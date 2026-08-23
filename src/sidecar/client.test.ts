import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyProfileIdentityPreset,
  checkProfileProxy,
  collectIdentityAuditResults,
  copyAutomationApiToken,
  createProfile,
  deleteProfile,
  describeIdentitySurfaces,
  exportProfileCookies,
  exportProfilePackage,
  getAutomationApiStatus,
  getChromiumStatus,
  getIdentityAuditPlan,
  getSidecarHealth,
  importLegacyProfiles,
  importProfilePackage,
  launchChromiumProfile,
  listIdentityPresets,
  listProfiles,
  lookupDiagnosticDetail,
  openIdentityAuditPage,
  replaceProfileCookies,
  scanLegacyProfiles,
  startAutomationApi,
  stopAutomationApi,
  stopChromiumProfile,
  triggerSidecarDiagnosticFailure,
  updateProfile,
  updateProfileIdentity,
  updateProfileProxy,
  validateIdentity,
  validateProxy,
} from "./client";
import { SIDECAR_BRIDGE_ERROR, SIDECAR_PROTOCOL_ERROR, type CookieExportFormat, type ProfileIdentity, type ProfileProxyDraft } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

const PROXY_CHECK_PROFILE_ID = "11111111-1111-1111-1111-111111111111";
const COOKIE_PROFILE_ID = "22222222-2222-2222-2222-222222222222";
const PACKAGE_PROFILE_ID = "33333333-3333-3333-3333-333333333333";
const IMPORTED_PACKAGE_PROFILE_ID = "44444444-4444-4444-4444-444444444444";

function cookieWarning(overrides: Record<string, unknown> = {}) {
  return {
    code: "NETSCAPE_METADATA_OMITTED",
    message: "Some cookie metadata is not represented by Netscape cookies.txt and was omitted from that export.",
    count: 2,
    ...overrides,
  };
}

function cookieExportResult(overrides: Record<string, unknown> = {}) {
  return {
    portabilityVersion: 1,
    profileId: COOKIE_PROFILE_ID,
    operation: "export",
    format: "netscape",
    exportedCount: 3,
    skippedCount: 1,
    warningCount: 1,
    warnings: [cookieWarning()],
    ...overrides,
  };
}

function cookieReplaceResult(overrides: Record<string, unknown> = {}) {
  return {
    portabilityVersion: 1,
    profileId: COOKIE_PROFILE_ID,
    operation: "replace",
    format: "theprivator-json",
    importedCount: 4,
    replacedCount: 2,
    skippedCount: 1,
    warningCount: 1,
    warnings: [cookieWarning({ code: "IMPORT_DUPLICATE_REPLACED", message: "Duplicate imported cookies were resolved deterministically by domain, path, and name.", count: 1 })],
    ...overrides,
  };
}

function cookieEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-cookie-1",
    protocolVersion: "1.0.0",
    durationMs: 9.5,
    result,
    ...overrides,
  };
}

function tooManyCookieWarnings() {
  return Array.from({ length: 21 }, (_item, index) =>
    cookieWarning({ code: `COOKIE_ROW_UNSUPPORTED_${index}`, message: `Safe warning ${index}.`, count: 1 }),
  );
}

function profilePackageWarning(overrides: Record<string, unknown> = {}) {
  return {
    code: "PACKAGE_PAYLOAD_RUNTIME_SKIPPED",
    message: "Volatile Chromium runtime files were skipped from the package.",
    count: 2,
    ...overrides,
  };
}

function profilePackageExportResult(overrides: Record<string, unknown> = {}) {
  return {
    packageVersion: 2,
    format: "theprivator.profile-package",
    operation: "export",
    profileId: PACKAGE_PROFILE_ID,
    profileName: "Research",
    cookieCount: 3,
    skippedCookieCount: 1,
    payloadFileCount: 4,
    payloadByteCount: 8192,
    warningCount: 1,
    warnings: [profilePackageWarning()],
    ...overrides,
  };
}

function profilePackageImportProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: IMPORTED_PACKAGE_PROFILE_ID,
    name: "Research Copy",
    storage: {
      profileDir: `profile-store/profiles/${IMPORTED_PACKAGE_PROFILE_ID}`,
      userDataDir: `profile-store/profiles/${IMPORTED_PACKAGE_PROFILE_ID}/user-data`,
    },
    ...overrides,
  };
}

function profilePackageImportResult(overrides: Record<string, unknown> = {}) {
  const profile = overrides.profile ?? profilePackageImportProfile();
  const profileId = typeof overrides.profileId === "string" ? overrides.profileId : IMPORTED_PACKAGE_PROFILE_ID;
  const profileName = typeof overrides.profileName === "string" ? overrides.profileName : "Research Copy";
  return {
    packageVersion: 2,
    format: "theprivator.profile-package",
    operation: "import",
    profileId,
    profileName,
    nameConflictResolved: true,
    profile,
    cookieCount: 3,
    importedCookieCount: 3,
    replacedCookieCount: 0,
    payloadFileCount: 4,
    payloadByteCount: 8192,
    warningCount: 1,
    warnings: [profilePackageWarning()],
    ...overrides,
  };
}

function profilePackageEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-package-1",
    protocolVersion: "1.0.0",
    durationMs: 12.25,
    result,
    ...overrides,
  };
}

function tooManyProfilePackageWarnings() {
  return Array.from({ length: 21 }, (_item, index) =>
    profilePackageWarning({ code: `PACKAGE_SAFE_WARNING_${index}`, message: `Safe package warning ${index}.`, count: 1 }),
  );
}

const UNSAFE_PROFILE_PACKAGE_CONTEXT = "manifest.json payload/Default/Cookies theprivator-cookies.json /tmp/theprivator-selected/research.tpkg profile-store/profiles/abc/user-data cookie domain private.example.invalid cookie name sessionid cookie value cookie-value-should-not-render proxy-user-should-not-leak proxy-pass-should-not-leak tpapi-secret-token DevToolsActivePort ws://127.0.0.1:9222/devtools/browser/abc --remote-debugging-port=9222 --user-data-dir=/private/profile raw diagnostics stdout stderr traceback stack trace";
const UNSAFE_PROFILE_PACKAGE_PATTERN = /manifest\.json|payload\/Default\/Cookies|theprivator-cookies\.json|theprivator-selected|profile-store\/profiles|private\.example\.invalid|sessionid|cookie-value-should-not-render|proxy-user-should-not-leak|proxy-pass-should-not-leak|tpapi-secret-token|DevToolsActivePort|ws:\/\/127\.0\.0\.1|--remote-debugging-port|--user-data-dir|raw diagnostics|stdout|stderr|traceback|stack trace/i;

function profilePackageCommandError(code: string, message: string, detailRef: string) {
  return {
    code,
    message,
    recoverable: true,
    detailRef,
    unsafeContext: {
      selectedPath: "/tmp/theprivator-selected/research.tpkg",
      archiveMembers: ["manifest.json", "payload/Default/Cookies"],
      rawManifest: { rawDiagnostics: UNSAFE_PROFILE_PACKAGE_CONTEXT },
      stack: UNSAFE_PROFILE_PACKAGE_CONTEXT,
    },
    rawDiagnostics: UNSAFE_PROFILE_PACKAGE_CONTEXT,
    stack: UNSAFE_PROFILE_PACKAGE_CONTEXT,
  };
}

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

function automationApiStatus(overrides: Record<string, unknown> = {}) {
  return {
    status: "running",
    running: true,
    api: {
      host: "127.0.0.1",
      port: 43123,
      url: "http://127.0.0.1:43123",
      scope: "loopback",
    },
    process: {
      pid: 5151,
      startedAt: "2026-05-04T18:15:00.000Z",
    },
    copyAvailable: true,
    lastTransitionAt: "2026-05-04T18:15:00.000Z",
    timings: {
      readinessDurationMs: 25.5,
    },
    ...overrides,
  };
}

function automationApiStopped(overrides: Record<string, unknown> = {}) {
  return automationApiStatus({
    status: "stopped",
    running: false,
    api: undefined,
    process: undefined,
    copyAvailable: false,
    lastTransitionAt: "2026-05-04T18:16:00.000Z",
    timings: {
      readinessDurationMs: 25.5,
      stopDurationMs: 8.75,
    },
    ...overrides,
  });
}

function automationApiTokenCopy(token = "tpapi-sentinel-token-should-not-render", overrides: Record<string, unknown> = {}) {
  return {
    token,
    ...overrides,
  };
}

function automationApiLastError(overrides: Record<string, unknown> = {}) {
  return {
    code: "AUTOMATION_API_START_TIMEOUT",
    message: "Automation API process did not emit readiness before the timeout.",
    phase: "readiness",
    detailRef: "bridge-automation-timeout-detail",
    at: "2026-05-04T18:16:30.000Z",
    durationMs: 5000,
    ...overrides,
  };
}

function defaultIdentity(overrides: Record<string, unknown> = {}): ProfileIdentity {
  return {
    identityVersion: 2,
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
    geolocation: { mode: "real", permission: "prompt" },
    mediaDevices: { mode: "real" },
    ports: { mode: "real" },
    ...overrides,
  };
}

function presetIdentity(overrides: Record<string, unknown> = {}): ProfileIdentity {
  return {
    identityVersion: 2,
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
    geolocation: { mode: "real", permission: "prompt" },
    mediaDevices: { mode: "real" },
    ports: { mode: "real" },
    ...overrides,
  };
}

function configuredSurfacesIdentity(overrides: Record<string, unknown> = {}): ProfileIdentity {
  return presetIdentity({
    presetId: null,
    label: "Configured surfaces",
    geolocation: {
      mode: "custom",
      permission: "allow",
      latitude: 40.712776,
      longitude: -74.005974,
      accuracy: 65,
      altitude: null,
    },
    mediaDevices: { mode: "custom", videoInputs: 1, audioInputs: 2, audioOutputs: 2 },
    ports: { mode: "custom", allowedPorts: [80, 443, 8080] },
    ...overrides,
  });
}

