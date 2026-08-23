import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyFailure } from "./verify-m004-s01.mjs";
import { COOKIE_MEMBER, MANIFEST_MEMBER, PACKAGE_FORMAT, assertM005S02PackageContentClean, assertM005S02PublicEvidenceRedacted, findM005S02ForbiddenPackageMarker, findM005S02ForbiddenPublicMarker } from "./verify-m005-s02.mjs";
import {
  S03_MARKERS,
  VERIFY_EVENT,
  assertM005S03ReadmeDocs,
  assertM005S03SourceGuardrails,
  assertUnsafeImportFailureTranscript,
  buildM005S03FinalSummary,
  collectM005S03MarkerClasses,
  createM005S03PackageScanContext,
  createM005S03PublicScanContext,
  formatM005S03CommandFailure,
  parseArgs,
} from "./verify-m005-s03.mjs";

let consoleSpy;

afterEach(() => {
  consoleSpy?.mockRestore();
  consoleSpy = undefined;
});

function mkdtempRoot(prefix) {
  return join(tmpdir(), `${prefix}${Math.random().toString(16).slice(2)}`);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seedS03Root({ packageScript = "node scripts/verify-m005-s03.mjs", readme } = {}) {
  const root = mkdtempRoot("theprivator-m005-s03-root-");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "theprivator", "tests"), { recursive: true });
  mkdirSync(join(root, "src", "sidecar"), { recursive: true });
  writeJson(join(root, "package.json"), { scripts: { "verify:m005:s03": packageScript } });
  writeFileSync(join(root, "README.md"), readme ?? "Use `npm run verify:m005:s03` for the M005 S03 source-level unsafe .tpkg rejection, rollback, cleanup, diagnostics detailRef, redaction, and package-content proof. The redaction scanner checks public verifier events, UI/client evidence, diagnostics, and final summaries; the package-content scanner separately checks accepted/exported archive contents while allowing portable cookie payload only in its dedicated cookie member. S04 owns packaged real-dialog native open/save dialog proof.\n", "utf8");
  for (const path of [
    "scripts/verify-m005-s03.mjs",
    "scripts/verify-m005-s03.test.mjs",
    "theprivator/tests/test_profile_package.py",
    "theprivator/tests/test_diagnostics.py",
    "src/sidecar/client.test.ts",
    "src/App.test.tsx",
  ]) {
    writeFileSync(join(root, path), `// tracked fixture for ${path}\n`, "utf8");
  }
  return root;
}

function goodManifest() {
  return {
    format: PACKAGE_FORMAT,
    version: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    profile: { name: "M005 S03", identity: { identityVersion: 2 }, proxy: { proxyVersion: 1, mode: "direct" }, proxySummary: { proxyVersion: 1, mode: "direct", credentialState: "none", summary: "Direct connection" } },
    cookies: { member: COOKIE_MEMBER, format: "theprivator.cookies", version: 1, byteCount: 64, sha256: "a".repeat(64), cookieCount: 1, skippedCount: 0 },
    payload: { prefix: "payload/", fileCount: 1, byteCount: 12, files: [{ path: "Default/Preferences", member: "payload/Default/Preferences", byteCount: 12, sha256: "b".repeat(64) }] },
    warnings: [],
  };
}

describe("verify-m005-s03 argument contract", () => {
  it("recognizes full, unsafe-smoke, guardrail, help, and unknown modes", () => {
    expect(parseArgs([])).toMatchObject({ unsafeSmokeOnly: false, guardrailsOnly: false, help: false, unknown: [] });
    expect(parseArgs(["--unsafe-smoke-only"])).toMatchObject({ unsafeSmokeOnly: true, guardrailsOnly: false, help: false, unknown: [] });
    expect(parseArgs(["--guardrails-only"])).toMatchObject({ unsafeSmokeOnly: false, guardrailsOnly: true, help: false, unknown: [] });
    expect(parseArgs(["-h"])).toMatchObject({ help: true, unknown: [] });
    expect(parseArgs(["--bogus"])).toMatchObject({ unknown: ["--bogus"] });
  });
});

describe("verify-m005-s03 scanner split", () => {
  it("rejects unsafe fixture material from public evidence", () => {
    const context = createM005S03PublicScanContext({ storeRoot: "/tmp/m005-s03-store", selectedPaths: ["/tmp/m005-s03-store/unsafe.tpkg"] });
    expect(findM005S02ForbiddenPublicMarker({ summary: S03_MARKERS.cookieValue }, context)).toMatchObject({ markerClass: "cookie_value" });
    expect(findM005S02ForbiddenPublicMarker({ selectedPath: "/tmp/m005-s03-store/unsafe.tpkg" }, context)).toMatchObject({ markerClass: "path" });
    expect(() => assertM005S02PublicEvidenceRedacted({ member: S03_MARKERS.rawDiagnosticsMember }, context)).toThrow(VerifyFailure);
  });

  it("allows cookie material only inside the cookie member while rejecting manifest and payload leaks", () => {
    const context = createM005S03PackageScanContext({});
    expect(findM005S02ForbiddenPackageMarker({ cookies: [{ domain: S03_MARKERS.cookieDomain, name: S03_MARKERS.cookieName, value: S03_MARKERS.cookieValue }] }, context, COOKIE_MEMBER)).toBeNull();
    expect(findM005S02ForbiddenPackageMarker({ leak: S03_MARKERS.cookieValue }, context, MANIFEST_MEMBER)).toMatchObject({ markerClass: "cookie_value" });
    expect(findM005S02ForbiddenPackageMarker({ proxy: { password: S03_MARKERS.proxyPassword } }, context, COOKIE_MEMBER)).toMatchObject({ markerClass: "credential" });
    expect(() => assertM005S02PackageContentClean({ manifest: goodManifest(), members: [{ name: MANIFEST_MEMBER, text: JSON.stringify(goodManifest()) }, { name: COOKIE_MEMBER, text: JSON.stringify({ cookies: [{ value: S03_MARKERS.cookieValue }] }) }, { name: "payload/Default/Preferences", text: "safe" }] }, context)).not.toThrow();
  });
});

