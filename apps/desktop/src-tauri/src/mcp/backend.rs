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

fn is_week(w: &str) -> bool {
    let b = w.as_bytes();
    b.len() == 8
        && b[4] == b'-'
        && b[5] == b'W'
        && b[..4].iter().chain(&b[6..]).all(u8::is_ascii_digit)
}

/// Agent 送來的關鍵結果補上預設值（同 app 新增 KR：start 0、target 100、手動）。
fn kr_norm(v: Option<&Value>) -> Option<Value> {
    let a = v?.as_array()?;
    Some(Value::Array(
        a.iter()
            .map(|k| {
                let start = k["start"].as_f64().unwrap_or(0.0);
                json!({
                    "id": k["id"].as_str().unwrap_or_default(),
                    "title": k["title"].as_str().unwrap_or_default(),
                    "start": start,
                    "target": k["target"].as_f64().unwrap_or(100.0),
                    "current": k["current"].as_f64().unwrap_or(start),
                    "unit": k["unit"].as_str().unwrap_or_default(),
                    "manual": k["manual"].as_bool().unwrap_or(true),
                })
            })
            .collect(),
    ))
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// 原本在小組（成員或負責人）、新名單裡沒有的人。
fn removed_members(old: &Value, members: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in strs(&old["members"]).into_iter().chain(strs(&old["leads"])) {
        if !members.contains(&id) && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// 私訊的對象：成員中不是我的那一位。
fn dm_peer(conv: &Value, me: &str) -> Option<String> {
    if conv["kind"] != "dm" {
        return None;
    }
    strs(&conv["members"]).into_iter().find(|m| m != me)
}

/// 名稱比對（去頭尾空白、不分大小寫）。
fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
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

    async fn is_admin(&self) -> Result<bool, String> {
        let ov = self.overview().await?;
        Ok(ov["members"]
            .as_array()
            .and_then(|m| m.iter().find(|x| x["isMe"] == true))
            .is_some_and(|m| m["isAdmin"] == true))
    }

    async fn need_admin(&self) -> Result<(), String> {
        if self.is_admin().await? {
            Ok(())
        } else {
            Err("only admins can do this".into())
        }
    }

    async fn team(&self, id: &str) -> Result<Value, String> {
        arr(to_v(commands::teams_info(self.state()).await)?)
            .into_iter()
            .find(|t| t["id"] == json!(id))
            .ok_or_else(|| "no team with this id".to_owned())
    }

    /// 小組存在且本人可管理（管理者或該小組負責人）。
    async fn managed_team(&self, id: &str) -> Result<Value, String> {
        let t = self.team(id).await?;
        if t["canManage"] != true {
            return Err("only this team's leads or admins can do this".into());
        }
        Ok(t)
    }

    async fn directions(&self) -> Result<Value, String> {
        to_v(commands::directions(self.state()).await)
    }

    async fn task(&self, team: &str, task: &str) -> Result<Value, String> {
        self.all_tasks()
            .await?
            .into_iter()
            .find(|t| t["id"] == json!(task) && t["team"] == json!(team))
            .ok_or_else(|| "no task with this id in this team".to_owned())
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
                    json!({ "directions": d["directions"], "teamGoals": d["teamGoals"], "weekNotes": notes,
                        "purpose": d["purpose"], "teamPurposes": d["teamPurposes"], "strategies": d["strategies"] }),
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
            "get_scrum" | "get_daily_tasks" => {
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
            "list_files" => {
                let query = args["query"].as_str().unwrap_or("").to_lowercase();
                let source = args["source"].as_str();
                let limit = args["limit"].as_u64().unwrap_or(50).clamp(1, 100) as usize;
                let files = to_v(commands::list_files(self.state()).await)?;
                let out: Vec<Value> = files
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|f| {
                        let srcs = f["sources"].as_array().cloned().unwrap_or_default();
                        let hit = query.is_empty()
                            || f["name"]
                                .as_str()
                                .is_some_and(|n| n.to_lowercase().contains(&query))
                            || srcs.iter().any(|s| {
                                s["excerpt"]
                                    .as_str()
                                    .is_some_and(|x| x.to_lowercase().contains(&query))
                            });
                        let kind = source.is_none_or(|k| srcs.iter().any(|s| s["kind"] == k));
                        hit && kind
                    })
                    .take(limit)
                    .map(|mut f| {
                        // 不回傳 Attachment 與金鑰（§18.3 v0.35）
                        if let Some(o) = f.as_object_mut() {
                            o.remove("attachment");
                            o.remove("downloaded");
                        }
                        f
                    })
                    .collect();
                Ok(json!(out))
            }
            "get_my_time" => {
                let from = need(&args, "from")?;
                let to = need(&args, "to")?;
                if !is_date(from) || !is_date(to) || from > to {
                    return Err("`from` / `to` must be YYYY-MM-DD and from ≤ to".into());
                }
                let (me, _, _) = self.me_and_teams().await?;
                let mut months = vec![from[..7].to_owned()];
                if to[..7] != from[..7] {
                    months.push(to[..7].to_owned());
                }
                let days = to_v(commands::worklog_days(self.state(), me, months).await)?;
                let days: Vec<Value> = days
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|d| d["date"].as_str().is_some_and(|x| x >= from && x <= to))
                    .collect();
                let running = to_v(commands::timer_state(self.state()).await)?;
                Ok(json!({ "days": days, "running": running }))
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
            "list_teams" => to_v(commands::teams_info(self.state()).await),
            "get_knowledge" => {
                let key = need(&args, "key")?;
                let snap = commands::kb(self.state()).await?;
                let it = snap
                    .items
                    .into_iter()
                    .find(|i| i.key == key)
                    .ok_or("no knowledge item with this key")?;
                let want = strs(&args["sections"]);
                let secs: Vec<_> = hills_node::doc_spec::sections(it.format, &it.body)
                    .into_iter()
                    .filter(|s| want.is_empty() || s.key.as_ref().is_some_and(|k| want.contains(k)))
                    .collect();
                Ok(json!({
                    "key": it.key, "title": it.title, "format": it.format, "spec": it.spec,
                    "author": it.author.to_string(), "source": it.source, "tags": it.tags,
                    "topicId": it.topic_id, "updatedAt": it.updated_at, "sections": secs
                }))
            }
            "list_knowledge_tree" => {
                let snap = to_v(commands::kb(self.state()).await)?;
                Ok(json!({ "categories": snap["categories"], "topics": snap["topics"] }))
            }
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
                    "teamGoalId",
                    "brief",
                    "acceptance",
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
            "propose_time_fix" => {
                let date = need(&args, "date")?;
                if !is_date(date) {
                    return Err("`date` must be YYYY-MM-DD".into());
                }
                let entries: Vec<hills_node::worklog::Entry> =
                    serde_json::from_value(args["entries"].clone()).map_err(|e| e.to_string())?;
                let total: u32 = entries.iter().map(|x| x.minutes).sum();
                let preview = json!({
                    "action": "timeFix", "date": date, "count": entries.len(),
                    "text": format!("{}:{:02}", total / 60, total % 60)
                });
                Ok((json!({ "date": date, "entries": entries }), preview))
            }
            "propose_scrum_draft" | "propose_daily_tasks" => {
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
                let (me, _, _) = self.me_and_teams().await?;
                let count = c["members"].as_array().map_or(0, Vec::len);
                let preview = json!({
                    "action": "message", "conv": c["name"], "to": dm_peer(c, &me),
                    "count": count, "text": clip(text, 200)
                });
                Ok((json!({ "conv": conv, "text": text }), preview))
            }
            "propose_delete_goal" => {
                let id = need(&args, "id")?;
                let all = arr(to_v(commands::plans(self.state(), true).await)?);
                let p = all
                    .into_iter()
                    .find(|p| p["id"] == json!(id))
                    .ok_or("no goal of the user with this id")?;
                let preview = json!({ "action": "deleteGoal", "title": p["title"], "level": p["level"], "period": p["period"] });
                Ok((json!({ "id": id }), preview))
            }
            "propose_delete_task" => {
                let team = need(&args, "team")?;
                let task = need(&args, "task")?;
                let t = self
                    .all_tasks()
                    .await?
                    .into_iter()
                    .find(|t| t["id"] == json!(task) && t["team"] == json!(team))
                    .ok_or("no task with this id in this team")?;
                let preview = json!({ "action": "deleteTask", "title": t["title"], "team": team, "assignee": t["assignee"] });
                Ok((json!({ "team": team, "task": task }), preview))
            }
            "propose_delete_kb_item" => {
                let key = need(&args, "key")?;
                let snap = to_v(commands::kb(self.state()).await)?;
                let it = arr(snap["items"].clone())
                    .into_iter()
                    .find(|it| it["key"] == json!(key))
                    .ok_or("no knowledge item with this key")?;
                let preview = json!({ "action": "deleteKb", "title": it["title"] });
                Ok((json!({ "key": key }), preview))
            }
            "propose_kb_item" => {
                let mut input = overlay(
                    Map::new(),
                    &args,
                    &["key", "title", "body", "tags", "topicId", "format"],
                );
                input.insert("spec".into(), json!(hills_node::doc_spec::SPEC_V1));
                let input = Value::Object(input);
                let parsed = serde_json::from_value::<hills_node::kb::KbInput>(input.clone())
                    .map_err(|e| format!("invalid knowledge item: {e}"))?;
                hills_node::doc_spec::check(
                    parsed.spec.as_deref(),
                    hills_node::doc_spec::DocKind::Knowledge,
                    parsed.format,
                    &parsed.body,
                )
                .map_err(|e| format!("{e} (hills-doc/1 needs sections summary and content)"))?;
                let preview = json!({
                    "action": if s(&args, "key").is_some() { "updateKb" } else { "createKb" },
                    "title": input["title"]
                });
                Ok((input, preview))
            }
            "propose_team_goal" => {
                let team = need(&args, "team")?;
                let t = self.managed_team(team).await?;
                let dirs = self.directions().await?;
                let id = s(&args, "id");
                let keys = [
                    "id",
                    "team",
                    "year",
                    "title",
                    "directionId",
                    "keyResults",
                    "criteria",
                ];
                let base: Map<String, Value> = match id {
                    Some(id) => {
                        let g = arr(dirs["teamGoals"].clone())
                            .into_iter()
                            .find(|g| g["id"] == json!(id) && g["team"] == json!(team))
                            .ok_or("no team goal with this id in this team")?;
                        keys.iter()
                            .filter_map(|k| g.get(*k).map(|v| ((*k).to_owned(), v.clone())))
                            .collect()
                    }
                    None => Map::from_iter([("team".to_owned(), json!(team))]),
                };
                let mut input = overlay(base, &args, &["year", "title", "directionId", "criteria"]);
                if let Some(krs) = kr_norm(args.get("keyResults")) {
                    input.insert("keyResults".into(), krs);
                }
                let input = Value::Object(input);
                if let Some(d) = input["directionId"].as_str().filter(|d| !d.is_empty()) {
                    let dir = arr(dirs["directions"].clone())
                        .into_iter()
                        .find(|x| x["id"] == json!(d))
                        .ok_or("no company direction with this id")?;
                    if dir["year"] != input["year"] {
                        return Err("the company direction is for a different year".into());
                    }
                }
                serde_json::from_value::<hills_node::direction::TeamGoalInput>(input.clone())
                    .map_err(|e| format!("invalid team goal: {e}"))?;
                let preview = json!({
                    "action": if id.is_some() { "updateTeamGoal" } else { "createTeamGoal" },
                    "team": t["name"], "period": input["year"], "title": input["title"]
                });
                Ok((input, preview))
            }
            "propose_delete_team_goal" => {
                let team = need(&args, "team")?;
                let id = need(&args, "id")?;
                let t = self.managed_team(team).await?;
                let g = arr(self.directions().await?["teamGoals"].clone())
                    .into_iter()
                    .find(|g| g["id"] == json!(id) && g["team"] == json!(team))
                    .ok_or("no team goal with this id in this team")?;
                let preview = json!({
                    "action": "deleteTeamGoal", "team": t["name"], "period": g["year"], "title": g["title"]
                });
                Ok((json!({ "team": team, "id": id }), preview))
            }
            "propose_week_note" => {
                let team = need(&args, "team")?;
                let week = need(&args, "week")?;
                if !is_week(week) {
                    return Err("`week` must be an ISO week like 2026-W46".into());
                }
                let text = args["text"].as_str().ok_or("`text` is required")?;
                let t = self.managed_team(team).await?;
                let preview = json!({
                    "action": "weekNote", "team": t["name"], "period": week, "text": clip(text, 200)
                });
                Ok((json!({ "team": team, "week": week, "text": text }), preview))
            }
            "propose_direction" => {
                self.need_admin().await?;
                let id = s(&args, "id");
                let base: Map<String, Value> = match id {
                    Some(id) => {
                        let d = arr(self.directions().await?["directions"].clone())
                            .into_iter()
                            .find(|d| d["id"] == json!(id))
                            .ok_or("no company direction with this id")?;
                        ["id", "year", "title", "keyResults"]
                            .iter()
                            .filter_map(|k| d.get(*k).map(|v| ((*k).to_owned(), v.clone())))
                            .collect()
                    }
                    None => Map::new(),
                };
                let mut input = overlay(base, &args, &["year", "title"]);
                if let Some(krs) = kr_norm(args.get("keyResults")) {
                    input.insert("keyResults".into(), krs);
                }
                let input = Value::Object(input);
                serde_json::from_value::<hills_node::direction::DirectionInput>(input.clone())
                    .map_err(|e| format!("invalid direction: {e}"))?;
                let preview = json!({
                    "action": if id.is_some() { "updateDirection" } else { "createDirection" },
                    "period": input["year"], "title": input["title"]
                });
                Ok((input, preview))
            }
            "propose_delete_direction" => {
                self.need_admin().await?;
                let id = need(&args, "id")?;
                let d = arr(self.directions().await?["directions"].clone())
                    .into_iter()
                    .find(|d| d["id"] == json!(id))
                    .ok_or("no company direction with this id")?;
                let preview = json!({ "action": "deleteDirection", "period": d["year"], "title": d["title"] });
                Ok((json!({ "id": id }), preview))
            }
            "propose_task_status" => {
                let team = need(&args, "team")?;
                let task = need(&args, "task")?;
                let status = need(&args, "status")?;
                if !["todo", "doing", "review", "done"].contains(&status) {
                    return Err("`status` must be todo, doing, review or done".into());
                }
                let t = self.task(team, task).await?;
                let mut input: Map<String, Value> =
                    ["title", "assignee", "dueAt", "planItemId", "teamGoalId"]
                        .iter()
                        .filter_map(|k| t.get(*k).map(|v| ((*k).to_owned(), v.clone())))
                        .collect();
                let steps: Vec<Value> = arr(t["steps"].clone())
                    .into_iter()
                    .map(|st| json!({ "id": st["id"], "title": st["title"], "assignee": st["assignee"], "done": st["done"] }))
                    .collect();
                input.insert("steps".into(), Value::Array(steps));
                input.insert("status".into(), json!(status));
                let input = Value::Object(input);
                serde_json::from_value::<commands::TaskArgs>(input.clone())
                    .map_err(|e| format!("invalid task: {e}"))?;
                let preview = json!({
                    "action": "taskStatus", "title": t["title"], "status": status, "assignee": t["assignee"]
                });
                Ok((
                    json!({ "team": team, "task": task, "input": input }),
                    preview,
                ))
            }
            "propose_task_log" => {
                let team = need(&args, "team")?;
                let task = need(&args, "task")?;
                let kind = need(&args, "kind")?;
                if ![
                    "start", "progress", "question", "answer", "blocked", "resolved",
                ]
                .contains(&kind)
                {
                    return Err(
                        "`kind` must be start, progress, blocked, resolved or answer".into(),
                    );
                }
                let blocked = s(&args, "blocked").unwrap_or_default();
                if kind == "resolved" && blocked.is_empty() {
                    return Err("`blocked` is required for `resolved`".into());
                }
                let text = s(&args, "text").unwrap_or_default();
                if !["start", "resolved"].contains(&kind) && text.trim().is_empty() {
                    return Err("`text` is required".into());
                }
                let percent = args["percent"].as_u64();
                if percent.is_some_and(|p| p > 100) {
                    return Err("`percent` must be 0–100".into());
                }
                let t = self.task(team, task).await?;
                let preview = json!({
                    "action": "taskLog", "title": t["title"], "kind": kind,
                    "text": clip(text, 120), "percent": percent
                });
                Ok((
                    json!({ "team": team, "task": task, "kind": kind, "text": text, "percent": percent, "blocked": blocked }),
                    preview,
                ))
            }
            "propose_task_close" => {
                let team = need(&args, "team")?;
                let task = need(&args, "task")?;
                let body = need(&args, "body")?;
                let format: hills_node::doc_spec::DocFormat = serde_json::from_value(
                    args.get("format").cloned().unwrap_or(json!("markdown")),
                )
                .map_err(|_| "`format` must be markdown or html".to_owned())?;
                let t = self.task(team, task).await?;
                let has_criteria = !arr(t["acceptance"].clone()).is_empty();
                hills_node::doc_spec::check(
                    Some(hills_node::doc_spec::SPEC_V1),
                    hills_node::doc_spec::DocKind::Report {
                        criteria: has_criteria,
                    },
                    format,
                    body,
                )
                .map_err(|e| e.to_string())?;
                let input = json!({
                    "format": format, "body": body,
                    "criteria": args.get("criteria").cloned().unwrap_or(json!([])),
                    "attachments": [],
                    "refs": args.get("refs").cloned().unwrap_or(json!([])),
                });
                serde_json::from_value::<hills_node::task_report::CloseInput>(input.clone())
                    .map_err(|e| format!("invalid report: {e}"))?;
                let summary = hills_node::doc_spec::sections(format, body)
                    .into_iter()
                    .find(|x| x.key.as_deref() == Some("summary"))
                    .map(|x| x.text)
                    .unwrap_or_default();
                let preview = json!({
                    "action": "closeTask", "title": t["title"], "text": clip(&summary, 120)
                });
                Ok((
                    json!({ "team": team, "task": task, "input": input }),
                    preview,
                ))
            }
            "propose_task_reopen" => {
                let team = need(&args, "team")?;
                let task = need(&args, "task")?;
                let text = need(&args, "text")?;
                if text.trim().is_empty() {
                    return Err("`text` is required".into());
                }
                let t = self.task(team, task).await?;
                let preview =
                    json!({ "action": "reopenTask", "title": t["title"], "text": clip(text, 120) });
                Ok((json!({ "team": team, "task": task, "text": text }), preview))
            }
            "propose_task_ack" => {
                let team = need(&args, "team")?;
                let task = need(&args, "task")?;
                let state = need(&args, "state")?;
                let note = s(&args, "note").map(str::trim).filter(|n| !n.is_empty());
                match state {
                    "accepted" => {}
                    "concern" if note.is_none() => {
                        return Err("`note` is required when state is concern".into());
                    }
                    "concern" => {}
                    _ => return Err("`state` must be accepted or concern".into()),
                }
                if note.is_some_and(|n| n.chars().count() > 200) {
                    return Err("`note` is too long (max 200 characters)".into());
                }
                let t = self.task(team, task).await?;
                let (me, _, _) = self.me_and_teams().await?;
                if t["assignee"] != json!(me) {
                    return Err("only the task's assignee can answer it".into());
                }
                let preview = json!({
                    "action": "taskAck", "title": t["title"], "state": state, "text": note, "assignee": t["assignedBy"]
                });
                Ok((
                    json!({ "team": team, "task": task, "state": state, "note": note }),
                    preview,
                ))
            }
            "propose_team" => {
                let name = need(&args, "name")?.trim().to_owned();
                if name.is_empty() || name.chars().count() > 40 {
                    return Err("`name` must be 1-40 characters".into());
                }
                let members = strs(&args["members"]);
                let leads = strs(&args["leads"]);
                if members.is_empty() {
                    return Err("a team needs at least one member".into());
                }
                if let Some(l) = leads.iter().find(|l| !members.contains(l)) {
                    return Err(format!("lead {l} must also be in members"));
                }
                let ov = self.overview().await?;
                let known = |id: &String| {
                    ov["members"]
                        .as_array()
                        .is_some_and(|m| m.iter().any(|x| x["id"] == json!(id)))
                };
                if let Some(x) = members.iter().find(|m| !known(m)) {
                    return Err(format!("no member with id {x}"));
                }
                let admin = self.is_admin().await?;
                let input = json!({ "id": s(&args, "id"), "name": name, "members": members, "leads": leads });
                let preview = match s(&args, "id") {
                    None => {
                        if !admin {
                            return Err("only admins can create teams".into());
                        }
                        json!({ "action": "createTeam", "title": name, "count": members.len(), "leads": leads })
                    }
                    Some(id) => {
                        let t = self.managed_team(id).await?;
                        if t["name"] != json!(name) && !admin {
                            return Err("only admins can rename teams".into());
                        }
                        json!({
                            "action": "updateTeam", "team": t["name"], "title": name,
                            "count": members.len(), "leads": leads,
                            "removed": removed_members(&t, &members)
                        })
                    }
                };
                Ok((input, preview))
            }
            "propose_archive_team" => {
                self.need_admin().await?;
                let id = need(&args, "id")?;
                let archived = args
                    .get("archived")
                    .and_then(Value::as_bool)
                    .ok_or("`archived` is required")?;
                let t = self.team(id).await?;
                let preview = json!({
                    "action": if archived { "archiveTeam" } else { "unarchiveTeam" }, "team": t["name"]
                });
                Ok((json!({ "id": id, "archived": archived }), preview))
            }
            "propose_kb_category" => {
                let name = need(&args, "name")?.trim().to_owned();
                let snap = to_v(commands::kb(self.state()).await)?;
                if arr(snap["categories"].clone()).iter().any(|c| {
                    c["resolved"] == c["id"]
                        && same_name(c["name"].as_str().unwrap_or_default(), &name)
                }) {
                    return Err("a category with this name already exists".into());
                }
                let preview = json!({ "action": "createKbCategory", "title": name });
                Ok((json!({ "name": name }), preview))
            }
            "propose_kb_topic" => {
                let category = need(&args, "categoryId")?;
                let name = need(&args, "name")?.trim().to_owned();
                let snap = to_v(commands::kb(self.state()).await)?;
                let cat = arr(snap["categories"].clone())
                    .into_iter()
                    .find(|c| c["id"] == json!(category))
                    .ok_or("no category with this id")?;
                if arr(snap["topics"].clone()).iter().any(|t| {
                    t["categoryId"] == json!(category)
                        && t["resolved"] == t["id"]
                        && same_name(t["name"].as_str().unwrap_or_default(), &name)
                }) {
                    return Err("this category already has a topic with this name".into());
                }
                let preview =
                    json!({ "action": "createKbTopic", "title": name, "parent": cat["name"] });
                Ok((json!({ "categoryId": category, "name": name }), preview))
            }
            "propose_kb_rename" => {
                let kind = need(&args, "kind")?;
                let id = need(&args, "id")?;
                let name = need(&args, "name")?.trim().to_owned();
                let list = match kind {
                    "category" => "categories",
                    "topic" => "topics",
                    _ => return Err("`kind` must be category or topic".into()),
                };
                let snap = to_v(commands::kb(self.state()).await)?;
                let it = arr(snap[list].clone())
                    .into_iter()
                    .find(|x| x["id"] == json!(id))
                    .ok_or("no category or topic with this id")?;
                let preview = json!({ "action": "renameKb", "kind": kind, "from": it["name"], "title": name });
                Ok((json!({ "kind": kind, "id": id, "name": name }), preview))
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
            "propose_time_fix" => {
                let entries: Vec<hills_node::worklog::Entry> =
                    serde_json::from_value(args["entries"].clone()).map_err(|e| e.to_string())?;
                to_v(
                    commands::set_worklog_day(
                        st,
                        need(&args, "date")?.to_owned(),
                        hills_node::worklog::DayLog {
                            date: String::new(),
                            entries: entries
                                .into_iter()
                                .map(|mut x| {
                                    x.source = "edited".into();
                                    x
                                })
                                .collect(),
                            attendance: None,
                            updated_at: 0,
                        },
                    )
                    .await,
                )
            }
            "propose_scrum_draft" | "propose_daily_tasks" => to_v(
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
            "propose_delete_goal" => {
                to_v(commands::delete_plan(st, need(&args, "id")?.to_owned()).await)
            }
            "propose_delete_task" => to_v(
                commands::delete_task(
                    st,
                    need(&args, "team")?.to_owned(),
                    need(&args, "task")?.to_owned(),
                )
                .await,
            ),
            "propose_delete_kb_item" => {
                to_v(commands::kb_delete(st, need(&args, "key")?.to_owned()).await)
            }
            "propose_team_goal" => {
                let input = serde_json::from_value(args).map_err(|e| e.to_string())?;
                to_v(commands::save_team_goal(st, input).await)
            }
            "propose_delete_team_goal" => to_v(
                commands::delete_team_goal(
                    st,
                    need(&args, "team")?.to_owned(),
                    need(&args, "id")?.to_owned(),
                )
                .await,
            ),
            "propose_week_note" => to_v(
                commands::set_week_note(
                    st,
                    need(&args, "team")?.to_owned(),
                    need(&args, "week")?.to_owned(),
                    args["text"].as_str().unwrap_or_default().to_owned(),
                )
                .await,
            ),
            "propose_direction" => {
                let input = serde_json::from_value(args).map_err(|e| e.to_string())?;
                to_v(commands::save_direction(st, input).await)
            }
            "propose_delete_direction" => {
                to_v(commands::delete_direction(st, need(&args, "id")?.to_owned()).await)
            }
            "propose_task_status" => {
                let input: commands::TaskArgs =
                    serde_json::from_value(args["input"].clone()).map_err(|e| e.to_string())?;
                to_v(
                    commands::update_task(
                        st,
                        need(&args, "team")?.to_owned(),
                        need(&args, "task")?.to_owned(),
                        input,
                    )
                    .await,
                )
            }
            "propose_task_log" if args["kind"] == "resolved" => to_v(
                commands::resolve_task_blocked(
                    st,
                    need(&args, "team")?.to_owned(),
                    need(&args, "task")?.to_owned(),
                    need(&args, "blocked")?.to_owned(),
                    s(&args, "text").unwrap_or_default().to_owned(),
                )
                .await,
            ),
            "propose_task_log" => {
                let kind: hills_node::task_report::LogKind =
                    serde_json::from_value(args["kind"].clone()).map_err(|e| e.to_string())?;
                to_v(
                    commands::add_task_log(
                        st,
                        need(&args, "team")?.to_owned(),
                        need(&args, "task")?.to_owned(),
                        kind,
                        s(&args, "text").unwrap_or_default().to_owned(),
                        args["percent"].as_u64().and_then(|p| u8::try_from(p).ok()),
                    )
                    .await,
                )
            }
            "propose_task_close" => {
                let input: hills_node::task_report::CloseInput =
                    serde_json::from_value(args["input"].clone()).map_err(|e| e.to_string())?;
                to_v(
                    commands::close_task(
                        st,
                        need(&args, "team")?.to_owned(),
                        need(&args, "task")?.to_owned(),
                        input,
                    )
                    .await,
                )
            }
            "propose_task_reopen" => to_v(
                commands::reopen_task(
                    st,
                    need(&args, "team")?.to_owned(),
                    need(&args, "task")?.to_owned(),
                    need(&args, "text")?.to_owned(),
                )
                .await,
            ),
            "propose_task_ack" => {
                let ack: hills_node::AckState =
                    serde_json::from_value(args["state"].clone()).map_err(|e| e.to_string())?;
                to_v(
                    commands::set_task_ack(
                        st,
                        need(&args, "team")?.to_owned(),
                        need(&args, "task")?.to_owned(),
                        ack,
                        s(&args, "note").map(str::to_owned),
                    )
                    .await,
                )
            }
            "propose_team" => {
                let name = need(&args, "name")?.to_owned();
                let members = strs(&args["members"]);
                let leads = strs(&args["leads"]);
                match s(&args, "id") {
                    None => to_v(commands::create_team(st, name, members, leads).await),
                    Some(id) => {
                        let t = self.team(id).await?;
                        if t["name"] != json!(name) {
                            commands::rename_team(self.state(), id.to_owned(), name).await?;
                        }
                        let same = |a: &Value, b: &[String]| {
                            let mut x = strs(a);
                            let mut y = b.to_vec();
                            x.sort();
                            y.sort();
                            x == y
                        };
                        if !same(&t["members"], &members) || !same(&t["leads"], &leads) {
                            commands::set_team_members(self.state(), id.to_owned(), members, leads)
                                .await?;
                        }
                        Ok(json!(id))
                    }
                }
            }
            "propose_archive_team" => to_v(
                commands::archive_team(
                    st,
                    need(&args, "id")?.to_owned(),
                    args["archived"].as_bool().unwrap_or(true),
                )
                .await,
            ),
            "propose_kb_category" => {
                to_v(commands::kb_create_category(st, need(&args, "name")?.to_owned()).await)
            }
            "propose_kb_topic" => to_v(
                commands::kb_create_topic(
                    st,
                    need(&args, "categoryId")?.to_owned(),
                    need(&args, "name")?.to_owned(),
                )
                .await,
            ),
            "propose_kb_rename" => to_v(
                commands::kb_rename(
                    st,
                    need(&args, "kind")?.to_owned(),
                    need(&args, "id")?.to_owned(),
                    need(&args, "name")?.to_owned(),
                )
                .await,
            ),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn week_codes() {
        assert!(is_week("2026-W46"));
        assert!(!is_week("2026-46") && !is_week("2026-W4") && !is_week("2026-WAB"));
    }

    #[test]
    fn key_results_get_defaults() {
        let v = kr_norm(Some(
            &json!([{ "title": "DEMO", "target": 1 }, { "title": "x", "start": 5 }]),
        ))
        .unwrap();
        assert_eq!(v[0]["start"], 0.0);
        assert_eq!(v[0]["target"], 1.0);
        assert_eq!(v[0]["manual"], true);
        assert_eq!(v[0]["id"], "");
        assert_eq!(v[1]["current"], 5.0);
        assert_eq!(v[1]["target"], 100.0);
        assert!(kr_norm(None).is_none());
    }

    #[test]
    fn removed_includes_dropped_leads_once() {
        let old = json!({ "members": ["a", "b", "c"], "leads": ["a", "d"] });
        let new = vec!["b".to_owned(), "c".to_owned()];
        assert_eq!(removed_members(&old, &new), vec!["a", "d"]);
        assert!(removed_members(&old, &["a", "b", "c", "d"].map(String::from)).is_empty());
    }

    #[test]
    fn dm_peer_is_the_other_member() {
        let dm = json!({ "kind": "dm", "members": ["me", "you"] });
        assert_eq!(dm_peer(&dm, "me").as_deref(), Some("you"));
        let group = json!({ "kind": "group", "members": ["me", "you"] });
        assert_eq!(dm_peer(&group, "me"), None);
        assert!(same_name(" AquaMind ", "aquamind"));
    }
}
