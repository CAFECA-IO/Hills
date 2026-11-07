//! 本機設定與機密（technical-design §16.1）。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use hills_crypto::SymmetricKey;
use hills_identity::MemberKeys;
use hills_identity::cert::DeviceKey;
use hills_identity::secret_store::{SecretStore, names};
use hills_proto::cafeca::CafecaAccount;
use hills_proto::{FORMAT_VERSION, MemberId, PeerAddr, Pub32};
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
    /// 資料格式版本（technical-design §17.9）；與目前版本不同時視為舊版資料
    #[serde(default = "legacy_format")]
    pub format: u8,
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
    /// 本人的 CAFECA 帳戶（§17）
    #[serde(default)]
    pub cafeca: Option<CafecaAccount>,
}

fn legacy_format() -> u8 {
    1
}

/// 本機資料是舊版格式（以復原詞與邀請碼建立，D41 之前），需清除後重新開始。
#[derive(Debug, thiserror::Error)]
#[error("本機資料是舊版格式，需清除後重新建立或加入組織")]
pub struct LegacyData;

impl NodeConfig {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join(CONFIG_FILE)
    }

    pub fn load(dir: &Path) -> Result<Option<Self>> {
        match std::fs::read(Self::path(dir)) {
            Ok(b) => {
                let cfg: Self = match serde_json::from_slice(&b) {
                    Ok(c) => c,
                    // 舊版設定缺欄位或欄位格式不同
                    Err(_) => return Err(LegacyData.into()),
                };
                if cfg.format != FORMAT_VERSION {
                    return Err(LegacyData.into());
                }
                Ok(Some(cfg))
            }
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
    pub keys: MemberKeys,
    pub device: DeviceKey,
    pub storage_key: SymmetricKey,
}

fn arr32(v: &[u8], what: &str) -> Result<[u8; 32]> {
    v.try_into().map_err(|_| anyhow::anyhow!("{what} 長度錯誤"))
}

impl Secrets {
    /// `member` 由 node.json 提供（成員 ID 由 CAFECA 帳戶推導，不由金鑰推導）。
    pub fn load(store: &Arc<dyn SecretStore>, member: MemberId) -> Result<Option<Self>> {
        let (Some(k), Some(d), Some(s)) = (
            store.get(names::MEMBER_KEYS)?,
            store.get(names::DEVICE_KEY)?,
            store.get(names::STORAGE_KEY)?,
        ) else {
            return Ok(None);
        };
        if k.len() != 64 {
            anyhow::bail!("成員金鑰長度錯誤");
        }
        Ok(Some(Self {
            keys: MemberKeys::from_secret_bytes(
                member,
                &arr32(&k[..32], "IK")?,
                &arr32(&k[32..], "EK")?,
            ),
            device: DeviceKey::from_secret_bytes(&arr32(&d, "device key")?),
            storage_key: SymmetricKey::from_bytes(&arr32(&s, "storage key")?),
        }))
    }

    pub fn save(&self, store: &Arc<dyn SecretStore>) -> Result<()> {
        let mut k = zeroize::Zeroizing::new(Vec::with_capacity(64));
        k.extend_from_slice(&self.keys.identity_secret_bytes()[..]);
        k.extend_from_slice(&self.keys.exchange_secret_bytes()[..]);
        store.set(names::MEMBER_KEYS, &k)?;
        store.set(names::DEVICE_KEY, &self.device.secret_bytes()[..])?;
        store.set(names::STORAGE_KEY, &self.storage_key.to_bytes()[..])?;
        Ok(())
    }

    /// 以既有的成員金鑰與裝置金鑰建立，並產生新的本機儲存金鑰。
    pub fn new(keys: MemberKeys, device: DeviceKey) -> Result<Self> {
        Ok(Self {
            keys,
            device,
            storage_key: SymmetricKey::generate()?,
        })
    }
}

/// 舊版（復原詞）在安全儲存區的項目名稱，清除時一併刪除。
const LEGACY_ENTROPY: &str = "hills.member-entropy";

/// 清除本機所有 Hills 機密（離開組織、測試）。
pub fn wipe_secrets(store: &Arc<dyn SecretStore>) -> Result<()> {
    for n in [
        names::MEMBER_KEYS,
        LEGACY_ENTROPY,
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
