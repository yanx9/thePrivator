import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_NAME = "theprivator-sidecar";
const SIDECAR_EXTERNAL_BIN = "binaries/theprivator-sidecar";
const EXTENSION = process.platform === "win32" ? ".exe" : "";
const PACKAGE_ARTIFACT_EXTENSIONS = new Set([
  ".AppImage",
  ".appimage",
  ".deb",
  ".rpm",
  ".dmg",
  ".msi",
  ".nsis.zip",
  ".exe",
]);
const STEP_RESULTS = [];

class VerifyFailure extends Error {
  constructor(message, details) {
    super(message);
    this.name = "VerifyFailure";
    this.details = details;
  }
}

function emit(event) {
  console.log(JSON.stringify({ event: "verify.s01", ...event }));
}

function assert(condition, message, details) {
  if (!condition) {
    throw new VerifyFailure(message, details);
  }
}

function commandName(command, args) {
  return [command, ...args].join(" ");
}

function executable(command) {
  return process.platform === "win32" && ["npm", "cargo", "rustc"].includes(command)
    ? `${command}.cmd`
    : command;
}

function normalizeOutput(value) {
  if (!value) {
    return "";
  }

  return value
    .replaceAll(ROOT_DIR, "<repo>")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-25)
    .join("\n");
}

function runStep(name, action) {
  const started = performance.now();
  try {
    const result = action() ?? {};
    const durationMs = Math.round(performance.now() - started);
    const record = { name, status: "pass", durationMs, ...result };
    STEP_RESULTS.push(record);
    emit({ step: name, status: "pass", durationMs, ...result });
    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    const record = { name, status: "fail", durationMs, message };
    STEP_RESULTS.push(record);
    emit({ step: name, status: "fail", durationMs, message });
    if (error?.details) {
      emit({ step: name, status: "fail-details", details: error.details });
    }
    throw error;
  }
}

