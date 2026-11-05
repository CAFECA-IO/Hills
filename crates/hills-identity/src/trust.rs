//! 信任鏈驗證（technical-design §3.2）。
//!
//! 1. `DeviceCert` 由某成員 IK 簽發，且裝置未被撤銷
//! 2. 該成員的 `MemberCert` 由有效管理者簽發，且成員未被停用
//! 3. 管理者的有效性可追溯至 OK 簽發的第一張管理者憑證
//! 4. 操作權限（角色）由呼叫端依 [`Verified::roles`] 判斷
//!
//! 語意：憑證在**簽發當時**簽發者有效即可。之後撤銷某位管理者，不會讓他先前加入的成員失效；
//! 若要移除那些成員，需各自撤銷。

use std::collections::{HashMap, HashSet};

use ed25519_dalek::VerifyingKey;
use hills_proto::{
    DeviceCert, MemberCert, MemberId, OrgId, Pub32, Revocation, RevocationTarget, Role, Roster,
    Signable, Signed,
};

use crate::{IdentityError, cert::org_id_for, cert::verify_signature, member_id_for};

/// 驗證通過的裝置與其成員。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub member_id: MemberId,
    pub device: Pub32,
    pub roles: Vec<Role>,
}

impl Verified {
    pub fn is_admin(&self) -> bool {
        self.roles.contains(&Role::Admin)
    }
}

/// 組織的信任狀態：OK.pub、成員憑證、裝置憑證、撤銷清單。
#[derive(Debug, Clone)]
pub struct TrustStore {
    org_root: Pub32,
    org_id: OrgId,
    members: HashMap<MemberId, Signed<MemberCert>>,
    by_ik: HashMap<Pub32, MemberId>,
    devices: HashMap<Pub32, Signed<DeviceCert>>,
    revoked_members: HashSet<MemberId>,
    revoked_devices: HashSet<Pub32>,
}

impl TrustStore {
    pub fn new(org_root: Pub32) -> Self {
        Self {
            org_root,
            org_id: org_id_for(&org_root),
            members: HashMap::new(),
            by_ik: HashMap::new(),
            devices: HashMap::new(),
            revoked_members: HashSet::new(),
            revoked_devices: HashSet::new(),
        }
    }

    pub fn org_id(&self) -> OrgId {
        self.org_id
    }

    pub fn org_root(&self) -> Pub32 {
        self.org_root
    }

    fn active_admin_by_ik(&self, ik: &Pub32) -> bool {
        self.by_ik
            .get(ik)
            .and_then(|m| self.members.get(m))
            .is_some_and(|c| c.body.is_admin() && !self.revoked_members.contains(&c.body.member_id))
    }

    /// 加入一張成員憑證：簽署者必須是 OK（僅限管理者憑證）或有效管理者。
    pub fn add_member_cert(&mut self, cert: Signed<MemberCert>) -> Result<(), IdentityError> {
        let b = &cert.body;
        hills_proto::check_version(b.v)?;
        if b.org_id != self.org_id {
            return Err(IdentityError::OrgMismatch);
        }
        let ik =
            VerifyingKey::from_bytes(&b.ik_pub.0).map_err(|_| IdentityError::InconsistentCert)?;
        if member_id_for(&ik) != b.member_id {
            return Err(IdentityError::InconsistentCert);
        }
        verify_signature(&cert)?;
        let by_root = cert.signer == self.org_root && b.is_admin();
        if !by_root && !self.active_admin_by_ik(&cert.signer) {
            return Err(IdentityError::UnauthorizedSigner);
        }
        self.by_ik.insert(b.ik_pub, b.member_id);
        self.members.insert(b.member_id, cert);
        Ok(())
    }

    /// 加入裝置憑證：必須由該成員本人的 IK 簽署，且成員有效。
    pub fn add_device_cert(&mut self, cert: Signed<DeviceCert>) -> Result<(), IdentityError> {
        hills_proto::check_version(cert.body.v)?;
        verify_signature(&cert)?;
        let member = self
            .members
            .get(&cert.body.member_id)
            .ok_or(IdentityError::UnknownMember)?;
        if member.body.ik_pub != cert.signer {
            return Err(IdentityError::UnauthorizedSigner);
        }
        if self.revoked_members.contains(&cert.body.member_id) {
            return Err(IdentityError::Revoked);
        }
        self.devices.insert(cert.body.device_pub, cert);
        Ok(())
    }

