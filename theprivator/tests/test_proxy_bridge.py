"""Tests for the local SOCKS5 authentication bridge.

The bridge sits in the data path of every credentialed SOCKS5 profile: Chromium
speaks no-auth SOCKS5 to it, and it authenticates to the real upstream. A fake
upstream SOCKS5 server runs in-process so the protocol behaviour can be checked
against real sockets rather than mocks.
"""

import io
import json
import socket
import socketserver
import threading
import time
from typing import Optional

import pytest

from theprivator_sidecar.proxy_bridge import (
    SOCKS5_BRIDGE_VERSION,
    Socks5BridgeConfig,
    Socks5BridgeServer,
    run_bridge_from_stdin,
)

UPSTREAM_USERNAME = "bridge-sentinel-user"
UPSTREAM_PASSWORD = "bridge-sentinel-pass"

NO_AUTH = b"\x05\x01\x00"
GREETING_OK = b"\x05\x00"
REPLY_SUCCESS_PREFIX = b"\x05\x00\x00"
REPLY_FAILURE = b"\x05\x01\x00\x01\x00\x00\x00\x00\x00\x00"


class FakeUpstream:
    """A minimal RFC1929 SOCKS5 server that echoes whatever it is sent.

    Records the target address each CONNECT asked for, so tests can assert what
    the bridge forwarded without inspecting the bridge's internals.
    """

    def __init__(self, *, require_credentials: bool = True) -> None:
        self.require_credentials = require_credentials
        self.requested_targets: list[tuple[str, int]] = []
        self.offered_credentials: list[tuple[str, bytes]] = []
        self._server: Optional[socketserver.TCPServer] = None
        self._thread: Optional[threading.Thread] = None
        self.host = "127.0.0.1"
        self.port = 0

    def __enter__(self) -> "FakeUpstream":
        outer = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                outer._serve_connection(self.request)

        class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self._server = Server((self.host, 0), Handler)
        self.host, self.port = self._server.server_address[:2]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def _serve_connection(self, sock: socket.socket) -> None:
        try:
            version = _read_exact(sock, 1)
            count = _read_exact(sock, 1)[0]
            methods = _read_exact(sock, count)
            if version != b"\x05":
                return
            if self.require_credentials:
                if b"\x02" not in methods:
                    sock.sendall(b"\x05\xff")
                    return
                sock.sendall(b"\x05\x02")
                assert _read_exact(sock, 1) == b"\x01"
                ulen = _read_exact(sock, 1)[0]
                username = _read_exact(sock, ulen).decode("utf-8")
                plen = _read_exact(sock, 1)[0]
                password = _read_exact(sock, plen)
                self.offered_credentials.append((username, password))
                ok = username == UPSTREAM_USERNAME and password == UPSTREAM_PASSWORD.encode("utf-8")
                sock.sendall(b"\x01\x00" if ok else b"\x01\x01")
                if not ok:
                    return
            else:
                sock.sendall(b"\x05\x00")

            assert _read_exact(sock, 3) == b"\x05\x01\x00"
            atyp = _read_exact(sock, 1)
            if atyp == b"\x01":
                host = socket.inet_ntoa(_read_exact(sock, 4))
            elif atyp == b"\x03":
                host = _read_exact(sock, _read_exact(sock, 1)[0]).decode("ascii")
            else:
                host = socket.inet_ntop(socket.AF_INET6, _read_exact(sock, 16))
            port = int.from_bytes(_read_exact(sock, 2), "big")
            self.requested_targets.append((host, port))
            sock.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")

            while True:
                data = sock.recv(65536)
                if not data:
                    sock.shutdown(socket.SHUT_WR)
                    return
                sock.sendall(data)
        except (OSError, AssertionError, UnicodeDecodeError):
            return


