import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyFailure } from "./verify-m004-s01.mjs";
import {
  FORMAT_NETSCAPE,
  FORMAT_THEPRIVATOR_JSON,
  VERIFY_EVENT,
  assertM005CapabilityConfig,
  assertM005PublicEvidenceRedacted,
  assertM005ReadmeDocs,
  assertM005SourceGuardrails,
  buildM005FinalSummary,
  buildM005FullSummary,
  createM005RedactionContext,
  findM005ForbiddenPublicMarker,
  formatM005CommandFailure,
  parseArgs,
  redactM005,
  runCapabilityOnlyVerification,
  runSidecarOnlySmoke,
} from "./verify-m005-s01.mjs";

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

function seedCapabilityRoot({ permissions } = {}) {
  const root = mkdtempSync(join(tmpdir(), "theprivator-m005-capability-"));
  mkdirSync(join(root, "src-tauri", "capabilities"), { recursive: true });
  mkdirSync(join(root, "src-tauri", "src"), { recursive: true });

  const defaultPermissions = [
    "core:default",
    "dialog:allow-open",
    "dialog:allow-save",
    {
      identifier: "shell:allow-spawn",
      allow: [{ name: "binaries/theprivator-sidecar", sidecar: true }],
    },
  ];

  writeJson(join(root, "src-tauri", "capabilities", "default.json"), {
    identifier: "default",
    windows: ["main"],
    permissions: permissions ?? defaultPermissions,
  });
  writeJson(join(root, "package.json"), {
    dependencies: {
      "@tauri-apps/api": "^2.0.0",
      "@tauri-apps/plugin-dialog": "^2.0.0",
    },
  });
  writeJson(join(root, "package-lock.json"), {
    packages: {
      "": {
        dependencies: {
          "@tauri-apps/api": "^2.0.0",
          "@tauri-apps/plugin-dialog": "^2.0.0",
        },
      },
      "node_modules/@tauri-apps/plugin-dialog": { version: "2.4.0" },
    },
  });
  writeFileSync(join(root, "src-tauri", "Cargo.toml"), '[dependencies]\ntauri = "2"\ntauri-plugin-dialog = "2"\ntauri-plugin-shell = "2"\n', "utf8");
  writeFileSync(join(root, "src-tauri", "Cargo.lock"), '[[package]]\nname = "tauri-plugin-dialog"\nversion = "2.4.0"\n', "utf8");
  writeFileSync(join(root, "src-tauri", "src", "lib.rs"), '.plugin(tauri_plugin_dialog::init())\nsidecar::profile_cookies_export\nsidecar::profile_cookies_replace\n', "utf8");
  writeFileSync(join(root, "src-tauri", "src", "sidecar.rs"), '"portability.cookies.export"\n"portability.cookies.replace"\n', "utf8");
  return root;
}

function seedSourceGuardRoot({ appSource, clientSource, readme } = {}) {
  const root = seedCapabilityRoot();
  mkdirSync(join(root, "src", "sidecar"), { recursive: true });
  writeFileSync(join(root, "scripts-placeholder"), "", "utf8");
  writeFileSync(join(root, "src", "App.tsx"), appSource ?? "import { exportProfileCookies, replaceProfileCookies } from './sidecar/client';\n", "utf8");
  writeFileSync(
    join(root, "src", "App.test.tsx"),
    "import { describe, it } from 'vitest';\ndescribe('app', () => { it('uses inline fixtures', () => {}); });\n",
    "utf8",
  );
  writeFileSync(
    join(root, "src", "sidecar", "client.ts"),
    clientSource ?? 'invoke<unknown>("profile_cookies_export", {});\ninvoke<unknown>("profile_cookies_replace", {});\n',
    "utf8",
  );
  writeFileSync(join(root, "src", "sidecar", "client.test.ts"), "import { describe } from 'vitest';\n", "utf8");
  writeFileSync(join(root, "src", "sidecar", "types.ts"), "export type CookieExportFormat = 'netscape' | 'theprivator-json';\n", "utf8");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "verify-m005-s01.mjs"), "export const verifier = true;\n", "utf8");
  writeFileSync(join(root, "scripts", "verify-m005-s01.test.mjs"), "import { describe } from 'vitest';\n", "utf8");
  writeFileSync(
    join(root, "README.md"),
    readme ?? "Use `npm run verify:m005:s01` for the M005 S01 cookie portability proof. It documents no-frontend-filesystem and no-path-leak boundaries while deferring packaged real-dialog proof to S04.\n",
    "utf8",
  );
  return root;
}

