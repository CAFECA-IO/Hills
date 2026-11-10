//! 計時與工作紀錄（technical-design §16.18 v0.34，D62）。
//!
//! - `member/<id>/timer`（PK，只有本人）：目前計時狀態 `running` 與原始片段 `seg:<ULID>`。
//! - `member/<id>/worklog/<yyyy-mm>`（WK，本人與本人所屬小組的負責人）：每天整理後的逐筆時間
//!   `day:<yyyy-mm-dd>` 與週計劃快照 `plan:<YYYY-Www>`。
//! - WK 由本人的裝置產生、交接給負責人；有負責人卸任時由本人輪替。

use std::collections::BTreeSet;

use anyhow::{Result, bail};
use automerge::{AutoCommit, ROOT, ReadDoc, transaction::Transactable};
use hills_crypto::{rotate, wrap_key};
use hills_identity::trust::TrustStore;
use hills_proto::gossip::PresenceState;
use hills_proto::{KeyFamily, MemberId, Pub32, Timestamp};
use serde::{Deserialize, Serialize};

use crate::node::{Inner, Node, lock, now_ms};
use crate::org::get_str;

const RUNNING: &str = "running";
const SEG_PREFIX: &str = "seg:";
const DAY_PREFIX: &str = "day:";
const PLAN_PREFIX: &str = "plan:";
/// 片段保留天數
const KEEP_MS: i64 = 62 * 86_400_000;
const MAX_ENTRIES: usize = 200;
const MAX_TITLE: usize = 200;
/// 本機交接紀錄：`收件成員/EK/epoch`
const HANDOVER_FILE: &str = "worklog-handover";
/// 最新 epoch 封裝給了哪些成員（用來判斷是否需要輪替）
const HOLDERS_FILE: &str = "worklog-holders";

pub fn timer_doc(m: &MemberId) -> String {
    format!("member/{m}/timer")
}

pub fn worklog_doc(m: &MemberId, month: &str) -> String {
    format!("member/{m}/worklog/{month}")
}

/// 時間記在哪裡：任務（含步驟）、會議、其他。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkRef {
    Task {
        team: String,
        task: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
        #[serde(default)]
        title: String,
    },
    Meeting,
    Other {
        #[serde(default)]
        title: String,
    },
}

/// 目前的計時狀態。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    /// 正在計時的項目；暫停時為 None
    #[serde(default)]
    pub current: Option<WorkRef>,
    pub since: Timestamp,
    /// start / focus / status
    #[serde(default)]
    pub source: String,
    /// 暫停或會議結束後要恢復的任務
    #[serde(default)]
    pub resume: Option<WorkRef>,
}

/// 一段計時。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    #[serde(default, skip_deserializing)]
    pub id: String,
    #[serde(rename = "ref")]
    pub work: WorkRef,
    pub start: Timestamp,
    pub end: Timestamp,
    #[serde(default)]
    pub source: String,
}

/// 整理後的一筆時間。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(rename = "ref")]
    pub work: WorkRef,
    /// 小組目標 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub minutes: u32,
    /// auto / edited / manual
    #[serde(default)]
    pub source: String,
}

/// 某天的工作紀錄。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayLog {
    #[serde(default)]
    pub date: String,
    pub entries: Vec<Entry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attendance: Option<u32>,
    #[serde(default)]
    pub updated_at: Timestamp,
}

/// 週計劃快照的一件任務。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTask {
    #[serde(rename = "ref")]
    pub work: WorkRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

/// 週計劃快照（「好，開始這一週」時寫入）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeekPlan {
    #[serde(default)]
    pub week: String,
    pub tasks: Vec<PlanTask>,
    /// 可用分鐘數
    #[serde(default)]
    pub capacity: u32,
    #[serde(default)]
    pub created_at: Timestamp,
}

fn valid_date(s: &str) -> bool {
    crate::scrum::valid_date(s)
}

fn valid_week(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 8
        && b[4] == b'-'
        && b[5] == b'W'
        && s[..4].bytes().all(|c| c.is_ascii_digit())
        && s[6..].parse::<u32>().is_ok_and(|w| (1..=53).contains(&w))
}

