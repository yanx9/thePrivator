#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AUTOMATION_AUTH_INVALID,
  AUTOMATION_AUTH_REQUIRED,
  AUTOMATION_HOST,
  ENV_HOST,
  ENV_PORT,
  ENV_STORE_ROOT,
  ENV_TOKEN,
  ROOT_DIR,
  VerifyFailure,
  assertAuthErrorResponse,
  assertHealthResponse,
  assertPublicEvidenceRedacted,
  createRedactionContext,
  executable,
  findForbiddenPublicMarker,
  parseReadinessLine,
  readTargetTriple,
  redact,
  redactText,
  redactedTail,
  targetBinaryPath,
  waitForListenerClosed,
  waitForReadiness,
} from "./verify-m004-s01.mjs";

export const VERIFY_EVENT = "verify.m004.s02";
export const PROFILE_API_VERSION = 1;
export const RUNTIME_API_VERSION = 1;
export const MAX_PROFILE_LIST_LIMIT = 100;
export const INVALID_REQUEST = "INVALID_REQUEST";
export const PROFILE_NOT_FOUND = "PROFILE_NOT_FOUND";

const READINESS_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 5_000;
const SIDECAR_TIMEOUT_MS = 15_000;
const CHROMIUM_LAUNCH_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_CHARS = 128 * 1024;
const REDACTED_VALUE = "<redacted>";
const S02_FORBIDDEN_TEXT_PATTERNS = Object.freeze([
  { markerClass: "profile_private_field", pattern: /\b(?:credentialState|userDataDir|profileDir|storeRoot|appDataRoot|storage|metadata|credentials?|username|password)\b/i },
  { markerClass: "profile_private_path", pattern: /\b(?:profile-store|profiles\.json)\b/i },
  { markerClass: "runtime_private_field", pattern: /\b(?:pid|ownerToken|launchArgs|debugPort|debugEndpoint|webSocketDebuggerUrl|wsEndpoint|DevToolsActivePort)\b/i },
  { markerClass: "runtime_private_arg", pattern: /--(?:user-data-dir|remote-debugging-port|proxy-server|load-extension|disable-extensions-except)\b/i },
  { markerClass: "runtime_private_authority", pattern: /\b(?:cdp:\/\/|wss?:\/\/[^\s"']+)\b/i },
  { markerClass: "raw_diag", pattern: /\b(?:stdout|stderr|rawDiagnostics?|rawBody|rawPayload|Traceback)\b/i },
]);
const S02_FORBIDDEN_KEY_PATTERN = /(?:credentialState|userDataDir|profileDir|storeRoot|appDataRoot|storage|metadata|credentials?|username|password|pid|ownerToken|launchArgs|debugPort|debugEndpoint|webSocketDebuggerUrl|wsEndpoint|stdout|stderr|rawDiagnostics?|rawBody|rawPayload)/i;

const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];

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

function classifyS02ForbiddenKey(key) {
  if (/credential|password|username/i.test(key)) return "profile_private_field";
  if (/userDataDir|profileDir|storeRoot|appDataRoot|storage|metadata/i.test(key)) return "profile_private_field";
  if (/pid|ownerToken|launchArgs|debugPort|debugEndpoint|webSocketDebuggerUrl|wsEndpoint/i.test(key)) return "runtime_private_field";
  if (/stdout|stderr|raw/i.test(key)) return "raw_diag";
  return "unsafe_field";
}

function isRedactedPlaceholderKey(key) {
  return /^<redacted-key:[a-z0-9_]+>$/.test(key);
}

function redactedS02KeyName(key) {
  return `<redacted-key:${classifyS02ForbiddenKey(key)}>`;
}

function safeFieldPath(path, keyOrIndex) {
  if (typeof keyOrIndex === "number") {
    return `${path}[${keyOrIndex}]`;
  }
  const segment = S02_FORBIDDEN_KEY_PATTERN.test(keyOrIndex) ? redactedS02KeyName(keyOrIndex) : keyOrIndex;
  return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
}

function safeKeyForDetails(key) {
  return S02_FORBIDDEN_KEY_PATTERN.test(key) ? redactedS02KeyName(key) : key;
}

function assertExactKeys(value, expectedKeys, label) {
  const expected = [...expectedKeys].sort();
  const actual = Object.keys(value ?? {}).sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} keys did not match the expected public contract.`, {
    phase: "contract-shape",
    expectedKeys: expected,
    actualKeys: actual.map(safeKeyForDetails),
  });
}

function assertRequestId(value, phase, fieldPath = "$.request.requestId") {
  assert(typeof value === "string" && value.startsWith("automation-"), "Automation API response did not include a safe requestId.", {
    phase,
    fieldPath,
  });
}

function assertResponseHeaderRequestId(headerRequestId, bodyRequestId, phase) {
  assertRequestId(bodyRequestId, phase);
  assert(headerRequestId === bodyRequestId, "Automation API X-Request-ID header did not match the body requestId.", {
    phase,
    headerPresent: typeof headerRequestId === "string",
  });
}

function assertIsoTimestamp(value, phase, fieldPath) {
  assert(typeof value === "string" && value.endsWith("Z"), "Automation API timestamp was not a UTC ISO string.", {
    phase,
    fieldPath,
  });
}

function assertProfileId(value, phase, fieldPath = "profileId") {
  assert(typeof value === "string" && value.trim().length > 0, "Profile id was missing from the safe response.", {
    phase,
    fieldPath,
  });
}

function assertSafeProxySummary(proxy, phase) {
  assert(isPlainObject(proxy), "Automation API profile proxy summary was not an object.", { phase });
  assert(proxy.proxyVersion === 1, "Automation API profile proxy version was not 1.", { phase });
  assert(typeof proxy.summary === "string" && proxy.summary.length > 0, "Automation API profile proxy summary was missing.", { phase });
  if (proxy.mode === "direct") {
    assertExactKeys(proxy, ["mode", "proxyVersion", "summary"], "Automation API direct proxy summary");
    assert(proxy.summary === "Direct connection", "Direct proxy summary text changed unexpectedly.", { phase });
    return "direct";
  }
  if (proxy.mode === "fixedServer") {
    assertExactKeys(proxy, ["host", "mode", "port", "protocol", "proxyVersion", "summary"], "Automation API fixed proxy summary");
    assert(["http", "https", "socks4", "socks5"].includes(proxy.protocol), "Fixed proxy protocol was not allowlisted.", { phase });
    assert(typeof proxy.host === "string" && proxy.host.length > 0, "Fixed proxy host was missing.", { phase });
    assert(Number.isInteger(proxy.port) && proxy.port > 0 && proxy.port <= 65535, "Fixed proxy port was invalid.", { phase });
    return "fixedServer";
  }
  fail("Automation API profile proxy mode was not recognized.", { phase, mode: proxy.mode });
}

function assertProfileSummary(profile, phase) {
  assert(isPlainObject(profile), "Automation API profile summary was not an object.", { phase });
  assertExactKeys(profile, ["createdAt", "defaults", "id", "identity", "name", "proxy", "updatedAt"], "Automation API profile summary");
  assertProfileId(profile.id, phase, "$.profile.id");
  assert(typeof profile.name === "string" && profile.name.length > 0, "Automation API profile name was missing.", { phase });
  assertIsoTimestamp(profile.createdAt, phase, "$.profile.createdAt");
  assertIsoTimestamp(profile.updatedAt, phase, "$.profile.updatedAt");
  assert(isPlainObject(profile.defaults), "Automation API profile defaults were not an object.", { phase });
  assertExactKeys(profile.defaults, ["browser", "fingerprintMode", "proxyMode", "startUrl"], "Automation API profile defaults");
  assert(isPlainObject(profile.identity), "Automation API profile identity summary was not an object.", { phase });
  const proxyMode = assertSafeProxySummary(profile.proxy, phase);
  return { profileId: profile.id, proxyMode };
}

function assertRuntimeEntry(entry, expectedStatus, phase, fieldPath) {
  assert(isPlainObject(entry), "Automation API runtime entry was not an object.", { phase, fieldPath });
  assertProfileId(entry.profileId, phase, `${fieldPath}.profileId`);
  assert(entry.status === expectedStatus, "Automation API runtime entry had the wrong status.", {
    phase,
    fieldPath: `${fieldPath}.status`,
    expectedStatus,
    actualStatus: entry.status,
  });
  if (expectedStatus === "running") {
    assertExactKeys(entry, ["profileId", "startedAt", "status"], "Automation API running runtime entry");
    assertIsoTimestamp(entry.startedAt, phase, `${fieldPath}.startedAt`);
  } else {
    assertExactKeys(entry, ["profileId", "status", "stoppedAt", "termination"], "Automation API reconciled runtime entry");
    assertIsoTimestamp(entry.stoppedAt, phase, `${fieldPath}.stoppedAt`);
    assert(typeof entry.termination === "string" && entry.termination.length > 0, "Automation API stopped runtime termination was missing.", {
      phase,
      fieldPath: `${fieldPath}.termination`,
    });
  }
  return { profileId: entry.profileId, status: entry.status };
}

function assertSelectedRuntimeState(entry, expectedStatus, phase) {
  assert(isPlainObject(entry), "Automation API selected-profile runtime state was not an object.", { phase });
  assertProfileId(entry.profileId, phase, "$.runtime.profileId");
  if (expectedStatus === "running") {
    assertRuntimeEntry(entry, "running", phase, "$.runtime");
    return { profileId: entry.profileId, status: "running" };
  }
  assert(entry.status === "stopped", "Automation API selected-profile runtime state did not report stopped.", { phase, actualStatus: entry.status });
  const keys = Object.keys(entry).sort();
  const allowedMinimal = JSON.stringify(keys) === JSON.stringify(["profileId", "status"]);
  const allowedReconciled = JSON.stringify(keys) === JSON.stringify(["profileId", "status", "stoppedAt", "termination"]);
  assert(allowedMinimal || allowedReconciled, "Automation API selected-profile stopped runtime shape was unsafe.", {
    phase,
    actualKeys: keys.map(safeKeyForDetails),
  });
  if (allowedReconciled) {
    assertIsoTimestamp(entry.stoppedAt, phase, "$.runtime.stoppedAt");
    assert(typeof entry.termination === "string" && entry.termination.length > 0, "Automation API selected-profile stopped termination was missing.", { phase });
  }
  return { profileId: entry.profileId, status: "stopped" };
}

export function createS02RedactionContext({ rootDir = ROOT_DIR, token, storeRoot, extraSensitiveValues = [] } = {}) {
  const context = createRedactionContext({ rootDir, token, storeRoot, extraSensitiveValues });
  return {
    ...context,
    forbiddenPatterns: [
      ...(context.forbiddenPatterns ?? []),
      ...S02_FORBIDDEN_TEXT_PATTERNS,
    ],
  };
}

export function findS02ForbiddenPublicMarker(value, context = createS02RedactionContext(), path = "$", state = { count: 0 }) {
  const s01Marker = findForbiddenPublicMarker(value, context, path, { count: 0 });
  if (s01Marker) {
    return s01Marker;
  }

  if (state.count++ > 4_000) {
    return {
      markerClass: "scan_limit",
      fieldPath: path,
      reason: "Public verifier evidence exceeded the bounded S02 redaction scan node limit.",
    };
  }

  if (typeof value === "string") {
    for (const { markerClass, pattern } of S02_FORBIDDEN_TEXT_PATTERNS) {
      if (pattern.test(value)) {
        return { markerClass, fieldPath: path, reason: "forbidden S02 text marker" };
      }
    }
    return null;
  }

  if (value === null || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findS02ForbiddenPublicMarker(item, context, safeFieldPath(path, index), state);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (!isRedactedPlaceholderKey(key) && S02_FORBIDDEN_KEY_PATTERN.test(key)) {
      return { markerClass: classifyS02ForbiddenKey(key), fieldPath: safeFieldPath(path, key), reason: "forbidden S02 key" };
    }
    const nestedMarker = findS02ForbiddenPublicMarker(nested, context, safeFieldPath(path, key), state);
    if (nestedMarker) return nestedMarker;
  }
  return null;
}

export function assertS02PublicEvidenceRedacted(value, context = createS02RedactionContext()) {
  const marker = findS02ForbiddenPublicMarker(value, context);
  assert(!marker, "S02 public verifier evidence contained a forbidden marker.", marker ?? {});
  return { status: "clean", scanned: true };
}

function redactS02Text(value, context) {
  let redacted = redactText(value, context);
  for (const { markerClass, pattern } of S02_FORBIDDEN_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, `<redacted:${markerClass}>`);
  }
  return redacted;
}

function redactS02Specific(value, context) {
  if (typeof value === "string") {
    return redactS02Text(value, context);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactS02Specific(item, context));
  }
  const safe = {};
  for (const [key, nested] of Object.entries(value)) {
    const safeKey = S02_FORBIDDEN_KEY_PATTERN.test(key) ? redactedS02KeyName(key) : redactS02Text(key, context);
    safe[safeKey] = S02_FORBIDDEN_KEY_PATTERN.test(key) ? REDACTED_VALUE : redactS02Specific(nested, context);
  }
  return safe;
}

function redactS02(value, context = createS02RedactionContext()) {
  return redactS02Specific(redact(value, context), context);
}

function safeErrorForPublic(error) {
  if (error instanceof VerifyFailure) {
    return {
      name: error.name,
      message: error.message,
      details: error.details ?? {},
    };
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

function createLineCollector(stream) {
  let text = "";
  let pending = "";
  const lines = [];
  const callbacks = new Set();

  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    text += chunk;
    if (text.length > MAX_CAPTURE_CHARS) {
      text = text.slice(-MAX_CAPTURE_CHARS);
    }
    pending += chunk;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      if (lines.length > 200) {
        lines.shift();
      }
      for (const callback of callbacks) {
        callback(line);
      }
    }
  });

  return {
    get text() {
      return text;
    },
    get lines() {
      return [...lines];
    },
    onLine(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
  };
}

function emit(event, context = createS02RedactionContext()) {
  const safeEvent = redactS02({ event: VERIFY_EVENT, ...event }, context);
  VERIFIER_EVENTS.push(safeEvent);
  console.log(JSON.stringify(safeEvent));
  return safeEvent;
}

function recordStep(name, status, started, fields = {}, context = createS02RedactionContext()) {
  const durationMs = Math.round(performance.now() - started);
  const record = redactS02({ name, status, durationMs, ...fields }, context);
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

function runStep(name, action, context = createS02RedactionContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(action());
    recordStep(name, "pass", started, publicResult, context);
    return returnValue;
  } catch (error) {
    recordStep(name, "fail", started, safeErrorForPublic(error), context);
    throw error;
  }
}

async function runStepAsync(name, action, context = createS02RedactionContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(await action());
    recordStep(name, "pass", started, publicResult, context);
    return returnValue;
  } catch (error) {
    recordStep(name, "fail", started, safeErrorForPublic(error), context);
    throw error;
  }
}

function resetRunState() {
  STEP_RESULTS.length = 0;
  VERIFIER_EVENTS.length = 0;
}

export function assertS02TargetBinary({ rootDir = ROOT_DIR, targetTriple = readTargetTriple(rootDir), binaryPath = targetBinaryPath({ rootDir, targetTriple }) } = {}) {
  const relativeBinary = relative(rootDir, binaryPath);
  assert(existsSync(binaryPath), `Missing target-triple sidecar binary ${relativeBinary}.`, {
    phase: "binary-discovery",
    binary: relativeBinary,
    targetTriple,
    action: "Run npm run sidecar:build before npm run verify:m004:s02.",
  });

  const stats = statSync(binaryPath);
  assert(stats.isFile(), "Target sidecar path is not a file.", {
    phase: "binary-discovery",
    binary: relativeBinary,
  });

  if (process.platform !== "win32") {
    assert((stats.mode & 0o111) !== 0, "Target sidecar binary is not executable on this Unix platform.", {
      phase: "binary-discovery",
      binary: relativeBinary,
      action: "Run npm run sidecar:build to recreate the executable sidecar binary.",
    });
  }

  return {
    binary: relativeBinary,
    targetTriple,
    executableChecked: process.platform !== "win32",
  };
}

function parseNdjsonLines(streamName, value, expectedCount = null, context = createS02RedactionContext()) {
  const lines = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (expectedCount !== null && lines.length !== expectedCount) {
    fail(`${streamName} emitted an unexpected number of NDJSON lines.`, {
      phase: "setup",
      streamName,
      lineCount: lines.length,
      expectedCount,
      tail: redactedTail(value, context),
    });
  }
  if (expectedCount === null && lines.length < 1) {
    fail(`${streamName} emitted no NDJSON lines.`, { phase: "setup", streamName });
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${streamName} line was not valid JSON.`, {
        phase: "setup",
        streamName,
        lineNumber: index + 1,
        errorName: error instanceof Error ? error.name : "Error",
        lineLength: line.length,
      });
    }
  });
}

