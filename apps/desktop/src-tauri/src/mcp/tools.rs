//! MCP 工具清單（technical-design §18.3）。說明以英文撰寫，給外部 Agent 閱讀。

use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 直接回傳資料
    Read,
    /// 只建立待確認變更（D17）
    Write,
    /// 查詢待確認變更的狀態
    Status,
}

pub struct ToolDef {
    pub name: &'static str,
    pub kind: Kind,
    pub description: &'static str,
    pub schema: Value,
}

fn obj(props: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}

const PERIODS: &str = "Period codes use the organization time zone: year `2026`, quarter `2026-Q4`, month `2026-11`, ISO week `2026-W46`, day `2026-11-09`.";

pub fn all() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "whoami",
            kind: Kind::Read,
            description: "Who the Hills user is: member id, name, admin flag, organization name, the user's teams, organization time zone and current time. Call this first.",
            schema: obj(json!({}), &[]),
        },
        ToolDef {
            name: "list_members",
            kind: Kind::Read,
            description: "Organization members with teams, presence (Online / Busy / Meeting / Focus / Away / Leave / Offline / Lunch) and `until` (return time or leave end, ms).",
            schema: obj(json!({}), &[]),
        },
        ToolDef {
            name: "list_goals",
            kind: Kind::Read,
            description: "Goals (year / quarter = OKR, month / week = to-do) with progress 0-100, parentId, alignedGoalId (team goal or company direction) and criteria. Tasks hang under week goals via the task's planItemId.",
            schema: obj(
                json!({
                    "level": { "type": "string", "enum": ["year", "quarter", "month", "week"] },
                    "period": { "type": "string", "description": PERIODS },
                    "mine_only": { "type": "boolean", "description": "Only the user's own goals (default true)." }
                }),
                &[],
            ),
        },
        ToolDef {
            name: "get_directions",
            kind: Kind::Read,
            description: "Company directions (set by admins), team goals (set by team leads, each aligned to a direction) with progress, and each team lead's note for the week.",
            schema: obj(json!({}), &[]),
        },
        ToolDef {
            name: "get_direction_summaries",
            kind: Kind::Read,
            description: "Each member's weekly direction summary (units done, alignedUnits, quarterProgress, quarter goals, lastActivity, openTasks) for recent weeks, plus drift rules. A member may be drifting when alignedUnits/units < minAlignedShare%, quarterProgress is more than behindPoints below the elapsed share of the quarter, there was no activity for staleDays, or no quarter goal is aligned.",
            schema: obj(json!({}), &[]),
        },
        ToolDef {
            name: "list_tasks",
            kind: Kind::Read,
            description: "Tasks the user can see, with steps. status: todo / doing / review / done. dueAt is ms.",
            schema: obj(
                json!({
                    "assignee": { "type": "string", "description": "Member id; use `me` for the user." },
                    "status": { "type": "string", "enum": ["todo", "doing", "review", "done", "open"], "description": "`open` = not done." },
                    "team": { "type": "string" },
                    "due_before": { "type": "integer", "description": "Only tasks due before this time (ms)." }
                }),
                &[],
            ),
        },
        ToolDef {
            name: "get_scrum",
            kind: Kind::Read,
            description: "The user's daily scrum for a day (submitted report and draft) and the scrum reports of the user's teams for that day.",
            schema: obj(
                json!({ "date": { "type": "string", "description": "YYYY-MM-DD" } }),
                &["date"],
            ),
        },
        ToolDef {
            name: "get_report",
            kind: Kind::Read,
            description: "The user's daily or weekly report for a period and the published reports of the user's teams.",
            schema: obj(
                json!({
                    "kind": { "type": "string", "enum": ["daily", "weekly"] },
                    "period": { "type": "string", "description": "Day `2026-11-09` for daily, ISO week `2026-W46` for weekly." }
                }),
                &["kind", "period"],
            ),
        },
        ToolDef {
            name: "list_conversations",
            kind: Kind::Read,
            description: "The user's conversations (direct and group) with the last message and unread count.",
            schema: obj(json!({}), &[]),
        },
        ToolDef {
            name: "read_messages",
            kind: Kind::Read,
            description: "Recent messages of a conversation, newest last.",
            schema: obj(
                json!({
                    "conv": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                }),
                &["conv"],
            ),
        },
        ToolDef {
            name: "search_knowledge",
            kind: Kind::Read,
            description: "Search the organization knowledge base by keyword in titles, bodies and tags.",
            schema: obj(
                json!({
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                }),
                &["query"],
            ),
        },
        ToolDef {
            name: "propose_goal",
            kind: Kind::Write,
            description: "Propose creating or updating a goal. Nothing is written until the user approves it in Hills; returns a pending change id. With `id` it updates that goal.",
            schema: obj(
                json!({
                    "id": { "type": "string" },
                    "level": { "type": "string", "enum": ["year", "quarter", "month", "week"] },
                    "period": { "type": "string", "description": PERIODS },
                    "title": { "type": "string" },
                    "parentId": { "type": "string" },
                    "alignedGoalId": { "type": "string", "description": "Year / quarter only: team goal or company direction id." },
                    "criteria": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "text": { "type": "string" } }, "required": ["text"] } },
                    "visibility": { "type": "object", "description": "{\"kind\":\"org\"} (default), {\"kind\":\"team\",\"team\":id} or {\"kind\":\"private\"}." }
                }),
                &["level", "period", "title"],
            ),
        },
        ToolDef {
            name: "propose_task",
            kind: Kind::Write,
            description: "Propose creating a task (or updating one with `task`). Nothing is written until the user approves it in Hills. When updating, send the whole task (title, assignee, status, dueAt, steps, planItemId).",
            schema: obj(
                json!({
                    "team": { "type": "string", "description": "Team id; `private` for a private task of the user." },
                    "task": { "type": "string", "description": "Existing task id to update." },
                    "title": { "type": "string" },
                    "assignee": { "type": "string", "description": "Member id." },
                    "status": { "type": "string", "enum": ["todo", "doing", "review", "done"] },
                    "dueAt": { "type": "integer", "description": "ms" },
                    "planItemId": { "type": "string", "description": "Week goal id." },
                    "steps": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "title": { "type": "string" }, "assignee": { "type": "string" }, "done": { "type": "boolean" } }, "required": ["title"] } }
                }),
                &["team", "title"],
            ),
        },
        ToolDef {
            name: "propose_step_done",
            kind: Kind::Write,
            description: "Propose marking a task step done or not done. Needs the user's approval in Hills.",
            schema: obj(
                json!({
                    "team": { "type": "string" },
                    "task": { "type": "string" },
                    "step": { "type": "string" },
                    "done": { "type": "boolean" }
                }),
                &["team", "task", "step", "done"],
            ),
        },
        ToolDef {
            name: "propose_scrum_draft",
            kind: Kind::Write,
            description: "Propose replacing the user's daily scrum draft for a day (Markdown). The user still submits the scrum themselves. Needs approval in Hills.",
            schema: obj(
                json!({
                    "date": { "type": "string", "description": "YYYY-MM-DD" },
                    "draft": { "type": "string" }
                }),
                &["date", "draft"],
            ),
        },
        ToolDef {
            name: "propose_message",
            kind: Kind::Write,
            description: "Propose sending a message to a conversation as the user. Sent only after the user approves it in Hills.",
            schema: obj(
                json!({
                    "conv": { "type": "string" },
                    "text": { "type": "string", "maxLength": 4000 }
                }),
                &["conv", "text"],
            ),
        },
        ToolDef {
            name: "propose_kb_item",
            kind: Kind::Write,
            description: "Propose adding (or with `key`, updating) a knowledge base item under a topic. Needs approval in Hills.",
            schema: obj(
                json!({
                    "key": { "type": "string" },
                    "title": { "type": "string" },
                    "body": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "topicId": { "type": "string" }
                }),
                &["title", "body", "topicId"],
            ),
        },
        ToolDef {
            name: "propose_delete_goal",
            kind: Kind::Write,
            description: "Propose deleting one of the user's own goals (use list_goals to find the id). Deleted only after the user approves it in Hills. Tasks linked to it are kept but lose the link.",
            schema: obj(json!({ "id": { "type": "string" } }), &["id"]),
        },
        ToolDef {
            name: "propose_delete_task",
            kind: Kind::Write,
            description: "Propose deleting a task (use list_tasks to find team and id). Deleted only after the user approves it in Hills.",
            schema: obj(
                json!({ "team": { "type": "string" }, "task": { "type": "string" } }),
                &["team", "task"],
            ),
        },
        ToolDef {
            name: "propose_delete_kb_item",
            kind: Kind::Write,
            description: "Propose deleting a knowledge base item by its key (from search_knowledge). Deleted only after the user approves it in Hills.",
            schema: obj(json!({ "key": { "type": "string" } }), &["key"]),
        },
        ToolDef {
            name: "get_change_status",
            kind: Kind::Status,
            description: "Status of a proposed change: pending, approved (with result), rejected, expired (after 24 hours) or failed (with error).",
            schema: obj(json!({ "id": { "type": "string" } }), &["id"]),
        },
    ]
}

pub fn find(name: &str) -> Option<ToolDef> {
    all().into_iter().find(|t| t.name == name)
}

/// `tools/list` 的回應內容。
pub fn list_json() -> Value {
    let tools: Vec<Value> = all()
        .into_iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.schema,
                "annotations": {
                    "readOnlyHint": t.kind != Kind::Write,
                    "destructiveHint": t.name.starts_with("propose_delete_"),
                    "openWorldHint": false
                }
            })
        })
        .collect();
    json!({ "tools": tools })
}
