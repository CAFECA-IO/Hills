//! 日 / 週報（technical-design §16.13 v0.18，feature-plan §5.5、D32、D16）。
//!
//! `member/<id>/reports/<teamId>/<yyyy>`：根物件 `report:<daily|weekly>:<period>` → JSON 字串。
//! 發佈到哪些小組就寫入哪些小組的文件；這次取消的小組從該文件刪除。

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, bail};
use automerge::{AutoCommit, ROOT, ReadDoc, ScalarValue, Value, transaction::Transactable};
use hills_proto::{MemberId, Timestamp};
use hills_sync::{DocKind, MemberSection};
use serde::{Deserialize, Serialize};

use crate::node::{Node, now_ms};
use crate::scrum::valid_date;

const PREFIX: &str = "report:";
const MAX_SECTION: usize = 32 * 1024;
const LOCAL_FILE: &str = "report-local";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportKind {
    Daily,
    Weekly,
}

impl ReportKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
        }
    }
}

/// 期間格式是否與種類相符：日報 `yyyy-mm-dd`、週報 `yyyy-Www`。
pub fn valid_period(kind: ReportKind, period: &str) -> bool {
    match kind {
        ReportKind::Daily => valid_date(period),
        ReportKind::Weekly => crate::plans::valid_period(crate::plans::PlanLevel::Week, period),
    }
}

pub fn report_doc(owner: &MemberId, team: &str, year: &str) -> String {
    format!("member/{owner}/reports/{team}/{year}")
}

fn report_key(kind: ReportKind, period: &str) -> String {
    format!("{PREFIX}{}:{period}", kind.as_str())
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportSections {
    pub progress: String,
    pub okr: String,
    pub attendance: String,
    pub next: String,
}

/// 週報 v2 的六段（technical-design §16.13 v0.34，D61）。發佈到小組的內容只有專案層級（D62）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportData {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub summary_edited: bool,
    #[serde(default)]
    pub time: Vec<TimeRow>,
    #[serde(default)]
    pub projects: Vec<ProjectRow>,
    #[serde(default)]
    pub plan: PlanData,
    #[serde(default)]
    pub reasons: Vec<Reason>,
    #[serde(default)]
    pub done_md: String,
    #[serde(default)]
    pub next_md: String,
}

