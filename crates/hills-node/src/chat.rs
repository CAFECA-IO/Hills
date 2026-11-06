//! 對話 API（technical-design §14）：建立、成員管理、送出與讀取訊息、本機已讀。

use std::collections::BTreeSet;

use anyhow::{Result, anyhow, bail};
use hills_proto::gossip::GossipMsg;
use hills_proto::{KeyFamily, MemberId, Pub32, Timestamp};
use serde::Serialize;

use crate::conv::{self, ConvInfo, ConvKind, Message, NewMessage, ReadMarks};
use crate::node::{Event, Inner, Node, State, lock, now_ms};

const READ_MARKS: &str = "conv-read";

/// 對話清單的一列。
#[derive(Debug, Clone, Serialize)]
pub struct ConvView {
    #[serde(flatten)]
    pub info: ConvInfo,
    pub last: Option<Message>,
    pub unread: u32,
}

fn recipients(st: &State, members: &BTreeSet<MemberId>) -> Result<Vec<(MemberId, Pub32)>> {
    let active = st.trust.active_members();
    members
        .iter()
        .map(|m| {
            active
                .iter()
                .find(|c| c.member_id == *m)
                .map(|c| (*m, c.ek_pub))
                .ok_or_else(|| anyhow!("{m} 不是組織的有效成員"))
        })
        .collect()
}

/// 對話目前的紀錄 epoch。
fn conv_epoch(st: &State, conv_id: &str) -> Result<u32> {
    st.ring
        .latest(&KeyFamily::Conv(conv_id.to_owned()))
        .map(|(id, _)| id.epoch)
        .ok_or_else(|| anyhow!("尚未取得對話金鑰"))
}

impl Inner {
    fn read_marks(&self) -> ReadMarks {
        self.store
            .read_secret_file(READ_MARKS)
            .ok()
            .flatten()
            .and_then(|raw| postcard::from_bytes(&raw).ok())
            .unwrap_or_default()
    }

    fn write_marks(&self, marks: &ReadMarks) -> Result<()> {
        self.store
            .write_secret_file(READ_MARKS, &postcard::to_allocvec(marks)?)?;
        Ok(())
    }

    /// 輪替對話金鑰（紀錄用 `Conv` 與 meta 用 `ConvMeta`），封裝給 `to`；回傳新的紀錄 epoch。
    fn rotate_conv_keys(
        &self,
        st: &mut State,
        conv_id: &str,
        to: &[(MemberId, Pub32)],
    ) -> Result<u32> {
        for family in [
            KeyFamily::Conv(conv_id.to_owned()),
            KeyFamily::ConvMeta(conv_id.to_owned()),
        ] {
            let r = hills_crypto::rotate(&st.ring, &family, to)?;
            for w in r.wrapped {
                let s = self.secrets.device.sign_body(w)?;
                st.key_outbox.push(s);
            }
            st.ring.insert(r.key_id, r.key);
        }
        self.persist(st)?;
        conv_epoch(st, conv_id)
    }

    /// 新成員取得 meta 的全部 epoch（meta 歷史不是秘密，且缺少舊 change 就無法套用新的）。
    fn share_meta_history(
        &self,
        st: &mut State,
        conv_id: &str,
        to: &[(MemberId, Pub32)],
    ) -> Result<()> {
        let family = KeyFamily::ConvMeta(conv_id.to_owned());
        let epochs: Vec<_> = st
            .ring
            .epochs(&family)
            .into_iter()
            .map(|(id, k)| (id.clone(), k.clone()))
            .collect();
        for (id, key) in epochs {
            for (m, ek) in to {
                let w = hills_crypto::wrap_key(&id, &key, *m, ek)?;
                st.key_outbox.push(self.secrets.device.sign_body(w)?);
            }
        }
        self.persist(st)
    }

    fn messages_locked(&self, st: &mut State, conv_id: &str) -> Vec<Message> {
        let months: Vec<String> = st
            .conv_months
            .get(conv_id)
            .map(|m| m.iter().cloned().collect())
            .unwrap_or_default();
        let mut out = Vec::new();
        for m in months {
            if let Ok(local) = self.load_doc(&mut st.docs, &format!("conv/{conv_id}/log/{m}")) {
                out.extend(conv::read_log(conv_id, &local.doc));
            }
        }
        conv::sort_messages(&mut out);
        out
    }

