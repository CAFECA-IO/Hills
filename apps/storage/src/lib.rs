//! hills-storage：SwarmStorage 原理的分片儲存節點（technical-design §15.6、D39）。
//!
//! - ALPN `hills/storage/1`；連線第一個請求必須是 `Hello`，信任邏輯與 mailbox 共用
//!   [`hills_net::gate::TrustGate`]。
//! - 只保存密文分片，以 SHA-256 定址；看不到檔名、目錄結構與內容。
//! - 資料目錄：`node.key`、`index.sqlite`、`objects/<前 2 碼>/<sha256>`。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use hills_identity::trust::Verified;
use hills_net::gate::{GateError, TrustGate, TrustPersist, UNCLAIMED};
use hills_net::{recv_message, remote_node, send_message};
use hills_proto::mailbox::ErrorCode;
use hills_proto::storage::{
    ALPN, MAX_FRAME, MAX_HAS, MAX_RETENTION_MS, MAX_SHARD, Request, Response,
};
use hills_proto::{Pub32, Roster, Timestamp};
use iroh::endpoint::Connection;
use iroh::{Endpoint, protocol::Router};
use rusqlite::{Connection as Db, OptionalExtension, params};
use sha2::{Digest, Sha256};

pub use hills_proto::storage::ALPN as STORAGE_ALPN;