fn check_ref(r: &WorkRef) -> Result<()> {
    let title = match r {
        WorkRef::Task { title, .. } | WorkRef::Other { title } => title,
        WorkRef::Meeting => return Ok(()),
    };
    if title.chars().count() > MAX_TITLE {
        bail!("標題最多 {MAX_TITLE} 字");
    }
    Ok(())
}

// ---------- 文件讀寫（純函式） ----------

pub fn read_running(doc: &AutoCommit) -> Option<Running> {
    serde_json::from_str(&get_str(doc, &ROOT, RUNNING)?).ok()
}

fn put_running(doc: &mut AutoCommit, r: Option<&Running>) -> Result<()> {
    match r {
        Some(r) => doc.put(ROOT, RUNNING, serde_json::to_string(r)?)?,
        None => {
            if doc.get(ROOT, RUNNING)?.is_some() {
                doc.delete(ROOT, RUNNING)?;
            }
        }
    }
    Ok(())
}

pub fn read_segments(doc: &AutoCommit, from: Timestamp, to: Timestamp) -> Vec<Segment> {
    let mut out: Vec<Segment> = doc
        .keys(ROOT)
        .filter_map(|k| {
            let id = k.strip_prefix(SEG_PREFIX)?.to_owned();
            let mut s: Segment = serde_json::from_str(&get_str(doc, &ROOT, &k)?).ok()?;
            s.id = id;
            (s.end > from && s.start < to).then_some(s)
        })
        .collect();
    out.sort_by(|a, b| a.start.cmp(&b.start).then(a.id.cmp(&b.id)));
    out
}

/// 結束目前的片段（at 之前）並寫入；回傳結束的項目。片段短於 30 秒不記。
fn close_segment(doc: &mut AutoCommit, run: &Running, at: Timestamp, id: &str) -> Result<()> {
    let Some(work) = &run.current else {
        return Ok(());
    };
    let end = at.max(run.since);
    if end - run.since < 30_000 {
        return Ok(());
    }
    let seg = Segment {
        id: String::new(),
        work: work.clone(),
        start: run.since,
        end,
        source: run.source.clone(),
    };
    doc.put(
        ROOT,
        format!("{SEG_PREFIX}{id}").as_str(),
        serde_json::to_string(&seg)?,
    )?;
    Ok(())
}

/// 刪除太舊的片段。
fn prune(doc: &mut AutoCommit, now: Timestamp) -> Result<()> {
    let old: Vec<String> = doc
        .keys(ROOT)
        .filter(|k| k.starts_with(SEG_PREFIX))
        .filter(|k| {
            get_str(doc, &ROOT, k)
                .and_then(|raw| serde_json::from_str::<Segment>(&raw).ok())
                .is_some_and(|s| s.end < now - KEEP_MS)
        })
        .collect();
    for k in old {
        doc.delete(ROOT, k.as_str())?;
    }
    Ok(())
}

/// 狀態變更時計時的動作（technical-design §16.18）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceAction {
    /// 午休、暫離、離線、休假：暫停
    Pause,
    /// 會議：改記會議
    Meeting,
    /// 上線、專注：有暫停的任務就恢復
    Resume,
    /// 忙碌：不變
    Keep,
}

pub fn presence_action(state: PresenceState) -> PresenceAction {
    match state {
        PresenceState::Lunch
        | PresenceState::Away
        | PresenceState::Offline
        | PresenceState::Leave => PresenceAction::Pause,
        PresenceState::Meeting => PresenceAction::Meeting,
        PresenceState::Online | PresenceState::Focus => PresenceAction::Resume,
        PresenceState::Busy => PresenceAction::Keep,
    }
}

