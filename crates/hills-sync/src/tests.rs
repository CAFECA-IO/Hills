use std::collections::HashSet;

use automerge::{AutoCommit, ObjType, ROOT, ReadDoc, transaction::Transactable};
use hills_identity::MemberKeys;
use hills_identity::cert::{DeviceKey, OrgRootKey};
use hills_proto::{RevocationTarget, Role};
use proptest::prelude::*;

use super::*;

struct Dir {
    team: HashSet<MemberId>,
    leads: HashSet<MemberId>,
}

impl Directory for Dir {
    fn is_team_member(&self, team: &str, m: &MemberId) -> bool {
        team == "t1" && self.team.contains(m)
    }
    fn is_conv_member(&self, _: &str, _: &MemberId) -> bool {
        false
    }
    fn is_conv_admin(&self, _: &str, _: &MemberId) -> bool {
        false
    }
    fn is_team_lead(&self, team: &str, m: &MemberId) -> bool {
        team == "t1" && self.leads.contains(m)
    }
}

struct World {
    trust: TrustStore,
    admin: (MemberKeys, DeviceKey),
    alice: (MemberKeys, DeviceKey),
    bob: (MemberKeys, DeviceKey),
    dir: Dir,
}

fn person(
    trust: &mut TrustStore,
    issuer: &MemberKeys,
    roles: Vec<Role>,
) -> (MemberKeys, DeviceKey) {
    let k = hills_identity::testing::keys();
    let cert = issuer
        .issue_member_cert(
            trust.org_id(),
            hills_identity::testing::public(&k),
            roles,
            1,
        )
        .unwrap();
    trust.add_member_cert(cert).unwrap();
    let d = DeviceKey::generate().unwrap();
    trust
        .add_device_cert(k.issue_device_cert(&d.public(), "pc", 1).unwrap())
        .unwrap();
    (k, d)
}

fn world() -> World {
    let ok = OrgRootKey::generate().unwrap();
    let mut trust = TrustStore::new(ok.public());
    let ak = hills_identity::testing::keys();
    trust
        .add_member_cert(
            ok.issue_first_admin(hills_identity::testing::public(&ak), 1)
                .unwrap(),
        )
        .unwrap();
    let ad = DeviceKey::generate().unwrap();
    trust
        .add_device_cert(ak.issue_device_cert(&ad.public(), "mac", 1).unwrap())
        .unwrap();
    let alice = person(&mut trust, &ak, vec![Role::Member]);
    let bob = person(&mut trust, &ak, vec![Role::Member]);
    let dir = Dir {
        team: [alice.0.member_id(), bob.0.member_id()].into(),
        leads: [alice.0.member_id()].into(),
    };
    World {
        trust,
        admin: (ak, ad),
        alice,
        bob,
        dir,
    }
}

fn int(doc: &AutoCommit, key: &str) -> Option<i64> {
    match doc.get(ROOT, key).ok()??.0 {
        automerge::Value::Scalar(s) => match s.as_ref() {
            automerge::ScalarValue::Int(i) => Some(*i),
            _ => None,
        },
        _ => None,
    }
}

/// 在文件上做一次編輯並回傳該 change 的簽章版本。
fn edit(
    doc: &mut AutoCommit,
    doc_id: &str,
    key: &str,
    value: i64,
    dev: &DeviceKey,
) -> SignedChange {
    doc.put(ROOT, key, value).unwrap();
    doc.commit();
    let c = doc.get_last_local_change().unwrap();
    sign_change(doc_id, &c, dev).unwrap()
}

#[test]
fn owner_only_attendance_and_illegal_change_does_not_block_others() {
    let w = world();
    let id = format!("member/{}/attendance/2026-11", w.alice.0.member_id());
    let mut alice_doc = AutoCommit::new();
    let c1 = edit(&mut alice_doc, &id, "clock_in", 900, &w.alice.1);
    // bob 拿到 alice 的文件後偷改
    let mut bob_doc = alice_doc.fork();
    let evil = edit(&mut bob_doc, &id, "clock_in", 800, &w.bob.1);
    let c2 = edit(&mut alice_doc, &id, "clock_out", 1800, &w.alice.1);

    let mut replica = AutoCommit::new();
    let mut v = Validator::new(&w.trust, &w.dir);
    let applied = v.apply(&id, &mut replica, &[c1, evil, c2], 1);
    assert_eq!(applied, 2);
    assert_eq!(v.rejections().len(), 1);
    assert_eq!(v.rejections()[0].reason, SyncError::Forbidden);
    assert_eq!(v.rejections()[0].signer, w.bob.1.public());
    assert_eq!(int(&replica, "clock_in"), Some(900));
    assert_eq!(int(&replica, "clock_out"), Some(1800));
}

#[test]
fn only_admin_writes_org() {
    let w = world();
    let mut doc = AutoCommit::new();
    let by_admin = edit(&mut doc, "org", "name", 1, &w.admin.1);
    let mut doc2 = AutoCommit::new();
    let by_alice = edit(&mut doc2, "org", "name", 2, &w.alice.1);
    let v = Validator::new(&w.trust, &w.dir);
    assert!(v.check("org", &by_admin).is_ok());
    assert_eq!(v.check("org", &by_alice).unwrap_err(), SyncError::Forbidden);
}

