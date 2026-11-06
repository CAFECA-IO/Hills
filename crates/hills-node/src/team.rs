//! team 文件的任務與角色外觀（technical-design §16.8 v0.11、D40），以及首頁的焦點規則。
//!
//! 任務放在根物件的 `task:<ULID>`，外觀放在 `profile:<memberId>`（JSON 字串，驗證層限本人寫入）。

use std::collections::BTreeMap;

use anyhow::{Result, anyhow, bail};
use automerge::{AutoCommit, ObjId, ObjType, ROOT, ReadDoc, transaction::Transactable};
use hills_proto::{MemberId, Timestamp};
use serde::{Deserialize, Serialize};

use crate::node::{Node, now_ms};
use crate::org::{get_int, get_obj, get_str};

const TASK_PREFIX: &str = "task:";
const PROFILE_PREFIX: &str = "profile:";
const FOCUS_FILE: &str = "focus";
const MAX_STEPS: usize = 30;
const MAX_TITLE: usize = 200;
/// 外觀色盤的大小（前端 `look.ts` 須一致）
pub const LOOK_PALETTE: u8 = 8;

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
    pub steps: Vec<TaskStep>,
    pub created_by: Option<MemberId>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Task {
    /// 第一個未完成的步驟。
    pub fn next_step(&self) -> Option<&TaskStep> {
        self.steps.iter().find(|s| !s.done)
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
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepInput {
    pub id: Option<String>,
    pub title: String,
    pub assignee: Option<MemberId>,
    #[serde(default)]
    pub done: bool,
}

/// 角色外觀：固定色盤的索引。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Look {
    pub hair: u8,
    pub shirt: u8,
    pub skin: u8,
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
        })
        .collect()
}

pub fn read_tasks(doc: &AutoCommit, team: &str) -> Vec<Task> {
    doc.keys(ROOT)
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
                steps: read_steps(doc, &t),
                created_by: member(doc, &t, "createdBy"),
                created_at: get_int(doc, &t, "createdAt").unwrap_or(0),
                updated_at: get_int(doc, &t, "updatedAt").unwrap_or(0),
            })
        })
        .collect()
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
    put_opt_member(doc, &t, "assignee", input.assignee.as_ref())?;
    let status = derive_status(input.status.unwrap_or_default(), &input.steps);
    doc.put(&t, "status", status.as_str())?;
    match input.due_at {
        Some(d) => doc.put(&t, "dueAt", d)?,
        None => {
            if doc.get(&t, "dueAt")?.is_some() {
                doc.delete(&t, "dueAt")?;
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
            (look.hair < LOOK_PALETTE && look.shirt < LOOK_PALETTE && look.skin < LOOK_PALETTE)
                .then_some((m, look))
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

fn team_doc(team: &str) -> String {
    format!("team/{team}")
}

impl Node {
    fn my_teams(&self) -> Vec<String> {
        self.org().teams_of(&self.member_id())
    }

    fn ensure_my_team(&self, team: &str) -> Result<()> {
        if !self.my_teams().iter().any(|t| t == team) {
            bail!("你不是這個小組的成員");
        }
        Ok(())
    }

    /// 我所屬各小組的任務。
    pub fn tasks(&self) -> Result<Vec<Task>> {
        let mut out = Vec::new();
        for team in self.my_teams() {
            out.extend(self.read_doc(&team_doc(&team), |d| read_tasks(d, &team))?);
        }
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        Ok(out)
    }

    pub async fn create_task(&self, team: &str, input: TaskInput) -> Result<String> {
        self.ensure_my_team(team)?;
        let now = now_ms();
        let id = crate::conv::ulid(now)?;
        let me = self.member_id();
        self.change(&team_doc(team), |doc| {
            write_task(doc, &id, &input, &me, now, &mut || crate::conv::ulid(now))
        })
        .await?;
        Ok(id)
    }

    pub async fn update_task(&self, team: &str, task: &str, input: TaskInput) -> Result<()> {
        self.ensure_my_team(team)?;
        let exists = self.read_doc(&team_doc(team), |d| {
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
        self.change(&team_doc(team), |doc| {
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
        self.change(&team_doc(team), |doc| {
            set_step_done(doc, task, step, done, now)
        })
        .await
    }

    pub async fn delete_task(&self, team: &str, task: &str) -> Result<()> {
        self.ensure_my_team(team)?;
        self.change(&team_doc(team), |doc| Ok(delete_task(doc, task)?))
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
        if look.hair >= LOOK_PALETTE || look.shirt >= LOOK_PALETTE || look.skin >= LOOK_PALETTE {
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
        }
    }

    #[test]
    fn task_roundtrip_and_steps() {
        let mut doc = AutoCommit::new();
        let input = TaskInput {
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
        assert_eq!(t.status, TaskStatus::Doing);
        assert_eq!(t.next_step().unwrap().id, "s2");

        // 編輯：保留既有步驟的完成時間，新增一步
        let mut edit = TaskInput {
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
    fn concurrent_step_ticks_merge() {
        let mut a = AutoCommit::new();
        let input = TaskInput {
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
            title: "  ".into(),
            ..Default::default()
        };
        assert!(write_task(&mut doc, "t", &bad, &A, 1, &mut ids()).is_err());
        let too_many = TaskInput {
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
            steps,
            created_by: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn s(id: &str, who: Option<MemberId>, done: bool) -> TaskStep {
        TaskStep {
            id: id.into(),
            title: id.into(),
            assignee: who,
            done,
            done_at: None,
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
                hair: 1,
                shirt: 2,
                skin: 3,
            },
        )
        .unwrap();
        doc.put(
            ROOT,
            format!("profile:{B}").as_str(),
            "{\"hair\":99,\"shirt\":0,\"skin\":0}",
        )
        .unwrap();
        let p = read_profiles(&doc);
        assert_eq!(p.len(), 1);
        assert_eq!(p[&A].skin, 3);
    }
}
