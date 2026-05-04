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
const SIDECAR_NAME = "theprivator-sidecar";
const EXTENSION = process.platform === "win32" ? ".exe" : "";
const STEP_RESULTS = [];
const SENSITIVE_VALUES = new Set([ROOT_DIR]);
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
]);

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
    for (const sensitive of Array.from(SENSITIVE_VALUES).sort((a, b) => b.length - a.length)) {
      if (sensitive) {
        redacted = redacted.split(sensitive).join(sensitive === ROOT_DIR ? "<repo>" : "<redacted>");
      }
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
  assert(
    existsSync(binaryPath),
    `Missing sidecar binary ${relative(ROOT_DIR, binaryPath)}.`,
    "Run npm run sidecar:build before npm run verify:s04.",
  );
  const stats = statSync(binaryPath);
  assert(stats.isFile(), "Target sidecar path is not a file.", relative(ROOT_DIR, binaryPath));
  if (process.platform !== "win32") {
    assert((stats.mode & 0o111) !== 0, "Target sidecar binary is not executable.", relative(ROOT_DIR, binaryPath));
  }
  return { binary: relative(ROOT_DIR, binaryPath), targetTriple };
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
      tail: value.split(/\r?\n/).filter(Boolean).slice(-10).join("\n"),
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
      });
    }
  });
}

function callSidecar(binaryPath, request, options = {}) {
  const input = `${JSON.stringify(request)}\n`;
  const result = spawnSync(binaryPath, {
    cwd: ROOT_DIR,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      fail(`Built sidecar timed out for ${request.method}.`, {
        method: request.method,
        stdoutTail: result.stdout,
        stderrTail: result.stderr,
      });
    }
    fail(`Built sidecar failed for ${request.method}.`, {
      method: request.method,
      error: result.error.message,
    });
  }

  if (result.status !== 0) {
    fail(`Built sidecar exited with status ${result.status ?? "unknown"} for ${request.method}.`, {
      method: request.method,
      stdoutTail: result.stdout,
      stderrTail: result.stderr,
    });
  }

  assertNoSensitiveDiagnostics(result.stderr, request.method);
  const [response] = parseNdjsonLines("stdout", result.stdout, 1);
  const diagnostics = parseNdjsonLines("stderr", result.stderr);
  assert(diagnostics.length >= 1, "Sidecar emitted no diagnostics.", { method: request.method });
  assertRequestDiagnostic(diagnostics[0], request);
  return { response, diagnostics, stderr: result.stderr, stdout: result.stdout };
}

