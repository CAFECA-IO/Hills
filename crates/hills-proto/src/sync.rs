//! 直連同步協定（ALPN `hills/sync/1`，technical-design §16.5）。

use serde::{Deserialize, Serialize};

use crate::SignedChange;

pub const ALPN: &[u8] = b"hills/sync/1";
pub const MAX_FRAME: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SyncRequest {
    /// 我目前的 heads；請回傳我缺少的 change
    Pull {
        doc_id: String,
        heads: Vec<[u8; 32]>,
    },
    /// 主動推送 change
    Push {
        doc_id: String,
        changes: Vec<SignedChange>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SyncResponse {
    Changes(Vec<SignedChange>),
    Ok,
    Forbidden,
    NotFound,
    Error(String),
}
