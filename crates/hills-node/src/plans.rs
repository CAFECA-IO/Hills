//! 五層計劃（目標「階梯」，technical-design §4.3、§16.10 v0.15，feature-plan §5.3、D8）。
//!
//! 每位成員的計劃依可見度分成多份文件：`member/<id>/plans/private`、`plans/team/<teamId>`、
//! `plans/org`，只有本人可寫。項目放在根物件 `item:<ULID>`。

use std::collections::{BTreeMap, BTreeSet, HashMap};

use anyhow::{Result, anyhow, bail};
use automerge::{
    AutoCommit, ObjId, ObjType, ROOT, ReadDoc, ScalarValue, Value, transaction::Transactable,
};
use hills_proto::{MemberId, Timestamp};
use hills_sync::{DocKind, MemberSection, PlanScope};
use serde::{Deserialize, Serialize};

use crate::node::{Node, now_ms};
use crate::org::{get_int, get_obj, get_str};

const ITEM_PREFIX: &str = "item:";
const MAX_TITLE: usize = 200;
const MAX_KRS: usize = 5;
const MAX_UNIT: usize = 16;
/// 「做到的標準」（D47）每則字數與數量上限
const MAX_CRITERION: usize = 80;
const MAX_CRITERIA: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanLevel {
    Year,
    Quarter,
    Month,
    Week,
    Day,
}

impl PlanLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Year => "year",
            Self::Quarter => "quarter",
            Self::Month => "month",
            Self::Week => "week",
            Self::Day => "day",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "year" => Self::Year,
            "quarter" => Self::Quarter,
            "month" => Self::Month,
            "week" => Self::Week,
            "day" => Self::Day,
            _ => return None,
        })
    }

    /// 年 / 季採 OKR（有關鍵結果），月 / 週 / 日為待辦。
    pub fn is_okr(self) -> bool {
        matches!(self, Self::Year | Self::Quarter)
    }
}

fn digits(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|c| c.is_ascii_digit())
}

fn in_range(s: &str, lo: u32, hi: u32) -> bool {
    s.parse::<u32>().is_ok_and(|v| (lo..=hi).contains(&v))
}

/// 期間格式是否與層級相符（§16.10）：`2026`、`2026-Q4`、`2026-11`、`2026-W45`、`2026-11-08`。
pub fn valid_period(level: PlanLevel, period: &str) -> bool {
    let parts: Vec<&str> = period.split('-').collect();
    match (level, parts.as_slice()) {
        (PlanLevel::Year, [y]) => digits(y, 4),
        (PlanLevel::Quarter, [y, q]) => {
            digits(y, 4) && q.len() == 2 && q.starts_with('Q') && in_range(&q[1..], 1, 4)
        }
        (PlanLevel::Month, [y, m]) => digits(y, 4) && digits(m, 2) && in_range(m, 1, 12),
        (PlanLevel::Week, [y, w]) => {
            digits(y, 4)
                && w.len() == 3
                && w.starts_with('W')
                && digits(&w[1..], 2)
                && in_range(&w[1..], 1, 53)
        }
        (PlanLevel::Day, [y, m, d]) => {
            digits(y, 4) && digits(m, 2) && in_range(m, 1, 12) && digits(d, 2) && in_range(d, 1, 31)
        }
        _ => false,
    }
}

/// 可見度（決定存放的文件與加密金鑰）。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", content = "team", rename_all = "lowercase")]
pub enum Visibility {
    Private,
    Team(String),
    Org,
}

impl Visibility {
    fn scope(&self) -> PlanScope {
        match self {
            Self::Private => PlanScope::Private,
            Self::Team(t) => PlanScope::Team(t.clone()),
            Self::Org => PlanScope::Org,
        }
    }

    fn of(scope: &PlanScope) -> Self {
        match scope {
            PlanScope::Private => Self::Private,
            PlanScope::Team(t) => Self::Team(t.clone()),
            PlanScope::Org => Self::Org,
        }
    }
}

pub fn plans_doc(owner: &MemberId, vis: &Visibility) -> String {
    format!("member/{owner}/plans/{}", vis.scope().path())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyResult {
    pub id: String,
    pub title: String,
    pub start: f64,
    pub target: f64,
    pub current: f64,
    pub unit: String,
    /// 目前值為手動輸入（否則由連結的待辦彙總）
    pub manual: bool,
}

/// 年 / 季目標「做到的標準」（D47，technical-design §16.10 v0.20）：純文字，不影響進度。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Criterion {
    #[serde(default)]
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    #[serde(serialize_with = "member_str")]
    pub owner: MemberId,
    pub visibility: Visibility,
    pub level: PlanLevel,
    pub period: String,
    pub title: String,
    pub parent_id: Option<String>,
    /// `<上層 planItemId>/<krId>`
    pub kr_ref: Option<String>,
    pub done: bool,
    pub progress_override: Option<u8>,
    pub key_results: Vec<KeyResult>,
    /// 對齊的公司方向或小組目標（年 / 季，D47）
    pub aligned_goal_id: Option<String>,
    pub criteria: Vec<Criterion>,
    /// 季目標幫助達成上層的哪些標準（criterion id）
    pub helps: Vec<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

fn member_str<S: serde::Serializer>(m: &MemberId, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&m.to_string())
}

