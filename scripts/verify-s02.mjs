import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
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
const PRESET_ID = "ubuntu-linux-chrome-120";
const SMOKE_PROFILE_NAME = "S02 Identity Proof Profile Should Not Leak";
const SIDECAR_TIMEOUT_MS = 15_000;
const CHROMIUM_LAUNCH_TIMEOUT_MS = 35_000;
const PROOF_TIMEOUT_MS = 25_000;
const PACKAGE_BUILD_TIMEOUT_MS = 300_000;
const PACKAGE_SMOKE_TIMEOUT_MS = 60_000;
const STEP_RESULTS = [];
const SENSITIVE_VALUES = new Set([ROOT_DIR]);
const PUBLIC_FORBIDDEN_MARKERS = [
  "DevToolsActivePort",
  "ws://",
  "wss://",
  "--remote-debugging-port",
  "--user-data-dir",
  "--load-extension",
  "--disable-extensions-except",
  "debugPort",
  "9222",
  "identity-extensions",
  "identity_config.js",
  "identity_protector.js",
  "__THEPRIVATOR_IDENTITY_CONFIG__",
  "Traceback",
];
const FORBIDDEN_PROFILE_RUNTIME_FIELDS = new Set([
  "pid",
  "process",
  "command",
  "status",
  "running",
  "stoppedAt",
  "startedAt",
  "termination",
  "extensionConfig",
  "cdpOverrides",
  "debugPort",
]);

const PROOF_COLLECTOR = String.raw`
import json
import sys
from theprivator_sidecar.identity_proof import collect_identity_proof_for_user_data_dir
from theprivator_sidecar.protocol import IDENTITY_PROOF_FAILED, SidecarError

try:
    proof = collect_identity_proof_for_user_data_dir(
        sys.argv[1],
        discovery_timeout_seconds=10.0,
        proof_timeout_seconds=8.0,
    )
    print(json.dumps({"ok": True, "proof": proof}, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
except SidecarError as exc:
    print(json.dumps({"ok": False, "error": exc.to_dict()}, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    raise SystemExit(2)
except Exception:
    print(json.dumps({"ok": False, "error": {"code": IDENTITY_PROOF_FAILED, "message": "Identity proof could not be collected.", "recoverable": True, "detailRef": "sidecar-proof-failed"}}, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    raise SystemExit(2)
`;

class VerifyFailure extends Error {
  constructor(message, details) {
    super(message);
    this.name = "VerifyFailure";
    this.details = details;
  }
}

