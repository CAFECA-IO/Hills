//! 儲存節點協定 `hills/storage/1`（technical-design §15.6，D39）。
//!
//! 每條雙向串流一個請求（與 mailbox 相同，§16.7）；連線第一個請求必須是 `Hello`。
//! 節點只保存密文分片，以 SHA-256 定址。

use serde::{Deserialize, Serialize};

use crate::mailbox::{ErrorCode, Hello};
use crate::{Roster, Signed, Timestamp};

pub const ALPN: &[u8] = b"hills/storage/1";
/// 單一分片上限：20 MiB 條帶 / 5 再加少量餘裕
pub const MAX_SHARD: usize = 4 * 1024 * 1024 + 64 * 1024;
/// 請求與回應上限
pub const MAX_FRAME: usize = 5 * 1024 * 1024;
/// `Has` 一次最多查詢的 ID 數
pub const MAX_HAS: usize = 64;
/// 保存期限上限：上傳後 1 年（D16）
pub const MAX_RETENTION_MS: Timestamp = 366 * 24 * 3600 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Request {
    Hello(Box<Hello>),
    PutRoster(Box<Signed<Roster>>),
    Has {
        ids: Vec<[u8; 32]>,
    },
    Put {
        id: [u8; 32],
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
        expires_at: Timestamp,
    },
    Get {
        id: [u8; 32],
        offset: u32,
        /// 0 = 到結尾
        len: u32,
    },
    Health,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Response {
    Ok,
    Has(Vec<bool>),
    Stored { duplicate: bool },
    Data(#[serde(with = "serde_bytes")] Vec<u8>),
    Health { objects: u64, bytes: u64 },
    Error { code: ErrorCode, message: String },
}