/// 依狀態變更更新計時（純函式；回傳新的 running，並在需要時寫入結束的片段）。
pub fn apply_presence(
    doc: &mut AutoCommit,
    action: PresenceAction,
    at: Timestamp,
    seg_id: &str,
) -> Result<()> {
    let Some(run) = read_running(doc) else {
        return Ok(());
    };
    let task = match &run.current {
        Some(WorkRef::Meeting) | None => run.resume.clone(),
        Some(w) => Some(w.clone()),
    };
    let next = match action {
        PresenceAction::Keep => return Ok(()),
        PresenceAction::Pause => {
            if run.current.is_none() {
                return Ok(());
            }
            Running {
                current: None,
                since: at,
                source: run.source.clone(),
                resume: task,
            }
        }
        PresenceAction::Meeting => {
            if run.current == Some(WorkRef::Meeting) {
                return Ok(());
            }
            Running {
                current: Some(WorkRef::Meeting),
                since: at,
                source: "status".into(),
                resume: task,
            }
        }
        PresenceAction::Resume => {
            if matches!(&run.current, Some(w) if *w != WorkRef::Meeting) {
                return Ok(());
            }
            match task {
                Some(t) => Running {
                    current: Some(t),
                    since: at,
                    source: run.source.clone(),
                    resume: None,
                },
                None => {
                    close_segment(doc, &run, at, seg_id)?;
                    return put_running(doc, None);
                }
            }
        }
    };
    close_segment(doc, &run, at, seg_id)?;
    put_running(doc, Some(&next))
}

pub fn read_days(doc: &AutoCommit) -> Vec<DayLog> {
    let mut out: Vec<DayLog> = doc
        .keys(ROOT)
        .filter_map(|k| {
            let date = k.strip_prefix(DAY_PREFIX)?.to_owned();
            let mut d: DayLog = serde_json::from_str(&get_str(doc, &ROOT, &k)?).ok()?;
            d.date = date;
            Some(d)
        })
        .collect();
    out.sort_by(|a, b| a.date.cmp(&b.date));
    out
}

pub fn read_plans(doc: &AutoCommit) -> Vec<WeekPlan> {
    doc.keys(ROOT)
        .filter_map(|k| {
            let week = k.strip_prefix(PLAN_PREFIX)?.to_owned();
            let mut p: WeekPlan = serde_json::from_str(&get_str(doc, &ROOT, &k)?).ok()?;
            p.week = week;
            Some(p)
        })
        .collect()
}

/// 依 ISO 週的週一推算月份（週計劃存在週一所在月份的文件）。
fn month_of_week(week: &str) -> Result<String> {
    let y: i32 = week[..4].parse()?;
    let w: i64 = week[6..].parse()?;
    // 1 月 4 日一定在第 1 週
    let jan4 = days_from_civil(y, 1, 4);
    let dow = (jan4 + 3).rem_euclid(7); // 0 = 週一
    let monday = jan4 - dow + (w - 1) * 7;
    let (yy, mm, _) = civil_from_days(monday);
    Ok(format!("{yy:04}-{mm:02}"))
}

fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = i64::from(if m <= 2 { y - 1 } else { y });
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ---------- Node API ----------

impl Node {
    /// 目前的計時狀態。
    pub fn timer_state(&self) -> Result<Option<Running>> {
        self.read_doc(&timer_doc(&self.member_id()), read_running)
    }

    /// 期間內的計時片段。
    pub fn timer_segments(&self, from: Timestamp, to: Timestamp) -> Result<Vec<Segment>> {
        self.read_doc(&timer_doc(&self.member_id()), |d| {
            read_segments(d, from, to)
        })
    }

    /// 開始計時（同時只有一件；開始另一件時先結束目前的片段）。`since` 可回溯（閒置後補回）。
    pub async fn timer_start(
        &self,
        work: WorkRef,
        source: &str,
        since: Option<Timestamp>,
    ) -> Result<()> {
        check_ref(&work)?;
        let now = now_ms();
        let at = since
            .filter(|s| *s <= now && *s > now - 86_400_000)
            .unwrap_or(now);
        let id = crate::conv::ulid(now)?;
        self.change(&timer_doc(&self.member_id()), |doc| {
            if let Some(run) = read_running(doc) {
                if run.current.as_ref() == Some(&work) {
                    return Ok(());
                }
                close_segment(doc, &run, at, &id)?;
            }
            prune(doc, now)?;
            put_running(
                doc,
                Some(&Running {
                    current: Some(work),
                    since: at,
                    source: source.to_owned(),
                    resume: None,
                }),
            )
        })
        .await
    }