/// `project` = 小組目標 id、`other`（其他任務）或 `nontask`（會議、訊息與零碎）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRow {
    pub project: String,
    pub minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub project: String,
    #[serde(default)]
    pub title: String,
    /// 期初、期末進度 0–100（期初不知道時 None）
    #[serde(default)]
    pub start: Option<f64>,
    pub end: f64,
    /// 我的貢獻（百分點）
    #[serde(default)]
    pub mine: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanData {
    #[serde(default)]
    pub minutes: Vec<PlanMinutes>,
    #[serde(default)]
    pub tasks: PlanTasks,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanMinutes {
    pub project: String,
    pub planned: u32,
    pub actual: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTasks {
    pub planned: u32,
    pub done: u32,
    pub carried: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reason {
    /// blocked | underestimate | unplanned | reopened | leave | other
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub minutes: Option<u32>,
}

const REASON_KINDS: [&str; 6] = [
    "blocked",
    "underestimate",
    "unplanned",
    "reopened",
    "leave",
    "other",
];
const MAX_ROWS: usize = 50;
const MAX_SUMMARY: usize = 2000;
const MAX_TEXT: usize = 500;

fn validate_data(d: &ReportData) -> Result<()> {
    if d.summary.chars().count() > MAX_SUMMARY {
        bail!("摘要最多 {MAX_SUMMARY} 字");
    }
    if d.done_md.len() > MAX_SECTION || d.next_md.len() > MAX_SECTION {
        bail!("每個欄位最多 32 KB");
    }
    if d.time.len() > MAX_ROWS
        || d.projects.len() > MAX_ROWS
        || d.plan.minutes.len() > MAX_ROWS
        || d.reasons.len() > MAX_ROWS
    {
        bail!("報告的列數太多");
    }
    let pct = |v: f64| v.is_finite() && (0.0..=100.0).contains(&v);
    if d.projects
        .iter()
        .any(|p| !pct(p.end) || p.start.is_some_and(|s| !pct(s)) || !p.mine.is_finite())
    {
        bail!("專案進度需為 0–100");
    }
    if d.projects
        .iter()
        .any(|p| p.title.chars().count() > MAX_TEXT)
    {
        bail!("專案名稱太長");
    }
    for r in &d.reasons {
        if !REASON_KINDS.contains(&r.kind.as_str()) {
            bail!("不認得的偏離原因");
        }
        if r.text.chars().count() > MAX_TEXT {
            bail!("原因說明最多 {MAX_TEXT} 字");
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportBody {
    v: u8,
    kind: ReportKind,
    period: String,
    sections: ReportSections,
    published_to: Vec<String>,
    generated_at: Timestamp,
    published_at: Timestamp,
    #[serde(default)]
    edited_at: Option<Timestamp>,
    /// v2（D61）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<ReportData>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    #[serde(serialize_with = "member_str")]
    pub member: MemberId,
    pub kind: ReportKind,
    pub period: String,
    pub sections: ReportSections,
    pub published_to: Vec<String>,
    pub generated_at: Timestamp,
    pub published_at: Timestamp,
    pub edited_at: Option<Timestamp>,
    /// v2 的六段（v1 為 None）
    pub data: Option<ReportData>,
}

fn member_str<S: serde::Serializer>(m: &MemberId, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&m.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportInput {
    pub kind: ReportKind,
    pub period: String,
    pub sections: ReportSections,
    pub published_to: Vec<String>,
    /// 產生草稿的時間（前端）
    #[serde(default)]
    pub generated_at: Option<Timestamp>,
    /// v2 的六段（D61；週報）
    #[serde(default)]
    pub data: Option<ReportData>,
}

/// 只存在本機的報表設定：草稿與「已提醒」紀錄（§16.13）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportLocal {
    /// key = `<kind>:<period>`，值為前端定義的 JSON 字串；只保留最近 10 份
    #[serde(default)]
    pub drafts: BTreeMap<String, String>,
    /// 最後提醒的週（`yyyy-Www`）
    #[serde(default)]
    pub reminded: Option<String>,
}

/// 期間所屬年份（文件分份用）：前 4 字元。
fn year_of(period: &str) -> &str {
    &period[..4]
}

fn validate(input: &ReportInput) -> Result<()> {
    if !valid_period(input.kind, &input.period) {
        bail!("期間格式與報表種類不符");
    }
    let s = &input.sections;
    if [&s.progress, &s.okr, &s.attendance, &s.next]
        .iter()
        .any(|x| x.len() > MAX_SECTION)
    {
        bail!("每個欄位最多 32 KB");
    }
    if input.published_to.is_empty() {
        bail!("請選擇至少一個發佈的小組");
    }
    if let Some(d) = &input.data {
        validate_data(d)?;
    }
    Ok(())
}

fn parse(member: MemberId, json: &str) -> Option<Report> {
    let b: ReportBody = serde_json::from_str(json).ok()?;
    if !valid_period(b.kind, &b.period) {
        return None;
    }
    Some(Report {
        member,
        kind: b.kind,
        period: b.period,
        sections: b.sections,
        published_to: b.published_to,
        generated_at: b.generated_at,
        published_at: b.published_at,
        edited_at: b.edited_at,
        data: b.data,
    })
}

/// 讀出一份報表文件。
pub fn read_reports(doc: &AutoCommit, member: MemberId) -> Vec<Report> {
    doc.keys(ROOT)
        .filter(|k| k.starts_with(PREFIX))
        .filter_map(|k| match doc.get(ROOT, &k).ok()??.0 {
            Value::Scalar(s) => match s.as_ref() {
                ScalarValue::Str(t) => parse(member, t),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// 同一人同一期出現在多份小組文件時取 `published_at` 較新者。
pub fn dedup(reports: Vec<Report>) -> Vec<Report> {
    let mut by: BTreeMap<(MemberId, ReportKind, String), Report> = BTreeMap::new();
    for r in reports {
        let k = (r.member, r.kind, r.period.clone());
        match by.get(&k) {
            Some(old) if old.published_at >= r.published_at => {}
            _ => {
                by.insert(k, r);
            }
        }
    }
    by.into_values().collect()
}

impl Node {
    /// 發佈（或更新）報表：寫入勾選小組的文件，並從這次取消的小組文件刪除。
    pub async fn publish_report(&self, input: ReportInput) -> Result<Report> {
        validate(&input)?;
        let me = self.member_id();
        let my_teams: BTreeSet<String> = self.org().teams_of(&me).into_iter().collect();
        let targets: BTreeSet<String> = input.published_to.iter().cloned().collect();
        if !targets.is_subset(&my_teams) {
            bail!("只能發佈到自己所屬的小組");
        }
        let existing = self.my_report(input.kind, &input.period)?;
        let now = now_ms();
        let body = ReportBody {
            v: if input.data.is_some() { 2 } else { 1 },
            kind: input.kind,
            period: input.period.clone(),
            sections: input.sections,
            published_to: targets.iter().cloned().collect(),
            generated_at: input.generated_at.unwrap_or(now),
            published_at: now,
            edited_at: existing.as_ref().map(|_| now),
            data: input.data,
        };
        let json = serde_json::to_string(&body)?;
        let key = report_key(input.kind, &input.period);
        let year = year_of(&input.period);
        for t in &targets {
            self.change(&report_doc(&me, t, year), |doc| {
                doc.put(ROOT, key.as_str(), json.as_str())?;
                Ok(())
            })
            .await?;
        }
        // 這次取消的小組：從該小組文件刪除（我目前仍屬於的小組）
        for t in my_teams.difference(&targets) {
            let id = report_doc(&me, t, year);
            let present =
                self.read_doc(&id, |d| d.get(ROOT, key.as_str()).ok().flatten().is_some())?;
            if present {
                self.change(&id, |doc| {
                    doc.delete(ROOT, key.as_str())?;
                    Ok(())
                })
                .await?;
            }
        }
        parse(me, &json).ok_or_else(|| anyhow::anyhow!("報表格式錯誤"))
    }

    /// 我已發佈的某期報表。
    pub fn my_report(&self, kind: ReportKind, period: &str) -> Result<Option<Report>> {
        if !valid_period(kind, period) {
            bail!("期間格式與報表種類不符");
        }
        let me = self.member_id();
        let mut found = Vec::new();
        for t in self.org().teams_of(&me) {
            let id = report_doc(&me, &t, year_of(period));
            found.extend(
                self.read_doc(&id, |d| read_reports(d, me))?
                    .into_iter()
                    .filter(|r| r.kind == kind && r.period == period),
            );
        }
        Ok(dedup(found).into_iter().next())
    }

    /// 某小組成員同一期已發佈的報表（只能讀自己所屬的小組）。
    pub fn team_reports(&self, team: &str, kind: ReportKind, period: &str) -> Result<Vec<Report>> {
        if !valid_period(kind, period) {
            bail!("期間格式與報表種類不符");
        }
        let me = self.member_id();
        if !self.org().teams_of(&me).iter().any(|t| t == team) {
            bail!("你不是這個小組的成員");
        }
        let year = year_of(period);
        let mut out = Vec::new();
        for id in self.inner.store.doc_ids()? {
            let Some(DocKind::Member {
                owner,
                section: MemberSection::Reports { team: t, year: y },
            }) = DocKind::parse(&id)
            else {
                continue;
            };
            if t != team || y != year {
                continue;
            }
            out.extend(
                self.read_doc(&id, |d| read_reports(d, owner))?
                    .into_iter()
                    .filter(|r| r.kind == kind && r.period == period),
            );
        }
        let mut v = dedup(out);
        v.sort_by_key(|r| r.member);
        Ok(v)
    }

    pub fn report_local(&self) -> ReportLocal {
        self.inner
            .store
            .read_secret_file(LOCAL_FILE)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default()
    }

    fn save_report_local(&self, v: &ReportLocal) -> Result<()> {
        self.inner
            .store
            .write_secret_file(LOCAL_FILE, &serde_json::to_vec(v)?)?;
        Ok(())
    }

    /// 保存草稿（`None` 清除）。草稿只存在本機（§16.13）。
    pub fn set_report_draft(
        &self,
        kind: ReportKind,
        period: &str,
        draft: Option<String>,
    ) -> Result<()> {
        if !valid_period(kind, period) {
            bail!("期間格式與報表種類不符");
        }
        if draft
            .as_ref()
            .is_some_and(|d| d.len() > 4 * MAX_SECTION + 1024)
        {
            bail!("草稿過大");
        }
        let key = format!("{}:{period}", kind.as_str());
        let mut v = self.report_local();
        match draft {
            Some(d) => {
                v.drafts.insert(key, d);
            }
            None => {
                v.drafts.remove(&key);
            }
        }
        while v.drafts.len() > 10 {
            let Some(first) = v.drafts.keys().next().cloned() else {
                break;
            };
            v.drafts.remove(&first);
        }
        self.save_report_local(&v)
    }

    /// 記錄本週已提醒（每週最多一次）；回傳這次是否應該提醒。
    pub fn mark_report_reminded(&self, week: &str) -> Result<bool> {
        let mut v = self.report_local();
        if v.reminded.as_deref() == Some(week) {
            return Ok(false);
        }
        v.reminded = Some(week.to_owned());
        self.save_report_local(&v)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(b: u8) -> MemberId {
        MemberId([b; 16])
    }

    fn input(period: &str, teams: &[&str]) -> ReportInput {
        ReportInput {
            kind: ReportKind::Weekly,
            period: period.into(),
            sections: ReportSections {
                progress: "- 完成 A".into(),
                ..Default::default()
            },
            published_to: teams.iter().map(|s| (*s).to_owned()).collect(),
            generated_at: None,
            data: None,
        }
    }

    #[test]
    fn periods_and_validation() {
        assert!(valid_period(ReportKind::Daily, "2026-11-09"));
        assert!(!valid_period(ReportKind::Daily, "2026-W45"));
        assert!(valid_period(ReportKind::Weekly, "2026-W45"));
        assert!(!valid_period(ReportKind::Weekly, "2026-11-09"));
        assert!(validate(&input("2026-W45", &["a"])).is_ok());
        assert!(validate(&input("2026-W45", &[])).is_err());
        let mut big = input("2026-W45", &["a"]);
        big.sections.next = "x".repeat(MAX_SECTION + 1);
        assert!(validate(&big).is_err());
        assert_eq!(
            report_key(ReportKind::Weekly, "2026-W45"),
            "report:weekly:2026-W45"
        );
    }

    #[test]
    fn read_and_dedup() {
        let body = |at: i64, text: &str| {
            serde_json::to_string(&ReportBody {
                v: 1,
                kind: ReportKind::Weekly,
                period: "2026-W45".into(),
                sections: ReportSections {
                    progress: text.into(),
                    ..Default::default()
                },
                published_to: vec!["a".into()],
                generated_at: 1,
                published_at: at,
                edited_at: None,
                data: None,
            })
            .unwrap()
        };
        let mut a = AutoCommit::new();
        a.put(ROOT, "report:weekly:2026-W45", body(5, "舊"))
            .unwrap();
        a.put(ROOT, "x", "y").unwrap();
        let mut b = AutoCommit::new();
        b.put(ROOT, "report:weekly:2026-W45", body(9, "新"))
            .unwrap();
        let mut all = read_reports(&a, m(1));
        all.extend(read_reports(&b, m(1)));
        let out = dedup(all);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].sections.progress, "新");
        let v = serde_json::to_value(&out[0]).unwrap();
        assert_eq!(v["member"], m(1).to_string());
        assert_eq!(v["kind"], "weekly");
        assert_eq!(v["publishedTo"][0], "a");
    }

    #[test]
    fn v2_data_validates_and_round_trips() {
        let mut i = input("2026-W46", &["a"]);
        let d = ReportData {
            summary: "這週主要投入 M1（12 小時）".into(),
            time: vec![
                TimeRow {
                    project: "tg1".into(),
                    minutes: 720,
                },
                TimeRow {
                    project: "nontask".into(),
                    minutes: 300,
                },
            ],
            projects: vec![ProjectRow {
                project: "tg1".into(),
                title: "M1".into(),
                start: Some(40.0),
                end: 52.0,
                mine: 6.5,
            }],
            plan: PlanData {
                minutes: vec![PlanMinutes {
                    project: "tg1".into(),
                    planned: 600,
                    actual: 720,
                }],
                tasks: PlanTasks {
                    planned: 5,
                    done: 3,
                    carried: 2,
                },
            },
            reasons: vec![Reason {
                kind: "blocked".into(),
                text: "等測試主機".into(),
                minutes: Some(120),
            }],
            ..Default::default()
        };
        i.data = Some(d.clone());
        assert!(validate(&i).is_ok());
        let body = ReportBody {
            v: 2,
            kind: ReportKind::Weekly,
            period: "2026-W46".into(),
            sections: ReportSections::default(),
            published_to: vec!["a".into()],
            generated_at: 1,
            published_at: 2,
            edited_at: None,
            data: Some(d.clone()),
        };
        let r = parse(m(1), &serde_json::to_string(&body).unwrap()).unwrap();
        assert_eq!(r.data, Some(d.clone()));
        let mut bad = d.clone();
        bad.reasons[0].kind = "nope".into();
        i.data = Some(bad);
        assert!(validate(&i).is_err());
        let mut bad = d;
        bad.projects[0].end = 140.0;
        i.data = Some(bad);
        assert!(validate(&i).is_err());
    }
}
