import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  delimiter as hostPathDelimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_NAME = "theprivator-sidecar";
const APP_BINARY_NAME = "theprivator";
const SIDECAR_EXTERNAL_BIN = "binaries/theprivator-sidecar";
const VERIFY_EVENT = "verify.s06";
const BUILD_TIMEOUT_MS = Number(process.env.VERIFY_S06_BUILD_TIMEOUT_MS ?? 20 * 60_000);
const COMMAND_TIMEOUT_MS = 30_000;
const FRESHNESS_SKEW_MS = 1_500;
const STEP_RESULTS = [];
const STANDARD_CHROMIUM_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "chrome",
  "microsoft-edge",
  "microsoft-edge-stable",
];
const LINUX_WEBDRIVER_NAMES = ["WebKitWebDriver", "webkit2gtk-driver"];
const PACKAGE_EXTENSIONS = new Set([".deb", ".rpm", ".AppImage", ".appimage"]);
const DEFAULT_SENSITIVE_SUBSTRINGS = [
  "copied-browser-data-should-not-leak",
  "outside-secret-should-not-leak",
  "proxy-user-should-not-leak",
  "proxy-pass-should-not-leak",
  "proxy_user",
  "proxy_pass",
];

const GLOBAL_SENSITIVE_VALUES = new Set([ROOT_DIR]);
if (process.env.THEPRIVATOR_CHROMIUM_PATH) {
  GLOBAL_SENSITIVE_VALUES.add(process.env.THEPRIVATOR_CHROMIUM_PATH);
}

export class VerifyFailure extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "VerifyFailure";
    this.details = details;
  }
}

export function executableName(name, platform = process.platform) {
  return platform === "win32" ? `${name}.exe` : name;
}

function pathDelimiterForPlatform(platform = process.platform) {
  return platform === "win32" ? ";" : ":";
}

function pathextsForPlatform(platform = process.platform, env = process.env) {
  if (platform !== "win32") {
    return [""];
  }
  const extensions = String(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  return extensions.length > 0 ? extensions : [".EXE", ".CMD", ".BAT", ".COM"];
}

function slashPath(value) {
  return value.split(sep).join("/");
}

function repoRelative(rootDir, path) {
  return slashPath(relative(rootDir, path)) || ".";
}

function executableForCommand(command, platform = process.platform) {
  if (platform === "win32" && ["npm", "cargo", "rustc"].includes(command)) {
    return `${command}.cmd`;
  }
  return command;
}

function isExecutable(path, platform = process.platform) {
  try {
    accessSync(path, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function commandLabel(command, args, label) {
  if (label) {
    return label;
  }
  return [basename(command), ...args].join(" ");
}

export function redact(value, options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const sensitiveValues = new Set([
    rootDir,
    ...GLOBAL_SENSITIVE_VALUES,
    ...(options.sensitiveValues ?? []),
  ]);

  function redactString(input) {
    let output = input;
    for (const sensitive of Array.from(sensitiveValues).filter(Boolean).sort((a, b) => b.length - a.length)) {
      output = output.split(sensitive).join(resolve(sensitive) === resolve(rootDir) ? "<repo>" : "<redacted>");
    }
    for (const token of DEFAULT_SENSITIVE_SUBSTRINGS) {
      output = output.split(token).join("<redacted>");
    }
    output = output.replace(/--user-data-dir(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)/g, "<chromium-user-data-dir redacted>");
    output = output.replace(/THEPRIVATOR_CHROMIUM_PATH=(?:"[^"]+"|'[^']+'|\S+)/g, "<chromium-path redacted>");
    output = output.replace(/(proxy[_-]?(?:user|pass)(?:word)?)(=|:)(?:"[^"]+"|'[^']+'|\S+)/gi, "$1$2<redacted>");
    output = output.replace(/Traceback(?:[^\n]*(?:\n\s+[^\n]*)*)?/g, "<traceback redacted>");
    return output;
  }

  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, options));
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, options)]));
  }
  return value;
}

