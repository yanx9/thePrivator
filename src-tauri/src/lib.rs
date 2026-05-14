mod automation_api;
mod diagnostics;
mod sidecar;

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
            sidecar::identity_validate,
            sidecar::proxy_validate,
            sidecar::identity_audit_plan,
            sidecar::identity_audit_open,
            sidecar::profiles_identity_apply_preset,
            sidecar::profiles_identity_update,
            sidecar::profiles_proxy_update,
            sidecar::profiles_proxy_check,
            sidecar::profiles_list,
            sidecar::profiles_create,
            sidecar::profiles_update,
            sidecar::profiles_delete,
            sidecar::chromium_status,
            sidecar::chromium_launch,
            sidecar::chromium_stop,
            sidecar::legacy_scan_profiles,
            sidecar::legacy_import_profiles
        ])
        .run(tauri::generate_context!())
        .expect("error while running ThePrivator Tauri application");
}
