//! 加密的本機索引與檢索（technical-design §16.20「儲存與檢索」）。
//!
//! 實際的加密存取由呼叫端提供（[`Vault`]，桌機 app 用 hills-store 的本機加密檔）。

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::chunk::Chunk;
use crate::{DocAiError, Result};

/// 加密檔的讀寫（以名稱區分，名稱不含路徑分隔）。
pub trait Vault {
    fn read(&self, name: &str) -> Result<Option<Vec<u8>>>;
    fn write(&self, name: &str, data: &[u8]) -> Result<()>;
    fn remove(&self, name: &str) -> Result<()>;
}

const MANIFEST: &str = "docai-index";
const FORMAT: u8 = 1;
const PER_FILE: usize = 3;
const SNIPPET: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Ready,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    pub name: String,
    pub chunks: u32,
    pub at: u64,
    pub status: FileStatus,
    /// 失敗或略過的原因
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Manifest {
    format: u8,
    model: String,
    dim: u32,
    files: BTreeMap<String, FileState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredChunk {
    chunk: Chunk,
    vec: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredFile {
    key: String,
    model: String,
    chunks: Vec<StoredChunk>,
}

/// 檢索結果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub file_key: String,
    pub name: String,
    pub page_from: u32,
    pub page_to: u32,
    pub heading: Vec<String>,
    pub snippet: String,
    pub score: f32,
}

pub struct Index {
    manifest: Manifest,
    chunks: HashMap<String, Vec<StoredChunk>>,
    /// 清單檔名與每個出處的加密檔名前綴（PDF：`docai-index` / `docai-`；知識：`docai-kb` / `docai-kb-`）
    names: (&'static str, &'static str),
}

/// 知識條目索引的清單檔名與前綴（technical-design §16.20「知識條目」，D70）。
pub const KB_NAMES: (&str, &str) = ("docai-kb", "docai-kb-");
const PDF_NAMES: (&str, &str) = (MANIFEST, "docai-");

/// 檔案代碼 → 加密檔名。
pub fn file_name(key: &str) -> String {
    file_name_with(PDF_NAMES.1, key)
}

fn file_name_with(prefix: &str, key: &str) -> String {
    let h = data_encoding::HEXLOWER.encode(blake3::hash(key.as_bytes()).as_bytes());
    format!("{prefix}{}", &h[..16])
}

/// 一段已向量化的內容（混合檢索用）。
pub struct Passage<'a> {
    pub key: &'a str,
    pub name: &'a str,
    pub chunk: &'a Chunk,
    pub vec: &'a [f32],
}

fn ser<T: Serialize>(v: &T) -> Result<Vec<u8>> {
    postcard::to_allocvec(v).map_err(|e| DocAiError::Store(e.to_string()))
}

fn de<T: for<'a> Deserialize<'a>>(b: &[u8]) -> Result<T> {
    postcard::from_bytes(b).map_err(|e| DocAiError::Store(e.to_string()))
}

impl Index {
    /// 讀取索引；模型不同（或格式不符）時清除全部，之後重建。
    pub fn open(vault: &dyn Vault, model: &str, dim: usize) -> Result<Self> {
        Self::open_named(vault, PDF_NAMES, model, dim)
    }

    /// 以指定的清單檔名與前綴開啟（知識條目用 [`KB_NAMES`]）。
    pub fn open_named(
        vault: &dyn Vault,
        names: (&'static str, &'static str),
        model: &str,
        dim: usize,
    ) -> Result<Self> {
        let dim32 = u32::try_from(dim).map_err(|_| DocAiError::Store("維度錯誤".into()))?;
        let fresh = Manifest {
            format: FORMAT,
            model: model.to_owned(),
            dim: dim32,
            files: BTreeMap::new(),
        };
        let old = vault.read(names.0)?.and_then(|b| de::<Manifest>(&b).ok());
        let mut idx = Self {
            manifest: fresh.clone(),
            chunks: HashMap::new(),
            names,
        };
        match old {
            Some(m) if m.format == FORMAT && m.model == model && m.dim == dim32 => {
                idx.manifest = m;
                let keys: Vec<String> = idx.manifest.files.keys().cloned().collect();
                for key in keys {
                    let ready =
                        idx.manifest.files.get(&key).map(|f| f.status) == Some(FileStatus::Ready);
                    if !ready {
                        continue;
                    }
                    match vault
                        .read(&idx.fname(&key))?
                        .and_then(|b| de::<StoredFile>(&b).ok())
                    {
                        Some(f) if f.key == key && f.model == model => {
                            idx.chunks.insert(key, f.chunks);
                        }
                        _ => {
                            // 檔案遺失或損壞：從清單移除，排程會重建
                            idx.manifest.files.remove(&key);
                        }
                    }
                }
            }
            Some(m) => {
                for key in m.files.keys() {
                    vault.remove(&idx.fname(key))?;
                }
                vault.write(names.0, &ser(&idx.manifest)?)?;
            }
            None => {}
        }
        Ok(idx)
    }

