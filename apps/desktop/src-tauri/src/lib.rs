//! Hills 桌機 app 的 Rust 端。M0 只有視窗與版本查詢；核心功能由 crates/hills-* 提供，
//! 前端只透過 Tauri command 讀取投影、送出寫入意圖（development-guidelines §4.2）。

/// 回傳 app 版本，供前端顯示與相容性檢查。
#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        eprintln!("Hills 無法啟動：{err}");
        std::process::exit(1);
    }
}