    /// 我建立的對話中，已被停用的組織成員自動移出並輪替金鑰（§14.1、§3.7）。
    pub(crate) fn prune_revoked_conv_members(&self) -> Result<bool> {
        let me = self.me();
        let mut st = lock(&self.st);
        let active: BTreeSet<MemberId> = st
            .trust
            .active_members()
            .iter()
            .map(|c| c.member_id)
            .collect();
        let stale: Vec<(String, Vec<MemberId>)> = st
            .convs
            .values()
            .filter(|c| c.creator == me)
            .filter_map(|c| {
                let gone: Vec<MemberId> = c.members.difference(&active).copied().collect();
                (!gone.is_empty()).then(|| (c.id.clone(), gone))
            })
            .collect();
        for (conv_id, gone) in &stale {
            let Some(info) = st.convs.get(conv_id).cloned() else {
                continue;
            };
            let keep: BTreeSet<MemberId> = info.members.intersection(&active).copied().collect();
            let to = recipients(&st, &keep)?;
            self.rotate_conv_keys(&mut st, conv_id, &to)?;
            let now = now_ms();
            self.change_locked(&mut st, &conv::meta_doc(conv_id), |doc| {
                for m in gone {
                    conv::remove_member(doc, m, now)?;
                }
                Ok(())
            })?;
        }
        Ok(!stale.is_empty())
    }
}

impl Node {
    /// 本人所屬的對話，依最後訊息時間（新到舊）排序。
    pub fn conversations(&self) -> Vec<ConvView> {
        let inner = &self.inner;
        let me = self.member_id();
        let marks = inner.read_marks();
        let mut st = lock(&inner.st);
        let convs: Vec<ConvInfo> = st
            .convs
            .values()
            .filter(|c| c.members.contains(&me))
            .cloned()
            .collect();
        let mut out: Vec<ConvView> = convs
            .into_iter()
            .map(|info| {
                let msgs = inner.messages_locked(&mut st, &info.id);
                let seen = marks.0.get(&info.id).copied().unwrap_or(0);
                let unread = msgs
                    .iter()
                    .filter(|m| m.author != me && m.created_at > seen)
                    .count() as u32;
                ConvView {
                    last: msgs.last().cloned(),
                    unread,
                    info,
                }
            })
            .collect();
        out.sort_by_key(|v| {
            std::cmp::Reverse(v.last.as_ref().map_or(v.info.created_at, |m| m.created_at))
        });
        out
    }

    /// 對話的訊息（舊到新），最多 `limit` 則（取最新的）。
    pub fn messages(&self, conv_id: &str, limit: usize) -> Result<Vec<Message>> {
        let mut st = lock(&self.inner.st);
        let me = self.member_id();
        if !st
            .convs
            .get(conv_id)
            .is_some_and(|c| c.members.contains(&me))
        {
            bail!("不是此對話的成員");
        }
        let mut v = self.inner.messages_locked(&mut st, conv_id);
        let skip = v.len().saturating_sub(limit);
        Ok(v.split_off(skip))
    }

    /// 與某位成員的既有私訊（最近有訊息者優先）。
    pub fn find_dm(&self, peer: &MemberId) -> Option<String> {
        self.conversations()
            .into_iter()
            .find(|v| v.info.kind == ConvKind::Dm && v.info.members.contains(peer))
            .map(|v| v.info.id)
    }

    /// 建立對話（私訊或群組），回傳 convId。
    pub async fn create_conv(
        &self,
        kind: ConvKind,
        name: &str,
        members: &[MemberId],
    ) -> Result<String> {
        let inner = &self.inner;
        let me = self.member_id();
        let mut all: BTreeSet<MemberId> = members.iter().copied().collect();
        all.insert(me);
        if kind == ConvKind::Dm && all.len() != 2 {
            bail!("私訊只能有兩位成員");
        }
        if all.len() < 2 {
            bail!("至少需要一位其他成員");
        }
        let now = now_ms();
        let conv_id = conv::new_conv_id(&me, now)?;
        let heads = {
            let mut st = lock(&inner.st);
            let to = recipients(&st, &all)?;
            let epoch = inner.rotate_conv_keys(&mut st, &conv_id, &to)?;
            let list: Vec<MemberId> = all.iter().copied().collect();
            let name = name.trim().chars().take(100).collect::<String>();
            inner.change_locked(&mut st, &conv::meta_doc(&conv_id), |doc| {
                Ok(conv::init_meta(doc, kind, &name, &list, epoch, now)?)
            })?
        };
        self.after_change(&conv::meta_doc(&conv_id), heads).await;
        Ok(conv_id)
    }

    /// 送出訊息。
    pub async fn send_message(
        &self,
        conv_id: &str,
        body: &str,
        mentions: &[MemberId],
        attachments: serde_json::Value,
    ) -> Result<Message> {
        let inner = &self.inner;
        let me = self.member_id();
        let now = now_ms();
        let epoch = conv_epoch(&lock(&inner.st), conv_id)?;
        let doc_id = conv::log_doc(conv_id, &conv::month_of(now), epoch);
        let kind = if attachments.is_null() {
            "text"
        } else {
            "files"
        };
        if body.trim().is_empty() && attachments.is_null() {
            bail!("訊息不能空白");
        }
        let mut key = String::new();
        let heads = {
            let mut st = lock(&inner.st);
            let members = st
                .convs
                .get(conv_id)
                .filter(|c| c.members.contains(&me))
                .map(|c| c.members.clone())
                .ok_or_else(|| anyhow!("不是此對話的成員"))?;
            let mentions: Vec<MemberId> = mentions
                .iter()
                .filter(|m| members.contains(m))
                .copied()
                .collect();
            let msg = NewMessage {
                kind,
                body,
                mentions: &mentions,
                attachments,
            };
            inner.change_locked(&mut st, &doc_id, |doc| {
                key = conv::append(doc, &me, &msg, now)?;
                Ok(())
            })?
        };
        let msg = {
            let mut st = lock(&inner.st);
            let local = inner.load_doc(&mut st.docs, &doc_id)?;
            conv::read_keys(conv_id, &local.doc, &[key])
                .into_iter()
                .next()
                .ok_or_else(|| anyhow!("訊息寫入失敗"))?
        };
        self.mark_read(conv_id, now)?;
        self.after_change(&doc_id, heads).await;
        Ok(msg)
    }

