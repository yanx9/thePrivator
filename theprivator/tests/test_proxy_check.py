"""Tests for the S04 profile-scoped proxy check contract."""

from __future__ import annotations

import copy
import json
from typing import Any, Mapping

import pytest

from theprivator_sidecar.identity import DEFAULT_REAL_IDENTITY, curated_preset
from theprivator_sidecar.profiles import ProfileStore
from theprivator_sidecar.protocol import (
    INVALID_REQUEST,
    PROFILE_NOT_FOUND,
    PROXY_CONNECTIVITY_FAILED,
    PROXY_INVALID,
    PROXY_SOCKS_AUTH_UNSUPPORTED,
    PROXY_PROOF_FAILED,
    SidecarError,
)
from theprivator_sidecar.proxy_check import (
    PROXY_CHECK_PUBLIC_CHECKER_STATUS,
    PROXY_CHECK_SCOPE_LOCAL_FIXTURE,
    PROXY_CHECK_VERSION,
    check_profile_proxy,
)

SENTINEL_USERNAME = "proxy-check-user-sentinel"
SENTINEL_PASSWORD = "proxy-check-password-sentinel"
SENTINEL_VALUES = (SENTINEL_USERNAME, SENTINEL_PASSWORD)
FORBIDDEN_PUBLIC_MARKERS = (
    *SENTINEL_VALUES,
    "Proxy-Authorization",
    "proxy-authorization",
    "--proxy-server",
    "--user-data-dir",
    "--remote-debugging-port",
    "--load-extension",
    "--disable-extensions-except",
    "proxy-auth-extensions",
    "DevToolsActivePort",
    "ws://",
    "wss://",
    "Traceback",
    "PRIVATE KEY",
    "proxy-key.pem",
    "proxy-cert.pem",
    "certificateTrust",
    "profile-store/",
    "raw checker content",
)
TOP_KEYS = {"proxyCheckVersion", "profileId", "proxy", "routeProof", "ipHiding", "webRtc", "publicCheckers"}
ROUTE_KEYS = {
    "status",
    "basis",
    "scope",
    "protocol",
    "credentialState",
    "durationMs",
    "fixture",
    "target",
    "directFallbackDetected",
    "observationCounts",
}
IP_HIDING_KEYS = {"status", "basis", "scope", "publicExitIpClaimed", "publicExitIp", "publicExitLocation", "localFixtureConclusion"}
WEBRTC_KEYS = {"status", "basis", "mode", "policy", "localIpExposure"}
PUBLIC_CHECKERS_KEYS = {"status", "basis", "networkDependency", "pages"}
PUBLIC_CHECKER_PAGE_KEYS = {"id", "label", "url", "surfaces", "advisory"}


def fixed_proxy(protocol: str = "http", *, credentials: bool = False, **overrides: Any) -> dict[str, Any]:
    proxy: dict[str, Any] = {
        "proxyVersion": 1,
        "mode": "fixedServer",
        "protocol": protocol,
        "host": "proxy.example.invalid",
        "port": 18080,
    }
    if credentials:
        proxy["credentials"] = {"username": SENTINEL_USERNAME, "password": SENTINEL_PASSWORD}
    proxy.update(overrides)
    return proxy


def create_profile(tmp_path, *, proxy: Mapping[str, Any] | None = None, identity: Mapping[str, Any] | None = None):
    store_root = tmp_path / "app-data-should-not-leak"
    store = ProfileStore(store_root)
    profile = store.create("Proxy Check")['profile']
    if proxy is not None:
        profile = store.update_proxy(profile["id"], proxy)["profile"]
    if identity is not None:
        profile = store.update_identity(profile["id"], identity)["profile"]
    return store_root, profile


def assert_public_shape(result: Mapping[str, Any]) -> None:
    assert set(result) == TOP_KEYS
    assert result["proxyCheckVersion"] == PROXY_CHECK_VERSION
    assert set(result["routeProof"]) == ROUTE_KEYS
    assert set(result["ipHiding"]) == IP_HIDING_KEYS
    assert set(result["webRtc"]) == WEBRTC_KEYS
    assert set(result["publicCheckers"]) == PUBLIC_CHECKERS_KEYS
    for page in result["publicCheckers"]["pages"]:
        assert set(page) == PUBLIC_CHECKER_PAGE_KEYS


