//! 文件的加密金鑰家族與讀取權限（technical-design §4.1、§16.1、§16.5）。

use hills_identity::trust::Verified;
use hills_proto::{KeyFamily, MemberId};
use hills_sync::{Directory, DocKind, MemberSection, PlanScope};

/// 文件使用哪個金鑰家族加密。目前支援 org、team、member secrets、計劃、對話（§14）。
pub fn key_family(doc_id: &str) -> Option<KeyFamily> {
    match DocKind::parse(doc_id)? {
        DocKind::ConvMeta(c) => Some(KeyFamily::ConvMeta(c)),
        DocKind::ConvLog(c) => Some(KeyFamily::Conv(c)),
        DocKind::Org
        | DocKind::KbMeta
        | DocKind::KbItems(_)
        | DocKind::TeamGoals(_)
        | DocKind::TeamRoster(_) => Some(KeyFamily::Org),
        DocKind::Team(t) => Some(KeyFamily::Team(t)),
        DocKind::Member {
            owner,
            section: MemberSection::Secrets | MemberSection::Tasks | MemberSection::Timer,
        } => Some(KeyFamily::MemberPrivate(owner)),
        // 工作紀錄（§16.18 v0.34，D62）：本人與所屬小組負責人
        DocKind::Member {
            owner,
            section: MemberSection::Worklog(_),
        } => Some(KeyFamily::MemberWorklog(owner)),
        // 方向摘要（§16.14 v0.21）、個人資料（§16.17 v0.31）：全員可讀
        DocKind::Member {
            section: MemberSection::Direction | MemberSection::Profile,
            ..
        } => Some(KeyFamily::Org),
        // 每日 Scrum（§16.12）
        DocKind::Member {
            section: MemberSection::Scrum { team, .. } | MemberSection::Reports { team, .. },
            ..
        } => Some(KeyFamily::Team(team)),
        // 計劃（§4.3 v0.15）
        DocKind::Member {
            owner,
            section: MemberSection::Plans(scope),
        } => Some(match scope {
            PlanScope::Private => KeyFamily::MemberPrivate(owner),
            PlanScope::Team(t) => KeyFamily::Team(t),
            PlanScope::Org => KeyFamily::Org,
        }),
        _ => None,
    }
}

/// 請求者可否讀取此文件（直連同步回應前檢查）。
pub fn can_read(doc_id: &str, who: &Verified, dir: &crate::org::OrgSnapshot) -> bool {
    match DocKind::parse(doc_id) {
        Some(
            DocKind::Org
            | DocKind::KbMeta
            | DocKind::KbItems(_)
            | DocKind::TeamGoals(_)
            | DocKind::TeamRoster(_),
        ) => true,
        Some(DocKind::Team(t)) => dir.is_team_member(&t, &who.member_id),
        Some(DocKind::Member {
            owner,
            section: MemberSection::Secrets | MemberSection::Tasks | MemberSection::Timer,
        }) => owner == who.member_id,
        Some(DocKind::Member {
            owner,
            section: MemberSection::Worklog(_),
        }) => owner == who.member_id || leads_of(dir, &owner).contains(&who.member_id),
        Some(DocKind::Member {
            section: MemberSection::Direction | MemberSection::Profile,
            ..
        }) => true,
        Some(DocKind::Member {
            section: MemberSection::Scrum { team, .. } | MemberSection::Reports { team, .. },
            ..
        }) => dir.is_team_member(&team, &who.member_id),
        Some(DocKind::Member {
            owner,
            section: MemberSection::Plans(scope),
        }) => match scope {
            PlanScope::Private => owner == who.member_id,
            PlanScope::Team(t) => dir.is_team_member(&t, &who.member_id),
            PlanScope::Org => true,
        },
        Some(DocKind::ConvMeta(c)) => dir.is_conv_member(&c, &who.member_id),
        // 只交出成員加入之後 epoch 的紀錄文件（§14.2 v0.9）
        Some(DocKind::ConvLog(c)) => {
            let epoch = crate::conv::parse_doc(doc_id)
                .and_then(|(_, seg)| seg)
                .and_then(|seg| crate::conv::segment_epoch(&seg));
            match (epoch, dir.conv_joined_epoch(&c, &who.member_id)) {
                (Some(n), Some(joined)) => joined <= n,
                _ => false,
            }
        }
        _ => false,
    }
}

/// 某成員所屬各小組的負責人（不含本人；工作紀錄的讀者，§16.18）。
pub fn leads_of(dir: &crate::org::OrgSnapshot, owner: &MemberId) -> Vec<MemberId> {
    let mut out: Vec<MemberId> = dir
        .teams_of(owner)
        .iter()
        .filter_map(|t| dir.teams.get(t))
        .flat_map(|t| t.leads.iter().copied())
        .filter(|m| m != owner)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// 本人是否應該持有此金鑰家族（決定無法解密的 bundle 是否值得保留重試）。
pub fn expects_key(family: &KeyFamily, me: &MemberId, dir: &dyn Directory) -> bool {
    match family {
        KeyFamily::Org => true,
        KeyFamily::Team(t) => dir.is_team_member(t, me),
        KeyFamily::MemberPrivate(m) => m == me,
        // 負責人名單可能比金鑰晚到；保留重試（限制 pending 數量）
        KeyFamily::MemberWorklog(_) => true,
        // 無法在取得金鑰前得知是否為成員；保留重試（node 端限制 pending 數量）
        KeyFamily::Conv(_) | KeyFamily::ConvMeta(_) => true,
        _ => false,
    }
}
