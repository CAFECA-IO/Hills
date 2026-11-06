//! 裝置金鑰、組織根金鑰與憑證的簽發 / 驗證（technical-design §2、§3.1、§3.3、§3.7）。

use std::fmt;

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hills_proto::{
    DeviceCert, FORMAT_VERSION, MemberCert, OrgId, Pub32, Revocation, RevocationTarget, Role,
    Sig64, Signable, Signed, Timestamp,
};
use zeroize::Zeroizing;

use crate::{IdentityError, MemberKeys};

/// 以 Ed25519 簽署協定訊息。
pub(crate) fn sign_with<T: Signable>(
    key: &SigningKey,
    body: T,
) -> Result<Signed<T>, IdentityError> {
    let sig = key.sign(&body.signing_bytes()?);
    Ok(Signed {
        body,
        signer: Pub32(key.verifying_key().to_bytes()),
        sig: Sig64(sig.to_bytes()),
    })
}

/// 驗證 `signed.sig` 是否為 `signed.signer` 對 body 的有效簽章（只驗簽章，不驗權限）。
pub fn verify_signature<T: Signable>(signed: &Signed<T>) -> Result<(), IdentityError> {
    let vk = VerifyingKey::from_bytes(&signed.signer.0).map_err(|_| IdentityError::BadSignature)?;
    let sig = Signature::from_bytes(&signed.sig.0);
    vk.verify(&signed.body.signing_bytes()?, &sig)
        .map_err(|_| IdentityError::BadSignature)
}

fn random_signing_key() -> Result<SigningKey, IdentityError> {
    let mut seed = Zeroizing::new([0u8; 32]);
    getrandom::fill(seed.as_mut()).map_err(|_| IdentityError::Randomness)?;
    Ok(SigningKey::from_bytes(&seed))
}

/// 裝置金鑰 DK：每台裝置隨機產生，同時作為 iroh NodeId（technical-design §3.1）。
pub struct DeviceKey {
    sk: SigningKey,
}

impl DeviceKey {
    pub fn generate() -> Result<Self, IdentityError> {
        Ok(Self {
            sk: random_signing_key()?,
        })
    }

    /// 由安全儲存區讀回的 32 bytes 還原。
    pub fn from_secret_bytes(bytes: &[u8; 32]) -> Self {
        Self {
            sk: SigningKey::from_bytes(bytes),
        }
    }

    /// 供寫入安全儲存區或轉為 iroh `SecretKey`。
    pub fn secret_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.sk.to_bytes())
    }

    pub fn public(&self) -> Pub32 {
        Pub32(self.sk.verifying_key().to_bytes())
    }

    /// 以 DK 簽署（例如 SignedChange）。
    pub fn sign_body<T: Signable>(&self, body: T) -> Result<Signed<T>, IdentityError> {
        sign_with(&self.sk, body)
    }
}

impl fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DeviceKey({:?})", self.public())
    }
}

/// 組織根金鑰 OK：只用來簽發第一張管理者憑證（technical-design §3.3）。
pub struct OrgRootKey {
    sk: SigningKey,
}

impl OrgRootKey {
    pub fn generate() -> Result<Self, IdentityError> {
        Ok(Self {
            sk: random_signing_key()?,
        })
    }

    pub fn from_secret_bytes(bytes: &[u8; 32]) -> Self {
        Self {
            sk: SigningKey::from_bytes(bytes),
        }
    }

    pub fn secret_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.sk.to_bytes())
    }

    pub fn public(&self) -> Pub32 {
        Pub32(self.sk.verifying_key().to_bytes())
    }

    pub fn org_id(&self) -> OrgId {
        org_id_for(&self.public())
    }

    #[cfg(test)]
    pub(crate) fn sign_raw<T: Signable>(&self, body: T) -> Result<Signed<T>, IdentityError> {
        sign_with(&self.sk, body)
    }

    /// 簽發第一張管理者憑證。
    pub fn issue_first_admin(
        &self,
        admin: &MemberKeys,
        now: Timestamp,
    ) -> Result<Signed<MemberCert>, IdentityError> {
        sign_with(
            &self.sk,
            member_cert_body(self.org_id(), admin, vec![Role::Admin, Role::Member], now),
        )
    }
}

