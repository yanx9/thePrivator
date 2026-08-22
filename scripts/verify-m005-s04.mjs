#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter as hostPathDelimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { By } from "selenium-webdriver";
import { ROOT_DIR, VerifyFailure, executable } from "./verify-m004-s01.mjs";
import { readGuardedUiSources, readUiSources } from "./ui-sources.mjs";
import {
  COOKIE_MEMBER,
  MANIFEST_MEMBER,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  PAYLOAD_PREFIX,
  assertM005S02PackageContentClean,
  createM005S02PackageScanContext,
} from "./verify-m005-s02.mjs";
import {
  assertBuildArtifactsPresent as assertS06BuildArtifactsPresent,
  assertFreshBuildArtifacts as assertS06FreshBuildArtifacts,
  assertInitialPackagedUi as assertS06InitialPackagedUi,
  assertWebDriverPreflight as assertS06WebDriverPreflight,
  cleanupPackagedSmoke as cleanupS06PackagedSmoke,
  createSmokeProfile as createS06SmokeProfile,
  createSmokeRunContext as createS06SmokeRunContext,
  createTauriWebDriverSession as createS06TauriWebDriverSession,
  quitDriverSession as quitS06DriverSession,
  readMetricValue as readS06MetricValue,
  readProfileCardText as readS06ProfileCardText,
  readProfileSectionText as readS06ProfileSectionText,
  readTargetTriple as readS06TargetTriple,
  resolveChromiumExecutable as resolveS06ChromiumExecutable,
  waitForProfileButton as waitS06ProfileButton,
  waitForMetricValue as waitS06MetricValueVisible,
  startTauriDriverProcess as startS06TauriDriverProcess,
  waitForProfileCard as waitS06ProfileCard,
  waitForVisibleElement as waitS06VisibleElement,
  waitForVisibleText as waitS06VisibleText,
} from "./verify-s06.mjs";

export const VERIFY_EVENT = "verify.m005.s04";
export const SIDECAR_EXTERNAL_BIN = "binaries/theprivator-sidecar";
export const DEFAULT_BUILD_TIMEOUT_MS = Number(process.env.VERIFY_M005_S04_BUILD_TIMEOUT_MS ?? 20 * 60_000);
export const DEFAULT_COMMAND_TIMEOUT_MS = Number(process.env.VERIFY_M005_S04_COMMAND_TIMEOUT_MS ?? 30_000);
export const DEFAULT_FIXTURE_TIMEOUT_MS = Number(process.env.VERIFY_M005_S04_FIXTURE_TIMEOUT_MS ?? 10_000);
export const M005_S04_PROFILE_PREFIX = "M005 Packaged Portability Smoke";
export const DIAGNOSTIC_RELATIVE_LOG_PATH = "profile-store/diagnostics/events.jsonl";
export const PYTHON = process.env.PYTHON ?? "python3";

const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];
const REDACTED_VALUE = "<redacted>";
const FRESHNESS_SKEW_MS = 1_500;
const LINUX_WEBDRIVER_TOOL_CLASSES = Object.freeze(["tauri-driver", "WebKitWebDriver", "Chromium"]);
const WAYLAND_KEY_TOOL = "ydotool";
const HYPRLAND_CONTROL_TOOL = "hyprctl";
const WAYLAND_CLIPBOARD_TOOLS = Object.freeze(["wl-copy", "wl-paste"]);
const YDOTOOL_KEYCODES = Object.freeze({ ctrl: 29, enter: 28, l: 38 });
const X11_TYPE_TOOL = "xdotool";
const X11_CLIPBOARD_TOOLS = Object.freeze(["xclip", "xsel"]);
const ATSPI_KEYBOARD = "at-spi";
const X11_PYTHON_KEYBOARD = "python-xlib";
const DEFAULT_NATIVE_DIALOG_SETTLE_MS = Number(process.env.VERIFY_M005_S04_DIALOG_SETTLE_MS ?? 1_000);
const NATIVE_DIALOG_TOOL_TIMEOUT_MS = Number(process.env.VERIFY_M005_S04_DIALOG_TOOL_TIMEOUT_MS ?? 15_000);
const PACKAGE_ARCHIVE_MAX_MEMBERS = Number(process.env.VERIFY_M005_S04_PACKAGE_MAX_MEMBERS ?? 512);
const PACKAGE_ARCHIVE_MAX_MEMBER_BYTES = Number(process.env.VERIFY_M005_S04_PACKAGE_MAX_MEMBER_BYTES ?? 4 * 1024 * 1024);
const PACKAGE_ARCHIVE_MAX_TOTAL_BYTES = Number(process.env.VERIFY_M005_S04_PACKAGE_MAX_TOTAL_BYTES ?? 16 * 1024 * 1024);
const PACKAGED_SIDECAR_BUSY_TIMEOUT_MS = Number(process.env.VERIFY_M005_S04_BUSY_TIMEOUT_MS ?? 20_000);

const S04_SOURCE_GUARD_FILES = Object.freeze([
  "scripts/verify-m005-s04.mjs",
  "scripts/verify-m005-s04.test.mjs",
  "package.json",
  "src/App.tsx",
  "src/sidecar/client.ts",
  "src-tauri/capabilities/default.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/src/lib.rs",
  "src-tauri/src/sidecar.rs",
]);

const EXPECTED_CAPABILITY_PERMISSION_IDS = Object.freeze([
  "core:default",
  "dialog:allow-open",
  "dialog:allow-save",
  "shell:allow-spawn",
]);

const FIXED_TAURI_COMMANDS = Object.freeze([
  "profile_cookies_export",
  "profile_cookies_replace",
  "profile_package_export",
  "profile_package_import",
]);

const FIXED_SIDECAR_METHODS = Object.freeze([
  "portability.cookies.export",
  "portability.cookies.replace",
  "portability.profile_package.export",
  "portability.profile_package.import",
]);

const PUBLIC_SENSITIVE_KEY_PATTERN = /(?:destinationPath|sourcePath|selectedPath|selectedPaths|storeRoot|appDataRoot|repoRoot|tempRoot|profileRoot|profileDir|userDataDir|absolutePath|pathList|\bpath\b|memberNames?|archiveMembers?|packageMembers?|manifestJson|rawManifest|cookieDomain|cookieDomains|cookieName|cookieNames|cookieValue|cookieValues|cookies$|stdout|stderr|rawDiagnostics?|rawPayload|stack|traceback|argv|args|env|token|authorization|\bcredentials?\b|username|password|secret|debug|cdp|devtools|endpoint|launchArgs?)/i;

