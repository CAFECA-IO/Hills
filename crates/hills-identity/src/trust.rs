//! 信任鏈驗證（technical-design §3.2）。
//!
//! 1. `DeviceCert` 由某成員 IK 簽發，且裝置未被撤銷
//! 2. 該成員的 `MemberCert` 由有效管理者簽發，且成員未被停用
//! 3. 管理者的有效性可追溯至 OK 簽發的第一張管理者憑證
//! 4. 操作權限（角色）由呼叫端依 [`Verified::roles`] 判斷
//!
//! 語意：憑證在**簽發當時**簽發者有效即可。之後撤銷某位管理者，不會讓他先前加入的成員失效；
//! 若要移除那些成員，需各自撤銷。
//!
//! v0.13（§17.7）：同一成員可有多張憑證（還原換發），以 `issued_at` 最新者為準；被取代的 IK
//! 只接受時間早於取代時間的簽章，由它簽發的 DeviceCert 一律失效。

use std::collections::{HashMap, HashSet};

use ed25519_dalek::VerifyingKey;
use hills_proto::{
    DeviceCert, MemberCert, MemberId, OrgId, Pub32, Revocation, RevocationTarget, Role, Roster,
    Signable, Signed,
};

use crate::{IdentityError, cert::org_id_for, cert::verify_signature, member_id_for};
use hills_proto::Timestamp;

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
    /// 目前有效的憑證（每位成員 `issued_at` 最新者）
    members: HashMap<MemberId, Signed<MemberCert>>,
    /// 每位成員的全部憑證，依 `issued_at` 排序（含已被取代者，供驗證歷史簽章與 roster 分發）
    history: HashMap<MemberId, Vec<Signed<MemberCert>>>,
    by_ik: HashMap<Pub32, MemberId>,
    devices: HashMap<Pub32, Signed<DeviceCert>>,
    revoked_members: HashSet<MemberId>,
    revoked_devices: HashSet<Pub32>,
    revocations: Vec<Signed<Revocation>>,
}

impl TrustStore {
    pub fn new(org_root: Pub32) -> Self {
        Self {
            org_root,
            org_id: org_id_for(&org_root),
            members: HashMap::new(),
            history: HashMap::new(),
            by_ik: HashMap::new(),
            devices: HashMap::new(),
            revoked_members: HashSet::new(),
            revoked_devices: HashSet::new(),
            revocations: Vec::new(),
        }
    }

    pub fn org_id(&self) -> OrgId {
        self.org_id
    }

    pub fn org_root(&self) -> Pub32 {
        self.org_root
    }

    /// `ik` 在時間 `at` 是否為有效管理者：持有該 IK 的憑證具管理者角色，且在 `at` 時尚未被較新的憑證取代。
    fn admin_at(&self, ik: &Pub32, at: Timestamp) -> bool {
        let Some(m) = self.by_ik.get(ik) else {
            return false;
        };
        if self.revoked_members.contains(m) {
            return false;
        }
        let Some(list) = self.history.get(m) else {
            return false;
        };
        list.iter().enumerate().any(|(i, c)| {
            c.body.ik_pub == *ik
                && c.body.is_admin()
                && list.get(i + 1).is_none_or(|next| at < next.body.issued_at)
        })
    }

