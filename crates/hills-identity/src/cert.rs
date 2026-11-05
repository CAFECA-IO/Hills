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
