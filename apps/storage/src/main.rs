//! hills-storage 執行檔（technical-design §15.6 v0.12）。
//!
//! 環境變數：
//! - `HILLS_NODE_INDEX`：節點編號 0–7（必填）
//! - `HILLS_DATA_DIR`：資料目錄（預設 `./data`），含 `node.key`、`index.sqlite`、`objects/`
//! - `HILLS_UDP_PORT`：iroh 固定 UDP 埠（預設 7850 + 編號）
//! - `HILLS_PUBLIC_ADDR`：對外位址（例如 `203.0.113.5:7850`），寫入連線碼
//! - `HILLS_RELAY`：自架 iroh-relay URL；`HILLS_NO_RELAY=1` 停用（本機測試）
//! - `HILLS_STORAGE_CODES_DIR`：連線碼寫入的資料夾（與 mailbox 共用的 volume）
//! - `HILLS_QUOTA_BYTES`：每位成員在本節點的配額（預設 20 GB）
//! - `HILLS_ORG_ROOT_PUB`（選填）：組織根金鑰 OK 公鑰（64 位 hex）
//! - `HILLS_LISTEN`：健康檢查 HTTP 位址（預設 `0.0.0.0:8080`）

use std::path::{Path, PathBuf};

use anyhow::Context;
use axum::{Json, Router, routing::get};
use hills_proto::Pub32;
use hills_proto::ticket::{StorageTicket, Ticket};
use hills_storage::{DEFAULT_QUOTA, STORAGE_ALPN, Storage, serve};
use iroh::{Endpoint, RelayMode, SecretKey, endpoint::presets};
use serde_json::{Value, json};

const SERVICE: &str = "hills-storage";
const PORT_BASE: u16 = 7850;

fn app() -> Router {
    Router::new().route("/v1/health", get(health))
}

async fn health() -> Json<Value> {
    Json(json!({ "service": SERVICE, "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn parse_pub(hex: &str) -> anyhow::Result<Pub32> {
    let bytes = data_encoding::HEXLOWER_PERMISSIVE
        .decode(hex.as_bytes())
        .context("HILLS_ORG_ROOT_PUB 不是 hex")?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("HILLS_ORG_ROOT_PUB 必須是 32 bytes"))?;
    Ok(Pub32(arr))
}

/// 讀取或產生節點自己的 iroh 金鑰（權限 0600）。
fn node_key(dir: &Path) -> anyhow::Result<SecretKey> {
    let path = dir.join("node.key");
    if let Ok(bytes) = std::fs::read(&path) {
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("node.key 格式錯誤"))?;
        return Ok(SecretKey::from_bytes(&arr));
    }
    let key = SecretKey::generate();
    std::fs::write(&path, key.to_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(key)
}

fn current_addr(endpoint: &Endpoint) -> hills_proto::PeerAddr {
    let mut peer = hills_net::to_peer_addr(&endpoint.addr());
    peer.direct.sort();
    if let Some(public) = env("HILLS_PUBLIC_ADDR") {
        peer.direct.retain(|a| a != &public);
        peer.direct.insert(0, public);
    }
    peer
}

/// 位址改變時寫入連線碼（不是機密，只含位址）。
fn publish(endpoint: &Endpoint, index: u8, codes: Option<&Path>, last: &mut String) {
    let code = match StorageTicket::new(index, current_addr(endpoint)).to_code() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, "無法產生連線碼");
            return;
        }
    };
    if *last == code {
        return;
    }
    if let Some(dir) = codes {
        let path = dir.join(format!("storage-{index}.txt"));
        let tmp = dir.join(format!(".storage-{index}.tmp"));
        if let Err(e) =
            std::fs::write(&tmp, format!("{code}\n")).and_then(|_| std::fs::rename(&tmp, &path))
        {
            tracing::warn!(error = %e, "無法寫入連線碼");
            return;
        }
    }
    println!("儲存節點 {index} 連線碼：{code}");
    *last = code;
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let index: u8 = env("HILLS_NODE_INDEX")
        .context("請設定 HILLS_NODE_INDEX（0–7）")?
        .parse()
        .context("HILLS_NODE_INDEX 不是數字")?;
    anyhow::ensure!(index < 32, "HILLS_NODE_INDEX 超出範圍");
    let port: u16 = env("HILLS_UDP_PORT")
        .map(|v| v.parse().context("HILLS_UDP_PORT 不是有效埠號"))
        .transpose()?
        .unwrap_or(PORT_BASE + u16::from(index));
    let quota: u64 = env("HILLS_QUOTA_BYTES")
        .map(|v| v.parse().context("HILLS_QUOTA_BYTES 不是數字"))
        .transpose()?
        .unwrap_or(DEFAULT_QUOTA);
    let org_root = env("HILLS_ORG_ROOT_PUB")
        .map(|v| parse_pub(&v))
        .transpose()?;
    let data = PathBuf::from(env("HILLS_DATA_DIR").unwrap_or_else(|| "data".into()));
    std::fs::create_dir_all(&data)?;
    let codes = env("HILLS_STORAGE_CODES_DIR").map(PathBuf::from);
    if let Some(dir) = &codes {
        std::fs::create_dir_all(dir)?;
    }
    let storage = Storage::open(&data, org_root, quota)?;

    let no_relay = env("HILLS_NO_RELAY").is_some_and(|v| v == "1");
    let relay = if no_relay {
        RelayMode::Disabled
    } else if let Some(url) = env("HILLS_RELAY") {
        RelayMode::custom([url.parse().context("HILLS_RELAY 不是有效 URL")?])
    } else {
        RelayMode::Default
    };
    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(node_key(&data)?)
        .relay_mode(relay)
        .alpns(vec![STORAGE_ALPN.to_vec()])
        .bind_addr(std::net::SocketAddr::from(([0, 0, 0, 0], port)))?
        .bind()
        .await?;
    if !no_relay {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(15), endpoint.online()).await;
    }
    tracing::info!(index, node_id = %endpoint.id(), claimed = storage.is_claimed(), "{SERVICE} ready");
    {
        let endpoint = endpoint.clone();
        let codes = codes.clone();
        tokio::spawn(async move {
            let mut last = String::new();
            loop {
                publish(&endpoint, index, codes.as_deref(), &mut last);
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            }
        });
    }
    {
        // 每日清除過期物件
        let storage = storage.clone();
        tokio::spawn(async move {
            loop {
                let s = storage.clone();
                let n = tokio::task::spawn_blocking(move || s.sweep(hills_now()))
                    .await
                    .unwrap_or(0);
                if n > 0 {
                    tracing::info!(removed = n, "已清除過期分片");
                }
                tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
            }
        });
    }
    let router = serve(endpoint, storage);

    let addr = env("HILLS_LISTEN").unwrap_or_else(|| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    router.shutdown().await?;
    Ok(())
}

fn hills_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_reports_ok() {
        let res = app()
            .oneshot(Request::get("/v1/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(res.status().is_success());
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["service"], SERVICE);
    }
}
