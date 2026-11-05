//! 新裝置綁定協定（ALPN `hills/link/1`，technical-design §16.3）。
//!
//! 舊裝置主動連線新裝置：
//! 1. `Begin{eph_pub}` → `Ready`（雙方各自計算並顯示 SAS）
//! 2. 使用者在舊裝置確認 SAS 一致 → `Deliver{nonce, ciphertext}` → `Accepted`

use serde::{Deserialize, Serialize};

use crate::{DeviceCert, PeerAddr, Pub32, Signed};

pub const ALPN: &[u8] = b"hills/link/1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LinkRequest {
    Begin {
        eph_pub: Pub32,
    },
    Deliver {
        #[serde(with = "serde_bytes")]
        nonce: [u8; 24],
        #[serde(with = "serde_bytes")]
        ciphertext: Vec<u8>,
    },
    Abort,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LinkResponse {
    Ready,
    Accepted,
    Rejected(String),
}

/// `Deliver` 加密前的內容。
#[derive(Serialize, Deserialize)]
pub struct LinkPayload {
    pub v: u8,
    #[serde(with = "serde_bytes")]
    pub entropy: [u8; 32],
    pub org_root: Pub32,
    pub mailbox: PeerAddr,
    pub device_cert: Signed<DeviceCert>,
}
