//! 小組管理與小組金鑰交接（technical-design §16.15，feature-plan D49）。
//!
//! - org 文件 `teams.<id>` 只放名稱與封存時間（管理者寫）。
//! - `team-roster/<teamId>`（GK）放成員、負責人與移出次數；寫入者是管理者或該小組負責人。
//! - 持有 TK 的成員裝置把全部 epoch 交接給名單上還沒拿到的人；有人被移出時由指定輪替裝置輪替。
//! - 管理者不持有非所屬小組的 TK：建立小組時產生第一個 epoch 封裝給成員後即丟棄。

use std::collections::BTreeSet;

use anyhow::{Result, anyhow, bail};
use automerge::{AutoCommit, ROOT, transaction::Transactable};
use hills_crypto::{rotate, wrap_key};
use hills_identity::trust::TrustStore;
use hills_proto::mailbox::KeyItem;
use hills_proto::{KeyFamily, MemberId, Pub32, Timestamp};
use serde::Serialize;

use crate::node::{Event, Inner, Node, State, lock, now_ms};
use crate::org::{self, OrgSnapshot, TeamRec, get_ids, get_int, put_list};

/// 小組名稱最多幾字
const MAX_NAME: usize = 40;
/// team 文件中「已為第 n 次移出輪替」
const KEY_ROTATED: &str = "keyRotatedFor";
/// 本機交接紀錄
const HANDOVER_FILE: &str = "team-handover";
/// 暫存、稍後重試的小組金鑰封裝
const DEFERRED_FILE: &str = "keys-deferred";
const MAX_DEFERRED: usize = 500;
/// 剛取得金鑰、需重新下載舊 bundle 的小組
const CATCH_UP_FILE: &str = "team-catch-up";

pub fn roster_doc(team: &str) -> String {
    format!("team-roster/{team}")
}

fn team_doc(team: &str) -> String {
    format!("team/{team}")
}

/// `team-roster/<teamId>` 的內容。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Roster {
    pub members: Vec<MemberId>,
    pub leads: Vec<MemberId>,
    pub removals: i64,
}

/// 讀取名單；文件沒有 `members` 時回傳 None（使用 org 的後備名單）。
pub fn read_roster(doc: &AutoCommit) -> Option<Roster> {
    org::get_obj(doc, &ROOT, "members")?;
    Some(Roster {
        members: get_ids(doc, &ROOT, "members"),
        leads: get_ids(doc, &ROOT, "leads"),
        removals: get_int(doc, &ROOT, "removals").unwrap_or(0),
    })
}

pub fn write_roster(doc: &mut AutoCommit, r: &Roster) -> Result<()> {
    let s = |v: &[MemberId]| v.iter().map(ToString::to_string).collect::<Vec<_>>();
    put_list(doc, &ROOT, "members", &s(&r.members))?;
    put_list(doc, &ROOT, "leads", &s(&r.leads))?;
    doc.put(ROOT, "removals", r.removals)?;
    Ok(())
}

/// 把 `team-roster` 文件的名單合併進 org 投影。
pub(crate) fn merge_rosters(inner: &Inner, st: &mut State, snap: &mut OrgSnapshot) {
    let ids: Vec<String> = snap.teams.keys().cloned().collect();
    for t in ids {
        let Ok(local) = inner.load_doc(&mut st.docs, &roster_doc(&t)) else {
            continue;
        };
        let Some(r) = read_roster(&local.doc) else {
            continue;
        };
        if let Some(rec) = snap.teams.get_mut(&t) {
            rec.members = r.members;
            rec.leads = r.leads;
            rec.removals = r.removals;
            rec.roster = true;
        }
    }
}

fn in_team(t: &TeamRec, m: &MemberId) -> bool {
    t.members.contains(m) || t.leads.contains(m)
}

/// 指定輪替成員：負責人中 memberId 最小者；沒有負責人時取成員中最小者。
pub fn designated_member(t: &TeamRec) -> Option<MemberId> {
    t.leads
        .iter()
        .min()
        .or_else(|| t.members.iter().min())
        .copied()
}

