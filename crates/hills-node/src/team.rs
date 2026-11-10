//! team 文件的任務與角色外觀（technical-design §16.8 v0.11、D40），以及首頁的焦點規則。
//!
//! 任務放在根物件的 `task:<ULID>`，外觀放在 `profile:<memberId>`（JSON 字串，驗證層限本人寫入）。
//! 私人任務（v0.19，D46）以相同結構放在 `member/<id>/tasks`，介面以 `team = "private"` 表示。

use std::collections::BTreeMap;

use anyhow::{Result, anyhow, bail};
use automerge::{AutoCommit, ObjId, ObjType, ROOT, ReadDoc, transaction::Transactable};
use hills_proto::{MemberId, Timestamp};
use serde::{Deserialize, Serialize};

use crate::node::{Node, now_ms};
use crate::org::{get_int, get_obj, get_str};

pub(crate) const TASK_PREFIX: &str = "task:";
/// 私人任務在介面與命令中的「小組」值（technical-design §16.8 v0.19）
pub const PRIVATE_TEAM: &str = "private";
const PROFILE_PREFIX: &str = "profile:";
/// 任務回應 `ack:<taskId>:<memberId>`（technical-design §16.8 v0.26，D50）
const ACK_PREFIX: &str = "ack:";
const MAX_ACK_NOTE: usize = 200;
const FOCUS_FILE: &str = "focus";
const MAX_STEPS: usize = 30;
/// 交付說明上限（D53，technical-design §16.8 v0.29）
const MAX_BRIEF: usize = 8 * 1024;
/// 預估分鐘數上限（1000 小時，D62）
const MAX_ESTIMATE: u32 = 60_000;
/// 完成條件條數與每條字數上限（D53）
const MAX_CRITERIA: usize = 20;
const MAX_CRITERION: usize = 200;
const MAX_TITLE: usize = 200;
/// 外觀色盤的大小（前端 `summit.ts` 須一致；technical-design §16.8 v0.31，D56）
pub const LOOK_PALETTE: u8 = 6;
/// 角色種類數：男性、女性、貓、狗、大象、羊、老虎（D56）
pub const LOOK_KINDS: u8 = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    #[default]
    Todo,
    Doing,
    Review,
    Done,
}

impl TaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Doing => "doing",
            Self::Review => "review",
            Self::Done => "done",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "doing" => Self::Doing,
            "review" => Self::Review,
            "done" => Self::Done,
            _ => Self::Todo,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    pub id: String,
    pub title: String,
    pub assignee: Option<MemberId>,
    pub done: bool,
    pub done_at: Option<Timestamp>,
    /// 預估分鐘數（v0.34，D62）
    pub estimate: Option<u32>,
}

/// 卡住中的紀錄（technical-design §16.8 v0.34，D60）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocked {
    /// 紀錄 id（ULID）
    pub log: String,
    pub author: MemberId,
    pub text: String,
    pub since: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub team: String,
    pub title: String,
    pub assignee: Option<MemberId>,
    pub status: TaskStatus,
    pub due_at: Option<Timestamp>,
    /// 改成完成的時間（v0.21，D47 方向摘要）
    pub done_at: Option<Timestamp>,
    pub steps: Vec<TaskStep>,
    /// 所屬週目標（D46）
    pub plan_item_id: Option<String>,
    pub created_by: Option<MemberId>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    /// 指派者與指派時間（負責人改變時寫入，D50）
    pub assigned_by: Option<MemberId>,
    pub assigned_at: Option<Timestamp>,
    /// 來源小組目標（D50，只供顯示與建議）
    pub team_goal_id: Option<String>,
    /// 目前負責人有效的回應（D50）
    pub ack: Option<Ack>,
    /// 交付說明（Markdown，D53）
    pub brief: Option<String>,
    /// 完成條件（D53）
    pub acceptance: Vec<Criterion>,
    /// 預估分鐘數（v0.34，D62）
    pub estimate: Option<u32>,
    /// 負責人最新回報的百分比（退回後重新計算，D60）
    pub reported: Option<u8>,
    /// 卡住中（最新一筆未解決的「卡住了」，D60）
    pub blocked: Option<Blocked>,
}

/// 任務的一條完成條件（technical-design §16.8 v0.29，D53）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Criterion {
    pub id: String,
    pub text: String,
}

/// 完成條件的輸入；`id` 為空時新增。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriterionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub text: String,
}

/// 負責人對指派的回應（technical-design §16.8 v0.26）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AckState {
    Accepted,
    Concern,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    pub state: AckState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub at: Timestamp,
}

impl Task {
    /// 待接下：有負責人、不是負責人自己指派、且沒有有效的「接下」。
    pub fn pending_ack(&self) -> bool {
        match (&self.assignee, &self.assigned_by) {
            (Some(a), Some(by)) => {
                a != by
                    && self.status != TaskStatus::Done
                    && !matches!(&self.ack, Some(k) if k.state == AckState::Accepted)
            }
            _ => false,
        }
    }

    /// 第一個未完成的步驟。
    pub fn next_step(&self) -> Option<&TaskStep> {
        self.steps.iter().find(|s| !s.done)
    }

    pub fn is_private(&self) -> bool {
        self.team == PRIVATE_TEAM
    }

    /// 任務進度 0–100（§16.8 v0.34，D60）：完成 = 100；否則取完成步驟比例與最新回報百分比較大者。
    pub fn progress(&self) -> f64 {
        if self.status == TaskStatus::Done {
            return 100.0;
        }
        let steps = if self.steps.is_empty() {
            0.0
        } else {
            let done = self.steps.iter().filter(|s| s.done).count();
            done as f64 * 100.0 / self.steps.len() as f64
        };
        steps.max(f64::from(self.reported.unwrap_or(0)))
    }
}

