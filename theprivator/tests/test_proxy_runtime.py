"""Tests for sidecar-owned proxy runtime launch planning."""

import json

import pytest

from theprivator_sidecar.protocol import (
    PROXY_INVALID,
    PROXY_LAUNCH_ARG_UNSAFE,
    PROXY_SOCKS_AUTH_UNSUPPORTED,
    PROXY_UNSUPPORTED_MODE,
    SidecarError,
)
from theprivator_sidecar.proxy import (
    DIRECT_PROXY_MODE,
    FIXED_SERVER_PROXY_MODE,
    PROXY_VERSION,
    SUPPORTED_PROXY_PROTOCOLS,
)
from theprivator_sidecar.proxy_runtime import (
    PROXY_SERVER_ARG_PREFIX,
    build_proxy_runtime_plan,
    is_rejected_launch_switch,
    validate_proxy_server_launch_arg,
)

SENTINEL_USERNAME = "proxy-user-sentinel-e2e33f73"
SENTINEL_PASSWORD = "proxy-password-sentinel-74d86415"
SENTINEL_VALUES = (SENTINEL_USERNAME, SENTINEL_PASSWORD)


def fixed_proxy(**overrides):
    proxy = {
        "proxyVersion": PROXY_VERSION,
        "mode": FIXED_SERVER_PROXY_MODE,
        "protocol": "http",
        "host": "proxy.example.invalid",
        "port": 8080,
    }
    proxy.update(overrides)
    return proxy


def assert_proxy_runtime_error(exc_info, code):
    error = exc_info.value
    assert isinstance(error, SidecarError)
    assert error.code == code
    assert error.recoverable is True
    assert error.detail_ref.startswith("sidecar-")
    encoded = json.dumps(error.to_dict(), ensure_ascii=False, sort_keys=True)
    assert "Traceback" not in encoded
    for sentinel in SENTINEL_VALUES:
        assert sentinel not in encoded
    return error


def assert_no_direct_fallback_or_credentials(plan):
    encoded = json.dumps(plan.to_dict(), ensure_ascii=False, sort_keys=True)
    for sentinel in SENTINEL_VALUES:
        assert sentinel not in encoded
    assert "direct://" not in encoded
    assert "bypass" not in encoded.casefold()
    assert "@" not in encoded
    assert "username" not in encoded
    assert "password" not in encoded


def test_direct_proxy_plan_emits_no_chromium_args():
    plan = build_proxy_runtime_plan({"proxyVersion": PROXY_VERSION, "mode": DIRECT_PROXY_MODE})

    assert plan.mode == DIRECT_PROXY_MODE
    assert plan.launch_args == []
    assert plan.requires_auth_helper is False
    assert plan.to_dict() == {
        "proxyVersion": PROXY_VERSION,
        "mode": DIRECT_PROXY_MODE,
        "requiresAuthHelper": False,
        "credentialState": "none",
        "launchArgCount": 0,
    }


@pytest.mark.parametrize("protocol", SUPPORTED_PROXY_PROTOCOLS)
def test_fixed_server_no_auth_protocols_emit_exactly_one_safe_proxy_arg(protocol):
    plan = build_proxy_runtime_plan(fixed_proxy(protocol=protocol, host="Proxy.Example.Invalid"))

    assert plan.mode == FIXED_SERVER_PROXY_MODE
    assert plan.protocol == protocol
    assert plan.host == "Proxy.Example.Invalid"
    assert plan.port == 8080
    assert plan.proxy_server == f"{protocol}://proxy.example.invalid:8080"
    assert plan.launch_args == [f"{PROXY_SERVER_ARG_PREFIX}{protocol}://proxy.example.invalid:8080"]
    assert plan.requires_auth_helper is False
    assert plan.credential_state == "none"
    assert_no_direct_fallback_or_credentials(plan)


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("::1", "socks5://[::1]:9050"),
        ("2001:db8::1", "socks5://[2001:db8::1]:9050"),
        ("2001:0DB8:0000:0000:0000:0000:0000:0001", "socks5://[2001:db8::1]:9050"),
    ],
)
def test_ipv6_proxy_hosts_are_bracketed_for_chromium(host, expected):
    plan = build_proxy_runtime_plan(fixed_proxy(protocol="socks5", host=host, port=9050))

    assert plan.proxy_server == expected
    assert plan.launch_args == [f"{PROXY_SERVER_ARG_PREFIX}{expected}"]
    assert_no_direct_fallback_or_credentials(plan)


