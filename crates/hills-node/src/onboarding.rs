//! 以 CAFECA 登入建立、加入組織，新增裝置與還原（technical-design §17.5–17.7）。
//!
//! 使用方式：[`Onboarding::begin`] 取得登入連結與確認碼 → 定期呼叫 [`Onboarding::poll`]，
//! 直到回傳 [`OnboardStep::Created`]、[`OnboardStep::WaitingApproval`] 或 [`OnboardStep::Linked`]。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use hills_cafeca::request::Outcome;
use hills_cafeca::{CafecaError, PendingSignIn, RpcVerifier, Verified, Verifier};
use hills_crypto::exchange::Ephemeral;
use hills_crypto::{KeyRing, rotate};
use hills_identity::cert::{DeviceKey, MemberPublic, OrgRootKey, org_id_for};
use hills_identity::secret_store::SecretStore;
use hills_identity::trust::TrustStore;
use hills_identity::{MemberKeys, member_id_for};
use hills_net::mailbox::MailboxClient;
use hills_net::to_endpoint_addr;
use hills_proto::cafeca::{
    Application, CafecaProof, DeviceGrantPayload, JoinApplication, SignInBinding, SignInKind,
};
use hills_proto::mailbox::JoinState;
use hills_proto::ticket::{MailboxTicket, OrgTicket, Ticket};
use hills_proto::{FORMAT_VERSION, KeyFamily, OrgId, PeerAddr, Pub32};
use iroh::address_lookup::MemoryLookup;
use iroh::{Endpoint, RelayMode, SecretKey, endpoint::presets};

use crate::config::{MemberStatus, NodeConfig, ORG_ROOT_SECRET, Secrets};
use crate::lifecycle::DEFAULT_TEAM;
use crate::node::{Node, NodeOptions, lock, now_ms};
use crate::org::{self, NewOrg};

/// 建立組織時的輸入。
pub struct CreateOrg {
    pub org_name: String,
    pub my_name: String,
    pub device_name: String,
    pub mailbox_code: String,
    pub timezone: String,
    pub locale: String,
    pub team_name: String,
}

/// 登入的目的。
pub enum OnboardKind {
    Create(CreateOrg),
    /// 加入組織；已是成員時自動成為新增裝置
    Join {
        org_code: String,
        my_name: String,
        device_name: String,
    },
    /// 遺失全部裝置後還原
    Recover {
        org_code: String,
        device_name: String,
    },
}

/// 顯示給使用者的登入資訊。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SignInView {
    /// 同時用於 QR 與「在這台電腦開啟」
    pub link: String,
    /// `XXXX-XXXX`
    pub code: String,
    /// Unix 秒
    pub expires_at: u64,
}

/// [`Onboarding::poll`] 的結果。
pub enum OnboardStep {
    /// 等待使用者在 CAFECA 簽署
    WaitingSignIn,
    /// 等待本人其他裝置封裝成員金鑰
    WaitingDevice { handle: Option<String> },
    /// 已送出加入或還原申請；節點以「等待核准」狀態執行
    WaitingApproval(Node),
    /// 已建立組織；呼叫端應引導匯出組織根金鑰備份
    Created(Node, Box<OrgRootKey>),
    /// 新裝置已完成綁定
    Linked(Node),
}

enum Phase {
    SignIn(Box<PendingSignIn>),
    Device {
        eph: Ephemeral,
        account: hills_proto::cafeca::CafecaAccount,
        handle: Option<String>,
    },
    Done,
}

/// 進行中的登入與加入流程。
pub struct Onboarding {
    dir: PathBuf,
    secret_store: Arc<dyn SecretStore>,
    opts: NodeOptions,
    kind: OnboardKind,
    org_root: Pub32,
    org_id: OrgId,
    mailbox: PeerAddr,
    keys: Option<MemberKeys>,
    device: DeviceKey,
    ok: Option<OrgRootKey>,
    endpoint: Endpoint,
    http: reqwest::Client,
    verifier: Arc<Verifier>,
    phase: Phase,
}

fn now_secs() -> u64 {
    (now_ms() / 1000) as u64
}

fn ensure_empty(dir: &Path) -> Result<()> {
    if NodeConfig::load(dir)?.is_some() {
        bail!("此裝置已加入組織");
    }
    Ok(())
}