    pub fn model(&self) -> &str {
        &self.manifest.model
    }

    fn fname(&self, key: &str) -> String {
        file_name_with(self.names.1, key)
    }

    /// 所有已向量化的段落。
    pub fn passages(&self) -> impl Iterator<Item = Passage<'_>> {
        self.chunks.iter().flat_map(move |(key, chunks)| {
            let name = self.manifest.files.get(key).map_or("", |f| f.name.as_str());
            chunks.iter().map(move |c| Passage {
                key: key.as_str(),
                name,
                chunk: &c.chunk,
                vec: &c.vec,
            })
        })
    }

    pub fn files(&self) -> &BTreeMap<String, FileState> {
        &self.manifest.files
    }

    pub fn total_chunks(&self) -> usize {
        self.chunks.values().map(Vec::len).sum()
    }

    fn save_manifest(&self, vault: &dyn Vault) -> Result<()> {
        vault.write(self.names.0, &ser(&self.manifest)?)
    }

    /// 寫入一個檔案的段落與向量（取代舊的）。
    pub fn put(
        &mut self,
        vault: &dyn Vault,
        key: &str,
        name: &str,
        chunks: Vec<Chunk>,
        vecs: Vec<Vec<f32>>,
        at: u64,
    ) -> Result<u32> {
        let dim = self.manifest.dim as usize;
        if chunks.len() != vecs.len() || vecs.iter().any(|v| v.len() != dim) {
            return Err(DocAiError::Store("向量數量或維度不符".into()));
        }
        let stored: Vec<StoredChunk> = chunks
            .into_iter()
            .zip(vecs)
            .map(|(chunk, vec)| StoredChunk { chunk, vec })
            .collect();
        let n = u32::try_from(stored.len()).unwrap_or(u32::MAX);
        let file = StoredFile {
            key: key.to_owned(),
            model: self.manifest.model.clone(),
            chunks: stored,
        };
        vault.write(&self.fname(key), &ser(&file)?)?;
        self.chunks.insert(key.to_owned(), file.chunks);
        self.manifest.files.insert(
            key.to_owned(),
            FileState {
                name: name.to_owned(),
                chunks: n,
                at,
                status: FileStatus::Ready,
                reason: None,
            },
        );
        self.save_manifest(vault)?;
        Ok(n)
    }

    /// 記下失敗或略過（不重試，直到使用者按「再試一次」或重建）。
    pub fn mark(
        &mut self,
        vault: &dyn Vault,
        key: &str,
        name: &str,
        status: FileStatus,
        reason: &str,
        at: u64,
    ) -> Result<()> {
        if self.chunks.remove(key).is_some() {
            vault.remove(&self.fname(key))?;
        }
        self.manifest.files.insert(
            key.to_owned(),
            FileState {
                name: name.to_owned(),
                chunks: 0,
                at,
                status,
                reason: Some(reason.to_owned()),
            },
        );
        self.save_manifest(vault)
    }

    pub fn forget(&mut self, vault: &dyn Vault, key: &str) -> Result<()> {
        if self.manifest.files.remove(key).is_none() {
            return Ok(());
        }
        self.chunks.remove(key);
        vault.remove(&self.fname(key))?;
        self.save_manifest(vault)
    }

    pub fn clear(&mut self, vault: &dyn Vault) -> Result<()> {
        for key in self.manifest.files.keys() {
            vault.remove(&self.fname(key))?;
        }
        self.manifest.files.clear();
        self.chunks.clear();
        self.save_manifest(vault)
    }

    /// 內積（向量皆已正規化 = cosine）前 `limit` 名；同一檔案最多 3 段。
    pub fn search(&self, query: &[f32], limit: usize) -> Vec<Hit> {
        let mut scored: Vec<(f32, &str, &StoredChunk)> = Vec::new();
        for (key, chunks) in &self.chunks {
            for c in chunks {
                if c.vec.len() != query.len() {
                    continue;
                }
                let s: f32 = c.vec.iter().zip(query).map(|(a, b)| a * b).sum();
                scored.push((s, key.as_str(), c));
            }
        }
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut per: HashMap<&str, usize> = HashMap::new();
        let mut out = Vec::new();
        for (score, key, c) in scored {
            let n = per.entry(key).or_insert(0);
            if *n >= PER_FILE {
                continue;
            }
            *n += 1;
            out.push(Hit {
                file_key: key.to_owned(),
                name: self
                    .manifest
                    .files
                    .get(key)
                    .map(|f| f.name.clone())
                    .unwrap_or_default(),
                page_from: c.chunk.page_from,
                page_to: c.chunk.page_to,
                heading: c.chunk.heading.clone(),
                snippet: c.chunk.text.chars().take(SNIPPET).collect(),
                score,
            });
            if out.len() >= limit {
                break;
            }
        }
        out
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::embed::{Embedder, FakeEmbedder};

    #[derive(Default)]
    pub struct MemVault(pub RefCell<HashMap<String, Vec<u8>>>);

    impl Vault for MemVault {
        fn read(&self, name: &str) -> Result<Option<Vec<u8>>> {
            Ok(self.0.borrow().get(name).cloned())
        }
        fn write(&self, name: &str, data: &[u8]) -> Result<()> {
            self.0.borrow_mut().insert(name.into(), data.to_vec());
            Ok(())
        }
        fn remove(&self, name: &str) -> Result<()> {
            self.0.borrow_mut().remove(name);
            Ok(())
        }
    }

    fn chunk(text: &str, page: u32) -> Chunk {
        Chunk {
            page_from: page,
            page_to: page,
            heading: vec!["H".into()],
            text: text.into(),
        }
    }

    fn put(idx: &mut Index, v: &MemVault, e: &mut FakeEmbedder, key: &str, texts: &[&str]) {
        let chunks: Vec<Chunk> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| chunk(t, i as u32 + 1))
            .collect();
        let vecs = e
            .embed_passages(&chunks.iter().map(|c| c.text.clone()).collect::<Vec<_>>())
            .unwrap();
        idx.put(v, key, &format!("{key}.pdf"), chunks, vecs, 1)
            .unwrap();
    }

    #[test]
    fn stores_searches_and_reloads() {
        let v = MemVault::default();
        let mut e = FakeEmbedder::default();
        let mut idx = Index::open(&v, "fake", e.dim).unwrap();
        put(
            &mut idx,
            &v,
            &mut e,
            "a",
            &["請假申請需由組長核准", "午餐在一樓"],
        );
        put(&mut idx, &v, &mut e, "b", &["伺服器部署與憑證更新"]);
        let q = e.embed_query("請假核准").unwrap();
        let hits = idx.search(&q, 5);
        assert_eq!(hits[0].file_key, "a");
        assert_eq!(hits[0].page_from, 1);
        assert_eq!(hits[0].name, "a.pdf");

        // 存的是 Vault 裡的內容，重新開啟後一樣找得到
        let idx2 = Index::open(&v, "fake", e.dim).unwrap();
        assert_eq!(idx2.total_chunks(), 3);
        assert_eq!(idx2.search(&q, 1)[0].file_key, "a");
    }

    #[test]
    fn caps_hits_per_file() {
        let v = MemVault::default();
        let mut e = FakeEmbedder::default();
        let mut idx = Index::open(&v, "fake", e.dim).unwrap();
        put(
            &mut idx,
            &v,
            &mut e,
            "a",
            &["假單", "假單一", "假單二", "假單三", "假單四"],
        );
        put(&mut idx, &v, &mut e, "b", &["假單五"]);
        let hits = idx.search(&e.embed_query("假單").unwrap(), 10);
        assert_eq!(hits.iter().filter(|h| h.file_key == "a").count(), 3);
        assert!(hits.iter().any(|h| h.file_key == "b"));
    }

    #[test]
    fn model_change_clears_everything() {
        let v = MemVault::default();
        let mut e = FakeEmbedder::default();
        let mut idx = Index::open(&v, "fake", e.dim).unwrap();
        put(&mut idx, &v, &mut e, "a", &["內容"]);
        assert!(v.0.borrow().contains_key(&file_name("a")));
        let idx2 = Index::open(&v, "other", 128).unwrap();
        assert!(idx2.files().is_empty());
        assert!(!v.0.borrow().contains_key(&file_name("a")));
    }

    #[test]
    fn mark_forget_and_validate() {
        let v = MemVault::default();
        let mut e = FakeEmbedder::default();
        let mut idx = Index::open(&v, "fake", e.dim).unwrap();
        put(&mut idx, &v, &mut e, "a", &["內容"]);
        idx.mark(&v, "a", "a.pdf", FileStatus::Failed, "壞了", 2)
            .unwrap();
        assert_eq!(idx.total_chunks(), 0);
        assert_eq!(idx.files()["a"].status, FileStatus::Failed);
        idx.forget(&v, "a").unwrap();
        assert!(idx.files().is_empty());
        let bad = idx.put(&v, "x", "x", vec![chunk("t", 1)], vec![vec![0.0; 3]], 1);
        assert!(bad.is_err());
    }
}
