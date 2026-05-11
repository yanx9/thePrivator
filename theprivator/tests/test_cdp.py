"""Tests for internal S02 CDP discovery and JSON-RPC helpers."""

import json
import threading
import time
from pathlib import Path
from typing import Any

import pytest
import requests

from theprivator_sidecar.cdp import (
    CdpClient,
    CdpEndpoint,
    apply_identity_cdp_overrides,
    close_page_target,
    create_page_target_endpoint,
    discover_devtools_endpoint,
    discover_page_target_endpoint,
    read_devtools_active_port,
    select_page_target_endpoint,
)
from theprivator_sidecar.protocol import IDENTITY_CDP_FAILED, SidecarError


class FakeResponse:
    def __init__(self, payload: Any = None, *, json_error: Exception | None = None) -> None:
        self.payload = payload
        self.json_error = json_error

    def json(self) -> Any:
        if self.json_error is not None:
            raise self.json_error
        return self.payload


class FakeSocket:
    def __init__(self, frames: list[str] | None = None, *, recv_error: Exception | None = None) -> None:
        self.frames = list(frames or [])
        self.recv_error = recv_error
        self.sent: list[dict[str, Any]] = []
        self.timeouts: list[float] = []
        self.closed = False

    def settimeout(self, timeout: float) -> None:
        self.timeouts.append(timeout)

    def send(self, payload: str) -> None:
        self.sent.append(json.loads(payload))

    def recv(self) -> str:
        if self.recv_error is not None:
            raise self.recv_error
        if not self.frames:
            raise TimeoutError("socket receive timed out")
        return self.frames.pop(0)

    def close(self) -> None:
        self.closed = True


def write_active_port(root: Path, content: str = "45678\n/devtools/browser/browser-id\n") -> None:
    (root / "DevToolsActivePort").write_text(content, encoding="utf-8")


def assert_sidecar_error(
    exc_info: pytest.ExceptionInfo[SidecarError],
    code: str = IDENTITY_CDP_FAILED,
    *,
    forbidden: tuple[str, ...] = (),
) -> SidecarError:
    error = exc_info.value
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    assert error.message
    combined = json.dumps(error.to_dict(), ensure_ascii=False)
    for marker in (
        "45678",
        "9222",
        "DevToolsActivePort",
        "ws://",
        "remote-debugging-port",
        "Traceback",
        *forbidden,
    ):
        assert marker not in combined
    return error


def test_active_port_polling_accepts_delayed_file_without_assuming_fixed_port(tmp_path):
    def delayed_writer() -> None:
        time.sleep(0.02)
        write_active_port(tmp_path, "45678\n/devtools/browser/delayed-target\n")

    thread = threading.Thread(target=delayed_writer)
    thread.start()
    try:
        endpoint = read_devtools_active_port(
            tmp_path,
            timeout_seconds=1,
            poll_interval_seconds=0.005,
        )
    finally:
        thread.join(timeout=1)

    assert endpoint.port == 45678
    assert endpoint.browser_target_path == "/devtools/browser/delayed-target"
    assert endpoint.version_url == "http://127.0.0.1:45678/json/version"


@pytest.mark.parametrize(
    "content",
    [
        "",
        "9222\n",
        "not-a-port\n/devtools/browser/target\n",
        "9222\nhttp://attacker.invalid/devtools/browser/target\n",
        "9222\n/devtools/page/not-browser-target\n",
        "9222\n/devtools/browser/target\nextra\n",
    ],
)
def test_active_port_malformed_content_is_typed_and_redacted(tmp_path, content):
    write_active_port(tmp_path, content)

    with pytest.raises(SidecarError) as exc_info:
        read_devtools_active_port(tmp_path, timeout_seconds=0.01, poll_interval_seconds=0.001)

    assert_sidecar_error(exc_info, forbidden=(str(tmp_path),))


