//! 待確認變更與稽核紀錄（technical-design §18.4）。只存在本機記憶體。

use std::collections::VecDeque;

use serde::Serialize;
use serde_json::Value;

/// 同時最多幾筆待確認
pub const MAX_PENDING: usize = 50;
/// 待確認多久後作廢
pub const TTL_MS: i64 = 24 * 3_600_000;
/// 已處理的變更保留幾筆（供 `get_change_status` 查詢）
const KEEP_RESOLVED: usize = 200;
/// 稽核保留幾筆
const KEEP_AUDIT: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "error")]
pub enum ChangeStatus {
    Pending,
    Approved,
    Rejected,
    Expired,
    Failed(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    /// 送出的 Agent（`initialize` 的 `clientInfo.name`）
    pub client: String,
    pub tool: String,
    /// 給確認卡顯示的結構化預覽（文字由前端依 i18n 組成）
    pub preview: Value,
    pub created_at: i64,
    pub status: ChangeStatus,
    #[serde(skip)]
    pub args: Value,
    /// 核准後的結果（例如新任務 id）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Read,
    Pending,
    Approved,
    Rejected,
    Denied,
    Error,
}

/// 稽核：只記時間、Agent、工具與結果，不記參數與內容。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub at: i64,
    pub client: String,
    pub tool: String,
    pub outcome: Outcome,
}

#[derive(Default)]
pub struct Queue {
    items: VecDeque<Change>,
    audit: VecDeque<AuditEntry>,
}

impl Queue {
    fn expire(&mut self, now: i64) {
        for c in &mut self.items {
            if c.status == ChangeStatus::Pending && now - c.created_at > TTL_MS {
                c.status = ChangeStatus::Expired;
            }
        }
        // 只修剪已處理的舊項目
        while self.items.len() > MAX_PENDING + KEEP_RESOLVED {
            let Some(i) = self
                .items
                .iter()
                .position(|c| c.status != ChangeStatus::Pending)
            else {
                break;
            };
            self.items.remove(i);
        }
    }

    pub fn add(
        &mut self,
        id: String,
        client: &str,
        tool: &str,
        args: Value,
        preview: Value,
        now: i64,
    ) -> Result<Change, String> {
        self.expire(now);
        let open = self
            .items
            .iter()
            .filter(|c| c.status == ChangeStatus::Pending)
            .count();
        if open >= MAX_PENDING {
            return Err(format!(
                "too many pending changes ({MAX_PENDING}); ask the user to review them in Hills first"
            ));
        }
        let c = Change {
            id,
            client: client.to_owned(),
            tool: tool.to_owned(),
            preview,
            created_at: now,
            status: ChangeStatus::Pending,
            args,
            result: None,
        };
        self.items.push_back(c.clone());
        Ok(c)
    }

    pub fn get(&mut self, id: &str, now: i64) -> Option<Change> {
        self.expire(now);
        self.items.iter().find(|c| c.id == id).cloned()
    }

    pub fn pending(&mut self, now: i64) -> Vec<Change> {
        self.expire(now);
        self.items
            .iter()
            .filter(|c| c.status == ChangeStatus::Pending)
            .cloned()
            .collect()
    }

    /// 取出要核准的變更（必須仍是待確認），並先標示為已核准以免重複執行。
    pub fn begin_approve(&mut self, id: &str, now: i64) -> Result<Change, String> {
        self.expire(now);
        let c = self
            .items
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| "找不到這個變更".to_owned())?;
        if c.status != ChangeStatus::Pending {
            return Err("這個變更已處理或已過期".to_owned());
        }
        c.status = ChangeStatus::Approved;
        Ok(c.clone())
    }

    pub fn finish(&mut self, id: &str, result: Result<Value, String>) {
        if let Some(c) = self.items.iter_mut().find(|c| c.id == id) {
            match result {
                Ok(v) => c.result = Some(v),
                Err(e) => c.status = ChangeStatus::Failed(e),
            }
        }
    }

    pub fn reject(&mut self, id: &str, now: i64) -> Result<Change, String> {
        self.expire(now);
        let c = self
            .items
            .iter_mut()
            .find(|c| c.id == id && c.status == ChangeStatus::Pending)
            .ok_or_else(|| "這個變更已處理或已過期".to_owned())?;
        c.status = ChangeStatus::Rejected;
        Ok(c.clone())
    }

    pub fn log(&mut self, at: i64, client: &str, tool: &str, outcome: Outcome) {
        self.audit.push_front(AuditEntry {
            at,
            client: client.to_owned(),
            tool: tool.to_owned(),
            outcome,
        });
        self.audit.truncate(KEEP_AUDIT);
    }

    pub fn audit(&self, limit: usize) -> Vec<AuditEntry> {
        self.audit.iter().take(limit).cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn add(q: &mut Queue, id: &str, now: i64) -> Result<Change, String> {
        q.add(
            id.into(),
            "Claude",
            "propose_task",
            json!({}),
            json!({}),
            now,
        )
    }

    #[test]
    fn approve_once_then_finish() {
        let mut q = Queue::default();
        add(&mut q, "a", 0).unwrap();
        assert_eq!(q.pending(1).len(), 1);
        q.begin_approve("a", 1).unwrap();
        assert!(q.begin_approve("a", 2).is_err());
        q.finish("a", Ok(json!("t1")));
        let c = q.get("a", 3).unwrap();
        assert_eq!(c.status, ChangeStatus::Approved);
        assert_eq!(c.result, Some(json!("t1")));
        assert!(q.pending(3).is_empty());
    }

    #[test]
    fn failed_reject_expire_and_cap() {
        let mut q = Queue::default();
        add(&mut q, "a", 0).unwrap();
        q.begin_approve("a", 0).unwrap();
        q.finish("a", Err("boom".into()));
        assert_eq!(
            q.get("a", 0).unwrap().status,
            ChangeStatus::Failed("boom".into())
        );

        add(&mut q, "b", 0).unwrap();
        q.reject("b", 1).unwrap();
        assert!(q.begin_approve("b", 1).is_err());

        add(&mut q, "c", 0).unwrap();
        assert_eq!(
            q.get("c", TTL_MS + 1).unwrap().status,
            ChangeStatus::Expired
        );
        assert!(q.begin_approve("c", TTL_MS + 1).is_err());

        for i in 0..MAX_PENDING {
            add(&mut q, &format!("p{i}"), TTL_MS + 2).unwrap();
        }
        assert!(add(&mut q, "over", TTL_MS + 2).is_err());
    }

    #[test]
    fn audit_keeps_latest_first() {
        let mut q = Queue::default();
        q.log(1, "Claude", "list_goals", Outcome::Read);
        q.log(2, "Claude", "propose_task", Outcome::Pending);
        let a = q.audit(10);
        assert_eq!(a[0].tool, "propose_task");
        assert_eq!(a.len(), 2);
    }
}
