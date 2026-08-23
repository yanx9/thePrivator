"""Deterministic local proxy routing fixtures for Chromium proxy proof work.

This module is intentionally sidecar-internal.  It provides ephemeral loopback
servers that prove routing by observation instead of by public IP checker pages:
a local target host is advertised under an intentionally non-resolvable
``.invalid`` hostname, and each proxy fixture maps that host+port to the local
server.  If Chromium falls back to a direct connection, normal DNS cannot make
the target resolve.

Public summaries are bounded and redacted.  They never include credentials,
``Proxy-Authorization`` values, WebSocket URLs, Chromium command lines, generated
certificate/key paths, or raw fixture socket payloads.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import select
import socket
import socketserver
import ssl
import tempfile
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import TracebackType
from typing import Any, Callable, Mapping, Optional, Sequence, Union
from urllib.parse import quote, urlsplit, urlunsplit

from .cdp import CdpClient, CdpEndpoint, CdpPageEndpoint, page_navigate, runtime_evaluate
from .protocol import JsonObject, PROXY_CONNECTIVITY_FAILED, PROXY_INVALID, PROXY_PROOF_FAILED, SidecarError
from .proxy import FIXED_SERVER_PROXY_MODE, PROXY_VERSION, normalize_proxy_config

PROXY_PROOF_SCHEMA_VERSION = 1
DEFAULT_PROOF_TARGET_HOST = "theprivator-proxy-proof.invalid"
DEFAULT_PROOF_TARGET_PORT = 80
PROXY_PROOF_PATH = "/theprivator-proxy-proof"
MAX_OBSERVATIONS = 24
MAX_OBSERVATION_STRING_LENGTH = 160
MAX_SUMMARY_BYTES = 8192
SOCKET_TIMEOUT_SECONDS = 2.0
SAFE_CONNECTIVITY_MESSAGE = "Proxy connectivity proof could not be completed."
SAFE_PROOF_MESSAGE = "Proxy proof could not be collected."

STATUS_OK = "ok"
FAILURE_AUTH = "auth-failed"
FAILURE_CONNECTIVITY = "connectivity-failed"
FAILURE_DIRECT_FALLBACK = "direct-fallback-suspected"
FAILURE_NO_PROXY_OBSERVATION = "no-proxy-observation"
FAILURE_NAVIGATION = "navigation-failed"
FAILURE_MALFORMED = "malformed-fixture-response"

_HTTP_PROXY_KINDS = frozenset({"http", "https"})
_SOCKS_PROXY_KINDS = frozenset({"socks4", "socks5"})
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_IGNORED_PROXY_HEADERS = frozenset({"proxy-authorization", "proxy-connection"})

# Static self-signed proof-only certificate for the TLS-wrapped HTTPS proxy
# fixture.  It is not trusted by normal launches.  Verifiers that need Chromium
# to connect to this HTTPS proxy should use the SPKI pin exposed by
# ``HttpsProxyCertificateStrategy.to_chromium_arg`` for this proof case only.
_HTTPS_PROXY_CERT_PEM = """-----BEGIN CERTIFICATE-----
MIIDYzCCAkugAwIBAgIUbxOqXJqyHghAnf7wR3VQl63rm80wDQYJKoZIhvcNAQEL
BQAwKDEmMCQGA1UEAwwddGhlcHJpdmF0b3ItcHJveHktcHJvb2YubG9jYWwwHhcN
MjYwNTEyMDEyMDU3WhcNMzYwNTA5MDEyMDU3WjAoMSYwJAYDVQQDDB10aGVwcml2
YXRvci1wcm94eS1wcm9vZi5sb2NhbDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBAMCWd7UwkrRm2JNuC1r4nmWh+2oJVNhkHjBiTTpLxXFJOBfK1SNHzS5f
2/RR3s7NWxw4s6nzZfV7hCRBYagTLcZcO0W9KphwTYFAow/TZLgNXpI9bL6sy2zz
N0Zx7cjIswHNcVpRK2Jwm6pEjJ8VFn+nIm5Xu1wUFbvxpZf7p6ccZ054Yup6NhfM
a6qqDhVOoMLl5Lqk0pqC2Muf2ULlmUyvN2KePNCM4BkY4/zlEFlZftOpQhl28lwU
Rk0IbdyY750kuKtJ7wDzSBz/ATAX7mrvZbbpRybkEeCSKwK+WQD2cJW7rCCPv+kU
hgCqWhp1UiJXa9LUmZmJepSXPaLyxGsCAwEAAaOBhDCBgTAdBgNVHQ4EFgQU1bqS
y+6uxnob7I1OQRBOVjqc214wHwYDVR0jBBgwFoAU1bqSy+6uxnob7I1OQRBOVjqc
214wDwYDVR0TAQH/BAUwAwEB/zAuBgNVHREEJzAlgh10aGVwcml2YXRvci1wcm94
eS1wcm9vZi5sb2NhbIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAUjl76wcFYZdu
UpG4puLf1zhRUD7glOxLf6IMMVlLy53LkRnhEiARPzNMobBnVeaXWLYEdSMOUfP4
YsEUkRaVxas76ohuw0FLWYzDXc5/35B5n6w74VXXUF9U14I7TyyvTw4FTAG9F0gU
CVRDgrWazfXtMZC6raXEj3drVUri4tNKPoX9YTqeVHnlHGIx+DD70uvALZqH7jqE
D84OvVScHfdwexW49HLf6VPPDjExJ2q4CH/Y3ka30swPWR3BIkYJ9iF9/3tFXZXi
UXXsgh2LVFkqZn10BtJqdwDO7sjnjzAiQSCg/8u2biPJNnh5CdgYJPbhLHXi98f9
ZmDrT/a2OA==
-----END CERTIFICATE-----
"""

_HTTPS_PROXY_KEY_PEM = """-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDAlne1MJK0ZtiT
bgta+J5loftqCVTYZB4wYk06S8VxSTgXytUjR80uX9v0Ud7OzVscOLOp82X1e4Qk
QWGoEy3GXDtFvSqYcE2BQKMP02S4DV6SPWy+rMts8zdGce3IyLMBzXFaUSticJuq
RIyfFRZ/pyJuV7tcFBW78aWX+6enHGdOeGLqejYXzGuqqg4VTqDC5eS6pNKagtjL
n9lC5ZlMrzdinjzQjOAZGOP85RBZWX7TqUIZdvJcFEZNCG3cmO+dJLirSe8A80gc
/wEwF+5q72W26Ucm5BHgkisCvlkA9nCVu6wgj7/pFIYAqloadVIiV2vS1JmZiXqU
lz2i8sRrAgMBAAECggEABF3lDPiy+uAyHPWr0D4+6TMJDlhz0gxDGvm/oojBS1ZL
rU5uEsS4BEssI5gPo0TIwhUPDdV1BGHulxvcaQE2Un8Y4PXvF1HEkB+1EtDKQdob
wNkftBsa6beCE1jV+W2DkZDk9xVMFIlVHkE7pwfFYNObVkErAGV8MKzEAnQ0Uvep
0usKJFY1KVHe8wcJEu/XZUS4LIT7KjnA8kFY453XXOlSPjEFwWHPwLbNjjrhZXh8
OlJRbyfGnQOfCWM/nRoiLg9acikgpYRtzOVjdQgrI/r5Gq0bMw5R9lNlRADd0iIA
cRQXWk6caco7ZO51WTpqg6XdtDkgPgpnbb2ogPR6wQKBgQDpmCF3fJu71UMcg385
wD0GFDVOc9aUvvQh7qwCAZCuG78Tjil+kI/s8SzYulqtGKOmlA26XeBH3grXm+hT
OBh3jxev2DrDt55Vm+pSMjL8kN4J9fc8Z0RaF8Pvv1nOwoZmU0pcEkAM6achlJm4
8tWx5LJfuhjUfbrWo/JXTgrAEQKBgQDTD23SYnBO7Zl05gzWD0/pDGMo11E5g+I8
5CMxBDh/N7YOjULK7bcnyAqpkxcHMpqtYqhSEuVDVgdbOSxV2DpN/I8v15yjxH7B
WZjt+MpifmXuP1vXCcjjbkzAXN3aAdPcP5gsJ3g7XsGaUN73WJcOfEmCQvhUlaqN
3SmCToj4uwKBgD31WxMdWxVUOKvMeSdxRP5ix8zaTtU/XPPPIZKapax4sZLXR0xJ
vdMkGTgXHcwB2A5sAMQo+D83tvp/YP0JyPuVWbwLh3K4NmgQpfNNW1bAehR8SCqe
XXPkD9V8lK6RzCJB/1wyfwitxOXUS33R8zpvJZzceI+MFc2uyK29hn5xAoGAa5y3
Swij6Kpejuro6o++F74YJO+7205yIMfVZZ2YTM0UB1FhF+SieScWwKVdnW7gzLy7
w7UcrfuEHrAE+fQYrkCypRsTI7EBTAYp4lPypMt7n0Ewy3CSu9s2SPJQr2I1KlxG
c2Tgeazzm4HWXVkPE/Ss6jzJLx9saY61JlpynhcCgYEAuCYsxEbvaLjKRz50mVb4
+psHTkt2N4+G5dQwVkp9LjJ+8fbgAU8KSDKxDOeXlvBC+vCxvWQf5RYbcjyEzJ5Z
xNODxgAQklOiSn5j5tQI4SjQAY/LgcAqfL8RvZ3Au+DA9N7R313//aRnNHkuh/CH
ux7YHb4zAelv7dKPa3n/+9w=
-----END PRIVATE KEY-----
"""

_HTTPS_PROXY_SPKI_SHA256 = "y8VuPogkxk3j+yWc5N8rSssl98o/Rj+GdrgQD2s1rXU="

ClientFactory = Callable[..., Any]


@dataclass(frozen=True)
class HttpsProxyCertificateStrategy:
    """Scoped proof-only trust metadata for the HTTPS proxy fixture."""

    spki_sha256: str = _HTTPS_PROXY_SPKI_SHA256

    def __post_init__(self) -> None:
        _validate_spki_pin(self.spki_sha256)

    def to_public_dict(self) -> JsonObject:
        """Return safe verifier metadata without command-line switch text."""
        return {"kind": "spki-pin", "spkiSha256": self.spki_sha256}

    def to_chromium_arg(self) -> str:
        """Return the one proof-only Chromium arg a verifier may append.

        This is deliberately not used by ``chromium.launch``.  Normal sidecar
        launches continue to reject both broad certificate-ignore switches and
        this SPKI switch; only an isolated proof verifier should consume it.
        """
        return f"--ignore-certificate-errors-spki-list={self.spki_sha256}"


@dataclass(frozen=True)
class ProxyProofCase:
    """Validated local proxy proof case metadata."""

    label: str
    kind: str
    proxy: JsonObject
    target_host: str = DEFAULT_PROOF_TARGET_HOST
    target_port: int = DEFAULT_PROOF_TARGET_PORT
    target_path: str = PROXY_PROOF_PATH
    managed_fixture: bool = True

    @property
    def target_url(self) -> str:
        netloc = self.target_host if self.target_port == 80 else f"{self.target_host}:{self.target_port}"
        return urlunsplit(("http", netloc, self.target_path, f"case={quote(self.label, safe='')}", ""))

    def to_public_dict(self) -> JsonObject:
        return {
            "label": self.label,
            "kind": self.kind,
            "targetHost": self.target_host,
            "targetPort": self.target_port,
            "managedFixture": self.managed_fixture,
        }


class _ObservationStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._observations: list[JsonObject] = []

    def record(self, **fields: Any) -> None:
        observation = _bounded_json_object(
            {
                key: _safe_observation_value(value)
                for key, value in fields.items()
                if value is not None
            }
        )
        with self._lock:
            self._observations.append(observation)
            del self._observations[:-MAX_OBSERVATIONS]

    def observations(self) -> list[JsonObject]:
        with self._lock:
            return [dict(item) for item in self._observations]


class ProxyProofTargetServer:
    """Ephemeral loopback HTTP target mapped by the proxy fixtures."""

    def __init__(self) -> None:
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._store = _ObservationStore()
        self.local_host = "127.0.0.1"
        self.local_port = 0

    def __enter__(self) -> "ProxyProofTargetServer":
        try:
            server = ThreadingHTTPServer((self.local_host, 0), _ProxyProofTargetHandler)
            server.proof_store = self._store  # type: ignore[attr-defined]
            host, port = server.server_address[:2]
            self.local_host = str(host)
            self.local_port = int(port)
            self._server = server
            self._thread = threading.Thread(target=server.serve_forever, name="proxy-proof-target", daemon=True)
            self._thread.start()
            return self
        except Exception as exc:
            self.close()
            raise _connectivity_error() from exc

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> None:
        self.close()

    @property
    def local_address(self) -> tuple[str, int]:
        if self.local_port <= 0:
            raise _connectivity_error()
        return (self.local_host, self.local_port)

    def observations(self) -> list[JsonObject]:
        return self._store.observations()

    def close(self) -> None:
        server = self._server
        thread = self._thread
        self._server = None
        self._thread = None
        if server is not None:
            try:
                server.shutdown()
            except Exception:
                pass
            try:
                server.server_close()
            except Exception:
                pass
        if thread is not None and thread.is_alive():
            thread.join(timeout=1.0)


class _ProxyProofTargetHandler(BaseHTTPRequestHandler):
    server_version = "ThePrivatorProxyProofTarget/1"
    sys_version = ""

    def do_GET(self) -> None:  # noqa: N802 - stdlib API name.
        status = HTTPStatus.OK if self.path.startswith(PROXY_PROOF_PATH) else HTTPStatus.NOT_FOUND
        store = getattr(self.server, "proof_store", None)
        if isinstance(store, _ObservationStore):
            store.record(
                fixture="target",
                phase="request",
                method="GET",
                status=int(status),
                host=_safe_host_header(self.headers.get("Host")),
                path=urlsplit(self.path).path or "/",
            )
        if status == HTTPStatus.NOT_FOUND:
            self.send_error(status)
            return
        body = json.dumps(
            {
                "schemaVersion": PROXY_PROOF_SCHEMA_VERSION,
                "proof": "theprivator proxy proof",
                "target": DEFAULT_PROOF_TARGET_HOST,
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib API name.
        return


class _ThreadingTcpServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


class _ThreadingTlsTcpServer(_ThreadingTcpServer):
    def __init__(self, server_address: tuple[str, int], handler: type[socketserver.BaseRequestHandler], context: ssl.SSLContext) -> None:
        self._ssl_context = context
        super().__init__(server_address, handler)

    def get_request(self) -> tuple[socket.socket, Any]:
        raw_socket, address = super().get_request()
        try:
            return self._ssl_context.wrap_socket(raw_socket, server_side=True), address
        except Exception:
            raw_socket.close()
            raise


class BaseProxyFixture:
    """Base context-manager for ephemeral loopback proxy fixtures."""

    kind = "proxy"

    def __init__(
        self,
        *,
        target_host: str = DEFAULT_PROOF_TARGET_HOST,
        target_port: int = DEFAULT_PROOF_TARGET_PORT,
        target_address: tuple[str, int],
        credentials: Optional[tuple[str, str]] = None,
    ) -> None:
        self.target_host = _validate_host(target_host)
        self.target_port = _validate_port(target_port)
        self.target_address = target_address
        self.credentials = credentials
        self.local_host = "127.0.0.1"
        self.local_port = 0
        self._store = _ObservationStore()
        self._server: Optional[_ThreadingTcpServer] = None
        self._thread: Optional[threading.Thread] = None
        self._temp_dir: Optional[tempfile.TemporaryDirectory[str]] = None

    def __enter__(self) -> "BaseProxyFixture":
        self.start()
        return self

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> None:
        self.close()

    @property
    def local_address(self) -> tuple[str, int]:
        if self.local_port <= 0:
            raise _connectivity_error()
        return (self.local_host, self.local_port)

    @property
    def proxy_url(self) -> str:
        return f"{self.kind}://{self.local_host}:{self.local_port}"

    def start(self) -> None:
        if self._server is not None:
            return
        try:
            server = self._make_server()
            server.fixture = self  # type: ignore[attr-defined]
            host, port = server.server_address[:2]
            self.local_host = str(host)
            self.local_port = int(port)
            self._server = server
            self._thread = threading.Thread(target=server.serve_forever, name=f"proxy-proof-{self.kind}", daemon=True)
            self._thread.start()
        except Exception as exc:
            self.close()
            raise _connectivity_error() from exc

    def _make_server(self) -> _ThreadingTcpServer:
        return _ThreadingTcpServer((self.local_host, 0), _HttpProxyHandler)

    def close(self) -> None:
        server = self._server
        thread = self._thread
        temp_dir = self._temp_dir
        self._server = None
        self._thread = None
        self._temp_dir = None
        if server is not None:
            try:
                server.shutdown()
            except Exception:
                pass
            try:
                server.server_close()
            except Exception:
                pass
        if thread is not None and thread.is_alive():
            thread.join(timeout=1.0)
        if temp_dir is not None:
            temp_dir.cleanup()

    def observations(self) -> list[JsonObject]:
        return self._store.observations()

    def record(self, **fields: Any) -> None:
        self._store.record(fixture=self.kind, **fields)

    def is_mapped_target(self, host: str, port: int) -> bool:
        return host.casefold() == self.target_host.casefold() and int(port) == self.target_port

    def connect_target(self, host: str, port: int) -> socket.socket:
        if not self.is_mapped_target(host, port):
            self.record(phase="connect", status="target-unmapped", targetHost=host, targetPort=port)
            raise _ProxyFixtureFailure(FAILURE_CONNECTIVITY)
        return socket.create_connection(self.target_address, timeout=SOCKET_TIMEOUT_SECONDS)


class HttpProxyFixture(BaseProxyFixture):
    """Plain HTTP fixed-server proxy fixture with optional Basic auth."""

    kind = "http"


class HttpsProxyFixture(BaseProxyFixture):
    """TLS-wrapped HTTPS fixed-server proxy fixture with optional Basic auth."""

    kind = "https"

    @property
    def certificate_strategy(self) -> HttpsProxyCertificateStrategy:
        return HttpsProxyCertificateStrategy()

    def _make_server(self) -> _ThreadingTcpServer:
        temp_dir = tempfile.TemporaryDirectory(prefix="theprivator-proxy-proof-")
        cert_path = Path(temp_dir.name) / "proxy-cert.pem"
        key_path = Path(temp_dir.name) / "proxy-key.pem"
        cert_path.write_text(_HTTPS_PROXY_CERT_PEM, encoding="utf-8")
        key_path.write_text(_HTTPS_PROXY_KEY_PEM, encoding="utf-8")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
        self._temp_dir = temp_dir
        return _ThreadingTlsTcpServer((self.local_host, 0), _HttpProxyHandler, context)


class Socks4ProxyFixture(BaseProxyFixture):
    """SOCKS4/SOCKS4a no-auth proxy fixture."""

    kind = "socks4"

    def _make_server(self) -> _ThreadingTcpServer:
        return _ThreadingTcpServer((self.local_host, 0), _Socks4ProxyHandler)


class Socks5ProxyFixture(BaseProxyFixture):
    """SOCKS5 proxy fixture with optional username/password auth."""

    kind = "socks5"

    def _make_server(self) -> _ThreadingTcpServer:
        return _ThreadingTcpServer((self.local_host, 0), _Socks5ProxyHandler)


class _ProxyFixtureFailure(Exception):
    def __init__(self, failure_class: str) -> None:
        super().__init__(failure_class)
        self.failure_class = failure_class


class _HttpProxyHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        fixture = _fixture_from_server(self.server)
        try:
            self.request.settimeout(SOCKET_TIMEOUT_SECONDS)
            raw_headers = _read_until(self.request, b"\r\n\r\n", 16384)
            request_line, headers = _parse_http_request_head(raw_headers)
            method, target, version = request_line
            if version not in {"HTTP/1.0", "HTTP/1.1"}:
                raise _ProxyFixtureFailure(FAILURE_MALFORMED)

            auth_state = _proxy_auth_state(headers, fixture.credentials)
            if auth_state != "accepted":
                fixture.record(phase="request", method=method, status="auth-failed", auth=auth_state)
                _send_proxy_auth_required(self.request)
                return

            if method.upper() == "CONNECT":
                host, port = _parse_connect_target(target)
                fixture.record(
                    phase="connect",
                    method="CONNECT",
                    status="accepted",
                    auth=auth_state,
                    targetHost=host,
                    targetPort=port,
                )
                upstream = fixture.connect_target(host, port)
                try:
                    self.request.sendall(b"HTTP/1.1 200 Connection Established\r\nProxy-Agent: ThePrivatorProxyProof\r\n\r\n")
                    _tunnel_pair(self.request, upstream, timeout_seconds=SOCKET_TIMEOUT_SECONDS)
                finally:
                    upstream.close()
                return

            parsed = urlsplit(target)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                raise _ProxyFixtureFailure(FAILURE_MALFORMED)
            host = parsed.hostname
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            path = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
            fixture.record(
                phase="request",
                method=method.upper(),
                status="accepted",
                auth=auth_state,
                targetHost=host,
                targetPort=port,
            )
            upstream = fixture.connect_target(host, port)
            try:
                _send_origin_form_request(upstream, method, path, parsed.netloc, version, headers)
                _relay_until_eof(upstream, self.request)
            finally:
                upstream.close()
        except _ProxyFixtureFailure as exc:
            fixture.record(phase="request", status=exc.failure_class)
            _safe_send(self.request, b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        except Exception:
            fixture.record(phase="request", status=FAILURE_CONNECTIVITY)
            _safe_send(self.request, b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")


class _Socks4ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        fixture = _fixture_from_server(self.server)
        upstream: Optional[socket.socket] = None
        try:
            self.request.settimeout(SOCKET_TIMEOUT_SECONDS)
            version = _read_exact(self.request, 1)
            if version != b"\x04":
                raise _ProxyFixtureFailure(FAILURE_MALFORMED)
            command = _read_exact(self.request, 1)
            port = int.from_bytes(_read_exact(self.request, 2), "big")
            ip_bytes = _read_exact(self.request, 4)
            _read_c_string(self.request, 256)  # userid, ignored and never recorded.
            if command != b"\x01":
                raise _ProxyFixtureFailure(FAILURE_CONNECTIVITY)
            if ip_bytes[:3] == b"\x00\x00\x00" and ip_bytes[3] != 0:
                host = _read_c_string(self.request, 256).decode("ascii", errors="strict")
            else:
                host = socket.inet_ntoa(ip_bytes)
            host = _validate_host(host)
            fixture.record(phase="connect", method="CONNECT", status="accepted", targetHost=host, targetPort=port)
            upstream = fixture.connect_target(host, port)
            self.request.sendall(b"\x00\x5a" + port.to_bytes(2, "big") + b"\x00\x00\x00\x00")
            _tunnel_pair(self.request, upstream, timeout_seconds=SOCKET_TIMEOUT_SECONDS)
        except _ProxyFixtureFailure as exc:
            fixture.record(phase="connect", status=exc.failure_class)
            _safe_send(self.request, b"\x00\x5b\x00\x00\x00\x00\x00\x00")
        except Exception:
            fixture.record(phase="connect", status=FAILURE_CONNECTIVITY)
            _safe_send(self.request, b"\x00\x5b\x00\x00\x00\x00\x00\x00")
        finally:
            if upstream is not None:
                upstream.close()


class _Socks5ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        fixture = _fixture_from_server(self.server)
        upstream: Optional[socket.socket] = None
        try:
            self.request.settimeout(SOCKET_TIMEOUT_SECONDS)
            if _read_exact(self.request, 1) != b"\x05":
                raise _ProxyFixtureFailure(FAILURE_MALFORMED)
            method_count = _read_exact(self.request, 1)[0]
            methods = _read_exact(self.request, method_count)
            if fixture.credentials is not None:
                if 2 not in methods:
                    fixture.record(phase="greeting", status="auth-failed")
                    self.request.sendall(b"\x05\xff")
                    return
                self.request.sendall(b"\x05\x02")
                _handle_socks5_username_password_auth(self.request, fixture)
            else:
                if 0 not in methods:
                    fixture.record(phase="greeting", status="auth-unsupported")
                    self.request.sendall(b"\x05\xff")
                    return
                self.request.sendall(b"\x05\x00")
            if _read_exact(self.request, 1) != b"\x05":
                raise _ProxyFixtureFailure(FAILURE_MALFORMED)
            command = _read_exact(self.request, 1)
            reserved = _read_exact(self.request, 1)
            atyp = _read_exact(self.request, 1)
            if command != b"\x01" or reserved != b"\x00":
                raise _ProxyFixtureFailure(FAILURE_CONNECTIVITY)
            host = _read_socks5_address(self.request, atyp)
            port = int.from_bytes(_read_exact(self.request, 2), "big")
            fixture.record(phase="connect", method="CONNECT", status="accepted", targetHost=host, targetPort=port)
            upstream = fixture.connect_target(host, port)
            self.request.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00" + port.to_bytes(2, "big"))
            _tunnel_pair(self.request, upstream, timeout_seconds=SOCKET_TIMEOUT_SECONDS)
        except _ProxyFixtureFailure as exc:
            fixture.record(phase="connect", status=exc.failure_class)
            _safe_send(self.request, b"\x05\x01\x00\x01\x00\x00\x00\x00\x00\x00")
        except Exception:
            fixture.record(phase="connect", status=FAILURE_CONNECTIVITY)
            _safe_send(self.request, b"\x05\x01\x00\x01\x00\x00\x00\x00\x00\x00")
        finally:
            if upstream is not None:
                upstream.close()


def _handle_socks5_username_password_auth(sock: socket.socket, fixture: BaseProxyFixture) -> None:
    if _read_exact(sock, 1) != b"\x01":
        raise _ProxyFixtureFailure(FAILURE_MALFORMED)
    username_length = _read_exact(sock, 1)[0]
    username = _read_exact(sock, username_length).decode("utf-8", errors="strict")
    password_length = _read_exact(sock, 1)[0]
    password = _read_exact(sock, password_length).decode("utf-8", errors="strict")
    if fixture.credentials != (username, password):
        fixture.record(phase="auth", status="auth-failed")
        sock.sendall(b"\x01\x01")
        raise _ProxyFixtureFailure(FAILURE_AUTH)
    fixture.record(phase="auth", status="accepted")
    sock.sendall(b"\x01\x00")


def collect_proxy_proof(
    store_root: Union[str, Path],
    case: Mapping[str, Any],
    *,
    endpoint_or_url: Optional[Union[CdpEndpoint, CdpPageEndpoint, str]] = None,
    client_factory: ClientFactory = CdpClient,
    timeout_seconds: float = 5.0,
) -> JsonObject:
    """Collect one deterministic local proxy proof summary.

    ``store_root`` is accepted for API symmetry with other sidecar proof helpers;
    this function does not read or write ignored project artifacts.  By default
    it starts managed local fixtures and exercises them with an internal socket
    client.  When ``endpoint_or_url`` is supplied, it drives an existing CDP page
    target to the exact proof URL instead.
    """
    del store_root  # Avoid accidental filesystem coupling to ignored artifacts.
    started = time.perf_counter()
    proof_case = parse_proxy_proof_case(case)
    if not proof_case.managed_fixture:
        _probe_configured_proxy_or_raise(proof_case)

    try:
        with ProxyProofTargetServer() as target:
            credentials = _credentials_for_case(proof_case)
            fixture = create_proxy_fixture(
                proof_case.kind,
                target_host=proof_case.target_host,
                target_port=proof_case.target_port,
                target_address=target.local_address,
                credentials=credentials,
            )
            with fixture:
                if endpoint_or_url is None:
                    navigation = _exercise_fixture_with_socket_client(fixture, proof_case, timeout_seconds=timeout_seconds)
                else:
                    navigation = _exercise_fixture_with_cdp(
                        endpoint_or_url,
                        proof_case,
                        client_factory=client_factory,
                        timeout_seconds=timeout_seconds,
                    )
                return classify_proxy_proof(
                    proof_case,
                    proxy_observations=fixture.observations(),
                    target_observations=target.observations(),
                    navigation=navigation,
                    duration_ms=_elapsed_ms(started),
                    certificate_strategy=(
                        fixture.certificate_strategy.to_public_dict()
                        if isinstance(fixture, HttpsProxyFixture)
                        else None
                    ),
                )
    except SidecarError:
        raise
    except Exception as exc:
        raise _proof_error() from exc


def parse_proxy_proof_case(case: Mapping[str, Any]) -> ProxyProofCase:
    if not isinstance(case, Mapping):
        raise _invalid_proxy_case_error()
    label = _safe_label(case.get("label", "proxy-proof"))
    proxy = normalize_proxy_config(case.get("proxy"))
    if proxy.get("mode") != FIXED_SERVER_PROXY_MODE:
        raise _invalid_proxy_case_error()
    kind = str(proxy.get("protocol", "")).lower()
    if kind not in _HTTP_PROXY_KINDS and kind not in _SOCKS_PROXY_KINDS:
        raise _invalid_proxy_case_error()
    target = _case_target(case)
    target_host = target["host"]
    target_port = target["port"]
    target_path = target["path"]
    managed = case.get("managedFixture")
    if managed is None:
        # Port 9 is commonly used in negative tests to represent an unreachable
        # configured proxy.  Privileged/low ports are not created as managed
        # fixtures unless the caller explicitly asks for that.
        managed_fixture = not (isinstance(proxy.get("port"), int) and int(proxy["port"]) < 1024)
    elif isinstance(managed, bool):
        managed_fixture = managed
    else:
        raise _invalid_proxy_case_error()
    return ProxyProofCase(
        label=label,
        kind=kind,
        proxy=_bounded_json_object(proxy),
        target_host=target_host,
        target_port=target_port,
        target_path=target_path,
        managed_fixture=managed_fixture,
    )


def create_proxy_fixture(
    kind: str,
    *,
    target_host: str,
    target_port: int,
    target_address: tuple[str, int],
    credentials: Optional[tuple[str, str]] = None,
) -> BaseProxyFixture:
    if kind == "http":
        return HttpProxyFixture(
            target_host=target_host,
            target_port=target_port,
            target_address=target_address,
            credentials=credentials,
        )
    if kind == "https":
        return HttpsProxyFixture(
            target_host=target_host,
            target_port=target_port,
            target_address=target_address,
            credentials=credentials,
        )
    if kind == "socks4":
        return Socks4ProxyFixture(target_host=target_host, target_port=target_port, target_address=target_address)
    if kind == "socks5":
        return Socks5ProxyFixture(
            target_host=target_host,
            target_port=target_port,
            target_address=target_address,
            credentials=credentials,
        )
    raise _invalid_proxy_case_error()


def classify_proxy_proof(
    proof_case: ProxyProofCase,
    *,
    proxy_observations: Sequence[Mapping[str, Any]],
    target_observations: Sequence[Mapping[str, Any]],
    navigation: Mapping[str, Any],
    duration_ms: float,
    certificate_strategy: Optional[Mapping[str, Any]] = None,
) -> JsonObject:
    """Classify routing proof observations into a redacted success summary.

    Failures raise typed ``SidecarError`` values; callers can correlate those via
    ``detailRef`` while keeping detailed fixture state in local verifier output.
    """
    safe_proxy_observations = _bounded_observations(proxy_observations)
    safe_target_observations = _bounded_observations(target_observations)
    safe_navigation = _bounded_json_object(navigation)
    failure_class = _failure_class_from_observations(
        proxy_observations=safe_proxy_observations,
        target_observations=safe_target_observations,
        navigation=safe_navigation,
    )
    summary = _bounded_summary(
        {
            "schemaVersion": PROXY_PROOF_SCHEMA_VERSION,
            "status": STATUS_OK if failure_class is None else "failed",
            "caseLabel": proof_case.label,
            "fixtureKind": proof_case.kind,
            "durationMs": max(0.0, duration_ms),
            "directFallbackDetected": failure_class == FAILURE_DIRECT_FALLBACK,
            "target": {"host": proof_case.target_host, "port": proof_case.target_port},
            "navigation": safe_navigation,
            "observations": {
                "proxyCount": len(safe_proxy_observations),
                "targetCount": len(safe_target_observations),
                "proxy": safe_proxy_observations,
                "target": safe_target_observations,
            },
            **({"certificateTrust": _bounded_json_object(certificate_strategy)} if certificate_strategy else {}),
        }
    )
    if failure_class is None:
        return summary
    if failure_class in {FAILURE_AUTH, FAILURE_CONNECTIVITY, FAILURE_NAVIGATION, FAILURE_MALFORMED}:
        raise _connectivity_error()
    raise _proof_error()


def _exercise_fixture_with_socket_client(
    fixture: BaseProxyFixture,
    proof_case: ProxyProofCase,
    *,
    timeout_seconds: float,
) -> JsonObject:
    if isinstance(fixture, (HttpProxyFixture, HttpsProxyFixture)):
        status = _http_proxy_client_roundtrip(fixture, proof_case, timeout_seconds=timeout_seconds)
    elif isinstance(fixture, Socks4ProxyFixture):
        status = _socks4_client_roundtrip(fixture, proof_case, timeout_seconds=timeout_seconds)
    elif isinstance(fixture, Socks5ProxyFixture):
        status = _socks5_client_roundtrip(fixture, proof_case, timeout_seconds=timeout_seconds)
    else:
        raise _invalid_proxy_case_error()
    return {"status": "navigated" if status == HTTPStatus.OK else "failed", "httpStatus": int(status)}


def _exercise_fixture_with_cdp(
    endpoint_or_url: Union[CdpEndpoint, CdpPageEndpoint, str],
    proof_case: ProxyProofCase,
    *,
    client_factory: ClientFactory,
    timeout_seconds: float,
) -> JsonObject:
    try:
        web_socket_url = _page_endpoint_url(endpoint_or_url)
        with client_factory(web_socket_url, timeout_seconds=timeout_seconds) as client:
            client.command("Page.enable", {}, timeout_seconds=timeout_seconds)
            navigation = page_navigate(
                client,
                proof_case.target_url,
                timeout_seconds=timeout_seconds,
                allowed_urls={proof_case.target_url},
            )
            marker = runtime_evaluate(
                client,
                "document.body ? document.body.textContent : ''",
                await_promise=False,
                return_by_value=True,
                timeout_seconds=timeout_seconds,
            )
        return {
            "status": "navigated",
            "frame": "present" if navigation.get("frameId") else "missing",
            "marker": "present" if isinstance(marker, str) and "theprivator proxy proof" in marker else "missing",
        }
    except SidecarError as exc:
        if exc.code == PROXY_PROOF_FAILED:
            raise
        raise _proof_error() from exc
    except Exception as exc:
        raise _proof_error() from exc


def _http_proxy_client_roundtrip(
    fixture: Union[HttpProxyFixture, HttpsProxyFixture],
    proof_case: ProxyProofCase,
    *,
    timeout_seconds: float,
) -> HTTPStatus:
    raw_socket = socket.create_connection(fixture.local_address, timeout=max(0.001, timeout_seconds))
    try:
        if isinstance(fixture, HttpsProxyFixture):
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            sock = context.wrap_socket(raw_socket, server_hostname="theprivator-proxy-proof.local")
        else:
            sock = raw_socket
        sock.settimeout(max(0.001, timeout_seconds))
        headers = [
            f"GET {proof_case.target_url} HTTP/1.1",
            f"Host: {proof_case.target_host}",
            "Connection: close",
            "User-Agent: ThePrivatorProxyProof/1",
        ]
        if fixture.credentials is not None:
            token = base64.b64encode(f"{fixture.credentials[0]}:{fixture.credentials[1]}".encode("utf-8")).decode("ascii")
            headers.append(f"Proxy-Authorization: Basic {token}")
        sock.sendall(("\r\n".join(headers) + "\r\n\r\n").encode("ascii"))
        response = _read_until(sock, b"\r\n", 1024)
        return _parse_status_line(response)
    except Exception as exc:
        raise _connectivity_error() from exc
    finally:
        try:
            raw_socket.close()
        except Exception:
            pass


def _socks4_client_roundtrip(fixture: Socks4ProxyFixture, proof_case: ProxyProofCase, *, timeout_seconds: float) -> HTTPStatus:
    with socket.create_connection(fixture.local_address, timeout=max(0.001, timeout_seconds)) as sock:
        sock.settimeout(max(0.001, timeout_seconds))
        port = proof_case.target_port.to_bytes(2, "big")
        sock.sendall(b"\x04\x01" + port + b"\x00\x00\x00\x01" + b"\x00" + proof_case.target_host.encode("ascii") + b"\x00")
        response = _read_exact(sock, 8)
        if response[:2] != b"\x00\x5a":
            raise _connectivity_error()
        _send_tunneled_http_get(sock, proof_case)
        status_line = _read_until(sock, b"\r\n", 1024)
        return _parse_status_line(status_line)


def _socks5_client_roundtrip(fixture: Socks5ProxyFixture, proof_case: ProxyProofCase, *, timeout_seconds: float) -> HTTPStatus:
    with socket.create_connection(fixture.local_address, timeout=max(0.001, timeout_seconds)) as sock:
        sock.settimeout(max(0.001, timeout_seconds))
        if fixture.credentials is not None:
            sock.sendall(b"\x05\x01\x02")
            if _read_exact(sock, 2) != b"\x05\x02":
                raise _connectivity_error()
            username_bytes = fixture.credentials[0].encode("utf-8")
            password_bytes = fixture.credentials[1].encode("utf-8")
            if len(username_bytes) > 255 or len(password_bytes) > 255:
                raise _connectivity_error()
            sock.sendall(b"\x01" + bytes([len(username_bytes)]) + username_bytes + bytes([len(password_bytes)]) + password_bytes)
            if _read_exact(sock, 2) != b"\x01\x00":
                raise _connectivity_error()
        else:
            sock.sendall(b"\x05\x01\x00")
            if _read_exact(sock, 2) != b"\x05\x00":
                raise _connectivity_error()
        host_bytes = proof_case.target_host.encode("ascii")
        if len(host_bytes) > 255:
            raise _connectivity_error()
        sock.sendall(
            b"\x05\x01\x00\x03"
            + bytes([len(host_bytes)])
            + host_bytes
            + proof_case.target_port.to_bytes(2, "big")
        )
        response = _read_exact(sock, 10)
        if response[:2] != b"\x05\x00":
            raise _connectivity_error()
        _send_tunneled_http_get(sock, proof_case)
        status_line = _read_until(sock, b"\r\n", 1024)
        return _parse_status_line(status_line)


def _send_tunneled_http_get(sock: socket.socket, proof_case: ProxyProofCase) -> None:
    request = (
        f"GET {proof_case.target_path}?case={quote(proof_case.label, safe='')} HTTP/1.1\r\n"
        f"Host: {proof_case.target_host}\r\n"
        "Connection: close\r\n"
        "User-Agent: ThePrivatorProxyProof/1\r\n\r\n"
    )
    sock.sendall(request.encode("ascii"))


def _probe_configured_proxy_or_raise(proof_case: ProxyProofCase) -> None:
    host = proof_case.proxy.get("host")
    port = proof_case.proxy.get("port")
    if not isinstance(host, str) or not isinstance(port, int):
        raise _invalid_proxy_case_error()
    try:
        with socket.create_connection((host, port), timeout=SOCKET_TIMEOUT_SECONDS):
            pass
    except Exception as exc:
        raise _connectivity_error() from exc
    raise _proof_error()


def _failure_class_from_observations(
    *,
    proxy_observations: Sequence[Mapping[str, Any]],
    target_observations: Sequence[Mapping[str, Any]],
    navigation: Mapping[str, Any],
) -> Optional[str]:
    statuses = {str(item.get("status", "")) for item in proxy_observations}
    if "auth-failed" in statuses or "missing" in statuses or "rejected" in statuses:
        return FAILURE_AUTH
    if FAILURE_MALFORMED in statuses:
        return FAILURE_MALFORMED
    if FAILURE_CONNECTIVITY in statuses or "target-unmapped" in statuses:
        return FAILURE_CONNECTIVITY
    if navigation.get("status") not in {"navigated", "ok"}:
        return FAILURE_NAVIGATION
    if not proxy_observations and target_observations:
        return FAILURE_DIRECT_FALLBACK
    if not proxy_observations:
        return FAILURE_NO_PROXY_OBSERVATION
    if not target_observations:
        return FAILURE_CONNECTIVITY
    if navigation.get("marker") == "missing":
        return FAILURE_NAVIGATION
    return None


def _credentials_for_case(proof_case: ProxyProofCase) -> Optional[tuple[str, str]]:
    credentials = proof_case.proxy.get("credentials")
    if credentials is None:
        return None
    if proof_case.kind == "socks4":
        raise _invalid_proxy_case_error()
    if not isinstance(credentials, Mapping):
        raise _invalid_proxy_case_error()
    username = credentials.get("username")
    password = credentials.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        raise _invalid_proxy_case_error()
    return (username, password)


def _case_target(case: Mapping[str, Any]) -> JsonObject:
    target_url = case.get("targetUrl") if isinstance(case.get("targetUrl"), str) else None
    if target_url is None:
        return {"host": DEFAULT_PROOF_TARGET_HOST, "port": DEFAULT_PROOF_TARGET_PORT, "path": PROXY_PROOF_PATH}
    try:
        parsed = urlsplit(target_url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise _invalid_proxy_case_error() from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise _invalid_proxy_case_error()
    return {
        "host": _validate_host(parsed.hostname),
        "port": _validate_port(port),
        "path": _validate_path(parsed.path or PROXY_PROOF_PATH),
    }


def _page_endpoint_url(endpoint_or_url: Union[CdpEndpoint, CdpPageEndpoint, str]) -> str:
    if isinstance(endpoint_or_url, CdpEndpoint):
        # The proxy proof collector expects a page target to already exist; real
        # launch orchestration is responsible for target discovery/creation.
        raise _proof_error()
    if isinstance(endpoint_or_url, CdpPageEndpoint):
        return endpoint_or_url.web_socket_debugger_url
    if isinstance(endpoint_or_url, str):
        return endpoint_or_url
    raise _proof_error()


def _fixture_from_server(server: Any) -> BaseProxyFixture:
    fixture = getattr(server, "fixture", None)
    if not isinstance(fixture, BaseProxyFixture):
        raise _connectivity_error()
    return fixture


def _parse_http_request_head(raw: bytes) -> tuple[tuple[str, str, str], dict[str, str]]:
    try:
        text = raw.decode("iso-8859-1")
    except UnicodeDecodeError as exc:
        raise _ProxyFixtureFailure(FAILURE_MALFORMED) from exc
    lines = text.split("\r\n")
    if not lines or not lines[0]:
        raise _ProxyFixtureFailure(FAILURE_MALFORMED)
    parts = lines[0].split(" ")
    if len(parts) != 3 or any(not part for part in parts):
        raise _ProxyFixtureFailure(FAILURE_MALFORMED)
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if not line:
            continue
        if ":" not in line:
            raise _ProxyFixtureFailure(FAILURE_MALFORMED)
        name, value = line.split(":", 1)
        if not name:
            raise _ProxyFixtureFailure(FAILURE_MALFORMED)
        headers[name.lower()] = value.strip()
    return (parts[0], parts[1], parts[2]), headers


def _proxy_auth_state(headers: Mapping[str, str], credentials: Optional[tuple[str, str]]) -> str:
    if credentials is None:
        return "accepted"
    header = headers.get("proxy-authorization")
    if not header:
        return "missing"
    prefix = "Basic "
    if not header.startswith(prefix):
        return "rejected"
    try:
        decoded = base64.b64decode(header[len(prefix) :], validate=True).decode("utf-8")
    except Exception:
        return "rejected"
    expected = f"{credentials[0]}:{credentials[1]}"
    return "accepted" if hmac.compare_digest(decoded, expected) else "rejected"


def _send_proxy_auth_required(sock: socket.socket) -> None:
    _safe_send(
        sock,
        b"HTTP/1.1 407 Proxy Authentication Required\r\n"
        b"Proxy-Authenticate: Basic realm=\"theprivator-proxy-proof\"\r\n"
        b"Content-Length: 0\r\nConnection: close\r\n\r\n",
    )


def _parse_connect_target(target: str) -> tuple[str, int]:
    if target.count(":") == 1:
        host, port_text = target.rsplit(":", 1)
    elif target.startswith("[") and "]:" in target:
        host, port_text = target.rsplit(":", 1)
        host = host.strip("[]")
    else:
        raise _ProxyFixtureFailure(FAILURE_MALFORMED)
    if not port_text.isdecimal():
        raise _ProxyFixtureFailure(FAILURE_MALFORMED)
    return _validate_host(host), _validate_port(int(port_text))


def _send_origin_form_request(
    upstream: socket.socket,
    method: str,
    path: str,
    netloc: str,
    version: str,
    headers: Mapping[str, str],
) -> None:
    lines = [f"{method.upper()} {path or '/'} {version}"]
    header_names = set()
    for name, value in headers.items():
        if name in _IGNORED_PROXY_HEADERS:
            continue
        if name == "host":
            value = netloc
        header_names.add(name)
        if _is_safe_header_value(value):
            lines.append(f"{_canonical_header_name(name)}: {value}")
    if "host" not in header_names:
        lines.append(f"Host: {netloc}")
    lines.append("Connection: close")
    upstream.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("iso-8859-1"))


def _read_socks5_address(sock: socket.socket, atyp: bytes) -> str:
    if atyp == b"\x01":
        return socket.inet_ntoa(_read_exact(sock, 4))
    if atyp == b"\x03":
        length = _read_exact(sock, 1)[0]
        return _validate_host(_read_exact(sock, length).decode("ascii", errors="strict"))
    if atyp == b"\x04":
        return socket.inet_ntop(socket.AF_INET6, _read_exact(sock, 16))
    raise _ProxyFixtureFailure(FAILURE_MALFORMED)


def _tunnel_pair(client: socket.socket, upstream: socket.socket, *, timeout_seconds: float) -> None:
    sockets = [client, upstream]
    deadline = time.monotonic() + max(0.05, timeout_seconds)
    while sockets and time.monotonic() < deadline:
        readable, _writable, _errored = select.select(sockets, [], sockets, 0.05)
        if not readable:
            continue
        for source in readable:
            try:
                chunk = source.recv(8192)
            except OSError:
                return
            if not chunk:
                return
            destination = upstream if source is client else client
            try:
                destination.sendall(chunk)
            except OSError:
                return


def _relay_until_eof(source: socket.socket, destination: socket.socket) -> None:
    while True:
        chunk = source.recv(8192)
        if not chunk:
            break
        destination.sendall(chunk)


def _read_until(sock: socket.socket, marker: bytes, max_bytes: int) -> bytes:
    data = bytearray()
    while marker not in data:
        chunk = sock.recv(1)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > max_bytes:
            raise _ProxyFixtureFailure(FAILURE_MALFORMED)
    if marker not in data:
        raise _ProxyFixtureFailure(FAILURE_CONNECTIVITY)
    return bytes(data)


def _read_exact(sock: socket.socket, length: int) -> bytes:
    data = bytearray()
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise _ProxyFixtureFailure(FAILURE_MALFORMED)
        data.extend(chunk)
    return bytes(data)


def _read_c_string(sock: socket.socket, max_bytes: int) -> bytes:
    data = bytearray()
    while True:
        chunk = _read_exact(sock, 1)
        if chunk == b"\x00":
            return bytes(data)
        data.extend(chunk)
        if len(data) > max_bytes:
            raise _ProxyFixtureFailure(FAILURE_MALFORMED)


def _safe_send(sock: socket.socket, payload: bytes) -> None:
    try:
        sock.sendall(payload)
    except Exception:
        return


def _parse_status_line(line: bytes) -> HTTPStatus:
    try:
        text = line.decode("ascii", errors="strict").strip()
        parts = text.split(" ", 2)
        if len(parts) < 2 or not parts[1].isdecimal():
            raise ValueError("status line is malformed")
        return HTTPStatus(int(parts[1]))
    except Exception as exc:
        raise _connectivity_error() from exc


def _bounded_observations(observations: Sequence[Mapping[str, Any]]) -> list[JsonObject]:
    return [_bounded_json_object(item) for item in list(observations)[-MAX_OBSERVATIONS:]]


def _bounded_summary(payload: Mapping[str, Any]) -> JsonObject:
    bounded = _bounded_json_object(payload)
    encoded = json.dumps(bounded, ensure_ascii=False, allow_nan=False, sort_keys=True)
    if len(encoded.encode("utf-8")) > MAX_SUMMARY_BYTES:
        raise _proof_error()
    _assert_no_forbidden_markers(encoded)
    return bounded


def _bounded_json_object(payload: Mapping[str, Any]) -> JsonObject:
    bounded = _bounded_json_value(payload)
    if not isinstance(bounded, dict):
        raise _proof_error()
    return bounded


def _bounded_json_value(value: Any, *, depth: int = 0) -> Any:
    if depth > 10:
        return None
    if isinstance(value, Mapping):
        result: JsonObject = {}
        for index, (key, nested) in enumerate(value.items()):
            if index >= MAX_OBSERVATIONS:
                break
            if isinstance(key, str) and key:
                result[key[:MAX_OBSERVATION_STRING_LENGTH]] = _bounded_json_value(nested, depth=depth + 1)
        return result
    if isinstance(value, (list, tuple)):
        return [_bounded_json_value(item, depth=depth + 1) for item in list(value)[:MAX_OBSERVATIONS]]
    if isinstance(value, str):
        return value[:MAX_OBSERVATION_STRING_LENGTH]
    if value is None or isinstance(value, bool) or isinstance(value, int):
        return value
    if isinstance(value, float):
        json.dumps(value, allow_nan=False)
        return value
    return None


def _safe_observation_value(value: Any) -> Any:
    if isinstance(value, str):
        lowered = value.casefold()
        if "proxy-authorization" in lowered or "basic " in lowered or "--proxy-server" in lowered or "ws://" in lowered:
            return "<redacted>"
    return value


def _assert_no_forbidden_markers(encoded: str) -> None:
    lowered = encoded.casefold()
    forbidden = (
        "proxy-authorization",
        "password",
        "username",
        "credentials",
        "--proxy-server",
        "ws://",
        "wss://",
        "devtoolsactiveport",
        "traceback",
        "private key",
        "proxy-key.pem",
        "proxy-cert.pem",
    )
    if any(marker in lowered for marker in forbidden):
        raise _proof_error()


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 3)


def _safe_label(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return "proxy-proof"
    label = value.strip()[:96]
    if any(ord(character) < 32 for character in label):
        raise _invalid_proxy_case_error()
    return label


def _validate_host(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 253:
        raise _invalid_proxy_case_error()
    if any(ord(character) < 33 for character in value) or "/" in value or "@" in value:
        raise _invalid_proxy_case_error()
    return value.lower()


def _validate_port(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value > 65535:
        raise _invalid_proxy_case_error()
    return value


def _validate_path(value: Any) -> str:
    if not isinstance(value, str) or not value.startswith("/") or len(value) > 256:
        raise _invalid_proxy_case_error()
    if any(ord(character) < 32 for character in value) or "\\" in value:
        raise _invalid_proxy_case_error()
    return value


def _safe_host_header(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value[:MAX_OBSERVATION_STRING_LENGTH]


def _is_safe_header_value(value: str) -> bool:
    return not any(ord(character) < 32 and character != "\t" for character in value)


def _canonical_header_name(name: str) -> str:
    return "-".join(part.capitalize() for part in name.split("-"))


def _validate_spki_pin(value: str) -> None:
    if not isinstance(value, str) or not value or len(value) > 128:
        raise _proof_error()
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise _proof_error() from exc
    if len(decoded) != hashlib.sha256().digest_size:
        raise _proof_error()


def _invalid_proxy_case_error() -> SidecarError:
    return SidecarError(code=PROXY_INVALID, message="Proxy proof case is invalid.")


def _connectivity_error() -> SidecarError:
    return SidecarError(code=PROXY_CONNECTIVITY_FAILED, message=SAFE_CONNECTIVITY_MESSAGE)


def _proof_error() -> SidecarError:
    return SidecarError(code=PROXY_PROOF_FAILED, message=SAFE_PROOF_MESSAGE)


__all__ = [
    "DEFAULT_PROOF_TARGET_HOST",
    "DEFAULT_PROOF_TARGET_PORT",
    "FAILURE_AUTH",
    "FAILURE_CONNECTIVITY",
    "FAILURE_DIRECT_FALLBACK",
    "FAILURE_MALFORMED",
    "FAILURE_NAVIGATION",
    "FAILURE_NO_PROXY_OBSERVATION",
    "HttpProxyFixture",
    "HttpsProxyCertificateStrategy",
    "HttpsProxyFixture",
    "PROXY_PROOF_PATH",
    "PROXY_PROOF_SCHEMA_VERSION",
    "ProxyProofCase",
    "ProxyProofTargetServer",
    "Socks4ProxyFixture",
    "Socks5ProxyFixture",
    "classify_proxy_proof",
    "collect_proxy_proof",
    "create_proxy_fixture",
    "parse_proxy_proof_case",
]
