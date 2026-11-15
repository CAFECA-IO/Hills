//! 問知識庫（D70，technical-design §16.21）：在這台電腦上理解問題、檢索知識與 PDF、以本機語言模型作答。
//!
//! 問題、片段與回答只在記憶體；結果以事件逐步送到前端，MCP `ask_knowledge` 走同一個流程。

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use hills_docai::hybrid::Retrieved;
use hills_docai::kbask::{self, Answer, AskInput, Hooks, Step, Turn};
use hills_docai::llm::LlamaLlm;
use hills_docai::models::{self, GEMMA_4_E4B};
use hills_docai::{Candidate, SourceKind};
use hills_node::Node;
use hills_node::kb::{KbSnapshot, KbSource};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{AppState, CmdResult, e};
use crate::docai::{
    ComponentStatus, DocAi, component_status, ensure_engine, kb_paths, lock, node_of,
    start_download, sync_kb,
};

pub const STEP_EVENT: &str = "kbask://step";
pub const TOKEN_EVENT: &str = "kbask://token";
pub const DONE_EVENT: &str = "kbask://done";
pub const ERROR_EVENT: &str = "kbask://error";

/// 記憶體低於這個值時提示可能很慢（technical-design §16.21「硬體」）。
const LOW_MEMORY: u64 = 12 * 1024 * 1024 * 1024;

/// 知識的指紋（則數, 最新更新時間）與它對應的建議問題。
type Suggestions = Option<((usize, i64), Vec<String>)>;

#[derive(Default)]
pub struct KbAsk {
    llm: Mutex<Option<Arc<LlamaLlm>>>,
    current: Mutex<Option<(u64, Arc<AtomicBool>)>>,
    seq: AtomicU64,
    /// （知識數, 最新更新時間）→ 建議問題
    suggestions: Mutex<Suggestions>,
}

