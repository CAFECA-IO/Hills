//! 簽章 change 與 single-writer 驗證層（technical-design §4.1、§4.2）。
//!
//! 每筆 Automerge change 由寫入裝置的 DK 簽章；接收端套用前依序檢查：
//!
//! 1. 簽章有效
//! 2. 簽署裝置通過信任鏈（`hills_identity::trust::TrustStore`）
//! 3. change 內容與宣告的 hash 一致、`doc_id` 與目標文件一致
//! 4. 作者是該文件的合法寫入者（[`allowed`]）
//!
//! 不通過的 change 不套用，並留下 [`Rejection`] 紀錄。因為每份文件只有一類寫入者，拒絕非法
//! change 不會影響合法寫入者的因果鏈。

pub mod doc_id;

use automerge::{AutoCommit, Change};
use hills_identity::cert::DeviceKey;
use hills_identity::trust::{TrustStore, Verified};
use hills_proto::{FORMAT_VERSION, MemberId, Pub32, SignedChange, SignedChangeBody, Timestamp};

pub use doc_id::{DocKind, MemberSection, PlanScope};

/// 小組與對話成員資料（來自 org 文件與 conv/<id>/meta 的投影）。
pub trait Directory {
    fn is_team_member(&self, team: &str, member: &MemberId) -> bool;
    fn is_conv_member(&self, conv: &str, member: &MemberId) -> bool;
    fn is_conv_admin(&self, conv: &str, member: &MemberId) -> bool;
}

/// 對話紀錄（technical-design §14.2）只能新增：每個 op 都必須是在根物件上、以
/// `<作者 memberId>:` 開頭的新 key 放入字串（不能覆寫、刪除或建立巢狀物件）。
pub fn append_only_by(change: &Change, author: &MemberId) -> bool {
    use automerge::ScalarValue;
    use automerge::legacy::{Key, ObjectId, OpType};
    let prefix = format!("{author}:");
    let decoded = change.decode();
    decoded.operations.iter().all(|op| {
        matches!(op.obj, ObjectId::Root)
            && op.pred.is_empty()
            && !op.insert
            && matches!(&op.key, Key::Map(k) if k.starts_with(&prefix) && k.len() <= 128)
            && matches!(&op.action, OpType::Put(ScalarValue::Str(_)))
    })
}

/// team 文件根物件上 `profile:` 開頭的 key 只能由本人放入字串（technical-design §16.8 v0.11）。
pub fn own_profile_only(change: &Change, author: &MemberId) -> bool {
    use automerge::ScalarValue;
    use automerge::legacy::{Key, ObjectId, OpType};
    let mine = format!("profile:{author}");
    let decoded = change.decode();
    decoded
        .operations
        .iter()
        .all(|op| match (&op.obj, &op.key) {
            (ObjectId::Root, Key::Map(k)) if k.starts_with("profile:") => {
                *k == mine && !op.insert && matches!(&op.action, OpType::Put(ScalarValue::Str(_)))
            }
            _ => true,
        })
}

/// 知識庫 `kb/items/*`（technical-design §16.11）：每個 op 都必須在根物件上放入字串或刪除 key，
/// 且 key 以作者 memberId 開頭；管理者可改任何 key（仍限根物件上的字串）。
pub fn own_keys_or_admin(change: &Change, who: &Verified) -> bool {
    use automerge::ScalarValue;
    use automerge::legacy::{Key, ObjectId, OpType};
    let prefix = format!("{}:", who.member_id);
    let admin = who.is_admin();
    let decoded = change.decode();
    decoded.operations.iter().all(|op| {
        matches!(op.obj, ObjectId::Root)
            && !op.insert
            && matches!(&op.key, Key::Map(k) if k.len() <= 128 && (admin || k.starts_with(&prefix)))
            && matches!(
                &op.action,
                OpType::Put(ScalarValue::Str(_)) | OpType::Delete
            )
    })
}

/// 判斷驗證通過的成員可否寫入此類文件（technical-design §4.1 表格）。
pub fn allowed(kind: &DocKind, who: &Verified, dir: &dyn Directory) -> bool {
    match kind {
        DocKind::Org => who.is_admin(),
        DocKind::Team(t) => dir.is_team_member(t, &who.member_id),
        DocKind::Member { owner, .. } => *owner == who.member_id,
        DocKind::Approvals(approver) => *approver == who.member_id,
        DocKind::ConvMeta(c) => dir.is_conv_admin(c, &who.member_id),
        DocKind::ConvLog(c) => dir.is_conv_member(c, &who.member_id),
        // 知識庫：任何已驗證成員（kb/items 的作者限制另由 own_keys_or_admin 檢查）
        DocKind::KbMeta | DocKind::KbItems(_) => true,
    }
}

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum SyncError {
    #[error("簽章或身分驗證失敗：{0}")]
    Identity(String),
    #[error("change 內容無法解析")]
    BadChange,
    #[error("change hash 不符")]
    HashMismatch,
    #[error("文件 ID 不符")]
    WrongDoc,
    #[error("未知的文件類型")]
    UnknownDoc,
    #[error("無寫入權限")]
    Forbidden,
    #[error("對話紀錄只能新增自己的訊息")]
    NotAppendOnly,
    #[error("只能修改自己的角色外觀")]
    NotOwnProfile,
    #[error("只有作者與管理者能修改這則知識")]
    NotOwnKey,
    #[error("簽署裝置與宣告的作者不同")]
    AuthorMismatch,
    #[error("不支援的版本")]
    Version,
    #[error("套用失敗")]
    Apply,
}

