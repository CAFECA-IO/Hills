//! 成員身分與金鑰（technical-design §2、§3.1）。
//!
//! ```text
//! 復原詞（BIP39 24 字）── 熵 32 bytes ─HKDF-SHA256─► IK（Ed25519，簽章）
//!                                            └────► EK（X25519，接收封裝金鑰）
//! 成員 ID = blake3(IK.pub) 前 16 bytes，以小寫 base32（無補齊）顯示
//! ```
//!
//! 金鑰由 BIP39 **熵** 推導，而不是由 BIP39 seed（PBKDF2）推導，因此同一組復原詞以英文或
//! 繁體中文字表顯示都對應同一個身分。
//!
//! 憑證、裝置金鑰、組織根金鑰與信任鏈見 [`cert`]、[`trust`]；私密資料存放介面見 [`secret_store`]。
//!
//! 私鑰型別在 drop 時清除記憶體，且 `Debug` 不會輸出任何私密內容
//! （development-guidelines §6）。

use std::fmt;

pub use hills_proto::MemberId;

use bip39::{Language, Mnemonic};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

pub mod cert;
pub mod secret_store;
pub mod trust;

/// 推導用的 HKDF salt。變更此值等同變更所有成員身分，屬於協定變更。
const HKDF_SALT: &[u8] = b"hills/v1/identity";
const INFO_IK: &[u8] = b"hills/v1/ik";
const INFO_EK: &[u8] = b"hills/v1/ek";

/// 復原詞字數（256-bit 熵）。
pub const WORD_COUNT: usize = 24;

/// 身分模組的錯誤。錯誤訊息不包含復原詞或金鑰內容。
#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("復原詞無效（字數、拼字或檢查碼錯誤）")]
    InvalidPhrase,
    #[error("復原詞必須是 {WORD_COUNT} 個字")]
    WrongWordCount,
    #[error("無法取得系統亂數")]
    Randomness,
    #[error("簽章驗證失敗")]
    BadSignature,
    #[error("簽署者不明或無權簽發")]
    UnauthorizedSigner,
    #[error("組織不符")]
    OrgMismatch,
    #[error("憑證內容不一致")]
    InconsistentCert,
    #[error("找不到成員")]
    UnknownMember,
    #[error("找不到裝置")]
    UnknownDevice,
    #[error("已被撤銷")]
    Revoked,
    #[error("訊息格式錯誤")]
    Proto(#[from] hills_proto::ProtoError),
}

/// 復原詞顯示語言。兩種語言對應同一個熵，因此對應同一個身分。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhraseLanguage {
    English,
    TraditionalChinese,
}

impl From<PhraseLanguage> for Language {
    fn from(l: PhraseLanguage) -> Self {
        match l {
            PhraseLanguage::English => Language::English,
            PhraseLanguage::TraditionalChinese => Language::TraditionalChinese,
        }
    }
}

/// 24 字復原詞。只保存熵，drop 時清除。
pub struct RecoveryPhrase {
    entropy: Zeroizing<[u8; 32]>,
}

impl RecoveryPhrase {
    /// 以系統亂數產生新的復原詞。
    pub fn generate() -> Result<Self, IdentityError> {
        let mut entropy = Zeroizing::new([0u8; 32]);
        getrandom::fill(entropy.as_mut()).map_err(|_| IdentityError::Randomness)?;
        Ok(Self { entropy })
    }

    /// 由使用者輸入的復原詞還原；自動辨識英文或繁體中文字表，容許多餘空白。
    pub fn parse(input: &str) -> Result<Self, IdentityError> {
        let normalized = input.split_whitespace().collect::<Vec<_>>().join(" ");
        if normalized.split(' ').count() != WORD_COUNT {
            return Err(IdentityError::WrongWordCount);
        }
        let mnemonic = [Language::English, Language::TraditionalChinese]
            .into_iter()
            .find_map(|lang| Mnemonic::parse_in_normalized(lang, &normalized).ok())
            .ok_or(IdentityError::InvalidPhrase)?;
        let mut entropy = Zeroizing::new([0u8; 32]);
        let raw = Zeroizing::new(mnemonic.to_entropy());
        if raw.len() != 32 {
            return Err(IdentityError::WrongWordCount);
        }
        entropy.copy_from_slice(&raw);
        Ok(Self { entropy })
    }

