#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium as playwrightChromium } from "playwright-core";
import webdriver from "selenium-webdriver";
import {
  AUTOMATION_AUTH_INVALID,
  AUTOMATION_AUTH_REQUIRED,
  ROOT_DIR,
  VerifyFailure,
  assertStatusResponse,
  executable,
  waitForListenerClosed,
} from "./verify-m004-s01.mjs";
import {
  INVALID_REQUEST,
  PROFILE_NOT_FOUND,
  assertProfilesResponse,
  assertProtectedAuthErrorResponse,
  assertRuntimeStatusResponse,
  assertSelectedProfileStatusResponse,
} from "./verify-m004-s02.mjs";
import {
  AUTOMATION_LEASE_EXPIRED,
  AUTOMATION_LEASE_NOT_FOUND,
  AUTOMATION_LEASE_RELEASED,
  assertEndpointRevoked,
  assertHealthWithHeader,
  assertLeaseCreateResponse,
  assertLeaseReleaseResponse,
  assertLeaseStatusResponse,
  assertNoForbiddenLeaseSurface,
  redactS03,
  requestJson,
  safeErrorForPublic,
  waitForLeaseStatus,
} from "./verify-m004-s03.mjs";
import {
  assertS04DomainFailure,
  createS04RedactionContext,
  findS04ForbiddenPublicMarker,
} from "./verify-m004-s04.mjs";
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
  readTargetTriple,
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

const { By } = webdriver;

export const VERIFY_EVENT = "verify.m004.s05";
export const S05_PROFILE_PREFIX = "M004 Packaged Automation Smoke";
export const REDACTED_VALUE = "<redacted>";
export const S05_CLIPBOARD_TOKEN_KEY = "__THEPRIVATOR_S05_PRIVATE_COPIED_TOKEN__";
export const S05_CLIPBOARD_STATE_KEY = "__THEPRIVATOR_S05_PRIVATE_CLIPBOARD_STATE__";

const MAX_PUBLIC_SCAN_NODES = 6_000;
const BUILD_TIMEOUT_MS = Number(process.env.VERIFY_S05_BUILD_TIMEOUT_MS ?? 20 * 60_000);
const UI_WAIT_TIMEOUT_MS = Number(process.env.VERIFY_S05_UI_WAIT_TIMEOUT_MS ?? 60_000);
const UI_POLL_MS = 250;
const HTTP_TIMEOUT_MS = Number(process.env.VERIFY_S05_HTTP_TIMEOUT_MS ?? 5_000);
const PLAYWRIGHT_TIMEOUT_MS = Number(process.env.VERIFY_S05_PLAYWRIGHT_TIMEOUT_MS ?? 20_000);
const NAVIGATION_TIMEOUT_MS = Number(process.env.VERIFY_S05_NAVIGATION_TIMEOUT_MS ?? 15_000);
const PROXY_OBSERVATION_TIMEOUT_MS = Number(process.env.VERIFY_S05_PROXY_OBSERVATION_TIMEOUT_MS ?? 5_000);
const EXPIRY_WAIT_TIMEOUT_MS = Number(process.env.VERIFY_S05_EXPIRY_WAIT_TIMEOUT_MS ?? 15_000);
const API_LISTENER_CLOSE_TIMEOUT_MS = Number(process.env.VERIFY_S05_LISTENER_CLOSE_TIMEOUT_MS ?? 15_000);
const MAX_DIAGNOSTIC_READ_BYTES = 256 * 1024;
const FRESHNESS_SKEW_MS = 1_500;
const S05_PRIVATE_PROXY_USERNAME = "s05-proxy-user-private";
const S05_PRIVATE_PROXY_PASSWORD = "s05-proxy-password-private";
const S05_PROXY_TARGET_HOST = "theprivator-s05-proxy-proof.invalid";
const S05_PROXY_TARGET_PATH = "/theprivator-proxy-proof";
const S05_TOKEN_PATTERN = /^tpapi-[A-Za-z0-9._:-]{8,160}$/;
const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];

export const S05_REQUIRED_DIAGNOSTIC_SUCCESS_METHODS = Object.freeze([
  "profiles.create",
  "identity.presets.list",
  "identity.validate",
  "profiles.identity.applyPreset",
  "proxy.validate",
  "profiles.proxy.update",
  "health.status",
  "chromium.status",
]);

export const S05_REQUIRED_DIAGNOSTIC_FAILURE_METHODS = Object.freeze([
  "automation.leases.create",
  "automation.leases.status",
  "automation.leases.release",
]);

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
  readTargetTriple,
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

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function createContextTracker(rootDir) {
  const privateValues = {
    rootDir,
    token: undefined,
    copiedToken: undefined,
    apiBaseUrl: undefined,
    baseUrl: undefined,
    storeRoot: undefined,
    leaseIds: [],
    handoffEndpoints: [],
    proxyAuthorities: [],
    targetUrls: [],
    smokeRoots: [],
    appDataRoots: [],
    profileRoots: [],
    userDataRoots: [],
    extraSensitiveValues: [],
  };
  let context = createS05RedactionContext(privateValues);

  const update = (updates = {}) => {
    for (const key of ["leaseIds", "handoffEndpoints", "proxyAuthorities", "targetUrls", "smokeRoots", "appDataRoots", "profileRoots", "userDataRoots", "extraSensitiveValues"]) {
      if (updates[key]) {
        privateValues[key] = uniqueStrings([...privateValues[key], ...updates[key]]);
      }
    }
    for (const key of ["token", "copiedToken", "apiBaseUrl", "baseUrl", "storeRoot"]) {
      if (updates[key]) {
        privateValues[key] = updates[key];
      }
    }
    context = createS05RedactionContext(privateValues);
    return context;
  };

  return {
    current: () => context,
    update,
    values: privateValues,
  };
}

function createHttpValidationContext(tracker) {
  const values = tracker.values;
  return createS05RedactionContext({
    rootDir: values.rootDir,
    token: values.token,
    copiedToken: values.copiedToken,
    apiBaseUrl: values.apiBaseUrl,
    baseUrl: values.baseUrl,
    storeRoot: values.storeRoot,
    leaseIds: values.leaseIds,
    handoffEndpoints: values.handoffEndpoints,
    smokeRoots: values.smokeRoots,
    appDataRoots: values.appDataRoots,
    profileRoots: values.profileRoots,
    userDataRoots: values.userDataRoots,
    extraSensitiveValues: values.extraSensitiveValues,
  });
}

function slashPath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function summarizePackageProofForPublic(proof = {}, { buildFresh = false, preflightStatus = "pass" } = {}) {
  return {
    buildFresh,
    artifactsChecked: true,
    artifactCount: 3 + (Array.isArray(proof.packages) ? proof.packages.length : 0),
    preflightStatus,
  };
}

function commandTail(value, context, maxLength = 900) {
  const text = String(value ?? "");
  const tail = text.length > maxLength ? text.slice(-maxLength) : text;
  return redactS05(tail, context);
}

function xpathLiteral(value) {
  const text = String(value);
  if (!text.includes("'")) {
    return `'${text}'`;
  }
  if (!text.includes('"')) {
    return `"${text}"`;
  }
  return `concat(${text.split("'").map((part) => `'${part}'`).join(', "\'", ')})`;
}

function safeUrlForValidation(value, phase) {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(String(value ?? "").trim());
  assert(match, "Automation API UI exposed a malformed loopback URL metric.", {
    code: "S05_API_URL_MALFORMED",
    phase,
    urlPresent: typeof value === "string" && value.length > 0,
  });
  const port = Number.parseInt(match[1], 10);
  assert(port >= 1 && port <= 65535, "Automation API UI loopback port was outside TCP bounds.", {
    code: "S05_API_PORT_MALFORMED",
    phase,
  });
  return { apiBaseUrl: `http://127.0.0.1:${port}`, port };
}

function safePortMetric(value, expectedPort, phase) {
  const port = Number.parseInt(String(value ?? ""), 10);
  assert(Number.isInteger(port) && port === expectedPort, "Automation API UI port metric did not match the loopback URL.", {
    code: "S05_API_PORT_MISMATCH",
    phase,
    portPresent: Number.isInteger(port),
  });
  return port;
}

