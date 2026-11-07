#![allow(clippy::unwrap_used, clippy::expect_used)] // 測試檔：失敗即 panic
//! 多節點整合測試：一個 mailbox + 多個 node，停用 relay，本機直連。
//!
//! 對應 M0 第三批計畫「驗證」1–6（technical-design §16）。

mod common;
use common::*;

/// 1. 管理者離線時送出加入申請；管理者上線後在「待核准」看到並核准，成員取得憑證、金鑰與 org 文件。
#[tokio::test]
async fn join_while_admin_offline() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let ss_admin = store();
    let admin = create(d_admin.path(), ss_admin.clone(), &mb.code).await;
    let org_code = admin.org_ticket().unwrap();
    admin.shutdown().await;
    drop(admin);

    let d_alice = tempfile::tempdir().unwrap();
    let alice_account = account();
    let (_, step) = sign_in(
        d_alice.path(),
        store(),
        OnboardKind::Join {
            org_code,
            my_name: "Alice".into(),
            device_name: "alice-pc".into(),
        },
        alice_account,
        "alice",
    )
    .await;
    let OnboardStep::WaitingApproval(alice) = step else {
        panic!("應等待核准");
    };
    assert_eq!(alice.status(), SyncStatus::Pending);
    assert!(alice.sync_now().await.is_err(), "核准前不能連 mailbox");
    assert_eq!(alice.cafeca(), Some(alice_account));

    let admin = Node::open(d_admin.path(), ss_admin, opts())
        .await
        .unwrap()
        .unwrap();
    approve_pending(&admin, &alice).await;
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = alice.sync_now().await;
            alice.org().members.contains_key(&alice.member_id())
        })
        .await
    );
    assert_eq!(org_name(&alice), "測試組織");
    assert!(!alice.is_admin());
    let rec = admin.org().members[&alice.member_id()].clone();
    assert_eq!(rec.handle.as_deref(), Some("alice"));
    assert_eq!(rec.cafeca, Some(alice_account.caip10()));
    assert!(admin.pending_joins().is_empty());
    alice.shutdown().await;
    admin.shutdown().await;
    mb.router.shutdown().await.unwrap();
}

