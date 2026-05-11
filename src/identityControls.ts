import type { IdentityMaskingMode, IdentityNoiseMode, IdentitySurface, ProfileIdentity, ProfileRecord } from "./sidecar/types";

export type IdentityModeValue = IdentityMaskingMode | IdentityNoiseMode;

export interface IdentityModeOption {
  value: IdentityModeValue;
  label: string;
  description: string;
}

export interface IdentitySurfaceControl {
  surface: IdentitySurface;
  label: string;
  mode: IdentityModeValue;
  modeLabel: string;
  options: IdentityModeOption[];
}

export const IDENTITY_SURFACE_ORDER: IdentitySurface[] = [
  "browser",
  "navigator",
  "screen",
  "locale",
  "canvas",
  "audio",
  "webgl",
  "webrtc",
];

export const IDENTITY_SURFACE_LABELS: Record<IdentitySurface, string> = {
  browser: "Browser",
  navigator: "Navigator",
  screen: "Screen",
  locale: "Locale",
  canvas: "Canvas",
  audio: "Audio",
  webgl: "WebGL",
  webrtc: "WebRTC",
};

const MASKING_MODE_OPTIONS: IdentityModeOption[] = [
  {
    value: "real",
    label: "Real",
    description: "Use the host value reported by Chromium without masking this surface.",
  },
  {
    value: "masked",
    label: "Masked",
    description: "Use a curated sidecar-provided value for this surface.",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Use a saved override for this surface.",
  },
];

const NOISE_MODE_OPTIONS: IdentityModeOption[] = [
  {
    value: "real",
    label: "Real",
    description: "Use the host value reported by Chromium without injecting noise.",
  },
  {
    value: "noise",
    label: "Noise",
    description: "Use deterministic sidecar noise for this rendering surface.",
  },
];

const NOISE_SURFACES = new Set<IdentitySurface>(["canvas", "audio"]);

export function getSupportedIdentityModeOptions(surface: IdentitySurface): IdentityModeOption[] {
  return (NOISE_SURFACES.has(surface) ? NOISE_MODE_OPTIONS : MASKING_MODE_OPTIONS).map((option) => ({ ...option }));
}

export function getIdentitySurfaceControls(identity: ProfileIdentity): IdentitySurfaceControl[] {
  return IDENTITY_SURFACE_ORDER.map((surface) => {
    const mode = getIdentitySurfaceMode(identity, surface);
    return {
      surface,
      label: IDENTITY_SURFACE_LABELS[surface],
      mode,
      modeLabel: formatIdentityMode(mode),
      options: getSupportedIdentityModeOptions(surface),
    };
  });
}

export function getIdentitySurfaceMode(identity: ProfileIdentity, surface: IdentitySurface): IdentityModeValue {
  return identity[surface].mode;
}

export function cloneProfileIdentity(identity: ProfileIdentity): ProfileIdentity {
  return JSON.parse(JSON.stringify(identity)) as ProfileIdentity;
}

export function seedInitialIdentityDraft(profile: ProfileRecord): ProfileIdentity {
  return cloneProfileIdentity(profile.identity);
}

export function formatIdentitySummary(identity: ProfileIdentity): string {
  const preset = identity.presetId ? `Preset ${identity.presetId}` : "No preset";
  const surfaceSummary = IDENTITY_SURFACE_ORDER.map((surface) => {
    const label = IDENTITY_SURFACE_LABELS[surface];
    return `${label} ${getIdentitySurfaceMode(identity, surface)}`;
  }).join(" · ");

  return `${identity.label} · ${preset} · ${surfaceSummary}`;
}

export function formatIdentityMode(mode: IdentityModeValue): string {
  if (mode === "real") {
    return "Real";
  }
  if (mode === "masked") {
    return "Masked";
  }
  if (mode === "custom") {
    return "Custom";
  }
  return "Noise";
}
