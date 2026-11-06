//! 新裝置綁定（technical-design §16.3）。
//!
//! 新裝置：[`LinkListener::start`] 顯示綁定碼 → 等待舊裝置連線 → 顯示 SAS → 收到身分後完成。
//! 舊裝置：[`Node::link_device`] 連線 → 顯示 SAS → 使用者確認一致後 [`LinkSession::confirm`]。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use hills_crypto::exchange::Ephemeral;
use hills_crypto::{SymmetricKey, open, seal};
use hills_identity::RecoveryPhrase;
use hills_identity::cert::DeviceKey;
use hills_identity::secret_store::SecretStore;
use hills_identity::trust::TrustStore;
use hills_net::{recv_message, request, send_message, to_endpoint_addr, to_peer_addr};
use hills_proto::link::{ALPN, LinkPayload, LinkRequest, LinkResponse};
use hills_proto::ticket::{LinkTicket, OrgTicket, Ticket};
use hills_proto::{FORMAT_VERSION, Pub32};
use iroh::endpoint::Connection;
use iroh::{Endpoint, RelayMode, SecretKey, endpoint::presets};
use tokio::sync::{oneshot, watch};
use zeroize::Zeroizing;

use crate::config::{MemberStatus, NodeConfig, Secrets};
use crate::node::{Node, NodeOptions, lock, now_ms};

const LINK_AAD: &[u8] = b"hills/v1/link-payload";
const MAX_LINK_MSG: usize = 64 * 1024;

/// 新裝置端：等待舊裝置傳送身分。
pub struct LinkListener {
    /// 顯示給使用者（文字碼 / QR），在舊裝置貼上
    pub code: String,
    /// 舊裝置連上後出現 SAS
    pub sas: watch::Receiver<Option<String>>,
    done: oneshot::Receiver<Result<()>>,
    endpoint: Endpoint,
    dir: PathBuf,
    secret_store: Arc<dyn SecretStore>,
    opts: NodeOptions,
}

struct Pending {
    device: DeviceKey,
    eph: Ephemeral,
    org: OrgTicket,
    device_name: String,
}

impl LinkListener {
    pub async fn start(
        dir: &Path,
        secret_store: Arc<dyn SecretStore>,
        org_code: &str,
        device_name: &str,
        opts: NodeOptions,
    ) -> Result<Self> {
        if NodeConfig::load(dir)?.is_some() {
            bail!("此裝置已加入組織");
        }
        let org = OrgTicket::from_code(org_code).context("組織連線碼無效")?;
        let device = DeviceKey::generate()?;
        let eph = Ephemeral::generate()?;
        let relay = match &org.mailbox.relay {
            Some(u) => RelayMode::custom([u.parse().context("relay URL 無效")?]),
            // 不用 Disabled：之後才取得的 relay 需能以 insert_relay 加入（§16.1）
            None => RelayMode::Custom(iroh::RelayMap::empty()),
        };
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::from_bytes(&device.secret_bytes()))
            .relay_mode(relay)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await?;
        if org.mailbox.relay.is_some() {
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(10), endpoint.online()).await;
        }
        let code = LinkTicket {
            v: FORMAT_VERSION,
            device: to_peer_addr(&endpoint.addr()),
            eph_pub: eph.public(),
        }
        .to_code()?;
        let (sas_tx, sas) = watch::channel(None);
        let (done_tx, done) = oneshot::channel();
        let pending = Pending {
            device,
            eph,
            org,
            device_name: device_name.to_owned(),
        };
        let ep = endpoint.clone();
        let d = dir.to_owned();
        let ss = secret_store.clone();
        tokio::spawn(async move {
            let r = match ep.accept().await {
                Some(incoming) => match incoming.await {
                    Ok(conn) => serve(conn, pending, &d, &ss, sas_tx).await,
                    Err(e) => Err(anyhow!("連線失敗：{e}")),
                },
                None => Err(anyhow!("已取消")),
            };
            let _ = done_tx.send(r);
        });
        Ok(Self {
            code,
            sas,
            done,
            endpoint,
            dir: dir.to_owned(),
            secret_store,
            opts,
        })
    }

    /// 等待綁定完成並啟動節點。
    pub async fn finish(self) -> Result<Node> {
        let r = self.done.await.map_err(|_| anyhow!("綁定中斷"))?;
        self.endpoint.close().await;
        r?;
        Node::open(&self.dir, self.secret_store, self.opts)
            .await?
            .ok_or_else(|| anyhow!("綁定後找不到設定"))
    }

    pub async fn cancel(self) {
        self.endpoint.close().await;
    }
}

