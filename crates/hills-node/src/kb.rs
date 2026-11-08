//! 知識庫（technical-design §16.11 v0.16，D42「星空」）。
//!
//! - `kb/meta`：分類 `cat:<ULID>` 與主題 `topic:<ULID>`（map），任何成員可建立、改名、合併
//! - `kb/items/<yyyy-mm>`：知識，key = `<作者>:<ULID>`、值為 JSON 字串；只有作者與管理者可改
//!   （驗證層 `hills_sync::own_keys_or_admin`）

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, anyhow, bail};
use automerge::{
    AutoCommit, ObjType, ROOT, ReadDoc, ScalarValue, Value, transaction::Transactable,
};
use hills_proto::{MemberId, Timestamp};
use hills_sync::DocKind;
use serde::{Deserialize, Serialize};

use crate::conv::{self, MAX_ATTACHMENTS_JSON};
use crate::node::{Node, now_ms};
use crate::org::{get_int, get_obj, get_str};

pub const META_DOC: &str = "kb/meta";
const CAT_PREFIX: &str = "cat:";
const TOPIC_PREFIX: &str = "topic:";
const MAX_TITLE: usize = 200;
const MAX_NAME: usize = 60;
const MAX_BODY: usize = 64 * 1024;
const MAX_TAGS: usize = 10;
const MAX_TAG: usize = 30;
const MAX_REFS: usize = 20;

pub fn items_doc(month: &str) -> String {
    format!("kb/items/{month}")
}

const CROCKFORD: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// ULID 前 10 字元的毫秒時間。
pub fn ulid_time(id: &str) -> Option<Timestamp> {
    if id.len() != 26 {
        return None;
    }
    let mut v: u64 = 0;
    for c in id.bytes().take(10) {
        let d = CROCKFORD
            .iter()
            .position(|x| *x == c.to_ascii_lowercase())? as u64;
        v = (v << 5) | d;
    }
    i64::try_from(v).ok()
}

/// 知識 key（`<作者>:<ULID>`）所在的月份文件。
pub fn doc_of_key(key: &str) -> Option<String> {
    let (_, id) = key.split_once(':')?;
    Some(items_doc(&conv::month_of(ulid_time(id)?)))
}

fn author_of(key: &str) -> Option<MemberId> {
    MemberId::parse(key.split_once(':')?.0).ok()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbCategory {
    pub id: String,
    pub name: String,
    pub created_at: Timestamp,
    /// 合併後的最終分類（沒有合併時等於自己）
    pub resolved: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbTopic {
    pub id: String,
    pub name: String,
    pub category_id: String,
    pub created_at: Timestamp,
    /// 合併後的最終主題
    pub resolved: String,
}

/// 知識來源（§16.11）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum KbSource {
    Manual,
    Message {
        #[serde(rename = "convId")]
        conv_id: String,
        #[serde(rename = "messageKey")]
        message_key: String,
    },
    File {
        #[serde(rename = "convId")]
        conv_id: String,
        attachment: serde_json::Value,
    },
    Task {
        #[serde(rename = "teamId")]
        team_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
    },
}

/// 文件中的 JSON 內容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemBody {
    v: u8,
    title: String,
    body: String,
    #[serde(default)]
    tags: Vec<String>,
    topic_id: String,
    #[serde(default)]
    refs: Vec<String>,
    source: KbSource,
    created_at: Timestamp,
    updated_at: Timestamp,
    updated_by: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbItem {
    /// `<作者>:<ULID>`
    pub key: String,
    #[serde(serialize_with = "member_str")]
    pub author: MemberId,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub topic_id: String,
    pub refs: Vec<String>,
    pub source: KbSource,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub updated_by: String,
}

fn member_str<S: serde::Serializer>(m: &MemberId, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&m.to_string())
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct KbSnapshot {
    pub categories: Vec<KbCategory>,
    pub topics: Vec<KbTopic>,
    pub items: Vec<KbItem>,
}

/// 新增或更新知識的輸入。`key` 為空時新增。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbInput {
    #[serde(default)]
    pub key: Option<String>,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub topic_id: String,
    #[serde(default)]
    pub refs: Vec<String>,
    /// 新增時的來源；更新時忽略（保留原來源）
    #[serde(default)]
    pub source: Option<KbSource>,
}

