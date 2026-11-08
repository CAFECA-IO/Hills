//! Tauri commands：包裝 hills-node，前端只透過這裡讀取投影、送出意圖（development-guidelines §4.2）。
//!
//! 錯誤以字串回傳給前端顯示；不得包含金鑰或業務資料內容。

use std::path::PathBuf;
use std::sync::Arc;

use hills_node::{
    ConvKind, CreateOrg, Event, LegacyData, Location, Look, MemberId, MemberStatus, Message, Node,
    NodeOptions, OnboardKind, OnboardStep, Onboarding, PresenceState, Pub32, SecretStore,
    StepInput, SyncStatus, Task, TaskInput, TaskStatus,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::keychain::Keychain;

pub(crate) type CmdResult<T> = Result<T, String>;

pub(crate) fn e(err: impl std::fmt::Display) -> String {
    err.to_string()
}

/// 前端事件名稱（`hills://…`）。
pub mod events {
    pub const NODE: &str = "hills://node";
}

pub struct AppState {
    dir: PathBuf,
    secrets: Arc<dyn SecretStore>,
    pub(crate) node: Mutex<Option<Node>>,
    /// 使用者本次選擇的檔案與下載目標（technical-design §15.2–15.5）
    pub(crate) files: std::sync::Mutex<crate::files::Registry>,
    /// 進行中的 CAFECA 登入（technical-design §17）與其登入連結
    onboarding: Mutex<Option<(Onboarding, String)>>,
    /// 前端目前開著的對話（該對話的新訊息不發通知）
    active_conv: std::sync::Mutex<Option<String>>,
    /// 會議 / 午休 / 專注期間延後的通知數（technical-design §5.1 v0.11）
    deferred: std::sync::Mutex<u32>,
}

impl AppState {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            secrets: Arc::new(Keychain::new()),
            node: Mutex::new(None),
            onboarding: Mutex::new(None),
            active_conv: std::sync::Mutex::new(None),
            deferred: std::sync::Mutex::new(0),
            files: std::sync::Mutex::new(crate::files::Registry::default()),
        }
    }
}

/// 只有 debug 建置（`tauri dev`、CI 測試安裝檔）接受開發測試模式的測試帳號（D44，§17.10）。
const ALLOW_DEV_LOGIN: bool = cfg!(debug_assertions);

fn opts() -> NodeOptions {
    NodeOptions {
        allow_dev_login: ALLOW_DEV_LOGIN,
        ..NodeOptions::default()
    }
}

