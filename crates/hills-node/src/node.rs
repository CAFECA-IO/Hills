//! Node 核心：狀態、啟動、文件讀寫與套用遠端 change（technical-design §16.1、§16.5）。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use automerge::AutoCommit;
use hills_crypto::{CryptoError, KeyRing, open_bundle, seal_bundle};
use hills_identity::secret_store::SecretStore;
use hills_identity::trust::TrustStore;
use hills_net::mailbox::MailboxClient;
use hills_net::to_endpoint_addr;
use hills_proto::gossip::{Presence, PresenceState};
use hills_proto::{
    DeviceCert, EncryptedBundle, MemberId, Pub32, Roster, Signed, SignedChange, Timestamp,
    WrappedKey,
};
use hills_store::DocStore;
use hills_sync::{DocKind, Validator, allowed, sign_change};
use iroh::address_lookup::MemoryLookup;
use iroh::protocol::Router;
use iroh::{Endpoint, RelayMode, SecretKey, endpoint::presets};
use iroh_gossip::Gossip;
use iroh_gossip::api::GossipSender;
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, broadcast};
use tokio::task::JoinHandle;

use crate::config::{MemberStatus, NodeConfig, Secrets};
use crate::conv::{self, ConvInfo};
use crate::local::LocalDoc;
use crate::org::{self, OrgSnapshot};
use crate::policy;

