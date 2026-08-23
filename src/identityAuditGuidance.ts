import type { ProfileIdentity } from "./sidecar/types";

export const SUPPORTED_AUDIT_SURFACES = [
  "browser",
  "clientHints",
  "navigator",
  "screen",
  "locale",
  "canvas",
  "webgl",
  "audio",
  "webrtc",
  // Added with identity v2. This list is what makes the guidance appear at all,
  // so a surface missing from it silently produces an audit page with nothing
  // to compare against -- which is how this whole module went unused.
  "geolocation",
  "mediaDevices",
  "ports",
] as const;

export type IdentityAuditSurface = (typeof SUPPORTED_AUDIT_SURFACES)[number];
export type IdentityAuditCategory = "browserleaks" | "consistency" | "privacy" | string;

export interface IdentityAuditPage {
  id: string;
  label: string;
  category: IdentityAuditCategory;
  url: string;
  surfaces: IdentityAuditSurface[];
  comparisonNote: string;
  requiresUserAction?: boolean;
}

export interface IdentityAuditExpectedRow {
  surface: IdentityAuditSurface;
  label: string;
  expected: string;
  guidance: string;
}

export interface IdentityAuditGuidance {
  pageId: string;
  pageLabel: string;
  pageUrl: string;
  category: IdentityAuditCategory;
  surfaces: IdentityAuditSurface[];
  advisoryCopy: string[];
  comparisonNote: string;
  requiresUserAction: boolean;
  expectedRows: IdentityAuditExpectedRow[];
}

export const IDENTITY_AUDIT_ADVISORY_COPY = [
  "This guide is advisory and does not promise invisibility, checker success scores, or stable public-page assertions.",
  "Use ThePrivator local proof for contractual app behavior; public pages are manual comparison aids.",
  "Public checker pages can change labels, scoring, collection rules, and exposed fields without notice.",
] as const;

const MAX_EXPECTED_ROWS = SUPPORTED_AUDIT_SURFACES.length;
const SUPPORTED_AUDIT_SURFACE_SET = new Set<string>(SUPPORTED_AUDIT_SURFACES);
const FORBIDDEN_TEXT_MARKERS = [
  "DevToolsActivePort",
  "remote-debugging-port",
  "debug port",
  "ws://",
  "wss://",
  "target id",
  "targetId",
  "--user-data-dir",
  "profile-store",
  "Traceback",
  "guaranteed undetectability",
  "guaranteed green",
  "universal green",
  "universal pass",
  "undetectable",
] as const;

export function buildIdentityAuditGuidance(identity: ProfileIdentity, page: IdentityAuditPage): IdentityAuditGuidance {
  const safePage = validateIdentityAuditPage(page);
  const expectedRows = safePage.surfaces.flatMap((surface) => expectedRowsForSurface(identity, surface));
  if (expectedRows.length > MAX_EXPECTED_ROWS) {
    throw new Error("Audit guidance has too many expected rows.");
  }

  return {
    pageId: safePage.id,
    pageLabel: safePage.label,
    pageUrl: safePage.url,
    category: safePage.category,
    surfaces: [...safePage.surfaces],
    advisoryCopy: IDENTITY_AUDIT_ADVISORY_COPY.map((copy) => assertSafeGuidanceText(copy, "advisory copy")),
    comparisonNote: safePage.comparisonNote,
    requiresUserAction: Boolean(safePage.requiresUserAction),
    expectedRows,
  };
}

export function validateIdentityAuditPage(page: unknown): IdentityAuditPage {
  if (!isRecord(page)) {
    throw new Error("Audit page must be an object.");
  }
  const id = requireSafeString(page.id, "page id", 80);
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error("Audit page id is unsupported.");
  }
  const label = requireSafeString(page.label, "page label", 120);
  const category = requireSafeString(page.category, "page category", 40);
  const url = requireSafeHttpsUrl(page.url);
  const comparisonNote = requireSafeString(page.comparisonNote, "comparison note", 512);
  if (!Array.isArray(page.surfaces) || page.surfaces.length === 0) {
    throw new Error("Audit page must include at least one surface.");
  }
  if (page.surfaces.length > SUPPORTED_AUDIT_SURFACES.length) {
    throw new Error("Audit page lists too many surfaces.");
  }

  const surfaces: IdentityAuditSurface[] = [];
  for (const surface of page.surfaces) {
    if (typeof surface !== "string" || !SUPPORTED_AUDIT_SURFACE_SET.has(surface)) {
      throw new Error("Audit page contains an unsupported surface.");
    }
    if (surfaces.includes(surface as IdentityAuditSurface)) {
      throw new Error("Audit page surfaces must be unique.");
    }
    surfaces.push(surface as IdentityAuditSurface);
  }

  return {
    id,
    label,
    category,
    url,
    surfaces,
    comparisonNote,
    requiresUserAction: Boolean(page.requiresUserAction),
  };
}

