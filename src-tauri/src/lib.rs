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
            bridge: "typed-command-placeholder",
            sidecar: "not-wired-yet",
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::shell_status])
        .run(tauri::generate_context!())
        .expect("error while running ThePrivator Tauri application");
}
