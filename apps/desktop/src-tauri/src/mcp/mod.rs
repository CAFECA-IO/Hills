//! 本機 MCP 介面（feature-plan D48，technical-design §18）：讓使用者自己的 AI Agent 協助操作 Hills。
//! 讀取直接回傳；寫入只建立待確認變更，使用者在 Hills 核准後才執行（D17）。

mod backend;
mod http;
pub mod pending;
pub mod protocol;
mod tools;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{AppState, CmdResult};
use backend::RealBackend;
use pending::{AuditEntry, Change};
use protocol::Server;

/// 前端事件：有新的待確認變更或狀態改變
pub const EVENT: &str = "hills://mcp";
pub const DEFAULT_PORT: u16 = 47321;
const TOKEN_KEY: &str = "hills.mcp.token";
const CONFIG_FILE: &str = "mcp.json";

/// 本機設定（不同步，technical-design §18.2）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalConfig {
    enabled: bool,
    port: u16,
}

impl Default for LocalConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
        }
    }
}

struct Running {
    port: u16,
    stop: tokio::sync::oneshot::Sender<()>,
}

pub struct McpRuntime {
    dir: PathBuf,
    server: Arc<Server<RealBackend>>,
    token: Arc<Mutex<String>>,
    running: tokio::sync::Mutex<Option<Running>>,
    /// 最近一次啟動失敗的原因（例如埠被占用）
    error: Mutex<Option<String>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn new_token() -> String {
    let mut b = [0u8; 32];
    let _ = getrandom::fill(&mut b);
    data_encoding::BASE32_NOPAD.encode(&b)
}

impl McpRuntime {
    pub fn new(app: AppHandle, dir: PathBuf) -> Self {
        Self {
            dir,
            server: Arc::new(Server::new(RealBackend { app })),
            token: Arc::new(Mutex::new(String::new())),
            running: tokio::sync::Mutex::new(None),
            error: Mutex::new(None),
        }
    }

    fn config(&self) -> LocalConfig {
        std::fs::read(self.dir.join(CONFIG_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save_config(&self, c: &LocalConfig) -> CmdResult<()> {
        let b = serde_json::to_vec_pretty(c).map_err(crate::commands::e)?;
        std::fs::write(self.dir.join(CONFIG_FILE), b).map_err(crate::commands::e)
    }

    /// 從鑰匙圈載入 token；沒有就產生一個。
    fn ensure_token(&self, app: &AppHandle) -> CmdResult<String> {
        let current = lock(&self.token).clone();
        if !current.is_empty() {
            return Ok(current);
        }
        let secrets = app.state::<AppState>().secrets.clone();
        let stored = secrets
            .get(TOKEN_KEY)
            .map_err(crate::commands::e)?
            .and_then(|v| String::from_utf8(v.to_vec()).ok())
            .filter(|s| !s.is_empty());
        let t = match stored {
            Some(t) => t,
            None => {
                let t = new_token();
                secrets
                    .set(TOKEN_KEY, t.as_bytes())
                    .map_err(crate::commands::e)?;
                t
            }
        };
        *lock(&self.token) = t.clone();
        Ok(t)
    }

    async fn org_allowed(app: &AppHandle) -> bool {
        let state = app.state::<AppState>();
        let guard = state.node.lock().await;
        guard
            .as_ref()
            .is_some_and(|n| n.mcp_allowed().unwrap_or(false))
    }

    /// 依「組織允許 且 本機開啟 且 已加入組織」啟動或停止伺服器（§18.2）。
    pub async fn refresh(&self, app: &AppHandle) {
        let cfg = self.config();
        let want = cfg.enabled && Self::org_allowed(app).await;
        let mut running = self.running.lock().await;
        let up = running.as_ref().map(|r| r.port);
        if want && up == Some(cfg.port) {
            return;
        }
        if let Some(r) = running.take() {
            let _ = r.stop.send(());
            tracing::info!("MCP 伺服器已停止");
        }
        if !want {
            return;
        }
        if let Err(e) = self.ensure_token(app) {
            *lock(&self.error) = Some(e);
            return;
        }
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", cfg.port)).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!("MCP 伺服器無法監聽 127.0.0.1:{}：{e}", cfg.port);
                *lock(&self.error) = Some(e.to_string());
                return;
            }
        };
        *lock(&self.error) = None;
        let router = http::router(http::Http {
            server: self.server.clone(),
            port: cfg.port,
            token: self.token.clone(),
        });
        let (stop, rx) = tokio::sync::oneshot::channel::<()>();
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await;
        });
        tracing::info!("MCP 伺服器在 127.0.0.1:{} 監聽", cfg.port);
        *running = Some(Running {
            port: cfg.port,
            stop,
        });
    }
}

