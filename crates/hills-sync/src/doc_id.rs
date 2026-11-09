//! 文件 ID 與寫入者規則（technical-design §4.1、§14.2）。

use hills_proto::MemberId;

/// 由文件 ID 解析出的文件類型與擁有者。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocKind {
    /// `org`：只有管理者可寫
    Org,
    /// `team/<teamId>`：小組成員
    Team(String),
    /// `team-goals/<teamId>`：小組目標，該小組負責人與管理者（technical-design §16.14，D47）
    TeamGoals(String),
    /// `team-roster/<teamId>`：小組成員與負責人，該小組負責人與管理者（technical-design §16.15，D49）
    TeamRoster(String),
    /// `member/<id>/…`：只有本人（plans、scrum、attendance、requests、reports）
    Member {
        owner: MemberId,
        section: MemberSection,
    },
    /// `approvals/<approverId>`：只有核准者本人
    Approvals(MemberId),
    /// `conv/<convId>/meta`：對話管理員
    ConvMeta(String),
    /// `conv/<convId>/log/<yyyy-mm>`：對話成員
    ConvLog(String),
    /// `kb/meta`：知識庫的分類與主題，全體成員（technical-design §16.11）
    KbMeta,
    /// `kb/items/<yyyy-mm>`：知識，全體成員；每則只限作者與管理者（§16.11）
    KbItems(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemberSection {
    /// 計劃（technical-design §4.3 v0.15）
    Plans(PlanScope),
    /// 每日 Scrum：`scrum/<teamId>/<yyyy-mm>`（technical-design §16.12）
    Scrum {
        team: String,
        month: String,
    },
    Attendance(String),
    Requests,
    /// 日 / 週報：`reports/<teamId>/<yyyy>`（technical-design §16.13）
    Reports {
        team: String,
        year: String,
    },
    /// 本人的私密設定，例如邀請 secret（technical-design §16.2）
    Secrets,
    /// 私人任務：`tasks`（technical-design §16.8 v0.19，D46）
    Tasks,
    /// 方向摘要與對齊建議：`direction`（technical-design §16.14 v0.21，D47），全員可讀
    Direction,
}

/// 計劃文件的可見度：`plans/private`、`plans/team/<teamId>`、`plans/org`（technical-design §4.3 v0.15）。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PlanScope {
    Private,
    Team(String),
    Org,
}

impl PlanScope {
    /// 文件 ID 中 `plans/` 之後的部分。
    pub fn path(&self) -> String {
        match self {
            PlanScope::Private => "private".into(),
            PlanScope::Team(t) => format!("team/{t}"),
            PlanScope::Org => "org".into(),
        }
    }
}

