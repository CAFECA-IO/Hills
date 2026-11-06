//! 伺服器端共用的信任邏輯（technical-design §15.6 v0.12、§16.7、§16.9）：mailbox 與儲存節點
//! 都用它處理 `Hello`、綁定組織、roster 推送與每個請求的撤銷檢查，只差在持久化方式。

use std::sync::{Mutex, MutexGuard};

use hills_identity::trust::{TrustStore, Verified};
use hills_proto::mailbox::{ErrorCode, Hello};
use hills_proto::{DeviceCert, OrgId, Pub32, Revocation, Roster, Signed};

/// 尚未綁定組織時的佔位 OK（全 0，不是有效的 Ed25519 公鑰，無法通過任何驗證）。
pub const UNCLAIMED: Pub32 = Pub32([0; 32]);

/// 拒絕原因（對應協定的錯誤碼）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateError {
    pub code: ErrorCode,
    pub message: String,
}

impl GateError {
    pub fn new(code: ErrorCode, message: &str) -> Self {
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

fn e(code: ErrorCode, message: &str) -> GateError {
    GateError::new(code, message)
}

/// 信任狀態的保存方式（mailbox：SQLite；儲存節點：SQLite）。
pub trait TrustPersist: Send + Sync {
    /// 保存 roster（每次變更後呼叫；失敗時變更不生效）。
    fn save_roster(&self, roster: &[u8]) -> Result<(), String>;
    /// 第一次綁定組織時呼叫。
    fn save_org_root(&self, root: &Pub32) -> Result<(), String>;
}

pub struct TrustGate {
    trust: Mutex<TrustStore>,
    persist: Box<dyn TrustPersist>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl TrustGate {
    /// `root` 為 [`UNCLAIMED`] 時等待第一位管理者綁定；`roster` 為已保存的信任狀態。
    pub fn new(
        root: Pub32,
        roster: Option<&Roster>,
        persist: Box<dyn TrustPersist>,
    ) -> anyhow::Result<Self> {
        let mut trust = TrustStore::new(root);
        if let (Some(r), false) = (roster, root == UNCLAIMED) {
            trust.import_roster(r)?;
        }
        Ok(Self {
            trust: Mutex::new(trust),
            persist,
        })
    }

    /// 直接讀取信任狀態（例如驗證封裝金鑰的簽署者）。鎖的順序：trust 在前。
    pub fn lock(&self) -> Result<MutexGuard<'_, TrustStore>, GateError> {
        self.trust
            .lock()
            .map_err(|_| e(ErrorCode::Internal, "lock"))
    }

    pub fn is_claimed(&self) -> bool {
        self.lock()
            .map(|t| t.org_root() != UNCLAIMED)
            .unwrap_or(false)
    }

    pub fn org_id(&self) -> OrgId {
        self.lock().map(|t| t.org_id()).unwrap_or(Pub32([0; 32]))
    }

    pub fn roster(&self) -> Result<Roster, GateError> {
        Ok(self.lock()?.to_roster(now_ms()))
    }

    /// 在副本上套用變更，保存成功後才取代（失敗時不留下半套狀態）。
    fn update(
        &self,
        f: impl FnOnce(&mut TrustStore) -> Result<Option<Pub32>, GateError>,
    ) -> Result<(), GateError> {
        let mut trust = self.lock()?;
        let mut next = trust.clone();
        let claim = f(&mut next)?;
        let bytes = hills_proto::encode(&next.to_roster(now_ms()))
            .map_err(|_| e(ErrorCode::Internal, "encode"))?;
        self.persist
            .save_roster(&bytes)
            .map_err(|_| e(ErrorCode::Internal, "無法保存信任狀態"))?;
        if let Some(root) = claim {
            self.persist
                .save_org_root(&root)
                .map_err(|_| e(ErrorCode::Internal, "無法綁定組織"))?;
            tracing::info!(org = %hills_identity::cert::org_id_for(&root), "已綁定組織");
        }
        *trust = next;
        Ok(())
    }

    /// 連線的第一個請求：驗證裝置憑證與成員憑證；尚未綁定時由第一位 OK 簽發的管理者綁定。
    pub fn hello(&self, h: &Hello, node: &Pub32) -> Result<Verified, GateError> {
        let mut verified = None;
        self.update(|trust| {
            let mut claim = None;
            if trust.org_root() == UNCLAIMED {
                let mc = h
                    .member_cert
                    .as_ref()
                    .ok_or_else(|| e(ErrorCode::Unauthorized, "尚未綁定組織"))?;
                let root = mc.signer;
                if !mc.body.is_admin() || mc.body.org_id != hills_identity::cert::org_id_for(&root)
                {
                    return Err(e(ErrorCode::Unauthorized, "尚未綁定組織"));
                }
                let mut fresh = TrustStore::new(root);
                fresh
                    .add_member_cert(mc.clone())
                    .map_err(|_| e(ErrorCode::Unauthorized, "成員憑證無效"))?;
                *trust = fresh;
                claim = Some(root);
            }
            let member_cert = match &h.member_cert {
                Some(mc) => {
                    if trust.member(&mc.body.member_id).is_none() {
                        // bootstrap：尚未收到 roster 時，接受由 OK 或已知管理者簽發的有效憑證
                        trust
                            .add_member_cert(mc.clone())
                            .map_err(|_| e(ErrorCode::Unauthorized, "成員憑證無效"))?;
                    }
                    mc.clone()
                }
                None => trust
                    .member_cert(&h.device_cert.body.member_id)
                    .cloned()
                    .ok_or_else(|| e(ErrorCode::Unauthorized, "未知的成員"))?,
            };
            trust
                .verify_hello(&h.device_cert, &member_cert, node)
                .map_err(|x| e(ErrorCode::Unauthorized, &x.to_string()))?;
            trust
                .add_device_cert(h.device_cert.clone())
                .map_err(|x| e(ErrorCode::Unauthorized, &x.to_string()))?;
            verified = Some(
                trust
                    .verify_device(node)
                    .map_err(|x| e(ErrorCode::Unauthorized, &x.to_string()))?,
            );
            Ok(claim)
        })?;
        verified.ok_or_else(|| e(ErrorCode::Internal, "hello"))
    }

    /// 每個請求都重新檢查（期間可能被撤銷）。
    pub fn still_valid(&self, node: &Pub32) -> Result<Verified, GateError> {
        self.lock()?
            .verify_device(node)
            .map_err(|_| e(ErrorCode::Unauthorized, "裝置已失效"))
    }

    /// 管理者裝置推送的 roster（含撤銷）。
    pub fn put_roster(&self, who: &Verified, roster: &Signed<Roster>) -> Result<(), GateError> {
        if !who.is_admin() || roster.signer != who.device {
            return Err(e(ErrorCode::Forbidden, "只有管理者裝置可推送 roster"));
        }
        if hills_identity::cert::verify_signature(roster).is_err()
            || roster.body.org_id != self.org_id()
        {
            return Err(e(ErrorCode::BadRequest, "roster 簽章或組織不符"));
        }
        self.update(|t| {
            t.import_roster(&roster.body)
                .map(|_| None)
                .map_err(|_| e(ErrorCode::BadRequest, "roster 內容無效"))
        })
    }

    pub fn put_device(&self, who: &Verified, cert: &Signed<DeviceCert>) -> Result<(), GateError> {
        if cert.body.member_id != who.member_id {
            return Err(e(ErrorCode::Forbidden, "只能上傳自己的裝置憑證"));
        }
        self.update(|t| {
            t.add_device_cert(cert.clone())
                .map(|_| None)
                .map_err(|x| e(ErrorCode::BadRequest, &x.to_string()))
        })
    }

    /// 權限（管理者 / 裝置本人）由 TrustStore 依簽署者判斷。
    pub fn put_revocation(&self, rev: &Signed<Revocation>) -> Result<(), GateError> {
        self.update(|t| {
            t.add_revocation(rev)
                .map(|_| None)
                .map_err(|x| e(ErrorCode::Forbidden, &x.to_string()))
        })
    }
}
