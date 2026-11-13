import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENV_PYTHON = process.platform === "win32"
  ? join(ROOT_DIR, ".venv", "Scripts", "python.exe")
  : join(ROOT_DIR, ".venv", "bin", "python");
const PYTHON = process.env.PYTHON ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : (process.platform === "win32" ? "python" : "python3"));
const SIDECAR_NAME = "theprivator-sidecar";
const EXTENSION = process.platform === "win32" ? ".exe" : "";
const BUILD_ROOT = join(ROOT_DIR, "tmp", "sidecar-pyinstaller");
const DIST_DIR = join(BUILD_ROOT, "dist");
const WORK_DIR = join(BUILD_ROOT, "work");
const SPEC_DIR = join(BUILD_ROOT, "spec");
const ENTRYPOINT = join(BUILD_ROOT, "theprivator_sidecar_entry.py");
const BINARIES_DIR = join(ROOT_DIR, "src-tauri", "binaries");

function fail(message, cause) {
  console.error(`[sidecar:build] ${message}`);
  if (cause) {
    console.error(`[sidecar:build] ${cause}`);
  }
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    timeout: options.timeout,
  });

  if (result.error) {
    fail(`Failed to run ${command}.`, result.error.message);
  }

  if (result.status !== 0) {
    fail(`${command} exited with status ${result.status ?? "unknown"}.`);
  }

  return result;
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail(`Failed to run ${command}.`, error.message);
  }
}

function ensurePyInstaller() {
  const result = spawnSync(PYTHON, ["-m", "PyInstaller", "--version"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    fail(
      "PyInstaller is required to build the sidecar binary. Install the dev requirements for this Python environment and retry.",
      `Tried ${PYTHON} -m PyInstaller --version.`,
    );
  }

  return result.stdout.trim();
}

const pyInstallerVersion = ensurePyInstaller();
const targetTriple = commandOutput("rustc", ["--print", "host-tuple"]);
if (!targetTriple) {
  fail("rustc did not return a host target triple.");
}

rmSync(BUILD_ROOT, { recursive: true, force: true });
mkdirSync(BUILD_ROOT, { recursive: true });
mkdirSync(BINARIES_DIR, { recursive: true });

writeFileSync(
  ENTRYPOINT,
  "from theprivator_sidecar.main import main\nraise SystemExit(main())\n",
  "utf8",
);

console.log(
  `[sidecar:build] Building ${SIDECAR_NAME} for ${targetTriple} with PyInstaller ${pyInstallerVersion}.`,
);

run(PYTHON, [
  "-m",
  "PyInstaller",
  "--noconfirm",
  "--clean",
  process.platform === "darwin" ? "--onedir" : "--onefile",
  // The release workflow imports the identity before this build hook runs.
  ...(process.platform === "darwin" && process.env.APPLE_SIGNING_IDENTITY
    ? ["--codesign-identity", process.env.APPLE_SIGNING_IDENTITY]
    : []),
  "--name",
  SIDECAR_NAME,
  // Lazily-imported modules PyInstaller's static analysis can miss. cdp and
  // proxy_bridge are imported inside function bodies (see main.py's subcommand
  // dispatch); psutil is imported under a try/except so a miss degrades the
  // process-tree stop path silently instead of failing the build.
  "--hidden-import",
  "theprivator_sidecar.vault",
  "--hidden-import",
  "theprivator_sidecar.identity_session",
  "--hidden-import",
  "theprivator_sidecar.managed_debugging",
  "--hidden-import",
  "theprivator_sidecar.cdp",
  "--hidden-import",
  "theprivator_sidecar.proxy_bridge",
  "--hidden-import",
  "theprivator_sidecar.cookie_bot",
  "--hidden-import",
  "psutil",
  "--hidden-import",
  "requests",
  "--hidden-import",
  "websocket",
  "--distpath",
  DIST_DIR,
  "--workpath",
  WORK_DIR,
  "--specpath",
  SPEC_DIR,
  ENTRYPOINT,
]);

const builtBinary = process.platform === "darwin"
  ? join(DIST_DIR, SIDECAR_NAME, SIDECAR_NAME)
  : join(DIST_DIR, `${SIDECAR_NAME}${EXTENSION}`);

// Keep macOS libraries at stable paths; onefile extracts them for every worker.
if (process.platform === "darwin") {
  const runtime = join(BINARIES_DIR, "_internal");
  rmSync(runtime, { recursive: true, force: true });
  cpSync(join(DIST_DIR, SIDECAR_NAME, "_internal"), runtime, { recursive: true, verbatimSymlinks: true });

  // Let PyInstaller classify binaries and data for macOS codesign. An onedir
  // runtime copied wholesale into Frameworks fails on data such as *.dist-info.
  // BUNDLE retains the console bootloader needed by our stdin/stdout protocol,
  // and cross-links Frameworks and Resources without moving data into code dirs.
  const spec = join(SPEC_DIR, `${SIDECAR_NAME}.spec`);
  appendFileSync(spec, `\napp = BUNDLE(coll, name='${SIDECAR_NAME}.app', bundle_identifier='com.theprivator.sidecar')\n`);
  run(PYTHON, [
    "-m", "PyInstaller", "--noconfirm", "--distpath", DIST_DIR,
    "--workpath", WORK_DIR, spec,
  ]);
  const bundleRuntime = join(BINARIES_DIR, "macos-runtime");
  rmSync(bundleRuntime, { recursive: true, force: true });
  for (const directory of ["Frameworks", "Resources"]) {
    cpSync(join(DIST_DIR, `${SIDECAR_NAME}.app`, "Contents", directory),
      join(bundleRuntime, directory), { recursive: true, verbatimSymlinks: true });
  }
}
if (!existsSync(builtBinary)) {
  fail(`PyInstaller did not produce ${relative(ROOT_DIR, builtBinary)}.`);
}

const targetBinary = join(BINARIES_DIR, `${SIDECAR_NAME}-${targetTriple}${EXTENSION}`);
copyFileSync(builtBinary, targetBinary);
if (process.platform !== "win32") {
  chmodSync(targetBinary, 0o755);
}

console.log(`[sidecar:build] Wrote ${relative(ROOT_DIR, targetBinary)}.`);
