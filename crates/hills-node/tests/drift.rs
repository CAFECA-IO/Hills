#![allow(clippy::unwrap_used, clippy::expect_used)]
//! D47 第 2 批：方向摘要全員可讀、對齊建議、偏離門檻（technical-design §16.14 v0.21）。

mod common;
use common::*;
use hills_node::DEFAULT_TEAM;
use hills_node::direction::TeamGoalInput;
use hills_node::drift::{DirectionRules, DirectionWeek, GoalBrief};
use hills_node::team::{TaskInput, TaskStatus};

fn summary(week: &str) -> DirectionWeek {
    DirectionWeek {
        v: 1,
        week: week.into(),
        units: 5,
        aligned_units: 1,
        quarter_progress: Some(50.0),
        goals: vec![GoalBrief {
            id: "q1".into(),
            title: "研究 Rust GUI 框架".into(),
            progress: 50.0,
            aligned_goal_id: None,
        }],
        private_goals: 0,
        last_activity: 1,
        open_tasks: 2,
        due_this_week: 1,
        updated_at: 0,
    }
}

#[tokio::test]
async fn summaries_suggestions_and_rules() {
    let mb = mailbox().await;
    let d: Vec<_> = (0..2).map(|_| tempfile::tempdir().unwrap()).collect();
    let admin = create(d[0].path(), store(), &mb.code).await;
    let alice = invite_and_join(&admin, d[1].path(), store(), "alice").await;

    // 任務完成時寫入 doneAt
    let t = alice
        .create_task(
            DEFAULT_TEAM,
            TaskInput {
                title: "比較 Tauri 與 Slint".into(),
                assignee: Some(alice.member_id()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    alice
        .update_task(
            DEFAULT_TEAM,
            &t,
            TaskInput {
                title: "比較 Tauri 與 Slint".into(),
                assignee: Some(alice.member_id()),
                status: Some(TaskStatus::Done),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let task = alice
        .tasks()
        .unwrap()
        .into_iter()
        .find(|x| x.id == t)
        .unwrap();
    assert!(task.done_at.is_some());

    // 格式不符的摘要被拒絕
    let mut bad = summary("2026-W46");
    bad.aligned_units = 9;
    assert!(alice.publish_direction(bad).await.is_err());
    alice.publish_direction(summary("2026-W46")).await.unwrap();

    // 管理者讀得到 alice 的摘要
    let me = alice.member_id().to_string();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = admin.sync_now().await;
            admin
                .direction_summaries()
                .unwrap()
                .iter()
                .any(|m| m.member == me && m.weeks.first().is_some_and(|w| w.units == 5))
        })
        .await
    );

    // 管理者建立小組目標並建議 alice 對齊；不能建議自己、不能對齊不存在的目標
    let goal = admin
        .save_team_goal(TeamGoalInput {
            id: None,
            team: DEFAULT_TEAM.into(),
            year: "2026".into(),
            title: "M1、M2 準時上線".into(),
            direction_id: None,
            key_results: vec![],
            criteria: vec![],
        })
        .await
        .unwrap();
    assert!(
        admin
            .suggest_align(admin.member_id(), "q1", &goal)
            .await
            .is_err()
    );
    assert!(
        admin
            .suggest_align(alice.member_id(), "q1", "nope")
            .await
            .is_err()
    );
    admin
        .suggest_align(alice.member_id(), "q1", &goal)
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = alice.sync_now().await;
            alice
                .my_suggestions()
                .unwrap()
                .iter()
                .any(|s| s.goal_id == goal && s.plan_item_id == "q1")
        })
        .await
    );
    assert!(admin.my_suggestions().unwrap().is_empty());

    // 門檻只有管理者能改
    let rules = DirectionRules {
        min_aligned_share: 60,
        behind_points: 20,
        stale_days: 10,
    };
    assert!(alice.set_direction_rules(rules).await.is_err());
    admin.set_direction_rules(rules).await.unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = alice.sync_now().await;
            alice.direction_rules().unwrap() == rules
        })
        .await
    );
}