function assertRequestDiagnostic(diagnostic, request) {
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

function assertNoSensitiveDiagnostics(stderr, method) {
  assert(!stderr.includes("Traceback"), "Diagnostic stderr leaked a traceback.", { method });
  assert(!stderr.includes("proxy_user"), "Diagnostic stderr leaked proxy username key.", { method });
  assert(!stderr.includes("proxy_pass"), "Diagnostic stderr leaked proxy password key.", { method });
  assert(!stderr.includes("copied-browser-data-should-not-leak"), "Diagnostic stderr leaked copied browser file content.", { method });
  assert(!stderr.includes("outside-secret-should-not-leak"), "Diagnostic stderr leaked external symlink target data.", { method });
  for (const sensitive of SENSITIVE_VALUES) {
    assert(!stderr.includes(sensitive), "Diagnostic stderr leaked a sensitive path.", { method, sensitive });
  }
}

function sidecarSuccess(binaryPath, id, method, params, options = {}) {
  const { response, diagnostics } = callSidecar(binaryPath, { id, method, params }, options);
  assert(response.id === id, "Sidecar success response id mismatch.", { method, responseId: response.id });
  assert(response.ok === true, `Expected ${method} to succeed.`, {
    method,
    errorCode: response.error?.code,
    detailRef: response.error?.detailRef,
  });
  assert(response.protocolVersion === "1.0.0", "Sidecar protocol version changed.", { method, protocolVersion: response.protocolVersion });
  assert(response.result && typeof response.result === "object" && !Array.isArray(response.result), "Success result must be an object.", { method });
  assert(diagnostics[0].status === "ok", "Successful request diagnostic did not report ok.", diagnostics[0]);
  assert(diagnostics[0].errorCode === null, "Successful diagnostic had an errorCode.", diagnostics[0]);
  assert(diagnostics[0].detailRef === null, "Successful diagnostic had a detailRef.", diagnostics[0]);
  return { result: response.result, diagnostics };
}

function sidecarError(binaryPath, id, method, params, expectedCode, options = {}) {
  const { response, diagnostics } = callSidecar(binaryPath, { id, method, params }, options);
  assert(response.id === id, "Sidecar error response id mismatch.", { method, responseId: response.id });
  assert(response.ok === false, `Expected ${method} to fail safely.`, { method, result: response.result });
  assert(response.protocolVersion === "1.0.0", "Sidecar protocol version changed.", { method, protocolVersion: response.protocolVersion });
  assert(response.error?.code === expectedCode, "Sidecar error code mismatch.", {
    method,
    expectedCode,
    actualCode: response.error?.code,
  });
  assert(response.error?.recoverable === true, "Sidecar error was not recoverable.", response.error);
  assert(typeof response.error?.detailRef === "string" && response.error.detailRef.startsWith("sidecar-"), "Sidecar error lost detailRef.", response.error);
  assert(diagnostics[0].status === "error", "Error request diagnostic did not report error.", diagnostics[0]);
  assert(diagnostics[0].errorCode === expectedCode, "Error diagnostic code mismatch.", diagnostics[0]);
  assert(diagnostics[0].detailRef === response.error.detailRef, "Error diagnostic detailRef mismatch.", diagnostics[0]);
  return { error: response.error, diagnostics };
}

function makeTempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  rememberSensitive(root);
  return root;
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

    sidecarSuccess(binaryPath, "s04-existing-profile", "profiles.create", { storeRoot, name: "Taken" });

    const scan = sidecarSuccess(binaryPath, "s04-scan", "legacy.scan", { storeRoot, legacyRoot }).result;
    assert(scan.scanVersion === 1, "Legacy scanVersion mismatch.", { scanVersion: scan.scanVersion });
    assert(scan.count === 3, "Legacy scan did not find the expected immediate profiles.", { count: scan.count });
    assert(Array.isArray(scan.candidates) && scan.candidates.length === 3, "Legacy scan candidates shape mismatch.", scan);
    const candidates = Object.fromEntries(scan.candidates.map((candidate) => [candidate.folderName, candidate]));
    for (const key of ["good", "partial", "duplicate"]) {
      assert(candidates[key]?.legacyId?.startsWith("legacy-"), "Legacy scan did not return opaque candidate ids.", { key });
      assert(!String(candidates[key].legacyId).includes(legacyRoot), "Legacy id leaked the legacy root.", { key });
    }

    const invalidRoot = sidecarError(
      binaryPath,
      "s04-invalid-root",
      "legacy.scan",
      { storeRoot, legacyRoot: join(legacyRoot, "missing") },
      "LEGACY_ROOT_INVALID",
    );
    assert(invalidRoot.error.detailRef.startsWith("sidecar-"), "Invalid root error lost detailRef.", invalidRoot.error);

    const badItems = sidecarError(
      binaryPath,
      "s04-bad-items",
      "legacy.import",
      { storeRoot, legacyRoot, items: {} },
      "INVALID_REQUEST",
    );
    assert(badItems.error.detailRef.startsWith("sidecar-"), "Bad-items error lost detailRef.", badItems.error);

    const imported = sidecarSuccess(
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
      assert(Object.keys(event).sort().join(",") === "detailRef,errorCode,event,legacyId,status", "Outcome diagnostic leaked forbidden fields.", event);
      assert(event.event === "legacy.import.outcome", "Outcome diagnostic event name mismatch.", event);
      assert(event.legacyId?.startsWith("legacy-"), "Outcome diagnostic legacyId is not opaque.", event);
      assert(event.status === "partial" || event.status === "failed", "Outcome diagnostic status mismatch.", event);
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
  const targetTriple = runStep("target-triple", () => ({ targetTriple: readTargetTriple() })).targetTriple;
  const binaryPath = join(ROOT_DIR, "src-tauri", "binaries", `${SIDECAR_NAME}-${targetTriple}${EXTENSION}`);
  runStep("target-binary", () => assertTargetBinary(binaryPath, targetTriple));
  const smoke = runStep("legacy-built-sidecar-smoke", () => runLegacySmoke(binaryPath));
  emit({ status: "pass", proof: smoke, checks: STEP_RESULTS });
} catch {
  emit({ status: "fail", checks: STEP_RESULTS });
  process.exit(1);
}
