//! OGSM（technical-design §16.14 v0.35，feature-plan D65）。
//!
//! - 公司目的：org 文件 `purpose`（JSON 字串），只有管理者可寫。
//! - 小組目的與策略：`team-goals/<teamId>` 的 `purpose`、`strategy:<ULID>`（JSON 字串），
//!   該小組負責人或管理者可寫（同小組目標，驗證層 `DocKind::TeamGoals`）。
//! - 衡量放在策略裡；進度在投影層計算，不設紅黃綠門檻。

use std::collections::{HashMap, HashSet};

use anyhow::{Result, bail};
use automerge::{AutoCommit, ROOT, ReadDoc, transaction::Transactable};
use hills_proto::{MemberId, Timestamp};
use serde::{Deserialize, Serialize};

use crate::direction::{TeamGoal, team_goals_doc};
use crate::node::{Node, now_ms};
use crate::org::get_str;
use crate::plans::kr_value;

const PURPOSE: &str = "purpose";
const STRATEGY_PREFIX: &str = "strategy:";
const MAX_PURPOSE_TITLE: usize = 120;
const MAX_WHY: usize = 1000;
const MAX_PERIOD: usize = 20;
const MAX_TITLE: usize = 80;
const MAX_HOW: usize = 300;
const MAX_GOALS: usize = 5;
const MAX_OWNERS: usize = 10;
const MAX_MEASURES: usize = 5;
const MAX_UNIT: usize = 10;
const MAX_STRATEGIES: usize = 10;

/// 目的（公司或小組）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Purpose {
    pub title: String,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub period: String,
    /// 小組目的服務的公司目標（公司目的不用）
    #[serde(default)]
    pub goal_ids: Vec<String>,
    #[serde(default)]
    pub updated_at: Timestamp,
    #[serde(default)]
    pub updated_by: String,
    /// 讀取時填入：小組 id（公司目的為 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
}

/// 衡量的來源。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MeasureSource {
    #[serde(rename_all = "camelCase")]
    Goal {
        goal_id: String,
        #[serde(default)]
        kr_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Manual {
        current: f64,
        target: f64,
        #[serde(default)]
        unit: Option<String>,
        #[serde(default)]
        updated_at: Timestamp,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measure {
    pub id: String,
    pub title: String,
    pub source: MeasureSource,
}

/// 策略（存在 `team-goals/<teamId>` 的 `strategy:<id>`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Strategy {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub team: String,
    pub title: String,
    #[serde(default)]
    pub how: Option<String>,
    pub goal_ids: Vec<String>,
    #[serde(default)]
    pub owners: Vec<String>,
    #[serde(default)]
    pub measures: Vec<Measure>,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub created_at: Timestamp,
    #[serde(default)]
    pub updated_at: Timestamp,
}

/// 目的的輸入。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurposeInput {
    pub title: String,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub period: String,
    #[serde(default)]
    pub goal_ids: Vec<String>,
}

/// 策略的輸入（`id` 為空時新增；衡量的 `id` 為空時新增）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyInput {
    #[serde(default)]
    pub id: Option<String>,
    pub team: String,
    pub title: String,
    #[serde(default)]
    pub how: Option<String>,
    pub goal_ids: Vec<String>,
    #[serde(default)]
    pub owners: Vec<String>,
    #[serde(default)]
    pub measures: Vec<Measure>,
    #[serde(default)]
    pub order: Option<i64>,
}

/// 讀取用：策略與計算後的進度。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyView {
    #[serde(flatten)]
    pub item: Strategy,
    pub progress: f64,
    /// 與 `measures` 同序
    pub measure_progress: Vec<f64>,
}

fn chars(s: &str) -> usize {
    s.trim().chars().count()
}

pub fn validate_purpose(p: &PurposeInput, team: bool) -> Result<()> {
    let n = chars(&p.title);
    if n == 0 || n > MAX_PURPOSE_TITLE {
        bail!("目的需為 1–{MAX_PURPOSE_TITLE} 字");
    }
    if chars(&p.why) > MAX_WHY {
        bail!("「為什麼」最多 {MAX_WHY} 字");
    }
    if chars(&p.period) > MAX_PERIOD {
        bail!("期間最多 {MAX_PERIOD} 字");
    }
    if !team && !p.goal_ids.is_empty() {
        bail!("公司目的不連到目標");
    }
    if p.goal_ids.len() > MAX_GOALS {
        bail!("最多連到 {MAX_GOALS} 個公司目標");
    }
    Ok(())
}

