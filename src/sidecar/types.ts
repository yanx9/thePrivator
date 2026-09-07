export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type SidecarUiPhase = "loading" | "healthy" | "recoverable-error" | "bridge-error";

export type SidecarErrorSource = "sidecar" | "bridge" | "protocol" | "ui";

export type SidecarHealthStatusValue = "healthy" | "degraded" | string;

export interface SidecarCommandSuccessEnvelope {
  requestId: JsonScalar;
  protocolVersion: string;
  durationMs: number;
  result: unknown;
}

export interface SidecarCommandErrorEnvelope {
  code: string;
  message: string;
  recoverable: boolean;
  detailRef: string;
}

export interface SidecarClientError extends SidecarCommandErrorEnvelope {
  source: SidecarErrorSource;
  phase: Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;
}

export interface SidecarHealthPayload {
  status: SidecarHealthStatusValue;
  product: {
    name: string;
    version: string;
  };
  sidecar: {
    version: string;
  };
  protocol: {
    version: string;
  };
  runtime: {
    pythonVersion: string;
    implementation: string;
  };
  platform: {
    system: string;
    release: string;
    machine: string;
  };
  build: {
    mode: string;
    frozen: boolean;
  };
  request?: {
    durationMs: number;
  };
  degradedFields?: string[];
}

export interface SidecarHealthSnapshot {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  checkedAt: string;
  health: SidecarHealthPayload;
}

export const DIAGNOSTIC_RELATIVE_LOG_PATH = "profile-store/diagnostics/events.jsonl" as const;

export type DiagnosticSource = "python-sidecar" | "rust-bridge";
export type DiagnosticEvent = "sidecar.request" | "sidecar.bridge_failure" | "legacy.import.outcome";
export type DiagnosticStatus = "ok" | "error" | "partial" | "failed";
export type DiagnosticLookupReason = "found" | "not-persisted" | "ui-local" | "invalid-detail-ref";
export type DiagnosticLogPath = typeof DIAGNOSTIC_RELATIVE_LOG_PATH;

export interface DiagnosticLegacyContext {
  legacyId: string;
}

export interface DiagnosticEntryBase {
  schemaVersion: 1;
  ts: string;
  source: DiagnosticSource;
  event: DiagnosticEvent;
  status: DiagnosticStatus;
  logPath: DiagnosticLogPath;
  requestId?: JsonScalar;
  method?: string;
  durationMs?: number;
  errorCode: string;
  detailRef: string;
}

export interface SidecarRequestDiagnosticEntry extends DiagnosticEntryBase {
  source: "python-sidecar";
  event: "sidecar.request";
  status: "error";
}

export interface LegacyImportDiagnosticEntry extends DiagnosticEntryBase {
  source: "python-sidecar";
  event: "legacy.import.outcome";
  status: "partial" | "failed";
  context?: DiagnosticLegacyContext;
}

export interface BridgeFailureDiagnosticEntry extends DiagnosticEntryBase {
  source: "rust-bridge";
  event: "sidecar.bridge_failure";
  status: "error";
  exitCode?: number | null;
  stdoutLines?: number;
  stderrLines?: number;
}

export type DiagnosticEntry =
  | SidecarRequestDiagnosticEntry
  | LegacyImportDiagnosticEntry
  | BridgeFailureDiagnosticEntry;

export interface DiagnosticLookupResult {
  found: boolean;
  detailRef: string;
  logPath: DiagnosticLogPath | null;
  reason: DiagnosticLookupReason;
  entries: DiagnosticEntry[];
}

export type FingerprintMode = "disabled" | "managed";

export type IdentitySurface =
  | "browser"
  | "navigator"
  | "screen"
  | "locale"
  | "canvas"
  | "audio"
  | "webgl"
  | "webrtc"
  | "geolocation"
  | "mediaDevices"
  | "ports";
export type IdentityMaskingMode = "real" | "masked" | "custom";
// Geolocation deliberately omits "masked": the sidecar has no mode that derives a
// position, so a masked geolocation would be a mode nothing can produce.
export type IdentityGeolocationMode = Exclude<IdentityMaskingMode, "masked">;
export type IdentityGeolocationPermission = "prompt" | "allow" | "block";
export type IdentityNoiseMode = "real" | "noise";
export type WebRtcPolicy = "real" | "disableNonProxiedUdp" | "block";

