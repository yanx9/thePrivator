"""Internal minimal Chrome DevTools Protocol helpers for identity runtime work.

This module is intentionally sidecar-internal. It discovers Chromium's ephemeral
DevTools endpoint from the profile-scoped ``DevToolsActivePort`` file, applies a
small allowlisted subset of CDP commands, and collapses all operational failures
into redacted typed ``SidecarError`` values. Public callers should never receive
ports, WebSocket URLs, active-port file paths, raw Chromium argv, or raw response
frames from this module.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Collection, Mapping, Optional, Protocol, Union
from urllib.parse import urlsplit

import requests

try:  # pragma: no cover - dependency-present path is exercised where installed.
    import websocket  # type: ignore
except ImportError:  # pragma: no cover - local unit tests use injected fake sockets.
    websocket = None  # type: ignore

from .protocol import IDENTITY_CDP_FAILED, JsonObject, SidecarError

DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort"
DEFAULT_DISCOVERY_TIMEOUT_SECONDS = 5.0
DEFAULT_POLL_INTERVAL_SECONDS = 0.05
DEFAULT_HTTP_TIMEOUT_SECONDS = 1.0
DEFAULT_WS_TIMEOUT_SECONDS = 1.0
DEFAULT_APPLY_TIMEOUT_SECONDS = 5.0
_SAFE_CDP_MESSAGE = "Identity CDP operation failed."
_SAFE_HTTP_HOST = "127.0.0.1"
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
_MAX_ACTIVE_PORT_BYTES = 512
_MAX_TARGET_PATH_LENGTH = 256
_MAX_TARGET_ID_LENGTH = 128


class _SocketLike(Protocol):
    def settimeout(self, timeout: float) -> None: ...

    def send(self, payload: str) -> Any: ...

    def recv(self) -> str: ...

    def close(self) -> Any: ...


HttpGet = Callable[..., Any]
ConnectFactory = Callable[[str, Optional[float]], _SocketLike]


@dataclass(frozen=True)
class DevToolsActivePort:
    """Validated contents of Chromium's profile-scoped active-port file."""

    port: int
    browser_target_path: str

    @property
    def version_url(self) -> str:
        return f"http://{_SAFE_HTTP_HOST}:{self.port}/json/version"


@dataclass(frozen=True)
class CdpEndpoint:
    """Internal CDP endpoint details; do not serialize to UI diagnostics."""

    port: int
    browser_target_path: str
    web_socket_debugger_url: str

    @property
    def version_url(self) -> str:
        return f"http://{_SAFE_HTTP_HOST}:{self.port}/json/version"

    @property
    def target_list_url(self) -> str:
        return f"http://{_SAFE_HTTP_HOST}:{self.port}/json/list"

    def to_safe_dict(self) -> JsonObject:
        """Return only non-sensitive summary fields for local assertions."""
        return {"source": "DevToolsActivePort", "debugger": "loopback", "target": "browser"}


@dataclass(frozen=True)
class CdpPageEndpoint:
    """Internal page target details used for page-scoped Emulation/Runtime work."""

    web_socket_debugger_url: str
    target_id: Optional[str] = None

    def to_safe_dict(self) -> JsonObject:
        """Return only non-sensitive summary fields for local assertions."""
        return {"source": "DevToolsTargetList", "debugger": "loopback", "target": "page"}


def read_devtools_active_port(
    user_data_dir: Union[str, Path],
    *,
    timeout_seconds: float = DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
) -> DevToolsActivePort:
    """Poll and validate Chromium's ``DevToolsActivePort`` file.

    The returned port is an internal implementation detail. All failures use a
    generic message so active-port paths and contents never leak into protocol
    errors or diagnostics.
    """
    path = Path(user_data_dir) / DEVTOOLS_ACTIVE_PORT_FILE
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while True:
        try:
            if path.is_file():
                content = path.read_text(encoding="utf-8")
                if len(content.encode("utf-8", errors="ignore")) > _MAX_ACTIVE_PORT_BYTES:
                    raise ValueError("active-port file is too large")
                return _parse_active_port_content(content)
        except SidecarError:
            raise
        except Exception as exc:
            raise _cdp_error() from exc

        if time.monotonic() >= deadline:
            raise _cdp_error()
        time.sleep(_bounded_poll_interval(poll_interval_seconds, deadline))


