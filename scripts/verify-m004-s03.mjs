#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium as playwrightChromium } from "playwright-core";
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
  readTargetTriple,
  redact,
  redactText,
  redactedTail,
  targetBinaryPath,
  waitForListenerClosed,
  waitForReadiness,
} from "./verify-m004-s01.mjs";
import {
  INVALID_REQUEST,
  PROFILE_NOT_FOUND,
  RUNTIME_API_VERSION,
  assertDomainErrorResponse,
  assertProtectedAuthErrorResponse,
  assertRuntimeStatusResponse,
  assertS02PublicEvidenceRedacted,
  assertS02TargetBinary,
  assertSelectedProfileStatusResponse,
  createS02RedactionContext,
  findS02ForbiddenPublicMarker,
} from "./verify-m004-s02.mjs";
import { assertHealthResponse } from "./verify-m004-s01.mjs";

export const VERIFY_EVENT = "verify.m004.s03";
export const LEASE_API_VERSION = 1;
export const AUTOMATION_LEASE_NOT_FOUND = "AUTOMATION_LEASE_NOT_FOUND";
export const AUTOMATION_LEASE_PROFILE_BUSY = "AUTOMATION_LEASE_PROFILE_BUSY";
export const AUTOMATION_LEASE_EXPIRED = "AUTOMATION_LEASE_EXPIRED";
export const AUTOMATION_LEASE_RELEASED = "AUTOMATION_LEASE_RELEASED";
export const AUTOMATION_LEASE_HANDOFF_FAILED = "AUTOMATION_LEASE_HANDOFF_FAILED";

const READINESS_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 5_000;
const SIDECAR_TIMEOUT_MS = 15_000;
const PLAYWRIGHT_TIMEOUT_MS = 15_000;
const ENDPOINT_REVOKED_TIMEOUT_MS = 3_000;
const EXPIRY_WAIT_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_CHARS = 128 * 1024;
const REDACTED_VALUE = "<redacted>";
const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];