@pytest.mark.parametrize("protocol", ["http", "https"])
def test_auth_helper_credentials_are_represented_without_argv_leak(protocol):
    plan = build_proxy_runtime_plan(
        fixed_proxy(
            protocol=protocol,
            credentials={"username": SENTINEL_USERNAME, "password": SENTINEL_PASSWORD},
        )
    )

    assert plan.launch_args == [f"{PROXY_SERVER_ARG_PREFIX}{protocol}://proxy.example.invalid:8080"]
    assert plan.requires_auth_helper is True
    assert plan.credential_state == "configured"
    assert_no_direct_fallback_or_credentials(plan)


def test_socks5_credentials_are_redacted_and_left_for_local_launch_bridge():
    plan = build_proxy_runtime_plan(
        fixed_proxy(
            protocol="socks5",
            credentials={"username": SENTINEL_USERNAME, "password": SENTINEL_PASSWORD},
        )
    )

    assert plan.launch_args == [f"{PROXY_SERVER_ARG_PREFIX}socks5://proxy.example.invalid:8080"]
    assert plan.requires_auth_helper is False
    assert plan.credential_state == "configured"
    assert_no_direct_fallback_or_credentials(plan)


def test_socks4_credentials_fail_before_any_launch_artifacts():
    with pytest.raises(SidecarError) as exc_info:
        build_proxy_runtime_plan(
            fixed_proxy(
                protocol="socks4",
                credentials={"username": SENTINEL_USERNAME, "password": SENTINEL_PASSWORD},
            )
        )

    assert_proxy_runtime_error(exc_info, PROXY_SOCKS_AUTH_UNSUPPORTED)


@pytest.mark.parametrize(
    ("proxy", "expected_code"),
    [
        (fixed_proxy(host="http://proxy.example.invalid"), PROXY_INVALID),
        (fixed_proxy(host="user:pass@proxy.example.invalid"), PROXY_INVALID),
        (fixed_proxy(host="proxy.example.invalid:8080"), PROXY_INVALID),
        (fixed_proxy(host="[::1]"), PROXY_INVALID),
        ({"proxyVersion": PROXY_VERSION, "mode": FIXED_SERVER_PROXY_MODE, "protocol": "http", "port": 8080}, PROXY_INVALID),
        ({"proxyVersion": PROXY_VERSION, "mode": FIXED_SERVER_PROXY_MODE, "protocol": "http", "host": "proxy.example.invalid"}, PROXY_INVALID),
        (fixed_proxy(protocol="quic"), PROXY_UNSUPPORTED_MODE),
    ],
)
def test_malformed_fixed_server_inputs_fail_as_typed_proxy_errors(proxy, expected_code):
    with pytest.raises(SidecarError) as exc_info:
        build_proxy_runtime_plan(proxy)

    assert_proxy_runtime_error(exc_info, expected_code)


@pytest.mark.parametrize(
    "arg",
    [
        "--proxy-server=http://user:pass@proxy.example.invalid:8080",
        "--proxy-server=direct://",
        "--proxy-server=http://proxy.example.invalid:8080,direct://",
        "--proxy-server=http://proxy.example.invalid:8080;https=http://proxy.example.invalid:8081",
        "--proxy-server=http://[::1:8080",
        "--proxy-server=http://proxy.example.invalid",
        "--proxy-server=http://proxy.example.invalid:8080/path",
    ],
)
def test_proxy_launch_arg_validator_rejects_unsafe_proxy_server_values(arg):
    with pytest.raises(SidecarError) as exc_info:
        validate_proxy_server_launch_arg(arg)

    assert_proxy_runtime_error(exc_info, PROXY_LAUNCH_ARG_UNSAFE)


@pytest.mark.parametrize(
    "arg",
    [
        "--proxy-bypass-list=<-loopback>",
        "--proxy-pac-url=http://proxy.example.invalid/proxy.pac",
        "--proxy-auto-detect",
        "--no-proxy-server",
        "--remote-debugging-port=9222",
        "--user-data-dir=/tmp/profile",
        "--ignore-certificate-errors",
        "--ignore-certificate-errors-spki-list=proof-only-pin",
    ],
)
def test_reserved_proxy_debug_path_and_certificate_switches_are_classified_as_rejected(arg):
    assert is_rejected_launch_switch(arg) is True


def test_safe_generated_proxy_server_arg_round_trips_through_validator():
    arg = f"{PROXY_SERVER_ARG_PREFIX}http://proxy.example.invalid:8080"

    assert validate_proxy_server_launch_arg(arg) == arg
