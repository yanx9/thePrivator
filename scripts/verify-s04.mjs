import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
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
const SIDECAR_NAME = "theprivator-sidecar";
const EXTENSION = process.platform === "win32" ? ".exe" : "";
const PRESET_ID = "ubuntu-linux-chrome-120";
const PROOF_PROFILE_NAME = "S04 Identity Proof Profile Should Not Leak";
const BASELINE_PROFILE_NAME = "S04 Identity Baseline Profile Should Not Leak";
const SIDECAR_TIMEOUT_MS = 15_000;
const CHROMIUM_LAUNCH_TIMEOUT_MS = 35_000;
const PROOF_TIMEOUT_MS = 35_000;
const PACKAGE_BUILD_TIMEOUT_MS = 300_000;
const BUILT_SIDECAR_TIMEOUT_MS = 60_000;
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
  "public checker",
  "browserleaks",
  "creepjs",
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
const FORBIDDEN_DIAGNOSTIC_KEYS = new Set([
  "params",
  "legacyRoot",
  "storeRoot",
  "items",
  "targetName",
  "folderName",
  "legacyName",
  "message",
  "stack",
  "traceback",
  "command",
  "env",
  "stdout",
  "stderr",
]);
const REQUIRED_SURFACE_LABELS = [
  "headers.userAgent",
  "headers.acceptLanguage",
  "headers.clientHints",
  "target.initial.browser.userAgent",
  "target.initial.browser.userAgentData",
  "target.initial.navigator",
  "target.initial.locale",
  "target.initial.viewport",
  "target.initial.canvas",
  "target.initial.webgl",
  "target.initial.audio",
  "target.initial.webrtc",
  "target.new.browser.userAgent",
  "target.new.browser.userAgentData",
  "target.new.navigator",
  "target.new.locale",
  "target.new.viewport",
  "target.new.canvas",
  "target.new.webgl",
  "target.new.audio",
  "target.new.webrtc",
];

