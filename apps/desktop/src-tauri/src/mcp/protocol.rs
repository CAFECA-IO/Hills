//! MCP 的 JSON-RPC 子集（technical-design §18.1）：initialize、ping、tools/list、tools/call。

use std::future::Future;
use std::sync::Mutex;

use serde_json::{Value, json};

use super::pending::{Change, Outcome, Queue};
use super::tools::{self, Kind};

pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// MCP 工具背後的實作：正式版包住 Node（backend.rs），測試用假的。
pub trait McpBackend: Send + Sync + 'static {
    /// 組織是否允許（每個請求都檢查，管理者關閉後立即拒絕）
    fn allowed(&self) -> impl Future<Output = bool> + Send;
    /// 讀取工具
    fn read(&self, tool: &str, args: Value) -> impl Future<Output = Result<Value, String>> + Send;
    /// 驗證寫入參數並產生（1）補齊後要執行的參數與（2）確認卡預覽
    fn prepare(
        &self,
        tool: &str,
        args: Value,
    ) -> impl Future<Output = Result<(Value, Value), String>> + Send;
    /// 使用者核准後執行
    fn apply(&self, tool: &str, args: Value) -> impl Future<Output = Result<Value, String>> + Send;
    /// 新增待確認變更時通知前端
    fn notify(&self);
    fn now_ms(&self) -> i64;
    fn new_id(&self) -> String;
}

pub struct Server<B> {
    pub backend: B,
    pub queue: Mutex<Queue>,
    client: Mutex<String>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn err(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_text(v: &Value, is_error: bool) -> Value {
    let text = match v {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

impl<B: McpBackend> Server<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            queue: Mutex::new(Queue::default()),
            client: Mutex::new("AI agent".to_owned()),
        }
    }

    pub fn client(&self) -> String {
        lock(&self.client).clone()
    }

    /// 處理一個 JSON-RPC 訊息；通知（沒有 id）回 None。
    pub async fn handle(&self, msg: Value) -> Option<Value> {
        let id = msg.get("id").cloned();
        let method = msg
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let Some(id) = id else {
            // notifications/initialized 等通知不需回應
            return None;
        };
        if msg.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Some(err(id, -32600, "invalid request"));
        }
        Some(match method {
            "initialize" => {
                if let Some(name) = params
                    .pointer("/clientInfo/name")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                {
                    *lock(&self.client) = name.chars().take(60).collect();
                }
                ok(
                    id,
                    json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": { "name": "hills", "title": "Hills", "version": env!("CARGO_PKG_VERSION") },
                        "instructions": "Hills is the user's team workspace (goals, tasks, scrum, reports, chat, knowledge base). Read tools return data the user can already see. Every write is only a proposal: it becomes a pending change that the user must approve inside Hills, so tell the user to check Hills and use get_change_status to follow up."
                    }),
                )
            }
            "ping" => ok(id, json!({})),
            "tools/list" => ok(id, tools::list_json()),
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match tools::find(name) {
                    None => err(id, -32602, "unknown tool"),
                    Some(t) => ok(id, self.call(t.name, t.kind, args).await),
                }
            }
            _ => err(id, -32601, "method not found"),
        })
    }

    async fn call(&self, name: &str, kind: Kind, args: Value) -> Value {
        let client = self.client();
        let now = self.backend.now_ms();
        if !self.backend.allowed().await {
            lock(&self.queue).log(now, &client, name, Outcome::Denied);
            return tool_text(
                &json!("The organization admin has not allowed AI agents (MCP) in Hills."),
                true,
            );
        }
        match kind {
            Kind::Read => match self.backend.read(name, args).await {
                Ok(v) => {
                    lock(&self.queue).log(now, &client, name, Outcome::Read);
                    tool_text(&v, false)
                }
                Err(e) => {
                    lock(&self.queue).log(now, &client, name, Outcome::Error);
                    tool_text(&json!(e), true)
                }
            },
            Kind::Status => {
                let id = args.get("id").and_then(Value::as_str).unwrap_or_default();
                let found = lock(&self.queue).get(id, now);
                match found {
                    Some(c) => tool_text(&status_json(&c), false),
                    None => tool_text(&json!("No change with this id."), true),
                }
            }
            Kind::Write => {
                let prepared = self.backend.prepare(name, args).await;
                let (args, preview) = match prepared {
                    Ok(p) => p,
                    Err(e) => {
                        lock(&self.queue).log(now, &client, name, Outcome::Error);
                        return tool_text(&json!(e), true);
                    }
                };
                let id = self.backend.new_id();
                let added = {
                    let mut q = lock(&self.queue);
                    let r = q.add(id, &client, name, args, preview, now);
                    let outcome = if r.is_ok() {
                        Outcome::Pending
                    } else {
                        Outcome::Error
                    };
                    q.log(now, &client, name, outcome);
                    r
                };
                match added {
                    Ok(c) => {
                        self.backend.notify();
                        tool_text(
                            &json!({
                                "status": "pending",
                                "id": c.id,
                                "preview": c.preview,
                                "note": "Waiting for the user to approve this in Hills. Nothing has been changed yet."
                            }),
                            false,
                        )
                    }
                    Err(e) => tool_text(&json!(e), true),
                }
            }
        }
    }

    /// 使用者在 Hills 核准：執行並記錄結果。
    pub async fn approve(&self, id: &str) -> Result<Value, String> {
        let now = self.backend.now_ms();
        let c = lock(&self.queue).begin_approve(id, now)?;
        let r = self.backend.apply(&c.tool, c.args.clone()).await;
        let mut q = lock(&self.queue);
        q.finish(id, r.clone());
        q.log(
            now,
            &c.client,
            &c.tool,
            if r.is_ok() {
                Outcome::Approved
            } else {
                Outcome::Error
            },
        );
        r
    }

    pub fn reject(&self, id: &str) -> Result<(), String> {
        let now = self.backend.now_ms();
        let mut q = lock(&self.queue);
        let c = q.reject(id, now)?;
        q.log(now, &c.client, &c.tool, Outcome::Rejected);
        Ok(())
    }

    pub fn pending(&self) -> Vec<Change> {
        let now = self.backend.now_ms();
        lock(&self.queue).pending(now)
    }
}