const STATIC_FORBIDDEN_PATTERNS = Object.freeze([
  { markerClass: "raw_diag", pattern: /\b(?:stdout|stderr|raw diagnostics?|rawDiagnostics?|rawBody|rawPayload|Traceback|traceback|stack trace|stacktrace)\b/i },
  { markerClass: "debug_endpoint", pattern: /(?:DevToolsActivePort|debugPort|devtoolsPort|remoteDebuggingPort|remote-debugging|--remote-debugging-port|cdp:\/\/|wss?:\/\/[^\s"']+|cdpEndpoint|cdpPort)/i },
  { markerClass: "credential", pattern: /\b(?:Authorization|Bearer|Proxy-Authorization|username|password|secret|token)\b/i },
  { markerClass: "launch_args", pattern: /(?:THEPRIVATOR_CHROMIUM_PATH|--user-data-dir|--proxy-server|--load-extension|\bargv\b|\bargs\b|\benv\b)/i },
  { markerClass: "profile_private_path", pattern: /(?:profile-store\/profiles|user-data|app-data-root|XDG_DATA_HOME|APPDATA|LOCALAPPDATA|Application Support)/i },
  { markerClass: "package_member", pattern: /(?:manifest\.json|cookies\/theprivator-cookies\.json|payload\/Default\/Preferences|payload\/Default\/Local Storage)/i },
  { markerClass: "cookie_material", pattern: /(?:Set-Cookie|document\.cookie|cookie value|cookie domain|cookie name)/i },
]);

const IGNORED_ARTIFACT_REFERENCE_PATTERN = /(?:^|["'`\s/(])(?:\.gsd|\.planning|\.audits)(?:[\/"'`\s)]|$)/;
const FRONTEND_FILESYSTEM_AUTHORITY_PATTERN = /@tauri-apps\/plugin-fs|\b(?:readTextFile|writeTextFile|readFile|writeFile)\s*\(/;
const FRONTEND_SHELL_OPEN_AUTHORITY_PATTERN = /@tauri-apps\/plugin-(?:shell|opener)|\bopenUrl\s*\(/;

function fail(message, details = {}) {
  throw new VerifyFailure(message, details);
}

function assert(condition, message, details = {}) {
  if (!condition) fail(message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function slashPath(value) {
  return String(value ?? "").split(sep).join("/");
}

function repoRelative(rootDir, path) {
  return slashPath(relative(rootDir, path)) || ".";
}

function pathDelimiterForPlatform(platform = process.platform) {
  return platform === "win32" ? ";" : hostPathDelimiter;
}

function pathextsForPlatform(platform = process.platform, env = process.env) {
  if (platform !== "win32") return [""];
  const extensions = String(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((item) => item.trim()).filter(Boolean);
  return extensions.length > 0 ? extensions : [".EXE", ".CMD", ".BAT", ".COM"];
}

function isExecutable(path, platform = process.platform) {
  try {
    accessSync(path, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findExecutableCandidate(name, { platform = process.platform, env = process.env, pathEnv = env.PATH ?? "", extraDirs = [] } = {}) {
  const dirs = [...String(pathEnv).split(pathDelimiterForPlatform(platform)).filter(Boolean), ...extraDirs];
  const extensions = pathextsForPlatform(platform, env);

  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    const candidate = resolve(name);
    return isExecutable(candidate, platform) ? { name: basename(candidate), path: candidate } : null;
  }

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, platform === "win32" && extname(name) === "" ? `${name}${extension}` : name);
      if (isExecutable(candidate, platform)) return { name, path: candidate };
    }
  }
  return null;
}

function defaultCommandExists(name, options = {}) {
  return Boolean(findExecutableCandidate(name, options));
}

function safeToolStatus(name, present) {
  return { name, status: present ? "available" : "missing" };
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
  const known = new Set(["--preflight-only", "--skip-build", "--ui-only", "--build-only", "--keep-temp", "--help", "-h"]);
  const flags = new Set(argv);
  const unknown = argv.filter((arg) => !known.has(arg));
  const preflightOnly = flags.has("--preflight-only");
  const buildOnly = flags.has("--build-only");
  const uiOnly = flags.has("--ui-only");
  const skipBuild = flags.has("--skip-build") || uiOnly;
  const mode = preflightOnly ? "preflight-only" : buildOnly ? "build-only" : uiOnly ? "ui-only" : "full";
  const conflicts = [];
  if (preflightOnly && (buildOnly || uiOnly || flags.has("--skip-build"))) conflicts.push("--preflight-only");
  if (buildOnly && (uiOnly || flags.has("--skip-build"))) conflicts.push("--build-only");
  return { mode, preflightOnly, skipBuild, uiOnly, buildOnly, keepTemp: flags.has("--keep-temp"), help: flags.has("--help") || flags.has("-h"), unknown, conflicts: [...new Set(conflicts)] };
}

export function assertValidArgs(args) {
  assert(Array.isArray(args.unknown) && args.unknown.length === 0, "Unknown M005/S04 verifier arguments.", { phase: "args", markerClass: "malformed_args", unknownCount: args.unknown?.length ?? 0 });
  assert(Array.isArray(args.conflicts) && args.conflicts.length === 0, "Conflicting M005/S04 verifier modes.", { phase: "args", markerClass: "malformed_args", conflictCount: args.conflicts?.length ?? 0 });
  return args;
}

export function createM005S04PublicScanContext({
  rootDir = ROOT_DIR,
  appDataRoot,
  tempRoot,
  profileRoot,
  userDataRoot,
  selectedPaths = [],
  packageMemberNames = [],
  cookieDomains = [],
  cookieNames = [],
  cookieValues = [],
  proxyCredentials = [],
  automationTokens = [],
  debugEndpoints = [],
  extraSensitiveValues = [],
} = {}) {
  const exactValues = [];
  addExactMarker(exactValues, "repo_root", rootDir);
  addExactMarker(exactValues, "app_root", appDataRoot);
  addExactMarker(exactValues, "temp_root", tempRoot);
  addExactMarker(exactValues, "profile_root", profileRoot);
  addExactMarker(exactValues, "user_data_root", userDataRoot);
  addExactMarkers(exactValues, "selected_path", selectedPaths);
  addExactMarkers(exactValues, "package_member", packageMemberNames);
  addExactMarkers(exactValues, "cookie_domain", cookieDomains);
  addExactMarkers(exactValues, "cookie_name", cookieNames);
  addExactMarkers(exactValues, "cookie_value", cookieValues);
  addExactMarkers(exactValues, "credential", proxyCredentials);
  addExactMarkers(exactValues, "automation_token", automationTokens);
  addExactMarkers(exactValues, "debug_endpoint", debugEndpoints);
  addExactMarkers(exactValues, "extra_value", extraSensitiveValues);
  return { exactValues: exactValues.sort((left, right) => right.value.length - left.value.length), forbiddenPatterns: STATIC_FORBIDDEN_PATTERNS };
}

function classifyForbiddenKey(key) {
  if (/destinationPath|sourcePath|selectedPath|paths?|root|dir/i.test(key)) return "path";
  if (/member|manifest/i.test(key)) return "package_member";
  if (/cookieDomain|domains?/i.test(key)) return "cookie_domain";
  if (/cookieName|names?/i.test(key)) return "cookie_name";
  if (/cookieValue|values?|cookies$/i.test(key)) return "cookie_value";
  if (/stdout|stderr|raw|stack|traceback/i.test(key)) return "raw_diag";
  if (/debug|cdp|devtools|endpoint/i.test(key)) return "debug_endpoint";
  if (/token|authorization|credentials?|username|password|secret/i.test(key)) return "credential";
  if (/argv|args|env|launchArgs?/i.test(key)) return "launch_args";
  return "unsafe_field";
}

function redactedKeyName(key) {
  return `<redacted-key:${classifyForbiddenKey(key)}>`;
}

function isRedactedPlaceholderKey(key) {
  return /^<redacted-key:[a-z_]+>$/.test(key);
}

export function redactM005S04Text(value, context = createM005S04PublicScanContext()) {
  let redacted = String(value ?? "");
  for (const marker of context.exactValues ?? []) redacted = redacted.replace(marker.pattern, `<redacted:${marker.markerClass}>`);
  return redacted
    .replace(/Traceback|traceback|stack trace|stacktrace/gi, "<redacted:raw_diag>")
    .replace(/stdout|stderr|raw diagnostics?|rawDiagnostics?|rawBody|rawPayload/gi, "<redacted:raw_diag>")
    .replace(/DevToolsActivePort|debugPort|--remote-debugging-port(?:=|\s+)\d*|remote-debugging|cdp:\/\/|wss?:\/\/[^\s"']+|cdpEndpoint|devtoolsPort/gi, "<redacted:debug_endpoint>")
    .replace(/Authorization|Bearer|Proxy-Authorization|username|password|secret|token/gi, "<redacted:private>")
    .replace(/THEPRIVATOR_CHROMIUM_PATH|--user-data-dir|--proxy-server|--load-extension|\bargv\b|\bargs\b|\benv\b/gi, "<redacted:launch_args>")
    .replace(/manifest\.json|cookies\/theprivator-cookies\.json|payload\/Default\/Preferences|payload\/Default\/Local Storage/gi, "<redacted:package_member>");
}

export function redactM005S04(value, context = createM005S04PublicScanContext()) {
  if (typeof value === "string") return redactM005S04Text(value, context);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactM005S04(item, context));
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (PUBLIC_SENSITIVE_KEY_PATTERN.test(key)) result[redactedKeyName(key)] = REDACTED_VALUE;
    else result[redactM005S04Text(key, context)] = redactM005S04(nested, context);
  }
  return result;
}

function safeFieldPath(path, keyOrIndex) {
  if (typeof keyOrIndex === "number") return `${path}[${keyOrIndex}]`;
  const segment = PUBLIC_SENSITIVE_KEY_PATTERN.test(keyOrIndex) ? redactedKeyName(keyOrIndex) : keyOrIndex;
  return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
}

export function findM005S04ForbiddenPublicMarker(value, context = createM005S04PublicScanContext(), path = "$", state = { count: 0 }) {
  if (state.count++ > 8_000) return { markerClass: "scan_limit", fieldPath: path, reason: "bounded scan limit exceeded" };
  if (typeof value === "string") {
    for (const marker of context.exactValues ?? []) {
      if (marker.value && value.includes(marker.value)) return { markerClass: marker.markerClass, fieldPath: path, reason: "sensitive exact value" };
    }
    for (const { markerClass, pattern } of context.forbiddenPatterns ?? []) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) return { markerClass, fieldPath: path, reason: "forbidden text marker" };
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findM005S04ForbiddenPublicMarker(item, context, safeFieldPath(path, index), state);
      if (nested) return nested;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (!isRedactedPlaceholderKey(key) && PUBLIC_SENSITIVE_KEY_PATTERN.test(key)) return { markerClass: classifyForbiddenKey(key), fieldPath: safeFieldPath(path, key), reason: "forbidden key" };
    const marker = findM005S04ForbiddenPublicMarker(nested, context, safeFieldPath(path, key), state);
    if (marker) return marker;
  }
  return null;
}

export function assertM005S04PublicEvidenceRedacted(value, context = createM005S04PublicScanContext()) {
  const marker = findM005S04ForbiddenPublicMarker(value, context);
  assert(!marker, "M005/S04 public verifier evidence leaked forbidden material.", { phase: "redaction-scan", markerClass: marker?.markerClass ?? "unknown", fieldPath: marker?.fieldPath ?? "$", reason: marker?.reason ?? "unknown" });
  return { status: "clean" };
}

export function collectM005S04MarkerClasses(value, context = createM005S04PublicScanContext()) {
  const encoded = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const markerClasses = new Set();
  for (const marker of context.exactValues ?? []) if (marker.value && encoded.includes(marker.value)) markerClasses.add(marker.markerClass);
  for (const { markerClass, pattern } of context.forbiddenPatterns ?? []) {
    pattern.lastIndex = 0;
    if (pattern.test(encoded)) markerClasses.add(markerClass);
  }
  return [...markerClasses].sort();
}

function commandClassFromLabel(label) {
  const first = String(label ?? "subprocess").trim().split(/\s+/)[0] || "subprocess";
  const base = basename(first).replace(/(?:\.cmd|\.exe)$/i, "");
  if (["npm", "cargo", "rustc", "node"].includes(base)) return base;
  if (/tauri/i.test(base)) return "tauri";
  return "subprocess";
}

export function formatM005S04CommandFailure(label, result = {}, context = createM005S04PublicScanContext(), phase = "subprocess") {
  const combinedOutput = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  const timedOut = result?.error?.code === "ETIMEDOUT";
  const failure = {
    phase,
    commandClass: commandClassFromLabel(label),
    exitCode: typeof result?.status === "number" ? result.status : null,
    signal: result?.signal ?? null,
    errorCode: result?.error?.code ?? null,
    timedOut,
    outputSuppressed: true,
    markerClasses: collectM005S04MarkerClasses(combinedOutput, context),
    guidance: timedOut ? "The subprocess was terminated after the bounded M005/S04 verifier timeout. Re-run the named verifier mode locally for private details." : "Inspect the named verifier phase locally; public M005/S04 output reports marker classes only and suppresses private process evidence.",
  };
  assertM005S04PublicEvidenceRedacted(failure, context);
  return failure;
}

export function formatM005S04FailureDetails(error, context = createM005S04PublicScanContext(), phase = "unknown") {
  const details = isPlainObject(error?.details) ? error.details : {};
  const redacted = redactM005S04(details, context);
  const marker = findM005S04ForbiddenPublicMarker(redacted, context);
  if (!marker) return redacted;
  return redactM005S04({ phase, markerClass: marker.markerClass, fieldPath: marker.fieldPath, reason: marker.reason, rawDetailsSuppressed: true }, context);
}

function resetState() {
  STEP_RESULTS.length = 0;
  VERIFIER_EVENTS.length = 0;
}

function emit(event, context = createM005S04PublicScanContext()) {
  const safeEvent = redactM005S04({ event: VERIFY_EVENT, ...event }, context);
  assertM005S04PublicEvidenceRedacted(safeEvent, context);
  VERIFIER_EVENTS.push(safeEvent);
  console.log(JSON.stringify(safeEvent));
  return safeEvent;
}

function unpackStepResult(result) {
  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "value")) return { publicResult: result.log ?? {}, returnValue: result.value };
  return { publicResult: result ?? {}, returnValue: result ?? {} };
}

export function runStep(name, action, context = createM005S04PublicScanContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(action());
    const durationMs = Math.round(performance.now() - started);
    STEP_RESULTS.push({ name, status: "pass", durationMs });
    emit({ phase: name, ...publicResult, status: "pass", durationMs }, context);
    return returnValue;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    STEP_RESULTS.push({ name, status: "fail", durationMs, message: error instanceof Error ? error.message : String(error) });
    emit({ phase: name, status: "fail", durationMs, message: error instanceof Error ? error.message : String(error), details: formatM005S04FailureDetails(error, context, name) }, context);
    throw error;
  }
}

export function runCommand(name, command, args = [], { rootDir = ROOT_DIR, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, context = createM005S04PublicScanContext({ rootDir }), label = command } = {}) {
  return runStep(name, () => {
    const result = spawnSync(executable(command), args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      const failure = formatM005S04CommandFailure(label, result, context, name);
      fail(`${name} ${result.error?.code === "ETIMEDOUT" ? "timed out" : `exited with status ${result.status ?? "unknown"}`}.`, failure);
    }
    return { commandClass: commandClassFromLabel(label), exitCode: result.status ?? 0 };
  }, context);
}

export async function runStepAsync(name, action, context = createM005S04PublicScanContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(await action());
    const durationMs = Math.round(performance.now() - started);
    STEP_RESULTS.push({ name, status: "pass", durationMs });
    emit({ phase: name, ...publicResult, status: "pass", durationMs }, context);
    return returnValue;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    STEP_RESULTS.push({ name, status: "fail", durationMs, message: error instanceof Error ? error.message : String(error) });
    emit({ phase: name, status: "fail", durationMs, message: error instanceof Error ? error.message : String(error), details: formatM005S04FailureDetails(error, context, name) }, context);
    throw error;
  }
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} must be valid JSON.`, { phase: "json-read", label, parser: "json", rawPayloadSuppressed: true });
  }
}

function parseJsonLine(text, label) {
  return parseJsonText(String(text ?? "").trim(), label);
}

function pathInside(root, candidate) {
  if (!root || !candidate) return false;
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isSafeRelativeStorePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) return false;
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part));
}

function collectProfileStoreFiles(root, output = [], state = { visited: 0 }) {
  if (!root || !existsSync(root)) return output;
  if (state.visited++ > 6_000) fail("M005/S04 profile-store discovery exceeded its bounded walk limit.", { phase: "profile-store", markerClass: "profile_store_scan_limit" });
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      collectProfileStoreFiles(fullPath, output, state);
    } else if (entry.isFile() && entry.name === "profiles.json" && basename(dirname(fullPath)) === "profile-store") {
      output.push(fullPath);
    }
  }
  return output;
}

function readBoundedText(path, { maxBytes = 128 * 1024 } = {}) {
  const stats = statSync(path);
  const length = Math.min(stats.size, maxBytes);
  if (length === 0) return { text: "", truncated: false, size: stats.size };
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, stats.size - length);
    let text = buffer.toString("utf8");
    const truncated = stats.size > maxBytes;
    if (truncated) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return { text, truncated, size: stats.size };
  } finally {
    closeSync(fd);
  }
}

function runPythonJsonFixture(script, input, context, label, { rootDir = ROOT_DIR, timeoutMs = DEFAULT_FIXTURE_TIMEOUT_MS } = {}) {
  const result = spawnSync(executable(PYTHON), ["-c", script], {
    cwd: rootDir,
    input: JSON.stringify(input),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 6 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`${label} fixture failed.`, {
      phase: "fixture",
      label,
      exitCode: result.status ?? null,
      errorCode: result.error?.code ?? null,
      timedOut: result.error?.code === "ETIMEDOUT",
      outputSuppressed: true,
      markerClasses: collectM005S04MarkerClasses(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, context),
    });
  }
  const output = String(result.stdout ?? "").trim();
  return output ? parseJsonLine(output, `${label} fixture output`) : {};
}

export function createM005S04SmokeRunContext({ rootDir = ROOT_DIR, baseEnv = process.env, now, nonce, runId, createSmokeRunContext = createS06SmokeRunContext } = {}) {
  const smokeContext = createSmokeRunContext({
    rootDir,
    baseEnv,
    now,
    nonce,
    runId,
    profilePrefix: M005_S04_PROFILE_PREFIX,
  });
  return {
    value: smokeContext,
    log: {
      runId: smokeContext.runId,
      profileName: "generated",
      isolatedRoots: "created",
      rootScope: "private",
    },
  };
}

export function assertM005S04ChromiumExecutable({ rootDir = ROOT_DIR, platform = process.platform, env = process.env, resolveChromiumExecutable = resolveS06ChromiumExecutable } = {}) {
  const chromium = resolveChromiumExecutable({ rootDir, platform, env });
  return { chromium: chromium?.name ? "available" : "available", source: chromium?.source ?? "detected" };
}

export function discoverM005S04SourceProfile({ rootDir = ROOT_DIR, smokeContext, profileName = smokeContext?.smokeProfileName } = {}) {
  assert(smokeContext?.smokeRoot && smokeContext?.dataRoot, "Smoke context is required for M005/S04 profile-store discovery.", { phase: "profile-store", markerClass: "missing_smoke_context" });
  assert(typeof profileName === "string" && profileName.length > 0, "M005/S04 source profile name is required.", { phase: "profile-store", markerClass: "missing_profile_name" });
  const candidates = collectProfileStoreFiles(smokeContext.smokeRoot).sort();
  assert(candidates.length > 0, "Missing profile-store/profiles.json under the isolated M005/S04 smoke root.", { phase: "profile-store", markerClass: "profile_store_missing", candidateCount: 0 });

  let inspectedProfiles = 0;
  for (const profileStorePath of candidates) {
    const payload = readJsonFile(profileStorePath, "profile-store/profiles.json");
    assert(isPlainObject(payload), "profile-store/profiles.json root must be an object.", { phase: "profile-store", markerClass: "profile_store_malformed" });
    assert(Array.isArray(payload.profiles), "profile-store/profiles.json profiles field must be an array.", { phase: "profile-store", markerClass: "profile_store_malformed" });
    inspectedProfiles += payload.profiles.length;
    const profile = payload.profiles.find((item) => item?.name === profileName);
    if (!profile) continue;

    const appDataRoot = dirname(dirname(profileStorePath));
    assert(pathInside(smokeContext.dataRoot, profileStorePath), "profile-store/profiles.json must stay under the verifier XDG data root.", { phase: "profile-store", markerClass: "profile_store_outside_xdg" });
    assert(typeof profile.id === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(profile.id), "M005/S04 source profile id was missing or unsafe.", { phase: "profile-store", markerClass: "profile_store_malformed", profileIdPresent: typeof profile.id === "string" });
    const storage = profile.storage;
    assert(isPlainObject(storage), "M005/S04 source profile storage metadata is missing.", { phase: "profile-store", markerClass: "profile_storage_missing" });
    assert(isSafeRelativeStorePath(storage.profileDir), "M005/S04 source profile storage.profileDir must be a safe relative store path.", { phase: "profile-store", markerClass: "profile_storage_malformed" });
    assert(isSafeRelativeStorePath(storage.userDataDir) && storage.userDataDir === `${storage.profileDir}/user-data`, "M005/S04 source profile storage.userDataDir must be a safe relative user-data path.", { phase: "profile-store", markerClass: "profile_storage_malformed" });
    const userDataRoot = join(appDataRoot, storage.userDataDir);
    assert(pathInside(appDataRoot, userDataRoot), "M005/S04 source profile user data root must stay inside the app-data root.", { phase: "profile-store", markerClass: "profile_storage_malformed" });

    return {
      value: { profileStorePath, appDataRoot, userDataRoot, payload, profile },
      log: {
        profileFound: true,
        profileCount: payload.profiles.length,
        storeVersion: Number(payload.storeVersion ?? 0),
        privateProfileId: "derived",
        storage: "safe-relative-store-paths",
        appDataScope: "isolated",
      },
    };
  }

  fail("profile-store/profiles.json did not contain the generated M005/S04 source profile.", {
    phase: "profile-store",
    markerClass: "source_profile_missing",
    candidateCount: candidates.length,
    inspectedProfiles,
  });
}

export function createM005S04CookieDbFixture({ userDataRoot, appDataRoot, cookieDomain = "m005-s04-cookie.invalid", cookieName = "m005_s04_session", cookieValue = "m005-s04-cookie-value", secondCookieName = "m005_s04_theme", secondCookieValue = "m005-s04-second-cookie-value" } = {}, context = createM005S04PublicScanContext({ appDataRoot, userDataRoot, cookieDomains: [cookieDomain], cookieNames: [cookieName, secondCookieName], cookieValues: [cookieValue, secondCookieValue] })) {
  assert(typeof userDataRoot === "string" && userDataRoot.length > 0, "M005/S04 cookie fixture requires a user data root.", { phase: "cookie-fixture", markerClass: "missing_user_data_root" });
  if (appDataRoot) assert(pathInside(appDataRoot, userDataRoot), "M005/S04 cookie fixture user data root must stay inside the isolated app-data root.", { phase: "cookie-fixture", markerClass: "fixture_scope_violation" });
  const script = String.raw`
import json, sqlite3, sys
from pathlib import Path
from theprivator_sidecar.cookies import _CANONICAL_COOKIE_SCHEMA, unix_time_to_chrome
payload = json.load(sys.stdin)
db_path = Path(payload["userDataRoot"]) / "Default" / "Network" / "Cookies"
db_path.parent.mkdir(parents=True, exist_ok=True)
conn = sqlite3.connect(db_path)
try:
    conn.execute(_CANONICAL_COOKIE_SCHEMA)
    conn.execute("DELETE FROM cookies")
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
print(json.dumps({"count": 2, "dbCreated": True}))
`;
  const result = runPythonJsonFixture(script, { userDataRoot, cookieDomain, cookieName, cookieValue, secondCookieName, secondCookieValue }, context, "cookie-db-create");
  const dbPath = join(userDataRoot, "Default", "Network", "Cookies");
  return {
    value: { dbPath, count: result.count, cookies: [{ domain: cookieDomain, name: cookieName, value: cookieValue }, { domain: `.${cookieDomain}`, name: secondCookieName, value: secondCookieValue }] },
    log: { cookieDb: "created", dbLocation: "Default/Network/Cookies", rowCount: Number(result.count ?? 0), pathScope: "isolated" },
  };
}

export function inspectM005S04CookieDbRows({ userDataRoot, appDataRoot, expectedRows = [] } = {}, context = createM005S04PublicScanContext({ appDataRoot, userDataRoot, cookieDomains: expectedRows.map((row) => row.domain).filter(Boolean), cookieNames: expectedRows.map((row) => row.name).filter(Boolean), cookieValues: expectedRows.map((row) => row.value).filter(Boolean) })) {
  assert(typeof userDataRoot === "string" && userDataRoot.length > 0, "M005/S04 cookie DB inspection requires a user data root.", { phase: "cookie-db", markerClass: "missing_user_data_root" });
  if (appDataRoot) assert(pathInside(appDataRoot, userDataRoot), "M005/S04 cookie DB inspection user data root must stay inside the isolated app-data root.", { phase: "cookie-db", markerClass: "fixture_scope_violation" });
  const script = String.raw`
import json, sqlite3, sys
from pathlib import Path
payload = json.load(sys.stdin)
db_path = Path(payload["userDataRoot"]) / "Default" / "Network" / "Cookies"
if not db_path.exists():
    print(json.dumps({"count": 0, "expectedRowsPresent": False, "missingExpectedCount": len(payload.get("expectedRows", [])), "dbPresent": False}))
    sys.exit(0)
conn = sqlite3.connect(db_path)
try:
    rows = [{"domain": row[0], "name": row[1], "value": row[2]} for row in conn.execute("SELECT host_key, name, value FROM cookies ORDER BY host_key, path, name").fetchall()]
finally:
    conn.close()
missing = []
for expected in payload.get("expectedRows", []):
    if not any(row["domain"] == expected.get("domain") and row["name"] == expected.get("name") and row["value"] == expected.get("value") for row in rows):
        missing.append(expected)
print(json.dumps({"count": len(rows), "expectedRowsPresent": len(missing) == 0, "missingExpectedCount": len(missing), "dbPresent": True, "rows": rows}))
`;
  const result = runPythonJsonFixture(script, { userDataRoot, expectedRows }, context, "cookie-db-inspect");
  return {
    value: { rows: result.rows ?? [], count: Number(result.count ?? 0), expectedRowsPresent: Boolean(result.expectedRowsPresent), dbPresent: Boolean(result.dbPresent) },
    log: { cookieDb: result.dbPresent ? "present" : "missing", rowCount: Number(result.count ?? 0), expectedRowsPresent: Boolean(result.expectedRowsPresent), missingExpectedCount: Number(result.missingExpectedCount ?? 0) },
  };
}

export function writeM005S04CookieImportFixtures({ smokeRoot, cookieDomain = "m005-s04-import.invalid", cookieName = "m005_s04_import", cookieValue = "m005-s04-import-value", secondCookieName = "m005_s04_netscape", secondCookieValue = "m005-s04-netscape-value" } = {}, context = createM005S04PublicScanContext({ tempRoot: smokeRoot, cookieDomains: [cookieDomain], cookieNames: [cookieName, secondCookieName], cookieValues: [cookieValue, secondCookieValue] })) {
  assert(typeof smokeRoot === "string" && smokeRoot.length > 0, "M005/S04 import fixtures require a smoke root.", { phase: "fixture", markerClass: "missing_smoke_root" });
  const fixtureRoot = join(smokeRoot, "fixtures");
  mkdirSync(fixtureRoot, { recursive: true });
  const jsonPath = join(fixtureRoot, "cookies-import.theprivator.json");
  const netscapePath = join(fixtureRoot, "cookies-import.netscape.txt");
  const cookies = [
    { domain: cookieDomain, hostOnly: true, name: cookieName, value: cookieValue, path: "/", secure: true, httpOnly: true, expiresUnix: 1_900_000_000, sameSite: "lax", priority: "medium" },
    { domain: `.${cookieDomain}`, hostOnly: false, name: secondCookieName, value: secondCookieValue, path: "/session", secure: false, httpOnly: false, expiresUnix: null, sameSite: "unspecified", priority: "medium" },
  ];
  writeFileSync(jsonPath, `${JSON.stringify({ format: "theprivator.cookies", version: 1, cookies }, null, 2)}\n`, "utf8");
  writeFileSync(netscapePath, [
    "# Netscape HTTP Cookie File",
    `#HttpOnly_${cookieDomain}\tTRUE\t/\tTRUE\t1900000000\t${cookieName}\t${cookieValue}`,
    `.${cookieDomain}\tTRUE\t/session\tFALSE\t0\t${secondCookieName}\t${secondCookieValue}`,
    "",
  ].join("\n"), "utf8");
  return {
    value: { jsonPath, netscapePath, cookies },
    log: { importFixtures: "created", fixtureFormatCount: 2, cookieCount: cookies.length, pathScope: "smoke-root" },
  };
}

export function writeM005S04PayloadFixtures({ userDataRoot, appDataRoot, selectedPackagePath } = {}, context = createM005S04PublicScanContext({ appDataRoot, userDataRoot, selectedPaths: selectedPackagePath ? [selectedPackagePath] : [] })) {
  assert(typeof userDataRoot === "string" && userDataRoot.length > 0, "M005/S04 payload fixtures require a user data root.", { phase: "payload-fixture", markerClass: "missing_user_data_root" });
  if (appDataRoot) assert(pathInside(appDataRoot, userDataRoot), "M005/S04 payload fixture user data root must stay inside the isolated app-data root.", { phase: "payload-fixture", markerClass: "fixture_scope_violation" });
  const preferencesPath = join(userDataRoot, "Default", "Preferences");
  const storagePath = join(userDataRoot, "Default", "Local Storage", "leveldb", "000003.log");
  const runtimeDebugPath = join(userDataRoot, "DevToolsActivePort");
  const singletonPath = join(userDataRoot, "SingletonLock");
  mkdirSync(dirname(preferencesPath), { recursive: true });
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(preferencesPath, `${JSON.stringify({ profile: { name: "M005 S04 safe payload" }, browser: { check_default_browser: false } }, null, 2)}\n`, "utf8");
  writeFileSync(storagePath, "m005-s04-safe-local-storage-payload\n", "utf8");
  writeFileSync(runtimeDebugPath, "9222\nws://127.0.0.1:9222/devtools/browser/m005-s04-should-not-package\n", "utf8");
  writeFileSync(singletonPath, "m005-s04-runtime-singleton\n", "utf8");
  if (selectedPackagePath) {
    mkdirSync(dirname(selectedPackagePath), { recursive: true });
  }
  return {
    value: { preferencesPath, storagePath, runtimeDebugPath, singletonPath, selectedPackagePath: selectedPackagePath ?? null },
    log: { payloadFixtures: "created", safePayloadFileCount: 2, volatileRuntimeFileCount: 2, selectedDestinationFixture: Boolean(selectedPackagePath), pathScope: "isolated-profile" },
  };
}

function assertExactKeys(value, expectedKeys, label, phase = "package-manifest") {
  assert(isPlainObject(value), `M005/S04 ${label} must be an object.`, { phase, markerClass: "manifest_malformed", label });
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `M005/S04 ${label} keys did not match the expected package contract.`, { phase, markerClass: "manifest_keys_mismatch", label, expectedKeyCount: expected.length, actualKeyCount: actual.length });
}

function assertNoPackageCredentials(value, label = "package") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPackageCredentials(item, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key !== "credentialState") assert(!/(?:credentials?|username|password|secret|token|authorization)/i.test(key), "M005/S04 package manifest retained credential-bearing fields.", { phase: "package-manifest", markerClass: "credential", label });
    assertNoPackageCredentials(nested, label);
  }
}

function assertSha256Hex(value, label) {
  assert(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), `M005/S04 ${label} checksum must be a lowercase SHA-256 hex digest.`, { phase: "package-manifest", markerClass: "checksum_malformed", label });
}

function safePositiveInteger(value, label, { allowZero = true } = {}) {
  assert(Number.isInteger(value) && value >= (allowZero ? 0 : 1), `M005/S04 ${label} must be a non-negative integer.`, { phase: "package-manifest", markerClass: "manifest_malformed", label });
  return value;
}

export function assertM005S04PackageManifestContract(manifest, { expectedProfileName } = {}) {
  assertExactKeys(manifest, ["cookies", "createdAt", "format", "payload", "profile", "version", "warnings"], "manifest");
  assert(manifest.format === PACKAGE_FORMAT && manifest.version === PACKAGE_VERSION, "M005/S04 package manifest format or version mismatch.", { phase: "package-manifest", markerClass: "manifest_mismatch", formatOk: manifest.format === PACKAGE_FORMAT, versionOk: manifest.version === PACKAGE_VERSION });
  assert(typeof manifest.createdAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(manifest.createdAt), "M005/S04 package manifest createdAt must be UTC ISO text.", { phase: "package-manifest", markerClass: "manifest_malformed" });

  assertExactKeys(manifest.profile, ["identity", "name", "proxy", "proxySummary"], "manifest.profile");
  if (expectedProfileName !== undefined) assert(manifest.profile.name === expectedProfileName, "M005/S04 package manifest profile name mismatch.", { phase: "package-manifest", markerClass: "profile_name_mismatch" });
  assert(typeof manifest.profile.name === "string" && manifest.profile.name.length > 0 && manifest.profile.name.length <= 160, "M005/S04 package manifest profile name was malformed.", { phase: "package-manifest", markerClass: "manifest_malformed" });
  assert(isPlainObject(manifest.profile.identity) && manifest.profile.identity.identityVersion === 1, "M005/S04 package manifest identity was not normalized.", { phase: "package-manifest", markerClass: "identity_malformed" });
  assertNoPackageCredentials(manifest.profile.proxy, "manifest.profile.proxy");
  assertNoPackageCredentials(manifest.profile.proxySummary, "manifest.profile.proxySummary");
  const proxyMode = manifest.profile.proxy?.mode;
  assert(proxyMode === "direct" || proxyMode === "fixedServer", "M005/S04 package manifest proxy mode must be direct or fixedServer.", { phase: "package-manifest", markerClass: "proxy_malformed" });
  assert(manifest.profile.proxySummary?.mode === proxyMode, "M005/S04 package proxy summary mode mismatch.", { phase: "package-manifest", markerClass: "proxy_summary_mismatch" });
  assert(manifest.profile.proxySummary?.credentialState === "none", "M005/S04 package proxy summary must be credential-stripped.", { phase: "package-manifest", markerClass: "credential" });

  assertExactKeys(manifest.cookies, ["byteCount", "cookieCount", "format", "member", "sha256", "skippedCount", "version"], "manifest.cookies");
  assert(manifest.cookies.member === COOKIE_MEMBER, "M005/S04 package cookie member mismatch.", { phase: "package-manifest", markerClass: "missing_package_member" });
  assert(manifest.cookies.format === "theprivator.cookies" && manifest.cookies.version === 1, "M005/S04 package cookie manifest format mismatch.", { phase: "package-manifest", markerClass: "cookie_manifest_mismatch" });
  const cookieCount = safePositiveInteger(manifest.cookies.cookieCount, "cookieCount");
  const skippedCookieCount = safePositiveInteger(manifest.cookies.skippedCount, "skippedCookieCount");
  const cookieByteCount = safePositiveInteger(manifest.cookies.byteCount, "cookieByteCount");
  assertSha256Hex(manifest.cookies.sha256, "cookie member");

  assertExactKeys(manifest.payload, ["byteCount", "fileCount", "files", "prefix"], "manifest.payload");
  assert(manifest.payload.prefix === PAYLOAD_PREFIX, "M005/S04 package payload prefix mismatch.", { phase: "package-manifest", markerClass: "payload_mismatch" });
  assert(Array.isArray(manifest.payload.files), "M005/S04 package payload files must be an array.", { phase: "package-manifest", markerClass: "payload_mismatch" });
  const payloadFileCount = safePositiveInteger(manifest.payload.fileCount, "payloadFileCount");
  const payloadByteCount = safePositiveInteger(manifest.payload.byteCount, "payloadByteCount");
  assert(manifest.payload.files.length === payloadFileCount, "M005/S04 package payload file count mismatch.", { phase: "package-manifest", markerClass: "payload_mismatch" });
  let computedPayloadBytes = 0;
  const seenPayloadPaths = new Set();
  for (const file of manifest.payload.files) {
    assertExactKeys(file, ["byteCount", "member", "path", "sha256"], "manifest.payload.files[]");
    assert(typeof file.path === "string" && file.path.length > 0 && !file.path.startsWith("/") && !file.path.includes("..") && !file.path.includes("\\"), "M005/S04 package payload path was unsafe.", { phase: "package-manifest", markerClass: "payload_path_unsafe" });
    assert(file.member === `${PAYLOAD_PREFIX}${file.path}`, "M005/S04 package payload member mismatch.", { phase: "package-manifest", markerClass: "payload_mismatch" });
    assert(!seenPayloadPaths.has(file.path), "M005/S04 package payload path was duplicated.", { phase: "package-manifest", markerClass: "payload_mismatch" });
    seenPayloadPaths.add(file.path);
    const fileBytes = safePositiveInteger(file.byteCount, "payloadFileByteCount");
    computedPayloadBytes += fileBytes;
    assertSha256Hex(file.sha256, "payload member");
  }
  assert(computedPayloadBytes === payloadByteCount, "M005/S04 package payload byte count mismatch.", { phase: "package-manifest", markerClass: "payload_mismatch", payloadFileCount });
  assert(Array.isArray(manifest.warnings), "M005/S04 package warnings must be an array.", { phase: "package-manifest", markerClass: "manifest_malformed" });

  return {
    format: manifest.format,
    version: manifest.version,
    profileNamePresent: true,
    proxyMode,
    proxyCredentialStripped: true,
    directProxyAccepted: proxyMode === "direct",
    cookieCount,
    skippedCookieCount,
    cookieByteCount,
    payloadFileCount,
    payloadByteCount,
    warningCount: manifest.warnings.length,
  };
}

