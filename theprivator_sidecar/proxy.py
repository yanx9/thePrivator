"""Canonical sidecar-owned proxy v1 schema, validation, and redaction helpers.

The profile store is allowed to persist raw proxy credentials, but command
responses, diagnostics, UI models, and verifier output must use only the public
summary returned by ``public_proxy_summary``. This module deliberately accepts a
small exact-field schema so legacy URL/PAC/debug/browser-argv shapes cannot be
smuggled into profile records before S02 implements runtime proxy support.
"""

from __future__ import annotations

import ipaddress
import re
from typing import Any, Mapping

from .protocol import (
    PROXY_INVALID,
    PROXY_PAC_UNSUPPORTED,
    PROXY_UNSUPPORTED_MODE,
    JsonObject,
    SidecarError,
)

PROXY_VERSION = 1
DIRECT_PROXY_MODE = "direct"
FIXED_SERVER_PROXY_MODE = "fixedServer"
SUPPORTED_PROXY_PROTOCOLS = ("http", "https", "socks4", "socks5")
CREDENTIAL_STATE_NONE = "none"
CREDENTIAL_STATE_CONFIGURED = "configured"

MAX_PROXY_HOST_LENGTH = 253
MAX_PROXY_CREDENTIAL_LENGTH = 512

_DIRECT_FIELDS = frozenset({"proxyVersion", "mode"})
_FIXED_SERVER_REQUIRED_FIELDS = frozenset({"proxyVersion", "mode", "protocol", "host", "port"})
_FIXED_SERVER_FIELDS = frozenset({*_FIXED_SERVER_REQUIRED_FIELDS, "credentials"})

_HOST_LABEL = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")


def _field_token(value: str) -> str:
    return "".join(character for character in value.casefold() if character not in {"_", "-", " "})


_PAC_FIELD_TOKENS = frozenset(
    {
        "autoconfigurl",
        "autodetect",
        "pac",
        "pacscript",
        "pacurl",
        "system",
        "wpad",
    }
)
_BYPASS_FIELD_TOKENS = frozenset(
    {
        "bypass",
        "bypasslist",
        "bypassrules",
        "directfallback",
        "fallbacktodirect",
        "noproxy",
        "proxybypassrules",
    }
)
_URL_STYLE_FIELD_TOKENS = frozenset(
    {
        "allproxy",
        "httpproxy",
        "httpsproxy",
        "proxy",
        "proxyserver",
        "proxyurl",
        "server",
        "socksproxy",
        "url",
    }
)
_UNSAFE_FIELD_TOKENS = frozenset(
    {
        "args",
        "argv",
        "binarypath",
        "command",
        "debugport",
        "executable",
        "executablepath",
        "launchargs",
        "path",
        "remotedebuggingport",
    }
)
PROXY_SECRET_FIELD_MARKERS = (
    "auth",
    "authorization",
    "credential",
    "credentials",
    "password",
    "proxyauthorization",
    "proxypass",
    "proxypassword",
    "proxyuser",
    "proxyusername",
    "username",
)
_SECRET_FIELD_TOKENS = frozenset(_field_token(marker) for marker in PROXY_SECRET_FIELD_MARKERS)


DEFAULT_DIRECT_PROXY: JsonObject = {
    "proxyVersion": PROXY_VERSION,
    "mode": DIRECT_PROXY_MODE,
}


def default_proxy_config() -> JsonObject:
    """Return the private persisted shape for a direct proxy profile."""
    return dict(DEFAULT_DIRECT_PROXY)


def normalize_proxy_config(proxy: Any) -> JsonObject:
    """Validate and normalize an untrusted proxy draft into a private shape.

    The returned object is safe only for trusted sidecar/store callers because it
    may include raw ``credentials``. Public responses must call
    ``public_proxy_summary`` instead.
    """
    if not isinstance(proxy, Mapping):
        _raise_proxy_error(PROXY_INVALID, "Proxy configuration must be an object.")

    _reject_unsupported_surfaces(proxy)
    _require_string_keys(proxy)
    _validate_proxy_version(proxy.get("proxyVersion"))

    mode = proxy.get("mode")
    if not isinstance(mode, str) or not mode:
        _raise_proxy_error(PROXY_INVALID, "Proxy mode is required.")
    if _field_token(mode) in _PAC_FIELD_TOKENS:
        _raise_proxy_error(
            PROXY_PAC_UNSUPPORTED,
            "PAC, system, and auto-detect proxy configuration is not supported.",
        )
    if mode == DIRECT_PROXY_MODE:
        return _normalize_direct_proxy(proxy)
    if mode == FIXED_SERVER_PROXY_MODE:
        return _normalize_fixed_server_proxy(proxy)

    _raise_proxy_error(PROXY_UNSUPPORTED_MODE, "Proxy mode is not supported.")


