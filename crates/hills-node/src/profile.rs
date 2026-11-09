//! 個人資料（顯示名稱、時區、工作時段）與通知偏好（technical-design §16.17 v0.31，D57）。
//!
//! 個人資料在 `member/<id>/profile`（本人寫、全員可讀，GK）；通知偏好在
//! `member/<id>/secrets` 的 `notify`（只有本人的裝置讀得到）。

use std::collections::BTreeMap;

use anyhow::{Result, bail};
use automerge::{AutoCommit, ROOT, transaction::Transactable};
use hills_proto::MemberId;
use hills_sync::{DocKind, MemberSection};
use serde::{Deserialize, Serialize};

use crate::node::{Node, now_ms};
use crate::org::{get_int, get_str, valid_hhmm};

/// 顯示名稱的最大字數
pub const MAX_DISPLAY_NAME: usize = 40;
const NOTIFY_KEY: &str = "notify";

pub fn profile_doc(owner: &MemberId) -> String {
    format!("member/{owner}/profile")
}

pub fn secrets_doc(owner: &MemberId) -> String {
    format!("member/{owner}/secrets")
}

/// 工作時段：星期（1 = 週一 … 7 = 週日）與起訖時間（不跨午夜）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkHours {
    pub days: Vec<u8>,
    pub start: String,
    pub end: String,
}

impl Default for WorkHours {
    fn default() -> Self {
        WorkHours {
            days: vec![1, 2, 3, 4, 5],
            start: "09:00".into(),
            end: "18:00".into(),
        }
    }
}

/// 個人資料。`display_name` / `timezone` 為空字串時分別沿用名冊姓名、裝置時區。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemberProfile {
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub timezone: String,
    #[serde(default)]
    pub work_hours: WorkHours,
    #[serde(default)]
    pub updated_at: i64,
}

fn yes() -> bool {
    true
}

/// 通知偏好（缺少的欄位視為開啟）。新裝置加入的安全通知不受影響。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyPrefs {
    #[serde(default = "yes")]
    pub messages: bool,
    #[serde(default = "yes")]
    pub assigned: bool,
    #[serde(default = "yes")]
    pub blockers: bool,
    #[serde(default = "yes")]
    pub scrum_reminder: bool,
}

impl Default for NotifyPrefs {
    fn default() -> Self {
        NotifyPrefs {
            messages: true,
            assigned: true,
            blockers: true,
            scrum_reminder: true,
        }
    }
}

fn valid_name(s: &str) -> bool {
    s.chars().count() <= MAX_DISPLAY_NAME && !s.chars().any(char::is_control)
}

/// IANA 時區名稱的格式檢查（例如 `Asia/Taipei`、`America/Argentina/Buenos_Aires`、`Etc/GMT+8`、`UTC`）。
/// 是否真的存在由前端以 `Intl` 確認。
fn valid_tz(s: &str) -> bool {
    s.is_empty()
        || (s.len() <= 64
            && s.starts_with(|c: char| c.is_ascii_alphabetic())
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'))
            && !s.contains("//")
            && !s.ends_with('/'))
}

fn valid_hours(h: &WorkHours) -> bool {
    let mut seen = [false; 8];
    for &d in &h.days {
        if !(1..=7).contains(&d) || seen[d as usize] {
            return false;
        }
        seen[d as usize] = true;
    }
    valid_hhmm(&h.start) && valid_hhmm(&h.end) && h.start < h.end
}

pub fn validate(p: &MemberProfile) -> Result<()> {
    if !valid_name(p.display_name.trim()) {
        bail!("顯示名稱需為 {MAX_DISPLAY_NAME} 字以內");
    }
    if !valid_tz(&p.timezone) {
        bail!("時區格式無效");
    }
    if !valid_hours(&p.work_hours) {
        bail!("工作時段無效：星期需為 1–7 且不重複，開始時間需早於結束時間");
    }
    Ok(())
}

/// 讀取個人資料；不合格的欄位改用預設值。
pub fn read_profile(doc: &AutoCommit) -> MemberProfile {
    let display_name = get_str(doc, &ROOT, "displayName")
        .map(|s| s.trim().to_owned())
        .filter(|s| valid_name(s))
        .unwrap_or_default();
    let timezone = get_str(doc, &ROOT, "timezone")
        .filter(|s| valid_tz(s))
        .unwrap_or_default();
    let work_hours = get_str(doc, &ROOT, "workHours")
        .and_then(|raw| serde_json::from_str::<WorkHours>(&raw).ok())
        .filter(valid_hours)
        .unwrap_or_default();
    MemberProfile {
        display_name,
        timezone,
        work_hours,
        updated_at: get_int(doc, &ROOT, "updatedAt").unwrap_or(0),
    }
}

pub fn write_profile(doc: &mut AutoCommit, p: &MemberProfile) -> Result<()> {
    validate(p)?;
    doc.put(ROOT, "displayName", p.display_name.trim())?;
    doc.put(ROOT, "timezone", p.timezone.as_str())?;
    doc.put(ROOT, "workHours", serde_json::to_string(&p.work_hours)?)?;
    doc.put(ROOT, "updatedAt", p.updated_at)?;
    Ok(())
}