export type ProfileProxyMode = "direct" | "fixedServer";
export type ProxyProtocol = "http" | "https" | "socks4" | "socks5";
export type ProxyCredentialState = "none" | "configured";

export interface DirectProxySummary {
  proxyVersion: 1;
  mode: "direct";
  credentialState: "none";
  summary: "Direct connection";
}

export interface FixedServerProxySummary {
  proxyVersion: 1;
  mode: "fixedServer";
  protocol: ProxyProtocol;
  host: string;
  port: number;
  credentialState: ProxyCredentialState;
  summary: string;
}

export type ProfileProxySummary = DirectProxySummary | FixedServerProxySummary;

export interface FixedServerProxyCredentials {
  username: string;
  password: string;
}

export interface DirectProxyDraft {
  proxyVersion: 1;
  mode: "direct";
}

export interface FixedServerProxyDraft {
  proxyVersion: 1;
  mode: "fixedServer";
  protocol: ProxyProtocol;
  host: string;
  port: number;
  credentials?: FixedServerProxyCredentials | null;
}

export type ProfileProxyDraft = DirectProxyDraft | FixedServerProxyDraft;

export interface ProxyValidationResult {
  proxyVersion: 1;
  proxy: ProfileProxySummary;
  warnings: [];
}

export interface ProxyValidationSnapshot extends ProxyValidationResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export type CookieExportFormat = "netscape" | "theprivator-json";
export type CookiePortabilityOperation = "export" | "replace";

export interface CookiePortabilityWarning {
  code: string;
  message: string;
  count: number;
}

export interface CookieExportResult {
  portabilityVersion: 1;
  profileId: string;
  operation: Extract<CookiePortabilityOperation, "export">;
  format: CookieExportFormat;
  exportedCount: number;
  skippedCount: number;
  warningCount: number;
  warnings: CookiePortabilityWarning[];
}

export interface CookieExportSnapshot extends CookieExportResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface CookieReplaceResult {
  portabilityVersion: 1;
  profileId: string;
  operation: Extract<CookiePortabilityOperation, "replace">;
  format: CookieExportFormat;
  importedCount: number;
  replacedCount: number;
  skippedCount: number;
  warningCount: number;
  warnings: CookiePortabilityWarning[];
}

export interface CookieReplaceSnapshot extends CookieReplaceResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export type ProfilePackageOperation = "export" | "import";

export interface ProfilePackageWarning {
  code: string;
  message: string;
  count: number;
}

export interface ProfilePackageExportResult {
  portabilityVersion: 1;
  packageVersion: 3;
  operation: Extract<ProfilePackageOperation, "export">;
  profileId: string;
  profileName: string;
  portableSessionCount: number;
  payloadFileCount: number;
  payloadBytes: number;
  payloadSkippedCount: number;
  warningCount: number;
  warnings: ProfilePackageWarning[];
}

export interface ProfilePackageExportSnapshot extends ProfilePackageExportResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface ProfilePackageImportResult {
  portabilityVersion: 1;
  packageVersion: 3;
  operation: Extract<ProfilePackageOperation, "import">;
  importedProfileId: string;
  importedProfileName: string;
  nameConflictResolved: boolean;
  portableSessionCount: number;
  payloadFileCount: number;
  payloadBytes: number;
  payloadSkippedCount: number;
  warningCount: number;
  warnings: ProfilePackageWarning[];
}

export interface ProfilePackageImportSnapshot extends ProfilePackageImportResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export type ProxyCheckRouteProofStatus = "not-run" | "proved";
export type ProxyCheckRouteProofBasis = "direct-profile" | "sidecar-managed-local-fixture";
export type ProxyCheckProofScope = "not-applicable" | "local-fixture";
export type ProxyCheckIpHidingStatus = "not-proven" | "proved";
export type ProxyCheckIpHidingBasis = "direct-profile" | "route-proof-succeeded";
export type ProxyCheckLocalFixtureConclusion = "not-run" | "direct target IP hidden from the proof target by the managed fixture";
export type ProxyCheckWebRtcStatus = "baseline-real" | "restricted";
export type ProxyCheckWebRtcExposure = "real-local-ip-baseline" | "blocked" | "non-proxied-udp-disabled";
export type ProxyCheckPublicCheckerStatus = "advisory-only";
export type ProxyCheckPublicCheckerBasis = "fixed-https-allowlist";
export type ProxyCheckPublicCheckerNetworkDependency = "user-driven-external-pages";
export type ProxyCheckPublicCheckerSurface = "ip" | "webrtc";

