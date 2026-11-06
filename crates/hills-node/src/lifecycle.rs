//! 組織生命週期：建立、加入、復原、邀請、停用（technical-design §3.3、§3.7、§16.2、§16.4）。

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use hills_crypto::exchange::join_mac;
use hills_crypto::{KeyRing, rotate};
use hills_identity::cert::{OrgRootKey, org_id_for};
use hills_identity::secret_store::SecretStore;
use hills_identity::trust::TrustStore;
use hills_identity::{PhraseLanguage, RecoveryPhrase};
use hills_net::mailbox::MailboxClient;
use hills_net::to_endpoint_addr;
use hills_proto::gossip::GossipMsg;
use hills_proto::ticket::{InviteTicket, MailboxTicket, OrgTicket, Ticket};
use hills_proto::{
    FORMAT_VERSION, JoinRequest, KeyFamily, MemberId, Pub32, RevocationTarget, Role,
};

use crate::config::{MemberStatus, NodeConfig, ORG_ROOT_SECRET, Secrets};
use crate::node::{Event, Node, NodeOptions, lock, now_ms};
use crate::org::{self, InviteRec, NewOrg};

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

pub const DEFAULT_TEAM: &str = "general";

fn pub_of(keys: &hills_identity::MemberKeys) -> (Pub32, Pub32) {
    (
        Pub32(keys.identity_public().to_bytes()),
        Pub32(keys.exchange_public().to_bytes()),
    )
}

fn ensure_empty(dir: &Path) -> Result<()> {
    if NodeConfig::load(dir)?.is_some() {
        bail!("此裝置已加入組織");
    }
    Ok(())
}

