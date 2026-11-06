#![allow(dead_code, unused_imports, clippy::unwrap_used, clippy::expect_used)]
//! 整合測試共用：本機 mailbox、建立組織、邀請加入、輪詢等待。

pub use std::future::Future;
pub use std::path::Path;
pub use std::sync::Arc;
pub use std::time::{Duration, Instant};

pub use hills_mailbox::{MAILBOX_ALPN, Mailbox, serve};
pub use hills_net::to_peer_addr;
pub use hills_node::{
    CreateOrg, LinkListener, MemoryStore, Node, NodeOptions, PresenceState, Role, SecretStore,
    SyncStatus,
};
pub use hills_proto::ticket::{MailboxTicket, Ticket};
pub use iroh::protocol::Router;
pub use iroh::{Endpoint, RelayMode, SecretKey, endpoint::presets};

pub fn opts() -> NodeOptions {
    NodeOptions {
        presence_interval: Duration::from_millis(500),
        presence_timeout: Duration::from_secs(3),
        poll_interval: Duration::from_secs(1),
        invite_ttl: Duration::from_secs(3600),
    }
}

pub fn store() -> Arc<dyn SecretStore> {
    Arc::new(MemoryStore::default())
}

pub struct MailboxServer {
    pub router: Router,
    pub code: String,
    pub mb: Arc<Mailbox>,
    pub addr: hills_proto::PeerAddr,
    pub _dir: tempfile::TempDir,
}

pub async fn mailbox() -> MailboxServer {
    let dir = tempfile::tempdir().unwrap();
    let mb = Mailbox::open(dir.path(), None).unwrap();
    let ep = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .relay_mode(RelayMode::Disabled)
        .alpns(vec![MAILBOX_ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let addr = to_peer_addr(&ep.addr());
    let code = MailboxTicket::new(addr.clone()).to_code().unwrap();
    MailboxServer {
        router: serve(ep, mb.clone()),
        code,
        mb,
        addr,
        _dir: dir,
    }
}

pub async fn create(dir: &Path, ss: Arc<dyn SecretStore>, code: &str) -> Node {
    let (node, _ok) = Node::create_org(
        dir,
        ss,
        CreateOrg {
            org_name: "測試組織".into(),
            my_name: "Admin".into(),
            device_name: "admin-mac".into(),
            mailbox_code: code.into(),
            timezone: "Asia/Taipei".into(),
            locale: "zh-TW".into(),
            team_name: "預設小組".into(),
        },
        opts(),
    )
    .await
    .unwrap();
    node.sync_now().await.unwrap();
    node
}

/// 輪詢直到條件成立；逾時回傳 false。
pub async fn eventually<F, Fut>(timeout: Duration, mut f: F) -> bool
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let start = Instant::now();
    while start.elapsed() < timeout {
        if f().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

/// 管理者邀請 → 送出加入（管理者可能離線）→ 核准 → 成員 Active。
pub async fn invite_and_join(
    admin: &Node,
    dir: &Path,
    ss: Arc<dyn SecretStore>,
    name: &str,
) -> Node {
    let code = admin.create_invite(Role::Member, vec![]).await.unwrap();
    let node = Node::join(dir, ss, &code, name, &format!("{name}-pc"), opts())
        .await
        .unwrap();
    admin.sync_now().await.unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = node.sync_now().await;
            node.status() == SyncStatus::Synced
                && node.org().members.contains_key(&node.member_id())
        })
        .await,
        "{name} 未完成加入"
    );
    node
}

pub fn org_name(n: &Node) -> String {
    n.org().name
}
