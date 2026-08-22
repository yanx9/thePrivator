"""Persistent local proxy bridge for Chromium SOCKS5 authentication.

Chromium does not reliably provide username/password credentials to upstream
SOCKS5 proxies. The sidecar launches this small local no-auth SOCKS5 bridge and
points Chromium at it; the bridge authenticates to the real upstream SOCKS5
provider. It is a private runtime process and must not log credentials.
"""

from __future__ import annotations

import json
import select
import socket
import socketserver
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import Any, Mapping, Optional

SOCKS5_BRIDGE_VERSION = 1
LOCAL_HOST = "127.0.0.1"
SOCKET_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class Socks5BridgeConfig:
    upstream_host: str
    upstream_port: int
    username: str
    password: str
    ready_file: Path


class Socks5BridgeServer:
    def __init__(self, config: Socks5BridgeConfig) -> None:
        self.config = config
        self._server: Optional[_ThreadingTcpServer] = None
        self._thread: Optional[threading.Thread] = None
        self.local_host = LOCAL_HOST
        self.local_port = 0

    def __enter__(self) -> "Socks5BridgeServer":
        self.start()
        return self

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> None:
        self.close()

    def start(self) -> None:
        if self._server is not None:
            return
        server = _ThreadingTcpServer((LOCAL_HOST, 0), _BridgeSocks5Handler)
        server.bridge_config = self.config  # type: ignore[attr-defined]
        host, port = server.server_address[:2]
        self.local_host = str(host)
        self.local_port = int(port)
        self._server = server
        self._thread = threading.Thread(target=server.serve_forever, name="theprivator-socks5-bridge", daemon=True)
        self._thread.start()
        _write_ready_file(self.config.ready_file, self.local_host, self.local_port)

    def serve_forever(self) -> None:
        if self._server is None:
            self.start()
        assert self._server is not None
        self._server.serve_forever(poll_interval=0.5)

    def close(self) -> None:
        server = self._server
        thread = self._thread
        self._server = None
        self._thread = None
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None and thread.is_alive():
            thread.join(timeout=1.0)


class _ThreadingTcpServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


class _BridgeSocks5Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        upstream: Optional[socket.socket] = None
        try:
            config = _config_from_server(self.server)
            self.request.settimeout(SOCKET_TIMEOUT_SECONDS)
            _accept_chromium_no_auth(self.request)
            target_host, target_port = _read_chromium_connect_request(self.request)
            upstream = _connect_upstream(config, target_host, target_port)
            _send_success_response(self.request)
            _tunnel_pair(self.request, upstream)
        except Exception:
            _safe_send(self.request, b"\x05\x01\x00\x01\x00\x00\x00\x00\x00\x00")
        finally:
            if upstream is not None:
                upstream.close()


def run_bridge_from_config_path(config_path: str) -> int:
    try:
        config = _read_config(Path(config_path))
        with Socks5BridgeServer(config) as server:
            server.serve_forever()
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:
        # Deliberately avoid printing exception details because config contains
        # upstream credentials. The parent process treats missing ready file as
        # a safe launch failure.
        return 1


def _read_config(path: Path) -> Socks5BridgeConfig:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping) or payload.get("bridgeVersion") != SOCKS5_BRIDGE_VERSION:
        raise ValueError("invalid bridge config")
    upstream = payload.get("upstream")
    credentials = payload.get("credentials")
    ready_file = payload.get("readyFile")
    if not isinstance(upstream, Mapping) or not isinstance(credentials, Mapping) or not isinstance(ready_file, str):
        raise ValueError("invalid bridge config")
    host = upstream.get("host")
    port = upstream.get("port")
    username = credentials.get("username")
    password = credentials.get("password")
    if not isinstance(host, str) or not host or not isinstance(port, int) or port < 1 or port > 65535:
        raise ValueError("invalid bridge upstream")
    if not isinstance(username, str) or not username or not isinstance(password, str) or not password:
        raise ValueError("invalid bridge credentials")
    return Socks5BridgeConfig(
        upstream_host=host,
        upstream_port=port,
        username=username,
        password=password,
        ready_file=Path(ready_file),
    )


def _write_ready_file(path: Path, host: str, port: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"bridgeVersion": SOCKS5_BRIDGE_VERSION, "host": host, "port": port}, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _config_from_server(server: Any) -> Socks5BridgeConfig:
    config = getattr(server, "bridge_config", None)
    if not isinstance(config, Socks5BridgeConfig):
        raise ValueError("missing bridge config")
    return config


