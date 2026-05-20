#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter as hostPathDelimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT_DIR, VerifyFailure, executable } from "./verify-m004-s01.mjs";
import {
  assertBuildArtifactsPresent as assertS06BuildArtifactsPresent,
  assertFreshBuildArtifacts as assertS06FreshBuildArtifacts,
  assertWebDriverPreflight as assertS06WebDriverPreflight,
  readTargetTriple as readS06TargetTriple,
} from "./verify-s06.mjs";

export const VERIFY_EVENT = "verify.m005.s04";
export const SIDECAR_EXTERNAL_BIN = "binaries/theprivator-sidecar";
export const DEFAULT_BUILD_TIMEOUT_MS = Number(process.env.VERIFY_M005_S04_BUILD_TIMEOUT_MS ?? 20 * 60_000);
export const DEFAULT_COMMAND_TIMEOUT_MS = Number(process.env.VERIFY_M005_S04_COMMAND_TIMEOUT_MS ?? 30_000);

const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];
const REDACTED_VALUE = "<redacted>";
const FRESHNESS_SKEW_MS = 1_500;
const LINUX_WEBDRIVER_TOOL_CLASSES = Object.freeze(["tauri-driver", "WebKitWebDriver", "Chromium"]);
const WAYLAND_TYPE_TOOL = "wtype";
const WAYLAND_CLIPBOARD_TOOLS = Object.freeze(["wl-copy", "wl-paste"]);
const X11_TYPE_TOOL = "xdotool";
const X11_CLIPBOARD_TOOLS = Object.freeze(["xclip", "xsel"]);

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

  const appSource = readFileSync(assertFileExists(rootDir, "src/App.tsx"), "utf8");
  assert(appSource.includes("@tauri-apps/plugin-dialog"), "React UI must use native open/save dialogs for portability path selection.", { phase: "source-guardrail", fileLabel: "src/App.tsx", markerClass: "missing_native_dialogs" });
  assert(/\bopen\s*\(/.test(appSource) && /\bsave\s*\(/.test(appSource), "React UI must keep native open and save dialog calls.", { phase: "source-guardrail", fileLabel: "src/App.tsx", markerClass: "missing_native_dialogs" });
  assert(!FRONTEND_FILESYSTEM_AUTHORITY_PATTERN.test(appSource), "React portability UI must not gain frontend filesystem authority.", { phase: "source-guardrail", fileLabel: "src/App.tsx", markerClass: "frontend_filesystem_authority" });
  assert(!FRONTEND_SHELL_OPEN_AUTHORITY_PATTERN.test(appSource), "React portability UI must not gain shell-open authority.", { phase: "source-guardrail", fileLabel: "src/App.tsx", markerClass: "shell_open_authority" });
  for (const command of FIXED_TAURI_COMMANDS) assert(!appSource.includes(`"${command}"`) && !appSource.includes(`'${command}'`), "React UI must call typed client wrappers instead of raw invoke command names.", { phase: "source-guardrail", fileLabel: "src/App.tsx", markerClass: "raw_invoke_in_ui" });
  for (const wrapper of ["exportProfileCookies", "replaceProfileCookies", "exportProfilePackage", "importProfilePackage"]) assert(appSource.includes(wrapper), "React UI must use typed cookie/package portability wrappers.", { phase: "source-guardrail", fileLabel: "src/App.tsx", markerClass: "missing_typed_wrapper" });

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

export function assertM005S04Guardrails({ rootDir = ROOT_DIR, platform = process.platform } = {}) {
  return { capability: assertM005S04CapabilityConfig({ rootDir }), tauriConfig: assertM005S04TauriConfig({ rootDir, platform }), source: assertM005S04SourceGuardrails({ rootDir }) };
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

  const waylandTypePresent = hasWayland && commandExists(WAYLAND_TYPE_TOOL, toolOptions);
  const waylandClipboardPresent = hasWayland && WAYLAND_CLIPBOARD_TOOLS.every((tool) => commandExists(tool, toolOptions));
  if (hasWayland && waylandTypePresent) {
    return { platform, strategy: "wayland", status: "available", display: "wayland", tools: [safeToolStatus(WAYLAND_TYPE_TOOL, true), ...WAYLAND_CLIPBOARD_TOOLS.map((tool) => safeToolStatus(tool, waylandClipboardPresent))], clipboard: waylandClipboardPresent ? "wl-clipboard" : "typing-only", missing: [], dialogs: [{ dialog: "save", selected: true, extension: "json" }, { dialog: "open", selected: true, extension: "tpkg" }] };
  }
  if (hasWayland && !waylandTypePresent) missing.push(missingTool(WAYLAND_TYPE_TOOL, "wayland-type", "Install wtype for Wayland native-dialog automation."));

  const x11TypePresent = hasX11 && commandExists(X11_TYPE_TOOL, toolOptions);
  const x11ClipboardTool = hasX11 ? X11_CLIPBOARD_TOOLS.find((tool) => commandExists(tool, toolOptions)) : null;
  if (hasX11 && x11TypePresent && x11ClipboardTool) {
    return { platform, strategy: "x11", status: "available", display: "x11", tools: [safeToolStatus(X11_TYPE_TOOL, true), safeToolStatus(x11ClipboardTool, true)], clipboard: x11ClipboardTool, missing: [], dialogs: [{ dialog: "save", selected: true, extension: "json" }, { dialog: "open", selected: true, extension: "tpkg" }] };
  }
  if (hasX11 && !x11TypePresent) missing.push(missingTool(X11_TYPE_TOOL, "x11-type", "Install xdotool for X11 native-dialog automation."));
  if (hasX11 && !x11ClipboardTool) missing.push(missingTool("xclip-or-xsel", "x11-clipboard", "Install xclip or xsel for X11 native-dialog clipboard fallback."));

  return { platform, strategy: "unavailable", status: "missing", display: hasWayland ? "wayland" : hasX11 ? "x11" : "missing", tools: [], missing, dialogs: [] };
}

export function assertNativeDialogAutomationPreflight(options = {}) {
  const strict = options.strict ?? true;
  const plan = planNativeDialogAutomation(options);
  if (strict && plan.missing.length > 0) {
    fail("M005/S04 native-dialog automation preflight failed.", { phase: "preflight.native-dialog", markerClass: "missing_native_dialog_tool", missing: plan.missing.map((item) => ({ name: item.name, toolClass: item.toolClass })), remediation: "Install the missing native-dialog automation tool class for the active Linux desktop session." });
  }
  return { strategy: plan.strategy, status: plan.status, display: plan.display, clipboard: plan.clipboard ?? null, missingToolClasses: plan.missing.map((item) => item.toolClass), dialogs: plan.dialogs };
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
  const commandPlan = { ...selection, strategy, steps: strategy === "wayland" ? ["focus-dialog", strategyPlan?.clipboard === "wl-clipboard" ? "clipboard-load" : "type-selection", "confirm-selection"] : strategy === "x11" ? ["focus-dialog", "clipboard-load", "confirm-selection"] : [] };
  assertM005S04PublicEvidenceRedacted(commandPlan);
  return commandPlan;
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
    guardrails: { capability: guardrails.capability ? "pass" : undefined, tauriConfig: guardrails.tauriConfig ? "pass" : undefined, source: guardrails.source ? "pass" : undefined, permissions: guardrails.capability?.permissions, dialogOpenSave: guardrails.capability?.dialogOpenSave, fixedSidecarSpawn: guardrails.capability?.fixedSidecarSpawn },
    preflight: { webdriver: preflight.webdriver ? { status: preflight.webdriver.missingToolClasses?.length ? "missing" : "available", display: preflight.webdriver.display, missingToolClasses: preflight.webdriver.missingToolClasses ?? [] } : undefined, nativeDialog: preflight.nativeDialog ? { status: preflight.nativeDialog.status, strategy: preflight.nativeDialog.strategy, display: preflight.nativeDialog.display, missingToolClasses: preflight.nativeDialog.missingToolClasses ?? [] } : undefined },
    build,
    runtime,
    cleanup,
    checks: checks.map((check) => ({ name: check.name, status: check.status, durationMs: check.durationMs })),
    error: error ? formatM005S04FailureDetails(error, context, mode) : null,
  }, context);
  assertM005S04PublicEvidenceRedacted(summary, context);
  return summary;
}

