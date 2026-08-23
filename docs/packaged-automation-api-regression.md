# Packaged Automation API regression

This runbook is for a fresh contributor or release runner who needs to prove the current-development-OS packaged Tauri app owns the Automation API end to end. After reading it, the action is clear: run `npm run verify:m004:s05`, understand each `verify.m004.s05` phase, and troubleshoot failures without exposing tokens, lease authority, proxy material, runtime paths, or browser debug endpoints.

S05 is the packaged app proof for M004. It lifts the earlier app-managed and built-sidecar Automation API contracts into visible packaged UI orchestration: the verifier rebuilds or validates the release Tauri app, starts that packaged app through WebDriver, creates and configures a managed profile, starts the app-owned Automation API from the UI, copies the generated token only through the UI **Copy token** control, exercises protected HTTP and Playwright lease flows, proves release/expiry/revocation cleanup, stops the API and app cleanly, correlates diagnostics, and scans public output for forbidden markers.

## What `npm run verify:m004:s05` proves

`npm run verify:m004:s05` is current-OS scoped. It proves the package and bundled sidecar produced on the machine running the command; it does not certify other operating systems, signed installers, notarization, release uploads, or public checker scores.

A passing run should emit `verify.m004.s05` JSON-line events and finish with a redacted `status: "pass"` summary for these checkpoints:

- package target-triple detection, Tauri guardrails, strict WebDriver preflight, package build window, Tauri package build, and fresh release artifact validation;
- packaged WebDriver startup and a visible packaged app session, not a source tree browser tab;
- initial packaged UI sanity checks and a disabled **Copy token** control before the API starts;
- creation of a unique `M004 Packaged Automation Smoke ...` profile;
- visible identity configuration and the curated identity preset apply flow;
- deterministic credentialed HTTP proxy fixture setup and visible packaged proxy configuration;
- **Start API**, safe API status metrics, and token capture through the private **Copy token** flow;
- public `/health`, expected missing/invalid auth failures, protected `/v1/status`, `/v1/profiles`, selected profile status, and `/v1/runtime/status` checks with request correlation;
- expected lease failure cases for invalid TTL, malformed body, unknown profile, and unknown lease;
- Playwright lease creation, active lease status, Playwright attachment to ThePrivator-launched Chromium, page navigation through the proxy fixture, and representative identity checks;
- proxy observation counts proving credentialed route-through-proxy behavior without direct fallback;
- lease release, released-status proof, released-reuse failure, runtime-stopped proof, and release revocation;
- short lease creation, expiry wait, expired-reuse failure, runtime-stopped proof, and expiry revocation;
- packaged API stop, listener closure, packaged app and WebDriver cleanup, and proxy fixture cleanup;
- profile-store inspection, diagnostics correlation, S05 redaction scan, forbidden-marker scan, and final summary.

Public checker pages are not the authority for this regression. If a public checker appears during related manual investigation, treat its content as advisory only; do not scrape it, assert its exact labels, or interpret public checker output as a guarantee of privacy, undetectability, or external exit IP behavior.

## Prerequisites

Install the normal development stack first:

- Node.js 20.19 or newer.
- npm dependencies installed with `npm install`. The Playwright client dependency is already pinned in `package-lock.json`; the S05 verifier uses `playwright-core` to attach to Chromium launched by ThePrivator rather than downloading a browser.
- Python 3.8 or newer with the sidecar development dependencies installed.
- Rust stable and Cargo on `PATH`.
- Tauri system dependencies for your OS.
- `tauri-driver` on `PATH`. A common setup is installing the Tauri CLI with WebDriver support and ensuring Cargo’s bin directory is available in your shell.
- A platform WebDriver backend for the packaged Tauri webview. On Linux this usually means WebKit WebDriver support through `WebKitWebDriver` or your distro’s equivalent package.
- A visible desktop session. On headless Linux, install xvfb and run the command through `xvfb-run`.
- Chromium or Google Chrome discoverable by the app and verifier. Keep custom discovery paths out of public logs and issue reports.

Missing `tauri-driver`, platform WebDriver, display, Chromium, or Python sidecar prerequisites are setup failures. They are not M004 proof failures until the environment can actually run the packaged app and verifier.

## Setup and command order

Run commands from the repository root.

```bash
npm install
python -m pip install -r requirements-dev.txt
npm run sidecar:build
```

Use the unit contract checks before the full packaged run when you are changing the verifier or diagnosing a regression:

```bash
npm test -- --run scripts/verify-s06.test.mjs scripts/verify-m004-s05.test.mjs
```

Use preflight when you only want to validate local WebDriver and browser prerequisites before paying for a package build:

```bash
npm run verify:m004:s05 -- --preflight-only
```

Run the full packaged regression:

```bash
npm run verify:m004:s05
```