def discover_devtools_endpoint(
    user_data_dir: Union[str, Path],
    *,
    timeout_seconds: float = DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    http_timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
    http_get: HttpGet = requests.get,
) -> CdpEndpoint:
    """Discover and validate Chromium's browser-level CDP WebSocket URL."""
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    active_port = read_devtools_active_port(
        user_data_dir,
        timeout_seconds=timeout_seconds,
        poll_interval_seconds=poll_interval_seconds,
    )

    while True:
        try:
            response = http_get(active_port.version_url, timeout=max(0.001, http_timeout_seconds))
            payload = response.json()
            if not isinstance(payload, Mapping):
                raise ValueError("version payload must be an object")
            web_socket_url = payload.get("webSocketDebuggerUrl")
            if not isinstance(web_socket_url, str) or not web_socket_url:
                raise ValueError("version payload is missing debugger URL")
            _validate_loopback_browser_ws_url(web_socket_url, expected_port=active_port.port)
            return CdpEndpoint(
                port=active_port.port,
                browser_target_path=active_port.browser_target_path,
                web_socket_debugger_url=web_socket_url,
            )
        except SidecarError:
            raise
        except requests.Timeout as exc:
            if time.monotonic() >= deadline:
                raise _cdp_error() from exc
        except requests.RequestException as exc:
            if time.monotonic() >= deadline:
                raise _cdp_error() from exc
        except Exception as exc:
            raise _cdp_error() from exc

        if time.monotonic() >= deadline:
            raise _cdp_error()
        time.sleep(_bounded_poll_interval(poll_interval_seconds, deadline))


def discover_page_target_endpoint(
    endpoint: CdpEndpoint,
    *,
    timeout_seconds: float = DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    http_timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
    http_get: HttpGet = requests.get,
) -> CdpPageEndpoint:
    """Discover the first loopback page target for page-scoped CDP commands."""
    return _discover_page_target_endpoint(
        endpoint,
        target_id=None,
        timeout_seconds=timeout_seconds,
        poll_interval_seconds=poll_interval_seconds,
        http_timeout_seconds=http_timeout_seconds,
        http_get=http_get,
    )


def select_page_target_endpoint(
    endpoint: CdpEndpoint,
    target_id: str,
    *,
    timeout_seconds: float = DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    http_timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
    http_get: HttpGet = requests.get,
) -> CdpPageEndpoint:
    """Discover a loopback page target by validated CDP target id."""
    _validate_target_id(target_id)
    return _discover_page_target_endpoint(
        endpoint,
        target_id=target_id,
        timeout_seconds=timeout_seconds,
        poll_interval_seconds=poll_interval_seconds,
        http_timeout_seconds=http_timeout_seconds,
        http_get=http_get,
    )


def create_page_target_endpoint(
    endpoint: CdpEndpoint,
    *,
    target_url: str = "about:blank",
    allowed_public_urls: Optional[Collection[str]] = None,
    client_factory: Optional[Callable[..., Any]] = None,
    timeout_seconds: float = DEFAULT_WS_TIMEOUT_SECONDS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    http_timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
    http_get: HttpGet = requests.get,
) -> CdpPageEndpoint:
    """Create a new page target and return its validated page endpoint.

    By default this helper remains restricted to local proof URLs: ``about:blank``
    and loopback HTTP. Guided audits may pass an explicit exact set of public
    HTTPS URLs, but no caller can provide arbitrary navigation strings.
    """
    if not isinstance(endpoint, CdpEndpoint):
        raise _cdp_error()
    _validate_create_target_url(target_url, allowed_public_urls=allowed_public_urls)
    factory = client_factory or CdpClient
    try:
        with factory(endpoint.web_socket_debugger_url, timeout_seconds=timeout_seconds) as client:
            result = client.command(
                "Target.createTarget",
                {"url": target_url},
                timeout_seconds=timeout_seconds,
            )
    except SidecarError:
        raise
    except Exception as exc:
        raise _cdp_error() from exc
    target_id = result.get("targetId") if isinstance(result, Mapping) else None
    if not isinstance(target_id, str):
        raise _cdp_error()
    _validate_target_id(target_id)
    return select_page_target_endpoint(
        endpoint,
        target_id,
        timeout_seconds=timeout_seconds,
        poll_interval_seconds=poll_interval_seconds,
        http_timeout_seconds=http_timeout_seconds,
        http_get=http_get,
    )


