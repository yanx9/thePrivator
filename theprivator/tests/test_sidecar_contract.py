"""Contract tests for the ThePrivator Python sidecar NDJSON protocol."""

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from theprivator import __version__ as app_version
from theprivator_sidecar.identity import DEFAULT_REAL_IDENTITY, curated_preset

REPO_ROOT = Path(__file__).resolve().parents[2]
SENTINEL_USERNAME = "proxy-user-sentinel-e2e33f73"
SENTINEL_PASSWORD = "proxy-password-sentinel-74d86415"
SENTINEL_VALUES = (SENTINEL_USERNAME, SENTINEL_PASSWORD)
FORBIDDEN_PROXY_RUNTIME_MARKERS = (
    *SENTINEL_VALUES,
    "proxy-auth-extensions",
    "--proxy-server",
    "proxy-server",
    "--load-extension",
    "load-extension",
    "--remote-debugging-port",
    "remote-debugging",
    "DevToolsActivePort",
    "debugPort",
    "ws://",
    "wss://",
    "argv-should-not-leak",
)
PERSISTED_REQUEST_DIAGNOSTIC_KEYS = {
    "schemaVersion",
    "ts",
    "source",
    "event",
    "status",
    "logPath",
    "requestId",
    "method",
    "durationMs",
    "errorCode",
    "detailRef",
}


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


def read_store_payload(store_root):
    return json.loads(Path(store_root, "profile-store", "profiles.json").read_text(encoding="utf-8"))


def assert_no_proxy_secret_values(text):
    for sentinel in SENTINEL_VALUES:
        assert sentinel not in text


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
                "devtools_content = os.environ.get('THEPRIVATOR_FAKE_CHROMIUM_DEVTOOLS_CONTENT')",
                "if devtools_content is not None:",
                "    for arg in sys.argv[1:]:",
                "        if arg.startswith('--user-data-dir='):",
                "            user_data_dir = arg.split('=', 1)[1]",
                "            os.makedirs(user_data_dir, exist_ok=True)",
                "            with open(os.path.join(user_data_dir, 'DevToolsActivePort'), 'w', encoding='utf-8') as handle:",
                "                handle.write(devtools_content)",
                "            break",
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


def with_identity_change(identity, path, value):
    changed = copy.deepcopy(identity)
    target = changed
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return changed


def warning_codes(result):
    warnings = result["warnings"]
    for warning in warnings:
        assert set(warning) == {"code", "message", "surface", "path"}
        assert warning["code"].startswith("IDENTITY_")
        assert warning["message"]
        assert warning["path"].startswith(warning["surface"])
    return {warning["code"] for warning in warnings}


def assert_redacted_stderr(*procs, store_root, profile_name=None):
    stderr = "".join(proc.stderr for proc in procs)
    assert store_root not in stderr
    if profile_name is not None:
        assert profile_name not in stderr
    assert "params" not in stderr
    assert "debugPort" not in stderr
    assert "9222" not in stderr
    assert "proxy-user-sentinel" not in stderr
    assert "proxy-password-sentinel" not in stderr
    assert "Traceback" not in stderr


def assert_proxy_failure_lookup_entry(entry, *, request_id, code, detail_ref):
    assert set(entry) == PERSISTED_REQUEST_DIAGNOSTIC_KEYS
    assert entry["schemaVersion"] == 1
    assert entry["source"] == "python-sidecar"
    assert entry["event"] == "sidecar.request"
    assert entry["status"] == "error"
    assert entry["requestId"] == request_id
    assert entry["method"] == "chromium.launch"
    assert isinstance(entry["durationMs"], (int, float))
    assert entry["durationMs"] >= 0
    assert entry["errorCode"] == code
    assert entry["detailRef"] == detail_ref
    assert entry["logPath"] == "profile-store/diagnostics/events.jsonl"
    encoded = json.dumps(entry, sort_keys=True)
    for marker in FORBIDDEN_PROXY_RUNTIME_MARKERS:
        assert marker not in encoded


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


def test_proxy_validate_is_pure_redacted_and_does_not_persist_when_store_root_is_supplied(tmp_path):
    store_root = str(tmp_path / "proxy-validate-store-should-not-be-created")
    direct_proc = run_sidecar(
        request_line(
            {
                "id": "proxy-validate-direct",
                "method": "proxy.validate",
                "params": {"proxy": {"proxyVersion": 1, "mode": "direct"}},
            }
        )
    )
    fixed_proc = run_sidecar(
        request_line(
            {
                "id": "proxy-validate-fixed",
                "method": "proxy.validate",
                "params": {
                    "storeRoot": store_root,
                    "proxy": {
                        "proxyVersion": 1,
                        "mode": "fixedServer",
                        "protocol": "https",
                        "host": " proxy.example.invalid ",
                        "port": 443,
                        "credentials": {
                            "username": SENTINEL_USERNAME,
                            "password": SENTINEL_PASSWORD,
                        },
                    },
                },
            }
        )
    )

    direct_response = parse_ndjson(direct_proc.stdout)[0]
    fixed_response = parse_ndjson(fixed_proc.stdout)[0]
    assert direct_response["ok"] is True
    assert direct_response["result"] == {
        "proxyVersion": 1,
        "proxy": {
            "proxyVersion": 1,
            "mode": "direct",
            "credentialState": "none",
            "summary": "Direct connection",
        },
        "warnings": [],
    }
    assert fixed_response["ok"] is True
    assert fixed_response["result"] == {
        "proxyVersion": 1,
        "proxy": {
            "proxyVersion": 1,
            "mode": "fixedServer",
            "protocol": "https",
            "host": "proxy.example.invalid",
            "port": 443,
            "credentialState": "configured",
            "summary": "https://proxy.example.invalid:443",
        },
        "warnings": [],
    }
    assert parse_ndjson(direct_proc.stderr)[0]["method"] == "proxy.validate"
    assert parse_ndjson(fixed_proc.stderr)[0]["method"] == "proxy.validate"
    assert_no_proxy_secret_values(direct_proc.stdout + direct_proc.stderr + fixed_proc.stdout + fixed_proc.stderr)
    assert not Path(store_root, "profile-store", "profiles.json").exists()
    assert not Path(store_root, "profile-store", "diagnostics", "events.jsonl").exists()


