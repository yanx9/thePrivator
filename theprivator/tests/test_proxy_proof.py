"""Tests for deterministic local proxy connectivity/proof tracing."""

import json
import socket
import time
from http import HTTPStatus
from typing import Any, Mapping

import pytest

from theprivator_sidecar.protocol import PROXY_CONNECTIVITY_FAILED, PROXY_INVALID, PROXY_PROOF_FAILED, SidecarError
from theprivator_sidecar.proxy_proof import (
    DEFAULT_PROOF_TARGET_HOST,
    DEFAULT_PROOF_TARGET_PORT,
    PROXY_PROOF_PATH,
    HttpProxyFixture,
    HttpsProxyCertificateStrategy,
    HttpsProxyFixture,
    ProxyProofCase,
    ProxyProofTargetServer,
    Socks5ProxyFixture,
    classify_proxy_proof,
    collect_proxy_proof,
    create_proxy_fixture,
)

SENTINEL_USERNAME = "proxy-proof-user-sentinel"
SENTINEL_PASSWORD = "proxy-proof-password-sentinel"
SENTINEL_VALUES = (SENTINEL_USERNAME, SENTINEL_PASSWORD)
FORBIDDEN_MARKERS = (
    *SENTINEL_VALUES,
    "Proxy-Authorization",
    "--proxy-server",
    "ws://",
    "wss://",
    "DevToolsActivePort",
    "Traceback",
    "PRIVATE KEY",
    "proxy-key.pem",
    "proxy-cert.pem",
    ".gsd",
)


def proxy_case(label: str = "http-auth", protocol: str = "http", **overrides: Any) -> dict[str, Any]:
    proxy: dict[str, Any] = {
        "proxyVersion": 1,
        "mode": "fixedServer",
        "protocol": protocol,
        "host": "127.0.0.1",
        "port": 18080,
    }
    if protocol in {"http", "https"}:
        proxy["credentials"] = {
            "username": SENTINEL_USERNAME,
            "password": SENTINEL_PASSWORD,
        }
    proxy.update(overrides.pop("proxy_overrides", {}))
    case = {
        "label": label,
        "proxy": proxy,
        "targetUrl": f"http://{DEFAULT_PROOF_TARGET_HOST}{PROXY_PROOF_PATH}",
    }
    case.update(overrides)
    return case


def assert_no_proxy_secret_leak(payload: Any) -> None:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    for marker in FORBIDDEN_MARKERS:
        assert marker not in encoded


def assert_sidecar_error(exc_info: pytest.ExceptionInfo[SidecarError], code: str) -> SidecarError:
    error = exc_info.value
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    assert error.message
    assert_no_proxy_secret_leak(error.to_dict())
    return error


def http_proxy_request(
    address: tuple[str, int],
    absolute_url: str,
    *,
    proxy_authorization: str | None = None,
) -> bytes:
    with socket.create_connection(address, timeout=1) as sock:
        headers = [
            f"GET {absolute_url} HTTP/1.1",
            f"Host: {DEFAULT_PROOF_TARGET_HOST}",
            "Connection: close",
        ]
        if proxy_authorization is not None:
            headers.append(f"Proxy-Authorization: {proxy_authorization}")
        sock.sendall(("\r\n".join(headers) + "\r\n\r\n").encode("ascii"))
        return sock.recv(4096)


