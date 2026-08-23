"""Tests for the sidecar-owned proxy v1 contract."""

import copy
import hmac
import json

import pytest

from theprivator_sidecar.protocol import (
    PROXY_INVALID,
    PROXY_PAC_UNSUPPORTED,
    PROXY_UNSUPPORTED_MODE,
    SidecarError,
)
from theprivator_sidecar.proxy import (
    CREDENTIAL_STATE_CONFIGURED,
    CREDENTIAL_STATE_NONE,
    DIRECT_PROXY_MODE,
    FIXED_SERVER_PROXY_MODE,
    PROXY_VERSION,
    SUPPORTED_PROXY_PROTOCOLS,
    default_proxy_config,
    is_proxy_secret_key,
    normalize_proxy_config,
    public_proxy_summary,
    redact_proxy_secrets,
)

SENTINEL_USERNAME = "proxy-user-sentinel-e2e33f73"
SENTINEL_PASSWORD = "proxy-password-sentinel-74d86415"
SENTINEL_VALUES = (SENTINEL_USERNAME, SENTINEL_PASSWORD)
FORBIDDEN_PUBLIC_KEYS = {"credentials", "username", "password"}


def fixed_proxy(**overrides):
    proxy = {
        "proxyVersion": PROXY_VERSION,
        "mode": FIXED_SERVER_PROXY_MODE,
        "protocol": "http",
        "host": "proxy.example",
        "port": 8080,
    }
    proxy.update(overrides)
    return proxy


def assert_proxy_error(draft, code):
    with pytest.raises(SidecarError) as exc_info:
        normalize_proxy_config(draft)

    error = exc_info.value
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    assert error.message
    assert not _contains_secret_value(error.message)
    return error


def assert_public_payload_safe(payload):
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    assert not _contains_secret_value(encoded)
    assert not _contains_forbidden_public_key(payload)
    assert "Traceback" not in encoded
    return encoded


def _contains_secret_value(text):
    return any(secret in text for secret in SENTINEL_VALUES)


def _contains_forbidden_public_key(value):
    if isinstance(value, dict):
        return any(key in FORBIDDEN_PUBLIC_KEYS for key in value) or any(
            _contains_forbidden_public_key(item) for item in value.values()
        )
    if isinstance(value, list):
        return any(_contains_forbidden_public_key(item) for item in value)
    return False


def test_direct_proxy_normalizes_to_private_shape_and_safe_public_summary():
    normalized = normalize_proxy_config({"proxyVersion": PROXY_VERSION, "mode": DIRECT_PROXY_MODE})

    assert normalized == default_proxy_config()
    assert normalized == {"proxyVersion": 1, "mode": "direct"}

    summary = public_proxy_summary(normalized)
    assert summary == {
        "proxyVersion": 1,
        "mode": "direct",
        "credentialState": CREDENTIAL_STATE_NONE,
        "summary": "Direct connection",
    }
    assert_public_payload_safe(summary)


@pytest.mark.parametrize("protocol", SUPPORTED_PROXY_PROTOCOLS)
def test_fixed_server_protocols_are_accepted_exactly_when_lowercase(protocol):
    normalized = normalize_proxy_config(fixed_proxy(protocol=protocol, host=" proxy.example "))

    assert normalized["proxyVersion"] == PROXY_VERSION
    assert normalized["mode"] == FIXED_SERVER_PROXY_MODE
    assert normalized["protocol"] == protocol
    assert normalized["host"] == "proxy.example"
    assert normalized["port"] == 8080
    assert "credentials" not in normalized

    summary = public_proxy_summary(normalized)
    assert summary["protocol"] == protocol
    assert summary["host"] == "proxy.example"
    assert summary["port"] == 8080
    assert summary["credentialState"] == CREDENTIAL_STATE_NONE
    assert summary["summary"] == f"{protocol}://proxy.example:8080"
    assert_public_payload_safe(summary)


@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",
        "::1",
        "2001:db8::1",
        "localhost",
        "proxy.example",
        "xn--bcher-kva.example",
    ],
)
def test_fixed_server_accepts_ip_localhost_and_punycode_hosts(host):
    normalized = normalize_proxy_config(fixed_proxy(protocol="socks5", host=host, port=1))

    assert normalized["host"] == host
    assert normalized["port"] == 1
    summary = public_proxy_summary(normalized)
    assert summary["credentialState"] == CREDENTIAL_STATE_NONE
    assert_public_payload_safe(summary)


@pytest.mark.parametrize("port", [1, 65535])
def test_fixed_server_accepts_valid_port_boundaries(port):
    normalized = normalize_proxy_config(fixed_proxy(port=port))

    assert normalized["port"] == port
    assert public_proxy_summary(normalized)["port"] == port