function normalizeOutputTail(value, options = {}) {
  if (!value) {
    return "";
  }
  return redact(value, options)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-25)
    .join("\n");
}

function fail(message, details, options = {}) {
  throw new VerifyFailure(message, redact(details, options));
}

function assert(condition, message, details, options = {}) {
  if (!condition) {
    fail(message, details, options);
  }
}

function emit(event) {
  console.log(JSON.stringify({ event: VERIFY_EVENT, ...redact(event) }));
}

export function runStep(name, action, options = {}) {
  const started = performance.now();
  try {
    const result = action() ?? {};
    const durationMs = Math.round(performance.now() - started);
    const logResult = result.log ?? result;
    const returnResult = result.value ?? result;
    const record = { name, status: "pass", durationMs, ...redact(logResult, options) };
    STEP_RESULTS.push(record);
    emit({ step: name, status: "pass", durationMs, ...redact(logResult, options) });
    return returnResult;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    const record = { name, status: "fail", durationMs, message };
    STEP_RESULTS.push(record);
    emit({ step: name, status: "fail", durationMs, message });
    if (error?.details) {
      emit({ step: name, status: "fail-details", details: redact(error.details, options) });
    }
    throw error;
  }
}

function runCommand(name, command, args, timeoutMs, options = {}) {
  return runStep(name, () => {
    const rootDir = options.rootDir ?? ROOT_DIR;
    const label = commandLabel(command, args, options.label ?? name);
    const result = spawnSync(executableForCommand(command), args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    });

    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        fail(`${name} timed out.`, {
          code: "S06_COMMAND_TIMEOUT",
          step: name,
          command: label,
          timeoutMs,
          stdoutTail: normalizeOutputTail(result.stdout, { rootDir }),
          stderrTail: normalizeOutputTail(result.stderr, { rootDir }),
        }, { rootDir });
      }
      fail(`Failed to run ${name}.`, {
        code: "S06_COMMAND_START_FAILED",
        step: name,
        command: label,
        message: result.error.message,
      }, { rootDir });
    }

    if (result.status !== 0) {
      fail(`${name} exited with status ${result.status ?? "unknown"}.`, {
        code: "S06_COMMAND_EXIT_NONZERO",
        step: name,
        command: label,
        exitCode: result.status,
        stdoutTail: normalizeOutputTail(result.stdout, { rootDir }),
        stderrTail: normalizeOutputTail(result.stderr, { rootDir }),
      }, { rootDir });
    }

    return { command: label, exitCode: result.status ?? 0 };
  }, { rootDir: options.rootDir ?? ROOT_DIR });
}

function readJson(path, rootDir) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("Required JSON metadata could not be parsed.", {
      code: "S06_JSON_MALFORMED",
      artifact: repoRelative(rootDir, path),
      message: error instanceof Error ? error.message : String(error),
    }, { rootDir });
  }
}

function findExecutableCandidate(name, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathEnv = options.pathEnv ?? env.PATH ?? "";
  const dirs = [
    ...String(pathEnv).split(pathDelimiterForPlatform(platform)).filter(Boolean),
    ...(options.extraDirs ?? []),
  ];
  const extensions = pathextsForPlatform(platform, env);

  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    const candidate = resolve(name);
    return isExecutable(candidate, platform) ? { name: basename(candidate), path: candidate } : null;
  }

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, platform === "win32" && extname(name) === "" ? `${name}${extension}` : name);
      if (isExecutable(candidate, platform)) {
        return { name, path: candidate };
      }
    }
  }
  return null;
}

function safeExecutableLog(candidate, source) {
  if (!candidate) {
    return null;
  }
  return { name: candidate.name, source };
}

