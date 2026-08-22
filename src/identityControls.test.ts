import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADVANCED_IDENTITY_LABEL,
  formatIdentityExpectedValueSummary,
  formatIdentitySummary,
  getIdentitySurfaceControls,
  getSupportedIdentityModeOptions,
  createIdentityDraftState,
  parseIdentityDraftState,
  seedInitialIdentityDraft,
  updateIdentityDraftField,
  updateIdentityDraftLabel,
  updateIdentityDraftSurfaceMode,
} from "./identityControls";
import type { IdentityDraftFieldValues, IdentityDraftState } from "./identityControls";
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
      fingerprintMode: "managed",
    },
    storage: {
      profileDir: "profile-store/profiles/11111111-1111-1111-1111-111111111111",
      userDataDir: "profile-store/profiles/11111111-1111-1111-1111-111111111111/user-data",
    },
    identity: savedIdentity,
    proxy: {
      proxyVersion: 1,
      mode: "direct",
      credentialState: "none",
      summary: "Direct connection",
    },
    organization: {
      folderId: null,
      tags: [],
      notes: "",
      favorite: false,
      color: null,
    },
    launch: {
      startupBehavior: "customUrls",
      startUrls: [],
      args: [],
    },
    lifecycle: {
      deletedAt: null,
      lastLaunchedAt: null,
      launchCount: 0,
    },
    sync: {
      revision: 1,
      updatedBy: "33333333-3333-3333-3333-333333333333",
      originDeviceId: "33333333-3333-3333-3333-333333333333",
      lastSyncedAt: null,
      lastSyncedRevision: null,
    },
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

  it("adds advanced field descriptors only for fields supported by the selected mode", () => {
    const controls = getIdentitySurfaceControls(identity());
    const browser = controls.find((control) => control.surface === "browser");
    const canvas = controls.find((control) => control.surface === "canvas");
    const audio = controls.find((control) => control.surface === "audio");

    expect(browser?.fields.map((field) => field.path)).toContain("browser.userAgent");
    expect(canvas?.fields.map((field) => field.path)).toEqual(["canvas.noiseSeed"]);
    expect(audio?.fields).toEqual([]);
  });

  it("clears preset identity and seeds a labeled custom override when an advanced mode changes", () => {
    const draft = updateIdentityDraftSurfaceMode(createIdentityDraftState(profileRecord(identity({ browser: { mode: "real" } }))), "browser", "custom");

    const parsed = parseIdentityDraftState(draft);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.identity.presetId).toBeNull();
      expect(parsed.identity.label).toBe(DEFAULT_ADVANCED_IDENTITY_LABEL);
      expect(parsed.identity.browser.mode).toBe("custom");
    }
  });

  it("preserves an intentionally edited label while clearing preset identity", () => {
    const profile = profileRecord(identity());
    let draft = updateIdentityDraftLabel({ identity: profile.identity, values: seedValues(profile.identity), errors: {}, labelEdited: false }, "Lab override");
    draft = updateIdentityDraftField(draft, "navigator.hardwareConcurrency", "12");

    const parsed = parseIdentityDraftState(draft);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.identity.label).toBe("Lab override");
      expect(parsed.identity.presetId).toBeNull();
      expect(parsed.identity.navigator.mode).toBe("custom");
      if (parsed.identity.navigator.mode !== "real") {
        expect(parsed.identity.navigator.hardwareConcurrency).toBe(12);
      }
    }
  });

  it("guards unsupported modes and malformed local fields before a sidecar payload is built", () => {
    const profile = profileRecord(identity({ webrtc: { mode: "real", policy: "real" } }));
    let draft: IdentityDraftState = { identity: profile.identity, values: seedValues(profile.identity), errors: {}, labelEdited: false };

    draft = updateIdentityDraftSurfaceMode(draft, "canvas", "custom");
    expect(draft.errors["canvas.mode"]).toMatch(/does not support custom mode/i);

    draft = updateIdentityDraftField(draft, "navigator.hardwareConcurrency", "9007199254740993");
    draft = updateIdentityDraftField(draft, "locale.languages", "en-US, , de-DE");
    draft = updateIdentityDraftField(draft, "webrtc.policy", "block");
    const parsed = parseIdentityDraftState(draft);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors["navigator.hardwareConcurrency"]).toMatch(/safe whole number/i);
      expect(parsed.errors["locale.languages"]).toMatch(/without blank entries/i);
      expect(parsed.errors["webrtc.policy"]).toMatch(/must be real when WebRTC mode is real/i);
    }
  });

  it("formats expected values for S05 verifier wording without leaking implementation paths", () => {
    const summary = formatIdentityExpectedValueSummary(identity());

    expect(summary).toContain("Browser: Masked UA Mozilla/5.0 Test");
    expect(summary).toContain("Navigator: Custom Linux x86_64, 8 cores, 8 GiB");
    expect(summary).toContain("Locale: Custom en-US, en-US/en, UTC");
    expect(summary).toContain("WebRTC: Custom WebRTC policy block");
  });
});

