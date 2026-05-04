import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENV_PYTHON = process.platform === "win32"
  ? join(ROOT_DIR, ".venv", "Scripts", "python.exe")
  : join(ROOT_DIR, ".venv", "bin", "python");
const PYTHON = process.env.PYTHON ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : (process.platform === "win32" ? "python" : "python3"));
const PYTHON_LABEL = "python";
const SIDECAR_MODULE_LABEL = `${PYTHON_LABEL} -m theprivator_sidecar`;
const STEP_RESULTS = [];
const SENSITIVE_VALUES = new Set([ROOT_DIR]);
const FORBIDDEN_PROFILE_RUNTIME_FIELDS = new Set([
  "pid",
  "process",
  "command",
  "status",
  "running",
  "stoppedAt",
  "startedAt",
  "termination",
]);
const SAFE_TERMINATIONS = new Set(["graceful", "forced", "reconciled"]);
const SMOKE_PROFILE_NAME = "S03 Smoke Profile";
const SIDECAR_TIMEOUT_MS = 15_000;
const CHROMIUM_LAUNCH_TIMEOUT_MS = 20_000;
const WAIT_STOPPED_TIMEOUT_MS = 8_000;

class VerifyFailure extends Error {
  constructor(message, details) {
    super(message);
    this.name = "VerifyFailure";
    this.details = details;
  }
}

function emit(event) {
  console.log(JSON.stringify({ event: "verify.s03", ...event }));
}

function executable(command) {
  return process.platform === "win32" && ["npm", "cargo", "rustc"].includes(command)
    ? `${command}.cmd`
    : command;
}

function commandLabel(command, args, label) {
  if (label) {
    return label;
  }
  return [basename(command), ...args].join(" ");
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
    .slice(-25)
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

function runStep(name, action) {
  const started = performance.now();
  try {
    const result = action() ?? {};
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
    const record = { name, status: "fail", durationMs, message };
    STEP_RESULTS.push(record);
    emit({ step: name, status: "fail", durationMs, message });
    if (error?.details) {
      emit({ step: name, status: "fail-details", details: redact(error.details) });
    }
    throw error;
  }
}

function runCommand(name, command, args, timeoutMs, options = {}) {
  return runStep(name, () => {
    const label = commandLabel(command, args, options.label);
    const result = spawnSync(executable(command), args, {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });

    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        fail(`${label} timed out.`, {
          command: label,
          timeoutMs,
          detail: "The child process was terminated by verify:s03.",
        });
      }
      fail(`Failed to run ${label}.`, { command: label, error: result.error.message });
    }

    if (result.status !== 0) {
      fail(`${label} exited with status ${result.status ?? "unknown"}.`, {
        command: label,
        exitCode: result.status,
        stdoutTail: normalizeOutput(result.stdout),
        stderrTail: normalizeOutput(result.stderr),
      });
    }

    return { command: label };
  });
}

