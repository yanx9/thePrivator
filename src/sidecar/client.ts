import { invoke } from "@tauri-apps/api/core";
import type {
  AutomationApiEndpointSnapshot,
  AutomationApiErrorSnapshot,
  AutomationApiLifecycleStatus,
  AutomationApiProcessSnapshot,
  AutomationApiStatusResult,
  AutomationApiStatusSnapshot,
  AutomationApiTimingSnapshot,
  ChromiumLaunchResult,
  ChromiumLaunchSnapshot,
  ChromiumRunningProfileState,
  ChromiumStatusResult,
  ChromiumStatusSnapshot,
  ChromiumStopResult,
  ChromiumStoppedProfileState,
  ChromiumStopSnapshot,
  ChromiumTermination,
  CookieExportFormat,
  CookieExportResult,
  CookieExportSnapshot,
  CookiePortabilityWarning,
  CookieReplaceResult,
  CookieReplaceSnapshot,
  ProfilePackageExportResult,
  ProfilePackageExportSnapshot,
  ProfilePackageImportResult,
  ProfilePackageImportSnapshot,
  ProfilePackageWarning,
  DiagnosticEntry,
  DiagnosticEvent,
  DiagnosticLegacyContext,
  DiagnosticLogPath,
  DiagnosticLookupReason,
  DiagnosticLookupResult,
  DiagnosticSource,
  DiagnosticStatus,
  JsonScalar,
  JsonObject,
  JsonValue,
  BrowserClientHints,
  IdentityAuditCategory,
  IdentityAuditCollectResult,
  IdentityAuditCollectSnapshot,
  IdentityAuditCollectedRow,
  IdentityAuditExpectedRow,
  IdentityAuditOpenResult,
  IdentityAuditOpenSnapshot,
  IdentityAuditPage,
  IdentityAuditPageResult,
  IdentityAuditPlanCopy,
  IdentityAuditPlanResult,
  IdentityAuditPlanSnapshot,
  IdentityAuditSurface,
  IdentityMaskingMode,
  IdentityNoiseMode,
  IdentityPresetListResult,
  IdentityPresetListSnapshot,
  IdentitySurface,
  IdentityValidationResult,
  IdentityValidationSnapshot,
  IdentityWarning,
  ProfileIdentity,
  ProfileIdentityMutationSnapshot,
  ProfileLaunch,
  ProfileLifecycle,
  ProfileOrganization,
  ProfileProxyDraft,
  ProfileProxyMode,
  ProfileProxyMutationSnapshot,
  ProfileProxySummary,
  ProfileStartupBehavior,
  ProfileSync,
  ProxyCheckIpHiding,
  ProxyCheckPublicCheckerPage,
  ProxyCheckPublicCheckerSurface,
  ProxyCheckPublicCheckers,
  ProxyCheckResult,
  ProxyCheckRouteProof,
  ProxyCheckSnapshot,
  ProxyCheckWebRtc,
  ProxyCredentialState,
  ProxyProtocol,
  ProxyValidationResult,
  ProxyValidationSnapshot,
  WebRtcPolicy,
  LegacyImportCopyStatus,
  LegacyImportOutcome,
  LegacyImportOutcomeError,
  LegacyImportOutcomeStatus,
  LegacyImportResult,
  LegacyImportSelection,
  LegacyImportSnapshot,
  LegacyIssue,
  LegacyScanCandidate,
  LegacyScanResult,
  LegacyScanSnapshot,
  LegacyUserDataStatus,
  FingerprintMode,
  ProfileDefaults,
  ProfileListResult,
  ProfileListSnapshot,
  ProfileMutationResult,
  ProfileMutationSnapshot,
  ProfileRecord,
  ProfileStorage,
  SidecarClientError,
  SidecarCommandErrorEnvelope,
  SidecarCommandSuccessEnvelope,
  SidecarErrorSource,
  SidecarHealthPayload,
  SidecarHealthSnapshot,
} from "./types";
import { DIAGNOSTIC_RELATIVE_LOG_PATH, SIDECAR_BRIDGE_ERROR, SIDECAR_PROTOCOL_ERROR } from "./types";

const BRIDGE_ERROR_CODES = new Set([
  "SIDECAR_CONFIGURATION_ERROR",
  "SIDECAR_PROCESS_ERROR",
  "SIDECAR_PROTOCOL_ERROR",
  "SIDECAR_TIMEOUT",
  "SIDECAR_UNAVAILABLE",
]);

const IDENTITY_AUDIT_CATALOG = [
  {
    id: "browserleaks-client-hints",
    category: "browserleaks",
    url: "https://browserleaks.com/client-hints",
    surfaces: ["browser", "clientHints"],
    requiresUserAction: false,
  },
  {
    id: "browserleaks-javascript",
    category: "browserleaks",
    url: "https://browserleaks.com/javascript",
    surfaces: ["browser", "navigator", "screen", "locale"],
    requiresUserAction: false,
  },
  {
    id: "browserleaks-canvas",
    category: "browserleaks",
    url: "https://browserleaks.com/canvas",
    surfaces: ["canvas"],
    requiresUserAction: false,
  },
  {
    id: "browserleaks-webgl",
    category: "browserleaks",
    url: "https://browserleaks.com/webgl",
    surfaces: ["webgl"],
    requiresUserAction: false,
  },
  {
    id: "browserleaks-webrtc",
    category: "browserleaks",
    url: "https://browserleaks.com/webrtc",
    surfaces: ["webrtc"],
    requiresUserAction: false,
  },
  {
    id: "pixelscan-fingerprint-check",
    category: "consistency",
    url: "https://pixelscan.net/fingerprint-check",
    surfaces: ["browser", "clientHints", "navigator", "screen", "locale", "canvas", "webgl", "audio", "webrtc"],
    requiresUserAction: false,
  },
  {
    id: "browserscan-browser-checker",
    category: "consistency",
    url: "https://www.browserscan.net/browser-checker",
    surfaces: ["browser", "clientHints", "navigator", "screen", "locale", "canvas", "webgl", "webrtc"],
    requiresUserAction: false,
  },
  {
    id: "amiunique-fingerprint",
    category: "privacy",
    url: "https://amiunique.org/fingerprint",
    surfaces: ["browser", "clientHints", "navigator", "screen", "locale", "canvas", "webgl", "audio", "webrtc"],
    requiresUserAction: false,
  },
  {
    id: "cover-your-tracks",
    category: "privacy",
    url: "https://coveryourtracks.eff.org/",
    surfaces: ["browser", "clientHints", "navigator", "canvas", "webgl", "audio", "webrtc"],
    requiresUserAction: true,
  },
] as const;

const IDENTITY_AUDIT_CATALOG_BY_ID = new Map<string, (typeof IDENTITY_AUDIT_CATALOG)[number]>(
  IDENTITY_AUDIT_CATALOG.map((page) => [page.id, page]),
);

const PROXY_CHECK_PUBLIC_CATALOG = [
  {
    id: "cloudflare-trace",
    label: "Cloudflare trace",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    surfaces: ["ip"],
  },
  {
    id: "aws-checkip",
    label: "AWS checkip",
    url: "https://checkip.amazonaws.com/",
    surfaces: ["ip"],
  },
  {
    id: "webbrowsertools-webrtc",
    label: "WebRTC leak test",
    url: "https://webbrowsertools.com/webrtc-leak-test/",
    surfaces: ["webrtc"],
  },
] as const;

const PROXY_CHECK_PUBLIC_CATALOG_BY_ID = new Map<string, (typeof PROXY_CHECK_PUBLIC_CATALOG)[number]>(
  PROXY_CHECK_PUBLIC_CATALOG.map((page) => [page.id, page]),
);

const FORBIDDEN_PROXY_CHECK_FIELD_TOKENS = new Set([
  "auth",
  "authorization",
  "authcredentials",
  "binarypath",
  "body",
  "certificate",
  "certificatetrust",
  "checkercontent",
  "command",
  "content",
  "credential",
  "credentials",
  "debugport",
  "devtoolsactiveport",
  "executable",
  "executablepath",
  "extensiondir",
  "launchargs",
  "password",
  "path",
  "profiledir",
  "proxyauthorization",
  "proxypass",
  "proxypassword",
  "proxyuser",
  "proxyusername",
  "rawcheckercontent",
  "rawcontent",
  "rawtranscript",
  "remotedebuggingport",
  "responsebody",
  "runtimepath",
  "storeroot",
  "transcript",
  "username",
  "userdata",
  "userdatadir",
  "websocketdebuggerurl",
  "args",
  "argv",
]);

const FORBIDDEN_PROXY_CHECK_TEXT_MARKERS = [
  "proxy-authorization",
  "proxy_authorization",
  "proxy password",
  "proxypassword",
  "proxy-password",
  "proxy username",
  "proxyusername",
  "proxy-username",
  "authcredentials",
  "--proxy-server",
  "--user-data-dir",
  "--remote-debugging-port",
  "--load-extension",
  "devtoolsactiveport",
  "profile-store/",
  "traceback",
  "private key",
  "certificateTrust",
  "ws://",
  "wss://",
];

const FORBIDDEN_AUDIT_FIELDS = new Set([
  "pid",
  "userDataDir",
  "targetId",
  "targetID",
  "debugPort",
  "webSocketDebuggerUrl",
  "websocketDebuggerUrl",
  "storeRoot",
  "command",
  "args",
  "argv",
  "extensionDir",
  "configPath",
  "configBody",
  "devToolsActivePort",
  "DevToolsActivePort",
]);

const FORBIDDEN_PUBLIC_PROXY_FIELD_TOKENS = new Set([
  "auth",
  "authorization",
  "authcredentials",
  "binarypath",
  "command",
  "credential",
  "credentials",
  "debugport",
  "devtoolsactiveport",
  "executable",
  "executablepath",
  "launchargs",
  "password",
  "path",
  "proxyauthorization",
  "proxypass",
  "proxypassword",
  "proxyuser",
  "proxyusername",
  "remotedebuggingport",
  "username",
  "websocketdebuggerurl",
  "args",
  "argv",
]);

// launch.args is the single public profile path that legitimately carries a
// switch list, so it is exempted by path rather than by dropping the token: the
// same key name anywhere else in a profile record is still a leak.
const PUBLIC_PROFILE_FORBIDDEN_TOKEN_EXEMPT_PATHS = new Set(["launch.args"]);

const MAX_PROFILE_TAGS = 10;
const MAX_PROFILE_TAG_LENGTH = 32;
const MAX_PROFILE_NOTES_LENGTH = 1500;
const MAX_PROFILE_START_URLS = 10;
const MAX_PROFILE_START_URL_LENGTH = 2048;
const MAX_PROFILE_LAUNCH_ARGS = 20;
const MAX_PROFILE_LAUNCH_ARG_LENGTH = 256;
const MAX_PROFILE_DEVICE_ID_LENGTH = 64;

const PROFILE_IDENTITY_SURFACES = ["browser", "navigator", "screen", "locale", "canvas", "audio", "webgl", "webrtc"] as const;

const PROFILE_TAG_PATTERN = /^[\p{L}\p{N}_ -]+$/u;
const PROFILE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const PROFILE_FOLDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const FORBIDDEN_AUTOMATION_API_FIELD_TOKENS = new Set([
  "appdata",
  "appdatadir",
  "appdataroot",
  "args",
  "argv",
  "auth",
  "authorization",
  "bearer",
  "cdp",
  "cdpendpoint",
  "command",
  "credential",
  "credentials",
  "debug",
  "debugport",
  "devtools",
  "devtoolsactiveport",
  "diagnostics",
  "env",
  "environment",
  "launchargs",
  "path",
  "raw",
  "rawdiagnostics",
  "root",
  "stderr",
  "stdout",
  "store",
  "storeroot",
  "token",
  "userdata",
  "userdatadir",
  "websocket",
  "websocketdebuggerurl",
  "websocketurl",
]);

const FORBIDDEN_AUTOMATION_API_TEXT_MARKERS = [
  "authorization:",
  "authorization=",
  "bearer ",
  "cdp://",
  "devtoolsactiveport",
  "raw diagnostics",
  "rawdiagnostics",
  "stderr",
  "stdout",
  "store_root",
  "storeroot",
  "theprivator_automation_api_store_root",
  "theprivator_automation_api_token",
  "tpapi-",
  "--remote-debugging-port",
  "--user-data-dir",
  "ws://",
  "wss://",
];

const MAX_COOKIE_PORTABILITY_WARNINGS = 20;

const FORBIDDEN_COOKIE_PORTABILITY_FIELD_TOKENS = new Set([
  "appdata",
  "appdatadir",
  "appdataroot",
  "args",
  "argv",
  "command",
  "content",
  "cookie",
  "cookies",
  "cookiedb",
  "cookiedbpath",
  "cookiedomain",
  "cookiename",
  "cookievalue",
  "databasepath",
  "dbpath",
  "destinationpath",
  "devtoolsactiveport",
  "domain",
  "encryptedvalue",
  "hostkey",
  "launchargs",
  "name",
  "path",
  "profiledir",
  "raw",
  "rawcontent",
  "rawdiagnostics",
  "sourcepath",
  "stderr",
  "stdout",
  "store",
  "storeroot",
  "userdata",
  "userdatadir",
  "value",
  "websocketdebuggerurl",
]);

const FORBIDDEN_COOKIE_PORTABILITY_TEXT_MARKERS = [
  "--remote-debugging-port",
  "--user-data-dir",
  "cookie value",
  "cookie domain",
  "destination path",
  "devtoolsactiveport",
  "encrypted_value",
  "host_key",
  "profile-store/",
  "raw diagnostics",
  "rawdiagnostics",
  "selected path",
  "source path",
  "stderr",
  "stdout",
  "store_root",
  "storeroot",
  "userdata",
  "userdatadir",
  "user-data-dir",
  "value=",
  "ws://",
  "wss://",
];

const PROFILE_PACKAGE_FORMAT = "theprivator.profile-package";
const PROFILE_PACKAGE_VERSION = 1;
const MAX_PROFILE_PACKAGE_WARNINGS = 20;

const PROFILE_PACKAGE_PAYLOAD_SKIP_WARNING_CODES = new Set([
  "PACKAGE_EXPORT_DESTINATION_SKIPPED",
  "PACKAGE_PAYLOAD_COOKIE_DB_SKIPPED",
  "PACKAGE_PAYLOAD_RUNTIME_SKIPPED",
  "PACKAGE_PAYLOAD_SPECIAL_SKIPPED",
  "PACKAGE_PAYLOAD_UNREADABLE_SKIPPED",
]);

const FORBIDDEN_PROFILE_PACKAGE_FIELD_TOKENS = new Set([
  "appdata",
  "appdatadir",
  "appdataroot",
  "approot",
  "args",
  "argv",
  "auth",
  "authorization",
  "apitoken",
  "authcredentials",
  "automationapitoken",
  "bearer",
  "cdp",
  "cdpendpoint",
  "command",
  "content",
  "cookie",
  "cookiedb",
  "cookiedbpath",
  "cookiedomain",
  "cookiename",
  "cookievalue",
  "credentials",
  "debug",
  "debugendpoint",
  "debugport",
  "destinationpath",
  "devtools",
  "devtoolsactiveport",
  "diagnostics",
  "domain",
  "endpoint",
  "env",
  "environment",
  "encryptedvalue",
  "hostkey",
  "launchargs",
  "manifest",
  "member",
  "members",
  "name",
  "packagefiles",
  "packagemember",
  "packagemembers",
  "password",
  "path",
  "profiledir",
  "profilepath",
  "proxycredentials",
  "proxypassword",
  "proxyusername",
  "raw",
  "rawcontent",
  "rawdiagnostics",
  "rawmanifest",
  "root",
  "selectedpath",
  "sourcepath",
  "stack",
  "stacktrace",
  "stderr",
  "stdout",
  "store",
  "storeroot",
  "token",
  "traceback",
  "userdata",
  "userdatadir",
  "username",
  "value",
  "websocket",
  "websocketdebuggerurl",
  "websocketurl",
]);

const FORBIDDEN_PROFILE_PACKAGE_TEXT_MARKERS = [
  "--remote-debugging-port",
  "--user-data-dir",
  "api token",
  "authorization:",
  "authorization=",
  "authcredentials",
  "automation api token",
  "bearer ",
  "cdp://",
  "cookie domain",
  "cookie name",
  "cookie value",
  "credential",
  "credentials",
  "debug endpoint",
  "devtoolsactiveport",
  "encrypted_value",
  "host_key",
  "launch args",
  "launchargs",
  "manifest.json",
  "package member",
  "password",
  "profile dir",
  "profile-store/",
  "proxy-pass",
  "proxy-password",
  "proxy-user",
  "proxy-username",
  "proxypass",
  "proxypassword",
  "proxyuser",
  "proxyusername",
  "raw diagnostics",
  "raw manifest",
  "rawdiagnostics",
  "selected path",
  "source path",
  "stack trace",
  "stderr",
  "stdout",
  "store_root",
  "storeroot",
  "theprivator-cookies.json",
  "token=",
  "tpapi-",
  "traceback",
  "user data",
  "userdata",
  "userdatadir",
  "user-data-dir",
  "value=",
  "ws://",
  "wss://",
];

let detailCounter = 0;

export async function getSidecarHealth(): Promise<SidecarHealthSnapshot> {
  try {
    const envelope = await invoke<unknown>("sidecar_health");
    return parseHealthEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function triggerSidecarDiagnosticFailure(): Promise<never> {
  try {
    await invoke<unknown>("sidecar_diagnostic_failure");
    throw makeProtocolError("The diagnostic sidecar command unexpectedly returned success.");
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }

    throw normalizeSidecarError(error);
  }
}

export async function lookupDiagnosticDetail(detailRef: string): Promise<DiagnosticLookupResult> {
  try {
    const safeDetailRef = requireDetailRef(detailRef, "detailRef");
    const result = await invoke<unknown>("diagnostics_lookup", { detailRef: safeDetailRef });
    return parseDiagnosticLookupResult(result, safeDetailRef);
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }

    throw normalizeSidecarError(error);
  }
}

