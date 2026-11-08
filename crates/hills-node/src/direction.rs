//! 團隊方向（technical-design §16.14 v0.20，feature-plan D47）。
//!
//! - 公司方向：org 文件根物件 `direction:<ULID>`，只有管理者可寫。
//! - 小組目標：`team-goals/<teamId>` 根物件 `goal:<ULID>`，該小組負責人與管理者可寫（驗證層檢查）。
//!
//! 兩者都以 `GK` 加密、全員可讀。個人的年 / 季目標以 `alignedGoalId` 對齊其中一個。

use std::collections::HashMap;

use anyhow::{Result, anyhow, bail};
use automerge::{AutoCommit, ObjType, ROOT, ReadDoc, transaction::Transactable};
use hills_proto::{MemberId, Timestamp};
use serde::{Deserialize, Serialize};

use crate::node::{Node, now_ms};
use crate::org::{get_int, get_obj, get_str};
use crate::plans::{
    KeyResult, PlanItem, PlanLevel, kr_value, put_opt_str, read_krs, validate_krs, write_krs,
};

const DIRECTION_PREFIX: &str = "direction:";
const GOAL_PREFIX: &str = "goal:";
const MAX_TITLE: usize = 80;
/// 每年公司方向的上限（介面建議 1–3 個）
const MAX_DIRECTIONS_PER_YEAR: usize = 5;

pub fn team_goals_doc(team: &str) -> String {
    format!("team-goals/{team}")
}

/// 公司方向。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Direction {
    pub id: String,
    pub year: String,
    pub title: String,
    pub key_results: Vec<KeyResult>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// 小組目標。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamGoal {
    pub id: String,
    pub team: String,
    pub year: String,
    pub title: String,
    pub direction_id: Option<String>,
    pub key_results: Vec<KeyResult>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// 新增或更新公司方向（`id` 為空時新增）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub year: String,
    pub title: String,
    #[serde(default)]
    pub key_results: Vec<KeyResult>,
}

/// 新增或更新小組目標（`id` 為空時新增）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamGoalInput {
    #[serde(default)]
    pub id: Option<String>,
    pub team: String,
    pub year: String,
    pub title: String,
    #[serde(default)]
    pub direction_id: Option<String>,
    #[serde(default)]
    pub key_results: Vec<KeyResult>,
}

fn valid_year(y: &str) -> bool {
    y.len() == 4 && y.bytes().all(|c| c.is_ascii_digit())
}

fn validate(year: &str, title: &str, krs: &[KeyResult]) -> Result<()> {
    if !valid_year(year) {
        bail!("年份格式需為 YYYY");
    }
    let n = title.trim().chars().count();
    if n == 0 || n > MAX_TITLE {
        bail!("標題需為 1–{MAX_TITLE} 字");
    }
    validate_krs(krs)
}

fn read_entries<T>(
    doc: &AutoCommit,
    prefix: &str,
    mut f: impl FnMut(String, &automerge::ObjId) -> Option<T>,
) -> Vec<T> {
    doc.keys(ROOT)
        .filter_map(|k| {
            let id = k.strip_prefix(prefix)?.to_owned();
            let o = get_obj(doc, &ROOT, &k)?;
            f(id, &o)
        })
        .collect()
}

/// org 文件中的公司方向。
pub fn read_directions(doc: &AutoCommit) -> Vec<Direction> {
    let mut v = read_entries(doc, DIRECTION_PREFIX, |id, o| {
        let year = get_str(doc, o, "year").filter(|y| valid_year(y))?;
        Some(Direction {
            id,
            year,
            title: get_str(doc, o, "title").unwrap_or_default(),
            key_results: read_krs(doc, o),
            created_at: get_int(doc, o, "createdAt").unwrap_or(0),
            updated_at: get_int(doc, o, "updatedAt").unwrap_or(0),
        })
    });
    v.sort_by(|a, b| (&a.year, a.created_at).cmp(&(&b.year, b.created_at)));
    v
}

/// 一份 `team-goals/<teamId>` 文件中的小組目標。
pub fn read_team_goals(doc: &AutoCommit, team: &str) -> Vec<TeamGoal> {
    let mut v = read_entries(doc, GOAL_PREFIX, |id, o| {
        let year = get_str(doc, o, "year").filter(|y| valid_year(y))?;
        Some(TeamGoal {
            id,
            team: team.to_owned(),
            year,
            title: get_str(doc, o, "title").unwrap_or_default(),
            direction_id: get_str(doc, o, "directionId"),
            key_results: read_krs(doc, o),
            created_at: get_int(doc, o, "createdAt").unwrap_or(0),
            updated_at: get_int(doc, o, "updatedAt").unwrap_or(0),
        })
    });
    v.sort_by(|a, b| (&a.year, a.created_at).cmp(&(&b.year, b.created_at)));
    v
}

