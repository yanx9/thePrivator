"""Contract tests for the ThePrivator Python sidecar NDJSON protocol."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from theprivator import __version__ as app_version

REPO_ROOT = Path(__file__).resolve().parents[2]


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
    assert isinstance(response["durationMs"], (int, float))

    error = response["error"]
    assert error["code"] == code
    assert error["message"]
    assert error["recoverable"] is True
    assert error["detailRef"].startswith("sidecar-")
    return error


def make_fake_chromium(tmp_path):
    script = tmp_path / "fake-chromium"
    script.write_text(
        "\n".join(
            [
                f"#!{sys.executable}",
                "import json",
                "import os",
                "import signal",
                "import sys",
                "import time",
                "capture = os.environ.get('THEPRIVATOR_FAKE_CHROMIUM_ARGV')",
                "if capture:",
                "    with open(capture, 'w', encoding='utf-8') as handle:",
                "        json.dump(sys.argv, handle)",
                "def handle_term(signum, frame):",
                "    raise SystemExit(0)",
                "signal.signal(signal.SIGTERM, handle_term)",
                "while True:",
                "    time.sleep(0.1)",
                "",
            ]
        ),
        encoding="utf-8",
    )
    script.chmod(0o755)
    return script


def test_health_status_success_returns_runtime_metadata_and_diagnostics():
    proc = run_sidecar(
        request_line({"id": "health-1", "method": "health.status", "params": {}})
    )

    assert proc.returncode == 0
    responses = parse_ndjson(proc.stdout)
    diagnostics = parse_ndjson(proc.stderr)
    assert len(responses) == 1
    assert len(diagnostics) == 1

    response = responses[0]
    assert response["id"] == "health-1"
    assert response["ok"] is True
    assert response["protocolVersion"] == "1.0.0"
    assert isinstance(response["durationMs"], (int, float))

    result = response["result"]
    assert result["status"] in {"healthy", "degraded"}
    assert result["product"] == {"name": "ThePrivator", "version": app_version}
    assert result["sidecar"] == {"version": "0.1.0"}
    assert result["protocol"] == {"version": "1.0.0"}
    assert result["runtime"]["pythonVersion"]
    assert result["runtime"]["implementation"]
    assert result["platform"]["system"]
    assert "request" in result
    assert isinstance(result["request"]["durationMs"], (int, float))

    diagnostic = diagnostics[0]
    assert diagnostic == {
        "event": "sidecar.request",
        "requestId": "health-1",
        "method": "health.status",
        "status": "ok",
        "durationMs": diagnostic["durationMs"],
        "errorCode": None,
        "detailRef": None,
    }


def test_diagnostics_fail_returns_typed_recoverable_error_without_stack_trace_or_param_leak():
    secret = "secret-token-should-not-leak"
    profile_path = "/tmp/theprivator-profile-should-not-leak"
    proc = run_sidecar(
        request_line(
            {
                "id": "fail-1",
                "method": "diagnostics.fail",
                "params": {"token": secret, "profilePath": profile_path},
            }
        )
    )

    assert proc.returncode == 0
    response = parse_ndjson(proc.stdout)[0]
    diagnostic = parse_ndjson(proc.stderr)[0]
    error = assert_error_envelope(response, "DIAGNOSTIC_FAILURE", "fail-1")
    assert error["message"] == "Diagnostic failure requested."
    assert diagnostic["event"] == "sidecar.request"
    assert diagnostic["requestId"] == "fail-1"
    assert diagnostic["method"] == "diagnostics.fail"
    assert diagnostic["status"] == "error"
    assert diagnostic["errorCode"] == "DIAGNOSTIC_FAILURE"
    assert diagnostic["detailRef"] == error["detailRef"]

    combined_output = proc.stdout + proc.stderr
    assert "Traceback" not in proc.stdout
    assert secret not in combined_output
    assert profile_path not in combined_output
    assert "params" not in proc.stderr


@pytest.mark.parametrize(
    ("input_text", "expected_id"),
    [
        ("\n", None),
        ('{"id":"bad-json", "method": "health.status"\n', None),
        (request_line({"method": "health.status", "params": {}}), None),
        (request_line({"id": "missing-method", "params": {}}), "missing-method"),
        (
            request_line(
                {"id": "bad-params", "method": "health.status", "params": ["not", "object"]}
            ),
            "bad-params",
        ),
    ],
)
def test_malformed_inputs_return_invalid_request_without_tracebacks(input_text, expected_id):
    proc = run_sidecar(input_text)

    assert proc.returncode == 0
    response = parse_ndjson(proc.stdout)[0]
    diagnostic = parse_ndjson(proc.stderr)[0]
    error = assert_error_envelope(response, "INVALID_REQUEST", expected_id)
    assert "Traceback" not in proc.stdout
    assert diagnostic["event"] == "sidecar.request"
    assert diagnostic["status"] == "error"
    assert diagnostic["errorCode"] == "INVALID_REQUEST"
    assert diagnostic["detailRef"] == error["detailRef"]


@pytest.mark.parametrize("method", ["unknown.command", "   "])
def test_unknown_or_blank_method_is_recoverable(method):
    proc = run_sidecar(request_line({"id": "method-1", "method": method, "params": {}}))

    response = parse_ndjson(proc.stdout)[0]
    diagnostic = parse_ndjson(proc.stderr)[0]

    if method.strip():
        error = assert_error_envelope(response, "UNKNOWN_COMMAND", "method-1")
        assert diagnostic["errorCode"] == "UNKNOWN_COMMAND"
        assert diagnostic["method"] == method
    else:
        error = assert_error_envelope(response, "INVALID_REQUEST", "method-1")
        assert diagnostic["errorCode"] == "INVALID_REQUEST"
        assert diagnostic["method"] is None

    assert diagnostic["detailRef"] == error["detailRef"]


def test_multiple_ndjson_requests_each_produce_one_response_and_echo_ids_exactly():
    proc = run_sidecar(
        request_line({"id": "first", "method": "health.status", "params": {}})
        + request_line({"id": 42, "method": "diagnostics.fail", "params": {}})
    )

    assert proc.returncode == 0
    responses = parse_ndjson(proc.stdout)
    diagnostics = parse_ndjson(proc.stderr)
    assert len(responses) == 2
    assert len(diagnostics) == 2
    assert responses[0]["id"] == "first"
    assert responses[0]["ok"] is True
    assert responses[1]["id"] == 42
    assert responses[1]["ok"] is False
    assert responses[1]["error"]["code"] == "DIAGNOSTIC_FAILURE"
    assert diagnostics[0]["requestId"] == "first"
    assert diagnostics[1]["requestId"] == 42


def test_profiles_create_list_update_delete_persist_across_fresh_sidecar_invocations(tmp_path):
    store_root = str(tmp_path / "app-data")

    create_proc = run_sidecar(
        request_line(
            {
                "id": "profile-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "Research"},
            }
        )
    )
    create_response = parse_ndjson(create_proc.stdout)[0]
    create_diagnostic = parse_ndjson(create_proc.stderr)[0]
    assert create_proc.returncode == 0
    assert create_response["ok"] is True
    assert create_response["result"]["storeVersion"] == 1
    assert create_response["result"]["count"] == 1
    profile = create_response["result"]["profile"]
    assert profile["name"] == "Research"
    assert profile["defaults"] == {
        "browser": "chromium",
        "startUrl": "about:blank",
        "proxyMode": "direct",
        "fingerprintMode": "disabled",
    }
    assert profile["storage"] == {
        "profileDir": f"profile-store/profiles/{profile['id']}",
        "userDataDir": f"profile-store/profiles/{profile['id']}/user-data",
    }
    assert create_diagnostic["event"] == "sidecar.request"
    assert create_diagnostic["method"] == "profiles.create"
    assert create_diagnostic["status"] == "ok"
    assert create_diagnostic["errorCode"] is None
    assert create_diagnostic["detailRef"] is None

    list_proc = run_sidecar(
        request_line(
            {
                "id": "profile-list",
                "method": "profiles.list",
                "params": {"storeRoot": store_root},
            }
        )
    )
    list_response = parse_ndjson(list_proc.stdout)[0]
    assert list_response["ok"] is True
    assert list_response["result"]["profiles"] == [profile]

    update_proc = run_sidecar(
        request_line(
            {
                "id": "profile-update",
                "method": "profiles.update",
                "params": {"storeRoot": store_root, "id": profile["id"], "name": "Renamed"},
            }
        )
    )
    update_response = parse_ndjson(update_proc.stdout)[0]
    assert update_response["ok"] is True
    assert update_response["result"]["profile"]["name"] == "Renamed"
    assert update_response["result"]["profiles"] == [update_response["result"]["profile"]]
    assert update_response["result"]["count"] == 1

    delete_proc = run_sidecar(
        request_line(
            {
                "id": "profile-delete",
                "method": "profiles.delete",
                "params": {"storeRoot": store_root, "id": profile["id"]},
            }
        )
    )
    delete_response = parse_ndjson(delete_proc.stdout)[0]
    assert delete_response["ok"] is True
    assert delete_response["result"] == {"storeVersion": 1, "profiles": [], "count": 0}


def test_profiles_diagnostics_are_redacted_even_when_stdout_contains_profile_data(tmp_path):
    store_root = str(tmp_path / "app-data-path-should-not-leak")
    profile_name = "Visible Profile Name"
    proc = run_sidecar(
        request_line(
            {
                "id": "profile-redaction",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": profile_name},
            }
        )
    )

    response = parse_ndjson(proc.stdout)[0]
    diagnostic = parse_ndjson(proc.stderr)[0]
    assert response["ok"] is True
    assert response["result"]["profile"]["name"] == profile_name
    assert diagnostic == {
        "event": "sidecar.request",
        "requestId": "profile-redaction",
        "method": "profiles.create",
        "status": "ok",
        "durationMs": diagnostic["durationMs"],
        "errorCode": None,
        "detailRef": None,
    }
    assert store_root not in proc.stderr
    assert profile_name not in proc.stderr
    assert "params" not in proc.stderr


def test_profiles_duplicate_invalid_not_found_and_corrupt_store_use_typed_error_envelopes(tmp_path):
    store_root = str(tmp_path / "app-data")
    run_sidecar(
        request_line(
            {
                "id": "profile-seed",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "Research"},
            }
        )
    )

    duplicate_proc = run_sidecar(
        request_line(
            {
                "id": "profile-duplicate",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "research"},
            }
        )
    )
    duplicate_response = parse_ndjson(duplicate_proc.stdout)[0]
    duplicate_diagnostic = parse_ndjson(duplicate_proc.stderr)[0]
    duplicate_error = assert_error_envelope(
        duplicate_response, "PROFILE_DUPLICATE_NAME", "profile-duplicate"
    )
    assert duplicate_diagnostic["method"] == "profiles.create"
    assert duplicate_diagnostic["status"] == "error"
    assert duplicate_diagnostic["errorCode"] == "PROFILE_DUPLICATE_NAME"
    assert duplicate_diagnostic["detailRef"] == duplicate_error["detailRef"]
    assert store_root not in duplicate_proc.stderr
    assert "research" not in duplicate_proc.stderr
    assert "Traceback" not in duplicate_proc.stdout
    assert "Traceback" not in duplicate_proc.stderr

    invalid_proc = run_sidecar(
        request_line(
            {
                "id": "profile-invalid",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "bad/name"},
            }
        )
    )
    assert_error_envelope(parse_ndjson(invalid_proc.stdout)[0], "PROFILE_INVALID_NAME", "profile-invalid")

    not_found_proc = run_sidecar(
        request_line(
            {
                "id": "profile-not-found",
                "method": "profiles.update",
                "params": {"storeRoot": store_root, "id": "missing", "name": "Still Missing"},
            }
        )
    )
    assert_error_envelope(parse_ndjson(not_found_proc.stdout)[0], "PROFILE_NOT_FOUND", "profile-not-found")

    store_file = tmp_path / "corrupt-app-data" / "profile-store" / "profiles.json"
    store_file.parent.mkdir(parents=True)
    store_file.write_text("{not-json", encoding="utf-8")
    corrupt_proc = run_sidecar(
        request_line(
            {
                "id": "profile-corrupt",
                "method": "profiles.list",
                "params": {"storeRoot": str(tmp_path / "corrupt-app-data")},
            }
        )
    )
    assert_error_envelope(parse_ndjson(corrupt_proc.stdout)[0], "PROFILE_STORE_CORRUPT", "profile-corrupt")
    assert "Traceback" not in corrupt_proc.stdout
    assert "Traceback" not in corrupt_proc.stderr


@pytest.mark.parametrize(
    "payload",
    [
        {"id": "missing-store", "method": "profiles.list", "params": {}},
        {"id": "bad-store", "method": "profiles.list", "params": {"storeRoot": 42}},
        {"id": "missing-name", "method": "profiles.create", "params": {"storeRoot": "root"}},
        {"id": "missing-id", "method": "profiles.delete", "params": {"storeRoot": "root"}},
        {"id": "chromium-missing-store", "method": "chromium.status", "params": {}},
        {"id": "chromium-bad-store", "method": "chromium.status", "params": {"storeRoot": 42}},
        {
            "id": "chromium-missing-profile",
            "method": "chromium.launch",
            "params": {"storeRoot": "root"},
        },
        {
            "id": "chromium-blank-profile",
            "method": "chromium.stop",
            "params": {"storeRoot": "root", "profileId": "   "},
        },
    ],
)
def test_profiles_malformed_params_return_invalid_request(payload):
    proc = run_sidecar(request_line(payload))

    response = parse_ndjson(proc.stdout)[0]
    diagnostic = parse_ndjson(proc.stderr)[0]
    error = assert_error_envelope(response, "INVALID_REQUEST", payload["id"])
    assert diagnostic["event"] == "sidecar.request"
    assert diagnostic["method"] == payload["method"]
    assert diagnostic["status"] == "error"
    assert diagnostic["errorCode"] == "INVALID_REQUEST"
    assert diagnostic["detailRef"] == error["detailRef"]
    assert "Traceback" not in proc.stdout
    assert "Traceback" not in proc.stderr


def test_chromium_launch_status_stop_sidecar_contract_redacts_runtime_details(tmp_path):
    store_root = str(tmp_path / "app-data-path-should-not-leak")
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "argv-should-not-leak.json"
    env = {
        "THEPRIVATOR_CHROMIUM_PATH": str(fake_chromium),
        "THEPRIVATOR_FAKE_CHROMIUM_ARGV": str(argv_capture),
    }

    create_proc = run_sidecar(
        request_line(
            {
                "id": "chromium-profile-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "Launch Me"},
            }
        )
    )
    profile = parse_ndjson(create_proc.stdout)[0]["result"]["profile"]

    try:
        launch_proc = run_sidecar(
            request_line(
                {
                    "id": "chromium-launch",
                    "method": "chromium.launch",
                    "params": {"storeRoot": store_root, "profileId": profile["id"]},
                }
            ),
            env=env,
        )
        launch_response = parse_ndjson(launch_proc.stdout)[0]
        launch_diagnostic = parse_ndjson(launch_proc.stderr)[0]
        assert launch_response["ok"] is True
        launch = launch_response["result"]
        assert launch["profileId"] == profile["id"]
        assert launch["status"] == "running"
        assert launch["pid"] > 0
        assert launch["startedAt"].endswith("Z")
        assert launch["runningCount"] == 1
        assert launch["userDataDir"] == profile["storage"]["userDataDir"]
        assert launch_diagnostic == {
            "event": "sidecar.request",
            "requestId": "chromium-launch",
            "method": "chromium.launch",
            "status": "ok",
            "durationMs": launch_diagnostic["durationMs"],
            "errorCode": None,
            "detailRef": None,
        }

        status_proc = run_sidecar(
            request_line(
                {
                    "id": "chromium-status",
                    "method": "chromium.status",
                    "params": {"storeRoot": store_root},
                }
            )
        )
        status_response = parse_ndjson(status_proc.stdout)[0]
        assert status_response["ok"] is True
        assert status_response["result"]["runningCount"] == 1
        assert status_response["result"]["profiles"][0]["pid"] == launch["pid"]
        assert status_response["result"]["profiles"][0]["startedAt"] == launch["startedAt"]

        stop_proc = run_sidecar(
            request_line(
                {
                    "id": "chromium-stop",
                    "method": "chromium.stop",
                    "params": {"storeRoot": store_root, "profileId": profile["id"]},
                }
            )
        )
        stop_response = parse_ndjson(stop_proc.stdout)[0]
        stop_diagnostic = parse_ndjson(stop_proc.stderr)[0]
        assert stop_response["ok"] is True
        assert stop_response["result"]["status"] == "stopped"
        assert stop_response["result"]["termination"] in {"graceful", "reconciled"}
        assert stop_response["result"]["runningCount"] == 0
        assert stop_diagnostic["method"] == "chromium.stop"
        assert stop_diagnostic["status"] == "ok"

        combined = (
            launch_proc.stdout
            + launch_proc.stderr
            + status_proc.stdout
            + status_proc.stderr
            + stop_proc.stdout
            + stop_proc.stderr
        )
        assert store_root not in combined
        assert str(fake_chromium) not in combined
        assert str(argv_capture) not in combined
        assert "--user-data-dir" not in combined
        assert "Traceback" not in combined
    finally:
        run_sidecar(
            request_line(
                {
                    "id": "chromium-cleanup",
                    "method": "chromium.stop",
                    "params": {"storeRoot": store_root, "profileId": profile["id"]},
                }
            )
        )

    stored_profile = json.loads(
        Path(store_root, "profile-store", "profiles.json").read_text(encoding="utf-8")
    )["profiles"][0]
    assert "pid" not in stored_profile
    assert "status" not in stored_profile
    assert "process" not in stored_profile
    assert "command" not in stored_profile


def test_chromium_missing_executable_sidecar_error_is_typed_and_redacted(tmp_path):
    store_root = str(tmp_path / "app-data-path-should-not-leak")
    create_proc = run_sidecar(
        request_line(
            {
                "id": "chromium-missing-exe-profile",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "No Browser"},
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
    diagnostic = parse_ndjson(proc.stderr)[0]
    error = assert_error_envelope(response, "CHROMIUM_EXECUTABLE_NOT_FOUND", "chromium-missing-exe")
    assert "THEPRIVATOR_CHROMIUM_PATH" in error["message"]
    assert diagnostic["event"] == "sidecar.request"
    assert diagnostic["method"] == "chromium.launch"
    assert diagnostic["status"] == "error"
    assert diagnostic["errorCode"] == "CHROMIUM_EXECUTABLE_NOT_FOUND"
    assert diagnostic["detailRef"] == error["detailRef"]
    combined = proc.stdout + proc.stderr
    assert store_root not in combined
    assert str(missing_executable) not in combined
    assert profile["name"] not in proc.stderr
    assert "Traceback" not in combined


def write_legacy_config(profile_dir: Path, payload: object) -> None:
    profile_dir.mkdir(parents=True, exist_ok=True)
    (profile_dir / "config.json").write_text(json.dumps(payload), encoding="utf-8")


def test_legacy_scan_ndjson_dispatch_returns_candidates_and_redacted_diagnostic(tmp_path):
    legacy_root = tmp_path / "legacy-root-should-not-leak"
    store_root = tmp_path / "app-data-should-not-leak"
    legacy_profile = legacy_root / "profile-one"
    write_legacy_config(
        legacy_profile,
        {
            "name": "Legacy Research",
            "proxy_user": "legacy-user-should-not-leak",
            "proxy_pass": "legacy-pass-should-not-leak",
            "absolute_path": str(tmp_path / "secret-path-should-not-leak"),
        },
    )
    (legacy_profile / "user-data" / "Default").mkdir(parents=True)

    proc = run_sidecar(
        request_line(
            {
                "id": "legacy-scan",
                "method": "legacy.scan",
                "params": {"storeRoot": str(store_root), "legacyRoot": str(legacy_root)},
            }
        )
    )

    assert proc.returncode == 0
    responses = parse_ndjson(proc.stdout)
    diagnostics = parse_ndjson(proc.stderr)
    assert len(responses) == 1
    assert len(diagnostics) == 1
    response = responses[0]
    assert response["id"] == "legacy-scan"
    assert response["ok"] is True
    assert response["protocolVersion"] == "1.0.0"
    assert response["result"]["scanVersion"] == 1
    assert response["result"]["count"] == 1
    candidate = response["result"]["candidates"][0]
    assert candidate["legacyId"].startswith("legacy-")
    assert candidate["folderName"] == "profile-one"
    assert candidate["targetName"] == "Legacy Research"
    assert candidate["userData"] == {"status": "available"}

    diagnostic = diagnostics[0]
    assert diagnostic == {
        "event": "sidecar.request",
        "requestId": "legacy-scan",
        "method": "legacy.scan",
        "status": "ok",
        "durationMs": diagnostic["durationMs"],
        "errorCode": None,
        "detailRef": None,
    }
    combined = proc.stdout + proc.stderr
    assert str(legacy_root) not in combined
    assert str(store_root) not in proc.stderr
    assert "legacy-user-should-not-leak" not in combined
    assert "legacy-pass-should-not-leak" not in combined
    assert "secret-path-should-not-leak" not in combined
    assert "params" not in proc.stderr
    assert "Traceback" not in combined


def test_legacy_import_ndjson_dispatch_reports_success_partial_failed_and_redacted_outcome_diagnostics(tmp_path):
    legacy_root = tmp_path / "legacy-root-should-not-leak"
    store_root = tmp_path / "app-data-should-not-leak"
    write_legacy_config(legacy_root / "good", {"name": "Good Legacy"})
    (legacy_root / "good" / "user-data" / "Default").mkdir(parents=True)
    (legacy_root / "good" / "user-data" / "Default" / "Preferences").write_text(
        "copied-browser-data-should-not-leak",
        encoding="utf-8",
    )
    write_legacy_config(legacy_root / "partial", {"name": "Partial Legacy"})
    partial_user_data = legacy_root / "partial" / "user-data"
    partial_user_data.mkdir(parents=True)
    outside_secret = tmp_path / "outside-secret-should-not-leak.txt"
    outside_secret.write_text("outside-secret-should-not-leak", encoding="utf-8")
    (partial_user_data / "unsafe-link").symlink_to(outside_secret)

    scan_proc = run_sidecar(
        request_line(
            {
                "id": "legacy-scan-for-import",
                "method": "legacy.scan",
                "params": {"storeRoot": str(store_root), "legacyRoot": str(legacy_root)},
            }
        )
    )
    candidates = {
        candidate["folderName"]: candidate
        for candidate in parse_ndjson(scan_proc.stdout)[0]["result"]["candidates"]
    }

    import_proc = run_sidecar(
        request_line(
            {
                "id": "legacy-import",
                "method": "legacy.import",
                "params": {
                    "storeRoot": str(store_root),
                    "legacyRoot": str(legacy_root),
                    "items": [
                        {"legacyId": candidates["good"]["legacyId"], "targetName": "Imported Good"},
                        {"legacyId": candidates["partial"]["legacyId"], "targetName": "Imported Partial"},
                        {"legacyId": "legacy-stale-selection", "targetName": "Imported Stale"},
                    ],
                },
            }
        )
    )

    assert import_proc.returncode == 0
    response = parse_ndjson(import_proc.stdout)[0]
    diagnostics = parse_ndjson(import_proc.stderr)
    assert response["id"] == "legacy-import"
    assert response["ok"] is True
    result = response["result"]
    assert result["importVersion"] == 1
    assert result["requestedCount"] == 3
    assert result["successCount"] == 1
    assert result["partialCount"] == 1
    assert result["failedCount"] == 1
    outcomes = {outcome["targetName"]: outcome for outcome in result["outcomes"]}
    assert outcomes["Imported Good"]["status"] == "success"
    assert outcomes["Imported Good"]["copyStatus"] == "copied"
    assert outcomes["Imported Partial"]["status"] == "partial"
    assert outcomes["Imported Partial"]["copyStatus"] == "failed"
    assert outcomes["Imported Partial"]["error"]["code"] == "LEGACY_USER_DATA_COPY_FAILED"
    assert outcomes["Imported Stale"]["status"] == "failed"
    assert outcomes["Imported Stale"]["copyStatus"] == "skipped"
    assert outcomes["Imported Stale"]["error"]["code"] == "LEGACY_SELECTION_INVALID"

    request_diagnostic = diagnostics[0]
    assert request_diagnostic["event"] == "sidecar.request"
    assert request_diagnostic["method"] == "legacy.import"
    assert request_diagnostic["status"] == "ok"
    outcome_diagnostics = diagnostics[1:]
    assert len(outcome_diagnostics) == 2
    assert {
        diagnostic["legacyId"]: diagnostic["errorCode"] for diagnostic in outcome_diagnostics
    } == {
        candidates["partial"]["legacyId"]: "LEGACY_USER_DATA_COPY_FAILED",
        "legacy-stale-selection": "LEGACY_SELECTION_INVALID",
    }
    for diagnostic in outcome_diagnostics:
        assert set(diagnostic) == {"event", "legacyId", "status", "errorCode", "detailRef", "durationMs"}
        assert diagnostic["event"] == "legacy.import.outcome"
        assert diagnostic["status"] in {"partial", "failed"}
        assert isinstance(diagnostic["durationMs"], (int, float))
        assert diagnostic["detailRef"].startswith("sidecar-")

    combined = import_proc.stdout + import_proc.stderr
    assert str(legacy_root) not in combined
    assert str(store_root) not in import_proc.stderr
    assert str(outside_secret) not in combined
    assert "copied-browser-data-should-not-leak" not in combined
    assert "outside-secret-should-not-leak" not in combined
    assert "params" not in import_proc.stderr
    assert "Traceback" not in combined


def test_legacy_malformed_params_return_invalid_request(tmp_path):
    proc = run_sidecar(
        request_line(
            {
                "id": "legacy-bad-items",
                "method": "legacy.import",
                "params": {"storeRoot": str(tmp_path / "app"), "legacyRoot": str(tmp_path / "legacy"), "items": {}},
            }
        )
    )

    response = parse_ndjson(proc.stdout)[0]
    diagnostic = parse_ndjson(proc.stderr)[0]
    error = assert_error_envelope(response, "INVALID_REQUEST", "legacy-bad-items")
    assert diagnostic["event"] == "sidecar.request"
    assert diagnostic["method"] == "legacy.import"
    assert diagnostic["status"] == "error"
    assert diagnostic["errorCode"] == "INVALID_REQUEST"
    assert diagnostic["detailRef"] == error["detailRef"]
    assert "Traceback" not in proc.stdout
    assert "Traceback" not in proc.stderr
