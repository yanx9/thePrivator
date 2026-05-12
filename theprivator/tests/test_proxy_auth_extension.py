"""Red tests for HTTP/HTTPS proxy-auth helper generation (future S02 task)."""

import json

import pytest

from theprivator_sidecar.proxy_runtime import build_proxy_runtime_plan

SENTINEL_USERNAME = "proxy-auth-user-sentinel"
SENTINEL_PASSWORD = "proxy-auth-password-sentinel"


def authenticated_http_proxy(protocol="http"):
    return {
        "proxyVersion": 1,
        "mode": "fixedServer",
        "protocol": protocol,
        "host": "proxy.example.invalid",
        "port": 18080,
        "credentials": {
            "username": SENTINEL_USERNAME,
            "password": SENTINEL_PASSWORD,
        },
    }


@pytest.mark.parametrize("protocol", ["http", "https"])
def test_authenticated_http_proxy_requires_redacted_auth_extension_artifact(tmp_path, protocol):
    plan = build_proxy_runtime_plan(authenticated_http_proxy(protocol))
    assert plan.requires_auth_helper is True
    assert plan.launch_args == [f"--proxy-server={protocol}://proxy.example.invalid:18080"]

    try:
        from theprivator_sidecar.proxy_auth_extension import generate_proxy_auth_extension
    except ImportError:
        pytest.fail("T02 must implement sidecar-owned proxy auth extension generation for HTTP/HTTPS credentials.")

    artifact = generate_proxy_auth_extension(tmp_path, "profile-id", authenticated_http_proxy(protocol), plan)
    encoded = json.dumps(artifact.to_public_dict(), sort_keys=True)
    assert SENTINEL_USERNAME not in encoded
    assert SENTINEL_PASSWORD not in encoded
    assert artifact.extension_dir.is_dir()
    assert (artifact.extension_dir / "manifest.json").is_file()


def test_proxy_auth_extension_rejects_mismatched_runtime_plan(tmp_path):
    plan = build_proxy_runtime_plan(authenticated_http_proxy("http"))
    mismatched_proxy = authenticated_http_proxy("https")

    try:
        from theprivator_sidecar.proxy_auth_extension import generate_proxy_auth_extension
    except ImportError:
        pytest.fail("T02 must reject proxy auth helper generation when the proxy plan and private config diverge.")

    with pytest.raises(Exception):
        generate_proxy_auth_extension(tmp_path, "profile-id", mismatched_proxy, plan)
