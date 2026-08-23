#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT_DIR, VerifyFailure, executable } from "./verify-m004-s01.mjs";
import {
  COOKIE_MEMBER,
  MANIFEST_MEMBER,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  PAYLOAD_PREFIX,
  PROFILE_PACKAGE_EXPORT,
  PROFILE_PACKAGE_IMPORT,
  assertM005S02CapabilityConfig,
  assertM005S02PackageContentClean,
  assertM005S02PublicEvidenceRedacted,
  assertM005S02SourceGuardrails,
  createM005S02PackageScanContext,
  createM005S02PublicScanContext,
  findM005S02ForbiddenPackageMarker,
  findM005S02ForbiddenPublicMarker,
  redactM005S02,
} from "./verify-m005-s02.mjs";

export const VERIFY_EVENT = "verify.m005.s03";
export const DIAGNOSTIC_RELATIVE_LOG_PATH = "profile-store/diagnostics/events.jsonl";
export const PACKAGE_TEMP_PREFIX = "theprivator-profile-package-";

const PYTHON = process.env.PYTHON ?? "python";
const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];
const SAFE_DIAGNOSTIC_KEYS = new Set(["event", "requestId", "method", "status", "durationMs", "errorCode", "detailRef"]);
const SAFE_PERSISTED_DIAGNOSTIC_KEYS = new Set(["schemaVersion", "ts", "source", "event", "status", "logPath", "requestId", "method", "durationMs", "errorCode", "detailRef"]);

const FOCUSED_VITEST_FILES = Object.freeze(["scripts/verify-m005-s03.test.mjs", "src/sidecar/client.test.ts", "src/App.test.tsx"]);
const S03_SOURCE_GUARD_FILES = Object.freeze([
  "scripts/verify-m005-s03.mjs",
  "scripts/verify-m005-s03.test.mjs",
  "package.json",
  "README.md",
  "tests/test_profile_package.py",
  "tests/test_diagnostics.py",
  "src/sidecar/client.test.ts",
  "src/App.test.tsx",
]);

