//! hills-mailbox 執行檔。
//!
//! 環境變數：
//! - `HILLS_ORG_ROOT_PUB`（選填）：組織根金鑰 OK 公鑰（64 位 hex）；未設定時為「未綁定」，
//!   由第一位組織管理者連線時綁定（technical-design §16.9）
//! - `HILLS_DATA_DIR`：資料目錄（預設 `./data`），含 `node.key`、`index.sqlite`、`blobs/`、
//!   `mailbox-code.txt`
//! - `HILLS_UDP_PORT`：iroh 固定 UDP 埠（預設 7843）
//! - `HILLS_PUBLIC_ADDR`：對外位址（例如 `203.0.113.5:7843`），寫入 mailbox 連線碼
//! - `HILLS_LISTEN`：健康檢查 HTTP 位址（預設 `0.0.0.0:8080`）
//! - `HILLS_RELAY`：自架 iroh-relay URL；未設定時使用 iroh 預設 relay
//! - `HILLS_NO_RELAY=1`：停用 relay（本機測試）
//! - `HILLS_STORAGE_CODES_DIR`（選填）：儲存節點連線碼所在資料夾，回應 `Services`（technical-design §15.6）
//! - `HILLS_CAFECA_WALLET`：CAFECA 錢包網址（technical-design §17.1）；未設定時無法受理加入申請
//! - `HILLS_CAFECA_RPC`（選填）：自架鏈上 RPC，取代錢包設定檔中的 `rpcUrl`

use std::path::PathBuf;

use anyhow::Context;
use axum::{Json, Router, routing::get};
use hills_mailbox::{Mailbox, serve};
use hills_proto::Pub32;
use hills_proto::ticket::{MailboxTicket, Ticket};
use iroh::{Endpoint, RelayMode, SecretKey, endpoint::presets};
use serde_json::{Value, json};

const SERVICE: &str = "hills-mailbox";
const DEFAULT_UDP_PORT: u16 = 7843;

fn endpoint_relay_disabled() -> bool {
    std::env::var("HILLS_NO_RELAY").is_ok_and(|v| v == "1")
}

fn app() -> Router {
    Router::new().route("/v1/health", get(health))
}

async fn health() -> Json<Value> {
    Json(json!({ "service": SERVICE, "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

fn parse_pub(hex: &str) -> anyhow::Result<Pub32> {
    let bytes = data_encoding::HEXLOWER_PERMISSIVE
        .decode(hex.trim().as_bytes())
        .context("HILLS_ORG_ROOT_PUB 不是 hex")?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("HILLS_ORG_ROOT_PUB 必須是 32 bytes"))?;
    Ok(Pub32(arr))
}

/// 讀取或產生 mailbox 自己的 iroh 金鑰（權限 0600）。
fn node_key(dir: &std::path::Path) -> anyhow::Result<SecretKey> {
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

/// 目前對外位址：`HILLS_PUBLIC_ADDR` 在最前，其餘直連位址排序（避免順序變動被當成位址改變）。
fn current_addr(endpoint: &Endpoint) -> hills_proto::PeerAddr {
    let mut peer = hills_net::to_peer_addr(&endpoint.addr());
    peer.direct.sort();
    if let Ok(public) = std::env::var("HILLS_PUBLIC_ADDR") {
        let public = public.trim().to_owned();
        if !public.is_empty() {
            peer.direct.retain(|a| a != &public);
            peer.direct.insert(0, public);
        }
    }
    peer
}

/// 更新 `Info` 的位址；改變時寫入 `mailbox-code.txt` 並印出連線碼（不是機密，只含位址）。
fn publish_addr(
    endpoint: &Endpoint,
    mailbox: &Mailbox,
    data: &std::path::Path,
) -> anyhow::Result<()> {
    let peer = current_addr(endpoint);
    if mailbox.set_self_addr(peer.clone()) {
        let code = MailboxTicket::new(peer).to_code()?;
        std::fs::write(data.join("mailbox-code.txt"), format!("{code}\n"))?;
        println!("mailbox 連線碼：{code}");
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let org_root = match std::env::var("HILLS_ORG_ROOT_PUB") {
        Ok(v) if !v.trim().is_empty() => Some(parse_pub(&v)?),
        _ => None,
    };
    let port: u16 = std::env::var("HILLS_UDP_PORT")
        .ok()
        .map(|v| v.parse().context("HILLS_UDP_PORT 不是有效埠號"))
        .transpose()?
        .unwrap_or(DEFAULT_UDP_PORT);
    let data = PathBuf::from(std::env::var("HILLS_DATA_DIR").unwrap_or_else(|_| "data".into()));
    std::fs::create_dir_all(&data)?;
    let mailbox = Mailbox::open(&data, org_root)?;
    if let Ok(dir) = std::env::var("HILLS_STORAGE_CODES_DIR")
        && !dir.trim().is_empty()
    {
        mailbox.set_storage_codes_dir(PathBuf::from(dir.trim()));
    }
    match std::env::var("HILLS_CAFECA_WALLET") {
        Ok(w) if !w.trim().is_empty() => {
            let verifier =
                hills_cafeca::RpcVerifier::new(&w, std::env::var("HILLS_CAFECA_RPC").ok())
                    .context("HILLS_CAFECA_WALLET 或 HILLS_CAFECA_RPC 不是有效網址")?;
            let wallet = verifier.wallet().to_owned();
            tracing::info!(wallet = %wallet, "CAFECA 錢包");
            mailbox.set_cafeca(
                wallet,
                std::sync::Arc::new(hills_cafeca::Verifier::Rpc(verifier)),
            );
        }
        _ => tracing::warn!("未設定 HILLS_CAFECA_WALLET：無法受理加入、新裝置與還原申請"),
    }

    let relay = if endpoint_relay_disabled() {
        RelayMode::Disabled
    } else if let Ok(url) = std::env::var("HILLS_RELAY") {
        RelayMode::custom([url.parse().context("HILLS_RELAY 不是有效 URL")?])
    } else {
        RelayMode::Default
    };
    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(node_key(&data)?)
        .relay_mode(relay)
        .alpns(vec![hills_mailbox::MAILBOX_ALPN.to_vec()])
        .bind_addr(std::net::SocketAddr::from(([0, 0, 0, 0], port)))?
        .bind()
        .await?;
    if !endpoint_relay_disabled() {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(15), endpoint.online()).await;
    }
    if mailbox.is_claimed() {
        tracing::info!(node_id = %endpoint.id(), org = %mailbox.org_id(), "{SERVICE} iroh endpoint ready");
    } else {
        tracing::info!(node_id = %endpoint.id(), "{SERVICE} iroh endpoint ready（尚未綁定組織）");
    }
    publish_addr(&endpoint, &mailbox, &data)?;
    // 定期更新自身位址：relay 較晚上線或位址改變時，連線碼與 `Info` 隨之更新（§16.1）
    {
        let endpoint = endpoint.clone();
        let mailbox = mailbox.clone();
        let data = data.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                if let Err(e) = publish_addr(&endpoint, &mailbox, &data) {
                    tracing::warn!(error = %e, "無法更新 mailbox 位址");
                }
            }
        });
    }
    let router = serve(endpoint, mailbox);

    let addr = std::env::var("HILLS_LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "health endpoint listening");
    axum::serve(listener, app())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    router.shutdown().await?;
    Ok(())
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

    #[test]
    fn parses_org_root() {
        assert!(parse_pub(&"ab".repeat(32)).is_ok());
        assert!(parse_pub("zz").is_err());
        assert!(parse_pub(&"ab".repeat(31)).is_err());
    }
}
