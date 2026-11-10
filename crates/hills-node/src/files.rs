//! 檔案索引（technical-design §16.19 v0.35，feature-plan D64）。
//!
//! 「檔案」頁列出本人看得到的所有附件：對話訊息（§14.2）、任務結案報告（§16.8）、
//! 知識庫的檔案來源（§16.11）。不新增同步文件，每次從本機已解密的文件建立；
//! 本機下載紀錄（`downloads`）只存在這台裝置。

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use anyhow::{Result, anyhow};
use hills_proto::{MemberId, Timestamp};
use serde::{Deserialize, Serialize};

use crate::conv::Message;
use crate::kb::{KbItem, KbSource};
use crate::node::{Node, lock};
use crate::task_report::TaskReport;

const DOWNLOADS: &str = "downloads";
/// 儲存節點上的檔案保留期（D16，預設 1 年）
pub const RETENTION_MS: i64 = 365 * 86_400_000;
const EXCERPT: usize = 80;

/// 檔案的一個出處。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileSource {
    #[serde(rename_all = "camelCase")]
    Message {
        conv_id: String,
        message_id: String,
        #[serde(serialize_with = "member_str")]
        author: MemberId,
        at: Timestamp,
        excerpt: String,
    },
    #[serde(rename_all = "camelCase")]
    TaskReport {
        team: String,
        task: String,
        title: String,
        author: Option<String>,
        at: Timestamp,
    },
    #[serde(rename_all = "camelCase")]
    Kb {
        kb_key: String,
        title: String,
        #[serde(serialize_with = "member_str")]
        author: MemberId,
        at: Timestamp,
    },
}

fn member_str<S: serde::Serializer>(m: &MemberId, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&m.to_string())
}

impl FileSource {
    pub fn at(&self) -> Timestamp {
        match self {
            Self::Message { at, .. } | Self::TaskReport { at, .. } | Self::Kb { at, .. } => *at,
        }
    }

    fn author(&self) -> Option<String> {
        match self {
            Self::Message { author, .. } | Self::Kb { author, .. } => Some(author.to_string()),
            Self::TaskReport { author, .. } => author.clone(),
        }
    }

    fn sort_key(&self) -> (Timestamp, String) {
        let id = match self {
            Self::Message { message_id, .. } => message_id.clone(),
            Self::TaskReport { team, task, .. } => format!("{team}/{task}"),
            Self::Kb { kb_key, .. } => kb_key.clone(),
        };
        (self.at(), id)
    }
}

/// 本機下載紀錄。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Downloaded {
    pub path: String,
    pub at: Timestamp,
}

/// 「檔案」頁的一列。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// 檔案：`FileManifest.fileId`；資料夾：`manifestRef.fileId`
    pub key: String,
    /// `file` | `folder`
    pub kind: &'static str,
    pub name: String,
    pub size: u64,
    pub mime: Option<String>,
    pub file_count: Option<u64>,
    /// 第一次分享的人（第一筆出處的作者）
    pub shared_by: Option<String>,
    pub shared_at: Timestamp,
    /// 依時間排序
    pub sources: Vec<FileSource>,
    pub downloaded: Option<Downloaded>,
    pub expires_at: Timestamp,
    /// 第一筆出處的 §14.2 Attachment（含金鑰，只給介面下載用；MCP 不回傳）
    pub attachment: serde_json::Value,
}

/// 從 §14.2 Attachment 取出合併用的 key 與顯示資訊。
struct Meta {
    key: String,
    kind: &'static str,
    name: String,
    size: u64,
    mime: Option<String>,
    file_count: Option<u64>,
}

fn meta_of(a: &serde_json::Value) -> Option<Meta> {
    let s = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_owned);
    let n = |v: &serde_json::Value, k: &str| v.get(k).and_then(serde_json::Value::as_u64);
    match a.get("type")?.as_str()? {
        "file" => {
            let m = a.get("manifest")?;
            Some(Meta {
                key: s(m, "fileId")?,
                kind: "file",
                name: s(m, "name")?,
                size: n(m, "size").unwrap_or(0),
                mime: s(m, "mime"),
                file_count: None,
            })
        }
        "folder" => Some(Meta {
            key: s(a.get("manifestRef")?, "fileId")?,
            kind: "folder",
            name: s(a, "name")?,
            size: n(a, "totalSize").unwrap_or(0),
            mime: None,
            file_count: n(a, "fileCount"),
        }),
        _ => None,
    }
}

fn attachments(v: &serde_json::Value) -> impl Iterator<Item = &serde_json::Value> {
    v.as_array().into_iter().flatten()
}

