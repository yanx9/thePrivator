# Packaged proxy regression and first profile loop

This runbook is for a fresh open-source contributor or release runner who needs to prove the current-OS packaged Tauri app, not just the source tree. After reading it, the action is clear: prove the M003 packaged proxy loop on the current OS with `npm run verify:s06`.

The M003 packaged proxy regression preserves the earlier first-profile and identity checks, then adds the release-critical proxy loop: create an identity profile, configure a credentialed fixed HTTP proxy through the packaged UI, check and save it, run **Run saved proxy proof**, launch and stop real Chromium through the bundled sidecar, restart the packaged app, confirm masked persistence, correlate diagnostics, and verify public evidence is redacted.

## What `npm run verify:s06` proves

`npm run verify:s06` is the final current-OS packaged smoke for the M003 proxy milestone. It rebuilds the Tauri artifact, starts the packaged app through WebDriver, drives visible UI only, uses the bundled sidecar rather than a dev or source sidecar, and records `verify.s06` JSON-line evidence for these checkpoints:

- preflight, Tauri capability guardrails, target triple, build freshness, and package artifact shape;
- isolated S06 smoke app data and packaged WebDriver session startup;
- profile creation for a unique `M003 Packaged Proxy Smoke ...` profile;
- applying `ubuntu-linux-chrome-120` / **Ubuntu Linux Chrome 120** to that same profile;
- starting a deterministic local HTTP proxy fixture with verifier-owned credentials that must never appear in public evidence;
- configuring **Fixed server** proxy mode in the packaged UI, selecting **HTTP**, entering the fixture endpoint, choosing **Replace credentials**, and typing credentials into the visible form;
- **Check proxy** draft validation and **Save proxy** persistence with credential state shown as configured and masked;
- a visible SOCKS-with-credentials negative proof that reports `PROXY_SOCKS_AUTH_UNSUPPORTED`, includes a safe `detailRef`, and resolves through diagnostics lookup;
- replacing the unsupported SOCKS proxy with the supported HTTP fixture and proving the saved-proxy panel resets instead of reusing stale proof state;
- **Run saved proxy proof** evidence with `routeProof`, `ipHiding`, `webRtc`, and `publicCheckers` vocabulary;
- route proof `proved`, IP-hiding conclusion `proved` for the deterministic local fixture, WebRTC/local-IP baseline restricted by the identity policy, public checkers marked advisory-only, and `directFallbackDetected:false`;
- Chromium launch, running-state guardrails that prevent live proxy edits, stop, packaged app restart, and saved identity plus masked proxy persistence;
- post-smoke profile-store and diagnostics correlation for profile creation, identity apply, proxy update/check, Chromium launch, and Chromium stop;
- cleanup, redaction scanning, retained artifact reporting, and a final summary with proxy, proxy-check, route-proof, IP-hiding, WebRTC, public-checker, diagnostics, cleanup, supporting-regression, and redaction fields.

Public checker pages are advisory comparison aids only. The packaged proof does not scrape public checker DOM, copy public checker text, assert a specific external exit IP, promise checker scores, or guarantee undetectability. The release evidence is the packaged app behavior, saved proxy truth, bundled sidecar invocation, typed diagnostics, local deterministic route proof, and redaction.

## Prerequisites

Install the normal development stack first:

- Node.js 20.19 or newer.
- npm dependencies installed with `npm install`.
- Python 3.8 or newer with the development requirements installed, including PyInstaller.
- Rust stable and Cargo on `PATH`.
- Tauri system dependencies for your OS.
- Chromium or Google Chrome available to the app and verifier. If your browser needs custom discovery in your shell, keep that value out of public logs and issue reports.
- `tauri-driver` on `PATH`. One common setup is `cargo install tauri-cli --features webdriver`, then ensuring Cargo’s bin directory is on `PATH`.
- On Linux, WebKit WebDriver support available on `PATH` through `WebKitWebDriver` or your distro’s equivalent package.
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

Use the dev shell only as an early sanity check. The packaged proof must open the packaged Tauri app through its bundled sidecar; do not keep a separate Python sidecar process running for the desktop UI.

Before the final packaged proof, run the source, bridge, and packaged-input gates that make a failure diagnosable:

```bash
npm test -- --run src/App.test.tsx src/sidecar/client.test.ts scripts/verify-s06.test.mjs
npm run build
npm run sidecar:build
npm run verify:s02
npm run verify:s03
npm run verify:s04
npm run verify:s05
```

Use these gates in order:

