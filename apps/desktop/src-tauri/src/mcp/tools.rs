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
            name: "list_teams",
            kind: Kind::Read,
            description: "Teams with members, leads (member ids), archived and canManage (the user can change this team's members and leads).",
            schema: obj(json!({}), &[]),
        },
        ToolDef {
            name: "list_knowledge_tree",
            kind: Kind::Read,
            description: "Knowledge base categories and topics (no item bodies). `resolved` is the id an entry was merged into (itself if not merged). Use it to pick a topicId for propose_kb_item.",
            schema: obj(json!({}), &[]),
        },
        ToolDef {
            name: "get_knowledge",
            kind: Kind::Read,
            description: "One knowledge item split into its hills-doc/1 sections ({key, title, text} as plain text). Pass `sections` (e.g. [\"summary\"]) to get only those; `lead` is the text before the first section.",
            schema: obj(
                json!({
                    "key": { "type": "string" },
                    "sections": { "type": "array", "items": { "type": "string" } }
                }),
                &["key"],
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
            description: "Propose adding (or with `key`, updating) a knowledge base item under a topic. Find the topic with list_knowledge_tree; if none fits, propose_kb_topic first. The body must follow the hills-doc/1 spec: required sections summary and content, optional points and sources, plus any custom sections. Markdown: `## 摘要 {#summary}` headings (custom: no key or `{#x-...}`). HTML: `<article data-hills-doc=\"1\"><section data-section=\"summary\"><h2>摘要</h2>...</section>...</article>`; no scripts, event attributes or external resources (inline styles and one <style> block are fine). Needs approval in Hills.",
            schema: obj(
                json!({
                    "key": { "type": "string" },
                    "title": { "type": "string" },
                    "format": { "type": "string", "enum": ["markdown", "html"], "description": "Default markdown." },
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
            name: "propose_team_goal",
            kind: Kind::Write,
            description: "Propose creating (or with `id`, updating) a team goal for a year. Only that team's leads (or admins) can. Fields left out keep their values when updating. Needs approval in Hills.",
            schema: obj(
                json!({
                    "id": { "type": "string" },
                    "team": { "type": "string" },
                    "year": { "type": "string", "description": "e.g. `2026`" },
                    "title": { "type": "string" },
                    "directionId": { "type": "string", "description": "Company direction of the same year (get_directions)." },
                    "keyResults": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "title": { "type": "string" }, "start": { "type": "number" }, "target": { "type": "number" }, "current": { "type": "number" }, "unit": { "type": "string" }, "manual": { "type": "boolean" } }, "required": ["title", "target"] } },
                    "criteria": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "text": { "type": "string" } }, "required": ["text"] } }
                }),
                &["team", "year", "title"],
            ),
        },
        ToolDef {
            name: "propose_delete_team_goal",
            kind: Kind::Write,
            description: "Propose deleting a team goal (team leads or admins). Deleted only after the user approves it in Hills.",
            schema: obj(
                json!({ "team": { "type": "string" }, "id": { "type": "string" } }),
                &["team", "id"],
            ),
        },
        ToolDef {
            name: "propose_week_note",
            kind: Kind::Write,
            description: "Propose writing the team lead's note for a week (team leads or admins). Needs approval in Hills.",
            schema: obj(
                json!({
                    "team": { "type": "string" },
                    "week": { "type": "string", "description": "ISO week, e.g. `2026-W46`" },
                    "text": { "type": "string" }
                }),
                &["team", "week", "text"],
            ),
        },
        ToolDef {
            name: "propose_direction",
            kind: Kind::Write,
            description: "Propose creating (or with `id`, updating) a company direction for a year. Admins only. Needs approval in Hills.",
            schema: obj(
                json!({
                    "id": { "type": "string" },
                    "year": { "type": "string" },
                    "title": { "type": "string" },
                    "keyResults": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "title": { "type": "string" }, "start": { "type": "number" }, "target": { "type": "number" }, "current": { "type": "number" }, "unit": { "type": "string" }, "manual": { "type": "boolean" } }, "required": ["title", "target"] } }
                }),
                &["year", "title"],
            ),
        },
        ToolDef {
            name: "propose_delete_direction",
            kind: Kind::Write,
            description: "Propose deleting a company direction. Admins only. Deleted only after the user approves it in Hills.",
            schema: obj(json!({ "id": { "type": "string" } }), &["id"]),
        },
        ToolDef {
            name: "propose_task_status",
            kind: Kind::Write,
            description: "Propose changing only a task's status (e.g. mark it done) without sending the whole task. Needs approval in Hills.",
            schema: obj(
                json!({
                    "team": { "type": "string" },
                    "task": { "type": "string" },
                    "status": { "type": "string", "enum": ["todo", "doing", "review", "done"] }
                }),
                &["team", "task", "status"],
            ),
        },
        ToolDef {
            name: "propose_task_ack",
            kind: Kind::Write,
            description: "Propose the user's answer to a task assigned to them: `accepted`, or `concern` with a short note. Only the current assignee can. It does not message the assigner; use propose_message for that. Needs approval in Hills.",
            schema: obj(
                json!({
                    "team": { "type": "string" },
                    "task": { "type": "string" },
                    "state": { "type": "string", "enum": ["accepted", "concern"] },
                    "note": { "type": "string", "maxLength": 200 }
                }),
                &["team", "task", "state"],
            ),
        },
        ToolDef {
            name: "propose_team",
            kind: Kind::Write,
            description: "Propose creating a team (admins) or, with `id`, changing its name (admins) and members / leads (admins or that team's leads). Send the full member and lead lists; leads must be members. Removing members rotates the team key. Needs approval in Hills.",
            schema: obj(
                json!({
                    "id": { "type": "string" },
                    "name": { "type": "string", "maxLength": 40 },
                    "members": { "type": "array", "items": { "type": "string" } },
                    "leads": { "type": "array", "items": { "type": "string" } }
                }),
                &["name", "members", "leads"],
            ),
        },
        ToolDef {
            name: "propose_archive_team",
            kind: Kind::Write,
            description: "Propose archiving (or with archived=false, restoring) a team. Admins only. Needs approval in Hills.",
            schema: obj(
                json!({ "id": { "type": "string" }, "archived": { "type": "boolean" } }),
                &["id", "archived"],
            ),
        },
        ToolDef {
            name: "propose_kb_category",
            kind: Kind::Write,
            description: "Propose creating a knowledge base category. Needs approval in Hills.",
            schema: obj(json!({ "name": { "type": "string" } }), &["name"]),
        },
        ToolDef {
            name: "propose_kb_topic",
            kind: Kind::Write,
            description: "Propose creating a topic in a knowledge base category (list_knowledge_tree). Needs approval in Hills.",
            schema: obj(
                json!({ "categoryId": { "type": "string" }, "name": { "type": "string" } }),
                &["categoryId", "name"],
            ),
        },
        ToolDef {
            name: "propose_kb_rename",
            kind: Kind::Write,
            description: "Propose renaming a knowledge base category or topic. Needs approval in Hills.",
            schema: obj(
                json!({
                    "kind": { "type": "string", "enum": ["category", "topic"] },
                    "id": { "type": "string" },
                    "name": { "type": "string" }
                }),
                &["kind", "id", "name"],
            ),
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
                    "destructiveHint": t.name.starts_with("propose_delete_") || t.name == "propose_archive_team",
                    "openWorldHint": false
                }
            })
        })
        .collect();
    json!({ "tools": tools })
}
