//! 儲存節點連線池（technical-design §15.6 v0.12、D39）：只轉送前端已加密、RS 編碼的密文分片。
//!
//! 節點清單由 mailbox `Services` 取得並保存在 `node.json`；每個節點保持一條已 Hello 的連線。
//! 管理者裝置在 roster 變更後推送給每個節點。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use hills_net::storage::StorageClient;
use hills_net::to_endpoint_addr;
use hills_proto::PeerAddr;
use hills_proto::mailbox::Hello;
use hills_proto::storage::{MAX_RETENTION_MS, MAX_SHARD};

use crate::node::{Inner, Node, lock, now_ms};

#[derive(Default)]
pub(crate) struct StoragePool {
    conns: tokio::sync::Mutex<HashMap<u8, Arc<StorageClient>>>,
    /// 每個節點最後推送的 roster 摘要（避免每次同步重送）
    pushed: std::sync::Mutex<HashMap<u8, [u8; 32]>>,
    /// 最近連線失敗的節點：短時間內直接回報失敗，讓下載改抓其他分片
    down: std::sync::Mutex<HashMap<u8, Instant>>,
}

/// 連線逾時
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// 連線失敗後多久內不再嘗試
const DOWN_FOR: Duration = Duration::from_secs(20);

fn hello(inner: &Inner) -> Hello {
    let st = lock(&inner.st);
    Hello {
        device_cert: st.my_device_cert.clone(),
        member_cert: st.trust.member_cert(&inner.me()).cloned(),
    }
}

impl Inner {
    fn storage_addr(&self, index: u8) -> Option<PeerAddr> {
        lock(&self.cfg)
            .storage
            .iter()
            .find(|(i, _)| *i == index)
            .map(|(_, a)| a.clone())
    }

    async fn storage_client(&self, index: u8) -> Result<Arc<StorageClient>> {
        let mut conns = self.storage.conns.lock().await;
        if let Some(c) = conns.get(&index)
            && !c.is_closed()
        {
            return Ok(c.clone());
        }
        let recently_down = self
            .storage
            .down
            .lock()
            .ok()
            .and_then(|d| d.get(&index).copied())
            .is_some_and(|t| t.elapsed() < DOWN_FOR);
        if recently_down {
            return Err(anyhow!("儲存節點 {index} 暫時無法連線"));
        }
        let addr = self
            .storage_addr(index)
            .ok_or_else(|| anyhow!("沒有編號 {index} 的儲存節點"))?;
        let ep = to_endpoint_addr(&addr)?;
        self.memory.add_endpoint_info(ep.clone());
        let res = tokio::time::timeout(
            CONNECT_TIMEOUT,
            StorageClient::connect(&self.endpoint, ep, hello(self)),
        )
        .await;
        let c = match res {
            Ok(Ok(c)) => Arc::new(c),
            Ok(Err(hills_net::NetError::Remote(m))) => {
                return Err(anyhow!("儲存節點 {index} 拒絕連線：{m}"));
            }
            failed => {
                if let Ok(mut d) = self.storage.down.lock() {
                    d.insert(index, Instant::now());
                }
                let reason = match failed {
                    Ok(Err(e)) => e.to_string(),
                    _ => "逾時".into(),
                };
                return Err(anyhow!("無法連線儲存節點 {index}：{reason}"));
            }
        };
        if let Ok(mut d) = self.storage.down.lock() {
            d.remove(&index);
        }
        conns.insert(index, c.clone());
        Ok(c)
    }

    async fn drop_client(&self, index: u8) {
        self.storage.conns.lock().await.remove(&index);
    }

