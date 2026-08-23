"""Sidecar-owned identity v1 schema, presets, validation, and warnings.

This module is the canonical M002 identity contract for the Python sidecar. It
intentionally maps selected values from the legacy fingerprint presets by hand
instead of importing legacy GUI/profile dataclasses, keeping sidecar persistence
and command validation independent from the old profile manager shape.
"""

from __future__ import annotations

import copy
import math
import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, Iterable, Mapping, Optional, Sequence, Set

from .protocol import (
    IDENTITY_INVALID,
    IDENTITY_PRESET_NOT_FOUND,
    IDENTITY_UNSUPPORTED_MODE,
    JsonObject,
    SidecarError,
)

IDENTITY_VERSION = 2
# v1 identities are upgraded in place on read rather than rejected. Every stored
# profile predates the new surfaces, so refusing them would make the app
# unreadable after an update; the new surfaces start inert instead.
SUPPORTED_IDENTITY_VERSIONS = frozenset({1, IDENTITY_VERSION})
MAX_LABEL_LENGTH = 128
MAX_STRING_LENGTH = 512
MAX_SHORT_STRING_LENGTH = 80
MAX_LANGUAGE_COUNT = 8
MAX_LANGUAGE_LENGTH = 20
MAX_NOISE_SEED = 1_000_000
MAX_SCREEN_DIMENSION = 10_000
MAX_HARDWARE_CONCURRENCY = 128
MAX_DEVICE_MEMORY = 128
MAX_GEOLOCATION_ACCURACY_METERS = 100_000
MIN_GEOLOCATION_ACCURACY_METERS = 1
MAX_ALTITUDE_METERS = 100_000
MIN_ALTITUDE_METERS = -1_000
# Coordinates are rounded because precision is itself a fingerprint: a real
# device reports a handful of decimals, and seventeen significant digits marks a
# profile out more clearly than a wrong city would.
GEOLOCATION_COORDINATE_DECIMALS = 6
MAX_MEDIA_VIDEO_INPUTS = 1
MAX_MEDIA_AUDIO_INPUTS = 4
MAX_MEDIA_AUDIO_OUTPUTS = 4
MAX_ALLOWED_PORTS = 50

SUPPORTED_MODES_BY_SURFACE: Dict[str, Set[str]] = {
    "browser": {"real", "masked", "custom"},
    "navigator": {"real", "masked", "custom"},
    "screen": {"real", "masked", "custom"},
    "locale": {"real", "masked", "custom"},
    "canvas": {"real", "noise"},
    "audio": {"real", "noise"},
    "webgl": {"real", "masked", "custom"},
    "webrtc": {"real", "masked", "custom"},
    # No "masked" for geolocation. In other products that means "derive it from
    # the proxy exit", which needs a geo-IP lookup inside the launch budget on
    # every start -- leaking the exit to a third party to hide it from the page.
    # The UI offers "fill from the last proxy check" instead, which uses a result
    # the user already asked for.
    "geolocation": {"real", "custom"},
    "mediaDevices": {"real", "masked", "custom"},
    "ports": {"real", "masked", "custom"},
}

REQUIRED_SURFACES = tuple(SUPPORTED_MODES_BY_SURFACE.keys())
_ROOT_FIELDS = {"identityVersion", "label", "presetId", *REQUIRED_SURFACES}
_SURFACES_ADDED_IN_V2 = frozenset({"geolocation", "mediaDevices", "ports"})
_CLIENT_HINT_FIELDS = {"platform", "platformVersion", "architecture", "mobile", "bitness", "model"}
_WEBRTC_POLICIES = {"real", "disableNonProxiedUdp", "block"}
_GEOLOCATION_PERMISSIONS = {"prompt", "allow", "block"}
_COMMON_DESKTOP_PLATFORMS = {"Win32", "MacIntel", "Linux x86_64"}
_COMMON_CPU_COUNTS = {1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 64}
_COMMON_DEVICE_MEMORY = {2, 4, 8, 16, 32, 64}
_LANGUAGE_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
_TIMEZONE_RE = re.compile(r"^(?:UTC|[A-Za-z_]+(?:/[A-Za-z0-9_+.-]+)+)$")


@dataclass(frozen=True)
class IdentityWarning:
    """Suspicious-but-saveable identity finding returned to callers."""

    code: str
    message: str
    surface: str
    path: str

    def to_dict(self) -> JsonObject:
        return asdict(self)


DEFAULT_REAL_IDENTITY: JsonObject = {
    "identityVersion": IDENTITY_VERSION,
    "label": "Real identity",
    "presetId": None,
    "browser": {"mode": "real"},
    "navigator": {"mode": "real"},
    "screen": {"mode": "real"},
    "locale": {"mode": "real"},
    "canvas": {"mode": "real"},
    "audio": {"mode": "real"},
    "webgl": {"mode": "real"},
    "webrtc": {"mode": "real", "policy": "real"},
    "geolocation": {"mode": "real", "permission": "prompt"},
    "mediaDevices": {"mode": "real"},
    "ports": {"mode": "real"},
}