async fn serve(
    conn: Connection,
    p: Pending,
    dir: &Path,
    ss: &Arc<dyn SecretStore>,
    sas_tx: watch::Sender<Option<String>>,
) -> Result<()> {
    let mut channel_key: Option<SymmetricKey> = None;
    while let Ok((mut send, mut recv)) = conn.accept_bi().await {
        let req: LinkRequest = recv_message(&mut recv, MAX_LINK_MSG).await?;
        match req {
            LinkRequest::Begin { eph_pub } => {
                let (sas, key) = p.eph.link_channel(&eph_pub, &eph_pub, &p.eph.public());
                channel_key = Some(key);
                let _ = sas_tx.send(Some(sas));
                send_message(&mut send, &LinkResponse::Ready).await?;
            }
            LinkRequest::Deliver { nonce, ciphertext } => {
                let key = channel_key.as_ref().ok_or_else(|| anyhow!("尚未開始"))?;
                let result = (|| -> Result<()> {
                    let plain = Zeroizing::new(open(key, LINK_AAD, &nonce, &ciphertext)?);
                    let payload: LinkPayload = postcard::from_bytes(&plain)?;
                    let phrase = RecoveryPhrase::from_entropy(&payload.entropy);
                    let keys = phrase.derive_keys();
                    let cert = &payload.device_cert;
                    if cert.body.device_pub != p.device.public()
                        || cert.signer != Pub32(keys.identity_public().to_bytes())
                        || payload.org_root != p.org.org_root
                    {
                        bail!("收到的身分與本裝置不符");
                    }
                    hills_identity::cert::verify_signature(cert)?;
                    let secrets = Secrets {
                        phrase,
                        keys,
                        device: DeviceKey::from_secret_bytes(&p.device.secret_bytes()),
                        storage_key: SymmetricKey::generate()?,
                    };
                    secrets.save(ss)?;
                    let cfg = NodeConfig {
                        org_root: payload.org_root,
                        mailbox: payload.mailbox.clone(),
                        member_id: secrets.keys.member_id(),
                        device_name: p.device_name.clone(),
                        status: MemberStatus::Active,
                        bundle_cursor: 0,
                        keys_cursor: 0,
                        storage: vec![],
                    };
                    // 寫入最小狀態，Node::open 會從 mailbox 補齊其餘資料
                    let store = hills_store::DocStore::open(dir, secrets.storage_key.clone())?;
                    crate::node::write_initial_state(
                        &store,
                        TrustStore::new(payload.org_root),
                        cert.clone(),
                    )?;
                    cfg.save(dir)?;
                    Ok(())
                })();
                let resp = match &result {
                    Ok(()) => LinkResponse::Accepted,
                    Err(e) => LinkResponse::Rejected(e.to_string()),
                };
                send_message(&mut send, &resp).await?;
                let _ = send.stopped().await;
                return result;
            }
            LinkRequest::Abort => {
                send_message(&mut send, &LinkResponse::Rejected("已取消".into())).await?;
                bail!("舊裝置取消綁定");
            }
        }
    }
    bail!("連線中斷")
}

/// 舊裝置端的綁定流程。
pub struct LinkSession {
    pub sas: String,
    conn: Connection,
    key: SymmetricKey,
    new_device: Pub32,
    node: Node,
}

impl Node {
    /// 連線到新裝置並計算 SAS；使用者確認兩邊數字一致後呼叫 [`LinkSession::confirm`]。
    pub async fn link_device(&self, link_code: &str) -> Result<LinkSession> {
        let t = LinkTicket::from_code(link_code).context("綁定碼無效")?;
        let eph = Ephemeral::generate()?;
        let (sas, key) = eph.link_channel(&t.eph_pub, &eph.public(), &t.eph_pub);
        let conn = self
            .inner
            .endpoint
            .connect(to_endpoint_addr(&t.device)?, ALPN)
            .await
            .map_err(|e| anyhow!("無法連線到新裝置：{e}"))?;
        match request::<_, LinkResponse>(
            &conn,
            &LinkRequest::Begin {
                eph_pub: eph.public(),
            },
            MAX_LINK_MSG,
        )
        .await?
        {
            LinkResponse::Ready => {}
            other => bail!("新裝置拒絕：{other:?}"),
        }
        Ok(LinkSession {
            sas,
            conn,
            key,
            new_device: t.device.node,
            node: self.clone(),
        })
    }
}

impl LinkSession {
    /// 使用者確認 SAS 一致：簽發新裝置憑證、上傳 mailbox、把身分傳給新裝置。
    pub async fn confirm(self, device_name: &str) -> Result<()> {
        let inner = &self.node.inner;
        let cert = inner
            .secrets
            .keys
            .issue_device_cert(&self.new_device, device_name, now_ms())?;
        {
            let mut st = lock(&inner.st);
            st.trust.add_device_cert(cert.clone())?;
            inner.persist(&st)?;
        }
        {
            let g = self.node.mailbox_guard().await?;
            g.as_ref()
                .ok_or_else(|| anyhow!("mailbox"))?
                .put_device(cert.clone())
                .await?;
        }
        let (org_root, mailbox) = {
            let cfg = lock(&inner.cfg);
            (cfg.org_root, cfg.mailbox.clone())
        };
        let payload = LinkPayload {
            v: FORMAT_VERSION,
            entropy: *inner.secrets.phrase.entropy(),
            org_root,
            mailbox,
            device_cert: cert,
        };
        let plain = Zeroizing::new(postcard::to_allocvec(&payload)?);
        let (nonce, ciphertext) = seal(&self.key, LINK_AAD, &plain)?;
        let resp: LinkResponse = request(
            &self.conn,
            &LinkRequest::Deliver { nonce, ciphertext },
            MAX_LINK_MSG,
        )
        .await?;
        self.conn.close(0u32.into(), b"done");
        crate::gossip::broadcast(inner, hills_proto::gossip::GossipMsg::RosterChanged).await;
        match resp {
            LinkResponse::Accepted => Ok(()),
            other => bail!("新裝置未接受：{other:?}"),
        }
    }

    pub async fn cancel(self) {
        let _ = request::<_, LinkResponse>(&self.conn, &LinkRequest::Abort, MAX_LINK_MSG).await;
        self.conn.close(0u32.into(), b"cancel");
    }
}