/// 建立 / 編輯任務的輸入；步驟 `id` 為空時新增。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub title: String,
    pub assignee: Option<MemberId>,
    pub status: Option<TaskStatus>,
    pub due_at: Option<Timestamp>,
    pub steps: Vec<StepInput>,
    /// 所屬週目標（D46）；由 node 檢查存在且為週層級
    #[serde(default)]
    pub plan_item_id: Option<String>,
    /// 來源小組目標（D50）；由 node 檢查存在於同一小組
    #[serde(default)]
    pub team_goal_id: Option<String>,
    /// 交付說明（D53）；None = 不變更，空字串 = 清除（其他畫面編輯任務時不會誤刪）
    #[serde(default)]
    pub brief: Option<String>,
    /// 完成條件（D53）；None = 不變更
    #[serde(default)]
    pub acceptance: Option<Vec<CriterionInput>>,
    /// 預估分鐘數（D62）；None = 不變更，0 = 清除
    #[serde(default)]
    pub estimate: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepInput {
    pub id: Option<String>,
    pub title: String,
    pub assignee: Option<MemberId>,
    #[serde(default)]
    pub done: bool,
    /// 預估分鐘數（D62）；None = 沿用既有步驟的值，0 = 清除
    #[serde(default)]
    pub estimate: Option<u32>,
}

/// 角色外觀：角色種類與三個部位的色號（technical-design §16.8 v0.31，D56）。
/// 舊資料沒有 `kind`，視為 0（男性）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Look {
    #[serde(default)]
    pub kind: u8,
    pub hair: u8,
    pub shirt: u8,
    pub skin: u8,
}

impl Look {
    pub fn is_valid(&self) -> bool {
        self.kind < LOOK_KINDS
            && self.hair < LOOK_PALETTE
            && self.shirt < LOOK_PALETTE
            && self.skin < LOOK_PALETTE
    }

    /// 讀取時的相容換算：色號以色盤大小取餘數，未知的角色視為男性。
    pub fn normalized(self) -> Look {
        Look {
            kind: if self.kind < LOOK_KINDS { self.kind } else { 0 },
            hair: self.hair % LOOK_PALETTE,
            shirt: self.shirt % LOOK_PALETTE,
            skin: self.skin % LOOK_PALETTE,
        }
    }
}

// ---------- 文件讀寫（純函式） ----------

type R<T> = Result<T, automerge::AutomergeError>;

fn member(doc: &AutoCommit, obj: &ObjId, key: &str) -> Option<MemberId> {
    get_str(doc, obj, key).and_then(|s| MemberId::parse(&s).ok())
}

fn get_bool(doc: &AutoCommit, obj: &ObjId, key: &str) -> bool {
    matches!(
        doc.get(obj, key).ok().flatten().map(|v| v.0),
        Some(automerge::Value::Scalar(s)) if matches!(s.as_ref(), automerge::ScalarValue::Boolean(true))
    )
}

fn read_steps(doc: &AutoCommit, task: &ObjId) -> Vec<TaskStep> {
    let Some(list) = get_obj(doc, task, "steps") else {
        return vec![];
    };
    (0..doc.length(&list))
        .filter_map(|i| match doc.get(&list, i).ok()?? {
            (automerge::Value::Object(_), id) => Some(id),
            _ => None,
        })
        .map(|s| TaskStep {
            id: get_str(doc, &s, "id").unwrap_or_default(),
            title: get_str(doc, &s, "title").unwrap_or_default(),
            assignee: member(doc, &s, "assignee"),
            done: get_bool(doc, &s, "done"),
            done_at: get_int(doc, &s, "doneAt"),
            estimate: get_int(doc, &s, "estimate").and_then(|v| u32::try_from(v).ok()),
        })
        .collect()
}

pub fn read_tasks(doc: &AutoCommit, team: &str) -> Vec<Task> {
    let tasks = doc
        .keys(ROOT)
        .filter_map(|k| {
            let id = k.strip_prefix(TASK_PREFIX)?.to_owned();
            let t = get_obj(doc, &ROOT, &k)?;
            Some(Task {
                id,
                team: team.to_owned(),
                title: get_str(doc, &t, "title").unwrap_or_default(),
                assignee: member(doc, &t, "assignee"),
                status: TaskStatus::parse(&get_str(doc, &t, "status").unwrap_or_default()),
                due_at: get_int(doc, &t, "dueAt"),
                done_at: get_int(doc, &t, "doneAt"),
                steps: read_steps(doc, &t),
                plan_item_id: get_str(doc, &t, "planItemId").filter(|s| !s.is_empty()),
                created_by: member(doc, &t, "createdBy"),
                created_at: get_int(doc, &t, "createdAt").unwrap_or(0),
                updated_at: get_int(doc, &t, "updatedAt").unwrap_or(0),
                assigned_by: member(doc, &t, "assignedBy"),
                assigned_at: get_int(doc, &t, "assignedAt"),
                team_goal_id: get_str(doc, &t, "teamGoalId").filter(|s| !s.is_empty()),
                ack: None,
                brief: get_str(doc, &t, "brief").filter(|s| !s.trim().is_empty()),
                acceptance: get_str(doc, &t, "acceptance")
                    .and_then(|raw| serde_json::from_str(&raw).ok())
                    .unwrap_or_default(),
                estimate: get_int(doc, &t, "estimate").and_then(|v| u32::try_from(v).ok()),
                reported: None,
                blocked: None,
            })
        })
        .collect::<Vec<_>>();
    let mut summary = crate::task_report::summarize_logs(doc);
    tasks
        .into_iter()
        .map(|mut t| {
            t.ack = read_ack(doc, &t);
            if let Some(s) = summary.remove(&t.id) {
                t.reported = s.reported_by(t.assignee.as_ref(), t.is_private());
                t.blocked = s.blocked;
            }
            t
        })
        .collect()
}

/// 目前負責人有效的回應：`at ≥ assignedAt`（改派後舊回應失效）。
fn read_ack(doc: &AutoCommit, t: &Task) -> Option<Ack> {
    let who = t.assignee?;
    let raw = get_str(doc, &ROOT, &format!("{ACK_PREFIX}{}:{who}", t.id))?;
    let ack: Ack = serde_json::from_str(&raw).ok()?;
    (ack.at >= t.assigned_at.unwrap_or(0)).then_some(ack)
}

