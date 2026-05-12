import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_NAME = "theprivator-sidecar";
const EXTENSION = process.platform === "win32" ? ".exe" : "";
const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];
const STORE_DIR = "profile-store";
const PROFILES_FILE = "profiles.json";
const DIAGNOSTIC_RELATIVE_LOG_PATH = "profile-store/diagnostics/events.jsonl";
const PROXY_USERNAME_SENTINEL = "proxy-user-s01-smoke";
const PROXY_PASSWORD_SENTINEL = "proxy-pass-s01-smoke";
const PROXY_HEADER_SENTINEL = "Proxy-Authorization: Basic proxy-s01-smoke";
const PROXY_KEY_SENTINEL = "proxyCredentialSentinelKey";
const STATIC_SENSITIVE_VALUES = [
  "debugPort",
  "9222",
  "--remote-debugging-port=9222",
  PROXY_USERNAME_SENTINEL,
  PROXY_PASSWORD_SENTINEL,
  PROXY_HEADER_SENTINEL,
  PROXY_KEY_SENTINEL,
  "Proxy-Authorization",
  "proxy-authorization",
  "proxy_authorization",
  "proxy-user",
  "proxy-username",
  "proxy-pass",
  "proxy-password",
];
const REDACTION_VALUES = new Set(STATIC_SENSITIVE_VALUES);
const SENSITIVE_DETAIL_KEY = /(?:authorization|credential|password|proxy[-_ ]?(?:authorization|pass|password|user|username)|username)/i;

class SmokeFailure extends Error {
  constructor(message, details) {
    super(message);
    this.name = "SmokeFailure";
    this.details = details;
  }
}

function emit(event) {
  const safeEvent = redactForLog({ event: "verify.sidecar", ...event });
  VERIFIER_EVENTS.push(safeEvent);
  console.log(JSON.stringify(safeEvent));
}

function fail(message, details) {
  throw new SmokeFailure(message, details);
}

function assert(condition, message, details) {
  if (!condition) {
    fail(message, details);
  }
}

function activeSensitiveValues(sensitiveValues = []) {
  return [...REDACTION_VALUES, ...sensitiveValues];
}

function registerSensitiveValues(sensitiveValues = []) {
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value.length > 0) {
      REDACTION_VALUES.add(value);
    }
  }
  return activeSensitiveValues();
}

function redactForLog(value, sensitiveValues = activeSensitiveValues()) {
  if (typeof value === "string") {
    return redactText(value, sensitiveValues);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, sensitiveValues));
  }

  const redacted = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) {
      redacted["<redacted-key>"] = "<redacted>";
    } else {
      redacted[redactText(key, sensitiveValues)] = redactForLog(nested, sensitiveValues);
    }
  }
  return redacted;
}