def close_page_target(
    endpoint: CdpEndpoint,
    target_id: str,
    *,
    client_factory: Optional[Callable[..., Any]] = None,
    timeout_seconds: float = DEFAULT_WS_TIMEOUT_SECONDS,
) -> JsonObject:
    """Close a validated page target via the browser CDP endpoint."""
    if not isinstance(endpoint, CdpEndpoint):
        raise _cdp_error()
    _validate_target_id(target_id)
    factory = client_factory or CdpClient
    try:
        with factory(endpoint.web_socket_debugger_url, timeout_seconds=timeout_seconds) as client:
            result = client.command(
                "Target.closeTarget",
                {"targetId": target_id},
                timeout_seconds=timeout_seconds,
            )
    except SidecarError:
        raise
    except Exception as exc:
        raise _cdp_error() from exc
    success = result.get("success") if isinstance(result, Mapping) else None
    if success is not True:
        raise _cdp_error()
    return {"closed": True}


def _discover_page_target_endpoint(
    endpoint: CdpEndpoint,
    *,
    target_id: Optional[str],
    timeout_seconds: float,
    poll_interval_seconds: float,
    http_timeout_seconds: float,
    http_get: HttpGet,
) -> CdpPageEndpoint:
    if not isinstance(endpoint, CdpEndpoint):
        raise _cdp_error()
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while True:
        try:
            response = http_get(endpoint.target_list_url, timeout=max(0.001, http_timeout_seconds))
            payload = response.json()
            if not isinstance(payload, list):
                raise ValueError("target list payload must be an array")
            for target in payload:
                if not isinstance(target, Mapping) or target.get("type") != "page":
                    continue
                candidate_id = target.get("id")
                if target_id is not None and candidate_id != target_id:
                    continue
                web_socket_url = target.get("webSocketDebuggerUrl")
                if not isinstance(web_socket_url, str) or not web_socket_url:
                    continue
                _validate_loopback_page_ws_url(web_socket_url, expected_port=endpoint.port)
                if isinstance(candidate_id, str):
                    _validate_target_id(candidate_id)
                return CdpPageEndpoint(web_socket_debugger_url=web_socket_url, target_id=candidate_id)
            raise ValueError("page target was not found")
        except SidecarError:
            raise
        except requests.Timeout as exc:
            if time.monotonic() >= deadline:
                raise _cdp_error() from exc
        except requests.RequestException as exc:
            if time.monotonic() >= deadline:
                raise _cdp_error() from exc
        except Exception as exc:
            if time.monotonic() >= deadline:
                raise _cdp_error() from exc

        if time.monotonic() >= deadline:
            raise _cdp_error()
        time.sleep(_bounded_poll_interval(poll_interval_seconds, deadline))


def _validate_create_target_url(target_url: str, *, allowed_public_urls: Optional[Collection[str]]) -> None:
    if target_url == "about:blank":
        return
    if isinstance(target_url, str) and target_url.startswith("http://127.0.0.1:"):
        return
    if allowed_public_urls is None:
        raise _cdp_error()
    _validate_public_target_url(target_url)
    for allowed_url in allowed_public_urls:
        _validate_public_target_url(allowed_url)
    if target_url not in allowed_public_urls:
        raise _cdp_error()


def _validate_public_target_url(url: str) -> None:
    if not isinstance(url, str) or not url or any(ord(character) < 32 for character in url):
        raise _cdp_error()
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise _cdp_error() from exc
    if parsed.scheme != "https" or parsed.username or parsed.password:
        raise _cdp_error()
    if not parsed.hostname or parsed.hostname in _LOOPBACK_HOSTS:
        raise _cdp_error()
    if port is not None:
        raise _cdp_error()
    if parsed.fragment or parsed.query:
        raise _cdp_error()


