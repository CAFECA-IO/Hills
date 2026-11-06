use std::fs;

use automerge::{AutoCommit, ObjType, ROOT, ReadDoc, transaction::Transactable};
use hills_crypto::SymmetricKey;

use super::projection::plans::PlanItems;
use super::*;

const MEMBER: &str = "member/aaaaaaaaaaaaaaaaaaaaaaaaaa";

fn plan_doc(titles: &[(&str, &str, bool)]) -> AutoCommit {
    let mut doc = AutoCommit::new();
    let items = doc.put_object(ROOT, "items", ObjType::List).unwrap();
    for (i, (id, title, done)) in titles.iter().enumerate() {
        let it = doc.insert_object(&items, i, ObjType::Map).unwrap();
        doc.put(&it, "id", *id).unwrap();
        doc.put(&it, "level", "week").unwrap();
        doc.put(&it, "title", *title).unwrap();
        doc.put(&it, "done", *done).unwrap();
    }
    doc.commit();
    doc
}

fn store(dir: &std::path::Path) -> (DocStore, SymmetricKey) {
    let key = SymmetricKey::generate().unwrap();
    (DocStore::open(dir, key.clone()).unwrap(), key)
}

#[test]
fn save_load_roundtrip_and_listing() {
    let tmp = tempfile::tempdir().unwrap();
    let (s, _) = store(tmp.path());
    let id = format!("{MEMBER}/plans/team");
    let mut doc = plan_doc(&[("p1", "完成 Hills MVP", false)]);
    s.save(&id, &mut doc).unwrap();
    s.save("org", &mut AutoCommit::new()).unwrap();
    let mut back = s.load(&id).unwrap().unwrap();
    assert_eq!(back.get_heads(), doc.get_heads());
    assert!(s.load("team/none").unwrap().is_none());
    assert_eq!(
        s.doc_ids().unwrap(),
        vec![id.clone(), "org".to_string()]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
    );
    s.delete(&id).unwrap();
    assert!(s.load(&id).unwrap().is_none());
}

#[test]
fn wrong_key_cannot_read() {
    let tmp = tempfile::tempdir().unwrap();
    let (s, _) = store(tmp.path());
    s.save("org", &mut plan_doc(&[("p", "x", false)])).unwrap();
    let other = DocStore::open(tmp.path(), SymmetricKey::generate().unwrap()).unwrap();
    assert!(matches!(other.load("org"), Err(StoreError::Decrypt)));
}

#[test]
fn no_plaintext_or_doc_ids_on_disk() {
    let tmp = tempfile::tempdir().unwrap();
    let (s, _) = store(tmp.path());
    let id = format!("{MEMBER}/plans/private");
    s.save(&id, &mut plan_doc(&[("p1", "SECRET-TITLE-42", false)]))
        .unwrap();
    for entry in fs::read_dir(tmp.path().join("docs")).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            !name.contains("member") && !name.contains("plans"),
            "{name}"
        );
        let bytes = fs::read(&path).unwrap();
        for needle in [&b"SECRET-TITLE-42"[..], b"plans/private", b"member/"] {
            assert!(
                !bytes.windows(needle.len()).any(|w| w == needle),
                "{name} 含明文"
            );
        }
    }
}

#[test]
fn file_moved_to_other_name_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let (s, _) = store(tmp.path());
    s.save("org", &mut plan_doc(&[("p", "x", false)])).unwrap();
    s.save("team/t1", &mut AutoCommit::new()).unwrap();
    let dir = tmp.path().join("docs");
    let org = dir.join(format!("{}.am", file_stem("org")));
    let team = dir.join(format!("{}.am", file_stem("team/t1")));
    fs::copy(&org, &team).unwrap();
    // AAD 是檔名，搬過去後解密失敗
    assert!(matches!(s.load("team/t1"), Err(StoreError::Decrypt)));
}

#[test]
fn interrupted_write_keeps_original() {
    let tmp = tempfile::tempdir().unwrap();
    let (s, _) = store(tmp.path());
    let mut doc = plan_doc(&[("p1", "v1", false)]);
    s.save("org", &mut doc).unwrap();
    // 模擬寫到一半當機：只留下暫存檔
    fs::write(tmp.path().join("docs/.tmp-deadbeef"), b"partial garbage").unwrap();
    let mut back = s.load("org").unwrap().unwrap();
    assert_eq!(back.get_heads(), doc.get_heads());
    assert_eq!(s.doc_ids().unwrap(), vec!["org".to_string()]);
}

#[test]
fn projection_updates_and_rebuilds() {
    let tmp = tempfile::tempdir().unwrap();
    let (s, _) = store(tmp.path());
    let mut db = ProjectionDb::in_memory(vec![Box::new(PlanItems)]).unwrap();
    let a = format!("{MEMBER}/plans/team");
    let b = format!("{MEMBER}/plans/private");
    let mut da = plan_doc(&[("p1", "年度目標", false), ("p2", "週任務", true)]);
    let mut dbd = plan_doc(&[("p3", "私人項目", false)]);
    for (id, d) in [(&a, &mut da), (&b, &mut dbd)] {
        s.save(id, d).unwrap();
        db.on_doc_changed(id, d).unwrap();
    }
    s.save("org", &mut AutoCommit::new()).unwrap();
    let count = |db: &ProjectionDb| -> (i64, i64) {
        db.conn()
            .query_row("SELECT COUNT(*), SUM(done) FROM plan_items", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
    };
    assert_eq!(count(&db), (3, 1));

    // 更新文件：刪掉一個項目
    let (_, items) = da.get(ROOT, "items").unwrap().unwrap();
    da.delete(&items, 0).unwrap();
    da.commit();
    s.save(&a, &mut da).unwrap();
    db.on_doc_changed(&a, &da).unwrap();
    assert_eq!(count(&db), (2, 1));

    // 全新的投影資料庫（模擬 app 重啟）由文件重建，結果相同
    let mut fresh = ProjectionDb::in_memory(vec![Box::new(PlanItems)]).unwrap();
    assert_eq!(fresh.rebuild(&s).unwrap(), 2);
    assert_eq!(count(&fresh), (2, 1));
    let title: String = fresh
        .conn()
        .query_row("SELECT title FROM plan_items WHERE id = 'p3'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(title, "私人項目");
}

#[test]
fn extra_data_and_secret_files() {
    let tmp = tempfile::tempdir().unwrap();
    let (s, _) = store(tmp.path());
    let mut doc = plan_doc(&[("p", "x", false)]);
    s.save_with("org", &mut doc, b"signatures").unwrap();
    let (mut back, extra) = s.load_with("org").unwrap().unwrap();
    assert_eq!(extra, b"signatures");
    assert_eq!(back.get_heads(), doc.get_heads());
    s.write_secret_file("keyring", b"KEYS").unwrap();
    assert_eq!(&**s.read_secret_file("keyring").unwrap().unwrap(), b"KEYS");
    assert!(s.read_secret_file("nothing").unwrap().is_none());
    assert!(s.write_secret_file("../x", b"").is_err());
    // 密文檔不含明文，也不會被當成文件列出
    let raw = fs::read(tmp.path().join("docs/keyring.enc")).unwrap();
    assert!(!raw.windows(4).any(|w| w == b"KEYS"));
    assert_eq!(s.doc_ids().unwrap(), vec!["org".to_string()]);
}
