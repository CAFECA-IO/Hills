//! 系統 keychain 實作的 [`SecretStore`]（technical-design §2「安全儲存」、§9）：
//! macOS Keychain、Windows Credential Manager、Linux Secret Service。
//!
//! 所有機密合併存成 **一個** keychain 項目（[`BUNDLE`]），並在記憶體快取：
//! - macOS 的存取授權以「項目」為單位，原本每個機密一個項目，啟動時要逐一授權；
//!   `app_info` 等命令又會重複讀取，選「允許」（非「永遠允許」）時就會一再詢問。
//! - 合併並快取後，每次啟動最多詢問一次（選「永遠允許」後同一個建置不再詢問）。
//! - 舊版的分開項目在第一次讀取時搬進合併項目，再刪除。
//!
//! 未以固定憑證簽署的建置（`tauri dev`、CI 測試安裝檔）每次重建後簽章都不同，macOS 會把它
//! 當成另一個程式，因此每個新建置仍會詢問一次；以固定的簽署身分建置即可避免。

use std::collections::BTreeMap;
use std::sync::Mutex;

use hills_node::SecretStore;
use hills_node::SecretStoreError;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// keychain 中的服務名稱（與 app identifier 相同）。
pub const SERVICE: &str = "io.cafeca.hills";
/// 合併後的單一項目名稱。
pub const BUNDLE: &str = "hills.secrets-v1";
/// 舊版分開存放的項目（第一次讀取時搬進 [`BUNDLE`]）。
const LEGACY: &[&str] = &[
    "hills.member-keys-v2",
    "hills.device-key",
    "hills.storage-key",
    "hills.org-root-key",
];

/// 底層的單一項目讀寫（正式為系統 keychain，測試為記憶體）。
pub trait RawStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretStoreError>;
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretStoreError>;
    fn delete(&self, name: &str) -> Result<(), SecretStoreError>;
}

/// 系統 keychain。
pub struct SystemKeychain {
    service: String,
}

impl SystemKeychain {
    fn entry(&self, name: &str) -> Result<keyring::Entry, SecretStoreError> {
        keyring::Entry::new(&self.service, name).map_err(|e| {
            tracing::warn!(error = %e, "keychain 無法使用");
            SecretStoreError::Unavailable
        })
    }
}

impl RawStore for SystemKeychain {
    fn get(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretStoreError> {
        match self.entry(name)?.get_secret() {
            Ok(v) => Ok(Some(Zeroizing::new(v))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => {
                tracing::warn!(error = %e, "keychain 讀取失敗");
                Err(SecretStoreError::Unavailable)
            }
        }
    }

    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretStoreError> {
        self.entry(name)?.set_secret(value).map_err(|e| {
            tracing::warn!(error = %e, "keychain 寫入失敗");
            SecretStoreError::Unavailable
        })
    }

    fn delete(&self, name: &str) -> Result<(), SecretStoreError> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => {
                tracing::warn!(error = %e, "keychain 刪除失敗");
                Err(SecretStoreError::Unavailable)
            }
        }
    }
}

/// 合併項目的內容（值以 base64 存放）。
#[derive(Serialize, Deserialize)]
struct Bundle {
    v: u8,
    items: BTreeMap<String, String>,
}

type Items = BTreeMap<String, Zeroizing<Vec<u8>>>;

/// 以單一合併項目存放所有機密，並在記憶體快取。
pub struct BundledStore<R: RawStore> {
    raw: R,
    cache: Mutex<Option<Items>>,
}

/// 桌機使用的 keychain。
pub type Keychain = BundledStore<SystemKeychain>;

impl Keychain {
    pub fn new() -> Self {
        BundledStore::with_raw(SystemKeychain {
            service: SERVICE.to_owned(),
        })
    }
}

impl<R: RawStore> BundledStore<R> {
    pub fn with_raw(raw: R) -> Self {
        Self {
            raw,
            cache: Mutex::new(None),
        }
    }

    fn decode(bytes: &[u8]) -> Result<Items, SecretStoreError> {
        let b: Bundle = serde_json::from_slice(bytes).map_err(|_| {
            tracing::warn!("keychain 合併項目格式錯誤");
            SecretStoreError::Unavailable
        })?;
        b.items
            .into_iter()
            .map(|(k, v)| {
                data_encoding::BASE64
                    .decode(v.as_bytes())
                    .map(|d| (k, Zeroizing::new(d)))
                    .map_err(|_| SecretStoreError::Unavailable)
            })
            .collect()
    }

    fn encode(items: &Items) -> Zeroizing<Vec<u8>> {
        let b = Bundle {
            v: 1,
            items: items
                .iter()
                .map(|(k, v)| (k.clone(), data_encoding::BASE64.encode(v)))
                .collect(),
        };
        let out = Zeroizing::new(serde_json::to_vec(&b).unwrap_or_default());
        // 中間的 base64 字串也清除
        for (_, mut s) in b.items {
            zeroize::Zeroize::zeroize(&mut s);
        }
        out
    }

