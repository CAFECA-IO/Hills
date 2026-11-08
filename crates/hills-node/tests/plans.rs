#![allow(clippy::unwrap_used, clippy::expect_used)]
//! 五層計劃的可見度與同步（technical-design §4.3、§16.10 v0.15）。

mod common;
use common::*;
use hills_node::plans::{KeyResult, PlanInput, PlanLevel, PlanQuery, Visibility};

fn quarter(vis: Visibility) -> PlanInput {
    PlanInput {
        id: None,
        level: PlanLevel::Quarter,
        period: "2026-Q4".into(),
        title: "M1 上線".into(),
        parent_id: None,
        kr_ref: None,
        done: false,
        progress_override: None,
        key_results: vec![KeyResult {
            id: String::new(),
            title: "功能完成".into(),
            start: 0.0,
            target: 28.0,
            current: 18.0,
            unit: "項".into(),
            manual: true,
        }],
        visibility: vis,
    }
}

fn titles(n: &Node, q: PlanQuery) -> Vec<String> {
    n.plans(q).unwrap().into_iter().map(|i| i.title).collect()
}

#[tokio::test]
async fn plan_visibility_follows_documents() {
    let mb = mailbox().await;
    let d: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let admin = create(d[0].path(), store(), &mb.code).await;
    let alice = invite_and_join(&admin, d[1].path(), store(), "alice").await;
    let bob = invite_and_join(&admin, d[2].path(), store(), "bob").await;
    let team = alice.org().teams_of(&alice.member_id())[0].clone();

    // 小組可見：同小組的 bob 看得到
    let id = alice
        .save_plan(quarter(Visibility::Team(team.clone())))
        .await
        .unwrap();
    let mut private = quarter(Visibility::Private);
    private.title = "私人目標".into();
    alice.save_plan(private).await.unwrap();
    assert_eq!(titles(&alice, PlanQuery::Mine).len(), 2);
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = bob.sync_now().await;
            titles(&bob, PlanQuery::Visible) == ["M1 上線"]
        })
        .await,
        "bob 應只看到小組可見的目標"
    );
    assert!(titles(&bob, PlanQuery::Mine).is_empty());
    let seen = bob.plans(PlanQuery::Visible).unwrap();
    assert_eq!(seen[0].owner, alice.member_id());
    assert_eq!(seen[0].key_results[0].current, 18.0);

    // 改為私人：搬移文件後 bob 看不到；alice 只有一份
    let mut moved = quarter(Visibility::Private);
    moved.id = Some(id.clone());
    alice.save_plan(moved).await.unwrap();
    let mine = alice.plans(PlanQuery::Mine).unwrap();
    assert_eq!(mine.len(), 2);
    assert!(mine.iter().all(|i| i.visibility == Visibility::Private));
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = bob.sync_now().await;
            titles(&bob, PlanQuery::Visible).is_empty()
        })
        .await,
        "改為私人後 bob 不應再看到"
    );

    // 不能存到自己不屬於的小組
    assert!(
        alice
            .save_plan(quarter(Visibility::Team("nope".into())))
            .await
            .is_err()
    );
    // 季目標不能勾完成；刪除
    assert!(alice.set_plan_done(&id, true).await.is_err());
    alice.delete_plan(&id).await.unwrap();
    assert_eq!(titles(&alice, PlanQuery::Mine), ["私人目標"]);
    for n in [admin, alice, bob] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}
