//! org 文件結構（technical-design §16.8）與 `member/<id>/secrets`。

use std::collections::BTreeMap;

use automerge::{
    AutoCommit, ObjId, ObjType, ROOT, ReadDoc, ScalarValue, Value, transaction::Transactable,
};
use hills_proto::{MemberId, Timestamp};
use hills_sync::Directory;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MemberRec {
    pub name: String,
    pub joined_at: Timestamp,
    pub removed_at: Option<Timestamp>,
    /// CAFECA 帳戶（CAIP-10：`eip155:<chainId>:<address>`，technical-design §16.8 v0.13）
    pub cafeca: Option<String>,
    /// CAFECA 代稱（加入時查詢，只供顯示）
    pub handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TeamRec {
    pub name: String,
    pub leads: Vec<MemberId>,
    pub members: Vec<MemberId>,
}

/// 辦公室（technical-design §16.8 v0.11；M1 不比對 Wi-Fi）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OfficeRec {
    pub name: String,
}

/// 午休時段（組織時區的 `HH:MM`）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LunchBreak {
    pub start: String,
    pub end: String,
}

/// org 文件的唯讀快照。
#[derive(Debug, Clone, Default, Serialize)]
pub struct OrgSnapshot {
    pub name: String,
    pub timezone: String,
    pub locale: String,
    pub members: BTreeMap<MemberId, MemberRec>,
    pub teams: BTreeMap<String, TeamRec>,
    pub offices: BTreeMap<String, OfficeRec>,
    pub lunch_break: Option<LunchBreak>,
    /// 對話現任成員（由本人可解密的 meta 投影，§14.1；不屬於 org 文件）
    #[serde(skip)]
    pub convs: BTreeMap<String, BTreeMap<MemberId, u32>>,
}

impl Directory for OrgSnapshot {
    fn is_team_member(&self, team: &str, m: &MemberId) -> bool {
        self.teams
            .get(team)
            .is_some_and(|t| t.members.contains(m) || t.leads.contains(m))
    }
    fn is_conv_member(&self, conv: &str, m: &MemberId) -> bool {
        self.convs.get(conv).is_some_and(|ms| ms.contains_key(m))
    }
    /// M1：對話管理員只有建立者（convId 前綴，§14.1 v0.9），不需先解密 meta。
    fn is_conv_admin(&self, conv: &str, m: &MemberId) -> bool {
        crate::conv::creator_of(conv).as_ref() == Some(m)
    }
}

impl OrgSnapshot {
    /// 對話現任成員加入時的 epoch。
    pub fn conv_joined_epoch(&self, conv: &str, m: &MemberId) -> Option<u32> {
        self.convs.get(conv)?.get(m).copied()
    }

