"""Generate per-profile MV3 helpers for HTTP/HTTPS proxy authentication.

The generated extension is a private runtime artifact: it contains proxy
credentials so Chromium can answer proxy auth challenges, but public sidecar
payloads and diagnostics only expose bounded metadata. Credentials never appear
in Chromium's proxy URI or launch argv.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Union

from .protocol import JsonObject, PROXY_AUTH_HELPER_FAILED, SidecarError
from .proxy import FIXED_SERVER_PROXY_MODE, PROXY_VERSION, normalize_proxy_config
from .proxy_runtime import ProxyRuntimePlan, proxy_server_identifier

MANIFEST_NAME = "manifest.json"
CONFIG_SCRIPT_NAME = "proxy_auth_config.js"
WORKER_SCRIPT_NAME = "proxy_auth_worker.js"
GENERATED_EXTENSIONS_DIR = "proxy-auth-extensions"
CONFIG_GLOBAL_NAME = "__THEPRIVATOR_PROXY_AUTH_CONFIG__"
HANDLE_GLOBAL_NAME = "__THEPRIVATOR_PROXY_AUTH_HANDLE_AUTH_REQUIRED__"
_SAFE_EXTENSION_MESSAGE = "Proxy auth helper could not be prepared."
_SCHEMA_VERSION = 1
_ALLOWED_AUTH_PROTOCOLS = frozenset({"http", "https"})
_FORBIDDEN_TEXT_MARKERS = (
    "DevToolsActivePort",
    "ws://",
    "wss://",
    "--remote-debugging-port",
    "debugPort",
    "--proxy-server",
    "--load-extension",
    "Traceback",
)


@dataclass(frozen=True)
class ProxyAuthExtensionArtifact:
    """Internal proxy-auth extension artifact metadata safe to summarize."""

    extension_dir: Path
    profile_key: str
    files: list[str]

    def to_public_dict(self) -> JsonObject:
        return {
            "profileKey": self.profile_key,
            "files": list(self.files),
            "requiresAuthHelper": True,
        }

    def to_safe_dict(self) -> JsonObject:
        return self.to_public_dict()


def runtime_proxy_auth_extension_root(store_root: Union[str, Path]) -> Path:
    """Return the app-owned generated proxy-auth extension root for a store root."""
    return Path(store_root) / "profile-store" / "runtime" / GENERATED_EXTENSIONS_DIR


def generate_proxy_auth_extension(
    extension_root: Union[str, Path],
    profile_id: str,
    proxy: Any,
    runtime_plan: ProxyRuntimePlan,
) -> ProxyAuthExtensionArtifact:
    """Write a static MV3 proxy-auth helper for one credentialed HTTP(S) plan."""
    temp_dir: Path | None = None
    try:
        config = _build_config(proxy, runtime_plan)
        profile_key = _profile_key(profile_id)
        root = Path(extension_root)
        root.mkdir(parents=True, exist_ok=True)
        target_dir = root / profile_key
        temp_dir = root / f".{profile_key}.{uuid.uuid4().hex}.tmp"
        _remove_path(temp_dir)
        temp_dir.mkdir(parents=False)

        _write_json(temp_dir / MANIFEST_NAME, _manifest())
        _write_text(temp_dir / CONFIG_SCRIPT_NAME, _config_script(config))
        _write_text(temp_dir / WORKER_SCRIPT_NAME, _worker_script())
        validate_proxy_auth_extension(temp_dir)

        _remove_path(target_dir)
        os.replace(temp_dir, target_dir)
        temp_dir = None
        return ProxyAuthExtensionArtifact(
            extension_dir=target_dir,
            profile_key=profile_key,
            files=[MANIFEST_NAME, CONFIG_SCRIPT_NAME, WORKER_SCRIPT_NAME],
        )
    except SidecarError:
        _remove_path(temp_dir)
        raise
    except Exception as exc:
        _remove_path(temp_dir)
        raise _extension_error() from exc


def validate_proxy_auth_extension(extension_dir: Union[str, Path]) -> None:
    """Validate generated proxy-auth helper files before Chromium launch."""
    try:
        root = Path(extension_dir)
        if not root.is_dir():
            raise ValueError("extension directory is unavailable")
        manifest_path = root / MANIFEST_NAME
        config_path = root / CONFIG_SCRIPT_NAME
        worker_path = root / WORKER_SCRIPT_NAME
        if not manifest_path.is_file() or not config_path.is_file() or not worker_path.is_file():
            raise ValueError("generated extension files are incomplete")

        with manifest_path.open("r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        if not isinstance(manifest, Mapping):
            raise ValueError("manifest must be an object")
        _validate_manifest(manifest)

        config_text = config_path.read_text(encoding="utf-8")
        worker_text = worker_path.read_text(encoding="utf-8")
        config = _parse_config_script(config_text)
        _validate_config(config)
        _validate_worker(worker_text)
    except SidecarError:
        raise
    except Exception as exc:
        raise _extension_error() from exc


def _build_config(proxy: Any, runtime_plan: ProxyRuntimePlan) -> JsonObject:
    normalized = normalize_proxy_config(proxy)
    if normalized.get("mode") != FIXED_SERVER_PROXY_MODE:
        raise _extension_error()
    protocol = normalized.get("protocol")
    host = normalized.get("host")
    port = normalized.get("port")
    credentials = normalized.get("credentials")
    if protocol not in _ALLOWED_AUTH_PROTOCOLS:
        raise _extension_error()
    if not isinstance(host, str) or not isinstance(port, int) or not isinstance(credentials, Mapping):
        raise _extension_error()
    if not runtime_plan.requires_auth_helper:
        raise _extension_error()
    if runtime_plan.protocol != protocol or runtime_plan.host != host or runtime_plan.port != port:
        raise _extension_error()
    if runtime_plan.proxy_server != proxy_server_identifier(protocol, host, port):
        raise _extension_error()

    username = credentials.get("username")
    password = credentials.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        raise _extension_error()
    config: JsonObject = {
        "schemaVersion": _SCHEMA_VERSION,
        "proxyVersion": PROXY_VERSION,
        "protocol": protocol,
        "challenger": {
            "host": _canonical_challenger_host(host),
            "port": port,
        },
        "credentials": {
            "username": username,
            "password": password,
        },
    }
    _validate_config(config)
    return config


def _validate_config(config: Mapping[str, Any]) -> None:
    if set(config) != {"schemaVersion", "proxyVersion", "protocol", "challenger", "credentials"}:
        raise _extension_error()
    if config.get("schemaVersion") != _SCHEMA_VERSION or config.get("proxyVersion") != PROXY_VERSION:
        raise _extension_error()
    if config.get("protocol") not in _ALLOWED_AUTH_PROTOCOLS:
        raise _extension_error()
    challenger = _require_object(config.get("challenger"))
    if set(challenger) != {"host", "port"}:
        raise _extension_error()
    _require_string(challenger.get("host"))
    _require_int(challenger.get("port"), minimum=1, maximum=65535)
    credentials = _require_object(config.get("credentials"))
    if set(credentials) != {"username", "password"}:
        raise _extension_error()
    _require_string(credentials.get("username"))
    _require_string(credentials.get("password"))


def _validate_manifest(manifest: Mapping[str, Any]) -> None:
    if manifest.get("manifest_version") != 3:
        raise _extension_error()
    if manifest.get("name") != "thePrivator Proxy Auth Runtime":
        raise _extension_error()
    if manifest.get("version") != "1.0.0":
        raise _extension_error()
    if manifest.get("permissions") != ["webRequest", "webRequestAuthProvider"]:
        raise _extension_error()
    if manifest.get("host_permissions") != ["<all_urls>"]:
        raise _extension_error()
    background = manifest.get("background")
    if not isinstance(background, Mapping) or background.get("service_worker") != WORKER_SCRIPT_NAME:
        raise _extension_error()
    if set(manifest) - {
        "manifest_version",
        "name",
        "version",
        "description",
        "permissions",
        "host_permissions",
        "background",
    }:
        raise _extension_error()


def _validate_worker(worker_text: str) -> None:
    for required in (
        f"importScripts('{CONFIG_SCRIPT_NAME}')",
        "chrome.webRequest.onAuthRequired.addListener",
        "details.isProxy !== true",
        "return {};",
        "return { cancel: true };",
        "authCredentials",
        HANDLE_GLOBAL_NAME,
    ):
        if required not in worker_text:
            raise _extension_error()
    _assert_no_forbidden_text(worker_text)


def _manifest() -> JsonObject:
    return {
        "manifest_version": 3,
        "name": "thePrivator Proxy Auth Runtime",
        "version": "1.0.0",
        "description": "Answers configured HTTP/HTTPS proxy authentication challenges.",
        "permissions": ["webRequest", "webRequestAuthProvider"],
        "host_permissions": ["<all_urls>"],
        "background": {"service_worker": WORKER_SCRIPT_NAME},
    }


def _config_script(config: Mapping[str, Any]) -> str:
    encoded = json.dumps(config, ensure_ascii=True, separators=(",", ":"), sort_keys=True, allow_nan=False)
    return f"self.{CONFIG_GLOBAL_NAME}=Object.freeze({encoded});\n"


def _parse_config_script(config_text: str) -> JsonObject:
    prefix = f"self.{CONFIG_GLOBAL_NAME}=Object.freeze("
    suffix = ");\n"
    if not config_text.startswith(prefix) or not config_text.endswith(suffix):
        raise _extension_error()
    raw = config_text[len(prefix) : -len(suffix)]
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise _extension_error()
    return parsed


def _worker_script() -> str:
    return f"""
