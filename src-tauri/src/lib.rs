mod automation_api;
mod diagnostics;
mod events;
mod sidecar;
mod sidecar_pool;

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
    tauri::Builder::default()
        .manage(automation_api::AutomationApiSupervisor::new())
        // Sidecar workers are kept warm between commands, so the pool has to
        // outlive any single command. Dropping it stops every pooled process.
        .manage(std::sync::Arc::new(sidecar_pool::SidecarPool::new()))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::shell_status,
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
            sidecar::profile_cookies_export,
            sidecar::profile_cookies_replace,
            sidecar::profile_package_export,
            sidecar::profile_package_import,
            sidecar::profiles_list,
            sidecar::profiles_create,
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
            sidecar::legacy_scan_profiles,
            sidecar::legacy_import_profiles
        ])
        .run(tauri::generate_context!())
        .expect("error while running ThePrivator Tauri application");
}