export async function listProfiles(): Promise<ProfileListSnapshot> {
  try {
    const envelope = await invoke<unknown>("profiles_list");
    return parseProfileListEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function createProfile(name: string): Promise<ProfileMutationSnapshot> {
  try {
    const envelope = await invoke<unknown>("profiles_create", { name });
    return parseProfileMutationEnvelope(envelope, new Date().toISOString(), {
      requireProfile: true,
      requireProfileInList: true,
      requireWarnings: false,
    });
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function updateProfile(id: string, name: string): Promise<ProfileMutationSnapshot> {
  try {
    const envelope = await invoke<unknown>("profiles_update", { id, name });
    return parseProfileMutationEnvelope(envelope, new Date().toISOString(), {
      requireProfile: true,
      requireProfileInList: true,
      requireWarnings: false,
    });
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function deleteProfile(id: string): Promise<ProfileMutationSnapshot> {
  try {
    const envelope = await invoke<unknown>("profiles_delete", { id });
    // Delete is a soft delete: the trashed record still comes back on profile,
    // but it is excluded from the refreshed profiles array.
    return parseProfileMutationEnvelope(envelope, new Date().toISOString(), {
      requireProfile: true,
      requireProfileInList: false,
      requireWarnings: false,
    });
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function listIdentityPresets(): Promise<IdentityPresetListSnapshot> {
  try {
    const envelope = await invoke<unknown>("identity_presets_list");
    return parseIdentityPresetListEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function validateIdentity(identity: ProfileIdentity): Promise<IdentityValidationSnapshot> {
  try {
    const envelope = await invoke<unknown>("identity_validate", { identity });
    return parseIdentityValidationEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function validateProxy(proxy: ProfileProxyDraft): Promise<ProxyValidationSnapshot> {
  try {
    const envelope = await invoke<unknown>("proxy_validate", { proxy });
    return parseProxyValidationEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function updateProfileProxy(
  profileId: string,
  proxy: ProfileProxyDraft,
): Promise<ProfileProxyMutationSnapshot> {
  try {
    const envelope = await invoke<unknown>("profiles_proxy_update", { profileId, proxy });
    const snapshot = parseProfileProxyMutationEnvelope(envelope, new Date().toISOString());
    if (snapshot.profile.id !== profileId) {
      throw makeProtocolError("The sidecar profile proxy update result did not match the requested profileId.");
    }
    return snapshot;
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function checkProfileProxy(profileId: string): Promise<ProxyCheckSnapshot> {
  try {
    const safeProfileId = requireProfileClientId(profileId, "profileId");
    const envelope = await invoke<unknown>("profiles_proxy_check", { profileId: safeProfileId });
    return parseProxyCheckEnvelope(envelope, new Date().toISOString(), safeProfileId);
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function exportProfileCookies(
  profileId: string,
  destinationPath: string,
  format: CookieExportFormat,
): Promise<CookieExportSnapshot> {
  try {
    const safeProfileId = requireProfileClientId(profileId, "profileId");
    const safeDestinationPath = requireDialogPathString(destinationPath, "destinationPath");
    const safeFormat = requireCookieExportFormat(format, "format");
    const envelope = await invoke<unknown>("profile_cookies_export", {
      profileId: safeProfileId,
      destinationPath: safeDestinationPath,
      format: safeFormat,
    });
    return parseCookieExportEnvelope(envelope, new Date().toISOString(), safeProfileId, safeFormat);
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function replaceProfileCookies(
  profileId: string,
  sourcePath: string,
): Promise<CookieReplaceSnapshot> {
  try {
    const safeProfileId = requireProfileClientId(profileId, "profileId");
    const safeSourcePath = requireDialogPathString(sourcePath, "sourcePath");
    const envelope = await invoke<unknown>("profile_cookies_replace", {
      profileId: safeProfileId,
      sourcePath: safeSourcePath,
    });
    return parseCookieReplaceEnvelope(envelope, new Date().toISOString(), safeProfileId);
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function exportProfilePackage(
  profileId: string,
  destinationPath: string,
): Promise<ProfilePackageExportSnapshot> {
  try {
    const safeProfileId = requireProfileClientId(profileId, "profileId");
    const safeDestinationPath = requireDialogPathString(destinationPath, "destinationPath");
    const envelope = await invoke<unknown>("profile_package_export", {
      profileId: safeProfileId,
      destinationPath: safeDestinationPath,
    });
    return parseProfilePackageExportEnvelope(envelope, new Date().toISOString(), safeProfileId);
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function importProfilePackage(sourcePath: string): Promise<ProfilePackageImportSnapshot> {
  try {
    const safeSourcePath = requireDialogPathString(sourcePath, "sourcePath");
    const envelope = await invoke<unknown>("profile_package_import", {
      sourcePath: safeSourcePath,
    });
    return parseProfilePackageImportEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function getIdentityAuditPlan(profileId: string): Promise<IdentityAuditPlanSnapshot> {
  try {
    const safeProfileId = requireAuditClientId(profileId, "profileId");
    const envelope = await invoke<unknown>("identity_audit_plan", { profileId: safeProfileId });
    return parseIdentityAuditPlanEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function openIdentityAuditPage(profileId: string, pageId: string): Promise<IdentityAuditOpenSnapshot> {
  try {
    const safeProfileId = requireAuditClientId(profileId, "profileId");
    const safePageId = requireAuditClientId(pageId, "pageId");
    const envelope = await invoke<unknown>("identity_audit_open", { profileId: safeProfileId, pageId: safePageId });
    return parseIdentityAuditOpenEnvelope(envelope, new Date().toISOString(), safeProfileId, safePageId);
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function collectIdentityAuditResults(profileId: string): Promise<IdentityAuditCollectSnapshot> {
  try {
    const safeProfileId = requireAuditClientId(profileId, "profileId");
    const envelope = await invoke<unknown>("identity_audit_collect", { profileId: safeProfileId });
    return parseIdentityAuditCollectEnvelope(envelope, new Date().toISOString(), safeProfileId);
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function applyProfileIdentityPreset(
  profileId: string,
  presetId: string,
): Promise<ProfileIdentityMutationSnapshot> {
  try {
    const envelope = await invoke<unknown>("profiles_identity_apply_preset", { profileId, presetId });
    const snapshot = parseProfileIdentityMutationEnvelope(envelope, new Date().toISOString());
    if (snapshot.profile.identity.presetId !== presetId) {
      throw makeProtocolError("The sidecar profile identity preset result did not match the requested presetId.");
    }
    return snapshot;
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function updateProfileIdentity(
  profileId: string,
  identity: ProfileIdentity,
): Promise<ProfileIdentityMutationSnapshot> {
  try {
    const envelope = await invoke<unknown>("profiles_identity_update", { profileId, identity });
    return parseProfileIdentityMutationEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function scanLegacyProfiles(legacyRoot: string): Promise<LegacyScanSnapshot> {
  try {
    const envelope = await invoke<unknown>("legacy_scan_profiles", { legacyRoot });
    return parseLegacyScanEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function importLegacyProfiles(
  legacyRoot: string,
  items: LegacyImportSelection[],
): Promise<LegacyImportSnapshot> {
  try {
    const envelope = await invoke<unknown>("legacy_import_profiles", { legacyRoot, items });
    return parseLegacyImportEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function startAutomationApi(): Promise<AutomationApiStatusSnapshot> {
  try {
    const snapshot = await invoke<unknown>("automation_api_start");
    return parseAutomationApiStatusSnapshot(snapshot, new Date().toISOString());
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function getAutomationApiStatus(): Promise<AutomationApiStatusSnapshot> {
  try {
    const snapshot = await invoke<unknown>("automation_api_status");
    return parseAutomationApiStatusSnapshot(snapshot, new Date().toISOString());
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function copyAutomationApiToken(): Promise<string> {
  try {
    const result = await invoke<unknown>("automation_api_copy_token");
    return parseAutomationApiTokenCopy(result);
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function stopAutomationApi(): Promise<AutomationApiStatusSnapshot> {
  try {
    const snapshot = await invoke<unknown>("automation_api_stop");
    return parseAutomationApiStatusSnapshot(snapshot, new Date().toISOString());
  } catch (error) {
    if (isSidecarClientError(error)) {
      throw error;
    }
    throw normalizeSidecarError(error);
  }
}

export async function getChromiumStatus(): Promise<ChromiumStatusSnapshot> {
  try {
    const envelope = await invoke<unknown>("chromium_status");
    return parseChromiumStatusEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function launchChromiumProfile(profileId: string): Promise<ChromiumLaunchSnapshot> {
  try {
    const envelope = await invoke<unknown>("chromium_launch", { profileId });
    return parseChromiumLaunchEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function stopChromiumProfile(profileId: string): Promise<ChromiumStopSnapshot> {
  try {
    const envelope = await invoke<unknown>("chromium_stop", { profileId });
    return parseChromiumStopEnvelope(envelope, new Date().toISOString());
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export function normalizeSidecarError(error: unknown): SidecarClientError {
  if (isCommandErrorEnvelope(error)) {
    const source = sourceForCode(error.code);
    return {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      detailRef: error.detailRef,
      source,
      phase: source === "sidecar" ? "recoverable-error" : "bridge-error",
    };
  }

  const message = extractErrorMessage(error);
  return {
    code: SIDECAR_BRIDGE_ERROR,
    message,
    recoverable: true,
    detailRef: makeDetailRef("bridge"),
    source: "bridge",
    phase: "bridge-error",
  };
}

function parseHealthEnvelope(value: unknown, checkedAt: string): SidecarHealthSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const health = parseHealthPayload(envelope.result);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    checkedAt,
    health,
  };
}

function parseDiagnosticLookupResult(value: unknown, requestedDetailRef: string): DiagnosticLookupResult {
  const record = requireRecord(value, "The diagnostics lookup response must be an object.");
  const found = requireBoolean(record.found, "diagnostics.found");
  const detailRef = requireDetailRef(record.detailRef, "diagnostics.detailRef");
  const reason = requireDiagnosticLookupReason(record.reason, "diagnostics.reason");
  const logPath = parseDiagnosticLogPath(record.logPath, "diagnostics.logPath");
  const entries = parseDiagnosticEntryArray(record.entries, detailRef);

  if (detailRef !== requestedDetailRef) {
    throw makeProtocolError("The diagnostics lookup response detailRef did not match the request.");
  }

  if (requestedDetailRef.startsWith("ui-")) {
    if (found || reason !== "ui-local" || logPath !== null || entries.length !== 0) {
      throw makeProtocolError("The diagnostics lookup response for a UI-local detailRef was malformed.");
    }
  } else if (reason === "ui-local" || reason === "invalid-detail-ref") {
    throw makeProtocolError("The diagnostics lookup response reason did not match the requested detailRef.");
  }

  if (found) {
    if (reason !== "found" || logPath !== DIAGNOSTIC_RELATIVE_LOG_PATH || entries.length === 0) {
      throw makeProtocolError("The diagnostics lookup found response was malformed.");
    }
  } else {
    if (entries.length !== 0) {
      throw makeProtocolError("The diagnostics lookup response included entries for a missing detailRef.");
    }
    if (reason === "found") {
      throw makeProtocolError("The diagnostics lookup response marked found without entries.");
    }
    if (reason === "not-persisted" && logPath !== DIAGNOSTIC_RELATIVE_LOG_PATH) {
      throw makeProtocolError("The diagnostics lookup not-persisted response must include the fixed log path.");
    }
    if (reason === "ui-local" && logPath !== null) {
      throw makeProtocolError("The diagnostics lookup no-log response must not include a log path.");
    }
  }

  return {
    found,
    detailRef,
    logPath,
    reason,
    entries,
  };
}

function parseDiagnosticEntryArray(value: unknown, lookupDetailRef: string): DiagnosticEntry[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError("The diagnostics lookup entries field must be an array.");
  }

  return value.map((entry, index) => parseDiagnosticEntry(entry, `entries[${index}]`, lookupDetailRef));
}

function parseDiagnosticEntry(value: unknown, field: string, lookupDetailRef: string): DiagnosticEntry {
  const record = requireRecord(value, `The diagnostics lookup field ${field} must be an object.`);
  requireLiteralNumber(record.schemaVersion, `${field}.schemaVersion`, 1);
  const ts = requireIsoTimestamp(record.ts, `${field}.ts`);
  const source = requireDiagnosticSource(record.source, `${field}.source`);
  const event = requireDiagnosticEvent(record.event, `${field}.event`);
  const status = requireDiagnosticStatus(record.status, `${field}.status`);
  const logPath = requireDiagnosticEntryLogPath(record.logPath, `${field}.logPath`);
  const detailRef = requireDetailRef(record.detailRef, `${field}.detailRef`);
  const errorCode = requireDiagnosticErrorCode(record.errorCode, `${field}.errorCode`);
  const requestId = record.requestId === undefined ? undefined : parseDiagnosticJsonScalar(record.requestId, `${field}.requestId`);
  const method = record.method === undefined ? undefined : requireSafeMethod(record.method, `${field}.method`);
  const durationMs = record.durationMs === undefined ? undefined : requireNonNegativeNumber(record.durationMs, `${field}.durationMs`);

  if (detailRef !== lookupDetailRef) {
    throw makeProtocolError(`The diagnostics lookup field ${field}.detailRef did not match the lookup detailRef.`);
  }

  const base = compactOptionalFields({
    schemaVersion: 1 as const,
    ts,
    source,
    event,
    status,
    logPath,
    requestId,
    method,
    durationMs,
    errorCode,
    detailRef,
  });

  if (source === "python-sidecar" && event === "sidecar.request" && status === "error") {
    if (!detailRef.startsWith("sidecar-")) {
      throw makeProtocolError(`The diagnostics lookup field ${field}.detailRef must be a sidecar detailRef.`);
    }
    if (record.context !== undefined) {
      throw makeProtocolError(`The diagnostics lookup field ${field}.context is not allowed for sidecar requests.`);
    }
    return base as DiagnosticEntry;
  }

  if (source === "python-sidecar" && event === "legacy.import.outcome" && (status === "partial" || status === "failed")) {
    if (!detailRef.startsWith("sidecar-")) {
      throw makeProtocolError(`The diagnostics lookup field ${field}.detailRef must be a sidecar detailRef.`);
    }
    const context = record.context === undefined ? undefined : parseDiagnosticLegacyContext(record.context, `${field}.context`);
    return compactOptionalFields({
      ...base,
      context,
    }) as DiagnosticEntry;
  }

  if (source === "rust-bridge" && event === "sidecar.bridge_failure" && status === "error") {
    if (!detailRef.startsWith("bridge-")) {
      throw makeProtocolError(`The diagnostics lookup field ${field}.detailRef must be a bridge detailRef.`);
    }
    if (record.context !== undefined) {
      throw makeProtocolError(`The diagnostics lookup field ${field}.context is not allowed for bridge failures.`);
    }
    const exitCode = record.exitCode === undefined ? undefined : parseDiagnosticExitCode(record.exitCode, `${field}.exitCode`);
    const stdoutLines = record.stdoutLines === undefined ? undefined : requireNonNegativeInteger(record.stdoutLines, `${field}.stdoutLines`);
    const stderrLines = record.stderrLines === undefined ? undefined : requireNonNegativeInteger(record.stderrLines, `${field}.stderrLines`);
    return compactOptionalFields({
      ...base,
      exitCode,
      stdoutLines,
      stderrLines,
    }) as DiagnosticEntry;
  }

  throw makeProtocolError(`The diagnostics lookup field ${field} has an invalid source/event/status combination.`);
}

function parseProfileListEnvelope(value: unknown, receivedAt: string): ProfileListSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseProfileListResult(envelope.result);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseProfileMutationEnvelope(
  value: unknown,
  receivedAt: string,
  options: { requireProfile: boolean; requireProfileInList: boolean; requireWarnings: boolean },
): ProfileMutationSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseProfileMutationResult(envelope.result, options);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseProfileIdentityMutationEnvelope(value: unknown, receivedAt: string): ProfileIdentityMutationSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseProfileMutationResult(envelope.result, {
    requireProfile: true,
    requireProfileInList: true,
    requireWarnings: true,
  });

  if (!result.profile || !result.warnings) {
    throw makeProtocolError("The sidecar profile identity mutation result is missing profile or warnings.");
  }

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
    profile: result.profile,
    warnings: result.warnings,
  };
}

function parseProfileProxyMutationEnvelope(value: unknown, receivedAt: string): ProfileProxyMutationSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseProfileMutationResult(envelope.result, {
    requireProfile: true,
    requireProfileInList: true,
    requireWarnings: false,
  });

  if (!result.profile) {
    throw makeProtocolError("The sidecar profile proxy mutation result is missing profile.");
  }

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
    profile: result.profile,
  };
}

function parseIdentityPresetListEnvelope(value: unknown, receivedAt: string): IdentityPresetListSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseIdentityPresetListResult(envelope.result);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseIdentityValidationEnvelope(value: unknown, receivedAt: string): IdentityValidationSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseIdentityValidationResult(envelope.result);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseProxyValidationEnvelope(value: unknown, receivedAt: string): ProxyValidationSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseProxyValidationResult(envelope.result);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseProxyCheckEnvelope(value: unknown, receivedAt: string, requestedProfileId: string): ProxyCheckSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseProxyCheckResult(envelope.result, requestedProfileId);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseCookieExportEnvelope(
  value: unknown,
  receivedAt: string,
  requestedProfileId: string,
  requestedFormat: CookieExportFormat,
): CookieExportSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseCookieExportResult(envelope.result, requestedProfileId, requestedFormat);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseCookieReplaceEnvelope(value: unknown, receivedAt: string, requestedProfileId: string): CookieReplaceSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseCookieReplaceResult(envelope.result, requestedProfileId);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseProfilePackageExportEnvelope(
  value: unknown,
  receivedAt: string,
  requestedProfileId: string,
): ProfilePackageExportSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseProfilePackageExportResult(envelope.result, requestedProfileId);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseProfilePackageImportEnvelope(value: unknown, receivedAt: string): ProfilePackageImportSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseProfilePackageImportResult(envelope.result);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseIdentityAuditPlanEnvelope(value: unknown, receivedAt: string): IdentityAuditPlanSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseIdentityAuditPlanResult(envelope.result);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseIdentityAuditOpenEnvelope(
  value: unknown,
  receivedAt: string,
  requestedProfileId: string,
  requestedPageId: string,
): IdentityAuditOpenSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseIdentityAuditOpenResult(envelope.result, requestedProfileId, requestedPageId);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseIdentityAuditCollectEnvelope(
  value: unknown,
  receivedAt: string,
  requestedProfileId: string,
): IdentityAuditCollectSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseIdentityAuditCollectResult(envelope.result, requestedProfileId);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseLegacyScanEnvelope(value: unknown, receivedAt: string): LegacyScanSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseLegacyScanResult(envelope.result);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseLegacyImportEnvelope(value: unknown, receivedAt: string): LegacyImportSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseLegacyImportResult(envelope.result);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseAutomationApiStatusSnapshot(value: unknown, receivedAt: string): AutomationApiStatusSnapshot {
  return {
    ...parseAutomationApiStatusResult(value),
    receivedAt,
  };
}

function parseAutomationApiStatusResult(value: unknown): AutomationApiStatusResult {
  const record = requireRecord(value, "The automation API lifecycle response must be an object.");
  assertNoForbiddenAutomationApiFields(record, "automationApi");
  requireAutomationApiKeys(
    record,
    ["status", "running", "api", "process", "copyAvailable", "lastTransitionAt", "lastError", "timings"],
    ["status", "running", "copyAvailable", "lastTransitionAt", "timings"],
    "automationApi",
  );

  const status = requireAutomationApiLifecycleStatus(record.status, "automationApi.status");
  const running = requireBoolean(record.running, "automationApi.running");
  const api = record.api === undefined || record.api === null ? null : parseAutomationApiEndpoint(record.api, "automationApi.api");
  const process = record.process === undefined || record.process === null ? null : parseAutomationApiProcess(record.process, "automationApi.process");
  const copyAvailable = requireBoolean(record.copyAvailable, "automationApi.copyAvailable");
  const lastError = record.lastError === undefined || record.lastError === null ? null : parseAutomationApiError(record.lastError, "automationApi.lastError");

  if ((status === "running") !== running) {
    throw makeProtocolError("The automation API lifecycle status and running flag disagreed.");
  }
  if (running && (!api || !process)) {
    throw makeProtocolError("The automation API running state must include loopback endpoint and process metadata.");
  }
  if (!running && (api || process || copyAvailable)) {
    throw makeProtocolError("The automation API stopped state must not expose endpoint, process, or copy availability.");
  }

  return {
    status,
    running,
    api,
    process,
    copyAvailable,
    lastTransitionAt: requireIsoTimestamp(record.lastTransitionAt, "automationApi.lastTransitionAt"),
    lastError,
    timings: parseAutomationApiTimings(record.timings, "automationApi.timings"),
  };
}

function parseAutomationApiEndpoint(value: unknown, field: string): AutomationApiEndpointSnapshot {
  const record = requireRecord(value, `The automation API field ${field} must be an object.`);
  assertNoForbiddenAutomationApiFields(record, field);
  requireAutomationApiKeys(record, ["host", "port", "url", "scope"], ["host", "port", "url", "scope"], field);
  const host = requireAutomationApiLoopbackHost(record.host, `${field}.host`);
  const port = requireProxyPort(record.port, `${field}.port`);
  const url = requireAutomationApiLoopbackUrl(record.url, host, port, `${field}.url`);
  return {
    host,
    port,
    url,
    scope: requireLiteral(record.scope, `${field}.scope`, "loopback"),
  };
}

function parseAutomationApiProcess(value: unknown, field: string): AutomationApiProcessSnapshot {
  const record = requireRecord(value, `The automation API field ${field} must be an object.`);
  assertNoForbiddenAutomationApiFields(record, field);
  requireAutomationApiKeys(record, ["pid", "startedAt"], ["pid", "startedAt"], field);
  return {
    pid: requirePositiveInteger(record.pid, `${field}.pid`),
    startedAt: requireIsoTimestamp(record.startedAt, `${field}.startedAt`),
  };
}

function parseAutomationApiError(value: unknown, field: string): AutomationApiErrorSnapshot {
  const record = requireRecord(value, `The automation API field ${field} must be an object.`);
  assertNoForbiddenAutomationApiFields(record, field);
  requireAutomationApiKeys(record, ["code", "message", "phase", "detailRef", "at", "durationMs"], ["code", "message", "phase", "detailRef", "at"], field);
  return compactOptionalFields({
    code: requireDiagnosticErrorCode(record.code, `${field}.code`),
    message: requireAutomationApiSafeText(record.message, `${field}.message`, { maxLength: 256 }),
    phase: requireAutomationApiErrorPhase(record.phase, `${field}.phase`),
    detailRef: requireDetailRef(record.detailRef, `${field}.detailRef`),
    at: requireIsoTimestamp(record.at, `${field}.at`),
    durationMs: record.durationMs === undefined ? undefined : requireNonNegativeNumber(record.durationMs, `${field}.durationMs`),
  });
}

function parseAutomationApiTimings(value: unknown, field: string): AutomationApiTimingSnapshot {
  const record = requireRecord(value, `The automation API field ${field} must be an object.`);
  assertNoForbiddenAutomationApiFields(record, field);
  requireAutomationApiKeys(record, ["readinessDurationMs", "stopDurationMs"], [], field);
  return compactOptionalFields({
    readinessDurationMs: record.readinessDurationMs === undefined ? undefined : requireNonNegativeNumber(record.readinessDurationMs, `${field}.readinessDurationMs`),
    stopDurationMs: record.stopDurationMs === undefined ? undefined : requireNonNegativeNumber(record.stopDurationMs, `${field}.stopDurationMs`),
  });
}

function parseAutomationApiTokenCopy(value: unknown): string {
  const record = requireRecord(value, "The automation API token copy response must be an object.");
  requireAutomationApiKeys(record, ["token"], ["token"], "automationApiTokenCopy");
  const token = requireString(record.token, "automationApiTokenCopy.token");
  if (!/^tpapi-[A-Za-z0-9._:-]{8,160}$/.test(token) || containsControlCharacters(token)) {
    throw makeProtocolError("The automation API token copy response did not contain a bounded token.");
  }
  return token;
}

function parseChromiumStatusEnvelope(value: unknown, receivedAt: string): ChromiumStatusSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseChromiumStatusResult(envelope.result);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseChromiumLaunchEnvelope(value: unknown, receivedAt: string): ChromiumLaunchSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseChromiumLaunchResult(envelope.result);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseChromiumStopEnvelope(value: unknown, receivedAt: string): ChromiumStopSnapshot {
  const envelope = parseSuccessEnvelope(value);
  const result = parseChromiumStopResult(envelope.result);

  return {
    requestId: formatRequestId(envelope.requestId),
    rawRequestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    bridgeDurationMs: envelope.durationMs,
    receivedAt,
    ...result,
  };
}

function parseSuccessEnvelope(value: unknown): SidecarCommandSuccessEnvelope {
  const record = requireRecord(value, "The Tauri bridge returned a non-object sidecar response.");
  const requestId = record.requestId;

  if (!isJsonScalar(requestId)) {
    throw makeProtocolError("The Tauri bridge response is missing requestId.");
  }

  const protocolVersion = requireString(record.protocolVersion, "protocolVersion");
  if (protocolVersion !== "1.0.0") {
    throw makeProtocolError("The Tauri bridge response used an unsupported protocolVersion.");
  }

  return {
    requestId,
    protocolVersion,
    durationMs: requireNumber(record.durationMs, "durationMs"),
    result: record.result,
  };
}

function parseHealthPayload(value: unknown): SidecarHealthPayload {
  const record = requireRecord(value, "The sidecar health result must be an object.");
  const product = requireRecord(record.product, "The sidecar health result is missing product metadata.");
  const sidecar = requireRecord(record.sidecar, "The sidecar health result is missing sidecar metadata.");
  const protocol = requireRecord(record.protocol, "The sidecar health result is missing protocol metadata.");
  const runtime = requireRecord(record.runtime, "The sidecar health result is missing runtime metadata.");
  const platform = requireRecord(record.platform, "The sidecar health result is missing platform metadata.");
  const build = requireRecord(record.build, "The sidecar health result is missing build metadata.");

  const request = record.request === undefined ? undefined : parseRequestTiming(record.request);
  const degradedFields =
    record.degradedFields === undefined ? undefined : parseStringArray(record.degradedFields, "degradedFields");

  return {
    status: requireString(record.status, "status"),
    product: {
      name: requireString(product.name, "product.name"),
      version: requireString(product.version, "product.version"),
    },
    sidecar: {
      version: requireString(sidecar.version, "sidecar.version"),
    },
    protocol: {
      version: requireString(protocol.version, "protocol.version"),
    },
    runtime: {
      pythonVersion: requireString(runtime.pythonVersion, "runtime.pythonVersion"),
      implementation: requireString(runtime.implementation, "runtime.implementation"),
    },
    platform: {
      system: requireString(platform.system, "platform.system"),
      release: requireString(platform.release, "platform.release"),
      machine: requireString(platform.machine, "platform.machine"),
    },
    build: {
      mode: requireString(build.mode, "build.mode"),
      frozen: requireBoolean(build.frozen, "build.frozen"),
    },
    request,
    degradedFields,
  };
}

function parseProfileListResult(value: unknown): ProfileListResult {
  const record = requireRecord(value, "The sidecar profile list result must be an object.");
  const storeVersion = requireStoreVersion(record.storeVersion);
  const profiles = parseProfileArray(record.profiles);
  const count = requireNonNegativeInteger(record.count, "count");

  if (count !== profiles.length) {
    throw makeProtocolError("The sidecar profile list count does not match the profiles array length.");
  }

  return {
    storeVersion,
    profiles,
    count,
  };
}

function parseProfileMutationResult(
  value: unknown,
  options: { requireProfile: boolean; requireProfileInList: boolean; requireWarnings: boolean },
): ProfileMutationResult {
  const record = requireRecord(value, "The sidecar profile mutation result must be an object.");
  const list = parseProfileListResult(record);
  const rawProfile = record.profile;
  const warnings = record.warnings === undefined ? undefined : parseIdentityWarningArray(record.warnings, "warnings");

  if (options.requireWarnings && warnings === undefined) {
    throw makeProtocolError("The sidecar profile identity mutation result is missing warnings.");
  }

  if (rawProfile === undefined) {
    if (options.requireProfile) {
      throw makeProtocolError("The sidecar profile mutation result is missing profile.");
    }

    return compactOptionalFields({
      ...list,
      warnings,
    });
  }

  const profile = parseProfileRecord(rawProfile);
  if (options.requireProfileInList && !list.profiles.some((item) => sameProfileRecord(item, profile))) {
    throw makeProtocolError("The sidecar profile mutation result profile is not present in the refreshed list.");
  }

  return compactOptionalFields({
    ...list,
    profile,
    warnings,
  });
}

function parseIdentityPresetListResult(value: unknown): IdentityPresetListResult {
  const record = requireRecord(value, "The sidecar identity preset list result must be an object.");
  requireLiteralNumber(record.identityVersion, "identityVersion", 1);
  const presets = parseIdentityArray(record.presets, "presets");
  const count = requireNonNegativeInteger(record.count, "count");

  if (count !== presets.length) {
    throw makeProtocolError("The sidecar identity preset count does not match the presets array length.");
  }

  const presetIds = new Set<string>();
  for (const [index, preset] of presets.entries()) {
    if (preset.presetId === null) {
      throw makeProtocolError(`The sidecar identity preset field presets[${index}].presetId must be present.`);
    }
    if (presetIds.has(preset.presetId)) {
      throw makeProtocolError("The sidecar identity preset list contains duplicate presetId values.");
    }
    presetIds.add(preset.presetId);
  }

  return {
    identityVersion: 1,
    presets,
    count,
  };
}

function parseIdentityValidationResult(value: unknown): IdentityValidationResult {
  const record = requireRecord(value, "The sidecar identity validation result must be an object.");
  requireLiteralNumber(record.identityVersion, "identityVersion", 1);
  return {
    identityVersion: 1,
    identity: parseProfileIdentity(record.identity, "identity"),
    warnings: parseIdentityWarningArray(record.warnings, "warnings"),
  };
}

function parseProxyValidationResult(value: unknown): ProxyValidationResult {
  const record = requireRecord(value, "The sidecar proxy validation result must be an object.");
  assertNoForbiddenPublicProxyFields(record, "proxyValidation");
  requirePublicKeys(record, ["proxyVersion", "proxy", "warnings"], ["proxyVersion", "proxy", "warnings"], "proxyValidation");
  requireLiteralNumber(record.proxyVersion, "proxyVersion", 1);
  const warnings = parseEmptyWarningArray(record.warnings, "warnings");

  return {
    proxyVersion: 1,
    proxy: parseProfileProxySummary(record.proxy, "proxy"),
    warnings,
  };
}

function parseProxyCheckResult(value: unknown, requestedProfileId: string): ProxyCheckResult {
  const record = requireRecord(value, "The sidecar proxy check result must be an object.");
  assertNoForbiddenProxyCheckFields(record, "proxyCheck");
  requireExactProxyCheckKeys(record, ["proxyCheckVersion", "profileId", "proxy", "routeProof", "ipHiding", "webRtc", "publicCheckers"], "proxyCheck");
  requireLiteralNumber(record.proxyCheckVersion, "proxyCheckVersion", 1);
  const profileId = requireProfileClientId(record.profileId, "profileId");
  if (profileId !== requestedProfileId) {
    throw makeProtocolError("The sidecar proxy check result did not match the requested profileId.");
  }

  return {
    proxyCheckVersion: 1,
    profileId,
    proxy: parseProfileProxySummary(record.proxy, "proxy"),
    routeProof: parseProxyCheckRouteProof(record.routeProof),
    ipHiding: parseProxyCheckIpHiding(record.ipHiding),
    webRtc: parseProxyCheckWebRtc(record.webRtc),
    publicCheckers: parseProxyCheckPublicCheckers(record.publicCheckers),
  };
}

function parseCookieExportResult(
  value: unknown,
  requestedProfileId: string,
  requestedFormat: CookieExportFormat,
): CookieExportResult {
  const record = requireRecord(value, "The sidecar cookie export result must be an object.");
  assertNoForbiddenCookiePortabilityFields(record, "cookieExport");
  requireExactCookiePortabilityKeys(
    record,
    ["portabilityVersion", "profileId", "operation", "format", "exportedCount", "skippedCount", "warningCount", "warnings"],
    "cookieExport",
  );
  requireLiteralNumber(record.portabilityVersion, "portabilityVersion", 1);
  const profileId = requireProfileClientId(record.profileId, "profileId");
  if (profileId !== requestedProfileId) {
    throw makeProtocolError("The sidecar cookie export result did not match the requested profileId.");
  }
  const operation = requireCookiePortabilityOperation(record.operation, "operation", "export");
  const format = requireCookieExportFormat(record.format, "format");
  if (format !== requestedFormat) {
    throw makeProtocolError("The sidecar cookie export result did not match the requested format.");
  }
  const exportedCount = requireNonNegativeSafeInteger(record.exportedCount, "exportedCount");
  const skippedCount = requireNonNegativeSafeInteger(record.skippedCount, "skippedCount");
  const warningCount = requireNonNegativeSafeInteger(record.warningCount, "warningCount");
  const warnings = parseCookiePortabilityWarnings(record.warnings, warningCount, "warnings");

  return {
    portabilityVersion: 1,
    profileId,
    operation,
    format,
    exportedCount,
    skippedCount,
    warningCount,
    warnings,
  };
}

function parseCookieReplaceResult(value: unknown, requestedProfileId: string): CookieReplaceResult {
  const record = requireRecord(value, "The sidecar cookie replace result must be an object.");
  assertNoForbiddenCookiePortabilityFields(record, "cookieReplace");
  requireExactCookiePortabilityKeys(
    record,
    [
      "portabilityVersion",
      "profileId",
      "operation",
      "format",
      "importedCount",
      "replacedCount",
      "skippedCount",
      "warningCount",
      "warnings",
    ],
    "cookieReplace",
  );
  requireLiteralNumber(record.portabilityVersion, "portabilityVersion", 1);
  const profileId = requireProfileClientId(record.profileId, "profileId");
  if (profileId !== requestedProfileId) {
    throw makeProtocolError("The sidecar cookie replace result did not match the requested profileId.");
  }
  const operation = requireCookiePortabilityOperation(record.operation, "operation", "replace");
  const format = requireCookieExportFormat(record.format, "format");
  const importedCount = requireNonNegativeSafeInteger(record.importedCount, "importedCount");
  const replacedCount = requireNonNegativeSafeInteger(record.replacedCount, "replacedCount");
  const skippedCount = requireNonNegativeSafeInteger(record.skippedCount, "skippedCount");
  const warningCount = requireNonNegativeSafeInteger(record.warningCount, "warningCount");
  const warnings = parseCookiePortabilityWarnings(record.warnings, warningCount, "warnings");

  if (replacedCount > importedCount) {
    throw makeProtocolError("The sidecar cookie replace result cannot replace more cookies than it imported.");
  }

  return {
    portabilityVersion: 1,
    profileId,
    operation,
    format,
    importedCount,
    replacedCount,
    skippedCount,
    warningCount,
    warnings,
  };
}

function parseProfilePackageExportResult(value: unknown, requestedProfileId: string): ProfilePackageExportResult {
  const record = requireRecord(value, "The sidecar profile package export result must be an object.");
  assertNoForbiddenProfilePackageFields(record, "profilePackageExport");
  requireExactProfilePackageKeys(
    record,
    [
      "packageVersion",
      "format",
      "operation",
      "profileId",
      "profileName",
      "cookieCount",
      "skippedCookieCount",
      "payloadFileCount",
      "payloadByteCount",
      "warningCount",
      "warnings",
    ],
    "profilePackageExport",
  );
  const packageVersion = requireProfilePackageVersion(record.packageVersion, "packageVersion");
  requireProfilePackageFormat(record.format, "format");
  const operation = requireProfilePackageOperation(record.operation, "operation", "export");
  const profileId = requireProfileClientId(record.profileId, "profileId");
  if (profileId !== requestedProfileId) {
    throw makeProtocolError("The sidecar profile package export result did not match the requested profileId.");
  }
  const profileName = requireProfilePackageSafeText(record.profileName, "profileName", { maxLength: 160 });
  const portableSessionCount = requireNonNegativeProfilePackageInteger(record.cookieCount, "cookieCount");
  requireNonNegativeProfilePackageInteger(record.skippedCookieCount, "skippedCookieCount");
  const payloadFileCount = requireNonNegativeProfilePackageInteger(record.payloadFileCount, "payloadFileCount");
  const payloadBytes = requireNonNegativeProfilePackageInteger(record.payloadByteCount, "payloadByteCount");
  const warningCount = requireNonNegativeProfilePackageInteger(record.warningCount, "warningCount");
  const warnings = parseProfilePackageWarnings(record.warnings, warningCount, "warnings");
  const payloadSkippedCount = countProfilePackagePayloadSkips(warnings);

  return {
    portabilityVersion: 1,
    packageVersion,
    operation,
    profileId,
    profileName,
    portableSessionCount,
    payloadFileCount,
    payloadBytes,
    payloadSkippedCount,
    warningCount,
    warnings,
  };
}

function parseProfilePackageImportResult(value: unknown): ProfilePackageImportResult {
  const record = requireRecord(value, "The sidecar profile package import result must be an object.");
  const publicRecord = withoutProfilePackageInternalFields(record);
  assertNoForbiddenProfilePackageFields(publicRecord, "profilePackageImport");
  requireExactProfilePackageKeys(
    record,
    [
      "packageVersion",
      "format",
      "operation",
      "profileId",
      "profileName",
      "nameConflictResolved",
      "profile",
      "cookieCount",
      "importedCookieCount",
      "replacedCookieCount",
      "payloadFileCount",
      "payloadByteCount",
      "warningCount",
      "warnings",
    ],
    "profilePackageImport",
  );
  const packageVersion = requireProfilePackageVersion(record.packageVersion, "packageVersion");
  requireProfilePackageFormat(record.format, "format");
  const operation = requireProfilePackageOperation(record.operation, "operation", "import");
  const importedProfileId = requireProfileClientId(record.profileId, "profileId");
  const importedProfileName = requireProfilePackageSafeText(record.profileName, "profileName", { maxLength: 160 });
  parseProfilePackageInternalProfileReference(record.profile, importedProfileId, importedProfileName);
  const nameConflictResolved = requireBoolean(record.nameConflictResolved, "nameConflictResolved");
  const portableSessionCount = requireNonNegativeProfilePackageInteger(record.cookieCount, "cookieCount");
  const importedCookieCount = requireNonNegativeProfilePackageInteger(record.importedCookieCount, "importedCookieCount");
  const replacedCookieCount = requireNonNegativeProfilePackageInteger(record.replacedCookieCount, "replacedCookieCount");
  const payloadFileCount = requireNonNegativeProfilePackageInteger(record.payloadFileCount, "payloadFileCount");
  const payloadBytes = requireNonNegativeProfilePackageInteger(record.payloadByteCount, "payloadByteCount");
  const warningCount = requireNonNegativeProfilePackageInteger(record.warningCount, "warningCount");
  const warnings = parseProfilePackageWarnings(record.warnings, warningCount, "warnings");
  const payloadSkippedCount = countProfilePackagePayloadSkips(warnings);

  if (importedCookieCount > portableSessionCount) {
    throw makeProtocolError("The sidecar profile package import result imported more portable sessions than the package reported.");
  }
  if (replacedCookieCount > importedCookieCount) {
    throw makeProtocolError("The sidecar profile package import result replaced more sessions than it imported.");
  }

  return {
    portabilityVersion: 1,
    packageVersion,
    operation,
    importedProfileId,
    importedProfileName,
    nameConflictResolved,
    portableSessionCount,
    payloadFileCount,
    payloadBytes,
    payloadSkippedCount,
    warningCount,
    warnings,
  };
}

function parseProfilePackageWarnings(
  value: unknown,
  expectedWarningCount: number,
  field: string,
): ProfilePackageWarning[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError(`The sidecar profile package field ${field} must be an array.`);
  }
  if (value.length > MAX_PROFILE_PACKAGE_WARNINGS) {
    throw makeProtocolError(`The sidecar profile package field ${field} exceeded the bounded warning count.`);
  }
  if (value.length !== expectedWarningCount) {
    throw makeProtocolError(`The sidecar profile package field ${field} length must match warningCount.`);
  }
  const seenCodes = new Set<string>();
  return value.map((item, index) => parseProfilePackageWarning(item, `${field}[${index}]`, seenCodes));
}

function parseProfilePackageWarning(
  value: unknown,
  field: string,
  seenCodes: Set<string>,
): ProfilePackageWarning {
  const record = requireRecord(value, `The sidecar profile package field ${field} must be an object.`);
  assertNoForbiddenProfilePackageFields(record, field);
  requireExactProfilePackageKeys(record, ["code", "message", "count"], field);
  const code = requireDiagnosticErrorCode(record.code, `${field}.code`);
  if (seenCodes.has(code)) {
    throw makeProtocolError(`The sidecar profile package field ${field}.code must be unique.`);
  }
  seenCodes.add(code);
  return {
    code,
    message: requireProfilePackageSafeText(record.message, `${field}.message`, { maxLength: 256 }),
    count: requirePositiveProfilePackageInteger(record.count, `${field}.count`),
  };
}

function countProfilePackagePayloadSkips(warnings: ProfilePackageWarning[]): number {
  let total = 0;
  for (const warning of warnings) {
    if (!PROFILE_PACKAGE_PAYLOAD_SKIP_WARNING_CODES.has(warning.code)) {
      continue;
    }
    total += warning.count;
    if (!Number.isSafeInteger(total)) {
      throw makeProtocolError("The sidecar profile package payload skipped count exceeded safe integer bounds.");
    }
  }
  return total;
}

function parseProfilePackageInternalProfileReference(
  value: unknown,
  expectedProfileId: string,
  expectedProfileName: string,
): void {
  const record = requireRecord(value, "The sidecar profile package import profile reference must be an object.");
  const profileId = requireProfileClientId(record.id, "profile.id");
  const profileName = requireProfilePackageSafeText(record.name, "profile.name", { maxLength: 160 });
  if (profileId !== expectedProfileId || profileName !== expectedProfileName) {
    throw makeProtocolError("The sidecar profile package import profile reference did not match the aggregate result.");
  }
}

function withoutProfilePackageInternalFields(record: Record<string, unknown>): Record<string, unknown> {
  const { profile: _profile, ...publicRecord } = record;
  return publicRecord;
}

function parseCookiePortabilityWarnings(
  value: unknown,
  expectedWarningCount: number,
  field: string,
): CookiePortabilityWarning[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError(`The sidecar cookie portability field ${field} must be an array.`);
  }
  if (value.length > MAX_COOKIE_PORTABILITY_WARNINGS) {
    throw makeProtocolError(`The sidecar cookie portability field ${field} exceeded the bounded warning count.`);
  }
  if (value.length !== expectedWarningCount) {
    throw makeProtocolError(`The sidecar cookie portability field ${field} length must match warningCount.`);
  }
  const seenCodes = new Set<string>();
  return value.map((item, index) => parseCookiePortabilityWarning(item, `${field}[${index}]`, seenCodes));
}

function parseCookiePortabilityWarning(
  value: unknown,
  field: string,
  seenCodes: Set<string>,
): CookiePortabilityWarning {
  const record = requireRecord(value, `The sidecar cookie portability field ${field} must be an object.`);
  assertNoForbiddenCookiePortabilityFields(record, field);
  requireExactCookiePortabilityKeys(record, ["code", "message", "count"], field);
  const code = requireDiagnosticErrorCode(record.code, `${field}.code`);
  if (seenCodes.has(code)) {
    throw makeProtocolError(`The sidecar cookie portability field ${field}.code must be unique.`);
  }
  seenCodes.add(code);
  return {
    code,
    message: requireCookiePortabilitySafeText(record.message, `${field}.message`, { maxLength: 256 }),
    count: requirePositiveSafeInteger(record.count, `${field}.count`),
  };
}

function parseProxyCheckRouteProof(value: unknown): ProxyCheckRouteProof {
  const record = requireRecord(value, "The sidecar proxy check routeProof result must be an object.");
  assertNoForbiddenProxyCheckFields(record, "routeProof");
  requireExactProxyCheckKeys(
    record,
    ["status", "basis", "scope", "protocol", "credentialState", "durationMs", "fixture", "target", "directFallbackDetected", "observationCounts"],
    "routeProof",
  );
  const status = requireProxyCheckRouteProofStatus(record.status, "routeProof.status");
  const basis = requireProxyCheckRouteProofBasis(record.basis, "routeProof.basis");
  const scope = requireProxyCheckScope(record.scope, "routeProof.scope");
  const protocol = record.protocol === null ? null : requireProxyProtocol(record.protocol, "routeProof.protocol");
  const credentialState = requireProxyCredentialState(record.credentialState, "routeProof.credentialState");
  const durationMs = requireNonNegativeNumber(record.durationMs, "routeProof.durationMs");
  const fixture = parseProxyCheckFixture(record.fixture, protocol, status);
  const target = parseProxyCheckTarget(record.target, status);
  const directFallbackDetected = requireLiteralBoolean(record.directFallbackDetected, "routeProof.directFallbackDetected", false);
  const observationCounts = parseProxyCheckObservationCounts(record.observationCounts, status);

  if (status === "not-run") {
    if (basis !== "direct-profile" || scope !== "not-applicable" || protocol !== null || fixture !== null || target !== null || durationMs !== 0) {
      throw makeProtocolError("The sidecar proxy check direct routeProof result was malformed.");
    }
  } else if (basis !== "sidecar-managed-local-fixture" || scope !== "local-fixture" || protocol === null || fixture === null || target === null) {
    throw makeProtocolError("The sidecar proxy check proved routeProof result was malformed.");
  }

  return {
    status,
    basis,
    scope,
    protocol,
    credentialState,
    durationMs,
    fixture,
    target,
    directFallbackDetected,
    observationCounts,
  };
}

function parseProxyCheckFixture(value: unknown, routeProtocol: ProxyProtocol | null, status: string): ProxyCheckRouteProof["fixture"] {
  if (status === "not-run") {
    if (value !== null) {
      throw makeProtocolError("The sidecar proxy check routeProof.fixture must be null for direct profiles.");
    }
    return null;
  }

  const record = requireRecord(value, "The sidecar proxy check routeProof.fixture must be an object.");
  assertNoForbiddenProxyCheckFields(record, "routeProof.fixture");
  requireExactProxyCheckKeys(record, ["kind", "managed"], "routeProof.fixture");
  const kind = requireProxyProtocol(record.kind, "routeProof.fixture.kind");
  if (routeProtocol !== null && kind !== routeProtocol) {
    throw makeProtocolError("The sidecar proxy check routeProof.fixture.kind must match routeProof.protocol.");
  }
  return {
    kind,
    managed: requireLiteralBoolean(record.managed, "routeProof.fixture.managed", true),
  };
}

function parseProxyCheckTarget(value: unknown, status: string): ProxyCheckRouteProof["target"] {
  if (status === "not-run") {
    if (value !== null) {
      throw makeProtocolError("The sidecar proxy check routeProof.target must be null for direct profiles.");
    }
    return null;
  }

  const record = requireRecord(value, "The sidecar proxy check routeProof.target must be an object.");
  assertNoForbiddenProxyCheckFields(record, "routeProof.target");
  requireExactProxyCheckKeys(record, ["host", "port"], "routeProof.target");
  return {
    host: requireProxyCheckHost(record.host, "routeProof.target.host"),
    port: requireProxyPort(record.port, "routeProof.target.port"),
  };
}

function parseProxyCheckObservationCounts(value: unknown, status: string): ProxyCheckRouteProof["observationCounts"] {
  const record = requireRecord(value, "The sidecar proxy check routeProof.observationCounts must be an object.");
  requireExactProxyCheckKeys(record, ["proxy", "target"], "routeProof.observationCounts");
  const counts = {
    proxy: requireNonNegativeInteger(record.proxy, "routeProof.observationCounts.proxy"),
    target: requireNonNegativeInteger(record.target, "routeProof.observationCounts.target"),
  };
  if (status === "not-run") {
    if (counts.proxy !== 0 || counts.target !== 0) {
      throw makeProtocolError("The sidecar proxy check direct routeProof observation counts must be zero.");
    }
  } else if (counts.proxy < 1 || counts.target < 1) {
    throw makeProtocolError("The sidecar proxy check proved routeProof observation counts must be positive.");
  }
  return counts;
}

function parseProxyCheckIpHiding(value: unknown): ProxyCheckIpHiding {
  const record = requireRecord(value, "The sidecar proxy check ipHiding result must be an object.");
  assertNoForbiddenProxyCheckFields(record, "ipHiding");
  requireExactProxyCheckKeys(record, ["status", "basis", "scope", "publicExitIpClaimed", "publicExitIp", "publicExitLocation", "localFixtureConclusion"], "ipHiding");
  const status = requireProxyCheckIpHidingStatus(record.status, "ipHiding.status");
  const basis = requireProxyCheckIpHidingBasis(record.basis, "ipHiding.basis");
  const scope = requireProxyCheckScope(record.scope, "ipHiding.scope");
  const publicExitIpClaimed = requireBoolean(record.publicExitIpClaimed, "ipHiding.publicExitIpClaimed");
  const publicExitIp = record.publicExitIp === null ? null : requireProxyCheckSafeText(record.publicExitIp, "ipHiding.publicExitIp", { maxLength: 64 });
  const publicExitLocation = parseProxyCheckPublicExitLocation(record.publicExitLocation);
  const localFixtureConclusion = requireProxyCheckLocalFixtureConclusion(record.localFixtureConclusion, "ipHiding.localFixtureConclusion");

  if (publicExitIpClaimed !== Boolean(publicExitIp)) {
    throw makeProtocolError("The sidecar proxy check public exit IP claim was malformed.");
  }
  if (publicExitLocation !== null && publicExitIp === null) {
    throw makeProtocolError("The sidecar proxy check public exit location requires a public exit IP.");
  }

  if (status === "not-proven") {
    if (basis !== "direct-profile" || scope !== "not-applicable" || localFixtureConclusion !== "not-run") {
      throw makeProtocolError("The sidecar proxy check direct ipHiding result was malformed.");
    }
  } else if (basis !== "route-proof-succeeded" || scope !== "local-fixture" || localFixtureConclusion !== "direct target IP hidden from the proof target by the managed fixture") {
    throw makeProtocolError("The sidecar proxy check proved ipHiding result was malformed.");
  }

  return {
    status,
    basis,
    scope,
    publicExitIpClaimed,
    publicExitIp,
    publicExitLocation,
    localFixtureConclusion,
  };
}

function parseProxyCheckPublicExitLocation(value: unknown): ProxyCheckIpHiding["publicExitLocation"] {
  if (value === null) {
    return null;
  }
  const record = requireRecord(value, "The sidecar proxy check public exit location must be null or an object.");
  assertNoForbiddenProxyCheckFields(record, "ipHiding.publicExitLocation");
  requireExactProxyCheckKeys(record, ["country", "region", "city", "timezone", "isp"], "ipHiding.publicExitLocation");
  return {
    country: record.country === null ? null : requireProxyCheckSafeText(record.country, "ipHiding.publicExitLocation.country", { maxLength: 128 }),
    region: record.region === null ? null : requireProxyCheckSafeText(record.region, "ipHiding.publicExitLocation.region", { maxLength: 128 }),
    city: record.city === null ? null : requireProxyCheckSafeText(record.city, "ipHiding.publicExitLocation.city", { maxLength: 128 }),
    timezone: record.timezone === null ? null : requireProxyCheckSafeText(record.timezone, "ipHiding.publicExitLocation.timezone", { maxLength: 128 }),
    isp: record.isp === null ? null : requireProxyCheckSafeText(record.isp, "ipHiding.publicExitLocation.isp", { maxLength: 128 }),
  };
}

function parseProxyCheckWebRtc(value: unknown): ProxyCheckWebRtc {
  const record = requireRecord(value, "The sidecar proxy check webRtc result must be an object.");
  assertNoForbiddenProxyCheckFields(record, "webRtc");
  requireExactProxyCheckKeys(record, ["status", "basis", "mode", "policy", "localIpExposure"], "webRtc");
  const status = requireProxyCheckWebRtcStatus(record.status, "webRtc.status");
  const basis = requireLiteral(record.basis, "webRtc.basis", "profile-identity-policy");
  const mode = requireIdentityMaskingMode(record.mode, "webRtc.mode");
  const policy = requireWebRtcPolicy(record.policy, "webRtc.policy");
  const localIpExposure = requireProxyCheckWebRtcExposure(record.localIpExposure, "webRtc.localIpExposure");

  if (status === "baseline-real") {
    if (mode !== "real" || policy !== "real" || localIpExposure !== "real-local-ip-baseline") {
      throw makeProtocolError("The sidecar proxy check baseline WebRTC result was malformed.");
    }
  } else if (policy === "real" || (localIpExposure !== "blocked" && localIpExposure !== "non-proxied-udp-disabled")) {
    throw makeProtocolError("The sidecar proxy check restricted WebRTC result was malformed.");
  }
  if (policy === "block" && localIpExposure !== "blocked") {
    throw makeProtocolError("The sidecar proxy check blocked WebRTC result was malformed.");
  }
  if (policy === "disableNonProxiedUdp" && localIpExposure !== "non-proxied-udp-disabled") {
    throw makeProtocolError("The sidecar proxy check disableNonProxiedUdp result was malformed.");
  }

  return {
    status,
    basis,
    mode,
    policy,
    localIpExposure,
  };
}

function parseProxyCheckPublicCheckers(value: unknown): ProxyCheckPublicCheckers {
  const record = requireRecord(value, "The sidecar proxy check publicCheckers result must be an object.");
  assertNoForbiddenProxyCheckFields(record, "publicCheckers");
  requireExactProxyCheckKeys(record, ["status", "basis", "networkDependency", "pages"], "publicCheckers");
  const status = requireLiteral(record.status, "publicCheckers.status", "advisory-only");
  const basis = requireLiteral(record.basis, "publicCheckers.basis", "fixed-https-allowlist");
  const networkDependency = requireLiteral(record.networkDependency, "publicCheckers.networkDependency", "user-driven-external-pages");
  const pages = parseProxyCheckPublicCheckerPages(record.pages);
  return {
    status,
    basis,
    networkDependency,
    pages,
  };
}

function parseProxyCheckPublicCheckerPages(value: unknown): ProxyCheckPublicCheckerPage[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError("The sidecar proxy check publicCheckers.pages field must be an array.");
  }
  if (value.length !== PROXY_CHECK_PUBLIC_CATALOG.length) {
    throw makeProtocolError("The sidecar proxy check public checker catalog count does not match the fixed catalog.");
  }
  const seen = new Set<string>();
  const pages = value.map((item, index) => {
    const page = parseProxyCheckPublicCheckerPage(item, `publicCheckers.pages[${index}]`);
    if (seen.has(page.id)) {
      throw makeProtocolError("The sidecar proxy check public checker catalog contains duplicate page ids.");
    }
    seen.add(page.id);
    return page;
  });
  for (const expected of PROXY_CHECK_PUBLIC_CATALOG) {
    if (!seen.has(expected.id)) {
      throw makeProtocolError("The sidecar proxy check public checker catalog is missing a fixed page id.");
    }
  }
  return pages;
}

function parseProxyCheckPublicCheckerPage(value: unknown, field: string): ProxyCheckPublicCheckerPage {
  const record = requireRecord(value, `The sidecar proxy check field ${field} must be an object.`);
  assertNoForbiddenProxyCheckFields(record, field);
  requireExactProxyCheckKeys(record, ["id", "label", "url", "surfaces", "advisory"], field);
  const id = requireProxyCheckPublicCheckerId(record.id, `${field}.id`);
  const expected = PROXY_CHECK_PUBLIC_CATALOG_BY_ID.get(id);
  if (!expected) {
    throw makeProtocolError(`The sidecar proxy check field ${field}.id is not in the fixed catalog.`);
  }
  const surfaces = parseProxyCheckPublicCheckerSurfaces(record.surfaces, `${field}.surfaces`);
  if (record.label !== expected.label || record.url !== expected.url || !sameStringArray(surfaces, [...expected.surfaces])) {
    throw makeProtocolError(`The sidecar proxy check field ${field} does not match fixed catalog metadata.`);
  }
  return {
    id,
    label: requireProxyCheckSafeText(record.label, `${field}.label`, { maxLength: 128 }),
    url: requireProxyCheckPublicCheckerUrl(record.url, expected.url, `${field}.url`),
    surfaces,
    advisory: requireProxyCheckSafeText(record.advisory, `${field}.advisory`, { maxLength: 256 }),
  };
}

function parseProxyCheckPublicCheckerSurfaces(value: unknown, field: string): ProxyCheckPublicCheckerSurface[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    throw makeProtocolError(`The sidecar proxy check field ${field} must be a bounded non-empty array.`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const surface = requireProxyCheckPublicCheckerSurface(item, `${field}[${index}]`);
    if (seen.has(surface)) {
      throw makeProtocolError(`The sidecar proxy check field ${field} contains duplicate surfaces.`);
    }
    seen.add(surface);
    return surface;
  });
}

function parseIdentityAuditPlanResult(value: unknown): IdentityAuditPlanResult {
  const record = requireRecord(value, "The sidecar identity audit plan result must be an object.");
  assertNoForbiddenAuditFields(record, "identityAuditPlan");
  requireExactAuditKeys(record, ["auditVersion", "copy", "pages"], "identityAuditPlan");
  requireLiteralNumber(record.auditVersion, "auditVersion", 1);

  return {
    auditVersion: 1,
    copy: parseIdentityAuditCopy(record.copy),
    pages: parseIdentityAuditPages(record.pages),
  };
}

function parseIdentityAuditOpenResult(value: unknown, requestedProfileId: string, requestedPageId: string): IdentityAuditOpenResult {
  const record = requireRecord(value, "The sidecar identity audit open result must be an object.");
  assertNoForbiddenAuditFields(record, "identityAuditOpen");
  requireExactAuditKeys(
    record,
    ["auditVersion", "profileId", "pageId", "status", "openedAt", "launched", "runningCount", "page"],
    "identityAuditOpen",
  );
  requireLiteralNumber(record.auditVersion, "auditVersion", 1);
  const profileId = requireAuditClientId(record.profileId, "profileId");
  const pageId = requireAuditClientId(record.pageId, "pageId");
  requireLiteral(record.status, "status", "opened");
  const page = parseIdentityAuditPage(record.page, "page");

  if (profileId !== requestedProfileId) {
    throw makeProtocolError("The sidecar identity audit open profileId did not match the request.");
  }
  if (pageId !== requestedPageId || page.id !== requestedPageId) {
    throw makeProtocolError("The sidecar identity audit open pageId did not match the request.");
  }

  return {
    auditVersion: 1,
    profileId,
    pageId,
    status: "opened",
    openedAt: requireIsoTimestamp(record.openedAt, "openedAt"),
    launched: requireBoolean(record.launched, "launched"),
    runningCount: requireNonNegativeInteger(record.runningCount, "runningCount"),
    page,
  };
}

function parseIdentityAuditCollectResult(value: unknown, requestedProfileId: string): IdentityAuditCollectResult {
  const record = requireRecord(value, "The sidecar identity audit collect result must be an object.");
  assertNoForbiddenAuditFields(record, "identityAuditCollect");
  requireExactAuditKeys(
    record,
    ["auditVersion", "profileId", "status", "collectedAt", "launched", "runningCount", "pages"],
    "identityAuditCollect",
  );
  requireLiteralNumber(record.auditVersion, "auditVersion", 1);
  const profileId = requireAuditClientId(record.profileId, "profileId");
  if (profileId !== requestedProfileId) {
    throw makeProtocolError("The sidecar identity audit collect profileId did not match the request.");
  }
  requireLiteral(record.status, "status", "collected");
  return {
    auditVersion: 1,
    profileId,
    status: "collected",
    collectedAt: requireIsoTimestamp(record.collectedAt, "collectedAt"),
    launched: requireBoolean(record.launched, "launched"),
    runningCount: requireNonNegativeInteger(record.runningCount, "runningCount"),
    pages: parseIdentityAuditPageResults(record.pages),
  };
}

function parseIdentityAuditPageResults(value: unknown): IdentityAuditPageResult[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError("The sidecar identity audit result pages field must be an array.");
  }
  if (value.length !== IDENTITY_AUDIT_CATALOG.length) {
    throw makeProtocolError("The sidecar identity audit result page count does not match the fixed catalog.");
  }
  const seen = new Set<string>();
  const pages = value.map((item, index) => {
    const page = parseIdentityAuditPageResult(item, `pages[${index}]`);
    if (seen.has(page.id)) {
      throw makeProtocolError("The sidecar identity audit result contains duplicate page ids.");
    }
    seen.add(page.id);
    return page;
  });
  for (const expected of IDENTITY_AUDIT_CATALOG) {
    if (!seen.has(expected.id)) {
      throw makeProtocolError("The sidecar identity audit result is missing a fixed page id.");
    }
  }
  return pages;
}

function parseIdentityAuditPageResult(value: unknown, field: string): IdentityAuditPageResult {
  const record = requireRecord(value, `The sidecar identity audit result field ${field} must be an object.`);
  assertNoForbiddenAuditFields(record, field);
  requireExactAuditKeys(record, ["id", "label", "category", "url", "status", "capturedAt", "title", "summary", "extractedRows", "notes"], field);
  const id = requireAuditClientId(record.id, `${field}.id`);
  const expected = IDENTITY_AUDIT_CATALOG_BY_ID.get(id);
  if (!expected) {
    throw makeProtocolError(`The sidecar identity audit result field ${field}.id is not in the fixed catalog.`);
  }
  const category = requireIdentityAuditCategory(record.category, `${field}.category`);
  if (category !== expected.category) {
    throw makeProtocolError(`The sidecar identity audit result field ${field}.category does not match the fixed catalog.`);
  }
  return {
    id,
    label: requireAuditSafeText(record.label, `${field}.label`, { maxLength: 128 }),
    category,
    url: requireIdentityAuditUrl(record.url, expected.url, `${field}.url`),
    status: requireIdentityAuditPageResultStatus(record.status, `${field}.status`),
    capturedAt: requireIsoTimestamp(record.capturedAt, `${field}.capturedAt`),
    title: requireAuditSafeText(record.title, `${field}.title`, { maxLength: 160 }),
    summary: requireAuditSafeText(record.summary, `${field}.summary`, { maxLength: 420 }),
    extractedRows: parseIdentityAuditCollectedRows(record.extractedRows, `${field}.extractedRows`),
    notes: parseIdentityAuditResultNotes(record.notes, `${field}.notes`),
  };
}

function parseIdentityAuditCollectedRows(value: unknown, field: string): IdentityAuditCollectedRow[] {
  if (!Array.isArray(value) || value.length > 12) {
    throw makeProtocolError(`The sidecar identity audit result field ${field} must be a bounded array.`);
  }
  return value.map((item, index) => {
    const rowField = `${field}[${index}]`;
    const record = requireRecord(item, `The sidecar identity audit result field ${rowField} must be an object.`);
    assertNoForbiddenAuditFields(record, rowField);
    requireExactAuditKeys(record, ["label", "value"], rowField);
    return {
      label: requireAuditSafeText(record.label, `${rowField}.label`, { maxLength: 160 }),
      value: requireAuditSafeText(record.value, `${rowField}.value`, { maxLength: 420 }),
    };
  });
}

function parseIdentityAuditResultNotes(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 4) {
    throw makeProtocolError(`The sidecar identity audit result field ${field} must be a bounded array.`);
  }
  return value.map((item, index) => requireAuditSafeText(item, `${field}[${index}]`, { maxLength: 180 }));
}

function parseIdentityAuditCopy(value: unknown): IdentityAuditPlanCopy {
  const record = requireRecord(value, "The sidecar identity audit copy result must be an object.");
  assertNoForbiddenAuditFields(record, "copy");
  requireExactAuditKeys(record, ["advisory", "localProof", "publicCheckerInstability"], "copy");
  return {
    advisory: requireAuditSafeText(record.advisory, "copy.advisory", { maxLength: 256 }),
    localProof: requireAuditSafeText(record.localProof, "copy.localProof", { maxLength: 256 }),
    publicCheckerInstability: requireAuditSafeText(record.publicCheckerInstability, "copy.publicCheckerInstability", { maxLength: 256 }),
  };
}

function parseIdentityAuditPages(value: unknown): IdentityAuditPage[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError("The sidecar identity audit pages field must be an array.");
  }
  if (value.length !== IDENTITY_AUDIT_CATALOG.length) {
    throw makeProtocolError("The sidecar identity audit page count does not match the fixed catalog.");
  }

  const seen = new Set<string>();
  const pages = value.map((item, index) => {
    const page = parseIdentityAuditPage(item, `pages[${index}]`);
    if (seen.has(page.id)) {
      throw makeProtocolError("The sidecar identity audit catalog contains duplicate page ids.");
    }
    seen.add(page.id);
    return page;
  });

  for (const expected of IDENTITY_AUDIT_CATALOG) {
    if (!seen.has(expected.id)) {
      throw makeProtocolError("The sidecar identity audit catalog is missing a fixed page id.");
    }
  }

  return pages;
}

function parseIdentityAuditPage(value: unknown, field: string): IdentityAuditPage {
  const record = requireRecord(value, `The sidecar identity audit field ${field} must be an object.`);
  assertNoForbiddenAuditFields(record, field);
  requireExactAuditKeys(
    record,
    ["id", "label", "category", "url", "surfaces", "comparisonNote", "requiresUserAction", "expectedRows"],
    field,
  );
  const id = requireAuditClientId(record.id, `${field}.id`);
  const expected = IDENTITY_AUDIT_CATALOG_BY_ID.get(id);
  if (!expected) {
    throw makeProtocolError(`The sidecar identity audit field ${field}.id is not in the fixed catalog.`);
  }
  const category = requireIdentityAuditCategory(record.category, `${field}.category`);
  const surfaces = parseIdentityAuditSurfaces(record.surfaces, `${field}.surfaces`);
  const url = requireIdentityAuditUrl(record.url, expected.url, `${field}.url`);

  if (category !== expected.category || record.requiresUserAction !== expected.requiresUserAction) {
    throw makeProtocolError(`The sidecar identity audit field ${field} does not match fixed catalog metadata.`);
  }
  if (!sameStringArray(surfaces, [...expected.surfaces])) {
    throw makeProtocolError(`The sidecar identity audit field ${field}.surfaces does not match the fixed catalog.`);
  }

  return {
    id,
    label: requireAuditSafeText(record.label, `${field}.label`, { maxLength: 128 }),
    category,
    url,
    surfaces,
    comparisonNote: requireAuditSafeText(record.comparisonNote, `${field}.comparisonNote`, { maxLength: 512 }),
    requiresUserAction: requireBoolean(record.requiresUserAction, `${field}.requiresUserAction`),
    expectedRows: parseIdentityAuditExpectedRows(record.expectedRows, surfaces, `${field}.expectedRows`),
  };
}

function parseIdentityAuditExpectedRows(value: unknown, pageSurfaces: IdentityAuditSurface[], field: string): IdentityAuditExpectedRow[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) {
    throw makeProtocolError(`The sidecar identity audit field ${field} must be a bounded non-empty array.`);
  }

  const pageSurfaceSet = new Set(pageSurfaces);
  return value.map((item, index) => {
    const rowField = `${field}[${index}]`;
    const record = requireRecord(item, `The sidecar identity audit field ${rowField} must be an object.`);
    assertNoForbiddenAuditFields(record, rowField);
    requireExactAuditKeys(record, ["surface", "label", "expected", "guidance"], rowField);
    const surface = requireIdentityAuditSurface(record.surface, `${rowField}.surface`);
    if (!pageSurfaceSet.has(surface)) {
      throw makeProtocolError(`The sidecar identity audit field ${rowField}.surface must belong to the page surfaces.`);
    }
    return {
      surface,
      label: requireAuditSafeText(record.label, `${rowField}.label`, { maxLength: 128 }),
      expected: requireAuditSafeText(record.expected, `${rowField}.expected`, { maxLength: 512 }),
      guidance: requireAuditSafeText(record.guidance, `${rowField}.guidance`, { maxLength: 512 }),
    };
  });
}

function parseIdentityAuditSurfaces(value: unknown, field: string): IdentityAuditSurface[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw makeProtocolError(`The sidecar identity audit field ${field} must be a bounded non-empty array.`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const surface = requireIdentityAuditSurface(item, `${field}[${index}]`);
    if (seen.has(surface)) {
      throw makeProtocolError(`The sidecar identity audit field ${field} contains duplicate surfaces.`);
    }
    seen.add(surface);
    return surface;
  });
}

function parseLegacyScanResult(value: unknown): LegacyScanResult {
  const record = requireRecord(value, "The sidecar legacy scan result must be an object.");
  requireLiteralNumber(record.scanVersion, "scanVersion", 1);
  const candidates = parseLegacyScanCandidateArray(record.candidates);
  const count = requireNonNegativeInteger(record.count, "count");
  const issues = parseLegacyIssueArray(record.issues, "issues");

  if (count !== candidates.length) {
    throw makeProtocolError("The sidecar legacy scan count does not match the candidates array length.");
  }

  return {
    scanVersion: 1,
    count,
    candidates,
    issues,
  };
}

function parseLegacyImportResult(value: unknown): LegacyImportResult {
  const record = requireRecord(value, "The sidecar legacy import result must be an object.");
  requireLiteralNumber(record.importVersion, "importVersion", 1);
  const outcomes = parseLegacyImportOutcomeArray(record.outcomes);
  const requestedCount = requireNonNegativeInteger(record.requestedCount, "requestedCount");
  const successCount = requireNonNegativeInteger(record.successCount, "successCount");
  const partialCount = requireNonNegativeInteger(record.partialCount, "partialCount");
  const failedCount = requireNonNegativeInteger(record.failedCount, "failedCount");

  if (requestedCount !== outcomes.length) {
    throw makeProtocolError("The sidecar legacy import requestedCount does not match the outcomes array length.");
  }
  if (successCount !== outcomes.filter((outcome) => outcome.status === "success").length) {
    throw makeProtocolError("The sidecar legacy import successCount does not match successful outcomes.");
  }
  if (partialCount !== outcomes.filter((outcome) => outcome.status === "partial").length) {
    throw makeProtocolError("The sidecar legacy import partialCount does not match partial outcomes.");
  }
  if (failedCount !== outcomes.filter((outcome) => outcome.status === "failed").length) {
    throw makeProtocolError("The sidecar legacy import failedCount does not match failed outcomes.");
  }

  return {
    importVersion: 1,
    requestedCount,
    successCount,
    partialCount,
    failedCount,
    outcomes,
  };
}

function parseLegacyScanCandidateArray(value: unknown): LegacyScanCandidate[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError("The sidecar legacy scan candidates field must be an array.");
  }

  return value.map((item, index) => parseLegacyScanCandidate(item, `candidates[${index}]`));
}

function parseLegacyScanCandidate(value: unknown, field: string): LegacyScanCandidate {
  const record = requireRecord(value, `The sidecar legacy scan field ${field} must be an object.`);
  const userData = requireRecord(record.userData, `The sidecar legacy scan field ${field}.userData must be an object.`);
  const legacyName = record.legacyName;

  if (legacyName !== null && typeof legacyName !== "string") {
    throw makeProtocolError(`The sidecar legacy scan field ${field}.legacyName must be a string or null.`);
  }

  return {
    legacyId: requireLegacyId(record.legacyId, `${field}.legacyId`),
    folderName: requireNonBlankString(record.folderName, `${field}.folderName`),
    legacyName,
    targetName: requireNonBlankString(record.targetName, `${field}.targetName`),
    userData: {
      status: requireLegacyUserDataStatus(userData.status, `${field}.userData.status`),
    },
    metadata: parseSafeJsonObject(record.metadata, `${field}.metadata`),
    issues: parseLegacyIssueArray(record.issues, `${field}.issues`),
  };
}

function parseLegacyIssueArray(value: unknown, field: string): LegacyIssue[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError(`The sidecar legacy field ${field} must be an array.`);
  }

  return value.map((item, index) => parseLegacyIssue(item, `${field}[${index}]`));
}

function parseLegacyIssue(value: unknown, field: string): LegacyIssue {
  const record = requireRecord(value, `The sidecar legacy issue field ${field} must be an object.`);
  return {
    code: requireNonBlankString(record.code, `${field}.code`),
    message: requireNonBlankString(record.message, `${field}.message`),
    detailRef: requireDetailRef(record.detailRef, `${field}.detailRef`),
  };
}

function parseLegacyImportOutcomeArray(value: unknown): LegacyImportOutcome[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError("The sidecar legacy import outcomes field must be an array.");
  }

  return value.map((item, index) => parseLegacyImportOutcome(item, `outcomes[${index}]`));
}

function parseLegacyImportOutcome(value: unknown, field: string): LegacyImportOutcome {
  const record = requireRecord(value, `The sidecar legacy import field ${field} must be an object.`);
  const base = {
    legacyId: requireLegacyId(record.legacyId, `${field}.legacyId`),
    targetName: requireNonBlankString(record.targetName, `${field}.targetName`),
    folderName: optionalNonBlankString(record.folderName, `${field}.folderName`),
    legacyName: optionalNonBlankString(record.legacyName, `${field}.legacyName`),
  };
  const status = requireLegacyImportOutcomeStatus(record.status, `${field}.status`);
  const copyStatus = requireLegacyImportCopyStatus(record.copyStatus, `${field}.copyStatus`);

  if (status === "success") {
    if (copyStatus !== "copied" && copyStatus !== "missing") {
      throw makeProtocolError(`The sidecar legacy import field ${field}.copyStatus is invalid for success.`);
    }
    if (record.error !== undefined) {
      throw makeProtocolError(`The sidecar legacy import field ${field}.error must be absent for success.`);
    }
    return compactOptionalFields({
      ...base,
      status,
      copyStatus,
      profileId: requireNonBlankString(record.profileId, `${field}.profileId`),
    });
  }

  if (status === "partial") {
    if (copyStatus !== "failed") {
      throw makeProtocolError(`The sidecar legacy import field ${field}.copyStatus must be failed for partial.`);
    }
    return compactOptionalFields({
      ...base,
      status,
      copyStatus,
      profileId: requireNonBlankString(record.profileId, `${field}.profileId`),
      error: parseLegacyOutcomeError(record.error, `${field}.error`),
    });
  }

  if (copyStatus !== "skipped") {
    throw makeProtocolError(`The sidecar legacy import field ${field}.copyStatus must be skipped for failed.`);
  }
  if (record.profileId !== undefined) {
    throw makeProtocolError(`The sidecar legacy import field ${field}.profileId must be absent for failed.`);
  }
  return compactOptionalFields({
    ...base,
    status,
    copyStatus,
    error: parseLegacyOutcomeError(record.error, `${field}.error`),
  });
}

function parseLegacyOutcomeError(value: unknown, field: string): LegacyImportOutcomeError {
  const record = requireRecord(value, `The sidecar legacy import field ${field} must be an object.`);
  return {
    code: requireNonBlankString(record.code, `${field}.code`),
    message: requireNonBlankString(record.message, `${field}.message`),
    recoverable: requireBoolean(record.recoverable, `${field}.recoverable`),
    detailRef: requireDetailRef(record.detailRef, `${field}.detailRef`),
  };
}

function parseChromiumStatusResult(value: unknown): ChromiumStatusResult {
  const record = requireRecord(value, "The sidecar Chromium status result must be an object.");
  const profiles = parseChromiumRunningProfileArray(record.profiles, "profiles");
  const runningCount = requireNonNegativeInteger(record.runningCount, "runningCount");
  const reconciled = parseChromiumStoppedProfileArray(record.reconciled, "reconciled");

  if (runningCount !== profiles.length) {
    throw makeProtocolError("The sidecar Chromium status runningCount does not match the profiles array length.");
  }

  return {
    runningCount,
    profiles,
    reconciled,
  };
}

function parseChromiumLaunchResult(value: unknown): ChromiumLaunchResult {
  const record = requireRecord(value, "The sidecar Chromium launch result must be an object.");
  return {
    ...parseChromiumRunningProfile(record, "launch"),
    runningCount: requirePositiveInteger(record.runningCount, "runningCount"),
  };
}

function parseChromiumStopResult(value: unknown): ChromiumStopResult {
  const record = requireRecord(value, "The sidecar Chromium stop result must be an object.");
  return {
    ...parseChromiumStoppedProfile(record, "stop"),
    runningCount: requireNonNegativeInteger(record.runningCount, "runningCount"),
  };
}

function parseChromiumRunningProfileArray(value: unknown, field: string): ChromiumRunningProfileState[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError(`The sidecar Chromium result field ${field} must be an array.`);
  }

  return value.map((item, index) => parseChromiumRunningProfile(item, `${field}[${index}]`));
}

function parseChromiumStoppedProfileArray(value: unknown, field: string): ChromiumStoppedProfileState[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError(`The sidecar Chromium result field ${field} must be an array.`);
  }

  return value.map((item, index) => parseChromiumStoppedProfile(item, `${field}[${index}]`));
}

function parseChromiumRunningProfile(value: unknown, field: string): ChromiumRunningProfileState {
  const record = requireRecord(value, `The sidecar Chromium result field ${field} must be an object.`);
  const profileId = requireNonBlankString(record.profileId, `${field}.profileId`);
  requireLiteral(record.status, `${field}.status`, "running");

  return {
    profileId,
    status: "running",
    pid: requirePositiveInteger(record.pid, `${field}.pid`),
    startedAt: requireIsoTimestamp(record.startedAt, `${field}.startedAt`),
    userDataDir: requireChromiumUserDataDir(record.userDataDir, profileId, `${field}.userDataDir`),
  };
}

function parseChromiumStoppedProfile(value: unknown, field: string): ChromiumStoppedProfileState {
  const record = requireRecord(value, `The sidecar Chromium result field ${field} must be an object.`);
  const profileId = requireNonBlankString(record.profileId, `${field}.profileId`);
  requireLiteral(record.status, `${field}.status`, "stopped");

  return {
    profileId,
    status: "stopped",
    stoppedAt: requireIsoTimestamp(record.stoppedAt, `${field}.stoppedAt`),
    termination: requireChromiumTermination(record.termination, `${field}.termination`),
    userDataDir: requireChromiumUserDataDir(record.userDataDir, profileId, `${field}.userDataDir`),
  };
}

function parseProfileArray(value: unknown): ProfileRecord[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError("The sidecar profile result field profiles must be an array.");
  }

  return value.map((item, index) => parseProfileRecord(item, `profiles[${index}]`));
}

function parseProfileRecord(value: unknown, field = "profile"): ProfileRecord {
  const record = requireRecord(value, `The sidecar profile result field ${field} must be an object.`);
  assertNoForbiddenPublicProfileFields(record, field);
  requirePublicKeys(
    record,
    ["id", "name", "createdAt", "updatedAt", "defaults", "storage", "identity", "proxy", "organization", "launch", "lifecycle", "sync", "metadata"],
    ["id", "name", "createdAt", "updatedAt", "defaults", "storage", "identity", "proxy", "organization", "launch", "lifecycle", "sync"],
    field,
  );
  const id = requireNonBlankString(record.id, `${field}.id`);
  const name = requireNonBlankString(record.name, `${field}.name`);
  const createdAt = requireIsoTimestamp(record.createdAt, `${field}.createdAt`);
  const updatedAt = requireIsoTimestamp(record.updatedAt, `${field}.updatedAt`);
  const proxy = parseProfileProxySummary(record.proxy, `${field}.proxy`);
  const identity = parseProfileIdentity(record.identity, `${field}.identity`);
  const launch = parseProfileLaunch(record.launch, `${field}.launch`);

  const metadata = record.metadata === undefined ? undefined : parseSafePublicMetadata(record.metadata, `${field}.metadata`);

  return {
    id,
    name,
    createdAt,
    updatedAt,
    defaults: parseProfileDefaults(record.defaults, `${field}.defaults`, {
      proxyMode: proxy.mode,
      startUrl: deriveProfileStartUrl(launch),
      fingerprintMode: deriveFingerprintMode(identity),
    }),
    storage: parseProfileStorage(record.storage, id, `${field}.storage`),
    identity,
    proxy,
    organization: parseProfileOrganization(record.organization, `${field}.organization`),
    launch,
    lifecycle: parseProfileLifecycle(record.lifecycle, `${field}.lifecycle`),
    sync: parseProfileSync(record.sync, `${field}.sync`),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function parseProfileDefaults(value: unknown, field: string, expected: Omit<ProfileDefaults, "browser">): ProfileDefaults {
  const defaults = requireRecord(value, `The sidecar profile result field ${field} must be an object.`);
  requirePublicKeys(defaults, ["browser", "startUrl", "proxyMode", "fingerprintMode"], ["browser", "startUrl", "proxyMode", "fingerprintMode"], field);
  requireLiteral(defaults.browser, `${field}.browser`, "chromium");
  const startUrl = requireProfileStartUrl(defaults.startUrl, `${field}.startUrl`);
  const proxyMode = requireProfileProxyMode(defaults.proxyMode, `${field}.proxyMode`);
  const fingerprintMode = requireFingerprintMode(defaults.fingerprintMode, `${field}.fingerprintMode`);

  // defaults is a summary of the canonical sections, never a source: a value the
  // launcher trusts must be re-derivable from launch, identity, and proxy.
  if (proxyMode !== expected.proxyMode) {
    throw makeProtocolError(`The sidecar profile result field ${field}.proxyMode must match the public proxy summary.`);
  }
  if (startUrl !== expected.startUrl) {
    throw makeProtocolError(`The sidecar profile result field ${field}.startUrl must match the launch block.`);
  }
  if (fingerprintMode !== expected.fingerprintMode) {
    throw makeProtocolError(`The sidecar profile result field ${field}.fingerprintMode must match the identity surfaces.`);
  }

  return {
    browser: "chromium",
    startUrl,
    proxyMode,
    fingerprintMode,
  };
}

function deriveProfileStartUrl(launch: ProfileLaunch): string {
  if (launch.startupBehavior !== "customUrls" || launch.startUrls.length === 0) {
    return "about:blank";
  }

  return launch.startUrls[0];
}

function deriveFingerprintMode(identity: ProfileIdentity): FingerprintMode {
  return PROFILE_IDENTITY_SURFACES.every((surface) => identity[surface].mode === "real") ? "disabled" : "managed";
}

function parseProfileProxySummary(value: unknown, field: string): ProfileProxySummary {
  const record = requireRecord(value, `The sidecar profile result field ${field} must be an object.`);
  assertNoForbiddenPublicProxyFields(record, field);
  requireLiteralNumber(record.proxyVersion, `${field}.proxyVersion`, 1);
  const mode = requireProfileProxyMode(record.mode, `${field}.mode`);

  if (mode === "direct") {
    requirePublicKeys(record, ["proxyVersion", "mode", "credentialState", "summary"], ["proxyVersion", "mode", "credentialState", "summary"], field);
    requireLiteral(record.credentialState, `${field}.credentialState`, "none");
    requireLiteral(record.summary, `${field}.summary`, "Direct connection");
    return {
      proxyVersion: 1,
      mode,
      credentialState: "none",
      summary: "Direct connection",
    };
  }

  requirePublicKeys(
    record,
    ["proxyVersion", "mode", "protocol", "host", "port", "credentialState", "summary"],
    ["proxyVersion", "mode", "protocol", "host", "port", "credentialState", "summary"],
    field,
  );
  const protocol = requireProxyProtocol(record.protocol, `${field}.protocol`);
  const host = requireProxyHost(record.host, `${field}.host`);
  const port = requireProxyPort(record.port, `${field}.port`);
  const credentialState = requireProxyCredentialState(record.credentialState, `${field}.credentialState`);
  const summary = requireProxySummary(record.summary, `${field}.summary`);
  const expectedSummary = formatProxySummary(protocol, host, port);

  if (summary !== expectedSummary) {
    throw makeProtocolError(`The sidecar profile result field ${field}.summary must match the redacted proxy endpoint.`);
  }

  return {
    proxyVersion: 1,
    mode,
    protocol,
    host,
    port,
    credentialState,
    summary,
  };
}

function parseProfileStorage(value: unknown, profileId: string, field: string): ProfileStorage {
  const storage = requireRecord(value, `The sidecar profile result field ${field} must be an object.`);
  const profileDir = requireRelativeStoragePath(storage.profileDir, `${field}.profileDir`);
  const userDataDir = requireRelativeStoragePath(storage.userDataDir, `${field}.userDataDir`);
  const expectedProfileDir = `profile-store/profiles/${profileId}`;

  if (profileDir !== expectedProfileDir) {
    throw makeProtocolError(`The sidecar profile result field ${field}.profileDir must match the profile id.`);
  }
  if (userDataDir !== `${expectedProfileDir}/user-data`) {
    throw makeProtocolError(`The sidecar profile result field ${field}.userDataDir must match the profile id.`);
  }

  return {
    profileDir,
    userDataDir,
  };
}

function parseProfileOrganization(value: unknown, field: string): ProfileOrganization {
  const organization = requireRecord(value, `The sidecar profile result field ${field} must be an object.`);
  requirePublicKeys(
    organization,
    ["folderId", "tags", "notes", "favorite", "color"],
    ["folderId", "tags", "notes", "favorite", "color"],
    field,
  );

  return {
    folderId: organization.folderId === null ? null : requireProfileFolderId(organization.folderId, `${field}.folderId`),
    tags: parseProfileTagArray(organization.tags, `${field}.tags`),
    // Notes are text the user typed: slashes and colons are ordinary content, so
    // the guard is control characters and length, never a path-shaped rejection.
    notes: requireProfileFreeText(organization.notes, `${field}.notes`, MAX_PROFILE_NOTES_LENGTH),
    favorite: requireBoolean(organization.favorite, `${field}.favorite`),
    color: organization.color === null ? null : requireProfileColor(organization.color, `${field}.color`),
  };
}

function parseProfileLaunch(value: unknown, field: string): ProfileLaunch {
  const launch = requireRecord(value, `The sidecar profile result field ${field} must be an object.`);
  requirePublicKeys(launch, ["startupBehavior", "startUrls", "args"], ["startupBehavior", "startUrls", "args"], field);

  return {
    startupBehavior: requireProfileStartupBehavior(launch.startupBehavior, `${field}.startupBehavior`),
    startUrls: parseProfileStartUrlArray(launch.startUrls, `${field}.startUrls`),
    args: parseProfileLaunchArgArray(launch.args, `${field}.args`),
  };
}

function parseProfileLifecycle(value: unknown, field: string): ProfileLifecycle {
  const lifecycle = requireRecord(value, `The sidecar profile result field ${field} must be an object.`);
  requirePublicKeys(lifecycle, ["deletedAt", "lastLaunchedAt", "launchCount"], ["deletedAt", "lastLaunchedAt", "launchCount"], field);

  return {
    deletedAt: lifecycle.deletedAt === null ? null : requireIsoTimestamp(lifecycle.deletedAt, `${field}.deletedAt`),
    lastLaunchedAt:
      lifecycle.lastLaunchedAt === null ? null : requireIsoTimestamp(lifecycle.lastLaunchedAt, `${field}.lastLaunchedAt`),
    launchCount: requireNonNegativeInteger(lifecycle.launchCount, `${field}.launchCount`),
  };
}

function parseProfileSync(value: unknown, field: string): ProfileSync {
  const sync = requireRecord(value, `The sidecar profile result field ${field} must be an object.`);
  requirePublicKeys(
    sync,
    ["revision", "updatedBy", "originDeviceId", "lastSyncedAt", "lastSyncedRevision"],
    ["revision", "updatedBy", "originDeviceId", "lastSyncedAt", "lastSyncedRevision"],
    field,
  );

  return {
    revision: requirePositiveInteger(sync.revision, `${field}.revision`),
    updatedBy: requireProfileDeviceId(sync.updatedBy, `${field}.updatedBy`),
    originDeviceId: requireProfileDeviceId(sync.originDeviceId, `${field}.originDeviceId`),
    lastSyncedAt: sync.lastSyncedAt === null ? null : requireIsoTimestamp(sync.lastSyncedAt, `${field}.lastSyncedAt`),
    lastSyncedRevision:
      sync.lastSyncedRevision === null ? null : requirePositiveInteger(sync.lastSyncedRevision, `${field}.lastSyncedRevision`),
  };
}

function parseProfileTagArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_PROFILE_TAGS) {
    throw makeProtocolError(`The sidecar profile result field ${field} must be a bounded tag array.`);
  }

  const tags = value.map((item, index) => requireProfileTag(item, `${field}[${index}]`));
  if (new Set(tags.map((tag) => tag.toLowerCase())).size !== tags.length) {
    throw makeProtocolError(`The sidecar profile result field ${field} must not repeat tags.`);
  }

  return tags;
}

function requireProfileTag(value: unknown, field: string): string {
  const tag = requireProfileFreeText(value, field, MAX_PROFILE_TAG_LENGTH);
  if (!tag.trim() || !PROFILE_TAG_PATTERN.test(tag)) {
    throw makeProtocolError(`The sidecar profile result field ${field} must be letters, digits, spaces, or hyphens.`);
  }

  return tag;
}

function requireProfileFreeText(value: unknown, field: string, maxLength: number): string {
  const text = requireString(value, field);
  if (codePointLength(text) > maxLength || containsControlCharacters(text)) {
    throw makeProtocolError(`The sidecar profile result field ${field} is outside supported bounds.`);
  }

  return text;
}

function requireProfileFolderId(value: unknown, field: string): string {
  const folderId = requireNonBlankString(value, field);
  if (!PROFILE_FOLDER_ID_PATTERN.test(folderId)) {
    throw makeProtocolError(`The sidecar profile result field ${field} must be a uuid or null.`);
  }

  return folderId;
}

function requireProfileColor(value: unknown, field: string): string {
  const color = requireString(value, field);
  if (!PROFILE_COLOR_PATTERN.test(color)) {
    throw makeProtocolError(`The sidecar profile result field ${field} must be a #rrggbb color or null.`);
  }

  return color;
}

function requireProfileStartupBehavior(value: unknown, field: string): ProfileStartupBehavior {
  if (value === "customUrls" || value === "restoreSession") {
    return value;
  }

  throw makeProtocolError(`The sidecar profile result field ${field} must be a supported startup behavior.`);
}

function parseProfileStartUrlArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_PROFILE_START_URLS) {
    throw makeProtocolError(`The sidecar profile result field ${field} must be a bounded start URL array.`);
  }

  return value.map((item, index) => requireProfileStartUrl(item, `${field}[${index}]`));
}

function requireProfileStartUrl(value: unknown, field: string): string {
  const startUrl = requireString(value, field);
  if (!startUrl || codePointLength(startUrl) > MAX_PROFILE_START_URL_LENGTH || containsControlCharacters(startUrl) || /\s/.test(startUrl)) {
    throw makeProtocolError(`The sidecar profile result field ${field} is outside supported bounds.`);
  }
  // A start URL is handed to Chromium as a positional argument, so an exact
  // scheme prefix is what makes switch injection structurally impossible.
  if (startUrl !== "about:blank" && !startUrl.startsWith("https://") && !startUrl.startsWith("http://")) {
    throw makeProtocolError(`The sidecar profile result field ${field} must begin with https:// or http://.`);
  }

  return startUrl;
}

function parseProfileLaunchArgArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_PROFILE_LAUNCH_ARGS) {
    throw makeProtocolError(`The sidecar profile result field ${field} must be a bounded launch argument array.`);
  }

  return value.map((item, index) => requireProfileLaunchArg(item, `${field}[${index}]`));
}

function requireProfileLaunchArg(value: unknown, field: string): string {
  const arg = requireProfileFreeText(value, field, MAX_PROFILE_LAUNCH_ARG_LENGTH);
  if (!arg.startsWith("--")) {
    throw makeProtocolError(`The sidecar profile result field ${field} must be a switch beginning with --.`);
  }

  return arg;
}

function requireProfileDeviceId(value: unknown, field: string): string {
  const deviceId = requireNonBlankString(value, field);
  if (codePointLength(deviceId) > MAX_PROFILE_DEVICE_ID_LENGTH || containsControlCharacters(deviceId)) {
    throw makeProtocolError(`The sidecar profile result field ${field} is outside supported bounds.`);
  }

  return deviceId;
}

function parseIdentityArray(value: unknown, field: string): ProfileIdentity[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError(`The sidecar identity field ${field} must be an array.`);
  }

  return value.map((item, index) => parseProfileIdentity(item, `${field}[${index}]`));
}

function parseProfileIdentity(value: unknown, field: string): ProfileIdentity {
  const record = requireRecord(value, `The sidecar identity field ${field} must be an object.`);
  requireExactKeys(record, [
    "identityVersion",
    "label",
    "presetId",
    "browser",
    "navigator",
    "screen",
    "locale",
    "canvas",
    "audio",
    "webgl",
    "webrtc",
  ], field);
  requireLiteralNumber(record.identityVersion, `${field}.identityVersion`, 1);

  return {
    identityVersion: 1,
    label: requireIdentityText(record.label, `${field}.label`, { maxLength: 128 }),
    presetId: parseIdentityPresetId(record.presetId, `${field}.presetId`),
    browser: parseBrowserIdentitySurface(record.browser, `${field}.browser`),
    navigator: parseNavigatorIdentitySurface(record.navigator, `${field}.navigator`),
    screen: parseScreenIdentitySurface(record.screen, `${field}.screen`),
    locale: parseLocaleIdentitySurface(record.locale, `${field}.locale`),
    canvas: parseNoiseIdentitySurface(record.canvas, `${field}.canvas`, "canvas"),
    audio: parseNoiseIdentitySurface(record.audio, `${field}.audio`, "audio"),
    webgl: parseWebGlIdentitySurface(record.webgl, `${field}.webgl`),
    webrtc: parseWebRtcIdentitySurface(record.webrtc, `${field}.webrtc`),
  };
}

function parseIdentityPresetId(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return requireIdentityText(value, field, { maxLength: 80 });
}

function parseBrowserIdentitySurface(value: unknown, field: string): ProfileIdentity["browser"] {
  const record = requireRecord(value, `The sidecar identity field ${field} must be an object.`);
  const mode = requireIdentityMaskingMode(record.mode, `${field}.mode`);
  if (mode === "real") {
    requireExactKeys(record, ["mode"], field);
    return { mode };
  }

  requireAllowedKeys(record, ["mode", "userAgent", "clientHints"], ["mode", "userAgent"], field);
  const clientHints = record.clientHints === undefined ? undefined : parseBrowserClientHints(record.clientHints, `${field}.clientHints`);
  return compactOptionalFields({
    mode,
    userAgent: requireIdentityText(record.userAgent, `${field}.userAgent`, { maxLength: 512 }),
    clientHints,
  });
}

function parseBrowserClientHints(value: unknown, field: string): BrowserClientHints {
  const record = requireRecord(value, `The sidecar identity field ${field} must be an object.`);
  requireAllowedKeys(record, ["platform", "platformVersion", "architecture", "bitness", "model", "mobile"], [], field);
  const parsed: BrowserClientHints = {};

  for (const key of ["platform", "platformVersion", "architecture", "bitness", "model"] as const) {
    if (record[key] !== undefined) {
      parsed[key] = requireIdentityText(record[key], `${field}.${key}`, {
        maxLength: 80,
        allowEmpty: key === "platformVersion" || key === "model",
      });
    }
  }
  if (record.mobile !== undefined) {
    parsed.mobile = requireBoolean(record.mobile, `${field}.mobile`);
  }

  return parsed;
}

function parseNavigatorIdentitySurface(value: unknown, field: string): ProfileIdentity["navigator"] {
  const record = requireRecord(value, `The sidecar identity field ${field} must be an object.`);
  const mode = requireIdentityMaskingMode(record.mode, `${field}.mode`);
  if (mode === "real") {
    requireExactKeys(record, ["mode"], field);
    return { mode };
  }

  const required = ["mode", "platform", "hardwareConcurrency", "deviceMemory", "uaPlatform", "uaPlatformVersion", "uaArchitecture", "uaMobile"];
  requireAllowedKeys(record, required, required, field);
  return {
    mode,
    platform: requireIdentityText(record.platform, `${field}.platform`, { maxLength: 80 }),
    hardwareConcurrency: requireIdentityInteger(record.hardwareConcurrency, `${field}.hardwareConcurrency`, 1, 128),
    deviceMemory: requireIdentityNumber(record.deviceMemory, `${field}.deviceMemory`, 0.25, 128),
    uaPlatform: requireIdentityText(record.uaPlatform, `${field}.uaPlatform`, { maxLength: 80 }),
    uaPlatformVersion: requireIdentityText(record.uaPlatformVersion, `${field}.uaPlatformVersion`, { maxLength: 80, allowEmpty: true }),
    uaArchitecture: requireIdentityText(record.uaArchitecture, `${field}.uaArchitecture`, { maxLength: 80 }),
    uaMobile: requireBoolean(record.uaMobile, `${field}.uaMobile`),
  };
}

function parseScreenIdentitySurface(value: unknown, field: string): ProfileIdentity["screen"] {
  const record = requireRecord(value, `The sidecar identity field ${field} must be an object.`);
  const mode = requireIdentityMaskingMode(record.mode, `${field}.mode`);
  if (mode === "real") {
    requireExactKeys(record, ["mode"], field);
    return { mode };
  }

  const required = ["mode", "width", "height", "viewportWidth", "viewportHeight", "colorDepth", "pixelRatio"];
  requireAllowedKeys(record, required, required, field);
  return {
    mode,
    width: requireIdentityInteger(record.width, `${field}.width`, 1, 10000),
    height: requireIdentityInteger(record.height, `${field}.height`, 1, 10000),
    viewportWidth: requireIdentityInteger(record.viewportWidth, `${field}.viewportWidth`, 1, 10000),
    viewportHeight: requireIdentityInteger(record.viewportHeight, `${field}.viewportHeight`, 1, 10000),
    colorDepth: requireIdentityInteger(record.colorDepth, `${field}.colorDepth`, 1, 64),
    pixelRatio: requireIdentityNumber(record.pixelRatio, `${field}.pixelRatio`, 0.25, 8),
  };
}

function parseLocaleIdentitySurface(value: unknown, field: string): ProfileIdentity["locale"] {
  const record = requireRecord(value, `The sidecar identity field ${field} must be an object.`);
  const mode = requireIdentityMaskingMode(record.mode, `${field}.mode`);
  if (mode === "real") {
    requireExactKeys(record, ["mode"], field);
    return { mode };
  }

  const required = ["mode", "locale", "languages", "timezoneId"];
  requireAllowedKeys(record, required, required, field);
  return {
    mode,
    locale: requireLanguageTag(record.locale, `${field}.locale`),
    languages: parseLanguageArray(record.languages, `${field}.languages`),
    timezoneId: requireTimezoneId(record.timezoneId, `${field}.timezoneId`),
  };
}

function parseNoiseIdentitySurface(value: unknown, field: string, surface: "canvas" | "audio"): ProfileIdentity["canvas"] {
  const record = requireRecord(value, `The sidecar identity field ${field} must be an object.`);
  const mode = requireIdentityNoiseMode(record.mode, `${field}.mode`);
  if (mode === "real") {
    requireExactKeys(record, ["mode"], field);
    return { mode };
  }

  requireAllowedKeys(record, ["mode", "noiseSeed"], ["mode", "noiseSeed"], field);
  return {
    mode,
    noiseSeed: requireIdentityInteger(record.noiseSeed, `${field}.noiseSeed`, 0, 1000000),
  };
}

function parseWebGlIdentitySurface(value: unknown, field: string): ProfileIdentity["webgl"] {
  const record = requireRecord(value, `The sidecar identity field ${field} must be an object.`);
  const mode = requireIdentityMaskingMode(record.mode, `${field}.mode`);
  if (mode === "real") {
    requireExactKeys(record, ["mode"], field);
    return { mode };
  }

  requireAllowedKeys(record, ["mode", "vendor", "renderer", "noiseSeed"], ["mode", "vendor", "renderer"], field);
  const noiseSeed = record.noiseSeed === undefined ? undefined : requireIdentityInteger(record.noiseSeed, `${field}.noiseSeed`, 0, 1000000);
  return compactOptionalFields({
    mode,
    vendor: requireIdentityText(record.vendor, `${field}.vendor`, { maxLength: 512 }),
    renderer: requireIdentityText(record.renderer, `${field}.renderer`, { maxLength: 512 }),
    noiseSeed,
  });
}

function parseWebRtcIdentitySurface(value: unknown, field: string): ProfileIdentity["webrtc"] {
  const record = requireRecord(value, `The sidecar identity field ${field} must be an object.`);
  requireAllowedKeys(record, ["mode", "policy"], ["mode", "policy"], field);
  const mode = requireIdentityMaskingMode(record.mode, `${field}.mode`);
  const policy = requireWebRtcPolicy(record.policy, `${field}.policy`);
  if (mode === "real" && policy !== "real") {
    throw makeProtocolError(`The sidecar identity field ${field}.policy must be real when mode is real.`);
  }
  return { mode, policy };
}

function parseIdentityWarningArray(value: unknown, field: string): IdentityWarning[] {
  if (!Array.isArray(value)) {
    throw makeProtocolError(`The sidecar identity warning field ${field} must be an array.`);
  }

  return value.map((item, index) => parseIdentityWarning(item, `${field}[${index}]`));
}

function parseIdentityWarning(value: unknown, field: string): IdentityWarning {
  const record = requireRecord(value, `The sidecar identity warning field ${field} must be an object.`);
  requireExactKeys(record, ["code", "message", "surface", "path"], field);
  const surface = requireIdentitySurfaceName(record.surface, `${field}.surface`);
  const path = requireIdentityWarningPath(record.path, `${field}.path`, surface);
  return {
    code: requireDiagnosticErrorCode(record.code, `${field}.code`),
    message: requireSafeDiagnosticString(record.message, `${field}.message`),
    surface,
    path,
  };
}

function requireExactKeys(record: Record<string, unknown>, keys: string[], field: string): void {
  requireAllowedKeys(record, keys, keys, field);
}

function requireAllowedKeys(record: Record<string, unknown>, allowed: string[], required: string[], field: string): void {
  const allowedSet = new Set(allowed);
  const requiredSet = new Set(required);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw makeProtocolError(`The sidecar identity field ${field} contains unknown fields.`);
    }
  }
  for (const key of requiredSet) {
    if (!(key in record)) {
      throw makeProtocolError(`The sidecar identity field ${field} is missing required fields.`);
    }
  }
}

function requireIdentityText(value: unknown, field: string, options: { maxLength: number; allowEmpty?: boolean }): string {
  const text = requireString(value, field);
  if (!options.allowEmpty && !text) {
    throw makeProtocolError(`The sidecar identity field ${field} must not be empty.`);
  }
  if (text.length > options.maxLength || containsControlCharacters(text)) {
    throw makeProtocolError(`The sidecar identity field ${field} is outside supported bounds.`);
  }
  return text;
}

function requireIdentityInteger(value: unknown, field: string, minValue: number, maxValue: number): number {
  const number = requireNumber(value, field);
  if (!Number.isInteger(number) || number < minValue || number > maxValue) {
    throw makeProtocolError(`The sidecar identity field ${field} is outside supported bounds.`);
  }
  return number;
}

function requireIdentityNumber(value: unknown, field: string, minValue: number, maxValue: number): number {
  const number = requireNumber(value, field);
  if (number < minValue || number > maxValue) {
    throw makeProtocolError(`The sidecar identity field ${field} is outside supported bounds.`);
  }
  return number;
}

function requireIdentityMaskingMode(value: unknown, field: string): IdentityMaskingMode {
  if (value === "real" || value === "masked" || value === "custom") {
    return value;
  }
  throw makeProtocolError(`The sidecar identity field ${field} must be a supported mode.`);
}

function requireIdentityNoiseMode(value: unknown, field: string): IdentityNoiseMode {
  if (value === "real" || value === "noise") {
    return value;
  }
  throw makeProtocolError(`The sidecar identity field ${field} must be a supported mode.`);
}

function requireWebRtcPolicy(value: unknown, field: string): WebRtcPolicy {
  if (value === "real" || value === "disableNonProxiedUdp" || value === "block") {
    return value;
  }
  throw makeProtocolError(`The sidecar identity field ${field} must be a supported WebRTC policy.`);
}

function requireIdentitySurfaceName(value: unknown, field: string): IdentitySurface {
  if (
    value === "browser" ||
    value === "navigator" ||
    value === "screen" ||
    value === "locale" ||
    value === "canvas" ||
    value === "audio" ||
    value === "webgl" ||
    value === "webrtc"
  ) {
    return value;
  }
  throw makeProtocolError(`The sidecar identity warning field ${field} must be a known surface.`);
}

function requireIdentityAuditSurface(value: unknown, field: string): IdentityAuditSurface {
  if (value === "clientHints") {
    return value;
  }
  return requireIdentitySurfaceName(value, field);
}

function requireIdentityAuditCategory(value: unknown, field: string): IdentityAuditCategory {
  if (value === "browserleaks" || value === "consistency" || value === "privacy") {
    return value;
  }
  throw makeProtocolError(`The sidecar identity audit field ${field} must be a known category.`);
}

function requireIdentityAuditPageResultStatus(value: unknown, field: string): "captured" | "needs-user-action" | "unavailable" {
  if (value === "captured" || value === "needs-user-action" || value === "unavailable") {
    return value;
  }
  throw makeProtocolError(`The sidecar identity audit field ${field} must be a known result status.`);
}

function requireIdentityAuditUrl(value: unknown, expectedUrl: string, field: string): string {
  const url = requireString(value, field);
  if (url !== expectedUrl) {
    throw makeProtocolError(`The sidecar identity audit field ${field} must match the fixed HTTPS catalog URL.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw makeProtocolError(`The sidecar identity audit field ${field} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    throw makeProtocolError(`The sidecar identity audit field ${field} must be a safe public HTTPS URL.`);
  }
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "0.0.0.0") {
    throw makeProtocolError(`The sidecar identity audit field ${field} must not target loopback.`);
  }
  return url;
}

function requireAuditClientId(value: unknown, field: string): string {
  const id = requireNonBlankString(value, field);
  if (id.length > 128 || isPathLikeOrUrl(id) || containsControlCharacters(id) || !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw makeProtocolError(`The sidecar identity audit field ${field} must be an opaque safe id.`);
  }
  return id;
}

function requireAuditSafeText(value: unknown, field: string, options: { maxLength: number }): string {
  const text = requireNonBlankString(value, field);
  if (text.length > options.maxLength || containsControlCharacters(text) || containsUnsafeAuditText(text)) {
    throw makeProtocolError(`The sidecar identity audit field ${field} must be safe UI copy.`);
  }
  return text;
}

function containsUnsafeAuditText(value: string): boolean {
  const lowered = value.toLowerCase();
  if (
    [
      "devtoolsactiveport",
      "remote-debugging-port",
      "debug port",
      "websocket",
      "ws://",
      "wss://",
      "target id",
      "targetid",
      "raw argv",
      "user-data-dir",
      "profile-store",
      "traceback",
      "proxy_user",
      "proxy_pass",
      "proxyuser",
      "proxyusername",
      "proxypass",
      "proxypassword",
      "authcredentials",
      "credentials",
      "username=",
      "token=",
      "password=",
      "secret=",
      "guaranteed undetectability",
      "guaranteed green",
      "guaranteed pass",
    ].some((marker) => lowered.includes(marker))
  ) {
    return true;
  }
  if (/\b(?:file|ws|wss):\/\//i.test(value)) {
    return true;
  }
  if (/(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}/.test(value) || /[A-Za-z]:[\\/][^\s]+/.test(value)) {
    return true;
  }
  return false;
}

function requireAutomationApiKeys(record: Record<string, unknown>, allowed: string[], required: string[], field: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw makeProtocolError(`The automation API field ${field} contains unknown fields.`);
    }
  }
  for (const key of required) {
    if (!(key in record)) {
      throw makeProtocolError(`The automation API field ${field} is missing required fields.`);
    }
  }
}

function assertNoForbiddenAutomationApiFields(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenAutomationApiFields(item, `${field}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === "string" && containsUnsafeAutomationApiText(value)) {
      throw makeProtocolError(`The automation API field ${field} must not expose token material, raw diagnostics, app-data roots, or debug endpoints.`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_AUTOMATION_API_FIELD_TOKENS.has(fieldToken(key))) {
      throw makeProtocolError(`The automation API field ${field}.${key} must not expose token material, raw diagnostics, app-data roots, or debug endpoints.`);
    }
    assertNoForbiddenAutomationApiFields(item, `${field}.${key}`);
  }
}

function containsUnsafeAutomationApiText(value: string): boolean {
  const lowered = value.toLowerCase();
  if (FORBIDDEN_AUTOMATION_API_TEXT_MARKERS.some((marker) => lowered.includes(marker))) {
    return true;
  }
  if (/(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}/.test(value) || /(?:^|\s)[A-Za-z]:[\\/][^\s]+/.test(value)) {
    return true;
  }
  return false;
}

function requireAutomationApiLifecycleStatus(value: unknown, field: string): AutomationApiLifecycleStatus {
  if (value === "stopped" || value === "running") {
    return value;
  }
  throw makeProtocolError(`The automation API field ${field} must be a known lifecycle status.`);
}

function requireAutomationApiLoopbackHost(value: unknown, field: string): string {
  const host = requireString(value, field).trim();
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return host;
  }
  const parts = host.split(".");
  if (parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return host;
  }
  throw makeProtocolError(`The automation API field ${field} must be a loopback IP address.`);
}

function requireAutomationApiLoopbackUrl(value: unknown, host: string, port: number, field: string): string {
  const url = requireString(value, field);
  const expectedUrl = host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
  if (url !== expectedUrl) {
    throw makeProtocolError(`The automation API field ${field} must match the loopback endpoint.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw makeProtocolError(`The automation API field ${field} must be a valid loopback URL.`);
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw makeProtocolError(`The automation API field ${field} must be a safe loopback URL.`);
  }
  return url;
}

function requireAutomationApiErrorPhase(value: unknown, field: string): string {
  const phase = requireNonBlankString(value, field);
  if (phase.length > 64 || containsControlCharacters(phase) || !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(phase)) {
    throw makeProtocolError(`The automation API field ${field} must be a safe lifecycle phase.`);
  }
  return phase;
}

function requireAutomationApiSafeText(value: unknown, field: string, options: { maxLength: number }): string {
  const text = requireNonBlankString(value, field);
  if (text.length > options.maxLength || containsControlCharacters(text) || containsUnsafeAutomationApiText(text)) {
    throw makeProtocolError(`The automation API field ${field} must be safe UI copy.`);
  }
  return text;
}

function requireExactProxyCheckKeys(record: Record<string, unknown>, keys: string[], field: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw makeProtocolError(`The sidecar proxy check field ${field} contains unknown fields.`);
    }
  }
  for (const key of keys) {
    if (!(key in record)) {
      throw makeProtocolError(`The sidecar proxy check field ${field} is missing required fields.`);
    }
  }
}

function assertNoForbiddenProxyCheckFields(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenProxyCheckFields(item, `${field}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === "string" && containsUnsafeProxyCheckText(value)) {
      throw makeProtocolError(`The sidecar proxy check field ${field} must not expose credentials, runtime details, or raw checker content.`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_PROXY_CHECK_FIELD_TOKENS.has(fieldToken(key))) {
      throw makeProtocolError(`The sidecar proxy check field ${field}.${key} must not expose credentials, runtime details, or raw checker content.`);
    }
    assertNoForbiddenProxyCheckFields(item, `${field}.${key}`);
  }
}

function containsUnsafeProxyCheckText(value: string): boolean {
  const lowered = value.toLowerCase();
  if (FORBIDDEN_PROXY_CHECK_TEXT_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()))) {
    return true;
  }
  if (/\b(?:file|ws|wss):\/\//i.test(value)) {
    return true;
  }
  if (/(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}/.test(value) || /(?:^|\s)[A-Za-z]:[\\/][^\s]+/.test(value)) {
    return true;
  }
  return false;
}

function requireProfileClientId(value: unknown, field: string): string {
  const id = requireNonBlankString(value, field);
  if (id.length > 128 || isPathLikeOrUrl(id) || containsControlCharacters(id) || !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw makeProtocolError(`The sidecar profile field ${field} must be an opaque safe id.`);
  }
  return id;
}

function requireDialogPathString(value: unknown, field: string): string {
  const path = requireString(value, field);
  if (!path.trim() || path.length > 4096 || containsControlCharacters(path) || path.includes("\0")) {
    throw makeProtocolError(`The sidecar portability field ${field} must be a bounded non-empty dialog path string.`);
  }
  return path;
}

function requireProfilePackageVersion(value: unknown, field: string): 1 {
  return requireLiteralNumber(value, field, PROFILE_PACKAGE_VERSION);
}

function requireProfilePackageFormat(value: unknown, field: string): typeof PROFILE_PACKAGE_FORMAT {
  if (value !== PROFILE_PACKAGE_FORMAT) {
    throw makeProtocolError(`The sidecar profile package field ${field} must be the supported package format.`);
  }
  return PROFILE_PACKAGE_FORMAT;
}

function requireProfilePackageOperation<T extends "export" | "import">(
  value: unknown,
  field: string,
  expected: T,
): T {
  if (value !== expected) {
    throw makeProtocolError(`The sidecar profile package field ${field} must be ${expected}.`);
  }
  return expected;
}

function requireExactProfilePackageKeys(record: Record<string, unknown>, keys: string[], field: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw makeProtocolError(`The sidecar profile package field ${field} contains unknown fields.`);
    }
  }
  for (const key of keys) {
    if (!(key in record)) {
      throw makeProtocolError(`The sidecar profile package field ${field} is missing required fields.`);
    }
  }
}

function assertNoForbiddenProfilePackageFields(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenProfilePackageFields(item, `${field}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === "string" && containsUnsafeProfilePackageText(value)) {
      throw makeProtocolError(`The sidecar profile package field ${field} must not expose selected paths, package members, manifests, cookies, credentials, runtime roots, diagnostics, debug endpoints, or launch details.`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_PROFILE_PACKAGE_FIELD_TOKENS.has(fieldToken(key))) {
      throw makeProtocolError(`The sidecar profile package field ${field}.${key} must not expose selected paths, package members, manifests, cookies, credentials, runtime roots, diagnostics, debug endpoints, or launch details.`);
    }
    assertNoForbiddenProfilePackageFields(item, `${field}.${key}`);
  }
}

function requireProfilePackageSafeText(value: unknown, field: string, options: { maxLength: number }): string {
  const text = requireNonBlankString(value, field);
  if (text.length > options.maxLength || containsControlCharacters(text) || containsUnsafeProfilePackageText(text)) {
    throw makeProtocolError(`The sidecar profile package field ${field} must be safe UI copy.`);
  }
  return text;
}

function containsUnsafeProfilePackageText(value: string): boolean {
  const lowered = value.toLowerCase();
  if (FORBIDDEN_PROFILE_PACKAGE_TEXT_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()))) {
    return true;
  }
  if (/\b(?:file|ws|wss):\/\//i.test(value)) {
    return true;
  }
  if (/(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}/.test(value) || /(?:^|\s)[A-Za-z]:[\\/][^\s]+/.test(value)) {
    return true;
  }
  return false;
}

function requireNonNegativeProfilePackageInteger(value: unknown, field: string): number {
  const number = requireNumber(value, field);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw makeProtocolError(`The sidecar profile package field ${field} must be a non-negative safe integer.`);
  }
  return number;
}

function requirePositiveProfilePackageInteger(value: unknown, field: string): number {
  const number = requireNumber(value, field);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw makeProtocolError(`The sidecar profile package field ${field} must be a positive safe integer.`);
  }
  return number;
}

function requireCookieExportFormat(value: unknown, field: string): CookieExportFormat {
  if (value === "netscape" || value === "theprivator-json") {
    return value;
  }
  throw makeProtocolError(`The sidecar cookie portability field ${field} must be a supported cookie export format.`);
}

function requireCookiePortabilityOperation<T extends "export" | "replace">(
  value: unknown,
  field: string,
  expected: T,
): T {
  if (value !== expected) {
    throw makeProtocolError(`The sidecar cookie portability field ${field} must be ${expected}.`);
  }
  return expected;
}

function requireExactCookiePortabilityKeys(record: Record<string, unknown>, keys: string[], field: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw makeProtocolError(`The sidecar cookie portability field ${field} contains unknown fields.`);
    }
  }
  for (const key of keys) {
    if (!(key in record)) {
      throw makeProtocolError(`The sidecar cookie portability field ${field} is missing required fields.`);
    }
  }
}

function assertNoForbiddenCookiePortabilityFields(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenCookiePortabilityFields(item, `${field}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === "string" && containsUnsafeCookiePortabilityText(value)) {
      throw makeProtocolError(`The sidecar cookie portability field ${field} must not expose cookie material, selected paths, runtime roots, diagnostics, or debug endpoints.`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_COOKIE_PORTABILITY_FIELD_TOKENS.has(fieldToken(key))) {
      throw makeProtocolError(`The sidecar cookie portability field ${field}.${key} must not expose cookie material, selected paths, runtime roots, diagnostics, or debug endpoints.`);
    }
    assertNoForbiddenCookiePortabilityFields(item, `${field}.${key}`);
  }
}

function requireCookiePortabilitySafeText(value: unknown, field: string, options: { maxLength: number }): string {
  const text = requireNonBlankString(value, field);
  if (text.length > options.maxLength || containsControlCharacters(text) || containsUnsafeCookiePortabilityText(text)) {
    throw makeProtocolError(`The sidecar cookie portability field ${field} must be safe UI copy.`);
  }
  return text;
}

function containsUnsafeCookiePortabilityText(value: string): boolean {
  const lowered = value.toLowerCase();
  if (FORBIDDEN_COOKIE_PORTABILITY_TEXT_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()))) {
    return true;
  }
  if (/\b(?:file|ws|wss):\/\//i.test(value)) {
    return true;
  }
  if (/(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}/.test(value) || /(?:^|\s)[A-Za-z]:[\\/][^\s]+/.test(value)) {
    return true;
  }
  return false;
}

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  const number = requireNumber(value, field);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw makeProtocolError(`The sidecar cookie portability field ${field} must be a non-negative safe integer.`);
  }
  return number;
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  const number = requireNumber(value, field);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw makeProtocolError(`The sidecar cookie portability field ${field} must be a positive safe integer.`);
  }
  return number;
}

function requireProxyCheckRouteProofStatus(value: unknown, field: string): ProxyCheckRouteProof["status"] {
  if (value === "not-run" || value === "proved") {
    return value;
  }
  throw makeProtocolError(`The sidecar proxy check field ${field} must be a known route proof status.`);
}

function requireProxyCheckRouteProofBasis(value: unknown, field: string): ProxyCheckRouteProof["basis"] {
  if (value === "direct-profile" || value === "sidecar-managed-local-fixture") {
    return value;
  }
  throw makeProtocolError(`The sidecar proxy check field ${field} must be a known route proof basis.`);
}

function requireProxyCheckScope(value: unknown, field: string): ProxyCheckRouteProof["scope"] {
  if (value === "not-applicable" || value === "local-fixture") {
    return value;
  }
  throw makeProtocolError(`The sidecar proxy check field ${field} must be a known proof scope.`);
}

function requireProxyCheckIpHidingStatus(value: unknown, field: string): ProxyCheckIpHiding["status"] {
  if (value === "not-proven" || value === "proved") {
    return value;
  }
  throw makeProtocolError(`The sidecar proxy check field ${field} must be a known IP-hiding status.`);
}

function requireProxyCheckIpHidingBasis(value: unknown, field: string): ProxyCheckIpHiding["basis"] {
  if (value === "direct-profile" || value === "route-proof-succeeded") {
    return value;
  }
  throw makeProtocolError(`The sidecar proxy check field ${field} must be a known IP-hiding basis.`);
}

function requireProxyCheckLocalFixtureConclusion(value: unknown, field: string): ProxyCheckIpHiding["localFixtureConclusion"] {
  if (value === "not-run" || value === "direct target IP hidden from the proof target by the managed fixture") {
    return value;
  }
  throw makeProtocolError(`The sidecar proxy check field ${field} must be a known local-fixture conclusion.`);
}

function requireProxyCheckWebRtcStatus(value: unknown, field: string): ProxyCheckWebRtc["status"] {
  if (value === "baseline-real" || value === "restricted") {
    return value;
  }
  throw makeProtocolError(`The sidecar proxy check field ${field} must be a known WebRTC status.`);
}

function requireProxyCheckWebRtcExposure(value: unknown, field: string): ProxyCheckWebRtc["localIpExposure"] {
  if (value === "real-local-ip-baseline" || value === "blocked" || value === "non-proxied-udp-disabled") {
    return value;
  }
  throw makeProtocolError(`The sidecar proxy check field ${field} must be a known WebRTC exposure classification.`);
}

function requireProxyCheckPublicCheckerId(value: unknown, field: string): ProxyCheckPublicCheckerPage["id"] {
  if (value === "cloudflare-trace" || value === "aws-checkip" || value === "webbrowsertools-webrtc") {
    return value;
  }
  throw makeProtocolError(`The sidecar proxy check field ${field} must be in the fixed public checker catalog.`);
}

function requireProxyCheckPublicCheckerSurface(value: unknown, field: string): ProxyCheckPublicCheckerSurface {
  if (value === "ip" || value === "webrtc") {
    return value;
  }
  throw makeProtocolError(`The sidecar proxy check field ${field} must be a known public checker surface.`);
}

function requireProxyCheckPublicCheckerUrl(value: unknown, expectedUrl: string, field: string): string {
  const url = requireString(value, field);
  if (url !== expectedUrl) {
    throw makeProtocolError(`The sidecar proxy check field ${field} must match the fixed HTTPS checker catalog URL.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw makeProtocolError(`The sidecar proxy check field ${field} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    throw makeProtocolError(`The sidecar proxy check field ${field} must be a safe public HTTPS URL.`);
  }
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "0.0.0.0") {
    throw makeProtocolError(`The sidecar proxy check field ${field} must not target loopback.`);
  }
  return url;
}

function requireProxyCheckHost(value: unknown, field: string): string {
  const host = requireNonBlankString(value, field).trim();
  if (host.length > 253 || containsControlCharacters(host) || /\s/.test(host) || /:\/\/|[\\/?#@]/.test(host)) {
    throw makeProtocolError(`The sidecar proxy check field ${field} must be a safe host.`);
  }
  if (!/^[A-Za-z0-9.:-]+$/.test(host)) {
    throw makeProtocolError(`The sidecar proxy check field ${field} must be a safe host.`);
  }
  return host;
}

function requireProxyCheckSafeText(value: unknown, field: string, options: { maxLength: number }): string {
  const text = requireNonBlankString(value, field);
  if (text.length > options.maxLength || containsControlCharacters(text) || containsUnsafeProxyCheckText(text)) {
    throw makeProtocolError(`The sidecar proxy check field ${field} must be safe UI copy.`);
  }
  return text;
}

function requireLiteralBoolean<T extends boolean>(value: unknown, field: string, expected: T): T {
  if (value !== expected) {
    throw makeProtocolError(`The sidecar response field ${field} must be ${expected}.`);
  }
  return expected;
}

function requireExactAuditKeys(record: Record<string, unknown>, keys: string[], field: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw makeProtocolError(`The sidecar identity audit field ${field} contains unknown fields.`);
    }
  }
  for (const key of keys) {
    if (!(key in record)) {
      throw makeProtocolError(`The sidecar identity audit field ${field} is missing required fields.`);
    }
  }
}

function assertNoForbiddenAuditFields(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenAuditFields(item, `${field}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_AUDIT_FIELDS.has(key)) {
      throw makeProtocolError(`The sidecar identity audit field ${field}.${key} must not expose runtime/debug details.`);
    }
    assertNoForbiddenAuditFields(item, `${field}.${key}`);
  }
}

function assertNoForbiddenPublicProfileFields(value: unknown, field: string, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenPublicProfileFields(item, `${field}[${index}]`, path));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_PUBLIC_PROXY_FIELD_TOKENS.has(fieldToken(key)) && !PUBLIC_PROFILE_FORBIDDEN_TOKEN_EXEMPT_PATHS.has(keyPath)) {
      throw makeProtocolError(`The sidecar public profile field ${field}.${key} must not expose proxy credentials or runtime details.`);
    }
    assertNoForbiddenPublicProfileFields(item, `${field}.${key}`, keyPath);
  }
}

function assertNoForbiddenPublicProxyFields(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenPublicProxyFields(item, `${field}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_PROXY_FIELD_TOKENS.has(fieldToken(key))) {
      throw makeProtocolError(`The sidecar public profile field ${field}.${key} must not expose proxy credentials or runtime details.`);
    }
    assertNoForbiddenPublicProxyFields(item, `${field}.${key}`);
  }
}

function requirePublicKeys(record: Record<string, unknown>, allowed: string[], required: string[], field: string): void {
  const allowedSet = new Set(allowed);
  const requiredSet = new Set(required);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw makeProtocolError(`The sidecar public profile field ${field} contains unknown fields.`);
    }
  }
  for (const key of requiredSet) {
    if (!(key in record)) {
      throw makeProtocolError(`The sidecar public profile field ${field} is missing required fields.`);
    }
  }
}

function parseEmptyWarningArray(value: unknown, field: string): [] {
  if (!Array.isArray(value) || value.length !== 0) {
    throw makeProtocolError(`The sidecar proxy validation field ${field} must be an empty warnings array.`);
  }
  return [];
}

function requireProfileProxyMode(value: unknown, field: string): ProfileProxyMode {
  if (value === "direct" || value === "fixedServer") {
    return value;
  }
  throw makeProtocolError(`The sidecar profile proxy field ${field} must be a supported mode.`);
}

function requireFingerprintMode(value: unknown, field: string): FingerprintMode {
  if (value === "disabled" || value === "managed") {
    return value;
  }

  throw makeProtocolError(`The sidecar profile result field ${field} must be a supported fingerprint mode.`);
}

function requireProxyProtocol(value: unknown, field: string): ProxyProtocol {
  if (value === "http" || value === "https" || value === "socks4" || value === "socks5") {
    return value;
  }
  throw makeProtocolError(`The sidecar profile proxy field ${field} must be a supported protocol.`);
}

function requireProxyCredentialState(value: unknown, field: string): ProxyCredentialState {
  if (value === "none" || value === "configured") {
    return value;
  }
  throw makeProtocolError(`The sidecar profile proxy field ${field} must be a supported credential state.`);
}

function requireProxyPort(value: unknown, field: string): number {
  const port = requireNumber(value, field);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw makeProtocolError(`The sidecar profile proxy field ${field} must be a valid port.`);
  }
  return port;
}

function requireProxyHost(value: unknown, field: string): string {
  const host = requireNonBlankString(value, field).trim();
  if (host.length > 253 || containsControlCharacters(host) || /\s/.test(host) || /:\/\/|[\\/?#@]/.test(host)) {
    throw makeProtocolError(`The sidecar profile proxy field ${field} must be a safe host.`);
  }
  if (!/^[A-Za-z0-9.:-]+$/.test(host)) {
    throw makeProtocolError(`The sidecar profile proxy field ${field} must be a safe host.`);
  }
  return host;
}

function requireProxySummary(value: unknown, field: string): string {
  const summary = requireNonBlankString(value, field);
  if (summary.length > 320 || containsControlCharacters(summary) || containsUnsafeProxySummaryText(summary)) {
    throw makeProtocolError(`The sidecar profile proxy field ${field} must be safe UI copy.`);
  }
  return summary;
}

function containsUnsafeProxySummaryText(value: string): boolean {
  const lowered = value.toLowerCase();
  if (["@", "credential", "password", "username", "proxyuser", "proxypass", "authcredentials", "debugport", "argv", "command"].some((marker) => lowered.includes(marker))) {
    return true;
  }
  return /(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function formatProxySummary(protocol: ProxyProtocol, host: string, port: number): string {
  const displayHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${protocol}://${displayHost}:${port}`;
}

function fieldToken(value: string): string {
  return value.toLowerCase().replace(/[\s_-]/g, "");
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function requireIdentityWarningPath(value: unknown, field: string, surface: IdentitySurface): string {
  const path = requireSafeDiagnosticString(value, field);
  if (!new RegExp(`^${surface}(?:\\.[A-Za-z][A-Za-z0-9]*(?:\\[\\])?)*$`).test(path)) {
    throw makeProtocolError(`The sidecar identity warning field ${field} must be a safe identity path.`);
  }
  return path;
}

function requireLanguageTag(value: unknown, field: string): string {
  const language = requireIdentityText(value, field, { maxLength: 20 });
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw makeProtocolError(`The sidecar identity field ${field} must be a valid language tag.`);
  }
  return language;
}

function parseLanguageArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw makeProtocolError(`The sidecar identity field ${field} must be a bounded language array.`);
  }
  return value.map((item, index) => requireLanguageTag(item, `${field}[${index}]`));
}

function requireTimezoneId(value: unknown, field: string): string {
  const timezone = requireIdentityText(value, field, { maxLength: 80 });
  if (!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(timezone)) {
    throw makeProtocolError(`The sidecar identity field ${field} must be a valid timezone id.`);
  }
  return timezone;
}

/**
 * Length in code points, matching Python's len().
 *
 * JavaScript string length counts UTF-16 units, so an emoji costs two. A note the
 * sidecar accepts and persists at exactly the bound would then fail this
 * boundary -- and rejecting one field rejects the whole profiles response.
 */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

function containsControlCharacters(value: string): boolean {
  // DEL included to match the sidecar's _contains_control_characters. Without it
  // this boundary accepts a notes, tag, or launch-arg value the producer rejects,
  // which is the wrong direction for a validator to be lenient in.
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function requireStoreVersion(value: unknown): 4 {
  if (value !== 4) {
    throw makeProtocolError("The sidecar profile result field storeVersion must be 4.");
  }

  return 4;
}

function requireNonBlankString(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!text.trim()) {
    throw makeProtocolError(`The sidecar response field ${field} must be a non-empty string.`);
  }

  return text;
}

function requireIsoTimestamp(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!text.endsWith("Z") || Number.isNaN(Date.parse(text))) {
    throw makeProtocolError(`The sidecar response field ${field} must be a UTC ISO timestamp string.`);
  }

  return text;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  const number = requireNumber(value, field);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw makeProtocolError(`The sidecar response field ${field} must be a non-negative integer.`);
  }

  return number;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const number = requireNumber(value, field);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw makeProtocolError(`The sidecar response field ${field} must be a positive integer.`);
  }

  return number;
}

function requireLiteralNumber<T extends number>(value: unknown, field: string, expected: T): T {
  if (value !== expected) {
    throw makeProtocolError(`The sidecar response field ${field} must be ${expected}.`);
  }

  return expected;
}

function requireDetailRef(value: unknown, field: string): string {
  const detailRef = requireNonBlankString(value, field);
  if (!isValidDetailRef(detailRef)) {
    throw makeProtocolError(`The sidecar response field ${field} must be an opaque detailRef.`);
  }

  return detailRef;
}

function requireDiagnosticLookupReason(value: unknown, field: string): DiagnosticLookupReason {
  if (value === "found" || value === "not-persisted" || value === "ui-local" || value === "invalid-detail-ref") {
    return value;
  }

  throw makeProtocolError(`The diagnostics lookup field ${field} must be a known reason.`);
}

function requireDiagnosticSource(value: unknown, field: string): DiagnosticSource {
  if (value === "python-sidecar" || value === "rust-bridge") {
    return value;
  }

  throw makeProtocolError(`The diagnostics lookup field ${field} must be a known source.`);
}

function requireDiagnosticEvent(value: unknown, field: string): DiagnosticEvent {
  if (value === "sidecar.request" || value === "sidecar.bridge_failure" || value === "legacy.import.outcome") {
    return value;
  }

  throw makeProtocolError(`The diagnostics lookup field ${field} must be a known event.`);
}

function requireDiagnosticStatus(value: unknown, field: string): DiagnosticStatus {
  if (value === "ok" || value === "error" || value === "partial" || value === "failed") {
    return value;
  }

  throw makeProtocolError(`The diagnostics lookup field ${field} must be a known status.`);
}

function parseDiagnosticLogPath(value: unknown, field: string): DiagnosticLogPath | null {
  if (value === null) {
    return null;
  }
  const logPath = requireString(value, field);
  if (logPath !== DIAGNOSTIC_RELATIVE_LOG_PATH) {
    throw makeProtocolError(`The diagnostics lookup field ${field} must use the fixed relative diagnostics log path.`);
  }

  return DIAGNOSTIC_RELATIVE_LOG_PATH;
}

function requireDiagnosticEntryLogPath(value: unknown, field: string): DiagnosticLogPath {
  const logPath = parseDiagnosticLogPath(value, field);
  if (logPath === null) {
    throw makeProtocolError(`The diagnostics lookup field ${field} must include the fixed relative diagnostics log path.`);
  }

  return logPath;
}

function requireDiagnosticErrorCode(value: unknown, field: string): string {
  const errorCode = requireNonBlankString(value, field);
  if (
    errorCode.length > 96 ||
    !/^[A-Z][A-Z0-9_]+$/.test(errorCode) ||
    isPathLikeOrUrl(errorCode)
  ) {
    throw makeProtocolError(`The diagnostics lookup field ${field} must be a safe error code.`);
  }

  return errorCode;
}

function parseDiagnosticJsonScalar(value: unknown, field: string): JsonScalar {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw makeProtocolError(`The diagnostics lookup field ${field} must be a finite scalar.`);
    }
    return value;
  }
  if (typeof value === "string") {
    return requireSafeDiagnosticString(value, field);
  }

  throw makeProtocolError(`The diagnostics lookup field ${field} must be a JSON scalar.`);
}

function parseDiagnosticLegacyContext(value: unknown, field: string): DiagnosticLegacyContext {
  const context = requireRecord(value, `The diagnostics lookup field ${field} must be an object.`);
  const keys = Object.keys(context);
  if (keys.length !== 1 || !keys.includes("legacyId")) {
    throw makeProtocolError(`The diagnostics lookup field ${field} must contain only legacyId.`);
  }

  return {
    legacyId: requireLegacyId(context.legacyId, `${field}.legacyId`),
  };
}

function requireSafeMethod(value: unknown, field: string): string {
  const method = requireSafeDiagnosticString(value, field);
  if (!method.includes(".") || !method.split(".").every(isSafeMethodSegment)) {
    throw makeProtocolError(`The diagnostics lookup field ${field} must be a safe method name.`);
  }

  return method;
}

function requireSafeDiagnosticString(value: unknown, field: string): string {
  const text = requireNonBlankString(value, field);
  if (text.length > 256 || isPathLikeOrUrl(text) || containsSensitiveDiagnosticMarker(text)) {
    throw makeProtocolError(`The diagnostics lookup field ${field} must be a safe diagnostic string.`);
  }

  return text;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  const number = requireNumber(value, field);
  if (number < 0) {
    throw makeProtocolError(`The diagnostics lookup field ${field} must be non-negative.`);
  }

  return number;
}

function parseDiagnosticExitCode(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }
  const exitCode = requireNumber(value, field);
  if (!Number.isInteger(exitCode)) {
    throw makeProtocolError(`The diagnostics lookup field ${field} must be an integer or null.`);
  }

  return exitCode;
}

function requireLegacyId(value: unknown, field: string): string {
  const legacyId = requireNonBlankString(value, field);
  const suffix = legacyId.startsWith("legacy-") ? legacyId.slice("legacy-".length) : "";
  if (!legacyId.startsWith("legacy-") || !suffix || suffix.length > 96 || isPathLikeOrUrl(legacyId) || !/^[A-Za-z0-9_.:-]+$/.test(suffix)) {
    throw makeProtocolError(`The sidecar legacy field ${field} must be an opaque legacy id.`);
  }

  return legacyId;
}

function requireLegacyUserDataStatus(value: unknown, field: string): LegacyUserDataStatus {
  if (value === "available" || value === "missing") {
    return value;
  }

  throw makeProtocolError(`The sidecar legacy field ${field} must be a known user-data status.`);
}

function requireLegacyImportOutcomeStatus(value: unknown, field: string): LegacyImportOutcomeStatus {
  if (value === "success" || value === "partial" || value === "failed") {
    return value;
  }

  throw makeProtocolError(`The sidecar legacy import field ${field} must be a known outcome status.`);
}

function requireLegacyImportCopyStatus(value: unknown, field: string): LegacyImportCopyStatus {
  if (value === "copied" || value === "missing" || value === "failed" || value === "skipped") {
    return value;
  }

  throw makeProtocolError(`The sidecar legacy import field ${field} must be a known copy status.`);
}

function optionalNonBlankString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return requireNonBlankString(value, field);
}

function parseSafePublicMetadata(value: unknown, field: string): JsonObject {
  assertNoForbiddenPublicProfileFields(value, field);
  return parseSafeJsonObject(value, field);
}

function parseSafeJsonObject(value: unknown, field: string): JsonObject {
  const record = requireRecord(value, `The sidecar response field ${field} must be an object.`);
  const parsed: JsonObject = {};
  for (const [key, item] of Object.entries(record)) {
    if (!key) {
      throw makeProtocolError(`The sidecar response field ${field} contains an empty metadata key.`);
    }
    parsed[key] = parseSafeJsonValue(item, `${field}.${key}`);
  }
  return parsed;
}

function parseSafeJsonValue(value: unknown, field: string): JsonValue {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (isPathLikeOrUrl(value)) {
      throw makeProtocolError(`The sidecar response field ${field} must not contain a path-like metadata string.`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw makeProtocolError(`The sidecar response field ${field} must contain a finite metadata number.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => parseSafeJsonValue(item, `${field}[${index}]`));
  }
  if (isRecord(value)) {
    return parseSafeJsonObject(value, field);
  }

  throw makeProtocolError(`The sidecar response field ${field} must contain JSON-safe metadata.`);
}

function isPathLikeOrUrl(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes("://") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  );
}

function isValidDetailRef(value: string): boolean {
  if (value.length > 256 || isPathLikeOrUrl(value)) {
    return false;
  }
  const [prefix, ...suffixParts] = value.split("-");
  if (suffixParts.length === 0) {
    return false;
  }
  if (prefix !== "sidecar" && prefix !== "bridge" && prefix !== "ui") {
    return false;
  }
  const detailSuffix = suffixParts.join("-");
  return detailSuffix.length > 0 && detailSuffix.length <= 127 && /^[A-Za-z0-9_.:-]+$/.test(detailSuffix);
}

function isSafeMethodSegment(segment: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(segment);
}

function containsSensitiveDiagnosticMarker(value: string): boolean {
  const lowered = value.toLowerCase();
  return [
    "traceback",
    "stdout",
    "stderr",
    "params",
    "authcredentials",
    "credential=",
    "credentials",
    "proxy_user",
    "proxy_pass",
    "proxyuser",
    "proxyusername",
    "proxypass",
    "proxypassword",
    "username=",
    "token=",
    "password=",
    "secret=",
    "--user-data-dir",
  ].some((marker) => lowered.includes(marker));
}

function compactOptionalFields<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function requireChromiumTermination(value: unknown, field: string): ChromiumTermination {
  if (value === "already-stopped" || value === "graceful" || value === "forced" || value === "reconciled") {
    return value;
  }

  throw makeProtocolError(`The sidecar response field ${field} must be a known Chromium termination value.`);
}

function requireChromiumUserDataDir(value: unknown, profileId: string, field: string): string {
  const userDataDir = requireRelativeStoragePath(value, field);
  const expectedUserDataDir = `profile-store/profiles/${profileId}/user-data`;

  if (userDataDir !== expectedUserDataDir) {
    throw makeProtocolError(`The sidecar Chromium result field ${field} must match the profile id.`);
  }

  return userDataDir;
}

function requireLiteral<T extends string>(value: unknown, field: string, expected: T): T {
  if (value !== expected) {
    throw makeProtocolError(`The sidecar response field ${field} must be ${expected}.`);
  }

  return expected;
}

function requireRelativeStoragePath(value: unknown, field: string): string {
  const path = requireNonBlankString(value, field);
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path) || path.includes("\0")) {
    throw makeProtocolError(`The sidecar response field ${field} must be a relative storage path.`);
  }

  return path;
}

function sameProfileRecord(left: ProfileRecord, right: ProfileRecord): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.storage.profileDir === right.storage.profileDir &&
    left.storage.userDataDir === right.storage.userDataDir &&
    left.defaults.browser === right.defaults.browser &&
    left.defaults.startUrl === right.defaults.startUrl &&
    left.defaults.proxyMode === right.defaults.proxyMode &&
    left.defaults.fingerprintMode === right.defaults.fingerprintMode &&
    JSON.stringify(left.identity) === JSON.stringify(right.identity) &&
    JSON.stringify(left.proxy) === JSON.stringify(right.proxy) &&
    JSON.stringify(left.organization) === JSON.stringify(right.organization) &&
    JSON.stringify(left.launch) === JSON.stringify(right.launch) &&
    JSON.stringify(left.lifecycle) === JSON.stringify(right.lifecycle) &&
    JSON.stringify(left.sync) === JSON.stringify(right.sync) &&
    JSON.stringify(left.metadata ?? null) === JSON.stringify(right.metadata ?? null)
  );
}

function parseRequestTiming(value: unknown): { durationMs: number } {
  const request = requireRecord(value, "The sidecar health request timing must be an object.");
  return {
    durationMs: requireNumber(request.durationMs, "request.durationMs"),
  };
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw makeProtocolError(`The sidecar health result field ${field} must be a string array.`);
  }

  return value;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw makeProtocolError(message);
  }

  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw makeProtocolError(`The sidecar response field ${field} must be a string.`);
  }

  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw makeProtocolError(`The sidecar response field ${field} must be a finite number.`);
  }

  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw makeProtocolError(`The sidecar response field ${field} must be a boolean.`);
  }

  return value;
}

function makeProtocolError(message: string): SidecarClientError {
  return {
    code: SIDECAR_PROTOCOL_ERROR,
    message,
    recoverable: true,
    detailRef: makeDetailRef("protocol"),
    source: "protocol",
    phase: "bridge-error",
  };
}

function makeDetailRef(scope: "bridge" | "protocol"): string {
  detailCounter += 1;
  return `ui-${scope}-${Date.now().toString(16)}-${detailCounter.toString(16)}`;
}

function sourceForCode(code: string): SidecarErrorSource {
  if (BRIDGE_ERROR_CODES.has(code)) {
    return code === SIDECAR_PROTOCOL_ERROR ? "protocol" : "bridge";
  }

  return "sidecar";
}

function isCommandErrorEnvelope(value: unknown): value is SidecarCommandErrorEnvelope {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.recoverable === "boolean" &&
    typeof value.detailRef === "string"
  );
}

function isSidecarClientError(value: unknown): value is SidecarClientError {
  if (!isCommandErrorEnvelope(value) || !isRecord(value)) {
    return false;
  }

  const source = value.source;
  return source === "sidecar" || source === "bridge" || source === "protocol" || source === "ui";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function formatRequestId(value: JsonScalar): string {
  return value === null ? "null" : String(value);
}

function extractErrorMessage(_error: unknown): string {
  return "The Tauri bridge rejected the sidecar request before returning a typed error.";
}
