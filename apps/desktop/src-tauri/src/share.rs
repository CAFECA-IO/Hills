//! 檔案分享的 Tauri commands（technical-design §15.2–15.6、D39）。
//!
//! - 讀檔：只接受以系統對話框選擇的檔案（token），以二進位回傳條帶明文給前端加密。
//! - 分片：前端加密、RS 編碼後的密文分片以二進位交給 Rust，轉送到儲存節點；Rust 不解密。
//! - 下載：前端解密後的明文寫入使用者所選位置的 `.partial`，完成才改名。

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::{AppState, CmdResult, e};
use crate::files::{FolderPick, PickedFile};
use crate::with_node;

fn registry(state: &AppState) -> CmdResult<std::sync::MutexGuard<'_, crate::files::Registry>> {
    state.files.lock().map_err(|_| "內部錯誤".to_string())
}

fn parse_id(hex: &str) -> CmdResult<[u8; 32]> {
    data_encoding::HEXLOWER_PERMISSIVE
        .decode(hex.as_bytes())
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or_else(|| "分片 ID 格式錯誤".to_string())
}

fn header<'a>(req: &'a Request<'_>, name: &str) -> CmdResult<&'a str> {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("缺少 {name}"))
}

fn raw_body<'a>(req: &'a Request<'_>) -> CmdResult<&'a [u8]> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b),
        InvokeBody::Json(_) => Err("需要二進位內容".into()),
    }
}

/// `encodeURIComponent` 的反向（標頭只能放 ASCII）。
fn percent_decode(s: &str) -> CmdResult<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let h = std::str::from_utf8(&b[i + 1..i + 3]).map_err(e)?;
            out.push(u8::from_str_radix(h, 16).map_err(|_| "路徑編碼錯誤".to_string())?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "路徑編碼錯誤".to_string())
}

#[tauri::command]
pub async fn pick_files(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Vec<PickedFile>> {
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_files())
        .await
        .map_err(e)?;
    let mut reg = registry(&state)?;
    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .filter_map(|p| reg.add_file(p))
        .collect())
}

#[tauri::command]
pub async fn pick_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<FolderPick>> {
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(e)?;
    let Some(dir) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    // 大資料夾的列舉不阻塞 async runtime
    let listing = {
        let mut reg = crate::files::Registry::default();
        let dir2 = dir.clone();
        let (pick, reg) = tokio::task::spawn_blocking(move || {
            let r = reg.add_folder(&dir2);
            (r, reg)
        })
        .await
        .map_err(e)?;
        let pick = pick.map_err(|_| "無法讀取資料夾".to_string())?;
        registry(&state)?.merge(reg);
        pick
    };
    Ok(Some(listing))
}

#[tauri::command]
pub async fn read_stripe(
    state: State<'_, AppState>,
    token: String,
    offset: u64,
    len: u64,
) -> CmdResult<Response> {
    let path = registry(&state)?.path_of(&token).ok_or("檔案未經選擇")?;
    let bytes = tokio::task::spawn_blocking(move || crate::files::read_range(&path, offset, len))
        .await
        .map_err(e)??;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn storage_nodes(state: State<'_, AppState>) -> CmdResult<Vec<u8>> {
    with_node!(state, n => Ok(n.storage_nodes()))
}

/// 二進位內容 = 分片；標頭 `x-node`、`x-id`（SHA-256 hex）。
#[tauri::command]
pub async fn put_shard(state: State<'_, AppState>, request: Request<'_>) -> CmdResult<()> {
    let node: u8 = header(&request, "x-node")?
        .parse()
        .map_err(|_| "x-node 錯誤")?;
    let id = parse_id(header(&request, "x-id")?)?;
    let data = raw_body(&request)?.to_vec();
    let n = state.node.lock().await.clone().ok_or("尚未加入組織")?;
    n.put_shard(node, id, data).await.map_err(e)
}

#[tauri::command]
pub async fn has_shards(
    state: State<'_, AppState>,
    node: u8,
    ids: Vec<String>,
) -> CmdResult<Vec<bool>> {
    let ids = ids
        .iter()
        .map(|s| parse_id(s))
        .collect::<CmdResult<Vec<_>>>()?;
    let n = state.node.lock().await.clone().ok_or("尚未加入組織")?;
    n.has_shards(node, ids).await.map_err(e)
}

#[tauri::command]
pub async fn get_shard(state: State<'_, AppState>, node: u8, id: String) -> CmdResult<Response> {
    let id = parse_id(&id)?;
    let n = state.node.lock().await.clone().ok_or("尚未加入組織")?;
    Ok(Response::new(n.get_shard(node, id).await.map_err(e)?))
}

#[tauri::command]
pub async fn save_target_file(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> CmdResult<Option<String>> {
    let name = crate::files::safe_component(&name);
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog().file().set_file_name(name).blocking_save_file()
    })
    .await
    .map_err(e)?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    Ok(Some(registry(&state)?.add_target_file(path)))
}

/// 匯出文字檔（報表 Markdown，technical-design §16.13）：存檔對話框選路徑後寫入；取消時回傳 false。
#[tauri::command]
pub async fn export_text(app: AppHandle, name: String, content: String) -> CmdResult<bool> {
    if content.len() > 1024 * 1024 {
        return Err("內容過大".into());
    }
    let name = crate::files::safe_component(&name);
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog().file().set_file_name(name).blocking_save_file()
    })
    .await
    .map_err(e)?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(false);
    };
    tokio::fs::write(&path, content.as_bytes())
        .await
        .map_err(e)?;
    Ok(true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDir {
    token: String,
    name: String,
}

#[tauri::command]
pub async fn save_target_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<TargetDir>> {
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(e)?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Some(TargetDir {
        token: registry(&state)?.add_target_dir(path),
        name,
    }))
}

