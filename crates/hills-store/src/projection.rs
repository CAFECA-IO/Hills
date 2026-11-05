//! 記憶體中的 SQLite 投影（technical-design §9）。
//!
//! 投影從 Automerge 文件導出可查詢的表；文件變更時呼叫 [`ProjectionDb::on_doc_changed`]，
//! app 啟動時呼叫 [`ProjectionDb::rebuild`]。投影永遠可以由文件重建，所以不寫入磁碟。

use automerge::AutoCommit;
use rusqlite::{Connection, Transaction};

use crate::{DocStore, StoreError};

pub trait Projection: Send {
    /// 建立資料表（重建時會先刪除再呼叫）。
    fn create(&self, tx: &Transaction<'_>) -> rusqlite::Result<()>;
    fn drop_tables(&self, tx: &Transaction<'_>) -> rusqlite::Result<()>;
    /// 此投影是否處理這份文件。
    fn handles(&self, doc_id: &str) -> bool;
    /// 以文件目前內容更新此文件對應的列（先刪除該文件的舊列再寫入）。
    fn update(&self, tx: &Transaction<'_>, doc_id: &str, doc: &AutoCommit) -> rusqlite::Result<()>;
}

pub struct ProjectionDb {
    conn: Connection,
    projections: Vec<Box<dyn Projection>>,
}

impl ProjectionDb {
    pub fn in_memory(projections: Vec<Box<dyn Projection>>) -> Result<Self, StoreError> {
        let mut conn = Connection::open_in_memory()?;
        {
            let tx = conn.transaction()?;
            for p in &projections {
                p.create(&tx)?;
            }
            tx.commit()?;
        }
        Ok(Self { conn, projections })
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn on_doc_changed(&mut self, doc_id: &str, doc: &AutoCommit) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        for p in self.projections.iter().filter(|p| p.handles(doc_id)) {
            p.update(&tx, doc_id, doc)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 清空所有投影，從文件庫全部重建。
    pub fn rebuild(&mut self, store: &DocStore) -> Result<usize, StoreError> {
        let ids = store.doc_ids()?;
        let tx = self.conn.transaction()?;
        for p in &self.projections {
            p.drop_tables(&tx)?;
            p.create(&tx)?;
        }
        let mut n = 0;
        for id in &ids {
            let handlers: Vec<_> = self.projections.iter().filter(|p| p.handles(id)).collect();
            if handlers.is_empty() {
                continue;
            }
            if let Some(doc) = store.load(id)? {
                for p in handlers {
                    p.update(&tx, id, &doc)?;
                }
                n += 1;
            }
        }
        tx.commit()?;
        Ok(n)
    }
}

/// 示範投影：計劃項目（`member/<id>/plans/*` 的 `items` 清單）。M1 各功能依此模式新增投影。
pub mod plans {
    use automerge::{AutoCommit, ObjType, ROOT, ReadDoc, ScalarValue, Value};
    use rusqlite::{Transaction, params};

    pub struct PlanItems;

    fn text(doc: &AutoCommit, obj: &automerge::ObjId, key: &str) -> Option<String> {
        match doc.get(obj, key).ok()??.0 {
            Value::Scalar(s) => match s.as_ref() {
                ScalarValue::Str(t) => Some(t.to_string()),
                _ => None,
            },
            _ => None,
        }
    }

    fn boolean(doc: &AutoCommit, obj: &automerge::ObjId, key: &str) -> bool {
        matches!(doc.get(obj, key).ok().flatten().map(|v| v.0), Some(Value::Scalar(s)) if matches!(s.as_ref(), ScalarValue::Boolean(true)))
    }

    impl super::Projection for PlanItems {
        fn create(&self, tx: &Transaction<'_>) -> rusqlite::Result<()> {
            tx.execute_batch(
                "CREATE TABLE plan_items (
                    doc_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    level TEXT,
                    period TEXT,
                    parent_id TEXT,
                    title TEXT,
                    done INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (doc_id, id)
                );
                CREATE INDEX plan_items_parent ON plan_items(parent_id);",
            )
        }

        fn drop_tables(&self, tx: &Transaction<'_>) -> rusqlite::Result<()> {
            tx.execute_batch("DROP TABLE IF EXISTS plan_items;")
        }

        fn handles(&self, doc_id: &str) -> bool {
            doc_id.starts_with("member/") && doc_id.contains("/plans/")
        }

        fn update(
            &self,
            tx: &Transaction<'_>,
            doc_id: &str,
            doc: &AutoCommit,
        ) -> rusqlite::Result<()> {
            tx.execute("DELETE FROM plan_items WHERE doc_id = ?1", params![doc_id])?;
            let Ok(Some((Value::Object(ObjType::List), items))) = doc.get(ROOT, "items") else {
                return Ok(());
            };
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO plan_items (doc_id, id, level, period, parent_id, title, done)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for i in 0..doc.length(&items) {
                let Ok(Some((Value::Object(ObjType::Map), it))) = doc.get(&items, i) else {
                    continue;
                };
                let Some(id) = text(doc, &it, "id") else {
                    continue;
                };
                stmt.execute(params![
                    doc_id,
                    id,
                    text(doc, &it, "level"),
                    text(doc, &it, "period"),
                    text(doc, &it, "parentId"),
                    text(doc, &it, "title"),
                    boolean(doc, &it, "done") as i64,
                ])?;
            }
            Ok(())
        }
    }
}
