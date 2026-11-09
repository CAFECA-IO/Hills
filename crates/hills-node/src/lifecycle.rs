//! 組織設定與停用（technical-design §3.7、§16）。建立、加入、還原見 [`crate::onboarding`]（§17）。

use anyhow::{Result, anyhow, bail};
use hills_crypto::rotate;
use hills_identity::cert::OrgRootKey;
use hills_proto::cafeca::CafecaAccount;
use hills_proto::gossip::GossipMsg;
use hills_proto::ticket::{OrgTicket, Ticket};
use hills_proto::{FORMAT_VERSION, KeyFamily, MemberId, Pub32, RevocationTarget};

use crate::config::ORG_ROOT_SECRET;
use crate::node::{Event, Node, lock, now_ms};
use crate::org;

pub const DEFAULT_TEAM: &str = "general";

impl Node {
    /// 本人的 CAFECA 帳戶（§17）。
    pub fn cafeca(&self) -> Option<CafecaAccount> {
        lock(&self.inner.cfg).cafeca
    }

    /// 匯出組織連線碼（加入、新裝置、還原用，§17.1）。
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
            // 只輪替自己持有的小組 TK；其餘由該小組的指定輪替裝置處理（D49，§16.15）
            let mut rotated = Vec::new();
            for t in snap.teams_of(&member) {
                if st.ring.latest(&KeyFamily::Team(t.clone())).is_none() {
                    continue;
                }
                let team = snap.teams[&t].clone();
                let r = recipients(
                    &|m| *m != member && (team.members.contains(m) || team.leads.contains(m)),
                    &st,
                );
                rotated.push(t.clone());
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
            crate::teams::remove_from_rosters(inner, &mut st, &member, &rotated)?;
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