/// 沿 `mergedInto` 鏈找到最終 id；遇到循環時取鏈上 id 最小者（§16.11）。
pub fn resolve(id: &str, merged: &BTreeMap<String, String>) -> String {
    let mut seen = BTreeSet::new();
    let mut cur = id.to_owned();
    while let Some(next) = merged.get(&cur) {
        if !seen.insert(cur.clone()) {
            return seen.into_iter().next().unwrap_or(cur);
        }
        cur = next.clone();
    }
    cur
}

/// 讀出分類與主題（含合併後的最終 id）。
pub fn read_meta(doc: &AutoCommit) -> (Vec<KbCategory>, Vec<KbTopic>) {
    let mut cats = Vec::new();
    let mut topics = Vec::new();
    let mut cat_merge = BTreeMap::new();
    let mut topic_merge = BTreeMap::new();
    for k in doc.keys(ROOT) {
        let Some(o) = get_obj(doc, &ROOT, &k) else {
            continue;
        };
        let name = get_str(doc, &o, "name").unwrap_or_default();
        let created_at = get_int(doc, &o, "createdAt").unwrap_or(0);
        let merged = get_str(doc, &o, "mergedInto");
        if let Some(id) = k.strip_prefix(CAT_PREFIX) {
            if let Some(m) = merged {
                cat_merge.insert(id.to_owned(), m);
            }
            cats.push(KbCategory {
                id: id.to_owned(),
                name,
                created_at,
                resolved: String::new(),
            });
        } else if let Some(id) = k.strip_prefix(TOPIC_PREFIX) {
            if let Some(m) = merged {
                topic_merge.insert(id.to_owned(), m);
            }
            topics.push(KbTopic {
                id: id.to_owned(),
                name,
                category_id: get_str(doc, &o, "categoryId").unwrap_or_default(),
                created_at,
                resolved: String::new(),
            });
        }
    }
    for c in &mut cats {
        c.resolved = resolve(&c.id, &cat_merge);
    }
    for t in &mut topics {
        t.resolved = resolve(&t.id, &topic_merge);
        // 主題的分類也沿合併鏈
        t.category_id = resolve(&t.category_id, &cat_merge);
    }
    cats.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    topics.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    (cats, topics)
}

/// 讀出一份知識文件。key 前綴不是合法 memberId 或 JSON 無效的項目略過。
pub fn read_items(doc: &AutoCommit) -> Vec<KbItem> {
    doc.keys(ROOT)
        .filter_map(|k| {
            let author = author_of(&k)?;
            let json = match doc.get(ROOT, &k).ok()??.0 {
                Value::Scalar(s) => match s.as_ref() {
                    ScalarValue::Str(t) => t.to_string(),
                    _ => return None,
                },
                _ => return None,
            };
            let b: ItemBody = serde_json::from_str(&json).ok()?;
            Some(KbItem {
                key: k,
                author,
                title: b.title,
                body: b.body,
                tags: b.tags,
                topic_id: b.topic_id,
                refs: b.refs,
                source: b.source,
                created_at: b.created_at,
                updated_at: b.updated_at,
                updated_by: b.updated_by,
            })
        })
        .collect()
}

fn check_name(name: &str) -> Result<String> {
    let n = name.trim();
    let len = n.chars().count();
    if len == 0 || len > MAX_NAME {
        bail!("名稱需為 1–{MAX_NAME} 字");
    }
    Ok(n.to_owned())
}