#[allow(clippy::too_many_arguments)]
fn write_entry(
    doc: &mut AutoCommit,
    key: &str,
    year: &str,
    title: &str,
    direction_id: Option<&str>,
    krs: &[KeyResult],
    now: Timestamp,
    kr_id: &mut dyn FnMut() -> Result<String>,
) -> Result<()> {
    let o = match get_obj(doc, &ROOT, key) {
        Some(o) => o,
        None => {
            let o = doc.put_object(ROOT, key, ObjType::Map)?;
            doc.put(&o, "createdAt", now)?;
            o
        }
    };
    doc.put(&o, "year", year)?;
    doc.put(&o, "title", title.trim())?;
    put_opt_str(doc, &o, "directionId", direction_id)?;
    write_krs(doc, &o, krs, kr_id)?;
    doc.put(&o, "updatedAt", now)?;
    Ok(())
}

pub fn write_direction(
    doc: &mut AutoCommit,
    id: &str,
    input: &DirectionInput,
    now: Timestamp,
    kr_id: &mut dyn FnMut() -> Result<String>,
) -> Result<()> {
    validate(&input.year, &input.title, &input.key_results)?;
    let key = format!("{DIRECTION_PREFIX}{id}");
    let exists = get_obj(doc, &ROOT, &key).is_some();
    let same_year = read_directions(doc)
        .iter()
        .filter(|d| d.year == input.year && d.id != id)
        .count();
    if !exists && same_year >= MAX_DIRECTIONS_PER_YEAR {
        bail!("每年的公司方向最多 {MAX_DIRECTIONS_PER_YEAR} 個");
    }
    write_entry(
        doc,
        &key,
        &input.year,
        &input.title,
        None,
        &input.key_results,
        now,
        kr_id,
    )
}

pub fn write_team_goal(
    doc: &mut AutoCommit,
    id: &str,
    input: &TeamGoalInput,
    now: Timestamp,
    kr_id: &mut dyn FnMut() -> Result<String>,
) -> Result<()> {
    validate(&input.year, &input.title, &input.key_results)?;
    write_entry(
        doc,
        &format!("{GOAL_PREFIX}{id}"),
        &input.year,
        &input.title,
        input.direction_id.as_deref(),
        &input.key_results,
        now,
        kr_id,
    )
}

fn delete_key(doc: &mut AutoCommit, key: &str) -> Result<()> {
    if doc.get(ROOT, key)?.is_some() {
        doc.delete(ROOT, key)?;
    }
    Ok(())
}

fn avg(v: &[f64]) -> Option<f64> {
    (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64)
}

/// 方向與小組目標的進度（§16.14）。`plans` 是讀者看得到的計劃，`progress` 是其彙總進度。
#[derive(Debug, Default, Clone, PartialEq)]
pub struct DirectionProgress {
    pub directions: HashMap<String, f64>,
    pub team_goals: HashMap<String, f64>,
}

pub fn direction_progress(
    directions: &[Direction],
    goals: &[TeamGoal],
    plans: &[PlanItem],
    progress: &HashMap<String, f64>,
) -> DirectionProgress {
    let mut aligned: HashMap<&str, Vec<f64>> = HashMap::new();
    for p in plans {
        if matches!(p.level, PlanLevel::Year | PlanLevel::Quarter)
            && let Some(g) = p.aligned_goal_id.as_deref()
        {
            aligned
                .entry(g)
                .or_default()
                .push(progress.get(&p.id).copied().unwrap_or(0.0));
        }
    }
    let by_krs = |krs: &[KeyResult]| avg(&krs.iter().map(kr_value).collect::<Vec<_>>());
    let mut out = DirectionProgress::default();
    for g in goals {
        let v = by_krs(&g.key_results)
            .or_else(|| avg(aligned.get(g.id.as_str()).map_or(&[][..], |v| v)))
            .unwrap_or(0.0);
        out.team_goals.insert(g.id.clone(), v);
    }
    for d in directions {
        let v = by_krs(&d.key_results)
            .or_else(|| {
                let mut parts: Vec<f64> = goals
                    .iter()
                    .filter(|g| g.direction_id.as_deref() == Some(d.id.as_str()))
                    .map(|g| out.team_goals[&g.id])
                    .collect();
                if let Some(v) = aligned.get(d.id.as_str()) {
                    parts.extend(v);
                }
                avg(&parts)
            })
            .unwrap_or(0.0);
        out.directions.insert(d.id.clone(), v);
    }
    out
}

