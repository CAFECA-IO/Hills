//! 方向摘要、對齊建議與偏離門檻（technical-design §16.14 v0.21，feature-plan D47 第 2 批）。
//!
//! `member/<id>/direction` 只有本人可寫、全員可讀（`GK`）。摘要由本人的 App（前端，依組織時區）
//! 計算後發佈；這裡只驗證格式、寫入與修剪，以及讀出所有成員的摘要與給我的建議。

use anyhow::{Result, bail};
use automerge::{AutoCommit, ObjType, ROOT, ReadDoc, transaction::Transactable};
use hills_proto::{MemberId, Timestamp};
use hills_sync::{DocKind, MemberSection};
use serde::{Deserialize, Serialize};

use crate::node::{Node, now_ms};
use crate::org::{get_int, get_obj, get_str};

const WEEK_PREFIX: &str = "week:";
const SUGGEST_PREFIX: &str = "suggest:";
/// 保留最近幾週的摘要
const KEEP_WEEKS: usize = 8;
const MAX_JSON: usize = 16 * 1024;
const MAX_GOALS: usize = 20;
const MAX_TITLE: usize = 200;
/// 建議超過幾天不再顯示
const SUGGEST_TTL_DAYS: i64 = 30;
const DAY_MS: i64 = 86_400_000;

pub fn direction_doc(owner: &MemberId) -> String {
    format!("member/{owner}/direction")
}

/// 摘要中的一個季目標（不含私人）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalBrief {
    pub id: String,
    pub title: String,
    pub progress: f64,
    #[serde(default)]
    pub aligned_goal_id: Option<String>,
}

/// 一週的方向摘要（§16.14 `DirectionWeek`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectionWeek {
    #[serde(default = "v1")]
    pub v: u32,
    pub week: String,
    pub units: u32,
    pub aligned_units: u32,
    pub quarter_progress: Option<f64>,
    #[serde(default)]
    pub goals: Vec<GoalBrief>,
    #[serde(default)]
    pub private_goals: u32,
    pub last_activity: Timestamp,
    #[serde(default)]
    pub open_tasks: u32,
    #[serde(default)]
    pub due_this_week: u32,
    #[serde(default)]
    pub updated_at: Timestamp,
}

fn v1() -> u32 {
    1
}

/// 對齊建議（§16.14 `Suggestion`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    #[serde(default = "v1")]
    pub v: u32,
    pub to: String,
    pub plan_item_id: String,
    pub goal_id: String,
    pub created_at: Timestamp,
}

/// 一位成員的摘要（由新到舊）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberDirection {
    pub member: String,
    pub weeks: Vec<DirectionWeek>,
}

/// 給我的建議。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionView {
    pub id: String,
    pub from: String,
    pub plan_item_id: String,
    pub goal_id: String,
    pub created_at: Timestamp,
}

/// 偏離門檻（org `directionRules`，§16.14）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectionRules {
    pub min_aligned_share: u32,
    pub behind_points: u32,
    pub stale_days: u32,
}

impl Default for DirectionRules {
    fn default() -> Self {
        Self {
            min_aligned_share: 50,
            behind_points: 25,
            stale_days: 14,
        }
    }
}

/// ISO 週字串 `YYYY-Www`（01–53）。
fn valid_week(w: &str) -> bool {
    let b = w.as_bytes();
    b.len() == 8
        && b[..4].iter().all(u8::is_ascii_digit)
        && &b[4..6] == b"-W"
        && b[6..].iter().all(u8::is_ascii_digit)
        && (1..=53).contains(&w[6..].parse::<u32>().unwrap_or(0))
}

fn pct_ok(v: f64) -> bool {
    v.is_finite() && (0.0..=100.0).contains(&v)
}

