import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProfile,
  deleteProfile,
  getChromiumStatus,
  getIdentityAuditPlan,
  applyProfileIdentityPreset,
  getSidecarHealth,
  importLegacyProfiles,
  launchChromiumProfile,
  listIdentityPresets,
  listProfiles,
  lookupDiagnosticDetail,
  openIdentityAuditPage,
  scanLegacyProfiles,
  stopChromiumProfile,
  triggerSidecarDiagnosticFailure,
  updateProfile,
  updateProfileIdentity,
  validateIdentity,
} from "./client";
import { SIDECAR_BRIDGE_ERROR, SIDECAR_PROTOCOL_ERROR, type ProfileIdentity } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

function healthEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-42",
    protocolVersion: "1.0.0",
    durationMs: 2.5,
    result: {
      status: "healthy",
      product: { name: "ThePrivator", version: "2.1.0" },
      sidecar: { version: "0.1.0" },
      protocol: { version: "1.0.0" },
      runtime: { pythonVersion: "3.12.3", implementation: "cpython" },
      platform: { system: "Linux", release: "6.8", machine: "x86_64" },
      build: { mode: "source", frozen: false },
      request: { durationMs: 1.25 },
    },
    ...overrides,
  };
}

function defaultIdentity(overrides: Record<string, unknown> = {}): ProfileIdentity {
  return {
    identityVersion: 1,
    label: "Real identity",
    presetId: null,
    browser: { mode: "real" },
    navigator: { mode: "real" },
    screen: { mode: "real" },
    locale: { mode: "real" },
    canvas: { mode: "real" },
    audio: { mode: "real" },
    webgl: { mode: "real" },
    webrtc: { mode: "real", policy: "real" },
    ...overrides,
  };
}

function presetIdentity(overrides: Record<string, unknown> = {}): ProfileIdentity {
  return {
    identityVersion: 1,
    label: "Windows 10 Chrome 120",
    presetId: "windows-10-chrome-120",
    browser: {
      mode: "masked",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      clientHints: {
        platform: "Windows",
        platformVersion: "10.0.0",
        architecture: "x86",
        mobile: false,
      },
    },
    navigator: {
      mode: "masked",
      platform: "Win32",
      hardwareConcurrency: 8,
      deviceMemory: 8,
      uaPlatform: "Windows",
      uaPlatformVersion: "10.0.0",
      uaArchitecture: "x86",
      uaMobile: false,
    },
    screen: {
      mode: "masked",
      width: 1920,
      height: 1080,
      viewportWidth: 1920,
      viewportHeight: 1032,
      colorDepth: 24,
      pixelRatio: 1,
    },
    locale: {
      mode: "masked",
      locale: "en-US",
      languages: ["en-US", "en"],
      timezoneId: "America/New_York",
    },
    canvas: { mode: "noise", noiseSeed: 120010 },
    audio: { mode: "noise", noiseSeed: 120011 },
    webgl: {
      mode: "masked",
      vendor: "Google Inc. (NVIDIA)",
      renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)",
      noiseSeed: 120012,
    },
    webrtc: { mode: "masked", policy: "disableNonProxiedUdp" },
    ...overrides,
  };
}

function suspiciousIdentity(overrides: Record<string, unknown> = {}): ProfileIdentity {
  return presetIdentity({
    presetId: null,
    label: "Suspicious but saveable",
    navigator: {
      mode: "custom",
      platform: "Win32",
      hardwareConcurrency: 3,
      deviceMemory: 8,
      uaPlatform: "Windows",
      uaPlatformVersion: "10.0.0",
      uaArchitecture: "x86",
      uaMobile: false,
    },
    ...overrides,
  });
}

function identityWarning(overrides: Record<string, unknown> = {}) {
  return {
    code: "IDENTITY_UNUSUAL_CPU",
    message: "Hardware concurrency is valid but uncommon for desktop Chromium.",
    surface: "navigator",
    path: "navigator.hardwareConcurrency",
    ...overrides,
  };
}

function identityEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-identity-1",
    protocolVersion: "1.0.0",
    durationMs: 3.25,
    result,
    ...overrides,
  };
}

function profileRecord(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === "string" ? overrides.id : "11111111-1111-1111-1111-111111111111";
  return {
    id,
    name: "Research",
    createdAt: "2026-05-04T18:00:00.000Z",
    updatedAt: "2026-05-04T18:01:00.000Z",
    defaults: {
      browser: "chromium",
      startUrl: "about:blank",
      proxyMode: "direct",
      fingerprintMode: "disabled",
    },
    storage: {
      profileDir: `profile-store/profiles/${id}`,
      userDataDir: `profile-store/profiles/${id}/user-data`,
    },
    identity: defaultIdentity(),
    ...overrides,
  };
}

function profileResult(overrides: Record<string, unknown> = {}) {
  const profiles = overrides.profiles ?? [profileRecord()];
  return {
    storeVersion: 2,
    profiles,
    count: Array.isArray(profiles) ? profiles.length : 1,
    ...overrides,
  };
}

function profileEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-profiles-1",
    protocolVersion: "1.0.0",
    durationMs: 4.5,
    result,
    ...overrides,
  };
}

function chromiumRunningProfile(overrides: Record<string, unknown> = {}) {
  const profileId = typeof overrides.profileId === "string" ? overrides.profileId : "11111111-1111-1111-1111-111111111111";
  return {
    profileId,
    status: "running",
    pid: 4242,
    startedAt: "2026-05-04T18:05:00.000Z",
    userDataDir: `profile-store/profiles/${profileId}/user-data`,
    ...overrides,
  };
}

function chromiumStoppedProfile(overrides: Record<string, unknown> = {}) {
  const profileId = typeof overrides.profileId === "string" ? overrides.profileId : "11111111-1111-1111-1111-111111111111";
  return {
    profileId,
    status: "stopped",
    stoppedAt: "2026-05-04T18:06:00.000Z",
    termination: "graceful",
    userDataDir: `profile-store/profiles/${profileId}/user-data`,
    ...overrides,
  };
}

function chromiumStatusResult(overrides: Record<string, unknown> = {}) {
  const profiles = overrides.profiles ?? [chromiumRunningProfile()];
  return {
    runningCount: Array.isArray(profiles) ? profiles.length : 1,
    profiles,
    reconciled: [],
    ...overrides,
  };
}

function chromiumEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-chromium-1",
    protocolVersion: "1.0.0",
    durationMs: 6.75,
    result,
    ...overrides,
  };
}

const AUDIT_PROFILE_ID = "11111111-1111-1111-1111-111111111111";

function auditExpectedRow(surface = "browser", overrides: Record<string, unknown> = {}) {
  return {
    surface,
    label: "Browser",
    expected: "Real host browser values.",
    guidance: "Compare visible values manually against ThePrivator local proof.",
    ...overrides,
  };
}

