//! org 文件結構（technical-design §16.8）與 `member/<id>/secrets`。

use std::collections::BTreeMap;

use automerge::{
    AutoCommit, ObjId, ObjType, ROOT, ReadDoc, ScalarValue, Value, transaction::Transactable,
};
use hills_proto::{MemberId, Role, Timestamp};
use hills_sync::Directory;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MemberRec {
    pub name: String,
    pub joined_at: Timestamp,
    pub removed_at: Option<Timestamp>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TeamRec {
    pub name: String,
    pub leads: Vec<MemberId>,
    pub members: Vec<MemberId>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InviteRec {
    pub secret_hash: String,
    pub role: Role,
    pub team_ids: Vec<String>,
    pub expires_at: Timestamp,
    pub created_by: MemberId,
    pub used_by: Option<MemberId>,
    pub revoked: bool,
}

/// org 文件的唯讀快照。
#[derive(Debug, Clone, Default, Serialize)]
pub struct OrgSnapshot {
    pub name: String,
    pub timezone: String,
    pub locale: String,
    pub members: BTreeMap<MemberId, MemberRec>,
    pub teams: BTreeMap<String, TeamRec>,
    pub invites: BTreeMap<String, InviteRec>,
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

fn get_bool(doc: &AutoCommit, obj: &ObjId, key: &str) -> bool {
    matches!(doc.get(obj, key).ok().flatten().map(|v| v.0), Some(Value::Scalar(s)) if matches!(s.as_ref(), ScalarValue::Boolean(true)))
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

fn role_of(s: &str) -> Role {
    if s == "admin" {
        Role::Admin
    } else {
        Role::Member
    }
}

fn role_str(r: Role) -> &'static str {
    match r {
        Role::Admin => "admin",
        Role::Member => "member",
    }
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
    if let Some(invites) = get_obj(doc, &ROOT, "invites") {
        for k in doc.keys(&invites) {
            let Some(i) = get_obj(doc, &invites, &k) else {
                continue;
            };
            let Some(created_by) =
                get_str(doc, &i, "createdBy").and_then(|c| MemberId::parse(&c).ok())
            else {
                continue;
            };
            s.invites.insert(
                k.clone(),
                InviteRec {
                    secret_hash: get_str(doc, &i, "secretHash").unwrap_or_default(),
                    role: role_of(&get_str(doc, &i, "role").unwrap_or_default()),
                    team_ids: get_strs(doc, &i, "teamIds"),
                    expires_at: get_int(doc, &i, "expiresAt").unwrap_or(0),
                    created_by,
                    used_by: get_str(doc, &i, "usedBy").and_then(|u| MemberId::parse(&u).ok()),
                    revoked: get_bool(doc, &i, "revoked"),
                },
            );
        }
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
    pub team_id: &'a str,
    pub team_name: &'a str,
    pub now: Timestamp,
}

pub fn init(doc: &mut AutoCommit, o: &NewOrg<'_>) -> R<()> {
    doc.put(ROOT, "name", o.name)?;
    doc.put(ROOT, "timezone", o.timezone)?;
    doc.put(ROOT, "locale", o.locale)?;
    ensure_map(doc, &ROOT, "invites")?;
    let teams = ensure_map(doc, &ROOT, "teams")?;
    let t = doc.put_object(&teams, o.team_id, ObjType::Map)?;
    doc.put(&t, "name", o.team_name)?;
    put_list(doc, &t, "leadIds", &[o.creator.to_string()])?;
    put_list(doc, &t, "memberIds", &[o.creator.to_string()])?;
    add_member(doc, &o.creator, o.creator_name, o.now)
}

pub fn rename(doc: &mut AutoCommit, name: &str) -> R<()> {
    doc.put(ROOT, "name", name)?;
    Ok(())
}

pub fn add_member(doc: &mut AutoCommit, id: &MemberId, name: &str, now: Timestamp) -> R<()> {
    let members = ensure_map(doc, &ROOT, "members")?;
    let m = doc.put_object(&members, id.to_string().as_str(), ObjType::Map)?;
    doc.put(&m, "name", name)?;
    doc.put(&m, "joinedAt", now)?;
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

pub fn add_invite(doc: &mut AutoCommit, id: &str, rec: &InviteRec) -> R<()> {
    let invites = ensure_map(doc, &ROOT, "invites")?;
    let i = doc.put_object(&invites, id, ObjType::Map)?;
    doc.put(&i, "secretHash", rec.secret_hash.as_str())?;
    doc.put(&i, "role", role_str(rec.role))?;
    put_list(doc, &i, "teamIds", &rec.team_ids)?;
    doc.put(&i, "expiresAt", rec.expires_at)?;
    doc.put(&i, "createdBy", rec.created_by.to_string().as_str())?;
    doc.put(&i, "revoked", rec.revoked)?;
    Ok(())
}

pub fn mark_invite_used(doc: &mut AutoCommit, id: &str, by: &MemberId) -> R<()> {
    let invites = ensure_map(doc, &ROOT, "invites")?;
    if let Some(i) = get_obj(doc, &invites, id) {
        doc.put(&i, "usedBy", by.to_string().as_str())?;
    }
    Ok(())
}

pub fn revoke_invite(doc: &mut AutoCommit, id: &str) -> R<()> {
    let invites = ensure_map(doc, &ROOT, "invites")?;
    if let Some(i) = get_obj(doc, &invites, id) {
        doc.put(&i, "revoked", true)?;
    }
    Ok(())
}

// ---------- member/<id>/secrets ----------

pub fn put_invite_secret(doc: &mut AutoCommit, invite_id: &str, secret_hex: &str) -> R<()> {
    let invites = ensure_map(doc, &ROOT, "invites")?;
    doc.put(&invites, invite_id, secret_hex)?;
    Ok(())
}

pub fn invite_secret(doc: &AutoCommit, invite_id: &str) -> Option<String> {
    let invites = get_obj(doc, &ROOT, "invites")?;
    get_str(doc, &invites, invite_id)
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
                team_id: "general",
                team_name: "全體",
                now: 1,
            },
        )
        .unwrap();
        add_member(&mut doc, &b, "小明", 2).unwrap();
        add_to_team(&mut doc, "general", &b).unwrap();
        add_to_team(&mut doc, "general", &b).unwrap();
        add_invite(
            &mut doc,
            "abcd",
            &InviteRec {
                secret_hash: "h".into(),
                role: Role::Member,
                team_ids: vec!["general".into()],
                expires_at: 9,
                created_by: a,
                used_by: None,
                revoked: false,
            },
        )
        .unwrap();
        mark_invite_used(&mut doc, "abcd", &b).unwrap();
        let s = read(&doc);
        assert_eq!(s.name, "CAFECA");
        assert_eq!(s.members.len(), 2);
        assert!(s.is_team_member("general", &b));
        assert_eq!(s.teams["general"].members.len(), 2);
        assert_eq!(s.invites["abcd"].used_by, Some(b));
        remove_member(&mut doc, &b, 3).unwrap();
        let s = read(&doc);
        assert!(!s.is_team_member("general", &b));
        assert_eq!(s.members[&b].removed_at, Some(3));
        assert_eq!(s.active_members().count(), 1);
    }

    #[test]
    fn secrets_doc() {
        let mut doc = AutoCommit::new();
        put_invite_secret(&mut doc, "abcd", "00ff").unwrap();
        assert_eq!(invite_secret(&doc, "abcd").as_deref(), Some("00ff"));
        assert_eq!(invite_secret(&doc, "nope"), None);
    }
}