impl Node {
    pub fn directions(&self) -> Result<Vec<Direction>> {
        self.read_doc("org", read_directions)
    }

    /// 所有小組的小組目標（全員可讀）。
    pub fn team_goals(&self) -> Result<Vec<TeamGoal>> {
        let teams: Vec<String> = self.org().teams.keys().cloned().collect();
        let ids = self.inner.store.doc_ids()?;
        let mut out = Vec::new();
        for t in teams {
            let doc = team_goals_doc(&t);
            if ids.contains(&doc) {
                out.extend(self.read_doc(&doc, |d| read_team_goals(d, &t))?);
            }
        }
        Ok(out)
    }

    /// `alignedGoalId` 是否指向存在的公司方向或小組目標。
    pub fn alignable_goal_exists(&self, id: &str) -> Result<bool> {
        Ok(self.directions()?.iter().any(|d| d.id == id)
            || self.team_goals()?.iter().any(|g| g.id == id))
    }

    fn can_write_team_goals(&self, team: &str, me: &MemberId) -> bool {
        self.is_admin()
            || self
                .org()
                .teams
                .get(team)
                .is_some_and(|t| t.leads.contains(me))
    }

    pub async fn save_direction(&self, input: DirectionInput) -> Result<String> {
        if !self.is_admin() {
            bail!("只有管理者可以設定公司方向");
        }
        let now = now_ms();
        let id = match input.id.as_deref().filter(|s| !s.is_empty()) {
            Some(id) => {
                if !self.directions()?.iter().any(|d| d.id == id) {
                    bail!("找不到這個公司方向");
                }
                id.to_owned()
            }
            None => crate::conv::ulid(now)?,
        };
        self.change("org", |doc| {
            write_direction(doc, &id, &input, now, &mut || crate::conv::ulid(now))
        })
        .await?;
        Ok(id)
    }

    pub async fn delete_direction(&self, id: &str) -> Result<()> {
        if !self.is_admin() {
            bail!("只有管理者可以設定公司方向");
        }
        self.change("org", |doc| {
            delete_key(doc, &format!("{DIRECTION_PREFIX}{id}"))
        })
        .await
    }

    pub async fn save_team_goal(&self, input: TeamGoalInput) -> Result<String> {
        let me = self.member_id();
        if !self.org().teams.contains_key(&input.team) {
            bail!("找不到這個小組");
        }
        if !self.can_write_team_goals(&input.team, &me) {
            bail!("只有小組負責人可以設定小組目標");
        }
        if let Some(d) = input.direction_id.as_deref().filter(|s| !s.is_empty()) {
            let dirs = self.directions()?;
            let dir = dirs
                .iter()
                .find(|x| x.id == d)
                .ok_or_else(|| anyhow!("找不到這個公司方向"))?;
            if dir.year != input.year {
                bail!("公司方向與小組目標的年份不同");
            }
        }
        let now = now_ms();
        let id = match input.id.as_deref().filter(|s| !s.is_empty()) {
            Some(id) => {
                if !self
                    .team_goals()?
                    .iter()
                    .any(|g| g.id == id && g.team == input.team)
                {
                    bail!("找不到這個小組目標");
                }
                id.to_owned()
            }
            None => crate::conv::ulid(now)?,
        };
        self.change(&team_goals_doc(&input.team), |doc| {
            write_team_goal(doc, &id, &input, now, &mut || crate::conv::ulid(now))
        })
        .await?;
        Ok(id)
    }