/// 背景呼叫 refresh（組織設定同步、加入組織後）。
pub fn refresh_later(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let rt = app.state::<McpRuntime>();
        rt.refresh(&app).await;
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    /// 組織是否允許
    allowed: bool,
    is_admin: bool,
    enabled: bool,
    running: bool,
    port: u16,
    endpoint: String,
    /// 開啟後才回傳
    token: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn mcp_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    rt: State<'_, McpRuntime>,
) -> CmdResult<McpSettings> {
    let (allowed, is_admin) = {
        let guard = state.node.lock().await;
        match guard.as_ref() {
            Some(n) => (n.mcp_allowed().unwrap_or(false), n.is_admin()),
            None => (false, false),
        }
    };
    let cfg = rt.config();
    let token = if cfg.enabled && allowed {
        Some(rt.ensure_token(&app)?)
    } else {
        None
    };
    let running = rt.running.lock().await.is_some();
    Ok(McpSettings {
        allowed,
        is_admin,
        enabled: cfg.enabled,
        running,
        port: cfg.port,
        endpoint: format!("http://127.0.0.1:{}/mcp", cfg.port),
        token,
        error: lock(&rt.error).clone(),
    })
}

#[tauri::command]
pub async fn set_mcp_enabled(
    app: AppHandle,
    rt: State<'_, McpRuntime>,
    enabled: bool,
) -> CmdResult<()> {
    let mut cfg = rt.config();
    cfg.enabled = enabled;
    rt.save_config(&cfg)?;
    rt.refresh(&app).await;
    let _ = app.emit(EVENT, "settings");
    Ok(())
}

#[tauri::command]
pub async fn regenerate_mcp_token(
    app: AppHandle,
    state: State<'_, AppState>,
    rt: State<'_, McpRuntime>,
) -> CmdResult<String> {
    let t = new_token();
    state
        .secrets
        .set(TOKEN_KEY, t.as_bytes())
        .map_err(crate::commands::e)?;
    *lock(&rt.token) = t.clone();
    let _ = app.emit(EVENT, "settings");
    Ok(t)
}

#[tauri::command]
pub async fn set_mcp_allowed(
    app: AppHandle,
    state: State<'_, AppState>,
    rt: State<'_, McpRuntime>,
    allowed: bool,
) -> CmdResult<()> {
    {
        let guard = state.node.lock().await;
        let n = guard.as_ref().ok_or_else(|| "尚未加入組織".to_string())?;
        n.set_mcp_allowed(allowed)
            .await
            .map_err(crate::commands::e)?;
    }
    rt.refresh(&app).await;
    let _ = app.emit(EVENT, "settings");
    Ok(())
}

#[tauri::command]
pub fn mcp_pending(rt: State<'_, McpRuntime>) -> Vec<Change> {
    rt.server.pending()
}

#[tauri::command]
pub async fn mcp_approve(
    app: AppHandle,
    rt: State<'_, McpRuntime>,
    id: String,
) -> CmdResult<Value> {
    let r = rt.server.approve(&id).await;
    let _ = app.emit(EVENT, "resolved");
    r
}

#[tauri::command]
pub fn mcp_reject(app: AppHandle, rt: State<'_, McpRuntime>, id: String) -> CmdResult<()> {
    rt.server.reject(&id)?;
    let _ = app.emit(EVENT, "resolved");
    Ok(())
}

#[tauri::command]
pub fn mcp_audit(rt: State<'_, McpRuntime>) -> Vec<AuditEntry> {
    rt.server
        .queue
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .audit(20)
}