export interface ProxyCheckObservationCounts {
  proxy: number;
  target: number;
}

export interface ProxyCheckFixture {
  kind: ProxyProtocol;
  managed: true;
}

export interface ProxyCheckTarget {
  host: string;
  port: number;
}

export interface ProxyCheckRouteProof {
  status: ProxyCheckRouteProofStatus;
  basis: ProxyCheckRouteProofBasis;
  scope: ProxyCheckProofScope;
  protocol: ProxyProtocol | null;
  credentialState: ProxyCredentialState;
  durationMs: number;
  fixture: ProxyCheckFixture | null;
  target: ProxyCheckTarget | null;
  directFallbackDetected: false;
  observationCounts: ProxyCheckObservationCounts;
}

export interface ProxyCheckPublicExitLocation {
  country: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  isp: string | null;
}

export interface ProxyCheckIpHiding {
  status: ProxyCheckIpHidingStatus;
  basis: ProxyCheckIpHidingBasis;
  scope: ProxyCheckProofScope;
  publicExitIpClaimed: boolean;
  publicExitIp: string | null;
  publicExitLocation: ProxyCheckPublicExitLocation | null;
  localFixtureConclusion: ProxyCheckLocalFixtureConclusion;
}

export interface ProxyCheckWebRtc {
  status: ProxyCheckWebRtcStatus;
  basis: "profile-identity-policy";
  mode: IdentityMaskingMode;
  policy: WebRtcPolicy;
  localIpExposure: ProxyCheckWebRtcExposure;
}

export interface ProxyCheckPublicCheckerPage {
  id: "cloudflare-trace" | "aws-checkip" | "webbrowsertools-webrtc";
  label: string;
  url: string;
  surfaces: ProxyCheckPublicCheckerSurface[];
  advisory: string;
}

export interface ProxyCheckPublicCheckers {
  status: ProxyCheckPublicCheckerStatus;
  basis: ProxyCheckPublicCheckerBasis;
  networkDependency: ProxyCheckPublicCheckerNetworkDependency;
  pages: ProxyCheckPublicCheckerPage[];
}

export interface ProxyCheckResult {
  proxyCheckVersion: 1;
  profileId: string;
  proxy: ProfileProxySummary;
  routeProof: ProxyCheckRouteProof;
  ipHiding: ProxyCheckIpHiding;
  webRtc: ProxyCheckWebRtc;
  publicCheckers: ProxyCheckPublicCheckers;
}

export interface ProxyCheckSnapshot extends ProxyCheckResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface IdentityRealSurface {
  mode: "real";
}

export interface IdentityMaskedSurface {
  mode: "masked";
}

export interface BrowserClientHints {
  platform?: string;
  platformVersion?: string;
  architecture?: string;
  bitness?: string;
  model?: string;
  mobile?: boolean;
}

export interface BrowserMaskedSurface {
  mode: Exclude<IdentityMaskingMode, "real">;
  userAgent: string;
  clientHints?: BrowserClientHints;
}

export type BrowserIdentitySurface = IdentityRealSurface | BrowserMaskedSurface;

export interface NavigatorMaskedSurface {
  mode: Exclude<IdentityMaskingMode, "real">;
  platform: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  uaPlatform: string;
  uaPlatformVersion: string;
  uaArchitecture: string;
  uaMobile: boolean;
}

export type NavigatorIdentitySurface = IdentityRealSurface | NavigatorMaskedSurface;

export interface ScreenMaskedSurface {
  mode: Exclude<IdentityMaskingMode, "real">;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  colorDepth: number;
  pixelRatio: number;
}

export type ScreenIdentitySurface = IdentityRealSurface | ScreenMaskedSurface;

export interface LocaleMaskedSurface {
  mode: Exclude<IdentityMaskingMode, "real">;
  locale: string;
  languages: string[];
  timezoneId: string;
}

export type LocaleIdentitySurface = IdentityRealSurface | LocaleMaskedSurface;

