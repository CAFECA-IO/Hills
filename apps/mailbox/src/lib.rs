//! hills-mailbox：保存加密資料的常駐節點（technical-design §4.4、§5.2、§16.7）。
//!
//! - ALPN `hills/mailbox/1`。iroh 連線已驗證對方 NodeId（= DK）；連線第一個請求必須是
//!   `Hello{DeviceCert, MemberCert}`（`Join` 例外），之後同一連線的請求不需逐一簽章。
//! - 信任來源：設定檔中的 OK.pub；管理者推送的成員憑證與撤銷、成員上傳的裝置憑證，每筆各自驗證。
//!   mailbox 是 roster 的分發點（`GetRoster`），但無法偽造任何一筆憑證。
//! - 只保存密文：bundle、封裝金鑰、加入申請；mailbox 無法解密任何內容。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use hills_identity::trust::{TrustStore, Verified};
use hills_net::{recv_message, remote_node, send_message};
use hills_proto::mailbox::{
    ALPN, ErrorCode, Hello, KeyItem, ListItem, MAX_FRAME, MAX_LIST, MAX_PENDING_JOINS, PeerInfo,
    PendingJoin, Request, Response,
};
use hills_proto::{
    DeviceCert, EncryptedBundle, FORMAT_VERSION, JoinRequest, KeyFamily, OrgId, PeerAddr, Pub32,
    Revocation, Roster, Signed, WrappedKey,
};
use iroh::endpoint::Connection;
use iroh::{Endpoint, protocol::Router};
use rusqlite::{Connection as Db, OptionalExtension, params};

pub use hills_proto::mailbox::ALPN as MAILBOX_ALPN;

/// (invite_id, request, received_at)
type JoinRow = (Vec<u8>, Vec<u8>, i64);
/// (device, member, addr, last_seen)
type PeerRow = (Vec<u8>, Vec<u8>, Vec<u8>, i64);

/// 位址簿只回傳最近 7 天內上線過的裝置。
const PEER_TTL_MS: i64 = 7 * 24 * 3600 * 1000;

/// 尚未綁定組織時的佔位 OK（全 0，不是有效的 Ed25519 公鑰，無法通過任何驗證）。
pub const UNCLAIMED: Pub32 = Pub32([0; 32]);