def _accept_chromium_no_auth(sock: socket.socket) -> None:
    if _read_exact(sock, 1) != b"\x05":
        raise ValueError("not socks5")
    method_count = _read_exact(sock, 1)[0]
    methods = _read_exact(sock, method_count)
    if 0 not in methods:
        sock.sendall(b"\x05\xff")
        raise ValueError("no acceptable method")
    sock.sendall(b"\x05\x00")


def _read_chromium_connect_request(sock: socket.socket) -> tuple[str, int]:
    if _read_exact(sock, 1) != b"\x05":
        raise ValueError("invalid request version")
    command = _read_exact(sock, 1)
    reserved = _read_exact(sock, 1)
    atyp = _read_exact(sock, 1)
    if command != b"\x01" or reserved != b"\x00":
        raise ValueError("unsupported command")
    host = _read_socks5_address(sock, atyp)
    port = int.from_bytes(_read_exact(sock, 2), "big")
    if port < 1 or port > 65535:
        raise ValueError("invalid target port")
    return host, port


def _connect_upstream(config: Socks5BridgeConfig, target_host: str, target_port: int) -> socket.socket:
    upstream = socket.create_connection((config.upstream_host, config.upstream_port), timeout=SOCKET_TIMEOUT_SECONDS)
    upstream.settimeout(SOCKET_TIMEOUT_SECONDS)
    try:
        username = config.username.encode("utf-8")
        password = config.password.encode("utf-8")
        if len(username) > 255 or len(password) > 255:
            raise ValueError("credentials too long")
        upstream.sendall(b"\x05\x01\x02")
        if _read_exact(upstream, 2) != b"\x05\x02":
            raise ValueError("upstream auth unsupported")
        upstream.sendall(b"\x01" + bytes([len(username)]) + username + bytes([len(password)]) + password)
        if _read_exact(upstream, 2) != b"\x01\x00":
            raise ValueError("upstream auth rejected")
        target = _socks5_address_bytes(target_host)
        upstream.sendall(b"\x05\x01\x00" + target + target_port.to_bytes(2, "big"))
        _read_upstream_connect_response(upstream)
        return upstream
    except Exception:
        upstream.close()
        raise


def _send_success_response(sock: socket.socket) -> None:
    sock.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")


def _read_upstream_connect_response(sock: socket.socket) -> None:
    header = _read_exact(sock, 4)
    if header[:2] != b"\x05\x00":
        raise ValueError("upstream connect failed")
    atyp = header[3]
    if atyp == 1:
        _read_exact(sock, 4)
    elif atyp == 3:
        length = _read_exact(sock, 1)[0]
        _read_exact(sock, length)
    elif atyp == 4:
        _read_exact(sock, 16)
    else:
        raise ValueError("upstream connect response malformed")
    _read_exact(sock, 2)


def _read_socks5_address(sock: socket.socket, atyp: bytes) -> str:
    if atyp == b"\x01":
        return socket.inet_ntoa(_read_exact(sock, 4))
    if atyp == b"\x03":
        length = _read_exact(sock, 1)[0]
        if length == 0:
            raise ValueError("empty domain")
        return _read_exact(sock, length).decode("idna")
    if atyp == b"\x04":
        return socket.inet_ntop(socket.AF_INET6, _read_exact(sock, 16))
    raise ValueError("unsupported address type")


def _socks5_address_bytes(host: str) -> bytes:
    try:
        return b"\x01" + socket.inet_aton(host)
    except OSError:
        pass
    try:
        return b"\x04" + socket.inet_pton(socket.AF_INET6, host)
    except OSError:
        pass
    encoded = host.encode("idna")
    if not encoded or len(encoded) > 255:
        raise ValueError("invalid domain")
    return b"\x03" + bytes([len(encoded)]) + encoded


def _tunnel_pair(left: socket.socket, right: socket.socket) -> None:
    sockets = [left, right]
    for sock in sockets:
        sock.settimeout(SOCKET_TIMEOUT_SECONDS)
    while sockets:
        readable, _, errored = select.select(sockets, [], sockets, SOCKET_TIMEOUT_SECONDS)
        if errored:
            return
        if not readable:
            return
        for source in readable:
            target = right if source is left else left
            data = source.recv(65536)
            if not data:
                return
            target.sendall(data)


def _read_exact(sock: socket.socket, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining > 0:
        chunk = sock.recv(remaining)
        if not chunk:
            raise ValueError("socket closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _safe_send(sock: socket.socket, data: bytes) -> None:
    try:
        sock.sendall(data)
    except Exception:
        return


if __name__ == "__main__":  # pragma: no cover - exercised through sidecar CLI integration.
    raise SystemExit(run_bridge_from_config_path(sys.argv[1] if len(sys.argv) > 1 else ""))