export interface NoiseIdentitySurface {
  mode: "noise";
  noiseSeed: number;
}

export type CanvasIdentitySurface = IdentityRealSurface | NoiseIdentitySurface;
export type AudioIdentitySurface = IdentityRealSurface | NoiseIdentitySurface;

export interface WebGlMaskedSurface {
  mode: Exclude<IdentityMaskingMode, "real">;
  vendor: string;
  renderer: string;
  noiseSeed?: number;
}

export type WebGlIdentitySurface = IdentityRealSurface | WebGlMaskedSurface;

export interface WebRtcIdentitySurface {
  mode: IdentityMaskingMode;
  policy: WebRtcPolicy;
}

export interface GeolocationRealSurface {
  mode: Extract<IdentityGeolocationMode, "real">;
  permission: IdentityGeolocationPermission;
}

export interface GeolocationCustomSurface {
  mode: Exclude<IdentityGeolocationMode, "real">;
  permission: IdentityGeolocationPermission;
  latitude: number;
  longitude: number;
  accuracy: number;
  /** Always emitted in custom mode, null when the profile pins no altitude. */
  altitude: number | null;
}

export type GeolocationIdentitySurface = GeolocationRealSurface | GeolocationCustomSurface;

export interface MediaDevicesMaskedSurface {
  mode: "masked";
  noiseSeed: number;
}

export interface MediaDevicesCustomSurface {
  mode: "custom";
  videoInputs: number;
  audioInputs: number;
  audioOutputs: number;
}

export type MediaDevicesIdentitySurface = IdentityRealSurface | MediaDevicesMaskedSurface | MediaDevicesCustomSurface;

export interface PortsCustomSurface {
  mode: "custom";
  allowedPorts: number[];
}

export type PortsIdentitySurface = IdentityRealSurface | IdentityMaskedSurface | PortsCustomSurface;

export interface ProfileIdentity {
  identityVersion: 2;
  label: string;
  presetId: string | null;
  browser: BrowserIdentitySurface;
  navigator: NavigatorIdentitySurface;
  screen: ScreenIdentitySurface;
  locale: LocaleIdentitySurface;
  canvas: CanvasIdentitySurface;
  audio: AudioIdentitySurface;
  webgl: WebGlIdentitySurface;
  webrtc: WebRtcIdentitySurface;
  geolocation: GeolocationIdentitySurface;
  mediaDevices: MediaDevicesIdentitySurface;
  ports: PortsIdentitySurface;
}

export interface IdentityWarning {
  code: string;
  message: string;
  surface: IdentitySurface;
  path: string;
}

export type IdentityAuditSurface = IdentitySurface | "clientHints";
export type IdentityAuditCategory = "browserleaks" | "consistency" | "privacy";
export type IdentityAuditOpenStatus = "opened";

export interface IdentityAuditExpectedRow {
  surface: IdentityAuditSurface;
  label: string;
  expected: string;
  guidance: string;
}

export interface IdentityAuditPage {
  id: string;
  label: string;
  category: IdentityAuditCategory;
  url: string;
  surfaces: IdentityAuditSurface[];
  comparisonNote: string;
  requiresUserAction: boolean;
  expectedRows: IdentityAuditExpectedRow[];
}

export interface IdentityAuditPlanCopy {
  advisory: string;
  localProof: string;
  publicCheckerInstability: string;
}

export interface IdentityAuditPlanResult {
  auditVersion: 1;
  copy: IdentityAuditPlanCopy;
  pages: IdentityAuditPage[];
}

export interface IdentityAuditPlanSnapshot extends IdentityAuditPlanResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface IdentityAuditOpenResult {
  auditVersion: 1;
  profileId: string;
  pageId: string;
  status: IdentityAuditOpenStatus;
  openedAt: string;
  launched: boolean;
  runningCount: number;
  page: IdentityAuditPage;
}

export interface IdentityAuditOpenSnapshot extends IdentityAuditOpenResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export type IdentityAuditCollectStatus = "collected";
export type IdentityAuditPageResultStatus = "captured" | "needs-user-action" | "unavailable";

export interface IdentityAuditCollectedRow {
  label: string;
  value: string;
}