- `npm run verify:s02` proves fixed-server proxy launch mapping, unsupported SOCKS credential failures, and safe sidecar proxy runtime behavior before packaging.
- `npm run verify:s03` proves the visible proxy configuration UI and store-v3 proxy truth used by the packaged app.
- `npm run verify:s04` proves deterministic proxy checking, route-proof vocabulary, diagnostics, and public-checker advisory wording.
- `npm run verify:s05` proves built-sidecar proxy plus identity composition before the final packaged app smoke.

Use a strict preflight when you want to validate WebDriver prerequisites before paying for a package build:

```bash
npm run verify:s06 -- --preflight-only
```

Build the packaged app and run the final smoke:

```bash
npm run verify:s06
```

On headless Linux, after installing the WebDriver prerequisites, run:

```bash
xvfb-run npm run verify:s06
```

## Artifact expectations

A successful current Linux build should leave a release executable and fresh `.deb`/`.rpm` packages. The verifier checks package freshness and bundled sidecar shape before it drives the UI. Generated sidecar binaries, package outputs, and S06 smoke-data roots are build artifacts and should stay ignored by git.

The S06 verifier intentionally retains an isolated smoke-data root and prints a redacted reference to it in the final summary. Use that retained root only for trusted local inspection of evidence such as the packaged profile store, diagnostics JSON lines, WebDriver driver tails, and fixture observation counts. Do not edit retained artifacts, inject raw sidecar parameters, enable debug ports, copy credentials into public reports, or turn the verifier into an arbitrary public-URL runner.

The profile store may contain private proxy credentials inside the retained local smoke root. Public evidence must not contain those credentials, credential-bearing proxy URIs, `Proxy-Authorization`, Chromium proxy arguments, generated auth-extension paths, app-data roots, debug endpoints, WebSocket endpoints, public checker body text, or fixture/trust internals.

## Manual packaged UAT fallback

Use this checklist when WebDriver automation prerequisites are unavailable. It is a fallback for local confidence, not a replacement for a passing `npm run verify:s06` on a machine that can run WebDriver.

1. Run `npm run sidecar:build`, then run the Tauri package build for your OS and open the packaged app or release executable that Tauri reports.
2. Confirm the window opens without starting a Python sidecar process manually.
3. Confirm the sidecar health area reaches the healthy state and shows product, protocol, runtime, platform, and build metadata.
4. Confirm the explicit legacy import panel is visible. You do not need to import data for this smoke; this only proves the legacy import surface still exists.
5. Create a unique profile named with an `M003 Packaged Proxy Smoke` prefix so it cannot be confused with normal local profiles.
6. Select the new profile, open **Identity configuration**, choose **Ubuntu Linux Chrome 120**, and apply it.
7. Confirm the profile summary shows the Ubuntu Linux Chrome 120 preset and representative masked/noisy identity surfaces.
8. Open **Configure proxy** for the profile.
9. Choose **Fixed server** mode, choose **HTTP**, enter a test proxy endpoint you control, choose **Replace credentials**, and enter credentials for that test proxy. Use only disposable test credentials and do not paste them into reports.
10. Click **Check proxy** and confirm the draft validation completes without warnings for the controlled test proxy.
11. Click **Save proxy** and confirm the saved proxy summary shows **M003 saved proxy**, **Fixed server**, **HTTP**, and credential state configured as masked.
12. Click **Run saved proxy proof**.
13. Confirm the saved proof reports deterministic local route proof, local fixture or controlled-proxy routing, IP-hiding conclusion for that proof scope, WebRTC / local-IP baseline, public checker advisory pages, protocol HTTP, credential state configured as masked, and fallback route not detected.
14. Click **Launch Chromium**.
15. Confirm Chromium opens, the profile card shows **Running**, and live proxy edits are blocked with copy explaining that saved proxy edits apply on the next launch.
16. Click **Stop Chromium**.
17. Confirm the profile returns to **Stopped** and the running count decrements.
18. Quit the packaged app.
19. Reopen the packaged app without starting a Python service.
20. Confirm the smoke profile is still listed, the identity summary remains present, and the saved proxy summary still shows the fixed HTTP proxy with credentials masked.
21. Run **Run saved proxy proof** again if the controlled proxy is still available, then stop Chromium from ThePrivator if it is running.
22. If any recoverable profile, identity, proxy check, proxy save, launch, stop, or cleanup error appears with a `detailRef`, use the diagnostics lookup UI before closing the app.

Do not use test-only bypasses, mocked sidecar data, arbitrary URLs, raw sidecar calls, debug ports, public checker scraping, or a manually started Python service for this checklist. The point is to prove the packaged app owns the profile, identity, proxy, Chromium lifecycle, diagnostics, and redaction boundaries.

## Diagnostics lookup workflow

