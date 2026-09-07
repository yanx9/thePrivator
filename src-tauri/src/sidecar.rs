use crate::diagnostics::{DiagnosticStore, StderrPersistOutcome};
use crate::events;
use crate::sidecar_pool::SidecarPool;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::Command as StdCommand,
    sync::atomic::{AtomicU64, Ordering},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

pub const SIDECAR_LOGICAL_NAME: &str = "theprivator-sidecar";
pub const SIDECAR_EXTERNAL_BIN: &str = "binaries/theprivator-sidecar";
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(5);
// Large legacy user-data copies can legitimately outlive CRUD/health checks, so
// only legacy.import receives this longer one-shot process timeout.
const LEGACY_IMPORT_TIMEOUT: Duration = Duration::from_secs(120);
// Identity-aware Chromium launch can include extension generation, process
// startup, DevTools readiness polling, and CDP apply before the sidecar responds.
// Identity audit open uses the same budget because it may launch Chromium and
// open a curated page after CDP identity overrides are applied.
const CHROMIUM_LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
// Stopping asks the process tree to exit, waits, then forces it. Python allows
// 3s graceful plus 2s forced, so the generic 5s bridge budget was exactly the
// worst case with nothing left for spawning the sidecar itself -- a browser that
// ignored SIGTERM timed out every time. This leaves real headroom.
const CHROMIUM_STOP_TIMEOUT: Duration = Duration::from_secs(15);
// Bulk launch staggers browser starts and each one carries the full launch cost,
// so the batch needs a budget of its own. The sidecar stops at 110s and returns
// what it managed, which is why this sits just above that.
const CHROMIUM_BULK_LAUNCH_TIMEOUT: Duration = Duration::from_secs(120);
const CHROMIUM_BULK_STOP_TIMEOUT: Duration = Duration::from_secs(60);
// Editing organization or launch settings is a single store write.
const PROFILE_SECTION_TIMEOUT: Duration = Duration::from_secs(10);
// Collecting the audit launches Chromium, waits for CDP discovery, then walks
// nine checker pages one at a time, each of which loads a real remote page over
// the profile's proxy. Measured runs take 40-90s; the previous 30s budget
// reported a bridge error while the sidecar kept working, leaving an orphaned
// browser the UI believed had never started.
const IDENTITY_AUDIT_COLLECT_TIMEOUT: Duration = Duration::from_secs(120);
// Profile proxy checks run a deterministic local proof through Chromium-sized
// machinery, so they need the same bounded long-command budget without allowing
// unbounded queued UI clicks.
const PROXY_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
// Cookie portability touches SQLite and selected files, so it gets a bounded
// budget longer than the generic bridge timeout but shorter than legacy copy.
const COOKIE_PORTABILITY_TIMEOUT: Duration = Duration::from_secs(30);
// Profile packages may include sanitized Chromium user-data payload copies, so
// they get a bounded long-command budget without granting unbounded renderer IO.
const PROFILE_PACKAGE_TIMEOUT: Duration = Duration::from_secs(120);
// Sync moves whole profile directories through a folder another program is
// still uploading, so its budgets are the portability ones rather than the CRUD
// ones. Status and configure only touch small files and stay short, which keeps
// a mistyped folder from taking two minutes to report itself.
const SYNC_STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const SYNC_PLAN_TIMEOUT: Duration = Duration::from_secs(60);
const SYNC_RUN_TIMEOUT: Duration = Duration::from_secs(600);
const SYNC_RESOLVE_TIMEOUT: Duration = Duration::from_secs(300);
const SYNC_PREPARE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_PROFILE_PACKAGE_ARGUMENT_CHARS: usize = 4096;

const COOKIE_FORMAT_THEPRIVATOR_JSON: &str = "theprivator-json";

const SIDECAR_CONFIGURATION_ERROR: &str = "SIDECAR_CONFIGURATION_ERROR";
const SIDECAR_PROCESS_ERROR: &str = "SIDECAR_PROCESS_ERROR";
const SIDECAR_PROTOCOL_ERROR: &str = "SIDECAR_PROTOCOL_ERROR";
const SIDECAR_TIMEOUT: &str = "SIDECAR_TIMEOUT";
const SIDECAR_UNAVAILABLE: &str = "SIDECAR_UNAVAILABLE";

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);
static DETAIL_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportItemParam {
    pub legacy_id: String,
    pub target_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SidecarCommandSuccess {
    pub request_id: Value,
    pub protocol_version: String,
    pub duration_ms: f64,
    pub result: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SidecarCommandError {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
    pub detail_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarProcessOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarRunnerError {
    Configuration,
    Unavailable,
    Timeout,
    Io,
}

#[async_trait]
pub trait SidecarRunner: Send + Sync {
    async fn run(
        &self,
        request_line: String,
        timeout: Duration,
    ) -> Result<SidecarProcessOutput, SidecarRunnerError>;

    fn diagnostics_store(&self) -> Option<&DiagnosticStore> {
        None
    }
}

pub struct TauriSidecarRunner {
    app: tauri::AppHandle,
    diagnostics_store: Option<DiagnosticStore>,
    pool: Arc<SidecarPool>,
}

impl TauriSidecarRunner {
    pub fn new(app: tauri::AppHandle) -> Self {
        let diagnostics_store = DiagnosticStore::from_app_data_dir(app.path().app_data_dir()).ok();
        // The pool is managed state so workers survive between commands. A
        // private pool is used if it is missing, which keeps this constructible
        // outside a fully built app; it just loses the reuse.
        let pool = app
            .try_state::<Arc<SidecarPool>>()
            .map(|state| state.inner().clone())
            .unwrap_or_else(|| Arc::new(SidecarPool::new()));
        Self {
            app,
            diagnostics_store,
            pool,
        }
    }
}

#[async_trait]
impl SidecarRunner for TauriSidecarRunner {
    async fn run(
        &self,
        request_line: String,
        timeout: Duration,
    ) -> Result<SidecarProcessOutput, SidecarRunnerError> {
        // Resolving the sidecar path must happen on the app handle, but the
        // exchange itself blocks, so the command is built into a factory the
        // pool calls only if it actually needs a new worker.
        let app = self.app.clone();
        let pool = self.pool.clone();

        tokio::task::spawn_blocking(move || {
            let spawn = || -> Result<StdCommand, SidecarRunnerError> {
                app.shell()
                    .sidecar(SIDECAR_LOGICAL_NAME)
                    .map(StdCommand::from)
                    .map_err(|_| SidecarRunnerError::Configuration)
            };
            pool.run(spawn, request_line, timeout)
        })
        .await
        .map_err(|_| SidecarRunnerError::Io)?
    }

    fn diagnostics_store(&self) -> Option<&DiagnosticStore> {
        self.diagnostics_store.as_ref()
    }
}

#[tauri::command]
pub async fn sidecar_health(
    app: tauri::AppHandle,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let runner = TauriSidecarRunner::new(app);
    sidecar_health_with_runner(&runner).await
}

#[tauri::command]
pub async fn sidecar_diagnostic_failure(
    app: tauri::AppHandle,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let runner = TauriSidecarRunner::new(app);
    sidecar_diagnostic_failure_with_runner(&runner).await
}

#[tauri::command]
pub async fn identity_presets_list(
    app: tauri::AppHandle,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let runner = TauriSidecarRunner::new(app);
    identity_presets_list_with_runner(&runner).await
}

#[tauri::command]
pub async fn identity_surfaces_describe(
    app: tauri::AppHandle,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let runner = TauriSidecarRunner::new(app);
    identity_surfaces_describe_with_runner(&runner).await
}

#[tauri::command]
pub async fn identity_validate(
    app: tauri::AppHandle,
    identity: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let runner = TauriSidecarRunner::new(app);
    identity_validate_with_runner(&runner, identity).await
}

#[tauri::command]
pub async fn proxy_validate(
    app: tauri::AppHandle,
    proxy: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let runner = TauriSidecarRunner::new(app);
    proxy_validate_with_runner(&runner, proxy).await
}

#[tauri::command]
pub async fn identity_audit_plan(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    identity_audit_plan_with_runner(&runner, store_root, profile_id).await
}

#[tauri::command]
pub async fn identity_audit_open(
    app: tauri::AppHandle,
    profile_id: String,
    page_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    identity_audit_open_with_runner(&runner, store_root, profile_id, page_id).await
}

#[tauri::command]
pub async fn identity_audit_collect(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    identity_audit_collect_with_runner(&runner, store_root, profile_id).await
}

#[tauri::command]
pub async fn profiles_identity_apply_preset(
    app: tauri::AppHandle,
    profile_id: String,
    preset_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = profiles_identity_apply_preset_with_runner(&runner, store_root, profile_id, preset_id).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "profiles.identity.applyPreset");
    result
}

#[tauri::command]
pub async fn profiles_identity_update(
    app: tauri::AppHandle,
    profile_id: String,
    identity: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = profiles_identity_update_with_runner(&runner, store_root, profile_id, identity).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "profiles.identity.update");
    result
}

#[tauri::command]
pub async fn profiles_proxy_update(
    app: tauri::AppHandle,
    profile_id: String,
    proxy: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = profiles_proxy_update_with_runner(&runner, store_root, profile_id, proxy).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "profiles.proxy.update");
    result
}

#[tauri::command]
pub async fn profiles_proxy_check(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    profiles_proxy_check_with_runner(&runner, store_root, profile_id).await
}

#[tauri::command]
pub async fn cookie_bot_defaults(app: tauri::AppHandle) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    cookie_bot_with_runner(&TauriSidecarRunner::new(app), "defaults", json!({})).await
}

#[tauri::command]
pub async fn cookie_bot_start(app: tauri::AppHandle, profile_id: String, config: Value) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let root = resolve_profile_store_root(&app)?;
    cookie_bot_with_runner(&TauriSidecarRunner::new(app), "start", json!({"storeRoot": root, "profileId": profile_id, "config": config})).await
}

#[tauri::command]
pub async fn cookie_bot_status(app: tauri::AppHandle, profile_id: String) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let root = resolve_profile_store_root(&app)?;
    cookie_bot_with_runner(&TauriSidecarRunner::new(app), "status", json!({"storeRoot": root, "profileId": profile_id})).await
}

#[tauri::command]
pub async fn cookie_bot_cancel(app: tauri::AppHandle, profile_id: String, job_id: String) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let root = resolve_profile_store_root(&app)?;
    cookie_bot_with_runner(&TauriSidecarRunner::new(app), "cancel", json!({"storeRoot": root, "profileId": profile_id, "jobId": job_id})).await
}

async fn cookie_bot_with_runner<R: SidecarRunner>(runner: &R, action: &str, params: Value) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let method = match action {
        "start" => "cookieBot.start",
        "status" => "cookieBot.status",
        "cancel" => "cookieBot.cancel",
        _ => "cookieBot.defaults",
    };
    invoke_method_with_params(runner, method, params).await
}

#[tauri::command]
pub async fn profile_cookies_export(
    app: tauri::AppHandle,
    profile_id: String,
    destination_path: String,
    format: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    profile_cookies_export_with_runner(&runner, store_root, profile_id, destination_path, format)
        .await
}

#[tauri::command]
pub async fn profile_cookies_replace(
    app: tauri::AppHandle,
    profile_id: String,
    source_path: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = profile_cookies_replace_with_runner(&runner, store_root, profile_id, source_path).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "portability.cookies.replace");
    result
}

#[tauri::command]
pub async fn profile_package_export(
    app: tauri::AppHandle,
    profile_id: String,
    destination_path: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    profile_package_export_with_runner(&runner, store_root, profile_id, destination_path).await
}

#[tauri::command]
pub async fn profile_package_import(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = profile_package_import_with_runner(&runner, store_root, source_path).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "portability.profile_package.import");
    result
}

#[tauri::command]
pub async fn profiles_list(
    app: tauri::AppHandle,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    profiles_list_with_runner(&runner, store_root).await
}

#[tauri::command]
pub async fn profiles_create(
    app: tauri::AppHandle,
    name: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = profiles_create_with_runner(&runner, store_root, name).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "profiles.create");
    result
}

#[tauri::command]
pub async fn profiles_duplicate(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = invoke_method_with_params_timeout(&runner, "profiles.duplicate", json!({
        "storeRoot": store_root, "profileId": profile_id,
    }), PROFILE_PACKAGE_TIMEOUT).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "profiles.duplicate");
    result
}

#[tauri::command]
pub async fn profiles_update(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = profiles_update_with_runner(&runner, store_root, id, name).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "profiles.update");
    result
}

#[tauri::command]
pub async fn profiles_delete(
    app: tauri::AppHandle,
    id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = profiles_delete_with_runner(&runner, store_root, id).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "profiles.delete");
    result
}

#[tauri::command]
pub async fn chromium_status(
    app: tauri::AppHandle,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    chromium_status_with_runner(&runner, store_root).await
}

#[tauri::command]
pub async fn chromium_launch(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = chromium_launch_with_runner(&runner, store_root, profile_id).await;
    events::notify_on_success(&app, &result, events::CHROMIUM_STATUS_CHANGED, "chromium.launch");
    result
}

#[tauri::command]
pub async fn sync_status(
    app: tauri::AppHandle,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    sync_status_with_runner(&runner, store_root).await
}

#[tauri::command]
pub async fn sync_configure(
    app: tauri::AppHandle,
    enabled: bool,
    folder: Option<String>,
    device_label: Option<String>,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    sync_configure_with_runner(&runner, store_root, enabled, folder, device_label).await
}

