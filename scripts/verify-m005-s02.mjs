#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { ROOT_DIR, VerifyFailure, executable } from "./verify-m004-s01.mjs";
import { readGuardedUiSources } from "./ui-sources.mjs";

export const VERIFY_EVENT = "verify.m005.s02";
export const PROFILE_PACKAGE_EXPORT = "portability.profile_package.export";
export const PROFILE_PACKAGE_IMPORT = "portability.profile_package.import";
export const PACKAGE_FORMAT = "theprivator.profile-package";
export const PACKAGE_VERSION = 1;
export const MANIFEST_MEMBER = "manifest.json";
export const COOKIE_MEMBER = "cookies/theprivator-cookies.json";
export const PAYLOAD_PREFIX = "payload/";
export const DIAGNOSTIC_RELATIVE_LOG_PATH = "profile-store/diagnostics/events.jsonl";

const PYTHON = process.env.PYTHON ?? "python3";
const SIDECAR_EXTERNAL_BIN = "binaries/theprivator-sidecar";
const REDACTED_VALUE = "<redacted>";
const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];

const FOCUSED_VITEST_FILES = Object.freeze([
  "scripts/verify-m005-s02.test.mjs",
  "src/sidecar/client.test.ts",
  "src/App.test.tsx",
]);

const SOURCE_GUARD_FILES = Object.freeze([
  "scripts/verify-m005-s02.mjs",
  "scripts/verify-m005-s02.test.mjs",
  "src/App.tsx",
  "src/App.test.tsx",
  "src/sidecar/client.ts",
  "src/sidecar/client.test.ts",
  "src/sidecar/types.ts",
  "src-tauri/capabilities/default.json",
  "src-tauri/src/lib.rs",
  "src-tauri/src/sidecar.rs",
]);

const SAFE_DIAGNOSTIC_KEYS = new Set(["event", "requestId", "method", "status", "durationMs", "errorCode", "detailRef"]);
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

const PUBLIC_SENSITIVE_KEY_PATTERN = /(?:destinationPath|sourcePath|selectedPath|storeRoot|appDataRoot|profileRoot|profileDir|userDataDir|absolutePath|pathList|memberNames?|archiveMembers?|manifestJson|rawManifest|cookieDomain|cookieDomains|cookieName|cookieNames|cookieValue|cookieValues|cookies$|stdout|stderr|rawDiagnostics?|rawPayload|stack|traceback|argv|args|env|token|authorization|\bcredentials?\b|password|secret|debug|cdp|devtools|endpoint|launchArgs?)/i;
const PACKAGE_FORBIDDEN_KEY_PATTERN = /(?:destinationPath|sourcePath|selectedPath|storeRoot|appDataRoot|profileRoot|profileDir|userDataDir|absolutePath|cookieDomain|cookieDomains|cookieName|cookieNames|cookieValue|cookieValues|stdout|stderr|rawDiagnostics?|rawPayload|stack|traceback|argv|args|env|token|authorization|\bcredentials?\b|username|password|secret|debug|cdp|devtools|endpoint|launchArgs?)/i;

