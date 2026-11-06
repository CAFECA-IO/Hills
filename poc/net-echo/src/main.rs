//! PoC：iroh 跨 NAT 連線測試工具（technical-design §12、Issue「[M0][PoC] iroh 跨 NAT 連線驗證」）。
//!
//! ```text
//! # 電腦 A
//! cargo run --release -p net-echo -- listen
//! # 電腦 B（貼上 A 印出的 ticket）
//! cargo run --release -p net-echo -- dial <ticket> --count 20
//! ```
//!
//! `--relay <url>` 改用自架 iroh-relay（deploy/poc/）；`--no-relay` 只用直連（本機測試用）。
//! dial 結束時輸出一行 JSON，可直接貼進 docs/poc-report.md 的測試矩陣。

use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use iroh::{
    Endpoint, EndpointAddr, RelayMode, RelayUrl,
    endpoint::{Connection, presets},
};
use serde_json::json;

const ALPN: &[u8] = b"hills/poc/echo/1";
const MAX_MSG: usize = 1024 * 1024;

#[derive(Parser)]
#[command(about = "iroh 連線測試：listen / dial")]
struct Cli {
    /// 使用自架 iroh-relay，例如 https://relay.example.com
    #[arg(long, global = true)]
    relay: Option<RelayUrl>,
    /// 停用 relay，只嘗試直連
    #[arg(long, global = true)]
    no_relay: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 等待連線並回傳收到的資料
    Listen,
    /// 連線到 listen 端並量測往返時間
    Dial {
        ticket: String,
        #[arg(long, default_value_t = 10)]
        count: u32,
        /// 每次傳送的位元組數
        #[arg(long, default_value_t = 1024)]
        size: usize,
    },
}

#[derive(Clone)]
enum Relay {
    Default,
    Custom(RelayUrl),
    Disabled,
}

async fn bind(relay: &Relay) -> Result<Endpoint> {
    let builder = match relay {
        Relay::Default => Endpoint::builder(presets::N0),
        Relay::Custom(url) => {
            Endpoint::builder(presets::N0).relay_mode(RelayMode::custom([url.clone()]))
        }
        Relay::Disabled => Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled),
    };
    let ep = builder.alpns(vec![ALPN.to_vec()]).bind().await?;
    if !matches!(relay, Relay::Disabled) {
        // 等待連上 relay；超時仍可用直連位址
        let _ = tokio::time::timeout(Duration::from_secs(10), ep.online()).await;
    }
    Ok(ep)
}

fn encode_ticket(addr: &EndpointAddr) -> Result<String> {
    Ok(data_encoding::BASE64URL_NOPAD.encode(&serde_json::to_vec(addr)?))
}

fn decode_ticket(t: &str) -> Result<EndpointAddr> {
    let raw = data_encoding::BASE64URL_NOPAD
        .decode(t.trim().as_bytes())
        .context("ticket 格式錯誤")?;
    Ok(serde_json::from_slice(&raw)?)
}

/// 接受連線，把每個雙向串流收到的資料原樣送回。
async fn serve(ep: Endpoint) -> Result<()> {
    while let Some(incoming) = ep.accept().await {
        tokio::spawn(async move {
            let Ok(conn) = async { anyhow::Ok(incoming.accept()?.await?) }.await else {
                return;
            };
            println!("連線：{}", conn.remote_id());
            while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                let Ok(data) = recv.read_to_end(MAX_MSG).await else {
                    break;
                };
                if send.write_all(&data).await.is_err() || send.finish().is_err() {
                    break;
                }
            }
        });
    }
    Ok(())
}

struct Report {
    connect: Duration,
    rtts: Vec<Duration>,
    path: &'static str,
    remote: String,
}

async fn dial(ep: &Endpoint, addr: EndpointAddr, count: u32, size: usize) -> Result<Report> {
    let t0 = Instant::now();
    let conn = ep.connect(addr, ALPN).await?;
    let connect = t0.elapsed();
    let payload = vec![0x5au8; size];
    let mut rtts = Vec::new();
    for _ in 0..count {
        let t = Instant::now();
        let (mut send, mut recv) = conn.open_bi().await?;
        send.write_all(&payload).await?;
        send.finish()?;
        let echoed = recv.read_to_end(MAX_MSG).await?;
        if echoed != payload {
            bail!("回傳內容不符");
        }
        rtts.push(t.elapsed());
    }
    let (path, remote) = selected_path(&conn);
    conn.close(0u32.into(), b"done");
    Ok(Report {
        connect,
        rtts,
        path,
        remote,
    })
}

fn selected_path(conn: &Connection) -> (&'static str, String) {
    let paths = conn.paths();
    let sel = paths.iter().find(|p| p.is_selected());
    match sel {
        Some(p) if p.is_relay() => ("relay", format!("{:?}", p.remote_addr())),
        Some(p) => ("direct", format!("{:?}", p.remote_addr())),
        None => ("unknown", String::new()),
    }
}

fn median_ms(v: &[Duration]) -> f64 {
    let mut ms: Vec<f64> = v.iter().map(|d| d.as_secs_f64() * 1000.0).collect();
    ms.sort_by(f64::total_cmp);
    ms.get(ms.len() / 2).copied().unwrap_or(0.0)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .init();
    let cli = Cli::parse();
    let relay = match (cli.no_relay, cli.relay) {
        (true, _) => Relay::Disabled,
        (false, Some(u)) => Relay::Custom(u),
        (false, None) => Relay::Default,
    };
    let ep = bind(&relay).await?;
    match cli.cmd {
        Cmd::Listen => {
            let addr = ep.addr();
            println!("endpoint id：{}", ep.id());
            println!("ticket：\n{}\n", encode_ticket(&addr)?);
            println!("在另一台電腦執行：cargo run --release -p net-echo -- dial <ticket>");
            tokio::select! {
                r = serve(ep.clone()) => r?,
                _ = tokio::signal::ctrl_c() => {},
            }
        }
        Cmd::Dial {
            ticket,
            count,
            size,
        } => {
            let r = dial(&ep, decode_ticket(&ticket)?, count, size).await?;
            let out = json!({
                "connect_ms": r.connect.as_secs_f64() * 1000.0,
                "rtt_median_ms": median_ms(&r.rtts),
                "count": r.rtts.len(),
                "size": size,
                "path": r.path,
                "remote": r.remote,
            });
            println!("{out}");
        }
    }
    ep.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_direct_echo() {
        let server = bind(&Relay::Disabled).await.unwrap();
        let ticket = encode_ticket(&server.addr()).unwrap();
        tokio::spawn(serve(server.clone()));
        let client = bind(&Relay::Disabled).await.unwrap();
        let r = dial(&client, decode_ticket(&ticket).unwrap(), 5, 4096)
            .await
            .unwrap();
        assert_eq!(r.rtts.len(), 5);
        assert_eq!(r.path, "direct");
        client.close().await;
        server.close().await;
    }

    #[test]
    fn bad_ticket_is_rejected() {
        assert!(decode_ticket("@@@").is_err());
    }
}