/// 1b. 管理者拒絕申請：申請者收到 Rejected 事件，無法連線。
#[tokio::test]
async fn rejected_join() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_x = tempfile::tempdir().unwrap();
    let (_, step) = sign_in(
        d_x.path(),
        store(),
        OnboardKind::Join {
            org_code: admin.org_ticket().unwrap(),
            my_name: "X".into(),
            device_name: "x-pc".into(),
        },
        account(),
        "x",
    )
    .await;
    let OnboardStep::WaitingApproval(x) = step else {
        panic!("應等待核准");
    };
    let mut events = x.events();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = admin.sync_now().await;
            !admin.pending_joins().is_empty()
        })
        .await
    );
    admin.reject_join(x.device()).await.unwrap();
    assert!(admin.pending_joins().is_empty());
    let got = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let _ = x.sync_now().await;
            while let Ok(e) = events.try_recv() {
                if e == hills_node::Event::Rejected {
                    return true;
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .unwrap_or(false);
    assert!(got, "申請者應收到被拒絕的通知");
    x.shutdown().await;
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

/// 4. 新裝置：同一 CAFECA 帳戶在新電腦登入 → 本人其他裝置自動封裝成員金鑰 → 新裝置能同步。
#[tokio::test]
async fn add_device_with_cafeca() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let acct = account();
    let alice = join_as(&admin, d_alice.path(), store(), "alice", acct).await;
    let mut alice_events = alice.events();

    let d2 = tempfile::tempdir().unwrap();
    let (mut ob, step) = sign_in(
        d2.path(),
        store(),
        OnboardKind::Join {
            org_code: alice.org_ticket().unwrap(),
            my_name: String::new(),
            device_name: "alice-laptop".into(),
        },
        acct,
        "alice",
    )
    .await;
    assert!(
        matches!(step, OnboardStep::WaitingDevice { .. }),
        "已是成員應等待本人裝置"
    );
    // alice 的裝置同步時自動授權
    let mut laptop = None;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        let _ = alice.sync_now().await;
        if let OnboardStep::Linked(n) = ob.poll().await.unwrap() {
            laptop = Some(n);
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let laptop = laptop.expect("新裝置應完成綁定");
    assert_eq!(laptop.member_id(), alice.member_id());
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = laptop.sync_now().await;
            org_name(&laptop) == "測試組織"
        })
        .await
    );
    assert_eq!(alice.devices().len(), 2);
    let mut notified = false;
    while let Ok(e) = alice_events.try_recv() {
        if matches!(e, hills_node::Event::DeviceAdded { ref name, .. } if name == "alice-laptop") {
            notified = true;
        }
    }
    assert!(notified, "原裝置應收到新裝置通知");
    // 新裝置也收得到之後的變更
    admin.rename_org("綁定後").await.unwrap();
    assert!(
        eventually(Duration::from_secs(5), || async {
            let _ = laptop.sync_now().await;
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

/// 6. 遺失全部裝置：以同一 CAFECA 帳戶申請還原 → 管理者核准 → 換發金鑰，讀回組織資料；
/// 舊裝置失效。
#[tokio::test]
async fn recover_with_cafeca() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let acct = account();
    let alice = join_as(&admin, d_alice.path(), store(), "alice", acct).await;
    admin.rename_org("還原前").await.unwrap();
    admin.sync_now().await.unwrap();

    let org_code = alice.org_ticket().unwrap();
    let id = alice.member_id();
    let old_device = alice.device();
    alice.shutdown().await;
    drop(alice);
    drop(d_alice); // 刪除本機資料

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
    assert_eq!(restored.member_id(), id);
    approve_pending(&admin, &restored).await;
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = restored.sync_now().await;
            org_name(&restored) == "還原前"
        })
        .await
    );
    // 舊裝置已失效、角色沿用
    assert!(!restored.devices().iter().any(|d| d.device == old_device));
    assert!(!restored.is_admin());
    restored.shutdown().await;
    admin.shutdown().await;
    mb.router.shutdown().await.unwrap();
}

fn org_mailbox(n: &Node) -> hills_proto::PeerAddr {
    hills_proto::ticket::OrgTicket::from_code(&n.org_ticket().unwrap())
        .unwrap()
        .mailbox
}

/// 7. mailbox 位址更新（technical-design §16.1）：以不含 relay 的連線碼建立組織，
/// mailbox 之後回報含 relay 的位址 → node 更新已存位址，之後的組織連線碼帶 relay；
/// NodeId 不同的位址被忽略。
#[tokio::test]
async fn mailbox_address_refresh() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let ss = store();
    let admin = create(d_admin.path(), ss.clone(), &mb.code).await;
    assert_eq!(org_mailbox(&admin).relay, None);

    // NodeId 不同：忽略
    let mut other = mb.addr.clone();
    other.node = hills_proto::Pub32([9; 32]);
    other.relay = Some("https://evil.invalid/".into());
    mb.mb.set_self_addr(other);
    admin.sync_now().await.unwrap();
    assert_eq!(org_mailbox(&admin).relay, None);

    // 同一 mailbox 補上 relay
    let mut fixed = mb.addr.clone();
    fixed.relay = Some("https://relay.invalid/".into());
    mb.mb.set_self_addr(fixed.clone());
    admin.sync_now().await.unwrap();
    assert_eq!(org_mailbox(&admin), fixed);
    // 仍可與 mailbox 同步（直連位址未變）
    admin.rename_org("更新位址後").await.unwrap();
    admin.sync_now().await.unwrap();

    // 重新啟動後沿用新位址
    admin.shutdown().await;
    drop(admin);
    let admin = Node::open(d_admin.path(), ss, opts())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(org_mailbox(&admin), fixed);
    admin.shutdown().await;
    mb.router.shutdown().await.unwrap();
}
