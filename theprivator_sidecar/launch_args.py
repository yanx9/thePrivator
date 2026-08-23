"""Curated allow-list for user-supplied Chromium switches.

The sidecar owns the flags that make a profile what it is -- the proxy, the
identity extension, the user-data directory, the DevTools endpoint. A user flag
that touches any of those does not customise the browser, it defeats the feature
it is running inside: ``--host-resolver-rules=MAP * 1.2.3.4`` redirects every
request without naming a proxy, and ``--disable-web-security`` neuters the
identity extension. So this is an allow-list of switches known to be inert with
respect to those subsystems, not a deny-list of ones known to be dangerous.

There is deliberately no escape hatch. Users will ask for one; the answer is to
add a table entry and a test case, which is a one-line change and a review, not
a runtime toggle that silently voids the guarantees the rest of the code spends
thousands of lines establishing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence

from .protocol import LAUNCH_ARG_UNSUPPORTED, SidecarError
from .proxy_runtime import is_rejected_launch_switch

MAX_USER_LAUNCH_ARGS = 20
MAX_USER_LAUNCH_ARG_LENGTH = 256

_BOOL_VALUE = re.compile(r"^(?:true|false)$", re.IGNORECASE)
_INT_VALUE = re.compile(r"^-?\d{1,6}$")
_WORD_VALUE = re.compile(r"^[A-Za-z0-9_.,-]{1,64}$")
_WINDOW_POSITION = re.compile(r"^-?\d{1,5},-?\d{1,5}$")


@dataclass(frozen=True)
class AllowedSwitch:
    """One switch a profile may carry, and what its value may look like."""

    name: str
    takes_value: bool = False
    value_pattern: Optional[re.Pattern[str]] = None
    max_value_length: int = 64


def _switch(name: str, *, value: Optional[re.Pattern[str]] = None, max_length: int = 64) -> AllowedSwitch:
    return AllowedSwitch(
        name=name,
        takes_value=value is not None,
        value_pattern=value,
        max_value_length=max_length,
    )


# Chosen because none of them touch networking, name resolution, the extension
# system, the process model, or DevTools. Growing this list is expected; each
# addition should be justified against that sentence.
USER_ALLOWED_SWITCHES: Mapping[str, AllowedSwitch] = {
    switch.name: switch
    for switch in (
        # Window and presentation
        _switch("--start-maximized"),
        _switch("--start-fullscreen"),
        _switch("--window-position", value=_WINDOW_POSITION),
        _switch("--hide-scrollbars"),
        _switch("--force-prefers-reduced-motion"),
        _switch("--force-color-profile", value=_WORD_VALUE),
        _switch("--force-dark-mode"),
        _switch("--font-render-hinting", value=_WORD_VALUE),
        _switch("--disable-lcd-text"),
        # Media and notifications
        _switch("--mute-audio"),
        _switch("--autoplay-policy", value=_WORD_VALUE),
        _switch("--disable-notifications"),
        _switch("--disable-popup-blocking"),
        # Rendering and performance
        _switch("--disable-gpu"),
        _switch("--disable-gpu-compositing"),
        _switch("--disable-software-rasterizer"),
        _switch("--disable-dev-shm-usage"),
        _switch("--disable-backgrounding-occluded-windows"),
        _switch("--disable-renderer-backgrounding"),
        _switch("--disable-background-timer-throttling"),
        _switch("--disable-ipc-flooding-protection"),
        # Content behaviour that stays inside the tab
        _switch("--disable-blink-features", value=_WORD_VALUE),
        _switch("--disable-infobars"),
        _switch("--disable-session-crashed-bubble"),
        _switch("--noerrdialogs"),
        _switch("--no-service-autorun"),
        _switch("--password-store", value=_WORD_VALUE),
        _switch("--use-mock-keychain"),
        _switch("--disable-search-engine-choice-screen"),
        _switch("--ash-no-nudges"),
        _switch("--propagate-iph-for-testing", value=_BOOL_VALUE),
        _switch("--force-device-scale-factor-reset"),
        _switch("--disable-component-update"),
        _switch("--disable-domain-reliability"),
        _switch("--disable-client-side-phishing-detection"),
        _switch("--disable-hang-monitor"),
        _switch("--disable-prompt-on-repost"),
        _switch("--no-pings"),
        _switch("--enable-automation-reset"),
        _switch("--test-type", value=_WORD_VALUE),
        _switch("--renderer-process-limit", value=_INT_VALUE),
    )
}

# Prefixes the sidecar derives itself. A user value here would either be
# overridden silently or would override the sidecar's own, and both outcomes are
# worse than refusing. Matched by prefix because every variant is owned.
_SIDECAR_OWNED_PREFIXES = (
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
    "--force-device-scale-factor",
    "--ignore-certificate-errors",
    "--force-webrtc-ip-handling-policy",
)

# Never allowed regardless of what the table above grows to hold. Each of these
# voids a guarantee the product makes rather than adjusting the browser.
_ALWAYS_REJECTED = (
    "--no-sandbox",
    "--disable-web-security",
    "--allow-running-insecure-content",
    "--disable-site-isolation-trials",
    "--headless",
    "--host-resolver-rules",
    "--host-rules",
    "--dns-over-https-templates",
    "--dns-over-https-mode",
    "--js-flags",
    "--enable-logging",
    "--log-file",
    "--log-level",
    "--log-net-log",
    "--vmodule",
    "--auto-open-devtools-for-tabs",
    "--enable-features",
    "--disable-features",
    "--allow-insecure-localhost",
    "--unsafely-treat-insecure-origin-as-secure",
)


def validate_user_launch_args(args: Any) -> list[str]:
    """Return the user switches that may be appended to a Chromium launch.

    Raises ``LAUNCH_ARG_UNSUPPORTED`` naming only the switch, never its value:
    an argument's value can carry whatever the user typed, including something
    they would not want echoed back through an error surface.
    """
    if args is None:
        return []
    if not isinstance(args, Sequence) or isinstance(args, (str, bytes)):
        raise _unsupported("Launch arguments must be a list of switches.")
    if len(args) > MAX_USER_LAUNCH_ARGS:
        raise _unsupported(
            f"A profile can carry at most {MAX_USER_LAUNCH_ARGS} launch arguments."
        )

    validated: list[str] = []
    seen: set[str] = set()
    for candidate in args:
        name, value = _split_switch(candidate)

        if name in seen:
            raise _unsupported(f"Launch argument {name} is repeated.")
        seen.add(name)

        if is_rejected_launch_switch(candidate):
            raise _unsupported(f"Launch argument {name} is reserved by the proxy layer.")
        if name in _ALWAYS_REJECTED:
            raise _unsupported(f"Launch argument {name} is not supported.")
        if name.startswith(_SIDECAR_OWNED_PREFIXES):
            raise _unsupported(f"Launch argument {name} is managed by ThePrivator.")

        allowed = USER_ALLOWED_SWITCHES.get(name)
        if allowed is None:
            raise _unsupported(f"Launch argument {name} is not supported.")
        if value is None and allowed.takes_value:
            raise _unsupported(f"Launch argument {name} requires a value.")
        if value is not None:
            if not allowed.takes_value:
                raise _unsupported(f"Launch argument {name} does not take a value.")
            if len(value) > allowed.max_value_length:
                raise _unsupported(f"Launch argument {name} has an oversized value.")
            if allowed.value_pattern is not None and not allowed.value_pattern.match(value):
                raise _unsupported(f"Launch argument {name} has an unsupported value.")

        validated.append(candidate)
    return validated


def _split_switch(candidate: Any) -> tuple[str, Optional[str]]:
    if not isinstance(candidate, str):
        raise _unsupported("Launch arguments must be text.")
    if not candidate.startswith("--"):
        raise _unsupported("Launch arguments must be switches beginning with '--'.")
    if len(candidate) > MAX_USER_LAUNCH_ARG_LENGTH:
        raise _unsupported("Launch argument is too long.")
    if any(ord(character) < 32 or ord(character) == 127 for character in candidate):
        raise _unsupported("Launch arguments cannot contain control characters.")
    # A space would let one entry smuggle a second switch past the per-entry
    # checks, since Chromium splits argv itself.
    if any(character.isspace() for character in candidate):
        raise _unsupported("Launch arguments cannot contain whitespace.")

    name, separator, value = candidate.partition("=")
    return name, (value if separator else None)


def _unsupported(message: str) -> SidecarError:
    return SidecarError(code=LAUNCH_ARG_UNSUPPORTED, message=message)
