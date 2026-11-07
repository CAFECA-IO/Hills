//! 原生 App 模式的登入請求（technical-design §17.2、§17.3）。

use hills_proto::FORMAT_VERSION;
use hills_proto::cafeca::{
    APP_DOMAIN, CafecaAccount, CafecaProof, MAX_SIGNIN_TTL, SignInBinding, SignInMessage,
};
use serde::{Deserialize, Serialize};

use crate::relay::{RelayKey, RelayPoll};
use crate::{CafecaError, normalize_wallet};

const NONCE_DOMAIN: &[u8] = b"hills/v1/cafeca-signin";

/// `blake3("hills/v1/cafeca-signin" ‖ postcard(binding))`。
pub fn binding_hash(b: &SignInBinding) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(NONCE_DOMAIN);
    // postcard 對這個結構不會失敗；萬一失敗，雜湊一個不可能出現的值讓驗證失敗
    h.update(&postcard::to_allocvec(b).unwrap_or_default());
    *h.finalize().as_bytes()
}

/// 登入請求的 nonce：`base64url(binding_hash)`，43 字元。
pub fn nonce_for(b: &SignInBinding) -> String {
    data_encoding::BASE64URL_NOPAD.encode(&binding_hash(b))
}

/// 確認碼：`base32(binding_hash[0..5])`，以 `XXXX-XXXX` 顯示。
pub fn confirm_code(b: &SignInBinding) -> String {
    let c = data_encoding::BASE32_NOPAD.encode(&binding_hash(b)[..5]);
    format!("{}-{}", &c[..4], &c[4..8])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayParams<'a> {
    ch: &'a str,
    id: &'a str,
    #[serde(rename = "pub")]
    pub_key: &'a str,
}

/// CAFECA 登入請求（CAFECA README §4，`mode: "relay"`）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignInRequest<'a> {
    v: u8,
    domain: &'a str,
    uri: &'a str,
    nonce: &'a str,
    issued_at: u64,
    expires_at: u64,
    statement: &'a str,
    claims: [&'a str; 1],
    mode: &'a str,
    relay: RelayParams<'a>,
}

/// 進行中的登入：顯示 `link`（QR 與「在這台電腦開啟」）與 `code`，再以 [`Self::poll`] 等待結果。
pub struct PendingSignIn {
    pub link: String,
    pub code: String,
    pub expires_at: u64,
    binding: SignInBinding,
    nonce: String,
    wallet: String,
    key: RelayKey,
}

/// 登入結果。
#[derive(Debug)]
pub enum Outcome {
    Approved(Box<CafecaProof>),
    Denied,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireMessage {
    domain: String,
    uri: String,
    nonce: String,
    issued_at: u64,
    expires_at: u64,
    #[serde(default)]
    statement: String,
    #[serde(default)]
    claims: String,
    #[serde(default)]
    channel: String,
}

#[derive(Deserialize)]
struct WireClaims {
    handle: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireResponse {
    #[serde(rename = "type")]
    kind: Option<String>,
    error: Option<String>,
    account: Option<String>,
    chain_id: Option<u64>,
    message: Option<WireMessage>,
    signature: Option<String>,
    claims: Option<WireClaims>,
}

impl PendingSignIn {
    /// 建立登入請求。`binding.issued_at` 必須是目前的 Unix 秒。`statement` 的確認碼由這裡附加。
    pub fn new(wallet: &str, binding: SignInBinding, action: &str) -> Result<Self, CafecaError> {
        let wallet = normalize_wallet(wallet)?;
        let key = RelayKey::generate()?;
        let nonce = nonce_for(&binding);
        let code = confirm_code(&binding);
        let expires_at = binding.issued_at + MAX_SIGNIN_TTL;
        let statement = statement_for(action, &code);
        let req = SignInRequest {
            v: 1,
            domain: APP_DOMAIN,
            uri: APP_DOMAIN,
            nonce: &nonce,
            issued_at: binding.issued_at,
            expires_at,
            statement: &statement,
            claims: ["handle"],
            mode: "relay",
            relay: RelayParams {
                ch: key.channel(),
                id: key.request_id(),
                pub_key: &key.public_b64(),
            },
        };
        let json = serde_json::to_vec(&req).map_err(|_| CafecaError::BadResponse)?;
        let link = format!(
            "{wallet}/dl/auth?v=1&req={}",
            data_encoding::BASE64URL_NOPAD.encode(&json)
        );
        Ok(Self {
            link,
            code,
            expires_at,
            binding,
            nonce,
            wallet,
            key,
        })
    }

    pub fn binding(&self) -> &SignInBinding {
        &self.binding
    }

    /// 查詢一次中繼信箱。尚無回應時回傳 `Ok(None)`；過期回傳 [`CafecaError::Expired`]。
    pub async fn poll(
        &self,
        http: &reqwest::Client,
        now_secs: u64,
    ) -> Result<Option<Outcome>, CafecaError> {
        let plain = match self.key.poll(http, &self.wallet).await? {
            RelayPoll::Pending if now_secs > self.expires_at => return Err(CafecaError::Expired),
            RelayPoll::Pending => return Ok(None),
            RelayPoll::Closed => return Err(CafecaError::Expired),
            RelayPoll::Box(plain) => plain,
        };
        self.parse_response(&plain).map(Some)
    }

