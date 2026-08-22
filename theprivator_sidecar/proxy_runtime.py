"""Runtime proxy planning for sidecar-owned Chromium launches.

The profile store may contain private proxy credentials, but Chromium launch
planning must only emit redaction-safe switches. This module converts the
trusted store-v3 proxy object into a small runtime contract and rejects states
that Chromium cannot safely satisfy without helper artifacts.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from typing import Any, Mapping, Optional
from urllib.parse import urlsplit

from .protocol import (
    JsonObject,
    PROXY_INVALID,
    PROXY_LAUNCH_ARG_UNSAFE,
    PROXY_SOCKS_AUTH_UNSUPPORTED,
    SidecarError,
)
from .proxy import (
    CREDENTIAL_STATE_CONFIGURED,
    CREDENTIAL_STATE_NONE,
    DIRECT_PROXY_MODE,
    FIXED_SERVER_PROXY_MODE,
    PROXY_VERSION,
    SUPPORTED_PROXY_PROTOCOLS,
    normalize_proxy_config,
)

PROXY_SERVER_ARG_PREFIX = "--proxy-server="
_HTTP_AUTH_PROTOCOLS = frozenset({"http", "https"})
_REJECTED_PROXY_SWITCH_PREFIXES = (
    "--proxy-bypass-list",
    "--proxy-pac-url",
    "--proxy-auto-detect",
    "--proxy-server",  # malformed variants; exact generated form is validated separately.
    "--no-proxy-server",
)
_REJECTED_RUNTIME_SWITCH_PREFIXES = (
    "--remote-debugging-address",
    "--remote-debugging-port",
    "--user-data-dir",
    "--ignore-certificate-errors",
    "--ignore-certificate-errors-spki-list",
)


@dataclass(frozen=True)
class ProxyRuntimePlan:
    """Safe launch-time proxy contract derived from one private proxy object."""

    proxy_version: int
    mode: str
    protocol: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    proxy_server: Optional[str] = None
    requires_auth_helper: bool = False
    credential_state: str = CREDENTIAL_STATE_NONE

    @property
    def launch_args(self) -> list[str]:
        """Return Chromium switches for this plan, never including credentials."""
        if self.proxy_server is None:
            return []
        return [validate_proxy_server_launch_arg(f"{PROXY_SERVER_ARG_PREFIX}{self.proxy_server}")]

    def to_dict(self) -> JsonObject:
        """Return a bounded redaction-safe summary for tests/diagnostics."""
        payload: JsonObject = {
            "proxyVersion": self.proxy_version,
            "mode": self.mode,
            "requiresAuthHelper": self.requires_auth_helper,
            "credentialState": self.credential_state,
            "launchArgCount": len(self.launch_args),
        }
        if self.protocol is not None:
            payload["protocol"] = self.protocol
        if self.host is not None:
            payload["host"] = self.host
        if self.port is not None:
            payload["port"] = self.port
        if self.proxy_server is not None:
            payload["proxyServer"] = self.proxy_server
        return payload


def build_proxy_runtime_plan(proxy: Any) -> ProxyRuntimePlan:
    """Normalize one private proxy config into safe Chromium launch inputs.

    HTTP(S) credentials are represented as an auth-helper extension requirement.
    SOCKS5 credentials are handled by Chromium launch through a local no-auth
    bridge, while SOCKS4 username/password remains unsupported and fails before
    executable discovery, extension generation, or process spawn.
    """
    normalized = normalize_proxy_config(proxy)
    mode = normalized["mode"]
    if mode == DIRECT_PROXY_MODE:
        return ProxyRuntimePlan(proxy_version=PROXY_VERSION, mode=DIRECT_PROXY_MODE)

    if mode != FIXED_SERVER_PROXY_MODE:  # Defensive; normalize_proxy_config normally raises first.
        raise SidecarError(
            code=PROXY_INVALID,
            message="Proxy runtime plan could not be prepared.",
        )

    protocol = normalized["protocol"]
    host = normalized["host"]
    port = normalized["port"]
    has_credentials = isinstance(normalized.get("credentials"), Mapping)
    if has_credentials and protocol == "socks4":
        raise SidecarError(
            code=PROXY_SOCKS_AUTH_UNSUPPORTED,
            message="SOCKS4 proxy credentials cannot be used for Chromium proxy launch.",
        )

    proxy_server = proxy_server_identifier(protocol, host, port)
    return ProxyRuntimePlan(
        proxy_version=PROXY_VERSION,
        mode=FIXED_SERVER_PROXY_MODE,
        protocol=protocol,
        host=host,
        port=port,
        proxy_server=proxy_server,
        requires_auth_helper=has_credentials and protocol in _HTTP_AUTH_PROTOCOLS,
        credential_state=CREDENTIAL_STATE_CONFIGURED if has_credentials else CREDENTIAL_STATE_NONE,
    )


def proxy_server_identifier(protocol: str, host: str, port: int) -> str:
    """Return Chromium's fixed-server identifier for a normalized proxy."""
    if protocol not in SUPPORTED_PROXY_PROTOCOLS:
        raise SidecarError(
            code=PROXY_INVALID,
            message="Proxy runtime plan could not be prepared.",
        )
    return f"{protocol}://{_host_for_chromium(host)}:{port}"


