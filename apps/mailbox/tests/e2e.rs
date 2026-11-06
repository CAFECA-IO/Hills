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
        member_cert: Some(
            o.trust
                .member_certs()
                .into_iter()
                .find(|c| c.body.member_id == p.keys.member_id())
                .unwrap(),
        ),
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
            device_certs: vec![],
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
    let mailbox = Mailbox::open(dir.path(), Some(o.ok.public())).unwrap();
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
    let c = MailboxClient::connect(&ep, s.addr.clone(), o.trust.org_id(), hello(o, p)).await?;
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
        MailboxClient::connect(&ep, srv.addr.clone(), o.trust.org_id(), hello(&o, &o.alice))
            .await
            .is_err()
    );

    // 陌生組織的管理者 → 拒絕
    let other = org();
    let ep = endpoint_for(&other.admin.device, vec![]).await;
    assert!(
        MailboxClient::connect(
            &ep,
            srv.addr.clone(),
            other.trust.org_id(),
            hello(&other, &other.admin)
        )
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
        let mailbox = Mailbox::open(dir.path(), Some(o.ok.public())).unwrap();
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
    let mailbox = Mailbox::open(dir.path(), Some(o.ok.public())).unwrap();
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

// ---------- v0.7 請求（technical-design §16.7） ----------

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn join_request(p: &Person) -> hills_proto::JoinRequest {
    let mut r = hills_proto::JoinRequest {
        v: FORMAT_VERSION,
        ik_pub: Pub32(p.keys.identity_public().to_bytes()),
        ek_pub: ek(p),
        device_cert: p
            .keys
            .issue_device_cert(&p.device.public(), "new-laptop", 2)
            .unwrap(),
        name: "新成員".into(),
        mac: [0; 32],
    };
    r.mac = hills_crypto::exchange::join_mac(&[9; 16], &[1; 8], &r.mac_input().unwrap());
    r
}

async fn bootstrap(o: &Org) -> (Server, MailboxClient, Endpoint) {
    let (srv, _) = server(o).await;
    let (admin, aep) = connect(&srv, o, &o.admin).await.unwrap();
    admin.put_roster(roster(o, vec![])).await.unwrap();
    (srv, admin, aep)
}

#[tokio::test]
async fn devices_revocations_and_roster_distribution() {
    let o = org();
    let (srv, admin, _aep) = bootstrap(&o).await;
    let (alice, _alep) = connect(&srv, &o, &o.alice).await.unwrap();

    // alice 上傳自己的第二台裝置
    let d2 = DeviceKey::generate().unwrap();
    alice
        .put_device(
            o.alice
                .keys
                .issue_device_cert(&d2.public(), "desktop", 3)
                .unwrap(),
        )
        .await
        .unwrap();
    // 不能替 bob 上傳
    let mut forged = o
        .alice
        .keys
        .issue_device_cert(&d2.public(), "x", 3)
        .unwrap();
    forged.body.member_id = o.bob.keys.member_id();
    assert!(alice.put_device(forged).await.is_err());

    let r = alice.get_roster().await.unwrap();
    assert_eq!(r.member_certs.len(), 3);
    assert!(
        r.device_certs
            .iter()
            .any(|c| c.body.device_pub == d2.public())
    );

    // 一般成員不能撤銷別人；本人可撤銷自己的裝置
    let bad = o
        .alice
        .keys
        .issue_revocation(
            o.trust.org_id(),
            RevocationTarget::Member(o.bob.keys.member_id()),
            "",
            4,
        )
        .unwrap();
    assert!(alice.put_revocation(bad).await.is_err());
    let own = o
        .alice
        .keys
        .issue_revocation(
            o.trust.org_id(),
            RevocationTarget::Device(d2.public()),
            "lost",
            4,
        )
        .unwrap();
    alice.put_revocation(own).await.unwrap();
    let r = admin.get_roster().await.unwrap();
    assert_eq!(r.revocations.len(), 1);

    // 匯入 mailbox 給的 roster 後，本地信任狀態可驗證 alice 的裝置、拒絕已撤銷裝置
    let mut local = TrustStore::new(o.ok.public());
    local.import_roster(&r).unwrap();
    assert!(local.verify_device(&o.alice.device.public()).is_ok());
    assert!(local.verify_device(&d2.public()).is_err());
    srv.router.shutdown().await.unwrap();
}

#[tokio::test]
async fn invite_and_join_flow() {
    let o = org();
    let (srv, admin, _aep) = bootstrap(&o).await;
    let (alice, _alep) = connect(&srv, &o, &o.alice).await.unwrap();
    let newbie = Person {
        keys: RecoveryPhrase::generate().unwrap().derive_keys(),
        device: DeviceKey::generate().unwrap(),
    };
    let nep = endpoint_for(&newbie.device, vec![]).await;
    let org_id = o.trust.org_id();

    // 未登記的邀請 → 拒絕
    assert!(
        MailboxClient::join(
            &nep,
            srv.addr.clone(),
            org_id,
            [1; 8],
            join_request(&newbie)
        )
        .await
        .is_err()
    );
    // 一般成員不能登記邀請
    assert!(alice.register_invite([1; 8], now() + 60_000).await.is_err());
    admin.register_invite([1; 8], now() + 60_000).await.unwrap();
    MailboxClient::join(
        &nep,
        srv.addr.clone(),
        org_id,
        [1; 8],
        join_request(&newbie),
    )
    .await
    .unwrap();

    // 申請中的裝置必須是連線的 NodeId
    let other = endpoint_for(&DeviceKey::generate().unwrap(), vec![]).await;
    assert!(
        MailboxClient::join(
            &other,
            srv.addr.clone(),
            org_id,
            [1; 8],
            join_request(&newbie)
        )
        .await
        .is_err()
    );

    // 只有管理者能讀取申請
    assert!(alice.fetch_joins().await.is_err());
    let joins = admin.fetch_joins().await.unwrap();
    assert_eq!(joins.len(), 1);
    assert_eq!(joins[0].request.name, "新成員");

    // 每個邀請最多 5 筆待處理
    for _ in 0..4 {
        let p = Person {
            keys: RecoveryPhrase::generate().unwrap().derive_keys(),
            device: DeviceKey::generate().unwrap(),
        };
        let ep = endpoint_for(&p.device, vec![]).await;
        MailboxClient::join(&ep, srv.addr.clone(), org_id, [1; 8], join_request(&p))
            .await
            .unwrap();
    }
    let p = Person {
        keys: RecoveryPhrase::generate().unwrap().derive_keys(),
        device: DeviceKey::generate().unwrap(),
    };
    let ep = endpoint_for(&p.device, vec![]).await;
    assert!(matches!(
        MailboxClient::join(&ep, srv.addr.clone(), org_id, [1; 8], join_request(&p)).await,
        Err(NetError::Remote(m)) if m.contains("TooLarge")
    ));

    // 關閉邀請後無法再申請，待處理清單也清空
    admin.close_invite([1; 8]).await.unwrap();
    assert!(admin.fetch_joins().await.unwrap().is_empty());
    assert!(
        MailboxClient::join(
            &nep,
            srv.addr.clone(),
            org_id,
            [1; 8],
            join_request(&newbie)
        )
        .await
        .is_err()
    );
    // 過期的邀請無法登記
    assert!(admin.register_invite([2; 8], now() - 1).await.is_err());
    srv.router.shutdown().await.unwrap();
}

#[tokio::test]
async fn wrapped_keys_mailbox() {
    let o = org();
    let (srv, admin, _aep) = bootstrap(&o).await;
    let (alice, _alep) = connect(&srv, &o, &o.alice).await.unwrap();
    let (bob, _bep) = connect(&srv, &o, &o.bob).await.unwrap();

    let rot = rotate(
        &KeyRing::default(),
        &KeyFamily::Org,
        &[
            (o.alice.keys.member_id(), ek(&o.alice)),
            (o.bob.keys.member_id(), ek(&o.bob)),
        ],
    )
    .unwrap();
    let signed: Vec<_> = rot
        .wrapped
        .iter()
        .map(|w| o.admin.device.sign_body(w.clone()).unwrap())
        .collect();
    // 一般成員自己簽署的 org 金鑰封裝 → 拒絕（權限看簽署者，不看上傳者）
    let by_alice: Vec<_> = rot
        .wrapped
        .iter()
        .map(|w| o.alice.device.sign_body(w.clone()).unwrap())
        .collect();
    assert!(alice.put_keys(by_alice).await.is_err());
    admin.put_keys(signed.clone()).await.unwrap();
    admin.put_keys(signed).await.unwrap(); // 重送不重複

    let (items, next) = alice.fetch_keys(0).await.unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].wrapped.body.recipient, o.alice.keys.member_id());
    let mut ring = KeyRing::default();
    ring.accept(&items[0].wrapped.body, &o.alice.keys).unwrap();
    assert!(alice.fetch_keys(next).await.unwrap().0.is_empty());
    assert_eq!(bob.fetch_keys(0).await.unwrap().0.len(), 1);

    // 成員可以封裝自己的私密金鑰
    let fam = KeyFamily::MemberPrivate(o.alice.keys.member_id());
    let own = rotate(
        &KeyRing::default(),
        &fam,
        &[(o.alice.keys.member_id(), ek(&o.alice))],
    )
    .unwrap();
    alice
        .put_keys(vec![
            o.alice.device.sign_body(own.wrapped[0].clone()).unwrap(),
        ])
        .await
        .unwrap();
    // 但不能替 bob 封裝 bob 的私密金鑰
    let fam_b = KeyFamily::MemberPrivate(o.bob.keys.member_id());
    let other = rotate(
        &KeyRing::default(),
        &fam_b,
        &[(o.bob.keys.member_id(), ek(&o.bob))],
    )
    .unwrap();
    assert!(
        alice
            .put_keys(vec![
                o.alice.device.sign_body(other.wrapped[0].clone()).unwrap()
            ])
            .await
            .is_err()
    );
    srv.router.shutdown().await.unwrap();
}

