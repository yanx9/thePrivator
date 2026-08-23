"""Local proof-page collector for S02 identity runtime verification.

The helper here is intentionally internal to the Python sidecar package. It uses
an ephemeral loopback HTTP server and an already-discovered CDP browser target to
observe representative browser/runtime and JavaScript-exposed identity surfaces
without depending on public checker pages. Failures are collapsed into a generic
``IDENTITY_PROOF_FAILED`` error so verifier diagnostics can remain useful without
leaking paths, ports, WebSocket URLs, raw responses, or stack traces.
"""

from __future__ import annotations

import json
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Union

from .cdp import (
    CdpClient,
    CdpEndpoint,
    CdpPageEndpoint,
    close_page_target,
    create_page_target_endpoint,
    discover_devtools_endpoint,
    discover_page_target_endpoint,
    page_navigate,
    runtime_evaluate,
)
from .protocol import IDENTITY_PROOF_FAILED, JsonObject, SidecarError

PROOF_SCHEMA_VERSION = 1
MAX_PROOF_JSON_BYTES = 8192
MAX_SURFACE_PROOF_JSON_BYTES = 16384
MAX_PROOF_STRING_LENGTH = 512
MAX_PROOF_LIST_LENGTH = 32
_SAFE_PROOF_MESSAGE = "Identity proof could not be collected."
_ACCEPT_CH_HEADER = ", ".join(
    [
        "Sec-CH-UA",
        "Sec-CH-UA-Mobile",
        "Sec-CH-UA-Platform",
        "Sec-CH-UA-Platform-Version",
        "Sec-CH-UA-Arch",
        "Sec-CH-UA-Bitness",
        "Sec-CH-UA-Model",
        "Sec-CH-UA-Full-Version",
        "Sec-CH-UA-Full-Version-List",
    ]
)
_ALLOWED_HEADER_NAMES = {
    "user-agent": "User-Agent",
    "accept-language": "Accept-Language",
    "sec-ch-ua": "Sec-CH-UA",
    "sec-ch-ua-mobile": "Sec-CH-UA-Mobile",
    "sec-ch-ua-platform": "Sec-CH-UA-Platform",
    "sec-ch-ua-platform-version": "Sec-CH-UA-Platform-Version",
    "sec-ch-ua-arch": "Sec-CH-UA-Arch",
    "sec-ch-ua-bitness": "Sec-CH-UA-Bitness",
    "sec-ch-ua-model": "Sec-CH-UA-Model",
    "sec-ch-ua-full-version": "Sec-CH-UA-Full-Version",
    "sec-ch-ua-full-version-list": "Sec-CH-UA-Full-Version-List",
}
_ALLOWED_USER_AGENT_DATA_HIGH_ENTROPY_KEYS = {
    "architecture",
    "bitness",
    "model",
    "platform",
    "platformVersion",
    "uaFullVersion",
    "fullVersionList",
    "brands",
    "mobile",
}
_SURFACE_LABELS = [
    "headers.userAgent",
    "headers.acceptLanguage",
    "headers.clientHints",
    "target.initial.browser.userAgent",
    "target.initial.browser.userAgentData",
    "target.initial.navigator",
    "target.initial.locale",
    "target.initial.viewport",
    "target.initial.canvas",
    "target.initial.webgl",
    "target.initial.audio",
    "target.initial.webrtc",
    "target.new.browser.userAgent",
    "target.new.browser.userAgentData",
    "target.new.navigator",
    "target.new.locale",
    "target.new.viewport",
    "target.new.canvas",
    "target.new.webgl",
    "target.new.audio",
    "target.new.webrtc",
]

PROOF_PAGE_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>theprivator identity proof</title>
</head>
<body>
  <main id="proof-root" data-proof="theprivator identity proof">
    theprivator identity proof
  </main>