    /// 停止計時；`at` 可回溯（閒置開始的時間）。`keep_resume` 為真時保留任務供之後恢復。
    pub async fn timer_stop(&self, at: Option<Timestamp>, keep_resume: bool) -> Result<()> {
        let now = now_ms();
        let at = at.filter(|a| *a <= now).unwrap_or(now);
        let id = crate::conv::ulid(now)?;
        self.change(&timer_doc(&self.member_id()), |doc| {
            let Some(run) = read_running(doc) else {
                return Ok(());
            };
            close_segment(doc, &run, at, &id)?;
            if keep_resume {
                let resume = run
                    .current
                    .clone()
                    .filter(|w| *w != WorkRef::Meeting)
                    .or(run.resume);
                put_running(
                    doc,
                    Some(&Running {
                        current: None,
                        since: at,
                        source: run.source,
                        resume,
                    }),
                )
            } else {
                put_running(doc, None)
            }
        })
        .await
    }

    /// 狀態改變時更新計時（set_presence 呼叫）。
    pub(crate) async fn timer_on_presence(&self, state: PresenceState) {
        let action = presence_action(state);
        if action == PresenceAction::Keep {
            return;
        }
        let me = self.member_id();
        if self
            .read_doc(&timer_doc(&me), read_running)
            .ok()
            .flatten()
            .is_none()
        {
            return;
        }
        let now = now_ms();
        let Ok(id) = crate::conv::ulid(now) else {
            return;
        };
        if let Err(e) = self
            .change(&timer_doc(&me), |doc| apply_presence(doc, action, now, &id))
            .await
        {
            tracing::warn!("無法更新計時：{e}");
        }
    }

    /// 某成員的工作紀錄（本人，或本人是他所屬小組的負責人）；`months` 為 yyyy-mm。
    pub fn worklog_days(&self, owner: &MemberId, months: &[String]) -> Result<Vec<DayLog>> {
        self.check_worklog_reader(owner)?;
        let mut out = Vec::new();
        for m in months {
            out.extend(self.read_doc(&worklog_doc(owner, m), read_days)?);
        }
        Ok(out)
    }

    pub fn week_plans(&self, owner: &MemberId, months: &[String]) -> Result<Vec<WeekPlan>> {
        self.check_worklog_reader(owner)?;
        let mut out = Vec::new();
        for m in months {
            out.extend(self.read_doc(&worklog_doc(owner, m), read_plans)?);
        }
        Ok(out)
    }

    fn check_worklog_reader(&self, owner: &MemberId) -> Result<()> {
        let me = self.member_id();
        if *owner != me && !crate::policy::leads_of(&self.org(), owner).contains(&me) {
            bail!("只有本人與小組負責人看得到工作紀錄");
        }
        Ok(())
    }

    /// 寫入（覆寫）本人某天的工作紀錄。
    pub async fn set_worklog_day(&self, date: &str, mut day: DayLog) -> Result<()> {
        if !valid_date(date) {
            bail!("日期格式需為 yyyy-mm-dd");
        }
        if day.entries.len() > MAX_ENTRIES {
            bail!("一天最多 {MAX_ENTRIES} 筆");
        }
        for e in &day.entries {
            check_ref(&e.work)?;
            if e.minutes > 24 * 60 {
                bail!("一筆最多 24 小時");
            }
        }
        day.date = date.to_owned();
        day.updated_at = now_ms();
        self.ensure_worklog_key()?;
        let json = serde_json::to_string(&day)?;
        let me = self.member_id();
        self.change(&worklog_doc(&me, &date[..7]), |doc| {
            doc.put(ROOT, format!("{DAY_PREFIX}{date}").as_str(), json.as_str())?;
            Ok(())
        })
        .await
    }

    /// 寫入本人的週計劃快照。
    pub async fn set_week_plan(&self, week: &str, mut plan: WeekPlan) -> Result<()> {
        if !valid_week(week) {
            bail!("週格式需為 YYYY-Www");
        }
        if plan.tasks.len() > MAX_ENTRIES {
            bail!("最多 {MAX_ENTRIES} 件");
        }
        for t in &plan.tasks {
            check_ref(&t.work)?;
        }
        plan.week = week.to_owned();
        plan.created_at = now_ms();
        self.ensure_worklog_key()?;
        let json = serde_json::to_string(&plan)?;
        let me = self.member_id();
        let month = month_of_week(week)?;
        self.change(&worklog_doc(&me, &month), |doc| {
            doc.put(ROOT, format!("{PLAN_PREFIX}{week}").as_str(), json.as_str())?;
            Ok(())
        })
        .await
    }