# Compact desktop Chromium-only curated table. Values are intentionally mapped
# from legacy preset prior art without importing legacy dataclasses or modules.
CURATED_PRESETS: Dict[str, JsonObject] = {
    "windows-10-chrome-120": {
        "identityVersion": IDENTITY_VERSION,
        "label": "Windows 10 Chrome 120",
        "presetId": "windows-10-chrome-120",
        "browser": {
            "mode": "masked",
            "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "clientHints": {
                "platform": "Windows",
                "platformVersion": "10.0.0",
                "architecture": "x86",
                "mobile": False,
            },
        },
        "navigator": {
            "mode": "masked",
            "platform": "Win32",
            "hardwareConcurrency": 8,
            "deviceMemory": 8,
            "uaPlatform": "Windows",
            "uaPlatformVersion": "10.0.0",
            "uaArchitecture": "x86",
            "uaMobile": False,
        },
        "screen": {
            "mode": "masked",
            "width": 1920,
            "height": 1080,
            "viewportWidth": 1920,
            "viewportHeight": 1032,
            "colorDepth": 24,
            "pixelRatio": 1.0,
        },
        "locale": {
            "mode": "masked",
            "locale": "en-US",
            "languages": ["en-US", "en"],
            "timezoneId": "America/New_York",
        },
        "canvas": {"mode": "noise", "noiseSeed": 120010},
        "audio": {"mode": "noise", "noiseSeed": 120011},
        "webgl": {
            "mode": "masked",
            "vendor": "Google Inc. (NVIDIA)",
            "renderer": "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)",
            "noiseSeed": 120012,
        },
        "webrtc": {"mode": "masked", "policy": "disableNonProxiedUdp"},
        # The new v2 surfaces start inert in every curated preset. They are
        # validated at import time and must be warning-free, so a hardened default
        # here would fail the whole module rather than the one preset.
        "geolocation": {"mode": "real", "permission": "prompt"},
        "mediaDevices": {"mode": "real"},
        "ports": {"mode": "real"},
    },
    "windows-11-chrome-121": {
        "identityVersion": IDENTITY_VERSION,
        "label": "Windows 11 Chrome 121",
        "presetId": "windows-11-chrome-121",
        "browser": {
            "mode": "masked",
            "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "clientHints": {
                "platform": "Windows",
                "platformVersion": "10.0.0",
                "architecture": "x86",
                "mobile": False,
            },
        },
        "navigator": {
            "mode": "masked",
            "platform": "Win32",
            "hardwareConcurrency": 16,
            "deviceMemory": 16,
            "uaPlatform": "Windows",
            "uaPlatformVersion": "10.0.0",
            "uaArchitecture": "x86",
            "uaMobile": False,
        },
        "screen": {
            "mode": "masked",
            "width": 2560,
            "height": 1440,
            "viewportWidth": 2560,
            "viewportHeight": 1372,
            "colorDepth": 24,
            "pixelRatio": 1.0,
        },
        "locale": {
            "mode": "masked",
            "locale": "en-US",
            "languages": ["en-US", "en"],
            "timezoneId": "America/Chicago",
        },
        "canvas": {"mode": "noise", "noiseSeed": 121010},
        "audio": {"mode": "noise", "noiseSeed": 121011},
        "webgl": {
            "mode": "masked",
            "vendor": "Google Inc. (NVIDIA)",
            "renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)",
            "noiseSeed": 121012,
        },
        "webrtc": {"mode": "masked", "policy": "disableNonProxiedUdp"},
        # The new v2 surfaces start inert in every curated preset. They are
        # validated at import time and must be warning-free, so a hardened default
        # here would fail the whole module rather than the one preset.
        "geolocation": {"mode": "real", "permission": "prompt"},
        "mediaDevices": {"mode": "real"},
        "ports": {"mode": "real"},
    },
    "macos-ventura-chrome-120": {
        "identityVersion": IDENTITY_VERSION,
        "label": "macOS Ventura Chrome 120",
        "presetId": "macos-ventura-chrome-120",
        "browser": {
            "mode": "masked",
            "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "clientHints": {
                "platform": "macOS",
                "platformVersion": "13.6.0",
                "architecture": "x86",
                "mobile": False,
            },
        },
        "navigator": {
            "mode": "masked",
            "platform": "MacIntel",
            "hardwareConcurrency": 8,
            "deviceMemory": 8,
            "uaPlatform": "macOS",
            "uaPlatformVersion": "13.6.0",
            "uaArchitecture": "x86",
            "uaMobile": False,
        },
        "screen": {
            "mode": "masked",
            "width": 1920,
            "height": 1080,
            "viewportWidth": 1920,
            "viewportHeight": 969,
            "colorDepth": 24,
            "pixelRatio": 2.0,
        },
        "locale": {
            "mode": "masked",
            "locale": "en-US",
            "languages": ["en-US", "en"],
            "timezoneId": "America/New_York",
        },
        "canvas": {"mode": "noise", "noiseSeed": 120020},
        "audio": {"mode": "noise", "noiseSeed": 120021},
        "webgl": {
            "mode": "masked",
            "vendor": "Google Inc. (Apple)",
            "renderer": "ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)",
            "noiseSeed": 120022,
        },
        "webrtc": {"mode": "masked", "policy": "disableNonProxiedUdp"},
        # The new v2 surfaces start inert in every curated preset. They are
        # validated at import time and must be warning-free, so a hardened default
        # here would fail the whole module rather than the one preset.
        "geolocation": {"mode": "real", "permission": "prompt"},
        "mediaDevices": {"mode": "real"},
        "ports": {"mode": "real"},
    },
    "ubuntu-linux-chrome-120": {
        "identityVersion": IDENTITY_VERSION,
        "label": "Ubuntu Linux Chrome 120",
        "presetId": "ubuntu-linux-chrome-120",
        "browser": {
            "mode": "masked",
            "userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "clientHints": {
                "platform": "Linux",
                "platformVersion": "",
                "architecture": "x86",
                "mobile": False,
            },
        },
        "navigator": {
            "mode": "masked",
            "platform": "Linux x86_64",
            "hardwareConcurrency": 8,
            "deviceMemory": 8,
            "uaPlatform": "Linux",
            "uaPlatformVersion": "",
            "uaArchitecture": "x86",
            "uaMobile": False,
        },
        "screen": {
            "mode": "masked",
            "width": 1920,
            "height": 1080,
            "viewportWidth": 1920,
            "viewportHeight": 1032,
            "colorDepth": 24,
            "pixelRatio": 1.0,
        },
        "locale": {
            "mode": "masked",
            "locale": "en-US",
            "languages": ["en-US", "en"],
            "timezoneId": "America/New_York",
        },
        "canvas": {"mode": "noise", "noiseSeed": 120030},
        "audio": {"mode": "noise", "noiseSeed": 120031},
        "webgl": {
            "mode": "masked",
            "vendor": "Google Inc. (Intel)",
            "renderer": "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
            "noiseSeed": 120032,
        },
        "webrtc": {"mode": "masked", "policy": "disableNonProxiedUdp"},
        # The new v2 surfaces start inert in every curated preset. They are
        # validated at import time and must be warning-free, so a hardened default
        # here would fail the whole module rather than the one preset.
        "geolocation": {"mode": "real", "permission": "prompt"},
        "mediaDevices": {"mode": "real"},
        "ports": {"mode": "real"},
    },
}


IDENTITY_PRESETS = CURATED_PRESETS


def curated_preset(preset_id: str) -> JsonObject:
    """Return a deep copy of a curated desktop Chromium identity preset."""
    if not isinstance(preset_id, str) or preset_id not in CURATED_PRESETS:
        raise SidecarError(
            code=IDENTITY_PRESET_NOT_FOUND,
            message="Identity preset was not found.",
        )
    return copy.deepcopy(CURATED_PRESETS[preset_id])


def normalize_identity(identity: Any) -> JsonObject:
    """Validate and return a normalized JSON-safe identity v1 object.

    Hard schema failures raise recoverable ``SidecarError`` instances before a
    caller can persist the payload. Suspicious but valid combinations are not
    errors; callers inspect them through ``warnings_for_identity``.
    """
    return _normalize_identity(identity, preset_ids=set(CURATED_PRESETS))


def validate_identity(identity: Any) -> JsonObject:
    """Validate a sidecar identity and return its normalized representation."""
    return normalize_identity(identity)


def warnings_for_identity(identity: Any) -> list[JsonObject]:
    """Return stable JSON-safe warnings for suspicious-but-saveable identities."""
    normalized = normalize_identity(identity)
    return [warning.to_dict() for warning in _warnings_for_normalized_identity(normalized)]


