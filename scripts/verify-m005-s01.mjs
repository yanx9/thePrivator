#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ROOT_DIR, VerifyFailure, executable } from "./verify-m004-s01.mjs";
import { readGuardedUiSources } from "./ui-sources.mjs";

export const VERIFY_EVENT = "verify.m005.s01";
export const PORTABILITY_EXPORT = "portability.cookies.export";
export const PORTABILITY_REPLACE = "portability.cookies.replace";
export const FORMAT_NETSCAPE = "netscape";
export const FORMAT_THEPRIVATOR_JSON = "theprivator-json";
export const MAX_IMPORT_BYTES = 1_048_576;
export const DIAGNOSTIC_RELATIVE_LOG_PATH = "profile-store/diagnostics/events.jsonl";
export const SIDECAR_EXTERNAL_BIN = "binaries/theprivator-sidecar";

const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];
const REDACTED_VALUE = "<redacted>";
const PYTHON = process.env.PYTHON ?? "python3";
const SAFE_DIAGNOSTIC_KEYS = new Set([
  "event",
  "requestId",
  "method",
  "status",
  "durationMs",
  "errorCode",
  "detailRef",
]);
const SAFE_PERSISTED_DIAGNOSTIC_KEYS = new Set([
  "schemaVersion",
  "ts",
  "source",
  "event",
  "status",
  "logPath",
  "requestId",
  "method",
  "durationMs",
  "errorCode",
  "detailRef",
]);
const SENSITIVE_KEY_PATTERN = /(?:destinationPath|sourcePath|storeRoot|appDataRoot|profileRoot|profileDir|userDataDir|cookieDomain|cookieValue|cookies?|domains?|values?|selectedPath|paths?|stdout|stderr|rawDiagnostics?|rawPayload|stack|traceback|argv|args|env|token|authorization|credential|password|secret|debug|cdp|devtools|endpoint)/i;
const STATIC_FORBIDDEN_PATTERNS = Object.freeze([
  { markerClass: "profile_private_path", pattern: /\b(?:profile-store\/profiles|user-data|app-data-root|XDG_DATA_HOME|APPDATA|LOCALAPPDATA|Application Support)\b/i },
  { markerClass: "raw_diag", pattern: /\b(?:stdout|stderr|raw diagnostics?|rawDiagnostics?|rawBody|rawPayload|Traceback|traceback|stack trace)\b/i },
  { markerClass: "debug_endpoint", pattern: /\b(?:DevToolsActivePort|debugPort|devtoolsPort|remoteDebuggingPort|remote-debugging|--remote-debugging-port|cdp:\/\/|cdpEndpoint|cdpPort)\b/i },
  { markerClass: "credential", pattern: /\b(?:Authorization|Bearer|Proxy-Authorization|credentials?|username|password|secret|token)\b/i },
  { markerClass: "launch_args", pattern: /\b(?:--user-data-dir|--proxy-server|--load-extension|argv|args|env)\b/i },
]);
const M005_FOCUSED_VITEST_FILES = Object.freeze([
  "scripts/verify-m005-s01.test.mjs",
  "src/sidecar/client.test.ts",
  "src/App.test.tsx",
]);
const M005_SOURCE_GUARD_FILES = Object.freeze([
  "scripts/verify-m005-s01.mjs",
  "scripts/verify-m005-s01.test.mjs",
  "src/App.tsx",
  "src/App.test.tsx",
  "src/sidecar/client.ts",
  "src/sidecar/client.test.ts",
  "src/sidecar/types.ts",
  "src-tauri/src/lib.rs",
  "src-tauri/src/sidecar.rs",
]);
const IGNORED_ARTIFACT_REFERENCE_PATTERN = /(?:^|["'`\s/(])(?:\.gsd|\.planning|\.audits)(?:[\/"'`\s)]|$)/;
const FRONTEND_FILESYSTEM_AUTHORITY_PATTERN = /@tauri-apps\/plugin-fs|\b(?:readTextFile|writeTextFile|readFile|writeFile)\s*\(/;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set(argv);
  return {
    sidecarOnly: flags.has("--sidecar-only"),
    capabilityOnly: flags.has("--capability-only"),
    help: flags.has("--help") || flags.has("-h"),
  };
}

export function createM005RedactionContext({
  rootDir = ROOT_DIR,
  storeRoot,
  profileRoot,
  userDataRoot,
  selectedPaths = [],
  cookieDomains = [],
  cookieValues = [],
  extraSensitiveValues = [],
} = {}) {
  const exactValues = [];
  const addValue = (markerClass, value) => {
    if (typeof value === "string" && value.length > 0) {
      exactValues.push({ markerClass, value, pattern: new RegExp(escapeRegExp(value), "g") });
    }
  };

  addValue("repo_root", rootDir);
  addValue("app_root", storeRoot);
  addValue("profile_root", profileRoot);
  addValue("user_data_root", userDataRoot);
  for (const value of selectedPaths) addValue("selected_path", value);
  for (const value of cookieDomains) addValue("cookie_domain", value);
  for (const value of cookieValues) addValue("cookie_value", value);
  for (const value of extraSensitiveValues) addValue("extra_value", value);

  return {
    exactValues: exactValues.sort((left, right) => right.value.length - left.value.length),
    forbiddenPatterns: STATIC_FORBIDDEN_PATTERNS,
  };
}

function classifyForbiddenKey(key) {
  if (/destinationPath|sourcePath|selectedPath|paths?|root|dir/i.test(key)) return "path";
  if (/domains?/i.test(key)) return "cookie_domain";
  if (/values?|cookies?/i.test(key)) return "cookie_value";
  if (/stdout|stderr|raw|stack|traceback/i.test(key)) return "raw_diag";
  if (/debug|cdp|devtools|endpoint/i.test(key)) return "debug_endpoint";
  if (/token|authorization|credential|password|secret/i.test(key)) return "credential";
  if (/argv|args|env/i.test(key)) return "launch_args";
  return "unsafe_field";
}

function redactedKeyName(key) {
  return `<redacted-key:${classifyForbiddenKey(key)}>`;
}

function isRedactedPlaceholderKey(key) {
  return /^<redacted-key:[a-z_]+>$/.test(key);
}

export function redactM005Text(value, context = createM005RedactionContext()) {
  let redacted = String(value ?? "");
  for (const marker of context.exactValues ?? []) {
    redacted = redacted.replace(marker.pattern, `<redacted:${marker.markerClass}>`);
  }
  return redacted
    .replace(/Traceback|traceback|stack trace/gi, "<redacted:raw_diag>")
    .replace(/stdout|stderr|raw diagnostics?|rawDiagnostics?|rawBody|rawPayload/gi, "<redacted:raw_diag>")
    .replace(/DevToolsActivePort|debugPort|--remote-debugging-port(?:=|\s+)\d*|remote-debugging|cdp:\/\/|cdpEndpoint|devtoolsPort/gi, "<redacted:debug_endpoint>")
    .replace(/Authorization|Bearer|Proxy-Authorization|credentials?|username|password|secret|token/gi, "<redacted:private>")
    .replace(/--user-data-dir|--proxy-server|--load-extension|argv|args|env/gi, "<redacted:launch_args>");
}

export function redactedM005Tail(value, context = createM005RedactionContext(), maxLength = 1_200) {
  const text = redactM005Text(value ?? "", context);
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

export function redactM005(value, context = createM005RedactionContext()) {
  if (typeof value === "string") {
    return redactM005Text(value, context);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactM005(item, context));
  }
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[redactedKeyName(key)] = REDACTED_VALUE;
    } else {
      result[redactM005Text(key, context)] = redactM005(nested, context);
    }
  }
  return result;
}