pub fn read_notify(doc: &AutoCommit) -> NotifyPrefs {
    get_str(doc, &ROOT, NOTIFY_KEY)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn write_notify(doc: &mut AutoCommit, p: &NotifyPrefs) -> Result<()> {
    doc.put(ROOT, NOTIFY_KEY, serde_json::to_string(p)?)?;
    Ok(())
}

impl Node {
    /// 本機已同步的所有成員個人資料文件。
    fn profile_docs(&self) -> Result<Vec<(MemberId, String)>> {
        Ok(self
            .inner
            .store
            .doc_ids()?
            .into_iter()
            .filter_map(|id| match DocKind::parse(&id) {
                Some(DocKind::Member {
                    owner,
                    section: MemberSection::Profile,
                }) => Some((owner, id)),
                _ => None,
            })
            .collect())
    }

    pub fn my_profile(&self) -> Result<MemberProfile> {
        self.read_doc(&profile_doc(&self.member_id()), read_profile)
    }

    pub async fn set_my_profile(&self, mut p: MemberProfile) -> Result<()> {
        p.display_name = p.display_name.trim().to_owned();
        p.updated_at = now_ms();
        validate(&p)?;
        self.change(&profile_doc(&self.member_id()), |doc| {
            write_profile(doc, &p)
        })
        .await
    }

    /// 在職成員（含自己）的個人資料；沒有文件的成員不列出。
    pub fn member_profiles(&self) -> Result<BTreeMap<MemberId, MemberProfile>> {
        let org = self.org();
        let mut out = BTreeMap::new();
        for (owner, id) in self.profile_docs()? {
            if org.active_members().any(|(m, _)| *m == owner) {
                out.insert(owner, self.read_doc(&id, read_profile)?);
            }
        }
        Ok(out)
    }

    /// 顯示名稱：個人資料的 `displayName`，空白時用名冊姓名。
    pub fn display_name(&self, id: &MemberId) -> String {
        let custom = self
            .read_doc(&profile_doc(id), read_profile)
            .map(|p| p.display_name)
            .unwrap_or_default();
        if !custom.is_empty() {
            return custom;
        }
        self.org()
            .members
            .get(id)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| id.to_string())
    }

    pub fn notify_prefs(&self) -> NotifyPrefs {
        self.read_doc(&secrets_doc(&self.member_id()), read_notify)
            .unwrap_or_default()
    }

    pub async fn set_notify_prefs(&self, p: NotifyPrefs) -> Result<()> {
        self.change(&secrets_doc(&self.member_id()), |doc| write_notify(doc, &p))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> MemberProfile {
        MemberProfile {
            display_name: "  小美 ".into(),
            timezone: "Asia/Taipei".into(),
            work_hours: WorkHours {
                days: vec![1, 2, 3, 4],
                start: "08:30".into(),
                end: "17:30".into(),
            },
            updated_at: 5,
        }
    }

    #[test]
    fn roundtrip_and_trim() {
        let mut doc = AutoCommit::new();
        write_profile(&mut doc, &profile()).unwrap();
        let p = read_profile(&doc);
        assert_eq!(p.display_name, "小美");
        assert_eq!(p.timezone, "Asia/Taipei");
        assert_eq!(p.work_hours.days, vec![1, 2, 3, 4]);
        assert_eq!(p.updated_at, 5);
    }

    #[test]
    fn empty_doc_uses_defaults() {
        let p = read_profile(&AutoCommit::new());
        assert_eq!(p, MemberProfile::default());
        assert_eq!(p.work_hours.days, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn validation() {
        let ok = profile();
        assert!(validate(&ok).is_ok());
        let long = MemberProfile {
            display_name: "字".repeat(41),
            ..ok.clone()
        };
        assert!(validate(&long).is_err());
        for tz in [
            "Asia/Taipei",
            "UTC",
            "Etc/GMT+8",
            "America/Argentina/Buenos_Aires",
            "",
        ] {
            assert!(valid_tz(tz), "{tz}");
        }
        for tz in ["/Asia", "Asia/", "Asia//Taipei", "Asia/Tai pei", "8/Asia"] {
            assert!(!valid_tz(tz), "{tz}");
        }
        let dup = WorkHours {
            days: vec![1, 1],
            ..WorkHours::default()
        };
        assert!(!valid_hours(&dup));
        let bad_day = WorkHours {
            days: vec![0],
            ..WorkHours::default()
        };
        assert!(!valid_hours(&bad_day));
        let backwards = WorkHours {
            start: "18:00".into(),
            end: "09:00".into(),
            ..WorkHours::default()
        };
        assert!(!valid_hours(&backwards));
        let none = WorkHours {
            days: vec![],
            ..WorkHours::default()
        };
        assert!(valid_hours(&none));
    }

    #[test]
    fn invalid_fields_fall_back() {
        let mut doc = AutoCommit::new();
        doc.put(ROOT, "timezone", "bad tz").unwrap();
        doc.put(
            ROOT,
            "workHours",
            "{\"days\":[9],\"start\":\"09:00\",\"end\":\"18:00\"}",
        )
        .unwrap();
        let p = read_profile(&doc);
        assert_eq!(p.timezone, "");
        assert_eq!(p.work_hours, WorkHours::default());
    }

    #[test]
    fn notify_defaults_and_partial() {
        let mut doc = AutoCommit::new();
        assert_eq!(read_notify(&doc), NotifyPrefs::default());
        doc.put(ROOT, NOTIFY_KEY, "{\"assigned\":false}").unwrap();
        let n = read_notify(&doc);
        assert!(!n.assigned && n.messages && n.blockers && n.scrum_reminder);
        write_notify(
            &mut doc,
            &NotifyPrefs {
                messages: false,
                ..NotifyPrefs::default()
            },
        )
        .unwrap();
        assert!(!read_notify(&doc).messages);
    }
}