    /// 依 mailbox `Services` 更新節點清單；清單改變時關閉舊連線。
    pub(crate) async fn apply_services(&self, list: Vec<(u8, PeerAddr)>) -> Result<()> {
        let changed = {
            let mut cfg = lock(&self.cfg);
            if cfg.storage == list {
                false
            } else {
                cfg.storage = list.clone();
                true
            }
        };
        if changed {
            self.save_cfg()?;
            self.storage.conns.lock().await.clear();
            if let Ok(mut p) = self.storage.pushed.lock() {
                p.clear();
            }
            tracing::info!(nodes = list.len(), "儲存節點清單已更新");
        }
        // 節點的 relay 若與 mailbox 不同，加入執行中的 endpoint
        for (_, a) in &list {
            if let Some(url) = a
                .relay
                .as_ref()
                .and_then(|r| r.parse::<iroh::RelayUrl>().ok())
            {
                self.endpoint
                    .insert_relay(url.clone(), Arc::new(url.into()))
                    .await;
            }
        }
        Ok(())
    }

    /// 管理者裝置：roster 有變動時推送給每個節點（失敗的節點下次同步再試）。
    pub(crate) async fn push_roster_to_storage(&self) {
        let (roster, digest) = {
            let st = lock(&self.st);
            let body = st.trust.to_roster(0);
            let digest = hills_proto::encode(&body)
                .map(|b| *blake3::hash(&b).as_bytes())
                .unwrap_or([0; 32]);
            let signed = self.secrets.device.sign_body(st.trust.to_roster(now_ms()));
            (signed, digest)
        };
        let Ok(roster) = roster else { return };
        let nodes: Vec<u8> = lock(&self.cfg).storage.iter().map(|(i, _)| *i).collect();
        for i in nodes {
            let done = self
                .storage
                .pushed
                .lock()
                .map(|p| p.get(&i) == Some(&digest))
                .unwrap_or(false);
            if done {
                continue;
            }
            let ok = match self.storage_client(i).await {
                Ok(c) => c.put_roster(roster.clone()).await.is_ok(),
                Err(_) => false,
            };
            if ok && let Ok(mut p) = self.storage.pushed.lock() {
                p.insert(i, digest);
            }
        }
    }
}

impl Node {
    /// 目前已知的儲存節點編號（由小到大）。
    pub fn storage_nodes(&self) -> Vec<u8> {
        let mut v: Vec<u8> = lock(&self.inner.cfg)
            .storage
            .iter()
            .map(|(i, _)| *i)
            .collect();
        v.sort_unstable();
        v
    }

    async fn with_retry<T, F, Fut>(&self, node: u8, f: F) -> Result<T>
    where
        F: Fn(Arc<StorageClient>) -> Fut,
        Fut: std::future::Future<Output = Result<T, hills_net::NetError>>,
    {
        let c = self.inner.storage_client(node).await?;
        match f(c).await {
            Ok(v) => Ok(v),
            Err(hills_net::NetError::Remote(m)) => Err(anyhow!("儲存節點 {node}：{m}")),
            Err(_) => {
                // 連線中斷：重連一次
                self.inner.drop_client(node).await;
                let c = self.inner.storage_client(node).await?;
                f(c).await.map_err(|e| anyhow!("儲存節點 {node}：{e}"))
            }
        }
    }

    /// 上傳一個密文分片（保存 1 年，D16）。
    pub async fn put_shard(&self, node: u8, id: [u8; 32], data: Vec<u8>) -> Result<()> {
        if data.is_empty() || data.len() > MAX_SHARD {
            return Err(anyhow!("分片大小超出範圍"));
        }
        let exp = now_ms() + MAX_RETENTION_MS - 24 * 3600 * 1000;
        self.with_retry(node, |c| {
            let data = data.clone();
            async move { c.put(id, data, exp).await }
        })
        .await
        .map(|_| ())
    }

    pub async fn has_shards(&self, node: u8, ids: Vec<[u8; 32]>) -> Result<Vec<bool>> {
        self.with_retry(node, |c| {
            let ids = ids.clone();
            async move { c.has(&ids).await }
        })
        .await
    }

    pub async fn get_shard(&self, node: u8, id: [u8; 32]) -> Result<Vec<u8>> {
        self.with_retry(node, |c| async move { c.get(id).await })
            .await
    }
}