export interface IdentityAuditPageResult {
  id: string;
  label: string;
  category: IdentityAuditCategory;
  url: string;
  status: IdentityAuditPageResultStatus;
  capturedAt: string;
  title: string;
  summary: string;
  extractedRows: IdentityAuditCollectedRow[];
  notes: string[];
}

export interface IdentityAuditCollectResult {
  auditVersion: 1;
  profileId: string;
  status: IdentityAuditCollectStatus;
  collectedAt: string;
  launched: boolean;
  runningCount: number;
  pages: IdentityAuditPageResult[];
}

export interface IdentityAuditCollectSnapshot extends IdentityAuditCollectResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface IdentityPresetListResult {
  identityVersion: 2;
  presets: ProfileIdentity[];
  count: number;
}

export interface IdentityPresetListSnapshot extends IdentityPresetListResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface IdentityValidationResult {
  identityVersion: 2;
  identity: ProfileIdentity;
  warnings: IdentityWarning[];
}

export interface IdentityValidationSnapshot extends IdentityValidationResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export type IdentitySurfaceFieldType = "text" | "integer" | "number" | "list" | "enum";

export interface IdentitySurfaceFieldDescriptor {
  name: string;
  type: IdentitySurfaceFieldType;
  required: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  maxItems?: number;
  options?: string[];
}

export interface IdentitySurfaceDescriptor {
  id: IdentitySurface;
  modes: string[];
  fields: IdentitySurfaceFieldDescriptor[];
}

export interface IdentitySurfacesDescribeResult {
  identityVersion: 2;
  surfaces: IdentitySurfaceDescriptor[];
}

export interface IdentitySurfacesDescribeSnapshot extends IdentitySurfacesDescribeResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface ProfileDefaults {
  browser: "chromium";
  startUrl: string;
  proxyMode: ProfileProxyMode;
  fingerprintMode: FingerprintMode;
}

export interface ProfileStorage {
  profileDir: string;
  userDataDir: string;
}

export interface ProfileOrganization {
  folderId: string | null;
  tags: string[];
  notes: string;
  favorite: boolean;
  color: string | null;
}

export type ProfileStartupBehavior = "customUrls" | "restoreSession";

export interface ProfileLaunch {
  startupBehavior: ProfileStartupBehavior;
  startUrls: string[];
  args: string[];
}

export interface ProfileLifecycle {
  /** A non-null deletedAt means the profile sits in the trash and is absent from every profiles array. */
  deletedAt: string | null;
  lastLaunchedAt: string | null;
  launchCount: number;
}

export interface ProfileSync {
  revision: number;
  updatedBy: string;
  originDeviceId: string;
  lastSyncedAt: string | null;
  lastSyncedRevision: number | null;
}

export interface ProfileRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  defaults: ProfileDefaults;
  storage: ProfileStorage;
  identity: ProfileIdentity;
  proxy: ProfileProxySummary;
  organization: ProfileOrganization;
  launch: ProfileLaunch;
  lifecycle: ProfileLifecycle;
  sync: ProfileSync;
  metadata?: JsonObject;
}

export interface ProfileListResult {
  storeVersion: 4;
  profiles: ProfileRecord[];
  count: number;
}

export interface ProfileMutationResult extends ProfileListResult {
  profile?: ProfileRecord;
  warnings?: IdentityWarning[];
}

export interface ProfileProxyMutationResult extends ProfileMutationResult {
  profile: ProfileRecord;
}

export interface ProfileIdentityMutationResult extends ProfileMutationResult {
  profile: ProfileRecord;
  warnings: IdentityWarning[];
}

/**
 * What the UI sends to replace a profile's organization section.
 *
 * The whole section travels, not a patch: the sections are small and strict-key,
 * and a partial update would need its own merge rules plus a way to say "clear
 * this field" that is distinguishable from "leave it alone".
 */
export interface ProfileOrganizationDraft {
  folderId: string | null;
  tags: string[];
  notes: string;
  favorite: boolean;
  color: string | null;
}

export interface ProfileLaunchDraft {
  startupBehavior: ProfileStartupBehavior;
  startUrls: string[];
  args: string[];
}

export type SyncAction = "nothing" | "push" | "pull" | "conflict" | "deleteLocal" | "deleteRemote";

export type SyncConflictResolution = "keepLocal" | "keepRemote" | "keepBoth";

