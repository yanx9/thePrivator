use crate::sidecar::{
    bridge_error, SidecarCommandError, SIDECAR_EXTERNAL_BIN, SIDECAR_LOGICAL_NAME,
};
use chrono::{SecondsFormat, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use serde_json::Value;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    io::{BufRead, BufReader},
    net::IpAddr,
    path::PathBuf,
    process::{Child, ChildStdout, Command as StdCommand, Stdio},
    sync::{mpsc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

const AUTOMATION_API_HOST: &str = "127.0.0.1";
const AUTOMATION_API_PORT: u16 = 0;
const AUTOMATION_API_SCOPE: &str = "loopback";
const AUTOMATION_API_MODE_ARG: &str = "automation-api";
const READINESS_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const READINESS_MAX_BYTES: usize = 1024;

const ENV_HOST: &str = "THEPRIVATOR_AUTOMATION_API_HOST";
const ENV_PORT: &str = "THEPRIVATOR_AUTOMATION_API_PORT";
const ENV_STORE_ROOT: &str = "THEPRIVATOR_AUTOMATION_API_STORE_ROOT";
const ENV_TOKEN: &str = "THEPRIVATOR_AUTOMATION_API_TOKEN";

const AUTOMATION_API_CONFIGURATION_ERROR: &str = "AUTOMATION_API_CONFIGURATION_ERROR";
const AUTOMATION_API_SPAWN_FAILED: &str = "AUTOMATION_API_SPAWN_FAILED";
const AUTOMATION_API_START_TIMEOUT: &str = "AUTOMATION_API_START_TIMEOUT";
const AUTOMATION_API_READINESS_MALFORMED: &str = "AUTOMATION_API_READINESS_MALFORMED";
const AUTOMATION_API_CHILD_EXITED: &str = "AUTOMATION_API_CHILD_EXITED";
const AUTOMATION_API_CHILD_STATUS_FAILED: &str = "AUTOMATION_API_CHILD_STATUS_FAILED";
const AUTOMATION_API_STOP_FAILED: &str = "AUTOMATION_API_STOP_FAILED";
const AUTOMATION_API_COPY_UNAVAILABLE: &str = "AUTOMATION_API_COPY_UNAVAILABLE";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AutomationApiLifecyclePhase {
    Stopped,
    Running,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationApiEndpointSnapshot {
    pub host: String,
    pub port: u16,
    pub url: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationApiProcessSnapshot {
    pub pid: u32,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationApiErrorSnapshot {
    pub code: String,
    pub message: String,
    pub phase: String,
    pub detail_ref: String,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationApiTimingSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readiness_duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_duration_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationApiStatusSnapshot {
    pub status: AutomationApiLifecyclePhase,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api: Option<AutomationApiEndpointSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<AutomationApiProcessSnapshot>,
    pub copy_available: bool,
    pub last_transition_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<AutomationApiErrorSnapshot>,
    pub timings: AutomationApiTimingSnapshot,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationApiCredentialCopy {
    pub token: String,
}

struct AutomationApiLifecycleState {
    phase: AutomationApiLifecyclePhase,
    child: Option<Box<dyn AutomationApiChild>>,
    credential: Option<String>,
    endpoint: Option<AutomationApiEndpointSnapshot>,
    process: Option<AutomationApiProcessSnapshot>,
    last_transition_at: String,
    last_error: Option<AutomationApiErrorSnapshot>,
    timings: AutomationApiTimingSnapshot,
}

impl AutomationApiLifecycleState {
    fn stopped() -> Self {
        Self {
            phase: AutomationApiLifecyclePhase::Stopped,
            child: None,
            credential: None,
            endpoint: None,
            process: None,
            last_transition_at: utc_now(),
            last_error: None,
            timings: AutomationApiTimingSnapshot::default(),
        }
    }

    fn snapshot(&self) -> AutomationApiStatusSnapshot {
        AutomationApiStatusSnapshot {
            status: self.phase.clone(),
            running: self.phase == AutomationApiLifecyclePhase::Running,
            api: self.endpoint.clone(),
            process: self.process.clone(),
            copy_available: self.phase == AutomationApiLifecyclePhase::Running
                && self.credential.is_some(),
            last_transition_at: self.last_transition_at.clone(),
            last_error: self.last_error.clone(),
            timings: self.timings.clone(),
        }
    }
}

pub struct AutomationApiSupervisor {
    state: Mutex<AutomationApiLifecycleState>,
}

impl AutomationApiSupervisor {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(AutomationApiLifecycleState::stopped()),
        }
    }

    fn lock_state(
        &self,
    ) -> Result<MutexGuard<'_, AutomationApiLifecycleState>, SidecarCommandError> {
        self.state.lock().map_err(|_| {
            bridge_error(
                AUTOMATION_API_CONFIGURATION_ERROR,
                "Automation API lifecycle state is unavailable.",
            )
        })
    }

    fn start_with_launcher<L: AutomationApiLauncher>(
        &self,
        launcher: &L,
        store_root: PathBuf,
    ) -> Result<AutomationApiStatusSnapshot, SidecarCommandError> {
        let mut state = self.lock_state()?;
        reconcile_child_locked(&mut state);
        if state.phase == AutomationApiLifecyclePhase::Running {
            return Ok(state.snapshot());
        }

        let started = Instant::now();
        let credential = generate_credential().map_err(|_| {
            let (snapshot, error) = lifecycle_error(
                AUTOMATION_API_CONFIGURATION_ERROR,
                "Automation API credential generation failed.",
                "configuration",
                Some(duration_ms(started.elapsed())),
            );
            state.last_error = Some(snapshot);
            state.last_transition_at = utc_now();
            error
        })?;

        let launch_config = AutomationApiLaunchConfig {
            host: AUTOMATION_API_HOST.to_string(),
            port: AUTOMATION_API_PORT,
            store_root,
            credential: credential.clone(),
        };

        let mut child = match launcher.launch(launch_config) {
            Ok(child) => child,
            Err(error) => {
                let (code, message) = match error {
                    AutomationApiLaunchError::Configuration => (
                        AUTOMATION_API_CONFIGURATION_ERROR,
                        format!(
                            "Automation API sidecar configuration failed for logical name '{SIDECAR_LOGICAL_NAME}'. Ensure bundle.externalBin includes '{SIDECAR_EXTERNAL_BIN}'."
                        ),
                    ),
                    AutomationApiLaunchError::Spawn => (
                        AUTOMATION_API_SPAWN_FAILED,
                        "Automation API process could not be started.".to_string(),
                    ),
                };
                let (snapshot, command_error) = lifecycle_error(
                    code,
                    &message,
                    "spawn",
                    Some(duration_ms(started.elapsed())),
                );
                state.credential = None;
                state.child = None;
                state.endpoint = None;
                state.process = None;
                state.phase = AutomationApiLifecyclePhase::Stopped;
                state.last_transition_at = utc_now();
                state.last_error = Some(snapshot);
                return Err(command_error);
            }
        };

        let pid = child.process_id();
        let readiness_line = match child.read_readiness_line(READINESS_TIMEOUT) {
            Ok(line) => line,
            Err(error) => {
                let (code, message) = match error {
                    AutomationApiReadinessError::Timeout => (
                        AUTOMATION_API_START_TIMEOUT,
                        "Automation API process did not emit readiness before the timeout.",
                    ),
                    AutomationApiReadinessError::Malformed => (
                        AUTOMATION_API_READINESS_MALFORMED,
                        "Automation API process emitted malformed readiness.",
                    ),
                    AutomationApiReadinessError::ChildExited => (
                        AUTOMATION_API_CHILD_EXITED,
                        "Automation API process exited before readiness.",
                    ),
                };
                let _ = child.kill();
                let _ = wait_until_stopped(child.as_mut(), STOP_TIMEOUT);
                let (snapshot, command_error) = lifecycle_error(
                    code,
                    message,
                    "readiness",
                    Some(duration_ms(started.elapsed())),
                );
                state.credential = None;
                state.child = None;
                state.endpoint = None;
                state.process = None;
                state.phase = AutomationApiLifecyclePhase::Stopped;
                state.last_transition_at = utc_now();
                state.last_error = Some(snapshot);
                state.timings.readiness_duration_ms = Some(duration_ms(started.elapsed()));
                return Err(command_error);
            }
        };

        let readiness = match parse_readiness(&readiness_line) {
            Ok(readiness) => readiness,
            Err(()) => {
                let _ = child.kill();
                let _ = wait_until_stopped(child.as_mut(), STOP_TIMEOUT);
                let (snapshot, command_error) = lifecycle_error(
                    AUTOMATION_API_READINESS_MALFORMED,
                    "Automation API process emitted unsafe readiness.",
                    "readiness",
                    Some(duration_ms(started.elapsed())),
                );
                state.credential = None;
                state.child = None;
                state.endpoint = None;
                state.process = None;
                state.phase = AutomationApiLifecyclePhase::Stopped;
                state.last_transition_at = utc_now();
                state.last_error = Some(snapshot);
                state.timings.readiness_duration_ms = Some(duration_ms(started.elapsed()));
                return Err(command_error);
            }
        };

        let now = utc_now();
        state.phase = AutomationApiLifecyclePhase::Running;
        state.credential = Some(credential);
        state.endpoint = Some(AutomationApiEndpointSnapshot {
            host: readiness.host.clone(),
            port: readiness.port,
            url: endpoint_url(&readiness.host, readiness.port),
            scope: AUTOMATION_API_SCOPE.to_string(),
        });
        state.process = Some(AutomationApiProcessSnapshot {
            pid,
            started_at: now.clone(),
        });
        state.child = Some(child);
        state.last_transition_at = now;
        state.last_error = None;
        state.timings.readiness_duration_ms = Some(duration_ms(started.elapsed()));
        Ok(state.snapshot())
    }

    fn status(&self) -> Result<AutomationApiStatusSnapshot, SidecarCommandError> {
        let mut state = self.lock_state()?;
        reconcile_child_locked(&mut state);
        Ok(state.snapshot())
    }

    fn copy_credential(&self) -> Result<AutomationApiCredentialCopy, SidecarCommandError> {
        let mut state = self.lock_state()?;
        reconcile_child_locked(&mut state);
        if state.phase != AutomationApiLifecyclePhase::Running {
            let (snapshot, error) = lifecycle_error(
                AUTOMATION_API_COPY_UNAVAILABLE,
                "Automation API credential is unavailable because the API is stopped.",
                "copyCredential",
                None,
            );
            state.last_error = Some(snapshot);
            return Err(error);
        }

        match state.credential.clone() {
            Some(token) => Ok(AutomationApiCredentialCopy { token }),
            None => {
                let (snapshot, error) = lifecycle_error(
                    AUTOMATION_API_COPY_UNAVAILABLE,
                    "Automation API credential is unavailable for the running process.",
                    "copyCredential",
                    None,
                );
                state.last_error = Some(snapshot);
                Err(error)
            }
        }
    }

    fn stop(&self) -> Result<AutomationApiStatusSnapshot, SidecarCommandError> {
        let mut state = self.lock_state()?;
        reconcile_child_locked(&mut state);
        if state.phase == AutomationApiLifecyclePhase::Stopped {
            return Ok(state.snapshot());
        }

        let stopped_at = Instant::now();
        let Some(mut child) = state.child.take() else {
            state.credential = None;
            state.endpoint = None;
            state.process = None;
            state.phase = AutomationApiLifecyclePhase::Stopped;
            state.last_transition_at = utc_now();
            state.timings.stop_duration_ms = Some(0.0);
            return Ok(state.snapshot());
        };

        // Clear the app-visible credential before attempting process shutdown so a
        // failed stop can be retried without re-exposing the old bearer material.
        state.credential = None;
        let stop_result = stop_child(child.as_mut(), STOP_TIMEOUT);
        match stop_result {
            Ok(()) => {
                state.endpoint = None;
                state.process = None;
                state.child = None;
                state.phase = AutomationApiLifecyclePhase::Stopped;
                state.last_transition_at = utc_now();
                state.last_error = None;
                state.timings.stop_duration_ms = Some(duration_ms(stopped_at.elapsed()));
                Ok(state.snapshot())
            }
            Err(()) => {
                state.child = Some(child);
                state.phase = AutomationApiLifecyclePhase::Running;
                let (snapshot, error) = lifecycle_error(
                    AUTOMATION_API_STOP_FAILED,
                    "Automation API process could not be stopped safely.",
                    "stop",
                    Some(duration_ms(stopped_at.elapsed())),
                );
                state.last_transition_at = utc_now();
                state.last_error = Some(snapshot);
                state.timings.stop_duration_ms = Some(duration_ms(stopped_at.elapsed()));
                Err(error)
            }
        }
    }
}

impl Default for AutomationApiSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for AutomationApiSupervisor {
    fn drop(&mut self) {
        if let Ok(state) = self.state.get_mut() {
            state.credential = None;
            if let Some(mut child) = state.child.take() {
                let _ = child.kill();
                let _ = wait_until_stopped(child.as_mut(), STOP_TIMEOUT);
            }
            state.endpoint = None;
            state.process = None;
            state.phase = AutomationApiLifecyclePhase::Stopped;
            state.last_transition_at = utc_now();
        }
    }
}

#[tauri::command]
pub fn automation_api_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AutomationApiSupervisor>,
) -> Result<AutomationApiStatusSnapshot, SidecarCommandError> {
    let store_root = app.path().app_data_dir().map_err(|_| {
        bridge_error(
            AUTOMATION_API_CONFIGURATION_ERROR,
            "The Tauri app data directory could not be resolved for the automation API.",
        )
    })?;
    let launcher = TauriAutomationApiLauncher::new(app);
    state.start_with_launcher(&launcher, store_root)
}

#[tauri::command]
pub fn automation_api_status(
    state: tauri::State<'_, AutomationApiSupervisor>,
) -> Result<AutomationApiStatusSnapshot, SidecarCommandError> {
    state.status()
}

#[tauri::command]
pub fn automation_api_copy_token(
    state: tauri::State<'_, AutomationApiSupervisor>,
) -> Result<AutomationApiCredentialCopy, SidecarCommandError> {
    state.copy_credential()
}

#[tauri::command]
pub fn automation_api_stop(
    state: tauri::State<'_, AutomationApiSupervisor>,
) -> Result<AutomationApiStatusSnapshot, SidecarCommandError> {
    state.stop()
}

struct AutomationApiLaunchConfig {
    host: String,
    port: u16,
    store_root: PathBuf,
    credential: String,
}

trait AutomationApiLauncher: Send + Sync {
    fn launch(
        &self,
        config: AutomationApiLaunchConfig,
    ) -> Result<Box<dyn AutomationApiChild>, AutomationApiLaunchError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AutomationApiLaunchError {
    Configuration,
    Spawn,
}

trait AutomationApiChild: Send {
    fn process_id(&self) -> u32;
    fn read_readiness_line(
        &mut self,
        timeout: Duration,
    ) -> Result<String, AutomationApiReadinessError>;
    fn try_wait(&mut self) -> Result<Option<i32>, ()>;
    fn kill(&mut self) -> Result<(), ()>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AutomationApiReadinessError {
    Timeout,
    Malformed,
    ChildExited,
}

struct TauriAutomationApiLauncher {
    app: tauri::AppHandle,
}

impl TauriAutomationApiLauncher {
    fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl AutomationApiLauncher for TauriAutomationApiLauncher {
    fn launch(
        &self,
        config: AutomationApiLaunchConfig,
    ) -> Result<Box<dyn AutomationApiChild>, AutomationApiLaunchError> {
        let shell_command = self
            .app
            .shell()
            .sidecar(SIDECAR_LOGICAL_NAME)
            .map_err(|_| AutomationApiLaunchError::Configuration)?;
        let mut command: StdCommand = shell_command.into();
        let store_root = config
            .store_root
            .into_os_string()
            .into_string()
            .map_err(|_| AutomationApiLaunchError::Configuration)?;

        command
            .arg(AUTOMATION_API_MODE_ARG)
            .env(ENV_HOST, config.host)
            .env(ENV_PORT, config.port.to_string())
            .env(ENV_STORE_ROOT, store_root)
            .env(ENV_TOKEN, config.credential)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            // PyInstaller sidecars can leave the serving process alive after the
            // bootloader parent exits. Put the sidecar tree in its own process
            // group so Stop API and supervisor Drop can revoke the whole local
            // listener authority instead of only the immediate child handle.
            command.process_group(0);
        }

        let mut child = command
            .spawn()
            .map_err(|_| AutomationApiLaunchError::Spawn)?;
        let stdout = child.stdout.take().ok_or(AutomationApiLaunchError::Spawn)?;
        Ok(Box::new(StdAutomationApiChild {
            child,
            stdout: Some(stdout),
        }))
    }
}

struct StdAutomationApiChild {
    child: Child,
    stdout: Option<ChildStdout>,
}

impl AutomationApiChild for StdAutomationApiChild {
    fn process_id(&self) -> u32 {
        self.child.id()
    }

    fn read_readiness_line(
        &mut self,
        timeout: Duration,
    ) -> Result<String, AutomationApiReadinessError> {
        let stdout = self
            .stdout
            .take()
            .ok_or(AutomationApiReadinessError::Malformed)?;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let result = reader.read_line(&mut line).map(|bytes| (bytes, line));
            let _ = tx.send(result);
        });

        match rx.recv_timeout(timeout) {
            Ok(Ok((0, _))) => Err(AutomationApiReadinessError::ChildExited),
            Ok(Ok((_, line))) => Ok(line),
            Ok(Err(_)) => Err(AutomationApiReadinessError::ChildExited),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(AutomationApiReadinessError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(AutomationApiReadinessError::ChildExited)
            }
        }
    }

    fn try_wait(&mut self) -> Result<Option<i32>, ()> {
        self.child
            .try_wait()
            .map(|status| status.map(|status| status.code().unwrap_or(-1)))
            .map_err(|_| ())
    }

    fn kill(&mut self) -> Result<(), ()> {
        #[cfg(unix)]
        {
            let pgid = self.child.id() as libc::pid_t;
            let group_kill = unsafe { libc::kill(-pgid, libc::SIGKILL) };
            let child_kill = self.child.kill();
            if group_kill == 0 || child_kill.is_ok() {
                return Ok(());
            }
            return Err(());
        }
        #[cfg(not(unix))]
        {
            self.child.kill().map_err(|_| ())
        }
    }
}

struct ReadinessPayload {
    host: String,
    port: u16,
}

fn parse_readiness(line: &str) -> Result<ReadinessPayload, ()> {
    let trimmed = line.trim();
    if trimmed.is_empty()
        || trimmed.len() > READINESS_MAX_BYTES
        || contains_forbidden_marker(trimmed)
    {
        return Err(());
    }

    let value: Value = serde_json::from_str(trimmed).map_err(|_| ())?;
    let object = value.as_object().ok_or(())?;
    if object.len() != 3
        || !object.contains_key("host")
        || !object.contains_key("port")
        || !object.contains_key("version")
    {
        return Err(());
    }

    let host = object
        .get("host")
        .and_then(Value::as_str)
        .filter(|host| is_loopback_host(host))
        .ok_or(())?
        .to_string();
    let port = object
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .ok_or(())? as u16;
    let version = object
        .get("version")
        .and_then(Value::as_str)
        .filter(|version| is_safe_version(version))
        .ok_or(())?;
    if version.is_empty() {
        return Err(());
    }

    Ok(ReadinessPayload { host, port })
}

fn contains_forbidden_marker(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    [
        "authorization",
        "bearer",
        "credential",
        "debug",
        "devtools",
        "store_root",
        "storeroot",
        "token",
        "stdout",
        "stderr",
        "argv",
        "args",
        "env",
        "ws://",
        "wss://",
        "cdp://",
        "--remote-debugging-port",
    ]
    .iter()
    .any(|marker| lowered.contains(marker))
}

fn is_loopback_host(host: &str) -> bool {
    if host.contains('/') || host.contains('\\') || host.contains(':') && host.contains(']') {
        return false;
    }
    host.parse::<IpAddr>()
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

fn is_safe_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
}

fn endpoint_url(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("http://[{host}]:{port}")
    } else {
        format!("http://{host}:{port}")
    }
}

fn reconcile_child_locked(state: &mut AutomationApiLifecycleState) {
    let Some(child) = state.child.as_mut() else {
        return;
    };

    match child.try_wait() {
        Ok(Some(_exit_code)) => {
            state.child = None;
            state.credential = None;
            state.endpoint = None;
            state.process = None;
            state.phase = AutomationApiLifecyclePhase::Stopped;
            state.last_transition_at = utc_now();
            let (snapshot, _) = lifecycle_error(
                AUTOMATION_API_CHILD_EXITED,
                "Automation API process exited unexpectedly.",
                "childExit",
                None,
            );
            state.last_error = Some(snapshot);
        }
        Ok(None) => {}
        Err(()) => {
            let (snapshot, _) = lifecycle_error(
                AUTOMATION_API_CHILD_STATUS_FAILED,
                "Automation API process status could not be inspected.",
                "status",
                None,
            );
            state.last_error = Some(snapshot);
        }
    }
}

fn stop_child(child: &mut dyn AutomationApiChild, timeout: Duration) -> Result<(), ()> {
    let already_exited = child.try_wait()?.is_some();
    let kill_result = child.kill();
    if already_exited {
        return Ok(());
    }
    if kill_result.is_err() && child.try_wait()?.is_none() {
        return Err(());
    }
    wait_until_stopped(child, timeout)
}

fn wait_until_stopped(child: &mut dyn AutomationApiChild, timeout: Duration) -> Result<(), ()> {
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            return if child.try_wait()?.is_some() {
                Ok(())
            } else {
                Err(())
            };
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn lifecycle_error(
    code: &str,
    message: &str,
    phase: &str,
    duration_ms: Option<f64>,
) -> (AutomationApiErrorSnapshot, SidecarCommandError) {
    let command_error = bridge_error(code, message);
    let snapshot = AutomationApiErrorSnapshot {
        code: command_error.code.clone(),
        message: command_error.message.clone(),
        phase: phase.to_string(),
        detail_ref: command_error.detail_ref.clone(),
        at: utc_now(),
        duration_ms,
    };
    (snapshot, command_error)
}

fn generate_credential() -> Result<String, ()> {
    let mut bytes = [0_u8; 32];
    OsRng.try_fill_bytes(&mut bytes).map_err(|_| ())?;
    let mut token = String::with_capacity("tpapi-".len() + bytes.len() * 2);
    token.push_str("tpapi-");
    for byte in bytes {
        token.push_str(&format!("{byte:02x}"));
    }
    Ok(token)
}

fn utc_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn duration_ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        collections::VecDeque,
        path::Path,
        sync::{Arc, Mutex},
    };

    const SENTINEL_STORE_ROOT: &str = "/tmp/theprivator-app-data-root-should-not-leak";

    #[derive(Clone)]
    struct FakeLauncher {
        outcomes: Arc<Mutex<VecDeque<FakeLaunchOutcome>>>,
        launches: Arc<Mutex<Vec<FakeLaunchRecord>>>,
        children: Arc<Mutex<Vec<FakeChildHandle>>>,
    }

    impl FakeLauncher {
        fn new(outcomes: Vec<FakeLaunchOutcome>) -> Self {
            Self {
                outcomes: Arc::new(Mutex::new(VecDeque::from(outcomes))),
                launches: Arc::new(Mutex::new(Vec::new())),
                children: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn launch_count(&self) -> usize {
            self.launches.lock().expect("launches lock").len()
        }

        fn first_credential(&self) -> String {
            self.launches.lock().expect("launches lock")[0]
                .credential
                .clone()
        }

        fn credentials(&self) -> Vec<String> {
            self.launches
                .lock()
                .expect("launches lock")
                .iter()
                .map(|launch| launch.credential.clone())
                .collect()
        }

        fn last_child(&self) -> FakeChildHandle {
            self.children
                .lock()
                .expect("children lock")
                .last()
                .cloned()
                .expect("child launched")
        }
    }

    impl AutomationApiLauncher for FakeLauncher {
        fn launch(
            &self,
            config: AutomationApiLaunchConfig,
        ) -> Result<Box<dyn AutomationApiChild>, AutomationApiLaunchError> {
            self.launches
                .lock()
                .expect("launches lock")
                .push(FakeLaunchRecord {
                    host: config.host.clone(),
                    port: config.port,
                    store_root: config.store_root.clone(),
                    credential: config.credential.clone(),
                });
            let outcome = self
                .outcomes
                .lock()
                .expect("outcomes lock")
                .pop_front()
                .unwrap_or_else(|| FakeLaunchOutcome::ready(49999));
            match outcome {
                FakeLaunchOutcome::ConfigurationError => {
                    Err(AutomationApiLaunchError::Configuration)
                }
                FakeLaunchOutcome::SpawnError => Err(AutomationApiLaunchError::Spawn),
                FakeLaunchOutcome::Child(child) => {
                    let handle = child.handle();
                    self.children.lock().expect("children lock").push(handle);
                    Ok(Box::new(child))
                }
            }
        }
    }

    struct FakeLaunchRecord {
        host: String,
        port: u16,
        store_root: PathBuf,
        credential: String,
    }

    enum FakeLaunchOutcome {
        ConfigurationError,
        SpawnError,
        Child(FakeChild),
    }

    impl FakeLaunchOutcome {
        fn ready(port: u16) -> Self {
            Self::Child(FakeChild::new(FakeReadiness::Line(
                json!({"host":"127.0.0.1","port":port,"version":"1.0.0"}).to_string(),
            )))
        }

        fn readiness_line(line: String) -> Self {
            Self::Child(FakeChild::new(FakeReadiness::Line(line)))
        }

        fn timeout() -> Self {
            Self::Child(FakeChild::new(FakeReadiness::Timeout))
        }

        fn exited_before_ready() -> Self {
            Self::Child(FakeChild::new(FakeReadiness::ChildExited))
        }

        fn stop_failure(port: u16) -> Self {
            let child = FakeChild::new(FakeReadiness::Line(
                json!({"host":"127.0.0.1","port":port,"version":"1.0.0"}).to_string(),
            ));
            child.handle().set_kill_fails(true);
            Self::Child(child)
        }
    }

    #[derive(Clone)]
    struct FakeChildHandle {
        state: Arc<Mutex<FakeChildState>>,
    }

    impl FakeChildHandle {
        fn force_exit(&self) {
            self.state.lock().expect("child lock").exited = true;
        }

        fn killed(&self) -> bool {
            self.state.lock().expect("child lock").killed
        }

        fn set_kill_fails(&self, value: bool) {
            self.state.lock().expect("child lock").kill_fails = value;
        }
    }

    struct FakeChild {
        state: Arc<Mutex<FakeChildState>>,
    }

    impl FakeChild {
        fn new(readiness: FakeReadiness) -> Self {
            Self {
                state: Arc::new(Mutex::new(FakeChildState {
                    pid: 4242,
                    readiness,
                    readiness_taken: false,
                    killed: false,
                    exited: false,
                    kill_fails: false,
                })),
            }
        }

        fn handle(&self) -> FakeChildHandle {
            FakeChildHandle {
                state: self.state.clone(),
            }
        }
    }

    struct FakeChildState {
        pid: u32,
        readiness: FakeReadiness,
        readiness_taken: bool,
        killed: bool,
        exited: bool,
        kill_fails: bool,
    }

    enum FakeReadiness {
        Line(String),
        Timeout,
        ChildExited,
    }

    impl AutomationApiChild for FakeChild {
        fn process_id(&self) -> u32 {
            self.state.lock().expect("child lock").pid
        }

        fn read_readiness_line(
            &mut self,
            _timeout: Duration,
        ) -> Result<String, AutomationApiReadinessError> {
            let mut state = self.state.lock().expect("child lock");
            if state.readiness_taken {
                return Err(AutomationApiReadinessError::Malformed);
            }
            state.readiness_taken = true;
            match &state.readiness {
                FakeReadiness::Line(line) => Ok(line.clone()),
                FakeReadiness::Timeout => Err(AutomationApiReadinessError::Timeout),
                FakeReadiness::ChildExited => {
                    state.exited = true;
                    Err(AutomationApiReadinessError::ChildExited)
                }
            }
        }

        fn try_wait(&mut self) -> Result<Option<i32>, ()> {
            let state = self.state.lock().expect("child lock");
            Ok((state.exited || state.killed).then_some(0))
        }

        fn kill(&mut self) -> Result<(), ()> {
            let mut state = self.state.lock().expect("child lock");
            if state.kill_fails {
                return Err(());
            }
            state.killed = true;
            state.exited = true;
            Ok(())
        }
    }

    fn store_root() -> PathBuf {
        Path::new(SENTINEL_STORE_ROOT).to_path_buf()
    }

    fn assert_status_is_redacted(status: &AutomationApiStatusSnapshot, forbidden: &str) {
        let json = serde_json::to_string(status).expect("status serializes");
        let debug = format!("{status:?}");
        for text in [json, debug] {
            assert!(!text.contains(forbidden));
            assert!(!text.contains(SENTINEL_STORE_ROOT));
            assert!(!text.contains("Authorization"));
            assert!(!text.contains("Bearer"));
            assert!(!text.contains(ENV_TOKEN));
            assert!(!text.contains("stdout"));
            assert!(!text.contains("stderr"));
            assert!(!text.contains("storeRoot"));
        }
    }

    #[test]
    fn automation_api_start_status_and_start_while_running_are_idempotent() {
        let supervisor = AutomationApiSupervisor::new();
        let launcher = FakeLauncher::new(vec![FakeLaunchOutcome::ready(43123)]);

        let started = supervisor
            .start_with_launcher(&launcher, store_root())
            .expect("start succeeds");
        let status = supervisor.status().expect("status succeeds");
        let started_again = supervisor
            .start_with_launcher(&launcher, store_root())
            .expect("already running start returns current status");

        assert_eq!(launcher.launch_count(), 1);
        assert_eq!(started.status, AutomationApiLifecyclePhase::Running);
        assert_eq!(
            started.api.as_ref().expect("api").url,
            "http://127.0.0.1:43123"
        );
        assert_eq!(status, started);
        assert_eq!(started_again, started);
        let launch = &launcher.launches.lock().expect("launches lock")[0];
        assert_eq!(launch.host, AUTOMATION_API_HOST);
        assert_eq!(launch.port, AUTOMATION_API_PORT);
        assert_eq!(launch.store_root, store_root());
        assert!(launch.credential.starts_with("tpapi-"));
    }

    #[test]
    fn automation_api_copy_token_only_returns_memory_credential_when_running() {
        let supervisor = AutomationApiSupervisor::new();
        let stopped_error = match supervisor.copy_credential() {
            Err(error) => error,
            Ok(_) => panic!("stopped copy unexpectedly succeeded"),
        };
        assert_eq!(stopped_error.code, AUTOMATION_API_COPY_UNAVAILABLE);

        let launcher = FakeLauncher::new(vec![FakeLaunchOutcome::ready(43124)]);
        supervisor
            .start_with_launcher(&launcher, store_root())
            .expect("start succeeds");
        let copied = supervisor.copy_credential().expect("running copy succeeds");
        assert_eq!(copied.token, launcher.first_credential());

        let status = supervisor.status().expect("status succeeds");
        assert!(status.copy_available);
        assert_status_is_redacted(&status, &copied.token);
    }

    #[test]
    fn automation_api_readiness_timeout_kills_child_and_clears_credential() {
        let supervisor = AutomationApiSupervisor::new();
        let launcher = FakeLauncher::new(vec![FakeLaunchOutcome::timeout()]);

        let error = supervisor
            .start_with_launcher(&launcher, store_root())
            .expect_err("timeout fails start");
        assert_eq!(error.code, AUTOMATION_API_START_TIMEOUT);
        let child = launcher.last_child();
        assert!(child.killed());
        let status = supervisor.status().expect("status succeeds");
        assert_eq!(status.status, AutomationApiLifecyclePhase::Stopped);
        assert!(!status.copy_available);
        assert_eq!(
            status.last_error.as_ref().expect("last error").code,
            AUTOMATION_API_START_TIMEOUT
        );
        assert_status_is_redacted(&status, &launcher.first_credential());
    }

    #[test]
    fn automation_api_malformed_and_non_loopback_readiness_are_rejected() {
        for line in [
            "not json".to_string(),
            json!({"host":"0.0.0.0","port":43125,"version":"1.0.0"}).to_string(),
            json!({"host":"127.0.0.1","port":43125,"version":"1.0.0","storeRoot":SENTINEL_STORE_ROOT}).to_string(),
            json!({"host":"127.0.0.1","port":43125,"version":"1.0.0","debugPort":9222}).to_string(),
        ] {
            let supervisor = AutomationApiSupervisor::new();
            let launcher = FakeLauncher::new(vec![FakeLaunchOutcome::readiness_line(line)]);
            let error = supervisor
                .start_with_launcher(&launcher, store_root())
                .expect_err("unsafe readiness fails start");
            assert_eq!(error.code, AUTOMATION_API_READINESS_MALFORMED);
            let status = supervisor.status().expect("status succeeds");
            assert_eq!(status.status, AutomationApiLifecyclePhase::Stopped);
            assert_status_is_redacted(&status, &launcher.first_credential());
        }
    }

    #[test]
    fn automation_api_child_exit_reconciles_status_and_clears_copy() {
        let supervisor = AutomationApiSupervisor::new();
        let launcher = FakeLauncher::new(vec![FakeLaunchOutcome::ready(43126)]);
        supervisor
            .start_with_launcher(&launcher, store_root())
            .expect("start succeeds");
        let credential = launcher.first_credential();
        launcher.last_child().force_exit();

        let status = supervisor.status().expect("status reconciles exit");
        assert_eq!(status.status, AutomationApiLifecyclePhase::Stopped);
        assert!(!status.copy_available);
        assert_eq!(
            status.last_error.as_ref().expect("last error").code,
            AUTOMATION_API_CHILD_EXITED
        );
        assert!(supervisor.copy_credential().is_err());
        assert_status_is_redacted(&status, &credential);
    }

    #[test]
    fn automation_api_stop_clears_credential_kills_child_and_restart_rotates_credential() {
        let supervisor = AutomationApiSupervisor::new();
        let launcher = FakeLauncher::new(vec![
            FakeLaunchOutcome::ready(43127),
            FakeLaunchOutcome::ready(43128),
        ]);
        supervisor
            .start_with_launcher(&launcher, store_root())
            .expect("first start succeeds");
        let first = supervisor.copy_credential().expect("copy succeeds").token;
        let first_child = launcher.last_child();

        let stopped = supervisor.stop().expect("stop succeeds");
        assert_eq!(stopped.status, AutomationApiLifecyclePhase::Stopped);
        assert!(!stopped.copy_available);
        assert!(first_child.killed());
        assert!(supervisor.copy_credential().is_err());

        supervisor
            .start_with_launcher(&launcher, store_root())
            .expect("restart succeeds");
        let second = supervisor.copy_credential().expect("copy succeeds").token;
        assert_ne!(first, second);
        assert_eq!(launcher.credentials().len(), 2);
    }

    #[test]
    fn automation_api_spawn_and_configuration_errors_are_safe() {
        for (outcome, code) in [
            (
                FakeLaunchOutcome::ConfigurationError,
                AUTOMATION_API_CONFIGURATION_ERROR,
            ),
            (FakeLaunchOutcome::SpawnError, AUTOMATION_API_SPAWN_FAILED),
            (
                FakeLaunchOutcome::exited_before_ready(),
                AUTOMATION_API_CHILD_EXITED,
            ),
        ] {
            let supervisor = AutomationApiSupervisor::new();
            let launcher = FakeLauncher::new(vec![outcome]);
            let error = supervisor
                .start_with_launcher(&launcher, store_root())
                .expect_err("start fails safely");
            assert_eq!(error.code, code);
            let error_debug = format!("{error:?}");
            assert!(!error_debug.contains("Authorization"));
            assert!(!error_debug.contains("Bearer"));
            assert!(!error_debug.contains(ENV_TOKEN));
            assert!(!error_debug.contains(SENTINEL_STORE_ROOT));
            let status = supervisor.status().expect("status succeeds");
            assert_eq!(status.status, AutomationApiLifecyclePhase::Stopped);
        }
    }

    #[test]
    fn automation_api_stop_failure_preserves_safe_retry_state_without_copy() {
        let supervisor = AutomationApiSupervisor::new();
        let launcher = FakeLauncher::new(vec![FakeLaunchOutcome::stop_failure(43129)]);
        supervisor
            .start_with_launcher(&launcher, store_root())
            .expect("start succeeds");
        let credential = launcher.first_credential();
        let child = launcher.last_child();

        let error = supervisor.stop().expect_err("first stop fails");
        assert_eq!(error.code, AUTOMATION_API_STOP_FAILED);
        let status = supervisor.status().expect("status succeeds");
        assert_eq!(status.status, AutomationApiLifecyclePhase::Running);
        assert!(!status.copy_available);
        assert!(supervisor.copy_credential().is_err());
        assert_status_is_redacted(&status, &credential);

        child.set_kill_fails(false);
        let stopped = supervisor.stop().expect("retry stop succeeds");
        assert_eq!(stopped.status, AutomationApiLifecyclePhase::Stopped);
    }
}
