use crate::diagnostics::{DiagnosticStore, StderrPersistOutcome};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command as StdCommand, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
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
}

impl TauriSidecarRunner {
    pub fn new(app: tauri::AppHandle) -> Self {
        let diagnostics_store = DiagnosticStore::from_app_data_dir(app.path().app_data_dir()).ok();
        Self {
            app,
            diagnostics_store,
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
        let shell_command = self
            .app
            .shell()
            .sidecar(SIDECAR_LOGICAL_NAME)
            .map_err(|_| SidecarRunnerError::Configuration)?;
        let command: StdCommand = shell_command.into();

        tokio::task::spawn_blocking(move || run_sidecar_process(command, request_line, timeout))
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
pub async fn identity_validate(
    app: tauri::AppHandle,
    identity: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let runner = TauriSidecarRunner::new(app);
    identity_validate_with_runner(&runner, identity).await
}

#[tauri::command]
pub async fn profiles_identity_apply_preset(
    app: tauri::AppHandle,
    profile_id: String,
    preset_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    profiles_identity_apply_preset_with_runner(&runner, store_root, profile_id, preset_id).await
}

#[tauri::command]
pub async fn profiles_identity_update(
    app: tauri::AppHandle,
    profile_id: String,
    identity: Value,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    profiles_identity_update_with_runner(&runner, store_root, profile_id, identity).await
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
    let runner = TauriSidecarRunner::new(app);
    profiles_create_with_runner(&runner, store_root, name).await
}

#[tauri::command]
pub async fn profiles_update(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    profiles_update_with_runner(&runner, store_root, id, name).await
}

#[tauri::command]
pub async fn profiles_delete(
    app: tauri::AppHandle,
    id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    profiles_delete_with_runner(&runner, store_root, id).await
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
    let runner = TauriSidecarRunner::new(app);
    chromium_launch_with_runner(&runner, store_root, profile_id).await
}

#[tauri::command]
pub async fn chromium_stop(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let store_root = resolve_profile_store_root(&app)?;
    let runner = TauriSidecarRunner::new(app);
    chromium_stop_with_runner(&runner, store_root, profile_id).await
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
    let runner = TauriSidecarRunner::new(app);
    legacy_import_profiles_with_runner(&runner, store_root, legacy_root, items).await
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
    invoke_method_with_params(
        runner,
        "chromium.launch",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
        }),
    )
    .await
}

async fn chromium_stop_with_runner<R: SidecarRunner>(
    runner: &R,
    store_root: String,
    profile_id: String,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    invoke_method_with_params(
        runner,
        "chromium.stop",
        json!({
            "storeRoot": store_root,
            "profileId": profile_id,
        }),
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

fn run_sidecar_process(
    mut command: StdCommand,
    request_line: String,
    timeout: Duration,
) -> Result<SidecarProcessOutput, SidecarRunnerError> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|_| SidecarRunnerError::Unavailable)?;

    {
        let mut stdin = child.stdin.take().ok_or(SidecarRunnerError::Io)?;
        stdin
            .write_all(request_line.as_bytes())
            .map_err(|_| SidecarRunnerError::Io)?;
        stdin.write_all(b"\n").map_err(|_| SidecarRunnerError::Io)?;
    }

    let started = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|_| SidecarRunnerError::Io)? {
            Some(status) => break status,
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SidecarRunnerError::Timeout);
            }
            None => thread::sleep(Duration::from_millis(10)),
        }
    };

    let stdout = read_child_pipe(child.stdout.take())?;
    let stderr = read_child_pipe(child.stderr.take())?;

    Ok(SidecarProcessOutput {
        exit_code: status.code(),
        stdout,
        stderr,
    })
}

fn read_child_pipe<T: Read>(pipe: Option<T>) -> Result<String, SidecarRunnerError> {
    let Some(mut pipe) = pipe else {
        return Ok(String::new());
    };
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes)
        .map_err(|_| SidecarRunnerError::Io)?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
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

    fn run_identity_validate(
        runner: &FakeRunner,
        identity: Value,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(identity_validate_with_runner(runner, identity))
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
    fn identity_validate_request_passes_identity_only() {
        let runner = FakeRunner::new(FakeMode::HealthSuccess);
        let identity = json!({
            "identityVersion": 1,
            "label": "Real identity",
            "presetId": null,
            "browser": { "mode": "real" },
            "navigator": { "mode": "real" },
            "screen": { "mode": "real" },
            "locale": { "mode": "real" },
            "canvas": { "mode": "real" },
            "audio": { "mode": "real" },
            "webgl": { "mode": "real" },
            "webrtc": { "mode": "real", "policy": "real" }
        });

        run_identity_validate(&runner, identity.clone()).expect("identity validate reaches sidecar");

        let request = runner.last_request();
        assert_request_params(&request, "identity.validate", &[("identity", identity)]);
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
        let identity = json!({ "identityVersion": 1, "label": "Custom" });

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
    fn identity_warning_payloads_pass_through_success_envelopes() {
        let runner = FakeRunner::new(FakeMode::SuccessResult(json!({
            "identityVersion": 1,
            "identity": { "identityVersion": 1, "label": "Suspicious" },
            "warnings": [
                {
                    "code": "IDENTITY_UNUSUAL_CPU",
                    "message": "Hardware concurrency is valid but uncommon for desktop Chromium.",
                    "surface": "navigator",
                    "path": "navigator.hardwareConcurrency"
                }
            ]
        })));

        let result = run_identity_validate(&runner, json!({ "identityVersion": 1 }))
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
            "legacy.import should be the only command with a longer copy timeout",
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
