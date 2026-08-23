import type {
  BrowserClientHints,
  IdentityMaskingMode,
  IdentityNoiseMode,
  IdentitySurface,
  ProfileIdentity,
  ProfileRecord,
  WebRtcPolicy,
} from "./sidecar/types";

export type IdentityModeValue = IdentityMaskingMode | IdentityNoiseMode;
export type IdentityDraftFieldKind = "text" | "textarea" | "integer" | "number" | "boolean" | "language-list" | "webrtc-policy" | "geolocation-permission" | "port-list";
export type IdentityDraftFieldPath =
  | "label"
  | "browser.userAgent"
  | "browser.clientHints.platform"
  | "browser.clientHints.platformVersion"
  | "browser.clientHints.architecture"
  | "browser.clientHints.bitness"
  | "browser.clientHints.model"
  | "browser.clientHints.mobile"
  | "navigator.platform"
  | "navigator.hardwareConcurrency"
  | "navigator.deviceMemory"
  | "navigator.uaPlatform"
  | "navigator.uaPlatformVersion"
  | "navigator.uaArchitecture"
  | "navigator.uaMobile"
  | "screen.width"
  | "screen.height"
  | "screen.viewportWidth"
  | "screen.viewportHeight"
  | "screen.colorDepth"
  | "screen.pixelRatio"
  | "locale.locale"
  | "locale.languages"
  | "locale.timezoneId"
  | "canvas.noiseSeed"
  | "audio.noiseSeed"
  | "webgl.vendor"
  | "webgl.renderer"
  | "webgl.noiseSeed"
  | "webrtc.policy"
  | "geolocation.permission"
  | "geolocation.latitude"
  | "geolocation.longitude"
  | "geolocation.accuracy"
  | "geolocation.altitude"
  | "mediaDevices.noiseSeed"
  | "mediaDevices.videoInputs"
  | "mediaDevices.audioInputs"
  | "mediaDevices.audioOutputs"
  | "ports.allowedPorts";

export type IdentityDraftFieldValues = Record<IdentityDraftFieldPath, string>;
export type IdentityDraftFieldErrors = Partial<Record<IdentityDraftFieldPath | `${IdentitySurface}.mode`, string>>;

export interface IdentityModeOption {
  value: IdentityModeValue;
  label: string;
  description: string;
}

export interface IdentityDraftFieldDescriptor {
  surface: IdentitySurface;
  path: Exclude<IdentityDraftFieldPath, "label">;
  label: string;
  kind: IdentityDraftFieldKind;
  description: string;
  modes: IdentityModeValue[];
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
}

export interface IdentitySurfaceControl {
  surface: IdentitySurface;
  label: string;
  mode: IdentityModeValue;
  modeLabel: string;
  options: IdentityModeOption[];
  fields: IdentityDraftFieldDescriptor[];
}

export interface IdentityDraftState {
  identity: ProfileIdentity;
  values: IdentityDraftFieldValues;
  errors: IdentityDraftFieldErrors;
  labelEdited: boolean;
}

export type IdentityDraftParseResult =
  | { ok: true; identity: ProfileIdentity; errors: IdentityDraftFieldErrors }
  | { ok: false; errors: IdentityDraftFieldErrors };

export const DEFAULT_ADVANCED_IDENTITY_LABEL = "Custom identity override";

export const IDENTITY_VERSION: ProfileIdentity["identityVersion"] = 2;