</body>
</html>
"""

PROOF_COLLECTOR_SCRIPT = r"""
(async () => {
  'use strict';

  const numberOrNull = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  const stringOrEmpty = (value) => (typeof value === 'string' ? value : '');
  const errorName = (error) => (error && typeof error.name === 'string' ? error.name : 'Error');

  const collectUserAgentData = async () => {
    if (!navigator.userAgentData) return { supported: false };
    try {
      const highEntropy = await navigator.userAgentData.getHighEntropyValues([
        'architecture',
        'bitness',
        'model',
        'platform',
        'platformVersion',
        'uaFullVersion',
        'fullVersionList'
      ]);
      return {
        supported: true,
        brands: Array.isArray(navigator.userAgentData.brands) ? navigator.userAgentData.brands : [],
        mobile: Boolean(navigator.userAgentData.mobile),
        platform: stringOrEmpty(navigator.userAgentData.platform),
        highEntropy,
      };
    } catch (error) {
      return { supported: false, errorName: errorName(error) };
    }
  };

  const collectCanvas = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 32;
      const context = canvas.getContext('2d');
      if (!context) return { supported: false };
      context.fillStyle = '#123456';
      context.fillRect(0, 0, 64, 32);
      context.fillStyle = '#abcdef';
      context.font = '12px sans-serif';
      context.fillText('theprivator', 4, 18);
      const firstSignature = canvas.toDataURL().slice(0, 160);
      const secondSignature = canvas.toDataURL().slice(0, 160);
      return {
        supported: true,
        signature: firstSignature,
        firstSignature,
        secondSignature,
        stable: firstSignature === secondSignature,
      };
    } catch (error) {
      return { supported: false, errorName: errorName(error) };
    }
  };

  const collectWebgl = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return { supported: false };
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const vendor = debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const pixel = new Uint8Array(4);
      gl.clearColor(0.25, 0.5, 0.75, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return {
        supported: true,
        vendor: String(vendor || ''),
        renderer: String(renderer || ''),
        pixelSample: Array.from(pixel),
      };
    } catch (error) {
      return { supported: false, errorName: errorName(error) };
    }
  };

  const collectAudio = async () => {
    try {
      const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (!Context) return { supported: false };
      const context = new Context(1, 128, 44100);
      const oscillator = context.createOscillator();
      const analyser = context.createAnalyser();
      analyser.fftSize = 32;
      oscillator.type = 'triangle';
      oscillator.frequency.value = 440;
      oscillator.connect(analyser);
      analyser.connect(context.destination);
      oscillator.start(0);
      oscillator.stop(128 / 44100);
      await context.startRendering();
      const sample = new Float32Array(Math.min(8, analyser.frequencyBinCount || 8));
      analyser.getFloatFrequencyData(sample);
      return {
        supported: true,
        sample: Array.from(sample).map((value) => (Number.isFinite(value) ? Number(value.toFixed(6)) : null)),
        analyserFftSize: numberOrNull(analyser.fftSize),
        contextSampleRate: numberOrNull(context.sampleRate),
      };
    } catch (error) {
      return { supported: false, errorName: errorName(error) };
    }
  };

  const collectWebrtc = () => {
    const Constructor = globalThis.RTCPeerConnection || globalThis.webkitRTCPeerConnection;
    if (!Constructor) return { supported: false };
    try {
      const peer = new Constructor();
      const config = peer.getConfiguration ? peer.getConfiguration() : {};
      if (peer.close) peer.close();
      return {
        supported: true,
        icePolicy: config.iceTransportPolicy || 'all',
        relayOnly: config.iceTransportPolicy === 'relay',
        errorName: null,
      };
    } catch (error) {
      return { supported: true, icePolicy: null, relayOnly: false, errorName: errorName(error) };
    }
  };

  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return {
    schemaVersion: 1,
    browser: {
      userAgent: stringOrEmpty(navigator.userAgent),
      userAgentData: await collectUserAgentData(),
    },
    navigator: {
      platform: stringOrEmpty(navigator.platform),
      hardwareConcurrency: numberOrNull(navigator.hardwareConcurrency),
      deviceMemory: numberOrNull(navigator.deviceMemory),
    },
    locale: {
      language: stringOrEmpty(navigator.language),
      languages: Array.isArray(navigator.languages) ? Array.from(navigator.languages) : [],
      timezone: stringOrEmpty(resolved.timeZone),
    },
    viewport: {
      innerWidth: numberOrNull(globalThis.innerWidth),
      innerHeight: numberOrNull(globalThis.innerHeight),
      devicePixelRatio: numberOrNull(globalThis.devicePixelRatio),
      screen: {
        width: numberOrNull(globalThis.screen && globalThis.screen.width),
        height: numberOrNull(globalThis.screen && globalThis.screen.height),
        colorDepth: numberOrNull(globalThis.screen && globalThis.screen.colorDepth),
      },
    },
    canvas: collectCanvas(),
    webgl: collectWebgl(),
    audio: await collectAudio(),
    webrtc: collectWebrtc(),
  };
})()
""".strip()

ClientFactory = Callable[..., Any]


class IdentityProofServer:
    """Ephemeral loopback HTTP server for the local proof page."""

    def __init__(self) -> None:
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self.url = ""

    def __enter__(self) -> "IdentityProofServer":
        try:
            server = ThreadingHTTPServer(("127.0.0.1", 0), _ProofRequestHandler)
            server.observed_headers = []  # type: ignore[attr-defined]
            server.headers_lock = threading.Lock()  # type: ignore[attr-defined]
            host, port = server.server_address[:2]
            self.url = f"http://{host}:{port}/"
            thread = threading.Thread(target=server.serve_forever, name="identity-proof-server", daemon=True)
            thread.start()
            self._server = server
            self._thread = thread
            return self
        except Exception as exc:
            self.close()
            raise _proof_error() from exc

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def close(self) -> None:
        server = self._server
        thread = self._thread
        self._server = None
        self._thread = None
        if server is not None:
            try:
                server.shutdown()
            except Exception:
                pass
            try:
                server.server_close()
            except Exception:
                pass
        if thread is not None and thread.is_alive():
            thread.join(timeout=1)
    def observed_headers(self) -> list[JsonObject]:
        server = self._server
        if server is None:
            return []
        lock = getattr(server, "headers_lock", None)
        observed = getattr(server, "observed_headers", [])
        if lock is None:
            return [dict(item) for item in observed]
        with lock:
            return [dict(item) for item in observed]

    def latest_headers(self) -> JsonObject:
        observed = self.observed_headers()
        return observed[-1] if observed else {}


class _ProofRequestHandler(BaseHTTPRequestHandler):
    server_version = "ThePrivatorIdentityProof/1"
    sys_version = ""

    def do_GET(self) -> None:  # noqa: N802 - http.server API name.
        if self.path not in {"/", "/index.html"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        _record_allowlisted_headers(self.server, self.headers)
        content = PROOF_PAGE_HTML.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-CH", _ACCEPT_CH_HEADER)
        self.send_header("Critical-CH", "Sec-CH-UA-Platform, Sec-CH-UA-Arch, Sec-CH-UA-Bitness")
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib API name.
        return


def _record_allowlisted_headers(server: Any, headers: Any) -> None:
    observed = _capture_allowlisted_headers(headers)
    lock = getattr(server, "headers_lock", None)
    store = getattr(server, "observed_headers", None)
    if not isinstance(store, list):
        return
    if lock is None:
        store.append(observed)
        return
    with lock:
        store.append(observed)


def _capture_allowlisted_headers(headers: Any) -> JsonObject:
    captured: JsonObject = {}
    try:
        items = list(headers.items())
    except Exception as exc:
        raise _proof_error() from exc
    for name, value in items:
        if not isinstance(name, str) or not isinstance(value, str):
            continue
        canonical = _ALLOWED_HEADER_NAMES.get(name.lower())
        if canonical is None:
            continue
        captured[canonical] = _safe_header_value(value)
    return {key: captured[key] for key in sorted(captured)}


def _safe_header_value(value: str) -> str:
    if any(ord(character) < 32 and character not in "\t" for character in value):
        raise _proof_error()
    return value[:MAX_PROOF_STRING_LENGTH]


def collect_identity_proof(
    endpoint_or_url: Union[CdpEndpoint, str],
    *,
    client_factory: ClientFactory = CdpClient,
    timeout_seconds: float = 5.0,
) -> JsonObject:
    """Navigate a page target to the local proof page and collect observed surfaces."""
    try:
        with IdentityProofServer() as server:
            web_socket_url = _page_endpoint_url(endpoint_or_url)
            observed = _collect_observation_from_page(
                web_socket_url,
                server.url,
                client_factory=client_factory,
                timeout_seconds=timeout_seconds,
            )
        return observed
    except SidecarError as exc:
        if exc.code == IDENTITY_PROOF_FAILED:
            raise
        raise _proof_error() from exc
    except Exception as exc:
        raise _proof_error() from exc


def collect_identity_surface_proof(
    endpoint: CdpEndpoint,
    *,
    client_factory: ClientFactory = CdpClient,
    timeout_seconds: float = 5.0,
) -> JsonObject:
    """Collect bounded S04 local proof across initial and newly-created page targets."""
    if not isinstance(endpoint, CdpEndpoint):
        raise _proof_error()
    new_target: Optional[CdpPageEndpoint] = None
    result: Optional[JsonObject] = None
    cleanup_error: Optional[BaseException] = None
    try:
        with IdentityProofServer() as server:
            initial_target = discover_page_target_endpoint(endpoint, timeout_seconds=timeout_seconds)
            initial_observation = _collect_observation_from_page(
                initial_target.web_socket_debugger_url,
                server.url,
                client_factory=client_factory,
                timeout_seconds=timeout_seconds,
            )
            initial_headers = server.latest_headers()

            new_target = create_page_target_endpoint(
                endpoint,
                client_factory=client_factory,
                timeout_seconds=timeout_seconds,
            )
            new_observation = _collect_observation_from_page(
                new_target.web_socket_debugger_url,
                server.url,
                client_factory=client_factory,
                timeout_seconds=timeout_seconds,
            )
            new_headers = server.latest_headers()

            result = validate_identity_surface_proof(
                {
                    "schemaVersion": PROOF_SCHEMA_VERSION,
                    "surfaceLabels": list(_SURFACE_LABELS),
                    "headers": {"initial": initial_headers, "new": new_headers},
                    "targets": {
                        "initial": {"label": "initial", "observation": initial_observation},
                        "new": {"label": "new", "observation": new_observation},
                    },
                }
            )
    except SidecarError as exc:
        if exc.code == IDENTITY_PROOF_FAILED:
            raise
        raise _proof_error() from exc
    except Exception as exc:
        raise _proof_error() from exc
    finally:
        if new_target is not None and new_target.target_id:
            try:
                close_page_target(
                    endpoint,
                    new_target.target_id,
                    client_factory=client_factory,
                    timeout_seconds=timeout_seconds,
                )
            except BaseException as exc:  # pragma: no cover - covered through proof wrapping paths.
                cleanup_error = exc
    if cleanup_error is not None:
        raise _proof_error() from cleanup_error
    if result is None:
        raise _proof_error()
    return result


def _collect_observation_from_page(
    web_socket_url: str,
    proof_url: str,
    *,
    client_factory: ClientFactory,
    timeout_seconds: float,
) -> JsonObject:
    with client_factory(web_socket_url, timeout_seconds=timeout_seconds) as client:
        client.command("Page.enable", {}, timeout_seconds=timeout_seconds)
        page_navigate(client, proof_url, timeout_seconds=timeout_seconds)
        observed = runtime_evaluate(
            client,
            PROOF_COLLECTOR_SCRIPT,
            await_promise=True,
            return_by_value=True,
            timeout_seconds=timeout_seconds,
        )
    return validate_identity_observation(observed)


def collect_identity_proof_for_user_data_dir(
    user_data_dir: Union[str, Path],
    *,
    discovery_timeout_seconds: float = 10.0,
    proof_timeout_seconds: float = 5.0,
    client_factory: ClientFactory = CdpClient,
) -> JsonObject:
    """Discover a launched profile's page target and collect a redacted proof."""
    try:
        endpoint = discover_devtools_endpoint(
            user_data_dir,
            timeout_seconds=discovery_timeout_seconds,
        )
        return collect_identity_proof(
            endpoint,
            client_factory=client_factory,
            timeout_seconds=proof_timeout_seconds,
        )
    except SidecarError as exc:
        if exc.code == IDENTITY_PROOF_FAILED:
            raise
        raise _proof_error() from exc
    except Exception as exc:
        raise _proof_error() from exc