#[cfg(test)]
mod backup_tests {
    use super::*;

    #[test]
    fn backup_roundtrip_and_wrong_password() {
        let k = OrgRootKey::generate().unwrap();
        let b = k.export_backup_with("correct horse", 1024, 1).unwrap();
        assert_eq!(
            OrgRootKey::import_backup(&b, "correct horse")
                .unwrap()
                .public(),
            k.public()
        );
        assert!(OrgRootKey::import_backup(&b, "wrong").is_err());
        assert!(OrgRootKey::import_backup(&b[..10], "correct horse").is_err());
        // 備份檔內不含私鑰明文
        let secret = k.secret_bytes();
        assert!(!b.windows(32).any(|w| w == &secret[..]));
    }
}

impl fmt::Debug for OrgRootKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OrgRootKey({:?})", self.public())
    }
}

/// 組織 ID = blake3(OK.pub)。
pub fn org_id_for(org_root: &Pub32) -> OrgId {
    Pub32(*blake3::hash(&org_root.0).as_bytes())
}

/// 受簽者的公開資訊（簽發 MemberCert 時使用，不需要受簽者的私鑰）。
#[derive(Debug, Clone, Copy)]
pub struct MemberPublic {
    pub ik_pub: Pub32,
    pub ek_pub: Pub32,
}

impl From<&MemberKeys> for MemberPublic {
    fn from(k: &MemberKeys) -> Self {
        Self {
            ik_pub: Pub32(k.identity_public().to_bytes()),
            ek_pub: Pub32(k.exchange_public().to_bytes()),
        }
    }
}

fn member_cert_body(
    org_id: OrgId,
    subject: impl Into<MemberPublic>,
    roles: Vec<Role>,
    now: Timestamp,
) -> MemberCert {
    let p: MemberPublic = subject.into();
    let member_id = VerifyingKey::from_bytes(&p.ik_pub.0)
        .map(|vk| crate::member_id_for(&vk))
        .unwrap_or(hills_proto::MemberId([0; 16]));
    MemberCert {
        v: FORMAT_VERSION,
        org_id,
        member_id,
        ik_pub: p.ik_pub,
        ek_pub: p.ek_pub,
        roles,
        issued_at: now,
    }
}

impl MemberKeys {
    /// 簽發本人裝置的 DeviceCert（以 IK 簽署）。
    pub fn issue_device_cert(
        &self,
        device: &Pub32,
        device_name: &str,
        now: Timestamp,
    ) -> Result<Signed<DeviceCert>, IdentityError> {
        self.sign_body(DeviceCert {
            v: FORMAT_VERSION,
            member_id: self.member_id(),
            device_pub: *device,
            device_name: device_name.to_owned(),
            issued_at: now,
            expires_at: None,
        })
    }

    /// 管理者簽發其他成員的 MemberCert。是否具備管理者身分由驗證端的 TrustStore 判斷。
    pub fn issue_member_cert(
        &self,
        org_id: OrgId,
        subject: MemberPublic,
        roles: Vec<Role>,
        now: Timestamp,
    ) -> Result<Signed<MemberCert>, IdentityError> {
        if VerifyingKey::from_bytes(&subject.ik_pub.0).is_err() {
            return Err(IdentityError::InconsistentCert);
        }
        self.sign_body(member_cert_body(org_id, subject, roles, now))
    }

    /// 簽發撤銷（成員由管理者撤銷；裝置可由本人或管理者撤銷）。
    pub fn issue_revocation(
        &self,
        org_id: OrgId,
        target: RevocationTarget,
        reason: &str,
        now: Timestamp,
    ) -> Result<Signed<Revocation>, IdentityError> {
        self.sign_body(Revocation {
            v: FORMAT_VERSION,
            org_id,
            target,
            reason: reason.to_owned(),
            at: now,
        })
    }
}

