use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    process::{Command as StdCommand, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri_plugin_shell::ShellExt;

pub const SIDECAR_LOGICAL_NAME: &str = "theprivator-sidecar";
pub const SIDECAR_EXTERNAL_BIN: &str = "binaries/theprivator-sidecar";
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(5);

const SIDECAR_CONFIGURATION_ERROR: &str = "SIDECAR_CONFIGURATION_ERROR";
const SIDECAR_PROCESS_ERROR: &str = "SIDECAR_PROCESS_ERROR";
const SIDECAR_PROTOCOL_ERROR: &str = "SIDECAR_PROTOCOL_ERROR";
const SIDECAR_TIMEOUT: &str = "SIDECAR_TIMEOUT";
const SIDECAR_UNAVAILABLE: &str = "SIDECAR_UNAVAILABLE";

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);
static DETAIL_COUNTER: AtomicU64 = AtomicU64::new(1);

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
}

pub struct TauriSidecarRunner {
    app: tauri::AppHandle,
}

impl TauriSidecarRunner {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
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

async fn invoke_fixed_method<R: SidecarRunner>(
    runner: &R,
    method: &'static str,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let request_id = next_request_id();
    let request = json!({
        "id": request_id,
        "method": method,
        "params": {},
    });
    let request_line = serde_json::to_string(&request).map_err(|_| {
        bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "Failed to encode the sidecar request envelope.",
        )
    })?;

    let output = runner
        .run(request_line, BRIDGE_TIMEOUT)
        .await
        .map_err(|error| map_runner_error(error, method, &request_id))?;

    parse_process_output(output, method, &request_id)
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
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    if output.exit_code != Some(0) {
        let error = bridge_error(
            SIDECAR_PROCESS_ERROR,
            "The Python sidecar process exited before returning a successful response.",
        );
        log_bridge_failure(method, request_id, &error, output.exit_code, &output);
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
        log_bridge_failure(method, request_id, &error, output.exit_code, &output);
        return Err(error);
    }

    let envelope: SidecarEnvelope = serde_json::from_str(stdout_lines[0]).map_err(|_| {
        let error = bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "The Python sidecar returned malformed JSON.",
        );
        log_bridge_failure(method, request_id, &error, output.exit_code, &output);
        error
    })?;

    validate_envelope(envelope, method, request_id, &output)
}

fn validate_envelope(
    envelope: SidecarEnvelope,
    method: &str,
    request_id: &str,
    output: &SidecarProcessOutput,
) -> Result<SidecarCommandSuccess, SidecarCommandError> {
    let expected_id = Value::String(request_id.to_string());
    if envelope.id.as_ref() != Some(&expected_id) {
        let error = bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "The Python sidecar response id did not match the bridge request id.",
        );
        log_bridge_failure(method, request_id, &error, output.exit_code, output);
        return Err(error);
    }

    let Some(ok) = envelope.ok else {
        let error = bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "The Python sidecar response is missing ok.",
        );
        log_bridge_failure(method, request_id, &error, output.exit_code, output);
        return Err(error);
    };

    let Some(protocol_version) = envelope.protocol_version else {
        let error = bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "The Python sidecar response is missing protocolVersion.",
        );
        log_bridge_failure(method, request_id, &error, output.exit_code, output);
        return Err(error);
    };

    let Some(duration_ms) = envelope.duration_ms else {
        let error = bridge_error(
            SIDECAR_PROTOCOL_ERROR,
            "The Python sidecar response is missing durationMs.",
        );
        log_bridge_failure(method, request_id, &error, output.exit_code, output);
        return Err(error);
    };

    if ok {
        let Some(result) = envelope.result else {
            let error = bridge_error(
                SIDECAR_PROTOCOL_ERROR,
                "The Python sidecar success response is missing result.",
            );
            log_bridge_failure(method, request_id, &error, output.exit_code, output);
            return Err(error);
        };

        if !result.is_object() {
            let error = bridge_error(
                SIDECAR_PROTOCOL_ERROR,
                "The Python sidecar success result must be an object.",
            );
            log_bridge_failure(method, request_id, &error, output.exit_code, output);
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
            log_bridge_failure(method, request_id, &error, output.exit_code, output);
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
    );
    mapped
}