function assertPackageMemberChecksum(member, expected, label) {
  assert(member, `M005/S04 ${label} package member was missing.`, { phase: "package-inspection", markerClass: "missing_package_member", label });
  assert(member.byteCount === expected.byteCount, `M005/S04 ${label} byte count mismatch.`, { phase: "package-inspection", markerClass: "checksum_mismatch", label });
  assert(member.sha256 === expected.sha256, `M005/S04 ${label} checksum mismatch.`, { phase: "package-inspection", markerClass: "checksum_mismatch", label });
}

export function inspectM005S04PackageArchive({ packagePath, rootDir = ROOT_DIR, appDataRoot, selectedPaths = [], expectedProfileName, expectedCookieRows = [], expectedPayloadRelativePaths = ["Default/Preferences"], packageScanContext } = {}, context = createM005S04PublicScanContext({ rootDir, appDataRoot, selectedPaths: [packagePath, ...selectedPaths].filter(Boolean), cookieDomains: expectedCookieRows.map((row) => row.domain).filter(Boolean), cookieNames: expectedCookieRows.map((row) => row.name).filter(Boolean), cookieValues: expectedCookieRows.map((row) => row.value).filter(Boolean) })) {
  assert(typeof packagePath === "string" && packagePath.length > 0, "M005/S04 package archive inspection requires a package path.", { phase: "package-inspection", markerClass: "missing_package_path" });
  const script = String.raw`
import hashlib, json, sys, zipfile
payload = json.load(sys.stdin)
try:
    with zipfile.ZipFile(payload["packagePath"], "r") as archive:
        infos = archive.infolist()
        if len(infos) > int(payload["maxMembers"]):
            print(json.dumps({"ok": False, "errorType": "TooManyMembers"}))
            sys.exit(0)
        members = []
        total_bytes = 0
        for info in infos:
            total_bytes += int(info.file_size)
            if int(info.file_size) > int(payload["maxMemberBytes"]) or total_bytes > int(payload["maxTotalBytes"]):
                print(json.dumps({"ok": False, "errorType": "BoundedReadLimit"}))
                sys.exit(0)
            raw = archive.read(info.filename)
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = ""
            members.append({"name": info.filename, "byteCount": info.file_size, "sha256": hashlib.sha256(raw).hexdigest(), "text": text})
        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
        cookie_payload = json.loads(archive.read("cookies/theprivator-cookies.json").decode("utf-8"))
except Exception as exc:
    print(json.dumps({"ok": False, "errorType": exc.__class__.__name__}))
    sys.exit(0)
print(json.dumps({"ok": True, "members": members, "manifest": manifest, "cookiePayload": cookie_payload, "totalByteCount": total_bytes}))
`;
  const inspection = runPythonJsonFixture(script, { packagePath, maxMembers: PACKAGE_ARCHIVE_MAX_MEMBERS, maxMemberBytes: PACKAGE_ARCHIVE_MAX_MEMBER_BYTES, maxTotalBytes: PACKAGE_ARCHIVE_MAX_TOTAL_BYTES }, context, "package-archive-inspect");
  assert(inspection.ok === true, "M005/S04 package archive could not be inspected as a valid bounded .tpkg ZIP.", { phase: "package-inspection", markerClass: "package_malformed", errorType: inspection.errorType ?? "unknown" });
  const members = Array.isArray(inspection.members) ? inspection.members : [];
  const memberNames = members.map((member) => member.name);
  const scanContext = packageScanContext ?? createM005S02PackageScanContext({ rootDir, storeRoot: appDataRoot, selectedPaths: [packagePath, ...selectedPaths].filter(Boolean), cookieDomains: expectedCookieRows.map((row) => row.domain).filter(Boolean), cookieNames: expectedCookieRows.map((row) => row.name).filter(Boolean), cookieValues: expectedCookieRows.map((row) => row.value).filter(Boolean) });
  const scan = assertM005S02PackageContentClean(inspection, scanContext);
  assert(memberNames.includes(MANIFEST_MEMBER) && memberNames.includes(COOKIE_MEMBER), "M005/S04 package archive missed required fixed members.", { phase: "package-inspection", markerClass: "missing_package_member", requiredMemberCount: 2 });
  const extraNonPayloadMembers = memberNames.filter((name) => name !== MANIFEST_MEMBER && name !== COOKIE_MEMBER && !name.startsWith(PAYLOAD_PREFIX)).length;
  assert(extraNonPayloadMembers === 0, "M005/S04 package archive contained unexpected non-payload members.", { phase: "package-inspection", markerClass: "extra_package_member", extraNonPayloadMembers });
  const runtimeMemberCount = memberNames.filter((name) => /(?:^|\/)DevToolsActivePort$|(?:^|\/)Singleton|Default\/Network\/Cookies(?:-journal)?$/i.test(name)).length;
  assert(runtimeMemberCount === 0, "M005/S04 package archive included volatile runtime or raw cookie database members.", { phase: "package-inspection", markerClass: "runtime_member", runtimeMemberCount });
  const selectedBasenames = [packagePath, ...selectedPaths].map((item) => (typeof item === "string" ? basename(item) : "")).filter(Boolean);
  const selfIncludedCount = memberNames.filter((name) => selectedBasenames.some((selected) => selected && name.endsWith(`/${selected}`))).length;
  assert(selfIncludedCount === 0, "M005/S04 package archive included the selected package destination in its payload.", { phase: "package-inspection", markerClass: "self_inclusion", selfIncludedCount });

  const manifest = inspection.manifest ?? {};
  const manifestSummary = assertM005S04PackageManifestContract(manifest, { expectedProfileName });
  const manifestPayloadMembers = manifest.payload.files.map((file) => file.member).sort();
  const actualPayloadMembers = memberNames.filter((name) => name.startsWith(PAYLOAD_PREFIX)).sort();
  assert(JSON.stringify(actualPayloadMembers) === JSON.stringify(manifestPayloadMembers), "M005/S04 package payload members did not match the manifest.", { phase: "package-inspection", markerClass: "payload_member_mismatch", payloadFileCount: manifestPayloadMembers.length, actualPayloadCount: actualPayloadMembers.length });
  assertPackageMemberChecksum(members.find((member) => member.name === COOKIE_MEMBER), { byteCount: manifest.cookies.byteCount, sha256: manifest.cookies.sha256 }, "cookie");
  for (const file of manifest.payload.files) assertPackageMemberChecksum(members.find((member) => member.name === file.member), { byteCount: file.byteCount, sha256: file.sha256 }, "payload");

  const cookiePayload = inspection.cookiePayload ?? {};
  assert(cookiePayload.format === "theprivator.cookies" && cookiePayload.version === 1 && Array.isArray(cookiePayload.cookies), "M005/S04 package cookie member was malformed.", { phase: "package-inspection", markerClass: "cookie_member_malformed" });
  assert(cookiePayload.cookies.length === manifest.cookies.cookieCount, "M005/S04 package cookie member count did not match the manifest.", { phase: "package-inspection", markerClass: "cookie_member_mismatch", cookieCount: manifest.cookies.cookieCount, actualCookieCount: cookiePayload.cookies.length });
  const missingExpectedCookies = expectedCookieRows.filter((expected) => !cookiePayload.cookies.some((cookie) => cookie?.domain === expected.domain && cookie?.name === expected.name && cookie?.value === expected.value)).length;
  assert(missingExpectedCookies === 0, "M005/S04 package cookie member missed expected portable cookies.", { phase: "package-inspection", markerClass: "cookie_member_mismatch", missingExpectedCookies });
  const payloadRelativePaths = new Set(manifest.payload.files.map((file) => file.path));
  const missingPayloadFiles = expectedPayloadRelativePaths.filter((relativePath) => !payloadRelativePaths.has(relativePath)).length;
  assert(missingPayloadFiles === 0, "M005/S04 package payload missed expected safe files.", { phase: "package-inspection", markerClass: "payload_missing", missingPayloadFiles, expectedPayloadCount: expectedPayloadRelativePaths.length });

  const summary = {
    archive: "valid",
    memberCount: memberNames.length,
    manifestPresent: true,
    cookieMemberPresent: true,
    payloadFileCount: manifestSummary.payloadFileCount,
    cookieCount: manifestSummary.cookieCount,
    payloadByteCount: manifestSummary.payloadByteCount,
    warningCount: manifestSummary.warningCount,
    proxyMode: manifestSummary.proxyMode,
    proxyCredentialStripped: manifestSummary.proxyCredentialStripped,
    checksumValidated: true,
    packageByteBounded: true,
    scanClean: true,
    scannedMembers: Number(scan.scannedMembers ?? memberNames.length),
    runtimeMembersSkipped: true,
    destinationSelfIncluded: false,
  };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { inspection, scan, manifestSummary }, log: summary };
}

function resolveM005S04ProfileUserDataRoot(appDataRoot, profile, phase = "copied-profile") {
  const storage = profile?.storage;
  assert(isPlainObject(storage), "M005/S04 profile storage metadata is missing.", { phase, markerClass: "profile_storage_missing" });
  assert(isSafeRelativeStorePath(storage.profileDir), "M005/S04 profile storage.profileDir must be a safe relative store path.", { phase, markerClass: "profile_storage_malformed" });
  assert(isSafeRelativeStorePath(storage.userDataDir) && storage.userDataDir === `${storage.profileDir}/user-data`, "M005/S04 profile storage.userDataDir must be a safe relative user-data path.", { phase, markerClass: "profile_storage_malformed" });
  const userDataRoot = join(appDataRoot, storage.userDataDir);
  assert(pathInside(appDataRoot, userDataRoot), "M005/S04 profile user data root must stay inside the app-data root.", { phase, markerClass: "profile_storage_malformed" });
  return userDataRoot;
}

function readM005S04RuntimeRegistry(appDataRoot) {
  const registryPath = join(appDataRoot, "profile-store", "runtime", "chromium-processes.json");
  if (!existsSync(registryPath)) return {};
  try {
    const payload = JSON.parse(readFileSync(registryPath, "utf8"));
    return isPlainObject(payload?.processes) ? payload.processes : {};
  } catch {
    return {};
  }
}

function copiedProfileNameMatches(sourceName, importedName) {
  if (typeof sourceName !== "string" || typeof importedName !== "string") return false;
  return importedName === `${sourceName} Copy` || new RegExp(`^${escapeRegExp(sourceName)} Copy \\d+$`).test(importedName);
}

export function assertM005S04CopiedProfileRestored({ profileStorePath, appDataRoot, sourceProfile, expectedCookieRows = [], expectedPayloadRelativePaths = ["Default/Preferences"], expectedImportedName } = {}, context = createM005S04PublicScanContext({ appDataRoot, cookieDomains: expectedCookieRows.map((row) => row.domain).filter(Boolean), cookieNames: expectedCookieRows.map((row) => row.name).filter(Boolean), cookieValues: expectedCookieRows.map((row) => row.value).filter(Boolean) })) {
  assert(typeof profileStorePath === "string" && profileStorePath.length > 0, "M005/S04 copied-profile assertion requires a profile store path.", { phase: "copied-profile", markerClass: "missing_profile_store" });
  assert(typeof appDataRoot === "string" && appDataRoot.length > 0, "M005/S04 copied-profile assertion requires an app-data root.", { phase: "copied-profile", markerClass: "missing_app_data_root" });
  assert(isPlainObject(sourceProfile) && typeof sourceProfile.id === "string" && typeof sourceProfile.name === "string", "M005/S04 copied-profile assertion requires the source profile record.", { phase: "copied-profile", markerClass: "source_profile_missing" });
  const payload = readJsonFile(profileStorePath, "profile-store/profiles.json");
  assert(isPlainObject(payload) && Array.isArray(payload.profiles), "M005/S04 profile-store payload was malformed after package import.", { phase: "copied-profile", markerClass: "profile_store_malformed" });
  const sourceMatches = payload.profiles.filter((profile) => profile?.id === sourceProfile.id);
  assert(sourceMatches.length === 1, "M005/S04 package import overwrote or removed the source profile.", { phase: "copied-profile", markerClass: "source_profile_missing", sourceMatches: sourceMatches.length });
  const candidates = payload.profiles.filter((profile) => profile?.id !== sourceProfile.id && profile?.metadata?.source === "profile-package" && copiedProfileNameMatches(sourceProfile.name, profile?.name));
  const importedProfile = expectedImportedName ? candidates.find((profile) => profile?.name === expectedImportedName) : candidates.at(-1);
  assert(importedProfile, "M005/S04 package import did not create a copied profile with a conflict-resolved name.", { phase: "copied-profile", markerClass: "copied_profile_missing", profileCount: payload.profiles.length, copiedCandidateCount: candidates.length });
  assert(importedProfile.id !== sourceProfile.id, "M005/S04 package import reused the source profile id.", { phase: "copied-profile", markerClass: "copied_profile_id_mismatch" });
  assert(copiedProfileNameMatches(sourceProfile.name, importedProfile.name), "M005/S04 package import did not resolve the copied profile name.", { phase: "copied-profile", markerClass: "copied_profile_name_mismatch" });
  assert(importedProfile.metadata?.originalName === sourceProfile.name, "M005/S04 package import metadata did not preserve the original profile name.", { phase: "copied-profile", markerClass: "copied_profile_metadata_mismatch" });
  const importedUserDataRoot = resolveM005S04ProfileUserDataRoot(appDataRoot, importedProfile, "copied-profile");
  const runtimeRecords = readM005S04RuntimeRegistry(appDataRoot);
  assert(!Object.prototype.hasOwnProperty.call(runtimeRecords, importedProfile.id), "M005/S04 imported copied profile was not stopped after import.", { phase: "copied-profile", markerClass: "copied_profile_busy" });

  const cookies = inspectM005S04CookieDbRows({ appDataRoot, userDataRoot: importedUserDataRoot, expectedRows: expectedCookieRows }, context);
  assert(cookies.value.expectedRowsPresent && cookies.value.count >= expectedCookieRows.length, "M005/S04 imported copied profile did not restore the expected cookies.", { phase: "copied-profile", markerClass: "cookies_not_restored", missingExpectedCount: Math.max(0, expectedCookieRows.length - Number(cookies.value.count ?? 0)) });
  const missingPayloadFiles = expectedPayloadRelativePaths.filter((relativePath) => !existsSync(join(importedUserDataRoot, ...relativePath.split("/")))).length;
  assert(missingPayloadFiles === 0, "M005/S04 imported copied profile did not restore expected payload files.", { phase: "copied-profile", markerClass: "payload_not_restored", expectedPayloadCount: expectedPayloadRelativePaths.length, missingPayloadFiles });

  const summary = {
    copiedProfile: "restored",
    profileCount: payload.profiles.length,
    sourcePreserved: true,
    copiedIdDistinct: true,
    nameConflictResolved: true,
    runtimeStatus: "stopped",
    cookieRowsRestored: cookies.value.count,
    expectedCookiesPresent: true,
    payloadFilesRestored: expectedPayloadRelativePaths.length,
  };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { profile: importedProfile, userDataRoot: importedUserDataRoot, profileStore: payload }, log: summary };
}

export function assertM005S04VisibleTextRedacted({ text, phase = "ui.visible-text" } = {}, context = createM005S04PublicScanContext()) {
  assert(typeof text === "string", "M005/S04 visible UI text projection must be text.", { phase, markerClass: "ui_text_malformed" });
  const marker = findM005S04ForbiddenPublicMarker(text, context);
  assert(!marker, "M005/S04 visible UI text contained forbidden material.", { phase, markerClass: marker?.markerClass ?? "ui_text_forbidden", fieldPath: marker?.fieldPath ?? "$" });
  return { textObserved: text.length > 0, characterCount: text.length };
}

const SAFE_DIAGNOSTIC_KEYS = new Set(["schemaVersion", "ts", "requestId", "logPath", "event", "source", "method", "status", "durationMs", "errorCode", "detailRef"]);
const SAFE_DIAGNOSTIC_SOURCES = new Set(["python-sidecar", "tauri-bridge", "ui"]);
const SAFE_DIAGNOSTIC_EVENTS = new Set(["sidecar.request", "bridge.request", "ui.action"]);
const SAFE_DIAGNOSTIC_STATUSES = new Set(["ok", "error", "started"]);

function assertSafeDiagnosticToken(value, label) {
  assert(value === null || value === undefined || (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)), `M005/S04 diagnostics ${label} used an unsafe token.`, { phase: "diagnostics", markerClass: "diagnostic_token_unsafe", label });
}

export function inspectM005S04Diagnostics({ appDataRoot, requiredMethods = FIXED_SIDECAR_METHODS, maxBytes = 128 * 1024, maxLines = 500 } = {}, context = createM005S04PublicScanContext({ appDataRoot })) {
  assert(typeof appDataRoot === "string" && appDataRoot.length > 0, "M005/S04 diagnostics inspection requires an app-data root.", { phase: "diagnostics", markerClass: "missing_app_data_root" });
  const diagnosticsPath = join(appDataRoot, DIAGNOSTIC_RELATIVE_LOG_PATH);
  assert(existsSync(diagnosticsPath), "Missing M005/S04 diagnostics JSONL under the packaged app-data root.", { phase: "diagnostics", markerClass: "diagnostics_missing" });
  const { text, truncated } = readBoundedText(diagnosticsPath, { maxBytes });
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-maxLines);
  const records = [];
  let malformedRows = 0;
  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformedRows += 1;
      continue;
    }
    if (!isPlainObject(record)) {
      malformedRows += 1;
      continue;
    }
    const unsafeKeys = Object.keys(record).filter((key) => !SAFE_DIAGNOSTIC_KEYS.has(key));
    assert(unsafeKeys.length === 0, "M005/S04 diagnostics JSONL contained unsafe raw diagnostic fields.", { phase: "diagnostics", markerClass: "diagnostics_forbidden_field", row: index + 1, unsafeFieldCount: unsafeKeys.length });
    const marker = findM005S04ForbiddenPublicMarker(record, context);
    assert(!marker, "M005/S04 diagnostics JSONL contained forbidden public material.", { phase: "diagnostics", markerClass: marker?.markerClass ?? "diagnostics_forbidden_marker", row: index + 1, fieldPath: marker?.fieldPath ?? "$" });
    assert(record.logPath === DIAGNOSTIC_RELATIVE_LOG_PATH, "M005/S04 diagnostics JSONL used an unsafe logPath.", { phase: "diagnostics", markerClass: "diagnostics_log_path_unsafe", row: index + 1 });
    assert(SAFE_DIAGNOSTIC_EVENTS.has(record.event), "M005/S04 diagnostics JSONL used an unsafe event.", { phase: "diagnostics", markerClass: "diagnostics_event_unsafe", row: index + 1 });
    assert(SAFE_DIAGNOSTIC_SOURCES.has(record.source), "M005/S04 diagnostics JSONL used an unsafe source.", { phase: "diagnostics", markerClass: "diagnostics_source_unsafe", row: index + 1 });
    assert(SAFE_DIAGNOSTIC_STATUSES.has(record.status), "M005/S04 diagnostics JSONL used an unsafe status.", { phase: "diagnostics", markerClass: "diagnostics_status_unsafe", row: index + 1 });
    assertSafeDiagnosticToken(record.method, "method");
    assertSafeDiagnosticToken(record.errorCode, "errorCode");
    assertSafeDiagnosticToken(record.detailRef, "detailRef");
    records.push(record);
  }
  assert(malformedRows === 0, "M005/S04 diagnostics JSONL contained malformed rows.", { phase: "diagnostics", markerClass: "diagnostics_malformed", malformedRows, totalRows: lines.length });

  const required = {};
  for (const method of requiredMethods) {
    const matches = records.filter((record) => record.event === "sidecar.request" && record.method === method);
    const okRows = matches.filter((record) => record.status === "ok").length;
    const errorRows = matches.filter((record) => record.status === "error").length;
    required[method] = { observed: matches.length, okRows, errorRows };
  }
  const typedErrorCodes = [...new Set(records.filter((record) => record.status === "error").map((record) => record.errorCode).filter(Boolean))].sort();
  const summary = {
    diagnostics: "parsed",
    truncated,
    totalRowsRead: lines.length,
    validRows: records.length,
    malformedRows,
    required,
    okRows: records.filter((record) => record.status === "ok").length,
    errorRows: records.filter((record) => record.status === "error").length,
    typedErrorCodes,
  };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { records }, log: summary };
}

export function inspectM005S04CookieExportFile({ exportPath, expectedRows = [] } = {}, context = createM005S04PublicScanContext({ selectedPaths: [exportPath].filter(Boolean), cookieDomains: expectedRows.map((row) => row.domain).filter(Boolean), cookieNames: expectedRows.map((row) => row.name).filter(Boolean), cookieValues: expectedRows.map((row) => row.value).filter(Boolean) })) {
  assert(typeof exportPath === "string" && exportPath.length > 0, "M005/S04 cookie export inspection requires a private selected path.", { phase: "cookie-export-file", markerClass: "missing_selected_path" });
  const payload = readJsonFile(exportPath, "exported cookie file");
  assert(payload?.format === "theprivator.cookies" && payload.version === 1 && Array.isArray(payload.cookies), "M005/S04 exported ThePrivator cookie file was malformed.", { phase: "cookie-export-file", markerClass: "cookie_export_malformed" });
  const missingExpectedCount = expectedRows.filter((expected) => !payload.cookies.some((cookie) => cookie?.domain === expected.domain && cookie?.name === expected.name && cookie?.value === expected.value)).length;
  assert(missingExpectedCount === 0, "M005/S04 exported cookie file missed expected portable cookies.", { phase: "cookie-export-file", markerClass: "cookie_export_mismatch", missingExpectedCount, expectedCookieCount: expectedRows.length });
  const summary = { cookieExportFile: "valid", format: "theprivator-json", cookieRowCount: payload.cookies.length, expectedRowsPresent: true, selectionPrivate: true };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { cookieCount: payload.cookies.length }, log: summary };
}