def collect_identity_surface_proof_for_user_data_dir(
    user_data_dir: Union[str, Path],
    *,
    discovery_timeout_seconds: float = 10.0,
    proof_timeout_seconds: float = 5.0,
    client_factory: ClientFactory = CdpClient,
) -> JsonObject:
    """Discover a launched profile and collect the richer S04 surface proof."""
    try:
        endpoint = discover_devtools_endpoint(
            user_data_dir,
            timeout_seconds=discovery_timeout_seconds,
        )
        return collect_identity_surface_proof(
            endpoint,
            client_factory=client_factory,
            timeout_seconds=proof_timeout_seconds,
        )
    except SidecarError as exc:
        if exc.code == IDENTITY_PROOF_FAILED:
            raise
        raise _proof_error() from exc
    except Exception as exc:
        raise _proof_error() from exc


def validate_identity_observation(payload: Any) -> JsonObject:
    """Validate and bound a proof observation before verifier output uses it."""
    if not isinstance(payload, Mapping):
        raise _proof_error()
    required_keys = {"schemaVersion", "browser", "navigator", "locale", "viewport", "canvas", "webgl", "audio", "webrtc"}
    if set(payload.keys()) != required_keys:
        raise _proof_error()
    if payload.get("schemaVersion") != PROOF_SCHEMA_VERSION:
        raise _proof_error()

    for key in ("browser", "navigator", "locale", "viewport", "canvas", "webgl", "audio", "webrtc"):
        if not isinstance(payload.get(key), Mapping):
            raise _proof_error()

    _validate_browser(payload["browser"])
    _validate_navigator(payload["navigator"])
    _validate_locale(payload["locale"])
    _validate_viewport(payload["viewport"])
    _validate_canvas(payload["canvas"])
    _validate_webgl(payload["webgl"])
    _validate_audio(payload["audio"])
    _validate_webrtc(payload["webrtc"])

    return _validate_bounded_json_object(payload, max_bytes=MAX_PROOF_JSON_BYTES)