pub(crate) fn now_ms() -> Timestamp {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 可調整的時間參數（測試時縮短）。
#[derive(Debug, Clone)]
pub struct NodeOptions {
    pub presence_interval: Duration,
    pub presence_timeout: Duration,
    pub poll_interval: Duration,
    pub invite_ttl: Duration,
}

impl Default for NodeOptions {
    fn default() -> Self {
        Self {
            presence_interval: Duration::from_secs(30),
            presence_timeout: Duration::from_secs(90),
            poll_interval: Duration::from_secs(15),
            invite_ttl: Duration::from_secs(72 * 3600),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SyncStatus {
    /// 等待管理者核准加入
    Pending,
    Offline,
    Syncing,
    Synced,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    StatusChanged(SyncStatus),
    /// 加入申請已核准
    Activated,
    OrgChanged,
    RosterChanged,
    PresenceChanged,
    DocChanged(String),
    /// 對話清單或成員變更
    ConvsChanged,
    /// 收到別人的新訊息（§14.2 通知）
    Message {
        conv: String,
        author: MemberId,
        /// 私訊，或提及本人
        notify: bool,
        preview: String,
    },
}

/// 需持久化的同步狀態（以儲存金鑰加密存成 `state.enc`）。
#[derive(Serialize, Deserialize, Default)]
struct Persisted {
    roster: Option<Roster>,
    ring: Vec<u8>,
    my_device_cert: Option<Signed<DeviceCert>>,
    outbox: Vec<EncryptedBundle>,
    key_outbox: Vec<Signed<WrappedKey>>,
    pending: Vec<EncryptedBundle>,
}

pub(crate) struct State {
    pub trust: TrustStore,
    pub ring: KeyRing,
    pub docs: HashMap<String, LocalDoc>,
    pub my_device_cert: Signed<DeviceCert>,
    /// 尚未上傳到 mailbox 的 bundle
    pub outbox: Vec<EncryptedBundle>,
    /// 尚未上傳的封裝金鑰
    pub key_outbox: Vec<Signed<WrappedKey>>,
    /// 暫時無法解密（金鑰尚未到）的 bundle
    pub pending: Vec<EncryptedBundle>,
    /// 本人可解密的對話（由 meta 投影，§14.1）
    pub convs: BTreeMap<String, ConvInfo>,
    /// 作者尚未出現在 meta 而暫存的對話紀錄 change（meta 更新後重試，§14.1 v0.9）
    pub held: Vec<(String, SignedChange)>,
    /// 各對話已知的訊息月份（`yyyy-mm`）
    pub conv_months: BTreeMap<String, std::collections::BTreeSet<String>>,
}

/// pending bundle 的上限（對話 bundle 無法事先判斷是否為本人所屬）。
const MAX_PENDING: usize = 5000;
/// 暫存對話 change 的上限。
const MAX_HELD: usize = 5000;

pub(crate) struct Inner {
    pub dir: PathBuf,
    pub opts: NodeOptions,
    pub cfg: Mutex<NodeConfig>,
    pub secrets: Secrets,
    pub secret_store: Arc<dyn SecretStore>,
    pub store: DocStore,
    pub st: Mutex<State>,
    pub endpoint: Endpoint,
    pub memory: MemoryLookup,
    pub gossip: Gossip,
    pub router: OnceLock<Router>,
    pub gossip_tx: tokio::sync::Mutex<Option<GossipSender>>,
    pub mailbox: tokio::sync::Mutex<Option<MailboxClient>>,
    pub wake: Notify,
    pub presence: Mutex<HashMap<MemberId, (Presence, Instant)>>,
    pub my_presence: Mutex<Presence>,
    pub events: broadcast::Sender<Event>,
    pub status: Mutex<SyncStatus>,
    pub tasks: Mutex<Vec<JoinHandle<()>>>,
}

/// Hills 節點：一台裝置上的一個成員身分。
#[derive(Clone)]
pub struct Node {
    pub(crate) inner: Arc<Inner>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Inner {
    pub fn me(&self) -> MemberId {
        self.secrets.keys.member_id()
    }

    pub fn emit(&self, e: Event) {
        let _ = self.events.send(e);
    }

    pub fn set_status(&self, s: SyncStatus) {
        let mut cur = lock(&self.status);
        if *cur != s {
            *cur = s;
            drop(cur);
            self.emit(Event::StatusChanged(s));
        }
    }

    pub fn persist(&self, st: &State) -> Result<()> {
        let p = Persisted {
            roster: Some(st.trust.to_roster(now_ms())),
            ring: st.ring.export()?.to_vec(),
            my_device_cert: Some(st.my_device_cert.clone()),
            outbox: st.outbox.clone(),
            key_outbox: st.key_outbox.clone(),
            pending: st.pending.clone(),
        };
        let bytes = zeroize::Zeroizing::new(postcard::to_allocvec(&p)?);
        self.store.write_secret_file("state", &bytes)?;
        Ok(())
    }

    pub fn save_cfg(&self) -> Result<()> {
        lock(&self.cfg).save(&self.dir)
    }

    /// 載入（必要時從磁碟）本地文件。
    pub fn load_doc<'a>(
        &self,
        docs: &'a mut HashMap<String, LocalDoc>,
        doc_id: &str,
    ) -> Result<&'a mut LocalDoc> {
        if !docs.contains_key(doc_id) {
            let local = match self.store.load_with(doc_id)? {
                Some((doc, extra)) => LocalDoc {
                    doc,
                    sigs: LocalDoc::decode_sigs(&extra),
                },
                None => LocalDoc::new(),
            };
            docs.insert(doc_id.to_owned(), local);
        }
        docs.get_mut(doc_id).ok_or_else(|| anyhow!("文件載入失敗"))
    }

    pub fn save_doc(&self, docs: &mut HashMap<String, LocalDoc>, doc_id: &str) -> Result<()> {
        let local = docs.get_mut(doc_id).ok_or_else(|| anyhow!("文件不存在"))?;
        let sigs = local.encode_sigs();
        self.store.save_with(doc_id, &mut local.doc, &sigs)?;
        Ok(())
    }

    pub fn org_snapshot(&self, st: &mut State) -> OrgSnapshot {
        let mut snap = match self.load_doc(&mut st.docs, "org") {
            Ok(l) => org::read(&l.doc),
            Err(_) => OrgSnapshot::default(),
        };
        snap.convs = st
            .convs
            .iter()
            .map(|(id, c)| (id.clone(), c.joined.clone()))
            .collect();
        snap
    }

    /// 文件變更後更新對話投影；回傳 meta 是否改變。
    pub fn note_conv_doc(&self, st: &mut State, doc_id: &str) -> bool {
        let Some((conv_id, month)) = conv::parse_doc(doc_id) else {
            return false;
        };
        match month {
            Some(m) => {
                st.conv_months.entry(conv_id).or_default().insert(m);
                false
            }
            None => {
                let Ok(local) = self.load_doc(&mut st.docs, doc_id) else {
                    return false;
                };
                let Some(info) = conv::read_meta(&conv_id, &local.doc) else {
                    return false;
                };
                let changed = st.convs.get(&conv_id) != Some(&info);
                st.convs.insert(conv_id, info);
                changed
            }
        }
    }

    /// 啟動時由本機文件重建對話投影。
    pub fn scan_convs(&self, st: &mut State) -> Result<()> {
        let mut ids = self.store.doc_ids()?;
        ids.sort();
        for id in ids {
            if id.starts_with("conv/") {
                self.note_conv_doc(st, &id);
            }
        }
        Ok(())
    }

    pub fn save_held(&self, st: &State) -> Result<()> {
        self.store
            .write_secret_file("held", &postcard::to_allocvec(&st.held)?)?;
        Ok(())
    }

    /// 在本機修改文件：檢查寫入權限 → 修改 → 簽章 → 保存 → 加密成 bundle 放入 outbox。
    /// 回傳新的 heads。呼叫端負責喚醒 mailbox 迴圈與廣播 heads。
    pub fn change_locked(
        &self,
        st: &mut State,
        doc_id: &str,
        f: impl FnOnce(&mut AutoCommit) -> Result<()>,
    ) -> Result<Vec<[u8; 32]>> {
        let family =
            policy::key_family(doc_id).ok_or_else(|| anyhow!("M0 不支援此文件類型：{doc_id}"))?;
        let kind = DocKind::parse(doc_id).ok_or_else(|| anyhow!("文件 ID 無效"))?;
        let dir = self.org_snapshot(st);
        let me = st
            .trust
            .verify_device(&self.secrets.device.public())
            .context("本裝置尚未通過信任鏈")?;
        if !allowed(&kind, &me, &dir) {
            bail!("沒有寫入 {doc_id} 的權限");
        }
        let (key_id, key) = st
            .ring
            .latest(&family)
            .map(|(i, k)| (i.clone(), k.clone()))
            .ok_or_else(|| anyhow!("缺少 {family:?} 金鑰"))?;
        let local = self.load_doc(&mut st.docs, doc_id)?;
        let before = local.doc.get_heads();
        f(&mut local.doc)?;
        local.doc.commit();
        let changes = local.doc.get_changes(&before);
        if changes.is_empty() {
            return Ok(local.heads());
        }
        let signed: Vec<SignedChange> = changes
            .iter()
            .map(|c| sign_change(doc_id, c, &self.secrets.device))
            .collect::<Result<_, _>>()?;
        for sc in &signed {
            local.record(sc);
        }
        let heads = local.heads();
        self.save_doc(&mut st.docs, doc_id)?;
        if self.note_conv_doc(st, doc_id) {
            self.emit(Event::ConvsChanged);
        }
        st.outbox.push(seal_bundle(doc_id, &key_id, &key, &signed)?);
        self.persist(st)?;
        Ok(heads)
    }

    /// 驗證並套用遠端 change；回傳套用數量。
    pub fn apply_remote(&self, doc_id: &str, changes: &[SignedChange]) -> Result<usize> {
        if changes.is_empty() {
            return Ok(0);
        }
        let mut new_messages = Vec::new();
        let (n, meta_changed) = {
            let mut st = lock(&self.st);
            let dir = self.org_snapshot(&mut st);
            let is_log = matches!(DocKind::parse(doc_id), Some(DocKind::ConvLog(_)));
            let mut ok = Vec::new();
            let mut held = Vec::new();
            {
                let v = Validator::new(&st.trust, &dir);
                for sc in changes {
                    match v.check(doc_id, sc) {
                        Ok((c, who)) => ok.push((c, sc, who.member_id)),
                        Err(hills_sync::SyncError::Forbidden) if is_log => held.push(sc.clone()),
                        Err(e) => tracing::warn!(doc_id, error = %e, "拒絕遠端 change"),
                    }
                }
            }
            if !held.is_empty() {
                for sc in held {
                    if !st
                        .held
                        .iter()
                        .any(|(_, h)| h.body.change_hash == sc.body.change_hash)
                    {
                        st.held.push((doc_id.to_owned(), sc));
                    }
                }
                let over = st.held.len().saturating_sub(MAX_HELD);
                st.held.drain(..over);
                self.save_held(&st)?;
            }
            if ok.is_empty() {
                return Ok(0);
            }
            let me = self.me();
            let State { docs, .. } = &mut *st;
            let local = self.load_doc(docs, doc_id)?;
            let fresh: Vec<_> = ok
                .into_iter()
                .filter(|(c, _, _)| local.doc.get_change_by_hash(&c.hash()).is_none())
                .collect();
            if fresh.is_empty() {
                return Ok(0);
            }
            for (_, sc, _) in &fresh {
                local.record(sc);
            }
            let added: Vec<String> = if is_log {
                fresh
                    .iter()
                    .filter(|(_, _, author)| *author != me)
                    .flat_map(|(c, _, _)| conv::added_keys(c))
                    .collect()
            } else {
                vec![]
            };
            local
                .doc
                .apply_changes(fresh.iter().map(|(c, _, _)| c.clone()))
                .map_err(|e| anyhow!("套用失敗：{e}"))?;
            if let Some((conv_id, _)) = conv::parse_doc(doc_id) {
                new_messages = conv::read_keys(&conv_id, &local.doc, &added);
            }
            self.save_doc(docs, doc_id)?;
            let meta_changed = self.note_conv_doc(&mut st, doc_id);
            let kinds: BTreeMap<String, conv::ConvKind> =
                st.convs.iter().map(|(k, c)| (k.clone(), c.kind)).collect();
            for m in &new_messages {
                let notify =
                    kinds.get(&m.conv) == Some(&conv::ConvKind::Dm) || m.mentions.contains(&me);
                self.emit(Event::Message {
                    conv: m.conv.clone(),
                    author: m.author,
                    notify,
                    preview: m.body.chars().take(120).collect(),
                });
            }
            (fresh.len(), meta_changed)
        };
        self.emit(Event::DocChanged(doc_id.to_owned()));
        if doc_id == "org" {
            self.emit(Event::OrgChanged);
        }
        if meta_changed {
            self.emit(Event::ConvsChanged);
            if let Some((conv_id, None)) = conv::parse_doc(doc_id) {
                self.retry_held(&conv_id)?;
            }
        }
        Ok(n)
    }

    /// meta 更新後，重試該對話暫存的 change。
    pub fn retry_held(&self, conv_id: &str) -> Result<()> {
        let prefix = format!("conv/{conv_id}/");
        let mine: Vec<(String, SignedChange)> = {
            let mut st = lock(&self.st);
            let (mine, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut st.held)
                .into_iter()
                .partition(|(d, _)| d.starts_with(&prefix));
            st.held = rest;
            self.save_held(&st)?;
            mine
        };
        let mut by_doc: BTreeMap<String, Vec<SignedChange>> = BTreeMap::new();
        for (d, sc) in mine {
            by_doc.entry(d).or_default().push(sc);
        }
        for (d, scs) in by_doc {
            self.apply_remote(&d, &scs)?;
        }
        Ok(())
    }

    /// 嘗試解開並套用 bundle；金鑰尚未到但應該會到的，放入 pending。
    pub fn ingest_bundle(&self, b: &EncryptedBundle) -> Result<()> {
        let opened = {
            let st = lock(&self.st);
            open_bundle(b, &st.ring)
        };
        match opened {
            Ok(changes) => {
                self.apply_remote(&b.doc_id, &changes)?;
            }
            Err(CryptoError::MissingKey(_)) => {
                let mut st = lock(&self.st);
                let dir = self.org_snapshot(&mut st);
                if policy::expects_key(&b.key_id.family, &self.me(), &dir)
                    && !st.pending.iter().any(|p| p.bundle_hash == b.bundle_hash)
                {
                    st.pending.push(b.clone());
                    let over = st.pending.len().saturating_sub(MAX_PENDING);
                    st.pending.drain(..over);
                    self.persist(&st)?;
                }
            }
            Err(e) => tracing::warn!(doc_id = %b.doc_id, error = %e, "無法解開 bundle"),
        }
        Ok(())
    }

    /// 金鑰更新後重試 pending bundle。
    pub fn retry_pending(&self) -> Result<()> {
        let pending = std::mem::take(&mut lock(&self.st).pending);
        for b in &pending {
            self.ingest_bundle(b)?;
        }
        let st = lock(&self.st);
        self.persist(&st)
    }
}

impl Node {
    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.inner.events.subscribe()
    }

    pub fn member_id(&self) -> MemberId {
        self.inner.me()
    }

    pub fn device(&self) -> Pub32 {
        self.inner.secrets.device.public()
    }

    pub fn status(&self) -> SyncStatus {
        *lock(&self.inner.status)
    }

    pub fn member_status(&self) -> MemberStatus {
        lock(&self.inner.cfg).status
    }

    pub fn dir(&self) -> &Path {
        &self.inner.dir
    }

    /// 讀取文件（唯讀），f 中可使用 Automerge ReadDoc API。
    pub fn read_doc<T>(&self, doc_id: &str, f: impl FnOnce(&AutoCommit) -> T) -> Result<T> {
        let mut st = lock(&self.inner.st);
        let local = self.inner.load_doc(&mut st.docs, doc_id)?;
        Ok(f(&local.doc))
    }

    /// 修改文件：簽章、保存、上傳 mailbox、gossip 廣播 heads。
    pub async fn change(
        &self,
        doc_id: &str,
        f: impl FnOnce(&mut AutoCommit) -> Result<()>,
    ) -> Result<()> {
        let heads = {
            let mut st = lock(&self.inner.st);
            self.inner.change_locked(&mut st, doc_id, f)?
        };
        self.inner.emit(Event::DocChanged(doc_id.to_owned()));
        if doc_id == "org" {
            self.inner.emit(Event::OrgChanged);
        }
        self.inner.wake.notify_one();
        crate::gossip::broadcast(
            &self.inner,
            hills_proto::gossip::GossipMsg::Heads {
                doc_id: doc_id.to_owned(),
                heads,
            },
        )
        .await;
        Ok(())
    }

    pub fn org(&self) -> OrgSnapshot {
        let mut st = lock(&self.inner.st);
        self.inner.org_snapshot(&mut st)
    }

    pub fn is_admin(&self) -> bool {
        let st = lock(&self.inner.st);
        st.trust
            .verify_device(&self.device())
            .map(|v| v.is_admin())
            .unwrap_or(false)
    }

    /// 設定自己的上線狀態並立即廣播。
    pub async fn set_presence(&self, state: PresenceState, note: &str) {
        let p = {
            let mut p = lock(&self.inner.my_presence);
            p.state = state;
            p.note = note.chars().take(140).collect();
            p.at = now_ms();
            p.clone()
        };
        lock(&self.inner.presence).insert(p.member, (p.clone(), Instant::now()));
        self.inner.emit(Event::PresenceChanged);
        crate::gossip::broadcast(&self.inner, hills_proto::gossip::GossipMsg::Presence(p)).await;
    }

    /// 目前已知的上線狀態（逾時者不列出）。
    pub fn presence(&self) -> HashMap<MemberId, Presence> {
        lock(&self.inner.presence)
            .iter()
            .map(|(k, (p, _))| (*k, p.clone()))
            .collect()
    }

    /// 立即與 mailbox 同步一次（UI 的「重新整理」、測試用）。
    pub async fn sync_now(&self) -> Result<()> {
        crate::mailbox::sync_once(&self.inner).await
    }

    /// 取得 mailbox 連線（必要時先同步一次以建立）。
    pub(crate) async fn mailbox_guard(
        &self,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<MailboxClient>>> {
        {
            let g = self.inner.mailbox.lock().await;
            if g.as_ref().is_some_and(|c| !c.is_closed()) {
                return Ok(g);
            }
        }
        let _ = crate::mailbox::sync_once(&self.inner).await;
        let g = self.inner.mailbox.lock().await;
        if g.as_ref().is_some_and(|c| !c.is_closed()) {
            Ok(g)
        } else {
            Err(anyhow!("目前無法連線到 mailbox"))
        }
    }

    /// 停止所有背景工作並關閉網路。
    pub async fn shutdown(&self) {
        for t in lock(&self.inner.tasks).drain(..) {
            t.abort();
        }
        if let Some(c) = self.inner.mailbox.lock().await.take() {
            c.close().await;
        }
        if let Some(r) = self.inner.router.get() {
            let _ = r.shutdown().await;
        }
        self.inner.endpoint.close().await;
    }

    /// 開啟既有節點；尚未設定時回傳 None。
    pub async fn open(
        dir: &Path,
        secret_store: Arc<dyn SecretStore>,
        opts: NodeOptions,
    ) -> Result<Option<Self>> {
        let Some(cfg) = NodeConfig::load(dir)? else {
            return Ok(None);
        };
        let Some(secrets) = Secrets::load(&secret_store)? else {
            bail!("找不到本機金鑰（安全儲存區可能被清除），請以復原詞還原");
        };
        Ok(Some(
            Self::start(dir, secret_store, cfg, secrets, None, opts).await?,
        ))
    }

    /// 以設定與機密啟動。`fresh` 為首次建立時的初始狀態。
    pub(crate) async fn start(
        dir: &Path,
        secret_store: Arc<dyn SecretStore>,
        cfg: NodeConfig,
        secrets: Secrets,
        fresh: Option<(TrustStore, KeyRing, Signed<DeviceCert>)>,
        opts: NodeOptions,
    ) -> Result<Self> {
        let store = DocStore::open(dir, secrets.storage_key.clone())?;
        let state = match fresh {
            Some((trust, ring, cert)) => State {
                trust,
                ring,
                docs: HashMap::new(),
                my_device_cert: cert,
                outbox: vec![],
                key_outbox: vec![],
                pending: vec![],
                convs: BTreeMap::new(),
                held: vec![],
                conv_months: BTreeMap::new(),
            },
            None => {
                let raw = store
                    .read_secret_file("state")?
                    .ok_or_else(|| anyhow!("找不到同步狀態"))?;
                let p: Persisted = postcard::from_bytes(&raw)?;
                let mut trust = TrustStore::new(cfg.org_root);
                if let Some(r) = &p.roster {
                    trust.import_roster(r)?;
                }
                State {
                    trust,
                    ring: KeyRing::import(&p.ring)?,
                    docs: HashMap::new(),
                    my_device_cert: p.my_device_cert.ok_or_else(|| anyhow!("缺少裝置憑證"))?,
                    outbox: p.outbox,
                    key_outbox: p.key_outbox,
                    pending: p.pending,
                    convs: BTreeMap::new(),
                    held: read_held(&store),
                    conv_months: BTreeMap::new(),
                }
            }
        };

        let memory = MemoryLookup::new();
        memory.add_endpoint_info(to_endpoint_addr(&cfg.mailbox)?);
        let relay = match &cfg.mailbox.relay {
            Some(u) => RelayMode::custom([u.parse().context("relay URL 無效")?]),
            // 不用 Disabled：之後才取得的 relay 需能以 insert_relay 加入（§16.1）
            None => RelayMode::Custom(iroh::RelayMap::empty()),
        };
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::from_bytes(&secrets.device.secret_bytes()))
            .relay_mode(relay)
            .address_lookup(memory.clone())
            .alpns(vec![
                hills_proto::sync::ALPN.to_vec(),
                iroh_gossip::ALPN.to_vec(),
            ])
            .bind()
            .await?;
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let me = secrets.keys.member_id();
        let status = if cfg.status == MemberStatus::Pending {
            SyncStatus::Pending
        } else {
            SyncStatus::Offline
        };
        let (events, _) = broadcast::channel(256);
        let inner = Arc::new(Inner {
            dir: dir.to_owned(),
            opts,
            cfg: Mutex::new(cfg),
            secrets,
            secret_store,
            store,
            st: Mutex::new(state),
            endpoint: endpoint.clone(),
            memory,
            gossip: gossip.clone(),
            router: OnceLock::new(),
            gossip_tx: tokio::sync::Mutex::new(None),
            mailbox: tokio::sync::Mutex::new(None),
            wake: Notify::new(),
            presence: Mutex::new(HashMap::new()),
            my_presence: Mutex::new(Presence {
                member: me,
                state: PresenceState::Online,
                note: String::new(),
                current_task: None,
                at: now_ms(),
            }),
            events,
            status: Mutex::new(status),
            tasks: Mutex::new(Vec::new()),
        });
        {
            let mut st = lock(&inner.st);
            inner.scan_convs(&mut st)?;
            inner.persist(&st)?;
        }
        let router = Router::builder(endpoint)
            .accept(
                hills_proto::sync::ALPN,
                crate::syncproto::SyncProto(Arc::downgrade(&inner)),
            )
            .accept(iroh_gossip::ALPN, gossip)
            .spawn();
        let _ = inner.router.set(router);
        let node = Self { inner };
        node.spawn_tasks();
        Ok(node)
    }

    fn spawn_tasks(&self) {
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        let mut tasks = lock(&self.inner.tasks);
        tasks.push(tokio::spawn(crate::mailbox::run(weak.clone())));
        tasks.push(tokio::spawn(crate::gossip::run(weak.clone())));
        tasks.push(tokio::spawn(crate::gossip::presence_loop(weak)));
    }
}

/// 綁定新裝置時寫入最小的初始狀態（其餘由 mailbox 補齊）。
pub(crate) fn write_initial_state(
    store: &DocStore,
    trust: TrustStore,
    cert: Signed<DeviceCert>,
) -> Result<()> {
    let p = Persisted {
        roster: Some(trust.to_roster(now_ms())),
        ring: KeyRing::default().export()?.to_vec(),
        my_device_cert: Some(cert),
        ..Default::default()
    };
    store.write_secret_file("state", &postcard::to_allocvec(&p)?)?;
    Ok(())
}

fn read_held(store: &DocStore) -> Vec<(String, SignedChange)> {
    store
        .read_secret_file("held")
        .ok()
        .flatten()
        .and_then(|raw| postcard::from_bytes(&raw).ok())
        .unwrap_or_default()
}