@pytest.mark.parametrize(
    ("proxy", "expected_code"),
    [
        (None, "PROXY_INVALID"),
        ("not-an-object", "PROXY_INVALID"),
        ({"proxyVersion": 1, "mode": "system"}, "PROXY_PAC_UNSUPPORTED"),
        ({"proxyVersion": 1, "mode": "direct", "unknown": True}, "PROXY_INVALID"),
        ({"proxyVersion": 1, "mode": "direct", "debugPort": 9222}, "PROXY_INVALID"),
        (
            {
                "proxyVersion": 1,
                "mode": "fixedServer",
                "protocol": "http",
                "host": "proxy.example.invalid",
                "port": 8080,
                "credentials": {"username": SENTINEL_USERNAME, "password": ""},
            },
            "PROXY_INVALID",
        ),
    ],
)
def test_proxy_validate_rejects_malformed_inputs_without_echoing_proxy_drafts(proxy, expected_code):
    proc = run_sidecar(
        request_line(
            {
                "id": "proxy-validate-invalid",
                "method": "proxy.validate",
                "params": {} if proxy is None else {"proxy": proxy},
            }
        )
    )

    response = parse_ndjson(proc.stdout)[0]
    diagnostic = parse_ndjson(proc.stderr)[0]
    error = assert_error_envelope(response, expected_code, "proxy-validate-invalid")
    assert diagnostic["method"] == "proxy.validate"
    assert diagnostic["status"] == "error"
    assert diagnostic["errorCode"] == expected_code
    assert diagnostic["detailRef"] == error["detailRef"]
    combined = proc.stdout + proc.stderr
    assert_no_proxy_secret_values(combined)
    assert "9222" not in combined
    assert "debugPort" not in combined
    assert "unknown" not in combined
    assert "Traceback" not in combined


def test_profiles_proxy_update_persists_validated_proxy_and_returns_safe_profile_collection(tmp_path):
    store_root = str(tmp_path / "app-data-path-should-not-leak")
    create_proc = run_sidecar(
        request_line(
            {
                "id": "proxy-profile-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "Proxy Profile"},
            }
        )
    )
    profile = parse_ndjson(create_proc.stdout)[0]["result"]["profile"]

    direct_proc = run_sidecar(
        request_line(
            {
                "id": "proxy-update-direct",
                "method": "profiles.proxy.update",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "proxy": {"proxyVersion": 1, "mode": "direct"},
                },
            }
        )
    )
    fixed_proc = run_sidecar(
        request_line(
            {
                "id": "proxy-update-fixed",
                "method": "profiles.proxy.update",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "proxy": {
                        "proxyVersion": 1,
                        "mode": "fixedServer",
                        "protocol": "http",
                        "host": "proxy.example.invalid",
                        "port": 8080,
                        "credentials": {
                            "username": SENTINEL_USERNAME,
                            "password": SENTINEL_PASSWORD,
                        },
                    },
                },
            }
        )
    )

    direct_response = parse_ndjson(direct_proc.stdout)[0]
    fixed_response = parse_ndjson(fixed_proc.stdout)[0]
    assert direct_response["ok"] is True
    assert direct_response["result"]["profile"]["proxy"]["mode"] == "direct"
    assert fixed_response["ok"] is True
    result = fixed_response["result"]
    assert result["storeVersion"] == 3
    assert result["count"] == 1
    assert result["profiles"] == [result["profile"]]
    public_proxy = result["profile"]["proxy"]
    assert public_proxy == {
        "proxyVersion": 1,
        "mode": "fixedServer",
        "protocol": "http",
        "host": "proxy.example.invalid",
        "port": 8080,
        "credentialState": "configured",
        "summary": "http://proxy.example.invalid:8080",
    }
    assert "credentials" not in public_proxy
    assert_no_proxy_secret_values(direct_proc.stdout + direct_proc.stderr + fixed_proc.stdout + fixed_proc.stderr)

    stored_profile = read_store_payload(store_root)["profiles"][0]
    assert stored_profile["defaults"]["proxyMode"] == "fixedServer"
    assert stored_profile["proxy"]["credentials"] == {
        "username": SENTINEL_USERNAME,
        "password": SENTINEL_PASSWORD,
    }
    assert_redacted_stderr(create_proc, direct_proc, fixed_proc, store_root=store_root, profile_name="Proxy Profile")


def test_profiles_proxy_update_invalid_input_preserves_store_and_persists_redacted_diagnostic(tmp_path):
    from theprivator_sidecar.diagnostics import lookup_by_detail_ref

    store_root = str(tmp_path / "app-data-path-should-not-leak")
    create_proc = run_sidecar(
        request_line(
            {
                "id": "proxy-invalid-profile-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "Invalid Proxy Profile"},
            }
        )
    )
    profile = parse_ndjson(create_proc.stdout)[0]["result"]["profile"]
    original_payload = Path(store_root, "profile-store", "profiles.json").read_text(encoding="utf-8")

    proc = run_sidecar(
        request_line(
            {
                "id": "proxy-update-invalid",
                "method": "profiles.proxy.update",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "proxy": {
                        "proxyVersion": 1,
                        "mode": "fixedServer",
                        "protocol": "http",
                        "host": "proxy.example.invalid",
                        "port": 8080,
                        "credentials": {"username": SENTINEL_USERNAME, "password": ""},
                    },
                },
            }
        )
    )

    response = parse_ndjson(proc.stdout)[0]
    diagnostic = parse_ndjson(proc.stderr)[0]
    error = assert_error_envelope(response, "PROXY_INVALID", "proxy-update-invalid")
    assert diagnostic["method"] == "profiles.proxy.update"
    assert diagnostic["status"] == "error"
    assert diagnostic["errorCode"] == "PROXY_INVALID"
    assert diagnostic["detailRef"] == error["detailRef"]
    assert Path(store_root, "profile-store", "profiles.json").read_text(encoding="utf-8") == original_payload
    lookup = lookup_by_detail_ref(store_root, error["detailRef"])
    assert lookup["found"] is True
    assert lookup["entries"][0]["method"] == "profiles.proxy.update"
    assert lookup["entries"][0]["errorCode"] == "PROXY_INVALID"
    assert lookup["entries"][0]["detailRef"] == error["detailRef"]
    assert_no_proxy_secret_values(proc.stdout + proc.stderr + json.dumps(lookup, sort_keys=True))