def _read_exact(sock: socket.socket, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining > 0:
        chunk = sock.recv(remaining)
        if not chunk:
            raise OSError("closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


@pytest.fixture
def bridge(tmp_path):
    """A running bridge in front of a credential-checking fake upstream."""
    with FakeUpstream() as upstream:
        config = Socks5BridgeConfig(
            upstream_host=upstream.host,
            upstream_port=upstream.port,
            username=UPSTREAM_USERNAME,
            password=UPSTREAM_PASSWORD,
            ready_file=tmp_path / "bridge.ready.json",
        )
        with Socks5BridgeServer(config) as server:
            yield server, upstream


def connect_through(server: Socks5BridgeServer, host: str, port: int = 80) -> socket.socket:
    """Complete a no-auth SOCKS5 CONNECT through the bridge, return the socket."""
    client = socket.create_connection((server.local_host, server.local_port), timeout=5.0)
    client.sendall(NO_AUTH)
    assert _read_exact(client, 2) == GREETING_OK
    client.sendall(_connect_request(host, port))
    reply = _read_exact(client, 4)
    assert reply[:3] == REPLY_SUCCESS_PREFIX, f"bridge refused CONNECT: {reply!r}"
    _read_exact(client, 4 if reply[3:4] == b"\x01" else 16)
    _read_exact(client, 2)
    return client


def _connect_request(host: str, port: int) -> bytes:
    try:
        address = b"\x01" + socket.inet_aton(host)
    except OSError:
        encoded = host.encode("ascii")
        address = b"\x03" + bytes([len(encoded)]) + encoded
    return b"\x05\x01\x00" + address + port.to_bytes(2, "big")


def test_ready_file_reports_the_bound_loopback_port(bridge, tmp_path):
    server, _upstream = bridge
    payload = json.loads((tmp_path / "bridge.ready.json").read_text(encoding="utf-8"))

    assert payload == {"bridgeVersion": SOCKS5_BRIDGE_VERSION, "host": "127.0.0.1", "port": server.local_port}


def test_relays_traffic_and_authenticates_to_the_upstream(bridge):
    server, upstream = bridge

    client = connect_through(server, "127.0.0.1", 8080)
    try:
        client.sendall(b"hello upstream")
        assert _read_exact(client, 14) == b"hello upstream"
    finally:
        client.close()

    assert upstream.offered_credentials == [(UPSTREAM_USERNAME, UPSTREAM_PASSWORD.encode("utf-8"))]
    assert upstream.requested_targets == [("127.0.0.1", 8080)]


def test_forwards_punycode_hostnames_verbatim(bridge):
    """IDNA-2003 round-tripping used to mangle or reject these.

    xn--fa-hia.de does not survive decode/re-encode, and xn--80ak6aa92e.com
    decodes to a Cyrillic homoglyph of apple.com -- forwarding a different host
    than the one requested.
    """
    server, upstream = bridge

    for hostname in ("xn--fa-hia.de", "xn--80ak6aa92e.com", "a" * 64 + ".example.com"):
        client = connect_through(server, hostname, 443)
        client.close()

    assert [host for host, _ in upstream.requested_targets] == [
        "xn--fa-hia.de",
        "xn--80ak6aa92e.com",
        "a" * 64 + ".example.com",
    ]


def test_idle_tunnel_survives_longer_than_the_handshake_timeout(bridge):
    """A silent WebSocket or long-poll must not be torn down for being quiet."""
    server, _upstream = bridge

    client = connect_through(server, "127.0.0.1", 8080)
    try:
        client.sendall(b"first")
        assert _read_exact(client, 5) == b"first"

        time.sleep(11.0)  # longer than SOCKET_TIMEOUT_SECONDS

        client.sendall(b"second")
        assert _read_exact(client, 6) == b"second"
    finally:
        client.close()


def test_half_close_does_not_tear_down_the_other_direction(bridge):
    """A client that finishes sending must still receive the pending response."""
    server, _upstream = bridge

    client = connect_through(server, "127.0.0.1", 8080)
    try:
        client.sendall(b"payload-before-half-close")
        client.shutdown(socket.SHUT_WR)

        assert _read_exact(client, 25) == b"payload-before-half-close"
    finally:
        client.close()


def test_large_bidirectional_transfer_is_not_truncated(bridge):
    server, _upstream = bridge

    payload = bytes(range(256)) * 4096  # 1 MiB, well past one recv buffer
    client = connect_through(server, "127.0.0.1", 8080)
    try:
        sender = threading.Thread(target=client.sendall, args=(payload,), daemon=True)
        sender.start()
        assert _read_exact(client, len(payload)) == payload
        sender.join(timeout=10.0)
    finally:
        client.close()


def test_refuses_a_client_that_does_not_offer_no_auth(bridge):
    server, _upstream = bridge

    client = socket.create_connection((server.local_host, server.local_port), timeout=5.0)
    try:
        client.sendall(b"\x05\x01\x02")  # offers username/password only
        assert _read_exact(client, 2) == b"\x05\xff"
    finally:
        client.close()


def test_reports_failure_when_the_upstream_rejects_the_credentials(tmp_path):
    with FakeUpstream() as upstream:
        config = Socks5BridgeConfig(
            upstream_host=upstream.host,
            upstream_port=upstream.port,
            username="wrong-user",
            password="wrong-pass",
            ready_file=tmp_path / "bridge.ready.json",
        )
        with Socks5BridgeServer(config) as server:
            client = socket.create_connection((server.local_host, server.local_port), timeout=5.0)
            try:
                client.sendall(NO_AUTH)
                assert _read_exact(client, 2) == GREETING_OK
                client.sendall(_connect_request("127.0.0.1", 8080))
                assert _read_exact(client, 10) == REPLY_FAILURE
            finally:
                client.close()


def test_does_not_inject_a_failure_reply_into_an_established_tunnel(bridge):
    """The failure reply is only meaningful before the success reply.

    Sending it mid-tunnel appends ten bytes of SOCKS5 framing to whatever the
    page is reading. The upstream is killed after the tunnel is up, so the
    handler's error path runs with a reply already sent.
    """
    server, upstream = bridge

    client = connect_through(server, "127.0.0.1", 8080)
    try:
        client.sendall(b"ping")
        assert _read_exact(client, 4) == b"ping"

        upstream.__exit__()  # drop the upstream under an established tunnel

        client.settimeout(5.0)
        trailing = b""
        try:
            while True:
                chunk = client.recv(65536)
                if not chunk:
                    break
                trailing += chunk
        except (socket.timeout, OSError):
            pass

        assert REPLY_FAILURE not in trailing
        assert trailing == b"", f"unexpected trailing bytes: {trailing!r}"
    finally:
        client.close()


def test_config_is_read_from_stdin_and_never_written_to_disk(tmp_path, monkeypatch):
    """Credentials arrive over the pipe; only the secret-free ready file lands."""
    with FakeUpstream() as upstream:
        ready_file = tmp_path / "bridge.ready.json"
        payload = json.dumps(
            {
                "bridgeVersion": SOCKS5_BRIDGE_VERSION,
                "upstream": {"host": upstream.host, "port": upstream.port},
                "credentials": {"username": UPSTREAM_USERNAME, "password": UPSTREAM_PASSWORD},
                "readyFile": str(ready_file),
            }
        )

        started = threading.Event()
        real_serve = Socks5BridgeServer.serve_forever

        def serve_once(self) -> None:
            started.set()

        monkeypatch.setattr(Socks5BridgeServer, "serve_forever", serve_once)
        assert run_bridge_from_stdin(io.StringIO(payload + "\n")) == 0
        assert started.is_set()
        assert real_serve is not None

        assert ready_file.exists()
        written = [path for path in tmp_path.rglob("*") if path.is_file()]
        assert written == [ready_file]

        for path in written:
            contents = path.read_text(encoding="utf-8")
            assert UPSTREAM_USERNAME not in contents
            assert UPSTREAM_PASSWORD not in contents


@pytest.mark.parametrize(
    "payload",
    [
        "",
        "   ",
        "not json",
        json.dumps({"bridgeVersion": 999}),
        json.dumps({"bridgeVersion": SOCKS5_BRIDGE_VERSION, "upstream": {"host": "h", "port": 0}}),
        json.dumps(
            {
                "bridgeVersion": SOCKS5_BRIDGE_VERSION,
                "upstream": {"host": "h", "port": 1080},
                "credentials": {"username": "", "password": "p"},
                "readyFile": "/tmp/x",
            }
        ),
    ],
)
def test_malformed_config_exits_nonzero_without_output(payload, capsys):
    assert run_bridge_from_stdin(io.StringIO(payload)) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""