importScripts('{CONFIG_SCRIPT_NAME}');

(() => {{
  'use strict';

  const config = self.{CONFIG_GLOBAL_NAME};
  const usedChallenges = new Set();
  const normalizeHost = (host) => String(host || '').toLowerCase();
  const configuredHost = normalizeHost(config && config.challenger && config.challenger.host);
  const configuredPort = Number(config && config.challenger && config.challenger.port);
  const challengeKey = (details) => [
    String((details && details.requestId) || ''),
    normalizeHost(details && details.challenger && details.challenger.host),
    String((details && details.challenger && details.challenger.port) || ''),
  ].join('|');
  const isConfiguredChallenger = (details) => {{
    const challenger = (details && details.challenger) || {{}};
    return normalizeHost(challenger.host) === configuredHost && Number(challenger.port) === configuredPort;
  }};
  const handleAuthRequired = (details) => {{
    if (!details || details.isProxy !== true) return {{}};
    if (!isConfiguredChallenger(details)) return {{ cancel: true }};
    const key = challengeKey(details);
    if (usedChallenges.has(key)) return {{ cancel: true }};
    usedChallenges.add(key);
    return {{
      authCredentials: {{
        username: String(config.credentials.username),
        password: String(config.credentials.password),
      }},
    }};
  }};

  chrome.webRequest.onAuthRequired.addListener(
    handleAuthRequired,
    {{ urls: ['<all_urls>'] }},
    ['blocking']
  );
  self.{HANDLE_GLOBAL_NAME} = handleAuthRequired;
}})();
""".lstrip()


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    _write_text(path, json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def _write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def _profile_key(profile_id: str) -> str:
    if not isinstance(profile_id, str) or not profile_id.strip():
        raise _extension_error()
    digest = hashlib.sha256(profile_id.encode("utf-8", errors="surrogatepass")).hexdigest()[:16]
    return f"profile-{digest}"


def _canonical_challenger_host(host: str) -> str:
    try:
        parsed = ipaddress.ip_address(host)
    except ValueError:
        return host.casefold()
    return parsed.compressed.casefold()


def _require_object(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _extension_error()
    return value


def _require_string(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 512 or _contains_control_characters(value):
        raise _extension_error()
    return value


def _require_int(value: Any, *, minimum: int, maximum: int) -> int:
    if type(value) is not int or value < minimum or value > maximum:
        raise _extension_error()
    return value


def _assert_no_forbidden_text(text: str) -> None:
    if any(marker in text for marker in _FORBIDDEN_TEXT_MARKERS):
        raise _extension_error()


def _contains_control_characters(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def _remove_path(path: Path | None) -> None:
    if path is None:
        return
    try:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        elif path.exists() or path.is_symlink():
            path.unlink()
    except OSError:
        return


def _extension_error() -> SidecarError:
    return SidecarError(
        code=PROXY_AUTH_HELPER_FAILED,
        message=_SAFE_EXTENSION_MESSAGE,
    )


__all__ = [
    "CONFIG_SCRIPT_NAME",
    "GENERATED_EXTENSIONS_DIR",
    "MANIFEST_NAME",
    "ProxyAuthExtensionArtifact",
    "WORKER_SCRIPT_NAME",
    "generate_proxy_auth_extension",
    "runtime_proxy_auth_extension_root",
    "validate_proxy_auth_extension",
]
