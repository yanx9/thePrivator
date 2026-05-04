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
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::shell_status,
            sidecar::sidecar_health,
            sidecar::sidecar_diagnostic_failure
        ])
        .run(tauri::generate_context!())
        .expect("error while running ThePrivator Tauri application");
}
