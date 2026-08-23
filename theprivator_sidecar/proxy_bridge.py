"""Persistent local proxy bridge for Chromium SOCKS5 authentication.

Chromium does not reliably provide username/password credentials to upstream
SOCKS5 proxies. The sidecar launches this small local no-auth SOCKS5 bridge and
points Chromium at it; the bridge authenticates to the real upstream SOCKS5
provider. It is a private runtime process and must not log credentials.
"""

from __future__ import annotations

import json
import os
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
# Bounds the SOCKS5 handshake only. Once the tunnel is established the sockets
# go back to blocking mode -- see _tunnel_pair.
SOCKET_TIMEOUT_SECONDS = 10.0
# How long select() waits before looping. Not a deadline: an idle tunnel simply
# polls again. Bounded so a closed peer is noticed reasonably promptly.
TUNNEL_SELECT_TIMEOUT_SECONDS = 30.0


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
        replied = False
        try:
            config = _config_from_server(self.server)
            self.request.settimeout(SOCKET_TIMEOUT_SECONDS)
            _accept_chromium_no_auth(self.request)
            target_host, target_port = _read_chromium_connect_request(self.request)
            upstream = _connect_upstream(config, target_host, target_port)
            _send_success_response(self.request)
            replied = True
            _tunnel_pair(self.request, upstream)
        except Exception:
            # Only meaningful before the success reply. Sending it afterwards
            # appends ten bytes of SOCKS5 framing to whatever the page was
            # already reading, corrupting the response instead of reporting a
            # failure. Deliberately never logged: config holds credentials.
            if not replied:
                _safe_send(self.request, b"\x05\x01\x00\x01\x00\x00\x00\x00\x00\x00")
        finally:
            if upstream is not None:
                upstream.close()


def run_bridge_from_stdin(stream: Any = None) -> int:
    """Read one JSON config line from stdin and serve until killed.

    The config carries the upstream proxy password, so it is handed over through
    the pipe rather than written to a file. A file would have to be created,
    chmod'ed, and deleted on every exit path -- and the paths that raise before
    the delete are exactly the ones that leave plaintext credentials on disk.
    A pipe has no such failure mode, and the credentials never touch the
    filesystem at all.
    """
    try:
        source = sys.stdin if stream is None else stream
        config = _read_config_payload(source.readline())
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


def _read_config_payload(raw: str) -> Socks5BridgeConfig:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("missing bridge config")
    return _parse_config(json.loads(raw))


def _parse_config(payload: Any) -> Socks5BridgeConfig:
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
    """Publish the bound port, and hold the file locked for this process's life.

    The lock is an ownership token, not a mutual-exclusion device. The parent
    records this bridge's pid so it can stop it later, but a pid alone is not
    proof of identity: after a reboot the OS reuses pids freely, and killing a
    recorded pid that now belongs to something else takes an unrelated process
    tree down with it. Because the kernel drops an flock when the holder dies,
    "can I take this lock?" answers "is my bridge still the one running?"
    without any bookkeeping that can itself go stale.

    The descriptor is deliberately leaked for the process lifetime: closing it
    would release the lock. It is reclaimed when the bridge exits.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        {
            "bridgeVersion": SOCKS5_BRIDGE_VERSION,
            "host": host,
            "port": port,
            "pid": os.getpid(),
        },
        sort_keys=True,
    )
    handle = open(path, "w", encoding="utf-8")  # noqa: SIM115 - held for the process lifetime on purpose.
    _hold_exclusive_lock(handle)
    handle.write(payload + "\n")
    handle.flush()
    os.fsync(handle.fileno())
    global _READY_FILE_HANDLE
    _READY_FILE_HANDLE = handle


# Kept alive so the lock taken in _write_ready_file survives until process exit.
_READY_FILE_HANDLE: Optional[Any] = None


def _hold_exclusive_lock(handle: Any) -> None:
    """Take a best-effort exclusive lock; a platform without one still works.

    Where locking is unavailable the parent falls back to matching the recorded
    pid, which is weaker but no worse than the behaviour this replaces.
    """
    try:
        if os.name == "posix":
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        elif os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except (ImportError, OSError):
        return


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
    """Read one SOCKS5 address, keeping domains exactly as they arrived.

    Domains are deliberately not decoded. Python's "idna" codec implements
    IDNA-2003, which rejects names Chromium legitimately sends -- a label longer
    than 63 characters, or a punycode name that does not round-trip, such as
    xn--fa-hia.de. Worse, decode-then-re-encode can rewrite a name into a
    different one: xn--80ak6aa92e.com becomes a Cyrillic homoglyph of apple.com.

    A proxy has no business interpreting hostnames. The bytes are validated as
    ASCII and length-bounded, then forwarded verbatim to the upstream, which is
    the party that actually resolves them.
    """
    if atyp == b"\x01":
        return socket.inet_ntoa(_read_exact(sock, 4))
    if atyp == b"\x03":
        length = _read_exact(sock, 1)[0]
        if length == 0:
            raise ValueError("empty domain")
        raw = _read_exact(sock, length)
        try:
            host = raw.decode("ascii")
        except UnicodeDecodeError as exc:
            raise ValueError("non-ascii domain") from exc
        if "\x00" in host:
            raise ValueError("invalid domain")
        return host
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
    try:
        encoded = host.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError("invalid domain") from exc
    if not encoded or len(encoded) > 255 or b"\x00" in encoded:
        raise ValueError("invalid domain")
    return b"\x03" + bytes([len(encoded)]) + encoded


def _tunnel_pair(left: socket.socket, right: socket.socket) -> None:
    """Relay bytes between the two sockets until both directions have closed.

    Three things this must not do, each of which it used to:

    - Treat an idle period as fatal. A tunnelled WebSocket, SSE stream, or
      keep-alive connection is legitimately silent for minutes; tearing it down
      after the handshake timeout made those look like ERR_CONNECTION_RESET.
      The handshake deadline does not apply once the tunnel is established.

    - Close both directions when one reports EOF. A peer that finishes sending
      and half-closes while the other side is still uploading must have its
      write side shut down, not the whole pair -- otherwise the upload truncates.

    - Leave the sockets in timeout mode. sendall() on a timeout-mode socket can
      raise after a partial write, silently corrupting the stream; blocking mode
      makes a short write impossible.
    """
    for sock in (left, right):
        sock.settimeout(None)

    readable_sockets = [left, right]
    while readable_sockets:
        try:
            readable, _, errored = select.select(readable_sockets, [], readable_sockets, TUNNEL_SELECT_TIMEOUT_SECONDS)
        except (OSError, ValueError):
            return
        if errored:
            return
        if not readable:
            # No traffic within the poll window. That is normal for an idle
            # tunnel, so keep waiting rather than closing a healthy connection.
            continue
        for source in readable:
            target = right if source is left else left
            try:
                data = source.recv(65536)
            except OSError:
                return
            if not data:
                # One direction is done. Signal EOF downstream and stop reading
                # this side, but let the opposite direction keep flowing.
                readable_sockets.remove(source)
                try:
                    target.shutdown(socket.SHUT_WR)
                except OSError:
                    return
                continue
            try:
                target.sendall(data)
            except OSError:
                return


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
    raise SystemExit(run_bridge_from_stdin())