class CdpClient:
    """Tiny JSON-RPC wrapper over ``websocket-client`` for allowlisted helpers."""

    def __init__(
        self,
        web_socket_debugger_url: str,
        *,
        connect: Optional[ConnectFactory] = None,
        timeout_seconds: float = DEFAULT_WS_TIMEOUT_SECONDS,
    ) -> None:
        self.web_socket_debugger_url = web_socket_debugger_url
        self.timeout_seconds = max(0.001, timeout_seconds)
        self._connect = connect or _default_websocket_connect
        self._socket: Optional[_SocketLike] = None
        self._next_id = 1

    def __enter__(self) -> "CdpClient":
        self.connect()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def connect(self) -> None:
        if self._socket is not None:
            return
        try:
            _validate_loopback_cdp_ws_url(self.web_socket_debugger_url)
            socket = self._connect(self.web_socket_debugger_url, self.timeout_seconds)
            socket.settimeout(self.timeout_seconds)
            self._socket = socket
        except SidecarError:
            raise
        except Exception as exc:
            raise _cdp_error() from exc

    def close(self) -> None:
        socket = self._socket
        self._socket = None
        if socket is None:
            return
        try:
            socket.close()
        except Exception:
            return

    def command(
        self,
        method: str,
        params: Optional[Mapping[str, Any]] = None,
        *,
        timeout_seconds: Optional[float] = None,
    ) -> JsonObject:
        """Send one CDP command and validate the matching JSON-RPC response."""
        if not isinstance(method, str) or not method:
            raise _cdp_error()
        if params is not None and not isinstance(params, Mapping):
            raise _cdp_error()

        self.connect()
        assert self._socket is not None
        request_id = self._next_id
        self._next_id += 1
        command_timeout = max(0.001, timeout_seconds if timeout_seconds is not None else self.timeout_seconds)
        payload = {
            "id": request_id,
            "method": method,
            "params": _json_safe_object(params or {}),
        }

        try:
            self._socket.settimeout(command_timeout)
            self._socket.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
            return self._read_response(request_id, command_timeout)
        except SidecarError:
            self.close()
            raise
        except Exception as exc:
            self.close()
            raise _cdp_error() from exc

    def _read_response(self, request_id: int, timeout_seconds: float) -> JsonObject:
        assert self._socket is not None
        deadline = time.monotonic() + timeout_seconds
        while True:
            if time.monotonic() >= deadline:
                raise _cdp_error()
            raw_frame = self._socket.recv()
            try:
                frame = json.loads(raw_frame)
            except (TypeError, json.JSONDecodeError) as exc:
                raise _cdp_error() from exc
            if not isinstance(frame, Mapping):
                raise _cdp_error()

            frame_id = frame.get("id")
            if frame_id is None and isinstance(frame.get("method"), str):
                # Browser events can be interleaved with command responses.
                continue
            if frame_id != request_id:
                raise _cdp_error()
            if "error" in frame:
                raise _cdp_error()
            result = frame.get("result")
            if not isinstance(result, Mapping):
                raise _cdp_error()
            return _json_safe_object(result)


def apply_identity_cdp_overrides(
    endpoint_or_url: Union[CdpEndpoint, CdpPageEndpoint, str],
    overrides: Mapping[str, Any],
    *,
    connect: Optional[ConnectFactory] = None,
    timeout_seconds: float = DEFAULT_APPLY_TIMEOUT_SECONDS,
) -> JsonObject:
    """Apply the allowlisted identity CDP overrides to an existing page target."""
    if not isinstance(overrides, Mapping):
        raise _cdp_error()
    if not overrides:
        return {"applied": []}

    applied: list[str] = []
    with CdpClient(
        _page_endpoint_url(endpoint_or_url),
        connect=connect,
        timeout_seconds=timeout_seconds,
    ) as client:
        if "userAgent" in overrides:
            set_user_agent_override(client, _require_object(overrides["userAgent"]), timeout_seconds=timeout_seconds)
            applied.append("userAgent")
        if "deviceMetrics" in overrides:
            set_device_metrics_override(
                client,
                _require_object(overrides["deviceMetrics"]),
                timeout_seconds=timeout_seconds,
            )
            applied.append("deviceMetrics")
        if "timezone" in overrides:
            timezone = _require_object(overrides["timezone"]).get("timezoneId")
            if not isinstance(timezone, str) or not timezone:
                raise _cdp_error()
            set_timezone_override(client, timezone, timeout_seconds=timeout_seconds)
            applied.append("timezone")
        if "locale" in overrides:
            locale = _require_object(overrides["locale"]).get("locale")
            if not isinstance(locale, str) or not locale:
                raise _cdp_error()
            set_locale_override(client, locale, timeout_seconds=timeout_seconds)
            applied.append("locale")

    return {"applied": applied}


