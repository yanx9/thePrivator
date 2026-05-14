#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SIDECAR_NAME = "theprivator-sidecar";
export const EXTENSION = process.platform === "win32" ? ".exe" : "";
export const VERIFY_EVENT = "verify.m004.s01";
export const AUTOMATION_HOST = "127.0.0.1";
export const ENV_HOST = "THEPRIVATOR_AUTOMATION_API_HOST";
export const ENV_PORT = "THEPRIVATOR_AUTOMATION_API_PORT";
export const ENV_STORE_ROOT = "THEPRIVATOR_AUTOMATION_API_STORE_ROOT";
export const ENV_TOKEN = "THEPRIVATOR_AUTOMATION_API_TOKEN";
export const AUTOMATION_AUTH_REQUIRED = "AUTOMATION_AUTH_REQUIRED";
export const AUTOMATION_AUTH_INVALID = "AUTOMATION_AUTH_INVALID";

const READINESS_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const LISTENER_CLOSE_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_CHARS = 128 * 1024;
const MAX_SCAN_NODES = 4_000;
const REDACTED_VALUE = "<redacted>";
const SENSITIVE_KEY_PATTERN = /(?:authorization|bearer|token|credential|password|secret|storeRoot|appDataRoot|userDataDir|profileDir|argv|args|env|stdout|stderr|rawDiagnostics|rawDiagnostic|raw|debug|cdp|webSocketDebuggerUrl|websocket)/i;

const STATIC_FORBIDDEN_PATTERNS = Object.freeze([
  { markerClass: "auth_header", pattern: /Authorization/i },
  { markerClass: "auth_scheme", pattern: /\bBearer\b/i },
  { markerClass: "process_config", pattern: /THEPRIVATOR_AUTOMATION_API_[A-Z_]+|\bautomation-api\b/i },
  { markerClass: "debug_endpoint", pattern: /DevToolsActivePort|debugPort|--remote-debugging-port|remote-debugging|cdp:\/\/|webSocketDebuggerUrl/i },
  { markerClass: "ws_endpoint", pattern: /wss?:\/\/[^\s"']+/i },
  { markerClass: "cred_field", pattern: /\b(?:credentials?|password|secret)\b/i },
  { markerClass: "raw_diag", pattern: /\b(?:stdout|stderr|raw diagnostics?|rawDiagnostics?)\b/i },
]);

export class VerifyFailure extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "VerifyFailure";
    this.details = sanitizeFailureDetails(details);
  }
}

function fail(message, details = {}) {
  throw new VerifyFailure(message, details);
}

function assert(condition, message, details = {}) {
  if (!condition) {
    fail(message, details);
  }
}

function sanitizeFailureDetails(details) {
  if (details === null || details === undefined) {
    return {};
  }
  if (typeof details !== "object") {
    return { note: String(details) };
  }
  if (Array.isArray(details)) {
    return details.map((item) => sanitizeFailureDetails(item));
  }

  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      safe[redactedKeyName(key)] = REDACTED_VALUE;
    } else if (typeof value === "string") {
      safe[key] = value.length > 180 ? `${value.slice(0, 180)}…` : value;
    } else if (value && typeof value === "object") {
      safe[key] = sanitizeFailureDetails(value);
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

export function executable(command, platform = process.platform) {
  return platform === "win32" && ["npm", "cargo", "rustc"].includes(command)
    ? `${command}.cmd`
    : command;
}

function runCommandOutput(command, args, { rootDir = ROOT_DIR, timeoutMs = 15_000 } = {}) {
  const result = spawnSync(executable(command), args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });

  if (result.error) {
    fail(`Failed to run ${command}.`, {
      phase: "binary-discovery",
      command,
      errorCode: result.error.code ?? "COMMAND_ERROR",
      action: "Ensure Rust is installed and rustc is available on PATH.",
    });
  }

  if (result.status !== 0) {
    fail(`${command} exited with status ${result.status ?? "unknown"}.`, {
      phase: "binary-discovery",
      command,
      exitCode: result.status,
      action: "Ensure Rust is installed and rustc is available on PATH.",
    });
  }

  return result.stdout.trim();
}

export function readTargetTriple(rootDir = ROOT_DIR) {
  const targetTriple = runCommandOutput("rustc", ["--print", "host-tuple"], { rootDir });
  assert(targetTriple, "rustc did not return a host target triple.", {
    phase: "binary-discovery",
    action: "Install Rust or inspect rustc --print host-tuple.",
  });
  return targetTriple;
}