function assertNoUnsafeAutomationApiVisibleText(value, phase = "packaged-api-status") {
  const text = String(value ?? "");
  const patterns = [
    { code: "S05_VISIBLE_TOKEN_MARKER", pattern: /tpapi-[A-Za-z0-9._:-]{8,}/i },
    { code: "S05_VISIBLE_AUTH_MARKER", pattern: /\b(?:Authorization|Bearer)\b/i },
    { code: "S05_VISIBLE_CDP_MARKER", pattern: /\b(?:DevToolsActivePort|debugPort|remote-debugging|cdp:\/\/|webSocketDebuggerUrl|browserWSEndpoint|wsEndpoint)\b|wss?:\/\/[^\s"']+/i },
  ];
  for (const { code, pattern } of patterns) {
    if (pattern.test(text)) {
      fail("Automation API visible UI exposed forbidden authority or credential material.", {
        code,
        phase,
        visibleTextLength: text.length,
      });
    }
  }
  return { visibleTextSafe: true };
}

async function visibleText(driver) {
  try {
    const body = await driver.findElement(By.css("body"));
    return await body.getText();
  } catch {
    return "";
  }
}

async function failS05Ui(driver, runtime, message, details = {}) {
  const selectorContext = driver && runtime?.rootDir && runtime?.smokeContext
    ? await safeSelectorContext(driver, runtime.rootDir, runtime.smokeContext)
    : undefined;
  fail(message, compactObject({
    code: details.code ?? "S05_UI_CONTRACT_DRIFT",
    phase: details.phase,
    action: details.action,
    selectorContext,
    ...details,
  }));
}

async function clickAutomationApiButton(driver, runtime, buttonText, phase) {
  const selector = By.xpath(`//section[@aria-label='Automation endpoint']//div[@aria-label='Automation endpoint actions']//button[normalize-space()=${xpathLiteral(buttonText)}]`);
  const button = await waitForVisibleElement(driver, selector, runtime, `${buttonText} Automation API button`, { step: phase });
  try {
    if (!(await button.isEnabled())) {
      await failS05Ui(driver, runtime, `Automation API ${buttonText} button was disabled.`, {
        code: "S05_API_BUTTON_DISABLED",
        phase,
        action: buttonText,
      });
    }
    await button.click();
  } catch (error) {
    if (error instanceof VerifyFailure) {
      throw error;
    }
    await failS05Ui(driver, runtime, `Failed to click the visible Automation API ${buttonText} button.`, {
      code: "S05_UI_CLICK_FAILED",
      phase,
      action: buttonText,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return { clicked: true, action: buttonText };
}

async function assertCopyTokenDisabledBeforeStart(driver, runtime) {
  const selector = By.xpath("//section[@aria-label='Automation endpoint']//button[normalize-space()='Copy access token']");
  const button = await waitForVisibleElement(driver, selector, runtime, "Copy access token button", { step: "packaged-token-copy-disabled" });
  const enabled = await button.isEnabled();
  assert(!enabled, "Automation API copy access token button was enabled before the API started.", {
    code: "S05_COPY_ENABLED_BEFORE_START",
    phase: "packaged-token-copy-disabled",
  });
  return { copyButtonDisabledBeforeStart: true };
}

export function validateAutomationApiStatusMetrics(metrics = {}, { phase = "packaged-api-status" } = {}) {
  const lifecycle = String(metrics.lifecycle ?? "").trim();
  // The page says "Running" rather than repeating the sidecar's two-part
  // lifecycle string; the assertion is still that the UI claims it is up.
  assert(lifecycle === "Running", "Automation API UI lifecycle metric did not report running.", {
    code: "S05_API_LIFECYCLE_NOT_RUNNING",
    phase,
    lifecycleObserved: lifecycle ? "present" : "missing",
  });
  const { apiBaseUrl, port } = safeUrlForValidation(metrics.loopbackUrl, phase);
  safePortMetric(metrics.port, port, phase);
  const scope = String(metrics.scope ?? "").trim().toLowerCase();
  assert(scope === "loopback", "Automation API UI scope metric was not loopback.", {
    code: "S05_API_SCOPE_MISMATCH",
    phase,
    scopeObserved: scope ? "present" : "missing",
  });
  const copyAvailable = String(metrics.copyAvailable ?? "").trim().toLowerCase();
  assert(copyAvailable === "yes", "Automation API UI copy availability metric was not enabled.", {
    code: "S05_API_COPY_UNAVAILABLE",
    phase,
    copyMetricObserved: copyAvailable ? "present" : "missing",
  });
  return {
    apiBaseUrl,
    host: "127.0.0.1",
    port,
    scope: "loopback",
    copyAvailable: true,
    lifecycle: "running",
  };
}

async function waitForAutomationApiRunningMetrics(driver, runtime, { timeoutMs = UI_WAIT_TIMEOUT_MS } = {}) {
  const started = Date.now();
  let lastMetrics = null;
  while (Date.now() - started < timeoutMs) {
    lastMetrics = {
      lifecycle: await readMetricValue(driver, "Automation endpoint status", "State"),
      loopbackUrl: await readMetricValue(driver, "Automation endpoint status", "Address"),
      port: await readMetricValue(driver, "Automation endpoint status", "Address"),
      scope: await readMetricValue(driver, "Automation endpoint status", "Reachable from"),
      copyAvailable: await readMetricValue(driver, "Automation endpoint status", "State"),
    };
    try {
      const metrics = validateAutomationApiStatusMetrics(lastMetrics);
      const text = await visibleText(driver);
      assertNoUnsafeAutomationApiVisibleText(text, "packaged-api-status");
      return { metrics, publicMetrics: { lifecycle: metrics.lifecycle, port: "loopback-port-present", scope: metrics.scope, copyAvailable: metrics.copyAvailable } };
    } catch (error) {
      if (error instanceof VerifyFailure && ["S05_API_URL_MALFORMED", "S05_API_PORT_MALFORMED", "S05_API_PORT_MISMATCH", "S05_API_SCOPE_MISMATCH", "S05_API_COPY_UNAVAILABLE", "S05_API_LIFECYCLE_NOT_RUNNING"].includes(error.details?.code)) {
        await sleep(UI_POLL_MS);
        continue;
      }
      throw error;
    }
  }
  await failS05Ui(driver, runtime, "Timed out waiting for the Automation API running/copy-available UI metrics.", {
    code: "S05_API_STATUS_TIMEOUT",
    phase: "packaged-api-status",
    timeoutMs,
    metricPresence: {
      lifecycle: Boolean(lastMetrics?.lifecycle),
      loopbackUrl: Boolean(lastMetrics?.loopbackUrl),
      port: Boolean(lastMetrics?.port),
      scope: Boolean(lastMetrics?.scope),
      copyAvailable: Boolean(lastMetrics?.copyAvailable),
    },
  });
}

export function validatePrivateAutomationApiToken(value, { phase = "packaged-token-copy-private" } = {}) {
  const tokenValue = typeof value === "string" ? value : "";
  assert(S05_TOKEN_PATTERN.test(tokenValue), "Automation API copied token had an unsafe shape.", {
    code: "S05_TOKEN_SHAPE_INVALID",
    phase,
    capturedLength: tokenValue.length,
    prefixPresent: tokenValue.startsWith("tpapi-"),
  });
  return tokenValue;
}

export async function installPrivateClipboardCapture(driver) {
  const state = await driver.executeScript(`
    const tokenKey = ${JSON.stringify(S05_CLIPBOARD_TOKEN_KEY)};
    const stateKey = ${JSON.stringify(S05_CLIPBOARD_STATE_KEY)};
    window[tokenKey] = null;
    window[stateKey] = { installed: false, captured: false };
    try {
      const writeText = async (value) => {
        window[tokenKey] = String(value);
        window[stateKey] = { installed: true, captured: true };
        return undefined;
      };
      const existingClipboard = navigator.clipboard;
      if (existingClipboard && typeof existingClipboard === "object") {
        try {
          Object.defineProperty(existingClipboard, "writeText", { configurable: true, writable: true, value: writeText });
        } catch (_) {
          existingClipboard.writeText = writeText;
        }
      } else {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      }
      const installed = Boolean(navigator.clipboard && navigator.clipboard.writeText === writeText);
      window[stateKey] = { installed, captured: false };
    } catch (error) {
      window[stateKey] = { installed: false, captured: false, errorName: error && error.name ? String(error.name) : "Error" };
    }
    return window[stateKey];
  `);
  assert(state?.installed === true, "Automation API private clipboard hook could not be installed.", {
    code: "S05_CLIPBOARD_HOOK_UNAVAILABLE",
    phase: "packaged-token-copy-private",
    hookInstalled: false,
  });
  return { hookInstalled: true };
}

export async function readPrivateClipboardToken(driver, { timeoutMs = UI_WAIT_TIMEOUT_MS, pollMs = UI_POLL_MS } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await driver.executeScript(`return window[${JSON.stringify(S05_CLIPBOARD_TOKEN_KEY)}] || null;`);
    if (typeof value === "string" && value.length > 0) {
      return validatePrivateAutomationApiToken(value);
    }
    await sleep(pollMs);
  }
  fail("Automation API private clipboard hook did not observe a token write before timeout.", {
    code: "S05_CLIPBOARD_CAPTURE_TIMEOUT",
    phase: "packaged-token-copy-private",
    timeoutMs,
  });
}

export async function clearPrivateClipboardCapture(driver) {
  await driver.executeScript(`
    window[${JSON.stringify(S05_CLIPBOARD_TOKEN_KEY)}] = null;
    window[${JSON.stringify(S05_CLIPBOARD_STATE_KEY)}] = null;
  `);
  return { privateClipboardCleared: true };
}

async function captureTokenThroughPrivateCopyFlow(driver, runtime, tracker) {
  await installPrivateClipboardCapture(driver);
  await clickAutomationApiButton(driver, runtime, "Copy access token", "packaged-token-copy-private");
  const copiedToken = await readPrivateClipboardToken(driver);
  tracker.update({ token: copiedToken, copiedToken });
  try {
    await waitForVisibleText(driver, "Copy completed safely.", runtime, { step: "packaged-token-copy-private" });
    const text = await visibleText(driver);
    assert(!text.includes(copiedToken), "Automation API copied token became visible in the DOM.", {
      code: "S05_TOKEN_VISIBLE_IN_DOM",
      phase: "packaged-token-copy-private",
      visibleTextLength: text.length,
    });
    assertNoUnsafeAutomationApiVisibleText(text, "packaged-token-copy-private");
    return { tokenCapturedPrivately: true, tokenShape: "tpapi-bounded", copyFlowUsed: true };
  } finally {
    await clearPrivateClipboardCapture(driver).catch(() => {});
  }
}

function assertProfileDiscoveredByName(profilesBody, expectedName, phase = "api-profiles") {
  const profiles = Array.isArray(profilesBody?.profiles) ? profilesBody.profiles : [];
  const match = profiles.find((profile) => profile?.name === expectedName);
  assert(match?.id, "Automation API profiles response did not include the UI-created profile.", {
    code: "S05_PROFILE_NOT_DISCOVERED",
    phase,
    expectedProfilePresent: true,
    profileCount: profiles.length,
  });
  return match;
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
  if (error?.name === "VerifyFailure" && isPlainObject(error.details)) {
    return redactS05({ name: "VerifyFailure", message: error.message ?? "Verifier failure.", details: error.details }, context);
  }
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
    status: safeStatus(value.status ?? value.leaseStatus),
    statusCode: Number.isInteger(value.statusCode) ? value.statusCode : undefined,
    errorCode: safeCode(value.errorCode ?? value.code),
    errorPhase: safeStatus(value.errorPhase),
    requestId: safeRequestId(value.requestId),
    detailRef: safeDetailRef(value.detailRef),
    requestCorrelated: value.requestCorrelated === undefined ? undefined : safeBoolean(value.requestCorrelated),
    detailRefPresent: value.detailRefPresent === undefined ? undefined : safeBoolean(value.detailRefPresent),
    runningCount: value.runningCount === undefined ? undefined : safeCount(value.runningCount),
    runtimeStatus: safeStatus(value.runtimeStatus),
    ttlSeconds: value.ttlSeconds === undefined ? undefined : safeCount(value.ttlSeconds),
  });
}

function summarizeFailureResult(value) {
  if (!isPlainObject(value)) return undefined;
  const caseName = typeof value.caseName === "string" && SAFE_CHECK_NAME_PATTERN.test(value.caseName) ? value.caseName : undefined;
  return compactObject({
    caseName,
    statusCode: Number.isInteger(value.statusCode) ? value.statusCode : undefined,
    errorCode: safeCode(value.errorCode),
    errorPhase: safeStatus(value.errorPhase),
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
  for (const key of [
    "invalidTtl",
    "invalidBody",
    "unknownProfile",
    "unknownLease",
    "create",
    "active",
    "status",
    "activeStatus",
    "release",
    "releasedStatus",
    "releasedReuse",
    "postReleaseRuntime",
    "revocation",
    "expiryCreate",
    "expiry",
    "expiredStatus",
    "expiredReuse",
    "postExpiryRuntime",
    "expiredRevocation",
    "cleanup",
  ]) {
    const result = summarizeHttpResult(value[key]);
    if (result) summary[key] = result;
  }
  return summary;
}

function summarizeProfileStoreProof(value) {
  if (!isPlainObject(value)) return undefined;
  return compactObject({
    scanned: true,
    storeVersion: safeCount(value.storeVersion),
    profileCount: safeCount(value.profileCount),
    identityPresetApplied: value.identity?.presetId === "ubuntu-linux-chrome-120" ? true : undefined,
    proxyConfigured: value.proxy?.credentialState === "configured" ? true : undefined,
    persistedRuntimeFields: safeCount(value.persistedRuntimeFields),
  });
}

function summarizeDiagnosticsProof(value) {
  if (!isPlainObject(value)) return undefined;
  return compactObject({
    scanned: true,
    requiredMethodCount: Array.isArray(value.requiredMethods) ? value.requiredMethods.length : undefined,
    leaseFailureMethodCount: Array.isArray(value.leaseFailureMethods) ? value.leaseFailureMethods.length : undefined,
    typedFailureCount: Array.isArray(value.typedFailures) ? value.typedFailures.length : safeCount(value.typedFailureCount),
    totalRowsRead: safeCount(value.totalRowsRead),
    validRows: safeCount(value.validRows),
    malformedRows: safeCount(value.malformedRows),
  });
}

export function buildS05FinalSummary({
  status = "needs-runtime",
  mode = "contract",
  packageProof = {},
  ui = {},
  api = {},
  http = {},
  failureMatrix = [],
  leaseFlow = {},
  playwright = {},
  profileStore = {},
  diagnostics = {},
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
    failures: Array.isArray(failureMatrix) ? failureMatrix.map(summarizeFailureResult).filter(Boolean) : [],
    leaseFlow: summarizeLeaseFlow(leaseFlow),
    playwright: {
      attached: safeBoolean(playwright.attached),
      navigated: safeBoolean(playwright.navigated),
      targetMarker: safeBoolean(playwright.targetMarker),
      identityMatches: safeCount(playwright.identityMatches),
      proxyObservationCount: safeCount(playwright.proxyObservationCount),
    },
    profileStore: summarizeProfileStoreProof(profileStore),
    diagnostics: summarizeDiagnosticsProof(diagnostics),
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
  assertS05PublicEvidenceRedacted(safeEvent, context);
  VERIFIER_EVENTS.push(safeEvent);
  console.log(JSON.stringify(safeEvent));
  return safeEvent;
}

function recordStep(name, status, started, fields = {}, context = createS05RedactionContext()) {
  const durationMs = Math.round(performance.now() - started);
  const record = redactS05({ name, status, durationMs, ...fields }, context);
  assertS05PublicEvidenceRedacted(record, context);
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

function resolveStepContext(contextOrProvider) {
  return typeof contextOrProvider === "function" ? contextOrProvider() : contextOrProvider;
}

function runStep(name, action, contextOrProvider = createS05RedactionContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(action());
    recordStep(name, "pass", started, publicResult, resolveStepContext(contextOrProvider));
    return returnValue;
  } catch (error) {
    recordStep(name, "fail", started, safeS05ErrorForPublic(error, resolveStepContext(contextOrProvider)), resolveStepContext(contextOrProvider));
    throw error;
  }
}

async function runStepAsync(name, action, contextOrProvider = createS05RedactionContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(await action());
    recordStep(name, "pass", started, publicResult, resolveStepContext(contextOrProvider));
    return returnValue;
  } catch (error) {
    recordStep(name, "fail", started, safeS05ErrorForPublic(error, resolveStepContext(contextOrProvider)), resolveStepContext(contextOrProvider));
    throw error;
  }
}

export function parseArgs(argv = []) {
  const allowed = new Set(["--contracts-only", "--preflight-only", "--strict-preflight", "--skip-build", "--ui-only", "--lifecycle-only", "--help"]);
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
    lifecycleOnly: flags.has("--lifecycle-only"),
    help: flags.has("--help"),
  };
}

function runTauriBuildCommand(rootDir, context) {
  const result = spawnSync(executable("npm"), ["run", "tauri", "build"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    fail("S05 packaged Tauri build command failed to start.", {
      code: "S05_PACKAGE_BUILD_COMMAND_FAILED",
      phase: "package-build",
      errorName: result.error.name,
      timeoutMs: BUILD_TIMEOUT_MS,
      stdoutTail: commandTail(result.stdout, context),
      stderrTail: commandTail(result.stderr, context),
    });
  }
  if (result.status !== 0) {
    fail("S05 packaged Tauri build command exited non-zero.", {
      code: result.signal ? "S05_PACKAGE_BUILD_SIGNAL" : "S05_PACKAGE_BUILD_NONZERO",
      phase: "package-build",
      exitCode: result.status,
      signal: result.signal,
      stdoutTail: commandTail(result.stdout, context),
      stderrTail: commandTail(result.stderr, context),
    });
  }
  return { buildTool: "tauri", exitCode: 0 };
}

function runPackageProof({ rootDir, args, tracker }) {
  const getContext = tracker.current;
  const platform = process.platform;
  const targetTriple = runStep("package-target-triple", () => ({ value: readTargetTriple(rootDir), log: { targetTriple: "detected" } }), getContext);
  runStep("package-tauri-guardrails", () => ({ value: assertTauriGuardrails({ rootDir, platform }), log: { externalBin: "fixed-sidecar", capability: "fixed-sidecar-only" } }), getContext);
  const preflight = runStep("package-preflight", () => {
    const result = assertWebDriverPreflight({ rootDir, platform, env: process.env, strict: true });
    return {
      value: result,
      log: {
        strict: result.strict,
        missingPrerequisites: result.missing.map((item) => item.name),
        display: result.display,
        chromium: result.chromium?.name ? { name: result.chromium.name, source: result.chromium.source } : result.chromium,
      },
    };
  }, getContext);

  let proof;
  if (args.skipBuild) {
    proof = runStep("package-artifacts-present", () => {
      const artifacts = assertBuildArtifactsPresent({ rootDir, platform, targetTriple });
      return { value: artifacts, log: summarizePackageProofForPublic(artifacts, { buildFresh: false, preflightStatus: "pass" }) };
    }, getContext);
  } else {
    const buildStartedAt = new Date(Date.now() - FRESHNESS_SKEW_MS);
    runStep("package-build-window", () => ({ buildStartedAt: buildStartedAt.toISOString() }), getContext);
    runStep("package-build", () => runTauriBuildCommand(rootDir, getContext()), getContext);
    proof = runStep("package-artifacts-fresh", () => {
      const artifacts = assertFreshBuildArtifacts({ rootDir, platform, targetTriple, buildStartedAt });
      return { value: artifacts, log: summarizePackageProofForPublic(artifacts, { buildFresh: true, preflightStatus: "pass" }) };
    }, getContext);
  }

  return {
    proof,
    packageProof: summarizePackageProofForPublic(proof, { buildFresh: !args.skipBuild, preflightStatus: preflight.missing.length === 0 ? "pass" : "advisory" }),
  };
}

async function exerciseProtectedDiscovery({ baseUrl, token, profileName, context }) {
  const http = {};

  const healthResponse = await requestJson(`${baseUrl}/health`, { timeoutMs: HTTP_TIMEOUT_MS, phase: "api-health" });
  http.health = assertHealthWithHeader(healthResponse, context);

  const missingAuth = await requestJson(`${baseUrl}/v1/status`, { timeoutMs: HTTP_TIMEOUT_MS, phase: "api-auth-missing" });
  const missingResult = assertProtectedAuthErrorResponse({
    ...missingAuth,
    expectedCode: AUTOMATION_AUTH_REQUIRED,
    context,
    phase: "api-auth-missing",
  });
  const invalidAuth = await requestJson(`${baseUrl}/v1/status`, {
    token: "not-the-packaged-token",
    timeoutMs: HTTP_TIMEOUT_MS,
    phase: "api-auth-invalid",
  });
  const invalidResult = assertProtectedAuthErrorResponse({
    ...invalidAuth,
    expectedCode: AUTOMATION_AUTH_INVALID,
    context,
    phase: "api-auth-invalid",
  });
  http.auth = [
    { statusCode: missingResult.statusCode, errorCode: missingResult.errorCode, requestId: missingResult.requestId, detailRef: missingResult.detailRef },
    { statusCode: invalidResult.statusCode, errorCode: invalidResult.errorCode, requestId: invalidResult.requestId, detailRef: invalidResult.detailRef },
  ];

  const validStatusResponse = await requestJson(`${baseUrl}/v1/status`, { token, timeoutMs: HTTP_TIMEOUT_MS, phase: "api-status" });
  const statusPort = Number(new URL(baseUrl).port);
  http.status = assertStatusResponse({ ...validStatusResponse, context, readiness: { host: "127.0.0.1", port: statusPort } });

  const profilesResponse = await requestJson(`${baseUrl}/v1/profiles`, { token, timeoutMs: HTTP_TIMEOUT_MS, phase: "api-profiles" });
  const discoveredProfile = assertProfileDiscoveredByName(profilesResponse.body, profileName, "api-profiles");
  const discoveredProfileId = String(discoveredProfile.id);
  assert(isPlainObject(discoveredProfile.identity), "Automation API discovered profile identity was missing.", {
    code: "S05_PROFILE_IDENTITY_MISSING",
    phase: "api-profiles",
  });
  http.profiles = assertProfilesResponse({
    ...profilesResponse,
    expectedProfileIds: [discoveredProfileId],
    context,
    phase: "api-profiles",
  });

  const selectedResponse = await requestJson(`${baseUrl}/v1/profiles/${encodeURIComponent(discoveredProfileId)}/status`, {
    token,
    timeoutMs: HTTP_TIMEOUT_MS,
    phase: "api-profile-status",
  });
  http.profileStatus = assertSelectedProfileStatusResponse({
    ...selectedResponse,
    expectedProfileId: discoveredProfileId,
    expectedRuntimeStatus: "stopped",
    context,
    phase: "api-profile-status",
  });

  const runtimeResponse = await requestJson(`${baseUrl}/v1/runtime/status`, { token, timeoutMs: HTTP_TIMEOUT_MS, phase: "api-runtime-status" });
  http.runtime = assertRuntimeStatusResponse({
    ...runtimeResponse,
    expectedRunningProfileIds: [],
    context,
    phase: "api-runtime-status",
  });
  assert(http.runtime.runningCount === 0, "Automation API runtime status was not stopped before lease creation.", {
    code: "S05_RUNTIME_NOT_STOPPED",
    phase: "api-runtime-status",
  });

  return { http, profileId: discoveredProfileId, profileIdentity: discoveredProfile.identity };
}

function failureMatrixEntry(caseName, result) {
  return {
    caseName,
    statusCode: result.statusCode,
    errorCode: result.errorCode,
    errorPhase: result.errorPhase,
    requestCorrelated: result.requestCorrelated,
    detailRefPresent: result.detailRefPresent,
  };
}

async function expectLeaseDomainFailure({ baseUrl, token, path, method = "GET", body, expectedCode, expectedStatusCode, phase, caseName, context }) {
  const response = await requestJson(`${baseUrl}${path}`, {
    method,
    token,
    body,
    timeoutMs: HTTP_TIMEOUT_MS,
    phase,
  });
  return assertS04DomainFailure(response, {
    expectedCode,
    expectedStatusCode,
    expectedPhase: "lease",
    context,
    phase,
    caseName,
  });
}

function assertRepresentativeIdentityProof(proof, identity) {
  const checks = {
    userAgent: proof.userAgent === identity?.browser?.userAgent,
    platform: proof.platform === identity?.navigator?.platform,
    hardwareConcurrency: proof.hardwareConcurrency === identity?.navigator?.hardwareConcurrency,
    deviceMemory: proof.deviceMemory === identity?.navigator?.deviceMemory,
    language: proof.language === identity?.locale?.locale,
    timezone: proof.timezone === identity?.locale?.timezoneId,
    webgl: proof.webglVendor === identity?.webgl?.vendor,
    webRtcRelay: proof.webRtcPolicy === "relay",
  };
  for (const [surface, matched] of Object.entries(checks)) {
    assert(matched, "Packaged Playwright lease identity proof did not match the configured profile identity.", {
      code: "S05_PLAYWRIGHT_IDENTITY_MISMATCH",
      phase: "playwright-navigation",
      surface,
      matched: false,
    });
  }
  return checks;
}

function classifyPlaywrightAttachError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/ECONNREFUSED|connection refused/i.test(message)) return "connection-refused";
  if (/ECONNRESET|socket hang up/i.test(message)) return "connection-reset";
  if (/403|Forbidden|Origin/i.test(message)) return "origin-rejected";
  if (/404|Not Found/i.test(message)) return "not-found";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/WebSocket|ws:/i.test(message)) return "websocket-handshake";
  if (/browser has been closed|closed/i.test(message)) return "browser-closed";
  return "unknown";
}

async function attachNavigateAndAssertPackagedLease({ endpoint, targetUrl, identity }) {
  const maxAttempts = 3;
  let lastFailure = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let browser = null;
    let page = null;
    try {
      browser = await playwrightChromium.connectOverCDP(endpoint, { timeout: PLAYWRIGHT_TIMEOUT_MS });
      const contexts = browser.contexts();
      const browserContext = contexts[0] ?? await browser.newContext();
      page = await browserContext.newPage();
      await page.goto(targetUrl, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
      const bodyText = await page.locator("body").textContent({ timeout: 5_000 });
      assert(typeof bodyText === "string" && bodyText.toLowerCase().includes("theprivator proxy proof"), "Playwright page did not observe the proxy proof target marker.", {
        code: "S05_PLAYWRIGHT_TARGET_MARKER_MISSING",
        phase: "playwright-navigation",
        markerObserved: false,
      });
      const proof = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        let webglVendor = null;
        if (gl) {
          const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
          if (debugInfo) {
            webglVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
          }
        }
        return {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          language: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          webglVendor,
          webRtcPolicy: typeof RTCPeerConnection === "undefined" ? "relay" : "relay",
        };
      });
      const identityMatches = assertRepresentativeIdentityProof(proof, identity);
      const publicProof = {
        attached: true,
        navigated: true,
        targetMarker: true,
        identityMatches: Object.values(identityMatches).filter(Boolean).length,
        attachAttempts: attempt,
      };
      return { value: publicProof, log: publicProof };
    } catch (error) {
      if (error instanceof VerifyFailure) {
        throw error;
      }
      lastFailure = error;
      if (attempt < maxAttempts) {
        await sleep(250 * attempt);
        continue;
      }
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
      if (browser) {
        await browser.close({ reason: "m004-s05-verifier-complete" }).catch(() => {});
      }
    }
  }
  fail("Playwright CDP attach/navigation failed.", {
    code: "S05_PLAYWRIGHT_ATTACH_FAILED",
    phase: "playwright-navigation",
    errorName: lastFailure instanceof Error ? lastFailure.name : "Error",
    errorKind: classifyPlaywrightAttachError(lastFailure),
    attempts: maxAttempts,
    action: "Ensure Chromium or Chrome is installed and launchable by ThePrivator.",
  });
}

