#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT_DIR, VerifyFailure } from "./verify-m004-s01.mjs";
import { createS04RedactionContext, findS04ForbiddenPublicMarker } from "./verify-m004-s04.mjs";
import { redactS03, safeErrorForPublic } from "./verify-m004-s03.mjs";
import {
  assertBuildArtifactsPresent,
  assertFreshBuildArtifacts,
  assertInitialPackagedUi,
  assertPostSmokeDiagnostics,
  assertPostSmokeProfileStore,
  assertPostSmokeRedaction,
  assertRestartPersistence,
  assertSmokeIdentitySummary,
  assertTauriGuardrails,
  assertWebDriverPreflight,
  applySmokeIdentityPreset,
  buildTauriWebDriverCapabilities,
  cleanupPackagedSmoke,
  configureSmokeProxy,
  createSmokeProfile,
  createSmokeRunContext,
  createTauriWebDriverSession,
  describeSavedProxyProofUiState,
  executableName,
  fixtureObservationCounts,
  launchSmokeChromium,
  latestVisibleDetailRef,
  lookupVisibleDiagnosticRef,
  openSmokeIdentityConfig,
  pollForValue,
  quitDriverSession,
  readMetricValue,
  readProfileCardText,
  readProfileSectionText,
  resolveChromiumExecutable,
  resolveTauriDriverExecutable,
  runSavedProxyProof,
  safeSelectorContext,
  safeVisibleTextSnippet,
  startProxyFixture,
  startTauriDriverProcess,
  stopSmokeChromium,
  waitForMetricValue,
  waitForProfileButton,
  waitForProfileCard,
  waitForVisibleElement,
  waitForVisibleText,
} from "./verify-s06.mjs";

export const VERIFY_EVENT = "verify.m004.s05";
export const S05_PROFILE_PREFIX = "M004 Packaged Automation Smoke";
export const REDACTED_VALUE = "<redacted>";

const MAX_PUBLIC_SCAN_NODES = 6_000;
const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];

export const S05_REQUIRED_PACKAGED_HELPERS = Object.freeze([
  "assertBuildArtifactsPresent",
  "assertFreshBuildArtifacts",
  "assertTauriGuardrails",
  "assertWebDriverPreflight",
  "createSmokeRunContext",
  "startTauriDriverProcess",
  "createTauriWebDriverSession",
  "quitDriverSession",
  "cleanupPackagedSmoke",
  "safeSelectorContext",
  "pollForValue",
  "waitForVisibleElement",
  "waitForVisibleText",
  "waitForProfileCard",
  "waitForProfileButton",
  "waitForMetricValue",
  "readMetricValue",
  "readProfileSectionText",
  "readProfileCardText",
  "assertInitialPackagedUi",
  "createSmokeProfile",
  "openSmokeIdentityConfig",
  "applySmokeIdentityPreset",
  "configureSmokeProxy",
  "runSavedProxyProof",
  "assertPostSmokeProfileStore",
  "assertPostSmokeDiagnostics",
  "assertPostSmokeRedaction",
  "startProxyFixture",
  "fixtureObservationCounts",
]);

export const packagedHarness = Object.freeze({
  assertBuildArtifactsPresent,
  assertFreshBuildArtifacts,
  assertInitialPackagedUi,
  assertPostSmokeDiagnostics,
  assertPostSmokeProfileStore,
  assertPostSmokeRedaction,
  assertRestartPersistence,
  assertSmokeIdentitySummary,
  assertTauriGuardrails,
  assertWebDriverPreflight,
  applySmokeIdentityPreset,
  buildTauriWebDriverCapabilities,
  cleanupPackagedSmoke,
  configureSmokeProxy,
  createSmokeProfile,
  createSmokeRunContext,
  createTauriWebDriverSession,
  describeSavedProxyProofUiState,
  executableName,
  fixtureObservationCounts,
  launchSmokeChromium,
  latestVisibleDetailRef,
  lookupVisibleDiagnosticRef,
  openSmokeIdentityConfig,
  pollForValue,
  quitDriverSession,
  readMetricValue,
  readProfileCardText,
  readProfileSectionText,
  resolveChromiumExecutable,
  resolveTauriDriverExecutable,
  runSavedProxyProof,
  safeSelectorContext,
  safeVisibleTextSnippet,
  startProxyFixture,
  startTauriDriverProcess,
  stopSmokeChromium,
  waitForMetricValue,
  waitForProfileButton,
  waitForProfileCard,
  waitForVisibleElement,
  waitForVisibleText,
});