When the UI shows a recoverable error, copy only the `detailRef`. The app diagnostics surface routes that value through the Tauri diagnostics lookup command and renders the matching bounded event summary in the app. If the lookup panel says no persisted event matched yet, retry once after the sidecar has had time to flush diagnostics.

Diagnostics are designed to be shareable after redaction review. They should include safe codes, statuses, durations, method names, and `detailRef` values for paths such as profile creation, identity preset apply, proxy update, proxy check, Chromium launch, and Chromium stop. They must not include secrets, absolute user data roots, raw command lines, environment values, Chromium proxy arguments, credential-bearing proxy URIs, proxy credentials, stdout/stderr bodies, tracebacks, generated extension or config paths, CDP/debug ports, WebSocket URLs, target IDs, public checker content, copied browser data, or verifier fixture internals. If you file an issue, share verifier JSON lines and diagnostics summaries only after checking those redaction rules.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Preflight fails | Run `npm run verify:s06 -- --preflight-only` and fix the named prerequisite before rerunning the full smoke. Treat malformed verifier output or a missing final `status: "pass"` as failure. |
| Stale or missing packaged artifacts | Rerun `npm run sidecar:build`, then rerun `npm run verify:s06`. The verifier expects fresh packaged artifacts from the current run, not old files left under the build directory. |
| Missing Chromium | Install Chromium or Chrome and ensure it is discoverable by the verifier. If you configure a custom path, do not paste the raw value into diagnostics or issues. |
| Missing `tauri-driver` | Install Tauri WebDriver support, confirm `tauri-driver` resolves on `PATH`, then rerun the smoke. |
| Missing WebKit WebDriver on Linux | Install your distro’s WebKit WebDriver package and confirm the WebDriver binary resolves on `PATH`. Some distros package WebKitGTK separately from the WebDriver binary. |
| No display on Linux | Run from a visible desktop session, or install xvfb and use `xvfb-run npm run verify:s06`. |
| Sidecar unavailable in the packaged app | Rebuild with `npm run sidecar:build`, then rerun the packaged smoke. Do not start a source sidecar manually; a passing packaged smoke must use the bundled sidecar. |
| Proxy fixture or provider fails | For the automated smoke, rerun once to rule out a transient fixture startup failure. For manual fallback, use a controlled disposable proxy and keep its credentials out of reports. Do not replace the verifier with arbitrary public URL checks. |
| `PROXY_SOCKS_AUTH_UNSUPPORTED` appears | This is expected during the automated negative step for SOCKS with credentials. It is a failure only if the later HTTP replacement save and **Run saved proxy proof** do not recover and prove the current saved proxy. |
| Saved proxy proof is not proven | Confirm the saved proxy summary shows fixed HTTP with credentials masked, then rerun **Run saved proxy proof** once. If it still reports not-proven, use the `detailRef` diagnostics lookup and treat the result as a proxy-check or fixture/provider regression. |
| Saved proxy proof looks stale after replacement save | The proof panel should reset after saving a replacement HTTP proxy and should use a fresh request for the next proof. If a previous SOCKS failure or old request remains visible, keep diagnostics and treat it as stale proof-state regression. |
| Launch fails after proxy save | Confirm Chromium is installed, the profile is not already running, and the saved proxy proof succeeded without direct fallback. Use diagnostics lookup for the `detailRef` before retrying. |
| Stop fails | Keep the app open, use diagnostics lookup for the `detailRef`, then retry stop. If Chromium remains open, close the browser manually only after capturing diagnostics. |
| Restart persistence is missing | Reopen the app once more and confirm the profile card, identity summary, and masked proxy summary. If they are still missing, keep safe diagnostics and treat it as a profile-store persistence regression. |
| Public checker pages disagree | Public pages can change labels, scripts, network behavior, and scores without notice. They are advisory only; do not scrape them or turn their contents into package-release assertions. |
| Cleanup needs a rerun | Rerun `npm run verify:s06`; the verifier uses a unique smoke profile and attempts owned Chromium and fixture cleanup. If a browser remains open after failure, capture diagnostics first, then close the browser manually. |
| Diagnostics lookup returns nothing | Retry once. If it still returns nothing, keep the retained local smoke root for trusted local inspection and include only the safe verifier summary in the issue. |
| Verifier output contains unsafe data | Treat that as a redaction bug. Do not share the raw output; file the safe step name and code, then keep the retained local state for a maintainer to inspect on a trusted machine. |

## Post-read action

Run the current-OS packaged proxy proof:

```bash
npm run verify:s06
```

A passing run should end with `status: "pass"` and a redacted final summary for the M003 packaged proxy evidence. If it does not, use the phase name, safe code, `detailRef`, diagnostics lookup, and retained local artifacts to troubleshoot without exposing credentials or runtime internals.