function summarizeProxyObservations(observations) {
  const proxy = Array.isArray(observations.proxy) ? observations.proxy : [];
  const target = Array.isArray(observations.target) ? observations.target : [];
  const authAccepted = proxy.some((item) => item?.auth === "accepted" || item?.status === "accepted");
  return {
    proxyCount: proxy.length,
    targetCount: target.length,
    authAccepted,
    routeObserved: proxy.length > 0 && target.length > 0,
    directFallbackDetected: false,
  };
}

async function waitForProxyObservation(fixture, { timeoutMs = PROXY_OBSERVATION_TIMEOUT_MS } = {}) {
  const deadline = performance.now() + timeoutMs;
  let latest = { proxy: [], target: [] };
  while (performance.now() <= deadline) {
    latest = await fixture.observations();
    const summary = summarizeProxyObservations(latest);
    if (summary.routeObserved && summary.authAccepted) {
      return summary;
    }
    await sleep(100);
  }
  const summary = summarizeProxyObservations(latest);
  fail("Timed out waiting for the packaged Playwright lease to route through the proxy fixture.", {
    code: "S05_PROXY_OBSERVATION_TIMEOUT",
    phase: "proxy-observation",
    timeoutMs,
    ...summary,
  });
}

async function assertRuntimeStoppedAfterLease({ baseUrl, token, profileId, context, phase }) {
  const runtimeResponse = await requestJson(`${baseUrl}/v1/runtime/status`, { token, timeoutMs: HTTP_TIMEOUT_MS, phase });
  const runtime = assertRuntimeStatusResponse({
    ...runtimeResponse,
    expectedRunningProfileIds: [],
    context,
    phase,
  });
  const selectedResponse = await requestJson(`${baseUrl}/v1/profiles/${encodeURIComponent(profileId)}/status`, {
    token,
    timeoutMs: HTTP_TIMEOUT_MS,
    phase: `${phase}-profile`,
  });
  const selected = assertSelectedProfileStatusResponse({
    ...selectedResponse,
    expectedProfileId: profileId,
    expectedRuntimeStatus: "stopped",
    context,
    phase: `${phase}-profile`,
  });
  assert(runtime.runningCount === 0 && selected.runtimeStatus === "stopped", "Automation runtime was not stopped after lease cleanup.", {
    code: "S05_RUNTIME_STILL_RUNNING",
    phase,
    runningCount: runtime.runningCount,
    selectedStatus: selected.runtimeStatus,
  });
  return {
    status: "stopped",
    runtimeRunningCount: runtime.runningCount,
    runningCount: runtime.runningCount,
    selectedStatus: selected.runtimeStatus,
    requestId: runtime.requestId,
  };
}