def test_profiles_proxy_check_direct_profile_returns_safe_not_proven_contract(tmp_path):
    store_root = str(tmp_path / "proxy-check-direct-app-data-should-not-leak")
    create_proc = run_sidecar(
        request_line(
            {
                "id": "proxy-check-direct-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "Proxy Check Direct"},
            }
        )
    )
    profile = parse_ndjson(create_proc.stdout)[0]["result"]["profile"]

    proc = run_sidecar(
        request_line(
            {
                "id": "proxy-check-direct",
                "method": "profiles.proxy.check",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "checkerUrl": "https://attacker.example.invalid/should-not-be-used",
                },
            }
        )
    )

    response = parse_ndjson(proc.stdout)[0]
    diagnostic = parse_ndjson(proc.stderr)[0]
    assert response["id"] == "proxy-check-direct"
    assert response["ok"] is True
    result = response["result"]
    assert set(result) == {"proxyCheckVersion", "profileId", "proxy", "routeProof", "ipHiding", "webRtc", "publicCheckers"}
    assert result["proxyCheckVersion"] == 1
    assert result["profileId"] == profile["id"]
    assert result["routeProof"]["status"] == "not-run"
    assert result["ipHiding"] == {
        "status": "not-proven",
        "basis": "direct-profile",
        "scope": "not-applicable",
        "publicExitIpClaimed": False,
        "publicExitIp": None,
        "publicExitLocation": None,
        "localFixtureConclusion": "not-run",
    }
    assert result["publicCheckers"]["status"] == "advisory-only"
    assert [page["id"] for page in result["publicCheckers"]["pages"]] == [
        "cloudflare-trace",
        "aws-checkip",
        "webbrowsertools-webrtc",
    ]
    assert "attacker.example.invalid" not in proc.stdout
    assert diagnostic["method"] == "profiles.proxy.check"
    assert diagnostic["status"] == "ok"
    assert diagnostic["errorCode"] is None
    assert diagnostic["detailRef"] is None
    assert_redacted_stderr(create_proc, proc, store_root=store_root, profile_name="Proxy Check Direct")

    log_text = Path(store_root, "profile-store", "diagnostics", "events.jsonl").read_text(encoding="utf-8")
    assert "profiles.proxy.check" in log_text
    assert store_root not in log_text
    combined = create_proc.stdout + create_proc.stderr + proc.stdout + proc.stderr + log_text
    for marker in FORBIDDEN_PROXY_RUNTIME_MARKERS:
        assert marker not in combined


def test_profiles_proxy_check_socks_credentials_return_safe_success_contract(tmp_path):
    store_root = str(tmp_path / "proxy-check-socks-app-data-should-not-leak")
    create_proc = run_sidecar(
        request_line(
            {
                "id": "proxy-check-socks-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "Proxy Check Socks"},
            }
        )
    )
    profile = parse_ndjson(create_proc.stdout)[0]["result"]["profile"]
    update_proc = run_sidecar(
        request_line(
            {
                "id": "proxy-check-socks-update",
                "method": "profiles.proxy.update",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "proxy": {
                        "proxyVersion": 1,
                        "mode": "fixedServer",
                        "protocol": "socks5",
                        "host": "proxy.example.invalid",
                        "port": 9050,
                        "credentials": {
                            "username": SENTINEL_USERNAME,
                            "password": SENTINEL_PASSWORD,
                        },
                    },
                },
            }
        )
    )
    assert parse_ndjson(update_proc.stdout)[0]["ok"] is True

    proc = run_sidecar(
        request_line(
            {
                "id": "proxy-check-socks",
                "method": "profiles.proxy.check",
                "params": {"storeRoot": store_root, "profileId": profile["id"]},
            }
        )
    )

    response = parse_ndjson(proc.stdout)[0]
    diagnostic = parse_ndjson(proc.stderr)[0]
    assert response["id"] == "proxy-check-socks"
    assert response["ok"] is True
    result = response["result"]
    assert result["routeProof"]["status"] == "proved"
    assert result["routeProof"]["protocol"] == "socks5"
    assert result["routeProof"]["credentialState"] == "configured"
    assert result["proxy"]["credentialState"] == "configured"
    assert result["ipHiding"]["publicExitLocation"] is None
    assert diagnostic["method"] == "profiles.proxy.check"
    assert diagnostic["status"] == "ok"
    assert diagnostic["errorCode"] is None
    assert diagnostic["detailRef"] is None
    combined = create_proc.stdout + create_proc.stderr + update_proc.stdout + update_proc.stderr + proc.stdout + proc.stderr
    assert_no_proxy_secret_values(combined)
    for marker in FORBIDDEN_PROXY_RUNTIME_MARKERS:
        assert marker not in combined


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
    assert create_response["result"]["storeVersion"] == 3
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
    assert profile["identity"] == DEFAULT_REAL_IDENTITY
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
    assert delete_response["result"] == {"storeVersion": 3, "profiles": [], "count": 0}