    /// 解析解密後的登入回應，組成登入證明（鏈上驗證另由 [`crate::Verifier`] 進行）。
    pub fn parse_response(&self, plain: &[u8]) -> Result<Outcome, CafecaError> {
        let r: WireResponse =
            serde_json::from_slice(plain).map_err(|_| CafecaError::BadResponse)?;
        if r.kind.as_deref() != Some("cafeca:auth") {
            return Err(CafecaError::BadResponse);
        }
        if r.error.is_some() {
            return Ok(Outcome::Denied);
        }
        let (Some(account), Some(chain_id), Some(m), Some(sig)) =
            (r.account, r.chain_id, r.message, r.signature)
        else {
            return Err(CafecaError::BadResponse);
        };
        let address = CafecaAccount::parse_address(&account).ok_or(CafecaError::BadResponse)?;
        let signature = sig
            .strip_prefix("0x")
            .and_then(|h| data_encoding::HEXLOWER_PERMISSIVE.decode(h.as_bytes()).ok())
            .ok_or(CafecaError::BadResponse)?;
        if m.nonce != self.nonce {
            return Err(CafecaError::Invalid("nonce 不符"));
        }
        let handle = r
            .claims
            .and_then(|c| c.handle)
            .filter(|h| h.len() <= 40 && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
        Ok(Outcome::Approved(Box::new(CafecaProof {
            v: FORMAT_VERSION,
            binding: self.binding.clone(),
            account: CafecaAccount { chain_id, address },
            message: SignInMessage {
                domain: m.domain,
                uri: m.uri,
                nonce: m.nonce,
                issued_at: m.issued_at,
                expires_at: m.expires_at,
                statement: m.statement,
                claims: m.claims,
                channel: m.channel,
            },
            signature,
            handle,
        })))
    }
}

/// 錢包授權畫面顯示的說明（CAFECA 限 200 字）。
fn statement_for(action: &str, code: &str) -> String {
    let action: String = action.chars().take(150).collect();
    format!("{action} · 確認碼 {code}")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use hills_proto::Pub32;
    use hills_proto::cafeca::SignInKind;

    pub(crate) fn binding(kind: SignInKind, issued_at: u64) -> SignInBinding {
        SignInBinding {
            v: FORMAT_VERSION,
            org_id: Pub32([1; 32]),
            kind,
            device_pub: Pub32([2; 32]),
            ik_pub: Some(Pub32([3; 32])),
            key_pub: Pub32([4; 32]),
            issued_at,
        }
    }

    #[test]
    fn nonce_and_code_bind_every_field() {
        let b = binding(SignInKind::Join, 1_800_000_000);
        let n = nonce_for(&b);
        assert_eq!(n.len(), 43);
        assert!(
            n.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
        let code = confirm_code(&b);
        assert_eq!(code.len(), 9);
        assert_eq!(&code[4..5], "-");
        let mut other = b.clone();
        other.device_pub = Pub32([9; 32]);
        assert_ne!(nonce_for(&other), n);
        let mut other = b.clone();
        other.kind = SignInKind::Recover;
        assert_ne!(nonce_for(&other), n);
        let mut other = b;
        other.issued_at += 1;
        assert_ne!(nonce_for(&other), n);
    }

    #[test]
    fn request_link_contains_relay_params() {
        let p = PendingSignIn::new(
            "https://id.example.com/",
            binding(SignInKind::Create, 1_800_000_000),
            "建立組織「範例」",
        )
        .unwrap();
        let req = p
            .link
            .strip_prefix("https://id.example.com/dl/auth?v=1&req=")
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(
            &data_encoding::BASE64URL_NOPAD
                .decode(req.as_bytes())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["domain"], APP_DOMAIN);
        assert_eq!(json["uri"], APP_DOMAIN);
        assert_eq!(json["mode"], "relay");
        assert_eq!(json["expiresAt"], 1_800_000_600);
        assert_eq!(json["nonce"], nonce_for(p.binding()));
        assert!(json["statement"].as_str().unwrap().ends_with(&p.code));
        assert_eq!(json["relay"]["ch"].as_str().unwrap().len(), 32);
        assert_eq!(json["relay"]["pub"].as_str().unwrap().len(), 87);
    }

    #[test]
    fn parse_response_checks_nonce_and_fields() {
        let p = PendingSignIn::new(
            "https://id.example.com",
            binding(SignInKind::Join, 1_800_000_000),
            "加入",
        )
        .unwrap();
        let ok = serde_json::json!({
            "v": 1, "type": "cafeca:auth",
            "account": format!("0x{}", "ab".repeat(20)), "chainId": 8018,
            "message": { "domain": APP_DOMAIN, "uri": APP_DOMAIN, "nonce": nonce_for(p.binding()),
                         "issuedAt": 1_800_000_000u64, "expiresAt": 1_800_000_600u64,
                         "statement": "s", "claims": "handle", "channel": "" },
            "signature": "0x0102", "claims": { "handle": "alice" }
        });
        match p.parse_response(ok.to_string().as_bytes()).unwrap() {
            Outcome::Approved(proof) => {
                assert_eq!(proof.account.address, [0xab; 20]);
                assert_eq!(proof.signature, vec![1, 2]);
                assert_eq!(proof.handle.as_deref(), Some("alice"));
            }
            Outcome::Denied => panic!("應為核准"),
        }
        let denied = serde_json::json!({"v":1,"type":"cafeca:auth","error":"access_denied"});
        assert!(matches!(
            p.parse_response(denied.to_string().as_bytes()).unwrap(),
            Outcome::Denied
        ));
        let mut wrong = ok.clone();
        wrong["message"]["nonce"] = "x".repeat(43).into();
        assert!(p.parse_response(wrong.to_string().as_bytes()).is_err());
        assert!(p.parse_response(b"{}").is_err());
    }
}
