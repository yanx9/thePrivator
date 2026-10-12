mod automation_api;
use tauri::{Manager, Emitter};
mod diagnostics;
mod events;
#[cfg(target_os = "linux")]
mod linux_webkit;
mod sidecar;
mod sidecar_pool;

// Holding the handle holds the OS lock until the desktop process exits.
struct DesktopInstanceLock(#[allow(dead_code)] std::fs::File);

mod commands {
    use serde::Serialize;

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ShellStatus {
        product_name: &'static str,
        bridge: &'static str,
        sidecar: &'static str,
    }

    #[tauri::command]
    pub fn shell_status() -> ShellStatus {
        ShellStatus {
            product_name: "ThePrivator",
            bridge: "typed-command-bridge",
            sidecar: "theprivator-sidecar",
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    linux_webkit::configure();

    tauri::Builder::default()
        .manage(sidecar::DesktopDataState::default())
        .manage(automation_api::AutomationApiSupervisor::new())
        // Sidecar workers are kept warm between commands, so the pool has to
        // outlive any single command. Dropping it stops every pooled process.
        .manage(std::sync::Arc::new(sidecar_pool::SidecarPool::new()))
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            std::fs::create_dir_all(&root)?;
            let mut options = std::fs::OpenOptions::new();
            options.read(true).write(true).create(true);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(0); }
            let file = options.open(root.join(".desktop.lock"))?;
            #[cfg(unix)] {
                use std::os::fd::AsRawFd;
                if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                    return Err("ThePrivator is already open for this data folder.".into());
                }
            }
            app.manage(DesktopInstanceLock(file));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::shell_status,
            sidecar::desktop_data,
            automation_api::automation_api_start,
            automation_api::automation_api_status,
            automation_api::automation_api_copy_token,
            automation_api::automation_api_stop,
            diagnostics::diagnostics_lookup,
            sidecar::sidecar_health,
            sidecar::sidecar_diagnostic_failure,
            sidecar::identity_presets_list,
            sidecar::identity_surfaces_describe,
            sidecar::identity_validate,
            sidecar::proxy_validate,
            sidecar::identity_audit_plan,
            sidecar::identity_audit_open,
            sidecar::identity_audit_collect,
            sidecar::profiles_identity_apply_preset,
            sidecar::profiles_identity_update,
            sidecar::profiles_proxy_update,
            sidecar::profiles_proxy_check,
            sidecar::cookie_bot_defaults,
            sidecar::cookie_bot_start,
            sidecar::cookie_bot_status,
            sidecar::cookie_bot_cancel,
            sidecar::profile_cookies_export,
            sidecar::profile_cookies_replace,
            sidecar::profile_package_export,
            sidecar::profile_package_import,
            sidecar::profiles_list,
            sidecar::profiles_create,
            sidecar::profiles_duplicate,
            sidecar::profiles_update,
            sidecar::profiles_delete,
            sidecar::chromium_status,
            sidecar::chromium_launch,
            sidecar::chromium_stop,
            sidecar::chromium_bulk_launch,
            sidecar::chromium_bulk_stop,
            sidecar::profiles_organization_update,
            sidecar::profiles_launch_update,
            sidecar::profiles_trash_list,
            sidecar::profiles_trash_restore,
            sidecar::profiles_trash_purge,
            sidecar::sync_status,
            sidecar::sync_configure,
            sidecar::sync_plan,
            sidecar::sync_run,
            sidecar::sync_resolve,
            sidecar::sync_prepare,
            sidecar::sync_force_release_lock,
            sidecar::legacy_scan_profiles,
            sidecar::legacy_import_profiles
        ])
        .build(tauri::generate_context!())
        .expect("error while building ThePrivator Tauri application")
        .run(|app, event| {
            if !matches!(&event, tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::CloseRequested { .. }, .. } | tauri::RunEvent::ExitRequested { .. }) { return; }
            let state = app.state::<sidecar::DesktopDataState>();
            if state.exit_ready.load(std::sync::atomic::Ordering::SeqCst) { return; }
            let protected = app.path().app_data_dir().map(|p| p.join("vault.json").exists()).unwrap_or(false);
            let unlocked = state.key.try_read().map(|k| k.is_some()).unwrap_or(true);
            if !protected || !unlocked { return; }
            match event {
                tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::CloseRequested { api, .. }, .. } => api.prevent_close(),
                tauri::RunEvent::ExitRequested { api, .. } => api.prevent_exit(),
                _ => return,
            }
            if state.closing.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let result = sidecar::desktop_data(handle.clone(), "vault.lock".into(), serde_json::json!({})).await;
                let state = handle.state::<sidecar::DesktopDataState>();
                if result.is_ok() {
                    state.exit_ready.store(true, std::sync::atomic::Ordering::SeqCst);
                    handle.exit(0);
                } else {
                    state.closing.store(false, std::sync::atomic::Ordering::SeqCst);
                    let _ = handle.emit("theprivator://vault-close-failed", "The vault could not be locked. The app remains open; retry Lock in Settings.");
                }
            });
        });
}