    /// 本人持有某成員工作紀錄金鑰的最新 epoch（測試與介面「金鑰交接中」用）。
    pub fn worklog_key_epoch(&self, owner: &MemberId) -> Option<u32> {
        lock(&self.inner.st)
            .ring
            .latest(&KeyFamily::MemberWorklog(*owner))
            .map(|(id, _)| id.epoch)
    }

    /// 還沒有 WK 時產生並封裝給自己（交接給負責人在同步迴圈中進行）。
    fn ensure_worklog_key(&self) -> Result<()> {
        ensure_key(&self.inner)
    }
}

fn ensure_key(inner: &Inner) -> Result<()> {
    let me = inner.me();
    let family = KeyFamily::MemberWorklog(me);
    let mut st = lock(&inner.st);
    if st.ring.latest(&family).is_some() {
        return Ok(());
    }
    let ek = Pub32(inner.secrets.keys.exchange_public().to_bytes());
    let r = rotate(&st.ring, &family, &[(me, ek)])?;
    for w in r.wrapped {
        st.key_outbox.push(inner.secrets.device.sign_body(w)?);
    }
    st.ring.insert(r.key_id, r.key);
    inner.persist(&st)
}

fn designated_device(trust: &TrustStore, m: &MemberId) -> Option<Pub32> {
    trust
        .devices_of(m)
        .into_iter()
        .map(|d| d.device_pub)
        .min_by_key(|p| p.0)
}

fn read_set(inner: &Inner, file: &str) -> BTreeSet<String> {
    inner
        .store
        .read_secret_file(file)
        .ok()
        .flatten()
        .and_then(|raw| postcard::from_bytes(&raw).ok())
        .unwrap_or_default()
}

