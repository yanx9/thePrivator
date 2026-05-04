import { invoke } from "@tauri-apps/api/core";
import type {
  JsonScalar,
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

function parseSuccessEnvelope(value: unknown): SidecarCommandSuccessEnvelope {
  const record = requireRecord(value, "The Tauri bridge returned a non-object sidecar response.");
  const requestId = record.requestId;

  if (!isJsonScalar(requestId)) {
    throw makeProtocolError("The Tauri bridge response is missing requestId.");
  }

  return {
    requestId,
    protocolVersion: requireString(record.protocolVersion, "protocolVersion"),
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
