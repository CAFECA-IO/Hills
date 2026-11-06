//! Hills 桌機 app 的 Rust 端：以 hills-node 為核心，透過 Tauri command 提供給前端
//! （development-guidelines §4.2；前端不接觸金鑰）。

mod commands;
mod keychain;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,iroh=warn,iroh_gossip=warn".into()),
        )
        .init();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(commands::AppState::new(dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::app_info,
            commands::create_org,
            commands::join_org,
            commands::recover,
            commands::recovery_words,
            commands::export_org_root_backup,
            commands::link_start,
            commands::link_cancel,
            commands::link_device,
            commands::link_confirm,
            commands::overview,
            commands::set_presence,
            commands::sync_status,
            commands::sync_now,
            commands::org_code,
            commands::create_invite,
            commands::invites,
            commands::rename_org,
            commands::revoke_member,
            commands::devices,
            commands::revoke_device,
            commands::conversations,
            commands::messages,
            commands::open_dm,
            commands::create_group,
            commands::send_message,
            commands::add_conv_members,
            commands::remove_conv_member,
            commands::rename_conv,
            commands::set_active_conv,
            commands::tasks,
            commands::create_task,
            commands::update_task,
            commands::set_step_done,
            commands::delete_task,
            commands::focus,
            commands::set_focus,
            commands::set_profile,
            commands::upsert_office,
            commands::remove_office,
            commands::set_lunch_break,
        ])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        eprintln!("Hills 無法啟動：{err}");
        std::process::exit(1);
    }
}