/// 檢查策略；`goals` 是同一小組現存的小組目標，`members` 是該小組成員。
pub fn validate_strategy(
    s: &StrategyInput,
    goals: &[TeamGoal],
    members: &HashSet<String>,
) -> Result<()> {
    let n = chars(&s.title);
    if n == 0 || n > MAX_TITLE {
        bail!("策略需為 1–{MAX_TITLE} 字");
    }
    if s.how.as_deref().map_or(0, chars) > MAX_HOW {
        bail!("做法最多 {MAX_HOW} 字");
    }
    if s.goal_ids.is_empty() || s.goal_ids.len() > MAX_GOALS {
        bail!("策略要連到 1–{MAX_GOALS} 個小組目標");
    }
    let mine: HashMap<&str, &TeamGoal> = goals
        .iter()
        .filter(|g| g.team == s.team)
        .map(|g| (g.id.as_str(), g))
        .collect();
    if s.goal_ids.iter().any(|g| !mine.contains_key(g.as_str())) {
        bail!("找不到這個小組目標");
    }
    if s.owners.len() > MAX_OWNERS {
        bail!("負責的人最多 {MAX_OWNERS} 位");
    }
    if s.owners.iter().any(|o| !members.contains(o)) {
        bail!("負責的人必須是這個小組的成員");
    }
    if s.measures.len() > MAX_MEASURES {
        bail!("每個策略最多 {MAX_MEASURES} 個衡量");
    }
    for m in &s.measures {
        let n = chars(&m.title);
        if n == 0 || n > MAX_TITLE {
            bail!("衡量需為 1–{MAX_TITLE} 字");
        }
        match &m.source {
            MeasureSource::Goal { goal_id, kr_id } => {
                let g = mine
                    .get(goal_id.as_str())
                    .ok_or_else(|| anyhow::anyhow!("找不到這個小組目標"))?;
                if let Some(k) = kr_id
                    && !g.key_results.iter().any(|x| &x.id == k)
                {
                    bail!("找不到這個關鍵結果");
                }
            }
            MeasureSource::Manual {
                current,
                target,
                unit,
                ..
            } => {
                if !current.is_finite() || !target.is_finite() || *target <= 0.0 {
                    bail!("目標值需大於 0");
                }
                if unit.as_deref().map_or(0, chars) > MAX_UNIT {
                    bail!("單位最多 {MAX_UNIT} 字");
                }
            }
        }
    }
    Ok(())
}

pub fn read_purpose(doc: &AutoCommit, team: Option<&str>) -> Option<Purpose> {
    let mut p: Purpose = serde_json::from_str(&get_str(doc, &ROOT, PURPOSE)?).ok()?;
    p.team = team.map(str::to_owned);
    Some(p)
}

pub fn write_purpose(
    doc: &mut AutoCommit,
    input: &PurposeInput,
    me: &MemberId,
    now: Timestamp,
) -> Result<()> {
    let p = Purpose {
        title: input.title.trim().to_owned(),
        why: input.why.trim().to_owned(),
        period: input.period.trim().to_owned(),
        goal_ids: input.goal_ids.clone(),
        updated_at: now,
        updated_by: me.to_string(),
        team: None,
    };
    doc.put(ROOT, PURPOSE, serde_json::to_string(&p)?)?;
    Ok(())
}

pub fn read_strategies(doc: &AutoCommit, team: &str) -> Vec<Strategy> {
    let mut v: Vec<Strategy> = doc
        .keys(ROOT)
        .filter_map(|k| {
            let id = k.strip_prefix(STRATEGY_PREFIX)?.to_owned();
            let mut s: Strategy = serde_json::from_str(&get_str(doc, &ROOT, &k)?).ok()?;
            s.id = id;
            s.team = team.to_owned();
            Some(s)
        })
        .collect();
    v.sort_by(|a, b| (a.order, a.created_at, &a.id).cmp(&(b.order, b.created_at, &b.id)));
    v
}

