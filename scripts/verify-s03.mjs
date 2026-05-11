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
const SMOKE_PROFILE_NAME = "S03 Identity Profile";
const TARGET_PRESET_ID = "ubuntu-linux-chrome-120";
const EXPECTED_PRESET_IDS = [
  "macos-ventura-chrome-120",
  "ubuntu-linux-chrome-120",
  "windows-10-chrome-120",
  "windows-11-chrome-121",
];
const STEP_RESULTS = [];
const PUBLIC_EVENTS = [];
const SENSITIVE_VALUES = new Set([ROOT_DIR]);
const FORBIDDEN_DURABLE_KEYS = new Set([
  "args",
  "argv",
  "command",
  "debugPort",
  "devtoolsPort",
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
  /--remote-debugging-port/i,
  /DevToolsActivePort/i,
  /Traceback \(most recent call last\)/i,
  /\bWebSocket\b/i,
  /\bws:\/\//i,
  /\bwss:\/\//i,
  /profile-store[\\/]+runtime/i,
  /runtime-registry/i,
];

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

function redact(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    let redacted = value;
    const values = Array.from(SENSITIVE_VALUES).sort((a, b) => b.length - a.length);
    for (const sensitive of values) {
      if (!sensitive) {
        continue;
      }
      redacted = redacted.split(sensitive).join(sensitive === ROOT_DIR ? "<repo>" : "<redacted-path>");
    }
    return redacted;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  }

  return value;
}

function normalizeOutput(value) {
  if (!value) {
    return "";
  }

  return redact(value)
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
    const record = { name, status: "fail", durationMs, message: redact(message) };
    STEP_RESULTS.push(record);
    emit({ step: name, status: "fail", durationMs, message: redact(message) });
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
  return root;
}