def test_http_discovery_uses_active_port_and_validates_loopback_websocket_url(tmp_path):
    write_active_port(tmp_path)
    calls: list[tuple[str, float]] = []

    def fake_get(url: str, *, timeout: float) -> FakeResponse:
        calls.append((url, timeout))
        return FakeResponse(
            {
                "Browser": "Chrome/120",
                "webSocketDebuggerUrl": "ws://127.0.0.1:45678/devtools/browser/browser-id",
            }
        )

    endpoint = discover_devtools_endpoint(
        tmp_path,
        http_get=fake_get,
        timeout_seconds=0.1,
        poll_interval_seconds=0.001,
        http_timeout_seconds=0.025,
    )

    assert endpoint.port == 45678
    assert endpoint.web_socket_debugger_url == "ws://127.0.0.1:45678/devtools/browser/browser-id"
    assert calls == [("http://127.0.0.1:45678/json/version", 0.025)]


@pytest.mark.parametrize(
    "payload",
    [
        ["not", "an", "object"],
        {"Browser": "Chrome/120"},
        {"webSocketDebuggerUrl": ""},
        {"webSocketDebuggerUrl": "ws://192.168.0.10:45678/devtools/browser/browser-id"},
        {"webSocketDebuggerUrl": "ws://127.0.0.1:45678/devtools/page/page-id"},
    ],
)
def test_http_discovery_rejects_malformed_payloads_and_non_loopback_urls(tmp_path, payload):
    write_active_port(tmp_path)

    def fake_get(url: str, *, timeout: float) -> FakeResponse:
        return FakeResponse(payload)

    with pytest.raises(SidecarError) as exc_info:
        discover_devtools_endpoint(
            tmp_path,
            http_get=fake_get,
            timeout_seconds=0.01,
            poll_interval_seconds=0.001,
            http_timeout_seconds=0.001,
        )

    assert_sidecar_error(exc_info, forbidden=(str(tmp_path), "192.168.0.10"))


def test_http_discovery_timeout_and_invalid_json_are_typed_and_redacted(tmp_path):
    write_active_port(tmp_path)

    def timeout_get(url: str, *, timeout: float) -> FakeResponse:
        raise requests.Timeout("timed out on port 45678")

    with pytest.raises(SidecarError) as timeout_exc:
        discover_devtools_endpoint(
            tmp_path,
            http_get=timeout_get,
            timeout_seconds=0.01,
            poll_interval_seconds=0.001,
            http_timeout_seconds=0.001,
        )
    assert_sidecar_error(timeout_exc, forbidden=(str(tmp_path),))

    def invalid_json_get(url: str, *, timeout: float) -> FakeResponse:
        return FakeResponse(json_error=ValueError("not json from http://127.0.0.1:45678/json/version"))

    with pytest.raises(SidecarError) as json_exc:
        discover_devtools_endpoint(
            tmp_path,
            http_get=invalid_json_get,
            timeout_seconds=0.01,
            poll_interval_seconds=0.001,
            http_timeout_seconds=0.001,
        )
    assert_sidecar_error(json_exc, forbidden=(str(tmp_path),))


def test_cdp_client_sends_incrementing_json_rpc_ids_and_closes_on_success():
    socket = FakeSocket(
        [
            json.dumps({"id": 1, "result": {"value": "first"}}),
            json.dumps({"id": 2, "result": {"value": "second"}}),
        ]
    )

    with CdpClient(
        "ws://127.0.0.1:45678/devtools/browser/browser-id",
        connect=lambda url, timeout: socket,
        timeout_seconds=0.25,
    ) as client:
        first = client.command("Runtime.evaluate", {"expression": "1"})
        second = client.command("Page.navigate", {"url": "http://127.0.0.1/proof"})

    assert first == {"value": "first"}
    assert second == {"value": "second"}
    assert [sent["id"] for sent in socket.sent] == [1, 2]
    assert [sent["method"] for sent in socket.sent] == ["Runtime.evaluate", "Page.navigate"]
    assert socket.timeouts == [0.25, 0.25, 0.25]
    assert socket.closed is True