const S03_FORBIDDEN_TEXT_PATTERNS = Object.freeze([
  { markerClass: "lease_id", pattern: /\blease_[A-Za-z0-9_-]{6,}\b/i },
  { markerClass: "handoff_field", pattern: /\b(?:connect-over-cdp|handoffOrigin|browserWSEndpoint|webSocketDebuggerUrl|wsEndpoint)\b/i },
  { markerClass: "debug_endpoint", pattern: /\b(?:DevToolsActivePort|debugPort|remote-debugging|--remote-debugging-port|cdp:\/\/)\b/i },
  { markerClass: "ws_endpoint", pattern: /wss?:\/\/[^\s"']+/i },
  { markerClass: "raw_diag", pattern: /\b(?:stdout|stderr|raw diagnostics?|rawDiagnostics?|Traceback|stack trace)\b/i },
  { markerClass: "profile_private_path", pattern: /\b(?:profile-store|profiles\.json)\b/i },
]);
const S03_FORBIDDEN_KEY_PATTERN = /^(?:leaseId|leaseEndpoint|handoff|handoffOrigin|browserWSEndpoint|webSocketDebuggerUrl|wsEndpoint|debugPort|remoteDebuggingPort|stdout|stderr|rawDiagnostics?|rawBody|rawPayload|stack|traceback)$/i;
const LEASE_SURFACE_FORBIDDEN_KEY_PATTERN = /(?:handoff|handoffOrigin|browserWSEndpoint|webSocketDebuggerUrl|wsEndpoint|debugPort|remoteDebuggingPort|storeRoot|appDataRoot|userDataDir|profileDir|credentials?|password|secret|token|authorization|stdout|stderr|rawDiagnostics?|rawBody|rawPayload|argv|args|env|stack|traceback)/i;
const LEASE_SURFACE_FORBIDDEN_TEXT_PATTERNS = Object.freeze([
  { markerClass: "handoff_field", pattern: /\b(?:connect-over-cdp|handoffOrigin|browserWSEndpoint|webSocketDebuggerUrl|wsEndpoint)\b/i },
  { markerClass: "debug_endpoint", pattern: /\b(?:DevToolsActivePort|debugPort|remote-debugging|--remote-debugging-port|cdp:\/\/)\b/i },
  { markerClass: "ws_endpoint", pattern: /wss?:\/\/[^\s"']+/i },
  { markerClass: "raw_diag", pattern: /\b(?:stdout|stderr|raw diagnostics?|rawDiagnostics?|Traceback|stack trace)\b/i },
  { markerClass: "profile_private_path", pattern: /\b(?:profile-store|profiles\.json)\b/i },
]);

function fail(message, details = {}) {
  throw new VerifyFailure(message, details);
}

function assert(condition, message, details = {}) {
  if (!condition) {
    fail(message, details);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addExactValues(context, markerClass, values) {
  const exactValues = [...(context.exactValues ?? [])];
  for (const value of values ?? []) {
    if (typeof value === "string" && value.length > 0) {
      exactValues.push({ markerClass, value, pattern: new RegExp(escapeRegExp(value), "g") });
    }
  }
  return exactValues;
}

export function createS03RedactionContext({
  rootDir = ROOT_DIR,
  token,
  storeRoot,
  leaseIds = [],
  handoffEndpoints = [],
  extraSensitiveValues = [],
} = {}) {
  let context = createS02RedactionContext({ rootDir, token, storeRoot, extraSensitiveValues });
  let exactValues = addExactValues(context, "lease_id", leaseIds);
  exactValues = addExactValues({ exactValues }, "lease_endpoint", handoffEndpoints);
  exactValues = exactValues.sort((left, right) => right.value.length - left.value.length);
  return {
    ...context,
    exactValues,
    forbiddenPatterns: [
      ...(context.forbiddenPatterns ?? []),
      ...S03_FORBIDDEN_TEXT_PATTERNS,
    ],
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRedactedPlaceholderKey(key) {
  return /^<redacted-key:[a-z0-9_]+>$/.test(key);
}

function classifyS03ForbiddenKey(key) {
  if (/lease/i.test(key)) return "lease_authority";
  if (/handoff|webSocket|wsEndpoint/i.test(key)) return "handoff_field";
  if (/debug|remoteDebugging/i.test(key)) return "debug_endpoint";
  if (/stdout|stderr|raw|stack|traceback/i.test(key)) return "raw_diag";
  return "unsafe_field";
}

function redactedS03KeyName(key) {
  return `<redacted-key:${classifyS03ForbiddenKey(key)}>`;
}

function safeFieldPath(path, keyOrIndex, keyPattern = S03_FORBIDDEN_KEY_PATTERN) {
  if (typeof keyOrIndex === "number") {
    return `${path}[${keyOrIndex}]`;
  }
  const segment = keyPattern.test(keyOrIndex) ? redactedS03KeyName(keyOrIndex) : keyOrIndex;
  return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
}

function safeKeyForDetails(key) {
  return (S03_FORBIDDEN_KEY_PATTERN.test(key) || LEASE_SURFACE_FORBIDDEN_KEY_PATTERN.test(key)) ? redactedS03KeyName(key) : key;
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

function assertResponseHeaderRequestId(headerRequestId, bodyRequestId, phase) {
  assert(typeof bodyRequestId === "string" && bodyRequestId.startsWith("automation-"), "Automation API response did not include a safe requestId.", {
    phase,
    fieldPath: "$.request.requestId",
  });
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

function assertLeaseId(value, phase, fieldPath = "lease.id") {
  assert(typeof value === "string" && value.startsWith("lease_"), "Automation lease id was missing or malformed.", {
    phase,
    fieldPath,
  });
  const suffix = value.slice("lease_".length);
  assert(suffix.length >= 6 && /^[A-Za-z0-9_-]+$/.test(suffix), "Automation lease id suffix was malformed.", {
    phase,
    fieldPath,
  });
}

export function assertPlaywrightHandoffShape(handoff, { phase = "lease-create" } = {}) {
  assert(isPlainObject(handoff), "Automation lease handoff was not an object.", { phase });
  assertExactKeys(handoff, ["browser", "endpoint", "method"], "Automation lease handoff");
  assert(handoff.browser === "chromium", "Automation lease handoff did not target Chromium.", { phase });
  assert(handoff.method === "connect-over-cdp", "Automation lease handoff method was not Playwright CDP.", { phase });
  const endpoint = handoff.endpoint;
  assert(typeof endpoint === "string", "Automation lease handoff endpoint was missing.", { phase });
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(endpoint);
  assert(match, "Automation lease handoff endpoint was not a safe loopback HTTP origin.", { phase });
  const port = Number.parseInt(match[1], 10);
  assert(port >= 1 && port <= 65535, "Automation lease handoff endpoint port was outside TCP bounds.", { phase });
  return {
    browser: handoff.browser,
    method: handoff.method,
    port,
    endpoint,
  };
}

function assertLeaseRuntimePayload(runtime, expectedProfileId, expectedStatus, phase) {
  assert(isPlainObject(runtime), "Automation lease runtime payload was not an object.", { phase });
  assert(runtime.runtimeApiVersion === RUNTIME_API_VERSION, "Automation lease runtime API version changed unexpectedly.", { phase });
  assert(Number.isInteger(runtime.runningCount) && runtime.runningCount >= 0, "Automation lease runtime runningCount was invalid.", { phase });
  assert(isPlainObject(runtime.profile), "Automation lease runtime profile payload was missing.", { phase });
  assert(runtime.profile.profileId === expectedProfileId, "Automation lease runtime profile id mismatch.", { phase, expectedProfilePresent: true });
  assert(runtime.profile.status === expectedStatus, "Automation lease runtime status mismatch.", { phase, expectedStatus, actualStatus: runtime.profile.status });
  if (expectedStatus === "running") {
    assertExactKeys(runtime, ["profile", "runningCount", "runtimeApiVersion"], "Automation lease running runtime");
    assertExactKeys(runtime.profile, ["profileId", "startedAt", "status"], "Automation lease running profile runtime");
    assertIsoTimestamp(runtime.profile.startedAt, phase, "$.runtime.profile.startedAt");
  } else {
    assertExactKeys(runtime, ["profile", "runningCount", "runtimeApiVersion"], "Automation lease stopped runtime");
    assertExactKeys(runtime.profile, ["profileId", "status", "stoppedAt", "termination"], "Automation lease stopped profile runtime");
    assertIsoTimestamp(runtime.profile.stoppedAt, phase, "$.runtime.profile.stoppedAt");
    assert(typeof runtime.profile.termination === "string" && runtime.profile.termination.length > 0, "Automation lease stopped runtime termination was missing.", { phase });
  }
  return {
    status: runtime.profile.status,
    runningCount: runtime.runningCount,
  };
}

function expectedLeaseKeysForStatus(status) {
  if (status === "active") {
    return ["createdAt", "expiresAt", "framework", "id", "profileId", "status", "ttlSeconds"];
  }
  if (status === "released") {
    return ["cleanedUpAt", "createdAt", "expiresAt", "framework", "id", "profileId", "releasedAt", "status", "ttlSeconds"];
  }
  if (status === "expired") {
    return ["cleanedUpAt", "createdAt", "expiredAt", "expiresAt", "framework", "id", "profileId", "status", "ttlSeconds"];
  }
  return [];
}

function assertLeaseRecord(lease, { expectedProfileId, expectedStatus, expectedTtlSeconds, phase }) {
  assert(isPlainObject(lease), "Automation lease payload was not an object.", { phase });
  assertExactKeys(lease, expectedLeaseKeysForStatus(expectedStatus), `Automation ${expectedStatus} lease`);
  assertLeaseId(lease.id, phase, "$.lease.id");
  assert(lease.profileId === expectedProfileId, "Automation lease profile id mismatch.", { phase, expectedProfilePresent: true });
  assert(lease.framework === "playwright", "Automation lease framework was not playwright.", { phase });
  assert(lease.status === expectedStatus, "Automation lease status mismatch.", { phase, expectedStatus, actualStatus: lease.status });
  assert(Number.isInteger(lease.ttlSeconds) && lease.ttlSeconds >= 1 && lease.ttlSeconds <= 120, "Automation lease TTL was outside allowed bounds.", { phase });
  if (expectedTtlSeconds !== undefined) {
    assert(lease.ttlSeconds === expectedTtlSeconds, "Automation lease TTL did not match the request.", { phase, expectedTtlSeconds, actualTtlSeconds: lease.ttlSeconds });
  }
  assertIsoTimestamp(lease.createdAt, phase, "$.lease.createdAt");
  assertIsoTimestamp(lease.expiresAt, phase, "$.lease.expiresAt");
  if (expectedStatus === "released") {
    assertIsoTimestamp(lease.releasedAt, phase, "$.lease.releasedAt");
    assertIsoTimestamp(lease.cleanedUpAt, phase, "$.lease.cleanedUpAt");
  }
  if (expectedStatus === "expired") {
    assertIsoTimestamp(lease.expiredAt, phase, "$.lease.expiredAt");
    assertIsoTimestamp(lease.cleanedUpAt, phase, "$.lease.cleanedUpAt");
  }
  return {
    id: lease.id,
    profileId: lease.profileId,
    status: lease.status,
    ttlSeconds: lease.ttlSeconds,
  };
}

export function findForbiddenLeaseSurfaceMarker(value, context = createS03RedactionContext(), path = "$", state = { count: 0 }) {
  if (state.count++ > 4_000) {
    return { markerClass: "scan_limit", fieldPath: path, reason: "Lease surface scan node limit exceeded." };
  }

  if (typeof value === "string") {
    for (const marker of context.exactValues ?? []) {
      if (marker.markerClass !== "lease_id" && marker.value && value.includes(marker.value)) {
        return { markerClass: marker.markerClass, fieldPath: path, reason: "sensitive exact value" };
      }
    }
    for (const { markerClass, pattern } of LEASE_SURFACE_FORBIDDEN_TEXT_PATTERNS) {
      if (pattern.test(value)) {
        return { markerClass, fieldPath: path, reason: "forbidden lease surface text marker" };
      }
    }
    return null;
  }

  if (value === null || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findForbiddenLeaseSurfaceMarker(item, context, safeFieldPath(path, index, LEASE_SURFACE_FORBIDDEN_KEY_PATTERN), state);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (LEASE_SURFACE_FORBIDDEN_KEY_PATTERN.test(key)) {
      return { markerClass: classifyS03ForbiddenKey(key), fieldPath: safeFieldPath(path, key, LEASE_SURFACE_FORBIDDEN_KEY_PATTERN), reason: "forbidden lease surface key" };
    }
    const nestedMarker = findForbiddenLeaseSurfaceMarker(nested, context, safeFieldPath(path, key, LEASE_SURFACE_FORBIDDEN_KEY_PATTERN), state);
    if (nestedMarker) return nestedMarker;
  }
  return null;
}

export function assertNoForbiddenLeaseSurface(value, context = createS03RedactionContext()) {
  const marker = findForbiddenLeaseSurfaceMarker(value, context);
  assert(!marker, "Automation lease status surface contained forbidden handoff or diagnostic material.", marker ?? {});
  return { status: "clean", scanned: true };
}

export function assertLeaseCreateResponse({ statusCode, body, requestId, location, expectedProfileId, expectedTtlSeconds, phase = "lease-create" } = {}) {
  assert(statusCode === 201, "Automation lease create did not return HTTP 201.", {
    phase,
    expectedStatusCode: 201,
    actualStatusCode: statusCode,
  });
  assert(isPlainObject(body), "Automation lease create body was not an object.", { phase });
  assertExactKeys(body, ["handoff", "lease", "leaseApiVersion", "request", "runtime"], "Automation lease create body");
  assert(body.leaseApiVersion === LEASE_API_VERSION, "Automation lease API version changed unexpectedly.", { phase });
  const lease = assertLeaseRecord(body.lease, { expectedProfileId, expectedStatus: "active", expectedTtlSeconds, phase });
  const handoff = assertPlaywrightHandoffShape(body.handoff, { phase });
  const runtime = assertLeaseRuntimePayload(body.runtime, expectedProfileId, "running", phase);
  assert(isPlainObject(body.request), "Automation lease create request metadata was missing.", { phase });
  assertExactKeys(body.request, ["requestId"], "Automation lease create request metadata");
  assertResponseHeaderRequestId(requestId, body.request.requestId, phase);
  assert(location === `/v1/leases/${lease.id}`, "Automation lease create Location header did not point to the lease status resource.", { phase, locationPresent: typeof location === "string" });
  return {
    private: {
      leaseId: lease.id,
      handoffEndpoint: handoff.endpoint,
    },
    public: {
      statusCode,
      leaseStatus: lease.status,
      framework: "playwright",
      ttlSeconds: lease.ttlSeconds,
      runtimeStatus: runtime.status,
      runningCount: runtime.runningCount,
      attach: {
        browser: handoff.browser,
        method: "private-cdp-authority",
        origin: "loopback-http",
      },
      requestId: body.request.requestId,
      locationHeader: "present",
    },
  };
}

export function assertLeaseStatusResponse({ statusCode, body, requestId, expectedProfileId, expectedStatus, expectedTtlSeconds, context = createS03RedactionContext(), phase = `lease-${expectedStatus}` } = {}) {
  assert(statusCode === 200, "Automation lease status request did not return HTTP 200.", {
    phase,
    expectedStatusCode: 200,
    actualStatusCode: statusCode,
  });
  assert(isPlainObject(body), "Automation lease status body was not an object.", { phase });
  const expectedKeys = expectedStatus === "active" ? ["lease", "leaseApiVersion", "request"] : ["lease", "leaseApiVersion", "request", "runtime"];
  assertExactKeys(body, expectedKeys, "Automation lease status body");
  assert(body.leaseApiVersion === LEASE_API_VERSION, "Automation lease API version changed unexpectedly.", { phase });
  const lease = assertLeaseRecord(body.lease, { expectedProfileId, expectedStatus, expectedTtlSeconds, phase });
  let runtime = null;
  if (expectedStatus !== "active") {
    runtime = assertLeaseRuntimePayload(body.runtime, expectedProfileId, "stopped", phase);
  }
  assert(isPlainObject(body.request), "Automation lease status request metadata was missing.", { phase });
  assertExactKeys(body.request, ["requestId"], "Automation lease status request metadata");
  assertResponseHeaderRequestId(requestId, body.request.requestId, phase);
  assertNoForbiddenLeaseSurface(body, context);
  return {
    statusCode,
    leaseStatus: lease.status,
    ttlSeconds: lease.ttlSeconds,
    runtimeStatus: runtime?.status ?? null,
    runningCount: runtime?.runningCount ?? null,
    requestId: body.request.requestId,
  };
}

export function assertLeaseReleaseResponse({ statusCode, body, requestId, expectedProfileId, expectedTtlSeconds, context = createS03RedactionContext(), phase = "lease-release" } = {}) {
  return assertLeaseStatusResponse({
    statusCode,
    body,
    requestId,
    expectedProfileId,
    expectedStatus: "released",
    expectedTtlSeconds,
    context,
    phase,
  });
}

export function findS03ForbiddenPublicMarker(value, context = createS03RedactionContext(), path = "$", state = { count: 0 }) {
  const s02Marker = findS02ForbiddenPublicMarker(value, context, path, { count: 0 });
  if (s02Marker) {
    return s02Marker;
  }

  if (state.count++ > 4_000) {
    return {
      markerClass: "scan_limit",
      fieldPath: path,
      reason: "Public verifier evidence exceeded the bounded S03 redaction scan node limit.",
    };
  }

  if (typeof value === "string") {
    for (const { markerClass, pattern } of S03_FORBIDDEN_TEXT_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) {
        return { markerClass, fieldPath: path, reason: "forbidden S03 text marker" };
      }
    }
    return null;
  }

  if (value === null || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findS03ForbiddenPublicMarker(item, context, safeFieldPath(path, index), state);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (!isRedactedPlaceholderKey(key) && S03_FORBIDDEN_KEY_PATTERN.test(key)) {
      return { markerClass: classifyS03ForbiddenKey(key), fieldPath: safeFieldPath(path, key), reason: "forbidden S03 key" };
    }
    const nestedMarker = findS03ForbiddenPublicMarker(nested, context, safeFieldPath(path, key), state);
    if (nestedMarker) return nestedMarker;
  }
  return null;
}

export function assertS03PublicEvidenceRedacted(value, context = createS03RedactionContext()) {
  const marker = findS03ForbiddenPublicMarker(value, context);
  assert(!marker, "S03 public verifier evidence contained a forbidden marker.", marker ?? {});
  return { status: "clean", scanned: true };
}

function redactS03Text(value, context) {
  let redacted = redactText(value, context);
  for (const { markerClass, pattern } of S03_FORBIDDEN_TEXT_PATTERNS) {
    const flags = pattern.ignoreCase ? "gi" : "g";
    redacted = redacted.replace(new RegExp(pattern.source, flags), `<redacted:${markerClass}>`);
  }
  return redacted;
}

function redactS03Specific(value, context) {
  if (typeof value === "string") {
    return redactS03Text(value, context);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactS03Specific(item, context));
  }
  const safe = {};
  for (const [key, nested] of Object.entries(value)) {
    const safeKey = S03_FORBIDDEN_KEY_PATTERN.test(key) ? redactedS03KeyName(key) : redactS03Text(key, context);
    safe[safeKey] = S03_FORBIDDEN_KEY_PATTERN.test(key) ? REDACTED_VALUE : redactS03Specific(nested, context);
  }
  return safe;
}

export function redactS03(value, context = createS03RedactionContext()) {
  return redactS03Specific(redact(value, context), context);
}

export function safeErrorForPublic(error) {
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

function emit(event, context = createS03RedactionContext()) {
  const safeEvent = redactS03({ event: VERIFY_EVENT, ...event }, context);
  VERIFIER_EVENTS.push(safeEvent);
  console.log(JSON.stringify(safeEvent));
  return safeEvent;
}

function recordStep(name, status, started, fields = {}, context = createS03RedactionContext()) {
  const durationMs = Math.round(performance.now() - started);
  const record = redactS03({ name, status, durationMs, ...fields }, context);
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

function runStep(name, action, context = createS03RedactionContext()) {
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

async function runStepAsync(name, action, context = createS03RedactionContext()) {
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

function parseNdjsonLines(streamName, value, expectedCount = null, context = createS03RedactionContext()) {
  const lines = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (expectedCount !== null && lines.length !== expectedCount) {
    fail(`${streamName} emitted an unexpected number of NDJSON lines.`, {
      phase: "profile-setup",
      streamName,
      lineCount: lines.length,
      expectedCount,
      tail: redactedTail(value, context),
    });
  }
  if (expectedCount === null && lines.length < 1) {
    fail(`${streamName} emitted no NDJSON lines.`, { phase: "profile-setup", streamName });
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      fail(`${streamName} line was not valid JSON.`, {
        phase: "profile-setup",
        streamName,
        lineNumber: index + 1,
        lineLength: line.length,
      });
    }
  });
}

export function sidecarRequest(id, method, params = {}) {
  return { id, method, params };
}

export function runSidecarRequest(binaryPath, request, { timeoutMs = SIDECAR_TIMEOUT_MS, env = {}, context = createS03RedactionContext() } = {}) {
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
      phase: "profile-setup",
      action: request.method,
      errorCode: result.error.code ?? "SIDECAR_REQUEST_FAILED",
      timeoutMs,
      outputTail: redactedTail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, context),
    });
  }
  if (result.status !== 0) {
    fail("Built sidecar request exited with a non-zero status.", {
      phase: "profile-setup",
      action: request.method,
      exitCode: result.status,
      outputTail: redactedTail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, context),
    });
  }

  const [response] = parseNdjsonLines("sidecar output", result.stdout, 1, context);
  const diagnostics = parseNdjsonLines("sidecar diagnostics", result.stderr, null, context);
  const diagnostic = diagnostics[0];
  assert(diagnostic?.event === "sidecar.request", "Sidecar diagnostic event name changed.", {
    phase: "profile-setup",
    action: request.method,
  });
  assert(diagnostic.method === request.method, "Sidecar diagnostic method did not match the request.", {
    phase: "profile-setup",
    action: request.method,
  });
  assert(diagnostic.requestId === request.id, "Sidecar diagnostic requestId did not match the request.", {
    phase: "profile-setup",
    action: request.method,
  });
  assert(!("params" in diagnostic), "Sidecar diagnostic leaked request params.", {
    phase: "profile-setup",
    action: request.method,
  });
  return { response, diagnostic, diagnostics };
}

export function sidecarSuccess(binaryPath, id, method, params = {}, options = {}) {
  const transcript = runSidecarRequest(binaryPath, sidecarRequest(id, method, params), options);
  const { response, diagnostic } = transcript;
  assert(response.id === id, "Sidecar success response id mismatch.", { phase: "profile-setup", action: method, requestId: id });
  assert(response.ok === true, `Expected ${method} to succeed.`, {
    phase: "profile-setup",
    action: method,
    errorCode: response.error?.code,
    detailRef: response.error?.detailRef,
  });
  assert(diagnostic.status === "ok", "Sidecar diagnostic did not report ok status.", { phase: "profile-setup", action: method });
  assert(diagnostic.errorCode === null, "Successful sidecar diagnostic should not include errorCode.", { phase: "profile-setup", action: method });
  assert(diagnostic.detailRef === null, "Successful sidecar diagnostic should not include detailRef.", { phase: "profile-setup", action: method });
  assert(isPlainObject(response.result), "Sidecar success response result was not an object.", { phase: "profile-setup", action: method });
  return { ...transcript, result: response.result };
}

function makeRequestId(label) {
  return `verify-m004-s03-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "request"}`;
}

function createVerifierProfile({ binaryPath, storeRoot, context }) {
  const profileName = `M004 S03 Lease Verifier ${randomUUID().slice(0, 8)}`;
  const result = sidecarSuccess(
    binaryPath,
    makeRequestId("profiles-create-lease-target"),
    "profiles.create",
    { storeRoot, name: profileName },
    { context },
  ).result;
  assert(isPlainObject(result.profile), "Profile setup response did not include a profile object.", { phase: "profile-setup" });
  assertProfileId(result.profile.id, "profile-setup", "$.profile.id");
  assert(result.profile.name === profileName, "Profile setup response name did not match.", { phase: "profile-setup", expectedProfilePresent: true });
  return {
    profileId: result.profile.id,
    profileName: "verifier-created-profile",
  };
}

export function startAutomationApi({ binaryPath, storeRoot, token }) {
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

export async function stopAutomationApi(processState, { timeoutMs = SHUTDOWN_TIMEOUT_MS } = {}) {
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

export function removeRuntimeRoot(storeRoot) {
  if (!storeRoot) {
    return false;
  }
  rmSync(storeRoot, { recursive: true, force: true });
  return !existsSync(storeRoot);
}

export async function requestJson(url, { method = "GET", token, body, timeoutMs = HTTP_TIMEOUT_MS, phase = "http" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${phase} timed out.`)), timeoutMs);
  try {
    const headers = { Accept: "application/json" };
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }
    const init = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail("Automation API response body was not valid JSON.", {
        phase,
        statusCode: response.status,
        bodyLength: text.length,
      });
    }
    return {
      statusCode: response.status,
      body: parsed,
      requestId: response.headers.get("x-request-id") ?? null,
      location: response.headers.get("location") ?? null,
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

export function assertHealthWithHeader(response, context) {
  assertS02PublicEvidenceRedacted(response.body, context);
  const result = assertHealthResponse({ ...response, context });
  assertResponseHeaderRequestId(response.requestId, response.body?.request?.requestId, "health");
  return result;
}

export async function verifyAuthFailures({ baseUrl, context }) {
  const missing = await requestJson(`${baseUrl}/v1/status`, { phase: "auth-missing" });
  const missingResult = assertProtectedAuthErrorResponse({
    ...missing,
    expectedCode: AUTOMATION_AUTH_REQUIRED,
    context,
    phase: "auth-missing",
  });
  const invalid = await requestJson(`${baseUrl}/v1/status`, { token: "not-the-local-token", phase: "auth-invalid" });
  const invalidResult = assertProtectedAuthErrorResponse({
    ...invalid,
    expectedCode: AUTOMATION_AUTH_INVALID,
    context,
    phase: "auth-invalid",
  });
  return [
    { mode: "missing", statusCode: missingResult.statusCode, errorCode: missingResult.errorCode },
    { mode: "invalid", statusCode: invalidResult.statusCode, errorCode: invalidResult.errorCode },
  ];
}

export async function createLease({ baseUrl, token, profileId, ttlSeconds, context }) {
  const response = await requestJson(`${baseUrl}/v1/profiles/${encodeURIComponent(profileId)}/leases`, {
    method: "POST",
    token,
    body: { framework: "playwright", ttlSeconds },
    phase: "lease-create",
  });
  const result = assertLeaseCreateResponse({
    ...response,
    expectedProfileId: profileId,
    expectedTtlSeconds: ttlSeconds,
    phase: "lease-create",
  });
  assertNoForbiddenLeaseSurface({ lease: result.public, request: { requestId: result.public.requestId } }, context);
  return result;
}

export async function attachAndExercisePlaywright(endpoint) {
  let browser = null;
  let page = null;
  try {
    browser = await playwrightChromium.connectOverCDP(endpoint, { timeout: PLAYWRIGHT_TIMEOUT_MS });
    const contexts = browser.contexts();
    const browserContext = contexts[0] ?? await browser.newContext();
    page = await browserContext.newPage();
    await page.goto("data:text/html,%3C!doctype%20html%3E%3Ctitle%3EM004%20S03%20Lease%20Verifier%3C%2Ftitle%3E%3Cmain%20id%3Dproof%3Elease%20action%20ok%3C%2Fmain%3E", {
      waitUntil: "load",
      timeout: 5_000,
    });
    const title = await page.title();
    const text = await page.locator("#proof").textContent({ timeout: 5_000 });
    assert(title === "M004 S03 Lease Verifier", "Playwright CDP action did not observe the expected page title.", { phase: "playwright-action" });
    assert(text === "lease action ok", "Playwright CDP action did not observe the expected page text.", { phase: "playwright-action" });
    return {
      attached: true,
      action: "data-url-title-and-text",
      titleMatched: true,
      textMatched: true,
    };
  } catch (error) {
    if (error instanceof VerifyFailure) {
      throw error;
    }
    fail("Playwright CDP attach/action failed.", {
      phase: "playwright-action",
      errorName: error instanceof Error ? error.name : "Error",
      action: "Ensure Chromium or Chrome is installed and launchable by ThePrivator.",
    });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (browser) {
      await browser.close({ reason: "m004-s03-verifier-complete" }).catch(() => {});
    }
  }
}

export async function assertEndpointRevoked(endpoint) {
  let browser = null;
  try {
    browser = await playwrightChromium.connectOverCDP(endpoint, { timeout: ENDPOINT_REVOKED_TIMEOUT_MS });
    fail("Expired automation lease endpoint remained usable.", {
      phase: "expiry-endpoint-revocation",
      connected: true,
    });
  } catch (error) {
    if (error instanceof VerifyFailure) {
      throw error;
    }
    return {
      revoked: true,
      probe: "playwright-attach-probe",
    };
  } finally {
    if (browser) {
      await browser.close({ reason: "m004-s03-revocation-probe" }).catch(() => {});
    }
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function waitForLeaseStatus({ baseUrl, token, profileId, leaseId, expectedStatus, expectedTtlSeconds, context, timeoutMs = EXPIRY_WAIT_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastStatus = null;
  while (Date.now() < deadline) {
    attempts += 1;
    const response = await requestJson(`${baseUrl}/v1/leases/${encodeURIComponent(leaseId)}`, {
      token,
      phase: `lease-${expectedStatus}`,
    });
    if (response.statusCode === 200 && response.body?.lease?.status === expectedStatus) {
      const status = assertLeaseStatusResponse({
        ...response,
        expectedProfileId: profileId,
        expectedStatus,
        expectedTtlSeconds,
        context,
        phase: `lease-${expectedStatus}`,
      });
      return { ...status, attempts };
    }
    lastStatus = response.body?.lease?.status ?? `http-${response.statusCode}`;
    await delay(250);
  }
  fail("Automation lease did not reach the expected status before timeout.", {
    phase: `lease-${expectedStatus}`,
    expectedStatus,
    lastStatus,
    attempts,
    timeoutMs,
  });
}

function connectOnce(host, port, timeoutMs = 400) {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host, port });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function assertListenerOpen({ host, port }) {
  const open = await connectOnce(host, port);
  assert(open, "Automation API listener was not reachable after readiness.", { phase: "listener-open", port });
  return { open: true };
}

export function buildFinalSummary({ status, target, readiness, setup = {}, httpChecks = {}, leaseFlow = {}, cleanup = {}, redaction = {}, error = null, checks = STEP_RESULTS } = {}) {
  const summary = {
    status,
    target: target
      ? {
          binary: target.binary,
          targetTriple: target.targetTriple,
          executableChecked: target.executableChecked,
        }
      : undefined,
    api: readiness
      ? {
          host: readiness.host,
          port: readiness.port,
          scope: "loopback",
          version: readiness.version,
        }
      : undefined,
    setup: {
      profileCreated: Boolean(setup.profileId),
      profileCount: setup.profileId ? 1 : 0,
    },
    http: {
      health: httpChecks.health,
      auth: httpChecks.auth,
      invalidTtl: httpChecks.invalidTtl,
      unknownProfile: httpChecks.unknownProfile,
      unknownLease: httpChecks.unknownLease,
      runtimeAfterRelease: httpChecks.runtimeAfterRelease,
      selectedAfterRelease: httpChecks.selectedAfterRelease,
    },
    leaseFlow: {
      create: leaseFlow.create,
      playwright: leaseFlow.playwright,
      release: leaseFlow.release,
      expiry: leaseFlow.expiry,
      endpointRevocation: leaseFlow.endpointRevocation,
    },
    cleanup: {
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

async function cleanupAfterFailure({ processState, readiness, baseUrl, token, activeLeaseIds, storeRoot, cleanup }) {
  if (baseUrl && token && activeLeaseIds?.size) {
    for (const leaseId of [...activeLeaseIds]) {
      try {
        await requestJson(`${baseUrl}/v1/leases/${encodeURIComponent(leaseId)}`, {
          method: "DELETE",
          token,
          phase: "cleanup-release",
          timeoutMs: HTTP_TIMEOUT_MS,
        });
        activeLeaseIds.delete(leaseId);
      } catch {
        // Best-effort only; the public cleanup summary remains safe.
      }
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

export async function runVerification({ rootDir = ROOT_DIR, token = `m004-s03-${randomUUID()}`, storeRoot = mkdtempSync(join(tmpdir(), "theprivator-m004-s03-")) } = {}) {
  resetRunState();
  const leaseIds = [];
  const handoffEndpoints = [];
  let context = createS03RedactionContext({ rootDir });
  let processState = null;
  let target = null;
  let readiness = null;
  let baseUrl = null;
  let setup = {};
  const activeLeaseIds = new Set();
  const httpChecks = {};
  const leaseFlow = {};
  const cleanup = { childExit: null, listenerClosed: false, runtimeRootRemoved: false };
  const rebuildContext = () => {
    context = createS03RedactionContext({ rootDir, token, storeRoot, leaseIds, handoffEndpoints });
  };

  try {
    target = runStep("binary-discovery", () => {
      const targetTriple = readTargetTriple(rootDir);
      return assertS02TargetBinary({ rootDir, targetTriple, binaryPath: targetBinaryPath({ rootDir, targetTriple }) });
    }, context);
    const binaryPath = resolve(rootDir, target.binary);

    rebuildContext();
    runStep("runtime-root", () => ({ created: true, location: "temporary-app-data" }), context);

    setup = runStep("profile-setup", () => {
      const profile = createVerifierProfile({ binaryPath, storeRoot, context });
      return { value: profile, log: { profileCreated: true, profileCount: 1 } };
    }, context);

    processState = runStep("spawn", () => {
      const state = startAutomationApi({ binaryPath, storeRoot, token });
      return { value: state, log: { child: state.child.pid ? "started" : "pending" } };
    }, context);

    readiness = await runStepAsync("readiness", async () => waitForReadiness(processState, { timeoutMs: READINESS_TIMEOUT_MS, context }), context);
    baseUrl = `http://${readiness.host}:${readiness.port}`;

    await runStepAsync("listener-open", async () => assertListenerOpen({ host: readiness.host, port: readiness.port }), context);

    httpChecks.health = await runStepAsync("health", async () => {
      const response = await requestJson(`${baseUrl}/health`, { phase: "health" });
      return assertHealthWithHeader(response, context);
    }, context);

    httpChecks.auth = await runStepAsync("auth", async () => {
      const checks = await verifyAuthFailures({ baseUrl, context });
      return { value: checks, log: { checks } };
    }, context);

    httpChecks.invalidTtl = await runStepAsync("lease-invalid-ttl", async () => {
      const response = await requestJson(`${baseUrl}/v1/profiles/${encodeURIComponent(setup.profileId)}/leases`, {
        method: "POST",
        token,
        body: { framework: "playwright", ttlSeconds: 0 },
        phase: "lease-invalid-ttl",
      });
      return assertDomainErrorResponse({
        ...response,
        expectedCode: INVALID_REQUEST,
        expectedStatusCode: 400,
        expectedPhase: "lease",
        context,
        phase: "lease-invalid-ttl",
      });
    }, context);

    httpChecks.unknownProfile = await runStepAsync("lease-unknown-profile", async () => {
      const response = await requestJson(`${baseUrl}/v1/profiles/missing-m004-s03-profile/leases`, {
        method: "POST",
        token,
        body: { framework: "playwright", ttlSeconds: 1 },
        phase: "lease-unknown-profile",
      });
      return assertDomainErrorResponse({
        ...response,
        expectedCode: PROFILE_NOT_FOUND,
        expectedStatusCode: 404,
        expectedPhase: "lease",
        context,
        phase: "lease-unknown-profile",
      });
    }, context);

    httpChecks.unknownLease = await runStepAsync("lease-unknown", async () => {
      const response = await requestJson(`${baseUrl}/v1/leases/lease_missing_m004_s03`, {
        token,
        phase: "lease-unknown",
      });
      return assertDomainErrorResponse({
        ...response,
        expectedCode: AUTOMATION_LEASE_NOT_FOUND,
        expectedStatusCode: 404,
        expectedPhase: "lease",
        context,
        phase: "lease-unknown",
      });
    }, context);

    const firstLease = await runStepAsync("lease-create", async () => {
      const result = await createLease({ baseUrl, token, profileId: setup.profileId, ttlSeconds: 30, context });
      return { value: result.private, log: result.public };
    }, context);
    leaseIds.push(firstLease.leaseId);
    handoffEndpoints.push(firstLease.handoffEndpoint);
    activeLeaseIds.add(firstLease.leaseId);
    rebuildContext();
    leaseFlow.create = { leaseStatus: "active", ttlSeconds: 30, runtimeStatus: "running", attachAuthority: "private-on-create-only" };

    await runStepAsync("lease-status-active", async () => {
      const response = await requestJson(`${baseUrl}/v1/leases/${encodeURIComponent(firstLease.leaseId)}`, {
        token,
        phase: "lease-status-active",
      });
      return assertLeaseStatusResponse({
        ...response,
        expectedProfileId: setup.profileId,
        expectedStatus: "active",
        expectedTtlSeconds: 30,
        context,
        phase: "lease-status-active",
      });
    }, context);

    leaseFlow.playwright = await runStepAsync("playwright-attach-action", async () => attachAndExercisePlaywright(firstLease.handoffEndpoint), context);

    leaseFlow.release = await runStepAsync("lease-release", async () => {
      const response = await requestJson(`${baseUrl}/v1/leases/${encodeURIComponent(firstLease.leaseId)}`, {
        method: "DELETE",
        token,
        phase: "lease-release",
      });
      const released = assertLeaseReleaseResponse({
        ...response,
        expectedProfileId: setup.profileId,
        expectedTtlSeconds: 30,
        context,
        phase: "lease-release",
      });
      activeLeaseIds.delete(firstLease.leaseId);
      return released;
    }, context);

    httpChecks.runtimeAfterRelease = await runStepAsync("runtime-status-released", async () => {
      const response = await requestJson(`${baseUrl}/v1/runtime/status`, {
        token,
        phase: "runtime-status-released",
      });
      return assertRuntimeStatusResponse({
        ...response,
        expectedRunningProfileIds: [],
        context,
        phase: "runtime-status-released",
      });
    }, context);

    httpChecks.selectedAfterRelease = await runStepAsync("selected-profile-status-released", async () => {
      const response = await requestJson(`${baseUrl}/v1/profiles/${encodeURIComponent(setup.profileId)}/status`, {
        token,
        phase: "selected-profile-status-released",
      });
      return assertSelectedProfileStatusResponse({
        ...response,
        expectedProfileId: setup.profileId,
        expectedRuntimeStatus: "stopped",
        context,
        phase: "selected-profile-status-released",
      });
    }, context);

    const expiringLease = await runStepAsync("lease-create-short", async () => {
      const result = await createLease({ baseUrl, token, profileId: setup.profileId, ttlSeconds: 1, context });
      return { value: result.private, log: { ...result.public, ttlSeconds: 1 } };
    }, context);
    leaseIds.push(expiringLease.leaseId);
    handoffEndpoints.push(expiringLease.handoffEndpoint);
    activeLeaseIds.add(expiringLease.leaseId);
    rebuildContext();

    leaseFlow.expiry = await runStepAsync("lease-expiry", async () => {
      const expired = await waitForLeaseStatus({
        baseUrl,
        token,
        profileId: setup.profileId,
        leaseId: expiringLease.leaseId,
        expectedStatus: "expired",
        expectedTtlSeconds: 1,
        context,
      });
      activeLeaseIds.delete(expiringLease.leaseId);
      return expired;
    }, context);

    leaseFlow.endpointRevocation = await runStepAsync("endpoint-revocation", async () => assertEndpointRevoked(expiringLease.handoffEndpoint), context);

    cleanup.childExit = await runStepAsync("shutdown", async () => stopAutomationApi(processState), context);
    const listener = await runStepAsync("listener-close", async () => waitForListenerClosed({ host: readiness.host, port: readiness.port }), context);
    cleanup.listenerClosed = listener.closed;
    cleanup.runtimeRootRemoved = runStep("cleanup", () => ({ runtimeRootRemoved: removeRuntimeRoot(storeRoot) }), context).runtimeRootRemoved;

    const redactionResult = runStep("redaction-scan", () => assertS03PublicEvidenceRedacted({ events: VERIFIER_EVENTS, checks: STEP_RESULTS }, context), context);
    const summary = buildFinalSummary({
      status: "pass",
      target,
      readiness,
      setup,
      httpChecks,
      leaseFlow,
      cleanup,
      redaction: redactionResult,
      checks: STEP_RESULTS,
    });
    assertS03PublicEvidenceRedacted(summary, context);
    emit({ status: "pass", summary }, context);
    return { summary, events: VERIFIER_EVENTS, checks: STEP_RESULTS };
  } catch (error) {
    await cleanupAfterFailure({ processState, readiness, baseUrl, token, activeLeaseIds, storeRoot, cleanup });
    const safeError = error instanceof VerifyFailure ? error : new VerifyFailure(error instanceof Error ? error.message : String(error));
    const summary = buildFinalSummary({
      status: "fail",
      target,
      readiness,
      setup,
      httpChecks,
      leaseFlow,
      cleanup,
      redaction: { status: "attempted" },
      error: safeError,
      checks: STEP_RESULTS,
    });
    const redactedSummary = redactS03(summary, context);
    try {
      assertS03PublicEvidenceRedacted(redactedSummary, context);
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