def validate_curated_presets(
    presets: Optional[Mapping[str, Any]] = None,
) -> Dict[str, JsonObject]:
    """Validate a curated preset table and require every preset to be warning-free."""
    table = CURATED_PRESETS if presets is None else presets
    if not isinstance(table, Mapping):
        _raise_invalid("Curated identity presets must be a JSON object.")

    preset_ids = set()
    for preset_id in table.keys():
        if not isinstance(preset_id, str) or not preset_id.strip() or len(preset_id) > MAX_SHORT_STRING_LENGTH:
            _raise_invalid("Curated identity preset ids must be short non-empty strings.")
        preset_ids.add(preset_id)

    normalized: Dict[str, JsonObject] = {}
    for preset_id, identity in table.items():
        preset = _normalize_identity(identity, preset_ids=preset_ids)
        if preset.get("presetId") != preset_id:
            _raise_invalid("Curated identity preset id must match its payload presetId.")
        warnings = _warnings_for_normalized_identity(preset)
        if warnings:
            _raise_invalid("Curated identity presets must not produce warnings.")
        normalized[preset_id] = preset
    return normalized


def describe_surfaces() -> JsonObject:
    """The identity contract, as data the UI can build a form from.

    The frontend keeps its own descriptor table -- it needs labels, help text and
    control kinds this module has no business owning. What it must not do is
    disagree about which surfaces exist or what their bounds are, so it compares
    itself against this and fails its own test when the two drift apart.
    """
    return {
        "identityVersion": IDENTITY_VERSION,
        "surfaces": [
            {
                "id": surface,
                "modes": sorted(SUPPORTED_MODES_BY_SURFACE[surface]),
                "fields": _describe_surface_fields(surface),
            }
            for surface in REQUIRED_SURFACES
        ],
    }


def _describe_surface_fields(surface: str) -> list[JsonObject]:
    def field(name: str, kind: str, **bounds: Any) -> JsonObject:
        return {"name": name, "type": kind, **bounds}

    if surface == "browser":
        return [field("userAgent", "text", maxLength=MAX_STRING_LENGTH, required=True)]
    if surface == "navigator":
        return [
            field("platform", "text", maxLength=MAX_SHORT_STRING_LENGTH, required=True),
            field("hardwareConcurrency", "integer", min=1, max=MAX_HARDWARE_CONCURRENCY, required=True),
            field("deviceMemory", "number", min=0.25, max=MAX_DEVICE_MEMORY, required=True),
        ]
    if surface == "screen":
        return [
            field(name, "integer", min=1, max=MAX_SCREEN_DIMENSION, required=True)
            for name in ("width", "height", "viewportWidth", "viewportHeight")
        ] + [
            field("colorDepth", "integer", min=1, max=64, required=True),
            field("pixelRatio", "number", min=0.25, max=8.0, required=True),
        ]
    if surface == "locale":
        return [
            field("locale", "text", maxLength=MAX_LANGUAGE_LENGTH, required=True),
            field("languages", "list", maxItems=MAX_LANGUAGE_COUNT, required=True),
            field("timezoneId", "text", maxLength=MAX_SHORT_STRING_LENGTH, required=True),
        ]
    if surface in {"canvas", "audio"}:
        return [field("noiseSeed", "integer", min=0, max=MAX_NOISE_SEED, required=True)]
    if surface == "webgl":
        return [
            field("vendor", "text", maxLength=MAX_SHORT_STRING_LENGTH, required=True),
            field("renderer", "text", maxLength=MAX_STRING_LENGTH, required=True),
            field("noiseSeed", "integer", min=0, max=MAX_NOISE_SEED, required=False),
        ]
    if surface == "webrtc":
        return [field("policy", "enum", options=sorted(_WEBRTC_POLICIES), required=True)]
    if surface == "geolocation":
        return [
            field("permission", "enum", options=sorted(_GEOLOCATION_PERMISSIONS), required=True),
            field("latitude", "number", min=-90.0, max=90.0, required=True),
            field("longitude", "number", min=-180.0, max=180.0, required=True),
            field("accuracy", "integer", min=MIN_GEOLOCATION_ACCURACY_METERS, max=MAX_GEOLOCATION_ACCURACY_METERS, required=True),
            field("altitude", "number", min=MIN_ALTITUDE_METERS, max=MAX_ALTITUDE_METERS, required=False),
        ]
    if surface == "mediaDevices":
        return [
            field("videoInputs", "integer", min=0, max=MAX_MEDIA_VIDEO_INPUTS, required=True),
            field("audioInputs", "integer", min=1, max=MAX_MEDIA_AUDIO_INPUTS, required=True),
            field("audioOutputs", "integer", min=1, max=MAX_MEDIA_AUDIO_OUTPUTS, required=True),
            field("noiseSeed", "integer", min=0, max=MAX_NOISE_SEED, required=False),
        ]
    if surface == "ports":
        return [field("allowedPorts", "list", maxItems=MAX_ALLOWED_PORTS, required=True)]
    return []


def _normalize_identity(identity: Any, *, preset_ids: Set[str]) -> JsonObject:
    if not isinstance(identity, Mapping):
        _raise_invalid("Identity payload must be a JSON object.")

    unknown_root_fields = set(identity) - _ROOT_FIELDS
    if unknown_root_fields:
        _raise_invalid("Identity payload contains unknown fields.")

    version = identity.get("identityVersion")
    if type(version) is not int or version not in SUPPORTED_IDENTITY_VERSIONS:
        _raise_invalid("Identity version is required and must be 1 or 2.")

    label = _require_string(identity.get("label"), "label", max_length=MAX_LABEL_LENGTH)
    preset_id = identity.get("presetId")
    if preset_id is not None:
        if not isinstance(preset_id, str) or not preset_id.strip() or len(preset_id) > MAX_SHORT_STRING_LENGTH:
            _raise_invalid("Identity presetId must be null or a short string.")
        if preset_id not in preset_ids:
            raise SidecarError(
                code=IDENTITY_PRESET_NOT_FOUND,
                message="Identity preset was not found.",
            )

    normalized: JsonObject = {
        "identityVersion": IDENTITY_VERSION,
        "label": label,
        "presetId": preset_id,
    }
    for surface in REQUIRED_SURFACES:
        if surface not in identity:
            if version < IDENTITY_VERSION and surface in _SURFACES_ADDED_IN_V2:
                # Absent because this identity predates the surface, not because
                # it is malformed. Starting it inert leaves behaviour unchanged.
                normalized[surface] = dict(DEFAULT_REAL_IDENTITY[surface])
                continue
            _raise_invalid(f"Identity surface '{surface}' is required.")
        normalized[surface] = _normalize_surface(surface, identity[surface])
    return normalized