export interface SyncStatusResult {
  enabled: boolean;
  configured: boolean;
  /** The folder's own name. The full path never crosses the bridge. */
  folderName: string | null;
  deviceLabel: string;
  lastRunAt: string | null;
  trackedProfiles: number;
  reachable: boolean;
  writable: boolean;
  detail: string;
}

export interface SyncPlanEntry {
  profileId: string;
  name: string;
  action: SyncAction;
  reason: string;
  localRevision: number | null;
  remoteRevision: number | null;
  baseRevision: number | null;
}

export interface SyncPlanResult {
  plans: SyncPlanEntry[];
  counts: Record<SyncAction, number>;
}

export interface SyncAppliedEntry {
  profileId: string;
  name: string;
  action: string;
  /** A folder name under conflicts/, never a path. */
  keptCopyAs: string | null;
}

export interface SyncFailureEntry {
  profileId: string;
  name: string;
  code: string;
}

export interface SyncRunResult {
  applied: SyncAppliedEntry[];
  conflicts: SyncPlanEntry[];
  failures: SyncFailureEntry[];
  status: SyncStatusResult;
}

export interface SyncResolveResult {
  resolved: SyncAppliedEntry;
  resolution: SyncConflictResolution;
}

export interface SyncPrepareResult {
  prepared: boolean;
  reason?: string;
  profileId?: string;
  name?: string;
  action?: string;
  keptCopyAs?: string | null;
}

export interface SyncLockReleaseResult {
  released: boolean;
  previousHolder?: string;
  reason?: string;
}

export interface SyncStatusSnapshot extends SyncStatusResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface SyncPlanSnapshot extends SyncPlanResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface SyncRunSnapshot extends SyncRunResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface ProfileTrashListResult {
  storeVersion: 4;
  profiles: ProfileRecord[];
  count: number;
}

export interface ProfileTrashListSnapshot extends ProfileTrashListResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

/** One profile a bulk call could not act on, and the code that says why. */
export interface BulkFailure {
  profileId: string;
  code: string;
}

export interface ChromiumBulkLaunchResult {
  launched: Array<{ profileId: string; startedAt: string }>;
  failed: BulkFailure[];
  runningCount: number;
}

export interface ChromiumBulkStopResult {
  stopped: Array<{ profileId: string; termination: ChromiumTermination }>;
  failed: BulkFailure[];
  runningCount: number;
}

export interface ChromiumBulkLaunchSnapshot extends ChromiumBulkLaunchResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface ChromiumBulkStopSnapshot extends ChromiumBulkStopResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface ProfileListSnapshot extends ProfileListResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface ProfileMutationSnapshot extends ProfileMutationResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface ProfileProxyMutationSnapshot extends ProfileProxyMutationResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface ProfileIdentityMutationSnapshot extends ProfileIdentityMutationResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface LegacyIssue {
  code: string;
  message: string;
  detailRef: string;
}

export type LegacyUserDataStatus = "available" | "missing";

export interface LegacyScanCandidate {
  legacyId: string;
  folderName: string;
  legacyName: string | null;
  targetName: string;
  userData: {
    status: LegacyUserDataStatus;
  };
  metadata: JsonObject;
  issues: LegacyIssue[];
}

export interface LegacyScanResult {
  scanVersion: 1;
  count: number;
  candidates: LegacyScanCandidate[];
  issues: LegacyIssue[];
}

export interface LegacyScanSnapshot extends LegacyScanResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface LegacyImportSelection {
  legacyId: string;
  targetName: string;
}

export type LegacyImportOutcomeStatus = "success" | "partial" | "failed";
export type LegacyImportCopyStatus = "copied" | "missing" | "failed" | "skipped";

export interface LegacyImportOutcomeError extends SidecarCommandErrorEnvelope {}

export interface LegacyImportOutcomeBase {
  legacyId: string;
  targetName: string;
  folderName?: string;
  legacyName?: string;
  status: LegacyImportOutcomeStatus;
  copyStatus: LegacyImportCopyStatus;
}

export interface LegacyImportSuccessOutcome extends LegacyImportOutcomeBase {
  status: "success";
  copyStatus: "copied" | "missing";
  profileId: string;
}

export interface LegacyImportPartialOutcome extends LegacyImportOutcomeBase {
  status: "partial";
  copyStatus: "failed";
  profileId: string;
  error: LegacyImportOutcomeError;
}