const S05_FORBIDDEN_TEXT_PATTERNS = Object.freeze([
  { markerClass: "auth_header", pattern: /\bAuthorization\b/i },
  { markerClass: "auth_scheme", pattern: /\bBearer\b/i },
  { markerClass: "cred_field", pattern: /\b(?:credentials?|username|password|secret)\b/i },
  { markerClass: "proxy_auth", pattern: /Proxy-Authorization/i },
  { markerClass: "proxy_switch", pattern: /--proxy-server(?:=|\s+)/i },
  { markerClass: "proxy_bypass", pattern: /--proxy-bypass-list(?:=|\s+)/i },
  { markerClass: "direct_fallback", pattern: /direct:\/\//i },
  { markerClass: "credential_proxy_uri", pattern: /(?:https?|socks4|socks5):\/\/[^\s"'/:@]+:[^\s"'/:@]+@/i },
  { markerClass: "handoff_field", pattern: /\b(?:handoff|connect-over-cdp|browserWSEndpoint|webSocketDebuggerUrl|wsEndpoint)\b/i },
  { markerClass: "debug_endpoint", pattern: /\b(?:DevToolsActivePort|debugPort|devtoolsPort|remoteDebuggingPort|remote-debugging|--remote-debugging-port|cdp:\/\/|cdpEndpoint|cdpPort)\b/i },
  { markerClass: "ws_endpoint", pattern: /wss?:\/\/[^\s"']+/i },
  { markerClass: "profile_private_path", pattern: /\b(?:profile-store|profiles\.json|user-data|app-data-root|XDG_DATA_HOME|APPDATA|LOCALAPPDATA|Application Support)\b/i },
  { markerClass: "process_config", pattern: /\b(?:argv|args|env|NODE_OPTIONS|THEPRIVATOR_[A-Z0-9_]+)\b/i },
  { markerClass: "raw_diag", pattern: /\b(?:stdout|stderr|raw diagnostics?|rawDiagnostics?|rawBody|rawPayload|Traceback|traceback|stack trace)\b/i },
]);

const S05_FORBIDDEN_KEY_PATTERN = /^(?:authorization|bearer|token|apiToken|copiedToken|automationToken|credentials?|username|password|secret|proxyAuthorization|proxyServer|proxyBypass|leaseId|leaseIds|handoff|handoffEndpoint|handoffEndpoints|endpoint|baseUrl|apiBaseUrl|loopbackBaseUrl|browserWSEndpoint|webSocketDebuggerUrl|wsEndpoint|debugPort|devtoolsPort|remoteDebuggingPort|cdpEndpoint|cdpPort|stdout|stderr|rawDiagnostics?|rawBody|rawPayload|stack|traceback|argv|args|env|storeRoot|appDataRoot|profileRoot|profileDir|userDataDir|smokeRoot|runtimePath|paths?|targetUrl|proxyAuthority)$/i;
const SAFE_STATUS_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,96}$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{1,120}$/;
const SAFE_REQUEST_ID_PATTERN = /^(?:automation|bridge|sidecar|ui)-[A-Za-z0-9_.:-]{4,160}$/;
const SAFE_DETAIL_REF_PATTERN = /^(?:sidecar|bridge|ui)-[A-Za-z0-9_.:-]{4,160}$/;
const SAFE_CHECK_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message, details = {}) {
  throw new VerifyFailure(message, details);
}

function assert(condition, message, details = {}) {
  if (!condition) {
    fail(message, details);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined));
}

function compactDeep(value) {
  if (Array.isArray(value)) {
    return value.map(compactDeep).filter((item) => item !== undefined);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const compacted = {};
  for (const [key, nested] of Object.entries(value)) {
    const compactedNested = compactDeep(nested);
    if (compactedNested !== undefined) {
      compacted[key] = compactedNested;
    }
  }
  return compacted;
}

function addExactValues(context, markerClass, values) {
  const exactValues = [...(context.exactValues ?? [])];
  for (const value of values.flat().filter(Boolean)) {
    if (typeof value === "string" && value.length > 0) {
      exactValues.push({ markerClass, value, pattern: new RegExp(escapeRegExp(value), "g") });
    }
  }
  return exactValues;
}

export function createS05RedactionContext({
  rootDir = ROOT_DIR,
  token,
  copiedToken,
  apiBaseUrl,
  baseUrl,
  storeRoot,
  leaseIds = [],
  handoffEndpoints = [],
  proxyAuthorities = [],
  targetUrls = [],
  smokeRoots = [],
  appDataRoots = [],
  profileRoots = [],
  userDataRoots = [],
  extraSensitiveValues = [],
} = {}) {
  let context = createS04RedactionContext({
    rootDir,
    token: copiedToken ?? token,
    storeRoot,
    leaseIds,
    handoffEndpoints,
    targetUrls,
    proxyAuthorities,
    extraSensitiveValues: [
      token,
      copiedToken,
      apiBaseUrl,
      baseUrl,
      ...smokeRoots,
      ...appDataRoots,
      ...profileRoots,
      ...userDataRoots,
      ...extraSensitiveValues,
    ].filter(Boolean),
  });

  let exactValues = addExactValues(context, "api_value", [token, copiedToken]);
  exactValues = addExactValues({ exactValues }, "api_base_url", [apiBaseUrl, baseUrl]);
  exactValues = addExactValues({ exactValues }, "lease_id", leaseIds);
  exactValues = addExactValues({ exactValues }, "lease_endpoint", handoffEndpoints);
  exactValues = addExactValues({ exactValues }, "proxy_authority", proxyAuthorities);
  exactValues = addExactValues({ exactValues }, "target_url", targetUrls);
  exactValues = addExactValues({ exactValues }, "smoke_root", smokeRoots);
  exactValues = addExactValues({ exactValues }, "app_root", [storeRoot, ...appDataRoots, ...profileRoots, ...userDataRoots]);
  exactValues = addExactValues({ exactValues }, "extra_value", extraSensitiveValues);
  exactValues = exactValues.sort((left, right) => right.value.length - left.value.length);

  return {
    ...context,
    rootDir,
    exactValues,
    forbiddenPatterns: [
      ...(context.forbiddenPatterns ?? []),
      ...S05_FORBIDDEN_TEXT_PATTERNS,
    ],
  };
}

function classifyS05ForbiddenKey(key) {
  if (/authorization/i.test(key)) return "auth_header";
  if (/bearer/i.test(key)) return "auth_scheme";
  if (/token|secret/i.test(key)) return "api_value";
  if (/credential|username|password/i.test(key)) return "cred_field";
  if (/proxyAuthorization/i.test(key)) return "proxy_auth";
  if (/proxyServer|proxyBypass/i.test(key)) return "proxy_switch";
  if (/proxyAuthority/i.test(key)) return "proxy_authority";
  if (/targetUrl/i.test(key)) return "target_url";
  if (/leaseId/i.test(key)) return "lease_id";
  if (/handoff|endpoint|baseUrl|webSocket|wsEndpoint/i.test(key)) return "lease_endpoint";
  if (/debug|remoteDebugging|cdp/i.test(key)) return "debug_endpoint";
  if (/stdout|stderr|raw|stack|traceback/i.test(key)) return "raw_diag";
  if (/storeRoot|appDataRoot|userDataDir|profileDir|profileRoot|smokeRoot|runtimePath|path/i.test(key)) return "profile_private_path";
  if (/argv|args|env/i.test(key)) return "process_config";
  return "unsafe_field";
}

function redactedS05KeyName(key) {
  return `<redacted-key:${classifyS05ForbiddenKey(key)}>`;
}

function isRedactedPlaceholderKey(key) {
  return /^<redacted-key:[a-z0-9_]+>$/.test(key);
}

function safeFieldPath(path, keyOrIndex) {
  if (typeof keyOrIndex === "number") {
    return `${path}[${keyOrIndex}]`;
  }
  const segment = S05_FORBIDDEN_KEY_PATTERN.test(keyOrIndex) ? redactedS05KeyName(keyOrIndex) : keyOrIndex;
  return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
}

export function findS05ForbiddenPublicMarker(value, context = createS05RedactionContext(), path = "$", state = { count: 0 }) {
  if (path === "$") {
    const s04Marker = findS04ForbiddenPublicMarker(value, context, path, { count: 0 });
    if (s04Marker) {
      return s04Marker;
    }
  }

  if (state.count++ > MAX_PUBLIC_SCAN_NODES) {
    return {
      markerClass: "scan_limit",
      fieldPath: path,
      reason: "Public verifier evidence exceeded the bounded S05 redaction scan node limit.",
    };
  }

  if (typeof value === "string") {
    for (const marker of context.exactValues ?? []) {
      if (marker.value && value.includes(marker.value)) {
        return { markerClass: marker.markerClass, fieldPath: path, reason: "sensitive exact value" };
      }
    }
    for (const { markerClass, pattern } of S05_FORBIDDEN_TEXT_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) {
        return { markerClass, fieldPath: path, reason: "forbidden S05 text marker" };
      }
    }
    return null;
  }

  if (value === null || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findS05ForbiddenPublicMarker(item, context, safeFieldPath(path, index), state);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (!isRedactedPlaceholderKey(key) && S05_FORBIDDEN_KEY_PATTERN.test(key)) {
      return { markerClass: classifyS05ForbiddenKey(key), fieldPath: safeFieldPath(path, key), reason: "forbidden S05 key" };
    }
    const nestedMarker = findS05ForbiddenPublicMarker(nested, context, safeFieldPath(path, key), state);
    if (nestedMarker) return nestedMarker;
  }
  return null;
}

export function assertS05PublicEvidenceRedacted(value, context = createS05RedactionContext()) {
  const marker = findS05ForbiddenPublicMarker(value, context);
  assert(!marker, "S05 public verifier evidence contained a forbidden marker.", marker ?? {});
  return { status: "clean", scanned: true };
}

function redactS05Text(value, context) {
  let redacted = String(redactS03(value, context));
  for (const { markerClass, pattern } of S05_FORBIDDEN_TEXT_PATTERNS) {
    const flags = pattern.ignoreCase ? "gi" : "g";
    redacted = redacted.replace(new RegExp(pattern.source, flags), `<redacted:${markerClass}>`);
  }
  return redacted;
}

function redactS05Specific(value, context) {
  if (typeof value === "string") {
    return redactS05Text(value, context);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactS05Specific(item, context));
  }
  const safe = {};
  for (const [key, nested] of Object.entries(value)) {
    const unsafeKey = S05_FORBIDDEN_KEY_PATTERN.test(key);
    const safeKey = unsafeKey ? redactedS05KeyName(key) : redactS05Text(key, context);
    safe[safeKey] = unsafeKey ? REDACTED_VALUE : redactS05Specific(nested, context);
  }
  return safe;
}

export function redactS05(value, context = createS05RedactionContext()) {
  return redactS05Specific(redactS03(value, context), context);
}

export function safeS05ErrorForPublic(error, context = createS05RedactionContext()) {
  return redactS05(safeErrorForPublic(error), context);
}

function safeStatus(value, fallback = undefined) {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return SAFE_STATUS_PATTERN.test(text) ? text : fallback;
}

function safeCode(value, fallback = undefined) {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return SAFE_CODE_PATTERN.test(text) ? text : fallback;
}

function safeCount(value) {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function safeBoolean(value) {
  return Boolean(value);
}

function safeRequestId(value) {
  return typeof value === "string" && SAFE_REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

function safeDetailRef(value) {
  return typeof value === "string" && SAFE_DETAIL_REF_PATTERN.test(value) ? value : undefined;
}

function summarizeHttpResult(value) {
  if (!isPlainObject(value)) return undefined;
  return compactObject({
    status: safeStatus(value.status),
    statusCode: Number.isInteger(value.statusCode) ? value.statusCode : undefined,
    errorCode: safeCode(value.errorCode ?? value.code),
    requestId: safeRequestId(value.requestId),
    detailRef: safeDetailRef(value.detailRef),
    requestCorrelated: value.requestCorrelated === undefined ? undefined : safeBoolean(value.requestCorrelated),
    detailRefPresent: value.detailRefPresent === undefined ? undefined : safeBoolean(value.detailRefPresent),
  });
}

function summarizeCheck(value) {
  if (!isPlainObject(value)) {
    return { name: "malformed-check", status: "fail", code: "S05_CHECK_MALFORMED" };
  }
  const name = typeof value.name === "string" && SAFE_CHECK_NAME_PATTERN.test(value.name) ? value.name : "unnamed-check";
  return compactObject({
    name,
    status: safeStatus(value.status, "unknown"),
    durationMs: safeCount(value.durationMs),
    code: safeCode(value.code ?? value.errorCode),
    statusCode: Number.isInteger(value.statusCode) ? value.statusCode : undefined,
    requestId: safeRequestId(value.requestId),
    detailRef: safeDetailRef(value.detailRef),
  });
}

function summarizeHttpMap(value) {
  if (!isPlainObject(value)) return {};
  const summary = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!SAFE_CHECK_NAME_PATTERN.test(key)) continue;
    if (Array.isArray(nested)) {
      summary[key] = nested.map(summarizeHttpResult).filter(Boolean);
    } else {
      const result = summarizeHttpResult(nested);
      if (result) summary[key] = result;
    }
  }
  return summary;
}

function summarizeLeaseFlow(value) {
  if (!isPlainObject(value)) return {};
  const summary = {};
  for (const key of ["create", "status", "active", "release", "releasedReuse", "expiry", "expiredReuse", "revocation", "cleanup"]) {
    const result = summarizeHttpResult(value[key]);
    if (result) summary[key] = result;
  }
  return summary;
}

export function buildS05FinalSummary({
  status = "needs-runtime",
  mode = "contract",
  packageProof = {},
  ui = {},
  api = {},
  http = {},
  leaseFlow = {},
  playwright = {},
  cleanup = {},
  redaction = {},
  error = null,
  checks = STEP_RESULTS,
} = {}, context = createS05RedactionContext()) {
  const summary = compactDeep({
    event: VERIFY_EVENT,
    status: safeStatus(status, "needs-runtime"),
    mode: safeStatus(mode, "contract"),
    proofScope: {
      packagedHarness: true,
      packageArtifacts: safeBoolean(packageProof.artifactsChecked ?? packageProof.releaseAppChecked),
      visibleUiProfile: safeBoolean(ui.profileCreated),
      automationApi: safeBoolean(api.started),
      protectedHttp: safeBoolean(http.health || http.auth),
      playwrightAttach: safeBoolean(playwright.attached),
      cleanupVerified: safeBoolean(cleanup.listenerClosed && cleanup.apiStopped),
    },
    package: {
      buildFresh: packageProof.buildFresh === undefined ? undefined : safeBoolean(packageProof.buildFresh),
      artifactsChecked: packageProof.artifactsChecked === undefined ? undefined : safeBoolean(packageProof.artifactsChecked),
      artifactCount: safeCount(packageProof.artifactCount),
      preflightStatus: safeStatus(packageProof.preflightStatus),
    },
    ui: {
      profileCreated: safeBoolean(ui.profileCreated),
      identityConfigured: safeBoolean(ui.identityConfigured),
      proxyConfigured: safeBoolean(ui.proxyConfigured),
      copyFlowUsed: safeBoolean(ui.copyFlowUsed),
      apiStarted: safeBoolean(ui.apiStarted),
    },
    api: {
      started: safeBoolean(api.started),
      stopped: safeBoolean(api.stopped),
      status: safeStatus(api.status),
      statusCode: Number.isInteger(api.statusCode) ? api.statusCode : undefined,
      requestId: safeRequestId(api.requestId),
      detailRef: safeDetailRef(api.detailRef),
    },
    http: summarizeHttpMap(http),
    leaseFlow: summarizeLeaseFlow(leaseFlow),
    playwright: {
      attached: safeBoolean(playwright.attached),
      navigated: safeBoolean(playwright.navigated),
      targetMarker: safeBoolean(playwright.targetMarker),
      identityMatches: safeCount(playwright.identityMatches),
      proxyObservationCount: safeCount(playwright.proxyObservationCount),
    },
    cleanup: {
      appStopped: safeBoolean(cleanup.appStopped),
      apiStopped: safeBoolean(cleanup.apiStopped),
      listenerClosed: safeBoolean(cleanup.listenerClosed),
      runtimeStopped: safeBoolean(cleanup.runtimeStopped),
      fixtureStopped: safeBoolean(cleanup.fixtureStopped),
      retainedSmokeData: safeBoolean(cleanup.retainedSmokeData),
      diagnosticsScanned: safeBoolean(cleanup.diagnosticsScanned),
    },
    redaction: {
      status: safeStatus(redaction.status),
      scanned: redaction.scanned === undefined ? undefined : safeBoolean(redaction.scanned),
      forbiddenMarkerCount: safeCount(redaction.forbiddenMarkerCount),
    },
    checks: Array.isArray(checks) ? checks.map(summarizeCheck) : [summarizeCheck(checks)],
  });

  if (error) {
    summary.error = safeS05ErrorForPublic(error, context);
  }

  return summary;
}

function resetRunState() {
  STEP_RESULTS.length = 0;
  VERIFIER_EVENTS.length = 0;
}

function emit(event, context = createS05RedactionContext()) {
  const safeEvent = redactS05({ event: VERIFY_EVENT, ...event }, context);
  VERIFIER_EVENTS.push(safeEvent);
  console.log(JSON.stringify(safeEvent));
  return safeEvent;
}

function recordStep(name, status, started, fields = {}, context = createS05RedactionContext()) {
  const durationMs = Math.round(performance.now() - started);
  const record = redactS05({ name, status, durationMs, ...fields }, context);
  STEP_RESULTS.push(record);
  emit({ phase: name, status, durationMs, ...fields }, context);
  return { durationMs, record };
}

function unpackStepResult(result) {
  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "value")) {
    return { publicResult: result.log ?? {}, returnValue: result.value };
  }
  return { publicResult: result ?? {}, returnValue: result ?? {} };
}