    pub async fn delete_team_goal(&self, team: &str, id: &str) -> Result<()> {
        if !self.can_write_team_goals(team, &self.member_id()) {
            bail!("只有小組負責人可以設定小組目標");
        }
        self.change(&team_goals_doc(team), |doc| {
            delete_key(doc, &format!("{GOAL_PREFIX}{id}"))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plans::Visibility;

    fn ids() -> impl FnMut() -> Result<String> {
        let mut n = 0;
        move || {
            n += 1;
            Ok(format!("k{n}"))
        }
    }

    fn dinput(year: &str, title: &str) -> DirectionInput {
        DirectionInput {
            id: None,
            year: year.into(),
            title: title.into(),
            key_results: vec![],
        }
    }

    #[test]
    fn write_read_directions_and_goals() {
        let mut doc = AutoCommit::new();
        write_direction(
            &mut doc,
            "d1",
            &dinput("2027", " Hills 日常化 "),
            5,
            &mut ids(),
        )
        .unwrap();
        let d = read_directions(&doc);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].title, "Hills 日常化");
        assert_eq!(d[0].created_at, 5);

        let mut g = AutoCommit::new();
        let input = TeamGoalInput {
            id: None,
            team: "t1".into(),
            year: "2027".into(),
            title: "M2 手機版".into(),
            direction_id: Some("d1".into()),
            key_results: vec![],
        };
        write_team_goal(&mut g, "g1", &input, 7, &mut ids()).unwrap();
        let goals = read_team_goals(&g, "t1");
        assert_eq!(goals[0].direction_id.as_deref(), Some("d1"));
        assert_eq!(goals[0].team, "t1");
        // 取消對齊
        let input = TeamGoalInput {
            direction_id: None,
            ..input
        };
        write_team_goal(&mut g, "g1", &input, 8, &mut ids()).unwrap();
        assert_eq!(read_team_goals(&g, "t1")[0].direction_id, None);
        assert_eq!(read_team_goals(&g, "t1")[0].created_at, 7);
        delete_key(&mut g, "goal:g1").unwrap();
        assert!(read_team_goals(&g, "t1").is_empty());
    }

    #[test]
    fn validation_and_limits() {
        let mut doc = AutoCommit::new();
        assert!(write_direction(&mut doc, "x", &dinput("27", "a"), 1, &mut ids()).is_err());
        assert!(write_direction(&mut doc, "x", &dinput("2027", " "), 1, &mut ids()).is_err());
        let long = "字".repeat(81);
        assert!(write_direction(&mut doc, "x", &dinput("2027", &long), 1, &mut ids()).is_err());
        for i in 0..5 {
            write_direction(
                &mut doc,
                &format!("d{i}"),
                &dinput("2027", "a"),
                1,
                &mut ids(),
            )
            .unwrap();
        }
        assert!(write_direction(&mut doc, "d9", &dinput("2027", "a"), 1, &mut ids()).is_err());
        // 更新既有的不受上限影響；其他年份另計
        write_direction(&mut doc, "d0", &dinput("2027", "b"), 2, &mut ids()).unwrap();
        write_direction(&mut doc, "e0", &dinput("2028", "a"), 2, &mut ids()).unwrap();
    }

    fn plan(id: &str, level: PlanLevel, aligned: Option<&str>) -> PlanItem {
        PlanItem {
            id: id.into(),
            owner: MemberId([1; 16]),
            visibility: Visibility::Org,
            level,
            period: String::new(),
            title: id.into(),
            parent_id: None,
            kr_ref: None,
            done: false,
            progress_override: None,
            key_results: vec![],
            aligned_goal_id: aligned.map(Into::into),
            criteria: vec![],
            helps: vec![],
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn progress_rules() {
        let d = |id: &str| Direction {
            id: id.into(),
            year: "2027".into(),
            title: id.into(),
            key_results: vec![],
            created_at: 0,
            updated_at: 0,
        };
        let g = |id: &str, dir: Option<&str>| TeamGoal {
            id: id.into(),
            team: "t1".into(),
            year: "2027".into(),
            title: id.into(),
            direction_id: dir.map(Into::into),
            key_results: vec![],
            created_at: 0,
            updated_at: 0,
        };
        let plans = vec![
            plan("y1", PlanLevel::Year, Some("g1")),
            plan("q1", PlanLevel::Quarter, Some("g1")),
            plan("y2", PlanLevel::Year, Some("d1")),
            // 月目標不算對齊
            plan("m1", PlanLevel::Month, Some("g1")),
        ];
        let progress: HashMap<String, f64> =
            [("y1", 40.0), ("q1", 80.0), ("y2", 20.0), ("m1", 0.0)]
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect();
        let mut kr_goal = g("g3", None);
        kr_goal.key_results = vec![KeyResult {
            id: "k".into(),
            title: "k".into(),
            start: 0.0,
            target: 10.0,
            current: 5.0,
            unit: String::new(),
            manual: true,
        }];
        let r = direction_progress(
            &[d("d1"), d("d2")],
            &[g("g1", Some("d1")), g("g2", Some("d1")), kr_goal],
            &plans,
            &progress,
        );
        assert_eq!(r.team_goals["g1"], 60.0);
        assert_eq!(r.team_goals["g2"], 0.0);
        assert_eq!(r.team_goals["g3"], 50.0);
        // d1 = (g1 60 + g2 0 + y2 20) / 3
        assert!((r.directions["d1"] - 80.0 / 3.0).abs() < 1e-9);
        assert_eq!(r.directions["d2"], 0.0);
    }
}