#[tauri::command]
pub async fn sync_plan(
    app: tauri::AppHandle,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    sync_plan_with_runner(&runner, store_root).await
}

#[tauri::command]
pub async fn sync_run(
    app: tauri::AppHandle,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = sync_run_with_runner(&runner, store_root).await;
    // A run can create, update, or trash profiles on this device, so the table
    // has to reload rather than wait for its next poll.
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "sync.run");
    result
}

#[tauri::command]
pub async fn sync_resolve(
    app: tauri::AppHandle,
    profile_id: String,
    resolution: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = sync_resolve_with_runner(&runner, store_root, profile_id, resolution).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "sync.resolve");
    result
}

#[tauri::command]
pub async fn sync_prepare(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = sync_prepare_with_runner(&runner, store_root, profile_id).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "sync.prepare");
    result
}

#[tauri::command]
pub async fn sync_force_release_lock(
    app: tauri::AppHandle,
    profile_id: String,
    confirm_device_label: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    sync_force_release_lock_with_runner(&runner, store_root, profile_id, confirm_device_label).await
}

#[tauri::command]
pub async fn profiles_organization_update(
    app: tauri::AppHandle,
    profile_id: String,
    organization: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result =
        profiles_organization_update_with_runner(&runner, store_root, profile_id, organization).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "profiles.organization.update");
    result
}

#[tauri::command]
pub async fn profiles_launch_update(
    app: tauri::AppHandle,
    profile_id: String,
    launch: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = profiles_launch_update_with_runner(&runner, store_root, profile_id, launch).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "profiles.launch.update");
    result
}

#[tauri::command]
pub async fn profiles_trash_list(
    app: tauri::AppHandle,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    profiles_trash_list_with_runner(&runner, store_root).await
}

#[tauri::command]
pub async fn profiles_trash_restore(
    app: tauri::AppHandle,
    id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = profiles_trash_restore_with_runner(&runner, store_root, id).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "profiles.trash.restore");
    result
}

#[tauri::command]
pub async fn profiles_trash_purge(
    app: tauri::AppHandle,
    id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = profiles_trash_purge_with_runner(&runner, store_root, id).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "profiles.trash.purge");
    result
}

#[tauri::command]
pub async fn chromium_bulk_launch(
    app: tauri::AppHandle,
    profile_ids: Vec<String>,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = chromium_bulk_launch_with_runner(&runner, store_root, profile_ids).await;
    events::notify_on_success(&app, &result, events::CHROMIUM_STATUS_CHANGED, "chromium.bulk.launch");
    result
}

#[tauri::command]
pub async fn chromium_bulk_stop(
    app: tauri::AppHandle,
    profile_ids: Option<Vec<String>>,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = chromium_bulk_stop_with_runner(&runner, store_root, profile_ids).await;
    events::notify_on_success(&app, &result, events::CHROMIUM_STATUS_CHANGED, "chromium.bulk.stop");
    result
}

#[tauri::command]
pub async fn chromium_stop(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = chromium_stop_with_runner(&runner, store_root, profile_id).await;
    events::notify_on_success(&app, &result, events::CHROMIUM_STATUS_CHANGED, "chromium.stop");
    result
}

#[tauri::command]
pub async fn legacy_scan_profiles(
    app: tauri::AppHandle,
    legacy_root: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    legacy_scan_profiles_with_runner(&runner, store_root, legacy_root).await
}

#[tauri::command]
pub async fn legacy_import_profiles(
    app: tauri::AppHandle,
    legacy_root: String,
    items: Vec<LegacyImportItemParam>,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app.clone());
    let result = legacy_import_profiles_with_runner(&runner, store_root, legacy_root, items).await;
    events::notify_on_success(&app, &result, events::PROFILES_CHANGED, "legacy.import");
    result
}

pub async fn sidecar_health_with_runner<R: SidecarRunner>(
    runner: &R,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_fixed_method(runner, "health.status").await
}

pub async fn sidecar_diagnostic_failure_with_runner<R: SidecarRunner>(
    runner: &R,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_fixed_method(runner, "diagnostics.fail").await
}

pub async fn identity_presets_list_with_runner<R: SidecarRunner>(
    runner: &R,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_fixed_method(runner, "identity.presets.list").await
}

pub async fn identity_surfaces_describe_with_runner<R: SidecarRunner>(
    runner: &R,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_fixed_method(runner, "identity.surfaces.describe").await
}

pub async fn identity_validate_with_runner<R: SidecarRunner>(
    runner: &R,
    identity: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "identity.validate",
        json!({
            "identity": identity,
        }),
    )
    .await
}

pub async fn proxy_validate_with_runner<R: SidecarRunner>(
    runner: &R,
    proxy: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "proxy.validate",
        json!({
            "proxy": proxy,
        }),
    )
    .await
}

async fn identity_audit_plan_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "identity.audit.plan",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
        }),
    )
    .await
}

async fn identity_audit_open_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
    page_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "identity.audit.open",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
            "pageId": page_id,
        }),
        CHROMIUM_LAUNCH_TIMEOUT,
    )
    .await
}

async fn identity_audit_collect_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "identity.audit.collect",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
        }),
        IDENTITY_AUDIT_COLLECT_TIMEOUT,
    )
    .await
}

async fn profiles_identity_apply_preset_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
    preset_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "profiles.identity.applyPreset",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
            "presetId": preset_id,
        }),
    )
    .await
}

async fn profiles_identity_update_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
    identity: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "profiles.identity.update",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
            "identity": identity,
        }),
    )
    .await
}

async fn profiles_proxy_update_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
    proxy: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "profiles.proxy.update",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
            "proxy": proxy,
        }),
    )
    .await
}

async fn profiles_proxy_check_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "profiles.proxy.check",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
        }),
        PROXY_CHECK_TIMEOUT,
    )
    .await
}

async fn profile_cookies_export_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
    destination_path: String,
    format: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    validate_non_empty_arg("profile id", &profile_id)?;
    validate_non_empty_arg("cookie export destination path", &destination_path)?;
    validate_cookie_export_format(&format)?;
    invoke_method_with_params_timeout(
        runner,
        "portability.cookies.export",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
            "destinationPath": destination_path,
            "format": format,
        }),
        COOKIE_PORTABILITY_TIMEOUT,
    )
    .await
}

async fn profile_cookies_replace_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
    source_path: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    validate_non_empty_arg("profile id", &profile_id)?;
    validate_non_empty_arg("cookie import source path", &source_path)?;
    invoke_method_with_params_timeout(
        runner,
        "portability.cookies.replace",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
            "sourcePath": source_path,
        }),
        COOKIE_PORTABILITY_TIMEOUT,
    )
    .await
}

async fn profile_package_export_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
    destination_path: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    validate_bounded_non_empty_arg(
        "profile id",
        &profile_id,
        MAX_PROFILE_PACKAGE_ARGUMENT_CHARS,
    )?;
    validate_bounded_non_empty_arg(
        "profile package destination path",
        &destination_path,
        MAX_PROFILE_PACKAGE_ARGUMENT_CHARS,
    )?;
    invoke_method_with_params_timeout(
        runner,
        "portability.profile_package.export",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
            "destinationPath": destination_path,
        }),
        PROFILE_PACKAGE_TIMEOUT,
    )
    .await
}

async fn profile_package_import_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    source_path: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    validate_bounded_non_empty_arg(
        "profile package source path",
        &source_path,
        MAX_PROFILE_PACKAGE_ARGUMENT_CHARS,
    )?;
    invoke_method_with_params_timeout(
        runner,
        "portability.profile_package.import",
        json!({
            "storeRoot": store_root,
            "sourcePath": source_path,
        }),
        PROFILE_PACKAGE_TIMEOUT,
    )
    .await
}

async fn profiles_list_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "profiles.list",
        json!({
            "storeRoot": store_root,
        }),
    )
    .await
}

async fn profiles_create_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    name: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "profiles.create",
        json!({
            "storeRoot": store_root,
            "name": name,
        }),
    )
    .await
}

async fn profiles_update_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    id: String,
    name: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "profiles.update",
        json!({
            "storeRoot": store_root,
            "id": id,
            "name": name,
        }),
    )
    .await
}

async fn profiles_delete_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "profiles.delete",
        json!({
            "storeRoot": store_root,
            "id": id,
        }),
    )
    .await
}

async fn chromium_status_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "chromium.status",
        json!({
            "storeRoot": store_root,
        }),
    )
    .await
}

async fn chromium_launch_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "chromium.launch",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
        }),
        CHROMIUM_LAUNCH_TIMEOUT,
    )
    .await
}

async fn sync_status_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "sync.status",
        json!({ "storeRoot": store_root }),
        SYNC_STATUS_TIMEOUT,
    )
    .await
}

async fn sync_configure_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    enabled: bool,
    folder: Option<String>,
    device_label: Option<String>,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "sync.configure",
        json!({
            "storeRoot": store_root,
            "enabled": enabled,
            "folder": folder,
            "deviceLabel": device_label,
        }),
        SYNC_STATUS_TIMEOUT,
    )
    .await
}

async fn sync_plan_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "sync.plan",
        json!({ "storeRoot": store_root }),
        SYNC_PLAN_TIMEOUT,
    )
    .await
}

async fn sync_run_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    // The longest budget in the bridge: a first run uploads or downloads every
    // profile in the library, and each one is a whole browser directory.
    invoke_method_with_params_timeout(
        runner,
        "sync.run",
        json!({ "storeRoot": store_root }),
        SYNC_RUN_TIMEOUT,
    )
    .await
}

async fn sync_resolve_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
    resolution: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "sync.resolve",
        json!({ "storeRoot": store_root, "profileId": profile_id, "resolution": resolution }),
        SYNC_RESOLVE_TIMEOUT,
    )
    .await
}

async fn sync_prepare_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "sync.prepare",
        json!({ "storeRoot": store_root, "profileId": profile_id }),
        SYNC_PREPARE_TIMEOUT,
    )
    .await
}

async fn sync_force_release_lock_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
    confirm_device_label: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "sync.lock.forceRelease",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
            "confirmDeviceLabel": confirm_device_label,
        }),
        SYNC_STATUS_TIMEOUT,
    )
    .await
}

async fn profiles_organization_update_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
    organization: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "profiles.organization.update",
        json!({ "storeRoot": store_root, "profileId": profile_id, "organization": organization }),
        PROFILE_SECTION_TIMEOUT,
    )
    .await
}

async fn profiles_launch_update_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
    launch: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "profiles.launch.update",
        json!({ "storeRoot": store_root, "profileId": profile_id, "launch": launch }),
        PROFILE_SECTION_TIMEOUT,
    )
    .await
}

async fn profiles_trash_list_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(runner, "profiles.trash.list", json!({ "storeRoot": store_root })).await
}

async fn profiles_trash_restore_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(runner, "profiles.trash.restore", json!({ "storeRoot": store_root, "id": id })).await
}

async fn profiles_trash_purge_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    // Purging removes the profile's user-data directory as well as its record,
    // so it gets the longer portability budget rather than the CRUD one.
    invoke_method_with_params_timeout(
        runner,
        "profiles.trash.purge",
        json!({ "storeRoot": store_root, "id": id }),
        COOKIE_PORTABILITY_TIMEOUT,
    )
    .await
}

async fn chromium_bulk_launch_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_ids: Vec<String>,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "chromium.bulk.launch",
        json!({ "storeRoot": store_root, "profileIds": profile_ids }),
        CHROMIUM_BULK_LAUNCH_TIMEOUT,
    )
    .await
}

async fn chromium_bulk_stop_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_ids: Option<Vec<String>>,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "chromium.bulk.stop",
        json!({ "storeRoot": store_root, "profileIds": profile_ids }),
        CHROMIUM_BULK_STOP_TIMEOUT,
    )
    .await
}

async fn chromium_stop_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "chromium.stop",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
        }),
        CHROMIUM_STOP_TIMEOUT,
    )
    .await
}

async fn legacy_scan_profiles_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    legacy_root: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "legacy.scan",
        json!({
            "storeRoot": store_root,
            "legacyRoot": legacy_root,
        }),
    )
    .await
}

async fn legacy_import_profiles_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    legacy_root: String,
    items: Vec<LegacyImportItemParam>,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(
        runner,
        "legacy.import",
        json!({
            "storeRoot": store_root,
            "legacyRoot": legacy_root,
            "items": items,
        }),
        LEGACY_IMPORT_TIMEOUT,
    )
    .await
}

fn resolve_profile_store_root(app: &tauri::AppHandle) -> Result<String, SidecarCommandError> {
    profile_store_root_from_app_data_dir(app.path().app_data_dir())
}

// `ProfileStore` appends `profile-store` internally, so the bridge injects the
// app-data root rather than a path that would become `profile-store/profile-store`.
fn profile_store_root_from_app_data_dir<E>(
    app_data_dir: Result<PathBuf, E>,
) -> Result<String, SidecarCommandError> {
    let app_data_dir = app_data_dir.map_err(|_| {
        bridge_error(
            SIDECAR_CONFIGURATION_ERROR,
            "The Tauri app data directory could not be resolved for the profile store.",
        )
    })?;

    app_data_dir.into_os_string().into_string().map_err(|_| {
        bridge_error(
            SIDECAR_CONFIGURATION_ERROR,
            "The Tauri app data directory for the profile store is not valid Unicode.",
        )
    })
}