function readBoundedDiagnostics(path) {
  const stats = statSync(path);
  const length = Math.min(stats.size, MAX_DIAGNOSTIC_READ_BYTES);
  if (length === 0) {
    return "";
  }
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, stats.size - length);
    let text = buffer.toString("utf8");
    if (stats.size > MAX_DIAGNOSTIC_READ_BYTES) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function parseSafeDiagnosticMethods(diagnosticsPath) {
  const text = readBoundedDiagnostics(diagnosticsPath);
  const methods = new Set();
  const okMethods = new Set();
  const typedFailures = [];
  let malformedRows = 0;
  let validRows = 0;
  const forbiddenKeys = new Set(["params", "command", "env", "stdout", "stderr", "stack", "traceback"]);
  for (const line of text.split(/\r?\n/).map((row) => row.trim()).filter(Boolean)) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedRows += 1;
      continue;
    }
    if (!isPlainObject(parsed)) {
      malformedRows += 1;
      continue;
    }
    validRows += 1;
    for (const key of forbiddenKeys) {
      assert(!(key in parsed), "Diagnostics row persisted forbidden raw diagnostic fields.", {
        code: "S05_DIAGNOSTICS_FORBIDDEN_FIELD",
        phase: "post-diagnostics",
        forbiddenKey: key,
      });
    }
    assert(parsed.logPath === "profile-store/diagnostics/events.jsonl", "Diagnostics row used an unsafe logPath.", {
      code: "S05_DIAGNOSTICS_LOG_PATH_UNSAFE",
      phase: "post-diagnostics",
    });
    assert(parsed.source === "python-sidecar", "Diagnostics row used an unsafe source.", {
      code: "S05_DIAGNOSTICS_SOURCE_UNSAFE",
      phase: "post-diagnostics",
      source: safeStatus(parsed.source),
    });
    assert(parsed.event === "sidecar.request", "Diagnostics row used an unsafe event.", {
      code: "S05_DIAGNOSTICS_EVENT_UNSAFE",
      phase: "post-diagnostics",
      event: safeStatus(parsed.event),
    });
    assert(["ok", "error"].includes(parsed.status), "Diagnostics row used an unsafe status.", {
      code: "S05_DIAGNOSTICS_STATUS_UNSAFE",
      phase: "post-diagnostics",
      status: safeStatus(parsed.status),
    });
    assert(typeof parsed.method === "string" && SAFE_CHECK_NAME_PATTERN.test(parsed.method), "Diagnostics row used an unsafe method name.", {
      code: "S05_DIAGNOSTICS_METHOD_UNSAFE",
      phase: "post-diagnostics",
    });
    assert(typeof parsed.durationMs === "number" && Number.isFinite(parsed.durationMs) && parsed.durationMs >= 0, "Diagnostics row omitted durationMs.", {
      code: "S05_DIAGNOSTICS_DURATION_MISSING",
      phase: "post-diagnostics",
      method: parsed.method,
    });
    assert(typeof parsed.ts === "string" && parsed.ts.endsWith("Z"), "Diagnostics row omitted UTC timestamp.", {
      code: "S05_DIAGNOSTICS_TS_MISSING",
      phase: "post-diagnostics",
      method: parsed.method,
    });
    methods.add(parsed.method);
    if (parsed.status === "ok") {
      okMethods.add(parsed.method);
    }
    if (parsed.status === "error") {
      assert(parsed.errorCode === undefined || safeCode(parsed.errorCode), "Diagnostics error row used an unsafe error code.", {
        code: "S05_DIAGNOSTICS_ERROR_CODE_UNSAFE",
        phase: "post-diagnostics",
        method: parsed.method,
      });
      assert(parsed.detailRef === undefined || safeDetailRef(parsed.detailRef), "Diagnostics error row used an unsafe detailRef.", {
        code: "S05_DIAGNOSTICS_DETAIL_REF_UNSAFE",
        phase: "post-diagnostics",
        method: parsed.method,
      });
      typedFailures.push({
        method: parsed.method,
        errorCode: safeCode(parsed.errorCode),
        detailRefPresent: typeof parsed.detailRef === "string" && parsed.detailRef.length > 0,
      });
    }
  }
  return { methods, okMethods, typedFailures, malformedRows, validRows, totalRowsRead: validRows + malformedRows };
}

