//! 私密資料（IK / EK、DK、本機儲存金鑰）的存放介面（technical-design §2、§9）。
//!
//! 桌機 app 以系統 keychain 實作（macOS Keychain、Windows Credential Manager）；
//! 本 crate 只提供介面與測試用的記憶體實作。

use std::collections::HashMap;
use std::sync::Mutex;

use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
pub enum SecretStoreError {
    #[error("安全儲存區無法使用")]
    Unavailable,
}

pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretStoreError>;
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretStoreError>;
    fn delete(&self, name: &str) -> Result<(), SecretStoreError>;
}

/// 測試用：只存在記憶體，drop 時清除。
#[derive(Default)]
pub struct MemoryStore {
    items: Mutex<HashMap<String, Zeroizing<Vec<u8>>>>,
}

impl SecretStore for MemoryStore {
    fn get(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretStoreError> {
        let items = self
            .items
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)?;
        Ok(items.get(name).cloned())
    }

    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretStoreError> {
        let mut items = self
            .items
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)?;
        items.insert(name.to_owned(), Zeroizing::new(value.to_vec()));
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), SecretStoreError> {
        let mut items = self
            .items
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)?;
        items.remove(name);
        Ok(())
    }
}

/// 固定的項目名稱。
pub mod names {
    pub const DEVICE_KEY: &str = "hills.device-key";
    pub const MEMBER_KEYS: &str = "hills.member-keys-v2";
    pub const STORAGE_KEY: &str = "hills.storage-key";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrip() {
        let s = MemoryStore::default();
        assert!(s.get(names::DEVICE_KEY).unwrap().is_none());
        s.set(names::DEVICE_KEY, &[1, 2, 3]).unwrap();
        assert_eq!(&**s.get(names::DEVICE_KEY).unwrap().unwrap(), &[1, 2, 3]);
        s.delete(names::DEVICE_KEY).unwrap();
        assert!(s.get(names::DEVICE_KEY).unwrap().is_none());
    }
}