/// 組織根金鑰備份檔（technical-design §3.3、§2）：Argon2id 由密碼推導金鑰，XChaCha20-Poly1305 加密。
#[derive(serde::Serialize, serde::Deserialize)]
struct OrgRootBackup {
    v: u8,
    org_root: Pub32,
    salt: [u8; 16],
    m_cost_kib: u32,
    t_cost: u32,
    #[serde(with = "serde_bytes_24")]
    nonce: [u8; 24],
    ciphertext: Vec<u8>,
}

mod serde_bytes_24 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8; 24], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(v)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 24], D::Error> {
        let v: Vec<u8> = Vec::deserialize(d)?;
        v.try_into()
            .map_err(|_| serde::de::Error::custom("nonce 長度錯誤"))
    }
}

/// Argon2id 參數：64 MiB、3 次（OWASP 建議範圍）。測試可用較低參數。
pub const BACKUP_M_COST_KIB: u32 = 64 * 1024;
pub const BACKUP_T_COST: u32 = 3;
const BACKUP_AAD: &[u8] = b"hills/v1/org-root-backup";

fn backup_key(
    password: &str,
    salt: &[u8; 16],
    m: u32,
    t: u32,
) -> Result<Zeroizing<[u8; 32]>, IdentityError> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(m, t, 1, Some(32)).map_err(|_| IdentityError::InconsistentCert)?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|_| IdentityError::InconsistentCert)?;
    Ok(out)
}

impl OrgRootKey {
    /// 匯出以密碼加密的備份檔內容。
    pub fn export_backup(&self, password: &str) -> Result<Vec<u8>, IdentityError> {
        self.export_backup_with(password, BACKUP_M_COST_KIB, BACKUP_T_COST)
    }

    pub fn export_backup_with(
        &self,
        password: &str,
        m_cost_kib: u32,
        t_cost: u32,
    ) -> Result<Vec<u8>, IdentityError> {
        use chacha20poly1305::{
            XChaCha20Poly1305, XNonce,
            aead::{Aead, KeyInit, Payload},
        };
        let mut salt = [0u8; 16];
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut salt).map_err(|_| IdentityError::Randomness)?;
        getrandom::fill(&mut nonce).map_err(|_| IdentityError::Randomness)?;
        let key = backup_key(password, &salt, m_cost_kib, t_cost)?;
        let secret = self.secret_bytes();
        let ciphertext = XChaCha20Poly1305::new((&*key).into())
            .encrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: &secret[..],
                    aad: BACKUP_AAD,
                },
            )
            .map_err(|_| IdentityError::InconsistentCert)?;
        let b = OrgRootBackup {
            v: FORMAT_VERSION,
            org_root: self.public(),
            salt,
            m_cost_kib,
            t_cost,
            nonce,
            ciphertext,
        };
        postcard::to_allocvec(&b).map_err(|_| IdentityError::Proto(hills_proto::ProtoError::Encode))
    }

    /// 由備份檔與密碼還原；密碼錯誤或檔案損壞時失敗。
    pub fn import_backup(bytes: &[u8], password: &str) -> Result<Self, IdentityError> {
        use chacha20poly1305::{
            XChaCha20Poly1305, XNonce,
            aead::{Aead, KeyInit, Payload},
        };
        let b: OrgRootBackup = postcard::from_bytes(bytes)
            .map_err(|_| IdentityError::Proto(hills_proto::ProtoError::Decode))?;
        hills_proto::check_version(b.v)?;
        if b.m_cost_kib > 1024 * 1024 || b.t_cost > 100 {
            return Err(IdentityError::InconsistentCert);
        }
        let key = backup_key(password, &b.salt, b.m_cost_kib, b.t_cost)?;
        let plain = Zeroizing::new(
            XChaCha20Poly1305::new((&*key).into())
                .decrypt(
                    &XNonce::from(b.nonce),
                    Payload {
                        msg: &b.ciphertext,
                        aad: BACKUP_AAD,
                    },
                )
                .map_err(|_| IdentityError::BadSignature)?,
        );
        let arr: [u8; 32] = plain
            .as_slice()
            .try_into()
            .map_err(|_| IdentityError::InconsistentCert)?;
        let k = Self::from_secret_bytes(&arr);
        if k.public() != b.org_root {
            return Err(IdentityError::InconsistentCert);
        }
        Ok(k)
    }
}
