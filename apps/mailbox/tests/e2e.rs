#![allow(clippy::unwrap_used, clippy::expect_used)] // 測試檔：失敗即 panic
//! mailbox 端對端測試：真實 iroh 連線（停用 relay，本機直連）。
//!
//! 對應 poc-report「加密 bundle + mailbox」：A 離線時 B 寫入，A 上線經 mailbox 補同步 ≤ 5 秒。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use automerge::{AutoCommit, ROOT, transaction::Transactable};
use hills_crypto::{KeyRing, open_bundle, rotate, seal_bundle};
use hills_identity::cert::{DeviceKey, MemberPublic, OrgRootKey};
use hills_identity::trust::TrustStore;
use hills_identity::{MemberKeys, RecoveryPhrase};
use hills_mailbox::{MAILBOX_ALPN, Mailbox, serve};
use hills_net::NetError;
use hills_net::mailbox::MailboxClient;
use hills_proto::mailbox::Hello;
use hills_proto::{FORMAT_VERSION, KeyFamily, MemberId, Pub32, RevocationTarget, Role, Roster};
use hills_sync::{Directory, Validator, sign_change};
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey, endpoint::presets, protocol::Router};

struct Person {
    keys: MemberKeys,
    device: DeviceKey,
}

struct Org {
    ok: OrgRootKey,
    trust: TrustStore,
    admin: Person,
    alice: Person,
    bob: Person,
}

fn person(trust: &mut TrustStore, issuer: &MemberKeys, roles: Vec<Role>) -> Person {
    let keys = RecoveryPhrase::generate().unwrap().derive_keys();
    let cert = issuer
        .issue_member_cert(trust.org_id(), MemberPublic::from(&keys), roles, 1)
        .unwrap();
    trust.add_member_cert(cert).unwrap();
    Person {
        keys,
        device: DeviceKey::generate().unwrap(),
    }
}

fn org() -> Org {
    let ok = OrgRootKey::generate().unwrap();
    let mut trust = TrustStore::new(ok.public());
    let akeys = RecoveryPhrase::generate().unwrap().derive_keys();
    trust
        .add_member_cert(ok.issue_first_admin(&akeys, 1).unwrap())
        .unwrap();
    let admin = Person {
        keys: akeys,
        device: DeviceKey::generate().unwrap(),
    };
    let alice = person(&mut trust, &admin.keys, vec![Role::Member]);
    let bob = person(&mut trust, &admin.keys, vec![Role::Member]);
    Org {
        ok,
        trust,
        admin,
        alice,
        bob,
    }
}

fn hello(o: &Org, p: &Person) -> Hello {
    Hello {
        device_cert: p
            .keys
            .issue_device_cert(&p.device.public(), "laptop", 2)
            .unwrap(),
        member_cert: o
            .trust
            .member_certs()
            .into_iter()
            .find(|c| c.body.member_id == p.keys.member_id())
            .unwrap(),
    }
}

fn roster(
    o: &Org,
    revocations: Vec<hills_proto::Signed<hills_proto::Revocation>>,
) -> hills_proto::Signed<Roster> {
    o.admin
        .device
        .sign_body(Roster {
            v: FORMAT_VERSION,
            org_id: o.trust.org_id(),
            member_certs: o.trust.member_certs(),
            revocations,
            issued_at: 3,
        })
        .unwrap()
}

async fn endpoint_for(device: &DeviceKey, alpns: Vec<Vec<u8>>) -> Endpoint {
    Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(&device.secret_bytes()))
        .relay_mode(RelayMode::Disabled)
        .alpns(alpns)
        .bind()
        .await
        .unwrap()
}

struct Server {
    router: Router,
    addr: EndpointAddr,
    _dir: tempfile::TempDir,
}

async fn server(o: &Org) -> (Server, Arc<Mailbox>) {
    let dir = tempfile::tempdir().unwrap();
    let mailbox = Mailbox::open(dir.path(), o.ok.public()).unwrap();
    let ep = endpoint_for(&DeviceKey::generate().unwrap(), vec![MAILBOX_ALPN.to_vec()]).await;
    let addr = ep.addr();
    let router = serve(ep, mailbox.clone());
    (
        Server {
            router,
            addr,
            _dir: dir,
        },
        mailbox,
    )
}

