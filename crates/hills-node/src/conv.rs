//! M1 對話（technical-design §14，D34、D37）。
//!
//! - `conv/<convId>/meta`：只有建立者可寫；`convId = <建立者 memberId>-<ULID>`（§14.1 v0.9）
//! - `conv/<convId>/log/<yyyy-mm>`：成員只能新增自己的訊息（hills-sync `append_only_by`）

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, anyhow, bail};
use automerge::{AutoCommit, ROOT, ReadDoc, ScalarValue, Value, transaction::Transactable};
use hills_proto::{MemberId, Pub32, Timestamp};
use serde::{Deserialize, Serialize};

use crate::org::{ensure_map, get_int, get_obj, get_str};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConvKind {
    Dm,
    Group,
}

impl ConvKind {
    fn as_str(self) -> &'static str {
        match self {
            ConvKind::Dm => "dm",
            ConvKind::Group => "group",
        }
    }
}

/// 從 meta 讀出的對話資訊（只含本人能解密的對話）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConvInfo {
    pub id: String,
    pub kind: ConvKind,
    pub name: String,
    pub creator: MemberId,
    pub created_at: Timestamp,
    /// 現任成員（含建立者）
    pub members: BTreeSet<MemberId>,
    /// 現任成員加入時的 epoch（直連同步只回應 `epoch ≤ n` 的紀錄文件，§14.2 v0.9）
    #[serde(skip)]
    pub joined: BTreeMap<MemberId, u32>,
}

/// 一則訊息（§14.2）。`author` 由 key 前綴決定（驗證層保證與簽署者相同）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Message {
    pub id: String,
    pub conv: String,
    pub author: MemberId,
    pub created_at: Timestamp,
    pub kind: String,
    pub body: String,
    pub mentions: Vec<MemberId>,
    /// 附件（§14.2 Attachment，前端定義的 JSON；只出現在 CK 加密的訊息中）
    pub attachments: serde_json::Value,
}

/// 訊息在文件中的 JSON 內容（作者與 id 由 key 表示）。
#[derive(Serialize, Deserialize)]
struct MessageBody {
    v: u8,
    #[serde(rename = "createdAt")]
    created_at: Timestamp,
    kind: String,
    body: String,
    #[serde(default)]
    mentions: Vec<String>,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    attachments: serde_json::Value,
}

pub const MAX_BODY: usize = 16 * 1024;
pub const MAX_ATTACHMENTS_JSON: usize = 512 * 1024;

// ---------- ID ----------

const CROCKFORD: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// ULID（小寫 Crockford base32，26 字元）：48 bit 毫秒時間 + 80 bit 亂數。
pub fn ulid(now: Timestamp) -> Result<String> {
    let mut rand = [0u8; 10];
    getrandom::fill(&mut rand).map_err(|_| anyhow!("無法取得亂數"))?;
    let mut v: u128 = (u128::from(now.max(0) as u64) & ((1 << 48) - 1)) << 80;
    for (i, b) in rand.iter().enumerate() {
        v |= u128::from(*b) << (8 * (9 - i));
    }
    Ok((0..26)
        .map(|i| CROCKFORD[((v >> (5 * (25 - i))) & 31) as usize] as char)
        .collect())
}

pub fn new_conv_id(creator: &MemberId, now: Timestamp) -> Result<String> {
    Ok(format!("{creator}-{}", ulid(now)?))
}

/// convId 的建立者（前綴）。
pub fn creator_of(conv_id: &str) -> Option<MemberId> {
    let (m, rest) = conv_id.split_once('-')?;
    if rest.is_empty() {
        return None;
    }
    MemberId::parse(m).ok()
}

pub fn meta_doc(conv: &str) -> String {
    format!("conv/{conv}/meta")
}

pub fn log_doc(conv: &str, month: &str, epoch: u32) -> String {
    format!("conv/{conv}/log/{month}-e{epoch}")
}

/// 紀錄文件分段（`<yyyy-mm>-e<n>`）的 epoch。
pub fn segment_epoch(seg: &str) -> Option<u32> {
    seg.split_once("-e")?.1.parse().ok()
}

/// 解析 `conv/<id>/meta` 或 `conv/<id>/log/<分段>`。
pub fn parse_doc(doc_id: &str) -> Option<(String, Option<String>)> {
    let parts: Vec<&str> = doc_id.split('/').collect();
    match parts.as_slice() {
        ["conv", c, "meta"] => Some(((*c).to_owned(), None)),
        ["conv", c, "log", ym] => Some(((*c).to_owned(), Some((*ym).to_owned()))),
        _ => None,
    }
}

