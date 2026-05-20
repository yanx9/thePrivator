import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyFailure } from "./verify-m004-s01.mjs";
import {
  FORMAT_NETSCAPE,
  FORMAT_THEPRIVATOR_JSON,
  VERIFY_EVENT,
  assertM005PublicEvidenceRedacted,
  buildM005FinalSummary,
  createM005RedactionContext,
  findM005ForbiddenPublicMarker,
  parseArgs,
  redactM005,
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

describe("verify-m005-s01 argument contract", () => {
  it("recognizes sidecar-only and help flags without enabling future modes", () => {
    expect(parseArgs(["--sidecar-only"])).toMatchObject({ sidecarOnly: true, capabilityOnly: false, help: false });
    expect(parseArgs(["--capability-only"])).toMatchObject({ sidecarOnly: false, capabilityOnly: true, help: false });
    expect(parseArgs(["--help"])).toMatchObject({ help: true });
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
        exportedJson: true,
        exportedNetscape: true,
        replaced: true,
        invalidImportPreservedRows: true,
        oversizedImportPreservedRows: true,
        unsupportedFormatRejected: true,
        busyRejected: true,
        diagnosticsRedacted: true,
        counts: { jsonExported: 2, netscapeExported: 2, imported: 2, replaced: 1, skipped: 1 },
      },
    });

    expect(summary.event).toBe(VERIFY_EVENT);
    expect(summary.mode).toBe("sidecar-only");
    expect(summary.sidecar.counts).toEqual({ jsonExported: 2, netscapeExported: 2, imported: 2, replaced: 1, skipped: 1 });
    expect(findM005ForbiddenPublicMarker(summary)).toBeNull();
  });
});

describe("verify-m005-s01 source sidecar smoke", () => {
  it("proves JSON/Netscape export, replace semantics, validation-before-clear, busy rejection, and redacted diagnostics", () => {
    const lines = captureConsole();
    const summary = runSidecarOnlySmoke();

    expect(summary.status).toBe("pass");
    expect(summary.sidecar.exportedJson).toBe(true);
    expect(summary.sidecar.exportedNetscape).toBe(true);
    expect(summary.sidecar.replaced).toBe(true);
    expect(summary.sidecar.invalidImportPreservedRows).toBe(true);
    expect(summary.sidecar.oversizedImportPreservedRows).toBe(true);
    expect(summary.sidecar.unsupportedFormatRejected).toBe(true);
    expect(summary.sidecar.busyRejected).toBe(true);
    expect(summary.sidecar.diagnosticsRedacted).toBe(true);
    expect(summary.sidecar.counts).toMatchObject({ jsonExported: 2, netscapeExported: 2, imported: 2, replaced: 1, skipped: 1 });

    const parsedEvents = lines.map((line) => JSON.parse(line));
    expect(parsedEvents.some((event) => event.phase === "sidecar.export-json" && event.exportedCount === 2)).toBe(true);
    expect(parsedEvents.some((event) => event.phase === "sidecar.export-netscape" && event.warningCount === 1)).toBe(true);
    expect(parsedEvents.some((event) => event.phase === "sidecar.replace-json" && event.importedCount === 2)).toBe(true);
    expect(parsedEvents.some((event) => event.phase === "sidecar.unsupported-format-rejected" && event.errorCode === "PORTABILITY_UNSUPPORTED_FORMAT")).toBe(true);
    expect(parsedEvents.some((event) => event.phase === "sidecar.busy-profile-rejected" && event.errorCode === "PORTABILITY_PROFILE_BUSY")).toBe(true);
    expect(findM005ForbiddenPublicMarker(parsedEvents)).toBeNull();
  });

  it("exports canonical format constants consumed by downstream verifier phases", () => {
    expect(FORMAT_THEPRIVATOR_JSON).toBe("theprivator-json");
    expect(FORMAT_NETSCAPE).toBe("netscape");
  });
});