/// 寫入本人對任務的回應。
pub fn put_ack(doc: &mut AutoCommit, task: &str, me: &MemberId, ack: &Ack) -> Result<()> {
    doc.put(
        ROOT,
        format!("{ACK_PREFIX}{task}:{me}").as_str(),
        serde_json::to_string(ack)?,
    )?;
    Ok(())
}

/// 任務改成完成時寫入 `doneAt`（已有則保留），離開完成時刪除（technical-design §16.8 v0.21）。
pub(crate) fn put_done_at(
    doc: &mut AutoCommit,
    t: &ObjId,
    status: TaskStatus,
    now: Timestamp,
) -> R<()> {
    let has = doc.get(t, "doneAt")?.is_some();
    if status == TaskStatus::Done {
        if !has {
            doc.put(t, "doneAt", now)?;
        }
    } else if has {
        doc.delete(t, "doneAt")?;
    }
    Ok(())
}

fn put_opt_member(doc: &mut AutoCommit, obj: &ObjId, key: &str, m: Option<&MemberId>) -> R<()> {
    match m {
        Some(m) => doc.put(obj, key, m.to_string().as_str())?,
        None => {
            if doc.get(obj, key)?.is_some() {
                doc.delete(obj, key)?;
            }
        }
    }
    Ok(())
}

fn validate(input: &TaskInput) -> Result<()> {
    let n = input.title.trim().chars().count();
    if n == 0 || n > MAX_TITLE {
        bail!("任務標題需為 1–{MAX_TITLE} 字");
    }
    if input.steps.len() > MAX_STEPS {
        bail!("步驟最多 {MAX_STEPS} 個");
    }
    if input
        .steps
        .iter()
        .any(|s| s.title.trim().is_empty() || s.title.chars().count() > MAX_TITLE)
    {
        bail!("步驟名稱需為 1–{MAX_TITLE} 字");
    }
    if input.estimate.is_some_and(|e| e > MAX_ESTIMATE)
        || input
            .steps
            .iter()
            .any(|s| s.estimate.is_some_and(|e| e > MAX_ESTIMATE))
    {
        bail!("預估時數最多 1000 小時");
    }
    if input.brief.as_ref().is_some_and(|b| b.len() > MAX_BRIEF) {
        bail!("交付說明最多 8 KB");
    }
    let acceptance = input.acceptance.as_deref().unwrap_or_default();
    if acceptance.len() > MAX_CRITERIA {
        bail!("完成條件最多 {MAX_CRITERIA} 條");
    }
    if acceptance.iter().any(|c| {
        let n = c.text.trim().chars().count();
        n == 0 || n > MAX_CRITERION
    }) {
        bail!("每條完成條件需為 1–{MAX_CRITERION} 字");
    }
    Ok(())
}

/// 狀態依步驟推導：全部完成 → 完成；有完成的 → 進行中（使用者指定的審核保留）。
fn derive_status(requested: TaskStatus, steps: &[StepInput]) -> TaskStatus {
    if !steps.is_empty() && steps.iter().all(|s| s.done) {
        return TaskStatus::Done;
    }
    if requested == TaskStatus::Done && !steps.is_empty() {
        return TaskStatus::Doing;
    }
    if requested == TaskStatus::Todo && steps.iter().any(|s| s.done) {
        return TaskStatus::Doing;
    }
    requested
}

/// 寫入任務（新增或整筆更新；步驟清單整體替換，保留既有步驟的完成時間）。
pub fn write_task(
    doc: &mut AutoCommit,
    id: &str,
    input: &TaskInput,
    me: &MemberId,
    now: Timestamp,
    step_id: &mut dyn FnMut() -> Result<String>,
) -> Result<()> {
    validate(input)?;
    let key = format!("{TASK_PREFIX}{id}");
    let (t, old_steps) = match get_obj(doc, &ROOT, &key) {
        Some(t) => {
            let old = read_steps(doc, &t);
            (t, old)
        }
        None => {
            let t = doc.put_object(ROOT, key.as_str(), ObjType::Map)?;
            doc.put(&t, "createdBy", me.to_string().as_str())?;
            doc.put(&t, "createdAt", now)?;
            (t, vec![])
        }
    };
    doc.put(&t, "title", input.title.trim())?;
    // 負責人改變時記下指派者與時間（D50）
    if member(doc, &t, "assignee") != input.assignee {
        match input.assignee {
            Some(_) => {
                doc.put(&t, "assignedBy", me.to_string().as_str())?;
                doc.put(&t, "assignedAt", now)?;
            }
            None => {
                for k in ["assignedBy", "assignedAt"] {
                    if doc.get(&t, k)?.is_some() {
                        doc.delete(&t, k)?;
                    }
                }
            }
        }
    }
    put_opt_member(doc, &t, "assignee", input.assignee.as_ref())?;
    match input.team_goal_id.as_deref().filter(|s| !s.is_empty()) {
        Some(g) => doc.put(&t, "teamGoalId", g)?,
        None => {
            if doc.get(&t, "teamGoalId")?.is_some() {
                doc.delete(&t, "teamGoalId")?;
            }
        }
    }
    let status = derive_status(input.status.unwrap_or_default(), &input.steps);
    doc.put(&t, "status", status.as_str())?;
    put_done_at(doc, &t, status, now)?;
    match input.due_at {
        Some(d) => doc.put(&t, "dueAt", d)?,
        None => {
            if doc.get(&t, "dueAt")?.is_some() {
                doc.delete(&t, "dueAt")?;
            }
        }
    }
    match input.plan_item_id.as_deref().filter(|s| !s.is_empty()) {
        Some(p) => doc.put(&t, "planItemId", p)?,
        None => {
            if doc.get(&t, "planItemId")?.is_some() {
                doc.delete(&t, "planItemId")?;
            }
        }
    }
    let list = doc.put_object(&t, "steps", ObjType::List)?;
    for (i, s) in input.steps.iter().enumerate() {
        let sid = match &s.id {
            Some(x) if !x.is_empty() => x.clone(),
            _ => step_id()?,
        };
        let prev = old_steps.iter().find(|o| o.id == sid);
        let m = doc.insert_object(&list, i, ObjType::Map)?;
        doc.put(&m, "id", sid.as_str())?;
        doc.put(&m, "title", s.title.trim())?;
        put_opt_member(doc, &m, "assignee", s.assignee.as_ref())?;
        doc.put(&m, "done", s.done)?;
        if s.done {
            let at = prev.and_then(|p| p.done_at).unwrap_or(now);
            doc.put(&m, "doneAt", at)?;
        }
        let estimate = match s.estimate {
            Some(0) => None,
            Some(e) => Some(e),
            None => prev.and_then(|p| p.estimate),
        };
        if let Some(e) = estimate {
            doc.put(&m, "estimate", i64::from(e))?;
        }
    }
    match input.estimate {
        Some(0) => {
            if doc.get(&t, "estimate")?.is_some() {
                doc.delete(&t, "estimate")?;
            }
        }
        Some(e) => doc.put(&t, "estimate", i64::from(e))?,
        None => {}
    }
    if let Some(b) = input.brief.as_deref().map(str::trim) {
        if b.is_empty() {
            if doc.get(&t, "brief")?.is_some() {
                doc.delete(&t, "brief")?;
            }
        } else {
            doc.put(&t, "brief", b)?;
        }
    }
    if let Some(acceptance) = &input.acceptance {
        if acceptance.is_empty() {
            if doc.get(&t, "acceptance")?.is_some() {
                doc.delete(&t, "acceptance")?;
            }
        } else {
            let mut list = Vec::with_capacity(acceptance.len());
            for c in acceptance {
                let id = match &c.id {
                    Some(x) if !x.is_empty() => x.clone(),
                    _ => step_id()?,
                };
                list.push(Criterion {
                    id,
                    text: c.text.trim().to_owned(),
                });
            }
            doc.put(&t, "acceptance", serde_json::to_string(&list)?)?;
        }
    }
    doc.put(&t, "updatedAt", now)?;
    Ok(())
}