function safeFieldPath(path, keyOrIndex) {
  if (typeof keyOrIndex === "number") return `${path}[${keyOrIndex}]`;
  const segment = SENSITIVE_KEY_PATTERN.test(keyOrIndex) ? redactedKeyName(keyOrIndex) : keyOrIndex;
  return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
}

export function findM005ForbiddenPublicMarker(value, context = createM005RedactionContext(), path = "$", state = { count: 0 }) {
  if (state.count++ > 6_000) {
    return { markerClass: "scan_limit", fieldPath: path, reason: "bounded scan limit exceeded" };
  }
  if (typeof value === "string") {
    for (const marker of context.exactValues ?? []) {
      if (marker.value && value.includes(marker.value)) {
        return { markerClass: marker.markerClass, fieldPath: path, reason: "sensitive exact value" };
      }
    }
    for (const { markerClass, pattern } of context.forbiddenPatterns ?? []) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) {
        return { markerClass, fieldPath: path, reason: "forbidden text marker" };
      }
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findM005ForbiddenPublicMarker(item, context, safeFieldPath(path, index), state);
      if (nested) return nested;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    const isAllowedDiagnosticLookup = key === "logPath" && nested === DIAGNOSTIC_RELATIVE_LOG_PATH;
    if (!isAllowedDiagnosticLookup && !isRedactedPlaceholderKey(key) && SENSITIVE_KEY_PATTERN.test(key)) {
      return { markerClass: classifyForbiddenKey(key), fieldPath: safeFieldPath(path, key), reason: "forbidden key" };
    }
    const marker = findM005ForbiddenPublicMarker(nested, context, safeFieldPath(path, key), state);
    if (marker) return marker;
  }
  return null;
}

export function assertM005PublicEvidenceRedacted(value, context = createM005RedactionContext()) {
  const marker = findM005ForbiddenPublicMarker(value, context);
  assert(!marker, "M005/S01 public evidence contained a forbidden marker.", marker ?? {});
  return { status: "clean", scanned: true };
}

function fail(message, details = {}) {
  throw new VerifyFailure(message, details);
}

function assert(condition, message, details = {}) {
  if (!condition) fail(message, details);
}

function emit(event, context = createM005RedactionContext()) {
  const safeEvent = redactM005({ event: VERIFY_EVENT, ...event }, context);
  VERIFIER_EVENTS.push(safeEvent);
  console.log(JSON.stringify(safeEvent));
}

function resetM005VerificationState() {
  STEP_RESULTS.length = 0;
  VERIFIER_EVENTS.length = 0;
}

function runStep(name, action, context) {
  const started = performance.now();
  try {
    const result = action();
    const log = result?.log ?? result ?? {};
    const value = result?.value ?? result;
    const durationMs = Math.round(performance.now() - started);
    STEP_RESULTS.push({ name, status: "pass", durationMs });
    emit({ phase: name, status: "pass", durationMs, ...log }, context);
    return value;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    const details = error?.details ? redactM005(error.details, context) : undefined;
    STEP_RESULTS.push({ name, status: "fail", durationMs, message });
    emit({ phase: name, status: "fail", durationMs, message, ...(details ? { details } : {}) }, context);
    throw error;
  }
}

function commandName(command, args) {
  return [command, ...args].join(" ");
}

export function formatM005CommandFailure(label, result, context = createM005RedactionContext()) {
  const combinedOutput = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  return redactM005({
    phase: "subprocess",
    command: label,
    exitCode: typeof result?.status === "number" ? result.status : null,
    signal: result?.signal ?? null,
    errorCode: result?.error?.code ?? null,
    timedOut: result?.error?.code === "ETIMEDOUT",
    redactedTail: redactedM005Tail(combinedOutput, context),
    guidance: result?.error?.code === "ETIMEDOUT"
      ? "The child process was terminated after the bounded M005/S01 verifier timeout."
      : "Inspect the named focused command locally; public verifier output includes only a redacted tail.",
  }, context);
}

function runM005CommandStep(name, command, args, timeoutMs, { rootDir = ROOT_DIR, context = createM005RedactionContext({ rootDir }) } = {}) {
  return runStep(name, () => {
    const label = commandName(command, args);
    const result = spawnSync(executable(command), args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });

    if (result.error || result.status !== 0) {
      const failure = formatM005CommandFailure(label, result, context);
      const verb = result.error?.code === "ETIMEDOUT" ? "timed out" : `exited with status ${result.status ?? "unknown"}`;
      fail(`${label} ${verb}.`, failure);
    }

    return { command: label };
  }, context);
}