def set_user_agent_override(
    client: CdpClient,
    payload: Mapping[str, Any],
    *,
    timeout_seconds: Optional[float] = None,
) -> JsonObject:
    return client.command(
        "Emulation.setUserAgentOverride",
        _json_safe_object(payload),
        timeout_seconds=timeout_seconds,
    )


def set_device_metrics_override(
    client: CdpClient,
    payload: Mapping[str, Any],
    *,
    timeout_seconds: Optional[float] = None,
) -> JsonObject:
    return client.command(
        "Emulation.setDeviceMetricsOverride",
        _json_safe_object(payload),
        timeout_seconds=timeout_seconds,
    )


def set_timezone_override(
    client: CdpClient,
    timezone_id: str,
    *,
    timeout_seconds: Optional[float] = None,
) -> JsonObject:
    if not isinstance(timezone_id, str) or not timezone_id:
        raise _cdp_error()
    return client.command(
        "Emulation.setTimezoneOverride",
        {"timezoneId": timezone_id},
        timeout_seconds=timeout_seconds,
    )


def set_locale_override(
    client: CdpClient,
    locale: str,
    *,
    timeout_seconds: Optional[float] = None,
) -> JsonObject:
    if not isinstance(locale, str) or not locale:
        raise _cdp_error()
    return client.command(
        "Emulation.setLocaleOverride",
        {"locale": locale},
        timeout_seconds=timeout_seconds,
    )


def page_navigate(
    client: Any,
    url: str,
    *,
    timeout_seconds: Optional[float] = None,
) -> JsonObject:
    if not isinstance(url, str) or not url.startswith("http://127.0.0.1:"):
        raise _cdp_error()
    result = client.command("Page.navigate", {"url": url}, timeout_seconds=timeout_seconds)
    if not isinstance(result, Mapping) or isinstance(result.get("errorText"), str):
        raise _cdp_error()
    return _json_safe_object(result)


def runtime_evaluate(
    client: Any,
    expression: str,
    *,
    await_promise: bool = True,
    return_by_value: bool = True,
    timeout_seconds: Optional[float] = None,
) -> Any:
    if not isinstance(expression, str) or not expression:
        raise _cdp_error()
    result = client.command(
        "Runtime.evaluate",
        {
            "expression": expression,
            "awaitPromise": await_promise,
            "returnByValue": return_by_value,
        },
        timeout_seconds=timeout_seconds,
    )
    if not isinstance(result, Mapping) or "exceptionDetails" in result:
        raise _cdp_error()
    remote = result.get("result")
    if not isinstance(remote, Mapping):
        raise _cdp_error()
    if "value" in remote:
        return _json_safe_value(remote.get("value"))
    if remote.get("subtype") == "null" or remote.get("type") == "undefined":
        return None
    raise _cdp_error()


def _default_websocket_connect(url: str, timeout: Optional[float]) -> _SocketLike:
    if websocket is None:
        raise _cdp_error()
    return websocket.create_connection(url, timeout=timeout, suppress_origin=True)


def _parse_active_port_content(content: str) -> DevToolsActivePort:
    lines = content.splitlines()
    if len(lines) != 2:
        raise _cdp_error()
    port_line, target_path = lines
    if port_line != port_line.strip() or not port_line.isdecimal():
        raise _cdp_error()
    port = int(port_line)
    if port <= 0 or port > 65535:
        raise _cdp_error()
    _validate_browser_target_path(target_path)
    return DevToolsActivePort(port=port, browser_target_path=target_path)


def _validate_browser_target_path(path: str) -> None:
    _validate_target_path(path, expected_prefix="/devtools/browser/")


def _validate_page_target_path(path: str) -> None:
    _validate_target_path(path, expected_prefix="/devtools/page/")


def _validate_target_id(target_id: str) -> None:
    if not isinstance(target_id, str) or not target_id:
        raise _cdp_error()
    if len(target_id) > _MAX_TARGET_ID_LENGTH:
        raise _cdp_error()
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
    if any(character not in allowed for character in target_id):
        raise _cdp_error()