/// 指定輪替裝置：該成員有效裝置中公鑰最小的一台。
fn designated_device(trust: &TrustStore, m: &MemberId) -> Option<Pub32> {
    trust
        .devices_of(m)
        .into_iter()
        .map(|d| d.device_pub)
        .min_by_key(|p| p.0)
}

/// 名單上的有效成員與其 EK。
fn recipients(trust: &TrustStore, t: &TeamRec) -> Vec<(MemberId, Pub32)> {
    let ids: BTreeSet<MemberId> = t.members.iter().chain(&t.leads).copied().collect();
    ids.into_iter()
        .filter(|m| trust.is_active_member(m))
        .filter_map(|m| trust.member(&m).map(|c| (m, c.ek_pub)))
        .collect()
}

/// 小組卡的資料（ui-spec「設定 → 小組」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInfo {
    pub id: String,
    pub name: String,
    pub members: Vec<MemberId>,
    pub leads: Vec<MemberId>,
    pub archived_at: Option<Timestamp>,
    /// 本人是成員卻還沒有小組金鑰（「金鑰交接中」）
    pub awaiting_key: bool,
    /// 本人可管理成員與負責人（管理者或該小組負責人）
    pub can_manage: bool,
}

/// 檢查名單：至少一位成員、都是有效成員、負責人是成員；回傳去重後的名單。
fn normalize(
    trust: &TrustStore,
    members: &[MemberId],
    leads: &[MemberId],
) -> Result<(Vec<MemberId>, Vec<MemberId>)> {
    let mut ms: Vec<MemberId> = Vec::new();
    for m in members {
        if !ms.contains(m) {
            ms.push(*m);
        }
    }
    if ms.is_empty() {
        bail!("小組至少要有一位成員");
    }
    if let Some(m) = ms.iter().find(|m| !trust.is_active_member(m)) {
        bail!("{m} 不是有效成員");
    }
    let mut ls: Vec<MemberId> = Vec::new();
    for l in leads {
        if !ms.contains(l) {
            bail!("負責人必須是小組成員");
        }
        if !ls.contains(l) {
            ls.push(*l);
        }
    }
    Ok((ms, ls))
}

fn valid_name(name: &str) -> Result<String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > MAX_NAME {
        bail!("小組名稱需為 1–{MAX_NAME} 字");
    }
    Ok(n.to_owned())
}

impl Node {
    /// 所有小組（含已封存）與本人的權限、金鑰狀態。
    pub fn teams_info(&self) -> Vec<TeamInfo> {
        let me = self.member_id();
        let admin = self.is_admin();
        let mut st = lock(&self.inner.st);
        let snap = self.inner.org_snapshot(&mut st);
        snap.teams
            .iter()
            .map(|(id, t)| TeamInfo {
                id: id.clone(),
                name: t.name.clone(),
                members: t.members.clone(),
                leads: t.leads.clone(),
                archived_at: t.archived_at,
                awaiting_key: in_team(t, &me)
                    && st.ring.latest(&KeyFamily::Team(id.clone())).is_none(),
                can_manage: admin || t.leads.contains(&me),
            })
            .collect()
    }

    /// 本人持有的小組金鑰最新 epoch（測試與診斷用）。
    #[doc(hidden)]
    pub fn team_key_epoch(&self, team: &str) -> Option<u32> {
        let st = lock(&self.inner.st);
        st.ring
            .latest(&KeyFamily::Team(team.to_owned()))
            .map(|(id, _)| id.epoch)
    }