describe("verify-m005-s01 argument contract", () => {
  it("recognizes sidecar-only and help flags without enabling future modes", () => {
    expect(parseArgs(["--sidecar-only"])).toMatchObject({ sidecarOnly: true, capabilityOnly: false, help: false });
    expect(parseArgs(["--capability-only"])).toMatchObject({ sidecarOnly: false, capabilityOnly: true, help: false });
    expect(parseArgs(["--help"])).toMatchObject({ help: true });
  });
});

describe("verify-m005-s01 capability boundary", () => {
  it("accepts only dialog open/save plus fixed sidecar spawn permissions", () => {
    const root = seedCapabilityRoot();
    try {
      expect(assertM005CapabilityConfig({ rootDir: root })).toMatchObject({
        dialogPlugin: "registered",
        filesystemAuthority: "absent",
        shellOpenAuthority: "absent",
        permissions: ["core:default", "dialog:allow-open", "dialog:allow-save", "shell:allow-spawn"].sort(),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects filesystem and shell-open capability drift", () => {
    const root = seedCapabilityRoot({
      permissions: [
        "core:default",
        "dialog:allow-open",
        "dialog:allow-save",
        "fs:allow-read-text-file",
        "shell:allow-open",
        {
          identifier: "shell:allow-spawn",
          allow: [{ name: "binaries/theprivator-sidecar", sidecar: true }],
        },
      ],
    });
    try {
      expect(() => assertM005CapabilityConfig({ rootDir: root })).toThrow(VerifyFailure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed capability JSON fixtures", () => {
    const root = seedCapabilityRoot();
    try {
      writeFileSync(join(root, "src-tauri", "capabilities", "default.json"), "{ not-json", "utf8");
      expect(() => assertM005CapabilityConfig({ rootDir: root })).toThrow(VerifyFailure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits redacted capability-only verifier events", () => {
    const root = seedCapabilityRoot();
    const lines = captureConsole();
    try {
      const summary = runCapabilityOnlyVerification({ rootDir: root });
      expect(summary.status).toBe("pass");
      expect(summary.mode).toBe("capability-only");
      expect(summary.capability.filesystemAuthority).toBe("absent");
      const parsedEvents = lines.map((line) => JSON.parse(line));
      expect(parsedEvents.some((event) => event.phase === "capability.dialog-boundary" && event.status === "pass")).toBe(true);
      expect(findM005ForbiddenPublicMarker(parsedEvents)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verify-m005-s01 source and docs guardrails", () => {
  it("accepts inline source fixtures that keep cookie portability behind dialog and fixed wrappers", () => {
    const root = seedSourceGuardRoot();
    try {
      expect(assertM005SourceGuardrails({ rootDir: root })).toMatchObject({
        frontendFilesystemAuthority: "absent",
        ignoredArtifactImports: "absent",
        uiUsesTypedWrappers: true,
        clientUsesFixedCommands: true,
      });
      expect(assertM005ReadmeDocs({ rootDir: root })).toMatchObject({
        command: "documented",
        packagedDialogProof: "deferred-to-s04",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects frontend filesystem authority, ignored artifact references, and missing README boundaries", () => {
    const root = seedSourceGuardRoot({
      appSource: "import { readTextFile } from '@tauri-apps/plugin-fs';\n",
      readme: "Cookie verifier notes without the canonical command.\n",
    });
    try {
      writeFileSync(join(root, "scripts", "verify-m005-s01.test.mjs"), "import '../." + "gsd/local-only-plan.md';\n", "utf8");
      expect(() => assertM005SourceGuardrails({ rootDir: root })).toThrow(VerifyFailure);
      writeFileSync(join(root, "scripts", "verify-m005-s01.test.mjs"), "import { describe } from 'vitest';\n", "utf8");
      expect(() => assertM005SourceGuardrails({ rootDir: root })).toThrow(VerifyFailure);
      expect(() => assertM005ReadmeDocs({ rootDir: root })).toThrow(VerifyFailure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verify-m005-s01 redaction helpers", () => {
  it("detects cookie values, cookie domains, selected paths, roots, raw diagnostics, credentials, and debug markers", () => {
    const context = createM005RedactionContext({
      storeRoot: "/private/app-data-root-should-not-leak",
      userDataRoot: "/private/app-data-root-should-not-leak/profile-store/profiles/profile-a/user-data",
      selectedPaths: ["/private/selected-cookies.json"],
      cookieDomains: ["m005-cookie-domain.invalid"],
      cookieValues: ["m005-secret-cookie-value"],
      extraSensitiveValues: ["tpapi-token-should-not-leak"],
    });

    const unsafe = {
      summary: "m005-cookie-domain.invalid m005-secret-cookie-value /private/selected-cookies.json",
      detail: "Traceback with --remote-debugging-port=9222 and Authorization Bearer tpapi-token-should-not-leak",
    };

    expect(findM005ForbiddenPublicMarker("m005-cookie-domain.invalid", context)).toMatchObject({ markerClass: "cookie_domain" });
    expect(findM005ForbiddenPublicMarker("m005-secret-cookie-value", context)).toMatchObject({ markerClass: "cookie_value" });
    expect(findM005ForbiddenPublicMarker(unsafe, context)).toBeTruthy();
    expect(() => assertM005PublicEvidenceRedacted(unsafe, context)).toThrow(VerifyFailure);

    const redacted = redactM005({ cookieValue: "m005-secret-cookie-value", outputTail: "Traceback" }, context);
    const encoded = JSON.stringify(redacted);
    expect(encoded).not.toContain("m005-secret-cookie-value");
    expect(encoded).not.toContain("Traceback");
    expect(encoded).toContain("<redacted-key:cookie_value>");
  });

  it("formats failing subprocess tails without leaking paths, cookie material, credentials, debug markers, raw diagnostics, or stack traces", () => {
    const context = createM005RedactionContext({
      storeRoot: "/private/app-data-root-should-not-leak",
      selectedPaths: ["/private/selected-cookies.json"],
      cookieDomains: ["m005-cookie-domain.invalid"],
      cookieValues: ["m005-secret-cookie-value"],
      extraSensitiveValues: ["tpapi-token-should-not-leak"],
    });
    const failure = formatM005CommandFailure("npm test -- --run focused", {
      status: 1,
      signal: null,
      stdout: "exported m005-cookie-domain.invalid from /private/selected-cookies.json",
      stderr: "Traceback with Authorization Bearer tpapi-token-should-not-leak and --remote-debugging-port=9222 plus m005-secret-cookie-value",
      error: null,
    }, context);
    const encoded = JSON.stringify(failure);

    expect(encoded).not.toContain("/private/selected-cookies.json");
    expect(encoded).not.toContain("m005-cookie-domain.invalid");
    expect(encoded).not.toContain("m005-secret-cookie-value");
    expect(encoded).not.toContain("tpapi-token-should-not-leak");
    expect(encoded).not.toContain("Traceback");
    expect(encoded).not.toContain("Authorization");
    expect(encoded).not.toContain("--remote-debugging-port");
    expect(findM005ForbiddenPublicMarker(failure, context)).toBeNull();
  });

  it("allows the existing persisted diagnostic lookup logPath but rejects unsafe path keys", () => {
    const safe = {
      schemaVersion: 1,
      event: "sidecar.request",
      source: "python-sidecar",
      status: "ok",
      logPath: "profile-store/diagnostics/events.jsonl",
      method: "portability.cookies.export",
      durationMs: 1,
      errorCode: null,
      detailRef: null,
    };
    expect(findM005ForbiddenPublicMarker(safe)).toBeNull();
    expect(findM005ForbiddenPublicMarker({ destinationPath: "redacted" })).toMatchObject({ markerClass: "path" });
  });
});

describe("verify-m005-s01 final summary", () => {
  it("summarizes only safe booleans and counts for sidecar proof", () => {
    const summary = buildM005FinalSummary({
      status: "pass",
      checks: [{ name: "sidecar.export-json", status: "pass", durationMs: 5 }],
      sidecar: {
        emptyExported: true,
        exportedJson: true,
        exportedNetscape: true,
        replaced: true,
        invalidImportPreservedRows: true,
        oversizedImportPreservedRows: true,
        unsupportedFormatRejected: true,
        busyRejected: true,
        diagnosticsRedacted: true,
        cleanup: { status: "removed", retained: false },
        counts: { zeroJsonExported: 0, jsonExported: 2, netscapeExported: 2, imported: 2, replaced: 1, skipped: 1 },
      },
    });

    expect(summary.event).toBe(VERIFY_EVENT);
    expect(summary.mode).toBe("sidecar-only");
    expect(summary.sidecar.emptyExported).toBe(true);
    expect(summary.sidecar.cleanup).toEqual({ status: "removed", retained: false });
    expect(summary.sidecar.counts).toEqual({ zeroJsonExported: 0, jsonExported: 2, netscapeExported: 2, imported: 2, replaced: 1, skipped: 1 });
    expect(findM005ForbiddenPublicMarker(summary)).toBeNull();
  });

  it("builds a full summary shape for downstream source-proof consumers without leaking forbidden markers", () => {
    const summary = buildM005FullSummary({
      status: "pass",
      checks: [
        { name: "node.focused-vitest", status: "pass", durationMs: 1 },
        { name: "cleanup.temp-fixtures", status: "pass", durationMs: 1 },
      ],
      commands: { focusedVitest: "pass", typescriptBuild: "pass", sidecarBuild: "pass", rustCommandTests: "pass" },
      capability: { filesystemAuthority: "absent", shellOpenAuthority: "absent", dialogPlugin: "registered" },
      sourceGuardrails: { scannedFiles: 9, frontendFilesystemAuthority: "absent", ignoredArtifactImports: "absent" },
      docs: { command: "documented", packagedDialogProof: "deferred-to-s04", authorityBoundary: "documented" },
      sidecar: {
        emptyExported: true,
        exportedJson: true,
        exportedNetscape: true,
        replaced: true,
        invalidImportPreservedRows: true,
        oversizedImportPreservedRows: true,
        unsupportedFormatRejected: true,
        busyRejected: true,
        diagnosticsRedacted: true,
        cleanup: { status: "removed", retained: false },
        counts: { zeroJsonExported: 0, jsonExported: 2, netscapeExported: 2, imported: 2, replaced: 1, skipped: 1 },
      },
    });

    expect(summary.mode).toBe("full");
    expect(summary.commands).toMatchObject({ focusedVitest: "pass", rustCommandTests: "pass" });
    expect(summary.docs.packagedDialogProof).toBe("deferred-to-s04");
    expect(findM005ForbiddenPublicMarker(summary)).toBeNull();
  });
});

describe("verify-m005-s01 source sidecar smoke", () => {
  it("proves JSON-only export, replace semantics, validation-before-clear, busy rejection, and redacted diagnostics", () => {
    const lines = captureConsole();
    const summary = runSidecarOnlySmoke();

    expect(summary.status).toBe("pass");
    expect(summary.sidecar.emptyExported).toBe(true);
    expect(summary.sidecar.exportedJson).toBe(true);
    expect(summary.sidecar.exportedNetscape).toBe(false);
    expect(summary.sidecar.legacyExportRejected).toBe(true);
    expect(summary.sidecar.replaced).toBe(true);
    expect(summary.sidecar.invalidImportPreservedRows).toBe(true);
    expect(summary.sidecar.oversizedImportPreservedRows).toBe(true);
    expect(summary.sidecar.unsupportedFormatRejected).toBe(true);
    expect(summary.sidecar.busyRejected).toBe(true);
    expect(summary.sidecar.diagnosticsRedacted).toBe(true);
    expect(summary.sidecar.cleanup).toEqual({ status: "removed", retained: false });
    expect(summary.sidecar.counts).toMatchObject({ zeroJsonExported: 0, jsonExported: 2, netscapeExported: 0, imported: 2, replaced: 1, skipped: 1 });

    const parsedEvents = lines.map((line) => JSON.parse(line));
    expect(parsedEvents.some((event) => event.phase === "sidecar.zero-cookie-export" && event.exportedCount === 0 && event.warningCount === 0)).toBe(true);
    expect(parsedEvents.some((event) => event.phase === "sidecar.export-json" && event.exportedCount === 2)).toBe(true);
    expect(parsedEvents.some((event) => event.phase === "sidecar.legacy-export-rejected" && event.errorCode === "PORTABILITY_UNSUPPORTED_FORMAT")).toBe(true);
    expect(parsedEvents.some((event) => event.phase === "sidecar.replace-json" && event.importedCount === 2)).toBe(true);
    expect(parsedEvents.some((event) => event.phase === "sidecar.unsupported-format-rejected" && event.errorCode === "PORTABILITY_UNSUPPORTED_FORMAT")).toBe(true);
    expect(parsedEvents.some((event) => event.phase === "sidecar.busy-profile-rejected" && event.errorCode === "PORTABILITY_PROFILE_BUSY")).toBe(true);
    expect(parsedEvents.some((event) => event.phase === "cleanup.temp-fixtures" && event.cleanupStatus === "removed")).toBe(true);
    expect(findM005ForbiddenPublicMarker(parsedEvents)).toBeNull();
  });

  it("exports canonical format constants consumed by downstream verifier phases", () => {
    expect(FORMAT_THEPRIVATOR_JSON).toBe("theprivator-json");
    expect(FORMAT_NETSCAPE).toBe("netscape");
  });
});
