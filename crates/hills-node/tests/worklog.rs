#![allow(clippy::unwrap_used, clippy::expect_used)]
//! D62：工作紀錄只有本人與所屬小組負責人讀得到（管理者不是負責人時也讀不到）；負責人卸任時輪替（technical-design §16.18）。

mod common;
use common::*;
use hills_node::Node;
use hills_node::worklog::{DayLog, Entry, WorkRef};

async fn sync_all(nodes: &[&Node]) {
    for n in nodes {
        let _ = n.sync_now().await;
    }
}

fn day(minutes: u32) -> DayLog {
    DayLog {
        date: String::new(),
        entries: vec![Entry {
            work: WorkRef::Other {
                title: "整理文件".into(),
            },
            project: None,
            minutes,
            source: "manual".into(),
        }],
        attendance: None,
        updated_at: 0,
    }
}

#[tokio::test]
async fn worklog_visible_to_self_and_leads_only() {
    let mb = mailbox().await;
    let d: Vec<_> = (0..4).map(|_| tempfile::tempdir().unwrap()).collect();
    let admin = create(d[0].path(), store(), &mb.code).await;
    let alice = invite_and_join(&admin, d[1].path(), store(), "alice").await;
    let bob = invite_and_join(&admin, d[2].path(), store(), "bob").await;
    let carol = invite_and_join(&admin, d[3].path(), store(), "carol").await;
    let all = [&admin, &alice, &bob, &carol];
    sync_all(&all).await;
    let (a, b, c) = (alice.member_id(), bob.member_id(), carol.member_id());
    let core = admin
        .create_team("核心", vec![a, b, c], vec![a])
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(5), || async {
            sync_all(&all).await;
            [&alice, &bob, &carol]
                .iter()
                .all(|n| n.team_key_epoch(&core) == Some(1))
        })
        .await
    );

    // bob 寫一天的紀錄 → 負責人 alice 讀得到；同組成員 carol、管理者讀不到
    bob.set_worklog_day("2026-11-09", day(90)).await.unwrap();
    let months = vec!["2026-11".to_owned()];
    assert!(
        eventually(Duration::from_secs(8), || async {
            sync_all(&all).await;
            alice
                .worklog_days(&b, &months)
                .is_ok_and(|v| v.first().is_some_and(|x| x.entries[0].minutes == 90))
        })
        .await,
        "負責人應取得工作紀錄金鑰並讀到內容"
    );
    // carol 只是同組成員；admin 建立組織時是預設小組的負責人，所以也是 bob 的負責人
    assert!(carol.worklog_days(&b, &months).is_err());
    assert_eq!(carol.worklog_key_epoch(&b), None);
    assert_eq!(bob.worklog_days(&b, &months).unwrap().len(), 1);

    // 負責人改為 carol：bob 輪替；carol 取得新金鑰並讀到之後的紀錄
    alice
        .set_team_members(&core, vec![a, b, c], vec![c])
        .await
        .unwrap();
    assert!(
        eventually(Duration::from_secs(8), || async {
            sync_all(&all).await;
            bob.worklog_key_epoch(&b) == Some(2) && carol.worklog_key_epoch(&b) == Some(2)
        })
        .await,
        "卸任後應輪替工作紀錄金鑰"
    );
    bob.set_worklog_day("2026-11-10", day(30)).await.unwrap();
    assert!(
        eventually(Duration::from_secs(8), || async {
            sync_all(&all).await;
            carol.worklog_days(&b, &months).is_ok_and(|v| v.len() == 2)
        })
        .await
    );
    assert!(alice.worklog_days(&b, &months).is_err());
    assert_eq!(alice.worklog_key_epoch(&b), Some(1));
}
