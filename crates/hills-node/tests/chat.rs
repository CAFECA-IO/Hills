#![allow(clippy::unwrap_used, clippy::expect_used)] // 測試檔：失敗即 panic
//! M1 對話整合測試（technical-design §14）：一個 mailbox + 多個 node，本機直連。

mod common;
use common::*;
use hills_node::{ConvKind, Event, Message};

fn bodies(n: &Node, conv: &str) -> Vec<String> {
    n.messages(conv, 100)
        .map(|v| v.into_iter().map(|m: Message| m.body).collect())
        .unwrap_or_default()
}

async fn sync_all(nodes: &[&Node]) {
    for n in nodes {
        let _ = n.sync_now().await;
    }
}

/// 管理者 + alice + bob，彼此已互相同步。
async fn trio(mb: &MailboxServer) -> (Vec<tempfile::TempDir>, Node, Node, Node) {
    let d = vec![
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    ];
    let admin = create(d[0].path(), store(), &mb.code).await;
    let alice = invite_and_join(&admin, d[1].path(), store(), "alice").await;
    let bob = invite_and_join(&admin, d[2].path(), store(), "bob").await;
    sync_all(&[&admin, &alice, &bob]).await;
    sync_all(&[&admin, &alice, &bob]).await;
    (d, admin, alice, bob)
}

/// 私訊：即時送達（gossip + 直連 ≤ 2 秒），第三人看不到；通知事件。
#[tokio::test]
async fn dm_is_private_and_fast() {
    let mb = mailbox().await;
    let (_d, admin, alice, bob) = trio(&mb).await;
    let conv = alice
        .create_conv(ConvKind::Dm, "", &[bob.member_id()])
        .await
        .unwrap();
    // bob 取得金鑰與 meta
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = bob.sync_now().await;
            bob.conversations().iter().any(|c| c.info.id == conv)
        })
        .await,
        "bob 沒有收到私訊"
    );
    let mut ev = bob.events();
    let t = Instant::now();
    alice
        .send_message(&conv, "嗨 bob", &[], serde_json::Value::Null)
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(2), || async {
            bodies(&bob, &conv) == ["嗨 bob"]
        })
        .await,
        "2 秒內未收到"
    );
    eprintln!("私訊送達 {:?}", t.elapsed());
    let mut notified = false;
    while let Ok(e) = ev.try_recv() {
        if let Event::Message {
            conv: c, notify, ..
        } = e
        {
            notified |= c == conv && notify;
        }
    }
    assert!(notified, "私訊應觸發通知");
    // 管理者不是成員：清單沒有、也讀不到
    sync_all(&[&admin]).await;
    assert!(admin.conversations().is_empty());
    assert!(admin.messages(&conv, 10).is_err());
    // 未讀數
    let v = bob.conversations();
    assert_eq!(v[0].unread, 1);
    bob.mark_read(&conv, v[0].last.as_ref().unwrap().created_at)
        .unwrap();
    assert_eq!(bob.conversations()[0].unread, 0);
    for n in [admin, alice, bob] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}

/// 群組：三人互傳；提及；移出成員後看不到新訊息；新成員看不到加入前的訊息。
#[tokio::test]
async fn group_membership_and_epochs() {
    let mb = mailbox().await;
    let (_d, admin, alice, bob) = trio(&mb).await;
    let conv = alice
        .create_conv(ConvKind::Group, "產品討論", &[bob.member_id()])
        .await
        .unwrap();
    alice
        .send_message(&conv, "第一則", &[], serde_json::Value::Null)
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = bob.sync_now().await;
            bodies(&bob, &conv) == ["第一則"]
        })
        .await
    );
    // 加入管理者：看不到加入前的訊息（D37）
    alice
        .add_conv_members(&conv, &[admin.member_id()])
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = admin.sync_now().await;
            admin.conversations().iter().any(|c| c.info.id == conv)
        })
        .await,
        "管理者未加入"
    );
    assert!(
        bodies(&admin, &conv).is_empty(),
        "新成員不應看到加入前的訊息"
    );
    bob.send_message(
        &conv,
        "@admin 看一下",
        &[admin.member_id()],
        serde_json::Value::Null,
    )
    .await
    .unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = admin.sync_now().await;
            bodies(&admin, &conv) == ["@admin 看一下"]
        })
        .await
    );
    let m = admin.messages(&conv, 10).unwrap();
    assert_eq!(m[0].mentions, vec![admin.member_id()]);
    assert_eq!(m[0].author, bob.member_id());

    // 移出 bob：之後的訊息 bob 讀不到；bob 也不能再寫
    alice
        .remove_conv_member(&conv, bob.member_id())
        .await
        .unwrap();
    alice
        .send_message(&conv, "移出後", &[], serde_json::Value::Null)
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = admin.sync_now().await;
            bodies(&admin, &conv).contains(&"移出後".to_owned())
        })
        .await
    );
    sync_all(&[&bob, &bob]).await;
    assert!(
        !bodies(&bob, &conv).contains(&"移出後".to_owned()),
        "被移出者不應讀到新訊息"
    );
    for n in [admin, alice, bob] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}