/// 訊息內文去掉常見 Markdown 符號後的前 80 字。
pub fn excerpt(body: &str) -> String {
    let plain: String = body
        .chars()
        .filter(|c| !matches!(c, '*' | '_' | '`' | '#' | '>' | '[' | ']'))
        .map(|c| if c == '\n' { ' ' } else { c })
        .collect();
    let t = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    t.chars().take(EXCERPT).collect()
}

/// 一則出處 ＋ 它附帶的 Attachment。
pub struct Found<'a> {
    pub source: FileSource,
    pub attachment: &'a serde_json::Value,
}

/// 依 key 合併；出處依時間排序，第一筆的 Attachment 與作者代表這個檔案。
pub fn build_index(
    found: Vec<Found<'_>>,
    downloads: &HashMap<String, Downloaded>,
) -> Vec<FileEntry> {
    let mut by_key: BTreeMap<String, (Meta, Vec<(FileSource, serde_json::Value)>)> =
        BTreeMap::new();
    for f in found {
        let Some(meta) = meta_of(f.attachment) else {
            continue;
        };
        by_key
            .entry(meta.key.clone())
            .or_insert_with(|| (meta, Vec::new()))
            .1
            .push((f.source, f.attachment.clone()));
    }
    let mut out: Vec<FileEntry> = by_key
        .into_values()
        .map(|(meta, mut srcs)| {
            srcs.sort_by_key(|(s, _)| s.sort_key());
            srcs.dedup_by(|a, b| a.0 == b.0);
            let first = &srcs[0];
            let shared_at = first.0.at();
            FileEntry {
                downloaded: downloads.get(&meta.key).cloned(),
                key: meta.key,
                kind: meta.kind,
                name: meta.name,
                size: meta.size,
                mime: meta.mime,
                file_count: meta.file_count,
                shared_by: first.0.author(),
                shared_at,
                expires_at: shared_at + RETENTION_MS,
                attachment: first.1.clone(),
                sources: srcs.into_iter().map(|(s, _)| s).collect(),
            }
        })
        .collect();
    out.sort_by(|a, b| b.shared_at.cmp(&a.shared_at).then(a.key.cmp(&b.key)));
    out
}

/// 對話訊息的出處（`kind = files`）。
pub fn from_messages(msgs: &[Message]) -> Vec<Found<'_>> {
    msgs.iter()
        .flat_map(|m| {
            attachments(&m.attachments).map(move |a| Found {
                source: FileSource::Message {
                    conv_id: m.conv.clone(),
                    message_id: m.id.clone(),
                    author: m.author,
                    at: m.created_at,
                    excerpt: excerpt(&m.body),
                },
                attachment: a,
            })
        })
        .collect()
}

/// 結案報告的出處。
pub fn from_reports<'a>(reports: &'a [(String, String, String, TaskReport)]) -> Vec<Found<'a>> {
    reports
        .iter()
        .flat_map(|(team, task, title, r)| {
            attachments(&r.attachments).map(move |a| Found {
                source: FileSource::TaskReport {
                    team: team.clone(),
                    task: task.clone(),
                    title: title.clone(),
                    author: r.author.map(|m| m.to_string()),
                    at: r.at,
                },
                attachment: a,
            })
        })
        .collect()
}

/// 知識庫的檔案來源。
pub fn from_kb(items: &[KbItem]) -> Vec<Found<'_>> {
    items
        .iter()
        .filter_map(|i| match &i.source {
            KbSource::File { attachment, .. } => Some(Found {
                source: FileSource::Kb {
                    kb_key: i.key.clone(),
                    title: i.title.clone(),
                    author: i.author,
                    at: i.created_at,
                },
                attachment,
            }),
            _ => None,
        })
        .collect()
}

impl Node {
    fn read_downloads(&self) -> HashMap<String, Downloaded> {
        self.inner
            .store
            .read_secret_file(DOWNLOADS)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default()
    }

    fn write_downloads(&self, d: &HashMap<String, Downloaded>) -> Result<()> {
        self.inner
            .store
            .write_secret_file(DOWNLOADS, &serde_json::to_vec(d)?)?;
        Ok(())
    }

    /// 記下下載完成的位置（只在本機；路徑由下載流程決定，不由呼叫端任意指定）。
    pub fn record_download(&self, key: &str, path: PathBuf, at: Timestamp) -> Result<()> {
        if key.is_empty() || key.len() > 64 {
            return Err(anyhow!("檔案代碼不正確"));
        }
        let mut d = self.read_downloads();
        d.insert(
            key.to_owned(),
            Downloaded {
                path: path.to_string_lossy().into_owned(),
                at,
            },
        );
        self.write_downloads(&d)
    }