impl Node {
    /// 建立組織（technical-design §3.3）。回傳組織根金鑰，呼叫端應引導使用者匯出備份。
    pub async fn create_org(
        dir: &Path,
        secret_store: Arc<dyn SecretStore>,
        req: CreateOrg,
        opts: NodeOptions,
    ) -> Result<(Self, OrgRootKey)> {
        ensure_empty(dir)?;
        let mailbox = MailboxTicket::from_code(&req.mailbox_code)
            .context("mailbox 連線碼無效")?
            .mailbox;
        let secrets = Secrets::fresh(RecoveryPhrase::generate()?)?;
        let ok = OrgRootKey::generate()?;
        let now = now_ms();
        let me = secrets.keys.member_id();

        let mut trust = TrustStore::new(ok.public());
        trust.add_member_cert(ok.issue_first_admin(&secrets.keys, now)?)?;
        let dc = secrets
            .keys
            .issue_device_cert(&secrets.device.public(), &req.device_name, now)?;
        trust.add_device_cert(dc.clone())?;

        // GK、預設小組 TK、本人 PK
        let (_, ek) = pub_of(&secrets.keys);
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

        secrets.save(&secret_store)?;
        secret_store.set(ORG_ROOT_SECRET, &ok.secret_bytes()[..])?;
        let cfg = NodeConfig {
            org_root: ok.public(),
            mailbox,
            member_id: me,
            device_name: req.device_name.clone(),
            status: MemberStatus::Active,
            bundle_cursor: 0,
            keys_cursor: 0,
            storage: vec![],
        };
        cfg.save(dir)?;
        let node = Self::start(
            dir,
            secret_store,
            cfg,
            secrets,
            Some((trust, ring, dc)),
            opts,
        )
        .await?;
        {
            let inner = &node.inner;
            let mut st = lock(&inner.st);
            for w in wrapped {
                let s = inner.secrets.device.sign_body(w)?;
                st.key_outbox.push(s);
            }
            inner.change_locked(&mut st, "org", |doc| {
                org::init(
                    doc,
                    &NewOrg {
                        name: &req.org_name,
                        timezone: &req.timezone,
                        locale: &req.locale,
                        creator: me,
                        creator_name: &req.my_name,
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

    /// 以邀請碼加入（technical-design §16.2）。送出申請後狀態為 Pending，核准後自動轉為 Active。
    pub async fn join(
        dir: &Path,
        secret_store: Arc<dyn SecretStore>,
        invite_code: &str,
        my_name: &str,
        device_name: &str,
        opts: NodeOptions,
    ) -> Result<Self> {
        ensure_empty(dir)?;
        let t = InviteTicket::from_code(invite_code).context("邀請碼無效")?;
        let secrets = Secrets::fresh(RecoveryPhrase::generate()?)?;
        let now = now_ms();
        let dc = secrets
            .keys
            .issue_device_cert(&secrets.device.public(), device_name, now)?;
        let (ik, ek) = pub_of(&secrets.keys);
        let mut req = JoinRequest {
            v: FORMAT_VERSION,
            ik_pub: ik,
            ek_pub: ek,
            device_cert: dc.clone(),
            name: my_name.chars().take(100).collect(),
            mac: [0; 32],
        };
        req.mac = join_mac(&t.secret, &t.invite_id, &req.mac_input()?);

        secrets.save(&secret_store)?;
        let cfg = NodeConfig {
            org_root: t.org_root,
            mailbox: t.mailbox.clone(),
            member_id: secrets.keys.member_id(),
            device_name: device_name.to_owned(),
            status: MemberStatus::Pending,
            bundle_cursor: 0,
            keys_cursor: 0,
            storage: vec![],
        };
        cfg.save(dir)?;
        let node = Self::start(
            dir,
            secret_store,
            cfg,
            secrets,
            Some((TrustStore::new(t.org_root), KeyRing::default(), dc)),
            opts,
        )
        .await?;
        MailboxClient::join(
            &node.inner.endpoint,
            to_endpoint_addr(&t.mailbox)?,
            org_id_for(&t.org_root),
            t.invite_id,
            req,
        )
        .await
        .context("無法送出加入申請")?;
        Ok(node)
    }

    /// 以復原詞與組織連線碼還原（technical-design §16.4）。
    pub async fn recover(
        dir: &Path,
        secret_store: Arc<dyn SecretStore>,
        words: &str,
        org_code: &str,
        device_name: &str,
        opts: NodeOptions,
    ) -> Result<Self> {
        ensure_empty(dir)?;
        let t = OrgTicket::from_code(org_code).context("組織連線碼無效")?;
        let secrets = Secrets::fresh(RecoveryPhrase::parse(words)?)?;
        let dc = secrets
            .keys
            .issue_device_cert(&secrets.device.public(), device_name, now_ms())?;
        secrets.save(&secret_store)?;
        let cfg = NodeConfig {
            org_root: t.org_root,
            mailbox: t.mailbox,
            member_id: secrets.keys.member_id(),
            device_name: device_name.to_owned(),
            status: MemberStatus::Active,
            bundle_cursor: 0,
            keys_cursor: 0,
            storage: vec![],
        };
        cfg.save(dir)?;
        Self::start(
            dir,
            secret_store,
            cfg,
            secrets,
            Some((TrustStore::new(t.org_root), KeyRing::default(), dc)),
            opts,
        )
        .await
    }

    /// 以介面語言顯示復原詞（D38）。
    pub fn recovery_words(&self, lang: PhraseLanguage) -> Vec<String> {
        self.inner.secrets.phrase.words(lang).to_vec()
    }

    /// 匯出組織連線碼（復原、裝置綁定用）。
    pub fn org_ticket(&self) -> Result<String> {
        let cfg = lock(&self.inner.cfg);
        Ok(OrgTicket {
            v: FORMAT_VERSION,
            org_root: cfg.org_root,
            mailbox: cfg.mailbox.clone(),
        }
        .to_code()?)
    }

    /// 以密碼匯出組織根金鑰備份（僅建立者裝置有 OK）。
    pub fn export_org_root_backup(&self, password: &str) -> Result<Vec<u8>> {
        let raw = self
            .inner
            .secret_store
            .get(ORG_ROOT_SECRET)?
            .ok_or_else(|| anyhow!("此裝置沒有組織根金鑰"))?;
        let arr: [u8; 32] = raw
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("組織根金鑰格式錯誤"))?;
        Ok(OrgRootKey::from_secret_bytes(&arr).export_backup(password)?)
    }

    /// 管理者建立邀請，回傳邀請碼（technical-design §16.2 步驟 1）。
    pub async fn create_invite(&self, role: Role, team_ids: Vec<String>) -> Result<String> {
        let inner = &self.inner;
        let mut invite_id = [0u8; 8];
        let mut secret = [0u8; 16];
        getrandom::fill(&mut invite_id).map_err(|_| anyhow!("無法取得亂數"))?;
        getrandom::fill(&mut secret).map_err(|_| anyhow!("無法取得亂數"))?;
        let id_hex = data_encoding::HEXLOWER.encode(&invite_id);
        let expires_at = now_ms() + inner.opts.invite_ttl.as_millis() as i64;
        let me = self.member_id();
        let team_ids = if team_ids.is_empty() {
            vec![DEFAULT_TEAM.to_owned()]
        } else {
            team_ids
        };
        {
            let mut st = lock(&inner.st);
            let secrets_doc = format!("member/{me}/secrets");
            let secret_hex = data_encoding::HEXLOWER.encode(&secret);
            inner.change_locked(&mut st, &secrets_doc, |doc| {
                Ok(org::put_invite_secret(doc, &id_hex, &secret_hex)?)
            })?;
            let rec = InviteRec {
                secret_hash: data_encoding::HEXLOWER.encode(blake3::hash(&secret).as_bytes()),
                role,
                team_ids,
                expires_at,
                created_by: me,
                used_by: None,
                revoked: false,
            };
            inner.change_locked(&mut st, "org", |doc| {
                Ok(org::add_invite(doc, &id_hex, &rec)?)
            })?;
        }
        inner.emit(Event::OrgChanged);
        {
            let g = self.mailbox_guard().await?;
            g.as_ref()
                .ok_or_else(|| anyhow!("mailbox"))?
                .register_invite(invite_id, expires_at)
                .await?;
        }
        inner.wake.notify_one();
        let cfg = lock(&inner.cfg);
        Ok(InviteTicket {
            v: FORMAT_VERSION,
            org_root: cfg.org_root,
            invite_id,
            secret,
            mailbox: cfg.mailbox.clone(),
        }
        .to_code()?)
    }

    /// 管理者修改組織名稱。
    pub async fn rename_org(&self, name: &str) -> Result<()> {
        let name = name.trim().to_owned();
        if name.is_empty() {
            bail!("名稱不可空白");
        }
        self.change("org", |doc| Ok(org::rename(doc, &name)?)).await
    }

    /// 管理者新增或改名辦公室（D40）；`id` 為空時新增。回傳辦公室 ID。
    pub async fn upsert_office(&self, id: Option<&str>, name: &str) -> Result<String> {
        let name = name.trim().to_owned();
        if name.is_empty() || name.chars().count() > 40 {
            bail!("辦公室名稱需為 1–40 字");
        }
        if !self.is_admin() {
            bail!("只有管理者可以設定辦公室");
        }
        let id = match id {
            Some(i) if !i.is_empty() => i.to_owned(),
            _ => crate::conv::ulid(crate::node::now_ms())?,
        };
        self.change("org", |doc| Ok(org::upsert_office(doc, &id, &name)?))
            .await?;
        Ok(id)
    }

    pub async fn remove_office(&self, id: &str) -> Result<()> {
        if !self.is_admin() {
            bail!("只有管理者可以設定辦公室");
        }
        self.change("org", |doc| Ok(org::remove_office(doc, id)?))
            .await
    }

    /// 管理者設定午休時段（`HH:MM`）；兩者皆空時清除。
    pub async fn set_lunch_break(&self, start: &str, end: &str) -> Result<()> {
        if !self.is_admin() {
            bail!("只有管理者可以設定午休時段");
        }
        let lunch = if start.is_empty() && end.is_empty() {
            None
        } else {
            if !org::valid_hhmm(start) || !org::valid_hhmm(end) || start >= end {
                bail!("午休時段格式需為 HH:MM，且結束晚於開始");
            }
            Some(org::LunchBreak {
                start: start.to_owned(),
                end: end.to_owned(),
            })
        };
        self.change("org", |doc| Ok(org::set_lunch_break(doc, lunch.as_ref())?))
            .await
    }

    /// 管理者停用成員：撤銷、輪替 GK 與其所屬小組 TK、從 org 文件移除（technical-design §3.7）。
    pub async fn revoke_member(&self, member: MemberId) -> Result<()> {
        let inner = &self.inner;
        if member == self.member_id() {
            bail!("不能停用自己");
        }
        let rev = {
            let st = lock(&inner.st);
            inner.secrets.keys.issue_revocation(
                st.trust.org_id(),
                RevocationTarget::Member(member),
                "停用",
                now_ms(),
            )?
        };
        {
            let g = self.mailbox_guard().await?;
            g.as_ref()
                .ok_or_else(|| anyhow!("mailbox"))?
                .put_revocation(rev.clone())
                .await?;
        }
        {
            let mut st = lock(&inner.st);
            st.trust.add_revocation(&rev)?;
            let snap = inner.org_snapshot(&mut st);
            let recipients = |filter: &dyn Fn(&MemberId) -> bool,
                              st: &crate::node::State|
             -> Vec<(MemberId, Pub32)> {
                st.trust
                    .active_members()
                    .into_iter()
                    .filter(|c| filter(&c.member_id))
                    .map(|c| (c.member_id, c.ek_pub))
                    .collect()
            };
            let mut rotations = vec![(KeyFamily::Org, recipients(&|_| true, &st))];
            for t in snap.teams_of(&member) {
                let team = snap.teams[&t].clone();
                let r = recipients(&|m| team.members.contains(m) || team.leads.contains(m), &st);
                rotations.push((KeyFamily::Team(t), r));
            }
            for (family, to) in rotations {
                let r = rotate(&st.ring, &family, &to)?;
                for w in r.wrapped {
                    let s = inner.secrets.device.sign_body(w)?;
                    st.key_outbox.push(s);
                }
                st.ring.insert(r.key_id, r.key);
            }
            inner.persist(&st)?;
            // 用新 epoch 寫入 org 文件
            inner.change_locked(&mut st, "org", |doc| {
                Ok(org::remove_member(doc, &member, now_ms())?)
            })?;
        }
        inner.emit(Event::OrgChanged);
        inner.emit(Event::RosterChanged);
        inner.wake.notify_one();
        crate::gossip::broadcast(inner, GossipMsg::RosterChanged).await;
        Ok(())
    }

    /// 撤銷自己的某台裝置（或管理者撤銷任何裝置）。
    pub async fn revoke_device(&self, device: Pub32) -> Result<()> {
        let inner = &self.inner;
        if device == self.device() {
            bail!("不能撤銷正在使用的裝置");
        }
        let rev = {
            let st = lock(&inner.st);
            inner.secrets.keys.issue_revocation(
                st.trust.org_id(),
                RevocationTarget::Device(device),
                "撤銷裝置",
                now_ms(),
            )?
        };
        {
            let g = self.mailbox_guard().await?;
            g.as_ref()
                .ok_or_else(|| anyhow!("mailbox"))?
                .put_revocation(rev.clone())
                .await?;
        }
        {
            let mut st = lock(&inner.st);
            st.trust.add_revocation(&rev)?;
            inner.persist(&st)?;
        }
        inner.emit(Event::RosterChanged);
        crate::gossip::broadcast(inner, GossipMsg::RosterChanged).await;
        Ok(())
    }

    /// 本人有效的裝置。
    pub fn devices(&self) -> Vec<DeviceView> {
        let st = lock(&self.inner.st);
        let me = self.member_id();
        let this = self.device();
        st.trust
            .devices_of(&me)
            .into_iter()
            .map(|d| DeviceView {
                device: d.device_pub,
                name: d.device_name.clone(),
                issued_at: d.issued_at,
                this_device: d.device_pub == this,
            })
            .collect()
    }

    /// 成員與其角色（來自 roster）。
    pub fn member_roles(&self) -> Vec<(MemberId, bool)> {
        let st = lock(&self.inner.st);
        st.trust
            .active_members()
            .into_iter()
            .map(|c| (c.member_id, c.is_admin()))
            .collect()
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceView {
    pub device: Pub32,
    pub name: String,
    pub issued_at: i64,
    pub this_device: bool,
}
