import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readUiSources } from "./ui-sources.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_NAME = "theprivator-sidecar";
const EXTENSION = process.platform === "win32" ? ".exe" : "";
const SIDECAR_TIMEOUT_MS = 60_000;
const SIDECAR_STOP_TIMEOUT_MS = 2_000;
const PRESET_ID = "ubuntu-linux-chrome-120";
const DIAGNOSTIC_RELATIVE_LOG_PATH = "profile-store/diagnostics/events.jsonl";
const PROXY_USERNAME = "proxy-s04-user-sentinel";
const PROXY_PASSWORD = "proxy-s04-password-sentinel";
const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];
const SIDECAR_TRANSCRIPTS = [];
const PUBLIC_RESULTS = [];
const SENSITIVE_VALUES = new Set([ROOT_DIR, PROXY_USERNAME, PROXY_PASSWORD]);
const SECRET_KEY_RE = /^(?:auth|authorization|credentials?|password|proxyAuthorization|proxyPass|proxyPassword|proxyUser|proxyUsername|username)$/i;
const PUBLIC_FORBIDDEN_TEXT = [
  "Proxy-Authorization",
  "proxy-authorization",
  "proxy_authorization",
  "DevToolsActivePort",
  "--proxy-server",
  "--remote-debugging-port",
  "--user-data-dir",
  "--load-extension",
  "--disable-extensions-except",
  "proxy-auth-extensions",
  "identity-extensions",
  "private key",
  "BEGIN PRIVATE KEY",
  "proxy-key.pem",
  "proxy-cert.pem",
  "ws://",
  "wss://",
  "Traceback",
];
const PRIVATE_STORE_RUNTIME_FIELDS = new Set([
  "args",
  "argv",
  "binaryPath",
  "command",
  "debugPort",
  "devtoolsPort",
  "executable",
  "executablePath",
  "launchArgs",
  "pid",
  "process",
  "remoteControlPort",
  "remoteDebuggingPort",
  "running",
  "startedAt",
  "status",
  "stoppedAt",
  "termination",
  "webSocketDebuggerUrl",
  "wsEndpoint",
]);
const PUBLIC_CHECKER_CATALOG = [
  {
    id: "cloudflare-trace",
    label: "Cloudflare trace",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    surfaces: ["ip"],
  },
  {
    id: "aws-checkip",
    label: "AWS checkip",
    url: "https://checkip.amazonaws.com/",
    surfaces: ["ip"],
  },
  {
    id: "webbrowsertools-webrtc",
    label: "WebRTC leak test",
    url: "https://webbrowsertools.com/webrtc-leak-test/",
    surfaces: ["webrtc"],
  },
];
let requestCounter = 0;

class VerifyFailure extends Error {
  constructor(message, details) {
    super(message);
    this.name = "VerifyFailure";
    this.details = redact(details);
  }
}

class LineReader {
  constructor(stream, streamName) {
    this.streamName = streamName;
    this.buffer = "";
    this.ended = false;
    this.lines = [];
    this.tailLines = [];
    this.waiters = [];

    stream.setEncoding("utf8");
    stream.on("data", (chunk) => this.acceptChunk(chunk));
    stream.on("end", () => this.finish());
    stream.on("error", (error) => this.finish(error));
  }

  acceptChunk(chunk) {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r?\n/);
    this.buffer = parts.pop() ?? "";
    for (const line of parts) {
      this.pushLine(line);
    }
  }

  pushLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    this.tailLines.push(trimmed);
    this.tailLines = this.tailLines.slice(-10);
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(trimmed);
      return;
    }
    this.lines.push(trimmed);
  }

  finish(error) {
    if (this.buffer.trim()) {
      this.pushLine(this.buffer);
      this.buffer = "";
    }
    this.ended = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(error ?? new Error(`${this.streamName} ended before the sidecar emitted the expected NDJSON line.`));
    }
  }

  next(timeoutMs, onTimeout) {
    if (this.lines.length > 0) {
      return Promise.resolve(this.lines.shift());
    }
    if (this.ended) {
      return Promise.reject(new Error(`${this.streamName} ended before the sidecar emitted the expected NDJSON line.`));
    }
    return new Promise((resolveLine, rejectLine) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        onTimeout();
        rejectLine(new Error(`${this.streamName} timed out waiting for sidecar NDJSON.`));
      }, timeoutMs);
      this.waiters.push({ resolve: resolveLine, reject: rejectLine, timer });
    });
  }

  tail() {
    return normalizeOutput(this.tailLines.join("\n"));
  }
}