    /// 加入一張成員憑證：簽署者必須是 OK（僅限管理者憑證）或簽發當時有效的管理者。
    /// 同一成員已有較新的憑證時，這張只記入歷史。
    pub fn add_member_cert(&mut self, cert: Signed<MemberCert>) -> Result<(), IdentityError> {
        let b = &cert.body;
        hills_proto::check_version(b.v)?;
        if b.org_id != self.org_id {
            return Err(IdentityError::OrgMismatch);
        }
        if VerifyingKey::from_bytes(&b.ik_pub.0).is_err() || member_id_for(&b.cafeca) != b.member_id
        {
            return Err(IdentityError::InconsistentCert);
        }
        verify_signature(&cert)?;
        let by_root = cert.signer == self.org_root && b.is_admin();
        if !by_root && !self.admin_at(&cert.signer, b.issued_at) {
            return Err(IdentityError::UnauthorizedSigner);
        }
        let list = self.history.entry(b.member_id).or_default();
        if list.iter().any(|c| c.sig == cert.sig) {
            return Ok(());
        }
        // 同一 IK 不能屬於兩位成員
        if let Some(other) = self.by_ik.get(&b.ik_pub)
            && *other != b.member_id
        {
            return Err(IdentityError::InconsistentCert);
        }
        self.by_ik.insert(b.ik_pub, b.member_id);
        let pos = list.partition_point(|c| c.body.issued_at <= b.issued_at);
        list.insert(pos, cert.clone());
        if let Some(latest) = list.last() {
            self.members.insert(b.member_id, latest.clone());
        }
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
        let admin = self.admin_at(&rev.signer, rev.body.at);
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
        if !self.revocations.iter().any(|r| r.sig == rev.sig) {
            self.revocations.push(rev.clone());
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
        let mut rejected = pending.len();
        for d in &roster.device_certs {
            if self.add_device_cert(d.clone()).is_err() {
                rejected += 1;
            }
        }
        for r in &roster.revocations {
            self.add_revocation(r)?;
        }
        Ok(rejected)
    }

    /// 匯出目前的完整 roster（成員憑證、裝置憑證、撤銷），供推送給 mailbox 或保存。
    pub fn to_roster(&self, issued_at: hills_proto::Timestamp) -> Roster {
        Roster {
            v: hills_proto::FORMAT_VERSION,
            org_id: self.org_id,
            member_certs: self.history.values().flatten().cloned().collect(),
            device_certs: self
                .devices
                .values()
                .filter(|c| self.signed_by_current_ik(c))
                .cloned()
                .collect(),
            revocations: self.revocations.clone(),
            issued_at,
        }
    }

    /// 裝置憑證是否由該成員目前的 IK 簽發（還原後舊裝置失效）。
    fn signed_by_current_ik(&self, cert: &Signed<DeviceCert>) -> bool {
        self.members
            .get(&cert.body.member_id)
            .is_some_and(|m| m.body.ik_pub == cert.signer)
    }

    /// 某位成員目前有效的裝置。
    pub fn devices_of(&self, member: &MemberId) -> Vec<&DeviceCert> {
        self.devices
            .values()
            .filter(|c| {
                &c.body.member_id == member
                    && !self.revoked_devices.contains(&c.body.device_pub)
                    && self.signed_by_current_ik(c)
            })
            .map(|c| &c.body)
            .collect()
    }

    /// 由 CAFECA 帳戶找成員（不論是否停用）。
    pub fn member_by_cafeca(
        &self,
        account: &hills_proto::cafeca::CafecaAccount,
    ) -> Option<&MemberCert> {
        self.members.get(&member_id_for(account)).map(|c| &c.body)
    }

    /// 目前有效的成員。
    pub fn active_members(&self) -> Vec<&MemberCert> {
        self.members
            .values()
            .filter(|c| !self.revoked_members.contains(&c.body.member_id))
            .map(|c| &c.body)
            .collect()
    }

    pub fn member_cert(&self, id: &MemberId) -> Option<&Signed<MemberCert>> {
        self.members.get(id)
    }

    pub fn device_cert(&self, device: &Pub32) -> Option<&Signed<DeviceCert>> {
        self.devices.get(device)
    }

    pub fn is_revoked_device(&self, device: &Pub32) -> bool {
        self.revoked_devices.contains(device)
    }

    /// 合併另一份 roster 快照（來自 mailbox 或其他節點）；回傳是否有變更。
    pub fn merge_roster(&mut self, roster: &Roster) -> Result<bool, IdentityError> {
        let count = |t: &Self| {
            (
                t.history.values().map(Vec::len).sum::<usize>(),
                t.devices.len(),
                t.revocations.len(),
            )
        };
        let before = count(self);
        self.import_roster(roster)?;
        Ok(before != count(self))
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
        if member.body.ik_pub != cert.signer {
            return Err(IdentityError::Revoked);
        }
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
    use crate::{MemberKeys, member_id_for};
    use hills_proto::FORMAT_VERSION;
    use hills_proto::cafeca::CafecaAccount;

    struct Org {
        ok: OrgRootKey,
        trust: TrustStore,
        admin: M,
    }

    fn account() -> CafecaAccount {
        let mut address = [0u8; 20];
        getrandom::fill(&mut address).unwrap();
        CafecaAccount {
            chain_id: 8018,
            address,
        }
    }

    /// 新成員：隨機 CAFECA 帳戶與金鑰。
    struct M {
        keys: MemberKeys,
        cafeca: CafecaAccount,
    }

    impl std::ops::Deref for M {
        type Target = MemberKeys;
        fn deref(&self) -> &MemberKeys {
            &self.keys
        }
    }

    impl M {
        fn public(&self) -> MemberPublic {
            MemberPublic::of(&self.keys, self.cafeca)
        }
    }

    fn keys() -> M {
        let cafeca = account();
        M {
            keys: MemberKeys::generate()
                .unwrap()
                .with_member(member_id_for(&cafeca)),
            cafeca,
        }
    }

    fn org() -> Org {
        let ok = OrgRootKey::generate().unwrap();
        let admin = keys();
        let mut trust = TrustStore::new(ok.public());
        trust
            .add_member_cert(ok.issue_first_admin(admin.public(), 1).unwrap())
            .unwrap();
        Org { ok, trust, admin }
    }

    fn add_member(o: &mut Org, roles: Vec<Role>) -> M {
        let m = keys();
        let cert = o
            .admin
            .issue_member_cert(o.trust.org_id(), m.public(), roles, 2)
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
        let mut body = o.ok.issue_first_admin(m.public(), 1).unwrap().body;
        body.roles = vec![Role::Member];
        let signed = o.ok.sign_raw(body).unwrap();
        assert!(matches!(
            t.add_member_cert(signed.clone()),
            Err(IdentityError::UnauthorizedSigner)
        ));
        // 改了內容 → 簽章失效
        let mut tampered = o.ok.issue_first_admin(m.public(), 1).unwrap();
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
            .issue_member_cert(o.trust.org_id(), x.public(), vec![Role::Member], 4)
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
            .issue_member_cert(o.trust.org_id(), x.public(), vec![Role::Member], 5)
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
                .add_member_cert(other.issue_first_admin(x.public(), 1).unwrap()),
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
            .issue_member_cert(o.trust.org_id(), x.public(), vec![Role::Member], 9)
            .unwrap();
        o.trust.add_member_cert(cx).unwrap();
        let mut certs = o.trust.member_certs();
        certs.reverse();
        let roster = Roster {
            v: FORMAT_VERSION,
            org_id: o.trust.org_id(),
            member_certs: certs,
            device_certs: vec![],
            revocations: vec![],
            issued_at: 10,
        };
        let mut fresh = TrustStore::new(o.ok.public());
        assert_eq!(fresh.import_roster(&roster).unwrap(), 0);
        assert!(fresh.is_active_member(&x.member_id()));
    }

    #[test]
    fn full_roster_roundtrip_with_devices_and_revocations() {
        let mut o = org();
        let m = add_member(&mut o, vec![Role::Member]);
        let d1 = add_device(&mut o, &m);
        let d2 = add_device(&mut o, &m);
        let r = m
            .issue_revocation(
                o.trust.org_id(),
                RevocationTarget::Device(d1.public()),
                "lost",
                6,
            )
            .unwrap();
        o.trust.add_revocation(&r).unwrap();
        let roster = o.trust.to_roster(10);
        assert_eq!(roster.revocations.len(), 1);
        let mut fresh = TrustStore::new(o.ok.public());
        assert_eq!(fresh.import_roster(&roster).unwrap(), 0);
        assert!(fresh.verify_device(&d2.public()).is_ok());
        assert!(matches!(
            fresh.verify_device(&d1.public()),
            Err(IdentityError::Revoked)
        ));
        assert_eq!(fresh.devices_of(&m.member_id()).len(), 1);
        // 重複合併不算變更
        assert!(!fresh.merge_roster(&roster).unwrap());
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

    #[test]
    fn recovery_replaces_cert_and_invalidates_old_devices() {
        let mut o = org();
        let a2 = add_member(&mut o, vec![Role::Admin, Role::Member]);
        let m = add_member(&mut o, vec![Role::Member]);
        let old_dev = add_device(&mut o, &m);
        // a2 在還原前（時間 5）簽發一位成員
        let x = keys();
        let cx = a2
            .issue_member_cert(o.trust.org_id(), x.public(), vec![Role::Member], 5)
            .unwrap();
        o.trust.add_member_cert(cx.clone()).unwrap();
        // m 還原：同一 CAFECA 帳戶、新金鑰，由管理者在時間 20 換發
        let m2 = M {
            keys: MemberKeys::generate().unwrap().with_member(m.member_id()),
            cafeca: m.cafeca,
        };
        let c2 = o
            .admin
            .issue_member_cert(o.trust.org_id(), m2.public(), vec![Role::Member], 20)
            .unwrap();
        o.trust.add_member_cert(c2).unwrap();
        assert_eq!(
            o.trust.member(&m.member_id()).unwrap().ik_pub,
            m2.public().ik_pub
        );
        assert!(matches!(
            o.trust.verify_device(&old_dev.public()),
            Err(IdentityError::Revoked)
        ));
        assert!(o.trust.devices_of(&m.member_id()).is_empty());
        let new_dev = add_device(&mut o, &m2);
        assert!(o.trust.verify_device(&new_dev.public()).is_ok());
        // 舊 IK 不能再簽發裝置
        assert!(
            o.trust
                .add_device_cert(
                    m.issue_device_cert(&DeviceKey::generate().unwrap().public(), "x", 30)
                        .unwrap()
                )
                .is_err()
        );
        // a2 還原後：之前簽發的 x 仍可在新裝置上匯入；舊 IK 之後的簽發被拒
        let a2b = M {
            keys: MemberKeys::generate().unwrap().with_member(a2.member_id()),
            cafeca: a2.cafeca,
        };
        let ca = o
            .admin
            .issue_member_cert(
                o.trust.org_id(),
                a2b.public(),
                vec![Role::Admin, Role::Member],
                40,
            )
            .unwrap();
        o.trust.add_member_cert(ca).unwrap();
        let y = keys();
        let late = a2
            .issue_member_cert(o.trust.org_id(), y.public(), vec![Role::Member], 41)
            .unwrap();
        assert!(matches!(
            o.trust.add_member_cert(late),
            Err(IdentityError::UnauthorizedSigner)
        ));
        let mut fresh = TrustStore::new(o.ok.public());
        let mut roster = o.trust.to_roster(50);
        roster.member_certs.reverse();
        assert_eq!(fresh.import_roster(&roster).unwrap(), 0);
        assert!(fresh.is_active_member(&x.member_id()));
        assert!(fresh.verify_device(&new_dev.public()).is_ok());
        assert!(fresh.verify_device(&old_dev.public()).is_err());
    }

    #[test]
    fn member_id_must_match_cafeca() {
        let mut o = org();
        let x = keys();
        let mut p = x.public();
        p.cafeca.address[0] ^= 1;
        let cert = o
            .admin
            .issue_member_cert(o.trust.org_id(), p, vec![Role::Member], 3)
            .unwrap();
        // 簽發時以 p.cafeca 推導，因此一致；竄改帳戶後簽章失效
        o.trust.add_member_cert(cert.clone()).unwrap();
        let mut tampered = cert;
        tampered.body.cafeca.address[1] ^= 1;
        assert!(o.trust.add_member_cert(tampered).is_err());
    }
}