/// 這台電腦的實體記憶體（位元組）；取不到時回傳 `None`。
fn total_memory() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }
    #[cfg(target_os = "linux")]
    {
        let s = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kb: u64 = s
            .lines()
            .find(|l| l.starts_with("MemTotal:"))?
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()?;
        Some(kb * 1024)
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbAskStatus {
    enabled: bool,
    ready: bool,
    /// 語言模型 + 尚未就緒的文件理解元件
    components: Vec<ComponentStatus>,
    memory_low: bool,
}

fn ready(ai: &DocAi) -> bool {
    ai.all_ready() && models::is_ready(&ai.dir, &GEMMA_4_E4B)
}

#[tauri::command]
pub async fn kbask_status(ai: State<'_, DocAi>) -> CmdResult<KbAskStatus> {
    let s = lock(&ai.settings).clone();
    let mut components = vec![component_status(&ai, &GEMMA_4_E4B)];
    for c in ai.components() {
        if !models::is_ready(&ai.dir, &c) {
            components.push(component_status(&ai, &c));
        }
    }
    let memory_low = tokio::task::spawn_blocking(total_memory)
        .await
        .ok()
        .flatten()
        .is_some_and(|m| m < LOW_MEMORY);
    Ok(KbAskStatus {
        enabled: s.ask,
        ready: s.ask && s.enabled && ready(&ai),
        components,
        memory_low,
    })
}

/// 開啟問知識庫（文件理解一併開啟），在背景下載缺少的元件。
#[tauri::command]
pub async fn kbask_enable(app: AppHandle, ai: State<'_, DocAi>) -> CmdResult<()> {
    if models::pdfium_component().is_none() {
        return Err("這個平台不支援文件理解".into());
    }
    let mut s = lock(&ai.settings).clone();
    s.enabled = true;
    s.ask = true;
    ai.save_settings(&s)?;
    *lock(&ai.settings) = s;
    for c in ai.components().into_iter().chain([GEMMA_4_E4B]) {
        if !models::is_ready(&ai.dir, &c) {
            start_download(app.clone(), c);
        }
    }
    Ok(())
}

/// 關閉；`purge` 時刪除語言模型（文件理解不受影響）。
#[tauri::command]
pub async fn kbask_disable(
    ai: State<'_, DocAi>,
    ask: State<'_, KbAsk>,
    purge: bool,
) -> CmdResult<()> {
    let mut s = lock(&ai.settings).clone();
    s.ask = false;
    ai.save_settings(&s)?;
    *lock(&ai.settings) = s;
    if let Some((_, c)) = lock(&ask.current).take() {
        c.store(true, Ordering::Relaxed);
    }
    lock(&ask.llm).take();
    if purge {
        let d = models::component_dir(&ai.dir, &GEMMA_4_E4B);
        if d.exists() {
            std::fs::remove_dir_all(d).map_err(e)?;
        }
    }
    Ok(())
}

fn llm_of(ai: &DocAi, ask: &KbAsk) -> CmdResult<Arc<LlamaLlm>> {
    let mut g = lock(&ask.llm);
    if let Some(l) = g.as_ref() {
        return Ok(l.clone());
    }
    let l = Arc::new(LlamaLlm::spawn(models::llm_path(&ai.dir)).map_err(e)?);
    *g = Some(l.clone());
    Ok(l)
}

/// 範圍：分類 id，或知識 key（「問這則知識」：這則與它引用的知識，以及它們附的檔案）。
struct Scope {
    items: Option<HashSet<String>>,
    files: Option<HashSet<String>>,
}

fn scope_of(snap: &KbSnapshot, scope: Option<&str>) -> Scope {
    let Some(sc) = scope.filter(|s| !s.is_empty()) else {
        return Scope {
            items: None,
            files: None,
        };
    };
    let items: HashSet<String> = if snap.items.iter().any(|i| i.key == sc) {
        let mut set = HashSet::from([sc.to_owned()]);
        if let Some(it) = snap.items.iter().find(|i| i.key == sc) {
            set.extend(it.refs.iter().cloned());
        }
        set
    } else {
        kb_paths(snap)
            .into_iter()
            .filter(|(_, (cat, _))| cat == sc)
            .map(|(k, _)| k)
            .collect()
    };
    let files = snap
        .items
        .iter()
        .filter(|i| items.contains(&i.key))
        .filter_map(|i| match &i.source {
            KbSource::File { attachment, .. } => attachment
                .get("fileKey")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            _ => None,
        })
        .collect();
    Scope {
        items: Some(items),
        files: Some(files),
    }
}

/// 整個流程（前端與 MCP 共用）。在阻塞執行緒呼叫。
fn ask_now(
    app: &AppHandle,
    node: &Node,
    input: &AskInput,
    scope: Option<&str>,
    cancel: &AtomicBool,
    hooks: Hooks<'_>,
) -> CmdResult<Answer> {
    let ai = app.state::<DocAi>();
    let ask = app.state::<KbAsk>();
    {
        let s = lock(&ai.settings);
        if !(s.ask && s.enabled) {
            return Err("問知識庫尚未在這台電腦開啟".into());
        }
    }
    if !ready(&ai) {
        return Err("元件尚未下載完成".into());
    }
    let snap = node.kb().map_err(e)?;
    sync_kb(&ai, node, &snap)?;
    ensure_engine(&ai, node)?;
    let llm = llm_of(&ai, &ask)?;
    let visible: HashSet<String> = node
        .list_files()
        .map_err(e)?
        .into_iter()
        .map(|f| f.key)
        .collect();
    let scope = scope_of(&snap, scope);
    let engine = ai.engine.clone();
    let mut search = |intent: &kbask::Intent| -> hills_docai::Result<Retrieved> {
        let mut g = lock(&engine);
        let Some(en) = g.as_mut() else {
            return Err(hills_docai::DocAiError::Store("文件理解尚未就緒".into()));
        };
        let mut cands: Vec<Candidate<'_>> = Vec::new();
        for p in en.kb.passages() {
            if scope.items.as_ref().is_none_or(|s| s.contains(p.key)) {
                cands.push(Candidate {
                    kind: SourceKind::Item,
                    passage: p,
                });
            }
        }
        for p in en.index.passages() {
            if visible.contains(p.key) && scope.files.as_ref().is_none_or(|s| s.contains(p.key)) {
                cands.push(Candidate {
                    kind: SourceKind::Pdf,
                    passage: p,
                });
            }
        }
        kbask::search_with(&mut *en.embedder, &cands, intent)
    };
    let started = std::time::Instant::now();
    let answer = kbask::ask(&*llm, &mut search, input, hooks, cancel).map_err(e)?;
    tracing::info!(
        ms = started.elapsed().as_millis() as u64,
        cited = answer.citations.len(),
        not_found = answer.not_found,
        "問知識庫完成"
    );
    Ok(answer)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepPayload<'a> {
    ask_id: u64,
    #[serde(flatten)]
    step: &'a Step,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenPayload<'a> {
    ask_id: u64,
    text: &'a str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload<'a> {
    ask_id: u64,
    answer: &'a Answer,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload {
    ask_id: u64,
    message: String,
    cancelled: bool,
}

/// 取消進行中的問題並登記新的。
fn begin(ask: &KbAsk) -> (u64, Arc<AtomicBool>) {
    let id = ask.seq.fetch_add(1, Ordering::Relaxed) + 1;
    let flag = Arc::new(AtomicBool::new(false));
    if let Some((_, old)) = lock(&ask.current).replace((id, flag.clone())) {
        old.store(true, Ordering::Relaxed);
    }
    (id, flag)
}

fn finish(ask: &KbAsk, id: u64) {
    let mut g = lock(&ask.current);
    if g.as_ref().is_some_and(|(cur, _)| *cur == id) {
        *g = None;
    }
}

/// 提問；結果透過 `kbask://step|token|done|error` 事件送出，回傳 `askId`。
#[tauri::command]
pub async fn kbask_ask(
    app: AppHandle,
    state: State<'_, AppState>,
    ask: State<'_, KbAsk>,
    question: String,
    history: Vec<Turn>,
    scope: Option<String>,
) -> CmdResult<u64> {
    let q = question.trim().to_owned();
    if q.is_empty() || q.chars().count() > 2000 {
        return Err("問題不能是空的，也不能超過 2000 字".into());
    }
    let node = node_of(&state).await?;
    let (id, cancel) = begin(&ask);
    std::thread::Builder::new()
        .name("hills-kbask".into())
        .spawn(move || {
            let input = AskInput {
                question: q,
                history,
            };
            let res = ask_now(
                &app,
                &node,
                &input,
                scope.as_deref(),
                &cancel,
                Hooks {
                    on_step: &mut |s| {
                        let _ = app.emit(
                            STEP_EVENT,
                            StepPayload {
                                ask_id: id,
                                step: s,
                            },
                        );
                    },
                    on_token: &mut |t| {
                        let _ = app.emit(
                            TOKEN_EVENT,
                            TokenPayload {
                                ask_id: id,
                                text: t,
                            },
                        );
                    },
                },
            );
            match res {
                Ok(a) => {
                    let _ = app.emit(
                        DONE_EVENT,
                        DonePayload {
                            ask_id: id,
                            answer: &a,
                        },
                    );
                }
                Err(message) => {
                    let _ = app.emit(
                        ERROR_EVENT,
                        ErrorPayload {
                            ask_id: id,
                            cancelled: cancel.load(Ordering::Relaxed),
                            message,
                        },
                    );
                }
            }
            finish(&app.state::<KbAsk>(), id);
        })
        .map_err(e)?;
    Ok(id)
}

#[tauri::command]
pub async fn kbask_cancel(ask: State<'_, KbAsk>, ask_id: u64) -> CmdResult<()> {
    if let Some((id, flag)) = lock(&ask.current).as_ref()
        && *id == ask_id
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// 依最近 30 天新增的知識產生 3 個建議問題；知識沒有變動時沿用上次的結果。
#[tauri::command]
pub async fn kbask_suggest(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let node = node_of(&state).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let ai = app.state::<DocAi>();
        let ask = app.state::<KbAsk>();
        {
            let s = lock(&ai.settings);
            if !(s.ask && s.enabled) || !ready(&ai) {
                return Ok(Vec::new());
            }
        }
        let snap = node.kb().map_err(e)?;
        let fp = (
            snap.items.len(),
            snap.items.iter().map(|i| i.updated_at).max().unwrap_or(0),
        );
        if let Some((k, q)) = lock(&ask.suggestions).as_ref()
            && *k == fp
        {
            return Ok(q.clone());
        }
        let since = hills_node::now_ms() - 30 * 86_400_000;
        let mut recent: Vec<_> = snap
            .items
            .iter()
            .filter(|i| i.created_at >= since)
            .collect();
        if recent.is_empty() {
            recent = snap.items.iter().collect();
        }
        recent.sort_by_key(|i| std::cmp::Reverse(i.created_at));
        let titles: Vec<String> = recent.iter().take(20).map(|i| i.title.clone()).collect();
        let llm = llm_of(&ai, &ask)?;
        let q = kbask::suggest(&*llm, &titles, &AtomicBool::new(false)).map_err(e)?;
        *lock(&ask.suggestions) = Some((fp, q.clone()));
        Ok(q)
    })
    .await
    .map_err(e)?
}

/// MCP `ask_knowledge`（technical-design §18.3 v0.41）：不串流，最多等 120 秒。
pub async fn ask_for_mcp(
    app: &AppHandle,
    question: String,
    history: Vec<Turn>,
    scope: Option<String>,
) -> Result<serde_json::Value, String> {
    let q = question.trim().to_owned();
    if q.is_empty() {
        return Err("question is empty".into());
    }
    let node = {
        let state = app.state::<AppState>();
        node_of(&state).await?
    };
    let (id, cancel) = begin(&app.state::<KbAsk>());
    let app2 = app.clone();
    let cancel2 = cancel.clone();
    let job = tauri::async_runtime::spawn_blocking(move || {
        let input = AskInput {
            question: q,
            history: history.into_iter().rev().take(3).rev().collect(),
        };
        let r = ask_now(
            &app2,
            &node,
            &input,
            scope.as_deref(),
            &cancel2,
            Hooks {
                on_step: &mut |_| {},
                on_token: &mut |_| {},
            },
        );
        finish(&app2.state::<KbAsk>(), id);
        r
    });
    match tokio::time::timeout(std::time::Duration::from_secs(120), job).await {
        Ok(Ok(Ok(a))) => serde_json::to_value(&a).map_err(|x| x.to_string()),
        Ok(Ok(Err(m))) => Err(m),
        Ok(Err(x)) => Err(x.to_string()),
        Err(_) => {
            cancel.store(true, Ordering::Relaxed);
            Err("timed out after 120 seconds".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_cancels_previous() {
        let ask = KbAsk::default();
        let (a, fa) = begin(&ask);
        let (b, fb) = begin(&ask);
        assert!(b > a);
        assert!(fa.load(Ordering::Relaxed));
        assert!(!fb.load(Ordering::Relaxed));
        finish(&ask, a);
        assert!(lock(&ask.current).is_some());
        finish(&ask, b);
        assert!(lock(&ask.current).is_none());
    }

    #[test]
    fn empty_scope_is_unrestricted() {
        let s = scope_of(&KbSnapshot::default(), None);
        assert!(s.items.is_none() && s.files.is_none());
        let s = scope_of(&KbSnapshot::default(), Some("cat-x"));
        assert!(s.items.is_some_and(|i| i.is_empty()));
    }
}