def test_page_target_discovery_uses_target_list_and_validates_loopback_page_websocket():
    endpoint = CdpEndpoint(
        port=45678,
        browser_target_path="/devtools/browser/browser-id",
        web_socket_debugger_url="ws://127.0.0.1:45678/devtools/browser/browser-id",
    )
    calls: list[tuple[str, float]] = []

    def fake_get(url: str, *, timeout: float) -> FakeResponse:
        calls.append((url, timeout))
        return FakeResponse(
            [
                {"type": "service_worker", "webSocketDebuggerUrl": "ws://127.0.0.1:45678/devtools/page/ignored"},
                {
                    "id": "initial-target",
                    "type": "page",
                    "webSocketDebuggerUrl": "ws://127.0.0.1:45678/devtools/page/page-id",
                },
            ]
        )

    page = discover_page_target_endpoint(
        endpoint,
        http_get=fake_get,
        timeout_seconds=0.1,
        poll_interval_seconds=0.001,
        http_timeout_seconds=0.025,
    )

    assert page.web_socket_debugger_url == "ws://127.0.0.1:45678/devtools/page/page-id"
    assert page.target_id == "initial-target"
    assert calls == [("http://127.0.0.1:45678/json/list", 0.025)]


def test_select_page_target_endpoint_uses_validated_target_id_without_leaking_urls():
    endpoint = CdpEndpoint(
        port=45678,
        browser_target_path="/devtools/browser/browser-id",
        web_socket_debugger_url="ws://127.0.0.1:45678/devtools/browser/browser-id",
    )
    calls: list[tuple[str, float]] = []

    def fake_get(url: str, *, timeout: float) -> FakeResponse:
        calls.append((url, timeout))
        return FakeResponse(
            [
                {
                    "id": "initial-target",
                    "type": "page",
                    "webSocketDebuggerUrl": "ws://127.0.0.1:45678/devtools/page/initial",
                },
                {
                    "id": "created-target",
                    "type": "page",
                    "webSocketDebuggerUrl": "ws://127.0.0.1:45678/devtools/page/created",
                },
            ]
        )

    page = select_page_target_endpoint(
        endpoint,
        "created-target",
        http_get=fake_get,
        timeout_seconds=0.1,
        poll_interval_seconds=0.001,
        http_timeout_seconds=0.025,
    )

    assert page.web_socket_debugger_url == "ws://127.0.0.1:45678/devtools/page/created"
    assert page.target_id == "created-target"
    assert calls == [("http://127.0.0.1:45678/json/list", 0.025)]


@pytest.mark.parametrize("target_id", ["", "../secret", "target id", "x" * 129])
def test_select_page_target_endpoint_rejects_bad_target_ids(target_id):
    endpoint = CdpEndpoint(
        port=45678,
        browser_target_path="/devtools/browser/browser-id",
        web_socket_debugger_url="ws://127.0.0.1:45678/devtools/browser/browser-id",
    )

    with pytest.raises(SidecarError) as exc_info:
        select_page_target_endpoint(endpoint, target_id)

    forbidden = (target_id,) if target_id else ()
    assert_sidecar_error(exc_info, forbidden=forbidden)


def test_create_page_target_endpoint_uses_browser_cdp_and_discovers_created_page():
    endpoint = CdpEndpoint(
        port=45678,
        browser_target_path="/devtools/browser/browser-id",
        web_socket_debugger_url="ws://127.0.0.1:45678/devtools/browser/browser-id",
    )
    socket = FakeSocket([json.dumps({"id": 1, "result": {"targetId": "created-target"}})])

    def fake_get(url: str, *, timeout: float) -> FakeResponse:
        return FakeResponse(
            [
                {
                    "id": "created-target",
                    "type": "page",
                    "webSocketDebuggerUrl": "ws://127.0.0.1:45678/devtools/page/created",
                }
            ]
        )

    page = create_page_target_endpoint(
        endpoint,
        client_factory=lambda url, **kwargs: CdpClient(url, connect=lambda _url, _timeout: socket, **kwargs),
        http_get=fake_get,
        timeout_seconds=0.25,
        poll_interval_seconds=0.001,
        http_timeout_seconds=0.025,
    )

    assert page.web_socket_debugger_url == "ws://127.0.0.1:45678/devtools/page/created"
    assert page.target_id == "created-target"
    assert socket.sent == [
        {"id": 1, "method": "Target.createTarget", "params": {"url": "about:blank"}}
    ]
    assert socket.closed is True


