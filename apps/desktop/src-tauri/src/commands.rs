//! Tauri commands：包裝 hills-node，前端只透過這裡讀取投影、送出意圖（development-guidelines §4.2）。
//!
//! 錯誤以字串回傳給前端顯示；不得包含金鑰、復原詞或業務資料內容。

use std::path::PathBuf;
use std::sync::Arc;

use hills_node::{
    CreateOrg, Event, LinkListener, LinkSession, MemberId, MemberStatus, Node, NodeOptions,
    PhraseLanguage, PresenceState, Pub32, Role, SecretStore, SyncStatus,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, oneshot};

use crate::keychain::Keychain;

type CmdResult<T> = Result<T, String>;

fn e(err: impl std::fmt::Display) -> String {
    err.to_string()
}

/// 前端事件名稱（`hills://…`）。
pub mod events {
    pub const NODE: &str = "hills://node";
    pub const LINK_SAS: &str = "hills://link-sas";
    pub const LINK_DONE: &str = "hills://link-done";
}

pub struct AppState {
    dir: PathBuf,
    secrets: Arc<dyn SecretStore>,
    node: Mutex<Option<Node>>,
    /// 新裝置端：等待舊裝置（取消用）
    link_cancel: Mutex<Option<oneshot::Sender<()>>>,
    /// 舊裝置端：已計算 SAS、等待使用者確認
    link_session: Mutex<Option<LinkSession>>,
}

impl AppState {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            secrets: Arc::new(Keychain::new()),
            node: Mutex::new(None),
            link_cancel: Mutex::new(None),
            link_session: Mutex::new(None),
        }
    }
}

fn opts() -> NodeOptions {
    NodeOptions::default()
}

/// 把 node 的事件轉送給前端（前端收到後重新讀取對應資料）。
fn forward_events(app: &AppHandle, node: &Node) {
    let mut rx = node.events();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let name = match ev {
                        Event::StatusChanged(_) => "status",
                        Event::Activated => "activated",
                        Event::OrgChanged => "org",
                        Event::RosterChanged => "roster",
                        Event::PresenceChanged => "presence",
                        Event::DocChanged(_) => "doc",
                    };
                    let _ = app.emit(events::NODE, name);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = app.emit(events::NODE, "all");
                }
                Err(_) => return,
            }
        }
    });
}

async fn install(app: &AppHandle, state: &AppState, node: Node) {
    forward_events(app, &node);
    *state.node.lock().await = Some(node);
    let _ = app.emit(events::NODE, "all");
}

macro_rules! with_node {
    ($state:expr, $n:ident => $body:expr) => {{
        let guard = $state.node.lock().await;
        let $n = guard.as_ref().ok_or_else(|| "尚未加入組織".to_string())?;
        $body
    }};
}

#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// welcome / pending / ready
    phase: &'static str,
    member_id: Option<String>,
    org_name: Option<String>,
    is_admin: bool,
    sync: Option<SyncStatus>,
    has_org_root: bool,
}

