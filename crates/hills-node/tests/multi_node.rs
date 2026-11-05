#![allow(clippy::unwrap_used, clippy::expect_used)] // 測試檔：失敗即 panic
//! 多節點整合測試：一個 mailbox + 多個 node，停用 relay，本機直連。
//!
//! 對應 M0 第三批計畫「驗證」1–6（technical-design §16）。

use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use hills_mailbox::{MAILBOX_ALPN, Mailbox, serve};
use hills_net::to_peer_addr;
use hills_node::{
    CreateOrg, LinkListener, MemoryStore, Node, NodeOptions, PresenceState, Role, SecretStore,
    SyncStatus,
};
use hills_proto::ticket::{MailboxTicket, Ticket};
use iroh::protocol::Router;
use iroh::{Endpoint, RelayMode, SecretKey, endpoint::presets};

fn opts() -> NodeOptions {
    NodeOptions {
        presence_interval: Duration::from_millis(500),
        presence_timeout: Duration::from_secs(3),
        poll_interval: Duration::from_secs(1),
        invite_ttl: Duration::from_secs(3600),
    }
}

fn store() -> Arc<dyn SecretStore> {
    Arc::new(MemoryStore::default())
}

struct MailboxServer {
    router: Router,
    code: String,
    _dir: tempfile::TempDir,
}

async fn mailbox() -> MailboxServer {
    let dir = tempfile::tempdir().unwrap();
    let mb = Mailbox::open(dir.path(), None).unwrap();
    let ep = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .relay_mode(RelayMode::Disabled)
        .alpns(vec![MAILBOX_ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let code = MailboxTicket::new(to_peer_addr(&ep.addr()))
        .to_code()
        .unwrap();
    MailboxServer {
        router: serve(ep, mb),
        code,
        _dir: dir,
    }
}

async fn create(dir: &Path, ss: Arc<dyn SecretStore>, code: &str) -> Node {
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
async fn eventually<F, Fut>(timeout: Duration, mut f: F) -> bool
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
async fn invite_and_join(admin: &Node, dir: &Path, ss: Arc<dyn SecretStore>, name: &str) -> Node {
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

fn org_name(n: &Node) -> String {
    n.org().name
}

/// 1. 管理者離線時送出加入申請，上線後自動核准；成員取得憑證、金鑰與 org 文件。
#[tokio::test]
async fn join_while_admin_offline() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let ss_admin = store();
    let admin = create(d_admin.path(), ss_admin.clone(), &mb.code).await;
    let code = admin.create_invite(Role::Member, vec![]).await.unwrap();
    admin.shutdown().await;
    drop(admin);

    let d_alice = tempfile::tempdir().unwrap();
    let alice = Node::join(d_alice.path(), store(), &code, "Alice", "alice-pc", opts())
        .await
        .unwrap();
    assert_eq!(alice.status(), SyncStatus::Pending);
    assert!(alice.sync_now().await.is_err(), "核准前不能連 mailbox");

    let admin = Node::open(d_admin.path(), ss_admin, opts())
        .await
        .unwrap()
        .unwrap();
    admin.sync_now().await.unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = alice.sync_now().await;
            alice.org().members.contains_key(&alice.member_id())
        })
        .await
    );
    assert_eq!(org_name(&alice), "測試組織");
    assert!(!alice.is_admin());
    assert!(admin.org().invites.values().all(|i| i.used_by.is_some()));
    alice.shutdown().await;
    admin.shutdown().await;
    mb.router.shutdown().await.unwrap();
}

/// 2. org 文件變更經 gossip + 直連 ≤ 2 秒到達；離線期間的變更上線後經 mailbox 補同步。
#[tokio::test]
async fn doc_changes_propagate_and_catch_up() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let ss_alice = store();
    let alice = invite_and_join(&admin, d_alice.path(), ss_alice.clone(), "alice").await;
    // 讓雙方取得位址簿、加入 gossip
    admin.sync_now().await.unwrap();
    alice.sync_now().await.unwrap();

    // 即時：只靠 gossip + 直連（mailbox 輪詢間隔 1 秒，但測 2 秒內到達）
    let t = Instant::now();
    admin.rename_org("即時名稱").await.unwrap();
    assert!(
        eventually(Duration::from_secs(2), || async {
            org_name(&alice) == "即時名稱"
        })
        .await,
        "2 秒內未收到"
    );
    eprintln!("即時同步 {:?}", t.elapsed());

    // 離線補同步
    alice.shutdown().await;
    drop(alice);
    admin.rename_org("離線期間的名稱").await.unwrap();
    admin.sync_now().await.unwrap();
    let alice = Node::open(d_alice.path(), ss_alice, opts())
        .await
        .unwrap()
        .unwrap();
    let t = Instant::now();
    assert!(
        eventually(Duration::from_secs(5), || async {
            org_name(&alice) == "離線期間的名稱"
        })
        .await
    );
    eprintln!("離線補同步 {:?}", t.elapsed());
    alice.shutdown().await;
    admin.shutdown().await;
    mb.router.shutdown().await.unwrap();
}