def test_identity_commands_list_validate_apply_update_and_reload_with_redacted_diagnostics(tmp_path):
    store_root = str(tmp_path / "app-data-path-should-not-leak")
    profile_name = "Identity Profile Should Not Leak"

    create_proc = run_sidecar(
        request_line(
            {
                "id": "identity-profile-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": profile_name},
            }
        )
    )
    create_response = parse_ndjson(create_proc.stdout)[0]
    assert create_response["ok"] is True
    assert create_response["result"]["storeVersion"] == 3
    profile = create_response["result"]["profile"]
    assert profile["identity"] == DEFAULT_REAL_IDENTITY

    presets_proc = run_sidecar(
        request_line({"id": "identity-presets", "method": "identity.presets.list", "params": {}})
    )
    presets_response = parse_ndjson(presets_proc.stdout)[0]
    assert presets_response["ok"] is True
    presets_result = presets_response["result"]
    assert presets_result["identityVersion"] == 1
    assert presets_result["count"] == len(presets_result["presets"])
    preset_ids = [preset["presetId"] for preset in presets_result["presets"]]
    assert preset_ids == sorted(preset_ids)
    assert {"windows-10-chrome-120", "macos-ventura-chrome-120"} <= set(preset_ids)

    suspicious_identity = with_identity_change(
        with_identity_change(curated_preset("windows-10-chrome-120"), ["screen", "width"], 900),
        ["screen", "height"],
        1440,
    )
    validate_proc = run_sidecar(
        request_line(
            {
                "id": "identity-validate",
                "method": "identity.validate",
                "params": {"identity": suspicious_identity},
            }
        )
    )
    validate_response = parse_ndjson(validate_proc.stdout)[0]
    assert validate_response["ok"] is True
    assert validate_response["result"]["identity"] == suspicious_identity
    assert "IDENTITY_DESKTOP_PORTRAIT_SCREEN" in warning_codes(validate_response["result"])

    apply_proc = run_sidecar(
        request_line(
            {
                "id": "identity-apply-preset",
                "method": "profiles.identity.applyPreset",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "presetId": "macos-ventura-chrome-120",
                },
            }
        )
    )
    apply_response = parse_ndjson(apply_proc.stdout)[0]
    assert apply_response["ok"] is True
    assert apply_response["result"]["warnings"] == []
    assert apply_response["result"]["profile"]["identity"] == curated_preset("macos-ventura-chrome-120")

    update_proc = run_sidecar(
        request_line(
            {
                "id": "identity-update",
                "method": "profiles.identity.update",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "identity": suspicious_identity,
                },
            }
        )
    )
    update_response = parse_ndjson(update_proc.stdout)[0]
    assert update_response["ok"] is True
    assert update_response["result"]["profile"]["identity"] == suspicious_identity
    assert "IDENTITY_DESKTOP_PORTRAIT_SCREEN" in warning_codes(update_response["result"])

    reload_proc = run_sidecar(
        request_line(
            {
                "id": "identity-reload",
                "method": "profiles.list",
                "params": {"storeRoot": store_root},
            }
        )
    )
    reload_response = parse_ndjson(reload_proc.stdout)[0]
    assert reload_response["ok"] is True
    assert reload_response["result"]["profiles"][0]["identity"] == suspicious_identity

    assert_redacted_stderr(
        create_proc,
        presets_proc,
        validate_proc,
        apply_proc,
        update_proc,
        reload_proc,
        store_root=store_root,
        profile_name=profile_name,
    )


def test_identity_commands_return_typed_errors_without_persisting_bad_shapes_or_leaking_params(tmp_path):
    store_root = str(tmp_path / "app-data-path-should-not-leak")
    profile_name = "Invalid Identity Should Not Leak"
    create_proc = run_sidecar(
        request_line(
            {
                "id": "identity-error-profile",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": profile_name},
            }
        )
    )
    profile = parse_ndjson(create_proc.stdout)[0]["result"]["profile"]
    invalid_mode_identity = with_identity_change(
        curated_preset("windows-10-chrome-120"), ["browser", "mode"], "noise"
    )
    debug_port_identity = {**curated_preset("windows-10-chrome-120"), "debugPort": 9222}

    cases = [
        (
            {
                "id": "identity-validate-non-object",
                "method": "identity.validate",
                "params": {"identity": "not-an-object"},
            },
            "IDENTITY_INVALID",
        ),
        (
            {
                "id": "identity-apply-missing-preset",
                "method": "profiles.identity.applyPreset",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "presetId": "missing-preset",
                },
            },
            "IDENTITY_PRESET_NOT_FOUND",
        ),
        (
            {
                "id": "identity-update-invalid-mode",
                "method": "profiles.identity.update",
                "params": {"storeRoot": store_root, "profileId": profile["id"], "identity": invalid_mode_identity},
            },
            "IDENTITY_UNSUPPORTED_MODE",
        ),
        (
            {
                "id": "identity-update-debug-port",
                "method": "profiles.identity.update",
                "params": {"storeRoot": store_root, "profileId": profile["id"], "identity": debug_port_identity},
            },
            "IDENTITY_INVALID",
        ),
        (
            {
                "id": "identity-update-missing-profile",
                "method": "profiles.identity.update",
                "params": {
                    "storeRoot": store_root,
                    "profileId": "missing-profile",
                    "identity": curated_preset("windows-10-chrome-120"),
                },
            },
            "PROFILE_NOT_FOUND",
        ),
    ]

    procs = []
    for payload, expected_code in cases:
        proc = run_sidecar(request_line(payload))
        procs.append(proc)
        response = parse_ndjson(proc.stdout)[0]
        diagnostic = parse_ndjson(proc.stderr)[0]
        error = assert_error_envelope(response, expected_code, payload["id"])
        assert diagnostic["event"] == "sidecar.request"
        assert diagnostic["method"] == payload["method"]
        assert diagnostic["status"] == "error"
        assert diagnostic["errorCode"] == expected_code
        assert diagnostic["detailRef"] == error["detailRef"]

    reload_proc = run_sidecar(
        request_line(
            {
                "id": "identity-error-reload",
                "method": "profiles.list",
                "params": {"storeRoot": store_root},
            }
        )
    )
    assert parse_ndjson(reload_proc.stdout)[0]["result"]["profiles"][0]["identity"] == DEFAULT_REAL_IDENTITY
    assert_redacted_stderr(
        create_proc,
        *procs,
        reload_proc,
        store_root=store_root,
        profile_name=profile_name,
    )