    /// 套用撤銷：成員只能由管理者撤銷；裝置可由本人或管理者撤銷。
    pub fn add_revocation(&mut self, rev: &Signed<Revocation>) -> Result<(), IdentityError> {
        hills_proto::check_version(rev.body.v)?;
        if rev.body.org_id != self.org_id {
            return Err(IdentityError::OrgMismatch);
        }
        verify_signature(rev)?;
        let admin = self.active_admin_by_ik(&rev.signer);
        match &rev.body.target {
            RevocationTarget::Member(m) => {
                if !admin {
                    return Err(IdentityError::UnauthorizedSigner);
                }
                self.revoked_members.insert(*m);
            }
            RevocationTarget::Device(d) => {
                let owner_ik = self
                    .devices
                    .get(d)
                    .and_then(|c| self.members.get(&c.body.member_id))
                    .map(|m| m.body.ik_pub);
                if !admin && owner_ik != Some(rev.signer) {
                    return Err(IdentityError::UnauthorizedSigner);
                }
                self.revoked_devices.insert(*d);
            }
        }
        Ok(())
    }

    /// 匯入 roster：憑證順序不限（反覆嘗試直到沒有新的可加入），撤銷最後套用。
    /// 回傳無法加入的憑證數。
    pub fn import_roster(&mut self, roster: &Roster) -> Result<usize, IdentityError> {
        if roster.org_id != self.org_id {
            return Err(IdentityError::OrgMismatch);
        }
        let mut pending: Vec<_> = roster.member_certs.clone();
        loop {
            let before = pending.len();
            pending.retain(|c| self.add_member_cert(c.clone()).is_err());
            if pending.is_empty() || pending.len() == before {
                break;
            }
        }
        for r in &roster.revocations {
            self.add_revocation(r)?;
        }
        Ok(pending.len())
    }

    /// 匯出目前的 roster 內容（供推送給 mailbox）。
    pub fn member_certs(&self) -> Vec<Signed<MemberCert>> {
        self.members.values().cloned().collect()
    }

    pub fn member(&self, id: &MemberId) -> Option<&MemberCert> {
        self.members.get(id).map(|c| &c.body)
    }

    pub fn is_active_member(&self, id: &MemberId) -> bool {
        self.members.contains_key(id) && !self.revoked_members.contains(id)
    }

    /// 驗證裝置（§3.2 步驟 1–3）。
    pub fn verify_device(&self, device: &Pub32) -> Result<Verified, IdentityError> {
        if self.revoked_devices.contains(device) {
            return Err(IdentityError::Revoked);
        }
        let cert = self
            .devices
            .get(device)
            .ok_or(IdentityError::UnknownDevice)?;
        let member_id = cert.body.member_id;
        if self.revoked_members.contains(&member_id) {
            return Err(IdentityError::Revoked);
        }
        let member = self
            .members
            .get(&member_id)
            .ok_or(IdentityError::UnknownMember)?;
        Ok(Verified {
            member_id,
            device: *device,
            roles: member.body.roles.clone(),
        })
    }

    /// 驗證由裝置簽署的訊息：簽章有效且簽署裝置通過信任鏈。
    pub fn verify_device_signed<T: Signable>(
        &self,
        signed: &Signed<T>,
    ) -> Result<Verified, IdentityError> {
        verify_signature(signed)?;
        self.verify_device(&signed.signer)
    }

