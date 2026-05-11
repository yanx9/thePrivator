# Packaged first profile loop

This runbook is for a fresh open-source contributor who wants to prove the Tauri rewrite as a packaged desktop app on the current OS. After following it, you should be able to build the app, open the packaged artifact without a manually started Python service, create a profile, launch real Chromium, stop it, reopen the app, confirm the profile persisted, and use diagnostics when something fails.

## What `npm run verify:s06` proves

`npm run verify:s06` is the packaged end-to-end smoke for the M001 rewrite spine. It rebuilds the current-OS Tauri artifact, opens the packaged app through WebDriver, drives the visible UI, and records `verify.s06` JSON-line evidence for these checkpoints:

- preflight and build freshness;
- release executable and current Linux `.deb`/`.rpm` artifact shape;
- packaged WebDriver session lifecycle;
- sidecar-backed profile creation for an `M001 Packaged Smoke ...` profile;
- real Chromium launch, running state, running count, stop, and cleanup;
- legacy import surface presence;
- persisted profile-store state after app restart;
- packaged diagnostics lookup and redaction checks;
- retained smoke-data location and final summary.

It does **not** prove signed installers, notarization, cross-platform release quality, AppImage publishing, release upload automation, or every distro package manager flow. Those remain deferred release-hardening work. It also does not replace the source-level regression guardrails listed below; run them before treating a packaged failure as only a packaging problem.

## Prerequisites

Install the normal development stack first:

- Node.js 20.19 or newer.
- npm dependencies installed with `npm install`.
- Python 3.8 or newer with the development requirements installed, including PyInstaller.
- Rust stable and Cargo on `PATH`.
- Tauri system dependencies for your OS.
- Chromium or Google Chrome available on `PATH`; if your browser lives elsewhere, configure the project’s Chromium path setting for your shell without pasting that value into issue reports.
- `tauri-driver` on `PATH`. One common setup is `cargo install tauri-cli --features webdriver`, then ensuring Cargo’s bin directory is on `PATH`.
- On Linux, WebKit WebDriver support (`WebKitWebDriver` or a distro package such as `webkit2gtk-driver`) available on `PATH`.
- A visible desktop session, or `xvfb-run` for headless Linux automation.

The packaged proof is current-OS scoped. On Linux, the current target set is `.deb` and `.rpm`. macOS, Windows, AppImage, signing, notarization, and release upload automation are not part of this smoke unless future work explicitly adds and verifies those targets.

## Command sequence

Run commands from the repository root.

```bash
npm install
python -m pip install -r requirements-dev.txt
npm run sidecar:build
npm run tauri dev
```

Use the dev shell only as an early sanity check. The packaged proof must open the packaged Tauri app through its bundled sidecar; do not keep a separate `python -m theprivator_sidecar` process running for the desktop UI.

Run the source guardrails before the final packaged proof:

```bash
npm run verify:s01
npm run verify:s03
npm run verify:s04
npm run verify:s05
```

Those checks cover the sidecar health spine, profile-store contract, Chromium lifecycle contract, S04 deterministic local full identity-surface proof with preserved legacy built-sidecar smoke, and S05 guided public checker audit entrypoint proof. S05 proves fixed catalog planning, advisory expected-value guidance, typed app-side audit failures, exact curated URL opens, cleanup, and redaction without scraping public checker page content. A failure in one of them usually means the packaged smoke is exposing an upstream regression, not a packaging-only issue; S06 remains the packaged end-to-end regression that proves the bundled app/sidecar loop.

Build the packaged app and run the final smoke:

```bash
npm run tauri build
npm run verify:s06
```

On headless Linux, after installing `tauri-driver`, WebKit WebDriver, Chromium, and xvfb, run:

```bash
xvfb-run npm run verify:s06
```

## Artifact expectations

A successful current Linux build should leave a release executable and fresh `.deb`/`.rpm` packages. The Tauri configuration intentionally targets Linux `.deb` and `.rpm` for this milestone. AppImage output, signed installers, notarized bundles, cross-platform packages, and release uploads are deferred.

Generated sidecar binaries, package outputs, and S06 smoke-data roots are build artifacts and should stay ignored by git. The S06 verifier intentionally retains its isolated smoke-data root for follow-up inspection. The generated smoke profile is also intentionally left in that isolated app-data root so persistence can be inspected after the automated restart check.

