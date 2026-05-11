# Packaged identity regression and first profile loop

This runbook is for a fresh open-source contributor or release runner who needs to prove the current-OS packaged Tauri app, not just the source tree. After following it, you should be able to build the package, open the packaged app without a manually started Python service, create a profile, apply and persist the curated M002 identity preset, launch and stop real Chromium through the bundled sidecar, reopen the app with that identity intact, enter the guided audit flow, optionally open one curated checker page, and use bounded diagnostics when something fails.

The M002 packaged identity regression preserves the M001 first-profile loop. A passing run still proves sidecar health, visible profile creation, launch, stop, restart persistence, legacy import surface presence, package shape, and redacted diagnostics; it now also proves identity and guided-audit behavior through the packaged boundary.

## What `npm run verify:s06` proves

`npm run verify:s06` is the final current-OS packaged smoke for the M002 identity/audit milestone. It rebuilds the Tauri artifact, opens the packaged app through WebDriver, drives only visible UI, and records `verify.s06` JSON-line evidence for these checkpoints:

- preflight, Tauri capability guardrails, target triple, build freshness, and package artifact shape;
- release executable and current Linux `.deb`/`.rpm` package expectations;
- isolated S06 smoke app-data root and packaged WebDriver session lifecycle;
- sidecar-backed profile creation for a unique `M002 Packaged Identity Smoke ...` profile;
- visible identity configuration, preset selection, and application of `ubuntu-linux-chrome-120` / `Ubuntu Linux Chrome 120`;
- saved identity summary with representative modes such as browser, navigator, screen, locale, WebGL, and WebRTC masked, plus canvas and audio noise;
- identity-enabled Chromium launch, running state, running count, stop, and cleanup;
- packaged app restart with the profile and identity summary still present;
- guided audit guide entry with the curated page catalog visible;
- one pageId-only `identity.audit.open` action for `browserleaks-webgl` / `BrowserLeaks WebGL` through ThePrivator's UI;
- no public checker DOM, text, screenshot, score, or arbitrary URL scraping;
- persisted profile-store state, typed diagnostics correlation, redaction scan, retained smoke-data location, cleanup, and final summary.

The checker pages are manual comparison targets only. There is no guarantee of undetectability, checker success scores, stable public-page labels, or privacy outcomes from `verify:s06`; the release evidence is ThePrivator's packaged app behavior, fixed command boundary, typed diagnostics, and redaction.

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

The packaged proof is current-OS scoped. On Linux, the current package targets are `.deb` and `.rpm`. macOS packages, Windows packages, AppImage, signing, notarization, release upload automation, and cross-OS package certification are not part of this smoke unless future work explicitly adds and verifies those targets.

## Command sequence

Run commands from the repository root.

```bash
npm install
python -m pip install -r requirements-dev.txt
npm run sidecar:build
npm run tauri dev
```

Use the dev shell only as an early sanity check. The packaged proof must open the packaged Tauri app through its bundled sidecar; do not keep a separate `python -m theprivator_sidecar` process running for the desktop UI.

Before the final packaged proof, run the source and bridge guardrails that make a packaged failure diagnosable:

```bash
python -m pytest theprivator/tests/test_identity.py theprivator/tests/test_profile_store.py theprivator/tests/test_identity_runtime.py theprivator/tests/test_cdp.py theprivator/tests/test_identity_proof.py theprivator/tests/test_chromium_lifecycle.py theprivator/tests/test_sidecar_contract.py theprivator/tests/test_identity_audit.py
cargo test --manifest-path src-tauri/Cargo.toml
npm test -- --run src/identityControls.test.ts src/identityAuditGuidance.test.ts src/App.test.tsx src/sidecar/client.test.ts scripts/verify-s06.test.mjs
npm run build
npm run verify:s04
npm run verify:s05
```

`npm run verify:s04` is the deterministic local identity-surface proof. `npm run verify:s05` is the source guided public-audit proof: fixed catalog planning, advisory expected-value guidance, typed app-side audit failures, exact curated URL opens, cleanup, and redaction without scraping public checker content. If one of those guardrails fails, treat the packaged smoke as exposing an upstream regression until proven otherwise.

Use a strict preflight when you want to validate WebDriver prerequisites before paying for a package build:

```bash
npm run verify:s06 -- --preflight-only
```

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

Generated sidecar binaries, package outputs, and S06 smoke-data roots are build artifacts and should stay ignored by git. The S06 verifier intentionally retains its isolated smoke-data root for follow-up inspection. Inspect retained artifacts only to understand evidence such as the packaged profile store or diagnostics summaries; do not edit ignored smoke roots, inject raw sidecar parameters, set debug ports, or turn the verifier into an arbitrary public-URL runner.

If you perform the manual fallback instead of the automated smoke, use your normal local app data unless you deliberately launch with an isolated environment. Treat manual profiles as local test data and remove them only after you have captured the evidence you need.

## Manual packaged UAT fallback

Use this checklist when WebDriver automation prerequisites are unavailable. It is a fallback for local confidence, not a replacement for a passing `npm run verify:s06` on a machine that can run WebDriver.

