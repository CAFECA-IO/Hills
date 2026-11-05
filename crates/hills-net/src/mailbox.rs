//! mailbox 客戶端（ALPN `hills/mailbox/1`，technical-design §5.2）。

use hills_proto::mailbox::{ALPN, Hello, ListItem, MAX_FRAME, Request, Response};
use hills_proto::{EncryptedBundle, OrgId, Roster, Signed};
use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr};

use crate::{NetError, request};

pub struct MailboxClient {
    conn: Connection,
    org_id: OrgId,
}

fn remote(resp: Response) -> NetError {
    match resp {
        Response::Error { code, message } => NetError::Remote(format!("{code:?}: {message}")),
        other => NetError::Remote(format!("非預期的回應：{other:?}")),
    }
}

impl MailboxClient {
    /// 連線並送出 Hello。
    pub async fn connect(
        endpoint: &Endpoint,
        addr: EndpointAddr,
        hello: Hello,
    ) -> Result<Self, NetError> {
        let org_id = hello.member_cert.body.org_id;
        let conn = endpoint
            .connect(addr, ALPN)
            .await
            .map_err(|e| NetError::Connect(e.to_string()))?;
        let client = Self { conn, org_id };
        match client.call(&Request::Hello(Box::new(hello))).await? {
            Response::Ok => Ok(client),
            other => Err(remote(other)),
        }
    }

    async fn call(&self, req: &Request) -> Result<Response, NetError> {
        request(&self.conn, req, MAX_FRAME + 64 * 1024).await
    }

    pub async fn put_roster(&self, roster: Signed<Roster>) -> Result<(), NetError> {
        match self.call(&Request::PutRoster(Box::new(roster))).await? {
            Response::Ok => Ok(()),
            other => Err(remote(other)),
        }
    }

    /// 上傳 bundle；回傳 (cursor, 是否重複)。
    pub async fn put(&self, bundle: EncryptedBundle) -> Result<(u64, bool), NetError> {
        match self.call(&Request::Put(bundle)).await? {
            Response::Stored { cursor, duplicate } => Ok((cursor, duplicate)),
            other => Err(remote(other)),
        }
    }

    /// 取得 cursor 之後的 bundle；回傳 (項目, 下一個 cursor)。
    pub async fn list(
        &self,
        doc_ids: Option<Vec<String>>,
        since: u64,
        limit: u32,
    ) -> Result<(Vec<ListItem>, u64), NetError> {
        let req = Request::List {
            org_id: self.org_id,
            doc_ids,
            since,
            limit,
        };
        match self.call(&req).await? {
            Response::Bundles { items, next } => Ok((items, next)),
            other => Err(remote(other)),
        }
    }

    /// 取得全部（自動分頁）。
    pub async fn list_all(
        &self,
        doc_ids: Option<Vec<String>>,
        since: u64,
    ) -> Result<(Vec<ListItem>, u64), NetError> {
        let mut out = Vec::new();
        let mut cursor = since;
        loop {
            let (items, next) = self
                .list(doc_ids.clone(), cursor, hills_proto::mailbox::MAX_LIST)
                .await?;
            let done = items.is_empty();
            out.extend(items);
            cursor = next;
            if done {
                return Ok((out, cursor));
            }
        }
    }

    pub async fn get(&self, bundle_hash: [u8; 32]) -> Result<Option<EncryptedBundle>, NetError> {
        match self
            .call(&Request::Get {
                org_id: self.org_id,
                bundle_hash,
            })
            .await?
        {
            Response::Bundle(b) => Ok(Some(*b)),
            Response::Error {
                code: hills_proto::mailbox::ErrorCode::NotFound,
                ..
            } => Ok(None),
            other => Err(remote(other)),
        }
    }

    pub async fn close(self) {
        self.conn.close(0u32.into(), b"bye");
    }
}