def test_close_page_target_sends_validated_close_command_and_closes_socket():
    endpoint = CdpEndpoint(
        port=45678,
        browser_target_path="/devtools/browser/browser-id",
        web_socket_debugger_url="ws://127.0.0.1:45678/devtools/browser/browser-id",
    )
    socket = FakeSocket([json.dumps({"id": 1, "result": {"success": True}})])

    result = close_page_target(
        endpoint,
        "created-target",
        client_factory=lambda url, **kwargs: CdpClient(url, connect=lambda _url, _timeout: socket, **kwargs),
        timeout_seconds=0.25,
    )

    assert result == {"closed": True}
    assert socket.sent == [
        {"id": 1, "method": "Target.closeTarget", "params": {"targetId": "created-target"}}
    ]
    assert socket.closed is True


@pytest.mark.parametrize(
    "payload",
    [
        {"not": "an array"},
        [],
        [{"type": "page"}],
        [{"type": "page", "webSocketDebuggerUrl": "ws://192.168.0.10:45678/devtools/page/page-id"}],
        [{"type": "page", "webSocketDebuggerUrl": "ws://127.0.0.1:45678/devtools/browser/browser-id"}],
    ],
)
def test_page_target_discovery_rejects_malformed_target_lists(payload):
    endpoint = CdpEndpoint(
        port=45678,
        browser_target_path="/devtools/browser/browser-id",
        web_socket_debugger_url="ws://127.0.0.1:45678/devtools/browser/browser-id",
    )

    def fake_get(url: str, *, timeout: float) -> FakeResponse:
        return FakeResponse(payload)

    with pytest.raises(SidecarError) as exc_info:
        discover_page_target_endpoint(
            endpoint,
            http_get=fake_get,
            timeout_seconds=0.01,
            poll_interval_seconds=0.001,
            http_timeout_seconds=0.001,
        )

    assert_sidecar_error(exc_info, forbidden=("192.168.0.10",))


def test_cdp_client_accepts_page_target_websocket_urls():
    socket = FakeSocket([json.dumps({"id": 1, "result": {}})])

    with CdpClient(
        "ws://127.0.0.1:45678/devtools/page/page-id",
        connect=lambda url, timeout: socket,
        timeout_seconds=0.25,
    ) as client:
        result = client.command("Page.enable", {})

    assert result == {}
    assert socket.closed is True


@pytest.mark.parametrize(
    "frame",
    [
        "not-json",
        json.dumps({"id": 99, "result": {}}),
        json.dumps({"id": 1, "error": {"message": "leaky ws://127.0.0.1:45678"}}),
        json.dumps({"id": 1}),
        json.dumps(["not", "an", "object"]),
    ],
)
def test_cdp_client_rejects_malformed_frames_and_closes_on_failure(frame):
    socket = FakeSocket([frame])

    with pytest.raises(SidecarError) as exc_info:
        with CdpClient(
            "ws://127.0.0.1:45678/devtools/browser/browser-id",
            connect=lambda url, timeout: socket,
            timeout_seconds=0.25,
        ) as client:
            client.command("Runtime.evaluate", {"expression": "1"})

    assert socket.closed is True
    assert_sidecar_error(exc_info)


def test_apply_identity_cdp_overrides_invokes_expected_helpers_in_order():
    socket = FakeSocket(
        [json.dumps({"id": request_id, "result": {}}) for request_id in range(1, 5)]
    )
    overrides = {
        "userAgent": {"userAgent": "UA", "acceptLanguage": "en-US,en", "platform": "Linux x86_64"},
        "deviceMetrics": {"width": 1200, "height": 800, "deviceScaleFactor": 1, "mobile": False},
        "timezone": {"timezoneId": "America/New_York"},
        "locale": {"locale": "en-US"},
    }

    apply_identity_cdp_overrides(
        "ws://127.0.0.1:45678/devtools/browser/browser-id",
        overrides,
        connect=lambda url, timeout: socket,
        timeout_seconds=1,
    )

    assert [sent["method"] for sent in socket.sent] == [
        "Emulation.setUserAgentOverride",
        "Emulation.setDeviceMetricsOverride",
        "Emulation.setTimezoneOverride",
        "Emulation.setLocaleOverride",
    ]
    assert socket.closed is True