pub fn write_strategy(
    doc: &mut AutoCommit,
    id: &str,
    input: &StrategyInput,
    now: Timestamp,
    new_id: &mut dyn FnMut() -> Result<String>,
) -> Result<()> {
    let key = format!("{STRATEGY_PREFIX}{id}");
    let prev: Option<Strategy> =
        get_str(doc, &ROOT, &key).and_then(|s| serde_json::from_str(&s).ok());
    let count = doc
        .keys(ROOT)
        .filter(|k| k.starts_with(STRATEGY_PREFIX))
        .count();
    if prev.is_none() && count >= MAX_STRATEGIES {
        bail!("每個小組最多 {MAX_STRATEGIES} 個策略");
    }
    let mut measures = Vec::with_capacity(input.measures.len());
    for m in &input.measures {
        let mut m = m.clone();
        if m.id.is_empty() {
            m.id = new_id()?;
        }
        m.title = m.title.trim().to_owned();
        if let MeasureSource::Manual { updated_at, .. } = &mut m.source {
            *updated_at = now;
        }
        measures.push(m);
    }
    let s = Strategy {
        id: String::new(),
        team: String::new(),
        title: input.title.trim().to_owned(),
        how: input
            .how
            .as_deref()
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(str::to_owned),
        goal_ids: input.goal_ids.clone(),
        owners: input.owners.clone(),
        measures,
        order: input
            .order
            .or(prev.as_ref().map(|p| p.order))
            .unwrap_or(count as i64),
        created_at: prev.as_ref().map_or(now, |p| p.created_at),
        updated_at: now,
    };
    doc.put(ROOT, key.as_str(), serde_json::to_string(&s)?)?;
    Ok(())
}

pub fn delete_strategy_in(doc: &mut AutoCommit, id: &str) -> Result<()> {
    let key = format!("{STRATEGY_PREFIX}{id}");
    if doc.get(ROOT, key.as_str())?.is_some() {
        doc.delete(ROOT, key.as_str())?;
    }
    Ok(())
}

fn avg(v: &[f64]) -> Option<f64> {
    (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64)
}

/// 一個衡量的進度（0–100）；參照不存在時 None。
pub fn measure_progress(
    m: &Measure,
    goals: &HashMap<&str, &TeamGoal>,
    goal_progress: &HashMap<String, f64>,
) -> Option<f64> {
    match &m.source {
        MeasureSource::Goal { goal_id, kr_id } => {
            let g = goals.get(goal_id.as_str())?;
            match kr_id {
                Some(k) => g.key_results.iter().find(|x| &x.id == k).map(kr_value),
                None => goal_progress.get(goal_id).copied(),
            }
        }
        MeasureSource::Manual {
            current, target, ..
        } => (*target > 0.0).then(|| (current / target * 100.0).clamp(0.0, 100.0)),
    }
}

/// 策略進度 = 衡量平均；沒有可用的衡量時 = 所連小組目標進度平均。
pub fn strategy_views(
    strategies: Vec<Strategy>,
    goals: &[TeamGoal],
    goal_progress: &HashMap<String, f64>,
) -> Vec<StrategyView> {
    let by_id: HashMap<&str, &TeamGoal> = goals.iter().map(|g| (g.id.as_str(), g)).collect();
    strategies
        .into_iter()
        .map(|mut s| {
            s.goal_ids.retain(|g| by_id.contains_key(g.as_str()));
            let mp: Vec<Option<f64>> = s
                .measures
                .iter()
                .map(|m| measure_progress(m, &by_id, goal_progress))
                .collect();
            let known: Vec<f64> = mp.iter().flatten().copied().collect();
            let progress = avg(&known)
                .or_else(|| {
                    avg(&s
                        .goal_ids
                        .iter()
                        .filter_map(|g| goal_progress.get(g).copied())
                        .collect::<Vec<_>>())
                })
                .unwrap_or(0.0);
            StrategyView {
                measure_progress: mp.into_iter().map(|x| x.unwrap_or(0.0)).collect(),
                progress,
                item: s,
            }
        })
        .collect()
}

impl Node {
    pub fn org_purpose(&self) -> Result<Option<Purpose>> {
        self.read_doc("org", |d| read_purpose(d, None))
    }