#[test]
fn team_members_only() {
    let w = world();
    let mut doc = AutoCommit::new();
    let v = Validator::new(&w.trust, &w.dir);
    assert!(
        v.check("team/t1", &edit(&mut doc, "team/t1", "a", 1, &w.bob.1))
            .is_ok()
    );
    assert_eq!(
        v.check("team/t1", &edit(&mut doc, "team/t1", "b", 1, &w.admin.1))
            .unwrap_err(),
        SyncError::Forbidden
    );
    assert_eq!(
        v.check("team/t2", &edit(&mut doc, "team/t2", "c", 1, &w.bob.1))
            .unwrap_err(),
        SyncError::Forbidden
    );
}

#[test]
fn team_goals_by_lead_or_admin() {
    let w = world();
    let mut doc = AutoCommit::new();
    let v = Validator::new(&w.trust, &w.dir);
    let id = "team-goals/t1";
    assert!(v.check(id, &edit(&mut doc, id, "a", 1, &w.alice.1)).is_ok());
    assert!(v.check(id, &edit(&mut doc, id, "b", 1, &w.admin.1)).is_ok());
    assert_eq!(
        v.check(id, &edit(&mut doc, id, "c", 1, &w.bob.1))
            .unwrap_err(),
        SyncError::Forbidden
    );
    assert_eq!(
        v.check(
            "team-goals/t2",
            &edit(&mut doc, "team-goals/t2", "d", 1, &w.alice.1)
        )
        .unwrap_err(),
        SyncError::Forbidden
    );
}

#[test]
fn team_profile_only_by_owner() {
    let w = world();
    let alice = w.alice.0.member_id();
    let bob = w.bob.0.member_id();
    let v = Validator::new(&w.trust, &w.dir);
    let put = |doc: &mut AutoCommit, key: String, dev: &DeviceKey| {
        doc.put(ROOT, key.as_str(), "{\"hair\":1}").unwrap();
        doc.commit();
        sign_change("team/t1", &doc.get_last_local_change().unwrap(), dev).unwrap()
    };
    let mut doc = AutoCommit::new();
    let own = put(&mut doc, format!("profile:{alice}"), &w.alice.1);
    assert!(v.check("team/t1", &own).is_ok());
    let other = put(&mut doc, format!("profile:{alice}"), &w.bob.1);
    assert_eq!(
        v.check("team/t1", &other).unwrap_err(),
        SyncError::NotOwnProfile
    );
    doc.delete(ROOT, format!("profile:{alice}").as_str())
        .unwrap();
    doc.commit();
    let del = sign_change("team/t1", &doc.get_last_local_change().unwrap(), &w.bob.1).unwrap();
    assert_eq!(
        v.check("team/t1", &del).unwrap_err(),
        SyncError::NotOwnProfile
    );
    // 其他 key 不受限制
    let task = put(&mut doc, format!("task:{bob}"), &w.alice.1);
    assert!(v.check("team/t1", &task).is_ok());
    // 任務回應（D50）：只能寫自己的 ack
    let ack = put(&mut doc, format!("ack:t1:{alice}"), &w.alice.1);
    assert!(v.check("team/t1", &ack).is_ok());
    let forged = put(&mut doc, format!("ack:t1:{alice}"), &w.bob.1);
    assert_eq!(
        v.check("team/t1", &forged).unwrap_err(),
        SyncError::NotOwnProfile
    );
}

#[test]
fn revoked_device_rejected() {
    let mut w = world();
    let mut doc = AutoCommit::new();
    let id = format!("member/{}/requests", w.alice.0.member_id());
    let c = edit(&mut doc, &id, "x", 1, &w.alice.1);
    let r = w
        .alice
        .0
        .issue_revocation(
            w.trust.org_id(),
            RevocationTarget::Device(w.alice.1.public()),
            "lost",
            2,
        )
        .unwrap();
    w.trust.add_revocation(&r).unwrap();
    let v = Validator::new(&w.trust, &w.dir);
    assert!(matches!(v.check(&id, &c), Err(SyncError::Identity(_))));
}

#[test]
fn tampering_is_detected() {
    let w = world();
    let id = format!("member/{}/reports", w.alice.0.member_id());
    let mut doc = AutoCommit::new();
    let c = edit(&mut doc, &id, "x", 1, &w.alice.1);
    let v = Validator::new(&w.trust, &w.dir);

    let mut bytes = c.clone();
    let last = bytes.body.change.len() - 1;
    bytes.body.change[last] ^= 1;
    assert!(matches!(v.check(&id, &bytes), Err(SyncError::Identity(_))));

    // 換成另一筆 change 內容並重新簽章，但沿用舊 hash
    let mut other = AutoCommit::new();
    let c2 = edit(&mut other, &id, "y", 2, &w.alice.1);
    let mut body = c.body.clone();
    body.change = c2.body.change.clone();
    let resigned = w.alice.1.sign_body(body).unwrap();
    assert_eq!(
        v.check(&id, &resigned).unwrap_err(),
        SyncError::HashMismatch
    );

    // 拿到別的文件重播
    let other_id = format!("member/{}/requests", w.alice.0.member_id());
    assert_eq!(v.check(&other_id, &c).unwrap_err(), SyncError::WrongDoc);

    // 宣告的作者與簽署者不同
    let mut body = c.body.clone();
    body.author_device = w.bob.1.public();
    assert_eq!(
        v.check(&id, &w.alice.1.sign_body(body).unwrap())
            .unwrap_err(),
        SyncError::AuthorMismatch
    );

    // 未知文件類型
    let mut d = AutoCommit::new();
    assert_eq!(
        v.check("secret/x", &edit(&mut d, "secret/x", "z", 1, &w.alice.1))
            .unwrap_err(),
        SyncError::UnknownDoc
    );
}