/// 每位成員在本節點的預設配額（technical-design §15.6）
pub const DEFAULT_QUOTA: u64 = 20 * 1024 * 1024 * 1024;

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS objects (
    id BLOB PRIMARY KEY,
    size INTEGER NOT NULL,
    uploader BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_uploader ON objects(uploader);
CREATE INDEX IF NOT EXISTS objects_expires ON objects(expires_at);
CREATE TABLE IF NOT EXISTS trust (id INTEGER PRIMARY KEY CHECK (id = 1), roster BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
";

fn now_ms() -> Timestamp {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn err(code: ErrorCode, message: &str) -> Response {
    Response::Error {
        code,
        message: message.to_owned(),
    }
}

fn gate_err(e: GateError) -> Response {
    Response::Error {
        code: e.code,
        message: e.message,
    }
}

struct DbPersist(Arc<Mutex<Db>>);

impl TrustPersist for DbPersist {
    fn save_roster(&self, roster: &[u8]) -> Result<(), String> {
        let db = self.0.lock().map_err(|_| "lock".to_string())?;
        db.execute(
            "INSERT OR REPLACE INTO trust (id, roster) VALUES (1, ?1)",
            params![roster],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
    fn save_org_root(&self, root: &Pub32) -> Result<(), String> {
        let db = self.0.lock().map_err(|_| "lock".to_string())?;
        db.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('org_root', ?1)",
            params![&root.0[..]],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
}

/// 儲存節點共享狀態。鎖的順序：trust（gate）→ db。
pub struct Storage {
    gate: TrustGate,
    db: Arc<Mutex<Db>>,
    objects: PathBuf,
    quota: u64,
}

impl Storage {
    /// 開啟資料目錄。`org_root` 為 None 時使用已綁定的組織，尚未綁定則等待第一位管理者。
    pub fn open(data_dir: &Path, org_root: Option<Pub32>, quota: u64) -> anyhow::Result<Arc<Self>> {
        std::fs::create_dir_all(data_dir.join("objects"))?;
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
        let saved: Option<Vec<u8>> = db
            .query_row("SELECT roster FROM trust WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        let roster: Option<Roster> = saved.map(|b| hills_proto::decode(&b)).transpose()?;
        let db = Arc::new(Mutex::new(db));
        let gate = TrustGate::new(root, roster.as_ref(), Box::new(DbPersist(db.clone())))?;
        Ok(Arc::new(Self {
            gate,
            db,
            objects: data_dir.join("objects"),
            quota,
        }))
    }

    pub fn is_claimed(&self) -> bool {
        self.gate.is_claimed()
    }

    fn path(&self, id: &[u8; 32]) -> PathBuf {
        let hex = data_encoding::HEXLOWER.encode(id);
        self.objects.join(&hex[..2]).join(hex)
    }

    fn has(&self, ids: &[[u8; 32]]) -> Response {
        if ids.len() > MAX_HAS {
            return err(ErrorCode::TooLarge, "一次查詢過多");
        }
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let now = now_ms();
        let out = ids
            .iter()
            .map(|id| {
                db.query_row(
                    "SELECT 1 FROM objects WHERE id = ?1 AND expires_at > ?2",
                    params![&id[..], now],
                    |_| Ok(()),
                )
                .optional()
                .ok()
                .flatten()
                .is_some()
                    && self.path(id).exists()
            })
            .collect();
        Response::Has(out)
    }

    fn put(&self, who: &Verified, id: [u8; 32], data: &[u8], expires_at: Timestamp) -> Response {
        if data.is_empty() || data.len() > MAX_SHARD {
            return err(ErrorCode::TooLarge, "分片大小超出範圍");
        }
        let digest: [u8; 32] = Sha256::digest(data).into();
        if digest != id {
            return err(ErrorCode::BadRequest, "SHA-256 不符");
        }
        let now = now_ms();
        let expires_at = if expires_at <= now {
            now + MAX_RETENTION_MS
        } else {
            expires_at.min(now + MAX_RETENTION_MS)
        };
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let existing: Option<i64> = db
            .query_row(
                "SELECT expires_at FROM objects WHERE id = ?1",
                params![&id[..]],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        let path = self.path(&id);
        if existing.is_some() && path.exists() {
            // 同一分片再次上傳：只延長保存期限
            let _ = db.execute(
                "UPDATE objects SET expires_at = MAX(expires_at, ?2) WHERE id = ?1",
                params![&id[..], expires_at],
            );
            return Response::Stored { duplicate: true };
        }
        let used: i64 = db
            .query_row(
                "SELECT COALESCE(SUM(size), 0) FROM objects WHERE uploader = ?1 AND expires_at > ?2",
                params![&who.member_id.0[..], now],
                |r| r.get(0),
            )
            .unwrap_or(i64::MAX);
        if (used as u64).saturating_add(data.len() as u64) > self.quota {
            return err(ErrorCode::TooLarge, "已超過此節點的配額");
        }
        let Some(dir) = path.parent() else {
            return err(ErrorCode::Internal, "路徑");
        };
        let tmp = dir.join(format!(".tmp-{}", data_encoding::HEXLOWER.encode(&id)));
        let written = std::fs::create_dir_all(dir)
            .and_then(|_| std::fs::write(&tmp, data))
            .and_then(|_| std::fs::rename(&tmp, &path));
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
            return err(ErrorCode::Internal, "無法寫入");
        }
        match db.execute(
            "INSERT OR REPLACE INTO objects (id, size, uploader, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&id[..], data.len() as i64, &who.member_id.0[..], now, expires_at],
        ) {
            Ok(_) => Response::Stored { duplicate: false },
            Err(_) => err(ErrorCode::Internal, "無法寫入索引"),
        }
    }

    fn get(&self, id: [u8; 32], offset: u32, len: u32) -> Response {
        let alive = self
            .db
            .lock()
            .ok()
            .and_then(|db| {
                db.query_row(
                    "SELECT 1 FROM objects WHERE id = ?1 AND expires_at > ?2",
                    params![&id[..], now_ms()],
                    |_| Ok(()),
                )
                .optional()
                .ok()
                .flatten()
            })
            .is_some();
        if !alive {
            return err(ErrorCode::NotFound, "找不到");
        }
        let Ok(bytes) = std::fs::read(self.path(&id)) else {
            return err(ErrorCode::NotFound, "找不到");
        };
        let start = (offset as usize).min(bytes.len());
        let end = if len == 0 {
            bytes.len()
        } else {
            start.saturating_add(len as usize).min(bytes.len())
        };
        Response::Data(bytes[start..end].to_vec())
    }

    fn health(&self) -> Response {
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        match db.query_row(
            "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM objects WHERE expires_at > ?1",
            params![now_ms()],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        ) {
            Ok((n, b)) => Response::Health {
                objects: n as u64,
                bytes: b as u64,
            },
            Err(_) => err(ErrorCode::Internal, "查詢失敗"),
        }
    }

    /// 刪除過期物件；回傳刪除數量（每日執行，technical-design §15.6）。
    pub fn sweep(&self, now: Timestamp) -> usize {
        let ids: Vec<Vec<u8>> = {
            let Ok(db) = self.db.lock() else {
                return 0;
            };
            let Ok(mut st) = db.prepare("SELECT id FROM objects WHERE expires_at <= ?1") else {
                return 0;
            };
            st.query_map(params![now], |r| r.get(0))
                .map(|rows| rows.filter_map(Result::ok).collect())
                .unwrap_or_default()
        };
        let mut n = 0;
        for id in ids {
            let Ok(arr) = <[u8; 32]>::try_from(id.as_slice()) else {
                continue;
            };
            let _ = std::fs::remove_file(self.path(&arr));
            if let Ok(db) = self.db.lock()
                && db
                    .execute(
                        "DELETE FROM objects WHERE id = ?1 AND expires_at <= ?2",
                        params![&id, now],
                    )
                    .is_ok()
            {
                n += 1;
            }
        }
        n
    }

    fn dispatch(&self, who: &Verified, req: Request) -> Response {
        match req {
            Request::Hello(_) => err(ErrorCode::BadRequest, "重複的 Hello"),
            Request::PutRoster(r) => match self.gate.put_roster(who, &r) {
                Ok(()) => Response::Ok,
                Err(e) => gate_err(e),
            },
            Request::Has { ids } => self.has(&ids),
            Request::Put {
                id,
                data,
                expires_at,
            } => self.put(who, id, &data, expires_at),
            Request::Get { id, offset, len } => self.get(id, offset, len),
            Request::Health => self.health(),
        }
    }

    /// 處理一條連線：第一個請求必須是 Hello；之後每個請求都重新檢查裝置是否仍有效。
    pub async fn handle(self: Arc<Self>, conn: Connection) {
        let node = remote_node(&conn);
        let mut hello_ok = false;
        while let Ok((mut send, mut recv)) = conn.accept_bi().await {
            let resp = match recv_message::<Request>(&mut recv, MAX_FRAME + 64 * 1024).await {
                Err(_) => err(ErrorCode::BadRequest, "無法解析請求"),
                Ok(Request::Hello(h)) if !hello_ok => match self.gate.hello(&h, &node) {
                    Ok(_) => {
                        hello_ok = true;
                        Response::Ok
                    }
                    Err(e) => gate_err(e),
                },
                Ok(req) if hello_ok => match self.gate.still_valid(&node) {
                    Ok(v) => {
                        // 檔案 I/O 不阻塞 async runtime
                        let me = self.clone();
                        tokio::task::spawn_blocking(move || me.dispatch(&v, req))
                            .await
                            .unwrap_or_else(|_| err(ErrorCode::Internal, "處理失敗"))
                    }
                    Err(e) => gate_err(e),
                },
                Ok(_) => err(ErrorCode::Unauthorized, "請先 Hello"),
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
            if unauthorized {
                let _ = send.stopped().await;
                conn.close(1u32.into(), b"unauthorized");
                break;
            }
        }
    }
}

#[derive(Clone)]
pub struct StorageProtocol(pub Arc<Storage>);

impl std::fmt::Debug for StorageProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StorageProtocol")
    }
}

impl iroh::protocol::ProtocolHandler for StorageProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), iroh::protocol::AcceptError> {
        self.0.clone().handle(conn).await;
        Ok(())
    }
}

/// 啟動 iroh router，提供儲存節點協定。
pub fn serve(endpoint: Endpoint, storage: Arc<Storage>) -> Router {
    Router::builder(endpoint)
        .accept(ALPN, StorageProtocol(storage))
        .spawn()
}
