import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProfile, deleteProfile, getSidecarHealth, listProfiles, triggerSidecarDiagnosticFailure, updateProfile } from "./client";
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

function profileRecord(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === "string" ? overrides.id : "11111111-1111-1111-1111-111111111111";
  return {
    id,
    name: "Research",
    createdAt: "2026-05-04T18:00:00.000Z",
    updatedAt: "2026-05-04T18:01:00.000Z",
    defaults: {
      browser: "chromium",
      startUrl: "about:blank",
      proxyMode: "direct",
      fingerprintMode: "disabled",
    },
    storage: {
      profileDir: `profile-store/profiles/${id}`,
      userDataDir: `profile-store/profiles/${id}/user-data`,
    },
    ...overrides,
  };
}

function profileResult(overrides: Record<string, unknown> = {}) {
  const profiles = overrides.profiles ?? [profileRecord()];
  return {
    storeVersion: 1,
    profiles,
    count: Array.isArray(profiles) ? profiles.length : 1,
    ...overrides,
  };
}

function profileEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-profiles-1",
    protocolVersion: "1.0.0",
    durationMs: 4.5,
    result,
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

  it("loads an empty profile list through the fixed Tauri profile command", async () => {
    mockInvoke.mockResolvedValueOnce({
      requestId: "bridge-profiles-1",
      protocolVersion: "1.0.0",
      durationMs: 4.5,
      result: {
        storeVersion: 1,
        profiles: [],
        count: 0,
      },
    });

    const snapshot = await listProfiles();

    expect(mockInvoke).toHaveBeenCalledWith("profiles_list");
    expect(snapshot.requestId).toBe("bridge-profiles-1");
    expect(snapshot.storeVersion).toBe(1);
    expect(snapshot.profiles).toEqual([]);
    expect(snapshot.count).toBe(0);
  });

  it("loads populated profile lists with typed defaults and relative storage", async () => {
    const profile = profileRecord({ name: "Research" });
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult({ profiles: [profile] })));

    const snapshot = await listProfiles();

    expect(snapshot.profiles).toEqual([profile]);
    expect(snapshot.profiles[0].defaults).toEqual({
      browser: "chromium",
      startUrl: "about:blank",
      proxyMode: "direct",
      fingerprintMode: "disabled",
    });
    expect(snapshot.profiles[0].storage).toEqual({
      profileDir: `profile-store/profiles/${profile.id}`,
      userDataDir: `profile-store/profiles/${profile.id}/user-data`,
    });
  });

  it("wraps create, update, and delete with fixed profile command params only", async () => {
    const original = profileRecord({ name: "Research" });
    const renamed = profileRecord({ name: "Renamed", updatedAt: "2026-05-04T18:02:00.000Z" });
    mockInvoke
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profile: original, profiles: [original] })))
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profile: renamed, profiles: [renamed] })))
      .mockResolvedValueOnce(profileEnvelope(profileResult({ profiles: [], count: 0 })));

    const created = await createProfile("Research");
    const updated = await updateProfile(original.id, "Renamed");
    const deleted = await deleteProfile(original.id);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "profiles_create", { name: "Research" });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "profiles_update", { id: original.id, name: "Renamed" });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "profiles_delete", { id: original.id });
    expect(created.profile).toEqual(original);
    expect(updated.profile).toEqual(renamed);
    expect(deleted.profile).toBeUndefined();
    expect(deleted.profiles).toEqual([]);
  });

  it.each([
    ["malformed envelope", { protocolVersion: "1.0.0", durationMs: 4.5, result: profileResult() }],
    ["wrong profiles item type", profileEnvelope(profileResult({ profiles: ["not-a-profile"] }))],
    ["missing defaults", profileEnvelope(profileResult({ profiles: [profileRecord({ defaults: undefined })] }))],
    ["missing relative storage fields", profileEnvelope(profileResult({ profiles: [profileRecord({ storage: {} })] }))],
    ["absolute storage path", profileEnvelope(profileResult({ profiles: [profileRecord({ storage: { profileDir: "/tmp/profile", userDataDir: "/tmp/profile/user-data" } })] }))],
    ["non-number count", profileEnvelope(profileResult({ count: "one" }))],
    ["non-string timestamp", profileEnvelope(profileResult({ profiles: [profileRecord({ createdAt: 42 })] }))],
  ])("maps malformed profile payloads to protocol errors: %s", async (_caseName, envelope) => {
    mockInvoke.mockResolvedValueOnce(envelope);

    await expect(listProfiles()).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      recoverable: true,
      source: "protocol",
      phase: "bridge-error",
      detailRef: expect.stringMatching(/^ui-protocol-/),
    });
  });

  it.each([
    ["PROFILE_INVALID_NAME", "Profile name is invalid."],
    ["PROFILE_DUPLICATE_NAME", "Profile name already exists."],
  ])("preserves typed recoverable profile errors: %s", async (code, message) => {
    mockInvoke.mockRejectedValueOnce({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-profile-detail",
    });

    await expect(createProfile("Research")).rejects.toMatchObject({
      code,
      message,
      recoverable: true,
      detailRef: "sidecar-profile-detail",
      source: "sidecar",
      phase: "recoverable-error",
    });
  });

  it("preserves typed bridge timeout errors for profile calls", async () => {
    mockInvoke.mockRejectedValueOnce({
      code: "SIDECAR_TIMEOUT",
      message: "The Python sidecar did not respond before the bridge timeout.",
      recoverable: true,
      detailRef: "bridge-timeout-detail",
    });

    await expect(listProfiles()).rejects.toMatchObject({
      code: "SIDECAR_TIMEOUT",
      source: "bridge",
      phase: "bridge-error",
      detailRef: "bridge-timeout-detail",
    });
  });

  it("rejects create/update mutation results missing the changed profile", async () => {
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult({ profiles: [profileRecord()] })));

    await expect(createProfile("Research")).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });
  });

  it("rejects mutation profile objects that are absent from the refreshed list", async () => {
    const changed = profileRecord({ id: "22222222-2222-2222-2222-222222222222", name: "Changed" });
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult({ profile: changed, profiles: [profileRecord()] })));

    await expect(updateProfile(changed.id, changed.name)).rejects.toMatchObject({
      code: SIDECAR_PROTOCOL_ERROR,
      source: "protocol",
      phase: "bridge-error",
    });
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