def wait_for_observation(supplier, predicate, *, timeout: float = 1.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        observations = supplier()
        if predicate(observations):
            return observations
        time.sleep(0.01)
    return supplier()


@pytest.mark.parametrize("protocol", ["http", "https", "socks4", "socks5"])
def test_collect_proxy_proof_reports_redacted_success_summary_for_all_fixture_kinds(tmp_path, protocol):
    proof = collect_proxy_proof(tmp_path, proxy_case(protocol=protocol, label=f"{protocol}-case"))

    assert proof["schemaVersion"] == 1
    assert proof["status"] == "ok"
    assert proof["caseLabel"] == f"{protocol}-case"
    assert proof["fixtureKind"] == protocol
    assert proof["durationMs"] >= 0
    assert proof["directFallbackDetected"] is False
    assert proof["target"] == {"host": DEFAULT_PROOF_TARGET_HOST, "port": DEFAULT_PROOF_TARGET_PORT}
    assert proof["observations"]["proxyCount"] >= 1
    assert proof["observations"]["targetCount"] >= 1
    assert proof["observations"]["proxy"][-1]["targetHost"] == DEFAULT_PROOF_TARGET_HOST
    assert proof["observations"]["target"][-1]["status"] == HTTPStatus.OK
    if protocol == "https":
        assert proof["certificateTrust"]["kind"] == "spki-pin"
    assert_no_proxy_secret_leak(proof)


def test_proxy_proof_collector_surfaces_typed_connectivity_failures(tmp_path):
    broken_case = proxy_case("broken-connectivity", proxy_overrides={"port": 9}, managedFixture=False)

    with pytest.raises(SidecarError) as exc_info:
        collect_proxy_proof(tmp_path, broken_case)

    assert_sidecar_error(exc_info, PROXY_CONNECTIVITY_FAILED)


def test_http_proxy_fixture_records_auth_failure_without_credentials():
    with ProxyProofTargetServer() as target:
        with HttpProxyFixture(
            target_host=DEFAULT_PROOF_TARGET_HOST,
            target_port=DEFAULT_PROOF_TARGET_PORT,
            target_address=target.local_address,
            credentials=(SENTINEL_USERNAME, SENTINEL_PASSWORD),
        ) as proxy:
            response = http_proxy_request(
                proxy.local_address,
                f"http://{DEFAULT_PROOF_TARGET_HOST}{PROXY_PROOF_PATH}",
                proxy_authorization="Basic definitely-wrong",
            )
            observations = wait_for_observation(
                proxy.observations,
                lambda items: any(item.get("status") == "auth-failed" for item in items),
            )

    assert response.startswith(b"HTTP/1.1 407")
    assert observations[-1]["status"] == "auth-failed"
    assert observations[-1]["auth"] == "rejected"
    assert target.observations() == []
    assert_no_proxy_secret_leak(observations)


def test_http_proxy_fixture_rejects_unmapped_target_host_as_failed_routing():
    with ProxyProofTargetServer() as target:
        with HttpProxyFixture(
            target_host=DEFAULT_PROOF_TARGET_HOST,
            target_port=DEFAULT_PROOF_TARGET_PORT,
            target_address=target.local_address,
        ) as proxy:
            response = http_proxy_request(proxy.local_address, "http://wrong.invalid/theprivator-proxy-proof")
            observations = wait_for_observation(
                proxy.observations,
                lambda items: any(item.get("status") == "target-unmapped" for item in items),
            )

    assert response.startswith(b"HTTP/1.1 502")
    assert any(item.get("status") == "target-unmapped" for item in observations)
    assert target.observations() == []
    assert_no_proxy_secret_leak(observations)


def test_socks5_fixture_records_malformed_handshake_without_leaking_payloads():
    with ProxyProofTargetServer() as target:
        with Socks5ProxyFixture(
            target_host=DEFAULT_PROOF_TARGET_HOST,
            target_port=DEFAULT_PROOF_TARGET_PORT,
            target_address=target.local_address,
        ) as proxy:
            with socket.create_connection(proxy.local_address, timeout=1) as sock:
                sock.sendall(b"\x04\x01not-socks5")
                response = sock.recv(16)
            observations = wait_for_observation(
                proxy.observations,
                lambda items: any(item.get("status") == "malformed-fixture-response" for item in items),
            )

    assert response.startswith(b"\x05\x01")
    assert observations[-1]["status"] == "malformed-fixture-response"
    assert target.observations() == []
    assert_no_proxy_secret_leak(observations)


def test_proxy_fixtures_close_ephemeral_ports_on_cleanup():
    with ProxyProofTargetServer() as target:
        with HttpProxyFixture(
            target_host=DEFAULT_PROOF_TARGET_HOST,
            target_port=DEFAULT_PROOF_TARGET_PORT,
            target_address=target.local_address,
        ) as proxy:
            address = proxy.local_address
            with socket.create_connection(address, timeout=1):
                pass

    with pytest.raises(OSError):
        socket.create_connection(address, timeout=0.1)


def test_https_proxy_certificate_strategy_is_scoped_and_not_a_public_summary_leak():
    strategy = HttpsProxyCertificateStrategy()

    assert strategy.to_public_dict() == {"kind": "spki-pin", "spkiSha256": strategy.spki_sha256}
    assert strategy.to_chromium_arg().startswith("--ignore-certificate-errors-spki-list=")
    assert "--ignore-certificate-errors" not in json.dumps(strategy.to_public_dict())
    assert_no_proxy_secret_leak(strategy.to_public_dict())


def test_classification_distinguishes_missing_proxy_observation_from_direct_fallback():
    proof_case = ProxyProofCase(
        label="classification",
        kind="http",
        proxy={"proxyVersion": 1, "mode": "fixedServer", "protocol": "http", "host": "127.0.0.1", "port": 18080},
    )

    with pytest.raises(SidecarError) as direct_exc:
        classify_proxy_proof(
            proof_case,
            proxy_observations=[],
            target_observations=[{"fixture": "target", "status": 200}],
            navigation={"status": "navigated"},
            duration_ms=1,
        )
    assert_sidecar_error(direct_exc, PROXY_PROOF_FAILED)

    with pytest.raises(SidecarError) as missing_exc:
        classify_proxy_proof(
            proof_case,
            proxy_observations=[],
            target_observations=[],
            navigation={"status": "navigated"},
            duration_ms=1,
        )
    assert_sidecar_error(missing_exc, PROXY_PROOF_FAILED)


def test_unsupported_proxy_fixture_kind_is_typed_and_redacted():
    with pytest.raises(SidecarError) as exc_info:
        create_proxy_fixture(
            "ftp",
            target_host=DEFAULT_PROOF_TARGET_HOST,
            target_port=DEFAULT_PROOF_TARGET_PORT,
            target_address=("127.0.0.1", 1),
        )

    assert_sidecar_error(exc_info, PROXY_INVALID)


def test_managed_fixture_tests_do_not_depend_on_ignored_or_public_resources(tmp_path):
    proof = collect_proxy_proof(tmp_path, proxy_case("local-only"))
    encoded = json.dumps(proof, ensure_ascii=False, sort_keys=True)

    assert "browserleaks" not in encoded.lower()
    assert "public checker" not in encoded.lower()
    assert ".gsd" not in encoded
    assert_no_proxy_secret_leak(proof)