/// 新增或更新的輸入。`id` 為空時新增。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    #[serde(default)]
    pub id: Option<String>,
    pub level: PlanLevel,
    pub period: String,
    pub title: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub kr_ref: Option<String>,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub progress_override: Option<u8>,
    #[serde(default)]
    pub key_results: Vec<KeyResult>,
    #[serde(default)]
    pub aligned_goal_id: Option<String>,
    #[serde(default)]
    pub criteria: Vec<Criterion>,
    #[serde(default)]
    pub helps: Vec<String>,
    pub visibility: Visibility,
}

fn get_f64(doc: &AutoCommit, obj: &ObjId, key: &str) -> f64 {
    match doc.get(obj, key).ok().flatten().map(|v| v.0) {
        Some(Value::Scalar(s)) => match s.as_ref() {
            ScalarValue::F64(f) => *f,
            ScalarValue::Int(i) => *i as f64,
            ScalarValue::Uint(u) => *u as f64,
            _ => 0.0,
        },
        _ => 0.0,
    }
}

fn get_bool(doc: &AutoCommit, obj: &ObjId, key: &str) -> bool {
    matches!(
        doc.get(obj, key).ok().flatten().map(|v| v.0),
        Some(Value::Scalar(s)) if matches!(s.as_ref(), ScalarValue::Boolean(true))
    )
}

pub(crate) fn read_krs(doc: &AutoCommit, item: &ObjId) -> Vec<KeyResult> {
    let Some(list) = get_obj(doc, item, "keyResults") else {
        return vec![];
    };
    (0..doc.length(&list))
        .filter_map(|i| match doc.get(&list, i).ok()?? {
            (Value::Object(ObjType::Map), id) => Some(id),
            _ => None,
        })
        .map(|k| KeyResult {
            id: get_str(doc, &k, "id").unwrap_or_default(),
            title: get_str(doc, &k, "title").unwrap_or_default(),
            start: get_f64(doc, &k, "start"),
            target: get_f64(doc, &k, "target"),
            current: get_f64(doc, &k, "current"),
            unit: get_str(doc, &k, "unit").unwrap_or_default(),
            manual: get_bool(doc, &k, "manual"),
        })
        .collect()
}

fn read_criteria(doc: &AutoCommit, item: &ObjId) -> Vec<Criterion> {
    let Some(list) = get_obj(doc, item, "criteria") else {
        return vec![];
    };
    (0..doc.length(&list))
        .filter_map(|i| match doc.get(&list, i).ok()?? {
            (Value::Object(ObjType::Map), id) => Some(id),
            _ => None,
        })
        .filter_map(|c| {
            Some(Criterion {
                id: get_str(doc, &c, "id")?,
                text: get_str(doc, &c, "text").unwrap_or_default(),
            })
        })
        .collect()
}