#[tokio::test]
async fn address_book() {
    let o = org();
    let (srv, admin, _aep) = bootstrap(&o).await;
    let (alice, alep) = connect(&srv, &o, &o.alice).await.unwrap();
    let my = hills_net::to_peer_addr(&alep.addr());
    alice.announce(my.clone()).await.unwrap();
    // 不能替別的裝置登記位址
    let mut fake = my.clone();
    fake.node = o.bob.device.public();
    assert!(alice.announce(fake).await.is_err());
    let peers = admin.peers().await.unwrap();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].device, o.alice.device.public());
    assert_eq!(
        hills_net::to_endpoint_addr(&peers[0].addr).unwrap().id,
        alep.addr().id
    );
    // 撤銷 alice 後不再列出
    let rev = o
        .admin
        .keys
        .issue_revocation(
            o.trust.org_id(),
            RevocationTarget::Member(o.alice.keys.member_id()),
            "",
            5,
        )
        .unwrap();
    admin.put_revocation(rev).await.unwrap();
    assert!(admin.peers().await.unwrap().is_empty());
    srv.router.shutdown().await.unwrap();
}

/// 未綁定的 mailbox：非管理者被拒；第一位 OK 簽發的管理者完成綁定，重啟後保留，之後他組織被拒。
#[tokio::test]
async fn unclaimed_mailbox_is_claimed_by_first_admin() {
    let o = org();
    let other = org();
    let dir = tempfile::tempdir().unwrap();
    {
        let mailbox = Mailbox::open(dir.path(), None).unwrap();
        assert!(!mailbox.is_claimed());
        let ep = endpoint_for(&DeviceKey::generate().unwrap(), vec![MAILBOX_ALPN.to_vec()]).await;
        let addr = ep.addr();
        let s = Server {
            router: serve(ep, mailbox.clone()),
            addr: addr.clone(),
            _dir: tempfile::tempdir().unwrap(),
        };
        // 一般成員不能綁定
        assert!(connect(&s, &o, &o.alice).await.is_err());
        assert!(!mailbox.is_claimed());
        // 第一位管理者綁定
        let (c, _ep) = connect(&s, &o, &o.admin).await.unwrap();
        assert!(mailbox.is_claimed());
        assert_eq!(mailbox.org_id(), o.trust.org_id());
        c.get_roster().await.unwrap();
        // 另一個組織的管理者被拒
        assert!(connect(&s, &other, &other.admin).await.is_err());
        s.router.shutdown().await.unwrap();
    }
    // 重啟後仍綁定在原組織；指定不同 OK 拒絕啟動
    let reopened = Mailbox::open(dir.path(), None).unwrap();
    assert_eq!(reopened.org_id(), o.trust.org_id());
    drop(reopened);
    assert!(Mailbox::open(dir.path(), Some(other.ok.public())).is_err());
}

/// `Info`：位址就緒前回錯誤，設定後回傳（technical-design §16.7）；需先 Hello。
#[tokio::test]
async fn info_returns_self_addr() {
    let o = org();
    let (srv, mb) = server(&o).await;
    let (admin, _ep) = connect(&srv, &o, &o.admin).await.unwrap();
    assert!(admin.info().await.is_err(), "位址未設定時應回錯誤");
    let mut addr = hills_net::to_peer_addr(&srv.addr);
    addr.relay = Some("https://relay.example.com/".into());
    assert!(mb.set_self_addr(addr.clone()));
    assert!(!mb.set_self_addr(addr.clone()), "相同位址不算改變");
    assert_eq!(admin.info().await.unwrap(), addr);
    srv.router.shutdown().await.unwrap();
}