def assert_public_payload_safe(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    for marker in FORBIDDEN_PUBLIC_MARKERS:
        assert marker not in encoded
    assert '"credentials"' not in encoded
    assert '"username"' not in encoded
    assert '"password"' not in encoded
    return encoded


def assert_sidecar_error(exc_info: pytest.ExceptionInfo[SidecarError], code: str) -> SidecarError:
    error = exc_info.value
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    assert error.message
    assert_public_payload_safe(error.to_dict())
    return error


def minimal_proof(protocol: str = "http", **overrides: Any) -> dict[str, Any]:
    proof: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "ok",
        "caseLabel": "profiles.proxy.check",
        "fixtureKind": protocol,
        "durationMs": 1.25,
        "directFallbackDetected": False,
        "target": {"host": "theprivator-proxy-proof.invalid", "port": 80},
        "navigation": {"status": "navigated", "httpStatus": 200},
        "observations": {"proxyCount": 1, "targetCount": 1, "proxy": [], "target": []},
    }
    proof.update(overrides)
    return proof


def test_direct_profile_returns_not_run_route_proof_and_not_proven_ip_hiding(tmp_path):
    store_root, profile = create_profile(tmp_path)

    result = check_profile_proxy(store_root, profile["id"])

    assert_public_shape(result)
    assert result["profileId"] == profile["id"]
    assert result["proxy"]["mode"] == "direct"
    assert result["routeProof"] == {
        "status": "not-run",
        "basis": "direct-profile",
        "scope": "not-applicable",
        "protocol": None,
        "credentialState": "none",
        "durationMs": 0,
        "fixture": None,
        "target": None,
        "directFallbackDetected": False,
        "observationCounts": {"proxy": 0, "target": 0},
    }
    assert result["ipHiding"] == {
        "status": "not-proven",
        "basis": "direct-profile",
        "scope": "not-applicable",
        "publicExitIpClaimed": False,
        "publicExitIp": None,
        "publicExitLocation": None,
        "localFixtureConclusion": "not-run",
    }
    assert result["webRtc"] == {
        "status": "baseline-real",
        "basis": "profile-identity-policy",
        "mode": "real",
        "policy": "real",
        "localIpExposure": "real-local-ip-baseline",
    }
    assert_public_payload_safe(result)


@pytest.mark.parametrize("protocol", ["http", "https", "socks4", "socks5"])
def test_fixed_server_protocols_return_local_fixture_route_and_ip_hiding_proof(tmp_path, protocol):
    store_root, profile = create_profile(tmp_path, proxy=fixed_proxy(protocol, credentials=protocol in {"http", "https"}))

    result = check_profile_proxy(store_root, profile["id"])

    assert_public_shape(result)
    route_proof = result["routeProof"]
    assert route_proof["status"] == "proved"
    assert route_proof["basis"] == PROXY_CHECK_SCOPE_LOCAL_FIXTURE
    assert route_proof["scope"] == "local-fixture"
    assert route_proof["protocol"] == protocol
    assert route_proof["fixture"] == {"kind": protocol, "managed": True}
    assert route_proof["target"] == {"host": "theprivator-proxy-proof.invalid", "port": 80}
    assert route_proof["directFallbackDetected"] is False
    assert route_proof["durationMs"] >= 0
    assert route_proof["observationCounts"]["proxy"] >= 1
    assert route_proof["observationCounts"]["target"] >= 1
    assert result["ipHiding"] == {
        "status": "proved",
        "basis": "route-proof-succeeded",
        "scope": "local-fixture",
        "publicExitIpClaimed": False,
        "publicExitIp": None,
        "publicExitLocation": None,
        "localFixtureConclusion": "direct target IP hidden from the proof target by the managed fixture",
    }
    assert result["proxy"]["credentialState"] == ("configured" if protocol in {"http", "https"} else "none")
    assert_public_payload_safe(result)