1. Run `npm run tauri build` and open the packaged app or release executable that Tauri reports.
2. Confirm the window opens without starting `python -m theprivator_sidecar` manually.
3. Confirm the sidecar health area reaches the healthy state and shows product, protocol, runtime, platform, and build metadata.
4. Confirm the explicit legacy import panel is visible. You do not need to import data for this smoke; this only proves the legacy import surface still exists.
5. Create a unique profile named with an `M002 Packaged Identity Smoke` prefix so it cannot be confused with normal local profiles.
6. Select the new profile, open **Identity configuration**, choose **Ubuntu Linux Chrome 120**, and apply it.
7. Confirm the profile summary shows `Preset ubuntu-linux-chrome-120`, **Ubuntu Linux Chrome 120**, and representative modes such as browser masked, canvas noise, WebGL masked, and WebRTC masked.
8. Click **Launch Chromium**.
9. Confirm Chromium opens, the profile card shows **Running**, and the running count increments.
10. Click **Stop Chromium**.
11. Confirm the profile returns to **Stopped** and the running count decrements.
12. Quit the packaged app.
13. Reopen the packaged app without starting a Python service.
14. Confirm the smoke profile is still listed and the saved identity summary still shows the Ubuntu Linux Chrome 120 preset and modes.
15. Open the profile’s **Guided identity audit** guide.
16. Confirm the guide shows the curated checker catalog, advisory copy, and the warning that public checker pages are manual comparison aids rather than proof of checker success.
17. Optionally choose **BrowserLeaks WebGL** and click **Open in profile**. Confirm ThePrivator reports the page opened in the configured profile, then stop Chromium from ThePrivator. Do not wait on, copy, scrape, screenshot, or assert the public checker page contents.
18. If any recoverable profile, identity, launch, stop, audit-plan, or audit-open error appears with a `detailRef`, use the diagnostics lookup UI before closing the app.

Do not use test-only bypasses, mocked sidecar data, arbitrary URLs, raw sidecar calls, debug ports, or a manually started Python service for this checklist. The point is to prove the packaged app owns the profile, identity, Chromium, audit, and diagnostics boundaries.

## Diagnostics lookup workflow

When the UI shows a recoverable error, copy only the `detailRef`. The app diagnostics surface routes that value through the Tauri diagnostics lookup command and renders the matching bounded event summary in the app. If the lookup panel says no persisted event matched yet, retry once after the sidecar has had time to flush diagnostics.

Diagnostics are designed to be shareable. They should include safe codes, statuses, durations, method names, and `detailRef` values for paths such as profile creation, identity preset apply, Chromium launch/stop, audit plan, and `identity.audit.open`. They must not include secrets, absolute user data roots, raw command lines, environment values, Chromium `--user-data-dir` arguments, proxy credentials, stdout/stderr bodies, tracebacks, generated extension or config paths, CDP/debug ports, WebSocket URLs, target IDs, public checker content, or copied browser data. If you file an issue, share the verifier JSON lines and diagnostics summaries only after checking those redaction rules.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Preflight fails | Run `npm run verify:s06 -- --preflight-only` and fix the named prerequisite before rerunning the full smoke. Treat malformed verifier output or missing final `status: "pass"` as failure. |
| Stale or missing packaged artifacts | Rerun `npm run tauri build`, then rerun `npm run verify:s06`. The verifier expects fresh artifacts from the current run, not old files left under the build directory. |
| Missing Chromium | Install Chromium or Chrome and ensure it is discoverable by the verifier. If you configure a custom path, do not paste the raw path into diagnostics or issues. |
| Missing `tauri-driver` | Install Tauri WebDriver support, confirm `tauri-driver` resolves on `PATH`, then rerun the smoke. |
| Missing `WebKitWebDriver` on Linux | Install your distro’s WebKit WebDriver package, commonly named `webkit2gtk-driver` or similar, and confirm `WebKitWebDriver` resolves on `PATH`. Some distros package WebKitGTK separately from the WebDriver binary. |
| No display on Linux | Run from a visible desktop session, or install xvfb and use `xvfb-run npm run verify:s06`. |
| Sidecar unavailable in the packaged app | Rebuild with `npm run sidecar:build` and `npm run tauri build`. Do not start `python -m theprivator_sidecar`; a passing packaged smoke must use the bundled sidecar. |
| Profile validation error | Use a non-empty, unique profile name with an `M002 Packaged Identity Smoke` prefix. Use the displayed `detailRef` with diagnostics lookup for the exact validation code. |
| Identity preset apply fails | Confirm the **Ubuntu Linux Chrome 120** preset is visible in the identity configuration panel, apply it again once, and use the `detailRef` if the UI reports a typed identity error. Do not bypass the UI with raw sidecar calls. |
| Launch fails | Confirm Chromium is installed, no policy blocks launching it, and the profile is not already running. Use diagnostics lookup for the `detailRef` before retrying. |
| Stop fails | Keep the app open, use diagnostics lookup for the `detailRef`, then retry stop. If Chromium remains open, close the browser manually only after capturing diagnostics. |
| Restart persistence is missing | Reopen the app once more and confirm the profile card and identity summary. If the preset or modes are still missing, keep the safe diagnostics summary and treat it as a profile-store persistence regression. |
| Audit guide fails to load | Use diagnostics lookup for the audit-plan `detailRef`, rerun the source guided audit proof with `npm run verify:s05`, then rerun `npm run verify:s06`. |
| BrowserLeaks WebGL does not open from the audit guide | Treat ThePrivator’s typed `identity.audit.open` result as the release signal. Use diagnostics lookup for the `detailRef`; do not replace the pageId-only button with an arbitrary URL or public checker scrape. |
| Public checker page looks different | Public pages can change labels, fields, scripts, and scores without notice. Compare manually if useful, but this is external instability unless ThePrivator reports a typed audit error. |
| Cleanup needs a rerun | Rerun `npm run verify:s06`; the verifier uses a unique smoke profile and attempts owned Chromium cleanup. If a browser remains open after failure, capture diagnostics first, then close the browser manually. |
| Diagnostics lookup returns nothing | Retry once. If it still returns nothing, keep the retained smoke-data root or manual app data for trusted local inspection and include the safe verifier summary in the issue. |
| Verifier output contains unsafe data | Treat that as a redaction bug. Do not share the raw output; file the safe step name and code, then keep the retained local state for a maintainer to inspect on a trusted machine. |