def test_identity_audit_plan_and_unknown_open_are_dispatched_with_redacted_diagnostics(tmp_path):
    store_root = str(tmp_path / "audit-app-data-path-should-not-leak")
    profile_name = "Audit Profile Should Not Leak"
    create_proc = run_sidecar(
        request_line(
            {
                "id": "audit-profile-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": profile_name},
            }
        )
    )
    profile = parse_ndjson(create_proc.stdout)[0]["result"]["profile"]

    plan_proc = run_sidecar(
        request_line(
            {
                "id": "audit-plan",
                "method": "identity.audit.plan",
                "params": {"storeRoot": store_root, "profileId": profile["id"]},
            }
        )
    )
    plan_response = parse_ndjson(plan_proc.stdout)[0]
    plan_diagnostic = parse_ndjson(plan_proc.stderr)[0]
    assert plan_response["ok"] is True
    plan = plan_response["result"]
    assert plan["auditVersion"] == 1
    assert any(page["id"] == "browserleaks-webgl" for page in plan["pages"])
    assert not Path(store_root, "profile-store", "runtime").exists()
    assert plan_diagnostic == {
        "event": "sidecar.request",
        "requestId": "audit-plan",
        "method": "identity.audit.plan",
        "status": "ok",
        "durationMs": plan_diagnostic["durationMs"],
        "errorCode": None,
        "detailRef": None,
    }

    open_proc = run_sidecar(
        request_line(
            {
                "id": "audit-open-unknown",
                "method": "identity.audit.open",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "pageId": "missing-page",
                },
            }
        )
    )
    open_response = parse_ndjson(open_proc.stdout)[0]
    open_diagnostic = parse_ndjson(open_proc.stderr)[0]
    error = assert_error_envelope(open_response, "IDENTITY_AUDIT_PAGE_NOT_FOUND", "audit-open-unknown")
    assert open_diagnostic["event"] == "sidecar.request"
    assert open_diagnostic["method"] == "identity.audit.open"
    assert open_diagnostic["status"] == "error"
    assert open_diagnostic["errorCode"] == "IDENTITY_AUDIT_PAGE_NOT_FOUND"
    assert open_diagnostic["detailRef"] == error["detailRef"]
    assert not Path(store_root, "profile-store", "runtime").exists()

    combined = create_proc.stdout + create_proc.stderr + plan_proc.stdout + plan_proc.stderr + open_proc.stdout + open_proc.stderr
    assert store_root not in plan_proc.stderr + open_proc.stderr
    assert profile_name not in plan_proc.stderr + open_proc.stderr
    assert "missing-page" not in combined
    assert "DevToolsActivePort" not in combined
    assert "ws://" not in combined
    assert "--remote-debugging-port" not in combined
    assert "Traceback" not in combined