/// 以裝置金鑰簽署一筆 Automerge change。
pub fn sign_change(
    doc_id: &str,
    change: &Change,
    device: &DeviceKey,
) -> Result<SignedChange, SyncError> {
    device
        .sign_body(SignedChangeBody {
            v: FORMAT_VERSION,
            doc_id: doc_id.to_owned(),
            change_hash: change.hash().0,
            author_device: device.public(),
            change: change.raw_bytes().to_vec(),
        })
        .map_err(|e| SyncError::Identity(e.to_string()))
}

/// 簽署文件中所有尚未簽署的本機 change（自 `since` 之後）。
pub fn sign_local_changes(
    doc_id: &str,
    doc: &mut AutoCommit,
    since: &[automerge::ChangeHash],
    device: &DeviceKey,
) -> Result<Vec<SignedChange>, SyncError> {
    doc.get_changes(since)
        .iter()
        .map(|c| sign_change(doc_id, c, device))
        .collect()
}

/// 被拒絕的 change 紀錄（本機稽核用，不含 change 內容）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub doc_id: String,
    pub signer: Pub32,
    pub change_hash: [u8; 32],
    pub reason: SyncError,
    pub at: Timestamp,
}

/// 驗證並套用 change。
pub struct Validator<'a> {
    trust: &'a TrustStore,
    dir: &'a dyn Directory,
    rejections: Vec<Rejection>,
}

impl<'a> Validator<'a> {
    pub fn new(trust: &'a TrustStore, dir: &'a dyn Directory) -> Self {
        Self {
            trust,
            dir,
            rejections: Vec::new(),
        }
    }

    /// 只驗證，不套用。成功時回傳解析後的 change 與作者。
    pub fn check(&self, doc_id: &str, sc: &SignedChange) -> Result<(Change, Verified), SyncError> {
        if sc.body.v != FORMAT_VERSION {
            return Err(SyncError::Version);
        }
        if sc.body.doc_id != doc_id {
            return Err(SyncError::WrongDoc);
        }
        if sc.body.author_device != sc.signer {
            return Err(SyncError::AuthorMismatch);
        }
        let who = self
            .trust
            .verify_device_signed(sc)
            .map_err(|e| SyncError::Identity(e.to_string()))?;
        let change =
            Change::from_bytes(sc.body.change.clone()).map_err(|_| SyncError::BadChange)?;
        if change.hash().0 != sc.body.change_hash {
            return Err(SyncError::HashMismatch);
        }
        let kind = DocKind::parse(doc_id).ok_or(SyncError::UnknownDoc)?;
        if !allowed(&kind, &who, self.dir) {
            return Err(SyncError::Forbidden);
        }
        if matches!(kind, DocKind::ConvLog(_)) && !append_only_by(&change, &who.member_id) {
            return Err(SyncError::NotAppendOnly);
        }
        if matches!(kind, DocKind::Team(_)) && !own_profile_only(&change, &who.member_id) {
            return Err(SyncError::NotOwnProfile);
        }
        if matches!(kind, DocKind::KbItems(_)) && !own_keys_or_admin(&change, &who) {
            return Err(SyncError::NotOwnKey);
        }
        Ok((change, who))
    }

    /// 驗證並套用一批 change；回傳成功套用的數量。被拒絕的記錄在 [`Self::rejections`]。
    /// 依賴尚未到達的 change 由 Automerge 暫存，等依賴到齊後自動生效。
    pub fn apply(
        &mut self,
        doc_id: &str,
        doc: &mut AutoCommit,
        changes: &[SignedChange],
        now: Timestamp,
    ) -> usize {
        let mut ok = Vec::new();
        for sc in changes {
            match self.check(doc_id, sc) {
                Ok((change, _)) => ok.push(change),
                Err(reason) => self.rejections.push(Rejection {
                    doc_id: doc_id.to_owned(),
                    signer: sc.signer,
                    change_hash: sc.body.change_hash,
                    reason,
                    at: now,
                }),
            }
        }
        let n = ok.len();
        if n > 0 && doc.apply_changes(ok).is_err() {
            self.rejections.push(Rejection {
                doc_id: doc_id.to_owned(),
                signer: Pub32([0; 32]),
                change_hash: [0; 32],
                reason: SyncError::Apply,
                at: now,
            });
            return 0;
        }
        n
    }

    pub fn rejections(&self) -> &[Rejection] {
        &self.rejections
    }

    pub fn take_rejections(&mut self) -> Vec<Rejection> {
        std::mem::take(&mut self.rejections)
    }
}

#[cfg(test)]
mod tests;
