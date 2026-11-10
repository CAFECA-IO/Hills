//! 任務執行紀錄與結案報告（technical-design §16.8 v0.29 / v0.33，D53）。
//!
//! - 紀錄：`log:<taskId>:<ULID>:<memberId>`，JSON 字串，只有作者可寫（驗證層），寫入後不修改。
//! - 報告：`report:<taskId>:<memberId>`，JSON 字串，只有負責人可寫，覆寫同一 key。
//! - 結案、退回在同一筆 change 內依序寫入（報告 → 狀態 / doneAt → 紀錄）。
//! - 私人任務的紀錄與報告存在 `member/<id>/tasks`。

use anyhow::{Result, anyhow, bail};
use automerge::{AutoCommit, ROOT, ReadDoc, transaction::Transactable};
use hills_proto::{MemberId, Timestamp};
use hills_sync::Directory;
use serde::{Deserialize, Serialize};

use crate::doc_spec::{self, DocFormat, DocKind as SpecKind};
use crate::node::{Node, now_ms};
use crate::org::{get_obj, get_str};
use crate::team::{PRIVATE_TEAM, TASK_PREFIX, Task, TaskStatus, put_done_at, read_tasks};

const LOG_PREFIX: &str = "log:";
const REPORT_PREFIX: &str = "report:";
const MAX_LOG_TEXT: usize = 4 * 1024;
const MAX_REPORT_BODY: usize = 64 * 1024;
const MAX_ATTACH_JSON: usize = 512 * 1024;
const MAX_NOTE: usize = 200;
const MAX_REFS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogKind {
    Start,
    Progress,
    Question,
    Answer,
    Close,
    Reopen,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogBody {
    kind: LogKind,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    refs: Vec<String>,
    at: Timestamp,
}

/// 一筆執行紀錄。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLog {
    pub id: String,
    pub author: MemberId,
    pub kind: LogKind,
    pub text: String,
    pub percent: Option<u8>,
    pub refs: Vec<String>,
    pub at: Timestamp,
}

/// 報告中一條完成條件的對照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriterionResult {
    pub id: String,
    pub met: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

fn v1() -> u8 {
    1
}

/// 結案報告（hills-doc/1 結案報告規格）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReport {
    #[serde(default = "v1")]
    pub v: u8,
    #[serde(default)]
    pub format: DocFormat,
    #[serde(default)]
    pub spec: String,
    pub body: String,
    #[serde(default)]
    pub criteria: Vec<CriterionResult>,
    /// §14.2 Attachment 陣列（前端上傳後產生；只存在 TK / PK 加密的文件中）
    #[serde(default = "empty_array")]
    pub attachments: serde_json::Value,
    #[serde(default)]
    pub at: Timestamp,
    /// 讀取時填入：作者
    #[serde(default, skip_deserializing)]
    pub author: Option<MemberId>,
}

fn empty_array() -> serde_json::Value {
    serde_json::Value::Array(vec![])
}

/// 結案的輸入（介面與 MCP）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseInput {
    #[serde(default)]
    pub format: DocFormat,
    pub body: String,
    #[serde(default)]
    pub criteria: Vec<CriterionResult>,
    #[serde(default = "empty_array")]
    pub attachments: serde_json::Value,
    #[serde(default)]
    pub refs: Vec<String>,
}

// ---------- 純函式 ----------

fn clean_text(text: &str, required: bool) -> Result<String> {
    let t = text.trim().to_owned();
    if required && t.is_empty() {
        bail!("請輸入內容");
    }
    if t.len() > MAX_LOG_TEXT {
        bail!("內容最多 4 KB");
    }
    Ok(t)
}

/// 紀錄內容（寫入用）。
pub struct LogEntry<'a> {
    pub kind: LogKind,
    pub text: &'a str,
    pub percent: Option<u8>,
    pub refs: Vec<String>,
    pub at: Timestamp,
}