describe("verify-m005-s03 summaries and failure formatting", () => {
  it("builds a redacted final summary with typed package safety booleans", () => {
    const summary = buildM005S03FinalSummary({
      status: "pass",
      commands: { pythonPackageDiagnostics: "pass", rustPackageCommandTests: "pass", focusedVitest: "pass", frontendBuild: "pass", sidecarBuild: "pass" },
      packageSafety: { unsafeImportFailures: 7, typedErrorCodes: ["PORTABILITY_PACKAGE_INVALID", "PORTABILITY_PACKAGE_TOO_LARGE", "PORTABILITY_PACKAGE_INVALID"], rollbackNoProfile: true, rollbackProvenByPythonTests: true, packageTempCleanup: true, diagnosticsDetailRefLookupRedacted: true, acceptedPackageContentClean: true, publicEvidenceRedacted: true, cleanup: { status: "removed", retained: false } },
      checks: [{ name: "unsafe.import.invalid_non_zip", status: "pass", durationMs: 3 }],
    });
    expect(summary.event).toBe(VERIFY_EVENT);
    expect(summary.packageSafety.typedErrorCodes).toEqual(["PORTABILITY_PACKAGE_INVALID", "PORTABILITY_PACKAGE_TOO_LARGE"]);
    expect(summary.packageSafety.cleanup).toEqual({ status: "removed", retained: false });
    expect(findM005S02ForbiddenPublicMarker(summary)).toBeNull();
  });

  it("formats subprocess failures with marker classes but without raw forbidden values", () => {
    const context = createM005S03PublicScanContext({ storeRoot: "/tmp/m005-s03-store" });
    const failure = formatM005S03CommandFailure("npm run verify:m005:s03", { status: 1, signal: null, stdout: `${S03_MARKERS.cookieValue} /tmp/m005-s03-store`, stderr: `${S03_MARKERS.proxyPassword} Traceback --remote-debugging-port=9222`, error: null }, context);
    const encoded = JSON.stringify(failure);
    expect(failure.markerClasses).toEqual(expect.arrayContaining(["app_root", "cookie_value", "credential", "debug_endpoint", "raw_diag"]));
    expect(encoded).not.toContain(S03_MARKERS.cookieValue);
    expect(encoded).not.toContain(S03_MARKERS.proxyPassword);
    expect(encoded).not.toContain("/tmp/m005-s03-store");
    expect(findM005S02ForbiddenPublicMarker(failure, context)).toBeNull();
  });

  it("reports unsafe import success as a phase failure without echoing package internals", () => {
    const context = createM005S03PublicScanContext({ selectedPaths: ["/tmp/private/unsafe.tpkg"] });
    const transcript = { response: { id: "unsafe", ok: true, result: { sourcePath: "/tmp/private/unsafe.tpkg", manifestJson: "raw" } }, diagnostic: { event: "sidecar.request", requestId: "unsafe", method: "portability.profile_package.import", status: "ok", durationMs: 1, errorCode: null, detailRef: null } };
    expect(() => assertUnsafeImportFailureTranscript(transcript, { id: "unsafe", expectedCode: "PORTABILITY_PACKAGE_INVALID", context })).toThrow(VerifyFailure);
  });

  it("classifies forbidden marker classes without needing literal marker output", () => {
    const context = createM005S03PublicScanContext({ storeRoot: "/tmp/m005-s03-store" });
    expect(collectM005S03MarkerClasses(`${S03_MARKERS.cookieValue} ${S03_MARKERS.proxyPassword} /tmp/m005-s03-store`, context)).toEqual(expect.arrayContaining(["app_root", "cookie_value", "credential"]));
  });
});

describe("verify-m005-s03 docs and source guardrails", () => {
  it("accepts README proof boundaries and tracked fixture-only source assumptions", () => {
    const root = seedS03Root();
    try {
      expect(assertM005S03SourceGuardrails({ rootDir: root })).toMatchObject({ ignoredArtifactImports: "absent", packageScript: "verify:m005:s03" });
      expect(assertM005S03ReadmeDocs({ rootDir: root })).toMatchObject({ sourceSafetyProof: "documented", packagedDialogProof: "deferred-to-s04" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when package script, README boundary, or ignored-artifact references drift", () => {
    const root = seedS03Root({ packageScript: "node scripts/other.mjs", readme: "M005 package proof without the S03 command.\n" });
    try {
      expect(() => assertM005S03SourceGuardrails({ rootDir: root })).toThrow(VerifyFailure);
      writeJson(join(root, "package.json"), { scripts: { "verify:m005:s03": "node scripts/verify-m005-s03.mjs" } });
      writeFileSync(join(root, "scripts", "verify-m005-s03.test.mjs"), "import '../." + "gsd/local-plan.md';\n", "utf8");
      expect(() => assertM005S03SourceGuardrails({ rootDir: root })).toThrow(VerifyFailure);
      writeFileSync(join(root, "scripts", "verify-m005-s03.test.mjs"), "import { describe } from 'vitest';\n", "utf8");
      expect(() => assertM005S03ReadmeDocs({ rootDir: root })).toThrow(VerifyFailure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
