import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSidecarHealth, triggerSidecarDiagnosticFailure } from "./client";
import { SIDECAR_PROTOCOL_ERROR } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

function healthEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-42",
    protocolVersion: "1.0.0",
    durationMs: 2.5,
    result: {
      status: "healthy",
      product: { name: "ThePrivator", version: "2.1.0" },
      sidecar: { version: "0.1.0" },
      protocol: { version: "1.0.0" },
      runtime: { pythonVersion: "3.12.3", implementation: "cpython" },
      platform: { system: "Linux", release: "6.8", machine: "x86_64" },
      build: { mode: "source", frozen: false },
      request: { durationMs: 1.25 },
    },
    ...overrides,
  };
}

describe("sidecar client", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("loads and validates the sidecar health envelope", async () => {
    mockInvoke.mockResolvedValueOnce(healthEnvelope());

    const health = await getSidecarHealth();

    expect(mockInvoke).toHaveBeenCalledWith("sidecar_health");
    expect(health.requestId).toBe("bridge-42");
    expect(health.protocolVersion).toBe("1.0.0");
    expect(health.bridgeDurationMs).toBe(2.5);
    expect(health.health.product).toEqual({ name: "ThePrivator", version: "2.1.0" });
    expect(health.health.build).toEqual({ mode: "source", frozen: false });
    expect(health.health.request?.durationMs).toBe(1.25);
  });

  it("maps malformed health envelopes to a recoverable protocol error", async () => {
    mockInvoke.mockResolvedValueOnce(healthEnvelope({ result: { status: "healthy" } }));

    await expect(getSidecarHealth()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it("preserves typed bridge rejections from Tauri invoke", async () => {
    mockInvoke.mockRejectedValueOnce({
      code: "SIDECAR_UNAVAILABLE",
      message: "The Python sidecar binary is unavailable. Run npm run sidecar:build and retry.",
      recoverable: true,
      detailRef: "bridge-detail-1",
    });

    await expect(getSidecarHealth()).rejects.toMatchObject({
      code: "SIDECAR_UNAVAILABLE",
      message: expect.stringContaining("sidecar binary"),
      detailRef: "bridge-detail-1",
      source: "bridge",
      phase: "bridge-error",
    });
  });

  it("normalizes untyped invoke rejections into a bridge error", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("webview invoke failed"));

    await expect(getSidecarHealth()).rejects.toMatchObject({
      code: "SIDECAR_BRIDGE_ERROR",
      message: "The Tauri bridge rejected the sidecar request before returning a typed error.",
      recoverable: true,
      source: "bridge",
      phase: "bridge-error",
    });
  });

  it("surfaces the deliberate sidecar diagnostic failure as recoverable", async () => {
    mockInvoke.mockRejectedValueOnce({
      code: "DIAGNOSTIC_FAILURE",
      message: "Diagnostic failure requested.",
      recoverable: true,
      detailRef: "sidecar-test-detail",
    });

    await expect(triggerSidecarDiagnosticFailure()).rejects.toMatchObject({
      code: "DIAGNOSTIC_FAILURE",
      message: "Diagnostic failure requested.",
      detailRef: "sidecar-test-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
    expect(mockInvoke).toHaveBeenCalledWith("sidecar_diagnostic_failure");
  });

  it("treats an unexpectedly successful diagnostic command as a protocol error", async () => {
    mockInvoke.mockResolvedValueOnce(healthEnvelope());

    await expect(triggerSidecarDiagnosticFailure()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });
  });
});