export function targetBinaryPath({ rootDir = ROOT_DIR, targetTriple = readTargetTriple(rootDir), extension = EXTENSION } = {}) {
  return join(rootDir, "src-tauri", "binaries", `${SIDECAR_NAME}-${targetTriple}${extension}`);
}

export function assertTargetBinary({ rootDir = ROOT_DIR, targetTriple = readTargetTriple(rootDir), binaryPath = targetBinaryPath({ rootDir, targetTriple }) } = {}) {
  const relativeBinary = relative(rootDir, binaryPath);
  assert(existsSync(binaryPath), `Missing target-triple sidecar binary ${relativeBinary}.`, {
    phase: "binary-discovery",
    binary: relativeBinary,
    targetTriple,
    action: "Run npm run sidecar:build before npm run verify:m004:s01.",
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createRedactionContext({ rootDir = ROOT_DIR, token, storeRoot, extraSensitiveValues = [] } = {}) {
  const exactValues = [];
  const addValue = (markerClass, value) => {
    if (typeof value === "string" && value.length > 0) {
      exactValues.push({ markerClass, value, pattern: new RegExp(escapeRegExp(value), "g") });
    }
  };

  addValue("repo_root", rootDir);
  addValue("api_value", token);
  addValue("app_root", storeRoot);
  for (const value of extraSensitiveValues) {
    addValue("extra_value", value);
  }

  return {
    rootDir,
    exactValues: exactValues.sort((left, right) => right.value.length - left.value.length),
    forbiddenPatterns: STATIC_FORBIDDEN_PATTERNS,
  };
}

function classifyForbiddenKey(key) {
  if (/authorization/i.test(key)) return "auth_header";
  if (/bearer/i.test(key)) return "auth_scheme";
  if (/token|secret/i.test(key)) return "api_value";
  if (/credential|password/i.test(key)) return "cred_field";
  if (/storeRoot|appDataRoot|userDataDir|profileDir/i.test(key)) return "app_root";
  if (/argv|args|env/i.test(key)) return "process_config";
  if (/stdout|stderr|raw/i.test(key)) return "raw_diag";
  if (/debug|cdp|websocket|webSocketDebuggerUrl/i.test(key)) return "debug_endpoint";
  return "unsafe_field";
}

function isRedactedPlaceholderKey(key) {
  return /^<redacted-key:[a-z_]+>$/.test(key);
}

function redactedKeyName(key) {
  return `<redacted-key:${classifyForbiddenKey(key)}>`;
}

export function redactText(value, context = createRedactionContext()) {
  let redacted = String(value ?? "");
  for (const marker of context.exactValues ?? []) {
    redacted = redacted.replace(marker.pattern, `<redacted:${marker.markerClass}>`);
  }
  return redacted
    .replace(/Authorization/gi, "<redacted:auth_header>")
    .replace(/\bBearer\b/gi, "<redacted:auth_scheme>")
    .replace(/THEPRIVATOR_AUTOMATION_API_[A-Z_]+/g, "<redacted:process_config>")
    .replace(/\bautomation-api\b/gi, "<redacted:process_arg>")
    .replace(/DevToolsActivePort|debugPort|--remote-debugging-port(?:=|\s+)\d*|remote-debugging|cdp:\/\/|webSocketDebuggerUrl/gi, "<redacted:debug_endpoint>")
    .replace(/wss?:\/\/[^\s"']+/gi, "<redacted:ws_endpoint>");
}

export function redact(value, context = createRedactionContext()) {
  if (typeof value === "string") {
    return redactText(value, context);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, context));
  }

  const redacted = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      redacted[redactedKeyName(key)] = REDACTED_VALUE;
    } else {
      redacted[redactText(key, context)] = redact(nested, context);
    }
  }
  return redacted;
}

export function redactedTail(value, context = createRedactionContext(), maxLength = 600) {
  const text = redactText(value ?? "", context);
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function safeFieldPath(path, keyOrIndex) {
  if (typeof keyOrIndex === "number") {
    return `${path}[${keyOrIndex}]`;
  }
  const segment = SENSITIVE_KEY_PATTERN.test(keyOrIndex) ? redactedKeyName(keyOrIndex) : keyOrIndex;
  return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
}

export function findForbiddenPublicMarker(value, context = createRedactionContext(), path = "$", state = { count: 0 }) {
  if (state.count++ > MAX_SCAN_NODES) {
    return {
      markerClass: "scan_limit",
      fieldPath: path,
      reason: "Public verifier evidence exceeded the bounded redaction scan node limit.",
    };
  }

  if (typeof value === "string") {
    for (const marker of context.exactValues ?? []) {
      if (marker.value && value.includes(marker.value)) {
        return { markerClass: marker.markerClass, fieldPath: path, reason: "sensitive exact value" };
      }
    }
    for (const { markerClass, pattern } of context.forbiddenPatterns ?? []) {
      if (pattern.test(value)) {
        return { markerClass, fieldPath: path, reason: "forbidden text marker" };
      }
    }
    return null;
  }

  if (value === null || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findForbiddenPublicMarker(item, context, safeFieldPath(path, index), state);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (!isRedactedPlaceholderKey(key) && SENSITIVE_KEY_PATTERN.test(key)) {
      return { markerClass: classifyForbiddenKey(key), fieldPath: safeFieldPath(path, key), reason: "forbidden key" };
    }
    const nestedPath = safeFieldPath(path, key);
    const nestedMarker = findForbiddenPublicMarker(nested, context, nestedPath, state);
    if (nestedMarker) return nestedMarker;
  }

  return null;
}

export function assertPublicEvidenceRedacted(value, context = createRedactionContext()) {
  const marker = findForbiddenPublicMarker(value, context);
  assert(!marker, "Public verifier evidence contained a forbidden marker.", marker ?? {});
  return { status: "clean", scanned: true };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expectedKeys, label) {
  const expected = [...expectedKeys].sort();
  const actual = Object.keys(value ?? {}).sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} keys did not match the expected public contract.`, {
    phase: "contract-shape",
    expectedKeys: expected,
    actualKeys: actual.map((key) => (SENSITIVE_KEY_PATTERN.test(key) ? redactedKeyName(key) : key)),
  });
}

function assertLoopbackHost(host, label = "host") {
  assert(["127.0.0.1", "::1"].includes(host), `${label} was not a loopback IP literal.`, {
    phase: "contract-shape",
    field: label,
  });
}

export function parseReadinessLine(line, context = createRedactionContext()) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    fail("Automation API readiness line was not valid JSON.", {
      phase: "readiness",
      lineLength: String(line ?? "").length,
    });
  }

  assert(isPlainObject(payload), "Automation API readiness line was not a JSON object.", {
    phase: "readiness",
  });
  assertPublicEvidenceRedacted(payload, context);
  assertExactKeys(payload, ["host", "port", "version"], "Automation API readiness");
  assertLoopbackHost(payload.host, "readiness.host");
  assert(Number.isInteger(payload.port) && payload.port > 0 && payload.port <= 65535, "Automation API readiness port was invalid.", {
    phase: "readiness",
  });
  assert(typeof payload.version === "string" && payload.version.length > 0, "Automation API readiness version was invalid.", {
    phase: "readiness",
  });
  return payload;
}

function assertRequestIdentity(error) {
  assert(typeof error.detailRef === "string" && error.detailRef.startsWith("sidecar-"), "Automation API error envelope was missing a safe detailRef.", {
    phase: "auth",
    fieldPath: "$.error.detailRef",
  });
  assert(typeof error.requestId === "string" && error.requestId.startsWith("automation-"), "Automation API error envelope was missing a safe requestId.", {
    phase: "auth",
    fieldPath: "$.error.requestId",
  });
}

export function assertAuthErrorResponse({ statusCode, body, expectedCode, context = createRedactionContext(), phase = "auth" } = {}) {
  assert(statusCode === 401, "Protected Automation API request did not fail closed with HTTP 401.", {
    phase,
    expectedStatusCode: 401,
    actualStatusCode: statusCode,
  });
  assertPublicEvidenceRedacted(body, context);
  assert(isPlainObject(body), "Automation API auth failure body was not a JSON object.", { phase });
  assertExactKeys(body, ["error"], "Automation API auth failure body");
  const error = body.error;
  assert(isPlainObject(error), "Automation API auth failure error was not a JSON object.", { phase });
  assertExactKeys(error, ["code", "message", "details", "detailRef", "requestId"], "Automation API auth failure error");
  assert(error.code === expectedCode, "Automation API auth failure returned the wrong typed code.", {
    phase,
    expectedCode,
    actualCode: error.code,
  });
  assert(typeof error.message === "string" && error.message.length > 0, "Automation API auth failure message was missing.", { phase });
  assert(error.details && error.details.phase === "auth", "Automation API auth failure did not name the auth phase.", {
    phase,
    fieldPath: "$.error.details.phase",
  });
  assertRequestIdentity(error);
  return {
    statusCode,
    errorCode: error.code,
    requestId: error.requestId,
    detailRef: error.detailRef,
  };
}

export function assertHealthResponse({ statusCode, body, context = createRedactionContext() } = {}) {
  assert(statusCode === 200, "Public Automation API health check did not return HTTP 200.", {
    phase: "health",
    expectedStatusCode: 200,
    actualStatusCode: statusCode,
  });
  assertPublicEvidenceRedacted(body, context);
  assert(isPlainObject(body), "Automation API health body was not a JSON object.", { phase: "health" });
  assertExactKeys(body, ["api", "automationApi", "product", "request", "sidecar", "status"], "Automation API health body");
  assert(body.status === "healthy", "Automation API health status was not healthy.", { phase: "health" });
  assert(body.product?.name === "ThePrivator", "Automation API health product metadata was missing.", { phase: "health" });
  assert(typeof body.product?.version === "string", "Automation API health product version was missing.", { phase: "health" });
  assert(typeof body.sidecar?.version === "string", "Automation API health sidecar version was missing.", { phase: "health" });
  assert(typeof body.automationApi?.version === "string", "Automation API health version was missing.", { phase: "health" });
  assertLoopbackHost(body.api?.host, "health.api.host");
  assert(Number.isInteger(body.api?.port) && body.api.port > 0, "Automation API health port was invalid.", { phase: "health" });
  assert(body.api.scope === "loopback", "Automation API health scope was not loopback.", { phase: "health" });
  assert(typeof body.request?.requestId === "string" && body.request.requestId.startsWith("automation-"), "Automation API health requestId was missing.", {
    phase: "health",
  });
  return {
    statusCode,
    requestId: body.request.requestId,
    version: body.automationApi.version,
  };
}

export function assertStatusResponse({ statusCode, body, readiness, context = createRedactionContext() } = {}) {
  assert(statusCode === 200, "Authenticated Automation API status check did not return HTTP 200.", {
    phase: "valid-auth",
    expectedStatusCode: 200,
    actualStatusCode: statusCode,
  });
  assertPublicEvidenceRedacted(body, context);
  assert(isPlainObject(body), "Automation API status body was not a JSON object.", { phase: "valid-auth" });
  assertExactKeys(body, ["api", "automationApi", "request", "startedAt", "status", "store"], "Automation API status body");
  assert(body.status === "running", "Automation API status was not running.", { phase: "valid-auth" });
  assert(typeof body.automationApi?.version === "string", "Automation API status version was missing.", { phase: "valid-auth" });
  assertLoopbackHost(body.api?.host, "status.api.host");
  assert(Number.isInteger(body.api?.port) && body.api.port > 0, "Automation API status port was invalid.", { phase: "valid-auth" });
  if (readiness) {
    assert(body.api.host === readiness.host && body.api.port === readiness.port, "Automation API status endpoint did not match readiness.", {
      phase: "valid-auth",
      readinessPort: readiness.port,
      statusPort: body.api.port,
    });
  }
  assert(body.api.scope === "loopback", "Automation API status scope was not loopback.", { phase: "valid-auth" });
  assert(body.store?.configured === true, "Automation API status store metadata was not safe/configured.", { phase: "valid-auth" });
  assert(typeof body.startedAt === "string" && body.startedAt.endsWith("Z"), "Automation API status startedAt was not an ISO timestamp.", { phase: "valid-auth" });
  assert(typeof body.request?.requestId === "string" && body.request.requestId.startsWith("automation-"), "Automation API status requestId was missing.", {
    phase: "valid-auth",
  });
  return {
    statusCode,
    requestId: body.request.requestId,
    api: {
      host: body.api.host,
      port: body.api.port,
      scope: body.api.scope,
    },
    storeConfigured: body.store.configured,
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

  const stdout = createLineCollector(child.stdout);
  const stderr = createLineCollector(child.stderr);
  return { child, stdout, stderr };
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

export async function waitForReadiness(processState, { timeoutMs = READINESS_TIMEOUT_MS, context = createRedactionContext() } = {}) {
  const { child, stdout } = processState;
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanupCallbacks = [];
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const cleanup of cleanupCallbacks) cleanup();
      callback(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort termination; the caller also performs cleanup in finally.
      }
      settle(rejectPromise, new VerifyFailure("Automation API process did not emit readiness before the timeout.", {
        phase: "readiness",
        timeoutMs,
        cleanup: "terminate-requested",
      }));
    }, timeoutMs);

    cleanupCallbacks.push(stdout.onLine((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const payload = parseReadinessLine(trimmed, context);
        settle(resolvePromise, payload);
      } catch (error) {
        settle(rejectPromise, error);
      }
    }));

    const onExit = (exitCode, signal) => {
      settle(rejectPromise, new VerifyFailure("Automation API process exited before readiness.", {
        phase: "readiness",
        exitCode,
        signal,
      }));
    };
    child.once("exit", onExit);
    cleanupCallbacks.push(() => child.off("exit", onExit));

    const onError = (error) => {
      settle(rejectPromise, new VerifyFailure("Automation API process could not be started.", {
        phase: "readiness",
        errorCode: error?.code ?? "SPAWN_ERROR",
        action: "Run npm run sidecar:build and retry the verifier.",
      }));
    };
    child.once("error", onError);
    cleanupCallbacks.push(() => child.off("error", onError));
  });
}

async function fetchJson(url, { headerValue, timeoutMs = HTTP_TIMEOUT_MS, phase, context = createRedactionContext() } = {}) {
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
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      fail("Automation API response body was not valid JSON.", {
        phase,
        statusCode: response.status,
        bodyLength: text.length,
      });
    }
    assertPublicEvidenceRedacted(body, context);
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

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function waitForListenerClosed({ host, port, timeoutMs = LISTENER_CLOSE_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const open = await connectOnce(host, port);
    if (!open) {
      return { closed: true, attempts };
    }
    await delay(150);
  }
  fail("Automation API listener remained open after shutdown.", {
    phase: "listener-close",
    port,
    attempts,
    timeoutMs,
  });
}

async function stopChild(processState, { timeoutMs = SHUTDOWN_TIMEOUT_MS } = {}) {
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
      // Best effort only; the failure below is the public signal.
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

const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];

function emit(event, context = createRedactionContext()) {
  const safeEvent = redact({ event: VERIFY_EVENT, ...event }, context);
  VERIFIER_EVENTS.push(safeEvent);
  console.log(JSON.stringify(safeEvent));
  return safeEvent;
}

function recordStep(name, status, started, fields = {}, context = createRedactionContext()) {
  const durationMs = Math.round(performance.now() - started);
  const record = redact({ name, status, durationMs, ...fields }, context);
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

function runStep(name, action, context = createRedactionContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(action());
    recordStep(name, "pass", started, publicResult, context);
    return returnValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = error instanceof VerifyFailure ? error.details : {};
    recordStep(name, "fail", started, { message, details }, context);
    throw error;
  }
}

async function runStepAsync(name, action, context = createRedactionContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(await action());
    recordStep(name, "pass", started, publicResult, context);
    return returnValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = error instanceof VerifyFailure ? error.details : {};
    recordStep(name, "fail", started, { message, details }, context);
    throw error;
  }
}

export function buildFinalSummary({ status, target, readiness, httpChecks = {}, cleanup = {}, redaction = {}, error = null, checks = STEP_RESULTS } = {}) {
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
    http: {
      health: httpChecks.health,
      missingAuth: httpChecks.missingAuth,
      malformedAuth: httpChecks.malformedAuth,
      invalidAuth: httpChecks.invalidAuth,
      validAuth: httpChecks.validAuth,
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
    summary.error = {
      name: error.name ?? "Error",
      message: error.message ?? String(error),
      details: error.details ?? {},
    };
  }

  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}

function resetRunState() {
  STEP_RESULTS.length = 0;
  VERIFIER_EVENTS.length = 0;
}

export async function runVerification({ rootDir = ROOT_DIR, token = `m004-s01-${randomUUID()}`, storeRoot = mkdtempSync(join(tmpdir(), "theprivator-m004-s01-")) } = {}) {
  resetRunState();
  let context = createRedactionContext({ rootDir });
  let processState = null;
  let target = null;
  let readiness = null;
  const httpChecks = {};
  const cleanup = { childExit: null, listenerClosed: false, runtimeRootRemoved: false };

  try {
    target = runStep("binary-discovery", () => {
      const targetTriple = readTargetTriple(rootDir);
      return assertTargetBinary({ rootDir, targetTriple });
    }, context);

    context = createRedactionContext({ rootDir, token, storeRoot });
    runStep("runtime-root", () => ({ created: true, location: "temporary-app-data" }), context);

    processState = runStep("spawn", () => {
      const state = startAutomationApi({ binaryPath: join(rootDir, target.binary), storeRoot, token });
      return { value: state, log: { child: state.child.pid ? "started" : "pending" } };
    }, context);

    readiness = await runStepAsync("readiness", async () => waitForReadiness(processState, { context }), context);
    const baseUrl = `http://${readiness.host}:${readiness.port}`;

    httpChecks.health = await runStepAsync("health", async () => {
      const response = await fetchJson(`${baseUrl}/health`, { phase: "health", context });
      return assertHealthResponse({ ...response, context });
    }, context);

    httpChecks.missingAuth = await runStepAsync("auth-missing", async () => {
      const response = await fetchJson(`${baseUrl}/v1/status`, { phase: "auth-missing", context });
      return assertAuthErrorResponse({ ...response, expectedCode: AUTOMATION_AUTH_REQUIRED, context, phase: "auth-missing" });
    }, context);

    httpChecks.malformedAuth = await runStepAsync("auth-malformed", async () => {
      const response = await fetchJson(`${baseUrl}/v1/status`, { headerValue: "Basic not-the-local-token", phase: "auth-malformed", context });
      return assertAuthErrorResponse({ ...response, expectedCode: AUTOMATION_AUTH_INVALID, context, phase: "auth-malformed" });
    }, context);

    httpChecks.invalidAuth = await runStepAsync("auth-invalid", async () => {
      const response = await fetchJson(`${baseUrl}/v1/status`, { headerValue: "Bearer not-the-local-token", phase: "auth-invalid", context });
      return assertAuthErrorResponse({ ...response, expectedCode: AUTOMATION_AUTH_INVALID, context, phase: "auth-invalid" });
    }, context);

    httpChecks.validAuth = await runStepAsync("auth-valid", async () => {
      const response = await fetchJson(`${baseUrl}/v1/status`, { headerValue: `Bearer ${token}`, phase: "auth-valid", context });
      return assertStatusResponse({ ...response, readiness, context });
    }, context);

    cleanup.childExit = await runStepAsync("shutdown", async () => stopChild(processState), context);
    const listener = await runStepAsync("listener-close", async () => waitForListenerClosed({ host: readiness.host, port: readiness.port }), context);
    cleanup.listenerClosed = listener.closed;
    cleanup.runtimeRootRemoved = runStep("cleanup", () => ({ runtimeRootRemoved: removeRuntimeRoot(storeRoot) }), context).runtimeRootRemoved;

    const redactionResult = runStep("redaction-scan", () => assertPublicEvidenceRedacted({ events: VERIFIER_EVENTS, checks: STEP_RESULTS }, context), context);
    const summary = buildFinalSummary({
      status: "pass",
      target,
      readiness,
      httpChecks,
      cleanup,
      redaction: redactionResult,
      checks: STEP_RESULTS,
    });
    assertPublicEvidenceRedacted(summary, context);
    emit({ status: "pass", summary }, context);
    return { summary, events: VERIFIER_EVENTS, checks: STEP_RESULTS };
  } catch (error) {
    if (processState?.child && processState.child.exitCode === null && processState.child.signalCode === null) {
      try {
        cleanup.childExit = await stopChild(processState);
      } catch (stopError) {
        cleanup.childExit = { cleanup: "failed", reason: stopError instanceof Error ? stopError.message : "unknown" };
      }
    }
    try {
      cleanup.runtimeRootRemoved = removeRuntimeRoot(storeRoot);
    } catch {
      cleanup.runtimeRootRemoved = false;
    }

    const safeError = error instanceof VerifyFailure
      ? error
      : new VerifyFailure(error instanceof Error ? error.message : String(error));
    const summary = buildFinalSummary({
      status: "fail",
      target,
      readiness,
      httpChecks,
      cleanup,
      redaction: { status: "attempted" },
      error: safeError,
      checks: STEP_RESULTS,
    });
    const redactedSummary = redact(summary, context);
    try {
      assertPublicEvidenceRedacted(redactedSummary, context);
    } catch (redactionError) {
      emit({ status: "fail", summary: { status: "fail", redaction: { status: "failed", details: redactionError.details ?? {} }, cleanup } }, context);
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