def test_credentials_are_preserved_privately_but_redacted_publicly():
    normalized = normalize_proxy_config(
        fixed_proxy(
            protocol="https",
            port=443,
            credentials={"username": SENTINEL_USERNAME, "password": SENTINEL_PASSWORD},
        )
    )

    assert "credentials" in normalized
    assert hmac.compare_digest(normalized["credentials"]["username"], SENTINEL_USERNAME)
    assert hmac.compare_digest(normalized["credentials"]["password"], SENTINEL_PASSWORD)

    summary = public_proxy_summary(normalized)
    assert summary == {
        "proxyVersion": PROXY_VERSION,
        "mode": FIXED_SERVER_PROXY_MODE,
        "protocol": "https",
        "host": "proxy.example",
        "port": 443,
        "credentialState": CREDENTIAL_STATE_CONFIGURED,
        "summary": "https://proxy.example:443",
    }
    assert_public_payload_safe(summary)

    redacted = redact_proxy_secrets(normalized)
    assert not _contains_secret_value(json.dumps(redacted, ensure_ascii=False, sort_keys=True))
    assert redacted["credentials"] == "<redacted>"


@pytest.mark.parametrize(
    "credentials",
    [None, {"username": SENTINEL_USERNAME, "password": SENTINEL_PASSWORD}],
)
def test_fixed_server_credentials_may_be_absent_null_or_configured(credentials):
    proxy = fixed_proxy()
    if credentials is not None:
        proxy["credentials"] = copy.deepcopy(credentials)
    elif credentials is None:
        proxy["credentials"] = None

    normalized = normalize_proxy_config(proxy)
    summary = public_proxy_summary(normalized)

    if credentials is None:
        assert "credentials" not in normalized
        assert summary["credentialState"] == CREDENTIAL_STATE_NONE
    else:
        assert hmac.compare_digest(normalized["credentials"]["username"], SENTINEL_USERNAME)
        assert hmac.compare_digest(normalized["credentials"]["password"], SENTINEL_PASSWORD)
        assert summary["credentialState"] == CREDENTIAL_STATE_CONFIGURED
    assert_public_payload_safe(summary)


@pytest.mark.parametrize(
    "draft",
    [
        "not-an-object",
        None,
        {"proxyVersion": 2, "mode": DIRECT_PROXY_MODE},
        {"proxyVersion": True, "mode": DIRECT_PROXY_MODE},
        {"proxyVersion": PROXY_VERSION, "mode": DIRECT_PROXY_MODE, "unknown": True},
        fixed_proxy(proxyVersion="1"),
        fixed_proxy(protocol="HTTP"),
        fixed_proxy(port="8080"),
        fixed_proxy(port=True),
        fixed_proxy(port=0),
        fixed_proxy(port=65536),
        fixed_proxy(host=""),
        fixed_proxy(host="\nproxy.example"),
        fixed_proxy(host="http://proxy.example"),
        fixed_proxy(host="proxy.example/path"),
        fixed_proxy(host="user:pass@proxy.example"),
        fixed_proxy(host="proxy.example:8080"),
        fixed_proxy(credentials={"username": "", "password": "secret"}),
        fixed_proxy(credentials={"username": "secret", "password": ""}),
        fixed_proxy(credentials={"username": "secret"}),
        fixed_proxy(credentials={"username": "secret", "password": "secret", "token": "secret"}),
        fixed_proxy(credentials={"username": "secret", "password": "bad\nsecret"}),
    ],
)
def test_malformed_proxy_inputs_raise_invalid_without_echoing_values(draft):
    assert_proxy_error(draft, PROXY_INVALID)


@pytest.mark.parametrize("field", ["pacScript", "pac_script", "pacUrl", "autoDetect", "system"])
def test_pac_system_and_autodetect_fields_raise_typed_pac_error(field):
    draft = {"proxyVersion": PROXY_VERSION, "mode": DIRECT_PROXY_MODE, field: "ignored"}

    assert_proxy_error(draft, PROXY_PAC_UNSUPPORTED)


@pytest.mark.parametrize("mode", ["pac", "system", "autoDetect"])
def test_pac_system_and_autodetect_modes_raise_typed_pac_error(mode):
    assert_proxy_error({"proxyVersion": PROXY_VERSION, "mode": mode}, PROXY_PAC_UNSUPPORTED)


@pytest.mark.parametrize("field", ["bypassList", "noProxy", "proxyBypassRules", "directFallback"])
def test_bypass_and_direct_fallback_fields_raise_typed_proxy_error(field):
    draft = fixed_proxy(**{field: ["localhost"]})

    assert_proxy_error(draft, PROXY_UNSUPPORTED_MODE)


@pytest.mark.parametrize(
    "draft",
    [
        fixed_proxy(protocol="quic"),
        {"proxyVersion": PROXY_VERSION, "mode": "quic"},
        {"proxyVersion": PROXY_VERSION, "mode": FIXED_SERVER_PROXY_MODE, "proxyUrl": "http://host.invalid:8080"},
        {"proxyVersion": PROXY_VERSION, "mode": FIXED_SERVER_PROXY_MODE, "server": "http://host.invalid:8080"},
    ],
)
def test_unsupported_protocol_modes_and_legacy_url_style_configs_raise_typed_errors(draft):
    assert_proxy_error(draft, PROXY_UNSUPPORTED_MODE)


def test_proxy_secret_key_helper_matches_public_redaction_markers():
    for key in ["credentials", "username", "password", "proxy_user", "proxyPassword", "Proxy-Authorization"]:
        assert is_proxy_secret_key(key) is True
    for key in ["host", "port", "protocol", "summary", "credentialState"]:
        assert is_proxy_secret_key(key) is False