/// 與 mailbox 匿名通訊用的暫時 endpoint（金鑰即本裝置 DK，mailbox 以此確認申請者）。
async fn temp_endpoint(device: &DeviceKey, mailbox: &PeerAddr) -> Result<Endpoint> {
    let memory = MemoryLookup::new();
    memory.add_endpoint_info(to_endpoint_addr(mailbox)?);
    let relay = match &mailbox.relay {
        Some(u) => RelayMode::custom([u.parse().context("relay URL 無效")?]),
        None => RelayMode::Disabled,
    };
    Ok(Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(&device.secret_bytes()))
        .relay_mode(relay)
        .address_lookup(memory)
        .bind()
        .await?)
}

fn pub_of(keys: &MemberKeys) -> (Pub32, Pub32) {
    (
        Pub32(keys.identity_public().to_bytes()),
        Pub32(keys.exchange_public().to_bytes()),
    )
}

impl Onboarding {
    /// 開始登入：取得 CAFECA 錢包網址、產生金鑰與登入請求。
    pub async fn begin(
        dir: &Path,
        secret_store: Arc<dyn SecretStore>,
        kind: OnboardKind,
        opts: NodeOptions,
    ) -> Result<(Self, SignInView)> {
        ensure_empty(dir)?;
        let (org_root, mailbox, ok) = match &kind {
            OnboardKind::Create(c) => {
                let mailbox = MailboxTicket::from_code(&c.mailbox_code)
                    .context("mailbox 連線碼無效")?
                    .mailbox;
                let ok = OrgRootKey::generate()?;
                (ok.public(), mailbox, Some(ok))
            }
            OnboardKind::Join { org_code, .. } | OnboardKind::Recover { org_code, .. } => {
                let t = OrgTicket::from_code(org_code).context("組織連線碼無效")?;
                (t.org_root, t.mailbox, None)
            }
        };
        let org_id = org_id_for(&org_root);
        let device = DeviceKey::generate()?;
        let keys = MemberKeys::generate()?;
        let endpoint = temp_endpoint(&device, &mailbox).await?;
        let cfg = MailboxClient::config(&endpoint, to_endpoint_addr(&mailbox)?)
            .await
            .context("無法連線到 mailbox")?;
        if cfg.cafeca_wallet.is_empty() {
            bail!("此組織的 mailbox 尚未設定 CAFECA 錢包（HILLS_CAFECA_WALLET）");
        }
        let verifier = match &opts.verifier {
            Some(v) => v.clone(),
            None => Arc::new(Verifier::Rpc(RpcVerifier::new(&cfg.cafeca_wallet, None)?)),
        };
        let (ik, ek) = pub_of(&keys);
        let (signin_kind, action) = match &kind {
            OnboardKind::Create(c) => (
                SignInKind::Create,
                format!(
                    "建立 Hills 組織「{}」",
                    c.org_name.chars().take(40).collect::<String>()
                ),
            ),
            OnboardKind::Join { .. } => (SignInKind::Join, "加入 Hills 組織".to_owned()),
            OnboardKind::Recover { .. } => (SignInKind::Recover, "還原 Hills 成員身分".to_owned()),
        };
        let binding = SignInBinding {
            v: FORMAT_VERSION,
            org_id,
            kind: signin_kind,
            device_pub: device.public(),
            ik_pub: Some(ik),
            key_pub: ek,
            issued_at: now_secs(),
        };
        let pending = PendingSignIn::new(&cfg.cafeca_wallet, binding, &action)?;
        let view = SignInView {
            link: pending.link.clone(),
            code: pending.code.clone(),
            expires_at: pending.expires_at,
        };
        Ok((
            Self {
                dir: dir.to_owned(),
                secret_store,
                opts,
                kind,
                org_root,
                org_id,
                mailbox,
                keys: Some(keys),
                device,
                ok,
                endpoint,
                http: hills_cafeca::http_client()?,
                verifier,
                phase: Phase::SignIn(Box::new(pending)),
            },
            view,
        ))
    }

    /// 查詢一次進度。CAFECA 拒絕或逾時時回傳錯誤（[`CafecaError`]）。
    pub async fn poll(&mut self) -> Result<OnboardStep> {
        match &self.phase {
            Phase::SignIn(p) => {
                let Some(outcome) = p.poll(&self.http, now_secs()).await? else {
                    return Ok(OnboardStep::WaitingSignIn);
                };
                let proof = match outcome {
                    Outcome::Approved(proof) => *proof,
                    Outcome::Denied => return Err(CafecaError::Denied.into()),
                };
                let verified = self.verifier.verify(&proof, now_secs()).await?;
                self.after_sign_in(proof, verified).await
            }
            Phase::Device { .. } => self.poll_grant().await,
            Phase::Done => bail!("流程已結束"),
        }
    }