function identitySurfacesDescribeResult(overrides: Record<string, unknown> = {}) {
  return {
    identityVersion: 2,
    surfaces: [
      {
        id: "browser",
        modes: ["custom", "masked", "real"],
        fields: [{ name: "userAgent", type: "text", maxLength: 512, required: true }],
      },
      {
        id: "geolocation",
        modes: ["custom", "real"],
        fields: [
          { name: "permission", type: "enum", options: ["allow", "block", "prompt"], required: true },
          { name: "latitude", type: "number", min: -90, max: 90, required: true },
          { name: "longitude", type: "number", min: -180, max: 180, required: true },
          { name: "accuracy", type: "integer", min: 1, max: 100000, required: true },
          { name: "altitude", type: "number", min: -1000, max: 100000, required: false },
        ],
      },
      {
        id: "mediaDevices",
        modes: ["custom", "masked", "real"],
        fields: [
          { name: "videoInputs", type: "integer", min: 0, max: 1, required: true },
          { name: "audioInputs", type: "integer", min: 1, max: 4, required: true },
          { name: "audioOutputs", type: "integer", min: 1, max: 4, required: true },
          { name: "noiseSeed", type: "integer", min: 0, max: 1000000, required: false },
        ],
      },
      {
        id: "ports",
        modes: ["custom", "masked", "real"],
        fields: [{ name: "allowedPorts", type: "list", maxItems: 50, required: true }],
      },
    ],
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

function directProxySummary(overrides: Record<string, unknown> = {}) {
  return {
    proxyVersion: 1,
    mode: "direct",
    credentialState: "none",
    summary: "Direct connection",
    ...overrides,
  };
}

function fixedProxySummary(overrides: Record<string, unknown> = {}) {
  return {
    proxyVersion: 1,
    mode: "fixedServer",
    protocol: "http",
    host: "proxy.example",
    port: 8080,
    credentialState: "none",
    summary: "http://proxy.example:8080",
    ...overrides,
  };
}

function directProxyDraft(overrides: Record<string, unknown> = {}): ProfileProxyDraft {
  return {
    proxyVersion: 1 as const,
    mode: "direct" as const,
    ...overrides,
  } as ProfileProxyDraft;
}

function fixedProxyDraft(overrides: Record<string, unknown> = {}): ProfileProxyDraft {
  return {
    proxyVersion: 1 as const,
    mode: "fixedServer" as const,
    protocol: "http" as const,
    host: "proxy.example",
    port: 8080,
    ...overrides,
  } as ProfileProxyDraft;
}

function proxyValidationResult(overrides: Record<string, unknown> = {}) {
  return {
    proxyVersion: 1,
    proxy: directProxySummary(),
    warnings: [],
    ...overrides,
  };
}

function proxyEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-proxy-1",
    protocolVersion: "1.0.0",
    durationMs: 3.75,
    result,
    ...overrides,
  };
}

function proxyCheckRouteProofDirect(overrides: Record<string, unknown> = {}) {
  return {
    status: "not-run",
    basis: "direct-profile",
    scope: "not-applicable",
    protocol: null,
    credentialState: "none",
    durationMs: 0,
    fixture: null,
    target: null,
    directFallbackDetected: false,
    observationCounts: { proxy: 0, target: 0 },
    ...overrides,
  };
}

function proxyCheckRouteProofProved(overrides: Record<string, unknown> = {}) {
  return {
    status: "proved",
    basis: "sidecar-managed-local-fixture",
    scope: "local-fixture",
    protocol: "http",
    credentialState: "none",
    durationMs: 245.5,
    fixture: { kind: "http", managed: true },
    target: { host: "198.51.100.20", port: 443 },
    directFallbackDetected: false,
    observationCounts: { proxy: 2, target: 1 },
    ...overrides,
  };
}

function proxyCheckIpHidingDirect(overrides: Record<string, unknown> = {}) {
  return {
    status: "not-proven",
    basis: "direct-profile",
    scope: "not-applicable",
    publicExitIpClaimed: false,
    publicExitIp: null,
    publicExitLocation: null,
    localFixtureConclusion: "not-run",
    ...overrides,
  };
}

function proxyCheckIpHidingProved(overrides: Record<string, unknown> = {}) {
  return {
    status: "proved",
    basis: "route-proof-succeeded",
    scope: "local-fixture",
    publicExitIpClaimed: false,
    publicExitIp: null,
    publicExitLocation: null,
    localFixtureConclusion: "direct target IP hidden from the proof target by the managed fixture",
    ...overrides,
  };
}

function proxyCheckWebRtcBaseline(overrides: Record<string, unknown> = {}) {
  return {
    status: "baseline-real",
    basis: "profile-identity-policy",
    mode: "real",
    policy: "real",
    localIpExposure: "real-local-ip-baseline",
    ...overrides,
  };
}

function proxyCheckWebRtcRestricted(overrides: Record<string, unknown> = {}) {
  return {
    status: "restricted",
    basis: "profile-identity-policy",
    mode: "masked",
    policy: "disableNonProxiedUdp",
    localIpExposure: "non-proxied-udp-disabled",
    ...overrides,
  };
}

function proxyCheckPublicCheckers(overrides: Record<string, unknown> = {}) {
  return {
    status: "advisory-only",
    basis: "fixed-https-allowlist",
    networkDependency: "user-driven-external-pages",
    pages: [
      {
        id: "cloudflare-trace",
        label: "Cloudflare trace",
        url: "https://www.cloudflare.com/cdn-cgi/trace",
        surfaces: ["ip"],
        advisory: "External IP guidance only; not used as ThePrivator proof.",
      },
      {
        id: "aws-checkip",
        label: "AWS checkip",
        url: "https://checkip.amazonaws.com/",
        surfaces: ["ip"],
        advisory: "External IP guidance only; not used as ThePrivator proof.",
      },
      {
        id: "webbrowsertools-webrtc",
        label: "WebRTC leak test",
        url: "https://webbrowsertools.com/webrtc-leak-test/",
        surfaces: ["webrtc"],
        advisory: "WebRTC guidance only; compare with the profile policy shown here.",
      },
    ],
    ...overrides,
  };
}

function proxyCheckResult(overrides: Record<string, unknown> = {}) {
  return {
    proxyCheckVersion: 1,
    profileId: PROXY_CHECK_PROFILE_ID,
    proxy: directProxySummary(),
    routeProof: proxyCheckRouteProofDirect(),
    ipHiding: proxyCheckIpHidingDirect(),
    webRtc: proxyCheckWebRtcBaseline(),
    publicCheckers: proxyCheckPublicCheckers(),
    ...overrides,
  };
}

function proxyCheckEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-proxy-check-1",
    protocolVersion: "1.0.0",
    durationMs: 8.25,
    result,
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

function profileOrganization(overrides: Record<string, unknown> = {}) {
  return {
    folderId: null,
    tags: [],
    notes: "",
    favorite: false,
    color: null,
    ...overrides,
  };
}

function profileLaunch(overrides: Record<string, unknown> = {}) {
  return {
    startupBehavior: "customUrls",
    startUrls: [],
    args: [],
    ...overrides,
  };
}

function profileLifecycle(overrides: Record<string, unknown> = {}) {
  return {
    deletedAt: null,
    lastLaunchedAt: null,
    launchCount: 0,
    ...overrides,
  };
}

function profileSync(overrides: Record<string, unknown> = {}) {
  return {
    revision: 1,
    updatedBy: "device-alpha",
    originDeviceId: "device-alpha",
    lastSyncedAt: null,
    lastSyncedRevision: null,
    ...overrides,
  };
}

function derivedStartUrl(launch: unknown): string {
  const record = (launch ?? {}) as { startupBehavior?: unknown; startUrls?: unknown };
  const startUrls = Array.isArray(record.startUrls) ? record.startUrls : [];
  if (record.startupBehavior !== "customUrls" || startUrls.length === 0) {
    return "about:blank";
  }
  return String(startUrls[0]);
}

function derivedFingerprintMode(identity: unknown): string {
  const surfaces = Object.values((identity ?? {}) as Record<string, unknown>);
  const allReal = surfaces.every(
    (surface) => typeof surface !== "object" || surface === null || (surface as { mode?: unknown }).mode === "real",
  );
  return allReal ? "disabled" : "managed";
}

function profileRecord(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === "string" ? overrides.id : "11111111-1111-1111-1111-111111111111";
  const proxy = overrides.proxy ?? directProxySummary();
  const proxyMode = typeof proxy === "object" && proxy !== null && (proxy as { mode?: unknown }).mode === "fixedServer" ? "fixedServer" : "direct";
  const identity = overrides.identity ?? defaultIdentity();
  const launch = overrides.launch ?? profileLaunch();
  return {
    id,
    name: "Research",
    createdAt: "2026-05-04T18:00:00.000Z",
    updatedAt: "2026-05-04T18:01:00.000Z",
    defaults: {
      browser: "chromium",
      startUrl: derivedStartUrl(launch),
      proxyMode,
      fingerprintMode: derivedFingerprintMode(identity),
    },
    storage: {
      profileDir: `profile-store/profiles/${id}`,
      userDataDir: `profile-store/profiles/${id}/user-data`,
    },
    identity,
    proxy,
    organization: profileOrganization(),
    launch,
    lifecycle: profileLifecycle(),
    sync: profileSync(),
    ...overrides,
  };
}