    /// 加入成員（只有建立者）。新成員只拿到目前的 epoch，看不到加入前的訊息（D37）。
    pub async fn add_conv_members(&self, conv_id: &str, members: &[MemberId]) -> Result<()> {
        let inner = &self.inner;
        let heads = {
            let mut st = lock(&inner.st);
            let info = self.owned_conv(&st, conv_id)?;
            if info.kind == ConvKind::Dm {
                bail!("私訊不能加入成員");
            }
            let new: BTreeSet<MemberId> = members
                .iter()
                .filter(|m| !info.members.contains(m))
                .copied()
                .collect();
            if new.is_empty() {
                return Ok(());
            }
            // 輪替：新 epoch 給全體（含新成員），新成員看不到加入前的紀錄（§14.1 v0.9）
            let mut all = info.members.clone();
            all.extend(new.iter().copied());
            let to = recipients(&st, &all)?;
            let fresh = recipients(&st, &new)?;
            inner.share_meta_history(&mut st, conv_id, &fresh)?;
            let epoch = inner.rotate_conv_keys(&mut st, conv_id, &to)?;
            let list: Vec<MemberId> = new.into_iter().collect();
            let now = now_ms();
            inner.change_locked(&mut st, &conv::meta_doc(conv_id), |doc| {
                Ok(conv::add_members(doc, &list, epoch, now)?)
            })?
        };
        self.after_change(&conv::meta_doc(conv_id), heads).await;
        Ok(())
    }

    /// 移出成員（只有建立者）：輪替 epoch，對方看不到之後的訊息。
    pub async fn remove_conv_member(&self, conv_id: &str, member: MemberId) -> Result<()> {
        let inner = &self.inner;
        let heads = {
            let mut st = lock(&inner.st);
            let info = self.owned_conv(&st, conv_id)?;
            if member == self.member_id() {
                bail!("建立者不能移出自己");
            }
            if !info.members.contains(&member) {
                return Ok(());
            }
            let mut keep = info.members.clone();
            keep.remove(&member);
            let to = recipients(&st, &keep)?;
            inner.rotate_conv_keys(&mut st, conv_id, &to)?;
            let now = now_ms();
            inner.change_locked(&mut st, &conv::meta_doc(conv_id), |doc| {
                Ok(conv::remove_member(doc, &member, now)?)
            })?
        };
        self.after_change(&conv::meta_doc(conv_id), heads).await;
        Ok(())
    }

    pub async fn rename_conv(&self, conv_id: &str, name: &str) -> Result<()> {
        let inner = &self.inner;
        let name: String = name.trim().chars().take(100).collect();
        let heads = {
            let mut st = lock(&inner.st);
            self.owned_conv(&st, conv_id)?;
            inner.change_locked(&mut st, &conv::meta_doc(conv_id), |doc| {
                Ok(conv::rename(doc, &name)?)
            })?
        };
        self.after_change(&conv::meta_doc(conv_id), heads).await;
        Ok(())
    }

    /// 標記已讀（只存本機）。
    pub fn mark_read(&self, conv_id: &str, at: Timestamp) -> Result<()> {
        let mut marks = self.inner.read_marks();
        let e = marks.0.entry(conv_id.to_owned()).or_insert(0);
        if at > *e {
            *e = at;
            self.inner.write_marks(&marks)?;
            self.inner.emit(Event::ConvsChanged);
        }
        Ok(())
    }

    fn owned_conv(&self, st: &State, conv_id: &str) -> Result<ConvInfo> {
        let info = st
            .convs
            .get(conv_id)
            .cloned()
            .ok_or_else(|| anyhow!("找不到對話"))?;
        if info.creator != self.member_id() {
            bail!("只有建立者可以管理此對話");
        }
        Ok(info)
    }

    async fn after_change(&self, doc_id: &str, heads: Vec<[u8; 32]>) {
        self.inner.emit(Event::DocChanged(doc_id.to_owned()));
        self.inner.wake.notify_one();
        crate::gossip::broadcast(
            &self.inner,
            GossipMsg::Heads {
                doc_id: doc_id.to_owned(),
                heads,
            },
        )
        .await;
    }
}