/// 兩位小組成員各自離線編輯小組文件，所有 change 以任意順序套用到新副本，結果一致。
fn team_changes(n_alice: usize, n_bob: usize, w: &World) -> (Vec<SignedChange>, AutoCommit) {
    let id = "team/t1";
    let mut base = AutoCommit::new();
    base.put_object(ROOT, "tasks", ObjType::Map).unwrap();
    base.commit();
    let mut all = sign_local_changes(id, &mut base, &[], &w.alice.1).unwrap();
    let mut a = base.fork();
    let mut b = base.fork();
    for i in 0..n_alice {
        all.push(edit(&mut a, id, &format!("a{i}"), i as i64, &w.alice.1));
    }
    for i in 0..n_bob {
        all.push(edit(&mut b, id, &format!("b{}", i % 3), i as i64, &w.bob.1));
    }
    a.merge(&mut b).unwrap();
    (all, a)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]
    #[test]
    fn any_order_converges(n_a in 1usize..8, n_b in 1usize..8, seed in any::<u64>()) {
        let w = world();
        let (mut all, mut expected) = team_changes(n_a, n_b, &w);
        // Fisher–Yates，以 seed 決定順序
        let mut s = seed | 1;
        for i in (1..all.len()).rev() {
            s ^= s << 13; s ^= s >> 7; s ^= s << 17;
            all.swap(i, (s % (i as u64 + 1)) as usize);
        }
        let mut replica = AutoCommit::new();
        let mut v = Validator::new(&w.trust, &w.dir);
        // 逐筆套用，模擬亂序到達
        for c in &all {
            v.apply("team/t1", &mut replica, std::slice::from_ref(c), 1);
        }
        prop_assert!(v.rejections().is_empty());
        let mut eh = expected.get_heads();
        let mut rh = replica.get_heads();
        eh.sort();
        rh.sort();
        prop_assert_eq!(eh, rh);
    }
}

#[test]
fn kb_items_only_author_or_admin() {
    let w = world();
    let alice = w.alice.0.member_id();
    let v = Validator::new(&w.trust, &w.dir);
    let doc_id = "kb/items/2026-11";
    let sign = |doc: &mut AutoCommit, dev: &DeviceKey| {
        doc.commit();
        sign_change(doc_id, &doc.get_last_local_change().unwrap(), dev).unwrap()
    };
    let key = format!("{alice}:01abc");
    let mut doc = AutoCommit::new();
    // 作者新增、修改、刪除自己的
    doc.put(ROOT, key.as_str(), "{\"v\":1}").unwrap();
    assert!(v.check(doc_id, &sign(&mut doc, &w.alice.1)).is_ok());
    doc.put(ROOT, key.as_str(), "{\"v\":1,\"title\":\"x\"}")
        .unwrap();
    assert!(v.check(doc_id, &sign(&mut doc, &w.alice.1)).is_ok());
    // 別人改不行，用別人的前綴新增也不行
    doc.put(ROOT, key.as_str(), "{}").unwrap();
    assert_eq!(
        v.check(doc_id, &sign(&mut doc, &w.bob.1)).unwrap_err(),
        SyncError::NotOwnKey
    );
    // 管理者可改、可刪
    doc.put(ROOT, key.as_str(), "{\"v\":1,\"title\":\"y\"}")
        .unwrap();
    assert!(v.check(doc_id, &sign(&mut doc, &w.admin.1)).is_ok());
    doc.delete(ROOT, key.as_str()).unwrap();
    assert!(v.check(doc_id, &sign(&mut doc, &w.admin.1)).is_ok());
    // 巢狀物件不行（即使是作者）
    doc.put_object(ROOT, format!("{alice}:02").as_str(), ObjType::Map)
        .unwrap();
    assert_eq!(
        v.check(doc_id, &sign(&mut doc, &w.alice.1)).unwrap_err(),
        SyncError::NotOwnKey
    );
    // kb/meta 任何成員可寫
    let mut meta = AutoCommit::new();
    let m = meta.put_object(ROOT, "cat:01", ObjType::Map).unwrap();
    meta.put(&m, "name", "工程").unwrap();
    meta.commit();
    let sc = sign_change("kb/meta", &meta.get_last_local_change().unwrap(), &w.bob.1).unwrap();
    assert!(v.check("kb/meta", &sc).is_ok());
}
