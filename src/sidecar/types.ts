export type JsonScalar = string | number | boolean | null;

export type SidecarUiPhase = "loading" | "healthy" | "recoverable-error" | "bridge-error";

export type SidecarErrorSource = "sidecar" | "bridge" | "protocol";

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