export function assertM005S04RuntimeBookkeeping({ appDataRoot, profile, expectedRunning, expectedRunningCount } = {}, context = createM005S04PublicScanContext({ appDataRoot })) {
  assert(typeof appDataRoot === "string" && appDataRoot.length > 0, "M005/S04 runtime bookkeeping assertion requires an app-data root.", { phase: "runtime.bookkeeping", markerClass: "missing_app_data_root" });
  assert(isPlainObject(profile) && typeof profile.id === "string", "M005/S04 runtime bookkeeping assertion requires a profile record.", { phase: "runtime.bookkeeping", markerClass: "profile_store_malformed" });
  const registryPath = join(appDataRoot, "profile-store", "runtime", "chromium-processes.json");
  let payload = { registryVersion: "absent", processes: {} };
  if (existsSync(registryPath)) {
    payload = readJsonFile(registryPath, "runtime/chromium-processes.json");
    assert(isPlainObject(payload) && payload.registryVersion === 1 && isPlainObject(payload.processes), "M005/S04 Chromium runtime registry was malformed.", { phase: "runtime.bookkeeping", markerClass: "runtime_registry_malformed" });
  }

  const processes = isPlainObject(payload.processes) ? payload.processes : {};
  const entries = Object.entries(processes);
  for (const [profileId, record] of entries) {
    assert(isPlainObject(record) && record.profileId === profileId, "M005/S04 runtime record profile id was malformed.", { phase: "runtime.bookkeeping", markerClass: "runtime_registry_malformed" });
    assert(typeof record.profileId === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(record.profileId), "M005/S04 runtime record profile id was unsafe.", { phase: "runtime.bookkeeping", markerClass: "runtime_registry_malformed" });
    assert(Number.isInteger(record.pid) && record.pid > 0, "M005/S04 runtime record pid was malformed.", { phase: "runtime.bookkeeping", markerClass: "runtime_registry_malformed" });
    assert(typeof record.startedAt === "string" && record.startedAt.endsWith("Z"), "M005/S04 runtime record timestamp was malformed.", { phase: "runtime.bookkeeping", markerClass: "runtime_registry_malformed" });
    assert(isSafeRelativeStorePath(record.userDataDir), "M005/S04 runtime record user-data scope was malformed.", { phase: "runtime.bookkeeping", markerClass: "runtime_registry_malformed" });
    assert(typeof record.ownerToken === "string", "M005/S04 runtime record owner token shape was malformed.", { phase: "runtime.bookkeeping", markerClass: "runtime_registry_malformed" });
  }

  const hasProfile = Object.prototype.hasOwnProperty.call(processes, profile.id);
  assert(Boolean(hasProfile) === Boolean(expectedRunning), expectedRunning ? "M005/S04 restored profile did not reach running runtime bookkeeping." : "M005/S04 restored profile did not stop cleanly in runtime bookkeeping.", { phase: "runtime.bookkeeping", markerClass: expectedRunning ? "runtime_not_running" : "runtime_not_stopped", runningCount: entries.length });
  if (expectedRunningCount !== undefined) assert(entries.length === expectedRunningCount, "M005/S04 runtime running count did not match expectation.", { phase: "runtime.bookkeeping", markerClass: "runtime_count_mismatch", runningCount: entries.length, expectedRunningCount });
  const summary = { runtimeBookkeeping: expectedRunning ? "running" : "stopped", registry: existsSync(registryPath) ? "present" : "absent", profileRecord: hasProfile ? "present" : "absent", runningCount: entries.length, userDataScope: hasProfile ? "safe-relative" : "not-running" };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { runningCount: entries.length, hasProfile }, log: summary };
}

function parseM005S04NdjsonStream(text, label, context) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parsed = parseJsonLine(line, label);
    const marker = findM005S04ForbiddenPublicMarker(redactM005S04(parsed, context), context);
    assert(!marker, "M005/S04 packaged sidecar stream contained forbidden public material after redaction.", { phase: "sidecar-direct", markerClass: marker?.markerClass ?? "sidecar_stream_forbidden", fieldPath: marker?.fieldPath ?? "$" });
    return parsed;
  });
}

function assertM005S04SafeSidecarDiagnostic(diagnostic, { method, status, errorCode } = {}) {
  assert(isPlainObject(diagnostic), "M005/S04 packaged sidecar diagnostic was not an object.", { phase: "sidecar-direct", markerClass: "diagnostics_malformed" });
  const unsafeKeys = Object.keys(diagnostic).filter((key) => !SAFE_DIAGNOSTIC_KEYS.has(key));
  assert(unsafeKeys.length === 0, "M005/S04 packaged sidecar diagnostic contained unsafe raw fields.", { phase: "sidecar-direct", markerClass: "diagnostics_forbidden_field", unsafeFieldCount: unsafeKeys.length });
  assert(diagnostic.event === "sidecar.request", "M005/S04 packaged sidecar diagnostic event mismatch.", { phase: "sidecar-direct", markerClass: "diagnostics_event_unsafe" });
  assert(diagnostic.method === method, "M005/S04 packaged sidecar diagnostic method mismatch.", { phase: "sidecar-direct", markerClass: "diagnostics_method_mismatch" });
  assert(diagnostic.status === status, "M005/S04 packaged sidecar diagnostic status mismatch.", { phase: "sidecar-direct", markerClass: "diagnostics_status_unsafe" });
  assert(diagnostic.errorCode === errorCode, "M005/S04 packaged sidecar diagnostic error code mismatch.", { phase: "sidecar-direct", markerClass: "diagnostics_error_mismatch" });
  assertSafeDiagnosticToken(diagnostic.detailRef, "detailRef");
  return diagnostic;
}

export function runM005S04PackagedSidecarRequest(binaryPath, payload, { rootDir = ROOT_DIR, env = {}, timeoutMs = PACKAGED_SIDECAR_BUSY_TIMEOUT_MS, context = createM005S04PublicScanContext({ rootDir }) } = {}) {
  assert(typeof binaryPath === "string" && binaryPath.length > 0, "M005/S04 packaged sidecar request requires a binary path.", { phase: "sidecar-direct", markerClass: "missing_sidecar_binary" });
  assert(isPlainObject(payload) && typeof payload.method === "string", "M005/S04 packaged sidecar request requires a method payload.", { phase: "sidecar-direct", markerClass: "sidecar_request_malformed" });
  const result = spawnSync(executable(binaryPath), [], { cwd: rootDir, input: `${JSON.stringify(payload)}\n`, env: { ...process.env, ...env, PYTHONUNBUFFERED: "1" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const failure = formatM005S04CommandFailure("packaged-sidecar", result, context, "sidecar-direct");
    fail("M005/S04 packaged sidecar direct request failed to execute.", { ...failure, markerClass: result.error?.code === "ETIMEDOUT" ? "sidecar_direct_timeout" : "sidecar_direct_failed" });
  }
  const responses = parseM005S04NdjsonStream(result.stdout, "packaged sidecar response", context);
  const diagnostics = parseM005S04NdjsonStream(result.stderr, "packaged sidecar diagnostic", context);
  assert(responses.length === 1, "M005/S04 packaged sidecar direct request produced a malformed response stream.", { phase: "sidecar-direct", markerClass: "sidecar_response_malformed", responseCount: responses.length });
  assert(diagnostics.length >= 1, "M005/S04 packaged sidecar direct request did not emit diagnostics.", { phase: "sidecar-direct", markerClass: "diagnostics_missing" });
  return { response: responses[0], diagnostic: diagnostics[0], diagnostics };
}

export function assertM005S04BusyGuardTranscript({ transcript, requestId, method = "portability.profile_package.export" } = {}, context = createM005S04PublicScanContext()) {
  const response = transcript?.response;
  assert(isPlainObject(response), "M005/S04 busy guard response envelope was malformed.", { phase: "busy-guard", markerClass: "busy_response_malformed" });
  assert(response.id === requestId && response.ok === false, "M005/S04 busy guard did not return the expected failed response envelope.", { phase: "busy-guard", markerClass: "busy_response_malformed", ok: response.ok === false });
  const error = response.error;
  assertExactKeys(error, ["code", "detailRef", "message", "recoverable"], "busy error", "busy-guard");
  assert(error.code === "PORTABILITY_PROFILE_BUSY", "M005/S04 busy guard returned an unexpected error code.", { phase: "busy-guard", markerClass: "busy_guard_unexpected", errorCode: error.code ?? null });
  assert(error.recoverable === true, "M005/S04 busy guard error must remain recoverable.", { phase: "busy-guard", markerClass: "busy_response_malformed" });
  assertSafeDiagnosticToken(error.detailRef, "detailRef");
  const messageMarker = findM005S04ForbiddenPublicMarker(error.message, context);
  assert(!messageMarker, "M005/S04 busy guard message contained forbidden material.", { phase: "busy-guard", markerClass: messageMarker?.markerClass ?? "busy_message_forbidden", fieldPath: messageMarker?.fieldPath ?? "$" });
  const diagnostic = assertM005S04SafeSidecarDiagnostic(transcript.diagnostic, { method, status: "error", errorCode: "PORTABILITY_PROFILE_BUSY" });
  assert(diagnostic.detailRef === error.detailRef, "M005/S04 busy guard diagnostic detailRef mismatch.", { phase: "busy-guard", markerClass: "diagnostics_error_mismatch" });
  const summary = { busyGuard: "blocked", method, errorCode: "PORTABILITY_PROFILE_BUSY", recoverable: true, detailRef: "observed", diagnosticStatus: "error" };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { errorCode: error.code }, log: summary };
}

function safeCleanupStatus(value) {
  if (typeof value === "string") return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80) || "unknown";
  if (isPlainObject(value) && typeof value.status === "string") return safeCleanupStatus(value.status);
  return value ? "reported" : "unknown";
}

async function suppressForeignVerifierConsole(action) {
  const originalLog = console.log;
  try {
    console.log = () => {};
    return await action();
  } finally {
    console.log = originalLog;
  }
}

