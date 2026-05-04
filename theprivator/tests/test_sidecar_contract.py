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
