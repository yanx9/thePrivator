import { describe, expect, it } from "vitest";
import { buildIdentityAuditGuidance } from "./identityAuditGuidance";
import type { IdentityAuditPage } from "./identityAuditGuidance";
import type { ProfileIdentity } from "./sidecar/types";

const allSurfacePage: IdentityAuditPage = {
  id: "pixelscan-fingerprint-check",
  label: "Pixelscan Fingerprint Check",
  category: "consistency",
  url: "https://pixelscan.net/fingerprint-check",
  surfaces: ["browser", "clientHints", "navigator", "screen", "locale", "canvas", "webgl", "audio", "webrtc"],
  comparisonNote: "Treat flags and scores as advisory consistency hints; compare contradictions instead of treating one result as authoritative.",
  requiresUserAction: false,
};

function identity(overrides: Partial<ProfileIdentity> = {}): ProfileIdentity {
  return {
    identityVersion: 1,
    label: "Research laptop",
    presetId: "ubuntu-linux-chrome-120",
    browser: {
      mode: "masked",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36",
      clientHints: {
        platform: "Linux",
        platformVersion: "",
        architecture: "x86",
        bitness: "64",
        model: "",
        mobile: false,
      },
    },
    navigator: {
      mode: "masked",
      platform: "Linux x86_64",
      hardwareConcurrency: 8,
      deviceMemory: 8,
      uaPlatform: "Linux",
      uaPlatformVersion: "",
      uaArchitecture: "x86",
      uaMobile: false,
    },
    screen: {
      mode: "masked",
      width: 1920,
      height: 1080,
      viewportWidth: 1920,
      viewportHeight: 1032,
      colorDepth: 24,
      pixelRatio: 1,
    },
    locale: {
      mode: "masked",
      locale: "en-US",
      languages: ["en-US", "en"],
      timezoneId: "America/New_York",
    },
    canvas: { mode: "noise", noiseSeed: 120030 },
    audio: { mode: "noise", noiseSeed: 120031 },
    webgl: {
      mode: "masked",
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
      noiseSeed: 120032,
    },
    webrtc: { mode: "masked", policy: "disableNonProxiedUdp" },
    ...overrides,
  };
}

function guidanceText(page: IdentityAuditPage = allSurfacePage, savedIdentity: ProfileIdentity = identity()): string {
  return JSON.stringify(buildIdentityAuditGuidance(savedIdentity, page));
}

describe("identity audit guidance", () => {
  it("maps configured identity surfaces into expected rows for a public checker page", () => {
    const guidance = buildIdentityAuditGuidance(identity(), allSurfacePage);

    expect(guidance.pageId).toBe("pixelscan-fingerprint-check");
    expect(guidance.expectedRows.map((row) => row.surface)).toEqual([
      "browser",
      "clientHints",
      "navigator",
      "screen",
      "locale",
      "canvas",
      "webgl",
      "audio",
      "webrtc",
    ]);
    expect(guidance.expectedRows.find((row) => row.surface === "browser")?.expected).toContain("Mozilla/5.0");
    expect(guidance.expectedRows.find((row) => row.surface === "clientHints")?.expected).toContain("platform Linux");
    expect(guidance.expectedRows.find((row) => row.surface === "navigator")?.expected).toContain("8 cores");
    expect(guidance.expectedRows.find((row) => row.surface === "screen")?.expected).toContain("1920×1080");
    expect(guidance.expectedRows.find((row) => row.surface === "locale")?.expected).toContain("America/New_York");
    expect(guidance.expectedRows.find((row) => row.surface === "webgl")?.expected).toContain("Google Inc. (Intel)");
    expect(guidance.expectedRows.find((row) => row.surface === "webrtc")?.expected).toContain("No non-proxied UDP");
    expect(guidance.expectedRows.find((row) => row.surface === "canvas")?.expected).toBe("Stable per-profile altered signature from configured noise.");
    expect(guidance.expectedRows.find((row) => row.surface === "audio")?.expected).toBe("Stable per-profile altered signature from configured noise.");
  });

  it("keeps public-checker copy advisory without path, debug, or guarantee language", () => {
    const combined = guidanceText();

    expect(combined).toContain("manual comparison aids");
    expect(combined).toContain("Public checker pages can change");
    expect(combined.toLowerCase()).not.toContain("pass/fail");
    for (const marker of [
      "/tmp/secret-store",
      "DevToolsActivePort",
      "remote-debugging-port",
      "ws://",
      "targetId",
      "--user-data-dir",
      "Traceback",
      "guaranteed undetectability",
      "universal green",
      "universal pass",
      "undetectable",
    ]) {
      expect(combined).not.toContain(marker);
    }
  });

  it("rejects malformed page shapes before returning partial guidance", () => {
    const malformedPages: unknown[] = [
      { ...allSurfacePage, id: "Bad Id" },
      { ...allSurfacePage, url: "http://pixelscan.net/fingerprint-check" },
      { ...allSurfacePage, url: "file:///tmp/checker.html" },
      { ...allSurfacePage, url: "https://127.0.0.1/checker" },
      { ...allSurfacePage, surfaces: [] },
      { ...allSurfacePage, surfaces: ["browser", "unknown"] },
      { ...allSurfacePage, surfaces: ["browser", "browser"] },
      { ...allSurfacePage, label: "Debug DevToolsActivePort" },
      { ...allSurfacePage, comparisonNote: "guaranteed undetectability" },
    ];

    for (const page of malformedPages) {
      expect(() => buildIdentityAuditGuidance(identity(), page as IdentityAuditPage)).toThrow(/Audit/);
    }
  });

  it("redacts unsafe configured identity text from generated rows", () => {
    const unsafeIdentity = identity({
      browser: {
        mode: "custom",
        userAgent: "Mozilla ws://127.0.0.1:9222 DevToolsActivePort --user-data-dir=/tmp/secret-store",
      },
      webgl: {
        mode: "custom",
        vendor: "targetId vendor",
        renderer: "Traceback renderer",
      },
    });

    const combined = guidanceText(allSurfacePage, unsafeIdentity);

    for (const marker of ["ws://", "127.0.0.1", "9222", "DevToolsActivePort", "--user-data-dir", "/tmp/secret-store", "targetId", "Traceback"]) {
      expect(combined).not.toContain(marker);
    }
    expect(combined).toContain("[redacted]");
  });
});
