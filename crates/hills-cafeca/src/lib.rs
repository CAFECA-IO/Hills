//! 以 CAFECA 登入（technical-design §17，D41）。
//!
//! - [`request`]：產生原生 App 模式的登入請求、nonce 與確認碼（§17.2、§17.3）
//! - [`relay`]：輪詢 CAFECA 中繼信箱並解開回應（ECDH P-256 → HKDF-SHA256 → AES-256-GCM）
//! - [`eip712`]：`SignIn` 結構雜湊（簽章本身由鏈上合約驗證）
//! - [`verify`]：登入證明驗證（離線檢查 + `isValidSignature` / `isPending` 鏈上查詢）
//!
//! 本 crate 不保存任何金鑰；登入請求的臨時 P-256 金鑰只存在記憶體，drop 時清除。
//! CAFECA repo 未附授權條款，這裡只依其公開協定實作，未複製程式碼。

use std::sync::Arc;
use std::time::Duration;

pub mod eip712;
pub mod relay;
pub mod request;
pub mod verify;

pub use request::{PendingSignIn, binding_hash, confirm_code, nonce_for};
pub use verify::{RpcVerifier, Verified, Verifier, WalletConfig};

#[derive(Debug, thiserror::Error)]
pub enum CafecaError {
    #[error("CAFECA 錢包網址無效")]
    BadWallet,
    #[error("無法連線到 CAFECA：{0}")]
    Network(String),
    #[error("CAFECA 回應格式錯誤")]
    BadResponse,
    #[error("登入請求已過期")]
    Expired,
    #[error("已在 CAFECA 拒絕登入")]
    Denied,
    #[error("無法解開 CAFECA 回應")]
    Decrypt,
    #[error("登入證明無效：{0}")]
    Invalid(&'static str),
    #[error("簽章驗證失敗")]
    BadSignature,
    #[error("CAFECA 身分正在恢復中，暫時無法使用")]
    RecoveryPending,
    #[error("無法取得系統亂數")]
    Randomness,
}

/// 共用的 HTTPS 客戶端（rustls + ring，與 iroh 相同的 TLS 堆疊；憑證以系統信任根驗證）。
pub fn http_client() -> Result<reqwest::Client, CafecaError> {
    // reqwest 以 rustls-no-provider 編譯：使用前需安裝 ring provider（已安裝時忽略）
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(8))
        .user_agent(concat!("hills/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| CafecaError::Network(e.to_string()))
}

/// 錢包網址正規化：必須是 http(s) 網址，去掉結尾的 `/`。
pub fn normalize_wallet(wallet: &str) -> Result<String, CafecaError> {
    let w = wallet.trim().trim_end_matches('/');
    let ok_scheme = w.starts_with("https://")
        || w.starts_with("http://localhost")
        || w.starts_with("http://127.0.0.1");
    if !ok_scheme || w.contains(char::is_whitespace) || w.contains('?') || w.contains('#') {
        return Err(CafecaError::BadWallet);
    }
    Ok(w.to_owned())
}

/// 讓 `Arc<RpcVerifier>` 與測試用驗證器共用同一型別。
pub type SharedVerifier = Arc<Verifier>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallet_normalization() {
        assert_eq!(
            normalize_wallet(" https://id.example.com/ ").unwrap(),
            "https://id.example.com"
        );
        assert!(normalize_wallet("http://localhost:10002").is_ok());
        assert!(normalize_wallet("http://evil.example").is_err());
        assert!(normalize_wallet("ftp://x").is_err());
        assert!(normalize_wallet("https://a b").is_err());
        assert!(normalize_wallet("https://a/?x").is_err());
    }
}
