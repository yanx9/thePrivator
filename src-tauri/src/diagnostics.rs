use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
};
use tauri::Manager;

use crate::sidecar::{bridge_error, SidecarCommandError};

pub const DIAGNOSTIC_SCHEMA_VERSION: u64 = 1;
pub const DIAGNOSTIC_SOURCE_PYTHON: &str = "python-sidecar";
pub const DIAGNOSTIC_SOURCE_RUST: &str = "rust-bridge";
pub const DIAGNOSTIC_RELATIVE_LOG_PATH: &str = "profile-store/diagnostics/events.jsonl";
pub const MAX_LOG_BYTES: usize = 512 * 1024;
pub const MAX_LOG_LINES: usize = 1000;
pub const MAX_LOOKUP_RESULTS: usize = 25;

const SIDECAR_REQUEST_EVENT: &str = "sidecar.request";
const LEGACY_IMPORT_OUTCOME_EVENT: &str = "legacy.import.outcome";
const BRIDGE_FAILURE_EVENT: &str = "sidecar.bridge_failure";
const SIDECAR_CONFIGURATION_ERROR: &str = "SIDECAR_CONFIGURATION_ERROR";
const DIAGNOSTIC_STORE_WRITE_FAILED: &str = "DIAGNOSTIC_STORE_WRITE_FAILED";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLookupResult {
    pub found: bool,
    pub detail_ref: String,
    pub log_path: Option<String>,
    pub reason: String,
    pub entries: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiagnosticPathError {
    Unavailable,
    NonUnicode,
    Relative,
}

#[derive(Debug, Clone)]
pub struct DiagnosticStore {
    app_data_root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticWriteOutcome {
    pub written: usize,
    pub skipped: usize,
    pub failed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StderrPersistOutcome {
    pub written: usize,
    pub skipped: usize,
    pub malformed_lines: usize,
    pub nonempty_lines: usize,
}

impl DiagnosticStore {
    pub fn from_app_data_dir<E>(
        app_data_dir: Result<PathBuf, E>,
    ) -> Result<Self, DiagnosticPathError> {
        let app_data_root = app_data_dir.map_err(|_| DiagnosticPathError::Unavailable)?;
        Self::new(app_data_root)
    }

    pub fn new(app_data_root: PathBuf) -> Result<Self, DiagnosticPathError> {
        if app_data_root.to_str().is_none() {
            return Err(DiagnosticPathError::NonUnicode);
        }
        if !app_data_root.is_absolute() {
            return Err(DiagnosticPathError::Relative);
        }
        Ok(Self { app_data_root })
    }

    pub fn log_path(&self) -> PathBuf {
        self.app_data_root
            .join("profile-store")
            .join("diagnostics")
            .join("events.jsonl")
    }

    pub fn append_event(&self, event: Value) -> DiagnosticWriteOutcome {
        self.append_events([event])
    }

    pub fn append_events<I>(&self, events: I) -> DiagnosticWriteOutcome
    where
        I: IntoIterator<Item = Value>,
    {
        let mut normalized = Vec::new();
        let mut skipped = 0;
        for event in events {
            if let Some(record) = normalize_event(&event, None, None) {
                normalized.push(record);
            } else {
                skipped += 1;
            }
        }

        if normalized.is_empty() {
            return DiagnosticWriteOutcome {
                written: 0,
                skipped,
                failed: false,
            };
        }

        let path = self.log_path();
        let result = (|| -> std::io::Result<()> {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?;
            for record in &normalized {
                file.write_all(encode_record(record).as_bytes())?;
                file.write_all(b"\n")?;
            }
            file.flush()?;
            let _ = file.sync_data();
            trim_log(&path)?;
            Ok(())
        })();

        if result.is_err() {
            emit_diagnostic_store_write_failed();
        }

        DiagnosticWriteOutcome {
            written: if result.is_ok() { normalized.len() } else { 0 },
            skipped,
            failed: result.is_err(),
        }
    }

    pub fn append_sidecar_stderr_events(
        &self,
        stderr: &str,
        method: &str,
        request_id: &str,
    ) -> StderrPersistOutcome {
        let mut normalized = Vec::new();
        let mut skipped = 0;
        let mut malformed_lines = 0;
        let mut nonempty_lines = 0;

        for line in stderr
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            nonempty_lines += 1;
            let Ok(parsed) = serde_json::from_str::<Value>(line) else {
                malformed_lines += 1;
                continue;
            };
            if let Some(record) = normalize_event(&parsed, Some(method), Some(request_id)) {
                normalized.push(record);
            } else {
                skipped += 1;
            }
        }

        let written = if normalized.is_empty() {
            0
        } else {
            self.append_events(normalized).written
        };

        StderrPersistOutcome {
            written,
            skipped,
            malformed_lines,
            nonempty_lines,
        }
    }

    pub fn lookup(&self, detail_ref: &str) -> DiagnosticLookupResult {
        lookup_in_store(Some(self), detail_ref)
    }
}

#[tauri::command]
pub fn diagnostics_lookup(
    app: tauri::AppHandle,
    detail_ref: String,
) -> Result<DiagnosticLookupResult, SidecarCommandError> {
    diagnostics_lookup_from_app_data_dir(app.path().app_data_dir(), &detail_ref).map_err(|_| {
        bridge_error(
            SIDECAR_CONFIGURATION_ERROR,
            "The Tauri app data directory could not be resolved for diagnostics lookup.",
        )
    })
}

pub fn diagnostics_lookup_from_app_data_dir<E>(
    app_data_dir: Result<PathBuf, E>,
    detail_ref: &str,
) -> Result<DiagnosticLookupResult, DiagnosticPathError> {
    match classify_detail_ref(detail_ref) {
        DetailRefClass::Ui => return Ok(ui_local_result(detail_ref)),
        DetailRefClass::Invalid => return Ok(invalid_detail_ref_result(detail_ref)),
        DetailRefClass::Persisted => {}
    }

    let store = DiagnosticStore::from_app_data_dir(app_data_dir)?;
    Ok(store.lookup(detail_ref))
}

pub fn lookup_in_store(
    store: Option<&DiagnosticStore>,
    detail_ref: &str,
) -> DiagnosticLookupResult {
    match classify_detail_ref(detail_ref) {
        DetailRefClass::Ui => return ui_local_result(detail_ref),
        DetailRefClass::Invalid => return invalid_detail_ref_result(detail_ref),
        DetailRefClass::Persisted => {}
    }

    let Some(store) = store else {
        return not_persisted_result(detail_ref);
    };
    let path = store.log_path();
    if !path.is_file() {
        return not_persisted_result(detail_ref);
    }

    let entries: Vec<Value> = read_valid_records(&path)
        .into_iter()
        .filter(|record| record.get("detailRef").and_then(Value::as_str) == Some(detail_ref))
        .take(MAX_LOOKUP_RESULTS)
        .collect();

    DiagnosticLookupResult {
        found: !entries.is_empty(),
        detail_ref: detail_ref.to_string(),
        log_path: Some(DIAGNOSTIC_RELATIVE_LOG_PATH.to_string()),
        reason: if entries.is_empty() {
            "not-persisted".to_string()
        } else {
            "found".to_string()
        },
        entries,
    }
}

pub fn normalize_event(
    raw_event: &Value,
    default_method: Option<&str>,
    default_request_id: Option<&str>,
) -> Option<Value> {
    let raw = raw_event.as_object()?;
    if let Some(schema_version) = raw.get("schemaVersion") {
        if schema_version.as_u64() != Some(DIAGNOSTIC_SCHEMA_VERSION) {
            return None;
        }
    }
    if let Some(log_path) = raw.get("logPath") {
        if log_path.as_str() != Some(DIAGNOSTIC_RELATIVE_LOG_PATH) {
            return None;
        }
    }

    let event_name = raw.get("event")?.as_str()?;
    let source = raw
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_else(|| default_source_for_event(event_name));

    if !source_matches_event(source, event_name) {
        return None;
    }

    let status = raw.get("status")?.as_str()?;
    let mut record = Map::new();
    record.insert(
        "schemaVersion".to_string(),
        json!(DIAGNOSTIC_SCHEMA_VERSION),
    );
    record.insert(
        "ts".to_string(),
        json!(safe_timestamp(raw.get("ts").and_then(Value::as_str))),
    );
    record.insert("source".to_string(), json!(source));
    record.insert("event".to_string(), json!(event_name));
    record.insert("status".to_string(), json!(status));
    record.insert("logPath".to_string(), json!(DIAGNOSTIC_RELATIVE_LOG_PATH));

    if let Some(request_id) = safe_request_id(raw.get("requestId"), default_request_id) {
        record.insert("requestId".to_string(), request_id);
    }

    let method = safe_method(raw.get("method").and_then(Value::as_str).or(default_method));
    if let Some(method) = method.or_else(|| {
        if event_name == LEGACY_IMPORT_OUTCOME_EVENT {
            Some("legacy.import".to_string())
        } else {
            None
        }
    }) {
        record.insert("method".to_string(), json!(method));
    }

    if let Some(duration_ms) = safe_duration(raw.get("durationMs")) {
        record.insert("durationMs".to_string(), duration_ms);
    }

    match event_name {
        SIDECAR_REQUEST_EVENT => normalize_sidecar_request(raw, status, record),
        LEGACY_IMPORT_OUTCOME_EVENT => normalize_legacy_import_outcome(raw, status, record),
        BRIDGE_FAILURE_EVENT => normalize_bridge_failure(raw, status, record),
        _ => None,
    }
}

pub fn bridge_failure_event(
    method: &str,
    request_id: &str,
    error_code: &str,
    detail_ref: &str,
    duration_ms: f64,
    exit_code: Option<i32>,
    stdout_lines: usize,
    stderr_lines: usize,
) -> Value {
    json!({
        "schemaVersion": DIAGNOSTIC_SCHEMA_VERSION,
        "ts": current_timestamp(),
        "source": DIAGNOSTIC_SOURCE_RUST,
        "event": BRIDGE_FAILURE_EVENT,
        "status": "error",
        "requestId": request_id,
        "method": method,
        "durationMs": duration_ms,
        "errorCode": error_code,
        "detailRef": detail_ref,
        "exitCode": exit_code,
        "stdoutLines": stdout_lines,
        "stderrLines": stderr_lines,
        "logPath": DIAGNOSTIC_RELATIVE_LOG_PATH,
    })
}

fn normalize_sidecar_request(
    raw: &Map<String, Value>,
    status: &str,
    mut record: Map<String, Value>,
) -> Option<Value> {
    if status != "ok" && status != "error" {
        return None;
    }

    if status == "error" {
        let error_code = safe_error_code(raw.get("errorCode")?.as_str()?)?;
        let detail_ref = safe_persisted_detail_ref(raw.get("detailRef")?.as_str()?)?;
        record.insert("errorCode".to_string(), json!(error_code));
        record.insert("detailRef".to_string(), json!(detail_ref));
    } else {
        record.insert("errorCode".to_string(), Value::Null);
        record.insert("detailRef".to_string(), Value::Null);
    }

    Some(Value::Object(record))
}

fn normalize_legacy_import_outcome(
    raw: &Map<String, Value>,
    status: &str,
    mut record: Map<String, Value>,
) -> Option<Value> {
    if status != "partial" && status != "failed" {
        return None;
    }
    let error_code = safe_error_code(raw.get("errorCode")?.as_str()?)?;
    let detail_ref = safe_persisted_detail_ref(raw.get("detailRef")?.as_str()?)?;
    record.insert("errorCode".to_string(), json!(error_code));
    record.insert("detailRef".to_string(), json!(detail_ref));

    if let Some(legacy_id) = safe_legacy_id(
        raw.get("legacyId")
            .or_else(|| raw.get("context").and_then(|value| value.get("legacyId")))
            .and_then(Value::as_str),
    ) {
        record.insert("context".to_string(), json!({ "legacyId": legacy_id }));
    }

    Some(Value::Object(record))
}

fn normalize_bridge_failure(
    raw: &Map<String, Value>,
    status: &str,
    mut record: Map<String, Value>,
) -> Option<Value> {
    if status != "error" {
        return None;
    }
    let error_code = safe_error_code(raw.get("errorCode")?.as_str()?)?;
    let detail_ref = safe_bridge_detail_ref(raw.get("detailRef")?.as_str()?)?;
    record.insert("errorCode".to_string(), json!(error_code));
    record.insert("detailRef".to_string(), json!(detail_ref));

    if let Some(exit_code) = raw.get("exitCode") {
        if exit_code.is_null() {
            record.insert("exitCode".to_string(), Value::Null);
        } else if let Some(code) = exit_code.as_i64().and_then(|code| i32::try_from(code).ok()) {
            record.insert("exitCode".to_string(), json!(code));
        }
    }
    if let Some(stdout_lines) = safe_count(raw.get("stdoutLines")) {
        record.insert("stdoutLines".to_string(), json!(stdout_lines));
    }
    if let Some(stderr_lines) = safe_count(raw.get("stderrLines")) {
        record.insert("stderrLines".to_string(), json!(stderr_lines));
    }

    Some(Value::Object(record))
}

fn read_valid_records(path: &PathBuf) -> Vec<Value> {
    read_bounded_lines(path)
        .into_iter()
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter_map(|value| normalize_event(&value, None, None))
        .rev()
        .take(MAX_LOG_LINES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn read_bounded_lines(path: &PathBuf) -> Vec<String> {
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let size = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let start = size.saturating_sub(MAX_LOG_BYTES as u64);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file
        .take(MAX_LOG_BYTES as u64)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<String> = text.lines().map(ToString::to_string).collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    lines
}

fn trim_log(path: &PathBuf) -> std::io::Result<()> {
    let mut records = read_valid_records(path);
    if records.len() > MAX_LOG_LINES {
        records = records.split_off(records.len() - MAX_LOG_LINES);
    }
    while !records.is_empty() && encoded_size(&records) > MAX_LOG_BYTES {
        records.remove(0);
    }

    let temp_path = path.with_file_name(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("events.jsonl"),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));

    let write_result = (|| -> std::io::Result<()> {
        let mut file = File::create(&temp_path)?;
        for record in &records {
            file.write_all(encode_record(record).as_bytes())?;
            file.write_all(b"\n")?;
        }
        file.flush()?;
        let _ = file.sync_data();
        fs::rename(&temp_path, path)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

fn encoded_size(records: &[Value]) -> usize {
    records
        .iter()
        .map(|record| encode_record(record).as_bytes().len() + 1)
        .sum()
}

fn encode_record(record: &Value) -> String {
    serde_json::to_string(record).unwrap_or_else(|_| "{}".to_string())
}

fn ui_local_result(detail_ref: &str) -> DiagnosticLookupResult {
    DiagnosticLookupResult {
        found: false,
        detail_ref: detail_ref.to_string(),
        log_path: None,
        reason: "ui-local".to_string(),
        entries: Vec::new(),
    }
}

fn invalid_detail_ref_result(detail_ref: &str) -> DiagnosticLookupResult {
    DiagnosticLookupResult {
        found: false,
        detail_ref: detail_ref.to_string(),
        log_path: None,
        reason: "invalid-detail-ref".to_string(),
        entries: Vec::new(),
    }
}

fn not_persisted_result(detail_ref: &str) -> DiagnosticLookupResult {
    DiagnosticLookupResult {
        found: false,
        detail_ref: detail_ref.to_string(),
        log_path: Some(DIAGNOSTIC_RELATIVE_LOG_PATH.to_string()),
        reason: "not-persisted".to_string(),
        entries: Vec::new(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DetailRefClass {
    Persisted,
    Ui,
    Invalid,
}

fn classify_detail_ref(value: &str) -> DetailRefClass {
    if !is_safe_short_string(value) {
        return DetailRefClass::Invalid;
    }
    let Some((prefix, suffix)) = value.split_once('-') else {
        return DetailRefClass::Invalid;
    };
    if suffix.is_empty() || suffix.len() > 127 || !suffix.chars().all(is_detail_ref_char) {
        return DetailRefClass::Invalid;
    }
    match prefix {
        "sidecar" | "bridge" => DetailRefClass::Persisted,
        "ui" => DetailRefClass::Ui,
        _ => DetailRefClass::Invalid,
    }
}

fn safe_persisted_detail_ref(value: &str) -> Option<String> {
    if classify_detail_ref(value) == DetailRefClass::Persisted {
        Some(value.to_string())
    } else {
        None
    }
}

fn safe_bridge_detail_ref(value: &str) -> Option<String> {
    if value.starts_with("bridge-") && classify_detail_ref(value) == DetailRefClass::Persisted {
        Some(value.to_string())
    } else {
        None
    }
}

fn is_detail_ref_char(value: char) -> bool {
    value.is_ascii_alphanumeric() || matches!(value, '_' | '.' | ':' | '-')
}

fn default_source_for_event(event_name: &str) -> &'static str {
    if event_name == BRIDGE_FAILURE_EVENT {
        DIAGNOSTIC_SOURCE_RUST
    } else {
        DIAGNOSTIC_SOURCE_PYTHON
    }
}

fn source_matches_event(source: &str, event_name: &str) -> bool {
    matches!(
        (source, event_name),
        (DIAGNOSTIC_SOURCE_PYTHON, SIDECAR_REQUEST_EVENT)
            | (DIAGNOSTIC_SOURCE_PYTHON, LEGACY_IMPORT_OUTCOME_EVENT)
            | (DIAGNOSTIC_SOURCE_RUST, BRIDGE_FAILURE_EVENT)
    )
}

fn safe_timestamp(value: Option<&str>) -> String {
    if let Some(value) = value {
        if value.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(value).is_ok() {
            return value.to_string();
        }
    }
    current_timestamp()
}

fn current_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn safe_request_id(value: Option<&Value>, default_request_id: Option<&str>) -> Option<Value> {
    match value {
        Some(Value::Null) | None => default_request_id
            .filter(|request_id| is_safe_short_string(request_id))
            .map(|request_id| json!(request_id)),
        Some(Value::Bool(value)) => Some(json!(value)),
        Some(Value::Number(value)) if value.is_i64() || value.is_u64() || value.is_f64() => {
            Some(Value::Number(value.clone()))
        }
        Some(Value::String(value)) if is_safe_short_string(value) => Some(json!(value)),
        _ => None,
    }
}

fn safe_method(value: Option<&str>) -> Option<String> {
    let value = value?;
    if !is_safe_short_string(value) || !value.contains('.') {
        return None;
    }
    let mut segments = value.split('.');
    if segments.all(|segment| {
        let mut chars = segment.chars();
        matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
            && chars.all(|char| char.is_ascii_lowercase() || char.is_ascii_digit() || char == '_')
    }) {
        Some(value.to_string())
    } else {
        None
    }
}

fn safe_error_code(value: &str) -> Option<String> {
    if value.len() < 2 || value.len() > 96 {
        return None;
    }
    if value
        .chars()
        .all(|char| char.is_ascii_uppercase() || char.is_ascii_digit() || char == '_')
        && value
            .chars()
            .next()
            .is_some_and(|char| char.is_ascii_uppercase())
    {
        Some(value.to_string())
    } else {
        None
    }
}

fn safe_duration(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Number(number)) if number.as_f64().is_some_and(|value| value >= 0.0) => {
            Some(Value::Number(number.clone()))
        }
        _ => None,
    }
}

fn safe_count(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

fn safe_legacy_id(value: Option<&str>) -> Option<String> {
    let value = value?;
    if !value.starts_with("legacy-") || value.len() > 103 {
        return None;
    }
    let suffix = &value[7..];
    if !suffix.is_empty() && suffix.chars().all(is_detail_ref_char) && is_safe_short_string(value) {
        Some(value.to_string())
    } else {
        None
    }
}

fn is_safe_short_string(value: &str) -> bool {
    if value.is_empty() || value.len() > 256 || looks_path_like(value) {
        return false;
    }
    let lowered = value.to_ascii_lowercase();
    ![
        "traceback",
        "stdout",
        "stderr",
        "params",
        "proxy_user",
        "proxy_pass",
        "token=",
        "password=",
        "secret=",
        "--user-data-dir",
    ]
    .iter()
    .any(|marker| lowered.contains(marker))
}

fn looks_path_like(value: &str) -> bool {
    value != DIAGNOSTIC_RELATIVE_LOG_PATH
        && (value.contains('/')
            || value.contains('\\')
            || value.contains("://")
            || value.starts_with('~')
            || value.as_bytes().get(1) == Some(&b':'))
}

fn emit_diagnostic_store_write_failed() {
    let event = json!({
        "event": "sidecar.diagnostic_store_write_failed",
        "source": DIAGNOSTIC_SOURCE_RUST,
        "status": "error",
        "errorCode": DIAGNOSTIC_STORE_WRITE_FAILED,
    });
    eprintln!("{}", serde_json::to_string(&event).unwrap_or_else(|_| {
        "{\"event\":\"sidecar.diagnostic_store_write_failed\",\"errorCode\":\"DIAGNOSTIC_STORE_WRITE_FAILED\"}".to_string()
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_store() -> DiagnosticStore {
        let sequence = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("theprivator-rust-diagnostics-{sequence}"));
        let _ = fs::remove_dir_all(&root);
        DiagnosticStore::new(root).expect("temp store root is absolute")
    }

    fn read_log_text(store: &DiagnosticStore) -> String {
        fs::read_to_string(store.log_path()).expect("diagnostics log exists")
    }

    #[test]
    fn append_normalizes_sidecar_error_and_lookup_returns_only_safe_fields() {
        let store = temp_store();
        let raw = json!({
            "event": "sidecar.request",
            "requestId": "bridge-1",
            "method": "profiles.create",
            "status": "error",
            "durationMs": 2.5,
            "errorCode": "PROFILE_DUPLICATE_NAME",
            "detailRef": "sidecar-duplicate-detail",
            "params": { "storeRoot": "/secret/root", "name": "Research" },
            "stdout": "secret stdout body",
            "stderr": "secret stderr body"
        });

        let outcome = store.append_event(raw);
        let lookup = store.lookup("sidecar-duplicate-detail");
        let log_text = read_log_text(&store);

        assert_eq!(outcome.written, 1);
        assert!(lookup.found);
        assert_eq!(
            lookup.log_path.as_deref(),
            Some(DIAGNOSTIC_RELATIVE_LOG_PATH)
        );
        assert_eq!(lookup.reason, "found");
        assert_eq!(lookup.entries.len(), 1);
        let entry = &lookup.entries[0];
        assert_eq!(entry["schemaVersion"], DIAGNOSTIC_SCHEMA_VERSION);
        assert_eq!(entry["source"], DIAGNOSTIC_SOURCE_PYTHON);
        assert_eq!(entry["event"], SIDECAR_REQUEST_EVENT);
        assert_eq!(entry["method"], "profiles.create");
        assert_eq!(entry["errorCode"], "PROFILE_DUPLICATE_NAME");
        assert_eq!(entry["detailRef"], "sidecar-duplicate-detail");
        assert!(entry.get("params").is_none());
        assert!(entry.get("stdout").is_none());
        assert!(entry.get("stderr").is_none());
        assert!(!log_text.contains("/secret/root"));
        assert!(!log_text.contains("secret stdout body"));
        assert!(!log_text.contains("secret stderr body"));
    }

    #[test]
    fn appending_stderr_events_persists_legacy_context_and_counts_malformed_lines() {
        let store = temp_store();
        let stderr = concat!(
            "not-json\n",
            "{\"event\":\"legacy.import.outcome\",\"legacyId\":\"legacy-safe-id\",\"status\":\"failed\",\"errorCode\":\"LEGACY_USER_DATA_COPY_FAILED\",\"detailRef\":\"sidecar-legacy-detail\",\"context\":{\"rawPath\":\"/secret\"}}\n",
            "{\"event\":\"sidecar.request\",\"status\":\"ok\",\"durationMs\":1}\n"
        );

        let outcome = store.append_sidecar_stderr_events(stderr, "legacy.import", "bridge-2");
        let lookup = store.lookup("sidecar-legacy-detail");
        let log_text = read_log_text(&store);

        assert_eq!(outcome.nonempty_lines, 3);
        assert_eq!(outcome.malformed_lines, 1);
        assert_eq!(outcome.written, 2);
        assert!(lookup.found);
        assert_eq!(lookup.entries[0]["event"], LEGACY_IMPORT_OUTCOME_EVENT);
        assert_eq!(lookup.entries[0]["context"]["legacyId"], "legacy-safe-id");
        assert!(lookup.entries[0]["context"].get("rawPath").is_none());
        assert!(!log_text.contains("/secret"));
    }

    #[test]
    fn bridge_failure_events_are_lookupable_without_stdout_or_stderr_bodies() {
        let store = temp_store();
        let event = bridge_failure_event(
            "health.status",
            "bridge-3",
            "SIDECAR_PROTOCOL_ERROR",
            "bridge-protocol-detail",
            5.0,
            Some(2),
            7,
            11,
        );

        store.append_event(event);
        let lookup = store.lookup("bridge-protocol-detail");
        let entry = &lookup.entries[0];

        assert!(lookup.found);
        assert_eq!(entry["source"], DIAGNOSTIC_SOURCE_RUST);
        assert_eq!(entry["event"], BRIDGE_FAILURE_EVENT);
        assert_eq!(entry["status"], "error");
        assert_eq!(entry["stdoutLines"], 7);
        assert_eq!(entry["stderrLines"], 11);
        assert!(entry.get("stdout").is_none());
        assert!(entry.get("stderr").is_none());
    }

    #[test]
    fn lookup_classifies_ui_invalid_missing_and_malformed_rows_without_reading_arbitrary_paths() {
        let store = temp_store();
        let ui = store.lookup("ui-panel-detail");
        let invalid = store.lookup("/tmp/sidecar-detail");
        let missing = store.lookup("sidecar-not-yet-persisted");

        assert_eq!(ui.reason, "ui-local");
        assert_eq!(ui.log_path, None);
        assert_eq!(invalid.reason, "invalid-detail-ref");
        assert_eq!(invalid.log_path, None);
        assert_eq!(missing.reason, "not-persisted");
        assert_eq!(
            missing.log_path.as_deref(),
            Some(DIAGNOSTIC_RELATIVE_LOG_PATH)
        );

        let path = store.log_path();
        fs::create_dir_all(path.parent().expect("diagnostics parent"))
            .expect("create diagnostics parent");
        fs::write(
            &path,
            concat!(
                "not-json\n",
                "{\"schemaVersion\":1,\"logPath\":\"/secret/path\",\"event\":\"sidecar.request\",\"source\":\"python-sidecar\",\"status\":\"error\",\"errorCode\":\"PROFILE_INVALID_NAME\",\"detailRef\":\"sidecar-unsafe\"}\n",
                "{\"schemaVersion\":1,\"logPath\":\"profile-store/diagnostics/events.jsonl\",\"event\":\"sidecar.request\",\"source\":\"python-sidecar\",\"status\":\"error\",\"errorCode\":\"PROFILE_INVALID_NAME\",\"detailRef\":\"sidecar-safe-row\"}\n"
            ),
        )
        .expect("write fixture log");

        let unsafe_lookup = store.lookup("sidecar-unsafe");
        let safe_lookup = store.lookup("sidecar-safe-row");
        assert!(!unsafe_lookup.found);
        assert!(safe_lookup.found);
        assert_eq!(safe_lookup.entries.len(), 1);
    }

    #[test]
    fn retention_trims_to_bounded_latest_entries_and_lookup_caps_results() {
        let store = temp_store();
        let events = (0..(MAX_LOG_LINES + 5)).map(|index| {
            json!({
                "event": "sidecar.request",
                "requestId": format!("bridge-{index}"),
                "method": "profiles.create",
                "status": "error",
                "durationMs": 1,
                "errorCode": "PROFILE_INVALID_NAME",
                "detailRef": if index % 2 == 0 { "sidecar-repeated-detail" } else { "sidecar-other-detail" }
            })
        });
        store.append_events(events);

        let lines = read_log_text(&store).lines().count();
        let repeated = store.lookup("sidecar-repeated-detail");

        assert!(lines <= MAX_LOG_LINES);
        assert_eq!(repeated.entries.len(), MAX_LOOKUP_RESULTS);
    }

    #[test]
    fn app_data_resolution_rejects_relative_and_nonunicode_paths() {
        assert_eq!(
            DiagnosticStore::new(PathBuf::from("relative/path"))
                .expect_err("relative root rejected"),
            DiagnosticPathError::Relative
        );

        #[cfg(unix)]
        {
            use std::ffi::OsString;
            use std::os::unix::ffi::OsStringExt;
            let path = PathBuf::from(OsString::from_vec(vec![b'/', 0xff]));
            assert_eq!(
                DiagnosticStore::new(path).expect_err("non-unicode root rejected"),
                DiagnosticPathError::NonUnicode
            );
        }
    }
}