/// mailbox 共享狀態。鎖的順序固定為 trust → db，避免死結。
pub struct Mailbox {
    /// 未綁定組織時，org_root 為 [`UNCLAIMED`]
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

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
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
CREATE TABLE IF NOT EXISTS trust (id INTEGER PRIMARY KEY CHECK (id = 1), roster BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS invites (
    invite_id BLOB PRIMARY KEY,
    created_by BLOB NOT NULL,
    expires_at INTEGER NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS joins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invite_id BLOB NOT NULL,
    device BLOB NOT NULL,
    request BLOB NOT NULL,
    received_at INTEGER NOT NULL,
    UNIQUE (invite_id, device)
);
CREATE TABLE IF NOT EXISTS wrapped_keys (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient BLOB NOT NULL,
    key_id TEXT NOT NULL,
    data BLOB NOT NULL,
    UNIQUE (recipient, key_id)
);
CREATE INDEX IF NOT EXISTS wrapped_keys_recipient ON wrapped_keys(recipient, cursor);
CREATE TABLE IF NOT EXISTS peers (
    device BLOB PRIMARY KEY,
    member BLOB NOT NULL,
    addr BLOB NOT NULL,
    last_seen INTEGER NOT NULL
);
";

impl Mailbox {
    /// 開啟資料目錄（`index.sqlite`、`blobs/`），載入已保存的信任狀態。
    ///
    /// `org_root` 為 None 時使用已綁定的組織；尚未綁定則等待第一位以 OK 簽發之管理者連線
    /// （technical-design §16.9）。指定的 OK 與已綁定的不同時拒絕啟動。
    pub fn open(data_dir: &Path, org_root: Option<Pub32>) -> anyhow::Result<Arc<Self>> {
        std::fs::create_dir_all(data_dir.join("blobs"))?;
        let db = Db::open(data_dir.join("index.sqlite"))?;
        db.execute_batch(SCHEMA)?;
        let stored: Option<Vec<u8>> = db
            .query_row("SELECT value FROM meta WHERE key = 'org_root'", [], |r| {
                r.get(0)
            })
            .optional()?;
        let stored = stored
            .map(|b| <[u8; 32]>::try_from(b.as_slice()).map(Pub32))
            .transpose()
            .map_err(|_| anyhow::anyhow!("資料庫中的 org_root 格式錯誤"))?;
        let root = match (org_root, stored) {
            (Some(a), Some(b)) if a != b => anyhow::bail!("HILLS_ORG_ROOT_PUB 與已綁定的組織不同"),
            (Some(a), None) => {
                db.execute(
                    "INSERT INTO meta (key, value) VALUES ('org_root', ?1)",
                    params![&a.0[..]],
                )?;
                a
            }
            (a, b) => a.or(b).unwrap_or(UNCLAIMED),
        };
        let mut trust = TrustStore::new(root);
        let saved: Option<Vec<u8>> = db
            .query_row("SELECT roster FROM trust WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        if let (Some(bytes), false) = (saved, root == UNCLAIMED) {
            let roster: Roster = hills_proto::decode(&bytes)?;
            trust.import_roster(&roster)?;
        }
        Ok(Arc::new(Self {
            trust: Mutex::new(trust),
            db: Mutex::new(db),
            blobs: data_dir.join("blobs"),
        }))
    }

    /// 是否已綁定組織。
    pub fn is_claimed(&self) -> bool {
        self.trust
            .lock()
            .map(|t| t.org_root() != UNCLAIMED)
            .unwrap_or(false)
    }

    pub fn org_id(&self) -> OrgId {
        self.trust
            .lock()
            .map(|t| t.org_id())
            .unwrap_or(Pub32([0; 32]))
    }

    fn blob_path(&self, hash: &[u8; 32]) -> PathBuf {
        self.blobs.join(data_encoding::HEXLOWER.encode(hash))
    }

    fn save_trust(&self, trust: &TrustStore) -> Result<(), Response> {
        let bytes = hills_proto::encode(&trust.to_roster(now_ms()))
            .map_err(|_| err(ErrorCode::Internal, "encode"))?;
        let db = self
            .db
            .lock()
            .map_err(|_| err(ErrorCode::Internal, "lock"))?;
        db.execute(
            "INSERT OR REPLACE INTO trust (id, roster) VALUES (1, ?1)",
            params![bytes],
        )
        .map_err(|_| err(ErrorCode::Internal, "無法保存信任狀態"))?;
        Ok(())
    }

    /// 在信任狀態的副本上套用變更，成功保存後才取代（失敗時不留下半套狀態）。
    fn update_trust(
        &self,
        f: impl FnOnce(&mut TrustStore) -> Result<(), Response>,
    ) -> Result<(), Response> {
        let mut trust = self
            .trust
            .lock()
            .map_err(|_| err(ErrorCode::Internal, "lock"))?;
        let mut next = trust.clone();
        f(&mut next)?;
        self.save_trust(&next)?;
        *trust = next;
        Ok(())
    }

    fn hello(&self, h: &Hello, node: &Pub32) -> Result<Verified, Response> {
        let mut verified = None;
        let mut claim = None;
        self.update_trust(|trust| {
            if trust.org_root() == UNCLAIMED {
                // 綁定：第一張由 OK 簽發的管理者憑證決定組織
                let mc = h.member_cert.as_ref().ok_or_else(|| err(ErrorCode::Unauthorized, "mailbox 尚未綁定組織"))?;
                let root = mc.signer;
                if !mc.body.is_admin() || mc.body.org_id != hills_identity::cert::org_id_for(&root) {
                    return Err(err(ErrorCode::Unauthorized, "mailbox 尚未綁定組織"));
                }
                let mut fresh = TrustStore::new(root);
                fresh.add_member_cert(mc.clone()).map_err(|_| err(ErrorCode::Unauthorized, "成員憑證無效"))?;
                *trust = fresh;
                claim = Some(root);
            }
            let member_cert = match &h.member_cert {
                Some(mc) => {
                    if trust.member(&mc.body.member_id).is_none() {
                        // bootstrap：尚未收到 roster 時，接受由 OK 或已知管理者簽發的有效憑證
                        trust
                            .add_member_cert(mc.clone())
                            .map_err(|_| err(ErrorCode::Unauthorized, "成員憑證無效"))?;
                    }
                    mc.clone()
                }
                None => trust
                    .member_cert(&h.device_cert.body.member_id)
                    .cloned()
                    .ok_or_else(|| err(ErrorCode::Unauthorized, "未知的成員"))?,
            };
            trust
                .verify_hello(&h.device_cert, &member_cert, node)
                .map_err(|e| err(ErrorCode::Unauthorized, &e.to_string()))?;
            trust
                .add_device_cert(h.device_cert.clone())
                .map_err(|e| err(ErrorCode::Unauthorized, &e.to_string()))?;
            verified = Some(
                trust
                    .verify_device(node)
                    .map_err(|e| err(ErrorCode::Unauthorized, &e.to_string()))?,
            );
            // 綁定在全部驗證通過後才寫入（失敗的連線不會綁定組織）
            if let Some(root) = claim {
                let db = self.db.lock().map_err(|_| err(ErrorCode::Internal, "lock"))?;
                db.execute("INSERT INTO meta (key, value) VALUES ('org_root', ?1)", params![&root.0[..]])
                    .map_err(|_| err(ErrorCode::Internal, "無法綁定組織"))?;
                tracing::info!(org = %hills_identity::cert::org_id_for(&root), "mailbox 已綁定組織");
            }
            Ok(())
        })?;
        verified.ok_or_else(|| err(ErrorCode::Internal, "hello"))
    }

    /// 每個請求都重新檢查（期間可能被撤銷）。
    fn still_valid(&self, node: &Pub32) -> Result<Verified, Response> {
        let trust = self
            .trust
            .lock()
            .map_err(|_| err(ErrorCode::Internal, "lock"))?;
        trust
            .verify_device(node)
            .map_err(|_| err(ErrorCode::Unauthorized, "裝置已失效"))
    }

    fn get_roster(&self) -> Response {
        match self.trust.lock() {
            Ok(t) => Response::Roster(Box::new(t.to_roster(now_ms()))),
            Err(_) => err(ErrorCode::Internal, "lock"),
        }
    }

    fn put_roster(&self, who: &Verified, roster: &Signed<Roster>) -> Response {
        if !who.is_admin() || roster.signer != who.device {
            return err(ErrorCode::Forbidden, "只有管理者裝置可推送 roster");
        }
        if hills_identity::cert::verify_signature(roster).is_err()
            || roster.body.org_id != self.org_id()
        {
            return err(ErrorCode::BadRequest, "roster 簽章或組織不符");
        }
        to_resp(self.update_trust(|t| {
            t.import_roster(&roster.body)
                .map(|_| ())
                .map_err(|_| err(ErrorCode::BadRequest, "roster 內容無效"))
        }))
    }

    fn put_device(&self, who: &Verified, cert: &Signed<DeviceCert>) -> Response {
        if cert.body.member_id != who.member_id {
            return err(ErrorCode::Forbidden, "只能上傳自己的裝置憑證");
        }
        to_resp(self.update_trust(|t| {
            t.add_device_cert(cert.clone())
                .map_err(|e| err(ErrorCode::BadRequest, &e.to_string()))
        }))
    }

    fn put_revocation(&self, rev: &Signed<Revocation>) -> Response {
        // 權限（管理者 / 裝置本人）由 TrustStore 依簽署者判斷
        to_resp(self.update_trust(|t| {
            t.add_revocation(rev)
                .map_err(|e| err(ErrorCode::Forbidden, &e.to_string()))
        }))
    }

    fn register_invite(&self, who: &Verified, invite_id: [u8; 8], expires_at: i64) -> Response {
        if !who.is_admin() {
            return err(ErrorCode::Forbidden, "只有管理者可建立邀請");
        }
        if expires_at <= now_ms() {
            return err(ErrorCode::BadRequest, "邀請已過期");
        }
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        match db.execute(
            "INSERT INTO invites (invite_id, created_by, expires_at) VALUES (?1, ?2, ?3)",
            params![&invite_id[..], &who.member_id.0[..], expires_at],
        ) {
            Ok(_) => Response::Ok,
            Err(_) => err(ErrorCode::BadRequest, "邀請已存在"),
        }
    }

    fn close_invite(&self, who: &Verified, invite_id: [u8; 8]) -> Response {
        if !who.is_admin() {
            return err(ErrorCode::Forbidden, "只有管理者可關閉邀請");
        }
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let ok = db
            .execute(
                "UPDATE invites SET closed = 1 WHERE invite_id = ?1",
                params![&invite_id[..]],
            )
            .is_ok()
            && db
                .execute(
                    "DELETE FROM joins WHERE invite_id = ?1",
                    params![&invite_id[..]],
                )
                .is_ok();
        if ok {
            Response::Ok
        } else {
            err(ErrorCode::Internal, "無法關閉邀請")
        }
    }

    /// 加入申請：不需 Hello，但邀請必須已登記、未過期、未關閉，且申請中的裝置就是連線的 NodeId。
    fn join(&self, org_id: OrgId, invite_id: [u8; 8], req: &JoinRequest, node: &Pub32) -> Response {
        if org_id != self.org_id() || req.v != FORMAT_VERSION || req.name.chars().count() > 100 {
            return err(ErrorCode::BadRequest, "申請格式錯誤");
        }
        if req.device_cert.body.device_pub != *node
            || req.device_cert.signer != req.ik_pub
            || hills_identity::cert::verify_signature(&req.device_cert).is_err()
        {
            return err(ErrorCode::BadRequest, "裝置憑證無效");
        }
        let Ok(bytes) = hills_proto::encode(req) else {
            return err(ErrorCode::Internal, "encode");
        };
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let invite: Option<(i64, i64)> = db
            .query_row(
                "SELECT expires_at, closed FROM invites WHERE invite_id = ?1",
                params![&invite_id[..]],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .ok()
            .flatten();
        match invite {
            Some((exp, 0)) if exp > now_ms() => {}
            _ => return err(ErrorCode::Forbidden, "邀請無效或已過期"),
        }
        let pending: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM joins WHERE invite_id = ?1",
                params![&invite_id[..]],
                |r| r.get(0),
            )
            .unwrap_or(i64::MAX);
        if pending >= MAX_PENDING_JOINS as i64 {
            return err(ErrorCode::TooLarge, "此邀請的待處理申請已達上限");
        }
        match db.execute(
            "INSERT OR REPLACE INTO joins (invite_id, device, request, received_at) VALUES (?1, ?2, ?3, ?4)",
            params![&invite_id[..], &node.0[..], bytes, now_ms()],
        ) {
            Ok(_) => Response::Ok,
            Err(_) => err(ErrorCode::Internal, "無法保存申請"),
        }
    }

    fn fetch_joins(&self, who: &Verified) -> Response {
        if !who.is_admin() {
            return err(ErrorCode::Forbidden, "只有管理者可讀取加入申請");
        }
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let rows: rusqlite::Result<Vec<JoinRow>> = (|| {
            let mut st = db.prepare(
                "SELECT j.invite_id, j.request, j.received_at FROM joins j
                 JOIN invites i ON i.invite_id = j.invite_id
                 WHERE i.closed = 0 AND i.expires_at > ?1 ORDER BY j.id",
            )?;
            let it = st.query_map(params![now_ms()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            it.collect()
        })();
        let Ok(rows) = rows else {
            return err(ErrorCode::Internal, "查詢失敗");
        };
        let joins = rows
            .into_iter()
            .filter_map(|(id, req, at)| {
                Some(PendingJoin {
                    invite_id: id.try_into().ok()?,
                    request: hills_proto::decode(&req).ok()?,
                    received_at: at,
                })
            })
            .collect();
        Response::Joins(joins)
    }

    fn put_keys(&self, wrapped: Vec<Signed<WrappedKey>>) -> Response {
        let Ok(trust) = self.trust.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let mut rows = Vec::with_capacity(wrapped.len());
        for w in wrapped {
            if w.body.v != FORMAT_VERSION {
                return err(ErrorCode::BadRequest, "版本不符");
            }
            let Ok(signer) = trust.verify_device_signed(&w) else {
                return err(ErrorCode::Unauthorized, "封裝金鑰的簽章無效");
            };
            let allowed = match &w.body.key_id.family {
                KeyFamily::Org | KeyFamily::Team(_) | KeyFamily::MemberAttendance(_) => {
                    signer.is_admin()
                }
                KeyFamily::MemberPrivate(m) => *m == signer.member_id,
                KeyFamily::Conv(_) => true,
            };
            if !allowed {
                return err(ErrorCode::Forbidden, "無權封裝此金鑰");
            }
            let Ok(bytes) = hills_proto::encode(&w) else {
                return err(ErrorCode::Internal, "encode");
            };
            rows.push((w.body.recipient, w.body.key_id.to_string(), bytes));
        }
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        for (recipient, key_id, bytes) in rows {
            // 同一收件者、同一 keyId 只保留第一份（金鑰不會改變）
            if db
                .execute(
                    "INSERT OR IGNORE INTO wrapped_keys (recipient, key_id, data) VALUES (?1, ?2, ?3)",
                    params![&recipient.0[..], key_id, bytes],
                )
                .is_err()
            {
                return err(ErrorCode::Internal, "無法寫入");
            }
        }
        Response::Ok
    }

    fn fetch_keys(&self, who: &Verified, since: u64) -> Response {
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let rows: Result<Vec<(i64, Vec<u8>)>, rusqlite::Error> = (|| {
            let mut st = db.prepare(
                "SELECT cursor, data FROM wrapped_keys WHERE recipient = ?1 AND cursor > ?2 ORDER BY cursor LIMIT ?3",
            )?;
            let it = st.query_map(
                params![&who.member_id.0[..], since as i64, MAX_LIST as i64],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            it.collect()
        })();
        let Ok(rows) = rows else {
            return err(ErrorCode::Internal, "查詢失敗");
        };
        let mut next = since;
        let items = rows
            .into_iter()
            .filter_map(|(cursor, data)| {
                next = cursor as u64;
                Some(KeyItem {
                    cursor: cursor as u64,
                    wrapped: hills_proto::decode(&data).ok()?,
                })
            })
            .collect();
        Response::Keys { items, next }
    }

    fn announce(&self, who: &Verified, addr: &PeerAddr) -> Response {
        if addr.node != who.device
            || addr.direct.len() > 16
            || addr.relay.as_ref().is_some_and(|r| r.len() > 256)
        {
            return err(ErrorCode::BadRequest, "位址無效");
        }
        let Ok(bytes) = hills_proto::encode(addr) else {
            return err(ErrorCode::Internal, "encode");
        };
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        match db.execute(
            "INSERT OR REPLACE INTO peers (device, member, addr, last_seen) VALUES (?1, ?2, ?3, ?4)",
            params![&who.device.0[..], &who.member_id.0[..], bytes, now_ms()],
        ) {
            Ok(_) => Response::Ok,
            Err(_) => err(ErrorCode::Internal, "無法寫入"),
        }
    }

    fn peers(&self) -> Response {
        let Ok(trust) = self.trust.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let rows: rusqlite::Result<Vec<PeerRow>> = (|| {
            let mut st = db.prepare(
                "SELECT device, member, addr, last_seen FROM peers WHERE last_seen > ?1",
            )?;
            let it = st.query_map(params![now_ms() - PEER_TTL_MS], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?;
            it.collect()
        })();
        let Ok(rows) = rows else {
            return err(ErrorCode::Internal, "查詢失敗");
        };
        let peers = rows
            .into_iter()
            .filter_map(|(device, member, addr, last_seen)| {
                let device = Pub32(device.try_into().ok()?);
                // 只回傳目前仍有效的裝置
                trust.verify_device(&device).ok()?;
                Some(PeerInfo {
                    member: hills_proto::MemberId(member.try_into().ok()?),
                    device,
                    addr: hills_proto::decode_unversioned(&addr).ok()?,
                    last_seen,
                })
            })
            .collect();
        Response::Peers(peers)
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
        match db.execute(
            "INSERT INTO bundles (org_id, doc_id, bundle_hash, uploader, received_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&org.0[..], b.doc_id, &b.bundle_hash[..], &who.member_id.0[..], now_ms()],
        ) {
            Ok(_) => Response::Stored { cursor: db.last_insert_rowid() as u64, duplicate: false },
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
            Request::Join { .. } => err(ErrorCode::BadRequest, "已登入的連線不需申請加入"),
            Request::GetRoster => self.get_roster(),
            Request::PutRoster(r) => self.put_roster(who, &r),
            Request::PutDevice(c) => self.put_device(who, &c),
            Request::PutRevocation(r) => self.put_revocation(&r),
            Request::RegisterInvite {
                invite_id,
                expires_at,
            } => self.register_invite(who, invite_id, expires_at),
            Request::CloseInvite { invite_id } => self.close_invite(who, invite_id),
            Request::FetchJoins => self.fetch_joins(who),
            Request::PutKeys(w) => self.put_keys(w),
            Request::FetchKeys { since } => self.fetch_keys(who, since),
            Request::Announce(addr) => self.announce(who, &addr),
            Request::Peers => self.peers(),
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

    /// 處理一條連線：第一個請求必須是 Hello（Join 例外）。
    pub async fn handle(self: Arc<Self>, conn: Connection) {
        let node = remote_node(&conn);
        let mut who: Option<Verified> = None;
        while let Ok((mut send, mut recv)) = conn.accept_bi().await {
            let resp = match recv_message::<Request>(&mut recv, MAX_FRAME + 64 * 1024).await {
                Err(_) => err(ErrorCode::BadRequest, "無法解析請求"),
                Ok(Request::Join {
                    org_id,
                    invite_id,
                    request,
                }) if who.is_none() => self.join(org_id, invite_id, &request, &node),
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

fn to_resp(r: Result<(), Response>) -> Response {
    match r {
        Ok(()) => Response::Ok,
        Err(e) => e,
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