/// UTC 月份 `yyyy-mm`（Howard Hinnant 的 civil_from_days）。
pub fn month_of(ms: Timestamp) -> String {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}")
}

// ---------- meta ----------

type R<T> = Result<T, automerge::AutomergeError>;

pub fn init_meta(
    doc: &mut AutoCommit,
    kind: ConvKind,
    name: &str,
    members: &[MemberId],
    epoch: u32,
    now: Timestamp,
) -> R<()> {
    doc.put(ROOT, "v", 1i64)?;
    doc.put(ROOT, "kind", kind.as_str())?;
    doc.put(ROOT, "name", name)?;
    doc.put(ROOT, "createdAt", now)?;
    add_members(doc, members, epoch, now)
}

pub fn add_members(
    doc: &mut AutoCommit,
    members: &[MemberId],
    epoch: u32,
    now: Timestamp,
) -> R<()> {
    let map = ensure_map(doc, &ROOT, "members")?;
    for m in members {
        let key = m.to_string();
        let rec = match get_obj(doc, &map, &key) {
            Some(r) => r,
            None => doc.put_object(&map, key.as_str(), automerge::ObjType::Map)?,
        };
        doc.put(&rec, "addedAt", now)?;
        doc.put(&rec, "epoch", i64::from(epoch))?;
        if doc.get(&rec, "removedAt")?.is_some() {
            doc.delete(&rec, "removedAt")?;
        }
    }
    Ok(())
}

pub fn remove_member(doc: &mut AutoCommit, member: &MemberId, now: Timestamp) -> R<()> {
    if let Some(map) = get_obj(doc, &ROOT, "members")
        && let Some(rec) = get_obj(doc, &map, &member.to_string())
    {
        doc.put(&rec, "removedAt", now)?;
    }
    Ok(())
}

pub fn rename(doc: &mut AutoCommit, name: &str) -> R<()> {
    doc.put(ROOT, "name", name)
}

/// 讀取 meta；尚未建立（空文件）時回傳 None。
pub fn read_meta(conv: &str, doc: &AutoCommit) -> Option<ConvInfo> {
    let creator = creator_of(conv)?;
    let kind = match get_str(doc, &ROOT, "kind")?.as_str() {
        "dm" => ConvKind::Dm,
        _ => ConvKind::Group,
    };
    let mut members = BTreeSet::new();
    let mut joined = BTreeMap::new();
    if let Some(map) = get_obj(doc, &ROOT, "members") {
        for k in doc.keys(&map) {
            let (Ok(id), Some(rec)) = (MemberId::parse(&k), get_obj(doc, &map, &k)) else {
                continue;
            };
            if get_int(doc, &rec, "removedAt").is_none() {
                members.insert(id);
                let e = get_int(doc, &rec, "epoch").unwrap_or(1);
                joined.insert(id, u32::try_from(e).unwrap_or(u32::MAX));
            }
        }
    }
    Some(ConvInfo {
        id: conv.to_owned(),
        kind,
        name: get_str(doc, &ROOT, "name").unwrap_or_default(),
        creator,
        created_at: get_int(doc, &ROOT, "createdAt").unwrap_or(0),
        members,
        joined,
    })
}

// ---------- log ----------

pub struct NewMessage<'a> {
    pub kind: &'a str,
    pub body: &'a str,
    pub mentions: &'a [MemberId],
    pub attachments: serde_json::Value,
}

/// 新增一則訊息，回傳 key（`<author>:<ulid>`）。
pub fn append(
    doc: &mut AutoCommit,
    author: &MemberId,
    msg: &NewMessage<'_>,
    now: Timestamp,
) -> Result<String> {
    if msg.body.len() > MAX_BODY {
        bail!("訊息過長");
    }
    let body = MessageBody {
        v: 1,
        created_at: now,
        kind: msg.kind.to_owned(),
        body: msg.body.to_owned(),
        mentions: msg.mentions.iter().map(|m| m.to_string()).collect(),
        attachments: msg.attachments.clone(),
    };
    let json = serde_json::to_string(&body)?;
    if json.len() > MAX_BODY + MAX_ATTACHMENTS_JSON {
        bail!("附件資料過大");
    }
    let key = format!("{author}:{}", ulid(now)?);
    doc.put(ROOT, key.as_str(), json)?;
    Ok(key)
}

fn parse_message(conv: &str, key: &str, json: &str) -> Option<Message> {
    let (author, id) = key.split_once(':')?;
    let author = MemberId::parse(author).ok()?;
    let b: MessageBody = serde_json::from_str(json).ok()?;
    Some(Message {
        id: id.to_owned(),
        conv: conv.to_owned(),
        author,
        created_at: b.created_at,
        kind: b.kind,
        body: b.body,
        mentions: b
            .mentions
            .iter()
            .filter_map(|m| MemberId::parse(m).ok())
            .collect(),
        attachments: b.attachments,
    })
}

