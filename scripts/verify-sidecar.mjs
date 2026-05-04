import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_NAME = "theprivator-sidecar";
const EXTENSION = process.platform === "win32" ? ".exe" : "";

function fail(message, details) {
  console.error(`[verify:sidecar] ${message}`);
  if (details) {
    console.error(`[verify:sidecar] ${details}`);
  }
  process.exit(1);
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
      lines.join("\n"),
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

function assert(condition, message, details) {
  if (!condition) {
    fail(message, details);
  }
}

const targetTriple = readTargetTriple();
const binaryPath = join(
  ROOT_DIR,
  "src-tauri",
  "binaries",
  `${SIDECAR_NAME}-${targetTriple}${EXTENSION}`,
);

if (!existsSync(binaryPath)) {
  fail(
    `Missing sidecar binary ${relative(ROOT_DIR, binaryPath)}.`,
    "Run npm run sidecar:build first.",
  );
}

const input = [
  JSON.stringify({ id: "verify-health", method: "health.status", params: {} }),
  JSON.stringify({ id: "verify-error", method: "diagnostics.fail", params: {} }),
].join("\n") + "\n";

const result = spawnSync(binaryPath, {
  cwd: ROOT_DIR,
  input,
  encoding: "utf8",
  timeout: 10_000,
  maxBuffer: 1024 * 1024,
});

if (result.error) {
  fail("Sidecar smoke process failed.", result.error.message);
}

if (result.status !== 0) {
  fail(`Sidecar exited with status ${result.status ?? "unknown"}.`, result.stderr);
}

const stdoutEvents = parseNdjsonLines("stdout", result.stdout, 2);
const stderrEvents = parseNdjsonLines("stderr", result.stderr, 2);
const [health, deliberateError] = stdoutEvents;
const [healthLog, errorLog] = stderrEvents;

assert(health.id === "verify-health", "Health response did not echo the request id.");
assert(health.ok === true, "Health response did not return ok:true.");
assert(health.result?.status, "Health response is missing result.status.");
assert(
  health.result?.product?.name === "ThePrivator",
  "Health response is missing product metadata.",
);
assert(
  health.result?.protocol?.version,
  "Health response is missing protocol metadata.",
);
assert(
  health.result?.build?.mode,
  "Health response is missing build metadata.",
);

assert(deliberateError.id === "verify-error", "Diagnostic error did not echo the request id.");
assert(deliberateError.ok === false, "Diagnostic error did not return ok:false.");
assert(
  deliberateError.error?.code === "DIAGNOSTIC_FAILURE",
  "Diagnostic error did not preserve DIAGNOSTIC_FAILURE.",
);
assert(deliberateError.error?.detailRef, "Diagnostic error is missing detailRef.");

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

assert(healthLog.status === "ok", "Health diagnostic did not report ok status.");
assert(errorLog.status === "error", "Deliberate diagnostic did not report error status.");
assert(errorLog.errorCode === "DIAGNOSTIC_FAILURE", "Deliberate diagnostic lost errorCode.");
assert(errorLog.detailRef === deliberateError.error.detailRef, "detailRef mismatch between stdout and stderr.");

console.log(
  `[verify:sidecar] ${relative(ROOT_DIR, binaryPath)} passed health.status and diagnostics.fail smoke checks.`,
);
