//! 登入證明驗證（technical-design §17.4）。
//!
//! 1–2. 離線檢查：nonce 由綁定內容推導、domain / uri / channel、時效
//! 3.   chainId 等於錢包設定
//! 4.   `eth_call account.isValidSignature(hashTypedData, signature) == 0x1626ba7e`
//! 5.   `recovery.isPending(account) == false`
//! 6.   代稱以 `GET <錢包>/api/profile?q=<account>` 查詢，只供顯示

use std::time::{Duration, Instant};

use alloy_primitives::{Address, B256, Bytes};
use alloy_sol_types::SolCall;
use hills_proto::cafeca::{APP_DOMAIN, CafecaAccount, CafecaProof, MAX_SIGNIN_TTL};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::eip712::{MAGIC_1271, isPendingCall, isValidSignatureCall, sign_in_hash};
use crate::request::nonce_for;
use crate::{CafecaError, http_client, normalize_wallet};

const CONFIG_TTL: Duration = Duration::from_secs(3600);

/// 錢包公布的鏈與合約設定（`/.well-known/cafeca-configuration`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletConfig {
    pub chain_id: u64,
    pub rpc_url: String,
    pub recovery: Option<[u8; 20]>,
}

/// 驗證通過的身分。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub account: CafecaAccount,
    /// 由錢包查詢的代稱；查不到時為回應中自稱的代稱（只供顯示）
    pub handle: Option<String>,
}

/// 離線檢查（步驟 1–2）。`received_at` 為收到證明的 Unix 秒（mailbox 記錄或本機當下）。
pub fn check_offline(proof: &CafecaProof, received_at: u64) -> Result<(), CafecaError> {
    let m = &proof.message;
    if m.nonce != nonce_for(&proof.binding) {
        return Err(CafecaError::Invalid("nonce 與登入內容不符"));
    }
    if m.domain != APP_DOMAIN || m.uri != APP_DOMAIN {
        return Err(CafecaError::Invalid("登入對象不是 Hills"));
    }
    if !m.channel.is_empty() {
        return Err(CafecaError::Invalid("不應開啟簽章通道"));
    }
    if m.issued_at != proof.binding.issued_at
        || m.expires_at < m.issued_at
        || m.expires_at - m.issued_at > MAX_SIGNIN_TTL
    {
        return Err(CafecaError::Invalid("時間欄位不合理"));
    }
    if received_at > m.expires_at || received_at + 120 < m.issued_at {
        return Err(CafecaError::Expired);
    }
    if proof.signature.len() < 20 || proof.signature.len() > 4096 {
        return Err(CafecaError::Invalid("簽章長度不合理"));
    }
    Ok(())
}

#[derive(Deserialize)]
struct WellKnown {
    chain: WkChain,
    contracts: Option<WkContracts>,
}

#[derive(Deserialize)]
struct WkChain {
    id: u64,
    rpc: String,
}

#[derive(Deserialize)]
struct WkContracts {
    recovery: Option<String>,
}

#[derive(Deserialize)]
struct RpcResponse {
    result: Option<String>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct Profile {
    handle: Option<String>,
}

/// 以錢包設定與鏈上 RPC 驗證（mailbox 與桌機共用）。
pub struct RpcVerifier {
    wallet: String,
    rpc_override: Option<String>,
    http: reqwest::Client,
    cache: Mutex<Option<(Instant, WalletConfig)>>,
}

fn valid_handle(h: &str) -> bool {
    !h.is_empty() && h.len() <= 40 && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl RpcVerifier {
    pub fn new(wallet: &str, rpc_override: Option<String>) -> Result<Self, CafecaError> {
        let rpc_override = match rpc_override.filter(|r| !r.trim().is_empty()) {
            Some(r) => Some(normalize_wallet(&r)?),
            None => None,
        };
        Ok(Self {
            wallet: normalize_wallet(wallet)?,
            rpc_override,
            http: http_client()?,
            cache: Mutex::new(None),
        })
    }

    pub fn wallet(&self) -> &str {
        &self.wallet
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// 讀取（並快取 1 小時）錢包設定。
    pub async fn config(&self) -> Result<WalletConfig, CafecaError> {
        let mut c = self.cache.lock().await;
        if let Some((at, cfg)) = c.as_ref()
            && at.elapsed() < CONFIG_TTL
        {
            return Ok(cfg.clone());
        }
        let url = format!("{}/.well-known/cafeca-configuration", self.wallet);
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| CafecaError::Network(e.without_url().to_string()))?;
        if !resp.status().is_success() {
            return Err(CafecaError::Network(format!(
                "HTTP {}",
                resp.status().as_u16()
            )));
        }
        let wk: WellKnown = resp.json().await.map_err(|_| CafecaError::BadResponse)?;
        let recovery = wk
            .contracts
            .and_then(|c| c.recovery)
            .map(|r| CafecaAccount::parse_address(&r).ok_or(CafecaError::BadResponse))
            .transpose()?;
        let cfg = WalletConfig {
            chain_id: wk.chain.id,
            rpc_url: match &self.rpc_override {
                Some(r) => r.clone(),
                None => normalize_wallet(&wk.chain.rpc)?,
            },
            recovery,
        };
        tracing::info!(chain_id = cfg.chain_id, "已讀取 CAFECA 錢包設定");
        *c = Some((Instant::now(), cfg.clone()));
        Ok(cfg)
    }

    async fn eth_call(
        &self,
        rpc: &str,
        to: [u8; 20],
        data: Vec<u8>,
    ) -> Result<Vec<u8>, CafecaError> {
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "eth_call",
            "params": [{
                "to": format!("0x{}", data_encoding::HEXLOWER.encode(&to)),
                "data": format!("0x{}", data_encoding::HEXLOWER.encode(&data)),
            }, "latest"],
        });
        let resp = self
            .http
            .post(rpc)
            .json(&body)
            .send()
            .await
            .map_err(|e| CafecaError::Network(e.without_url().to_string()))?;
        let r: RpcResponse = resp.json().await.map_err(|_| CafecaError::BadResponse)?;
        if r.error.is_some() {
            // 呼叫失敗（例如帳戶合約不存在）視為簽章無效
            return Err(CafecaError::BadSignature);
        }
        let hex = r.result.ok_or(CafecaError::BadResponse)?;
        data_encoding::HEXLOWER_PERMISSIVE
            .decode(hex.trim_start_matches("0x").as_bytes())
            .map_err(|_| CafecaError::BadResponse)
    }

