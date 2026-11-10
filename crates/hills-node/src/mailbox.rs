//! 與 mailbox 的同步迴圈（technical-design §16.1、§16.2、§16.7）。

use std::sync::{Arc, Weak};
use std::time::Duration;

use anyhow::Result;
use hills_crypto::rotate;
use hills_net::mailbox::MailboxClient;
use hills_net::{to_endpoint_addr, to_peer_addr};
use hills_proto::gossip::GossipMsg;
use hills_proto::mailbox::{Hello, JoinState};
use hills_proto::{KeyFamily, PeerAddr};

use crate::config::MemberStatus;
use crate::node::{Event, Inner, SyncStatus, lock};
use crate::{approval, gossip};

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

/// 驗證並收下封裝給我的金鑰；權限由簽署裝置決定。小組金鑰依 §16.15 的接受規則，
/// 目前無法判斷的（名單文件可能比金鑰晚到）暫存稍後重試。
fn accept_keys(inner: &Inner, items: &[hills_proto::mailbox::KeyItem]) -> Result<bool> {
    let mut st = lock(&inner.st);
    let mut changed = false;
    let mut deferred = Vec::new();
    let mut new_teams = Vec::new();
    let snap = inner.org_snapshot(&mut st);
    for it in items {
        let w = &it.wrapped;
        let Ok(signer) = st.trust.verify_device_signed(w) else {
            continue;
        };
        let ok = match &w.body.key_id.family {
            KeyFamily::Org | KeyFamily::MemberAttendance(_) => signer.is_admin(),
            KeyFamily::Team(t) => {
                let ok = crate::teams::team_key_ok(
                    &snap,
                    &st,
                    t,
                    w.body.key_id.epoch,
                    &signer.member_id,
                    signer.is_admin(),
                );
                if !ok && !st.ring.contains(&w.body.key_id) {
                    deferred.push(it.clone());
                }
                ok
            }
            KeyFamily::MemberPrivate(m) | KeyFamily::MemberWorklog(m) => *m == signer.member_id,
            // §14.1 v0.9：只接受對話建立者裝置封裝的對話金鑰
            KeyFamily::Conv(c) | KeyFamily::ConvMeta(c) => {
                crate::conv::creator_of(c) == Some(signer.member_id)
            }
        };
        if !ok || st.ring.contains(&w.body.key_id) {
            continue;
        }
        let first = st.ring.latest(&w.body.key_id.family).is_none();
        if st.ring.accept(&w.body, &inner.secrets.keys).is_ok() {
            changed = true;
            if let (true, KeyFamily::Team(t)) = (first, &w.body.key_id.family) {
                new_teams.push(t.clone());
            }
        }
    }
    if changed {
        inner.persist(&st)?;
    }
    drop(st);
    inner.defer_keys(deferred)?;
    inner.need_catch_up(new_teams)?;
    Ok(changed)
}

/// 重試暫存的小組金鑰，再交接 / 輪替小組金鑰（§16.15）。
fn reconcile_teams(inner: &Inner) -> Result<bool> {
    let retry = inner.take_deferred()?;
    if !retry.is_empty() && accept_keys(inner, &retry)? {
        inner.retry_pending()?;
    }
    let teams = crate::teams::reconcile(inner)?;
    // 工作紀錄金鑰交接給負責人（§16.18，D62）
    let worklog = crate::worklog::reconcile(inner)?;
    Ok(teams || worklog)
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
    let my_devices_before = lock(&inner.st).trust.devices_of(&inner.me()).len();
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
        // 本人的新裝置由其他裝置授權時也通知（§17.6 步驟 5）
        let added: Vec<_> = {
            let st = lock(&inner.st);
            let me = inner.me();
            let this = inner.secrets.device.public();
            let devs = st.trust.devices_of(&me);
            if devs.len() > my_devices_before && my_devices_before > 0 {
                devs.into_iter()
                    .filter(|d| d.device_pub != this)
                    .max_by_key(|d| d.issued_at)
                    .map(|d| (d.device_pub, d.device_name.clone()))
                    .into_iter()
                    .collect()
            } else {
                vec![]
            }
        };
        for (device, name) in added {
            inner.emit(Event::DeviceAdded { device, name });
        }
    }
    // 成員還原後重新封裝我建立的對話金鑰（§17.7）
    if let Err(e) = approval::rewrap_for_recovered(inner) {
        tracing::warn!(error = %e, "無法重新封裝對話金鑰");
    }
    // 我建立的對話中被停用的成員：移出並輪替（§14.1）
    if let Err(e) = inner.prune_revoked_conv_members() {
        tracing::warn!(error = %e, "無法更新對話成員");
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
    // 小組金鑰交接與輪替（D49）：有新的封裝就再上傳一次
    match reconcile_teams(inner) {
        Ok(true) => upload(inner, mb).await?,
        Ok(false) => {}
        Err(e) => tracing::warn!(error = %e, "無法交接小組金鑰"),
    }
    // 剛取得小組金鑰：重新下載該小組加入前的 bundle（當時不是成員而未保留）
    let teams = inner.catch_up_teams()?;
    if !teams.is_empty() {
        let (items, _) = mb.list_all(None, 0).await?;
        for it in &items {
            if matches!(&it.bundle.key_id.family, KeyFamily::Team(t) if teams.contains(t)) {
                inner.ingest_bundle(&it.bundle)?;
            }
        }
        inner.clear_catch_up(&teams)?;
    }
    // mailbox 位址更新（§16.1）：舊版 mailbox 不支援 Info 時略過
    match mb.info().await {
        Ok(addr) => apply_mailbox_addr(inner, addr).await?,
        Err(e) => tracing::debug!(error = %e, "mailbox 不支援 Info"),
    }
    // 儲存節點清單（§15.6 v0.12）：舊版 mailbox 不支援 Services 時略過
    match mb.services().await {
        Ok(list) => inner.apply_services(list).await?,
        Err(e) => tracing::debug!(error = %e, "mailbox 不支援 Services"),
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
    // 本人的新裝置申請（§17.6）
    if let Err(e) = approval::serve_device_requests(inner, mb).await {
        tracing::debug!(error = %e, "無法處理新裝置申請");
    }
    // 管理者：待核准的加入與還原申請
    let admin = lock(&inner.st)
        .trust
        .verify_device(&me)
        .is_ok_and(|v| v.is_admin());
    if admin {
        inner.push_roster_to_storage().await;
        if let Err(e) = approval::refresh_joins(inner, mb).await {
            tracing::debug!(error = %e, "無法讀取加入申請");
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
                if pending {
                    check_rejected(inner).await;
                }
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

/// 等待核准時查詢申請是否被拒絕（§17.6 步驟 5）。
async fn check_rejected(inner: &Inner) {
    if inner.rejected.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let (org_id, addr) = {
        let st = lock(&inner.st);
        let cfg = lock(&inner.cfg);
        (st.trust.org_id(), to_endpoint_addr(&cfg.mailbox))
    };
    let Ok(addr) = addr else { return };
    let device = inner.secrets.device.public();
    if let Ok(JoinState::Rejected) =
        MailboxClient::join_status(&inner.endpoint, addr, org_id, device).await
    {
        inner
            .rejected
            .store(true, std::sync::atomic::Ordering::Relaxed);
        inner.emit(Event::Rejected);
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
