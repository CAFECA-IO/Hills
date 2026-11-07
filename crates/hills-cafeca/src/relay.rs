//! CAFECA 中繼信箱（`/api/channel`）與回應解密（technical-design §17.2）。
//!
//! ```text
//! K  = HKDF-SHA256(ikm = ECDH(App 私鑰, 錢包臨時公鑰 epk), salt = ch, info = "CAFECA-channel-v1")
//! pt = AES-256-GCM-Open(K, iv, ct, aad = "<ch>|<id>|res")
//! ```

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use p256::{PublicKey, SecretKey};
use serde::Deserialize;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::CafecaError;

const INFO: &[u8] = b"CAFECA-channel-v1";

/// 中繼上的密文（CAFECA `Box`）。
#[derive(Debug, Clone, Deserialize)]
pub struct RelayBox {
    pub v: u8,
    pub ch: String,
    pub id: String,
    pub iv: String,
    pub ct: String,
    pub epk: Option<String>,
}

#[derive(Deserialize)]
struct PollResponse {
    #[serde(rename = "box")]
    boxed: Option<RelayBox>,
    #[serde(default)]
    closed: bool,
}

/// 輪詢結果。
pub enum RelayPoll {
    Pending,
    Closed,
    Box(Zeroizing<Vec<u8>>),
}

/// 一次登入用的臨時 P-256 金鑰與中繼位置。私鑰只存在記憶體（`SecretKey` drop 時清除）。
pub struct RelayKey {
    secret: SecretKey,
    ch: String,
    id: String,
}

fn random_hex(n: usize) -> Result<String, CafecaError> {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).map_err(|_| CafecaError::Randomness)?;
    Ok(data_encoding::HEXLOWER.encode(&b))
}

fn b64(s: &str) -> Result<Vec<u8>, CafecaError> {
    data_encoding::BASE64URL_NOPAD
        .decode(s.trim_end_matches('=').as_bytes())
        .map_err(|_| CafecaError::Decrypt)
}

impl RelayKey {
    pub fn generate() -> Result<Self, CafecaError> {
        let secret = loop {
            let mut b = Zeroizing::new([0u8; 32]);
            getrandom::fill(b.as_mut()).map_err(|_| CafecaError::Randomness)?;
            if let Ok(k) = SecretKey::from_slice(&b[..]) {
                break k;
            }
        };
        Ok(Self {
            secret,
            ch: random_hex(16)?,
            id: random_hex(16)?,
        })
    }

    #[cfg(test)]
    pub(crate) fn from_parts(secret: &[u8; 32], ch: &str, id: &str) -> Self {
        Self {
            secret: SecretKey::from_slice(secret).expect("測試金鑰"),
            ch: ch.into(),
            id: id.into(),
        }
    }

    pub fn channel(&self) -> &str {
        &self.ch
    }

    pub fn request_id(&self) -> &str {
        &self.id
    }

    /// 未壓縮公鑰（65 bytes）的 base64url。
    pub fn public_b64(&self) -> String {
        data_encoding::BASE64URL_NOPAD.encode(&self.secret.public_key().to_sec1_bytes())
    }