    /// 下載過的位置；檔案已不在時移除紀錄並回傳 None。
    pub fn downloaded_path(&self, key: &str) -> Result<Option<PathBuf>> {
        let mut d = self.read_downloads();
        let Some(rec) = d.get(key) else {
            return Ok(None);
        };
        let p = PathBuf::from(&rec.path);
        if p.exists() {
            return Ok(Some(p));
        }
        d.remove(key);
        self.write_downloads(&d)?;
        Ok(None)
    }

    /// 「檔案」頁（§16.19）：本人看得到的所有附件。
    pub fn list_files(&self) -> Result<Vec<FileEntry>> {
        let me = self.member_id();
        let msgs: Vec<Message> = {
            let mut st = lock(&self.inner.st);
            let convs: Vec<String> = st
                .convs
                .values()
                .filter(|c| c.members.contains(&me))
                .map(|c| c.id.clone())
                .collect();
            convs
                .iter()
                .flat_map(|c| self.inner.messages_locked(&mut st, c))
                .filter(|m| m.kind == "files")
                .collect()
        };
        let mut reports = Vec::new();
        for t in self.tasks()? {
            if let Some(r) = self.task_report(&t.team, &t.id)? {
                reports.push((t.team.clone(), t.id.clone(), t.title.clone(), r));
            }
        }
        let kb = self.kb()?.items;
        let mut found = from_messages(&msgs);
        found.extend(from_reports(&reports));
        found.extend(from_kb(&kb));
        Ok(build_index(found, &self.read_downloads()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file(id: &str, name: &str) -> serde_json::Value {
        json!({ "type": "file", "manifest": { "fileId": id, "name": name, "size": 10, "mime": "application/pdf" }, "fileKey": "k" })
    }

    fn msg(id: &str, at: Timestamp, atts: serde_json::Value) -> Message {
        Message {
            id: id.into(),
            conv: "c1".into(),
            author: MemberId([1; 16]),
            created_at: at,
            kind: "files".into(),
            body: "**季報**初稿\n週五前看完".into(),
            mentions: vec![],
            attachments: atts,
            task: None,
        }
    }

    #[test]
    fn merges_same_file_and_orders_sources() {
        let a = msg("m2", 200, json!([file("F1", "a.pdf")]));
        let b = msg("m1", 100, json!([file("F1", "a.pdf"), file("F2", "b.pdf")]));
        let msgs = vec![a, b];
        let found = from_messages(&msgs);
        let idx = build_index(found, &HashMap::new());
        assert_eq!(idx.len(), 2);
        let f1 = idx.iter().find(|e| e.key == "F1").unwrap();
        assert_eq!(f1.sources.len(), 2);
        assert_eq!(f1.sources[0].at(), 100);
        assert_eq!(f1.shared_at, 100);
        assert_eq!(f1.expires_at, 100 + RETENTION_MS);
        assert_eq!(f1.attachment["fileKey"], "k");
        // 新到舊
        assert!(idx[0].shared_at >= idx[1].shared_at);
    }

    #[test]
    fn folders_and_bad_attachments() {
        let folder = json!({ "type": "folder", "name": "設計稿", "totalSize": 99, "fileCount": 3,
            "manifestRef": { "fileId": "D1", "name": "x" }, "manifestKey": "k" });
        let msgs = vec![msg("m1", 1, json!([folder, { "type": "weird" }, 5]))];
        let idx = build_index(from_messages(&msgs), &HashMap::new());
        assert_eq!(idx.len(), 1);
        assert_eq!(idx[0].kind, "folder");
        assert_eq!(idx[0].file_count, Some(3));
        assert_eq!(idx[0].size, 99);
    }

    #[test]
    fn excerpt_strips_markdown() {
        assert_eq!(excerpt("**季報**初稿\n週五前看完"), "季報初稿 週五前看完");
        assert_eq!(excerpt(&"字".repeat(200)).chars().count(), 80);
    }

    #[test]
    fn downloads_attach_to_entries() {
        let msgs = vec![msg("m1", 1, json!([file("F1", "a.pdf")]))];
        let mut d = HashMap::new();
        d.insert(
            "F1".to_owned(),
            Downloaded {
                path: "/tmp/a.pdf".into(),
                at: 5,
            },
        );
        let idx = build_index(from_messages(&msgs), &d);
        assert_eq!(idx[0].downloaded.as_ref().unwrap().path, "/tmp/a.pdf");
    }
}
