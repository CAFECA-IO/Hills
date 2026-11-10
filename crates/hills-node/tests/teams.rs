#![allow(clippy::unwrap_used, clippy::expect_used)]
//! D49：小組管理與小組金鑰交接（technical-design §16.15）。

mod common;
use common::*;
use hills_node::{Node, TaskInput};

fn task(title: &str) -> TaskInput {
    TaskInput {
        plan_item_id: None,
        team_goal_id: None,
        brief: None,
        acceptance: None,
        title: title.into(),
        assignee: None,
        status: None,
        due_at: None,
        steps: vec![],
    }
}

fn has_task(n: &Node, title: &str) -> bool {
    n.tasks().unwrap().iter().any(|t| t.title == title)
}

async fn sync_all(nodes: &[&Node]) {
    for n in nodes {
        let _ = n.sync_now().await;
    }
}

#[tokio::test]
async fn teams_hand_over_and_rotate_keys() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let alice = invite_and_join(&admin, d_alice.path(), store(), "alice").await;
    let d_bob = tempfile::tempdir().unwrap();
    let bob = invite_and_join(&admin, d_bob.path(), store(), "bob").await;
    let d_carol = tempfile::tempdir().unwrap();
    let carol = invite_and_join(&admin, d_carol.path(), store(), "carol").await;
    let all = [&admin, &alice, &bob, &carol];
    sync_all(&all).await;
    let (a, b, c) = (alice.member_id(), bob.member_id(), carol.member_id());

    // 管理者建立小組：成員 alice、bob，負責人 alice；管理者不持有 TK
    assert!(alice.create_team("x", vec![a], vec![]).await.is_err());
    assert!(admin.create_team("core", vec![], vec![]).await.is_err());
    assert!(admin.create_team("core", vec![a], vec![b]).await.is_err());
    let core = admin
        .create_team("核心", vec![a, b], vec![a])
        .await
        .unwrap();
    assert_eq!(admin.team_key_epoch(&core), None);
    let info = admin.teams_info();
    let t = info.iter().find(|t| t.id == core).unwrap();
    assert!(t.can_manage && !t.awaiting_key);
    assert!(
        eventually(Duration::from_secs(5), || async {
            sync_all(&all).await;
            alice.team_key_epoch(&core) == Some(1) && bob.team_key_epoch(&core) == Some(1)
        })
        .await,
        "成員應收到小組金鑰"
    );
    alice.create_task(&core, task("第一件事")).await.unwrap();
    assert!(admin.create_task(&core, task("管理者")).await.is_err());
    assert!(
        eventually(Duration::from_secs(5), || async {
            sync_all(&all).await;
            has_task(&bob, "第一件事")
        })
        .await
    );
    assert!(
        !has_task(&admin, "第一件事"),
        "管理者不在小組，讀不到小組任務"
    );

    // 不是負責人不能改名單；負責人 alice 加入 carol → 由成員裝置交接
    assert!(
        bob.set_team_members(&core, vec![a, b, c], vec![a])
            .await
            .is_err()
    );
    alice
        .set_team_members(&core, vec![a, b, c], vec![a])
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(8), || async {
            sync_all(&all).await;
            has_task(&carol, "第一件事")
        })
        .await,
        "新成員應由小組成員交接取得金鑰"
    );
    assert_eq!(carol.team_key_epoch(&core), Some(1));

    // 移出 bob → 指定輪替裝置（alice）輪替一次
    alice
        .set_team_members(&core, vec![a, c], vec![a])
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(8), || async {
            sync_all(&all).await;
            alice.team_key_epoch(&core) == Some(2) && carol.team_key_epoch(&core) == Some(2)
        })
        .await,
        "移出後應輪替"
    );
    alice.create_task(&core, task("移出之後")).await.unwrap();
    assert!(
        eventually(Duration::from_secs(5), || async {
            sync_all(&all).await;
            has_task(&carol, "移出之後")
        })
        .await
    );
    for _ in 0..3 {
        sync_all(&all).await;
    }
    assert_eq!(bob.team_key_epoch(&core), Some(1));
    assert!(!has_task(&bob, "移出之後"), "被移出者讀不到新內容");
    // 只輪替一次
    assert_eq!(alice.team_key_epoch(&core), Some(2));
    assert_eq!(carol.team_key_epoch(&core), Some(2));

    // 改名、封存（管理者）
    assert!(alice.rename_team(&core, "改名").await.is_err());
    admin.rename_team(&core, "核心二").await.unwrap();
    admin.archive_team(&core, true).await.unwrap();
    let t = admin
        .teams_info()
        .into_iter()
        .find(|t| t.id == core)
        .unwrap();
    assert_eq!(t.name, "核心二");
    assert!(t.archived_at.is_some());
    admin.archive_team(&core, false).await.unwrap();
    assert!(
        admin
            .teams_info()
            .into_iter()
            .find(|t| t.id == core)
            .unwrap()
            .archived_at
            .is_none()
    );

    for n in [carol, bob, alice, admin] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}

/// D50：組長指派 → 成員收到通知 → 有困難 / 接下 → 組長看到。
#[tokio::test]
async fn assign_notify_and_ack() {
    use hills_node::{AckState, DEFAULT_TEAM, Event};
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let alice = invite_and_join(&admin, d_alice.path(), store(), "alice").await;
    sync_all(&[&admin, &alice]).await;
    let a = alice.member_id();
    let mut events = alice.events();

    let mut input = task("B2 設備清單比對");
    input.assignee = Some(a);
    let id = admin.create_task(DEFAULT_TEAM, input).await.unwrap();
    let mut got = false;
    let start = Instant::now();
    while !got && start.elapsed() < Duration::from_secs(10) {
        let _ = alice.sync_now().await;
        while let Ok(e) = events.try_recv() {
            if let Event::TaskAssigned { task, by, .. } = e {
                got |= task == id && by == admin.member_id();
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(got, "被指派者應收到通知");
    let t = alice
        .tasks()
        .unwrap()
        .into_iter()
        .find(|t| t.id == id)
        .unwrap();
    assert!(t.pending_ack());

    // 只有負責人能回應；有困難需附原因
    assert!(
        admin
            .set_task_ack(DEFAULT_TEAM, &id, AckState::Accepted, None)
            .await
            .is_err()
    );
    assert!(
        alice
            .set_task_ack(DEFAULT_TEAM, &id, AckState::Concern, None)
            .await
            .is_err()
    );
    alice
        .set_task_ack(
            DEFAULT_TEAM,
            &id,
            AckState::Concern,
            Some("需要測試帳號".into()),
        )
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(5), || async {
            let _ = admin.sync_now().await;
            admin.tasks().unwrap().iter().any(|t| {
                t.id == id
                    && t.ack.as_ref().is_some_and(|k| k.state == AckState::Concern)
                    && t.pending_ack()
            })
        })
        .await,
        "組長應看到有困難"
    );
    alice
        .set_task_ack(DEFAULT_TEAM, &id, AckState::Accepted, None)
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(5), || async {
            let _ = admin.sync_now().await;
            admin
                .tasks()
                .unwrap()
                .iter()
                .any(|t| t.id == id && !t.pending_ack())
        })
        .await,
        "接下後不再待接下"
    );
    for n in [alice, admin] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}
