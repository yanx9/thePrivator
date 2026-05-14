"""Contract tests for the loopback automation API sidecar mode."""

import io
import json
from pathlib import Path
from typing import Mapping, Optional

import pytest

pytest.importorskip(
    "fastapi",
    reason="FastAPI automation API contract tests require requirements.txt runtime dependencies.",
)

from theprivator_sidecar import automation_api
from theprivator_sidecar.automation_api import (
    AUTOMATION_API_VERSION,
    DEFAULT_PROFILE_LIST_LIMIT,
    ENV_HOST,
    ENV_PORT,
    ENV_STORE_ROOT,
    ENV_TOKEN,
    MAX_PROFILE_LIST_LIMIT,
    PROFILE_API_VERSION,
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
from theprivator_sidecar.identity import DEFAULT_REAL_IDENTITY
from theprivator_sidecar.profiles import ProfileStore
from theprivator_sidecar.protocol import (
    AUTOMATION_API_BIND_FAILED,
    AUTOMATION_API_CONFIGURATION_ERROR,
    AUTOMATION_AUTH_INVALID,
    AUTOMATION_AUTH_REQUIRED,
    INVALID_REQUEST,
    PROFILE_STORE_CORRUPT,
    PROFILE_STORE_UNAVAILABLE,
    SIDECAR_VERSION,
)
from theprivator_sidecar.proxy import FIXED_SERVER_PROXY_MODE, PROXY_VERSION

SENTINEL_TOKEN = "sentinel-automation-token-8f6736f6787c"
SENTINEL_USERNAME = "proxy-user-sentinel-automation-2f95cb"
SENTINEL_PASSWORD = "proxy-pass-sentinel-automation-7350fd"
FORBIDDEN_STATIC_MARKERS = (
    SENTINEL_TOKEN,
    SENTINEL_USERNAME,
    SENTINEL_PASSWORD,
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
FORBIDDEN_PROFILE_KEYS = {
    "storage",
    "profileDir",
    "userDataDir",
    "metadata",
    "credentialState",
    "credentials",
    "username",
    "password",
}


def automation_auth_headers(token: str = SENTINEL_TOKEN) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def fixed_proxy() -> dict[str, object]:
    return {
        "proxyVersion": PROXY_VERSION,
        "mode": FIXED_SERVER_PROXY_MODE,
        "protocol": "http",
        "host": "proxy.example.invalid",
        "port": 8080,
        "credentials": {
            "username": SENTINEL_USERNAME,
            "password": SENTINEL_PASSWORD,
        },
    }


def collect_keys(value) -> set[str]:
    if isinstance(value, Mapping):
        keys = set(value.keys())
        for nested in value.values():
            keys.update(collect_keys(nested))
        return keys
    if isinstance(value, list):
        keys: set[str] = set()
        for item in value:
            keys.update(collect_keys(item))
        return keys
    return set()


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


def assert_no_forbidden_profile_surface(payload, *extra_markers: str) -> None:
    encoded_payload = encoded(payload)
    assert FORBIDDEN_PROFILE_KEYS.isdisjoint(collect_keys(payload))
    assert_no_forbidden_markers(
        encoded_payload,
        "profile-store",
        "app-data-root-should-not-leak",
        "storage",
        "profileDir",
        "userDataDir",
        "metadata",
        "credentialState",
        "credentials",
        "username",
        "password",
        *extra_markers,
    )


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


def assert_profile_error_body(response, expected_code: str, expected_status: int):
    assert response.status_code == expected_status
    body = response.json()
    assert set(body) == {"error"}
    error = body["error"]
    assert set(error) == {"code", "message", "details", "detailRef", "requestId"}
    assert error["code"] == expected_code
    assert error["message"]
    assert error["details"] == {"phase": "profile"}
    assert error["detailRef"].startswith("sidecar-")
    assert error["requestId"].startswith("automation-")
    assert_no_forbidden_profile_surface(body)
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


def test_profiles_empty_store_returns_bounded_empty_page(tmp_path):
    config = make_config(tmp_path)
    app = create_app(config)

    response = asgi_get(app, "/v1/profiles", headers=automation_auth_headers())

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"profileApiVersion", "profiles", "count", "limit", "nextCursor", "request"}
    assert body == {
        "profileApiVersion": PROFILE_API_VERSION,
        "profiles": [],
        "count": 0,
        "limit": DEFAULT_PROFILE_LIST_LIMIT,
        "nextCursor": None,
        "request": {"requestId": body["request"]["requestId"]},
    }
    assert body["request"]["requestId"].startswith("automation-")
    assert_no_forbidden_profile_surface(body, str(config.store_root))


def test_profiles_list_returns_allowlisted_direct_and_fixed_proxy_profiles_with_cursor_pagination(tmp_path):
    config = make_config(tmp_path)
    store = ProfileStore(config.store_root)
    direct_profile = store.create("Alpha Direct")["profile"]
    fixed_seed = store.create("Beta Fixed")["profile"]
    fixed_profile = store.update_proxy(fixed_seed["id"], fixed_proxy())["profile"]
    stored_payload = (config.store_root / "profile-store" / "profiles.json").read_text(encoding="utf-8")
    assert SENTINEL_USERNAME in stored_payload
    assert SENTINEL_PASSWORD in stored_payload
    app = create_app(config)

    first_response = asgi_get(app, "/v1/profiles?limit=1", headers=automation_auth_headers())

    assert first_response.status_code == 200
    first_body = first_response.json()
    assert set(first_body) == {"profileApiVersion", "profiles", "count", "limit", "nextCursor", "request"}
    assert first_body["profileApiVersion"] == PROFILE_API_VERSION
    assert first_body["count"] == 1
    assert first_body["limit"] == 1
    assert first_body["request"]["requestId"].startswith("automation-")
    assert isinstance(first_body["nextCursor"], str)
    assert first_body["nextCursor"]
    first_profile = first_body["profiles"][0]
    assert set(first_profile) == {"id", "name", "createdAt", "updatedAt", "defaults", "identity", "proxy"}
    assert first_profile["id"] == direct_profile["id"]
    assert first_profile["name"] == "Alpha Direct"
    assert first_profile["createdAt"] == direct_profile["createdAt"]
    assert first_profile["updatedAt"] == direct_profile["updatedAt"]
    assert first_profile["defaults"] == {
        "browser": "chromium",
        "startUrl": "about:blank",
        "proxyMode": "direct",
        "fingerprintMode": "disabled",
    }
    assert first_profile["identity"] == DEFAULT_REAL_IDENTITY
    assert first_profile["proxy"] == {
        "proxyVersion": PROXY_VERSION,
        "mode": "direct",
        "summary": "Direct connection",
    }
    assert_no_forbidden_profile_surface(first_body, str(config.store_root))

    second_response = asgi_get(
        app,
        f"/v1/profiles?limit=1&cursor={first_body['nextCursor']}",
        headers=automation_auth_headers(),
    )

    assert second_response.status_code == 200
    second_body = second_response.json()
    assert second_body["profileApiVersion"] == PROFILE_API_VERSION
    assert second_body["count"] == 1
    assert second_body["limit"] == 1
    assert second_body["nextCursor"] is None
    second_profile = second_body["profiles"][0]
    assert set(second_profile) == {"id", "name", "createdAt", "updatedAt", "defaults", "identity", "proxy"}
    assert second_profile["id"] == fixed_profile["id"]
    assert second_profile["name"] == "Beta Fixed"
    assert second_profile["defaults"] == {
        "browser": "chromium",
        "startUrl": "about:blank",
        "proxyMode": "fixedServer",
        "fingerprintMode": "disabled",
    }
    assert second_profile["identity"] == DEFAULT_REAL_IDENTITY
    assert second_profile["proxy"] == {
        "proxyVersion": PROXY_VERSION,
        "mode": "fixedServer",
        "protocol": "http",
        "host": "proxy.example.invalid",
        "port": 8080,
        "summary": "http://proxy.example.invalid:8080",
    }
    assert_no_forbidden_profile_surface(second_body, str(config.store_root))


@pytest.mark.parametrize(
    ("headers", "url", "expected_code"),
    [
        ({}, "/v1/profiles", AUTOMATION_AUTH_REQUIRED),
        ({}, f"/v1/profiles?token={SENTINEL_TOKEN}", AUTOMATION_AUTH_REQUIRED),
        ({"Authorization": ""}, "/v1/profiles", AUTOMATION_AUTH_INVALID),
        ({"Authorization": "Basic not-the-token"}, "/v1/profiles", AUTOMATION_AUTH_INVALID),
        ({"Authorization": "Bearer"}, "/v1/profiles", AUTOMATION_AUTH_INVALID),
        ({"Authorization": f"Bearer {SENTINEL_TOKEN[:12]}"}, "/v1/profiles", AUTOMATION_AUTH_INVALID),
        ({"Authorization": f"Bearer {SENTINEL_TOKEN} extra"}, "/v1/profiles", AUTOMATION_AUTH_INVALID),
        ({"Authorization": "Bearer wrong-token"}, "/v1/profiles", AUTOMATION_AUTH_INVALID),
    ],
)
def test_profiles_reject_missing_malformed_query_param_and_invalid_auth_like_status(tmp_path, headers, url, expected_code):
    config = make_config(tmp_path)
    app = create_app(config)

    response = asgi_get(app, url, headers=headers)

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert_error_body(response, expected_code)
    assert_no_forbidden_markers(response.text, str(config.store_root))


@pytest.mark.parametrize(
    "url",
    [
        "/v1/profiles?limit=0",
        "/v1/profiles?limit=-1",
        f"/v1/profiles?limit={MAX_PROFILE_LIST_LIMIT + 1}",
        "/v1/profiles?limit=not-an-integer",
        "/v1/profiles?limit=",
        "/v1/profiles?limit=1&limit=2",
        "/v1/profiles?cursor=not-a-cursor",
        "/v1/profiles?cursor=p_cHJvZmlsZXM6MA",
    ],
)
def test_profiles_reject_invalid_limit_and_cursor_with_profile_phase_400(tmp_path, url):
    config = make_config(tmp_path)
    ProfileStore(config.store_root).create("Seed")
    app = create_app(config)

    response = asgi_get(app, url, headers=automation_auth_headers())

    assert_profile_error_body(response, INVALID_REQUEST, 400)
    assert response.headers["x-request-id"].startswith("automation-")
    assert_no_forbidden_profile_surface(response.json(), str(config.store_root))


def test_profiles_max_limit_page_is_bounded_and_returns_follow_up_cursor(tmp_path):
    config = make_config(tmp_path)
    store = ProfileStore(config.store_root)
    for index in range(MAX_PROFILE_LIST_LIMIT + 1):
        store.create(f"Profile {index:03d}")
    app = create_app(config)

    first_response = asgi_get(app, f"/v1/profiles?limit={MAX_PROFILE_LIST_LIMIT}", headers=automation_auth_headers())

    assert first_response.status_code == 200
    first_body = first_response.json()
    assert first_body["limit"] == MAX_PROFILE_LIST_LIMIT
    assert first_body["count"] == MAX_PROFILE_LIST_LIMIT
    assert len(first_body["profiles"]) == MAX_PROFILE_LIST_LIMIT
    assert first_body["profiles"][0]["name"] == "Profile 000"
    assert first_body["profiles"][-1]["name"] == "Profile 099"
    assert isinstance(first_body["nextCursor"], str)
    assert_no_forbidden_profile_surface(first_body, str(config.store_root))

    second_response = asgi_get(
        app,
        f"/v1/profiles?limit={MAX_PROFILE_LIST_LIMIT}&cursor={first_body['nextCursor']}",
        headers=automation_auth_headers(),
    )

    assert second_response.status_code == 200
    second_body = second_response.json()
    assert second_body["count"] == 1
    assert second_body["profiles"][0]["name"] == "Profile 100"
    assert second_body["nextCursor"] is None
    assert_no_forbidden_profile_surface(second_body, str(config.store_root))


def test_profiles_corrupt_store_returns_profile_phase_503_without_paths_or_raw_json(tmp_path):
    config = make_config(tmp_path)
    store_file = config.store_root / "profile-store" / "profiles.json"
    store_file.parent.mkdir(parents=True)
    store_file.write_text("{not-json", encoding="utf-8")
    app = create_app(config)

    response = asgi_get(app, "/v1/profiles", headers=automation_auth_headers())

    assert_profile_error_body(response, PROFILE_STORE_CORRUPT, 503)
    assert "{not-json" not in response.text
    assert "Traceback" not in response.text
    assert_no_forbidden_profile_surface(response.json(), str(config.store_root), str(store_file))


def test_profiles_unavailable_store_returns_profile_phase_503_without_store_root(tmp_path):
    config = make_config(tmp_path)
    config.store_root.parent.mkdir(parents=True, exist_ok=True)
    config.store_root.write_text("not a directory", encoding="utf-8")
    app = create_app(config)

    response = asgi_get(app, "/v1/profiles", headers=automation_auth_headers())

    assert_profile_error_body(response, PROFILE_STORE_UNAVAILABLE, 503)
    assert "Traceback" not in response.text
    assert_no_forbidden_profile_surface(response.json(), str(config.store_root))


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