function parseJsonLine(line, label, context) {
  try {
    return JSON.parse(line);
  } catch (error) {
    fail(`${label} was not valid JSON.`, {
      phase: "sidecar-io",
      lineLength: String(line ?? "").length,
      outputTail: redactM005Text(line, context).slice(-500),
      parserMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseNdjson(value, expectedLines, label, context) {
  const lines = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert(lines.length === expectedLines, `${label} emitted an unexpected number of NDJSON lines.`, {
    phase: "sidecar-io",
    label,
    expectedLines,
    actualLines: lines.length,
    outputTail: redactM005Text(value, context).slice(-500),
  });
  return lines.map((line, index) => parseJsonLine(line, `${label} line ${index + 1}`, context));
}

export function runSourceSidecarRequest(payload, { rootDir = ROOT_DIR, python = PYTHON, context = createM005RedactionContext() } = {}) {
  const result = spawnSync(executable(python), ["-m", "theprivator_sidecar"], {
    cwd: rootDir,
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    fail("Source sidecar request failed to execute.", {
      phase: "sidecar-process",
      errorCode: result.error.code ?? "SPAWN_ERROR",
      outputTail: redactM005Text(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, context).slice(-500),
    });
  }
  if (result.status !== 0) {
    fail("Source sidecar request exited unsuccessfully.", {
      phase: "sidecar-process",
      exitCode: result.status,
      signal: result.signal,
      outputTail: redactM005Text(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, context).slice(-500),
    });
  }
  const [response] = parseNdjson(result.stdout, 1, "sidecar response stream", context);
  const [diagnostic] = parseNdjson(result.stderr, 1, "sidecar diagnostic stream", context);
  return { response, diagnostic };
}

function assertDiagnosticEvent(diagnostic, expected) {
  assert(diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic), "Sidecar diagnostic was not an object.");
  for (const key of Object.keys(diagnostic)) {
    assert(SAFE_DIAGNOSTIC_KEYS.has(key), "Sidecar diagnostic included an unsafe field.", {
      phase: "diagnostic-shape",
      field: key,
    });
  }
  assert(diagnostic.event === "sidecar.request", "Sidecar diagnostic used the wrong event name.");
  assert(diagnostic.method === expected.method, "Sidecar diagnostic method mismatch.", {
    phase: "diagnostic-shape",
    expectedMethod: expected.method,
    actualMethod: diagnostic.method,
  });
  assert(diagnostic.status === expected.status, "Sidecar diagnostic status mismatch.", {
    phase: "diagnostic-shape",
    expectedStatus: expected.status,
    actualStatus: diagnostic.status,
  });
  assert(diagnostic.errorCode === expected.errorCode, "Sidecar diagnostic errorCode mismatch.", {
    phase: "diagnostic-shape",
    expectedCode: expected.errorCode,
    actualCode: diagnostic.errorCode,
  });
  if (expected.detailRef !== undefined) {
    assert(diagnostic.detailRef === expected.detailRef, "Sidecar diagnostic detailRef mismatch.", {
      phase: "diagnostic-shape",
    });
  }
  assert(typeof diagnostic.durationMs === "number" && diagnostic.durationMs >= 0, "Sidecar diagnostic duration was invalid.");
  return { method: diagnostic.method, status: diagnostic.status, errorCode: diagnostic.errorCode, detailRef: diagnostic.detailRef ?? null };
}

function assertPortabilitySuccess(response, { requestId, operation, format }) {
  assert(response.id === requestId, "Portability response did not echo the request id.", { phase: "contract" });
  assert(response.ok === true, "Portability response did not return ok:true.", { phase: "contract" });
  const result = response.result;
  assert(result?.portabilityVersion === 1, "Portability result did not use version 1.", { phase: "contract" });
  assert(result.operation === operation, "Portability operation mismatch.", { phase: "contract" });
  assert(result.format === format, "Portability format mismatch.", { phase: "contract" });
  assert(Array.isArray(result.warnings), "Portability warnings were not an array.", { phase: "contract" });
  assert(result.warningCount === result.warnings.length, "Portability warningCount did not match warnings length.", { phase: "contract" });
  for (const field of ["exportedCount", "importedCount", "replacedCount", "skippedCount", "warningCount"]) {
    if (field in result) {
      assert(Number.isInteger(result[field]) && result[field] >= 0, "Portability count field was invalid.", {
        phase: "contract",
        field,
      });
    }
  }
  assert(!("destinationPath" in result), "Portability result leaked destinationPath.", { phase: "contract" });
  assert(!("sourcePath" in result), "Portability result leaked sourcePath.", { phase: "contract" });
  assert(!("cookies" in result), "Portability result leaked cookie payloads.", { phase: "contract" });
  return result;
}

function assertPortabilityError(response, { requestId, code }) {
  assert(response.id === requestId, "Portability error did not echo the request id.", { phase: "contract" });
  assert(response.ok === false, "Portability error did not return ok:false.", { phase: "contract" });
  assert(response.error?.code === code, "Portability error code mismatch.", {
    phase: "contract",
    expectedCode: code,
    actualCode: response.error?.code,
  });
  assert(response.error?.recoverable === true, "Portability error was not recoverable.", { phase: "contract" });
  assert(typeof response.error?.detailRef === "string" && response.error.detailRef.startsWith("sidecar-"), "Portability error was missing a safe detailRef.", { phase: "contract" });
  assert(!("path" in response.error), "Portability error leaked a path field.", { phase: "contract" });
  return { errorCode: response.error.code, detailRef: response.error.detailRef };
}

function assertNoPublicLeak(value, context, label) {
  const marker = findM005ForbiddenPublicMarker(value, context);
  assert(!marker, `${label} leaked forbidden public evidence.`, marker ?? {});
}

function readJsonFile(path, label, { rootDir = ROOT_DIR } = {}) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} must be valid JSON.`, {
      phase: "capability",
      file: relative(rootDir, path),
      parserMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

function permissionIdentifier(permission) {
  return typeof permission === "string" ? permission : permission?.identifier;
}

function assertNoForbiddenCapability(permission) {
  const identifier = permissionIdentifier(permission);
  assert(typeof identifier === "string" && identifier.length > 0, "Default capability contained an invalid permission entry.", {
    phase: "capability",
    identifier: identifier ?? "unknown",
  });
  assert(!identifier.startsWith("fs:"), "Default capability must not grant frontend filesystem authority.", {
    phase: "capability",
    identifier,
  });
  assert(identifier !== "shell:allow-open" && identifier !== "opener:allow-open" && identifier !== "opener:default", "Default capability must not grant shell/open authority.", {
    phase: "capability",
    identifier,
  });
  assert(identifier !== "dialog:default", "Default capability must not grant broad dialog defaults.", {
    phase: "capability",
    identifier,
  });
}

export function assertM005CapabilityConfig({ rootDir = ROOT_DIR } = {}) {
  const capabilityPath = join(rootDir, "src-tauri", "capabilities", "default.json");
  const packagePath = join(rootDir, "package.json");
  const packageLockPath = join(rootDir, "package-lock.json");
  const cargoTomlPath = join(rootDir, "src-tauri", "Cargo.toml");
  const cargoLockPath = join(rootDir, "src-tauri", "Cargo.lock");
  const libPath = join(rootDir, "src-tauri", "src", "lib.rs");
  const sidecarPath = join(rootDir, "src-tauri", "src", "sidecar.rs");

  const capability = readJsonFile(capabilityPath, "src-tauri/capabilities/default.json", { rootDir });
  const permissions = capability.permissions;
  assert(Array.isArray(permissions), "Default capability permissions must be an array.", { phase: "capability" });

  const permissionIds = [];
  for (const permission of permissions) {
    assertNoForbiddenCapability(permission);
    const identifier = permissionIdentifier(permission);
    if (identifier === "shell:allow-spawn") {
      assert(permission && typeof permission === "object" && !Array.isArray(permission), "shell:allow-spawn must stay scoped by an allowlist object.", {
        phase: "capability",
      });
      const allow = permission.allow;
      const allowedSidecars = Array.isArray(allow)
        ? allow.filter((entry) => entry?.name === SIDECAR_EXTERNAL_BIN && entry?.sidecar === true)
        : [];
      assert(Array.isArray(allow) && allow.length === 1 && allowedSidecars.length === 1, "shell:allow-spawn must allow only the packaged sidecar.", {
        phase: "capability",
        identifier,
      });
    }
    permissionIds.push(identifier);
  }

  const sortedIds = [...permissionIds].sort();
  const expectedIds = ["core:default", "dialog:allow-open", "dialog:allow-save", "shell:allow-spawn"].sort();
  assert(JSON.stringify(sortedIds) === JSON.stringify(expectedIds), "Default capability must contain only core, dialog open/save, and fixed sidecar spawn permissions.", {
    phase: "capability",
    permissions: sortedIds,
  });

  const packageJson = readJsonFile(packagePath, "package.json", { rootDir });
  assert(typeof packageJson.dependencies?.["@tauri-apps/plugin-dialog"] === "string", "package.json must depend on @tauri-apps/plugin-dialog for native file dialogs.", {
    phase: "capability",
  });
  assert(!packageJson.dependencies?.["@tauri-apps/plugin-fs"] && !packageJson.devDependencies?.["@tauri-apps/plugin-fs"], "package.json must not add the Tauri filesystem plugin.", {
    phase: "capability",
  });

  const packageLock = readJsonFile(packageLockPath, "package-lock.json", { rootDir });
  assert(typeof packageLock.packages?.[""]?.dependencies?.["@tauri-apps/plugin-dialog"] === "string", "package-lock root package must include @tauri-apps/plugin-dialog.", {
    phase: "capability",
  });
  assert(packageLock.packages?.["node_modules/@tauri-apps/plugin-dialog"], "package-lock must pin @tauri-apps/plugin-dialog.", {
    phase: "capability",
  });
  assert(!packageLock.packages?.[""]?.dependencies?.["@tauri-apps/plugin-fs"] && !packageLock.packages?.["node_modules/@tauri-apps/plugin-fs"], "package-lock must not include @tauri-apps/plugin-fs.", {
    phase: "capability",
  });

  const cargoToml = readFileSync(cargoTomlPath, "utf8");
  const cargoLock = readFileSync(cargoLockPath, "utf8");
  assert(/^tauri-plugin-dialog\s*=\s*/m.test(cargoToml), "Cargo.toml must depend on tauri-plugin-dialog.", { phase: "capability" });
  assert(!/^tauri-plugin-fs\s*=\s*/m.test(cargoToml), "Cargo.toml must not depend on tauri-plugin-fs.", { phase: "capability" });
  assert(/\nname = "tauri-plugin-dialog"\n/.test(cargoLock), "Cargo.lock must pin tauri-plugin-dialog.", { phase: "capability" });

  const libRs = readFileSync(libPath, "utf8");
  assert(libRs.includes(".plugin(tauri_plugin_dialog::init())"), "Tauri builder must register the dialog plugin.", { phase: "capability" });
  assert(libRs.includes("sidecar::profile_cookies_export") && libRs.includes("sidecar::profile_cookies_replace"), "Tauri invoke handler must register fixed cookie commands.", {
    phase: "capability",
  });

  const sidecarRs = readFileSync(sidecarPath, "utf8");
  assert(sidecarRs.includes('"portability.cookies.export"') && sidecarRs.includes('"portability.cookies.replace"'), "Rust bridge must expose fixed portability cookie method wrappers.", {
    phase: "capability",
  });

  return {
    permissions: sortedIds,
    dialogPlugin: "registered",
    filesystemAuthority: "absent",
    shellOpenAuthority: "absent",
  };
}

export function runCapabilityOnlyVerification({ rootDir = ROOT_DIR, resetState = true, emitFinal = true } = {}) {
  if (resetState) resetM005VerificationState();
  const stepStart = STEP_RESULTS.length;
  const result = runStep("capability.dialog-boundary", () => assertM005CapabilityConfig({ rootDir }), createM005RedactionContext({ rootDir }));
  const summary = {
    event: VERIFY_EVENT,
    status: "pass",
    mode: "capability-only",
    capability: result,
    checks: STEP_RESULTS.slice(stepStart).map((check) => ({ name: check.name, status: check.status, durationMs: check.durationMs })),
  };
  assertM005PublicEvidenceRedacted(summary, createM005RedactionContext({ rootDir }));
  if (emitFinal) emit({ status: "pass", summary }, createM005RedactionContext({ rootDir }));
  return summary;
}

function assertFileExists(rootDir, relativePath) {
  const absolutePath = join(rootDir, relativePath);
  assert(existsSync(absolutePath), "M005/S01 verifier source scan expected a tracked file to exist.", {
    phase: "source-guardrail",
    file: relativePath,
  });
  return absolutePath;
}

export function assertM005SourceGuardrails({ rootDir = ROOT_DIR } = {}) {
  const scannedFiles = [];
  for (const relativePath of M005_SOURCE_GUARD_FILES) {
    const absolutePath = assertFileExists(rootDir, relativePath);
    const source = readFileSync(absolutePath, "utf8");
    scannedFiles.push(relativePath);
    assert(!IGNORED_ARTIFACT_REFERENCE_PATTERN.test(source), "M005/S01 verifier and tests must not import ignored planning artifacts.", {
      phase: "source-guardrail",
      file: relativePath,
      markerClass: "ignored_artifact_reference",
    });
  }

  // Applied per UI file rather than to src/App.tsx alone, so the rule still holds
  // once the UI is split into components. See scripts/ui-sources.mjs.
  for (const file of readGuardedUiSources(rootDir).files) {
    assert(!FRONTEND_FILESYSTEM_AUTHORITY_PATTERN.test(file.text), "Cookie portability UI must not gain frontend filesystem authority.", {
      phase: "source-guardrail",
      file: file.path,
      markerClass: "frontend_filesystem_authority",
    });
    assert(!file.text.includes('"profile_cookies_export"') && !file.text.includes('"profile_cookies_replace"'), "Cookie portability UI must call typed client wrappers instead of raw invoke command names.", {
      phase: "source-guardrail",
      file: file.path,
      markerClass: "raw_cookie_invoke_in_ui",
    });
  }

  const clientSource = readFileSync(assertFileExists(rootDir, "src/sidecar/client.ts"), "utf8");
  assert(!clientSource.includes('"portability.cookies.export"') && !clientSource.includes('"portability.cookies.replace"'), "TypeScript client must not expose raw sidecar portability method strings.", {
    phase: "source-guardrail",
    file: "src/sidecar/client.ts",
    markerClass: "raw_sidecar_method_in_client",
  });
  assert(clientSource.includes('invoke<unknown>("profile_cookies_export"') && clientSource.includes('invoke<unknown>("profile_cookies_replace"'), "TypeScript client must keep fixed cookie portability Tauri wrappers.", {
    phase: "source-guardrail",
    file: "src/sidecar/client.ts",
    markerClass: "missing_fixed_wrappers",
  });

  return {
    scannedFiles: scannedFiles.length,
    frontendFilesystemAuthority: "absent",
    ignoredArtifactImports: "absent",
    uiUsesTypedWrappers: true,
    clientUsesFixedCommands: true,
  };
}

export function assertM005ReadmeDocs({ rootDir = ROOT_DIR } = {}) {
  const readme = readFileSync(assertFileExists(rootDir, "README.md"), "utf8");
  assert(readme.includes("npm run verify:m005:s01"), "README must document the canonical M005/S01 verifier command.", {
    phase: "docs",
    markerClass: "missing_command",
  });
  assert(/M005\s*S01|cookie portability/i.test(readme), "README must name the cookie portability source proof.", {
    phase: "docs",
    markerClass: "missing_scope",
  });
  assert(/S04/i.test(readme) && /packaged/i.test(readme) && /dialog/i.test(readme), "README must defer packaged real-dialog proof to S04.", {
    phase: "docs",
    markerClass: "missing_s04_boundary",
  });
  assert(/no-frontend-filesystem|no frontend filesystem/i.test(readme) && /no-path-leak|path leak|selected locations/i.test(readme), "README must document the frontend filesystem and selected-location redaction boundary.", {
    phase: "docs",
    markerClass: "missing_authority_boundary",
  });
  return {
    command: "documented",
    packagedDialogProof: "deferred-to-s04",
    authorityBoundary: "documented",
  };
}

function createStoreProfile(context) {
  const profileName = "M005 Cookie Smoke";
  const created = runSourceSidecarRequest(
    {
      id: "m005-profile-create",
      method: "profiles.create",
      params: { storeRoot: context.storeRoot, name: profileName },
    },
    { context: context.redactionContext },
  );
  assert(created.response.ok === true, "Smoke profile could not be created.", { phase: "fixture" });
  const profileId = created.response.result?.profile?.id;
  assert(typeof profileId === "string" && profileId.length > 0, "Smoke profile id was missing.", { phase: "fixture" });
  return profileId;
}

function runPythonFixture(script, input, context, label) {
  const result = spawnSync(executable(PYTHON), ["-c", script], {
    cwd: ROOT_DIR,
    input: JSON.stringify(input),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`${label} fixture failed.`, {
      phase: "fixture",
      label,
      exitCode: result.status,
      errorCode: result.error?.code ?? null,
      outputTail: redactM005Text(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, context).slice(-500),
    });
  }
  if (!String(result.stdout ?? "").trim()) return {};
  return parseJsonLine(result.stdout.trim(), `${label} fixture output`, context);
}

function createCookieDbFixture({ storeRoot, profileId, cookieDomain, cookieValue, secondCookieValue }, context) {
  const script = String.raw`
import json, sqlite3, sys
from pathlib import Path
from theprivator_sidecar.cookies import _CANONICAL_COOKIE_SCHEMA, unix_time_to_chrome
payload = json.load(sys.stdin)
root = Path(payload["storeRoot"])
profile_id = payload["profileId"]
db_path = root / "profile-store" / "profiles" / profile_id / "user-data" / "Default" / "Network" / "Cookies"
db_path.parent.mkdir(parents=True, exist_ok=True)
conn = sqlite3.connect(db_path)
try:
    conn.execute(_CANONICAL_COOKIE_SCHEMA)
    now = unix_time_to_chrome(1_700_000_000)
    expiry = unix_time_to_chrome(1_900_000_000)
    rows = [
        (now, payload["cookieDomain"], "", "session_id", payload["cookieValue"], b"", "/", expiry, 1, 1, now, 1, 1, 2, 1, 2, 443, 0, now, 0, 0),
        (now, "." + payload["cookieDomain"], "", "session_cookie", payload["secondCookieValue"], b"", "/session", 0, 0, 0, now, 0, 0, 1, -1, 1, 80, 0, now, 0, 0),
    ]
    conn.executemany("INSERT INTO cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port, is_same_party, last_update_utc, source_type, has_cross_site_ancestor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    conn.commit()
finally:
    conn.close()
print(json.dumps({"count": 2}))
`;
  return runPythonFixture(script, { storeRoot, profileId, cookieDomain, cookieValue, secondCookieValue }, context, "cookie-db-create");
}

function cookieDbSummary({ storeRoot, profileId, expectedValues = [] }, context) {
  const script = String.raw`
import json, sqlite3, sys
from pathlib import Path
payload = json.load(sys.stdin)
db_path = Path(payload["storeRoot"]) / "profile-store" / "profiles" / payload["profileId"] / "user-data" / "Default" / "Network" / "Cookies"
conn = sqlite3.connect(db_path)
try:
    rows = conn.execute("SELECT name, value FROM cookies ORDER BY host_key, path, name").fetchall()
finally:
    conn.close()
values = [row[1] for row in rows]
print(json.dumps({
    "count": len(rows),
    "hasExpectedValues": all(value in values for value in payload.get("expectedValues", [])),
}))
`;
  return runPythonFixture(script, { storeRoot, profileId, expectedValues }, context, "cookie-db-summary");
}

function writeImportJson(path, cookies) {
  writeFileSync(path, `${JSON.stringify({ format: "theprivator.cookies", version: 1, cookies }, null, 2)}\n`, "utf8");
}

function readDiagnostics(storeRoot, context) {
  const path = join(storeRoot, DIAGNOSTIC_RELATIVE_LOG_PATH);
  assert(existsSync(path), "Diagnostic log was not written.", { phase: "diagnostics" });
  const lines = readFileSync(path, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => parseJsonLine(line, `diagnostic ${index + 1}`, context));
}

function assertPersistedDiagnostics(entries, expectedRows) {
  for (const [index, entry] of entries.entries()) {
    for (const key of Object.keys(entry)) {
      assert(SAFE_PERSISTED_DIAGNOSTIC_KEYS.has(key), "Persisted diagnostic included an unsafe field.", {
        phase: "diagnostics",
        index,
        field: key,
      });
    }
    assert(entry.event === "sidecar.request", "Persisted diagnostic event mismatch.", { phase: "diagnostics", index });
    assert(entry.logPath === DIAGNOSTIC_RELATIVE_LOG_PATH, "Persisted diagnostic logPath mismatch.", { phase: "diagnostics", index });
  }
  for (const expected of expectedRows) {
    const matches = entries.filter((entry) => entry.requestId === expected.requestId && entry.method === expected.method);
    assert(matches.length === 1, "Persisted diagnostics did not contain exactly one expected row.", {
      phase: "diagnostics",
      requestId: expected.requestId,
      method: expected.method,
      matchCount: matches.length,
    });
    const row = matches[0];
    assert(row.status === expected.status, "Persisted diagnostic status mismatch.", { phase: "diagnostics" });
    assert(row.errorCode === expected.errorCode, "Persisted diagnostic errorCode mismatch.", { phase: "diagnostics" });
    assert(row.detailRef === expected.detailRef, "Persisted diagnostic detailRef mismatch.", { phase: "diagnostics" });
  }
  return { diagnosticEntries: entries.length, expectedEntries: expectedRows.length };
}

function writeBusyRuntimeRecord(storeRoot, profileId) {
  const runtimePath = join(storeRoot, "profile-store", "runtime", "chromium-processes.json");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, `${JSON.stringify({
    registryVersion: 1,
    processes: {
      [profileId]: {
        profileId,
        pid: process.pid,
        startedAt: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"),
        userDataDir: `profile-store/profiles/${profileId}/user-data`,
        ownerToken: "m005-runtime-owner",
      },
    },
  }, null, 2)}\n`, "utf8");
}

function clearBusyRuntimeRecord(storeRoot) {
  const runtimePath = join(storeRoot, "profile-store", "runtime", "chromium-processes.json");
  writeFileSync(runtimePath, `${JSON.stringify({ registryVersion: 1, processes: {} }, null, 2)}\n`, "utf8");
}

export function buildM005FinalSummary({ status, checks, sidecar }) {
  const summary = {
    event: VERIFY_EVENT,
    status,
    mode: "sidecar-only",
    sidecar: {
      emptyExported: Boolean(sidecar?.emptyExported),
      exportedJson: Boolean(sidecar?.exportedJson),
      exportedNetscape: Boolean(sidecar?.exportedNetscape),
      legacyExportRejected: Boolean(sidecar?.legacyExportRejected),
      replaced: Boolean(sidecar?.replaced),
      invalidImportPreservedRows: Boolean(sidecar?.invalidImportPreservedRows),
      oversizedImportPreservedRows: Boolean(sidecar?.oversizedImportPreservedRows),
      unsupportedFormatRejected: Boolean(sidecar?.unsupportedFormatRejected),
      busyRejected: Boolean(sidecar?.busyRejected),
      diagnosticsRedacted: Boolean(sidecar?.diagnosticsRedacted),
      cleanup: {
        status: sidecar?.cleanup?.status ?? "unknown",
        retained: Boolean(sidecar?.cleanup?.retained),
      },
      counts: {
        zeroJsonExported: Number(sidecar?.counts?.zeroJsonExported ?? 0),
        jsonExported: Number(sidecar?.counts?.jsonExported ?? 0),
        netscapeExported: Number(sidecar?.counts?.netscapeExported ?? 0),
        imported: Number(sidecar?.counts?.imported ?? 0),
        replaced: Number(sidecar?.counts?.replaced ?? 0),
        skipped: Number(sidecar?.counts?.skipped ?? 0),
      },
    },
    checks: checks.map((check) => ({ name: check.name, status: check.status, durationMs: check.durationMs })),
  };
  assert(!findM005ForbiddenPublicMarker(summary), "M005 final summary was not redaction-safe.");
  return summary;
}

export function buildM005FullSummary({ status, checks, commands, capability, sourceGuardrails, docs, sidecar }) {
  const summary = {
    event: VERIFY_EVENT,
    status,
    mode: "full",
    commands: {
      focusedVitest: commands?.focusedVitest ?? "unknown",
      typescriptBuild: commands?.typescriptBuild ?? "unknown",
      sidecarBuild: commands?.sidecarBuild ?? "unknown",
      rustCommandTests: commands?.rustCommandTests ?? "unknown",
    },
    capability,
    sourceGuardrails,
    docs,
    sidecar,
    checks: checks.map((check) => ({ name: check.name, status: check.status, durationMs: check.durationMs })),
  };
  assert(!findM005ForbiddenPublicMarker(summary), "M005 full summary was not redaction-safe.");
  return summary;
}

function recordCleanupStep(storeRoot, { keepTemp, context }) {
  const started = performance.now();
  const duration = () => Math.round(performance.now() - started);
  if (keepTemp) {
    const durationMs = duration();
    const cleanup = { status: "retained", retained: true };
    STEP_RESULTS.push({ name: "cleanup.temp-fixtures", status: "pass", durationMs });
    emit({ phase: "cleanup.temp-fixtures", status: "pass", durationMs, cleanupStatus: cleanup.status, retained: cleanup.retained }, context);
    return cleanup;
  }

  try {
    rmSync(storeRoot, { recursive: true, force: true });
    const durationMs = duration();
    const cleanup = { status: "removed", retained: false };
    STEP_RESULTS.push({ name: "cleanup.temp-fixtures", status: "pass", durationMs });
    emit({ phase: "cleanup.temp-fixtures", status: "pass", durationMs, cleanupStatus: cleanup.status, retained: cleanup.retained }, context);
    return cleanup;
  } catch (error) {
    const durationMs = duration();
    const cleanup = { status: "failed", retained: true, errorCode: error?.code ?? "CLEANUP_FAILED" };
    STEP_RESULTS.push({ name: "cleanup.temp-fixtures", status: "fail", durationMs });
    emit({ phase: "cleanup.temp-fixtures", status: "fail", durationMs, cleanupStatus: cleanup.status, errorCode: cleanup.errorCode }, context);
    return cleanup;
  }
}

export function runSidecarOnlySmoke({ rootDir = ROOT_DIR, python = PYTHON, keepTemp = false, resetState = true, emitFinal = true } = {}) {
  if (resetState) resetM005VerificationState();
  const sidecarStepStart = STEP_RESULTS.length;
  void rootDir;
  void python;
  const storeRoot = mkdtempSync(join(tmpdir(), "theprivator-m005-s01-"));
  const cookieDomain = "m005-cookie-domain.invalid";
  const cookieValue = "m005-secret-cookie-value";
  const secondCookieValue = "m005-second-secret-cookie-value";
  const replacementValue = "m005-replacement-secret-cookie-value";
  const exportJsonPath = join(storeRoot, "export-should-not-leak.json");
  const zeroExportJsonPath = join(storeRoot, "zero-export-should-not-leak.json");
  const exportTxtPath = join(storeRoot, "export-should-not-leak.txt");
  const importJsonPath = join(storeRoot, "import-should-not-leak.json");
  const malformedJsonPath = join(storeRoot, "malformed-should-not-leak.json");
  const oversizedPath = join(storeRoot, "oversized-should-not-leak.txt");
  const unsupportedPath = join(storeRoot, "unsupported-should-not-leak.csv");
  const busyExportPath = join(storeRoot, "busy-should-not-leak.json");
  const redactionContext = createM005RedactionContext({
    storeRoot,
    selectedPaths: [exportJsonPath, zeroExportJsonPath, exportTxtPath, importJsonPath, malformedJsonPath, oversizedPath, unsupportedPath, busyExportPath],
    cookieDomains: [cookieDomain, `.${cookieDomain}`],
    cookieValues: [cookieValue, secondCookieValue, replacementValue],
  });
  const context = { storeRoot, redactionContext };
  const expectedDiagnostics = [];
  const portabilityPublicEvidence = [];
  const sidecar = { counts: {} };

  function remember(result, { requestId, method, status, errorCode, detailRef }) {
    portabilityPublicEvidence.push(result.response, result.diagnostic);
    expectedDiagnostics.push({ requestId, method, status, errorCode, detailRef });
    return result;
  }

  try {
    const profileId = runStep("fixture.profile", () => {
      const id = createStoreProfile(context);
      const userDataRoot = join(storeRoot, "profile-store", "profiles", id, "user-data");
      context.redactionContext = createM005RedactionContext({
        storeRoot,
        profileRoot: dirname(userDataRoot),
        userDataRoot,
        selectedPaths: [exportJsonPath, zeroExportJsonPath, exportTxtPath, importJsonPath, malformedJsonPath, oversizedPath, unsupportedPath, busyExportPath],
        cookieDomains: [cookieDomain, `.${cookieDomain}`],
        cookieValues: [cookieValue, secondCookieValue, replacementValue],
      });
      return { value: id, log: { profileReady: true } };
    }, context.redactionContext);

    runStep("sidecar.zero-cookie-export", () => {
      const result = remember(
        runSourceSidecarRequest({
          id: "m005-export-zero-json",
          method: PORTABILITY_EXPORT,
          params: { storeRoot, profileId, destinationPath: zeroExportJsonPath, format: FORMAT_THEPRIVATOR_JSON },
        }, { context: context.redactionContext }),
        { requestId: "m005-export-zero-json", method: PORTABILITY_EXPORT, status: "ok", errorCode: null, detailRef: null },
      );
      const payload = assertPortabilitySuccess(result.response, { requestId: "m005-export-zero-json", operation: "export", format: FORMAT_THEPRIVATOR_JSON });
      assertDiagnosticEvent(result.diagnostic, { method: PORTABILITY_EXPORT, status: "ok", errorCode: null, detailRef: null });
      assert(payload.exportedCount === 0 && payload.skippedCount === 0 && payload.warningCount === 0, "Zero-cookie export did not report clean zero counts.", { phase: "zero-cookie" });
      const exported = JSON.parse(readFileSync(zeroExportJsonPath, "utf8"));
      assert(Array.isArray(exported) && exported.length === 0, "Zero-cookie JSON export did not write an empty cookie array.", { phase: "zero-cookie" });
      sidecar.emptyExported = true;
      sidecar.counts.zeroJsonExported = payload.exportedCount;
      return { exportedCount: payload.exportedCount, warningCount: payload.warningCount };
    }, context.redactionContext);

    runStep("fixture.cookie-db", () => {
      const result = createCookieDbFixture({ storeRoot, profileId, cookieDomain, cookieValue, secondCookieValue }, context.redactionContext);
      assert(result.count === 2, "Cookie DB fixture did not create the expected rows.", { phase: "fixture" });
      return { rowCount: result.count };
    }, context.redactionContext);

    const jsonExport = runStep("sidecar.export-json", () => {
      const result = remember(
        runSourceSidecarRequest({
          id: "m005-export-json",
          method: PORTABILITY_EXPORT,
          params: { storeRoot, profileId, destinationPath: exportJsonPath, format: FORMAT_THEPRIVATOR_JSON },
        }, { context: context.redactionContext }),
        { requestId: "m005-export-json", method: PORTABILITY_EXPORT, status: "ok", errorCode: null, detailRef: null },
      );
      const payload = assertPortabilitySuccess(result.response, { requestId: "m005-export-json", operation: "export", format: FORMAT_THEPRIVATOR_JSON });
      assertDiagnosticEvent(result.diagnostic, { method: PORTABILITY_EXPORT, status: "ok", errorCode: null, detailRef: null });
      assert(payload.exportedCount === 2, "JSON export did not report two exported cookies.", { phase: "export" });
      const exported = JSON.parse(readFileSync(exportJsonPath, "utf8"));
      assert(Array.isArray(exported) && exported.length === 2, "JSON export did not write the expected cookie array.", { phase: "export" });
      assert(exported.every((cookie) => cookie.storeId === "Default" && typeof cookie.session === "boolean" && typeof cookie.expirationDate === "number" && ["Lax", "Strict", "None", "Unspecified"].includes(cookie.sameSite)), "JSON export used the wrong cookie fields.", { phase: "export" });
      sidecar.exportedJson = true;
      sidecar.counts.jsonExported = payload.exportedCount;
      return { exportedCount: payload.exportedCount, warningCount: payload.warningCount };
    }, context.redactionContext);

    runStep("sidecar.legacy-export-rejected", () => {
      const result = runSourceSidecarRequest({
        id: "m005-export-netscape",
        method: PORTABILITY_EXPORT,
        params: { storeRoot, profileId, destinationPath: exportTxtPath, format: FORMAT_NETSCAPE },
      }, { context: context.redactionContext });
      const error = assertPortabilityError(result.response, { requestId: "m005-export-netscape", code: "PORTABILITY_UNSUPPORTED_FORMAT" });
      assertDiagnosticEvent(result.diagnostic, { method: PORTABILITY_EXPORT, status: "error", errorCode: "PORTABILITY_UNSUPPORTED_FORMAT", detailRef: error.detailRef });
      remember(result, { requestId: "m005-export-netscape", method: PORTABILITY_EXPORT, status: "error", errorCode: "PORTABILITY_UNSUPPORTED_FORMAT", detailRef: error.detailRef });
      assert(!existsSync(exportTxtPath), "Removed text export unexpectedly wrote a file.", { phase: "export" });
      sidecar.legacyExportRejected = true;
      return { errorCode: error.errorCode };
    }, context.redactionContext);

    runStep("sidecar.replace-json", () => {
      writeImportJson(importJsonPath, [
        { domain: cookieDomain, hostOnly: true, path: "/", name: "session_id", value: "m005-duplicate-old", secure: true, httpOnly: true, expiresUnix: 1_900_000_000, sameSite: "lax", priority: "high" },
        { domain: cookieDomain, hostOnly: true, path: "/", name: "session_id", value: replacementValue, secure: true, httpOnly: true, expiresUnix: 1_900_000_000, sameSite: "strict", priority: "medium" },
        { domain: `.${cookieDomain}`, hostOnly: false, path: "/new", name: "new_cookie", value: secondCookieValue, secure: false, httpOnly: false, expiresUnix: null, sameSite: "unspecified", priority: "medium" },
      ]);
      const result = remember(
        runSourceSidecarRequest({
          id: "m005-replace-json",
          method: PORTABILITY_REPLACE,
          params: { storeRoot, profileId, sourcePath: importJsonPath },
        }, { context: context.redactionContext }),
        { requestId: "m005-replace-json", method: PORTABILITY_REPLACE, status: "ok", errorCode: null, detailRef: null },
      );
      const payload = assertPortabilitySuccess(result.response, { requestId: "m005-replace-json", operation: "replace", format: FORMAT_THEPRIVATOR_JSON });
      assertDiagnosticEvent(result.diagnostic, { method: PORTABILITY_REPLACE, status: "ok", errorCode: null, detailRef: null });
      assert(payload.importedCount === 2, "Replace did not import the expected unique cookie count.", { phase: "replace" });
      assert(payload.replacedCount === 1, "Replace did not report the expected replaced cookie count.", { phase: "replace" });
      assert(payload.skippedCount === 1, "Replace did not report the expected duplicate skip count.", { phase: "replace" });
      const summary = cookieDbSummary({ storeRoot, profileId, expectedValues: [replacementValue, secondCookieValue] }, context.redactionContext);
      assert(summary.count === 2 && summary.hasExpectedValues, "Cookie DB rows did not match replace results.", { phase: "replace" });
      sidecar.replaced = true;
      sidecar.counts.imported = payload.importedCount;
      sidecar.counts.replaced = payload.replacedCount;
      sidecar.counts.skipped = payload.skippedCount;
      return { importedCount: payload.importedCount, replacedCount: payload.replacedCount, skippedCount: payload.skippedCount };
    }, context.redactionContext);

    runStep("sidecar.invalid-import-preserves-db", () => {
      const before = cookieDbSummary({ storeRoot, profileId, expectedValues: [replacementValue, secondCookieValue] }, context.redactionContext);
      writeFileSync(malformedJsonPath, `${JSON.stringify({ format: "theprivator.cookies", version: 999, cookies: [] })}\n`, "utf8");
      const result = runSourceSidecarRequest({
        id: "m005-replace-invalid",
        method: PORTABILITY_REPLACE,
        params: { storeRoot, profileId, sourcePath: malformedJsonPath },
      }, { context: context.redactionContext });
      const error = assertPortabilityError(result.response, { requestId: "m005-replace-invalid", code: "PORTABILITY_COOKIE_FILE_INVALID" });
      assertDiagnosticEvent(result.diagnostic, { method: PORTABILITY_REPLACE, status: "error", errorCode: "PORTABILITY_COOKIE_FILE_INVALID", detailRef: error.detailRef });
      remember(result, { requestId: "m005-replace-invalid", method: PORTABILITY_REPLACE, status: "error", errorCode: "PORTABILITY_COOKIE_FILE_INVALID", detailRef: error.detailRef });
      const after = cookieDbSummary({ storeRoot, profileId, expectedValues: [replacementValue, secondCookieValue] }, context.redactionContext);
      assert(after.count === before.count && after.hasExpectedValues, "Invalid import mutated existing cookies.", { phase: "invalid-import" });
      sidecar.invalidImportPreservedRows = true;
      return { errorCode: error.errorCode, rowsPreserved: true };
    }, context.redactionContext);

    runStep("sidecar.oversized-import-preserves-db", () => {
      const before = cookieDbSummary({ storeRoot, profileId, expectedValues: [replacementValue, secondCookieValue] }, context.redactionContext);
      writeFileSync(oversizedPath, "x".repeat(MAX_IMPORT_BYTES + 1), "utf8");
      const result = runSourceSidecarRequest({
        id: "m005-replace-oversized",
        method: PORTABILITY_REPLACE,
        params: { storeRoot, profileId, sourcePath: oversizedPath },
      }, { context: context.redactionContext });
      const error = assertPortabilityError(result.response, { requestId: "m005-replace-oversized", code: "PORTABILITY_COOKIE_FILE_TOO_LARGE" });
      assertDiagnosticEvent(result.diagnostic, { method: PORTABILITY_REPLACE, status: "error", errorCode: "PORTABILITY_COOKIE_FILE_TOO_LARGE", detailRef: error.detailRef });
      remember(result, { requestId: "m005-replace-oversized", method: PORTABILITY_REPLACE, status: "error", errorCode: "PORTABILITY_COOKIE_FILE_TOO_LARGE", detailRef: error.detailRef });
      const after = cookieDbSummary({ storeRoot, profileId, expectedValues: [replacementValue, secondCookieValue] }, context.redactionContext);
      assert(after.count === before.count && after.hasExpectedValues, "Oversized import mutated existing cookies.", { phase: "oversized-import" });
      sidecar.oversizedImportPreservedRows = true;
      return { errorCode: error.errorCode, rowsPreserved: true };
    }, context.redactionContext);

    runStep("sidecar.unsupported-format-rejected", () => {
      const before = cookieDbSummary({ storeRoot, profileId, expectedValues: [replacementValue, secondCookieValue] }, context.redactionContext);
      const result = runSourceSidecarRequest({
        id: "m005-replace-unsupported",
        method: PORTABILITY_REPLACE,
        params: { storeRoot, profileId, sourcePath: unsupportedPath },
      }, { context: context.redactionContext });
      const error = assertPortabilityError(result.response, { requestId: "m005-replace-unsupported", code: "PORTABILITY_UNSUPPORTED_FORMAT" });
      assertDiagnosticEvent(result.diagnostic, { method: PORTABILITY_REPLACE, status: "error", errorCode: "PORTABILITY_UNSUPPORTED_FORMAT", detailRef: error.detailRef });
      remember(result, { requestId: "m005-replace-unsupported", method: PORTABILITY_REPLACE, status: "error", errorCode: "PORTABILITY_UNSUPPORTED_FORMAT", detailRef: error.detailRef });
      const after = cookieDbSummary({ storeRoot, profileId, expectedValues: [replacementValue, secondCookieValue] }, context.redactionContext);
      assert(after.count === before.count && after.hasExpectedValues, "Unsupported import format mutated existing cookies.", { phase: "unsupported-format" });
      sidecar.unsupportedFormatRejected = true;
      return { errorCode: error.errorCode, rowsPreserved: true };
    }, context.redactionContext);

    runStep("sidecar.busy-profile-rejected", () => {
      writeBusyRuntimeRecord(storeRoot, profileId);
      const result = runSourceSidecarRequest({
        id: "m005-export-busy",
        method: PORTABILITY_EXPORT,
        params: { storeRoot, profileId, destinationPath: busyExportPath, format: FORMAT_THEPRIVATOR_JSON },
      }, { context: context.redactionContext });
      const error = assertPortabilityError(result.response, { requestId: "m005-export-busy", code: "PORTABILITY_PROFILE_BUSY" });
      assertDiagnosticEvent(result.diagnostic, { method: PORTABILITY_EXPORT, status: "error", errorCode: "PORTABILITY_PROFILE_BUSY", detailRef: error.detailRef });
      remember(result, { requestId: "m005-export-busy", method: PORTABILITY_EXPORT, status: "error", errorCode: "PORTABILITY_PROFILE_BUSY", detailRef: error.detailRef });
      assert(!existsSync(busyExportPath), "Busy export wrote a destination file.", { phase: "busy-guard" });
      clearBusyRuntimeRecord(storeRoot);
      sidecar.busyRejected = true;
      return { errorCode: error.errorCode, destinationUntouched: true };
    }, context.redactionContext);

    runStep("diagnostics.redaction", () => {
      const entries = readDiagnostics(storeRoot, context.redactionContext);
      const result = assertPersistedDiagnostics(entries, expectedDiagnostics);
      assertNoPublicLeak(portabilityPublicEvidence, context.redactionContext, "Portability public responses and diagnostics");
      assertNoPublicLeak(entries, context.redactionContext, "Persisted diagnostics");
      sidecar.diagnosticsRedacted = true;
      return result;
    }, context.redactionContext);

    runStep("verifier.redaction", () => {
      assertM005PublicEvidenceRedacted(VERIFIER_EVENTS, context.redactionContext);
      return { emittedEvents: VERIFIER_EVENTS.length };
    }, context.redactionContext);

    const cleanup = recordCleanupStep(storeRoot, { keepTemp, context: context.redactionContext });
    sidecar.cleanup = cleanup;
    if (cleanup.status === "failed") {
      fail("M005/S01 temporary cookie fixture cleanup failed.", {
        phase: "cleanup",
        cleanupStatus: cleanup.status,
        errorCode: cleanup.errorCode,
      });
    }

    const summary = buildM005FinalSummary({ status: "pass", checks: STEP_RESULTS.slice(sidecarStepStart), sidecar });
    if (emitFinal) emit({ status: "pass", summary }, context.redactionContext);
    return summary;
  } finally {
    if (!sidecar.cleanup) {
      sidecar.cleanup = recordCleanupStep(storeRoot, { keepTemp, context: context.redactionContext });
    }
  }
}

export function runFullVerification({ rootDir = ROOT_DIR } = {}) {
  resetM005VerificationState();
  const context = createM005RedactionContext({ rootDir });
  const commands = {};

  runM005CommandStep(
    "node.focused-vitest",
    "npm",
    ["test", "--", "--run", ...M005_FOCUSED_VITEST_FILES],
    120_000,
    { rootDir, context },
  );
  commands.focusedVitest = "pass";

  runM005CommandStep("frontend.typecheck-build", "npm", ["run", "build"], 120_000, { rootDir, context });
  commands.typescriptBuild = "pass";

  runM005CommandStep("sidecar.build", "npm", ["run", "sidecar:build"], 300_000, { rootDir, context });
  commands.sidecarBuild = "pass";

  runM005CommandStep(
    "rust.cookie-command-tests",
    "cargo",
    ["test", "--manifest-path", "src-tauri/Cargo.toml", "profile_cookies"],
    180_000,
    { rootDir, context },
  );
  commands.rustCommandTests = "pass";

  const capability = runCapabilityOnlyVerification({ rootDir, resetState: false, emitFinal: false }).capability;
  const sourceGuardrails = runStep("source.cookie-guardrails", () => assertM005SourceGuardrails({ rootDir }), context);
  const docs = runStep("docs.readme-proof-boundary", () => assertM005ReadmeDocs({ rootDir }), context);
  const sidecarSummary = runSidecarOnlySmoke({ rootDir, resetState: false, emitFinal: false });
  const summary = buildM005FullSummary({
    status: "pass",
    checks: STEP_RESULTS,
    commands,
    capability,
    sourceGuardrails,
    docs,
    sidecar: sidecarSummary.sidecar,
  });
  assertM005PublicEvidenceRedacted(summary, context);
  emit({ status: "pass", summary }, context);
  return summary;
}

function printHelp() {
  console.log(`Usage: npm run verify:m005:s01 -- [--sidecar-only] [--capability-only]\n\nDefault            Run the full M005/S01 source-level proof.\n--sidecar-only      Run only the source-sidecar cookie portability smoke fixture.\n--capability-only   Verify only the Tauri dialog/fixed-command permission boundary.\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.capabilityOnly) {
    runCapabilityOnlyVerification();
    return 0;
  }
  if (args.sidecarOnly) {
    runSidecarOnlySmoke();
    return 0;
  }
  runFullVerification();
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const details = error?.details ? redactM005(error.details) : undefined;
    const failure = redactM005({
      event: VERIFY_EVENT,
      status: "fail",
      message,
      ...(details ? { details } : {}),
      checks: STEP_RESULTS.map((check) => ({ name: check.name, status: check.status, durationMs: check.durationMs })),
    });
    console.log(JSON.stringify(failure));
    process.exit(1);
  });
}