def test_profile_identity_command_corrupt_store_surfaces_existing_typed_error(tmp_path):
    store_root = tmp_path / "corrupt-app-data-path-should-not-leak"
    store_file = store_root / "profile-store" / "profiles.json"
    store_file.parent.mkdir(parents=True)
    store_file.write_text("{not-json", encoding="utf-8")

    proc = run_sidecar(
        request_line(
            {
                "id": "identity-corrupt-store",
                "method": "profiles.identity.applyPreset",
                "params": {
                    "storeRoot": str(store_root),
                    "profileId": "missing-profile",
                    "presetId": "windows-10-chrome-120",
                },
            }
        )
    )

    response = parse_ndjson(proc.stdout)[0]
    diagnostic = parse_ndjson(proc.stderr)[0]
    error = assert_error_envelope(response, "PROFILE_STORE_CORRUPT", "identity-corrupt-store")
    assert diagnostic["errorCode"] == "PROFILE_STORE_CORRUPT"
    assert diagnostic["detailRef"] == error["detailRef"]
    assert str(store_root) not in proc.stderr
    assert "Traceback" not in proc.stdout + proc.stderr


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
        {
            "id": "identity-apply-missing-store",
            "method": "profiles.identity.applyPreset",
            "params": {"profileId": "profile-id", "presetId": "windows-10-chrome-120"},
        },
        {
            "id": "identity-apply-bad-store",
            "method": "profiles.identity.applyPreset",
            "params": {"storeRoot": 42, "profileId": "profile-id", "presetId": "windows-10-chrome-120"},
        },
        {
            "id": "identity-apply-missing-profile",
            "method": "profiles.identity.applyPreset",
            "params": {"storeRoot": "root", "presetId": "windows-10-chrome-120"},
        },
        {
            "id": "identity-apply-blank-profile",
            "method": "profiles.identity.applyPreset",
            "params": {"storeRoot": "root", "profileId": "   ", "presetId": "windows-10-chrome-120"},
        },
        {
            "id": "identity-apply-missing-preset",
            "method": "profiles.identity.applyPreset",
            "params": {"storeRoot": "root", "profileId": "profile-id"},
        },
        {
            "id": "identity-apply-bad-preset",
            "method": "profiles.identity.applyPreset",
            "params": {"storeRoot": "root", "profileId": "profile-id", "presetId": 42},
        },
        {
            "id": "identity-update-missing-store",
            "method": "profiles.identity.update",
            "params": {"profileId": "profile-id", "identity": DEFAULT_REAL_IDENTITY},
        },
        {
            "id": "identity-update-missing-profile",
            "method": "profiles.identity.update",
            "params": {"storeRoot": "root", "identity": DEFAULT_REAL_IDENTITY},
        },
        {
            "id": "proxy-update-missing-store",
            "method": "profiles.proxy.update",
            "params": {"profileId": "profile-id", "proxy": {"proxyVersion": 1, "mode": "direct"}},
        },
        {
            "id": "proxy-update-bad-store",
            "method": "profiles.proxy.update",
            "params": {"storeRoot": 42, "profileId": "profile-id", "proxy": {"proxyVersion": 1, "mode": "direct"}},
        },
        {
            "id": "proxy-update-missing-profile",
            "method": "profiles.proxy.update",
            "params": {"storeRoot": "root", "proxy": {"proxyVersion": 1, "mode": "direct"}},
        },
        {
            "id": "proxy-update-blank-profile",
            "method": "profiles.proxy.update",
            "params": {"storeRoot": "root", "profileId": "   ", "proxy": {"proxyVersion": 1, "mode": "direct"}},
        },
        {
            "id": "audit-plan-missing-store",
            "method": "identity.audit.plan",
            "params": {"profileId": "profile-id"},
        },
        {
            "id": "audit-plan-blank-profile",
            "method": "identity.audit.plan",
            "params": {"storeRoot": "root", "profileId": "   "},
        },
        {
            "id": "audit-open-missing-page",
            "method": "identity.audit.open",
            "params": {"storeRoot": "root", "profileId": "profile-id"},
        },
        {
            "id": "audit-open-bad-page",
            "method": "identity.audit.open",
            "params": {"storeRoot": "root", "profileId": "profile-id", "pageId": 42},
        },
        {
            "id": "audit-collect-missing-store",
            "method": "identity.audit.collect",
            "params": {"profileId": "profile-id"},
        },
        {
            "id": "audit-collect-blank-profile",
            "method": "identity.audit.collect",
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


def test_proxy_runtime_diagnostics_keep_only_safe_failure_metadata(tmp_path):
    from theprivator_sidecar.diagnostics import append_events, lookup_by_detail_ref

    store_root = tmp_path / "proxy-runtime-diagnostics"
    failure_codes = [
        "PROXY_SOCKS_AUTH_UNSUPPORTED",
        "PROXY_AUTH_HELPER_FAILED",
        "PROXY_CONNECTIVITY_FAILED",
        "PROXY_PROOF_FAILED",
    ]
    safe_events = [
        {
            "event": "sidecar.request",
            "requestId": f"proxy-runtime-safe-{index}",
            "method": "chromium.launch",
            "status": "error",
            "durationMs": 1.5 + index,
            "errorCode": code,
            "detailRef": f"sidecar-proxy-safe-{index}",
        }
        for index, code in enumerate(failure_codes)
    ]
    unsafe_detail_refs = [
        "sidecar-proxy-server",
        "sidecar-proxy-auth-extensions",
        "sidecar-load-extension",
        "sidecar-remote-debugging-port",
        "sidecar-DevToolsActivePort",
        "sidecar-debugPort",
        "sidecar-argv",
    ]
    unsafe_events = [
        {**safe_events[0], "requestId": f"unsafe-proxy-runtime-{index}", "detailRef": detail_ref}
        for index, detail_ref in enumerate(unsafe_detail_refs)
    ]

    result = append_events(store_root, [*safe_events, *unsafe_events])

    assert result == {"ok": True, "written": len(safe_events), "skipped": False}
    for event in safe_events:
        lookup = lookup_by_detail_ref(store_root, event["detailRef"])
        assert lookup["found"] is True
        assert lookup["logPath"] == "profile-store/diagnostics/events.jsonl"
        assert len(lookup["entries"]) == 1
        assert_proxy_failure_lookup_entry(
            lookup["entries"][0],
            request_id=event["requestId"],
            code=event["errorCode"],
            detail_ref=event["detailRef"],
        )
    for detail_ref in unsafe_detail_refs:
        assert lookup_by_detail_ref(store_root, detail_ref) == {
            "found": False,
            "logPath": "profile-store/diagnostics/events.jsonl",
            "entries": [],
        }

    log_text = Path(store_root, "profile-store", "diagnostics", "events.jsonl").read_text(encoding="utf-8")
    for marker in FORBIDDEN_PROXY_RUNTIME_MARKERS:
        assert marker not in log_text


def test_socks4_proxy_credentials_chromium_launch_fails_before_spawn_with_diagnostic(tmp_path):
    from theprivator_sidecar.diagnostics import lookup_by_detail_ref

    store_root = str(tmp_path / "fixed-proxy-launch-app-data-should-not-leak")
    create_proc = run_sidecar(
        request_line(
            {
                "id": "fixed-launch-profile-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "Fixed Proxy Launch"},
            }
        )
    )
    profile = parse_ndjson(create_proc.stdout)[0]["result"]["profile"]
    update_proc = run_sidecar(
        request_line(
            {
                "id": "fixed-launch-proxy-update",
                "method": "profiles.proxy.update",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "proxy": {
                        "proxyVersion": 1,
                        "mode": "fixedServer",
                        "protocol": "socks4",
                        "host": "proxy.example.invalid",
                        "port": 9050,
                        "credentials": {
                            "username": SENTINEL_USERNAME,
                            "password": SENTINEL_PASSWORD,
                        },
                    },
                },
            }
        )
    )
    assert parse_ndjson(update_proc.stdout)[0]["ok"] is True

    launch_proc = run_sidecar(
        request_line(
            {
                "id": "fixed-proxy-chromium-launch",
                "method": "chromium.launch",
                "params": {"storeRoot": store_root, "profileId": profile["id"]},
            }
        ),
        env={"THEPRIVATOR_CHROMIUM_PATH": str(tmp_path / "missing-chromium-should-not-matter")},
    )

    response = parse_ndjson(launch_proc.stdout)[0]
    diagnostic = parse_ndjson(launch_proc.stderr)[0]
    error = assert_error_envelope(response, "PROXY_SOCKS_AUTH_UNSUPPORTED", "fixed-proxy-chromium-launch")
    assert diagnostic["method"] == "chromium.launch"
    assert diagnostic["status"] == "error"
    assert diagnostic["errorCode"] == "PROXY_SOCKS_AUTH_UNSUPPORTED"
    assert diagnostic["detailRef"] == error["detailRef"]
    lookup = lookup_by_detail_ref(store_root, error["detailRef"])
    assert lookup["found"] is True
    assert len(lookup["entries"]) == 1
    assert_proxy_failure_lookup_entry(
        lookup["entries"][0],
        request_id="fixed-proxy-chromium-launch",
        code="PROXY_SOCKS_AUTH_UNSUPPORTED",
        detail_ref=error["detailRef"],
    )
    assert not Path(store_root, "profile-store", "runtime").exists()
    combined = create_proc.stdout + create_proc.stderr + update_proc.stdout + update_proc.stderr + launch_proc.stdout + launch_proc.stderr
    assert_no_proxy_secret_values(combined + json.dumps(lookup, sort_keys=True))
    assert "CHROMIUM_EXECUTABLE_NOT_FOUND" not in combined
    assert "missing-chromium-should-not-matter" not in combined