/// 3. presence ≤ 2 秒到達；關閉後逾時判定離線。
#[tokio::test]
async fn presence_propagates_and_expires() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let alice = invite_and_join(&admin, d_alice.path(), store(), "alice").await;
    admin.sync_now().await.unwrap();
    alice.sync_now().await.unwrap();
    let id = alice.member_id();

    // gossip 鄰居建立需要一點時間：先等第一則 presence 到達
    assert!(
        eventually(Duration::from_secs(10), || async {
            admin.presence().contains_key(&id)
        })
        .await
    );
    alice.set_presence(PresenceState::Busy, "寫報告").await;
    assert!(
        eventually(Duration::from_secs(2), || async {
            admin
                .presence()
                .get(&id)
                .is_some_and(|p| p.state == PresenceState::Busy && p.note == "寫報告")
        })
        .await
    );
    alice.shutdown().await;
    assert!(
        eventually(Duration::from_secs(6), || async {
            !admin.presence().contains_key(&id)
        })
        .await,
        "逾時後應判定離線"
    );
    admin.shutdown().await;
    mb.router.shutdown().await.unwrap();
}

/// 4. 新裝置綁定：雙方 SAS 一致，確認後新裝置取得身分並能同步。
#[tokio::test]
async fn link_new_device() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let alice = invite_and_join(&admin, d_alice.path(), store(), "alice").await;

    let d2 = tempfile::tempdir().unwrap();
    let mut listener = LinkListener::start(
        d2.path(),
        store(),
        &alice.org_ticket().unwrap(),
        "alice-laptop",
        opts(),
    )
    .await
    .unwrap();
    let session = alice.link_device(&listener.code).await.unwrap();
    listener.sas.wait_for(|s| s.is_some()).await.unwrap();
    let new_sas = listener.sas.borrow().clone().unwrap();
    assert_eq!(new_sas, session.sas);
    assert_eq!(new_sas.len(), 6);
    session.confirm("alice-laptop").await.unwrap();
    let laptop = listener.finish().await.unwrap();

    assert_eq!(laptop.member_id(), alice.member_id());
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = laptop.sync_now().await;
            org_name(&laptop) == "測試組織"
        })
        .await
    );
    assert_eq!(alice.devices().len(), 2);
    // 新裝置也收得到之後的變更
    admin.rename_org("綁定後").await.unwrap();
    assert!(
        eventually(Duration::from_secs(5), || async {
            org_name(&laptop) == "綁定後"
        })
        .await
    );
    for n in [laptop, alice, admin] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}

/// 5. 停用 bob → 金鑰輪替：bob 被 mailbox 拒絕、看不到新資料；alice 照常。
#[tokio::test]
async fn revoke_member_rotates_keys() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let alice = invite_and_join(&admin, d_alice.path(), store(), "alice").await;
    let d_bob = tempfile::tempdir().unwrap();
    let bob = invite_and_join(&admin, d_bob.path(), store(), "bob").await;
    for n in [&admin, &alice, &bob] {
        n.sync_now().await.unwrap();
    }
    assert!(alice.org().members.contains_key(&bob.member_id()));

    admin.revoke_member(bob.member_id()).await.unwrap();
    admin.sync_now().await.unwrap();
    admin.rename_org("停用後").await.unwrap();
    admin.sync_now().await.unwrap();

    assert!(
        eventually(Duration::from_secs(5), || async {
            let _ = alice.sync_now().await;
            org_name(&alice) == "停用後"
                && alice
                    .org()
                    .members
                    .get(&bob.member_id())
                    .is_some_and(|m| m.removed_at.is_some())
        })
        .await
    );
    // bob：mailbox 拒絕；即使收到 gossip 也解不開新 epoch
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(bob.sync_now().await.is_err(), "mailbox 應拒絕已停用成員");
    assert_ne!(org_name(&bob), "停用後");
    for n in [bob, alice, admin] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}

/// 6. 刪除本機全部資料後，以復原詞 + 組織連線碼還原並讀回原有資料。
#[tokio::test]
async fn recover_from_phrase() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let alice = invite_and_join(&admin, d_alice.path(), store(), "alice").await;
    admin.rename_org("還原前").await.unwrap();
    admin.sync_now().await.unwrap();

    let words = alice
        .recovery_words(hills_node::PhraseLanguage::TraditionalChinese)
        .join(" ");
    let org_code = alice.org_ticket().unwrap();
    let id = alice.member_id();
    alice.shutdown().await;
    drop(alice);
    drop(d_alice); // 刪除本機資料

    let d_new = tempfile::tempdir().unwrap();
    let restored = Node::recover(d_new.path(), store(), &words, &org_code, "new-pc", opts())
        .await
        .unwrap();
    assert_eq!(restored.member_id(), id);
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = restored.sync_now().await;
            org_name(&restored) == "還原前"
        })
        .await
    );
    restored.shutdown().await;
    admin.shutdown().await;
    mb.router.shutdown().await.unwrap();
}