function profileResult(overrides: Record<string, unknown> = {}) {
  const profiles = overrides.profiles ?? [profileRecord()];
  return {
    storeVersion: 4,
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

function auditPageResult(overrides: Record<string, unknown> = {}) {
  return {
    id: "browserleaks-webgl",
    label: "BrowserLeaks WebGL",
    category: "browserleaks",
    url: "https://browserleaks.com/webgl",
    status: "captured",
    capturedAt: "2026-05-04T18:08:00.000Z",
    title: "BrowserLeaks WebGL Report",
    summary: "WebGL vendor and renderer were visible on the checker page.",
    extractedRows: [{ label: "WebGL Vendor", value: "Google Inc." }],
    notes: [],
    ...overrides,
  };
}

function auditCollectResult(overrides: Record<string, unknown> = {}) {
  const plan = auditPlanResult();
  const pages = overrides.pages ?? (plan.pages as Array<Record<string, unknown>>).map((page) => auditPageResult({
    id: page.id,
    label: page.label,
    category: page.category,
    url: page.url,
    status: page.requiresUserAction ? "needs-user-action" : "captured",
    title: page.requiresUserAction ? "Manual test required" : `${page.label} result`,
    summary: page.requiresUserAction ? "Open this checker in the profile and start the site test before reading results." : `${page.label} fields were captured.`,
    extractedRows: page.requiresUserAction ? [] : [{ label: "Observed", value: "Public checker value" }],
    notes: page.requiresUserAction ? ["This site requires a user-started public test."] : [],
  }));
  return {
    auditVersion: 1,
    profileId: AUDIT_PROFILE_ID,
    status: "collected",
    collectedAt: "2026-05-04T18:08:30.000Z",
    launched: false,
    runningCount: 1,
    pages,
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
        storeVersion: 4,
        profiles: [],
        count: 0,
      },
    });

    const snapshot = await listProfiles();

    expect(mockInvoke).toHaveBeenCalledWith("profiles_list");
    expect(snapshot.requestId).toBe("bridge-profiles-1");
    expect(snapshot.storeVersion).toBe(4);
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
    expect(snapshot.profiles[0].proxy).toEqual(directProxySummary());
    expect(snapshot.profiles[0].storage).toEqual({
      profileDir: `profile-store/profiles/${profile.id}`,
      userDataDir: `profile-store/profiles/${profile.id}/user-data`,
    });
  });

  it("wraps create, update, and delete with fixed profile command params only", async () => {
    const original = profileRecord({ name: "Research" });
    const renamed = profileRecord({ name: "Renamed", updatedAt: "2026-05-04T18:02:00.000Z" });
    const trashed = profileRecord({
      name: "Renamed",
      updatedAt: "2026-05-04T18:03:00.000Z",
      lifecycle: profileLifecycle({ deletedAt: "2026-05-04T18:03:00.000Z" }),
    });
    mockInvoke
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profile: original, profiles: [original] })))
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profile: renamed, profiles: [renamed] })))
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profile: trashed, profiles: [] })));

    const created = await createProfile("Research");
    const updated = await updateProfile(original.id, "Renamed");
    const deleted = await deleteProfile(original.id);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "profiles_create", { name: "Research" });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "profiles_update", { id: original.id, name: "Renamed" });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "profiles_delete", { id: original.id });
    expect(created.profile).toEqual(original);
    expect(updated.profile).toEqual(renamed);
    expect(deleted.profile).toEqual(trashed);
    expect(deleted.profile?.lifecycle.deletedAt).toBe("2026-05-04T18:03:00.000Z");
    expect(deleted.profiles).toEqual([]);
    expect(deleted.count).toBe(0);
  });

  it("keeps organization notes and tags that read like paths or URLs", async () => {
    const organization = profileOrganization({
      folderId: "55555555-5555-5555-5555-555555555555",
      tags: ["client-work", "EU proxy"],
      notes: "Billing: https://billing.example.com/account/42 — key lives at C:/keys/2026, rotate it first.",
      favorite: true,
      color: "#1a2b3c",
    });
    const profile = profileRecord({ organization });
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult({ profiles: [profile] })));

    const snapshot = await listProfiles();

    expect(snapshot.profiles[0].organization).toEqual(organization);
  });

  it("derives profile defaults from the launch block and the identity surfaces", async () => {
    const launch = profileLaunch({
      startUrls: ["https://example.com/start", "http://intranet.example/", "about:blank"],
      args: ["--disable-features=Translate"],
    });
    const profile = profileRecord({ identity: presetIdentity(), launch });
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult({ profiles: [profile] })));

    const snapshot = await listProfiles();

    expect(snapshot.profiles[0].launch).toEqual(launch);
    expect(snapshot.profiles[0].defaults).toEqual({
      browser: "chromium",
      startUrl: "https://example.com/start",
      proxyMode: "direct",
      fingerprintMode: "managed",
    });
  });

  it("wraps proxy validation and profile proxy update with fixed command params only", async () => {
    const draft = fixedProxyDraft({ credentials: { username: "proxy-user", password: "proxy-pass" } });
    const fixedSummary = fixedProxySummary({ credentialState: "configured" });
    const profile = profileRecord({ proxy: fixedSummary });
    mockInvoke
      .mockResolvedValueOnce(proxyEnvelope(proxyValidationResult({ proxy: fixedSummary })))
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profile, profiles: [profile] })));

    const validation = await validateProxy(draft);
    const updated = await updateProfileProxy(profile.id, draft);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "proxy_validate", { proxy: draft });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "profiles_proxy_update", { profileId: profile.id, proxy: draft });
    expect(validation).toMatchObject({
      proxyVersion: 1,
      proxy: fixedSummary,
      warnings: [],
      requestId: "bridge-proxy-1",
    });
    expect(updated.profile).toEqual(profile);
    expect(updated.profiles).toEqual([profile]);
    expect(JSON.stringify(validation)).not.toMatch(/proxy-user|proxy-pass|"username"|"password"|"credentials"/i);
    expect(JSON.stringify(updated)).not.toMatch(/proxy-user|proxy-pass|"username"|"password"|"credentials"/i);
  });

  it("checks a profile proxy through a fixed command and parses direct/not-proven output", async () => {
    const result = proxyCheckResult();
    mockInvoke.mockResolvedValueOnce(proxyCheckEnvelope(result));

    const snapshot = await checkProfileProxy(PROXY_CHECK_PROFILE_ID);

    expect(mockInvoke).toHaveBeenCalledWith("profiles_proxy_check", { profileId: PROXY_CHECK_PROFILE_ID });
    expect(snapshot).toMatchObject({
      proxyCheckVersion: 1,
      profileId: PROXY_CHECK_PROFILE_ID,
      requestId: "bridge-proxy-check-1",
      protocolVersion: "1.0.0",
      bridgeDurationMs: 8.25,
      routeProof: { status: "not-run", basis: "direct-profile", directFallbackDetected: false },
      ipHiding: { status: "not-proven", publicExitIpClaimed: false, publicExitIp: null },
      webRtc: { status: "baseline-real", localIpExposure: "real-local-ip-baseline" },
      publicCheckers: { status: "advisory-only", networkDependency: "user-driven-external-pages" },
    });
    expect(snapshot.publicCheckers.pages.map((page) => page.id)).toEqual([
      "cloudflare-trace",
      "aws-checkip",
      "webbrowsertools-webrtc",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/storeRoot|proxy-user|proxy-pass|"username"|"password"|"credentials"|debugPort|webSocketDebuggerUrl|checkerContent|rawContent/i);
  });

  it("parses proved proxy-check output with WebRTC restriction as advisory public-checker guidance", async () => {
    const fixedSummary = fixedProxySummary();
    const result = proxyCheckResult({
      proxy: fixedSummary,
      routeProof: proxyCheckRouteProofProved(),
      ipHiding: proxyCheckIpHidingProved(),
      webRtc: proxyCheckWebRtcRestricted(),
    });
    mockInvoke.mockResolvedValueOnce(proxyCheckEnvelope(result));

    const snapshot = await checkProfileProxy(PROXY_CHECK_PROFILE_ID);

    expect(snapshot.proxy).toEqual(fixedSummary);
    expect(snapshot.routeProof).toMatchObject({
      status: "proved",
      basis: "sidecar-managed-local-fixture",
      protocol: "http",
      fixture: { kind: "http", managed: true },
      target: { host: "198.51.100.20", port: 443 },
      observationCounts: { proxy: 2, target: 1 },
    });
    expect(snapshot.ipHiding).toMatchObject({
      status: "proved",
      publicExitIpClaimed: false,
      publicExitIp: null,
      localFixtureConclusion: "direct target IP hidden from the proof target by the managed fixture",
    });
    expect(snapshot.webRtc).toMatchObject({
      status: "restricted",
      policy: "disableNonProxiedUdp",
      localIpExposure: "non-proxied-udp-disabled",
    });
  });

  it.each([
    ["empty profile id", ""],
    ["path-like profile id", "profile/../secret"],
    ["URL-like profile id", "https://example.invalid/profile"],
  ])("rejects invalid proxy-check profile id inputs before invoking Tauri: %s", async (_caseName, profileId) => {
    await expect(checkProfileProxy(profileId)).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it.each([
    ["non-object result", proxyCheckEnvelope("not-object")],
    ["unknown root key", proxyCheckEnvelope(proxyCheckResult({ checkerContent: "raw public checker transcript" }))],
    ["profile id mismatch", proxyCheckEnvelope(proxyCheckResult({ profileId: "22222222-2222-2222-2222-222222222222" }))],
    ["unknown route status", proxyCheckEnvelope(proxyCheckResult({ routeProof: proxyCheckRouteProofDirect({ status: "maybe" }) }))],
    ["proved route missing fixture", proxyCheckEnvelope(proxyCheckResult({ routeProof: proxyCheckRouteProofProved({ fixture: null }) }))],
    ["direct route has non-zero observations", proxyCheckEnvelope(proxyCheckResult({ routeProof: proxyCheckRouteProofDirect({ observationCounts: { proxy: 1, target: 0 } }) }))],
    ["ip hiding public claim", proxyCheckEnvelope(proxyCheckResult({ ipHiding: proxyCheckIpHidingProved({ publicExitIpClaimed: true, publicExitIp: null }) }))],
    ["malformed WebRTC warning", proxyCheckEnvelope(proxyCheckResult({ webRtc: proxyCheckWebRtcRestricted({ policy: "block", localIpExposure: "non-proxied-udp-disabled" }) }))],
    ["HTTP checker URL", () => {
      const result = cloneJson(proxyCheckResult()) as { publicCheckers: { pages: Array<Record<string, unknown>> } };
      result.publicCheckers.pages[0].url = "http://www.cloudflare.com/cdn-cgi/trace";
      return proxyCheckEnvelope(result);
    }],
    ["duplicate checker ids", () => {
      const result = cloneJson(proxyCheckResult()) as { publicCheckers: { pages: Array<Record<string, unknown>> } };
      result.publicCheckers.pages[1].id = result.publicCheckers.pages[0].id;
      return proxyCheckEnvelope(result);
    }],
    ["missing checker id", () => {
      const result = cloneJson(proxyCheckResult()) as { publicCheckers: { pages: Array<Record<string, unknown>> } };
      result.publicCheckers.pages = result.publicCheckers.pages.slice(0, 2);
      return proxyCheckEnvelope(result);
    }],
    ["raw checker transcript field", () => {
      const result = cloneJson(proxyCheckResult()) as { publicCheckers: { pages: Array<Record<string, unknown>> } };
      result.publicCheckers.pages[0].rawTranscript = "HTTP/2 200 raw checker body";
      return proxyCheckEnvelope(result);
    }],
  ] as Array<[string, unknown | (() => unknown)]>)("maps malformed proxy-check payloads to protocol errors: %s", async (_caseName, envelopeOrFactory) => {
    mockInvoke.mockResolvedValueOnce(typeof envelopeOrFactory === "function" ? envelopeOrFactory() : envelopeOrFactory);

    await expect(checkProfileProxy(PROXY_CHECK_PROFILE_ID)).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
  });

  it.each(["credentials", "username", "password", "storeRoot", "userDataDir", "debugPort", "argv", "webSocketDebuggerUrl", "rawCheckerContent"])(
    "rejects forbidden proxy-check field %s before UI state sees it",
    async (field) => {
      mockInvoke.mockResolvedValueOnce(proxyCheckEnvelope(proxyCheckResult({ [field]: "unsafe-runtime-or-secret-detail" })));

      await expect(checkProfileProxy(PROXY_CHECK_PROFILE_ID)).rejects.toMatchObject({
        code: SIDECAR_PROTOCOL_ERROR,
        source: "protocol",
        phase: "bridge-error",
      });
    },
  );

  it("preserves typed sidecar and bridge errors for proxy-check calls", async () => {
    mockInvoke
      .mockRejectedValueOnce({
        code: "PROXY_PROOF_FAILED",
        message: "Proxy check proof could not be completed.",
        recoverable: true,
        detailRef: "sidecar-proxy-check-detail",
      })
      .mockRejectedValueOnce({
        code: "SIDECAR_TIMEOUT",
        message: "The Python sidecar did not respond before the bridge timeout.",
        recoverable: true,
        detailRef: "bridge-proxy-check-timeout",
      })
      .mockRejectedValueOnce({
        code: SIDECAR_PROTOCOL_ERROR,
        message: "The Python sidecar returned malformed JSON.",
        recoverable: true,
        detailRef: "bridge-proxy-check-protocol",
      });

    await expect(checkProfileProxy(PROXY_CHECK_PROFILE_ID)).rejects.toMatchObject({
      code: "PROXY_PROOF_FAILED",
      message: "Proxy check proof could not be completed.",
      recoverable: true,
      detailRef: "sidecar-proxy-check-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
    await expect(checkProfileProxy(PROXY_CHECK_PROFILE_ID)).rejects.toMatchObject({
      code: "SIDECAR_TIMEOUT",
      source: "bridge",
      phase: "bridge-error",
      detailRef: "bridge-proxy-check-timeout",
    });
    await expect(checkProfileProxy(PROXY_CHECK_PROFILE_ID)).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
      detailRef: "bridge-proxy-check-protocol",
    });
  });

  it("exports and replaces profile cookies through fixed commands with safe DTO snapshots", async () => {
    const exportDestination = "/selected/private/export.cookies";
    const replaceSource = "/selected/private/import.cookies.json";
    mockInvoke
      .mockResolvedValueOnce(cookieEnvelope(cookieExportResult()))
      .mockResolvedValueOnce(cookieEnvelope(cookieReplaceResult({ warningCount: 0, warnings: [], skippedCount: 0 })));

    const exported = await exportProfileCookies(COOKIE_PROFILE_ID, exportDestination, "netscape");
    const replaced = await replaceProfileCookies(COOKIE_PROFILE_ID, replaceSource);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "profile_cookies_export", {
      profileId: COOKIE_PROFILE_ID,
      destinationPath: exportDestination,
      format: "netscape",
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "profile_cookies_replace", {
      profileId: COOKIE_PROFILE_ID,
      sourcePath: replaceSource,
    });
    for (const [command, params] of mockInvoke.mock.calls) {
      expect(command).toMatch(/^profile_cookies_(export|replace)$/);
      expect(JSON.stringify(params)).not.toMatch(/storeRoot|method|portability\.cookies/i);
    }
    expect(exported).toMatchObject({
      portabilityVersion: 1,
      profileId: COOKIE_PROFILE_ID,
      operation: "export",
      format: "netscape",
      exportedCount: 3,
      skippedCount: 1,
      warningCount: 1,
      requestId: "bridge-cookie-1",
      protocolVersion: "1.0.0",
      bridgeDurationMs: 9.5,
      warnings: [cookieWarning()],
    });
    expect(replaced).toMatchObject({
      portabilityVersion: 1,
      profileId: COOKIE_PROFILE_ID,
      operation: "replace",
      format: "theprivator-json",
      importedCount: 4,
      replacedCount: 2,
      skippedCount: 0,
      warningCount: 0,
      warnings: [],
    });
    expect(JSON.stringify(exported)).not.toMatch(/\/selected\/private|storeRoot|sourcePath|destinationPath|cookieDomain|host_key|"domain"|"name"|"value"/i);
    expect(JSON.stringify(replaced)).not.toMatch(/\/selected\/private|storeRoot|sourcePath|destinationPath|cookieDomain|host_key|"domain"|"name"|"value"/i);
  });

  it.each([
    ["zero-cookie export", () => cookieEnvelope(cookieExportResult({ exportedCount: 0, skippedCount: 0, warningCount: 0, warnings: [] })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/empty.cookies", "netscape")],
    ["zero-cookie replace", () => cookieEnvelope(cookieReplaceResult({ importedCount: 0, replacedCount: 0, skippedCount: 0, warningCount: 0, warnings: [] })), () => replaceProfileCookies(COOKIE_PROFILE_ID, "/tmp/empty.cookies.json")],
    ["bounded warning count", () => cookieEnvelope(cookieReplaceResult({ warningCount: 1, warnings: [cookieWarning({ code: "IMPORT_DUPLICATE_REPLACED", count: 4 })], skippedCount: 4 })), () => replaceProfileCookies(COOKIE_PROFILE_ID, "/tmp/duplicates.cookies.json")],
  ] as Array<[string, () => unknown, () => Promise<unknown>]>)("accepts cookie portability boundary conditions: %s", async (_caseName, envelopeFactory, callClient) => {
    mockInvoke.mockResolvedValueOnce(envelopeFactory());

    await expect(callClient()).resolves.toMatchObject({
      portabilityVersion: 1,
      profileId: COOKIE_PROFILE_ID,
    });
  });

  it.each([
    ["blank export profile id", () => exportProfileCookies(" ", "/tmp/export.cookies", "netscape")],
    ["path-like export profile id", () => exportProfileCookies("profile/../secret", "/tmp/export.cookies", "netscape")],
    ["blank export destination", () => exportProfileCookies(COOKIE_PROFILE_ID, " ", "netscape")],
    ["unsupported export format", () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "json" as CookieExportFormat)],
    ["blank replace profile id", () => replaceProfileCookies("", "/tmp/import.cookies")],
    ["blank replace source", () => replaceProfileCookies(COOKIE_PROFILE_ID, "")],
  ])("rejects malformed cookie wrapper inputs before invoking Tauri: %s", async (_caseName, callClient) => {
    await expect(callClient()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong portability version", () => cookieEnvelope(cookieExportResult({ portabilityVersion: 2 })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")],
    ["missing exported count", () => cookieEnvelope(cookieExportResult({ exportedCount: undefined })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")],
    ["negative skipped count", () => cookieEnvelope(cookieExportResult({ skippedCount: -1 })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")],
    ["non-integer warning count", () => cookieEnvelope(cookieExportResult({ warningCount: 1.5 })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")],
    ["unsafe integer count", () => cookieEnvelope(cookieExportResult({ exportedCount: Number.MAX_SAFE_INTEGER + 1 })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")],
    ["mismatched profile id", () => cookieEnvelope(cookieExportResult({ profileId: PROXY_CHECK_PROFILE_ID })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")],
    ["wrong export operation", () => cookieEnvelope(cookieExportResult({ operation: "replace" })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")],
    ["wrong export format", () => cookieEnvelope(cookieExportResult({ format: "theprivator-json" })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")],
    ["warning count mismatch", () => cookieEnvelope(cookieExportResult({ warningCount: 0 })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")],
    ["too many warnings", () => cookieEnvelope(cookieExportResult({ warningCount: 21, warnings: tooManyCookieWarnings() })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")],
    ["duplicate warning codes", () => cookieEnvelope(cookieExportResult({ warningCount: 2, warnings: [cookieWarning(), cookieWarning()] })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")],
    ["zero warning item count", () => cookieEnvelope(cookieExportResult({ warnings: [cookieWarning({ count: 0 })] })), () => exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")],
    ["wrong replace operation", () => cookieEnvelope(cookieReplaceResult({ operation: "export" })), () => replaceProfileCookies(COOKIE_PROFILE_ID, "/tmp/import.cookies")],
    ["unsupported replace format", () => cookieEnvelope(cookieReplaceResult({ format: "json" })), () => replaceProfileCookies(COOKIE_PROFILE_ID, "/tmp/import.cookies")],
    ["replaced count exceeds imported count", () => cookieEnvelope(cookieReplaceResult({ importedCount: 1, replacedCount: 2 })), () => replaceProfileCookies(COOKIE_PROFILE_ID, "/tmp/import.cookies")],
  ] as Array<[string, () => unknown, () => Promise<unknown>]>)("maps malformed cookie portability payloads to protocol errors: %s", async (_caseName, envelopeFactory, callClient) => {
    mockInvoke.mockResolvedValueOnce(envelopeFactory());

    await expect(callClient()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
  });

  it.each([
    ["selected destination path", { destinationPath: "/selected/private/export.cookies" }],
    ["selected source path", { sourcePath: "/selected/private/import.cookies" }],
    ["store root", { storeRoot: "/app/data/root" }],
    ["cookie value", { value: "session-cookie-secret" }],
    ["cookie domain", { domain: "private.example.invalid" }],
    ["cookie name", { name: "sid" }],
    ["cookie DB path", { cookieDbPath: "/app/data/profile/Cookies" }],
    ["raw cookie list", { cookies: [{ domain: "private.example.invalid", name: "sid", value: "secret" }] }],
  ])("rejects unsafe cookie portability result field before UI state sees it: %s", async (_caseName, extraFields) => {
    mockInvoke.mockResolvedValueOnce(cookieEnvelope(cookieExportResult(extraFields)));

    await expect(exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it.each([
    ["unsafe warning field", [cookieWarning({ domain: "private.example.invalid" })]],
    ["absolute path in warning text", [cookieWarning({ message: "Cookie import skipped /Users/alice/private/Cookies." })]],
    ["raw diagnostics in warning text", [cookieWarning({ message: "See raw diagnostics stderr for details." })]],
  ])("rejects unsafe cookie portability warnings: %s", async (_caseName, warnings) => {
    mockInvoke.mockResolvedValueOnce(cookieEnvelope(cookieExportResult({ warnings, warningCount: warnings.length })));

    await expect(exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it("preserves typed cookie portability sidecar, bridge, and protocol errors", async () => {
    mockInvoke
      .mockRejectedValueOnce({
        code: "PORTABILITY_PROFILE_BUSY",
        message: "Stop this profile before importing or exporting cookies.",
        recoverable: true,
        detailRef: "sidecar-cookie-busy-detail",
      })
      .mockRejectedValueOnce({
        code: "PORTABILITY_COOKIE_FILE_INVALID",
        message: "Cookie import file is malformed or unsupported.",
        recoverable: true,
        detailRef: "sidecar-cookie-invalid-detail",
      })
      .mockRejectedValueOnce({
        code: "SIDECAR_TIMEOUT",
        message: "The Python sidecar did not respond before the bridge timeout.",
        recoverable: true,
        detailRef: "bridge-cookie-timeout-detail",
      })
      .mockRejectedValueOnce({
        code: SIDECAR_PROTOCOL_ERROR,
        message: "The Python sidecar returned malformed JSON.",
        recoverable: true,
        detailRef: "bridge-cookie-protocol-detail",
      });

    await expect(exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "netscape")).rejects.toMatchObject({
      code: "PORTABILITY_PROFILE_BUSY",
      message: "Stop this profile before importing or exporting cookies.",
      recoverable: true,
      detailRef: "sidecar-cookie-busy-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
    await expect(replaceProfileCookies(COOKIE_PROFILE_ID, "/tmp/import.cookies")).rejects.toMatchObject({
      code: "PORTABILITY_COOKIE_FILE_INVALID",
      detailRef: "sidecar-cookie-invalid-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
    await expect(exportProfileCookies(COOKIE_PROFILE_ID, "/tmp/export.cookies", "theprivator-json")).rejects.toMatchObject({
      code: "SIDECAR_TIMEOUT",
      detailRef: "bridge-cookie-timeout-detail",
      source: "bridge",
      phase: "bridge-error",
    });
    await expect(replaceProfileCookies(COOKIE_PROFILE_ID, "/tmp/import.cookies")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      detailRef: "bridge-cookie-protocol-detail",
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it("exports and imports profile packages through fixed commands with metadata-only snapshots", async () => {
    const exportDestination = "/selected/private/research.tpkg";
    const importSource = "/selected/private/research.tpkg";
    mockInvoke
      .mockResolvedValueOnce(profilePackageEnvelope(profilePackageExportResult()))
      .mockResolvedValueOnce(profilePackageEnvelope(profilePackageImportResult({ warningCount: 0, warnings: [] })));

    const exported = await exportProfilePackage(PACKAGE_PROFILE_ID, exportDestination);
    const imported = await importProfilePackage(importSource);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "profile_package_export", {
      profileId: PACKAGE_PROFILE_ID,
      destinationPath: exportDestination,
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "profile_package_import", {
      sourcePath: importSource,
    });
    for (const [command, params] of mockInvoke.mock.calls) {
      expect(command).toMatch(/^profile_package_(export|import)$/);
      expect(JSON.stringify(params)).not.toMatch(/storeRoot|method|portability\.profile_package|manifest|payload|cookie/i);
    }
    expect(exported).toMatchObject({
      portabilityVersion: 1,
      packageVersion: 2,
      operation: "export",
      profileId: PACKAGE_PROFILE_ID,
      profileName: "Research",
      portableSessionCount: 3,
      payloadFileCount: 4,
      payloadBytes: 8192,
      payloadSkippedCount: 2,
      warningCount: 1,
      warnings: [profilePackageWarning()],
      requestId: "bridge-package-1",
      protocolVersion: "1.0.0",
      bridgeDurationMs: 12.25,
    });
    expect(imported).toMatchObject({
      portabilityVersion: 1,
      packageVersion: 2,
      operation: "import",
      importedProfileId: IMPORTED_PACKAGE_PROFILE_ID,
      importedProfileName: "Research Copy",
      nameConflictResolved: true,
      portableSessionCount: 3,
      payloadFileCount: 4,
      payloadBytes: 8192,
      payloadSkippedCount: 0,
      warningCount: 0,
      warnings: [],
    });
    expect(exported).not.toHaveProperty("format");
    expect(imported).not.toHaveProperty("profile");
    expect(imported).not.toHaveProperty("format");
    expect(JSON.stringify({ exported, imported })).not.toMatch(/\/selected\/private|profile-store|profileDir|userDataDir|manifest\.json|theprivator-cookies\.json|payload\/|cookieCount|payloadByteCount|skippedCookieCount|importedCookieCount|replacedCookieCount/i);
  });

  it.each([
    ["zero-count package export", () => profilePackageEnvelope(profilePackageExportResult({ cookieCount: 0, skippedCookieCount: 0, payloadFileCount: 0, payloadByteCount: 0, warningCount: 0, warnings: [] })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/empty.tpkg")],
    ["zero-count package import", () => profilePackageEnvelope(profilePackageImportResult({ cookieCount: 0, importedCookieCount: 0, replacedCookieCount: 0, payloadFileCount: 0, payloadByteCount: 0, warningCount: 0, warnings: [] })), () => importProfilePackage("/tmp/empty.tpkg")],
    ["conflict-resolved import", () => profilePackageEnvelope(profilePackageImportResult({ nameConflictResolved: true, profileName: "Research Copy 2", profile: profilePackageImportProfile({ name: "Research Copy 2" }) })), () => importProfilePackage("/tmp/conflict.tpkg")],
    ["bounded package warnings", () => profilePackageEnvelope(profilePackageExportResult({ warningCount: 2, warnings: [profilePackageWarning({ count: 4 }), profilePackageWarning({ code: "PACKAGE_EXPORT_DESTINATION_SKIPPED", message: "The selected package destination was excluded from the payload snapshot.", count: 1 })] })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/warnings.tpkg")],
  ] as Array<[string, () => unknown, () => Promise<unknown>]>)("accepts profile package boundary conditions: %s", async (_caseName, envelopeFactory, callClient) => {
    mockInvoke.mockResolvedValueOnce(envelopeFactory());

    await expect(callClient()).resolves.toMatchObject({
      portabilityVersion: 1,
      packageVersion: 2,
    });
  });

  it.each([
    ["blank export profile id", () => exportProfilePackage(" ", "/tmp/export.tpkg")],
    ["path-like export profile id", () => exportProfilePackage("profile/../secret", "/tmp/export.tpkg")],
    ["blank export destination", () => exportProfilePackage(PACKAGE_PROFILE_ID, " ")],
    ["blank import source", () => importProfilePackage("")],
  ])("rejects malformed package wrapper inputs before invoking Tauri: %s", async (_caseName, callClient) => {
    await expect(callClient()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong package version", () => profilePackageEnvelope(profilePackageExportResult({ packageVersion: 3 })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["superseded package version", () => profilePackageEnvelope(profilePackageExportResult({ packageVersion: 1 })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["wrong package format", () => profilePackageEnvelope(profilePackageExportResult({ format: "zip" })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["missing payload count", () => profilePackageEnvelope(profilePackageExportResult({ payloadFileCount: undefined })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["negative payload bytes", () => profilePackageEnvelope(profilePackageExportResult({ payloadByteCount: -1 })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["non-integer warning count", () => profilePackageEnvelope(profilePackageExportResult({ warningCount: 1.5 })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["unsafe integer count", () => profilePackageEnvelope(profilePackageExportResult({ payloadFileCount: Number.MAX_SAFE_INTEGER + 1 })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["mismatched export profile id", () => profilePackageEnvelope(profilePackageExportResult({ profileId: PROXY_CHECK_PROFILE_ID })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["wrong export operation", () => profilePackageEnvelope(profilePackageExportResult({ operation: "import" })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["wrong import operation", () => profilePackageEnvelope(profilePackageImportResult({ operation: "export" })), () => importProfilePackage("/tmp/import.tpkg")],
    ["warning count mismatch", () => profilePackageEnvelope(profilePackageExportResult({ warningCount: 0 })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["too many warnings", () => profilePackageEnvelope(profilePackageExportResult({ warningCount: 21, warnings: tooManyProfilePackageWarnings() })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["duplicate warning codes", () => profilePackageEnvelope(profilePackageExportResult({ warningCount: 2, warnings: [profilePackageWarning(), profilePackageWarning()] })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["zero warning item count", () => profilePackageEnvelope(profilePackageExportResult({ warnings: [profilePackageWarning({ count: 0 })] })), () => exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")],
    ["imported sessions exceed portable sessions", () => profilePackageEnvelope(profilePackageImportResult({ cookieCount: 1, importedCookieCount: 2 })), () => importProfilePackage("/tmp/import.tpkg")],
    ["replaced sessions exceed imported sessions", () => profilePackageEnvelope(profilePackageImportResult({ importedCookieCount: 1, replacedCookieCount: 2 })), () => importProfilePackage("/tmp/import.tpkg")],
    ["import profile reference mismatch", () => profilePackageEnvelope(profilePackageImportResult({ profile: profilePackageImportProfile({ id: PACKAGE_PROFILE_ID }) })), () => importProfilePackage("/tmp/import.tpkg")],
  ] as Array<[string, () => unknown, () => Promise<unknown>]>)("maps malformed profile package payloads to protocol errors: %s", async (_caseName, envelopeFactory, callClient) => {
    mockInvoke.mockResolvedValueOnce(envelopeFactory());

    await expect(callClient()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
  });

  it.each([
    ["selected destination path", { destinationPath: "/selected/private/research.tpkg" }],
    ["selected source path", { sourcePath: "/selected/private/research.tpkg" }],
    ["store root", { storeRoot: "/app/data/root" }],
    ["app root", { appRoot: "/Applications/ThePrivator.app" }],
    ["user-data dir", { userDataDir: "profile-store/profiles/abc/user-data" }],
    ["profile dir", { profileDir: "profile-store/profiles/abc" }],
    ["package members", { members: ["manifest.json", "payload/Default/Preferences"] }],
    ["raw manifest", { rawManifest: { format: "theprivator.profile-package" } }],
    ["cookie value", { cookieValue: "session-cookie-secret" }],
    ["cookie domain", { cookieDomain: "private.example.invalid" }],
    ["cookie name", { cookieName: "sid" }],
    ["credentials", { credentials: { username: "proxy-user", password: "proxy-pass" } }],
    ["Automation API token", { automationApiToken: "tpapi-secret-token" }],
    ["debug endpoint", { debugEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc" }],
    ["CDP endpoint", { cdpEndpoint: "cdp://127.0.0.1:9222/devtools/browser/abc" }],
    ["launch args", { launchArgs: ["--user-data-dir=/private/profile"] }],
    ["raw diagnostics", { stdout: "raw stdout", stderr: "raw stderr", rawDiagnostics: "unsafe raw diagnostics" }],
    ["stack trace", { stackTrace: "Traceback (most recent call last): package import stack trace" }],
  ])("rejects unsafe profile package result field before UI state sees it: %s", async (_caseName, extraFields) => {
    mockInvoke.mockResolvedValueOnce(profilePackageEnvelope(profilePackageExportResult(extraFields)));

    await expect(exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });

    mockInvoke.mockResolvedValueOnce(profilePackageEnvelope(profilePackageImportResult(extraFields)));

    await expect(importProfilePackage("/tmp/import.tpkg")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it.each([
    ["unsafe warning field", [profilePackageWarning({ member: "payload/Default/Preferences" })]],
    ["absolute path in warning text", [profilePackageWarning({ message: "Profile package skipped /Users/alice/private/Default/Preferences." })]],
    ["manifest member in warning text", [profilePackageWarning({ message: "Skipped manifest.json from payload." })]],
    ["cookie detail in warning text", [profilePackageWarning({ message: "Cookie value sid=secret was skipped." })]],
    ["proxy credential in warning text", [profilePackageWarning({ message: "Proxy credentials proxy-user-should-not-leak proxy-pass-should-not-leak were rejected." })]],
    ["Automation API token in warning text", [profilePackageWarning({ message: "Automation API token tpapi-secret-token was rejected." })]],
    ["debug endpoint in warning text", [profilePackageWarning({ message: "See ws://127.0.0.1:9222/devtools/browser/abc." })]],
    ["CDP endpoint in warning text", [profilePackageWarning({ message: "CDP endpoint cdp://127.0.0.1:9222/devtools/browser/abc was rejected." })]],
    ["launch args in warning text", [profilePackageWarning({ message: "Launch args --user-data-dir=/private/profile were rejected." })]],
    ["raw diagnostics in warning text", [profilePackageWarning({ message: "See raw diagnostics stderr for details." })]],
    ["stack trace in warning text", [profilePackageWarning({ message: "Traceback and stack trace output was rejected." })]],
  ])("rejects unsafe profile package warnings: %s", async (_caseName, warnings) => {
    mockInvoke.mockResolvedValueOnce(profilePackageEnvelope(profilePackageExportResult({ warnings, warningCount: warnings.length })));

    await expect(exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });

    mockInvoke.mockResolvedValueOnce(profilePackageEnvelope(profilePackageImportResult({ warnings, warningCount: warnings.length })));

    await expect(importProfilePackage("/tmp/import.tpkg")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it("preserves typed profile package sidecar, bridge, and protocol errors", async () => {
    mockInvoke
      .mockRejectedValueOnce({
        code: "PORTABILITY_PROFILE_BUSY",
        message: "Stop this profile before exporting a profile package.",
        recoverable: true,
        detailRef: "sidecar-package-busy-detail",
      })
      .mockRejectedValueOnce({
        code: "PORTABILITY_PACKAGE_INVALID",
        message: "Profile package is invalid or unsupported.",
        recoverable: true,
        detailRef: "sidecar-package-invalid-detail",
      })
      .mockRejectedValueOnce({
        code: "PORTABILITY_PACKAGE_CHECKSUM_MISMATCH",
        message: "Profile package checksum verification failed.",
        recoverable: true,
        detailRef: "sidecar-package-checksum-detail",
      })
      .mockRejectedValueOnce({
        code: "SIDECAR_TIMEOUT",
        message: "The Python sidecar did not respond before the bridge timeout.",
        recoverable: true,
        detailRef: "bridge-package-timeout-detail",
      })
      .mockRejectedValueOnce({
        code: SIDECAR_PROTOCOL_ERROR,
        message: "The Python sidecar returned malformed JSON.",
        recoverable: true,
        detailRef: "bridge-package-protocol-detail",
      });

    await expect(exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")).rejects.toMatchObject({
      code: "PORTABILITY_PROFILE_BUSY",
      message: "Stop this profile before exporting a profile package.",
      recoverable: true,
      detailRef: "sidecar-package-busy-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
    await expect(importProfilePackage("/tmp/import.tpkg")).rejects.toMatchObject({
      code: "PORTABILITY_PACKAGE_INVALID",
      detailRef: "sidecar-package-invalid-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
    await expect(importProfilePackage("/tmp/import.tpkg")).rejects.toMatchObject({
      code: "PORTABILITY_PACKAGE_CHECKSUM_MISMATCH",
      detailRef: "sidecar-package-checksum-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
    await expect(exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")).rejects.toMatchObject({
      code: "SIDECAR_TIMEOUT",
      detailRef: "bridge-package-timeout-detail",
      source: "bridge",
      phase: "bridge-error",
    });
    await expect(importProfilePackage("/tmp/import.tpkg")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      detailRef: "bridge-package-protocol-detail",
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it.each([
    ["PORTABILITY_PACKAGE_INVALID", "Profile package is invalid.", "sidecar-package-invalid-detail"],
    ["PORTABILITY_PACKAGE_CHECKSUM_MISMATCH", "Profile package checksum verification failed.", "sidecar-package-checksum-detail"],
    ["PORTABILITY_PACKAGE_TOO_LARGE", "Profile package is too large.", "sidecar-package-too-large-detail"],
    ["PORTABILITY_PACKAGE_READ_FAILED", "Profile package could not be read.", "sidecar-package-read-detail"],
    ["PORTABILITY_PACKAGE_PAYLOAD_FAILED", "Profile package payload could not be restored.", "sidecar-package-payload-detail"],
    ["PORTABILITY_PACKAGE_IMPORT_FAILED", "Profile package import failed.", "sidecar-package-import-detail"],
  ])("preserves package import rejection code %s while stripping unsafe thrown context", async (code, message, detailRef) => {
    mockInvoke.mockRejectedValueOnce(profilePackageCommandError(code, message, detailRef));

    let thrown: unknown;
    try {
      await importProfilePackage("/tmp/import.tpkg");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code,
      message,
      recoverable: true,
      detailRef,
      source: "sidecar",
      phase: "recoverable-error",
    });
    expect(thrown).not.toHaveProperty("unsafeContext");
    expect(thrown).not.toHaveProperty("rawDiagnostics");
    expect(thrown).not.toHaveProperty("stack");
    expect(JSON.stringify(thrown)).not.toMatch(UNSAFE_PROFILE_PACKAGE_PATTERN);
  });

  it.each([
    ["missing request id", () => profilePackageEnvelope(profilePackageExportResult(), { requestId: undefined })],
    ["unsupported bridge protocol", () => profilePackageEnvelope(profilePackageExportResult(), { protocolVersion: "2.0.0" })],
    ["non-object result", () => profilePackageEnvelope(null)],
    ["unknown result field", () => profilePackageEnvelope(profilePackageExportResult({ harmlessExtra: true }))],
  ])("maps malformed profile package envelopes to protocol errors: %s", async (_caseName, envelopeFactory) => {
    mockInvoke.mockResolvedValueOnce(envelopeFactory());

    await expect(exportProfilePackage(PACKAGE_PROFILE_ID, "/tmp/export.tpkg")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it.each([
    ["direct", directProxySummary()],
    ["fixed unauthenticated", fixedProxySummary()],
    ["fixed authenticated", fixedProxySummary({ credentialState: "configured" })],
  ])("parses redacted proxy summaries for %s profiles", async (_caseName, proxy) => {
    const profile = profileRecord({ proxy });
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult({ profiles: [profile] })));

    const snapshot = await listProfiles();

    expect(snapshot.profiles[0].proxy).toEqual(proxy);
    expect(snapshot.profiles[0].defaults.proxyMode).toBe((proxy as { mode: string }).mode);
  });

  it("wraps identity commands with fixed command params and parses structured warnings", async () => {
    const preset = presetIdentity();
    const profile = profileRecord({ identity: preset });
    const suspicious = suspiciousIdentity();
    const suspiciousProfile = profileRecord({ identity: suspicious, updatedAt: "2026-05-04T18:03:00.000Z" });
    const warning = identityWarning();
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope({ identityVersion: 2, presets: [preset], count: 1 }))
      .mockResolvedValueOnce(identityEnvelope({ identityVersion: 2, identity: suspicious, warnings: [warning] }))
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

  it("parses the geolocation, media device, and port surfaces and their warnings", async () => {
    const identity = configuredSurfacesIdentity();
    const geolocationOnly = defaultIdentity({
      label: "Geolocation only",
      geolocation: { mode: "custom", permission: "block", latitude: -33.868821, longitude: 151.209296, accuracy: 1, altitude: 58.5 },
    });
    const profile = profileRecord({ identity });
    const geolocationProfile = profileRecord({ id: "55555555-5555-5555-5555-555555555555", identity: geolocationOnly });
    const warnings = [
      identityWarning({ code: "IDENTITY_GEOLOCATION_WITHOUT_PERMISSION", message: "A fixed position is set but the page can never ask for it.", surface: "geolocation", path: "geolocation.permission" }),
      identityWarning({ code: "IDENTITY_GEOLOCATION_TIMEZONE_MISMATCH", message: "The fixed position is far from the masked timezone.", surface: "geolocation", path: "geolocation.latitude" }),
      identityWarning({ code: "IDENTITY_MEDIA_DEVICES_UNUSUAL", message: "The device counts are valid but uncommon for desktop Chromium.", surface: "mediaDevices", path: "mediaDevices.audioInputs" }),
      identityWarning({ code: "IDENTITY_PORTS_ALLOWLIST_BROAD", message: "The allowed port list is broad enough to be distinctive.", surface: "ports", path: "ports.allowedPorts" }),
    ];
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope({ identityVersion: 2, identity, warnings }))
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profiles: [profile, geolocationProfile] })));

    const validation = await validateIdentity(identity);
    const listed = await listProfiles();

    expect(validation.identityVersion).toBe(2);
    expect(validation.identity).toEqual(identity);
    expect(validation.warnings).toEqual(warnings);
    expect(listed.profiles[0].identity.geolocation).toEqual(identity.geolocation);
    expect(listed.profiles[0].identity.mediaDevices).toEqual(identity.mediaDevices);
    expect(listed.profiles[0].identity.ports).toEqual(identity.ports);
    // A profile whose only non-real surface is one of the new ones must still be
    // derived as managed, or every profiles response fails the defaults check.
    expect(listed.profiles[1].defaults.fingerprintMode).toBe("managed");
  });

  it.each([
    ["masked media devices", { mediaDevices: { mode: "masked", noiseSeed: 4242 } }],
    ["masked ports", { ports: { mode: "masked" } }],
    ["blocked real geolocation", { geolocation: { mode: "real", permission: "block" } }],
    ["single allowed port", { ports: { mode: "custom", allowedPorts: [65535] } }],
    ["empty allowed port list", { ports: { mode: "custom", allowedPorts: [] } }],
    ["boundary coordinates", { geolocation: { mode: "custom", permission: "allow", latitude: -90, longitude: 180, accuracy: 100000, altitude: -1000 } }],
    ["minimum device counts", { mediaDevices: { mode: "custom", videoInputs: 0, audioInputs: 1, audioOutputs: 1 } }],
    // The sidecar counts label bounds in code points, so a 128-code-point label
    // ending in an emoji is a value it accepts and persists.
    ["code-point label bound", { label: `${"a".repeat(127)}🙂` }],
  ] as Array<[string, Record<string, unknown>]>)("accepts identity surface boundary conditions: %s", async (_caseName, overrides) => {
    const identity = defaultIdentity(overrides);
    mockInvoke.mockResolvedValueOnce(identityEnvelope({ identityVersion: 2, identity, warnings: [] }));

    await expect(validateIdentity(identity)).resolves.toMatchObject({ identityVersion: 2, identity });
  });

  it("describes identity surfaces through the fixed Tauri command", async () => {
    mockInvoke.mockResolvedValueOnce(identityEnvelope(identitySurfacesDescribeResult()));

    const described = await describeIdentitySurfaces();

    expect(mockInvoke).toHaveBeenCalledWith("identity_surfaces_describe");
    expect(described.requestId).toBe("bridge-identity-1");
    expect(described.identityVersion).toBe(2);
    expect(described.surfaces.map((surface) => surface.id)).toEqual(["browser", "geolocation", "mediaDevices", "ports"]);
    expect(described.surfaces[1].modes).toEqual(["custom", "real"]);
    expect(described.surfaces[1].fields[0]).toEqual({ name: "permission", type: "enum", options: ["allow", "block", "prompt"], required: true });
    expect(described.surfaces[1].fields[4]).toEqual({ name: "altitude", type: "number", min: -1000, max: 100000, required: false });
    expect(described.surfaces[3].fields[0]).toEqual({ name: "allowedPorts", type: "list", maxItems: 50, required: true });
  });

  it.each([
    ["superseded identity version", identityEnvelope(identitySurfacesDescribeResult({ identityVersion: 1 }))],
    ["unknown result key", identityEnvelope({ ...identitySurfacesDescribeResult(), surfaceCount: 4 })],
    ["unknown surface id", identityEnvelope(identitySurfacesDescribeResult({ surfaces: [{ id: "gpu", modes: ["real"], fields: [] }] }))],
    ["unknown surface key", identityEnvelope(identitySurfacesDescribeResult({ surfaces: [{ id: "ports", modes: ["real"], fields: [], label: "Ports" }] }))],
    ["repeated surface id", identityEnvelope(identitySurfacesDescribeResult({ surfaces: [{ id: "ports", modes: ["real"], fields: [] }, { id: "ports", modes: ["real"], fields: [] }] }))],
    ["unsorted modes", identityEnvelope(identitySurfacesDescribeResult({ surfaces: [{ id: "ports", modes: ["real", "custom"], fields: [] }] }))],
    ["unknown mode", identityEnvelope(identitySurfacesDescribeResult({ surfaces: [{ id: "ports", modes: ["derived"], fields: [] }] }))],
    ["unknown field key", identityEnvelope(identitySurfacesDescribeResult({ surfaces: [{ id: "ports", modes: ["real"], fields: [{ name: "allowedPorts", type: "list", maxItems: 50, required: true, help: "Ports" }] }] }))],
    ["unknown field type", identityEnvelope(identitySurfacesDescribeResult({ surfaces: [{ id: "ports", modes: ["real"], fields: [{ name: "allowedPorts", type: "portlist", maxItems: 50, required: true }] }] }))],
    ["inverted field bounds", identityEnvelope(identitySurfacesDescribeResult({ surfaces: [{ id: "geolocation", modes: ["real"], fields: [{ name: "latitude", type: "number", min: 90, max: -90, required: true }] }] }))],
    ["repeated field name", identityEnvelope(identitySurfacesDescribeResult({ surfaces: [{ id: "geolocation", modes: ["real"], fields: [{ name: "latitude", type: "number", min: -90, max: 90, required: true }, { name: "latitude", type: "number", min: -90, max: 90, required: true }] }] }))],
    ["empty surface list", identityEnvelope(identitySurfacesDescribeResult({ surfaces: [] }))],
  ])("maps malformed identity surface descriptions to protocol errors: %s", async (_caseName, envelope) => {
    mockInvoke.mockResolvedValueOnce(envelope);

    await expect(describeIdentitySurfaces()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
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

  it("parses safe automation API running and stopped lifecycle snapshots", async () => {
    mockInvoke
      .mockResolvedValueOnce(automationApiStatus())
      .mockResolvedValueOnce(automationApiStopped());

    const running = await getAutomationApiStatus();
    const stopped = await getAutomationApiStatus();

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "automation_api_status");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "automation_api_status");
    expect(running).toMatchObject({
      status: "running",
      running: true,
      api: { host: "127.0.0.1", port: 43123, url: "http://127.0.0.1:43123", scope: "loopback" },
      process: { pid: 5151, startedAt: "2026-05-04T18:15:00.000Z" },
      copyAvailable: true,
    });
    expect(stopped).toMatchObject({
      status: "stopped",
      running: false,
      api: null,
      process: null,
      copyAvailable: false,
    });
    expect(JSON.stringify(running)).not.toMatch(/tpapi-|storeRoot|Authorization|webSocket|debugPort|argv/i);
  });

  it("wraps automation API lifecycle commands with fixed command names and no frontend authority", async () => {
    mockInvoke
      .mockResolvedValueOnce(automationApiStatus({ lastTransitionAt: "2026-05-04T18:17:00.000Z" }))
      .mockResolvedValueOnce(automationApiTokenCopy())
      .mockResolvedValueOnce(automationApiStopped());

    const started = await startAutomationApi();
    const token = await copyAutomationApiToken();
    const stopped = await stopAutomationApi();

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "automation_api_start");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "automation_api_copy_token");
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "automation_api_stop");
    expect(started.status).toBe("running");
    expect(token).toBe("tpapi-sentinel-token-should-not-render");
    expect(stopped.status).toBe("stopped");
  });

  it("preserves stopped copy-token failures as safe typed errors", async () => {
    mockInvoke.mockRejectedValueOnce({
      code: "AUTOMATION_API_COPY_UNAVAILABLE",
      message: "Automation API credential is unavailable because the API is stopped.",
      recoverable: true,
      detailRef: "bridge-automation-copy-detail",
    });

    await expect(copyAutomationApiToken()).rejects.toMatchObject({
      code: "AUTOMATION_API_COPY_UNAVAILABLE",
      message: "Automation API credential is unavailable because the API is stopped.",
      recoverable: true,
      detailRef: "bridge-automation-copy-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
    expect(mockInvoke).toHaveBeenCalledWith("automation_api_copy_token");
  });

  it.each([
    ["unknown lifecycle phase", automationApiStatus({ status: "starting" })],
    ["running flag mismatch", automationApiStatus({ running: false })],
    ["missing running endpoint", automationApiStatus({ api: undefined })],
    ["non-loopback URL", automationApiStatus({ api: { host: "127.0.0.1", port: 43123, url: "http://198.51.100.1:43123", scope: "loopback" } })],
    ["unsafe token field", automationApiStatus({ token: "tpapi-sentinel-token-should-not-render" })],
    ["unsafe store root field", automationApiStatus({ storeRoot: "/tmp/theprivator-app-data-root-should-not-leak" })],
    ["unsafe debug endpoint field", automationApiStatus({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser" })],
    ["missing last error detailRef", automationApiStopped({ lastError: automationApiLastError({ detailRef: undefined }) })],
    ["token in last error text", automationApiStopped({ lastError: automationApiLastError({ message: "tpapi-sentinel-token-should-not-render" }) })],
  ])("rejects malformed or unsafe automation API payloads: %s", async (_caseName, payload) => {
    mockInvoke.mockResolvedValueOnce(payload);

    await expect(getAutomationApiStatus()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
  });

  it.each([
    ["extra copy-token field", automationApiTokenCopy(undefined, { storeRoot: "/tmp/theprivator-app-data-root-should-not-leak" })],
    ["malformed token", automationApiTokenCopy("not-a-valid-local-token")],
  ])("rejects malformed automation API token-copy responses: %s", async (_caseName, payload) => {
    mockInvoke.mockResolvedValueOnce(payload);

    await expect(copyAutomationApiToken()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
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

  it("collects bounded audit website results through a safe profile identifier only", async () => {
    mockInvoke.mockResolvedValueOnce(auditEnvelope(auditCollectResult({ launched: true })));

    const snapshot = await collectIdentityAuditResults(AUDIT_PROFILE_ID);

    expect(mockInvoke).toHaveBeenCalledWith("identity_audit_collect", { profileId: AUDIT_PROFILE_ID });
    expect(snapshot).toMatchObject({
      auditVersion: 1,
      profileId: AUDIT_PROFILE_ID,
      status: "collected",
      launched: true,
      runningCount: 1,
    });
    expect(snapshot.pages).toHaveLength(9);
    expect(snapshot.pages.find((page) => page.id === "cover-your-tracks")?.status).toBe("needs-user-action");
    expect(snapshot.pages[0].extractedRows[0]).toMatchObject({ label: "Observed", value: "Public checker value" });
    expect(JSON.stringify(snapshot)).not.toMatch(/pid|userDataDir|targetId|debugPort|webSocketDebuggerUrl|storeRoot|command|extensionDir|ws:\/\//i);
  });

  it.each([
    ["empty profile id", null, () => getIdentityAuditPlan(" ")],
    ["empty collect profile id", null, () => collectIdentityAuditResults(" ")],
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
    ["unknown audit result field", () => auditEnvelope(auditCollectResult({ targetId: "page-target" })), () => collectIdentityAuditResults(AUDIT_PROFILE_ID)],
    ["mismatched collect profile id", () => auditEnvelope(auditCollectResult({ profileId: "22222222-2222-2222-2222-222222222222" })), () => collectIdentityAuditResults(AUDIT_PROFILE_ID)],
    ["unsafe audit result string", () => {
      const result = cloneJson(auditCollectResult()) as unknown as { pages: Array<{ summary: string }> };
      result.pages[0].summary = "Open ws://127.0.0.1:9222/json for details.";
      return auditEnvelope(result);
    }, () => collectIdentityAuditResults(AUDIT_PROFILE_ID)],
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
    ["stale v2 store version", profileEnvelope(profileResult({ storeVersion: 2 }))],
    ["stale v3 store version", profileEnvelope(profileResult({ storeVersion: 3 }))],
    ["store version newer than this build", profileEnvelope(profileResult({ storeVersion: 5 }))],
    ["wrong profiles item type", profileEnvelope(profileResult({ profiles: ["not-a-profile"] }))],
    ["missing defaults", profileEnvelope(profileResult({ profiles: [profileRecord({ defaults: undefined })] }))],
    ["missing identity", profileEnvelope(profileResult({ profiles: [profileRecord({ identity: undefined })] }))],
    ["missing proxy", profileEnvelope(profileResult({ profiles: [profileRecord({ proxy: undefined })] }))],
    ["invalid proxy credential state", profileEnvelope(profileResult({ profiles: [profileRecord({ proxy: fixedProxySummary({ credentialState: "visible" }) })] }))],
    ["proxy defaults mismatch", profileEnvelope(profileResult({ profiles: [profileRecord({ proxy: fixedProxySummary(), defaults: { browser: "chromium", startUrl: "about:blank", proxyMode: "direct", fingerprintMode: "disabled" } })] }))],
    ["proxy summary mismatch", profileEnvelope(profileResult({ profiles: [profileRecord({ proxy: fixedProxySummary({ summary: "http://user:pass@proxy.example:8080" }) })] }))],
    ["unknown identity surface mode", profileEnvelope(profileResult({ profiles: [profileRecord({ identity: defaultIdentity({ browser: { mode: "private" } }) })] }))],
    ["invalid language array", profileEnvelope(profileResult({ profiles: [profileRecord({ identity: presetIdentity({ locale: { mode: "masked", locale: "en-US", languages: ["not a tag"], timezoneId: "America/New_York" } }) })] }))],
    ["invalid noise seed", profileEnvelope(profileResult({ profiles: [profileRecord({ identity: presetIdentity({ canvas: { mode: "noise", noiseSeed: 1000001 } }) })] }))],
    ["missing relative storage fields", profileEnvelope(profileResult({ profiles: [profileRecord({ storage: {} })] }))],
    ["absolute storage path", profileEnvelope(profileResult({ profiles: [profileRecord({ storage: { profileDir: "/tmp/profile", userDataDir: "/tmp/profile/user-data" } })] }))],
    ["non-number count", profileEnvelope(profileResult({ count: "one" }))],
    ["non-string timestamp", profileEnvelope(profileResult({ profiles: [profileRecord({ createdAt: 42 })] }))],
    ["missing organization", profileEnvelope(profileResult({ profiles: [profileRecord({ organization: undefined })] }))],
    ["missing launch", profileEnvelope(profileResult({ profiles: [profileRecord({ launch: undefined })] }))],
    ["missing lifecycle", profileEnvelope(profileResult({ profiles: [profileRecord({ lifecycle: undefined })] }))],
    ["missing sync", profileEnvelope(profileResult({ profiles: [profileRecord({ sync: undefined })] }))],
    ["unknown organization field", profileEnvelope(profileResult({ profiles: [profileRecord({ organization: { ...profileOrganization(), archived: true } })] }))],
    ["too many organization tags", profileEnvelope(profileResult({ profiles: [profileRecord({ organization: profileOrganization({ tags: Array.from({ length: 11 }, (_item, index) => `tag-${index}`) }) })] }))],
    ["organization tag outside the tag character set", profileEnvelope(profileResult({ profiles: [profileRecord({ organization: profileOrganization({ tags: ["ops/prod"] }) })] }))],
    ["organization tag beyond the length bound", profileEnvelope(profileResult({ profiles: [profileRecord({ organization: profileOrganization({ tags: ["t".repeat(33)] }) })] }))],
    ["organization notes beyond the length bound", profileEnvelope(profileResult({ profiles: [profileRecord({ organization: profileOrganization({ notes: "n".repeat(1501) }) })] }))],
    ["organization notes containing a control character", profileEnvelope(profileResult({ profiles: [profileRecord({ organization: profileOrganization({ notes: "Rotate the key\u0007then restart." }) })] }))],
    ["organization color outside the hex form", profileEnvelope(profileResult({ profiles: [profileRecord({ organization: profileOrganization({ color: "#12345" }) })] }))],
    ["start URL with a non-http scheme", profileEnvelope(profileResult({ profiles: [profileRecord({ launch: profileLaunch({ startUrls: ["file:///etc/passwd"] }) })] }))],
    ["too many start URLs", profileEnvelope(profileResult({ profiles: [profileRecord({ launch: profileLaunch({ startUrls: Array.from({ length: 11 }, (_item, index) => `https://example.com/${index}`) }) })] }))],
    ["launch argument that is not a switch", profileEnvelope(profileResult({ profiles: [profileRecord({ launch: profileLaunch({ args: ["--disable-features=Translate", "https://example.com/"] }) })] }))],
    ["too many launch arguments", profileEnvelope(profileResult({ profiles: [profileRecord({ launch: profileLaunch({ args: Array.from({ length: 21 }, (_item, index) => `--flag-${index}`) }) })] }))],
    ["defaults start URL disagreeing with the launch block", profileEnvelope(profileResult({ profiles: [profileRecord({ launch: profileLaunch({ startUrls: ["https://example.com/start"] }), defaults: { browser: "chromium", startUrl: "about:blank", proxyMode: "direct", fingerprintMode: "disabled" } })] }))],
    ["defaults fingerprint mode disagreeing with the identity surfaces", profileEnvelope(profileResult({ profiles: [profileRecord({ identity: presetIdentity(), defaults: { browser: "chromium", startUrl: "about:blank", proxyMode: "direct", fingerprintMode: "disabled" } })] }))],
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
    "credentials",
    "username",
    "password",
    "proxyPassword",
    "authCredentials",
    "debugPort",
    "path",
    "argv",
    "args",
    "command",
    "executablePath",
  ])("rejects forbidden raw proxy/profile leak field %s before UI state sees it", async (field) => {
    const unsafeValue = field === "argv" || field === "args" ? ["--proxy-server=http://user:pass@proxy.example:8080"] : "unsafe-runtime-or-secret-detail";
    const profile = profileRecord({ proxy: { ...fixedProxySummary(), [field]: unsafeValue } });
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult({ profiles: [profile] })));

    await expect(listProfiles()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
  });

  it("keeps the args leak guard armed everywhere except the launch block", async () => {
    const profile = profileRecord({ metadata: { args: ["--proxy-server=http://user:pass@proxy.example:8080"] } });
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult({ profiles: [profile] })));

    await expect(listProfiles()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      message: expect.stringContaining("must not expose proxy credentials or runtime details"),
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it.each([
    ["proxy validation leaked credentials", proxyEnvelope(proxyValidationResult({ proxy: { ...fixedProxySummary(), credentials: { username: "raw-user", password: "raw-pass" } } })), () => validateProxy(directProxyDraft())],
    ["proxy validation invalid credentialState", proxyEnvelope(proxyValidationResult({ proxy: fixedProxySummary({ credentialState: "raw" }) })), () => validateProxy(directProxyDraft())],
    ["proxy validation non-empty warnings", proxyEnvelope(proxyValidationResult({ warnings: [{ code: "PROXY_WARNING" }] })), () => validateProxy(directProxyDraft())],
    ["proxy update result profile absent from refreshed list", profileEnvelope(profileResult({ profile: profileRecord({ proxy: fixedProxySummary() }), profiles: [profileRecord()] })), () => updateProfileProxy("11111111-1111-1111-1111-111111111111", fixedProxyDraft())],
    ["proxy update result profile id mismatch", profileEnvelope(profileResult({ profile: profileRecord({ id: "22222222-2222-2222-2222-222222222222", proxy: fixedProxySummary() }), profiles: [profileRecord({ id: "22222222-2222-2222-2222-222222222222", proxy: fixedProxySummary() })] })), () => updateProfileProxy("11111111-1111-1111-1111-111111111111", fixedProxyDraft())],
  ])("maps malformed proxy payloads to protocol errors: %s", async (_caseName, envelope, callClient) => {
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
    ["PROXY_INVALID", "Proxy configuration must be an object.", () => validateProxy(directProxyDraft())],
    ["PROXY_PAC_UNSUPPORTED", "PAC proxy configuration is not supported.", () => updateProfileProxy("profile-id", directProxyDraft())],
  ])("preserves typed recoverable proxy errors: %s", async (code, message, callClient) => {
    mockInvoke.mockRejectedValueOnce({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-proxy-detail",
    });

    await expect(callClient()).rejects.toMatchObject({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-proxy-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
  });

  it.each([
    [
      "malformed preset list warning-free contract",
      identityEnvelope({ identityVersion: 2, presets: [presetIdentity({ presetId: null })], count: 1 }),
      () => listIdentityPresets(),
    ],
    [
      "warning missing code",
      identityEnvelope({ identityVersion: 2, identity: suspiciousIdentity(), warnings: [identityWarning({ code: undefined })] }),
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
      { protocolVersion: "1.0.0", durationMs: 3.25, result: { identityVersion: 2, presets: [], count: 0 } },
      () => listIdentityPresets(),
    ],
    [
      "unknown protocol version",
      identityEnvelope({ identityVersion: 2, presets: [], count: 0 }, { protocolVersion: "9.9.9" }),
      () => listIdentityPresets(),
    ],
    [
      "superseded identity version",
      identityEnvelope({ identityVersion: 1, identity: defaultIdentity(), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "unknown geolocation field",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ geolocation: { mode: "real", permission: "prompt", heading: 90 } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "unknown media device field",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ mediaDevices: { mode: "real", videoInputs: 1 } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "unknown port field",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ ports: { mode: "real", allowedPorts: [] } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "masked geolocation mode",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ geolocation: { mode: "masked", permission: "prompt", latitude: 0, longitude: 0, accuracy: 10, altitude: null } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "unknown geolocation permission",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ geolocation: { mode: "real", permission: "ask" } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "out of range latitude",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ geolocation: { mode: "custom", permission: "allow", latitude: 91, longitude: 0, accuracy: 10, altitude: null } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "out of range longitude",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ geolocation: { mode: "custom", permission: "allow", latitude: 0, longitude: -181, accuracy: 10, altitude: null } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "zero accuracy",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ geolocation: { mode: "custom", permission: "allow", latitude: 0, longitude: 0, accuracy: 0, altitude: null } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "missing altitude key",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ geolocation: { mode: "custom", permission: "allow", latitude: 0, longitude: 0, accuracy: 10 } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "media device noise seed in custom mode",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ mediaDevices: { mode: "custom", videoInputs: 1, audioInputs: 2, audioOutputs: 2, noiseSeed: 7 } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "too many video inputs",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ mediaDevices: { mode: "custom", videoInputs: 2, audioInputs: 2, audioOutputs: 2 } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "zero audio inputs",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ mediaDevices: { mode: "custom", videoInputs: 1, audioInputs: 0, audioOutputs: 2 } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "too many allowed ports",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ ports: { mode: "custom", allowedPorts: Array.from({ length: 51 }, (_item, index) => index + 1) } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "duplicated allowed ports",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ ports: { mode: "custom", allowedPorts: [80, 80, 443] } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "unsorted allowed ports",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ ports: { mode: "custom", allowedPorts: [443, 80] } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "out of range allowed port",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ ports: { mode: "custom", allowedPorts: [0] } }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "unknown warning surface",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity(), warnings: [identityWarning({ surface: "unknownSurface", path: "unknownSurface.mode" })] }),
      () => validateIdentity(defaultIdentity()),
    ],
    [
      "label beyond the code-point bound",
      identityEnvelope({ identityVersion: 2, identity: defaultIdentity({ label: `${"a".repeat(128)}🙂` }), warnings: [] }),
      () => validateIdentity(defaultIdentity()),
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
    ["PROFILE_INVALID_NAME", "Profile name is invalid.", () => createProfile("Research")],
    ["PROFILE_DUPLICATE_NAME", "Profile name already exists.", () => createProfile("Research")],
    ["PROFILE_STORE_VERSION_TOO_NEW", "This profile store was written by a newer version of ThePrivator. Update the app to open it.", () => listProfiles()],
    ["PROFILE_START_URL_INVALID", "Start URLs must begin with https:// or http://.", () => listProfiles()],
    ["PROFILE_ORGANIZATION_INVALID", "Profile notes cannot contain control characters.", () => listProfiles()],
  ])("preserves typed recoverable profile errors: %s", async (code, message, callClient) => {
    mockInvoke.mockRejectedValueOnce({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-profile-detail",
    });

    await expect(callClient()).rejects.toMatchObject({
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