    /// 驗證一組 Hello 憑證（mailbox 用）：兩張憑證本身有效、一致，且裝置是連線的 NodeId。
    pub fn verify_hello(
        &self,
        device_cert: &Signed<DeviceCert>,
        member_cert: &Signed<MemberCert>,
        connection_node: &Pub32,
    ) -> Result<Verified, IdentityError> {
        if device_cert.body.device_pub != *connection_node
            || device_cert.body.member_id != member_cert.body.member_id
        {
            return Err(IdentityError::InconsistentCert);
        }
        let known = self
            .members
            .get(&member_cert.body.member_id)
            .ok_or(IdentityError::UnknownMember)?;
        if known.body != member_cert.body {
            return Err(IdentityError::InconsistentCert);
        }
        let mut scratch = self.clone();
        scratch.add_device_cert(device_cert.clone())?;
        scratch.verify_device(connection_node)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cert::{DeviceKey, MemberPublic, OrgRootKey};
    use crate::{MemberKeys, RecoveryPhrase};
    use hills_proto::FORMAT_VERSION;

    struct Org {
        ok: OrgRootKey,
        trust: TrustStore,
        admin: MemberKeys,
    }

    fn keys() -> MemberKeys {
        RecoveryPhrase::generate().unwrap().derive_keys()
    }

    fn org() -> Org {
        let ok = OrgRootKey::generate().unwrap();
        let admin = keys();
        let mut trust = TrustStore::new(ok.public());
        trust
            .add_member_cert(ok.issue_first_admin(&admin, 1).unwrap())
            .unwrap();
        Org { ok, trust, admin }
    }

    fn add_member(o: &mut Org, roles: Vec<Role>) -> MemberKeys {
        let m = keys();
        let cert = o
            .admin
            .issue_member_cert(o.trust.org_id(), MemberPublic::from(&m), roles, 2)
            .unwrap();
        o.trust.add_member_cert(cert).unwrap();
        m
    }

    fn add_device(o: &mut Org, m: &MemberKeys) -> DeviceKey {
        let d = DeviceKey::generate().unwrap();
        o.trust
            .add_device_cert(m.issue_device_cert(&d.public(), "laptop", 3).unwrap())
            .unwrap();
        d
    }

    #[test]
    fn full_chain_verifies() {
        let mut o = org();
        let m = add_member(&mut o, vec![Role::Member]);
        let d = add_device(&mut o, &m);
        let v = o.trust.verify_device(&d.public()).unwrap();
        assert_eq!(v.member_id, m.member_id());
        assert!(!v.is_admin());
        let admin_dev = DeviceKey::generate().unwrap();
        let cert = o
            .admin
            .issue_device_cert(&admin_dev.public(), "mac", 3)
            .unwrap();
        o.trust.add_device_cert(cert).unwrap();
        assert!(
            o.trust
                .verify_device(&admin_dev.public())
                .unwrap()
                .is_admin()
        );
    }

    #[test]
    fn org_root_can_only_issue_admins() {
        let o = org();
        let m = keys();
        let mut t = o.trust.clone();
        // OK 直接簽發一般成員憑證 → 拒絕
        let mut body = o.ok.issue_first_admin(&m, 1).unwrap().body;
        body.roles = vec![Role::Member];
        let signed = o.ok.sign_raw(body).unwrap();
        assert!(matches!(
            t.add_member_cert(signed.clone()),
            Err(IdentityError::UnauthorizedSigner)
        ));
        // 改了內容 → 簽章失效
        let mut tampered = o.ok.issue_first_admin(&m, 1).unwrap();
        tampered.body.issued_at = 99;
        assert!(matches!(
            t.add_member_cert(tampered),
            Err(IdentityError::BadSignature)
        ));
    }

    #[test]
    fn non_admin_cannot_issue_members() {
        let mut o = org();
        let m = add_member(&mut o, vec![Role::Member]);
        let x = keys();
        let cert = m
            .issue_member_cert(
                o.trust.org_id(),
                MemberPublic::from(&x),
                vec![Role::Member],
                4,
            )
            .unwrap();
        assert!(matches!(
            o.trust.add_member_cert(cert),
            Err(IdentityError::UnauthorizedSigner)
        ));
    }

    #[test]
    fn admin_can_issue_another_admin() {
        let mut o = org();
        let a2 = add_member(&mut o, vec![Role::Admin, Role::Member]);
        let x = keys();
        let cert = a2
            .issue_member_cert(
                o.trust.org_id(),
                MemberPublic::from(&x),
                vec![Role::Member],
                5,
            )
            .unwrap();
        assert!(o.trust.add_member_cert(cert).is_ok());
    }

    #[test]
    fn other_org_rejected() {
        let mut o = org();
        let other = OrgRootKey::generate().unwrap();
        let x = keys();
        assert!(matches!(
            o.trust
                .add_member_cert(other.issue_first_admin(&x, 1).unwrap()),
            Err(IdentityError::OrgMismatch)
        ));
    }

    #[test]
    fn device_cert_must_be_signed_by_owner() {
        let mut o = org();
        let m = add_member(&mut o, vec![Role::Member]);
        let x = add_member(&mut o, vec![Role::Member]);
        let d = DeviceKey::generate().unwrap();
        // x 替 m 簽發裝置憑證
        let mut cert = x.issue_device_cert(&d.public(), "evil", 3).unwrap();
        cert.body.member_id = m.member_id();
        let resigned = x.sign_body(cert.body).unwrap();
        assert!(matches!(
            o.trust.add_device_cert(resigned),
            Err(IdentityError::UnauthorizedSigner)
        ));
    }

    #[test]
    fn revoked_member_and_device_fail() {
        let mut o = org();
        let m = add_member(&mut o, vec![Role::Member]);
        let d1 = add_device(&mut o, &m);
        let d2 = add_device(&mut o, &m);
        // 本人撤銷自己的 d1
        let r = m
            .issue_revocation(
                o.trust.org_id(),
                RevocationTarget::Device(d1.public()),
                "lost",
                6,
            )
            .unwrap();
        o.trust.add_revocation(&r).unwrap();
        assert!(matches!(
            o.trust.verify_device(&d1.public()),
            Err(IdentityError::Revoked)
        ));
        assert!(o.trust.verify_device(&d2.public()).is_ok());
        // 成員不能撤銷別人
        let x = add_member(&mut o, vec![Role::Member]);
        let r = x
            .issue_revocation(
                o.trust.org_id(),
                RevocationTarget::Member(m.member_id()),
                "",
                7,
            )
            .unwrap();
        assert!(matches!(
            o.trust.add_revocation(&r),
            Err(IdentityError::UnauthorizedSigner)
        ));
        // 管理者停用成員 → 所有裝置失效
        let r = o
            .admin
            .issue_revocation(
                o.trust.org_id(),
                RevocationTarget::Member(m.member_id()),
                "left",
                8,
            )
            .unwrap();
        o.trust.add_revocation(&r).unwrap();
        assert!(matches!(
            o.trust.verify_device(&d2.public()),
            Err(IdentityError::Revoked)
        ));
    }

    #[test]
    fn verify_device_signed_checks_signature_and_chain() {
        let mut o = org();
        let m = add_member(&mut o, vec![Role::Member]);
        let d = add_device(&mut o, &m);
        let rev = Revocation {
            v: FORMAT_VERSION,
            org_id: o.trust.org_id(),
            target: RevocationTarget::Member(m.member_id()),
            reason: "x".into(),
            at: 1,
        };
        let s = d.sign_body(rev).unwrap();
        assert!(o.trust.verify_device_signed(&s).is_ok());
        let mut tampered = s.clone();
        tampered.body.reason = "y".into();
        assert!(matches!(
            o.trust.verify_device_signed(&tampered),
            Err(IdentityError::BadSignature)
        ));
        let stranger = DeviceKey::generate().unwrap();
        assert!(matches!(
            o.trust
                .verify_device_signed(&stranger.sign_body(s.body).unwrap()),
            Err(IdentityError::UnknownDevice)
        ));
    }

    #[test]
    fn roster_import_any_order() {
        let mut o = org();
        let a2 = add_member(&mut o, vec![Role::Admin, Role::Member]);
        let x = keys();
        let cx = a2
            .issue_member_cert(
                o.trust.org_id(),
                MemberPublic::from(&x),
                vec![Role::Member],
                9,
            )
            .unwrap();
        o.trust.add_member_cert(cx).unwrap();
        let mut certs = o.trust.member_certs();
        certs.reverse();
        let roster = Roster {
            v: FORMAT_VERSION,
            org_id: o.trust.org_id(),
            member_certs: certs,
            revocations: vec![],
            issued_at: 10,
        };
        let mut fresh = TrustStore::new(o.ok.public());
        assert_eq!(fresh.import_roster(&roster).unwrap(), 0);
        assert!(fresh.is_active_member(&x.member_id()));
    }

    #[test]
    fn hello_requires_matching_node() {
        let mut o = org();
        let m = add_member(&mut o, vec![Role::Member]);
        let d = DeviceKey::generate().unwrap();
        let dc = m.issue_device_cert(&d.public(), "pc", 3).unwrap();
        let mc = o.trust.members.get(&m.member_id()).unwrap().clone();
        assert!(o.trust.verify_hello(&dc, &mc, &d.public()).is_ok());
        let other = DeviceKey::generate().unwrap();
        assert!(matches!(
            o.trust.verify_hello(&dc, &mc, &other.public()),
            Err(IdentityError::InconsistentCert)
        ));
    }
}