    /// 建立小組（管理者）：寫入名稱與名單，產生第一個 epoch 封裝給成員。
    pub async fn create_team(
        &self,
        name: &str,
        members: Vec<MemberId>,
        leads: Vec<MemberId>,
    ) -> Result<String> {
        if !self.is_admin() {
            bail!("只有管理者可以建立小組");
        }
        let name = valid_name(name)?;
        let inner = &self.inner;
        let me = self.member_id();
        let now = now_ms();
        let id = crate::conv::ulid(now)?.to_ascii_lowercase();
        {
            let mut st = lock(&inner.st);
            let (members, leads) = normalize(&st.trust, &members, &leads)?;
            let rec = TeamRec {
                members: members.clone(),
                leads: leads.clone(),
                ..Default::default()
            };
            let family = KeyFamily::Team(id.clone());
            let r = rotate(&st.ring, &family, &recipients(&st.trust, &rec))?;
            for w in r.wrapped {
                let s = inner.secrets.device.sign_body(w)?;
                st.key_outbox.push(s);
            }
            if in_team(&rec, &me) {
                st.ring.insert(r.key_id, r.key);
            }
            inner.persist(&st)?;
            inner.change_locked(&mut st, "org", |doc| Ok(org::create_team(doc, &id, &name)?))?;
            let roster = Roster {
                members,
                leads,
                removals: 0,
            };
            inner.change_locked(&mut st, &roster_doc(&id), |doc| write_roster(doc, &roster))?;
        }
        self.after_team_change().await;
        Ok(id)
    }

    /// 改名小組（管理者）。
    pub async fn rename_team(&self, id: &str, name: &str) -> Result<()> {
        if !self.is_admin() {
            bail!("只有管理者可以改小組名稱");
        }
        let name = valid_name(name)?;
        let mut found = false;
        self.change("org", |doc| {
            found = org::rename_team(doc, id, &name)?;
            Ok(())
        })
        .await?;
        if !found {
            bail!("找不到這個小組");
        }
        Ok(())
    }

    /// 封存或取消封存小組（管理者）。
    pub async fn archive_team(&self, id: &str, archived: bool) -> Result<()> {
        if !self.is_admin() {
            bail!("只有管理者可以封存小組");
        }
        let at = archived.then(now_ms);
        let mut found = false;
        self.change("org", |doc| {
            found = org::set_team_archived(doc, id, at)?;
            Ok(())
        })
        .await?;
        if !found {
            bail!("找不到這個小組");
        }
        Ok(())
    }

    /// 設定小組成員與負責人（管理者或該小組負責人）；有人被移出時移出次數 + 1。
    pub async fn set_team_members(
        &self,
        id: &str,
        members: Vec<MemberId>,
        leads: Vec<MemberId>,
    ) -> Result<()> {
        let me = self.member_id();
        let admin = self.is_admin();
        {
            let inner = &self.inner;
            let mut st = lock(&inner.st);
            let snap = inner.org_snapshot(&mut st);
            let team = snap
                .teams
                .get(id)
                .ok_or_else(|| anyhow!("找不到這個小組"))?;
            if !admin && !team.leads.contains(&me) {
                bail!("只有管理者與小組負責人可以管理成員");
            }
            let (members, leads) = normalize(&st.trust, &members, &leads)?;
            let removed = team
                .members
                .iter()
                .chain(&team.leads)
                .any(|m| !members.contains(m));
            let roster = Roster {
                members,
                leads,
                removals: team.removals + i64::from(removed),
            };
            inner.change_locked(&mut st, &roster_doc(id), |doc| write_roster(doc, &roster))?;
        }
        self.after_team_change().await;
        Ok(())
    }

    async fn after_team_change(&self) {
        let inner = &self.inner;
        inner.emit(Event::OrgChanged);
        inner.wake.notify_one();
        crate::gossip::broadcast(inner, hills_proto::gossip::GossipMsg::KeysChanged).await;
    }
}

impl Inner {
    fn read_handover(&self) -> BTreeSet<String> {
        self.store
            .read_secret_file(HANDOVER_FILE)
            .ok()
            .flatten()
            .and_then(|raw| postcard::from_bytes(&raw).ok())
            .unwrap_or_default()
    }

    fn read_deferred(&self) -> Vec<KeyItem> {
        self.store
            .read_secret_file(DEFERRED_FILE)
            .ok()
            .flatten()
            .and_then(|raw| postcard::from_bytes(&raw).ok())
            .unwrap_or_default()
    }

    fn write_deferred(&self, items: &[KeyItem]) -> Result<()> {
        self.store
            .write_secret_file(DEFERRED_FILE, &postcard::to_allocvec(items)?)?;
        Ok(())
    }