/// 啟動時呼叫：開啟既有節點（若有），回傳目前階段。
#[tauri::command]
pub async fn app_info(app: AppHandle, state: State<'_, AppState>) -> CmdResult<AppInfo> {
    let mut guard = state.node.lock().await;
    if guard.is_none()
        && let Some(node) = Node::open(&state.dir, state.secrets.clone(), opts())
            .await
            .map_err(e)?
    {
        forward_events(&app, &node);
        *guard = Some(node);
    }
    let Some(n) = guard.as_ref() else {
        return Ok(AppInfo {
            phase: "welcome",
            member_id: None,
            org_name: None,
            is_admin: false,
            sync: None,
            has_org_root: false,
        });
    };
    let phase = if n.member_status() == MemberStatus::Pending {
        "pending"
    } else {
        "ready"
    };
    let has_org_root = state
        .secrets
        .get(hills_node::config::ORG_ROOT_SECRET)
        .map(|v| v.is_some())
        .unwrap_or(false);
    Ok(AppInfo {
        phase,
        member_id: Some(n.member_id().to_string()),
        org_name: Some(n.org().name),
        is_admin: n.is_admin(),
        sync: Some(n.status()),
        has_org_root,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOrgArgs {
    org_name: String,
    my_name: String,
    device_name: String,
    mailbox_code: String,
    timezone: String,
    locale: String,
    team_name: String,
}

#[tauri::command]
pub async fn create_org(
    app: AppHandle,
    state: State<'_, AppState>,
    args: CreateOrgArgs,
) -> CmdResult<()> {
    let (node, _ok) = Node::create_org(
        &state.dir,
        state.secrets.clone(),
        CreateOrg {
            org_name: args.org_name.trim().to_owned(),
            my_name: args.my_name.trim().to_owned(),
            device_name: args.device_name.trim().to_owned(),
            mailbox_code: args.mailbox_code,
            timezone: args.timezone,
            locale: args.locale,
            team_name: args.team_name,
        },
        opts(),
    )
    .await
    .map_err(e)?;
    install(&app, &state, node).await;
    Ok(())
}

#[tauri::command]
pub async fn join_org(
    app: AppHandle,
    state: State<'_, AppState>,
    invite_code: String,
    my_name: String,
    device_name: String,
) -> CmdResult<()> {
    let node = Node::join(
        &state.dir,
        state.secrets.clone(),
        &invite_code,
        my_name.trim(),
        device_name.trim(),
        opts(),
    )
    .await
    .map_err(e)?;
    install(&app, &state, node).await;
    Ok(())
}

#[tauri::command]
pub async fn recover(
    app: AppHandle,
    state: State<'_, AppState>,
    words: String,
    org_code: String,
    device_name: String,
) -> CmdResult<()> {
    let node = Node::recover(
        &state.dir,
        state.secrets.clone(),
        &words,
        &org_code,
        device_name.trim(),
        opts(),
    )
    .await
    .map_err(e)?;
    install(&app, &state, node).await;
    Ok(())
}

fn lang(l: &str) -> PhraseLanguage {
    if l.starts_with("en") {
        PhraseLanguage::English
    } else {
        PhraseLanguage::TraditionalChinese
    }
}

/// 以介面語言回傳復原詞（D38）。只在復原詞畫面呼叫，前端不保存。
#[tauri::command]
pub async fn recovery_words(state: State<'_, AppState>, locale: String) -> CmdResult<Vec<String>> {
    with_node!(state, n => Ok(n.recovery_words(lang(&locale))))
}

/// 匯出組織根金鑰備份到「下載」資料夾，回傳檔案路徑。
#[tauri::command]
pub async fn export_org_root_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> CmdResult<String> {
    if password.chars().count() < 12 {
        return Err("密碼至少 12 個字元".into());
    }
    let bytes = with_node!(state, n => n.export_org_root_backup(&password).map_err(e)?);
    let dir = app.path().download_dir().map_err(e)?;
    let mut path = dir.join("hills-org-root.hillsbackup");
    let mut i = 1;
    while path.exists() {
        path = dir.join(format!("hills-org-root-{i}.hillsbackup"));
        i += 1;
    }
    std::fs::write(&path, bytes).map_err(e)?;
    Ok(path.display().to_string())
}

// ── 新裝置綁定 ──────────────────────────────────────────

/// 新裝置：開始等待舊裝置，回傳綁定碼與 QR（SVG）。SAS 以事件 `hills://link-sas` 送出，
/// 完成或失敗以 `hills://link-done`（payload：錯誤訊息或 null）送出。
#[tauri::command]
pub async fn link_start(
    app: AppHandle,
    state: State<'_, AppState>,
    org_code: String,
    device_name: String,
) -> CmdResult<Code> {
    let listener = LinkListener::start(
        &state.dir,
        state.secrets.clone(),
        &org_code,
        device_name.trim(),
        opts(),
    )
    .await
    .map_err(e)?;
    let code = Code::new(listener.code.clone())?;
    let (cancel_tx, cancel_rx) = oneshot::channel();
    if let Some(old) = state.link_cancel.lock().await.replace(cancel_tx) {
        let _ = old.send(());
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut sas = listener.sas.clone();
        let app3 = app2.clone();
        let sas_task = tauri::async_runtime::spawn(async move {
            if sas.wait_for(|s| s.is_some()).await.is_ok() {
                let v = sas.borrow().clone();
                let _ = app3.emit(events::LINK_SAS, v);
            }
        });
        let result = tokio::select! {
            r = listener.finish() => r.map(Some),
            _ = cancel_rx => Ok(None),
        };
        sas_task.abort();
        let state = app2.state::<AppState>();
        match result {
            Ok(Some(node)) => {
                install(&app2, &state, node).await;
                let _ = app2.emit(events::LINK_DONE, Option::<String>::None);
            }
            Ok(None) => {}
            Err(err) => {
                let _ = app2.emit(events::LINK_DONE, Some(err.to_string()));
            }
        }
    });
    Ok(code)
}

#[tauri::command]
pub async fn link_cancel(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(tx) = state.link_cancel.lock().await.take() {
        let _ = tx.send(());
    }
    if let Some(s) = state.link_session.lock().await.take() {
        s.cancel().await;
    }
    Ok(())
}

/// 舊裝置：貼上新裝置的綁定碼，回傳 SAS 供比對。
#[tauri::command]
pub async fn link_device(state: State<'_, AppState>, code: String) -> CmdResult<String> {
    let session = with_node!(state, n => n.link_device(&code).await.map_err(e)?);
    let sas = session.sas.clone();
    if let Some(old) = state.link_session.lock().await.replace(session) {
        old.cancel().await;
    }
    Ok(sas)
}

/// 舊裝置：使用者確認兩邊數字一致。
#[tauri::command]
pub async fn link_confirm(state: State<'_, AppState>, device_name: String) -> CmdResult<()> {
    let session = state
        .link_session
        .lock()
        .await
        .take()
        .ok_or("沒有進行中的綁定")?;
    session.confirm(device_name.trim()).await.map_err(e)
}

// ── 團隊與上線狀態 ──────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    id: String,
    name: String,
    is_admin: bool,
    is_me: bool,
    joined_at: i64,
    /// None = 離線
    presence: Option<PresenceState>,
    note: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamView {
    id: String,
    name: String,
    members: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    org_name: String,
    members: Vec<MemberView>,
    teams: Vec<TeamView>,
}

#[tauri::command]
pub async fn overview(state: State<'_, AppState>) -> CmdResult<Overview> {
    with_node!(state, n => {
        let org = n.org();
        let roles: std::collections::HashMap<MemberId, bool> = n.member_roles().into_iter().collect();
        let presence = n.presence();
        let me = n.member_id();
        let members = org
            .active_members()
            .map(|(id, m)| {
                let p = presence.get(id);
                MemberView {
                    id: id.to_string(),
                    name: m.name.clone(),
                    is_admin: roles.get(id).copied().unwrap_or(false),
                    is_me: *id == me,
                    joined_at: m.joined_at,
                    presence: p.map(|p| p.state),
                    note: p.map(|p| p.note.clone()).unwrap_or_default(),
                }
            })
            .collect();
        let teams = org
            .teams
            .iter()
            .map(|(id, t)| TeamView {
                id: id.clone(),
                name: t.name.clone(),
                members: t.members.iter().map(|m| m.to_string()).collect(),
            })
            .collect();
        Ok(Overview { org_name: org.name, members, teams })
    })
}

#[tauri::command]
pub async fn set_presence(
    state: State<'_, AppState>,
    presence: PresenceState,
    note: String,
) -> CmdResult<()> {
    with_node!(state, n => {
        n.set_presence(presence, &note).await;
        Ok(())
    })
}

#[tauri::command]
pub async fn sync_status(state: State<'_, AppState>) -> CmdResult<Option<SyncStatus>> {
    Ok(state.node.lock().await.as_ref().map(|n| n.status()))
}

#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>) -> CmdResult<()> {
    with_node!(state, n => n.sync_now().await.map_err(e))
}

// ── 設定 ────────────────────────────────────────────────

/// 文字碼與 QR（SVG）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Code {
    code: String,
    qr_svg: String,
}