/// 讀出一個月份文件中的全部訊息。
pub fn read_log(conv: &str, doc: &AutoCommit) -> Vec<Message> {
    doc.keys(&ROOT)
        .filter_map(|k| match doc.get(&ROOT, &k).ok()??.0 {
            Value::Scalar(s) => match s.as_ref() {
                ScalarValue::Str(t) => parse_message(conv, &k, t),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// 依 key 讀出特定訊息（新收到的 change 用）。
pub fn read_keys(conv: &str, doc: &AutoCommit, keys: &[String]) -> Vec<Message> {
    keys.iter()
        .filter_map(|k| match doc.get(&ROOT, k).ok()??.0 {
            Value::Scalar(s) => match s.as_ref() {
                ScalarValue::Str(t) => parse_message(conv, k, t),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// change 新增的 key（已通過 append_only 驗證）。
pub fn added_keys(change: &automerge::Change) -> Vec<String> {
    use automerge::legacy::Key;
    change
        .decode()
        .operations
        .iter()
        .filter_map(|op| match &op.key {
            Key::Map(k) => Some(k.to_string()),
            Key::Seq(_) => None,
        })
        .collect()
}

/// 排序：時間、id。
pub fn sort_messages(v: &mut [Message]) {
    v.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
}

/// 本機已讀紀錄（只存本機，§14.1 v0.9）。
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ReadMarks(pub BTreeMap<String, Timestamp>);

/// 封裝對話金鑰給成員所需的公鑰。
pub type Recipient = (MemberId, Pub32);

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn mid(b: u8) -> MemberId {
        MemberId([b; 16])
    }

    #[test]
    fn conv_id_carries_creator() {
        let id = new_conv_id(&mid(3), 1_700_000_000_000).unwrap();
        assert_eq!(creator_of(&id), Some(mid(3)));
        assert!(id.len() <= 64);
        assert!(hills_sync::DocKind::parse(&meta_doc(&id)).is_some());
        assert!(hills_sync::DocKind::parse(&log_doc(&id, "2026-11", 3)).is_some());
        assert_eq!(segment_epoch("2026-11-e3"), Some(3));
        assert_eq!(creator_of("nope"), None);
    }

    #[test]
    fn months() {
        assert_eq!(month_of(0), "1970-01");
        assert_eq!(month_of(1_793_923_200_000), "2026-11");
        assert_eq!(month_of(951_782_400_000), "2000-02"); // 2000-02-29
    }

    #[test]
    fn ulid_is_sortable() {
        let a = ulid(1000).unwrap();
        let b = ulid(2000).unwrap();
        assert_eq!(a.len(), 26);
        assert!(a < b);
    }

    #[test]
    fn meta_and_log_roundtrip() {
        let mut meta = AutoCommit::new();
        let conv = new_conv_id(&mid(1), 5).unwrap();
        init_meta(&mut meta, ConvKind::Group, "g", &[mid(1), mid(2)], 1, 5).unwrap();
        remove_member(&mut meta, &mid(2), 6).unwrap();
        let info = read_meta(&conv, &meta).unwrap();
        assert_eq!(info.members, [mid(1)].into_iter().collect());
        assert_eq!(info.creator, mid(1));

        let mut log = AutoCommit::new();
        let before = log.get_heads();
        let msg = NewMessage {
            kind: "text",
            body: "hi @x",
            mentions: &[mid(2)],
            attachments: serde_json::Value::Null,
        };
        append(&mut log, &mid(1), &msg, 7).unwrap();
        log.commit();
        let changes = log.get_changes(&before);
        assert!(hills_sync::append_only_by(&changes[0], &mid(1)));
        assert!(!hills_sync::append_only_by(&changes[0], &mid(2)));
        let msgs = read_log(&conv, &log);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].author, mid(1));
        assert_eq!(msgs[0].mentions, vec![mid(2)]);
        assert_eq!(added_keys(&changes[0]).len(), 1);
    }

    #[test]
    fn overwriting_a_message_is_not_append_only() {
        let mut log = AutoCommit::new();
        let msg = NewMessage {
            kind: "text",
            body: "a",
            mentions: &[],
            attachments: serde_json::Value::Null,
        };
        let key = append(&mut log, &mid(1), &msg, 7).unwrap();
        log.commit();
        let before = log.get_heads();
        log.put(ROOT, key.as_str(), "{}").unwrap();
        log.commit();
        let c = log.get_changes(&before);
        assert!(!hills_sync::append_only_by(&c[0], &mid(1)));
    }
}
