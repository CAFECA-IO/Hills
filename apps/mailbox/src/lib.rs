//! hills-mailbox：保存加密 change bundle 的常駐節點（technical-design §4.4、§5.2）。
//!
//! - ALPN `hills/mailbox/1`。iroh 連線已驗證對方 NodeId（= DK）；連線第一個請求必須是
//!   `Hello{DeviceCert, MemberCert}`，之後同一連線的請求不需逐一簽章。
//! - 信任來源：設定檔中的 OK.pub，以及管理者推送的 roster（每筆憑證各自驗證）。
//!   第一位管理者的憑證由 OK 簽發，因此可在 roster 推送前先 Hello（bootstrap）。
//! - 只保存密文：索引（SQLite）記錄 docId、bundleHash、cursor、上傳者、時間；
//!   ciphertext 存成檔案。mailbox 無法解密任何內容。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use hills_identity::trust::{TrustStore, Verified};
use hills_net::{recv_message, remote_node, send_message};
use hills_proto::mailbox::{
    ALPN, ErrorCode, Hello, ListItem, MAX_FRAME, MAX_LIST, Request, Response,
};
use hills_proto::{EncryptedBundle, FORMAT_VERSION, OrgId, Pub32, Signed};
use iroh::endpoint::Connection;
use iroh::{Endpoint, protocol::Router};
use rusqlite::{Connection as Db, OptionalExtension, params};

pub use hills_proto::mailbox::ALPN as MAILBOX_ALPN;

/// mailbox 共享狀態。
pub struct Mailbox {
    org_root: Pub32,
    trust: Mutex<TrustStore>,
    db: Mutex<Db>,
    blobs: PathBuf,
}