/// 離線補同步：收件者離線時送出的訊息，上線後經 mailbox 取得。
#[tokio::test]
async fn offline_member_catches_up() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let ss_alice = store();
    let alice = invite_and_join(&admin, d_alice.path(), ss_alice.clone(), "alice").await;
    let id = alice.member_id();
    alice.shutdown().await;
    drop(alice);

    let conv = admin.create_conv(ConvKind::Dm, "", &[id]).await.unwrap();
    admin
        .send_message(&conv, "離線時送出", &[], serde_json::Value::Null)
        .await
        .unwrap();
    admin.sync_now().await.unwrap();

    let alice = Node::open(d_alice.path(), ss_alice.clone(), opts())
        .await
        .unwrap()
        .unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = alice.sync_now().await;
            bodies(&alice, &conv) == ["離線時送出"]
        })
        .await
    );
    // 重新開啟後仍在（對話投影由本機文件重建）
    alice.shutdown().await;
    drop(alice);
    let alice = Node::open(d_alice.path(), ss_alice, opts())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bodies(&alice, &conv), ["離線時送出"]);
    alice.shutdown().await;
    admin.shutdown().await;
    mb.router.shutdown().await.unwrap();
}

/// 停用組織成員：其所在對話由建立者自動移出並輪替。
#[tokio::test]
async fn revoked_org_member_is_pruned_from_conversations() {
    let mb = mailbox().await;
    let (_d, admin, alice, bob) = trio(&mb).await;
    let conv = admin
        .create_conv(
            ConvKind::Group,
            "全員",
            &[alice.member_id(), bob.member_id()],
        )
        .await
        .unwrap();
    sync_all(&[&admin, &alice, &bob]).await;
    admin.revoke_member(bob.member_id()).await.unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = admin.sync_now().await;
            admin
                .conversations()
                .iter()
                .find(|c| c.info.id == conv)
                .is_some_and(|c| !c.info.members.contains(&bob.member_id()))
        })
        .await,
        "bob 應被移出對話"
    );
    for n in [admin, alice, bob] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}

/// 成員還原後（§17.7）：對話建立者重新封裝對話金鑰，還原的成員讀得到還原前的訊息。
#[tokio::test]
async fn recovered_member_reads_history() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let acct = account();
    let alice = join_as(&admin, d_alice.path(), store(), "alice", acct).await;
    sync_all(&[&admin, &alice]).await;
    let conv = admin
        .create_conv(ConvKind::Dm, "", &[alice.member_id()])
        .await
        .unwrap();
    admin
        .send_message(&conv, "還原前的訊息", &[], serde_json::Value::Null)
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = alice.sync_now().await;
            bodies(&alice, &conv) == ["還原前的訊息"]
        })
        .await
    );
    let org_code = alice.org_ticket().unwrap();
    alice.shutdown().await;
    drop(alice);
    drop(d_alice);

    let d_new = tempfile::tempdir().unwrap();
    let (_, step) = sign_in(
        d_new.path(),
        store(),
        OnboardKind::Recover {
            org_code,
            device_name: "new-pc".into(),
        },
        acct,
        "alice",
    )
    .await;
    let OnboardStep::WaitingApproval(restored) = step else {
        panic!("還原應等待核准");
    };
    approve_pending(&admin, &restored).await;
    assert!(
        eventually(Duration::from_secs(15), || async {
            sync_all(&[&admin, &restored]).await;
            bodies(&restored, &conv) == ["還原前的訊息"]
        })
        .await,
        "還原後應讀得到對話歷史"
    );
    restored.shutdown().await;
    admin.shutdown().await;
    mb.router.shutdown().await.unwrap();
}

/// 焦點營地：任何成員可連結任務，以最新一則為準；連結訊息不計未讀、不通知（§14.2 v0.14）。
#[tokio::test]
async fn conversation_task_link() {
    let mb = mailbox().await;
    let (_d, _admin, alice, bob) = trio(&mb).await;
    let team = alice.org().teams_of(&alice.member_id())[0].clone();
    let input = |title: &str| hills_node::team::TaskInput {
        plan_item_id: None,
        team_goal_id: None,
        title: title.into(),
        assignee: None,
        status: None,
        due_at: None,
        steps: vec![],
    };
    let t1 = alice.create_task(&team, input("驗收")).await.unwrap();
    let t2 = alice.create_task(&team, input("部署")).await.unwrap();
    let conv = alice
        .create_conv(ConvKind::Dm, "", &[bob.member_id()])
        .await
        .unwrap();
    // 不存在的任務被拒
    assert!(
        alice
            .set_conv_task(&conv, Some((&team, "nope")))
            .await
            .is_err()
    );
    alice
        .set_conv_task(&conv, Some((&team, &t1)))
        .await
        .unwrap();
    let linked = |n: &Node| {
        n.conversations()
            .into_iter()
            .find(|c| c.info.id == conv)
            .and_then(|c| c.task)
            .map(|t| t.id)
    };
    assert_eq!(linked(&alice), Some(t1.clone()));
    let mut ev = bob.events();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = bob.sync_now().await;
            linked(&bob) == Some(t1.clone())
        })
        .await,
        "bob 應看到連結的任務"
    );
    let row = bob
        .conversations()
        .into_iter()
        .find(|c| c.info.id == conv)
        .unwrap();
    assert_eq!(row.unread, 0, "連結訊息不計未讀");
    assert!(row.last.is_none(), "連結訊息不是最後訊息");
    while let Ok(e) = ev.try_recv() {
        if let Event::Message { notify, .. } = e {
            assert!(!notify, "連結訊息不通知");
        }
    }
    // bob 等任務同步後改連另一個；以最新為準
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = bob.sync_now().await;
            bob.tasks().unwrap().iter().any(|t| t.id == t2)
        })
        .await
    );
    bob.set_conv_task(&conv, Some((&team, &t2))).await.unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = alice.sync_now().await;
            linked(&alice) == Some(t2.clone())
        })
        .await
    );
    // 取消連結
    alice.set_conv_task(&conv, None).await.unwrap();
    assert_eq!(linked(&alice), None);
    for n in [alice, bob] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}
