import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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

function parseNdjsonLines(streamName, value, expectedCount) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== expectedCount) {
    fail(
      `${streamName} emitted ${lines.length} NDJSON line(s), expected ${expectedCount}.`,
      `${streamName}LineCount=${lines.length}`,
    );
  }

  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${streamName} line ${index + 1} is not valid JSON.`, error.message);
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

function runSidecarSmoke(binaryPath) {
  const input = [
    JSON.stringify({ id: "verify-health", method: "health.status", params: {} }),
    JSON.stringify({ id: "verify-error", method: "diagnostics.fail", params: {} }),
    "{ invalid json",
  ].join("\n") + "\n";

  const result = spawnSync(binaryPath, {
    cwd: ROOT_DIR,
    input,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      fail("Sidecar smoke timed out and the child process was killed.", result.error.message);
    }
    fail("Sidecar smoke process failed.", result.error.message);
  }

  if (result.status !== 0) {
    fail(`Sidecar exited with status ${result.status ?? "unknown"}.`, "Expected status 0.");
  }

  const stdoutEvents = parseNdjsonLines("stdout", result.stdout, 3);
  const stderrEvents = parseNdjsonLines("stderr", result.stderr, 3);
  return { stdoutEvents, stderrEvents };
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

function assertDiagnosticLogs(stderrEvents) {
  for (const [index, event] of stderrEvents.entries()) {
    assert(event.event === "sidecar.request", `stderr event ${index + 1} has the wrong event name.`);
    assert("requestId" in event, `stderr event ${index + 1} is missing requestId.`);
    assert("method" in event, `stderr event ${index + 1} is missing method.`);
    assert("status" in event, `stderr event ${index + 1} is missing status.`);
    assert("durationMs" in event, `stderr event ${index + 1} is missing durationMs.`);
    assert("errorCode" in event, `stderr event ${index + 1} is missing errorCode.`);
    assert("detailRef" in event, `stderr event ${index + 1} is missing detailRef.`);
    assert(!("params" in event), `stderr event ${index + 1} leaked request params.`);
  }
  return { diagnosticLines: stderrEvents.length };
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
  const { stdoutEvents, stderrEvents } = runStep("sidecar-ndjson", () => {
    const result = runSidecarSmoke(binaryPath);
    return {
      value: result,
      log: {
        stdoutLines: result.stdoutEvents.length,
        stderrLines: result.stderrEvents.length,
      },
    };
  });
  runStep("health-envelope", () => assertHealthEnvelope(stdoutEvents[0], stderrEvents[0]));
  runStep("deliberate-error-envelope", () => assertDeliberateErrorEnvelope(stdoutEvents[1], stderrEvents[1]));
  runStep("invalid-input-envelope", () => assertInvalidInputEnvelope(stdoutEvents[2], stderrEvents[2]));
  runStep("redacted-diagnostic-logs", () => assertDiagnosticLogs(stderrEvents));

  emit({ status: "pass", checks: STEP_RESULTS });
} catch {
  emit({ status: "fail", checks: STEP_RESULTS });
  process.exit(1);
}
