import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyFailure } from "./verify-m004-s01.mjs";
import { assertTauriGuardrails as assertS06TauriGuardrails } from "./verify-s06.mjs";
import {
  VERIFY_EVENT,
  assertM005S04CapabilityConfig,
  assertM005S04Guardrails,
  assertM005S04PublicEvidenceRedacted,
  assertM005S04SourceGuardrails,
  assertNativeDialogAutomationPreflight,
  assertValidArgs,
  buildM005S04FinalSummary,
  collectM005S04MarkerClasses,
  createM005S04PublicScanContext,
  createNativeDialogCommandPlan,
  describeNativeDialogSelection,
  findM005S04ForbiddenPublicMarker,
  formatM005S04CommandFailure,
  parseArgs,
  planNativeDialogAutomation,
  runPreflightOnlyVerification,
} from "./verify-m005-s04.mjs";

const tempRoots = [];
let consoleSpy;
const IGNORED_ARTIFACT_REFERENCE_PATTERN = /(?:^|["'`\s/(])(?:\.gsd|\.planning|\.audits)(?:[\/"'`\s)]|$)/;

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "theprivator-m005-s04-test-"));
  tempRoots.push(root);
  return root;
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function captureConsole() {
  const lines = [];
  consoleSpy = vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
  return lines;
}

function defaultPermissions(overrides = {}) {
  return overrides.permissions ?? [
    "core:default",
    "dialog:allow-open",
    "dialog:allow-save",
    { identifier: "shell:allow-spawn", allow: [{ name: "binaries/theprivator-sidecar", sidecar: true }] },
  ];
}

function seedS04Root({ permissions, appSource, clientSource, libSource, sidecarSource, packageScript = "node scripts/verify-m005-s04.mjs", targets = ["deb", "rpm"] } = {}) {
  const root = makeRoot();
  writeJson(join(root, "src-tauri", "capabilities", "default.json"), {
    identifier: "default",
    windows: ["main"],
    permissions: defaultPermissions({ permissions }),
  });
  writeJson(join(root, "src-tauri", "tauri.conf.json"), {
    build: { beforeDevCommand: "npm run sidecar:build && npm run dev", beforeBuildCommand: "npm run build && npm run sidecar:build" },
    bundle: { externalBin: ["binaries/theprivator-sidecar"], targets },
  });
  writeJson(join(root, "package.json"), {
    scripts: { "verify:m005:s04": packageScript },
    dependencies: { "@tauri-apps/api": "^2.0.0", "@tauri-apps/plugin-dialog": "^2.0.0" },
  });
  writeText(join(root, "src", "App.tsx"), appSource ?? "import { open, save } from '@tauri-apps/plugin-dialog';\nimport { exportProfileCookies, replaceProfileCookies, exportProfilePackage, importProfilePackage } from './sidecar/client';\nopen(); save(); void exportProfileCookies; void replaceProfileCookies; void exportProfilePackage; void importProfilePackage;\n");
  writeText(join(root, "src", "sidecar", "client.ts"), clientSource ?? 'invoke<unknown>("profile_cookies_export", {});\ninvoke<unknown>("profile_cookies_replace", {});\ninvoke<unknown>("profile_package_export", {});\ninvoke<unknown>("profile_package_import", {});\n');
  writeText(join(root, "src-tauri", "src", "lib.rs"), libSource ?? "sidecar::profile_cookies_export\nsidecar::profile_cookies_replace\nsidecar::profile_package_export\nsidecar::profile_package_import\n");
  writeText(join(root, "src-tauri", "src", "sidecar.rs"), sidecarSource ?? `#[tauri::command]
pub async fn profile_cookies_export(app: tauri::AppHandle) { let store_root = resolve_profile_store_root(&app)?; profile_cookies_export_with_runner(&runner, store_root).await }
#[tauri::command]
pub async fn profile_cookies_replace(app: tauri::AppHandle) { let store_root = resolve_profile_store_root(&app)?; profile_cookies_replace_with_runner(&runner, store_root).await }
#[tauri::command]
pub async fn profile_package_export(app: tauri::AppHandle) { let store_root = resolve_profile_store_root(&app)?; profile_package_export_with_runner(&runner, store_root).await }
#[tauri::command]
pub async fn profile_package_import(app: tauri::AppHandle) { let store_root = resolve_profile_store_root(&app)?; profile_package_import_with_runner(&runner, store_root).await }
async fn profile_cookies_export_with_runner() { "portability.cookies.export"; }
async fn profile_cookies_replace_with_runner() { "portability.cookies.replace"; }
async fn profile_package_export_with_runner() { "portability.profile_package.export"; }
async fn profile_package_import_with_runner() { "portability.profile_package.import"; }
`);
  writeText(join(root, "scripts", "verify-m005-s04.mjs"), "export const verifier = true;\n");
  writeText(join(root, "scripts", "verify-m005-s04.test.mjs"), "import { describe } from 'vitest';\n");
  return root;
}