    /// 讀出合併項目（只在第一次存取時讀 keychain；沒有合併項目時搬移舊版分開的項目），
    /// 在鎖內執行 `f`。`f` 失敗時丟棄快取，下次重新讀取，避免快取與 keychain 不一致。
    fn with_items<T>(
        &self,
        f: impl FnOnce(&mut Items) -> Result<T, SecretStoreError>,
    ) -> Result<T, SecretStoreError> {
        let mut guard = self
            .cache
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)?;
        if guard.is_none() {
            let items = match self.raw.get(BUNDLE)? {
                Some(bytes) => Self::decode(&bytes)?,
                None => self.migrate()?,
            };
            *guard = Some(items);
        }
        let items = guard.as_mut().ok_or(SecretStoreError::Unavailable)?;
        let out = f(items);
        if out.is_err() {
            *guard = None;
        }
        out
    }

    fn migrate(&self) -> Result<Items, SecretStoreError> {
        let mut items = Items::new();
        for name in LEGACY {
            if let Some(v) = self.raw.get(name)? {
                items.insert((*name).to_owned(), v);
            }
        }
        if !items.is_empty() {
            self.raw.set(BUNDLE, &Self::encode(&items))?;
            for name in LEGACY {
                // 搬移完成後刪除舊項目；失敗只記錄，下次清除資料時會再刪
                if self.raw.delete(name).is_err() {
                    tracing::warn!("舊版 keychain 項目刪除失敗");
                }
            }
            tracing::info!(count = items.len(), "已將 keychain 項目合併");
        }
        Ok(items)
    }

    fn persist(&self, items: &Items) -> Result<(), SecretStoreError> {
        if items.is_empty() {
            self.raw.delete(BUNDLE)
        } else {
            self.raw.set(BUNDLE, &Self::encode(items))
        }
    }
}

impl<R: RawStore> SecretStore for BundledStore<R> {
    fn get(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretStoreError> {
        self.with_items(|items| Ok(items.get(name).cloned()))
    }

    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretStoreError> {
        self.with_items(|items| {
            items.insert(name.to_owned(), Zeroizing::new(value.to_vec()));
            self.persist(items)
        })
    }

    fn delete(&self, name: &str) -> Result<(), SecretStoreError> {
        self.with_items(|items| match items.remove(name) {
            Some(_) => self.persist(items),
            None => Ok(()),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// 記錄每個項目被讀取幾次的記憶體 keychain。
    #[derive(Default)]
    struct FakeRaw {
        items: Mutex<BTreeMap<String, Vec<u8>>>,
        reads: AtomicUsize,
    }

    impl RawStore for &FakeRaw {
        fn get(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretStoreError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self
                .items
                .lock()
                .unwrap()
                .get(name)
                .map(|v| Zeroizing::new(v.clone())))
        }
        fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretStoreError> {
            self.items
                .lock()
                .unwrap()
                .insert(name.to_owned(), value.to_vec());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), SecretStoreError> {
            self.items.lock().unwrap().remove(name);
            Ok(())
        }
    }

    #[test]
    fn single_item_and_cached_reads() {
        let raw = FakeRaw::default();
        let s = BundledStore::with_raw(&raw);
        s.set("hills.device-key", &[1, 2, 3]).unwrap();
        s.set("hills.storage-key", &[4]).unwrap();
        // keychain 裡只有一個項目
        assert_eq!(
            raw.items.lock().unwrap().keys().collect::<Vec<_>>(),
            vec![BUNDLE]
        );
        // 重新開啟：第一次讀取後都從快取讀
        let s = BundledStore::with_raw(&raw);
        let before = raw.reads.load(Ordering::SeqCst);
        for _ in 0..10 {
            assert_eq!(&**s.get("hills.device-key").unwrap().unwrap(), &[1, 2, 3]);
            assert!(s.get("hills.org-root-key").unwrap().is_none());
        }
        assert_eq!(raw.reads.load(Ordering::SeqCst) - before, 1);
        s.delete("hills.device-key").unwrap();
        s.delete("hills.storage-key").unwrap();
        assert!(
            raw.items.lock().unwrap().is_empty(),
            "全部刪除後移除合併項目"
        );
    }

    #[test]
    fn migrates_legacy_items() {
        let raw = FakeRaw::default();
        raw.items
            .lock()
            .unwrap()
            .insert("hills.member-keys-v2".into(), vec![7; 64]);
        raw.items
            .lock()
            .unwrap()
            .insert("hills.device-key".into(), vec![8; 32]);
        let s = BundledStore::with_raw(&raw);
        assert_eq!(&**s.get("hills.device-key").unwrap().unwrap(), &[8; 32]);
        assert_eq!(s.get("hills.member-keys-v2").unwrap().unwrap().len(), 64);
        assert_eq!(
            raw.items.lock().unwrap().keys().collect::<Vec<_>>(),
            vec![BUNDLE],
            "舊項目搬移後刪除"
        );
    }
}
