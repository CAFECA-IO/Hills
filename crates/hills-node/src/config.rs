//! 本機設定與機密（technical-design §16.1）。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use hills_crypto::SymmetricKey;
use hills_identity::cert::DeviceKey;
use hills_identity::secret_store::{SecretStore, names};
use hills_identity::{MemberKeys, RecoveryPhrase};
use hills_proto::{MemberId, PeerAddr, Pub32};
use serde::{Deserialize, Serialize};

pub const CONFIG_FILE: &str = "node.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemberStatus {
    /// 已送出加入申請，等待管理者核准
    Pending,
    Active,
}

/// `node.json`：非機密的本機設定。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeConfig {
    pub org_root: Pub32,
    pub mailbox: PeerAddr,
    pub member_id: MemberId,
    pub device_name: String,
    pub status: MemberStatus,
    /// mailbox bundle 游標
    pub bundle_cursor: u64,
    /// mailbox 封裝金鑰游標
    pub keys_cursor: u64,
    /// 儲存節點（mailbox `Services`，technical-design §15.6 v0.12）
    #[serde(default)]
    pub storage: Vec<(u8, PeerAddr)>,
}

impl NodeConfig {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join(CONFIG_FILE)
    }

    pub fn load(dir: &Path) -> Result<Option<Self>> {
        match std::fs::read(Self::path(dir)) {
            Ok(b) => Ok(Some(
                serde_json::from_slice(&b).context("node.json 格式錯誤")?,
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join(".node.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, Self::path(dir))?;
        Ok(())
    }
}

/// 從安全儲存區讀出的機密。
pub struct Secrets {
    pub phrase: RecoveryPhrase,
    pub keys: MemberKeys,
    pub device: DeviceKey,
    pub storage_key: SymmetricKey,
}

fn arr32(v: &[u8], what: &str) -> Result<[u8; 32]> {
    v.try_into().map_err(|_| anyhow::anyhow!("{what} 長度錯誤"))
}

impl Secrets {
    pub fn load(store: &Arc<dyn SecretStore>) -> Result<Option<Self>> {
        let (Some(e), Some(d), Some(s)) = (
            store.get(names::RECOVERY_ENTROPY)?,
            store.get(names::DEVICE_KEY)?,
            store.get(names::STORAGE_KEY)?,
        ) else {
            return Ok(None);
        };
        let phrase = RecoveryPhrase::from_entropy(&arr32(&e, "entropy")?);
        Ok(Some(Self {
            keys: phrase.derive_keys(),
            phrase,
            device: DeviceKey::from_secret_bytes(&arr32(&d, "device key")?),
            storage_key: SymmetricKey::from_bytes(&arr32(&s, "storage key")?),
        }))
    }

    pub fn save(&self, store: &Arc<dyn SecretStore>) -> Result<()> {
        store.set(names::RECOVERY_ENTROPY, &self.phrase.entropy()[..])?;
        store.set(names::DEVICE_KEY, &self.device.secret_bytes()[..])?;
        store.set(names::STORAGE_KEY, &self.storage_key.to_bytes()[..])?;
        Ok(())
    }

    /// 新身分或新裝置：產生 DK 與本機儲存金鑰。
    pub fn fresh(phrase: RecoveryPhrase) -> Result<Self> {
        Ok(Self {
            keys: phrase.derive_keys(),
            phrase,
            device: DeviceKey::generate()?,
            storage_key: SymmetricKey::generate()?,
        })
    }
}

/// 清除本機所有 Hills 機密（離開組織、測試）。
pub fn wipe_secrets(store: &Arc<dyn SecretStore>) -> Result<()> {
    for n in [
        names::RECOVERY_ENTROPY,
        names::DEVICE_KEY,
        names::STORAGE_KEY,
        ORG_ROOT_SECRET,
    ] {
        store.delete(n)?;
    }
    Ok(())
}

/// 建立者裝置保存的組織根金鑰（technical-design §3.3）。
pub const ORG_ROOT_SECRET: &str = "hills.org-root-key";
