//! 每日 Scrum（technical-design §16.12 v0.17，feature-plan §5.4、D21）。
//!
//! `member/<id>/scrum/<teamId>/<yyyy-mm>`：根物件 `day:<yyyy-mm-dd>` → JSON 字串；
//! 送出時寫入每個所屬小組的文件，讀取時同一天取 `updatedAt` 較新者。

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, bail};
use automerge::{AutoCommit, ROOT, ReadDoc, ScalarValue, Value, transaction::Transactable};
use hills_proto::{MemberId, Timestamp};
use hills_sync::{DocKind, MemberSection};
use serde::{Deserialize, Serialize};

use crate::node::{Node, now_ms};
use crate::org::{OrgSnapshot, get_str};

const DAY_PREFIX: &str = "day:";
const MAX_ITEMS: usize = 30;
const MAX_TEXT: usize = 200;
/// 組織預設提醒時間（§16.12）
pub const DEFAULT_REMINDER: &str = "17:30";
/// 本機設定（不同步）：草稿與個人提醒時間
const LOCAL_FILE: &str = "scrum-local";

/// 只存在本機的 Scrum 設定。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScrumLocal {
    /// 個人提醒時間（`HH:MM`）；None = 組織預設
    #[serde(default)]
    pub reminder: Option<String>,
    /// 草稿（前端定義的 JSON 字串），以日期為 key，只保留最近 7 天
    #[serde(default)]
    pub drafts: BTreeMap<String, String>,
    /// 最後提醒的日期
    #[serde(default)]
    pub reminded: Option<String>,
}

pub fn scrum_doc(owner: &MemberId, team: &str, month: &str) -> String {
    format!("member/{owner}/scrum/{team}/{month}")
}

/// `yyyy-mm-dd`（只檢查格式與範圍）。
pub fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
        && s[5..7].parse::<u32>().is_ok_and(|m| (1..=12).contains(&m))
        && s[8..10].parse::<u32>().is_ok_and(|d| (1..=31).contains(&d))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ScrumRef {
    Task {
        #[serde(rename = "teamId")]
        team_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
        title: String,
    },
    Plan {
        #[serde(rename = "planId")]
        plan_id: String,
        title: String,
    },
    Text {
        title: String,
    },
}