def test_curated_identity_fixed_server_proxy_reports_combined_s04_vocabulary(tmp_path, monkeypatch):
    store_root, profile = create_profile(
        tmp_path,
        proxy=fixed_proxy("https", credentials=True, port=18443),
        identity=curated_preset("windows-10-chrome-120"),
    )

    def collect_safe_minimal_proof(received_store_root, case, *, timeout_seconds):
        assert received_store_root == store_root
        assert timeout_seconds > 0
        assert case["label"] == "profiles.proxy.check"
        assert case["managedFixture"] is True
        assert case["proxy"]["mode"] == "fixedServer"
        assert case["proxy"]["protocol"] == "https"
        assert case["proxy"]["credentials"] == {
            "username": SENTINEL_USERNAME,
            "password": SENTINEL_PASSWORD,
        }
        return minimal_proof("https")

    monkeypatch.setattr("theprivator_sidecar.proxy_check.collect_proxy_proof", collect_safe_minimal_proof)

    result = check_profile_proxy(store_root, profile["id"])

    assert_public_shape(result)
    assert result["profileId"] == profile["id"]
    assert result["proxy"] == {
        "proxyVersion": 1,
        "mode": "fixedServer",
        "protocol": "https",
        "host": "proxy.example.invalid",
        "port": 18443,
        "credentialState": "configured",
        "summary": "https://proxy.example.invalid:18443",
    }
    assert result["routeProof"] == {
        "status": "proved",
        "basis": PROXY_CHECK_SCOPE_LOCAL_FIXTURE,
        "scope": "local-fixture",
        "protocol": "https",
        "credentialState": "configured",
        "durationMs": 1.25,
        "fixture": {"kind": "https", "managed": True},
        "target": {"host": "theprivator-proxy-proof.invalid", "port": 80},
        "directFallbackDetected": False,
        "observationCounts": {"proxy": 1, "target": 1},
    }
    assert result["ipHiding"] == {
        "status": "proved",
        "basis": "route-proof-succeeded",
        "scope": "local-fixture",
        "publicExitIpClaimed": False,
        "publicExitIp": None,
        "publicExitLocation": None,
        "localFixtureConclusion": "direct target IP hidden from the proof target by the managed fixture",
    }
    assert result["webRtc"] == {
        "status": "restricted",
        "basis": "profile-identity-policy",
        "mode": "masked",
        "policy": "disableNonProxiedUdp",
        "localIpExposure": "non-proxied-udp-disabled",
    }
    assert result["publicCheckers"]["status"] == PROXY_CHECK_PUBLIC_CHECKER_STATUS
    assert result["publicCheckers"]["networkDependency"] == "user-driven-external-pages"
    assert all("content" not in page for page in result["publicCheckers"]["pages"])
    assert_public_payload_safe(result)


def test_webrtc_policy_classification_reports_real_baseline_and_restricted_modes(tmp_path):
    real_store_root, real_profile = create_profile(tmp_path / "real", identity=DEFAULT_REAL_IDENTITY)
    restricted_store_root, restricted_profile = create_profile(
        tmp_path / "restricted",
        identity=curated_preset("ubuntu-linux-chrome-120"),
    )

    real = check_profile_proxy(real_store_root, real_profile["id"])["webRtc"]
    restricted = check_profile_proxy(restricted_store_root, restricted_profile["id"])["webRtc"]

    assert real == {
        "status": "baseline-real",
        "basis": "profile-identity-policy",
        "mode": "real",
        "policy": "real",
        "localIpExposure": "real-local-ip-baseline",
    }
    assert restricted == {
        "status": "restricted",
        "basis": "profile-identity-policy",
        "mode": "masked",
        "policy": "disableNonProxiedUdp",
        "localIpExposure": "non-proxied-udp-disabled",
    }


def test_public_checker_catalog_is_fixed_https_advisory_guidance(tmp_path):
    store_root, profile = create_profile(tmp_path)

    public_checkers = check_profile_proxy(store_root, profile["id"])["publicCheckers"]

    assert public_checkers["status"] == PROXY_CHECK_PUBLIC_CHECKER_STATUS
    assert public_checkers["basis"] == "fixed-https-allowlist"
    assert public_checkers["networkDependency"] == "user-driven-external-pages"
    pages = public_checkers["pages"]
    assert [page["id"] for page in pages] == ["cloudflare-trace", "aws-checkip", "webbrowsertools-webrtc"]
    assert all(page["url"].startswith("https://") for page in pages)
    assert all("content" not in page for page in pages)
    assert any(page["surfaces"] == ["webrtc"] for page in pages)
    assert_public_payload_safe(public_checkers)