function expectedRowsForSurface(identity: ProfileIdentity, surface: IdentityAuditSurface): IdentityAuditExpectedRow[] {
  switch (surface) {
    case "geolocation": {
      if (identity.geolocation.mode === "real") {
        return [
          row(
            surface,
            "Geolocation",
            "The real device position, if the browser is allowed to report one.",
            "A page that reports a position far from the proxy's exit country is a mismatch worth fixing.",
          ),
        ];
      }
      const { latitude, longitude, accuracy, permission } = identity.geolocation;
      return [
        row(
          surface,
          "Geolocation",
          `${latitude}, ${longitude} within ${accuracy} m; permission ${permission}`,
          "Coordinates are rounded to six decimals on purpose: more precision is itself identifying.",
        ),
      ];
    }
    case "mediaDevices": {
      if (identity.mediaDevices.mode === "real") {
        return [row(surface, "Media devices", "The real cameras and microphones.", "Compare the count, not the labels: labels stay empty without permission.")];
      }
      if (identity.mediaDevices.mode === "masked") {
        return [row(surface, "Media devices", "A stable but synthetic device list.", "Device ids should stay the same across reloads of the same profile.")];
      }
      const { videoInputs, audioInputs, audioOutputs } = identity.mediaDevices;
      return [
        row(
          surface,
          "Media devices",
          `${videoInputs} cameras, ${audioInputs} microphones, ${audioOutputs} speakers`,
          "Non-empty labels without a permission prompt would be a signal in themselves.",
        ),
      ];
    }
    case "ports": {
      if (identity.ports.mode === "real") {
        return [row(surface, "Port scanning", "Nothing is blocked.", "A page that scans localhost will reach whatever is listening.")];
      }
      if (identity.ports.mode === "masked") {
        return [row(surface, "Port scanning", "Requests to local ports are refused.", "Only pages outside loopback are affected; local proof pages still work.")];
      }
      return [
        row(
          surface,
          "Port scanning",
          `Only ${identity.ports.allowedPorts.join(", ") || "no"} local ports reachable`,
          "Anything not listed should fail to connect rather than time out.",
        ),
      ];
    }
    case "browser": {
      if (identity.browser.mode === "real") {
        return [row(surface, "Browser", "Real host browser values.", "Compare against the host Chromium values shown by local proof and the public page.")];
      }
      return [row(surface, "Browser / User-Agent", `User-Agent ${identity.browser.userAgent}`, "Compare the full User-Agent string when the checker exposes it.")];
    }
    case "clientHints": {
      if (identity.browser.mode === "real") {
        return [row(surface, "Client Hints", "Real host Client Hints as Chromium exposes them.", "Some high-entropy hints may be unavailable until a site requests them.")];
      }
      const hints = identity.browser.clientHints ?? {};
      const navigatorFallback = identity.navigator.mode === "real" ? undefined : identity.navigator;
      const expectedParts: string[] = [];
      const platform = hints.platform || navigatorFallback?.uaPlatform;
      const platformVersion = hints.platformVersion || navigatorFallback?.uaPlatformVersion;
      const architecture = hints.architecture || navigatorFallback?.uaArchitecture;
      if (platform) {
        expectedParts.push(`platform ${platform}`);
      }
      if (platformVersion) {
        expectedParts.push(`platform version ${platformVersion}`);
      }
      if (architecture) {
        expectedParts.push(`architecture ${architecture}`);
      }
      if (hints.bitness) {
        expectedParts.push(`bitness ${hints.bitness}`);
      }
      if (hints.model) {
        expectedParts.push(`model ${hints.model}`);
      }
      const mobile = typeof hints.mobile === "boolean" ? hints.mobile : navigatorFallback?.uaMobile;
      if (typeof mobile === "boolean") {
        expectedParts.push(`mobile ${String(mobile)}`);
      }
      return [
        row(
          surface,
          "Client Hints",
          expectedParts.length > 0 ? expectedParts.join("; ") : "Configured Client Hints may be absent or withheld by Chromium.",
          "Compare exposed low and high entropy hints; missing fields can be public-checker behavior.",
        ),
      ];
    }
    case "navigator": {
      if (identity.navigator.mode === "real") {
        return [row(surface, "Navigator", "Real host navigator values.", "Compare against local proof and visible navigator fields.")];
      }
      return [
        row(
          surface,
          "Navigator",
          `${identity.navigator.platform}; ${identity.navigator.hardwareConcurrency} cores; ${identity.navigator.deviceMemory} GiB; UA platform ${identity.navigator.uaPlatform}; UA architecture ${identity.navigator.uaArchitecture}; mobile ${String(identity.navigator.uaMobile)}`,
          "Compare navigator.platform, hardwareConcurrency, deviceMemory, and UA metadata where shown.",
        ),
      ];
    }
    case "screen": {
      if (identity.screen.mode === "real") {
        return [row(surface, "Screen", "Real host screen and viewport values.", "Compare screen, viewport, color depth, and device pixel ratio fields.")];
      }
      return [
        row(
          surface,
          "Screen",
          `${identity.screen.width}×${identity.screen.height}; viewport ${identity.screen.viewportWidth}×${identity.screen.viewportHeight}; color depth ${identity.screen.colorDepth}; DPR ${identity.screen.pixelRatio}`,
          "Compare both total screen and viewport dimensions; public pages may label viewport fields differently.",
        ),
      ];
    }
    case "locale": {
      if (identity.locale.mode === "real") {
        return [row(surface, "Locale", "Real host locale, language, and timezone values.", "Compare browser language, languages list, Intl locale, and timezone where available.")];
      }
      return [
        row(
          surface,
          "Locale",
          `locale ${identity.locale.locale}; languages ${identity.locale.languages.join(", ")}; timezone ${identity.locale.timezoneId}`,
          "Compare language ordering and timezone; local clock formatting can vary by checker.",
        ),
      ];
    }
    case "canvas": {
      if (identity.canvas.mode === "real") {
        return [row(surface, "Canvas", "Real host canvas rendering signature.", "Use local proof as the app-side reference; public hashes are not stable contracts.")];
      }
      return [row(surface, "Canvas", "Stable per-profile altered signature from configured noise.", "Do not compare against a known hash; check that repeated visits with this profile remain stable.")];
    }
    case "audio": {
      if (identity.audio.mode === "real") {
        return [row(surface, "Audio", "Real host audio rendering signature.", "Use local proof as the app-side reference; public samples are not stable contracts.")];
      }
      return [row(surface, "Audio", "Stable per-profile altered signature from configured noise.", "Do not compare against a known sample; check that repeated visits with this profile remain stable.")];
    }
    case "webgl": {
      if (identity.webgl.mode === "real") {
        return [row(surface, "WebGL", "Real host WebGL vendor and renderer values.", "Compare visible vendor and renderer strings when exposed.")];
      }
      const expected = `vendor ${identity.webgl.vendor}; renderer ${identity.webgl.renderer}${identity.webgl.noiseSeed === undefined ? "" : "; stable per-profile altered signature from configured noise"}`;
      return [row(surface, "WebGL", expected, "Compare vendor and renderer strings; do not treat a fingerprint hash as a known expected value.")];
    }
    case "webrtc": {
      const expected = identity.webrtc.policy === "real"
        ? "Real host WebRTC behavior."
        : identity.webrtc.policy === "block"
          ? "WebRTC blocked or unavailable to the checker."
          : "No non-proxied UDP or local IP candidate exposure expected.";
      return [row(surface, "WebRTC", expected, "Compare candidate exposure manually; STUN and network behavior can vary by public checker.")];
    }
  }
}

