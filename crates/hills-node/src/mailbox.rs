//! 與 mailbox 的同步迴圈（technical-design §16.1、§16.2、§16.7）。

use std::sync::{Arc, Weak};
use std::time::Duration;

use anyhow::{Result, anyhow};
use hills_crypto::exchange::{join_mac, mac_eq};
use hills_crypto::rotate;
use hills_identity::cert::MemberPublic;
use hills_net::mailbox::MailboxClient;
use hills_net::{to_endpoint_addr, to_peer_addr};
use hills_proto::gossip::GossipMsg;
use hills_proto::mailbox::{Hello, PendingJoin};
use hills_proto::{KeyFamily, PeerAddr, Role, Signed, WrappedKey};

use crate::config::MemberStatus;
use crate::node::{Event, Inner, SyncStatus, lock, now_ms};
use crate::{gossip, org};

async fn connect(inner: &Inner) -> Result<MailboxClient> {
    let (hello, org_id, addr) = {
        let st = lock(&inner.st);
        let cfg = lock(&inner.cfg);
        let hello = Hello {
            device_cert: st.my_device_cert.clone(),
            member_cert: st.trust.member_cert(&inner.me()).cloned(),
        };
        (hello, st.trust.org_id(), to_endpoint_addr(&cfg.mailbox)?)
    };
    Ok(MailboxClient::connect(&inner.endpoint, addr, org_id, hello).await?)
}

/// 驗證並收下封裝給我的金鑰；權限規則與 mailbox 相同（簽署裝置決定）。
fn accept_keys(inner: &Inner, items: &[hills_proto::mailbox::KeyItem]) -> Result<bool> {
    let mut st = lock(&inner.st);
    let mut changed = false;
    for it in items {
        let w = &it.wrapped;
        let Ok(signer) = st.trust.verify_device_signed(w) else {
            continue;
        };
        let ok = match &w.body.key_id.family {
            KeyFamily::Org | KeyFamily::Team(_) | KeyFamily::MemberAttendance(_) => {
                signer.is_admin()
            }
            KeyFamily::MemberPrivate(m) => *m == signer.member_id,
            KeyFamily::Conv(_) => true,
        };
        if !ok || st.ring.contains(&w.body.key_id) {
            continue;
        }
        if st.ring.accept(&w.body, &inner.secrets.keys).is_ok() {
            changed = true;
        }
    }
    if changed {
        inner.persist(&st)?;
    }
    Ok(changed)
}

/// 確保自己有私密金鑰（PK），沒有就建立並封裝給自己。
fn ensure_private_key(inner: &Inner) -> Result<()> {
    let mut st = lock(&inner.st);
    let family = KeyFamily::MemberPrivate(inner.me());
    if st.ring.latest(&family).is_some() {
        return Ok(());
    }
    let ek = hills_proto::Pub32(inner.secrets.keys.exchange_public().to_bytes());
    let r = rotate(&st.ring, &family, &[(inner.me(), ek)])?;
    for w in r.wrapped {
        st.key_outbox.push(inner.secrets.device.sign_body(w)?);
    }
    st.ring.insert(r.key_id, r.key);
    inner.persist(&st)
}

async fn upload(inner: &Inner, mb: &MailboxClient) -> Result<()> {
    let keys = lock(&inner.st).key_outbox.clone();
    if !keys.is_empty() {
        mb.put_keys(keys.clone()).await?;
        {
            let mut st = lock(&inner.st);
            st.key_outbox.retain(|k| !keys.contains(k));
            inner.persist(&st)?;
        }
        gossip::broadcast(inner, GossipMsg::KeysChanged).await;
    }
    let bundles = lock(&inner.st).outbox.clone();
    for b in bundles {
        mb.put(b.clone()).await?;
        {
            let mut st = lock(&inner.st);
            st.outbox.retain(|x| x.bundle_hash != b.bundle_hash);
            inner.persist(&st)?;
        }
    }
    Ok(())
}