fn validate(input: &KbInput) -> Result<()> {
    let n = input.title.trim().chars().count();
    if n == 0 || n > MAX_TITLE {
        bail!("知識標題需為 1–{MAX_TITLE} 字");
    }
    if input.body.len() > MAX_BODY {
        bail!("內容過長（最多 64 KB）");
    }
    if input.tags.len() > MAX_TAGS
        || input
            .tags
            .iter()
            .any(|t| t.trim().is_empty() || t.chars().count() > MAX_TAG)
    {
        bail!("標籤最多 {MAX_TAGS} 個，每個 1–{MAX_TAG} 字");
    }
    if input.refs.len() > MAX_REFS {
        bail!("引用最多 {MAX_REFS} 則");
    }
    if let Some(KbSource::File { attachment, .. }) = &input.source
        && serde_json::to_string(attachment)?.len() > MAX_ATTACHMENTS_JSON
    {
        bail!("附件資料過大");
    }
    Ok(())
}

impl Node {
    /// 知識庫的全部內容（本機已同步的部分）。
    pub fn kb(&self) -> Result<KbSnapshot> {
        let (categories, topics) = self.read_doc(META_DOC, read_meta)?;
        let mut items = Vec::new();
        for id in self.inner.store.doc_ids()? {
            if matches!(DocKind::parse(&id), Some(DocKind::KbItems(_))) {
                items.extend(self.read_doc(&id, read_items)?);
            }
        }
        items.sort_by(|a, b| (a.created_at, &a.key).cmp(&(b.created_at, &b.key)));
        Ok(KbSnapshot {
            categories,
            topics,
            items,
        })
    }

    pub async fn kb_create_category(&self, name: &str) -> Result<String> {
        let name = check_name(name)?;
        let now = now_ms();
        let id = conv::ulid(now)?;
        let me = self.member_id().to_string();
        self.change(META_DOC, |doc| {
            let o = doc.put_object(ROOT, format!("{CAT_PREFIX}{id}").as_str(), ObjType::Map)?;
            doc.put(&o, "name", name.as_str())?;
            doc.put(&o, "createdAt", now)?;
            doc.put(&o, "createdBy", me.as_str())?;
            Ok(())
        })
        .await?;
        Ok(id)
    }

    pub async fn kb_create_topic(&self, category: &str, name: &str) -> Result<String> {
        let name = check_name(name)?;
        let (cats, _) = self.read_doc(META_DOC, read_meta)?;
        if !cats.iter().any(|c| c.id == category) {
            bail!("找不到分類");
        }
        let now = now_ms();
        let id = conv::ulid(now)?;
        let me = self.member_id().to_string();
        self.change(META_DOC, |doc| {
            let o = doc.put_object(ROOT, format!("{TOPIC_PREFIX}{id}").as_str(), ObjType::Map)?;
            doc.put(&o, "name", name.as_str())?;
            doc.put(&o, "categoryId", category)?;
            doc.put(&o, "createdAt", now)?;
            doc.put(&o, "createdBy", me.as_str())?;
            Ok(())
        })
        .await?;
        Ok(id)
    }

    fn meta_key(kind: &str, id: &str) -> Result<String> {
        match kind {
            "category" => Ok(format!("{CAT_PREFIX}{id}")),
            "topic" => Ok(format!("{TOPIC_PREFIX}{id}")),
            _ => bail!("未知的類型"),
        }
    }

    /// 分類或主題改名（`kind` = category / topic）。
    pub async fn kb_rename(&self, kind: &str, id: &str, name: &str) -> Result<()> {
        let name = check_name(name)?;
        let key = Self::meta_key(kind, id)?;
        self.change(META_DOC, |doc| {
            let o = get_obj(doc, &ROOT, &key).ok_or_else(|| anyhow!("找不到項目"))?;
            doc.put(&o, "name", name.as_str())?;
            Ok(())
        })
        .await
    }