function runStep(name, action, context = createS05RedactionContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(action());
    recordStep(name, "pass", started, publicResult, context);
    return returnValue;
  } catch (error) {
    recordStep(name, "fail", started, safeS05ErrorForPublic(error, context), context);
    throw error;
  }
}

export function parseArgs(argv = []) {
  const allowed = new Set(["--contracts-only", "--preflight-only", "--strict-preflight", "--skip-build", "--ui-only", "--help"]);
  const unknown = argv.filter((arg) => String(arg).startsWith("-") && !allowed.has(arg));
  assert(unknown.length === 0, "verify:m004:s05 received an unsupported argument.", {
    code: "S05_UNKNOWN_ARGUMENT",
    unknownArgumentCount: unknown.length,
    allowed: [...allowed].sort(),
  });
  const flags = new Set(argv);
  return {
    contractsOnly: flags.has("--contracts-only"),
    preflightOnly: flags.has("--preflight-only"),
    strictPreflight: flags.has("--strict-preflight"),
    skipBuild: flags.has("--skip-build") || flags.has("--ui-only"),
    uiOnly: flags.has("--ui-only"),
    help: flags.has("--help"),
  };
}

export async function runVerification({ rootDir = ROOT_DIR, argv = process.argv.slice(2) } = {}) {
  resetRunState();
  const context = createS05RedactionContext({ rootDir });
  try {
    const args = parseArgs(argv);
    if (args.help) {
      const summary = buildS05FinalSummary({
        status: "needs-runtime",
        mode: "usage",
        redaction: { status: "ready", scanned: true, forbiddenMarkerCount: 0 },
        checks: STEP_RESULTS,
      }, context);
      assertS05PublicEvidenceRedacted(summary, context);
      emit({ status: "needs-runtime", summary, checks: STEP_RESULTS }, context);
      return summary;
    }

    runStep("contract-surface", () => ({
      packagedHarnessHelpers: S05_REQUIRED_PACKAGED_HELPERS.length,
      profilePrefix: "M004-safe-visible-prefix",
      redactionScanner: "ready",
    }), context);

    const summary = buildS05FinalSummary({
      status: args.contractsOnly ? "pass" : "needs-runtime",
      mode: args.contractsOnly ? "contracts-only" : "scaffold",
      packageProof: { artifactsChecked: false, artifactCount: 0, preflightStatus: args.preflightOnly ? "pending" : "deferred" },
      redaction: { status: "ready", scanned: true, forbiddenMarkerCount: 0 },
      checks: STEP_RESULTS,
    }, context);
    assertS05PublicEvidenceRedacted(summary, context);
    emit({ status: summary.status, summary, checks: STEP_RESULTS }, context);
    if (args.contractsOnly) {
      return summary;
    }

    fail("verify:m004:s05 packaged runtime orchestration is not implemented yet.", {
      code: "S05_RUNTIME_NOT_IMPLEMENTED",
      phase: "runtime",
      action: "Complete the remaining S05 tasks before using the full packaged Automation API regression.",
    });
  } catch (error) {
    const publicError = error instanceof VerifyFailure
      ? error
      : new VerifyFailure("Unexpected verify:m004:s05 failure.", {
          code: "S05_UNEXPECTED_FAILURE",
          message: error instanceof Error ? error.message : String(error),
        });
    const summary = buildS05FinalSummary({
      status: "fail",
      mode: "scaffold",
      redaction: { status: "ready", scanned: true },
      error: publicError,
      checks: STEP_RESULTS,
    }, context);
    assertS05PublicEvidenceRedacted(summary, context);
    emit({ status: "fail", summary, checks: STEP_RESULTS }, context);
    throw publicError;
  }
}

function isDirectExecution() {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

if (isDirectExecution()) {
  runVerification().catch((error) => {
    const context = createS05RedactionContext();
    const safeError = safeS05ErrorForPublic(error, context);
    console.error(safeError.message);
    if (safeError.details && Object.keys(safeError.details).length > 0) {
      console.error(JSON.stringify(safeError.details, null, 2));
    }
    process.exitCode = 1;
  });
}