/// 同步迴圈中執行：把 WK 交接給本人所屬小組的負責人；有人卸任時輪替。回傳是否有新的封裝待上傳。
pub(crate) fn reconcile(inner: &Inner) -> Result<bool> {
    let me = inner.me();
    let family = KeyFamily::MemberWorklog(me);
    let mut st = lock(&inner.st);
    if st.ring.latest(&family).is_none() {
        return Ok(false);
    }
    let snap = inner.org_snapshot(&mut st);
    let leads: Vec<(MemberId, Pub32)> = crate::policy::leads_of(&snap, &me)
        .into_iter()
        .filter(|m| st.trust.is_active_member(m))
        .filter_map(|m| st.trust.member(&m).map(|c| (m, c.ek_pub)))
        .collect();
    let now_holders: BTreeSet<String> = leads.iter().map(|(m, _)| m.to_string()).collect();
    let prev_holders = read_set(inner, HOLDERS_FILE);
    let mut handed = read_set(inner, HANDOVER_FILE);
    let mut queued = false;
    let mine_ek = Pub32(inner.secrets.keys.exchange_public().to_bytes());
    // 輪替：上次的收件人有人不再是負責人，由本人的指定裝置產生新 epoch
    let removed = prev_holders.iter().any(|h| !now_holders.contains(h));
    let mut rotated = false;
    if removed && designated_device(&st.trust, &me) == Some(inner.secrets.device.public()) {
        let mut to = leads.clone();
        to.push((me, mine_ek));
        let r = rotate(&st.ring, &family, &to)?;
        for w in r.wrapped {
            let s = inner.secrets.device.sign_body(w)?;
            st.key_outbox.push(s);
        }
        let epoch = r.key_id.epoch;
        st.ring.insert(r.key_id, r.key);
        for (m, ek) in &leads {
            handed.insert(format!("{m}/{ek}/{epoch}"));
        }
        tracing::info!(epoch, "已輪替工作紀錄金鑰");
        queued = true;
        rotated = true;
    }
    // 交接：還沒拿到最新 epoch 的負責人（卸任前沒有輪替時，交出全部 epoch）
    let latest = st.ring.latest(&family).map_or(0, |(id, _)| id.epoch);
    for (m, ek) in &leads {
        let k = format!("{m}/{ek}/{latest}");
        if handed.contains(&k) {
            continue;
        }
        let wraps: Vec<_> = st
            .ring
            .epochs(&family)
            .into_iter()
            .map(|(id, key)| wrap_key(id, key, *m, ek))
            .collect::<Result<_, _>>()?;
        for w in wraps {
            let s = inner.secrets.device.sign_body(w)?;
            st.key_outbox.push(s);
        }
        handed.insert(k);
        queued = true;
    }
    // 有人卸任但本裝置不是指定裝置：等指定裝置輪替後再更新收件人紀錄
    let holders_ok = !removed || rotated;
    if queued || (holders_ok && prev_holders != now_holders) {
        inner.persist(&st)?;
        inner
            .store
            .write_secret_file(HANDOVER_FILE, &postcard::to_allocvec(&handed)?)?;
        if holders_ok {
            inner
                .store
                .write_secret_file(HOLDERS_FILE, &postcard::to_allocvec(&now_holders)?)?;
        }
    }
    Ok(queued)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn task(t: &str) -> WorkRef {
        WorkRef::Task {
            team: "g".into(),
            task: t.into(),
            step: None,
            title: t.into(),
        }
    }

    #[test]
    fn presence_pauses_meetings_and_resumes() {
        let mut doc = AutoCommit::new();
        let run = Running {
            current: Some(task("t1")),
            since: 0,
            source: "start".into(),
            resume: None,
        };
        put_running(&mut doc, Some(&run)).unwrap();
        // 會議：結束任務片段，改記會議
        apply_presence(&mut doc, PresenceAction::Meeting, 600_000, "a").unwrap();
        let r = read_running(&doc).unwrap();
        assert_eq!(r.current, Some(WorkRef::Meeting));
        assert_eq!(r.resume, Some(task("t1")));
        // 午休：結束會議片段，暫停
        apply_presence(&mut doc, PresenceAction::Pause, 1_200_000, "b").unwrap();
        let r = read_running(&doc).unwrap();
        assert_eq!(r.current, None);
        assert_eq!(r.resume, Some(task("t1")));
        // 上線：恢復任務
        apply_presence(&mut doc, PresenceAction::Resume, 3_000_000, "c").unwrap();
        let r = read_running(&doc).unwrap();
        assert_eq!(r.current, Some(task("t1")));
        assert_eq!(r.since, 3_000_000);
        let segs = read_segments(&doc, 0, i64::MAX);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].work, task("t1"));
        assert_eq!(segs[1].work, WorkRef::Meeting);
        assert_eq!(segs[1].end - segs[1].start, 600_000);
        // 忙碌不影響
        apply_presence(&mut doc, PresenceAction::Keep, 4_000_000, "d").unwrap();
        assert_eq!(read_segments(&doc, 0, i64::MAX).len(), 2);
    }

    #[test]
    fn short_segments_and_prune() {
        let mut doc = AutoCommit::new();
        let run = Running {
            current: Some(task("t")),
            since: 0,
            source: String::new(),
            resume: None,
        };
        close_segment(&mut doc, &run, 10_000, "short").unwrap();
        assert!(read_segments(&doc, 0, i64::MAX).is_empty());
        close_segment(&mut doc, &run, 120_000, "ok").unwrap();
        assert_eq!(read_segments(&doc, 0, i64::MAX).len(), 1);
        prune(&mut doc, KEEP_MS + 200_000).unwrap();
        assert!(read_segments(&doc, 0, i64::MAX).is_empty());
    }

    #[test]
    fn week_month_and_formats() {
        assert_eq!(month_of_week("2026-W46").unwrap(), "2026-11");
        assert_eq!(month_of_week("2026-W01").unwrap(), "2025-12");
        assert_eq!(month_of_week("2027-W01").unwrap(), "2027-01");
        assert!(valid_week("2026-W46"));
        assert!(!valid_week("2026-46"));
        let json = serde_json::to_string(&Entry {
            work: WorkRef::Meeting,
            project: None,
            minutes: 60,
            source: "auto".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"ref":{"kind":"meeting"},"minutes":60,"source":"auto"}"#
        );
    }
}