On headless Linux, after installing WebDriver and browser prerequisites, run:

```bash
xvfb-run npm run verify:m004:s05
```

Only use `--skip-build` when you intentionally want to reuse already-built, fresh package artifacts during local diagnosis. The release proof should normally run without that flag so package freshness is part of the evidence.

## Evidence and cleanup expectations

A successful run keeps public evidence intentionally narrow. Safe public fields include phase names, pass/fail status, durations, status codes, stable error codes, request IDs, safe `detailRef`s, counts, booleans, and redacted summary categories.

The verifier intentionally retains an isolated smoke-data root for trusted local inspection after the run. Use that retained local state only on the machine that produced it to inspect profile-store diagnostics, verifier step records, proxy fixture observation counts, and package process tails. Do not paste retained roots, absolute paths, raw diagnostics, copied tokens, lease IDs, handoff endpoints, proxy authorities, proxy credentials, browser debug endpoints, target URLs, or process-output tails into public issues or chat.

Cleanup is part of the proof. The verifier releases or expires leases, verifies release and expiry revocation, stops the app-owned Automation API through the packaged UI, waits for the loopback listener to close, stops the proxy fixture, shuts down WebDriver, and records cleanup state in the final summary. If a failure interrupts the run, capture the safe phase, code, request ID, and `detailRef` first; close leftover windows or browser processes manually only after preserving trusted local diagnostics.

## Safety boundaries

Follow these rules when running or reporting S05:

- Never manually start a source sidecar to make S05 pass. The packaged app must own the bundled sidecar and the Automation API lifecycle.
- Never paste, log, screenshot, or publish the copied Automation API token. The **Copy token** action is a verifier-owned private capture path, not a documentation or support workflow.
- Never publish lease IDs, handoff endpoints, CDP endpoints, WebSocket debugger URLs, loopback base URLs, proxy authorities, proxy credentials, target URLs, app-data roots, profile roots, user-data roots, package process tails, raw diagnostics, stack traces, argv, or environment values.
- Treat forbidden-marker or redaction failures as security-sensitive verifier bugs. Do not share raw output; share the safe phase name, code, and request correlation only.
- Do not use public checker content as a release gate. The proof is the packaged app behavior, protected API contract, Playwright lease lifecycle, deterministic proxy fixture observation, diagnostics correlation, cleanup, and redaction scan.
- Do not treat public checker output or sanitized public verifier output as a guarantee that no private data exists in retained local artifacts. Public evidence is deliberately limited; retained smoke roots are for trusted local debugging only.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `package-preflight` reports a missing prerequisite | Install the named dependency, then rerun `npm run verify:m004:s05 -- --preflight-only`. Fix setup before interpreting any later failure. |
| `tauri-driver` is missing | Install Tauri WebDriver support and ensure `tauri-driver` resolves on `PATH`. Keep install paths out of public reports. |
| Linux WebDriver startup fails | Install your distro’s WebKit WebDriver package, confirm the WebDriver binary resolves on `PATH`, and rerun under a visible desktop session or `xvfb-run`. |
| Chromium is missing | Install Chromium or Google Chrome and ensure discovery works in the verifier shell. Do not publish custom browser paths. |
| Package build fails | Resolve the native Tauri, Rust, Node, or Python sidecar dependency named by the build output, then rerun the full command. Do not work around this by starting a source sidecar. |
| **Copy token** is enabled before API start | Treat it as a packaged UI lifecycle regression. Keep the safe phase and code; do not click or publish any token material. |
| API auth checks fail unexpectedly | Use the safe HTTP status, request ID, and `detailRef`. Do not print the token or Authorization header while debugging. |
| Lease creation or Playwright attach fails | Use the phase name, stable code, request ID, and retained local diagnostics. Do not expose handoff endpoints, CDP authority, WebSocket URLs, or lease IDs. |
| Proxy observation is not proved | Confirm Chromium and the proxy fixture started in the same run, then rerun once. Do not replace the deterministic fixture with arbitrary public URL assertions. |
| Listener cleanup fails | Keep the app open long enough to capture safe diagnostics, then stop the API or close leftover windows manually. Treat repeated listener failures as cleanup regressions. |
| Diagnostics are missing or incomplete | Use the retained local smoke root for trusted inspection and share only safe `detailRef`, status, method category, and request-correlation evidence. |
| Redaction or forbidden-marker scan fails | Stop sharing the raw output immediately. Preserve the retained local state for trusted maintainers and report only the safe phase/code summary. |

## Post-read action

Run the current-OS packaged Automation API regression:

```bash
npm run verify:m004:s05
```

A passing run ends with `status: "pass"` and a redacted final summary. If it does not pass, use the phase name, stable error code, request ID, safe `detailRef`, and retained local diagnostics to diagnose the failure without exposing authority-bearing or path-bearing material.