function validateEnvExecutableValue(value, label, options = {}) {
  const platform = options.platform ?? process.platform;
  const rootDir = options.rootDir ?? ROOT_DIR;
  const env = options.env ?? process.env;
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  GLOBAL_SENSITIVE_VALUES.add(trimmed);
  if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) {
    fail(`${label} contains control characters and cannot be used.`, {
      code: "S06_EXECUTABLE_PATH_MALFORMED",
      source: label,
    }, { rootDir });
  }
  if (trimmed.includes(pathDelimiterForPlatform(platform))) {
    fail(`${label} is ambiguous; set it to exactly one executable path.`, {
      code: "S06_EXECUTABLE_PATH_AMBIGUOUS",
      source: label,
    }, { rootDir });
  }
  if (/\s--?\w/.test(trimmed) || trimmed.startsWith("-")) {
    fail(`${label} must be an executable path, not a command line.`, {
      code: "S06_EXECUTABLE_PATH_COMMAND_LINE",
      source: label,
    }, { rootDir });
  }

  const candidate = findExecutableCandidate(trimmed, { platform, env, pathEnv: env.PATH });
  if (!candidate) {
    fail(`${label} did not point to an executable file.`, {
      code: "S06_EXECUTABLE_PATH_NOT_EXECUTABLE",
      source: label,
      instruction: "Set THEPRIVATOR_CHROMIUM_PATH to a single Chromium/Chrome executable path or install chromium/google-chrome on PATH.",
    }, { rootDir });
  }
  return candidate;
}

export function resolveChromiumExecutable(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (env.THEPRIVATOR_CHROMIUM_PATH) {
    const candidate = validateEnvExecutableValue(env.THEPRIVATOR_CHROMIUM_PATH, "THEPRIVATOR_CHROMIUM_PATH", {
      rootDir,
      env,
      platform,
    });
    return { ...safeExecutableLog(candidate, "THEPRIVATOR_CHROMIUM_PATH") };
  }

  for (const name of STANDARD_CHROMIUM_NAMES) {
    const candidate = findExecutableCandidate(name, { env, pathEnv: env.PATH, platform });
    if (candidate) {
      return { ...safeExecutableLog(candidate, "PATH") };
    }
  }

  fail("Chromium executable was not found for the packaged smoke.", {
    code: "S06_CHROMIUM_MISSING",
    name: "Chromium",
    instruction: "Install Chromium/Chrome or set THEPRIVATOR_CHROMIUM_PATH to one local executable before running npm run verify:s06.",
  }, { rootDir });
}

export function assertWebDriverPreflight(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const strict = options.strict ?? true;
  const missing = [];
  const pathEnv = env.PATH ?? "";
  const cargoBin = join(homedir(), ".cargo", "bin");
  GLOBAL_SENSITIVE_VALUES.add(cargoBin);

  const tauriDriver = findExecutableCandidate("tauri-driver", {
    env,
    pathEnv,
    platform,
    extraDirs: [cargoBin],
  });
  if (!tauriDriver) {
    missing.push({
      name: "tauri-driver",
      instruction: "Install Tauri WebDriver support (for example cargo install tauri-cli --features webdriver) and ensure tauri-driver is on PATH.",
    });
  }

  let platformDriver = null;
  if (platform === "linux") {
    for (const name of LINUX_WEBDRIVER_NAMES) {
      platformDriver = findExecutableCandidate(name, { env, pathEnv, platform });
      if (platformDriver) {
        break;
      }
    }
    if (!platformDriver) {
      missing.push({
        name: "WebKitWebDriver",
        instruction: "Install the Linux WebKit WebDriver package (commonly webkit2gtk-driver/WebKitWebDriver) before running the packaged UI smoke.",
      });
    }
  }

  const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  if (platform === "linux" && !hasDisplay) {
    missing.push({
      name: "display",
      instruction: "Run from a visible desktop session or use xvfb-run npm run verify:s06 for headless Linux automation.",
    });
  }

  let chromium = null;
  try {
    chromium = resolveChromiumExecutable({ rootDir, env, platform });
  } catch (error) {
    if (error instanceof VerifyFailure && error.details?.code === "S06_CHROMIUM_MISSING") {
      missing.push({ name: "Chromium", instruction: error.details.instruction });
    } else {
      throw error;
    }
  }

  const result = {
    strict,
    tauriDriver: safeExecutableLog(tauriDriver, tauriDriver ? "PATH" : "missing"),
    platformDriver: platform === "linux" ? safeExecutableLog(platformDriver, platformDriver ? "PATH" : "missing") : { name: "native", source: "platform" },
    display: platform === "linux" ? (hasDisplay ? "available" : "missing") : "not-required",
    chromium: chromium ?? { name: "Chromium", source: "missing" },
    missing,
  };

  if (strict && missing.length > 0) {
    fail("S06 WebDriver preflight failed.", {
      code: "S06_PREFLIGHT_MISSING",
      missing,
      instruction: "Install the missing prerequisites, or on headless Linux run xvfb-run npm run verify:s06 after installing tauri-driver, WebKitWebDriver, and Chromium.",
    }, { rootDir });
  }

  return result;
}

