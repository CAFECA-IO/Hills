//! 文件的加密金鑰家族與讀取權限（technical-design §4.1、§16.1、§16.5）。

use hills_identity::trust::Verified;
use hills_proto::{KeyFamily, MemberId};
use hills_sync::{Directory, DocKind, MemberSection};

/// 文件使用哪個金鑰家族加密。M0 只支援 org、team、member secrets。
pub fn key_family(doc_id: &str) -> Option<KeyFamily> {
    match DocKind::parse(doc_id)? {
        DocKind::Org => Some(KeyFamily::Org),
        DocKind::Team(t) => Some(KeyFamily::Team(t)),
        DocKind::Member {
            owner,
            section: MemberSection::Secrets,
        } => Some(KeyFamily::MemberPrivate(owner)),
        _ => None,
    }
}

/// 請求者可否讀取此文件（直連同步回應前檢查）。
pub fn can_read(doc_id: &str, who: &Verified, dir: &dyn Directory) -> bool {
    match DocKind::parse(doc_id) {
        Some(DocKind::Org) => true,
        Some(DocKind::Team(t)) => dir.is_team_member(&t, &who.member_id),
        Some(DocKind::Member {
            owner,
            section: MemberSection::Secrets,
        }) => owner == who.member_id,
        _ => false,
    }
}

/// 本人是否應該持有此金鑰家族（決定無法解密的 bundle 是否值得保留重試）。
pub fn expects_key(family: &KeyFamily, me: &MemberId, dir: &dyn Directory) -> bool {
    match family {
        KeyFamily::Org => true,
        KeyFamily::Team(t) => dir.is_team_member(t, me),
        KeyFamily::MemberPrivate(m) => m == me,
        _ => false,
    }
}