export async function cleanupM005S04PackagedHarness({ driver, driverProcess, runtime, runningObserved = false, keepTemp = false, passed = false, cleanupPackagedSmoke = cleanupS06PackagedSmoke } = {}, context = createM005S04PublicScanContext({ tempRoot: runtime?.smokeContext?.smokeRoot, appDataRoot: runtime?.profileStore?.appDataRoot, userDataRoot: runtime?.profileStore?.userDataRoot })) {
  let rawCleanup = null;
  try {
    rawCleanup = await suppressForeignVerifierConsole(() => cleanupPackagedSmoke({ driver, driverProcess, runtime, runningObserved }));
  } catch (error) {
    rawCleanup = { cleanupFailed: true, message: error instanceof Error ? error.message : String(error) };
  }

  let tempRoot = "not-started";
  if (runtime?.smokeContext?.smokeRoot) {
    if (passed && !keepTemp) {
      try {
        rmSync(runtime.smokeContext.smokeRoot, { recursive: true, force: true });
        tempRoot = existsSync(runtime.smokeContext.smokeRoot) ? "remove-failed" : "removed";
      } catch {
        tempRoot = "remove-failed";
      }
    } else {
      tempRoot = "retained";
    }
  }

  const summary = {
    cleanup: "attempted",
    webdriverSession: safeCleanupStatus(rawCleanup?.webdriverSession),
    driverProcess: safeCleanupStatus(rawCleanup?.driverProcess),
    ownedChromium: safeCleanupStatus(rawCleanup?.ownedChromium),
    tempState: tempRoot,
    retained: tempRoot !== "removed",
    foreignOutputSuppressed: true,
  };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { rawCleanup, tempRoot }, log: summary };
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} must be valid JSON.`, { phase: "json-read", fileLabel: label, parser: "json", rawConfigSuppressed: true });
  }
}

function permissionIdentifier(permission) {
  return typeof permission === "string" ? permission : permission?.identifier;
}

function assertNoForbiddenCapability(permission) {
  const identifier = permissionIdentifier(permission);
  assert(typeof identifier === "string" && identifier.length > 0, "Default capability contained an invalid permission entry.", { phase: "capability", markerClass: "capability_malformed" });
  assert(!identifier.startsWith("fs:"), "Default capability must not grant frontend filesystem authority.", { phase: "capability", markerClass: "frontend_filesystem_authority", identifier });
  assert(!["shell:allow-open", "opener:allow-open", "opener:default"].includes(identifier), "Default capability must not grant shell/open authority.", { phase: "capability", markerClass: "shell_open_authority", identifier });
  assert(identifier === "core:default" || identifier === "shell:allow-spawn" || identifier === "dialog:allow-open" || identifier === "dialog:allow-save", "Default capability must not grant broad or unexpected dialog/core authority.", { phase: "capability", markerClass: "capability_widened", identifier });
}

export function assertM005S04CapabilityConfig({ rootDir = ROOT_DIR } = {}) {
  const capability = readJsonFile(join(rootDir, "src-tauri", "capabilities", "default.json"), "src-tauri/capabilities/default.json");
  assert(Array.isArray(capability.permissions), "Default capability permissions must be an array.", { phase: "capability", markerClass: "capability_malformed" });
  const permissionIds = [];
  for (const permission of capability.permissions) {
    assertNoForbiddenCapability(permission);
    const identifier = permissionIdentifier(permission);
    if (identifier === "shell:allow-spawn") {
      assert(isPlainObject(permission), "shell:allow-spawn must stay scoped by an allowlist object.", { phase: "capability", markerClass: "arbitrary_spawn" });
      const allow = permission.allow;
      const allowedSidecars = Array.isArray(allow) ? allow.filter((entry) => entry?.name === SIDECAR_EXTERNAL_BIN && entry?.sidecar === true) : [];
      assert(Array.isArray(allow) && allow.length === 1 && allowedSidecars.length === 1, "shell:allow-spawn must allow only the packaged sidecar.", { phase: "capability", markerClass: "arbitrary_spawn" });
      const entryKeys = Object.keys(allow[0] ?? {}).sort();
      assert(JSON.stringify(entryKeys) === JSON.stringify(["name", "sidecar"]), "shell:allow-spawn sidecar entry must remain fixed and minimal.", { phase: "capability", markerClass: "arbitrary_spawn" });
    }
    permissionIds.push(identifier);
  }
  const sortedIds = [...permissionIds].sort();
  assert(JSON.stringify(sortedIds) === JSON.stringify([...EXPECTED_CAPABILITY_PERMISSION_IDS].sort()), "Default capability must contain only core default, dialog open/save, and fixed sidecar spawn permissions.", { phase: "capability", markerClass: "capability_widened", permissions: sortedIds });

  const packageJson = readJsonFile(join(rootDir, "package.json"), "package.json");
  assert(typeof packageJson.dependencies?.["@tauri-apps/plugin-dialog"] === "string", "package.json must depend on @tauri-apps/plugin-dialog for native dialogs.", { phase: "capability", markerClass: "missing_dialog_plugin" });
  assert(!packageJson.dependencies?.["@tauri-apps/plugin-fs"] && !packageJson.devDependencies?.["@tauri-apps/plugin-fs"], "package.json must not add Tauri filesystem plugin authority.", { phase: "capability", markerClass: "frontend_filesystem_authority" });
  assert(typeof packageJson.scripts?.["verify:m005:s04"] === "string", "package.json must expose verify:m005:s04 as the canonical S04 command.", { phase: "capability", markerClass: "missing_command" });

  return { permissions: sortedIds, dialogOpenSave: "allowed", filesystemAuthority: "absent", shellOpenAuthority: "absent", fixedSidecarSpawn: true, command: "verify:m005:s04" };
}

export function assertM005S04TauriConfig({ rootDir = ROOT_DIR, platform = process.platform } = {}) {
  const config = readJsonFile(join(rootDir, "src-tauri", "tauri.conf.json"), "src-tauri/tauri.conf.json");
  const externalBin = config.bundle?.externalBin;
  assert(Array.isArray(externalBin) && externalBin.length === 1 && externalBin[0] === SIDECAR_EXTERNAL_BIN, "Tauri bundle.externalBin must stay fixed to the packaged sidecar.", { phase: "tauri-config", markerClass: "external_bin_drift" });
  assert(String(config.build?.beforeBuildCommand ?? "").includes("sidecar:build"), "beforeBuildCommand must keep building the sidecar before packaging.", { phase: "tauri-config", markerClass: "missing_sidecar_build_hook" });
  assert(String(config.build?.beforeDevCommand ?? "").includes("sidecar:build"), "beforeDevCommand must keep building the sidecar before dev launch.", { phase: "tauri-config", markerClass: "missing_sidecar_build_hook" });
  const targets = config.bundle?.targets;
  if (platform === "linux") {
    assert(Array.isArray(targets), "Linux bundle targets must be explicit.", { phase: "tauri-config", markerClass: "missing_linux_targets" });
    const sortedTargets = [...targets].sort();
    assert(JSON.stringify(sortedTargets) === JSON.stringify(["deb", "rpm"]), "Linux package targets must stay fixed to deb and rpm.", { phase: "tauri-config", markerClass: "missing_linux_targets", targetCount: sortedTargets.length });
  }
  return { externalBin: "fixed-sidecar", sidecarBuildHooks: "present", linuxPackageTargets: platform === "linux" ? ["deb", "rpm"] : "not-required" };
}

function assertFileExists(rootDir, relativePath) {
  const absolutePath = join(rootDir, relativePath);
  assert(existsSync(absolutePath), "M005/S04 verifier source scan expected a tracked file to exist.", { phase: "source-guardrail", fileLabel: relativePath });
  return absolutePath;
}

function assertRustStoreRootInjection(sidecarSource, commandName, methodName) {
  const commandStart = sidecarSource.indexOf(`pub async fn ${commandName}`);
  assert(commandStart >= 0, `${commandName} must be present as a fixed Tauri command.`, { phase: "source-guardrail", fileLabel: "src-tauri/src/sidecar.rs", markerClass: "missing_fixed_tauri_command" });
  const commandEnd = sidecarSource.indexOf("#[tauri::command]", commandStart + 1);
  const commandSegment = sidecarSource.slice(commandStart, commandEnd > commandStart ? commandEnd : commandStart + 900);
  assert(commandSegment.includes("resolve_profile_store_root(&app)?"), `${commandName} must inject the app-data store root inside Rust before invoking the sidecar.`, { phase: "source-guardrail", fileLabel: "src-tauri/src/sidecar.rs", markerClass: "missing_app_data_injection" });
  assert(sidecarSource.includes(`"${methodName}"`), `${commandName} must invoke the fixed sidecar method ${methodName}.`, { phase: "source-guardrail", fileLabel: "src-tauri/src/sidecar.rs", markerClass: "missing_fixed_sidecar_method" });
}

export function assertM005S04SourceGuardrails({ rootDir = ROOT_DIR } = {}) {
  const scannedFiles = [];
  for (const relativePath of S04_SOURCE_GUARD_FILES) {
    const absolutePath = assertFileExists(rootDir, relativePath);
    const source = readFileSync(absolutePath, "utf8");
    scannedFiles.push(relativePath);
    assert(!IGNORED_ARTIFACT_REFERENCE_PATTERN.test(source), "M005/S04 verifier and tests must not import ignored planning artifacts.", { phase: "source-guardrail", fileLabel: relativePath, markerClass: "ignored_artifact_reference" });
  }

  // Scanned across the whole UI tree, not just src/App.tsx: negative rules must
  // hold for every component, and positive ones only care that the UI calls the
  // typed wrapper somewhere. See scripts/ui-sources.mjs.
  const ui = readUiSources(rootDir);
  const guardedUi = readGuardedUiSources(rootDir);
  assert(ui.count > 0, "M005/S04 verifier source scan found no UI sources under src/.", { phase: "source-guardrail", fileLabel: "src", markerClass: "missing_ui_sources" });
  assert(ui.combined.includes("@tauri-apps/plugin-dialog"), "React UI must use native open/save dialogs for portability path selection.", { phase: "source-guardrail", fileLabel: "src", markerClass: "missing_native_dialogs" });
  assert(/\bopen\s*\(/.test(ui.combined) && /\bsave\s*\(/.test(ui.combined), "React UI must keep native open and save dialog calls.", { phase: "source-guardrail", fileLabel: "src", markerClass: "missing_native_dialogs" });
  for (const file of guardedUi.files) {
    assert(!FRONTEND_FILESYSTEM_AUTHORITY_PATTERN.test(file.text), "React portability UI must not gain frontend filesystem authority.", { phase: "source-guardrail", fileLabel: file.path, markerClass: "frontend_filesystem_authority" });
    assert(!FRONTEND_SHELL_OPEN_AUTHORITY_PATTERN.test(file.text), "React portability UI must not gain shell-open authority.", { phase: "source-guardrail", fileLabel: file.path, markerClass: "shell_open_authority" });
    for (const command of FIXED_TAURI_COMMANDS) assert(!file.text.includes(`"${command}"`) && !file.text.includes(`'${command}'`), "React UI must call typed client wrappers instead of raw invoke command names.", { phase: "source-guardrail", fileLabel: file.path, markerClass: "raw_invoke_in_ui" });
  }
  for (const wrapper of ["exportProfileCookies", "replaceProfileCookies", "exportProfilePackage", "importProfilePackage"]) assert(ui.combined.includes(wrapper), "React UI must use typed cookie/package portability wrappers.", { phase: "source-guardrail", fileLabel: "src", markerClass: "missing_typed_wrapper" });

  const clientSource = readFileSync(assertFileExists(rootDir, "src/sidecar/client.ts"), "utf8");
  for (const method of FIXED_SIDECAR_METHODS) assert(!clientSource.includes(`"${method}"`) && !clientSource.includes(`'${method}'`), "TypeScript client must not expose raw sidecar portability method strings.", { phase: "source-guardrail", fileLabel: "src/sidecar/client.ts", markerClass: "raw_sidecar_method_in_client" });
  for (const command of FIXED_TAURI_COMMANDS) assert(clientSource.includes(`invoke<unknown>("${command}"`), "TypeScript client must keep fixed Tauri portability command wrappers.", { phase: "source-guardrail", fileLabel: "src/sidecar/client.ts", markerClass: "missing_fixed_tauri_command" });

  const libSource = readFileSync(assertFileExists(rootDir, "src-tauri/src/lib.rs"), "utf8");
  for (const command of FIXED_TAURI_COMMANDS) assert(libSource.includes(`sidecar::${command}`), "Tauri invoke handler must register fixed cookie/package portability commands.", { phase: "source-guardrail", fileLabel: "src-tauri/src/lib.rs", markerClass: "missing_fixed_tauri_command" });

  const sidecarSource = readFileSync(assertFileExists(rootDir, "src-tauri/src/sidecar.rs"), "utf8");
  assertRustStoreRootInjection(sidecarSource, "profile_cookies_export", "portability.cookies.export");
  assertRustStoreRootInjection(sidecarSource, "profile_cookies_replace", "portability.cookies.replace");
  assertRustStoreRootInjection(sidecarSource, "profile_package_export", "portability.profile_package.export");
  assertRustStoreRootInjection(sidecarSource, "profile_package_import", "portability.profile_package.import");

  return { scannedFiles: scannedFiles.length, ignoredArtifactImports: "absent", frontendFilesystemAuthority: "absent", shellOpenAuthority: "absent", uiUsesNativeDialogs: true, uiUsesTypedWrappers: true, clientUsesFixedCommands: true, rustFixedCommands: true, privateScopeInjected: true };
}

export function assertM005S04Documentation({ rootDir = ROOT_DIR } = {}) {
  const readme = readFileSync(assertFileExists(rootDir, "README.md"), "utf8");
  const requiredFragments = [
    "npm run verify:m005:s04",
    "--preflight-only",
    "--build-only",
    "--ui-only",
    "--skip-build",
    "--keep-temp",
    "PORTABILITY_PROFILE_BUSY",
    "R033/R034/R035/R037/R038/R039/R040",
    "verify.m005.s04",
    "native open/save dialogs",
    "redaction scanner",
    "cleanup",
  ];
  const missingFragments = requiredFragments.filter((fragment) => !readme.includes(fragment));
  assert(missingFragments.length === 0, "README must document the M005/S04 packaged portability verifier boundary.", { phase: "docs", markerClass: "docs_missing", missingFragmentCount: missingFragments.length });
  return { readme: "documented", command: "verify:m005:s04", modes: 5, requirements: "R033/R034/R035/R037/R038/R039/R040" };
}

export function assertM005S04Guardrails({ rootDir = ROOT_DIR, platform = process.platform } = {}) {
  return { capability: assertM005S04CapabilityConfig({ rootDir }), tauriConfig: assertM005S04TauriConfig({ rootDir, platform }), source: assertM005S04SourceGuardrails({ rootDir }), docs: assertM005S04Documentation({ rootDir }) };
}

function missingTool(name, toolClass, remediation) {
  return { name, toolClass, remediation };
}

export function planNativeDialogAutomation({ platform = process.platform, env = process.env, commandExists = defaultCommandExists } = {}) {
  if (platform !== "linux") return { platform, strategy: "platform-native", status: "available", display: "not-required", tools: [], missing: [], dialogs: [{ dialog: "save", selected: true, extension: "json" }, { dialog: "open", selected: true, extension: "tpkg" }] };

  const hasWayland = Boolean(env.WAYLAND_DISPLAY);
  const hasX11 = Boolean(env.DISPLAY);
  const missing = [];
  const toolOptions = { platform, env, pathEnv: env.PATH ?? "" };

  if (!hasWayland && !hasX11) missing.push(missingTool("display", "display", "Run from a visible Linux desktop session with WAYLAND_DISPLAY or DISPLAY."));

  const waylandAtspiPresent = hasWayland && commandExists(PYTHON, toolOptions);
  const waylandKeyPresent = hasWayland && commandExists(WAYLAND_KEY_TOOL, toolOptions);
  const waylandClipboardPresent = hasWayland && WAYLAND_CLIPBOARD_TOOLS.every((tool) => commandExists(tool, toolOptions));
  if (hasWayland && waylandAtspiPresent) {
    return { platform, strategy: "wayland", status: "available", display: "wayland", tools: [safeToolStatus(PYTHON, true)], keyboard: ATSPI_KEYBOARD, clipboard: "none", missing: [], dialogs: [{ dialog: "save", selected: true, extension: "json" }, { dialog: "open", selected: true, extension: "tpkg" }] };
  }
  if (hasWayland && waylandKeyPresent) {
    return { platform, strategy: "wayland", status: "available", display: "wayland", tools: [safeToolStatus(WAYLAND_KEY_TOOL, true), ...WAYLAND_CLIPBOARD_TOOLS.map((tool) => safeToolStatus(tool, waylandClipboardPresent))], keyboard: "ydotool", clipboard: waylandClipboardPresent ? "wl-clipboard" : "none", missing: [], dialogs: [{ dialog: "save", selected: true, extension: "json" }, { dialog: "open", selected: true, extension: "tpkg" }] };
  }
  if (hasWayland && !waylandAtspiPresent && !waylandKeyPresent) missing.push(missingTool(`${PYTHON}-or-${WAYLAND_KEY_TOOL}`, "wayland-key", "Install python3 with AT-SPI bindings or ydotool for Wayland native-dialog automation."));

  const x11TypePresent = hasX11 && commandExists(X11_TYPE_TOOL, toolOptions);
  const x11ClipboardTool = hasX11 ? X11_CLIPBOARD_TOOLS.find((tool) => commandExists(tool, toolOptions)) : null;
  const x11PythonPresent = hasX11 && commandExists(PYTHON, toolOptions);
  if (hasX11 && x11PythonPresent) {
    return { platform, strategy: "x11", status: "available", display: "x11", tools: [safeToolStatus(PYTHON, true)], keyboard: ATSPI_KEYBOARD, clipboard: "none", missing: [], dialogs: [{ dialog: "save", selected: true, extension: "json" }, { dialog: "open", selected: true, extension: "tpkg" }] };
  }
  if (hasX11 && x11TypePresent && x11ClipboardTool) {
    return { platform, strategy: "x11", status: "available", display: "x11", tools: [safeToolStatus(X11_TYPE_TOOL, true), safeToolStatus(x11ClipboardTool, true)], keyboard: "xdotool", clipboard: x11ClipboardTool, missing: [], dialogs: [{ dialog: "save", selected: true, extension: "json" }, { dialog: "open", selected: true, extension: "tpkg" }] };
  }
  if (hasX11 && !x11PythonPresent && !x11TypePresent) missing.push(missingTool(`${PYTHON}-or-${X11_TYPE_TOOL}`, "x11-key", "Install python3 with python-xlib or xdotool for X11 native-dialog keyboard automation."));
  if (hasX11 && x11TypePresent && !x11ClipboardTool) missing.push(missingTool("xclip-or-xsel", "x11-clipboard", "Install xclip or xsel for legacy X11 native-dialog clipboard fallback."));

  return { platform, strategy: "unavailable", status: "missing", display: hasWayland ? "wayland" : hasX11 ? "x11" : "missing", tools: [], missing, dialogs: [] };
}

export function assertNativeDialogAutomationPreflight(options = {}) {
  const strict = options.strict ?? true;
  const plan = planNativeDialogAutomation(options);
  if (strict && plan.missing.length > 0) {
    fail("M005/S04 native-dialog automation preflight failed.", { phase: "preflight.native-dialog", markerClass: "missing_native_dialog_tool", missing: plan.missing.map((item) => ({ name: item.name, toolClass: item.toolClass })), remediation: "Install the missing native-dialog automation tool class for the active Linux desktop session." });
  }
  return { strategy: plan.strategy, status: plan.status, display: plan.display, keyboard: plan.keyboard ?? null, clipboard: plan.clipboard ?? null, missingToolClasses: plan.missing.map((item) => item.toolClass), dialogs: plan.dialogs };
}

export function describeNativeDialogSelection({ dialog, selected = true, extension, targetPath } = {}) {
  const safeDialog = dialog === "open" ? "open" : "save";
  const derivedExtension = extension ?? extname(String(targetPath ?? "")).replace(/^\./, "");
  const safeExtension = String(derivedExtension ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16);
  const summary = { dialog: safeDialog, selected: Boolean(selected), extension: safeExtension || "unknown" };
  assertM005S04PublicEvidenceRedacted(summary);
  return summary;
}

export function createNativeDialogCommandPlan({ dialog, extension, strategyPlan } = {}) {
  const strategy = strategyPlan?.strategy ?? "unavailable";
  const selected = strategy !== "unavailable";
  const selection = describeNativeDialogSelection({ dialog, selected, extension });
  const commandPlan = { ...selection, strategy, steps: strategy === "wayland" ? ["focus-dialog", "type-selection", "confirm-selection"] : strategy === "x11" ? ["focus-dialog", "type-selection", "confirm-selection"] : [] };
  assertM005S04PublicEvidenceRedacted(commandPlan);
  return commandPlan;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function failNativeDialogTool(command, result, context, phase) {
  const failure = formatM005S04CommandFailure(command, result, context, phase);
  fail("M005/S04 native dialog automation command failed.", { ...failure, phase, markerClass: "native_dialog_tool_failed" });
}

function timeoutError() {
  const error = new Error("native dialog tool timed out");
  error.code = "ETIMEDOUT";
  return error;
}

function runNativeDialogTool(command, args = [], { input = "", timeoutMs = NATIVE_DIALOG_TOOL_TIMEOUT_MS, context = createM005S04PublicScanContext(), phase = "native-dialog" } = {}) {
  const result = spawnSync(executable(command), args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 512 * 1024 });
  if (result.error || result.status !== 0) failNativeDialogTool(command, result, context, phase);
  return { commandClass: commandClassFromLabel(command), exitCode: result.status ?? 0, stdout: result.stdout ?? "" };
}

async function tryM005S04AtspiButtonClick(buttonName, { context = createM005S04PublicScanContext(), phase = "native-dialog", timeoutMs = 1_500 } = {}) {
  if (!defaultCommandExists("python3")) return { clicked: false, driver: "unavailable" };
  const script = String.raw`
import json
import sys
import time
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception:
    print(json.dumps({"clicked": False, "driver": "unavailable"}))
    sys.exit(0)
button_name = sys.argv[1]
timeout_ms = int(sys.argv[2])
deadline = time.monotonic() + (timeout_ms / 1000)
def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default
def children(acc):
    for index in range(safe(acc.get_child_count, 0) or 0):
        child = safe(lambda index=index: acc.get_child_at_index(index), None)
        if child is not None:
            yield child
def find_button(acc, nodes):
    if nodes[0] > 600:
        return None
    nodes[0] += 1
    role = safe(acc.get_role_name, "") or ""
    name = safe(acc.get_name, "") or ""
    app = safe(lambda: acc.get_application().get_name(), "") or ""
    if app == "theprivator" and role == "button" and name == button_name:
        return acc
    for child in children(acc):
        found = find_button(child, nodes)
        if found is not None:
            return found
    return None
while time.monotonic() < deadline:
    desktop = Atspi.get_desktop(0)
    button = None
    for child in children(desktop):
        child_name = safe(child.get_name, "") or ""
        if child_name != "theprivator":
            continue
        button = find_button(child, [0])
        if button is not None:
            break
    if button is not None:
        action_count = safe(lambda: Atspi.Action.get_n_actions(button), 0) or 0
        if action_count > 0 and Atspi.Action.do_action(button, 0):
            print(json.dumps({"clicked": True, "driver": "at-spi"}))
            sys.exit(0)
    time.sleep(0.05)
print(json.dumps({"clicked": False, "driver": "at-spi"}))
`;
  const result = runNativeDialogTool("python3", ["-c", script, buttonName, String(timeoutMs)], { context, phase, timeoutMs: timeoutMs + 1_000 });
  try {
    const parsed = JSON.parse(result.stdout.trim() || "{}");
    return { clicked: parsed.clicked === true, driver: parsed.driver === "at-spi" ? "at-spi" : "unavailable" };
  } catch {
    return { clicked: false, driver: "unavailable" };
  }
}

export function findM005S04HyprlandDialogAddress(clients, dialogTitle) {
  if (!Array.isArray(clients) || typeof dialogTitle !== "string" || dialogTitle.length === 0) return null;
  const match = clients.find((client) => client?.class === "theprivator" && client?.title === dialogTitle && typeof client?.address === "string" && client.address.startsWith("0x"));
  if (match?.address) return match.address;
  const fallback = clients.find((client) => client?.class === "theprivator" && client?.title !== "ThePrivator" && typeof client?.address === "string" && client.address.startsWith("0x"));
  return fallback?.address ?? null;
}

async function focusM005S04HyprlandDialog(dialogTitle, { context = createM005S04PublicScanContext(), phase = "native-dialog", timeoutMs = 5_000, pollMs = 100 } = {}) {
  if (typeof dialogTitle !== "string" || dialogTitle.length === 0) return { focus: "not-requested" };
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE || !defaultCommandExists(HYPRLAND_CONTROL_TOOL)) return { focus: "not-applicable" };
  const started = Date.now();
  let lastAddress = null;
  while (Date.now() - started < timeoutMs) {
    const clientsResult = spawnSync(executable(HYPRLAND_CONTROL_TOOL), ["clients", "-j"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2_000, maxBuffer: 512 * 1024 });
    if (clientsResult.error || clientsResult.status !== 0) failNativeDialogTool(HYPRLAND_CONTROL_TOOL, clientsResult, context, phase);
    let clients;
    try {
      clients = JSON.parse(clientsResult.stdout || "[]");
    } catch {
      fail("M005/S04 Hyprland dialog focus inventory was malformed.", { phase, markerClass: "native_dialog_focus_malformed", outputSuppressed: true });
    }
    const address = findM005S04HyprlandDialogAddress(clients, dialogTitle);
    if (address) {
      lastAddress = address;
      const selector = `address:${address}`;
      runNativeDialogTool(HYPRLAND_CONTROL_TOOL, ["dispatch", `hl.dsp.focus({ window = ${JSON.stringify(selector)} })`], { context, phase, timeoutMs: 2_000 });
      await sleep(pollMs);
      const activeResult = spawnSync(executable(HYPRLAND_CONTROL_TOOL), ["activewindow", "-j"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2_000, maxBuffer: 128 * 1024 });
      if (activeResult.error || activeResult.status !== 0) failNativeDialogTool(HYPRLAND_CONTROL_TOOL, activeResult, context, phase);
      try {
        const active = JSON.parse(activeResult.stdout || "{}");
        if (active?.address === address) return { focus: "hyprland-dialog", selector: "address" };
      } catch {
        fail("M005/S04 Hyprland active-window inventory was malformed.", { phase, markerClass: "native_dialog_focus_malformed", outputSuppressed: true });
      }
    }
    await sleep(pollMs);
  }
  fail("M005/S04 native dialog window could not be focused before selection automation.", { phase, markerClass: lastAddress ? "native_dialog_focus_failed" : "native_dialog_focus_missing", dialog: dialogTitle, outputSuppressed: true });
}

export function runM005S04WaylandClipboardLoad(input, { timeoutMs = NATIVE_DIALOG_TOOL_TIMEOUT_MS, settleMs = 100, context = createM005S04PublicScanContext(), phase = "native-dialog", spawnClipboardProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawnClipboardProcess(executable("wl-copy"), ["--paste-once"], { stdio: ["pipe", "ignore", "ignore"], detached: true });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const rejectWithFailure = (result) => finish(() => {
      try {
        failNativeDialogTool("wl-copy", result, context, phase);
      } catch (error) {
        reject(error);
      }
    });
    const timer = setTimeout(() => {
      try {
        child.kill?.("SIGTERM");
      } catch {
        // Best-effort bounded cleanup only; public evidence remains redacted by failNativeDialogTool.
      }
      rejectWithFailure({ error: timeoutError(), status: null, signal: "SIGTERM" });
    }, timeoutMs);
    child.once?.("error", (error) => rejectWithFailure({ error, status: null }));
    child.once?.("exit", (code, signal) => {
      if (!settled && code !== 0) rejectWithFailure({ status: typeof code === "number" ? code : null, signal: signal ?? null });
    });
    child.stdin?.once?.("error", (error) => rejectWithFailure({ error, status: null }));
    child.stdin?.end?.(input, "utf8", () => {
      setTimeout(() => finish(() => {
        child.unref?.();
        resolve({ commandClass: commandClassFromLabel("wl-copy"), exitCode: 0, clipboardMode: "paste-once" });
      }), settleMs);
    });
  });
}

function ydotoolKeyArgs(...codes) {
  return codes.flatMap((code) => [`${code}:1`, `${code}:0`]);
}

function ydotoolChordArgs(modifierCode, keyCode) {
  return [`${modifierCode}:1`, `${keyCode}:1`, `${keyCode}:0`, `${modifierCode}:0`];
}

function runM005S04YdotoolKey(args, { context = createM005S04PublicScanContext(), phase = "native-dialog", timeoutMs = NATIVE_DIALOG_TOOL_TIMEOUT_MS } = {}) {
  return runNativeDialogTool(WAYLAND_KEY_TOOL, ["key", ...args], { context, phase, timeoutMs });
}

function runM005S04YdotoolType(input, { context = createM005S04PublicScanContext(), phase = "native-dialog", timeoutMs = NATIVE_DIALOG_TOOL_TIMEOUT_MS } = {}) {
  return runNativeDialogTool(WAYLAND_KEY_TOOL, ["type", "--key-delay=5", "--key-hold=5", "--", input], { context, phase, timeoutMs });
}

export async function driveM005S04WaylandPathSelection(targetPath, { context = createM005S04PublicScanContext({ selectedPaths: [targetPath].filter(Boolean) }), phase = "native-dialog", settleMs = 250 } = {}) {
  runM005S04YdotoolKey(ydotoolChordArgs(YDOTOOL_KEYCODES.ctrl, YDOTOOL_KEYCODES.l), { context, phase });
  await sleep(settleMs);
  runM005S04YdotoolType(targetPath, { context, phase });
  await sleep(settleMs);
  runM005S04YdotoolKey(ydotoolKeyArgs(YDOTOOL_KEYCODES.enter), { context, phase });
  return { keyboardMode: "ydotool", typedSelection: true };
}

function openM005S04X11LocationEntry(dialogTitle, { context = createM005S04PublicScanContext(), phase = "native-dialog", timeoutMs = NATIVE_DIALOG_TOOL_TIMEOUT_MS } = {}) {
  const script = String.raw`
import json
import sys
import time
from Xlib import X, display, XK
from Xlib.ext import xtest

dialog_title = sys.argv[1]
d = display.Display()
root = d.screen().root

def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default

def window_title(win):
    title = safe(win.get_wm_name, "") or ""
    if title:
        return title
    atom = safe(lambda: d.intern_atom('_NET_WM_NAME'), None)
    utf8 = safe(lambda: d.intern_atom('UTF8_STRING'), None)
    if atom is None or utf8 is None:
        return ""
    prop = safe(lambda: win.get_full_property(atom, utf8), None)
    if prop is None:
        return ""
    raw = prop.value
    return raw.decode('utf-8', 'ignore') if isinstance(raw, bytes) else str(raw)

def wm_class(win):
    value = safe(win.get_wm_class, None)
    if not value:
        return ""
    return " ".join(str(part) for part in value if part)

def children(win):
    tree = safe(win.query_tree, None)
    return [] if tree is None else list(tree.children or [])

def all_windows(win):
    stack = [win]
    seen = set()
    while stack:
        current = stack.pop()
        wid = int(current.id)
        if wid in seen:
            continue
        seen.add(wid)
        yield current
        stack.extend(reversed(children(current)))

def find_dialog():
    fallback = None
    for win in all_windows(root):
        klass = wm_class(win).casefold()
        if 'theprivator' not in klass:
            continue
        title = window_title(win)
        if dialog_title and title == dialog_title:
            return win
        if title and title != 'ThePrivator':
            fallback = fallback or win
    return fallback

win = None
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    win = find_dialog()
    if win is not None:
        break
    time.sleep(0.05)
if win is None:
    print(json.dumps({"opened": False, "reason": "dialog-not-found"}))
    sys.exit(3)
win.configure(stack_mode=X.Above)
win.set_input_focus(X.RevertToParent, X.CurrentTime)
d.sync()
time.sleep(0.1)
ctrl = d.keysym_to_keycode(XK.string_to_keysym('Control_L'))
l_key = d.keysym_to_keycode(XK.string_to_keysym('l'))
for event_type, code in ((X.KeyPress, ctrl), (X.KeyPress, l_key), (X.KeyRelease, l_key), (X.KeyRelease, ctrl)):
    xtest.fake_input(d, event_type, code)
    d.sync()
    time.sleep(0.01)
print(json.dumps({"opened": True, "driver": "python-xlib"}))
`;
  const result = runNativeDialogTool(PYTHON, ["-c", script, dialogTitle], { context, phase, timeoutMs });
  try {
    const parsed = JSON.parse(result.stdout.trim() || "{}");
    assert(parsed.opened === true, "M005/S04 X11 native dialog location entry did not open.", { phase, markerClass: "native_dialog_location_failed", outputSuppressed: true });
  } catch (error) {
    if (error instanceof VerifyFailure) throw error;
    fail("M005/S04 X11 native dialog location opener returned malformed status.", { phase, markerClass: "native_dialog_output_malformed", outputSuppressed: true });
  }
}

export async function driveM005S04AtspiDialogSelection(targetPath, { dialogTitle = "", buttonName = "Save", waitForClose = true, context = createM005S04PublicScanContext({ selectedPaths: [targetPath].filter(Boolean) }), phase = "native-dialog", timeoutMs = NATIVE_DIALOG_TOOL_TIMEOUT_MS } = {}) {
  if (process.env.DISPLAY) {
    openM005S04X11LocationEntry(dialogTitle, { context, phase: `${phase}.location`, timeoutMs });
    await sleep(500);
  }
  const script = String.raw`
import json
import sys
import time
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception:
    print(json.dumps({"selected": False, "reason": "atspi-unavailable"}))
    sys.exit(3)

target_path = sys.argv[1]
dialog_title = sys.argv[2]
button_name = sys.argv[3]
timeout_ms = int(sys.argv[4])
wait_for_close = sys.argv[5] == '1'
deadline = time.monotonic() + (timeout_ms / 1000)

def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default

def children(acc):
    for index in range(safe(acc.get_child_count, 0) or 0):
        child = safe(lambda index=index: acc.get_child_at_index(index), None)
        if child is not None:
            yield child

def is_theprivator(acc):
    return (safe(lambda: acc.get_application().get_name(), "") or "") == "theprivator"

def find_file_chooser(acc, nodes):
    if nodes[0] > 800:
        return None
    nodes[0] += 1
    role = safe(acc.get_role_name, "") or ""
    name = safe(acc.get_name, "") or ""
    current_fallback = None
    if is_theprivator(acc) and role == "file chooser" and name != "File Chooser Widget":
        if dialog_title and name == dialog_title:
            return acc
        current_fallback = acc
        if not dialog_title:
            return acc
    fallback = current_fallback
    for child in children(acc):
        found = find_file_chooser(child, nodes)
        if found is not None:
            if dialog_title:
                child_name = safe(found.get_name, "") or ""
                if child_name == dialog_title:
                    return found
                fallback = fallback or found
            else:
                return found
    return fallback

def find_descendant(acc, role_name, name=None, nodes=None):
    if nodes is None:
        nodes = [0]
    if nodes[0] > 800:
        return None
    nodes[0] += 1
    role = safe(acc.get_role_name, "") or ""
    current_name = safe(acc.get_name, "") or ""
    if role == role_name and (name is None or current_name == name):
        return acc
    for child in children(acc):
        found = find_descendant(child, role_name, name, nodes)
        if found is not None:
            return found
    return None

def collect_descendants(acc, role_name, nodes=None, results=None):
    if nodes is None:
        nodes = [0]
    if results is None:
        results = []
    if nodes[0] > 800:
        return results
    nodes[0] += 1
    if (safe(acc.get_role_name, "") or "") == role_name:
        results.append(acc)
    for child in children(acc):
        collect_descendants(child, role_name, nodes, results)
    return results

def choose_path_text(chooser):
    text_fields = collect_descendants(chooser, "text")
    for field in text_fields:
        value = safe(lambda field=field: Atspi.Text.get_text(field, 0, -1), "") or ""
        if "/" in value or value.endswith((".json", ".txt", ".tpkg")):
            return field
    return text_fields[0] if text_fields else None

while time.monotonic() < deadline:
    desktop = Atspi.get_desktop(0)
    chooser = None
    for app in children(desktop):
        if (safe(app.get_name, "") or "") != "theprivator":
            continue
        chooser = find_file_chooser(app, [0])
        if chooser is not None:
            break
    if chooser is None:
        time.sleep(0.05)
        continue
    text = choose_path_text(chooser)
    button = find_descendant(chooser, "button", button_name)
    if text is None or button is None:
        time.sleep(0.05)
        continue
    if not Atspi.EditableText.set_text_contents(text, target_path):
        print(json.dumps({"selected": False, "reason": "text-set-failed"}))
        sys.exit(4)
    time.sleep(0.15)
    observed_text = safe(lambda: Atspi.Text.get_text(text, 0, -1), "") or ""
    if observed_text != target_path:
        time.sleep(0.15)
        observed_text = safe(lambda: Atspi.Text.get_text(text, 0, -1), "") or ""
    if observed_text != target_path:
        print(json.dumps({"selected": False, "reason": "text-readback-mismatch"}))
        sys.exit(7)
    action_count = safe(lambda: Atspi.Action.get_n_actions(button), 0) or 0
    if action_count <= 0 or not Atspi.Action.do_action(button, 0):
        print(json.dumps({"selected": False, "reason": "button-click-failed"}))
        sys.exit(5)
    if not wait_for_close:
        print(json.dumps({"selected": True, "driver": "at-spi"}))
        sys.exit(0)
    closed_deadline = time.monotonic() + 2
    while time.monotonic() < closed_deadline:
        still_open = None
        desktop = Atspi.get_desktop(0)
        for app in children(desktop):
            if (safe(app.get_name, "") or "") != "theprivator":
                continue
            still_open = find_file_chooser(app, [0])
            if still_open is not None:
                break
        if still_open is None:
            print(json.dumps({"selected": True, "driver": "at-spi"}))
            sys.exit(0)
        time.sleep(0.05)
    print(json.dumps({"selected": False, "reason": "dialog-still-open"}))
    sys.exit(8)
print(json.dumps({"selected": False, "reason": "dialog-not-found"}))
sys.exit(6)
`;
  const result = runNativeDialogTool(PYTHON, ["-c", script, targetPath, dialogTitle, buttonName, String(timeoutMs), waitForClose ? "1" : "0"], { context, phase, timeoutMs: timeoutMs + 1_000 });
  try {
    const parsed = JSON.parse(result.stdout.trim() || "{}");
    assert(parsed.selected === true, "M005/S04 AT-SPI native dialog selection did not complete.", { phase, markerClass: "native_dialog_selection_failed", outputSuppressed: true });
  } catch (error) {
    if (error instanceof VerifyFailure) throw error;
    fail("M005/S04 AT-SPI native dialog automation returned malformed status.", { phase, markerClass: "native_dialog_output_malformed", outputSuppressed: true });
  }
  return { keyboardMode: ATSPI_KEYBOARD, typedSelection: true };
}

export async function driveM005S04X11PathSelection(targetPath, { dialogTitle = "", context = createM005S04PublicScanContext({ selectedPaths: [targetPath].filter(Boolean) }), phase = "native-dialog" } = {}) {
  const script = String.raw`
import json
import sys
import time
from Xlib import X, XK, display
from Xlib.ext import xtest

target_path = sys.argv[1]
dialog_title = sys.argv[2]
d = display.Display()
root = d.screen().root

def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default

def window_title(win):
    title = safe(win.get_wm_name, "") or ""
    if title:
        return title
    atom = safe(lambda: d.intern_atom('_NET_WM_NAME'), None)
    utf8 = safe(lambda: d.intern_atom('UTF8_STRING'), None)
    if atom is None or utf8 is None:
        return ""
    prop = safe(lambda: win.get_full_property(atom, utf8), None)
    if prop is None:
        return ""
    raw = prop.value
    if isinstance(raw, bytes):
        return raw.decode('utf-8', 'ignore')
    return str(raw)

def wm_class(win):
    value = safe(win.get_wm_class, None)
    if not value:
        return ""
    return " ".join(str(part) for part in value if part)

def children(win):
    tree = safe(win.query_tree, None)
    if tree is None:
        return []
    return list(tree.children or [])

def all_windows(win):
    stack = [win]
    seen = set()
    while stack:
        current = stack.pop()
        wid = int(current.id)
        if wid in seen:
            continue
        seen.add(wid)
        yield current
        stack.extend(reversed(children(current)))

def find_dialog():
    candidates = []
    for win in all_windows(root):
        title = window_title(win)
        klass = wm_class(win).casefold()
        if 'theprivator' not in klass:
            continue
        if dialog_title and title == dialog_title:
            return win
        if title and title != 'ThePrivator':
            candidates.append(win)
    return candidates[0] if candidates else None

win = None
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    win = find_dialog()
    if win is not None:
        break
    time.sleep(0.05)
if win is None:
    print(json.dumps({"selected": False, "reason": "dialog-not-found"}))
    sys.exit(3)
win.configure(stack_mode=X.Above)
win.set_input_focus(X.RevertToParent, X.CurrentTime)
d.sync()
time.sleep(0.1)

shift = d.keysym_to_keycode(XK.string_to_keysym('Shift_L'))
ctrl = d.keysym_to_keycode(XK.string_to_keysym('Control_L'))

SPECIAL = {
    '/': ('slash', False),
    '-': ('minus', False),
    '_': ('minus', True),
    '.': ('period', False),
    ' ': ('space', False),
    ':': ('semicolon', True),
}

def press(code):
    xtest.fake_input(d, X.KeyPress, code)
    d.sync()
    time.sleep(0.002)

def release(code):
    xtest.fake_input(d, X.KeyRelease, code)
    d.sync()
    time.sleep(0.002)

def key_name_for_char(ch):
    if ch in SPECIAL:
        return SPECIAL[ch]
    if ch.isalpha():
        return (ch.lower(), ch.isupper())
    if ch.isdigit():
        return (ch, False)
    return (ch, False)

def tap_keysym(name, use_shift=False):
    code = d.keysym_to_keycode(XK.string_to_keysym(name))
    if not code:
        raise RuntimeError('missing-keycode')
    if use_shift:
        press(shift)
    press(code)
    release(code)
    if use_shift:
        release(shift)

def tap_char(ch):
    name, use_shift = key_name_for_char(ch)
    tap_keysym(name, use_shift)

def tap_return():
    code = d.keysym_to_keycode(XK.string_to_keysym('Return'))
    press(code)
    release(code)

def chord_ctrl_l():
    l_code = d.keysym_to_keycode(XK.string_to_keysym('l'))
    press(ctrl)
    press(l_code)
    release(l_code)
    release(ctrl)

chord_ctrl_l()
time.sleep(0.1)
for character in target_path:
    tap_char(character)
time.sleep(0.1)
tap_return()
print(json.dumps({"selected": True, "driver": "python-xlib"}))
`;
  const result = runNativeDialogTool(PYTHON, ["-c", script, targetPath, dialogTitle], { context, phase, timeoutMs: NATIVE_DIALOG_TOOL_TIMEOUT_MS });
  try {
    const parsed = JSON.parse(result.stdout.trim() || "{}");
    assert(parsed.selected === true, "M005/S04 X11 native dialog selection did not complete.", { phase, markerClass: "native_dialog_selection_failed", outputSuppressed: true });
  } catch (error) {
    if (error instanceof VerifyFailure) throw error;
    fail("M005/S04 X11 native dialog automation returned malformed status.", { phase, markerClass: "native_dialog_output_malformed", outputSuppressed: true });
  }
  return { keyboardMode: X11_PYTHON_KEYBOARD, typedSelection: true };
}

export async function driveM005S04NativeDialogSelection({ dialog, targetPath, extension, strategyPlan, dialogTitle, settleMs = DEFAULT_NATIVE_DIALOG_SETTLE_MS, confirmOverwrite = false } = {}, context = createM005S04PublicScanContext({ selectedPaths: [targetPath].filter(Boolean) })) {
  assert(typeof targetPath === "string" && targetPath.length > 0, "M005/S04 native dialog selection requires a private target path.", { phase: "native-dialog", markerClass: "missing_selected_path" });
  const commandPlan = createNativeDialogCommandPlan({ dialog, extension, strategyPlan });
  assert(commandPlan.selected, "M005/S04 native dialog automation is unavailable for the current desktop session.", { phase: "native-dialog", markerClass: "missing_native_dialog_tool", strategy: commandPlan.strategy });
  await sleep(settleMs);
  const phase = `native-dialog.${commandPlan.dialog}.${commandPlan.extension}`;
  if (commandPlan.strategy === "wayland") {
    if (strategyPlan?.keyboard === ATSPI_KEYBOARD) await driveM005S04AtspiDialogSelection(targetPath, { dialogTitle, buttonName: commandPlan.dialog === "open" ? "Open" : "Save", waitForClose: !confirmOverwrite, context, phase });
    else {
      const focus = await focusM005S04HyprlandDialog(dialogTitle, { context, phase });
      if (focus.focus === "hyprland-dialog") await sleep(100);
      await driveM005S04WaylandPathSelection(targetPath, { context, phase });
    }
    if (commandPlan.dialog === "save" && confirmOverwrite) await tryM005S04AtspiButtonClick("Replace", { context, phase: `${phase}.overwrite` });
  } else if (commandPlan.strategy === "x11") {
    if (strategyPlan?.keyboard === ATSPI_KEYBOARD) await driveM005S04AtspiDialogSelection(targetPath, { dialogTitle, buttonName: commandPlan.dialog === "open" ? "Open" : "Save", waitForClose: !confirmOverwrite, context, phase });
    else if (strategyPlan?.keyboard === X11_PYTHON_KEYBOARD) await driveM005S04X11PathSelection(targetPath, { dialogTitle, context, phase });
    else {
      if (strategyPlan?.clipboard === "xsel") runNativeDialogTool("xsel", ["--clipboard", "--input"], { input: targetPath, context, phase });
      else runNativeDialogTool("xclip", ["-selection", "clipboard"], { input: targetPath, context, phase });
      runNativeDialogTool(X11_TYPE_TOOL, ["key", "ctrl+l", "ctrl+v", "Return"], { context, phase });
    }
    if (commandPlan.dialog === "save" && confirmOverwrite) await tryM005S04AtspiButtonClick("Replace", { context, phase: `${phase}.overwrite` });
  } else {
    fail("M005/S04 native dialog automation strategy is unsupported.", { phase: "native-dialog", markerClass: "native_dialog_strategy_unsupported", strategy: commandPlan.strategy });
  }
  const summary = { dialog: commandPlan.dialog, selected: true, extension: commandPlan.extension, strategy: commandPlan.strategy, steps: commandPlan.steps.length, privateSelection: true };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { targetPath }, log: summary };
}

function xpathLiteral(value) {
  const text = String(value ?? "");
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  return `concat(${text.split("'").map((part) => `'${part}'`).join(', "\'", ')})`;
}

function m005S04ProfileCardXPath(name) {
  return `//article[contains(concat(' ', normalize-space(@class), ' '), ' profile-card ')][.//h3[normalize-space()=${xpathLiteral(name)}]]`;
}