    /// 測試用：直接提供登入證明（略過 CAFECA 中繼）。
    #[doc(hidden)]
    pub async fn submit_proof_for_tests(&mut self, proof: CafecaProof) -> Result<OnboardStep> {
        let verified = self.verifier.verify(&proof, now_secs()).await?;
        self.after_sign_in(proof, verified).await
    }

    /// 測試用：目前登入請求的綁定內容。
    #[doc(hidden)]
    pub fn binding_for_tests(&self) -> Option<SignInBinding> {
        match &self.phase {
            Phase::SignIn(p) => Some(p.binding().clone()),
            _ => None,
        }
    }

    async fn after_sign_in(
        &mut self,
        proof: CafecaProof,
        verified: Verified,
    ) -> Result<OnboardStep> {
        let member = member_id_for(&verified.account);
        let keys = self
            .keys
            .take()
            .ok_or_else(|| anyhow!("流程狀態錯誤"))?
            .with_member(member);
        match &self.kind {
            OnboardKind::Create(_) => {
                self.phase = Phase::Done;
                let (node, ok) = self.finish_create(keys, verified).await?;
                Ok(OnboardStep::Created(node, Box::new(ok)))
            }
            OnboardKind::Join {
                my_name,
                device_name,
                ..
            } => {
                let (my_name, device_name) = (my_name.clone(), device_name.clone());
                self.submit(keys, proof, verified, &my_name, &device_name, false)
                    .await
            }
            OnboardKind::Recover { device_name, .. } => {
                let device_name = device_name.clone();
                self.submit(keys, proof, verified, "", &device_name, true)
                    .await
            }
        }
    }

    async fn submit(
        &mut self,
        keys: MemberKeys,
        proof: CafecaProof,
        verified: Verified,
        my_name: &str,
        device_name: &str,
        recover: bool,
    ) -> Result<OnboardStep> {
        let (ik, ek) = pub_of(&keys);
        let dc = keys.issue_device_cert(&self.device.public(), device_name, now_ms())?;
        let a = JoinApplication {
            v: FORMAT_VERSION,
            proof,
            ik_pub: ik,
            ek_pub: ek,
            device_cert: dc.clone(),
            name: my_name.chars().take(100).collect(),
        };
        let app = if recover {
            Application::Recover(a)
        } else {
            Application::Join(a)
        };
        let state = MailboxClient::join(
            &self.endpoint,
            to_endpoint_addr(&self.mailbox)?,
            self.org_id,
            app,
        )
        .await
        .context("無法送出申請")?;
        match state {
            JoinState::Pending => {
                self.phase = Phase::Done;
                let node = self
                    .start_node(keys, dc, verified.account, MemberStatus::Pending)
                    .await?;
                Ok(OnboardStep::WaitingApproval(node))
            }
            JoinState::AwaitingDevice => {
                // 新裝置：以申請時的 EK 接收本人其他裝置封裝的成員金鑰
                let eph = Ephemeral::from_secret_bytes(&keys.exchange_secret_bytes());
                self.phase = Phase::Device {
                    eph,
                    account: verified.account,
                    handle: verified.handle.clone(),
                };
                Ok(OnboardStep::WaitingDevice {
                    handle: verified.handle,
                })
            }
            JoinState::Rejected | JoinState::Unknown => bail!("申請未被受理"),
        }
    }

    async fn poll_grant(&mut self) -> Result<OnboardStep> {
        let Phase::Device {
            eph,
            account,
            handle,
        } = &self.phase
        else {
            bail!("流程狀態錯誤");
        };
        let device = self.device.public();
        let Some(sealed) = MailboxClient::fetch_device_grant(
            &self.endpoint,
            to_endpoint_addr(&self.mailbox)?,
            self.org_id,
            device,
        )
        .await?
        else {
            return Ok(OnboardStep::WaitingDevice {
                handle: handle.clone(),
            });
        };
        let plain = eph.open_grant(&device, &sealed)?;
        let p: DeviceGrantPayload = hills_proto::decode(&plain)?;
        let member = member_id_for(account);
        if p.account != *account
            || p.member_id != member
            || p.device_cert.body.device_pub != device
            || p.device_cert.body.member_id != member
        {
            bail!("收到的成員金鑰與登入的帳戶不符");
        }
        let keys = MemberKeys::from_secret_bytes(member, &p.ik_secret, &p.ek_secret);
        if p.device_cert.signer.0 != keys.identity_public().to_bytes() {
            bail!("裝置憑證不是由成員金鑰簽發");
        }
        let account = *account;
        let dc = p.device_cert.clone();
        self.phase = Phase::Done;
        let node = self
            .start_node(keys, dc, account, MemberStatus::Active)
            .await?;
        Ok(OnboardStep::Linked(node))
    }

