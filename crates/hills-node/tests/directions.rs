#![allow(clippy::unwrap_used, clippy::expect_used)]
//! D47：公司方向與小組目標（technical-design §16.14 v0.20）——
//! 管理者寫公司方向、負責人寫小組目標，全員讀得到；個人年 / 季目標可對齊。

mod common;
use common::*;
use hills_node::DEFAULT_TEAM;
use hills_node::direction::{DirectionInput, TeamGoalInput};
use hills_node::plans::{Criterion, PlanInput, PlanLevel, PlanQuery, Visibility};

fn year(title: &str, aligned: Option<String>) -> PlanInput {
    PlanInput {
        id: None,
        level: PlanLevel::Year,
        period: "2027".into(),
        title: title.into(),
        parent_id: None,
        kr_ref: None,
        done: false,
        progress_override: None,
        key_results: vec![],
        aligned_goal_id: aligned,
        criteria: vec![Criterion {
            id: String::new(),
            text: "每週 80% 同事在用".into(),
        }],
        helps: vec![],
        visibility: Visibility::Org,
    }
}

#[tokio::test]
async fn directions_team_goals_and_alignment() {
    let mb = mailbox().await;
    let d: Vec<_> = (0..2).map(|_| tempfile::tempdir().unwrap()).collect();
    let admin = create(d[0].path(), store(), &mb.code).await;
    let alice = invite_and_join(&admin, d[1].path(), store(), "alice").await;

    // 公司方向只有管理者能寫
    let dir_input = DirectionInput {
        id: None,
        year: "2027".into(),
        title: "Hills 成為全公司的日常工具".into(),
        key_results: vec![],
    };
    assert!(alice.save_direction(dir_input.clone()).await.is_err());
    let dir = admin.save_direction(dir_input).await.unwrap();

    // 小組目標：建立者是預設小組的負責人；alice 不是
    let goal_input = TeamGoalInput {
        id: None,
        team: DEFAULT_TEAM.into(),
        year: "2027".into(),
        title: "M2 手機版與全員導入".into(),
        direction_id: Some(dir.clone()),
        key_results: vec![],
        criteria: vec![],
    };
    assert!(alice.save_team_goal(goal_input.clone()).await.is_err());
    // 不是負責人也不能繞過 Node 直接寫入文件（本機驗證層拒絕）
    assert!(
        alice
            .change(&format!("team-goals/{DEFAULT_TEAM}"), |_| Ok(()))
            .await
            .is_err()
    );
    // 年份不同的公司方向不能對齊
    let mut wrong_year = goal_input.clone();
    wrong_year.year = "2028".into();
    assert!(admin.save_team_goal(wrong_year).await.is_err());
    let goal = admin.save_team_goal(goal_input).await.unwrap();

    // alice 同步後讀得到公司方向與小組目標
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = alice.sync_now().await;
            alice.directions().unwrap().iter().any(|x| x.id == dir)
                && alice.team_goals().unwrap().iter().any(|g| g.id == goal)
        })
        .await
    );

    // 對齊：不存在的目標被拒絕；存在的可以
    assert!(
        alice
            .save_plan(year("x", Some("nope".into())))
            .await
            .is_err()
    );
    let y = alice
        .save_plan(year("手機版做到全員都在用", Some(goal.clone())))
        .await
        .unwrap();
    let mine = alice.plans(PlanQuery::Mine).unwrap();
    let item = mine.iter().find(|i| i.id == y).unwrap();
    assert_eq!(item.aligned_goal_id.as_deref(), Some(goal.as_str()));
    assert_eq!(item.criteria.len(), 1);
    assert!(!item.criteria[0].id.is_empty());

    // 這週重點：只有負責人能寫，全員讀得到
    assert!(
        alice
            .set_week_note(DEFAULT_TEAM, "2026-W46", "x")
            .await
            .is_err()
    );
    admin
        .set_week_note(DEFAULT_TEAM, "2026-W46", "全力 M1 驗收")
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = alice.sync_now().await;
            alice
                .week_notes()
                .unwrap()
                .iter()
                .any(|n| n.week == "2026-W46" && n.text == "全力 M1 驗收")
        })
        .await
    );

    // D48：AI 代理（MCP）只有管理者能開放，同步後全員讀得到
    assert!(!alice.mcp_allowed().unwrap());
    assert!(alice.set_mcp_allowed(true).await.is_err());
    admin.set_mcp_allowed(true).await.unwrap();
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = alice.sync_now().await;
            alice.mcp_allowed().unwrap()
        })
        .await
    );

    // 刪除小組目標後，對齊視為不存在（讀取端略過）
    admin.delete_team_goal(DEFAULT_TEAM, &goal).await.unwrap();
    assert!(!admin.alignable_goal_exists(&goal).unwrap());
}