If you perform the manual fallback instead of the automated smoke, use your normal local app data unless you deliberately launch with an isolated environment. Treat manual profiles as local test data and remove them only after you have captured the evidence you need.

## Manual packaged UAT fallback

Use this checklist when automation prerequisites are unavailable. It is a fallback for local confidence, not a replacement for a passing `npm run verify:s06` on a machine that can run WebDriver.

1. Run `npm run tauri build` and open the packaged app or release executable that Tauri reports.
2. Confirm the window opens without starting `python -m theprivator_sidecar` manually.
3. Confirm the sidecar health area reaches the healthy state and shows product, protocol, runtime, platform, and build metadata.
4. Confirm the explicit legacy import panel is visible. You do not need to import data for this smoke; this only proves the legacy import surface still exists.
5. Create a profile named `M001 Packaged Smoke`.
6. Select the new profile and click **Launch Chromium**.
7. Confirm Chromium opens, the profile card shows **Running**, and the running count increments.
8. Click **Stop Chromium**.
9. Confirm the profile returns to **Stopped** and the running count decrements.
10. Quit the packaged app.
11. Reopen the packaged app without starting a Python service.
12. Confirm `M001 Packaged Smoke` is still listed and remains stopped.
13. If any recoverable error appears with a `detailRef`, use the diagnostics lookup UI before closing the app.

Do not use test-only bypasses, mocked sidecar data, or a manually started Python service for this checklist. The point is to prove the packaged app owns the sidecar boundary.

## Diagnostics lookup workflow

When the UI shows a recoverable error, copy only the `detailRef`. The app diagnostics surface routes that value through the Tauri command `diagnostics_lookup(detailRef)` and renders the matching bounded event summary in the app. If the lookup panel says no persisted event matched yet, retry once after the sidecar has had time to flush diagnostics.

Diagnostics are designed to be shareable. They should include safe codes, statuses, durations, and `detailRef` values. They must not include secrets, absolute user data roots, raw command lines, environment values, Chromium `--user-data-dir` arguments, proxy credentials, stdout/stderr bodies, tracebacks, or copied browser data. If you file an issue, share the verifier JSON lines and diagnostics summaries only after checking those redaction rules.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Stale or missing packaged artifacts | Rerun `npm run tauri build`, then rerun `npm run verify:s06`. The verifier expects fresh artifacts from the current run, not old files left under the build directory. |
| Missing Chromium | Install Chromium or Chrome and ensure it is discoverable by the verifier. If you configure a custom path, do not paste the raw path into diagnostics or issues. |
| Missing `tauri-driver` | Install Tauri WebDriver support, confirm `tauri-driver` resolves on `PATH`, then rerun the smoke. |
| Missing `WebKitWebDriver` on Linux | Install your distro’s WebKit WebDriver package, commonly named `webkit2gtk-driver` or similar, and confirm `WebKitWebDriver` resolves on `PATH`. Some distros package WebKitGTK separately from the WebDriver binary. |
| No display on Linux | Run from a visible desktop session, or install xvfb and use `xvfb-run npm run verify:s06`. |
| Sidecar unavailable in the packaged app | Rebuild with `npm run sidecar:build` and `npm run tauri build`. Do not start `python -m theprivator_sidecar`; a passing packaged smoke must use the bundled sidecar. |
| Profile validation error | Use a non-empty, unique profile name such as `M001 Packaged Smoke`. Use the displayed `detailRef` with diagnostics lookup for the exact validation code. |
| Launch fails | Confirm Chromium is installed, no policy blocks launching it, and the profile is not already running. Use diagnostics lookup for the `detailRef` before retrying. |
| Stop fails | Keep the app open, use diagnostics lookup for the `detailRef`, then retry stop. If Chromium remains open, close the browser manually only after capturing diagnostics. |
| Diagnostics lookup returns nothing | Retry once. If it still returns nothing, keep the retained smoke-data root or manual app data for inspection and include the safe verifier summary in the issue. |
| Verifier output contains unsafe data | Treat that as a redaction bug. Do not share the raw output; file the safe step name and code, then keep the retained local state for a maintainer to inspect on a trusted machine. |