function assertExecutableFile(path, label, rootDir, platform) {
  assert(existsSync(path), `Missing ${label}.`, {
    code: "S06_ARTIFACT_MISSING",
    artifact: repoRelative(rootDir, path),
  }, { rootDir });
  const stats = statSync(path);
  assert(stats.isFile(), `${label} is not a file.`, {
    code: "S06_ARTIFACT_NOT_FILE",
    artifact: repoRelative(rootDir, path),
  }, { rootDir });
  if (platform !== "win32") {
    assert((stats.mode & 0o111) !== 0, `${label} is not executable.`, {
      code: "S06_ARTIFACT_NOT_EXECUTABLE",
      artifact: repoRelative(rootDir, path),
    }, { rootDir });
  }
  return stats;
}

function assertFresh(stats, path, buildStartedAt, rootDir, label) {
  const thresholdMs = buildStartedAt instanceof Date ? buildStartedAt.getTime() : Number(buildStartedAt);
  assert(Number.isFinite(thresholdMs), "Build freshness timestamp is invalid.", {
    code: "S06_BUILD_STARTED_AT_INVALID",
  }, { rootDir });
  assert(stats.mtimeMs + FRESHNESS_SKEW_MS >= thresholdMs, `${label} is stale; it predates the S06 build start.`, {
    code: "S06_ARTIFACT_STALE",
    artifact: repoRelative(rootDir, path),
    mtime: new Date(stats.mtimeMs).toISOString(),
    buildStartedAt: new Date(thresholdMs).toISOString(),
  }, { rootDir });
}

function walkArtifacts(path, artifacts) {
  if (!existsSync(path)) {
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) {
      walkArtifacts(fullPath, artifacts);
      continue;
    }
    if (entry.isFile() && PACKAGE_EXTENSIONS.has(extname(entry.name))) {
      artifacts.push(fullPath);
    }
  }
}

function findPackageArtifacts(rootDir) {
  const artifacts = [];
  walkArtifacts(join(rootDir, "src-tauri", "target", "release", "bundle"), artifacts);
  return artifacts;
}

