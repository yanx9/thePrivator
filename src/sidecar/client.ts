import { invoke } from "@tauri-apps/api/core";
import type {
  ChromiumLaunchResult,
  ChromiumLaunchSnapshot,
  ChromiumRunningProfileState,
  ChromiumStatusResult,
  ChromiumStatusSnapshot,
  ChromiumStopResult,
  ChromiumStoppedProfileState,
  ChromiumStopSnapshot,
  ChromiumTermination,
  JsonScalar,
  JsonObject,
  JsonValue,
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
import { SIDECAR_BRIDGE_ERROR, SIDECAR_PROTOCOL_ERROR } from "./types";

const BRIDGE_ERROR_CODES = new Set([
  "SIDECAR_CONFIGURATION_ERROR",
  "SIDECAR_PROCESS_ERROR",
  "SIDECAR_PROTOCOL_ERROR",
  "SIDECAR_TIMEOUT",
  "SIDECAR_UNAVAILABLE",
]);

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
    });
  } catch (error) {
    throw normalizeSidecarError(error);
  }
}

export async function deleteProfile(id: string): Promise<ProfileMutationSnapshot> {
  try {
    const envelope = await invoke<unknown>("profiles_delete", { id });
    return parseProfileMutationEnvelope(envelope, new Date().toISOString(), {
      requireProfile: false,
      requireProfileInList: false,
    });
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
      ...error,
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
  options: { requireProfile: boolean; requireProfileInList: boolean },
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
  options: { requireProfile: boolean; requireProfileInList: boolean },
): ProfileMutationResult {
  const record = requireRecord(value, "The sidecar profile mutation result must be an object.");
  const list = parseProfileListResult(record);
  const rawProfile = record.profile;

  if (rawProfile === undefined) {
    if (options.requireProfile) {
      throw makeProtocolError("The sidecar profile mutation result is missing profile.");
    }

    return list;
  }

  const profile = parseProfileRecord(rawProfile);
  if (options.requireProfileInList && !list.profiles.some((item) => sameProfileRecord(item, profile))) {
    throw makeProtocolError("The sidecar profile mutation result profile is not present in the refreshed list.");
  }

  return {
    ...list,
    profile,
  };
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
  const id = requireNonBlankString(record.id, `${field}.id`);
  const name = requireNonBlankString(record.name, `${field}.name`);
  const createdAt = requireIsoTimestamp(record.createdAt, `${field}.createdAt`);
  const updatedAt = requireIsoTimestamp(record.updatedAt, `${field}.updatedAt`);

  const metadata = record.metadata === undefined ? undefined : parseSafeJsonObject(record.metadata, `${field}.metadata`);

  return {
    id,
    name,
    createdAt,
    updatedAt,
    defaults: parseProfileDefaults(record.defaults, `${field}.defaults`),
    storage: parseProfileStorage(record.storage, id, `${field}.storage`),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function parseProfileDefaults(value: unknown, field: string): ProfileDefaults {
  const defaults = requireRecord(value, `The sidecar profile result field ${field} must be an object.`);
  requireLiteral(defaults.browser, `${field}.browser`, "chromium");
  requireLiteral(defaults.startUrl, `${field}.startUrl`, "about:blank");
  requireLiteral(defaults.proxyMode, `${field}.proxyMode`, "direct");
  requireLiteral(defaults.fingerprintMode, `${field}.fingerprintMode`, "disabled");

  return {
    browser: "chromium",
    startUrl: "about:blank",
    proxyMode: "direct",
    fingerprintMode: "disabled",
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

function requireStoreVersion(value: unknown): 1 {
  if (value !== 1) {
    throw makeProtocolError("The sidecar profile result field storeVersion must be 1.");
  }

  return 1;
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
  if (!Number.isInteger(number) || number < 0) {
    throw makeProtocolError(`The sidecar response field ${field} must be a non-negative integer.`);
  }

  return number;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const number = requireNumber(value, field);
  if (!Number.isInteger(number) || number <= 0) {
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
  if (!detailRef.startsWith("sidecar-") && !detailRef.startsWith("bridge-") && !detailRef.startsWith("ui-")) {
    throw makeProtocolError(`The sidecar response field ${field} must be an opaque detailRef.`);
  }

  return detailRef;
}

function requireLegacyId(value: unknown, field: string): string {
  const legacyId = requireNonBlankString(value, field);
  if (!legacyId.startsWith("legacy-")) {
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
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("://") || value.includes("\0");
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
  return source === "sidecar" || source === "bridge" || source === "protocol";
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