def validate_identity_surface_proof(payload: Any) -> JsonObject:
    """Validate and bound the richer S04 multi-target proof payload."""
    if not isinstance(payload, Mapping):
        raise _proof_error()
    if payload.get("schemaVersion") != PROOF_SCHEMA_VERSION:
        raise _proof_error()
    headers = payload.get("headers")
    targets = payload.get("targets")
    labels = payload.get("surfaceLabels")
    if not isinstance(headers, Mapping) or not isinstance(targets, Mapping) or not isinstance(labels, list):
        raise _proof_error()
    if set(headers.keys()) != {"initial", "new"} or set(targets.keys()) != {"initial", "new"}:
        raise _proof_error()

    validated = {
        "schemaVersion": PROOF_SCHEMA_VERSION,
        "surfaceLabels": _validate_surface_labels(labels),
        "headers": {
            "initial": _validate_observed_headers(headers["initial"]),
            "new": _validate_observed_headers(headers["new"]),
        },
        "targets": {
            "initial": _validate_target_observation(targets["initial"], expected_label="initial"),
            "new": _validate_target_observation(targets["new"], expected_label="new"),
        },
    }
    return _validate_bounded_json_object(validated, max_bytes=MAX_SURFACE_PROOF_JSON_BYTES)


def _validate_surface_labels(labels: list[Any]) -> list[str]:
    if not labels or len(labels) > MAX_PROOF_LIST_LENGTH:
        raise _proof_error()
    validated: list[str] = []
    allowed = set(_SURFACE_LABELS)
    for label in labels:
        _require_string(label, allow_empty=False)
        if label not in allowed:
            raise _proof_error()
        validated.append(label)
    return validated