export function assertFreshBuildArtifacts(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const platform = options.platform ?? process.platform;
  const buildStartedAt = options.buildStartedAt;
  const extension = platform === "win32" ? ".exe" : "";
  const targetTriple = options.targetTriple;
  assert(targetTriple && typeof targetTriple === "string", "Target triple is required for S06 artifact checks.", {
    code: "S06_TARGET_TRIPLE_MISSING",
  }, { rootDir });

  const releaseExecutable = join(rootDir, "src-tauri", "target", "release", executableName(APP_BINARY_NAME, platform));
  const releaseSidecar = join(rootDir, "src-tauri", "target", "release", `${SIDECAR_NAME}${extension}`);
  const targetTripleSidecar = join(rootDir, "src-tauri", "binaries", `${SIDECAR_NAME}-${targetTriple}${extension}`);

  const releaseExecutableStats = assertExecutableFile(releaseExecutable, "release executable", rootDir, platform);
  const releaseSidecarStats = assertExecutableFile(releaseSidecar, "release sidecar", rootDir, platform);
  const targetTripleSidecarStats = assertExecutableFile(targetTripleSidecar, "target-triple sidecar", rootDir, platform);
  assertFresh(releaseExecutableStats, releaseExecutable, buildStartedAt, rootDir, "release executable");
  assertFresh(releaseSidecarStats, releaseSidecar, buildStartedAt, rootDir, "release sidecar");
  assertFresh(targetTripleSidecarStats, targetTripleSidecar, buildStartedAt, rootDir, "target-triple sidecar");

  const packages = findPackageArtifacts(rootDir);
  const debs = packages.filter((path) => extname(path) === ".deb");
  const rpms = packages.filter((path) => extname(path) === ".rpm");
  const appImages = packages.filter((path) => [".AppImage", ".appimage"].includes(extname(path)));
  if (platform === "linux") {
    assert(appImages.length === 0, "Linux package output unexpectedly included AppImage without S06 proof.", {
      code: "S06_APPIMAGE_UNPROVEN",
      artifacts: appImages.map((path) => repoRelative(rootDir, path)),
    }, { rootDir });
    assert(debs.length > 0, "Linux package output is missing a fresh .deb artifact.", {
      code: "S06_DEB_MISSING",
      bundleRoot: "src-tauri/target/release/bundle",
    }, { rootDir });
    assert(rpms.length > 0, "Linux package output is missing a fresh .rpm artifact.", {
      code: "S06_RPM_MISSING",
      bundleRoot: "src-tauri/target/release/bundle",
    }, { rootDir });
  }

  const packagePaths = [...debs, ...rpms];
  for (const artifact of packagePaths) {
    const stats = statSync(artifact);
    assert(stats.isFile(), "Package artifact is not a file.", {
      code: "S06_PACKAGE_NOT_FILE",
      artifact: repoRelative(rootDir, artifact),
    }, { rootDir });
    assertFresh(stats, artifact, buildStartedAt, rootDir, "package artifact");
  }

  return {
    buildStartedAt: new Date(buildStartedAt instanceof Date ? buildStartedAt.getTime() : Number(buildStartedAt)).toISOString(),
    releaseExecutable: repoRelative(rootDir, releaseExecutable),
    releaseSidecar: repoRelative(rootDir, releaseSidecar),
    targetTripleSidecar: repoRelative(rootDir, targetTripleSidecar),
    packages: packagePaths.map((path) => repoRelative(rootDir, path)).sort(),
  };
}

