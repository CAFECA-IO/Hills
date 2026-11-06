//! 儲存節點客戶端（ALPN `hills/storage/1`，technical-design §15.6、D39）。
//!
//! 只傳送已由前端加密、RS 編碼的密文分片；不解密、不重新編碼。

use hills_proto::mailbox::Hello;
use hills_proto::storage::{ALPN, MAX_FRAME, MAX_HAS, Request, Response};
use hills_proto::{Roster, Signed, Timestamp};
use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr};

use crate::{NetError, request};

pub struct StorageClient {
    conn: Connection,
}

fn remote(resp: Response) -> NetError {
    match resp {
        Response::Error { code, message } => NetError::Remote(format!("{code:?}: {message}")),
        other => NetError::Remote(format!("非預期的回應：{other:?}")),
    }
}

impl StorageClient {
    /// 連線並送出 Hello。
    pub async fn connect(
        endpoint: &Endpoint,
        addr: EndpointAddr,
        hello: Hello,
    ) -> Result<Self, NetError> {
        let conn = endpoint
            .connect(addr, ALPN)
            .await
            .map_err(|e| NetError::Connect(e.to_string()))?;
        let client = Self { conn };
        match client.call(&Request::Hello(Box::new(hello))).await? {
            Response::Ok => Ok(client),
            other => Err(remote(other)),
        }
    }

    async fn call(&self, req: &Request) -> Result<Response, NetError> {
        request(&self.conn, req, MAX_FRAME + 64 * 1024).await
    }

    pub fn is_closed(&self) -> bool {
        self.conn.close_reason().is_some()
    }

    pub async fn put_roster(&self, roster: Signed<Roster>) -> Result<(), NetError> {
        match self.call(&Request::PutRoster(Box::new(roster))).await? {
            Response::Ok => Ok(()),
            other => Err(remote(other)),
        }
    }

    /// 哪些分片已存在（續傳用）。
    pub async fn has(&self, ids: &[[u8; 32]]) -> Result<Vec<bool>, NetError> {
        let mut out = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(MAX_HAS) {
            match self
                .call(&Request::Has {
                    ids: chunk.to_vec(),
                })
                .await?
            {
                Response::Has(v) if v.len() == chunk.len() => out.extend(v),
                other => return Err(remote(other)),
            }
        }
        Ok(out)
    }

    /// 上傳分片；回傳是否原本就存在。
    pub async fn put(
        &self,
        id: [u8; 32],
        data: Vec<u8>,
        expires_at: Timestamp,
    ) -> Result<bool, NetError> {
        match self
            .call(&Request::Put {
                id,
                data,
                expires_at,
            })
            .await?
        {
            Response::Stored { duplicate } => Ok(duplicate),
            other => Err(remote(other)),
        }
    }

    pub async fn get(&self, id: [u8; 32]) -> Result<Vec<u8>, NetError> {
        match self
            .call(&Request::Get {
                id,
                offset: 0,
                len: 0,
            })
            .await?
        {
            Response::Data(d) => Ok(d),
            other => Err(remote(other)),
        }
    }

    pub async fn health(&self) -> Result<(u64, u64), NetError> {
        match self.call(&Request::Health).await? {
            Response::Health { objects, bytes } => Ok((objects, bytes)),
            other => Err(remote(other)),
        }
    }
}