async fn connect(s: &Server, o: &Org, p: &Person) -> Result<(MailboxClient, Endpoint), NetError> {
    let ep = endpoint_for(&p.device, vec![]).await;
    let c = MailboxClient::connect(&ep, s.addr.clone(), hello(o, p)).await?;
    Ok((c, ep))
}

struct Team(HashSet<MemberId>);

impl Directory for Team {
    fn is_team_member(&self, team: &str, m: &MemberId) -> bool {
        team == "t1" && self.0.contains(m)
    }
    fn is_conv_member(&self, _: &str, _: &MemberId) -> bool {
        false
    }
    fn is_conv_admin(&self, _: &str, _: &MemberId) -> bool {
        false
    }
}

fn ek(p: &Person) -> Pub32 {
    Pub32(p.keys.exchange_public().to_bytes())
}

#[tokio::test]
async fn offline_member_catches_up_within_5s() {
    let mut o = org();
    let (srv, _) = server(&o).await;

    // 管理者以 OK 簽發的憑證 bootstrap，推送 roster
    let (admin, _aep) = connect(&srv, &o, &o.admin).await.unwrap();
    admin.put_roster(roster(&o, vec![])).await.unwrap();

    // 小組金鑰 epoch 1 封裝給 alice、bob（keys 紀錄的傳遞不在本測試範圍）
    let family = KeyFamily::Team("t1".into());
    let rot = rotate(
        &KeyRing::default(),
        &family,
        &[
            (o.alice.keys.member_id(), ek(&o.alice)),
            (o.bob.keys.member_id(), ek(&o.bob)),
        ],
    )
    .unwrap();
    let mut bob_ring = KeyRing::default();
    bob_ring.accept(&rot.wrapped[1], &o.bob.keys).unwrap();
    let mut alice_ring = KeyRing::default();
    alice_ring.accept(&rot.wrapped[0], &o.alice.keys).unwrap();

    // alice 離線期間，bob 編輯小組文件 3 次，每次上傳一份 bundle
    for p in [&o.alice, &o.bob] {
        o.trust
            .add_device_cert(
                p.keys
                    .issue_device_cert(&p.device.public(), "laptop", 2)
                    .unwrap(),
            )
            .unwrap();
    }
    let (bob, _bep) = connect(&srv, &o, &o.bob).await.unwrap();
    let mut bob_doc = AutoCommit::new();
    let key = bob_ring.get(&rot.key_id).unwrap().clone();
    for i in 0..3 {
        bob_doc
            .put(ROOT, format!("task{i}"), format!("工作 {i}"))
            .unwrap();
        bob_doc.commit();
        let sc = sign_change(
            "team/t1",
            &bob_doc.get_last_local_change().unwrap(),
            &o.bob.device,
        )
        .unwrap();
        let bundle = seal_bundle("team/t1", &rot.key_id, &key, &[sc]).unwrap();
        let (_, dup) = bob.put(bundle.clone()).await.unwrap();
        assert!(!dup);
        // 重送同一份 → 去重
        assert!(bob.put(bundle).await.unwrap().1);
    }

    // alice 上線補同步
    let t0 = Instant::now();
    let (alice, _alep) = connect(&srv, &o, &o.alice).await.unwrap();
    let (items, next) = alice
        .list_all(Some(vec!["team/t1".into()]), 0)
        .await
        .unwrap();
    assert_eq!(items.len(), 3);
    assert!(next >= 3);
    let dir = Team([o.alice.keys.member_id(), o.bob.keys.member_id()].into());
    let mut v = Validator::new(&o.trust, &dir);
    let mut alice_doc = AutoCommit::new();
    for it in &items {
        let changes = open_bundle(&it.bundle, &alice_ring).unwrap();
        assert_eq!(v.apply("team/t1", &mut alice_doc, &changes, 4), 1);
    }
    let elapsed = t0.elapsed();
    assert!(v.rejections().is_empty());
    assert_eq!(alice_doc.get_heads(), bob_doc.get_heads());
    println!(
        "catch-up: {} bundles in {:.1} ms",
        items.len(),
        elapsed.as_secs_f64() * 1000.0
    );
    assert!(elapsed < Duration::from_secs(5), "{elapsed:?}");

    // 之後的 cursor 沒有新資料
    assert!(alice.list(None, next, 10).await.unwrap().0.is_empty());
    // GET 單筆
    assert!(
        alice
            .get(items[0].bundle.bundle_hash)
            .await
            .unwrap()
            .is_some()
    );
    assert!(alice.get([0; 32]).await.unwrap().is_none());
    srv.router.shutdown().await.unwrap();
}

