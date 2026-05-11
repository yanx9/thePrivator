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
export type IdentityDraftFieldKind = "text" | "textarea" | "integer" | "number" | "boolean" | "language-list" | "webrtc-policy";
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
  | "webrtc.policy";

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
};

const MASKED_OR_CUSTOM: IdentityModeValue[] = ["masked", "custom"];
const NOISE_ONLY: IdentityModeValue[] = ["noise"];
const WEBRTC_MODES: IdentityModeValue[] = ["real", "masked", "custom"];

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
];

export function getSupportedIdentityModeOptions(surface: IdentitySurface): IdentityModeOption[] {
  return (NOISE_SURFACES.has(surface) ? NOISE_MODE_OPTIONS : MASKING_MODE_OPTIONS).map((option) => ({ ...option }));
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

  const identity: ProfileIdentity = {
    identityVersion: 1,
    label,
    presetId: baseIdentity.presetId,
    browser: buildBrowserSurface(baseIdentity.browser.mode, values, errors),
    navigator: buildNavigatorSurface(baseIdentity.navigator.mode, values, errors),
    screen: buildScreenSurface(baseIdentity.screen.mode, values, errors),
    locale: buildLocaleSurface(baseIdentity.locale.mode, values, errors),
    canvas: buildNoiseSurface("canvas", baseIdentity.canvas.mode, values, errors),
    audio: buildNoiseSurface("audio", baseIdentity.audio.mode, values, errors),
    webgl: buildWebGlSurface(baseIdentity.webgl.mode, values, errors),
    webrtc: buildWebRtcSurface(baseIdentity.webrtc.mode, values, errors),
  };

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, identity, errors: {} };
}

function buildBrowserSurface(
  mode: ProfileIdentity["browser"]["mode"],
  values: IdentityDraftFieldValues,
  errors: IdentityDraftFieldErrors,
): ProfileIdentity["browser"] {
  if (mode === "real") {
    return { mode };
  }

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
    if (value) {
      clientHints[key] = value;
    }
  }
  if (values["browser.clientHints.mobile"] === "true") {
    clientHints.mobile = true;
  } else if (values["browser.clientHints.mobile"] !== "false") {
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
    return buildBrowserSurface(mode as Exclude<IdentityMaskingMode, "real">, values, {});
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

  const previousPolicy = identity.webrtc.policy;
  return { mode: mode as IdentityMaskingMode, policy: mode === "real" ? "real" : previousPolicy };
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
  } else {
    identity.webrtc = value as ProfileIdentity["webrtc"];
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
  if (text.length > options.maxLength || containsControlCharacters(text)) {
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
  const value = identity.webrtc;
  return `${formatIdentityMode(value.mode)} WebRTC policy ${value.policy}`;
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