pub fn write_log(
    doc: &mut AutoCommit,
    task: &str,
    id: &str,
    me: &MemberId,
    e: LogEntry<'_>,
) -> Result<()> {
    let body = LogBody {
        kind: e.kind,
        text: e.text.to_owned(),
        percent: e.percent,
        refs: e.refs,
        at: e.at,
    };
    doc.put(
        ROOT,
        format!("{LOG_PREFIX}{task}:{id}:{me}").as_str(),
        serde_json::to_string(&body)?,
    )?;
    Ok(())
}

/// 某任務的紀錄（依時間，再依 ULID 排序）。
pub fn read_logs(doc: &AutoCommit, task: &str) -> Vec<TaskLog> {
    let prefix = format!("{LOG_PREFIX}{task}:");
    let mut out: Vec<TaskLog> = doc
        .keys(ROOT)
        .filter_map(|k| {
            let rest = k.strip_prefix(&prefix)?;
            let (id, author) = rest.split_once(':')?;
            let author = MemberId::parse(author).ok()?;
            let raw = get_str(doc, &ROOT, &k)?;
            let b: LogBody = serde_json::from_str(&raw).ok()?;
            Some(TaskLog {
                id: id.to_owned(),
                author,
                kind: b.kind,
                text: b.text,
                percent: b.percent.filter(|p| *p <= 100),
                refs: b.refs,
                at: b.at,
            })
        })
        .collect();
    out.sort_by(|a, b| a.at.cmp(&b.at).then(a.id.cmp(&b.id)));
    out
}

pub fn write_report(doc: &mut AutoCommit, task: &str, me: &MemberId, r: &TaskReport) -> Result<()> {
    doc.put(
        ROOT,
        format!("{REPORT_PREFIX}{task}:{me}").as_str(),
        serde_json::to_string(r)?,
    )?;
    Ok(())
}

/// 報告：優先取 `prefer`（目前負責人）的那份，沒有則取最新一份。
pub fn read_report(doc: &AutoCommit, task: &str, prefer: Option<&MemberId>) -> Option<TaskReport> {
    let prefix = format!("{REPORT_PREFIX}{task}:");
    let mut all: Vec<TaskReport> = doc
        .keys(ROOT)
        .filter_map(|k| {
            let author = MemberId::parse(k.strip_prefix(&prefix)?).ok()?;
            let raw = get_str(doc, &ROOT, &k)?;
            let mut r: TaskReport = serde_json::from_str(&raw).ok()?;
            r.author = Some(author);
            Some(r)
        })
        .collect();
    if let Some(p) = prefer
        && let Some(i) = all.iter().position(|r| r.author.as_ref() == Some(p))
    {
        return Some(all.swap_remove(i));
    }
    all.sort_by_key(|r| r.at);
    all.pop()
}

/// 檢查報告：規格段落、大小、完成條件對照、HTML 安全。
pub fn validate_report(task: &Task, input: &CloseInput) -> Result<()> {
    if input.body.len() > MAX_REPORT_BODY {
        bail!("報告最多 64 KB");
    }
    let kind = SpecKind::Report {
        criteria: !task.acceptance.is_empty(),
    };
    doc_spec::check(Some(doc_spec::SPEC_V1), kind, input.format, &input.body)?;
    if input.format == DocFormat::Html && crate::kb::has_active_html(&input.body) {
        bail!("HTML 含有不允許的內容（腳本或事件）");
    }
    for c in &input.criteria {
        if !task.acceptance.iter().any(|a| a.id == c.id) {
            bail!("找不到完成條件 {}", c.id);
        }
        if c.note
            .as_ref()
            .is_some_and(|n| n.chars().count() > MAX_NOTE)
        {
            bail!("備註最多 {MAX_NOTE} 字");
        }
    }
    if !input.attachments.is_array() {
        bail!("附件格式錯誤");
    }
    if serde_json::to_string(&input.attachments)?.len() > MAX_ATTACH_JSON {
        bail!("附件資料過大");
    }
    if input.refs.len() > MAX_REFS {
        bail!("產出的知識最多 {MAX_REFS} 則");
    }
    Ok(())
}