function auditPage(overrides: Record<string, unknown> = {}) {
  return {
    id: "browserleaks-webgl",
    label: "BrowserLeaks WebGL",
    category: "browserleaks",
    url: "https://browserleaks.com/webgl",
    surfaces: ["webgl"],
    comparisonNote: "Compare configured WebGL vendor and renderer when masked or custom; noise only means a stable per-profile altered signature.",
    requiresUserAction: false,
    expectedRows: [auditExpectedRow("webgl", { label: "WebGL", expected: "Real host WebGL vendor and renderer values." })],
    ...overrides,
  };
}

function auditPlanResult(overrides: Record<string, unknown> = {}) {
  const pages = overrides.pages ?? [
    auditPage({
      id: "browserleaks-client-hints",
      label: "BrowserLeaks Client Hints",
      url: "https://browserleaks.com/client-hints",
      surfaces: ["browser", "clientHints"],
      comparisonNote: "Compare User-Agent Client Hints platform, architecture, bitness, model, and mobile flag where the public page exposes them.",
      expectedRows: [auditExpectedRow("browser"), auditExpectedRow("clientHints", { label: "Client Hints" })],
    }),
    auditPage({
      id: "browserleaks-javascript",
      label: "BrowserLeaks JavaScript",
      url: "https://browserleaks.com/javascript",
      surfaces: ["browser", "navigator", "screen", "locale"],
      comparisonNote: "Compare User-Agent, navigator platform and hardware, languages, timezone, screen, and viewport values manually.",
      expectedRows: [auditExpectedRow("browser"), auditExpectedRow("navigator"), auditExpectedRow("screen"), auditExpectedRow("locale")],
    }),
    auditPage({
      id: "browserleaks-canvas",
      label: "BrowserLeaks Canvas",
      url: "https://browserleaks.com/canvas",
      surfaces: ["canvas"],
      comparisonNote: "For noise mode, expect a stable per-profile altered signature rather than a known hash or universal score.",
      expectedRows: [auditExpectedRow("canvas", { label: "Canvas", expected: "Stable per-profile altered signature from configured noise." })],
    }),
    auditPage(),
    auditPage({
      id: "browserleaks-webrtc",
      label: "BrowserLeaks WebRTC",
      url: "https://browserleaks.com/webrtc",
      surfaces: ["webrtc"],
      comparisonNote: "For restricted policies, compare whether non-proxied UDP or local IP candidates are absent; external network behavior is checker-dependent.",
      expectedRows: [auditExpectedRow("webrtc", { label: "WebRTC", expected: "Real host WebRTC behavior." })],
    }),
    auditPage({
      id: "pixelscan-fingerprint-check",
      label: "Pixelscan Fingerprint Check",
      category: "consistency",
      url: "https://pixelscan.net/fingerprint-check",
      surfaces: ["browser", "clientHints", "navigator", "screen", "locale", "canvas", "webgl", "audio", "webrtc"],
      comparisonNote: "Treat flags and scores as advisory consistency hints; compare contradictions instead of treating one score as authoritative.",
      expectedRows: [auditExpectedRow("browser"), auditExpectedRow("clientHints"), auditExpectedRow("navigator"), auditExpectedRow("screen"), auditExpectedRow("locale"), auditExpectedRow("canvas"), auditExpectedRow("webgl"), auditExpectedRow("audio"), auditExpectedRow("webrtc")],
    }),
    auditPage({
      id: "browserscan-browser-checker",
      label: "BrowserScan Browser Checker",
      category: "consistency",
      url: "https://www.browserscan.net/browser-checker",
      surfaces: ["browser", "clientHints", "navigator", "screen", "locale", "canvas", "webgl", "webrtc"],
      comparisonNote: "Use the report as a cross-check for browser, kernel, timezone, and surface mismatches, not as an authoritative result.",
      expectedRows: [auditExpectedRow("browser"), auditExpectedRow("clientHints"), auditExpectedRow("navigator"), auditExpectedRow("screen"), auditExpectedRow("locale"), auditExpectedRow("canvas"), auditExpectedRow("webgl"), auditExpectedRow("webrtc")],
    }),
    auditPage({
      id: "amiunique-fingerprint",
      label: "AmIUnique Fingerprint",
      category: "privacy",
      url: "https://amiunique.org/fingerprint",
      surfaces: ["browser", "clientHints", "navigator", "screen", "locale", "canvas", "webgl", "audio", "webrtc"],
      comparisonNote: "Use attributes and similarity ratios for interpretation; uniqueness reporting is not a pass or fail assertion.",
      expectedRows: [auditExpectedRow("browser"), auditExpectedRow("clientHints"), auditExpectedRow("navigator"), auditExpectedRow("screen"), auditExpectedRow("locale"), auditExpectedRow("canvas"), auditExpectedRow("webgl"), auditExpectedRow("audio"), auditExpectedRow("webrtc")],
    }),
    auditPage({
      id: "cover-your-tracks",
      label: "Cover Your Tracks",
      category: "privacy",
      url: "https://coveryourtracks.eff.org/",
      surfaces: ["browser", "clientHints", "navigator", "canvas", "webgl", "audio", "webrtc"],
      comparisonNote: "The page requires a user-started test and collects anonymous data according to its site copy; use results as privacy guidance only.",
      requiresUserAction: true,
      expectedRows: [auditExpectedRow("browser"), auditExpectedRow("clientHints"), auditExpectedRow("navigator"), auditExpectedRow("canvas"), auditExpectedRow("webgl"), auditExpectedRow("audio"), auditExpectedRow("webrtc")],
    }),
  ];

  return {
    auditVersion: 1,
    copy: {
      advisory: "This guide is advisory and does not promise invisibility, checker success scores, or stable public-page assertions.",
      localProof: "Use ThePrivator local proof for contractual app behavior; public pages are manual comparison aids.",
      publicCheckerInstability: "Public checker pages can change labels, scoring, collection rules, and exposed fields without notice.",
    },
    pages,
    ...overrides,
  };
}

function auditEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-audit-1",
    protocolVersion: "1.0.0",
    durationMs: 7.5,
    result,
    ...overrides,
  };
}