fn status_json(c: &Change) -> Value {
    let mut v = serde_json::to_value(&c.status).unwrap_or(Value::Null);
    if let (Some(o), Some(r)) = (v.as_object_mut(), &c.result) {
        o.insert("result".into(), r.clone());
    }
    v
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Default)]
    pub struct Fake {
        pub denied: AtomicBool,
        pub applied: AtomicUsize,
        pub notified: AtomicUsize,
        pub ids: AtomicUsize,
    }

    impl McpBackend for Fake {
        async fn allowed(&self) -> bool {
            !self.denied.load(Ordering::SeqCst)
        }
        async fn read(&self, tool: &str, _args: Value) -> Result<Value, String> {
            Ok(json!({ "tool": tool }))
        }
        async fn prepare(&self, tool: &str, args: Value) -> Result<(Value, Value), String> {
            if args.get("title").is_none() && tool == "propose_task" {
                return Err("title is required".into());
            }
            Ok((
                args.clone(),
                json!({ "action": tool, "title": args.get("title") }),
            ))
        }
        async fn apply(&self, _tool: &str, _args: Value) -> Result<Value, String> {
            self.applied.fetch_add(1, Ordering::SeqCst);
            Ok(json!("t1"))
        }
        fn notify(&self) {
            self.notified.fetch_add(1, Ordering::SeqCst);
        }
        fn now_ms(&self) -> i64 {
            1_000
        }
        fn new_id(&self) -> String {
            format!("c{}", self.ids.fetch_add(1, Ordering::SeqCst))
        }
    }

    fn call(name: &str, args: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } })
    }

    fn text(v: &Value) -> String {
        v.pointer("/result/content/0/text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    }

    #[tokio::test]
    async fn initialize_and_list() {
        let s = Server::new(Fake::default());
        let r = s
            .handle(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": PROTOCOL_VERSION, "clientInfo": { "name": "Claude Code" } } }))
            .await
            .unwrap();
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(s.client(), "Claude Code");
        assert!(
            s.handle(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
                .await
                .is_none()
        );
        let r = s
            .handle(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
            .await
            .unwrap();
        let names: Vec<&str> = r["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"list_goals") && names.contains(&"propose_task"));
        assert!(names.contains(&"propose_delete_goal") && names.contains(&"propose_delete_task"));
        // D51：小組、方向、任務狀態與接下、知識庫結構
        for n in [
            "list_teams",
            "list_knowledge_tree",
            "propose_team_goal",
            "propose_delete_team_goal",
            "propose_week_note",
            "propose_direction",
            "propose_delete_direction",
            "propose_task_status",
            "propose_task_ack",
            "propose_team",
            "propose_archive_team",
            "propose_kb_category",
            "propose_kb_topic",
            "propose_kb_rename",
        ] {
            assert!(names.contains(&n), "missing {n}");
        }
        let hint = |n: &str| {
            r["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == n)
                .unwrap()["annotations"]["destructiveHint"]
                .clone()
        };
        assert_eq!(hint("propose_archive_team"), true);
        assert_eq!(hint("propose_delete_direction"), true);
        assert_eq!(hint("propose_team"), false);
        // 刪除類工具也是寫入：readOnlyHint 為 false
        let del = r["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "propose_delete_task")
            .unwrap();
        assert_eq!(del["annotations"]["readOnlyHint"], false);
        let r = s
            .handle(json!({ "jsonrpc": "2.0", "id": 3, "method": "nope" }))
            .await
            .unwrap();
        assert_eq!(r["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn writes_wait_for_approval() {
        let s = Server::new(Fake::default());
        let r = s
            .handle(call("propose_task", json!({ "team": "g", "title": "x" })))
            .await
            .unwrap();
        let body: Value = serde_json::from_str(&text(&r)).unwrap();
        assert_eq!(body["status"], "pending");
        assert_eq!(s.backend.applied.load(Ordering::SeqCst), 0);
        assert_eq!(s.backend.notified.load(Ordering::SeqCst), 1);
        let id = body["id"].as_str().unwrap().to_owned();
        assert_eq!(s.pending().len(), 1);

        let st = s
            .handle(call("get_change_status", json!({ "id": id })))
            .await
            .unwrap();
        assert!(text(&st).contains("pending"));

        assert_eq!(s.approve(&id).await.unwrap(), json!("t1"));
        assert_eq!(s.backend.applied.load(Ordering::SeqCst), 1);
        assert!(s.approve(&id).await.is_err());
        let st = s
            .handle(call("get_change_status", json!({ "id": id })))
            .await
            .unwrap();
        assert!(text(&st).contains("approved") && text(&st).contains("t1"));

        // 拒絕的不會執行
        let r = s
            .handle(call("propose_task", json!({ "team": "g", "title": "y" })))
            .await
            .unwrap();
        let id2 = serde_json::from_str::<Value>(&text(&r)).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        s.reject(&id2).unwrap();
        assert!(s.approve(&id2).await.is_err());
        assert_eq!(s.backend.applied.load(Ordering::SeqCst), 1);

        // 參數錯誤 → isError，不建立變更
        let r = s
            .handle(call("propose_task", json!({ "team": "g" })))
            .await
            .unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(s.pending().is_empty());
    }

    #[tokio::test]
    async fn denied_when_org_disallows() {
        let s = Server::new(Fake::default());
        s.backend.denied.store(true, Ordering::SeqCst);
        let r = s.handle(call("list_goals", json!({}))).await.unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(text(&r).contains("not allowed"));
        let audit = s.queue.lock().unwrap().audit(5);
        assert_eq!(audit[0].outcome, Outcome::Denied);
    }
}
