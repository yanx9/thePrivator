import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_NAME = "theprivator-sidecar";
const EXTENSION = process.platform === "win32" ? ".exe" : "";
const STEP_RESULTS = [];

class SmokeFailure extends Error {
  constructor(message, details) {
    super(message);
    this.name = "SmokeFailure";
    this.details = details;
  }
}

function emit(event) {
  console.log(JSON.stringify({ event: "verify.sidecar", ...event }));
}

function fail(message, details) {
  throw new SmokeFailure(message, details);
}

function assert(condition, message, details) {
  if (!condition) {
    fail(message, details);
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
  const text = redactText(value, sensitiveValues);
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
  assert(response.result?.storeVersion === 2, "Profile create did not return storeVersion 2.");
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
  assert(response.result?.storeVersion === 2, "Identity apply did not return storeVersion 2.");
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

function assertDiagnosticLogs(diagnostics) {
  for (const [index, event] of diagnostics.entries()) {
    assert(event.event === "sidecar.request", `stderr event ${index + 1} has the wrong event name.`);
    assert("requestId" in event, `stderr event ${index + 1} is missing requestId.`);
    assert("method" in event, `stderr event ${index + 1} is missing method.`);
    assert("status" in event, `stderr event ${index + 1} is missing status.`);
    assert("durationMs" in event, `stderr event ${index + 1} is missing durationMs.`);
    assert("errorCode" in event, `stderr event ${index + 1} is missing errorCode.`);
    assert("detailRef" in event, `stderr event ${index + 1} is missing detailRef.`);
    assert(!("params" in event), `stderr event ${index + 1} leaked request params.`);
  }
  return { diagnosticLines: diagnostics.length };
}

function assertRedactedSmokeOutput(transcripts, { storeRoot, profileName }) {
  const stdout = transcripts.map((item) => item.stdout).join("\n");
  const stderr = transcripts.map((item) => item.stderr).join("\n");
  const combined = `${stdout}\n${stderr}`;

  assert(!combined.includes(storeRoot), "Smoke output leaked the temporary app-data root.");
  assert(!stderr.includes(profileName), "Smoke diagnostics leaked the profile name.");
  assert(!stderr.includes("params"), "Smoke diagnostics leaked raw params.");
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
  const sensitiveValues = [storeRoot, profileName, "debugPort", "9222", "--remote-debugging-port=9222"];
  const transcripts = [];
  const diagnostics = [];

  try {
    const health = runStep("health-envelope", () => {
      const result = runSidecarRequest(
        binaryPath,
        { id: "verify-health", method: "health.status", params: {} },
        sensitiveValues,
      );
      transcripts.push(result);
      diagnostics.push(result.diagnostic);
      return { value: result, log: { requestId: result.response.id } };
    });
    runStep("health-assertions", () => assertHealthEnvelope(health.response, health.diagnostic));

    const deliberateError = runStep("deliberate-error-envelope", () => {
      const result = runSidecarRequest(
        binaryPath,
        { id: "verify-error", method: "diagnostics.fail", params: {} },
        sensitiveValues,
      );
      transcripts.push(result);
      diagnostics.push(result.diagnostic);
      return { value: result, log: { requestId: result.response.id } };
    });
    runStep("deliberate-error-assertions", () =>
      assertDeliberateErrorEnvelope(deliberateError.response, deliberateError.diagnostic),
    );

    const invalidInput = runStep("invalid-input-envelope", () => {
      const result = runSidecarInvalidInput(binaryPath, sensitiveValues);
      transcripts.push(result);
      diagnostics.push(result.diagnostic);
      return { value: result, log: { errorCode: result.response.error?.code } };
    });
    runStep("invalid-input-assertions", () =>
      assertInvalidInputEnvelope(invalidInput.response, invalidInput.diagnostic),
    );

    const created = runStep("profile-create", () => {
      const result = runSidecarRequest(
        binaryPath,
        {
          id: "verify-profile-create",
          method: "profiles.create",
          params: { storeRoot, name: profileName },
        },
        sensitiveValues,
      );
      transcripts.push(result);
      diagnostics.push(result.diagnostic);
      return { value: result, log: { requestId: result.response.id } };
    });
    const { profileId } = runStep("profile-create-assertions", () =>
      assertProfileCreateEnvelope(created.response, created.diagnostic, profileName),
    );

    const presets = runStep("identity-presets-list", () => {
      const result = runSidecarRequest(
        binaryPath,
        { id: "verify-identity-presets", method: "identity.presets.list", params: {} },
        sensitiveValues,
      );
      transcripts.push(result);
      diagnostics.push(result.diagnostic);
      return { value: result, log: { requestId: result.response.id } };
    });
    const { presetId } = runStep("identity-presets-assertions", () =>
      assertPresetListEnvelope(presets.response, presets.diagnostic),
    );

    const applied = runStep("identity-apply-preset", () => {
      const result = runSidecarRequest(
        binaryPath,
        {
          id: "verify-identity-apply",
          method: "profiles.identity.applyPreset",
          params: { storeRoot, profileId, presetId },
        },
        sensitiveValues,
      );
      transcripts.push(result);
      diagnostics.push(result.diagnostic);
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
      const result = runSidecarRequest(
        binaryPath,
        {
          id: "verify-identity-invalid",
          method: "profiles.identity.update",
          params: { storeRoot, profileId, identity: invalidIdentity },
        },
        sensitiveValues,
      );
      transcripts.push(result);
      diagnostics.push(result.diagnostic);
      return { value: result, log: { requestId: result.response.id } };
    });
    runStep("identity-invalid-assertions", () =>
      assertInvalidIdentityEnvelope(invalidIdentityResult.response, invalidIdentityResult.diagnostic),
    );

    runStep("diagnostic-log-shape", () => assertDiagnosticLogs(diagnostics));
    runStep("redacted-smoke-output", () => assertRedactedSmokeOutput(transcripts, { storeRoot, profileName }));
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
  }

  emit({ status: "pass", checks: STEP_RESULTS });
} catch {
  emit({ status: "fail", checks: STEP_RESULTS });
  process.exit(1);
}