    async fn start_node(
        &self,
        keys: MemberKeys,
        dc: hills_proto::Signed<hills_proto::DeviceCert>,
        account: hills_proto::cafeca::CafecaAccount,
        status: MemberStatus,
    ) -> Result<Node> {
        let device = DeviceKey::from_secret_bytes(&self.device.secret_bytes());
        let member = keys.member_id();
        let secrets = Secrets::new(keys, device)?;
        secrets.save(&self.secret_store)?;
        let cfg = NodeConfig {
            format: FORMAT_VERSION,
            org_root: self.org_root,
            mailbox: self.mailbox.clone(),
            member_id: member,
            device_name: dc.body.device_name.clone(),
            status,
            bundle_cursor: 0,
            keys_cursor: 0,
            storage: vec![],
            cafeca: Some(account),
        };
        cfg.save(&self.dir)?;
        self.endpoint.close().await;
        Node::start(
            &self.dir,
            self.secret_store.clone(),
            cfg,
            secrets,
            Some((TrustStore::new(self.org_root), KeyRing::default(), dc)),
            self.opts.clone(),
        )
        .await
    }

    async fn finish_create(
        &mut self,
        keys: MemberKeys,
        verified: Verified,
    ) -> Result<(Node, OrgRootKey)> {
        let OnboardKind::Create(req) = &self.kind else {
            bail!("流程狀態錯誤");
        };
        let ok = self.ok.take().ok_or_else(|| anyhow!("缺少組織根金鑰"))?;
        let now = now_ms();
        let me = keys.member_id();
        let account = verified.account;
        let mut trust = TrustStore::new(ok.public());
        trust.add_member_cert(ok.issue_first_admin(MemberPublic::of(&keys, account), now)?)?;
        let dc = keys.issue_device_cert(&self.device.public(), &req.device_name, now)?;
        trust.add_device_cert(dc.clone())?;

        // GK、預設小組 TK、本人 PK
        let (_, ek) = pub_of(&keys);
        let mut ring = KeyRing::default();
        let mut wrapped = Vec::new();
        for family in [
            KeyFamily::Org,
            KeyFamily::Team(DEFAULT_TEAM.into()),
            KeyFamily::MemberPrivate(me),
        ] {
            let r = rotate(&ring, &family, &[(me, ek)])?;
            wrapped.extend(r.wrapped);
            ring.insert(r.key_id, r.key);
        }

        let device = DeviceKey::from_secret_bytes(&self.device.secret_bytes());
        let secrets = Secrets::new(keys, device)?;
        secrets.save(&self.secret_store)?;
        self.secret_store
            .set(ORG_ROOT_SECRET, &ok.secret_bytes()[..])?;
        let cfg = NodeConfig {
            format: FORMAT_VERSION,
            org_root: ok.public(),
            mailbox: self.mailbox.clone(),
            member_id: me,
            device_name: req.device_name.clone(),
            status: MemberStatus::Active,
            bundle_cursor: 0,
            keys_cursor: 0,
            storage: vec![],
            cafeca: Some(account),
        };
        cfg.save(&self.dir)?;
        self.endpoint.close().await;
        let node = Node::start(
            &self.dir,
            self.secret_store.clone(),
            cfg,
            secrets,
            Some((trust, ring, dc)),
            self.opts.clone(),
        )
        .await?;
        {
            let inner = &node.inner;
            let mut st = lock(&inner.st);
            for w in wrapped {
                let s = inner.secrets.device.sign_body(w)?;
                st.key_outbox.push(s);
            }
            let caip = account.caip10();
            inner.change_locked(&mut st, "org", |doc| {
                org::init(
                    doc,
                    &NewOrg {
                        name: &req.org_name,
                        timezone: &req.timezone,
                        locale: &req.locale,
                        creator: me,
                        creator_name: &req.my_name,
                        creator_cafeca: &caip,
                        creator_handle: verified.handle.as_deref(),
                        team_id: DEFAULT_TEAM,
                        team_name: &req.team_name,
                        now,
                    },
                )?;
                Ok(())
            })?;
        }
        node.inner.wake.notify_one();
        Ok((node, ok))
    }

    /// 取消：關閉暫時連線（未寫入任何本機資料）。
    pub async fn cancel(self) {
        self.endpoint.close().await;
    }
}