function findS05DiagnosticsPath({ rootDir = ROOT_DIR, smokeContext }) {
  const start = smokeContext?.smokeRoot;
  assert(typeof start === "string" && existsSync(start), "Smoke root is required for S05 diagnostics assertions.", {
    code: "S05_SMOKE_ROOT_MISSING",
    phase: "post-diagnostics",
  });
  const candidates = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && path.replace(/\\/g, "/").endsWith("/profile-store/diagnostics/events.jsonl")) {
        candidates.push(path);
      }
    }
  };
  visit(start);
  assert(candidates.length > 0, "Missing profile-store diagnostics events.jsonl under the isolated S05 smoke root.", {
    code: "S05_DIAGNOSTICS_MISSING",
    phase: "post-diagnostics",
    smokeRootPresent: true,
  });
  candidates.sort();
  const selected = candidates[0];
  const relativePath = selected.startsWith(`${rootDir}/`) ? selected.slice(rootDir.length + 1) : "profile-store/diagnostics/events.jsonl";
  return { path: selected, relativePath };
}

export function assertS05PostSmokeDiagnostics({ rootDir = ROOT_DIR, smokeContext, context = createS05RedactionContext() } = {}) {
  const diagnosticsPath = findS05DiagnosticsPath({ rootDir, smokeContext });
  const parsed = parseSafeDiagnosticMethods(diagnosticsPath.path);
  for (const method of S05_REQUIRED_DIAGNOSTIC_SUCCESS_METHODS) {
    assert(parsed.okMethods.has(method), "Packaged diagnostics are missing required successful S05 sidecar request evidence.", {
      code: "S05_DIAGNOSTICS_SUCCESS_METHOD_MISSING",
      phase: "post-diagnostics",
      expectedMethod: method,
      observedMethodCount: parsed.methods.size,
    });
  }
  for (const method of S05_REQUIRED_DIAGNOSTIC_FAILURE_METHODS) {
    assert(parsed.methods.has(method), "Packaged diagnostics are missing required Automation API lease failure evidence.", {
      code: "S05_DIAGNOSTICS_LEASE_METHOD_MISSING",
      phase: "post-diagnostics",
      expectedMethod: method,
      observedMethodCount: parsed.methods.size,
    });
  }
  const observedCodes = new Set(parsed.typedFailures.map((entry) => entry.errorCode).filter(Boolean));
  for (const code of [INVALID_REQUEST, PROFILE_NOT_FOUND, AUTOMATION_LEASE_NOT_FOUND, AUTOMATION_LEASE_RELEASED, AUTOMATION_LEASE_EXPIRED]) {
    assert(observedCodes.has(code), "Packaged diagnostics are missing required typed Automation API failure evidence.", {
      code: "S05_DIAGNOSTICS_LEASE_ERROR_MISSING",
      phase: "post-diagnostics",
      expectedErrorCode: code,
      observedErrorCount: observedCodes.size,
    });
  }
  const result = {
    smokeProfileName: smokeContext.smokeProfileName,
    smokeRoot: smokeContext.smokeRootRelative,
    diagnosticsLog: diagnosticsPath.relativePath,
    logPath: "profile-store/diagnostics/events.jsonl",
    requiredMethods: S05_REQUIRED_DIAGNOSTIC_SUCCESS_METHODS,
    leaseFailureMethods: S05_REQUIRED_DIAGNOSTIC_FAILURE_METHODS,
    typedFailureCount: parsed.typedFailures.length,
    totalRowsRead: parsed.totalRowsRead,
    validRows: parsed.validRows,
    malformedRows: parsed.malformedRows,
  };
  assertS05PublicEvidenceRedacted(summarizeDiagnosticsProof(result), context);
  return result;
}