/// 一次完整的同步：roster、金鑰、上傳、下載、位址簿、管理者工作。
async fn refresh(inner: &Arc<Inner>, mb: &MailboxClient) -> Result<()> {
    // roster
    let roster = mb.get_roster().await?;
    let roster_changed = {
        let mut st = lock(&inner.st);
        let c = st.trust.merge_roster(&roster)?;
        if c {
            inner.persist(&st)?;
        }
        c
    };
    if roster_changed {
        inner.emit(Event::RosterChanged);
    }
    // 金鑰
    let since = lock(&inner.cfg).keys_cursor;
    let (items, next) = mb.fetch_keys(since).await?;
    let keys_changed = accept_keys(inner, &items)?;
    if next != since {
        lock(&inner.cfg).keys_cursor = next;
        inner.save_cfg()?;
    }
    ensure_private_key(inner)?;
    if keys_changed {
        inner.retry_pending()?;
    }
    // 上傳本機變更
    upload(inner, mb).await?;
    // 下載
    let since = lock(&inner.cfg).bundle_cursor;
    let (items, next) = mb.list_all(None, since).await?;
    for it in &items {
        inner.ingest_bundle(&it.bundle)?;
    }
    if next != since {
        lock(&inner.cfg).bundle_cursor = next;
        inner.save_cfg()?;
    }
    // mailbox 位址更新（§16.1）：舊版 mailbox 不支援 Info 時略過
    match mb.info().await {
        Ok(addr) => apply_mailbox_addr(inner, addr).await?,
        Err(e) => tracing::debug!(error = %e, "mailbox 不支援 Info"),
    }
    // 位址簿 → gossip 鄰居
    mb.announce(to_peer_addr(&inner.endpoint.addr())).await?;
    let me = inner.secrets.device.public();
    let mut neighbors = Vec::new();
    for p in mb.peers().await? {
        if p.device == me {
            continue;
        }
        if let Ok(addr) = to_endpoint_addr(&p.addr) {
            inner.memory.add_endpoint_info(addr);
            neighbors.push(p.device);
        }
    }
    gossip::join_peers(inner, neighbors).await;
    // 管理者：處理自己建立的邀請
    let admin = lock(&inner.st)
        .trust
        .verify_device(&me)
        .is_ok_and(|v| v.is_admin());
    if admin {
        let joins = mb.fetch_joins().await?;
        for j in joins {
            if let Err(e) = approve_join(inner, mb, &j).await {
                tracing::debug!(error = %e, "略過加入申請");
            }
        }
    }
    Ok(())
}

/// 依 mailbox 回報的位址更新已存位址；NodeId 不同時忽略。新 relay 直接加入執行中的 endpoint。
pub(crate) async fn apply_mailbox_addr(inner: &Inner, addr: PeerAddr) -> Result<()> {
    let new_relay = {
        let mut cfg = lock(&inner.cfg);
        if addr.node != cfg.mailbox.node || addr == cfg.mailbox {
            return Ok(());
        }
        let new_relay = addr
            .relay
            .clone()
            .filter(|r| cfg.mailbox.relay.as_ref() != Some(r));
        cfg.mailbox = addr.clone();
        new_relay
    };
    inner.save_cfg()?;
    if let Ok(ep) = to_endpoint_addr(&addr) {
        inner.memory.add_endpoint_info(ep);
    }
    tracing::info!(relay = ?addr.relay, "mailbox 位址已更新");
    if let Some(url) = new_relay.and_then(|r| r.parse::<iroh::RelayUrl>().ok()) {
        inner
            .endpoint
            .insert_relay(url.clone(), Arc::new(url.into()))
            .await;
        // 等 relay 連上，讓接下來的 Announce 帶有 relay 位址
        let _ = tokio::time::timeout(Duration::from_secs(5), inner.endpoint.online()).await;
    }
    Ok(())
}

