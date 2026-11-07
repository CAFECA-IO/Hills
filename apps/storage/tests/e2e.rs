#![allow(clippy::unwrap_used, clippy::expect_used)] // 測試檔：失敗即 panic
//! 儲存節點端對端測試（technical-design §15.6）：真實 iroh 連線（停用 relay，本機直連）。

use std::sync::Arc;

use hills_identity::MemberKeys;
use hills_identity::cert::{DeviceKey, OrgRootKey};
use hills_identity::trust::TrustStore;
use hills_net::NetError;
use hills_net::storage::StorageClient;
use hills_proto::mailbox::Hello;
use hills_proto::{FORMAT_VERSION, RevocationTarget, Role, Roster};
use hills_storage::{STORAGE_ALPN, Storage, serve};
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey, endpoint::presets, protocol::Router};
use sha2::{Digest, Sha256};

struct Person {
    keys: MemberKeys,
    device: DeviceKey,
}

struct Org {
    trust: TrustStore,
    admin: Person,
    alice: Person,
    bob: Person,
}

fn person(trust: &mut TrustStore, issuer: &MemberKeys) -> Person {
    let keys = hills_identity::testing::keys();
    let cert = issuer
        .issue_member_cert(
            trust.org_id(),
            hills_identity::testing::public(&keys),
            vec![Role::Member],
            1,
        )
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
    let akeys = hills_identity::testing::keys();
    trust
        .add_member_cert(
            ok.issue_first_admin(hills_identity::testing::public(&akeys), 1)
                .unwrap(),
        )
        .unwrap();
    let admin = Person {
        keys: akeys,
        device: DeviceKey::generate().unwrap(),
    };
    let alice = person(&mut trust, &admin.keys);
    let bob = person(&mut trust, &admin.keys);
    Org {
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

struct Server {
    router: Router,
    addr: EndpointAddr,
    storage: Arc<Storage>,
    _dir: tempfile::TempDir,
}

async fn server(quota: u64) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let storage = Storage::open(dir.path(), None, quota).unwrap();
    let ep = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .relay_mode(RelayMode::Disabled)
        .alpns(vec![STORAGE_ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let addr = ep.addr();
    Server {
        router: serve(ep, storage.clone()),
        addr,
        storage,
        _dir: dir,
    }
}

/// 客戶端連線（endpoint 需與連線一起保留）。
struct Client {
    _ep: Endpoint,
    c: StorageClient,
}

impl std::ops::Deref for Client {
    type Target = StorageClient;
    fn deref(&self) -> &StorageClient {
        &self.c
    }
}

async fn connect(s: &Server, o: &Org, p: &Person) -> Result<Client, NetError> {
    let ep = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(&p.device.secret_bytes()))
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await
        .unwrap();
    let c = StorageClient::connect(&ep, s.addr.clone(), hello(o, p)).await?;
    Ok(Client { _ep: ep, c })
}

fn shard(seed: u8, len: usize) -> ([u8; 32], Vec<u8>) {
    let data: Vec<u8> = (0..len)
        .map(|i| (i as u8).wrapping_mul(31) ^ seed)
        .collect();
    (Sha256::digest(&data).into(), data)
}

fn far() -> i64 {
    i64::MAX / 2
}

#[tokio::test]
async fn put_get_has_and_sha_check() {
    let o = org();
    let srv = server(hills_storage::DEFAULT_QUOTA).await;
    // 第一位管理者綁定組織
    let admin = connect(&srv, &o, &o.admin).await.unwrap();
    assert!(srv.storage.is_claimed());
    let alice = connect(&srv, &o, &o.alice).await.unwrap();
    let (id, data) = shard(1, 4096);
    assert_eq!(alice.has(&[id]).await.unwrap(), vec![false]);
    assert!(!alice.put(id, data.clone(), far()).await.unwrap());
    assert!(
        alice.put(id, data.clone(), far()).await.unwrap(),
        "重複上傳"
    );
    assert_eq!(alice.has(&[id, [9; 32]]).await.unwrap(), vec![true, false]);
    assert_eq!(admin.get(id).await.unwrap(), data);
    // SHA-256 不符
    let (_, other) = shard(2, 100);
    assert!(
        matches!(alice.put(id, other, far()).await, Err(NetError::Remote(m)) if m.contains("BadRequest"))
    );
    // 不存在
    assert!(matches!(alice.get([7; 32]).await, Err(NetError::Remote(m)) if m.contains("NotFound")));
    let (n, bytes) = alice.health().await.unwrap();
    assert_eq!((n, bytes), (1, 4096));
    srv.router.shutdown().await.unwrap();
}

#[tokio::test]
async fn quota_and_expiry() {
    let o = org();
    let srv = server(10_000).await;
    let _admin = connect(&srv, &o, &o.admin).await.unwrap();
    let alice = connect(&srv, &o, &o.alice).await.unwrap();
    let (a, da) = shard(1, 6000);
    let (b, db) = shard(2, 6000);
    alice.put(a, da, far()).await.unwrap();
    assert!(
        matches!(alice.put(b, db.clone(), far()).await, Err(NetError::Remote(m)) if m.contains("TooLarge"))
    );
    // 配額是每位成員各自計算
    let bob = connect(&srv, &o, &o.bob).await.unwrap();
    bob.put(b, db, far()).await.unwrap();
    // 過期清除
    let removed = srv.storage.sweep(far() + 1);
    assert_eq!(removed, 2);
    assert_eq!(alice.has(&[a, b]).await.unwrap(), vec![false, false]);
    srv.router.shutdown().await.unwrap();
}

#[tokio::test]
async fn unclaimed_rejects_members_and_revoked_device_is_cut_off() {
    let o = org();
    let srv = server(hills_storage::DEFAULT_QUOTA).await;
    assert!(
        connect(&srv, &o, &o.alice).await.is_err(),
        "未綁定時一般成員不能連線"
    );
    let admin = connect(&srv, &o, &o.admin).await.unwrap();
    let bob = connect(&srv, &o, &o.bob).await.unwrap();
    let (id, data) = shard(3, 64);
    bob.put(id, data, far()).await.unwrap();
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
    let roster = o
        .admin
        .device
        .sign_body(Roster {
            v: FORMAT_VERSION,
            org_id: o.trust.org_id(),
            member_certs: o.trust.member_certs(),
            device_certs: vec![],
            revocations: vec![rev],
            issued_at: 3,
        })
        .unwrap();
    // 只有管理者能推送 roster
    assert!(bob.put_roster(roster.clone()).await.is_err());
    let bob = connect(&srv, &o, &o.bob).await.unwrap();
    admin.put_roster(roster).await.unwrap();
    assert!(matches!(bob.get(id).await, Err(NetError::Remote(m)) if m.contains("Unauthorized")));
    assert!(connect(&srv, &o, &o.bob).await.is_err());
    srv.router.shutdown().await.unwrap();
}

#[tokio::test]
async fn trust_state_persists() {
    let o = org();
    let dir = tempfile::tempdir().unwrap();
    {
        let s = Storage::open(dir.path(), None, 1 << 20).unwrap();
        assert!(!s.is_claimed());
        let ep = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::generate())
            .relay_mode(RelayMode::Disabled)
            .alpns(vec![STORAGE_ALPN.to_vec()])
            .bind()
            .await
            .unwrap();
        let srv = Server {
            addr: ep.addr(),
            router: serve(ep, s.clone()),
            storage: s,
            _dir: tempfile::tempdir().unwrap(),
        };
        connect(&srv, &o, &o.admin).await.unwrap();
        srv.router.shutdown().await.unwrap();
    }
    let again = Storage::open(dir.path(), None, 1 << 20).unwrap();
    assert!(again.is_claimed());
}
