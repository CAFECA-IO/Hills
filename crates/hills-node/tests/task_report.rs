#![allow(clippy::unwrap_used, clippy::expect_used)]
//! D53：沒有步驟的任務結案 → 對方看到報告 → 指派者退回 → 再結案（technical-design §16.8 v0.33）。

mod common;
use common::*;
use hills_node::task_report::{CloseInput, LogKind};
use hills_node::{DEFAULT_TEAM, TaskInput, TaskStatus};

fn report(body: &str) -> CloseInput {
    serde_json::from_value(serde_json::json!({ "format": "markdown", "body": body })).unwrap()
}

#[tokio::test]
async fn close_reopen_and_close_again() {
    let mb = mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let admin = create(d_admin.path(), store(), &mb.code).await;
    let d_alice = tempfile::tempdir().unwrap();
    let alice = invite_and_join(&admin, d_alice.path(), store(), "alice").await;
    admin.sync_now().await.unwrap();
    alice.sync_now().await.unwrap();
    let a = alice.member_id();

    // 已過期、沒有步驟的任務
    let id = admin
        .create_task(
            DEFAULT_TEAM,
            TaskInput {
                title: "確認主管期待".into(),
                assignee: Some(a),
                due_at: Some(1_000),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(2), || async {
            alice.tasks().unwrap().iter().any(|t| t.id == id)
        })
        .await
    );

    // 只有負責人可以結案；報告需要摘要段落
    assert!(
        admin
            .close_task(DEFAULT_TEAM, &id, report("## 結果摘要 {#summary}\n好"))
            .await
            .is_err()
    );
    assert!(
        alice
            .close_task(DEFAULT_TEAM, &id, report("沒有段落"))
            .await
            .is_err()
    );
    alice
        .add_task_log(
            DEFAULT_TEAM,
            &id,
            LogKind::Progress,
            "訪談完成一半",
            Some(50),
        )
        .await
        .unwrap();
    alice
        .close_task(
            DEFAULT_TEAM,
            &id,
            report("## 結果摘要 {#summary}\n每週五交週報"),
        )
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(2), || async {
            let done = admin
                .tasks()
                .unwrap()
                .iter()
                .any(|t| t.id == id && t.status == TaskStatus::Done);
            done && admin.task_report(DEFAULT_TEAM, &id).unwrap().is_some()
        })
        .await
    );

    // 指派者退回（意見必填）
    assert!(admin.reopen_task(DEFAULT_TEAM, &id, " ").await.is_err());
    admin
        .reopen_task(DEFAULT_TEAM, &id, "請補上報告頻率")
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(2), || async {
            alice
                .tasks()
                .unwrap()
                .iter()
                .any(|t| t.id == id && t.status == TaskStatus::Doing)
        })
        .await
    );

    // 再結案，紀錄完整
    alice
        .close_task(
            DEFAULT_TEAM,
            &id,
            report("## 結果摘要 {#summary}\n每週五交週報，月底簡報"),
        )
        .await
        .unwrap();
    let kinds: Vec<LogKind> = alice
        .task_logs(DEFAULT_TEAM, &id)
        .unwrap()
        .into_iter()
        .map(|l| l.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![
            LogKind::Progress,
            LogKind::Close,
            LogKind::Reopen,
            LogKind::Close
        ]
    );
    assert!(
        alice
            .task_report(DEFAULT_TEAM, &id)
            .unwrap()
            .unwrap()
            .body
            .contains("月底簡報")
    );
}
