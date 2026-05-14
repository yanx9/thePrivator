"""Contract tests for the loopback automation API sidecar mode."""

import io
import json
from pathlib import Path
from typing import Mapping, Optional

import pytest

from theprivator_sidecar import automation_api
from theprivator_sidecar.automation_api import (
    AUTOMATION_API_VERSION,
    ENV_HOST,
    ENV_PORT,
    ENV_STORE_ROOT,
    ENV_TOKEN,
    AutomationApiConfig,
    AutomationStartupError,
    bind_loopback_socket,
    create_app,
    encode_safe_json_line,
    load_config_from_env,
    readiness_payload,
    run_from_env,
    safe_startup_error_payload,
)
from theprivator_sidecar.protocol import (
    AUTOMATION_API_BIND_FAILED,
    AUTOMATION_API_CONFIGURATION_ERROR,
    AUTOMATION_AUTH_INVALID,
    AUTOMATION_AUTH_REQUIRED,
    SIDECAR_VERSION,
)

SENTINEL_TOKEN = "sentinel-automation-token-8f6736f6787c"
FORBIDDEN_STATIC_MARKERS = (
    SENTINEL_TOKEN,
    "Authorization",
    "Bearer",
    "DevToolsActivePort",
    "debugPort",
    "--remote-debugging-port",
    "remote-debugging",
    "cdp://",
    "ws://",
    "wss://",
    "argv-should-not-leak",
)


def make_config(tmp_path: Path, *, host: str = "127.0.0.1", port: int = 43123, token: str = SENTINEL_TOKEN) -> AutomationApiConfig:
    return AutomationApiConfig(
        host=host,
        port=port,
        store_root=tmp_path / "app-data-root-should-not-leak",
        token=token,
    )


def make_client(tmp_path: Path, *, token: str = SENTINEL_TOKEN):
    return create_app(make_config(tmp_path, token=token))


class AsgiResponse:
    def __init__(self, status_code: int, headers: Mapping[str, str], body: bytes) -> None:
        self.status_code = status_code
        self.headers = dict(headers)
        self.content = body
        self.text = body.decode("utf-8")

    def json(self):
        return json.loads(self.text)


def asgi_get(app, url: str, headers: Optional[Mapping[str, str]] = None) -> AsgiResponse:
    import asyncio

    path, separator, query = url.partition("?")
    encoded_headers = [
        (name.lower().encode("latin-1"), value.encode("latin-1"))
        for name, value in (headers or {}).items()
    ]
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": query.encode("ascii") if separator else b"",
        "headers": encoded_headers,
        "client": ("127.0.0.1", 34567),
        "server": ("127.0.0.1", 43123),
        "root_path": "",
    }
    events = []
    request_sent = False

    async def receive():
        nonlocal request_sent
        if request_sent:
            return {"type": "http.disconnect"}
        request_sent = True
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        events.append(message)

    asyncio.run(app(scope, receive, send))
    start = next(event for event in events if event["type"] == "http.response.start")
    body = b"".join(event.get("body", b"") for event in events if event["type"] == "http.response.body")
    response_headers = {
        name.decode("latin-1"): value.decode("latin-1")
        for name, value in start.get("headers", [])
    }
    return AsgiResponse(start["status"], response_headers, body)


def encoded(value) -> str:
    return json.dumps(value, sort_keys=True)


def assert_no_forbidden_markers(text: str, *extra_markers: str) -> None:
    for marker in (*FORBIDDEN_STATIC_MARKERS, *extra_markers):
        if marker:
            assert marker not in text


def assert_error_body(response, expected_code: str):
    body = response.json()
    assert set(body) == {"error"}
    error = body["error"]
    assert set(error) == {"code", "message", "details", "detailRef", "requestId"}
    assert error["code"] == expected_code
    assert error["message"]
    assert error["details"] == {"phase": "auth"}
    assert error["detailRef"].startswith("sidecar-")
    assert error["requestId"].startswith("automation-")
    return error