export const IDENTITY_SURFACE_ORDER: IdentitySurface[] = [
  "browser",
  "navigator",
  "screen",
  "locale",
  "canvas",
  "audio",
  "webgl",
  "webrtc",
  "geolocation",
  "mediaDevices",
  "ports",
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
  geolocation: "Geolocation",
  mediaDevices: "Media devices",
  ports: "Ports",
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

// Geolocation deliberately has no "masked" mode: deriving a plausible position
// from the proxy exit needs a third-party geo-IP lookup on every launch, which
// leaks the exit to hide it. The UI offers the last proxy check instead.
const GEOLOCATION_MODE_OPTIONS: IdentityModeOption[] = [
  {
    value: "real",
    label: "Real",
    description: "Let Chromium report the host position when a site is granted the permission.",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Report a saved fixed position for this profile.",
  },
];

const NOISE_SURFACES = new Set<IdentitySurface>(["canvas", "audio"]);

const FIELD_DEFAULTS: IdentityDraftFieldValues = {
  label: DEFAULT_ADVANCED_IDENTITY_LABEL,
  "browser.userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "browser.clientHints.platform": "Linux",
  "browser.clientHints.platformVersion": "",
  "browser.clientHints.architecture": "x86",
  "browser.clientHints.bitness": "64",
  "browser.clientHints.model": "",
  "browser.clientHints.mobile": "false",
  "navigator.platform": "Linux x86_64",
  "navigator.hardwareConcurrency": "8",
  "navigator.deviceMemory": "8",
  "navigator.uaPlatform": "Linux",
  "navigator.uaPlatformVersion": "",
  "navigator.uaArchitecture": "x86",
  "navigator.uaMobile": "false",
  "screen.width": "1920",
  "screen.height": "1080",
  "screen.viewportWidth": "1440",
  "screen.viewportHeight": "900",
  "screen.colorDepth": "24",
  "screen.pixelRatio": "1",
  "locale.locale": "en-US",
  "locale.languages": "en-US, en",
  "locale.timezoneId": "UTC",
  "canvas.noiseSeed": "1001",
  "audio.noiseSeed": "2001",
  "webgl.vendor": "Intel Inc.",
  "webgl.renderer": "Mesa Intel(R) Graphics",
  "webgl.noiseSeed": "",
  "webrtc.policy": "real",
  "geolocation.permission": "prompt",
  "geolocation.latitude": "0",
  "geolocation.longitude": "0",
  "geolocation.accuracy": "100",
  "geolocation.altitude": "",
  "mediaDevices.noiseSeed": "3001",
  "mediaDevices.videoInputs": "1",
  "mediaDevices.audioInputs": "1",
  "mediaDevices.audioOutputs": "1",
  "ports.allowedPorts": "",
};

const GEOLOCATION_COORDINATE_DECIMALS = 6;
const MAX_ALLOWED_PORT_ENTRIES = 50;

const MASKED_OR_CUSTOM: IdentityModeValue[] = ["masked", "custom"];
const MASKED_ONLY: IdentityModeValue[] = ["masked"];
const CUSTOM_ONLY: IdentityModeValue[] = ["custom"];
const NOISE_ONLY: IdentityModeValue[] = ["noise"];
const WEBRTC_MODES: IdentityModeValue[] = ["real", "masked", "custom"];
const GEOLOCATION_MODES: IdentityModeValue[] = ["real", "custom"];

export const IDENTITY_DRAFT_FIELD_DESCRIPTORS: IdentityDraftFieldDescriptor[] = [
  {
    surface: "browser",
    path: "browser.userAgent",
    label: "User agent",
    kind: "textarea",
    description: "The Chromium user-agent string exposed to sites.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    maxLength: 512,
  },
  {
    surface: "browser",
    path: "browser.clientHints.platform",
    label: "Client hints platform",
    kind: "text",
    description: "Optional Sec-CH-UA platform value.",
    modes: MASKED_OR_CUSTOM,
    maxLength: 80,
  },
  {
    surface: "browser",
    path: "browser.clientHints.platformVersion",
    label: "Client hints platform version",
    kind: "text",
    description: "Optional Sec-CH-UA platform version value.",
    modes: MASKED_OR_CUSTOM,
    maxLength: 80,
  },
  {
    surface: "browser",
    path: "browser.clientHints.architecture",
    label: "Client hints architecture",
    kind: "text",
    description: "Optional Sec-CH-UA architecture value.",
    modes: MASKED_OR_CUSTOM,
    maxLength: 80,
  },
  {
    surface: "browser",
    path: "browser.clientHints.bitness",
    label: "Client hints bitness",
    kind: "text",
    description: "Optional Sec-CH-UA bitness value.",
    modes: MASKED_OR_CUSTOM,
    maxLength: 80,
  },
  {
    surface: "browser",
    path: "browser.clientHints.model",
    label: "Client hints model",
    kind: "text",
    description: "Optional mobile model value; usually blank for desktop profiles.",
    modes: MASKED_OR_CUSTOM,
    maxLength: 80,
  },
  {
    surface: "browser",
    path: "browser.clientHints.mobile",
    label: "Client hints mobile",
    kind: "boolean",
    description: "Whether Chromium Client Hints should report a mobile device.",
    modes: MASKED_OR_CUSTOM,
  },
  {
    surface: "navigator",
    path: "navigator.platform",
    label: "Navigator platform",
    kind: "text",
    description: "The value exposed through navigator.platform.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    maxLength: 80,
  },
  {
    surface: "navigator",
    path: "navigator.hardwareConcurrency",
    label: "Hardware concurrency",
    kind: "integer",
    description: "CPU core count exposed through navigator.hardwareConcurrency.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    min: 1,
    max: 128,
  },
  {
    surface: "navigator",
    path: "navigator.deviceMemory",
    label: "Device memory",
    kind: "number",
    description: "Approximate memory in GiB exposed through navigator.deviceMemory.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    min: 0.25,
    max: 128,
  },
  {
    surface: "navigator",
    path: "navigator.uaPlatform",
    label: "UA platform",
    kind: "text",
    description: "The User-Agent Client Hints platform paired with navigator values.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    maxLength: 80,
  },
  {
    surface: "navigator",
    path: "navigator.uaPlatformVersion",
    label: "UA platform version",
    kind: "text",
    description: "Optional platform version paired with navigator values.",
    modes: MASKED_OR_CUSTOM,
    maxLength: 80,
  },
  {
    surface: "navigator",
    path: "navigator.uaArchitecture",
    label: "UA architecture",
    kind: "text",
    description: "The architecture paired with navigator values.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    maxLength: 80,
  },
  {
    surface: "navigator",
    path: "navigator.uaMobile",
    label: "UA mobile",
    kind: "boolean",
    description: "Whether navigator/User-Agent Client Hints should describe a mobile device.",
    modes: MASKED_OR_CUSTOM,
    required: true,
  },
  {
    surface: "screen",
    path: "screen.width",
    label: "Screen width",
    kind: "integer",
    description: "Total screen width in CSS pixels.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    min: 1,
    max: 10000,
  },
  {
    surface: "screen",
    path: "screen.height",
    label: "Screen height",
    kind: "integer",
    description: "Total screen height in CSS pixels.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    min: 1,
    max: 10000,
  },
  {
    surface: "screen",
    path: "screen.viewportWidth",
    label: "Viewport width",
    kind: "integer",
    description: "Viewport width applied at launch.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    min: 1,
    max: 10000,
  },
  {
    surface: "screen",
    path: "screen.viewportHeight",
    label: "Viewport height",
    kind: "integer",
    description: "Viewport height applied at launch.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    min: 1,
    max: 10000,
  },
  {
    surface: "screen",
    path: "screen.colorDepth",
    label: "Color depth",
    kind: "integer",
    description: "screen.colorDepth value.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    min: 1,
    max: 64,
  },
  {
    surface: "screen",
    path: "screen.pixelRatio",
    label: "Pixel ratio",
    kind: "number",
    description: "devicePixelRatio value.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    min: 0.25,
    max: 8,
  },
  {
    surface: "locale",
    path: "locale.locale",
    label: "Locale",
    kind: "text",
    description: "Primary BCP 47 language tag, such as en-US.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    maxLength: 20,
  },
  {
    surface: "locale",
    path: "locale.languages",
    label: "Languages",
    kind: "language-list",
    description: "Comma-separated BCP 47 language tags, in navigator.languages order.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    maxLength: 180,
  },
  {
    surface: "locale",
    path: "locale.timezoneId",
    label: "Timezone ID",
    kind: "text",
    description: "IANA timezone identifier such as Europe/Berlin, or UTC.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    maxLength: 80,
  },
  {
    surface: "canvas",
    path: "canvas.noiseSeed",
    label: "Canvas noise seed",
    kind: "integer",
    description: "Deterministic canvas noise seed.",
    modes: NOISE_ONLY,
    required: true,
    min: 0,
    max: 1_000_000,
  },
  {
    surface: "audio",
    path: "audio.noiseSeed",
    label: "Audio noise seed",
    kind: "integer",
    description: "Deterministic audio noise seed.",
    modes: NOISE_ONLY,
    required: true,
    min: 0,
    max: 1_000_000,
  },
  {
    surface: "webgl",
    path: "webgl.vendor",
    label: "WebGL vendor",
    kind: "text",
    description: "WebGL vendor string.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    maxLength: 512,
  },
  {
    surface: "webgl",
    path: "webgl.renderer",
    label: "WebGL renderer",
    kind: "text",
    description: "WebGL renderer string.",
    modes: MASKED_OR_CUSTOM,
    required: true,
    maxLength: 512,
  },
  {
    surface: "webgl",
    path: "webgl.noiseSeed",
    label: "WebGL noise seed",
    kind: "integer",
    description: "Optional deterministic WebGL noise seed.",
    modes: MASKED_OR_CUSTOM,
    min: 0,
    max: 1_000_000,
  },
  {
    surface: "webrtc",
    path: "webrtc.policy",
    label: "WebRTC policy",
    kind: "webrtc-policy",
    description: "Network exposure policy for WebRTC candidates.",
    modes: WEBRTC_MODES,
    required: true,
  },
  {
    surface: "geolocation",
    path: "geolocation.permission",
    label: "Geolocation permission",
    kind: "geolocation-permission",
    description: "What Chromium answers when a site asks for the position.",
    modes: GEOLOCATION_MODES,
    required: true,
  },
  {
    surface: "geolocation",
    path: "geolocation.latitude",
    label: "Latitude",
    kind: "number",
    description: "Reported latitude in decimal degrees, rounded to six places.",
    modes: CUSTOM_ONLY,
    required: true,
    min: -90,
    max: 90,
  },
  {
    surface: "geolocation",
    path: "geolocation.longitude",
    label: "Longitude",
    kind: "number",
    description: "Reported longitude in decimal degrees, rounded to six places.",
    modes: CUSTOM_ONLY,
    required: true,
    min: -180,
    max: 180,
  },
  {
    surface: "geolocation",
    path: "geolocation.accuracy",
    label: "Accuracy",
    kind: "integer",
    description: "Reported accuracy radius in metres.",
    modes: CUSTOM_ONLY,
    required: true,
    min: 1,
    max: 100_000,
  },
  {
    surface: "geolocation",
    path: "geolocation.altitude",
    label: "Altitude",
    kind: "number",
    description: "Optional reported altitude in metres; blank reports no altitude.",
    modes: CUSTOM_ONLY,
    min: -1_000,
    max: 100_000,
  },
  {
    surface: "mediaDevices",
    path: "mediaDevices.noiseSeed",
    label: "Media devices noise seed",
    kind: "integer",
    description: "Deterministic seed for masked media device labels and ids.",
    modes: MASKED_ONLY,
    required: true,
    min: 0,
    max: 1_000_000,
  },
  {
    surface: "mediaDevices",
    path: "mediaDevices.videoInputs",
    label: "Video inputs",
    kind: "integer",
    description: "Number of cameras enumerated by mediaDevices.",
    modes: CUSTOM_ONLY,
    required: true,
    min: 0,
    max: 1,
  },
  {
    surface: "mediaDevices",
    path: "mediaDevices.audioInputs",
    label: "Audio inputs",
    kind: "integer",
    description: "Number of microphones enumerated by mediaDevices.",
    modes: CUSTOM_ONLY,
    required: true,
    min: 1,
    max: 4,
  },
  {
    surface: "mediaDevices",
    path: "mediaDevices.audioOutputs",
    label: "Audio outputs",
    kind: "integer",
    description: "Number of speakers enumerated by mediaDevices.",
    modes: CUSTOM_ONLY,
    required: true,
    min: 1,
    max: 4,
  },
  {
    surface: "ports",
    path: "ports.allowedPorts",
    label: "Allowed ports",
    kind: "port-list",
    description: "Comma-separated localhost ports pages may still reach, at most 50 entries.",
    modes: CUSTOM_ONLY,
    min: 1,
    max: 65_535,
  },
];

export function getSupportedIdentityModeOptions(surface: IdentitySurface): IdentityModeOption[] {
  return identitySurfaceModeOptions(surface).map((option) => ({ ...option }));
}

function identitySurfaceModeOptions(surface: IdentitySurface): IdentityModeOption[] {
  if (NOISE_SURFACES.has(surface)) {
    return NOISE_MODE_OPTIONS;
  }
  if (surface === "geolocation") {
    return GEOLOCATION_MODE_OPTIONS;
  }
  return MASKING_MODE_OPTIONS;
}

export function isSupportedIdentityMode(surface: IdentitySurface, value: string): value is IdentityModeValue {
  return getSupportedIdentityModeOptions(surface).some((option) => option.value === value);
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
      fields: getIdentitySurfaceFieldDescriptors(identity, surface),
    };
  });
}

