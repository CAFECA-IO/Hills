#![allow(clippy::unwrap_used, clippy::expect_used)]
//! 日 / 週報（technical-design §16.13 v0.18）：發佈到小組、同小組可讀、更新以新內容為準。

mod common;
use common::*;
use hills_node::reports::{ReportInput, ReportKind, ReportSections};

fn input(team: &str, progress: &str) -> ReportInput {
    ReportInput {
        kind: ReportKind::Weekly,
        period: "2026-W45".into(),
        sections: ReportSections {
            progress: progress.into(),
            okr: "- M1 上線 62%".into(),
            attendance: "（待假勤）".into(),
            next: "- 壓力測試".into(),
        },
        published_to: if team.is_empty() {
            vec![]
        } else {
            vec![team.into()]
        },
        generated_at: Some(1),
        data: None,
    }
}

#[tokio::test]
async fn weekly_report_published_to_team() {
    let mb = mailbox().await;
    let d: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let admin = create(d[0].path(), store(), &mb.code).await;
    let alice = invite_and_join(&admin, d[1].path(), store(), "alice").await;
    let bob = invite_and_join(&admin, d[2].path(), store(), "bob").await;
    let team = alice.org().teams_of(&alice.member_id())[0].clone();

    // 發佈範圍不可空、不可是不屬於的小組
    assert!(alice.publish_report(input("", "x")).await.is_err());
    assert!(alice.publish_report(input("nope", "x")).await.is_err());

    let r = alice
        .publish_report(input(&team, "- 完成 Mac 驗收"))
        .await
        .unwrap();
    assert_eq!(r.published_to, vec![team.clone()]);
    assert!(r.edited_at.is_none());
    let seen = |n: &Node, text: &str| {
        n.team_reports(&team, ReportKind::Weekly, "2026-W45")
            .unwrap()
            .iter()
            .any(|x| x.member == alice.member_id() && x.sections.progress == text)
    };
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = bob.sync_now().await;
            seen(&bob, "- 完成 Mac 驗收")
        })
        .await,
        "同小組的 bob 應看到 alice 的週報"
    );

    // 更新後以新內容為準
    let r2 = alice
        .publish_report(input(&team, "- 完成 Mac 與 Windows 驗收"))
        .await
        .unwrap();
    assert!(r2.edited_at.is_some());
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = bob.sync_now().await;
            seen(&bob, "- 完成 Mac 與 Windows 驗收")
        })
        .await
    );
    assert_eq!(
        alice
            .my_report(ReportKind::Weekly, "2026-W45")
            .unwrap()
            .unwrap()
            .sections
            .progress,
        "- 完成 Mac 與 Windows 驗收"
    );
    assert!(
        bob.team_reports("nope", ReportKind::Weekly, "2026-W45")
            .is_err()
    );
    assert!(
        bob.team_reports(&team, ReportKind::Daily, "2026-W45")
            .is_err()
    );

    // 本機草稿與每週一次的提醒紀錄
    alice
        .set_report_draft(ReportKind::Daily, "2026-11-09", Some("{}".into()))
        .unwrap();
    assert!(alice.report_local().drafts.contains_key("daily:2026-11-09"));
    assert!(alice.mark_report_reminded("2026-W45").unwrap());
    assert!(!alice.mark_report_reminded("2026-W45").unwrap());
    for n in [admin, alice, bob] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}
