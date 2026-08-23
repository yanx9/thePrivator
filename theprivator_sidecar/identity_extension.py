"""Generate deterministic per-profile MV3 identity runtime extensions."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Union

from .protocol import IDENTITY_EXTENSION_FAILED, JsonObject, SidecarError

MANIFEST_NAME = "manifest.json"
CONFIG_SCRIPT_NAME = "identity_config.js"
PROTECTOR_SCRIPT_NAME = "identity_protector.js"
GENERATED_EXTENSIONS_DIR = "identity-extensions"
CONFIG_GLOBAL_NAME = "__THEPRIVATOR_IDENTITY_CONFIG__"
_SAFE_EXTENSION_MESSAGE = "Identity extension could not be prepared."

_ALLOWED_TOP_LEVEL = {
    "schemaVersion",
    "navigator",
    "locale",
    "screen",
    "canvas",
    "audio",
    "webgl",
    "webrtc",
    "geolocation",
    "mediaDevices",
    "ports",
}
_ALLOWED_NAVIGATOR = {"platform", "hardwareConcurrency", "deviceMemory", "userAgentData"}
_ALLOWED_USER_AGENT_DATA = {
    "platform",
    "platformVersion",
    "architecture",
    "mobile",
    "bitness",
    "model",
    "brands",
    "fullVersionList",
    "fullVersion",
    "wow64",
}
_REQUIRED_USER_AGENT_DATA = set(_ALLOWED_USER_AGENT_DATA)
_ALLOWED_LOCALE = {"locale", "languages", "timezoneId"}
_ALLOWED_SCREEN = {"width", "height", "viewportWidth", "viewportHeight", "colorDepth", "pixelRatio"}
_ALLOWED_NOISE = {"enabled", "noiseSeed"}
_ALLOWED_WEBGL = {"enabled", "vendor", "renderer", "noiseSeed"}
_ALLOWED_WEBRTC_POLICIES = {"disableNonProxiedUdp", "block"}
_ALLOWED_GEOLOCATION = {"permission", "latitude", "longitude", "accuracy", "altitude"}
_ALLOWED_MEDIA_DEVICES = {"seed", "videoInputs", "audioInputs", "audioOutputs"}
_ALLOWED_PORTS = {"mode", "allowedPorts"}
_FORBIDDEN_TEXT_MARKERS = (
    "DevToolsActivePort",
    "ws://",
    "wss://",
    "--remote-debugging-port",
    "debugPort",
    "Traceback",
)


@dataclass(frozen=True)
class IdentityExtensionArtifact:
    """Internal extension artifact metadata safe to summarize without config bodies."""

    extension_dir: Path
    profile_key: str
    files: list[str]

    def to_safe_dict(self) -> JsonObject:
        return {
            "profileKey": self.profile_key,
            "files": list(self.files),
        }


def runtime_identity_extension_root(store_root: Union[str, Path]) -> Path:
    """Return the app-owned generated extension root for a store root."""
    return Path(store_root) / "profile-store" / "runtime" / GENERATED_EXTENSIONS_DIR


def generate_identity_extension(
    extension_root: Union[str, Path],
    profile_id: str,
    plan_or_config: Any,
) -> IdentityExtensionArtifact:
    """Write a static MV3 extension from a runtime plan or extension config."""
    temp_dir: Path | None = None
    try:
        config = _extract_extension_config(plan_or_config)
        _validate_extension_config(config)
        profile_key = _profile_key(profile_id)
        root = Path(extension_root)
        root.mkdir(parents=True, exist_ok=True)
        target_dir = root / profile_key
        temp_dir = root / f".{profile_key}.{uuid.uuid4().hex}.tmp"
        _remove_path(temp_dir)
        temp_dir.mkdir(parents=False)

        _write_json(temp_dir / MANIFEST_NAME, _manifest())
        _write_text(temp_dir / CONFIG_SCRIPT_NAME, _config_script(config))
        _write_text(temp_dir / PROTECTOR_SCRIPT_NAME, _protector_script())
        validate_identity_extension(temp_dir)

        _remove_path(target_dir)
        os.replace(temp_dir, target_dir)
        temp_dir = None
        return IdentityExtensionArtifact(
            extension_dir=target_dir,
            profile_key=profile_key,
            files=[MANIFEST_NAME, CONFIG_SCRIPT_NAME, PROTECTOR_SCRIPT_NAME],
        )
    except SidecarError:
        _remove_path(temp_dir)
        raise
    except Exception as exc:
        _remove_path(temp_dir)
        raise _extension_error() from exc


def validate_identity_extension(extension_dir: Union[str, Path]) -> None:
    """Validate generated extension files before launch can consume them."""
    try:
        root = Path(extension_dir)
        if not root.is_dir():
            raise ValueError("extension directory is unavailable")
        manifest_path = root / MANIFEST_NAME
        config_path = root / CONFIG_SCRIPT_NAME
        protector_path = root / PROTECTOR_SCRIPT_NAME
        if not manifest_path.is_file() or not config_path.is_file() or not protector_path.is_file():
            raise ValueError("generated extension files are incomplete")

        with manifest_path.open("r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        if not isinstance(manifest, Mapping):
            raise ValueError("manifest must be an object")
        _validate_manifest(manifest)

        config_text = config_path.read_text(encoding="utf-8")
        protector_text = protector_path.read_text(encoding="utf-8")
        if CONFIG_GLOBAL_NAME not in config_text or "Object.freeze" not in config_text:
            raise ValueError("config script shape is invalid")
        if "fetch(" in config_text or "config.json" in config_text:
            raise ValueError("config script must not fetch async config")
        for required in ("Navigator.prototype", "Screen.prototype", "RTCPeerConnection"):
            if required not in protector_text:
                raise ValueError("protector script shape is invalid")
        _assert_no_forbidden_text(config_text)
        _assert_no_forbidden_text(protector_text)
    except SidecarError:
        raise
    except Exception as exc:
        raise _extension_error() from exc


def _extract_extension_config(plan_or_config: Any) -> JsonObject:
    if hasattr(plan_or_config, "extension_config"):
        raw_config = getattr(plan_or_config, "extension_config")
    else:
        raw_config = plan_or_config
    if not isinstance(raw_config, Mapping):
        raise _extension_error()
    return _json_copy(raw_config)


def _validate_extension_config(config: Mapping[str, Any]) -> None:
    if not config:
        raise _extension_error()
    _ensure_keys(config, _ALLOWED_TOP_LEVEL)
    if config.get("schemaVersion") != 2:
        raise _extension_error()
    if set(config) == {"schemaVersion"}:
        raise _extension_error()

    if "navigator" in config:
        navigator = _require_object(config["navigator"])
        _ensure_keys(navigator, _ALLOWED_NAVIGATOR)
        if not navigator:
            raise _extension_error()
        if "platform" in navigator:
            _require_string(navigator.get("platform"))
        if "hardwareConcurrency" in navigator:
            _require_int(navigator.get("hardwareConcurrency"), minimum=1, maximum=128)
        if "deviceMemory" in navigator:
            _require_number(navigator.get("deviceMemory"), minimum=0.25, maximum=128)
        if "userAgentData" in navigator:
            _validate_user_agent_data(_require_object(navigator.get("userAgentData")))

    if "locale" in config:
        locale = _require_object(config["locale"])
        _ensure_keys(locale, _ALLOWED_LOCALE)
        _require_string(locale.get("locale"))
        _require_string(locale.get("timezoneId"))
        languages = locale.get("languages")
        if not isinstance(languages, list) or not languages:
            raise _extension_error()
        for language in languages:
            _require_string(language)

    if "screen" in config:
        screen = _require_object(config["screen"])
        _ensure_keys(screen, _ALLOWED_SCREEN)
        for key in ("width", "height", "viewportWidth", "viewportHeight", "colorDepth"):
            _require_int(screen.get(key), minimum=1, maximum=10_000 if key != "colorDepth" else 64)
        _require_number(screen.get("pixelRatio"), minimum=0.25, maximum=8)

    for key in ("canvas", "audio"):
        if key in config:
            surface = _require_object(config[key])
            _ensure_keys(surface, _ALLOWED_NOISE)
            if surface.get("enabled") is not True:
                raise _extension_error()
            _require_int(surface.get("noiseSeed"), minimum=0, maximum=1_000_000)

    if "webgl" in config:
        webgl = _require_object(config["webgl"])
        _ensure_keys(webgl, _ALLOWED_WEBGL)
        if webgl.get("enabled") is not True:
            raise _extension_error()
        _require_string(webgl.get("vendor"))
        _require_string(webgl.get("renderer"))
        if "noiseSeed" in webgl:
            _require_int(webgl.get("noiseSeed"), minimum=0, maximum=1_000_000)

    if "webrtc" in config:
        webrtc = _require_object(config["webrtc"])
        _ensure_keys(webrtc, {"policy"})
        if webrtc.get("policy") not in _ALLOWED_WEBRTC_POLICIES:
            raise _extension_error()

    if "geolocation" in config:
        geolocation = _require_object(config["geolocation"])
        _ensure_keys(geolocation, _ALLOWED_GEOLOCATION)
        if geolocation.get("permission") not in {"prompt", "allow", "block"}:
            raise _extension_error()
        if "latitude" in geolocation:
            _require_number(geolocation.get("latitude"), minimum=-90, maximum=90)
            _require_number(geolocation.get("longitude"), minimum=-180, maximum=180)
            _require_int(geolocation.get("accuracy"), minimum=1, maximum=100_000)
            altitude = geolocation.get("altitude")
            if altitude is not None:
                _require_number(altitude, minimum=-1_000, maximum=100_000)

    if "mediaDevices" in config:
        media = _require_object(config["mediaDevices"])
        _ensure_keys(media, _ALLOWED_MEDIA_DEVICES)
        _require_int(media.get("seed"), minimum=0, maximum=1_000_000)
        _require_int(media.get("videoInputs"), minimum=0, maximum=1)
        _require_int(media.get("audioInputs"), minimum=1, maximum=4)
        _require_int(media.get("audioOutputs"), minimum=1, maximum=4)

    if "ports" in config:
        ports = _require_object(config["ports"])
        _ensure_keys(ports, _ALLOWED_PORTS)
        if ports.get("mode") not in {"masked", "custom"}:
            raise _extension_error()
        allowed_ports = ports.get("allowedPorts")
        if not isinstance(allowed_ports, list) or len(allowed_ports) > 50:
            raise _extension_error()
        for port in allowed_ports:
            _require_int(port, minimum=1, maximum=65535)

    _assert_no_forbidden_text(json.dumps(config, ensure_ascii=True, allow_nan=False, sort_keys=True))


def _validate_user_agent_data(user_agent_data: Mapping[str, Any]) -> None:
    _ensure_keys(user_agent_data, _ALLOWED_USER_AGENT_DATA)
    if not _REQUIRED_USER_AGENT_DATA.issubset(set(user_agent_data)):
        raise _extension_error()
    for key in ("platform", "platformVersion", "architecture", "bitness", "model", "fullVersion"):
        _require_string(user_agent_data[key], allow_empty=True)
    if not isinstance(user_agent_data.get("mobile"), bool):
        raise _extension_error()
    if not isinstance(user_agent_data.get("wow64"), bool):
        raise _extension_error()
    _validate_brand_list(user_agent_data.get("brands"))
    _validate_brand_list(user_agent_data.get("fullVersionList"))


def _validate_brand_list(value: Any) -> None:
    if not isinstance(value, list) or not value or len(value) > 8:
        raise _extension_error()
    for item in value:
        brand = _require_object(item)
        _ensure_keys(brand, {"brand", "version"})
        _require_string(brand.get("brand"))
        _require_string(brand.get("version"))


def _validate_manifest(manifest: Mapping[str, Any]) -> None:
    content_scripts = manifest.get("content_scripts")
    if manifest.get("manifest_version") != 3 or not isinstance(content_scripts, list) or len(content_scripts) != 1:
        raise _extension_error()
    script = content_scripts[0]
    if not isinstance(script, Mapping):
        raise _extension_error()
    if script.get("js") != [CONFIG_SCRIPT_NAME, PROTECTOR_SCRIPT_NAME]:
        raise _extension_error()
    if script.get("run_at") != "document_start" or script.get("world") != "MAIN":
        raise _extension_error()
    if script.get("matches") != ["<all_urls>"]:
        raise _extension_error()
    if script.get("all_frames") is not True or script.get("match_about_blank") is not True:
        raise _extension_error()


def _manifest() -> JsonObject:
    return {
        "manifest_version": 3,
        "name": "thePrivator Identity Runtime",
        "version": "1.0.0",
        "description": "Applies sidecar-generated identity overrides.",
        "content_scripts": [
            {
                "matches": ["<all_urls>"],
                "js": [CONFIG_SCRIPT_NAME, PROTECTOR_SCRIPT_NAME],
                "run_at": "document_start",
                "world": "MAIN",
                "all_frames": True,
                "match_about_blank": True,
                "match_origin_as_fallback": True,
            }
        ],
    }


def _config_script(config: Mapping[str, Any]) -> str:
    encoded = json.dumps(config, ensure_ascii=True, separators=(",", ":"), sort_keys=True, allow_nan=False)
    return "\n".join(
        [
            "(() => {",
            "  'use strict';",
            "  const deepFreeze = (value) => {",
            "    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;",
            "    Object.freeze(value);",
            "    for (const key of Object.keys(value)) deepFreeze(value[key]);",
            "    return value;",
            "  };",
            f"  const config = deepFreeze({encoded});",
            f"  Object.defineProperty(globalThis, '{CONFIG_GLOBAL_NAME}', {{",
            "    value: config,",
            "    enumerable: false,",
            "    configurable: false,",
            "    writable: false,",
            "  });",
            "})();",
            "",
        ]
    )


def _protector_script() -> str:
    return r"""