def _normalize_surface(surface: str, raw_surface: Any) -> JsonObject:
    if not isinstance(raw_surface, Mapping):
        _raise_invalid(f"Identity surface '{surface}' must be an object.")

    mode = raw_surface.get("mode")
    if not isinstance(mode, str) or not mode:
        _raise_invalid(f"Identity surface '{surface}' requires a mode.")
    if mode not in SUPPORTED_MODES_BY_SURFACE[surface]:
        raise SidecarError(
            code=IDENTITY_UNSUPPORTED_MODE,
            message=f"Identity surface '{surface}' does not support mode '{mode}'.",
        )

    if surface == "browser":
        return _normalize_browser(raw_surface, mode)
    if surface == "navigator":
        return _normalize_navigator(raw_surface, mode)
    if surface == "screen":
        return _normalize_screen(raw_surface, mode)
    if surface == "locale":
        return _normalize_locale(raw_surface, mode)
    if surface in {"canvas", "audio"}:
        return _normalize_noise_surface(surface, raw_surface, mode)
    if surface == "webgl":
        return _normalize_webgl(raw_surface, mode)
    if surface == "webrtc":
        return _normalize_webrtc(raw_surface, mode)
    if surface == "geolocation":
        return _normalize_geolocation(raw_surface, mode)
    if surface == "mediaDevices":
        return _normalize_media_devices(raw_surface, mode)
    if surface == "ports":
        return _normalize_ports(raw_surface, mode)

    _raise_invalid("Identity payload contains an unknown surface.")


def _normalize_browser(raw_surface: Mapping[str, Any], mode: str) -> JsonObject:
    if mode == "real":
        _ensure_keys(raw_surface, allowed={"mode"}, required={"mode"}, context="browser")
        return {"mode": "real"}

    _ensure_keys(raw_surface, allowed={"mode", "userAgent", "clientHints"}, required={"mode", "userAgent"}, context="browser")
    normalized: JsonObject = {
        "mode": mode,
        "userAgent": _require_string(raw_surface.get("userAgent"), "browser.userAgent", max_length=MAX_STRING_LENGTH),
    }
    if "clientHints" in raw_surface:
        normalized["clientHints"] = _normalize_client_hints(raw_surface["clientHints"])
    return normalized


def _normalize_client_hints(value: Any) -> JsonObject:
    if not isinstance(value, Mapping):
        _raise_invalid("browser.clientHints must be an object when provided.")
    _ensure_keys(value, allowed=_CLIENT_HINT_FIELDS, required=set(), context="browser.clientHints")
    normalized: JsonObject = {}
    for key in ("platform", "platformVersion", "architecture", "bitness", "model"):
        if key in value:
            normalized[key] = _require_string(value[key], f"browser.clientHints.{key}", max_length=MAX_SHORT_STRING_LENGTH, allow_empty=(key in {"platformVersion", "model"}))
    if "mobile" in value:
        if not isinstance(value["mobile"], bool):
            _raise_invalid("browser.clientHints.mobile must be a boolean.")
        normalized["mobile"] = value["mobile"]
    return normalized


def _normalize_navigator(raw_surface: Mapping[str, Any], mode: str) -> JsonObject:
    if mode == "real":
        _ensure_keys(raw_surface, allowed={"mode"}, required={"mode"}, context="navigator")
        return {"mode": "real"}

    required = {
        "mode",
        "platform",
        "hardwareConcurrency",
        "deviceMemory",
        "uaPlatform",
        "uaPlatformVersion",
        "uaArchitecture",
        "uaMobile",
    }
    _ensure_keys(raw_surface, allowed=required, required=required, context="navigator")
    if not isinstance(raw_surface.get("uaMobile"), bool):
        _raise_invalid("navigator.uaMobile must be a boolean.")
    return {
        "mode": mode,
        "platform": _require_string(raw_surface.get("platform"), "navigator.platform", max_length=MAX_SHORT_STRING_LENGTH),
        "hardwareConcurrency": _require_int(raw_surface.get("hardwareConcurrency"), "navigator.hardwareConcurrency", min_value=1, max_value=MAX_HARDWARE_CONCURRENCY),
        "deviceMemory": _require_number(raw_surface.get("deviceMemory"), "navigator.deviceMemory", min_value=0.25, max_value=MAX_DEVICE_MEMORY),
        "uaPlatform": _require_string(raw_surface.get("uaPlatform"), "navigator.uaPlatform", max_length=MAX_SHORT_STRING_LENGTH),
        "uaPlatformVersion": _require_string(raw_surface.get("uaPlatformVersion"), "navigator.uaPlatformVersion", max_length=MAX_SHORT_STRING_LENGTH, allow_empty=True),
        "uaArchitecture": _require_string(raw_surface.get("uaArchitecture"), "navigator.uaArchitecture", max_length=MAX_SHORT_STRING_LENGTH),
        "uaMobile": raw_surface["uaMobile"],
    }


def _normalize_screen(raw_surface: Mapping[str, Any], mode: str) -> JsonObject:
    if mode == "real":
        _ensure_keys(raw_surface, allowed={"mode"}, required={"mode"}, context="screen")
        return {"mode": "real"}

    required = {"mode", "width", "height", "viewportWidth", "viewportHeight", "colorDepth", "pixelRatio"}
    _ensure_keys(raw_surface, allowed=required, required=required, context="screen")
    return {
        "mode": mode,
        "width": _require_int(raw_surface.get("width"), "screen.width", min_value=1, max_value=MAX_SCREEN_DIMENSION),
        "height": _require_int(raw_surface.get("height"), "screen.height", min_value=1, max_value=MAX_SCREEN_DIMENSION),
        "viewportWidth": _require_int(raw_surface.get("viewportWidth"), "screen.viewportWidth", min_value=1, max_value=MAX_SCREEN_DIMENSION),
        "viewportHeight": _require_int(raw_surface.get("viewportHeight"), "screen.viewportHeight", min_value=1, max_value=MAX_SCREEN_DIMENSION),
        "colorDepth": _require_int(raw_surface.get("colorDepth"), "screen.colorDepth", min_value=1, max_value=64),
        "pixelRatio": _require_number(raw_surface.get("pixelRatio"), "screen.pixelRatio", min_value=0.25, max_value=8.0),
    }


def _normalize_locale(raw_surface: Mapping[str, Any], mode: str) -> JsonObject:
    if mode == "real":
        _ensure_keys(raw_surface, allowed={"mode"}, required={"mode"}, context="locale")
        return {"mode": "real"}

    required = {"mode", "locale", "languages", "timezoneId"}
    _ensure_keys(raw_surface, allowed=required, required=required, context="locale")
    locale = _require_language_tag(raw_surface.get("locale"), "locale.locale")
    timezone_id = _require_timezone(raw_surface.get("timezoneId"), "locale.timezoneId")
    languages = _require_languages(raw_surface.get("languages"))
    return {"mode": mode, "locale": locale, "languages": languages, "timezoneId": timezone_id}