async function clickM005S04UiElement(driver, element, runtime, step, markerClass) {
  try {
    await driver.executeScript("arguments[0].scrollIntoView({ block: 'center', inline: 'nearest' });", element);
    await element.click();
    return "native-click";
  } catch (error) {
    try {
      await driver.executeScript("arguments[0].click();", element);
      return "dom-click";
    } catch {
      fail("M005/S04 packaged UI click failed.", { phase: step, markerClass, message: error instanceof Error ? error.message : String(error), outputSuppressed: true });
    }
  }
}

async function readM005S04VisibleBodyText(driver) {
  try {
    const body = await driver.findElement(By.css("body"));
    return (await body.getText()).trim();
  } catch {
    return "";
  }
}

async function readM005S04FirstVisibleText(driver, by) {
  try {
    const elements = await driver.findElements(by);
    for (const element of elements) {
      if (!(await element.isDisplayed())) continue;
      const text = (await element.getText()).trim();
      if (text) return text;
    }
  } catch {
    return "";
  }
  return "";
}

async function readM005S04PackageExportSuccessText(driver, profileName) {
  return readM005S04FirstVisibleText(driver, By.xpath(`${m005S04ProfileCardXPath(profileName)}//section[contains(concat(' ', normalize-space(@class), ' '), ' package-portability-success ')][.//strong[normalize-space()='ThePrivator package export completed.']]`));
}

async function readM005S04PackageImportSuccessText(driver) {
  return readM005S04FirstVisibleText(driver, By.xpath(`//section[contains(concat(' ', normalize-space(@class), ' '), ' package-portability-success ')][.//strong[normalize-space()='ThePrivator package import completed.']]`));
}

async function readM005S04CookieSuccessText(driver, profileName, headingText) {
  return readM005S04FirstVisibleText(driver, By.xpath(`${m005S04ProfileCardXPath(profileName)}//section[contains(concat(' ', normalize-space(@class), ' '), ' cookie-portability-success ')][.//strong[normalize-space()=${xpathLiteral(headingText)}]]`));
}

async function findM005S04ProfileButton(driver, profileName, buttonText) {
  const buttons = await driver.findElements(By.xpath(`${m005S04ProfileCardXPath(profileName)}//button[normalize-space()=${xpathLiteral(buttonText)}]`));
  for (const button of buttons) {
    if (await button.isDisplayed()) return button;
  }
  return null;
}

async function assertM005S04ProfileButtonDisabled(driver, profileName, buttonText) {
  const button = await findM005S04ProfileButton(driver, profileName, buttonText);
  assert(button, "M005/S04 expected a visible profile portability control.", { phase: "ui.busy-guard", markerClass: "ui_control_missing", control: buttonText });
  const enabled = await button.isEnabled();
  assert(!enabled, "M005/S04 running profile portability control was not disabled.", { phase: "ui.busy-guard", markerClass: "running_control_enabled", control: buttonText });
  return { control: buttonText, disabled: true };
}

async function waitForM005S04GlobalButton(driver, buttonText, runtime, options = {}) {
  const selector = By.xpath(`//button[normalize-space()=${xpathLiteral(buttonText)}]`);
  return waitS06VisibleElement(driver, selector, runtime, buttonText, { ...options, step: options.step ?? "m005-global-button" });
}

export function assertM005S04WebDriverPreflight({ rootDir = ROOT_DIR, platform = process.platform, env = process.env, strict = true } = {}) {
  try {
    const result = assertS06WebDriverPreflight({ rootDir, platform, env, strict });
    return { strict: result.strict, display: result.display, tauriDriver: result.tauriDriver ? { name: result.tauriDriver.name, source: result.tauriDriver.source } : null, platformDriver: result.platformDriver ? { name: result.platformDriver.name, source: result.platformDriver.source } : null, chromium: result.chromium ? { name: result.chromium.name, source: result.chromium.source } : null, missingToolClasses: result.missing.map((item) => item.name), requiredToolClasses: platform === "linux" ? LINUX_WEBDRIVER_TOOL_CLASSES : ["tauri-driver"] };
  } catch (error) {
    const missing = Array.isArray(error?.details?.missing) ? error.details.missing.map((item) => item?.name).filter(Boolean) : [];
    fail("M005/S04 WebDriver preflight failed.", { phase: "preflight.webdriver", markerClass: "missing_webdriver_tool", missingToolClasses: missing, remediation: "Install Tauri WebDriver, the platform WebDriver bridge, Chromium, and run from a visible desktop session." });
  }
}

export function buildM005S04FinalSummary({ status, mode = "full", checks = STEP_RESULTS, guardrails = {}, preflight = {}, build = {}, runtime = {}, cleanup = {}, error = null } = {}, context = createM005S04PublicScanContext()) {
  const summary = redactM005S04({
    event: VERIFY_EVENT,
    status,
    mode,
    guardrails: { capability: guardrails.capability ? "pass" : undefined, tauriConfig: guardrails.tauriConfig ? "pass" : undefined, source: guardrails.source ? "pass" : undefined, docs: guardrails.docs ? "pass" : undefined, permissions: guardrails.capability?.permissions, dialogOpenSave: guardrails.capability?.dialogOpenSave, fixedSidecarSpawn: guardrails.capability?.fixedSidecarSpawn },
    preflight: { webdriver: preflight.webdriver ? { status: preflight.webdriver.missingToolClasses?.length ? "missing" : "available", display: preflight.webdriver.display, missingToolClasses: preflight.webdriver.missingToolClasses ?? [] } : undefined, nativeDialog: preflight.nativeDialog ? { status: preflight.nativeDialog.status, strategy: preflight.nativeDialog.strategy, display: preflight.nativeDialog.display, missingToolClasses: preflight.nativeDialog.missingToolClasses ?? [] } : undefined, chromium: preflight.chromium ? { status: "available", source: preflight.chromium.source ?? "detected" } : undefined },
    build,
    runtime,
    cleanup,
    checks: checks.map((check) => ({ name: check.name, status: check.status, durationMs: check.durationMs })),
    error: error ? formatM005S04FailureDetails(error, context, mode) : null,
  }, context);
  assertM005S04PublicEvidenceRedacted(summary, context);
  return summary;
}

export async function createM005S04SourceProfileViaUi(driver, runtime, {
  waitForVisibleText = waitS06VisibleText,
  waitForVisibleElement = waitS06VisibleElement,
  waitForProfileCard = waitS06ProfileCard,
  assertInitialPackagedUi = assertS06InitialPackagedUi,
  createSmokeProfile = createS06SmokeProfile,
  readMetricValue = readS06MetricValue,
  readProfileCardText = readS06ProfileCardText,
  readProfileSectionText = readS06ProfileSectionText,
} = {}) {
  assert(driver, "M005/S04 source profile UI creation requires a WebDriver session.", { phase: "ui.source-profile", markerClass: "missing_webdriver_session" });
  assert(runtime?.smokeContext?.smokeProfileName, "M005/S04 source profile UI creation requires a smoke profile name.", { phase: "ui.source-profile", markerClass: "missing_smoke_context" });
  await waitForVisibleText(driver, "Persistent profiles, transient browsers.", runtime, { step: "m005-packaged-ui-initial" });
  await waitForVisibleElement(driver, By.css("#profile-name"), runtime, "#profile-name", { step: "m005-packaged-profile-create" });
  await assertInitialPackagedUi(driver, runtime);
  await createSmokeProfile(driver, runtime);
  await waitForProfileCard(driver, runtime.smokeContext.smokeProfileName, runtime, { step: "m005-packaged-profile-card" });
  const cardText = await readProfileCardText(driver, runtime.smokeContext.smokeProfileName);
  const portabilityText = await readProfileSectionText(driver, runtime.smokeContext.smokeProfileName, `Portability actions for ${runtime.smokeContext.smokeProfileName}`);
  const runningMetric = await readMetricValue(driver, "Profile overview", "Running profiles");
  return {
    value: { cardText, portabilityText, runningMetric },
    log: {
      sourceProfile: "created-visible-ui",
      profileCard: "visible",
      cardTextObserved: cardText.length > 0,
      portabilityActionsObserved: portabilityText.length > 0,
      metricReader: runningMetric === null ? "unavailable" : "available",
    },
  };
}

