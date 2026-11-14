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
        review: None,
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

/// D65：OGSM——公司目的只有管理者能寫；小組目的、策略與衡量只有負責人（或管理者）能寫，全員讀得到。
#[tokio::test]
async fn ogsm_purpose_strategies_and_measures() {
    use hills_node::ogsm::{Measure, MeasureSource, PurposeInput, StrategyInput};
    let mb = mailbox().await;
    let d: Vec<_> = (0..2).map(|_| tempfile::tempdir().unwrap()).collect();
    let admin = create(d[0].path(), store(), &mb.code).await;
    let alice = invite_and_join(&admin, d[1].path(), store(), "alice").await;

    let purpose = PurposeInput {
        title: "讓每個人知道團隊往哪走".into(),
        why: "工作散在 5 個工具".into(),
        period: "2026–2027".into(),
        goal_ids: vec![],
    };
    assert!(alice.save_org_purpose(purpose.clone()).await.is_err());
    admin.save_org_purpose(purpose).await.unwrap();

    let dir = admin
        .save_direction(DirectionInput {
            id: None,
            year: "2027".into(),
            title: "全員導入".into(),
            key_results: vec![],
        })
        .await
        .unwrap();
    let goal = admin
        .save_team_goal(TeamGoalInput {
            id: None,
            team: DEFAULT_TEAM.into(),
            year: "2027".into(),
            title: "M1、M2 準時上線".into(),
            direction_id: Some(dir.clone()),
            key_results: vec![],
            criteria: vec![],
        })
        .await
        .unwrap();

    let team_purpose = PurposeInput {
        title: "桌機版每天穩定可用".into(),
        why: String::new(),
        period: "2027".into(),
        goal_ids: vec![dir.clone()],
    };
    assert!(
        alice
            .save_team_purpose(DEFAULT_TEAM, team_purpose.clone())
            .await
            .is_err()
    );
    admin
        .save_team_purpose(DEFAULT_TEAM, team_purpose)
        .await
        .unwrap();

    let strategy = StrategyInput {
        id: None,
        team: DEFAULT_TEAM.into(),
        title: "先穩定 Mac / Windows".into(),
        how: None,
        goal_ids: vec![goal.clone()],
        owners: vec![alice.member_id().to_string()],
        measures: vec![Measure {
            id: String::new(),
            title: "安裝成功率".into(),
            source: MeasureSource::Manual {
                current: 48.0,
                target: 50.0,
                unit: None,
                updated_at: 0,
            },
        }],
        order: None,
    };
    assert!(alice.save_strategy(strategy.clone()).await.is_err());
    let sid = admin.save_strategy(strategy).await.unwrap();

    // alice 同步後讀得到公司目的、小組目的與策略（含她是負責的人）
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = alice.sync_now().await;
            let (purposes, strategies) = alice.team_ogsm().unwrap();
            alice.org_purpose().unwrap().is_some()
                && purposes.iter().any(|p| p.goal_ids == vec![dir.clone()])
                && strategies
                    .iter()
                    .any(|s| s.id == sid && s.owners == vec![alice.member_id().to_string()])
        })
        .await
    );
    assert!(alice.delete_strategy(DEFAULT_TEAM, &sid).await.is_err());
    admin.delete_strategy(DEFAULT_TEAM, &sid).await.unwrap();
    assert!(admin.team_ogsm().unwrap().1.is_empty());
}