class SidecarSession {
  constructor(binaryPath) {
    this.child = spawn(binaryPath, [], {
      cwd: ROOT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stdout = new LineReader(this.child.stdout, "sidecar stdout");
    this.stderr = new LineReader(this.child.stderr, "sidecar stderr");
    this.exited = false;
    this.exitInfo = null;
    this.exitPromise = new Promise((resolveExit) => {
      this.child.once("exit", (code, signal) => {
        this.exited = true;
        this.exitInfo = { code, signal };
        resolveExit(this.exitInfo);
      });
    });
    this.child.once("error", (error) => {
      this.exited = true;
      this.exitInfo = { code: null, signal: null, error };
    });
  }

  async request(id, method, params, options = {}) {
    if (this.exited) {
      fail("Built sidecar exited before a verifier request completed.", {
        method,
        requestId: id,
        exit: this.exitInfo,
        stdoutTail: this.stdout.tail(),
        stderrTail: this.stderr.tail(),
      });
    }

    const timeoutMs = options.timeoutMs ?? SIDECAR_TIMEOUT_MS;
    const stdoutLinePromise = this.stdout.next(timeoutMs, () => this.kill());
    const stderrLinePromise = this.stderr.next(timeoutMs, () => this.kill());
    try {
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, "utf8");
    } catch (error) {
      fail("Failed to write a request to the built sidecar.", {
        method,
        requestId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let stdoutLine;
    let stderrLine;
    try {
      [stdoutLine, stderrLine] = await Promise.all([stdoutLinePromise, stderrLinePromise]);
    } catch (error) {
      fail(`Built sidecar timed out or stopped during ${method}.`, {
        method,
        requestId: id,
        timeoutMs,
        error: error instanceof Error ? error.message : String(error),
        stdoutTail: this.stdout.tail(),
        stderrTail: this.stderr.tail(),
      });
    }

    const response = parseJsonLine("sidecar stdout", stdoutLine, { method, requestId: id });
    const diagnostic = parseJsonLine("sidecar stderr", stderrLine, { method, requestId: id });
    const transcript = { id, method, response, diagnostics: [diagnostic], stdout: stdoutLine, stderr: stderrLine };
    SIDECAR_TRANSCRIPTS.push(transcript);
    return transcript;
  }

  kill() {
    if (!this.exited) {
      this.child.kill("SIGKILL");
    }
  }

  async close() {
    if (this.exited) {
      return this.exitInfo;
    }
    try {
      this.child.stdin.end();
    } catch {
      // Process may already be exiting.
    }
    const timeout = new Promise((resolveTimeout) => {
      setTimeout(() => resolveTimeout({ timeout: true }), SIDECAR_STOP_TIMEOUT_MS);
    });
    const result = await Promise.race([this.exitPromise, timeout]);
    if (result?.timeout && !this.exited) {
      this.kill();
      return this.exitPromise;
    }
    return result;
  }
}

function emit(event) {
  const payload = redact({ event: "verify.s04", ...event });
  VERIFIER_EVENTS.push(payload);
  console.log(JSON.stringify(payload));
}

function fail(message, details) {
  throw new VerifyFailure(message, details);
}

function assert(condition, message, details) {
  if (!condition) {
    fail(message, details);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function runStep(name, action) {
  const started = performance.now();
  try {
    const result = await action();
    const durationMs = Math.round(performance.now() - started);
    const logResult = isPlainObject(result) && Object.prototype.hasOwnProperty.call(result, "log") ? result.log : result;
    const returnResult = isPlainObject(result) && Object.prototype.hasOwnProperty.call(result, "value") ? result.value : result;
    const logPayload = isPlainObject(logResult) ? logResult : { value: logResult };
    STEP_RESULTS.push({ name, status: "pass", durationMs });
    emit({ step: name, status: "pass", durationMs, ...logPayload });
    return returnResult;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    STEP_RESULTS.push({ name, status: "fail", durationMs, message });
    emit({ step: name, status: "fail", durationMs, message });
    if (error?.details) {
      emit({ step: name, status: "fail-details", details: error.details });
    }
    throw error;
  }
}

function rememberSensitive(value) {
  if (typeof value === "string" && value.trim()) {
    SENSITIVE_VALUES.add(value);
  }
}

function redactText(value) {
  let redacted = String(value ?? "");
  for (const sensitive of Array.from(SENSITIVE_VALUES).filter(Boolean).sort((a, b) => b.length - a.length)) {
    const replacement = sensitive === ROOT_DIR
      ? "<repo>"
      : sensitive.includes("theprivator-s04-")
        ? "<temp-root>"
        : "<redacted>";
    redacted = redacted.split(sensitive).join(replacement);
  }
  return redacted
    .replace(/ws:\/\/[^\s"']+/gi, "ws://<redacted>")
    .replace(/wss:\/\/[^\s"']+/gi, "wss://<redacted>")
    .replace(/--remote-debugging-port(?:=|\s+)\d+/gi, "--remote-debugging-port=<redacted>")
    .replace(/--user-data-dir(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)/gi, "--user-data-dir=<redacted>")
    .replace(/debugPort["':\s=]+\d+/gi, "debugPort=<redacted>");
}

function redact(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (SECRET_KEY_RE.test(key)) {
        return ["<redacted-key>", "<redacted>"];
      }
      return [key, redact(item)];
    }));
  }
  return value;
}

function normalizeOutput(value, maxLength = 800) {
  const text = redactText(value)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-20)
    .join("\n");
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function parseJsonLine(streamName, line, context) {
  try {
    return JSON.parse(line);
  } catch (error) {
    fail(`${streamName} emitted malformed NDJSON.`, {
      ...context,
      error: error instanceof Error ? error.message : String(error),
      lineTail: normalizeOutput(line),
    });
  }
}

function readTargetTriple() {
  try {
    return execFileSync("rustc", ["--print", "host-tuple"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail("Failed to determine the Rust host target triple.", error instanceof Error ? error.message : String(error));
  }
}

function targetBinaryPath(targetTriple) {
  return join(ROOT_DIR, "src-tauri", "binaries", `${SIDECAR_NAME}-${targetTriple}${EXTENSION}`);
}

function assertTargetBinary(binaryPath, targetTriple) {
  assert(existsSync(binaryPath), `Missing built sidecar binary ${relative(ROOT_DIR, binaryPath)}.`, {
    instruction: "Run npm run sidecar:build before npm run verify:s04.",
    targetTriple,
  });
  const stats = statSync(binaryPath);
  assert(stats.isFile(), "Built sidecar path is not a file.", { binary: relative(ROOT_DIR, binaryPath) });
  if (process.platform !== "win32") {
    assert((stats.mode & 0o111) !== 0, "Built sidecar binary is not executable.", { binary: relative(ROOT_DIR, binaryPath) });
  }
  return { binary: relative(ROOT_DIR, binaryPath), targetTriple };
}

function makeRequestId(label) {
  requestCounter += 1;
  return `verify-s04-${safeLabel(label)}-${requestCounter}`;
}

function safeLabel(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "case";
}

function makeTempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  rememberSensitive(root);
  return root;
}

async function sidecarSuccess(session, id, method, params, options = {}) {
  const transcript = await session.request(id, method, params, options);
  const { response, diagnostics } = transcript;
  const diagnostic = diagnostics[0];
  assertRequestDiagnostic(diagnostic, { id, method }, "ok");
  assert(response.id === id, "Sidecar success response id mismatch.", { method, responseId: response.id, expectedId: id });
  assert(response.ok === true, `Expected ${method} to succeed.`, {
    method,
    errorCode: response.error?.code,
    detailRef: response.error?.detailRef,
  });
  assert(response.protocolVersion === "1.0.0", "Sidecar protocol version changed.", { method, protocolVersion: response.protocolVersion });
  assert(isPlainObject(response.result), "Sidecar success result must be an object.", { method });
  assertNoUnsafePublicPayload({ response: response.result, diagnostic }, `${method}.success`);
  PUBLIC_RESULTS.push({ method, result: response.result, diagnostic });
  return { result: response.result, response, diagnostic, transcript };
}

async function sidecarError(session, id, method, params, options = {}) {
  const transcript = await session.request(id, method, params, options);
  const { response, diagnostics } = transcript;
  const diagnostic = diagnostics[0];
  assertRequestDiagnostic(diagnostic, { id, method }, "error");
  assert(response.id === id, "Sidecar error response id mismatch.", { method, responseId: response.id, expectedId: id });
  assert(response.ok === false, `Expected ${method} to fail safely.`, { method, result: response.result });
  assert(response.protocolVersion === "1.0.0", "Sidecar protocol version changed.", { method, protocolVersion: response.protocolVersion });
  assert(isPlainObject(response.error), "Sidecar error response is missing error.", { method });
  assert(response.error.recoverable === true, "Sidecar error was not recoverable.", response.error);
  assert(typeof response.error.detailRef === "string" && response.error.detailRef.startsWith("sidecar-"), "Sidecar error lost its opaque detailRef.", response.error);
  assert(diagnostic.errorCode === response.error.code, "Sidecar error diagnostic code mismatch.", { method, diagnostic, error: response.error });
  assert(diagnostic.detailRef === response.error.detailRef, "Sidecar error diagnostic detailRef mismatch.", { method, diagnostic, error: response.error });
  assertNoUnsafePublicPayload({ error: response.error, diagnostic }, `${method}.error`);
  PUBLIC_RESULTS.push({ method, error: response.error, diagnostic });
  return { error: response.error, response, diagnostic, transcript };
}

function assertRequestDiagnostic(diagnostic, request, expectedStatus) {
  assert(isPlainObject(diagnostic), "Sidecar diagnostic is not an object.", { request, diagnostic });
  assert(diagnostic.event === "sidecar.request", "Sidecar diagnostic event changed.", { request, diagnostic });
  assert(diagnostic.requestId === request.id, "Sidecar diagnostic request id mismatch.", { request, diagnostic });
  assert(diagnostic.method === request.method, "Sidecar diagnostic method mismatch.", { request, diagnostic });
  assert(diagnostic.status === expectedStatus, "Sidecar diagnostic status mismatch.", { request, expectedStatus, diagnosticStatus: diagnostic.status });
  assert(typeof diagnostic.durationMs === "number" && Number.isFinite(diagnostic.durationMs) && diagnostic.durationMs >= 0, "Sidecar diagnostic duration is invalid.", { request, diagnostic });
  if (expectedStatus === "ok") {
    assert(diagnostic.errorCode === null, "Successful diagnostic had an errorCode.", { request, diagnostic });
    assert(diagnostic.detailRef === null, "Successful diagnostic had a detailRef.", { request, diagnostic });
  } else {
    assert(typeof diagnostic.errorCode === "string" && /^[A-Z][A-Z0-9_]+$/.test(diagnostic.errorCode), "Error diagnostic lost safe errorCode.", { request, diagnostic });
    assert(typeof diagnostic.detailRef === "string" && diagnostic.detailRef.startsWith("sidecar-"), "Error diagnostic lost sidecar detailRef.", { request, diagnostic });
  }
  for (const key of Object.keys(diagnostic)) {
    assert(!SECRET_KEY_RE.test(key), "Diagnostic leaked a credential-bearing key.", { key, request });
  }
}

function exactKeys(record, expected, surface) {
  assert(isPlainObject(record), `${surface} must be an object.`, { observedType: typeof record });
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  assert(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${surface} keys changed.`, {
    expected: wanted,
    actual,
  });
}

function assertProfileShape(profile, expectedName) {
  exactKeys(profile, ["id", "name", "createdAt", "updatedAt", "defaults", "storage", "identity", "proxy"], "profile");
  assert(typeof profile.id === "string" && /^[0-9a-f-]{36}$/.test(profile.id), "Profile id was not a UUID.", { profileId: profile.id });
  assert(profile.name === expectedName, "Profile name mismatch.", { expectedName, profileName: profile.name });
  assert(isPlainObject(profile.storage), "Profile storage missing.", { profileId: profile.id });
  assert(typeof profile.storage.profileDir === "string" && profile.storage.profileDir.startsWith("profile-store/profiles/"), "Profile profileDir must be relative.", { profileId: profile.id });
  assert(typeof profile.storage.userDataDir === "string" && profile.storage.userDataDir.endsWith("/user-data") && !profile.storage.userDataDir.startsWith("/"), "Profile userDataDir must be relative.", { profileId: profile.id });
  assertPublicProxySummary(profile.proxy, { mode: "direct" }, "profile.proxy");
  return profile;
}

function expectedCredentialState(proxy) {
  return isPlainObject(proxy?.credentials) ? "configured" : "none";
}

function assertPublicProxySummary(summary, expected, surface) {
  assert(isPlainObject(summary), `${surface} missing public proxy summary.`, { summary });
  if (expected.mode === "direct") {
    exactKeys(summary, ["proxyVersion", "mode", "credentialState", "summary"], surface);
    assert(summary.proxyVersion === 1, `${surface}.proxyVersion mismatch.`, { summary });
    assert(summary.mode === "direct", `${surface}.mode mismatch.`, { summary });
    assert(summary.credentialState === "none", `${surface}.credentialState mismatch.`, { summary });
    assert(summary.summary === "Direct connection", `${surface}.summary mismatch.`, { summary });
    return;
  }

  exactKeys(summary, ["proxyVersion", "mode", "protocol", "host", "port", "credentialState", "summary"], surface);
  assert(summary.proxyVersion === 1, `${surface}.proxyVersion mismatch.`, { summary });
  assert(summary.mode === "fixedServer", `${surface}.mode mismatch.`, { summary });
  assert(summary.protocol === expected.protocol, `${surface}.protocol mismatch.`, { expected: expected.protocol, observed: summary.protocol });
  assert(summary.host === expected.host, `${surface}.host mismatch.`, { expected: expected.host, observed: summary.host });
  assert(summary.port === expected.port, `${surface}.port mismatch.`, { expected: expected.port, observed: summary.port });
  assert(summary.credentialState === expectedCredentialState(expected), `${surface}.credentialState mismatch.`, { summary });
  assert(summary.summary === `${expected.protocol}://${expected.host}:${expected.port}`, `${surface}.summary mismatch.`, { summary });
}

function assertDirectRouteProof(routeProof) {
  exactKeys(routeProof, ["status", "basis", "scope", "protocol", "credentialState", "durationMs", "fixture", "target", "directFallbackDetected", "observationCounts"], "routeProof");
  assert(routeProof.status === "not-run", "Direct route proof must be not-run.", { routeProof });
  assert(routeProof.basis === "direct-profile", "Direct route proof basis mismatch.", { routeProof });
  assert(routeProof.scope === "not-applicable", "Direct route proof scope mismatch.", { routeProof });
  assert(routeProof.protocol === null, "Direct route proof protocol must be null.", { routeProof });
  assert(routeProof.credentialState === "none", "Direct route proof credential state mismatch.", { routeProof });
  assert(routeProof.durationMs === 0, "Direct route proof duration must be zero.", { routeProof });
  assert(routeProof.fixture === null && routeProof.target === null, "Direct route proof fixture/target must be null.", { routeProof });
  assert(routeProof.directFallbackDetected === false, "Direct route proof fallback flag must stay false.", { routeProof });
  assert(routeProof.observationCounts?.proxy === 0 && routeProof.observationCounts?.target === 0, "Direct route proof observation counts must be zero.", { routeProof });
}

function assertProvedRouteProof(routeProof, expectedProxy) {
  exactKeys(routeProof, ["status", "basis", "scope", "protocol", "credentialState", "durationMs", "fixture", "target", "directFallbackDetected", "observationCounts"], "routeProof");
  assert(routeProof.status === "proved", "Fixed proxy route proof must be proved.", { routeProof });
  assert(routeProof.basis === "sidecar-managed-local-fixture", "Fixed proxy route proof basis mismatch.", { routeProof });
  assert(routeProof.scope === "local-fixture", "Fixed proxy route proof scope mismatch.", { routeProof });
  assert(routeProof.protocol === expectedProxy.protocol, "Fixed proxy route proof protocol mismatch.", { expected: expectedProxy.protocol, observed: routeProof.protocol });
  assert(routeProof.credentialState === expectedCredentialState(expectedProxy), "Fixed proxy route proof credential state mismatch.", { routeProof });
  assert(typeof routeProof.durationMs === "number" && Number.isFinite(routeProof.durationMs) && routeProof.durationMs >= 0, "Fixed proxy route proof duration invalid.", { routeProof });
  exactKeys(routeProof.fixture, ["kind", "managed"], "routeProof.fixture");
  assert(routeProof.fixture.kind === expectedProxy.protocol && routeProof.fixture.managed === true, "Fixed proxy route proof fixture mismatch.", { routeProof });
  exactKeys(routeProof.target, ["host", "port"], "routeProof.target");
  assert(routeProof.target.host === "theprivator-proxy-proof.invalid", "Fixed proxy proof target host changed.", { target: routeProof.target });
  assert(routeProof.target.port === 80, "Fixed proxy proof target port changed.", { target: routeProof.target });
  assert(routeProof.directFallbackDetected === false, "Fixed proxy route proof detected direct fallback.", { routeProof });
  assert(routeProof.observationCounts?.proxy > 0 && routeProof.observationCounts?.target > 0, "Fixed proxy route proof observation counts must be positive.", { routeProof });
}

function assertIpHiding(ipHiding, expectedStatus) {
  exactKeys(ipHiding, ["status", "basis", "scope", "publicExitIpClaimed", "publicExitIp", "publicExitLocation", "localFixtureConclusion"], "ipHiding");
  // A public exit IP is advisory and only ever populated by a live lookup through
  // the real proxy. This verifier runs entirely against the managed local fixture
  // on a .invalid host, which proxy_check skips, so all three must be absent here
  // -- an exit IP appearing in this run would mean the check reached the network.
  assert(ipHiding.publicExitIpClaimed === false && ipHiding.publicExitIp === null && ipHiding.publicExitLocation === null,
    "Proxy check must not report a public exit observation against the local fixture.", { ipHiding });
  if (expectedStatus === "not-proven") {
    assert(ipHiding.status === "not-proven", "Direct profile IP hiding status mismatch.", { ipHiding });
    assert(ipHiding.basis === "direct-profile" && ipHiding.scope === "not-applicable", "Direct profile IP hiding basis/scope mismatch.", { ipHiding });
    assert(ipHiding.localFixtureConclusion === "not-run", "Direct profile IP hiding conclusion mismatch.", { ipHiding });
    return;
  }
  assert(ipHiding.status === "proved", "Fixed proxy IP hiding status mismatch.", { ipHiding });
  assert(ipHiding.basis === "route-proof-succeeded" && ipHiding.scope === "local-fixture", "Fixed proxy IP hiding basis/scope mismatch.", { ipHiding });
  assert(ipHiding.localFixtureConclusion === "direct target IP hidden from the proof target by the managed fixture", "Fixed proxy IP hiding conclusion mismatch.", { ipHiding });
}

function assertWebRtc(webRtc, expected) {
  exactKeys(webRtc, ["status", "basis", "mode", "policy", "localIpExposure"], "webRtc");
  assert(webRtc.basis === "profile-identity-policy", "WebRTC basis mismatch.", { webRtc });
  if (expected === "baseline-real") {
    assert(webRtc.status === "baseline-real", "Expected baseline-real WebRTC classification.", { webRtc });
    assert(webRtc.mode === "real" && webRtc.policy === "real", "Expected real WebRTC policy.", { webRtc });
    assert(webRtc.localIpExposure === "real-local-ip-baseline", "Expected real local IP baseline exposure copy.", { webRtc });
    return;
  }
  assert(webRtc.status === "restricted", "Expected restricted WebRTC classification.", { webRtc });
  assert(webRtc.mode === "masked" && webRtc.policy === "disableNonProxiedUdp", "Expected disableNonProxiedUdp WebRTC policy.", { webRtc });
  assert(webRtc.localIpExposure === "non-proxied-udp-disabled", "Expected non-proxied UDP disabled exposure copy.", { webRtc });
}

function assertPublicCheckers(publicCheckers) {
  exactKeys(publicCheckers, ["status", "basis", "networkDependency", "pages"], "publicCheckers");
  assert(publicCheckers.status === "advisory-only", "Public checkers must stay advisory-only.", { publicCheckers });
  assert(publicCheckers.basis === "fixed-https-allowlist", "Public checker basis mismatch.", { publicCheckers });
  assert(publicCheckers.networkDependency === "user-driven-external-pages", "Public checker network dependency mismatch.", { publicCheckers });
  assert(Array.isArray(publicCheckers.pages) && publicCheckers.pages.length === PUBLIC_CHECKER_CATALOG.length, "Public checker catalog count mismatch.", { publicCheckers });
  for (const expected of PUBLIC_CHECKER_CATALOG) {
    const page = publicCheckers.pages.find((item) => item?.id === expected.id);
    assert(page, "Public checker catalog is missing an expected page.", { expectedId: expected.id });
    exactKeys(page, ["id", "label", "url", "surfaces", "advisory"], `publicCheckers.${expected.id}`);
    assert(page.label === expected.label, "Public checker label mismatch.", { expected, page });
    assert(page.url === expected.url && page.url.startsWith("https://"), "Public checker URL mismatch.", { expected, page });
    assert(Array.isArray(page.surfaces) && sameStringArray(page.surfaces, expected.surfaces), "Public checker surfaces mismatch.", { expected, page });
    assert(typeof page.advisory === "string" && page.advisory.includes("guidance only"), "Public checker advisory copy must remain bounded guidance.", { pageId: page.id });
  }
}

function sameStringArray(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function assertProxyCheckResult(result, profileId, expectedProxy, expectedWebRtc) {
  exactKeys(result, ["proxyCheckVersion", "profileId", "proxy", "routeProof", "ipHiding", "webRtc", "publicCheckers"], "proxyCheck");
  assert(result.proxyCheckVersion === 1, "Proxy check version mismatch.", { version: result.proxyCheckVersion });
  assert(result.profileId === profileId, "Proxy check profile id mismatch.", { profileId: result.profileId, expectedProfileId: profileId });
  assertPublicProxySummary(result.proxy, expectedProxy, "proxyCheck.proxy");
  if (expectedProxy.mode === "direct") {
    assertDirectRouteProof(result.routeProof);
    assertIpHiding(result.ipHiding, "not-proven");
  } else {
    assertProvedRouteProof(result.routeProof, expectedProxy);
    assertIpHiding(result.ipHiding, "proved");
  }
  assertWebRtc(result.webRtc, expectedWebRtc);
  assertPublicCheckers(result.publicCheckers);
  assertNoUnsafePublicPayload(result, "proxyCheck.result");
  return {
    routeProof: result.routeProof.status,
    ipHiding: result.ipHiding.status,
    webRtc: result.webRtc.status,
    publicCheckerStatus: result.publicCheckers.status,
  };
}

function diagnosticLogPath(storeRoot) {
  return join(storeRoot, "profile-store", "diagnostics", "events.jsonl");
}

function parseDiagnosticsLog(storeRoot, { required = true } = {}) {
  const path = diagnosticLogPath(storeRoot);
  if (!existsSync(path)) {
    assert(!required, "Expected profile-store diagnostics JSONL to exist.", { logPath: DIAGNOSTIC_RELATIVE_LOG_PATH });
    return [];
  }
  const text = readFileSync(path, "utf8");
  assertNoUnsafeText(text, "diagnostics.jsonl");
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail("Persisted diagnostic line is malformed JSON.", {
        lineNumber: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    assertNoUnsafePublicPayload(record, `diagnostics[${index}]`);
    assert(record.logPath === DIAGNOSTIC_RELATIVE_LOG_PATH, "Diagnostic record lost the fixed relative log path.", { lineNumber: index + 1, logPath: record.logPath });
    return record;
  });
}

function assertDiagnosticEntry(records, expected) {
  const match = records.find((record) => record.requestId === expected.requestId
    && record.method === expected.method
    && record.status === expected.status
    && (expected.errorCode === undefined || record.errorCode === expected.errorCode)
    && (expected.detailRef === undefined || record.detailRef === expected.detailRef));
  assert(match, "Expected diagnostic entry was not persisted.", { expected, observedCount: records.length });
  return match;
}

function assertDiagnosticLookup(storeRoot, detailRef, expected) {
  assert(typeof detailRef === "string" && detailRef.startsWith("sidecar-"), "Diagnostic lookup requires a sidecar detailRef.", { detailRef });
  const records = parseDiagnosticsLog(storeRoot);
  const entries = records.filter((record) => record.detailRef === detailRef);
  assert(entries.length > 0, "Diagnostic lookup by detailRef found no entries.", { detailRef, logPath: DIAGNOSTIC_RELATIVE_LOG_PATH });
  const match = assertDiagnosticEntry(entries, { ...expected, detailRef });
  return {
    found: true,
    detailRef,
    logPath: DIAGNOSTIC_RELATIVE_LOG_PATH,
    entries: entries.length,
    method: match.method,
    status: match.status,
    errorCode: match.errorCode,
  };
}

function assertPrivateStoreNoRuntime(storeRoot, profileId, { expectPrivateCredentials = false } = {}) {
  const path = join(storeRoot, "profile-store", "profiles.json");
  assert(existsSync(path), "profiles.json was not written.", { profileId });
  const payload = JSON.parse(readFileSync(path, "utf8"));
  assert(payload.storeVersion === 3, "S04 proxy check must use the store-v3 profile schema.", { storeVersion: payload.storeVersion });
  assert(Array.isArray(payload.profiles), "profiles.json profiles field must be an array.", { profileId });
  const profile = payload.profiles.find((item) => item?.id === profileId);
  assert(profile, "profiles.json does not contain the case profile.", { profileId });
  const runtimeFields = [];
  visit(profile, (_value, pathParts) => {
    const key = pathParts.at(-1);
    if (PRIVATE_STORE_RUNTIME_FIELDS.has(key)) {
      runtimeFields.push(pathParts.join("."));
    }
  });
  assert(runtimeFields.length === 0, "Private profile store persisted runtime/debug fields.", { profileId, runtimeFields });
  const hasPrivateCredentials = isPlainObject(profile.proxy?.credentials);
  assert(hasPrivateCredentials === expectPrivateCredentials, "Private store credential persistence state mismatch.", {
    profileId,
    expectedPrivateCredentials: expectPrivateCredentials,
    observedPrivateCredentials: hasPrivateCredentials,
  });
  return { storeVersion: payload.storeVersion, profileCount: payload.profiles.length, runtimeFields: 0, privateCredentials: hasPrivateCredentials ? "present-private-only" : "none" };
}

function visit(value, visitor, pathParts = []) {
  visitor(value, pathParts);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, visitor, [...pathParts, String(index)]));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      visit(nested, visitor, [...pathParts, key]);
    }
  }
}

async function createProfile(session, storeRoot, name) {
  const create = await sidecarSuccess(
    session,
    makeRequestId(`${safeLabel(name)}-create`),
    "profiles.create",
    { storeRoot, name },
  );
  assert(create.result.storeVersion === 3, "profiles.create did not return storeVersion 3.", { storeVersion: create.result.storeVersion });
  return assertProfileShape(create.result.profile, name);
}

async function applyRestrictedWebRtcPreset(session, storeRoot, profileId) {
  const applied = await sidecarSuccess(
    session,
    makeRequestId(`${profileId.slice(0, 8)}-preset`),
    "profiles.identity.applyPreset",
    { storeRoot, profileId, presetId: PRESET_ID },
  );
  assert(applied.result.storeVersion === 3, "profiles.identity.applyPreset did not return storeVersion 3.", { storeVersion: applied.result.storeVersion });
  assert(applied.result.profile?.identity?.presetId === PRESET_ID, "Restricted WebRTC preset was not applied.", { profileId });
  assert(applied.result.profile?.identity?.webrtc?.policy === "disableNonProxiedUdp", "Restricted WebRTC preset policy mismatch.", { profileId });
  return { presetId: PRESET_ID, policy: applied.result.profile.identity.webrtc.policy };
}

async function saveProxy(session, storeRoot, profileId, proxy) {
  const saved = await sidecarSuccess(
    session,
    makeRequestId(`${profileId.slice(0, 8)}-proxy-save`),
    "profiles.proxy.update",
    { storeRoot, profileId, proxy },
  );
  assert(saved.result.storeVersion === 3, "profiles.proxy.update did not return storeVersion 3.", { storeVersion: saved.result.storeVersion });
  assertPublicProxySummary(saved.result.profile?.proxy, proxy, "profiles.proxy.update.profile.proxy");
  return saved.result.profile.proxy;
}

async function assertPublicProfileSummary(session, storeRoot, profileId, expectedProxy) {
  const listed = await sidecarSuccess(
    session,
    makeRequestId(`${profileId.slice(0, 8)}-list`),
    "profiles.list",
    { storeRoot },
  );
  assert(listed.result.storeVersion === 3, "profiles.list did not return storeVersion 3.", { storeVersion: listed.result.storeVersion });
  const profile = listed.result.profiles?.find((item) => item?.id === profileId);
  assert(profile, "profiles.list did not include the case profile.", { profileId });
  assertPublicProxySummary(profile.proxy, expectedProxy, "profiles.list.profile.proxy");
  assertNoUnsafePublicPayload(profile, "profiles.list.profile");
  return { profileCount: listed.result.profiles.length, proxyMode: profile.proxy.mode, credentialState: profile.proxy.credentialState };
}

async function assertRuntimeRegistryEmpty(session, storeRoot, caseLabel) {
  const status = await sidecarSuccess(
    session,
    makeRequestId(`${safeLabel(caseLabel)}-chromium-status`),
    "chromium.status",
    { storeRoot },
  );
  assert(status.result.runningCount === 0, "Chromium runtime registry retained running profiles after proxy check.", { caseLabel, runningCount: status.result.runningCount });
  assert(Array.isArray(status.result.profiles) && status.result.profiles.length === 0, "Chromium status listed running profiles after proxy check.", { caseLabel, profiles: status.result.profiles });
  return { runningCount: status.result.runningCount, profiles: status.result.profiles.length };
}

async function runProxyCheckCase(session, caseConfig) {
  const storeRoot = makeTempRoot(`theprivator-s04-${safeLabel(caseConfig.label)}-`);
  const transcriptsBefore = SIDECAR_TRANSCRIPTS.length;
  try {
    emit({ phase: "case-start", caseLabel: caseConfig.label, proxyMode: caseConfig.proxy.mode, protocol: caseConfig.proxy.protocol ?? null, expectation: caseConfig.expectedRoute });
    const profile = await createProfile(session, storeRoot, `S04 ${caseConfig.label}`);
    let webRtcSetup = { policy: "real" };
    if (caseConfig.webRtc === "restricted") {
      webRtcSetup = await applyRestrictedWebRtcPreset(session, storeRoot, profile.id);
    }
    const publicProxy = await saveProxy(session, storeRoot, profile.id, caseConfig.proxy);
    const publicSummary = await assertPublicProfileSummary(session, storeRoot, profile.id, caseConfig.proxy);
    emit({ phase: "profile-configured", caseLabel: caseConfig.label, profileId: profile.id, proxy: publicProxy, webRtc: webRtcSetup, publicSummary });

    const checkRequestId = makeRequestId(`${caseConfig.label}-proxy-check`);
    const check = await sidecarSuccess(
      session,
      checkRequestId,
      "profiles.proxy.check",
      { storeRoot, profileId: profile.id },
      { timeoutMs: SIDECAR_TIMEOUT_MS },
    );
    const proof = assertProxyCheckResult(check.result, profile.id, caseConfig.proxy, caseConfig.webRtc === "restricted" ? "restricted" : "baseline-real");
    const diagnostics = parseDiagnosticsLog(storeRoot);
    const persisted = assertDiagnosticEntry(diagnostics, {
      requestId: checkRequestId,
      method: "profiles.proxy.check",
      status: "ok",
    });
    const privateStore = assertPrivateStoreNoRuntime(storeRoot, profile.id, { expectPrivateCredentials: expectedCredentialState(caseConfig.proxy) === "configured" });
    const runtime = await assertRuntimeRegistryEmpty(session, storeRoot, caseConfig.label);
    assertTranscriptRedaction(SIDECAR_TRANSCRIPTS.slice(transcriptsBefore));
    assertNoUnsafePublicPayload(PUBLIC_RESULTS.slice(-8), `${caseConfig.label}.public-results`);

    const removedBefore = existsSync(storeRoot);
    rmSync(storeRoot, { recursive: true, force: true });
    const cleanup = { storeRemoved: removedBefore && !existsSync(storeRoot), runtime };
    emit({ phase: "route-proof", caseLabel: caseConfig.label, status: "pass", protocol: caseConfig.proxy.protocol ?? null, ...proof, observations: check.result.routeProof.observationCounts });
    emit({ phase: "webrtc-classification", caseLabel: caseConfig.label, status: "pass", webRtc: check.result.webRtc });
    emit({ phase: "public-checker-advisory", caseLabel: caseConfig.label, status: "pass", pageCount: check.result.publicCheckers.pages.length, networkDependency: check.result.publicCheckers.networkDependency });
    emit({ phase: "diagnostics", caseLabel: caseConfig.label, status: "pass", requestId: checkRequestId, method: persisted.method, diagnosticStatus: persisted.status, detailRef: persisted.detailRef });
    emit({ phase: "cleanup", caseLabel: caseConfig.label, status: "pass", ...cleanup });
    emit({ phase: "case-result", caseLabel: caseConfig.label, status: "pass", profileId: profile.id, proof, privateStore });
    return { caseLabel: caseConfig.label, proof, privateStore };
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

// SOCKS5 credentials used to be rejected outright. They are now carried by the
// local SOCKS5 auth bridge (theprivator_sidecar/proxy_bridge.py), because Chromium
// cannot send SOCKS5 username/password upstream itself. SOCKS4 has no credential
// mechanism at all, so it is the protocol that still fails closed -- and keeping
// this case pointed at it preserves the coverage rather than deleting it.
async function runSocksCredentialFailure(session) {
  const caseLabel = "socks4-auth-unsupported";
  const storeRoot = makeTempRoot(`theprivator-s04-${caseLabel}-`);
  const transcriptsBefore = SIDECAR_TRANSCRIPTS.length;
  try {
    emit({ phase: "case-start", caseLabel, proxyMode: "fixedServer", protocol: "socks4", expectation: "typed-error" });
    const profile = await createProfile(session, storeRoot, "S04 SOCKS auth unsupported");
    const proxy = {
      proxyVersion: 1,
      mode: "fixedServer",
      protocol: "socks4",
      host: "proxy.s04-socks-auth.invalid",
      port: 19051,
      credentials: { username: PROXY_USERNAME, password: PROXY_PASSWORD },
    };
    await saveProxy(session, storeRoot, profile.id, proxy);
    await assertPublicProfileSummary(session, storeRoot, profile.id, proxy);
    const checkRequestId = makeRequestId(`${caseLabel}-proxy-check`);
    const failed = await sidecarError(
      session,
      checkRequestId,
      "profiles.proxy.check",
      { storeRoot, profileId: profile.id },
      { timeoutMs: SIDECAR_TIMEOUT_MS },
    );
    assert(failed.error.code === "PROXY_SOCKS_AUTH_UNSUPPORTED", "SOCKS credential check did not fail with the typed proxy runtime error.", { errorCode: failed.error.code, detailRef: failed.error.detailRef });
    const lookup = assertDiagnosticLookup(storeRoot, failed.error.detailRef, {
      requestId: checkRequestId,
      method: "profiles.proxy.check",
      status: "error",
      errorCode: "PROXY_SOCKS_AUTH_UNSUPPORTED",
    });
    const privateStore = assertPrivateStoreNoRuntime(storeRoot, profile.id, { expectPrivateCredentials: true });
    const runtime = await assertRuntimeRegistryEmpty(session, storeRoot, caseLabel);
    assertTranscriptRedaction(SIDECAR_TRANSCRIPTS.slice(transcriptsBefore));
    emit({ phase: "typed-negative", caseLabel, status: "pass", errorCode: failed.error.code, detailRef: failed.error.detailRef, diagnostics: lookup, runtime, privateStore });
    return { caseLabel, errorCode: failed.error.code, detailRef: failed.error.detailRef };
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

async function runUnknownProfileFailure(session) {
  const caseLabel = "unknown-profile-check";
  const storeRoot = makeTempRoot(`theprivator-s04-${caseLabel}-`);
  const transcriptsBefore = SIDECAR_TRANSCRIPTS.length;
  try {
    emit({ phase: "case-start", caseLabel, expectation: "typed-error" });
    const missingProfileId = "00000000-0000-4000-8000-000000000404";
    const checkRequestId = makeRequestId(`${caseLabel}-proxy-check`);
    const failed = await sidecarError(
      session,
      checkRequestId,
      "profiles.proxy.check",
      { storeRoot, profileId: missingProfileId },
      { timeoutMs: SIDECAR_TIMEOUT_MS },
    );
    assert(failed.error.code === "PROFILE_NOT_FOUND", "Unknown profile check did not fail with PROFILE_NOT_FOUND.", { errorCode: failed.error.code, detailRef: failed.error.detailRef });
    const lookup = assertDiagnosticLookup(storeRoot, failed.error.detailRef, {
      requestId: checkRequestId,
      method: "profiles.proxy.check",
      status: "error",
      errorCode: "PROFILE_NOT_FOUND",
    });
    const runtime = await assertRuntimeRegistryEmpty(session, storeRoot, caseLabel);
    assertTranscriptRedaction(SIDECAR_TRANSCRIPTS.slice(transcriptsBefore));
    emit({ phase: "malformed-input-negative", caseLabel, status: "pass", errorCode: failed.error.code, detailRef: failed.error.detailRef, diagnostics: lookup, runtime });
    return { caseLabel, errorCode: failed.error.code, detailRef: failed.error.detailRef };
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

function assertNoUnsafeText(value, surface) {
  const text = String(value ?? "");
  for (const sensitive of SENSITIVE_VALUES) {
    if (typeof sensitive === "string" && sensitive) {
      assert(!text.includes(sensitive), "Public verifier surface leaked a sensitive value.", { surface });
    }
  }
  for (const marker of PUBLIC_FORBIDDEN_TEXT) {
    assert(!text.includes(marker), "Public verifier surface leaked a forbidden runtime/debug marker.", { surface, marker });
  }
}

function assertNoUnsafePublicPayload(value, surface) {
  visit(value, (nested, pathParts) => {
    const key = pathParts.at(-1) ?? surface;
    assert(!SECRET_KEY_RE.test(key), "Public payload leaked a credential-bearing key.", { surface, path: pathParts.join(".") });
    if (typeof nested === "string") {
      assertNoUnsafeText(nested, `${surface}.${pathParts.join(".")}`);
      assert(!/[\u0000-\u001f\u007f]/.test(nested), "Public payload leaked control characters.", { surface, path: pathParts.join(".") });
    }
    assert(key !== "rawTranscript" && key !== "responseBody" && key !== "html" && key !== "content", "Public checker payload included raw external content.", { surface, path: pathParts.join(".") });
  });
}

function assertTranscriptRedaction(transcripts) {
  for (const [index, transcript] of transcripts.entries()) {
    assertNoUnsafeText(transcript.stdout, `sidecar-transcript[${index}].stdout`);
    assertNoUnsafeText(transcript.stderr, `sidecar-transcript[${index}].stderr`);
    assertNoUnsafePublicPayload({ response: transcript.response, diagnostics: transcript.diagnostics }, `sidecar-transcript[${index}]`);
  }
}

function assertVerifierEventsRedacted() {
  assertNoUnsafePublicPayload(VERIFIER_EVENTS, "verify.s04.events");
  assertNoUnsafeText(JSON.stringify(VERIFIER_EVENTS), "verify.s04.events-json");
}

function assertStaticNoPublicCheckerScraping() {
  // The UI half is discovered rather than listed, so the rule keeps applying once
  // src/App.tsx is split into components. See scripts/ui-sources.mjs.
  const sources = [
    { path: "theprivator_sidecar/proxy_check.py", text: readFileSync(join(ROOT_DIR, "theprivator_sidecar", "proxy_check.py"), "utf8") },
    ...readUiSources(ROOT_DIR).files,
  ];
  assert(sources.length > 1, "Proxy-check static scan found no UI sources under src/.");
  const forbiddenSourcePatterns = [
    /checkerBody/i,
    /fetch\s*\(\s*["']https:\/\//i,
    /XMLHttpRequest\s*\(/,
    /urllib\.request/i,
    /urlopen\s*\(/i,
    /requests\.get\s*\(/i,
  ];
  const findings = [];
  for (const { path: source, text } of sources) {
    assert(!text.includes(PROXY_USERNAME) && !text.includes(PROXY_PASSWORD), "Static source leaked verifier credential sentinels.", { source });
    const scannable = withoutAuditedPublicExitLookup(source, text);
    for (const pattern of forbiddenSourcePatterns) {
      if (pattern.test(scannable)) {
        findings.push({ source, pattern: String(pattern) });
      }
    }
  }
  assert(findings.length === 0, "Static proxy-check surfaces appear to scrape public checker content.", { findings });
  return { sources: sources.length, forbiddenFindings: 0, auditedPublicExitLookup: assertAuditedPublicExitLookupShape() };
}

/**
 * The proxy check makes exactly one outbound request: an advisory IP-metadata
 * lookup through the user's own proxy, used to report the exit IP and location.
 * That is a different thing from scraping a public checker page, which is what
 * this guardrail exists to prevent -- so the one audited call is excised before
 * the generic patterns run, and its shape is asserted separately below. Nothing
 * else in the file gets to make an outbound request.
 */
function withoutAuditedPublicExitLookup(source, text) {
  if (source !== "theprivator_sidecar/proxy_check.py") return text;
  return text.replace(AUDITED_PUBLIC_EXIT_LOOKUP_CALL, "");
}

const AUDITED_PUBLIC_EXIT_LOOKUP_CALL = /requests\.get\(\s*_PUBLIC_EXIT_LOOKUP_URL,\s*proxies=\{"http": proxy_url\},\s*timeout=PROXY_CHECK_TIMEOUT_SECONDS,\s*\)/;

function assertAuditedPublicExitLookupShape() {
  const text = readFileSync(join(ROOT_DIR, "theprivator_sidecar", "proxy_check.py"), "utf8");
  const callCount = (text.match(/requests\.get\s*\(/g) ?? []).length;
  assert(callCount === 1, "Proxy check must make exactly one outbound request.", { callCount });
  assert(AUDITED_PUBLIC_EXIT_LOOKUP_CALL.test(text), "The proxy check public exit lookup must keep its audited fixed-URL, proxied, timeout-bounded shape.");
  assert(text.includes('_PUBLIC_EXIT_LOOKUP_HOST = "ip-api.com"'), "The proxy check public exit lookup host must stay fixed.");
  // The advisory checker catalog is data the UI links to, never something the
  // sidecar fetches: none of those hosts may appear in the lookup URL.
  assert(!/_PUBLIC_EXIT_LOOKUP_URL\s*=.*(browserleaks|pixelscan|browserscan|amiunique|coveryourtracks)/i.test(text),
    "The proxy check public exit lookup must not point at a public checker.");
  return "fixed-ip-metadata-endpoint";
}

function assertProofShapeGuardStatic() {
  const text = readFileSync(join(ROOT_DIR, "theprivator_sidecar", "proxy_check.py"), "utf8");
  assert(text.includes("_validated_proof_summary"), "Proxy check proof-shape validator is missing.");
  assert(text.includes("frozenset(proof.keys()) - _ALLOWED_PROOF_KEYS"), "Proxy check no-extra-proof-keys guard is missing.");
  assert(text.includes("required <= frozenset(proof.keys())"), "Proxy check required-proof-keys guard is missing.");
  assert(text.includes("PROXY_PROOF_FAILED"), "Proxy check malformed proof failure must use a typed PROXY_* error.");
  return { validator: "_validated_proof_summary", errorCode: "PROXY_PROOF_FAILED" };
}

function assertMalformedProtocolGuard() {
  let rejected = false;
  try {
    parseJsonLine("sidecar stdout", "not json", { method: "profiles.proxy.check", requestId: "verify-s04-malformed-protocol" });
  } catch (error) {
    rejected = error instanceof VerifyFailure && error.message.includes("malformed NDJSON");
    assertNoUnsafePublicPayload(error.details, "malformed-protocol-error-details");
  }
  assert(rejected, "Verifier protocol guard did not reject malformed sidecar NDJSON.");
  return { malformedResponseRejected: true };
}

async function runHealthCheck(session) {
  const health = await sidecarSuccess(session, makeRequestId("health"), "health.status", {});
  assert(["healthy", "degraded"].includes(health.result.status), "Health status is invalid.", { status: health.result.status });
  assert(health.result.build?.mode === "pyinstaller", "verify:s04 must exercise the built sidecar binary.", { buildMode: health.result.build?.mode });
  return { status: health.result.status, buildMode: health.result.build.mode, sidecarVersion: health.result.sidecar?.version };
}

async function main() {
  const targetTriple = await runStep("target-triple", () => {
    const value = readTargetTriple();
    assert(value, "rustc did not return a host target triple.");
    return { value, log: { targetTriple: value } };
  });
  const binaryPath = targetBinaryPath(targetTriple);
  await runStep("target-binary", () => assertTargetBinary(binaryPath, targetTriple));

  const session = new SidecarSession(binaryPath);
  try {
    await runStep("built-sidecar-health", () => runHealthCheck(session));
    await runStep("protocol-malformed-response-guard", () => assertMalformedProtocolGuard());
    await runStep("proof-shape-guard-static", () => assertProofShapeGuardStatic());

    const cases = [
      {
        label: "direct-not-proven-baseline",
        proxy: { proxyVersion: 1, mode: "direct" },
        expectedRoute: "not-run",
        webRtc: "baseline-real",
      },
      {
        label: "http-no-auth-route-proof",
        proxy: { proxyVersion: 1, mode: "fixedServer", protocol: "http", host: "proxy.s04-http.invalid", port: 18080 },
        expectedRoute: "proved",
        webRtc: "baseline-real",
      },
      {
        label: "http-auth-restricted-webrtc",
        proxy: {
          proxyVersion: 1,
          mode: "fixedServer",
          protocol: "http",
          host: "proxy.s04-http-auth.invalid",
          port: 18081,
          credentials: { username: PROXY_USERNAME, password: PROXY_PASSWORD },
        },
        expectedRoute: "proved",
        webRtc: "restricted",
      },
      {
        label: "https-auth-route-proof",
        proxy: {
          proxyVersion: 1,
          mode: "fixedServer",
          protocol: "https",
          host: "proxy.s04-https-auth.invalid",
          port: 18443,
          credentials: { username: PROXY_USERNAME, password: PROXY_PASSWORD },
        },
        expectedRoute: "proved",
        webRtc: "baseline-real",
      },
      {
        label: "socks5-route-proof",
        proxy: { proxyVersion: 1, mode: "fixedServer", protocol: "socks5", host: "proxy.s04-socks5.invalid", port: 19050 },
        expectedRoute: "proved",
        webRtc: "baseline-real",
      },
      {
        label: "socks4-test-net-route-proof",
        proxy: { proxyVersion: 1, mode: "fixedServer", protocol: "socks4", host: "198.51.100.10", port: 19040 },
        expectedRoute: "proved",
        webRtc: "baseline-real",
      },
    ];

    const caseResults = [];
    for (const testCase of cases) {
      caseResults.push(await runStep(`proxy-check-${safeLabel(testCase.label)}`, () => runProxyCheckCase(session, testCase)));
    }

    const negativeResults = [];
    negativeResults.push(await runStep("negative-socks-auth-unsupported", () => runSocksCredentialFailure(session)));
    negativeResults.push(await runStep("negative-unknown-profile", () => runUnknownProfileFailure(session)));

    await runStep("no-public-checker-scraping", () => assertStaticNoPublicCheckerScraping());
    await runStep("redaction-sweep", () => {
      assertTranscriptRedaction(SIDECAR_TRANSCRIPTS);
      assertVerifierEventsRedacted();
      assertNoUnsafePublicPayload(PUBLIC_RESULTS, "public-command-results");
      return { transcriptCount: SIDECAR_TRANSCRIPTS.length, verifierEvents: VERIFIER_EVENTS.length, publicResults: PUBLIC_RESULTS.length, forbiddenMarkers: 0 };
    });

    emit({
      status: "pass",
      phase: "summary",
      routeProofCases: caseResults.length,
      negativeCases: negativeResults.length,
      checks: STEP_RESULTS,
    });
  } finally {
    await session.close();
  }
}

try {
  await main();
} catch (error) {
  emit({ status: "fail", message: error instanceof Error ? error.message : String(error), checks: STEP_RESULTS });
  process.exit(1);
}