export function getIdentitySurfaceFieldDescriptors(
  identity: ProfileIdentity,
  surface: IdentitySurface,
): IdentityDraftFieldDescriptor[] {
  const mode = getIdentitySurfaceMode(identity, surface);
  return IDENTITY_DRAFT_FIELD_DESCRIPTORS
    .filter((descriptor) => descriptor.surface === surface && descriptor.modes.includes(mode))
    .map((descriptor) => ({ ...descriptor, modes: [...descriptor.modes] }));
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

export function createIdentityDraftState(profileOrIdentity: ProfileRecord | ProfileIdentity): IdentityDraftState {
  const identity = "identity" in profileOrIdentity ? profileOrIdentity.identity : profileOrIdentity;
  const cloned = cloneProfileIdentity(identity);
  return {
    identity: cloned,
    values: serializeIdentityDraftValues(cloned),
    errors: {},
    labelEdited: false,
  };
}

export function updateIdentityDraftLabel(draft: IdentityDraftState, value: string): IdentityDraftState {
  const identity = cloneProfileIdentity(draft.identity);
  identity.label = value;
  identity.presetId = null;
  const values = { ...draft.values, label: value };
  return rebuildDraftFromValues(identity, values, true);
}

export function updateIdentityDraftField(
  draft: IdentityDraftState,
  path: Exclude<IdentityDraftFieldPath, "label">,
  value: string,
): IdentityDraftState {
  const identity = markIdentityAsAdvancedOverride(draft.identity, { preserveLabel: draft.labelEdited });
  const values = {
    ...draft.values,
    label: identity.label,
    [path]: value,
  };
  return rebuildDraftFromValues(identity, values, draft.labelEdited);
}

export function updateIdentityDraftSurfaceMode(
  draft: IdentityDraftState,
  surface: IdentitySurface,
  modeValue: string,
): IdentityDraftState {
  if (!isSupportedIdentityMode(surface, modeValue)) {
    return {
      ...draft,
      errors: {
        ...draft.errors,
        [`${surface}.mode`]: `${IDENTITY_SURFACE_LABELS[surface]} does not support ${modeValue || "the selected"} mode.`,
      },
    };
  }

  const identity = markIdentityAsAdvancedOverride(draft.identity, { preserveLabel: draft.labelEdited });
  assignIdentitySurface(identity, surface, seedIdentitySurface(surface, modeValue, identity, draft.values));

  if (surface === "webrtc" && modeValue === "real") {
    identity.webrtc = { mode: "real", policy: "real" };
  }

  const values = serializeIdentityDraftValues(identity);
  if (draft.labelEdited) {
    values.label = draft.values.label;
    identity.label = draft.values.label;
  }
  return rebuildDraftFromValues(identity, values, draft.labelEdited);
}

export function parseIdentityDraftState(draft: IdentityDraftState): IdentityDraftParseResult {
  return buildProfileIdentityFromValues(draft.identity, draft.values);
}

export function markIdentityAsAdvancedOverride(
  identity: ProfileIdentity,
  options: { preserveLabel?: boolean; fallbackLabel?: string } = {},
): ProfileIdentity {
  const next = cloneProfileIdentity(identity);
  const fallbackLabel = options.fallbackLabel ?? DEFAULT_ADVANCED_IDENTITY_LABEL;
  next.presetId = null;
  if (!options.preserveLabel || !next.label.trim()) {
    next.label = fallbackLabel;
  }
  return next;
}

export function serializeIdentityDraftValues(identity: ProfileIdentity): IdentityDraftFieldValues {
  const values = { ...FIELD_DEFAULTS };
  values.label = identity.label;

  if (identity.browser.mode !== "real") {
    values["browser.userAgent"] = identity.browser.userAgent;
    values["browser.clientHints.platform"] = identity.browser.clientHints?.platform ?? "";
    values["browser.clientHints.platformVersion"] = identity.browser.clientHints?.platformVersion ?? "";
    values["browser.clientHints.architecture"] = identity.browser.clientHints?.architecture ?? "";
    values["browser.clientHints.bitness"] = identity.browser.clientHints?.bitness ?? "";
    values["browser.clientHints.model"] = identity.browser.clientHints?.model ?? "";
    values["browser.clientHints.mobile"] = String(identity.browser.clientHints?.mobile ?? false);
  }

  if (identity.navigator.mode !== "real") {
    values["navigator.platform"] = identity.navigator.platform;
    values["navigator.hardwareConcurrency"] = String(identity.navigator.hardwareConcurrency);
    values["navigator.deviceMemory"] = String(identity.navigator.deviceMemory);
    values["navigator.uaPlatform"] = identity.navigator.uaPlatform;
    values["navigator.uaPlatformVersion"] = identity.navigator.uaPlatformVersion;
    values["navigator.uaArchitecture"] = identity.navigator.uaArchitecture;
    values["navigator.uaMobile"] = String(identity.navigator.uaMobile);
  }

  if (identity.screen.mode !== "real") {
    values["screen.width"] = String(identity.screen.width);
    values["screen.height"] = String(identity.screen.height);
    values["screen.viewportWidth"] = String(identity.screen.viewportWidth);
    values["screen.viewportHeight"] = String(identity.screen.viewportHeight);
    values["screen.colorDepth"] = String(identity.screen.colorDepth);
    values["screen.pixelRatio"] = String(identity.screen.pixelRatio);
  }

  if (identity.locale.mode !== "real") {
    values["locale.locale"] = identity.locale.locale;
    values["locale.languages"] = identity.locale.languages.join(", ");
    values["locale.timezoneId"] = identity.locale.timezoneId;
  }

  if (identity.canvas.mode === "noise") {
    values["canvas.noiseSeed"] = String(identity.canvas.noiseSeed);
  }

  if (identity.audio.mode === "noise") {
    values["audio.noiseSeed"] = String(identity.audio.noiseSeed);
  }

  if (identity.webgl.mode !== "real") {
    values["webgl.vendor"] = identity.webgl.vendor;
    values["webgl.renderer"] = identity.webgl.renderer;
    values["webgl.noiseSeed"] = identity.webgl.noiseSeed === undefined ? "" : String(identity.webgl.noiseSeed);
  }

  values["webrtc.policy"] = identity.webrtc.policy;
  values["geolocation.permission"] = identity.geolocation.permission;

  if (identity.geolocation.mode !== "real") {
    values["geolocation.latitude"] = String(identity.geolocation.latitude);
    values["geolocation.longitude"] = String(identity.geolocation.longitude);
    values["geolocation.accuracy"] = String(identity.geolocation.accuracy);
    values["geolocation.altitude"] = identity.geolocation.altitude === null ? "" : String(identity.geolocation.altitude);
  }

  if (identity.mediaDevices.mode === "masked") {
    values["mediaDevices.noiseSeed"] = String(identity.mediaDevices.noiseSeed);
  } else if (identity.mediaDevices.mode === "custom") {
    values["mediaDevices.videoInputs"] = String(identity.mediaDevices.videoInputs);
    values["mediaDevices.audioInputs"] = String(identity.mediaDevices.audioInputs);
    values["mediaDevices.audioOutputs"] = String(identity.mediaDevices.audioOutputs);
  }

  if (identity.ports.mode === "custom") {
    values["ports.allowedPorts"] = identity.ports.allowedPorts.join(", ");
  }

  return values;
}

export function formatIdentitySummary(identity: ProfileIdentity): string {
  const preset = identity.presetId ? `Preset ${identity.presetId}` : "No preset";
  const surfaceSummary = IDENTITY_SURFACE_ORDER.map((surface) => {
    const label = IDENTITY_SURFACE_LABELS[surface];
    return `${label} ${getIdentitySurfaceMode(identity, surface)}`;
  }).join(" · ");

  return `${identity.label} · ${preset} · ${surfaceSummary}`;
}

export function formatIdentityExpectedValueSummary(identity: ProfileIdentity): string {
  return IDENTITY_SURFACE_ORDER.map((surface) => {
    return `${IDENTITY_SURFACE_LABELS[surface]}: ${formatIdentitySurfaceExpectedValues(identity, surface)}`;
  }).join(" · ");
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

function rebuildDraftFromValues(identity: ProfileIdentity, values: IdentityDraftFieldValues, labelEdited: boolean): IdentityDraftState {
  const parsed = buildProfileIdentityFromValues(identity, values);
  return {
    identity: parsed.ok ? parsed.identity : identity,
    values,
    errors: parsed.errors,
    labelEdited,
  };
}

function buildProfileIdentityFromValues(baseIdentity: ProfileIdentity, values: IdentityDraftFieldValues): IdentityDraftParseResult {
  const errors: IdentityDraftFieldErrors = {};
  const label = parseTextValue(values.label, {
    path: "label",
    label: "Identity label",
    maxLength: 128,
    required: true,
    errors,
  });

  // Merged onto the source identity rather than rebuilt as a literal: a surface
  // this builder does not parse must survive the round trip instead of being
  // dropped from the payload the sidecar is handed back.
  const identity = cloneProfileIdentity(baseIdentity);
  identity.identityVersion = IDENTITY_VERSION;
  identity.label = label;
  identity.presetId = baseIdentity.presetId;
  identity.browser = buildBrowserSurface(baseIdentity.browser.mode, values, errors, baseIdentity.browser);
  identity.navigator = buildNavigatorSurface(baseIdentity.navigator.mode, values, errors);
  identity.screen = buildScreenSurface(baseIdentity.screen.mode, values, errors);
  identity.locale = buildLocaleSurface(baseIdentity.locale.mode, values, errors);
  identity.canvas = buildNoiseSurface("canvas", baseIdentity.canvas.mode, values, errors);
  identity.audio = buildNoiseSurface("audio", baseIdentity.audio.mode, values, errors);
  identity.webgl = buildWebGlSurface(baseIdentity.webgl.mode, values, errors);
  identity.webrtc = buildWebRtcSurface(baseIdentity.webrtc.mode, values, errors);
  identity.geolocation = buildGeolocationSurface(baseIdentity.geolocation.mode, values, errors);
  identity.mediaDevices = buildMediaDevicesSurface(baseIdentity.mediaDevices.mode, values, errors);
  identity.ports = buildPortsSurface(baseIdentity.ports.mode, values, errors);

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, identity, errors: {} };
}

function buildBrowserSurface(
  mode: ProfileIdentity["browser"]["mode"],
  values: IdentityDraftFieldValues,
  errors: IdentityDraftFieldErrors,
  baseBrowser: ProfileIdentity["browser"],
): ProfileIdentity["browser"] {
  if (mode === "real") {
    return { mode };
  }

  const baseClientHints: BrowserClientHints =
    "clientHints" in baseBrowser && baseBrowser.clientHints ? baseBrowser.clientHints : {};

  const userAgent = parseTextValue(values["browser.userAgent"], {
    path: "browser.userAgent",
    label: "User agent",
    maxLength: 512,
    required: true,
    errors,
  });
  const clientHints: BrowserClientHints = {};
  for (const path of [
    "browser.clientHints.platform",
    "browser.clientHints.platformVersion",
    "browser.clientHints.architecture",
    "browser.clientHints.bitness",
    "browser.clientHints.model",
  ] as const) {
    const value = parseTextValue(values[path], {
      path,
      label: descriptorLabel(path),
      maxLength: 80,
      required: false,
      errors,
    });
    const key = path.split(".").at(-1) as keyof Omit<BrowserClientHints, "mobile">;
    // Written when the user typed something, and also when the saved identity
    // already carried the key -- the sidecar accepts an empty platformVersion or
    // model, so dropping one silently rewrites a saved profile on any unrelated
    // edit. Only a key that was never there stays absent.
    if (value || baseClientHints[key] !== undefined) {
      clientHints[key] = value;
    }
  }
  if (values["browser.clientHints.mobile"] === "true") {
    clientHints.mobile = true;
  } else if (values["browser.clientHints.mobile"] === "false") {
    // false is a value, not an absence. Leaving it out let the runtime fall back
    // to navigator.uaMobile, which silently flips a profile that deliberately
    // said "not mobile" to mobile after a save that changed nothing else.
    clientHints.mobile = false;
  } else {
    errors["browser.clientHints.mobile"] = "Client hints mobile must be true or false.";
  }

  return compactOptionalFields({
    mode,
    userAgent,
    clientHints: Object.keys(clientHints).length > 0 ? clientHints : undefined,
  });
}

function buildNavigatorSurface(
  mode: ProfileIdentity["navigator"]["mode"],
  values: IdentityDraftFieldValues,
  errors: IdentityDraftFieldErrors,
): ProfileIdentity["navigator"] {
  if (mode === "real") {
    return { mode };
  }

  return {
    mode,
    platform: parseTextValue(values["navigator.platform"], {
      path: "navigator.platform",
      label: "Navigator platform",
      maxLength: 80,
      required: true,
      errors,
    }),
    hardwareConcurrency: parseIntegerValue(values["navigator.hardwareConcurrency"], {
      path: "navigator.hardwareConcurrency",
      label: "Hardware concurrency",
      min: 1,
      max: 128,
      errors,
    }),
    deviceMemory: parseNumberValue(values["navigator.deviceMemory"], {
      path: "navigator.deviceMemory",
      label: "Device memory",
      min: 0.25,
      max: 128,
      errors,
    }),
    uaPlatform: parseTextValue(values["navigator.uaPlatform"], {
      path: "navigator.uaPlatform",
      label: "UA platform",
      maxLength: 80,
      required: true,
      errors,
    }),
    uaPlatformVersion: parseTextValue(values["navigator.uaPlatformVersion"], {
      path: "navigator.uaPlatformVersion",
      label: "UA platform version",
      maxLength: 80,
      required: false,
      errors,
    }),
    uaArchitecture: parseTextValue(values["navigator.uaArchitecture"], {
      path: "navigator.uaArchitecture",
      label: "UA architecture",
      maxLength: 80,
      required: true,
      errors,
    }),
    uaMobile: parseBooleanValue(values["navigator.uaMobile"], "navigator.uaMobile", "UA mobile", errors),
  };
}

function buildScreenSurface(
  mode: ProfileIdentity["screen"]["mode"],
  values: IdentityDraftFieldValues,
  errors: IdentityDraftFieldErrors,
): ProfileIdentity["screen"] {
  if (mode === "real") {
    return { mode };
  }

  return {
    mode,
    width: parseIntegerValue(values["screen.width"], { path: "screen.width", label: "Screen width", min: 1, max: 10000, errors }),
    height: parseIntegerValue(values["screen.height"], { path: "screen.height", label: "Screen height", min: 1, max: 10000, errors }),
    viewportWidth: parseIntegerValue(values["screen.viewportWidth"], { path: "screen.viewportWidth", label: "Viewport width", min: 1, max: 10000, errors }),
    viewportHeight: parseIntegerValue(values["screen.viewportHeight"], { path: "screen.viewportHeight", label: "Viewport height", min: 1, max: 10000, errors }),
    colorDepth: parseIntegerValue(values["screen.colorDepth"], { path: "screen.colorDepth", label: "Color depth", min: 1, max: 64, errors }),
    pixelRatio: parseNumberValue(values["screen.pixelRatio"], { path: "screen.pixelRatio", label: "Pixel ratio", min: 0.25, max: 8, errors }),
  };
}

function buildLocaleSurface(
  mode: ProfileIdentity["locale"]["mode"],
  values: IdentityDraftFieldValues,
  errors: IdentityDraftFieldErrors,
): ProfileIdentity["locale"] {
  if (mode === "real") {
    return { mode };
  }

  const locale = parseLanguageTagValue(values["locale.locale"], "locale.locale", "Locale", errors);
  return {
    mode,
    locale,
    languages: parseLanguageListValue(values["locale.languages"], "locale.languages", errors),
    timezoneId: parseTimezoneValue(values["locale.timezoneId"], "locale.timezoneId", errors),
  };
}

function buildNoiseSurface(
  surface: "canvas" | "audio",
  mode: ProfileIdentity[typeof surface]["mode"],
  values: IdentityDraftFieldValues,
  errors: IdentityDraftFieldErrors,
): ProfileIdentity[typeof surface] {
  if (mode === "real") {
    return { mode };
  }

  const path = `${surface}.noiseSeed` as const;
  return {
    mode,
    noiseSeed: parseIntegerValue(values[path], {
      path,
      label: `${IDENTITY_SURFACE_LABELS[surface]} noise seed`,
      min: 0,
      max: 1_000_000,
      errors,
    }),
  };
}

function buildWebGlSurface(
  mode: ProfileIdentity["webgl"]["mode"],
  values: IdentityDraftFieldValues,
  errors: IdentityDraftFieldErrors,
): ProfileIdentity["webgl"] {
  if (mode === "real") {
    return { mode };
  }

  const noiseSeedText = values["webgl.noiseSeed"].trim();
  const noiseSeed = noiseSeedText
    ? parseIntegerValue(noiseSeedText, { path: "webgl.noiseSeed", label: "WebGL noise seed", min: 0, max: 1_000_000, errors })
    : undefined;

  return compactOptionalFields({
    mode,
    vendor: parseTextValue(values["webgl.vendor"], {
      path: "webgl.vendor",
      label: "WebGL vendor",
      maxLength: 512,
      required: true,
      errors,
    }),
    renderer: parseTextValue(values["webgl.renderer"], {
      path: "webgl.renderer",
      label: "WebGL renderer",
      maxLength: 512,
      required: true,
      errors,
    }),
    noiseSeed,
  });
}

function buildWebRtcSurface(
  mode: ProfileIdentity["webrtc"]["mode"],
  values: IdentityDraftFieldValues,
  errors: IdentityDraftFieldErrors,
): ProfileIdentity["webrtc"] {
  const policy = parseWebRtcPolicyValue(values["webrtc.policy"], errors);
  if (mode === "real" && policy !== "real") {
    errors["webrtc.policy"] = "WebRTC policy must be real when WebRTC mode is real.";
  }
  return { mode, policy };
}

function buildGeolocationSurface(
  mode: ProfileIdentity["geolocation"]["mode"],
  values: IdentityDraftFieldValues,
  errors: IdentityDraftFieldErrors,
): ProfileIdentity["geolocation"] {
  // The permission is carried in both modes: a profile that reports its real
  // position still has to say whether a page may ask for it.
  const permission = parseGeolocationPermissionValue(values["geolocation.permission"], errors);
  if (mode === "real") {
    return { mode, permission };
  }

  const altitudeText = values["geolocation.altitude"].trim();
  return {
    mode,
    permission,
    latitude: roundCoordinateValue(parseNumberValue(values["geolocation.latitude"], {
      path: "geolocation.latitude",
      label: "Latitude",
      min: -90,
      max: 90,
      errors,
    })),
    longitude: roundCoordinateValue(parseNumberValue(values["geolocation.longitude"], {
      path: "geolocation.longitude",
      label: "Longitude",
      min: -180,
      max: 180,
      errors,
    })),
    accuracy: parseIntegerValue(values["geolocation.accuracy"], {
      path: "geolocation.accuracy",
      label: "Accuracy",
      min: 1,
      max: 100_000,
      errors,
    }),
    altitude: altitudeText
      ? roundCoordinateValue(parseNumberValue(altitudeText, {
        path: "geolocation.altitude",
        label: "Altitude",
        min: -1_000,
        max: 100_000,
        errors,
      }))
      : null,
  };
}

function buildMediaDevicesSurface(
  mode: ProfileIdentity["mediaDevices"]["mode"],
  values: IdentityDraftFieldValues,
  errors: IdentityDraftFieldErrors,
): ProfileIdentity["mediaDevices"] {
  if (mode === "real") {
    return { mode };
  }
  if (mode === "masked") {
    return {
      mode,
      noiseSeed: parseIntegerValue(values["mediaDevices.noiseSeed"], {
        path: "mediaDevices.noiseSeed",
        label: "Media devices noise seed",
        min: 0,
        max: 1_000_000,
        errors,
      }),
    };
  }

  return {
    mode,
    videoInputs: parseIntegerValue(values["mediaDevices.videoInputs"], {
      path: "mediaDevices.videoInputs",
      label: "Video inputs",
      min: 0,
      max: 1,
      errors,
    }),
    audioInputs: parseIntegerValue(values["mediaDevices.audioInputs"], {
      path: "mediaDevices.audioInputs",
      label: "Audio inputs",
      min: 1,
      max: 4,
      errors,
    }),
    audioOutputs: parseIntegerValue(values["mediaDevices.audioOutputs"], {
      path: "mediaDevices.audioOutputs",
      label: "Audio outputs",
      min: 1,
      max: 4,
      errors,
    }),
  };
}

function buildPortsSurface(
  mode: ProfileIdentity["ports"]["mode"],
  values: IdentityDraftFieldValues,
  errors: IdentityDraftFieldErrors,
): ProfileIdentity["ports"] {
  if (mode !== "custom") {
    return { mode };
  }

  return { mode, allowedPorts: parseAllowedPortsValue(values["ports.allowedPorts"], errors) };
}

function seedIdentitySurface(
  surface: IdentitySurface,
  mode: IdentityModeValue,
  identity: ProfileIdentity,
  values: IdentityDraftFieldValues,
): ProfileIdentity[IdentitySurface] {
  if (surface === "browser") {
    if (mode === "real") {
      return { mode };
    }
    return buildBrowserSurface(mode as Exclude<IdentityMaskingMode, "real">, values, {}, { mode: "real" });
  }
  if (surface === "navigator") {
    if (mode === "real") {
      return { mode };
    }
    return buildNavigatorSurface(mode as Exclude<IdentityMaskingMode, "real">, values, {});
  }
  if (surface === "screen") {
    if (mode === "real") {
      return { mode };
    }
    return buildScreenSurface(mode as Exclude<IdentityMaskingMode, "real">, values, {});
  }
  if (surface === "locale") {
    if (mode === "real") {
      return { mode };
    }
    return buildLocaleSurface(mode as Exclude<IdentityMaskingMode, "real">, values, {});
  }
  if (surface === "canvas") {
    if (mode === "real") {
      return { mode };
    }
    return buildNoiseSurface("canvas", "noise", values, {});
  }
  if (surface === "audio") {
    if (mode === "real") {
      return { mode };
    }
    return buildNoiseSurface("audio", "noise", values, {});
  }
  if (surface === "webgl") {
    if (mode === "real") {
      return { mode };
    }
    return buildWebGlSurface(mode as Exclude<IdentityMaskingMode, "real">, values, {});
  }
  if (surface === "webrtc") {
    const previousPolicy = identity.webrtc.policy;
    return { mode: mode as IdentityMaskingMode, policy: mode === "real" ? "real" : previousPolicy };
  }
  if (surface === "geolocation") {
    return buildGeolocationSurface(mode as ProfileIdentity["geolocation"]["mode"], values, {});
  }
  if (surface === "mediaDevices") {
    return buildMediaDevicesSurface(mode as IdentityMaskingMode, values, {});
  }
  if (surface === "ports") {
    return buildPortsSurface(mode as IdentityMaskingMode, values, {});
  }

  return unsupportedIdentitySurface(surface);
}

function assignIdentitySurface(
  identity: ProfileIdentity,
  surface: IdentitySurface,
  value: ProfileIdentity[IdentitySurface],
): void {
  if (surface === "browser") {
    identity.browser = value as ProfileIdentity["browser"];
  } else if (surface === "navigator") {
    identity.navigator = value as ProfileIdentity["navigator"];
  } else if (surface === "screen") {
    identity.screen = value as ProfileIdentity["screen"];
  } else if (surface === "locale") {
    identity.locale = value as ProfileIdentity["locale"];
  } else if (surface === "canvas") {
    identity.canvas = value as ProfileIdentity["canvas"];
  } else if (surface === "audio") {
    identity.audio = value as ProfileIdentity["audio"];
  } else if (surface === "webgl") {
    identity.webgl = value as ProfileIdentity["webgl"];
  } else if (surface === "webrtc") {
    identity.webrtc = value as ProfileIdentity["webrtc"];
  } else if (surface === "geolocation") {
    identity.geolocation = value as ProfileIdentity["geolocation"];
  } else if (surface === "mediaDevices") {
    identity.mediaDevices = value as ProfileIdentity["mediaDevices"];
  } else if (surface === "ports") {
    identity.ports = value as ProfileIdentity["ports"];
  } else {
    unsupportedIdentitySurface(surface);
  }
}

function parseTextValue(
  value: string,
  options: {
    path: IdentityDraftFieldPath;
    label: string;
    maxLength: number;
    required: boolean;
    errors: IdentityDraftFieldErrors;
  },
): string {
  const text = value.trim();
  if (options.required && !text) {
    options.errors[options.path] = `${options.label} is required.`;
    return "";
  }
  // The sidecar counts code points, so a UTF-16 length here would reject
  // payloads it accepts and accept payloads it rejects.
  if (Array.from(text).length > options.maxLength || containsControlCharacters(text)) {
    options.errors[options.path] = `${options.label} must be ${options.maxLength} safe characters or fewer.`;
  }
  return text;
}

function parseIntegerValue(
  value: string,
  options: {
    path: Exclude<IdentityDraftFieldPath, "label">;
    label: string;
    min: number;
    max: number;
    errors: IdentityDraftFieldErrors;
  },
): number {
  const text = value.trim();
  const parsed = Number(text);
  if (!text || !Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || !Number.isInteger(parsed)) {
    options.errors[options.path] = `${options.label} must be a safe whole number.`;
    return options.min;
  }
  if (parsed < options.min || parsed > options.max) {
    options.errors[options.path] = `${options.label} must be between ${options.min} and ${options.max}.`;
  }
  return parsed;
}

function parseNumberValue(
  value: string,
  options: {
    path: Exclude<IdentityDraftFieldPath, "label">;
    label: string;
    min: number;
    max: number;
    errors: IdentityDraftFieldErrors;
  },
): number {
  const text = value.trim();
  const parsed = Number(text);
  if (!text || !Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) {
    options.errors[options.path] = `${options.label} must be a safe number.`;
    return options.min;
  }
  if (parsed < options.min || parsed > options.max) {
    options.errors[options.path] = `${options.label} must be between ${options.min} and ${options.max}.`;
  }
  return parsed;
}

function parseBooleanValue(
  value: string,
  path: Exclude<IdentityDraftFieldPath, "label">,
  label: string,
  errors: IdentityDraftFieldErrors,
): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  errors[path] = `${label} must be true or false.`;
  return false;
}

