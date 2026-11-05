//! hills-node：Hills 的 app 核心（technical-design §16）。
//!
//! 組合 identity / crypto / store / sync / net，提供組織生命週期（建立、加入、綁定、復原、停用）、
//! 文件讀寫與同步（mailbox、gossip、直連）、上線狀態。桌機 app 只透過本 crate 操作。

pub mod config;
mod gossip;
mod lifecycle;
mod link;
mod local;
mod mailbox;
mod node;
pub mod org;
mod policy;
mod syncproto;

pub use config::MemberStatus;
pub use hills_identity::PhraseLanguage;
pub use hills_identity::secret_store::{MemoryStore, SecretStore, SecretStoreError};
pub use hills_proto::gossip::{Presence, PresenceState};
pub use hills_proto::{MemberId, Pub32, Role};
pub use lifecycle::{CreateOrg, DEFAULT_TEAM, DeviceView};
pub use link::{LinkListener, LinkSession};
pub use node::{Event, Node, NodeOptions, SyncStatus};
pub use org::OrgSnapshot;