def test_missing_unknown_and_malformed_profile_inputs_fail_typed(tmp_path):
    store_root, profile = create_profile(tmp_path)

    with pytest.raises(SidecarError) as blank_exc:
        check_profile_proxy(store_root, "   ")
    assert_sidecar_error(blank_exc, INVALID_REQUEST)

    with pytest.raises(SidecarError) as missing_exc:
        check_profile_proxy(store_root, "00000000-0000-0000-0000-000000000000")
    assert_sidecar_error(missing_exc, PROFILE_NOT_FOUND)

    payload_path = store_root / "profile-store" / "profiles.json"
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    payload["profiles"][0]["proxy"] = {"proxyVersion": 1, "mode": "system"}
    payload_path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(SidecarError) as malformed_exc:
        check_profile_proxy(store_root, profile["id"])
    assert malformed_exc.value.code.startswith("PROXY_")
    assert_public_payload_safe(malformed_exc.value.to_dict())


def test_socks4_credentials_fail_before_public_payload_without_secret_leak(tmp_path, monkeypatch):
    store_root, profile = create_profile(tmp_path, proxy=fixed_proxy("socks4", credentials=True))

    def fail_if_called(*_args: Any, **_kwargs: Any) -> Mapping[str, Any]:
        raise AssertionError("public payload should not be produced for credentialed SOCKS4")

    monkeypatch.setattr("theprivator_sidecar.proxy_check._collect_public_exit_observation", fail_if_called)

    with pytest.raises(SidecarError) as exc_info:
        check_profile_proxy(store_root, profile["id"])

    # The launch-time verdict, not the generic "invalid proof case" the proof
    # collector used to raise: SOCKS4 has no credential mechanism at all, and the
    # message should say that rather than blaming the fixture.
    assert_sidecar_error(exc_info, PROXY_SOCKS_AUTH_UNSUPPORTED)


def test_socks5_credentials_return_local_proof_without_leaking_secret_values(tmp_path):
    store_root, profile = create_profile(tmp_path, proxy=fixed_proxy("socks5", credentials=True))

    result = check_profile_proxy(store_root, profile["id"])

    assert_public_shape(result)
    assert result["routeProof"]["status"] == "proved"
    assert result["routeProof"]["protocol"] == "socks5"
    assert result["routeProof"]["credentialState"] == "configured"
    assert result["proxy"]["credentialState"] == "configured"
    assert result["ipHiding"]["status"] == "proved"
    assert_public_payload_safe(result)


@pytest.mark.parametrize("code", [PROXY_CONNECTIVITY_FAILED, PROXY_PROOF_FAILED])
def test_proxy_proof_failures_propagate_typed_safe_errors(tmp_path, monkeypatch, code):
    store_root, profile = create_profile(tmp_path, proxy=fixed_proxy("http"))

    def failing_collector(*_args: Any, **_kwargs: Any) -> Mapping[str, Any]:
        raise SidecarError(code=code, message="Safe proxy failure")

    monkeypatch.setattr("theprivator_sidecar.proxy_check.collect_proxy_proof", failing_collector)

    with pytest.raises(SidecarError) as exc_info:
        check_profile_proxy(store_root, profile["id"])

    assert_sidecar_error(exc_info, code)


@pytest.mark.parametrize(
    "proof",
    [
        minimal_proof(raw="unexpected"),
        minimal_proof(directFallbackDetected=True),
        minimal_proof(observations={"proxyCount": 0, "targetCount": 1}),
        minimal_proof(target={"host": "theprivator-proxy-proof.invalid", "port": 80, "path": "/raw"}),
        minimal_proof(observations={"proxyCount": 1, "targetCount": 1, "proxy": [{"username": SENTINEL_USERNAME}], "target": []}),
    ],
)
def test_unexpected_or_unsafe_proof_summaries_fail_closed_without_public_leak(tmp_path, monkeypatch, proof):
    store_root, profile = create_profile(tmp_path, proxy=fixed_proxy("http"))

    monkeypatch.setattr("theprivator_sidecar.proxy_check.collect_proxy_proof", lambda *_args, **_kwargs: copy.deepcopy(proof))

    with pytest.raises(SidecarError) as exc_info:
        check_profile_proxy(store_root, profile["id"])

    assert_sidecar_error(exc_info, PROXY_PROOF_FAILED)
