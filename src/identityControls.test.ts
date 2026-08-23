// Vite's eager raw glob reads the sidecar contract without Node fs types, the
// same way the UI source guard in App.test.tsx reads the UI.
const sidecarIdentitySources: Record<string, string> = import.meta.glob("../theprivator_sidecar/identity.py", {
  query: "?raw",
  import: "default",
  eager: true,
});
import { describe, expect, it } from "vitest";
import {
  IDENTITY_DRAFT_FIELD_DESCRIPTORS,
  DEFAULT_ADVANCED_IDENTITY_LABEL,
  IDENTITY_SURFACE_ORDER,
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

const maskingSurfaces: IdentitySurface[] = ["browser", "navigator", "screen", "locale", "webgl", "webrtc", "mediaDevices", "ports"];
const noiseSurfaces: IdentitySurface[] = ["canvas", "audio"];

// identity.surfaces.describe reports exactly this table: its surface ids are the
// keys and its mode lists are the values, both taken straight from the sidecar.
function readSidecarSurfaceContract(): { identityVersion: number; modesBySurface: Map<string, string[]> } {
  const source = Object.values(sidecarIdentitySources)[0];
  if (!source) {
    throw new Error("The sidecar identity module could not be read.");
  }

  const table = /\nSUPPORTED_MODES_BY_SURFACE[^=]*= \{\n([\s\S]*?)\n\}\n/.exec(source)?.[1];
  const version = /\nIDENTITY_VERSION = (\d+)\n/.exec(source)?.[1];
  if (!table || !version) {
    throw new Error("The sidecar identity module no longer declares its surface contract where this test reads it.");
  }

  const modesBySurface = new Map<string, string[]>();
  for (const [, surface, modes] of table.matchAll(/^ {4}"([A-Za-z]+)": \{([^}]*)\},$/gm)) {
    modesBySurface.set(surface, [...modes.matchAll(/"([a-z]+)"/g)].map(([, mode]) => mode).sort());
  }
  return { identityVersion: Number(version), modesBySurface };
}

/**
 * The length bounds identity.py actually enforces, read from its normalizer
 * calls rather than from describe_surfaces -- the descriptor is a second copy
 * and has been wrong before, so the enforcing code is the authority.
 */
function readSidecarTextFieldBounds(): Map<string, number> {
  const source = Object.values(sidecarIdentitySources)[0];
  if (!source) {
    throw new Error("The sidecar identity module could not be read.");
  }
  const constants = new Map<string, number>();
  for (const [, name, value] of source.matchAll(/^(MAX_[A-Z_]*LENGTH) = ([\d_]+)$/gm)) {
    constants.set(name, Number(value.replace(/_/g, "")));
  }
  const bounds = new Map<string, number>();
  for (const [, path, constant] of source.matchAll(/_require_string\([^,]+,\s*"([^"]+)"[^)]*max_length=(MAX_[A-Z_]+)/g)) {
    const value = constants.get(constant);
    if (value !== undefined) {
      bounds.set(path, value);
    }
  }
  if (bounds.size === 0) {
    throw new Error("The sidecar identity module no longer declares its text bounds where this test reads them.");
  }
  return bounds;
}

