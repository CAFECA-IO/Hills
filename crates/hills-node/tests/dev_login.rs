#![allow(clippy::unwrap_used, clippy::expect_used)]
//! 開發測試模式（D44，technical-design §17.10）：以測試帳號名稱建立、加入、新增裝置。

mod common;
use common::*;

fn create_kind(code: &str) -> OnboardKind {
    OnboardKind::Create(CreateOrg {
        org_name: "測試組織".into(),
        my_name: "Admin".into(),
        device_name: "admin-mac".into(),
        mailbox_code: code.into(),
        timezone: "Asia/Taipei".into(),
        locale: "zh-TW".into(),
        team_name: "預設小組".into(),
    })
}

fn join_kind(org_code: String, device: &str) -> OnboardKind {
    OnboardKind::Join {
        org_code,
        my_name: "Bob".into(),
        device_name: device.into(),
    }
}

async fn dev_begin(dir: &Path, kind: OnboardKind, name: &str) -> OnboardStep {
    let (mut ob, view) = Onboarding::begin_with(dir, store(), kind, dev_opts(), Some(name.into()))
        .await
        .unwrap();
    assert!(view.link.is_empty());
    ob.poll().await.unwrap()
}

#[tokio::test]
async fn dev_login_create_join_and_add_device() {
    let mb = dev_mailbox().await;
    let d_admin = tempfile::tempdir().unwrap();
    let OnboardStep::Created(admin, _ok) =
        dev_begin(d_admin.path(), create_kind(&mb.code), "admin").await
    else {
        panic!("應完成建立組織");
    };
    admin.sync_now().await.unwrap();
    let org_code = admin.org_ticket().unwrap();

    // bob 以測試帳號申請加入，管理者以 Dev 驗證器核准
    let d_bob = tempfile::tempdir().unwrap();
    let OnboardStep::WaitingApproval(bob) =
        dev_begin(d_bob.path(), join_kind(org_code.clone(), "bob-pc"), "Bob").await
    else {
        panic!("應等待核准");
    };
    approve_pending(&admin, &bob).await;
    assert!(
        eventually(Duration::from_secs(10), || async {
            let _ = bob.sync_now().await;
            bob.status() == SyncStatus::Synced && bob.org().members.contains_key(&bob.member_id())
        })
        .await,
        "bob 未完成加入"
    );
    assert_eq!(
        bob.member_id(),
        hills_identity::member_id_for(&hills_cafeca::dev::dev_account("bob"))
    );

    // 另一台電腦輸入相同名稱 = 新增裝置，由 bob 的裝置自動授權
    let d_bob2 = tempfile::tempdir().unwrap();
    let (mut ob, _) = Onboarding::begin_with(
        d_bob2.path(),
        store(),
        join_kind(org_code, "bob-laptop"),
        dev_opts(),
        Some("bob".into()),
    )
    .await
    .unwrap();
    assert!(matches!(
        ob.poll().await.unwrap(),
        OnboardStep::WaitingDevice { .. }
    ));
    let mut laptop = None;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        let _ = bob.sync_now().await;
        if let OnboardStep::Linked(n) = ob.poll().await.unwrap() {
            laptop = Some(n);
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let laptop = laptop.expect("新裝置應完成綁定");
    assert_eq!(laptop.member_id(), bob.member_id());
    for n in [laptop, bob, admin] {
        n.shutdown().await;
    }
    mb.router.shutdown().await.unwrap();
}

#[tokio::test]
async fn dev_login_requires_both_sides() {
    // release 建置（allow_dev_login = false）不接受測試帳號
    let mb = dev_mailbox().await;
    let d = tempfile::tempdir().unwrap();
    assert!(
        Onboarding::begin_with(
            d.path(),
            store(),
            create_kind(&mb.code),
            NodeOptions::default(),
            Some("admin".into()),
        )
        .await
        .is_err()
    );
    mb.router.shutdown().await.unwrap();

    // mailbox 未啟用 HILLS_DEV_LOGIN
    let real = mailbox_with(
        "https://wallet.example",
        Verifier::Rpc(hills_cafeca::RpcVerifier::new("https://wallet.example", None).unwrap()),
    )
    .await;
    assert!(
        Onboarding::begin_with(
            d.path(),
            store(),
            create_kind(&real.code),
            dev_opts(),
            Some("admin".into()),
        )
        .await
        .is_err()
    );
    real.router.shutdown().await.unwrap();
}

#[tokio::test]
async fn old_ticket_version_is_explained() {
    // v1 時代的 mailbox 連線碼（D41 之前的伺服器）
    let mut t = MailboxTicket::from_code(&dev_mailbox().await.code).unwrap();
    t.v = 1;
    let code = t.to_code().unwrap();
    let d = tempfile::tempdir().unwrap();
    let err = Onboarding::begin_with(d.path(), store(), create_kind(&code), dev_opts(), None)
        .await
        .err()
        .expect("舊版連線碼應被拒絕")
        .to_string();
    assert!(err.contains("舊版") && err.contains("v1"), "{err}");
}
