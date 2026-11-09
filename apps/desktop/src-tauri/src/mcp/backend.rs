//! 正式版 MCP backend：直接呼叫既有的 Tauri command 函式（與使用者自己操作走同一組驗證與權限）。

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter, Manager};

use super::protocol::McpBackend;
use crate::commands::{self, AppState};

pub struct RealBackend {
    pub app: AppHandle,
}

fn to_v<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

fn s<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}

fn need<'a>(args: &'a Value, k: &str) -> Result<&'a str, String> {
    s(args, k).ok_or_else(|| format!("`{k}` is required"))
}

fn arr(v: Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a,
        _ => vec![],
    }
}

fn clip(text: &str, n: usize) -> String {
    let mut out: String = text.chars().take(n).collect();
    if text.chars().count() > n {
        out.push('…');
    }
    out
}

fn is_date(d: &str) -> bool {
    let b = d.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// 以 `extra` 的欄位覆蓋 `base`（只覆蓋 `keys` 列出的欄位）。
fn overlay(mut base: Map<String, Value>, extra: &Value, keys: &[&str]) -> Map<String, Value> {
    for k in keys {
        if let Some(v) = extra.get(*k) {
            base.insert((*k).to_owned(), v.clone());
        }
    }
    base
}

impl RealBackend {
    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    async fn overview(&self) -> Result<Value, String> {
        to_v(commands::overview(self.state()).await)
    }

    /// 我的 id 與我所屬的小組 id
    async fn me_and_teams(&self) -> Result<(String, Vec<String>, Value), String> {
        let ov = self.overview().await?;
        let me = ov["members"]
            .as_array()
            .and_then(|m| m.iter().find(|x| x["isMe"] == true))
            .and_then(|m| m["id"].as_str())
            .unwrap_or_default()
            .to_owned();
        let teams = ov["teams"]
            .as_array()
            .map(|t| {
                t.iter()
                    .filter(|x| {
                        x["members"]
                            .as_array()
                            .is_some_and(|m| m.iter().any(|v| v == &json!(me)))
                            || x["leads"]
                                .as_array()
                                .is_some_and(|m| m.iter().any(|v| v == &json!(me)))
                    })
                    .filter_map(|x| x["id"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        Ok((me, teams, ov))
    }

    async fn all_tasks(&self) -> Result<Vec<Value>, String> {
        Ok(arr(to_v(commands::tasks(self.state()).await)?))
    }
}

impl McpBackend for RealBackend {
    async fn allowed(&self) -> bool {
        let state = self.state();
        let guard = state.node.lock().await;
        guard
            .as_ref()
            .is_some_and(|n| n.mcp_allowed().unwrap_or(false))
    }

    async fn read(&self, tool: &str, args: Value) -> Result<Value, String> {
        match tool {
            "whoami" => {
                let (me, teams, ov) = self.me_and_teams().await?;
                let member = ov["members"]
                    .as_array()
                    .and_then(|m| m.iter().find(|x| x["id"] == json!(me)))
                    .cloned()
                    .unwrap_or(Value::Null);
                let my_teams: Vec<Value> = arr(ov["teams"].clone())
                    .into_iter()
                    .filter(|t| {
                        t["id"]
                            .as_str()
                            .is_some_and(|id| teams.iter().any(|x| x == id))
                    })
                    .collect();
                Ok(json!({
                    "me": { "id": me, "name": member["name"], "isAdmin": member["isAdmin"] },
                    "org": ov["orgName"],
                    "teams": my_teams,
                    "timezone": ov["timezone"],
                    "nowMs": crate::commands::now_ms(),
                    "periodFormats": { "year": "2026", "quarter": "2026-Q4", "month": "2026-11", "week": "2026-W46", "day": "2026-11-09" }
                }))
            }
            "list_members" => {
                let ov = self.overview().await?;
                let members: Vec<Value> = arr(ov["members"].clone())
                    .into_iter()
                    .map(|m| {
                        json!({
                            "id": m["id"], "name": m["name"], "isAdmin": m["isAdmin"], "isMe": m["isMe"],
                            "presence": m["presence"], "until": m["until"], "note": m["note"]
                        })
                    })
                    .collect();
                Ok(json!({ "members": members, "teams": ov["teams"] }))
            }
            "list_goals" => {
                let mine = args
                    .get("mine_only")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let level = s(&args, "level");
                let period = s(&args, "period");
                let list: Vec<Value> = arr(to_v(commands::plans(self.state(), mine).await)?)
                    .into_iter()
                    .filter(|p| level.is_none_or(|l| p["level"] == json!(l)))
                    .filter(|p| period.is_none_or(|x| p["period"] == json!(x)))
                    .collect();
                Ok(Value::Array(list))
            }
            "get_directions" => {
                let d = to_v(commands::directions(self.state()).await)?;
                let notes = to_v(commands::week_notes(self.state()).await)?;
                Ok(
                    json!({ "directions": d["directions"], "teamGoals": d["teamGoals"], "weekNotes": notes }),
                )
            }
            "get_direction_summaries" => {
                let sums = to_v(commands::direction_summaries(self.state()).await)?;
                let rules = to_v(commands::direction_rules(self.state()).await)?;
                Ok(json!({ "summaries": sums, "rules": rules }))
            }
            "list_tasks" => {
                let (me, _, _) = self.me_and_teams().await?;
                let assignee =
                    s(&args, "assignee").map(|a| if a == "me" { me.clone() } else { a.to_owned() });
                let status = s(&args, "status");
                let team = s(&args, "team");
                let before = args.get("due_before").and_then(Value::as_i64);
                let list: Vec<Value> = self
                    .all_tasks()
                    .await?
                    .into_iter()
                    .filter(|t| assignee.as_ref().is_none_or(|a| t["assignee"] == json!(a)))
                    .filter(|t| match status {
                        Some("open") => t["status"] != json!("done"),
                        Some(x) => t["status"] == json!(x),
                        None => true,
                    })
                    .filter(|t| team.is_none_or(|x| t["team"] == json!(x)))
                    .filter(|t| before.is_none_or(|b| t["dueAt"].as_i64().is_some_and(|d| d < b)))
                    .collect();
                Ok(Value::Array(list))
            }
            "get_scrum" => {
                let date = need(&args, "date")?;
                if !is_date(date) {
                    return Err("`date` must be YYYY-MM-DD".into());
                }
                let mine = to_v(commands::scrum_mine(self.state(), date.to_owned()).await)?;
                let (_, teams, _) = self.me_and_teams().await?;
                let mut team = Map::new();
                for t in teams {
                    let r = to_v(
                        commands::scrum_team(
                            self.state(),
                            t.clone(),
                            date.to_owned(),
                            date.to_owned(),
                        )
                        .await,
                    )?;
                    team.insert(t, r);
                }
                Ok(json!({ "mine": mine, "teams": team }))
            }
            "get_report" => {
                let kind = need(&args, "kind")?.to_owned();
                let period = need(&args, "period")?.to_owned();
                let mine =
                    to_v(commands::report_mine(self.state(), kind.clone(), period.clone()).await)?;
                let (_, teams, _) = self.me_and_teams().await?;
                let mut team = Map::new();
                for t in teams {
                    let r = to_v(
                        commands::report_team(
                            self.state(),
                            t.clone(),
                            kind.clone(),
                            period.clone(),
                        )
                        .await,
                    )?;
                    team.insert(t, r);
                }
                Ok(json!({ "mine": mine, "teams": team }))
            }
            "list_conversations" => to_v(commands::conversations(self.state()).await),
            "read_messages" => {
                let conv = need(&args, "conv")?.to_owned();
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map_or(20, |l| l.clamp(1, 50)) as usize;
                to_v(commands::messages(self.state(), conv, Some(limit)).await)
            }
            "search_knowledge" => {
                let q = need(&args, "query")?.to_lowercase();
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map_or(10, |l| l.clamp(1, 50)) as usize;
                let snap = to_v(commands::kb(self.state()).await)?;
                let hits: Vec<Value> = arr(snap["items"].clone())
                    .into_iter()
                    .filter(|it| {
                        let hay = format!(
                            "{} {} {}",
                            it["title"].as_str().unwrap_or_default(),
                            it["body"].as_str().unwrap_or_default(),
                            it["tags"]
                        )
                        .to_lowercase();
                        hay.contains(&q)
                    })
                    .take(limit)
                    .collect();
                Ok(
                    json!({ "items": hits, "topics": snap["topics"], "categories": snap["categories"] }),
                )
            }
            _ => Err("unknown tool".into()),
        }
    }

    async fn prepare(&self, tool: &str, args: Value) -> Result<(Value, Value), String> {
        match tool {
            "propose_goal" => {
                let base = match s(&args, "id") {
                    Some(id) => {
                        let all = arr(to_v(commands::plans(self.state(), false).await)?);
                        let p = all
                            .into_iter()
                            .find(|p| p["id"] == json!(id) && p["mine"] == true)
                            .ok_or("no goal of the user with this id")?;
                        let keys = [
                            "id",
                            "level",
                            "period",
                            "title",
                            "parentId",
                            "krRef",
                            "done",
                            "progressOverride",
                            "keyResults",
                            "alignedGoalId",
                            "criteria",
                            "helps",
                            "visibility",
                        ];
                        keys.iter()
                            .filter_map(|k| p.get(*k).map(|v| ((*k).to_owned(), v.clone())))
                            .collect()
                    }
                    None => {
                        let (_, teams, _) = self.me_and_teams().await?;
                        let vis = teams.first().map_or(
                            json!({ "kind": "org" }),
                            |t| json!({ "kind": "team", "team": t }),
                        );
                        Map::from_iter([("visibility".to_owned(), vis)])
                    }
                };
                let input = Value::Object(overlay(
                    base,
                    &args,
                    &[
                        "level",
                        "period",
                        "title",
                        "parentId",
                        "alignedGoalId",
                        "criteria",
                        "visibility",
                    ],
                ));
                serde_json::from_value::<hills_node::plans::PlanInput>(input.clone())
                    .map_err(|e| format!("invalid goal: {e}"))?;
                let preview = json!({
                    "action": if s(&args, "id").is_some() { "updateGoal" } else { "createGoal" },
                    "level": input["level"], "period": input["period"], "title": input["title"]
                });
                Ok((input, preview))
            }
            "propose_task" => {
                let team = need(&args, "team")?.to_owned();
                let task = s(&args, "task").map(str::to_owned);
                let keys = [
                    "title",
                    "assignee",
                    "status",
                    "dueAt",
                    "steps",
                    "planItemId",
                ];
                let base = match &task {
                    Some(id) => {
                        let t = self
                            .all_tasks()
                            .await?
                            .into_iter()
                            .find(|t| t["id"] == json!(id) && t["team"] == json!(team))
                            .ok_or("no task with this id in this team")?;
                        let mut m: Map<String, Value> = keys
                            .iter()
                            .filter_map(|k| t.get(*k).map(|v| ((*k).to_owned(), v.clone())))
                            .collect();
                        let steps: Vec<Value> = arr(t["steps"].clone())
                            .into_iter()
                            .map(|st| json!({ "id": st["id"], "title": st["title"], "assignee": st["assignee"], "done": st["done"] }))
                            .collect();
                        m.insert("steps".into(), Value::Array(steps));
                        m
                    }
                    None => {
                        let (me, _, _) = self.me_and_teams().await?;
                        Map::from_iter([("assignee".to_owned(), json!(me))])
                    }
                };
                let input = Value::Object(overlay(base, &args, &keys));
                serde_json::from_value::<commands::TaskArgs>(input.clone())
                    .map_err(|e| format!("invalid task: {e}"))?;
                let preview = json!({
                    "action": if task.is_some() { "updateTask" } else { "createTask" },
                    "team": team, "title": input["title"], "assignee": input["assignee"],
                    "dueAt": input["dueAt"], "planItemId": input["planItemId"], "status": input["status"]
                });
                Ok((
                    json!({ "team": team, "task": task, "input": input }),
                    preview,
                ))
            }
            "propose_step_done" => {
                let team = need(&args, "team")?;
                let task = need(&args, "task")?;
                let step = need(&args, "step")?;
                let done = args
                    .get("done")
                    .and_then(Value::as_bool)
                    .ok_or("`done` is required")?;
                let t = self
                    .all_tasks()
                    .await?
                    .into_iter()
                    .find(|t| t["id"] == json!(task) && t["team"] == json!(team))
                    .ok_or("no task with this id in this team")?;
                let st = arr(t["steps"].clone())
                    .into_iter()
                    .find(|x| x["id"] == json!(step))
                    .ok_or("no step with this id")?;
                let preview = json!({ "action": "stepDone", "task": t["title"], "step": st["title"], "done": done });
                Ok((
                    json!({ "team": team, "task": task, "step": step, "done": done }),
                    preview,
                ))
            }
            "propose_scrum_draft" => {
                let date = need(&args, "date")?;
                if !is_date(date) {
                    return Err("`date` must be YYYY-MM-DD".into());
                }
                let draft = need(&args, "draft")?;
                let preview =
                    json!({ "action": "scrumDraft", "date": date, "text": clip(draft, 200) });
                Ok((json!({ "date": date, "draft": draft }), preview))
            }
            "propose_message" => {
                let conv = need(&args, "conv")?;
                let text = need(&args, "text")?;
                if text.chars().count() > 4000 {
                    return Err("message is too long (max 4000 characters)".into());
                }
                let convs = arr(to_v(commands::conversations(self.state()).await)?);
                let c = convs
                    .iter()
                    .find(|c| c["id"] == json!(conv))
                    .ok_or("no conversation with this id")?;
                let preview =
                    json!({ "action": "message", "conv": c["name"], "text": clip(text, 200) });
                Ok((json!({ "conv": conv, "text": text }), preview))
            }
            "propose_kb_item" => {
                let input = Value::Object(overlay(
                    Map::new(),
                    &args,
                    &["key", "title", "body", "tags", "topicId"],
                ));
                serde_json::from_value::<hills_node::kb::KbInput>(input.clone())
                    .map_err(|e| format!("invalid knowledge item: {e}"))?;
                let preview = json!({
                    "action": if s(&args, "key").is_some() { "updateKb" } else { "createKb" },
                    "title": input["title"]
                });
                Ok((input, preview))
            }
            _ => Err("unknown tool".into()),
        }
    }

    async fn apply(&self, tool: &str, args: Value) -> Result<Value, String> {
        let st = self.state();
        match tool {
            "propose_goal" => {
                let input = serde_json::from_value(args).map_err(|e| e.to_string())?;
                to_v(commands::save_plan(st, input).await)
            }
            "propose_task" => {
                let team = need(&args, "team")?.to_owned();
                let input: commands::TaskArgs =
                    serde_json::from_value(args["input"].clone()).map_err(|e| e.to_string())?;
                match s(&args, "task") {
                    Some(task) => {
                        to_v(commands::update_task(st, team, task.to_owned(), input).await)
                    }
                    None => to_v(commands::create_task(st, team, input).await),
                }
            }
            "propose_step_done" => to_v(
                commands::set_step_done(
                    st,
                    need(&args, "team")?.to_owned(),
                    need(&args, "task")?.to_owned(),
                    need(&args, "step")?.to_owned(),
                    args["done"].as_bool().unwrap_or(true),
                )
                .await,
            ),
            "propose_scrum_draft" => to_v(
                commands::scrum_draft_set(
                    st,
                    need(&args, "date")?.to_owned(),
                    Some(need(&args, "draft")?.to_owned()),
                )
                .await,
            ),
            "propose_message" => to_v(
                commands::send_message(
                    st,
                    need(&args, "conv")?.to_owned(),
                    need(&args, "text")?.to_owned(),
                    vec![],
                    None,
                )
                .await,
            ),
            "propose_kb_item" => {
                let input = serde_json::from_value(args).map_err(|e| e.to_string())?;
                to_v(commands::kb_save(st, input).await)
            }
            _ => Err("unknown tool".into()),
        }
    }

    fn notify(&self) {
        let _ = self.app.emit(super::EVENT, "pending");
    }

    fn now_ms(&self) -> i64 {
        crate::commands::now_ms()
    }

    fn new_id(&self) -> String {
        let mut b = [0u8; 10];
        let _ = getrandom::fill(&mut b);
        data_encoding::BASE32_NOPAD.encode(&b).to_lowercase()
    }
}