/// 結案：報告 → 狀態完成 / doneAt → close 紀錄（同一筆 change）。
pub fn close_in_doc(
    doc: &mut AutoCommit,
    task: &str,
    me: &MemberId,
    report: &TaskReport,
    log_id: &str,
    refs: Vec<String>,
    now: Timestamp,
) -> Result<()> {
    let t = get_obj(doc, &ROOT, &format!("{TASK_PREFIX}{task}"))
        .ok_or_else(|| anyhow!("找不到任務"))?;
    write_report(doc, task, me, report)?;
    doc.put(&t, "status", "done")?;
    put_done_at(doc, &t, TaskStatus::Done, now)?;
    doc.put(&t, "updatedAt", now)?;
    write_log(
        doc,
        task,
        log_id,
        me,
        LogEntry {
            kind: LogKind::Close,
            text: "",
            percent: None,
            refs,
            at: now,
        },
    )
}

/// 退回：狀態改回進行中、刪除 doneAt、reopen 紀錄（同一筆 change）。
pub fn reopen_in_doc(
    doc: &mut AutoCommit,
    task: &str,
    me: &MemberId,
    text: &str,
    log_id: &str,
    now: Timestamp,
) -> Result<()> {
    let t = get_obj(doc, &ROOT, &format!("{TASK_PREFIX}{task}"))
        .ok_or_else(|| anyhow!("找不到任務"))?;
    doc.put(&t, "status", "doing")?;
    put_done_at(doc, &t, TaskStatus::Doing, now)?;
    doc.put(&t, "updatedAt", now)?;
    write_log(
        doc,
        task,
        log_id,
        me,
        LogEntry {
            kind: LogKind::Reopen,
            text,
            percent: None,
            refs: vec![],
            at: now,
        },
    )
}

// ---------- Node API ----------

impl Node {
    fn find_task(&self, team: &str, task: &str) -> Result<Task> {
        self.ensure_my_team(team)?;
        self.read_doc(&self.task_doc(team), |d| read_tasks(d, team))?
            .into_iter()
            .find(|x| x.id == task)
            .ok_or_else(|| anyhow!("找不到任務"))
    }

    /// 私人任務：負責人永遠是我。
    fn is_assignee(&self, t: &Task) -> bool {
        t.team == PRIVATE_TEAM || t.assignee == Some(self.member_id())
    }

    pub fn task_logs(&self, team: &str, task: &str) -> Result<Vec<TaskLog>> {
        self.ensure_my_team(team)?;
        self.read_doc(&self.task_doc(team), |d| read_logs(d, task))
    }

    pub fn task_report(&self, team: &str, task: &str) -> Result<Option<TaskReport>> {
        let t = self.find_task(team, task)?;
        self.read_doc(&self.task_doc(team), |d| {
            read_report(d, task, t.assignee.as_ref())
        })
    }

    /// 寫一筆紀錄。start / progress / question：負責人；answer：小組成員（私人任務不提供）。
    pub async fn add_task_log(
        &self,
        team: &str,
        task: &str,
        kind: LogKind,
        text: &str,
        percent: Option<u8>,
    ) -> Result<()> {
        let t = self.find_task(team, task)?;
        match kind {
            LogKind::Start | LogKind::Progress | LogKind::Question => {
                if !self.is_assignee(&t) {
                    bail!("只有負責人可以回報");
                }
                if kind == LogKind::Question && t.team == PRIVATE_TEAM {
                    bail!("私人任務不能提出問題");
                }
            }
            LogKind::Answer => {
                if t.team == PRIVATE_TEAM {
                    bail!("私人任務不能回覆");
                }
            }
            LogKind::Close | LogKind::Reopen => bail!("請使用結案或退回"),
        }
        if percent.is_some_and(|p| p > 100) {
            bail!("百分比需為 0–100");
        }
        let text = clean_text(text, kind != LogKind::Start)?;
        let now = now_ms();
        let id = crate::conv::ulid(now)?;
        let me = self.member_id();
        self.change(&self.task_doc(team), |doc| {
            write_log(
                doc,
                task,
                &id,
                &me,
                LogEntry {
                    kind,
                    text: &text,
                    percent,
                    refs: vec![],
                    at: now,
                },
            )
        })
        .await
    }

