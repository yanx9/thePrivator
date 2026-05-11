"""Curated public checker catalog for guided identity audits.

The catalog is advisory only: these public pages help a user compare visible
values against their configured identity, but they are not a scraping surface and
not a guarantee of checker scores or privacy outcomes.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urlparse

from .profiles import normalize_profile_identity
from .protocol import IDENTITY_AUDIT_FAILED, IDENTITY_AUDIT_PAGE_NOT_FOUND, JsonObject, SidecarError

AUDIT_VERSION = 1
AUDIT_SURFACES = (
    "browser",
    "clientHints",
    "navigator",
    "screen",
    "locale",
    "canvas",
    "webgl",
    "audio",
    "webrtc",
)
AUDIT_CATEGORIES = ("browserleaks", "consistency", "privacy")
NO_GUARANTEE_COPY = "This guide is advisory and does not promise invisibility, checker success scores, or stable public-page assertions."
LOCAL_PROOF_COPY = "Use ThePrivator local proof for contractual app behavior; public pages are manual comparison aids."
PUBLIC_CHECKER_INSTABILITY_COPY = "Public checker pages can change labels, scoring, collection rules, and exposed fields without notice."

_FORBIDDEN_TEXT_MARKERS = (
    "DevToolsActivePort",
    "remote-debugging-port",
    "debug port",
    "websocket",
    "ws://",
    "wss://",
    "target id",
    "targetId",
    "raw argv",
    "user-data-dir",
    "profile-store",
    "Traceback",
    "guaranteed undetectability",
    "guaranteed green",
    "guaranteed pass",
)


@dataclass(frozen=True)
class AuditPage:
    """One allowlisted public checker page used by the guided audit flow."""

    page_id: str
    label: str
    category: str
    url: str
    surfaces: tuple[str, ...]
    comparison_note: str
    requires_user_action: bool = False

    def to_dict(self) -> JsonObject:
        return {
            "id": self.page_id,
            "label": self.label,
            "category": self.category,
            "url": self.url,
            "surfaces": list(self.surfaces),
            "comparisonNote": self.comparison_note,
            "requiresUserAction": self.requires_user_action,
        }


_RAW_AUDIT_CATALOG = (
    AuditPage(
        page_id="browserleaks-client-hints",
        label="BrowserLeaks Client Hints",
        category="browserleaks",
        url="https://browserleaks.com/client-hints",
        surfaces=("browser", "clientHints"),
        comparison_note="Compare User-Agent Client Hints platform, architecture, bitness, model, and mobile flag where the public page exposes them.",
    ),
    AuditPage(
        page_id="browserleaks-javascript",
        label="BrowserLeaks JavaScript",
        category="browserleaks",
        url="https://browserleaks.com/javascript",
        surfaces=("browser", "navigator", "screen", "locale"),
        comparison_note="Compare User-Agent, navigator platform and hardware, languages, timezone, screen, and viewport values manually.",
    ),
    AuditPage(
        page_id="browserleaks-canvas",
        label="BrowserLeaks Canvas",
        category="browserleaks",
        url="https://browserleaks.com/canvas",
        surfaces=("canvas",),
        comparison_note="For noise mode, expect a stable per-profile altered signature rather than a known hash or universal score.",
    ),
    AuditPage(
        page_id="browserleaks-webgl",
        label="BrowserLeaks WebGL",
        category="browserleaks",
        url="https://browserleaks.com/webgl",
        surfaces=("webgl",),
        comparison_note="Compare configured WebGL vendor and renderer when masked or custom; noise only means a stable per-profile altered signature.",
    ),
    AuditPage(
        page_id="browserleaks-webrtc",
        label="BrowserLeaks WebRTC",
        category="browserleaks",
        url="https://browserleaks.com/webrtc",
        surfaces=("webrtc",),
        comparison_note="For restricted policies, compare whether non-proxied UDP or local IP candidates are absent; external network behavior is checker-dependent.",
    ),
    AuditPage(
        page_id="pixelscan-fingerprint-check",
        label="Pixelscan Fingerprint Check",
        category="consistency",
        url="https://pixelscan.net/fingerprint-check",
        surfaces=AUDIT_SURFACES,
        comparison_note="Treat flags and scores as advisory consistency hints; compare contradictions instead of treating one score as authoritative.",
    ),
    AuditPage(
        page_id="browserscan-browser-checker",
        label="BrowserScan Browser Checker",
        category="consistency",
        url="https://www.browserscan.net/browser-checker",
        surfaces=("browser", "clientHints", "navigator", "screen", "locale", "canvas", "webgl", "webrtc"),
        comparison_note="Use the report as a cross-check for browser, kernel, timezone, and surface mismatches, not as an authoritative result.",
    ),
    AuditPage(
        page_id="amiunique-fingerprint",
        label="AmIUnique Fingerprint",
        category="privacy",
        url="https://amiunique.org/fingerprint",
        surfaces=AUDIT_SURFACES,
        comparison_note="Use attributes and similarity ratios for interpretation; uniqueness reporting is not a pass or fail assertion.",
    ),
    AuditPage(
        page_id="cover-your-tracks",
        label="Cover Your Tracks",
        category="privacy",
        url="https://coveryourtracks.eff.org/",
        surfaces=("browser", "clientHints", "navigator", "canvas", "webgl", "audio", "webrtc"),
        comparison_note="The page requires a user-started test and collects anonymous data according to its site copy; use results as privacy guidance only.",
        requires_user_action=True,
    ),
)

_EXPECTED_URL_BY_PAGE_ID = {page.page_id: page.url for page in _RAW_AUDIT_CATALOG}


def validate_audit_catalog(pages: Sequence[AuditPage]) -> tuple[AuditPage, ...]:
    """Validate and freeze a candidate audit catalog."""
    if not isinstance(pages, Sequence) or isinstance(pages, (str, bytes)):
        _raise_audit_failed("Audit catalog must be a sequence.")

    seen: set[str] = set()
    validated: list[AuditPage] = []
    for page in pages:
        if not isinstance(page, AuditPage):
            _raise_audit_failed("Audit catalog entries must be AuditPage objects.")
        _validate_page_id(page.page_id)
        if page.page_id in seen:
            _raise_audit_failed("Audit catalog page ids must be unique.")
        seen.add(page.page_id)
        _validate_safe_text(page.label, "label")
        _validate_safe_text(page.comparison_note, "comparisonNote")
        if page.category not in AUDIT_CATEGORIES:
            _raise_audit_failed("Audit catalog page category is unsupported.")
        expected_url = _EXPECTED_URL_BY_PAGE_ID.get(page.page_id)
        if expected_url is None or page.url != expected_url:
            _raise_audit_failed("Audit catalog page URL is not allowlisted.")
        _validate_https_url(page.url)
        if not page.surfaces:
            _raise_audit_failed("Audit catalog page must cover at least one surface.")
        if len(set(page.surfaces)) != len(page.surfaces):
            _raise_audit_failed("Audit catalog page surfaces must be unique.")
        for surface in page.surfaces:
            if surface not in AUDIT_SURFACES:
                _raise_audit_failed("Audit catalog page surface is unsupported.")
        validated.append(page)

    if set(seen) != set(_EXPECTED_URL_BY_PAGE_ID):
        _raise_audit_failed("Audit catalog page set is incomplete.")
    return tuple(validated)


def audit_catalog_payload() -> list[JsonObject]:
    """Return a JSON-safe copy of the frozen public checker catalog."""
    return [page.to_dict() for page in AUDIT_CATALOG]


def build_audit_plan(profile: Any) -> JsonObject:
    """Build a safe, profile-specific manual audit plan.

    The profile identity is normalized through the existing profile-store path
    before any rows are produced. Profile names, storage paths, runtime process
    state, debug ports, target ids, and raw launch details are deliberately not
    included in the returned JSON.
    """
    identity = normalize_profile_identity(_extract_profile_identity(profile))
    return {
        "auditVersion": AUDIT_VERSION,
        "copy": {
            "advisory": NO_GUARANTEE_COPY,
            "localProof": LOCAL_PROOF_COPY,
            "publicCheckerInstability": PUBLIC_CHECKER_INSTABILITY_COPY,
        },
        "pages": [
            {
                **page.to_dict(),
                "expectedRows": _expected_rows_for_surfaces(identity, page.surfaces),
            }
            for page in AUDIT_CATALOG
        ],
    }


def get_audit_page(page_id: str) -> JsonObject:
    """Return one catalog page by id or raise a typed recoverable audit error."""
    if not isinstance(page_id, str) or not page_id.strip():
        raise SidecarError(
            code=IDENTITY_AUDIT_PAGE_NOT_FOUND,
            message="Audit page was not found.",
        )
    for page in AUDIT_CATALOG:
        if page.page_id == page_id:
            return page.to_dict()
    raise SidecarError(
        code=IDENTITY_AUDIT_PAGE_NOT_FOUND,
        message="Audit page was not found.",
    )


def _extract_profile_identity(profile: Any) -> Any:
    if isinstance(profile, Mapping):
        if "identity" in profile:
            return profile["identity"]
        if "identityVersion" in profile:
            return profile
    identity = getattr(profile, "identity", None)
    if identity is not None:
        return identity
    _raise_audit_failed("Audit profile identity is unavailable.")


def _expected_rows_for_surfaces(identity: Mapping[str, Any], surfaces: Iterable[str]) -> list[JsonObject]:
    rows: list[JsonObject] = []
    for surface in surfaces:
        rows.extend(_expected_rows_for_surface(identity, surface))
    return rows


def _expected_rows_for_surface(identity: Mapping[str, Any], surface: str) -> list[JsonObject]:
    if surface == "browser":
        browser = _mapping(identity.get("browser"))
        if browser.get("mode") == "real":
            return [_row("browser", "Browser", "Real host browser values.", "Compare against the host Chromium values shown by local proof and the public page.")]
        return [
            _row(
                "browser",
                "Browser / User-Agent",
                f"User-Agent {_text(browser.get('userAgent'))}",
                "Compare the full User-Agent string when the checker exposes it.",
            )
        ]

    if surface == "clientHints":
        browser = _mapping(identity.get("browser"))
        navigator = _mapping(identity.get("navigator"))
        if browser.get("mode") == "real":
            return [_row("clientHints", "Client Hints", "Real host Client Hints as Chromium exposes them.", "Some high-entropy hints may be unavailable until a site requests them.")]
        hints = _mapping(browser.get("clientHints"))
        expected_parts: list[str] = []
        platform = hints.get("platform") or navigator.get("uaPlatform")
        platform_version = hints.get("platformVersion") or navigator.get("uaPlatformVersion")
        architecture = hints.get("architecture") or navigator.get("uaArchitecture")
        if platform:
            expected_parts.append(f"platform {_text(platform)}")
        if platform_version:
            expected_parts.append(f"platform version {_text(platform_version)}")
        if architecture:
            expected_parts.append(f"architecture {_text(architecture)}")
        if hints.get("bitness"):
            expected_parts.append(f"bitness {_text(hints.get('bitness'))}")
        if hints.get("model"):
            expected_parts.append(f"model {_text(hints.get('model'))}")
        mobile = hints.get("mobile") if "mobile" in hints else navigator.get("uaMobile")
        if isinstance(mobile, bool):
            expected_parts.append(f"mobile {str(mobile).lower()}")
        expected = "; ".join(expected_parts) if expected_parts else "Configured Client Hints may be absent or withheld by Chromium."
        return [_row("clientHints", "Client Hints", expected, "Compare exposed low and high entropy hints; missing fields can be public-checker behavior.")]

    if surface == "navigator":
        navigator = _mapping(identity.get("navigator"))
        if navigator.get("mode") == "real":
            return [_row("navigator", "Navigator", "Real host navigator values.", "Compare against local proof and visible navigator fields.")]
        return [
            _row(
                "navigator",
                "Navigator",
                f"{_text(navigator.get('platform'))}; {navigator.get('hardwareConcurrency')} cores; {navigator.get('deviceMemory')} GiB; UA platform {_text(navigator.get('uaPlatform'))}; UA architecture {_text(navigator.get('uaArchitecture'))}; mobile {str(navigator.get('uaMobile')).lower()}",
                "Compare navigator.platform, hardwareConcurrency, deviceMemory, and UA metadata where shown.",
            )
        ]

    if surface == "screen":
        screen = _mapping(identity.get("screen"))
        if screen.get("mode") == "real":
            return [_row("screen", "Screen", "Real host screen and viewport values.", "Compare screen, viewport, color depth, and device pixel ratio fields.")]
        return [
            _row(
                "screen",
                "Screen",
                f"{screen.get('width')}×{screen.get('height')}; viewport {screen.get('viewportWidth')}×{screen.get('viewportHeight')}; color depth {screen.get('colorDepth')}; DPR {screen.get('pixelRatio')}",
                "Compare both total screen and viewport dimensions; public pages may label viewport fields differently.",
            )
        ]

    if surface == "locale":
        locale = _mapping(identity.get("locale"))
        if locale.get("mode") == "real":
            return [_row("locale", "Locale", "Real host locale, language, and timezone values.", "Compare browser language, languages list, Intl locale, and timezone where available.")]
        languages = locale.get("languages")
        joined_languages = ", ".join(_text(item) for item in languages) if isinstance(languages, list) else ""
        return [
            _row(
                "locale",
                "Locale",
                f"locale {_text(locale.get('locale'))}; languages {joined_languages}; timezone {_text(locale.get('timezoneId'))}",
                "Compare language ordering and timezone; local clock formatting can vary by checker.",
            )
        ]

    if surface == "canvas":
        canvas = _mapping(identity.get("canvas"))
        if canvas.get("mode") == "real":
            return [_row("canvas", "Canvas", "Real host canvas rendering signature.", "Use local proof as the app-side reference; public hashes are not stable contracts.")]
        return [_row("canvas", "Canvas", "Stable per-profile altered signature from configured noise.", "Do not compare against a known hash; check that repeated visits with this profile remain stable.")]

    if surface == "audio":
        audio = _mapping(identity.get("audio"))
        if audio.get("mode") == "real":
            return [_row("audio", "Audio", "Real host audio rendering signature.", "Use local proof as the app-side reference; public samples are not stable contracts.")]
        return [_row("audio", "Audio", "Stable per-profile altered signature from configured noise.", "Do not compare against a known sample; check that repeated visits with this profile remain stable.")]

    if surface == "webgl":
        webgl = _mapping(identity.get("webgl"))
        if webgl.get("mode") == "real":
            return [_row("webgl", "WebGL", "Real host WebGL vendor and renderer values.", "Compare visible vendor and renderer strings when exposed.")]
        expected = f"vendor {_text(webgl.get('vendor'))}; renderer {_text(webgl.get('renderer'))}"
        if "noiseSeed" in webgl:
            expected = f"{expected}; stable per-profile altered signature from configured noise"
        return [_row("webgl", "WebGL", expected, "Compare vendor and renderer strings; do not treat a fingerprint hash as a known expected value.")]

    if surface == "webrtc":
        webrtc = _mapping(identity.get("webrtc"))
        policy = webrtc.get("policy")
        if policy == "real":
            expected = "Real host WebRTC behavior."
        elif policy == "block":
            expected = "WebRTC blocked or unavailable to the checker."
        else:
            expected = "No non-proxied UDP or local IP candidate exposure expected."
        return [_row("webrtc", "WebRTC", expected, "Compare candidate exposure manually; STUN and network behavior can vary by public checker.")]

    _raise_audit_failed("Audit catalog page surface is unsupported.")


def _row(surface: str, label: str, expected: str, guidance: str) -> JsonObject:
    return {
        "surface": surface,
        "label": label,
        "expected": _redact_expected_text(expected),
        "guidance": _redact_expected_text(guidance),
    }


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any) -> str:
    return "" if value is None else _redact_expected_text(str(value))


def _redact_expected_text(value: str) -> str:
    redacted = value
    redacted = re.sub(r"wss?://[^\s;\"']+", "[redacted]", redacted, flags=re.IGNORECASE)
    redacted = re.sub(r"\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost)\b", "[redacted]", redacted, flags=re.IGNORECASE)
    redacted = re.sub(r":(?:[0-9]{2,5})\b", ":[redacted]", redacted)
    redacted = re.sub(r"(?:/[A-Za-z0-9._-]+){2,}", "[redacted]", redacted)
    for marker in _FORBIDDEN_TEXT_MARKERS:
        redacted = re.sub(re.escape(marker), "[redacted]", redacted, flags=re.IGNORECASE)
    return redacted


def _validate_page_id(value: Any) -> None:
    if not isinstance(value, str) or not value or len(value) > 80:
        _raise_audit_failed("Audit catalog page id must be a short string.")
    if not all(character.islower() or character.isdigit() or character == "-" for character in value):
        _raise_audit_failed("Audit catalog page id contains unsupported characters.")


def _validate_https_url(value: Any) -> None:
    if not isinstance(value, str) or not value:
        _raise_audit_failed("Audit catalog page URL must be a string.")
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.hostname in {"127.0.0.1", "localhost", "0.0.0.0"}:
        _raise_audit_failed("Audit catalog page URL must be an exact public HTTPS URL.")


def _validate_safe_text(value: Any, field: str) -> None:
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        _raise_audit_failed(f"Audit catalog {field} must be a bounded string.")
    lowered = value.casefold()
    if any(ord(character) < 32 for character in value):
        _raise_audit_failed(f"Audit catalog {field} contains control characters.")
    if any(marker.casefold() in lowered for marker in _FORBIDDEN_TEXT_MARKERS):
        _raise_audit_failed(f"Audit catalog {field} contains unsafe debug or promise language.")


def _raise_audit_failed(message: str) -> None:
    raise SidecarError(
        code=IDENTITY_AUDIT_FAILED,
        message=message,
    )


AUDIT_CATALOG = validate_audit_catalog(_RAW_AUDIT_CATALOG)

__all__ = [
    "AUDIT_CATALOG",
    "AUDIT_CATEGORIES",
    "AUDIT_SURFACES",
    "AUDIT_VERSION",
    "AuditPage",
    "LOCAL_PROOF_COPY",
    "NO_GUARANTEE_COPY",
    "PUBLIC_CHECKER_INSTABILITY_COPY",
    "audit_catalog_payload",
    "build_audit_plan",
    "get_audit_page",
    "validate_audit_catalog",
]