afterEach(() => {
  consoleSpy?.mockRestore();
  consoleSpy = undefined;
  while (tempRoots.length > 0) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe("verify-m005-s04 argument contract", () => {
  it("recognizes full, preflight, build, UI, skip-build, keep-temp, help, unknown, and conflict modes", () => {
    expect(parseArgs([])).toMatchObject({ mode: "full", preflightOnly: false, skipBuild: false, buildOnly: false, uiOnly: false, keepTemp: false, unknown: [], conflicts: [] });
    expect(parseArgs(["--preflight-only"])).toMatchObject({ mode: "preflight-only", preflightOnly: true, skipBuild: false, unknown: [], conflicts: [] });
    expect(parseArgs(["--build-only"])).toMatchObject({ mode: "build-only", buildOnly: true, skipBuild: false, unknown: [], conflicts: [] });
    expect(parseArgs(["--ui-only", "--keep-temp"])).toMatchObject({ mode: "ui-only", uiOnly: true, skipBuild: true, keepTemp: true, unknown: [], conflicts: [] });
    expect(parseArgs(["--bogus"])).toMatchObject({ unknown: ["--bogus"] });
    expect(() => assertValidArgs(parseArgs(["--preflight-only", "--ui-only"]))).toThrow(VerifyFailure);
  });
});

describe("verify-m005-s04 capability and config guardrails", () => {
  it("accepts M005 dialog permissions and proves the stale S06 capability guardrail is not reused", () => {
    const root = seedS04Root();
    expect(assertM005S04CapabilityConfig({ rootDir: root })).toMatchObject({ dialogOpenSave: "allowed", filesystemAuthority: "absent", fixedSidecarSpawn: true });
    expect(assertM005S04Guardrails({ rootDir: root, platform: "linux" })).toMatchObject({ tauriConfig: { linuxPackageTargets: ["deb", "rpm"] } });
    expect(() => assertS06TauriGuardrails({ rootDir: root, platform: "linux" })).toThrow(/Default capability widened/);
  });

  it("rejects missing dialog permission, broad filesystem/shell authority, arbitrary spawn, and missing Linux targets", () => {
    expect(() => assertM005S04CapabilityConfig({ rootDir: seedS04Root({ permissions: ["core:default", "dialog:allow-open", { identifier: "shell:allow-spawn", allow: [{ name: "binaries/theprivator-sidecar", sidecar: true }] }] }) })).toThrow(VerifyFailure);
    expect(() => assertM005S04CapabilityConfig({ rootDir: seedS04Root({ permissions: ["core:default", "dialog:allow-open", "dialog:allow-save", "fs:allow-read-text-file", { identifier: "shell:allow-spawn", allow: [{ name: "binaries/theprivator-sidecar", sidecar: true }] }] }) })).toThrow(VerifyFailure);
    expect(() => assertM005S04CapabilityConfig({ rootDir: seedS04Root({ permissions: ["core:default", "dialog:allow-open", "dialog:allow-save", "shell:allow-open", { identifier: "shell:allow-spawn", allow: [{ name: "binaries/theprivator-sidecar", sidecar: true }] }] }) })).toThrow(VerifyFailure);
    expect(() => assertM005S04CapabilityConfig({ rootDir: seedS04Root({ permissions: ["core:default", "dialog:allow-open", "dialog:allow-save", { identifier: "shell:allow-spawn", allow: [{ name: "binaries/other-sidecar", sidecar: true }] }] }) })).toThrow(VerifyFailure);
    expect(() => assertM005S04Guardrails({ rootDir: seedS04Root({ targets: ["appimage"] }), platform: "linux" })).toThrow(VerifyFailure);
  });
});

describe("verify-m005-s04 source guardrails", () => {
  it("accepts native dialogs, typed wrappers, fixed commands, and app-data root injection", () => {
    const root = seedS04Root();
    expect(assertM005S04SourceGuardrails({ rootDir: root })).toMatchObject({ uiUsesNativeDialogs: true, uiUsesTypedWrappers: true, clientUsesFixedCommands: true, privateScopeInjected: true });
  });

  it("rejects raw UI invokes, raw sidecar method selection, missing Rust commands, and ignored local-only fixture references", () => {
    expect(() => assertM005S04SourceGuardrails({ rootDir: seedS04Root({ appSource: 'import { open, save } from "@tauri-apps/plugin-dialog";\nopen(); save(); invoke("profile_cookies_export");\nexportProfileCookies; replaceProfileCookies; exportProfilePackage; importProfilePackage;\n' }) })).toThrow(VerifyFailure);
    expect(() => assertM005S04SourceGuardrails({ rootDir: seedS04Root({ clientSource: 'const method = "portability.profile_package.export";\ninvoke<unknown>("profile_cookies_export", {});\ninvoke<unknown>("profile_cookies_replace", {});\ninvoke<unknown>("profile_package_export", {});\ninvoke<unknown>("profile_package_import", {});\n' }) })).toThrow(VerifyFailure);
    expect(() => assertM005S04SourceGuardrails({ rootDir: seedS04Root({ libSource: "sidecar::profile_cookies_export\n" }) })).toThrow(VerifyFailure);
    const root = seedS04Root();
    writeText(join(root, "scripts", "verify-m005-s04.test.mjs"), "import '../." + "gsd/local-plan.md';\n");
    expect(() => assertM005S04SourceGuardrails({ rootDir: root })).toThrow(VerifyFailure);
  });
});

describe("verify-m005-s04 native dialog preflight", () => {
  it("plans Wayland automation with redacted save/open dialog summaries", () => {
    const commandExists = (name) => ["wtype", "wl-copy", "wl-paste"].includes(name);
    const plan = planNativeDialogAutomation({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-1", PATH: "/mock/bin" }, commandExists });
    expect(plan).toMatchObject({ strategy: "wayland", status: "available", clipboard: "wl-clipboard", missing: [] });
    const commandPlan = createNativeDialogCommandPlan({ dialog: "save", extension: "json", strategyPlan: plan });
    expect(commandPlan).toEqual({ dialog: "save", selected: true, extension: "json", strategy: "wayland", steps: ["focus-dialog", "clipboard-load", "confirm-selection"] });
    expect(findM005S04ForbiddenPublicMarker(commandPlan)).toBeNull();
  });

  it("falls back to X11 when Wayland is absent and fails closed for missing tools", () => {
    const x11Plan = planNativeDialogAutomation({ platform: "linux", env: { DISPLAY: ":1", PATH: "/mock/bin" }, commandExists: (name) => ["xdotool", "xclip"].includes(name) });
    expect(x11Plan).toMatchObject({ strategy: "x11", status: "available", clipboard: "xclip" });
    expect(() => assertNativeDialogAutomationPreflight({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-1", PATH: "/mock/bin" }, commandExists: () => false, strict: true })).toThrow(VerifyFailure);
  });

  it("summarizes native selections by dialog kind and extension without selected paths", () => {
    const selection = describeNativeDialogSelection({ dialog: "open", targetPath: "/private/theprivator-smoke/profile-package.tpkg" });
    expect(selection).toEqual({ dialog: "open", selected: true, extension: "tpkg" });
    expect(JSON.stringify(selection)).not.toContain("/private");
  });
});

describe("verify-m005-s04 scanner and summary contracts", () => {
  it("rejects selected paths, cookies, credentials, debug endpoints, process output, arguments, stacks, package members, and unsafe keys", () => {
    const context = createM005S04PublicScanContext({
      appDataRoot: "/private/app-data-root",
      selectedPaths: ["/private/app-data-root/export.json"],
      cookieDomains: ["m005-s04-cookie.invalid"],
      cookieNames: ["m005_s04_session"],
      cookieValues: ["m005-s04-cookie-value"],
      proxyCredentials: ["m005-s04-proxy-pass"],
      automationTokens: ["m005-s04-token"],
      debugEndpoints: ["ws://127.0.0.1:9222/devtools/browser/private"],
      packageMemberNames: ["manifest.json"],
    });
    for (const unsafe of [
      "/private/app-data-root/export.json",
      "m005-s04-cookie.invalid",
      "m005_s04_session",
      "m005-s04-cookie-value",
      "m005-s04-proxy-pass",
      "m005-s04-token",
      "ws://127.0.0.1:9222/devtools/browser/private",
      "Traceback stdout stderr stack trace",
      "--user-data-dir=/private/profile",
      "manifest.json",
      { selectedPath: "/private/app-data-root/export.json" },
    ]) {
      expect(findM005S04ForbiddenPublicMarker(unsafe, context)).toBeTruthy();
    }
    expect(() => assertM005S04PublicEvidenceRedacted({ cookieValue: "m005-s04-cookie-value" }, context)).toThrow(VerifyFailure);
  });

  it("formats subprocess failures with marker classes but without private values or forbidden public fields", () => {
    const context = createM005S04PublicScanContext({ appDataRoot: "/private/app-data-root", selectedPaths: ["/private/app-data-root/export.json"], cookieValues: ["m005-s04-cookie-value"], proxyCredentials: ["m005-s04-proxy-pass"] });
    const failure = formatM005S04CommandFailure("npm run verify:m005:s04", { status: 1, signal: null, stdout: "m005-s04-cookie-value /private/app-data-root/export.json", stderr: "Traceback --remote-debugging-port=9222 m005-s04-proxy-pass", error: null }, context, "runtime.cookie-export");
    const encoded = JSON.stringify(failure);
    expect(failure.markerClasses).toEqual(expect.arrayContaining(["app_root", "cookie_value", "credential", "debug_endpoint", "raw_diag"]));
    expect(encoded).not.toContain("m005-s04-cookie-value");
    expect(encoded).not.toContain("m005-s04-proxy-pass");
    expect(encoded).not.toContain("/private/app-data-root");
    expect(findM005S04ForbiddenPublicMarker(failure, context)).toBeNull();
  });

  it("builds a redacted final preflight summary", () => {
    const summary = buildM005S04FinalSummary({
      status: "pass",
      mode: "preflight-only",
      guardrails: { capability: { permissions: ["core:default", "dialog:allow-open", "dialog:allow-save", "shell:allow-spawn"], dialogOpenSave: "allowed", fixedSidecarSpawn: true }, tauriConfig: { linuxPackageTargets: ["deb", "rpm"] }, source: { privateScopeInjected: true } },
      preflight: { webdriver: { display: "available", missingToolClasses: [] }, nativeDialog: { status: "available", strategy: "wayland", display: "wayland", missingToolClasses: [] } },
      checks: [{ name: "preflight.native-dialog", status: "pass", durationMs: 2 }],
    });
    expect(summary.event).toBe(VERIFY_EVENT);
    expect(summary.preflight.nativeDialog.strategy).toBe("wayland");
    expect(findM005S04ForbiddenPublicMarker(summary)).toBeNull();
  });

  it("classifies unsafe marker classes and keeps this test file free of ignored local-only fixture imports", () => {
    const context = createM005S04PublicScanContext({ appDataRoot: "/private/app-data-root", cookieValues: ["m005-s04-cookie-value"] });
    expect(collectM005S04MarkerClasses("m005-s04-cookie-value /private/app-data-root Traceback", context)).toEqual(expect.arrayContaining(["app_root", "cookie_value", "raw_diag"]));
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    expect(IGNORED_ARTIFACT_REFERENCE_PATTERN.test(source)).toBe(false);
  });
});

describe("verify-m005-s04 preflight runner", () => {
  it("emits redacted guardrail and native preflight events with injected tool checks", () => {
    const root = seedS04Root();
    const lines = captureConsole();
    const summary = runPreflightOnlyVerification({
      rootDir: root,
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-1", PATH: "/mock/bin" },
      emitFinal: true,
      webdriverPreflight: () => ({ display: "available", missingToolClasses: [], requiredToolClasses: ["tauri-driver", "WebKitWebDriver", "Chromium"] }),
      nativeDialogPreflight: () => ({ strategy: "wayland", status: "available", display: "wayland", clipboard: "wl-clipboard", missingToolClasses: [], dialogs: [{ dialog: "save", selected: true, extension: "json" }] }),
    });
    expect(summary).toMatchObject({ status: "pass", mode: "preflight-only" });
    const events = lines.map((line) => JSON.parse(line));
    expect(events.some((event) => event.phase === "guardrails.m005-s04" && event.status === "pass")).toBe(true);
    expect(events.some((event) => event.phase === "preflight.native-dialog" && event.status === "pass")).toBe(true);
    expect(findM005S04ForbiddenPublicMarker(events)).toBeNull();
  });
});