#[tokio::test]
async fn authentication_and_authorization() {
    let o = org();
    let (srv, _) = server(&o).await;

    // roster 推送前，管理者以外的成員不認識
    assert!(connect(&srv, &o, &o.alice).await.is_err());
    let (admin, _aep) = connect(&srv, &o, &o.admin).await.unwrap();
    admin.put_roster(roster(&o, vec![])).await.unwrap();
    let (alice, _alep) = connect(&srv, &o, &o.alice).await.unwrap();

    // 一般成員不能推送 roster
    assert!(
        matches!(alice.put_roster(roster(&o, vec![])).await, Err(NetError::Remote(m)) if m.contains("Forbidden"))
    );

    // 拿 alice 的憑證從別的裝置（NodeId 不同）連線 → 拒絕
    let stranger = DeviceKey::generate().unwrap();
    let ep = endpoint_for(&stranger, vec![]).await;
    assert!(
        MailboxClient::connect(&ep, srv.addr.clone(), hello(&o, &o.alice))
            .await
            .is_err()
    );

    // 陌生組織的管理者 → 拒絕
    let other = org();
    let ep = endpoint_for(&other.admin.device, vec![]).await;
    assert!(
        MailboxClient::connect(&ep, srv.addr.clone(), hello(&other, &other.admin))
            .await
            .is_err()
    );

    // 撤銷 bob 後，bob 既有的連線也失效
    let (bob, _bep) = connect(&srv, &o, &o.bob).await.unwrap();
    assert!(bob.list(None, 0, 10).await.is_ok());
    let rev = o
        .admin
        .keys
        .issue_revocation(
            o.trust.org_id(),
            RevocationTarget::Member(o.bob.keys.member_id()),
            "left",
            5,
        )
        .unwrap();
    admin.put_roster(roster(&o, vec![rev])).await.unwrap();
    assert!(
        matches!(bob.list(None, 0, 10).await, Err(NetError::Remote(m)) if m.contains("Unauthorized"))
    );
    assert!(connect(&srv, &o, &o.bob).await.is_err());
    srv.router.shutdown().await.unwrap();
}

#[tokio::test]
async fn bad_bundles_rejected_and_state_persists() {
    let o = org();
    let dir = tempfile::tempdir().unwrap();
    {
        let mailbox = Mailbox::open(dir.path(), o.ok.public()).unwrap();
        let ep = endpoint_for(&DeviceKey::generate().unwrap(), vec![MAILBOX_ALPN.to_vec()]).await;
        let srv = Server {
            addr: ep.addr(),
            router: serve(ep, mailbox),
            _dir: tempfile::tempdir().unwrap(),
        };
        let (admin, _aep) = connect(&srv, &o, &o.admin).await.unwrap();
        admin.put_roster(roster(&o, vec![])).await.unwrap();
        let (alice, _alep) = connect(&srv, &o, &o.alice).await.unwrap();
        let rot = rotate(&KeyRing::default(), &KeyFamily::Org, &[]).unwrap();
        let mut b = seal_bundle("org", &rot.key_id, &rot.key, &[]).unwrap();
        b.bundle_hash[0] ^= 1;
        assert!(matches!(alice.put(b).await, Err(NetError::Remote(m)) if m.contains("BadRequest")));
        let good = seal_bundle("org", &rot.key_id, &rot.key, &[]).unwrap();
        alice.put(good).await.unwrap();
        srv.router.shutdown().await.unwrap();
    }
    // 重新開啟：roster 與 bundle 仍在，alice 可直接連線
    let mailbox = Mailbox::open(dir.path(), o.ok.public()).unwrap();
    let ep = endpoint_for(&DeviceKey::generate().unwrap(), vec![MAILBOX_ALPN.to_vec()]).await;
    let srv = Server {
        addr: ep.addr(),
        router: serve(ep, mailbox),
        _dir: tempfile::tempdir().unwrap(),
    };
    let (alice, _alep) = connect(&srv, &o, &o.alice).await.unwrap();
    assert_eq!(alice.list_all(None, 0).await.unwrap().0.len(), 1);
    srv.router.shutdown().await.unwrap();
}