    /// 各小組的目的與策略（全員可讀）。
    pub fn team_ogsm(&self) -> Result<(Vec<Purpose>, Vec<Strategy>)> {
        let teams: Vec<String> = self.org().teams.keys().cloned().collect();
        let ids = self.inner.store.doc_ids()?;
        let mut purposes = Vec::new();
        let mut strategies = Vec::new();
        for t in teams {
            let doc = team_goals_doc(&t);
            if ids.contains(&doc) {
                let (p, s) = self.read_doc(&doc, |d| {
                    (read_purpose(d, Some(&t)), read_strategies(d, &t))
                })?;
                purposes.extend(p);
                strategies.extend(s);
            }
        }
        Ok((purposes, strategies))
    }

    pub async fn save_org_purpose(&self, input: PurposeInput) -> Result<()> {
        if !self.is_admin() {
            bail!("只有管理者可以寫公司目的");
        }
        validate_purpose(&input, false)?;
        let me = self.member_id();
        let now = now_ms();
        self.change("org", |doc| write_purpose(doc, &input, &me, now))
            .await
    }

    fn can_write_ogsm(&self, team: &str) -> Result<()> {
        let me = self.member_id();
        let org = self.org();
        let t = org
            .teams
            .get(team)
            .ok_or_else(|| anyhow::anyhow!("找不到這個小組"))?;
        if !(self.is_admin() || t.leads.contains(&me)) {
            bail!("只有小組負責人可以編輯小組的目的、策略與衡量");
        }
        Ok(())
    }

    pub async fn save_team_purpose(&self, team: &str, input: PurposeInput) -> Result<()> {
        self.can_write_ogsm(team)?;
        validate_purpose(&input, true)?;
        let dirs = self.directions()?;
        if input
            .goal_ids
            .iter()
            .any(|g| !dirs.iter().any(|d| &d.id == g))
        {
            bail!("找不到這個公司目標");
        }
        let me = self.member_id();
        let now = now_ms();
        self.change(&team_goals_doc(team), |doc| {
            write_purpose(doc, &input, &me, now)
        })
        .await
    }

    pub async fn save_strategy(&self, input: StrategyInput) -> Result<String> {
        self.can_write_ogsm(&input.team)?;
        let org = self.org();
        let t = &org.teams[&input.team];
        let members: HashSet<String> = t
            .members
            .iter()
            .chain(t.leads.iter())
            .map(|m| m.to_string())
            .collect();
        let goals = self.team_goals()?;
        validate_strategy(&input, &goals, &members)?;
        let now = now_ms();
        let (_, existing) = self.team_ogsm()?;
        let id = match input.id.as_deref().filter(|s| !s.is_empty()) {
            Some(id) => {
                if !existing.iter().any(|s| s.id == id && s.team == input.team) {
                    bail!("找不到這個策略");
                }
                id.to_owned()
            }
            None => crate::conv::ulid(now)?,
        };
        self.change(&team_goals_doc(&input.team), |doc| {
            write_strategy(doc, &id, &input, now, &mut || crate::conv::ulid(now))
        })
        .await?;
        Ok(id)
    }

