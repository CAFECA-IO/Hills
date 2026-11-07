//! 加入、還原與新裝置申請的處理（technical-design §17.6、§17.7）。
//!
//! - 管理者：驗證 mailbox 暫存的加入 / 還原申請，列為待核准；核准時簽發 MemberCert 並封裝金鑰。
//! - 本人裝置：自動處理本人的新裝置申請，以 HPKE 把 IK / EK 封裝給新裝置。
//! - 對話建立者：成員還原（EK 改變）後，把對話金鑰重新封裝給新 EK。

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use hills_cafeca::{RpcVerifier, Verifier};
use hills_identity::cert::MemberPublic;
use hills_identity::member_id_for;
use hills_net::mailbox::MailboxClient;
use hills_proto::cafeca::{Application, DeviceGrantPayload};
use hills_proto::gossip::GossipMsg;
use hills_proto::mailbox::PendingApplication;
use hills_proto::{FORMAT_VERSION, KeyFamily, MemberId, Pub32, Role, Signed, WrappedKey};
use serde::Serialize;

use crate::lifecycle::DEFAULT_TEAM;
use crate::node::{Event, Inner, Node, lock, now_ms};
use crate::{gossip, org};

/// 已知 EK 的 secret 檔（§17.7）。
pub(crate) const EKS_FILE: &str = "eks";

