import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyFailure } from "./verify-m004-s01.mjs";
import {
  COOKIE_MEMBER,
  MANIFEST_MEMBER,
  PACKAGE_FORMAT,
  VERIFY_EVENT,
  assertM005S02CapabilityConfig,
  assertM005S02PackageContentClean,
  assertM005S02PackageManifestSummary,
  assertM005S02PublicEvidenceRedacted,
  assertM005S02ReadmeDocs,
  assertM005S02SourceGuardrails,
  buildM005S02FinalSummary,
  createM005S02PackageScanContext,
  createM005S02PublicScanContext,
  findM005S02ForbiddenPackageMarker,
  findM005S02ForbiddenPackageMember,
  findM005S02ForbiddenPublicMarker,
  formatM005S02CommandFailure,
  parseArgs,
  runGuardrailsOnlyVerification,
} from "./verify-m005-s02.mjs";

let consoleSpy;

afterEach(() => {
  consoleSpy?.mockRestore();
  consoleSpy = undefined;
});

function captureConsole() {
  const lines = [];
  consoleSpy = vi.spyOn(console, "log").mockImplementation((line) => {
    lines.push(String(line));
  });
  return lines;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seedCapabilityRoot({ permissions, readme } = {}) {
  const root = mkdtempRoot("theprivator-m005-s02-cap-");
  mkdirSync(join(root, "src-tauri", "capabilities"), { recursive: true });
  mkdirSync(join(root, "src-tauri", "src"), { recursive: true });
  mkdirSync(join(root, "src", "sidecar"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });

  const defaultPermissions = [
    "core:default",
    "dialog:allow-open",
    "dialog:allow-save",
    { identifier: "shell:allow-spawn", allow: [{ name: "binaries/theprivator-sidecar", sidecar: true }] },
  ];

  writeJson(join(root, "src-tauri", "capabilities", "default.json"), {
    identifier: "default",
    windows: ["main"],
    permissions: permissions ?? defaultPermissions,
  });
  writeJson(join(root, "package.json"), {
    scripts: { "verify:m005:s02": "node scripts/verify-m005-s02.mjs" },
    dependencies: { "@tauri-apps/api": "^2.0.0", "@tauri-apps/plugin-dialog": "^2.0.0" },
  });
  writeJson(join(root, "package-lock.json"), {
    packages: {
      "": { dependencies: { "@tauri-apps/api": "^2.0.0", "@tauri-apps/plugin-dialog": "^2.0.0" } },
      "node_modules/@tauri-apps/plugin-dialog": { version: "2.4.0" },
    },
  });
  writeFileSync(join(root, "src-tauri", "Cargo.toml"), '[dependencies]\ntauri = "2"\ntauri-plugin-dialog = "2"\ntauri-plugin-shell = "2"\n', "utf8");
  writeFileSync(join(root, "src-tauri", "Cargo.lock"), '[[package]]\nname = "tauri-plugin-dialog"\nversion = "2.4.0"\n', "utf8");
  writeFileSync(join(root, "src-tauri", "src", "lib.rs"), ".plugin(tauri_plugin_dialog::init())\nsidecar::profile_package_export\nsidecar::profile_package_import\n", "utf8");
  writeFileSync(join(root, "src-tauri", "src", "sidecar.rs"), '"portability.profile_package.export"\n"portability.profile_package.import"\n', "utf8");
  writeFileSync(join(root, "src", "App.tsx"), "import { exportProfilePackage, importProfilePackage } from './sidecar/client';\n", "utf8");
  writeFileSync(join(root, "src", "App.test.tsx"), "import { describe, it } from 'vitest';\ndescribe('app package UI', () => { it('uses inline fixtures', () => {}); });\n", "utf8");
  writeFileSync(join(root, "src", "sidecar", "client.ts"), 'invoke<unknown>("profile_package_export", {});\ninvoke<unknown>("profile_package_import", {});\n', "utf8");
  writeFileSync(join(root, "src", "sidecar", "client.test.ts"), "import { describe } from 'vitest';\n", "utf8");
  writeFileSync(join(root, "src", "sidecar", "types.ts"), "export type ProfilePackageOperation = 'export' | 'import';\n", "utf8");
  writeFileSync(join(root, "scripts", "verify-m005-s02.mjs"), "export const verifier = true;\n", "utf8");
  writeFileSync(join(root, "scripts", "verify-m005-s02.test.mjs"), "import { describe } from 'vitest';\n", "utf8");
  writeFileSync(
    join(root, "README.md"),
    readme ?? "Use `npm run verify:m005:s02` for the M005 S02 .tpkg profile package proof. It documents public redaction versus package-content archive scan boundaries, defers the unsafe package rejection matrix to S03, and defers packaged real-dialog proof to S04.\n",
    "utf8",
  );
  return root;
}

function mkdtempRoot(prefix) {
  return join(tmpdir(), `${prefix}${Math.random().toString(16).slice(2)}`);
}

function goodManifest(overrides = {}) {
  return {
    format: PACKAGE_FORMAT,
    version: 1,
    createdAt: "2026-05-20T09:00:00.000Z",
    profile: {
      name: "M005 S02 Package Smoke",
      identity: { identityVersion: 1, label: "Ubuntu", browser: { mode: "real" }, navigator: { mode: "real" }, screen: { mode: "real" }, locale: { mode: "real" }, canvas: { mode: "real" }, audio: { mode: "real" }, webgl: { mode: "real" }, webrtc: { mode: "real", policy: "real" } },
      proxy: { proxyVersion: 1, mode: "fixedServer", protocol: "socks5", host: "proxy.m005-s02.invalid", port: 19080 },
      proxySummary: { proxyVersion: 1, mode: "fixedServer", protocol: "socks5", host: "proxy.m005-s02.invalid", port: 19080, credentialState: "none", summary: "socks5://proxy.m005-s02.invalid:19080" },
    },
    cookies: { member: COOKIE_MEMBER, format: "theprivator.cookies", version: 1, byteCount: 128, sha256: "a".repeat(64), cookieCount: 2, skippedCount: 0 },
    payload: { prefix: "payload/", fileCount: 1, byteCount: 12, files: [{ path: "Default/Preferences", member: "payload/Default/Preferences", byteCount: 12, sha256: "b".repeat(64) }] },
    warnings: [],
    ...overrides,
  };
}

describe("verify-m005-s02 argument contract", () => {
  it("recognizes sidecar, guardrail, and help modes", () => {
    expect(parseArgs(["--sidecar-only"])).toMatchObject({ sidecarOnly: true, guardrailsOnly: false, help: false });
    expect(parseArgs(["--guardrails-only"])).toMatchObject({ sidecarOnly: false, guardrailsOnly: true, help: false });
    expect(parseArgs(["-h"])).toMatchObject({ help: true });
  });
});

describe("verify-m005-s02 scanner boundaries", () => {
  it("rejects cookie/path/package material from public evidence", () => {
    const context = createM005S02PublicScanContext({
      storeRoot: "/tmp/theprivator-m005-s02-store",
      selectedPaths: ["/tmp/theprivator-m005-s02-store/package.tpkg"],
      packageMemberNames: [MANIFEST_MEMBER, "payload/Default/Preferences"],
      cookieDomains: ["m005-s02-cookie.invalid"],
      cookieNames: ["m005_s02_session"],
      cookieValues: ["m005-s02-cookie-value-sentinel"],
      proxyCredentials: ["m005-s02-socks-password-sentinel"],
    });

    expect(findM005S02ForbiddenPublicMarker({ summary: "m005-s02-cookie-value-sentinel" }, context)).toMatchObject({ markerClass: "cookie_value" });
    expect(findM005S02ForbiddenPublicMarker({ summary: "payload/Default/Preferences" }, context)).toMatchObject({ markerClass: "package_member" });
    expect(() => assertM005S02PublicEvidenceRedacted({ selectedPath: "/tmp/theprivator-m005-s02-store/package.tpkg" }, context)).toThrow(VerifyFailure);
  });

  it("allows intended cookie material only inside the cookie payload member", () => {
    const context = createM005S02PackageScanContext({
      cookieDomains: ["m005-s02-cookie.invalid"],
      cookieNames: ["m005_s02_session"],
      cookieValues: ["m005-s02-cookie-value-sentinel"],
      proxyCredentials: ["m005-s02-socks-password-sentinel"],
    });

    expect(findM005S02ForbiddenPackageMarker({ cookies: [{ domain: "m005-s02-cookie.invalid", name: "m005_s02_session", value: "m005-s02-cookie-value-sentinel" }] }, context, COOKIE_MEMBER)).toBeNull();
    expect(findM005S02ForbiddenPackageMarker({ leak: "m005-s02-cookie-value-sentinel" }, context, MANIFEST_MEMBER)).toMatchObject({ markerClass: "cookie_value" });
    expect(findM005S02ForbiddenPackageMarker({ proxy: { password: "m005-s02-socks-password-sentinel" } }, context, COOKIE_MEMBER)).toMatchObject({ markerClass: "credential" });
    expect(findM005S02ForbiddenPackageMember("payload/Default/Network/Cookies", "", context)).toMatchObject({ markerClass: "raw_cookie_db" });
  });
});

describe("verify-m005-s02 manifest and summary contracts", () => {
  it("validates the safe manifest summary and rejects credentials", () => {
    expect(assertM005S02PackageManifestSummary(goodManifest(), { expectedProfileName: "M005 S02 Package Smoke" })).toMatchObject({ proxyCredentialStripped: true, cookieCount: 2, payloadFileCount: 1 });
    expect(() => assertM005S02PackageManifestSummary(goodManifest({ profile: { ...goodManifest().profile, proxy: { ...goodManifest().profile.proxy, credentials: { username: "u", password: "p" } } } }))).toThrow(VerifyFailure);
  });

  it("scans archive inspection without exposing member names publicly", () => {
    const inspection = { manifest: goodManifest(), members: [{ name: MANIFEST_MEMBER, text: JSON.stringify(goodManifest()) }, { name: COOKIE_MEMBER, text: JSON.stringify({ cookies: [{ value: "m005-s02-cookie-value-sentinel" }] }) }, { name: "payload/Default/Preferences", text: "safe payload" }] };
    const context = createM005S02PackageScanContext({ cookieValues: ["m005-s02-cookie-value-sentinel"] });
    expect(assertM005S02PackageContentClean(inspection, context)).toMatchObject({ status: "clean", scannedMembers: 3 });
  });

  it("builds a redacted final summary with cleanup status and stable counts", () => {
    const summary = buildM005S02FinalSummary({
      status: "pass",
      commands: { focusedVitest: "pass", frontendBuild: "pass", sidecarBuild: "pass", rustPackageCommandTests: "pass" },
      packageSmoke: { exported: true, imported: true, packageScanClean: true, cleanup: { status: "removed", retained: false }, counts: { cookieCount: 2, importedCookieCount: 2, payloadFileCount: 2, payloadByteCount: 42, warningCount: 3 } },
      checks: [{ name: "package.inspect-scan", status: "pass", durationMs: 3 }],
    });
    expect(summary.event).toBe(VERIFY_EVENT);
    expect(summary.package.cleanup).toEqual({ status: "removed", retained: false });
    expect(summary.package.counts.cookieCount).toBe(2);
    expect(findM005S02ForbiddenPublicMarker(summary)).toBeNull();
  });

  it("formats failing subprocess output without leaking secret tails", () => {
    const context = createM005S02PublicScanContext({
      storeRoot: "/tmp/theprivator-m005-s02-store",
      cookieValues: ["m005-s02-cookie-value-sentinel"],
      proxyCredentials: ["m005-s02-socks-password-sentinel"],
    });
    const failure = formatM005S02CommandFailure("npm run verify:m005:s02", {
      status: 1,
      signal: null,
      stdout: "m005-s02-cookie-value-sentinel /tmp/theprivator-m005-s02-store",
      stderr: "Traceback --remote-debugging-port=9222 m005-s02-socks-password-sentinel",
      error: null,
    }, context);
    const encoded = JSON.stringify(failure);
    expect(encoded).not.toContain("m005-s02-cookie-value-sentinel");
    expect(encoded).not.toContain("m005-s02-socks-password-sentinel");
    expect(encoded).not.toContain("/tmp/theprivator-m005-s02-store");
    expect(findM005S02ForbiddenPublicMarker(failure, context)).toBeNull();
  });
});

describe("verify-m005-s02 guardrails", () => {
  it("accepts minimal dialog, fixed command, source, and README boundaries", () => {
    const root = seedCapabilityRoot();
    const lines = captureConsole();
    try {
      expect(assertM005S02CapabilityConfig({ rootDir: root })).toMatchObject({ filesystemAuthority: "absent", packageCommands: "registered" });
      expect(assertM005S02SourceGuardrails({ rootDir: root })).toMatchObject({ frontendFilesystemAuthority: "absent", clientUsesFixedCommands: true });
      expect(assertM005S02ReadmeDocs({ rootDir: root })).toMatchObject({ unsafePackageMatrix: "deferred-to-s03", packagedDialogProof: "deferred-to-s04" });
      const summary = runGuardrailsOnlyVerification({ rootDir: root });
      expect(summary.status).toBe("pass");
      expect(lines.map((line) => JSON.parse(line)).some((event) => event.phase === "docs.readme-proof-boundary")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on capability drift, ignored artifacts, and incomplete docs", () => {
    const root = seedCapabilityRoot({
      permissions: ["core:default", "dialog:allow-open", "dialog:allow-save", "fs:allow-read-text-file", { identifier: "shell:allow-spawn", allow: [{ name: "binaries/theprivator-sidecar", sidecar: true }] }],
      readme: "M005 S02 package verifier without downstream boundary notes.\n",
    });
    try {
      expect(() => assertM005S02CapabilityConfig({ rootDir: root })).toThrow(VerifyFailure);
      writeFileSync(join(root, "scripts", "verify-m005-s02.test.mjs"), "import '../." + "gsd/local-plan.md';\n", "utf8");
      expect(() => assertM005S02SourceGuardrails({ rootDir: root })).toThrow(VerifyFailure);
      writeFileSync(join(root, "scripts", "verify-m005-s02.test.mjs"), "import { describe } from 'vitest';\n", "utf8");
      expect(() => assertM005S02ReadmeDocs({ rootDir: root })).toThrow(VerifyFailure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