    /// 查詢代稱（失敗時回傳 None）。
    pub async fn lookup_handle(&self, account: &CafecaAccount) -> Option<String> {
        let url = format!("{}/api/profile?q={}", self.wallet, account.address_hex());
        let resp = self.http.get(url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json::<Profile>()
            .await
            .ok()?
            .handle
            .filter(|h| valid_handle(h))
    }

    /// 完整驗證（§17.4）。
    pub async fn verify(
        &self,
        proof: &CafecaProof,
        received_at: u64,
    ) -> Result<Verified, CafecaError> {
        check_offline(proof, received_at)?;
        let cfg = self.config().await?;
        if proof.account.chain_id != cfg.chain_id {
            return Err(CafecaError::Invalid("鏈 ID 不符"));
        }
        let hash = sign_in_hash(&proof.account, &proof.message);
        let call = isValidSignatureCall {
            hash: B256::from(hash),
            signature: Bytes::from(proof.signature.clone()),
        };
        let out = self
            .eth_call(&cfg.rpc_url, proof.account.address, call.abi_encode())
            .await?;
        let magic = isValidSignatureCall::abi_decode_returns(&out)
            .map_err(|_| CafecaError::BadSignature)?;
        if magic.0 != MAGIC_1271 {
            return Err(CafecaError::BadSignature);
        }
        if let Some(recovery) = cfg.recovery {
            let call = isPendingCall {
                account: Address::from(proof.account.address),
            };
            let out = self
                .eth_call(&cfg.rpc_url, recovery, call.abi_encode())
                .await?;
            let pending =
                isPendingCall::abi_decode_returns(&out).map_err(|_| CafecaError::BadResponse)?;
            if pending {
                return Err(CafecaError::RecoveryPending);
            }
        }
        let handle = match self.lookup_handle(&proof.account).await {
            Some(h) => Some(h),
            None => proof.handle.clone().filter(|h| valid_handle(h)),
        };
        Ok(Verified {
            account: proof.account,
            handle,
        })
    }
}

/// 驗證器：正式環境為 [`RpcVerifier`]；測試可啟用 `testing` feature 使用只做離線檢查的版本。
pub enum Verifier {
    Rpc(RpcVerifier),
    /// 只做離線檢查、不查鏈上（**僅供測試**）
    #[cfg(feature = "testing")]
    OfflineForTests,
}

impl Verifier {
    pub async fn verify(
        &self,
        proof: &CafecaProof,
        received_at: u64,
    ) -> Result<Verified, CafecaError> {
        match self {
            Self::Rpc(v) => v.verify(proof, received_at).await,
            #[cfg(feature = "testing")]
            Self::OfflineForTests => {
                check_offline(proof, received_at)?;
                Ok(Verified {
                    account: proof.account,
                    handle: proof.handle.clone(),
                })
            }
        }
    }