impl ScrumRef {
    fn title(&self) -> &str {
        match self {
            Self::Task { title, .. } | Self::Plan { title, .. } | Self::Text { title } => title,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Blocker {
    pub text: String,
    #[serde(default)]
    pub notified: Vec<String>,
}

/// 文件中的 JSON 內容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportBody {
    v: u8,
    date: String,
    done: Vec<ScrumRef>,
    today: Vec<ScrumRef>,
    blockers: Vec<Blocker>,
    submitted_at: Timestamp,
    updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrumReport {
    #[serde(serialize_with = "member_str")]
    pub member: MemberId,
    pub date: String,
    pub done: Vec<ScrumRef>,
    pub today: Vec<ScrumRef>,
    pub blockers: Vec<Blocker>,
    pub submitted_at: Timestamp,
    pub updated_at: Timestamp,
}

fn member_str<S: serde::Serializer>(m: &MemberId, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&m.to_string())
}

/// 送出的輸入（`notified` 由節點計算，輸入中的值忽略）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrumInput {
    pub date: String,
    #[serde(default)]
    pub done: Vec<ScrumRef>,
    #[serde(default)]
    pub today: Vec<ScrumRef>,
    #[serde(default)]
    pub blockers: Vec<String>,
}

fn validate(input: &ScrumInput) -> Result<()> {
    if !valid_date(&input.date) {
        bail!("日期格式需為 yyyy-mm-dd");
    }
    for list in [&input.done, &input.today] {
        if list.len() > MAX_ITEMS {
            bail!("每一區最多 {MAX_ITEMS} 項");
        }
        if list.iter().any(|r| {
            let n = r.title().trim().chars().count();
            n == 0 || n > MAX_TEXT
        }) {
            bail!("每項需為 1–{MAX_TEXT} 字");
        }
    }
    if input.blockers.len() > MAX_ITEMS
        || input.blockers.iter().any(|b| {
            let n = b.trim().chars().count();
            n == 0 || n > MAX_TEXT
        })
    {
        bail!("阻礙最多 {MAX_ITEMS} 項，每項 1–{MAX_TEXT} 字");
    }
    Ok(())
}

/// 阻礙通知對象：各所屬小組的負責人；小組沒有負責人時為全體管理者（§16.12）。
pub fn notify_targets(
    org: &OrgSnapshot,
    me: &MemberId,
    teams: &[String],
    admins: &[MemberId],
) -> Vec<MemberId> {
    let mut out = BTreeSet::new();
    for t in teams {
        let leads: Vec<MemberId> = org
            .teams
            .get(t)
            .map(|x| x.leads.clone())
            .unwrap_or_default();
        if leads.is_empty() {
            out.extend(admins.iter().copied());
        } else {
            out.extend(leads);
        }
    }
    out.remove(me);
    out.into_iter().collect()
}

fn parse(member: MemberId, json: &str) -> Option<ScrumReport> {
    let b: ReportBody = serde_json::from_str(json).ok()?;
    if !valid_date(&b.date) {
        return None;
    }
    Some(ScrumReport {
        member,
        date: b.date,
        done: b.done,
        today: b.today,
        blockers: b.blockers,
        submitted_at: b.submitted_at,
        updated_at: b.updated_at,
    })
}

fn str_at(doc: &AutoCommit, key: &str) -> Option<String> {
    match doc.get(ROOT, key).ok()??.0 {
        Value::Scalar(s) => match s.as_ref() {
            ScalarValue::Str(t) => Some(t.to_string()),
            _ => None,
        },
        _ => None,
    }
}

/// 讀出一份 Scrum 文件。
pub fn read_reports(doc: &AutoCommit, member: MemberId) -> Vec<ScrumReport> {
    doc.keys(ROOT)
        .filter(|k| k.starts_with(DAY_PREFIX))
        .filter_map(|k| parse(member, &str_at(doc, &k)?))
        .collect()
}

/// 指定 key（新收到的 change）的 Scrum。
pub fn read_keys(doc: &AutoCommit, member: MemberId, keys: &[String]) -> Vec<ScrumReport> {
    keys.iter()
        .filter(|k| k.starts_with(DAY_PREFIX))
        .filter_map(|k| parse(member, &str_at(doc, k)?))
        .collect()
}

/// 同一人同一天出現在多份小組文件時取 `updated_at` 較新者。
pub fn dedup(reports: Vec<ScrumReport>) -> Vec<ScrumReport> {
    let mut by: BTreeMap<(MemberId, String), ScrumReport> = BTreeMap::new();
    for r in reports {
        let k = (r.member, r.date.clone());
        match by.get(&k) {
            Some(old) if old.updated_at >= r.updated_at => {}
            _ => {
                by.insert(k, r);
            }
        }
    }
    by.into_values().collect()
}

/// 文件 ID 若為 Scrum，回傳擁有者。
pub fn scrum_owner(doc_id: &str) -> Option<MemberId> {
    match DocKind::parse(doc_id)? {
        DocKind::Member {
            owner,
            section: MemberSection::Scrum { .. },
        } => Some(owner),
        _ => None,
    }
}

impl Node {
    /// 送出（或更新）某天的 Scrum，寫入每個所屬小組的文件。
    pub async fn scrum_submit(&self, input: ScrumInput) -> Result<ScrumReport> {
        validate(&input)?;
        let me = self.member_id();
        let org = self.org();
        let teams = org.teams_of(&me);
        if teams.is_empty() {
            bail!("你還沒有加入任何小組");
        }
        let admins: Vec<MemberId> = self
            .member_roles()
            .into_iter()
            .filter(|(_, admin)| *admin)
            .map(|(m, _)| m)
            .collect();
        let notified: Vec<String> = notify_targets(&org, &me, &teams, &admins)
            .iter()
            .map(|m| m.to_string())
            .collect();
        let now = now_ms();
        let existing = self.my_scrum(&input.date)?;
        let body = ReportBody {
            v: 1,
            date: input.date.clone(),
            done: input.done,
            today: input.today,
            blockers: input
                .blockers
                .iter()
                .map(|t| Blocker {
                    text: t.trim().to_owned(),
                    notified: notified.clone(),
                })
                .collect(),
            submitted_at: existing.as_ref().map_or(now, |e| e.submitted_at),
            updated_at: now,
        };
        let json = serde_json::to_string(&body)?;
        let month = &input.date[..7];
        let key = format!("{DAY_PREFIX}{}", input.date);
        for t in &teams {
            self.change(&scrum_doc(&me, t, month), |doc| {
                doc.put(ROOT, key.as_str(), json.as_str())?;
                Ok(())
            })
            .await?;
        }
        parse(me, &json).ok_or_else(|| anyhow::anyhow!("Scrum 格式錯誤"))
    }

