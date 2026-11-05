//! 本地儲存（technical-design §9）。
//!
//! - [`DocStore`]：Automerge 文件以本機儲存金鑰靜態加密存檔。
//!   - 檔名 = `hex(blake3(docId)).am`，不洩漏文件結構
//!   - 內容 = `nonce ‖ XChaCha20-Poly1305(docId ‖ Automerge 存檔)`，AAD = 檔名
//!   - 寫入：暫存檔 → fsync → rename，中斷不損壞既有檔案
//! - [`ProjectionDb`]：只存在記憶體的 SQLite 投影，啟動時由文件重建。

pub mod projection;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use automerge::AutoCommit;
use hills_crypto::{SymmetricKey, open_at_rest, seal_at_rest};
use zeroize::Zeroizing;

pub use projection::{Projection, ProjectionDb};

const EXT: &str = "am";
const MAX_DOC_ID: usize = 512;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("讀寫檔案失敗：{0}")]
    Io(#[from] std::io::Error),
    #[error("文件無法解密（金鑰錯誤或檔案損壞）")]
    Decrypt,
    #[error("文件內容與檔名不符")]
    Mismatch,
    #[error("Automerge 資料錯誤")]
    Automerge,
    #[error("文件 ID 無效")]
    BadDocId,
    #[error("投影資料庫錯誤：{0}")]
    Sql(#[from] rusqlite::Error),
}

/// 加密的 Automerge 文件庫。
pub struct DocStore {
    dir: PathBuf,
    key: SymmetricKey,
}

fn file_stem(doc_id: &str) -> String {
    data_encoding::HEXLOWER.encode(blake3::hash(doc_id.as_bytes()).as_bytes())
}

impl DocStore {
    /// 開啟（必要時建立）`dir/docs/`。
    pub fn open(dir: &Path, key: SymmetricKey) -> Result<Self, StoreError> {
        let dir = dir.join("docs");
        fs::create_dir_all(&dir)?;
        Ok(Self { dir, key })
    }

    fn path(&self, stem: &str) -> PathBuf {
        self.dir.join(format!("{stem}.{EXT}"))
    }

    pub fn save(&self, doc_id: &str, doc: &mut AutoCommit) -> Result<(), StoreError> {
        if doc_id.is_empty() || doc_id.len() > MAX_DOC_ID {
            return Err(StoreError::BadDocId);
        }
        let stem = file_stem(doc_id);
        let mut plain = Zeroizing::new(Vec::new());
        plain.extend_from_slice(&(doc_id.len() as u16).to_be_bytes());
        plain.extend_from_slice(doc_id.as_bytes());
        plain.extend_from_slice(&doc.save());
        let sealed =
            seal_at_rest(&self.key, stem.as_bytes(), &plain).map_err(|_| StoreError::Decrypt)?;
        atomic_write(&self.path(&stem), &sealed)
    }

    pub fn load(&self, doc_id: &str) -> Result<Option<AutoCommit>, StoreError> {
        let stem = file_stem(doc_id);
        match self.read(&stem)? {
            None => Ok(None),
            Some((id, doc)) if id == doc_id => Ok(Some(doc)),
            Some(_) => Err(StoreError::Mismatch),
        }
    }

    fn read(&self, stem: &str) -> Result<Option<(String, AutoCommit)>, StoreError> {
        let bytes = match fs::read(self.path(stem)) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let plain = Zeroizing::new(
            open_at_rest(&self.key, stem.as_bytes(), &bytes).map_err(|_| StoreError::Decrypt)?,
        );
        if plain.len() < 2 {
            return Err(StoreError::Decrypt);
        }
        let n = u16::from_be_bytes([plain[0], plain[1]]) as usize;
        let id = plain
            .get(2..2 + n)
            .and_then(|b| std::str::from_utf8(b).ok())
            .ok_or(StoreError::Decrypt)?
            .to_owned();
        if file_stem(&id) != stem {
            return Err(StoreError::Mismatch);
        }
        let doc = AutoCommit::load(&plain[2 + n..]).map_err(|_| StoreError::Automerge)?;
        Ok(Some((id, doc)))
    }

    /// 列出所有文件 ID（解密每個檔案取得；略過暫存檔）。
    pub fn doc_ids(&self) -> Result<Vec<String>, StoreError> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some(EXT) {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if let Some((id, _)) = self.read(stem)? {
                ids.push(id);
            }
        }
        ids.sort();
        Ok(ids)
    }

    pub fn delete(&self, doc_id: &str) -> Result<(), StoreError> {
        match fs::remove_file(self.path(&file_stem(doc_id))) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

/// 寫暫存檔 → fsync → rename（同一目錄內 rename 為原子操作）。
fn atomic_write(path: &Path, data: &[u8]) -> Result<(), StoreError> {
    let dir = path.parent().ok_or(StoreError::BadDocId)?;
    let mut rnd = [0u8; 8];
    getrandom::fill(&mut rnd).map_err(|_| std::io::Error::other("random"))?;
    let tmp = dir.join(format!(".tmp-{}", data_encoding::HEXLOWER.encode(&rnd)));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    #[cfg(unix)]
    {
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