def _validate_observed_headers(headers: Any) -> JsonObject:
    if not isinstance(headers, Mapping):
        raise _proof_error()
    validated: JsonObject = {}
    for name, value in headers.items():
        if not isinstance(name, str) or name not in _ALLOWED_HEADER_NAMES.values():
            raise _proof_error()
        _require_string(value, allow_empty=True)
        validated[name] = value[:MAX_PROOF_STRING_LENGTH]
    return {key: validated[key] for key in sorted(validated)}


def _validate_target_observation(target: Any, *, expected_label: str) -> JsonObject:
    if not isinstance(target, Mapping):
        raise _proof_error()
    if set(target.keys()) != {"label", "observation"}:
        raise _proof_error()
    if target.get("label") != expected_label:
        raise _proof_error()
    return {
        "label": expected_label,
        "observation": validate_identity_observation(target.get("observation")),
    }


def _require_allowed_keys(payload: Mapping[str, Any], allowed: set[str]) -> None:
    if any(not isinstance(key, str) for key in payload.keys()):
        raise _proof_error()
    if set(payload.keys()) - allowed:
        raise _proof_error()


def _validate_brand_list(value: Any) -> None:
    if not isinstance(value, list):
        raise _proof_error()
    if len(value) > MAX_PROOF_LIST_LENGTH:
        raise _proof_error()
    for item in value:
        if not isinstance(item, Mapping):
            raise _proof_error()
        _require_allowed_keys(item, {"brand", "version"})
        _require_string(item.get("brand"), allow_empty=False)
        _require_string(item.get("version"), allow_empty=False)