    /// 我在某天送出的 Scrum。
    pub fn my_scrum(&self, date: &str) -> Result<Option<ScrumReport>> {
        if !valid_date(date) {
            bail!("日期格式需為 yyyy-mm-dd");
        }
        let me = self.member_id();
        let mut found = Vec::new();
        for t in self.org().teams_of(&me) {
            let id = scrum_doc(&me, &t, &date[..7]);
            found.extend(
                self.read_doc(&id, |d| read_reports(d, me))?
                    .into_iter()
                    .filter(|r| r.date == date),
            );
        }
        Ok(dedup(found).into_iter().next())
    }

    /// 某小組成員在 `[from, to]`（含）期間的 Scrum；只能讀自己所屬的小組。
    pub fn scrum_reports(&self, team: &str, from: &str, to: &str) -> Result<Vec<ScrumReport>> {
        if !valid_date(from) || !valid_date(to) || from > to {
            bail!("日期範圍無效");
        }
        let me = self.member_id();
        let org = self.org();
        if !org.teams_of(&me).iter().any(|t| t == team) {
            bail!("你不是這個小組的成員");
        }
        let ids = self.inner.store.doc_ids()?;
        let mut out = Vec::new();
        for id in &ids {
            let Some(DocKind::Member {
                owner,
                section: MemberSection::Scrum { team: t, month },
            }) = DocKind::parse(id)
            else {
                continue;
            };
            // 跨越多個月份時包含中間的月份
            if t != team || month.as_str() < &from[..7] || month.as_str() > &to[..7] {
                continue;
            }
            out.extend(
                self.read_doc(id, |d| read_reports(d, owner))?
                    .into_iter()
                    .filter(|r| r.date.as_str() >= from && r.date.as_str() <= to),
            );
        }
        let mut v = dedup(out);
        v.sort_by(|a, b| (&a.date, a.member).cmp(&(&b.date, b.member)));
        Ok(v)
    }

    /// 本機設定（草稿、個人提醒時間）。
    pub fn scrum_local(&self) -> ScrumLocal {
        self.inner
            .store
            .read_secret_file(LOCAL_FILE)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default()
    }

    fn save_scrum_local(&self, v: &ScrumLocal) -> Result<()> {
        self.inner
            .store
            .write_secret_file(LOCAL_FILE, &serde_json::to_vec(v)?)?;
        Ok(())
    }

    /// 保存某天的草稿（`None` 清除）。草稿只存在本機（§16.12）。
    pub fn set_scrum_draft(&self, date: &str, draft: Option<String>) -> Result<()> {
        if !valid_date(date) {
            bail!("日期格式需為 yyyy-mm-dd");
        }
        if draft.as_ref().is_some_and(|d| d.len() > 64 * 1024) {
            bail!("草稿過大");
        }
        let mut v = self.scrum_local();
        match draft {
            Some(d) => {
                v.drafts.insert(date.to_owned(), d);
            }
            None => {
                v.drafts.remove(date);
            }
        }
        while v.drafts.len() > 7 {
            let Some(first) = v.drafts.keys().next().cloned() else {
                break;
            };
            v.drafts.remove(&first);
        }
        self.save_scrum_local(&v)
    }

    /// 個人提醒時間（`None` = 組織預設）。
    pub fn set_my_scrum_reminder(&self, hhmm: Option<String>) -> Result<()> {
        if let Some(h) = &hhmm
            && !crate::org::valid_hhmm(h)
        {
            bail!("時間格式需為 HH:MM");
        }
        let mut v = self.scrum_local();
        v.reminder = hhmm;
        self.save_scrum_local(&v)
    }

    /// 記錄某天已提醒（每天最多一次）；回傳這次是否應該提醒。
    pub fn mark_scrum_reminded(&self, date: &str) -> Result<bool> {
        let mut v = self.scrum_local();
        if v.reminded.as_deref() == Some(date) {
            return Ok(false);
        }
        v.reminded = Some(date.to_owned());
        self.save_scrum_local(&v)?;
        Ok(true)
    }

