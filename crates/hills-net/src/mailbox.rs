//! mailbox 客戶端（ALPN `hills/mailbox/1`，technical-design §5.2）。

use hills_proto::mailbox::{
    ALPN, Hello, KeyItem, ListItem, MAX_FRAME, MAX_LIST, PeerInfo, PendingJoin, Request, Response,
};
use hills_proto::{
    DeviceCert, EncryptedBundle, JoinRequest, OrgId, PeerAddr, Revocation, Roster, Signed,
    WrappedKey,
};
use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr};

use crate::{NetError, request};

async fn request_on(conn: &Connection, req: &Request) -> Result<Response, NetError> {
    request(conn, req, MAX_FRAME + 64 * 1024).await
}

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
        org_id: OrgId,
        hello: Hello,
    ) -> Result<Self, NetError> {
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
        request_on(&self.conn, req).await
    }

    /// 連線是否仍開啟（mailbox 重啟或網路中斷後會關閉）。
    pub fn is_closed(&self) -> bool {
        self.conn.close_reason().is_some()
    }

    /// 送出加入申請（不需 Hello，technical-design §16.2）。連線完成後即關閉。
    pub async fn join(
        endpoint: &Endpoint,
        addr: EndpointAddr,
        org_id: OrgId,
        invite_id: [u8; 8],
        request: JoinRequest,
    ) -> Result<(), NetError> {
        let conn = endpoint
            .connect(addr, ALPN)
            .await
            .map_err(|e| NetError::Connect(e.to_string()))?;
        let resp: Response = request_on(
            &conn,
            &Request::Join {
                org_id,
                invite_id,
                request: Box::new(request),
            },
        )
        .await?;
        conn.close(0u32.into(), b"bye");
        match resp {
            Response::Ok => Ok(()),
            other => Err(remote(other)),
        }
    }

    async fn expect_ok(&self, req: &Request) -> Result<(), NetError> {
        match self.call(req).await? {
            Response::Ok => Ok(()),
            other => Err(remote(other)),
        }
    }

    pub async fn get_roster(&self) -> Result<Roster, NetError> {
        match self.call(&Request::GetRoster).await? {
            Response::Roster(r) => Ok(*r),
            other => Err(remote(other)),
        }
    }

    pub async fn put_device(&self, cert: Signed<DeviceCert>) -> Result<(), NetError> {
        self.expect_ok(&Request::PutDevice(Box::new(cert))).await
    }

    pub async fn put_revocation(&self, rev: Signed<Revocation>) -> Result<(), NetError> {
        self.expect_ok(&Request::PutRevocation(Box::new(rev))).await
    }

    pub async fn register_invite(
        &self,
        invite_id: [u8; 8],
        expires_at: i64,
    ) -> Result<(), NetError> {
        self.expect_ok(&Request::RegisterInvite {
            invite_id,
            expires_at,
        })
        .await
    }

    pub async fn close_invite(&self, invite_id: [u8; 8]) -> Result<(), NetError> {
        self.expect_ok(&Request::CloseInvite { invite_id }).await
    }

    pub async fn fetch_joins(&self) -> Result<Vec<PendingJoin>, NetError> {
        match self.call(&Request::FetchJoins).await? {
            Response::Joins(j) => Ok(j),
            other => Err(remote(other)),
        }
    }

    pub async fn put_keys(&self, wrapped: Vec<Signed<WrappedKey>>) -> Result<(), NetError> {
        self.expect_ok(&Request::PutKeys(wrapped)).await
    }

    /// 取得 cursor 之後封裝給本人的金鑰（自動分頁）。
    pub async fn fetch_keys(&self, since: u64) -> Result<(Vec<KeyItem>, u64), NetError> {
        let mut out = Vec::new();
        let mut cursor = since;
        loop {
            let (items, next) = match self.call(&Request::FetchKeys { since: cursor }).await? {
                Response::Keys { items, next } => (items, next),
                other => return Err(remote(other)),
            };
            let n = items.len();
            out.extend(items);
            cursor = next;
            if n < MAX_LIST as usize {
                return Ok((out, cursor));
            }
        }
    }

    pub async fn announce(&self, addr: PeerAddr) -> Result<(), NetError> {
        self.expect_ok(&Request::Announce(addr)).await
    }

    pub async fn peers(&self) -> Result<Vec<PeerInfo>, NetError> {
        match self.call(&Request::Peers).await? {
            Response::Peers(p) => Ok(p),
            other => Err(remote(other)),
        }
    }

    /// mailbox 目前的位址（§16.1「mailbox 位址更新」）。
    pub async fn info(&self) -> Result<PeerAddr, NetError> {
        match self.call(&Request::Info).await? {
            Response::Info(a) => Ok(a),
            other => Err(remote(other)),
        }
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
