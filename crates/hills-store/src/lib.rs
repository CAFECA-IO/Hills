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
        self.save_with(doc_id, doc, &[])
    }

    /// 保存文件與附加資料（例如每筆 change 的簽章，technical-design §16.5）。
    pub fn save_with(
        &self,
        doc_id: &str,
        doc: &mut AutoCommit,
        extra: &[u8],
    ) -> Result<(), StoreError> {
        if doc_id.is_empty() || doc_id.len() > MAX_DOC_ID {
            return Err(StoreError::BadDocId);
        }
        let stem = file_stem(doc_id);
        let mut plain = Zeroizing::new(Vec::new());
        plain.extend_from_slice(&(doc_id.len() as u16).to_be_bytes());
        plain.extend_from_slice(doc_id.as_bytes());
        plain.extend_from_slice(&(extra.len() as u32).to_be_bytes());
        plain.extend_from_slice(extra);
        plain.extend_from_slice(&doc.save());
        let sealed =
            seal_at_rest(&self.key, stem.as_bytes(), &plain).map_err(|_| StoreError::Decrypt)?;
        atomic_write(&self.path(&stem), &sealed)
    }

    pub fn load(&self, doc_id: &str) -> Result<Option<AutoCommit>, StoreError> {
        Ok(self.load_with(doc_id)?.map(|(d, _)| d))
    }

    /// 載入文件與附加資料。
    pub fn load_with(&self, doc_id: &str) -> Result<Option<(AutoCommit, Vec<u8>)>, StoreError> {
        let stem = file_stem(doc_id);
        match self.read(&stem)? {
            None => Ok(None),
            Some((id, doc, extra)) if id == doc_id => Ok(Some((doc, extra))),
            Some(_) => Err(StoreError::Mismatch),
        }
    }

    /// 以儲存金鑰加密保存任意小檔（KeyRing、TrustStore 快照），AAD = 檔名。
    pub fn write_secret_file(&self, name: &str, data: &[u8]) -> Result<(), StoreError> {
        if name.is_empty() || name.contains(['/', '\\']) {
            return Err(StoreError::BadDocId);
        }
        let aad = format!("file:{name}");
        let sealed =
            seal_at_rest(&self.key, aad.as_bytes(), data).map_err(|_| StoreError::Decrypt)?;
        atomic_write(&self.dir.join(format!("{name}.enc")), &sealed)
    }

    pub fn read_secret_file(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        let bytes = match fs::read(self.dir.join(format!("{name}.enc"))) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let aad = format!("file:{name}");
        Ok(Some(Zeroizing::new(
            open_at_rest(&self.key, aad.as_bytes(), &bytes).map_err(|_| StoreError::Decrypt)?,
        )))
    }

    fn read(&self, stem: &str) -> Result<Option<(String, AutoCommit, Vec<u8>)>, StoreError> {
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
        let rest = &plain[2 + n..];
        if rest.len() < 4 {
            return Err(StoreError::Decrypt);
        }
        let m = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
        let extra = rest.get(4..4 + m).ok_or(StoreError::Decrypt)?.to_vec();
        let doc = AutoCommit::load(&rest[4 + m..]).map_err(|_| StoreError::Automerge)?;
        Ok(Some((id, doc, extra)))
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
            if let Some((id, _, _)) = self.read(stem)? {
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
