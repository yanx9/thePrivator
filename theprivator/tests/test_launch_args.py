"""Tests for the curated Chromium switch allow-list.

Every switch here reaches the browser's argv, so the interesting cases are the
rejections: a flag that gets through is a flag that can void the proxy layer or
the identity extension the rest of the sidecar exists to provide.
"""

import pytest

from theprivator_sidecar.launch_args import (
    MAX_USER_LAUNCH_ARGS,
    USER_ALLOWED_SWITCHES,
    validate_user_launch_args,
)
from theprivator_sidecar.protocol import LAUNCH_ARG_UNSUPPORTED, SidecarError


def assert_rejected(args):
    with pytest.raises(SidecarError) as exc_info:
        validate_user_launch_args(args)
    assert exc_info.value.code == LAUNCH_ARG_UNSUPPORTED
    return exc_info.value


@pytest.mark.parametrize(
    "args",
    [
        [],
        ["--mute-audio"],
        ["--start-maximized", "--hide-scrollbars"],
        ["--window-position=100,50"],
        ["--force-color-profile=srgb"],
        ["--renderer-process-limit=4"],
    ],
)
def test_curated_switches_pass(args):
    assert validate_user_launch_args(args) == args


@pytest.mark.parametrize(
    ("switch", "why"),
    [
        ("--host-resolver-rules=MAP*1.2.3.4", "redirects every request without naming a proxy"),
        ("--host-rules=MAP*1.2.3.4", "same, older spelling"),
        ("--dns-over-https-mode=secure", "moves name resolution off the proxy"),
        ("--proxy-server=http://evil.invalid", "the sidecar owns the proxy"),
        ("--proxy-bypass-list=*", "carves holes in the proxy"),
        ("--no-proxy-server", "turns the proxy off outright"),
        ("--user-data-dir=/tmp/elsewhere", "the sidecar owns the profile directory"),
        ("--load-extension=/tmp/x", "the sidecar owns the extension set"),
        ("--disable-extensions-except=/tmp/x", "would drop the identity extension"),
        ("--remote-debugging-port=9222", "the sidecar owns DevTools"),
        ("--user-agent=Spoofed", "the identity engine owns this"),
        ("--disable-web-security", "neuters the identity extension"),
        ("--no-sandbox", "removes the process sandbox"),
        ("--headless", "changes the browser's whole shape"),
        ("--js-flags=--expose-gc", "reaches into the JS engine"),
        ("--enable-logging", "writes diagnostics outside the redaction perimeter"),
    ],
)
def test_dangerous_switches_are_rejected(switch, why):
    error = assert_rejected([switch])

    assert switch.partition("=")[0] in error.message, why
    # The value may be anything the user typed; only the switch name is echoed.
    if "=" in switch:
        assert switch.partition("=")[2] not in error.message


def test_enable_features_is_rejected_rather_than_pattern_matched():
    """Its value is a comma-separated list, so a name-level allow could not
    catch "--enable-features=Foo,DnsOverHttps" and would only look like a guard."""
    assert_rejected(["--enable-features=Foo,DnsOverHttps"])
    assert_rejected(["--disable-features=IsolateOrigins"])


def test_whitespace_cannot_smuggle_a_second_switch():
    # Chromium splits argv itself, so one entry containing a space would carry a
    # switch past every per-entry check above.
    assert_rejected(["--mute-audio --no-sandbox"])


@pytest.mark.parametrize(
    "args",
    [
        ["--mute-audio=1"],
        ["--window-position"],
        ["--window-position=not-coordinates"],
        ["--force-color-profile=" + "x" * 100],
        ["--mute-audio", "--mute-audio"],
        ["--not-a-real-switch"],
        ["-single-dash"],
        ["--mute\x00-audio"],
        ["--" + "x" * 300],
        [42],
        "--mute-audio",
        [f"--{name}" for name in range(MAX_USER_LAUNCH_ARGS + 1)],
    ],
)
def test_malformed_input_is_rejected(args):
    assert_rejected(args)


def test_none_means_no_arguments():
    assert validate_user_launch_args(None) == []


def test_no_allowed_switch_touches_a_subsystem_the_sidecar_owns():
    """A guard on the table itself, so growing it cannot quietly reopen a hole."""
    owned = (
        "--user-data-dir",
        "--profile-directory",
        "--proxy",
        "--no-proxy",
        "--load-extension",
        "--disable-extensions-except",
        "--remote-",
        "--user-agent",
        "--lang",
        "--window-size",
        "--force-device-scale-factor=",
        "--ignore-certificate-errors",
        "--host-resolver-rules",
        "--host-rules",
        "--enable-features",
        "--disable-features",
        "--headless",
        "--no-sandbox",
        "--disable-web-security",
    )
    for name in USER_ALLOWED_SWITCHES:
        assert not name.startswith(owned), f"{name} is on the allow-list but the sidecar owns it"
