//! 成員身分與金鑰（technical-design §2、§3.1、§17）。
//!
//! ```text
//! CAFECA 帳戶（chainId + 身分合約地址）
//! 成員 ID = blake3("hills/v1/member" ‖ chainId(u64 BE) ‖ address) 前 16 bytes
//! IK（Ed25519，簽章）、EK（X25519，接收封裝金鑰）：成員第一台裝置隨機產生
//! ```
//!
//! 憑證、裝置金鑰、組織根金鑰與信任鏈見 [`cert`]、[`trust`]；私密資料存放介面見 [`secret_store`]。
//!
//! 私鑰型別在 drop 時清除記憶體，且 `Debug` 不會輸出任何私密內容
//! （development-guidelines §6）。

use std::fmt;

pub use hills_proto::MemberId;
use hills_proto::cafeca::CafecaAccount;

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret};
use zeroize::Zeroizing;

pub mod cert;
pub mod secret_store;
pub mod trust;

/// 成員 ID 推導的 domain separation 前綴。變更等同變更所有成員 ID，屬於協定變更。
const MEMBER_ID_DOMAIN: &[u8] = b"hills/v1/member";

/// 身分模組的錯誤。錯誤訊息不包含金鑰內容。
#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
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

/// 由 CAFECA 帳戶計算成員 ID（technical-design §3.1）。
pub fn member_id_for(account: &CafecaAccount) -> MemberId {
    let mut h = blake3::Hasher::new();
    h.update(MEMBER_ID_DOMAIN);
    h.update(&account.chain_id.to_be_bytes());
    h.update(&account.address);
    let mut id = [0u8; 16];
    id.copy_from_slice(&h.finalize().as_bytes()[..16]);
    MemberId(id)
}

/// 成員的身分金鑰 IK 與協商金鑰 EK，以及所屬成員 ID。私鑰在 drop 時清除。
pub struct MemberKeys {
    ik: SigningKey,
    ek: StaticSecret,
    member_id: MemberId,
}

impl MemberKeys {
    /// 以系統亂數產生新的 IK / EK（成員 ID 尚未決定，登入 CAFECA 後以 [`Self::with_member`] 設定）。
    pub fn generate() -> Result<Self, IdentityError> {
        let mut ik = Zeroizing::new([0u8; 32]);
        let mut ek = Zeroizing::new([0u8; 32]);
        getrandom::fill(ik.as_mut()).map_err(|_| IdentityError::Randomness)?;
        getrandom::fill(ek.as_mut()).map_err(|_| IdentityError::Randomness)?;
        Ok(Self::from_secret_bytes(MemberId([0; 16]), &ik, &ek))
    }

    /// 由私鑰位元組還原（安全儲存區、新裝置封裝）。
    pub fn from_secret_bytes(member_id: MemberId, ik: &[u8; 32], ek: &[u8; 32]) -> Self {
        Self {
            ik: SigningKey::from_bytes(ik),
            ek: StaticSecret::from(*ek),
            member_id,
        }
    }

    /// 設定所屬成員 ID（由 CAFECA 帳戶推導）。
    pub fn with_member(mut self, member_id: MemberId) -> Self {
        self.member_id = member_id;
        self
    }

    /// IK 私鑰位元組（寫入安全儲存區或封裝給本人新裝置時使用）。
    pub fn identity_secret_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.ik.to_bytes())
    }

    pub fn member_id(&self) -> MemberId {
        self.member_id
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

    fn account(b: u8) -> CafecaAccount {
        CafecaAccount {
            chain_id: 8018,
            address: [b; 20],
        }
    }

    /// 固定測試向量：推導方式改變等同所有成員 ID 改變。
    #[test]
    fn member_id_is_stable() {
        let id = member_id_for(&CafecaAccount {
            chain_id: 8018,
            address: [0x11; 20],
        });
        assert_eq!(
            id.to_string(),
            include_str!("../tests/vectors/member_id.txt").trim(),
            "成員 ID 測試向量不符；若是刻意變更協定，請同步更新文件與向量"
        );
    }

    #[test]
    fn member_id_depends_on_chain_and_address() {
        assert_ne!(member_id_for(&account(1)), member_id_for(&account(2)));
        let mut other_chain = account(1);
        other_chain.chain_id = 1;
        assert_ne!(member_id_for(&account(1)), member_id_for(&other_chain));
    }

    #[test]
    fn secret_bytes_roundtrip() {
        let k = MemberKeys::generate()
            .unwrap()
            .with_member(member_id_for(&account(3)));
        let r = MemberKeys::from_secret_bytes(
            k.member_id(),
            &k.identity_secret_bytes(),
            &k.exchange_secret_bytes(),
        );
        assert_eq!(r.identity_public(), k.identity_public());
        assert_eq!(r.exchange_public(), k.exchange_public());
        assert_eq!(r.member_id(), k.member_id());
    }

    #[test]
    fn debug_never_leaks_secrets() {
        let k = MemberKeys::generate().unwrap();
        let dbg = format!("{k:?}");
        assert!(dbg.contains("member_id"));
        let secret = data_encoding::HEXLOWER.encode(&k.identity_secret_bytes()[..]);
        assert!(!dbg.contains(&secret));
    }

    #[test]
    fn member_id_display_roundtrip() {
        let id = member_id_for(&account(9));
        assert_eq!(MemberId::parse(&id.to_string()).unwrap(), id);
        assert_eq!(id.to_string().len(), 26);
        assert!(MemberId::parse("not-base32!").is_err());
    }

    #[test]
    fn dh_agrees() {
        let a = MemberKeys::generate().unwrap();
        let b = MemberKeys::generate().unwrap();
        assert_eq!(
            *a.diffie_hellman(&b.exchange_public()),
            *b.diffie_hellman(&a.exchange_public())
        );
    }

    proptest! {
        #[test]
        fn sign_verify_roundtrip(msg in proptest::collection::vec(any::<u8>(), 0..256)) {
            let k = MemberKeys::generate().unwrap();
            let sig = k.sign(&msg);
            prop_assert!(verify(&k.identity_public(), &msg, &sig).is_ok());
            let mut tampered = msg.clone();
            tampered.push(1);
            prop_assert!(verify(&k.identity_public(), &tampered, &sig).is_err());
        }
    }
}

/// 測試輔助（`testing` feature）：以 IK 公鑰前 20 bytes 當作 CAFECA 帳戶地址，讓測試不需另存帳戶。
#[cfg(any(test, feature = "testing"))]
#[allow(clippy::expect_used)] // 測試輔助：亂數失敗即 panic
pub mod testing {
    use super::*;
    use crate::cert::MemberPublic;

    /// 測試用的鏈 ID。
    pub const CHAIN_ID: u64 = 8018;

    /// 由 IK 推導的測試帳戶。
    pub fn account_of(keys: &MemberKeys) -> CafecaAccount {
        let mut address = [0u8; 20];
        address.copy_from_slice(&keys.identity_public().as_bytes()[..20]);
        CafecaAccount {
            chain_id: CHAIN_ID,
            address,
        }
    }

    /// 新成員金鑰（成員 ID 由測試帳戶推導）。
    pub fn keys() -> MemberKeys {
        let k = MemberKeys::generate().expect("亂數");
        let id = member_id_for(&account_of(&k));
        k.with_member(id)
    }

    /// 簽發 MemberCert 用的公開資訊。
    pub fn public(keys: &MemberKeys) -> MemberPublic {
        MemberPublic::of(keys, account_of(keys))
    }
}