fn bridge_error(code: &str, message: &str) -> SidecarCommandError {
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

fn log_bridge_failure(
    method: &str,
    request_id: &str,
    error: &SidecarCommandError,
    exit_code: Option<i32>,
    output: &SidecarProcessOutput,
) {
    let event = json!({
        "event": "sidecar.bridge_failure",
        "requestId": request_id,
        "method": method,
        "errorCode": error.code,
        "detailRef": error.detail_ref,
        "exitCode": exit_code,
        "stdoutLines": output.stdout.lines().filter(|line| !line.trim().is_empty()).count(),
        "stderrLines": output.stderr.lines().filter(|line| !line.trim().is_empty()).count(),
    });

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
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    enum FakeMode {
        HealthSuccess,
        TypedError,
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
    }

    impl FakeRunner {
        fn new(mode: FakeMode) -> Self {
            Self {
                mode,
                last_request: Arc::new(Mutex::new(None)),
            }
        }

        fn last_request(&self) -> Value {
            self.last_request
                .lock()
                .expect("last_request lock poisoned")
                .clone()
                .expect("runner was not called")
        }
    }

    #[async_trait]
    impl SidecarRunner for FakeRunner {
        async fn run(
            &self,
            request_line: String,
            _timeout: Duration,
        ) -> Result<SidecarProcessOutput, SidecarRunnerError> {
            let request: Value = serde_json::from_str(&request_line).expect("valid bridge request");
            *self
                .last_request
                .lock()
                .expect("last_request lock poisoned") = Some(request.clone());
            let request_id = request.get("id").cloned().unwrap_or(Value::Null);

            match &self.mode {
                FakeMode::HealthSuccess => Ok(output_with_stdout(json!({
                    "id": request_id,
                    "ok": true,
                    "protocolVersion": "1.0.0",
                    "durationMs": 1.25,
                    "result": { "status": "healthy" }
                }))),
                FakeMode::TypedError => Ok(output_with_stdout(json!({
                    "id": request_id,
                    "ok": false,
                    "protocolVersion": "1.0.0",
                    "durationMs": 1.5,
                    "error": {
                        "code": "DIAGNOSTIC_FAILURE",
                        "message": "Diagnostic failure requested.",
                        "recoverable": true,
                        "detailRef": "sidecar-test-detail"
                    }
                }))),
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
    }

    fn output_with_stdout(value: Value) -> SidecarProcessOutput {
        SidecarProcessOutput {
            exit_code: Some(0),
            stdout: format!("{value}\n"),
            stderr: "{\"event\":\"sidecar.request\"}\n".to_string(),
        }
    }

    fn output(exit_code: Option<i32>, stdout: &str, stderr: &str) -> SidecarProcessOutput {
        SidecarProcessOutput {
            exit_code,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
        }
    }

    fn run_health(runner: &FakeRunner) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(sidecar_health_with_runner(runner))
    }

    fn run_diagnostic_failure(
        runner: &FakeRunner,
    ) -> Result<SidecarCommandSuccess, SidecarCommandError> {
        tauri::async_runtime::block_on(sidecar_diagnostic_failure_with_runner(runner))
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
        let runner = FakeRunner::new(FakeMode::TypedError);

        let error = run_diagnostic_failure(&runner).expect_err("diagnostic failure surfaces");

        assert_eq!(error.code, "DIAGNOSTIC_FAILURE");
        assert_eq!(error.message, "Diagnostic failure requested.");
        assert!(error.recoverable);
        assert_eq!(error.detail_ref, "sidecar-test-detail");
        assert_eq!(runner.last_request()["method"], "diagnostics.fail");
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