    pub async fn lookup_handle(&self, account: &CafecaAccount) -> Option<String> {
        match self {
            Self::Rpc(v) => v.lookup_handle(account).await,
            #[cfg(feature = "testing")]
            Self::OfflineForTests => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use axum::Json;
    use axum::extract::{Query, State};
    use axum::routing::{get, post};
    use hills_proto::FORMAT_VERSION;
    use hills_proto::cafeca::{SignInKind, SignInMessage};

    use super::*;
    use crate::request::tests::binding;

    #[derive(Clone)]
    struct Mock {
        valid: Arc<AtomicBool>,
        pending: Arc<AtomicBool>,
        base: String,
    }

    async fn wk(State(m): State<Mock>) -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "chain": { "id": 8018, "rpc": format!("{}/rpc", m.base) },
            "contracts": { "recovery": format!("0x{}", "77".repeat(20)) }
        }))
    }

    async fn rpc(
        State(m): State<Mock>,
        Json(req): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        let to = req["params"][0]["to"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let word = if to == format!("0x{}", "77".repeat(20)) {
            let mut w = [0u8; 32];
            w[31] = m.pending.load(Ordering::SeqCst) as u8;
            w
        } else {
            let mut w = [0u8; 32];
            if m.valid.load(Ordering::SeqCst) {
                w[..4].copy_from_slice(&MAGIC_1271);
            }
            w
        };
        Json(
            serde_json::json!({"jsonrpc":"2.0","id":1,"result": format!("0x{}", data_encoding::HEXLOWER.encode(&word))}),
        )
    }

    async fn profile(
        Query(q): Query<std::collections::HashMap<String, String>>,
    ) -> Json<serde_json::Value> {
        let handle = q.get("q").map(|_| "alice");
        Json(serde_json::json!({ "handle": handle }))
    }

    async fn serve() -> Mock {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let m = Mock {
            valid: Arc::new(AtomicBool::new(true)),
            pending: Arc::new(AtomicBool::new(false)),
            base: format!("http://127.0.0.1:{}", addr.port()),
        };
        let app = axum::Router::new()
            .route("/.well-known/cafeca-configuration", get(wk))
            .route("/rpc", post(rpc))
            .route("/api/profile", get(profile))
            .with_state(m.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.ok() });
        m
    }

    fn proof(issued_at: u64) -> CafecaProof {
        let b = binding(SignInKind::Join, issued_at);
        CafecaProof {
            v: FORMAT_VERSION,
            account: CafecaAccount {
                chain_id: 8018,
                address: [0xab; 20],
            },
            message: SignInMessage {
                domain: APP_DOMAIN.into(),
                uri: APP_DOMAIN.into(),
                nonce: nonce_for(&b),
                issued_at,
                expires_at: issued_at + 600,
                statement: "加入 · 確認碼".into(),
                claims: "handle".into(),
                channel: String::new(),
            },
            binding: b,
            signature: vec![1; 64],
            handle: Some("self_claimed".into()),
        }
    }

    #[test]
    fn offline_checks() {
        let p = proof(1_000);
        assert!(check_offline(&p, 1_100).is_ok());
        assert!(matches!(
            check_offline(&p, 1_601),
            Err(CafecaError::Expired)
        ));
        let mut bad = p.clone();
        bad.binding.device_pub.0[0] ^= 1;
        assert!(check_offline(&bad, 1_100).is_err());
        let mut bad = p.clone();
        bad.message.domain = "https://evil.example".into();
        assert!(check_offline(&bad, 1_100).is_err());
        let mut bad = p.clone();
        bad.message.channel = "x".into();
        assert!(check_offline(&bad, 1_100).is_err());
        let mut bad = p;
        bad.message.expires_at = 1_000 + 3600;
        assert!(check_offline(&bad, 1_100).is_err());
    }

    #[tokio::test]
    async fn rpc_verification() {
        let m = serve().await;
        let v = RpcVerifier::new(&m.base, None).unwrap();
        let cfg = v.config().await.unwrap();
        assert_eq!(cfg.chain_id, 8018);
        assert_eq!(cfg.recovery, Some([0x77; 20]));
        let p = proof(1_000);
        let ok = v.verify(&p, 1_100).await.unwrap();
        assert_eq!(ok.account.address, [0xab; 20]);
        assert_eq!(ok.handle.as_deref(), Some("alice"));

        m.valid.store(false, Ordering::SeqCst);
        assert!(matches!(
            v.verify(&p, 1_100).await,
            Err(CafecaError::BadSignature)
        ));
        m.valid.store(true, Ordering::SeqCst);
        m.pending.store(true, Ordering::SeqCst);
        assert!(matches!(
            v.verify(&p, 1_100).await,
            Err(CafecaError::RecoveryPending)
        ));
        m.pending.store(false, Ordering::SeqCst);
        let mut other_chain = p.clone();
        other_chain.account.chain_id = 1;
        assert!(v.verify(&other_chain, 1_100).await.is_err());
    }
}
