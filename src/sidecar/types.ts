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

export interface ProfileDefaults {
  browser: "chromium";
  startUrl: "about:blank";
  proxyMode: "direct";
  fingerprintMode: "disabled";
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
  metadata?: JsonObject;
}

export interface ProfileListResult {
  storeVersion: 1;
  profiles: ProfileRecord[];
  count: number;
}

export interface ProfileMutationResult extends ProfileListResult {
  profile?: ProfileRecord;
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