function parseLanguageTagValue(
  value: string,
  path: Exclude<IdentityDraftFieldPath, "label">,
  label: string,
  errors: IdentityDraftFieldErrors,
): string {
  const text = parseTextValue(value, { path, label, maxLength: 20, required: true, errors });
  if (text && !isLanguageTag(text)) {
    errors[path] = `${label} must be a valid BCP 47 language tag.`;
  }
  return text;
}

function parseLanguageListValue(
  value: string,
  path: Exclude<IdentityDraftFieldPath, "label">,
  errors: IdentityDraftFieldErrors,
): string[] {
  const rawItems = value.split(",").map((item) => item.trim());
  if (!value.trim() || rawItems.some((item) => !item)) {
    errors[path] = "Languages must be a non-empty comma-separated list without blank entries.";
    return [];
  }
  if (rawItems.length > 8) {
    errors[path] = "Languages supports at most 8 entries.";
  }
  for (const item of rawItems) {
    if (!isLanguageTag(item)) {
      errors[path] = "Languages must contain only valid BCP 47 language tags.";
      break;
    }
  }
  return rawItems;
}

function parseTimezoneValue(
  value: string,
  path: Exclude<IdentityDraftFieldPath, "label">,
  errors: IdentityDraftFieldErrors,
): string {
  const text = parseTextValue(value, { path, label: "Timezone ID", maxLength: 80, required: true, errors });
  if (text && !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(text)) {
    errors[path] = "Timezone ID must be UTC or an IANA timezone such as Europe/Berlin.";
  }
  return text;
}

