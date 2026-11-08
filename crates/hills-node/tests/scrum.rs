#![allow(clippy::unwrap_used, clippy::expect_used)]
//! 每日 Scrum（technical-design §16.12 v0.17）：小組成員互相看得到、阻礙通知負責人。

mod common;
use common::*;
use hills_node::Event;
use hills_node::scrum::{ScrumInput, ScrumRef};

fn input(blockers: &[&str], today: &str) -> ScrumInput {
    ScrumInput {
        date: "2026-11-09".into(),
        done: vec![ScrumRef::Task {
            team_id: "x".into(),
            task_id: "t".into(),
            title: "Mac 驗收".into(),
        }],
        today: vec![ScrumRef::Text {
            title: today.into(),
        }],
        blockers: blockers.iter().map(|s| (*s).to_owned()).collect(),
    }
}

#[tokio::test]
async fn scrum_shared_with_team_and_blockers_notify() {
    let mb = mailbox().await;
    let d: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let admin = create(d[0].path(), store(), &mb.code).await;
    let alice = invite_and_join(&admin, d[1].path(), store(), "alice").await;
    let bob = invite_and_join(&admin, d[2].path(), store(), "bob").await;
    let team = alice.org().teams_of(&alice.member_id())[0].clone();
    let mut admin_events = admin.events();

    // 預設小組沒有負責人 → 阻礙通知管理者
    let r = alice
        .scrum_submit(input(&["需要 relay 測試主機"], "Windows 驗收"))
        .await
        .unwrap();
    assert_eq!(r.blockers[0].notified, vec![admin.member_id().to_string()]);
    assert_eq!(
        alice.my_scrum("2026-11-09").unwrap().unwrap().today,
        r.today
    );
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = bob.sync_now().await;
            bob.scrum_reports(&team, "2026-11-01", "2026-11-30")
                .unwrap()
                .iter()
                .any(|x| x.member == alice.member_id())
        })
        .await,
        "同小組的 bob 應看到 alice 的 Scrum"
    );
    let mut got = false;
    let start = Instant::now();
    while !got && start.elapsed() < Duration::from_secs(10) {
        let _ = admin.sync_now().await;
        while let Ok(e) = admin_events.try_recv() {
            if let Event::ScrumBlocker { member, text, .. } = e {
                got |= member == alice.member_id() && text == "需要 relay 測試主機";
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(got, "管理者應收到阻礙通知");

    // 修改同一天：以新的為準
    alice
        .scrum_submit(input(&[], "Windows 驗收與週報"))
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = bob.sync_now().await;
            bob.scrum_reports(&team, "2026-11-09", "2026-11-09")
                .unwrap()
                .iter()
                .any(|x| x.member == alice.member_id()
                    && x.blockers.is_empty()
                    && matches!(&x.today[0], ScrumRef::Text { title } if title == "Windows 驗收與週報"))
        })
        .await,
        "修改後應以新的為準"
    );
    // 不屬於的小組讀不到；日期範圍驗證
    assert!(
        bob.scrum_reports("nope", "2026-11-01", "2026-11-30")
            .is_err()
    );
    assert!(
        bob.scrum_reports(&team, "2026-11-30", "2026-11-01")
            .is_err()
    );

    // 組織提醒時間：管理者可改，成員不行；個人覆寫只存本機
    assert_eq!(bob.scrum_reminder(), "17:30");
    assert!(bob.set_scrum_reminder("18:00").await.is_err());
    admin.set_scrum_reminder("18:00").await.unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = bob.sync_now().await;
            bob.scrum_reminder() == "18:00"
        })
        .await
    );
    bob.set_my_scrum_reminder(Some("09:30".into())).unwrap();
    assert_eq!(bob.scrum_local().reminder.as_deref(), Some("09:30"));
    assert!(bob.mark_scrum_reminded("2026-11-09").unwrap());
    assert!(
        !bob.mark_scrum_reminded("2026-11-09").unwrap(),
        "每天最多一次"
    );
    bob.set_scrum_draft("2026-11-09", Some("{}".into()))
        .unwrap();
    assert_eq!(
        bob.scrum_local()
            .drafts
            .get("2026-11-09")
            .map(String::as_str),
        Some("{}")
    );
    for n in [admin, alice, bob] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}
