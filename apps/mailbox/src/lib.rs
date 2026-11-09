//! hills-mailbox：保存加密資料的常駐節點（technical-design §4.4、§5.2、§16.7）。
//!
//! - ALPN `hills/mailbox/1`。iroh 連線已驗證對方 NodeId（= DK）；連線第一個請求必須是
//!   `Hello{DeviceCert, MemberCert}`（`Join` 例外），之後同一連線的請求不需逐一簽章。
//! - 信任來源：設定檔中的 OK.pub；管理者推送的成員憑證與撤銷、成員上傳的裝置憑證，每筆各自驗證。
//!   mailbox 是 roster 的分發點（`GetRoster`），但無法偽造任何一筆憑證。
//! - 只保存密文：bundle、封裝金鑰；加入申請只含公鑰、CAFECA 登入證明與裝置名稱（technical-design §17.8）。
//!   mailbox 無法解密任何組織資料。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hills_cafeca::Verifier;
use hills_proto::cafeca::Application;

use hills_identity::trust::Verified;
use hills_net::gate::{GateError, TrustGate, TrustPersist};
use hills_net::{recv_message, remote_node, send_message};
use hills_proto::mailbox::{
    ALPN, ErrorCode, Hello, JoinState, KeyItem, ListItem, MAX_FRAME, MAX_LIST, MAX_PENDING_JOINS,
    PeerInfo, PendingApplication, Request, Response, ServerConfig,
};
use hills_proto::{
    DeviceCert, EncryptedBundle, FORMAT_VERSION, KeyFamily, OrgId, PeerAddr, Pub32, Revocation,
    Roster, Signed, WrappedKey,
};
use iroh::endpoint::Connection;
use iroh::{Endpoint, protocol::Router};
use rusqlite::{Connection as Db, OptionalExtension, params};

pub use hills_proto::mailbox::ALPN as MAILBOX_ALPN;

/// (data, received_at, handle)
type AppRow = (Vec<u8>, i64, Option<String>);

/// 申請保留 7 天；新裝置封裝保留 1 天（technical-design §17.8）。
const APPLICATION_TTL_MS: i64 = 7 * 24 * 3600 * 1000;
const GRANT_TTL_MS: i64 = 24 * 3600 * 1000;
/// 每個來源 NodeId 每分鐘最多送出的申請數。
const JOIN_RATE: usize = 5;

/// 申請在資料庫中的種類：1 加入、2 新裝置、3 還原。
fn app_code(a: &Application) -> i64 {
    match a {
        Application::Join(_) => 1,
        Application::Device(_) => 2,
        Application::Recover(_) => 3,
    }
}
/// (device, member, addr, last_seen)
type PeerRow = (Vec<u8>, Vec<u8>, Vec<u8>, i64);

/// 位址簿只回傳最近 7 天內上線過的裝置。
const PEER_TTL_MS: i64 = 7 * 24 * 3600 * 1000;

pub use hills_net::gate::UNCLAIMED;

/// mailbox 共享狀態。鎖的順序固定為 trust（gate）→ db，避免死結。
pub struct Mailbox {
    /// 信任邏輯與儲存節點共用（technical-design §15.6 v0.12）
    gate: TrustGate,
    db: Arc<Mutex<Db>>,
    blobs: PathBuf,
    /// 自己目前的位址（由執行檔在 endpoint 上線後設定，§16.7 `Info`）
    self_addr: Mutex<Option<PeerAddr>>,
    /// 儲存節點連線碼所在資料夾（`Services`，§15.6 v0.12）
    storage_codes: Mutex<Option<PathBuf>>,
    /// CAFECA 錢包網址與驗證器（§17.1、§17.8）
    cafeca: Mutex<Option<(String, Arc<Verifier>)>>,
    /// 申請限流：來源 NodeId → 最近送出時間
    join_rate: Mutex<HashMap<Pub32, Vec<Instant>>>,
}

/// 信任狀態存在 mailbox 的 SQLite（`trust`、`meta` 表）。
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