function auditOpenResult(overrides: Record<string, unknown> = {}) {
  return {
    auditVersion: 1,
    profileId: AUDIT_PROFILE_ID,
    pageId: "browserleaks-webgl",
    status: "opened",
    openedAt: "2026-05-04T18:07:00.000Z",
    launched: false,
    runningCount: 1,
    page: auditPage(),
    ...overrides,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function legacyIssue(overrides: Record<string, unknown> = {}) {
  return {
    code: "LEGACY_CONFIG_MISSING",
    message: "Legacy profile config.json is missing.",
    detailRef: "sidecar-legacy-issue",
    ...overrides,
  };
}

function legacyCandidate(overrides: Record<string, unknown> = {}) {
  return {
    legacyId: "legacy-111111111111111111111111",
    folderName: "profile-one",
    legacyName: "Legacy Research",
    targetName: "Legacy Research",
    userData: { status: "available" },
    metadata: {
      source: "legacy-theprivator",
      format: "legacy-profile",
      legacyFolder: "profile-one",
      legacyName: "Legacy Research",
      hasUserData: true,
      formatVersion: "2",
      chromiumVersion: "116.0.0",
      remoteControlPort: 9222,
    },
    issues: [],
    ...overrides,
  };
}

function legacyScanResult(overrides: Record<string, unknown> = {}) {
  const candidates = overrides.candidates ?? [legacyCandidate()];
  return {
    scanVersion: 1,
    count: Array.isArray(candidates) ? candidates.length : 1,
    candidates,
    issues: [],
    ...overrides,
  };
}

function legacyOutcome(overrides: Record<string, unknown> = {}) {
  return {
    legacyId: "legacy-111111111111111111111111",
    targetName: "Imported Research",
    folderName: "profile-one",
    legacyName: "Legacy Research",
    status: "success",
    profileId: "11111111-1111-1111-1111-111111111111",
    copyStatus: "copied",
    ...overrides,
  };
}

function legacyError(overrides: Record<string, unknown> = {}) {
  return {
    code: "LEGACY_SELECTION_INVALID",
    message: "Selected legacy profile was not found in a fresh scan.",
    recoverable: true,
    detailRef: "sidecar-legacy-error",
    ...overrides,
  };
}

function legacyImportResult(overrides: Record<string, unknown> = {}) {
  const outcomes = overrides.outcomes ?? [legacyOutcome()];
  return {
    importVersion: 1,
    requestedCount: Array.isArray(outcomes) ? outcomes.length : 1,
    successCount: Array.isArray(outcomes) ? outcomes.filter((outcome) => (outcome as { status?: unknown })?.status === "success").length : 0,
    partialCount: Array.isArray(outcomes) ? outcomes.filter((outcome) => (outcome as { status?: unknown })?.status === "partial").length : 0,
    failedCount: Array.isArray(outcomes) ? outcomes.filter((outcome) => (outcome as { status?: unknown })?.status === "failed").length : 0,
    outcomes,
    ...overrides,
  };
}

function legacyEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-legacy-1",
    protocolVersion: "1.0.0",
    durationMs: 8.25,
    result,
    ...overrides,
  };
}

function diagnosticEntry(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    ts: "2026-05-04T18:10:00.000Z",
    source: "python-sidecar",
    event: "sidecar.request",
    status: "error",
    requestId: "bridge-diagnostics-1",
    method: "profiles.create",
    durationMs: 3.5,
    errorCode: "PROFILE_DUPLICATE_NAME",
    detailRef: "sidecar-duplicate-detail",
    logPath: "profile-store/diagnostics/events.jsonl",
    ...overrides,
  };
}

function diagnosticLookupResult(overrides: Record<string, unknown> = {}) {
  const detailRef = typeof overrides.detailRef === "string" ? overrides.detailRef : "sidecar-duplicate-detail";
  const entries = overrides.entries ?? [diagnosticEntry({ detailRef })];
  return {
    found: true,
    detailRef,
    logPath: "profile-store/diagnostics/events.jsonl",
    reason: "found",
    entries,
    ...overrides,
  };
}