def _validate_optional_error_name(payload: Mapping[str, Any]) -> None:
    error_name = payload.get("errorName")
    if error_name is not None:
        _require_string(error_name, allow_empty=True)


def _validate_browser(browser: Mapping[str, Any]) -> None:
    _require_allowed_keys(browser, {"userAgent", "userAgentData"})
    _require_string(browser.get("userAgent"), allow_empty=False)
    user_agent_data = browser.get("userAgentData")
    if not isinstance(user_agent_data, Mapping):
        raise _proof_error()
    supported = user_agent_data.get("supported")
    if not isinstance(supported, bool):
        raise _proof_error()
    if not supported:
        _require_allowed_keys(user_agent_data, {"supported", "errorName"})
        _validate_optional_error_name(user_agent_data)
        return
    _require_allowed_keys(user_agent_data, {"supported", "brands", "mobile", "platform", "highEntropy"})
    _validate_brand_list(user_agent_data.get("brands"))
    if not isinstance(user_agent_data.get("mobile"), bool):
        raise _proof_error()
    _require_string(user_agent_data.get("platform"), allow_empty=True)
    high_entropy = user_agent_data.get("highEntropy")
    if not isinstance(high_entropy, Mapping):
        raise _proof_error()
    _require_allowed_keys(high_entropy, set(_ALLOWED_USER_AGENT_DATA_HIGH_ENTROPY_KEYS))
    for key, value in high_entropy.items():
        if key in {"brands", "fullVersionList"}:
            _validate_brand_list(value)
        elif key == "mobile":
            if not isinstance(value, bool):
                raise _proof_error()
        else:
            _require_string(value, allow_empty=True)