/// 待核准的申請（管理者畫面）。
#[derive(Debug, Clone, Serialize)]
pub struct JoinView {
    /// 申請裝置（核准 / 拒絕時的識別）
    pub device: Pub32,
    /// `join` 或 `recover`
    pub kind: &'static str,
    pub member: MemberId,
    pub name: String,
    pub device_name: String,
    pub handle: Option<String>,
    /// `0x` 開頭的帳戶地址
    pub account: String,
    pub account_short: String,
    pub received_at: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingJoin {
    pub view: JoinView,
    pub app: PendingApplication,
}

/// 取得（必要時建立）CAFECA 驗證器。
pub(crate) async fn verifier(inner: &Inner, mb: &MailboxClient) -> Result<Arc<Verifier>> {
    let mut g = inner.cafeca.lock().await;
    if let Some(v) = g.as_ref() {
        return Ok(v.clone());
    }
    let cfg = mb.server_config().await?;
    if cfg.cafeca_wallet.is_empty() {
        bail!("mailbox 尚未設定 CAFECA 錢包");
    }
    let v = Arc::new(Verifier::Rpc(RpcVerifier::new(&cfg.cafeca_wallet, None)?));
    *g = Some(v.clone());
    Ok(v)
}

fn secs(ms: i64) -> u64 {
    (ms.max(0) / 1000) as u64
}

/// 管理者：讀取並驗證待核准的申請。
pub(crate) async fn refresh_joins(inner: &Arc<Inner>, mb: &MailboxClient) -> Result<()> {
    let apps = mb.fetch_joins().await?;
    let v = verifier(inner, mb).await?;
    let mut out = Vec::new();
    for p in apps {
        let (a, kind) = match &p.application {
            Application::Join(a) => (a, "join"),
            Application::Recover(a) => (a, "recover"),
            Application::Device(_) => continue,
        };
        let org_id = lock(&inner.st).trust.org_id();
        if !p.application.binding_consistent(&org_id) {
            continue;
        }
        let verified = match v.verify(&a.proof, secs(p.received_at)).await {
            Ok(x) => x,
            Err(e) => {
                tracing::info!(error = %e, "略過登入證明無效的申請");
                continue;
            }
        };
        let member = member_id_for(&verified.account);
        if a.device_cert.body.member_id != member {
            continue;
        }
        out.push(PendingJoin {
            view: JoinView {
                device: a.device_cert.body.device_pub,
                kind,
                member,
                name: a.name.clone(),
                device_name: a.device_cert.body.device_name.clone(),
                handle: verified.handle.or(p.handle.clone()),
                account: verified.account.address_hex(),
                account_short: verified.account.short(),
                received_at: p.received_at,
            },
            app: p,
        });
    }
    let changed = {
        let mut j = lock(&inner.joins);
        let old: Vec<Pub32> = j.iter().map(|p| p.view.device).collect();
        let new: Vec<Pub32> = out.iter().map(|p| p.view.device).collect();
        *j = out;
        old != new
    };
    if changed {
        inner.emit(Event::JoinsChanged);
    }
    Ok(())
}

/// 本人裝置：處理本人的新裝置申請（自動授權，§17.6 步驟 3）。
pub(crate) async fn serve_device_requests(inner: &Arc<Inner>, mb: &MailboxClient) -> Result<()> {
    let reqs = mb.fetch_device_requests().await?;
    if reqs.is_empty() {
        return Ok(());
    }
    let v = verifier(inner, mb).await?;
    let me = inner.me();
    let account = lock(&inner.cfg)
        .cafeca
        .ok_or_else(|| anyhow!("缺少本人的 CAFECA 帳戶"))?;
    for p in reqs {
        let Application::Device(a) = &p.application else {
            continue;
        };
        let org_id = lock(&inner.st).trust.org_id();
        if !p.application.binding_consistent(&org_id) {
            continue;
        }
        let verified = match v.verify(&a.proof, secs(p.received_at)).await {
            Ok(x) => x,
            Err(e) => {
                tracing::info!(error = %e, "略過登入證明無效的新裝置申請");
                continue;
            }
        };
        if verified.account != account || member_id_for(&verified.account) != me {
            continue;
        }
        let name: String = a.name.chars().take(60).collect();
        let cert = inner
            .secrets
            .keys
            .issue_device_cert(&a.device_pub, &name, now_ms())?;
        mb.put_device(cert.clone()).await?;
        let payload = DeviceGrantPayload {
            v: FORMAT_VERSION,
            member_id: me,
            account,
            device_cert: cert.clone(),
            ik_secret: *inner.secrets.keys.identity_secret_bytes(),
            ek_secret: *inner.secrets.keys.exchange_secret_bytes(),
        };
        let plain = zeroize::Zeroizing::new(hills_proto::encode(&payload)?);
        let sealed = hills_crypto::exchange::seal_grant(&a.eph_pub, &a.device_pub, &plain)?;
        mb.put_device_grant(a.device_pub, sealed).await?;
        {
            let mut st = lock(&inner.st);
            st.trust.add_device_cert(cert)?;
            inner.persist(&st)?;
        }
        tracing::info!("已授權本人的新裝置");
        inner.emit(Event::DeviceAdded {
            device: a.device_pub,
            name,
        });
        inner.emit(Event::RosterChanged);
        gossip::broadcast(inner, GossipMsg::RosterChanged).await;
    }
    Ok(())
}

/// 對話建立者：成員 EK 改變（還原）後，重新封裝我建立的對話的金鑰（§17.7）。
pub(crate) fn rewrap_for_recovered(inner: &Inner) -> Result<()> {
    let me = inner.me();
    let mut st = lock(&inner.st);
    let current: HashMap<MemberId, Pub32> = st
        .trust
        .active_members()
        .into_iter()
        .map(|c| (c.member_id, c.ek_pub))
        .collect();
    let changed: Vec<(MemberId, Pub32)> = {
        let known = lock(&inner.known_eks);
        current
            .iter()
            .filter(|(m, ek)| known.get(*m).is_some_and(|k| k != *ek))
            .map(|(m, ek)| (*m, *ek))
            .collect()
    };
    if !changed.is_empty() {
        let convs: Vec<_> = st
            .convs
            .values()
            .filter(|c| c.creator == me)
            .cloned()
            .collect();
        for (member, ek) in &changed {
            if *member == me {
                continue;
            }
            for c in convs.iter().filter(|c| c.members.contains(member)) {
                let from = c.joined.get(member).copied().unwrap_or(1);
                let mut out = Vec::new();
                for (id, key) in st.ring.epochs(&KeyFamily::Conv(c.id.clone())) {
                    if id.epoch >= from {
                        out.push(hills_crypto::wrap_key(id, key, *member, ek)?);
                    }
                }
                for (id, key) in st.ring.epochs(&KeyFamily::ConvMeta(c.id.clone())) {
                    out.push(hills_crypto::wrap_key(id, key, *member, ek)?);
                }
                for w in out {
                    let s = inner.secrets.device.sign_body(w)?;
                    st.key_outbox.push(s);
                }
            }
        }
        inner.persist(&st)?;
    }
    drop(st);
    let mut known = lock(&inner.known_eks);
    if *known != current {
        *known = current;
        let raw = postcard::to_allocvec(&*known)?;
        inner.store.write_secret_file(EKS_FILE, &raw)?;
    }
    Ok(())
}

fn wrap_families(
    st: &crate::node::State,
    families: &[KeyFamily],
    member: MemberId,
    ek: &Pub32,
) -> Result<Vec<WrappedKey>> {
    let mut out = Vec::new();
    for f in families {
        for (id, key) in st.ring.epochs(f) {
            out.push(hills_crypto::wrap_key(id, key, member, ek)?);
        }
    }
    Ok(out)
}

impl Node {
    /// 待核准的加入與還原申請（管理者）。
    pub fn pending_joins(&self) -> Vec<JoinView> {
        lock(&self.inner.joins)
            .iter()
            .map(|p| p.view.clone())
            .collect()
    }