/// 把 node 的事件轉送給前端（前端收到後重新讀取對應資料），並發出桌機通知（§14.2）。
fn forward_events(app: &AppHandle, node: &Node) {
    let mut rx = node.events();
    let app = app.clone();
    let node = node.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let name = match &ev {
                        Event::StatusChanged(_) => "status",
                        Event::Activated => "activated",
                        Event::OrgChanged => "org",
                        Event::RosterChanged => "roster",
                        Event::PresenceChanged => "presence",
                        Event::DocChanged(_) => "doc",
                        Event::ConvsChanged => "convs",
                        Event::Message { .. } => "message",
                        Event::JoinsChanged => "joins",
                        Event::DeviceAdded { .. } => "device-added",
                        Event::Rejected => "rejected",
                        Event::ScrumBlocker { .. } => "doc",
                    };
                    if let Event::ScrumBlocker { member, text, .. } = &ev {
                        notify_scrum_blocker(&app, &node, member, text);
                    }
                    if let Event::DeviceAdded { name, .. } = &ev {
                        notify_device_added(&app, &node, name);
                    }
                    if let Event::Message {
                        conv,
                        author,
                        notify: true,
                        preview,
                    } = &ev
                    {
                        notify_message(&app, &node, conv, author, preview);
                    }
                    if matches!(ev, Event::PresenceChanged) {
                        flush_deferred(&app, &node);
                    }
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

/// 私訊或提及：視窗不在前景、或沒有開著該對話時發出通知。標題為寄件者姓名、內容為訊息預覽。
fn notify_message(app: &AppHandle, node: &Node, conv: &str, author: &MemberId, preview: &str) {
    use tauri_plugin_notification::NotificationExt;
    let focused = app
        .get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    let viewing = app
        .state::<AppState>()
        .active_conv
        .lock()
        .map(|a| a.as_deref() == Some(conv))
        .unwrap_or(false);
    if focused && viewing {
        return;
    }
    if my_presence_defers(node) {
        if let Ok(mut n) = app.state::<AppState>().deferred.lock() {
            *n += 1;
        }
        return;
    }
    let title = node
        .org()
        .members
        .get(author)
        .map(|m| m.name.clone())
        .unwrap_or_else(|| author.to_string());
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(preview)
        .show();
}

/// 小組成員回報阻礙（technical-design §16.12）：通知負責人。
fn notify_scrum_blocker(app: &AppHandle, node: &Node, member: &MemberId, text: &str) {
    use tauri_plugin_notification::NotificationExt;
    let zh = !node.org().locale.starts_with("en");
    let name = node
        .org()
        .members
        .get(member)
        .map(|m| m.name.clone())
        .unwrap_or_default();
    let title = if zh {
        format!("{name} 回報了阻礙")
    } else {
        format!("{name} reported a blocker")
    };
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(text.chars().take(120).collect::<String>())
        .show();
}

/// 本人的新裝置已加入（technical-design §17.6 步驟 5）：可在「設定 → 我的裝置」撤銷。
fn notify_device_added(app: &AppHandle, node: &Node, name: &str) {
    use tauri_plugin_notification::NotificationExt;
    let zh = !node.org().locale.starts_with("en");
    let body = if zh {
        format!("新裝置「{name}」已加入你的帳戶。如果不是你本人，請到「設定 → 我的裝置」撤銷。")
    } else {
        format!(
            "New device “{name}” was added to your account. If it wasn't you, revoke it in Settings → My devices."
        )
    };
    let _ = app
        .notification()
        .builder()
        .title("Hills")
        .body(body)
        .show();
}

/// 會議、午休、專注中，且回來時間未到（未設定則直到手動切換）時延後通知。
pub(crate) fn defers(state: PresenceState, until: Option<i64>, now: i64) -> bool {
    matches!(
        state,
        PresenceState::Meeting | PresenceState::Lunch | PresenceState::Focus
    ) && until.is_none_or(|u| u > now)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn my_presence_defers(node: &Node) -> bool {
    node.presence()
        .get(&node.member_id())
        .is_some_and(|p| defers(p.state, p.until, now_ms()))
}

/// 狀態結束後，以一則摘要通知延後期間收到的訊息數。
fn flush_deferred(app: &AppHandle, node: &Node) {
    use tauri_plugin_notification::NotificationExt;
    if my_presence_defers(node) {
        return;
    }
    let count = app
        .state::<AppState>()
        .deferred
        .lock()
        .map(|mut n| std::mem::take(&mut *n))
        .unwrap_or(0);
    if count == 0 {
        return;
    }
    let zh = node.org().locale.starts_with("zh");
    let (title, body) = if zh {
        ("Hills".to_string(), format!("剛才收到 {count} 則訊息"))
    } else {
        (
            "Hills".to_string(),
            format!("{count} messages arrived while you were away"),
        )
    };
    let _ = app.notification().builder().title(title).body(body).show();
}

async fn install(app: &AppHandle, state: &AppState, node: Node) {
    forward_events(app, &node);
    *state.node.lock().await = Some(node);
    let _ = app.emit(events::NODE, "all");
}

#[macro_export]
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
    /// welcome / pending / ready / legacy（舊版資料，需清除，technical-design §17.9）
    phase: &'static str,
    member_id: Option<String>,
    org_name: Option<String>,
    is_admin: bool,
    sync: Option<SyncStatus>,
    has_org_root: bool,
    /// 此建置可用測試帳號（D44）
    dev_login: bool,
}

/// 啟動時呼叫：開啟既有節點（若有），回傳目前階段。
#[tauri::command]
pub async fn app_info(app: AppHandle, state: State<'_, AppState>) -> CmdResult<AppInfo> {
    let mut guard = state.node.lock().await;
    if guard.is_none() {
        match Node::open(&state.dir, state.secrets.clone(), opts()).await {
            Ok(Some(node)) => {
                forward_events(&app, &node);
                *guard = Some(node);
            }
            Ok(None) => {}
            Err(err) if err.downcast_ref::<LegacyData>().is_some() => {
                return Ok(AppInfo {
                    phase: "legacy",
                    member_id: None,
                    org_name: None,
                    is_admin: false,
                    sync: None,
                    has_org_root: false,
                    dev_login: ALLOW_DEV_LOGIN,
                });
            }
            Err(err) => return Err(e(err)),
        }
    }
    let Some(n) = guard.as_ref() else {
        return Ok(AppInfo {
            phase: "welcome",
            member_id: None,
            org_name: None,
            is_admin: false,
            sync: None,
            has_org_root: false,
            dev_login: ALLOW_DEV_LOGIN,
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
        dev_login: ALLOW_DEV_LOGIN,
    })
}

/// 清除本機所有 Hills 資料（舊版資料，或使用者要重新開始；technical-design §17.9）。
#[tauri::command]
pub async fn reset_local_data(state: State<'_, AppState>) -> CmdResult<()> {
    let mut guard = state.node.lock().await;
    if let Some(n) = guard.take() {
        n.shutdown().await;
    }
    if let Some((ob, _)) = state.onboarding.lock().await.take() {
        ob.cancel().await;
    }
    hills_node::config::wipe_secrets(&state.secrets).map_err(e)?;
    if state.dir.exists() {
        std::fs::remove_dir_all(&state.dir).map_err(e)?;
    }
    std::fs::create_dir_all(&state.dir).map_err(e)?;
    Ok(())
}

// ── 以 CAFECA 登入（technical-design §17）────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardArgs {
    /// create / join / recover
    kind: String,
    #[serde(default)]
    org_name: String,
    #[serde(default)]
    my_name: String,
    device_name: String,
    /// create：mailbox 連線碼；join / recover：組織連線碼
    code: String,
    #[serde(default)]
    timezone: String,
    #[serde(default)]
    locale: String,
    #[serde(default)]
    team_name: String,
    /// 開發測試模式的測試帳號名稱（D44）；空字串為正式 CAFECA 登入
    #[serde(default)]
    dev_account: String,
}

/// 登入連結（QR 與「在這台電腦開啟」）與確認碼。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInInfo {
    code: String,
    expires_at: u64,
    qr_svg: String,
}