def _validate_navigator(navigator: Mapping[str, Any]) -> None:
    _require_allowed_keys(navigator, {"platform", "hardwareConcurrency", "deviceMemory"})
    _require_string(navigator.get("platform"), allow_empty=True)
    _require_optional_number(navigator.get("hardwareConcurrency"))
    _require_optional_number(navigator.get("deviceMemory"))


def _validate_locale(locale: Mapping[str, Any]) -> None:
    _require_allowed_keys(locale, {"language", "languages", "timezone"})
    _require_string(locale.get("language"), allow_empty=True)
    languages = locale.get("languages")
    if not isinstance(languages, list):
        raise _proof_error()
    for language in languages:
        _require_string(language, allow_empty=False)
    _require_string(locale.get("timezone"), allow_empty=True)


def _validate_viewport(viewport: Mapping[str, Any]) -> None:
    _require_allowed_keys(viewport, {"innerWidth", "innerHeight", "devicePixelRatio", "screen"})
    _require_optional_number(viewport.get("innerWidth"))
    _require_optional_number(viewport.get("innerHeight"))
    _require_optional_number(viewport.get("devicePixelRatio"))
    screen = viewport.get("screen")
    if not isinstance(screen, Mapping):
        raise _proof_error()
    _require_allowed_keys(screen, {"width", "height", "colorDepth"})
    _require_optional_number(screen.get("width"))
    _require_optional_number(screen.get("height"))
    _require_optional_number(screen.get("colorDepth"))


def _validate_canvas(canvas: Mapping[str, Any]) -> None:
    supported = canvas.get("supported")
    if not isinstance(supported, bool):
        raise _proof_error()
    if not supported:
        _require_allowed_keys(canvas, {"supported", "errorName"})
        _validate_optional_error_name(canvas)
        return
    _require_allowed_keys(canvas, {"supported", "signature", "firstSignature", "secondSignature", "stable"})
    _require_string(canvas.get("signature"), allow_empty=False)
    if canvas.get("firstSignature") is not None:
        _require_string(canvas.get("firstSignature"), allow_empty=False)
    if canvas.get("secondSignature") is not None:
        _require_string(canvas.get("secondSignature"), allow_empty=False)
    if canvas.get("stable") is not None and not isinstance(canvas.get("stable"), bool):
        raise _proof_error()


def _validate_webgl(webgl: Mapping[str, Any]) -> None:
    supported = webgl.get("supported")
    if not isinstance(supported, bool):
        raise _proof_error()
    if not supported:
        _require_allowed_keys(webgl, {"supported", "errorName"})
        _validate_optional_error_name(webgl)
        return
    _require_allowed_keys(webgl, {"supported", "vendor", "renderer", "pixelSample"})
    _require_string(webgl.get("vendor"), allow_empty=True)
    _require_string(webgl.get("renderer"), allow_empty=True)
    pixel_sample = webgl.get("pixelSample")
    if pixel_sample is not None:
        if not isinstance(pixel_sample, list) or len(pixel_sample) > 16:
            raise _proof_error()
        for value in pixel_sample:
            _require_optional_number(value)


def _validate_audio(audio: Mapping[str, Any]) -> None:
    supported = audio.get("supported")
    if not isinstance(supported, bool):
        raise _proof_error()
    if not supported:
        _require_allowed_keys(audio, {"supported", "errorName"})
        _validate_optional_error_name(audio)
        return
    _require_allowed_keys(audio, {"supported", "sample", "analyserFftSize", "contextSampleRate"})
    sample = audio.get("sample")
    if not isinstance(sample, list):
        raise _proof_error()
    for value in sample:
        _require_optional_number(value)
    _require_optional_number(audio.get("analyserFftSize"))
    _require_optional_number(audio.get("contextSampleRate"))