    pub async fn delete_strategy(&self, team: &str, id: &str) -> Result<()> {
        self.can_write_ogsm(team)?;
        self.change(&team_goals_doc(team), |doc| delete_strategy_in(doc, id))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plans::KeyResult;

    fn goal(id: &str, team: &str, krs: Vec<KeyResult>) -> TeamGoal {
        TeamGoal {
            id: id.into(),
            team: team.into(),
            year: "2026".into(),
            title: id.into(),
            direction_id: None,
            key_results: krs,
            criteria: vec![],
            created_at: 0,
            updated_at: 0,
        }
    }

    fn kr(id: &str, current: f64) -> KeyResult {
        KeyResult {
            id: id.into(),
            title: id.into(),
            start: 0.0,
            target: 10.0,
            current,
            unit: String::new(),
            manual: true,
        }
    }

    fn input(goals: &[&str], measures: Vec<Measure>) -> StrategyInput {
        StrategyInput {
            id: None,
            team: "eng".into(),
            title: " 先穩定桌機版 ".into(),
            how: Some("Mac / Windows 先".into()),
            goal_ids: goals.iter().map(|s| s.to_string()).collect(),
            owners: vec!["a".into()],
            measures,
            order: None,
        }
    }

    fn manual(id: &str, current: f64, target: f64) -> Measure {
        Measure {
            id: id.into(),
            title: "安裝成功率".into(),
            source: MeasureSource::Manual {
                current,
                target,
                unit: Some("%".into()),
                updated_at: 0,
            },
        }
    }

    #[test]
    fn validates_references_and_limits() {
        let goals = vec![
            goal("g1", "eng", vec![kr("k1", 5.0)]),
            goal("g2", "ops", vec![]),
        ];
        let members: HashSet<String> = ["a".to_string()].into();
        assert!(validate_strategy(&input(&["g1"], vec![]), &goals, &members).is_ok());
        // 其他小組的目標
        assert!(validate_strategy(&input(&["g2"], vec![]), &goals, &members).is_err());
        assert!(validate_strategy(&input(&[], vec![]), &goals, &members).is_err());
        let mut bad_owner = input(&["g1"], vec![]);
        bad_owner.owners = vec!["z".into()];
        assert!(validate_strategy(&bad_owner, &goals, &members).is_err());
        let bad_kr = Measure {
            id: String::new(),
            title: "x".into(),
            source: MeasureSource::Goal {
                goal_id: "g1".into(),
                kr_id: Some("nope".into()),
            },
        };
        assert!(validate_strategy(&input(&["g1"], vec![bad_kr]), &goals, &members).is_err());
        assert!(
            validate_strategy(
                &input(&["g1"], vec![manual("", 1.0, 0.0)]),
                &goals,
                &members
            )
            .is_err()
        );
        let p = PurposeInput {
            title: "讓每個人知道往哪走".into(),
            why: String::new(),
            period: "2026–2027".into(),
            goal_ids: vec!["d1".into()],
        };
        assert!(validate_purpose(&p, true).is_ok());
        assert!(validate_purpose(&p, false).is_err());
    }

    #[test]
    fn write_read_and_progress() {
        let mut doc = AutoCommit::new();
        let mut n = 0;
        let mut ids = move || {
            n += 1;
            Ok(format!("m{n}"))
        };
        let kr_measure = Measure {
            id: String::new(),
            title: "M1 驗收".into(),
            source: MeasureSource::Goal {
                goal_id: "g1".into(),
                kr_id: Some("k1".into()),
            },
        };
        write_strategy(
            &mut doc,
            "s1",
            &input(&["g1"], vec![kr_measure, manual("", 3.0, 4.0)]),
            7,
            &mut ids,
        )
        .unwrap();
        write_strategy(&mut doc, "s2", &input(&["g1", "gone"], vec![]), 8, &mut ids).unwrap();
        let s = read_strategies(&doc, "eng");
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].id, "s1");
        assert_eq!(s[0].title, "先穩定桌機版");
        assert_eq!(s[0].measures[0].id, "m1");
        assert_eq!(s[0].created_at, 7);

        let goals = vec![goal("g1", "eng", vec![kr("k1", 5.0)])];
        let gp: HashMap<String, f64> = [("g1".to_string(), 40.0)].into();
        let v = strategy_views(s, &goals, &gp);
        // KR 50%、手動 75% → 62.5
        assert_eq!(v[0].measure_progress, vec![50.0, 75.0]);
        assert!((v[0].progress - 62.5).abs() < 1e-9);
        // 沒有衡量 → 小組目標進度；不存在的目標被略過
        assert_eq!(v[1].progress, 40.0);
        assert_eq!(v[1].item.goal_ids, vec!["g1".to_string()]);

        let me = MemberId([2; 16]);
        let p = PurposeInput {
            title: " 目的 ".into(),
            why: "為什麼".into(),
            period: "2026".into(),
            goal_ids: vec![],
        };
        write_purpose(&mut doc, &p, &me, 9).unwrap();
        let back = read_purpose(&doc, Some("eng")).unwrap();
        assert_eq!(back.title, "目的");
        assert_eq!(back.team.as_deref(), Some("eng"));
        delete_strategy_in(&mut doc, "s2").unwrap();
        assert_eq!(read_strategies(&doc, "eng").len(), 1);
    }
}