    /// 暫存目前無法判斷的小組金鑰封裝（名單文件可能比金鑰晚到）。
    pub(crate) fn defer_keys(&self, items: Vec<KeyItem>) -> Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        let mut all = self.read_deferred();
        for it in items {
            if !all.iter().any(|x| x.wrapped == it.wrapped) {
                all.push(it);
            }
        }
        let over = all.len().saturating_sub(MAX_DEFERRED);
        all.drain(..over);
        self.write_deferred(&all)
    }

    fn read_catch_up(&self) -> BTreeSet<String> {
        self.store
            .read_secret_file(CATCH_UP_FILE)
            .ok()
            .flatten()
            .and_then(|raw| postcard::from_bytes(&raw).ok())
            .unwrap_or_default()
    }

    /// 記下剛取得第一把金鑰的小組，稍後重新下載它們的 bundle。
    pub(crate) fn need_catch_up(&self, teams: Vec<String>) -> Result<()> {
        if teams.is_empty() {
            return Ok(());
        }
        let mut all = self.read_catch_up();
        all.extend(teams);
        self.store
            .write_secret_file(CATCH_UP_FILE, &postcard::to_allocvec(&all)?)?;
        Ok(())
    }

    pub(crate) fn catch_up_teams(&self) -> Result<BTreeSet<String>> {
        Ok(self.read_catch_up())
    }

    pub(crate) fn clear_catch_up(&self, done: &BTreeSet<String>) -> Result<()> {
        let rest: BTreeSet<String> = self.read_catch_up().difference(done).cloned().collect();
        self.store
            .write_secret_file(CATCH_UP_FILE, &postcard::to_allocvec(&rest)?)?;
        Ok(())
    }

    /// 取出暫存的封裝以重試。
    pub(crate) fn take_deferred(&self) -> Result<Vec<KeyItem>> {
        let all = self.read_deferred();
        if !all.is_empty() {
            self.write_deferred(&[])?;
        }
        Ok(all)
    }
}

/// 小組金鑰的接受規則（§16.15）：`Ok(true)` 接受、`Ok(false)` 暫存重試。
pub(crate) fn team_key_ok(
    snap: &OrgSnapshot,
    st: &State,
    team: &str,
    epoch: u32,
    signer: &MemberId,
    signer_admin: bool,
) -> bool {
    if signer_admin {
        return true;
    }
    let Some(t) = snap.teams.get(team) else {
        return false;
    };
    if !in_team(t, signer) {
        return false;
    }
    match st.ring.latest(&KeyFamily::Team(team.to_owned())) {
        Some((id, _)) if epoch > id.epoch => designated_member(t).as_ref() == Some(signer),
        _ => true,
    }
}