/// 開始以 CAFECA 登入。
#[tauri::command]
pub async fn onboard_begin(state: State<'_, AppState>, args: OnboardArgs) -> CmdResult<SignInInfo> {
    let device_name = args.device_name.trim().chars().take(60).collect::<String>();
    let kind = match args.kind.as_str() {
        "create" => OnboardKind::Create(CreateOrg {
            org_name: args.org_name.trim().to_owned(),
            my_name: args.my_name.trim().to_owned(),
            device_name,
            mailbox_code: args.code,
            timezone: args.timezone,
            locale: args.locale,
            team_name: args.team_name,
        }),
        "join" => OnboardKind::Join {
            org_code: args.code,
            my_name: args.my_name.trim().to_owned(),
            device_name,
        },
        "recover" => OnboardKind::Recover {
            org_code: args.code,
            device_name,
        },
        _ => return Err("未知的登入目的".into()),
    };
    if let Some((old, _)) = state.onboarding.lock().await.take() {
        old.cancel().await;
    }
    let dev_account = Some(args.dev_account.trim().to_owned()).filter(|n| !n.is_empty());
    let (ob, view) =
        Onboarding::begin_with(&state.dir, state.secrets.clone(), kind, opts(), dev_account)
            .await
            .map_err(e)?;
    // 測試帳號沒有登入連結
    let qr_svg = if view.link.is_empty() {
        String::new()
    } else {
        qrcode::QrCode::new(view.link.as_bytes())
            .map_err(e)?
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .build()
    };
    *state.onboarding.lock().await = Some((ob, view.link));
    Ok(SignInInfo {
        code: view.code,
        expires_at: view.expires_at,
        qr_svg,
    })
}

/// 以系統瀏覽器開啟目前的登入連結（「在這台電腦開啟」）。
#[tauri::command]
pub async fn onboard_open_link(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let link = state
        .onboarding
        .lock()
        .await
        .as_ref()
        .map(|(_, l)| l.clone())
        .filter(|l| !l.is_empty())
        .ok_or("沒有進行中的登入")?;
    app.opener().open_url(link, None::<&str>).map_err(e)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardStatus {
    /// signin / device / approval / created / linked / denied / expired
    step: &'static str,
    handle: Option<String>,
}

/// 查詢登入進度。完成時節點已啟動。
#[tauri::command]
pub async fn onboard_poll(app: AppHandle, state: State<'_, AppState>) -> CmdResult<OnboardStatus> {
    let mut guard = state.onboarding.lock().await;
    let Some((ob, _)) = guard.as_mut() else {
        return Err("沒有進行中的登入".into());
    };
    let step = match ob.poll().await {
        Ok(s) => s,
        Err(err) => {
            let code = match err.downcast_ref::<hills_cafeca::CafecaError>() {
                Some(hills_cafeca::CafecaError::Denied) => Some("denied"),
                Some(hills_cafeca::CafecaError::Expired) => Some("expired"),
                _ => None,
            };
            return match code {
                Some(step) => {
                    if let Some((ob, _)) = guard.take() {
                        ob.cancel().await;
                    }
                    Ok(OnboardStatus { step, handle: None })
                }
                None => Err(e(err)),
            };
        }
    };
    let (status, node) = match step {
        OnboardStep::WaitingSignIn => (("signin", None), None),
        OnboardStep::WaitingDevice { handle } => (("device", handle), None),
        OnboardStep::WaitingApproval(n) => (("approval", None), Some(n)),
        OnboardStep::Created(n, _ok) => (("created", None), Some(n)),
        OnboardStep::Linked(n) => (("linked", None), Some(n)),
    };
    if let Some(n) = node {
        guard.take();
        drop(guard);
        install(&app, &state, n).await;
    }
    Ok(OnboardStatus {
        step: status.0,
        handle: status.1,
    })
}

#[tauri::command]
pub async fn onboard_cancel(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some((ob, _)) = state.onboarding.lock().await.take() {
        ob.cancel().await;
    }
    Ok(())
}

/// 匯出組織根金鑰備份到「下載」資料夾，回傳檔案路徑。/// 匯出組織根金鑰備份到「下載」資料夾，回傳檔案路徑。
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
    /// 回來時間（ms）
    until: Option<i64>,
    /// `hidden` / `remote` / `office:<id>`
    location: String,
    look: Option<Look>,
}

fn location_str(l: &Location) -> String {
    match l {
        Location::Hidden => "hidden".into(),
        Location::Remote => "remote".into(),
        Location::Office(id) => format!("office:{id}"),
    }
}