def test_http_proxy_auth_chromium_launch_sidecar_contract_uses_helper_and_redacts_secrets(tmp_path):
    store_root = str(tmp_path / "auth-proxy-launch-app-data-should-not-leak")
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "auth-proxy-argv-should-not-leak.json"
    env = {
        "THEPRIVATOR_CHROMIUM_PATH": str(fake_chromium),
        "THEPRIVATOR_FAKE_CHROMIUM_ARGV": str(argv_capture),
    }
    create_proc = run_sidecar(
        request_line(
            {
                "id": "auth-proxy-profile-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "Auth Proxy Launch"},
            }
        )
    )
    profile = parse_ndjson(create_proc.stdout)[0]["result"]["profile"]
    update_proc = run_sidecar(
        request_line(
            {
                "id": "auth-proxy-update",
                "method": "profiles.proxy.update",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "proxy": {
                        "proxyVersion": 1,
                        "mode": "fixedServer",
                        "protocol": "http",
                        "host": "proxy.example.invalid",
                        "port": 18080,
                        "credentials": {
                            "username": SENTINEL_USERNAME,
                            "password": SENTINEL_PASSWORD,
                        },
                    },
                },
            }
        )
    )
    assert parse_ndjson(update_proc.stdout)[0]["ok"] is True

    try:
        launch_proc = run_sidecar(
            request_line(
                {
                    "id": "auth-proxy-launch",
                    "method": "chromium.launch",
                    "params": {"storeRoot": store_root, "profileId": profile["id"]},
                }
            ),
            env=env,
        )
        response = parse_ndjson(launch_proc.stdout)[0]
        diagnostic = parse_ndjson(launch_proc.stderr)[0]
        assert response["ok"] is True
        assert response["result"]["status"] == "running"
        assert diagnostic["method"] == "chromium.launch"
        assert diagnostic["status"] == "ok"
        assert diagnostic["detailRef"] is None

        argv = json.loads(argv_capture.read_text(encoding="utf-8"))
        proxy_args = [arg for arg in argv if arg.startswith("--proxy-server=")]
        assert proxy_args == ["--proxy-server=http://proxy.example.invalid:18080"]
        assert any(arg.startswith("--load-extension=") for arg in argv)
        assert any(arg.startswith("--disable-extensions-except=") for arg in argv)
        assert_no_proxy_secret_values("\n".join(argv))
        assert "direct://" not in "\n".join(argv)

        combined = create_proc.stdout + create_proc.stderr + update_proc.stdout + update_proc.stderr + launch_proc.stdout + launch_proc.stderr
        assert_no_proxy_secret_values(combined)
        assert store_root not in combined
        assert str(fake_chromium) not in combined
        assert str(argv_capture) not in combined
        assert "--proxy-server" not in combined
        assert "--load-extension" not in combined
        assert "proxy-auth-extensions" not in combined
        assert "Traceback" not in combined
    finally:
        run_sidecar(
            request_line(
                {
                    "id": "auth-proxy-cleanup",
                    "method": "chromium.stop",
                    "params": {"storeRoot": store_root, "profileId": profile["id"]},
                }
            )
        )


def test_http_proxy_auth_helper_generation_failure_is_typed_redacted_and_diagnostic(tmp_path):
    from theprivator_sidecar.diagnostics import lookup_by_detail_ref

    store_root = str(tmp_path / "auth-helper-failure-app-data-should-not-leak")
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "auth-helper-failure-argv-should-not-exist.json"
    create_proc = run_sidecar(
        request_line(
            {
                "id": "auth-helper-profile-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": "Auth Helper Failure"},
            }
        )
    )
    profile = parse_ndjson(create_proc.stdout)[0]["result"]["profile"]
    update_proc = run_sidecar(
        request_line(
            {
                "id": "auth-helper-proxy-update",
                "method": "profiles.proxy.update",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "proxy": {
                        "proxyVersion": 1,
                        "mode": "fixedServer",
                        "protocol": "https",
                        "host": "proxy.example.invalid",
                        "port": 18443,
                        "credentials": {
                            "username": SENTINEL_USERNAME,
                            "password": SENTINEL_PASSWORD,
                        },
                    },
                },
            }
        )
    )
    assert parse_ndjson(update_proc.stdout)[0]["ok"] is True
    runtime_dir = Path(store_root, "profile-store", "runtime")
    runtime_dir.mkdir(parents=True)
    (runtime_dir / "proxy-auth-extensions").write_text("not-a-directory", encoding="utf-8")

    launch_proc = run_sidecar(
        request_line(
            {
                "id": "auth-helper-launch",
                "method": "chromium.launch",
                "params": {"storeRoot": store_root, "profileId": profile["id"]},
            }
        ),
        env={
            "THEPRIVATOR_CHROMIUM_PATH": str(fake_chromium),
            "THEPRIVATOR_FAKE_CHROMIUM_ARGV": str(argv_capture),
        },
    )

    response = parse_ndjson(launch_proc.stdout)[0]
    diagnostic = parse_ndjson(launch_proc.stderr)[0]
    error = assert_error_envelope(response, "PROXY_AUTH_HELPER_FAILED", "auth-helper-launch")
    assert diagnostic["method"] == "chromium.launch"
    assert diagnostic["status"] == "error"
    assert diagnostic["errorCode"] == "PROXY_AUTH_HELPER_FAILED"
    assert diagnostic["detailRef"] == error["detailRef"]
    lookup = lookup_by_detail_ref(store_root, error["detailRef"])
    assert lookup["found"] is True
    assert len(lookup["entries"]) == 1
    assert_proxy_failure_lookup_entry(
        lookup["entries"][0],
        request_id="auth-helper-launch",
        code="PROXY_AUTH_HELPER_FAILED",
        detail_ref=error["detailRef"],
    )
    assert not argv_capture.exists()

    combined = create_proc.stdout + create_proc.stderr + update_proc.stdout + update_proc.stderr + launch_proc.stdout + launch_proc.stderr
    assert_no_proxy_secret_values(combined + json.dumps(lookup, sort_keys=True))
    assert store_root not in combined
    assert str(fake_chromium) not in combined
    assert str(argv_capture) not in combined
    assert "proxy-auth-extensions" not in combined
    assert "--proxy-server" not in combined
    assert "--load-extension" not in combined
    assert "Traceback" not in combined


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
        assert "--remote-debugging-port" not in combined
        assert "DevToolsActivePort" not in combined
        assert "ws://" not in combined
        assert "debugPort" not in combined
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


