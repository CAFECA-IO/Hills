//! gossip 訊息（technical-design §16.6）：`Signed<GossipMsg>` 以 GK 加密後廣播。

use serde::{Deserialize, Serialize};

use crate::{KeyId, MemberId, Signable, Timestamp, Versioned};

pub const TOPIC_PREFIX: &[u8] = b"hills/v1/gossip";
pub const AAD_PREFIX: &[u8] = b"hills/v1/gossip";
/// 每則 gossip 訊息的上限
pub const MAX_MESSAGE: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PresenceState {
    Online,
    Busy,
    Meeting,
    Focus,
    Away,
    Leave,
    Offline,
    /// 午休（D40）；加在最後，既有值的編號不變
    Lunch,
}

/// 成員自己選擇的地點（technical-design §5.1 v0.11）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Location {
    /// 不顯示地點
    #[default]
    Hidden,
    Remote,
    /// org 文件 `offices/<id>`
    Office(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Presence {
    pub member: MemberId,
    pub state: PresenceState,
    pub note: String,
    pub current_task: Option<String>,
    pub at: Timestamp,
    /// 「幾點回來」；到期後回到上線
    pub until: Option<Timestamp>,
    pub location: Location,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum GossipMsg {
    Presence(Presence),
    Heads {
        doc_id: String,
        heads: Vec<[u8; 32]>,
    },
    /// roster 有變動（新成員、裝置、撤銷），請向 mailbox GetRoster
    RosterChanged,
    /// 有新的封裝金鑰，請向 mailbox FetchKeys
    KeysChanged,
}

impl Signable for GossipMsg {
    const SIGN_TYPE: &'static str = "gossip";
}

/// 線上傳送的格式。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GossipEnvelope {
    pub v: u8,
    pub key_id: KeyId,
    #[serde(with = "serde_bytes")]
    pub nonce: [u8; 24],
    #[serde(with = "serde_bytes")]
    pub ciphertext: Vec<u8>,
}

impl Versioned for GossipEnvelope {
    fn version(&self) -> u8 {
        self.v
    }
}