function sidecarRequest(id, method, params = {}) {
  return { id, method, params };
}

function runSidecarRequest(binaryPath, request, { timeoutMs = SIDECAR_TIMEOUT_MS, env = {}, context = createS02RedactionContext() } = {}) {
  const result = spawnSync(binaryPath, {
    cwd: ROOT_DIR,
    input: `${JSON.stringify(request)}\n`,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    const timedOut = result.error.code === "ETIMEDOUT";
    fail(timedOut ? "Built sidecar request timed out." : "Built sidecar request failed.", {
      phase: "setup",
      action: request.method,
      errorCode: result.error.code ?? "SIDECAR_REQUEST_FAILED",
      timeoutMs,
      stdoutTail: redactedTail(result.stdout, context),
      stderrTail: redactedTail(result.stderr, context),
    });
  }
  if (result.status !== 0) {
    fail("Built sidecar request exited with a non-zero status.", {
      phase: "setup",
      action: request.method,
      exitCode: result.status,
      stdoutTail: redactedTail(result.stdout, context),
      stderrTail: redactedTail(result.stderr, context),
    });
  }

  const [response] = parseNdjsonLines("sidecar stdout", result.stdout, 1, context);
  const diagnostics = parseNdjsonLines("sidecar stderr", result.stderr, null, context);
  const diagnostic = diagnostics[0];
  assert(diagnostic?.event === "sidecar.request", "Sidecar diagnostic event name changed.", {
    phase: "setup",
    action: request.method,
  });
  assert(diagnostic.method === request.method, "Sidecar diagnostic method did not match the request.", {
    phase: "setup",
    action: request.method,
  });
  assert(diagnostic.requestId === request.id, "Sidecar diagnostic requestId did not match the request.", {
    phase: "setup",
    action: request.method,
  });
  assert(!("params" in diagnostic), "Sidecar diagnostic leaked request params.", {
    phase: "setup",
    action: request.method,
  });
  return { response, diagnostic, diagnostics };
}

function sidecarSuccess(binaryPath, id, method, params = {}, options = {}) {
  const transcript = runSidecarRequest(binaryPath, sidecarRequest(id, method, params), options);
  const { response, diagnostic } = transcript;
  assert(response.id === id, "Sidecar success response id mismatch.", { phase: "setup", action: method, requestId: id });
  assert(response.ok === true, `Expected ${method} to succeed.`, {
    phase: "setup",
    action: method,
    errorCode: response.error?.code,
    detailRef: response.error?.detailRef,
  });
  assert(diagnostic.status === "ok", "Sidecar diagnostic did not report ok status.", { phase: "setup", action: method });
  assert(diagnostic.errorCode === null, "Successful sidecar diagnostic should not include errorCode.", { phase: "setup", action: method });
  assert(diagnostic.detailRef === null, "Successful sidecar diagnostic should not include detailRef.", { phase: "setup", action: method });
  assert(isPlainObject(response.result), "Sidecar success response result was not an object.", { phase: "setup", action: method });
  return { ...transcript, result: response.result };
}

function makeRequestId(label) {
  return `verify-m004-s02-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "request"}`;
}

function assertSetupProfile(profile, expectedName) {
  assert(isPlainObject(profile), "Profile setup response did not include a profile object.", { phase: "profile-setup" });
  assertProfileId(profile.id, "profile-setup", "$.profile.id");
  assert(profile.name === expectedName, "Profile setup response name did not match.", { phase: "profile-setup", profileId: profile.id });
  assert(isPlainObject(profile.storage), "Profile setup response did not include storage metadata.", { phase: "profile-setup", profileId: profile.id });
  assert(typeof profile.storage.userDataDir === "string" && profile.storage.userDataDir.startsWith("profile-store/profiles/"), "Profile setup storage path was not the expected safe relative shape.", {
    phase: "profile-setup",
    profileId: profile.id,
  });
  return profile;
}

function createFakeChromiumExecutable(storeRoot) {
  const scriptPath = join(storeRoot, process.platform === "win32" ? "fake-chromium.cmd" : "fake-chromium");
  if (process.platform === "win32") {
    writeFileSync(scriptPath, "@echo off\r\n:loop\r\nping -n 2 127.0.0.1 > nul\r\ngoto loop\r\n", "utf8");
  } else {
    writeFileSync(scriptPath, "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n", "utf8");
    chmodSync(scriptPath, 0o755);
  }
  return { path: scriptPath, created: existsSync(scriptPath) };
}

function createProfilesAndLaunchRuntime({ binaryPath, storeRoot, fakeChromiumPath, context }) {
  const directName = "M004 S02 Direct";
  const fixedName = "M004 S02 Fixed Proxy";
  const direct = sidecarSuccess(
    binaryPath,
    makeRequestId("profiles-create-direct"),
    "profiles.create",
    { storeRoot, name: directName },
    { context },
  ).result;
  const directProfile = assertSetupProfile(direct.profile, directName);

  const fixed = sidecarSuccess(
    binaryPath,
    makeRequestId("profiles-create-fixed"),
    "profiles.create",
    { storeRoot, name: fixedName },
    { context },
  ).result;
  const fixedSeed = assertSetupProfile(fixed.profile, fixedName);

  const proxy = {
    proxyVersion: 1,
    mode: "fixedServer",
    protocol: "http",
    host: "proxy.m004-s02.invalid",
    port: 8080,
    credentials: {
      username: "m004-s02-proxy-user-sentinel",
      password: "m004-s02-proxy-password-sentinel",
    },
  };
  const updated = sidecarSuccess(
    binaryPath,
    makeRequestId("profiles-proxy-update"),
    "profiles.proxy.update",
    { storeRoot, profileId: fixedSeed.id, proxy },
    { context },
  ).result;
  const fixedProfile = assertSetupProfile(updated.profile, fixedName);

  const launch = sidecarSuccess(
    binaryPath,
    makeRequestId("chromium-launch"),
    "chromium.launch",
    { storeRoot, profileId: fixedProfile.id },
    {
      context,
      timeoutMs: CHROMIUM_LAUNCH_TIMEOUT_MS,
      env: { THEPRIVATOR_CHROMIUM_PATH: fakeChromiumPath },
    },
  ).result;
  assert(launch.profileId === fixedProfile.id, "Runtime launch profile id mismatch.", { phase: "runtime-setup", profileId: fixedProfile.id });
  assert(launch.status === "running", "Runtime launch did not report running.", { phase: "runtime-setup", profileId: fixedProfile.id });
  assert(Number.isInteger(launch.runningCount) && launch.runningCount >= 1, "Runtime launch did not report a running count.", { phase: "runtime-setup", profileId: fixedProfile.id });

  return {
    profileIds: [directProfile.id, fixedProfile.id],
    launchedProfileId: fixedProfile.id,
    proxyProfileId: fixedProfile.id,
    runningCount: launch.runningCount,
  };
}

function stopLaunchedProfile({ binaryPath, storeRoot, profileId, context }) {
  if (!profileId) {
    return { requested: false, stopped: false, runningCount: null };
  }
  const stop = sidecarSuccess(
    binaryPath,
    makeRequestId("chromium-stop"),
    "chromium.stop",
    { storeRoot, profileId },
    { context, timeoutMs: SIDECAR_TIMEOUT_MS },
  ).result;
  assert(stop.profileId === profileId, "Runtime stop profile id mismatch.", { phase: "runtime-stop", profileId });
  assert(stop.status === "stopped", "Runtime stop did not report stopped.", { phase: "runtime-stop", profileId });
  assert(Number.isInteger(stop.runningCount), "Runtime stop did not return a running count.", { phase: "runtime-stop", profileId });
  return { requested: true, stopped: true, profileIds: [profileId], runningCount: stop.runningCount };
}

function startAutomationApi({ binaryPath, storeRoot, token }) {
  const child = spawn(binaryPath, ["automation-api"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      [ENV_HOST]: AUTOMATION_HOST,
      [ENV_PORT]: "0",
      [ENV_STORE_ROOT]: storeRoot,
      [ENV_TOKEN]: token,
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    child,
    stdout: createLineCollector(child.stdout),
    stderr: createLineCollector(child.stderr),
  };
}

function waitForExit(child, timeoutMs, phase) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new VerifyFailure(`${phase} timed out waiting for child exit.`, { phase }));
    }, timeoutMs);
    child.once("exit", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, signal });
    });
  });
}