    /// 以指定語言輸出 24 個字。呼叫端顯示後應盡快丟棄。
    pub fn words(&self, lang: PhraseLanguage) -> Zeroizing<Vec<String>> {
        // 熵固定 32 bytes，from_entropy_in 只會在長度錯誤時失敗。
        let words = Mnemonic::from_entropy_in(lang.into(), self.entropy.as_ref())
            .map(|m| m.words().map(str::to_owned).collect())
            .unwrap_or_default();
        Zeroizing::new(words)
    }

    /// 推導成員金鑰。
    pub fn derive_keys(&self) -> MemberKeys {
        MemberKeys::derive(&self.entropy)
    }
}

impl fmt::Debug for RecoveryPhrase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecoveryPhrase(<redacted>)")
    }
}

/// 由 IK 公鑰計算成員 ID：blake3(IK.pub) 前 16 bytes（technical-design §3.1）。
pub fn member_id_for(ik: &VerifyingKey) -> MemberId {
    let hash = blake3::hash(ik.as_bytes());
    let mut id = [0u8; 16];
    id.copy_from_slice(&hash.as_bytes()[..16]);
    MemberId(id)
}

/// 成員的身分金鑰 IK 與協商金鑰 EK。私鑰在 drop 時清除。
pub struct MemberKeys {
    ik: SigningKey,
    ek: StaticSecret,
}

impl MemberKeys {
    fn derive(entropy: &[u8; 32]) -> Self {
        let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), entropy);
        let mut ik_bytes = Zeroizing::new([0u8; 32]);
        let mut ek_bytes = Zeroizing::new([0u8; 32]);
        // 輸出 32 bytes 遠小於 HKDF-SHA256 上限（255 × 32），expand 不會失敗。
        let _ = hk.expand(INFO_IK, ik_bytes.as_mut());
        let _ = hk.expand(INFO_EK, ek_bytes.as_mut());
        let keys = Self {
            ik: SigningKey::from_bytes(&ik_bytes),
            ek: StaticSecret::from(*ek_bytes),
        };
        ik_bytes.zeroize();
        ek_bytes.zeroize();
        keys
    }

    pub fn member_id(&self) -> MemberId {
        member_id_for(&self.ik.verifying_key())
    }

    /// IK 公鑰。
    pub fn identity_public(&self) -> VerifyingKey {
        self.ik.verifying_key()
    }

    /// EK 公鑰。
    pub fn exchange_public(&self) -> XPublicKey {
        XPublicKey::from(&self.ek)
    }

    /// 以 IK 簽章。
    pub fn sign(&self, message: &[u8]) -> Signature {
        self.ik.sign(message)
    }

    /// 以 IK 簽署協定訊息（technical-design §2 簽章輸入格式）。
    pub fn sign_body<T: hills_proto::Signable>(
        &self,
        body: T,
    ) -> Result<hills_proto::Signed<T>, IdentityError> {
        cert::sign_with(&self.ik, body)
    }

    /// EK 私鑰位元組，只供 HPKE 解封裝使用（hills-crypto）。
    pub fn exchange_secret_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.ek.to_bytes())
    }

    /// X25519 金鑰協商（供 HPKE 等上層使用）。
    pub fn diffie_hellman(&self, peer: &XPublicKey) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.ek.diffie_hellman(peer).to_bytes())
    }
}

impl fmt::Debug for MemberKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MemberKeys")
            .field("member_id", &self.member_id())
            .finish_non_exhaustive()
    }
}