    /// 解開錢包放入中繼的回應。
    pub fn open(&self, b: &RelayBox) -> Result<Zeroizing<Vec<u8>>, CafecaError> {
        if b.v != 1 || b.ch != self.ch || b.id != self.id {
            return Err(CafecaError::Decrypt);
        }
        let epk =
            PublicKey::from_sec1_bytes(&b64(b.epk.as_deref().ok_or(CafecaError::Decrypt)?)?)
                .map_err(|_| CafecaError::Decrypt)?;
        let shared = self.secret.diffie_hellman(&epk);
        let mut key = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(
            Some(self.ch.as_bytes()),
            shared.raw_secret_bytes().as_slice(),
        )
        .expand(INFO, key.as_mut())
        .map_err(|_| CafecaError::Decrypt)?;
        let cipher = Aes256Gcm::new_from_slice(&key[..]).map_err(|_| CafecaError::Decrypt)?;
        let iv = b64(&b.iv)?;
        let nonce = Nonce::try_from(iv.as_slice()).map_err(|_| CafecaError::Decrypt)?;
        let aad = format!("{}|{}|res", self.ch, self.id);
        let ct = b64(&b.ct)?;
        cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &ct,
                    aad: aad.as_bytes(),
                },
            )
            .map(Zeroizing::new)
            .map_err(|_| CafecaError::Decrypt)
    }

    /// 查詢一次中繼：`GET <wallet>/api/channel?ch=<ch>&r=<id>&res=1`。
    pub async fn poll(
        &self,
        http: &reqwest::Client,
        wallet: &str,
    ) -> Result<RelayPoll, CafecaError> {
        let url = format!("{wallet}/api/channel?ch={}&r={}&res=1", self.ch, self.id);
        let resp = http
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
        let r: PollResponse = resp.json().await.map_err(|_| CafecaError::BadResponse)?;
        match r.boxed {
            Some(b) => Ok(RelayPoll::Box(self.open(&b)?)),
            None if r.closed => Ok(RelayPoll::Closed),
            None => Ok(RelayPoll::Pending),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 由 CAFECA repo `app/scripts/native-signin-check.mts`（WebCrypto）產生的向量。
    #[test]
    fn opens_cafeca_vector() {
        let k = RelayKey::from_parts(
            &[0x11; 32],
            "0123456789abcdef0123456789abcdef",
            "fedcba9876543210fedcba9876543210",
        );
        assert_eq!(
            k.public_b64(),
            "BAIX5hfwtkQ5KCePlpmeaaI6TywVK99tbN9m5bgCgtTtGUp968uXcS0t2jyoWqh2Wlb0X8dYWZZS8ol8ZTBuV5Q"
        );
        let b = RelayBox {
            v: 1,
            ch: "0123456789abcdef0123456789abcdef".into(),
            id: "fedcba9876543210fedcba9876543210".into(),
            iv: "MzMzMzMzMzMzMzMz".into(),
            ct: "4e1M6ksPnfzDYFvdf27A4znIHNxn9SGJW1S0lSFHagfWVhM1EN_hKOQ-RBj-61boS6fcwxCMy4d6EnyELQ2DYDLbt04nAwlERmm6c-SqrtRf9MqyyvGf7-_1f9dU9OfQv4zOT5v8_4J0NnapLS_zOTlACJKTnhPfmaE".into(),
            epk: Some("BNZak5d8qj0bCBhS_1ennkZfFmBXcwS66tUF3TpIWJzzUBheiVNy32Ih6joTdVfkc_3bZ1XwW9UHw8Uz_OnJEoU".into()),
        };
        let pt = k.open(&b).unwrap();
        assert_eq!(
            std::str::from_utf8(&pt).unwrap(),
            r#"{"v":1,"type":"cafeca:auth","error":"access_denied","nonce":"q5Yk0n7m1cVbT2xG8sJfL4hW9eR3aZ6uN0pD5iO7kQc"}"#
        );
        // 換通道 / 請求 id / 竄改密文 → 失敗
        let mut other = b.clone();
        other.id = "00".repeat(16);
        assert!(k.open(&other).is_err());
        let mut tampered = b.clone();
        tampered.ct.replace_range(0..1, "5");
        assert!(k.open(&tampered).is_err());
        let mut no_epk = b;
        no_epk.epk = None;
        assert!(k.open(&no_epk).is_err());
    }

    #[test]
    fn generated_keys_are_distinct() {
        let a = RelayKey::generate().unwrap();
        let b = RelayKey::generate().unwrap();
        assert_ne!(a.public_b64(), b.public_b64());
        assert_eq!(a.channel().len(), 32);
        assert_ne!(a.channel(), b.channel());
    }
}