(() => {
  'use strict';

  const config = globalThis.__THEPRIVATOR_IDENTITY_CONFIG__ || {};
  const seededRandom = (seed) => {
    const x = Math.sin(Number(seed) || 0) * 10000;
    return x - Math.floor(x);
  };
  const maskFunction = (replacement, original) => {
    const nativeLike = typeof original === 'function' ? original : function () {};
    try {
      Object.defineProperty(replacement, 'toString', {
        value: () => Function.prototype.toString.call(nativeLike),
        configurable: true,
      });
    } catch (_) {}
    return replacement;
  };
  const overrideGetter = (owner, property, value) => {
    if (value === undefined || value === null || !owner) return;
    const descriptor = Object.getOwnPropertyDescriptor(owner, property);
    const original = descriptor && descriptor.get ? descriptor.get : function () { return value; };
    try {
      Object.defineProperty(owner, property, {
        get: maskFunction(function () { return value; }, original),
        configurable: true,
        enumerable: descriptor ? descriptor.enumerable : true,
      });
    } catch (_) {}
  };
  const copyBrands = (brands) => Object.freeze((Array.isArray(brands) ? brands : []).map((brand) => Object.freeze({
    brand: String((brand && brand.brand) || ''),
    version: String((brand && brand.version) || ''),
  })));

  const navigatorConfig = config.navigator || {};
  const navigatorPrototype = globalThis.Navigator && globalThis.Navigator.prototype;
  overrideGetter(navigatorPrototype, 'platform', navigatorConfig.platform);
  overrideGetter(navigatorPrototype, 'hardwareConcurrency', navigatorConfig.hardwareConcurrency);
  overrideGetter(navigatorPrototype, 'deviceMemory', navigatorConfig.deviceMemory);
  if (navigatorConfig.userAgentData) {
    const source = navigatorConfig.userAgentData;
    const mobile = Boolean(source.mobile);
    const platform = source.platform || '';
    const uaData = Object.freeze({
      brands: copyBrands(source.brands),
      mobile,
      platform,
      getHighEntropyValues: maskFunction(async function (hints) {
        const result = { brands: copyBrands(source.brands), mobile, platform };
        const requested = Array.isArray(hints) ? hints : [];
        for (const hint of requested) {
          if (hint === 'platform') result.platform = platform;
          if (hint === 'platformVersion') result.platformVersion = source.platformVersion || '';
          if (hint === 'architecture') result.architecture = source.architecture || '';
          if (hint === 'bitness') result.bitness = source.bitness || '';
          if (hint === 'model') result.model = source.model || '';
          if (hint === 'uaFullVersion') result.uaFullVersion = source.fullVersion || '';
          if (hint === 'fullVersion') result.fullVersion = source.fullVersion || '';
          if (hint === 'fullVersionList') result.fullVersionList = copyBrands(source.fullVersionList);
          if (hint === 'wow64') result.wow64 = Boolean(source.wow64);
        }
        return result;
      }, async function getHighEntropyValues() {}),
      toJSON: maskFunction(function () { return { brands: copyBrands(source.brands), mobile, platform }; }, function toJSON() {}),
    });
    overrideGetter(navigatorPrototype, 'userAgentData', uaData);
  }

  const localeConfig = config.locale || {};
  if (Array.isArray(localeConfig.languages)) {
    overrideGetter(navigatorPrototype, 'languages', Object.freeze([...localeConfig.languages]));
    overrideGetter(navigatorPrototype, 'language', localeConfig.languages[0]);
  }
  if (localeConfig.locale || localeConfig.timezoneId) {
    const originalResolvedOptions = globalThis.Intl && globalThis.Intl.DateTimeFormat && globalThis.Intl.DateTimeFormat.prototype && globalThis.Intl.DateTimeFormat.prototype.resolvedOptions;
    if (typeof originalResolvedOptions === 'function') {
      globalThis.Intl.DateTimeFormat.prototype.resolvedOptions = maskFunction(function (...args) {
        const result = originalResolvedOptions.apply(this, args);
        if (localeConfig.locale) result.locale = localeConfig.locale;
        if (localeConfig.timezoneId) result.timeZone = localeConfig.timezoneId;
        return result;
      }, originalResolvedOptions);
    }
  }

  const screenConfig = config.screen || {};
  const screenPrototype = globalThis.Screen && globalThis.Screen.prototype;
  const windowPrototype = globalThis.Window && globalThis.Window.prototype;
  overrideGetter(screenPrototype, 'width', screenConfig.width);
  overrideGetter(screenPrototype, 'height', screenConfig.height);
  overrideGetter(screenPrototype, 'availWidth', screenConfig.width);
  overrideGetter(screenPrototype, 'availHeight', screenConfig.height);
  overrideGetter(screenPrototype, 'colorDepth', screenConfig.colorDepth);
  overrideGetter(screenPrototype, 'pixelDepth', screenConfig.colorDepth);
  overrideGetter(windowPrototype, 'innerWidth', screenConfig.viewportWidth);
  overrideGetter(windowPrototype, 'innerHeight', screenConfig.viewportHeight);
  overrideGetter(windowPrototype, 'devicePixelRatio', screenConfig.pixelRatio);

  const canvasConfig = config.canvas || {};
  if (canvasConfig.enabled && globalThis.HTMLCanvasElement && globalThis.CanvasRenderingContext2D) {
    const seed = canvasConfig.noiseSeed || 1;
    const addNoise = (imageData, seedBase) => {
      if (!imageData || !imageData.data) return imageData;
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const noise = Math.floor(seededRandom(seedBase + i) * 5) - 2;
        data[i] = Math.max(0, Math.min(255, data[i] + noise));
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
      }
      return imageData;
    };
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    if (typeof originalGetImageData === 'function') {
      CanvasRenderingContext2D.prototype.getImageData = maskFunction(function (...args) {
        return addNoise(originalGetImageData.apply(this, args), seed);
      }, originalGetImageData);
    }
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    if (typeof originalToDataURL === 'function') {
      HTMLCanvasElement.prototype.toDataURL = maskFunction(function (...args) {
        const context = this.getContext && this.getContext('2d');
        if (context && typeof context.getImageData === 'function' && typeof context.putImageData === 'function') {
          try {
            const data = context.getImageData(0, 0, this.width, this.height);
            context.putImageData(addNoise(data, seed), 0, 0);
          } catch (_) {}
        }
        return originalToDataURL.apply(this, args);
      }, originalToDataURL);
    }
  }

  const webglConfig = config.webgl || {};
  const hookWebgl = (Constructor) => {
    if (!webglConfig.enabled || !Constructor || !Constructor.prototype) return;
    const originalGetParameter = Constructor.prototype.getParameter;
    if (typeof originalGetParameter === 'function') {
      Constructor.prototype.getParameter = maskFunction(function (parameter) {
        if ((parameter === 0x9245 || parameter === 0x1F00) && webglConfig.vendor) return webglConfig.vendor;
        if ((parameter === 0x9246 || parameter === 0x1F01) && webglConfig.renderer) return webglConfig.renderer;
        return originalGetParameter.call(this, parameter);
      }, originalGetParameter);
    }
    const originalReadPixels = Constructor.prototype.readPixels;
    if (typeof originalReadPixels === 'function') {
      Constructor.prototype.readPixels = maskFunction(function (...args) {
        const result = originalReadPixels.apply(this, args);
        const pixels = args[6];
        if (pixels && pixels.length && webglConfig.noiseSeed !== undefined) {
          for (let i = 0; i < pixels.length; i += 4) {
            const noise = Math.floor(seededRandom(webglConfig.noiseSeed + i) * 5) - 2;
            pixels[i] = Math.max(0, Math.min(255, pixels[i] + noise));
          }
        }
        return result;
      }, originalReadPixels);
    }
  };
  hookWebgl(globalThis.WebGLRenderingContext);
  hookWebgl(globalThis.WebGL2RenderingContext);

  const audioConfig = config.audio || {};
  if (audioConfig.enabled && globalThis.AnalyserNode && globalThis.AnalyserNode.prototype) {
    const seed = audioConfig.noiseSeed || 1;
    const addFloatNoise = (array) => {
      if (!array || typeof array.length !== 'number') return array;
      for (let i = 0; i < array.length; i += 1) {
        const base = Number.isFinite(array[i]) ? array[i] : -100;
        array[i] = base + ((seededRandom(seed + i) - 0.5) * 0.02);
      }
      return array;
    };
    const addByteNoise = (array) => {
      if (!array || typeof array.length !== 'number') return array;
      for (let i = 0; i < array.length; i += 1) {
        const noise = Math.floor(seededRandom(seed + i) * 5) - 2;
        array[i] = Math.max(0, Math.min(255, array[i] + noise));
      }
      return array;
    };
    const hookAnalyser = (methodName, mutator) => {
      const original = AnalyserNode.prototype[methodName];
      if (typeof original !== 'function') return;
      AnalyserNode.prototype[methodName] = maskFunction(function (array) {
        original.call(this, array);
        return mutator(array);
      }, original);
    };
    hookAnalyser('getFloatFrequencyData', addFloatNoise);
    hookAnalyser('getFloatTimeDomainData', addFloatNoise);
    hookAnalyser('getByteFrequencyData', addByteNoise);
  }

  const webrtcConfig = config.webrtc || {};
  if (webrtcConfig.policy === 'block') {
    const makeBlockedError = () => {
      if (typeof DOMException === 'function') return new DOMException('WebRTC unavailable', 'NotAllowedError');
      const error = new Error('WebRTC unavailable');
      error.name = 'NotAllowedError';
      return error;
    };
    const BlockedPeerConnection = maskFunction(function () { throw makeBlockedError(); }, globalThis.RTCPeerConnection);
    globalThis.RTCPeerConnection = BlockedPeerConnection;
    globalThis.webkitRTCPeerConnection = BlockedPeerConnection;
  } else if (webrtcConfig.policy === 'disableNonProxiedUdp' && globalThis.RTCPeerConnection) {
    const OriginalPeerConnection = globalThis.RTCPeerConnection;
    globalThis.RTCPeerConnection = maskFunction(function (configuration, ...rest) {
      const nextConfiguration = Object.assign({}, configuration || {}, { iceTransportPolicy: 'relay' });
      return new OriginalPeerConnection(nextConfiguration, ...rest);
    }, OriginalPeerConnection);
  }

  const geolocationConfig = config.geolocation;
  if (geolocationConfig && navigator.geolocation) {
    const permission = geolocationConfig.permission || 'prompt';
    const hasFixedPosition = typeof geolocationConfig.latitude === 'number';
    const makeDeniedError = () => {
      const error = new Error('User denied Geolocation');
      error.code = 1;
      error.PERMISSION_DENIED = 1;
      return error;
    };
    const makePosition = () => ({
      coords: {
        latitude: geolocationConfig.latitude,
        longitude: geolocationConfig.longitude,
        accuracy: geolocationConfig.accuracy,
        altitude: geolocationConfig.altitude === undefined ? null : geolocationConfig.altitude,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    });

    const originalGetCurrent = navigator.geolocation.getCurrentPosition;
    const originalWatch = navigator.geolocation.watchPosition;
    navigator.geolocation.getCurrentPosition = maskFunction(function (onSuccess, onError, options) {
      if (permission === 'block') {
        if (typeof onError === 'function') onError(makeDeniedError());
        return undefined;
      }
      if (permission === 'allow' && hasFixedPosition) {
        if (typeof onSuccess === 'function') onSuccess(makePosition());
        return undefined;
      }
      return originalGetCurrent.call(navigator.geolocation, onSuccess, onError, options);
    }, originalGetCurrent);

    navigator.geolocation.watchPosition = maskFunction(function (onSuccess, onError, options) {
      if (permission === 'block') {
        if (typeof onError === 'function') onError(makeDeniedError());
        return 0;
      }
      if (permission === 'allow' && hasFixedPosition) {
        if (typeof onSuccess === 'function') onSuccess(makePosition());
        return 0;
      }
      return originalWatch.call(navigator.geolocation, onSuccess, onError, options);
    }, originalWatch);

    if (navigator.permissions && navigator.permissions.query) {
      const originalQuery = navigator.permissions.query;
      navigator.permissions.query = maskFunction(function (descriptor) {
        if (descriptor && descriptor.name === 'geolocation' && permission !== 'prompt') {
          return Promise.resolve({
            state: permission === 'allow' ? 'granted' : 'denied',
            onchange: null,
          });
        }
        return originalQuery.call(navigator.permissions, descriptor);
      }, originalQuery);
    }
  }

  const mediaConfig = config.mediaDevices;
  if (mediaConfig && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    const originalEnumerate = navigator.mediaDevices.enumerateDevices;
    const stableId = (kind, index) => {
      let hash = Number(mediaConfig.seed) || 0;
      const material = kind + ':' + index;
      for (let position = 0; position < material.length; position += 1) {
        hash = (hash * 31 + material.charCodeAt(position)) >>> 0;
      }
      let out = '';
      for (let round = 0; round < 8; round += 1) {
        hash = (hash * 1103515245 + 12345) >>> 0;
        out += hash.toString(16).padStart(8, '0');
      }
      return out.slice(0, 64);
    };
    const buildDevices = () => {
      const devices = [];
      const kinds = [
        ['videoinput', mediaConfig.videoInputs],
        ['audioinput', mediaConfig.audioInputs],
        ['audiooutput', mediaConfig.audioOutputs],
      ];
      for (const [kind, count] of kinds) {
        for (let index = 0; index < (Number(count) || 0); index += 1) {
          devices.push({
            deviceId: stableId(kind, index),
            kind,
            // Chrome returns an empty label until camera or microphone
            // permission is granted, so a populated one is itself a tell.
            label: '',
            groupId: stableId('group:' + kind, index),
            toJSON() { return this; },
          });
        }
      }
      return devices;
    };
    navigator.mediaDevices.enumerateDevices = maskFunction(
      function () { return Promise.resolve(buildDevices()); },
      originalEnumerate,
    );
  }

  const portsConfig = config.ports;
  if (portsConfig) {
    const allowedPorts = new Set((portsConfig.allowedPorts || []).map(Number));
    const isLoopbackHost = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    // Only pages served from somewhere else are blocked from probing loopback.
    // A local page reaching its own host is not a fingerprinting attempt, and
    // blocking it unconditionally breaks the sidecar's own local proof fixture
    // and the audit checkers, which the extension also matches.
    const pageIsLocal = isLoopbackHost(location.hostname);
    const isBlockedTarget = (rawUrl) => {
      if (pageIsLocal) return false;
      let parsed;
      try { parsed = new URL(rawUrl, location.href); } catch (_) { return false; }
      if (!isLoopbackHost(parsed.hostname)) return false;
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
      return !allowedPorts.has(port);
    };
    const makeBlockedError = () => {
      if (typeof DOMException === 'function') return new DOMException('Failed to fetch', 'NetworkError');
      return new Error('Failed to fetch');
    };

    if (typeof fetch === 'function') {
      const originalFetch = fetch;
      globalThis.fetch = maskFunction(function (input, init) {
        const target = typeof input === 'string' ? input : (input && input.url);
        if (target && isBlockedTarget(target)) return Promise.reject(makeBlockedError());
        return originalFetch.call(globalThis, input, init);
      }, originalFetch);
    }
    if (globalThis.XMLHttpRequest) {
      const originalOpen = globalThis.XMLHttpRequest.prototype.open;
      globalThis.XMLHttpRequest.prototype.open = maskFunction(function (method, url, ...rest) {
        if (url && isBlockedTarget(url)) throw makeBlockedError();
        return originalOpen.call(this, method, url, ...rest);
      }, originalOpen);
    }
    if (typeof WebSocket === 'function') {
      const OriginalWebSocket = WebSocket;
      globalThis.WebSocket = maskFunction(function (url, protocols) {
        if (url && isBlockedTarget(url)) throw makeBlockedError();
        return protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
      }, OriginalWebSocket);
      globalThis.WebSocket.prototype = OriginalWebSocket.prototype;
    }
  }
})();
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