    /// 把 `from` 合併到 `into`（同類型）。
    pub async fn kb_merge(&self, kind: &str, from: &str, into: &str) -> Result<()> {
        if from == into {
            bail!("不能合併到自己");
        }
        let key = Self::meta_key(kind, from)?;
        let target = Self::meta_key(kind, into)?;
        self.change(META_DOC, |doc| {
            if get_obj(doc, &ROOT, &target).is_none() {
                bail!("找不到合併目標");
            }
            let o = get_obj(doc, &ROOT, &key).ok_or_else(|| anyhow!("找不到項目"))?;
            doc.put(&o, "mergedInto", into)?;
            Ok(())
        })
        .await
    }

    fn can_edit(&self, key: &str) -> bool {
        author_of(key) == Some(self.member_id()) || self.is_admin()
    }

    /// 新增或更新知識，回傳 key。更新只允許作者與管理者。
    pub async fn kb_save(&self, input: KbInput) -> Result<String> {
        validate(&input)?;
        let snap = self.kb()?;
        if !snap.topics.iter().any(|t| t.id == input.topic_id) {
            bail!("找不到主題");
        }
        let existing = match input.key.as_deref().filter(|k| !k.is_empty()) {
            Some(k) => Some(
                snap.items
                    .iter()
                    .find(|i| i.key == k)
                    .cloned()
                    .ok_or_else(|| anyhow!("找不到知識"))?,
            ),
            None => None,
        };
        let now = now_ms();
        let me = self.member_id();
        let key = match &existing {
            Some(e) => {
                if !self.can_edit(&e.key) {
                    bail!("只有作者與管理者能編輯這則知識");
                }
                e.key.clone()
            }
            None => format!("{me}:{}", conv::ulid(now)?),
        };
        let mut refs: Vec<String> = Vec::new();
        for r in &input.refs {
            if *r != key && !refs.contains(r) {
                if !snap.items.iter().any(|i| i.key == *r) {
                    bail!("引用的知識不存在");
                }
                refs.push(r.clone());
            }
        }
        let body = ItemBody {
            v: 1,
            title: input.title.trim().to_owned(),
            body: input.body.clone(),
            tags: input.tags.iter().map(|t| t.trim().to_owned()).collect(),
            topic_id: input.topic_id.clone(),
            refs,
            source: match &existing {
                Some(e) => e.source.clone(),
                None => input.source.clone().unwrap_or(KbSource::Manual),
            },
            created_at: existing.as_ref().map_or(now, |e| e.created_at),
            updated_at: now,
            updated_by: me.to_string(),
        };
        let json = serde_json::to_string(&body)?;
        let doc_id = doc_of_key(&key).ok_or_else(|| anyhow!("知識 key 無效"))?;
        self.change(&doc_id, |doc| {
            doc.put(ROOT, key.as_str(), json)?;
            Ok(())
        })
        .await?;
        Ok(key)
    }

    pub async fn kb_delete(&self, key: &str) -> Result<()> {
        if !self.can_edit(key) {
            bail!("只有作者與管理者能刪除這則知識");
        }
        let doc_id = doc_of_key(key).ok_or_else(|| anyhow!("知識 key 無效"))?;
        self.change(&doc_id, |doc| {
            if doc.get(ROOT, key)?.is_none() {
                bail!("找不到知識");
            }
            doc.delete(ROOT, key)?;
            Ok(())
        })
        .await
    }