const IGNORED_ARTIFACT_REFERENCE_PATTERN = /(?:^|["'`\s/(])(?:\.gsd|\.planning|\.audits)(?:[\/"'`\s)]|$)/;
const S03_README_COMMAND_PATTERN = /npm run verify:m005:s03/;
const S03_README_BOUNDARY_PATTERN = /S03[\s\S]{0,900}source-level[\s\S]{0,900}(unsafe|malformed|rejection|rollback|cleanup)/i;
const S03_README_SCAN_SPLIT_PATTERN = /redaction[\s\S]{0,900}package-content|package-content[\s\S]{0,900}redaction/i;
const S04_README_DIALOG_PATTERN = /S04[\s\S]{0,900}packaged[\s\S]{0,900}(real-dialog|native open\/save|dialog)/i;

export const S03_MARKERS = Object.freeze({
  cookieDomain: "m005-s03-cookie.invalid",
  cookieName: "m005_s03_session",
  cookieValue: "m005-s03-cookie-value-sentinel",
  secondCookieName: "m005_s03_secondary",
  secondCookieValue: "m005-s03-secondary-cookie-value-sentinel",
  proxyUsername: "m005-s03-socks-user-sentinel",
  proxyPassword: "m005-s03-socks-password-sentinel",
  rawDiagnosticsMember: "metadata/rawDiagnostics.json",
  rawDiagnosticsText: "Traceback raw stdout stderr stack should stay private",
  debugEndpointText: "DevToolsActivePort ws://127.0.0.1:9222/devtools/browser/m005-s03-private",
});

function fail(message, details = {}) {
  throw new VerifyFailure(message, details);
}

function assert(condition, message, details = {}) {
  if (!condition) fail(message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const known = new Set(["--unsafe-smoke-only", "--guardrails-only", "--help", "-h"]);
  return {
    unsafeSmokeOnly: argv.includes("--unsafe-smoke-only"),
    guardrailsOnly: argv.includes("--guardrails-only"),
    help: argv.includes("--help") || argv.includes("-h"),
    unknown: argv.filter((arg) => !known.has(arg)),
  };
}

export function createM005S03PublicScanContext({
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
  return createM005S02PublicScanContext({
    rootDir,
    storeRoot,
    profileRoot,
    userDataRoot,
    selectedPaths,
    packageMemberNames: [MANIFEST_MEMBER, COOKIE_MEMBER, `${PAYLOAD_PREFIX}Default/Preferences`, `${PAYLOAD_PREFIX}Default/Network/Cookies`, S03_MARKERS.rawDiagnosticsMember, ...packageMemberNames],
    cookieDomains: [S03_MARKERS.cookieDomain, `.${S03_MARKERS.cookieDomain}`, ...cookieDomains],
    cookieNames: [S03_MARKERS.cookieName, S03_MARKERS.secondCookieName, ...cookieNames],
    cookieValues: [S03_MARKERS.cookieValue, S03_MARKERS.secondCookieValue, ...cookieValues],
    proxyCredentials: [S03_MARKERS.proxyUsername, S03_MARKERS.proxyPassword, ...proxyCredentials],
    extraSensitiveValues: [S03_MARKERS.rawDiagnosticsText, S03_MARKERS.debugEndpointText, ...extraSensitiveValues],
  });
}

export function createM005S03PackageScanContext({ rootDir = ROOT_DIR, storeRoot, selectedPaths = [], cookieDomains = [], cookieNames = [], cookieValues = [], proxyCredentials = [], extraSensitiveValues = [] } = {}) {
  return createM005S02PackageScanContext({
    rootDir,
    storeRoot,
    selectedPaths,
    cookieDomains: [S03_MARKERS.cookieDomain, `.${S03_MARKERS.cookieDomain}`, ...cookieDomains],
    cookieNames: [S03_MARKERS.cookieName, S03_MARKERS.secondCookieName, ...cookieNames],
    cookieValues: [S03_MARKERS.cookieValue, S03_MARKERS.secondCookieValue, ...cookieValues],
    proxyCredentials: [S03_MARKERS.proxyUsername, S03_MARKERS.proxyPassword, ...proxyCredentials],
    extraSensitiveValues: [S03_MARKERS.rawDiagnosticsText, S03_MARKERS.debugEndpointText, ...extraSensitiveValues],
  });
}

export function collectM005S03MarkerClasses(value, context = createM005S03PublicScanContext()) {
  const encoded = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const markerClasses = new Set();
  for (const marker of context.exactValues ?? []) {
    if (marker.value && encoded.includes(marker.value)) markerClasses.add(marker.markerClass);
  }
  for (const { markerClass, pattern } of context.forbiddenPatterns ?? []) {
    pattern.lastIndex = 0;
    if (pattern.test(encoded)) markerClasses.add(markerClass);
  }
  return [...markerClasses].sort();
}

export function formatM005S03CommandFailure(label, result, context = createM005S03PublicScanContext()) {
  const combinedOutput = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  const failure = {
    phase: "subprocess",
    command: label,
    exitCode: typeof result?.status === "number" ? result.status : null,
    signal: result?.signal ?? null,
    errorCode: result?.error?.code ?? null,
    timedOut: result?.error?.code === "ETIMEDOUT",
    outputSuppressed: true,
    markerClasses: collectM005S03MarkerClasses(combinedOutput, context),
    guidance: result?.error?.code === "ETIMEDOUT" ? "The child process was terminated after the bounded M005/S03 verifier timeout." : "Inspect the named focused command locally; public verifier output suppresses process output and reports marker classes only.",
  };
  assertM005S02PublicEvidenceRedacted(failure, context);
  return failure;
}

export function formatM005S03FailureDetails(error, context = createM005S03PublicScanContext(), phase = "unknown") {
  const redacted = redactM005S02(error?.details && typeof error.details === "object" ? error.details : {}, context);
  const marker = findM005S02ForbiddenPublicMarker(redacted, context);
  if (!marker) return redacted;
  return { phase, markerClass: marker.markerClass, fieldPath: marker.fieldPath, reason: marker.reason, rawDetailsSuppressed: true };
}

function resetState() {
  STEP_RESULTS.length = 0;
  VERIFIER_EVENTS.length = 0;
}

function emit(event, context = createM005S03PublicScanContext()) {
  const safeEvent = redactM005S02({ event: VERIFY_EVENT, ...event }, context);
  assertM005S02PublicEvidenceRedacted(safeEvent, context);
  VERIFIER_EVENTS.push(safeEvent);
  console.log(JSON.stringify(safeEvent));
  return safeEvent;
}

function unpackStepResult(result) {
  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "value")) return { publicResult: result.log ?? {}, returnValue: result.value };
  return { publicResult: result ?? {}, returnValue: result ?? {} };
}

function runStep(name, action, context = createM005S03PublicScanContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(action());
    const durationMs = Math.round(performance.now() - started);
    STEP_RESULTS.push({ name, status: "pass", durationMs });
    emit({ phase: name, status: "pass", durationMs, ...publicResult }, context);
    return returnValue;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    STEP_RESULTS.push({ name, status: "fail", durationMs, message: error instanceof Error ? error.message : String(error) });
    emit({ phase: name, status: "fail", durationMs, message: error instanceof Error ? error.message : String(error), details: formatM005S03FailureDetails(error, context, name) }, context);
    throw error;
  }
}

function runCommandStep(name, command, args, timeoutMs, { rootDir = ROOT_DIR, context = createM005S03PublicScanContext({ rootDir }) } = {}) {
  return runStep(name, () => {
    const label = [command, ...args].join(" ");
    const result = spawnSync(executable(command), args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 24 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      const failure = formatM005S03CommandFailure(label, result, context);
      fail(`${label} ${result.error?.code === "ETIMEDOUT" ? "timed out" : `exited with status ${result.status ?? "unknown"}`}.`, failure);
    }
    return { command: label };
  }, context);
}

function parseJsonLine(line, label) {
  try {
    return JSON.parse(line);
  } catch (error) {
    fail(`${label} was not valid JSON.`, { phase: "json-parse", lineLength: String(line ?? "").length, parserMessage: error instanceof Error ? error.message : String(error), rawOutputSuppressed: true });
  }
}

function parseNdjson(value, expectedLines, label, context) {
  const lines = String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (expectedLines !== null) {
    assert(lines.length === expectedLines, `${label} emitted an unexpected number of NDJSON lines.`, { phase: "sidecar-io", expectedLines, actualLines: lines.length, rawOutputSuppressed: true, markerClasses: collectM005S03MarkerClasses(value, context) });
  } else {
    assert(lines.length >= 1, `${label} emitted no NDJSON lines.`, { phase: "sidecar-io", label });
  }
  return lines.map((line, index) => parseJsonLine(line, `${label} line ${index + 1}`));
}

function runPythonJson(script, input, context, label, { timeoutMs = 20_000 } = {}) {
  const result = spawnSync(executable(PYTHON), ["-c", script], { cwd: ROOT_DIR, input: `${JSON.stringify(input)}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    fail(`${label} fixture failed.`, { phase: "fixture", label, exitCode: typeof result.status === "number" ? result.status : null, errorCode: result.error?.code ?? null, outputSuppressed: true, markerClasses: collectM005S03MarkerClasses(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, context) });
  }
  const output = String(result.stdout ?? "").trim();
  return output ? parseJsonLine(output, `${label} fixture output`) : {};
}

function runSourceSidecarRequest(payload, { context = createM005S03PublicScanContext(), timeoutMs = 30_000 } = {}) {
  const result = spawnSync(executable(PYTHON), ["-m", "theprivator_sidecar"], { cwd: ROOT_DIR, input: `${JSON.stringify(payload)}\n`, env: { ...process.env, PYTHONUNBUFFERED: "1" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    fail("Source sidecar request failed.", { phase: "sidecar-process", method: payload?.method, exitCode: typeof result.status === "number" ? result.status : null, errorCode: result.error?.code ?? null, outputSuppressed: true, markerClasses: collectM005S03MarkerClasses(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, context) });
  }
  const [response] = parseNdjson(result.stdout, 1, "sidecar response stream", context);
  const diagnostics = parseNdjson(result.stderr, null, "sidecar diagnostic stream", context);
  return { response, diagnostic: diagnostics[0], diagnostics };
}

function makeRequestId(label) {
  return `verify-m005-s03-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "request"}`;
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

function sourceSidecarSuccess(id, method, params, { context, timeoutMs = 30_000 } = {}) {
  const transcript = runSourceSidecarRequest({ id, method, params }, { context, timeoutMs });
  assert(transcript.response.id === id, "Sidecar response did not echo the request id.", { phase: "sidecar-contract", method });
  assert(transcript.response.ok === true, `Expected ${method} to succeed.`, { phase: "sidecar-contract", method, errorCode: transcript.response.error?.code, detailRef: transcript.response.error?.detailRef });
  assertDiagnosticEvent(transcript.diagnostic, { method, status: "ok", errorCode: null, detailRef: null });
  assert(isPlainObject(transcript.response.result), "Sidecar success result was not an object.", { phase: "sidecar-contract", method });
  return { ...transcript, result: transcript.response.result };
}

export function assertUnsafeImportFailureTranscript(transcript, { id, expectedCode, context = createM005S03PublicScanContext() } = {}) {
  assert(transcript.response?.id === id, "Sidecar response did not echo the unsafe import request id.", { phase: "unsafe-import", expectedCode });
  assert(transcript.response?.ok === false, "Unsafe package import unexpectedly succeeded.", { phase: "unsafe-import", expectedCode, successSuppressed: true });
  const error = transcript.response.error;
  assert(isPlainObject(error), "Unsafe package import error envelope was malformed.", { phase: "unsafe-import", expectedCode });
  assert(error.code === expectedCode, "Unsafe package import returned the wrong error code.", { phase: "unsafe-import", expectedCode, actualCode: error.code });
  assert(error.recoverable === true, "Unsafe package import error was not recoverable.", { phase: "unsafe-import", expectedCode });
  assert(typeof error.detailRef === "string" && error.detailRef.startsWith("sidecar-"), "Unsafe package import did not expose an opaque detailRef.", { phase: "unsafe-import", expectedCode });
  const diagnostic = assertDiagnosticEvent(transcript.diagnostic, { method: PROFILE_PACKAGE_IMPORT, status: "error", errorCode: expectedCode, detailRef: error.detailRef });
  assertM005S02PublicEvidenceRedacted({ response: transcript.response, diagnostic }, context);
  return { errorCode: error.code, detailRef: error.detailRef, diagnostic };
}

function readJsonFile(path, label, { rootDir = ROOT_DIR } = {}) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} must be valid JSON.`, { phase: "json-read", file: relative(rootDir, path), parserMessage: error instanceof Error ? error.message : String(error) });
  }
}