function emit(event) {
  console.log(JSON.stringify({ event: "verify.s02", ...event }));
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
    return redacted
      .replace(/ws:\/\/[^\s"']+/gi, "ws://<redacted>")
      .replace(/wss:\/\/[^\s"']+/gi, "wss://<redacted>")
      .replace(/--remote-debugging-port(?:=|\s+)\d+/gi, "--remote-debugging-port=<redacted>")
      .replace(/debugPort[\"':\s=]+\d+/gi, "debugPort=<redacted>")
      .replace(/9222/g, "<redacted-port>");
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
          detail: "The child process was terminated by verify:s02.",
          stdoutTail: normalizeOutput(result.stdout),
          stderrTail: normalizeOutput(result.stderr),
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

  return { response, diagnostic, stdout: result.stdout, stderr: result.stderr };
}

function sidecarRequest(id, method, params) {
  return { id, method, params };
}

function sidecarSuccess(id, method, params, options = {}) {
  const result = callSidecar(sidecarRequest(id, method, params), options);
  const { response, diagnostic } = result;
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
  return { result: response.result, response, diagnostic, stdout: result.stdout, stderr: result.stderr };
}

function sidecarError(id, method, params, options = {}) {
  const result = callSidecar(sidecarRequest(id, method, params), options);
  const { response, diagnostic } = result;
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
  return { error: response.error, response, diagnostic, stdout: result.stdout, stderr: result.stderr };
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
  assert(isSafeRelativeStoragePath(profile.storage.userDataDir), "Created profile userDataDir is not a safe relative path.", {
    userDataDir: profile.storage.userDataDir,
  });
  return profile;
}

function assertRunningPayload(payload, profile) {
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
  assert(payload.runningCount === undefined || payload.runningCount === 1, "Chromium running count mismatch.", {
    runningCount: payload.runningCount,
  });
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
  assert(["graceful", "forced", "reconciled", "already-stopped"].includes(payload.termination), "Chromium stop payload termination was unexpected.", {
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

function readJsonIfExists(path, fallback = null) {
  if (!existsSync(path)) {
    return fallback;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function textIfExists(path) {
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf8");
}

function makeTempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  rememberSensitive(root);
  return root;
}

function makeRequestId(label) {
  return `verify-s02-${label}`;
}

function assertPresetList(result) {
  assert(result.identityVersion === 1, "Preset list did not return identityVersion 1.", {
    identityVersion: result.identityVersion,
  });
  assert(Array.isArray(result.presets), "Preset list did not return presets array.");
  assert(result.count === result.presets.length, "Preset list count mismatch.", {
    count: result.count,
    presetCount: result.presets.length,
  });
  const preset = result.presets.find((item) => item?.presetId === PRESET_ID);
  assert(preset, "Preset list did not include the S02 curated proof preset.", {
    presetId: PRESET_ID,
    availableCount: result.presets.length,
  });
  return preset;
}

function assertAppliedIdentity(result, profile, preset) {
  assert(result.storeVersion === 3, "Identity apply did not preserve store v3.", {
    storeVersion: result.storeVersion,
  });
  assert(Array.isArray(result.warnings), "Identity apply did not return warnings array.");
  assert(result.warnings.length === 0, "Curated S02 preset should not warn.", {
    warnings: result.warnings,
  });
  assert(result.profile?.id === profile.id, "Identity apply profile id mismatch.", {
    profileId: result.profile?.id,
    expectedProfileId: profile.id,
  });
  assert(result.profile?.identity?.presetId === PRESET_ID, "Identity apply did not persist the selected preset id.", {
    presetId: result.profile?.identity?.presetId,
  });
  assert(JSON.stringify(result.profile.identity) === JSON.stringify(preset), "Persisted identity does not match the curated preset payload.", {
    presetId: PRESET_ID,
  });
  return result.profile.identity;
}

function assertEqual(actual, expected, surface) {
  assert(Object.is(actual, expected), `${surface} mismatch.`, { surface, expected, observed: actual });
}

function assertNumberEqual(actual, expected, surface) {
  assert(typeof actual === "number" && Math.abs(actual - expected) < 0.0001, `${surface} mismatch.`, {
    surface,
    expected,
    observed: actual,
  });
}

function assertArrayEqual(actual, expected, surface) {
  assert(Array.isArray(actual), `${surface} was not an array.`, { surface, observed: actual });
  assert(actual.length === expected.length && actual.every((value, index) => value === expected[index]), `${surface} mismatch.`, {
    surface,
    expected,
    observed: actual,
  });
}

function assertObservedIdentity(proof, identity) {
  assert(proof?.schemaVersion === 1, "Proof observation schema version mismatch.", {
    schemaVersion: proof?.schemaVersion,
  });

  assertEqual(proof.browser?.userAgent, identity.browser.userAgent, "browser.userAgent");
  const uaData = proof.browser?.userAgentData;
  assert(uaData && uaData.supported === true, "navigator.userAgentData should be exposed for the curated S02 preset.", {
    userAgentData: uaData,
  });
  assertEqual(uaData.platform, identity.browser.clientHints.platform, "browser.userAgentData.platform");
  assertEqual(uaData.mobile, identity.browser.clientHints.mobile, "browser.userAgentData.mobile");
  assertEqual(uaData.highEntropy?.platform, identity.browser.clientHints.platform, "browser.userAgentData.highEntropy.platform");
  assertEqual(uaData.highEntropy?.platformVersion, identity.browser.clientHints.platformVersion, "browser.userAgentData.highEntropy.platformVersion");
  assertEqual(uaData.highEntropy?.architecture, identity.browser.clientHints.architecture, "browser.userAgentData.highEntropy.architecture");

  assertEqual(proof.navigator?.platform, identity.navigator.platform, "navigator.platform");
  assertNumberEqual(proof.navigator?.hardwareConcurrency, identity.navigator.hardwareConcurrency, "navigator.hardwareConcurrency");
  assertNumberEqual(proof.navigator?.deviceMemory, identity.navigator.deviceMemory, "navigator.deviceMemory");

  assertEqual(proof.locale?.language, identity.locale.locale, "navigator.language");
  assertArrayEqual(proof.locale?.languages, identity.locale.languages, "navigator.languages");
  assertEqual(proof.locale?.timezone, identity.locale.timezoneId, "Intl.DateTimeFormat.timeZone");

  assertNumberEqual(proof.viewport?.innerWidth, identity.screen.viewportWidth, "viewport.innerWidth");
  assertNumberEqual(proof.viewport?.innerHeight, identity.screen.viewportHeight, "viewport.innerHeight");
  assertNumberEqual(proof.viewport?.devicePixelRatio, identity.screen.pixelRatio, "viewport.devicePixelRatio");
  assertNumberEqual(proof.viewport?.screen?.width, identity.screen.width, "screen.width");
  assertNumberEqual(proof.viewport?.screen?.height, identity.screen.height, "screen.height");
  assertNumberEqual(proof.viewport?.screen?.colorDepth, identity.screen.colorDepth, "screen.colorDepth");

  assert(proof.webgl?.supported === true, "WebGL should be available for the S02 representative proof.", {
    webgl: proof.webgl,
  });
  assertEqual(proof.webgl.vendor, identity.webgl.vendor, "webgl.vendor");
  assertEqual(proof.webgl.renderer, identity.webgl.renderer, "webgl.renderer");

  assert(proof.canvas?.supported === true, "Canvas should be available for the S02 representative proof.", {
    canvas: proof.canvas,
  });
  assert(typeof proof.canvas.signature === "string" && proof.canvas.signature.startsWith("data:image/png"), "Canvas proof did not return a deterministic data URL marker.", {
    canvas: proof.canvas,
  });

  assert(proof.audio?.supported === true, "Audio proof should report support for the representative S02 marker.", {
    audio: proof.audio,
  });
  assert(Array.isArray(proof.audio.sample) && proof.audio.sample.length >= 3, "Audio proof did not return a deterministic sample marker.", {
    audio: proof.audio,
  });

  assert(proof.webrtc?.supported === true, "WebRTC proof should report constructor availability.", {
    webrtc: proof.webrtc,
  });
  assertEqual(proof.webrtc.icePolicy, "relay", "webrtc.iceTransportPolicy");

  return {
    userAgent: "matched",
    clientHints: "matched",
    navigator: "matched",
    locale: "matched",
    viewport: "matched",
    webgl: "matched",
    canvas: "marker-present",
    audio: "marker-present",
    webrtc: "relay",
  };
}

function runProofCollector(userDataPath) {
  rememberSensitive(userDataPath);
  const result = spawnSync(PYTHON, ["-c", PROOF_COLLECTOR, userDataPath], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROOF_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      fail("Identity proof collector timed out.", {
        timeoutMs: PROOF_TIMEOUT_MS,
        stdoutTail: normalizeOutput(result.stdout),
        stderrTail: normalizeOutput(result.stderr),
      });
    }
    fail("Identity proof collector process failed.", {
      error: result.error.message,
      stdoutTail: normalizeOutput(result.stdout),
      stderrTail: normalizeOutput(result.stderr),
    });
  }

  assert(!result.stderr.trim(), "Identity proof collector wrote to stderr.", {
    stderrTail: normalizeOutput(result.stderr),
  });
  const [payload] = parseNdjsonLines("proof stdout", result.stdout, 1);
  if (result.status !== 0 || payload.ok !== true) {
    fail("Identity proof collector failed.", {
      exitCode: result.status,
      errorCode: payload.error?.code,
      detailRef: payload.error?.detailRef,
      message: payload.error?.message,
      stdoutTail: normalizeOutput(result.stdout),
    });
  }
  assert(payload.proof && typeof payload.proof === "object", "Identity proof collector returned no proof payload.");
  return { proof: payload.proof, stdout: result.stdout, stderr: result.stderr };
}

function assertProfilesJsonClean(storeRoot, profileId) {
  const profilesPath = join(storeRoot, "profile-store", "profiles.json");
  assert(existsSync(profilesPath), "profiles.json was not written for the S02 proof profile.");
  const payload = JSON.parse(readFileSync(profilesPath, "utf8"));
  assert(payload.storeVersion === 3, "profiles.json did not remain store v3.", {
    storeVersion: payload.storeVersion,
  });
  assert(Array.isArray(payload.profiles), "profiles.json profiles field is not an array.");
  const profile = payload.profiles.find((item) => item?.id === profileId);
  assert(profile, "profiles.json does not contain the S02 proof profile.", { profileId });
  const runtimeFields = Object.keys(profile).filter((key) => FORBIDDEN_PROFILE_RUNTIME_FIELDS.has(key));
  assert(runtimeFields.length === 0, "profiles.json persisted forbidden Chromium runtime/config truth.", {
    runtimeFields,
  });
  assert(profile.identity?.presetId === PRESET_ID, "profiles.json did not retain the curated preset identity.", {
    presetId: profile.identity?.presetId,
  });
  return { profileCount: payload.profiles.length, storeVersion: payload.storeVersion };
}

function assertRuntimeRegistryEmpty(storeRoot) {
  const registryPath = join(storeRoot, "profile-store", "runtime", "chromium-processes.json");
  const payload = readJsonIfExists(registryPath, { registryVersion: 1, processes: {} });
  assert(payload.registryVersion === 1, "Runtime registry version mismatch after stop.", {
    registryVersion: payload.registryVersion,
  });
  assert(payload.processes && typeof payload.processes === "object" && !Array.isArray(payload.processes), "Runtime registry processes field is invalid.", {
    processes: payload.processes,
  });
  assert(Object.keys(payload.processes).length === 0, "Runtime registry retained processes after stop.", {
    processCount: Object.keys(payload.processes).length,
  });
  return { processCount: 0 };
}

function assertNoPublicLeaks({ storeRoot, profile, transcripts, proofTranscript }) {
  const profilesPath = join(storeRoot, "profile-store", "profiles.json");
  const registryPath = join(storeRoot, "profile-store", "runtime", "chromium-processes.json");
  const diagnosticsPath = join(storeRoot, "profile-store", "diagnostics", "events.jsonl");
  const extensionRoot = join(storeRoot, "profile-store", "runtime", "identity-extensions");
  const userDataPath = join(storeRoot, ...profile.storage.userDataDir.split("/"));
  rememberSensitive(extensionRoot);
  rememberSensitive(userDataPath);

  const publicResponses = transcripts.map((item) => ({ response: item.response, diagnostic: item.diagnostic }));
  const combinedPublic = [
    JSON.stringify(publicResponses),
    proofTranscript?.stdout ?? "",
    proofTranscript?.stderr ?? "",
    textIfExists(profilesPath),
    textIfExists(registryPath),
    textIfExists(diagnosticsPath),
  ].join("\n");

  for (const sensitive of [storeRoot, extensionRoot, userDataPath]) {
    assert(!combinedPublic.includes(sensitive), "Public/persisted verifier surfaces leaked an app-owned absolute path.", {
      leaked: sensitive === storeRoot ? "storeRoot" : "runtimePath",
    });
  }

  for (const marker of PUBLIC_FORBIDDEN_MARKERS) {
    assert(!combinedPublic.includes(marker), "Public/persisted verifier surfaces leaked a forbidden debug/config marker.", {
      marker,
    });
  }

  const diagnosticsText = textIfExists(diagnosticsPath);
  if (diagnosticsText) {
    const lines = diagnosticsText.split(/\r?\n/).filter(Boolean);
    assert(lines.length >= 1, "Persisted diagnostics did not record any store-root sidecar proof steps.", {
      diagnosticLines: lines.length,
      sidecarRequests: transcripts.length,
    });
    for (const [index, line] of lines.entries()) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        fail("Persisted diagnostic line is not valid JSON.", {
          lineNumber: index + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      assert(parsed.event === "sidecar.request", "Persisted diagnostic event name changed.", {
        lineNumber: index + 1,
        event: parsed.event,
      });
      assert(!("params" in parsed), "Persisted diagnostic leaked params.", {
        lineNumber: index + 1,
      });
    }
  }

  return {
    responseCount: transcripts.length,
    diagnosticsPresent: existsSync(diagnosticsPath),
    forbiddenMarkers: 0,
  };
}

function runMissingExecutableAssertion() {
  const missingRoot = makeTempRoot("theprivator-s02-missing-");
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
    return { errorCode: error.code, detailRef: error.detailRef };
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }
}

function runRealChromiumIdentityProof() {
  const storeRoot = makeTempRoot("theprivator-s02-proof-");
  const transcripts = [];
  let profile;
  let launched = null;
  let proofTranscript = null;

  function rememberTranscript(result) {
    transcripts.push(result);
    return result;
  }

  function cleanup() {
    if (profile?.id) {
      try {
        rememberTranscript(sidecarSuccess(
          makeRequestId("cleanup-stop"),
          "chromium.stop",
          { storeRoot, profileId: profile.id },
          { timeoutMs: SIDECAR_TIMEOUT_MS },
        ));
      } catch {
        // The failing step still reports safe details; cleanup must not mask it.
      }
    }
    rmSync(storeRoot, { recursive: true, force: true });
  }

  try {
    profile = runStep("profiles-create", () => {
      const create = rememberTranscript(sidecarSuccess(
        makeRequestId("profile-create"),
        "profiles.create",
        { storeRoot, name: SMOKE_PROFILE_NAME },
      )).result;
      assert(create.storeVersion === 3, "Profile create did not return store v3.", {
        storeVersion: create.storeVersion,
      });
      const createdProfile = assertProfileShape(create.profile);
      return {
        value: createdProfile,
        log: {
          profileId: createdProfile.id,
          userDataDir: createdProfile.storage.userDataDir,
        },
      };
    });

    const preset = runStep("identity-presets-list", () => {
      const presets = rememberTranscript(sidecarSuccess(
        makeRequestId("presets-list"),
        "identity.presets.list",
        {},
      )).result;
      const selected = assertPresetList(presets);
      return {
        value: selected,
        log: { presetId: selected.presetId, presetCount: presets.count },
      };
    });

    const identity = runStep("identity-apply-preset", () => {
      const applied = rememberTranscript(sidecarSuccess(
        makeRequestId("apply-preset"),
        "profiles.identity.applyPreset",
        { storeRoot, profileId: profile.id, presetId: PRESET_ID },
      )).result;
      const selectedIdentity = assertAppliedIdentity(applied, profile, preset);
      return {
        value: selectedIdentity,
        log: { profileId: profile.id, presetId: PRESET_ID, warningCount: applied.warnings.length },
      };
    });

    launched = runStep("chromium-launch", () => {
      const result = rememberTranscript(callSidecar(
        sidecarRequest(
          makeRequestId("launch"),
          "chromium.launch",
          { storeRoot, profileId: profile.id },
        ),
        { timeoutMs: CHROMIUM_LAUNCH_TIMEOUT_MS },
      ));
      const { response, diagnostic } = result;
      if (response.ok === false && response.error?.code === "CHROMIUM_EXECUTABLE_NOT_FOUND") {
        fail("Chromium executable was not found for the S02 identity proof.", {
          errorCode: response.error.code,
          detailRef: response.error.detailRef,
          instruction: "Install Chromium/Chrome or set THEPRIVATOR_CHROMIUM_PATH to a local executable before running npm run verify:s02.",
        });
      }
      assert(response.ok === true, "Chromium launch failed during the S02 identity proof.", {
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
      const running = assertRunningPayload(response.result, profile);
      const userDataPath = join(storeRoot, ...profile.storage.userDataDir.split("/"));
      rememberSensitive(userDataPath);
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

    const proof = runStep("identity-proof-collect", () => {
      const userDataPath = join(storeRoot, ...profile.storage.userDataDir.split("/"));
      proofTranscript = runProofCollector(userDataPath);
      const observed = assertObservedIdentity(proofTranscript.proof, identity);
      return {
        value: proofTranscript.proof,
        log: { profileId: profile.id, observed },
      };
    });

    runStep("chromium-stop", () => {
      const stop = rememberTranscript(sidecarSuccess(
        makeRequestId("stop"),
        "chromium.stop",
        { storeRoot, profileId: profile.id },
        { timeoutMs: SIDECAR_TIMEOUT_MS },
      )).result;
      const stopped = assertStoppedPayload(stop, profile);
      launched = null;
      return {
        profileId: stopped.profileId,
        lifecycleStatus: stopped.status,
        termination: stopped.termination,
        runningCount: stopped.runningCount,
      };
    });

    runStep("chromium-status-stopped", () => {
      const status = rememberTranscript(sidecarSuccess(
        makeRequestId("status-stopped"),
        "chromium.status",
        { storeRoot },
      )).result;
      assertStatusStopped(status);
      return {
        runningCount: status.runningCount,
        profileCount: status.profiles.length,
        reconciledCount: status.reconciled.length,
      };
    });

    runStep("runtime-registry-empty", () => assertRuntimeRegistryEmpty(storeRoot));
    runStep("profiles-json-clean", () => assertProfilesJsonClean(storeRoot, profile.id));
    runStep("redaction-leak-check", () => assertNoPublicLeaks({ storeRoot, profile, transcripts, proofTranscript }));

    return {
      profileId: profile.id,
      presetId: PRESET_ID,
      launchPid: launched?.pid ?? null,
      proofSchemaVersion: proof.schemaVersion,
    };
  } finally {
    cleanup();
  }
}

function runPackageGuard() {
  runCommand("sidecar-build", "npm", ["run", "sidecar:build"], PACKAGE_BUILD_TIMEOUT_MS);
  runCommand("built-sidecar-smoke", "npm", ["run", "verify:sidecar"], PACKAGE_SMOKE_TIMEOUT_MS);
  return { build: "passed", smoke: "passed" };
}

try {
  runStep("missing-executable-typed-error", runMissingExecutableAssertion);
  const proof = runStep("real-chromium-identity-proof", runRealChromiumIdentityProof);
  const packageGuard = runStep("package-smoke-guard", runPackageGuard);

  emit({
    status: "pass",
    proof,
    packageGuard,
    checks: STEP_RESULTS,
  });
} catch {
  emit({
    status: "fail",
    checks: STEP_RESULTS,
  });
  process.exit(1);
}