impl Code {
    fn new(code: String) -> CmdResult<Self> {
        let qr = qrcode::QrCode::new(code.as_bytes()).map_err(e)?;
        let qr_svg = qr
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .build();
        Ok(Self { code, qr_svg })
    }
}

#[tauri::command]
pub async fn org_code(state: State<'_, AppState>) -> CmdResult<Code> {
    with_node!(state, n => Code::new(n.org_ticket().map_err(e)?))
}

#[tauri::command]
pub async fn create_invite(state: State<'_, AppState>, admin: bool) -> CmdResult<Code> {
    let role = if admin { Role::Admin } else { Role::Member };
    with_node!(state, n => Code::new(n.create_invite(role, vec![]).await.map_err(e)?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteView {
    id: String,
    admin: bool,
    expires_at: i64,
    mine: bool,
}

/// 尚未使用、未撤銷、未過期的邀請。
#[tauri::command]
pub async fn invites(state: State<'_, AppState>) -> CmdResult<Vec<InviteView>> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    with_node!(state, n => {
        let me = n.member_id();
        Ok(n.org()
            .invites
            .into_iter()
            .filter(|(_, i)| i.used_by.is_none() && !i.revoked && i.expires_at > now)
            .map(|(id, i)| InviteView {
                id,
                admin: i.role == Role::Admin,
                expires_at: i.expires_at,
                mine: i.created_by == me,
            })
            .collect())
    })
}

#[tauri::command]
pub async fn rename_org(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    with_node!(state, n => n.rename_org(&name).await.map_err(e))
}

#[tauri::command]
pub async fn revoke_member(state: State<'_, AppState>, member_id: String) -> CmdResult<()> {
    let id = MemberId::parse(&member_id).map_err(e)?;
    with_node!(state, n => {
        if id == n.member_id() {
            return Err("不能停用自己".into());
        }
        n.revoke_member(id).await.map_err(e)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    id: String,
    name: String,
    issued_at: i64,
    this_device: bool,
}

#[tauri::command]
pub async fn devices(state: State<'_, AppState>) -> CmdResult<Vec<DeviceInfo>> {
    with_node!(state, n => Ok(n
        .devices()
        .into_iter()
        .map(|d| DeviceInfo {
            id: d.device.to_string(),
            name: d.name,
            issued_at: d.issued_at,
            this_device: d.this_device,
        })
        .collect()))
}

fn parse_pub(s: &str) -> CmdResult<Pub32> {
    let bytes: Vec<u8> = (0..s.len())
        .step_by(2)
        .map(|i| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()))
        .collect::<Option<_>>()
        .ok_or("裝置 ID 格式錯誤")?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| "裝置 ID 格式錯誤")?;
    Ok(Pub32(arr))
}

#[tauri::command]
pub async fn revoke_device(state: State<'_, AppState>, device_id: String) -> CmdResult<()> {
    let id = parse_pub(&device_id)?;
    with_node!(state, n => {
        if id == n.device() {
            return Err("不能撤銷目前使用中的裝置".into());
        }
        n.revoke_device(id).await.map_err(e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_device_id() {
        let hex = "ab".repeat(32);
        assert_eq!(parse_pub(&hex).unwrap(), Pub32([0xab; 32]));
        assert!(parse_pub("abc").is_err());
        assert!(parse_pub(&"zz".repeat(32)).is_err());
    }

    #[test]
    fn qr_is_svg() {
        let c = Code::new("hills1-test".into()).unwrap();
        assert!(c.qr_svg.contains("<svg"));
    }

    #[test]
    fn phrase_language_follows_locale() {
        assert_eq!(lang("en"), PhraseLanguage::English);
        assert_eq!(lang("zh-TW"), PhraseLanguage::TraditionalChinese);
    }
}