function makeRequestId(label) {
  return `verify-s03-${label}`;
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
      return {
        response: parseNdjsonLine("stdout", stdoutLine, requestPayload.method),
        diagnostic: parseNdjsonLine("stderr", stderrLine, requestPayload.method),
      };
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

async function callSidecar(client, request, options = {}) {
  const { response, diagnostic } = await client.request(request, options);

  assert(diagnostic.event === "sidecar.request", "Sidecar diagnostic event name changed.", {
    method: request.method,
    diagnosticEvent: diagnostic.event,
  });
  assert(diagnostic.method === request.method, "Sidecar diagnostic method did not match the request.", {
    method: request.method,
    diagnosticMethod: diagnostic.method,
  });
  assert(diagnostic.requestId === request.id, "Sidecar diagnostic request id did not match the request.", {
    requestId: request.id,
    diagnosticRequestId: diagnostic.requestId,
  });
  assert(!("params" in diagnostic), "Sidecar diagnostic leaked request params.", { method: request.method });
  assert(!("storeRoot" in diagnostic), "Sidecar diagnostic leaked store root.", { method: request.method });

  return { response, diagnostic };
}

async function sidecarSuccess(client, id, method, params, options = {}) {
  const { response, diagnostic } = await callSidecar(client, sidecarRequest(id, method, params), options);
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
  return response.result;
}

async function sidecarError(client, id, method, params, options = {}) {
  const { response, diagnostic } = await callSidecar(client, sidecarRequest(id, method, params), options);
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
  return response.error;
}

function isSafeRelativeStoragePath(value) {
  return typeof value === "string"
    && value.startsWith("profile-store/profiles/")
    && value.endsWith("/user-data")
    && !value.startsWith("/")
    && !value.includes("..");
}

function assertProfileShape(profile) {
  assert(profile && typeof profile === "object" && !Array.isArray(profile), "Profile payload is missing.");
  assert(typeof profile.id === "string" && profile.id.length > 0, "Profile is missing id.");
  assert(profile.name === SMOKE_PROFILE_NAME, "Profile name mismatch.", { profileName: profile.name });
  assert(profile.storage && typeof profile.storage === "object", "Profile is missing storage metadata.");
  assert(isSafeRelativeStoragePath(profile.storage.userDataDir), "Profile userDataDir is not a safe relative S02 path.", {
    userDataDir: profile.storage.userDataDir,
  });
  assert(profile.identity && typeof profile.identity === "object" && !Array.isArray(profile.identity), "Profile is missing identity.");
  assert(profile.identity.identityVersion === 1, "Profile identity version mismatch.", {
    identityVersion: profile.identity.identityVersion,
  });
  return profile;
}

function assertCollectionShape(result, expectedProfileId) {
  assert(result.storeVersion === 2, "Profile collection must use storeVersion 2.", { storeVersion: result.storeVersion });
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

function makeSuspiciousOverride(presetIdentity) {
  const identity = cloneJson(presetIdentity);
  identity.label = "S03 warning-bearing override";
  identity.presetId = null;
  identity.navigator.hardwareConcurrency = 7;
  identity.navigator.deviceMemory = 3;
  identity.screen.viewportWidth = identity.screen.width + 1;
  return identity;
}

function readProfilesJson(storeRoot) {
  const profilesPath = join(storeRoot, "profile-store", "profiles.json");
  assert(existsSync(profilesPath), "profiles.json was not written for the identity verifier.");
  rememberSensitive(profilesPath);
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

function assertNoForbiddenKeys(value, context, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, context, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    assert(!FORBIDDEN_DURABLE_KEYS.has(key), `${context} contains forbidden runtime/debug field ${key}.`, {
      key,
      path: `${path}.${key}`,
    });
    assertNoForbiddenKeys(nestedValue, context, `${path}.${key}`);
  }
}

function assertNoForbiddenText(text, context) {
  for (const sensitive of SENSITIVE_VALUES) {
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

function assertProfilesJsonClean(storeRoot, profileId, expectedIdentity) {
  const { text, payload } = readProfilesJson(storeRoot);
  assert(payload.storeVersion === 2, "profiles.json must remain a v2 profile-store payload.", {
    storeVersion: payload.storeVersion,
  });
  assert(Array.isArray(payload.profiles), "profiles.json profiles field is not an array.");
  const profile = payload.profiles.find((item) => item?.id === profileId);
  assert(profile, "profiles.json does not contain the smoke profile.", { profileId });
  assert(deepEqualJson(profile.identity, expectedIdentity), "profiles.json did not persist the expected warning-bearing identity override.", {
    expectedLabel: expectedIdentity.label,
    actualLabel: profile.identity?.label,
  });
  assertNoForbiddenKeys(payload, "profiles.json");
  assertNoForbiddenText(text, "profiles.json");
  return { profileCount: payload.profiles.length, storeVersion: payload.storeVersion };
}

function assertPresetList(result) {
  assert(result.identityVersion === 1, "Preset list identityVersion mismatch.", { identityVersion: result.identityVersion });
  assert(Array.isArray(result.presets), "Preset list presets field is not an array.");
  assert(result.count === result.presets.length, "Preset list count mismatch.", {
    count: result.count,
    presetCount: result.presets.length,
  });
  const ids = result.presets.map((preset) => preset?.presetId).sort();
  assert(deepEqualJson(ids, EXPECTED_PRESET_IDS), "Curated preset ids changed unexpectedly.", {
    expectedPresetIds: EXPECTED_PRESET_IDS,
    actualPresetIds: ids,
  });
  return result.presets;
}

async function runIdentityVerifier(storeRoot) {
  const client = await runStep("source-sidecar-start", async () => {
    const startedClient = startSourceSidecar();
    return { value: startedClient, log: { process: "source-sidecar", transport: "ndjson-stdio" } };
  });
  let profile;
  let suspiciousIdentity;
  let profilesJsonBeforeInvalid;

  try {
    profile = await runStep("profile-create", async () => {
      const create = await sidecarSuccess(
        client,
        makeRequestId("profile-create"),
        "profiles.create",
        { storeRoot, name: SMOKE_PROFILE_NAME },
      );
      const createdProfile = assertProfileShape(create.profile);
      assertCollectionShape(create, createdProfile.id);
      return {
        value: createdProfile,
        log: {
          profileId: createdProfile.id,
          storeVersion: create.storeVersion,
          profileCount: create.count,
        },
      };
    });

    const presets = await runStep("curated-presets-list", async () => {
      const presetList = await sidecarSuccess(
        client,
        makeRequestId("preset-list"),
        "identity.presets.list",
        {},
      );
      const loadedPresets = assertPresetList(presetList);
      return {
        value: loadedPresets,
        log: {
          presetCount: loadedPresets.length,
          presetIds: loadedPresets.map((preset) => preset.presetId).sort(),
        },
      };
    });

    const appliedProfile = await runStep("apply-ubuntu-preset", async () => {
      const apply = await sidecarSuccess(
        client,
        makeRequestId("apply-ubuntu"),
        "profiles.identity.applyPreset",
        { storeRoot, profileId: profile.id, presetId: TARGET_PRESET_ID },
      );
      const updatedProfile = assertProfileShape(apply.profile);
      assertCollectionShape(apply, profile.id);
      assert(updatedProfile.identity.presetId === TARGET_PRESET_ID, "Applied profile identity preset id mismatch.", {
        presetId: updatedProfile.identity.presetId,
      });
      assert(Array.isArray(apply.warnings) && apply.warnings.length === 0, "Ubuntu curated preset should apply without warnings.", {
        warningCount: Array.isArray(apply.warnings) ? apply.warnings.length : "not-array",
      });
      return {
        value: updatedProfile,
        log: {
          profileId: updatedProfile.id,
          presetId: updatedProfile.identity.presetId,
          warningCount: apply.warnings.length,
        },
      };
    });

    const targetPreset = presets.find((preset) => preset.presetId === TARGET_PRESET_ID) ?? appliedProfile.identity;
    suspiciousIdentity = makeSuspiciousOverride(targetPreset);

    const validatedWarningCodes = await runStep("validate-warning-override", async () => {
      const validation = await sidecarSuccess(
        client,
        makeRequestId("validate-warning"),
        "identity.validate",
        { identity: suspiciousIdentity },
      );
      assert(validation.identityVersion === 1, "Identity validation version mismatch.", { identityVersion: validation.identityVersion });
      assert(deepEqualJson(validation.identity, suspiciousIdentity), "Validated suspicious override did not normalize as expected.", {
        expectedLabel: suspiciousIdentity.label,
        actualLabel: validation.identity?.label,
      });
      assert(Array.isArray(validation.warnings) && validation.warnings.length >= 2, "Suspicious override should return saveable warnings.", {
        warningCount: Array.isArray(validation.warnings) ? validation.warnings.length : "not-array",
      });
      const warningCodes = validation.warnings.map((warning) => warning.code).sort();
      assert(warningCodes.includes("IDENTITY_UNUSUAL_CPU"), "Suspicious override did not report unusual CPU warning.", { warningCodes });
      assert(warningCodes.includes("IDENTITY_UNUSUAL_DEVICE_MEMORY"), "Suspicious override did not report unusual memory warning.", { warningCodes });
      assert(warningCodes.includes("IDENTITY_VIEWPORT_EXCEEDS_SCREEN"), "Suspicious override did not report viewport warning.", { warningCodes });
      return {
        value: warningCodes,
        log: {
          warningCount: warningCodes.length,
          warningCodes,
        },
      };
    });

    await runStep("save-warning-override", async () => {
      const update = await sidecarSuccess(
        client,
        makeRequestId("save-warning"),
        "profiles.identity.update",
        { storeRoot, profileId: profile.id, identity: suspiciousIdentity },
      );
      const updatedProfile = assertProfileShape(update.profile);
      assertCollectionShape(update, profile.id);
      assert(deepEqualJson(updatedProfile.identity, suspiciousIdentity), "Profile update did not return the warning-bearing override.", {
        expectedLabel: suspiciousIdentity.label,
        actualLabel: updatedProfile.identity?.label,
      });
      const warningCodes = update.warnings.map((warning) => warning.code).sort();
      assert(deepEqualJson(warningCodes, validatedWarningCodes), "Update warnings did not match validation warnings.", {
        validationWarningCodes: validatedWarningCodes,
        updateWarningCodes: warningCodes,
      });
      return {
        profileId: updatedProfile.id,
        presetId: updatedProfile.identity.presetId,
        warningCount: warningCodes.length,
        warningCodes,
      };
    });

    await runStep("reload-persisted-override", async () => {
      const list = await sidecarSuccess(
        client,
        makeRequestId("reload-list"),
        "profiles.list",
        { storeRoot },
      );
      const reloadedProfile = assertCollectionShape(list, profile.id);
      assert(deepEqualJson(reloadedProfile.identity, suspiciousIdentity), "Reloaded profile did not preserve the warning-bearing override.", {
        expectedLabel: suspiciousIdentity.label,
        actualLabel: reloadedProfile.identity?.label,
      });
      return {
        profileId: reloadedProfile.id,
        label: reloadedProfile.identity.label,
        presetId: reloadedProfile.identity.presetId ?? "none",
        profileCount: list.count,
      };
    });

    profilesJsonBeforeInvalid = readProfilesJson(storeRoot).text;

    await runStep("invalid-update-no-write", async () => {
      const invalidIdentity = cloneJson(suspiciousIdentity);
      invalidIdentity.identityVersion = 999;
      const error = await sidecarError(
        client,
        makeRequestId("invalid-update"),
        "profiles.identity.update",
        { storeRoot, profileId: profile.id, identity: invalidIdentity },
      );
      assert(error.code.startsWith("IDENTITY_"), "Invalid identity update did not return a typed IDENTITY_* code.", {
        errorCode: error.code,
      });
      assert(error.recoverable === true, "Invalid identity update should be recoverable.", {
        recoverable: error.recoverable,
      });
      const profilesJsonAfterInvalid = readProfilesJson(storeRoot).text;
      assert(profilesJsonAfterInvalid === profilesJsonBeforeInvalid, "Invalid identity update mutated profiles.json.", {
        errorCode: error.code,
      });
      const list = await sidecarSuccess(
        client,
        makeRequestId("post-invalid-list"),
        "profiles.list",
        { storeRoot },
      );
      const reloadedProfile = assertCollectionShape(list, profile.id);
      assert(deepEqualJson(reloadedProfile.identity, suspiciousIdentity), "Invalid identity update changed the in-store identity.", {
        expectedLabel: suspiciousIdentity.label,
        actualLabel: reloadedProfile.identity?.label,
      });
      return {
        errorCode: error.code,
        detailRef: error.detailRef,
        noWrite: true,
      };
    });

    await runStep("store-redaction-scan", async () => {
      const clean = assertProfilesJsonClean(storeRoot, profile.id, suspiciousIdentity);
      const publicText = JSON.stringify(PUBLIC_EVENTS);
      assertNoForbiddenText(publicText, "verify:s03 public output");
      return {
        storeVersion: clean.storeVersion,
        profileCount: clean.profileCount,
        forbiddenRuntimeFields: 0,
        publicOutputLeaks: 0,
      };
    });

    await runStep("source-sidecar-stop", async () => {
      const stopped = await client.stop();
      return { process: "source-sidecar", exitCode: stopped.exitCode, exitSignal: stopped.exitSignal };
    });
  } finally {
    await client.cleanup();
  }

  return {
    profileId: profile.id,
    savedLabel: suspiciousIdentity.label,
    presetId: TARGET_PRESET_ID,
  };
}

const storeRoot = makeTempRoot("theprivator-s03-identity-");

try {
  const proof = await runIdentityVerifier(storeRoot);
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