def test_chromium_masked_identity_cdp_failure_is_typed_redacted_and_cleans_runtime(tmp_path):
    store_root = str(tmp_path / "app-data-path-should-not-leak")
    profile_name = "Masked Launch Should Not Leak"
    fake_chromium = make_fake_chromium(tmp_path)
    argv_capture = tmp_path / "argv-should-not-leak.json"

    create_proc = run_sidecar(
        request_line(
            {
                "id": "masked-profile-create",
                "method": "profiles.create",
                "params": {"storeRoot": store_root, "name": profile_name},
            }
        )
    )
    profile = parse_ndjson(create_proc.stdout)[0]["result"]["profile"]
    apply_proc = run_sidecar(
        request_line(
            {
                "id": "masked-profile-identity",
                "method": "profiles.identity.applyPreset",
                "params": {
                    "storeRoot": store_root,
                    "profileId": profile["id"],
                    "presetId": "windows-10-chrome-120",
                },
            }
        )
    )
    assert parse_ndjson(apply_proc.stdout)[0]["ok"] is True

    launch_proc = run_sidecar(
        request_line(
            {
                "id": "masked-chromium-launch",
                "method": "chromium.launch",
                "params": {"storeRoot": store_root, "profileId": profile["id"]},
            }
        ),
        env={
            "THEPRIVATOR_CHROMIUM_PATH": str(fake_chromium),
            "THEPRIVATOR_FAKE_CHROMIUM_ARGV": str(argv_capture),
            "THEPRIVATOR_FAKE_CHROMIUM_DEVTOOLS_CONTENT": "not-a-port\n/devtools/browser/test\n",
        },
    )

    launch_response = parse_ndjson(launch_proc.stdout)[0]
    diagnostic = parse_ndjson(launch_proc.stderr)[0]
    error = assert_error_envelope(launch_response, "IDENTITY_CDP_FAILED", "masked-chromium-launch")
    assert diagnostic["event"] == "sidecar.request"
    assert diagnostic["method"] == "chromium.launch"
    assert diagnostic["status"] == "error"
    assert diagnostic["errorCode"] == "IDENTITY_CDP_FAILED"
    assert diagnostic["detailRef"] == error["detailRef"]

    argv = json.loads(argv_capture.read_text(encoding="utf-8"))
    assert "--remote-debugging-port=0" in argv
    assert "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" in argv
    assert any(arg.startswith("--load-extension=") for arg in argv)
    assert any(arg.startswith("--disable-extensions-except=") for arg in argv)

    status_proc = run_sidecar(
        request_line(
            {
                "id": "masked-chromium-status",
                "method": "chromium.status",
                "params": {"storeRoot": store_root},
            }
        )
    )
    assert parse_ndjson(status_proc.stdout)[0]["result"] == {
        "runningCount": 0,
        "profiles": [],
        "reconciled": [],
    }

    stop_proc = run_sidecar(
        request_line(
            {
                "id": "masked-chromium-stop",
                "method": "chromium.stop",
                "params": {"storeRoot": store_root, "profileId": profile["id"]},
            }
        )
    )
    stop_response = parse_ndjson(stop_proc.stdout)[0]
    assert stop_response["ok"] is True
    assert stop_response["result"]["termination"] == "already-stopped"

    stored_profile = json.loads(
        Path(store_root, "profile-store", "profiles.json").read_text(encoding="utf-8")
    )["profiles"][0]
    for forbidden in ("pid", "status", "process", "command", "startedAt", "debugPort"):
        assert forbidden not in stored_profile

    combined = (
        create_proc.stdout
        + create_proc.stderr
        + apply_proc.stdout
        + apply_proc.stderr
        + launch_proc.stdout
        + launch_proc.stderr
        + status_proc.stdout
        + status_proc.stderr
        + stop_proc.stdout
        + stop_proc.stderr
    )
    assert store_root not in combined
    assert str(fake_chromium) not in combined
    assert str(argv_capture) not in combined
    assert profile_name not in launch_proc.stderr
    assert "DevToolsActivePort" not in combined
    assert "not-a-port" not in combined
    assert "ws://" not in combined
    assert "--remote-debugging-port" not in combined
    assert "--load-extension" not in combined
    assert "debugPort" not in combined
    assert "Traceback" not in combined


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