function identity(overrides: Partial<ProfileIdentity> = {}): ProfileIdentity {
  return {
    identityVersion: 2,
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
    geolocation: {
      mode: "custom",
      permission: "allow",
      latitude: 52.520008,
      longitude: 13.404954,
      accuracy: 120,
      altitude: null,
    },
    mediaDevices: { mode: "masked", noiseSeed: 3001 },
    ports: { mode: "custom", allowedPorts: [3000, 8080] },
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

  it("offers geolocation a real-or-custom choice without a masked mode", () => {
    const options = getSupportedIdentityModeOptions("geolocation").map((option) => option.value);

    expect(options).toEqual(["real", "custom"]);
    expect(options).not.toContain("masked");
    expect(options).not.toContain("noise");
  });

  it("agrees with the sidecar identity surface contract on surfaces and modes", () => {
    const contract = readSidecarSurfaceContract();

    expect(contract.identityVersion).toBe(identity().identityVersion);
    expect([...contract.modesBySurface.keys()].sort()).toEqual([...IDENTITY_SURFACE_ORDER].sort());

    for (const [surface, modes] of contract.modesBySurface) {
      expect(getSupportedIdentityModeOptions(surface as IdentitySurface).map((option) => option.value).sort()).toEqual(modes);
    }
  });

  it("agrees with the sidecar on the length bound of every text field it edits", () => {
    // A form built from a smaller bound than the sidecar enforces rejects values
    // the sidecar accepts and persists, which reads as a bug in the profile
    // rather than in the form. This is the drift the describe contract exists to
    // catch, so it is compared rather than assumed.
    const enforced = readSidecarTextFieldBounds();

    for (const descriptor of IDENTITY_DRAFT_FIELD_DESCRIPTORS) {
      const bound = enforced.get(descriptor.path);
      if (bound === undefined || descriptor.maxLength === undefined) {
        continue;
      }
      expect(descriptor.maxLength, `${descriptor.path} bound disagrees with the sidecar`).toBe(bound);
    }
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

  it("seeds each surface with its own shape when a mode changes", () => {
    let draft = createIdentityDraftState(profileRecord(identity()));

    draft = updateIdentityDraftSurfaceMode(draft, "ports", "masked");
    draft = updateIdentityDraftSurfaceMode(draft, "mediaDevices", "custom");
    draft = updateIdentityDraftSurfaceMode(draft, "geolocation", "real");

    expect(draft.identity.ports).toEqual({ mode: "masked" });
    expect(draft.identity.mediaDevices).toEqual({ mode: "custom", videoInputs: 1, audioInputs: 1, audioOutputs: 1 });
    expect(draft.identity.geolocation).toEqual({ mode: "real", permission: "allow" });
  });

  it("normalizes an allowed-port list the way the sidecar stores it", () => {
    let draft = createIdentityDraftState(profileRecord(identity()));
    draft = updateIdentityDraftField(draft, "ports.allowedPorts", "8080, 3000, 8080, 1");

    const parsed = parseIdentityDraftState(draft);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.identity.ports).toEqual({ mode: "custom", allowedPorts: [1, 3000, 8080] });
    }
  });

  it("guards geolocation, media device, and port fields before a sidecar payload is built", () => {
    let draft = createIdentityDraftState(profileRecord(identity()));

    draft = updateIdentityDraftField(draft, "geolocation.latitude", "91");
    draft = updateIdentityDraftField(draft, "geolocation.permission", "always");
    draft = updateIdentityDraftField(draft, "ports.allowedPorts", "80, 70000");
    draft = updateIdentityDraftSurfaceMode(draft, "geolocation", "masked");

    const parsed = parseIdentityDraftState(draft);

    expect(draft.errors["geolocation.mode"]).toMatch(/does not support masked mode/i);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors["geolocation.latitude"]).toMatch(/between -90 and 90/i);
      expect(parsed.errors["geolocation.permission"]).toMatch(/prompt, allow, or block/i);
      expect(parsed.errors["ports.allowedPorts"]).toMatch(/between 1 and 65535/i);
    }
  });

  it("keeps a surface the draft builder does not parse instead of dropping it from the payload", () => {
    const savedIdentity = identity();
    const futureSurface = { mode: "masked", futureField: 7 };
    const withFutureSurface = { ...savedIdentity, futureSurface } as ProfileIdentity;
    const draft: IdentityDraftState = { identity: withFutureSurface, values: seedValues(savedIdentity), errors: {}, labelEdited: false };

    const parsed = parseIdentityDraftState(draft);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.identity.identityVersion).toBe(2);
      expect((parsed.identity as unknown as Record<string, unknown>).futureSurface).toEqual(futureSurface);
      expect((parsed.identity as unknown as Record<string, unknown>).futureSurface).not.toBe(futureSurface);
      expect(parsed.identity.geolocation).toEqual(savedIdentity.geolocation);
      expect(parsed.identity.mediaDevices).toEqual(savedIdentity.mediaDevices);
      expect(parsed.identity.ports).toEqual(savedIdentity.ports);
    }
  });

  it("counts text field bounds in code points so astral characters are not charged twice", () => {
    let draft = createIdentityDraftState(profileRecord(identity()));
    draft = updateIdentityDraftField(draft, "webgl.vendor", "😀".repeat(512));

    expect(parseIdentityDraftState(draft).ok).toBe(true);

    draft = updateIdentityDraftField(draft, "webgl.vendor", "😀".repeat(513));

    const parsed = parseIdentityDraftState(draft);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors["webgl.vendor"]).toMatch(/512 safe characters or fewer/i);
    }
  });

  it("formats expected values for S05 verifier wording without leaking implementation paths", () => {
    const summary = formatIdentityExpectedValueSummary(identity());

    expect(summary).toContain("Browser: Masked UA Mozilla/5.0 Test");
    expect(summary).toContain("Navigator: Custom Linux x86_64, 8 cores, 8 GiB");
    expect(summary).toContain("Locale: Custom en-US, en-US/en, UTC");
    expect(summary).toContain("WebRTC: Custom WebRTC policy block");
    expect(summary).toContain("Geolocation: Custom 52.520008, 13.404954 ±120 m, permission allow");
    expect(summary).toContain("Media devices: Masked device labels, noise seed 3001");
    expect(summary).toContain("Ports: Custom allowed ports 3000/8080");
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
    "geolocation.permission": savedIdentity.geolocation.permission,
    "geolocation.latitude": savedIdentity.geolocation.mode === "real" ? "0" : String(savedIdentity.geolocation.latitude),
    "geolocation.longitude": savedIdentity.geolocation.mode === "real" ? "0" : String(savedIdentity.geolocation.longitude),
    "geolocation.accuracy": savedIdentity.geolocation.mode === "real" ? "100" : String(savedIdentity.geolocation.accuracy),
    "geolocation.altitude": savedIdentity.geolocation.mode === "real" || savedIdentity.geolocation.altitude === null ? "" : String(savedIdentity.geolocation.altitude),
    "mediaDevices.noiseSeed": savedIdentity.mediaDevices.mode === "masked" ? String(savedIdentity.mediaDevices.noiseSeed) : "3001",
    "mediaDevices.videoInputs": savedIdentity.mediaDevices.mode === "custom" ? String(savedIdentity.mediaDevices.videoInputs) : "1",
    "mediaDevices.audioInputs": savedIdentity.mediaDevices.mode === "custom" ? String(savedIdentity.mediaDevices.audioInputs) : "1",
    "mediaDevices.audioOutputs": savedIdentity.mediaDevices.mode === "custom" ? String(savedIdentity.mediaDevices.audioOutputs) : "1",
    "ports.allowedPorts": savedIdentity.ports.mode === "custom" ? savedIdentity.ports.allowedPorts.join(", ") : "",
  };
}
