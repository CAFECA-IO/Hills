#![allow(clippy::unwrap_used, clippy::expect_used)]
//! D46：任務是目標的最底層（technical-design §16.8、§16.10 v0.19）——
//! 私人任務只有本人看得到；小組任務連到週目標；不再寫入日目標。

mod common;
use common::*;
use hills_node::DEFAULT_TEAM;
use hills_node::plans::{PlanInput, PlanLevel, PlanQuery, Visibility};
use hills_node::team::{PRIVATE_TEAM, StepInput, TaskInput};

fn week(title: &str) -> PlanInput {
    PlanInput {
        id: None,
        level: PlanLevel::Week,
        period: "2026-W46".into(),
        title: title.into(),
        parent_id: None,
        kr_ref: None,
        done: false,
        progress_override: None,
        key_results: vec![],
        aligned_goal_id: None,
        criteria: vec![],
        helps: vec![],
        review: None,
        visibility: Visibility::Private,
    }
}

#[tokio::test]
async fn private_tasks_and_week_goals() {
    let mb = mailbox().await;
    let d: Vec<_> = (0..2).map(|_| tempfile::tempdir().unwrap()).collect();
    let admin = create(d[0].path(), store(), &mb.code).await;
    let alice = invite_and_join(&admin, d[1].path(), store(), "alice").await;
    let me = alice.member_id();

    // 日目標不再寫入
    let mut day = week("舊的日目標");
    day.level = PlanLevel::Day;
    day.period = "2026-11-09".into();
    assert!(alice.save_plan(day).await.is_err());

    // 週目標（私人）＋連到它的小組任務與私人任務
    let w = alice.save_plan(week("檔案分享")).await.unwrap();
    let team_task = alice
        .create_task(
            DEFAULT_TEAM,
            TaskInput {
                plan_item_id: Some(w.clone()),
                title: "壓力測試".into(),
                assignee: Some(me),
                steps: vec![
                    StepInput {
                        title: "準備資料".into(),
                        ..Default::default()
                    },
                    StepInput {
                        title: "執行".into(),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let mine = alice
        .create_task(
            PRIVATE_TEAM,
            TaskInput {
                plan_item_id: Some(w.clone()),
                title: "整理筆記".into(),
                assignee: Some(admin.member_id()), // 私人任務負責人固定為本人
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let tasks = alice.tasks().unwrap();
    let p = tasks.iter().find(|t| t.id == mine).unwrap();
    assert!(p.is_private());
    assert_eq!(p.assignee, Some(me));
    assert_eq!(p.plan_item_id.as_deref(), Some(w.as_str()));

    // 不存在或不是週層級的目標不能連結
    let bad = alice
        .create_task(
            DEFAULT_TEAM,
            TaskInput {
                plan_item_id: Some("nope".into()),
                title: "x".into(),
                ..Default::default()
            },
        )
        .await;
    assert!(bad.is_err());

    // 私人任務不能連到對話
    let conv = alice
        .create_conv(hills_node::ConvKind::Group, "討論", &[admin.member_id()])
        .await
        .unwrap();
    assert!(
        alice
            .set_conv_task(&conv, Some((PRIVATE_TEAM, &mine)))
            .await
            .is_err()
    );

    // admin 看得到小組任務，看不到私人任務
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = admin.sync_now().await;
            admin.tasks().unwrap().iter().any(|t| t.id == team_task)
        })
        .await
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = admin.sync_now().await;
    assert!(!admin.tasks().unwrap().iter().any(|t| t.id == mine));

    // 週目標仍在，日目標沒有出現
    let plans = alice.plans(PlanQuery::Mine).unwrap();
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].id, w);
}