fn err(code: ErrorCode, message: &str) -> Response {
    Response::Error {
        code,
        message: message.to_owned(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Mailbox {
    /// 開啟資料目錄（`index.sqlite`、`blobs/`），載入已保存的 roster。
    pub fn open(data_dir: &Path, org_root: Pub32) -> anyhow::Result<Arc<Self>> {
        std::fs::create_dir_all(data_dir.join("blobs"))?;
        let db = Db::open(data_dir.join("index.sqlite"))?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS bundles (
                cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                org_id BLOB NOT NULL,
                doc_id TEXT NOT NULL,
                bundle_hash BLOB NOT NULL,
                uploader BLOB NOT NULL,
                received_at INTEGER NOT NULL,
                UNIQUE (org_id, bundle_hash)
             );
             CREATE INDEX IF NOT EXISTS bundles_doc ON bundles(org_id, doc_id, cursor);
             CREATE TABLE IF NOT EXISTS roster (id INTEGER PRIMARY KEY CHECK (id = 1), data BLOB NOT NULL);",
        )?;
        let mut trust = TrustStore::new(org_root);
        let saved: Option<Vec<u8>> = db
            .query_row("SELECT data FROM roster WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        if let Some(bytes) = saved {
            let roster: Signed<hills_proto::Roster> = hills_proto::decode(&bytes)?;
            trust.import_roster(&roster.body)?;
        }
        Ok(Arc::new(Self {
            org_root,
            trust: Mutex::new(trust),
            db: Mutex::new(db),
            blobs: data_dir.join("blobs"),
        }))
    }

    pub fn org_id(&self) -> OrgId {
        hills_identity::cert::org_id_for(&self.org_root)
    }

    fn blob_path(&self, hash: &[u8; 32]) -> PathBuf {
        self.blobs.join(data_encoding::HEXLOWER.encode(hash))
    }

    fn hello(&self, h: &Hello, node: &Pub32) -> Result<Verified, Response> {
        let mut trust = self
            .trust
            .lock()
            .map_err(|_| err(ErrorCode::Internal, "lock"))?;
        if trust.member(&h.member_cert.body.member_id).is_none() {
            // bootstrap：尚未收到 roster 時，接受由 OK 或已知管理者簽發的有效憑證
            trust
                .add_member_cert(h.member_cert.clone())
                .map_err(|_| err(ErrorCode::Unauthorized, "成員憑證無效"))?;
        }
        trust
            .verify_hello(&h.device_cert, &h.member_cert, node)
            .map_err(|e| err(ErrorCode::Unauthorized, &e.to_string()))?;
        trust
            .add_device_cert(h.device_cert.clone())
            .map_err(|e| err(ErrorCode::Unauthorized, &e.to_string()))?;
        trust
            .verify_device(node)
            .map_err(|e| err(ErrorCode::Unauthorized, &e.to_string()))
    }

    /// 每個請求都重新檢查（roster 可能在連線期間撤銷此裝置）。
    fn still_valid(&self, node: &Pub32) -> Result<Verified, Response> {
        let trust = self
            .trust
            .lock()
            .map_err(|_| err(ErrorCode::Internal, "lock"))?;
        trust
            .verify_device(node)
            .map_err(|_| err(ErrorCode::Unauthorized, "裝置已失效"))
    }

    fn put_roster(&self, who: &Verified, roster: &Signed<hills_proto::Roster>) -> Response {
        if !who.is_admin() || roster.signer != who.device {
            return err(ErrorCode::Forbidden, "只有管理者裝置可推送 roster");
        }
        if hills_identity::cert::verify_signature(roster).is_err()
            || roster.body.org_id != self.org_id()
        {
            return err(ErrorCode::BadRequest, "roster 簽章或組織不符");
        }
        let Ok(mut trust) = self.trust.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let mut next = trust.clone();
        if next.import_roster(&roster.body).is_err() {
            return err(ErrorCode::BadRequest, "roster 內容無效");
        }
        let Ok(bytes) = hills_proto::encode(roster) else {
            return err(ErrorCode::Internal, "encode");
        };
        let saved = self.db.lock().ok().and_then(|db| {
            db.execute(
                "INSERT OR REPLACE INTO roster (id, data) VALUES (1, ?1)",
                params![bytes],
            )
            .ok()
        });
        if saved.is_none() {
            return err(ErrorCode::Internal, "無法保存 roster");
        }
        *trust = next;
        Response::Ok
    }

    fn put(&self, who: &Verified, b: EncryptedBundle) -> Response {
        if b.v != FORMAT_VERSION || b.doc_id.is_empty() || b.doc_id.len() > 512 {
            return err(ErrorCode::BadRequest, "bundle 格式錯誤");
        }
        if b.ciphertext.len() > MAX_FRAME {
            return err(ErrorCode::TooLarge, "bundle 過大");
        }
        if *blake3::hash(&b.ciphertext).as_bytes() != b.bundle_hash {
            return err(ErrorCode::BadRequest, "bundle_hash 不符");
        }
        let org = self.org_id();
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let existing: Option<i64> = db
            .query_row(
                "SELECT cursor FROM bundles WHERE org_id = ?1 AND bundle_hash = ?2",
                params![&org.0[..], &b.bundle_hash[..]],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        if let Some(cursor) = existing {
            return Response::Stored {
                cursor: cursor as u64,
                duplicate: true,
            };
        }
        // 先寫檔再寫索引：索引存在時檔案一定存在
        let Ok(data) = hills_proto::encode(&b) else {
            return err(ErrorCode::Internal, "encode");
        };
        let tmp = self.blobs.join(format!(
            ".tmp-{}",
            data_encoding::HEXLOWER.encode(&b.bundle_hash)
        ));
        if std::fs::write(&tmp, &data)
            .and_then(|_| std::fs::rename(&tmp, self.blob_path(&b.bundle_hash)))
            .is_err()
        {
            return err(ErrorCode::Internal, "無法寫入");
        }
        let inserted = db.execute(
            "INSERT INTO bundles (org_id, doc_id, bundle_hash, uploader, received_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&org.0[..], b.doc_id, &b.bundle_hash[..], &who.member_id.0[..], now_ms()],
        );
        match inserted {
            Ok(_) => Response::Stored {
                cursor: db.last_insert_rowid() as u64,
                duplicate: false,
            },
            Err(_) => err(ErrorCode::Internal, "無法寫入索引"),
        }
    }

    fn load_blob(&self, hash: &[u8; 32]) -> Option<EncryptedBundle> {
        let bytes = std::fs::read(self.blob_path(hash)).ok()?;
        hills_proto::decode(&bytes).ok()
    }

    fn list(
        &self,
        org_id: OrgId,
        doc_ids: Option<Vec<String>>,
        since: u64,
        limit: u32,
    ) -> Response {
        if org_id != self.org_id() {
            return err(ErrorCode::Forbidden, "組織不符");
        }
        let limit = limit.clamp(1, MAX_LIST) as i64;
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let rows: Result<Vec<(i64, Vec<u8>)>, rusqlite::Error> = (|| {
            let mut out = Vec::new();
            match &doc_ids {
                None => {
                    let mut st = db.prepare(
                        "SELECT cursor, bundle_hash FROM bundles WHERE org_id = ?1 AND cursor > ?2 ORDER BY cursor LIMIT ?3",
                    )?;
                    for r in st.query_map(params![&org_id.0[..], since as i64, limit], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })? {
                        out.push(r?);
                    }
                }
                Some(ids) => {
                    let mut st = db.prepare(
                        "SELECT cursor, bundle_hash FROM bundles WHERE org_id = ?1 AND doc_id = ?2 AND cursor > ?3 ORDER BY cursor LIMIT ?4",
                    )?;
                    for id in ids.iter().take(100) {
                        for r in st
                            .query_map(params![&org_id.0[..], id, since as i64, limit], |r| {
                                Ok((r.get(0)?, r.get(1)?))
                            })?
                        {
                            out.push(r?);
                        }
                    }
                    out.sort_by_key(|(c, _)| *c);
                    out.truncate(limit as usize);
                }
            }
            Ok(out)
        })();
        let Ok(rows) = rows else {
            return err(ErrorCode::Internal, "查詢失敗");
        };
        let mut items = Vec::with_capacity(rows.len());
        let mut next = since;
        for (cursor, hash) in rows {
            let Ok(h) = <[u8; 32]>::try_from(hash.as_slice()) else {
                continue;
            };
            if let Some(bundle) = self.load_blob(&h) {
                items.push(ListItem {
                    cursor: cursor as u64,
                    bundle,
                });
            }
            next = cursor as u64;
        }
        Response::Bundles { items, next }
    }

    fn get(&self, org_id: OrgId, hash: [u8; 32]) -> Response {
        if org_id != self.org_id() {
            return err(ErrorCode::Forbidden, "組織不符");
        }
        match self.load_blob(&hash) {
            Some(b) => Response::Bundle(Box::new(b)),
            None => err(ErrorCode::NotFound, "找不到"),
        }
    }

    fn dispatch(&self, who: &Verified, req: Request) -> Response {
        match req {
            Request::Hello(_) => err(ErrorCode::BadRequest, "重複的 Hello"),
            Request::PutRoster(r) => self.put_roster(who, &r),
            Request::Put(b) => self.put(who, b),
            Request::List {
                org_id,
                doc_ids,
                since,
                limit,
            } => self.list(org_id, doc_ids, since, limit),
            Request::Get {
                org_id,
                bundle_hash,
            } => self.get(org_id, bundle_hash),
        }
    }

    /// 處理一條連線：第一個請求必須是 Hello。
    pub async fn handle(self: Arc<Self>, conn: Connection) {
        let node = remote_node(&conn);
        let mut who: Option<Verified> = None;
        while let Ok((mut send, mut recv)) = conn.accept_bi().await {
            let resp = match recv_message::<Request>(&mut recv, MAX_FRAME + 64 * 1024).await {
                Err(_) => err(ErrorCode::BadRequest, "無法解析請求"),
                Ok(Request::Hello(h)) if who.is_none() => match self.hello(&h, &node) {
                    Ok(v) => {
                        who = Some(v);
                        Response::Ok
                    }
                    Err(e) => e,
                },
                Ok(req) => match &who {
                    None => err(ErrorCode::Unauthorized, "請先 Hello"),
                    Some(_) => match self.still_valid(&node) {
                        Ok(v) => self.dispatch(&v, req),
                        Err(e) => e,
                    },
                },
            };
            let unauthorized = matches!(
                resp,
                Response::Error {
                    code: ErrorCode::Unauthorized,
                    ..
                }
            );
            if send_message(&mut send, &resp).await.is_err() {
                break;
            }
            if unauthorized && who.is_none() {
                // 讓客戶端讀完回應再關閉
                let _ = send.stopped().await;
                conn.close(1u32.into(), b"unauthorized");
                break;
            }
        }
    }
}

/// iroh Router 的協定處理器。
#[derive(Clone)]
pub struct MailboxProtocol(pub Arc<Mailbox>);

impl std::fmt::Debug for MailboxProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MailboxProtocol")
    }
}

impl iroh::protocol::ProtocolHandler for MailboxProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), iroh::protocol::AcceptError> {
        self.0.clone().handle(conn).await;
        Ok(())
    }
}

/// 啟動 iroh router，提供 mailbox 協定。
pub fn serve(endpoint: Endpoint, mailbox: Arc<Mailbox>) -> Router {
    Router::builder(endpoint)
        .accept(ALPN, MailboxProtocol(mailbox))
        .spawn()
}