def _validate_webrtc(webrtc: Mapping[str, Any]) -> None:
    supported = webrtc.get("supported")
    if not isinstance(supported, bool):
        raise _proof_error()
    if not supported:
        _require_allowed_keys(webrtc, {"supported", "errorName"})
        _validate_optional_error_name(webrtc)
        return
    _require_allowed_keys(webrtc, {"supported", "icePolicy", "relayOnly", "errorName"})
    ice_policy = webrtc.get("icePolicy")
    if ice_policy is not None:
        _require_string(ice_policy, allow_empty=True)
    relay_only = webrtc.get("relayOnly")
    if relay_only is not None and not isinstance(relay_only, bool):
        raise _proof_error()
    _validate_optional_error_name(webrtc)


def _require_string(value: Any, *, allow_empty: bool) -> str:
    if not isinstance(value, str):
        raise _proof_error()
    if not allow_empty and not value:
        raise _proof_error()
    if any(ord(character) < 32 for character in value):
        raise _proof_error()
    return value


def _require_optional_number(value: Any) -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _proof_error()
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise _proof_error() from exc


def _page_endpoint_url(endpoint_or_url: Union[CdpEndpoint, str]) -> str:
    if isinstance(endpoint_or_url, CdpEndpoint):
        return discover_page_target_endpoint(endpoint_or_url).web_socket_debugger_url
    if isinstance(endpoint_or_url, str):
        return endpoint_or_url
    raise _proof_error()


def _validate_bounded_json_object(payload: Mapping[str, Any], *, max_bytes: int) -> JsonObject:
    bounded = _bounded_json_value(payload)
    if not isinstance(bounded, dict):
        raise _proof_error()
    try:
        encoded = json.dumps(bounded, ensure_ascii=False, allow_nan=False, sort_keys=True)
    except (TypeError, ValueError) as exc:
        raise _proof_error() from exc
    if len(encoded.encode("utf-8")) > max_bytes:
        raise _proof_error()
    return bounded


def _bounded_json_value(value: Any, *, depth: int = 0) -> Any:
    if depth > 12:
        return None
    if isinstance(value, Mapping):
        result: JsonObject = {}
        for index, (key, nested) in enumerate(value.items()):
            if index >= MAX_PROOF_LIST_LENGTH:
                break
            if isinstance(key, str) and key:
                result[key[:MAX_PROOF_STRING_LENGTH]] = _bounded_json_value(nested, depth=depth + 1)
        return result
    if isinstance(value, list):
        return [_bounded_json_value(item, depth=depth + 1) for item in value[:MAX_PROOF_LIST_LENGTH]]
    if isinstance(value, str):
        return value[:MAX_PROOF_STRING_LENGTH]
    if value is None or isinstance(value, bool) or isinstance(value, int):
        return value
    if isinstance(value, float):
        json.dumps(value, allow_nan=False)
        return value
    return None


def _proof_error() -> SidecarError:
    return SidecarError(code=IDENTITY_PROOF_FAILED, message=_SAFE_PROOF_MESSAGE)


__all__ = [
    "IdentityProofServer",
    "MAX_PROOF_JSON_BYTES",
    "MAX_SURFACE_PROOF_JSON_BYTES",
    "PROOF_COLLECTOR_SCRIPT",
    "PROOF_PAGE_HTML",
    "PROOF_SCHEMA_VERSION",
    "collect_identity_proof",
    "collect_identity_proof_for_user_data_dir",
    "collect_identity_surface_proof",
    "collect_identity_surface_proof_for_user_data_dir",
    "validate_identity_observation",
    "validate_identity_surface_proof",
]