def public_proxy_summary(proxy: Any) -> JsonObject:
    """Return a redaction-safe public proxy summary for command/UI callers."""
    normalized = normalize_proxy_config(proxy)
    if normalized["mode"] == DIRECT_PROXY_MODE:
        return {
            "proxyVersion": PROXY_VERSION,
            "mode": DIRECT_PROXY_MODE,
            "credentialState": CREDENTIAL_STATE_NONE,
            "summary": "Direct connection",
        }

    credential_state = (
        CREDENTIAL_STATE_CONFIGURED
        if isinstance(normalized.get("credentials"), Mapping)
        else CREDENTIAL_STATE_NONE
    )
    protocol = normalized["protocol"]
    host = normalized["host"]
    port = normalized["port"]
    return {
        "proxyVersion": PROXY_VERSION,
        "mode": FIXED_SERVER_PROXY_MODE,
        "protocol": protocol,
        "host": host,
        "port": port,
        "credentialState": credential_state,
        "summary": f"{protocol}://{_host_for_summary(host)}:{port}",
    }


def redact_proxy_secrets(value: Any) -> Any:
    """Return a JSON-like copy with proxy credential-bearing fields redacted."""
    if isinstance(value, Mapping):
        redacted: JsonObject = {}
        for key, nested in value.items():
            if is_proxy_secret_key(key):
                redacted[key] = "<redacted>"
            else:
                redacted[key] = redact_proxy_secrets(nested)
        return redacted
    if isinstance(value, list):
        return [redact_proxy_secrets(item) for item in value]
    if isinstance(value, tuple):
        return [redact_proxy_secrets(item) for item in value]
    return value


def is_proxy_secret_key(key: Any) -> bool:
    """Return whether a field name is proxy credential-bearing."""
    return isinstance(key, str) and _field_token(key) in _SECRET_FIELD_TOKENS


def _normalize_direct_proxy(proxy: Mapping[str, Any]) -> JsonObject:
    if frozenset(proxy.keys()) != _DIRECT_FIELDS:
        _raise_proxy_error(PROXY_INVALID, "Direct proxy configuration contains unsupported fields.")
    return default_proxy_config()


def _normalize_fixed_server_proxy(proxy: Mapping[str, Any]) -> JsonObject:
    keys = frozenset(proxy.keys())
    if not _FIXED_SERVER_REQUIRED_FIELDS <= keys or keys - _FIXED_SERVER_FIELDS:
        _raise_proxy_error(PROXY_INVALID, "Fixed proxy configuration is invalid.")

    protocol = _normalize_protocol(proxy.get("protocol"))
    host = _normalize_host(proxy.get("host"))
    port = _normalize_port(proxy.get("port"))

    normalized: JsonObject = {
        "proxyVersion": PROXY_VERSION,
        "mode": FIXED_SERVER_PROXY_MODE,
        "protocol": protocol,
        "host": host,
        "port": port,
    }
    credentials = _normalize_credentials(proxy.get("credentials")) if "credentials" in proxy else None
    if credentials is not None:
        normalized["credentials"] = credentials
    return normalized


def _normalize_protocol(protocol: Any) -> str:
    if not isinstance(protocol, str) or not protocol:
        _raise_proxy_error(PROXY_INVALID, "Fixed proxy protocol is required.")
    if protocol != protocol.lower():
        _raise_proxy_error(PROXY_INVALID, "Fixed proxy protocol is invalid.")
    if protocol not in SUPPORTED_PROXY_PROTOCOLS:
        _raise_proxy_error(PROXY_UNSUPPORTED_MODE, "Proxy protocol is not supported.")
    return protocol


def _normalize_host(host: Any) -> str:
    if not isinstance(host, str):
        _raise_proxy_error(PROXY_INVALID, "Fixed proxy host is required.")
    if _contains_control_characters(host):
        _raise_proxy_error(PROXY_INVALID, "Fixed proxy host is invalid.")
    trimmed = host.strip()
    if not trimmed or len(trimmed) > MAX_PROXY_HOST_LENGTH:
        _raise_proxy_error(PROXY_INVALID, "Fixed proxy host is invalid.")
    if any(character.isspace() for character in trimmed):
        _raise_proxy_error(PROXY_INVALID, "Fixed proxy host is invalid.")
    if not _is_valid_host(trimmed):
        _raise_proxy_error(PROXY_INVALID, "Fixed proxy host is invalid.")
    return trimmed