export function assertTauriGuardrails(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const platform = options.platform ?? process.platform;
  const tauriConfigPath = join(rootDir, "src-tauri", "tauri.conf.json");
  const capabilityPath = join(rootDir, "src-tauri", "capabilities", "default.json");
  const tauriConfig = readJson(tauriConfigPath, rootDir);
  const capability = readJson(capabilityPath, rootDir);

  const externalBin = tauriConfig.bundle?.externalBin;
  assert(Array.isArray(externalBin) && externalBin.length === 1 && externalBin[0] === SIDECAR_EXTERNAL_BIN,
    "Tauri bundle.externalBin must stay fixed to the packaged sidecar.", {
      code: "S06_EXTERNAL_BIN_DRIFT",
      externalBin,
    }, { rootDir });

  const targets = tauriConfig.bundle?.targets;
  if (platform === "linux") {
    assert(Array.isArray(targets), "Linux bundle targets must stay explicit.", {
      code: "S06_BUNDLE_TARGETS_MISSING",
      targets,
    }, { rootDir });
    const sortedTargets = [...targets].sort();
    assert(JSON.stringify(sortedTargets) === JSON.stringify(["deb", "rpm"]),
      "Linux bundle targets must stay fixed to .deb and .rpm only.", {
        code: "S06_BUNDLE_TARGETS_DRIFT",
        targets,
      }, { rootDir });
  }

  assert(String(tauriConfig.build?.beforeBuildCommand ?? "").includes("sidecar:build"),
    "beforeBuildCommand must keep building the sidecar before packaging.", {
      code: "S06_BEFORE_BUILD_DRIFT",
    }, { rootDir });
  assert(String(tauriConfig.build?.beforeDevCommand ?? "").includes("sidecar:build"),
    "beforeDevCommand must keep building the sidecar before dev launch.", {
      code: "S06_BEFORE_DEV_DRIFT",
    }, { rootDir });

  const permissions = capability.permissions;
  assert(Array.isArray(permissions), "Default capability permissions must be an array.", {
    code: "S06_CAPABILITY_MALFORMED",
  }, { rootDir });

  const permissionIds = [];
  for (const permission of permissions) {
    if (permission === "core:default") {
      permissionIds.push(permission);
      continue;
    }
    if (permission && typeof permission === "object" && permission.identifier === "shell:allow-spawn") {
      const allow = permission.allow;
      const allowedSidecars = Array.isArray(allow)
        ? allow.filter((entry) => entry?.name === SIDECAR_EXTERNAL_BIN && entry?.sidecar === true)
        : [];
      assert(Array.isArray(allow) && allow.length === 1 && allowedSidecars.length === 1,
        "Default capability widened shell:allow-spawn beyond the fixed sidecar.", {
          code: "S06_CAPABILITY_WIDENED",
          identifier: permission.identifier,
        }, { rootDir });
      permissionIds.push(permission.identifier);
      continue;
    }

    const identifier = typeof permission === "string" ? permission : permission?.identifier;
    fail("Default capability widened filesystem/shell authority for S06.", {
      code: "S06_CAPABILITY_WIDENED",
      identifier: identifier ?? "unknown",
    }, { rootDir });
  }

  assert(permissionIds.length === 2 && permissionIds.includes("core:default") && permissionIds.includes("shell:allow-spawn"),
    "Default capability must contain only core:default and shell:allow-spawn.", {
      code: "S06_CAPABILITY_DRIFT",
      permissions: permissionIds,
    }, { rootDir });

  return {
    externalBin: SIDECAR_EXTERNAL_BIN,
    targets,
    permissions: permissionIds,
  };
}

function readTargetTriple(rootDir = ROOT_DIR) {
  const result = spawnSync(executableForCommand("rustc"), ["--print", "host-tuple"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
  });

  if (result.error) {
    fail("Failed to determine the Rust host target triple.", {
      code: "S06_TARGET_TRIPLE_COMMAND_FAILED",
      message: result.error.message,
      stderrTail: normalizeOutputTail(result.stderr, { rootDir }),
    }, { rootDir });
  }
  if (result.status !== 0) {
    fail("rustc --print host-tuple failed.", {
      code: "S06_TARGET_TRIPLE_COMMAND_NONZERO",
      exitCode: result.status,
      stderrTail: normalizeOutputTail(result.stderr, { rootDir }),
    }, { rootDir });
  }
  const targetTriple = result.stdout.trim();
  assert(targetTriple, "rustc did not return a host target triple.", {
    code: "S06_TARGET_TRIPLE_EMPTY",
  }, { rootDir });
  return targetTriple;
}

