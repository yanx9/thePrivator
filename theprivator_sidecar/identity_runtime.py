"""Map canonical profile identity JSON into launch-time runtime contracts."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from .identity import IDENTITY_VERSION, normalize_identity
from .protocol import IDENTITY_CDP_FAILED, JsonObject, SidecarError

RUNTIME_PLAN_SCHEMA_VERSION = 1
WEBRTC_DISABLE_NON_PROXIED_UDP_FLAG = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"


@dataclass(frozen=True)
class IdentityRuntimePlan:
    """Deterministic identity artifacts needed by Chromium launch integration."""

    identity_version: int
    preset_id: Optional[str]
    extension_config: JsonObject
    cdp_overrides: JsonObject
    launch_flags: list[str]

    @property
    def requires_extension(self) -> bool:
        return bool(self.extension_config)

    @property
    def requires_cdp(self) -> bool:
        return bool(self.cdp_overrides)

    def to_dict(self) -> JsonObject:
        """Return a JSON-safe, public-safe plan summary without profile labels."""
        return {
            "identityVersion": self.identity_version,
            "presetId": self.preset_id,
            "requiresExtension": self.requires_extension,
            "requiresCdp": self.requires_cdp,
            "extensionConfig": _json_copy(self.extension_config),
            "cdpOverrides": _json_copy(self.cdp_overrides),
            "launchFlags": list(self.launch_flags),
        }


def build_identity_runtime_plan(identity: Any) -> IdentityRuntimePlan:
    """Normalize one profile identity into extension, CDP, and launch artifacts."""
    normalized = normalize_identity(identity)
    try:
        extension_config = _build_extension_config(normalized)
        cdp_overrides = _build_cdp_overrides(normalized)
        launch_flags = _build_launch_flags(normalized)
        return IdentityRuntimePlan(
            identity_version=IDENTITY_VERSION,
            preset_id=normalized.get("presetId") if isinstance(normalized.get("presetId"), str) else None,
            extension_config=extension_config,
            cdp_overrides=cdp_overrides,
            launch_flags=launch_flags,
        )
    except SidecarError:
        raise
    except Exception as exc:
        raise SidecarError(
            code=IDENTITY_CDP_FAILED,
            message="Identity CDP overrides could not be prepared.",
        ) from exc


def _build_extension_config(identity: Mapping[str, Any]) -> JsonObject:
    config: JsonObject = {}

    navigator = identity["navigator"]
    if navigator.get("mode") != "real":
        config["navigator"] = {
            "platform": navigator["platform"],
            "hardwareConcurrency": navigator["hardwareConcurrency"],
            "deviceMemory": navigator["deviceMemory"],
            "userAgentData": _navigator_user_agent_metadata(navigator),
        }

    locale = identity["locale"]
    if locale.get("mode") != "real":
        config["locale"] = {
            "locale": locale["locale"],
            "languages": list(locale["languages"]),
            "timezoneId": locale["timezoneId"],
        }

    screen = identity["screen"]
    if screen.get("mode") != "real":
        config["screen"] = {
            "width": screen["width"],
            "height": screen["height"],
            "viewportWidth": screen["viewportWidth"],
            "viewportHeight": screen["viewportHeight"],
            "colorDepth": screen["colorDepth"],
            "pixelRatio": screen["pixelRatio"],
        }

    canvas = identity["canvas"]
    if canvas.get("mode") == "noise":
        config["canvas"] = {"enabled": True, "noiseSeed": canvas["noiseSeed"]}

    audio = identity["audio"]
    if audio.get("mode") == "noise":
        config["audio"] = {"enabled": True, "noiseSeed": audio["noiseSeed"]}

    webgl = identity["webgl"]
    if webgl.get("mode") != "real":
        webgl_config: JsonObject = {
            "enabled": True,
            "vendor": webgl["vendor"],
            "renderer": webgl["renderer"],
        }
        if "noiseSeed" in webgl:
            webgl_config["noiseSeed"] = webgl["noiseSeed"]
        config["webgl"] = webgl_config

    webrtc = identity["webrtc"]
    if webrtc.get("policy") != "real":
        config["webrtc"] = {"policy": webrtc["policy"]}

    if not config:
        return {}
    return {"schemaVersion": RUNTIME_PLAN_SCHEMA_VERSION, **config}


def _build_cdp_overrides(identity: Mapping[str, Any]) -> JsonObject:
    overrides: JsonObject = {}

    browser = identity["browser"]
    navigator = identity["navigator"]
    locale = identity["locale"]
    screen = identity["screen"]

    if browser.get("mode") != "real":
        user_agent: JsonObject = {"userAgent": browser["userAgent"]}
        if locale.get("mode") != "real":
            user_agent["acceptLanguage"] = ",".join(locale["languages"])
        if navigator.get("mode") != "real":
            user_agent["platform"] = navigator["platform"]
        metadata = _browser_user_agent_metadata(browser, navigator)
        if metadata:
            user_agent["userAgentMetadata"] = metadata
        overrides["userAgent"] = user_agent

    if locale.get("mode") != "real":
        overrides["locale"] = {"locale": locale["locale"]}
        overrides["timezone"] = {"timezoneId": locale["timezoneId"]}

    if screen.get("mode") != "real":
        overrides["deviceMetrics"] = {
            "width": screen["viewportWidth"],
            "height": screen["viewportHeight"],
            "deviceScaleFactor": screen["pixelRatio"],
            "mobile": _identity_mobile(identity),
            "screenWidth": screen["width"],
            "screenHeight": screen["height"],
        }

    return overrides


def _build_launch_flags(identity: Mapping[str, Any]) -> list[str]:
    policy = identity["webrtc"].get("policy")
    if policy in {"disableNonProxiedUdp", "block"}:
        return [WEBRTC_DISABLE_NON_PROXIED_UDP_FLAG]
    return []


def _browser_user_agent_metadata(browser: Mapping[str, Any], navigator: Mapping[str, Any]) -> JsonObject:
    raw_hints = browser.get("clientHints")
    if isinstance(raw_hints, Mapping) and raw_hints:
        return _ordered_metadata(raw_hints)
    if navigator.get("mode") == "real":
        return {}
    return _navigator_user_agent_metadata(navigator)


def _navigator_user_agent_metadata(navigator: Mapping[str, Any]) -> JsonObject:
    return {
        "platform": navigator["uaPlatform"],
        "platformVersion": navigator["uaPlatformVersion"],
        "architecture": navigator["uaArchitecture"],
        "mobile": navigator["uaMobile"],
    }


def _ordered_metadata(raw: Mapping[str, Any]) -> JsonObject:
    metadata: JsonObject = {}
    for key in ("platform", "platformVersion", "architecture", "mobile", "bitness", "model"):
        if key in raw:
            metadata[key] = raw[key]
    return metadata


def _identity_mobile(identity: Mapping[str, Any]) -> bool:
    browser_hints = identity["browser"].get("clientHints")
    if isinstance(browser_hints, Mapping) and isinstance(browser_hints.get("mobile"), bool):
        return browser_hints["mobile"]
    navigator = identity["navigator"]
    if navigator.get("mode") != "real" and isinstance(navigator.get("uaMobile"), bool):
        return navigator["uaMobile"]
    return False


def _json_copy(payload: Any) -> Any:
    return json.loads(json.dumps(payload, ensure_ascii=False, allow_nan=False, sort_keys=True))


__all__ = [
    "IdentityRuntimePlan",
    "RUNTIME_PLAN_SCHEMA_VERSION",
    "WEBRTC_DISABLE_NON_PROXIED_UDP_FLAG",
    "build_identity_runtime_plan",
]