def _normalize_noise_surface(surface: str, raw_surface: Mapping[str, Any], mode: str) -> JsonObject:
    if mode == "real":
        _ensure_keys(raw_surface, allowed={"mode"}, required={"mode"}, context=surface)
        return {"mode": "real"}

    _ensure_keys(raw_surface, allowed={"mode", "noiseSeed"}, required={"mode", "noiseSeed"}, context=surface)
    return {
        "mode": "noise",
        "noiseSeed": _require_noise_seed(raw_surface.get("noiseSeed"), f"{surface}.noiseSeed"),
    }


def _normalize_webgl(raw_surface: Mapping[str, Any], mode: str) -> JsonObject:
    if mode == "real":
        _ensure_keys(raw_surface, allowed={"mode"}, required={"mode"}, context="webgl")
        return {"mode": "real"}

    _ensure_keys(raw_surface, allowed={"mode", "vendor", "renderer", "noiseSeed"}, required={"mode", "vendor", "renderer"}, context="webgl")
    normalized: JsonObject = {
        "mode": mode,
        "vendor": _require_string(raw_surface.get("vendor"), "webgl.vendor", max_length=MAX_STRING_LENGTH),
        "renderer": _require_string(raw_surface.get("renderer"), "webgl.renderer", max_length=MAX_STRING_LENGTH),
    }
    if "noiseSeed" in raw_surface:
        normalized["noiseSeed"] = _require_noise_seed(raw_surface.get("noiseSeed"), "webgl.noiseSeed")
    return normalized


def _normalize_webrtc(raw_surface: Mapping[str, Any], mode: str) -> JsonObject:
    _ensure_keys(raw_surface, allowed={"mode", "policy"}, required={"mode", "policy"}, context="webrtc")
    policy = raw_surface.get("policy")
    if not isinstance(policy, str) or policy not in _WEBRTC_POLICIES:
        _raise_invalid("webrtc.policy must be one of real, disableNonProxiedUdp, or block.")
    if mode == "real" and policy != "real":
        _raise_invalid("webrtc mode real requires policy real.")
    return {"mode": mode, "policy": policy}


def _normalize_geolocation(raw_surface: Mapping[str, Any], mode: str) -> JsonObject:
    """Validate the geolocation permission and, when custom, the fixed position.

    The permission is present in both modes: a profile that reports its real
    position still needs to say whether the page may ask for it, and "block"
    with no coordinates is a perfectly ordinary configuration.
    """
    permission = raw_surface.get("permission", "prompt")
    if permission not in _GEOLOCATION_PERMISSIONS:
        _raise_invalid("Identity geolocation permission must be prompt, allow, or block.")

    if mode == "real":
        _ensure_keys(raw_surface, allowed={"mode", "permission"}, required={"mode", "permission"}, context="geolocation")
        return {"mode": mode, "permission": permission}

    _ensure_keys(
        raw_surface,
        allowed={"mode", "permission", "latitude", "longitude", "accuracy", "altitude"},
        required={"mode", "latitude", "longitude", "accuracy"},
        context="geolocation",
    )
    latitude = _require_rounded_coordinate(raw_surface.get("latitude"), "latitude", limit=90.0)
    longitude = _require_rounded_coordinate(raw_surface.get("longitude"), "longitude", limit=180.0)
    accuracy = _require_int(raw_surface.get("accuracy"), "geolocation.accuracy", min_value=MIN_GEOLOCATION_ACCURACY_METERS, max_value=MAX_GEOLOCATION_ACCURACY_METERS)
    altitude = raw_surface.get("altitude")
    if altitude is not None:
        altitude = _require_rounded_number(
            altitude,
            "geolocation.altitude",
            minimum=MIN_ALTITUDE_METERS,
            maximum=MAX_ALTITUDE_METERS,
        )
    return {
        "mode": mode,
        "permission": permission,
        "latitude": latitude,
        "longitude": longitude,
        "accuracy": accuracy,
        "altitude": altitude,
    }


def _normalize_media_devices(raw_surface: Mapping[str, Any], mode: str) -> JsonObject:
    if mode == "real":
        _ensure_keys(raw_surface, allowed={"mode"}, required={"mode"}, context="mediaDevices")
        return {"mode": mode}
    if mode == "masked":
        _ensure_keys(raw_surface, allowed={"mode", "noiseSeed"}, required={"mode", "noiseSeed"}, context="mediaDevices")
        return {
            "mode": mode,
            "noiseSeed": _require_int(raw_surface.get("noiseSeed"), "mediaDevices.noiseSeed", min_value=0, max_value=MAX_NOISE_SEED
            ),
        }

    _ensure_keys(raw_surface, allowed={"mode", "videoInputs", "audioInputs", "audioOutputs"}, required={"mode", "videoInputs", "audioInputs", "audioOutputs"}, context="mediaDevices")
    video_inputs = _require_int(raw_surface.get("videoInputs"), "mediaDevices.videoInputs", min_value=0, max_value=MAX_MEDIA_VIDEO_INPUTS
    )
    audio_inputs = _require_int(raw_surface.get("audioInputs"), "mediaDevices.audioInputs", min_value=1, max_value=MAX_MEDIA_AUDIO_INPUTS
    )
    audio_outputs = _require_int(raw_surface.get("audioOutputs"), "mediaDevices.audioOutputs", min_value=1, max_value=MAX_MEDIA_AUDIO_OUTPUTS
    )
    return {
        "mode": mode,
        "videoInputs": video_inputs,
        "audioInputs": audio_inputs,
        "audioOutputs": audio_outputs,
    }


def _normalize_ports(raw_surface: Mapping[str, Any], mode: str) -> JsonObject:
    if mode in {"real", "masked"}:
        _ensure_keys(raw_surface, allowed={"mode"}, required={"mode"}, context="ports")
        return {"mode": mode}

    _ensure_keys(raw_surface, allowed={"mode", "allowedPorts"}, required={"mode", "allowedPorts"}, context="ports")
    raw_ports = raw_surface.get("allowedPorts")
    if not isinstance(raw_ports, list) or len(raw_ports) > MAX_ALLOWED_PORTS:
        _raise_invalid(f"Identity ports.allowedPorts must be a list of at most {MAX_ALLOWED_PORTS} ports.")
    ports: list[int] = []
    for candidate in raw_ports:
        port = _require_int(candidate, "ports.allowedPorts", min_value=1, max_value=65535)
        if port not in ports:
            ports.append(port)
    return {"mode": mode, "allowedPorts": sorted(ports)}


def _require_rounded_coordinate(value: Any, label: str, *, limit: float) -> float:
    return _require_rounded_number(value, f"geolocation.{label}", minimum=-limit, maximum=limit)


