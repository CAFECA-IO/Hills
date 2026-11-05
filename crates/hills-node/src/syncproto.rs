//! 直連同步協定 `hills/sync/1`（technical-design §16.5）。

use std::sync::{Arc, Weak};

use anyhow::{Result, anyhow};
use hills_net::{recv_message, remote_node, request, send_message};
use hills_proto::Pub32;
use hills_proto::sync::{ALPN, MAX_FRAME, SyncRequest, SyncResponse};
use iroh::PublicKey;
use iroh::endpoint::Connection;

use crate::node::{Inner, lock};
use crate::policy;

#[derive(Clone)]
pub(crate) struct SyncProto(pub Weak<Inner>);

impl std::fmt::Debug for SyncProto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SyncProto")
    }
}

fn respond(inner: &Arc<Inner>, node: &Pub32, req: SyncRequest) -> SyncResponse {
    let who = {
        let st = lock(&inner.st);
        match st.trust.verify_device(node) {
            Ok(w) => w,
            Err(_) => return SyncResponse::Forbidden,
        }
    };
    match req {
        SyncRequest::Pull { doc_id, heads } => {
            let mut st = lock(&inner.st);
            let dir = inner.org_snapshot(&mut st);
            if !policy::can_read(&doc_id, &who, &dir) {
                return SyncResponse::Forbidden;
            }
            match inner.load_doc(&mut st.docs, &doc_id) {
                Ok(local) => SyncResponse::Changes(local.signed_since(&doc_id, &heads)),
                Err(_) => SyncResponse::NotFound,
            }
        }
        SyncRequest::Push { doc_id, changes } => match inner.apply_remote(&doc_id, &changes) {
            Ok(_) => SyncResponse::Ok,
            Err(e) => SyncResponse::Error(e.to_string()),
        },
    }
}

impl iroh::protocol::ProtocolHandler for SyncProto {
    async fn accept(&self, conn: Connection) -> Result<(), iroh::protocol::AcceptError> {
        let node = remote_node(&conn);
        while let Ok((mut send, mut recv)) = conn.accept_bi().await {
            let Some(inner) = self.0.upgrade() else { break };
            let resp = match recv_message::<SyncRequest>(&mut recv, MAX_FRAME).await {
                Ok(req) => respond(&inner, &node, req),
                Err(_) => SyncResponse::Error("無法解析請求".into()),
            };
            if send_message(&mut send, &resp).await.is_err() {
                break;
            }
        }
        Ok(())
    }
}

/// 向指定裝置拉取我缺少的 change。
pub(crate) async fn pull(inner: &Arc<Inner>, device: Pub32, doc_id: &str) -> Result<usize> {
    if device == inner.secrets.device.public() {
        return Ok(0);
    }
    let heads = {
        let mut st = lock(&inner.st);
        inner.load_doc(&mut st.docs, doc_id)?.heads()
    };
    let id = PublicKey::from_bytes(&device.0).map_err(|_| anyhow!("NodeId 無效"))?;
    let conn = inner
        .endpoint
        .connect(id, ALPN)
        .await
        .map_err(|e| anyhow!("連線失敗：{e}"))?;
    let resp: SyncResponse = request(
        &conn,
        &SyncRequest::Pull {
            doc_id: doc_id.to_owned(),
            heads,
        },
        MAX_FRAME,
    )
    .await?;
    conn.close(0u32.into(), b"done");
    match resp {
        SyncResponse::Changes(c) => inner.apply_remote(doc_id, &c),
        other => Err(anyhow!("pull 失敗：{other:?}")),
    }
}
