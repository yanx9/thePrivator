import { describe, expect, it } from "vitest";
import {
  formatIdentitySummary,
  getSupportedIdentityModeOptions,
  seedInitialIdentityDraft,
} from "./identityControls";
import type { IdentitySurface, ProfileIdentity, ProfileRecord } from "./sidecar/types";

const maskingSurfaces: IdentitySurface[] = ["browser", "navigator", "screen", "locale", "webgl", "webrtc"];
const noiseSurfaces: IdentitySurface[] = ["canvas", "audio"];

function identity(overrides: Partial<ProfileIdentity> = {}): ProfileIdentity {
  return {
    identityVersion: 1,
    label: "Research laptop",
    presetId: "balanced-desktop",
    browser: { mode: "masked", userAgent: "Mozilla/5.0 Test" },
    navigator: {
      mode: "custom",
      platform: "Linux x86_64",
      hardwareConcurrency: 8,
      deviceMemory: 8,
      uaPlatform: "Linux",
      uaPlatformVersion: "6.8",
      uaArchitecture: "x86",
      uaMobile: false,
    },
    screen: {
      mode: "masked",
      width: 1920,
      height: 1080,
      viewportWidth: 1440,
      viewportHeight: 900,
      colorDepth: 24,
      pixelRatio: 1,
    },
    locale: {
      mode: "custom",
      locale: "en-US",
      languages: ["en-US", "en"],
      timezoneId: "UTC",
    },
    canvas: { mode: "noise", noiseSeed: 1234 },
    audio: { mode: "real" },
    webgl: { mode: "masked", vendor: "Intel Inc.", renderer: "Mesa Intel" },
    webrtc: { mode: "custom", policy: "block" },
    ...overrides,
  };
}

function profileRecord(savedIdentity = identity()): ProfileRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Research",
    createdAt: "2026-05-04T18:00:00.000Z",
    updatedAt: "2026-05-04T18:01:00.000Z",
    defaults: {
      browser: "chromium",
      startUrl: "about:blank",
      proxyMode: "direct",
      fingerprintMode: "disabled",
    },
    storage: {
      profileDir: "profile-store/profiles/11111111-1111-1111-1111-111111111111",
      userDataDir: "profile-store/profiles/11111111-1111-1111-1111-111111111111/user-data",
    },
    identity: savedIdentity,
  };
}

describe("identity control helpers", () => {
  it("exposes masking mode options for browser-like identity surfaces only", () => {
    for (const surface of maskingSurfaces) {
      expect(getSupportedIdentityModeOptions(surface).map((option) => option.value)).toEqual(["real", "masked", "custom"]);
    }
  });

  it("exposes noise mode options only for canvas and audio", () => {
    for (const surface of noiseSurfaces) {
      expect(getSupportedIdentityModeOptions(surface).map((option) => option.value)).toEqual(["real", "noise"]);
    }

    expect(getSupportedIdentityModeOptions("webgl").map((option) => option.value)).not.toContain("noise");
    expect(getSupportedIdentityModeOptions("browser").map((option) => option.value)).not.toContain("noise");
  });

  it("formats a compact saved-identity summary with label, preset, and surface modes", () => {
    const summary = formatIdentitySummary(identity());

    expect(summary).toContain("Research laptop");
    expect(summary).toContain("Preset balanced-desktop");
    expect(summary).toContain("Browser masked");
    expect(summary).toContain("Navigator custom");
    expect(summary).toContain("Canvas noise");
    expect(summary).toContain("WebRTC custom");
  });

  it("seeds an editable draft from the saved profile identity without sharing nested references", () => {
    const savedIdentity = identity();
    const draft = seedInitialIdentityDraft(profileRecord(savedIdentity));

    expect(draft).toEqual(savedIdentity);
    expect(draft).not.toBe(savedIdentity);
    expect(draft.navigator).not.toBe(savedIdentity.navigator);

    draft.label = "Draft rename";
    if (draft.navigator.mode !== "real" && savedIdentity.navigator.mode !== "real") {
      draft.navigator.platform = "Edited platform";
      expect(savedIdentity.navigator.platform).toBe("Linux x86_64");
    }
    expect(savedIdentity.label).toBe("Research laptop");
  });
});
