#![allow(clippy::unwrap_used, clippy::expect_used)]
//! D40：任務、角色外觀、辦公室、回來時間與地點在兩個成員之間同步（technical-design §5.1、§16.8 v0.11）。

mod common;
use common::*;
use hills_node::{DEFAULT_TEAM, Location, Look, StepInput, TaskInput, TaskStatus};

#[tokio::test]
async fn tasks_profiles_offices_and_presence_sync() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let alice = invite_and_join(&admin, d_alice.path(), store(), "alice").await;
    admin.sync_now().await.unwrap();
    alice.sync_now().await.unwrap();
    let a = alice.member_id();
    let me = admin.member_id();

    // 任務：admin 建立，alice 2 秒內看到；alice 勾選步驟，admin 看到
    let id = admin
        .create_task(
            DEFAULT_TEAM,
            TaskInput {
                plan_item_id: None,
                team_goal_id: None,
                title: "Windows 驗收".into(),
                assignee: Some(a),
                status: None,
                due_at: Some(4_000_000_000_000),
                steps: vec![
                    StepInput {
                        title: "relay 更新".into(),
                        assignee: Some(me),
                        ..Default::default()
                    },
                    StepInput {
                        title: "通知測試".into(),
                        assignee: Some(a),
                        ..Default::default()
                    },
                ],
            },
        )
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(2), || async {
            alice.tasks().unwrap().iter().any(|t| t.id == id)
        })
        .await,
        "任務 2 秒內未同步"
    );
    // admin 負責下一步 → admin 的焦點是這個任務；alice 是負責人 → 也是她的焦點
    assert_eq!(admin.focus().unwrap().task.unwrap().id, id);
    assert_eq!(alice.focus().unwrap().task.unwrap().id, id);
    let step = alice.tasks().unwrap()[0].steps[0].id.clone();
    alice
        .set_step_done(DEFAULT_TEAM, &id, &step, true)
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(2), || async {
            admin.tasks().unwrap()[0].steps[0].done
        })
        .await
    );
    assert_eq!(admin.tasks().unwrap()[0].status, TaskStatus::Doing);
    // 下一步已不是 admin 的：admin 沒有焦點
    assert!(admin.focus().unwrap().task.is_none());

    // 角色外觀
    let look = Look {
        hair: 2,
        shirt: 5,
        skin: 1,
    };
    alice.set_profile(look).await.unwrap();
    assert!(
        eventually(Duration::from_secs(2), || async {
            admin.profiles().unwrap().get(&a) == Some(&look)
        })
        .await
    );

    // 辦公室（只有管理者）
    let office = admin.upsert_office(None, "台北辦公室").await.unwrap();
    assert!(alice.upsert_office(None, "偷建").await.is_err());
    admin.set_lunch_break("12:00", "13:30").await.unwrap();
    assert!(
        eventually(Duration::from_secs(2), || async {
            let o = alice.org();
            o.offices.contains_key(&office) && o.lunch_break.is_some()
        })
        .await
    );

    // 回來時間與地點
    assert!(
        eventually(Duration::from_secs(10), || async {
            admin.presence().contains_key(&a)
        })
        .await
    );
    let until = hills_proto_now() + 60_000;
    alice
        .set_presence_full(
            PresenceState::Lunch,
            "",
            Some(until),
            Location::Office(office.clone()),
        )
        .await;
    assert!(
        eventually(Duration::from_secs(2), || async {
            admin.presence().get(&a).is_some_and(|p| {
                p.state == PresenceState::Lunch
                    && p.until == Some(until)
                    && p.location == Location::Office(office.clone())
            })
        })
        .await
    );

    alice.shutdown().await;
    admin.shutdown().await;
    mb.router.shutdown().await.unwrap();
}

fn hills_proto_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