    /// 組織預設提醒時間（org 文件 `scrumReminder`）。
    pub fn scrum_reminder(&self) -> String {
        self.read_doc("org", |d| get_str(d, &ROOT, "scrumReminder"))
            .ok()
            .flatten()
            .filter(|s| crate::org::valid_hhmm(s))
            .unwrap_or_else(|| DEFAULT_REMINDER.to_owned())
    }

    /// 管理者設定組織預設提醒時間（`HH:MM`）。
    pub async fn set_scrum_reminder(&self, hhmm: &str) -> Result<()> {
        if !self.is_admin() {
            bail!("只有管理者可以設定組織預設提醒時間");
        }
        if !crate::org::valid_hhmm(hhmm) {
            bail!("時間格式需為 HH:MM");
        }
        self.change("org", |doc| {
            doc.put(ROOT, "scrumReminder", hhmm)?;
            Ok(())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::org::TeamRec;

    fn m(b: u8) -> MemberId {
        MemberId([b; 16])
    }

    #[test]
    fn dates() {
        assert!(valid_date("2026-11-09"));
        for bad in [
            "2026-13-01",
            "2026-11-32",
            "2026-1-01",
            "20261109",
            "2026-11-0x",
        ] {
            assert!(!valid_date(bad), "{bad}");
        }
    }

    #[test]
    fn notify_rules() {
        let mut org = OrgSnapshot::default();
        org.teams.insert(
            "a".into(),
            TeamRec {
                name: "A".into(),
                leads: vec![m(2)],
                members: vec![m(1), m(2)],
                ..Default::default()
            },
        );
        org.teams.insert(
            "b".into(),
            TeamRec {
                name: "B".into(),
                leads: vec![],
                members: vec![m(1)],
                ..Default::default()
            },
        );
        let admins = vec![m(9), m(1)];
        assert_eq!(
            notify_targets(&org, &m(1), &["a".into()], &admins),
            vec![m(2)]
        );
        // 沒有負責人 → 管理者（不含自己）
        assert_eq!(
            notify_targets(&org, &m(1), &["a".into(), "b".into()], &admins),
            vec![m(2), m(9)]
        );
    }

    #[test]
    fn read_and_dedup() {
        let me = m(1);
        let body = |updated: i64, blocker: &str| {
            serde_json::to_string(&ReportBody {
                v: 1,
                date: "2026-11-09".into(),
                done: vec![ScrumRef::Task {
                    team_id: "a".into(),
                    task_id: "t".into(),
                    title: "驗收".into(),
                }],
                today: vec![ScrumRef::Text {
                    title: "寫週報".into(),
                }],
                blockers: vec![Blocker {
                    text: blocker.into(),
                    notified: vec![m(2).to_string()],
                }],
                submitted_at: 1,
                updated_at: updated,
            })
            .unwrap()
        };
        let mut a = AutoCommit::new();
        a.put(ROOT, "day:2026-11-09", body(5, "舊")).unwrap();
        a.put(ROOT, "other", "x").unwrap();
        let mut b = AutoCommit::new();
        b.put(ROOT, "day:2026-11-09", body(7, "新")).unwrap();
        let mut all = read_reports(&a, me);
        all.extend(read_reports(&b, me));
        let out = dedup(all);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].blockers[0].text, "新");
        let v = serde_json::to_value(&out[0]).unwrap();
        assert_eq!(v["member"], me.to_string());
        assert_eq!(v["done"][0]["kind"], "task");
        assert_eq!(v["done"][0]["teamId"], "a");
        assert_eq!(
            read_keys(&b, me, &["day:2026-11-09".into(), "x".into()]).len(),
            1
        );
    }

    #[test]
    fn validation() {
        let ok = ScrumInput {
            date: "2026-11-09".into(),
            done: vec![],
            today: vec![ScrumRef::Text { title: "x".into() }],
            blockers: vec!["需要測試機".into()],
        };
        assert!(validate(&ok).is_ok());
        let mut bad = ok.clone();
        bad.date = "11/09".into();
        assert!(validate(&bad).is_err());
        let mut bad = ok.clone();
        bad.blockers = vec![" ".into()];
        assert!(validate(&bad).is_err());
        let mut bad = ok;
        bad.today = (0..31)
            .map(|i| ScrumRef::Text {
                title: i.to_string(),
            })
            .collect();
        assert!(validate(&bad).is_err());
    }
}