const PUBLIC_STATIC_FORBIDDEN_PATTERNS = Object.freeze([
  { markerClass: "raw_diag", pattern: /\b(?:stdout|stderr|raw diagnostics?|rawDiagnostics?|rawBody|rawPayload|Traceback|traceback|stack trace)\b/i },
  { markerClass: "debug_endpoint", pattern: /\b(?:DevToolsActivePort|debugPort|devtoolsPort|remoteDebuggingPort|remote-debugging|--remote-debugging-port|cdp:\/\/|wss?:\/\/[^\s"']+|cdpEndpoint|cdpPort)\b/i },
  { markerClass: "credential", pattern: /\b(?:Authorization|Bearer|Proxy-Authorization|username|password|secret|token)\b/i },
  { markerClass: "launch_args", pattern: /\b(?:THEPRIVATOR_CHROMIUM_PATH|--user-data-dir|--proxy-server|--load-extension|argv|args|env)\b/i },
  { markerClass: "package_member", pattern: /\b(?:manifest\.json|cookies\/theprivator-cookies\.json|payload\/Default\/Preferences|payload\/Default\/Local Storage)\b/i },
]);

const PACKAGE_STATIC_FORBIDDEN_PATTERNS = Object.freeze([
  { markerClass: "raw_diag", pattern: /\b(?:stdout|stderr|raw diagnostics?|rawDiagnostics?|rawBody|rawPayload|Traceback|traceback|stack trace)\b/i },
  { markerClass: "debug_endpoint", pattern: /\b(?:DevToolsActivePort|debugPort|devtoolsPort|remoteDebuggingPort|remote-debugging|--remote-debugging-port|cdp:\/\/|wss?:\/\/[^\s"']+|cdpEndpoint|cdpPort)\b/i },
  { markerClass: "credential", pattern: /\b(?:Authorization|Bearer|Proxy-Authorization|username|password|secret|token)\b/i },
  { markerClass: "launch_args", pattern: /\b(?:THEPRIVATOR_CHROMIUM_PATH|--user-data-dir|--proxy-server|--load-extension|argv|args|env)\b/i },
]);

const RUNTIME_MEMBER_PATTERNS = Object.freeze([
  { markerClass: "runtime_singleton", pattern: /(?:^|\/)DevToolsActivePort$/i },
  { markerClass: "runtime_singleton", pattern: /(?:^|\/)Singleton[^/]*$/i },
  { markerClass: "raw_cookie_db", pattern: /(?:^|\/)Default\/(?:Network\/)?Cookies(?:-journal)?$/i },
]);

const IGNORED_ARTIFACT_REFERENCE_PATTERN = /(?:^|["'`\s/(])(?:\.gsd|\.planning|\.audits)(?:[\/"'`\s)]|$)/;
const FRONTEND_FILESYSTEM_AUTHORITY_PATTERN = /@tauri-apps\/plugin-fs|\b(?:readTextFile|writeTextFile|readFile|writeFile)\s*\(/;

function fail(message, details = {}) {
  throw new VerifyFailure(message, details);
}

function assert(condition, message, details = {}) {
  if (!condition) fail(message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addExactMarker(exactValues, markerClass, value) {
  if (typeof value === "string" && value.length > 0) {
    exactValues.push({ markerClass, value, pattern: new RegExp(escapeRegExp(value), "g") });
  }
}

function addExactMarkers(exactValues, markerClass, values = []) {
  for (const value of values) addExactMarker(exactValues, markerClass, value);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set(argv);
  return {
    sidecarOnly: flags.has("--sidecar-only"),
    guardrailsOnly: flags.has("--guardrails-only"),
    help: flags.has("--help") || flags.has("-h"),
  };
}

export function createM005S02PublicScanContext({
  rootDir = ROOT_DIR,
  storeRoot,
  profileRoot,
  userDataRoot,
  selectedPaths = [],
  packageMemberNames = [],
  cookieDomains = [],
  cookieNames = [],
  cookieValues = [],
  proxyCredentials = [],
  extraSensitiveValues = [],
} = {}) {
  const exactValues = [];
  addExactMarker(exactValues, "repo_root", rootDir);
  addExactMarker(exactValues, "app_root", storeRoot);
  addExactMarker(exactValues, "profile_root", profileRoot);
  addExactMarker(exactValues, "user_data_root", userDataRoot);
  addExactMarkers(exactValues, "selected_path", selectedPaths);
  addExactMarkers(exactValues, "package_member", packageMemberNames);
  addExactMarkers(exactValues, "cookie_domain", cookieDomains);
  addExactMarkers(exactValues, "cookie_name", cookieNames);
  addExactMarkers(exactValues, "cookie_value", cookieValues);
  addExactMarkers(exactValues, "credential", proxyCredentials);
  addExactMarkers(exactValues, "extra_value", extraSensitiveValues);
  return { exactValues: exactValues.sort((left, right) => right.value.length - left.value.length), forbiddenPatterns: PUBLIC_STATIC_FORBIDDEN_PATTERNS };
}

export function createM005S02PackageScanContext({ rootDir = ROOT_DIR, storeRoot, selectedPaths = [], cookieDomains = [], cookieNames = [], cookieValues = [], proxyCredentials = [], extraSensitiveValues = [] } = {}) {
  const exactValues = [];
  addExactMarker(exactValues, "repo_root", rootDir);
  addExactMarker(exactValues, "app_root", storeRoot);
  addExactMarkers(exactValues, "selected_path", selectedPaths);
  addExactMarkers(exactValues, "cookie_domain", cookieDomains);
  addExactMarkers(exactValues, "cookie_name", cookieNames);
  addExactMarkers(exactValues, "cookie_value", cookieValues);
  addExactMarkers(exactValues, "credential", proxyCredentials);
  addExactMarkers(exactValues, "extra_value", extraSensitiveValues);
  return { exactValues: exactValues.sort((left, right) => right.value.length - left.value.length), forbiddenPatterns: PACKAGE_STATIC_FORBIDDEN_PATTERNS, cookieMember: COOKIE_MEMBER };
}

function classifyPublicKey(key) {
  if (/destinationPath|sourcePath|selectedPath|paths?|root|dir/i.test(key)) return "path";
  if (/member|manifest/i.test(key)) return "package_member";
  if (/cookieDomain|domains?/i.test(key)) return "cookie_domain";
  if (/cookieName/i.test(key)) return "cookie_name";
  if (/cookieValue|values?/i.test(key)) return "cookie_value";
  if (/cookies$/i.test(key)) return "cookie_payload";
  if (/stdout|stderr|raw|stack|traceback/i.test(key)) return "raw_diag";
  if (/debug|cdp|devtools|endpoint/i.test(key)) return "debug_endpoint";
  if (/token|authorization|credentials?|password|secret/i.test(key)) return "credential";
  if (/argv|args|env/i.test(key)) return "launch_args";
  return "unsafe_field";
}

function classifyPackageKey(key) {
  if (/destinationPath|sourcePath|selectedPath|paths?|root|dir/i.test(key)) return "path";
  if (/cookieDomain|domains?/i.test(key)) return "cookie_domain";
  if (/cookieName/i.test(key)) return "cookie_name";
  if (/cookieValue|values?/i.test(key)) return "cookie_value";
  if (/stdout|stderr|raw|stack|traceback/i.test(key)) return "raw_diag";
  if (/debug|cdp|devtools|endpoint/i.test(key)) return "debug_endpoint";
  if (/token|authorization|credentials|username|password|secret/i.test(key)) return "credential";
  if (/argv|args|env/i.test(key)) return "launch_args";
  return "unsafe_manifest_key";
}

function redactedKeyName(key, classifier = classifyPublicKey) {
  return `<redacted-key:${classifier(key)}>`;
}

function isRedactedPlaceholderKey(key) {
  return /^<redacted-key:[a-z_]+>$/.test(key);
}

export function redactM005S02Text(value, context = createM005S02PublicScanContext()) {
  let redacted = String(value ?? "");
  for (const marker of context.exactValues ?? []) redacted = redacted.replace(marker.pattern, `<redacted:${marker.markerClass}>`);
  return redacted
    .replace(/Traceback|traceback|stack trace/gi, "<redacted:raw_diag>")
    .replace(/stdout|stderr|raw diagnostics?|rawDiagnostics?|rawBody|rawPayload/gi, "<redacted:raw_diag>")
    .replace(/DevToolsActivePort|debugPort|--remote-debugging-port(?:=|\s+)\d*|remote-debugging|cdp:\/\/|wss?:\/\/[^\s"']+|cdpEndpoint|devtoolsPort/gi, "<redacted:debug_endpoint>")
    .replace(/Authorization|Bearer|Proxy-Authorization|username|password|secret|token/gi, "<redacted:private>")
    .replace(/THEPRIVATOR_CHROMIUM_PATH|--user-data-dir|--proxy-server|--load-extension|argv|args|env/gi, "<redacted:launch_args>");
}

export function redactedM005S02Tail(value, context = createM005S02PublicScanContext(), maxLength = 1_200) {
  const text = redactM005S02Text(value ?? "", context);
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

export function redactM005S02(value, context = createM005S02PublicScanContext()) {
  if (typeof value === "string") return redactM005S02Text(value, context);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactM005S02(item, context));
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (PUBLIC_SENSITIVE_KEY_PATTERN.test(key)) result[redactedKeyName(key)] = REDACTED_VALUE;
    else result[redactM005S02Text(key, context)] = redactM005S02(nested, context);
  }
  return result;
}

function safePublicFieldPath(path, keyOrIndex) {
  if (typeof keyOrIndex === "number") return `${path}[${keyOrIndex}]`;
  const segment = PUBLIC_SENSITIVE_KEY_PATTERN.test(keyOrIndex) ? redactedKeyName(keyOrIndex) : keyOrIndex;
  return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
}

function safePackageFieldPath(path, keyOrIndex) {
  if (typeof keyOrIndex === "number") return `${path}[${keyOrIndex}]`;
  const segment = PACKAGE_FORBIDDEN_KEY_PATTERN.test(keyOrIndex) ? redactedKeyName(keyOrIndex, classifyPackageKey) : keyOrIndex;
  return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
}

export function findM005S02ForbiddenPublicMarker(value, context = createM005S02PublicScanContext(), path = "$", state = { count: 0 }) {
  if (state.count++ > 8_000) return { markerClass: "scan_limit", fieldPath: path, reason: "bounded scan limit exceeded" };
  if (typeof value === "string") {
    for (const marker of context.exactValues ?? []) if (marker.value && value.includes(marker.value)) return { markerClass: marker.markerClass, fieldPath: path, reason: "sensitive exact value" };
    for (const { markerClass, pattern } of context.forbiddenPatterns ?? []) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) return { markerClass, fieldPath: path, reason: "forbidden text marker" };
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findM005S02ForbiddenPublicMarker(item, context, safePublicFieldPath(path, index), state);
      if (nested) return nested;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    const isAllowedDiagnosticLookup = key === "logPath" && nested === DIAGNOSTIC_RELATIVE_LOG_PATH;
    if (!isAllowedDiagnosticLookup && !isRedactedPlaceholderKey(key) && PUBLIC_SENSITIVE_KEY_PATTERN.test(key)) {
      return { markerClass: classifyPublicKey(key), fieldPath: safePublicFieldPath(path, key), reason: "forbidden key" };
    }
    const marker = findM005S02ForbiddenPublicMarker(nested, context, safePublicFieldPath(path, key), state);
    if (marker) return marker;
  }
  return null;
}

export function assertM005S02PublicEvidenceRedacted(value, context = createM005S02PublicScanContext()) {
  const marker = findM005S02ForbiddenPublicMarker(value, context);
  assert(!marker, "M005/S02 public evidence contained a forbidden marker.", marker ?? {});
  return { status: "clean", scanned: true };
}

function findForbiddenPackageText(text, context, memberName, path) {
  const allowCookieMaterial = memberName === (context.cookieMember ?? COOKIE_MEMBER);
  for (const marker of context.exactValues ?? []) {
    if (allowCookieMaterial && ["cookie_domain", "cookie_name", "cookie_value"].includes(marker.markerClass)) continue;
    if (marker.value && String(text).includes(marker.value)) return { markerClass: marker.markerClass, memberName, fieldPath: path, reason: "forbidden exact package value" };
  }
  for (const { markerClass, pattern } of context.forbiddenPatterns ?? []) {
    pattern.lastIndex = 0;
    if (pattern.test(String(text))) return { markerClass, memberName, fieldPath: path, reason: "forbidden package text marker" };
  }
  return null;
}

export function findM005S02ForbiddenPackageMarker(value, context = createM005S02PackageScanContext(), memberName = "package", path = "$", state = { count: 0 }) {
  if (state.count++ > 12_000) return { markerClass: "scan_limit", memberName, fieldPath: path, reason: "bounded package scan limit exceeded" };
  if (typeof value === "string") return findForbiddenPackageText(value, context, memberName, path);
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findM005S02ForbiddenPackageMarker(item, context, memberName, safePackageFieldPath(path, index), state);
      if (nested) return nested;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (!isRedactedPlaceholderKey(key) && PACKAGE_FORBIDDEN_KEY_PATTERN.test(key)) return { markerClass: classifyPackageKey(key), memberName, fieldPath: safePackageFieldPath(path, key), reason: "unsafe package manifest key" };
    const keyMarker = findForbiddenPackageText(key, context, memberName, safePackageFieldPath(path, key));
    if (keyMarker) return keyMarker;
    const nestedMarker = findM005S02ForbiddenPackageMarker(nested, context, memberName, safePackageFieldPath(path, key), state);
    if (nestedMarker) return nestedMarker;
  }
  return null;
}

export function findM005S02ForbiddenPackageMember(memberName, text, context = createM005S02PackageScanContext()) {
  for (const { markerClass, pattern } of RUNTIME_MEMBER_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(memberName)) return { markerClass, memberName, fieldPath: "$member", reason: "forbidden package member name" };
  }
  return findM005S02ForbiddenPackageMarker(text, context, memberName);
}

export function assertM005S02PackageContentClean(inspection, context = createM005S02PackageScanContext()) {
  assert(isPlainObject(inspection), "Package inspection must be an object.", { phase: "package-scan" });
  const members = Array.isArray(inspection.members) ? inspection.members : [];
  for (const member of members) {
    const name = member?.name;
    assert(typeof name === "string" && name.length > 0, "Package member summary was malformed.", { phase: "package-scan" });
    const marker = findM005S02ForbiddenPackageMember(name, member?.text ?? "", context);
    assert(!marker, "Profile package content contained a forbidden marker.", marker ?? {});
  }
  const manifestMarker = findM005S02ForbiddenPackageMarker(inspection.manifest, context, MANIFEST_MEMBER);
  assert(!manifestMarker, "Profile package manifest contained a forbidden marker.", manifestMarker ?? {});
  return { status: "clean", scannedMembers: members.length };
}

function assertExactKeys(value, expectedKeys, label) {
  const expected = [...expectedKeys].sort();
  const actual = Object.keys(value ?? {}).sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} keys did not match the expected package contract.`, { phase: "manifest-summary", expectedKeys: expected, actualKeys: actual.map((key) => (PACKAGE_FORBIDDEN_KEY_PATTERN.test(key) ? redactedKeyName(key, classifyPackageKey) : key)) });
}

export function assertM005S02PackageManifestSummary(manifest, { expectedProfileName } = {}) {
  assert(isPlainObject(manifest), "Profile package manifest was not an object.", { phase: "manifest-summary" });
  assertExactKeys(manifest, ["cookies", "createdAt", "format", "payload", "profile", "version", "warnings"], "manifest");
  assert(manifest.format === PACKAGE_FORMAT, "Profile package manifest format mismatch.", { phase: "manifest-summary" });
  assert(manifest.version === PACKAGE_VERSION, "Profile package manifest version mismatch.", { phase: "manifest-summary" });
  assert(isPlainObject(manifest.profile), "Profile package manifest profile was malformed.", { phase: "manifest-summary" });
  assertExactKeys(manifest.profile, ["identity", "name", "proxy", "proxySummary"], "manifest.profile");
  if (expectedProfileName !== undefined) assert(manifest.profile.name === expectedProfileName, "Profile package manifest profile name mismatch.", { phase: "manifest-summary" });
  assert(!("credentials" in (manifest.profile.proxy ?? {})), "Profile package manifest proxy retained credentials.", { phase: "manifest-summary" });
  assert(!("username" in (manifest.profile.proxy ?? {})) && !("password" in (manifest.profile.proxy ?? {})), "Profile package manifest proxy exposed credential fields.", { phase: "manifest-summary" });
  assert(manifest.profile.proxy?.mode === "fixedServer", "Profile package manifest proxy mode mismatch.", { phase: "manifest-summary" });
  assert(manifest.profile.proxySummary?.credentialState === "none", "Profile package proxy summary did not reflect stripped credentials.", { phase: "manifest-summary" });
  assert(isPlainObject(manifest.profile.identity) && manifest.profile.identity.identityVersion === 1, "Profile package manifest identity was not normalized.", { phase: "manifest-summary" });
  assert(isPlainObject(manifest.cookies), "Profile package manifest cookie metadata was malformed.", { phase: "manifest-summary" });
  assertExactKeys(manifest.cookies, ["byteCount", "cookieCount", "format", "member", "sha256", "skippedCount", "version"], "manifest.cookies");
  assert(manifest.cookies.member === COOKIE_MEMBER, "Profile package cookie member mismatch.", { phase: "manifest-summary" });
  assert(manifest.cookies.cookieCount >= 1, "Profile package did not report portable cookies.", { phase: "manifest-summary" });
  assert(isPlainObject(manifest.payload), "Profile package manifest payload metadata was malformed.", { phase: "manifest-summary" });
  assertExactKeys(manifest.payload, ["byteCount", "fileCount", "files", "prefix"], "manifest.payload");
  assert(manifest.payload.prefix === PAYLOAD_PREFIX, "Profile package payload prefix mismatch.", { phase: "manifest-summary" });
  assert(Array.isArray(manifest.payload.files), "Profile package payload file list was malformed.", { phase: "manifest-summary" });
  assert(manifest.payload.fileCount === manifest.payload.files.length, "Profile package payload file count mismatch.", { phase: "manifest-summary" });
  assert(Array.isArray(manifest.warnings), "Profile package warning list was malformed.", { phase: "manifest-summary" });
  return { format: manifest.format, version: manifest.version, profileNamePresent: typeof manifest.profile.name === "string" && manifest.profile.name.length > 0, proxyCredentialStripped: true, cookieCount: manifest.cookies.cookieCount, payloadFileCount: manifest.payload.fileCount, warningCount: manifest.warnings.length };
}

function commandName(command, args) {
  return [command, ...args].join(" ");
}

export function formatM005S02CommandFailure(label, result, context = createM005S02PublicScanContext()) {
  const combinedOutput = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  return redactM005S02({ phase: "subprocess", command: label, exitCode: typeof result?.status === "number" ? result.status : null, signal: result?.signal ?? null, errorCode: result?.error?.code ?? null, timedOut: result?.error?.code === "ETIMEDOUT", redactedTail: redactedM005S02Tail(combinedOutput, context), guidance: result?.error?.code === "ETIMEDOUT" ? "The child process was terminated after the bounded M005/S02 verifier timeout." : "Inspect the named focused command locally; public verifier output includes only a redacted tail." }, context);
}

function emit(event, context = createM005S02PublicScanContext()) {
  const safeEvent = redactM005S02({ event: VERIFY_EVENT, ...event }, context);
  VERIFIER_EVENTS.push(safeEvent);
  console.log(JSON.stringify(safeEvent));
  return safeEvent;
}

function resetState() {
  STEP_RESULTS.length = 0;
  VERIFIER_EVENTS.length = 0;
}

function unpackStepResult(result) {
  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "value")) return { publicResult: result.log ?? {}, returnValue: result.value };
  return { publicResult: result ?? {}, returnValue: result ?? {} };
}

function runStep(name, action, context = createM005S02PublicScanContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(action());
    const durationMs = Math.round(performance.now() - started);
    STEP_RESULTS.push({ name, status: "pass", durationMs });
    emit({ phase: name, status: "pass", durationMs, ...publicResult }, context);
    return returnValue;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    const details = error?.details ? redactM005S02(error.details, context) : undefined;
    STEP_RESULTS.push({ name, status: "fail", durationMs, message });
    emit({ phase: name, status: "fail", durationMs, message, ...(details ? { details } : {}) }, context);
    throw error;
  }
}

function runCommandStep(name, command, args, timeoutMs, { rootDir = ROOT_DIR, context = createM005S02PublicScanContext({ rootDir }) } = {}) {
  return runStep(name, () => {
    const label = commandName(command, args);
    const result = spawnSync(executable(command), args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 24 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      const failure = formatM005S02CommandFailure(label, result, context);
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
    fail(`${label} was not valid JSON.`, { phase: "sidecar-io", lineLength: String(line ?? "").length, outputTail: redactM005S02Text(line, context).slice(-500), parserMessage: error instanceof Error ? error.message : String(error) });
  }
}

function parseNdjson(value, expectedLines, label, context) {
  const lines = String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (expectedLines !== null) assert(lines.length === expectedLines, `${label} emitted an unexpected number of NDJSON lines.`, { phase: "sidecar-io", label, expectedLines, actualLines: lines.length, outputTail: redactM005S02Text(value, context).slice(-500) });
  else assert(lines.length >= 1, `${label} emitted no NDJSON lines.`, { phase: "sidecar-io", label });
  return lines.map((line, index) => parseJsonLine(line, `${label} line ${index + 1}`, context));
}

function runSourceSidecarRequest(payload, { rootDir = ROOT_DIR, python = PYTHON, context = createM005S02PublicScanContext(), env = {}, timeoutMs = 20_000 } = {}) {
  const result = spawnSync(executable(python), ["-m", "theprivator_sidecar"], { cwd: rootDir, input: `${JSON.stringify(payload)}\n`, env: { ...process.env, ...env, PYTHONUNBUFFERED: "1" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) fail("Source sidecar request failed to execute.", { phase: "sidecar-process", method: payload?.method, errorCode: result.error.code ?? "SPAWN_ERROR", outputTail: redactedM005S02Tail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, context) });
  if (result.status !== 0) fail("Source sidecar request exited unsuccessfully.", { phase: "sidecar-process", method: payload?.method, exitCode: result.status, signal: result.signal, outputTail: redactedM005S02Tail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, context) });
  const [response] = parseNdjson(result.stdout, 1, "sidecar response stream", context);
  const diagnostics = parseNdjson(result.stderr, null, "sidecar diagnostic stream", context);
  const diagnostic = diagnostics[0];
  return { response, diagnostic, diagnostics };
}

function makeRequestId(label) {
  return `verify-m005-s02-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "request"}`;
}

function assertDiagnosticEvent(diagnostic, expected) {
  assert(isPlainObject(diagnostic), "Sidecar diagnostic was not an object.", { phase: "diagnostic-shape" });
  for (const key of Object.keys(diagnostic)) assert(SAFE_DIAGNOSTIC_KEYS.has(key), "Sidecar diagnostic included an unsafe field.", { phase: "diagnostic-shape", field: key });
  assert(diagnostic.event === "sidecar.request", "Sidecar diagnostic used the wrong event name.", { phase: "diagnostic-shape" });
  assert(diagnostic.method === expected.method, "Sidecar diagnostic method mismatch.", { phase: "diagnostic-shape", expectedMethod: expected.method, actualMethod: diagnostic.method });
  assert(diagnostic.status === expected.status, "Sidecar diagnostic status mismatch.", { phase: "diagnostic-shape", expectedStatus: expected.status, actualStatus: diagnostic.status });
  assert(diagnostic.errorCode === expected.errorCode, "Sidecar diagnostic errorCode mismatch.", { phase: "diagnostic-shape", expectedCode: expected.errorCode, actualCode: diagnostic.errorCode });
  if (expected.detailRef !== undefined) assert(diagnostic.detailRef === expected.detailRef, "Sidecar diagnostic detailRef mismatch.", { phase: "diagnostic-shape" });
  assert(typeof diagnostic.durationMs === "number" && diagnostic.durationMs >= 0, "Sidecar diagnostic duration was invalid.", { phase: "diagnostic-shape" });
  return { method: diagnostic.method, status: diagnostic.status, errorCode: diagnostic.errorCode, detailRef: diagnostic.detailRef ?? null };
}

function sidecarSuccess(id, method, params, { context, env = {}, timeoutMs } = {}) {
  const result = runSourceSidecarRequest({ id, method, params }, { context, env, timeoutMs });
  assert(result.response.id === id, "Sidecar response did not echo the request id.", { phase: "sidecar-contract", method });
  assert(result.response.ok === true, `Expected ${method} to succeed.`, { phase: "sidecar-contract", method, errorCode: result.response.error?.code, detailRef: result.response.error?.detailRef });
  assertDiagnosticEvent(result.diagnostic, { method, status: "ok", errorCode: null, detailRef: null });
  assert(isPlainObject(result.response.result), "Sidecar success result was not an object.", { phase: "sidecar-contract", method });
  return { ...result, result: result.response.result };
}

function readJsonFile(path, label, { rootDir = ROOT_DIR } = {}) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} must be valid JSON.`, { phase: "json-read", file: relative(rootDir, path), parserMessage: error instanceof Error ? error.message : String(error) });
  }
}

function permissionIdentifier(permission) {
  return typeof permission === "string" ? permission : permission?.identifier;
}

function assertNoForbiddenCapability(permission) {
  const identifier = permissionIdentifier(permission);
  assert(typeof identifier === "string" && identifier.length > 0, "Default capability contained an invalid permission entry.", { phase: "capability" });
  assert(!identifier.startsWith("fs:"), "Default capability must not grant frontend filesystem authority.", { phase: "capability", identifier });
  assert(identifier !== "shell:allow-open" && identifier !== "opener:allow-open" && identifier !== "opener:default", "Default capability must not grant shell/open authority.", { phase: "capability", identifier });
  assert(identifier !== "dialog:default", "Default capability must not grant broad dialog defaults.", { phase: "capability", identifier });
}

export function assertM005S02CapabilityConfig({ rootDir = ROOT_DIR } = {}) {
  const capability = readJsonFile(join(rootDir, "src-tauri", "capabilities", "default.json"), "src-tauri/capabilities/default.json", { rootDir });
  assert(Array.isArray(capability.permissions), "Default capability permissions must be an array.", { phase: "capability" });
  const permissionIds = [];
  for (const permission of capability.permissions) {
    assertNoForbiddenCapability(permission);
    const identifier = permissionIdentifier(permission);
    if (identifier === "shell:allow-spawn") {
      const allow = permission?.allow;
      const allowedSidecars = Array.isArray(allow) ? allow.filter((entry) => entry?.name === SIDECAR_EXTERNAL_BIN && entry?.sidecar === true) : [];
      assert(Array.isArray(allow) && allow.length === 1 && allowedSidecars.length === 1, "shell:allow-spawn must allow only the packaged sidecar.", { phase: "capability", identifier });
    }
    permissionIds.push(identifier);
  }
  const sortedIds = [...permissionIds].sort();
  assert(JSON.stringify(sortedIds) === JSON.stringify(["core:default", "dialog:allow-open", "dialog:allow-save", "shell:allow-spawn"].sort()), "Default capability must contain only core, dialog open/save, and fixed sidecar spawn permissions.", { phase: "capability", permissions: sortedIds });

  const packageJson = readJsonFile(join(rootDir, "package.json"), "package.json", { rootDir });
  assert(typeof packageJson.dependencies?.["@tauri-apps/plugin-dialog"] === "string", "package.json must depend on @tauri-apps/plugin-dialog for native file dialogs.", { phase: "capability" });
  assert(!packageJson.dependencies?.["@tauri-apps/plugin-fs"] && !packageJson.devDependencies?.["@tauri-apps/plugin-fs"], "package.json must not add the Tauri filesystem plugin.", { phase: "capability" });
  assert(typeof packageJson.scripts?.["verify:m005:s02"] === "string", "package.json must expose verify:m005:s02 as the canonical S02 command.", { phase: "capability" });

  const packageLock = readJsonFile(join(rootDir, "package-lock.json"), "package-lock.json", { rootDir });
  assert(typeof packageLock.packages?.[""]?.dependencies?.["@tauri-apps/plugin-dialog"] === "string", "package-lock root package must include @tauri-apps/plugin-dialog.", { phase: "capability" });
  assert(packageLock.packages?.["node_modules/@tauri-apps/plugin-dialog"], "package-lock must pin @tauri-apps/plugin-dialog.", { phase: "capability" });
  assert(!packageLock.packages?.[""]?.dependencies?.["@tauri-apps/plugin-fs"] && !packageLock.packages?.["node_modules/@tauri-apps/plugin-fs"], "package-lock must not include @tauri-apps/plugin-fs.", { phase: "capability" });

  const cargoToml = readFileSync(join(rootDir, "src-tauri", "Cargo.toml"), "utf8");
  const cargoLock = readFileSync(join(rootDir, "src-tauri", "Cargo.lock"), "utf8");
  assert(/^tauri-plugin-dialog\s*=\s*/m.test(cargoToml), "Cargo.toml must depend on tauri-plugin-dialog.", { phase: "capability" });
  assert(!/^tauri-plugin-fs\s*=\s*/m.test(cargoToml), "Cargo.toml must not depend on tauri-plugin-fs.", { phase: "capability" });
  assert(/\nname = "tauri-plugin-dialog"\n/.test(cargoLock), "Cargo.lock must pin tauri-plugin-dialog.", { phase: "capability" });

  const libRs = readFileSync(join(rootDir, "src-tauri", "src", "lib.rs"), "utf8");
  assert(libRs.includes(".plugin(tauri_plugin_dialog::init())"), "Tauri builder must register the dialog plugin.", { phase: "capability" });
  assert(libRs.includes("sidecar::profile_package_export") && libRs.includes("sidecar::profile_package_import"), "Tauri invoke handler must register fixed profile package commands.", { phase: "capability" });

  const sidecarRs = readFileSync(join(rootDir, "src-tauri", "src", "sidecar.rs"), "utf8");
  assert(sidecarRs.includes('"portability.profile_package.export"') && sidecarRs.includes('"portability.profile_package.import"'), "Rust bridge must expose fixed profile package method wrappers.", { phase: "capability" });
  return { permissions: sortedIds, dialogPlugin: "registered", filesystemAuthority: "absent", shellOpenAuthority: "absent", packageCommands: "registered" };
}

function assertFileExists(rootDir, relativePath) {
  const absolutePath = join(rootDir, relativePath);
  assert(existsSync(absolutePath), "M005/S02 verifier source scan expected a tracked file to exist.", { phase: "source-guardrail", file: relativePath });
  return absolutePath;
}

export function assertM005S02SourceGuardrails({ rootDir = ROOT_DIR } = {}) {
  const scannedFiles = [];
  for (const relativePath of SOURCE_GUARD_FILES) {
    const absolutePath = assertFileExists(rootDir, relativePath);
    const source = readFileSync(absolutePath, "utf8");
    scannedFiles.push(relativePath);
    assert(!IGNORED_ARTIFACT_REFERENCE_PATTERN.test(source), "M005/S02 verifier and tests must not import ignored planning artifacts.", { phase: "source-guardrail", file: relativePath, markerClass: "ignored_artifact_reference" });
  }
  // Applied per UI file rather than to src/App.tsx alone, so the rule still holds
  // once the UI is split into components. See scripts/ui-sources.mjs.
  for (const file of readGuardedUiSources(rootDir).files) {
    assert(!FRONTEND_FILESYSTEM_AUTHORITY_PATTERN.test(file.text), "Profile package UI must not gain frontend filesystem authority.", { phase: "source-guardrail", file: file.path, markerClass: "frontend_filesystem_authority" });
    assert(!file.text.includes('"profile_package_export"') && !file.text.includes('"profile_package_import"'), "Profile package UI must call typed client wrappers instead of raw invoke command names.", { phase: "source-guardrail", file: file.path, markerClass: "raw_package_invoke_in_ui" });
  }
  const clientSource = readFileSync(assertFileExists(rootDir, "src/sidecar/client.ts"), "utf8");
  assert(!clientSource.includes('"portability.profile_package.export"') && !clientSource.includes('"portability.profile_package.import"'), "TypeScript client must not expose raw sidecar profile package method strings.", { phase: "source-guardrail", file: "src/sidecar/client.ts", markerClass: "raw_sidecar_method_in_client" });
  assert(clientSource.includes('invoke<unknown>("profile_package_export"') && clientSource.includes('invoke<unknown>("profile_package_import"'), "TypeScript client must keep fixed profile package Tauri wrappers.", { phase: "source-guardrail", file: "src/sidecar/client.ts", markerClass: "missing_fixed_wrappers" });
  return { scannedFiles: scannedFiles.length, frontendFilesystemAuthority: "absent", ignoredArtifactImports: "absent", uiUsesTypedWrappers: true, clientUsesFixedCommands: true };
}

export function assertM005S02ReadmeDocs({ rootDir = ROOT_DIR } = {}) {
  const readme = readFileSync(assertFileExists(rootDir, "README.md"), "utf8");
  assert(readme.includes("npm run verify:m005:s02"), "README must document the canonical M005/S02 verifier command.", { phase: "docs", markerClass: "missing_command" });
  assert(/M005\s*S02|profile package|\.tpkg/i.test(readme), "README must name the .tpkg profile package source proof.", { phase: "docs", markerClass: "missing_scope" });
  assert(/redaction/i.test(readme) && /package[- ]scan|archive scan|package content/i.test(readme), "README must explain the public redaction vs package-content scan boundary.", { phase: "docs", markerClass: "missing_scan_boundary" });
  assert(/S03/i.test(readme) && /unsafe|rejection|negative/i.test(readme), "README must defer the unsafe package rejection matrix to S03.", { phase: "docs", markerClass: "missing_s03_boundary" });
  assert(/S04/i.test(readme) && /packaged/i.test(readme) && /dialog/i.test(readme), "README must defer packaged real-dialog proof to S04.", { phase: "docs", markerClass: "missing_s04_boundary" });
  return { command: "documented", sourcePackageProof: "documented", redactionBoundary: "documented", unsafePackageMatrix: "deferred-to-s03", packagedDialogProof: "deferred-to-s04" };
}

function runPythonFixture(script, input, context, label, { timeoutMs = 10_000 } = {}) {
  const result = spawnSync(executable(PYTHON), ["-c", script], { cwd: ROOT_DIR, input: JSON.stringify(input), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 6 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${label} fixture failed.`, { phase: "fixture", label, exitCode: result.status, errorCode: result.error?.code ?? null, outputTail: redactedM005S02Tail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, context) });
  if (!String(result.stdout ?? "").trim()) return {};
  return parseJsonLine(result.stdout.trim(), `${label} fixture output`, context);
}

function createCookieDbFixture({ storeRoot, profileId, cookieDomain, cookieName, cookieValue, secondCookieName, secondCookieValue }, context) {
  const script = String.raw`
import json, sqlite3, sys
from pathlib import Path
from theprivator_sidecar.cookies import _CANONICAL_COOKIE_SCHEMA, unix_time_to_chrome
payload = json.load(sys.stdin)
db_path = Path(payload["storeRoot"]) / "profile-store" / "profiles" / payload["profileId"] / "user-data" / "Default" / "Network" / "Cookies"
db_path.parent.mkdir(parents=True, exist_ok=True)
conn = sqlite3.connect(db_path)
try:
    conn.execute(_CANONICAL_COOKIE_SCHEMA)
    now = unix_time_to_chrome(1_700_000_000)
    expiry = unix_time_to_chrome(1_900_000_000)
    rows = [
        (now, payload["cookieDomain"], "", payload["cookieName"], payload["cookieValue"], b"", "/", expiry, 1, 1, now, 1, 1, 2, 1, 2, 443, 0, now, 0, 0),
        (now, "." + payload["cookieDomain"], "", payload["secondCookieName"], payload["secondCookieValue"], b"", "/session", 0, 0, 0, now, 0, 0, 1, -1, 1, 80, 0, now, 0, 0),
    ]
    conn.executemany("INSERT INTO cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port, is_same_party, last_update_utc, source_type, has_cross_site_ancestor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    conn.commit()
finally:
    conn.close()
print(json.dumps({"count": 2}))
`;
  return runPythonFixture(script, { storeRoot, profileId, cookieDomain, cookieName, cookieValue, secondCookieName, secondCookieValue }, context, "cookie-db-create");
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
print(json.dumps({"count": len(rows), "hasExpectedValues": all(value in values for value in payload.get("expectedValues", []))}))
`;
  return runPythonFixture(script, { storeRoot, profileId, expectedValues }, context, "cookie-db-summary");
}

function inspectPackageArchive(packagePath, context) {
  const script = String.raw`
import hashlib, json, sys, zipfile
payload = json.load(sys.stdin)
with zipfile.ZipFile(payload["packagePath"], "r") as archive:
    members = []
    for info in archive.infolist():
        raw = archive.read(info.filename)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = ""
        members.append({"name": info.filename, "byteCount": info.file_size, "sha256": hashlib.sha256(raw).hexdigest(), "text": text})
    manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
    cookie_payload = json.loads(archive.read("cookies/theprivator-cookies.json").decode("utf-8"))
print(json.dumps({"members": members, "manifest": manifest, "cookiePayload": cookie_payload}))
`;
  return runPythonFixture(script, { packagePath }, context, "package-inspection");
}

function createFakeChromiumExecutable(storeRoot) {
  const scriptPath = join(storeRoot, process.platform === "win32" ? "fake-chromium.cmd" : "fake-chromium");
  if (process.platform === "win32") writeFileSync(scriptPath, "@echo off\r\n:loop\r\nping -n 2 127.0.0.1 > nul\r\ngoto loop\r\n", "utf8");
  else {
    writeFileSync(scriptPath, "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n", "utf8");
    chmodSync(scriptPath, 0o755);
  }
  return { path: scriptPath, created: existsSync(scriptPath) };
}

function readDiagnostics(storeRoot, context) {
  const path = join(storeRoot, DIAGNOSTIC_RELATIVE_LOG_PATH);
  assert(existsSync(path), "Diagnostic log was not written.", { phase: "diagnostics" });
  const lines = readFileSync(path, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => parseJsonLine(line, `diagnostic ${index + 1}`, context));
}

function assertPersistedDiagnostics(entries, expectedRows) {
  for (const [index, entry] of entries.entries()) {
    for (const key of Object.keys(entry)) assert(SAFE_PERSISTED_DIAGNOSTIC_KEYS.has(key), "Persisted diagnostic included an unsafe field.", { phase: "diagnostics", index, field: key });
    assert(entry.event === "sidecar.request", "Persisted diagnostic event mismatch.", { phase: "diagnostics", index });
    assert(entry.logPath === DIAGNOSTIC_RELATIVE_LOG_PATH, "Persisted diagnostic logPath mismatch.", { phase: "diagnostics", index });
  }
  for (const expected of expectedRows) {
    const matches = entries.filter((entry) => entry.requestId === expected.requestId && entry.method === expected.method);
    assert(matches.length === 1, "Persisted diagnostics did not contain exactly one expected row.", { phase: "diagnostics", requestId: expected.requestId, method: expected.method, matchCount: matches.length });
    const row = matches[0];
    assert(row.status === expected.status, "Persisted diagnostic status mismatch.", { phase: "diagnostics", method: expected.method });
    assert(row.errorCode === expected.errorCode, "Persisted diagnostic errorCode mismatch.", { phase: "diagnostics", method: expected.method });
    assert(row.detailRef === expected.detailRef, "Persisted diagnostic detailRef mismatch.", { phase: "diagnostics", method: expected.method });
  }
  return { diagnosticEntries: entries.length, expectedEntries: expectedRows.length };
}

function readPrivateProfileRecord(storeRoot, profileId) {
  const store = readJsonFile(join(storeRoot, "profile-store", "profiles.json"), "profile store", { rootDir: storeRoot });
  const record = Array.isArray(store.profiles) ? store.profiles.find((profile) => profile?.id === profileId) : null;
  assert(isPlainObject(record), "Imported private profile record was not found.", { phase: "private-store", profileFound: false });
  return record;
}

function writePayloadFixtures({ userDataRoot, packagePath }) {
  const preferencesPath = join(userDataRoot, "Default", "Preferences");
  const storagePath = join(userDataRoot, "Default", "Local Storage", "leveldb", "000003.log");
  mkdirSync(dirname(preferencesPath), { recursive: true });
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(preferencesPath, `${JSON.stringify({ profile: { name: "M005 S02 safe payload" }, browser: { check_default_browser: false } }, null, 2)}\n`, "utf8");
  writeFileSync(storagePath, "m005-s02-safe-local-storage-payload\n", "utf8");
  writeFileSync(join(userDataRoot, "DevToolsActivePort"), "9222\nws://127.0.0.1:9222/devtools/browser/m005-s02-should-not-package\n", "utf8");
  writeFileSync(join(userDataRoot, "SingletonLock"), "m005-s02-runtime-singleton\n", "utf8");
  writeFileSync(packagePath, "placeholder selected package destination should be skipped\n", "utf8");
}

function assertPackageResultShape(result, operation, profileId = null) {
  assert(result.packageVersion === PACKAGE_VERSION, "Profile package result used the wrong package version.", { phase: "package-contract", operation });
  assert(result.format === PACKAGE_FORMAT, "Profile package result used the wrong format.", { phase: "package-contract", operation });
  assert(result.operation === operation, "Profile package result operation mismatch.", { phase: "package-contract", operation });
  if (profileId !== null) assert(result.profileId === profileId, "Profile package result profile id mismatch.", { phase: "package-contract", operation });
  for (const field of ["cookieCount", "payloadFileCount", "payloadByteCount", "warningCount"]) assert(Number.isInteger(result[field]) && result[field] >= 0, "Profile package count field was invalid.", { phase: "package-contract", operation, field });
  assert(Array.isArray(result.warnings) && result.warningCount === result.warnings.length, "Profile package warning count mismatch.", { phase: "package-contract", operation });
  assert(!("destinationPath" in result) && !("sourcePath" in result), "Profile package result leaked a selected path field.", { phase: "package-contract", operation });
  return result;
}

function warningCodes(result) {
  return new Set((result.warnings ?? []).map((warning) => warning?.code).filter((code) => typeof code === "string"));
}

function recordCleanupStep(storeRoot, { context }) {
  const started = performance.now();
  try {
    rmSync(storeRoot, { recursive: true, force: true });
    const removed = !existsSync(storeRoot);
    const durationMs = Math.round(performance.now() - started);
    const cleanup = { status: removed ? "removed" : "failed", retained: !removed };
    STEP_RESULTS.push({ name: "cleanup.temp-fixtures", status: removed ? "pass" : "fail", durationMs });
    emit({ phase: "cleanup.temp-fixtures", status: removed ? "pass" : "fail", durationMs, cleanupStatus: cleanup.status, retained: cleanup.retained }, context);
    return cleanup;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const cleanup = { status: "failed", retained: true, errorCode: error?.code ?? "CLEANUP_FAILED" };
    STEP_RESULTS.push({ name: "cleanup.temp-fixtures", status: "fail", durationMs });
    emit({ phase: "cleanup.temp-fixtures", status: "fail", durationMs, cleanupStatus: cleanup.status, errorCode: cleanup.errorCode }, context);
    return cleanup;
  }
}

export function buildM005S02FinalSummary({ status, mode = "full", checks = STEP_RESULTS, commands = {}, guardrails = {}, docs = {}, packageSmoke = {}, error = null } = {}, context = createM005S02PublicScanContext()) {
  const summary = {
    event: VERIFY_EVENT,
    status,
    mode,
    commands: { focusedVitest: commands.focusedVitest ?? "unknown", frontendBuild: commands.frontendBuild ?? "unknown", sidecarBuild: commands.sidecarBuild ?? "unknown", rustPackageCommandTests: commands.rustPackageCommandTests ?? "unknown" },
    guardrails,
    docs,
    package: {
      exported: Boolean(packageSmoke.exported),
      imported: Boolean(packageSmoke.imported),
      manifestValidated: Boolean(packageSmoke.manifestValidated),
      packageScanClean: Boolean(packageSmoke.packageScanClean),
      publicEvidenceRedacted: Boolean(packageSmoke.publicEvidenceRedacted),
      nameConflictResolved: Boolean(packageSmoke.nameConflictResolved),
      proxyCredentialsStripped: Boolean(packageSmoke.proxyCredentialsStripped),
      cookiesRestored: Boolean(packageSmoke.cookiesRestored),
      payloadRestored: Boolean(packageSmoke.payloadRestored),
      runtimeFilesSkipped: Boolean(packageSmoke.runtimeFilesSkipped),
      restoredLaunchStop: Boolean(packageSmoke.restoredLaunchStop),
      diagnosticsRedacted: Boolean(packageSmoke.diagnosticsRedacted),
      cleanup: { status: packageSmoke.cleanup?.status ?? "unknown", retained: Boolean(packageSmoke.cleanup?.retained) },
      counts: { cookieCount: Number(packageSmoke.counts?.cookieCount ?? 0), importedCookieCount: Number(packageSmoke.counts?.importedCookieCount ?? 0), replacedCookieCount: Number(packageSmoke.counts?.replacedCookieCount ?? 0), payloadFileCount: Number(packageSmoke.counts?.payloadFileCount ?? 0), payloadByteCount: Number(packageSmoke.counts?.payloadByteCount ?? 0), warningCount: Number(packageSmoke.counts?.warningCount ?? 0) },
    },
    checks: checks.map((check) => ({ name: check.name, status: check.status, durationMs: check.durationMs })),
  };
  if (error) summary.error = { name: error.name ?? "Error", message: error.message ?? String(error), details: error.details ? redactM005S02(error.details, context) : {} };
  assertM005S02PublicEvidenceRedacted(summary, context);
  return summary;
}

export function runGuardrailsOnlyVerification({ rootDir = ROOT_DIR, reset = true, emitFinal = true } = {}) {
  if (reset) resetState();
  const context = createM005S02PublicScanContext({ rootDir });
  const capability = runStep("guardrails.capability", () => assertM005S02CapabilityConfig({ rootDir }), context);
  const sourceGuardrails = runStep("guardrails.source", () => assertM005S02SourceGuardrails({ rootDir }), context);
  const docs = runStep("docs.readme-proof-boundary", () => assertM005S02ReadmeDocs({ rootDir }), context);
  const summary = buildM005S02FinalSummary({ status: "pass", mode: "guardrails-only", guardrails: { capability, sourceGuardrails }, docs, checks: STEP_RESULTS }, context);
  if (emitFinal) emit({ status: "pass", summary }, context);
  return summary;
}

export function runSidecarPackageSmoke({ reset = true, emitFinal = true } = {}) {
  if (reset) resetState();
  const smokeStart = STEP_RESULTS.length;
  const storeRoot = mkdtempSync(join(tmpdir(), "theprivator-m005-s02-"));
  const profileName = "M005 S02 Package Smoke";
  const cookieDomain = "m005-s02-cookie.invalid";
  const cookieName = "m005_s02_session";
  const cookieValue = "m005-s02-cookie-value-sentinel";
  const secondCookieName = "m005_s02_secondary";
  const secondCookieValue = "m005-s02-secondary-cookie-value-sentinel";
  const proxyUsername = "m005-s02-socks-user-sentinel";
  const proxyPassword = "m005-s02-socks-password-sentinel";
  let packagePath = join(storeRoot, "package-selected-before-profile.tpkg");
  let context = createM005S02PublicScanContext({ storeRoot, selectedPaths: [packagePath], cookieDomains: [cookieDomain, `.${cookieDomain}`], cookieNames: [cookieName, secondCookieName], cookieValues: [cookieValue, secondCookieValue], proxyCredentials: [proxyUsername, proxyPassword] });
  let packageScanContext = createM005S02PackageScanContext({ storeRoot, selectedPaths: [packagePath], cookieDomains: [cookieDomain, `.${cookieDomain}`], cookieNames: [cookieName, secondCookieName], cookieValues: [cookieValue, secondCookieValue], proxyCredentials: [proxyUsername, proxyPassword] });
  const expectedDiagnostics = [];
  const publicEvidence = [];
  const smoke = { counts: {} };

  function remember(transcript, expected) {
    publicEvidence.push(transcript.response, transcript.diagnostic);
    expectedDiagnostics.push(expected);
    return transcript;
  }

  try {
    const profile = runStep("fixture.profile", () => {
      const createId = makeRequestId("profile-create");
      const created = remember(sidecarSuccess(createId, "profiles.create", { storeRoot, name: profileName }, { context }), { requestId: createId, method: "profiles.create", status: "ok", errorCode: null, detailRef: null });
      const profileId = created.result.profile?.id;
      assert(typeof profileId === "string" && profileId.length > 0, "Smoke profile id was missing.", { phase: "fixture" });
      const proxy = { proxyVersion: 1, mode: "fixedServer", protocol: "socks5", host: "proxy.m005-s02.invalid", port: 19080, credentials: { username: proxyUsername, password: proxyPassword } };
      const proxyId = makeRequestId("proxy-update");
      const proxied = remember(sidecarSuccess(proxyId, "profiles.proxy.update", { storeRoot, profileId, proxy }, { context }), { requestId: proxyId, method: "profiles.proxy.update", status: "ok", errorCode: null, detailRef: null });
      const currentProfile = proxied.result.profile ?? created.result.profile;
      const userDataRoot = join(storeRoot, currentProfile.storage.userDataDir);
      const profileRoot = dirname(userDataRoot);
      packagePath = join(userDataRoot, "selected-package-output-should-not-leak.tpkg");
      context = createM005S02PublicScanContext({ storeRoot, profileRoot, userDataRoot, selectedPaths: [packagePath], packageMemberNames: [MANIFEST_MEMBER, COOKIE_MEMBER, "payload/Default/Preferences", "payload/Default/Local Storage/leveldb/000003.log"], cookieDomains: [cookieDomain, `.${cookieDomain}`], cookieNames: [cookieName, secondCookieName], cookieValues: [cookieValue, secondCookieValue], proxyCredentials: [proxyUsername, proxyPassword] });
      packageScanContext = createM005S02PackageScanContext({ storeRoot, selectedPaths: [packagePath], cookieDomains: [cookieDomain, `.${cookieDomain}`], cookieNames: [cookieName, secondCookieName], cookieValues: [cookieValue, secondCookieValue], proxyCredentials: [proxyUsername, proxyPassword] });
      return { value: { profileId, userDataRoot, profileRoot }, log: { profileReady: true } };
    }, context);

    runStep("fixture.payload-and-cookies", () => {
      writePayloadFixtures({ userDataRoot: profile.userDataRoot, packagePath });
      const cookieFixture = createCookieDbFixture({ storeRoot, profileId: profile.profileId, cookieDomain, cookieName, cookieValue, secondCookieName, secondCookieValue }, context);
      assert(cookieFixture.count === 2, "Cookie DB fixture did not create the expected rows.", { phase: "fixture" });
      return { payloadFiles: 2, runtimeFiles: 2, cookieRows: cookieFixture.count };
    }, context);

    runStep("sidecar.package-export", () => {
      const exportId = makeRequestId("package-export");
      const transcript = remember(sidecarSuccess(exportId, PROFILE_PACKAGE_EXPORT, { storeRoot, profileId: profile.profileId, destinationPath: packagePath }, { context, timeoutMs: 30_000 }), { requestId: exportId, method: PROFILE_PACKAGE_EXPORT, status: "ok", errorCode: null, detailRef: null });
      const result = assertPackageResultShape(transcript.result, "export", profile.profileId);
      assert(existsSync(packagePath) && statSync(packagePath).isFile(), "Profile package export did not write a package file.", { phase: "package-export" });
      assert(result.cookieCount === 2, "Profile package export did not report the expected cookie count.", { phase: "package-export" });
      assert(result.payloadFileCount >= 2, "Profile package export did not include the expected safe payload files.", { phase: "package-export" });
      const codes = warningCodes(result);
      assert(codes.has("PACKAGE_PAYLOAD_RUNTIME_SKIPPED"), "Profile package export did not report skipped runtime files.", { phase: "package-export" });
      assert(codes.has("PACKAGE_PAYLOAD_COOKIE_DB_SKIPPED"), "Profile package export did not report skipped cookie DB files.", { phase: "package-export" });
      assert(codes.has("PACKAGE_EXPORT_DESTINATION_SKIPPED"), "Profile package export did not report skipped selected destination.", { phase: "package-export" });
      smoke.exported = true;
      smoke.counts.cookieCount = result.cookieCount;
      smoke.counts.payloadFileCount = result.payloadFileCount;
      smoke.counts.payloadByteCount = result.payloadByteCount;
      smoke.counts.warningCount = result.warningCount;
      return { cookieCount: result.cookieCount, payloadFileCount: result.payloadFileCount, warningCount: result.warningCount };
    }, context);

    const inspection = runStep("package.inspect-scan", () => {
      const inspected = inspectPackageArchive(packagePath, context);
      const manifestSummary = assertM005S02PackageManifestSummary(inspected.manifest, { expectedProfileName: profileName });
      const packageScan = assertM005S02PackageContentClean(inspected, packageScanContext);
      const memberNames = inspected.members.map((member) => member.name);
      assert(memberNames.includes(MANIFEST_MEMBER) && memberNames.includes(COOKIE_MEMBER), "Profile package missed required members.", { phase: "package-scan" });
      assert(!memberNames.some((name) => /DevToolsActivePort|Singleton|Default\/Network\/Cookies|selected-package-output/i.test(name)), "Profile package included a forbidden runtime, cookie DB, or selected destination member.", { phase: "package-scan" });
      const cookies = Array.isArray(inspected.cookiePayload?.cookies) ? inspected.cookiePayload.cookies : [];
      const cookieValues = new Set(cookies.map((cookie) => cookie?.value));
      assert(cookieValues.has(cookieValue) && cookieValues.has(secondCookieValue), "Profile package cookie member did not contain the intended portable cookie values.", { phase: "package-scan" });
      smoke.manifestValidated = true;
      smoke.packageScanClean = true;
      smoke.runtimeFilesSkipped = true;
      return { value: inspected, log: { scannedMembers: packageScan.scannedMembers, cookieCount: manifestSummary.cookieCount, payloadFileCount: manifestSummary.payloadFileCount } };
    }, context);

    const importResult = runStep("sidecar.package-import", () => {
      const importId = makeRequestId("package-import");
      const transcript = remember(sidecarSuccess(importId, PROFILE_PACKAGE_IMPORT, { storeRoot, sourcePath: packagePath }, { context, timeoutMs: 30_000 }), { requestId: importId, method: PROFILE_PACKAGE_IMPORT, status: "ok", errorCode: null, detailRef: null });
      const result = assertPackageResultShape(transcript.result, "import");
      assert(result.profileId !== profile.profileId, "Profile package import reused the source profile id.", { phase: "package-import" });
      assert(result.nameConflictResolved === true, "Profile package import did not resolve the same-store name conflict.", { phase: "package-import" });
      assert(typeof result.profileName === "string" && result.profileName.includes("Copy"), "Profile package import did not create a copied profile name.", { phase: "package-import" });
      assert(result.profile?.proxy?.credentialState === "none", "Imported public profile proxy did not strip credential state.", { phase: "package-import" });
      assert(result.profile?.proxy?.protocol === "socks5" && result.profile?.proxy?.host === "proxy.m005-s02.invalid", "Imported public profile proxy summary did not preserve fixed SOCKS proxy endpoint.", { phase: "package-import" });
      const privateRecord = readPrivateProfileRecord(storeRoot, result.profileId);
      assert(privateRecord.proxy?.protocol === "socks5" && !("credentials" in privateRecord.proxy), "Imported private profile proxy retained credentials.", { phase: "private-store" });
      smoke.imported = true;
      smoke.nameConflictResolved = true;
      smoke.proxyCredentialsStripped = true;
      smoke.counts.importedCookieCount = result.importedCookieCount;
      smoke.counts.replacedCookieCount = result.replacedCookieCount;
      return { value: result, log: { importedProfileCreated: true, nameConflictResolved: true, importedCookieCount: result.importedCookieCount, replacedCookieCount: result.replacedCookieCount } };
    }, context);

    runStep("restored.payload-and-cookies", () => {
      const importedUserDataRoot = join(storeRoot, importResult.profile.storage.userDataDir);
      const preferences = readFileSync(join(importedUserDataRoot, "Default", "Preferences"), "utf8");
      assert(preferences.includes("M005 S02 safe payload"), "Imported payload did not restore the expected Preferences file.", { phase: "restored-payload" });
      assert(existsSync(join(importedUserDataRoot, "Default", "Local Storage", "leveldb", "000003.log")), "Imported payload did not restore the expected local storage fixture.", { phase: "restored-payload" });
      assert(!existsSync(join(importedUserDataRoot, "DevToolsActivePort")) && !existsSync(join(importedUserDataRoot, "SingletonLock")), "Imported payload restored volatile runtime files.", { phase: "restored-payload" });
      const cookies = cookieDbSummary({ storeRoot, profileId: importResult.profileId, expectedValues: [cookieValue, secondCookieValue] }, context);
      assert(cookies.count === 2 && cookies.hasExpectedValues, "Imported profile cookie DB did not contain restored portable cookies.", { phase: "restored-cookies" });
      smoke.cookiesRestored = true;
      smoke.payloadRestored = true;
      return { payloadRestored: true, cookieRows: cookies.count };
    }, context);

    runStep("restored.launch-stop", () => {
      const fakeChromium = createFakeChromiumExecutable(storeRoot);
      const launchId = makeRequestId("chromium-launch-imported");
      const launch = remember(sidecarSuccess(launchId, "chromium.launch", { storeRoot, profileId: importResult.profileId }, { context, env: { THEPRIVATOR_CHROMIUM_PATH: fakeChromium.path }, timeoutMs: 30_000 }), { requestId: launchId, method: "chromium.launch", status: "ok", errorCode: null, detailRef: null });
      assert(launch.result.profileId === importResult.profileId && launch.result.status === "running", "Imported profile did not launch through the fake Chromium lifecycle.", { phase: "restored-launch" });
      const stopId = makeRequestId("chromium-stop-imported");
      const stop = remember(sidecarSuccess(stopId, "chromium.stop", { storeRoot, profileId: importResult.profileId }, { context, timeoutMs: 20_000 }), { requestId: stopId, method: "chromium.stop", status: "ok", errorCode: null, detailRef: null });
      assert(stop.result.profileId === importResult.profileId && stop.result.status === "stopped", "Imported profile did not stop through the fake Chromium lifecycle.", { phase: "restored-stop" });
      smoke.restoredLaunchStop = true;
      return { launched: true, stopped: true, runningCount: stop.result.runningCount };
    }, context);

    runStep("diagnostics.redaction", () => {
      const entries = readDiagnostics(storeRoot, context);
      const diagnosticSummary = assertPersistedDiagnostics(entries, expectedDiagnostics);
      assertM005S02PublicEvidenceRedacted(redactM005S02(publicEvidence, context), context);
      assertM005S02PublicEvidenceRedacted(entries, context);
      smoke.diagnosticsRedacted = true;
      return diagnosticSummary;
    }, context);

    runStep("verifier.redaction", () => {
      assertM005S02PublicEvidenceRedacted(VERIFIER_EVENTS, context);
      smoke.publicEvidenceRedacted = true;
      return { emittedEvents: VERIFIER_EVENTS.length };
    }, context);

    const cleanup = recordCleanupStep(storeRoot, { context });
    smoke.cleanup = cleanup;
    if (cleanup.status === "failed") fail("M005/S02 temporary package fixture cleanup failed.", { phase: "cleanup", cleanupStatus: cleanup.status, errorCode: cleanup.errorCode });
    const summary = buildM005S02FinalSummary({ status: "pass", mode: "sidecar-only", checks: STEP_RESULTS.slice(smokeStart), packageSmoke: smoke }, context);
    if (emitFinal) emit({ status: "pass", summary }, context);
    void inspection;
    return summary;
  } finally {
    if (!smoke.cleanup) smoke.cleanup = recordCleanupStep(storeRoot, { context });
  }
}

export function runFullVerification({ rootDir = ROOT_DIR } = {}) {
  resetState();
  const context = createM005S02PublicScanContext({ rootDir });
  const commands = {};
  runCommandStep("node.focused-vitest", "npm", ["test", "--", "--run", ...FOCUSED_VITEST_FILES], 180_000, { rootDir, context });
  commands.focusedVitest = "pass";
  runCommandStep("frontend.typecheck-build", "npm", ["run", "build"], 180_000, { rootDir, context });
  commands.frontendBuild = "pass";
  runCommandStep("sidecar.build", "npm", ["run", "sidecar:build"], 360_000, { rootDir, context });
  commands.sidecarBuild = "pass";
  runCommandStep("rust.profile-package-command-tests", "cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "profile_package"], 240_000, { rootDir, context });
  commands.rustPackageCommandTests = "pass";
  const capability = runStep("guardrails.capability", () => assertM005S02CapabilityConfig({ rootDir }), context);
  const sourceGuardrails = runStep("guardrails.source", () => assertM005S02SourceGuardrails({ rootDir }), context);
  const docs = runStep("docs.readme-proof-boundary", () => assertM005S02ReadmeDocs({ rootDir }), context);
  const sidecarSummary = runSidecarPackageSmoke({ reset: false, emitFinal: false });
  const summary = buildM005S02FinalSummary({ status: "pass", mode: "full", commands, guardrails: { capability, sourceGuardrails }, docs, packageSmoke: sidecarSummary.package, checks: STEP_RESULTS }, context);
  assertM005S02PublicEvidenceRedacted(summary, context);
  emit({ status: "pass", summary }, context);
  return summary;
}

function printHelp() {
  console.log(`Usage: npm run verify:m005:s02 -- [--sidecar-only] [--guardrails-only]\n\nDefault             Run the full M005/S02 source-level proof.\n--sidecar-only      Run only the temp source-sidecar .tpkg package smoke.\n--guardrails-only   Verify only capability/source/docs guardrails.\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.guardrailsOnly) {
    runGuardrailsOnlyVerification();
    return 0;
  }
  if (args.sidecarOnly) {
    runSidecarPackageSmoke();
    return 0;
  }
  runFullVerification();
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const context = createM005S02PublicScanContext({ rootDir: ROOT_DIR });
    const safeError = error instanceof VerifyFailure ? error : new VerifyFailure(error instanceof Error ? error.message : String(error));
    const failure = redactM005S02({ event: VERIFY_EVENT, status: "fail", message: safeError.message, details: safeError.details ?? {}, checks: STEP_RESULTS.map((check) => ({ name: check.name, status: check.status, durationMs: check.durationMs })) }, context);
    console.log(JSON.stringify(failure));
    process.exit(1);
  });
}