/// 二進位內容 = 解密後的明文；標頭 `x-token`、`x-path`（資料夾內路徑，encodeURIComponent）、`x-offset`。
#[tauri::command]
pub async fn write_partial(state: State<'_, AppState>, request: Request<'_>) -> CmdResult<()> {
    let token = header(&request, "x-token")?.to_owned();
    let path = percent_decode(header(&request, "x-path").unwrap_or(""))?;
    let offset: u64 = header(&request, "x-offset")?
        .parse()
        .map_err(|_| "x-offset 錯誤")?;
    let data = raw_body(&request)?;
    registry(&state)?.write_partial(&token, &path, offset, data)
}

#[tauri::command]
pub async fn finish_download(
    state: State<'_, AppState>,
    token: String,
    path: String,
    size: u64,
    key: Option<String>,
) -> CmdResult<String> {
    let done = registry(&state)?.finish(&token, &path, size)?;
    // 單檔下載：記下完成的位置（「檔案」頁的「已下載」，§16.19 v0.35）
    if let Some(key) = key.filter(|_| path.is_empty()) {
        let at = hills_node::now_ms();
        with_node!(state, n => n.record_download(&key, std::path::PathBuf::from(&done), at).map_err(e))?;
    }
    Ok(done)
}

/// 資料夾下載完成：記下目標資料夾（路徑取自本次選擇的下載目標，不由前端指定）。
#[tauri::command]
pub async fn record_folder_download(
    state: State<'_, AppState>,
    token: String,
    key: String,
) -> CmdResult<()> {
    let root = registry(&state)?
        .target_root(&token)
        .ok_or("找不到下載目標")?;
    let at = hills_node::now_ms();
    with_node!(state, n => n.record_download(&key, root, at).map_err(e))
}

/// 打開或在 Finder / 檔案總管中顯示下載過的檔案（「檔案」頁，D64）。只接受本機下載紀錄中的路徑。
#[tauri::command]
pub async fn open_downloaded(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    reveal: bool,
) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let p = with_node!(state, n => n.downloaded_path(&key).map_err(e))?
        .ok_or("檔案已移動或刪除，請重新下載")?;
    if reveal {
        app.opener().reveal_item_in_dir(p).map_err(e)
    } else {
        app.opener()
            .open_path(p.to_string_lossy(), None::<&str>)
            .map_err(e)
    }
}

#[tauri::command]
pub async fn abort_download(
    state: State<'_, AppState>,
    token: String,
    path: String,
) -> CmdResult<()> {
    registry(&state)?.abort(&token, &path);
    Ok(())
}

/// 在 Finder / 檔案總管中顯示，或用預設程式打開。
#[tauri::command]
pub async fn show_download(
    app: AppHandle,
    state: State<'_, AppState>,
    token: String,
    path: String,
    name: String,
    open: bool,
) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let p = if path.is_empty() && name.is_empty() {
        registry(&state)?.target_root(&token)
    } else {
        registry(&state)?.shown_path(&token, &path, &name)
    }
    .ok_or("找不到檔案")?;
    if open {
        app.opener()
            .open_path(p.to_string_lossy(), None::<&str>)
            .map_err(e)
    } else {
        app.opener().reveal_item_in_dir(p).map_err(e)
    }
}

// ── 續傳（ui-spec「檔案分享」：下次開啟時詢問「繼續上傳？」）─────────

#[derive(Serialize, Deserialize)]
struct StoredJob {
    id: String,
    paths: Vec<Option<std::path::PathBuf>>,
    state: serde_json::Value,
}

#[derive(Deserialize)]
pub struct JobArgs {
    id: String,
    tokens: Vec<String>,
    state: serde_json::Value,
}

#[derive(Serialize)]
pub struct JobView {
    id: String,
    tokens: Vec<Option<String>>,
    state: serde_json::Value,
}

/// 保存未完成的上傳（前端狀態含檔案金鑰，以儲存金鑰加密存在本機）。
#[tauri::command]
pub async fn save_upload_jobs(state: State<'_, AppState>, jobs: Vec<JobArgs>) -> CmdResult<()> {
    let stored: Vec<StoredJob> = {
        let reg = registry(&state)?;
        jobs.into_iter()
            .map(|j| StoredJob {
                id: j.id,
                paths: j.tokens.iter().map(|t| reg.path_of(t)).collect(),
                state: j.state,
            })
            .collect()
    };
    let bytes = serde_json::to_vec(&stored).map_err(e)?;
    with_node!(state, n => n.save_upload_jobs(&bytes).map_err(e))
}

#[tauri::command]
pub async fn upload_jobs(state: State<'_, AppState>) -> CmdResult<Vec<JobView>> {
    let raw = with_node!(state, n => n.upload_jobs().map_err(e))?;
    let Some(raw) = raw else { return Ok(vec![]) };
    let stored: Vec<StoredJob> = serde_json::from_slice(&raw).unwrap_or_default();
    let mut reg = registry(&state)?;
    Ok(stored
        .into_iter()
        .map(|j| JobView {
            id: j.id,
            tokens: j
                .paths
                .into_iter()
                .map(|p| p.and_then(|p| reg.restore(p)))
                .collect(),
            state: j.state,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent() {
        assert_eq!(
            percent_decode("%E8%A8%AD%E8%A8%88/a%20b").unwrap(),
            "設計/a b"
        );
        assert_eq!(percent_decode("plain").unwrap(), "plain");
        assert!(percent_decode("%zz").is_err());
    }
}
