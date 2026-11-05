//! iroh 網路層（technical-design §5）。
//!
//! 每個請求使用一條雙向 QUIC 串流：送出 postcard 編碼的請求後關閉送出端，對方讀到結尾、
//! 處理後回傳一個回應並關閉。不需要額外的長度前綴。

pub mod mailbox;

use hills_proto::{PeerAddr, ProtoError, Pub32};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::{EndpointAddr, PublicKey, RelayUrl, TransportAddr};
use serde::{Serialize, de::DeserializeOwned};

#[derive(Debug, thiserror::Error)]
pub enum NetError {
    #[error("連線失敗：{0}")]
    Connect(String),
    #[error("傳輸錯誤：{0}")]
    Stream(String),
    #[error("訊息過大")]
    TooLarge,
    #[error("協定錯誤：{0}")]
    Proto(#[from] ProtoError),
    #[error("伺服器回應錯誤：{0}")]
    Remote(String),
}

pub fn stream_err(e: impl std::fmt::Display) -> NetError {
    NetError::Stream(e.to_string())
}

/// iroh 位址 → 協定用的 `PeerAddr`。
pub fn to_peer_addr(addr: &EndpointAddr) -> PeerAddr {
    PeerAddr {
        node: Pub32(*addr.id.as_bytes()),
        relay: addr.relay_urls().next().map(|u| u.to_string()),
        direct: addr.ip_addrs().map(|a| a.to_string()).collect(),
    }
}

/// `PeerAddr` → iroh 位址；格式錯誤的項目略過。
pub fn to_endpoint_addr(p: &PeerAddr) -> Result<EndpointAddr, NetError> {
    let id =
        PublicKey::from_bytes(&p.node.0).map_err(|_| NetError::Connect("NodeId 無效".into()))?;
    let relay = p
        .relay
        .iter()
        .filter_map(|r| r.parse::<RelayUrl>().ok())
        .map(TransportAddr::Relay);
    let direct = p
        .direct
        .iter()
        .filter_map(|a| a.parse().ok())
        .map(TransportAddr::Ip);
    Ok(EndpointAddr::from_parts(id, relay.chain(direct)))
}

/// 連線對方的 NodeId（= 對方裝置的 DK 公鑰）。
pub fn remote_node(conn: &Connection) -> Pub32 {
    Pub32(*conn.remote_id().as_bytes())
}

pub async fn send_message<T: Serialize>(send: &mut SendStream, msg: &T) -> Result<(), NetError> {
    let bytes = hills_proto::encode(msg)?;
    send.write_all(&bytes).await.map_err(stream_err)?;
    send.finish().map_err(stream_err)?;
    Ok(())
}

pub async fn recv_message<T: DeserializeOwned>(
    recv: &mut RecvStream,
    max: usize,
) -> Result<T, NetError> {
    let bytes = recv.read_to_end(max).await.map_err(|e| {
        if e.to_string().contains("too long") {
            NetError::TooLarge
        } else {
            stream_err(e)
        }
    })?;
    postcard::from_bytes(&bytes).map_err(|_| NetError::Proto(ProtoError::Decode))
}

/// 開一條串流送出請求並等待回應。
pub async fn request<Req: Serialize, Resp: DeserializeOwned>(
    conn: &Connection,
    req: &Req,
    max_response: usize,
) -> Result<Resp, NetError> {
    let (mut send, mut recv) = conn.open_bi().await.map_err(stream_err)?;
    send_message(&mut send, req).await?;
    recv_message(&mut recv, max_response).await
}