/// 勾選或取消一個步驟（只改該步驟，不替換清單，兩人同時勾選不同步驟時都保留）。
pub fn set_step_done(
    doc: &mut AutoCommit,
    task: &str,
    step: &str,
    done: bool,
    now: Timestamp,
) -> Result<()> {
    let t = get_obj(doc, &ROOT, &format!("{TASK_PREFIX}{task}"))
        .ok_or_else(|| anyhow!("找不到任務"))?;
    let list = get_obj(doc, &t, "steps").ok_or_else(|| anyhow!("任務沒有步驟"))?;
    let mut found = false;
    for i in 0..doc.length(&list) {
        let Some((automerge::Value::Object(_), s)) = doc.get(&list, i)? else {
            continue;
        };
        if get_str(doc, &s, "id").as_deref() == Some(step) {
            doc.put(&s, "done", done)?;
            if done {
                doc.put(&s, "doneAt", now)?;
            } else if doc.get(&s, "doneAt")?.is_some() {
                doc.delete(&s, "doneAt")?;
            }
            found = true;
        }
    }
    if !found {
        bail!("找不到步驟");
    }
    let steps = read_steps(doc, &t);
    let status = if steps.iter().all(|s| s.done) {
        TaskStatus::Done
    } else {
        match TaskStatus::parse(&get_str(doc, &t, "status").unwrap_or_default()) {
            TaskStatus::Done | TaskStatus::Todo if steps.iter().any(|s| s.done) => {
                TaskStatus::Doing
            }
            TaskStatus::Done => TaskStatus::Todo,
            s => s,
        }
    };
    doc.put(&t, "status", status.as_str())?;
    put_done_at(doc, &t, status, now)?;
    doc.put(&t, "updatedAt", now)?;
    Ok(())
}

pub fn delete_task(doc: &mut AutoCommit, task: &str) -> R<()> {
    let key = format!("{TASK_PREFIX}{task}");
    if doc.get(ROOT, key.as_str())?.is_some() {
        doc.delete(ROOT, key.as_str())?;
    }
    Ok(())
}

pub fn put_profile(doc: &mut AutoCommit, me: &MemberId, look: &Look) -> Result<()> {
    doc.put(
        ROOT,
        format!("{PROFILE_PREFIX}{me}").as_str(),
        serde_json::to_string(look)?,
    )?;
    Ok(())
}

pub fn read_profiles(doc: &AutoCommit) -> BTreeMap<MemberId, Look> {
    doc.keys(ROOT)
        .filter_map(|k| {
            let m = MemberId::parse(k.strip_prefix(PROFILE_PREFIX)?).ok()?;
            let raw = get_str(doc, &ROOT, &k)?;
            let look: Look = serde_json::from_str(&raw).ok()?;
            Some((m, look.normalized()))
        })
        .collect()
}

// ---------- 焦點（feature-plan §5.4、technical-design §16.8） ----------

fn concerns_me(t: &Task, me: &MemberId) -> bool {
    t.status != TaskStatus::Done
        && (t.assignee.as_ref() == Some(me)
            || t.next_step().and_then(|s| s.assignee.as_ref()) == Some(me))
}

/// 我負責、尚未完成的步驟後面還有別人負責的步驟（我卡住別人）。
fn blocks_others(t: &Task, me: &MemberId) -> bool {
    let mut mine_pending = false;
    for s in &t.steps {
        if s.done {
            continue;
        }
        match s.assignee.as_ref() {
            Some(a) if a == me => mine_pending = true,
            Some(_) if mine_pending => return true,
            _ => {}
        }
    }
    false
}