async function stopAutomationApi(processState, { timeoutMs = SHUTDOWN_TIMEOUT_MS } = {}) {
  if (!processState?.child) {
    return { requested: false, exitCode: null, signal: null, alreadyExited: true };
  }
  const { child } = processState;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { requested: false, exitCode: child.exitCode, signal: child.signalCode, alreadyExited: true };
  }
  child.kill("SIGTERM");
  try {
    const exited = await waitForExit(child, timeoutMs, "shutdown");
    return { requested: true, ...exited, alreadyExited: false };
  } catch (error) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort force-kill; the safe failure below is enough for public evidence.
    }
    if (error instanceof VerifyFailure) {
      throw new VerifyFailure("Automation API child refused to exit before the shutdown timeout.", {
        phase: "shutdown",
        cleanup: "force-kill-requested",
        timeoutMs,
      });
    }
    throw error;
  }
}

function removeRuntimeRoot(storeRoot) {
  if (!storeRoot) {
    return false;
  }
  rmSync(storeRoot, { recursive: true, force: true });
  return !existsSync(storeRoot);
}

export function parseHttpJsonBody({ text, statusCode = 0, phase = "http", context = createS02RedactionContext() } = {}) {
  let body;
  try {
    body = JSON.parse(String(text ?? ""));
  } catch {
    fail("Automation API response body was not valid JSON.", {
      phase,
      statusCode,
      bodyLength: String(text ?? "").length,
    });
  }
  assertS02PublicEvidenceRedacted(body, context);
  return body;
}

