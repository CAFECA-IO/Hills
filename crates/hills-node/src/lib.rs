//! hills-node：Hills 的 app 核心（technical-design §16）。
//!
//! 組合 identity / crypto / store / sync / net，提供組織生命週期（以 CAFECA 登入建立、加入、新增裝置、還原，停用）、
//! 文件讀寫與同步（mailbox、gossip、直連）、上線狀態。桌機 app 只透過本 crate 操作。

mod approval;
mod chat;
pub mod config;
pub mod conv;
mod gossip;
pub mod kb;
mod lifecycle;
mod local;
mod mailbox;
mod node;
pub mod onboarding;
pub mod org;
pub mod plans;
mod policy;
pub mod scrum;
mod storage;
mod syncproto;
pub mod team;

pub use approval::JoinView;
pub use chat::ConvView;
pub use config::LegacyData;
pub use config::MemberStatus;
pub use conv::{ConvInfo, ConvKind, Message};
pub use hills_identity::secret_store::{MemoryStore, SecretStore, SecretStoreError};
pub use hills_proto::gossip::{Location, Presence, PresenceState};
pub use hills_proto::{MemberId, Pub32, Role};
pub use lifecycle::{DEFAULT_TEAM, DeviceView};
pub use node::{Event, Node, NodeOptions, SyncStatus};
pub use onboarding::{CreateOrg, OnboardKind, OnboardStep, Onboarding, SignInView};
pub use org::{LunchBreak, OfficeRec, OrgSnapshot};
pub use team::{Focus, Look, StepInput, Task, TaskInput, TaskStatus, TaskStep};