function parseWebRtcPolicyValue(value: string, errors: IdentityDraftFieldErrors): WebRtcPolicy {
  if (value === "real" || value === "disableNonProxiedUdp" || value === "block") {
    return value;
  }
  errors["webrtc.policy"] = "WebRTC policy must be real, disable non-proxied UDP, or block.";
  return "real";
}

function parseGeolocationPermissionValue(
  value: string,
  errors: IdentityDraftFieldErrors,
): ProfileIdentity["geolocation"]["permission"] {
  if (value === "prompt" || value === "allow" || value === "block") {
    return value;
  }
  errors["geolocation.permission"] = "Geolocation permission must be prompt, allow, or block.";
  return "prompt";
}

function parseAllowedPortsValue(value: string, errors: IdentityDraftFieldErrors): number[] {
  const text = value.trim();
  if (!text) {
    return [];
  }

  const rawItems = text.split(",").map((item) => item.trim());
  if (rawItems.some((item) => !item)) {
    errors["ports.allowedPorts"] = "Allowed ports must be a comma-separated list without blank entries.";
    return [];
  }
  if (rawItems.length > MAX_ALLOWED_PORT_ENTRIES) {
    errors["ports.allowedPorts"] = `Allowed ports supports at most ${MAX_ALLOWED_PORT_ENTRIES} entries.`;
  }

  // Deduplicated and sorted the way the sidecar normalizes the list, so a saved
  // draft reads back as the user left it.
  const ports: number[] = [];
  for (const item of rawItems) {
    const parsed = Number(item);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
      errors["ports.allowedPorts"] = "Allowed ports must be whole numbers between 1 and 65535.";
      break;
    }
    if (!ports.includes(parsed)) {
      ports.push(parsed);
    }
  }
  return ports.sort((left, right) => left - right);
}