def _require_rounded_number(value: Any, label: str, *, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _raise_invalid(f"Identity {label} must be a number.")
    number = float(value)
    if not math.isfinite(number) or number < minimum or number > maximum:
        _raise_invalid(f"Identity {label} must be between {minimum} and {maximum}.")
    return round(number, GEOLOCATION_COORDINATE_DECIMALS)


def _warnings_for_normalized_identity(identity: Mapping[str, Any]) -> list[IdentityWarning]:
    warnings: list[IdentityWarning] = []
    browser = identity.get("browser", {})
    navigator = identity.get("navigator", {})
    screen = identity.get("screen", {})
    locale = identity.get("locale", {})
    webgl = identity.get("webgl", {})

    if screen.get("mode") != "real" and _is_desktop_platform(navigator) and screen.get("width", 0) < screen.get("height", 0):
        warnings.append(
            IdentityWarning(
                code="IDENTITY_DESKTOP_PORTRAIT_SCREEN",
                message="Desktop identity uses a portrait screen orientation, which is unusual.",
                surface="screen",
                path="screen.width",
            )
        )

    if screen.get("mode") != "real":
        if screen.get("viewportWidth", 0) > screen.get("width", 0) or screen.get("viewportHeight", 0) > screen.get("height", 0):
            warnings.append(
                IdentityWarning(
                    code="IDENTITY_VIEWPORT_EXCEEDS_SCREEN",
                    message="Viewport dimensions exceed screen dimensions.",
                    surface="screen",
                    path="screen.viewportWidth",
                )
            )

    ua_family = _user_agent_family(browser.get("userAgent"))
    if ua_family is not None and navigator.get("mode") != "real":
        nav_platform = str(navigator.get("platform", ""))
        nav_ua_platform = str(navigator.get("uaPlatform", ""))
        if not _navigator_matches_ua_family(ua_family, nav_platform, nav_ua_platform):
            warnings.append(
                IdentityWarning(
                    code="IDENTITY_UA_PLATFORM_MISMATCH",
                    message="User-Agent platform does not match navigator platform metadata.",
                    surface="navigator",
                    path="navigator.platform",
                )
            )

    ua_mobile = _user_agent_is_mobile(browser.get("userAgent"))
    nav_mobile = navigator.get("uaMobile") if navigator.get("mode") != "real" else None
    hint_mobile = browser.get("clientHints", {}).get("mobile") if isinstance(browser.get("clientHints"), Mapping) else None
    if ua_mobile is not None and (nav_mobile is not None or hint_mobile is not None):
        if (nav_mobile is not None and nav_mobile != ua_mobile) or (hint_mobile is not None and hint_mobile != ua_mobile):
            warnings.append(
                IdentityWarning(
                    code="IDENTITY_MOBILE_FLAG_MISMATCH",
                    message="Mobile flags do not match the User-Agent mobility signal.",
                    surface="navigator",
                    path="navigator.uaMobile",
                )
            )

    if navigator.get("mode") != "real":
        cpu_count = navigator.get("hardwareConcurrency")
        if isinstance(cpu_count, int) and cpu_count not in _COMMON_CPU_COUNTS:
            warnings.append(
                IdentityWarning(
                    code="IDENTITY_UNUSUAL_CPU",
                    message="Hardware concurrency is valid but uncommon for desktop Chromium.",
                    surface="navigator",
                    path="navigator.hardwareConcurrency",
                )
            )

        device_memory = navigator.get("deviceMemory")
        if isinstance(device_memory, (int, float)) and device_memory not in _COMMON_DEVICE_MEMORY:
            warnings.append(
                IdentityWarning(
                    code="IDENTITY_UNUSUAL_DEVICE_MEMORY",
                    message="Device memory is valid but uncommon for desktop Chromium.",
                    surface="navigator",
                    path="navigator.deviceMemory",
                )
            )

    _append_client_hint_warnings(warnings, browser, navigator)
    _append_locale_warnings(warnings, locale)
    _append_noise_seed_warnings(warnings, identity)
    _append_webgl_os_warning(warnings, browser, navigator, webgl)
    _append_cross_surface_warnings(warnings, identity)

    return warnings


# Rough centre of each IANA region, used only to notice a configured position on
# the wrong continent. Deliberately coarse: the point is to catch a profile
# claiming Warsaw with a Los Angeles timezone, not to geocode.
_REGION_CENTRES: Dict[str, tuple[float, float]] = {
    "Africa": (0.0, 20.0),
    "America": (10.0, -80.0),
    "Antarctica": (-80.0, 0.0),
    "Asia": (35.0, 100.0),
    "Atlantic": (35.0, -30.0),
    "Australia": (-25.0, 135.0),
    "Europe": (50.0, 15.0),
    "Indian": (-20.0, 75.0),
    "Pacific": (-10.0, -160.0),
}
# Generous enough that a country on the edge of its region does not warn.
_REGION_MATCH_DEGREES = 75.0


def _append_cross_surface_warnings(warnings: list[IdentityWarning], identity: Mapping[str, Any]) -> None:
    """Flag combinations that are individually valid but implausible together.

    Masking is not monotonic. A profile claiming a Warsaw position with a Los
    Angeles timezone, or a camera on a platform that reports none, is *more*
    identifiable than one that masked nothing -- the inconsistency is itself the
    signal. These are warnings rather than errors because the sidecar cannot know
    the user's intent, only that the combination is unusual.
    """
    geolocation = identity.get("geolocation", {})
    locale = identity.get("locale", {})
    media = identity.get("mediaDevices", {})
    ports = identity.get("ports", {})

    if geolocation.get("mode") == "custom" and geolocation.get("permission") == "block":
        warnings.append(
            IdentityWarning(
                code="IDENTITY_GEOLOCATION_WITHOUT_PERMISSION",
                message="A fixed position is configured but pages are blocked from reading it.",
                surface="geolocation",
                path="geolocation.permission",
            )
        )

    if geolocation.get("mode") == "custom" and locale.get("mode") != "real":
        region = str(locale.get("timezoneId", "")).split("/", 1)[0]
        centre = _REGION_CENTRES.get(region)
        if centre is not None:
            latitude = float(geolocation.get("latitude", 0.0))
            longitude = float(geolocation.get("longitude", 0.0))
            if (
                abs(latitude - centre[0]) > _REGION_MATCH_DEGREES
                or abs(longitude - centre[1]) > _REGION_MATCH_DEGREES
            ):
                warnings.append(
                    IdentityWarning(
                        code="IDENTITY_GEOLOCATION_TIMEZONE_MISMATCH",
                        message="The configured position is far from the region of the configured timezone.",
                        surface="geolocation",
                        path="geolocation.latitude",
                    )
                )

    if media.get("mode") == "custom":
        video = media.get("videoInputs", 0)
        audio_in = media.get("audioInputs", 0)
        if video > 0 and audio_in == 0:
            warnings.append(
                IdentityWarning(
                    code="IDENTITY_MEDIA_DEVICES_UNUSUAL",
                    message="A camera with no microphone is an unusual device combination.",
                    surface="mediaDevices",
                    path="mediaDevices.audioInputs",
                )
            )

    allowed_ports = ports.get("allowedPorts")
    if isinstance(allowed_ports, list) and len(allowed_ports) > 20:
        warnings.append(
            IdentityWarning(
                code="IDENTITY_PORTS_ALLOWLIST_BROAD",
                message="A large allowed-port list gives back much of what port masking hides.",
                surface="ports",
                path="ports.allowedPorts",
            )
        )


def _append_client_hint_warnings(
    warnings: list[IdentityWarning],
    browser: Mapping[str, Any],
    navigator: Mapping[str, Any],
) -> None:
    hints = browser.get("clientHints")
    if not isinstance(hints, Mapping) or navigator.get("mode") == "real":
        return

    hint_platform_family = _platform_family_from_value(hints.get("platform"))
    navigator_platform_family = _platform_family_from_value(navigator.get("uaPlatform")) or _platform_family_from_value(navigator.get("platform"))
    if hint_platform_family is not None and navigator_platform_family is not None and hint_platform_family != navigator_platform_family:
        warnings.append(
            IdentityWarning(
                code="IDENTITY_CLIENT_HINT_PLATFORM_MISMATCH",
                message="Browser Client Hint platform does not match navigator platform metadata.",
                surface="browser",
                path="browser.clientHints.platform",
            )
        )

    hint_platform_version = hints.get("platformVersion")
    navigator_platform_version = navigator.get("uaPlatformVersion")
    if _non_empty_string(hint_platform_version) and _non_empty_string(navigator_platform_version) and hint_platform_version != navigator_platform_version:
        warnings.append(
            IdentityWarning(
                code="IDENTITY_CLIENT_HINT_VERSION_MISMATCH",
                message="Browser Client Hint platform version does not match navigator platform version metadata.",
                surface="browser",
                path="browser.clientHints.platformVersion",
            )
        )

    hint_architecture = _architecture_family(hints.get("architecture"))
    navigator_architecture = _architecture_family(navigator.get("uaArchitecture"))
    if hint_architecture is not None and navigator_architecture is not None and hint_architecture != navigator_architecture:
        warnings.append(
            IdentityWarning(
                code="IDENTITY_CLIENT_HINT_ARCHITECTURE_MISMATCH",
                message="Browser Client Hint architecture does not match navigator architecture metadata.",
                surface="browser",
                path="browser.clientHints.architecture",
            )
        )

    hint_mobile = hints.get("mobile")
    navigator_mobile = navigator.get("uaMobile")
    if isinstance(hint_mobile, bool) and isinstance(navigator_mobile, bool) and hint_mobile != navigator_mobile:
        warnings.append(
            IdentityWarning(
                code="IDENTITY_CLIENT_HINT_MOBILE_MISMATCH",
                message="Browser Client Hint mobile flag does not match navigator mobile metadata.",
                surface="browser",
                path="browser.clientHints.mobile",
            )
        )


def _append_locale_warnings(warnings: list[IdentityWarning], locale: Mapping[str, Any]) -> None:
    if locale.get("mode") == "real":
        return

    locale_tag = locale.get("locale")
    languages = locale.get("languages")
    first_language = languages[0] if isinstance(languages, Sequence) and not isinstance(languages, (str, bytes)) and languages else None
    if _language_primary(locale_tag) is not None and _language_primary(first_language) is not None and _language_primary(locale_tag) != _language_primary(first_language):
        warnings.append(
            IdentityWarning(
                code="IDENTITY_LOCALE_LANGUAGE_MISMATCH",
                message="Locale primary language does not match the first navigator language.",
                surface="locale",
                path="locale.languages[0]",
            )
        )

    locale_region = _language_region(locale_tag)
    timezone_region = _timezone_region(locale.get("timezoneId"))
    expected_timezone_regions = _timezone_regions_for_locale_region(locale_region)
    if expected_timezone_regions and timezone_region is not None and timezone_region not in expected_timezone_regions:
        warnings.append(
            IdentityWarning(
                code="IDENTITY_TIMEZONE_REGION_MISMATCH",
                message="Timezone region is unusual for the locale region.",
                surface="locale",
                path="locale.timezoneId",
            )
        )


def _append_noise_seed_warnings(warnings: list[IdentityWarning], identity: Mapping[str, Any]) -> None:
    seen: dict[int, str] = {}
    for surface in ("canvas", "audio", "webgl"):
        surface_payload = identity.get(surface, {})
        if not isinstance(surface_payload, Mapping) or surface_payload.get("mode") == "real":
            continue
        seed = surface_payload.get("noiseSeed")
        if not isinstance(seed, int):
            continue
        if seed in seen:
            warnings.append(
                IdentityWarning(
                    code="IDENTITY_REUSED_NOISE_SEED",
                    message="Multiple fingerprinting surfaces reuse the same noise seed.",
                    surface=surface,
                    path=f"{surface}.noiseSeed",
                )
            )
            return
        seen[seed] = surface


def _append_webgl_os_warning(
    warnings: list[IdentityWarning],
    browser: Mapping[str, Any],
    navigator: Mapping[str, Any],
    webgl: Mapping[str, Any],
) -> None:
    if webgl.get("mode") == "real":
        return

    expected_family = (
        _user_agent_family(browser.get("userAgent"))
        or _platform_family_from_value(navigator.get("uaPlatform"))
        or _platform_family_from_value(navigator.get("platform"))
    )
    observed_family = _webgl_os_family(webgl)
    comparable_families = {"Windows", "macOS", "Linux"}
    if expected_family in comparable_families and observed_family in comparable_families and expected_family != observed_family:
        warnings.append(
            IdentityWarning(
                code="IDENTITY_WEBGL_OS_MISMATCH",
                message="WebGL vendor or renderer indicates a different OS family than browser and navigator metadata.",
                surface="webgl",
                path="webgl.renderer",
            )
        )


def _is_desktop_platform(navigator: Mapping[str, Any]) -> bool:
    if navigator.get("mode") == "real":
        return False
    platform = str(navigator.get("platform", ""))
    ua_platform = str(navigator.get("uaPlatform", ""))
    return platform in _COMMON_DESKTOP_PLATFORMS or ua_platform in {"Windows", "macOS", "Linux"}


def _user_agent_family(user_agent: Any) -> Optional[str]:
    if not isinstance(user_agent, str):
        return None
    ua = user_agent.lower()
    if "android" in ua:
        return "Android"
    if "windows" in ua:
        return "Windows"
    if "macintosh" in ua or "mac os x" in ua:
        return "macOS"
    if "linux" in ua or "x11" in ua:
        return "Linux"
    return None


def _user_agent_is_mobile(user_agent: Any) -> Optional[bool]:
    if not isinstance(user_agent, str):
        return None
    ua = user_agent.lower()
    if "mobile" in ua or "android" in ua or "iphone" in ua:
        return True
    if any(marker in ua for marker in ("windows", "macintosh", "x11", "linux")):
        return False
    return None


def _navigator_matches_ua_family(family: str, platform: str, ua_platform: str) -> bool:
    if family == "Windows":
        return platform == "Win32" and ua_platform == "Windows"
    if family == "macOS":
        return platform == "MacIntel" and ua_platform == "macOS"
    if family == "Linux":
        return platform.startswith("Linux") and ua_platform == "Linux"
    if family == "Android":
        return platform.startswith("Linux") and ua_platform == "Android"
    return True


def _platform_family_from_value(value: Any) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    normalized = value.strip().lower()
    if not normalized:
        return None
    if "android" in normalized:
        return "Android"
    if normalized in {"windows", "win32", "win64"} or normalized.startswith("win"):
        return "Windows"
    if normalized in {"macos", "macintel"} or "mac" in normalized:
        return "macOS"
    if normalized == "linux" or normalized.startswith("linux") or normalized == "x11":
        return "Linux"
    return None


def _architecture_family(value: Any) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    normalized = value.strip().lower().replace("-", "_")
    if normalized in {"x86", "x86_64", "x64", "amd64", "ia32"}:
        return "x86"
    if normalized in {"arm", "arm64", "aarch64"}:
        return "arm"
    return normalized or None


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _language_primary(value: Any) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    return value.split("-", 1)[0].lower()


def _language_region(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    parts = value.split("-")
    if len(parts) < 2:
        return None
    region = parts[1]
    if len(region) == 2 and region.isalpha():
        return region.upper()
    if len(region) == 3 and region.isdigit():
        return region
    return None


def _timezone_region(value: Any) -> Optional[str]:
    if not isinstance(value, str) or value == "UTC":
        return None
    return value.split("/", 1)[0]


def _timezone_regions_for_locale_region(region: Optional[str]) -> set[str]:
    if region is None:
        return set()
    america = {"AR", "BR", "CA", "CL", "CO", "MX", "PE", "US", "VE"}
    europe = {
        "AT",
        "BE",
        "CH",
        "CZ",
        "DE",
        "DK",
        "ES",
        "FI",
        "FR",
        "GB",
        "GR",
        "HU",
        "IE",
        "IT",
        "NL",
        "NO",
        "PL",
        "PT",
        "RO",
        "SE",
        "UA",
    }
    asia = {"CN", "HK", "ID", "IN", "JP", "KR", "MY", "PH", "SG", "TH", "TW", "VN"}
    africa = {"EG", "KE", "MA", "NG", "ZA"}
    if region in america:
        return {"America"}
    if region in europe:
        return {"Europe"}
    if region in asia:
        return {"Asia"}
    if region == "AU":
        return {"Australia"}
    if region == "NZ":
        return {"Pacific"}
    if region in africa:
        return {"Africa"}
    return set()


def _webgl_os_family(webgl: Mapping[str, Any]) -> Optional[str]:
    vendor = webgl.get("vendor")
    renderer = webgl.get("renderer")
    combined = " ".join(part for part in (vendor, renderer) if isinstance(part, str)).lower()
    if not combined:
        return None
    if "direct3d" in combined or "directx" in combined or " d3d" in combined:
        return "Windows"
    if "apple" in combined or "metal" in combined:
        return "macOS"
    if "mesa" in combined:
        return "Linux"
    return None


def _ensure_keys(
    value: Mapping[str, Any],
    *,
    allowed: Iterable[str],
    required: Iterable[str],
    context: str,
) -> None:
    allowed_set = set(allowed)
    required_set = set(required)
    unknown = set(value) - allowed_set
    missing = required_set - set(value)
    if unknown:
        _raise_invalid(f"{context} contains unknown fields.")
    if missing:
        _raise_invalid(f"{context} is missing required fields.")


def _require_string(
    value: Any,
    path: str,
    *,
    max_length: int,
    allow_empty: bool = False,
) -> str:
    if not isinstance(value, str):
        _raise_invalid(f"{path} must be a string.")
    if not allow_empty and not value:
        _raise_invalid(f"{path} must not be empty.")
    if len(value) > max_length or _contains_control_characters(value):
        _raise_invalid(f"{path} is outside supported bounds.")
    return value


def _require_language_tag(value: Any, path: str) -> str:
    language = _require_string(value, path, max_length=MAX_LANGUAGE_LENGTH)
    if not _LANGUAGE_RE.fullmatch(language):
        _raise_invalid(f"{path} must be a valid BCP47-like language tag.")
    return language


def _require_timezone(value: Any, path: str) -> str:
    timezone_id = _require_string(value, path, max_length=MAX_SHORT_STRING_LENGTH)
    if not _TIMEZONE_RE.fullmatch(timezone_id):
        _raise_invalid(f"{path} must be a valid IANA-style timezone id.")
    return timezone_id


def _require_languages(value: Any) -> list[str]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        _raise_invalid("locale.languages must be a list of language tags.")
    if not value or len(value) > MAX_LANGUAGE_COUNT:
        _raise_invalid("locale.languages is outside supported bounds.")
    return [_require_language_tag(item, "locale.languages[]") for item in value]


def _require_int(value: Any, path: str, *, min_value: int, max_value: int) -> int:
    if type(value) is not int:
        _raise_invalid(f"{path} must be an integer.")
    if value < min_value or value > max_value:
        _raise_invalid(f"{path} is outside supported bounds.")
    return value


def _require_number(value: Any, path: str, *, min_value: float, max_value: float) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        _raise_invalid(f"{path} must be a finite number.")
    if value < min_value or value > max_value:
        _raise_invalid(f"{path} is outside supported bounds.")
    return value


def _require_noise_seed(value: Any, path: str) -> int:
    return _require_int(value, path, min_value=0, max_value=MAX_NOISE_SEED)


def _contains_control_characters(value: str) -> bool:
    return any(ord(character) < 32 for character in value)


def _raise_invalid(message: str) -> None:
    raise SidecarError(
        code=IDENTITY_INVALID,
        message=message,
    )


CURATED_PRESETS = validate_curated_presets(CURATED_PRESETS)
IDENTITY_PRESETS = CURATED_PRESETS


__all__ = [
    "CURATED_PRESETS",
    "DEFAULT_REAL_IDENTITY",
    "IDENTITY_PRESETS",
    "IDENTITY_VERSION",
    "IdentityWarning",
    "MAX_LANGUAGE_COUNT",
    "MAX_LABEL_LENGTH",
    "MAX_NOISE_SEED",
    "SUPPORTED_MODES_BY_SURFACE",
    "curated_preset",
    "normalize_identity",
    "validate_curated_presets",
    "validate_identity",
    "warnings_for_identity",
]