/// 驗證加入申請並核准（technical-design §16.2 步驟 3）。
async fn approve_join(inner: &Arc<Inner>, mb: &MailboxClient, j: &PendingJoin) -> Result<()> {
    let invite_hex = data_encoding::HEXLOWER.encode(&j.invite_id);
    let me = inner.me();
    let (cert, team_ids, req) = {
        let mut st = lock(&inner.st);
        let snap = inner.org_snapshot(&mut st);
        let invite = snap
            .invites
            .get(&invite_hex)
            .ok_or_else(|| anyhow!("找不到邀請"))?;
        if invite.created_by != me
            || invite.used_by.is_some()
            || invite.revoked
            || invite.expires_at < now_ms()
        {
            return Err(anyhow!("不是我建立的有效邀請"));
        }
        let secrets_id = format!("member/{me}/secrets");
        let secret_hex = {
            let local = inner.load_doc(&mut st.docs, &secrets_id)?;
            org::invite_secret(&local.doc, &invite_hex)
                .ok_or_else(|| anyhow!("找不到邀請 secret"))?
        };
        let secret: [u8; 16] = data_encoding::HEXLOWER
            .decode(secret_hex.as_bytes())?
            .try_into()
            .map_err(|_| anyhow!("secret 格式錯誤"))?;
        let req = j.request.clone();
        if !mac_eq(
            &req.mac,
            &join_mac(&secret, &j.invite_id, &req.mac_input()?),
        ) {
            return Err(anyhow!("MAC 不符"));
        }
        let subject = MemberPublic {
            ik_pub: req.ik_pub,
            ek_pub: req.ek_pub,
        };
        let roles = if invite.role == Role::Admin {
            vec![Role::Admin, Role::Member]
        } else {
            vec![Role::Member]
        };
        let cert =
            inner
                .secrets
                .keys
                .issue_member_cert(st.trust.org_id(), subject, roles, now_ms())?;
        if cert.body.member_id != req.device_cert.body.member_id {
            return Err(anyhow!("裝置憑證與成員不符"));
        }
        st.trust.add_member_cert(cert.clone())?;
        st.trust.add_device_cert(req.device_cert.clone())?;
        inner.persist(&st)?;
        (cert, invite.team_ids.clone(), req)
    };
    let new_id = cert.body.member_id;

    // roster → mailbox
    let roster = {
        let st = lock(&inner.st);
        inner
            .secrets
            .device
            .sign_body(st.trust.to_roster(now_ms()))?
    };
    mb.put_roster(roster).await?;

    // 金鑰：GK 全部 epoch、所屬小組 TK 全部 epoch
    let wrapped: Vec<Signed<WrappedKey>> = {
        let st = lock(&inner.st);
        let mut out = Vec::new();
        let mut families = vec![KeyFamily::Org];
        families.extend(team_ids.iter().map(|t| KeyFamily::Team(t.clone())));
        for f in &families {
            for (id, key) in st.ring.epochs(f) {
                let w = hills_crypto::wrap_key(id, key, new_id, &req.ek_pub)?;
                out.push(inner.secrets.device.sign_body(w)?);
            }
        }
        out
    };
    mb.put_keys(wrapped).await?;

    // org 文件：加入成員與小組、標記邀請已使用
    {
        let mut st = lock(&inner.st);
        inner.change_locked(&mut st, "org", |doc| {
            org::add_member(doc, &new_id, &req.name, now_ms())?;
            for t in &team_ids {
                org::add_to_team(doc, t, &new_id)?;
            }
            org::mark_invite_used(doc, &invite_hex, &new_id)?;
            Ok(())
        })?;
    }
    mb.close_invite(j.invite_id).await?;
    upload(inner, mb).await?;
    inner.emit(Event::OrgChanged);
    inner.emit(Event::RosterChanged);
    gossip::broadcast(inner, GossipMsg::RosterChanged).await;
    gossip::broadcast(inner, GossipMsg::KeysChanged).await;
    tracing::info!(member = %new_id, "已核准加入申請");
    Ok(())
}

/// 執行一次同步；必要時先連線。
pub(crate) async fn sync_once(inner: &Arc<Inner>) -> Result<()> {
    let mut guard = inner.mailbox.lock().await;
    if guard.as_ref().is_none_or(|c| c.is_closed()) {
        match connect(inner).await {
            Ok(c) => {
                *guard = Some(c);
                let was_pending = lock(&inner.cfg).status == MemberStatus::Pending;
                if was_pending {
                    lock(&inner.cfg).status = MemberStatus::Active;
                    inner.save_cfg()?;
                    inner.emit(Event::Activated);
                }
            }
            Err(e) => {
                let pending = lock(&inner.cfg).status == MemberStatus::Pending;
                inner.set_status(if pending {
                    SyncStatus::Pending
                } else {
                    SyncStatus::Offline
                });
                return Err(e);
            }
        }
    }
    inner.set_status(SyncStatus::Syncing);
    let Some(mb) = guard.as_ref() else {
        return Ok(());
    };
    match refresh(inner, mb).await {
        Ok(()) => {
            inner.set_status(SyncStatus::Synced);
            Ok(())
        }
        Err(e) => {
            *guard = None;
            inner.set_status(SyncStatus::Offline);
            Err(e)
        }
    }
}

/// 背景迴圈：定期同步，或在本機變更、gossip 通知時立即同步。
pub(crate) async fn run(weak: Weak<Inner>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        let Some(inner) = weak.upgrade() else { return };
        let poll = inner.opts.poll_interval;
        let delay = match sync_once(&inner).await {
            Ok(()) => {
                backoff = Duration::from_secs(1);
                poll
            }
            Err(e) => {
                tracing::debug!(error = %e, "mailbox 同步失敗");
                backoff = (backoff * 2).min(poll);
                backoff
            }
        };
        let wake = async { inner.wake.notified().await };
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = wake => {}
        }
    }
}