    /// 從對話訊息存成知識（必須是對話成員）：內容為訊息內容，附件訊息的來源為檔案。
    pub async fn kb_from_message(
        &self,
        conv_id: &str,
        message_key: &str,
        topic_id: &str,
        title: &str,
        attachment: Option<usize>,
    ) -> Result<String> {
        let msg = self
            .messages(conv_id, usize::MAX)?
            .into_iter()
            .find(|m| format!("{}:{}", m.author, m.id) == message_key)
            .ok_or_else(|| anyhow!("找不到訊息"))?;
        let source = match attachment {
            Some(i) => KbSource::File {
                conv_id: conv_id.to_owned(),
                attachment: msg
                    .attachments
                    .as_array()
                    .and_then(|a| a.get(i))
                    .cloned()
                    .ok_or_else(|| anyhow!("找不到附件"))?,
            },
            None => KbSource::Message {
                conv_id: conv_id.to_owned(),
                message_key: message_key.to_owned(),
            },
        };
        self.kb_save(KbInput {
            key: None,
            title: title.to_owned(),
            body: msg.body,
            tags: vec![],
            topic_id: topic_id.to_owned(),
            refs: vec![],
            source: Some(source),
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ulid_month_roundtrip() {
        let t = 1_794_000_000_000;
        let id = conv::ulid(t).unwrap();
        assert_eq!(ulid_time(&id), Some(t));
        let key = format!("{}:{id}", MemberId([1; 16]));
        assert_eq!(doc_of_key(&key), Some(items_doc(&conv::month_of(t))));
        assert_eq!(doc_of_key("bad"), None);
        assert_eq!(ulid_time("short"), None);
    }

    #[test]
    fn merge_chains_and_cycles() {
        let m: BTreeMap<String, String> = [("a", "b"), ("b", "c"), ("x", "y"), ("y", "x")]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        assert_eq!(resolve("a", &m), "c");
        assert_eq!(resolve("c", &m), "c");
        assert_eq!(resolve("x", &m), "x");
        assert_eq!(resolve("y", &m), "x");
    }

    #[test]
    fn meta_and_items_read() {
        let mut doc = AutoCommit::new();
        for (k, name) in [("cat:c1", "工程"), ("cat:c2", "開發")] {
            let o = doc.put_object(ROOT, k, ObjType::Map).unwrap();
            doc.put(&o, "name", name).unwrap();
        }
        let t = doc.put_object(ROOT, "topic:t1", ObjType::Map).unwrap();
        doc.put(&t, "name", "儲存").unwrap();
        doc.put(&t, "categoryId", "c2").unwrap();
        let c2 = get_obj(&doc, &ROOT, "cat:c2").unwrap();
        doc.put(&c2, "mergedInto", "c1").unwrap();
        let (cats, topics) = read_meta(&doc);
        assert_eq!(cats.len(), 2);
        assert_eq!(cats.iter().find(|c| c.id == "c2").unwrap().resolved, "c1");
        assert_eq!(topics[0].category_id, "c1", "主題的分類沿合併鏈");

        let mut items = AutoCommit::new();
        let me = MemberId([2; 16]);
        let body = ItemBody {
            v: 1,
            title: "D39".into(),
            body: "內容".into(),
            tags: vec!["儲存".into()],
            topic_id: "t1".into(),
            refs: vec![],
            source: KbSource::Message {
                conv_id: "c".into(),
                message_key: "m".into(),
            },
            created_at: 1,
            updated_at: 2,
            updated_by: me.to_string(),
        };
        items
            .put(
                ROOT,
                format!("{me}:01").as_str(),
                serde_json::to_string(&body).unwrap(),
            )
            .unwrap();
        items.put(ROOT, "notamember:01", "{}").unwrap();
        let read = read_items(&items);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].author, me);
        let v = serde_json::to_value(&read[0]).unwrap();
        assert_eq!(v["author"], me.to_string());
        assert_eq!(v["source"]["kind"], "message");
        assert_eq!(v["source"]["convId"], "c");
    }

    #[test]
    fn validation() {
        let base = KbInput {
            key: None,
            title: "t".into(),
            body: String::new(),
            tags: vec![],
            topic_id: "x".into(),
            refs: vec![],
            source: None,
        };
        assert!(validate(&base).is_ok());
        let mut bad = base.clone();
        bad.title = " ".into();
        assert!(validate(&bad).is_err());
        let mut bad = base.clone();
        bad.tags = (0..11).map(|i| i.to_string()).collect();
        assert!(validate(&bad).is_err());
        let mut bad = base;
        bad.body = "x".repeat(MAX_BODY + 1);
        assert!(validate(&bad).is_err());
    }
}