pub fn validate_week(w: &DirectionWeek) -> Result<()> {
    if !valid_week(&w.week) {
        bail!("週次格式需為 YYYY-Www");
    }
    if w.aligned_units > w.units {
        bail!("為了團隊方向的數量不能多於全部");
    }
    if w.quarter_progress.is_some_and(|p| !pct_ok(p)) {
        bail!("進度需為 0–100");
    }
    if w.goals.len() > MAX_GOALS {
        bail!("季目標最多 {MAX_GOALS} 個");
    }
    if w.goals
        .iter()
        .any(|g| g.id.is_empty() || g.title.chars().count() > MAX_TITLE || !pct_ok(g.progress))
    {
        bail!("季目標資料無效");
    }
    if w.due_this_week > w.open_tasks {
        bail!("這週到期的數量不能多於未完成的任務");
    }
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(doc: &AutoCommit, key: &str) -> Option<T> {
    serde_json::from_str(&get_str(doc, &ROOT, key)?).ok()
}

/// 一份方向文件中的摘要（由新到舊；格式不符的略過）。
pub fn read_weeks(doc: &AutoCommit) -> Vec<DirectionWeek> {
    let mut v: Vec<DirectionWeek> = doc
        .keys(ROOT)
        .filter(|k| k.starts_with(WEEK_PREFIX))
        .filter_map(|k| read_json::<DirectionWeek>(doc, &k))
        .filter(|w| validate_week(w).is_ok())
        .collect();
    v.sort_by(|a, b| b.week.cmp(&a.week));
    v
}

pub fn read_suggestions(doc: &AutoCommit) -> Vec<(String, Suggestion)> {
    doc.keys(ROOT)
        .filter_map(|k| {
            let id = k.strip_prefix(SUGGEST_PREFIX)?.to_owned();
            Some((id, read_json::<Suggestion>(doc, &k)?))
        })
        .collect()
}

/// 寫入一週的摘要，並刪除最近 [`KEEP_WEEKS`] 週以外的舊摘要。
pub fn write_week(doc: &mut AutoCommit, week: &DirectionWeek) -> Result<()> {
    validate_week(week)?;
    let json = serde_json::to_string(week)?;
    if json.len() > MAX_JSON {
        bail!("方向摘要過大");
    }
    doc.put(ROOT, format!("{WEEK_PREFIX}{}", week.week).as_str(), json)?;
    let mut keys: Vec<String> = doc
        .keys(ROOT)
        .filter(|k| k.starts_with(WEEK_PREFIX))
        .collect();
    keys.sort();
    keys.reverse();
    for k in keys.into_iter().skip(KEEP_WEEKS) {
        doc.delete(ROOT, k.as_str())?;
    }
    Ok(())
}

/// 寫入一則建議，並刪除過期的建議。
pub fn write_suggestion(
    doc: &mut AutoCommit,
    id: &str,
    s: &Suggestion,
    now: Timestamp,
) -> Result<()> {
    doc.put(
        ROOT,
        format!("{SUGGEST_PREFIX}{id}").as_str(),
        serde_json::to_string(s)?,
    )?;
    for (old, sg) in read_suggestions(doc) {
        if now - sg.created_at > SUGGEST_TTL_DAYS * DAY_MS {
            doc.delete(ROOT, format!("{SUGGEST_PREFIX}{old}").as_str())?;
        }
    }
    Ok(())
}

pub fn read_rules(doc: &AutoCommit) -> DirectionRules {
    let d = DirectionRules::default();
    let Some(o) = get_obj(doc, &ROOT, "directionRules") else {
        return d;
    };
    let get = |k: &str, def: u32| {
        get_int(doc, &o, k)
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(def)
    };
    DirectionRules {
        min_aligned_share: get("minAlignedShare", d.min_aligned_share),
        behind_points: get("behindPoints", d.behind_points),
        stale_days: get("staleDays", d.stale_days),
    }
}

pub fn write_rules(doc: &mut AutoCommit, r: &DirectionRules) -> Result<()> {
    if r.min_aligned_share > 100 || r.behind_points > 100 || !(1..=365).contains(&r.stale_days) {
        bail!("門檻需為：比例 0–100、落後 0–100 個百分點、1–365 天");
    }
    let o = doc.put_object(ROOT, "directionRules", ObjType::Map)?;
    doc.put(&o, "minAlignedShare", i64::from(r.min_aligned_share))?;
    doc.put(&o, "behindPoints", i64::from(r.behind_points))?;
    doc.put(&o, "staleDays", i64::from(r.stale_days))?;
    Ok(())
}

impl Node {
    /// 本機已同步的所有成員方向文件。
    fn direction_docs(&self) -> Result<Vec<(MemberId, String)>> {
        Ok(self
            .inner
            .store
            .doc_ids()?
            .into_iter()
            .filter_map(|id| match DocKind::parse(&id) {
                Some(DocKind::Member {
                    owner,
                    section: MemberSection::Direction,
                }) => Some((owner, id)),
                _ => None,
            })
            .collect())
    }

    /// 所有成員（含自己）的方向摘要。
    pub fn direction_summaries(&self) -> Result<Vec<MemberDirection>> {
        let active: Vec<MemberId> = self.org().active_members().map(|(m, _)| *m).collect();
        let mut out = Vec::new();
        for (owner, id) in self.direction_docs()? {
            if !active.contains(&owner) {
                continue;
            }
            let weeks = self.read_doc(&id, read_weeks)?;
            out.push(MemberDirection {
                member: owner.to_string(),
                weeks,
            });
        }
        Ok(out)
    }

    /// 別人送給我、還沒過期的對齊建議（由新到舊）。
    pub fn my_suggestions(&self) -> Result<Vec<SuggestionView>> {
        let me = self.member_id().to_string();
        let now = now_ms();
        let mut out = Vec::new();
        for (owner, id) in self.direction_docs()? {
            for (sid, s) in self.read_doc(&id, read_suggestions)? {
                if s.to == me && now - s.created_at <= SUGGEST_TTL_DAYS * DAY_MS {
                    out.push(SuggestionView {
                        id: sid,
                        from: owner.to_string(),
                        plan_item_id: s.plan_item_id,
                        goal_id: s.goal_id,
                        created_at: s.created_at,
                    });
                }
            }
        }
        out.sort_by_key(|s| std::cmp::Reverse(s.created_at));
        Ok(out)
    }

    /// 發佈本週的方向摘要（前端計算，§16.14）。
    pub async fn publish_direction(&self, mut week: DirectionWeek) -> Result<()> {
        week.v = 1;
        week.updated_at = now_ms();
        validate_week(&week)?;
        self.change(&direction_doc(&self.member_id()), |doc| {
            write_week(doc, &week)
        })
        .await
    }

    /// 對某位成員的季目標送出對齊建議（寫在自己的文件）。
    pub async fn suggest_align(
        &self,
        to: MemberId,
        plan_item_id: &str,
        goal_id: &str,
    ) -> Result<()> {
        if to == self.member_id() {
            bail!("不能建議自己");
        }
        if !self.org().active_members().any(|(m, _)| *m == to) {
            bail!("找不到這位成員");
        }
        if plan_item_id.is_empty() || !self.alignable_goal_exists(goal_id)? {
            bail!("找不到要對齊的方向或小組目標");
        }
        let now = now_ms();
        let id = crate::conv::ulid(now)?;
        let s = Suggestion {
            v: 1,
            to: to.to_string(),
            plan_item_id: plan_item_id.to_owned(),
            goal_id: goal_id.to_owned(),
            created_at: now,
        };
        self.change(&direction_doc(&self.member_id()), |doc| {
            write_suggestion(doc, &id, &s, now)
        })
        .await
    }

    pub fn direction_rules(&self) -> Result<DirectionRules> {
        self.read_doc("org", read_rules)
    }

    pub async fn set_direction_rules(&self, rules: DirectionRules) -> Result<()> {
        if !self.is_admin() {
            bail!("只有管理者可以設定偏離門檻");
        }
        self.change("org", |doc| write_rules(doc, &rules)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn week(w: &str) -> DirectionWeek {
        DirectionWeek {
            v: 1,
            week: w.into(),
            units: 5,
            aligned_units: 1,
            quarter_progress: Some(50.0),
            goals: vec![GoalBrief {
                id: "q1".into(),
                title: "研究 Rust GUI 框架".into(),
                progress: 50.0,
                aligned_goal_id: None,
            }],
            private_goals: 0,
            last_activity: 1,
            open_tasks: 3,
            due_this_week: 1,
            updated_at: 2,
        }
    }

    #[test]
    fn weeks_roundtrip_and_prune() {
        let mut doc = AutoCommit::new();
        for n in 37..=46 {
            write_week(&mut doc, &week(&format!("2026-W{n:02}"))).unwrap();
        }
        let weeks = read_weeks(&doc);
        assert_eq!(weeks.len(), KEEP_WEEKS);
        assert_eq!(weeks[0].week, "2026-W46");
        assert_eq!(weeks.last().unwrap().week, "2026-W39");
        // 跨年排序
        write_week(&mut doc, &week("2027-W01")).unwrap();
        assert_eq!(read_weeks(&doc)[0].week, "2027-W01");
        assert_eq!(read_weeks(&doc).len(), KEEP_WEEKS);
    }

    #[test]
    fn validation() {
        let mut w = week("2026-W46");
        assert!(validate_week(&w).is_ok());
        w.week = "2026-46".into();
        assert!(validate_week(&w).is_err());
        w.week = "2026-W54".into();
        assert!(validate_week(&w).is_err());
        let mut w = week("2026-W46");
        w.aligned_units = 6;
        assert!(validate_week(&w).is_err());
        let mut w = week("2026-W46");
        w.quarter_progress = Some(120.0);
        assert!(validate_week(&w).is_err());
        let mut w = week("2026-W46");
        w.goals[0].progress = f64::NAN;
        assert!(validate_week(&w).is_err());
        let mut w = week("2026-W46");
        w.due_this_week = 9;
        assert!(validate_week(&w).is_err());
    }

    #[test]
    fn suggestions_expire() {
        let mut doc = AutoCommit::new();
        let s = |at| Suggestion {
            v: 1,
            to: "m".into(),
            plan_item_id: "q".into(),
            goal_id: "g".into(),
            created_at: at,
        };
        write_suggestion(&mut doc, "a", &s(0), 0).unwrap();
        write_suggestion(&mut doc, "b", &s(DAY_MS * 31), DAY_MS * 31).unwrap();
        let ids: Vec<String> = read_suggestions(&doc).into_iter().map(|(i, _)| i).collect();
        assert_eq!(ids, vec!["b".to_string()]);
    }

    #[test]
    fn rules_default_and_write() {
        let mut doc = AutoCommit::new();
        assert_eq!(read_rules(&doc), DirectionRules::default());
        let r = DirectionRules {
            min_aligned_share: 60,
            behind_points: 20,
            stale_days: 10,
        };
        write_rules(&mut doc, &r).unwrap();
        assert_eq!(read_rules(&doc), r);
        assert!(write_rules(&mut doc, &DirectionRules { stale_days: 0, ..r }).is_err());
    }
}