/// 自動選出焦點任務：期限最近 → 卡住別人 → 指派給我 → 建立時間。
pub fn pick_focus<'a>(tasks: &'a [Task], me: &MemberId) -> Option<&'a Task> {
    tasks.iter().filter(|t| concerns_me(t, me)).min_by_key(|t| {
        (
            t.due_at.unwrap_or(i64::MAX),
            !blocks_others(t, me),
            t.assignee.as_ref() != Some(me),
            t.created_at,
            t.id.clone(),
        )
    })
}

/// 首頁的焦點：手動選擇（仍未完成時）優先，否則自動。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Focus {
    pub task: Option<Task>,
    pub manual: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct FocusChoice {
    team: String,
    task: String,
}

// ---------- Node API ----------

pub(crate) fn team_doc(team: &str) -> String {
    format!("team/{team}")
}

fn private_tasks_doc(owner: &MemberId) -> String {
    format!("member/{owner}/tasks")
}

impl Node {
    pub(crate) fn my_teams(&self) -> Vec<String> {
        self.org().teams_of(&self.member_id())
    }

    pub(crate) fn ensure_my_team(&self, team: &str) -> Result<()> {
        if team == PRIVATE_TEAM {
            return Ok(());
        }
        if !self.my_teams().iter().any(|t| t == team) {
            bail!("你不是這個小組的成員");
        }
        Ok(())
    }

    /// 任務所在的文件：小組任務 `team/<id>`，私人任務 `member/<me>/tasks`。
    pub(crate) fn task_doc(&self, team: &str) -> String {
        if team == PRIVATE_TEAM {
            private_tasks_doc(&self.member_id())
        } else {
            team_doc(team)
        }
    }

    /// 我所屬各小組的任務，加上我的私人任務。
    pub fn tasks(&self) -> Result<Vec<Task>> {
        let mut out = Vec::new();
        for team in self.my_teams() {
            out.extend(self.read_doc(&team_doc(&team), |d| read_tasks(d, &team))?);
        }
        out.extend(self.read_doc(&self.task_doc(PRIVATE_TEAM), |d| {
            read_tasks(d, PRIVATE_TEAM)
        })?);
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        Ok(out)
    }

    /// 檢查並整理輸入：週目標須存在於我可讀的計劃且為週層級；私人任務負責人固定為我、步驟無負責人。
    fn prepare_task(&self, team: &str, mut input: TaskInput) -> Result<TaskInput> {
        if let Some(p) = input.plan_item_id.as_deref().filter(|s| !s.is_empty()) {
            let ok = self
                .plans(crate::plans::PlanQuery::Visible)?
                .iter()
                .any(|i| i.id == p && i.level == crate::plans::PlanLevel::Week);
            if !ok {
                bail!("找不到這個週目標");
            }
        }
        if team == PRIVATE_TEAM {
            input.assignee = Some(self.member_id());
            input.team_goal_id = None;
            for s in &mut input.steps {
                s.assignee = None;
            }
        }
        if let Some(g) = input.team_goal_id.as_deref().filter(|s| !s.is_empty())
            && !self
                .team_goals()?
                .iter()
                .any(|x| x.id == g && x.team == team)
        {
            bail!("找不到這個小組目標");
        }
        Ok(input)
    }

