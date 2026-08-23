import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENV_PYTHON = process.platform === "win32"
  ? join(ROOT_DIR, ".venv", "Scripts", "python.exe")
  : join(ROOT_DIR, ".venv", "bin", "python");
const PYTHON = process.env.PYTHON ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : (process.platform === "win32" ? "python" : "python3"));
const PYTHON_LABEL = "python";
const SIDECAR_MODULE_LABEL = `${PYTHON_LABEL} -m theprivator_sidecar`;
const SIDECAR_TIMEOUT_MS = 15_000;
const SIDECAR_STOP_TIMEOUT_MS = 2_000;
const SMOKE_PROFILE_NAME = "S03 Proxy Config Profile";
const HTTP_PROXY_USERNAME = "proxy-s03-http-user-sentinel";
const HTTP_PROXY_PASSWORD = "proxy-s03-http-password-sentinel";
const BAD_PROXY_USERNAME = "proxy-s03-bad-user-sentinel";
const BAD_PROXY_PASSWORD = "proxy-s03-bad-password-sentinel";
const STEP_RESULTS = [];
const PUBLIC_EVENTS = [];
const SIDECAR_TRANSCRIPTS = [];
const SENSITIVE_VALUES = new Set([
  ROOT_DIR,
  HTTP_PROXY_USERNAME,
  HTTP_PROXY_PASSWORD,
  BAD_PROXY_USERNAME,
  BAD_PROXY_PASSWORD,
]);
const DANGEROUS_VALUE_KEY_RE = /^(?:auth|authorization|credentials?|password|proxyauthorization|proxypass|proxypassword|proxyuser|proxyusername|username)$/i;
const PUBLIC_SECRET_KEY_RE = /^(?:credentials?|password|proxyAuthorization|proxyPassword|proxyPass|proxyUser|proxyUsername|username)$/i;
const FORBIDDEN_DURABLE_KEYS = new Set([
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
const FORBIDDEN_TEXT_MARKERS = [
  /Proxy-Authorization/i,
  /--proxy-server/i,
  /--load-extension/i,
  /--disable-extensions-except/i,
  /--remote-debugging-port/i,
  /--user-data-dir/i,
  /DevToolsActivePort/i,
  /Traceback \(most recent call last\)/i,
  /\bWebSocket\b/i,
  /\bws:\/\//i,
  /\bwss:\/\//i,
  /profile-store[\\/]+runtime/i,
  /runtime-registry/i,
  /identity-extensions/i,
  /proxy-auth-extensions/i,
];
const DIAGNOSTIC_RELATIVE_LOG_PATH = "profile-store/diagnostics/events.jsonl";

class VerifyFailure extends Error {
  constructor(message, details) {
    super(message);
    this.name = "VerifyFailure";
    this.details = details;
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
      waiter.reject(error ?? new Error(`${this.streamName} ended before the source sidecar emitted the expected NDJSON line.`));
    }
  }

  next(timeoutMs, onTimeout) {
    if (this.lines.length > 0) {
      return Promise.resolve(this.lines.shift());
    }
    if (this.ended) {
      return Promise.reject(new Error(`${this.streamName} ended before the source sidecar emitted the expected NDJSON line.`));
    }

    return new Promise((resolveLine, rejectLine) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        onTimeout();
        rejectLine(new Error(`${this.streamName} timed out waiting for source sidecar NDJSON.`));
      }, timeoutMs);
      this.waiters.push({ resolve: resolveLine, reject: rejectLine, timer });
    });
  }

  tail() {
    return normalizeOutput(this.tailLines.join("\n"));
  }
}

function emit(event) {
  const payload = redact({ event: "verify.s03", ...event });
  PUBLIC_EVENTS.push(payload);
  console.log(JSON.stringify(payload));
}

function rememberSensitive(value) {
  if (typeof value === "string" && value.trim()) {
    SENSITIVE_VALUES.add(value);
  }
}

function activeSensitiveValues(extra = []) {
  return [...SENSITIVE_VALUES, ...extra].filter((value) => typeof value === "string" && value.length > 0);
}

function redactText(value, extra = []) {
  let redacted = String(value ?? "");
  for (const sensitive of activeSensitiveValues(extra).sort((a, b) => b.length - a.length)) {
    if (!sensitive) {
      continue;
    }
    const replacement = sensitive === ROOT_DIR
      ? "<repo>"
      : sensitive.includes("theprivator-s03-proxy-")
        ? "<temp-root>"
        : "<redacted>";
    redacted = redacted.split(sensitive).join(replacement);
  }
  return redacted
    .replace(/ws:\/\/[^\s"']+/gi, "ws://<redacted>")
    .replace(/wss:\/\/[^\s"']+/gi, "wss://<redacted>")
    .replace(/--remote-debugging-port(?:=|\s+)\d+/gi, "--remote-debugging-port=<redacted>")
    .replace(/debugPort["':\s=]+\d+/gi, "debugPort=<redacted>");
}

function redact(value, extra = []) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactText(value, extra);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, extra));
  }

  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (DANGEROUS_VALUE_KEY_RE.test(key)) {
        return ["<redacted-key>", "<redacted>"];
      }
      return [redactText(key, extra), redact(item, extra)];
    }));
  }

  return value;
}

function normalizeOutput(value, extra = []) {
  if (!value) {
    return "";
  }

  return redactText(value, extra)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-10)
    .join("\n");
}

function fail(message, details) {
  throw new VerifyFailure(message, redact(details));
}

function assert(condition, message, details) {
  if (!condition) {
    fail(message, details);
  }
}

async function runStep(name, action) {
  const started = performance.now();
  try {
    const result = (await action()) ?? {};
    const durationMs = Math.round(performance.now() - started);
    const logResult = result.log ?? result;
    const returnResult = result.value ?? result;
    const record = { name, ...redact(logResult), status: "pass", durationMs };
    STEP_RESULTS.push(record);
    emit({ step: name, ...redact(logResult), status: "pass", durationMs });
    return returnResult;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    const record = { name, status: "fail", durationMs, message: redactText(message) };
    STEP_RESULTS.push(record);
    emit({ step: name, status: "fail", durationMs, message: redactText(message) });
    if (error?.details) {
      emit({ step: name, status: "fail-details", details: redact(error.details) });
    }
    throw error;
  }
}

function makeTempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  rememberSensitive(root);
  rememberSensitive(join(root, "profile-store"));
  rememberSensitive(join(root, "profile-store", "profiles.json"));
  rememberSensitive(join(root, "profile-store", "diagnostics", "events.jsonl"));
  return root;
}

function makeRequestId(label) {
  return `verify-s03-${label}`.slice(0, 120);
}

function sidecarRequest(id, method, params) {
  return { id, method, params };
}

function executable(command) {
  return process.platform === "win32" && basename(command) === command && !command.endsWith(".exe")
    ? `${command}.exe`
    : command;
}

function startSourceSidecar() {
  const child = spawn(executable(PYTHON), ["-m", "theprivator_sidecar"], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = new LineReader(child.stdout, "stdout");
  const stderr = new LineReader(child.stderr, "stderr");
  let spawnError = null;
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  let stopRequested = false;

  child.on("error", (error) => {
    spawnError = error;
  });
  const exitPromise = new Promise((resolveExit) => {
    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      resolveExit({ code, signal });
    });
  });

  const killForTimeout = () => {
    if (!exited) {
      child.kill("SIGKILL");
    }
  };

  async function request(requestPayload, options = {}) {
    const timeoutMs = options.timeoutMs ?? SIDECAR_TIMEOUT_MS;
    if (spawnError) {
      fail("Failed to start the source sidecar process.", {
        process: SIDECAR_MODULE_LABEL,
        error: spawnError.message,
      });
    }
    if (exited) {
      fail("Source sidecar exited before the verifier request completed.", {
        process: SIDECAR_MODULE_LABEL,
        exitCode,
        exitSignal,
        method: requestPayload.method,
        stdoutTail: stdout.tail(),
        stderrTail: stderr.tail(),
      });
    }

    try {
      child.stdin.write(`${JSON.stringify(requestPayload)}\n`);
    } catch (error) {
      fail("Failed to send a verifier request to the source sidecar.", {
        process: SIDECAR_MODULE_LABEL,
        method: requestPayload.method,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const [stdoutLine, stderrLine] = await Promise.all([
        stdout.next(timeoutMs, killForTimeout),
        stderr.next(timeoutMs, killForTimeout),
      ]);
      assertNoPublicLeaks(`source sidecar ${requestPayload.method} stdout`, stdoutLine);
      assertNoPublicLeaks(`source sidecar ${requestPayload.method} stderr`, stderrLine);
      const response = parseNdjsonLine("stdout", stdoutLine, requestPayload.method);
      const diagnostic = parseNdjsonLine("stderr", stderrLine, requestPayload.method);
      SIDECAR_TRANSCRIPTS.push({
        requestId: requestPayload.id,
        method: requestPayload.method,
        stdoutLine,
        stderrLine,
        response,
        diagnostic,
      });
      return { response, diagnostic };
    } catch (error) {
      if (error instanceof VerifyFailure) {
        throw error;
      }
      fail(`${SIDECAR_MODULE_LABEL} failed to complete verifier step ${requestPayload.method}.`, {
        method: requestPayload.method,
        timeoutMs,
        stdoutTail: stdout.tail(),
        stderrTail: stderr.tail(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function stop() {
    stopRequested = true;
    if (exited) {
      assert(exitCode === 0, "Source sidecar exited non-zero before verifier shutdown.", {
        exitCode,
        exitSignal,
        stdoutTail: stdout.tail(),
        stderrTail: stderr.tail(),
      });
      return { exitCode, exitSignal: exitSignal ?? "none" };
    }

    child.stdin.end();
    let shutdownTimer;
    const timeout = new Promise((_, reject) => {
      shutdownTimer = setTimeout(() => reject(new Error("source sidecar shutdown timed out")), SIDECAR_STOP_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([exitPromise, timeout]);
      clearTimeout(shutdownTimer);
      assert(result.code === 0, "Source sidecar exited non-zero during verifier shutdown.", {
        exitCode: result.code,
        exitSignal: result.signal,
        stdoutTail: stdout.tail(),
        stderrTail: stderr.tail(),
      });
      return { exitCode: result.code, exitSignal: result.signal ?? "none" };
    } catch (error) {
      clearTimeout(shutdownTimer);
      if (!exited) {
        child.kill("SIGKILL");
      }
      fail("Source sidecar did not shut down cleanly after verifier completion.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function cleanup() {
    if (!stopRequested && !exited) {
      child.kill("SIGKILL");
      await Promise.race([
        exitPromise,
        new Promise((resolveCleanup) => setTimeout(resolveCleanup, SIDECAR_STOP_TIMEOUT_MS)),
      ]);
    }
  }

  return { request, stop, cleanup };
}

function parseNdjsonLine(streamName, line, method) {
  try {
    return JSON.parse(line);
  } catch (error) {
    fail(`${streamName} emitted malformed NDJSON for verifier step ${method}.`, {
      streamName,
      method,
      lineTail: normalizeOutput(line),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function callSidecar(client, requestPayload, options = {}) {
  const { response, diagnostic } = await client.request(requestPayload, options);

  assertPublicPayloadSafe(response, `sidecar ${requestPayload.method} response`);
  assertPublicPayloadSafe(diagnostic, `sidecar ${requestPayload.method} diagnostic`);
  assert(diagnostic.event === "sidecar.request", "Sidecar diagnostic event name changed.", {
    method: requestPayload.method,
    diagnosticEvent: diagnostic.event,
  });
  assert(diagnostic.method === requestPayload.method, "Sidecar diagnostic method did not match the request.", {
    method: requestPayload.method,
    diagnosticMethod: diagnostic.method,
  });
  assert(diagnostic.requestId === requestPayload.id, "Sidecar diagnostic request id did not match the request.", {
    requestId: requestPayload.id,
    diagnosticRequestId: diagnostic.requestId,
  });
  assert(!("params" in diagnostic), "Sidecar diagnostic leaked request params.", { method: requestPayload.method });
  assert(!("storeRoot" in diagnostic), "Sidecar diagnostic leaked store root.", { method: requestPayload.method });

  return { response, diagnostic };
}

async function sidecarSuccess(client, id, method, params, options = {}) {
  const transcript = await callSidecar(client, sidecarRequest(id, method, params), options);
  const { response, diagnostic } = transcript;
  assert(response.id === id, "Sidecar response id did not match the request.", {
    method,
    requestId: id,
    responseId: response.id,
  });
  assert(response.ok === true, `Expected ${method} to succeed.`, {
    method,
    errorCode: response.error?.code,
    detailRef: response.error?.detailRef,
    message: response.error?.message,
  });
  assert(diagnostic.status === "ok", "Sidecar diagnostic did not report ok status.", {
    method,
    status: diagnostic.status,
    errorCode: diagnostic.errorCode,
    detailRef: diagnostic.detailRef,
  });
  assert(diagnostic.errorCode === null, "Successful diagnostic should not include an error code.", {
    method,
    errorCode: diagnostic.errorCode,
  });
  assert(diagnostic.detailRef === null, "Successful diagnostic should not include a detailRef.", {
    method,
    detailRef: diagnostic.detailRef,
  });
  assert(response.result && typeof response.result === "object" && !Array.isArray(response.result), "Success response result must be an object.", { method });
  return { ...transcript, result: response.result };
}

async function sidecarError(client, id, method, params, options = {}) {
  const transcript = await callSidecar(client, sidecarRequest(id, method, params), options);
  const { response, diagnostic } = transcript;
  assert(response.id === id, "Sidecar error response id did not match the request.", {
    method,
    requestId: id,
    responseId: response.id,
  });
  assert(response.ok === false, `Expected ${method} to fail safely.`, {
    method,
    result: response.result,
  });
  assert(response.error && typeof response.error === "object", "Sidecar error response is missing error.", { method });
  assert(diagnostic.status === "error", "Sidecar diagnostic did not report error status.", {
    method,
    status: diagnostic.status,
  });
  assert(diagnostic.errorCode === response.error.code, "Diagnostic errorCode did not match response error code.", {
    method,
    responseCode: response.error.code,
    diagnosticCode: diagnostic.errorCode,
  });
  assert(diagnostic.detailRef === response.error.detailRef, "Diagnostic detailRef did not match response error detailRef.", {
    method,
    responseDetailRef: response.error.detailRef,
    diagnosticDetailRef: diagnostic.detailRef,
  });
  assert(typeof response.error.detailRef === "string" && response.error.detailRef.startsWith("sidecar-"), "Sidecar error did not include an opaque detailRef.", {
    method,
    detailRef: response.error.detailRef,
  });
  assert(response.error.recoverable === true, "Proxy verifier expected a recoverable typed sidecar error.", {
    method,
    recoverable: response.error.recoverable,
  });
  return { ...transcript, error: response.error };
}

function isSafeRelativeStoragePath(value) {
  return typeof value === "string"
    && value.startsWith("profile-store/profiles/")
    && value.endsWith("/user-data")
    && !value.startsWith("/")
    && !value.includes("..");
}

function assertProfileShape(profile, expectedName = SMOKE_PROFILE_NAME) {
  assert(profile && typeof profile === "object" && !Array.isArray(profile), "Profile payload is missing.");
  assert(typeof profile.id === "string" && profile.id.length > 0, "Profile is missing id.");
  assert(profile.name === expectedName, "Profile name mismatch.", { profileName: profile.name });
  assert(profile.storage && typeof profile.storage === "object", "Profile is missing storage metadata.");
  assert(isSafeRelativeStoragePath(profile.storage.userDataDir), "Profile userDataDir is not a safe relative path.", {
    userDataDir: profile.storage.userDataDir,
  });
  assert(profile.identity && typeof profile.identity === "object" && !Array.isArray(profile.identity), "Profile is missing identity.");
  assert(profile.identity.identityVersion === 2, "Profile identity version mismatch.", {
    identityVersion: profile.identity.identityVersion,
  });
  assertPublicPayloadSafe(profile, "public profile payload");
  return profile;
}

function assertCollectionShape(result, expectedProfileId) {
  assert(result.storeVersion === 4, "Profile collection must use storeVersion 4.", { storeVersion: result.storeVersion });
  assert(Array.isArray(result.profiles), "Profile collection profiles field is not an array.");
  assert(result.count === result.profiles.length, "Profile collection count mismatch.", {
    count: result.count,
    profileCount: result.profiles.length,
  });
  const profile = result.profiles.find((item) => item?.id === expectedProfileId);
  assert(profile, "Profile collection did not include the smoke profile.", { expectedProfileId });
  return assertProfileShape(profile);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function deepEqualJson(left, right) {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function expectedSummary(proxy) {
  if (proxy.mode === "direct") {
    return {
      proxyVersion: 1,
      mode: "direct",
      credentialState: "none",
      summary: "Direct connection",
    };
  }
  return {
    proxyVersion: 1,
    mode: "fixedServer",
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    credentialState: proxy.credentials ? "configured" : "none",
    summary: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
  };
}

function assertPublicProxySummary(proxy, expected) {
  assert(proxy && typeof proxy === "object" && !Array.isArray(proxy), "Proxy summary is missing.");
  assert(proxy.proxyVersion === 1, "Proxy summary did not report proxyVersion 1.", { proxyVersion: proxy.proxyVersion });
  assert(proxy.mode === expected.mode, "Proxy summary mode mismatch.", { mode: proxy.mode, expectedMode: expected.mode });
  assert(proxy.credentialState === expected.credentialState, "Proxy summary credential state mismatch.", {
    credentialState: proxy.credentialState,
    expectedCredentialState: expected.credentialState,
  });
  assert(proxy.summary === expected.summary, "Proxy summary text mismatch.", {
    summary: proxy.summary,
    expectedSummary: expected.summary,
  });
  if (expected.mode === "fixedServer") {
    assert(proxy.protocol === expected.protocol, "Proxy summary protocol mismatch.", { protocol: proxy.protocol, expectedProtocol: expected.protocol });
    assert(proxy.host === expected.host, "Proxy summary host mismatch.", { host: proxy.host, expectedHost: expected.host });
    assert(proxy.port === expected.port, "Proxy summary port mismatch.", { port: proxy.port, expectedPort: expected.port });
  }
  assertPublicPayloadSafe(proxy, "public proxy summary");
  return proxy;
}

function assertProxyValidationResult(result, expected) {
  assert(result.proxyVersion === 1, "Proxy validation result did not report proxyVersion 1.", { proxyVersion: result.proxyVersion });
  assert(Array.isArray(result.warnings) && result.warnings.length === 0, "Proxy validation returned unexpected warnings.", {
    warningCount: Array.isArray(result.warnings) ? result.warnings.length : "not-array",
  });
  assertPublicProxySummary(result.proxy, expected);
  return result.proxy;
}

function assertProxyMutationResult(result, profileId, expected) {
  assert(result.storeVersion === 4, "Proxy update did not preserve store v4.", { storeVersion: result.storeVersion });
  assert(Array.isArray(result.profiles), "Proxy update did not return a profiles array.");
  assert(result.profile?.id === profileId, "Proxy update returned the wrong profile id.", {
    profileId: result.profile?.id,
    expectedProfileId: profileId,
  });
  assertPublicProxySummary(result.profile.proxy, expected);
  const listed = result.profiles.find((item) => item?.id === profileId);
  assert(listed, "Proxy update result did not include the updated profile in the list.", { profileId });
  assertPublicProxySummary(listed.proxy, expected);
  return result.profile;
}

function readProfilesJson(storeRoot) {
  const profilesPath = join(storeRoot, "profile-store", "profiles.json");
  rememberSensitive(profilesPath);
  assert(existsSync(profilesPath), "profiles.json was not written for the proxy verifier.");
  const text = readFileSync(profilesPath, "utf8");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    fail("profiles.json is not valid JSON.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { path: profilesPath, text, payload };
}

function findPrivateProfile(storeRoot, profileId) {
  const { text, payload } = readProfilesJson(storeRoot);
  assert(payload.storeVersion === 4, "profiles.json must remain a v4 profile-store payload.", {
    storeVersion: payload.storeVersion,
  });
  assert(Array.isArray(payload.profiles), "profiles.json profiles field is not an array.");
  const profile = payload.profiles.find((item) => item?.id === profileId);
  assert(profile, "profiles.json does not contain the smoke profile.", { profileId });
  assertNoPrivateRuntimeLeaks(text, payload);
  return { text, payload, profile };
}

function assertPrivateProxy(storeRoot, profileId, expectedPrivateProxy) {
  const { payload, profile } = findPrivateProfile(storeRoot, profileId);
  assert(deepEqualJson(profile.proxy, expectedPrivateProxy), "Persisted private proxy did not match the expected canonical shape.", {
    expectedMode: expectedPrivateProxy.mode,
    actualMode: profile.proxy?.mode,
    expectedProtocol: expectedPrivateProxy.protocol ?? "none",
    actualProtocol: profile.proxy?.protocol ?? "none",
    expectedCredentialState: expectedPrivateProxy.credentials ? "private" : "none",
    actualCredentialState: profile.proxy?.credentials ? "private" : "none",
  });
  return {
    storeVersion: payload.storeVersion,
    profileCount: payload.profiles.length,
    credentialState: expectedPrivateProxy.credentials ? "private" : "none",
  };
}

function diagnosticLogPath(storeRoot) {
  return join(storeRoot, "profile-store", "diagnostics", "events.jsonl");
}

function readDiagnosticLogEntries(storeRoot) {
  const path = diagnosticLogPath(storeRoot);
  rememberSensitive(path);
  assert(existsSync(path), "Diagnostic JSONL log was not written.");
  const text = readFileSync(path, "utf8");
  assertNoPublicLeaks("diagnostic JSONL log", text);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert(lines.length > 0, "Diagnostic JSONL log did not contain any entries.");
  return lines.map((line, index) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      fail("Persisted diagnostic line is not valid JSON.", {
        lineNumber: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    assertDiagnosticEntrySafe(entry, index + 1);
    return entry;
  });
}

function assertDiagnosticEntrySafe(entry, lineNumber) {
  const allowedKeys = new Set(["schemaVersion", "ts", "source", "event", "status", "logPath", "requestId", "method", "durationMs", "errorCode", "detailRef"]);
  for (const key of Object.keys(entry)) {
    assert(allowedKeys.has(key), "Persisted diagnostic contained an unexpected field.", { lineNumber, key });
  }
  assert(entry.schemaVersion === 1, "Persisted diagnostic schema version mismatch.", { lineNumber, schemaVersion: entry.schemaVersion });
  assert(entry.source === "python-sidecar", "Persisted diagnostic source mismatch.", { lineNumber, source: entry.source });
  assert(entry.event === "sidecar.request", "Persisted diagnostic event name changed.", { lineNumber, event: entry.event });
  assert(entry.logPath === DIAGNOSTIC_RELATIVE_LOG_PATH, "Persisted diagnostic log path changed.", { lineNumber, logPath: entry.logPath });
  assert(!("params" in entry), "Persisted diagnostic leaked params.", { lineNumber });
  assert(!("storeRoot" in entry), "Persisted diagnostic leaked storeRoot.", { lineNumber });
  assertPublicPayloadSafe(entry, "persisted diagnostic entry");
}

function assertStoredDiagnosticLogEntries(storeRoot, expectedDiagnostics) {
  const entries = readDiagnosticLogEntries(storeRoot);
  for (const expected of expectedDiagnostics) {
    const matching = entries.filter((entry) => entry.requestId === expected.requestId && entry.method === expected.method);
    assert(matching.length === 1, "Persisted diagnostic log did not contain exactly one matching command entry.", {
      requestId: expected.requestId,
      method: expected.method,
      matchCount: matching.length,
    });
    const entry = matching[0];
    assert(entry.status === expected.status, "Persisted diagnostic entry status mismatch.", {
      requestId: expected.requestId,
      method: expected.method,
      expectedStatus: expected.status,
      actualStatus: entry.status,
    });
    assert(entry.errorCode === expected.errorCode, "Persisted diagnostic entry errorCode mismatch.", {
      requestId: expected.requestId,
      method: expected.method,
      expectedErrorCode: expected.errorCode,
      actualErrorCode: entry.errorCode,
    });
    assert(entry.detailRef === expected.detailRef, "Persisted diagnostic entry detailRef mismatch.", {
      requestId: expected.requestId,
      method: expected.method,
    });
  }
  return {
    diagnosticEntries: entries.length,
    expectedEntries: expectedDiagnostics.length,
    errorEntries: entries.filter((entry) => entry.status === "error").length,
  };
}

function trackStoredDiagnostic(expectedDiagnostics, transcript) {
  expectedDiagnostics.push({
    requestId: transcript.diagnostic.requestId,
    method: transcript.diagnostic.method,
    status: transcript.diagnostic.status,
    errorCode: transcript.diagnostic.errorCode,
    detailRef: transcript.diagnostic.detailRef,
  });
  return transcript;
}

function assertNoForbiddenKeys(value, context, path = "$", allowProxyCredentials = false) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, context, `${path}[${index}]`, allowProxyCredentials));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    const isAllowedCredentialKey = allowProxyCredentials && (nextPath.endsWith(".proxy.credentials") || nextPath.endsWith(".proxy.credentials.username") || nextPath.endsWith(".proxy.credentials.password"));
    // Anchored to the profile record root on purpose. A suffix match would also
    // exempt metadata.launch.args or proxy.launch.args, so a captured Chromium
    // launch record shaped {"launch": {"args": [...]}} persisted anywhere in the
    // store would pass the guard it exists to trip.
    const isAllowedLaunchArgsKey = /^\$\.profiles\[\d+\]\.launch\.args$/.test(nextPath);
    assert(isAllowedCredentialKey || isAllowedLaunchArgsKey || !FORBIDDEN_DURABLE_KEYS.has(key), `${context} contains forbidden runtime/debug field ${key}.`, {
      key,
      path: nextPath,
    });
    assertNoForbiddenKeys(nestedValue, context, nextPath, allowProxyCredentials);
  }
}

function assertNoPublicSecretKeys(value, context, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPublicSecretKeys(item, context, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    assert(!PUBLIC_SECRET_KEY_RE.test(key), `${context} exposed a proxy credential-bearing field.`, {
      key,
      path: `${path}.${key}`,
    });
    assertNoPublicSecretKeys(nestedValue, context, `${path}.${key}`);
  }
}

function assertNoForbiddenText(text, context, extra = []) {
  for (const sensitive of activeSensitiveValues(extra)) {
    assert(!text.includes(sensitive), `${context} leaked a sensitive sentinel or absolute path.`, {
      context,
      leaked: sensitive === ROOT_DIR ? "repo-root" : "sentinel-or-path",
    });
  }
  for (const marker of FORBIDDEN_TEXT_MARKERS) {
    assert(!marker.test(text), `${context} leaked a forbidden runtime/debug marker.`, {
      context,
      marker: String(marker),
    });
  }
}

function assertNoPublicLeaks(label, value, extra = []) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assertNoForbiddenText(text, label, extra);
}

function assertPublicPayloadSafe(value, context) {
  assertNoPublicSecretKeys(value, context);
  assertNoPublicLeaks(context, value);
}

function assertNoPrivateRuntimeLeaks(text, payload) {
  assertNoForbiddenTextWithoutCredentials(text, "profiles.json");
  assertNoForbiddenKeys(payload, "profiles.json", "$", true);
  assert(!text.includes(ROOT_DIR), "profiles.json leaked the repository path.");
}

function assertNoForbiddenTextWithoutCredentials(text, context) {
  const nonCredentialSensitive = [...SENSITIVE_VALUES].filter((value) => ![HTTP_PROXY_USERNAME, HTTP_PROXY_PASSWORD, BAD_PROXY_USERNAME, BAD_PROXY_PASSWORD].includes(value));
  for (const sensitive of nonCredentialSensitive) {
    assert(!text.includes(sensitive), `${context} leaked a sensitive absolute path.`, {
      context,
      leaked: sensitive === ROOT_DIR ? "repo-root" : "runtime-path",
    });
  }
  for (const marker of FORBIDDEN_TEXT_MARKERS) {
    assert(!marker.test(text), `${context} leaked a forbidden runtime/debug marker.`, {
      context,
      marker: String(marker),
    });
  }
}

function assertVerifierRedactionHelpers() {
  const redacted = redact({
    stdoutTail: `leaked ${HTTP_PROXY_USERNAME}`,
    stderrTail: `leaked ${HTTP_PROXY_PASSWORD}`,
    proxyPassword: HTTP_PROXY_PASSWORD,
    credentialState: "configured",
  });
  assertNoPublicLeaks("verifier redaction helper output", redacted);
  assert(JSON.stringify(redacted).includes("credentialState"), "Verifier redaction helper should preserve safe credentialState vocabulary.");

  let caughtLeak = false;
  try {
    assertPublicPayloadSafe({ proxy: { credentials: { username: HTTP_PROXY_USERNAME } } }, "synthetic malformed public payload");
  } catch (error) {
    caughtLeak = error instanceof VerifyFailure;
  }
  assert(caughtLeak, "Verifier redaction boundary did not reject a synthetic malformed public credentials payload.");
  return { redactionHelper: "proxy-sentinels", malformedPublicPayloadRejected: true };
}

function assertTranscriptRedaction() {
  const publicText = SIDECAR_TRANSCRIPTS.map((item) => `${item.stdoutLine}\n${item.stderrLine}`).join("\n");
  assertNoPublicLeaks("source sidecar transcripts", publicText);
  return { transcriptCount: SIDECAR_TRANSCRIPTS.length };
}

function assertVerifierEventsRedacted() {
  assertNoPublicLeaks("verify:s03 public events", JSON.stringify(PUBLIC_EVENTS));
  return { emittedEvents: PUBLIC_EVENTS.length };
}

const DIRECT_PROXY = { proxyVersion: 1, mode: "direct" };
const HTTP_CREDENTIAL_PROXY = {
  proxyVersion: 1,
  mode: "fixedServer",
  protocol: "http",
  host: "proxy-s03-http.example",
  port: 18080,
  credentials: {
    username: HTTP_PROXY_USERNAME,
    password: HTTP_PROXY_PASSWORD,
  },
};
const HTTPS_NO_CREDENTIAL_PROXY = {
  proxyVersion: 1,
  mode: "fixedServer",
  protocol: "https",
  host: "proxy-s03-https.example",
  port: 18443,
};
const SOCKS4_NO_CREDENTIAL_PROXY = {
  proxyVersion: 1,
  mode: "fixedServer",
  protocol: "socks4",
  host: "proxy-s03-socks4.example",
  port: 19040,
};
const SOCKS5_NO_CREDENTIAL_PROXY = {
  proxyVersion: 1,
  mode: "fixedServer",
  protocol: "socks5",
  host: "proxy-s03-socks5.example",
  port: 19050,
};

async function runInvalidProxyUpdateNoWrite({ client, expectedDiagnostics, storeRoot, profileId, requestId, proxy, expectedErrorCode }) {
  const before = readProfilesJson(storeRoot).text;
  const result = trackStoredDiagnostic(
    expectedDiagnostics,
    await sidecarError(client, requestId, "profiles.proxy.update", { storeRoot, profileId, proxy }),
  );
  assert(result.error.code === expectedErrorCode, "Invalid proxy update returned the wrong typed error code.", {
    requestId,
    expectedErrorCode,
    actualErrorCode: result.error.code,
  });
  assert(result.error.code.startsWith("PROXY_"), "Invalid proxy update did not return a typed PROXY_* error.", {
    requestId,
    errorCode: result.error.code,
  });
  const after = readProfilesJson(storeRoot).text;
  assert(after === before, "Invalid proxy update mutated profiles.json.", {
    requestId,
    errorCode: result.error.code,
  });
  return {
    requestId,
    errorCode: result.error.code,
    detailRef: result.error.detailRef,
    storeUnchanged: true,
  };
}

async function runProxyConfigVerifier(storeRoot) {
  const expectedDiagnostics = [];
  const client = await runStep("source-sidecar-start", async () => {
    const startedClient = startSourceSidecar();
    return {
      value: startedClient,
      log: {
        phase: "proxy-config",
        action: "start",
        process: "source-sidecar",
        transport: "ndjson-stdio",
      },
    };
  });
  let profile;
  let finalSummary = null;

  try {
    profile = await runStep("profile-create", async () => {
      const create = trackStoredDiagnostic(
        expectedDiagnostics,
        await sidecarSuccess(
          client,
          makeRequestId("profile-create"),
          "profiles.create",
          { storeRoot, name: SMOKE_PROFILE_NAME },
        ),
      );
      const createdProfile = assertProfileShape(create.result.profile);
      assertCollectionShape(create.result, createdProfile.id);
      assertPublicProxySummary(createdProfile.proxy, expectedSummary(DIRECT_PROXY));
      return {
        value: createdProfile,
        log: {
          phase: "proxy-config",
          action: "create-profile",
          profileId: createdProfile.id,
          storeVersion: create.result.storeVersion,
          profileCount: create.result.count,
          savedSummary: createdProfile.proxy.summary,
          credentialState: createdProfile.proxy.credentialState,
        },
      };
    });

    await runStep("profile-list-initial-direct", async () => {
      const list = trackStoredDiagnostic(
        expectedDiagnostics,
        await sidecarSuccess(
          client,
          makeRequestId("profile-list-initial"),
          "profiles.list",
          { storeRoot },
        ),
      );
      const listedProfile = assertCollectionShape(list.result, profile.id);
      assertPublicProxySummary(listedProfile.proxy, expectedSummary(DIRECT_PROXY));
      return {
        phase: "reload",
        action: "list-initial",
        profileCount: list.result.count,
        savedSummary: listedProfile.proxy.summary,
        credentialState: listedProfile.proxy.credentialState,
      };
    });

    await runStep("proxy-validate-direct", async () => {
      const validation = await sidecarSuccess(
        client,
        makeRequestId("validate-direct"),
        "proxy.validate",
        { proxy: DIRECT_PROXY },
      );
      const proxy = assertProxyValidationResult(validation.result, expectedSummary(DIRECT_PROXY));
      return {
        phase: "proxy-config",
        action: "validate",
        proxyMode: proxy.mode,
        credentialState: proxy.credentialState,
      };
    });

    await runStep("profile-proxy-save-direct", async () => {
      const update = trackStoredDiagnostic(
        expectedDiagnostics,
        await sidecarSuccess(
          client,
          makeRequestId("save-direct"),
          "profiles.proxy.update",
          { storeRoot, profileId: profile.id, proxy: DIRECT_PROXY },
        ),
      );
      const updatedProfile = assertProxyMutationResult(update.result, profile.id, expectedSummary(DIRECT_PROXY));
      const privateState = assertPrivateProxy(storeRoot, profile.id, DIRECT_PROXY);
      return {
        phase: "proxy-config",
        action: "update",
        profileId: updatedProfile.id,
        savedSummary: updatedProfile.proxy.summary,
        credentialState: updatedProfile.proxy.credentialState,
        privateCredentialState: privateState.credentialState,
      };
    });

    await runStep("proxy-validate-fixed-vocabulary", async () => {
      const fixtures = [
        HTTP_CREDENTIAL_PROXY,
        HTTPS_NO_CREDENTIAL_PROXY,
        SOCKS4_NO_CREDENTIAL_PROXY,
        SOCKS5_NO_CREDENTIAL_PROXY,
      ];
      const protocols = [];
      const credentialStates = [];
      for (const draft of fixtures) {
        const validation = await sidecarSuccess(
          client,
          makeRequestId(`validate-${draft.protocol}`),
          "proxy.validate",
          { proxy: draft },
        );
        const proxy = assertProxyValidationResult(validation.result, expectedSummary(draft));
        protocols.push(proxy.protocol);
        credentialStates.push(proxy.credentialState);
      }
      return {
        phase: "proxy-config",
        action: "validate-fixed-family",
        protocols,
        credentialStates,
      };
    });

    await runStep("profile-proxy-save-http-credentials", async () => {
      const update = trackStoredDiagnostic(
        expectedDiagnostics,
        await sidecarSuccess(
          client,
          makeRequestId("save-http-fixed"),
          "profiles.proxy.update",
          { storeRoot, profileId: profile.id, proxy: HTTP_CREDENTIAL_PROXY },
        ),
      );
      const updatedProfile = assertProxyMutationResult(update.result, profile.id, expectedSummary(HTTP_CREDENTIAL_PROXY));
      const privateState = assertPrivateProxy(storeRoot, profile.id, HTTP_CREDENTIAL_PROXY);
      return {
        phase: "proxy-config",
        action: "update",
        protocol: updatedProfile.proxy.protocol,
        savedSummary: updatedProfile.proxy.summary,
        credentialState: updatedProfile.proxy.credentialState,
        privateCredentialState: privateState.credentialState,
      };
    });

    await runStep("reload-masked-http-credentials", async () => {
      const list = trackStoredDiagnostic(
        expectedDiagnostics,
        await sidecarSuccess(
          client,
          makeRequestId("reload-http-fixed"),
          "profiles.list",
          { storeRoot },
        ),
      );
      const listedProfile = assertCollectionShape(list.result, profile.id);
      assertPublicProxySummary(listedProfile.proxy, expectedSummary(HTTP_CREDENTIAL_PROXY));
      return {
        phase: "reload",
        action: "list-after-credential-save",
        savedSummary: listedProfile.proxy.summary,
        credentialState: listedProfile.proxy.credentialState,
        rawCredentialsRendered: false,
      };
    });

    await runStep("profile-proxy-save-socks5-no-credentials", async () => {
      const update = trackStoredDiagnostic(
        expectedDiagnostics,
        await sidecarSuccess(
          client,
          makeRequestId("save-socks5-open"),
          "profiles.proxy.update",
          { storeRoot, profileId: profile.id, proxy: SOCKS5_NO_CREDENTIAL_PROXY },
        ),
      );
      const updatedProfile = assertProxyMutationResult(update.result, profile.id, expectedSummary(SOCKS5_NO_CREDENTIAL_PROXY));
      const privateState = assertPrivateProxy(storeRoot, profile.id, SOCKS5_NO_CREDENTIAL_PROXY);
      finalSummary = cloneJson(updatedProfile.proxy);
      return {
        phase: "proxy-config",
        action: "update",
        protocol: updatedProfile.proxy.protocol,
        savedSummary: updatedProfile.proxy.summary,
        credentialState: updatedProfile.proxy.credentialState,
        privateCredentialState: privateState.credentialState,
      };
    });

    await runStep("reload-socks5-no-credentials", async () => {
      const list = trackStoredDiagnostic(
        expectedDiagnostics,
        await sidecarSuccess(
          client,
          makeRequestId("reload-socks5-open"),
          "profiles.list",
          { storeRoot },
        ),
      );
      const listedProfile = assertCollectionShape(list.result, profile.id);
      assertPublicProxySummary(listedProfile.proxy, expectedSummary(SOCKS5_NO_CREDENTIAL_PROXY));
      finalSummary = cloneJson(listedProfile.proxy);
      return {
        phase: "reload",
        action: "list-after-socks-save",
        savedSummary: listedProfile.proxy.summary,
        credentialState: listedProfile.proxy.credentialState,
      };
    });

    await runStep("invalid-updates-no-write", async () => {
      const invalidProxyCases = [
        {
          label: "pac-mode",
          requestId: makeRequestId("invalid-pac-mode"),
          expectedErrorCode: "PROXY_PAC_UNSUPPORTED",
          proxy: {
            proxyVersion: 1,
            mode: "pac",
            pacUrl: "https://proxy-s03-pac.example/proxy.pac",
            credentials: { username: BAD_PROXY_USERNAME, password: BAD_PROXY_PASSWORD },
          },
        },
        {
          label: "system-mode",
          requestId: makeRequestId("invalid-system-mode"),
          expectedErrorCode: "PROXY_PAC_UNSUPPORTED",
          proxy: { proxyVersion: 1, mode: "system" },
        },
        {
          label: "url-style-field",
          requestId: makeRequestId("invalid-url-style-field"),
          expectedErrorCode: "PROXY_UNSUPPORTED_MODE",
          proxy: {
            proxyVersion: 1,
            mode: "fixedServer",
            protocol: "http",
            host: "proxy-s03-url.example",
            port: 18081,
            proxyUrl: "http://proxy-s03-url.example:18081",
          },
        },
        {
          label: "userinfo-host",
          requestId: makeRequestId("invalid-userinfo-host"),
          expectedErrorCode: "PROXY_INVALID",
          proxy: {
            proxyVersion: 1,
            mode: "fixedServer",
            protocol: "http",
            host: "user:pass@proxy-s03-userinfo.example",
            port: 18082,
          },
        },
        {
          label: "unsafe-launch-field",
          requestId: makeRequestId("invalid-unsafe-launch-field"),
          expectedErrorCode: "PROXY_INVALID",
          proxy: {
            proxyVersion: 1,
            mode: "fixedServer",
            protocol: "http",
            host: "proxy-s03-unsafe.example",
            port: 18083,
            argv: ["--remote-debugging-port=9222"],
          },
        },
        {
          label: "direct-fallback",
          requestId: makeRequestId("invalid-direct-fallback"),
          expectedErrorCode: "PROXY_UNSUPPORTED_MODE",
          proxy: {
            proxyVersion: 1,
            mode: "fixedServer",
            protocol: "http",
            host: "proxy-s03-fallback.example",
            port: 18084,
            directFallback: true,
          },
        },
        {
          label: "invalid-port",
          requestId: makeRequestId("invalid-port"),
          expectedErrorCode: "PROXY_INVALID",
          proxy: {
            proxyVersion: 1,
            mode: "fixedServer",
            protocol: "http",
            host: "proxy-s03-invalid-port.example",
            port: 70000,
          },
        },
        {
          label: "incomplete-credentials",
          requestId: makeRequestId("invalid-incomplete-pair"),
          expectedErrorCode: "PROXY_INVALID",
          proxy: {
            proxyVersion: 1,
            mode: "fixedServer",
            protocol: "http",
            host: "proxy-s03-incomplete-creds.example",
            port: 18085,
            credentials: { username: BAD_PROXY_USERNAME, password: "" },
          },
        },
      ];
      const outcomes = [];
      for (const testCase of invalidProxyCases) {
        const outcome = await runInvalidProxyUpdateNoWrite({
          client,
          expectedDiagnostics,
          storeRoot,
          profileId: profile.id,
          requestId: testCase.requestId,
          proxy: testCase.proxy,
          expectedErrorCode: testCase.expectedErrorCode,
        });
        outcomes.push({ label: testCase.label, errorCode: outcome.errorCode, storeUnchanged: outcome.storeUnchanged });
      }
      return {
        phase: "proxy-config",
        action: "invalid-updates-no-write",
        invalidCaseCount: outcomes.length,
        outcomes,
      };
    });

    await runStep("post-invalid-store-truth", async () => {
      const list = trackStoredDiagnostic(
        expectedDiagnostics,
        await sidecarSuccess(
          client,
          makeRequestId("post-invalid-list"),
          "profiles.list",
          { storeRoot },
        ),
      );
      const listedProfile = assertCollectionShape(list.result, profile.id);
      assertPublicProxySummary(listedProfile.proxy, expectedSummary(SOCKS5_NO_CREDENTIAL_PROXY));
      const privateState = assertPrivateProxy(storeRoot, profile.id, SOCKS5_NO_CREDENTIAL_PROXY);
      return {
        phase: "proxy-config",
        action: "verify-no-write-truth",
        savedSummary: listedProfile.proxy.summary,
        credentialState: listedProfile.proxy.credentialState,
        privateCredentialState: privateState.credentialState,
      };
    });

    await runStep("runtime-guard-boundary-status", async () => {
      const status = trackStoredDiagnostic(
        expectedDiagnostics,
        await sidecarSuccess(
          client,
          makeRequestId("chromium-status-boundary"),
          "chromium.status",
          { storeRoot },
        ),
      );
      assert(status.result.runningCount === 0, "Runtime guard boundary smoke expected no running Chromium profiles.", {
        runningCount: status.result.runningCount,
      });
      assert(Array.isArray(status.result.profiles) && status.result.profiles.length === 0, "Runtime guard boundary smoke found running profile payloads.", {
        runningProfiles: status.result.profiles?.length,
      });
      return {
        phase: "runtime-guard-boundary",
        action: "status-only",
        runningCount: status.result.runningCount,
        packagedUiGuardProof: "deferred-to-s06-and-react-tests",
      };
    });

    await runStep("diagnostic-log-shape", async () => {
      const diagnosticProof = assertStoredDiagnosticLogEntries(storeRoot, expectedDiagnostics);
      return {
        phase: "proxy-config",
        action: "diagnostic-log-shape",
        ...diagnosticProof,
      };
    });

    await runStep("redaction-boundary", async () => {
      const helperProof = assertVerifierRedactionHelpers();
      const transcriptProof = assertTranscriptRedaction();
      const eventProof = assertVerifierEventsRedacted();
      return {
        phase: "redaction",
        action: "scan-public-output",
        ...helperProof,
        ...transcriptProof,
        ...eventProof,
        publicIpProof: "not-claimed",
        webRtcProof: "not-claimed",
      };
    });

    await runStep("source-sidecar-stop", async () => {
      const stopped = await client.stop();
      return {
        phase: "proxy-config",
        action: "stop",
        process: "source-sidecar",
        exitCode: stopped.exitCode,
        exitSignal: stopped.exitSignal,
      };
    });
  } finally {
    await client.cleanup();
  }

  return {
    profileId: profile.id,
    finalSavedSummary: finalSummary?.summary ?? "unknown",
    finalCredentialState: finalSummary?.credentialState ?? "unknown",
    categories: ["proxy-config", "redaction", "reload", "runtime-guard-boundary"],
    publicIpProof: "not-claimed",
    webRtcProof: "not-claimed",
  };
}

const storeRoot = makeTempRoot("theprivator-s03-proxy-");

try {
  const proof = await runProxyConfigVerifier(storeRoot);
  rmSync(storeRoot, { recursive: true, force: true });
  emit({
    status: "pass",
    proof,
    checks: STEP_RESULTS,
  });
} catch {
  rmSync(storeRoot, { recursive: true, force: true });
  emit({
    status: "fail",
    checks: STEP_RESULTS,
  });
  process.exit(1);
}