def test_health_is_public_and_contains_only_safe_runtime_metadata(tmp_path):
    config = make_config(tmp_path)
    app = create_app(config)

    response = asgi_get(app, "/health")

    assert response.status_code == 200
    assert response.headers["x-request-id"].startswith("automation-")
    assert response.headers["x-automation-api-version"] == AUTOMATION_API_VERSION
    body = response.json()
    assert body["status"] == "healthy"
    assert body["product"]["name"] == "ThePrivator"
    assert body["sidecar"] == {"version": SIDECAR_VERSION}
    assert body["automationApi"] == {"version": AUTOMATION_API_VERSION}
    assert body["api"] == {"host": "127.0.0.1", "port": 43123, "scope": "loopback"}
    assert body["request"]["requestId"].startswith("automation-")
    assert_no_forbidden_markers(response.text, str(config.store_root))


def test_status_accepts_exact_token_without_echoing_token_or_store_root(tmp_path):
    config = make_config(tmp_path)
    app = create_app(config)

    response = asgi_get(app, "/v1/status", headers={"Authorization": f"Bearer {SENTINEL_TOKEN}"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "running"
    assert body["automationApi"] == {"version": AUTOMATION_API_VERSION}
    assert body["api"] == {"host": "127.0.0.1", "port": 43123, "scope": "loopback"}
    assert body["store"] == {"configured": True}
    assert body["startedAt"].endswith("Z")
    assert body["request"]["requestId"].startswith("automation-")
    assert_no_forbidden_markers(response.text, str(config.store_root))


@pytest.mark.parametrize(
    ("headers", "url", "expected_code"),
    [
        ({}, "/v1/status", AUTOMATION_AUTH_REQUIRED),
        ({}, f"/v1/status?token={SENTINEL_TOKEN}", AUTOMATION_AUTH_REQUIRED),
        ({"Authorization": ""}, "/v1/status", AUTOMATION_AUTH_INVALID),
        ({"Authorization": "Basic not-the-token"}, "/v1/status", AUTOMATION_AUTH_INVALID),
        ({"Authorization": "Bearer"}, "/v1/status", AUTOMATION_AUTH_INVALID),
        ({"Authorization": f"Bearer {SENTINEL_TOKEN[:12]}"}, "/v1/status", AUTOMATION_AUTH_INVALID),
        ({"Authorization": f"Bearer {SENTINEL_TOKEN} extra"}, "/v1/status", AUTOMATION_AUTH_INVALID),
        ({"Authorization": f"Bearer {SENTINEL_TOKEN}-suffix"}, "/v1/status", AUTOMATION_AUTH_INVALID),
        ({"Authorization": "Bearer wrong-token"}, "/v1/status", AUTOMATION_AUTH_INVALID),
    ],
)
def test_status_rejects_missing_malformed_and_invalid_auth_with_redacted_401(tmp_path, headers, url, expected_code):
    config = make_config(tmp_path)
    app = create_app(config)

    response = asgi_get(app, url, headers=headers)

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert_error_body(response, expected_code)
    assert_no_forbidden_markers(response.text, str(config.store_root))


def test_health_stays_public_when_token_query_param_is_supplied(tmp_path):
    app = make_client(tmp_path)

    response = asgi_get(app, f"/health?token={SENTINEL_TOKEN}")

    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
    assert_no_forbidden_markers(response.text)


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
def test_config_accepts_loopback_hosts(tmp_path, host):
    config = load_config_from_env(
        {
            ENV_HOST: host,
            ENV_PORT: "0",
            ENV_STORE_ROOT: str(tmp_path / "safe-app-data"),
            ENV_TOKEN: SENTINEL_TOKEN,
        }
    )

    assert config.host in {"127.0.0.1", "::1"}
    assert config.port == 0


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.10", "example.com", "http://127.0.0.1"])
def test_config_rejects_non_loopback_hosts_without_echoing_inputs(tmp_path, host):
    store_root = str(tmp_path / "unsafe-host-root-should-not-leak")

    with pytest.raises(AutomationStartupError) as raised:
        load_config_from_env(
            {
                ENV_HOST: host,
                ENV_PORT: "0",
                ENV_STORE_ROOT: store_root,
                ENV_TOKEN: SENTINEL_TOKEN,
            }
        )

    assert raised.value.code == AUTOMATION_API_CONFIGURATION_ERROR
    payload = safe_startup_error_payload(raised.value)
    text = encoded(payload)
    assert payload["phase"] == "configuration"
    assert_no_forbidden_markers(text, store_root, host)


@pytest.mark.parametrize(
    ("env_patch", "expected_message"),
    [
        ({ENV_TOKEN: ""}, "Automation API token is required."),
        ({ENV_STORE_ROOT: ""}, "Automation API store root is required."),
        ({ENV_STORE_ROOT: "relative-app-data"}, "Automation API store root is invalid."),
        ({ENV_PORT: "70000"}, "Automation API port must be a valid TCP port."),
    ],
)
def test_startup_config_errors_are_typed_and_redacted(tmp_path, env_patch, expected_message):
    store_root = str(tmp_path / "config-error-root-should-not-leak")
    env = {
        ENV_HOST: "127.0.0.1",
        ENV_PORT: "0",
        ENV_STORE_ROOT: store_root,
        ENV_TOKEN: SENTINEL_TOKEN,
        **env_patch,
    }

    stdout = io.StringIO()
    stderr = io.StringIO()
    result = run_from_env(env, stdout=stdout, stderr=stderr)

    assert result == 2
    assert stdout.getvalue() == ""
    payload = json.loads(stderr.getvalue())
    assert payload["event"] == "automation-api.lifecycle"
    assert payload["status"] == "error"
    assert payload["phase"] == "configuration"
    assert payload["error"]["code"] == AUTOMATION_API_CONFIGURATION_ERROR
    assert payload["error"]["message"] == expected_message
    assert payload["error"]["detailRef"].startswith("sidecar-")
    assert_no_forbidden_markers(stderr.getvalue(), store_root, env_patch.get(ENV_STORE_ROOT, ""))


def test_readiness_payload_is_strict_safe_json(tmp_path):
    config = make_config(tmp_path, port=51234)

    payload = readiness_payload(config)
    line = encode_safe_json_line(payload)

    assert set(payload) == {"host", "port", "version"}
    assert payload == {"host": "127.0.0.1", "port": 51234, "version": AUTOMATION_API_VERSION}
    assert json.loads(line) == payload
    assert_no_forbidden_markers(line, str(config.store_root), "event", "phase", "status")


def test_bind_failure_is_typed_and_redacted(tmp_path):
    occupied = bind_loopback_socket("127.0.0.1", 0)
    port = int(occupied.getsockname()[1])
    store_root = str(tmp_path / "bind-root-should-not-leak")
    env = {
        ENV_HOST: "127.0.0.1",
        ENV_PORT: str(port),
        ENV_STORE_ROOT: store_root,
        ENV_TOKEN: SENTINEL_TOKEN,
    }
    try:
        stdout = io.StringIO()
        stderr = io.StringIO()
        result = run_from_env(env, stdout=stdout, stderr=stderr)
    finally:
        occupied.close()

    assert result == 2
    assert stdout.getvalue() == ""
    payload = json.loads(stderr.getvalue())
    assert payload["phase"] == "bind"
    assert payload["error"]["code"] == AUTOMATION_API_BIND_FAILED
    assert payload["error"]["detailRef"].startswith("sidecar-")
    assert_no_forbidden_markers(stderr.getvalue(), store_root, str(port))


def test_main_dispatches_explicit_automation_api_mode(monkeypatch):
    from theprivator_sidecar import main as sidecar_main

    calls = []

    def fake_run_from_env(environ):
        calls.append(environ)
        return 17

    monkeypatch.setattr(automation_api, "run_from_env", fake_run_from_env)

    assert sidecar_main.main(["automation-api"]) == 17
    assert calls
