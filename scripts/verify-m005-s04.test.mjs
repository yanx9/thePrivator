import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyFailure } from "./verify-m004-s01.mjs";
import { assertTauriGuardrails as assertS06TauriGuardrails } from "./verify-s06.mjs";
import {
  VERIFY_EVENT,
  cleanupM005S04PackagedHarness,
  createM005S04CookieDbFixture,
  createM005S04PublicScanContext,
  createM005S04SmokeRunContext,
  createM005S04SourceProfileViaUi,
  createNativeDialogCommandPlan,
  assertM005S04CapabilityConfig,
  assertM005S04CopiedProfileRestored,
  assertM005S04Guardrails,
  assertM005S04PackageManifestContract,
  assertM005S04PublicEvidenceRedacted,
  assertM005S04RuntimeBookkeeping,
  assertM005S04SourceGuardrails,
  assertM005S04VisibleTextRedacted,
  assertM005S04BusyGuardTranscript,
  assertNativeDialogAutomationPreflight,
  assertValidArgs,
  buildM005S04FinalSummary,
  collectM005S04MarkerClasses,
  describeNativeDialogSelection,
  discoverM005S04SourceProfile,
  findM005S04ForbiddenPublicMarker,
  findM005S04HyprlandDialogAddress,
  formatM005S04CommandFailure,
  inspectM005S04CookieDbRows,
  inspectM005S04CookieExportFile,
  inspectM005S04Diagnostics,
  inspectM005S04PackageArchive,
  parseArgs,
  planNativeDialogAutomation,
  runM005S04WaylandClipboardLoad,
  runPreflightOnlyVerification,
  writeM005S04CookieImportFixtures,
  writeM005S04PayloadFixtures,
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

function seedPackagedProfileStore({ root = makeRoot(), profileName = "M005 Packaged Portability Smoke unit", profileId = "m005-s04-profile-1", storeVersion = 4, profiles } = {}) {
  const smokeRoot = join(root, "smoke-root");
  const dataRoot = join(smokeRoot, "data");
  const appDataRoot = join(dataRoot, "theprivator-app-data");
  const profile = {
    id: profileId,
    name: profileName,
    storage: {
      profileDir: `profile-store/profiles/${profileId}`,
      userDataDir: `profile-store/profiles/${profileId}/user-data`,
    },
  };
  writeJson(join(appDataRoot, "profile-store", "profiles.json"), { storeVersion, profiles: profiles ?? [profile] });
  return { root, smokeContext: { smokeRoot, dataRoot, smokeProfileName: profileName, runId: "unit" }, appDataRoot, profile, userDataRoot: join(appDataRoot, profile.storage.userDataDir) };
}

function writePackageFixture(packagePath, { includeRuntimeMember = false, omitCookieMember = false, extraRawMember = false, credentialProxy = false, manifestCookieLeak = false, missingLocalStorage = false } = {}) {
  const script = String.raw`
import hashlib, json, sys, zipfile
from pathlib import Path
payload = json.load(sys.stdin)
package_path = Path(payload["packagePath"])
package_path.parent.mkdir(parents=True, exist_ok=True)
cookie_payload = {"format":"theprivator.cookies","version":1,"cookies":[{"domain":"m005-s04-package.invalid","name":"m005_s04_package","value":"package-cookie-value","path":"/","secure":True,"httpOnly":True,"expires":1900000000}]}
cookie_bytes = json.dumps(cookie_payload, sort_keys=True).encode("utf-8")
pref_bytes = b'{"profile":{"name":"M005 S04 package payload"}}\n'
storage_bytes = b'm005-s04-safe-local-storage-payload\n'
payload_files = [{"path":"Default/Preferences","member":"payload/Default/Preferences","bytes":pref_bytes}]
if not payload.get("missingLocalStorage"):
  payload_files.append({"path":"Default/Local Storage/leveldb/000003.log","member":"payload/Default/Local Storage/leveldb/000003.log","bytes":storage_bytes})
proxy = {"proxyVersion":1,"mode":"direct"}
proxy_summary = {"proxyVersion":1,"mode":"direct","credentialState":"none","summary":"Direct connection"}
if payload.get("credentialProxy"):
  proxy = {"proxyVersion":1,"mode":"fixedServer","protocol":"http","host":"proxy.m005-s04.invalid","port":8080,"credentials":{"username":"u","password":"p"}}
  proxy_summary = {"proxyVersion":1,"mode":"fixedServer","credentialState":"configured","summary":"credentialed proxy should stay private"}
manifest = {
  "format":"theprivator.profile-package",
  "version":1,
  "createdAt":"2026-01-01T00:00:00.000Z",
  "profile":{"name":"M005 S04 Package","identity":{"identityVersion":1},"proxy":proxy,"proxySummary":proxy_summary},
  "cookies":{"member":"cookies/theprivator-cookies.json","format":"theprivator.cookies","version":1,"byteCount":len(cookie_bytes),"sha256":hashlib.sha256(cookie_bytes).hexdigest(),"cookieCount":1,"skippedCount":0},
  "payload":{"prefix":"payload/","fileCount":len(payload_files),"byteCount":sum(len(item["bytes"]) for item in payload_files),"files":[{"path":item["path"],"member":item["member"],"byteCount":len(item["bytes"]),"sha256":hashlib.sha256(item["bytes"]).hexdigest()} for item in payload_files]},
  "warnings":[],
}
if payload.get("manifestCookieLeak"):
  manifest["profile"]["name"] = "package-cookie-value"
with zipfile.ZipFile(package_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
  archive.writestr("manifest.json", json.dumps(manifest, sort_keys=True).encode("utf-8"))
  if not payload.get("omitCookieMember"):
    archive.writestr("cookies/theprivator-cookies.json", cookie_bytes)
  for item in payload_files:
    archive.writestr(item["member"], item["bytes"])
  if payload.get("includeRuntimeMember"):
    archive.writestr("payload/Default/Network/Cookies", b"raw runtime db")
  if payload.get("extraRawMember"):
    archive.writestr("raw-diagnostics.txt", b"Traceback stdout stderr")
`;
  const result = spawnSync(process.env.PYTHON ?? "python3", ["-c", script], { input: JSON.stringify({ packagePath, includeRuntimeMember, omitCookieMember, extraRawMember, credentialProxy, manifestCookieLeak, missingLocalStorage }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) throw new Error(`package fixture failed: ${result.stderr || result.error?.message}`);
}

function writeDiagnosticsFixture(appDataRoot, rows) {
  writeText(join(appDataRoot, "profile-store", "diagnostics", "events.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function diagnosticRow(method, overrides = {}) {
  return {
    schemaVersion: 1,
    ts: "2026-01-01T00:00:00.000Z",
    requestId: `req-${method.replace(/[^A-Za-z0-9]/g, "-")}`,
    logPath: "profile-store/diagnostics/events.jsonl",
    event: "sidecar.request",
    source: "python-sidecar",
    method,
    status: "ok",
    durationMs: 3,
    errorCode: null,
    detailRef: null,
    ...overrides,
  };
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
    app: { windows: [{ label: "main", decorations: false }] },
    bundle: { externalBin: ["binaries/theprivator-sidecar"], targets },
  });
  writeJson(join(root, "package.json"), {
    scripts: { "verify:m005:s04": packageScript },
    dependencies: { "@tauri-apps/api": "^2.0.0", "@tauri-apps/plugin-dialog": "^2.0.0" },
  });
  writeText(join(root, "README.md"), "npm run verify:m005:s04 --preflight-only --build-only --ui-only --skip-build --keep-temp verify.m005.s04 native open/save dialogs redaction scanner cleanup PORTABILITY_PROFILE_BUSY R033/R034/R035/R037/R038/R039/R040\n");
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
    // Assert that S06's capability guardrail rejects an M005 root, via its stable
    // error code rather than its prose. Which rejection branch fires depends on
    // S06's own allow-list, which is owned by verify-s06 and may grow; pinning the
    // exact message or branch here couples this suite to that file's wording.
    let s06Failure;
    try {
      assertS06TauriGuardrails({ rootDir: root, platform: "linux" });
    } catch (error) {
      s06Failure = error;
    }
    // Not toBeInstanceOf: each verifier script declares its own VerifyFailure class,
    // so an error thrown by verify-s06 is never an instance of the one imported here.
    expect(s06Failure?.name).toBe("VerifyFailure");
    expect(s06Failure.details?.code).toMatch(/^S06_CAPABILITY_/);
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
  it("plans Wayland AT-SPI selection with redacted save/open dialog summaries", () => {
    const commandExists = (name) => name === "python3";
    const plan = planNativeDialogAutomation({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-1", PATH: "/mock/bin" }, commandExists });
    expect(plan).toMatchObject({ strategy: "wayland", status: "available", keyboard: "at-spi", clipboard: "none", missing: [] });
    const commandPlan = createNativeDialogCommandPlan({ dialog: "save", extension: "json", strategyPlan: plan });
    expect(commandPlan).toEqual({ dialog: "save", selected: true, extension: "json", strategy: "wayland", steps: ["focus-dialog", "type-selection", "confirm-selection"] });
    expect(findM005S04ForbiddenPublicMarker(commandPlan)).toBeNull();
  });

  it("falls back to Wayland ydotool when AT-SPI is unavailable", () => {
    const commandExists = (name) => ["ydotool", "wl-copy", "wl-paste"].includes(name);
    const plan = planNativeDialogAutomation({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-1", PATH: "/mock/bin" }, commandExists });
    expect(plan).toMatchObject({ strategy: "wayland", status: "available", keyboard: "ydotool", clipboard: "wl-clipboard", missing: [] });
  });

  it("falls back to X11 when Wayland is absent and fails closed for missing tools", () => {
    const x11PythonPlan = planNativeDialogAutomation({ platform: "linux", env: { DISPLAY: ":1", PATH: "/mock/bin" }, commandExists: (name) => name === "python3" });
    expect(x11PythonPlan).toMatchObject({ strategy: "x11", status: "available", keyboard: "at-spi", clipboard: "none" });
    const x11Plan = planNativeDialogAutomation({ platform: "linux", env: { DISPLAY: ":1", PATH: "/mock/bin" }, commandExists: (name) => ["xdotool", "xclip"].includes(name) });
    expect(x11Plan).toMatchObject({ strategy: "x11", status: "available", keyboard: "xdotool", clipboard: "xclip" });
    expect(() => assertNativeDialogAutomationPreflight({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-1", PATH: "/mock/bin" }, commandExists: () => false, strict: true })).toThrow(VerifyFailure);
  });

  it("matches Hyprland native dialog windows by exact safe title or non-main ThePrivator fallback address", () => {
    const clients = [
      { class: "theprivator", title: "ThePrivator", address: "0x1" },
      { class: "theprivator", title: "Export cookies as ThePrivator JSON", address: "0xabc" },
      { class: "other", title: "Export cookies as ThePrivator JSON", address: "0xdef" },
    ];
    expect(findM005S04HyprlandDialogAddress(clients, "Export cookies as ThePrivator JSON")).toBe("0xabc");
    expect(findM005S04HyprlandDialogAddress(clients, "Import ThePrivator package")).toBe("0xabc");
    expect(findM005S04HyprlandDialogAddress([{ class: "theprivator", title: "ThePrivator", address: "0x1" }], "Import ThePrivator package")).toBeNull();
  });

  it("loads Wayland clipboard through detached paste-once process without inheriting output streams", async () => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = vi.fn((value, encoding, callback) => {
      expect(value).toBe("/private/theprivator-smoke/cookies.json");
      expect(encoding).toBe("utf8");
      setImmediate(callback);
    });
    child.kill = vi.fn();
    child.unref = vi.fn();
    const spawnClipboardProcess = vi.fn(() => child);
    const context = createM005S04PublicScanContext({ selectedPaths: ["/private/theprivator-smoke/cookies.json"] });

    await expect(runM005S04WaylandClipboardLoad("/private/theprivator-smoke/cookies.json", { context, phase: "native-dialog.save.json", timeoutMs: 100, settleMs: 0, spawnClipboardProcess })).resolves.toMatchObject({ clipboardMode: "paste-once", exitCode: 0 });

    expect(spawnClipboardProcess).toHaveBeenCalledWith(expect.stringMatching(/wl-copy$/), ["--paste-once"], { stdio: ["pipe", "ignore", "ignore"], detached: true });
    expect(child.unref).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
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
      chromiumPreflight: () => ({ chromium: "available", source: "test" }),
      nativeDialogPreflight: () => ({ strategy: "wayland", status: "available", display: "wayland", clipboard: "wl-clipboard", missingToolClasses: [], dialogs: [{ dialog: "save", selected: true, extension: "json" }] }),
    });
    expect(summary).toMatchObject({ status: "pass", mode: "preflight-only" });
    const events = lines.map((line) => JSON.parse(line));
    expect(events.some((event) => event.phase === "guardrails.m005-s04" && event.status === "pass")).toBe(true);
    expect(events.some((event) => event.phase === "preflight.chromium" && event.status === "pass")).toBe(true);
    expect(events.some((event) => event.phase === "preflight.native-dialog" && event.status === "pass")).toBe(true);
    expect(findM005S04ForbiddenPublicMarker(events)).toBeNull();
  });
});

describe("verify-m005-s04 packaged harness profile discovery", () => {
  it("creates an M005-prefixed isolated smoke context and derives private profile storage from the packaged store", () => {
    const root = makeRoot();
    const smoke = createM005S04SmokeRunContext({ rootDir: root, runId: "unit-run", nonce: "unit", now: new Date("2026-01-01T00:00:00.000Z"), baseEnv: {} });
    expect(smoke.value.smokeProfileName).toContain("M005 Packaged Portability Smoke");
    expect(smoke.log).toMatchObject({ profileName: "generated", isolatedRoots: "created", rootScope: "private" });
    expect(findM005S04ForbiddenPublicMarker(smoke.log, createM005S04PublicScanContext({ tempRoot: smoke.value.smokeRoot }))).toBeNull();

    const seeded = seedPackagedProfileStore({ root, profileName: smoke.value.smokeProfileName });
    const discovered = discoverM005S04SourceProfile({ rootDir: root, smokeContext: seeded.smokeContext, profileName: smoke.value.smokeProfileName });
    expect(discovered.value.profile.id).toBe(seeded.profile.id);
    expect(discovered.value.appDataRoot).toBe(seeded.appDataRoot);
    expect(discovered.value.userDataRoot).toBe(seeded.userDataRoot);
    expect(discovered.log).toMatchObject({ profileFound: true, privateProfileId: "derived", storage: "safe-relative-store-paths" });
    expect(findM005S04ForbiddenPublicMarker(discovered.log, createM005S04PublicScanContext({ appDataRoot: seeded.appDataRoot, userDataRoot: seeded.userDataRoot }))).toBeNull();
  });

  it("fails safely for missing stores and malformed profile records", () => {
    const root = makeRoot();
    const smokeContext = { smokeRoot: join(root, "smoke"), dataRoot: join(root, "smoke", "data"), smokeProfileName: "missing", runId: "unit" };
    mkdirSync(smokeContext.dataRoot, { recursive: true });
    expect(() => discoverM005S04SourceProfile({ rootDir: root, smokeContext })).toThrow(VerifyFailure);
    const malformed = seedPackagedProfileStore({ root, profiles: [{ id: "profile-1", name: "missing", storage: { profileDir: "../bad", userDataDir: "../bad/user-data" } }] });
    expect(() => discoverM005S04SourceProfile({ rootDir: root, smokeContext: malformed.smokeContext })).toThrow(VerifyFailure);
  });
});

describe("verify-m005-s04 fixture helpers", () => {
  it("creates and inspects a Chromium cookie DB with redacted aggregate public output", () => {
    const { appDataRoot, userDataRoot } = seedPackagedProfileStore();
    const context = createM005S04PublicScanContext({ appDataRoot, userDataRoot, cookieDomains: ["m005-s04-cookie.invalid"], cookieNames: ["m005_s04_session"], cookieValues: ["m005-s04-cookie-value"] });
    const created = createM005S04CookieDbFixture({ appDataRoot, userDataRoot }, context);
    expect(created.log).toMatchObject({ cookieDb: "created", rowCount: 2, pathScope: "isolated" });
    const inspected = inspectM005S04CookieDbRows({ appDataRoot, userDataRoot, expectedRows: created.value.cookies }, context);
    expect(inspected.log).toMatchObject({ cookieDb: "present", rowCount: 2, expectedRowsPresent: true, missingExpectedCount: 0 });
    const missing = inspectM005S04CookieDbRows({ appDataRoot, userDataRoot, expectedRows: [{ domain: "missing.invalid", name: "missing", value: "missing" }] }, context);
    expect(missing.log).toMatchObject({ expectedRowsPresent: false, missingExpectedCount: 1 });
    expect(findM005S04ForbiddenPublicMarker([created.log, inspected.log], context)).toBeNull();
  });

  it("writes deterministic import and payload fixtures without leaking private paths in public summaries", () => {
    const { smokeContext, appDataRoot, userDataRoot } = seedPackagedProfileStore();
    const context = createM005S04PublicScanContext({ tempRoot: smokeContext.smokeRoot, appDataRoot, userDataRoot });
    const imports = writeM005S04CookieImportFixtures({ smokeRoot: smokeContext.smokeRoot }, context);
    const payload = writeM005S04PayloadFixtures({ appDataRoot, userDataRoot, selectedPackagePath: join(smokeContext.smokeRoot, "fixtures", "selected-output.tpkg") }, context);
    expect(readFileSync(imports.value.jsonPath, "utf8")).toContain("theprivator.cookies");
    expect(readFileSync(imports.value.jsonPath, "utf8")).toContain("expiresUnix");
    expect(readFileSync(imports.value.netscapePath, "utf8")).toContain("Netscape HTTP Cookie File");
    expect(readFileSync(payload.value.preferencesPath, "utf8")).toContain("M005 S04 safe payload");
    expect(readFileSync(payload.value.runtimeDebugPath, "utf8")).toContain("devtools/browser");
    expect(imports.log).toMatchObject({ fixtureFormatCount: 2, cookieCount: 2, pathScope: "smoke-root" });
    expect(payload.log).toMatchObject({ safePayloadFileCount: 2, volatileRuntimeFileCount: 2, selectedDestinationFixture: true });
    expect(findM005S04ForbiddenPublicMarker([imports.log, payload.log], context)).toBeNull();
  });
});

describe("verify-m005-s04 archive and diagnostics inspectors", () => {
  it("inspects .tpkg archives with S02 package scans while exposing only aggregate booleans and counts", () => {
    const root = makeRoot();
    const packagePath = join(root, "fixtures", "portable.tpkg");
    writePackageFixture(packagePath);
    const context = createM005S04PublicScanContext({ rootDir: root, selectedPaths: [packagePath], packageMemberNames: ["manifest.json", "cookies/theprivator-cookies.json", "payload/Default/Preferences"] });
    const inspection = inspectM005S04PackageArchive({ rootDir: root, packagePath, selectedPaths: [packagePath] }, context);
    expect(inspection.log).toMatchObject({ archive: "valid", manifestPresent: true, cookieMemberPresent: true, payloadFileCount: 2, cookieCount: 1, runtimeMembersSkipped: true, proxyMode: "direct", checksumValidated: true });
    const encoded = JSON.stringify(inspection.log);
    expect(encoded).not.toContain("manifest.json");
    expect(encoded).not.toContain("payload/Default/Preferences");
    expect(findM005S04ForbiddenPublicMarker(inspection.log, context)).toBeNull();

    const unsafePackagePath = join(root, "fixtures", "runtime-member.tpkg");
    writePackageFixture(unsafePackagePath, { includeRuntimeMember: true });
    expect(() => inspectM005S04PackageArchive({ rootDir: root, packagePath: unsafePackagePath })).toThrow(VerifyFailure);
  });

  it("accepts direct-proxy manifests and rejects credentials, missing members, unsafe markers, and missing payload expectations", () => {
    const root = makeRoot();
    const packagePath = join(root, "fixtures", "direct.tpkg");
    writePackageFixture(packagePath);
    const context = createM005S04PublicScanContext({ rootDir: root, selectedPaths: [packagePath], cookieValues: ["package-cookie-value"] });
    const inspection = inspectM005S04PackageArchive({ rootDir: root, packagePath, selectedPaths: [packagePath], expectedPayloadRelativePaths: ["Default/Preferences", "Default/Local Storage/leveldb/000003.log"] }, context);
    expect(assertM005S04PackageManifestContract(inspection.value.inspection.manifest, { expectedProfileName: "M005 S04 Package" })).toMatchObject({ proxyMode: "direct", directProxyAccepted: true, proxyCredentialStripped: true });

    const credentialPath = join(root, "fixtures", "credential.tpkg");
    writePackageFixture(credentialPath, { credentialProxy: true });
    expect(() => inspectM005S04PackageArchive({ rootDir: root, packagePath: credentialPath })).toThrow(VerifyFailure);

    const missingCookiePath = join(root, "fixtures", "missing-cookie.tpkg");
    writePackageFixture(missingCookiePath, { omitCookieMember: true });
    expect(() => inspectM005S04PackageArchive({ rootDir: root, packagePath: missingCookiePath })).toThrow(VerifyFailure);

    const extraMemberPath = join(root, "fixtures", "extra-raw.tpkg");
    writePackageFixture(extraMemberPath, { extraRawMember: true });
    expect(() => inspectM005S04PackageArchive({ rootDir: root, packagePath: extraMemberPath })).toThrow(VerifyFailure);

    const manifestLeakPath = join(root, "fixtures", "manifest-cookie-leak.tpkg");
    writePackageFixture(manifestLeakPath, { manifestCookieLeak: true });
    expect(() => inspectM005S04PackageArchive({ rootDir: root, packagePath: manifestLeakPath, expectedCookieRows: [{ domain: "m005-s04-package.invalid", name: "m005_s04_package", value: "package-cookie-value" }] })).toThrow(VerifyFailure);

    const missingPayloadPath = join(root, "fixtures", "missing-local-storage.tpkg");
    writePackageFixture(missingPayloadPath, { missingLocalStorage: true });
    expect(() => inspectM005S04PackageArchive({ rootDir: root, packagePath: missingPayloadPath, expectedPayloadRelativePaths: ["Default/Preferences", "Default/Local Storage/leveldb/000003.log"] })).toThrow(VerifyFailure);
  });

  it("asserts copied-profile store, stopped runtime, restored cookies, and restored payload files", () => {
    const seeded = seedPackagedProfileStore({ profileName: "M005 Packaged Portability Smoke Copy Unit" });
    const imported = {
      ...seeded.profile,
      id: "m005-s04-profile-copy",
      name: `${seeded.profile.name} Copy`,
      storage: {
        profileDir: "profile-store/profiles/m005-s04-profile-copy",
        userDataDir: "profile-store/profiles/m005-s04-profile-copy/user-data",
      },
      metadata: {
        source: "profile-package",
        format: "theprivator.profile-package",
        formatVersion: "1",
        originalName: seeded.profile.name,
        hasUserData: true,
      },
    };
    const profileStorePath = join(seeded.appDataRoot, "profile-store", "profiles.json");
    writeJson(profileStorePath, { storeVersion: 4, profiles: [seeded.profile, imported] });
    const importedUserDataRoot = join(seeded.appDataRoot, imported.storage.userDataDir);
    const context = createM005S04PublicScanContext({ appDataRoot: seeded.appDataRoot, userDataRoot: importedUserDataRoot, cookieDomains: ["m005-s04-cookie.invalid"], cookieNames: ["m005_s04_session", "m005_s04_theme"], cookieValues: ["m005-s04-cookie-value", "m005-s04-second-cookie-value"] });
    const cookies = createM005S04CookieDbFixture({ appDataRoot: seeded.appDataRoot, userDataRoot: importedUserDataRoot }, context);
    writeText(join(importedUserDataRoot, "Default", "Preferences"), "restored preferences\n");
    writeText(join(importedUserDataRoot, "Default", "Local Storage", "leveldb", "000003.log"), "restored local storage\n");
    const restored = assertM005S04CopiedProfileRestored({ profileStorePath, appDataRoot: seeded.appDataRoot, sourceProfile: seeded.profile, expectedCookieRows: cookies.value.cookies, expectedPayloadRelativePaths: ["Default/Preferences", "Default/Local Storage/leveldb/000003.log"] }, context);
    expect(restored.value.profile.id).toBe(imported.id);
    expect(restored.log).toMatchObject({ copiedProfile: "restored", sourcePreserved: true, copiedIdDistinct: true, nameConflictResolved: true, runtimeStatus: "stopped", expectedCookiesPresent: true, payloadFilesRestored: 2 });
    expect(findM005S04ForbiddenPublicMarker(restored.log, context)).toBeNull();

    writeJson(profileStorePath, { storeVersion: 4, profiles: [seeded.profile, { ...imported, name: "Wrong Imported Name" }] });
    expect(() => assertM005S04CopiedProfileRestored({ profileStorePath, appDataRoot: seeded.appDataRoot, sourceProfile: seeded.profile, expectedCookieRows: cookies.value.cookies }, context)).toThrow(VerifyFailure);
  });

  it("validates exported cookie files and runtime bookkeeping without leaking cookie material or owner tokens", () => {
    const seeded = seedPackagedProfileStore({ profileName: "M005 Packaged Portability Smoke Runtime Unit" });
    const exportPath = join(seeded.smokeContext.smokeRoot, "fixtures", "exported.json");
    const cookies = [
      { domain: "m005-s04-export.invalid", name: "m005_s04_export", value: "m005-s04-export-value" },
    ];
    writeJson(exportPath, { format: "theprivator.cookies", version: 1, cookies });
    const context = createM005S04PublicScanContext({ appDataRoot: seeded.appDataRoot, selectedPaths: [exportPath], cookieDomains: cookies.map((cookie) => cookie.domain), cookieNames: cookies.map((cookie) => cookie.name), cookieValues: cookies.map((cookie) => cookie.value) });
    const inspected = inspectM005S04CookieExportFile({ exportPath, expectedRows: cookies }, context);
    expect(inspected.log).toMatchObject({ cookieExportFile: "valid", cookieRowCount: 1, expectedRowsPresent: true, selectionPrivate: true });

    const runtimePath = join(seeded.appDataRoot, "profile-store", "runtime", "chromium-processes.json");
    writeJson(runtimePath, { registryVersion: 1, processes: { [seeded.profile.id]: { profileId: seeded.profile.id, pid: 12345, startedAt: "2026-01-01T00:00:00.000Z", userDataDir: seeded.profile.storage.userDataDir, ownerToken: "private-owner-token" } } });
    const running = assertM005S04RuntimeBookkeeping({ appDataRoot: seeded.appDataRoot, profile: seeded.profile, expectedRunning: true, expectedRunningCount: 1 }, createM005S04PublicScanContext({ appDataRoot: seeded.appDataRoot }));
    expect(running.log).toMatchObject({ runtimeBookkeeping: "running", profileRecord: "present", runningCount: 1, userDataScope: "safe-relative" });
    expect(JSON.stringify(running.log)).not.toContain("private-owner-token");
    expect(findM005S04ForbiddenPublicMarker([inspected.log, running.log], context)).toBeNull();

    writeJson(runtimePath, { registryVersion: 1, processes: {} });
    const stopped = assertM005S04RuntimeBookkeeping({ appDataRoot: seeded.appDataRoot, profile: seeded.profile, expectedRunning: false, expectedRunningCount: 0 }, context);
    expect(stopped.log).toMatchObject({ runtimeBookkeeping: "stopped", profileRecord: "absent", runningCount: 0 });
    writeJson(runtimePath, { registryVersion: 1, processes: { [seeded.profile.id]: { profileId: seeded.profile.id, pid: "bad" } } });
    expect(() => assertM005S04RuntimeBookkeeping({ appDataRoot: seeded.appDataRoot, profile: seeded.profile, expectedRunning: true }, context)).toThrow(VerifyFailure);
  });

  it("accepts only typed PORTABILITY_PROFILE_BUSY direct sidecar envelopes", () => {
    const context = createM005S04PublicScanContext({ selectedPaths: ["/private/busy-output.tpkg"] });
    const transcript = {
      response: { id: "busy", ok: false, protocolVersion: "1.0.0", durationMs: 4, error: { code: "PORTABILITY_PROFILE_BUSY", message: "Profile must be stopped before package portability.", recoverable: true, detailRef: "sidecar-busy-ref" } },
      diagnostic: diagnosticRow("portability.profile_package.export", { requestId: "busy", status: "error", errorCode: "PORTABILITY_PROFILE_BUSY", detailRef: "sidecar-busy-ref" }),
    };
    const busy = assertM005S04BusyGuardTranscript({ transcript, requestId: "busy" }, context);
    expect(busy.log).toMatchObject({ busyGuard: "blocked", errorCode: "PORTABILITY_PROFILE_BUSY", detailRef: "observed", diagnosticStatus: "error" });
    expect(findM005S04ForbiddenPublicMarker(busy.log, context)).toBeNull();

    const malformed = { ...transcript, response: { ...transcript.response, error: { ...transcript.response.error, debugPort: "9222" } } };
    expect(() => assertM005S04BusyGuardTranscript({ transcript: malformed, requestId: "busy" }, context)).toThrow(VerifyFailure);
    const unexpectedSuccess = { ...transcript, response: { id: "busy", ok: true, result: {} } };
    expect(() => assertM005S04BusyGuardTranscript({ transcript: unexpectedSuccess, requestId: "busy" }, context)).toThrow(VerifyFailure);
  });

  it("parses bounded diagnostics JSONL into safe aggregate counts and rejects forbidden raw fields", () => {
    const { appDataRoot } = seedPackagedProfileStore();
    writeDiagnosticsFixture(appDataRoot, [
      diagnosticRow("portability.cookies.export"),
      diagnosticRow("portability.cookies.replace"),
      diagnosticRow("portability.profile_package.export"),
      diagnosticRow("portability.profile_package.import", { status: "error", errorCode: "PORTABILITY_PACKAGE_INVALID", detailRef: "sidecar-safe-ref" }),
    ]);
    const context = createM005S04PublicScanContext({ appDataRoot });
    const diagnostics = inspectM005S04Diagnostics({ appDataRoot }, context);
    expect(diagnostics.log).toMatchObject({ diagnostics: "parsed", validRows: 4, malformedRows: 0, okRows: 3, errorRows: 1, typedErrorCodes: ["PORTABILITY_PACKAGE_INVALID"] });
    expect(diagnostics.log.required["portability.cookies.export"]).toMatchObject({ observed: 1, okRows: 1 });
    expect(findM005S04ForbiddenPublicMarker(diagnostics.log, context)).toBeNull();

    writeDiagnosticsFixture(appDataRoot, [diagnosticRow("portability.cookies.export", { stdout: "/private/raw" })]);
    expect(() => inspectM005S04Diagnostics({ appDataRoot }, context)).toThrow(VerifyFailure);
  });
});

describe("verify-m005-s04 packaged UI and cleanup wrappers", () => {
  it("drives source profile creation through visible S06 UI helpers and emits only safe booleans", async () => {
    const calls = [];
    const runtime = { smokeContext: { smokeProfileName: "M005 Packaged Portability Smoke unit" } };
    const proof = await createM005S04SourceProfileViaUi({}, runtime, {
      waitForVisibleText: async () => calls.push("visible-text"),
      waitForVisibleElement: async () => calls.push("visible-element"),
      assertInitialPackagedUi: async () => calls.push("initial-ui"),
      createSmokeProfile: async () => calls.push("create-profile"),
      waitForProfileCard: async () => calls.push("profile-card"),
      readProfileCardText: async () => "Profile card visible text",
      readProfileSectionText: async () => "Export cookies Import cookies Export package Import package",
      readMetricValue: async () => "0",
    });
    expect(calls).toEqual(["visible-text", "visible-element", "initial-ui", "create-profile", "profile-card"]);
    expect(proof.log).toMatchObject({ sourceProfile: "created-visible-ui", profileCard: "visible", cardTextObserved: true, portabilityActionsObserved: true, metricReader: "available" });
    expect(findM005S04ForbiddenPublicMarker(proof.log)).toBeNull();
  });

  it("suppresses S06 cleanup output and removes the smoke root on successful non-keep-temp cleanup", async () => {
    const { smokeContext } = seedPackagedProfileStore();
    expect(readFileSync(join(smokeContext.smokeRoot, "data", "theprivator-app-data", "profile-store", "profiles.json"), "utf8")).toContain("profiles");
    const cleanup = await cleanupM005S04PackagedHarness({
      runtime: { smokeContext },
      passed: true,
      keepTemp: false,
      cleanupPackagedSmoke: async () => {
        console.log(JSON.stringify({ event: "verify.s06", smokeRoot: smokeContext.smokeRoot }));
        return { webdriverSession: { status: "quit" }, driverProcess: { status: "stopped" }, ownedChromium: "not-observed" };
      },
    }, createM005S04PublicScanContext({ tempRoot: smokeContext.smokeRoot }));
    expect(cleanup.log).toMatchObject({ webdriverSession: "quit", driverProcess: "stopped", ownedChromium: "not-observed", tempState: "removed", retained: false, foreignOutputSuppressed: true });
    expect(() => readFileSync(join(smokeContext.smokeRoot, "data", "theprivator-app-data", "profile-store", "profiles.json"), "utf8")).toThrow();
    expect(findM005S04ForbiddenPublicMarker(cleanup.log, createM005S04PublicScanContext({ tempRoot: smokeContext.smokeRoot }))).toBeNull();
  });
});

