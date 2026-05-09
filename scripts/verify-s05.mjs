import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_NAME = "theprivator-sidecar";
const EXTENSION = process.platform === "win32" ? ".exe" : "";
const DIAGNOSTIC_RELATIVE_LOG_PATH = "profile-store/diagnostics/events.jsonl";
const STEP_RESULTS = [];
const SENSITIVE_VALUES = new Set([ROOT_DIR]);
const FORBIDDEN_LOG_SUBSTRINGS = [
  "params",
  "storeRoot",
  "legacyRoot",
  "stdout",
  "stderr",
  "Traceback",
  "proxy_user",
  "proxy_pass",
  "--user-data-dir",
  "THEPRIVATOR_CHROMIUM_PATH=",
  "command",
  "env",
];

class VerifyFailure extends Error {
  constructor(message, details) {
    super(message);
    this.name = "VerifyFailure";
    this.details = details;
  }
}

function emit(event) {
  console.log(JSON.stringify({ event: "verify.s05", ...event }));
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
    const record = { name, status: "pass", durationMs, ...redact(result.log ?? result) };
    STEP_RESULTS.push(record);
    emit({ step: name, ...redact(result.log ?? result), status: "pass", durationMs });
    return result.value ?? result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    STEP_RESULTS.push({ name, status: "fail", durationMs, message });
    emit({ step: name, status: "fail", durationMs, message });
    if (error?.details) {
      emit({ step: name, status: "fail-details", details: redact(error.details) });
    }
    throw error;
  }
}

function executable(command) {
  return process.platform === "win32" && ["npm", "cargo", "rustc"].includes(command) ? `${command}.cmd` : command;
}