describe("sidecar client", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("looks up and validates a persisted sidecar diagnostic entry", async () => {
    mockInvoke.mockResolvedValueOnce(diagnosticLookupResult());

    const result = await lookupDiagnosticDetail("sidecar-duplicate-detail");

    expect(mockInvoke).toHaveBeenCalledWith("diagnostics_lookup", { detailRef: "sidecar-duplicate-detail" });
    expect(result).toEqual(diagnosticLookupResult());
  });

  it("validates persisted bridge and legacy diagnostic entry variants", async () => {
    const bridgeEntry = diagnosticEntry({
      source: "rust-bridge",
      event: "sidecar.bridge_failure",
      status: "error",
      method: "health.status",
      errorCode: "SIDECAR_PROTOCOL_ERROR",
      detailRef: "bridge-protocol-detail",
      exitCode: 2,
      stdoutLines: 7,
      stderrLines: 11,
    });
    const legacyEntry = diagnosticEntry({
      source: "python-sidecar",
      event: "legacy.import.outcome",
      status: "failed",
      method: "legacy.import",
      errorCode: "LEGACY_USER_DATA_COPY_FAILED",
      detailRef: "sidecar-legacy-detail",
      context: { legacyId: "legacy-safe-id" },
    });
    mockInvoke
      .mockResolvedValueOnce(diagnosticLookupResult({ detailRef: "bridge-protocol-detail", entries: [bridgeEntry] }))
      .mockResolvedValueOnce(diagnosticLookupResult({ detailRef: "sidecar-legacy-detail", entries: [legacyEntry] }));

    const bridge = await lookupDiagnosticDetail("bridge-protocol-detail");
    const legacy = await lookupDiagnosticDetail("sidecar-legacy-detail");

    expect(bridge.entries[0]).toMatchObject({
      source: "rust-bridge",
      event: "sidecar.bridge_failure",
      detailRef: "bridge-protocol-detail",
      stdoutLines: 7,
      stderrLines: 11,
    });
    expect(legacy.entries[0]).toMatchObject({
      source: "python-sidecar",
      event: "legacy.import.outcome",
      status: "failed",
      detailRef: "sidecar-legacy-detail",
      context: { legacyId: "legacy-safe-id" },
    });
  });

  it("validates no-match and UI-local diagnostic lookup results", async () => {
    const noMatch = diagnosticLookupResult({
      found: false,
      detailRef: "sidecar-not-yet-persisted",
      logPath: "profile-store/diagnostics/events.jsonl",
      reason: "not-persisted",
      entries: [],
    });
    const uiLocal = diagnosticLookupResult({
      found: false,
      detailRef: "ui-protocol-local",
      logPath: null,
      reason: "ui-local",
      entries: [],
    });
    mockInvoke.mockResolvedValueOnce(noMatch).mockResolvedValueOnce(uiLocal);

    await expect(lookupDiagnosticDetail("sidecar-not-yet-persisted")).resolves.toEqual(noMatch);
    await expect(lookupDiagnosticDetail("ui-protocol-local")).resolves.toEqual(uiLocal);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "diagnostics_lookup", { detailRef: "sidecar-not-yet-persisted" });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "diagnostics_lookup", { detailRef: "ui-protocol-local" });
  });

  it.each([
    ["blank", ""],
    ["non-string", undefined as unknown as string],
    ["unsupported prefix", "profile-detail"],
    ["path-like", "sidecar-/tmp/detail"],
  ])("rejects invalid diagnostic lookup detailRef inputs before invoking Tauri: %s", async (_caseName, detailRef) => {
    await expect(lookupDiagnosticDetail(detailRef)).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it.each([
    ["missing response detailRef", diagnosticLookupResult({ detailRef: undefined })],
    ["mismatched response detailRef", diagnosticLookupResult({ detailRef: "sidecar-other-detail" })],
    ["unknown reason", diagnosticLookupResult({ reason: "archived" })],
    ["found without entries", diagnosticLookupResult({ entries: [] })],
    ["missing entries", { found: true, detailRef: "sidecar-duplicate-detail", logPath: "profile-store/diagnostics/events.jsonl", reason: "found" }],
    ["missing entry timestamp", diagnosticLookupResult({ entries: [diagnosticEntry({ ts: undefined })] })],
    ["missing entry detailRef", diagnosticLookupResult({ entries: [diagnosticEntry({ detailRef: undefined })] })],
    ["unknown source", diagnosticLookupResult({ entries: [diagnosticEntry({ source: "webview" })] })],
    ["unknown event", diagnosticLookupResult({ entries: [diagnosticEntry({ event: "sidecar.stdout" })] })],
    ["unknown status", diagnosticLookupResult({ entries: [diagnosticEntry({ status: "warning" })] })],
    ["invalid source-event-status combination", diagnosticLookupResult({ entries: [diagnosticEntry({ source: "rust-bridge", event: "sidecar.request" })] })],
    ["non-finite duration", diagnosticLookupResult({ entries: [diagnosticEntry({ durationMs: Number.POSITIVE_INFINITY })] })],
    ["malformed UI-local response", diagnosticLookupResult({ found: false, detailRef: "ui-protocol-local", logPath: "profile-store/diagnostics/events.jsonl", reason: "not-persisted", entries: [] })],
  ])("maps malformed diagnostic lookup payloads to protocol errors: %s", async (_caseName, payload) => {
    mockInvoke.mockResolvedValueOnce(payload);

    await expect(lookupDiagnosticDetail(_caseName === "malformed UI-local response" ? "ui-protocol-local" : "sidecar-duplicate-detail")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
  });

  it.each([
    ["unsafe response logPath", diagnosticLookupResult({ logPath: "/tmp/events.jsonl" })],
    ["unsafe entry logPath", diagnosticLookupResult({ entries: [diagnosticEntry({ logPath: "https://example.invalid/events.jsonl" })] })],
    ["path-like requestId", diagnosticLookupResult({ entries: [diagnosticEntry({ requestId: "/tmp/profile-root" })] })],
    ["arbitrary legacy context key", diagnosticLookupResult({ entries: [diagnosticEntry({ event: "legacy.import.outcome", status: "failed", method: "legacy.import", context: { legacyId: "legacy-safe-id", rawPath: "/secret" } })] })],
    ["path-like legacy context value", diagnosticLookupResult({ entries: [diagnosticEntry({ event: "legacy.import.outcome", status: "failed", method: "legacy.import", context: { legacyId: "legacy-/secret" } })] })],
  ])("rejects unsafe diagnostic lookup paths and context values: %s", async (_caseName, payload) => {
    mockInvoke.mockResolvedValueOnce(payload);

    await expect(lookupDiagnosticDetail("sidecar-duplicate-detail")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it("normalizes diagnostic lookup command failures into SidecarClientError", async () => {
    mockInvoke
      .mockRejectedValueOnce({
        code: "SIDECAR_CONFIGURATION_ERROR",
        message: "The Tauri app data directory could not be resolved for diagnostics lookup.",
        recoverable: true,
        detailRef: "bridge-config-detail",
      })
      .mockRejectedValueOnce(new Error("invoke failed"));

    await expect(lookupDiagnosticDetail("sidecar-duplicate-detail")).rejects.toMatchObject({
      code: "SIDECAR_CONFIGURATION_ERROR",
      source: "bridge",
      phase: "bridge-error",
      detailRef: "bridge-config-detail",
    });
    await expect(lookupDiagnosticDetail("sidecar-duplicate-detail")).rejects.toMatchObject({
      code: SIDECAR_BRIDGE_ERROR,
      message: "The Tauri bridge rejected the sidecar request before returning a typed error.",
      recoverable: true,
      source: "bridge",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-bridge-/),
    });
  });

  it("loads and validates the sidecar health envelope", async () => {
    mockInvoke.mockResolvedValueOnce(healthEnvelope());

    const health = await getSidecarHealth();

    expect(mockInvoke).toHaveBeenCalledWith("sidecar_health");
    expect(health.requestId).toBe("bridge-42");
    expect(health.protocolVersion).toBe("1.0.0");
    expect(health.bridgeDurationMs).toBe(2.5);
    expect(health.health.product).toEqual({ name: "ThePrivator", version: "2.1.0" });
    expect(health.health.build).toEqual({ mode: "source", frozen: false });
    expect(health.health.request?.durationMs).toBe(1.25);
  });

  it("loads an empty profile list through the fixed Tauri profile command", async () => {
    mockInvoke.mockResolvedValueOnce({
      requestId: "bridge-profiles-1",
      protocolVersion: "1.0.0",
      durationMs: 4.5,
      result: {
        storeVersion: 2,
        profiles: [],
        count: 0,
      },
    });

    const snapshot = await listProfiles();

    expect(mockInvoke).toHaveBeenCalledWith("profiles_list");
    expect(snapshot.requestId).toBe("bridge-profiles-1");
    expect(snapshot.storeVersion).toBe(2);
    expect(snapshot.profiles).toEqual([]);
    expect(snapshot.count).toBe(0);
  });

  it("loads populated profile lists with typed defaults and relative storage", async () => {
    const profile = profileRecord({ name: "Research" });
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult({ profiles: [profile] })));

    const snapshot = await listProfiles();

    expect(snapshot.profiles).toEqual([profile]);
    expect(snapshot.profiles[0].defaults).toEqual({
      browser: "chromium",
      startUrl: "about:blank",
      proxyMode: "direct",
      fingerprintMode: "disabled",
    });
    expect(snapshot.profiles[0].storage).toEqual({
      profileDir: `profile-store/profiles/${profile.id}`,
      userDataDir: `profile-store/profiles/${profile.id}/user-data`,
    });
  });

  it("wraps create, update, and delete with fixed profile command params only", async () => {
    const original = profileRecord({ name: "Research" });
    const renamed = profileRecord({ name: "Renamed", updatedAt: "2026-05-04T18:02:00.000Z" });
    mockInvoke
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profile: original, profiles: [original] })))
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profile: renamed, profiles: [renamed] })))
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profiles: [], count: 0 })));

    const created = await createProfile("Research");
    const updated = await updateProfile(original.id, "Renamed");
    const deleted = await deleteProfile(original.id);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "profiles_create", { name: "Research" });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "profiles_update", { id: original.id, name: "Renamed" });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "profiles_delete", { id: original.id });
    expect(created.profile).toEqual(original);
    expect(updated.profile).toEqual(renamed);
    expect(deleted.profile).toBeUndefined();
    expect(deleted.profiles).toEqual([]);
  });

  it("wraps identity commands with fixed command params and parses structured warnings", async () => {
    const preset = presetIdentity();
    const profile = profileRecord({ identity: preset });
    const suspicious = suspiciousIdentity();
    const suspiciousProfile = profileRecord({ identity: suspicious, updatedAt: "2026-05-04T18:03:00.000Z" });
    const warning = identityWarning();
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope({ identityVersion: 1, presets: [preset], count: 1 }))
      .mockResolvedValueOnce(identityEnvelope({ identityVersion: 1, identity: suspicious, warnings: [warning] }))
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profile, profiles: [profile], warnings: [] })))
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profile: suspiciousProfile, profiles: [suspiciousProfile], warnings: [warning] })));

    const presets = await listIdentityPresets();
    const validation = await validateIdentity(suspicious);
    const applied = await applyProfileIdentityPreset(profile.id, "windows-10-chrome-120");
    const updated = await updateProfileIdentity(profile.id, suspicious);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "identity_presets_list");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "identity_validate", { identity: suspicious });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "profiles_identity_apply_preset", {
      profileId: profile.id,
      presetId: "windows-10-chrome-120",
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(4, "profiles_identity_update", {
      profileId: profile.id,
      identity: suspicious,
    });
    expect(presets.presets).toEqual([preset]);
    expect(validation.warnings).toEqual([warning]);
    expect(applied.profile.identity.presetId).toBe("windows-10-chrome-120");
    expect(applied.warnings).toEqual([]);
    expect(updated.profile.identity).toEqual(suspicious);
    expect(updated.warnings).toEqual([warning]);
  });

  it("scans legacy profiles through the fixed Tauri command and validates nested candidates", async () => {
    const candidate = legacyCandidate({ issues: [legacyIssue()] });
    mockInvoke.mockResolvedValueOnce(legacyEnvelope(legacyScanResult({ candidates: [candidate] })));

    const snapshot = await scanLegacyProfiles("/user/chosen/legacy-root");

    expect(mockInvoke).toHaveBeenCalledWith("legacy_scan_profiles", { legacyRoot: "/user/chosen/legacy-root" });
    expect(snapshot.requestId).toBe("bridge-legacy-1");
    expect(snapshot.scanVersion).toBe(1);
    expect(snapshot.count).toBe(1);
    expect(snapshot.candidates[0]).toEqual(candidate);
    expect(snapshot.candidates[0].issues[0]).toMatchObject({
      code: "LEGACY_CONFIG_MISSING",
      detailRef: "sidecar-legacy-issue",
    });
  });

  it("imports selected legacy profiles through the fixed Tauri command and validates outcome variants", async () => {
    const success = legacyOutcome({ legacyId: "legacy-success", targetName: "Imported Success", status: "success", copyStatus: "copied" });
    const partial = legacyOutcome({
      legacyId: "legacy-partial",
      targetName: "Imported Partial",
      status: "partial",
      copyStatus: "failed",
      error: legacyError({ code: "LEGACY_USER_DATA_COPY_FAILED" }),
    });
    const failed = legacyOutcome({
      legacyId: "legacy-failed",
      targetName: "Imported Failed",
      status: "failed",
      copyStatus: "skipped",
      profileId: undefined,
      error: legacyError({ code: "LEGACY_SELECTION_INVALID" }),
    });
    mockInvoke.mockResolvedValueOnce(legacyEnvelope(legacyImportResult({ outcomes: [success, partial, failed] })));

    const snapshot = await importLegacyProfiles("/user/chosen/legacy-root", [
      { legacyId: "legacy-success", targetName: "Imported Success" },
      { legacyId: "legacy-partial", targetName: "Imported Partial" },
      { legacyId: "legacy-failed", targetName: "Imported Failed" },
    ]);

    expect(mockInvoke).toHaveBeenCalledWith("legacy_import_profiles", {
      legacyRoot: "/user/chosen/legacy-root",
      items: [
        { legacyId: "legacy-success", targetName: "Imported Success" },
        { legacyId: "legacy-partial", targetName: "Imported Partial" },
        { legacyId: "legacy-failed", targetName: "Imported Failed" },
      ],
    });
    expect(snapshot.requestedCount).toBe(3);
    expect(snapshot.successCount).toBe(1);
    expect(snapshot.partialCount).toBe(1);
    expect(snapshot.failedCount).toBe(1);
    expect(snapshot.outcomes.map((outcome) => outcome.status)).toEqual(["success", "partial", "failed"]);
    expect(snapshot.outcomes[1]).toMatchObject({
      copyStatus: "failed",
      error: { code: "LEGACY_USER_DATA_COPY_FAILED", detailRef: "sidecar-legacy-error" },
    });
  });

  it.each([
    ["missing candidate legacyId", legacyEnvelope(legacyScanResult({ candidates: [legacyCandidate({ legacyId: "" })] })), () => scanLegacyProfiles("/legacy")],
    ["invalid candidate user-data status", legacyEnvelope(legacyScanResult({ candidates: [legacyCandidate({ userData: { status: "unknown" } })] })), () => scanLegacyProfiles("/legacy")],
    ["non-array import items", legacyEnvelope(legacyImportResult({ outcomes: {} })), () => importLegacyProfiles("/legacy", [])],
    ["unknown outcome status", legacyEnvelope(legacyImportResult({ outcomes: [legacyOutcome({ status: "done" })] })), () => importLegacyProfiles("/legacy", [])],
    ["unknown copy status", legacyEnvelope(legacyImportResult({ outcomes: [legacyOutcome({ copyStatus: "linked" })] })), () => importLegacyProfiles("/legacy", [])],
    ["missing outcome error detailRef", legacyEnvelope(legacyImportResult({ outcomes: [legacyOutcome({ status: "failed", copyStatus: "skipped", profileId: undefined, error: legacyError({ detailRef: undefined }) })] })), () => importLegacyProfiles("/legacy", [])],
    ["legacy count mismatch", legacyEnvelope(legacyScanResult({ count: 2 })), () => scanLegacyProfiles("/legacy")],
    ["unknown protocol version", legacyEnvelope(legacyScanResult(), { protocolVersion: "9.9.9" }), () => scanLegacyProfiles("/legacy")],
  ])("maps malformed legacy payloads to protocol errors: %s", async (_caseName, envelope, callClient) => {
    mockInvoke.mockResolvedValueOnce(envelope);

    await expect(callClient()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
  });

  it.each([
    ["LEGACY_ROOT_INVALID", "Legacy root must be an existing directory.", () => scanLegacyProfiles("/missing")],
    ["LEGACY_SELECTION_INVALID", "Legacy import selection is invalid.", () => importLegacyProfiles("/legacy", [])],
    ["PROFILE_DUPLICATE_NAME", "Profile name already exists.", () => importLegacyProfiles("/legacy", [])],
  ])("preserves typed recoverable legacy errors: %s", async (code, message, callClient) => {
    mockInvoke.mockRejectedValueOnce({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-legacy-detail",
    });

    await expect(callClient()).rejects.toMatchObject({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-legacy-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
  });

  it("loads an empty Chromium status through the fixed Tauri lifecycle command", async () => {
    mockInvoke.mockResolvedValueOnce(chromiumEnvelope(chromiumStatusResult({ profiles: [], runningCount: 0 })));

    const snapshot = await getChromiumStatus();

    expect(mockInvoke).toHaveBeenCalledWith("chromium_status");
    expect(snapshot.requestId).toBe("bridge-chromium-1");
    expect(snapshot.protocolVersion).toBe("1.0.0");
    expect(snapshot.bridgeDurationMs).toBe(6.75);
    expect(snapshot.runningCount).toBe(0);
    expect(snapshot.profiles).toEqual([]);
    expect(snapshot.reconciled).toEqual([]);
  });

  it("wraps launch and stop with fixed Chromium command params only", async () => {
    const running = chromiumRunningProfile();
    const stopped = chromiumStoppedProfile({ termination: "forced" });
    mockInvoke
      .mockResolvedValueOnce(chromiumEnvelope({ ...running, runningCount: 1 }))
      .mockResolvedValueOnce(chromiumEnvelope({ ...stopped, runningCount: 0 }));

    const launch = await launchChromiumProfile(running.profileId);
    const stop = await stopChromiumProfile(stopped.profileId);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "chromium_launch", { profileId: running.profileId });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "chromium_stop", { profileId: stopped.profileId });
    expect(launch).toMatchObject({
      profileId: running.profileId,
      status: "running",
      pid: 4242,
      startedAt: "2026-05-04T18:05:00.000Z",
      userDataDir: running.userDataDir,
      runningCount: 1,
    });
    expect(stop).toMatchObject({
      profileId: stopped.profileId,
      status: "stopped",
      termination: "forced",
      stoppedAt: "2026-05-04T18:06:00.000Z",
      userDataDir: stopped.userDataDir,
      runningCount: 0,
    });
  });

  it("validates populated Chromium status with running and reconciled profile states", async () => {
    const running = chromiumRunningProfile();
    const reconciled = chromiumStoppedProfile({ termination: "reconciled" });
    mockInvoke.mockResolvedValueOnce(
      chromiumEnvelope(chromiumStatusResult({ profiles: [running], reconciled: [reconciled] })),
    );

    const snapshot = await getChromiumStatus();

    expect(snapshot.runningCount).toBe(1);
    expect(snapshot.profiles).toEqual([running]);
    expect(snapshot.reconciled).toEqual([reconciled]);
  });

  it.each([
    ["empty profile id", chromiumEnvelope(chromiumStatusResult({ profiles: [chromiumRunningProfile({ profileId: "" })] })), getChromiumStatus],
    ["malformed pid", chromiumEnvelope({ ...chromiumRunningProfile({ pid: "4242" }), runningCount: 1 }), () => launchChromiumProfile("11111111-1111-1111-1111-111111111111")],
    ["non-positive pid", chromiumEnvelope({ ...chromiumRunningProfile({ pid: 0 }), runningCount: 1 }), () => launchChromiumProfile("11111111-1111-1111-1111-111111111111")],
    ["bad started timestamp", chromiumEnvelope({ ...chromiumRunningProfile({ startedAt: "2026-05-04 18:05" }), runningCount: 1 }), () => launchChromiumProfile("11111111-1111-1111-1111-111111111111")],
    ["unknown running status", chromiumEnvelope(chromiumStatusResult({ profiles: [chromiumRunningProfile({ status: "starting" })] })), getChromiumStatus],
    ["unknown termination", chromiumEnvelope({ ...chromiumStoppedProfile({ termination: "sigterm" }), runningCount: 0 }), () => stopChromiumProfile("11111111-1111-1111-1111-111111111111")],
    ["absolute userDataDir", chromiumEnvelope(chromiumStatusResult({ profiles: [chromiumRunningProfile({ userDataDir: "/tmp/profile/user-data" })] })), getChromiumStatus],
    ["missing running count", chromiumEnvelope({ profiles: [], reconciled: [] }), getChromiumStatus],
    ["launch running count zero", chromiumEnvelope({ ...chromiumRunningProfile(), runningCount: 0 }), () => launchChromiumProfile("11111111-1111-1111-1111-111111111111")],
    ["non-array running profiles", chromiumEnvelope(chromiumStatusResult({ profiles: {} })), getChromiumStatus],
    ["non-array reconciled profiles", chromiumEnvelope(chromiumStatusResult({ profiles: [], reconciled: {} })), getChromiumStatus],
    ["running count mismatch", chromiumEnvelope(chromiumStatusResult({ profiles: [chromiumRunningProfile()], runningCount: 2 })), getChromiumStatus],
  ])("maps malformed Chromium runtime payloads to protocol errors: %s", async (_caseName, envelope, callClient) => {
    mockInvoke.mockResolvedValueOnce(envelope);

    await expect(callClient()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
  });

  it.each([
    ["CHROMIUM_EXECUTABLE_NOT_FOUND", "Chromium executable was not found.", () => launchChromiumProfile("profile-id")],
    ["CHROMIUM_ALREADY_RUNNING", "Chromium is already running for this profile.", () => launchChromiumProfile("profile-id")],
    ["CHROMIUM_STOP_FAILED", "Chromium process could not be stopped.", () => stopChromiumProfile("profile-id")],
    ["PROFILE_NOT_FOUND", "Profile not found.", () => launchChromiumProfile("missing-profile")],
  ])("preserves typed recoverable Chromium lifecycle errors: %s", async (code, message, callClient) => {
    mockInvoke.mockRejectedValueOnce({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-chromium-detail",
    });

    await expect(callClient()).rejects.toMatchObject({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-chromium-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
  });

  it("preserves typed bridge and protocol errors for Chromium lifecycle calls", async () => {
    mockInvoke
      .mockRejectedValueOnce({
        code: "SIDECAR_TIMEOUT",
        message: "The Python sidecar did not respond before the bridge timeout.",
        recoverable: true,
        detailRef: "bridge-timeout-detail",
      })
      .mockRejectedValueOnce({
        code: SIDECAR_PROTOCOL_ERROR,
        message: "The Python sidecar returned malformed JSON.",
        recoverable: true,
        detailRef: "bridge-protocol-detail",
      });

    await expect(getChromiumStatus()).rejects.toMatchObject({
      code: "SIDECAR_TIMEOUT",
      source: "bridge",
      phase: "bridge-error",
      detailRef: "bridge-timeout-detail",
    });
    await expect(launchChromiumProfile("profile-id")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
      detailRef: "bridge-protocol-detail",
    });
  });

  it("loads the fixed identity audit plan through a safe Tauri command wrapper", async () => {
    mockInvoke.mockResolvedValueOnce(auditEnvelope(auditPlanResult()));

    const snapshot = await getIdentityAuditPlan(AUDIT_PROFILE_ID);

    expect(mockInvoke).toHaveBeenCalledWith("identity_audit_plan", { profileId: AUDIT_PROFILE_ID });
    expect(snapshot).toMatchObject({
      auditVersion: 1,
      requestId: "bridge-audit-1",
      protocolVersion: "1.0.0",
      bridgeDurationMs: 7.5,
    });
    expect(snapshot.pages).toHaveLength(9);
    expect(snapshot.pages.map((page) => page.id)).toContain("cover-your-tracks");
    expect(snapshot.pages.find((page) => page.id === "cover-your-tracks")?.requiresUserAction).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/targetId|debugPort|webSocketDebuggerUrl|storeRoot|extensionDir|DevToolsActivePort|ws:\/\//i);
  });

  it("opens an audit catalog page through safe profile/page identifiers only", async () => {
    mockInvoke
      .mockResolvedValueOnce(auditEnvelope(auditOpenResult({ launched: false })))
      .mockResolvedValueOnce(auditEnvelope(auditOpenResult({ launched: true, runningCount: 1 })));

    const existing = await openIdentityAuditPage(AUDIT_PROFILE_ID, "browserleaks-webgl");
    const launched = await openIdentityAuditPage(AUDIT_PROFILE_ID, "browserleaks-webgl");

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "identity_audit_open", {
      profileId: AUDIT_PROFILE_ID,
      pageId: "browserleaks-webgl",
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "identity_audit_open", {
      profileId: AUDIT_PROFILE_ID,
      pageId: "browserleaks-webgl",
    });
    expect(existing).toMatchObject({
      auditVersion: 1,
      profileId: AUDIT_PROFILE_ID,
      pageId: "browserleaks-webgl",
      status: "opened",
      openedAt: "2026-05-04T18:07:00.000Z",
      launched: false,
      runningCount: 1,
    });
    expect(launched.launched).toBe(true);
    expect(existing.page.url).toBe("https://browserleaks.com/webgl");
    expect(JSON.stringify(existing)).not.toMatch(/pid|userDataDir|targetId|debugPort|webSocketDebuggerUrl|storeRoot|command|extensionDir|ws:\/\//i);
  });

  it.each([
    ["empty profile id", null, () => getIdentityAuditPlan(" ")],
    ["empty page id", null, () => openIdentityAuditPage(AUDIT_PROFILE_ID, "")],
    ["mismatched open profile id", () => auditEnvelope(auditOpenResult({ profileId: "22222222-2222-2222-2222-222222222222" })), () => openIdentityAuditPage(AUDIT_PROFILE_ID, "browserleaks-webgl")],
    ["mismatched open page id", () => auditEnvelope(auditOpenResult({ pageId: "browserleaks-canvas" })), () => openIdentityAuditPage(AUDIT_PROFILE_ID, "browserleaks-webgl")],
    ["plan page count mismatch", () => auditEnvelope(auditPlanResult({ pages: (auditPlanResult().pages as unknown[]).slice(0, 8) })), () => getIdentityAuditPlan(AUDIT_PROFILE_ID)],
    ["duplicate catalog ids", () => {
      const plan = cloneJson(auditPlanResult()) as unknown as { pages: Array<Record<string, unknown>> };
      plan.pages[1].id = plan.pages[0].id;
      return auditEnvelope(plan);
    }, () => getIdentityAuditPlan(AUDIT_PROFILE_ID)],
    ["invalid audit URL protocol", () => {
      const plan = cloneJson(auditPlanResult()) as unknown as { pages: Array<Record<string, unknown>> };
      plan.pages[3].url = "http://browserleaks.com/webgl";
      return auditEnvelope(plan);
    }, () => getIdentityAuditPlan(AUDIT_PROFILE_ID)],
    ["unknown audit page field", () => auditEnvelope(auditOpenResult({ targetId: "page-target" })), () => openIdentityAuditPage(AUDIT_PROFILE_ID, "browserleaks-webgl")],
    ["unsafe audit guidance string", () => {
      const result = cloneJson(auditOpenResult()) as { page: { expectedRows: Array<Record<string, unknown>> } };
      result.page.expectedRows[0].guidance = "Open ws://127.0.0.1:9222/json for details.";
      return auditEnvelope(result);
    }, () => openIdentityAuditPage(AUDIT_PROFILE_ID, "browserleaks-webgl")],
    ["negative running count", () => auditEnvelope(auditOpenResult({ runningCount: -1 })), () => openIdentityAuditPage(AUDIT_PROFILE_ID, "browserleaks-webgl")],
  ] as Array<[string, null | (() => unknown), () => Promise<unknown>]>)("maps malformed audit payloads to protocol errors: %s", async (_caseName, envelopeFactory, callClient) => {
    if (envelopeFactory) {
      mockInvoke.mockResolvedValueOnce(envelopeFactory());
    }

    await expect(callClient()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });

    if (!envelopeFactory) {
      expect(mockInvoke).not.toHaveBeenCalled();
    }
  });

  it.each(["targetId", "debugPort", "webSocketDebuggerUrl", "storeRoot", "command", "extensionDir"])(
    "rejects forbidden raw audit runtime field %s before UI state sees it",
    async (field) => {
      mockInvoke.mockResolvedValueOnce(auditEnvelope(auditOpenResult({ [field]: "unsafe-runtime-detail" })));

      await expect(openIdentityAuditPage(AUDIT_PROFILE_ID, "browserleaks-webgl")).rejects.toMatchObject({
        code: SIDECAR_PROTOCOL_ERROR,
        source: "protocol",
        phase: "bridge-error",
      });
    },
  );

  it("preserves typed sidecar and bridge errors for identity audit wrappers", async () => {
    mockInvoke
      .mockRejectedValueOnce({
        code: "IDENTITY_AUDIT_PAGE_NOT_FOUND",
        message: "Audit page was not found.",
        recoverable: true,
        detailRef: "sidecar-audit-detail",
      })
      .mockRejectedValueOnce({
        code: "SIDECAR_TIMEOUT",
        message: "The Python sidecar did not respond before the bridge timeout.",
        recoverable: true,
        detailRef: "bridge-audit-timeout",
      });

    await expect(openIdentityAuditPage(AUDIT_PROFILE_ID, "missing-page")).rejects.toMatchObject({
      code: "IDENTITY_AUDIT_PAGE_NOT_FOUND",
      message: "Audit page was not found.",
      recoverable: true,
      detailRef: "sidecar-audit-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
    await expect(getIdentityAuditPlan(AUDIT_PROFILE_ID)).rejects.toMatchObject({
      code: "SIDECAR_TIMEOUT",
      source: "bridge",
      phase: "bridge-error",
      detailRef: "bridge-audit-timeout",
    });
  });

  it.each([
    ["malformed envelope", { protocolVersion: "1.0.0", durationMs: 4.5, result: profileResult() }],
    ["stale v1 store version", profileEnvelope(profileResult({ storeVersion: 1 }))],
    ["wrong profiles item type", profileEnvelope(profileResult({ profiles: ["not-a-profile"] }))],
    ["missing defaults", profileEnvelope(profileResult({ profiles: [profileRecord({ defaults: undefined })] }))],
    ["missing identity", profileEnvelope(profileResult({ profiles: [profileRecord({ identity: undefined })] }))],
    ["unknown identity surface mode", profileEnvelope(profileResult({ profiles: [profileRecord({ identity: defaultIdentity({ browser: { mode: "private" } }) })] }))],
    ["invalid language array", profileEnvelope(profileResult({ profiles: [profileRecord({ identity: presetIdentity({ locale: { mode: "masked", locale: "en-US", languages: ["not a tag"], timezoneId: "America/New_York" } }) })] }))],
    ["invalid noise seed", profileEnvelope(profileResult({ profiles: [profileRecord({ identity: presetIdentity({ canvas: { mode: "noise", noiseSeed: 1000001 } }) })] }))],
    ["missing relative storage fields", profileEnvelope(profileResult({ profiles: [profileRecord({ storage: {} })] }))],
    ["absolute storage path", profileEnvelope(profileResult({ profiles: [profileRecord({ storage: { profileDir: "/tmp/profile", userDataDir: "/tmp/profile/user-data" } })] }))],
    ["non-number count", profileEnvelope(profileResult({ count: "one" }))],
    ["non-string timestamp", profileEnvelope(profileResult({ profiles: [profileRecord({ createdAt: 42 })] }))],
  ])("maps malformed profile payloads to protocol errors: %s", async (_caseName, envelope) => {
    mockInvoke.mockResolvedValueOnce(envelope);

    await expect(listProfiles()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
  });

  it.each([
    [
      "malformed preset list warning-free contract",
      identityEnvelope({ identityVersion: 1, presets: [presetIdentity({ presetId: null })], count: 1 }),
      () => listIdentityPresets(),
    ],
    [
      "warning missing code",
      identityEnvelope({ identityVersion: 1, identity: suspiciousIdentity(), warnings: [identityWarning({ code: undefined })] }),
      () => validateIdentity(suspiciousIdentity()),
    ],
    [
      "warning missing surface",
      profileEnvelope(profileResult({ profile: profileRecord(), profiles: [profileRecord()], warnings: [identityWarning({ surface: undefined })] })),
      () => updateProfileIdentity("11111111-1111-1111-1111-111111111111", defaultIdentity()),
    ],
    [
      "warning missing message",
      profileEnvelope(profileResult({ profile: profileRecord(), profiles: [profileRecord()], warnings: [identityWarning({ message: undefined })] })),
      () => updateProfileIdentity("11111111-1111-1111-1111-111111111111", defaultIdentity()),
    ],
    [
      "apply preset response presetId mismatch",
      profileEnvelope(profileResult({
        profile: profileRecord({ identity: presetIdentity({ presetId: "ubuntu-linux-chrome-120" }) }),
        profiles: [profileRecord({ identity: presetIdentity({ presetId: "ubuntu-linux-chrome-120" }) })],
        warnings: [],
      })),
      () => applyProfileIdentityPreset("11111111-1111-1111-1111-111111111111", "windows-10-chrome-120"),
    ],
    [
      "missing profile in identity mutation result",
      profileEnvelope(profileResult({ profiles: [profileRecord()], warnings: [] })),
      () => updateProfileIdentity("11111111-1111-1111-1111-111111111111", defaultIdentity()),
    ],
    [
      "malformed identity command envelope",
      { protocolVersion: "1.0.0", durationMs: 3.25, result: { identityVersion: 1, presets: [], count: 0 } },
      () => listIdentityPresets(),
    ],
    [
      "unknown protocol version",
      identityEnvelope({ identityVersion: 1, presets: [], count: 0 }, { protocolVersion: "9.9.9" }),
      () => listIdentityPresets(),
    ],
  ])("maps malformed identity payloads to protocol errors: %s", async (_caseName, envelope, callClient) => {
    mockInvoke.mockResolvedValueOnce(envelope);

    await expect(callClient()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
  });

  it.each([
    ["IDENTITY_INVALID", "Identity payload must be a JSON object.", () => validateIdentity(defaultIdentity())],
    ["IDENTITY_PRESET_NOT_FOUND", "Identity preset was not found.", () => applyProfileIdentityPreset("profile-id", "missing-preset")],
    ["IDENTITY_UNSUPPORTED_MODE", "Identity surface does not support that mode.", () => updateProfileIdentity("profile-id", defaultIdentity())],
  ])("preserves typed recoverable identity errors: %s", async (code, message, callClient) => {
    mockInvoke.mockRejectedValueOnce({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-identity-detail",
    });

    await expect(callClient()).rejects.toMatchObject({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-identity-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
  });

  it.each([
    ["PROFILE_INVALID_NAME", "Profile name is invalid."],
    ["PROFILE_DUPLICATE_NAME", "Profile name already exists."],
  ])("preserves typed recoverable profile errors: %s", async (code, message) => {
    mockInvoke.mockRejectedValueOnce({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-profile-detail",
    });

    await expect(createProfile("Research")).rejects.toMatchObject({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-profile-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
  });

  it("preserves typed bridge timeout errors for profile calls", async () => {
    mockInvoke.mockRejectedValueOnce({
      code: "SIDECAR_TIMEOUT",
      message: "The Python sidecar did not respond before the bridge timeout.",
      recoverable: true,
      detailRef: "bridge-timeout-detail",
    });

    await expect(listProfiles()).rejects.toMatchObject({
      code: "SIDECAR_TIMEOUT",
      source: "bridge",
      phase: "bridge-error",
      detailRef: "bridge-timeout-detail",
    });
  });

  it("rejects create/update mutation results missing the changed profile", async () => {
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult({ profiles: [profileRecord()] })));

    await expect(createProfile("Research")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it("rejects mutation profile objects that are absent from the refreshed list", async () => {
    const changed = profileRecord({ id: "22222222-2222-2222-2222-222222222222", name: "Changed" });
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult({ profile: changed, profiles: [profileRecord()] })));

    await expect(updateProfile(changed.id, changed.name)).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it("maps malformed health envelopes to a recoverable protocol error", async () => {
    mockInvoke.mockResolvedValueOnce(healthEnvelope({ result: { status: "healthy" } }));

    await expect(getSidecarHealth()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it("preserves typed bridge rejections from Tauri invoke", async () => {
    mockInvoke.mockRejectedValueOnce({
      code: "SIDECAR_UNAVAILABLE",
      message: "The Python sidecar binary is unavailable. Run npm run sidecar:build and retry.",
      recoverable: true,
      detailRef: "bridge-detail-1",
    });

    await expect(getSidecarHealth()).rejects.toMatchObject({
      code: "SIDECAR_UNAVAILABLE",
      message: expect.stringContaining("sidecar binary"),
      detailRef: "bridge-detail-1",
      source: "bridge",
      phase: "bridge-error",
    });
  });

  it("normalizes untyped invoke rejections into a bridge error", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("webview invoke failed"));

    await expect(getSidecarHealth()).rejects.toMatchObject({
      code: "SIDECAR_BRIDGE_ERROR",
      message: "The Tauri bridge rejected the sidecar request before returning a typed error.",
      recoverable: true,
      source: "bridge",
      phase: "bridge-error",
    });
  });

  it("surfaces the deliberate sidecar diagnostic failure as recoverable", async () => {
    mockInvoke.mockRejectedValueOnce({
      code: "DIAGNOSTIC_FAILURE",
      message: "Diagnostic failure requested.",
      recoverable: true,
      detailRef: "sidecar-test-detail",
    });

    await expect(triggerSidecarDiagnosticFailure()).rejects.toMatchObject({
      code: "DIAGNOSTIC_FAILURE",
      message: "Diagnostic failure requested.",
      detailRef: "sidecar-test-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
    expect(mockInvoke).toHaveBeenCalledWith("sidecar_diagnostic_failure");
  });

  it("treats an unexpectedly successful diagnostic command as a protocol error", async () => {
    mockInvoke.mockResolvedValueOnce(healthEnvelope());

    await expect(triggerSidecarDiagnosticFailure()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });
  });
});
