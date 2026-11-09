#![allow(clippy::unwrap_used, clippy::expect_used)]
//! 知識庫（technical-design §16.11 v0.16）：全組織可讀、只有作者與管理者能改。

mod common;
use common::*;
use hills_node::ConvKind;
use hills_node::kb::{KbInput, KbSource};

fn input(topic: &str, title: &str) -> KbInput {
    KbInput {
        key: None,
        title: title.into(),
        body: "**內容**".into(),
        format: Default::default(),
        spec: None,
        tags: vec!["儲存".into()],
        topic_id: topic.into(),
        refs: vec![],
        source: None,
    }
}

fn titles(n: &Node) -> Vec<String> {
    n.kb().unwrap().items.into_iter().map(|i| i.title).collect()
}

async fn synced(nodes: &[&Node], ok: impl Fn() -> bool) -> bool {
    eventually(Duration::from_secs(10), || async {
        for n in nodes {
            let _ = n.sync_now().await;
        }
        ok()
    })
    .await
}

#[tokio::test]
async fn kb_shared_and_author_only() {
    let mb = mailbox().await;
    let d: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let admin = create(d[0].path(), store(), &mb.code).await;
    let alice = invite_and_join(&admin, d[1].path(), store(), "alice").await;
    let bob = invite_and_join(&admin, d[2].path(), store(), "bob").await;
    for n in [&admin, &alice, &bob] {
        n.sync_now().await.unwrap();
    }

    let cat = alice.kb_create_category("工程").await.unwrap();
    let topic = alice.kb_create_topic(&cat, "儲存").await.unwrap();
    let key = alice.kb_save(input(&topic, "D39 儲存節點")).await.unwrap();
    assert!(
        synced(&[&alice, &bob], || titles(&bob) == ["D39 儲存節點"]).await,
        "bob 應看到知識"
    );

    // bob 可以新增並引用 alice 的知識
    let mut mine = input(&topic, "relay 部署");
    mine.refs = vec![key.clone()];
    let bob_key = bob.kb_save(mine).await.unwrap();
    // 引用不存在的知識被拒
    let mut bad = input(&topic, "x");
    bad.refs = vec!["nope:01".into()];
    assert!(bob.kb_save(bad).await.is_err());

    // bob 不能改或刪 alice 的知識（本機檢查）
    let mut edit = input(&topic, "被 bob 改掉");
    edit.key = Some(key.clone());
    assert!(bob.kb_save(edit).await.is_err());
    assert!(bob.kb_delete(&key).await.is_err());

    // 繞過本機檢查直接寫入：驗證層拒絕，alice 看不到
    let doc = hills_node::kb::doc_of_key(&key).unwrap();
    bob.change(&doc, |d| {
        use automerge::transaction::Transactable;
        d.put(automerge::ROOT, key.as_str(), "{}")?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(
        synced(&[&bob, &alice], || titles(&alice).len() == 2).await,
        "alice 應收到 bob 的新知識"
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = alice.sync_now().await;
    let a = alice.kb().unwrap();
    let item = a.items.iter().find(|i| i.key == key).unwrap();
    assert_eq!(item.title, "D39 儲存節點", "非作者的修改應被拒絕");
    assert_eq!(
        a.items.iter().find(|i| i.key == bob_key).unwrap().refs,
        vec![key.clone()]
    );

    // 管理者可以改
    assert!(synced(&[&admin], || titles(&admin).len() == 2).await);
    let mut fix = input(&topic, "D39 儲存節點（管理者修訂）");
    fix.key = Some(key.clone());
    admin.kb_save(fix).await.unwrap();
    assert!(
        synced(&[&admin, &alice], || titles(&alice)
            .contains(&"D39 儲存節點（管理者修訂）".to_string()))
        .await,
        "管理者的修改應生效"
    );

    // 分類合併：兩人看到同一結果
    let cat2 = bob.kb_create_category("開發").await.unwrap();
    let topic2 = bob.kb_create_topic(&cat2, "部署").await.unwrap();
    bob.kb_merge("category", &cat2, &cat).await.unwrap();
    assert!(
        synced(&[&bob, &alice], || {
            alice
                .kb()
                .unwrap()
                .topics
                .iter()
                .any(|t| t.id == topic2 && t.category_id == cat)
        })
        .await,
        "合併後主題應屬於原分類"
    );

    // 從訊息存成知識：帶入內容與來源
    let conv = alice
        .create_conv(ConvKind::Dm, "", &[bob.member_id()])
        .await
        .unwrap();
    let m = alice
        .send_message(&conv, "部署前先備份 volume", &[], serde_json::Value::Null)
        .await
        .unwrap();
    let mkey = format!("{}:{}", m.author, m.id);
    let k = alice
        .kb_from_message(&conv, &mkey, &topic, "部署前備份", None)
        .await
        .unwrap();
    let item = alice
        .kb()
        .unwrap()
        .items
        .into_iter()
        .find(|i| i.key == k)
        .unwrap();
    assert_eq!(item.body, "部署前先備份 volume");
    assert_eq!(
        item.source,
        KbSource::Message {
            conv_id: conv.clone(),
            message_key: mkey
        }
    );
    // 不是對話成員不能存
    assert!(
        admin
            .kb_from_message(&conv, "x:y", &topic, "t", None)
            .await
            .is_err()
    );
    // 作者可刪
    alice.kb_delete(&k).await.unwrap();
    assert!(!titles(&alice).contains(&"部署前備份".to_string()));
    for n in [admin, alice, bob] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}