function readTargetTriple() {
  try {
    return execFileSync("rustc", ["--print", "host-tuple"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail("Failed to determine the Rust host target triple.", error.message);
  }
}

function redactText(value, sensitiveValues = []) {
  let redacted = String(value ?? "");
  for (const sensitive of sensitiveValues) {
    if (typeof sensitive === "string" && sensitive.length > 0) {
      redacted = redacted.split(sensitive).join("<redacted>");
    }
  }
  return redacted
    .replace(/--remote-debugging-port(?:=|\s+)\d+/gi, "--remote-debugging-port=<redacted>")
    .replace(/debugPort[\"':\s=]+\d+/gi, "debugPort=<redacted>")
    .replace(/9222/g, "<redacted-port>");
}

function redactedTail(value, sensitiveValues = [], maxLength = 600) {
  const text = redactText(value, activeSensitiveValues(sensitiveValues));
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function redactedProcessDetails(result, sensitiveValues = []) {
  return {
    status: result.status,
    signal: result.signal,
    stdoutTail: redactedTail(result.stdout, sensitiveValues),
    stderrTail: redactedTail(result.stderr, sensitiveValues),
  };
}

function parseNdjsonLines(streamName, value, expectedCount, sensitiveValues = []) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== expectedCount) {
    fail(
      `${streamName} emitted ${lines.length} NDJSON line(s), expected ${expectedCount}.`,
      {
        [`${streamName}LineCount`]: lines.length,
        [`${streamName}Tail`]: redactedTail(value, sensitiveValues),
      },
    );
  }

  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${streamName} line ${index + 1} is not valid JSON.`, {
        parserMessage: error.message,
        [`${streamName}Tail`]: redactedTail(value, sensitiveValues),
      });
    }
  });
}

function runStep(name, action) {
  const started = performance.now();
  try {
    const result = action();
    const logResult = result?.log ?? result;
    const returnResult = result?.value ?? result;
    const durationMs = Math.round(performance.now() - started);
    STEP_RESULTS.push({ name, status: "pass", durationMs });
    emit({ step: name, status: "pass", durationMs, ...logResult });
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

function assertTargetBinary(binaryPath, targetTriple) {
  assert(
    existsSync(binaryPath),
    `Missing sidecar binary ${relative(ROOT_DIR, binaryPath)}.`,
    "Run npm run sidecar:build first.",
  );

  const stats = statSync(binaryPath);
  assert(stats.isFile(), "Target sidecar path is not a file.", relative(ROOT_DIR, binaryPath));

  if (process.platform !== "win32") {
    assert(
      (stats.mode & 0o111) !== 0,
      "Target sidecar binary is not executable on this Unix platform.",
      relative(ROOT_DIR, binaryPath),
    );
  }

  return {
    binary: relative(ROOT_DIR, binaryPath),
    targetTriple,
    executableChecked: process.platform !== "win32",
  };
}

function runSidecarRaw(binaryPath, input, expectedStdoutCount, expectedStderrCount, sensitiveValues = []) {
  const result = spawnSync(binaryPath, {
    cwd: ROOT_DIR,
    input,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      fail("Sidecar smoke timed out and the child process was killed.", {
        error: result.error.message,
        ...redactedProcessDetails(result, sensitiveValues),
      });
    }
    fail("Sidecar smoke process failed.", {
      error: result.error.message,
      ...redactedProcessDetails(result, sensitiveValues),
    });
  }

  if (result.status !== 0) {
    fail(`Sidecar exited with status ${result.status ?? "unknown"}.`, {
      expectedStatus: 0,
      ...redactedProcessDetails(result, sensitiveValues),
    });
  }

  const stdoutEvents = parseNdjsonLines(
    "stdout",
    result.stdout,
    expectedStdoutCount,
    sensitiveValues,
  );
  const stderrEvents = parseNdjsonLines(
    "stderr",
    result.stderr,
    expectedStderrCount,
    sensitiveValues,
  );

  return {
    stdoutEvents,
    stderrEvents,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runSidecarRequest(binaryPath, payload, sensitiveValues = []) {
  const result = runSidecarRaw(
    binaryPath,
    `${JSON.stringify(payload)}\n`,
    1,
    1,
    sensitiveValues,
  );
  return {
    response: result.stdoutEvents[0],
    diagnostic: result.stderrEvents[0],
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runSidecarInvalidInput(binaryPath, sensitiveValues = []) {
  const result = runSidecarRaw(binaryPath, "{ invalid json\n", 1, 1, sensitiveValues);
  return {
    response: result.stdoutEvents[0],
    diagnostic: result.stderrEvents[0],
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function profileStorePath(storeRoot) {
  return join(storeRoot, STORE_DIR, PROFILES_FILE);
}

function diagnosticLogPath(storeRoot) {
  return join(storeRoot, STORE_DIR, "diagnostics", "events.jsonl");
}

function readRequiredText(path, label) {
  assert(existsSync(path), `${label} is missing.`);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    fail(`${label} could not be read.`, { error: error instanceof Error ? error.message : String(error) });
  }
}

function parseJsonText(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${label} is not valid JSON.`, { parserMessage: error instanceof Error ? error.message : String(error) });
  }
}

function readProfileStore(storeRoot) {
  const text = readRequiredText(profileStorePath(storeRoot), "Profile store JSON");
  return { text, payload: parseJsonText(text, "Profile store JSON") };
}

function readDiagnosticLogEntries(storeRoot) {
  const text = readRequiredText(diagnosticLogPath(storeRoot), "Diagnostic JSONL log");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert(lines.length > 0, "Diagnostic JSONL log did not contain any entries.");
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`Diagnostic JSONL log line ${index + 1} is not valid JSON.`, {
        parserMessage: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function assertNoProxyCredentialSentinels(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const sentinel of [PROXY_USERNAME_SENTINEL, PROXY_PASSWORD_SENTINEL]) {
    assert(!text.includes(sentinel), `${label} leaked a proxy credential sentinel.`, {
      label,
      markerClass: "proxy-credential-sentinel",
    });
  }
}

function assertNoCredentialObjectKeys(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert(!/\"credentials\"\s*:/.test(text), `${label} leaked a proxy credentials object.`, { label });
  assert(!/\"username\"\s*:/.test(text), `${label} leaked a proxy username field.`, { label });
  assert(!/\"password\"\s*:/.test(text), `${label} leaked a proxy password field.`, { label });
}

function assertHealthEnvelope(health, healthLog) {
  assert(health.id === "verify-health", "Health response did not echo the request id.");
  assert(health.ok === true, "Health response did not return ok:true.");
  assert(health.result?.status, "Health response is missing result.status.");
  assert(
    health.result?.product?.name === "ThePrivator",
    "Health response is missing product metadata.",
  );
  assert(health.result?.protocol?.version, "Health response is missing protocol metadata.");
  assert(health.result?.build?.mode, "Health response is missing build metadata.");
  assert(
    health.result?.build?.mode === "pyinstaller",
    "Built sidecar health did not report pyinstaller build mode.",
  );
  assert(health.result?.build?.frozen === true, "Built sidecar health did not report frozen:true.");
  assert(healthLog.status === "ok", "Health diagnostic did not report ok status.");
  assert(healthLog.errorCode === null, "Health diagnostic should not include an error code.");
  assert(healthLog.detailRef === null, "Health diagnostic should not include a detailRef.");
  return { requestId: health.id, buildMode: health.result.build.mode };
}

function assertDeliberateErrorEnvelope(deliberateError, errorLog) {
  assert(deliberateError.id === "verify-error", "Diagnostic error did not echo the request id.");
  assert(deliberateError.ok === false, "Diagnostic error did not return ok:false.");
  assert(
    deliberateError.error?.code === "DIAGNOSTIC_FAILURE",
    "Diagnostic error did not preserve DIAGNOSTIC_FAILURE.",
  );
  assert(deliberateError.error?.recoverable === true, "Diagnostic error is not recoverable.");
  assert(deliberateError.error?.detailRef, "Diagnostic error is missing detailRef.");
  assert(errorLog.status === "error", "Deliberate diagnostic did not report error status.");
  assert(errorLog.errorCode === "DIAGNOSTIC_FAILURE", "Deliberate diagnostic lost errorCode.");
  assert(
    errorLog.detailRef === deliberateError.error.detailRef,
    "detailRef mismatch between stdout and stderr.",
  );
  return { requestId: deliberateError.id, errorCode: deliberateError.error.code };
}

function assertInvalidInputEnvelope(invalidInput, invalidLog) {
  assert(invalidInput.id === null, "Invalid input response should use a null id.");
  assert(invalidInput.ok === false, "Invalid input did not return ok:false.");
  assert(invalidInput.error?.code === "INVALID_REQUEST", "Invalid input did not return INVALID_REQUEST.");
  assert(invalidInput.error?.recoverable === true, "Invalid input error is not recoverable.");
  assert(invalidInput.error?.detailRef, "Invalid input error is missing detailRef.");
  assert(invalidLog.status === "error", "Invalid input diagnostic did not report error status.");
  assert(invalidLog.errorCode === "INVALID_REQUEST", "Invalid input diagnostic lost errorCode.");
  assert(invalidLog.detailRef === invalidInput.error.detailRef, "Invalid input detailRef mismatch.");
  return { errorCode: invalidInput.error.code };
}

function assertProfileCreateEnvelope(response, diagnostic, profileName) {
  assert(response.id === "verify-profile-create", "Profile create did not echo request id.");
  assert(response.ok === true, "Profile create did not return ok:true.");
  assert(response.result?.storeVersion === 3, "Profile create did not return storeVersion 3.");
  assert(response.result?.profile?.id, "Profile create is missing profile id.");
  assert(response.result?.profile?.name === profileName, "Profile create returned the wrong profile name.");
  assert(
    response.result?.profile?.identity?.identityVersion === 1,
    "Profile create is missing default identity v1.",
  );
  assert(diagnostic.status === "ok", "Profile create diagnostic did not report ok status.");
  assert(diagnostic.errorCode === null, "Profile create diagnostic should not include an error code.");
  return { profileId: response.result.profile.id, storeVersion: response.result.storeVersion };
}

function assertPresetListEnvelope(response, diagnostic) {
  assert(response.id === "verify-identity-presets", "Preset list did not echo request id.");
  assert(response.ok === true, "Preset list did not return ok:true.");
  assert(response.result?.identityVersion === 1, "Preset list did not return identityVersion 1.");
  assert(Array.isArray(response.result?.presets), "Preset list did not return presets array.");
  assert(response.result.count === response.result.presets.length, "Preset list count mismatch.");
  const presetIds = response.result.presets.map((preset) => preset.presetId);
  assert(
    presetIds.includes("windows-10-chrome-120"),
    "Preset list did not include windows-10-chrome-120.",
  );
  assert(diagnostic.status === "ok", "Preset list diagnostic did not report ok status.");
  return { presetId: "windows-10-chrome-120", presetCount: response.result.count };
}

function assertApplyPresetEnvelope(response, diagnostic, presetId) {
  assert(response.id === "verify-identity-apply", "Identity apply did not echo request id.");
  assert(response.ok === true, "Identity apply did not return ok:true.");
  assert(response.result?.storeVersion === 3, "Identity apply did not return storeVersion 3.");
  assert(Array.isArray(response.result?.warnings), "Identity apply did not return warnings array.");
  assert(response.result.warnings.length === 0, "Curated preset apply should not warn.");
  assert(
    response.result?.profile?.identity?.presetId === presetId,
    "Identity apply did not persist the selected preset id.",
  );
  assert(diagnostic.status === "ok", "Identity apply diagnostic did not report ok status.");
  return { presetId: response.result.profile.identity.presetId };
}

function assertInvalidIdentityEnvelope(response, diagnostic) {
  assert(response.id === "verify-identity-invalid", "Invalid identity did not echo request id.");
  assert(response.ok === false, "Invalid identity did not return ok:false.");
  assert(response.error?.code === "IDENTITY_INVALID", "Invalid identity did not return IDENTITY_INVALID.");
  assert(response.error?.recoverable === true, "Invalid identity error is not recoverable.");
  assert(response.error?.detailRef, "Invalid identity error is missing detailRef.");
  assert(diagnostic.status === "error", "Invalid identity diagnostic did not report error status.");
  assert(diagnostic.errorCode === "IDENTITY_INVALID", "Invalid identity diagnostic lost errorCode.");
  assert(diagnostic.detailRef === response.error.detailRef, "Invalid identity detailRef mismatch.");
  return { errorCode: response.error.code };
}

function assertPublicProxySummary(proxy, expected) {
  assert(proxy?.proxyVersion === 1, "Proxy summary did not report proxyVersion 1.");
  assert(proxy?.mode === expected.mode, "Proxy summary returned the wrong mode.", {
    expectedMode: expected.mode,
    actualMode: proxy?.mode,
  });
  assert(proxy?.credentialState === expected.credentialState, "Proxy summary returned the wrong credential state.", {
    expectedCredentialState: expected.credentialState,
    actualCredentialState: proxy?.credentialState,
  });
  assert(proxy?.summary === expected.summary, "Proxy summary returned the wrong safe summary.", {
    expectedSummary: expected.summary,
    actualSummary: proxy?.summary,
  });
  if (expected.protocol !== undefined) {
    assert(proxy.protocol === expected.protocol, "Proxy summary returned the wrong protocol.");
    assert(proxy.host === expected.host, "Proxy summary returned the wrong host.");
    assert(proxy.port === expected.port, "Proxy summary returned the wrong port.");
  }
  assert(!("credentials" in proxy), "Proxy summary leaked credentials.");
  assert(!("username" in proxy), "Proxy summary leaked a username field.");
  assert(!("password" in proxy), "Proxy summary leaked a password field.");
}

function assertProxyValidateEnvelope(response, diagnostic, requestId, expectedProxy) {
  assert(response.id === requestId, "Proxy validate did not echo request id.");
  assert(response.ok === true, "Proxy validate did not return ok:true.");
  assert(response.result?.proxyVersion === 1, "Proxy validate did not return proxyVersion 1.");
  assert(Array.isArray(response.result?.warnings), "Proxy validate did not return warnings array.");
  assert(response.result.warnings.length === 0, "Proxy validate returned unexpected warnings.");
  assertPublicProxySummary(response.result?.proxy, expectedProxy);
  assertNoProxyCredentialSentinels(response, "Proxy validate public response");
  assertNoCredentialObjectKeys(response, "Proxy validate public response");
  assert(diagnostic.status === "ok", "Proxy validate diagnostic did not report ok status.");
  assert(diagnostic.errorCode === null, "Proxy validate diagnostic should not include an error code.");
  assert(diagnostic.detailRef === null, "Proxy validate diagnostic should not include a detailRef.");
  return { proxyMode: response.result.proxy.mode, credentialState: response.result.proxy.credentialState };
}

function assertProxyUpdateEnvelope(response, diagnostic, profileId, expectedProxy) {
  assert(response.id === "verify-proxy-update", "Proxy update did not echo request id.");
  assert(response.ok === true, "Proxy update did not return ok:true.");
  assert(response.result?.storeVersion === 3, "Proxy update did not return storeVersion 3.");
  assert(response.result?.profile?.id === profileId, "Proxy update returned the wrong profile id.");
  assertPublicProxySummary(response.result?.profile?.proxy, expectedProxy);
  assert(Array.isArray(response.result?.profiles), "Proxy update did not return profiles array.");
  const listed = response.result.profiles.find((profile) => profile?.id === profileId);
  assert(listed, "Proxy update list did not include the updated profile.");
  assertPublicProxySummary(listed.proxy, expectedProxy);
  assertNoProxyCredentialSentinels(response, "Proxy update public response");
  assertNoCredentialObjectKeys(response, "Proxy update public response");
  assert(diagnostic.status === "ok", "Proxy update diagnostic did not report ok status.");
  assert(diagnostic.errorCode === null, "Proxy update diagnostic should not include an error code.");
  return { storeVersion: response.result.storeVersion, proxyMode: response.result.profile.proxy.mode };
}

function assertProfileListProxyEnvelope(response, diagnostic, profileId, expectedProxy) {
  assert(response.id === "verify-profile-list-v3", "Profile list did not echo request id.");
  assert(response.ok === true, "Profile list did not return ok:true.");
  assert(response.result?.storeVersion === 3, "Profile list did not return storeVersion 3.");
  assert(Array.isArray(response.result?.profiles), "Profile list did not return profiles array.");
  const listed = response.result.profiles.find((profile) => profile?.id === profileId);
  assert(listed, "Profile list did not include the smoke profile.");
  assertPublicProxySummary(listed.proxy, expectedProxy);
  assertNoProxyCredentialSentinels(response, "Profile list public response");
  assertNoCredentialObjectKeys(response, "Profile list public response");
  assert(diagnostic.status === "ok", "Profile list diagnostic did not report ok status.");
  return { storeVersion: response.result.storeVersion, profileCount: response.result.count };
}

function assertPersistedProxyCredentials(storeRoot, profileId) {
  const { payload } = readProfileStore(storeRoot);
  assert(payload?.storeVersion === 3, "Persisted profile store did not use storeVersion 3.", {
    storeVersion: payload?.storeVersion,
  });
  const profile = Array.isArray(payload.profiles)
    ? payload.profiles.find((item) => item?.id === profileId)
    : undefined;
  assert(profile, "Persisted profile store did not include the smoke profile.");
  const proxy = profile.proxy;
  assert(proxy?.mode === "fixedServer", "Persisted proxy did not use fixedServer mode.", {
    proxyMode: proxy?.mode,
  });
  assert(proxy?.protocol === "socks5", "Persisted proxy did not keep the expected protocol.");
  assert(proxy?.host === "proxy.s01-smoke.example", "Persisted proxy did not keep the expected host.");
  assert(proxy?.port === 19050, "Persisted proxy did not keep the expected port.");
  assert(proxy?.credentials?.username === PROXY_USERNAME_SENTINEL, "Persisted proxy username sentinel was not found at the targeted store path.", {
    hasCredentialsObject: Boolean(proxy?.credentials),
  });
  assert(proxy?.credentials?.password === PROXY_PASSWORD_SENTINEL, "Persisted proxy password sentinel was not found at the targeted store path.", {
    hasCredentialsObject: Boolean(proxy?.credentials),
  });
  return { storeVersion: payload.storeVersion, proxyMode: proxy.mode, credentialFieldCount: 2 };
}

function assertProxyErrorEnvelope(response, diagnostic, requestId, expectedErrorCode) {
  assert(response.id === requestId, "Proxy failure did not echo request id.");
  assert(response.ok === false, "Proxy failure did not return ok:false.");
  assert(response.error?.code === expectedErrorCode, "Proxy failure returned the wrong error code.", {
    expectedErrorCode,
    actualErrorCode: response.error?.code,
  });
  assert(response.error?.recoverable === true, "Proxy failure error is not recoverable.");
  assert(response.error?.detailRef, "Proxy failure error is missing detailRef.");
  assert(diagnostic.status === "error", "Proxy failure diagnostic did not report error status.");
  assert(diagnostic.errorCode === expectedErrorCode, "Proxy failure diagnostic lost errorCode.");
  assert(diagnostic.detailRef === response.error.detailRef, "Proxy failure detailRef mismatch.");
  assertNoProxyCredentialSentinels(response, "Proxy failure public response");
  assertNoProxyCredentialSentinels(diagnostic, "Proxy failure stderr diagnostic");
  return { errorCode: response.error.code };
}

function assertChromiumLaunchGuardEnvelope(response, diagnostic) {
  assert(response.id === "verify-chromium-fixed-proxy-guard", "Chromium launch guard did not echo request id.");
  assert(response.ok === false, "Chromium launch guard did not return ok:false.");
  assert(
    response.error?.code === "PROXY_SOCKS_AUTH_UNSUPPORTED",
    "Chromium launch guard did not return PROXY_SOCKS_AUTH_UNSUPPORTED.",
    { actualErrorCode: response.error?.code },
  );
  assert(response.error?.recoverable === true, "Chromium launch guard error is not recoverable.");
  assert(response.error?.detailRef, "Chromium launch guard error is missing detailRef.");
  assert(diagnostic.status === "error", "Chromium launch guard diagnostic did not report error status.");
  assert(diagnostic.errorCode === "PROXY_SOCKS_AUTH_UNSUPPORTED", "Chromium launch guard diagnostic lost errorCode.");
  assert(diagnostic.detailRef === response.error.detailRef, "Chromium launch guard detailRef mismatch.");
  assertNoProxyCredentialSentinels(response, "Chromium launch guard public response");
  assertNoProxyCredentialSentinels(diagnostic, "Chromium launch guard stderr diagnostic");
  return { errorCode: response.error.code };
}

function runInvalidProxyUpdateNoWrite({ binaryPath, storeRoot, profileId, requestId, proxy, expectedErrorCode, sensitiveValues }) {
  const before = readProfileStore(storeRoot).text;
  const result = runSidecarRequest(
    binaryPath,
    {
      id: requestId,
      method: "profiles.proxy.update",
      params: { storeRoot, profileId, proxy },
    },
    sensitiveValues,
  );
  const after = readProfileStore(storeRoot).text;
  assert(after === before, "Invalid proxy update mutated the persisted profile store.", {
    requestId,
    expectedErrorCode,
    actualErrorCode: result.response?.error?.code,
  });
  assertProxyErrorEnvelope(result.response, result.diagnostic, requestId, expectedErrorCode);
  return result;
}

function assertStoredDiagnosticLogEntries(storeRoot, expectedDiagnostics) {
  const entries = readDiagnosticLogEntries(storeRoot);
  assertNoProxyCredentialSentinels(entries, "Persisted diagnostic lookup JSON");
  for (const [index, entry] of entries.entries()) {
    assert(entry.schemaVersion === 1, `Persisted diagnostic ${index + 1} has the wrong schema version.`);
    assert(entry.source === "python-sidecar", `Persisted diagnostic ${index + 1} has the wrong source.`);
    assert(entry.event === "sidecar.request", `Persisted diagnostic ${index + 1} has the wrong event.`);
    assert(entry.logPath === DIAGNOSTIC_RELATIVE_LOG_PATH, `Persisted diagnostic ${index + 1} has the wrong log path.`);
    assert("method" in entry, `Persisted diagnostic ${index + 1} is missing method.`);
    assert("status" in entry, `Persisted diagnostic ${index + 1} is missing status.`);
    assert("durationMs" in entry, `Persisted diagnostic ${index + 1} is missing durationMs.`);
    assert("errorCode" in entry, `Persisted diagnostic ${index + 1} is missing errorCode.`);
    assert("detailRef" in entry, `Persisted diagnostic ${index + 1} is missing detailRef.`);
    assert(!("params" in entry), `Persisted diagnostic ${index + 1} leaked params.`);
    assert(!("credentials" in entry), `Persisted diagnostic ${index + 1} leaked credentials.`);
    assert(!("context" in entry), `Persisted diagnostic ${index + 1} leaked context.`);
  }

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
  return { diagnosticEntries: entries.length, expectedEntries: expectedDiagnostics.length };
}

function assertVerifierRedactionHelpers() {
  const details = redactForLog({
    stdoutTail: `leaked ${PROXY_USERNAME_SENTINEL}`,
    stderrTail: `leaked ${PROXY_PASSWORD_SENTINEL}`,
    proxyPassword: PROXY_PASSWORD_SENTINEL,
    header: PROXY_HEADER_SENTINEL,
    key: PROXY_KEY_SENTINEL,
  });
  assertNoProxyCredentialSentinels(details, "Verifier redaction helper output");
  assert(!JSON.stringify(details).includes(PROXY_HEADER_SENTINEL), "Verifier redaction helper leaked proxy header sentinel.");
  assert(!JSON.stringify(details).includes(PROXY_KEY_SENTINEL), "Verifier redaction helper leaked proxy key sentinel.");
  return { redactionHelper: "proxy-sentinels" };
}

function assertVerifierEventsRedacted() {
  assertNoProxyCredentialSentinels(VERIFIER_EVENTS, "Verifier emitted step details");
  return { emittedEvents: VERIFIER_EVENTS.length };
}

function assertDiagnosticLogs(diagnostics) {
  const allowedKeys = new Set(["event", "requestId", "method", "status", "durationMs", "errorCode", "detailRef"]);
  for (const [index, event] of diagnostics.entries()) {
    assert(event.event === "sidecar.request", `stderr event ${index + 1} has the wrong event name.`);
    assert("requestId" in event, `stderr event ${index + 1} is missing requestId.`);
    assert("method" in event, `stderr event ${index + 1} is missing method.`);
    assert("status" in event, `stderr event ${index + 1} is missing status.`);
    assert("durationMs" in event, `stderr event ${index + 1} is missing durationMs.`);
    assert("errorCode" in event, `stderr event ${index + 1} is missing errorCode.`);
    assert("detailRef" in event, `stderr event ${index + 1} is missing detailRef.`);
    for (const key of Object.keys(event)) {
      assert(allowedKeys.has(key), `stderr event ${index + 1} included an unexpected diagnostic field.`, {
        field: key,
      });
    }
    assert(!("params" in event), `stderr event ${index + 1} leaked request params.`);
  }
  assertNoProxyCredentialSentinels(diagnostics, "stderr diagnostics");
  return { diagnosticLines: diagnostics.length };
}

function assertRedactedSmokeOutput(transcripts, { storeRoot, profileName }) {
  const stdout = transcripts.map((item) => item.stdout).join("\n");
  const stderr = transcripts.map((item) => item.stderr).join("\n");
  const combined = `${stdout}\n${stderr}`;

  assertNoProxyCredentialSentinels(stdout, "Smoke public stdout");
  assertNoProxyCredentialSentinels(stderr, "Smoke stderr diagnostics");
  assert(!combined.includes(storeRoot), "Smoke output leaked the temporary app-data root.");
  assert(!stderr.includes(profileName), "Smoke diagnostics leaked the profile name.");
  assert(!stderr.includes("params"), "Smoke diagnostics leaked raw params.");
  assert(!combined.includes(PROXY_HEADER_SENTINEL), "Smoke output leaked the proxy header sentinel.");
  assert(!combined.includes(PROXY_KEY_SENTINEL), "Smoke output leaked the proxy key sentinel.");
  assert(!combined.includes("--remote-debugging-port"), "Smoke output leaked debug-port command details.");
  assert(!combined.includes("debugPort"), "Smoke output leaked debugPort details.");
  assert(!combined.includes("9222"), "Smoke output leaked debug-port value.");
  assert(!combined.includes("Traceback"), "Smoke output leaked a Python traceback.");
  return { transcriptCount: transcripts.length };
}

try {
  const targetTriple = runStep("target-triple", () => {
    const value = readTargetTriple();
    assert(value, "rustc did not return a host target triple.");
    return { targetTriple: value };
  }).targetTriple;

  const binaryPath = join(
    ROOT_DIR,
    "src-tauri",
    "binaries",
    `${SIDECAR_NAME}-${targetTriple}${EXTENSION}`,
  );

  runStep("target-binary", () => assertTargetBinary(binaryPath, targetTriple));

  const storeRoot = mkdtempSync(join(tmpdir(), "theprivator-sidecar-smoke-"));
  const profileName = "Smoke Profile Should Not Leak";
  const sensitiveValues = registerSensitiveValues([storeRoot, profileName]);
  const transcripts = [];
  const diagnostics = [];
  const expectedStoredDiagnostics = [];
  const fixedProxyDraft = {
    proxyVersion: 1,
    mode: "fixedServer",
    protocol: "socks5",
    host: "proxy.s01-smoke.example",
    port: 19050,
    credentials: {
      username: PROXY_USERNAME_SENTINEL,
      password: PROXY_PASSWORD_SENTINEL,
    },
  };
  const fixedProxySummary = {
    mode: "fixedServer",
    protocol: "socks5",
    host: "proxy.s01-smoke.example",
    port: 19050,
    credentialState: "configured",
    summary: "socks5://proxy.s01-smoke.example:19050",
  };
  const directProxySummary = {
    mode: "direct",
    credentialState: "none",
    summary: "Direct connection",
  };

  function remember(result, { persisted = false } = {}) {
    transcripts.push(result);
    diagnostics.push(result.diagnostic);
    if (persisted) {
      expectedStoredDiagnostics.push({
        requestId: result.diagnostic.requestId,
        method: result.diagnostic.method,
        status: result.diagnostic.status,
        errorCode: result.diagnostic.errorCode,
        detailRef: result.diagnostic.detailRef,
      });
    }
    return result;
  }

  try {
    const health = runStep("health-envelope", () => {
      const result = remember(
        runSidecarRequest(
          binaryPath,
          { id: "verify-health", method: "health.status", params: {} },
          sensitiveValues,
        ),
      );
      return { value: result, log: { requestId: result.response.id } };
    });
    runStep("health-assertions", () => assertHealthEnvelope(health.response, health.diagnostic));

    const deliberateError = runStep("deliberate-error-envelope", () => {
      const result = remember(
        runSidecarRequest(
          binaryPath,
          { id: "verify-error", method: "diagnostics.fail", params: {} },
          sensitiveValues,
        ),
      );
      return { value: result, log: { requestId: result.response.id } };
    });
    runStep("deliberate-error-assertions", () =>
      assertDeliberateErrorEnvelope(deliberateError.response, deliberateError.diagnostic),
    );

    const invalidInput = runStep("invalid-input-envelope", () => {
      const result = remember(runSidecarInvalidInput(binaryPath, sensitiveValues));
      return { value: result, log: { errorCode: result.response.error?.code } };
    });
    runStep("invalid-input-assertions", () =>
      assertInvalidInputEnvelope(invalidInput.response, invalidInput.diagnostic),
    );

    const directProxyValidated = runStep("proxy-validate-direct", () => {
      const result = remember(
        runSidecarRequest(
          binaryPath,
          {
            id: "verify-proxy-validate-direct",
            method: "proxy.validate",
            params: { proxy: { proxyVersion: 1, mode: "direct" } },
          },
          sensitiveValues,
        ),
      );
      return { value: result, log: { requestId: result.response.id } };
    });
    runStep("proxy-validate-direct-assertions", () =>
      assertProxyValidateEnvelope(
        directProxyValidated.response,
        directProxyValidated.diagnostic,
        "verify-proxy-validate-direct",
        directProxySummary,
      ),
    );

    const fixedProxyValidated = runStep("proxy-validate-authenticated", () => {
      const result = remember(
        runSidecarRequest(
          binaryPath,
          {
            id: "verify-proxy-validate-authenticated",
            method: "proxy.validate",
            params: { proxy: fixedProxyDraft },
          },
          sensitiveValues,
        ),
      );
      return { value: result, log: { requestId: result.response.id } };
    });
    runStep("proxy-validate-authenticated-assertions", () =>
      assertProxyValidateEnvelope(
        fixedProxyValidated.response,
        fixedProxyValidated.diagnostic,
        "verify-proxy-validate-authenticated",
        fixedProxySummary,
      ),
    );

    const created = runStep("profile-create", () => {
      const result = remember(
        runSidecarRequest(
          binaryPath,
          {
            id: "verify-profile-create",
            method: "profiles.create",
            params: { storeRoot, name: profileName },
          },
          sensitiveValues,
        ),
        { persisted: true },
      );
      return { value: result, log: { requestId: result.response.id } };
    });
    const { profileId } = runStep("profile-create-assertions", () =>
      assertProfileCreateEnvelope(created.response, created.diagnostic, profileName),
    );

    const presets = runStep("identity-presets-list", () => {
      const result = remember(
        runSidecarRequest(
          binaryPath,
          { id: "verify-identity-presets", method: "identity.presets.list", params: {} },
          sensitiveValues,
        ),
      );
      return { value: result, log: { requestId: result.response.id } };
    });
    const { presetId } = runStep("identity-presets-assertions", () =>
      assertPresetListEnvelope(presets.response, presets.diagnostic),
    );

    const applied = runStep("identity-apply-preset", () => {
      const result = remember(
        runSidecarRequest(
          binaryPath,
          {
            id: "verify-identity-apply",
            method: "profiles.identity.applyPreset",
            params: { storeRoot, profileId, presetId },
          },
          sensitiveValues,
        ),
        { persisted: true },
      );
      return { value: result, log: { requestId: result.response.id } };
    });
    runStep("identity-apply-assertions", () =>
      assertApplyPresetEnvelope(applied.response, applied.diagnostic, presetId),
    );

    const invalidIdentity = {
      ...applied.response.result.profile.identity,
      debugPort: 9222,
    };
    const invalidIdentityResult = runStep("identity-invalid-update", () => {
      const result = remember(
        runSidecarRequest(
          binaryPath,
          {
            id: "verify-identity-invalid",
            method: "profiles.identity.update",
            params: { storeRoot, profileId, identity: invalidIdentity },
          },
          sensitiveValues,
        ),
        { persisted: true },
      );
      return { value: result, log: { requestId: result.response.id } };
    });
    runStep("identity-invalid-assertions", () =>
      assertInvalidIdentityEnvelope(invalidIdentityResult.response, invalidIdentityResult.diagnostic),
    );

    const proxyUpdated = runStep("profile-proxy-update-authenticated", () => {
      const result = remember(
        runSidecarRequest(
          binaryPath,
          {
            id: "verify-proxy-update",
            method: "profiles.proxy.update",
            params: { storeRoot, profileId, proxy: fixedProxyDraft },
          },
          sensitiveValues,
        ),
        { persisted: true },
      );
      return { value: result, log: { requestId: result.response.id } };
    });
    runStep("profile-proxy-update-assertions", () =>
      assertProxyUpdateEnvelope(proxyUpdated.response, proxyUpdated.diagnostic, profileId, fixedProxySummary),
    );

    runStep("persisted-private-proxy-credentials", () => assertPersistedProxyCredentials(storeRoot, profileId));

    const listed = runStep("profile-list-v3-proxy-summary", () => {
      const result = remember(
        runSidecarRequest(
          binaryPath,
          {
            id: "verify-profile-list-v3",
            method: "profiles.list",
            params: { storeRoot },
          },
          sensitiveValues,
        ),
        { persisted: true },
      );
      return { value: result, log: { requestId: result.response.id } };
    });
    runStep("profile-list-v3-proxy-summary-assertions", () =>
      assertProfileListProxyEnvelope(listed.response, listed.diagnostic, profileId, fixedProxySummary),
    );

    const invalidProxyCases = [
      {
        step: "profile-proxy-invalid-pac-no-write",
        requestId: "verify-proxy-invalid-pac",
        expectedErrorCode: "PROXY_PAC_UNSUPPORTED",
        proxy: {
          proxyVersion: 1,
          mode: "pac",
          pacUrl: "https://proxy.s01-smoke.example/proxy.pac",
          credentials: {
            username: PROXY_USERNAME_SENTINEL,
            password: PROXY_PASSWORD_SENTINEL,
          },
        },
      },
      {
        step: "profile-proxy-invalid-unsafe-field-no-write",
        requestId: "verify-proxy-invalid-unsafe-field",
        expectedErrorCode: "PROXY_INVALID",
        proxy: {
          proxyVersion: 1,
          mode: "fixedServer",
          protocol: "http",
          host: "proxy.s01-smoke.example",
          port: 18080,
          argv: [PROXY_KEY_SENTINEL],
          debugPort: 9222,
        },
      },
      {
        step: "profile-proxy-invalid-bypass-no-write",
        requestId: "verify-proxy-invalid-bypass",
        expectedErrorCode: "PROXY_UNSUPPORTED_MODE",
        proxy: {
          proxyVersion: 1,
          mode: "fixedServer",
          protocol: "http",
          host: "proxy.s01-smoke.example",
          port: 18080,
          bypassList: ["localhost"],
        },
      },
      {
        step: "profile-proxy-invalid-authn-no-write",
        requestId: "verify-proxy-invalid-authn",
        expectedErrorCode: "PROXY_INVALID",
        proxy: {
          proxyVersion: 1,
          mode: "fixedServer",
          protocol: "http",
          host: "proxy.s01-smoke.example",
          port: 18080,
          credentials: {
            username: PROXY_USERNAME_SENTINEL,
            password: "bad\nsecret",
          },
        },
      },
    ];

    for (const testCase of invalidProxyCases) {
      runStep(testCase.step, () => {
        const result = remember(
          runInvalidProxyUpdateNoWrite({
            binaryPath,
            storeRoot,
            profileId,
            requestId: testCase.requestId,
            proxy: testCase.proxy,
            expectedErrorCode: testCase.expectedErrorCode,
            sensitiveValues,
          }),
          { persisted: true },
        );
        return {
          value: result,
          log: { requestId: result.response.id, errorCode: result.response.error?.code, storeUnchanged: true },
        };
      });
    }

    const launchGuard = runStep("chromium-fixed-proxy-launch-guard", () => {
      const result = remember(
        runSidecarRequest(
          binaryPath,
          {
            id: "verify-chromium-fixed-proxy-guard",
            method: "chromium.launch",
            params: { storeRoot, profileId },
          },
          sensitiveValues,
        ),
        { persisted: true },
      );
      return { value: result, log: { requestId: result.response.id, errorCode: result.response.error?.code } };
    });
    runStep("chromium-fixed-proxy-launch-guard-assertions", () =>
      assertChromiumLaunchGuardEnvelope(launchGuard.response, launchGuard.diagnostic),
    );

    runStep("diagnostic-log-shape", () => assertDiagnosticLogs(diagnostics));
    runStep("persisted-diagnostic-log-shape", () =>
      assertStoredDiagnosticLogEntries(storeRoot, expectedStoredDiagnostics),
    );
    runStep("redacted-smoke-output", () => assertRedactedSmokeOutput(transcripts, { storeRoot, profileName }));
    runStep("verifier-redaction-helper", assertVerifierRedactionHelpers);
    runStep("verifier-emitted-redaction", assertVerifierEventsRedacted);
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
  }

  emit({ status: "pass", checks: STEP_RESULTS });
} catch {
  emit({ status: "fail", checks: STEP_RESULTS });
  process.exit(1);
}
