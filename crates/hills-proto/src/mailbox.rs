//! mailbox 協定（ALPN `hills/mailbox/1`，technical-design §5.2）。
//!
//! 每條 iroh 連線第一個請求必須是 [`Request::Hello`]；之後每個雙向串流承載一個請求與一個回應，
//! 以長度前綴的 postcard 編碼（framing 見 `hills-net`）。

use serde::{Deserialize, Serialize};

use crate::cafeca::Application;
use crate::{
    DeviceCert, EncryptedBundle, MemberCert, MemberId, OrgId, PeerAddr, Pub32, Revocation, Roster,
    Signed, Timestamp, WrappedKey,
};

pub const ALPN: &[u8] = b"hills/mailbox/1";
/// 單一訊息上限（bundle 由同步引擎控制大小）。
pub const MAX_FRAME: usize = 16 * 1024 * 1024;
/// LIST 單頁上限。
pub const MAX_LIST: u32 = 500;

/// 連線開頭的身分宣告（technical-design §5.2）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub device_cert: Signed<DeviceCert>,
    /// 省略時 mailbox 使用已知的成員憑證（technical-design §16.7）
    pub member_cert: Option<Signed<MemberCert>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Request {
    Hello(Box<Hello>),
    GetRoster,
    PutRoster(Box<Signed<Roster>>),
    PutDevice(Box<Signed<DeviceCert>>),
    PutRevocation(Box<Signed<Revocation>>),
    /// 不需 Hello：部署設定（technical-design §17.1）
    Config,
    /// 不需 Hello：加入 / 新裝置 / 還原申請，mailbox 驗證 CAFECA 登入證明（§17.8）
    Join {
        org_id: OrgId,
        application: Box<Application>,
    },
    /// 不需 Hello：申請狀態
    JoinStatus {
        org_id: OrgId,
        device: Pub32,
    },
    /// 管理者：待核准的加入與還原申請
    FetchJoins,
    /// 管理者：核准（已 PutRoster 後）或拒絕
    ResolveJoin {
        device: Pub32,
        approved: bool,
    },
    /// 本人裝置：本人的新裝置申請
    FetchDeviceRequests,
    /// 本人裝置：封裝給新裝置的成員金鑰
    PutDeviceGrant {
        device: Pub32,
        #[serde(with = "serde_bytes")]
        sealed: Vec<u8>,
    },
    /// 不需 Hello：新裝置取回封裝（內容已加密）
    FetchDeviceGrant {
        org_id: OrgId,
        device: Pub32,
    },
    PutKeys(Vec<Signed<WrappedKey>>),
    FetchKeys {
        since: u64,
    },
    Announce(PeerAddr),
    Peers,
    Put(EncryptedBundle),
    List {
        org_id: OrgId,
        doc_ids: Option<Vec<String>>,
        since: u64,
        limit: u32,
    },
    Get {
        org_id: OrgId,
        bundle_hash: [u8; 32],
    },
    /// mailbox 目前的位址（technical-design §16.1、§16.7）。新增於列舉尾端以保持相容
    Info,
    /// 儲存節點位址（依編號排序，§15.6 v0.12）。新增於列舉尾端
    Services,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorCode {
    /// 尚未 Hello 或憑證無效
    Unauthorized,
    /// 已驗證但無權限（例如非管理者推送 roster）
    Forbidden,
    BadRequest,
    NotFound,
    TooLarge,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListItem {
    pub cursor: u64,
    pub bundle: EncryptedBundle,
}

/// mailbox 暫存的申請（§17.8）。`handle` 由 mailbox 向 CAFECA 查詢，只供顯示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingApplication {
    pub application: Application,
    pub received_at: Timestamp,
    pub handle: Option<String>,
}

/// 申請狀態（`JoinStatus` 回應）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JoinState {
    /// 等待管理者核准（加入、還原）
    Pending,
    /// 已是成員：等待本人其他裝置封裝成員金鑰（新裝置，§17.6）
    AwaitingDevice,
    Rejected,
    Unknown,
}

/// 部署設定（`Config` 回應）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerConfig {
    /// CAFECA 錢包網址（`HILLS_CAFECA_WALLET`）；未設定時為空字串
    pub cafeca_wallet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyItem {
    pub cursor: u64,
    pub wrapped: Signed<WrappedKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerInfo {
    pub member: MemberId,
    pub device: Pub32,
    pub addr: PeerAddr,
    pub last_seen: Timestamp,
}

/// 每個組織最多保留的待處理申請數（§17.8）。
pub const MAX_PENDING_JOINS: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Response {
    Ok,
    /// PUT 成功；`duplicate` 表示同一 bundle_hash 已存在
    Stored {
        cursor: u64,
        duplicate: bool,
    },
    Bundles {
        items: Vec<ListItem>,
        next: u64,
    },
    Bundle(Box<EncryptedBundle>),
    Roster(Box<Roster>),
    Joins(Vec<PendingApplication>),
    JoinStatus(JoinState),
    DeviceGrant(Option<Vec<u8>>),
    Config(ServerConfig),
    Keys {
        items: Vec<KeyItem>,
        next: u64,
    },
    Peers(Vec<PeerInfo>),
    Error {
        code: ErrorCode,
        message: String,
    },
    /// 回應 [`Request::Info`]
    Info(PeerAddr),
    /// 回應 [`Request::Services`]：`(節點編號, 位址)`
    Services(Vec<(u8, PeerAddr)>),
}