    /// 負責人回應指派（D50）：接下或有困難（附原因）。只有目前負責人可回應。
    pub async fn set_task_ack(
        &self,
        team: &str,
        task: &str,
        state: AckState,
        note: Option<String>,
    ) -> Result<()> {
        if team == PRIVATE_TEAM {
            bail!("私人任務不需要回應");
        }
        self.ensure_my_team(team)?;
        let me = self.member_id();
        let t = self
            .read_doc(&team_doc(team), |d| read_tasks(d, team))?
            .into_iter()
            .find(|x| x.id == task)
            .ok_or_else(|| anyhow!("找不到任務"))?;
        if t.assignee != Some(me) {
            bail!("只有負責人可以回應");
        }
        let note = note.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty());
        if state == AckState::Concern && note.is_none() {
            bail!("請說明遇到的困難");
        }
        if note
            .as_ref()
            .is_some_and(|n| n.chars().count() > MAX_ACK_NOTE)
        {
            bail!("說明最多 {MAX_ACK_NOTE} 字");
        }
        let ack = Ack {
            state,
            note,
            at: now_ms().max(t.assigned_at.unwrap_or(0)),
        };
        self.change(&team_doc(team), |doc| put_ack(doc, task, &me, &ack))
            .await
    }

    pub async fn create_task(&self, team: &str, input: TaskInput) -> Result<String> {
        self.ensure_my_team(team)?;
        let input = self.prepare_task(team, input)?;
        let now = now_ms();
        let id = crate::conv::ulid(now)?;
        let me = self.member_id();
        self.change(&self.task_doc(team), |doc| {
            write_task(doc, &id, &input, &me, now, &mut || crate::conv::ulid(now))
        })
        .await?;
        Ok(id)
    }

    pub async fn update_task(&self, team: &str, task: &str, input: TaskInput) -> Result<()> {
        self.ensure_my_team(team)?;
        let input = self.prepare_task(team, input)?;
        let exists = self.read_doc(&self.task_doc(team), |d| {
            d.get(ROOT, format!("{TASK_PREFIX}{task}").as_str())
                .ok()
                .flatten()
                .is_some()
        })?;
        if !exists {
            bail!("找不到任務");
        }
        let now = now_ms();
        let me = self.member_id();
        self.change(&self.task_doc(team), |doc| {
            write_task(doc, task, &input, &me, now, &mut || crate::conv::ulid(now))
        })
        .await
    }

    pub async fn set_step_done(
        &self,
        team: &str,
        task: &str,
        step: &str,
        done: bool,
    ) -> Result<()> {
        self.ensure_my_team(team)?;
        let now = now_ms();
        let me = self.member_id();
        let log_id = crate::conv::ulid(now)?;
        self.change(&self.task_doc(team), |doc| {
            set_step_done(doc, task, step, done, now)?;
            if !done {
                return Ok(());
            }
            // 步驟完成寫一筆紀錄（§16.8 v0.34，D60）
            let title = get_obj(doc, &ROOT, &format!("{TASK_PREFIX}{task}"))
                .map(|t| read_steps(doc, &t))
                .and_then(|steps| steps.into_iter().find(|s| s.id == step))
                .map(|s| s.title)
                .unwrap_or_default();
            crate::task_report::write_log(
                doc,
                task,
                &log_id,
                &me,
                crate::task_report::LogEntry {
                    kind: crate::task_report::LogKind::Step,
                    text: &title,
                    percent: None,
                    refs: vec![step.to_owned()],
                    at: now,
                },
            )
        })
        .await
    }

    pub async fn delete_task(&self, team: &str, task: &str) -> Result<()> {
        self.ensure_my_team(team)?;
        self.change(&self.task_doc(team), |doc| Ok(delete_task(doc, task)?))
            .await
    }

    /// 各成員的角色外觀（任一份小組文件中的設定）。
    pub fn profiles(&self) -> Result<BTreeMap<MemberId, Look>> {
        let mut out = BTreeMap::new();
        for team in self.my_teams() {
            for (m, l) in self.read_doc(&team_doc(&team), read_profiles)? {
                out.entry(m).or_insert(l);
            }
        }
        Ok(out)
    }

    /// 設定自己的外觀，寫入自己所屬的每個小組文件。
    pub async fn set_profile(&self, look: Look) -> Result<()> {
        if !look.is_valid() {
            bail!("外觀選項無效");
        }
        let me = self.member_id();
        let teams = self.my_teams();
        if teams.is_empty() {
            bail!("尚未加入任何小組");
        }
        for team in teams {
            self.change(&team_doc(&team), |doc| put_profile(doc, &me, &look))
                .await?;
        }
        Ok(())
    }

    fn focus_choice(&self) -> Option<FocusChoice> {
        let store = &self.inner.store;
        store
            .read_secret_file(FOCUS_FILE)
            .ok()
            .flatten()
            .and_then(|raw| postcard::from_bytes(&raw).ok())
    }

    /// 首頁焦點（手動選擇只存在本機）。
    pub fn focus(&self) -> Result<Focus> {
        let tasks = self.tasks()?;
        let me = self.member_id();
        if let Some(c) = self.focus_choice()
            && let Some(t) = tasks
                .iter()
                .find(|t| t.team == c.team && t.id == c.task && t.status != TaskStatus::Done)
        {
            return Ok(Focus {
                task: Some(t.clone()),
                manual: true,
            });
        }
        Ok(Focus {
            task: pick_focus(&tasks, &me).cloned(),
            manual: false,
        })
    }

    /// 手動選擇焦點；`None` 回到自動。
    pub fn set_focus(&self, choice: Option<(&str, &str)>) -> Result<()> {
        let store = &self.inner.store;
        let c = choice
            .map(|(team, task)| FocusChoice {
                team: team.to_owned(),
                task: task.to_owned(),
            })
            .unwrap_or_default();
        store.write_secret_file(FOCUS_FILE, &postcard::to_allocvec(&c)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: MemberId = MemberId([1; 16]);
    const B: MemberId = MemberId([2; 16]);

    fn ids() -> impl FnMut() -> Result<String> {
        let mut n = 0;
        move || {
            n += 1;
            Ok(format!("s{n}"))
        }
    }

    fn step(title: &str, who: Option<MemberId>) -> StepInput {
        StepInput {
            id: None,
            title: title.into(),
            assignee: who,
            done: false,
            estimate: None,
        }
    }

    #[test]
    fn plan_link_and_progress() {
        // D46：任務連結週目標，可清除；進度依步驟比例
        let mut doc = AutoCommit::new();
        let mut input = TaskInput {
            plan_item_id: Some("w1".into()),
            title: "壓力測試".into(),
            ..Default::default()
        };
        write_task(&mut doc, "t", &input, &A, 1, &mut ids()).unwrap();
        let t = &read_tasks(&doc, PRIVATE_TEAM)[0];
        assert_eq!(t.plan_item_id.as_deref(), Some("w1"));
        assert!(t.is_private());
        assert_eq!(t.progress(), 0.0);
        input.plan_item_id = None;
        input.status = Some(TaskStatus::Done);
        write_task(&mut doc, "t", &input, &A, 2, &mut ids()).unwrap();
        let t = &read_tasks(&doc, "g")[0];
        assert_eq!(t.plan_item_id, None);
        assert_eq!(t.progress(), 100.0, "沒有步驟：完成 = 100");
        let t = task(
            "x",
            None,
            None,
            vec![
                s("a", None, true),
                s("b", None, false),
                s("c", None, false),
                s("d", None, true),
            ],
        );
        assert_eq!(t.progress(), 50.0);
    }

    #[test]
    fn task_done_at() {
        let mut doc = AutoCommit::new();
        let mut input = TaskInput {
            title: "寫週報".into(),
            ..Default::default()
        };
        write_task(&mut doc, "t", &input, &A, 10, &mut ids()).unwrap();
        assert_eq!(read_tasks(&doc, "g")[0].done_at, None);
        input.status = Some(TaskStatus::Done);
        write_task(&mut doc, "t", &input, &A, 20, &mut ids()).unwrap();
        assert_eq!(read_tasks(&doc, "g")[0].done_at, Some(20));
        // 再次儲存仍是完成：保留原本的完成時間
        input.title = "寫週報（改）".into();
        write_task(&mut doc, "t", &input, &A, 30, &mut ids()).unwrap();
        assert_eq!(read_tasks(&doc, "g")[0].done_at, Some(20));
        input.status = Some(TaskStatus::Todo);
        write_task(&mut doc, "t", &input, &A, 40, &mut ids()).unwrap();
        assert_eq!(read_tasks(&doc, "g")[0].done_at, None);
        // 步驟全部勾完 → 任務完成時間 = 最後一步
        input.steps = vec![step("a", None)];
        write_task(&mut doc, "t", &input, &A, 50, &mut ids()).unwrap();
        set_step_done(&mut doc, "t", "s1", true, 60).unwrap();
        assert_eq!(read_tasks(&doc, "g")[0].done_at, Some(60));
        set_step_done(&mut doc, "t", "s1", false, 70).unwrap();
        assert_eq!(read_tasks(&doc, "g")[0].done_at, None);
    }

    #[test]
    fn task_roundtrip_and_steps() {
        let mut doc = AutoCommit::new();
        let input = TaskInput {
            plan_item_id: None,
            team_goal_id: None,
            brief: None,
            acceptance: None,
            estimate: None,
            title: " Windows 驗收 ".into(),
            assignee: Some(B),
            status: None,
            due_at: Some(1400),
            steps: vec![
                step("Mac 驗收", Some(B)),
                step("relay 更新", Some(A)),
                step("通知測試", Some(B)),
            ],
        };
        write_task(&mut doc, "t1", &input, &A, 10, &mut ids()).unwrap();
        let t = &read_tasks(&doc, "general")[0];
        assert_eq!(t.title, "Windows 驗收");
        assert_eq!(t.steps.len(), 3);
        assert_eq!(t.steps[1].id, "s2");
        assert_eq!(t.status, TaskStatus::Todo);
        assert_eq!(t.created_by, Some(A));

        set_step_done(&mut doc, "t1", "s1", true, 20).unwrap();
        let t = &read_tasks(&doc, "general")[0];
        assert!(t.steps[0].done && t.steps[0].done_at == Some(20));
        assert_eq!(t.done_at, None);
        assert_eq!(t.status, TaskStatus::Doing);
        assert_eq!(t.next_step().unwrap().id, "s2");

        // 編輯：保留既有步驟的完成時間，新增一步
        let mut edit = TaskInput {
            plan_item_id: None,
            team_goal_id: None,
            brief: None,
            acceptance: None,
            estimate: None,
            title: "Windows 驗收".into(),
            assignee: Some(B),
            status: Some(TaskStatus::Doing),
            due_at: None,
            steps: t
                .steps
                .iter()
                .map(|s| StepInput {
                    id: Some(s.id.clone()),
                    title: s.title.clone(),
                    assignee: s.assignee,
                    done: s.done,
                    estimate: None,
                })
                .collect(),
        };
        edit.steps.push(step("簽核", Some(B)));
        write_task(&mut doc, "t1", &edit, &A, 30, &mut ids()).unwrap();
        let t = &read_tasks(&doc, "general")[0];
        assert_eq!(t.steps.len(), 4);
        assert_eq!(t.steps[0].done_at, Some(20));
        assert_eq!(t.due_at, None);
        for s in ["s2", "s3"] {
            set_step_done(&mut doc, "t1", s, true, 40).unwrap();
        }
        let last = read_tasks(&doc, "general")[0].steps[3].id.clone();
        set_step_done(&mut doc, "t1", &last, true, 50).unwrap();
        assert_eq!(read_tasks(&doc, "general")[0].status, TaskStatus::Done);
        set_step_done(&mut doc, "t1", &last, false, 60).unwrap();
        assert_eq!(read_tasks(&doc, "general")[0].status, TaskStatus::Doing);
        delete_task(&mut doc, "t1").unwrap();
        assert!(read_tasks(&doc, "general").is_empty());
    }

    #[test]
    fn brief_and_acceptance_kept_unless_given() {
        let mut doc = AutoCommit::new();
        let mut input = TaskInput {
            title: "交付".into(),
            brief: Some("## 背景\n說明".into()),
            acceptance: Some(vec![CriterionInput {
                id: None,
                text: "通過測試".into(),
            }]),
            ..Default::default()
        };
        write_task(&mut doc, "t", &input, &A, 1, &mut ids()).unwrap();
        let t = read_tasks(&doc, "g").pop().unwrap();
        assert_eq!(t.brief.as_deref(), Some("## 背景\n說明"));
        assert_eq!(t.acceptance.len(), 1);
        let cid = t.acceptance[0].id.clone();
        // 其他畫面只改標題：不傳 brief / acceptance → 保留
        input.title = "交付 v2".into();
        input.brief = None;
        input.acceptance = None;
        write_task(&mut doc, "t", &input, &A, 2, &mut ids()).unwrap();
        let t = read_tasks(&doc, "g").pop().unwrap();
        assert_eq!(t.acceptance[0].id, cid);
        assert!(t.brief.is_some());
        // 空字串與空清單 → 清除
        input.brief = Some("  ".into());
        input.acceptance = Some(vec![]);
        write_task(&mut doc, "t", &input, &A, 3, &mut ids()).unwrap();
        let t = read_tasks(&doc, "g").pop().unwrap();
        assert!(t.brief.is_none() && t.acceptance.is_empty());
        // 上限
        input.acceptance = Some(
            (0..21)
                .map(|i| CriterionInput {
                    id: None,
                    text: format!("c{i}"),
                })
                .collect(),
        );
        assert!(write_task(&mut doc, "t", &input, &A, 4, &mut ids()).is_err());
    }

    #[test]
    fn concurrent_step_ticks_merge() {
        let mut a = AutoCommit::new();
        let input = TaskInput {
            plan_item_id: None,
            title: "x".into(),
            steps: vec![step("1", None), step("2", None)],
            ..Default::default()
        };
        write_task(&mut a, "t", &input, &A, 1, &mut ids()).unwrap();
        let mut b = a.fork();
        set_step_done(&mut a, "t", "s1", true, 2).unwrap();
        set_step_done(&mut b, "t", "s2", true, 3).unwrap();
        a.merge(&mut b).unwrap();
        assert!(read_tasks(&a, "g")[0].steps.iter().all(|s| s.done));
    }

    #[test]
    fn validation() {
        let mut doc = AutoCommit::new();
        let bad = TaskInput {
            plan_item_id: None,
            title: "  ".into(),
            ..Default::default()
        };
        assert!(write_task(&mut doc, "t", &bad, &A, 1, &mut ids()).is_err());
        let too_many = TaskInput {
            plan_item_id: None,
            title: "x".into(),
            steps: (0..31).map(|i| step(&i.to_string(), None)).collect(),
            ..Default::default()
        };
        assert!(write_task(&mut doc, "t", &too_many, &A, 1, &mut ids()).is_err());
    }

    fn task(id: &str, due: Option<i64>, assignee: Option<MemberId>, steps: Vec<TaskStep>) -> Task {
        Task {
            id: id.into(),
            team: "g".into(),
            title: id.into(),
            assignee,
            status: TaskStatus::Todo,
            due_at: due,
            done_at: None,
            steps,
            plan_item_id: None,
            created_by: None,
            created_at: 0,
            updated_at: 0,
            assigned_by: None,
            assigned_at: None,
            team_goal_id: None,
            ack: None,
            brief: None,
            acceptance: vec![],
            estimate: None,
            reported: None,
            blocked: None,
        }
    }

    #[test]
    fn assignment_and_ack() {
        // D50：指派記下指派者；負責人回應；改派後舊回應失效
        let mut doc = AutoCommit::new();
        let mut input = TaskInput {
            title: "B2 設備清單比對".into(),
            assignee: Some(B),
            team_goal_id: Some("g1".into()),
            ..Default::default()
        };
        write_task(&mut doc, "t", &input, &A, 10, &mut ids()).unwrap();
        let t = &read_tasks(&doc, "g")[0];
        assert_eq!((t.assigned_by, t.assigned_at), (Some(A), Some(10)));
        assert_eq!(t.team_goal_id.as_deref(), Some("g1"));
        assert!(t.pending_ack());
        // 有困難：仍待接下
        let concern = Ack {
            state: AckState::Concern,
            note: Some("需要測試帳號".into()),
            at: 11,
        };
        put_ack(&mut doc, "t", &B, &concern).unwrap();
        let t = &read_tasks(&doc, "g")[0];
        assert_eq!(t.ack.as_ref(), Some(&concern));
        assert!(t.pending_ack());
        // 接下
        let ok = Ack {
            state: AckState::Accepted,
            note: None,
            at: 12,
        };
        put_ack(&mut doc, "t", &B, &ok).unwrap();
        assert!(!read_tasks(&doc, "g")[0].pending_ack());
        // 只改標題不影響指派
        input.title = "B2 設備清單比對（更新）".into();
        write_task(&mut doc, "t", &input, &B, 13, &mut ids()).unwrap();
        let t = &read_tasks(&doc, "g")[0];
        assert_eq!(t.assigned_at, Some(10));
        assert!(!t.pending_ack());
        // 改派給 A 自己：不需接下；B 的舊回應不算
        input.assignee = Some(A);
        write_task(&mut doc, "t", &input, &A, 14, &mut ids()).unwrap();
        let t = &read_tasks(&doc, "g")[0];
        assert_eq!(t.ack, None);
        assert!(!t.pending_ack());
        // 改回 B：舊的接下早於新的指派，失效
        input.assignee = Some(B);
        write_task(&mut doc, "t", &input, &A, 15, &mut ids()).unwrap();
        let t = &read_tasks(&doc, "g")[0];
        assert_eq!(t.ack, None);
        assert!(t.pending_ack());
        // 取消指派
        input.assignee = None;
        write_task(&mut doc, "t", &input, &A, 16, &mut ids()).unwrap();
        let t = &read_tasks(&doc, "g")[0];
        assert_eq!((t.assigned_by, t.assigned_at), (None, None));
        assert!(!t.pending_ack());
    }

    fn s(id: &str, who: Option<MemberId>, done: bool) -> TaskStep {
        TaskStep {
            id: id.into(),
            title: id.into(),
            assignee: who,
            done,
            done_at: None,
            estimate: None,
        }
    }

    #[test]
    fn focus_order() {
        let mine_late = task("late", Some(900), Some(A), vec![]);
        let mine_soon = task("soon", Some(500), Some(A), vec![]);
        let blocking = task(
            "block",
            None,
            Some(B),
            vec![s("1", Some(A), false), s("2", Some(B), false)],
        );
        let others = task("other", Some(100), Some(B), vec![s("1", Some(B), false)]);
        let mine_nodue = task("nodue", None, Some(A), vec![]);
        let mut done = task("done", Some(1), Some(A), vec![]);
        done.status = TaskStatus::Done;
        let all = vec![
            mine_late.clone(),
            blocking.clone(),
            others,
            mine_nodue.clone(),
            done,
        ];
        assert_eq!(pick_focus(&all, &A).unwrap().id, "late");
        let mut with_soon = all.clone();
        with_soon.push(mine_soon);
        assert_eq!(pick_focus(&with_soon, &A).unwrap().id, "soon");
        // 都沒期限：卡住別人的優先於只指派給我的
        let no_due = vec![mine_nodue, blocking];
        assert_eq!(pick_focus(&no_due, &A).unwrap().id, "block");
        assert!(pick_focus(&no_due, &MemberId([9; 16])).is_none());
    }

    #[test]
    fn profiles() {
        let mut doc = AutoCommit::new();
        put_profile(
            &mut doc,
            &A,
            &Look {
                kind: 2,
                hair: 1,
                shirt: 2,
                skin: 3,
            },
        )
        .unwrap();
        // 舊資料：沒有 kind、色號 0–7（v0.31 起以 6 取餘數）
        doc.put(
            ROOT,
            format!("profile:{B}").as_str(),
            "{\"hair\":7,\"shirt\":0,\"skin\":6}",
        )
        .unwrap();
        let p = read_profiles(&doc);
        assert_eq!(p.len(), 2);
        assert_eq!(p[&A].kind, 2);
        assert_eq!(p[&A].skin, 3);
        assert_eq!(
            p[&B],
            Look {
                kind: 0,
                hair: 1,
                shirt: 0,
                skin: 0
            }
        );
        let bad = Look {
            kind: 9,
            hair: 0,
            shirt: 0,
            skin: 0,
        };
        assert!(!bad.is_valid());
        assert_eq!(bad.normalized().kind, 0);
    }
}