export function runPreflightOnlyVerification({ rootDir = ROOT_DIR, platform = process.platform, env = process.env, reset = true, emitFinal = true, guardrailsCheck = assertM005S04Guardrails, webdriverPreflight = assertM005S04WebDriverPreflight, nativeDialogPreflight = assertNativeDialogAutomationPreflight } = {}) {
  if (reset) resetState();
  const context = createM005S04PublicScanContext({ rootDir });
  assertValidArgs(parseArgs(["--preflight-only"]));
  const guardrails = runStep("guardrails.m005-s04", () => guardrailsCheck({ rootDir, platform }), context);
  const webdriver = runStep("preflight.webdriver", () => webdriverPreflight({ rootDir, platform, env, strict: true }), context);
  const nativeDialog = runStep("preflight.native-dialog", () => nativeDialogPreflight({ platform, env, strict: true }), context);
  const summary = buildM005S04FinalSummary({ status: "pass", mode: "preflight-only", guardrails, preflight: { webdriver, nativeDialog }, checks: STEP_RESULTS }, context);
  if (emitFinal) emit({ phase: "summary", status: "pass", summary }, context);
  return summary;
}

export function runBuildOnlyVerification({ rootDir = ROOT_DIR, platform = process.platform, env = process.env, reset = true, emitFinal = true } = {}) {
  if (reset) resetState();
  const context = createM005S04PublicScanContext({ rootDir });
  const guardrails = runStep("guardrails.m005-s04", () => assertM005S04Guardrails({ rootDir, platform }), context);
  runStep("preflight.webdriver", () => assertM005S04WebDriverPreflight({ rootDir, platform, env, strict: false }), context);
  runStep("preflight.native-dialog", () => assertNativeDialogAutomationPreflight({ platform, env, strict: false }), context);
  const targetTriple = runStep("build.target-triple", () => ({ targetTriple: readS06TargetTriple(rootDir) }), context).targetTriple;
  const buildStartedAt = new Date(Date.now() - FRESHNESS_SKEW_MS);
  runStep("build.freshness-window", () => ({ buildStartedAt: buildStartedAt.toISOString() }), context);
  runCommand("build.release", "npm", ["run", "tauri", "build"], { rootDir, timeoutMs: DEFAULT_BUILD_TIMEOUT_MS, context, label: "npm-run-tauri-build" });
  const artifacts = runStep("build.artifact-shape", () => {
    const proof = assertS06FreshBuildArtifacts({ rootDir, platform, targetTriple, buildStartedAt });
    return { releaseExecutable: "present", releaseSidecar: "present", packageCount: proof.packages.length };
  }, context);
  const summary = buildM005S04FinalSummary({ status: "pass", mode: "build-only", guardrails, build: { targetTriple: "detected", ...artifacts }, checks: STEP_RESULTS }, context);
  if (emitFinal) emit({ phase: "summary", status: "pass", summary }, context);
  return summary;
}