fn read_strs(doc: &AutoCommit, item: &ObjId, key: &str) -> Vec<String> {
    let Some(list) = get_obj(doc, item, key) else {
        return vec![];
    };
    (0..doc.length(&list))
        .filter_map(|i| match doc.get(&list, i).ok()??.0 {
            Value::Scalar(s) => match s.as_ref() {
                ScalarValue::Str(t) => Some(t.to_string()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// 讀出一份計劃文件的全部項目（格式不符的項目略過）。
pub fn read_items(doc: &AutoCommit, owner: &MemberId, vis: &Visibility) -> Vec<PlanItem> {
    doc.keys(ROOT)
        .filter_map(|k| {
            let id = k.strip_prefix(ITEM_PREFIX)?.to_owned();
            let o = get_obj(doc, &ROOT, &k)?;
            let level = PlanLevel::parse(&get_str(doc, &o, "level")?)?;
            // D46：日層級已取消，既有的日目標不再顯示
            if level == PlanLevel::Day {
                return None;
            }
            let period = get_str(doc, &o, "period")?;
            if !valid_period(level, &period) {
                return None;
            }
            Some(PlanItem {
                id,
                owner: *owner,
                visibility: vis.clone(),
                level,
                period,
                title: get_str(doc, &o, "title").unwrap_or_default(),
                parent_id: get_str(doc, &o, "parentId"),
                kr_ref: get_str(doc, &o, "krRef"),
                done: get_bool(doc, &o, "done"),
                progress_override: get_int(doc, &o, "progressOverride")
                    .map(|v| v.clamp(0, 100) as u8),
                key_results: if level.is_okr() {
                    read_krs(doc, &o)
                } else {
                    vec![]
                },
                aligned_goal_id: if level.is_okr() {
                    get_str(doc, &o, "alignedGoalId")
                } else {
                    None
                },
                criteria: if level.is_okr() {
                    read_criteria(doc, &o)
                } else {
                    vec![]
                },
                helps: if level == PlanLevel::Quarter {
                    read_strs(doc, &o, "helps")
                } else {
                    vec![]
                },
                created_at: get_int(doc, &o, "createdAt").unwrap_or(0),
                updated_at: get_int(doc, &o, "updatedAt").unwrap_or(0),
            })
        })
        .collect()
}

fn validate(input: &PlanInput) -> Result<()> {
    let n = input.title.trim().chars().count();
    if n == 0 || n > MAX_TITLE {
        bail!("目標標題需為 1–{MAX_TITLE} 字");
    }
    if input.level == PlanLevel::Day {
        bail!("日目標已改為任務（D46）");
    }
    if !valid_period(input.level, &input.period) {
        bail!("期間格式與層級不符");
    }
    if input.progress_override.is_some_and(|p| p > 100) {
        bail!("進度需為 0–100");
    }
    validate_krs(&input.key_results)?;
    if input.criteria.len() > MAX_CRITERIA {
        bail!("做到的標準最多 {MAX_CRITERIA} 個");
    }
    for c in &input.criteria {
        let n = c.text.trim().chars().count();
        if n == 0 || n > MAX_CRITERION {
            bail!("做到的標準需為 1–{MAX_CRITERION} 字");
        }
    }
    if input.helps.len() > MAX_CRITERIA {
        bail!("幫助達成的標準最多 {MAX_CRITERIA} 個");
    }
    Ok(())
}

/// 關鍵結果的數量、名稱與數值（計劃與 [`crate::direction`] 共用）。
pub(crate) fn validate_krs(krs: &[KeyResult]) -> Result<()> {
    if krs.len() > MAX_KRS {
        bail!("關鍵結果最多 {MAX_KRS} 個");
    }
    for k in krs {
        let n = k.title.trim().chars().count();
        if n == 0 || n > MAX_TITLE || k.unit.chars().count() > MAX_UNIT {
            bail!("關鍵結果名稱需為 1–{MAX_TITLE} 字，單位最多 {MAX_UNIT} 字");
        }
        if ![k.start, k.target, k.current].iter().all(|v| v.is_finite()) {
            bail!("關鍵結果數值無效");
        }
    }
    Ok(())
}

pub(crate) fn put_opt_str(
    doc: &mut AutoCommit,
    obj: &ObjId,
    key: &str,
    v: Option<&str>,
) -> Result<()> {
    match v.filter(|s| !s.is_empty()) {
        Some(s) => doc.put(obj, key, s)?,
        None => {
            if doc.get(obj, key)?.is_some() {
                doc.delete(obj, key)?;
            }
        }
    }
    Ok(())
}

/// 寫入（新增或整筆更新）一個項目；`created_at` 為既有項目的建立時間（搬移可見度時保留）。
pub fn write_item(
    doc: &mut AutoCommit,
    id: &str,
    input: &PlanInput,
    created_at: Timestamp,
    now: Timestamp,
    kr_id: &mut dyn FnMut() -> Result<String>,
) -> Result<()> {
    validate(input)?;
    let key = format!("{ITEM_PREFIX}{id}");
    let o = match get_obj(doc, &ROOT, &key) {
        Some(o) => o,
        None => {
            let o = doc.put_object(ROOT, key.as_str(), ObjType::Map)?;
            doc.put(&o, "createdAt", created_at)?;
            o
        }
    };
    doc.put(&o, "level", input.level.as_str())?;
    doc.put(&o, "period", input.period.as_str())?;
    doc.put(&o, "title", input.title.trim())?;
    put_opt_str(doc, &o, "parentId", input.parent_id.as_deref())?;
    let kr_ref = if input.level.is_okr() {
        None
    } else {
        input.kr_ref.as_deref()
    };
    put_opt_str(doc, &o, "krRef", kr_ref)?;
    doc.put(&o, "done", input.done && !input.level.is_okr())?;
    match input.progress_override {
        Some(p) => doc.put(&o, "progressOverride", i64::from(p))?,
        None => {
            if doc.get(&o, "progressOverride")?.is_some() {
                doc.delete(&o, "progressOverride")?;
            }
        }
    }
    let okr = input.level.is_okr();
    write_krs(doc, &o, if okr { &input.key_results } else { &[] }, kr_id)?;
    put_opt_str(
        doc,
        &o,
        "alignedGoalId",
        input.aligned_goal_id.as_deref().filter(|_| okr),
    )?;
    let list = doc.put_object(&o, "criteria", ObjType::List)?;
    if okr {
        for (i, c) in input.criteria.iter().enumerate() {
            let cid = if c.id.is_empty() {
                kr_id()?
            } else {
                c.id.clone()
            };
            let m = doc.insert_object(&list, i, ObjType::Map)?;
            doc.put(&m, "id", cid.as_str())?;
            doc.put(&m, "text", c.text.trim())?;
        }
    }
    let list = doc.put_object(&o, "helps", ObjType::List)?;
    if input.level == PlanLevel::Quarter {
        for (i, h) in input.helps.iter().enumerate() {
            doc.insert(&list, i, h.as_str())?;
        }
    }
    doc.put(&o, "updatedAt", now)?;
    Ok(())
}

/// 整筆替換關鍵結果清單（計劃與 [`crate::direction`] 共用）。
pub(crate) fn write_krs(
    doc: &mut AutoCommit,
    obj: &ObjId,
    krs: &[KeyResult],
    kr_id: &mut dyn FnMut() -> Result<String>,
) -> Result<()> {
    let list = doc.put_object(obj, "keyResults", ObjType::List)?;
    for (i, k) in krs.iter().enumerate() {
        let kid = if k.id.is_empty() {
            kr_id()?
        } else {
            k.id.clone()
        };
        let m = doc.insert_object(&list, i, ObjType::Map)?;
        doc.put(&m, "id", kid.as_str())?;
        doc.put(&m, "title", k.title.trim())?;
        doc.put(&m, "start", k.start)?;
        doc.put(&m, "target", k.target)?;
        doc.put(&m, "current", k.current)?;
        doc.put(&m, "unit", k.unit.trim())?;
        doc.put(&m, "manual", k.manual)?;
    }
    Ok(())
}

pub fn set_done(doc: &mut AutoCommit, id: &str, done: bool, now: Timestamp) -> Result<()> {
    let o =
        get_obj(doc, &ROOT, &format!("{ITEM_PREFIX}{id}")).ok_or_else(|| anyhow!("找不到目標"))?;
    doc.put(&o, "done", done)?;
    doc.put(&o, "updatedAt", now)?;
    Ok(())
}

pub fn delete_item(doc: &mut AutoCommit, id: &str) -> Result<()> {
    let key = format!("{ITEM_PREFIX}{id}");
    if doc.get(ROOT, key.as_str())?.is_some() {
        doc.delete(ROOT, key.as_str())?;
    }
    Ok(())
}

/// 同一 id 出現在多份文件（可見度搬移中）時取 `updated_at` 較新者。
pub fn dedup(items: Vec<PlanItem>) -> Vec<PlanItem> {
    let mut by: BTreeMap<(MemberId, String), PlanItem> = BTreeMap::new();
    for it in items {
        let k = (it.owner, it.id.clone());
        match by.get(&k) {
            Some(old) if old.updated_at >= it.updated_at => {}
            _ => {
                by.insert(k, it);
            }
        }
    }
    let mut out: Vec<PlanItem> = by.into_values().collect();
    out.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    out
}

fn pct(v: f64) -> f64 {
    v.clamp(0.0, 100.0)
}

pub(crate) fn kr_value(k: &KeyResult) -> f64 {
    let span = k.target - k.start;
    if span == 0.0 {
        if k.current >= k.target { 100.0 } else { 0.0 }
    } else {
        pct((k.current - k.start) / span * 100.0)
    }
}

/// 進度彙總結果（0–100）。
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Rollup {
    pub items: HashMap<String, f64>,
    /// key = `<itemId>/<krId>`
    pub krs: HashMap<String, f64>,
}

/// 依 §16.10 計算進度。只用讀者看得到的項目（傳入的 `items`）與任務。
/// `tasks` = (所屬週目標 id, 任務進度 0–100)，見 [`crate::team::Task::progress`]。
pub fn rollup(items: &[PlanItem], tasks: &[(String, f64)]) -> Rollup {
    let mut task_progress: HashMap<&str, Vec<f64>> = HashMap::new();
    for (p, v) in tasks {
        task_progress.entry(p.as_str()).or_default().push(*v);
    }
    let by_id: HashMap<&str, &PlanItem> = items.iter().map(|i| (i.id.as_str(), i)).collect();
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut linked: HashMap<&str, Vec<&str>> = HashMap::new();
    for i in items {
        if let Some(p) = i.parent_id.as_deref()
            && by_id.contains_key(p)
        {
            children.entry(p).or_default().push(&i.id);
        }
        if let Some(r) = i.kr_ref.as_deref() {
            linked.entry(r).or_default().push(&i.id);
        }
    }
    let mut out = Rollup::default();
    let mut visiting = BTreeSet::new();
    let ctx = Ctx {
        by_id: &by_id,
        children: &children,
        linked: &linked,
        tasks: &task_progress,
    };
    for i in items {
        item_progress(&i.id, &ctx, &mut out, &mut visiting);
    }
    out
}

struct Ctx<'a, 'b> {
    by_id: &'b HashMap<&'a str, &'a PlanItem>,
    children: &'b HashMap<&'a str, Vec<&'a str>>,
    linked: &'b HashMap<&'a str, Vec<&'a str>>,
    tasks: &'b HashMap<&'a str, Vec<f64>>,
}

fn avg(v: &[f64]) -> Option<f64> {
    (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64)
}

fn item_progress<'a>(
    id: &'a str,
    ctx: &Ctx<'a, '_>,
    out: &mut Rollup,
    visiting: &mut BTreeSet<&'a str>,
) -> f64 {
    if let Some(v) = out.items.get(id) {
        return *v;
    }
    let Some(item) = ctx.by_id.get(id) else {
        return 0.0;
    };
    // 防止 parentId 形成循環
    if !visiting.insert(id) {
        return 0.0;
    }
    let kids = |out: &mut Rollup, visiting: &mut BTreeSet<&'a str>, ids: &[&'a str]| -> Vec<f64> {
        ids.iter()
            .map(|c| item_progress(c, ctx, out, visiting))
            .collect()
    };
    let child_ids = ctx.children.get(id).cloned().unwrap_or_default();
    let auto = if item.level.is_okr() {
        let mut kr_vals = Vec::new();
        for k in &item.key_results {
            let key = format!("{}/{}", item.id, k.id);
            let v = if k.manual {
                kr_value(k)
            } else {
                match ctx.linked.get(key.as_str()) {
                    Some(ids) => avg(&kids(out, visiting, ids)).unwrap_or_else(|| kr_value(k)),
                    None => kr_value(k),
                }
            };
            out.krs.insert(key, v);
            kr_vals.push(v);
        }
        avg(&kr_vals)
            .or_else(|| avg(&kids(out, visiting, &child_ids)))
            .unwrap_or(0.0)
    } else {
        // 待辦（月 / 週）：子項目與連結的任務（週目標，D46）合併平均
        let mut parts = kids(out, visiting, &child_ids);
        if let Some(t) = ctx.tasks.get(id) {
            parts.extend(t.iter().copied());
        }
        match avg(&parts) {
            Some(v) => v,
            None if item.done => 100.0,
            None => 0.0,
        }
    };
    let v = item.progress_override.map_or(auto, f64::from);
    visiting.remove(id);
    out.items.insert(id.to_owned(), v);
    v
}

/// [`Node::plans`] 的範圍。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanQuery {
    /// 只有我的
    Mine,
    /// 我的，加上我能讀到的同事目標
    Visible,
}

impl Node {
    /// 我目前所屬小組的可見度選項與文件。
    fn my_plan_scopes(&self) -> Vec<Visibility> {
        let mut v = vec![Visibility::Private, Visibility::Org];
        v.extend(
            self.org()
                .teams_of(&self.member_id())
                .into_iter()
                .map(Visibility::Team),
        );
        v
    }

    /// 計劃項目（已去重）。`Visible` 另外列出本機已同步、我有權讀取的同事計劃文件。
    pub fn plans(&self, query: PlanQuery) -> Result<Vec<PlanItem>> {
        let me = self.member_id();
        let mut docs: BTreeSet<(MemberId, Visibility)> =
            self.my_plan_scopes().into_iter().map(|v| (me, v)).collect();
        // 我以前所屬小組的文件也算我的（離開小組後仍可搬移或刪除）
        let ids = self.inner.store.doc_ids()?;
        for id in &ids {
            if let Some(DocKind::Member {
                owner,
                section: MemberSection::Plans(scope),
            }) = DocKind::parse(id)
            {
                let vis = Visibility::of(&scope);
                if owner == me {
                    docs.insert((me, vis));
                } else if query == PlanQuery::Visible {
                    let readable = match &vis {
                        Visibility::Private => false,
                        Visibility::Org => true,
                        Visibility::Team(t) => self.org().teams_of(&me).contains(t),
                    };
                    if readable {
                        docs.insert((owner, vis));
                    }
                }
            }
        }
        let mut out = Vec::new();
        for (owner, vis) in docs {
            let id = plans_doc(&owner, &vis);
            if owner != me && !ids.contains(&id) {
                continue;
            }
            out.extend(self.read_doc(&id, |d| read_items(d, &owner, &vis))?);
        }
        Ok(dedup(out))
    }

    fn find_mine(&self, id: &str) -> Result<Option<PlanItem>> {
        Ok(self
            .plans(PlanQuery::Mine)?
            .into_iter()
            .find(|i| i.id == id))
    }

    /// 新增或更新目標（含可見度搬移），回傳 id。
    pub async fn save_plan(&self, input: PlanInput) -> Result<String> {
        validate(&input)?;
        if let Visibility::Team(t) = &input.visibility
            && !self.org().teams_of(&self.member_id()).contains(t)
        {
            bail!("你不是這個小組的成員");
        }
        if input.level.is_okr()
            && let Some(g) = input.aligned_goal_id.as_deref().filter(|s| !s.is_empty())
            && !self.alignable_goal_exists(g)?
        {
            bail!("找不到要對齊的方向或小組目標");
        }
        let me = self.member_id();
        let now = now_ms();
        let existing = match input.id.as_deref().filter(|s| !s.is_empty()) {
            Some(id) => Some(self.find_mine(id)?.ok_or_else(|| anyhow!("找不到目標"))?),
            None => None,
        };
        let id = match &existing {
            Some(e) => e.id.clone(),
            None => crate::conv::ulid(now)?,
        };
        if input.parent_id.as_deref() == Some(id.as_str()) {
            bail!("不能對齊自己");
        }
        let created_at = existing.as_ref().map_or(now, |e| e.created_at);
        let target = plans_doc(&me, &input.visibility);
        self.change(&target, |doc| {
            write_item(doc, &id, &input, created_at, now, &mut || {
                crate::conv::ulid(now)
            })
        })
        .await?;
        if let Some(e) = existing
            && e.visibility != input.visibility
        {
            self.change(&plans_doc(&me, &e.visibility), |doc| delete_item(doc, &id))
                .await?;
        }
        Ok(id)
    }

    pub async fn set_plan_done(&self, id: &str, done: bool) -> Result<()> {
        let item = self.find_mine(id)?.ok_or_else(|| anyhow!("找不到目標"))?;
        if item.level.is_okr() {
            bail!("年度與季度目標以關鍵結果計算進度");
        }
        let now = now_ms();
        self.change(&plans_doc(&self.member_id(), &item.visibility), |doc| {
            set_done(doc, id, done, now)
        })
        .await
    }

    pub async fn delete_plan(&self, id: &str) -> Result<()> {
        let item = self.find_mine(id)?.ok_or_else(|| anyhow!("找不到目標"))?;
        self.change(&plans_doc(&self.member_id(), &item.visibility), |doc| {
            delete_item(doc, id)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> MemberId {
        MemberId([1; 16])
    }

    fn input(level: PlanLevel, period: &str) -> PlanInput {
        PlanInput {
            id: None,
            level,
            period: period.into(),
            title: "目標".into(),
            parent_id: None,
            kr_ref: None,
            done: false,
            progress_override: None,
            key_results: vec![],
            aligned_goal_id: None,
            criteria: vec![],
            helps: vec![],
            visibility: Visibility::Org,
        }
    }

    fn kr(id: &str, start: f64, target: f64, current: f64, manual: bool) -> KeyResult {
        KeyResult {
            id: id.into(),
            title: id.into(),
            start,
            target,
            current,
            unit: String::new(),
            manual,
        }
    }

    fn item(id: &str, level: PlanLevel) -> PlanItem {
        PlanItem {
            id: id.into(),
            owner: me(),
            visibility: Visibility::Org,
            level,
            period: String::new(),
            title: id.into(),
            parent_id: None,
            kr_ref: None,
            done: false,
            progress_override: None,
            key_results: vec![],
            aligned_goal_id: None,
            criteria: vec![],
            helps: vec![],
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn periods() {
        use PlanLevel::*;
        for (l, p) in [
            (Year, "2026"),
            (Quarter, "2026-Q4"),
            (Month, "2026-11"),
            (Week, "2026-W45"),
            (Week, "2026-W53"),
            (Day, "2026-11-08"),
        ] {
            assert!(valid_period(l, p), "{p}");
        }
        for (l, p) in [
            (Year, "26"),
            (Quarter, "2026-Q5"),
            (Quarter, "2026-4"),
            (Month, "2026-13"),
            (Month, "2026-1"),
            (Week, "2026-W54"),
            (Week, "2026-W5"),
            (Day, "2026-11-32"),
            (Day, "2026-11"),
            (Month, "2026-Q4"),
        ] {
            assert!(!valid_period(l, p), "{p}");
        }
    }

    #[test]
    fn write_read_and_done() {
        let mut doc = AutoCommit::new();
        let mut q = input(PlanLevel::Quarter, "2026-Q4");
        let mut k = kr("", 0.0, 28.0, 18.0, true);
        k.title = "M1 功能".into();
        q.key_results = vec![k];
        q.done = true; // 季目標的 done 忽略
        let mut n = 0;
        write_item(&mut doc, "q1", &q, 5, 10, &mut || {
            n += 1;
            Ok(format!("kr{n}"))
        })
        .unwrap();
        let mut d = input(PlanLevel::Week, "2026-W45");
        d.parent_id = Some("q1".into());
        d.kr_ref = Some("q1/kr1".into());
        write_item(&mut doc, "d1", &d, 6, 11, &mut || Ok("x".into())).unwrap();
        set_done(&mut doc, "d1", true, 12).unwrap();
        let items = read_items(&doc, &me(), &Visibility::Org);
        assert_eq!(items.len(), 2);
        let q = items.iter().find(|i| i.id == "q1").unwrap();
        assert!(!q.done);
        assert_eq!(q.key_results[0].id, "kr1");
        assert_eq!(q.created_at, 5);
        let d = items.iter().find(|i| i.id == "d1").unwrap();
        assert!(d.done);
        assert_eq!(d.kr_ref.as_deref(), Some("q1/kr1"));
        assert_eq!(d.updated_at, 12);
        delete_item(&mut doc, "d1").unwrap();
        assert_eq!(read_items(&doc, &me(), &Visibility::Org).len(), 1);
    }

    #[test]
    fn alignment_criteria_and_helps() {
        let mut doc = AutoCommit::new();
        let mut n = 0;
        let mut ids = move || {
            n += 1;
            Ok(format!("c{n}"))
        };
        let mut y = input(PlanLevel::Year, "2027");
        y.aligned_goal_id = Some("g1".into());
        y.criteria = vec![Criterion {
            id: String::new(),
            text: " 80% 同事在用 ".into(),
        }];
        y.helps = vec!["x".into()]; // 年目標不存 helps
        write_item(&mut doc, "y", &y, 1, 1, &mut ids).unwrap();
        let mut q = input(PlanLevel::Quarter, "2027-Q1");
        q.helps = vec!["c1".into()];
        write_item(&mut doc, "q", &q, 1, 1, &mut ids).unwrap();
        let mut m = input(PlanLevel::Month, "2027-01");
        m.aligned_goal_id = Some("g1".into()); // 月目標不能對齊方向
        m.criteria = y.criteria.clone();
        write_item(&mut doc, "m", &m, 1, 1, &mut ids).unwrap();
        let items = read_items(&doc, &me(), &Visibility::Org);
        let get = |id: &str| items.iter().find(|i| i.id == id).unwrap();
        assert_eq!(get("y").aligned_goal_id.as_deref(), Some("g1"));
        assert_eq!(get("y").criteria[0].text, "80% 同事在用");
        assert_eq!(get("y").criteria[0].id, "c1");
        assert!(get("y").helps.is_empty());
        assert_eq!(get("q").helps, vec!["c1".to_string()]);
        assert_eq!(get("m").aligned_goal_id, None);
        assert!(get("m").criteria.is_empty());
        // 取消對齊
        y.aligned_goal_id = None;
        y.criteria[0].id = "c1".into();
        write_item(&mut doc, "y", &y, 1, 2, &mut ids).unwrap();
        let items = read_items(&doc, &me(), &Visibility::Org);
        assert_eq!(
            items.iter().find(|i| i.id == "y").unwrap().aligned_goal_id,
            None
        );
        // 標準的字數與數量
        let mut bad = input(PlanLevel::Year, "2027");
        bad.criteria = vec![Criterion {
            id: String::new(),
            text: " ".into(),
        }];
        assert!(write_item(&mut doc, "b", &bad, 1, 1, &mut ids).is_err());
        bad.criteria = (0..6)
            .map(|i| Criterion {
                id: String::new(),
                text: format!("{i}"),
            })
            .collect();
        assert!(write_item(&mut doc, "b", &bad, 1, 1, &mut ids).is_err());
    }

    #[test]
    fn day_items_are_hidden() {
        // 既有的日目標（D46 之前寫入）讀取時略過
        let mut doc = AutoCommit::new();
        let o = doc.put_object(ROOT, "item:d0", ObjType::Map).unwrap();
        doc.put(&o, "level", "day").unwrap();
        doc.put(&o, "period", "2026-11-08").unwrap();
        doc.put(&o, "title", "舊的日目標").unwrap();
        assert!(read_items(&doc, &me(), &Visibility::Org).is_empty());
    }

    #[test]
    fn validation() {
        let mut bad = input(PlanLevel::Month, "2026-W45");
        assert!(validate(&bad).is_err());
        bad.period = "2026-11".into();
        bad.title = " ".into();
        assert!(validate(&bad).is_err());
        assert!(
            validate(&input(PlanLevel::Day, "2026-11-08")).is_err(),
            "D46 不再寫入日目標"
        );
        let mut q = input(PlanLevel::Quarter, "2026-Q4");
        q.key_results = (0..6)
            .map(|i| kr(&i.to_string(), 0.0, 1.0, 0.0, true))
            .collect();
        assert!(validate(&q).is_err());
        q.key_results = vec![kr("a", 0.0, f64::NAN, 0.0, true)];
        assert!(validate(&q).is_err());
    }

    #[test]
    fn dedup_prefers_newer() {
        let mut a = item("x", PlanLevel::Week);
        a.updated_at = 1;
        a.visibility = Visibility::Org;
        let mut b = a.clone();
        b.updated_at = 2;
        b.visibility = Visibility::Private;
        let out = dedup(vec![a, b]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].visibility, Visibility::Private);
    }

    #[test]
    fn rollup_rules() {
        use PlanLevel::*;
        // 季目標：KR1 手動 18/28，KR2 由兩個月待辦彙總（一個完成）
        let mut q = item("q", Quarter);
        q.key_results = vec![
            kr("k1", 0.0, 28.0, 14.0, true),
            kr("k2", 0.0, 1.0, 0.0, false),
        ];
        let mut m1 = item("m1", Month);
        m1.parent_id = Some("q".into());
        m1.kr_ref = Some("q/k2".into());
        m1.done = true;
        let mut m2 = item("m2", Month);
        m2.parent_id = Some("q".into());
        m2.kr_ref = Some("q/k2".into());
        // 週目標有任務：一個完成（100）、一個 0 → 50（D46）
        let mut w = item("w", Week);
        w.parent_id = Some("m2".into());
        let tasks = vec![("w".to_string(), 100.0), ("w".to_string(), 0.0)];
        let r = rollup(&[q.clone(), m1, m2, w], &tasks);
        assert_eq!(r.items["w"], 50.0);
        assert_eq!(r.items["m2"], 50.0, "有子項目時用子項目平均（忽略 done）");
        assert_eq!(r.krs["q/k1"], 50.0);
        assert_eq!(r.krs["q/k2"], 75.0);
        assert_eq!(r.items["q"], 62.5);
        // 覆寫優先
        let mut q2 = q.clone();
        q2.progress_override = Some(90);
        assert_eq!(rollup(&[q2], &[]).items["q"], 90.0);
        // 沒有 KR、沒有子項目 → 0；沒有 KR 有子項目 → 子項目平均
        let y = item("y", Year);
        let mut q3 = item("q3", Quarter);
        q3.parent_id = Some("y".into());
        q3.progress_override = Some(40);
        let r = rollup(&[y, q3], &[]);
        assert_eq!(r.items["y"], 40.0);
        assert_eq!(rollup(&[item("z", Year)], &[]).items["z"], 0.0);
        // 週目標沒有任務 → 依 done；有任務時忽略 done、依步驟比例；覆寫優先
        let mut w2 = item("w2", Week);
        w2.done = true;
        assert_eq!(rollup(&[w2.clone()], &[]).items["w2"], 100.0);
        assert_eq!(
            rollup(&[w2.clone()], &[("w2".into(), 25.0)]).items["w2"],
            25.0
        );
        w2.progress_override = Some(70);
        assert_eq!(rollup(&[w2], &[("w2".into(), 25.0)]).items["w2"], 70.0);
        // 起始值等於目標值、超出範圍會被限制
        assert_eq!(kr_value(&kr("a", 5.0, 5.0, 5.0, true)), 100.0);
        assert_eq!(kr_value(&kr("a", 0.0, 10.0, 20.0, true)), 100.0);
        assert_eq!(kr_value(&kr("a", 10.0, 0.0, 5.0, true)), 50.0, "遞減目標");
    }

    #[test]
    fn view_json_shape() {
        let mut i = item("a", PlanLevel::Week);
        i.visibility = Visibility::Team("t1".into());
        let v = serde_json::to_value(&i).unwrap();
        assert_eq!(v["owner"], me().to_string());
        assert_eq!(
            v["visibility"],
            serde_json::json!({"kind": "team", "team": "t1"})
        );
        assert_eq!(v["level"], "week");
        let p: PlanInput = serde_json::from_value(serde_json::json!({
            "level": "week", "period": "2026-W45", "title": "x",
            "visibility": {"kind": "private"}
        }))
        .unwrap();
        assert_eq!(p.visibility, Visibility::Private);
    }

    #[test]
    fn rollup_survives_cycles() {
        let mut a = item("a", PlanLevel::Week);
        a.parent_id = Some("b".into());
        let mut b = item("b", PlanLevel::Week);
        b.parent_id = Some("a".into());
        let r = rollup(&[a, b], &[]);
        assert!(r.items.contains_key("a") && r.items.contains_key("b"));
    }
}