function roundCoordinateValue(value: number): number {
  return Number(value.toFixed(GEOLOCATION_COORDINATE_DECIMALS));
}

function descriptorLabel(path: Exclude<IdentityDraftFieldPath, "label">): string {
  return IDENTITY_DRAFT_FIELD_DESCRIPTORS.find((descriptor) => descriptor.path === path)?.label ?? path;
}

function formatIdentitySurfaceExpectedValues(identity: ProfileIdentity, surface: IdentitySurface): string {
  if (surface === "browser") {
    const value = identity.browser;
    return value.mode === "real" ? "real host browser values" : `${formatIdentityMode(value.mode)} UA ${value.userAgent}`;
  }
  if (surface === "navigator") {
    const value = identity.navigator;
    return value.mode === "real" ? "real host navigator values" : `${formatIdentityMode(value.mode)} ${value.platform}, ${value.hardwareConcurrency} cores, ${value.deviceMemory} GiB`;
  }
  if (surface === "screen") {
    const value = identity.screen;
    return value.mode === "real" ? "real host screen values" : `${formatIdentityMode(value.mode)} ${value.width}×${value.height}, viewport ${value.viewportWidth}×${value.viewportHeight}, DPR ${value.pixelRatio}`;
  }
  if (surface === "locale") {
    const value = identity.locale;
    return value.mode === "real" ? "real host locale values" : `${formatIdentityMode(value.mode)} ${value.locale}, ${value.languages.join("/")}, ${value.timezoneId}`;
  }
  if (surface === "canvas") {
    const value = identity.canvas;
    return value.mode === "real" ? "real host rendering values" : `Noise seed ${value.noiseSeed}`;
  }
  if (surface === "audio") {
    const value = identity.audio;
    return value.mode === "real" ? "real host rendering values" : `Noise seed ${value.noiseSeed}`;
  }
  if (surface === "webgl") {
    const value = identity.webgl;
    return value.mode === "real" ? "real host WebGL values" : `${formatIdentityMode(value.mode)} ${value.vendor} / ${value.renderer}`;
  }
  if (surface === "webrtc") {
    const value = identity.webrtc;
    return `${formatIdentityMode(value.mode)} WebRTC policy ${value.policy}`;
  }
  if (surface === "geolocation") {
    const value = identity.geolocation;
    return value.mode === "real"
      ? `real host position, permission ${value.permission}`
      : `${formatIdentityMode(value.mode)} ${value.latitude}, ${value.longitude} ±${value.accuracy} m, permission ${value.permission}`;
  }
  if (surface === "mediaDevices") {
    const value = identity.mediaDevices;
    if (value.mode === "real") {
      return "real host media devices";
    }
    return value.mode === "masked"
      ? `${formatIdentityMode(value.mode)} device labels, noise seed ${value.noiseSeed}`
      : `${formatIdentityMode(value.mode)} ${value.videoInputs} camera, ${value.audioInputs} microphone, ${value.audioOutputs} speaker`;
  }
  if (surface === "ports") {
    const value = identity.ports;
    if (value.mode === "real") {
      return "real host local port access";
    }
    return value.mode === "masked"
      ? `${formatIdentityMode(value.mode)} local port probes`
      : `${formatIdentityMode(value.mode)} allowed ports ${value.allowedPorts.length > 0 ? value.allowedPorts.join("/") : "none"}`;
  }

  return unsupportedIdentitySurface(surface);
}

function unsupportedIdentitySurface(surface: never): never {
  throw new Error(`Unsupported identity surface ${String(surface)}.`);
}

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

function isLanguageTag(value: string): boolean {
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value);
}

function compactOptionalFields<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
