"""Synthetic public exit metadata and fail-closed transport tests."""
import pytest

from theprivator_sidecar import proxy_check as check


@pytest.mark.parametrize("code, expected", [
    ("US", "US"), ("DE", "DE"), (None, None), ("", None),
    ("USA", None), ("us", None), (" US ", None), ("U1", None),
    ("ÜS", None), ("U\n", None), (42, None), (["US"], None),
])
def test_country_code_is_nullable_uppercase_alpha2(code, expected):
    observation = check._public_exit_from_payload({
        "status": "success", "query": "203.0.113.1", "country": "United States",
        "countryCode": code,
    })
    result = check._proved_ip_hiding(observation)
    assert result["publicExitLocation"] == {
        "country": "United States", "countryCode": expected, "region": None,
        "city": None, "timezone": None, "isp": None,
    }


def test_legacy_location_without_country_code_is_accepted():
    result = check._proved_ip_hiding({"ip": "203.0.113.1", "location": {"country": "Germany"}})
    assert result["publicExitLocation"]["countryCode"] is None


def test_lookup_requests_country_code():
    assert "countryCode" in check._PUBLIC_EXIT_LOOKUP_PATH.split("fields=", 1)[1].split(",")


@pytest.mark.parametrize("protocol", ["http", "https"])
def test_http_lookup_is_isolated_from_environment_and_redirects(monkeypatch, protocol):
    import requests

    monkeypatch.setenv("HTTPS_PROXY", "http://unrelated.invalid:9999")
    captured = {}

    def send(session, request, **kwargs):
        captured.update(kwargs, trust_env=session.trust_env, request=request)
        response = requests.Response()
        response.status_code = 200
        response._content = b'{"query":"203.0.113.1","countryCode":"DE"}'
        return response

    monkeypatch.setattr(requests.Session, "send", send)
    proxy = {"mode": "fixedServer", "protocol": protocol, "host": "127.0.0.1", "port": 12345}
    assert check._collect_public_exit_observation(proxy)["location"]["countryCode"] == "DE"
    expected = f"{protocol}://127.0.0.1:12345"
    assert captured["proxies"] == {"http": expected, "https": expected}
    assert captured["trust_env"] is False
    assert captured["allow_redirects"] is False


@pytest.mark.parametrize("chunked", [False, True])
@pytest.mark.parametrize("authenticated", [False, True])
def test_socks5_lookup_uses_proxy_remote_dns_and_http_framing(monkeypatch, chunked, authenticated):
    import json
    import socket
    import threading

    client, server = socket.socketpair()
    server.settimeout(2)
    connections = []
    errors = []

    def connect(address, *, timeout):
        connections.append(address)
        return client

    def serve():
        try:
            with server:
                greeting = check._read_exact(server, 2)
                methods = check._read_exact(server, greeting[1])
                assert greeting[0] == 5
                assert (2 in methods) == authenticated
                server.sendall(b"\x05\x02" if authenticated else b"\x05\x00")
                if authenticated:
                    assert check._read_exact(server, 1) == b"\x01"
                    username = check._read_exact(server, check._read_exact(server, 1)[0])
                    password = check._read_exact(server, check._read_exact(server, 1)[0])
                    assert (username, password) == (b"synthetic-user", b"synthetic-password")
                    server.sendall(b"\x01\x00")
                assert check._read_exact(server, 4) == b"\x05\x01\x00\x03"
                assert check._read_exact(server, check._read_exact(server, 1)[0]) == b"ip-api.com"
                assert check._read_exact(server, 2) == b"\x00\x50"
                server.sendall(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x50")
                request = b""
                while not request.endswith(b"\r\n\r\n"):
                    request += check._read_exact(server, 1)
                assert request.startswith(b"GET /json/?fields=")
                assert b"countryCode" in request
                body = json.dumps({"status": "success", "query": "203.0.113.1", "countryCode": "DE"}).encode()
                if chunked:
                    response = b"Transfer-Encoding: chunked\r\n\r\n" + f"{len(body):x}\r\n".encode() + body + b"\r\n0\r\n\r\n"
                else:
                    response = f"Content-Length: {len(body)}\r\n\r\n".encode() + body
                server.sendall(b"HTTP/1.1 200 OK\r\n" + response)
        except BaseException as error:
            errors.append(error)

    monkeypatch.setattr(check.socket, "create_connection", connect)
    worker = threading.Thread(target=serve, daemon=True)
    worker.start()
    proxy = {"mode": "fixedServer", "protocol": "socks5", "host": "synthetic-proxy.test", "port": 12345}
    if authenticated:
        proxy["credentials"] = {"username": "synthetic-user", "password": "synthetic-password"}
    observation = check._collect_public_exit_observation(proxy)
    worker.join(3)
    assert not worker.is_alive()
    assert errors == []
    assert connections == [("synthetic-proxy.test", 12345)]
    assert observation is not None
    assert observation["location"]["countryCode"] == "DE"


@pytest.mark.parametrize("protocol", ["http", "https", "socks4", "socks5"])
def test_failed_proxy_never_retries_direct(monkeypatch, protocol):
    import requests

    attempts = []

    def fail_socket(address, **kwargs):
        attempts.append(address)
        raise OSError("synthetic proxy unavailable")

    def fail_http(session, request, **kwargs):
        attempts.append(kwargs["proxies"])
        raise requests.exceptions.ProxyError("synthetic proxy unavailable")

    monkeypatch.setattr(check.socket, "create_connection", fail_socket)
    monkeypatch.setattr(requests.Session, "send", fail_http)
    proxy = {"mode": "fixedServer", "protocol": protocol, "host": "synthetic-proxy.test", "port": 12345}
    assert check._collect_public_exit_observation(proxy) is None
    if protocol in {"http", "https"}:
        url = f"{protocol}://synthetic-proxy.test:12345"
        assert attempts == [{"http": url, "https": url}]
    elif protocol == "socks5":
        assert attempts == [("synthetic-proxy.test", 12345)]
    else:
        assert attempts == []  # Unsupported SOCKS4 lookup fails closed.