def validate_proxy_server_launch_arg(arg: str) -> str:
    """Validate one sidecar-generated --proxy-server switch.

    This intentionally accepts only a single fixed-server URL. It rejects
    credentials, direct fallback, bypass/PAC-style expressions, and malformed
    IPv6 so unsafe strings never reach subprocess spawning.
    """
    if not isinstance(arg, str) or not arg.startswith(PROXY_SERVER_ARG_PREFIX):
        _raise_unsafe_proxy_arg()

    value = arg[len(PROXY_SERVER_ARG_PREFIX) :]
    if not value or _contains_control_or_space(value):
        _raise_unsafe_proxy_arg()
    if any(marker in value for marker in (";", ",", "=")):
        _raise_unsafe_proxy_arg()
    if value.casefold().startswith("direct://") or "direct://" in value.casefold():
        _raise_unsafe_proxy_arg()

    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise _unsafe_proxy_arg_error() from exc

    if parsed.scheme not in SUPPORTED_PROXY_PROTOCOLS:
        _raise_unsafe_proxy_arg()
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        _raise_unsafe_proxy_arg()
    if parsed.path or parsed.query or parsed.fragment:
        _raise_unsafe_proxy_arg()
    if not isinstance(parsed.hostname, str) or port is None:
        _raise_unsafe_proxy_arg()

    try:
        normalized = normalize_proxy_config(
            {
                "proxyVersion": PROXY_VERSION,
                "mode": FIXED_SERVER_PROXY_MODE,
                "protocol": parsed.scheme,
                "host": parsed.hostname,
                "port": port,
            }
        )
    except SidecarError as exc:
        raise _unsafe_proxy_arg_error() from exc

    expected = proxy_server_identifier(
        normalized["protocol"],
        normalized["host"],
        normalized["port"],
    )
    if value != expected:
        _raise_unsafe_proxy_arg()
    return arg


def is_rejected_launch_switch(arg: str) -> bool:
    """Return whether a Chromium extra arg is a reserved unsafe switch."""
    if not isinstance(arg, str):
        return False
    return any(
        arg == prefix or arg.startswith(f"{prefix}=") or arg.startswith(f"{prefix} ")
        for prefix in (*_REJECTED_PROXY_SWITCH_PREFIXES, *_REJECTED_RUNTIME_SWITCH_PREFIXES)
    )


def _host_for_chromium(host: str) -> str:
    try:
        parsed = ipaddress.ip_address(host)
    except ValueError:
        return host.lower()
    if parsed.version == 6:
        return f"[{parsed.compressed}]"
    return str(parsed)


def _contains_control_or_space(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 or character.isspace() for character in value)


def _unsafe_proxy_arg_error() -> SidecarError:
    return SidecarError(
        code=PROXY_LAUNCH_ARG_UNSAFE,
        message="Chromium proxy launch arguments could not be prepared.",
    )


def _raise_unsafe_proxy_arg() -> None:
    raise _unsafe_proxy_arg_error()


__all__ = [
    "PROXY_SERVER_ARG_PREFIX",
    "ProxyRuntimePlan",
    "build_proxy_runtime_plan",
    "is_rejected_launch_switch",
    "proxy_server_identifier",
    "validate_proxy_server_launch_arg",
]