function parseNdjsonLines(streamName, value, expectedCount) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== expectedCount) {
    fail(`${streamName} emitted ${lines.length} NDJSON line(s), expected ${expectedCount}.`, {
      streamName,
      lineCount: lines.length,
      tail: normalizeOutput(value),
    });
  }

  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${streamName} line ${index + 1} is not valid JSON.`, {
        streamName,
        lineNumber: index + 1,
        error: error instanceof Error ? error.message : String(error),
        lineTail: normalizeOutput(line),
      });
    }
  });
}

function callSidecar(request, options = {}) {
  const timeoutMs = options.timeoutMs ?? SIDECAR_TIMEOUT_MS;
  const env = { ...process.env, ...(options.env ?? {}) };
  const input = `${JSON.stringify(request)}\n`;
  const result = spawnSync(PYTHON, ["-m", "theprivator_sidecar"], {
    cwd: ROOT_DIR,
    input,
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      fail(`${SIDECAR_MODULE_LABEL} timed out for ${request.method}.`, {
        method: request.method,
        timeoutMs,
        stdoutTail: normalizeOutput(result.stdout),
        stderrTail: normalizeOutput(result.stderr),
      });
    }
    fail(`${SIDECAR_MODULE_LABEL} failed for ${request.method}.`, {
      method: request.method,
      error: result.error.message,
      stdoutTail: normalizeOutput(result.stdout),
      stderrTail: normalizeOutput(result.stderr),
    });
  }

  if (result.status !== 0) {
    fail(`${SIDECAR_MODULE_LABEL} exited with status ${result.status ?? "unknown"} for ${request.method}.`, {
      method: request.method,
      exitCode: result.status,
      stdoutTail: normalizeOutput(result.stdout),
      stderrTail: normalizeOutput(result.stderr),
    });
  }

  const [response] = parseNdjsonLines("stdout", result.stdout, 1);
  const [diagnostic] = parseNdjsonLines("stderr", result.stderr, 1);

  assert(diagnostic.event === "sidecar.request", "Sidecar diagnostic event name changed.", {
    method: request.method,
    diagnostic,
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

  return { response, diagnostic };
}

function sidecarRequest(id, method, params) {
  return { id, method, params };
}

function sidecarSuccess(id, method, params, options = {}) {
  const { response, diagnostic } = callSidecar(sidecarRequest(id, method, params), options);
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
  return { result: response.result, durationMs: response.durationMs };
}

function sidecarError(id, method, params, options = {}) {
  const { response, diagnostic } = callSidecar(sidecarRequest(id, method, params), options);
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
  return { error: response.error, durationMs: response.durationMs };
}

function isSafeRelativeStoragePath(value) {
  return typeof value === "string"
    && value.startsWith("profile-store/profiles/")
    && value.endsWith("/user-data")
    && !value.startsWith("/")
    && !value.includes("..");
}

function assertProfileShape(profile) {
  assert(profile && typeof profile === "object" && !Array.isArray(profile), "Created profile payload is missing.");
  assert(typeof profile.id === "string" && profile.id.length > 0, "Created profile is missing id.");
  assert(profile.name === SMOKE_PROFILE_NAME, "Created profile name mismatch.", { profileName: profile.name });
  assert(profile.storage && typeof profile.storage === "object", "Created profile is missing storage metadata.");
  assert(isSafeRelativeStoragePath(profile.storage.userDataDir), "Created profile userDataDir is not a safe relative S02 path.", {
    userDataDir: profile.storage.userDataDir,
  });
  return profile;
}

function assertRunningPayload(payload, profile, expectedRunningCount = 1) {
  assert(payload.profileId === profile.id, "Chromium running payload profile id mismatch.", {
    profileId: payload.profileId,
    expectedProfileId: profile.id,
  });
  assert(payload.status === "running", "Chromium payload did not report running.", {
    status: payload.status,
  });
  assert(Number.isInteger(payload.pid) && payload.pid > 0, "Chromium running payload is missing a positive PID.", {
    pid: payload.pid,
  });
  assert(typeof payload.startedAt === "string" && payload.startedAt.endsWith("Z"), "Chromium running payload is missing startedAt.", {
    startedAt: payload.startedAt,
  });
  assert(payload.userDataDir === profile.storage.userDataDir, "Chromium running payload userDataDir mismatch.", {
    userDataDir: payload.userDataDir,
    expectedUserDataDir: profile.storage.userDataDir,
  });
  assert(payload.runningCount === undefined || payload.runningCount === expectedRunningCount, "Chromium running count mismatch.", {
    runningCount: payload.runningCount,
    expectedRunningCount,
  });
  assert(isPidAlive(payload.pid), "Chromium launch PID is not alive after launch.", { pid: payload.pid });
  return payload;
}

function assertStoppedPayload(payload, profile) {
  assert(payload.profileId === profile.id, "Chromium stopped payload profile id mismatch.", {
    profileId: payload.profileId,
    expectedProfileId: profile.id,
  });
  assert(payload.status === "stopped", "Chromium stop payload did not report stopped.", {
    status: payload.status,
  });
  assert(SAFE_TERMINATIONS.has(payload.termination), "Chromium stop payload termination was unexpected.", {
    termination: payload.termination,
  });
  assert(payload.runningCount === 0, "Chromium stop payload did not clear running count.", {
    runningCount: payload.runningCount,
  });
  assert(payload.userDataDir === profile.storage.userDataDir, "Chromium stopped payload userDataDir mismatch.", {
    userDataDir: payload.userDataDir,
    expectedUserDataDir: profile.storage.userDataDir,
  });
  return payload;
}

function assertStatusRunning(payload, profile, pid, startedAt) {
  assert(payload.runningCount === 1, "Chromium status did not report one running profile.", {
    runningCount: payload.runningCount,
  });
  assert(Array.isArray(payload.profiles) && payload.profiles.length === 1, "Chromium status profiles did not contain exactly one profile.", {
    profileCount: Array.isArray(payload.profiles) ? payload.profiles.length : "not-array",
  });
  assert(Array.isArray(payload.reconciled) && payload.reconciled.length === 0, "Chromium status unexpectedly reconciled while PID is running.", {
    reconciledCount: Array.isArray(payload.reconciled) ? payload.reconciled.length : "not-array",
  });
  const running = payload.profiles[0];
  assertRunningPayload({ ...running, runningCount: 1 }, profile);
  assert(running.pid === pid, "Chromium status PID did not match launch PID.", {
    statusPid: running.pid,
    launchPid: pid,
  });
  assert(running.startedAt === startedAt, "Chromium status startedAt did not match launch proof.", {
    statusStartedAt: running.startedAt,
    launchStartedAt: startedAt,
  });
  return running;
}

function assertStatusStopped(payload) {
  assert(payload.runningCount === 0, "Chromium status did not report zero running profiles after stop.", {
    runningCount: payload.runningCount,
  });
  assert(Array.isArray(payload.profiles) && payload.profiles.length === 0, "Chromium status retained running profiles after stop.", {
    profileCount: Array.isArray(payload.profiles) ? payload.profiles.length : "not-array",
  });
  assert(Array.isArray(payload.reconciled), "Chromium status reconciled field is not an array.", {
    reconciled: payload.reconciled,
  });
  return payload;
}

function assertReconciledStatus(payload, profile) {
  assertStatusStopped(payload);
  const reconciled = payload.reconciled.find((item) => item?.profileId === profile.id);
  assert(reconciled, "Chromium status did not report the externally closed profile as reconciled.", {
    reconciledCount: payload.reconciled.length,
    profileId: profile.id,
  });
  assert(reconciled.status === "stopped", "Reconciled payload did not report stopped.", {
    status: reconciled.status,
  });
  assert(reconciled.termination === "reconciled", "Reconciled payload termination mismatch.", {
    termination: reconciled.termination,
  });
  assert(reconciled.userDataDir === profile.storage.userDataDir, "Reconciled payload userDataDir mismatch.", {
    userDataDir: reconciled.userDataDir,
    expectedUserDataDir: profile.storage.userDataDir,
  });
  return reconciled;
}

function assertProfilesJsonClean(storeRoot, profileId) {
  const profilesPath = join(storeRoot, "profile-store", "profiles.json");
  assert(existsSync(profilesPath), "profiles.json was not written for the smoke profile.");
  const payload = JSON.parse(readFileSync(profilesPath, "utf8"));
  assert(Array.isArray(payload.profiles), "profiles.json profiles field is not an array.");
  const profile = payload.profiles.find((item) => item?.id === profileId);
  assert(profile, "profiles.json does not contain the smoke profile.", { profileId });
  const runtimeFields = Object.keys(profile).filter((key) => FORBIDDEN_PROFILE_RUNTIME_FIELDS.has(key));
  assert(runtimeFields.length === 0, "profiles.json persisted forbidden Chromium runtime truth.", {
    runtimeFields,
  });
  return { profileCount: payload.profiles.length };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForPidGone(pid, timeoutMs = WAIT_STOPPED_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    sleep(100);
  }
  return !isPidAlive(pid);
}

function terminatePid(pid, reason) {
  if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) {
    return { signal: "none", aliveAfter: false };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      fail(`Failed to terminate smoke Chromium PID during ${reason}.`, {
        pid,
        errorCode: error?.code,
      });
    }
  }

  if (waitForPidGone(pid, WAIT_STOPPED_TIMEOUT_MS)) {
    return { signal: "SIGTERM", aliveAfter: false };
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      fail(`Failed to force-kill smoke Chromium PID during ${reason}.`, {
        pid,
        errorCode: error?.code,
      });
    }
  }

  const aliveAfter = !waitForPidGone(pid, WAIT_STOPPED_TIMEOUT_MS);
  return { signal: "SIGKILL", aliveAfter };
}

function makeTempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  rememberSensitive(root);
  return root;
}

function makeRequestId(label) {
  return `verify-s03-${label}`;
}

function runMissingExecutableAssertion() {
  const missingRoot = makeTempRoot("theprivator-s03-missing-");
  const emptyPath = join(missingRoot, "empty-path");
  mkdirSync(emptyPath, { recursive: true });
  const missingExecutable = join(missingRoot, "missing-chromium");
  rememberSensitive(missingExecutable);

  try {
    const create = sidecarSuccess(
      makeRequestId("missing-create"),
      "profiles.create",
      { storeRoot: missingRoot, name: SMOKE_PROFILE_NAME },
    ).result;
    const profile = assertProfileShape(create.profile);

    const { error } = sidecarError(
      makeRequestId("missing-launch"),
      "chromium.launch",
      { storeRoot: missingRoot, profileId: profile.id },
      {
        env: {
          THEPRIVATOR_CHROMIUM_PATH: missingExecutable,
          PATH: emptyPath,
        },
        timeoutMs: CHROMIUM_LAUNCH_TIMEOUT_MS,
      },
    );

    assert(error.code === "CHROMIUM_EXECUTABLE_NOT_FOUND", "Missing Chromium executable did not surface the typed lifecycle code.", {
      errorCode: error.code,
      detailRef: error.detailRef,
    });
    assert(typeof error.detailRef === "string" && error.detailRef.startsWith("sidecar-"), "Missing executable error did not preserve detailRef.", {
      detailRef: error.detailRef,
    });
    return { errorCode: error.code, detailRef: error.detailRef };
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }
}

function runRealChromiumSmoke() {
  const storeRoot = makeTempRoot("theprivator-s03-smoke-");
  let profile;
  const launchedPids = new Set();
  let currentPid = null;

  const cleanup = () => {
    if (profile?.id) {
      try {
        sidecarSuccess(
          makeRequestId("cleanup-stop"),
          "chromium.stop",
          { storeRoot, profileId: profile.id },
          { timeoutMs: SIDECAR_TIMEOUT_MS },
        );
      } catch {
        // The failure path below still kills only PIDs this smoke recorded.
      }
    }

    for (const pid of launchedPids) {
      if (isPidAlive(pid)) {
        terminatePid(pid, "cleanup");
      }
    }

    rmSync(storeRoot, { recursive: true, force: true });
  };

  try {
    profile = runStep("sidecar-profile-create", () => {
      const create = sidecarSuccess(
        makeRequestId("profile-create"),
        "profiles.create",
        { storeRoot, name: SMOKE_PROFILE_NAME },
      ).result;
      const createdProfile = assertProfileShape(create.profile);
      return {
        value: createdProfile,
        log: {
          profileId: createdProfile.id,
          userDataDir: createdProfile.storage.userDataDir,
        },
      };
    });

    const firstLaunch = runStep("chromium-launch", () => {
      const { response, diagnostic } = callSidecar(
        sidecarRequest(
          makeRequestId("launch"),
          "chromium.launch",
          { storeRoot, profileId: profile.id },
        ),
        { timeoutMs: CHROMIUM_LAUNCH_TIMEOUT_MS },
      );

      if (response.ok === false && response.error?.code === "CHROMIUM_EXECUTABLE_NOT_FOUND") {
        fail("Chromium executable was not found for the S03 real-runtime smoke.", {
          errorCode: response.error.code,
          detailRef: response.error.detailRef,
          instruction: "Install Chromium/Chrome or set THEPRIVATOR_CHROMIUM_PATH to a local executable before running npm run verify:s03.",
        });
      }

      assert(response.ok === true, "Chromium launch failed during the S03 real-runtime smoke.", {
        errorCode: response.error?.code,
        detailRef: response.error?.detailRef,
        diagnosticStatus: diagnostic.status,
        diagnosticErrorCode: diagnostic.errorCode,
      });
      assert(diagnostic.status === "ok", "Chromium launch diagnostic did not report ok.", {
        diagnosticStatus: diagnostic.status,
        errorCode: diagnostic.errorCode,
        detailRef: diagnostic.detailRef,
      });
      const running = assertRunningPayload(response.result, profile, 1);
      launchedPids.add(running.pid);
      currentPid = running.pid;
      return {
        value: running,
        log: {
          profileId: running.profileId,
          pid: running.pid,
          lifecycleStatus: running.status,
          runningCount: running.runningCount,
          userDataDir: running.userDataDir,
        },
      };
    });

    runStep("chromium-status-running", () => {
      const status = sidecarSuccess(
        makeRequestId("status-running"),
        "chromium.status",
        { storeRoot },
      ).result;
      const running = assertStatusRunning(status, profile, firstLaunch.pid, firstLaunch.startedAt);
      return {
        profileId: running.profileId,
        pid: running.pid,
        lifecycleStatus: running.status,
        runningCount: status.runningCount,
      };
    });

    const stopped = runStep("chromium-stop", () => {
      const stop = sidecarSuccess(
        makeRequestId("stop"),
        "chromium.stop",
        { storeRoot, profileId: profile.id },
        { timeoutMs: SIDECAR_TIMEOUT_MS },
      ).result;
      const stoppedPayload = assertStoppedPayload(stop, profile);
      assert(waitForPidGone(firstLaunch.pid, WAIT_STOPPED_TIMEOUT_MS), "Chromium PID remained alive after sidecar stop.", {
        pid: firstLaunch.pid,
      });
      currentPid = null;
      return {
        value: stoppedPayload,
        log: {
          profileId: stoppedPayload.profileId,
          previousPid: firstLaunch.pid,
          lifecycleStatus: stoppedPayload.status,
          termination: stoppedPayload.termination,
          runningCount: stoppedPayload.runningCount,
        },
      };
    });

    runStep("chromium-status-stopped", () => {
      const status = sidecarSuccess(
        makeRequestId("status-stopped"),
        "chromium.status",
        { storeRoot },
      ).result;
      assertStatusStopped(status);
      return {
        runningCount: status.runningCount,
        profileCount: status.profiles.length,
        reconciledCount: status.reconciled.length,
        previousTermination: stopped.termination,
      };
    });

    const secondLaunch = runStep("chromium-relaunch", () => {
      const relaunch = sidecarSuccess(
        makeRequestId("relaunch"),
        "chromium.launch",
        { storeRoot, profileId: profile.id },
        { timeoutMs: CHROMIUM_LAUNCH_TIMEOUT_MS },
      ).result;
      const running = assertRunningPayload(relaunch, profile, 1);
      launchedPids.add(running.pid);
      currentPid = running.pid;
      return {
        value: running,
        log: {
          profileId: running.profileId,
          pid: running.pid,
          lifecycleStatus: running.status,
          runningCount: running.runningCount,
        },
      };
    });

    runStep("chromium-external-close", () => {
      const termination = terminatePid(secondLaunch.pid, "external-close");
      assert(termination.aliveAfter === false, "Externally terminated smoke Chromium PID is still alive.", {
        pid: secondLaunch.pid,
        signal: termination.signal,
      });
      currentPid = null;
      return {
        profileId: profile.id,
        pid: secondLaunch.pid,
        externalSignal: termination.signal,
        aliveAfter: termination.aliveAfter,
      };
    });

    runStep("chromium-status-reconciled", () => {
      const status = sidecarSuccess(
        makeRequestId("status-reconciled"),
        "chromium.status",
        { storeRoot },
      ).result;
      const reconciled = assertReconciledStatus(status, profile);
      return {
        profileId: reconciled.profileId,
        lifecycleStatus: reconciled.status,
        termination: reconciled.termination,
        runningCount: status.runningCount,
        reconciledCount: status.reconciled.length,
      };
    });

    runStep("profile-store-clean", () => {
      const clean = assertProfilesJsonClean(storeRoot, profile.id);
      return {
        profileId: profile.id,
        profileCount: clean.profileCount,
        persistedRuntimeFields: 0,
      };
    });

    return {
      profileId: profile.id,
      launchPid: firstLaunch.pid,
      relaunchPid: secondLaunch.pid,
      stoppedTermination: stopped.termination,
    };
  } catch (error) {
    if (currentPid !== null && isPidAlive(currentPid)) {
      const cleanup = terminatePid(currentPid, "failure");
      emit({
        step: "chromium-cleanup-pid",
        status: cleanup.aliveAfter ? "fail" : "pass",
        pid: currentPid,
        signal: cleanup.signal,
      });
    }
    throw error;
  } finally {
    cleanup();
  }
}

function runRegressionCommands() {
  runCommand(
    "python-lifecycle-contract-tests",
    PYTHON,
    ["-m", "pytest", "theprivator/tests/test_chromium_lifecycle.py", "theprivator/tests/test_sidecar_contract.py"],
    120_000,
    { label: `${PYTHON_LABEL} -m pytest theprivator/tests/test_chromium_lifecycle.py theprivator/tests/test_sidecar_contract.py` },
  );
  runCommand("rust-bridge-tests", "cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], 180_000);
  runCommand("node-ui-client-tests", "npm", ["test", "--", "--run"], 120_000);
  runCommand("frontend-build", "npm", ["run", "build"], 120_000);
}

try {
  runRegressionCommands();
  runStep("missing-executable-typed-error", runMissingExecutableAssertion);
  const smoke = runStep("real-chromium-launch-stop-smoke", runRealChromiumSmoke);

  emit({
    status: "pass",
    proof: smoke,
    checks: STEP_RESULTS,
  });
} catch {
  emit({
    status: "fail",
    checks: STEP_RESULTS,
  });
  process.exit(1);
}
