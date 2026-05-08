"""Durable redacted diagnostics tests for store-root sidecar commands."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
FORBIDDEN_LOG_SUBSTRINGS = (
    "params",
    "storeRoot",
    "legacyRoot",
    "stdout",
    "stderr",
    "Traceback",
    "proxy_user",
    "proxy_pass",
    "--user-data-dir",
    "THEPRIVATOR_CHROMIUM_PATH=",
)


def run_sidecar(input_text, env=None):
    """Run the sidecar module with isolated stdin/stdout/stderr streams."""
    process_env = None if env is None else {**os.environ, **env}
    return subprocess.run(
        [sys.executable, "-m", "theprivator_sidecar"],
        input=input_text,
        text=True,
        capture_output=True,
        cwd=REPO_ROOT,
        env=process_env,
        check=False,
    )


def request_line(payload):
    return json.dumps(payload) + "\n"


def parse_ndjson(stream):
    return [json.loads(line) for line in stream.splitlines()]


def assert_error_envelope(response, code, request_id=None):
    assert response["id"] == request_id
    assert response["ok"] is False
    assert response["protocolVersion"] == "1.0.0"
    error = response["error"]
    assert error["code"] == code
    assert error["recoverable"] is True
    assert error["detailRef"].startswith("sidecar-")
    return error


def diagnostics_log_path(store_root):
    return Path(store_root) / "profile-store" / "diagnostics" / "events.jsonl"


def read_log_records(store_root):
    return [json.loads(line) for line in diagnostics_log_path(store_root).read_text(encoding="utf-8").splitlines()]


def assert_redacted_log_text(store_root, *forbidden_values):
    text = diagnostics_log_path(store_root).read_text(encoding="utf-8")
    for value in [*FORBIDDEN_LOG_SUBSTRINGS, *forbidden_values]:
        if value:
            assert str(value) not in text
    return text


def write_legacy_config(profile_dir: Path, payload: object) -> None:
    profile_dir.mkdir(parents=True, exist_ok=True)
    (profile_dir / "config.json").write_text(json.dumps(payload), encoding="utf-8")


def test_profile_duplicate_error_is_persisted_with_matching_detail_ref_and_redaction(tmp_path):
    from theprivator_sidecar.diagnostics import DIAGNOSTIC_RELATIVE_LOG_PATH, lookup_by_detail_ref

    store_root = str(tmp_path / "app-data-path-should-not-leak")
    profile_name = "Research Secret Name"
    run_sidecar(
        request_line(
            {
                "id": "profile-seed",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": profile_name},
            }
        )
    )

    duplicate_proc = run_sidecar(
        request_line(
            {
                "id": "profile-duplicate",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": profile_name.casefold()},
            }
        )
    )

    response = parse_ndjson(duplicate_proc.stdout)[0]
    stderr_diagnostic = parse_ndjson(duplicate_proc.stderr)[0]
    error = assert_error_envelope(response, "PROFILE_DUPLICATE_NAME", "profile-duplicate")
    assert stderr_diagnostic["detailRef"] == error["detailRef"]

    lookup = lookup_by_detail_ref(store_root, error["detailRef"])
    assert lookup == {
        "found": True,
        "logPath": DIAGNOSTIC_RELATIVE_LOG_PATH,
        "entries": [lookup["entries"][0]],
    }
    entry = lookup["entries"][0]
    assert entry["schemaVersion"] == 1
    assert entry["source"] == "python-sidecar"
    assert entry["event"] == "sidecar.request"
    assert entry["requestId"] == "profile-duplicate"
    assert entry["method"] == "profiles.create"
    assert entry["status"] == "error"
    assert entry["errorCode"] == "PROFILE_DUPLICATE_NAME"
    assert entry["detailRef"] == error["detailRef"]
    assert isinstance(entry["durationMs"], (int, float))
    assert entry["ts"].endswith("Z")
    assert entry["logPath"] == DIAGNOSTIC_RELATIVE_LOG_PATH

    log_text = assert_redacted_log_text(store_root, store_root, profile_name, profile_name.casefold())
    assert "profile-store/diagnostics/events.jsonl" in log_text
    assert len(parse_ndjson(log_text)) == 2


def test_direct_no_store_root_calls_stay_stderr_only_and_ignore_log_path_params(tmp_path):
    sneaky_log = tmp_path / "webview-supplied-log-path-should-not-exist" / "events.jsonl"
    proc = run_sidecar(
        request_line(
            {
                "id": "diagnostic-no-store",
                "method": "diagnostics.fail",
                "params": {"logPath": str(sneaky_log), "token": "secret-token-should-not-leak"},
            }
        )
    )

    response = parse_ndjson(proc.stdout)[0]
    diagnostic = parse_ndjson(proc.stderr)[0]
    error = assert_error_envelope(response, "DIAGNOSTIC_FAILURE", "diagnostic-no-store")
    assert diagnostic["detailRef"] == error["detailRef"]
    assert not sneaky_log.exists()
    assert "secret-token-should-not-leak" not in proc.stderr
    assert str(sneaky_log) not in proc.stderr


def test_chromium_missing_executable_error_is_persisted_with_matching_detail_ref(tmp_path):
    from theprivator_sidecar.diagnostics import lookup_by_detail_ref

    store_root = str(tmp_path / "app-data-path-should-not-leak")
    create_proc = run_sidecar(
        request_line(
            {
                "id": "chromium-profile-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "No Browser Secret Name"},
            }
        )
    )
    profile = parse_ndjson(create_proc.stdout)[0]["result"]["profile"]
    missing_executable = tmp_path / "missing-chromium-path-should-not-leak"

    proc = run_sidecar(
        request_line(
            {
                "id": "chromium-missing-exe",
                "method": "chromium.launch",
                "params": {"storeRoot": store_root, "profileId": profile["id"]},
            }
        ),
        env={"THEPRIVATOR_CHROMIUM_PATH": str(missing_executable), "PATH": str(tmp_path / "empty")},
    )

    response = parse_ndjson(proc.stdout)[0]
    error = assert_error_envelope(response, "CHROMIUM_EXECUTABLE_NOT_FOUND", "chromium-missing-exe")
    lookup = lookup_by_detail_ref(store_root, error["detailRef"])
    assert lookup["found"] is True
    assert lookup["entries"][0]["event"] == "sidecar.request"
    assert lookup["entries"][0]["method"] == "chromium.launch"
    assert lookup["entries"][0]["errorCode"] == "CHROMIUM_EXECUTABLE_NOT_FOUND"
    assert lookup["entries"][0]["detailRef"] == error["detailRef"]
    assert_redacted_log_text(store_root, store_root, str(missing_executable), profile["name"])


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlink support is required for partial copy fixture")
def test_legacy_import_outcome_diagnostics_are_persisted_per_failed_or_partial_item(tmp_path):
    from theprivator_sidecar.diagnostics import lookup_by_detail_ref

    legacy_root = tmp_path / "legacy-root-should-not-leak"
    store_root = str(tmp_path / "app-data-should-not-leak")
    partial_name = "Partial Secret Name"
    stale_name = "Stale Secret Name"
    write_legacy_config(
        legacy_root / "partial",
        {
            "name": partial_name,
            "proxy_user": "legacy-user-should-not-leak",
            "proxy_pass": "legacy-pass-should-not-leak",
            "absolute_path": str(tmp_path / "secret-path-should-not-leak"),
        },
    )
    partial_user_data = legacy_root / "partial" / "user-data"
    partial_user_data.mkdir(parents=True)
    outside_secret = tmp_path / "outside-secret-should-not-leak.txt"
    outside_secret.write_text("outside-secret-should-not-leak", encoding="utf-8")
    (partial_user_data / "unsafe-link").symlink_to(outside_secret)

    scan_proc = run_sidecar(
        request_line(
            {
                "id": "legacy-scan-for-diagnostics",
                "method": "legacy.scan",
                "params": {"storeRoot": store_root, "legacyRoot": str(legacy_root)},
            }
        )
    )
    candidate = parse_ndjson(scan_proc.stdout)[0]["result"]["candidates"][0]

    import_proc = run_sidecar(
        request_line(
            {
                "id": "legacy-import-diagnostics",
                "method": "legacy.import",
                "params": {
                    "storeRoot": store_root,
                    "legacyRoot": str(legacy_root),
                    "items": [
                        {"legacyId": candidate["legacyId"], "targetName": partial_name},
                        {"legacyId": "legacy-stale-selection", "targetName": stale_name},
                    ],
                },
            }
        )
    )

    response = parse_ndjson(import_proc.stdout)[0]
    diagnostics = parse_ndjson(import_proc.stderr)
    assert response["ok"] is True
    assert response["result"]["partialCount"] == 1
    assert response["result"]["failedCount"] == 1
    outcome_diagnostics = [item for item in diagnostics if item["event"] == "legacy.import.outcome"]
    assert len(outcome_diagnostics) == 2

    for stderr_outcome in outcome_diagnostics:
        lookup = lookup_by_detail_ref(store_root, stderr_outcome["detailRef"])
        assert lookup["found"] is True
        assert lookup["entries"][0]["event"] == "legacy.import.outcome"
        assert lookup["entries"][0]["method"] == "legacy.import"
        assert lookup["entries"][0]["status"] in {"partial", "failed"}
        assert lookup["entries"][0]["errorCode"] == stderr_outcome["errorCode"]
        assert lookup["entries"][0]["detailRef"] == stderr_outcome["detailRef"]
        assert lookup["entries"][0]["context"] == {"legacyId": stderr_outcome["legacyId"]}

    assert_redacted_log_text(
        store_root,
        str(legacy_root),
        store_root,
        partial_name,
        stale_name,
        "legacy-user-should-not-leak",
        "legacy-pass-should-not-leak",
        "secret-path-should-not-leak",
        "outside-secret-should-not-leak",
    )


def test_lookup_skips_malformed_rows_and_retention_keeps_latest_records(tmp_path):
    from theprivator_sidecar.diagnostics import MAX_LOG_LINES, append_events, lookup_by_detail_ref

    store_root = tmp_path / "app-data"
    log_path = diagnostics_log_path(store_root)
    log_path.parent.mkdir(parents=True)
    log_path.write_text("not-json\n", encoding="utf-8")

    events = []
    for index in range(MAX_LOG_LINES + 5):
        detail_ref = f"sidecar-retention-{index:04x}"
        events.append(
            {
                "event": "sidecar.request",
                "requestId": f"retain-{index}",
                "method": "profiles.create",
                "status": "error",
                "durationMs": 1,
                "errorCode": "PROFILE_INVALID_NAME",
                "detailRef": detail_ref,
            }
        )

    result = append_events(store_root, events)

    assert result["ok"] is True
    records = read_log_records(store_root)
    assert len(records) == MAX_LOG_LINES
    assert records[0]["detailRef"] == "sidecar-retention-0005"
    assert records[-1]["detailRef"] == f"sidecar-retention-{MAX_LOG_LINES + 4:04x}"
    assert lookup_by_detail_ref(store_root, "sidecar-retention-0000") == {
        "found": False,
        "logPath": "profile-store/diagnostics/events.jsonl",
        "entries": [],
    }
    newest_lookup = lookup_by_detail_ref(store_root, records[-1]["detailRef"])
    assert newest_lookup["found"] is True
    assert newest_lookup["entries"] == [records[-1]]


def test_diagnostic_append_failure_does_not_replace_user_facing_command_error(tmp_path):
    store_root = tmp_path / "app-data"
    diagnostics_parent = store_root / "profile-store" / "diagnostics"
    diagnostics_parent.parent.mkdir(parents=True)
    diagnostics_parent.write_text("not-a-directory", encoding="utf-8")

    proc = run_sidecar(
        request_line(
            {
                "id": "profile-invalid-with-diagnostic-write-failure",
                "method": "profiles.create",
                "params": {"storeRoot": str(store_root), "name": "bad/name"},
            }
        )
    )

    response = parse_ndjson(proc.stdout)[0]
    diagnostics = parse_ndjson(proc.stderr)
    error = assert_error_envelope(
        response,
        "PROFILE_INVALID_NAME",
        "profile-invalid-with-diagnostic-write-failure",
    )
    assert diagnostics[0]["errorCode"] == "PROFILE_INVALID_NAME"
    assert diagnostics[0]["detailRef"] == error["detailRef"]
    assert all(str(store_root) not in json.dumps(diagnostic) for diagnostic in diagnostics)
    assert "Traceback" not in proc.stdout
    assert "Traceback" not in proc.stderr
