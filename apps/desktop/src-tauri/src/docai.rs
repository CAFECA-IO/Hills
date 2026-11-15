//! 本機文件理解（D68，technical-design §16.20）：設定、元件下載、建立索引與搜尋。
//!
//! 內容只在這台電腦處理：前端把解密後的 PDF 交給 `docai_index_bytes`（不寫入磁碟），
//! 段落與向量用裝置金鑰加密存成本機檔（`Node::docai_*`）。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use hills_docai::models::{self, Component};
use hills_docai::{
    DocAiError, Embedder, FastEmbedder, FileState, FileStatus, Hit, Index, KB_NAMES, KbDoc,
    PdfWorker, Vault, kb_chunks, model_spec,
};
use hills_node::Node;
use hills_node::kb::KbSnapshot;
use serde::{Deserialize, Serialize};
use tauri::ipc::Request;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{AppState, CmdResult, e};
use crate::share::{header, percent_decode, raw_body};

pub const PROGRESS_EVENT: &str = "docai://progress";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Settings {
    pub(crate) enabled: bool,
    pub(crate) model: String,
    /// 問知識庫（D70，technical-design §16.21）
    #[serde(default)]
    pub(crate) ask: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            model: models::E5_SMALL.id.into(),
            ask: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: u64,
    total: u64,
    /// 失敗原因（下載失敗或驗證失敗）
    error: Option<String>,
    running: bool,
}

pub(crate) struct Engine {
    pdf: PdfWorker,
    pub(crate) embedder: Box<dyn Embedder>,
    /// PDF 段落
    pub(crate) index: Index,
    /// 知識條目段落（v0.40，D70）
    pub(crate) kb: Index,
}

pub struct DocAi {
    pub(crate) dir: PathBuf,
    pub(crate) settings: Mutex<Settings>,
    progress: Mutex<HashMap<&'static str, Progress>>,
    pub(crate) engine: Arc<Mutex<Option<Engine>>>,
}

pub(crate) struct NodeVault(pub(crate) Node);