def _validate_target_path(path: str, *, expected_prefix: str) -> None:
    if not isinstance(path, str) or not path:
        raise _cdp_error()
    if len(path) > _MAX_TARGET_PATH_LENGTH:
        raise _cdp_error()
    if not path.startswith(expected_prefix):
        raise _cdp_error()
    if any(ord(character) < 33 for character in path):
        raise _cdp_error()
    if "://" in path or "\\" in path or "?" in path or "#" in path:
        raise _cdp_error()


def _validate_loopback_browser_ws_url(url: str, *, expected_port: Optional[int] = None) -> None:
    _validate_loopback_cdp_ws_url(url, expected_port=expected_port, target="browser")


def _validate_loopback_page_ws_url(url: str, *, expected_port: Optional[int] = None) -> None:
    _validate_loopback_cdp_ws_url(url, expected_port=expected_port, target="page")


def _validate_loopback_cdp_ws_url(
    url: str,
    *,
    expected_port: Optional[int] = None,
    target: Optional[str] = None,
) -> None:
    if not isinstance(url, str) or not url:
        raise _cdp_error()
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise _cdp_error() from exc
    if parsed.scheme != "ws" or parsed.username or parsed.password:
        raise _cdp_error()
    host = parsed.hostname
    if host not in _LOOPBACK_HOSTS:
        raise _cdp_error()
    if port is None or port <= 0 or port > 65535:
        raise _cdp_error()
    if expected_port is not None and port != expected_port:
        raise _cdp_error()
    if target == "browser":
        _validate_browser_target_path(parsed.path)
        return
    if target == "page":
        _validate_page_target_path(parsed.path)
        return
    if parsed.path.startswith("/devtools/browser/"):
        _validate_browser_target_path(parsed.path)
        return
    _validate_page_target_path(parsed.path)


def _endpoint_url(endpoint_or_url: Union[CdpEndpoint, CdpPageEndpoint, str]) -> str:
    if isinstance(endpoint_or_url, CdpEndpoint):
        return endpoint_or_url.web_socket_debugger_url
    if isinstance(endpoint_or_url, CdpPageEndpoint):
        return endpoint_or_url.web_socket_debugger_url
    if isinstance(endpoint_or_url, str):
        return endpoint_or_url
    raise _cdp_error()


def _page_endpoint_url(endpoint_or_url: Union[CdpEndpoint, CdpPageEndpoint, str]) -> str:
    if isinstance(endpoint_or_url, CdpEndpoint):
        return discover_page_target_endpoint(endpoint_or_url).web_socket_debugger_url
    return _endpoint_url(endpoint_or_url)


def _require_object(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _cdp_error()
    return value


def _json_safe_object(payload: Mapping[str, Any]) -> JsonObject:
    copied = _json_safe_value(payload)
    if not isinstance(copied, dict):
        raise _cdp_error()
    return copied


def _json_safe_value(value: Any) -> Any:
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True))
    except (TypeError, ValueError) as exc:
        raise _cdp_error() from exc


def _bounded_poll_interval(poll_interval_seconds: float, deadline: float) -> float:
    remaining = max(0.0, deadline - time.monotonic())
    return min(max(0.001, poll_interval_seconds), remaining if remaining else 0.001)


def _cdp_error() -> SidecarError:
    return SidecarError(code=IDENTITY_CDP_FAILED, message=_SAFE_CDP_MESSAGE)


__all__ = [
    "CdpClient",
    "CdpEndpoint",
    "CdpPageEndpoint",
    "DEFAULT_APPLY_TIMEOUT_SECONDS",
    "DEFAULT_DISCOVERY_TIMEOUT_SECONDS",
    "DEFAULT_HTTP_TIMEOUT_SECONDS",
    "DEFAULT_POLL_INTERVAL_SECONDS",
    "DEFAULT_WS_TIMEOUT_SECONDS",
    "DEVTOOLS_ACTIVE_PORT_FILE",
    "DevToolsActivePort",
    "apply_identity_cdp_overrides",
    "close_page_target",
    "create_page_target_endpoint",
    "discover_devtools_endpoint",
    "discover_page_target_endpoint",
    "page_navigate",
    "read_devtools_active_port",
    "runtime_evaluate",
    "set_device_metrics_override",
    "set_locale_override",
    "set_timezone_override",
    "set_user_agent_override",
    "select_page_target_endpoint",
]