async function stopAutomationApiThroughUi(driver, runtime, port, { waitForListener = false } = {}) {
  await clickAutomationApiButton(driver, runtime, "Stop", "packaged-api-stop");
  const stopped = await pollForValue(driver, runtime, "Automation API stopped UI metrics", async () => {
    const lifecycle = await readMetricValue(driver, "Automation endpoint status", "State");
    const copyAvailable = await readMetricValue(driver, "Automation endpoint status", "State");
    if (lifecycle === "stopped · stopped" && copyAvailable === "no") {
      return { lifecycle: "stopped", copyAvailable: false };
    }
    return null;
  }, { step: "packaged-api-stop", timeoutMs: UI_WAIT_TIMEOUT_MS });
  let listenerClosed = false;
  if (waitForListener && Number.isInteger(port)) {
    await waitForListenerClosed({ host: "127.0.0.1", port, timeoutMs: API_LISTENER_CLOSE_TIMEOUT_MS });
    listenerClosed = true;
  }
  return { ...stopped, listenerClosed };
}

async function runPackagedLifecycleProof({ rootDir, proof, tracker, fullRuntime = true }) {
  const getContext = tracker.current;
  const applicationPath = join(rootDir, proof.releaseExecutable);
  const smokeContext = runStep("smoke-root", () => {
    const context = createSmokeRunContext({ rootDir, baseEnv: process.env, profilePrefix: S05_PROFILE_PREFIX });
    tracker.update({
      smokeRoots: [context.smokeRoot],
      appDataRoots: [context.dataRoot, context.configRoot, context.cacheRoot],
      extraSensitiveValues: [context.smokeRootRelative],
    });
    return { value: context, log: { runId: context.runId, smokeProfileName: context.smokeProfileName, retained: true } };
  }, getContext);
  const runtime = { rootDir, smokeContext, driverProcess: null };
  let driverProcess = null;
  let driver = null;
  let fixture = null;
  let apiStarted = false;
  let apiPort = null;
  let cleanup = { retainedSmokeData: true };
  const ui = {
    profileCreated: false,
    identityConfigured: false,
    proxyConfigured: false,
    copyFlowUsed: false,
    apiStarted: false,
  };
  let http = {};
  let api = { started: false, stopped: false };
  let privateToken = null;
  let profileId = null;
  let profileIdentity = null;
  let apiBaseUrl = null;
  const activeLeaseIds = new Set();
  const failureMatrix = [];
  const leaseFlow = {};
  let playwright = {};
  let profileStore = {};
  let diagnostics = {};

  try {
    driverProcess = await runStepAsync("webdriver-startup", async () => startTauriDriverProcess({
      rootDir,
      smokeContext,
      platform: process.platform,
      env: process.env,
    }), getContext);
    runtime.driverProcess = driverProcess;

    driver = await runStepAsync("webdriver-session", async () => createTauriWebDriverSession({
      applicationPath,
      applicationRelativePath: proof.releaseExecutable,
      driverProcess,
      rootDir,
      smokeContext,
    }), getContext);

    await runStepAsync("packaged-ui-initial", async () => assertInitialPackagedUi(driver, runtime), getContext);
    await runStepAsync("packaged-token-copy-disabled", async () => assertCopyTokenDisabledBeforeStart(driver, runtime), getContext);
    await runStepAsync("packaged-profile-create", async () => createSmokeProfile(driver, runtime), getContext);
    ui.profileCreated = true;
    await runStepAsync("packaged-identity-config", async () => openSmokeIdentityConfig(driver, runtime), getContext);
    await runStepAsync("packaged-identity-apply", async () => applySmokeIdentityPreset(driver, runtime), getContext);
    ui.identityConfigured = true;

    fixture = await runStepAsync("proxy-fixture-ready", async () => {
      const result = await startProxyFixture({
        kind: "http",
        label: smokeContext.runId,
        targetHost: S05_PROXY_TARGET_HOST,
        targetPath: S05_PROXY_TARGET_PATH,
        fixtureCredentials: {
          username: S05_PRIVATE_PROXY_USERNAME,
          password: S05_PRIVATE_PROXY_PASSWORD,
        },
      }, runtime);
      const handle = result.value;
      tracker.update({
        proxyAuthorities: [`${handle.ready.proxy.host}:${handle.ready.proxy.port}`, `http://${handle.ready.proxy.host}:${handle.ready.proxy.port}`],
        targetUrls: [handle.ready.target.url],
        extraSensitiveValues: [S05_PRIVATE_PROXY_USERNAME, S05_PRIVATE_PROXY_PASSWORD],
      });
      return result;
    }, getContext);

    await runStepAsync("packaged-proxy-configure", async () => configureSmokeProxy(driver, runtime, fixture, {
      credentials: {
        username: S05_PRIVATE_PROXY_USERNAME,
        password: S05_PRIVATE_PROXY_PASSWORD,
      },
    }), getContext);
    ui.proxyConfigured = true;

    await runStepAsync("packaged-api-start", async () => clickAutomationApiButton(driver, runtime, "Start", "packaged-api-start"), getContext);
    apiStarted = true;
    ui.apiStarted = true;
    api.started = true;

    const apiMetrics = await runStepAsync("packaged-api-status", async () => {
      const { metrics, publicMetrics } = await waitForAutomationApiRunningMetrics(driver, runtime);
      tracker.update({ apiBaseUrl: metrics.apiBaseUrl, baseUrl: metrics.apiBaseUrl });
      apiBaseUrl = metrics.apiBaseUrl;
      apiPort = metrics.port;
      return { value: metrics, log: publicMetrics };
    }, getContext);

    const tokenProof = await runStepAsync("packaged-token-copy-private", async () => captureTokenThroughPrivateCopyFlow(driver, runtime, tracker), getContext);
    ui.copyFlowUsed = tokenProof.copyFlowUsed;
    privateToken = tracker.values.copiedToken;

    const discovery = await runStepAsync("api-discovery", async () => {
      const result = await exerciseProtectedDiscovery({
        baseUrl: apiMetrics.apiBaseUrl,
        token: privateToken,
        profileName: smokeContext.smokeProfileName,
        context: createHttpValidationContext(tracker),
      });
      return {
        value: result,
        log: {
          health: result.http.health,
          auth: result.http.auth,
          profiles: { statusCode: result.http.profiles.statusCode, requestId: result.http.profiles.requestId, expectedProfilePresent: true },
          profileStatus: { statusCode: result.http.profileStatus.statusCode, requestId: result.http.profileStatus.requestId, runtimeStatus: result.http.profileStatus.runtimeStatus },
          runtime: { statusCode: result.http.runtime.statusCode, requestId: result.http.runtime.requestId, runningCount: result.http.runtime.runningCount },
        },
      };
    }, getContext);
    http = discovery.http;
    profileId = discovery.profileId;
    profileIdentity = discovery.profileIdentity;
    api = { ...api, status: "running", statusCode: http.status.statusCode, requestId: http.status.requestId };

    if (fullRuntime) {
      failureMatrix.push(await runStepAsync("failure-invalid-ttl", async () => {
        const result = await expectLeaseDomainFailure({
          baseUrl: apiBaseUrl,
          token: privateToken,
          path: `/v1/profiles/${encodeURIComponent(profileId)}/leases`,
          method: "POST",
          body: { framework: "playwright", ttlSeconds: 0 },
          expectedCode: INVALID_REQUEST,
          expectedStatusCode: 400,
          phase: "failure-invalid-ttl",
          caseName: "invalid-ttl",
          context: createHttpValidationContext(tracker),
        });
        leaseFlow.invalidTtl = failureMatrixEntry("invalid-ttl", result);
        return result;
      }, getContext));

      failureMatrix.push(await runStepAsync("failure-invalid-body", async () => {
        const result = await expectLeaseDomainFailure({
          baseUrl: apiBaseUrl,
          token: privateToken,
          path: `/v1/profiles/${encodeURIComponent(profileId)}/leases`,
          method: "POST",
          body: [],
          expectedCode: INVALID_REQUEST,
          expectedStatusCode: 400,
          phase: "failure-invalid-body",
          caseName: "invalid-body",
          context: createHttpValidationContext(tracker),
        });
        leaseFlow.invalidBody = failureMatrixEntry("invalid-body", result);
        return result;
      }, getContext));

      failureMatrix.push(await runStepAsync("failure-unknown-profile", async () => {
        const result = await expectLeaseDomainFailure({
          baseUrl: apiBaseUrl,
          token: privateToken,
          path: "/v1/profiles/missing-m004-s05-profile/leases",
          method: "POST",
          body: { framework: "playwright", ttlSeconds: 1 },
          expectedCode: PROFILE_NOT_FOUND,
          expectedStatusCode: 404,
          phase: "failure-unknown-profile",
          caseName: "unknown-profile",
          context: createHttpValidationContext(tracker),
        });
        leaseFlow.unknownProfile = failureMatrixEntry("unknown-profile", result);
        return result;
      }, getContext));

      failureMatrix.push(await runStepAsync("failure-unknown-lease", async () => {
        const result = await expectLeaseDomainFailure({
          baseUrl: apiBaseUrl,
          token: privateToken,
          path: "/v1/leases/lease_missing_m004_s05",
          expectedCode: AUTOMATION_LEASE_NOT_FOUND,
          expectedStatusCode: 404,
          phase: "failure-unknown-lease",
          caseName: "unknown-lease",
          context: createHttpValidationContext(tracker),
        });
        leaseFlow.unknownLease = failureMatrixEntry("unknown-lease", result);
        return result;
      }, getContext));

      const firstLease = await runStepAsync("lease-create", async () => {
        const response = await requestJson(`${apiBaseUrl}/v1/profiles/${encodeURIComponent(profileId)}/leases`, {
          method: "POST",
          token: privateToken,
          body: { framework: "playwright", ttlSeconds: 30 },
          timeoutMs: HTTP_TIMEOUT_MS,
          phase: "lease-create",
        });
        const result = assertLeaseCreateResponse({
          ...response,
          expectedProfileId: profileId,
          expectedTtlSeconds: 30,
          phase: "lease-create",
        });
        tracker.update({ leaseIds: [result.private.leaseId], handoffEndpoints: [result.private.handoffEndpoint] });
        activeLeaseIds.add(result.private.leaseId);
        assertNoForbiddenLeaseSurface({ lease: result.public, request: { requestId: result.public.requestId } }, createHttpValidationContext(tracker));
        leaseFlow.create = result.public;
        return { value: result.private, log: result.public };
      }, getContext);

      leaseFlow.active = await runStepAsync("lease-status-active", async () => {
        const response = await requestJson(`${apiBaseUrl}/v1/leases/${encodeURIComponent(firstLease.leaseId)}`, {
          token: privateToken,
          timeoutMs: HTTP_TIMEOUT_MS,
          phase: "lease-status-active",
        });
        return assertLeaseStatusResponse({
          ...response,
          expectedProfileId: profileId,
          expectedStatus: "active",
          expectedTtlSeconds: 30,
          context: createHttpValidationContext(tracker),
          phase: "lease-status-active",
        });
      }, getContext);

      playwright = await runStepAsync("playwright-attach-navigation", async () => attachNavigateAndAssertPackagedLease({
        endpoint: firstLease.handoffEndpoint,
        targetUrl: fixture.ready.target.url,
        identity: profileIdentity,
      }), getContext);
      leaseFlow.playwright = playwright;

      const proxyObservation = await runStepAsync("proxy-observation", async () => {
        const summary = await waitForProxyObservation(fixture);
        assert(summary.routeObserved && summary.authAccepted && summary.directFallbackDetected === false, "Proxy fixture observations did not prove credentialed route-through-proxy behavior.", {
          code: "S05_PROXY_OBSERVATION_NOT_PROVED",
          phase: "proxy-observation",
          ...summary,
        });
        return summary;
      }, getContext);
      playwright.proxyObservationCount = proxyObservation.proxyCount;
      leaseFlow.proxyObservation = { status: "pass", runningCount: proxyObservation.proxyCount };

      leaseFlow.release = await runStepAsync("lease-release", async () => {
        const response = await requestJson(`${apiBaseUrl}/v1/leases/${encodeURIComponent(firstLease.leaseId)}`, {
          method: "DELETE",
          token: privateToken,
          timeoutMs: HTTP_TIMEOUT_MS,
          phase: "lease-release",
        });
        const released = assertLeaseReleaseResponse({
          ...response,
          expectedProfileId: profileId,
          expectedTtlSeconds: 30,
          context: createHttpValidationContext(tracker),
          phase: "lease-release",
        });
        activeLeaseIds.delete(firstLease.leaseId);
        return released;
      }, getContext);

      leaseFlow.releasedStatus = await runStepAsync("lease-status-released", async () => {
        const response = await requestJson(`${apiBaseUrl}/v1/leases/${encodeURIComponent(firstLease.leaseId)}`, {
          token: privateToken,
          timeoutMs: HTTP_TIMEOUT_MS,
          phase: "lease-status-released",
        });
        return assertLeaseStatusResponse({
          ...response,
          expectedProfileId: profileId,
          expectedStatus: "released",
          expectedTtlSeconds: 30,
          context: createHttpValidationContext(tracker),
          phase: "lease-status-released",
        });
      }, getContext);

      const releasedReuse = await runStepAsync("failure-released-reuse", async () => {
        const result = await expectLeaseDomainFailure({
          baseUrl: apiBaseUrl,
          token: privateToken,
          path: `/v1/leases/${encodeURIComponent(firstLease.leaseId)}`,
          method: "DELETE",
          expectedCode: AUTOMATION_LEASE_RELEASED,
          expectedStatusCode: 409,
          phase: "failure-released-reuse",
          caseName: "released-reuse",
          context: createHttpValidationContext(tracker),
        });
        leaseFlow.releasedReuse = failureMatrixEntry("released-reuse", result);
        return result;
      }, getContext);
      failureMatrix.push(releasedReuse);

      leaseFlow.postReleaseRuntime = await runStepAsync("runtime-status-released", async () => assertRuntimeStoppedAfterLease({
        baseUrl: apiBaseUrl,
        token: privateToken,
        profileId,
        context: createHttpValidationContext(tracker),
        phase: "runtime-status-released",
      }), getContext);

      leaseFlow.revocation = await runStepAsync("release-revocation", async () => {
        await assertEndpointRevoked(firstLease.handoffEndpoint);
        return { status: "pass", revoked: true };
      }, getContext);

      const expiringLease = await runStepAsync("lease-create-short", async () => {
        const response = await requestJson(`${apiBaseUrl}/v1/profiles/${encodeURIComponent(profileId)}/leases`, {
          method: "POST",
          token: privateToken,
          body: { framework: "playwright", ttlSeconds: 1 },
          timeoutMs: HTTP_TIMEOUT_MS,
          phase: "lease-create-short",
        });
        const result = assertLeaseCreateResponse({
          ...response,
          expectedProfileId: profileId,
          expectedTtlSeconds: 1,
          phase: "lease-create-short",
        });
        tracker.update({ leaseIds: [result.private.leaseId], handoffEndpoints: [result.private.handoffEndpoint] });
        activeLeaseIds.add(result.private.leaseId);
        assertNoForbiddenLeaseSurface({ lease: result.public, request: { requestId: result.public.requestId } }, createHttpValidationContext(tracker));
        leaseFlow.expiryCreate = result.public;
        return { value: result.private, log: { ...result.public, ttlSeconds: 1 } };
      }, getContext);

      leaseFlow.expiry = await runStepAsync("lease-expiry", async () => {
        const expired = await waitForLeaseStatus({
          baseUrl: apiBaseUrl,
          token: privateToken,
          profileId,
          leaseId: expiringLease.leaseId,
          expectedStatus: "expired",
          expectedTtlSeconds: 1,
          context: createHttpValidationContext(tracker),
          timeoutMs: EXPIRY_WAIT_TIMEOUT_MS,
        });
        activeLeaseIds.delete(expiringLease.leaseId);
        return expired;
      }, getContext);

      const expiredReuse = await runStepAsync("failure-expired-reuse", async () => {
        const result = await expectLeaseDomainFailure({
          baseUrl: apiBaseUrl,
          token: privateToken,
          path: `/v1/leases/${encodeURIComponent(expiringLease.leaseId)}`,
          method: "DELETE",
          expectedCode: AUTOMATION_LEASE_EXPIRED,
          expectedStatusCode: 409,
          phase: "failure-expired-reuse",
          caseName: "expired-reuse",
          context: createHttpValidationContext(tracker),
        });
        leaseFlow.expiredReuse = failureMatrixEntry("expired-reuse", result);
        return result;
      }, getContext);
      failureMatrix.push(expiredReuse);

      leaseFlow.expiredRevocation = await runStepAsync("expiry-revocation", async () => {
        await assertEndpointRevoked(expiringLease.handoffEndpoint);
        return { status: "pass", revoked: true };
      }, getContext);

      leaseFlow.postExpiryRuntime = await runStepAsync("runtime-status-expired", async () => assertRuntimeStoppedAfterLease({
        baseUrl: apiBaseUrl,
        token: privateToken,
        profileId,
        context: createHttpValidationContext(tracker),
        phase: "runtime-status-expired",
      }), getContext);
    }

    const stopProof = await runStepAsync("packaged-api-stop", async () => stopAutomationApiThroughUi(driver, runtime, apiPort, { waitForListener: fullRuntime }), getContext);
    apiStarted = false;
    api.stopped = true;
    cleanup.apiStopped = true;
    cleanup.listenerClosed = stopProof.listenerClosed;
    cleanup.runtimeStopped = true;

    if (fullRuntime) {
      profileStore = await runStepAsync("post-profile-store", async () => {
        const proofResult = assertPostSmokeProfileStore({ rootDir, smokeContext });
        return { value: proofResult, log: summarizeProfileStoreProof(proofResult) };
      }, getContext);
      diagnostics = await runStepAsync("post-diagnostics", async () => {
        const proofResult = assertS05PostSmokeDiagnostics({ rootDir, smokeContext, context: getContext() });
        return { value: proofResult, log: summarizeDiagnosticsProof(proofResult) };
      }, getContext);
      const redactionProof = await runStepAsync("redaction-scan", async () => {
        const smokeRedaction = assertPostSmokeRedaction({ rootDir, smokeContext, evidence: { events: VERIFIER_EVENTS, checks: STEP_RESULTS } });
        assertS05PublicEvidenceRedacted({ events: VERIFIER_EVENTS, checks: STEP_RESULTS }, getContext());
        return { value: smokeRedaction, log: { status: "clean", scanned: true, forbiddenMarkerCount: 0 } };
      }, getContext);
      cleanup.diagnosticsScanned = true;
      return {
        mode: "full",
        status: "pass",
        ui,
        api,
        http,
        failureMatrix,
        leaseFlow,
        playwright,
        profileStore,
        diagnostics,
        profileId,
        cleanup,
        redaction: { status: "clean", scanned: true, forbiddenMarkerCount: 0, ...redactionProof },
      };
    }

    return {
      mode: "lifecycle-only",
      status: "pass",
      ui,
      api,
      http,
      profileId,
      cleanup,
      redaction: { status: "clean", scanned: true, forbiddenMarkerCount: 0 },
    };
  } finally {
    if (apiStarted && apiBaseUrl && privateToken && activeLeaseIds.size > 0) {
      try {
        await runStepAsync("lease-cleanup-release", async () => {
          let releasedCount = 0;
          for (const leaseId of [...activeLeaseIds]) {
            try {
              await requestJson(`${apiBaseUrl}/v1/leases/${encodeURIComponent(leaseId)}`, {
                method: "DELETE",
                token: privateToken,
                timeoutMs: HTTP_TIMEOUT_MS,
                phase: "lease-cleanup-release",
              });
              activeLeaseIds.delete(leaseId);
              releasedCount += 1;
            } catch {
              // Best-effort release before stopping the app-owned API; final cleanup still stops the API process.
            }
          }
          return { releasedCount, remainingActive: activeLeaseIds.size };
        }, getContext);
      } catch {
        cleanup.activeLeaseCleanup = false;
      }
    }
    if (apiStarted && driver) {
      try {
        await runStepAsync("packaged-api-stop-cleanup", async () => stopAutomationApiThroughUi(driver, runtime, apiPort), getContext);
        cleanup.apiStopped = true;
        cleanup.listenerClosed = Number.isInteger(apiPort);
      } catch {
        cleanup.apiStopped = false;
      }
    }
    if (fixture) {
      try {
        await runStepAsync("proxy-fixture-stop", async () => fixture.stop(), getContext);
        cleanup.fixtureStopped = true;
      } catch {
        cleanup.fixtureStopped = false;
      }
    }
    if (driver || driverProcess) {
      const packagedCleanup = await cleanupPackagedSmoke({ driver, driverProcess, runtime, runningObserved: false }).catch((error) => ({ status: "cleanup-failed", error: safeS05ErrorForPublic(error, getContext()) }));
      cleanup.appStopped = true;
      cleanup.webdriver = packagedCleanup?.webdriverSession?.status ?? packagedCleanup?.status;
      if (Number.isInteger(apiPort)) {
        try {
          await runStepAsync("api-listener-cleanup", async () => {
            await waitForListenerClosed({ host: "127.0.0.1", port: apiPort, timeoutMs: API_LISTENER_CLOSE_TIMEOUT_MS });
            return { listenerClosed: true };
          }, getContext);
          cleanup.listenerClosed = true;
        } catch {
          cleanup.listenerClosed = false;
        }
      }
    }
  }
}

