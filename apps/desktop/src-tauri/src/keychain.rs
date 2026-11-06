//! 系統 keychain 實作的 [`SecretStore`]（technical-design §2「安全儲存」、§9）：
//! macOS Keychain、Windows Credential Manager、Linux Secret Service。

use hills_node::SecretStore;
use hills_node::SecretStoreError;
use zeroize::Zeroizing;

/// keychain 中的服務名稱（與 app identifier 相同）。
pub const SERVICE: &str = "io.cafeca.hills";

pub struct Keychain {
    service: String,
}

impl Keychain {
    pub fn new() -> Self {
        Self {
            service: SERVICE.to_owned(),
        }
    }

    fn entry(&self, name: &str) -> Result<keyring::Entry, SecretStoreError> {
        keyring::Entry::new(&self.service, name).map_err(|e| {
            tracing::warn!(error = %e, "keychain 無法使用");
            SecretStoreError::Unavailable
        })
    }
}

impl SecretStore for Keychain {
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