    /// 結案（D53）：只有負責人；報告須符合 hills-doc/1 結案報告規格。
    pub async fn close_task(&self, team: &str, task: &str, input: CloseInput) -> Result<()> {
        let t = self.find_task(team, task)?;
        if !self.is_assignee(&t) {
            bail!("只有負責人可以結案");
        }
        validate_report(&t, &input)?;
        let now = now_ms();
        let report = TaskReport {
            v: 1,
            format: input.format,
            spec: doc_spec::SPEC_V1.into(),
            body: input.body,
            criteria: input.criteria,
            attachments: input.attachments,
            at: now,
            author: None,
        };
        let id = crate::conv::ulid(now)?;
        let me = self.member_id();
        self.change(&self.task_doc(team), |doc| {
            close_in_doc(doc, task, &me, &report, &id, input.refs, now)
        })
        .await
    }

    /// 退回（D53）：指派者、負責人或小組負責人；意見必填。私人任務不能退回。
    pub async fn reopen_task(&self, team: &str, task: &str, text: &str) -> Result<()> {
        let t = self.find_task(team, task)?;
        if t.team == PRIVATE_TEAM {
            bail!("私人任務不能退回");
        }
        if t.status != TaskStatus::Done {
            bail!("任務尚未結案");
        }
        let me = self.member_id();
        let allowed = t.assignee == Some(me)
            || t.assigned_by == Some(me)
            || self.org().is_team_lead(team, &me);
        if !allowed {
            bail!("只有指派者、負責人或小組負責人可以退回");
        }
        let text = clean_text(text, true)?;
        let now = now_ms();
        let id = crate::conv::ulid(now)?;
        self.change(&self.task_doc(team), |doc| {
            reopen_in_doc(doc, task, &me, &text, &id, now)
        })
        .await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::team::{Criterion, TaskInput, write_task};

    const A: MemberId = MemberId([1; 16]);
    const B: MemberId = MemberId([2; 16]);

    fn doc_with_task(acceptance: Vec<Criterion>) -> (AutoCommit, Task) {
        let mut doc = AutoCommit::new();
        let input = TaskInput {
            title: "驗收".into(),
            assignee: Some(A),
            acceptance: Some(
                acceptance
                    .iter()
                    .map(|c| crate::team::CriterionInput {
                        id: Some(c.id.clone()),
                        text: c.text.clone(),
                    })
                    .collect(),
            ),
            ..Default::default()
        };
        let mut n = 0;
        write_task(&mut doc, "t1", &input, &A, 10, &mut || {
            n += 1;
            Ok(format!("s{n}"))
        })
        .unwrap();
        let t = read_tasks(&doc, "team1").pop().unwrap();
        (doc, t)
    }

    fn close(body: &str) -> CloseInput {
        CloseInput {
            format: DocFormat::Markdown,
            body: body.into(),
            criteria: vec![],
            attachments: empty_array(),
            refs: vec![],
        }
    }

    #[test]
    fn close_and_reopen_roundtrip() {
        let (mut doc, t) = doc_with_task(vec![]);
        let input = close("## 結果摘要 {#summary}\n完成了");
        validate_report(&t, &input).unwrap();
        let report = TaskReport {
            v: 1,
            format: input.format,
            spec: doc_spec::SPEC_V1.into(),
            body: input.body.clone(),
            criteria: vec![],
            attachments: serde_json::json!([{"type": "file"}]),
            at: 20,
            author: None,
        };
        close_in_doc(&mut doc, "t1", &A, &report, "L1", vec![], 20).unwrap();
        let t = read_tasks(&doc, "team1").pop().unwrap();
        assert_eq!(t.status, TaskStatus::Done);
        assert_eq!(t.done_at, Some(20));
        let r = read_report(&doc, "t1", Some(&A)).unwrap();
        assert_eq!(r.author, Some(A));
        assert_eq!(r.attachments.as_array().unwrap().len(), 1);
        reopen_in_doc(&mut doc, "t1", &B, "請補測試結果", "L2", 30).unwrap();
        let t = read_tasks(&doc, "team1").pop().unwrap();
        assert_eq!(t.status, TaskStatus::Doing);
        assert_eq!(t.done_at, None);
        let logs = read_logs(&doc, "t1");
        assert_eq!(
            logs.iter().map(|l| l.kind).collect::<Vec<_>>(),
            vec![LogKind::Close, LogKind::Reopen]
        );
        assert_eq!(logs[1].author, B);
        // 報告保留
        assert!(read_report(&doc, "t1", Some(&A)).is_some());
    }

    #[test]
    fn report_validation() {
        let crit = vec![Criterion {
            id: "c1".into(),
            text: "通過測試".into(),
        }];
        let (_, t) = doc_with_task(crit);
        // 有完成條件時需要 criteria 段落
        assert!(validate_report(&t, &close("## 結果摘要 {#summary}\n好")).is_err());
        let ok = close("## 結果摘要 {#summary}\n好\n\n## 完成條件對照 {#criteria}\n- 通過");
        validate_report(&t, &ok).unwrap();
        let unknown = CloseInput {
            criteria: vec![CriterionResult {
                id: "nope".into(),
                met: true,
                note: None,
            }],
            ..ok.clone()
        };
        assert!(validate_report(&t, &unknown).is_err());
        let html = CloseInput {
            format: DocFormat::Html,
            body: "<article data-hills-doc=\"1\"><section data-section=\"summary\"><h2>摘要</h2><p>x</p></section><section data-section=\"criteria\"><p>y</p></section><script>alert(1)</script></article>".into(),
            ..ok.clone()
        };
        assert!(validate_report(&t, &html).is_err());
        let bad_attach = CloseInput {
            attachments: serde_json::json!({"a": 1}),
            ..ok
        };
        assert!(validate_report(&t, &bad_attach).is_err());
    }

    #[test]
    fn logs_sorted_and_latest_report_fallback() {
        let (mut doc, _) = doc_with_task(vec![]);
        write_log(
            &mut doc,
            "t1",
            "02",
            &A,
            LogEntry {
                kind: LogKind::Progress,
                text: "一半",
                percent: Some(50),
                refs: vec![],
                at: 5,
            },
        )
        .unwrap();
        write_log(
            &mut doc,
            "t1",
            "01",
            &B,
            LogEntry {
                kind: LogKind::Answer,
                text: "好",
                percent: None,
                refs: vec![],
                at: 5,
            },
        )
        .unwrap();
        write_log(
            &mut doc,
            "t2",
            "03",
            &A,
            LogEntry {
                kind: LogKind::Start,
                text: "",
                percent: None,
                refs: vec![],
                at: 1,
            },
        )
        .unwrap();
        let logs = read_logs(&doc, "t1");
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].id, "01");
        assert_eq!(logs[1].percent, Some(50));
        let r = |at| TaskReport {
            v: 1,
            format: DocFormat::Markdown,
            spec: doc_spec::SPEC_V1.into(),
            body: "x".into(),
            criteria: vec![],
            attachments: empty_array(),
            at,
            author: None,
        };
        write_report(&mut doc, "t1", &A, &r(1)).unwrap();
        write_report(&mut doc, "t1", &B, &r(9)).unwrap();
        assert_eq!(read_report(&doc, "t1", Some(&A)).unwrap().author, Some(A));
        assert_eq!(read_report(&doc, "t1", None).unwrap().author, Some(B));
    }
}