fn validate_non_empty_arg(label: &str, value: &str) -> Result<(), SidecarCommandError> {
    if value.trim().is_empty() {
        return Err(bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            &format!("The {label} argument is required."),
        ));
    }
    Ok(())
}

fn validate_bounded_non_empty_arg(
    label: &str,
    value: &str,
    max_chars: usize,
) -> Result<(), SidecarCommandError> {
    validate_non_empty_arg(label, value)?;
    if value.chars().count() > max_chars {
        return Err(bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            &format!("The {label} argument exceeds the allowed length."),
        ));
    }
    Ok(())
}

fn validate_cookie_export_format(format: &str) -> Result<(), SidecarCommandError> {
    validate_non_empty_arg("cookie export format", format)?;
    match format {
        COOKIE_FORMAT_THEPRIVATOR_JSON => Ok(()),
        _ => Err(bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "The cookie export format is unsupported.",
        )),
    }
}

async fn invoke_fixed_method<R: SidecarRunner>(
    runner: &R,
    method: &'static str,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(runner, method, json!({})).await
}

async fn invoke_method_with_params<R: SidecarRunner>(
    runner: &R,
    method: &'static str,
    params: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params_timeout(runner, method, params, BRIDGE_TIMEOUT).await
}

async fn invoke_method_with_params_timeout<R: SidecarRunner>(
    runner: &R,
    method: &'static str,
    params: Value,
    timeout: Duration,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let request_id = next_request_id();
    let request = json!({
        "id": request_id,
        "method": method,
        "params": params,
    });
    let request_line = serde_json::to_string(&request).map_err(|_| {
        bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "Failed to encode the sidecar request envelope.",
        )
    })?;

    let started = Instant::now();
    let output = match runner.run(request_line, timeout).await {
        Ok(output) => output,
        Err(error) => {
            return Err(map_runner_error(
                error,
                method,
                &request_id,
                runner.diagnostics_store(),
                duration_ms(started.elapsed()),
            ));
        }
    };
    let bridge_duration_ms = duration_ms(started.elapsed());

    if let Some(outcome) = persist_sidecar_stderr_diagnostics(
        runner.diagnostics_store(),
        &output.stderr,
        method,
        &request_id,
    ) {
        if outcome.malformed_lines > 0 {
            let error = bridge_error(
                SIDECAR_PROTOCOL_ERROR,
                "The Python sidecar emitted malformed diagnostic stderr lines.",
            );
            log_bridge_failure(
                method,
                &request_id,
                &error,
                output.exit_code,
                &output,
                runner.diagnostics_store(),
                bridge_duration_ms,
            );
        }
    }

    parse_process_output(
        output,
        method,
        &request_id,
        runner.diagnostics_store(),
        bridge_duration_ms,
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarEnvelope {
    id: Option<Value>,
    ok: Option<bool>,
    protocol_version: Option<String>,
    duration_ms: Option<f64>,
    result: Option<Value>,
    error: Option<SidecarErrorEnvelope>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarErrorEnvelope {
    code: String,
    message: String,
    recoverable: bool,
    detail_ref: String,
}

fn parse_process_output(
    output: SidecarProcessOutput,
    method: &str,
    request_id: &str,
    diagnostics_store: Option<&DiagnosticStore>,
    bridge_duration_ms: f64,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    if output.exit_code != Some(0) {
        let error = bridge_error(
            SIDECAR_PROCESS_ERROR,
            "The Python sidecar process exited before returning a successful response.",
        );
        log_bridge_failure(
            method,
            request_id,
            &error,
            output.exit_code,
            &output,
            diagnostics_store,
            bridge_duration_ms,
        );
        return Err(error);
    }

    let stdout_lines: Vec<&str> = output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();

    if stdout_lines.len() != 1 {
        let error = bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "The Python sidecar returned an invalid response envelope.",
        );
        log_bridge_failure(
            method,
            request_id,
            &error,
            output.exit_code,
            &output,
            diagnostics_store,
            bridge_duration_ms,
        );
        return Err(error);
    }

    let envelope: SidecarEnvelope = serde_json::from_str(stdout_lines[0]).map_err(|_| {
        let error = bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "The Python sidecar returned malformed JSON.",
        );
        log_bridge_failure(
            method,
            request_id,
            &error,
            output.exit_code,
            &output,
            diagnostics_store,
            bridge_duration_ms,
        );
        error
    })?;

    validate_envelope(
        envelope,
        method,
        request_id,
        &output,
        diagnostics_store,
        bridge_duration_ms,
    )
}

fn validate_envelope(
    envelope: SidecarEnvelope,
    method: &str,
    request_id: &str,
    output: &SidecarProcessOutput,
    diagnostics_store: Option<&DiagnosticStore>,
    bridge_duration_ms: f64,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let expected_id = Value::String(request_id.to_string());
    if envelope.id.as_ref() != Some(&expected_id) {
        let error = bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "The Python sidecar response id did not match the bridge request id.",
        );
        log_bridge_failure(
            method,
            request_id,
            &error,
            output.exit_code,
            output,
            diagnostics_store,
            bridge_duration_ms,
        );
        return Err(error);
    }

    let Some(ok) = envelope.ok else {
        let error = bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "The Python sidecar response is missing ok.",
        );
        log_bridge_failure(
            method,
            request_id,
            &error,
            output.exit_code,
            output,
            diagnostics_store,
            bridge_duration_ms,
        );
        return Err(error);
    };

    let Some(protocol_version) = envelope.protocol_version else {
        let error = bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "The Python sidecar response is missing protocolVersion.",
        );
        log_bridge_failure(
            method,
            request_id,
            &error,
            output.exit_code,
            output,
            diagnostics_store,
            bridge_duration_ms,
        );
        return Err(error);
    };

    let Some(duration_ms) = envelope.duration_ms else {
        let error = bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "The Python sidecar response is missing durationMs.",
        );
        log_bridge_failure(
            method,
            request_id,
            &error,
            output.exit_code,
            output,
            diagnostics_store,
            bridge_duration_ms,
        );
        return Err(error);
    };

    if ok {
        let Some(result) = envelope.result else {
            let error = bridge_error(
                SIDECAR_PROTOCOL_ERROR,
                "The Python sidecar success response is missing result.",
            );
            log_bridge_failure(
                method,
                request_id,
                &error,
                output.exit_code,
                output,
                diagnostics_store,
                bridge_duration_ms,
            );
            return Err(error);
        };

        if !result.is_object() {
            let error = bridge_error(
                SIDECAR_PROTOCOL_ERROR,
                "The Python sidecar success result must be an object.",
            );
            log_bridge_failure(
                method,
                request_id,
                &error,
                output.exit_code,
                output,
                diagnostics_store,
                bridge_duration_ms,
            );
            return Err(error);
        }

        Ok(SidecarCommandSuccess {
            request_id: expected_id,
            protocol_version,
            duration_ms,
            result,
        })
    } else {
        let Some(error) = envelope.error else {
            let error = bridge_error(
                SIDECAR_PROTOCOL_ERROR,
                "The Python sidecar error response is missing error.",
            );
            log_bridge_failure(
                method,
                request_id,
                &error,
                output.exit_code,
                output,
                diagnostics_store,
                bridge_duration_ms,
            );
            return Err(error);
        };

        Err(SidecarCommandError {
            code: error.code,
            message: error.message,
            recoverable: error.recoverable,
            detail_ref: error.detail_ref,
        })
    }
}

fn map_runner_error(
    error: SidecarRunnerError,
    method: &str,
    request_id: &str,
    diagnostics_store: Option<&DiagnosticStore>,
    bridge_duration_ms: f64,
) -> SidecarCommandError {
    let mapped = match error {
        SidecarRunnerError::Configuration => bridge_error(
            SIDECAR_CONFIGURATION_ERROR,
            &format!(
                "Sidecar configuration failed for logical name '{SIDECAR_LOGICAL_NAME}'. Ensure bundle.externalBin includes '{SIDECAR_EXTERNAL_BIN}'."
            ),
        ),
        SidecarRunnerError::Unavailable => bridge_error(
            SIDECAR_UNAVAILABLE,
            "The Python sidecar binary is unavailable. Run npm run sidecar:build and retry.",
        ),
        SidecarRunnerError::Timeout => bridge_error(
            SIDECAR_TIMEOUT,
            "The Python sidecar did not respond before the bridge timeout.",
        ),
        SidecarRunnerError::Io => bridge_error(
            SIDECAR_PROCESS_ERROR,
            "The Rust bridge could not complete sidecar process I/O.",
        ),
    };

    log_bridge_failure(
        method,
        request_id,
        &mapped,
        None,
        &SidecarProcessOutput {
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
        },
        diagnostics_store,
        bridge_duration_ms,
    );
    mapped
}

pub(crate) fn bridge_error(code: &str, message: &str) -> SidecarCommandError {
    SidecarCommandError {
        code: code.to_string(),
        message: message.to_string(),
        recoverable: true,
        detail_ref: make_detail_ref("bridge"),
    }
}

fn next_request_id() -> String {
    let sequence = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("bridge-{sequence}")
}

fn make_detail_ref(prefix: &str) -> String {
    let sequence = DETAIL_COUNTER.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{prefix}-{timestamp:x}-{sequence:x}")
}

fn duration_ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn persist_sidecar_stderr_diagnostics(
    diagnostics_store: Option<&DiagnosticStore>,
    stderr: &str,
    method: &str,
    request_id: &str,
) -> Option<StderrPersistOutcome> {
    diagnostics_store.map(|store| store.append_sidecar_stderr_events(stderr, method, request_id))
}

