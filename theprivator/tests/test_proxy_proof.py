"""Red tests for real proxy connectivity/proof tracing (future S02 task)."""

import json

import pytest

from theprivator_sidecar.protocol import SidecarError


def proxy_case(label="http-auth"):
    return {
        "label": label,
        "proxy": {
            "proxyVersion": 1,
            "mode": "fixedServer",
            "protocol": "http",
            "host": "127.0.0.1",
            "port": 18080,
            "credentials": {
                "username": "proxy-proof-user-sentinel",
                "password": "proxy-proof-password-sentinel",
            },
        },
        "expectedUrl": "https://example.test/through-proxy",
    }


def assert_no_proxy_secret_leak(payload):
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    assert "proxy-proof-user-sentinel" not in encoded
    assert "proxy-proof-password-sentinel" not in encoded
    assert "Proxy-Authorization" not in encoded
    assert "--proxy-server" not in encoded
    assert "ws://" not in encoded


def test_proxy_proof_collector_reports_redacted_success_summary(tmp_path):
    try:
        from theprivator_sidecar.proxy_proof import collect_proxy_proof
    except ImportError:
        pytest.fail("A future S02 task must implement deterministic proxy proof collection.")

    proof = collect_proxy_proof(tmp_path, proxy_case())
    assert proof["status"] == "ok"
    assert proof["caseLabel"] == "http-auth"
    assert proof["durationMs"] >= 0
    assert proof["directFallbackDetected"] is False
    assert_no_proxy_secret_leak(proof)


def test_proxy_proof_collector_surfaces_typed_connectivity_failures(tmp_path):
    try:
        from theprivator_sidecar.proxy_proof import collect_proxy_proof
    except ImportError:
        pytest.fail("A future S02 task must implement typed proxy connectivity/proof failures.")

    broken_case = proxy_case("broken-connectivity")
    broken_case["proxy"] = {**broken_case["proxy"], "port": 9}
    with pytest.raises(SidecarError) as exc_info:
        collect_proxy_proof(tmp_path, broken_case)

    assert exc_info.value.code.startswith("PROXY_")
    assert exc_info.value.recoverable is True
    assert exc_info.value.detail_ref.startswith("sidecar-")
    assert_no_proxy_secret_leak(exc_info.value.to_dict())