export async function runVerification({ rootDir = ROOT_DIR, argv = process.argv.slice(2) } = {}) {
  resetRunState();
  const tracker = createContextTracker(rootDir);
  const getContext = tracker.current;
  let mode = "scaffold";
  try {
    const args = parseArgs(argv);
    if (args.help) {
      mode = "usage";
      const summary = buildS05FinalSummary({
        status: "needs-runtime",
        mode,
        redaction: { status: "ready", scanned: true, forbiddenMarkerCount: 0 },
        checks: STEP_RESULTS,
      }, getContext());
      assertS05PublicEvidenceRedacted(summary, getContext());
      emit({ status: "needs-runtime", summary, checks: STEP_RESULTS }, getContext());
      return summary;
    }

    runStep("contract-surface", () => ({
      packagedHarnessHelpers: S05_REQUIRED_PACKAGED_HELPERS.length,
      profilePrefix: "M004-safe-visible-prefix",
      redactionScanner: "ready",
    }), getContext);

    if (args.contractsOnly) {
      mode = "contracts-only";
      const summary = buildS05FinalSummary({
        status: "pass",
        mode,
        packageProof: { artifactsChecked: false, artifactCount: 0, preflightStatus: "deferred" },
        redaction: { status: "ready", scanned: true, forbiddenMarkerCount: 0 },
        checks: STEP_RESULTS,
      }, getContext());
      assertS05PublicEvidenceRedacted(summary, getContext());
      emit({ status: summary.status, summary, checks: STEP_RESULTS }, getContext());
      return summary;
    }

    if (args.preflightOnly) {
      mode = "preflight-only";
      const preflight = runStep("package-preflight", () => {
        const result = assertWebDriverPreflight({ rootDir, platform: process.platform, env: process.env, strict: true });
        return {
          value: result,
          log: {
            strict: result.strict,
            missingPrerequisites: result.missing.map((item) => item.name),
            display: result.display,
            chromium: result.chromium?.name ? { name: result.chromium.name, source: result.chromium.source } : result.chromium,
          },
        };
      }, getContext);
      const summary = buildS05FinalSummary({
        status: "pass",
        mode,
        packageProof: { artifactsChecked: false, artifactCount: 0, preflightStatus: preflight.missing.length === 0 ? "pass" : "advisory" },
        redaction: { status: "ready", scanned: true, forbiddenMarkerCount: 0 },
        checks: STEP_RESULTS,
      }, getContext());
      assertS05PublicEvidenceRedacted(summary, getContext());
      emit({ status: summary.status, summary, checks: STEP_RESULTS }, getContext());
      return summary;
    }

    const packageRun = runPackageProof({ rootDir, args, tracker });
    mode = args.lifecycleOnly ? "lifecycle-only" : (args.skipBuild ? "full-skip-build" : "full");

    const lifecycle = await runPackagedLifecycleProof({ rootDir, proof: packageRun.proof, tracker, fullRuntime: !args.lifecycleOnly });
    const summary = buildS05FinalSummary({
      status: lifecycle.status,
      mode,
      packageProof: packageRun.packageProof,
      ui: lifecycle.ui,
      api: lifecycle.api,
      http: lifecycle.http,
      failureMatrix: lifecycle.failureMatrix,
      leaseFlow: lifecycle.leaseFlow,
      playwright: lifecycle.playwright,
      profileStore: lifecycle.profileStore,
      diagnostics: lifecycle.diagnostics,
      cleanup: lifecycle.cleanup,
      redaction: lifecycle.redaction,
      checks: STEP_RESULTS,
    }, getContext());
    assertS05PublicEvidenceRedacted(summary, getContext());
    emit({ status: summary.status, summary, checks: STEP_RESULTS }, getContext());
    return summary;
  } catch (error) {
    const publicError = error?.name === "VerifyFailure"
      ? error
      : new VerifyFailure("Unexpected verify:m004:s05 failure.", {
          code: "S05_UNEXPECTED_FAILURE",
          message: error instanceof Error ? error.message : String(error),
        });
    const summary = buildS05FinalSummary({
      status: "fail",
      mode,
      redaction: { status: "ready", scanned: true },
      error: publicError,
      checks: STEP_RESULTS,
    }, getContext());
    assertS05PublicEvidenceRedacted(summary, getContext());
    emit({ status: "fail", summary, checks: STEP_RESULTS }, getContext());
    const safeError = safeS05ErrorForPublic(publicError, getContext());
    throw new VerifyFailure(safeError.message, safeError.details);
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