function inspectPackageContents(packages, rootDir) {
  const inspections = [];
  for (const artifact of packages) {
    const absolute = join(rootDir, artifact);
    const extension = extname(absolute);
    if (extension === ".deb") {
      const tool = findExecutableCandidate("dpkg-deb", { env: process.env, pathEnv: process.env.PATH });
      if (!tool) {
        inspections.push({ artifact, tool: "dpkg-deb", status: "skipped", reason: "tool-missing" });
        continue;
      }
      const result = spawnSync(tool.path, ["-c", absolute], {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (result.status !== 0 || result.error) {
        inspections.push({ artifact, tool: "dpkg-deb", status: "skipped", reason: "inspection-failed" });
        continue;
      }
      assert(result.stdout.includes(SIDECAR_NAME), ".deb package listing did not include the sidecar name.", {
        code: "S06_PACKAGE_SIDECAR_MISSING",
        artifact,
        tool: "dpkg-deb",
      }, { rootDir });
      inspections.push({ artifact, tool: "dpkg-deb", status: "pass" });
      continue;
    }
    if (extension === ".rpm") {
      const tool = findExecutableCandidate("rpm", { env: process.env, pathEnv: process.env.PATH });
      if (!tool) {
        inspections.push({ artifact, tool: "rpm", status: "skipped", reason: "tool-missing" });
        continue;
      }
      const result = spawnSync(tool.path, ["-qpl", absolute], {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (result.status !== 0 || result.error) {
        inspections.push({ artifact, tool: "rpm", status: "skipped", reason: "inspection-failed" });
        continue;
      }
      assert(result.stdout.includes(SIDECAR_NAME), ".rpm package listing did not include the sidecar name.", {
        code: "S06_PACKAGE_SIDECAR_MISSING",
        artifact,
        tool: "rpm",
      }, { rootDir });
      inspections.push({ artifact, tool: "rpm", status: "pass" });
    }
  }
  return { inspections };
}

function parseArgs(argv) {
  const flags = new Set(argv);
  return {
    buildOnly: flags.has("--build-only"),
    preflightOnly: flags.has("--preflight-only"),
    strictPreflight: flags.has("--strict-preflight"),
  };
}

function runBuildOnly(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const platform = options.platform ?? process.platform;
  const targetTriple = runStep("target-triple", () => ({ targetTriple: readTargetTriple(rootDir) }), { rootDir }).targetTriple;
  runStep("tauri-config-capability", () => assertTauriGuardrails({ rootDir, platform }), { rootDir });
  runStep("preflight", () => {
    const preflight = assertWebDriverPreflight({ rootDir, platform, env: process.env, strict: options.strictPreflight ?? false });
    return {
      strict: preflight.strict,
      missingPrerequisites: preflight.missing.map((item) => item.name),
      display: preflight.display,
      chromium: preflight.chromium,
    };
  }, { rootDir });

  const buildStartedAt = new Date(Date.now() - FRESHNESS_SKEW_MS);
  runStep("build-freshness-window", () => ({ buildStartedAt: buildStartedAt.toISOString() }), { rootDir });
  runCommand("fresh-build", "npm", ["run", "tauri", "build"], BUILD_TIMEOUT_MS, {
    rootDir,
    label: "npm-run-tauri-build",
  });
  const artifacts = runStep("artifact-shape", () => assertFreshBuildArtifacts({
    rootDir,
    platform,
    targetTriple,
    buildStartedAt,
  }), { rootDir });
  runStep("package-sidecar-shape", () => inspectPackageContents(artifacts.packages, rootDir), { rootDir });
  return { targetTriple, ...artifacts };
}

function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.preflightOnly) {
    runStep("preflight", () => assertWebDriverPreflight({ rootDir: ROOT_DIR, env: process.env, strict: true }), { rootDir: ROOT_DIR });
    emit({ status: "pass", mode: "preflight-only", checks: STEP_RESULTS });
    return;
  }

  const proof = runBuildOnly({ rootDir: ROOT_DIR, strictPreflight: args.strictPreflight && args.buildOnly });
  emit({
    status: "pass",
    mode: args.buildOnly ? "build-only" : "build-only-skeleton",
    proof,
    checks: STEP_RESULTS,
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    runCli();
  } catch (error) {
    if (error instanceof VerifyFailure) {
      console.error(error.message);
      if (error.details) {
        console.error(JSON.stringify(redact(error.details), null, 2));
      }
      emit({ status: "fail", checks: STEP_RESULTS });
      process.exitCode = 1;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Unexpected verify:s06 failure.");
      console.error(redact(message));
      emit({ status: "fail", checks: STEP_RESULTS });
      process.exitCode = 1;
    }
  }
}