function summarizeExistingArtifacts({ rootDir = ROOT_DIR, platform = process.platform } = {}) {
  const targetTriple = readS06TargetTriple(rootDir);
  const artifacts = assertS06BuildArtifactsPresent({ rootDir, platform, targetTriple });
  return { targetTriple: "detected", releaseExecutable: "present", releaseSidecar: "present", packageCount: artifacts.packages.length };
}

async function runFullOrUiSkeleton(args, { rootDir = ROOT_DIR, platform = process.platform, env = process.env } = {}) {
  resetState();
  const context = createM005S04PublicScanContext({ rootDir });
  const guardrails = runStep("guardrails.m005-s04", () => assertM005S04Guardrails({ rootDir, platform }), context);
  const webdriver = runStep("preflight.webdriver", () => assertM005S04WebDriverPreflight({ rootDir, platform, env, strict: true }), context);
  const nativeDialog = runStep("preflight.native-dialog", () => assertNativeDialogAutomationPreflight({ platform, env, strict: true }), context);
  let build = {};
  if (args.skipBuild) build = runStep("build.artifact-shape", () => summarizeExistingArtifacts({ rootDir, platform }), context);
  else build = runBuildOnlyVerification({ rootDir, platform, env, reset: false, emitFinal: false }).build ?? {};
  fail("M005/S04 packaged UI runtime loop is not implemented in this skeleton task yet.", { phase: "runtime.loop", markerClass: "runtime_loop_pending", mode: args.mode, preflight: { webdriver: webdriver.missingToolClasses.length === 0, nativeDialog: nativeDialog.status }, build: build.packageCount === undefined ? "not-run" : "available", outputSuppressed: true });
}

function printHelp() {
  console.log(`Usage: npm run verify:m005:s04 -- [--preflight-only|--build-only|--ui-only] [--skip-build] [--keep-temp]\n\nModes:\n  default           Full packaged portability proof; later S04 tasks fill in the UI runtime loop.\n  --preflight-only  Run M005 guardrails, WebDriver preflight, and native-dialog preflight only.\n  --build-only      Build release artifacts and validate their shape without running the UI loop.\n  --ui-only         Validate existing artifacts and run the packaged UI loop.\n\nDiagnostics:\n  --skip-build      Reuse existing artifacts for full/UI modes.\n  --keep-temp       Reserved for later runtime cleanup diagnostics; paths remain redacted.`);
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