impl Vault for NodeVault {
    fn read(&self, name: &str) -> hills_docai::Result<Option<Vec<u8>>> {
        self.0
            .docai_read(name)
            .map_err(|x| DocAiError::Store(x.to_string()))
    }
    fn write(&self, name: &str, data: &[u8]) -> hills_docai::Result<()> {
        self.0
            .docai_write(name, data)
            .map_err(|x| DocAiError::Store(x.to_string()))
    }
    fn remove(&self, name: &str) -> hills_docai::Result<()> {
        self.0
            .docai_remove(name)
            .map_err(|x| DocAiError::Store(x.to_string()))
    }
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl DocAi {
    pub fn new(dir: PathBuf) -> Self {
        let settings = std::fs::read(dir.join("settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            dir,
            settings: Mutex::new(settings),
            progress: Mutex::new(HashMap::new()),
            engine: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn save_settings(&self, s: &Settings) -> CmdResult<()> {
        std::fs::create_dir_all(&self.dir).map_err(e)?;
        std::fs::write(
            self.dir.join("settings.json"),
            serde_json::to_vec(s).map_err(e)?,
        )
        .map_err(e)
    }

    pub(crate) fn components(&self) -> Vec<Component> {
        let model = lock(&self.settings).model.clone();
        let mut out = Vec::new();
        if let Some(p) = models::pdfium_component() {
            out.push(p);
        }
        if let Some(m) = model_spec(&model) {
            out.push(m.component);
        }
        out
    }

    pub(crate) fn all_ready(&self) -> bool {
        models::pdfium_component().is_some()
            && self
                .components()
                .iter()
                .all(|c| models::is_ready(&self.dir, c))
    }
}

/// 啟用中且元件就緒時載入引擎（第一次呼叫較慢：載入模型、解密索引）。
pub(crate) fn ensure_engine(ai: &DocAi, node: &Node) -> CmdResult<()> {
    let mut g = lock(&ai.engine);
    let settings = lock(&ai.settings).clone();
    if !settings.enabled {
        *g = None;
        return Err("文件理解尚未開啟".into());
    }
    if g.as_ref()
        .is_some_and(|en| en.embedder.id() == settings.model)
    {
        return Ok(());
    }
    if !ai.all_ready() {
        return Err("元件尚未下載完成".into());
    }
    let spec = model_spec(&settings.model).ok_or("未知的模型")?;
    let pdf = PdfWorker::spawn(&ai.dir).map_err(e)?;
    let embedder = FastEmbedder::load(&ai.dir, spec).map_err(e)?;
    let vault = NodeVault(node.clone());
    let index = Index::open(&vault, spec.id, spec.dim).map_err(e)?;
    let kb = Index::open_named(&vault, KB_NAMES, spec.id, spec.dim).map_err(e)?;
    *g = Some(Engine {
        pdf,
        embedder: Box::new(embedder),
        index,
        kb,
    });
    Ok(())
}

pub(crate) async fn node_of(state: &State<'_, AppState>) -> CmdResult<Node> {
    state
        .node
        .lock()
        .await
        .clone()
        .ok_or_else(|| "尚未加入組織".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComponentStatus {
    id: &'static str,
    size: u64,
    /// missing | downloading | ready | failed
    state: &'static str,
    done: u64,
    total: u64,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocAiStatus {
    supported: bool,
    enabled: bool,
    model: String,
    ready: bool,
    components: Vec<ComponentStatus>,
    files: BTreeMap<String, FileState>,
    total_chunks: usize,
    /// 已建立索引的知識則數（v0.40，D70）
    kb_items: usize,
}

/// 一個元件的下載狀態。
pub(crate) fn component_status(ai: &DocAi, c: &Component) -> ComponentStatus {
    let progress = lock(&ai.progress);
    let p = progress.get(c.id);
    let state = if models::is_ready(&ai.dir, c) {
        "ready"
    } else if p.is_some_and(|p| p.running) {
        "downloading"
    } else if p.is_some_and(|p| p.error.is_some()) {
        "failed"
    } else {
        "missing"
    };
    ComponentStatus {
        id: c.id,
        size: c.size(),
        state,
        done: p.map_or(0, |p| p.done),
        total: p.map_or(c.size(), |p| p.total),
        error: p.and_then(|p| p.error.clone()),
    }
}

#[tauri::command]
pub async fn docai_status(
    state: State<'_, AppState>,
    ai: State<'_, DocAi>,
) -> CmdResult<DocAiStatus> {
    let settings = lock(&ai.settings).clone();
    let ready = settings.enabled && ai.all_ready();
    if ready && let Ok(node) = node_of(&state).await {
        let ai2 = ai.inner();
        // 載入索引才能回報各檔狀態；載入失敗時照常回報元件狀態
        let _ = tokio::task::block_in_place(|| ensure_engine(ai2, &node));
    }
    let components = ai
        .components()
        .iter()
        .map(|c| component_status(&ai, c))
        .collect();
    let (files, total_chunks, kb_items) = match lock(&ai.engine).as_ref() {
        Some(en) if ready => (
            en.index.files().clone(),
            en.index.total_chunks(),
            en.kb.files().len(),
        ),
        _ => (BTreeMap::new(), 0, 0),
    };
    Ok(DocAiStatus {
        supported: models::pdfium_component().is_some(),
        enabled: settings.enabled,
        model: settings.model,
        ready,
        components,
        files,
        total_chunks,
        kb_items,
    })
}

/// 開啟（或換模型），並在背景下載缺少的元件。
#[tauri::command]
pub async fn docai_enable(app: AppHandle, ai: State<'_, DocAi>, model: String) -> CmdResult<()> {
    if model_spec(&model).is_none() {
        return Err("未知的模型".into());
    }
    if models::pdfium_component().is_none() {
        return Err("這個平台不支援文件理解".into());
    }
    let s = Settings {
        enabled: true,
        model,
        ask: lock(&ai.settings).ask,
    };
    ai.save_settings(&s)?;
    *lock(&ai.settings) = s;
    // 換模型時下次載入會重建索引（Index::open 依模型清除）
    *lock(&ai.engine) = None;
    for c in ai.components() {
        let running = lock(&ai.progress).get(c.id).is_some_and(|p| p.running);
        if running || models::is_ready(&ai.dir, &c) {
            continue;
        }
        start_download(app.clone(), c);
    }
    Ok(())
}

pub(crate) fn start_download(app: AppHandle, c: Component) {
    tauri::async_runtime::spawn(async move {
        let ai = app.state::<DocAi>();
        let set = |p: Progress| {
            lock(&ai.progress).insert(c.id, p);
        };
        set(Progress {
            done: 0,
            total: c.size(),
            error: None,
            running: true,
        });
        let mut last = 0u64;
        let res = models::download(&ai.dir, &c, |done, total| {
            // 每 1% 回報一次
            if done.saturating_sub(last) * 100 >= total || done == total {
                last = done;
                lock(&ai.progress).insert(
                    c.id,
                    Progress {
                        done,
                        total,
                        error: None,
                        running: true,
                    },
                );
                let _ = app.emit(PROGRESS_EVENT, c.id);
            }
        })
        .await;
        set(Progress {
            done: if res.is_ok() { c.size() } else { last },
            total: c.size(),
            error: res.err().map(|x| x.to_string()),
            running: false,
        });
        let _ = app.emit(PROGRESS_EVENT, c.id);
    });
}

/// 關閉；`purge` 時刪除索引與下載的元件。
#[tauri::command]
pub async fn docai_disable(
    state: State<'_, AppState>,
    ai: State<'_, DocAi>,
    purge: bool,
) -> CmdResult<()> {
    let mut s = lock(&ai.settings).clone();
    s.enabled = false;
    // 問知識庫需要文件理解：一併關閉
    s.ask = false;
    ai.save_settings(&s)?;
    *lock(&ai.settings) = s.clone();
    let engine = lock(&ai.engine).take();
    if purge {
        if let Ok(node) = node_of(&state).await {
            let vault = NodeVault(node);
            match engine {
                Some(mut en) => {
                    en.index.clear(&vault).map_err(e)?;
                    en.kb.clear(&vault).map_err(e)?;
                }
                None => {
                    if let Some(spec) = model_spec(&s.model) {
                        Index::open(&vault, spec.id, spec.dim)
                            .and_then(|mut i| i.clear(&vault))
                            .map_err(e)?;
                        Index::open_named(&vault, KB_NAMES, spec.id, spec.dim)
                            .and_then(|mut i| i.clear(&vault))
                            .map_err(e)?;
                    }
                }
            }
        }
        for c in [models::E5_SMALL.component, models::BGE_M3.component]
            .into_iter()
            .chain(models::pdfium_component())
        {
            let d = models::component_dir(&ai.dir, &c);
            if d.exists() {
                std::fs::remove_dir_all(d).map_err(e)?;
            }
        }
        lock(&ai.progress).clear();
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Indexed {
    chunks: u32,
    status: FileStatus,
    reason: Option<String>,
}

/// 解析失敗的原因代碼（前端依代碼顯示文字）。
fn reason_of(err: &DocAiError) -> (FileStatus, &'static str) {
    match err {
        DocAiError::TooLarge => (FileStatus::Skipped, "tooLarge"),
        DocAiError::NoText => (FileStatus::Skipped, "noText"),
        DocAiError::BadPdf => (FileStatus::Failed, "unreadable"),
        _ => (FileStatus::Failed, "error"),
    }
}

/// `bytes` 為 `None` 表示檔案超過上限（不讀進記憶體）。
fn index_now(
    ai: &DocAi,
    node: &Node,
    key: &str,
    name: &str,
    bytes: Option<&[u8]>,
) -> CmdResult<Indexed> {
    if key.is_empty() || key.len() > 128 {
        return Err("檔案代碼不正確".into());
    }
    ensure_engine(ai, node)?;
    let mut g = lock(&ai.engine);
    let en = g.as_mut().ok_or("文件理解尚未就緒")?;
    let vault = NodeVault(node.clone());
    let at = u64::try_from(hills_node::now_ms()).unwrap_or(0);
    let started = std::time::Instant::now();
    let parsed = match bytes {
        Some(b) => en.pdf.parse(b.to_vec()),
        None => Err(DocAiError::TooLarge),
    };
    let result = parsed.and_then(|chunks| {
        let texts: Vec<String> = chunks.iter().map(|c| c.embed_text()).collect();
        let vecs = en.embedder.embed_passages(&texts)?;
        Ok((chunks, vecs))
    });
    match result {
        Ok((chunks, vecs)) => {
            let n = en
                .index
                .put(&vault, key, name, chunks, vecs, at)
                .map_err(e)?;
            tracing::info!(
                file = key,
                chunks = n,
                ms = started.elapsed().as_millis() as u64,
                "文件索引完成"
            );
            Ok(Indexed {
                chunks: n,
                status: FileStatus::Ready,
                reason: None,
            })
        }
        Err(err) => {
            let (status, reason) = reason_of(&err);
            tracing::info!(file = key, reason, "文件索引未完成");
            en.index
                .mark(&vault, key, name, status, reason, at)
                .map_err(e)?;
            Ok(Indexed {
                chunks: 0,
                status,
                reason: Some(reason.into()),
            })
        }
    }
}

/// 二進位內容 = 解密後的 PDF；標頭 `x-key`、`x-name`（encodeURIComponent）、`x-size`（原檔大小，超過上限時可不送內容）。
#[tauri::command]
pub async fn docai_index_bytes(
    state: State<'_, AppState>,
    ai: State<'_, DocAi>,
    request: Request<'_>,
) -> CmdResult<Indexed> {
    let key = header(&request, "x-key")?.to_owned();
    let name = percent_decode(header(&request, "x-name").unwrap_or(""))?;
    let bytes = raw_body(&request)?;
    let declared: usize = header(&request, "x-size")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(bytes.len());
    let too_large = declared.max(bytes.len()) > hills_docai::MAX_BYTES;
    let node = node_of(&state).await?;
    let ai = ai.inner();
    tokio::task::block_in_place(|| index_now(ai, &node, &key, &name, (!too_large).then_some(bytes)))
}

/// 已下載的檔案：從本機下載紀錄的路徑讀取（路徑不由前端指定）。
#[tauri::command]
pub async fn docai_index_downloaded(
    state: State<'_, AppState>,
    ai: State<'_, DocAi>,
    key: String,
    name: String,
) -> CmdResult<Indexed> {
    let node = node_of(&state).await?;
    let path = node
        .downloaded_path(&key)
        .map_err(e)?
        .ok_or("檔案已移動或刪除")?;
    let ai = ai.inner();
    tokio::task::block_in_place(|| {
        let bytes = read_limited(&path)?;
        index_now(ai, &node, &key, &name, bytes.as_deref())
    })
}

/// 超過上限時回傳 `None`，不讀進記憶體。
fn read_limited(p: &Path) -> CmdResult<Option<Vec<u8>>> {
    let len = std::fs::metadata(p).map_err(e)?.len();
    if len > hills_docai::MAX_BYTES as u64 {
        return Ok(None);
    }
    std::fs::read(p).map(Some).map_err(e)
}

#[tauri::command]
pub async fn docai_forget(
    state: State<'_, AppState>,
    ai: State<'_, DocAi>,
    key: String,
) -> CmdResult<()> {
    let node = node_of(&state).await?;
    let ai = ai.inner();
    tokio::task::block_in_place(|| {
        ensure_engine(ai, &node)?;
        let mut g = lock(&ai.engine);
        let en = g.as_mut().ok_or("文件理解尚未就緒")?;
        en.index.forget(&NodeVault(node), &key).map_err(e)
    })
}

#[tauri::command]
pub async fn docai_rebuild(state: State<'_, AppState>, ai: State<'_, DocAi>) -> CmdResult<()> {
    let node = node_of(&state).await?;
    let ai = ai.inner();
    tokio::task::block_in_place(|| {
        ensure_engine(ai, &node)?;
        let mut g = lock(&ai.engine);
        let en = g.as_mut().ok_or("文件理解尚未就緒")?;
        let vault = NodeVault(node);
        en.index.clear(&vault).map_err(e)?;
        en.kb.clear(&vault).map_err(e)
    })
}

/// 知識條目的標題路徑：分類 › 主題（依合併後的結果）。
pub(crate) fn kb_paths(snap: &KbSnapshot) -> HashMap<String, (String, Vec<String>)> {
    let cats: HashMap<&str, &hills_node::kb::KbCategory> =
        snap.categories.iter().map(|c| (c.id.as_str(), c)).collect();
    let topics: HashMap<&str, &hills_node::kb::KbTopic> =
        snap.topics.iter().map(|t| (t.id.as_str(), t)).collect();
    let resolve_topic = |id: &str| {
        topics
            .get(id)
            .and_then(|t| topics.get(t.resolved.as_str()).copied().or(Some(*t)))
    };
    snap.items
        .iter()
        .map(|it| {
            let mut path = Vec::new();
            let mut cat_id = String::new();
            if let Some(t) = resolve_topic(&it.topic_id) {
                let cat = cats
                    .get(t.category_id.as_str())
                    .and_then(|c| cats.get(c.resolved.as_str()).copied().or(Some(*c)));
                if let Some(c) = cat {
                    path.push(c.name.clone());
                    cat_id = c.id.clone();
                }
                path.push(t.name.clone());
            }
            (it.key.clone(), (cat_id, path))
        })
        .collect()
}

/// 依 `updatedAt` 比對，重建新增或修改的知識、移除已刪除的（technical-design §16.20「知識條目」）。
pub(crate) fn sync_kb(ai: &DocAi, node: &Node, snap: &KbSnapshot) -> CmdResult<usize> {
    ensure_engine(ai, node)?;
    let paths = kb_paths(snap);
    let mut g = lock(&ai.engine);
    let en = g.as_mut().ok_or("文件理解尚未就緒")?;
    let vault = NodeVault(node.clone());
    let live: std::collections::HashSet<&str> = snap.items.iter().map(|i| i.key.as_str()).collect();
    let gone: Vec<String> = en
        .kb
        .files()
        .keys()
        .filter(|k| !live.contains(k.as_str()))
        .cloned()
        .collect();
    for k in gone {
        en.kb.forget(&vault, &k).map_err(e)?;
    }
    let mut changed = 0;
    for it in &snap.items {
        let at = u64::try_from(it.updated_at).unwrap_or(0);
        if en.kb.files().get(&it.key).is_some_and(|f| f.at == at) {
            continue;
        }
        let doc = KbDoc {
            title: it.title.clone(),
            path: paths.get(&it.key).map(|p| p.1.clone()).unwrap_or_default(),
            body: it.body.clone(),
            html: it.format == hills_node::doc_spec::DocFormat::Html,
        };
        let chunks = kb_chunks(&doc);
        let texts: Vec<String> = chunks.iter().map(|c| c.embed_text()).collect();
        let vecs = en.embedder.embed_passages(&texts).map_err(e)?;
        en.kb
            .put(&vault, &it.key, &it.title, chunks, vecs, at)
            .map_err(e)?;
        changed += 1;
    }
    if changed > 0 {
        tracing::info!(items = changed, "知識索引更新");
    }
    Ok(changed)
}

/// 前端在知識列表變動時呼叫（文件理解未開啟時不做事）。
#[tauri::command]
pub async fn docai_index_kb(state: State<'_, AppState>, ai: State<'_, DocAi>) -> CmdResult<usize> {
    if !lock(&ai.settings).enabled || !ai.all_ready() {
        return Ok(0);
    }
    let node = node_of(&state).await?;
    let ai = ai.inner();
    tokio::task::block_in_place(|| {
        let snap = node.kb().map_err(e)?;
        sync_kb(ai, &node, &snap)
    })
}

pub fn search_now(ai: &DocAi, node: &Node, query: &str, limit: usize) -> CmdResult<Vec<Hit>> {
    let q = query.trim();
    if q.chars().count() < 2 {
        return Ok(Vec::new());
    }
    ensure_engine(ai, node)?;
    let mut g = lock(&ai.engine);
    let en = g.as_mut().ok_or("文件理解尚未就緒")?;
    let qv = en.embedder.embed_query(q).map_err(e)?;
    Ok(en.index.search(&qv, limit.clamp(1, 20)))
}

/// 內容搜尋：只回傳本人目前看得到的檔案（以 `list_files` 過濾）。
#[tauri::command]
pub async fn docai_search(
    state: State<'_, AppState>,
    ai: State<'_, DocAi>,
    query: String,
    limit: Option<usize>,
) -> CmdResult<Vec<Hit>> {
    let node = node_of(&state).await?;
    if !lock(&ai.settings).enabled {
        return Ok(Vec::new());
    }
    let ai = ai.inner();
    let hits = tokio::task::block_in_place(|| search_now(ai, &node, &query, limit.unwrap_or(10)))?;
    let visible: std::collections::HashSet<String> = node
        .list_files()
        .map_err(e)?
        .into_iter()
        .map(|f| f.key)
        .collect();
    Ok(hits
        .into_iter()
        .filter(|h| visible.contains(&h.file_key))
        .collect())
}

/// MCP `search_knowledge` 的 PDF 內容命中（technical-design §18.3 v0.37）：未開啟或未就緒時回傳空陣列。
pub async fn content_hits(app: &AppHandle, query: &str, limit: usize) -> Vec<serde_json::Value> {
    let ai = app.state::<DocAi>();
    if !lock(&ai.settings).enabled || !ai.all_ready() {
        return Vec::new();
    }
    let state = app.state::<AppState>();
    let Ok(node) = node_of(&state).await else {
        return Vec::new();
    };
    let ai = ai.inner();
    let Ok(hits) = tokio::task::block_in_place(|| search_now(ai, &node, query, limit)) else {
        return Vec::new();
    };
    let files: HashMap<String, hills_node::files::FileEntry> = node
        .list_files()
        .unwrap_or_default()
        .into_iter()
        .map(|f| (f.key.clone(), f))
        .collect();
    hits.into_iter()
        .filter_map(|h| {
            let f = files.get(&h.file_key)?;
            Some(serde_json::json!({
                "fileKey": h.file_key,
                "name": f.name,
                "pageFrom": h.page_from,
                "pageTo": h.page_to,
                "heading": h.heading,
                "snippet": h.snippet,
                "score": h.score,
                "sources": f.sources,
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_map_to_codes() {
        assert_eq!(reason_of(&DocAiError::TooLarge).1, "tooLarge");
        assert_eq!(reason_of(&DocAiError::NoText).0, FileStatus::Skipped);
        assert_eq!(reason_of(&DocAiError::BadPdf).0, FileStatus::Failed);
    }

    #[test]
    fn settings_default_to_off_with_small_model() {
        let dir = tempfile::tempdir().unwrap();
        let ai = DocAi::new(dir.path().join("docai"));
        let s = lock(&ai.settings).clone();
        assert!(!s.enabled);
        assert_eq!(s.model, "e5-small");
        ai.save_settings(&Settings {
            enabled: true,
            model: "bge-m3".into(),
            ask: false,
        })
        .unwrap();
        let again = DocAi::new(dir.path().join("docai"));
        assert_eq!(lock(&again.settings).model, "bge-m3");
    }
}