function assertFileExists(rootDir, relativePath) {
  const absolutePath = join(rootDir, relativePath);
  assert(existsSync(absolutePath), "M005/S03 verifier source scan expected a tracked file to exist.", { phase: "source-guardrail", file: relativePath });
  return absolutePath;
}

export function assertM005S03SourceGuardrails({ rootDir = ROOT_DIR } = {}) {
  const scannedFiles = [];
  for (const relativePath of S03_SOURCE_GUARD_FILES) {
    const source = readFileSync(assertFileExists(rootDir, relativePath), "utf8");
    scannedFiles.push(relativePath);
    assert(!IGNORED_ARTIFACT_REFERENCE_PATTERN.test(source), "M005/S03 verifier and tests must not import ignored planning artifacts.", { phase: "source-guardrail", file: relativePath, markerClass: "ignored_artifact_reference" });
  }
  const packageJson = readJsonFile(join(rootDir, "package.json"), "package.json", { rootDir });
  assert(packageJson.scripts?.["verify:m005:s03"] === "node scripts/verify-m005-s03.mjs", "package.json must expose verify:m005:s03 as the canonical S03 command.", { phase: "source-guardrail", markerClass: "missing_package_script" });
  return { scannedFiles: scannedFiles.length, ignoredArtifactImports: "absent", packageScript: "verify:m005:s03" };
}

export function assertM005S03ReadmeDocs({ rootDir = ROOT_DIR } = {}) {
  const readme = readFileSync(assertFileExists(rootDir, "README.md"), "utf8");
  assert(S03_README_COMMAND_PATTERN.test(readme), "README must document the canonical M005/S03 verifier command.", { phase: "docs", markerClass: "missing_command" });
  assert(S03_README_BOUNDARY_PATTERN.test(readme), "README must describe S03 as the source-level unsafe package safety proof.", { phase: "docs", markerClass: "missing_s03_boundary" });
  assert(S03_README_SCAN_SPLIT_PATTERN.test(readme), "README must explain the redaction scanner versus package-content scanner split.", { phase: "docs", markerClass: "missing_scan_boundary" });
  assert(S04_README_DIALOG_PATTERN.test(readme), "README must defer packaged real-dialog package proof to S04.", { phase: "docs", markerClass: "missing_s04_boundary" });
  return { command: "documented", sourceSafetyProof: "documented", scanBoundary: "documented", packagedDialogProof: "deferred-to-s04" };
}

