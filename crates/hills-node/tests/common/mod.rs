#![allow(dead_code, unused_imports, clippy::unwrap_used, clippy::expect_used)]
//! 整合測試共用：本機 mailbox、以（測試用）CAFECA 登入建立組織與加入、輪詢等待。

pub use std::future::Future;
pub use std::path::Path;
pub use std::sync::Arc;
pub use std::time::{Duration, Instant};

pub use hills_cafeca::Verifier;
pub use hills_mailbox::{MAILBOX_ALPN, Mailbox, serve};
pub use hills_net::to_peer_addr;
pub use hills_node::{
    CreateOrg, MemoryStore, Node, NodeOptions, OnboardKind, OnboardStep, Onboarding, PresenceState,
    Role, SecretStore, SyncStatus,
};
pub use hills_proto::cafeca::{
    APP_DOMAIN, CafecaAccount, CafecaProof, SignInBinding, SignInMessage,
};
pub use hills_proto::ticket::{MailboxTicket, Ticket};
pub use iroh::protocol::Router;
pub use iroh::{Endpoint, RelayMode, SecretKey, endpoint::presets};

pub fn opts() -> NodeOptions {
    NodeOptions {
        presence_interval: Duration::from_millis(500),
        presence_timeout: Duration::from_secs(3),
        poll_interval: Duration::from_secs(1),
        verifier: Some(Arc::new(Verifier::OfflineForTests)),
    }
}

/// 隨機的測試 CAFECA 帳戶。
pub fn account() -> CafecaAccount {
    let mut address = [0u8; 20];
    getrandom::fill(&mut address).unwrap();
    CafecaAccount {
        chain_id: 8018,
        address,
    }
}

/// 測試用登入證明（OfflineForTests 只檢查綁定內容與時效，不查鏈上）。
pub fn proof(binding: SignInBinding, account: CafecaAccount, handle: &str) -> CafecaProof {
    CafecaProof {
        v: hills_proto::FORMAT_VERSION,
        account,
        message: SignInMessage {
            domain: APP_DOMAIN.into(),
            uri: APP_DOMAIN.into(),
            nonce: hills_cafeca::nonce_for(&binding),
            issued_at: binding.issued_at,
            expires_at: binding.issued_at + 600,
            statement: "測試".into(),
            claims: "handle".into(),
            channel: String::new(),
        },
        binding,
        signature: vec![1; 64],
        handle: Some(handle.into()),
    }
}

/// 以指定帳戶完成登入，回傳下一步。
pub async fn sign_in(
    dir: &Path,
    ss: Arc<dyn SecretStore>,
    kind: OnboardKind,
    account: CafecaAccount,
    handle: &str,
) -> (Onboarding, OnboardStep) {
    let (mut ob, view) = Onboarding::begin(dir, ss, kind, opts()).await.unwrap();
    assert_eq!(view.code.len(), 9);
    let b = ob.binding_for_tests().unwrap();
    let step = ob
        .submit_proof_for_tests(proof(b, account, handle))
        .await
        .unwrap();
    (ob, step)
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
    mb.set_cafeca(
        "https://wallet.example".into(),
        Arc::new(Verifier::OfflineForTests),
    );
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
    let (_, step) = sign_in(
        dir,
        ss,
        OnboardKind::Create(CreateOrg {
            org_name: "測試組織".into(),
            my_name: "Admin".into(),
            device_name: "admin-mac".into(),
            mailbox_code: code.into(),
            timezone: "Asia/Taipei".into(),
            locale: "zh-TW".into(),
            team_name: "預設小組".into(),
        }),
        account(),
        "admin",
    )
    .await;
    let OnboardStep::Created(node, _ok) = step else {
        panic!("應完成建立組織");
    };
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

/// 送出加入申請 → 管理者核准 → 成員 Active。
pub async fn invite_and_join(
    admin: &Node,
    dir: &Path,
    ss: Arc<dyn SecretStore>,
    name: &str,
) -> Node {
    join_as(admin, dir, ss, name, account()).await
}

/// 以指定帳戶申請加入並由管理者核准。
pub async fn join_as(
    admin: &Node,
    dir: &Path,
    ss: Arc<dyn SecretStore>,
    name: &str,
    acct: CafecaAccount,
) -> Node {
    let org_code = admin.org_ticket().unwrap();
    let (_, step) = sign_in(
        dir,
        ss,
        OnboardKind::Join {
            org_code,
            my_name: name.into(),
            device_name: format!("{name}-pc"),
        },
        acct,
        name,
    )
    .await;
    let OnboardStep::WaitingApproval(node) = step else {
        panic!("應等待核准");
    };
    approve_pending(admin, &node).await;
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

/// 管理者等到申請出現後核准。
pub async fn approve_pending(admin: &Node, node: &Node) {
    let device = node.device();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = admin.sync_now().await;
            admin.pending_joins().iter().any(|j| j.device == device)
        })
        .await,
        "管理者未收到申請"
    );
    admin.approve_join(device, false, vec![]).await.unwrap();
}

pub fn org_name(n: &Node) -> String {
    n.org().name
}