function readTargetTriple() {
  try {
    return execFileSync(executable("rustc"), ["--print", "host-tuple"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail("Failed to determine the Rust host target triple.", error instanceof Error ? error.message : String(error));
  }
}

function resolveBuiltSidecar() {
  const targetTriple = readTargetTriple();
  const binaryPath = join(ROOT_DIR, "src-tauri", "binaries", `${SIDECAR_NAME}-${targetTriple}${EXTENSION}`);
  assert(existsSync(binaryPath), "Missing built sidecar binary. Run npm run sidecar:build before npm run verify:s05.", relative(ROOT_DIR, binaryPath));
  const stats = statSync(binaryPath);
  assert(stats.isFile(), "Built sidecar path is not a file.", relative(ROOT_DIR, binaryPath));
  if (process.platform !== "win32") {
    assert((stats.mode & 0o111) !== 0, "Built sidecar is not executable.", relative(ROOT_DIR, binaryPath));
  }
  return { binaryPath, targetTriple };
}

function parseNdjson(streamName, value, expectedCount = undefined) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (expectedCount !== undefined && lines.length !== expectedCount) {
    fail(`${streamName} emitted ${lines.length} line(s), expected ${expectedCount}.`, { streamName, tail: value.slice(-1000) });
  }

  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${streamName} line ${index + 1} is not valid JSON.`, {
        error: error instanceof Error ? error.message : String(error),
        lineTail: line.slice(-1000),
      });
    }
  });
}

function callSidecar(binaryPath, request, options = {}) {
  const result = spawnSync(binaryPath, {
    cwd: ROOT_DIR,
    input: `${JSON.stringify(request)}\n`,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error) {
    fail(`Built sidecar failed for ${request.method}.`, {
      method: request.method,
      error: result.error.message,
      stdoutTail: result.stdout,
      stderrTail: result.stderr,
    });
  }
  if (result.status !== 0) {
    fail(`Built sidecar exited with status ${result.status ?? "unknown"} for ${request.method}.`, {
      method: request.method,
      stdoutTail: result.stdout,
      stderrTail: result.stderr,
    });
  }

  const [response] = parseNdjson("stdout", result.stdout, 1);
  const diagnostics = parseNdjson("stderr", result.stderr);
  return { response, diagnostics };
}

function assertSuccess(response, requestId, method) {
  assert(response.id === requestId, "Sidecar success id mismatch.", { method, responseId: response.id });
  assert(response.ok === true, `Expected ${method} to succeed.`, { method, response });
  assert(response.protocolVersion === "1.0.0", "Sidecar protocol version changed.", { method, response });
  return response.result;
}

function assertError(response, requestId, code, method) {
  assert(response.id === requestId, "Sidecar error id mismatch.", { method, responseId: response.id });
  assert(response.ok === false, `Expected ${method} to fail.`, { method, response });
  assert(response.protocolVersion === "1.0.0", "Sidecar protocol version changed.", { method, response });
  assert(response.error?.code === code, `Expected ${method} error code ${code}.`, { method, error: response.error });
  assert(response.error?.recoverable === true, `Expected ${method} error to be recoverable.`, { method, error: response.error });
  assert(typeof response.error?.detailRef === "string" && response.error.detailRef.startsWith("sidecar-"), "Expected sidecar detailRef.", {
    method,
    error: response.error,
  });
  return response.error;
}

function diagnosticsLogPath(storeRoot) {
  return join(storeRoot, DIAGNOSTIC_RELATIVE_LOG_PATH);
}

function readDiagnosticRecords(storeRoot) {
  const path = diagnosticsLogPath(storeRoot);
  assert(existsSync(path), "Missing diagnostics log file.", path);
  return parseNdjson("diagnostics log", readFileSync(path, "utf8"));
}

function findRecord(storeRoot, detailRef, expectations) {
  const records = readDiagnosticRecords(storeRoot);
  const record = records.find((entry) => entry.detailRef === detailRef && (!expectations.event || entry.event === expectations.event));
  assert(record, "No persisted diagnostic record matched detailRef.", { detailRef, expectations, records });
  assert(record.schemaVersion === 1, "Diagnostic schema version changed.", record);
  assert(record.logPath === DIAGNOSTIC_RELATIVE_LOG_PATH, "Diagnostic log path must stay relative and fixed.", record);
  assert(record.detailRef === detailRef, "Diagnostic detailRef mismatch.", record);
  assert(record.source === expectations.source, "Diagnostic source mismatch.", record);
  assert(record.event === expectations.event, "Diagnostic event mismatch.", record);
  if (expectations.status !== undefined) {
    assert(record.status === expectations.status, "Diagnostic status mismatch.", record);
  }
  if (expectations.errorCode !== undefined) {
    assert(record.errorCode === expectations.errorCode, "Diagnostic error code mismatch.", record);
  }
  if (expectations.method) {
    assert(record.method === expectations.method, "Diagnostic method mismatch.", record);
  }
  assert(typeof record.durationMs === "number" && record.durationMs >= 0, "Diagnostic duration missing.", record);
  assert(typeof record.ts === "string" && record.ts.endsWith("Z"), "Diagnostic timestamp missing.", record);
  return record;
}

function assertLogRedacted(storeRoot, ...forbiddenValues) {
  const text = readFileSync(diagnosticsLogPath(storeRoot), "utf8");
  for (const forbidden of [...FORBIDDEN_LOG_SUBSTRINGS, ...forbiddenValues, ...SENSITIVE_VALUES]) {
    if (forbidden) {
      assert(!text.includes(String(forbidden)), "Diagnostics log leaked forbidden text.", { forbidden, logTail: text.slice(-2000) });
    }
  }
  return { bytes: Buffer.byteLength(text) };
}

function writeLegacyConfig(profileDir, payload) {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "config.json"), JSON.stringify(payload), "utf8");
}

function assertNoFrontendBypassImports() {
  const appSource = readFileSync(join(ROOT_DIR, "src", "App.tsx"), "utf8");
  const clientSource = readFileSync(join(ROOT_DIR, "src", "sidecar", "client.ts"), "utf8");

  assert(appSource.includes("lookupDiagnosticDetail"), "App.tsx must render diagnostics through the strict sidecar client wrapper.");
  assert(!appSource.includes("@tauri-apps/api/core"), "App.tsx must not import Tauri invoke directly.");
  assert(!/@tauri-apps\/plugin-(dialog|fs|shell)/.test(appSource), "App.tsx must not import filesystem, dialog, or shell bypass plugins.");
  assert(!/showOpenFilePicker|webkitdirectory|readTextFile|writeTextFile|localStorage|type=[\"']file[\"']/.test(appSource), "App.tsx must not add browser filesystem bypasses.");
  assert(
    clientSource.includes('invoke<unknown>("diagnostics_lookup", { detailRef: safeDetailRef })'),
    "src/sidecar/client.ts must call diagnostics_lookup with only the validated detailRef.",
  );
  assert(
    !/diagnostics_lookup[\s\S]{0,160}(logPath|storeRoot|legacyRoot|params|stdout|stderr)/.test(clientSource),
    "src/sidecar/client.ts must not widen diagnostics_lookup inputs or raw diagnostic payload access.",
  );
}

function main() {
  let tempRoot;
  try {
    const { binaryPath, targetTriple } = runStep("built-sidecar-present", () => {
      const resolved = resolveBuiltSidecar();
      return { value: resolved, binary: relative(ROOT_DIR, resolved.binaryPath), targetTriple: resolved.targetTriple };
    });

    runStep("frontend-diagnostic-boundary", () => {
      assertNoFrontendBypassImports();
      return { checkedFiles: ["src/App.tsx", "src/sidecar/client.ts"] };
    });

    tempRoot = mkdtempSync(join(tmpdir(), "theprivator-s05-"));
    const storeRoot = join(tempRoot, "app-data-path-should-not-leak");
    const legacyRoot = join(tempRoot, "legacy-root-should-not-leak");
    rememberSensitive(tempRoot);
    rememberSensitive(storeRoot);
    rememberSensitive(legacyRoot);

    const profile = runStep("profile-diagnostic-correlation", () => {
      const profileName = "S05 Secret Profile Name";
      rememberSensitive(profileName);
      const seed = callSidecar(binaryPath, {
        id: "s05-profile-seed",
        method: "profiles.create",
        params: { storeRoot, name: profileName },
      });
      const seedResult = assertSuccess(seed.response, "s05-profile-seed", "profiles.create");
      const duplicate = callSidecar(binaryPath, {
        id: "s05-profile-duplicate",
        method: "profiles.create",
        params: { storeRoot, name: profileName.toLowerCase() },
      });
      const duplicateError = assertError(duplicate.response, "s05-profile-duplicate", "PROFILE_DUPLICATE_NAME", "profiles.create");
      findRecord(storeRoot, duplicateError.detailRef, {
        source: "python-sidecar",
        event: "sidecar.request",
        status: "error",
        method: "profiles.create",
        errorCode: "PROFILE_DUPLICATE_NAME",
      });

      const invalidName = " S05 Invalid Secret Name ";
      rememberSensitive(invalidName);
      const invalid = callSidecar(binaryPath, {
        id: "s05-profile-invalid-name",
        method: "profiles.create",
        params: { storeRoot, name: invalidName },
      });
      const invalidError = assertError(invalid.response, "s05-profile-invalid-name", "PROFILE_INVALID_NAME", "profiles.create");
      findRecord(storeRoot, invalidError.detailRef, {
        source: "python-sidecar",
        event: "sidecar.request",
        status: "error",
        method: "profiles.create",
        errorCode: "PROFILE_INVALID_NAME",
      });

      const redaction = assertLogRedacted(storeRoot, profileName, profileName.toLowerCase(), invalidName);
      return { value: seedResult.profile, detailRefs: [duplicateError.detailRef, invalidError.detailRef], ...redaction };
    });

    runStep("chromium-diagnostic-correlation", () => {
      const missingChromiumPath = join(tempRoot, "missing-chromium-path-should-not-leak");
      const emptyPath = join(tempRoot, "empty-path");
      mkdirSync(emptyPath, { recursive: true });
      rememberSensitive(missingChromiumPath);
      const launch = callSidecar(
        binaryPath,
        {
          id: "s05-chromium-missing",
          method: "chromium.launch",
          params: { storeRoot, profileId: profile.id },
        },
        { env: { THEPRIVATOR_CHROMIUM_PATH: missingChromiumPath, PATH: emptyPath } },
      );
      const error = assertError(launch.response, "s05-chromium-missing", "CHROMIUM_EXECUTABLE_NOT_FOUND", "chromium.launch");
      findRecord(storeRoot, error.detailRef, {
        source: "python-sidecar",
        event: "sidecar.request",
        status: "error",
        method: "chromium.launch",
        errorCode: "CHROMIUM_EXECUTABLE_NOT_FOUND",
      });
      return { detailRef: error.detailRef, ...assertLogRedacted(storeRoot, missingChromiumPath) };
    });

    runStep("legacy-outcome-diagnostic-correlation", () => {
      const partialName = "S05 Partial Secret Name";
      const staleName = "S05 Stale Secret Name";
      const proxyUser = "s05-proxy-user-should-not-leak";
      const proxyPass = "s05-proxy-pass-should-not-leak";
      const outsideSecretText = "s05-outside-secret-should-not-leak";
      rememberSensitive(partialName);
      rememberSensitive(staleName);
      rememberSensitive(proxyUser);
      rememberSensitive(proxyPass);
      rememberSensitive(outsideSecretText);

      const partialDir = join(legacyRoot, "partial");
      writeLegacyConfig(partialDir, {
        name: partialName,
        proxy_user: proxyUser,
        proxy_pass: proxyPass,
        absolute_path: join(tempRoot, "secret-path-should-not-leak"),
      });
      const userDataDir = join(partialDir, "user-data");
      mkdirSync(userDataDir, { recursive: true });
      const outsideSecret = join(tempRoot, "outside-secret-should-not-leak.txt");
      writeFileSync(outsideSecret, outsideSecretText, "utf8");
      symlinkSync(outsideSecret, join(userDataDir, "unsafe-link"));

      const scan = callSidecar(binaryPath, {
        id: "s05-legacy-scan",
        method: "legacy.scan",
        params: { storeRoot, legacyRoot },
      });
      const scanResult = assertSuccess(scan.response, "s05-legacy-scan", "legacy.scan");
      const candidate = scanResult.candidates[0];
      assert(candidate?.legacyId, "Legacy scan did not return a candidate.", scanResult);

      const imported = callSidecar(binaryPath, {
        id: "s05-legacy-import",
        method: "legacy.import",
        params: {
          storeRoot,
          legacyRoot,
          items: [
            { legacyId: candidate.legacyId, targetName: partialName },
            { legacyId: "legacy-stale-selection", targetName: staleName },
          ],
        },
      });
      const importResult = assertSuccess(imported.response, "s05-legacy-import", "legacy.import");
      assert(importResult.partialCount === 1, "Legacy import should produce one partial outcome.", importResult);
      assert(importResult.failedCount === 1, "Legacy import should produce one failed outcome.", importResult);

      const detailRefs = importResult.outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.error.detailRef);
      assert(detailRefs.length === 2, "Legacy import did not expose two outcome detailRefs.", importResult.outcomes);
      for (const detailRef of detailRefs) {
        const record = findRecord(storeRoot, detailRef, {
          source: "python-sidecar",
          event: "legacy.import.outcome",
          status: undefined,
          method: "legacy.import",
          errorCode: undefined,
        });
        assert(record.status === "partial" || record.status === "failed", "Legacy outcome status mismatch.", record);
        assert(typeof record.errorCode === "string" && record.errorCode.startsWith("LEGACY_"), "Legacy outcome error code mismatch.", record);
        assert(Object.keys(record.context ?? {}).join(",") === "legacyId", "Legacy context must only contain legacyId.", record);
      }

      return {
        detailRefs,
        ...assertLogRedacted(storeRoot, partialName, staleName, proxyUser, proxyPass, outsideSecretText, legacyRoot),
      };
    });

    emit({ step: "summary", status: "pass", steps: STEP_RESULTS.length });
  } catch (error) {
    if (error instanceof VerifyFailure) {
      console.error(error.message);
      if (error.details) {
        console.error(JSON.stringify(redact(error.details), null, 2));
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

main();
