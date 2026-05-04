# S01 Tauri sidecar health smoke

This runbook is for a fresh local contributor who wants to prove the rewrite spine on their current OS. After following it, you should be able to run the dev shell, build a packaged Tauri artifact, open it, and see the same sidecar health and recoverable error states without manually starting a Python service.

## What this smoke proves

- The React UI invokes typed Tauri commands rather than calling the sidecar directly.
- The Rust bridge resolves the bundled Python sidecar through Tauri `externalBin` configuration.
- The PyInstaller-built sidecar responds to `health.status` with redacted product, protocol, runtime, platform, and build metadata.
- The deliberate diagnostic failure renders as a recoverable typed error with a `detailRef`.
- Invalid NDJSON input remains a typed recoverable `INVALID_REQUEST` response instead of a traceback.

## Prerequisites

Install the normal toolchains before running the smoke:

- Node.js 20.19 or newer.
- Python 3.8 or newer with the dev requirements installed.
- Rust stable with Cargo available on `PATH`.
- Tauri system dependencies for your OS.

Linux packaging may require WebKitGTK, AppIndicator, librsvg, `dpkg`, `rpm`, or equivalent distro packages depending on which Tauri bundle targets are available locally. The S01 Linux smoke intentionally targets `.deb` and `.rpm` packages for this repository because AppImage bundling depends on `linuxdeploy`, which can fail in this environment after the release binary and package directories are already produced. If `npm run tauri build` fails while compiling or bundling native dependencies, install the missing system package named by the Tauri output and rerun the same command.

## One-time setup

```bash
npm install
python -m pip install -r requirements-dev.txt
```

If you use a virtual environment, activate it before installing the Python requirements. The sidecar build helper automatically prefers `.venv` when it exists; otherwise it uses `PYTHON`, `python3`, or `python` depending on the platform.

## Automated S01 verification

Run the full automated slice smoke:

```bash
npm run verify:s01
```

The command runs the frontend tests, production frontend build, PyInstaller sidecar build, Tauri sidecar configuration checks, built-binary NDJSON smoke checks, and Rust bridge tests. It prints JSON lines with `event`, `step`, `status`, and `durationMs` so a future agent can identify the exact failing boundary.

Expected successful checkpoints include:

- `node-tests`
- `frontend-build`
- `sidecar-build`
- `tauri-sidecar-config`
- `target-binary`
- `built-sidecar-smoke`
- `rust-command-tests`

The built-binary smoke checks the healthy envelope, deliberate `DIAGNOSTIC_FAILURE`, invalid JSON `INVALID_REQUEST`, executable target-triple binary naming, and redacted stderr diagnostics. Stderr diagnostics must contain request metadata and `detailRef` when relevant, but they must not include request params, environment variables, tokens, profile paths, or full command lines.

## Development shell smoke

Start the Tauri dev shell:

```bash
npm run tauri dev
```

Tauri runs the sidecar build before launching the Vite dev server. When the window opens, verify these visible states:

1. The page heading says **ThePrivator rewrite spine**.
2. The phase ribbon settles on `healthy` after the first sidecar health check.
3. The health, build, and status cards show product, protocol, runtime, platform, build mode, request timing, and bridge timing.
4. Click **Trigger diagnostic error**.
5. The recoverable error card shows `DIAGNOSTIC_FAILURE`, `Recoverable: yes`, and a non-empty `detailRef`.
6. Click **Retry health** and confirm the phase returns to `healthy`.

Do not start `python -m theprivator_sidecar` separately for the Tauri UI. The Rust command bridge starts the configured sidecar for each invoke.

## Packaged artifact smoke

Build the current-OS Tauri artifact:

```bash
npm run tauri build
```

The Tauri config runs the frontend build and sidecar build before packaging. In this S01 proof, the current Linux package targets produce `.deb` and `.rpm` artifacts. Install and run the generated package for your distro family, or run the release executable that Tauri reports if you are only doing a local smoke on the build machine.

If future work re-enables macOS, Windows, or AppImage targets, use the generated app bundle, installer, or image that Tauri reports and repeat the same visible checks before treating that target as supported.

Then repeat the same visible checks from the development shell smoke: initial `healthy` phase, populated health/build/status cards, deliberate `DIAGNOSTIC_FAILURE`, non-empty `detailRef`, and successful **Retry health**.

To mechanically assert that a current-OS build artifact exists after packaging, run:

```bash
npm run verify:s01:packaged
```

That check does not rebuild the package. It only verifies that Tauri left at least one bundle or release artifact for the current OS.

## Direct sidecar inspection

For low-level protocol debugging, you can inspect the source sidecar without Tauri:

```bash
printf '{"id":"manual-health","method":"health.status","params":{}}\n' | python -m theprivator_sidecar
```

This should write one NDJSON response line to stdout and one redacted structured diagnostic line to stderr. The packaged smoke still depends on the PyInstaller-built target-triple binary, so direct source inspection is diagnostic only and does not replace `npm run verify:s01`.

## Failure guide

- **`sidecar-build` fails:** install Python dev requirements in the environment used by the build helper, then rerun `npm run verify:s01`. The helper copies over the Tauri sidecar binary only after PyInstaller succeeds.
- **`target-binary` fails:** rebuild with `npm run sidecar:build`; on Unix, ensure the generated sidecar is executable.
- **`built-sidecar-smoke` fails:** compare the expected and actual envelope named in the JSON failure line. Protocol failures intentionally report line counts or parse status, not raw request params.
- **`tauri-sidecar-config` fails:** confirm Tauri `externalBin`, shell capabilities, and the package icon still name the fixed sidecar binary and square bundle icon.
- **`rust-command-tests` fails:** the typed bridge no longer maps sidecar process, timeout, or protocol failures as expected.
- **`npm run tauri build` fails:** resolve the native Tauri/package dependency printed by Tauri, then rerun the build and `npm run verify:s01:packaged`. AppImage bundling is not part of the Linux S01 target set because `linuxdeploy` failed in this environment after `.deb`/`.rpm` artifacts were produced; reintroduce it only with a passing package smoke.
