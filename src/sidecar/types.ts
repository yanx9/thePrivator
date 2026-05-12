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

export type FingerprintMode = "disabled";

export type IdentitySurface = "browser" | "navigator" | "screen" | "locale" | "canvas" | "audio" | "webgl" | "webrtc";
export type IdentityMaskingMode = "real" | "masked" | "custom";
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

export interface ProxyCheckIpHiding {
  status: ProxyCheckIpHidingStatus;
  basis: ProxyCheckIpHidingBasis;
  scope: ProxyCheckProofScope;
  publicExitIpClaimed: false;
  publicExitIp: null;
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

export interface ProfileIdentity {
  identityVersion: 1;
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

export interface IdentityPresetListResult {
  identityVersion: 1;
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
  identityVersion: 1;
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

export interface ProfileDefaults {
  browser: "chromium";
  startUrl: "about:blank";
  proxyMode: ProfileProxyMode;
  fingerprintMode: FingerprintMode;
}

export interface ProfileStorage {
  profileDir: string;
  userDataDir: string;
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
  metadata?: JsonObject;
}

export interface ProfileListResult {
  storeVersion: 3;
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

export const SIDECAR_PROTOCOL_ERROR = "SIDECAR_PROTOCOL_ERROR";
export const SIDECAR_BRIDGE_ERROR = "SIDECAR_BRIDGE_ERROR";
