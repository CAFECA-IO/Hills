//! Tauri commands：包裝 hills-node，前端只透過這裡讀取投影、送出意圖（development-guidelines §4.2）。
//!
//! 錯誤以字串回傳給前端顯示；不得包含金鑰、復原詞或業務資料內容。

use std::path::PathBuf;
use std::sync::Arc;

use hills_node::{
    ConvKind, CreateOrg, Event, LinkListener, LinkSession, Location, Look, MemberId, MemberStatus,
    Message, Node, NodeOptions, PhraseLanguage, PresenceState, Pub32, Role, SecretStore, StepInput,
    SyncStatus, Task, TaskInput, TaskStatus,
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
            link_cancel: Mutex::new(None),
            link_session: Mutex::new(None),
            active_conv: std::sync::Mutex::new(None),
            deferred: std::sync::Mutex::new(0),
        }
    }
}

fn opts() -> NodeOptions {
    NodeOptions::default()
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
                    };
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    org_name: String,
    members: Vec<MemberView>,
    teams: Vec<TeamView>,
    offices: Vec<OfficeView>,
    lunch_break: Option<LunchView>,
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
        Ok(Overview { org_name: org.name, members, teams, offices, lunch_break })
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
        let c = Code::new("hills1-test".into()).unwrap();
        assert!(c.qr_svg.contains("<svg"));
    }

    #[test]
    fn phrase_language_follows_locale() {
        assert_eq!(lang("en"), PhraseLanguage::English);
        assert_eq!(lang("zh-TW"), PhraseLanguage::TraditionalChinese);
    }
}