/// 同步迴圈中執行：交接小組金鑰、必要時輪替。回傳是否有新的封裝待上傳。
pub(crate) fn reconcile(inner: &Inner) -> Result<bool> {
    let me = inner.me();
    let my_device = inner.secrets.device.public();
    let mut st = lock(&inner.st);
    let snap = inner.org_snapshot(&mut st);
    let mut handed = inner.read_handover();
    let mut queued = false;
    for (tid, team) in &snap.teams {
        if !team.roster || !in_team(team, &me) {
            continue;
        }
        let family = KeyFamily::Team(tid.clone());
        if st.ring.latest(&family).is_none() {
            continue;
        }
        let to = recipients(&st.trust, team);
        // 輪替：有人被移出且尚未輪替，本裝置是指定輪替裝置
        if team.removals > 0
            && designated_member(team) == Some(me)
            && designated_device(&st.trust, &me) == Some(my_device)
        {
            let done = {
                let local = inner.load_doc(&mut st.docs, &team_doc(tid))?;
                get_int(&local.doc, &ROOT, KEY_ROTATED).unwrap_or(0)
            };
            if team.removals > done {
                let r = rotate(&st.ring, &family, &to)?;
                for w in r.wrapped {
                    let s = inner.secrets.device.sign_body(w)?;
                    st.key_outbox.push(s);
                }
                let epoch = r.key_id.epoch;
                st.ring.insert(r.key_id, r.key);
                inner.persist(&st)?;
                for (m, ek) in &to {
                    handed.insert(handover_key(tid, m, ek, epoch));
                }
                let n = team.removals;
                inner.change_locked(&mut st, &team_doc(tid), |doc| {
                    doc.put(ROOT, KEY_ROTATED, n)?;
                    Ok(())
                })?;
                tracing::info!(team = %tid, epoch, "已輪替小組金鑰");
                queued = true;
            }
        }
        // 交接：名單上還沒交接過最新 epoch 的人
        let latest = st.ring.latest(&family).map_or(0, |(id, _)| id.epoch);
        for (m, ek) in &to {
            if *m == me {
                continue;
            }
            let k = handover_key(tid, m, ek, latest);
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
    }
    if queued {
        inner.persist(&st)?;
        inner
            .store
            .write_secret_file(HANDOVER_FILE, &postcard::to_allocvec(&handed)?)?;
    }
    Ok(queued)
}

fn handover_key(team: &str, m: &MemberId, ek: &Pub32, epoch: u32) -> String {
    format!("{team}/{m}/{ek}/{epoch}")
}

/// 停用成員時從所有名單移除（§16.15）；`rotated` 為管理者已自行輪替的小組（不再增加移出次數）。
pub(crate) fn remove_from_rosters(
    inner: &Inner,
    st: &mut State,
    member: &MemberId,
    rotated: &[String],
) -> Result<()> {
    let snap = inner.org_snapshot(st);
    for (tid, team) in &snap.teams {
        if !team.roster || !in_team(team, member) {
            continue;
        }
        let roster = Roster {
            members: team
                .members
                .iter()
                .filter(|m| *m != member)
                .copied()
                .collect(),
            leads: team
                .leads
                .iter()
                .filter(|m| *m != member)
                .copied()
                .collect(),
            removals: team.removals + i64::from(!rotated.contains(tid)),
        };
        inner.change_locked(st, &roster_doc(tid), |doc| write_roster(doc, &roster))?;
    }
    Ok(())
}

/// 核准加入時把成員加入名單（有 `team-roster` 的小組寫名單，否則寫 org 後備名單）。
pub(crate) fn add_to_team(
    inner: &Inner,
    st: &mut State,
    team: &str,
    member: &MemberId,
) -> Result<()> {
    let snap = inner.org_snapshot(st);
    match snap.teams.get(team) {
        Some(t) if t.roster => {
            if in_team(t, member) {
                return Ok(());
            }
            let mut members = t.members.clone();
            members.push(*member);
            let roster = Roster {
                members,
                leads: t.leads.clone(),
                removals: t.removals,
            };
            inner.change_locked(st, &roster_doc(team), |doc| write_roster(doc, &roster))?;
        }
        Some(_) => {
            inner.change_locked(st, "org", |doc| Ok(org::add_to_team(doc, team, member)?))?;
        }
        None => {}
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn m(n: u8) -> MemberId {
        MemberId([n; 16])
    }

    #[test]
    fn roster_roundtrip_and_fallback() {
        let mut doc = AutoCommit::new();
        assert_eq!(read_roster(&doc), None);
        let r = Roster {
            members: vec![m(1), m(2)],
            leads: vec![m(2)],
            removals: 3,
        };
        write_roster(&mut doc, &r).unwrap();
        assert_eq!(read_roster(&doc), Some(r));
    }

    #[test]
    fn designated_prefers_smallest_lead() {
        let t = TeamRec {
            members: vec![m(5), m(1), m(3)],
            leads: vec![m(3), m(5)],
            ..Default::default()
        };
        assert_eq!(designated_member(&t), Some(m(3)));
        let t = TeamRec {
            members: vec![m(5), m(2)],
            ..Default::default()
        };
        assert_eq!(designated_member(&t), Some(m(2)));
        assert_eq!(designated_member(&TeamRec::default()), None);
    }
}