fn parse_location(s: &str) -> CmdResult<Location> {
    match s {
        "hidden" => Ok(Location::Hidden),
        "remote" => Ok(Location::Remote),
        _ => s
            .strip_prefix("office:")
            .filter(|id| !id.is_empty() && id.len() <= 64)
            .map(|id| Location::Office(id.to_owned()))
            .ok_or_else(|| "地點格式錯誤".to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeView {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LunchView {
    start: String,
    end: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamView {
    id: String,
    name: String,
    members: Vec<String>,
    leads: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    org_name: String,
    members: Vec<MemberView>,
    teams: Vec<TeamView>,
    offices: Vec<OfficeView>,
    lunch_break: Option<LunchView>,
    /// 組織時區（IANA；計劃期間依此計算，technical-design §16.10）
    timezone: String,
}

#[tauri::command]
pub async fn overview(state: State<'_, AppState>) -> CmdResult<Overview> {
    with_node!(state, n => {
        let org = n.org();
        let roles: std::collections::HashMap<MemberId, bool> = n.member_roles().into_iter().collect();
        let presence = n.presence();
        let me = n.member_id();
        let looks = n.profiles().unwrap_or_default();
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
                    until: p.and_then(|p| p.until),
                    location: p.map(|p| location_str(&p.location)).unwrap_or_else(|| "hidden".into()),
                    look: looks.get(id).copied(),
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
                leads: t.leads.iter().map(|m| m.to_string()).collect(),
            })
            .collect();
        let offices = org
            .offices
            .iter()
            .map(|(id, o)| OfficeView { id: id.clone(), name: o.name.clone() })
            .collect();
        let lunch_break = org
            .lunch_break
            .as_ref()
            .map(|l| LunchView { start: l.start.clone(), end: l.end.clone() });
        Ok(Overview { org_name: org.name, members, teams, offices, lunch_break, timezone: org.timezone })
    })
}

#[tauri::command]
pub async fn set_presence(
    state: State<'_, AppState>,
    presence: PresenceState,
    note: String,
    until: Option<i64>,
    location: Option<String>,
) -> CmdResult<()> {
    let location = location.as_deref().map(parse_location).transpose()?;
    with_node!(state, n => {
        match location {
            Some(l) => n.set_presence_full(presence, &note, until, l).await,
            // 舊介面（閒置自動暫離）：保留地點與回來時間
            None => n.set_presence(presence, &note).await,
        }
        Ok(())
    })
}

// ── 任務、焦點、角色外觀、辦公室（D40、technical-design §16.8 v0.11）──

fn opt_member(s: &Option<String>) -> CmdResult<Option<MemberId>> {
    s.as_deref()
        .filter(|x| !x.is_empty())
        .map(parse_member)
        .transpose()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepView {
    id: String,
    title: String,
    assignee: Option<String>,
    done: bool,
    done_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    id: String,
    team: String,
    title: String,
    assignee: Option<String>,
    status: TaskStatus,
    due_at: Option<i64>,
    steps: Vec<StepView>,
    plan_item_id: Option<String>,
    created_by: Option<String>,
    created_at: i64,
    updated_at: i64,
}

impl From<Task> for TaskView {
    fn from(t: Task) -> Self {
        Self {
            id: t.id,
            team: t.team,
            title: t.title,
            assignee: t.assignee.map(|m| m.to_string()),
            status: t.status,
            due_at: t.due_at,
            steps: t
                .steps
                .into_iter()
                .map(|s| StepView {
                    id: s.id,
                    title: s.title,
                    assignee: s.assignee.map(|m| m.to_string()),
                    done: s.done,
                    done_at: s.done_at,
                })
                .collect(),
            plan_item_id: t.plan_item_id,
            created_by: t.created_by.map(|m| m.to_string()),
            created_at: t.created_at,
            updated_at: t.updated_at,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepArgs {
    id: Option<String>,
    title: String,
    assignee: Option<String>,
    #[serde(default)]
    done: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArgs {
    title: String,
    assignee: Option<String>,
    status: Option<TaskStatus>,
    due_at: Option<i64>,
    #[serde(default)]
    steps: Vec<StepArgs>,
    #[serde(default)]
    plan_item_id: Option<String>,
}

impl TaskArgs {
    fn into_input(self) -> CmdResult<TaskInput> {
        Ok(TaskInput {
            title: self.title,
            assignee: opt_member(&self.assignee)?,
            status: self.status,
            due_at: self.due_at,
            steps: self
                .steps
                .into_iter()
                .map(|s| {
                    Ok(StepInput {
                        id: s.id,
                        title: s.title,
                        assignee: opt_member(&s.assignee)?,
                        done: s.done,
                    })
                })
                .collect::<CmdResult<_>>()?,
            plan_item_id: self.plan_item_id,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusView {
    task: Option<TaskView>,
    manual: bool,
}

#[tauri::command]
pub async fn tasks(state: State<'_, AppState>) -> CmdResult<Vec<TaskView>> {
    with_node!(state, n => Ok(n.tasks().map_err(e)?.into_iter().map(Into::into).collect()))
}

#[tauri::command]
pub async fn create_task(
    state: State<'_, AppState>,
    team: String,
    input: TaskArgs,
) -> CmdResult<String> {
    let input = input.into_input()?;
    with_node!(state, n => n.create_task(&team, input).await.map_err(e))
}

#[tauri::command]
pub async fn update_task(
    state: State<'_, AppState>,
    team: String,
    task: String,
    input: TaskArgs,
) -> CmdResult<()> {
    let input = input.into_input()?;
    with_node!(state, n => n.update_task(&team, &task, input).await.map_err(e))
}

#[tauri::command]
pub async fn set_step_done(
    state: State<'_, AppState>,
    team: String,
    task: String,
    step: String,
    done: bool,
) -> CmdResult<()> {
    with_node!(state, n => n.set_step_done(&team, &task, &step, done).await.map_err(e))
}

#[tauri::command]
pub async fn delete_task(state: State<'_, AppState>, team: String, task: String) -> CmdResult<()> {
    with_node!(state, n => n.delete_task(&team, &task).await.map_err(e))
}

// ── 目標（五層計劃，technical-design §16.10）────────────────

/// 一個計劃項目與彙總後的進度（0–100）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    #[serde(flatten)]
    item: hills_node::plans::PlanItem,
    progress: f64,
    /// 關鍵結果 id → 進度
    kr_progress: std::collections::BTreeMap<String, f64>,
    mine: bool,
}

/// 計劃項目與彙總進度；任務進度計入週目標（D46，technical-design §16.10）。
fn rolled_plans(
    n: &hills_node::Node,
    query: hills_node::plans::PlanQuery,
) -> anyhow::Result<(Vec<hills_node::plans::PlanItem>, hills_node::plans::Rollup)> {
    let items = n.plans(query)?;
    let tasks: Vec<(String, f64)> = n
        .tasks()?
        .iter()
        .filter_map(|t| t.plan_item_id.clone().map(|p| (p, t.progress())))
        .collect();
    let r = hills_node::plans::rollup(&items, &tasks);
    Ok((items, r))
}

/// 全部看得到的計劃項目（前端依期間篩選；進度以全部可見項目彙總）。
#[tauri::command]
pub async fn plans(state: State<'_, AppState>, mine_only: bool) -> CmdResult<Vec<PlanView>> {
    use hills_node::plans::PlanQuery;
    let query = if mine_only {
        PlanQuery::Mine
    } else {
        PlanQuery::Visible
    };
    with_node!(state, n => {
        let me = n.member_id();
        let (items, r) = rolled_plans(n, query).map_err(e)?;
        Ok(items
            .into_iter()
            .map(|item| {
                let kr_progress = item
                    .key_results
                    .iter()
                    .filter_map(|k| {
                        r.krs.get(&format!("{}/{}", item.id, k.id)).map(|v| (k.id.clone(), *v))
                    })
                    .collect();
                PlanView {
                    progress: r.items.get(&item.id).copied().unwrap_or(0.0),
                    kr_progress,
                    mine: item.owner == me,
                    item,
                }
            })
            .collect())
    })
}

#[tauri::command]
pub async fn save_plan(
    state: State<'_, AppState>,
    input: hills_node::plans::PlanInput,
) -> CmdResult<String> {
    with_node!(state, n => n.save_plan(input).await.map_err(e))
}

#[tauri::command]
pub async fn set_plan_done(state: State<'_, AppState>, id: String, done: bool) -> CmdResult<()> {
    with_node!(state, n => n.set_plan_done(&id, done).await.map_err(e))
}

#[tauri::command]
pub async fn delete_plan(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    with_node!(state, n => n.delete_plan(&id).await.map_err(e))
}

// ── 團隊方向（technical-design §16.14，D47）──────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectionView {
    #[serde(flatten)]
    item: hills_node::direction::Direction,
    progress: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamGoalView {
    #[serde(flatten)]
    item: hills_node::direction::TeamGoal,
    progress: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectionsView {
    directions: Vec<DirectionView>,
    team_goals: Vec<TeamGoalView>,
}

/// 公司方向與小組目標，含讀者看得到的對齊進度。
#[tauri::command]
pub async fn directions(state: State<'_, AppState>) -> CmdResult<DirectionsView> {
    use hills_node::direction::direction_progress;
    with_node!(state, n => {
        let dirs = n.directions().map_err(e)?;
        let goals = n.team_goals().map_err(e)?;
        let (items, r) = rolled_plans(n, hills_node::plans::PlanQuery::Visible).map_err(e)?;
        let p = direction_progress(&dirs, &goals, &items, &r.items);
        Ok(DirectionsView {
            directions: dirs
                .into_iter()
                .map(|d| DirectionView {
                    progress: p.directions.get(&d.id).copied().unwrap_or(0.0),
                    item: d,
                })
                .collect(),
            team_goals: goals
                .into_iter()
                .map(|g| TeamGoalView {
                    progress: p.team_goals.get(&g.id).copied().unwrap_or(0.0),
                    item: g,
                })
                .collect(),
        })
    })
}

#[tauri::command]
pub async fn save_direction(
    state: State<'_, AppState>,
    input: hills_node::direction::DirectionInput,
) -> CmdResult<String> {
    with_node!(state, n => n.save_direction(input).await.map_err(e))
}

#[tauri::command]
pub async fn delete_direction(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    with_node!(state, n => n.delete_direction(&id).await.map_err(e))
}

#[tauri::command]
pub async fn save_team_goal(
    state: State<'_, AppState>,
    input: hills_node::direction::TeamGoalInput,
) -> CmdResult<String> {
    with_node!(state, n => n.save_team_goal(input).await.map_err(e))
}

#[tauri::command]
pub async fn delete_team_goal(
    state: State<'_, AppState>,
    team: String,
    id: String,
) -> CmdResult<()> {
    with_node!(state, n => n.delete_team_goal(&team, &id).await.map_err(e))
}

// ── 知識庫（technical-design §16.11）─────────────────────────

#[tauri::command]
pub async fn kb(state: State<'_, AppState>) -> CmdResult<hills_node::kb::KbSnapshot> {
    with_node!(state, n => n.kb().map_err(e))
}

#[tauri::command]
pub async fn kb_save(
    state: State<'_, AppState>,
    input: hills_node::kb::KbInput,
) -> CmdResult<String> {
    with_node!(state, n => n.kb_save(input).await.map_err(e))
}

#[tauri::command]
pub async fn kb_delete(state: State<'_, AppState>, key: String) -> CmdResult<()> {
    with_node!(state, n => n.kb_delete(&key).await.map_err(e))
}

#[tauri::command]
pub async fn kb_create_category(state: State<'_, AppState>, name: String) -> CmdResult<String> {
    with_node!(state, n => n.kb_create_category(&name).await.map_err(e))
}

#[tauri::command]
pub async fn kb_create_topic(
    state: State<'_, AppState>,
    category: String,
    name: String,
) -> CmdResult<String> {
    with_node!(state, n => n.kb_create_topic(&category, &name).await.map_err(e))
}

/// `kind` = category / topic。
#[tauri::command]
pub async fn kb_rename(
    state: State<'_, AppState>,
    kind: String,
    id: String,
    name: String,
) -> CmdResult<()> {
    with_node!(state, n => n.kb_rename(&kind, &id, &name).await.map_err(e))
}

#[tauri::command]
pub async fn kb_merge(
    state: State<'_, AppState>,
    kind: String,
    from: String,
    into: String,
) -> CmdResult<()> {
    with_node!(state, n => n.kb_merge(&kind, &from, &into).await.map_err(e))
}

/// 從訊息（或其第 `attachment` 個附件）存成知識。
#[tauri::command]
pub async fn kb_from_message(
    state: State<'_, AppState>,
    conv: String,
    message_key: String,
    topic: String,
    title: String,
    attachment: Option<usize>,
) -> CmdResult<String> {
    with_node!(state, n => n
        .kb_from_message(&conv, &message_key, &topic, &title, attachment)
        .await
        .map_err(e))
}

// ── 日 / 週報（technical-design §16.13）────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportMine {
    report: Option<hills_node::reports::Report>,
    draft: Option<String>,
}

fn report_kind(kind: &str) -> CmdResult<hills_node::reports::ReportKind> {
    use hills_node::reports::ReportKind;
    match kind {
        "daily" => Ok(ReportKind::Daily),
        "weekly" => Ok(ReportKind::Weekly),
        _ => Err("未知的報表種類".into()),
    }
}

#[tauri::command]
pub async fn report_mine(
    state: State<'_, AppState>,
    kind: String,
    period: String,
) -> CmdResult<ReportMine> {
    let k = report_kind(&kind)?;
    with_node!(state, n => Ok(ReportMine {
        report: n.my_report(k, &period).map_err(e)?,
        draft: n.report_local().drafts.get(&format!("{kind}:{period}")).cloned(),
    }))
}

#[tauri::command]
pub async fn report_publish(
    state: State<'_, AppState>,
    input: hills_node::reports::ReportInput,
) -> CmdResult<hills_node::reports::Report> {
    with_node!(state, n => {
        let (kind, period) = (input.kind, input.period.clone());
        let r = n.publish_report(input).await.map_err(e)?;
        n.set_report_draft(kind, &period, None).map_err(e)?;
        Ok(r)
    })
}

#[tauri::command]
pub async fn report_team(
    state: State<'_, AppState>,
    team: String,
    kind: String,
    period: String,
) -> CmdResult<Vec<hills_node::reports::Report>> {
    let k = report_kind(&kind)?;
    with_node!(state, n => n.team_reports(&team, k, &period).map_err(e))
}

#[tauri::command]
pub async fn report_draft_set(
    state: State<'_, AppState>,
    kind: String,
    period: String,
    draft: Option<String>,
) -> CmdResult<()> {
    let k = report_kind(&kind)?;
    with_node!(state, n => n.set_report_draft(k, &period, draft).map_err(e))
}

/// 週五提醒產生週報（每週一次，本週已發佈就不提醒）。
#[tauri::command]
pub async fn report_remind(
    app: AppHandle,
    state: State<'_, AppState>,
    week: String,
    title: String,
    body: String,
) -> CmdResult<bool> {
    use tauri_plugin_notification::NotificationExt;
    with_node!(state, n => {
        let published = n
            .my_report(hills_node::reports::ReportKind::Weekly, &week)
            .map_err(e)?
            .is_some();
        if published || !n.mark_report_reminded(&week).map_err(e)? {
            return Ok(false);
        }
        let _ = app.notification().builder().title(title).body(body).show();
        Ok(true)
    })
}

// ── 每日 Scrum（technical-design §16.12）──────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrumMine {
    report: Option<hills_node::scrum::ScrumReport>,
    /// 本機草稿（前端定義的 JSON 字串）
    draft: Option<String>,
    /// 阻礙會通知的對象
    notify: Vec<String>,
}

#[tauri::command]
pub async fn scrum_mine(state: State<'_, AppState>, date: String) -> CmdResult<ScrumMine> {
    with_node!(state, n => {
        let me = n.member_id();
        let org = n.org();
        let admins: Vec<MemberId> =
            n.member_roles().into_iter().filter(|(_, a)| *a).map(|(m, _)| m).collect();
        let notify = hills_node::scrum::notify_targets(&org, &me, &org.teams_of(&me), &admins)
            .iter()
            .map(|m| m.to_string())
            .collect();
        Ok(ScrumMine {
            report: n.my_scrum(&date).map_err(e)?,
            draft: n.scrum_local().drafts.get(&date).cloned(),
            notify,
        })
    })
}

#[tauri::command]
pub async fn scrum_submit(
    state: State<'_, AppState>,
    input: hills_node::scrum::ScrumInput,
) -> CmdResult<hills_node::scrum::ScrumReport> {
    with_node!(state, n => {
        let date = input.date.clone();
        let r = n.scrum_submit(input).await.map_err(e)?;
        n.set_scrum_draft(&date, None).map_err(e)?;
        Ok(r)
    })
}

#[tauri::command]
pub async fn scrum_team(
    state: State<'_, AppState>,
    team: String,
    from: String,
    to: String,
) -> CmdResult<Vec<hills_node::scrum::ScrumReport>> {
    with_node!(state, n => n.scrum_reports(&team, &from, &to).map_err(e))
}

#[tauri::command]
pub async fn scrum_draft_set(
    state: State<'_, AppState>,
    date: String,
    draft: Option<String>,
) -> CmdResult<()> {
    with_node!(state, n => n.set_scrum_draft(&date, draft).map_err(e))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrumReminder {
    /// 組織預設
    org: String,
    /// 個人覆寫（None = 組織預設）
    mine: Option<String>,
}

#[tauri::command]
pub async fn scrum_reminder(state: State<'_, AppState>) -> CmdResult<ScrumReminder> {
    with_node!(state, n => Ok(ScrumReminder { org: n.scrum_reminder(), mine: n.scrum_local().reminder }))
}

#[tauri::command]
pub async fn set_my_scrum_reminder(
    state: State<'_, AppState>,
    hhmm: Option<String>,
) -> CmdResult<()> {
    let hhmm = hhmm.filter(|h| !h.trim().is_empty());
    with_node!(state, n => n.set_my_scrum_reminder(hhmm).map_err(e))
}

#[tauri::command]
pub async fn set_org_scrum_reminder(state: State<'_, AppState>, hhmm: String) -> CmdResult<()> {
    with_node!(state, n => n.set_scrum_reminder(&hhmm).await.map_err(e))
}

/// 前端在提醒時間（組織時區、工作日、尚未送出）呼叫；每天最多通知一次。
#[tauri::command]
pub async fn scrum_remind(
    app: AppHandle,
    state: State<'_, AppState>,
    date: String,
    title: String,
    body: String,
) -> CmdResult<bool> {
    use tauri_plugin_notification::NotificationExt;
    with_node!(state, n => {
        if n.my_scrum(&date).map_err(e)?.is_some() || !n.mark_scrum_reminded(&date).map_err(e)? {
            return Ok(false);
        }
        let _ = app.notification().builder().title(title).body(body).show();
        Ok(true)
    })
}

#[tauri::command]
pub async fn focus(state: State<'_, AppState>) -> CmdResult<FocusView> {
    with_node!(state, n => {
        let f = n.focus().map_err(e)?;
        Ok(FocusView { task: f.task.map(Into::into), manual: f.manual })
    })
}

/// 手動選擇焦點；`task` 為空時回到自動。
#[tauri::command]
pub async fn set_focus(
    app: AppHandle,
    state: State<'_, AppState>,
    team: Option<String>,
    task: Option<String>,
) -> CmdResult<()> {
    with_node!(state, n => {
        let choice = team.as_deref().zip(task.as_deref());
        n.set_focus(choice).map_err(e)?;
        let _ = app.emit(events::NODE, "doc");
        Ok(())
    })
}

#[tauri::command]
pub async fn set_profile(state: State<'_, AppState>, look: Look) -> CmdResult<()> {
    with_node!(state, n => n.set_profile(look).await.map_err(e))
}

#[tauri::command]
pub async fn upsert_office(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
) -> CmdResult<String> {
    with_node!(state, n => n.upsert_office(id.as_deref(), &name).await.map_err(e))
}

#[tauri::command]
pub async fn remove_office(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    with_node!(state, n => n.remove_office(&id).await.map_err(e))
}

#[tauri::command]
pub async fn set_lunch_break(
    state: State<'_, AppState>,
    start: String,
    end: String,
) -> CmdResult<()> {
    with_node!(state, n => n.set_lunch_break(&start, &end).await.map_err(e))
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

/// 本人的 CAFECA 帳戶（設定 → 個人）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    address: String,
    short: String,
    handle: Option<String>,
}

#[tauri::command]
pub async fn cafeca_account(state: State<'_, AppState>) -> CmdResult<Option<AccountView>> {
    with_node!(state, n => Ok(n.cafeca().map(|a| AccountView {
        address: a.address_hex(),
        short: a.short(),
        handle: n.org().members.get(&n.member_id()).and_then(|m| m.handle.clone()),
    })))
}

/// 待核准的加入與還原申請（管理者，ui-spec「設定」D41 補充）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequestView {
    device: String,
    kind: &'static str,
    member_id: String,
    name: String,
    device_name: String,
    handle: Option<String>,
    account: String,
    account_short: String,
    received_at: i64,
}

#[tauri::command]
pub async fn pending_joins(state: State<'_, AppState>) -> CmdResult<Vec<JoinRequestView>> {
    with_node!(state, n => Ok(n
        .pending_joins()
        .into_iter()
        .map(|j| JoinRequestView {
            device: j.device.to_string(),
            kind: j.kind,
            member_id: j.member.to_string(),
            name: j.name,
            device_name: j.device_name,
            handle: j.handle,
            account: j.account,
            account_short: j.account_short,
            received_at: j.received_at,
        })
        .collect()))
}

#[tauri::command]
pub async fn approve_join(
    state: State<'_, AppState>,
    device: String,
    admin: bool,
    teams: Vec<String>,
) -> CmdResult<()> {
    let device = parse_pub(&device)?;
    with_node!(state, n => n.approve_join(device, admin, teams).await.map_err(e))
}

#[tauri::command]
pub async fn reject_join(state: State<'_, AppState>, device: String) -> CmdResult<()> {
    let device = parse_pub(&device)?;
    with_node!(state, n => n.reject_join(device).await.map_err(e))
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

// ── 對話（technical-design §14）────────────────────────────

fn parse_member(s: &str) -> CmdResult<MemberId> {
    MemberId::parse(s).map_err(|_| "成員 ID 格式錯誤".to_string())
}

fn parse_members(v: &[String]) -> CmdResult<Vec<MemberId>> {
    v.iter().map(|s| parse_member(s)).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    id: String,
    conv: String,
    author: String,
    created_at: i64,
    kind: String,
    body: String,
    mentions: Vec<String>,
    attachments: serde_json::Value,
    task: Option<TaskRefView>,
}

/// 對話連結的任務（technical-design §14.2 v0.14）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRefView {
    team: String,
    id: String,
}

impl From<hills_node::conv::TaskRef> for TaskRefView {
    fn from(t: hills_node::conv::TaskRef) -> Self {
        Self {
            team: t.team,
            id: t.id,
        }
    }
}

impl From<Message> for MessageView {
    fn from(m: Message) -> Self {
        Self {
            id: m.id,
            conv: m.conv,
            author: m.author.to_string(),
            created_at: m.created_at,
            kind: m.kind,
            body: m.body,
            mentions: m.mentions.iter().map(|x| x.to_string()).collect(),
            attachments: m.attachments,
            task: m.task.map(Into::into),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvRow {
    id: String,
    kind: ConvKind,
    name: String,
    creator: String,
    created_at: i64,
    members: Vec<String>,
    last: Option<MessageView>,
    unread: u32,
    task: Option<TaskRefView>,
}

#[tauri::command]
pub async fn conversations(state: State<'_, AppState>) -> CmdResult<Vec<ConvRow>> {
    with_node!(state, n => Ok(n
        .conversations()
        .into_iter()
        .map(|v| ConvRow {
            id: v.info.id,
            kind: v.info.kind,
            name: v.info.name,
            creator: v.info.creator.to_string(),
            created_at: v.info.created_at,
            members: v.info.members.iter().map(|m| m.to_string()).collect(),
            last: v.last.map(Into::into),
            unread: v.unread,
            task: v.task.map(Into::into),
        })
        .collect()))
}

#[tauri::command]
pub async fn messages(
    state: State<'_, AppState>,
    conv: String,
    limit: Option<usize>,
) -> CmdResult<Vec<MessageView>> {
    let limit = limit.unwrap_or(500).min(5000);
    with_node!(state, n => Ok(n
        .messages(&conv, limit)
        .map_err(e)?
        .into_iter()
        .map(Into::into)
        .collect()))
}

/// 開啟與某位成員的私訊（沒有就建立）。
#[tauri::command]
pub async fn open_dm(state: State<'_, AppState>, member: String) -> CmdResult<String> {
    let peer = parse_member(&member)?;
    with_node!(state, n => {
        if let Some(id) = n.find_dm(&peer) {
            return Ok(id);
        }
        n.create_conv(ConvKind::Dm, "", &[peer]).await.map_err(e)
    })
}

#[tauri::command]
pub async fn create_group(
    state: State<'_, AppState>,
    name: String,
    members: Vec<String>,
) -> CmdResult<String> {
    let members = parse_members(&members)?;
    if name.trim().is_empty() {
        return Err("群組名稱不可空白".into());
    }
    with_node!(state, n => n.create_conv(ConvKind::Group, &name, &members).await.map_err(e))
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    conv: String,
    body: String,
    mentions: Vec<String>,
    attachments: Option<serde_json::Value>,
) -> CmdResult<MessageView> {
    let mentions = parse_members(&mentions)?;
    let attachments = attachments.unwrap_or(serde_json::Value::Null);
    with_node!(state, n => n
        .send_message(&conv, &body, &mentions, attachments)
        .await
        .map(Into::into)
        .map_err(e))
}

#[tauri::command]
pub async fn add_conv_members(
    state: State<'_, AppState>,
    conv: String,
    members: Vec<String>,
) -> CmdResult<()> {
    let members = parse_members(&members)?;
    with_node!(state, n => n.add_conv_members(&conv, &members).await.map_err(e))
}

#[tauri::command]
pub async fn remove_conv_member(
    state: State<'_, AppState>,
    conv: String,
    member: String,
) -> CmdResult<()> {
    let member = parse_member(&member)?;
    with_node!(state, n => n.remove_conv_member(&conv, member).await.map_err(e))
}

#[tauri::command]
pub async fn rename_conv(state: State<'_, AppState>, conv: String, name: String) -> CmdResult<()> {
    with_node!(state, n => n.rename_conv(&conv, &name).await.map_err(e))
}

/// 把對話連到任務；`team` / `task` 省略時取消連結（ui-spec「聊天」焦點營地）。
#[tauri::command]
pub async fn set_conv_task(
    state: State<'_, AppState>,
    conv: String,
    team: Option<String>,
    task: Option<String>,
) -> CmdResult<()> {
    let link = match (&team, &task) {
        (Some(team), Some(task)) => Some((team.as_str(), task.as_str())),
        (None, None) => None,
        _ => return Err("需同時指定小組與任務".into()),
    };
    with_node!(state, n => n.set_conv_task(&conv, link).await.map_err(e))
}

/// 前端開啟（或離開）某個對話：標記已讀並記錄，用於決定是否通知。
#[tauri::command]
pub async fn set_active_conv(
    state: State<'_, AppState>,
    conv: Option<String>,
    read_until: Option<i64>,
) -> CmdResult<()> {
    if let Ok(mut a) = state.active_conv.lock() {
        a.clone_from(&conv);
    }
    if let (Some(c), Some(t)) = (conv, read_until) {
        with_node!(state, n => n.mark_read(&c, t).map_err(e))?;
    }
    Ok(())
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
    fn location_roundtrip() {
        for s in ["hidden", "remote", "office:01ABC"] {
            assert_eq!(location_str(&parse_location(s).unwrap()), s);
        }
        assert!(parse_location("office:").is_err());
        assert!(parse_location("moon").is_err());
    }

    #[test]
    fn notification_deferral() {
        assert!(defers(PresenceState::Focus, None, 10));
        assert!(defers(PresenceState::Lunch, Some(11), 10));
        assert!(!defers(PresenceState::Meeting, Some(10), 10));
        assert!(!defers(PresenceState::Online, None, 10));
        assert!(!defers(PresenceState::Away, Some(99), 10));
    }

    #[test]
    fn qr_is_svg() {
        let c = Code::new("hills-org1-test".into()).unwrap();
        assert!(c.qr_svg.contains("<svg"));
    }
}