async function fetchJson(url, { headerValue, timeoutMs = HTTP_TIMEOUT_MS, phase, context = createS02RedactionContext() } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${phase} timed out.`)), timeoutMs);
  try {
    const headers = { Accept: "application/json" };
    if (headerValue !== undefined) {
      headers.Authorization = headerValue;
    }
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseHttpJsonBody({ text, statusCode: response.status, phase, context });
    return {
      statusCode: response.status,
      body,
      requestId: response.headers.get("x-request-id") ?? null,
    };
  } catch (error) {
    if (error instanceof VerifyFailure) {
      throw error;
    }
    fail("Automation API HTTP request failed.", {
      phase,
      errorName: error instanceof Error ? error.name : "Error",
      timeoutMs,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function assertProtectedAuthErrorResponse({ statusCode, body, requestId, expectedCode, context = createS02RedactionContext(), phase = "auth" } = {}) {
  const result = assertAuthErrorResponse({ statusCode, body, expectedCode, context, phase });
  assertResponseHeaderRequestId(requestId, body?.error?.requestId, phase);
  return result;
}

export function assertDomainErrorResponse({ statusCode, body, requestId, expectedCode, expectedStatusCode, expectedPhase, context = createS02RedactionContext(), phase = expectedPhase } = {}) {
  assert(statusCode === expectedStatusCode, "Automation API domain error returned the wrong HTTP status.", {
    phase,
    expectedStatusCode,
    actualStatusCode: statusCode,
  });
  assertS02PublicEvidenceRedacted(body, context);
  assert(isPlainObject(body), "Automation API domain error body was not an object.", { phase });
  assertExactKeys(body, ["error"], "Automation API domain error body");
  const error = body.error;
  assert(isPlainObject(error), "Automation API domain error payload was not an object.", { phase });
  assertExactKeys(error, ["code", "details", "detailRef", "message", "requestId"], "Automation API domain error");
  assert(error.code === expectedCode, "Automation API domain error returned the wrong code.", {
    phase,
    expectedCode,
    actualCode: error.code,
  });
  assert(typeof error.message === "string" && error.message.length > 0, "Automation API domain error message was missing.", { phase });
  assert(error.details?.phase === expectedPhase, "Automation API domain error phase was wrong.", {
    phase,
    expectedPhase,
    actualPhase: error.details?.phase,
  });
  assert(typeof error.detailRef === "string" && error.detailRef.startsWith("sidecar-"), "Automation API domain error detailRef was missing.", { phase });
  assertResponseHeaderRequestId(requestId, error.requestId, phase);
  return {
    statusCode,
    errorCode: error.code,
    detailRef: error.detailRef,
    requestId: error.requestId,
    errorPhase: error.details.phase,
  };
}

export function assertProfilesResponse({ statusCode, body, requestId, expectedProfileIds = null, context = createS02RedactionContext(), phase = "profiles" } = {}) {
  assert(statusCode === 200, "Automation API profiles request did not return HTTP 200.", {
    phase,
    expectedStatusCode: 200,
    actualStatusCode: statusCode,
  });
  assertS02PublicEvidenceRedacted(body, context);
  assert(isPlainObject(body), "Automation API profiles body was not an object.", { phase });
  assertExactKeys(body, ["count", "limit", "nextCursor", "profileApiVersion", "profiles", "request"], "Automation API profiles body");
  assert(body.profileApiVersion === PROFILE_API_VERSION, "Automation API profile version changed unexpectedly.", { phase, profileApiVersion: body.profileApiVersion });
  assert(Array.isArray(body.profiles), "Automation API profiles field was not an array.", { phase });
  assert(body.count === body.profiles.length, "Automation API profiles count did not match the array length.", { phase, count: body.count, arrayLength: body.profiles.length });
  assert(Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= MAX_PROFILE_LIST_LIMIT, "Automation API profile list limit was outside bounds.", { phase, limit: body.limit });
  assert(body.nextCursor === null || (typeof body.nextCursor === "string" && body.nextCursor.length > 0), "Automation API nextCursor was not null or an opaque string.", { phase });
  assert(isPlainObject(body.request), "Automation API profiles request metadata was missing.", { phase });
  assertExactKeys(body.request, ["requestId"], "Automation API profiles request metadata");
  assertResponseHeaderRequestId(requestId, body.request.requestId, phase);

  const summaries = body.profiles.map((profile) => assertProfileSummary(profile, phase));
  const profileIds = summaries.map((summary) => summary.profileId);
  if (expectedProfileIds) {
    for (const expectedProfileId of expectedProfileIds) {
      assert(profileIds.includes(expectedProfileId), "Automation API profiles page did not include an expected profile.", {
        phase,
        expectedProfilePresent: true,
      });
    }
  }
  return {
    statusCode,
    requestId: body.request.requestId,
    count: body.count,
    limit: body.limit,
    nextCursorPresent: Boolean(body.nextCursor),
    profileIds,
    proxyModes: summaries.map((summary) => summary.proxyMode),
  };
}

export function assertRuntimeStatusResponse({ statusCode, body, requestId, expectedRunningProfileIds = null, context = createS02RedactionContext(), phase = "runtime-status" } = {}) {
  assert(statusCode === 200, "Automation API runtime status request did not return HTTP 200.", {
    phase,
    expectedStatusCode: 200,
    actualStatusCode: statusCode,
  });
  assertS02PublicEvidenceRedacted(body, context);
  assert(isPlainObject(body), "Automation API runtime status body was not an object.", { phase });
  assertExactKeys(body, ["profiles", "reconciled", "request", "runningCount", "runtimeApiVersion"], "Automation API runtime status body");
  assert(body.runtimeApiVersion === RUNTIME_API_VERSION, "Automation API runtime version changed unexpectedly.", { phase, runtimeApiVersion: body.runtimeApiVersion });
  assert(Array.isArray(body.profiles), "Automation API runtime profiles field was not an array.", { phase });
  assert(Array.isArray(body.reconciled), "Automation API runtime reconciled field was not an array.", { phase });
  assert(body.runningCount === body.profiles.length, "Automation API runningCount did not match running profiles length.", { phase, runningCount: body.runningCount, profileCount: body.profiles.length });
  assert(isPlainObject(body.request), "Automation API runtime request metadata was missing.", { phase });
  assertExactKeys(body.request, ["requestId"], "Automation API runtime request metadata");
  assertResponseHeaderRequestId(requestId, body.request.requestId, phase);

  const running = body.profiles.map((entry, index) => assertRuntimeEntry(entry, "running", phase, `$.profiles[${index}]`));
  const reconciled = body.reconciled.map((entry, index) => assertRuntimeEntry(entry, "stopped", phase, `$.reconciled[${index}]`));
  const runningProfileIds = running.map((entry) => entry.profileId);
  if (expectedRunningProfileIds) {
    for (const expectedProfileId of expectedRunningProfileIds) {
      assert(runningProfileIds.includes(expectedProfileId), "Automation API runtime status did not include an expected running profile.", {
        phase,
        expectedProfilePresent: true,
      });
    }
  }
  return {
    statusCode,
    requestId: body.request.requestId,
    runningCount: body.runningCount,
    runningProfileIds,
    reconciledProfileIds: reconciled.map((entry) => entry.profileId),
    reconciledCount: reconciled.length,
  };
}

export function assertSelectedProfileStatusResponse({ statusCode, body, requestId, expectedProfileId, expectedRuntimeStatus = "running", context = createS02RedactionContext(), phase = "selected-profile-status" } = {}) {
  assert(statusCode === 200, "Automation API selected-profile status request did not return HTTP 200.", {
    phase,
    expectedStatusCode: 200,
    actualStatusCode: statusCode,
  });
  assertS02PublicEvidenceRedacted(body, context);
  assert(isPlainObject(body), "Automation API selected-profile status body was not an object.", { phase });
  assertExactKeys(body, ["profile", "profileApiVersion", "request", "runtime", "runtimeApiVersion"], "Automation API selected-profile status body");
  assert(body.profileApiVersion === PROFILE_API_VERSION, "Automation API selected-profile profile version changed unexpectedly.", { phase });
  assert(body.runtimeApiVersion === RUNTIME_API_VERSION, "Automation API selected-profile runtime version changed unexpectedly.", { phase });
  const profile = assertProfileSummary(body.profile, phase);
  if (expectedProfileId) {
    assert(profile.profileId === expectedProfileId, "Automation API selected-profile response returned the wrong profile.", { phase, expectedProfilePresent: true });
  }
  const runtime = assertSelectedRuntimeState(body.runtime, expectedRuntimeStatus, phase);
  assert(runtime.profileId === profile.profileId, "Automation API selected-profile runtime profile id mismatch.", { phase });
  assert(isPlainObject(body.request), "Automation API selected-profile request metadata was missing.", { phase });
  assertExactKeys(body.request, ["requestId"], "Automation API selected-profile request metadata");
  assertResponseHeaderRequestId(requestId, body.request.requestId, phase);
  return {
    statusCode,
    requestId: body.request.requestId,
    profileId: profile.profileId,
    runtimeStatus: runtime.status,
    proxyMode: profile.proxyMode,
  };
}

function assertHealthWithHeader(response, context) {
  const result = assertHealthResponse({ ...response, context });
  assertResponseHeaderRequestId(response.requestId, response.body?.request?.requestId, "health");
  return result;
}

async function verifyNewEndpointAuth({ baseUrl, token, profileId, context }) {
  const endpoints = [
    { label: "profiles", path: "/v1/profiles" },
    { label: "selected-profile-status", path: `/v1/profiles/${encodeURIComponent(profileId)}/status` },
    { label: "runtime-status", path: "/v1/runtime/status" },
  ];
  const checks = [];
  for (const endpoint of endpoints) {
    const missing = await runStepAsync(`auth-${endpoint.label}-missing`, async () => {
      const response = await fetchJson(`${baseUrl}${endpoint.path}`, { phase: `auth-${endpoint.label}-missing`, context });
      const result = assertProtectedAuthErrorResponse({ ...response, expectedCode: AUTOMATION_AUTH_REQUIRED, context, phase: `auth-${endpoint.label}-missing` });
      return { ...result, endpoint: endpoint.label };
    }, context);
    checks.push({ endpoint: endpoint.label, mode: "missing", ...missing });

    const invalid = await runStepAsync(`auth-${endpoint.label}-invalid`, async () => {
      const response = await fetchJson(`${baseUrl}${endpoint.path}`, {
        headerValue: `Bearer not-${token.slice(0, 8)}`,
        phase: `auth-${endpoint.label}-invalid`,
        context,
      });
      const result = assertProtectedAuthErrorResponse({ ...response, expectedCode: AUTOMATION_AUTH_INVALID, context, phase: `auth-${endpoint.label}-invalid` });
      return { ...result, endpoint: endpoint.label };
    }, context);
    checks.push({ endpoint: endpoint.label, mode: "invalid", ...invalid });
  }
  return checks;
}

export function buildFinalSummary({ status, target, readiness, setup = {}, httpChecks = {}, cleanup = {}, redaction = {}, error = null, checks = STEP_RESULTS } = {}) {
  const summary = {
    status,
    target: target
      ? {
          binary: target.binary,
          targetTriple: target.targetTriple,
          executableChecked: target.executableChecked,
        }
      : undefined,
    endpoint: readiness
      ? {
          host: readiness.host,
          port: readiness.port,
          scope: "loopback",
          version: readiness.version,
        }
      : undefined,
    setup: {
      profileCount: setup.profileIds?.length ?? 0,
      profileIds: setup.profileIds ?? [],
      proxyProfileId: setup.proxyProfileId ?? null,
      launchedProfileId: setup.launchedProfileId ?? null,
      runtimeLaunchProven: Boolean(setup.launchedProfileId),
    },
    http: {
      health: httpChecks.health,
      auth: httpChecks.auth,
      invalidPagination: httpChecks.invalidPagination,
      unknownProfile: httpChecks.unknownProfile,
      profiles: httpChecks.profiles,
      selectedProfileStatus: httpChecks.selectedProfileStatus,
      runtimeStatus: httpChecks.runtimeStatus,
    },
    cleanup: {
      runtimeStop: cleanup.runtimeStop ?? null,
      childExit: cleanup.childExit ?? null,
      listenerClosed: cleanup.listenerClosed ?? false,
      runtimeRootRemoved: cleanup.runtimeRootRemoved ?? false,
    },
    redaction,
    checks,
  };

  if (error) {
    summary.error = safeErrorForPublic(error);
  }

  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}

async function cleanupAfterFailure({ processState, readiness, launchedProfileId, binaryPath, storeRoot, context, cleanup }) {
  if (launchedProfileId && binaryPath && storeRoot) {
    try {
      cleanup.runtimeStop = stopLaunchedProfile({ binaryPath, storeRoot, profileId: launchedProfileId, context });
    } catch (error) {
      cleanup.runtimeStop = { requested: true, stopped: false, error: safeErrorForPublic(error) };
    }
  }
  if (processState?.child && processState.child.exitCode === null && processState.child.signalCode === null) {
    try {
      cleanup.childExit = await stopAutomationApi(processState);
    } catch (error) {
      cleanup.childExit = { cleanup: "failed", error: safeErrorForPublic(error) };
    }
  }
  if (readiness?.host && readiness?.port) {
    try {
      const listener = await waitForListenerClosed({ host: readiness.host, port: readiness.port });
      cleanup.listenerClosed = listener.closed;
    } catch {
      cleanup.listenerClosed = false;
    }
  }
  try {
    cleanup.runtimeRootRemoved = removeRuntimeRoot(storeRoot);
  } catch {
    cleanup.runtimeRootRemoved = false;
  }
}

export async function runVerification({ rootDir = ROOT_DIR, token = `m004-s02-${randomUUID()}`, storeRoot = mkdtempSync(join(tmpdir(), "theprivator-m004-s02-")) } = {}) {
  resetRunState();
  let context = createS02RedactionContext({ rootDir });
  let processState = null;
  let target = null;
  let readiness = null;
  let setup = {};
  let launchedProfileId = null;
  let fakeChromium = null;
  const httpChecks = {};
  const cleanup = { runtimeStop: null, childExit: null, listenerClosed: false, runtimeRootRemoved: false };

  try {
    target = runStep("binary-discovery", () => {
      const targetTriple = readTargetTriple(rootDir);
      return assertS02TargetBinary({ rootDir, targetTriple });
    }, context);
    const binaryPath = resolve(rootDir, target.binary);

    context = createS02RedactionContext({
      rootDir,
      token,
      storeRoot,
      extraSensitiveValues: [
        "m004-s02-proxy-user-sentinel",
        "m004-s02-proxy-password-sentinel",
      ],
    });

    runStep("runtime-root", () => ({ created: true, location: "temporary-app-data" }), context);
    fakeChromium = runStep("fake-chromium", () => {
      const created = createFakeChromiumExecutable(storeRoot);
      return { value: created, log: { created: created.created, kind: "long-lived" } };
    }, context);

    setup = runStep("profile-setup", () => {
      const result = createProfilesAndLaunchRuntime({ binaryPath, storeRoot, fakeChromiumPath: fakeChromium.path, context });
      launchedProfileId = result.launchedProfileId;
      return {
        value: result,
        log: {
          profileCount: result.profileIds.length,
          profileIds: result.profileIds,
          proxyProfileId: result.proxyProfileId,
          runtimeLaunchProven: true,
          runningCount: result.runningCount,
        },
      };
    }, context);

    processState = runStep("spawn", () => {
      const state = startAutomationApi({ binaryPath, storeRoot, token });
      return { value: state, log: { child: state.child.pid ? "started" : "pending" } };
    }, context);

    readiness = await runStepAsync("readiness", async () => {
      const ready = await waitForReadiness(processState, { timeoutMs: READINESS_TIMEOUT_MS, context });
      parseReadinessLine(JSON.stringify(ready), context);
      return ready;
    }, context);
    const baseUrl = `http://${readiness.host}:${readiness.port}`;

    httpChecks.health = await runStepAsync("health", async () => {
      const response = await fetchJson(`${baseUrl}/health`, { phase: "health", context });
      return assertHealthWithHeader(response, context);
    }, context);

    httpChecks.auth = await verifyNewEndpointAuth({ baseUrl, token, profileId: setup.launchedProfileId, context });

    httpChecks.invalidPagination = await runStepAsync("profiles-invalid-pagination", async () => {
      const response = await fetchJson(`${baseUrl}/v1/profiles?limit=0`, {
        headerValue: `Bearer ${token}`,
        phase: "profiles-invalid-pagination",
        context,
      });
      return assertDomainErrorResponse({
        ...response,
        expectedCode: INVALID_REQUEST,
        expectedStatusCode: 400,
        expectedPhase: "profile",
        context,
        phase: "profiles-invalid-pagination",
      });
    }, context);

    httpChecks.unknownProfile = await runStepAsync("selected-profile-unknown", async () => {
      const response = await fetchJson(`${baseUrl}/v1/profiles/missing-m004-s02-profile/status`, {
        headerValue: `Bearer ${token}`,
        phase: "selected-profile-unknown",
        context,
      });
      return assertDomainErrorResponse({
        ...response,
        expectedCode: PROFILE_NOT_FOUND,
        expectedStatusCode: 404,
        expectedPhase: "profile",
        context,
        phase: "selected-profile-unknown",
      });
    }, context);

    httpChecks.profiles = await runStepAsync("profiles-list", async () => {
      const response = await fetchJson(`${baseUrl}/v1/profiles?limit=10`, {
        headerValue: `Bearer ${token}`,
        phase: "profiles-list",
        context,
      });
      return assertProfilesResponse({ ...response, expectedProfileIds: setup.profileIds, context, phase: "profiles-list" });
    }, context);

    httpChecks.selectedProfileStatus = await runStepAsync("selected-profile-status", async () => {
      const response = await fetchJson(`${baseUrl}/v1/profiles/${encodeURIComponent(setup.launchedProfileId)}/status`, {
        headerValue: `Bearer ${token}`,
        phase: "selected-profile-status",
        context,
      });
      return assertSelectedProfileStatusResponse({
        ...response,
        expectedProfileId: setup.launchedProfileId,
        expectedRuntimeStatus: "running",
        context,
        phase: "selected-profile-status",
      });
    }, context);

    httpChecks.runtimeStatus = await runStepAsync("runtime-status", async () => {
      const response = await fetchJson(`${baseUrl}/v1/runtime/status`, {
        headerValue: `Bearer ${token}`,
        phase: "runtime-status",
        context,
      });
      return assertRuntimeStatusResponse({
        ...response,
        expectedRunningProfileIds: [setup.launchedProfileId],
        context,
        phase: "runtime-status",
      });
    }, context);

    cleanup.runtimeStop = runStep("runtime-stop", () => {
      const stopped = stopLaunchedProfile({ binaryPath, storeRoot, profileId: launchedProfileId, context });
      launchedProfileId = null;
      return stopped;
    }, context);

    cleanup.childExit = await runStepAsync("shutdown", async () => stopAutomationApi(processState), context);
    const listener = await runStepAsync("listener-close", async () => waitForListenerClosed({ host: readiness.host, port: readiness.port }), context);
    cleanup.listenerClosed = listener.closed;
    cleanup.runtimeRootRemoved = runStep("cleanup", () => ({ runtimeRootRemoved: removeRuntimeRoot(storeRoot) }), context).runtimeRootRemoved;

    const redactionResult = runStep("redaction-scan", () => assertS02PublicEvidenceRedacted({ events: VERIFIER_EVENTS, checks: STEP_RESULTS }, context), context);
    const summary = buildFinalSummary({
      status: "pass",
      target,
      readiness,
      setup,
      httpChecks,
      cleanup,
      redaction: redactionResult,
      checks: STEP_RESULTS,
    });
    assertS02PublicEvidenceRedacted(summary, context);
    emit({ status: "pass", summary }, context);
    return { summary, events: VERIFIER_EVENTS, checks: STEP_RESULTS };
  } catch (error) {
    const binaryPath = target ? resolve(rootDir, target.binary) : null;
    await cleanupAfterFailure({ processState, readiness, launchedProfileId, binaryPath, storeRoot, context, cleanup });
    const safeError = error instanceof VerifyFailure ? error : new VerifyFailure(error instanceof Error ? error.message : String(error));
    const summary = buildFinalSummary({
      status: "fail",
      target,
      readiness,
      setup,
      httpChecks,
      cleanup,
      redaction: { status: "attempted" },
      error: safeError,
      checks: STEP_RESULTS,
    });
    const redactedSummary = redactS02(summary, context);
    try {
      assertS02PublicEvidenceRedacted(redactedSummary, context);
    } catch (redactionError) {
      emit({ status: "fail", summary: { status: "fail", redaction: { status: "failed", error: safeErrorForPublic(redactionError) }, cleanup } }, context);
      throw safeError;
    }
    emit({ status: "fail", summary: redactedSummary }, context);
    throw safeError;
  }
}

function isDirectExecution() {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

if (isDirectExecution()) {
  runVerification().catch(() => {
    process.exitCode = 1;
  });
}