/// 以 IK 公鑰驗證簽章。
pub fn verify(
    ik: &VerifyingKey,
    message: &[u8],
    signature: &Signature,
) -> Result<(), IdentityError> {
    ik.verify(message, signature)
        .map_err(|_| IdentityError::BadSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// BIP39 官方測試向量的 256-bit 全零熵。
    const VECTOR_EN: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
        abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
        abandon abandon abandon abandon abandon art";

    #[test]
    fn bip39_vector_roundtrip() {
        let p = RecoveryPhrase::parse(VECTOR_EN).unwrap();
        assert_eq!(p.entropy.as_ref(), &[0u8; 32]);
        assert_eq!(
            p.words(PhraseLanguage::English).join(" "),
            VECTOR_EN.split_whitespace().collect::<Vec<_>>().join(" ")
        );
    }

    /// 固定測試向量：任何實作變更若改變推導結果，此測試會失敗（等同所有身分改變）。
    #[test]
    fn derivation_is_stable() {
        let keys = RecoveryPhrase::parse(VECTOR_EN).unwrap().derive_keys();
        let id = keys.member_id().to_string();
        let ik = data_encoding::HEXLOWER.encode(keys.identity_public().as_bytes());
        let ek = data_encoding::HEXLOWER.encode(keys.exchange_public().as_bytes());
        insta_like(
            "member_id",
            &id,
            include_str!("../tests/vectors/member_id.txt"),
        );
        insta_like("ik_pub", &ik, include_str!("../tests/vectors/ik_pub.txt"));
        insta_like("ek_pub", &ek, include_str!("../tests/vectors/ek_pub.txt"));
    }

    fn insta_like(name: &str, got: &str, expected: &str) {
        assert_eq!(
            got,
            expected.trim(),
            "{name} 測試向量不符；若是刻意變更協定，請同步更新文件與向量"
        );
    }

    #[test]
    fn chinese_and_english_map_to_same_identity() {
        let p = RecoveryPhrase::generate().unwrap();
        let zh = p.words(PhraseLanguage::TraditionalChinese).join(" ");
        let en = p.words(PhraseLanguage::English).join(" ");
        let a = RecoveryPhrase::parse(&zh)
            .unwrap()
            .derive_keys()
            .member_id();
        let b = RecoveryPhrase::parse(&en)
            .unwrap()
            .derive_keys()
            .member_id();
        assert_eq!(a, b);
        assert_eq!(a, p.derive_keys().member_id());
    }

    #[test]
    fn rejects_bad_phrases() {
        assert!(matches!(
            RecoveryPhrase::parse("abandon abandon"),
            Err(IdentityError::WrongWordCount)
        ));
        let bad_checksum = VECTOR_EN.replace(" art", " abandon");
        assert!(matches!(
            RecoveryPhrase::parse(&bad_checksum),
            Err(IdentityError::InvalidPhrase)
        ));
        let twelve = "abandon ".repeat(11) + "about";
        assert!(matches!(
            RecoveryPhrase::parse(&twelve),
            Err(IdentityError::WrongWordCount)
        ));
    }

    #[test]
    fn tolerates_extra_whitespace() {
        let messy = format!("  {}\n", VECTOR_EN.replace(' ', "   "));
        assert!(RecoveryPhrase::parse(&messy).is_ok());
    }

    #[test]
    fn debug_never_leaks_secrets() {
        let p = RecoveryPhrase::parse(VECTOR_EN).unwrap();
        assert!(!format!("{p:?}").contains("abandon"));
        let k = p.derive_keys();
        let dbg = format!("{k:?}");
        assert!(dbg.contains("member_id"));
        assert!(!dbg.contains(&data_encoding::HEXLOWER.encode(&[0u8; 4])));
    }

    #[test]
    fn member_id_display_roundtrip() {
        let id = RecoveryPhrase::generate()
            .unwrap()
            .derive_keys()
            .member_id();
        assert_eq!(MemberId::parse(&id.to_string()).unwrap(), id);
        assert_eq!(id.to_string().len(), 26);
        assert!(MemberId::parse("not-base32!").is_err());
    }

    #[test]
    fn dh_agrees() {
        let a = RecoveryPhrase::generate().unwrap().derive_keys();
        let b = RecoveryPhrase::generate().unwrap().derive_keys();
        assert_eq!(
            *a.diffie_hellman(&b.exchange_public()),
            *b.diffie_hellman(&a.exchange_public())
        );
    }

    proptest! {
        #[test]
        fn sign_verify_roundtrip(msg in proptest::collection::vec(any::<u8>(), 0..256)) {
            let k = RecoveryPhrase::generate().unwrap().derive_keys();
            let sig = k.sign(&msg);
            prop_assert!(verify(&k.identity_public(), &msg, &sig).is_ok());
            let mut tampered = msg.clone();
            tampered.push(1);
            prop_assert!(verify(&k.identity_public(), &tampered, &sig).is_err());
        }

        #[test]
        fn distinct_entropy_distinct_ids(a in any::<[u8; 32]>(), b in any::<[u8; 32]>()) {
            prop_assume!(a != b);
            prop_assert_ne!(MemberKeys::derive(&a).member_id(), MemberKeys::derive(&b).member_id());
        }
    }
}