/// 對話紀錄的分段：`<yyyy-mm>-e<epoch>`（technical-design §14.2 v0.9）。
fn is_log_segment(s: &str) -> bool {
    match s.split_once("-e") {
        Some((ym, n)) => {
            is_month(ym) && !n.is_empty() && n.len() <= 9 && n.bytes().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

fn is_month(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7
        && b[4] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || c.is_ascii_digit())
}

fn is_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

impl DocKind {
    pub fn parse(doc_id: &str) -> Option<Self> {
        let parts: Vec<&str> = doc_id.split('/').collect();
        Some(match parts.as_slice() {
            ["org"] => DocKind::Org,
            ["team", t] if is_segment(t) => DocKind::Team((*t).into()),
            ["team-goals", t] if is_segment(t) => DocKind::TeamGoals((*t).into()),
            ["team-roster", t] if is_segment(t) => DocKind::TeamRoster((*t).into()),
            ["approvals", m] => DocKind::Approvals(MemberId::parse(m).ok()?),
            ["kb", "meta"] => DocKind::KbMeta,
            ["kb", "items", ym] if is_month(ym) => DocKind::KbItems((*ym).into()),
            ["conv", c, "meta"] if is_segment(c) => DocKind::ConvMeta((*c).into()),
            ["conv", c, "log", seg] if is_segment(c) && is_log_segment(seg) => {
                DocKind::ConvLog((*c).into())
            }
            ["member", m, rest @ ..] => {
                let owner = MemberId::parse(m).ok()?;
                let section = match rest {
                    ["plans", "private"] => MemberSection::Plans(PlanScope::Private),
                    ["plans", "org"] => MemberSection::Plans(PlanScope::Org),
                    ["plans", "team", t] if is_segment(t) => {
                        MemberSection::Plans(PlanScope::Team((*t).into()))
                    }
                    ["scrum", t, ym] if is_segment(t) && is_month(ym) => MemberSection::Scrum {
                        team: (*t).into(),
                        month: (*ym).into(),
                    },
                    ["attendance", ym] if is_month(ym) => MemberSection::Attendance((*ym).into()),
                    ["requests"] => MemberSection::Requests,
                    ["reports", t, y]
                        if is_segment(t)
                            && y.len() == 4
                            && y.bytes().all(|c| c.is_ascii_digit()) =>
                    {
                        MemberSection::Reports {
                            team: (*t).into(),
                            year: (*y).into(),
                        }
                    }
                    ["secrets"] => MemberSection::Secrets,
                    ["tasks"] => MemberSection::Tasks,
                    ["direction"] => MemberSection::Direction,
                    _ => return None,
                };
                DocKind::Member { owner, section }
            }
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_ids() {
        let m = MemberId([3; 16]);
        assert_eq!(DocKind::parse("org"), Some(DocKind::Org));
        assert_eq!(
            DocKind::parse("team/t-1"),
            Some(DocKind::Team("t-1".into()))
        );
        assert_eq!(
            DocKind::parse("team-goals/t-1"),
            Some(DocKind::TeamGoals("t-1".into()))
        );
        assert_eq!(DocKind::parse("team-goals/a/b"), None);
        assert_eq!(
            DocKind::parse("team-roster/t-1"),
            Some(DocKind::TeamRoster("t-1".into()))
        );
        assert_eq!(DocKind::parse("team-roster/a/b"), None);
        assert!(matches!(
            DocKind::parse(&format!("member/{m}/direction")),
            Some(DocKind::Member {
                section: MemberSection::Direction,
                ..
            })
        ));
        assert_eq!(
            DocKind::parse(&format!("member/{m}/attendance/2026-11")),
            Some(DocKind::Member {
                owner: m,
                section: MemberSection::Attendance("2026-11".into())
            })
        );
        for (path, scope) in [
            ("private", PlanScope::Private),
            ("org", PlanScope::Org),
            ("team/t-1", PlanScope::Team("t-1".into())),
        ] {
            assert_eq!(scope.path(), path);
            assert_eq!(
                DocKind::parse(&format!("member/{m}/plans/{path}")),
                Some(DocKind::Member {
                    owner: m,
                    section: MemberSection::Plans(scope)
                })
            );
        }
        assert_eq!(
            DocKind::parse(&format!("member/{m}/scrum/t-1/2026-11")),
            Some(DocKind::Member {
                owner: m,
                section: MemberSection::Scrum {
                    team: "t-1".into(),
                    month: "2026-11".into()
                }
            })
        );
        assert_eq!(
            DocKind::parse(&format!("member/{m}/reports/t-1/2026")),
            Some(DocKind::Member {
                owner: m,
                section: MemberSection::Reports {
                    team: "t-1".into(),
                    year: "2026".into()
                }
            })
        );
        assert_eq!(
            DocKind::parse(&format!("member/{m}/tasks")),
            Some(DocKind::Member {
                owner: m,
                section: MemberSection::Tasks
            })
        );
        assert_eq!(DocKind::parse("kb/meta"), Some(DocKind::KbMeta));
        assert_eq!(
            DocKind::parse("kb/items/2026-11"),
            Some(DocKind::KbItems("2026-11".into()))
        );
        assert_eq!(
            DocKind::parse(&format!("approvals/{m}")),
            Some(DocKind::Approvals(m))
        );
        assert_eq!(
            DocKind::parse("conv/c1/log/2026-11-e1"),
            Some(DocKind::ConvLog("c1".into()))
        );
    }

    #[test]
    fn rejects_unknown_ids() {
        let m = MemberId([3; 16]);
        for bad in [
            "".to_string(),
            "orgs".into(),
            "team/".into(),
            "team/a/b".into(),
            "team/../org".into(),
            format!("member/{m}/attendance/2026-1"),
            format!("member/{m}/plans/public"),
            format!("member/{m}/plans/team"),
            format!("member/{m}/plans/team/a/b"),
            format!("member/{m}/plans/team/a.b"),
            "member/notbase32/requests".into(),
            "conv/c1/log/202611".into(),
            format!("member/{m}/scrum/2026-11"),
            format!("member/{m}/scrum/t/2026-1"),
            format!("member/{m}/reports"),
            format!("member/{m}/reports/t/26"),
            "kb".into(),
            "kb/items".into(),
            "kb/items/2026-1".into(),
            "kb/other".into(),
        ] {
            assert_eq!(DocKind::parse(&bad), None, "{bad}");
        }
    }
}