fn log_bridge_failure(
    method: &str,
    request_id: &str,
    error: &SidecarCommandError,
    exit_code: Option<i32>,
    output: &SidecarProcessOutput,
    diagnostics_store: Option<&DiagnosticStore>,
    bridge_duration_ms: f64,
) {
    let stdout_lines = output
        .stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    let stderr_lines = output
        .stderr
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    let event = crate::diagnostics::bridge_failure_event(
        method,
        request_id,
        &error.code,
        &error.detail_ref,
        bridge_duration_ms,
        exit_code,
        stdout_lines,
        stderr_lines,
    );

    if let Some(store) = diagnostics_store {
        store.append_event(event.clone());
    }

    eprintln!(
        "{}",
        serde_json::to_string(&event).unwrap_or_else(|_| {
            "{\"event\":\"sidecar.bridge_failure\",\"errorCode\":\"SERIALIZE_FAILURE\"}".to_string()
        })
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{Arc, Mutex},
        time::{SystemTime, UNIX_EPOCH},
    };

    #[derive(Clone)]
    enum FakeMode {
        HealthSuccess,
        SuccessResult(Value),
        TypedError {
            code: &'static str,
            message: &'static str,
            detail_ref: &'static str,
        },
        Static(SidecarProcessOutput),
        RunnerError(SidecarRunnerError),
        MismatchedId,
        MissingOk,
        MissingResult,
        MissingError,
    }

    #[derive(Clone)]
    struct FakeRunner {
        mode: FakeMode,
        last_request: Arc<Mutex<Option<Value>>>,
        last_timeout: Arc<Mutex<Option<Duration>>>,
        diagnostics_store: Option<DiagnosticStore>,
    }

    impl FakeRunner {
        fn new(mode: FakeMode) -> Self {
            Self {
                mode,
                last_request: Arc::new(Mutex::new(None)),
                last_timeout: Arc::new(Mutex::new(None)),
                diagnostics_store: None,
            }
        }

        fn with_diagnostics(mode: FakeMode, diagnostics_store: DiagnosticStore) -> Self {
            Self {
                mode,
                last_request: Arc::new(Mutex::new(None)),
                last_timeout: Arc::new(Mutex::new(None)),
                diagnostics_store: Some(diagnostics_store),
            }
        }

        fn last_request(&self) -> Value {
            self.last_request
                .lock()
                .expect("last_request lock poisoned")
                .clone()
                .expect("runner was not called")
        }

        fn last_timeout(&self) -> Duration {
            self.last_timeout
                .lock()
                .expect("last_timeout lock poisoned")
                .expect("runner was not called")
        }

        fn was_called(&self) -> bool {
            self.last_request
                .lock()
                .expect("last_request lock poisoned")
                .is_some()
        }
    }

    #[async_trait]
    impl SidecarRunner for FakeRunner {
        async fn run(
            &self,
            request_line: String,
            timeout: Duration,
        ) -> Result<SidecarProcessOutput, SidecarRunnerError> {
            let request: Value = serde_json::from_str(&request_line).expect("valid bridge request");
            *self
                .last_request
                .lock()
                .expect("last_request lock poisoned") = Some(request.clone());
            *self
                .last_timeout
                .lock()
                .expect("last_timeout lock poisoned") = Some(timeout);
            let request_id = request.get("id").cloned().unwrap_or(Value::Null);

            match &self.mode {
                FakeMode::HealthSuccess => Ok(output_with_stdout(json!({
                    "id": request_id,
                    "ok": true,
                    "protocolVersion": "1.0.0",
                    "durationMs": 1.25,
                    "result": { "status": "healthy" }
                }))),
                FakeMode::SuccessResult(result) => Ok(output_with_stdout(json!({
                    "id": request_id,
                    "ok": true,
                    "protocolVersion": "1.0.0",
                    "durationMs": 1.25,
                    "result": result.clone()
                }))),
                FakeMode::TypedError {
                    code,
                    message,
                    detail_ref,
                } => Ok(output_with_stdout_and_stderr(
                    json!({
                        "id": request_id,
                        "ok": false,
                        "protocolVersion": "1.0.0",
                        "durationMs": 1.5,
                        "error": {
                            "code": code,
                            "message": message,
                            "recoverable": true,
                            "detailRef": detail_ref
                        }
                    }),
                    json!({
                        "event": "sidecar.request",
                        "status": "error",
                        "durationMs": 1.5,
                        "errorCode": code,
                        "detailRef": detail_ref
                    }),
                )),
                FakeMode::Static(output) => Ok(output.clone()),
                FakeMode::RunnerError(error) => Err(error.clone()),
                FakeMode::MismatchedId => Ok(output_with_stdout(json!({
                    "id": "different-request",
                    "ok": true,
                    "protocolVersion": "1.0.0",
                    "durationMs": 1.0,
                    "result": { "status": "healthy" }
                }))),
                FakeMode::MissingOk => Ok(output_with_stdout(json!({
                    "id": request_id,
                    "protocolVersion": "1.0.0",
                    "durationMs": 1.0,
                    "result": { "status": "healthy" }
                }))),
                FakeMode::MissingResult => Ok(output_with_stdout(json!({
                    "id": request_id,
                    "ok": true,
                    "protocolVersion": "1.0.0",
                    "durationMs": 1.0
                }))),
                FakeMode::MissingError => Ok(output_with_stdout(json!({
                    "id": request_id,
                    "ok": false,
                    "protocolVersion": "1.0.0",
                    "durationMs": 1.0
                }))),
            }
        }

        fn diagnostics_store(&self) -> Option<&DiagnosticStore> {
            self.diagnostics_store.as_ref()
        }
    }

    fn output_with_stdout(value: Value) -> SidecarProcessOutput {
        output_with_stdout_and_stderr(
            value,
            json!({
                "event": "sidecar.request",
                "status": "ok",
                "durationMs": 1.25
            }),
        )
    }

    fn output_with_stdout_and_stderr(value: Value, stderr_event: Value) -> SidecarProcessOutput {
        SidecarProcessOutput {
            exit_code: Some(0),
            stdout: format!("{value}\n"),
            stderr: format!("{stderr_event}\n"),
        }
    }

    fn output(exit_code: Option<i32>, stdout: &str, stderr: &str) -> SidecarProcessOutput {
        SidecarProcessOutput {
            exit_code,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
        }
    }

    fn temp_diagnostics_store() -> DiagnosticStore {
        let sequence = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("theprivator-sidecar-diagnostics-{sequence}"));
        let _ = fs::remove_dir_all(&root);
        DiagnosticStore::new(root).expect("temp diagnostics root is absolute")
    }

    fn diagnostics_log_text(store: &DiagnosticStore) -> String {
        fs::read_to_string(store.log_path()).expect("diagnostics log exists")
    }

    fn run_health(runner: &FakeRunner) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(sidecar_health_with_runner(runner))
    }

    fn run_diagnostic_failure(
        runner: &FakeRunner,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(sidecar_diagnostic_failure_with_runner(runner))
    }

    fn run_identity_presets_list(
        runner: &FakeRunner,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(identity_presets_list_with_runner(runner))
    }

    fn run_identity_surfaces_describe(
        runner: &FakeRunner,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(identity_surfaces_describe_with_runner(runner))
    }

    fn run_identity_validate(
        runner: &FakeRunner,
        identity: Value,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(identity_validate_with_runner(runner, identity))
    }

    fn run_proxy_validate(
        runner: &FakeRunner,
        proxy: Value,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(proxy_validate_with_runner(runner, proxy))
    }

    fn run_profiles_identity_apply_preset(
        runner: &FakeRunner,
        store_root: &str,
        profile_id: &str,
        preset_id: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(profiles_identity_apply_preset_with_runner(
            runner,
            store_root.to_string(),
            profile_id.to_string(),
            preset_id.to_string(),
        ))
    }

    fn run_profiles_identity_update(
        runner: &FakeRunner,
        store_root: &str,
        profile_id: &str,
        identity: Value,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(profiles_identity_update_with_runner(
            runner,
            store_root.to_string(),
            profile_id.to_string(),
            identity,
        ))
    }

    fn run_profiles_proxy_update(
        runner: &FakeRunner,
        store_root: &str,
        profile_id: &str,
        proxy: Value,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(profiles_proxy_update_with_runner(
            runner,
            store_root.to_string(),
            profile_id.to_string(),
            proxy,
        ))
    }

    fn run_profiles_proxy_check(
        runner: &FakeRunner,
        store_root: &str,
        profile_id: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(profiles_proxy_check_with_runner(
            runner,
            store_root.to_string(),
            profile_id.to_string(),
        ))
    }

    fn run_profiles_list(
        runner: &FakeRunner,
        store_root: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(profiles_list_with_runner(runner, store_root.to_string()))
    }

    fn run_profiles_create(
        runner: &FakeRunner,
        store_root: &str,
        name: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(profiles_create_with_runner(
            runner,
            store_root.to_string(),
            name.to_string(),
        ))
    }

    fn run_profiles_update(
        runner: &FakeRunner,
        store_root: &str,
        id: &str,
        name: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(profiles_update_with_runner(
            runner,
            store_root.to_string(),
            id.to_string(),
            name.to_string(),
        ))
    }

    fn run_profiles_delete(
        runner: &FakeRunner,
        store_root: &str,
        id: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(profiles_delete_with_runner(
            runner,
            store_root.to_string(),
            id.to_string(),
        ))
    }

    fn run_chromium_status(
        runner: &FakeRunner,
        store_root: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(chromium_status_with_runner(runner, store_root.to_string()))
    }

    fn run_chromium_launch(
        runner: &FakeRunner,
        store_root: &str,
        profile_id: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(chromium_launch_with_runner(
            runner,
            store_root.to_string(),
            profile_id.to_string(),
        ))
    }

    fn run_chromium_stop(
        runner: &FakeRunner,
        store_root: &str,
        profile_id: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(chromium_stop_with_runner(
            runner,
            store_root.to_string(),
            profile_id.to_string(),
        ))
    }

    fn run_identity_audit_plan(
        runner: &FakeRunner,
        store_root: &str,
        profile_id: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(identity_audit_plan_with_runner(
            runner,
            store_root.to_string(),
            profile_id.to_string(),
        ))
    }

    fn run_identity_audit_open(
        runner: &FakeRunner,
        store_root: &str,
        profile_id: &str,
        page_id: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(identity_audit_open_with_runner(
            runner,
            store_root.to_string(),
            profile_id.to_string(),
            page_id.to_string(),
        ))
    }

    fn run_identity_audit_collect(
        runner: &FakeRunner,
        store_root: &str,
        profile_id: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(identity_audit_collect_with_runner(
            runner,
            store_root.to_string(),
            profile_id.to_string(),
        ))
    }

    fn run_legacy_scan(
        runner: &FakeRunner,
        store_root: &str,
        legacy_root: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(legacy_scan_profiles_with_runner(
            runner,
            store_root.to_string(),
            legacy_root.to_string(),
        ))
    }

    fn run_profile_cookies_export(
        runner: &FakeRunner,
        store_root: &str,
        profile_id: &str,
        destination_path: &str,
        format: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(profile_cookies_export_with_runner(
            runner,
            store_root.to_string(),
            profile_id.to_string(),
            destination_path.to_string(),
            format.to_string(),
        ))
    }

    fn run_profile_cookies_replace(
        runner: &FakeRunner,
        store_root: &str,
        profile_id: &str,
        source_path: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(profile_cookies_replace_with_runner(
            runner,
            store_root.to_string(),
            profile_id.to_string(),
            source_path.to_string(),
        ))
    }

    fn run_profile_package_export(
        runner: &FakeRunner,
        store_root: &str,
        profile_id: &str,
        destination_path: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(profile_package_export_with_runner(
            runner,
            store_root.to_string(),
            profile_id.to_string(),
            destination_path.to_string(),
        ))
    }

    fn run_profile_package_import(
        runner: &FakeRunner,
        store_root: &str,
        source_path: &str,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(profile_package_import_with_runner(
            runner,
            store_root.to_string(),
            source_path.to_string(),
        ))
    }

    fn run_legacy_import(
        runner: &FakeRunner,
        store_root: &str,
        legacy_root: &str,
        items: Vec<LegacyImportItemParam>,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(legacy_import_profiles_with_runner(
            runner,
            store_root.to_string(),
            legacy_root.to_string(),
            items,
        ))
    }

    fn legacy_item(legacy_id: &str, target_name: &str) -> LegacyImportItemParam {
        LegacyImportItemParam {
            legacy_id: legacy_id.to_string(),
            target_name: target_name.to_string(),
        }
    }

    fn assert_request_params(request: &Value, method: &str, expected: &[(&str, Value)]) {
        assert_eq!(request["method"], method);
        let params = request["params"].as_object().expect("params object");
        assert_eq!(params.len(), expected.len());
        for (key, value) in expected {
            assert_eq!(params.get(*key), Some(value), "param {key} mismatch");
        }
    }

    #[test]
    fn sync_commands_send_their_method_and_the_store_root() {
        let cases: Vec<(&str, Box<dyn Fn(&FakeRunner) -> Result<SidecarCommandSuccess, SidecarCommandError>>)> = vec![
            (
                "sync.status",
                Box::new(|runner| {
                    tauri::async_runtime::block_on(sync_status_with_runner(runner, "/store".into()))
                }),
            ),
            (
                "sync.plan",
                Box::new(|runner| {
                    tauri::async_runtime::block_on(sync_plan_with_runner(runner, "/store".into()))
                }),
            ),
            (
                "sync.run",
                Box::new(|runner| {
                    tauri::async_runtime::block_on(sync_run_with_runner(runner, "/store".into()))
                }),
            ),
        ];

        for (method, call) in cases {
            let runner = FakeRunner::new(FakeMode::SuccessResult(json!({ "ok": true })));
            call(&runner).expect("command succeeds");
            let request = runner.last_request();

            assert_eq!(request["method"], method);
            assert_eq!(request["params"]["storeRoot"], "/store");
        }
    }

    #[test]
    fn sync_configure_passes_the_folder_and_label_through_unchanged() {
        let runner = FakeRunner::new(FakeMode::SuccessResult(json!({ "enabled": true })));

        tauri::async_runtime::block_on(sync_configure_with_runner(
            &runner,
            "/store".into(),
            true,
            Some("/home/user/Drive/ThePrivator".into()),
            Some("Laptop A".into()),
        ))
        .expect("configure succeeds");
        let request = runner.last_request();

        assert_eq!(request["method"], "sync.configure");
        assert_eq!(request["params"]["enabled"], true);
        assert_eq!(request["params"]["folder"], "/home/user/Drive/ThePrivator");
        assert_eq!(request["params"]["deviceLabel"], "Laptop A");
    }

    #[test]
    fn disabling_sync_sends_no_folder_rather_than_an_empty_one() {
        // An empty string is a value the sidecar would have to reject; absent is
        // the honest way to say "not changing the folder".
        let runner = FakeRunner::new(FakeMode::SuccessResult(json!({ "enabled": false })));

        tauri::async_runtime::block_on(sync_configure_with_runner(
            &runner,
            "/store".into(),
            false,
            None,
            None,
        ))
        .expect("configure succeeds");

        assert!(runner.last_request()["params"]["folder"].is_null());
    }

    #[test]
    fn sync_resolve_and_prepare_carry_their_profile_id() {
        let runner = FakeRunner::new(FakeMode::SuccessResult(json!({ "resolved": {} })));
        tauri::async_runtime::block_on(sync_resolve_with_runner(
            &runner,
            "/store".into(),
            "profile-1".into(),
            "keepRemote".into(),
        ))
        .expect("resolve succeeds");
        assert_eq!(runner.last_request()["params"]["profileId"], "profile-1");
        assert_eq!(runner.last_request()["params"]["resolution"], "keepRemote");

        let runner = FakeRunner::new(FakeMode::SuccessResult(json!({ "prepared": true })));
        tauri::async_runtime::block_on(sync_prepare_with_runner(
            &runner,
            "/store".into(),
            "profile-2".into(),
        ))
        .expect("prepare succeeds");
        assert_eq!(runner.last_request()["method"], "sync.prepare");
        assert_eq!(runner.last_request()["params"]["profileId"], "profile-2");
    }

    #[test]
    fn taking_over_a_lock_carries_the_typed_confirmation() {
        let runner = FakeRunner::new(FakeMode::SuccessResult(json!({ "released": true })));

        tauri::async_runtime::block_on(sync_force_release_lock_with_runner(
            &runner,
            "/store".into(),
            "profile-1".into(),
            "Laptop A".into(),
        ))
        .expect("release succeeds");
        let request = runner.last_request();

        assert_eq!(request["method"], "sync.lock.forceRelease");
        assert_eq!(request["params"]["confirmDeviceLabel"], "Laptop A");
    }

    #[test]
    fn a_sync_run_gets_a_far_longer_budget_than_a_status_check() {
        // A first run uploads or downloads every profile in the library, each a
        // whole browser directory; a status check only reads small files, and a
        // mistyped folder must not take minutes to report itself.
        let runner = FakeRunner::new(FakeMode::SuccessResult(json!({})));
        tauri::async_runtime::block_on(sync_run_with_runner(&runner, "/store".into())).expect("run");
        let run_budget = runner.last_timeout();

        let runner = FakeRunner::new(FakeMode::SuccessResult(json!({})));
        tauri::async_runtime::block_on(sync_status_with_runner(&runner, "/store".into())).expect("status");
        let status_budget = runner.last_timeout();

        assert!(run_budget >= Duration::from_secs(600));
        assert!(status_budget <= Duration::from_secs(30));
        assert!(run_budget > status_budget);
    }

    #[test]
    fn health_status_stderr_diagnostic_is_persisted_without_store_root_param() {
        let store = temp_diagnostics_store();
        let runner = FakeRunner::with_diagnostics(FakeMode::HealthSuccess, store.clone());

        let result = run_health(&runner).expect("health succeeds");
        let request = runner.last_request();
        let log_text = diagnostics_log_text(&store);

        assert_eq!(result.result["status"], "healthy");
        assert_eq!(request["method"], "health.status");
        assert!(request["params"]
            .as_object()
            .expect("params object")
            .is_empty());
        assert!(log_text.contains("\"event\":\"sidecar.request\""));
        assert!(log_text.contains("\"method\":\"health.status\""));
        assert!(log_text.contains("\"requestId\":\"bridge-"));
        assert!(!log_text.contains("storeRoot"));
    }

    #[test]
    fn typed_sidecar_error_stderr_is_persisted_and_lookupable_by_detail_ref() {
        let store = temp_diagnostics_store();
        let runner = FakeRunner::with_diagnostics(
            FakeMode::TypedError {
                code: "DIAGNOSTIC_FAILURE",
                message: "Diagnostic failure requested.",
                detail_ref: "sidecar-diagnostic-detail",
            },
            store.clone(),
        );

        let error = run_diagnostic_failure(&runner).expect_err("diagnostic failure surfaces");
        let lookup = store.lookup(&error.detail_ref);

        assert_eq!(error.code, "DIAGNOSTIC_FAILURE");
        assert_eq!(error.detail_ref, "sidecar-diagnostic-detail");
        assert!(lookup.found);
        assert_eq!(lookup.entries.len(), 1);
        assert_eq!(
            lookup.entries[0]["source"],
            crate::diagnostics::DIAGNOSTIC_SOURCE_PYTHON
        );
        assert_eq!(lookup.entries[0]["event"], "sidecar.request");
        assert_eq!(lookup.entries[0]["method"], "diagnostics.fail");
        assert_eq!(lookup.entries[0]["errorCode"], "DIAGNOSTIC_FAILURE");
        assert_eq!(
            lookup.log_path.as_deref(),
            Some(crate::diagnostics::DIAGNOSTIC_RELATIVE_LOG_PATH)
        );
    }

    #[test]
    fn runner_failures_are_persisted_by_visible_bridge_detail_ref() {
        let cases = [
            (
                SidecarRunnerError::Configuration,
                SIDECAR_CONFIGURATION_ERROR,
            ),
            (SidecarRunnerError::Unavailable, SIDECAR_UNAVAILABLE),
            (SidecarRunnerError::Timeout, SIDECAR_TIMEOUT),
            (SidecarRunnerError::Io, SIDECAR_PROCESS_ERROR),
        ];

        for (runner_error, expected_code) in cases {
            let store = temp_diagnostics_store();
            let runner = FakeRunner::with_diagnostics(
                FakeMode::RunnerError(runner_error.clone()),
                store.clone(),
            );

            let error = run_health(&runner).expect_err("runner error surfaces");
            let lookup = store.lookup(&error.detail_ref);

            assert_eq!(error.code, expected_code);
            assert!(error.detail_ref.starts_with("bridge-"));
            assert!(lookup.found, "missing lookup for {}", expected_code);
            assert_eq!(
                lookup.entries[0]["source"],
                crate::diagnostics::DIAGNOSTIC_SOURCE_RUST
            );
            assert_eq!(lookup.entries[0]["event"], "sidecar.bridge_failure");
            assert_eq!(lookup.entries[0]["method"], "health.status");
            assert_eq!(lookup.entries[0]["errorCode"], expected_code);
            assert_eq!(lookup.entries[0]["detailRef"], error.detail_ref);
            assert_eq!(lookup.entries[0]["stdoutLines"], 0);
            assert_eq!(lookup.entries[0]["stderrLines"], 0);
        }
    }

    #[test]
    fn protocol_failures_are_persisted_with_line_counts_and_without_output_bodies() {
        let store = temp_diagnostics_store();
        let runner = FakeRunner::with_diagnostics(
            FakeMode::Static(output(
                Some(0),
                "{\"ok\":true}\n{\"ok\":true}\nSECRET_STDOUT_BODY\n",
                "SECRET_STDERR_BODY /tmp/private\n",
            )),
            store.clone(),
        );

        let error = run_health(&runner).expect_err("multiple stdout lines surface");
        let lookup = store.lookup(&error.detail_ref);
        let log_text = diagnostics_log_text(&store);

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
        assert!(lookup.found);
        assert_eq!(lookup.entries[0]["event"], "sidecar.bridge_failure");
        assert_eq!(lookup.entries[0]["errorCode"], SIDECAR_PROTOCOL_ERROR);
        assert_eq!(lookup.entries[0]["stdoutLines"], 3);
        assert_eq!(lookup.entries[0]["stderrLines"], 1);
        assert!(!log_text.contains("SECRET_STDOUT_BODY"));
        assert!(!log_text.contains("SECRET_STDERR_BODY"));
        assert!(!log_text.contains("/tmp/private"));
    }

    #[test]
    fn health_request_uses_empty_params_and_returns_result() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        let result = run_health(&runner).expect("health succeeds");

        assert_eq!(result.result["status"], "healthy");
        assert_eq!(result.protocol_version, "1.0.0");
        assert_eq!(result.duration_ms, 1.25);
        let request = runner.last_request();
        assert_eq!(request["method"], "health.status");
        assert!(request["params"]
            .as_object()
            .expect("params object")
            .is_empty());
    }

    #[test]
    fn sidecar_typed_error_is_passed_through() {
        let runner = FakeRunner::new(FakeMode::TypedError {
            code: "DIAGNOSTIC_FAILURE",
            message: "Diagnostic failure requested.",
            detail_ref: "sidecar-test-detail",
        });

        let error = run_diagnostic_failure(&runner).expect_err("diagnostic failure surfaces");

        assert_eq!(error.code, "DIAGNOSTIC_FAILURE");
        assert_eq!(error.message, "Diagnostic failure requested.");
        assert!(error.recoverable);
        assert_eq!(error.detail_ref, "sidecar-test-detail");
        assert_eq!(runner.last_request()["method"], "diagnostics.fail");
    }

    #[test]
    fn identity_presets_list_request_uses_empty_params() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_identity_presets_list(&runner).expect("identity preset list reaches sidecar");

        let request = runner.last_request();
        assert_eq!(request["method"], "identity.presets.list");
        assert!(request["params"]
            .as_object()
            .expect("params object")
            .is_empty());
        assert_eq!(runner.last_timeout(), BRIDGE_TIMEOUT);
    }

    #[test]
    fn identity_surfaces_describe_request_uses_empty_params() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_identity_surfaces_describe(&runner).expect("identity surface describe reaches sidecar");

        let request = runner.last_request();
        assert_eq!(request["method"], "identity.surfaces.describe");
        assert!(request["params"]
            .as_object()
            .expect("params object")
            .is_empty());
        assert_eq!(runner.last_timeout(), BRIDGE_TIMEOUT);
    }

    #[test]
    fn identity_validate_request_passes_identity_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);
        let identity = json!({
            "identityVersion": 2,
            "label": "Real identity",
            "presetId": null,
            "browser": { "mode": "real" },
            "navigator": { "mode": "real" },
            "screen": { "mode": "real" },
            "locale": { "mode": "real" },
            "canvas": { "mode": "real" },
            "audio": { "mode": "real" },
            "webgl": { "mode": "real" },
            "webrtc": { "mode": "real", "policy": "real" },
            "geolocation": { "mode": "real", "permission": "prompt" },
            "mediaDevices": { "mode": "real" },
            "ports": { "mode": "real" }
        });

        run_identity_validate(&runner, identity.clone())
            .expect("identity validate reaches sidecar");

        let request = runner.last_request();
        assert_request_params(&request, "identity.validate", &[("identity", identity)]);
    }

    #[test]
    fn proxy_validate_request_passes_proxy_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);
        let proxy = json!({
            "proxyVersion": 1,
            "mode": "fixedServer",
            "protocol": "http",
            "host": "proxy.example.test",
            "port": 8080
        });

        run_proxy_validate(&runner, proxy.clone()).expect("proxy validate reaches sidecar");

        let request = runner.last_request();
        assert_request_params(&request, "proxy.validate", &[("proxy", proxy)]);
        assert_eq!(runner.last_timeout(), BRIDGE_TIMEOUT);
    }

    #[test]
    fn profiles_identity_apply_preset_injects_store_root_profile_id_and_preset_id_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_profiles_identity_apply_preset(
            &runner,
            "/app/data/root",
            "profile-id",
            "windows-10-chrome-120",
        )
        .expect("identity preset apply reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "profiles.identity.applyPreset",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("profileId", json!("profile-id")),
                ("presetId", json!("windows-10-chrome-120")),
            ],
        );
    }

    #[test]
    fn profiles_identity_update_injects_store_root_profile_id_and_identity_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);
        let identity = json!({ "identityVersion": 2, "label": "Custom" });

        run_profiles_identity_update(&runner, "/app/data/root", "profile-id", identity.clone())
            .expect("identity update reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "profiles.identity.update",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("profileId", json!("profile-id")),
                ("identity", identity),
            ],
        );
    }

    #[test]
    fn profiles_proxy_update_injects_store_root_profile_id_and_proxy_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);
        let proxy = json!({
            "proxyVersion": 1,
            "mode": "fixedServer",
            "protocol": "socks5",
            "host": "proxy.example.test",
            "port": 1080
        });

        run_profiles_proxy_update(&runner, "/app/data/root", "profile-id", proxy.clone())
            .expect("proxy update reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "profiles.proxy.update",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("profileId", json!("profile-id")),
                ("proxy", proxy),
            ],
        );
        let params = request["params"].as_object().expect("params object");
        assert_eq!(params.get("profile-store"), None);
        assert_eq!(runner.last_timeout(), BRIDGE_TIMEOUT);
    }

    #[test]
    fn profiles_proxy_check_injects_store_root_and_profile_id_only_with_proof_timeout() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_profiles_proxy_check(&runner, "/app/data/root", "profile-id")
            .expect("proxy check reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "profiles.proxy.check",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("profileId", json!("profile-id")),
            ],
        );
        let params = request["params"].as_object().expect("params object");
        assert_eq!(params.get("proxy"), None);
        assert_eq!(params.get("url"), None);
        assert_eq!(params.get("argv"), None);
        assert_eq!(params.get("checkerContent"), None);
        assert_eq!(runner.last_timeout(), PROXY_CHECK_TIMEOUT);
        assert!(runner.last_timeout() > BRIDGE_TIMEOUT);
    }

    #[test]
    fn profiles_proxy_check_error_is_passed_through_and_diagnostic_lookup_is_redacted() {
        let store = temp_diagnostics_store();
        let runner = FakeRunner::with_diagnostics(
            FakeMode::TypedError {
                code: "PROXY_PROOF_FAILED",
                message: "Proxy check proof could not be completed.",
                detail_ref: "sidecar-proxy-check-detail",
            },
            store.clone(),
        );

        let error = run_profiles_proxy_check(&runner, "/app/data/root", "profile-id")
            .expect_err("proxy check error surfaces");
        let lookup = store.lookup(&error.detail_ref);
        let log_text = diagnostics_log_text(&store);

        assert_eq!(error.code, "PROXY_PROOF_FAILED");
        assert_eq!(error.message, "Proxy check proof could not be completed.");
        assert!(error.recoverable);
        assert_eq!(error.detail_ref, "sidecar-proxy-check-detail");
        assert!(lookup.found);
        assert_eq!(lookup.entries[0]["method"], "profiles.proxy.check");
        assert_eq!(lookup.entries[0]["errorCode"], "PROXY_PROOF_FAILED");
        assert!(!log_text.contains("/app/data/root"));
        assert!(!log_text.contains("--proxy-server"));
        assert!(!log_text.contains("credentials"));
    }

    #[test]
    fn profiles_proxy_check_timeout_maps_to_timeout_error_with_proof_budget() {
        let runner = FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Timeout));

        let error = run_profiles_proxy_check(&runner, "/app/data/root", "profile-id")
            .expect_err("proxy check timeout surfaces");

        assert_eq!(error.code, SIDECAR_TIMEOUT);
        assert!(error.detail_ref.starts_with("bridge-"));
        assert_eq!(runner.last_request()["method"], "profiles.proxy.check");
        assert_eq!(runner.last_timeout(), PROXY_CHECK_TIMEOUT);
    }

    #[test]
    fn profiles_proxy_check_malformed_stdout_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::Static(output(Some(0), "not json\n", "")));

        let error = run_profiles_proxy_check(&runner, "/app/data/root", "profile-id")
            .expect_err("proxy check malformed stdout surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
        assert!(error.detail_ref.starts_with("bridge-"));
        assert_eq!(runner.last_request()["method"], "profiles.proxy.check");
    }

    #[test]
    fn identity_warning_payloads_pass_through_success_envelopes() {
        let runner = FakeRunner::new(FakeMode::SuccessResult(json!({
            "identityVersion": 2,
            "identity": { "identityVersion": 2, "label": "Suspicious" },
            "warnings": [
                {
                    "code": "IDENTITY_UNUSUAL_CPU",
                    "message": "Hardware concurrency is valid but uncommon for desktop Chromium.",
                    "surface": "navigator",
                    "path": "navigator.hardwareConcurrency"
                }
            ]
        })));

        let result = run_identity_validate(&runner, json!({ "identityVersion": 2 }))
            .expect("identity validate warnings pass through");

        assert_eq!(result.result["warnings"][0]["code"], "IDENTITY_UNUSUAL_CPU");
        assert_eq!(runner.last_request()["method"], "identity.validate");
    }

    #[test]
    fn identity_typed_error_is_passed_through() {
        let runner = FakeRunner::new(FakeMode::TypedError {
            code: "IDENTITY_INVALID",
            message: "Identity payload must be a JSON object.",
            detail_ref: "identity-invalid-detail",
        });

        let error = run_identity_validate(&runner, json!("not-an-object"))
            .expect_err("identity invalid error surfaces");

        assert_eq!(error.code, "IDENTITY_INVALID");
        assert_eq!(error.message, "Identity payload must be a JSON object.");
        assert!(error.recoverable);
        assert_eq!(error.detail_ref, "identity-invalid-detail");
        assert_eq!(runner.last_request()["method"], "identity.validate");
    }

    #[test]
    fn proxy_validate_error_is_passed_through_and_diagnostic_lookup_is_redacted() {
        let store = temp_diagnostics_store();
        let runner = FakeRunner::with_diagnostics(
            FakeMode::TypedError {
                code: "PROXY_INVALID",
                message: "Proxy configuration is invalid.",
                detail_ref: "sidecar-proxy-invalid-detail",
            },
            store.clone(),
        );
        let proxy = json!({
            "proxyVersion": 1,
            "mode": "fixedServer",
            "protocol": "http",
            "host": "proxy.example.test",
            "port": 8080,
            "credentials": {
                "username": "proxy-user-should-not-leak",
                "password": "proxy-pass-should-not-leak"
            }
        });

        let error = run_proxy_validate(&runner, proxy).expect_err("proxy invalid error surfaces");
        let lookup = store.lookup(&error.detail_ref);
        let log_text = diagnostics_log_text(&store);

        assert_eq!(error.code, "PROXY_INVALID");
        assert_eq!(error.message, "Proxy configuration is invalid.");
        assert!(error.recoverable);
        assert_eq!(error.detail_ref, "sidecar-proxy-invalid-detail");
        assert!(lookup.found);
        assert_eq!(lookup.entries[0]["method"], "proxy.validate");
        assert_eq!(lookup.entries[0]["errorCode"], "PROXY_INVALID");
        assert!(!log_text.contains("proxy-user-should-not-leak"));
        assert!(!log_text.contains("proxy-pass-should-not-leak"));
        assert!(!log_text.contains("credentials"));
    }

    #[test]
    fn profiles_proxy_update_error_is_passed_through_and_diagnostic_lookup_is_redacted() {
        let store = temp_diagnostics_store();
        let runner = FakeRunner::with_diagnostics(
            FakeMode::TypedError {
                code: "PROXY_UNSUPPORTED_MODE",
                message: "Proxy mode is not supported.",
                detail_ref: "sidecar-proxy-update-detail",
            },
            store.clone(),
        );
        let proxy = json!({
            "proxyVersion": 1,
            "mode": "fixedServer",
            "protocol": "http",
            "host": "proxy.example.test",
            "port": 8080,
            "credentials": {
                "username": "proxy-user-should-not-leak",
                "password": "proxy-pass-should-not-leak"
            }
        });

        let error = run_profiles_proxy_update(&runner, "/app/data/root", "profile-id", proxy)
            .expect_err("proxy update error surfaces");
        let lookup = store.lookup(&error.detail_ref);
        let log_text = diagnostics_log_text(&store);

        assert_eq!(error.code, "PROXY_UNSUPPORTED_MODE");
        assert_eq!(error.message, "Proxy mode is not supported.");
        assert!(error.recoverable);
        assert_eq!(error.detail_ref, "sidecar-proxy-update-detail");
        assert!(lookup.found);
        assert_eq!(lookup.entries[0]["method"], "profiles.proxy.update");
        assert_eq!(lookup.entries[0]["errorCode"], "PROXY_UNSUPPORTED_MODE");
        assert!(!log_text.contains("/app/data/root"));
        assert!(!log_text.contains("proxy-user-should-not-leak"));
        assert!(!log_text.contains("proxy-pass-should-not-leak"));
        assert!(!log_text.contains("credentials"));
    }

    #[test]
    fn proxy_malformed_stdout_maps_to_protocol_error_with_bridge_detail_ref() {
        let runner = FakeRunner::new(FakeMode::Static(output(Some(0), "not json\n", "")));

        let error = run_proxy_validate(&runner, json!({ "proxyVersion": 1 }))
            .expect_err("proxy malformed stdout surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
        assert!(error.detail_ref.starts_with("bridge-"));
        assert_eq!(runner.last_request()["method"], "proxy.validate");
    }

    #[test]
    fn identity_mismatched_request_id_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::MismatchedId);

        let error = run_identity_presets_list(&runner)
            .expect_err("identity mismatched id surfaces as protocol error");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
        assert_eq!(runner.last_request()["method"], "identity.presets.list");
    }

    #[test]
    fn profile_list_request_injects_only_store_root() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_profiles_list(&runner, "/app/data/root").expect("profile list succeeds");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "profiles.list",
            &[("storeRoot", json!("/app/data/root"))],
        );
    }

    #[test]
    fn profile_create_request_injects_store_root_and_name_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_profiles_create(&runner, "/app/data/root", "").expect("profile create reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "profiles.create",
            &[("storeRoot", json!("/app/data/root")), ("name", json!(""))],
        );
    }

    #[test]
    fn profile_update_request_injects_store_root_id_and_name_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_profiles_update(&runner, "/app/data/root", "", "Renamed")
            .expect("profile update reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "profiles.update",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("id", json!("")),
                ("name", json!("Renamed")),
            ],
        );
    }

    #[test]
    fn profile_delete_request_injects_store_root_and_id_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_profiles_delete(&runner, "/app/data/root", "profile-id")
            .expect("profile delete reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "profiles.delete",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("id", json!("profile-id")),
            ],
        );
    }

    #[test]
    fn chromium_status_request_injects_only_store_root() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_chromium_status(&runner, "/app/data/root").expect("chromium status reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "chromium.status",
            &[("storeRoot", json!("/app/data/root"))],
        );
    }

    #[test]
    fn chromium_launch_request_injects_store_root_and_profile_id_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_chromium_launch(&runner, "/app/data/root", "profile-id")
            .expect("chromium launch reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "chromium.launch",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("profileId", json!("profile-id")),
            ],
        );
        assert_eq!(runner.last_timeout(), CHROMIUM_LAUNCH_TIMEOUT);
        assert!(runner.last_timeout() > BRIDGE_TIMEOUT);
    }

    #[test]
    fn chromium_stop_request_injects_store_root_and_profile_id_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_chromium_stop(&runner, "/app/data/root", "profile-id")
            .expect("chromium stop reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "chromium.stop",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("profileId", json!("profile-id")),
            ],
        );
    }

    #[test]
    fn chromium_stop_budget_exceeds_the_python_graceful_plus_forced_wait() {
        // Python allows 3s graceful then 2s forced. Under the generic bridge
        // budget the worst case was exactly 5s with nothing left for spawning
        // the sidecar, so a browser ignoring SIGTERM timed out every time.
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_chromium_stop(&runner, "/app/data/root", "profile-id")
            .expect("chromium stop reaches sidecar");

        assert_eq!(runner.last_timeout(), CHROMIUM_STOP_TIMEOUT);
        assert!(runner.last_timeout() > BRIDGE_TIMEOUT);
        assert!(runner.last_timeout() >= Duration::from_secs(10));
    }

    #[test]
    fn identity_audit_collect_budget_covers_a_full_checker_walk() {
        // Launch, CDP discovery, then nine remote checker pages one at a time.
        // Measured runs take 40-90s; the previous launch-sized budget reported a
        // bridge error while the sidecar kept working.
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_identity_audit_collect(&runner, "/app/data/root", "profile-id")
            .expect("audit collect reaches sidecar");

        assert_eq!(runner.last_timeout(), IDENTITY_AUDIT_COLLECT_TIMEOUT);
        assert!(runner.last_timeout() > CHROMIUM_LAUNCH_TIMEOUT);
        assert!(runner.last_timeout() >= Duration::from_secs(90));
    }

    #[test]
    fn identity_audit_plan_request_injects_store_root_and_profile_id_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_identity_audit_plan(&runner, "/app/data/root", "profile-id")
            .expect("audit plan reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "identity.audit.plan",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("profileId", json!("profile-id")),
            ],
        );
        assert_eq!(runner.last_timeout(), BRIDGE_TIMEOUT);
    }

    #[test]
    fn cookie_bot_requests_keep_normal_short_command_budget() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);
        tauri::async_runtime::block_on(cookie_bot_with_runner(
            &runner, "start", json!({"storeRoot": "/app/data/root", "profileId": "profile-id", "config": {"maxPages": 2}}),
        )).expect("start returns job immediately");
        assert_request_params(&runner.last_request(), "cookieBot.start", &[
            ("storeRoot", json!("/app/data/root")), ("profileId", json!("profile-id")), ("config", json!({"maxPages": 2})),
        ]);
        assert_eq!(runner.last_timeout(), BRIDGE_TIMEOUT);
        for action in ["defaults", "status", "cancel"] {
            tauri::async_runtime::block_on(cookie_bot_with_runner(&runner, action, json!({}))).unwrap();
            assert_eq!(runner.last_timeout(), BRIDGE_TIMEOUT);
        }
    }

    #[test]
    fn identity_audit_open_request_injects_store_root_profile_id_and_page_id_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_identity_audit_open(
            &runner,
            "/app/data/root",
            "profile-id",
            "browserleaks-webgl",
        )
        .expect("audit open reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "identity.audit.open",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("profileId", json!("profile-id")),
                ("pageId", json!("browserleaks-webgl")),
            ],
        );
        assert_eq!(runner.last_timeout(), CHROMIUM_LAUNCH_TIMEOUT);
        assert!(runner.last_timeout() > BRIDGE_TIMEOUT);
    }

    #[test]
    fn identity_audit_errors_are_passed_through() {
        let plan_runner = FakeRunner::new(FakeMode::TypedError {
            code: "PROFILE_NOT_FOUND",
            message: "Profile not found.",
            detail_ref: "sidecar-audit-plan-detail",
        });
        let open_runner = FakeRunner::new(FakeMode::TypedError {
            code: "IDENTITY_AUDIT_PAGE_NOT_FOUND",
            message: "Audit page was not found.",
            detail_ref: "sidecar-audit-open-detail",
        });

        let plan_error = run_identity_audit_plan(&plan_runner, "/app/data/root", "missing-profile")
            .expect_err("audit plan error surfaces");
        let open_error =
            run_identity_audit_open(&open_runner, "/app/data/root", "profile-id", "missing-page")
                .expect_err("audit open error surfaces");

        assert_eq!(plan_error.code, "PROFILE_NOT_FOUND");
        assert_eq!(plan_error.message, "Profile not found.");
        assert!(plan_error.recoverable);
        assert_eq!(plan_error.detail_ref, "sidecar-audit-plan-detail");
        assert_eq!(plan_runner.last_request()["method"], "identity.audit.plan");
        assert_eq!(open_error.code, "IDENTITY_AUDIT_PAGE_NOT_FOUND");
        assert_eq!(open_error.message, "Audit page was not found.");
        assert!(open_error.recoverable);
        assert_eq!(open_error.detail_ref, "sidecar-audit-open-detail");
        assert_eq!(open_runner.last_request()["method"], "identity.audit.open");
    }

    #[test]
    fn identity_audit_open_timeout_uses_chromium_launch_budget() {
        let runner = FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Timeout));

        let error = run_identity_audit_open(
            &runner,
            "/app/data/root",
            "profile-id",
            "browserleaks-webgl",
        )
        .expect_err("audit open timeout surfaces");

        assert_eq!(error.code, SIDECAR_TIMEOUT);
        assert!(error.detail_ref.starts_with("bridge-"));
        assert_eq!(runner.last_request()["method"], "identity.audit.open");
        assert_eq!(runner.last_timeout(), CHROMIUM_LAUNCH_TIMEOUT);
    }

    #[test]
    fn identity_audit_malformed_stdout_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::Static(output(Some(0), "not json\n", "")));

        let error = run_identity_audit_plan(&runner, "/app/data/root", "profile-id")
            .expect_err("audit malformed stdout surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
        assert_eq!(runner.last_request()["method"], "identity.audit.plan");
    }

    #[test]
    fn profile_cookies_export_injects_store_root_profile_path_and_format_only() {
        for format in [COOKIE_FORMAT_THEPRIVATOR_JSON] {
            let runner = FakeRunner::new(FakeMode::HealthSuccess);

            run_profile_cookies_export(
                &runner,
                "/app/data/root",
                "profile-id",
                "/selected/private/export.cookies",
                format,
            )
            .expect("cookie export reaches sidecar");

            let request = runner.last_request();
            assert_request_params(
                &request,
                "portability.cookies.export",
                &[
                    ("storeRoot", json!("/app/data/root")),
                    ("profileId", json!("profile-id")),
                    ("destinationPath", json!("/selected/private/export.cookies")),
                    ("format", json!(format)),
                ],
            );
            assert_eq!(runner.last_timeout(), COOKIE_PORTABILITY_TIMEOUT);
            assert!(runner.last_timeout() > BRIDGE_TIMEOUT);
            assert!(runner.last_timeout() < LEGACY_IMPORT_TIMEOUT);
        }
    }

    #[test]
    fn profile_cookies_replace_injects_store_root_profile_and_source_path_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_profile_cookies_replace(
            &runner,
            "/app/data/root",
            "profile-id",
            "/selected/private/import.cookies.json",
        )
        .expect("cookie replace reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "portability.cookies.replace",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("profileId", json!("profile-id")),
                ("sourcePath", json!("/selected/private/import.cookies.json")),
            ],
        );
        assert_eq!(runner.last_timeout(), COOKIE_PORTABILITY_TIMEOUT);
        assert!(runner.last_timeout() > BRIDGE_TIMEOUT);
        assert!(runner.last_timeout() < LEGACY_IMPORT_TIMEOUT);
    }

    #[test]
    fn profile_cookies_busy_error_is_passed_through() {
        let runner = FakeRunner::new(FakeMode::TypedError {
            code: "PORTABILITY_PROFILE_BUSY",
            message: "Profile must be stopped before cookie portability.",
            detail_ref: "sidecar-portability-busy-detail",
        });

        let error = run_profile_cookies_export(
            &runner,
            "/app/data/root",
            "profile-id",
            "/selected/private/export.cookies",
            COOKIE_FORMAT_THEPRIVATOR_JSON,
        )
        .expect_err("cookie busy error surfaces");

        assert_eq!(error.code, "PORTABILITY_PROFILE_BUSY");
        assert_eq!(
            error.message,
            "Profile must be stopped before cookie portability."
        );
        assert!(error.recoverable);
        assert_eq!(error.detail_ref, "sidecar-portability-busy-detail");
        assert_eq!(
            runner.last_request()["method"],
            "portability.cookies.export"
        );
    }

    #[test]
    fn profile_cookies_malformed_inputs_are_rejected_before_dispatch() {
        let export_cases = [
            (
                "empty profile id",
                " ",
                "/selected/private/export.cookies",
                COOKIE_FORMAT_THEPRIVATOR_JSON,
                "profile id",
            ),
            (
                "empty destination path",
                "profile-id",
                "  ",
                COOKIE_FORMAT_THEPRIVATOR_JSON,
                "destination path",
            ),
            (
                "empty format",
                "profile-id",
                "/selected/private/export.cookies",
                "",
                "format",
            ),
            (
                "unsupported format",
                "profile-id",
                "/selected/private/export.cookies",
                "chromium-sqlite",
                "unsupported",
            ),
            (
                "removed Netscape export",
                "profile-id",
                "/selected/private/export.cookies",
                "netscape",
                "unsupported",
            ),
        ];

        for (label, profile_id, destination_path, format, message_fragment) in export_cases {
            let runner = FakeRunner::new(FakeMode::HealthSuccess);
            let error = run_profile_cookies_export(
                &runner,
                "/app/data/root",
                profile_id,
                destination_path,
                format,
            )
            .expect_err(label);

            assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR, "{label}");
            assert!(error.message.contains(message_fragment), "{label}");
            assert!(error.detail_ref.starts_with("bridge-"), "{label}");
            assert!(!error.message.contains("/app/data/root"), "{label}");
            assert!(!error.message.contains("/selected/private"), "{label}");
            assert!(!error.message.contains("chromium-sqlite"), "{label}");
            assert!(!runner.was_called(), "{label} dispatched unexpectedly");
        }

        let runner = FakeRunner::new(FakeMode::HealthSuccess);
        let error = run_profile_cookies_replace(&runner, "/app/data/root", "profile-id", " ")
            .expect_err("empty source path is rejected");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
        assert!(error.message.contains("source path"));
        assert!(!error.message.contains("/app/data/root"));
        assert!(!runner.was_called());
    }

    #[test]
    fn profile_cookies_timeout_and_unavailable_errors_use_safe_bridge_messages() {
        let timeout_runner = FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Timeout));
        let timeout_error = run_profile_cookies_export(
            &timeout_runner,
            "/app/data/root",
            "profile-id",
            "/selected/private/export.cookies",
            COOKIE_FORMAT_THEPRIVATOR_JSON,
        )
        .expect_err("cookie export timeout surfaces");

        assert_eq!(timeout_error.code, SIDECAR_TIMEOUT);
        assert!(timeout_error.detail_ref.starts_with("bridge-"));
        assert_eq!(
            timeout_runner.last_request()["method"],
            "portability.cookies.export"
        );
        assert_eq!(timeout_runner.last_timeout(), COOKIE_PORTABILITY_TIMEOUT);
        assert!(!timeout_error.message.contains("/app/data/root"));
        assert!(!timeout_error.message.contains("/selected/private"));

        let unavailable_runner =
            FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Unavailable));
        let unavailable_error = run_profile_cookies_replace(
            &unavailable_runner,
            "/app/data/root",
            "profile-id",
            "/selected/private/import.cookies.json",
        )
        .expect_err("cookie replace missing sidecar surfaces");

        assert_eq!(unavailable_error.code, SIDECAR_UNAVAILABLE);
        assert!(unavailable_error.message.contains("sidecar:build"));
        assert_eq!(
            unavailable_runner.last_request()["method"],
            "portability.cookies.replace"
        );
        assert!(!unavailable_error.message.contains("/app/data/root"));
        assert!(!unavailable_error.message.contains("/selected/private"));
    }

    #[test]
    fn profile_cookies_malformed_sidecar_response_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::Static(output(Some(0), "not json\n", "")));

        let error = run_profile_cookies_replace(
            &runner,
            "/app/data/root",
            "profile-id",
            "/selected/private/import.cookies.json",
        )
        .expect_err("cookie replace malformed stdout surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
        assert_eq!(
            runner.last_request()["method"],
            "portability.cookies.replace"
        );
        assert_eq!(runner.last_timeout(), COOKIE_PORTABILITY_TIMEOUT);
        assert!(!error.message.contains("/selected/private"));
    }

    #[test]
    fn profile_package_export_injects_store_root_profile_and_destination_only_with_opaque_path() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);
        let selected_path = "/selected/private/../opaque-export.tpkg";

        run_profile_package_export(&runner, "/app/data/root", "profile-id", selected_path)
            .expect("package export reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "portability.profile_package.export",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("profileId", json!("profile-id")),
                ("destinationPath", json!(selected_path)),
            ],
        );
        assert_eq!(runner.last_timeout(), PROFILE_PACKAGE_TIMEOUT);
        assert!(runner.last_timeout() > COOKIE_PORTABILITY_TIMEOUT);
    }

    #[test]
    fn profile_package_import_injects_store_root_and_source_only_with_opaque_path() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);
        let selected_path = "/selected/private/../opaque-import.tpkg";

        run_profile_package_import(&runner, "/app/data/root", selected_path)
            .expect("package import reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "portability.profile_package.import",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("sourcePath", json!(selected_path)),
            ],
        );
        assert_eq!(runner.last_timeout(), PROFILE_PACKAGE_TIMEOUT);
        assert!(runner.last_timeout() > COOKIE_PORTABILITY_TIMEOUT);
    }

    #[test]
    fn profile_package_typed_busy_and_package_errors_are_passed_through() {
        let busy_runner = FakeRunner::new(FakeMode::TypedError {
            code: "PORTABILITY_PROFILE_BUSY",
            message: "Profile must be stopped before package export.",
            detail_ref: "profile-package-busy-detail",
        });

        let busy_error = run_profile_package_export(
            &busy_runner,
            "/app/data/root",
            "profile-id",
            "/selected/private/export.tpkg",
        )
        .expect_err("package busy error surfaces");

        assert_eq!(busy_error.code, "PORTABILITY_PROFILE_BUSY");
        assert_eq!(
            busy_error.message,
            "Profile must be stopped before package export."
        );
        assert!(busy_error.recoverable);
        assert_eq!(busy_error.detail_ref, "profile-package-busy-detail");
        assert_eq!(
            busy_runner.last_request()["method"],
            "portability.profile_package.export"
        );

        for code in [
            "PORTABILITY_PACKAGE_INVALID",
            "PORTABILITY_PACKAGE_READ_FAILED",
            "PORTABILITY_PACKAGE_WRITE_FAILED",
        ] {
            let package_runner = FakeRunner::new(FakeMode::TypedError {
                code,
                message: "The selected ThePrivator package could not be processed.",
                detail_ref: "profile-package-detail",
            });

            let package_error = run_profile_package_import(
                &package_runner,
                "/app/data/root",
                "/selected/private/import.tpkg",
            )
            .expect_err("package typed error surfaces");

            assert_eq!(package_error.code, code);
            assert_eq!(
                package_error.message,
                "The selected ThePrivator package could not be processed."
            );
            assert!(package_error.recoverable);
            assert_eq!(package_error.detail_ref, "profile-package-detail");
            assert_eq!(
                package_runner.last_request()["method"],
                "portability.profile_package.import"
            );
        }
    }

    #[test]
    fn profile_package_malformed_inputs_are_rejected_before_dispatch() {
        let selected_destination = "/selected/private/export.tpkg".to_string();
        let too_long = "x".repeat(MAX_PROFILE_PACKAGE_ARGUMENT_CHARS + 1);
        let export_cases = vec![
            (
                "empty profile id",
                " ".to_string(),
                selected_destination.clone(),
                "profile id",
            ),
            (
                "empty destination path",
                "profile-id".to_string(),
                "  ".to_string(),
                "destination path",
            ),
            (
                "too long profile id",
                too_long.clone(),
                selected_destination.clone(),
                "exceeds",
            ),
            (
                "too long destination path",
                "profile-id".to_string(),
                too_long.clone(),
                "exceeds",
            ),
        ];

        for (label, profile_id, destination_path, message_fragment) in export_cases {
            let runner = FakeRunner::new(FakeMode::HealthSuccess);
            let error = run_profile_package_export(
                &runner,
                "/app/data/root",
                &profile_id,
                &destination_path,
            )
            .expect_err(label);

            assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR, "{label}");
            assert!(error.message.contains(message_fragment), "{label}");
            assert!(error.detail_ref.starts_with("bridge-"), "{label}");
            assert!(!error.message.contains("/app/data/root"), "{label}");
            assert!(!error.message.contains("/selected/private"), "{label}");
            assert!(!error.message.contains(&too_long), "{label}");
            assert!(!runner.was_called(), "{label} dispatched unexpectedly");
        }

        for (label, source_path, message_fragment) in [
            ("empty source path", " ".to_string(), "source path"),
            ("too long source path", too_long.clone(), "exceeds"),
        ] {
            let runner = FakeRunner::new(FakeMode::HealthSuccess);
            let error = run_profile_package_import(&runner, "/app/data/root", &source_path)
                .expect_err(label);

            assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR, "{label}");
            assert!(error.message.contains(message_fragment), "{label}");
            assert!(!error.message.contains("/app/data/root"), "{label}");
            assert!(!error.message.contains(&too_long), "{label}");
            assert!(!runner.was_called(), "{label} dispatched unexpectedly");
        }
    }

    #[test]
    fn profile_package_timeout_unavailable_and_protocol_errors_use_safe_messages() {
        let timeout_runner = FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Timeout));
        let timeout_error = run_profile_package_export(
            &timeout_runner,
            "/app/data/root",
            "profile-id",
            "/selected/private/export.tpkg",
        )
        .expect_err("package export timeout surfaces");

        assert_eq!(timeout_error.code, SIDECAR_TIMEOUT);
        assert!(timeout_error.detail_ref.starts_with("bridge-"));
        assert_eq!(
            timeout_runner.last_request()["method"],
            "portability.profile_package.export"
        );
        assert_eq!(timeout_runner.last_timeout(), PROFILE_PACKAGE_TIMEOUT);
        assert!(!timeout_error.message.contains("/app/data/root"));
        assert!(!timeout_error.message.contains("/selected/private"));

        let unavailable_runner =
            FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Unavailable));
        let unavailable_error = run_profile_package_import(
            &unavailable_runner,
            "/app/data/root",
            "/selected/private/import.tpkg",
        )
        .expect_err("package import missing sidecar surfaces");

        assert_eq!(unavailable_error.code, SIDECAR_UNAVAILABLE);
        assert!(unavailable_error.message.contains("sidecar:build"));
        assert_eq!(
            unavailable_runner.last_request()["method"],
            "portability.profile_package.import"
        );
        assert!(!unavailable_error.message.contains("/app/data/root"));
        assert!(!unavailable_error.message.contains("/selected/private"));

        let protocol_runner = FakeRunner::new(FakeMode::Static(output(Some(0), "not json\n", "")));
        let protocol_error = run_profile_package_import(
            &protocol_runner,
            "/app/data/root",
            "/selected/private/import.tpkg",
        )
        .expect_err("package malformed stdout surfaces");

        assert_eq!(protocol_error.code, SIDECAR_PROTOCOL_ERROR);
        assert_eq!(
            protocol_runner.last_request()["method"],
            "portability.profile_package.import"
        );
        assert_eq!(protocol_runner.last_timeout(), PROFILE_PACKAGE_TIMEOUT);
        assert!(!protocol_error.message.contains("/app/data/root"));
        assert!(!protocol_error.message.contains("/selected/private"));
    }

    #[test]
    fn profile_package_bridge_failure_diagnostics_redact_selected_paths() {
        let store = temp_diagnostics_store();
        let runner = FakeRunner::with_diagnostics(
            FakeMode::Static(output(Some(0), "not json\n", "")),
            store.clone(),
        );

        let error = run_profile_package_export(
            &runner,
            "/app/data/root",
            "profile-id",
            "/selected/private/export.tpkg",
        )
        .expect_err("malformed package response persists bridge diagnostic");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
        let log = diagnostics_log_text(&store);
        assert!(log.contains("sidecar.bridge_failure"));
        assert!(log.contains("portability.profile_package.export"));
        assert!(!log.contains("/app/data/root"));
        assert!(!log.contains("/selected/private"));
        assert!(!log.contains("export.tpkg"));
    }

    #[test]
    fn profile_package_capability_posture_remains_minimal() {
        let capability_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json");
        let capability: Value = serde_json::from_str(
            &fs::read_to_string(capability_path).expect("default capability is readable"),
        )
        .expect("default capability is valid JSON");
        let permissions = capability["permissions"]
            .as_array()
            .expect("permissions are an array");
        let string_permissions: Vec<&str> = permissions.iter().filter_map(Value::as_str).collect();

        assert_eq!(
            string_permissions,
            vec![
                "core:default",
                "core:window:default",
                "core:window:allow-start-dragging",
                "core:window:allow-minimize",
                "core:window:allow-toggle-maximize",
                "core:window:allow-close",
                "dialog:allow-open",
                "dialog:allow-save",
            ]
        );

        let spawn_permissions: Vec<&Value> = permissions
            .iter()
            .filter(|permission| permission.get("identifier") == Some(&json!("shell:allow-spawn")))
            .collect();
        assert_eq!(spawn_permissions.len(), 1);
        let allow = spawn_permissions[0]["allow"]
            .as_array()
            .expect("shell spawn allowlist is an array");
        assert_eq!(allow.len(), 1);
        assert_eq!(allow[0]["name"], SIDECAR_EXTERNAL_BIN);
        assert_eq!(allow[0]["sidecar"], true);

        let serialized = serde_json::to_string(&capability).expect("capability serializes");
        for forbidden in [
            "fs:",
            "opener:",
            "shell:allow-open",
            "shell:allow-execute",
            "shell:allow-kill",
            "dialog:default",
            "dialog:allow-message",
            "dialog:allow-ask",
            "dialog:allow-confirm",
            "dialog:allow-pick-folder",
            "core:window:allow-create",
            "core:window:allow-set-title",
            "core:window:allow-set-size",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "capability unexpectedly contains {forbidden}"
            );
        }
    }

    #[test]
    fn legacy_scan_request_injects_store_root_and_legacy_root_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);

        run_legacy_scan(&runner, "/app/data/root", "/legacy/root")
            .expect("legacy scan reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "legacy.scan",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("legacyRoot", json!("/legacy/root")),
            ],
        );
        assert_eq!(runner.last_timeout(), BRIDGE_TIMEOUT);
    }

    #[test]
    fn legacy_import_request_injects_selection_only_and_uses_longer_timeout() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);
        let items = vec![legacy_item("legacy-one", "Imported One")];

        run_legacy_import(&runner, "/app/data/root", "/legacy/root", items)
            .expect("legacy import reaches sidecar");

        let request = runner.last_request();
        assert_request_params(
            &request,
            "legacy.import",
            &[
                ("storeRoot", json!("/app/data/root")),
                ("legacyRoot", json!("/legacy/root")),
                (
                    "items",
                    json!([{ "legacyId": "legacy-one", "targetName": "Imported One" }]),
                ),
            ],
        );
        assert!(
            runner.last_timeout() > BRIDGE_TIMEOUT,
            "legacy.import should retain a longer copy timeout",
        );
    }

    #[test]
    fn legacy_sidecar_errors_are_passed_through() {
        let runner = FakeRunner::new(FakeMode::TypedError {
            code: "LEGACY_ROOT_INVALID",
            message: "Legacy root must be an existing directory.",
            detail_ref: "legacy-root-detail",
        });

        let error = run_legacy_scan(&runner, "/app/data/root", "/missing/legacy")
            .expect_err("legacy root error surfaces");

        assert_eq!(error.code, "LEGACY_ROOT_INVALID");
        assert_eq!(error.message, "Legacy root must be an existing directory.");
        assert!(error.recoverable);
        assert_eq!(error.detail_ref, "legacy-root-detail");
        assert_eq!(runner.last_request()["method"], "legacy.scan");
    }

    #[test]
    fn legacy_import_timeout_maps_to_timeout_error() {
        let runner = FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Timeout));

        let error = run_legacy_import(
            &runner,
            "/app/data/root",
            "/legacy/root",
            vec![legacy_item("legacy-one", "Imported One")],
        )
        .expect_err("legacy import timeout surfaces");

        assert_eq!(error.code, SIDECAR_TIMEOUT);
        assert!(error.detail_ref.starts_with("bridge-"));
        assert_eq!(runner.last_request()["method"], "legacy.import");
        assert!(runner.last_timeout() > BRIDGE_TIMEOUT);
    }

    #[test]
    fn legacy_malformed_stdout_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::Static(output(Some(0), "not json\n", "")));

        let error = run_legacy_import(
            &runner,
            "/app/data/root",
            "/legacy/root",
            vec![legacy_item("legacy-one", "Imported One")],
        )
        .expect_err("legacy malformed stdout surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
        assert_eq!(runner.last_request()["method"], "legacy.import");
    }

    #[test]
    fn chromium_lifecycle_error_is_passed_through() {
        let runner = FakeRunner::new(FakeMode::TypedError {
            code: "CHROMIUM_EXECUTABLE_NOT_FOUND",
            message: "Chromium executable was not found.",
            detail_ref: "chromium-executable-detail",
        });

        let error = run_chromium_launch(&runner, "/app/data/root", "profile-id")
            .expect_err("chromium lifecycle error surfaces");

        assert_eq!(error.code, "CHROMIUM_EXECUTABLE_NOT_FOUND");
        assert_eq!(error.message, "Chromium executable was not found.");
        assert!(error.recoverable);
        assert_eq!(error.detail_ref, "chromium-executable-detail");
        assert_eq!(runner.last_request()["method"], "chromium.launch");
    }

    #[test]
    fn chromium_launch_timeout_maps_to_timeout_error_with_identity_apply_budget() {
        let runner = FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Timeout));

        let error = run_chromium_launch(&runner, "/app/data/root", "profile-id")
            .expect_err("chromium launch timeout surfaces");

        assert_eq!(error.code, SIDECAR_TIMEOUT);
        assert!(error.detail_ref.starts_with("bridge-"));
        assert_eq!(runner.last_request()["method"], "chromium.launch");
        assert_eq!(runner.last_timeout(), CHROMIUM_LAUNCH_TIMEOUT);
    }

    #[test]
    fn chromium_bridge_timeout_maps_to_timeout_error() {
        let runner = FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Timeout));

        let error =
            run_chromium_status(&runner, "/app/data/root").expect_err("chromium timeout surfaces");

        assert_eq!(error.code, SIDECAR_TIMEOUT);
        assert!(error.detail_ref.starts_with("bridge-"));
        assert_eq!(runner.last_request()["method"], "chromium.status");
    }

    #[test]
    fn chromium_malformed_stdout_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::Static(output(Some(0), "not json\n", "")));

        let error = run_chromium_stop(&runner, "/app/data/root", "profile-id")
            .expect_err("chromium malformed stdout surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
        assert_eq!(runner.last_request()["method"], "chromium.stop");
    }

    #[test]
    fn profile_duplicate_name_error_is_passed_through() {
        let runner = FakeRunner::new(FakeMode::TypedError {
            code: "PROFILE_DUPLICATE_NAME",
            message: "Profile name already exists.",
            detail_ref: "profile-duplicate-detail",
        });

        let error = run_profiles_create(&runner, "/app/data/root", "research")
            .expect_err("duplicate profile error surfaces");

        assert_eq!(error.code, "PROFILE_DUPLICATE_NAME");
        assert_eq!(error.message, "Profile name already exists.");
        assert!(error.recoverable);
        assert_eq!(error.detail_ref, "profile-duplicate-detail");
        assert_eq!(runner.last_request()["method"], "profiles.create");
    }

    #[test]
    fn profile_invalid_name_error_is_passed_through() {
        let runner = FakeRunner::new(FakeMode::TypedError {
            code: "PROFILE_INVALID_NAME",
            message: "Profile name is invalid.",
            detail_ref: "profile-invalid-detail",
        });

        let error = run_profiles_create(&runner, "/app/data/root", "bad/name")
            .expect_err("invalid profile error surfaces");

        assert_eq!(error.code, "PROFILE_INVALID_NAME");
        assert_eq!(error.message, "Profile name is invalid.");
        assert!(error.recoverable);
        assert_eq!(error.detail_ref, "profile-invalid-detail");
    }

    #[test]
    fn profile_timeout_maps_to_timeout_error() {
        let runner = FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Timeout));

        let error = run_profiles_create(&runner, "/app/data/root", "Research")
            .expect_err("profile timeout surfaces");

        assert_eq!(error.code, SIDECAR_TIMEOUT);
        assert!(error.detail_ref.starts_with("bridge-"));
        assert_eq!(runner.last_request()["method"], "profiles.create");
    }

    #[test]
    fn profile_malformed_stdout_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::Static(output(Some(0), "not json\n", "")));

        let error = run_profiles_list(&runner, "/app/data/root")
            .expect_err("profile malformed stdout surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
        assert_eq!(runner.last_request()["method"], "profiles.list");
    }

    #[test]
    fn profile_mismatched_request_id_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::MismatchedId);

        let error = run_profiles_delete(&runner, "/app/data/root", "profile-id")
            .expect_err("profile mismatched id surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
        assert_eq!(runner.last_request()["method"], "profiles.delete");
    }

    #[test]
    fn profile_store_root_resolution_maps_failures_to_configuration_error() {
        let error = profile_store_root_from_app_data_dir::<()>(Err(()))
            .expect_err("profile store resolution failure surfaces");

        assert_eq!(error.code, SIDECAR_CONFIGURATION_ERROR);
        assert!(error.recoverable);
        assert!(error.detail_ref.starts_with("bridge-"));
        assert!(!error.message.contains("/"));
    }

    #[test]
    fn profile_store_root_resolution_injects_app_data_root_for_sidecar_layout() {
        let root = profile_store_root_from_app_data_dir::<()>(Ok(PathBuf::from("/app/data/root")))
            .expect("app data root resolves");

        assert_eq!(root, "/app/data/root");
    }

    #[test]
    fn nonzero_exit_maps_to_process_error() {
        let runner = FakeRunner::new(FakeMode::Static(output(
            Some(2),
            "",
            "{\"event\":\"sidecar.request\",\"status\":\"error\"}\n",
        )));

        let error = run_health(&runner).expect_err("nonzero exit surfaces");

        assert_eq!(error.code, SIDECAR_PROCESS_ERROR);
        assert!(error.recoverable);
        assert!(error.detail_ref.starts_with("bridge-"));
    }

    #[test]
    fn timeout_maps_to_timeout_error() {
        let runner = FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Timeout));

        let error = run_health(&runner).expect_err("timeout surfaces");

        assert_eq!(error.code, SIDECAR_TIMEOUT);
        assert!(error.message.contains("timeout"));
    }

    #[test]
    fn missing_binary_maps_to_unavailable() {
        let runner = FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Unavailable));

        let error = run_health(&runner).expect_err("missing binary surfaces");

        assert_eq!(error.code, SIDECAR_UNAVAILABLE);
        assert!(error.message.contains("sidecar:build"));
    }

    #[test]
    fn shell_configuration_error_names_logical_sidecar() {
        let runner = FakeRunner::new(FakeMode::RunnerError(SidecarRunnerError::Configuration));

        let error = run_health(&runner).expect_err("config error surfaces");

        assert_eq!(error.code, SIDECAR_CONFIGURATION_ERROR);
        assert!(error.message.contains(SIDECAR_LOGICAL_NAME));
        assert!(error.message.contains(SIDECAR_EXTERNAL_BIN));
    }

    #[test]
    fn invalid_json_stdout_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::Static(output(Some(0), "not json\n", "")));

        let error = run_health(&runner).expect_err("invalid json surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
    }

    #[test]
    fn multiple_stdout_lines_map_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::Static(output(
            Some(0),
            "{\"ok\":true}\n{\"ok\":true}\n",
            "",
        )));

        let error = run_health(&runner).expect_err("multiple lines surface");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
    }

    #[test]
    fn mismatched_request_id_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::MismatchedId);

        let error = run_health(&runner).expect_err("mismatched id surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
    }

    #[test]
    fn missing_ok_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::MissingOk);

        let error = run_health(&runner).expect_err("missing ok surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
    }

    #[test]
    fn missing_success_result_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::MissingResult);

        let error = run_health(&runner).expect_err("missing result surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
    }

    #[test]
    fn missing_error_object_maps_to_protocol_error() {
        let runner = FakeRunner::new(FakeMode::MissingError);

        let error = run_health(&runner).expect_err("missing error surfaces");

        assert_eq!(error.code, SIDECAR_PROTOCOL_ERROR);
    }
}