def _normalize_port(port: Any) -> int:
    if isinstance(port, bool) or not isinstance(port, int):
        _raise_proxy_error(PROXY_INVALID, "Fixed proxy port is invalid.")
    if port < 1 or port > 65535:
        _raise_proxy_error(PROXY_INVALID, "Fixed proxy port is invalid.")
    return port


def _normalize_credentials(credentials: Any) -> JsonObject | None:
    if credentials is None:
        return None
    if not isinstance(credentials, Mapping):
        _raise_proxy_error(PROXY_INVALID, "Proxy credentials are invalid.")
    _require_string_keys(credentials)
    if frozenset(credentials.keys()) != {"username", "password"}:
        _raise_proxy_error(PROXY_INVALID, "Proxy credentials are invalid.")

    username = _credential_string(credentials.get("username"))
    password = _credential_string(credentials.get("password"))
    return {"username": username, "password": password}


def _credential_string(value: Any) -> str:
    if not isinstance(value, str):
        _raise_proxy_error(PROXY_INVALID, "Proxy credentials are invalid.")
    if not value.strip() or len(value) > MAX_PROXY_CREDENTIAL_LENGTH:
        _raise_proxy_error(PROXY_INVALID, "Proxy credentials are invalid.")
    if _contains_control_characters(value):
        _raise_proxy_error(PROXY_INVALID, "Proxy credentials are invalid.")
    return value


def _validate_proxy_version(value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value != PROXY_VERSION:
        _raise_proxy_error(PROXY_INVALID, "Proxy version is invalid.")


def _reject_unsupported_surfaces(proxy: Mapping[str, Any]) -> None:
    for key, value in proxy.items():
        token = _field_token(key) if isinstance(key, str) else ""
        if token in _PAC_FIELD_TOKENS or (
            token == "mode" and isinstance(value, str) and _field_token(value) in _PAC_FIELD_TOKENS
        ):
            _raise_proxy_error(
                PROXY_PAC_UNSUPPORTED,
                "PAC, system, and auto-detect proxy configuration is not supported.",
            )
        if token in _BYPASS_FIELD_TOKENS:
            _raise_proxy_error(
                PROXY_UNSUPPORTED_MODE,
                "Proxy bypass lists and direct fallback are not supported.",
            )
        if token in _URL_STYLE_FIELD_TOKENS:
            _raise_proxy_error(
                PROXY_UNSUPPORTED_MODE,
                "URL-style proxy configuration is not supported.",
            )
        if token in _UNSAFE_FIELD_TOKENS:
            _raise_proxy_error(PROXY_INVALID, "Proxy configuration contains unsupported fields.")


def _require_string_keys(payload: Mapping[Any, Any]) -> None:
    if any(not isinstance(key, str) or not key for key in payload.keys()):
        _raise_proxy_error(PROXY_INVALID, "Proxy configuration contains invalid fields.")


def _is_valid_host(host: str) -> bool:
    if not host.isascii():
        return False
    if any(marker in host for marker in ("://", "/", "\\", "?", "#", "@")):
        return False
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    if ":" in host:
        return False

    labels = host.split(".")
    return all(_HOST_LABEL.fullmatch(label) for label in labels)


def _host_for_summary(host: str) -> str:
    try:
        parsed = ipaddress.ip_address(host)
    except ValueError:
        return host
    if parsed.version == 6:
        return f"[{host}]"
    return host


def _contains_control_characters(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def _raise_proxy_error(code: str, message: str) -> None:
    raise SidecarError(code=code, message=message)


__all__ = [
    "CREDENTIAL_STATE_CONFIGURED",
    "CREDENTIAL_STATE_NONE",
    "DEFAULT_DIRECT_PROXY",
    "DIRECT_PROXY_MODE",
    "FIXED_SERVER_PROXY_MODE",
    "PROXY_SECRET_FIELD_MARKERS",
    "PROXY_VERSION",
    "SUPPORTED_PROXY_PROTOCOLS",
    "default_proxy_config",
    "is_proxy_secret_key",
    "normalize_proxy_config",
    "public_proxy_summary",
    "redact_proxy_secrets",
]