fn gate_err(e: GateError) -> Response {
    Response::Error {
        code: e.code,
        message: e.message,
    }
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
CREATE TABLE IF NOT EXISTS applications (
    device BLOB PRIMARY KEY,
    kind INTEGER NOT NULL,
    account BLOB NOT NULL,
    member BLOB NOT NULL,
    data BLOB NOT NULL,
    received_at INTEGER NOT NULL,
    handle TEXT,
    rejected INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS applications_member ON applications(member, kind);
CREATE TABLE IF NOT EXISTS grants (
    device BLOB PRIMARY KEY,
    sealed BLOB NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wrapped_keys (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient BLOB NOT NULL,
    recipient_ek BLOB NOT NULL,
    key_id TEXT NOT NULL,
    data BLOB NOT NULL,
    UNIQUE (recipient, recipient_ek, key_id)
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
        let saved: Option<Vec<u8>> = db
            .query_row("SELECT roster FROM trust WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        let roster: Option<Roster> = saved.map(|b| hills_proto::decode(&b)).transpose()?;
        let db = Arc::new(Mutex::new(db));
        let gate = TrustGate::new(root, roster.as_ref(), Box::new(DbPersist(db.clone())))?;
        Ok(Arc::new(Self {
            gate,
            db,
            blobs: data_dir.join("blobs"),
            self_addr: Mutex::new(None),
            storage_codes: Mutex::new(None),
            cafeca: Mutex::new(None),
            join_rate: Mutex::new(HashMap::new()),
        }))
    }

    /// 設定 `Info` 回傳的自身位址；回傳是否與先前不同。
    pub fn set_self_addr(&self, addr: PeerAddr) -> bool {
        match self.self_addr.lock() {
            Ok(mut cur) => {
                let changed = cur.as_ref() != Some(&addr);
                *cur = Some(addr);
                changed
            }
            Err(_) => false,
        }
    }

    fn info(&self) -> Response {
        match self.self_addr.lock().map(|a| a.clone()) {
            Ok(Some(a)) => Response::Info(a),
            _ => err(ErrorCode::NotFound, "位址尚未就緒"),
        }
    }

    /// 設定 CAFECA 錢包網址與驗證器（`HILLS_CAFECA_WALLET`，technical-design §17.1）。
    /// 驗證器為 `Verifier::Dev` 時，`Config` 回報 `dev_login`（§17.10）；錢包可為空字串。
    pub fn set_cafeca(&self, wallet: String, verifier: Arc<Verifier>) {
        if let Ok(mut c) = self.cafeca.lock() {
            *c = Some((wallet, verifier));
        }
    }

    fn config(&self) -> Response {
        let (wallet, dev_login) = self
            .cafeca
            .lock()
            .ok()
            .and_then(|c| c.as_ref().map(|(w, v)| (w.clone(), v.is_dev())))
            .unwrap_or_default();
        Response::Config(ServerConfig {
            cafeca_wallet: wallet,
            dev_login,
        })
    }

    /// 設定儲存節點連線碼所在的資料夾（`HILLS_STORAGE_CODES_DIR`）。
    pub fn set_storage_codes_dir(&self, dir: PathBuf) {
        if let Ok(mut d) = self.storage_codes.lock() {
            *d = Some(dir);
        }
    }

    /// `storage-<n>.txt` 中的連線碼，依編號排序；讀不到或格式錯誤的略過。
    fn services(&self) -> Response {
        use hills_proto::ticket::{StorageTicket, Ticket};
        let Some(dir) = self.storage_codes.lock().ok().and_then(|d| d.clone()) else {
            return Response::Services(vec![]);
        };
        let mut out: Vec<(u8, PeerAddr)> = (0u8..32)
            .filter_map(|i| {
                let raw = std::fs::read_to_string(dir.join(format!("storage-{i}.txt"))).ok()?;
                let t = StorageTicket::from_code(raw.trim()).ok()?;
                (t.index == i).then_some((i, t.node))
            })
            .collect();
        out.sort_by_key(|(i, _)| *i);
        Response::Services(out)
    }

    /// 是否已綁定組織。
    pub fn is_claimed(&self) -> bool {
        self.gate.is_claimed()
    }

    pub fn org_id(&self) -> OrgId {
        self.gate.org_id()
    }

    fn blob_path(&self, hash: &[u8; 32]) -> PathBuf {
        self.blobs.join(data_encoding::HEXLOWER.encode(hash))
    }

    fn hello(&self, h: &Hello, node: &Pub32) -> Result<Verified, Response> {
        self.gate.hello(h, node).map_err(gate_err)
    }

    /// 每個請求都重新檢查（期間可能被撤銷）。
    fn still_valid(&self, node: &Pub32) -> Result<Verified, Response> {
        self.gate.still_valid(node).map_err(gate_err)
    }

    fn get_roster(&self) -> Response {
        match self.gate.roster() {
            Ok(r) => Response::Roster(Box::new(r)),
            Err(e) => gate_err(e),
        }
    }

    fn put_roster(&self, who: &Verified, roster: &Signed<Roster>) -> Response {
        to_resp(self.gate.put_roster(who, roster).map_err(gate_err))
    }

    fn put_device(&self, who: &Verified, cert: &Signed<DeviceCert>) -> Response {
        to_resp(self.gate.put_device(who, cert).map_err(gate_err))
    }

    fn put_revocation(&self, rev: &Signed<Revocation>) -> Response {
        to_resp(self.gate.put_revocation(rev).map_err(gate_err))
    }

    fn rate_limited(&self, node: &Pub32) -> bool {
        let Ok(mut rate) = self.join_rate.lock() else {
            return true;
        };
        let now = Instant::now();
        rate.retain(|_, v| {
            v.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
            !v.is_empty()
        });
        let v = rate.entry(*node).or_default();
        if v.len() >= JOIN_RATE {
            return true;
        }
        v.push(now);
        false
    }

    fn sweep(db: &Db) {
        let now = now_ms();
        let _ = db.execute(
            "DELETE FROM applications WHERE received_at < ?1",
            params![now - APPLICATION_TTL_MS],
        );
        let _ = db.execute(
            "DELETE FROM grants WHERE created_at < ?1",
            params![now - GRANT_TTL_MS],
        );
    }

    /// 加入 / 新裝置 / 還原申請（§17.6–17.8）：不需 Hello，但申請中的裝置必須就是連線的 NodeId，
    /// 且 CAFECA 登入證明通過鏈上驗證。
    async fn join(&self, org_id: OrgId, app: Application, node: &Pub32) -> Response {
        if org_id != self.org_id() || !self.is_claimed() {
            return err(ErrorCode::BadRequest, "組織不符");
        }
        let v = match &app {
            Application::Join(a) | Application::Recover(a) => a.v,
            Application::Device(a) => a.v,
        };
        if v != FORMAT_VERSION || app.name().chars().count() > 100 {
            return err(ErrorCode::BadRequest, "申請格式錯誤");
        }
        if app.device_pub() != *node || !app.binding_consistent(&org_id) {
            return err(ErrorCode::BadRequest, "申請與登入內容不符");
        }
        let account = app.proof().account;
        let member = hills_identity::member_id_for(&account);
        if let Application::Join(a) | Application::Recover(a) = &app
            && (a.device_cert.body.member_id != member
                || hills_identity::cert::verify_signature(&a.device_cert).is_err())
        {
            return err(ErrorCode::BadRequest, "裝置憑證無效");
        }
        if self.rate_limited(node) {
            return err(ErrorCode::TooLarge, "申請太頻繁，請稍後再試");
        }
        let Some(verifier) = self
            .cafeca
            .lock()
            .ok()
            .and_then(|c| c.as_ref().map(|(_, v)| v.clone()))
        else {
            return err(
                ErrorCode::Internal,
                "此 mailbox 尚未設定 CAFECA（HILLS_CAFECA_WALLET 或 HILLS_DEV_LOGIN）",
            );
        };
        let received_at = now_ms();
        let verified = match verifier
            .verify(app.proof(), (received_at / 1000) as u64)
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::info!(error = %e, "拒絕申請：登入證明無效");
                return err(ErrorCode::BadRequest, &e.to_string());
            }
        };
        // 是否已是成員：加入需「不是」有效成員；新裝置與還原需「是」
        let is_member = match self.gate.lock() {
            Ok(t) => t.is_active_member(&member),
            Err(_) => return err(ErrorCode::Internal, "lock"),
        };
        // 已是成員的「加入」視為新增裝置（§17.6）；新裝置與還原需已是成員
        let (app, state) = match (app, is_member) {
            (a @ Application::Join(_), true) => (a.into_device(), JoinState::AwaitingDevice),
            (a @ Application::Join(_), false) => (a, JoinState::Pending),
            (a @ Application::Device(_), true) => (a, JoinState::AwaitingDevice),
            (a @ Application::Recover(_), true) => (a, JoinState::Pending),
            (_, false) => return err(ErrorCode::Forbidden, "此 CAFECA 帳戶不是成員"),
        };
        let Ok(bytes) = hills_proto::encode(&app) else {
            return err(ErrorCode::Internal, "encode");
        };
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        Self::sweep(&db);
        let pending: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM applications WHERE rejected = 0",
                [],
                |r| r.get(0),
            )
            .unwrap_or(i64::MAX);
        if pending >= MAX_PENDING_JOINS as i64 {
            return err(ErrorCode::TooLarge, "待處理申請已達上限");
        }
        // 同一帳戶、同一種類只保留最新一筆
        let kind = app_code(&app);
        let ok = db
            .execute(
                "DELETE FROM applications WHERE account = ?1 AND kind = ?2",
                params![&account.address[..], kind],
            )
            .is_ok()
            && db
                .execute(
                    "INSERT OR REPLACE INTO applications (device, kind, account, member, data, received_at, handle)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![&node.0[..], kind, &account.address[..], &member.0[..], bytes, received_at, verified.handle],
                )
                .is_ok();
        if ok {
            Response::JoinStatus(state)
        } else {
            err(ErrorCode::Internal, "無法保存申請")
        }
    }

    fn join_status(&self, org_id: OrgId, device: &Pub32, node: &Pub32) -> Response {
        if org_id != self.org_id() || device != node {
            return err(ErrorCode::BadRequest, "只能查詢自己的申請");
        }
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let row: Option<i64> = db
            .query_row(
                "SELECT rejected FROM applications WHERE device = ?1",
                params![&device.0[..]],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        let kind: Option<i64> = db
            .query_row(
                "SELECT kind FROM applications WHERE device = ?1",
                params![&device.0[..]],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        Response::JoinStatus(match row {
            Some(0) if kind == Some(2) => JoinState::AwaitingDevice,
            Some(0) => JoinState::Pending,
            Some(_) => JoinState::Rejected,
            None => JoinState::Unknown,
        })
    }

    fn query_apps(&self, sql: &str, p: &[&dyn rusqlite::ToSql]) -> Response {
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        Self::sweep(&db);
        let rows: rusqlite::Result<Vec<AppRow>> = (|| {
            let mut st = db.prepare(sql)?;
            let it = st.query_map(p, |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            it.collect()
        })();
        let Ok(rows) = rows else {
            return err(ErrorCode::Internal, "查詢失敗");
        };
        Response::Joins(
            rows.into_iter()
                .filter_map(|(data, at, handle)| {
                    Some(PendingApplication {
                        application: hills_proto::decode_unversioned(&data).ok()?,
                        received_at: at,
                        handle,
                    })
                })
                .collect(),
        )
    }

    fn fetch_joins(&self, who: &Verified) -> Response {
        if !who.is_admin() {
            return err(ErrorCode::Forbidden, "只有管理者可讀取加入申請");
        }
        self.query_apps(
            "SELECT data, received_at, handle FROM applications
             WHERE rejected = 0 AND kind IN (1, 3) ORDER BY received_at",
            &[],
        )
    }

    fn resolve_join(&self, who: &Verified, device: &Pub32, approved: bool) -> Response {
        if !who.is_admin() {
            return err(ErrorCode::Forbidden, "只有管理者可處理加入申請");
        }
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let r = if approved {
            db.execute(
                "DELETE FROM applications WHERE device = ?1 AND kind IN (1, 3)",
                params![&device.0[..]],
            )
        } else {
            db.execute(
                "UPDATE applications SET rejected = 1 WHERE device = ?1 AND kind IN (1, 3)",
                params![&device.0[..]],
            )
        };
        match r {
            Ok(_) => Response::Ok,
            Err(_) => err(ErrorCode::Internal, "無法更新申請"),
        }
    }

    fn fetch_device_requests(&self, who: &Verified) -> Response {
        self.query_apps(
            "SELECT data, received_at, handle FROM applications
             WHERE rejected = 0 AND kind = 2 AND member = ?1 ORDER BY received_at",
            &[&&who.member_id.0[..]],
        )
    }

    fn put_device_grant(&self, who: &Verified, device: &Pub32, sealed: &[u8]) -> Response {
        if sealed.len() > 4096 {
            return err(ErrorCode::TooLarge, "封裝過大");
        }
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let member: Option<Vec<u8>> = db
            .query_row(
                "SELECT member FROM applications WHERE device = ?1 AND kind = 2",
                params![&device.0[..]],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        if member.as_deref() != Some(&who.member_id.0[..]) {
            return err(ErrorCode::Forbidden, "不是本人的新裝置申請");
        }
        let ok = db
            .execute(
                "INSERT OR REPLACE INTO grants (device, sealed, created_at) VALUES (?1, ?2, ?3)",
                params![&device.0[..], sealed, now_ms()],
            )
            .is_ok()
            && db
                .execute(
                    "DELETE FROM applications WHERE device = ?1",
                    params![&device.0[..]],
                )
                .is_ok();
        if ok {
            Response::Ok
        } else {
            err(ErrorCode::Internal, "無法保存封裝")
        }
    }

    fn fetch_device_grant(&self, org_id: OrgId, device: &Pub32, node: &Pub32) -> Response {
        if org_id != self.org_id() || device != node {
            return err(ErrorCode::BadRequest, "只能取回自己的封裝");
        }
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        let sealed: Option<Vec<u8>> = db
            .query_row(
                "SELECT sealed FROM grants WHERE device = ?1",
                params![&device.0[..]],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        Response::DeviceGrant(sealed)
    }

    fn put_keys(&self, wrapped: Vec<Signed<WrappedKey>>) -> Response {
        let Ok(trust) = self.gate.lock() else {
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
                KeyFamily::Org | KeyFamily::MemberAttendance(_) => signer.is_admin(),
                // D49（technical-design §16.15）：mailbox 看不到小組名單，小組金鑰由任何有效成員
                // 交接；成員資格由收件端檢查
                KeyFamily::Team(_) => true,
                KeyFamily::MemberPrivate(m) => *m == signer.member_id,
                KeyFamily::Conv(_) | KeyFamily::ConvMeta(_) => true,
            };
            if !allowed {
                return err(ErrorCode::Forbidden, "無權封裝此金鑰");
            }
            let Ok(bytes) = hills_proto::encode(&w) else {
                return err(ErrorCode::Internal, "encode");
            };
            rows.push((
                w.body.recipient,
                w.body.recipient_ek,
                w.body.key_id.to_string(),
                bytes,
            ));
        }
        let Ok(db) = self.db.lock() else {
            return err(ErrorCode::Internal, "lock");
        };
        for (recipient, ek, key_id, bytes) in rows {
            // 同一收件者、同一 EK、同一 keyId 只保留第一份（金鑰不會改變；還原換 EK 後可再封裝）
            if db
                .execute(
                    "INSERT OR IGNORE INTO wrapped_keys (recipient, recipient_ek, key_id, data) VALUES (?1, ?2, ?3, ?4)",
                    params![&recipient.0[..], &ek.0[..], key_id, bytes],
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
        let Ok(trust) = self.gate.lock() else {
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
            Request::Config => self.config(),
            Request::JoinStatus { .. } | Request::FetchDeviceGrant { .. } => {
                err(ErrorCode::BadRequest, "已登入的連線不需此請求")
            }
            Request::FetchJoins => self.fetch_joins(who),
            Request::ResolveJoin { device, approved } => self.resolve_join(who, &device, approved),
            Request::FetchDeviceRequests => self.fetch_device_requests(who),
            Request::PutDeviceGrant { device, sealed } => {
                self.put_device_grant(who, &device, &sealed)
            }
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
            Request::Info => self.info(),
            Request::Services => self.services(),
        }
    }

    /// 處理一條連線：第一個請求必須是 Hello（Config 與申請相關請求例外）。
    pub async fn handle(self: Arc<Self>, conn: Connection) {
        let node = remote_node(&conn);
        let mut who: Option<Verified> = None;
        while let Ok((mut send, mut recv)) = conn.accept_bi().await {
            let resp = match recv_message::<Request>(&mut recv, MAX_FRAME + 64 * 1024).await {
                Err(_) => err(ErrorCode::BadRequest, "無法解析請求"),
                Ok(Request::Join {
                    org_id,
                    application,
                }) if who.is_none() => self.join(org_id, *application, &node).await,
                Ok(Request::Config) => self.config(),
                Ok(Request::JoinStatus { org_id, device }) if who.is_none() => {
                    self.join_status(org_id, &device, &node)
                }
                Ok(Request::FetchDeviceGrant { org_id, device }) if who.is_none() => {
                    self.fetch_device_grant(org_id, &device, &node)
                }
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