const PROOF_COLLECTOR = String.raw`
import json
import sys
from theprivator_sidecar.identity_proof import collect_identity_surface_proof_for_user_data_dir
from theprivator_sidecar.protocol import IDENTITY_PROOF_FAILED, SidecarError

try:
    proof = collect_identity_surface_proof_for_user_data_dir(
        sys.argv[1],
        discovery_timeout_seconds=10.0,
        proof_timeout_seconds=10.0,
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
  console.log(JSON.stringify({ event: "verify.s04", ...event }));
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
    for (const sensitive of Array.from(SENSITIVE_VALUES).filter(Boolean).sort((a, b) => b.length - a.length)) {
      redacted = redacted.split(sensitive).join(resolve(sensitive) === resolve(ROOT_DIR) ? "<repo>" : "<redacted>");
    }
    return redacted
      .replace(/ws:\/\/[^\s"']+/gi, "ws://<redacted>")
      .replace(/wss:\/\/[^\s"']+/gi, "wss://<redacted>")
      .replace(/--remote-debugging-port(?:=|\s+)\d+/gi, "--remote-debugging-port=<redacted>")
      .replace(/--user-data-dir(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)/gi, "--user-data-dir=<redacted>")
      .replace(/debugPort["':\s=]+\d+/gi, "debugPort=<redacted>")
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
          detail: "The child process was terminated by verify:s04.",
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

function parseNdjsonLines(streamName, value, expectedCount = undefined) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (expectedCount !== undefined && lines.length !== expectedCount) {
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

function callSourceSidecar(request, options = {}) {
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

  assertNoUnsafeText(result.stdout, `${request.method}.stdout`);
  assertNoUnsafeText(result.stderr, `${request.method}.stderr`);
  const [response] = parseNdjsonLines("source sidecar stdout", result.stdout, 1);
  const diagnostics = parseNdjsonLines("source sidecar stderr", result.stderr);
  assert(diagnostics.length >= 1, "Source sidecar emitted no diagnostics.", { method: request.method });
  assertRequestDiagnostic(diagnostics[0], request);
  return { response, diagnostic: diagnostics[0], diagnostics, stdout: result.stdout, stderr: result.stderr };
}

function sidecarRequest(id, method, params) {
  return { id, method, params };
}

function sidecarSuccess(id, method, params, options = {}) {
  const result = callSourceSidecar(sidecarRequest(id, method, params), options);
  const { response, diagnostic } = result;
  assert(response.id === id, "Sidecar success response id mismatch.", { method, responseId: response.id });
  assert(response.ok === true, `Expected ${method} to succeed.`, {
    method,
    errorCode: response.error?.code,
    detailRef: response.error?.detailRef,
  });
  assert(response.protocolVersion === "1.0.0", "Sidecar protocol version changed.", { method, protocolVersion: response.protocolVersion });
  assert(response.result && typeof response.result === "object" && !Array.isArray(response.result), "Success result must be an object.", { method });
  assert(diagnostic.status === "ok", "Successful request diagnostic did not report ok.", diagnostic);
  assert(diagnostic.errorCode === null, "Successful diagnostic had an errorCode.", diagnostic);
  assert(diagnostic.detailRef === null, "Successful diagnostic had a detailRef.", diagnostic);
  return { result: response.result, response, diagnostic, diagnostics: result.diagnostics, stdout: result.stdout, stderr: result.stderr };
}

function sidecarError(id, method, params, options = {}) {
  const result = callSourceSidecar(sidecarRequest(id, method, params), options);
  const { response, diagnostic } = result;
  assert(response.id === id, "Sidecar error response id mismatch.", { method, responseId: response.id });
  assert(response.ok === false, `Expected ${method} to fail safely.`, { method, result: response.result });
  assert(response.protocolVersion === "1.0.0", "Sidecar protocol version changed.", { method, protocolVersion: response.protocolVersion });
  assert(response.error && typeof response.error === "object", "Sidecar error response is missing error.", { method });
  assert(response.error.recoverable === true, "Sidecar error was not recoverable.", response.error);
  assert(typeof response.error.detailRef === "string" && response.error.detailRef.startsWith("sidecar-"), "Sidecar error lost detailRef.", response.error);
  assert(diagnostic.status === "error", "Error request diagnostic did not report error.", diagnostic);
  assert(diagnostic.errorCode === response.error.code, "Error diagnostic code mismatch.", diagnostic);
  assert(diagnostic.detailRef === response.error.detailRef, "Error diagnostic detailRef mismatch.", diagnostic);
  return { error: response.error, response, diagnostic, diagnostics: result.diagnostics, stdout: result.stdout, stderr: result.stderr };
}

function assertRequestDiagnostic(diagnostic, request) {
  assert(diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic), "Request diagnostic is not an object.", diagnostic);
  assert(diagnostic.event === "sidecar.request", "Request diagnostic event name changed.", diagnostic);
  assert(diagnostic.requestId === request.id, "Request diagnostic id mismatch.", diagnostic);
  assert(diagnostic.method === request.method, "Request diagnostic method mismatch.", diagnostic);
  assert("status" in diagnostic, "Request diagnostic is missing status.", diagnostic);
  assert("durationMs" in diagnostic, "Request diagnostic is missing durationMs.", diagnostic);
  assert("errorCode" in diagnostic, "Request diagnostic is missing errorCode.", diagnostic);
  assert("detailRef" in diagnostic, "Request diagnostic is missing detailRef.", diagnostic);
  for (const key of Object.keys(diagnostic)) {
    assert(!FORBIDDEN_DIAGNOSTIC_KEYS.has(key), "Request diagnostic leaked forbidden shape.", { key, diagnostic });
  }
}

function assertNoUnsafeText(value, surface) {
  const text = String(value ?? "");
  for (const sensitive of SENSITIVE_VALUES) {
    assert(!text.includes(sensitive), "Verifier surface leaked a sensitive value.", { surface });
  }
  for (const marker of PUBLIC_FORBIDDEN_MARKERS) {
    assert(!text.includes(marker), "Verifier surface leaked a forbidden debug/config marker.", { surface, marker });
  }
}

function isSafeRelativeStoragePath(value) {
  return typeof value === "string"
    && value.startsWith("profile-store/profiles/")
    && value.endsWith("/user-data")
    && !value.startsWith("/")
    && !value.includes("..");
}

function assertProfileShape(profile, expectedName) {
  assert(profile && typeof profile === "object" && !Array.isArray(profile), "Created profile payload is missing.");
  assert(typeof profile.id === "string" && profile.id.length > 0, "Created profile is missing id.");
  assert(profile.name === expectedName, "Created profile name mismatch.", { profileName: profile.name });
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
  assert(payload.status === "running", "Chromium payload did not report running.", { status: payload.status });
  assert(Number.isInteger(payload.pid) && payload.pid > 0, "Chromium running payload is missing a positive PID.", { pid: payload.pid });
  assert(typeof payload.startedAt === "string" && payload.startedAt.endsWith("Z"), "Chromium running payload is missing startedAt.", {
    startedAt: payload.startedAt,
  });
  assert(payload.userDataDir === profile.storage.userDataDir, "Chromium running payload userDataDir mismatch.", {
    userDataDir: payload.userDataDir,
    expectedUserDataDir: profile.storage.userDataDir,
  });
  return payload;
}

function assertStoppedPayload(payload, profile) {
  assert(payload.profileId === profile.id, "Chromium stopped payload profile id mismatch.", {
    profileId: payload.profileId,
    expectedProfileId: profile.id,
  });
  assert(payload.status === "stopped", "Chromium stop payload did not report stopped.", { status: payload.status });
  assert(["graceful", "forced", "reconciled", "already-stopped"].includes(payload.termination), "Chromium stop payload termination was unexpected.", {
    termination: payload.termination,
  });
  assert(payload.runningCount >= 0, "Chromium stop payload running count missing.", { runningCount: payload.runningCount });
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
  assert(Array.isArray(payload.reconciled), "Chromium status reconciled field is not an array.", { reconciled: payload.reconciled });
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
  return `verify-s04-${label}`;
}

function assertPresetList(result) {
  assert(result.identityVersion === 1, "Preset list did not return identityVersion 1.", { identityVersion: result.identityVersion });
  assert(Array.isArray(result.presets), "Preset list did not return presets array.");
  assert(result.count === result.presets.length, "Preset list count mismatch.", {
    count: result.count,
    presetCount: result.presets.length,
  });
  const preset = result.presets.find((item) => item?.presetId === PRESET_ID);
  assert(preset, "Preset list did not include the S04 curated proof preset.", {
    presetId: PRESET_ID,
    availableCount: result.presets.length,
  });
  return preset;
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeNoiseBaselineIdentity(preset) {
  const identity = deepCopy(preset);
  identity.label = "S04 noise comparison baseline";
  identity.presetId = null;
  identity.canvas = { mode: "real" };
  identity.audio = { mode: "real" };
  return identity;
}

function assertAppliedIdentity(result, profile, preset) {
  assert(result.storeVersion === 2, "Identity apply did not preserve store v2.", { storeVersion: result.storeVersion });
  assert(Array.isArray(result.warnings), "Identity apply did not return warnings array.");
  assert(result.warnings.length === 0, "Curated S04 preset should not warn.", { warnings: result.warnings });
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

function assertUpdatedIdentity(result, profile, expectedIdentity) {
  assert(result.storeVersion === 2, "Identity update did not preserve store v2.", { storeVersion: result.storeVersion });
  assert(Array.isArray(result.warnings), "Identity update did not return warnings array.");
  assert(result.warnings.length === 0, "Noise baseline identity should not warn.", { warnings: result.warnings });
  assert(result.profile?.id === profile.id, "Identity update profile id mismatch.", {
    profileId: result.profile?.id,
    expectedProfileId: profile.id,
  });
  assert(JSON.stringify(result.profile.identity) === JSON.stringify(expectedIdentity), "Persisted baseline identity mismatch.", {
    profileId: profile.id,
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

function chromeVersionFromUa(userAgent) {
  const match = typeof userAgent === "string" ? userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/) : null;
  return match ? match[1] : "0.0.0.0";
}

function expectedBitness(identity) {
  const raw = identity.browser?.clientHints?.bitness;
  if (typeof raw === "string") {
    return raw;
  }
  const architecture = identity.browser?.clientHints?.architecture ?? identity.navigator?.uaArchitecture;
  return ["x86", "arm"].includes(architecture) ? "64" : "";
}

function assertBrandListIncludes(brands, brandName, expectedVersion, surface) {
  assert(Array.isArray(brands), `${surface} was not an array.`, { surface, observed: brands });
  const match = brands.find((item) => item?.brand === brandName);
  assert(match, `${surface} did not include ${brandName}.`, { surface, brands });
  assert(match.version === expectedVersion, `${surface} ${brandName} version mismatch.`, {
    surface,
    expected: expectedVersion,
    observed: match.version,
  });
}

function assertUserAgentData(uaData, identity, surface) {
  assert(uaData && uaData.supported === true, `${surface} should expose navigator.userAgentData.`, { surface, userAgentData: uaData });
  const hints = identity.browser.clientHints;
  const version = chromeVersionFromUa(identity.browser.userAgent);
  const major = version.split(".", 1)[0];

  assertEqual(uaData.platform, hints.platform, `${surface}.platform`);
  assertEqual(uaData.mobile, hints.mobile, `${surface}.mobile`);
  assertBrandListIncludes(uaData.brands, "Chromium", major, `${surface}.brands`);
  assertBrandListIncludes(uaData.brands, "Google Chrome", major, `${surface}.brands`);

  const highEntropy = uaData.highEntropy;
  assert(highEntropy && typeof highEntropy === "object", `${surface}.highEntropy missing.`, { surface, userAgentData: uaData });
  assertEqual(highEntropy.platform, hints.platform, `${surface}.highEntropy.platform`);
  assertEqual(highEntropy.platformVersion, hints.platformVersion ?? "", `${surface}.highEntropy.platformVersion`);
  assertEqual(highEntropy.architecture, hints.architecture, `${surface}.highEntropy.architecture`);
  assertEqual(highEntropy.bitness, expectedBitness(identity), `${surface}.highEntropy.bitness`);
  assertEqual(highEntropy.model, hints.model ?? "", `${surface}.highEntropy.model`);
  assertEqual(highEntropy.uaFullVersion, version, `${surface}.highEntropy.uaFullVersion`);
  assertBrandListIncludes(highEntropy.fullVersionList, "Chromium", version, `${surface}.highEntropy.fullVersionList`);
  assertBrandListIncludes(highEntropy.fullVersionList, "Google Chrome", version, `${surface}.highEntropy.fullVersionList`);
}

function hasMeaningfulClientHintHeader(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return trimmed !== "" && trimmed !== "\"\"";
}

function assertClientHintHeaders(headers, identity, surface) {
  const hints = identity.browser.clientHints;
  const observed = {};
  if (typeof headers["Sec-CH-UA-Platform"] === "string") {
    observed.platform = headers["Sec-CH-UA-Platform"];
    assert(headers["Sec-CH-UA-Platform"].includes(hints.platform), `${surface}.Sec-CH-UA-Platform mismatch.`, {
      surface,
      expected: hints.platform,
      observed: headers["Sec-CH-UA-Platform"],
    });
  }
  if (typeof headers["Sec-CH-UA-Mobile"] === "string") {
    observed.mobile = headers["Sec-CH-UA-Mobile"];
    assert(headers["Sec-CH-UA-Mobile"].includes(hints.mobile ? "1" : "0"), `${surface}.Sec-CH-UA-Mobile mismatch.`, {
      surface,
      expected: hints.mobile,
      observed: headers["Sec-CH-UA-Mobile"],
    });
  }
  if (typeof headers["Sec-CH-UA-Arch"] === "string") {
    observed.architecture = hasMeaningfulClientHintHeader(headers["Sec-CH-UA-Arch"]) ? "matched" : "empty";
    if (hasMeaningfulClientHintHeader(headers["Sec-CH-UA-Arch"])) {
      assert(headers["Sec-CH-UA-Arch"].includes(hints.architecture), `${surface}.Sec-CH-UA-Arch mismatch.`, {
        surface,
        expected: hints.architecture,
        observed: headers["Sec-CH-UA-Arch"],
      });
    }
  }
  if (typeof headers["Sec-CH-UA-Bitness"] === "string") {
    observed.bitness = hasMeaningfulClientHintHeader(headers["Sec-CH-UA-Bitness"]) ? "matched" : "empty";
    if (hasMeaningfulClientHintHeader(headers["Sec-CH-UA-Bitness"])) {
      assert(headers["Sec-CH-UA-Bitness"].includes(expectedBitness(identity)), `${surface}.Sec-CH-UA-Bitness mismatch.`, {
        surface,
        expected: expectedBitness(identity),
        observed: headers["Sec-CH-UA-Bitness"],
      });
    }
  }
  if (typeof headers["Sec-CH-UA-Full-Version-List"] === "string") {
    observed.fullVersionList = hasMeaningfulClientHintHeader(headers["Sec-CH-UA-Full-Version-List"]) ? "matched" : "empty";
    if (hasMeaningfulClientHintHeader(headers["Sec-CH-UA-Full-Version-List"])) {
      assert(headers["Sec-CH-UA-Full-Version-List"].includes(chromeVersionFromUa(identity.browser.userAgent)), `${surface}.Sec-CH-UA-Full-Version-List mismatch.`, {
        surface,
        expected: chromeVersionFromUa(identity.browser.userAgent),
        observed: headers["Sec-CH-UA-Full-Version-List"],
      });
    }
  }
  return Object.keys(observed).length > 0 ? observed : { exposed: false };
}

function assertHeaders(headers, identity, surface) {
  assert(headers && typeof headers === "object" && !Array.isArray(headers), `${surface} headers missing.`, { surface, headers });
  assertEqual(headers["User-Agent"], identity.browser.userAgent, `${surface}.User-Agent`);
  if (typeof headers["Accept-Language"] === "string") {
    assert(headers["Accept-Language"].includes(identity.locale.languages[0]), `${surface}.Accept-Language mismatch.`, {
      surface,
      expected: identity.locale.languages[0],
      observed: headers["Accept-Language"],
    });
  }
  return {
    userAgent: "matched",
    acceptLanguage: typeof headers["Accept-Language"] === "string" ? "matched" : "not-exposed",
    clientHints: assertClientHintHeaders(headers, identity, surface),
  };
}

function targetObservation(surfaceProof, targetName) {
  const target = surfaceProof?.targets?.[targetName];
  assert(target?.label === targetName, `target.${targetName} label mismatch.`, { targetName, target });
  const observation = target.observation;
  assert(observation?.schemaVersion === 1, `target.${targetName} observation schema mismatch.`, {
    schemaVersion: observation?.schemaVersion,
  });
  return observation;
}

function assertCanvas(canvas, identity, surface, baselineCanvas = null) {
  assert(canvas?.supported === true, `${surface}.canvas should be supported.`, { surface, canvas });
  assert(typeof canvas.signature === "string" && canvas.signature.startsWith("data:image/png"), `${surface}.canvas signature missing.`, {
    surface,
    canvas,
  });
  assert(typeof canvas.firstSignature === "string" && typeof canvas.secondSignature === "string", `${surface}.canvas repeated signatures missing.`, {
    surface,
    canvas,
  });

  if (identity.canvas.mode === "noise") {
    assert(canvas.stable === false || canvas.firstSignature !== canvas.secondSignature, `${surface}.canvas noise was not observable across repeated reads.`, {
      surface,
      first: canvas.firstSignature.slice(0, 40),
      second: canvas.secondSignature.slice(0, 40),
      stable: canvas.stable,
    });
    if (baselineCanvas?.supported === true) {
      assert(canvas.firstSignature !== baselineCanvas.firstSignature, `${surface}.canvas noise did not differ from the no-noise baseline.`, {
        surface,
        expected: "different canvas signature",
        observed: "same canvas signature",
      });
    }
    return "noise-observed";
  }

  assert(canvas.stable === true && canvas.firstSignature === canvas.secondSignature, `${surface}.canvas real-mode baseline was not stable.`, {
    surface,
    stable: canvas.stable,
  });
  return "stable-baseline";
}

function samplesDiffer(actual, baseline) {
  if (!Array.isArray(actual) || !Array.isArray(baseline) || actual.length !== baseline.length) {
    return true;
  }
  return actual.some((value, index) => {
    const other = baseline[index];
    if (value === null || other === null) {
      return value !== other;
    }
    if (typeof value !== "number" || typeof other !== "number") {
      return value !== other;
    }
    return Math.abs(value - other) > 0.000001;
  });
}

function assertAudio(audio, identity, surface, baselineAudio = null) {
  assert(audio?.supported === true, `${surface}.audio should be supported.`, { surface, audio });
  assert(Array.isArray(audio.sample) && audio.sample.length >= 3, `${surface}.audio sample missing.`, { surface, audio });
  assertNumberEqual(audio.analyserFftSize, 32, `${surface}.audio.analyserFftSize`);
  assertNumberEqual(audio.contextSampleRate, 44100, `${surface}.audio.contextSampleRate`);
  if (identity.audio.mode === "noise" && baselineAudio?.supported === true) {
    assert(samplesDiffer(audio.sample, baselineAudio.sample), `${surface}.audio noise did not differ from the no-noise baseline.`, {
      surface,
      expected: "different audio sample",
      observed: "same audio sample",
    });
    return "noise-observed";
  }
  return identity.audio.mode === "noise" ? "sample-present" : "baseline-sample-present";
}

function assertViewportInnerDimension(actual, expected, surface) {
  if (surface.startsWith("target.new.")) {
    assert(typeof actual === "number" && actual > 0 && actual <= expected && expected - actual <= 240, `${surface} outside bounded new-target viewport range.`, {
      surface,
      expected,
      observed: actual,
    });
    return;
  }
  assertNumberEqual(actual, expected, surface);
}

function assertObservationSurfaces(observation, identity, surface, baselineObservation = null) {
  assertEqual(observation.browser?.userAgent, identity.browser.userAgent, `${surface}.browser.userAgent`);
  assertUserAgentData(observation.browser?.userAgentData, identity, `${surface}.browser.userAgentData`);

  assertEqual(observation.navigator?.platform, identity.navigator.platform, `${surface}.navigator.platform`);
  assertNumberEqual(observation.navigator?.hardwareConcurrency, identity.navigator.hardwareConcurrency, `${surface}.navigator.hardwareConcurrency`);
  assertNumberEqual(observation.navigator?.deviceMemory, identity.navigator.deviceMemory, `${surface}.navigator.deviceMemory`);

  assertEqual(observation.locale?.language, identity.locale.locale, `${surface}.locale.language`);
  assertArrayEqual(observation.locale?.languages, identity.locale.languages, `${surface}.locale.languages`);
  assertEqual(observation.locale?.timezone, identity.locale.timezoneId, `${surface}.locale.timezone`);

  assertViewportInnerDimension(observation.viewport?.innerWidth, identity.screen.viewportWidth, `${surface}.viewport.innerWidth`);
  assertViewportInnerDimension(observation.viewport?.innerHeight, identity.screen.viewportHeight, `${surface}.viewport.innerHeight`);
  assertNumberEqual(observation.viewport?.devicePixelRatio, identity.screen.pixelRatio, `${surface}.viewport.devicePixelRatio`);
  assertNumberEqual(observation.viewport?.screen?.width, identity.screen.width, `${surface}.viewport.screen.width`);
  assertNumberEqual(observation.viewport?.screen?.height, identity.screen.height, `${surface}.viewport.screen.height`);
  assertNumberEqual(observation.viewport?.screen?.colorDepth, identity.screen.colorDepth, `${surface}.viewport.screen.colorDepth`);

  assert(observation.webgl?.supported === true, `${surface}.webgl should be supported.`, { surface, webgl: observation.webgl });
  assertEqual(observation.webgl.vendor, identity.webgl.vendor, `${surface}.webgl.vendor`);
  assertEqual(observation.webgl.renderer, identity.webgl.renderer, `${surface}.webgl.renderer`);
  assert(Array.isArray(observation.webgl.pixelSample) && observation.webgl.pixelSample.length === 4, `${surface}.webgl pixel sample missing.`, {
    surface,
    pixelSample: observation.webgl.pixelSample,
  });

  const canvas = assertCanvas(observation.canvas, identity, surface, baselineObservation?.canvas);
  const audio = assertAudio(observation.audio, identity, surface, baselineObservation?.audio);

  assert(observation.webrtc?.supported === true, `${surface}.webrtc should be supported.`, { surface, webrtc: observation.webrtc });
  if (identity.webrtc.policy === "disableNonProxiedUdp") {
    assertEqual(observation.webrtc.icePolicy, "relay", `${surface}.webrtc.icePolicy`);
    assertEqual(observation.webrtc.relayOnly, true, `${surface}.webrtc.relayOnly`);
  } else if (identity.webrtc.policy === "block") {
    assertEqual(observation.webrtc.errorName, "NotAllowedError", `${surface}.webrtc.errorName`);
  } else {
    assert(["all", undefined, null].includes(observation.webrtc.icePolicy), `${surface}.webrtc real policy mismatch.`, {
      surface,
      icePolicy: observation.webrtc.icePolicy,
    });
  }

  return {
    userAgent: "matched",
    clientHints: "matched",
    navigator: "matched",
    locale: "matched",
    viewport: "matched",
    webgl: "matched",
    canvas,
    audio,
    webrtc: identity.webrtc.policy,
  };
}

function assertSurfaceProof(surfaceProof, identity, baselineProof = null) {
  assert(surfaceProof?.schemaVersion === 1, "Surface proof schema version mismatch.", { schemaVersion: surfaceProof?.schemaVersion });
  assert(Array.isArray(surfaceProof.surfaceLabels), "Surface proof labels missing.", { surfaceLabels: surfaceProof?.surfaceLabels });
  for (const label of REQUIRED_SURFACE_LABELS) {
    assert(surfaceProof.surfaceLabels.includes(label), "Surface proof omitted a promised label.", { label });
  }

  const initial = targetObservation(surfaceProof, "initial");
  const created = targetObservation(surfaceProof, "new");
  const baselineInitial = baselineProof ? targetObservation(baselineProof, "initial") : null;
  const baselineCreated = baselineProof ? targetObservation(baselineProof, "new") : null;

  return {
    headers: {
      initial: assertHeaders(surfaceProof.headers?.initial, identity, "headers.initial"),
      new: assertHeaders(surfaceProof.headers?.new, identity, "headers.new"),
    },
    targets: {
      initial: assertObservationSurfaces(initial, identity, "target.initial", baselineInitial),
      new: assertObservationSurfaces(created, identity, "target.new", baselineCreated),
    },
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
      fail("Identity surface proof collector timed out.", {
        timeoutMs: PROOF_TIMEOUT_MS,
        stdoutTail: normalizeOutput(result.stdout),
        stderrTail: normalizeOutput(result.stderr),
      });
    }
    fail("Identity surface proof collector process failed.", {
      error: result.error.message,
      stdoutTail: normalizeOutput(result.stdout),
      stderrTail: normalizeOutput(result.stderr),
    });
  }

  assert(!result.stderr.trim(), "Identity surface proof collector wrote to stderr.", { stderrTail: normalizeOutput(result.stderr) });
  const [payload] = parseNdjsonLines("proof stdout", result.stdout, 1);
  if (result.status !== 0 || payload.ok !== true) {
    fail("Identity surface proof collector failed.", {
      exitCode: result.status,
      errorCode: payload.error?.code,
      detailRef: payload.error?.detailRef,
      message: payload.error?.message,
      stdoutTail: normalizeOutput(result.stdout),
    });
  }
  assert(payload.proof && typeof payload.proof === "object" && !Array.isArray(payload.proof), "Identity surface proof collector returned no proof payload.");
  assertNoUnsafeText(result.stdout, "identity-proof-collector.stdout");
  assertNoUnsafeText(result.stderr, "identity-proof-collector.stderr");
  return { proof: payload.proof, stdout: result.stdout, stderr: result.stderr };
}

function assertProfilesJsonClean(storeRoot, profileIds) {
  const profilesPath = join(storeRoot, "profile-store", "profiles.json");
  assert(existsSync(profilesPath), "profiles.json was not written for the S04 proof profiles.");
  const payload = JSON.parse(readFileSync(profilesPath, "utf8"));
  assert(payload.storeVersion === 2, "profiles.json did not remain store v2.", { storeVersion: payload.storeVersion });
  assert(Array.isArray(payload.profiles), "profiles.json profiles field is not an array.");
  for (const profile of payload.profiles) {
    const runtimeFields = Object.keys(profile).filter((key) => FORBIDDEN_PROFILE_RUNTIME_FIELDS.has(key));
    assert(runtimeFields.length === 0, "profiles.json persisted forbidden Chromium runtime/config truth.", {
      profileId: profile.id,
      runtimeFields,
    });
  }
  for (const profileId of profileIds) {
    assert(payload.profiles.some((item) => item?.id === profileId), "profiles.json does not contain an S04 proof profile.", { profileId });
  }
  return { profileCount: payload.profiles.length, storeVersion: payload.storeVersion, runtimeFields: 0 };
}

function assertRuntimeRegistryEmpty(storeRoot) {
  const registryPath = join(storeRoot, "profile-store", "runtime", "chromium-processes.json");
  const payload = readJsonIfExists(registryPath, { registryVersion: 1, processes: {} });
  assert(payload.registryVersion === 1, "Runtime registry version mismatch after stop.", { registryVersion: payload.registryVersion });
  assert(payload.processes && typeof payload.processes === "object" && !Array.isArray(payload.processes), "Runtime registry processes field is invalid.", {
    processes: payload.processes,
  });
  assert(Object.keys(payload.processes).length === 0, "Runtime registry retained processes after stop.", {
    processCount: Object.keys(payload.processes).length,
  });
  return { processCount: 0 };
}

function assertNoPublicLeaks({ storeRoot, profiles, transcripts, proofTranscripts }) {
  const profilesPath = join(storeRoot, "profile-store", "profiles.json");
  const registryPath = join(storeRoot, "profile-store", "runtime", "chromium-processes.json");
  const diagnosticsPath = join(storeRoot, "profile-store", "diagnostics", "events.jsonl");
  const extensionRoot = join(storeRoot, "profile-store", "runtime", "identity-extensions");
  rememberSensitive(extensionRoot);
  for (const profile of profiles) {
    if (profile?.storage?.userDataDir) {
      rememberSensitive(join(storeRoot, ...profile.storage.userDataDir.split("/")));
    }
  }

  const publicResponses = transcripts.map((item) => ({ response: item.response, diagnostics: item.diagnostics }));
  const combinedPublic = [
    JSON.stringify(publicResponses),
    ...proofTranscripts.flatMap((item) => [item?.stdout ?? "", item?.stderr ?? ""]),
    textIfExists(profilesPath),
    textIfExists(registryPath),
    textIfExists(diagnosticsPath),
    JSON.stringify(STEP_RESULTS),
  ].join("\n");

  for (const sensitive of SENSITIVE_VALUES) {
    assert(!combinedPublic.includes(sensitive), "Public/persisted verifier surfaces leaked a sensitive value.", {
      leaked: sensitive === storeRoot ? "storeRoot" : "sensitiveValue",
    });
  }

  for (const marker of PUBLIC_FORBIDDEN_MARKERS) {
    assert(!combinedPublic.includes(marker), "Public/persisted verifier surfaces leaked a forbidden debug/config marker.", { marker });
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
      for (const key of Object.keys(parsed)) {
        assert(!FORBIDDEN_DIAGNOSTIC_KEYS.has(key), "Persisted diagnostic leaked forbidden shape.", {
          lineNumber: index + 1,
          key,
        });
      }
    }
  }

  return {
    responseCount: transcripts.length,
    proofTranscripts: proofTranscripts.length,
    diagnosticsPresent: existsSync(diagnosticsPath),
    forbiddenMarkers: 0,
  };
}

function runMissingExecutableAssertion() {
  const missingRoot = makeTempRoot("theprivator-s04-missing-");
  const emptyPath = join(missingRoot, "empty-path");
  mkdirSync(emptyPath, { recursive: true });
  const missingExecutable = join(missingRoot, "missing-chromium");
  rememberSensitive(missingExecutable);

  try {
    const create = sidecarSuccess(
      makeRequestId("missing-create"),
      "profiles.create",
      { storeRoot: missingRoot, name: PROOF_PROFILE_NAME },
    ).result;
    const profile = assertProfileShape(create.profile, PROOF_PROFILE_NAME);

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

function launchProfile({ name, requestLabel, storeRoot, profile, transcripts }) {
  return runStep(name, () => {
    const result = rememberTranscript(transcripts, callSourceSidecar(
      sidecarRequest(
        makeRequestId(requestLabel),
        "chromium.launch",
        { storeRoot, profileId: profile.id },
      ),
      { timeoutMs: CHROMIUM_LAUNCH_TIMEOUT_MS },
    ));
    const { response, diagnostic } = result;
    if (response.ok === false && response.error?.code === "CHROMIUM_EXECUTABLE_NOT_FOUND") {
      fail("Chromium executable was not found for the S04 full-surface proof.", {
        errorCode: response.error.code,
        detailRef: response.error.detailRef,
        instruction: "Install Chromium/Chrome or set THEPRIVATOR_CHROMIUM_PATH to a local executable before running npm run verify:s04.",
      });
    }
    assert(response.ok === true, "Chromium launch failed during the S04 full-surface proof.", {
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
}

function rememberTranscript(transcripts, result) {
  transcripts.push(result);
  return result;
}

function stopProfileStep({ name, requestLabel, storeRoot, profile, transcripts }) {
  return runStep(name, () => {
    const stop = rememberTranscript(transcripts, sidecarSuccess(
      makeRequestId(requestLabel),
      "chromium.stop",
      { storeRoot, profileId: profile.id },
      { timeoutMs: SIDECAR_TIMEOUT_MS },
    )).result;
    const stopped = assertStoppedPayload(stop, profile);
    return {
      profileId: stopped.profileId,
      lifecycleStatus: stopped.status,
      termination: stopped.termination,
      runningCount: stopped.runningCount,
    };
  });
}

function runRealChromiumSurfaceProof() {
  const storeRoot = makeTempRoot("theprivator-s04-proof-");
  const transcripts = [];
  const proofTranscripts = [];
  const profiles = [];
  let baselineProfile = null;
  let configuredProfile = null;
  let baselineLaunched = false;
  let configuredLaunched = false;

  function cleanup() {
    for (const profile of [configuredProfile, baselineProfile]) {
      if (!profile?.id) {
        continue;
      }
      try {
        rememberTranscript(transcripts, sidecarSuccess(
          makeRequestId(`cleanup-stop-${profile.id.slice(0, 8)}`),
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
    const preset = runStep("identity-presets-list", () => {
      const presets = rememberTranscript(transcripts, sidecarSuccess(
        makeRequestId("presets-list"),
        "identity.presets.list",
        {},
      )).result;
      const selected = assertPresetList(presets);
      return { value: selected, log: { presetId: selected.presetId, presetCount: presets.count } };
    });

    baselineProfile = runStep("profile-create-baseline", () => {
      const create = rememberTranscript(transcripts, sidecarSuccess(
        makeRequestId("baseline-create"),
        "profiles.create",
        { storeRoot, name: BASELINE_PROFILE_NAME },
      )).result;
      assert(create.storeVersion === 2, "Baseline profile create did not return store v2.", { storeVersion: create.storeVersion });
      const profile = assertProfileShape(create.profile, BASELINE_PROFILE_NAME);
      profiles.push(profile);
      return { value: profile, log: { profileId: profile.id, userDataDir: profile.storage.userDataDir } };
    });

    const baselineIdentity = runStep("identity-update-baseline-no-noise", () => {
      const identity = makeNoiseBaselineIdentity(preset);
      const updated = rememberTranscript(transcripts, sidecarSuccess(
        makeRequestId("baseline-update"),
        "profiles.identity.update",
        { storeRoot, profileId: baselineProfile.id, identity },
      )).result;
      const selectedIdentity = assertUpdatedIdentity(updated, baselineProfile, identity);
      return {
        value: selectedIdentity,
        log: { profileId: baselineProfile.id, canvasMode: selectedIdentity.canvas.mode, audioMode: selectedIdentity.audio.mode },
      };
    });

    launchProfile({
      name: "chromium-launch-baseline",
      requestLabel: "baseline-launch",
      storeRoot,
      profile: baselineProfile,
      transcripts,
    });
    baselineLaunched = true;

    const baselineProof = runStep("identity-proof-collect-baseline", () => {
      const userDataPath = join(storeRoot, ...baselineProfile.storage.userDataDir.split("/"));
      const transcript = runProofCollector(userDataPath);
      proofTranscripts.push(transcript);
      const observed = assertSurfaceProof(transcript.proof, baselineIdentity);
      return { value: transcript.proof, log: { profileId: baselineProfile.id, observed } };
    });

    stopProfileStep({
      name: "chromium-stop-baseline",
      requestLabel: "baseline-stop",
      storeRoot,
      profile: baselineProfile,
      transcripts,
    });
    baselineLaunched = false;

    configuredProfile = runStep("profile-create-configured", () => {
      const create = rememberTranscript(transcripts, sidecarSuccess(
        makeRequestId("configured-create"),
        "profiles.create",
        { storeRoot, name: PROOF_PROFILE_NAME },
      )).result;
      assert(create.storeVersion === 2, "Configured profile create did not return store v2.", { storeVersion: create.storeVersion });
      const profile = assertProfileShape(create.profile, PROOF_PROFILE_NAME);
      profiles.push(profile);
      return { value: profile, log: { profileId: profile.id, userDataDir: profile.storage.userDataDir } };
    });

    const configuredIdentity = runStep("identity-apply-preset", () => {
      const applied = rememberTranscript(transcripts, sidecarSuccess(
        makeRequestId("apply-preset"),
        "profiles.identity.applyPreset",
        { storeRoot, profileId: configuredProfile.id, presetId: PRESET_ID },
      )).result;
      const selectedIdentity = assertAppliedIdentity(applied, configuredProfile, preset);
      return {
        value: selectedIdentity,
        log: { profileId: configuredProfile.id, presetId: PRESET_ID, warningCount: applied.warnings.length },
      };
    });

    launchProfile({
      name: "chromium-launch-configured",
      requestLabel: "configured-launch",
      storeRoot,
      profile: configuredProfile,
      transcripts,
    });
    configuredLaunched = true;

    const configuredProof = runStep("identity-proof-collect-configured", () => {
      const userDataPath = join(storeRoot, ...configuredProfile.storage.userDataDir.split("/"));
      const transcript = runProofCollector(userDataPath);
      proofTranscripts.push(transcript);
      return { value: transcript.proof, log: { profileId: configuredProfile.id, schemaVersion: transcript.proof.schemaVersion } };
    });

    const assertionSummary = runStep("expected-vs-observed-assertions", () => {
      const observed = assertSurfaceProof(configuredProof, configuredIdentity, baselineProof);
      return {
        observed,
        baselineComparison: {
          canvas: "configured-differs-from-no-noise-baseline",
          audio: "configured-differs-from-no-noise-baseline",
        },
      };
    });

    stopProfileStep({
      name: "chromium-stop-configured",
      requestLabel: "configured-stop",
      storeRoot,
      profile: configuredProfile,
      transcripts,
    });
    configuredLaunched = false;

    runStep("chromium-status-stopped", () => {
      const status = rememberTranscript(transcripts, sidecarSuccess(
        makeRequestId("status-stopped"),
        "chromium.status",
        { storeRoot },
      )).result;
      assertStatusStopped(status);
      return { runningCount: status.runningCount, profileCount: status.profiles.length, reconciledCount: status.reconciled.length };
    });

    runStep("runtime-registry-empty", () => assertRuntimeRegistryEmpty(storeRoot));
    runStep("profiles-json-clean", () => assertProfilesJsonClean(storeRoot, [baselineProfile.id, configuredProfile.id]));
    runStep("redaction-leak-check", () => assertNoPublicLeaks({ storeRoot, profiles, transcripts, proofTranscripts }));

    return {
      presetId: PRESET_ID,
      profileCount: profiles.length,
      proofSchemaVersion: configuredProof.schemaVersion,
      assertionSummary,
    };
  } finally {
    if (baselineLaunched || configuredLaunched) {
      cleanup();
    } else {
      rmSync(storeRoot, { recursive: true, force: true });
    }
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

function assertTargetBinary(binaryPath, targetTriple) {
  assert(existsSync(binaryPath), `Missing sidecar binary ${relative(ROOT_DIR, binaryPath)}.`, "Run npm run sidecar:build before npm run verify:s04.");
  const stats = statSync(binaryPath);
  assert(stats.isFile(), "Target sidecar path is not a file.", relative(ROOT_DIR, binaryPath));
  if (process.platform !== "win32") {
    assert((stats.mode & 0o111) !== 0, "Target sidecar binary is not executable.", relative(ROOT_DIR, binaryPath));
  }
  return { binary: relative(ROOT_DIR, binaryPath), targetTriple };
}

function callBuiltSidecar(binaryPath, request, options = {}) {
  const input = `${JSON.stringify(request)}\n`;
  const result = spawnSync(binaryPath, {
    cwd: ROOT_DIR,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs ?? BUILT_SIDECAR_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      fail(`Built sidecar timed out for ${request.method}.`, {
        method: request.method,
        stdoutTail: normalizeOutput(result.stdout),
        stderrTail: normalizeOutput(result.stderr),
      });
    }
    fail(`Built sidecar failed for ${request.method}.`, { method: request.method, error: result.error.message });
  }

  if (result.status !== 0) {
    fail(`Built sidecar exited with status ${result.status ?? "unknown"} for ${request.method}.`, {
      method: request.method,
      stdoutTail: normalizeOutput(result.stdout),
      stderrTail: normalizeOutput(result.stderr),
    });
  }

  assertNoUnsafeText(result.stdout, `built.${request.method}.stdout`);
  assertNoUnsafeText(result.stderr, `built.${request.method}.stderr`);
  const [response] = parseNdjsonLines("built sidecar stdout", result.stdout, 1);
  const diagnostics = parseNdjsonLines("built sidecar stderr", result.stderr);
  assert(diagnostics.length >= 1, "Built sidecar emitted no diagnostics.", { method: request.method });
  assertRequestDiagnostic(diagnostics[0], request);
  return { response, diagnostics, stderr: result.stderr, stdout: result.stdout };
}

function builtSidecarSuccess(binaryPath, id, method, params, options = {}) {
  const { response, diagnostics } = callBuiltSidecar(binaryPath, { id, method, params }, options);
  assert(response.id === id, "Built sidecar success response id mismatch.", { method, responseId: response.id });
  assert(response.ok === true, `Expected ${method} to succeed.`, {
    method,
    errorCode: response.error?.code,
    detailRef: response.error?.detailRef,
  });
  assert(response.protocolVersion === "1.0.0", "Built sidecar protocol version changed.", { method, protocolVersion: response.protocolVersion });
  assert(response.result && typeof response.result === "object" && !Array.isArray(response.result), "Success result must be an object.", { method });
  assert(diagnostics[0].status === "ok", "Successful built request diagnostic did not report ok.", diagnostics[0]);
  assert(diagnostics[0].errorCode === null, "Successful built diagnostic had an errorCode.", diagnostics[0]);
  assert(diagnostics[0].detailRef === null, "Successful built diagnostic had a detailRef.", diagnostics[0]);
  return { result: response.result, diagnostics };
}

function builtSidecarError(binaryPath, id, method, params, expectedCode, options = {}) {
  const { response, diagnostics } = callBuiltSidecar(binaryPath, { id, method, params }, options);
  assert(response.id === id, "Built sidecar error response id mismatch.", { method, responseId: response.id });
  assert(response.ok === false, `Expected ${method} to fail safely.`, { method, result: response.result });
  assert(response.protocolVersion === "1.0.0", "Built sidecar protocol version changed.", { method, protocolVersion: response.protocolVersion });
  assert(response.error?.code === expectedCode, "Built sidecar error code mismatch.", {
    method,
    expectedCode,
    actualCode: response.error?.code,
  });
  assert(response.error?.recoverable === true, "Built sidecar error was not recoverable.", response.error);
  assert(typeof response.error?.detailRef === "string" && response.error.detailRef.startsWith("sidecar-"), "Built sidecar error lost detailRef.", response.error);
  assert(diagnostics[0].status === "error", "Error built request diagnostic did not report error.", diagnostics[0]);
  assert(diagnostics[0].errorCode === expectedCode, "Error built diagnostic code mismatch.", diagnostics[0]);
  assert(diagnostics[0].detailRef === response.error.detailRef, "Error built diagnostic detailRef mismatch.", diagnostics[0]);
  return { error: response.error, diagnostics };
}

function writeLegacyProfile(legacyRoot, folderName, config, options = {}) {
  const profileDir = join(legacyRoot, folderName);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "config.json"), JSON.stringify(config), "utf8");
  if (options.userDataFile) {
    const filePath = join(profileDir, "user-data", "Default", "Preferences");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, options.userDataFile, "utf8");
  }
  if (options.symlinkTarget) {
    const userDataDir = join(profileDir, "user-data");
    mkdirSync(userDataDir, { recursive: true });
    symlinkSync(options.symlinkTarget, join(userDataDir, "unsafe-link"));
  }
}

function snapshotTree(root) {
  if (!existsSync(root)) {
    return [];
  }
  const entries = [];
  function visit(current) {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const rel = relative(root, path).split("\\").join("/");
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        entries.push(["symlink", rel, readlinkSync(path)]);
      } else if (stats.isDirectory()) {
        entries.push(["dir", rel, null]);
        visit(path);
      } else if (stats.isFile()) {
        entries.push(["file", rel, readFileSync(path, "utf8")]);
      } else {
        entries.push(["other", rel, null]);
      }
    }
  }
  visit(root);
  return entries;
}

function assertProfileStorage(storeRoot, profileId, expectedName, expectedCopiedContent = undefined) {
  const profilesPath = join(storeRoot, "profile-store", "profiles.json");
  assert(existsSync(profilesPath), "profiles.json was not written.", { profileId });
  const payload = JSON.parse(readFileSync(profilesPath, "utf8"));
  const profile = payload.profiles?.find((item) => item?.id === profileId);
  assert(profile, "Imported profile was not persisted.", { profileId });
  assert(profile.name === expectedName, "Imported profile name mismatch.", { expectedName, actualName: profile.name });
  assert(typeof profile.storage?.userDataDir === "string", "Imported profile missing userDataDir.", { profileId });
  assert(!profile.storage.userDataDir.startsWith("/"), "Imported profile userDataDir was absolute.", { userDataDir: profile.storage.userDataDir });
  assert(!profile.storage.userDataDir.includes(".."), "Imported profile userDataDir escaped storage.", { userDataDir: profile.storage.userDataDir });
  assert(profile.metadata?.source === "legacy-theprivator", "Imported profile did not preserve safe legacy source metadata.", profile.metadata);
  assert(profile.metadata?.legacyFolder, "Imported profile did not preserve safe legacy folder metadata.", profile.metadata);
  if (expectedCopiedContent !== undefined) {
    const copiedPath = join(storeRoot, profile.storage.userDataDir, "Default", "Preferences");
    assert(existsSync(copiedPath), "Imported user-data file was not copied.", { profileId });
    assert(readFileSync(copiedPath, "utf8") === expectedCopiedContent, "Imported user-data content mismatch.", { profileId });
  }
  return profile;
}

function runLegacySmoke(binaryPath) {
  const legacyRoot = makeTempRoot("theprivator-s04-legacy-");
  const storeRoot = makeTempRoot("theprivator-s04-store-");
  const outsideSecret = join(legacyRoot, "..", `${basename(legacyRoot)}-outside-secret-should-not-leak.txt`);
  rememberSensitive(outsideSecret);
  writeFileSync(outsideSecret, "outside-secret-should-not-leak", "utf8");

  try {
    writeLegacyProfile(
      legacyRoot,
      "good",
      {
        name: "Good Legacy",
        version: "2",
        chromium_version: "116.0.0",
        rc_port: 9222,
        proxy_user: "proxy-user-should-not-leak",
        proxy_pass: "proxy-pass-should-not-leak",
      },
      { userDataFile: "copied-browser-data-should-not-leak" },
    );
    writeLegacyProfile(legacyRoot, "partial", { name: "Partial Legacy" }, { symlinkTarget: outsideSecret });
    writeLegacyProfile(legacyRoot, "duplicate", { name: "Duplicate Legacy" });
    const beforeImport = snapshotTree(legacyRoot);

    builtSidecarSuccess(binaryPath, "s04-existing-profile", "profiles.create", { storeRoot, name: "Taken" });

    const scan = builtSidecarSuccess(binaryPath, "s04-scan", "legacy.scan", { storeRoot, legacyRoot }).result;
    assert(scan.scanVersion === 1, "Legacy scanVersion mismatch.", { scanVersion: scan.scanVersion });
    assert(scan.count === 3, "Legacy scan did not find the expected immediate profiles.", { count: scan.count });
    assert(Array.isArray(scan.candidates) && scan.candidates.length === 3, "Legacy scan candidates shape mismatch.", scan);
    const candidates = Object.fromEntries(scan.candidates.map((candidate) => [candidate.folderName, candidate]));
    for (const key of ["good", "partial", "duplicate"]) {
      assert(candidates[key]?.legacyId?.startsWith("legacy-"), "Legacy scan did not return opaque candidate ids.", { key });
      assert(!String(candidates[key].legacyId).includes(legacyRoot), "Legacy id leaked the legacy root.", { key });
    }

    const invalidRoot = builtSidecarError(
      binaryPath,
      "s04-invalid-root",
      "legacy.scan",
      { storeRoot, legacyRoot: join(legacyRoot, "missing") },
      "LEGACY_ROOT_INVALID",
    );
    assert(invalidRoot.error.detailRef.startsWith("sidecar-"), "Invalid root error lost detailRef.", invalidRoot.error);

    const badItems = builtSidecarError(
      binaryPath,
      "s04-bad-items",
      "legacy.import",
      { storeRoot, legacyRoot, items: {} },
      "INVALID_REQUEST",
    );
    assert(badItems.error.detailRef.startsWith("sidecar-"), "Bad-items error lost detailRef.", badItems.error);

    const imported = builtSidecarSuccess(
      binaryPath,
      "s04-import",
      "legacy.import",
      {
        storeRoot,
        legacyRoot,
        items: [
          { legacyId: candidates.good.legacyId, targetName: "Imported Good" },
          { legacyId: candidates.partial.legacyId, targetName: "Imported Partial" },
          { legacyId: "legacy-stale-selection", targetName: "Imported Stale" },
          { legacyId: candidates.duplicate.legacyId, targetName: "Taken" },
        ],
      },
      { timeoutMs: 60_000 },
    );

    const result = imported.result;
    assert(result.importVersion === 1, "Legacy importVersion mismatch.", { importVersion: result.importVersion });
    assert(result.requestedCount === 4, "Legacy import requestedCount mismatch.", result);
    assert(result.successCount === 1, "Legacy import successCount mismatch.", result);
    assert(result.partialCount === 1, "Legacy import partialCount mismatch.", result);
    assert(result.failedCount === 2, "Legacy import failedCount mismatch.", result);

    const outcomes = Object.fromEntries(result.outcomes.map((outcome) => [outcome.targetName, outcome]));
    assert(outcomes["Imported Good"]?.status === "success", "Success import outcome missing.", result.outcomes);
    assert(outcomes["Imported Good"].copyStatus === "copied", "Success import did not copy user-data.", outcomes["Imported Good"]);
    assert(outcomes["Imported Partial"]?.status === "partial", "Partial import outcome missing.", result.outcomes);
    assert(outcomes["Imported Partial"].error?.code === "LEGACY_USER_DATA_COPY_FAILED", "Partial import did not expose copy failure.", outcomes["Imported Partial"]);
    assert(outcomes["Imported Stale"]?.status === "failed", "Stale import outcome missing.", result.outcomes);
    assert(outcomes["Imported Stale"].error?.code === "LEGACY_SELECTION_INVALID", "Stale import code mismatch.", outcomes["Imported Stale"]);
    assert(outcomes.Taken?.status === "failed", "Duplicate import outcome missing.", result.outcomes);
    assert(outcomes.Taken.error?.code === "PROFILE_DUPLICATE_NAME", "Duplicate import code mismatch.", outcomes.Taken);

    const outcomeDiagnostics = imported.diagnostics.slice(1);
    assert(outcomeDiagnostics.length === 3, "Import did not emit one redacted diagnostic per failed/partial profile.", outcomeDiagnostics);
    const diagnosticCodes = new Set(outcomeDiagnostics.map((event) => event.errorCode));
    for (const expectedCode of ["LEGACY_USER_DATA_COPY_FAILED", "LEGACY_SELECTION_INVALID", "PROFILE_DUPLICATE_NAME"]) {
      assert(diagnosticCodes.has(expectedCode), "Import outcome diagnostic missing expected error code.", { expectedCode, outcomeDiagnostics });
    }
    for (const event of outcomeDiagnostics) {
      assert(Object.keys(event).sort().join(",") === "detailRef,durationMs,errorCode,event,legacyId,status", "Outcome diagnostic leaked forbidden fields.", event);
      assert(event.event === "legacy.import.outcome", "Outcome diagnostic event name mismatch.", event);
      assert(event.legacyId?.startsWith("legacy-"), "Outcome diagnostic legacyId is not opaque.", event);
      assert(event.status === "partial" || event.status === "failed", "Outcome diagnostic status mismatch.", event);
      assert(typeof event.durationMs === "number" && event.durationMs >= 0, "Outcome diagnostic duration missing.", event);
      assert(typeof event.detailRef === "string" && event.detailRef.startsWith("sidecar-"), "Outcome diagnostic lost detailRef.", event);
    }

    assert(JSON.stringify(snapshotTree(legacyRoot)) === JSON.stringify(beforeImport), "Legacy source tree was mutated by import.");
    assertProfileStorage(storeRoot, outcomes["Imported Good"].profileId, "Imported Good", "copied-browser-data-should-not-leak");
    assertProfileStorage(storeRoot, outcomes["Imported Partial"].profileId, "Imported Partial");

    return {
      importedProfiles: result.successCount + result.partialCount,
      failedProfiles: result.failedCount,
      outcomeDiagnostics: outcomeDiagnostics.length,
    };
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true });
    rmSync(storeRoot, { recursive: true, force: true });
    rmSync(outsideSecret, { force: true });
  }
}

try {
  runStep("missing-executable-typed-error", runMissingExecutableAssertion);
  const proof = runStep("real-chromium-full-surface-proof", runRealChromiumSurfaceProof);
  runCommand("sidecar-build", "npm", ["run", "sidecar:build"], PACKAGE_BUILD_TIMEOUT_MS);
  const targetTriple = runStep("target-triple", () => ({ targetTriple: readTargetTriple() })).targetTriple;
  const binaryPath = join(ROOT_DIR, "src-tauri", "binaries", `${SIDECAR_NAME}-${targetTriple}${EXTENSION}`);
  runStep("target-binary", () => assertTargetBinary(binaryPath, targetTriple));
  const legacySmoke = runStep("legacy-built-sidecar-smoke", () => runLegacySmoke(binaryPath));

  emit({ status: "pass", proof, legacySmoke, checks: STEP_RESULTS });
} catch {
  emit({ status: "fail", checks: STEP_RESULTS });
  process.exit(1);
}