function seedValues(savedIdentity: ProfileIdentity): IdentityDraftFieldValues {
  return {
    label: savedIdentity.label,
    "browser.userAgent": savedIdentity.browser.mode === "real" ? "Mozilla/5.0 Test" : savedIdentity.browser.userAgent,
    "browser.clientHints.platform": "",
    "browser.clientHints.platformVersion": "",
    "browser.clientHints.architecture": "",
    "browser.clientHints.bitness": "",
    "browser.clientHints.model": "",
    "browser.clientHints.mobile": "false",
    "navigator.platform": savedIdentity.navigator.mode === "real" ? "Linux x86_64" : savedIdentity.navigator.platform,
    "navigator.hardwareConcurrency": savedIdentity.navigator.mode === "real" ? "8" : String(savedIdentity.navigator.hardwareConcurrency),
    "navigator.deviceMemory": savedIdentity.navigator.mode === "real" ? "8" : String(savedIdentity.navigator.deviceMemory),
    "navigator.uaPlatform": savedIdentity.navigator.mode === "real" ? "Linux" : savedIdentity.navigator.uaPlatform,
    "navigator.uaPlatformVersion": savedIdentity.navigator.mode === "real" ? "" : savedIdentity.navigator.uaPlatformVersion,
    "navigator.uaArchitecture": savedIdentity.navigator.mode === "real" ? "x86" : savedIdentity.navigator.uaArchitecture,
    "navigator.uaMobile": savedIdentity.navigator.mode === "real" ? "false" : String(savedIdentity.navigator.uaMobile),
    "screen.width": savedIdentity.screen.mode === "real" ? "1920" : String(savedIdentity.screen.width),
    "screen.height": savedIdentity.screen.mode === "real" ? "1080" : String(savedIdentity.screen.height),
    "screen.viewportWidth": savedIdentity.screen.mode === "real" ? "1440" : String(savedIdentity.screen.viewportWidth),
    "screen.viewportHeight": savedIdentity.screen.mode === "real" ? "900" : String(savedIdentity.screen.viewportHeight),
    "screen.colorDepth": savedIdentity.screen.mode === "real" ? "24" : String(savedIdentity.screen.colorDepth),
    "screen.pixelRatio": savedIdentity.screen.mode === "real" ? "1" : String(savedIdentity.screen.pixelRatio),
    "locale.locale": savedIdentity.locale.mode === "real" ? "en-US" : savedIdentity.locale.locale,
    "locale.languages": savedIdentity.locale.mode === "real" ? "en-US, en" : savedIdentity.locale.languages.join(", "),
    "locale.timezoneId": savedIdentity.locale.mode === "real" ? "UTC" : savedIdentity.locale.timezoneId,
    "canvas.noiseSeed": savedIdentity.canvas.mode === "real" ? "1001" : String(savedIdentity.canvas.noiseSeed),
    "audio.noiseSeed": savedIdentity.audio.mode === "real" ? "2001" : String(savedIdentity.audio.noiseSeed),
    "webgl.vendor": savedIdentity.webgl.mode === "real" ? "Intel Inc." : savedIdentity.webgl.vendor,
    "webgl.renderer": savedIdentity.webgl.mode === "real" ? "Mesa Intel" : savedIdentity.webgl.renderer,
    "webgl.noiseSeed": savedIdentity.webgl.mode === "real" || savedIdentity.webgl.noiseSeed === undefined ? "" : String(savedIdentity.webgl.noiseSeed),
    "webrtc.policy": String(savedIdentity.webrtc.policy),
  };
}
