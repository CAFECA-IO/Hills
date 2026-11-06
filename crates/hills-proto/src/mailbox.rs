//! mailbox 協定（ALPN `hills/mailbox/1`，technical-design §5.2）。
//!
//! 每條 iroh 連線第一個請求必須是 [`Request::Hello`]；之後每個雙向串流承載一個請求與一個回應，
//! 以長度前綴的 postcard 編碼（framing 見 `hills-net`）。

use serde::{Deserialize, Serialize};

use crate::{
    DeviceCert, EncryptedBundle, JoinRequest, MemberCert, MemberId, OrgId, PeerAddr, Pub32,
    Revocation, Roster, Signed, Timestamp, WrappedKey,
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
    RegisterInvite {
        invite_id: [u8; 8],
        expires_at: Timestamp,
    },
    CloseInvite {
        invite_id: [u8; 8],
    },
    /// 不需 Hello（technical-design §16.2）
    Join {
        org_id: OrgId,
        invite_id: [u8; 8],
        request: Box<JoinRequest>,
    },
    FetchJoins,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingJoin {
    pub invite_id: [u8; 8],
    pub request: JoinRequest,
    pub received_at: Timestamp,
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

/// 每個邀請最多保留的待處理申請數。
pub const MAX_PENDING_JOINS: usize = 5;

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
    Joins(Vec<PendingJoin>),
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
}