    /// 核准申請（§17.6 步驟 4、§17.7）。`admin` 與 `teams` 只用於加入；還原沿用原角色與小組。
    pub async fn approve_join(&self, device: Pub32, admin: bool, teams: Vec<String>) -> Result<()> {
        let inner = &self.inner;
        if !self.is_admin() {
            bail!("只有管理者可以核准申請");
        }
        let pending = lock(&inner.joins)
            .iter()
            .find(|p| p.view.device == device)
            .cloned()
            .ok_or_else(|| anyhow!("找不到這筆申請，可能已處理"))?;
        let (a, recover) = match &pending.app.application {
            Application::Join(a) => (a.clone(), false),
            Application::Recover(a) => (a.clone(), true),
            Application::Device(_) => bail!("新裝置申請不需管理者核准"),
        };
        let account = a.proof.account;
        let member = member_id_for(&account);
        let me = self.member_id();
        let teams = if recover {
            vec![]
        } else if teams.is_empty() {
            vec![DEFAULT_TEAM.to_owned()]
        } else {
            teams
        };
        let wrapped: Vec<Signed<WrappedKey>> = {
            let mut st = lock(&inner.st);
            let roles = if recover {
                st.trust
                    .member(&member)
                    .map(|c| c.roles.clone())
                    .ok_or_else(|| anyhow!("還原的成員不存在"))?
            } else if admin {
                vec![Role::Admin, Role::Member]
            } else {
                vec![Role::Member]
            };
            if !recover && st.trust.is_active_member(&member) {
                bail!("此 CAFECA 帳戶已是成員");
            }
            let subject = MemberPublic {
                cafeca: account,
                ik_pub: a.ik_pub,
                ek_pub: a.ek_pub,
            };
            let cert = inner.secrets.keys.issue_member_cert(
                st.trust.org_id(),
                subject,
                roles,
                now_ms(),
            )?;
            st.trust.add_member_cert(cert)?;
            st.trust.add_device_cert(a.device_cert.clone())?;
            inner.persist(&st)?;
            // GK 與小組 TK（含歷史 epoch）；還原另含該成員的 AK
            let snap = inner.org_snapshot(&mut st);
            let mut families = vec![KeyFamily::Org];
            let team_ids = if recover {
                snap.teams_of(&member)
            } else {
                teams.clone()
            };
            families.extend(team_ids.into_iter().map(KeyFamily::Team));
            if recover {
                families.push(KeyFamily::MemberAttendance(member));
            }
            wrap_families(&st, &families, member, &a.ek_pub)?
                .into_iter()
                .map(|w| inner.secrets.device.sign_body(w))
                .collect::<Result<_, _>>()?
        };
        let g = self.mailbox_guard().await?;
        let mb = g.as_ref().ok_or_else(|| anyhow!("mailbox"))?;
        let roster = {
            let st = lock(&inner.st);
            inner
                .secrets
                .device
                .sign_body(st.trust.to_roster(now_ms()))?
        };
        mb.put_roster(roster).await?;
        mb.put_keys(wrapped).await?;
        if !recover {
            let mut st = lock(&inner.st);
            let handle = pending.view.handle.clone();
            inner.change_locked(&mut st, "org", |doc| {
                org::add_member(
                    doc,
                    &org::NewMember {
                        id: member,
                        name: &a.name,
                        cafeca: &account.caip10(),
                        handle: handle.as_deref(),
                        approved_by: Some(me),
                        now: now_ms(),
                    },
                )?;
                for t in &teams {
                    org::add_to_team(doc, t, &member)?;
                }
                Ok(())
            })?;
        }
        mb.resolve_join(device, true).await?;
        lock(&inner.joins).retain(|p| p.view.device != device);
        drop(g);
        inner.wake.notify_one();
        inner.emit(Event::JoinsChanged);
        inner.emit(Event::OrgChanged);
        inner.emit(Event::RosterChanged);
        gossip::broadcast(inner, GossipMsg::RosterChanged).await;
        gossip::broadcast(inner, GossipMsg::KeysChanged).await;
        tracing::info!(member = %member, recover, "已核准申請");
        Ok(())
    }

    /// 拒絕申請。
    pub async fn reject_join(&self, device: Pub32) -> Result<()> {
        if !self.is_admin() {
            bail!("只有管理者可以處理申請");
        }
        {
            let g = self.mailbox_guard().await?;
            g.as_ref()
                .ok_or_else(|| anyhow!("mailbox"))?
                .resolve_join(device, false)
                .await?;
        }
        lock(&self.inner.joins).retain(|p| p.view.device != device);
        self.inner.emit(Event::JoinsChanged);
        Ok(())
    }
}