export interface LegacyImportFailedOutcome extends LegacyImportOutcomeBase {
  status: "failed";
  copyStatus: "skipped";
  error: LegacyImportOutcomeError;
}

export type LegacyImportOutcome =
  | LegacyImportSuccessOutcome
  | LegacyImportPartialOutcome
  | LegacyImportFailedOutcome;

export interface LegacyImportResult {
  importVersion: 1;
  requestedCount: number;
  successCount: number;
  partialCount: number;
  failedCount: number;
  outcomes: LegacyImportOutcome[];
}

export interface LegacyImportSnapshot extends LegacyImportResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export type AutomationApiLifecycleStatus = "stopped" | "running";
export type AutomationApiScope = "loopback";

export interface AutomationApiEndpointSnapshot {
  host: string;
  port: number;
  url: string;
  scope: AutomationApiScope;
}

export interface AutomationApiProcessSnapshot {
  pid: number;
  startedAt: string;
}

export interface AutomationApiErrorSnapshot {
  code: string;
  message: string;
  phase: string;
  detailRef: string;
  at: string;
  durationMs?: number;
}

export interface AutomationApiTimingSnapshot {
  readinessDurationMs?: number;
  stopDurationMs?: number;
}

export interface AutomationApiStatusResult {
  status: AutomationApiLifecycleStatus;
  running: boolean;
  api: AutomationApiEndpointSnapshot | null;
  process: AutomationApiProcessSnapshot | null;
  copyAvailable: boolean;
  lastTransitionAt: string;
  lastError: AutomationApiErrorSnapshot | null;
  timings: AutomationApiTimingSnapshot;
}

export interface AutomationApiStatusSnapshot extends AutomationApiStatusResult {
  receivedAt: string;
}

export type ChromiumRuntimeStatus = "running" | "stopped";

export type ChromiumTermination = "already-stopped" | "graceful" | "forced" | "reconciled";

export interface ChromiumRunningProfileState {
  profileId: string;
  status: Extract<ChromiumRuntimeStatus, "running">;
  pid: number;
  startedAt: string;
  userDataDir: string;
}

export interface ChromiumStoppedProfileState {
  profileId: string;
  status: Extract<ChromiumRuntimeStatus, "stopped">;
  stoppedAt: string;
  termination: ChromiumTermination;
  userDataDir: string;
}

export interface ChromiumStatusResult {
  runningCount: number;
  profiles: ChromiumRunningProfileState[];
  reconciled: ChromiumStoppedProfileState[];
}

export interface ChromiumLaunchResult extends ChromiumRunningProfileState {
  runningCount: number;
}

export interface ChromiumStopResult extends ChromiumStoppedProfileState {
  runningCount: number;
}

export interface ChromiumStatusSnapshot extends ChromiumStatusResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface ChromiumLaunchSnapshot extends ChromiumLaunchResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface ChromiumStopSnapshot extends ChromiumStopResult {
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface CookieBotConfig {
  urls: string[];
  maxPages: number;
  maxDepth: number;
  dwellSeconds: number;
  maxDurationSeconds: number;
  closeAfterCompletion: boolean;
}

export type CookieBotStatus = "queued" | "running" | "cancelling" | "completed" | "cancelled" | "failed";

export interface CookieBotJob {
  jobId: string;
  profileId: string;
  status: CookieBotStatus;
  /** Returned URLs omit query strings and fragments for privacy. */
  config: CookieBotConfig;
  createdAt: string;
  finishedAt: string | null;
  currentUrl: string | null;
  visitedPages: number;
  failedPages: number;
  errors: string[];
  stopReason: string | null;
}

export interface CookieBotSnapshot {
  job: CookieBotJob | null;
  requestId: string;
  rawRequestId: JsonScalar;
  protocolVersion: string;
  bridgeDurationMs: number;
  receivedAt: string;
}

export interface CookieBotDefaultsSnapshot extends Omit<CookieBotSnapshot, "job"> {
  config: CookieBotConfig;
}

export const SIDECAR_PROTOCOL_ERROR = "SIDECAR_PROTOCOL_ERROR";
export const SIDECAR_BRIDGE_ERROR = "SIDECAR_BRIDGE_ERROR";