function runCommand(name, command, args, timeoutMs, options = {}) {
  return runStep(name, () => {
    const label = commandName(command, args);
    const result = spawnSync(executable(command), args, {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });

    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        throw new VerifyFailure(`${label} timed out.`, "The child process was terminated by the smoke runner.");
      }
      throw new VerifyFailure(`Failed to run ${label}.`, result.error.message);
    }

    if (result.status !== 0) {
      throw new VerifyFailure(`${label} exited with status ${result.status ?? "unknown"}.`, {
        stdoutTail: normalizeOutput(result.stdout),
        stderrTail: normalizeOutput(result.stderr),
      });
    }

    if (options.echoStdoutOnPass && result.stdout) {
      process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    }

    return { command: label };
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readPngDimensions(path) {
  const bytes = readFileSync(path);
  const pngSignature = "89504e470d0a1a0a";
  assert(bytes.subarray(0, 8).toString("hex") === pngSignature, "Bundle icon must be a PNG file.");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function readTargetTriple() {
  const result = spawnSync(executable("rustc"), ["--print", "host-tuple"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });

  if (result.error) {
    throw new VerifyFailure("Failed to determine the Rust host target triple.", result.error.message);
  }

  if (result.status !== 0) {
    throw new VerifyFailure("rustc --print host-tuple failed.", normalizeOutput(result.stderr));
  }

  const targetTriple = result.stdout.trim();
  assert(targetTriple, "rustc did not return a host target triple.");
  return targetTriple;
}

function assertTauriConfig() {
  const tauriConfig = readJson(join(ROOT_DIR, "src-tauri", "tauri.conf.json"));
  const capability = readJson(join(ROOT_DIR, "src-tauri", "capabilities", "default.json"));
  const externalBin = tauriConfig.bundle?.externalBin;

  assert(Array.isArray(externalBin), "bundle.externalBin must be an array.");
  assert(
    externalBin.includes(SIDECAR_EXTERNAL_BIN),
    `bundle.externalBin must include ${SIDECAR_EXTERNAL_BIN}.`,
  );
  const bundleTargets = tauriConfig.bundle?.targets;
  if (process.platform === "linux") {
    assert(Array.isArray(bundleTargets), "Linux S01 packaging must name explicit current-OS bundle targets.");
    assert(bundleTargets.includes("deb"), "Linux S01 packaging must include the deb target.");
    assert(bundleTargets.includes("rpm"), "Linux S01 packaging must include the rpm target.");
    assert(
      !bundleTargets.includes("appimage"),
      "Linux S01 packaging excludes appimage until linuxdeploy is reliable in this environment.",
    );
  }
  assert(
    String(tauriConfig.build?.beforeDevCommand ?? "").includes("sidecar:build"),
    "beforeDevCommand must build the sidecar before launching the dev shell.",
  );
  assert(
    String(tauriConfig.build?.beforeBuildCommand ?? "").includes("sidecar:build"),
    "beforeBuildCommand must build the sidecar before packaging.",
  );

  const icons = tauriConfig.bundle?.icon;
  assert(Array.isArray(icons) && icons.length > 0, "bundle.icon must list at least one package icon.");
  assert(icons.includes("icons/icon.png"), "bundle.icon must include the square package icon.");
  const iconPath = join(ROOT_DIR, "src-tauri", "icons", "icon.png");
  assert(existsSync(iconPath), "Configured package icon is missing.", relative(ROOT_DIR, iconPath));
  const iconDimensions = readPngDimensions(iconPath);
  assert(
    iconDimensions.width === iconDimensions.height,
    "Configured package icon must be square for AppImage bundling.",
    iconDimensions,
  );

  const shellPermission = capability.permissions?.find(
    (permission) => typeof permission === "object" && permission.identifier === "shell:allow-spawn",
  );
  assert(shellPermission, "Default Tauri capability must grant shell:allow-spawn for the sidecar.");
  const allowedSidecar = shellPermission.allow?.some(
    (entry) => entry?.name === SIDECAR_EXTERNAL_BIN && entry?.sidecar === true,
  );
  assert(allowedSidecar, `Default Tauri capability must allow ${SIDECAR_EXTERNAL_BIN} as a sidecar.`);

  return { externalBin: SIDECAR_EXTERNAL_BIN, icon: "icons/icon.png", targets: tauriConfig.bundle?.targets };
}

function assertTargetBinary() {
  const targetTriple = readTargetTriple();
  const binaryPath = join(
    ROOT_DIR,
    "src-tauri",
    "binaries",
    `${SIDECAR_NAME}-${targetTriple}${EXTENSION}`,
  );

  assert(existsSync(binaryPath), `Missing target-triple sidecar binary ${relative(ROOT_DIR, binaryPath)}.`);
  assert(
    basename(binaryPath) === `${SIDECAR_NAME}-${targetTriple}${EXTENSION}`,
    "Target sidecar binary name does not match the host triple.",
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

function walkArtifacts(path, artifacts) {
  if (!existsSync(path)) {
    return;
  }

  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".app")) {
        artifacts.push(fullPath);
      } else {
        walkArtifacts(fullPath, artifacts);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const name = entry.name;
    const extension = extname(name);
    if (PACKAGE_ARTIFACT_EXTENSIONS.has(extension) || name.endsWith(".nsis.zip")) {
      artifacts.push(fullPath);
    }
  }
}

function assertPackageArtifacts() {
  const candidates = [];
  walkArtifacts(join(ROOT_DIR, "src-tauri", "target", "release", "bundle"), candidates);

  const releaseBinary = join(
    ROOT_DIR,
    "src-tauri",
    "target",
    "release",
    process.platform === "win32" ? "theprivator.exe" : "theprivator",
  );
  if (existsSync(releaseBinary) && statSync(releaseBinary).isFile()) {
    candidates.push(releaseBinary);
  }

  assert(
    candidates.length > 0,
    "No current-OS Tauri bundle or release artifact was found after tauri build.",
    "Run npm run tauri build first and inspect the Tauri build output.",
  );

  return { artifacts: candidates.map((path) => relative(ROOT_DIR, path)).slice(0, 10) };
}

function runDefaultVerification() {
  runCommand("node-tests", "npm", ["test", "--", "--run"], 120_000);
  runCommand("frontend-build", "npm", ["run", "build"], 120_000);
  runCommand("sidecar-build", "npm", ["run", "sidecar:build"], 300_000);
  runStep("tauri-sidecar-config", assertTauriConfig);
  runStep("target-binary", assertTargetBinary);
  runCommand("built-sidecar-smoke", "npm", ["run", "--silent", "verify:sidecar"], 30_000, {
    echoStdoutOnPass: true,
  });
  runCommand("rust-command-tests", "cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], 180_000);
}

try {
  if (process.argv.includes("--package-artifacts-only")) {
    runStep("tauri-package-artifacts", assertPackageArtifacts);
  } else {
    runDefaultVerification();
  }

  emit({ status: "pass", checks: STEP_RESULTS });
} catch {
  emit({ status: "fail", checks: STEP_RESULTS });
  process.exit(1);
}