function row(surface: IdentityAuditSurface, label: string, expected: string, guidance: string): IdentityAuditExpectedRow {
  return {
    surface,
    label,
    expected: redactGeneratedText(expected),
    guidance: redactGeneratedText(guidance),
  };
}

function requireSafeString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || containsControlCharacters(value)) {
    throw new Error(`Audit ${field} must be a bounded string.`);
  }
  return assertSafeGuidanceText(value, field);
}

function requireSafeHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) {
    throw new Error("Audit page URL must be a bounded string.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Audit page URL must be valid.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "0.0.0.0") {
    throw new Error("Audit page URL must be a public HTTPS URL.");
  }
  return value;
}

function assertSafeGuidanceText(value: string, field: string): string {
  const lower = value.toLocaleLowerCase();
  if (FORBIDDEN_TEXT_MARKERS.some((marker) => lower.includes(marker.toLocaleLowerCase()))) {
    throw new Error(`Audit ${field} contains unsafe debug or promise language.`);
  }
  return value;
}

function redactGeneratedText(value: string): string {
  let redacted = value;
  redacted = redacted.replace(/wss?:\/\/[^\s;"']+/gi, "[redacted]");
  redacted = redacted.replace(/\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost)\b/gi, "[redacted]");
  redacted = redacted.replace(/:(?:[0-9]{2,5})\b/g, ":[redacted]");
  redacted = redacted.replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "[redacted]");
  for (const marker of FORBIDDEN_TEXT_MARKERS) {
    const markerPattern = new RegExp(escapeRegExp(marker), "gi");
    redacted = redacted.replace(markerPattern, "[redacted]");
  }
  return redacted;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
