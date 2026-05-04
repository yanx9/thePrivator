"""Contract tests for the ThePrivator Python sidecar NDJSON protocol."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from theprivator import __version__ as app_version

REPO_ROOT = Path(__file__).resolve().parents[2]


def run_sidecar(input_text):
    """Run the sidecar module with isolated stdin/stdout/stderr streams."""
    return subprocess.run(
        [sys.executable, "-m", "theprivator_sidecar"],
        input=input_text,
        text=True,
        capture_output=True,
        cwd=REPO_ROOT,
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