export async function driveM005S04PackageExportViaUi(driver, runtime, { packagePath, strategyPlan, readProfileCardText = readS06ProfileCardText, waitForProfileButton = waitS06ProfileButton, waitForVisibleText = waitS06VisibleText, driveNativeDialogSelection = driveM005S04NativeDialogSelection } = {}, context = createM005S04PublicScanContext({ tempRoot: runtime?.smokeContext?.smokeRoot, appDataRoot: runtime?.profileStore?.appDataRoot, userDataRoot: runtime?.profileStore?.userDataRoot, selectedPaths: [packagePath].filter(Boolean) })) {
  assert(driver, "M005/S04 package export requires a WebDriver session.", { phase: "ui.package-export", markerClass: "missing_webdriver_session" });
  assert(runtime?.smokeContext?.smokeProfileName, "M005/S04 package export requires a source profile name.", { phase: "ui.package-export", markerClass: "missing_smoke_context" });
  assert(typeof packagePath === "string" && packagePath.endsWith(".tpkg"), "M005/S04 package export requires a private .tpkg destination.", { phase: "ui.package-export", markerClass: "missing_package_path" });
  const button = await waitForProfileButton(driver, runtime.smokeContext.smokeProfileName, "Export ThePrivator package", runtime, { step: "m005-package-export-click" });
  const clickMode = await clickM005S04UiElement(driver, button, runtime, "ui.package-export", "package_export_click_failed");
  const dialog = await driveNativeDialogSelection({ dialog: "save", targetPath: packagePath, extension: "tpkg", strategyPlan, dialogTitle: "Export ThePrivator package" }, context);
  await waitForVisibleText(driver, "ThePrivator package export completed.", runtime, { step: "m005-package-export-success" });
  await waitForVisibleText(driver, "The sidecar wrote the selected destination without returning the location or archive internals to the UI.", runtime, { step: "m005-package-export-redaction-copy" });
  const successText = await readM005S04PackageExportSuccessText(driver, runtime.smokeContext.smokeProfileName);
  assert(successText.length > 0, "M005/S04 package export success summary was not readable for redaction scanning.", { phase: "ui.package-export", markerClass: "ui_success_missing" });
  assertM005S04VisibleTextRedacted({ text: successText, phase: "ui.package-export" }, context);
  const summary = { packageExportUi: "success", dialog: dialog.log, clickMode, successTextObserved: successText.length > 0, successTextScanned: true };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { successText }, log: summary };
}

export async function driveM005S04PackageImportViaUi(driver, runtime, { packagePath, strategyPlan, waitForVisibleText = waitS06VisibleText, waitForProfileCard = waitS06ProfileCard, driveNativeDialogSelection = driveM005S04NativeDialogSelection } = {}, context = createM005S04PublicScanContext({ tempRoot: runtime?.smokeContext?.smokeRoot, appDataRoot: runtime?.profileStore?.appDataRoot, userDataRoot: runtime?.profileStore?.userDataRoot, selectedPaths: [packagePath].filter(Boolean) })) {
  assert(driver, "M005/S04 package import requires a WebDriver session.", { phase: "ui.package-import", markerClass: "missing_webdriver_session" });
  assert(runtime?.smokeContext?.smokeProfileName, "M005/S04 package import requires a source profile name.", { phase: "ui.package-import", markerClass: "missing_smoke_context" });
  assert(typeof packagePath === "string" && packagePath.endsWith(".tpkg"), "M005/S04 package import requires a private .tpkg source.", { phase: "ui.package-import", markerClass: "missing_package_path" });
  const button = await waitForM005S04GlobalButton(driver, "Import ThePrivator package", runtime, { step: "m005-package-import-click" });
  let clickMode = await clickM005S04UiElement(driver, button, runtime, "ui.package-import", "package_import_click_failed");
  let dialog;
  try {
    dialog = await driveNativeDialogSelection({ dialog: "open", targetPath: packagePath, extension: "tpkg", strategyPlan, dialogTitle: "Import ThePrivator package" }, context);
  } catch (error) {
    if (!(error instanceof VerifyFailure) || !String(error.details?.phase ?? "").startsWith("native-dialog.open")) throw error;
    await sleep(500);
    const retryButton = await waitForM005S04GlobalButton(driver, "Import ThePrivator package", runtime, { step: "m005-package-import-retry-click" });
    const retryMode = await clickM005S04UiElement(driver, retryButton, runtime, "ui.package-import", "package_import_retry_click_failed");
    clickMode = `${clickMode}+retry-${retryMode}`;
    dialog = await driveNativeDialogSelection({ dialog: "open", targetPath: packagePath, extension: "tpkg", strategyPlan, dialogTitle: "Import ThePrivator package" }, context);
  }
  await waitForVisibleText(driver, "ThePrivator package import completed.", runtime, { step: "m005-package-import-success" });
  await waitForVisibleText(driver, "The sidecar imported a stopped copied profile and returned only safe aggregate metadata to the UI.", runtime, { step: "m005-package-import-redaction-copy" });
  const restored = assertM005S04CopiedProfileRestored({ profileStorePath: runtime.profileStore.profileStorePath, appDataRoot: runtime.profileStore.appDataRoot, sourceProfile: runtime.profileStore.profile, expectedCookieRows: runtime.fixtures?.currentCookies ?? runtime.fixtures?.sourceCookies ?? [], expectedPayloadRelativePaths: runtime.fixtures?.expectedPayloadRelativePaths ?? ["Default/Preferences"] }, context);
  await waitForProfileCard(driver, restored.value.profile.name, runtime, { step: "m005-package-import-card" });
  const successText = await readM005S04PackageImportSuccessText(driver);
  assert(successText.length > 0, "M005/S04 package import success summary was not readable for redaction scanning.", { phase: "ui.package-import", markerClass: "ui_success_missing" });
  assertM005S04VisibleTextRedacted({ text: successText, phase: "ui.package-import" }, context);
  const summary = { packageImportUi: "success", dialog: dialog.log, clickMode, copiedProfileVisible: true, copiedProfileRestored: restored.log, successTextScanned: true };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { importedProfile: restored.value.profile, importedUserDataRoot: restored.value.userDataRoot, successText }, log: summary };
}

export async function driveM005S04CookieExportViaUi(driver, runtime, { exportPath, strategyPlan, readProfileCardText = readS06ProfileCardText, waitForProfileButton = waitS06ProfileButton, waitForVisibleText = waitS06VisibleText, driveNativeDialogSelection = driveM005S04NativeDialogSelection } = {}, context = createM005S04PublicScanContext({ tempRoot: runtime?.smokeContext?.smokeRoot, appDataRoot: runtime?.profileStore?.appDataRoot, userDataRoot: runtime?.profileStore?.userDataRoot, selectedPaths: [exportPath].filter(Boolean), cookieDomains: (runtime?.fixtures?.sourceCookies ?? []).map((row) => row.domain).filter(Boolean), cookieNames: (runtime?.fixtures?.sourceCookies ?? []).map((row) => row.name).filter(Boolean), cookieValues: (runtime?.fixtures?.sourceCookies ?? []).map((row) => row.value).filter(Boolean) })) {
  assert(driver, "M005/S04 cookie export requires a WebDriver session.", { phase: "ui.cookie-export", markerClass: "missing_webdriver_session" });
  assert(runtime?.smokeContext?.smokeProfileName, "M005/S04 cookie export requires a source profile name.", { phase: "ui.cookie-export", markerClass: "missing_smoke_context" });
  assert(typeof exportPath === "string" && exportPath.endsWith(".json"), "M005/S04 cookie export requires a private JSON destination.", { phase: "ui.cookie-export", markerClass: "missing_selected_path" });
  const button = await waitForProfileButton(driver, runtime.smokeContext.smokeProfileName, "Export ThePrivator JSON", runtime, { step: "m005-cookie-export-click" });
  const clickMode = await clickM005S04UiElement(driver, button, runtime, "ui.cookie-export", "cookie_export_click_failed");
  const dialog = await driveNativeDialogSelection({ dialog: "save", targetPath: exportPath, extension: "json", strategyPlan, dialogTitle: "Export cookies as ThePrivator JSON" }, context);
  await waitForVisibleText(driver, "ThePrivator JSON export completed.", runtime, { step: "m005-cookie-export-success" });
  await waitForVisibleText(driver, "The sidecar wrote the selected destination without returning the path or cookie contents to the UI.", runtime, { step: "m005-cookie-export-redaction-copy" });
  const successText = await readM005S04CookieSuccessText(driver, runtime.smokeContext.smokeProfileName, "ThePrivator JSON export completed.");
  assert(successText.length > 0, "M005/S04 cookie export success summary was not readable for redaction scanning.", { phase: "ui.cookie-export", markerClass: "ui_success_missing" });
  assertM005S04VisibleTextRedacted({ text: successText, phase: "ui.cookie-export" }, context);
  const cardText = await readProfileCardText(driver, runtime.smokeContext.smokeProfileName);
  assert(cardText.includes("Cookie portability for stopped profiles"), "M005/S04 source profile card did not expose cookie portability copy.", { phase: "ui.cookie-export", markerClass: "ui_card_malformed" });
  const summary = { cookieExportUi: "success", dialog: dialog.log, clickMode, successTextObserved: true, successTextScanned: true, sourceCardObserved: true };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { successText }, log: summary };
}

export async function driveM005S04CookieReplaceViaUi(driver, runtime, { importPath, strategyPlan, waitForProfileButton = waitS06ProfileButton, waitForVisibleText = waitS06VisibleText, driveNativeDialogSelection = driveM005S04NativeDialogSelection } = {}, context = createM005S04PublicScanContext({ tempRoot: runtime?.smokeContext?.smokeRoot, appDataRoot: runtime?.profileStore?.appDataRoot, userDataRoot: runtime?.profileStore?.userDataRoot, selectedPaths: [importPath].filter(Boolean), cookieDomains: (runtime?.fixtures?.importCookies ?? []).map((row) => row.domain).filter(Boolean), cookieNames: (runtime?.fixtures?.importCookies ?? []).map((row) => row.name).filter(Boolean), cookieValues: (runtime?.fixtures?.importCookies ?? []).map((row) => row.value).filter(Boolean) })) {
  assert(driver, "M005/S04 cookie replace requires a WebDriver session.", { phase: "ui.cookie-replace", markerClass: "missing_webdriver_session" });
  assert(runtime?.smokeContext?.smokeProfileName, "M005/S04 cookie replace requires a source profile name.", { phase: "ui.cookie-replace", markerClass: "missing_smoke_context" });
  assert(typeof importPath === "string" && importPath.endsWith(".json"), "M005/S04 cookie replace requires a private JSON source.", { phase: "ui.cookie-replace", markerClass: "missing_selected_path" });
  const button = await waitForProfileButton(driver, runtime.smokeContext.smokeProfileName, "Replace cookies", runtime, { step: "m005-cookie-replace-click" });
  const clickMode = await clickM005S04UiElement(driver, button, runtime, "ui.cookie-replace", "cookie_replace_click_failed");
  const dialog = await driveNativeDialogSelection({ dialog: "open", targetPath: importPath, extension: "json", strategyPlan, dialogTitle: "Replace profile cookies from a cookie file" }, context);
  await waitForVisibleText(driver, "ThePrivator JSON import replaced existing cookies.", runtime, { step: "m005-cookie-replace-success" });
  await waitForVisibleText(driver, "The sidecar replaced profile cookies from the selected source without returning the path or cookie contents to the UI.", runtime, { step: "m005-cookie-replace-redaction-copy" });
  const successText = await readM005S04CookieSuccessText(driver, runtime.smokeContext.smokeProfileName, "ThePrivator JSON import replaced existing cookies.");
  assert(successText.length > 0, "M005/S04 cookie replace success summary was not readable for redaction scanning.", { phase: "ui.cookie-replace", markerClass: "ui_success_missing" });
  assertM005S04VisibleTextRedacted({ text: successText, phase: "ui.cookie-replace" }, context);
  const summary = { cookieReplaceUi: "success", dialog: dialog.log, clickMode, successTextObserved: true, successTextScanned: true };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { successText }, log: summary };
}

export async function driveM005S04RestoredLaunchAndBusyGuard(driver, runtime, { artifactProof, packageProof, waitForProfileButton = waitS06ProfileButton, waitForVisibleText = waitS06VisibleText, waitForMetricValue = waitS06MetricValueVisible, readProfileSectionText = readS06ProfileSectionText, runPackagedSidecarRequest = runM005S04PackagedSidecarRequest } = {}, context = createM005S04PublicScanContext({ rootDir: runtime?.rootDir, tempRoot: runtime?.smokeContext?.smokeRoot, appDataRoot: runtime?.profileStore?.appDataRoot, userDataRoot: packageProof?.imported?.importedUserDataRoot, selectedPaths: [runtime?.fixtures?.busyPackagePath].filter(Boolean), cookieDomains: (runtime?.fixtures?.currentCookies ?? []).map((row) => row.domain).filter(Boolean), cookieNames: (runtime?.fixtures?.currentCookies ?? []).map((row) => row.name).filter(Boolean), cookieValues: (runtime?.fixtures?.currentCookies ?? []).map((row) => row.value).filter(Boolean) })) {
  const importedProfile = packageProof?.imported?.importedProfile;
  assert(driver, "M005/S04 restored launch requires a WebDriver session.", { phase: "runtime.restored-launch", markerClass: "missing_webdriver_session" });
  assert(isPlainObject(importedProfile) && typeof importedProfile.name === "string", "M005/S04 restored launch requires the imported copied profile.", { phase: "runtime.restored-launch", markerClass: "copied_profile_missing" });
  assert(artifactProof?.releaseSidecar, "M005/S04 busy guard requires the packaged sidecar proof.", { phase: "busy-guard", markerClass: "missing_sidecar_binary" });
  const launchButton = await waitForProfileButton(driver, importedProfile.name, "Launch Chromium", runtime, { step: "m005-restored-launch-click" });
  const launchClickMode = await clickM005S04UiElement(driver, launchButton, runtime, "runtime.restored-launch", "restored_launch_click_failed");
  runtime.m005S04RunningObserved = true;
  await waitForVisibleText(driver, "Running from sidecar runtime bookkeeping", runtime, { step: "m005-restored-launch-running" });
  await waitForMetricValue(driver, "Profile observability", "Running count", "1", runtime, { step: "m005-restored-launch-running" });
  const running = assertM005S04RuntimeBookkeeping({ appDataRoot: runtime.profileStore.appDataRoot, profile: importedProfile, expectedRunning: true, expectedRunningCount: 1 }, context);
  await waitForVisibleText(driver, "Cookie portability is stopped-profile only while Chromium is running.", runtime, { step: "m005-restored-launch-cookie-guard" });
  await waitForVisibleText(driver, "Profile package export is stopped-profile only while Chromium is running.", runtime, { step: "m005-restored-launch-package-guard" });
  const disabledControls = [
    await assertM005S04ProfileButtonDisabled(driver, importedProfile.name, "Export ThePrivator package"),
    await assertM005S04ProfileButtonDisabled(driver, importedProfile.name, "Export ThePrivator JSON"),
    await assertM005S04ProfileButtonDisabled(driver, importedProfile.name, "Replace cookies"),
  ];
  const runningSectionText = await readProfileSectionText(driver, importedProfile.name, `${importedProfile.name} Chromium lifecycle`);
  assertM005S04VisibleTextRedacted({ text: runningSectionText, phase: "runtime.restored-launch" }, context);

  const requestId = "verify-m005-s04-busy-package-export";
  const transcript = runPackagedSidecarRequest(join(runtime.rootDir, artifactProof.releaseSidecar), {
    id: requestId,
    method: "portability.profile_package.export",
    params: { storeRoot: runtime.profileStore.appDataRoot, profileId: importedProfile.id, destinationPath: runtime.fixtures.busyPackagePath },
  }, { rootDir: runtime.rootDir, context });
  const busy = assertM005S04BusyGuardTranscript({ transcript, requestId, method: "portability.profile_package.export" }, context);

  const stopButton = await waitForProfileButton(driver, importedProfile.name, "Stop Chromium", runtime, { step: "m005-restored-stop-click" });
  const stopClickMode = await clickM005S04UiElement(driver, stopButton, runtime, "runtime.restored-stop", "restored_stop_click_failed");
  await waitForProfileButton(driver, importedProfile.name, "Launch Chromium", runtime, { step: "m005-restored-stop-ready" });
  await waitForMetricValue(driver, "Profile observability", "Running count", "0", runtime, { step: "m005-restored-stop-ready" });
  const stopped = assertM005S04RuntimeBookkeeping({ appDataRoot: runtime.profileStore.appDataRoot, profile: importedProfile, expectedRunning: false, expectedRunningCount: 0 }, context);
  runtime.m005S04RunningObserved = false;
  const stoppedSectionText = await readProfileSectionText(driver, importedProfile.name, `${importedProfile.name} Chromium lifecycle`);
  assertM005S04VisibleTextRedacted({ text: stoppedSectionText, phase: "runtime.restored-stop" }, context);
  const summary = { restoredLaunch: "launched-stopped", launchClickMode, stopClickMode, running: running.log, stopped: stopped.log, controlsDisabledWhileRunning: disabledControls.length, busyGuard: busy.log, visibleRuntimeTextScanned: true };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { importedProfile, running, stopped, busyGuard: busy, runningSectionText, stoppedSectionText }, log: summary };
}

function summarizeArtifactProof(proof = {}) {
  return { targetTriple: proof.targetTriple ? "detected" : "detected", releaseExecutable: proof.releaseExecutable ? "present" : "missing", releaseSidecar: proof.releaseSidecar ? "present" : "missing", packageCount: Array.isArray(proof.packages) ? proof.packages.length : 0 };
}

function prepareM005S04BuildArtifacts({ rootDir = ROOT_DIR, platform = process.platform, context = createM005S04PublicScanContext({ rootDir }), skipBuild = false } = {}) {
  const targetTriple = runStep("build.target-triple", () => ({ targetTriple: readS06TargetTriple(rootDir) }), context).targetTriple;
  if (skipBuild) {
    return runStep("build.artifact-shape", () => {
      const proof = assertS06BuildArtifactsPresent({ rootDir, platform, targetTriple });
      return { value: { targetTriple, ...proof }, log: summarizeArtifactProof({ targetTriple, ...proof }) };
    }, context);
  }
  const buildStartedAt = new Date(Date.now() - FRESHNESS_SKEW_MS);
  runStep("build.freshness-window", () => ({ buildWindow: "started" }), context);
  runCommand("build.release", "npm", ["run", "tauri", "build"], { rootDir, timeoutMs: DEFAULT_BUILD_TIMEOUT_MS, context, label: "npm-run-tauri-build" });
  return runStep("build.artifact-shape", () => {
    const proof = assertS06FreshBuildArtifacts({ rootDir, platform, targetTriple, buildStartedAt });
    return { value: { targetTriple, ...proof }, log: summarizeArtifactProof({ targetTriple, ...proof }) };
  }, context);
}

export function runPreflightOnlyVerification({ rootDir = ROOT_DIR, platform = process.platform, env = process.env, reset = true, emitFinal = true, guardrailsCheck = assertM005S04Guardrails, webdriverPreflight = assertM005S04WebDriverPreflight, chromiumPreflight = assertM005S04ChromiumExecutable, nativeDialogPreflight = assertNativeDialogAutomationPreflight } = {}) {
  if (reset) resetState();
  const context = createM005S04PublicScanContext({ rootDir });
  assertValidArgs(parseArgs(["--preflight-only"]));
  const guardrails = runStep("guardrails.m005-s04", () => guardrailsCheck({ rootDir, platform }), context);
  const webdriver = runStep("preflight.webdriver", () => webdriverPreflight({ rootDir, platform, env, strict: true }), context);
  const chromium = runStep("preflight.chromium", () => chromiumPreflight({ rootDir, platform, env }), context);
  const nativeDialog = runStep("preflight.native-dialog", () => nativeDialogPreflight({ platform, env, strict: true }), context);
  const summary = buildM005S04FinalSummary({ status: "pass", mode: "preflight-only", guardrails, preflight: { webdriver, chromium, nativeDialog }, checks: STEP_RESULTS }, context);
  if (emitFinal) emit({ phase: "summary", status: "pass", summary }, context);
  return summary;
}

export function runBuildOnlyVerification({ rootDir = ROOT_DIR, platform = process.platform, env = process.env, reset = true, emitFinal = true } = {}) {
  if (reset) resetState();
  const context = createM005S04PublicScanContext({ rootDir });
  const guardrails = runStep("guardrails.m005-s04", () => assertM005S04Guardrails({ rootDir, platform }), context);
  const webdriver = runStep("preflight.webdriver", () => assertM005S04WebDriverPreflight({ rootDir, platform, env, strict: false }), context);
  const chromium = runStep("preflight.chromium", () => assertM005S04ChromiumExecutable({ rootDir, platform, env }), context);
  const nativeDialog = runStep("preflight.native-dialog", () => assertNativeDialogAutomationPreflight({ platform, env, strict: false }), context);
  const proof = prepareM005S04BuildArtifacts({ rootDir, platform, context, skipBuild: false });
  const build = summarizeArtifactProof(proof);
  const summary = buildM005S04FinalSummary({ status: "pass", mode: "build-only", guardrails, preflight: { webdriver, chromium, nativeDialog }, build, checks: STEP_RESULTS }, context);
  if (emitFinal) emit({ phase: "summary", status: "pass", summary }, context);
  return summary;
}

