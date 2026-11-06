//! Gossip 與 Presence（technical-design §16.6、§5.1）。

use std::sync::{Arc, Weak};
use std::time::Instant;

use bytes::Bytes;
use hills_crypto::exchange::{open_gossip, seal_gossip};
use hills_proto::gossip::{GossipEnvelope, GossipMsg, MAX_MESSAGE, TOPIC_PREFIX};
use hills_proto::{KeyFamily, Pub32};
use iroh::PublicKey;
use iroh_gossip::TopicId;
use iroh_gossip::api::Event as GossipEvent;
use n0_future::StreamExt;

use crate::node::{Event, Inner, lock, now_ms};
use crate::policy;

pub(crate) fn topic(inner: &Inner) -> TopicId {
    let org_id = lock(&inner.st).trust.org_id();
    let mut h = blake3::Hasher::new();
    h.update(TOPIC_PREFIX);
    h.update(&org_id.0);
    TopicId::from_bytes(*h.finalize().as_bytes())
}

/// 簽章、以 GK 加密後廣播。尚未加入 gossip 或沒有 GK 時略過。
pub(crate) async fn broadcast(inner: &Inner, msg: GossipMsg) {
    let bytes = {
        let st = lock(&inner.st);
        let Some((id, key)) = st.ring.latest(&KeyFamily::Org) else {
            return;
        };
        let Ok(signed) = inner.secrets.device.sign_body(msg) else {
            return;
        };
        match seal_gossip(id, key, &signed).and_then(|env| Ok(hills_proto::encode(&env)?)) {
            Ok(b) => b,
            Err(_) => return,
        }
    };
    if let Some(tx) = inner.gossip_tx.lock().await.as_ref() {
        let _ = tx.broadcast(Bytes::from(bytes)).await;
    }
}

/// 加入新的 gossip 鄰居（來自 mailbox 位址簿）。
pub(crate) async fn join_peers(inner: &Inner, peers: Vec<Pub32>) {
    let ids: Vec<PublicKey> = peers
        .iter()
        .filter_map(|p| PublicKey::from_bytes(&p.0).ok())
        .collect();
    if ids.is_empty() {
        return;
    }
    if let Some(tx) = inner.gossip_tx.lock().await.as_ref() {
        let _ = tx.join_peers(ids).await;
    }
}

fn handle(inner: &Arc<Inner>, content: &[u8]) {
    if content.len() > MAX_MESSAGE {
        return;
    }
    let Ok(env) = hills_proto::decode::<GossipEnvelope>(content) else {
        return;
    };
    let (signed, who) = {
        let st = lock(&inner.st);
        let Ok(signed) = open_gossip(&env, &st.ring) else {
            return;
        };
        let Ok(who) = st.trust.verify_device_signed(&signed) else {
            return;
        };
        (signed, who)
    };
    match signed.body {
        GossipMsg::Presence(p) if p.member == who.member_id => {
            lock(&inner.presence).insert(p.member, (p, Instant::now()));
            inner.emit(Event::PresenceChanged);
        }
        GossipMsg::Heads { doc_id, heads } => {
            let wanted = {
                let mut st = lock(&inner.st);
                let dir = inner.org_snapshot(&mut st);
                let me = st.trust.verify_device(&inner.secrets.device.public());
                me.is_ok_and(|me| policy::can_read(&doc_id, &me, &dir))
                    && inner
                        .load_doc(&mut st.docs, &doc_id)
                        .is_ok_and(|l| l.missing_any(&heads))
            };
            if wanted {
                let inner = inner.clone();
                tokio::spawn(async move {
                    if let Err(e) = crate::syncproto::pull(&inner, signed.signer, &doc_id).await {
                        tracing::debug!(error = %e, "pull 失敗，等待 mailbox 補同步");
                        inner.wake.notify_one();
                    }
                });
            }
        }
        GossipMsg::RosterChanged | GossipMsg::KeysChanged => inner.wake.notify_one(),
        _ => {}
    }
}

/// 訂閱組織 gossip topic 並處理收到的訊息。
pub(crate) async fn run(weak: Weak<Inner>) {
    let Some(inner) = weak.upgrade() else { return };
    let topic = topic(&inner);
    let Ok(sub) = inner.gossip.subscribe(topic, vec![]).await else {
        tracing::warn!("無法訂閱 gossip topic");
        return;
    };
    let (tx, mut rx) = sub.split();
    *inner.gossip_tx.lock().await = Some(tx);
    drop(inner);
    while let Some(ev) = rx.next().await {
        let Some(inner) = weak.upgrade() else { return };
        match ev {
            Ok(GossipEvent::Received(msg)) => handle(&inner, &msg.content),
            Ok(GossipEvent::NeighborUp(_)) => {
                // 新鄰居：送出自己的狀態，讓對方立即看到
                let p = lock(&inner.my_presence).clone();
                broadcast(
                    &inner,
                    GossipMsg::Presence(hills_proto::gossip::Presence { at: now_ms(), ..p }),
                )
                .await;
            }
            Ok(_) => {}
            Err(_) => return,
        }
    }
}

/// 定期廣播自己的狀態，並移除逾時未更新的成員。
pub(crate) async fn presence_loop(weak: Weak<Inner>) {
    loop {
        let Some(inner) = weak.upgrade() else { return };
        let interval = inner.opts.presence_interval;
        let timeout = inner.opts.presence_timeout;
        let (p, expired) = {
            let mut p = lock(&inner.my_presence);
            let now = now_ms();
            let expired = expire(&mut p, now);
            p.at = now;
            (p.clone(), expired)
        };
        if expired {
            inner.emit(Event::PresenceChanged);
        }
        let me = p.member;
        lock(&inner.presence).insert(me, (p.clone(), Instant::now()));
        broadcast(&inner, GossipMsg::Presence(p)).await;
        let removed = {
            let mut map = lock(&inner.presence);
            let before = map.len();
            map.retain(|m, (_, seen)| *m == me || seen.elapsed() < timeout);
            before != map.len()
        };
        if removed {
            inner.emit(Event::PresenceChanged);
        }
        drop(inner);
        tokio::time::sleep(interval).await;
    }
}

/// 回來時間已到：會議、午休、暫離、專注、忙碌、休假回到上線（technical-design §5.1 v0.11）。
pub(crate) fn expire(p: &mut hills_proto::gossip::Presence, now: hills_proto::Timestamp) -> bool {
    use hills_proto::gossip::PresenceState;
    match p.until {
        Some(u) if u <= now => {
            p.until = None;
            if p.state != PresenceState::Offline {
                p.state = PresenceState::Online;
            }
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use hills_proto::MemberId;
    use hills_proto::gossip::{Location, Presence, PresenceState};

    #[test]
    fn until_expires_back_to_online() {
        let mut p = Presence {
            member: MemberId([1; 16]),
            state: PresenceState::Lunch,
            note: String::new(),
            current_task: None,
            at: 0,
            until: Some(100),
            location: Location::Remote,
        };
        assert!(!super::expire(&mut p, 99));
        assert_eq!(p.state, PresenceState::Lunch);
        assert!(super::expire(&mut p, 100));
        assert_eq!(p.state, PresenceState::Online);
        assert_eq!(p.until, None);
        assert!(!super::expire(&mut p, 200));
    }
}