def _json_copy(payload: Any) -> Any:
    try:
        return json.loads(json.dumps(payload, ensure_ascii=False, allow_nan=False, sort_keys=True))
    except (TypeError, ValueError) as exc:
        raise _extension_error() from exc


def _ensure_keys(value: Mapping[str, Any], allowed: set[str]) -> None:
    if set(value) - allowed:
        raise _extension_error()


def _require_object(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _extension_error()
    return value


def _require_string(value: Any, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise _extension_error()
    if (not allow_empty and not value) or len(value) > 512 or _contains_control_characters(value):
        raise _extension_error()
    _assert_no_forbidden_text(value)
    return value


def _require_int(value: Any, *, minimum: int, maximum: int) -> int:
    if type(value) is not int or value < minimum or value > maximum:
        raise _extension_error()
    return value


def _require_number(value: Any, *, minimum: float, maximum: float) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < minimum or value > maximum:
        raise _extension_error()
    json.dumps(value, allow_nan=False)
    return value


def _assert_no_forbidden_text(text: str) -> None:
    if any(marker in text for marker in _FORBIDDEN_TEXT_MARKERS):
        raise _extension_error()


def _contains_control_characters(value: str) -> bool:
    return any(ord(character) < 32 for character in value)


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
        code=IDENTITY_EXTENSION_FAILED,
        message=_SAFE_EXTENSION_MESSAGE,
    )


__all__ = [
    "CONFIG_SCRIPT_NAME",
    "GENERATED_EXTENSIONS_DIR",
    "IdentityExtensionArtifact",
    "MANIFEST_NAME",
    "PROTECTOR_SCRIPT_NAME",
    "generate_identity_extension",
    "runtime_identity_extension_root",
    "validate_identity_extension",
]