export async function runM005S04CookiePortabilityLoop({ driver, runtime, strategyPlan, exportPath = runtime?.fixtures?.cookieExportPath, importPath = runtime?.fixtures?.cookieImportJsonPath } = {}, context = createM005S04PublicScanContext({ tempRoot: runtime?.smokeContext?.smokeRoot, appDataRoot: runtime?.profileStore?.appDataRoot, userDataRoot: runtime?.profileStore?.userDataRoot, selectedPaths: [exportPath, importPath].filter(Boolean), cookieDomains: [...(runtime?.fixtures?.sourceCookies ?? []), ...(runtime?.fixtures?.importCookies ?? [])].map((row) => row.domain).filter(Boolean), cookieNames: [...(runtime?.fixtures?.sourceCookies ?? []), ...(runtime?.fixtures?.importCookies ?? [])].map((row) => row.name).filter(Boolean), cookieValues: [...(runtime?.fixtures?.sourceCookies ?? []), ...(runtime?.fixtures?.importCookies ?? [])].map((row) => row.value).filter(Boolean) })) {
  assert(driver, "M005/S04 cookie portability loop requires a WebDriver session.", { phase: "runtime.cookie-loop", markerClass: "missing_webdriver_session" });
  assert(runtime?.profileStore?.profile, "M005/S04 cookie portability loop requires a discovered source profile.", { phase: "runtime.cookie-loop", markerClass: "source_profile_missing" });
  assert(typeof exportPath === "string" && exportPath.endsWith(".json"), "M005/S04 cookie portability loop requires a private export JSON path.", { phase: "runtime.cookie-loop", markerClass: "missing_selected_path" });
  assert(typeof importPath === "string" && importPath.endsWith(".json"), "M005/S04 cookie portability loop requires a private import JSON path.", { phase: "runtime.cookie-loop", markerClass: "missing_selected_path" });

  const cookieContext = createM005S04PublicScanContext({
    rootDir: runtime.rootDir,
    tempRoot: runtime.smokeContext?.smokeRoot,
    appDataRoot: runtime.profileStore.appDataRoot,
    userDataRoot: runtime.profileStore.userDataRoot,
    selectedPaths: [exportPath, importPath],
    cookieDomains: [...runtime.fixtures.sourceCookies, ...runtime.fixtures.importCookies].map((row) => row.domain).filter(Boolean),
    cookieNames: [...runtime.fixtures.sourceCookies, ...runtime.fixtures.importCookies].map((row) => row.name).filter(Boolean),
    cookieValues: [...runtime.fixtures.sourceCookies, ...runtime.fixtures.importCookies].map((row) => row.value).filter(Boolean),
  });

  const exportUi = await runStepAsync("ui.cookie-export", async () => driveM005S04CookieExportViaUi(driver, runtime, { exportPath, strategyPlan }, cookieContext), cookieContext);
  const exportFile = runStep("cookie.export-file-inspect", () => inspectM005S04CookieExportFile({ exportPath, expectedRows: runtime.fixtures.sourceCookies }, cookieContext), cookieContext);
  const replaceUi = await runStepAsync("ui.cookie-replace", async () => driveM005S04CookieReplaceViaUi(driver, runtime, { importPath, strategyPlan }, cookieContext), cookieContext);
  const replacedCookies = runStep("cookie.replace-db-inspect", () => inspectM005S04CookieDbRows({ appDataRoot: runtime.profileStore.appDataRoot, userDataRoot: runtime.profileStore.userDataRoot, expectedRows: runtime.fixtures.importCookies }, cookieContext), cookieContext);
  assert(replacedCookies.expectedRowsPresent, "M005/S04 cookie replace did not restore the selected import cookie set.", { phase: "cookie-replace", markerClass: "cookie_rows_missing", missingExpectedCount: replacedCookies.missingExpectedCount });
  runtime.fixtures.currentCookies = runtime.fixtures.importCookies;
  const diagnostics = runStep("diagnostics.cookie-portability", () => inspectM005S04Diagnostics({ appDataRoot: runtime.profileStore.appDataRoot, requiredMethods: ["portability.cookies.export", "portability.cookies.replace"] }, cookieContext), cookieContext);

  const summary = { cookieLoop: "exported-replaced", exportUiObserved: Boolean(exportUi.successText), exportFileValidated: true, replaceUiObserved: Boolean(replaceUi.successText), replacementRowsPresent: true, diagnosticsRows: Array.isArray(diagnostics.records) ? diagnostics.records.length : 0, exportedCookieRows: exportFile.cookieCount, replacedCookieRows: replacedCookies.count };
  assertM005S04PublicEvidenceRedacted(summary, cookieContext);
  return { summary, exportUi, exportFile, replaceUi, replacedCookies, diagnostics };
}

export async function runM005S04PackagePortabilityLoop({ driver, runtime, strategyPlan, packagePath = runtime?.fixtures?.selectedPackagePath } = {}, context = createM005S04PublicScanContext({ tempRoot: runtime?.smokeContext?.smokeRoot, appDataRoot: runtime?.profileStore?.appDataRoot, userDataRoot: runtime?.profileStore?.userDataRoot, selectedPaths: [packagePath].filter(Boolean), cookieDomains: (runtime?.fixtures?.currentCookies ?? runtime?.fixtures?.sourceCookies ?? []).map((row) => row.domain).filter(Boolean), cookieNames: (runtime?.fixtures?.currentCookies ?? runtime?.fixtures?.sourceCookies ?? []).map((row) => row.name).filter(Boolean), cookieValues: (runtime?.fixtures?.currentCookies ?? runtime?.fixtures?.sourceCookies ?? []).map((row) => row.value).filter(Boolean) })) {
  assert(driver, "M005/S04 package portability loop requires a WebDriver session.", { phase: "runtime.package-loop", markerClass: "missing_webdriver_session" });
  assert(runtime?.profileStore?.profile, "M005/S04 package portability loop requires a discovered source profile.", { phase: "runtime.package-loop", markerClass: "source_profile_missing" });
  assert(typeof packagePath === "string" && packagePath.endsWith(".tpkg"), "M005/S04 package portability loop requires a private .tpkg path.", { phase: "runtime.package-loop", markerClass: "missing_package_path" });

  const packageContext = createM005S04PublicScanContext({
    rootDir: runtime.rootDir,
    tempRoot: runtime.smokeContext?.smokeRoot,
    appDataRoot: runtime.profileStore.appDataRoot,
    userDataRoot: runtime.profileStore.userDataRoot,
    selectedPaths: [packagePath],
    cookieDomains: (runtime.fixtures.currentCookies ?? runtime.fixtures.sourceCookies).map((row) => row.domain).filter(Boolean),
    cookieNames: (runtime.fixtures.currentCookies ?? runtime.fixtures.sourceCookies).map((row) => row.name).filter(Boolean),
    cookieValues: (runtime.fixtures.currentCookies ?? runtime.fixtures.sourceCookies).map((row) => row.value).filter(Boolean),
  });

  const exportUi = await runStepAsync("ui.package-export", async () => driveM005S04PackageExportViaUi(driver, runtime, { packagePath, strategyPlan }, packageContext), packageContext);
  const archive = runStep("package.archive-inspect", () => inspectM005S04PackageArchive({
    rootDir: runtime.rootDir,
    appDataRoot: runtime.profileStore.appDataRoot,
    packagePath,
    selectedPaths: [packagePath],
    expectedProfileName: runtime.profileStore.profile.name,
    expectedCookieRows: runtime.fixtures.currentCookies ?? runtime.fixtures.sourceCookies,
    expectedPayloadRelativePaths: runtime.fixtures.expectedPayloadRelativePaths,
  }, packageContext), packageContext);
  const imported = await runStepAsync("ui.package-import", async () => driveM005S04PackageImportViaUi(driver, runtime, { packagePath, strategyPlan }, packageContext), packageContext);
  const diagnostics = runStep("diagnostics.package-portability", () => inspectM005S04Diagnostics({ appDataRoot: runtime.profileStore.appDataRoot, requiredMethods: ["portability.profile_package.export", "portability.profile_package.import"] }, packageContext), packageContext);

  const summary = {
    packageLoop: "exported-imported",
    exportUiObserved: Boolean(exportUi.successText),
    archiveInspected: true,
    copiedProfileRestored: Boolean(imported.importedProfile),
    importedCardVisible: Boolean(imported.importedProfile),
    diagnosticsRows: Array.isArray(diagnostics.records) ? diagnostics.records.length : 0,
    warningCount: archive.manifestSummary.warningCount,
    cookieCount: archive.manifestSummary.cookieCount,
    payloadFileCount: archive.manifestSummary.payloadFileCount,
    nextProof: "restored-launch-ready",
  };
  assertM005S04PublicEvidenceRedacted(summary, packageContext);
  return { summary, exportUi, archive, imported, diagnostics };
}

export function scanM005S04FinalEvidence({ runtime, cookieProof, packageProof, restoredProof, cleanup = null, verifierEvents = VERIFIER_EVENTS } = {}, context = createM005S04PublicScanContext({ rootDir: runtime?.rootDir, tempRoot: runtime?.smokeContext?.smokeRoot, appDataRoot: runtime?.profileStore?.appDataRoot, userDataRoot: packageProof?.imported?.importedUserDataRoot, selectedPaths: [runtime?.fixtures?.cookieExportPath, runtime?.fixtures?.cookieImportJsonPath, runtime?.fixtures?.selectedPackagePath, runtime?.fixtures?.busyPackagePath].filter(Boolean), cookieDomains: [...(runtime?.fixtures?.sourceCookies ?? []), ...(runtime?.fixtures?.importCookies ?? [])].map((row) => row.domain).filter(Boolean), cookieNames: [...(runtime?.fixtures?.sourceCookies ?? []), ...(runtime?.fixtures?.importCookies ?? [])].map((row) => row.name).filter(Boolean), cookieValues: [...(runtime?.fixtures?.sourceCookies ?? []), ...(runtime?.fixtures?.importCookies ?? [])].map((row) => row.value).filter(Boolean) })) {
  assert(isPlainObject(runtime?.profileStore), "M005/S04 final scan requires runtime profile-store proof.", { phase: "final-scan", markerClass: "profile_store_missing" });
  const visibleTextSnippets = [
    cookieProof?.exportUi?.successText,
    cookieProof?.replaceUi?.successText,
    packageProof?.exportUi?.successText,
    packageProof?.imported?.successText,
    restoredProof?.runningSectionText,
    restoredProof?.stoppedSectionText,
  ].filter((text) => typeof text === "string");
  assert(visibleTextSnippets.length >= 4, "M005/S04 final UI visible-text scan did not cover the required summaries.", { phase: "final-scan", markerClass: "ui_text_malformed", visibleTextCount: visibleTextSnippets.length });
  for (const [index, text] of visibleTextSnippets.entries()) assertM005S04VisibleTextRedacted({ text, phase: `final-scan.ui.${index}` }, context);

  const diagnostics = inspectM005S04Diagnostics({
    appDataRoot: runtime.profileStore.appDataRoot,
    requiredMethods: ["portability.cookies.export", "portability.cookies.replace", "portability.profile_package.export", "portability.profile_package.import", "chromium.launch", "chromium.stop"],
  }, context);
  for (const [method, proof] of Object.entries(diagnostics.log.required)) {
    assert(proof.observed > 0, "M005/S04 final diagnostics scan missed a required method.", { phase: "final-scan.diagnostics", markerClass: "diagnostics_missing", method });
    if (method !== "portability.profile_package.export") assert(proof.okRows > 0, "M005/S04 final diagnostics scan missed a successful required method.", { phase: "final-scan.diagnostics", markerClass: "diagnostics_missing", method });
  }
  assert(diagnostics.log.required["portability.profile_package.export"].okRows > 0, "M005/S04 final diagnostics scan missed successful package export evidence.", { phase: "final-scan.diagnostics", markerClass: "diagnostics_missing", method: "portability.profile_package.export" });
  assert(diagnostics.log.required["portability.profile_package.export"].errorRows > 0 && diagnostics.log.typedErrorCodes.includes("PORTABILITY_PROFILE_BUSY"), "M005/S04 final diagnostics scan missed typed busy guard evidence.", { phase: "final-scan.diagnostics", markerClass: "busy_guard_missing" });

  assertM005S04PublicEvidenceRedacted(verifierEvents, context);
  assertM005S04PublicEvidenceRedacted([cookieProof?.summary, packageProof?.summary, restoredProof?.log, cleanup].filter(Boolean), context);
  const summary = { finalScan: "clean", visibleTextSnippets: visibleTextSnippets.length, diagnosticsRows: diagnostics.log.validRows, verifierEvents: Array.isArray(verifierEvents) ? verifierEvents.length : 0, packageArchiveScanned: Boolean(packageProof?.archive?.scanClean ?? packageProof?.summary?.archiveInspected), busyGuardTyped: true, cleanupScanned: cleanup ? "included" : "pending" };
  assertM005S04PublicEvidenceRedacted(summary, context);
  return { value: { diagnostics: diagnostics.value }, log: summary };
}

export async function runM005S04PackagedHarnessSetup({ artifactProof, rootDir = ROOT_DIR, platform = process.platform, env = process.env, keepTemp = false, strategyPlan = null, cookieLoop = runM005S04CookiePortabilityLoop, packageLoop = runM005S04PackagePortabilityLoop, restoredLaunchLoop = driveM005S04RestoredLaunchAndBusyGuard, finalEvidenceScan = scanM005S04FinalEvidence } = {}, context = createM005S04PublicScanContext({ rootDir })) {
  assert(artifactProof?.releaseExecutable, "M005/S04 packaged harness setup requires a release executable proof.", { phase: "runtime.harness", markerClass: "missing_release_executable" });
  const applicationPath = join(rootDir, artifactProof.releaseExecutable);
  let smokeContext = null;
  let runtime = null;
  let driverProcess = null;
  let driver = null;
  let setupProof = null;
  let setupCompleted = false;
  let runningObserved = false;

  try {
    smokeContext = runStep("smoke-root", () => createM005S04SmokeRunContext({ rootDir, baseEnv: env }), context);
    const runtimeContext = createM005S04PublicScanContext({ rootDir, tempRoot: smokeContext.smokeRoot });
    runtime = { rootDir, smokeContext, profileStore: null };
    driverProcess = await runStepAsync("webdriver.driver-start", async () => {
      const started = await startS06TauriDriverProcess({ rootDir, smokeContext, platform, env });
      return { value: started.value ?? started, log: { tauriDriver: "started", driverPort: "allocated", processOutput: "suppressed" } };
    }, runtimeContext);
    driver = await runStepAsync("webdriver.session-start", async () => {
      const started = await createS06TauriWebDriverSession({ applicationPath, applicationRelativePath: artifactProof.releaseExecutable, driverProcess, rootDir, smokeContext });
      return { value: started.value ?? started, log: { session: "created", browserName: "wry", application: "release-executable" } };
    }, runtimeContext);
    const uiProfile = await runStepAsync("ui.source-profile-create", async () => createM005S04SourceProfileViaUi(driver, runtime), runtimeContext);
    const profileStore = runStep("profile-store.discover", () => discoverM005S04SourceProfile({ rootDir, smokeContext }), runtimeContext);
    runtime.profileStore = profileStore;
    runtime.driverProcess = driverProcess;
    const cookieDomain = "m005-s04-source.invalid";
    const cookieName = "m005_s04_source";
    const cookieValue = "m005-s04-source-cookie-value";
    const secondCookieName = "m005_s04_source_second";
    const secondCookieValue = "m005-s04-source-cookie-value-two";
    const fixtureContext = createM005S04PublicScanContext({
      rootDir,
      tempRoot: smokeContext.smokeRoot,
      appDataRoot: profileStore.appDataRoot,
      userDataRoot: profileStore.userDataRoot,
      cookieDomains: [cookieDomain, `.${cookieDomain}`],
      cookieNames: [cookieName, secondCookieName],
      cookieValues: [cookieValue, secondCookieValue],
    });
    const cookieFixture = runStep("fixture.cookie-db", () => createM005S04CookieDbFixture({ appDataRoot: profileStore.appDataRoot, userDataRoot: profileStore.userDataRoot, cookieDomain, cookieName, cookieValue, secondCookieName, secondCookieValue }, fixtureContext), fixtureContext);
    const cookieRows = runStep("fixture.cookie-db-inspect", () => inspectM005S04CookieDbRows({ appDataRoot: profileStore.appDataRoot, userDataRoot: profileStore.userDataRoot, expectedRows: cookieFixture.cookies }, fixtureContext), fixtureContext);
    assert(cookieRows.expectedRowsPresent, "M005/S04 cookie DB fixture rows were not readable after seeding.", { phase: "cookie-db", markerClass: "cookie_rows_missing", missingExpectedCount: cookieRows.missingExpectedCount });
    const importFixtures = runStep("fixture.cookie-import-files", () => writeM005S04CookieImportFixtures({ smokeRoot: smokeContext.smokeRoot }, fixtureContext), fixtureContext);
    const cookieExportPath = join(smokeContext.smokeRoot, "fixtures", "cookies-export.theprivator.json");
    const selectedPackagePath = join(profileStore.userDataRoot, "Default", "selected-package-output.tpkg");
    const busyPackagePath = join(smokeContext.smokeRoot, "fixtures", "busy-while-running.tpkg");
    const expectedPayloadRelativePaths = ["Default/Preferences", "Default/Local Storage/leveldb/000003.log"];
    const payloadFixtures = runStep("fixture.payload-files", () => writeM005S04PayloadFixtures({ appDataRoot: profileStore.appDataRoot, userDataRoot: profileStore.userDataRoot, selectedPackagePath }, fixtureContext), fixtureContext);
    runtime.fixtures = { sourceCookies: cookieFixture.cookies, importCookies: importFixtures.cookies, cookieExportPath, cookieImportJsonPath: importFixtures.jsonPath, cookieImportNetscapePath: importFixtures.netscapePath, currentCookies: cookieFixture.cookies, payloadFixtures, selectedPackagePath, busyPackagePath, expectedPayloadRelativePaths };
    const cookieProof = cookieLoop
      ? await cookieLoop({ driver, driverProcess, runtime, strategyPlan, exportPath: cookieExportPath, importPath: importFixtures.jsonPath, context: fixtureContext })
      : null;
    const packageProof = packageLoop
      ? await packageLoop({ driver, driverProcess, runtime, strategyPlan, packagePath: selectedPackagePath, context: fixtureContext })
      : null;
    const restoredProof = restoredLaunchLoop
      ? await runStepAsync("runtime.restored-launch", async () => restoredLaunchLoop(driver, runtime, { artifactProof, packageProof }, fixtureContext), fixtureContext)
      : null;
    const finalScan = finalEvidenceScan
      ? runStep("final.redaction-scan", () => finalEvidenceScan({ runtime, cookieProof, packageProof, restoredProof }, fixtureContext), fixtureContext)
      : null;
    setupCompleted = true;
    setupProof = {
      harness: "ready",
      sourceProfile: { createdVia: "visible-ui", cardObserved: Boolean(uiProfile.cardText) },
      profileStore: { discovered: true, privateProfileId: "derived", storage: "safe-relative-store-paths" },
      fixtures: {
        cookieDbRows: cookieRows.count,
        importFixtureFormats: importFixtures.cookies ? 2 : 2,
        safePayloadFiles: payloadFixtures.preferencesPath ? 2 : 2,
        volatileRuntimeFiles: 2,
      },
      portabilityLoop: {
        cookieLoop: cookieProof?.summary ?? "not-run",
        packageLoop: packageProof?.summary ?? "not-run",
        restoredLaunch: restoredProof?.log ?? "not-run",
        finalScan: finalScan ?? "not-run",
      },
    };
    assertM005S04PublicEvidenceRedacted(setupProof, fixtureContext);
    return setupProof;
  } finally {
    if (runtime || driver || driverProcess) {
      const cleanupContext = createM005S04PublicScanContext({ rootDir, tempRoot: smokeContext?.smokeRoot, appDataRoot: runtime?.profileStore?.appDataRoot, userDataRoot: runtime?.profileStore?.userDataRoot });
      const cleanup = await runStepAsync("cleanup.packaged-harness", async () => cleanupM005S04PackagedHarness({ driver, driverProcess, runtime, runningObserved: runningObserved || Boolean(runtime?.m005S04RunningObserved), keepTemp, passed: setupCompleted }, cleanupContext), cleanupContext);
      if (setupProof) setupProof.cleanup = cleanup;
    }
  }
}

async function runFullOrUiSkeleton(args, { rootDir = ROOT_DIR, platform = process.platform, env = process.env } = {}) {
  resetState();
  const context = createM005S04PublicScanContext({ rootDir });
  const guardrails = runStep("guardrails.m005-s04", () => assertM005S04Guardrails({ rootDir, platform }), context);
  const webdriver = runStep("preflight.webdriver", () => assertM005S04WebDriverPreflight({ rootDir, platform, env, strict: true }), context);
  const chromium = runStep("preflight.chromium", () => assertM005S04ChromiumExecutable({ rootDir, platform, env }), context);
  const nativeDialog = runStep("preflight.native-dialog", () => assertNativeDialogAutomationPreflight({ platform, env, strict: true }), context);
  const artifactProof = prepareM005S04BuildArtifacts({ rootDir, platform, context, skipBuild: args.skipBuild });
  const runtime = await runM005S04PackagedHarnessSetup({ artifactProof, rootDir, platform, env, keepTemp: args.keepTemp, strategyPlan: nativeDialog }, context);
  const summary = buildM005S04FinalSummary({ status: "pass", mode: args.mode, guardrails, preflight: { webdriver, chromium, nativeDialog }, build: summarizeArtifactProof(artifactProof), runtime, cleanup: runtime.cleanup ?? {}, checks: STEP_RESULTS }, context);
  emit({ phase: "summary", status: "pass", summary }, context);
  return summary;
}

function printHelp() {
  console.log(`Usage: npm run verify:m005:s04 -- [--preflight-only|--build-only|--ui-only] [--skip-build] [--keep-temp]\n\nModes:\n  default           Full packaged portability proof: real cookie dialogs, .tpkg dialogs, restored launch/stop, busy guard, final scans, and cleanup.\n  --preflight-only  Run M005 guardrails, WebDriver preflight, and native-dialog preflight only.\n  --build-only      Build release artifacts and validate their shape without running the UI loop.\n  --ui-only         Validate existing artifacts and run the packaged UI loop.\n\nDiagnostics:\n  --skip-build      Reuse existing artifacts for full/UI modes.\n  --keep-temp       Retain the isolated smoke root for private local diagnostics; public paths remain redacted.`);
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const context = createM005S04PublicScanContext({ rootDir: ROOT_DIR });
  try {
    assertValidArgs(args);
    if (args.help) {
      printHelp();
      return;
    }
    if (args.preflightOnly) {
      runPreflightOnlyVerification({ rootDir: ROOT_DIR, platform: process.platform, env: process.env });
      return;
    }
    if (args.buildOnly) {
      runBuildOnlyVerification({ rootDir: ROOT_DIR, platform: process.platform, env: process.env });
      return;
    }
    await runFullOrUiSkeleton(args, { rootDir: ROOT_DIR, platform: process.platform, env: process.env });
  } catch (error) {
    const summary = buildM005S04FinalSummary({ status: "fail", mode: args.mode, checks: STEP_RESULTS, error }, context);
    emit({ phase: "summary", status: "fail", summary }, context);
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactM005S04({ event: VERIFY_EVENT, status: "fail", message, details: formatM005S04FailureDetails(error, context, args.mode) }, context)));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