function packageTempDirs() {
  try {
    return new Set(readdirSync(tmpdir(), { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith(PACKAGE_TEMP_PREFIX)).map((entry) => join(tmpdir(), entry.name)));
  } catch {
    return new Set();
  }
}

function assertNoNewPackageTempDirs(before) {
  const retained = [...packageTempDirs()].filter((path) => !before.has(path) && existsSync(path));
  assert(retained.length === 0, "Profile package temporary staging directories were retained.", { phase: "temp-cleanup", retainedCount: retained.length });
  return { retainedTempDirs: 0 };
}

function assertNoProfileMutation(storeRoot) {
  const profilesFile = join(storeRoot, "profile-store", "profiles.json");
  const profiles = existsSync(profilesFile) ? readJsonFile(profilesFile, "profile store", { rootDir: storeRoot }).profiles ?? [] : [];
  const profilesDir = join(storeRoot, "profile-store", "profiles");
  const profileDirCount = existsSync(profilesDir) ? readdirSync(profilesDir).length : 0;
  assert(profiles.length === 0 && profileDirCount === 0, "Unsafe package import mutated profile records or directories.", { phase: "rollback-no-profile", profileCount: profiles.length, profileDirCount });
  return { profileRecords: profiles.length, profileDirectories: profileDirCount };
}

function writeUnsafePackageFixtures(fixtureRoot, context) {
  const script = String.raw`
import copy, hashlib, json, stat, sys, zipfile
from pathlib import Path
from theprivator_sidecar import profile_package
from theprivator_sidecar.identity import DEFAULT_REAL_IDENTITY
from theprivator_sidecar.proxy import PROXY_VERSION, FIXED_SERVER_PROXY_MODE
payload = json.load(sys.stdin)
root = Path(payload["fixtureRoot"]); root.mkdir(parents=True, exist_ok=True)
cookie_payload = (json.dumps({"format":"theprivator.cookies","version":1,"cookies":[]}, sort_keys=True) + "\n").encode("utf-8")
def manifest(**overrides):
    data = {"format": profile_package.PACKAGE_FORMAT, "version": profile_package.PACKAGE_VERSION, "createdAt": "2026-01-01T00:00:00.000Z", "profile": {"name": "M005 S03 Imported", "identity": copy.deepcopy(DEFAULT_REAL_IDENTITY), "proxy": {"proxyVersion": PROXY_VERSION, "mode": "direct"}, "proxySummary": {"proxyVersion": PROXY_VERSION, "mode": "direct", "credentialState": "none", "summary": "Direct connection"}}, "cookies": {"member": profile_package.COOKIE_MEMBER, "format": "theprivator.cookies", "version": 1, "byteCount": len(cookie_payload), "sha256": hashlib.sha256(cookie_payload).hexdigest(), "cookieCount": 0, "skippedCount": 0}, "payload": {"prefix": profile_package.PAYLOAD_PREFIX, "fileCount": 0, "byteCount": 0, "files": []}, "warnings": []}
    data.update(overrides); return data
def write_zip(name, data, extra_members=None, extra_infos=None):
    path = root / name
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(profile_package.MANIFEST_MEMBER, json.dumps(data, sort_keys=True).encode("utf-8")); archive.writestr(profile_package.COOKIE_MEMBER, cookie_payload)
        for member, content in (extra_members or {}).items(): archive.writestr(member, content)
        for info, content in (extra_infos or []): archive.writestr(info, content)
    return path
cases = []
not_zip = root / "not-a-zip.tpkg"; not_zip.write_text("not a zip with manifest.json payload/secret Traceback", encoding="utf-8"); cases.append({"caseId":"invalid_non_zip","fileName":not_zip.name,"expectedCode":"PORTABILITY_PACKAGE_INVALID"})
unsupported = write_zip("unsupported-version.tpkg", manifest(version=999)); cases.append({"caseId":"unsupported_version","fileName":unsupported.name,"expectedCode":"PORTABILITY_PACKAGE_UNSUPPORTED_VERSION"})
checksum_manifest = manifest(); checksum_manifest["cookies"]["sha256"] = "0" * 64; checksum = write_zip("checksum-mismatch.tpkg", checksum_manifest); cases.append({"caseId":"checksum_mismatch","fileName":checksum.name,"expectedCode":"PORTABILITY_PACKAGE_CHECKSUM_MISMATCH"})
too_large_manifest = manifest(payload={"prefix": profile_package.PAYLOAD_PREFIX, "fileCount": 0, "byteCount": profile_package.MAX_PAYLOAD_BYTES + 1, "files": []}); too_large = write_zip("too-large-payload.tpkg", too_large_manifest); cases.append({"caseId":"too_large","fileName":too_large.name,"expectedCode":"PORTABILITY_PACKAGE_TOO_LARGE"})
unsafe_manifest = manifest(); unsafe_manifest["profile"]["proxy"] = {"proxyVersion": PROXY_VERSION, "mode": FIXED_SERVER_PROXY_MODE, "protocol":"http", "host":"proxy.m005-s03.invalid", "port":8080, "credentials":{"username":payload["proxyUsername"],"password":payload["proxyPassword"]}}; unsafe_manifest["profile"]["proxySummary"] = {"proxyVersion": PROXY_VERSION, "mode": FIXED_SERVER_PROXY_MODE, "credentialState":"configured", "summary":"credentialed proxy should stay private"}; unsafe = write_zip("unsafe-manifest.tpkg", unsafe_manifest); cases.append({"caseId":"unsafe_manifest","fileName":unsafe.name,"expectedCode":"PORTABILITY_PACKAGE_INVALID"})
extra = write_zip("extra-raw-diagnostics-member.tpkg", manifest(), extra_members={payload["rawDiagnosticsMember"]: payload["rawDiagnosticsText"].encode("utf-8")}); cases.append({"caseId":"extra_member","fileName":extra.name,"expectedCode":"PORTABILITY_PACKAGE_INVALID"})
special_payload = b"not followed"; special_manifest = manifest(payload={"prefix": profile_package.PAYLOAD_PREFIX, "fileCount":1, "byteCount":len(special_payload), "files":[{"path":"Default/Preferences","member":profile_package.PAYLOAD_PREFIX+"Default/Preferences","byteCount":len(special_payload),"sha256":hashlib.sha256(special_payload).hexdigest()}]}); special_info = zipfile.ZipInfo(profile_package.PAYLOAD_PREFIX + "Default/Preferences"); special_info.external_attr = (stat.S_IFLNK | 0o777) << 16; special = write_zip("special-payload.tpkg", special_manifest, extra_infos=[(special_info, special_payload)]); cases.append({"caseId":"payload_failed","fileName":special.name,"expectedCode":"PORTABILITY_PACKAGE_PAYLOAD_FAILED"})
cases.append({"caseId":"read_failed","fileName":"missing-source.tpkg","expectedCode":"PORTABILITY_PACKAGE_READ_FAILED"})
print(json.dumps({"cases": cases}))
`;
  const result = runPythonJson(script, { fixtureRoot, proxyUsername: S03_MARKERS.proxyUsername, proxyPassword: S03_MARKERS.proxyPassword, rawDiagnosticsMember: S03_MARKERS.rawDiagnosticsMember, rawDiagnosticsText: S03_MARKERS.rawDiagnosticsText }, context, "unsafe-package-fixtures");
  assert(Array.isArray(result.cases) && result.cases.length >= 6, "Unsafe package fixture generation returned no cases.", { phase: "fixture", caseCount: Array.isArray(result.cases) ? result.cases.length : 0 });
  return result.cases.map((item) => ({ ...item, sourcePath: join(fixtureRoot, item.fileName) }));
}

function createCookieDbFixture({ storeRoot, profileId }, context) {
  const script = String.raw`
import json, sqlite3, sys
from pathlib import Path
from theprivator_sidecar.cookies import _CANONICAL_COOKIE_SCHEMA, unix_time_to_chrome
payload = json.load(sys.stdin)
db_path = Path(payload["storeRoot"]) / "profile-store" / "profiles" / payload["profileId"] / "user-data" / "Default" / "Network" / "Cookies"
db_path.parent.mkdir(parents=True, exist_ok=True)
conn = sqlite3.connect(db_path)
try:
    conn.execute(_CANONICAL_COOKIE_SCHEMA); now = unix_time_to_chrome(1_700_000_000)
    rows = [(now, payload["cookieDomain"], "", payload["cookieName"], payload["cookieValue"], b"", "/", 0, 1, 1, now, 0, 0, 1, -1, 2, 443, 0, now, 0, 0), (now, "." + payload["cookieDomain"], "", payload["secondCookieName"], payload["secondCookieValue"], b"", "/session", 0, 0, 0, now, 0, 0, 1, -1, 1, 80, 0, now, 0, 0)]
    conn.executemany("INSERT INTO cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port, is_same_party, last_update_utc, source_type, has_cross_site_ancestor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows); conn.commit()
finally:
    conn.close()
print(json.dumps({"count": 2}))
`;
  return runPythonJson(script, { storeRoot, profileId, cookieDomain: S03_MARKERS.cookieDomain, cookieName: S03_MARKERS.cookieName, cookieValue: S03_MARKERS.cookieValue, secondCookieName: S03_MARKERS.secondCookieName, secondCookieValue: S03_MARKERS.secondCookieValue }, context, "cookie-db-create");
}

function inspectPackageArchive(packagePath, context) {
  const script = String.raw`
import hashlib, json, sys, zipfile
payload = json.load(sys.stdin)
with zipfile.ZipFile(payload["packagePath"], "r") as archive:
    members = []
    for info in archive.infolist():
        raw = archive.read(info.filename)
        try: text = raw.decode("utf-8")
        except UnicodeDecodeError: text = ""
        members.append({"name": info.filename, "byteCount": info.file_size, "sha256": hashlib.sha256(raw).hexdigest(), "text": text})
    manifest = json.loads(archive.read("manifest.json").decode("utf-8")); cookie_payload = json.loads(archive.read("cookies/theprivator-cookies.json").decode("utf-8"))
print(json.dumps({"members": members, "manifest": manifest, "cookiePayload": cookie_payload}))
`;
  return runPythonJson(script, { packagePath }, context, "package-inspection");
}

function readDiagnostics(storeRoot) {
  const path = join(storeRoot, DIAGNOSTIC_RELATIVE_LOG_PATH);
  assert(existsSync(path), "Diagnostic log was not written.", { phase: "diagnostics" });
  return readFileSync(path, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => parseJsonLine(line, `diagnostic ${index + 1}`));
}

function lookupDetailRefs(storeRoot, detailRefs, context) {
  const script = String.raw`
import json, sys
from theprivator_sidecar.diagnostics import lookup_by_detail_ref
payload = json.load(sys.stdin)
print(json.dumps({"lookups": [{"detailRef": ref, "lookup": lookup_by_detail_ref(payload["storeRoot"], ref)} for ref in payload["detailRefs"]]}, sort_keys=True))
`;
  return runPythonJson(script, { storeRoot, detailRefs }, context, "diagnostic-detailref-lookup");
}

function assertPersistedDiagnostics(entries, lookups, expectedRows, context) {
  for (const [index, entry] of entries.entries()) {
    for (const key of Object.keys(entry)) assert(SAFE_PERSISTED_DIAGNOSTIC_KEYS.has(key), "Persisted diagnostic included an unsafe field.", { phase: "diagnostics", index, field: key });
    assert(entry.event === "sidecar.request" && entry.logPath === DIAGNOSTIC_RELATIVE_LOG_PATH, "Persisted diagnostic shape mismatch.", { phase: "diagnostics", index });
  }
  for (const expected of expectedRows) {
    const matches = entries.filter((entry) => entry.requestId === expected.requestId && entry.method === expected.method);
    assert(matches.length === 1, "Persisted diagnostics did not contain exactly one expected row.", { phase: "diagnostics", requestId: expected.requestId, method: expected.method, matchCount: matches.length });
    const row = matches[0];
    assert(row.status === expected.status && row.errorCode === expected.errorCode && row.detailRef === expected.detailRef, "Persisted diagnostic did not match expected status/code/detailRef.", { phase: "diagnostics", method: expected.method, errorCode: expected.errorCode });
    const lookupRow = lookups.lookups?.find((item) => item.detailRef === expected.detailRef);
    assert(lookupRow?.lookup?.found === true && lookupRow.lookup.entries?.[0]?.detailRef === expected.detailRef, "Persisted detailRef lookup did not find the expected row.", { phase: "diagnostics", errorCode: expected.errorCode });
  }
  assertM005S02PublicEvidenceRedacted(entries, context);
  assertM005S02PublicEvidenceRedacted(lookups, context);
  return { diagnosticEntries: entries.length, lookupEntries: lookups.lookups?.length ?? 0, expectedEntries: expectedRows.length };
}

function writeAcceptedPayloadFixtures({ userDataRoot, packagePath }) {
  const preferencesPath = join(userDataRoot, "Default", "Preferences");
  mkdirSync(dirname(preferencesPath), { recursive: true });
  writeFileSync(preferencesPath, `${JSON.stringify({ profile: { name: "M005 S03 safe payload" } }, null, 2)}\n`, "utf8");
  writeFileSync(join(userDataRoot, "DevToolsActivePort"), S03_MARKERS.debugEndpointText, "utf8");
  writeFileSync(join(userDataRoot, "SingletonLock"), "m005-s03-runtime-singleton\n", "utf8");
  writeFileSync(packagePath, "selected package destination placeholder should be skipped\n", "utf8");
}

function assertPackageResultShape(result, operation, profileId = null) {
  assert(result.packageVersion === PACKAGE_VERSION && result.format === PACKAGE_FORMAT && result.operation === operation, "Profile package result contract mismatch.", { phase: "package-contract", operation });
  if (profileId !== null) assert(result.profileId === profileId, "Profile package result profile id mismatch.", { phase: "package-contract", operation });
  for (const field of ["cookieCount", "payloadFileCount", "payloadByteCount", "warningCount"]) assert(Number.isInteger(result[field]) && result[field] >= 0, "Profile package count field was invalid.", { phase: "package-contract", operation, field });
  assert(!("destinationPath" in result) && !("sourcePath" in result), "Profile package result leaked a selected path field.", { phase: "package-contract", operation });
  return result;
}

function recordCleanupStep(storeRoot, { context, smoke }) {
  const started = performance.now();
  try {
    rmSync(storeRoot, { recursive: true, force: true });
    const cleanup = { status: !existsSync(storeRoot) ? "removed" : "failed", retained: existsSync(storeRoot) };
    const durationMs = Math.round(performance.now() - started);
    STEP_RESULTS.push({ name: "cleanup.verifier-fixtures", status: cleanup.retained ? "fail" : "pass", durationMs });
    emit({ phase: "cleanup.verifier-fixtures", status: cleanup.retained ? "fail" : "pass", durationMs, cleanupStatus: cleanup.status, retained: cleanup.retained }, context);
    if (smoke) smoke.cleanup = cleanup;
    return cleanup;
  } catch (error) {
    const cleanup = { status: "failed", retained: true, errorCode: error?.code ?? "CLEANUP_FAILED" };
    if (smoke) smoke.cleanup = cleanup;
    return cleanup;
  }
}

export function buildM005S03FinalSummary({ status, mode = "full", checks = STEP_RESULTS, commands = {}, guardrails = {}, docs = {}, packageSafety = {}, error = null } = {}, context = createM005S03PublicScanContext()) {
  const summary = {
    event: VERIFY_EVENT,
    status,
    mode,
    commands: {
      pythonPackageDiagnostics: commands.pythonPackageDiagnostics ?? "unknown",
      rustPackageCommandTests: commands.rustPackageCommandTests ?? "unknown",
      focusedVitest: commands.focusedVitest ?? "unknown",
      frontendBuild: commands.frontendBuild ?? "unknown",
      sidecarBuild: commands.sidecarBuild ?? "unknown",
    },
    guardrails,
    docs,
    packageSafety: {
      unsafeImportFailures: Number(packageSafety.unsafeImportFailures ?? 0),
      typedErrorCodes: Array.isArray(packageSafety.typedErrorCodes) ? [...new Set(packageSafety.typedErrorCodes)].sort() : [],
      rollbackNoProfile: Boolean(packageSafety.rollbackNoProfile),
      rollbackProvenByPythonTests: Boolean(packageSafety.rollbackProvenByPythonTests),
      packageTempCleanup: Boolean(packageSafety.packageTempCleanup),
      diagnosticsDetailRefLookupRedacted: Boolean(packageSafety.diagnosticsDetailRefLookupRedacted),
      acceptedPackageContentClean: Boolean(packageSafety.acceptedPackageContentClean),
      publicEvidenceRedacted: Boolean(packageSafety.publicEvidenceRedacted),
      cleanup: { status: packageSafety.cleanup?.status ?? "unknown", retained: Boolean(packageSafety.cleanup?.retained) },
    },
    checks: checks.map((check) => ({ name: check.name, status: check.status, durationMs: check.durationMs })),
  };
  if (error) summary.error = { name: error.name ?? "Error", message: error.message ?? String(error), details: formatM005S03FailureDetails(error, context, "final-summary") };
  assertM005S02PublicEvidenceRedacted(summary, context);
  return summary;
}

export function runGuardrailsOnlyVerification({ rootDir = ROOT_DIR, reset = true, emitFinal = true } = {}) {
  if (reset) resetState();
  const context = createM005S03PublicScanContext({ rootDir });
  const s02Capability = runStep("guardrails.s02-capability", () => assertM005S02CapabilityConfig({ rootDir }), context);
  const s02Source = runStep("guardrails.s02-source", () => assertM005S02SourceGuardrails({ rootDir }), context);
  const s03Source = runStep("guardrails.s03-source", () => assertM005S03SourceGuardrails({ rootDir }), context);
  const docs = runStep("docs.readme-s03-proof-boundary", () => assertM005S03ReadmeDocs({ rootDir }), context);
  const summary = buildM005S03FinalSummary({ status: "pass", mode: "guardrails-only", guardrails: { s02Capability, s02Source, s03Source }, docs, checks: STEP_RESULTS }, context);
  if (emitFinal) emit({ status: "pass", summary }, context);
  return summary;
}

export function runUnsafePackageSmoke({ reset = true, emitFinal = true } = {}) {
  if (reset) resetState();
  const smokeStart = STEP_RESULTS.length;
  const storeRoot = mkdtempSync(join(tmpdir(), "theprivator-m005-s03-"));
  const fixtureRoot = join(storeRoot, "unsafe-fixtures");
  let packagePath = join(storeRoot, "accepted-package-output.tpkg");
  let context = createM005S03PublicScanContext({ storeRoot, selectedPaths: [packagePath, fixtureRoot] });
  let packageScanContext = createM005S03PackageScanContext({ storeRoot, selectedPaths: [packagePath] });
  const publicEvidence = [];
  const expectedDiagnostics = [];
  const tempBefore = packageTempDirs();
  const smoke = { typedErrorCodes: [], unsafeImportFailures: 0 };
  const remember = (transcript, expected) => { publicEvidence.push(transcript.response, transcript.diagnostic); expectedDiagnostics.push(expected); return transcript; };

  try {
    const cases = runStep("fixture.unsafe-packages", () => {
      const fixtureCases = writeUnsafePackageFixtures(fixtureRoot, context);
      return { value: fixtureCases, log: { caseCount: fixtureCases.length } };
    }, context);
    context = createM005S03PublicScanContext({ storeRoot, selectedPaths: [packagePath, fixtureRoot, ...cases.map((item) => item.sourcePath)], packageMemberNames: [S03_MARKERS.rawDiagnosticsMember, `${PAYLOAD_PREFIX}Default/Preferences`] });
    packageScanContext = createM005S03PackageScanContext({ storeRoot, selectedPaths: [packagePath, ...cases.map((item) => item.sourcePath)] });

    for (const testCase of cases) {
      runStep(`unsafe.import.${testCase.caseId}`, () => {
        const requestId = makeRequestId(`unsafe-${testCase.caseId}`);
        const transcript = runSourceSidecarRequest({ id: requestId, method: PROFILE_PACKAGE_IMPORT, params: { storeRoot, sourcePath: testCase.sourcePath } }, { context, timeoutMs: 30_000 });
        const checked = assertUnsafeImportFailureTranscript(transcript, { id: requestId, expectedCode: testCase.expectedCode, context });
        remember(transcript, { requestId, method: PROFILE_PACKAGE_IMPORT, status: "error", errorCode: testCase.expectedCode, detailRef: checked.detailRef });
        assertNoProfileMutation(storeRoot);
        smoke.unsafeImportFailures += 1;
        smoke.typedErrorCodes.push(testCase.expectedCode);
        return { caseId: testCase.caseId, errorCode: testCase.expectedCode, detailRef: "present", profileMutation: "absent" };
      }, context);
    }

    runStep("rollback.no-profile-validation-failures", () => { smoke.rollbackNoProfile = true; return assertNoProfileMutation(storeRoot); }, context);
    runStep("cleanup.package-temp-staging", () => { smoke.packageTempCleanup = true; return assertNoNewPackageTempDirs(tempBefore); }, context);
    runStep("diagnostics.detailref-redaction", () => {
      const entries = readDiagnostics(storeRoot);
      const lookups = lookupDetailRefs(storeRoot, expectedDiagnostics.map((row) => row.detailRef), context);
      const diagnosticSummary = assertPersistedDiagnostics(entries, lookups, expectedDiagnostics, context);
      assertM005S02PublicEvidenceRedacted(redactM005S02(publicEvidence, context), context);
      smoke.diagnosticsDetailRefLookupRedacted = true;
      return diagnosticSummary;
    }, context);

    runStep("accepted.exported-package-content-scan", () => {
      const createId = makeRequestId("accepted-profile-create");
      const created = remember(sourceSidecarSuccess(createId, "profiles.create", { storeRoot, name: "M005 S03 Accepted Package" }, { context }), { requestId: createId, method: "profiles.create", status: "ok", errorCode: null, detailRef: null });
      const profileId = created.result.profile?.id;
      assert(typeof profileId === "string" && profileId.length > 0, "Accepted package fixture profile id was missing.", { phase: "accepted-package" });
      const proxyId = makeRequestId("accepted-proxy-update");
      const proxied = remember(sourceSidecarSuccess(proxyId, "profiles.proxy.update", { storeRoot, profileId, proxy: { proxyVersion: 1, mode: "fixedServer", protocol: "socks5", host: "proxy.m005-s03.invalid", port: 19081, credentials: { username: S03_MARKERS.proxyUsername, password: S03_MARKERS.proxyPassword } } }, { context }), { requestId: proxyId, method: "profiles.proxy.update", status: "ok", errorCode: null, detailRef: null });
      const profile = proxied.result.profile ?? created.result.profile;
      const userDataRoot = join(storeRoot, profile.storage.userDataDir);
      packagePath = join(userDataRoot, "accepted-package-output.tpkg");
      context = createM005S03PublicScanContext({ storeRoot, profileRoot: dirname(userDataRoot), userDataRoot, selectedPaths: [packagePath], packageMemberNames: [MANIFEST_MEMBER, COOKIE_MEMBER, `${PAYLOAD_PREFIX}Default/Preferences`] });
      packageScanContext = createM005S03PackageScanContext({ storeRoot, selectedPaths: [packagePath] });
      writeAcceptedPayloadFixtures({ userDataRoot, packagePath });
      const cookieFixture = createCookieDbFixture({ storeRoot, profileId }, context);
      assert(cookieFixture.count === 2, "Cookie DB fixture did not create the expected rows.", { phase: "accepted-package" });
      const exportId = makeRequestId("accepted-package-export");
      const exported = remember(sourceSidecarSuccess(exportId, PROFILE_PACKAGE_EXPORT, { storeRoot, profileId, destinationPath: packagePath }, { context, timeoutMs: 45_000 }), { requestId: exportId, method: PROFILE_PACKAGE_EXPORT, status: "ok", errorCode: null, detailRef: null });
      const result = assertPackageResultShape(exported.result, "export", profileId);
      assert(existsSync(packagePath) && statSync(packagePath).isFile(), "Accepted package export did not write a package file.", { phase: "accepted-package" });
      const inspection = inspectPackageArchive(packagePath, context);
      const packageScan = assertM005S02PackageContentClean(inspection, packageScanContext);
      const members = inspection.members.map((member) => member.name);
      assert(members.includes(MANIFEST_MEMBER) && members.includes(COOKIE_MEMBER), "Accepted package missed required fixed members.", { phase: "accepted-package" });
      assert(!members.some((name) => /DevToolsActivePort|Singleton|Default\/Network\/Cookies/i.test(name)), "Accepted package included a forbidden runtime or raw cookie database member.", { phase: "accepted-package", markerClass: "runtime_member" });
      const packageMarker = findM005S02ForbiddenPackageMarker(inspection.manifest, packageScanContext, MANIFEST_MEMBER);
      assert(!packageMarker, "Accepted package manifest retained forbidden material.", packageMarker ?? {});
      smoke.acceptedPackageContentClean = true;
      return { exported: true, scannedMembers: packageScan.scannedMembers, cookieCount: result.cookieCount, payloadFileCount: result.payloadFileCount, warningCount: result.warningCount };
    }, context);

    runStep("verifier.public-evidence-redaction", () => {
      assertM005S02PublicEvidenceRedacted(redactM005S02(publicEvidence, context), context);
      assertM005S02PublicEvidenceRedacted(VERIFIER_EVENTS, context);
      smoke.publicEvidenceRedacted = true;
      return { publicEvidenceItems: publicEvidence.length, emittedEvents: VERIFIER_EVENTS.length };
    }, context);

    const cleanup = recordCleanupStep(storeRoot, { context, smoke });
    if (cleanup.status === "failed") fail("M005/S03 temporary verifier fixture cleanup failed.", { phase: "cleanup", cleanupStatus: cleanup.status });
    const summary = buildM005S03FinalSummary({ status: "pass", mode: "unsafe-smoke-only", checks: STEP_RESULTS.slice(smokeStart), packageSafety: smoke }, context);
    if (emitFinal) emit({ status: "pass", summary }, context);
    return summary;
  } finally {
    if (!smoke.cleanup) recordCleanupStep(storeRoot, { context, smoke });
  }
}

export function runFullVerification({ rootDir = ROOT_DIR } = {}) {
  resetState();
  const context = createM005S03PublicScanContext({ rootDir });
  const commands = {};
  runCommandStep("python.package-diagnostics-tests", PYTHON, ["-m", "pytest", "tests/test_profile_package.py", "tests/test_diagnostics.py", "-q"], 300_000, { rootDir, context }); commands.pythonPackageDiagnostics = "pass";
  runCommandStep("rust.profile-package-command-tests", "cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "profile_package"], 240_000, { rootDir, context }); commands.rustPackageCommandTests = "pass";
  runCommandStep("node.focused-vitest", "npm", ["test", "--", "--run", ...FOCUSED_VITEST_FILES], 180_000, { rootDir, context }); commands.focusedVitest = "pass";
  runCommandStep("frontend.typecheck-build", "npm", ["run", "build"], 180_000, { rootDir, context }); commands.frontendBuild = "pass";
  runCommandStep("sidecar.build", "npm", ["run", "sidecar:build"], 360_000, { rootDir, context }); commands.sidecarBuild = "pass";
  const s02Capability = runStep("guardrails.s02-capability", () => assertM005S02CapabilityConfig({ rootDir }), context);
  const s02Source = runStep("guardrails.s02-source", () => assertM005S02SourceGuardrails({ rootDir }), context);
  const s03Source = runStep("guardrails.s03-source", () => assertM005S03SourceGuardrails({ rootDir }), context);
  const docs = runStep("docs.readme-s03-proof-boundary", () => assertM005S03ReadmeDocs({ rootDir }), context);
  const smokeSummary = runUnsafePackageSmoke({ reset: false, emitFinal: false });
  const packageSafety = { ...smokeSummary.packageSafety, rollbackProvenByPythonTests: commands.pythonPackageDiagnostics === "pass" };
  const summary = buildM005S03FinalSummary({ status: "pass", mode: "full", commands, guardrails: { s02Capability, s02Source, s03Source }, docs, packageSafety, checks: STEP_RESULTS }, context);
  emit({ status: "pass", summary }, context);
  return summary;
}

function printHelp() {
  console.log(`Usage: npm run verify:m005:s03 -- [--unsafe-smoke-only] [--guardrails-only]\n\nDefault              Run the full M005/S03 source-level package safety proof.\n--unsafe-smoke-only  Run only unsafe package rejection, diagnostics, cleanup, and package-content scans.\n--guardrails-only    Verify only capability/source/docs guardrails.\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { printHelp(); return 0; }
  if (args.unknown.length > 0) fail("Unknown M005/S03 verifier argument.", { phase: "args", unknownCount: args.unknown.length });
  if (args.guardrailsOnly) { runGuardrailsOnlyVerification(); return 0; }
  if (args.unsafeSmokeOnly) { runUnsafePackageSmoke(); return 0; }
  runFullVerification();
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const context = createM005S03PublicScanContext({ rootDir: ROOT_DIR });
    const safeError = error instanceof VerifyFailure ? error : new VerifyFailure(error instanceof Error ? error.message : String(error));
    const summary = buildM005S03FinalSummary({ status: "fail", mode: "full", checks: STEP_RESULTS, error: safeError }, context);
    emit({ status: "fail", summary }, context);
    process.exit(1);
  });
}