    pub fn teams_of(&self, m: &MemberId) -> Vec<String> {
        self.teams
            .iter()
            .filter(|(_, t)| t.members.contains(m) || t.leads.contains(m))
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn active_members(&self) -> impl Iterator<Item = (&MemberId, &MemberRec)> {
        self.members.iter().filter(|(_, r)| r.removed_at.is_none())
    }
}

// ---------- 讀取 ----------

pub(crate) fn get_obj(doc: &AutoCommit, obj: &ObjId, key: &str) -> Option<ObjId> {
    match doc.get(obj, key).ok()?? {
        (Value::Object(_), id) => Some(id),
        _ => None,
    }
}

pub(crate) fn get_str(doc: &AutoCommit, obj: &ObjId, key: &str) -> Option<String> {
    match doc.get(obj, key).ok()??.0 {
        Value::Scalar(s) => match s.as_ref() {
            ScalarValue::Str(t) => Some(t.to_string()),
            _ => None,
        },
        _ => None,
    }
}

pub(crate) fn get_int(doc: &AutoCommit, obj: &ObjId, key: &str) -> Option<i64> {
    match doc.get(obj, key).ok()??.0 {
        Value::Scalar(s) => match s.as_ref() {
            ScalarValue::Int(i) => Some(*i),
            ScalarValue::Uint(u) => i64::try_from(*u).ok(),
            _ => None,
        },
        _ => None,
    }
}

fn get_ids(doc: &AutoCommit, obj: &ObjId, key: &str) -> Vec<MemberId> {
    get_strs(doc, obj, key)
        .iter()
        .filter_map(|s| MemberId::parse(s).ok())
        .collect()
}

fn get_strs(doc: &AutoCommit, obj: &ObjId, key: &str) -> Vec<String> {
    let Some(list) = get_obj(doc, obj, key) else {
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

pub fn read(doc: &AutoCommit) -> OrgSnapshot {
    let mut s = OrgSnapshot {
        name: get_str(doc, &ROOT, "name").unwrap_or_default(),
        timezone: get_str(doc, &ROOT, "timezone").unwrap_or_default(),
        locale: get_str(doc, &ROOT, "locale").unwrap_or_default(),
        ..Default::default()
    };
    if let Some(members) = get_obj(doc, &ROOT, "members") {
        for k in doc.keys(&members) {
            let (Ok(id), Some(m)) = (MemberId::parse(&k), get_obj(doc, &members, &k)) else {
                continue;
            };
            s.members.insert(
                id,
                MemberRec {
                    name: get_str(doc, &m, "name").unwrap_or_default(),
                    joined_at: get_int(doc, &m, "joinedAt").unwrap_or(0),
                    removed_at: get_int(doc, &m, "removedAt"),
                    cafeca: get_str(doc, &m, "cafeca"),
                    handle: get_str(doc, &m, "handle"),
                },
            );
        }
    }
    if let Some(teams) = get_obj(doc, &ROOT, "teams") {
        for k in doc.keys(&teams) {
            let Some(t) = get_obj(doc, &teams, &k) else {
                continue;
            };
            s.teams.insert(
                k.clone(),
                TeamRec {
                    name: get_str(doc, &t, "name").unwrap_or_default(),
                    leads: get_ids(doc, &t, "leadIds"),
                    members: get_ids(doc, &t, "memberIds"),
                },
            );
        }
    }
    if let Some(offices) = get_obj(doc, &ROOT, "offices") {
        for k in doc.keys(&offices) {
            let Some(o) = get_obj(doc, &offices, &k) else {
                continue;
            };
            s.offices.insert(
                k.clone(),
                OfficeRec {
                    name: get_str(doc, &o, "name").unwrap_or_default(),
                },
            );
        }
    }
    if let Some(l) = get_obj(doc, &ROOT, "lunchBreak")
        && let (Some(start), Some(end)) = (get_str(doc, &l, "start"), get_str(doc, &l, "end"))
    {
        s.lunch_break = Some(LunchBreak { start, end });
    }
    s
}

// ---------- 寫入 ----------

type R<T> = Result<T, automerge::AutomergeError>;

pub(crate) fn ensure_map(doc: &mut AutoCommit, obj: &ObjId, key: &str) -> R<ObjId> {
    if let Some(id) = get_obj(doc, obj, key) {
        return Ok(id);
    }
    doc.put_object(obj, key, ObjType::Map)
}

fn put_list(doc: &mut AutoCommit, obj: &ObjId, key: &str, items: &[String]) -> R<()> {
    let list = doc.put_object(obj, key, ObjType::List)?;
    for (i, it) in items.iter().enumerate() {
        doc.insert(&list, i, it.as_str())?;
    }
    Ok(())
}

pub struct NewOrg<'a> {
    pub name: &'a str,
    pub timezone: &'a str,
    pub locale: &'a str,
    pub creator: MemberId,
    pub creator_name: &'a str,
    pub creator_cafeca: &'a str,
    pub creator_handle: Option<&'a str>,
    pub team_id: &'a str,
    pub team_name: &'a str,
    pub now: Timestamp,
}

pub fn init(doc: &mut AutoCommit, o: &NewOrg<'_>) -> R<()> {
    doc.put(ROOT, "name", o.name)?;
    doc.put(ROOT, "timezone", o.timezone)?;
    doc.put(ROOT, "locale", o.locale)?;
    let teams = ensure_map(doc, &ROOT, "teams")?;
    let t = doc.put_object(&teams, o.team_id, ObjType::Map)?;
    doc.put(&t, "name", o.team_name)?;
    put_list(doc, &t, "leadIds", &[o.creator.to_string()])?;
    put_list(doc, &t, "memberIds", &[o.creator.to_string()])?;
    add_member(
        doc,
        &NewMember {
            id: o.creator,
            name: o.creator_name,
            cafeca: o.creator_cafeca,
            handle: o.creator_handle,
            approved_by: None,
            now: o.now,
        },
    )
}

pub fn rename(doc: &mut AutoCommit, name: &str) -> R<()> {
    doc.put(ROOT, "name", name)?;
    Ok(())
}

/// 新成員（technical-design §16.8 v0.13）。
pub struct NewMember<'a> {
    pub id: MemberId,
    pub name: &'a str,
    pub cafeca: &'a str,
    pub handle: Option<&'a str>,
    pub approved_by: Option<MemberId>,
    pub now: Timestamp,
}

pub fn add_member(doc: &mut AutoCommit, n: &NewMember<'_>) -> R<()> {
    let members = ensure_map(doc, &ROOT, "members")?;
    let m = doc.put_object(&members, n.id.to_string().as_str(), ObjType::Map)?;
    doc.put(&m, "name", n.name)?;
    doc.put(&m, "joinedAt", n.now)?;
    doc.put(&m, "cafeca", n.cafeca)?;
    if let Some(h) = n.handle {
        doc.put(&m, "handle", h)?;
    }
    if let Some(a) = n.approved_by {
        doc.put(&m, "approvedBy", a.to_string().as_str())?;
    }
    Ok(())
}

pub fn add_to_team(doc: &mut AutoCommit, team: &str, id: &MemberId) -> R<()> {
    let teams = ensure_map(doc, &ROOT, "teams")?;
    let Some(t) = get_obj(doc, &teams, team) else {
        return Ok(());
    };
    let mut ids = get_strs(doc, &t, "memberIds");
    if !ids.contains(&id.to_string()) {
        ids.push(id.to_string());
        put_list(doc, &t, "memberIds", &ids)?;
    }
    Ok(())
}

/// 停用成員：從所有小組移除並標記移除時間（保留紀錄供交接，feature-plan §5.1）。
pub fn remove_member(doc: &mut AutoCommit, id: &MemberId, now: Timestamp) -> R<()> {
    let members = ensure_map(doc, &ROOT, "members")?;
    if let Some(m) = get_obj(doc, &members, &id.to_string()) {
        doc.put(&m, "removedAt", now)?;
    }
    let teams = ensure_map(doc, &ROOT, "teams")?;
    for k in doc.keys(&teams).collect::<Vec<_>>() {
        let Some(t) = get_obj(doc, &teams, &k) else {
            continue;
        };
        for field in ["memberIds", "leadIds"] {
            let ids = get_strs(doc, &t, field);
            if ids.contains(&id.to_string()) {
                let kept: Vec<String> = ids.into_iter().filter(|x| *x != id.to_string()).collect();
                put_list(doc, &t, field, &kept)?;
            }
        }
    }
    Ok(())
}

/// 新增或改名辦公室。
pub fn upsert_office(doc: &mut AutoCommit, id: &str, name: &str) -> R<()> {
    let offices = ensure_map(doc, &ROOT, "offices")?;
    let o = match get_obj(doc, &offices, id) {
        Some(o) => o,
        None => {
            let o = doc.put_object(&offices, id, ObjType::Map)?;
            doc.put_object(&o, "wifiHashes", ObjType::List)?;
            o
        }
    };
    doc.put(&o, "name", name)?;
    Ok(())
}

pub fn remove_office(doc: &mut AutoCommit, id: &str) -> R<()> {
    let offices = ensure_map(doc, &ROOT, "offices")?;
    if get_obj(doc, &offices, id).is_some() {
        doc.delete(&offices, id)?;
    }
    Ok(())
}

/// 設定或清除午休時段。
pub fn set_lunch_break(doc: &mut AutoCommit, lunch: Option<&LunchBreak>) -> R<()> {
    match lunch {
        Some(l) => {
            let m = doc.put_object(ROOT, "lunchBreak", ObjType::Map)?;
            doc.put(&m, "start", l.start.as_str())?;
            doc.put(&m, "end", l.end.as_str())?;
        }
        None => {
            if get_obj(doc, &ROOT, "lunchBreak").is_some() {
                doc.delete(ROOT, "lunchBreak")?;
            }
        }
    }
    Ok(())
}

/// `HH:MM`（00:00–23:59）。
pub fn valid_hhmm(s: &str) -> bool {
    let Some((h, m)) = s.split_once(':') else {
        return false;
    };
    h.len() == 2
        && m.len() == 2
        && h.parse::<u8>().is_ok_and(|h| h < 24)
        && m.parse::<u8>().is_ok_and(|m| m < 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn org_doc_roundtrip() {
        let a = MemberId([1; 16]);
        let b = MemberId([2; 16]);
        let mut doc = AutoCommit::new();
        init(
            &mut doc,
            &NewOrg {
                name: "CAFECA",
                timezone: "Asia/Taipei",
                locale: "zh-TW",
                creator: a,
                creator_name: "管理者",
                creator_cafeca: "eip155:8018:0x01",
                creator_handle: Some("admin"),
                team_id: "general",
                team_name: "全體",
                now: 1,
            },
        )
        .unwrap();
        add_member(
            &mut doc,
            &NewMember {
                id: b,
                name: "小明",
                cafeca: "eip155:8018:0x02",
                handle: None,
                approved_by: Some(a),
                now: 2,
            },
        )
        .unwrap();
        add_to_team(&mut doc, "general", &b).unwrap();
        add_to_team(&mut doc, "general", &b).unwrap();
        let s = read(&doc);
        assert_eq!(s.name, "CAFECA");
        assert_eq!(s.members.len(), 2);
        assert!(s.is_team_member("general", &b));
        assert_eq!(s.teams["general"].members.len(), 2);
        assert_eq!(s.members[&a].handle.as_deref(), Some("admin"));
        assert_eq!(s.members[&b].cafeca.as_deref(), Some("eip155:8018:0x02"));
        remove_member(&mut doc, &b, 3).unwrap();
        let s = read(&doc);
        assert!(!s.is_team_member("general", &b));
        assert_eq!(s.members[&b].removed_at, Some(3));
        assert_eq!(s.active_members().count(), 1);
    }

    #[test]
    fn offices_and_lunch() {
        let mut doc = AutoCommit::new();
        upsert_office(&mut doc, "tpe", "台北辦公室").unwrap();
        upsert_office(&mut doc, "hsz", "新竹").unwrap();
        upsert_office(&mut doc, "hsz", "新竹辦公室").unwrap();
        set_lunch_break(
            &mut doc,
            Some(&LunchBreak {
                start: "12:00".into(),
                end: "13:30".into(),
            }),
        )
        .unwrap();
        let s = read(&doc);
        assert_eq!(s.offices.len(), 2);
        assert_eq!(s.offices["hsz"].name, "新竹辦公室");
        assert_eq!(s.lunch_break.as_ref().unwrap().end, "13:30");
        remove_office(&mut doc, "tpe").unwrap();
        set_lunch_break(&mut doc, None).unwrap();
        let s = read(&doc);
        assert_eq!(s.offices.len(), 1);
        assert!(s.lunch_break.is_none());
        assert!(valid_hhmm("09:05") && !valid_hhmm("24:00") && !valid_hhmm("9:5"));
    }
}
