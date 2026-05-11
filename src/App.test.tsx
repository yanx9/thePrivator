// @ts-expect-error Vite raw import keeps the source guard browser-build compatible without Node fs types.
import appSourceText from "./App.tsx?raw";
import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { DIAGNOSTIC_RELATIVE_LOG_PATH } from "./sidecar/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

function healthEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-7",
    protocolVersion: "1.0.0",
    durationMs: 3.4,
    result: {
      status: "healthy",
      product: { name: "ThePrivator", version: "2.1.0" },
      sidecar: { version: "0.1.0" },
      protocol: { version: "1.0.0" },
      runtime: { pythonVersion: "3.12.3", implementation: "cpython" },
      platform: { system: "Linux", release: "6.8", machine: "x86_64" },
      build: { mode: "source", frozen: false },
      request: { durationMs: 1.2 },
    },
    ...overrides,
  };
}

function defaultIdentity(overrides: Record<string, unknown> = {}) {
  return {
    identityVersion: 1,
    label: "Real identity",
    presetId: null,
    browser: { mode: "real" },
    navigator: { mode: "real" },
    screen: { mode: "real" },
    locale: { mode: "real" },
    canvas: { mode: "real" },
    audio: { mode: "real" },
    webgl: { mode: "real" },
    webrtc: { mode: "real", policy: "real" },
    ...overrides,
  };
}

function profileRecord(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === "string" ? overrides.id : "11111111-1111-1111-1111-111111111111";
  const base = {
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
    identity: defaultIdentity(),
  };

  return {
    ...base,
    ...overrides,
    storage: overrides.storage ?? base.storage,
  };
}

function profileResult(profiles: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    storeVersion: 2,
    profiles,
    count: profiles.length,
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

function identityPreset(label: string, presetId: string, overrides: Record<string, unknown> = {}) {
  return defaultIdentity({ label, presetId, ...overrides });
}

function identityPresetResult(presets: unknown[] = [
  identityPreset("Real identity", "real"),
  identityPreset("Balanced desktop", "balanced-desktop"),
  identityPreset("Travel laptop", "travel-laptop"),
  identityPreset("Strict privacy", "strict-privacy"),
]) {
  return {
    identityVersion: 1,
    presets,
    count: presets.length,
  };
}

function identityWarning(overrides: Record<string, unknown> = {}) {
  return {
    code: "IDENTITY_TIMEZONE_MISMATCH",
    message: "Locale timezone does not match the selected browser region.",
    surface: "locale",
    path: "locale.timezoneId",
    ...overrides,
  };
}

function identityValidationResult(identity: unknown, warnings: unknown[] = [identityWarning()]) {
  return {
    identityVersion: 1,
    identity,
    warnings,
  };
}

function identityEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-identity-1",
    protocolVersion: "1.0.0",
    durationMs: 5.25,
    result,
    ...overrides,
  };
}

function profileError(code: string, message: string, detailRef = "profile-detail-ref") {
  return {
    code,
    message,
    recoverable: true,
    detailRef,
  };
}

function chromiumRunningProfile(overrides: Record<string, unknown> = {}) {
  const profileId = typeof overrides.profileId === "string" ? overrides.profileId : "11111111-1111-1111-1111-111111111111";
  return {
    profileId,
    status: "running",
    pid: 4242,
    startedAt: "2026-05-04T18:05:00.000Z",
    userDataDir: `profile-store/profiles/${profileId}/user-data`,
    ...overrides,
  };
}

function chromiumStoppedProfile(overrides: Record<string, unknown> = {}) {
  const profileId = typeof overrides.profileId === "string" ? overrides.profileId : "11111111-1111-1111-1111-111111111111";
  return {
    profileId,
    status: "stopped",
    stoppedAt: "2026-05-04T18:06:00.000Z",
    termination: "graceful",
    userDataDir: `profile-store/profiles/${profileId}/user-data`,
    ...overrides,
  };
}

function chromiumStatusResult(overrides: Record<string, unknown> = {}) {
  const profiles = overrides.profiles ?? [];
  return {
    runningCount: Array.isArray(profiles) ? profiles.length : 0,
    profiles,
    reconciled: [],
    ...overrides,
  };
}

function chromiumEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-chromium-1",
    protocolVersion: "1.0.0",
    durationMs: 6.75,
    result,
    ...overrides,
  };
}

function legacyIssue(overrides: Record<string, unknown> = {}) {
  return {
    code: "LEGACY_CONFIG_MISSING",
    message: "Legacy profile config.json is missing.",
    detailRef: "sidecar-legacy-issue",
    ...overrides,
  };
}

function legacyCandidate(overrides: Record<string, unknown> = {}) {
  return {
    legacyId: "legacy-111111111111111111111111",
    folderName: "profile-one",
    legacyName: "Legacy Research",
    targetName: "Legacy Research",
    userData: { status: "available" },
    metadata: {
      source: "legacy-theprivator",
      format: "legacy-profile",
      legacyFolder: "profile-one",
      legacyName: "Legacy Research",
      hasUserData: true,
      formatVersion: "2",
      chromiumVersion: "116.0.0",
      remoteControlPort: 9222,
    },
    issues: [],
    ...overrides,
  };
}

function legacyScanResult(overrides: Record<string, unknown> = {}) {
  const candidates = overrides.candidates ?? [legacyCandidate()];
  return {
    scanVersion: 1,
    count: Array.isArray(candidates) ? candidates.length : 1,
    candidates,
    issues: [],
    ...overrides,
  };
}

function legacyOutcome(overrides: Record<string, unknown> = {}) {
  return {
    legacyId: "legacy-111111111111111111111111",
    targetName: "Imported Research",
    folderName: "profile-one",
    legacyName: "Legacy Research",
    status: "success",
    profileId: "11111111-1111-1111-1111-111111111111",
    copyStatus: "copied",
    ...overrides,
  };
}

function legacyError(overrides: Record<string, unknown> = {}) {
  return {
    code: "LEGACY_SELECTION_INVALID",
    message: "Selected legacy profile was not found in a fresh scan.",
    recoverable: true,
    detailRef: "sidecar-legacy-error",
    ...overrides,
  };
}

function legacyImportResult(overrides: Record<string, unknown> = {}) {
  const outcomes = overrides.outcomes ?? [legacyOutcome()];
  return {
    importVersion: 1,
    requestedCount: Array.isArray(outcomes) ? outcomes.length : 1,
    successCount: Array.isArray(outcomes) ? outcomes.filter((outcome) => (outcome as { status?: unknown })?.status === "success").length : 0,
    partialCount: Array.isArray(outcomes) ? outcomes.filter((outcome) => (outcome as { status?: unknown })?.status === "partial").length : 0,
    failedCount: Array.isArray(outcomes) ? outcomes.filter((outcome) => (outcome as { status?: unknown })?.status === "failed").length : 0,
    outcomes,
    ...overrides,
  };
}

function legacyEnvelope(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-legacy-1",
    protocolVersion: "1.0.0",
    durationMs: 8.25,
    result,
    ...overrides,
  };
}

function diagnosticEntry(detailRef: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    ts: "2026-05-04T18:10:00.000Z",
    source: "python-sidecar",
    event: "sidecar.request",
    status: "error",
    logPath: DIAGNOSTIC_RELATIVE_LOG_PATH,
    requestId: "request-lookup-1",
    method: "profiles.create",
    durationMs: 12.5,
    errorCode: "PROFILE_INVALID_NAME",
    detailRef,
    ...overrides,
  };
}

function diagnosticLookupResult(detailRef: string, overrides: Record<string, unknown> = {}) {
  return {
    found: true,
    detailRef,
    reason: "found",
    logPath: DIAGNOSTIC_RELATIVE_LOG_PATH,
    entries: [diagnosticEntry(detailRef)],
    ...overrides,
  };
}

const appSource = () => appSourceText;

function mockStartup(profiles: unknown[] = [], chromiumResult: unknown = chromiumStatusResult()) {
  mockInvoke
    .mockResolvedValueOnce(healthEnvelope())
    .mockResolvedValueOnce(profileEnvelope(profileResult(profiles)))
    .mockResolvedValueOnce(chromiumEnvelope(chromiumResult));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function commandCalls(command: string) {
  return mockInvoke.mock.calls.filter(([calledCommand]) => calledCommand === command);
}

describe("ThePrivator profile library UI", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("starts health, profile list, and Chromium status without a startup waterfall and renders the empty-state CTA", async () => {
    const health = deferred<unknown>();
    const profiles = deferred<unknown>();
    const chromium = deferred<unknown>();
    mockInvoke.mockImplementation(((command: string) => {
      if (command === "sidecar_health") {
        return health.promise;
      }
      if (command === "profiles_list") {
        return profiles.promise;
      }
      if (command === "chromium_status") {
        return chromium.promise;
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    }) as typeof invoke);

    render(<App />);

    expect(screen.getByRole("heading", { name: /persistent profiles, transient browsers/i })).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "sidecar_health");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "profiles_list");
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "chromium_status");
    expect(screen.getByLabelText(/current profile phase/i)).toHaveTextContent(/loading/i);
    expect(screen.getByRole("button", { name: /refreshing profiles/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /refreshing status/i })).toBeDisabled();

    await act(async () => {
      health.resolve(healthEnvelope());
      profiles.resolve(profileEnvelope(profileResult([])));
      chromium.resolve(chromiumEnvelope(chromiumStatusResult()));
      await Promise.all([health.promise, profiles.promise, chromium.promise]);
    });

    expect(await screen.findByLabelText(/empty profile library/i)).toHaveTextContent(/Create the first profile/i);
    expect(screen.getByLabelText(/current profile phase/i)).toHaveTextContent(/ready/i);
    expect(screen.getByLabelText(/current profile phase/i)).toHaveTextContent(/0 stored profiles/i);
    expect(screen.getByLabelText(/compact sidecar system status/i)).toHaveTextContent(/ThePrivator 2\.1\.0/i);
    expect(screen.getByLabelText(/profile observability/i)).toHaveTextContent(/Lifecycle phaseready/i);
  });

  it("renders startup profiles as persisted reload truth with typed defaults and compact observability", async () => {
    const profile = profileRecord({ name: "Research" });
    mockStartup([profile]);

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    expect(card).toHaveTextContent("11111111-1111-1111-1111-111111111111");
    expect(card).toHaveTextContent(/2026-05-04 18:00:00 UTC/i);
    expect(card).toHaveTextContent(/Chromium/i);
    expect(card).toHaveTextContent(/direct proxy/i);
    expect(card).toHaveTextContent(/disabled fingerprinting/i);
    expect(card).toHaveTextContent(/about:blank/i);
    expect(card).toHaveTextContent(/profile-store\/profiles\/11111111-1111-1111-1111-111111111111\/user-data/i);
    expect(card).toHaveTextContent(/No sidecar-owned running record exists/i);
    expect(card).toHaveTextContent(/transient runtime state, not durable profile truth/i);
    expect(screen.getByLabelText(/profile observability/i)).toHaveTextContent(/Current count1/i);
    expect(screen.getByLabelText(/profile observability/i)).toHaveTextContent(/List requestbridge-profiles-1/i);
    expect(screen.getByLabelText(/profile observability/i)).toHaveTextContent(/Running count0/i);
  });

  it("renders saved identity as profile truth without lazy identity startup calls", async () => {
    const savedIdentity = defaultIdentity({
      label: "Banking desktop",
      presetId: "balanced-desktop",
      browser: { mode: "masked", userAgent: "Mozilla/5.0 Banking" },
      canvas: { mode: "noise", noiseSeed: 444 },
      webgl: { mode: "custom", vendor: "Intel Inc.", renderer: "Mesa Intel" },
    });
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    mockStartup([profile]);

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    const identityPanel = within(card).getByLabelText(/research saved identity summary/i);
    expect(identityPanel).toHaveTextContent(/M002 saved identity/i);
    expect(identityPanel).toHaveTextContent(/Banking desktop/i);
    expect(identityPanel).toHaveTextContent(/Preset balanced-desktop/i);
    expect(identityPanel).toHaveTextContent(/Browser masked/i);
    expect(identityPanel).toHaveTextContent(/Canvas noise/i);
    expect(identityPanel).toHaveTextContent(/WebGL custom/i);
    expect(commandCalls("identity_presets_list")).toHaveLength(0);
    expect(commandCalls("identity_validate")).toHaveLength(0);
  });

  it("lazy-loads curated presets and saved validation warnings when Configure identity opens", async () => {
    const savedIdentity = defaultIdentity({ label: "Research laptop", presetId: "balanced-desktop" });
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(savedIdentity, [identityWarning()])));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));

    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    expect(panel).toHaveTextContent(/Identity configuration phase/i);
    expect(panel).toHaveTextContent(/Balanced desktop/i);
    expect(panel).toHaveTextContent(/Travel laptop/i);
    expect(panel).toHaveTextContent(/Strict privacy/i);
    expect(panel).toHaveTextContent(/Real identity/i);
    expect(panel).toHaveTextContent(/Saved warnings1/i);
    expect(panel).toHaveTextContent(/IDENTITY_TIMEZONE_MISMATCH/i);
    expect(panel).toHaveTextContent(/Locale timezone does not match/i);
    expect(mockInvoke).toHaveBeenCalledWith("identity_presets_list");
    expect(mockInvoke).toHaveBeenCalledWith("identity_validate", { identity: savedIdentity });
    expect(commandCalls("identity_presets_list")).toHaveLength(1);
    expect(commandCalls("identity_validate")).toHaveLength(1);
  });

  it("renders saved-validation failures safely without mutating the profile list", async () => {
    const savedIdentity = defaultIdentity({ label: "Warning profile", presetId: null });
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockRejectedValueOnce(profileError("IDENTITY_VALIDATION_FAILED", "Saved identity validation failed.", "sidecar-validation-detail"));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));

    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/IDENTITY_VALIDATION_FAILED/i));
    expect(panel).toHaveTextContent(/Saved identity validation failed/i);
    expect(panel).toHaveTextContent(/sidecar-validation-detail/i);
    expect(panel).toHaveTextContent(/Warning profile/i);
    expect(panel).toHaveTextContent(/No preset/i);
    expect(screen.getByRole("listitem", { name: /research/i })).toBeInTheDocument();
    expect(commandCalls("profiles_list")).toHaveLength(1);
  });

  it("redacts raw identity bridge failures while preserving diagnostic lookup affordances", async () => {
    const savedIdentity = defaultIdentity({ label: "Bridge failure profile", presetId: null });
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    const rawRuntimeMessage = "Traceback (most recent call last): /tmp/theprivator-app-data/profile-store --remote-debugging-port=9222 ws://127.0.0.1/devtools/browser raw command args";

    mockInvoke.mockImplementation(((command: string, args?: unknown) => {
      if (command === "sidecar_health") {
        return Promise.resolve(healthEnvelope());
      }
      if (command === "profiles_list") {
        return Promise.resolve(profileEnvelope(profileResult([profile])));
      }
      if (command === "chromium_status") {
        return Promise.resolve(chromiumEnvelope(chromiumStatusResult()));
      }
      if (command === "identity_presets_list") {
        return Promise.resolve(identityEnvelope(identityPresetResult()));
      }
      if (command === "identity_validate") {
        return Promise.reject(new Error(rawRuntimeMessage));
      }
      if (command === "diagnostics_lookup") {
        const detailRef = (args as { detailRef?: string } | undefined)?.detailRef ?? "ui-bridge-missing";
        return Promise.resolve({ found: false, detailRef, reason: "ui-local", logPath: null, entries: [] });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    }) as typeof invoke);

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));

    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/SIDECAR_BRIDGE_ERROR/i));
    expect(panel).toHaveTextContent(/Tauri bridge rejected the sidecar request/i);
    expect(panel).toHaveTextContent(/Sourcebridge/i);
    expect(panel).not.toHaveTextContent("/tmp/theprivator-app-data");
    expect(panel).not.toHaveTextContent("--remote-debugging-port");
    expect(panel).not.toHaveTextContent("ws://127.0.0.1");
    expect(panel).not.toHaveTextContent(/Traceback/i);
    expect(panel).not.toHaveTextContent(/raw command args/i);

    const lookupButton = within(panel).getByRole("button", { name: /lookup diagnostics for ui-bridge/i });
    fireEvent.click(lookupButton);

    const lookupPanel = await screen.findByLabelText(/diagnostic lookup/i);
    expect(lookupPanel).toHaveTextContent(/UI-local reference/i);
    expect(lookupPanel).not.toHaveTextContent("/tmp/theprivator-app-data");
    expect(lookupPanel).not.toHaveTextContent("--remote-debugging-port");
    expect(lookupPanel).not.toHaveTextContent("ws://127.0.0.1");
    expect(commandCalls("profiles_identity_update")).toHaveLength(0);
  });

  it("renders preset-loading failures safely while preserving the saved identity draft", async () => {
    const savedIdentity = defaultIdentity({ label: "Preset failure profile", presetId: "balanced-desktop" });
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    mockStartup([profile]);
    mockInvoke
      .mockRejectedValueOnce(profileError("IDENTITY_PRESETS_UNAVAILABLE", "Identity preset list could not be loaded.", "sidecar-preset-detail"))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(savedIdentity, [])));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));

    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/IDENTITY_PRESETS_UNAVAILABLE/i));
    expect(panel).toHaveTextContent(/Identity preset list could not be loaded/i);
    expect(panel).toHaveTextContent(/sidecar-preset-detail/i);
    expect(panel).toHaveTextContent(/Preset failure profile/i);
    expect(panel).toHaveTextContent(/Preset balanced-desktop/i);
    expect(commandCalls("identity_presets_list")).toHaveLength(1);
    expect(commandCalls("profiles_list")).toHaveLength(1);
  });

  it("reuses cached presets when reopening the same identity panel", async () => {
    const savedIdentity = defaultIdentity({ label: "Cached profile", presetId: "balanced-desktop" });
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(savedIdentity, [])))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(savedIdentity, [])));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const firstPanel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(firstPanel).toHaveTextContent(/Preset count4/i));
    fireEvent.click(within(firstPanel).getByRole("button", { name: /close identity configuration/i }));
    expect(within(card).queryByRole("region", { name: /configure identity for research/i })).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const reopenedPanel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(reopenedPanel).toHaveTextContent(/Preset count4/i));
    expect(commandCalls("identity_presets_list")).toHaveLength(1);
    expect(commandCalls("identity_validate")).toHaveLength(2);
  });

  it("applies a curated preset through the typed client and renders non-blocking warnings", async () => {
    const savedIdentity = defaultIdentity({ label: "Research laptop", presetId: null });
    const appliedIdentity = identityPreset("Balanced desktop", "balanced-desktop", {
      browser: { mode: "masked", userAgent: "Mozilla/5.0 Balanced" },
      canvas: { mode: "noise", noiseSeed: 313 },
    });
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    const updatedProfile = profileRecord({
      id: profile.id,
      name: "Research",
      updatedAt: "2026-05-04T18:12:00.000Z",
      identity: appliedIdentity,
    });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(savedIdentity, [])))
      .mockResolvedValueOnce(
        profileEnvelope(profileResult([updatedProfile], {
          profile: updatedProfile,
          warnings: [identityWarning({ code: "IDENTITY_REGION_MISMATCH", message: "Browser region and locale differ.", surface: "browser", path: "browser.userAgent" })],
        })),
      );

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/Preset count4/i));

    fireEvent.change(within(panel).getByLabelText(/curated preset/i), { target: { value: "balanced-desktop" } });
    fireEvent.click(within(panel).getByRole("button", { name: /apply preset/i }));

    await waitFor(() => expect(panel).toHaveTextContent(/Preset applied with 1 warning/i));
    expect(panel).toHaveTextContent(/Warnings are non-blocking/i);
    expect(panel).toHaveTextContent(/Preset apply warnings/i);
    expect(panel).toHaveTextContent(/IDENTITY_REGION_MISMATCH/i);
    expect(panel).toHaveTextContent(/Browser region and locale differ/i);
    expect(card).toHaveTextContent(/Balanced desktop/i);
    expect(card).toHaveTextContent(/Preset balanced-desktop/i);
    expect(card).toHaveTextContent(/Canvas noise/i);
    expect(mockInvoke).toHaveBeenCalledWith("profiles_identity_apply_preset", {
      profileId: profile.id,
      presetId: "balanced-desktop",
    });
    expect(commandCalls("profiles_identity_apply_preset")).toHaveLength(1);
  });

  it("renders zero-warning preset apply success without promising fingerprint protection", async () => {
    const savedIdentity = defaultIdentity({ label: "Research laptop", presetId: null });
    const appliedIdentity = identityPreset("Strict privacy", "strict-privacy", {
      navigator: { mode: "masked", platform: "Linux x86_64", hardwareConcurrency: 8, deviceMemory: 8, uaPlatform: "Linux", uaPlatformVersion: "", uaArchitecture: "x86", uaMobile: false },
    });
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    const updatedProfile = profileRecord({ id: profile.id, name: "Research", identity: appliedIdentity });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(savedIdentity, [])))
      .mockResolvedValueOnce(profileEnvelope(profileResult([updatedProfile], { profile: updatedProfile, warnings: [] })));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/Preset count4/i));

    fireEvent.change(within(panel).getByLabelText(/curated preset/i), { target: { value: "strict-privacy" } });
    fireEvent.click(within(panel).getByRole("button", { name: /apply preset/i }));

    await waitFor(() => expect(panel).toHaveTextContent(/Preset applied with 0 sidecar warnings/i));
    expect(panel).toHaveTextContent(/does not promise full fingerprint protection/i);
    expect(panel).not.toHaveTextContent(/Preset apply warnings/i);
    expect(card).toHaveTextContent(/Strict privacy/i);
  });

  it("keeps the previous identity visible when preset apply returns a typed sidecar error", async () => {
    const savedIdentity = defaultIdentity({ label: "Original identity", presetId: null });
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(savedIdentity, [])))
      .mockRejectedValueOnce(profileError("IDENTITY_PRESET_NOT_FOUND", "Curated preset was not found.", "sidecar-apply-detail"));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/Preset count4/i));

    fireEvent.change(within(panel).getByLabelText(/curated preset/i), { target: { value: "balanced-desktop" } });
    fireEvent.click(within(panel).getByRole("button", { name: /apply preset/i }));

    await waitFor(() => expect(panel).toHaveTextContent(/IDENTITY_PRESET_NOT_FOUND/i));
    expect(panel).toHaveTextContent(/Curated preset was not found/i);
    expect(panel).toHaveTextContent(/sidecar/i);
    expect(panel).toHaveTextContent(/Recoverableyes/i);
    expect(panel).toHaveTextContent(/sidecar-apply-detail/i);
    expect(within(panel).getByRole("button", { name: /lookup diagnostics for sidecar-apply-detail/i })).toBeEnabled();
    expect(within(panel).getByRole("button", { name: /apply preset/i })).toBeEnabled();
    expect(card).toHaveTextContent(/Original identity/i);
    expect(card).toHaveTextContent(/No preset/i);
    expect(card).not.toHaveTextContent(/Balanced desktop · Preset balanced-desktop/i);
    expect(commandCalls("profiles_identity_apply_preset")).toHaveLength(1);
    expect(commandCalls("profiles_list")).toHaveLength(1);
  });

  it("renders client parser preset mismatch failures without applying partial data", async () => {
    const savedIdentity = defaultIdentity({ label: "Original identity", presetId: null });
    const mismatchedIdentity = identityPreset("Travel laptop", "travel-laptop");
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    const mismatchedProfile = profileRecord({ id: profile.id, name: "Research", identity: mismatchedIdentity });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(savedIdentity, [])))
      .mockResolvedValueOnce(profileEnvelope(profileResult([mismatchedProfile], { profile: mismatchedProfile, warnings: [] })));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/Preset count4/i));

    fireEvent.change(within(panel).getByLabelText(/curated preset/i), { target: { value: "balanced-desktop" } });
    fireEvent.click(within(panel).getByRole("button", { name: /apply preset/i }));

    await waitFor(() => expect(panel).toHaveTextContent(/SIDECAR_PROTOCOL_ERROR/i));
    expect(panel).toHaveTextContent(/protocol/i);
    expect(panel).toHaveTextContent(/did not match the requested presetId/i);
    expect(card).toHaveTextContent(/Original identity/i);
    expect(card).toHaveTextContent(/No preset/i);
    expect(card).not.toHaveTextContent(/Travel laptop · Preset travel-laptop/i);
  });

  it("does not apply when no preset or only a stale preset id is selected", async () => {
    const noPresetProfile = profileRecord({ name: "No Preset", identity: defaultIdentity({ label: "No preset identity", presetId: null }) });
    const staleProfile = profileRecord({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Stale Preset",
      identity: defaultIdentity({ label: "Stale identity", presetId: "retired-preset" }),
    });
    mockStartup([noPresetProfile, staleProfile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(noPresetProfile.identity, [])))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(staleProfile.identity, [])));

    render(<App />);

    const noPresetCard = await screen.findByRole("listitem", { name: /no preset/i });
    fireEvent.click(within(noPresetCard).getByRole("button", { name: /configure identity for no preset/i }));
    const noPresetPanel = await within(noPresetCard).findByRole("region", { name: /configure identity for no preset/i });
    await waitFor(() => expect(noPresetPanel).toHaveTextContent(/Choose a curated preset before applying/i));
    expect(within(noPresetPanel).getByRole("button", { name: /apply preset/i })).toBeDisabled();
    fireEvent.click(within(noPresetPanel).getByRole("button", { name: /close identity configuration/i }));

    const staleCard = screen.getByRole("listitem", { name: /stale preset/i });
    fireEvent.click(within(staleCard).getByRole("button", { name: /configure identity for stale preset/i }));
    const stalePanel = await within(staleCard).findByRole("region", { name: /configure identity for stale preset/i });
    await waitFor(() => expect(stalePanel).toHaveTextContent(/retired-preset is not in the loaded curated preset list/i));
    expect(within(stalePanel).getByRole("button", { name: /apply preset/i })).toBeDisabled();
    expect(commandCalls("profiles_identity_apply_preset")).toHaveLength(0);
  });

  it("disables preset apply with explanatory copy while Chromium is running or launching", async () => {
    const profile = profileRecord({ name: "Research", identity: defaultIdentity({ label: "Runtime identity", presetId: null }) });
    const running = chromiumRunningProfile({ profileId: profile.id, pid: 8787 });
    mockStartup([profile], chromiumStatusResult({ profiles: [running] }));
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(profile.identity, [])));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/Preset count4/i));

    fireEvent.change(within(panel).getByLabelText(/curated preset/i), { target: { value: "balanced-desktop" } });
    const applyPresetButton = within(panel).getByRole("button", { name: /apply preset/i });
    const checkIdentityButton = within(panel).getByRole("button", { name: /check identity/i });
    const saveOverrideButton = within(panel).getByRole("button", { name: /save advanced override/i });
    expect(applyPresetButton).toBeDisabled();
    expect(applyPresetButton).toHaveAccessibleDescription(/changes affect the next launch only/i);
    expect(checkIdentityButton).toBeDisabled();
    expect(checkIdentityButton).toHaveAccessibleDescription(/changes affect the next launch only/i);
    expect(saveOverrideButton).toBeDisabled();
    expect(saveOverrideButton).toHaveAccessibleDescription(/changes affect the next launch only/i);
    expect(panel).toHaveTextContent(/disabled while Chromium is running/i);
    expect(panel).toHaveTextContent(/changes affect the next launch only/i);
    expect(commandCalls("profiles_identity_apply_preset")).toHaveLength(0);
  });

  it("disables preset apply while Chromium launch is pending", async () => {
    const profile = profileRecord({ name: "Research", identity: defaultIdentity({ label: "Pending identity", presetId: null }) });
    const pendingLaunch = deferred<unknown>();
    mockInvoke.mockImplementation(((command: string) => {
      if (command === "sidecar_health") {
        return Promise.resolve(healthEnvelope());
      }
      if (command === "profiles_list") {
        return Promise.resolve(profileEnvelope(profileResult([profile])));
      }
      if (command === "chromium_status") {
        return Promise.resolve(chromiumEnvelope(chromiumStatusResult()));
      }
      if (command === "chromium_launch") {
        return pendingLaunch.promise;
      }
      if (command === "identity_presets_list") {
        return Promise.resolve(identityEnvelope(identityPresetResult()));
      }
      if (command === "identity_validate") {
        return Promise.resolve(identityEnvelope(identityValidationResult(profile.identity, [])));
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    }) as typeof invoke);

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /launch chromium/i }));
    await waitFor(() => expect(card).toHaveTextContent(/Launching/i));
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/Preset count4/i));

    fireEvent.change(within(panel).getByLabelText(/curated preset/i), { target: { value: "balanced-desktop" } });
    expect(within(panel).getByRole("button", { name: /apply preset/i })).toBeDisabled();
    expect(panel).toHaveTextContent(/disabled while Chromium is launching/i);
    expect(commandCalls("profiles_identity_apply_preset")).toHaveLength(0);

    await act(async () => {
      pendingLaunch.resolve(chromiumEnvelope({ ...chromiumRunningProfile({ profileId: profile.id }), runningCount: 1 }));
    });
  });

  it("disables preset apply while Chromium stop is pending", async () => {
    const profile = profileRecord({ name: "Research", identity: defaultIdentity({ label: "Stopping identity", presetId: null }) });
    const running = chromiumRunningProfile({ profileId: profile.id, pid: 9797 });
    const pendingStop = deferred<unknown>();
    mockInvoke.mockImplementation(((command: string) => {
      if (command === "sidecar_health") {
        return Promise.resolve(healthEnvelope());
      }
      if (command === "profiles_list") {
        return Promise.resolve(profileEnvelope(profileResult([profile])));
      }
      if (command === "chromium_status") {
        return Promise.resolve(chromiumEnvelope(chromiumStatusResult({ profiles: [running] })));
      }
      if (command === "chromium_stop") {
        return pendingStop.promise;
      }
      if (command === "identity_presets_list") {
        return Promise.resolve(identityEnvelope(identityPresetResult()));
      }
      if (command === "identity_validate") {
        return Promise.resolve(identityEnvelope(identityValidationResult(profile.identity, [])));
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    }) as typeof invoke);

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /stop chromium/i }));
    await waitFor(() => expect(card).toHaveTextContent(/Stopping/i));
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/Preset count4/i));

    fireEvent.change(within(panel).getByLabelText(/curated preset/i), { target: { value: "balanced-desktop" } });
    expect(within(panel).getByRole("button", { name: /apply preset/i })).toBeDisabled();
    expect(panel).toHaveTextContent(/disabled while Chromium is stopping/i);
    expect(commandCalls("profiles_identity_apply_preset")).toHaveLength(0);

    await act(async () => {
      pendingStop.resolve(chromiumEnvelope({ ...chromiumStoppedProfile({ profileId: profile.id }), runningCount: 0 }));
    });
  });

  it("renders only supported advanced mode options per identity surface", async () => {
    const profile = profileRecord({ name: "Research", identity: defaultIdentity({ label: "Advanced source" }) });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(profile.identity, [])));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/Preset count4/i));

    const canvasMode = within(panel).getByLabelText(/canvas mode/i) as HTMLSelectElement;
    const webglMode = within(panel).getByLabelText(/webgl mode/i) as HTMLSelectElement;

    expect(Array.from(canvasMode.options).map((option) => option.value)).toEqual(["real", "noise"]);
    expect(Array.from(webglMode.options).map((option) => option.value)).toEqual(["real", "masked", "custom"]);
    expect(Array.from(canvasMode.options).map((option) => option.value)).not.toContain("custom");
    expect(Array.from(webglMode.options).map((option) => option.value)).not.toContain("noise");
  });

  it("shows local field errors and blocks sidecar writes until the advanced draft is parseable", async () => {
    const profile = profileRecord({ name: "Research", identity: defaultIdentity({ label: "Parse source" }) });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(profile.identity, [])));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/Preset count4/i));

    fireEvent.change(within(panel).getByLabelText(/navigator mode/i), { target: { value: "custom" } });
    fireEvent.change(within(panel).getByLabelText(/locale mode/i), { target: { value: "custom" } });
    const hardwareConcurrency = within(panel).getByLabelText(/hardware concurrency/i);
    fireEvent.change(hardwareConcurrency, { target: { value: "9007199254740993" } });
    fireEvent.change(within(panel).getByLabelText(/languages/i), { target: { value: "en-US, , de-DE" } });
    fireEvent.change(within(panel).getByLabelText(/webrtc policy/i), { target: { value: "block" } });

    expect(hardwareConcurrency).toHaveAttribute("aria-invalid", "true");
    expect(panel).toHaveTextContent(/must be a safe whole number/i);
    expect(panel).toHaveTextContent(/without blank entries/i);
    expect(panel).toHaveTextContent(/must be real when WebRTC mode is real/i);
    expect(within(panel).getByRole("button", { name: /check identity/i })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: /save advanced override/i })).toBeDisabled();
    expect(commandCalls("identity_validate")).toHaveLength(1);
    expect(commandCalls("profiles_identity_update")).toHaveLength(0);
  });

  it("checks and saves a warning-bearing advanced override without blocking persistence", async () => {
    const savedIdentity = defaultIdentity({
      label: "Balanced desktop",
      presetId: "balanced-desktop",
      screen: {
        mode: "masked",
        width: 1920,
        height: 1080,
        viewportWidth: 1440,
        viewportHeight: 900,
        colorDepth: 24,
        pixelRatio: 1,
      },
      locale: { mode: "custom", locale: "en-US", languages: ["en-US", "en"], timezoneId: "UTC" },
    });
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    const checkedIdentity = defaultIdentity({
      label: "Custom identity override",
      presetId: null,
      screen: {
        mode: "masked",
        width: 3200,
        height: 1080,
        viewportWidth: 1440,
        viewportHeight: 900,
        colorDepth: 24,
        pixelRatio: 1,
      },
      locale: { mode: "custom", locale: "en-US", languages: ["en-US", "en"], timezoneId: "UTC" },
    });
    const warning = identityWarning({
      code: "IDENTITY_VIEWPORT_MISMATCH",
      message: "Screen width and viewport width are unusual together.",
      surface: "screen",
      path: "screen.viewportWidth",
    });
    const updatedProfile = profileRecord({ id: profile.id, name: "Research", identity: checkedIdentity, updatedAt: "2026-05-04T18:20:00.000Z" });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(savedIdentity, [])))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(checkedIdentity, [warning])))
      .mockResolvedValueOnce(profileEnvelope(profileResult([updatedProfile], { profile: updatedProfile, warnings: [warning] })));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/Preset count4/i));

    fireEvent.change(within(panel).getByLabelText(/screen width/i), { target: { value: "3200" } });
    fireEvent.click(within(panel).getByRole("button", { name: /check identity/i }));

    await waitFor(() => expect(panel).toHaveTextContent(/Identity check completed with 1 warning/i));
    expect(panel).toHaveTextContent(/Warnings are visible and saveable/i);
    expect(panel).toHaveTextContent(/IDENTITY_VIEWPORT_MISMATCH/i);
    expect(within(panel).getByRole("button", { name: /save advanced override/i })).toBeEnabled();

    fireEvent.click(within(panel).getByRole("button", { name: /save advanced override/i }));

    await waitFor(() => expect(panel).toHaveTextContent(/Advanced override saved with 1 warning/i));
    expect(panel).toHaveTextContent(/Saved override warnings/i);
    expect(card).toHaveTextContent(/Custom identity override/i);
    expect(card).toHaveTextContent(/No preset/i);
    expect(commandCalls("profiles_identity_update")).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledWith("profiles_identity_update", {
      profileId: profile.id,
      identity: expect.objectContaining({
        label: "Custom identity override",
        presetId: null,
        screen: expect.objectContaining({ mode: "masked", width: 3200 }),
        locale: expect.objectContaining({ languages: ["en-US", "en"] }),
      }),
    });
  });

  it("renders typed validation errors with detailRef while preserving the draft and avoiding writes", async () => {
    const savedIdentity = defaultIdentity({
      label: "Unsupported source",
      screen: {
        mode: "masked",
        width: 1920,
        height: 1080,
        viewportWidth: 1440,
        viewportHeight: 900,
        colorDepth: 24,
        pixelRatio: 1,
      },
    });
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(savedIdentity, [])))
      .mockRejectedValueOnce(profileError("IDENTITY_UNSUPPORTED_MODE", "The identity mode is not supported by this surface.", "sidecar-unsupported-detail"));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/Preset count4/i));

    fireEvent.change(within(panel).getByLabelText(/advanced identity label/i), { target: { value: "Lab draft" } });
    fireEvent.click(within(panel).getByRole("button", { name: /check identity/i }));

    await waitFor(() => expect(panel).toHaveTextContent(/IDENTITY_UNSUPPORTED_MODE/i));
    expect(panel).toHaveTextContent(/sidecar-unsupported-detail/i);
    expect(within(panel).getByLabelText(/advanced identity label/i)).toHaveValue("Lab draft");
    expect(commandCalls("profiles_identity_update")).toHaveLength(0);
  });

  it("keeps previous profile truth visible when save returns a typed invalid identity error", async () => {
    const savedIdentity = defaultIdentity({
      label: "Original identity",
      presetId: null,
      screen: {
        mode: "masked",
        width: 1920,
        height: 1080,
        viewportWidth: 1440,
        viewportHeight: 900,
        colorDepth: 24,
        pixelRatio: 1,
      },
    });
    const profile = profileRecord({ name: "Research", identity: savedIdentity });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(savedIdentity, [])))
      .mockRejectedValueOnce(profileError("IDENTITY_INVALID", "The advanced identity override failed validation.", "sidecar-save-detail"));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    const summary = within(card).getByLabelText(/research saved identity summary/i);
    fireEvent.click(within(card).getByRole("button", { name: /configure identity for research/i }));
    const panel = await within(card).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(panel).toHaveTextContent(/Preset count4/i));

    fireEvent.change(within(panel).getByLabelText(/screen width/i), { target: { value: "3200" } });
    fireEvent.click(within(panel).getByRole("button", { name: /save advanced override/i }));

    await waitFor(() => expect(panel).toHaveTextContent(/IDENTITY_INVALID/i));
    expect(panel).toHaveTextContent(/The advanced identity override failed validation/i);
    expect(panel).toHaveTextContent(/sidecar-save-detail/i);
    expect(within(panel).getByLabelText(/screen width/i)).toHaveValue("3200");
    expect(summary).toHaveTextContent(/Original identity/i);
    expect(summary).not.toHaveTextContent(/Custom identity override/i);
    expect(commandCalls("profiles_identity_update")).toHaveLength(1);
    expect(commandCalls("profiles_list")).toHaveLength(1);
  });

  it("restores a saved advanced override from a fresh startup profile list", async () => {
    const savedOverride = defaultIdentity({
      label: "Lab viewport override",
      presetId: null,
      browser: { mode: "custom", userAgent: "Mozilla/5.0 Lab Override" },
      screen: {
        mode: "custom",
        width: 2560,
        height: 1440,
        viewportWidth: 1600,
        viewportHeight: 1000,
        colorDepth: 24,
        pixelRatio: 1.25,
      },
      canvas: { mode: "noise", noiseSeed: 777 },
    });
    const profile = profileRecord({ name: "Research", identity: savedOverride });
    mockStartup([profile]);

    const firstRender = render(<App />);
    const firstCard = await screen.findByRole("listitem", { name: /research/i });
    expect(firstCard).toHaveTextContent(/Lab viewport override/i);
    expect(firstCard).toHaveTextContent(/Browser custom/i);
    expect(firstCard).toHaveTextContent(/Screen custom/i);
    expect(firstCard).toHaveTextContent(/Canvas noise/i);

    firstRender.unmount();
    mockInvoke.mockReset();
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(identityEnvelope(identityPresetResult()))
      .mockResolvedValueOnce(identityEnvelope(identityValidationResult(savedOverride, [])));

    render(<App />);
    const restartedCard = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(restartedCard).getByRole("button", { name: /configure identity for research/i }));
    const restartedPanel = await within(restartedCard).findByRole("region", { name: /configure identity for research/i });
    await waitFor(() => expect(restartedPanel).toHaveTextContent(/Preset count4/i));

    expect(within(restartedPanel).getByLabelText(/advanced identity label/i)).toHaveValue("Lab viewport override");
    expect(within(restartedPanel).getByLabelText(/user agent/i)).toHaveValue("Mozilla/5.0 Lab Override");
    expect(within(restartedPanel).getByLabelText(/screen width/i)).toHaveValue("2560");
    expect(within(restartedPanel).getByLabelText(/canvas noise seed/i)).toHaveValue("777");
    expect(commandCalls("profiles_list")).toHaveLength(1);
  });

  it("renders startup profile load failures as actionable recovery without claiming an empty store", async () => {
    mockInvoke
      .mockResolvedValueOnce(healthEnvelope())
      .mockRejectedValueOnce(profileError("SIDECAR_UNAVAILABLE", "The profile bridge is unavailable.", "startup-detail"))
      .mockResolvedValueOnce(chromiumEnvelope(chromiumStatusResult()));

    render(<App />);

    const feedback = await screen.findByLabelText(/profile operation feedback/i);
    expect(feedback).toHaveTextContent(/Startup profile load/i);
    expect(feedback).toHaveTextContent(/SIDECAR_UNAVAILABLE/i);
    expect(feedback).toHaveTextContent(/startup-detail/i);
    expect(screen.getByLabelText(/profile load recovery/i)).toHaveTextContent(/Profile truth could not be loaded/i);
    expect(screen.getByRole("button", { name: /retry profile load/i })).toBeEnabled();
    expect(screen.queryByLabelText(/empty profile library/i)).not.toBeInTheDocument();
  });

  it("creates a profile through the typed client and replaces the visible list from the refreshed result", async () => {
    const created = profileRecord({ name: "Research" });
    mockStartup([]);
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult([created], { profile: created })));

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    const input = screen.getByLabelText(/profile name/i);
    fireEvent.change(input, { target: { value: "Research" } });
    fireEvent.click(screen.getByRole("button", { name: /^create profile$/i }));

    expect(await screen.findByRole("listitem", { name: /research/i })).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.getByLabelText(/profile operation feedback/i)).toHaveTextContent(/Last successful profile list contains 1 profile/i);
    expect(mockInvoke).toHaveBeenLastCalledWith("profiles_create", { name: "Research" });
  });

  it("renders invalid-name create errors inline and preserves the user's typed input", async () => {
    mockStartup([]);
    mockInvoke.mockRejectedValueOnce(profileError("PROFILE_INVALID_NAME", "Profile name is invalid.", "invalid-detail"));

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    const input = screen.getByLabelText(/profile name/i);
    fireEvent.change(input, { target: { value: "bad/name" } });
    fireEvent.click(screen.getByRole("button", { name: /^create profile$/i }));

    const feedback = await screen.findByLabelText(/profile operation feedback/i);
    expect(feedback).toHaveTextContent(/Create profile/i);
    expect(feedback).toHaveTextContent(/PROFILE_INVALID_NAME/i);
    expect(feedback).toHaveTextContent(/invalid-detail/i);
    expect(input).toHaveValue("bad/name");
    expect(screen.getByRole("button", { name: /^create profile$/i })).toBeEnabled();
    expect(screen.getByLabelText(/empty profile library/i)).toBeInTheDocument();
  });

  it("keeps the previous list and edit input after duplicate-name rename errors", async () => {
    const research = profileRecord({ id: "11111111-1111-1111-1111-111111111111", name: "Research" });
    const work = profileRecord({ id: "22222222-2222-2222-2222-222222222222", name: "Work" });
    mockStartup([research, work]);
    mockInvoke.mockRejectedValueOnce(profileError("PROFILE_DUPLICATE_NAME", "Profile name already exists.", "duplicate-detail"));

    render(<App />);

    const workCard = await screen.findByRole("listitem", { name: /work/i });
    fireEvent.click(within(workCard).getByRole("button", { name: /rename/i }));
    const renameInput = within(workCard).getByLabelText(/new profile name/i);
    fireEvent.change(renameInput, { target: { value: "Research" } });
    fireEvent.click(within(workCard).getByRole("button", { name: /save rename/i }));

    const feedback = await screen.findByLabelText(/profile operation feedback/i);
    expect(feedback).toHaveTextContent(/Rename profile/i);
    expect(feedback).toHaveTextContent(/PROFILE_DUPLICATE_NAME/i);
    expect(feedback).toHaveTextContent(/duplicate-detail/i);
    expect(renameInput).toHaveValue("Research");
    expect(screen.getByRole("listitem", { name: /research/i })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: /work/i })).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenLastCalledWith("profiles_update", {
      id: "22222222-2222-2222-2222-222222222222",
      name: "Research",
    });
  });

  it("renames a profile and renders the changed card from the sidecar refreshed list", async () => {
    const original = profileRecord({ name: "Research" });
    const renamed = profileRecord({ name: "Field Work", updatedAt: "2026-05-04T18:05:00.000Z" });
    mockStartup([original]);
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult([renamed], { profile: renamed })));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /rename/i }));
    const renameInput = within(card).getByLabelText(/new profile name/i);
    fireEvent.change(renameInput, { target: { value: "Field Work" } });
    fireEvent.click(within(card).getByRole("button", { name: /save rename/i }));

    const renamedCard = await screen.findByRole("listitem", { name: /field work/i });
    expect(renamedCard).toHaveTextContent(/2026-05-04 18:05:00 UTC/i);
    expect(screen.queryByLabelText(/new profile name/i)).not.toBeInTheDocument();
    expect(mockInvoke).toHaveBeenLastCalledWith("profiles_update", {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Field Work",
    });
  });

  it("requires explicit delete confirmation and removes the card after sidecar success", async () => {
    const profile = profileRecord({ name: "Research" });
    mockStartup([profile]);
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult([])));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /^delete$/i }));

    expect(mockInvoke).toHaveBeenCalledTimes(3);
    const confirmation = within(card).getByRole("group", { name: /confirm delete research/i });
    expect(confirmation).toHaveTextContent(/removes the profile record only/i);
    expect(confirmation).toHaveTextContent(/does not promise browser user-data cleanup/i);

    fireEvent.click(within(confirmation).getByRole("button", { name: /confirm delete research/i }));

    await waitFor(() => expect(screen.queryByRole("listitem", { name: /research/i })).not.toBeInTheDocument());
    expect(screen.getByLabelText(/empty profile library/i)).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenLastCalledWith("profiles_delete", {
      id: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("surfaces delete failures inline while keeping the prior list and re-enabling confirmation", async () => {
    const profile = profileRecord({ name: "Research" });
    mockStartup([profile]);
    mockInvoke.mockRejectedValueOnce(profileError("PROFILE_DELETE_FAILED", "Profile delete bookkeeping failed.", "delete-detail"));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /^delete$/i }));
    const confirmation = within(card).getByRole("group", { name: /confirm delete research/i });
    fireEvent.click(within(confirmation).getByRole("button", { name: /confirm delete research/i }));

    const feedback = await screen.findByLabelText(/profile operation feedback/i);
    expect(feedback).toHaveTextContent(/Delete profile/i);
    expect(feedback).toHaveTextContent(/PROFILE_DELETE_FAILED/i);
    expect(feedback).toHaveTextContent(/delete-detail/i);
    expect(screen.getByRole("listitem", { name: /research/i })).toBeInTheDocument();
    expect(within(confirmation).getByRole("button", { name: /confirm delete research/i })).toBeEnabled();
  });

  it("renders malformed profile mutation responses as protocol errors and keeps prior list visible", async () => {
    const profile = profileRecord({ name: "Research" });
    mockStartup([profile]);
    mockInvoke.mockResolvedValueOnce(profileEnvelope(profileResult([profile])));

    render(<App />);

    await screen.findByRole("listitem", { name: /research/i });
    const input = screen.getByLabelText(/profile name/i);
    fireEvent.change(input, { target: { value: "Travel" } });
    fireEvent.click(screen.getByRole("button", { name: /^create profile$/i }));

    const feedback = await screen.findByLabelText(/profile operation feedback/i);
    expect(feedback).toHaveTextContent(/SIDECAR_PROTOCOL_ERROR/i);
    expect(feedback).toHaveTextContent(/protocol/i);
    expect(input).toHaveValue("Travel");
    expect(screen.getByRole("listitem", { name: /research/i })).toBeInTheDocument();
  });

  it("launches a stored profile, renders validated PID proof, and disables unsafe row CRUD while running", async () => {
    const profile = profileRecord({ name: "Research" });
    const running = chromiumRunningProfile({ profileId: profile.id, pid: 7321 });
    mockStartup([profile]);
    mockInvoke
      .mockResolvedValueOnce(chromiumEnvelope({ ...running, runningCount: 1 }))
      .mockResolvedValueOnce(chromiumEnvelope(chromiumStatusResult({ profiles: [running] })));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /launch chromium/i }));

    await waitFor(() => expect(card).toHaveTextContent(/Running from sidecar runtime bookkeeping/i));
    expect(card).toHaveTextContent(/PID7321/i);
    expect(card).toHaveTextContent(/2026-05-04 18:05:00 UTC/i);
    expect(within(card).getByRole("button", { name: /stop chromium/i })).toBeEnabled();
    expect(within(card).getByRole("button", { name: /rename/i })).toBeDisabled();
    expect(within(card).getByRole("button", { name: /^delete$/i })).toBeDisabled();
    expect(screen.getByLabelText(/profile observability/i)).toHaveTextContent(/Running count1/i);
    expect(mockInvoke).toHaveBeenCalledWith("chromium_launch", { profileId: profile.id });
  });

  it("renders missing-executable launch errors as row-level recoverable lifecycle feedback", async () => {
    const profile = profileRecord({ name: "Research" });
    mockStartup([profile]);
    mockInvoke.mockRejectedValueOnce(
      profileError("CHROMIUM_EXECUTABLE_NOT_FOUND", "Chromium executable was not found.", "missing-chromium-detail"),
    );

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /launch chromium/i }));

    const recovery = await within(card).findByLabelText(/research lifecycle recovery/i);
    expect(recovery).toHaveTextContent(/Launch Chromium failed safely/i);
    expect(recovery).toHaveTextContent(/CHROMIUM_EXECUTABLE_NOT_FOUND/i);
    expect(recovery).toHaveTextContent(/sidecar/i);
    expect(recovery).toHaveTextContent(/missing-chromium-detail/i);
    expect(within(recovery).getByRole("button", { name: /retry launch/i })).toBeEnabled();
    expect(card).toHaveTextContent(/Stopped/i);
    expect(card).not.toHaveTextContent(/PID4242/i);
  });

  it("preserves already-running launch errors and prevents duplicate launch clicks while pending", async () => {
    const profile = profileRecord({ name: "Research" });
    mockStartup([profile]);
    mockInvoke.mockRejectedValueOnce(
      profileError("CHROMIUM_ALREADY_RUNNING", "Chromium is already running for this profile.", "already-running-detail"),
    );

    const firstRender = render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /launch chromium/i }));

    const recovery = await within(card).findByLabelText(/research lifecycle recovery/i);
    expect(recovery).toHaveTextContent(/CHROMIUM_ALREADY_RUNNING/i);
    expect(recovery).toHaveTextContent(/already-running-detail/i);
    firstRender.unmount();

    const pendingLaunch = deferred<unknown>();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(((command: string) => {
      if (command === "sidecar_health") {
        return Promise.resolve(healthEnvelope());
      }
      if (command === "profiles_list") {
        return Promise.resolve(profileEnvelope(profileResult([profile])));
      }
      if (command === "chromium_status") {
        return Promise.resolve(chromiumEnvelope(chromiumStatusResult()));
      }
      if (command === "chromium_launch") {
        return pendingLaunch.promise;
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    }) as typeof invoke);

    render(<App />);

    const pendingCard = await screen.findByRole("listitem", { name: /research/i });
    const launchButton = within(pendingCard).getByRole("button", { name: /launch chromium/i });
    fireEvent.click(launchButton);
    fireEvent.click(launchButton);

    expect(within(pendingCard).getByRole("button", { name: /launching/i })).toBeDisabled();
    expect(commandCalls("chromium_launch")).toHaveLength(1);

    await act(async () => {
      pendingLaunch.resolve(chromiumEnvelope({ ...chromiumRunningProfile({ profileId: profile.id }), runningCount: 1 }));
      await pendingLaunch.promise;
    });
  });

  it("treats malformed launch success as a recoverable protocol error without showing Running", async () => {
    const profile = profileRecord({ name: "Research" });
    mockStartup([profile]);
    mockInvoke.mockResolvedValueOnce(
      chromiumEnvelope({ ...chromiumRunningProfile({ profileId: profile.id, pid: "not-a-pid" }), runningCount: 1 }),
    );

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /launch chromium/i }));

    const recovery = await within(card).findByLabelText(/research lifecycle recovery/i);
    expect(recovery).toHaveTextContent(/SIDECAR_PROTOCOL_ERROR/i);
    expect(recovery).toHaveTextContent(/protocol/i);
    expect(card).toHaveTextContent(/Stopped/i);
    expect(within(card).queryByRole("button", { name: /stop chromium/i })).not.toBeInTheDocument();
  });

  it("stops only the selected running profile and returns the row to stopped proof", async () => {
    const profile = profileRecord({ name: "Research" });
    const running = chromiumRunningProfile({ profileId: profile.id, pid: 8181 });
    const stopped = chromiumStoppedProfile({ profileId: profile.id, termination: "graceful" });
    mockStartup([profile], chromiumStatusResult({ profiles: [running] }));
    mockInvoke
      .mockResolvedValueOnce(chromiumEnvelope({ ...stopped, runningCount: 0 }))
      .mockResolvedValueOnce(chromiumEnvelope(chromiumStatusResult({ profiles: [], runningCount: 0 })));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    expect(card).toHaveTextContent(/PID8181/i);
    fireEvent.click(within(card).getByRole("button", { name: /stop chromium/i }));

    await waitFor(() => expect(card).toHaveTextContent(/Stopped/i));
    expect(card).toHaveTextContent(/graceful/i);
    expect(within(card).getByRole("button", { name: /launch chromium/i })).toBeEnabled();
    expect(mockInvoke).toHaveBeenCalledWith("chromium_stop", { profileId: profile.id });
  });

  it("keeps PID proof visible when stop fails and exposes Retry Stop", async () => {
    const profile = profileRecord({ name: "Research" });
    const running = chromiumRunningProfile({ profileId: profile.id, pid: 9191 });
    mockStartup([profile], chromiumStatusResult({ profiles: [running] }));
    mockInvoke.mockRejectedValueOnce(
      profileError("CHROMIUM_STOP_FAILED", "Chromium process could not be stopped.", "stop-detail"),
    );

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /stop chromium/i }));

    const recovery = await within(card).findByLabelText(/research lifecycle recovery/i);
    expect(card).toHaveTextContent(/Running/i);
    expect(card).toHaveTextContent(/PID9191/i);
    expect(recovery).toHaveTextContent(/CHROMIUM_STOP_FAILED/i);
    expect(recovery).toHaveTextContent(/stop-detail/i);
    expect(within(recovery).getByRole("button", { name: /retry stop/i })).toBeEnabled();
  });

  it("renders status bridge failures without losing the stored profile list", async () => {
    const profile = profileRecord({ name: "Research" });
    mockInvoke
      .mockResolvedValueOnce(healthEnvelope())
      .mockResolvedValueOnce(profileEnvelope(profileResult([profile])))
      .mockRejectedValueOnce(
        profileError("SIDECAR_TIMEOUT", "The Python sidecar did not respond before the bridge timeout.", "status-timeout-detail"),
      );

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    const recovery = await within(card).findByLabelText(/research lifecycle recovery/i);
    expect(card).toHaveTextContent(/Stopped/i);
    expect(recovery).toHaveTextContent(/Status refresh failed safely/i);
    expect(recovery).toHaveTextContent(/SIDECAR_TIMEOUT/i);
    expect(recovery).toHaveTextContent(/bridge/i);
    expect(within(recovery).getByRole("button", { name: /retry status refresh/i })).toBeEnabled();
    expect(screen.getByLabelText(/profile observability/i)).toHaveTextContent(/SIDECAR_TIMEOUT/i);
  });

  it("reconciles an externally closed Chromium process on the next status refresh", async () => {
    const profile = profileRecord({ name: "Research" });
    const running = chromiumRunningProfile({ profileId: profile.id, pid: 5151 });
    mockStartup([profile], chromiumStatusResult({ profiles: [running] }));
    mockInvoke.mockResolvedValueOnce(chromiumEnvelope(chromiumStatusResult({ profiles: [], runningCount: 0 })));

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    expect(card).toHaveTextContent(/PID5151/i);
    fireEvent.click(screen.getByRole("button", { name: /refresh lifecycle status/i }));

    await waitFor(() => expect(card).toHaveTextContent(/Last status refresh reconciled/i));
    expect(card).toHaveTextContent(/reconciled/i);
    expect(within(card).getByRole("button", { name: /launch chromium/i })).toBeEnabled();
    expect(screen.getByLabelText(/profile observability/i)).toHaveTextContent(/Last reconciliation11111111-1111-1111-1111-111111111111 reconciled/i);
  });

  it("renders the legacy import panel as an explicit flow without automatic scan or import calls", async () => {
    mockStartup([]);

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    expect(screen.getByRole("heading", { name: /bring old theprivator profiles/i })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: /scan legacy profiles/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /scan legacy root/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /import selected/i })).not.toBeInTheDocument();
    expect(commandCalls("legacy_scan_profiles")).toHaveLength(0);
    expect(commandCalls("legacy_import_profiles")).toHaveLength(0);
  });

  it("scans legacy candidates, keeps target names editable, displays candidate issues, and requires rescan after path changes", async () => {
    const first = legacyCandidate({ legacyId: "legacy-good", targetName: "Imported Good" });
    const second = legacyCandidate({
      legacyId: "legacy-needs-fix",
      folderName: "needs-fix",
      legacyName: null,
      targetName: "Taken",
      userData: { status: "missing" },
      issues: [
        legacyIssue({ code: "PROFILE_DUPLICATE_NAME", message: "Profile name already exists.", detailRef: "sidecar-duplicate" }),
        legacyIssue({ code: "PROFILE_INVALID_NAME", message: "Profile name is invalid.", detailRef: "sidecar-invalid" }),
      ],
    });
    mockStartup([]);
    mockInvoke.mockResolvedValueOnce(legacyEnvelope(legacyScanResult({ candidates: [first, second] })));

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    const rootInput = screen.getByLabelText(/legacy profile root/i);
    fireEvent.change(rootInput, { target: { value: "/tmp/legacy-root" } });
    fireEvent.click(screen.getByRole("button", { name: /scan legacy root/i }));

    const candidateList = await screen.findByRole("list", { name: /scanned legacy profiles/i });
    const goodRow = within(candidateList).getByRole("listitem", { name: /legacy research/i });
    const issueRow = within(candidateList).getByRole("listitem", { name: /needs-fix/i });
    expect(within(goodRow).getByLabelText(/target profile name/i)).toHaveValue("Imported Good");
    expect(issueRow).toHaveTextContent(/No user-data found/i);
    expect(issueRow).toHaveTextContent(/PROFILE_DUPLICATE_NAME/i);
    expect(issueRow).toHaveTextContent(/PROFILE_INVALID_NAME/i);
    expect(screen.getByRole("button", { name: /import selected \(0\)/i })).toBeDisabled();

    fireEvent.click(within(goodRow).getByRole("checkbox", { name: /select profile/i }));
    expect(screen.getByRole("button", { name: /import selected \(1\)/i })).toBeEnabled();
    fireEvent.change(within(goodRow).getByLabelText(/target profile name/i), { target: { value: "Edited Good" } });
    expect(within(goodRow).getByLabelText(/target profile name/i)).toHaveValue("Edited Good");

    fireEvent.change(rootInput, { target: { value: "/tmp/another-legacy-root" } });
    expect(await screen.findByText(/path changed after the last scan/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import selected \(1\)/i })).toBeDisabled();
    expect(mockInvoke).toHaveBeenCalledWith("legacy_scan_profiles", { legacyRoot: "/tmp/legacy-root" });
  });

  it("surfaces empty legacy scan results without enabling import", async () => {
    mockStartup([]);
    mockInvoke.mockResolvedValueOnce(legacyEnvelope(legacyScanResult({ candidates: [] })));

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    fireEvent.change(screen.getByLabelText(/legacy profile root/i), { target: { value: "/tmp/empty-legacy-root" } });
    fireEvent.click(screen.getByRole("button", { name: /scan legacy root/i }));

    expect(await screen.findByLabelText(/no legacy profiles found/i)).toHaveTextContent(/No immediate legacy profile folders were found/i);
    expect(screen.getByRole("button", { name: /import selected \(0\)/i })).toBeDisabled();
    expect(screen.getByLabelText(/legacy import observability/i)).toHaveTextContent(/Scanned profiles0/i);
  });

  it("imports selected profiles with success, partial, and failure outcomes and refreshes profile cards from the store", async () => {
    const candidates = [
      legacyCandidate({ legacyId: "legacy-success", folderName: "good", legacyName: "Good Legacy", targetName: "Imported Good" }),
      legacyCandidate({ legacyId: "legacy-partial", folderName: "partial", legacyName: "Partial Legacy", targetName: "Imported Partial" }),
      legacyCandidate({ legacyId: "legacy-failed", folderName: "failed", legacyName: "Failed Legacy", targetName: "Imported Failed" }),
    ];
    const success = legacyOutcome({ legacyId: "legacy-success", folderName: "good", legacyName: "Good Legacy", targetName: "Imported Good", status: "success", copyStatus: "copied", profileId: "33333333-3333-3333-3333-333333333333" });
    const partial = legacyOutcome({
      legacyId: "legacy-partial",
      folderName: "partial",
      legacyName: "Partial Legacy",
      targetName: "Imported Partial",
      status: "partial",
      copyStatus: "failed",
      profileId: "44444444-4444-4444-4444-444444444444",
      error: legacyError({ code: "LEGACY_USER_DATA_COPY_FAILED", message: "Legacy user-data copy failed.", detailRef: "sidecar-copy-partial" }),
    });
    const failed = legacyOutcome({
      legacyId: "legacy-failed",
      folderName: "failed",
      legacyName: "Failed Legacy",
      targetName: "Imported Failed",
      status: "failed",
      copyStatus: "skipped",
      profileId: undefined,
      error: legacyError({ code: "LEGACY_SELECTION_INVALID", detailRef: "sidecar-stale-selection" }),
    });
    const importedGood = profileRecord({ id: "33333333-3333-3333-3333-333333333333", name: "Imported Good" });
    const importedPartial = profileRecord({ id: "44444444-4444-4444-4444-444444444444", name: "Imported Partial" });
    mockStartup([]);
    mockInvoke
      .mockResolvedValueOnce(legacyEnvelope(legacyScanResult({ candidates })))
      .mockResolvedValueOnce(legacyEnvelope(legacyImportResult({ outcomes: [success, partial, failed] })))
      .mockResolvedValueOnce(profileEnvelope(profileResult([importedGood, importedPartial])));

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    fireEvent.change(screen.getByLabelText(/legacy profile root/i), { target: { value: "/tmp/legacy-root" } });
    fireEvent.click(screen.getByRole("button", { name: /scan legacy root/i }));
    const candidateList = await screen.findByRole("list", { name: /scanned legacy profiles/i });
    within(candidateList).getAllByRole("checkbox", { name: /select profile/i }).forEach((checkbox) => fireEvent.click(checkbox));
    fireEvent.click(screen.getByRole("button", { name: /import selected \(3\)/i }));

    const outcomes = await screen.findByLabelText(/legacy import outcomes/i);
    expect(outcomes).toHaveTextContent(/Success1/i);
    expect(outcomes).toHaveTextContent(/Partial1/i);
    expect(outcomes).toHaveTextContent(/Failed1/i);
    expect(outcomes).toHaveTextContent(/User-data copied/i);
    expect(outcomes).toHaveTextContent(/User-data copy failed/i);
    expect(outcomes).toHaveTextContent(/LEGACY_USER_DATA_COPY_FAILED/i);
    expect(outcomes).toHaveTextContent(/sidecar-copy-partial/i);
    expect(outcomes).toHaveTextContent(/LEGACY_SELECTION_INVALID/i);
    expect(outcomes).not.toHaveTextContent("/tmp/legacy-root");
    expect(outcomes).not.toHaveTextContent("proxy-user-should-not-leak");
    expect(outcomes).not.toHaveTextContent("proxy-pass-should-not-leak");

    const profileGrid = await screen.findByRole("list", { name: /stored profiles/i });
    expect(within(profileGrid).getByRole("listitem", { name: /imported good/i })).toBeInTheDocument();
    expect(within(profileGrid).getByRole("listitem", { name: /imported partial/i })).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("legacy_import_profiles", {
      legacyRoot: "/tmp/legacy-root",
      items: [
        { legacyId: "legacy-success", targetName: "Imported Good" },
        { legacyId: "legacy-partial", targetName: "Imported Partial" },
        { legacyId: "legacy-failed", targetName: "Imported Failed" },
      ],
    });
  });

  it("retains scanned rows, selections, and edited target names after a bridge timeout import error", async () => {
    mockStartup([]);
    mockInvoke
      .mockResolvedValueOnce(legacyEnvelope(legacyScanResult({ candidates: [legacyCandidate({ legacyId: "legacy-timeout", targetName: "Timeout Profile" })] })))
      .mockRejectedValueOnce(profileError("SIDECAR_TIMEOUT", "The Python sidecar did not respond before the bridge timeout.", "bridge-timeout-detail"));

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    fireEvent.change(screen.getByLabelText(/legacy profile root/i), { target: { value: "/tmp/legacy-root" } });
    fireEvent.click(screen.getByRole("button", { name: /scan legacy root/i }));
    const row = await screen.findByRole("listitem", { name: /legacy research/i });
    fireEvent.click(within(row).getByRole("checkbox", { name: /select profile/i }));
    fireEvent.change(within(row).getByLabelText(/target profile name/i), { target: { value: "Timeout Edited" } });
    fireEvent.click(screen.getByRole("button", { name: /import selected \(1\)/i }));

    const error = await screen.findByText(/SIDECAR_TIMEOUT/i);
    expect(error).toBeInTheDocument();
    expect(screen.getAllByText(/bridge-timeout-detail/i).length).toBeGreaterThan(0);
    expect(within(row).getByRole("checkbox", { name: /select profile/i })).toBeChecked();
    expect(within(row).getByLabelText(/target profile name/i)).toHaveValue("Timeout Edited");
    expect(screen.getByRole("button", { name: /import selected \(1\)/i })).toBeEnabled();
  });

  it("keeps import outcomes visible and reports profile reload failures separately", async () => {
    mockStartup([]);
    mockInvoke
      .mockResolvedValueOnce(legacyEnvelope(legacyScanResult({ candidates: [legacyCandidate({ legacyId: "legacy-refresh", targetName: "Imported Refresh" })] })))
      .mockResolvedValueOnce(legacyEnvelope(legacyImportResult({ outcomes: [legacyOutcome({ legacyId: "legacy-refresh", targetName: "Imported Refresh" })] })))
      .mockRejectedValueOnce(profileError("PROFILE_STORE_UNAVAILABLE", "Profile store could not be reloaded.", "refresh-after-import-detail"));

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    fireEvent.change(screen.getByLabelText(/legacy profile root/i), { target: { value: "/tmp/legacy-root" } });
    fireEvent.click(screen.getByRole("button", { name: /scan legacy root/i }));
    const row = await screen.findByRole("listitem", { name: /legacy research/i });
    fireEvent.click(within(row).getByRole("checkbox", { name: /select profile/i }));
    fireEvent.click(screen.getByRole("button", { name: /import selected \(1\)/i }));

    const outcomes = await screen.findByLabelText(/legacy import outcomes/i);
    expect(outcomes).toHaveTextContent(/Imported Refresh/i);
    expect(await screen.findByText(/Profile list refresh after import failed/i)).toBeInTheDocument();
    expect(screen.getAllByText(/PROFILE_STORE_UNAVAILABLE/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/refresh-after-import-detail/i).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/empty profile library/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/profile load recovery/i)).toHaveTextContent(/Profile truth could not be loaded/i);
  });

  it("normalizes malformed legacy import payloads to visible protocol errors while retaining scan state", async () => {
    mockStartup([]);
    mockInvoke
      .mockResolvedValueOnce(legacyEnvelope(legacyScanResult({ candidates: [legacyCandidate({ legacyId: "legacy-malformed", targetName: "Malformed Import" })] })))
      .mockResolvedValueOnce(legacyEnvelope(legacyImportResult({ requestedCount: 2 })));

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    fireEvent.change(screen.getByLabelText(/legacy profile root/i), { target: { value: "/tmp/legacy-root" } });
    fireEvent.click(screen.getByRole("button", { name: /scan legacy root/i }));
    const row = await screen.findByRole("listitem", { name: /legacy research/i });
    fireEvent.click(within(row).getByRole("checkbox", { name: /select profile/i }));
    fireEvent.click(screen.getByRole("button", { name: /import selected \(1\)/i }));

    expect(await screen.findByText(/SIDECAR_PROTOCOL_ERROR/i)).toBeInTheDocument();
    expect(screen.getAllByText(/protocol/i).length).toBeGreaterThan(0);
    expect(within(row).getByRole("checkbox", { name: /select profile/i })).toBeChecked();
    expect(within(row).getByLabelText(/target profile name/i)).toHaveValue("Malformed Import");
  });

  it("looks up profile diagnostic refs with safe event summaries while retaining profile form state", async () => {
    const detailRef = "sidecar-profile-invalid";
    mockStartup([]);
    mockInvoke
      .mockRejectedValueOnce(profileError("PROFILE_INVALID_NAME", "Profile name is invalid.", detailRef))
      .mockResolvedValueOnce(
        diagnosticLookupResult(detailRef, {
          entries: [
            diagnosticEntry(detailRef, {
              errorCode: "PROFILE_INVALID_NAME",
              method: "profiles.create",
              requestId: "profile-request-1",
            }),
          ],
        }),
      );

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    const input = screen.getByLabelText(/profile name/i);
    fireEvent.change(input, { target: { value: "bad/name" } });
    fireEvent.click(screen.getByRole("button", { name: /^create profile$/i }));

    const feedback = await screen.findByLabelText(/profile operation feedback/i);
    expect(feedback).toHaveTextContent(/PROFILE_INVALID_NAME/i);
    fireEvent.click(within(feedback).getByRole("button", { name: /lookup diagnostics for sidecar-profile-invalid/i }));

    const lookupPanel = await screen.findByLabelText(/diagnostic lookup/i);
    expect(lookupPanel).toHaveTextContent(/sidecar-profile-invalid/i);
    expect(lookupPanel).toHaveTextContent(/sidecar\.request/i);
    expect(lookupPanel).toHaveTextContent(/python-sidecar/i);
    expect(lookupPanel).toHaveTextContent(/profiles\.create/i);
    expect(lookupPanel).toHaveTextContent(/PROFILE_INVALID_NAME/i);
    expect(lookupPanel).toHaveTextContent(DIAGNOSTIC_RELATIVE_LOG_PATH);
    expect(lookupPanel).not.toHaveTextContent("/tmp/legacy-root");
    expect(lookupPanel).not.toHaveTextContent("stdout body");
    expect(lookupPanel).not.toHaveTextContent("stderr body");
    expect(input).toHaveValue("bad/name");
    expect(screen.getByLabelText(/empty profile library/i)).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenLastCalledWith("diagnostics_lookup", { detailRef });
  });

  it("shows UI-local no-log explanations and recovers from lookup command rejection without clearing legacy state", async () => {
    const detailRef = "ui-legacy-legacy-root-required";
    mockStartup([]);
    mockInvoke
      .mockResolvedValueOnce({ found: false, detailRef, reason: "ui-local", logPath: null, entries: [] })
      .mockRejectedValueOnce(profileError("SIDECAR_TIMEOUT", "Diagnostics lookup timed out.", "bridge-lookup-timeout"))
      .mockResolvedValueOnce({ found: false, detailRef, reason: "ui-local", logPath: null, entries: [] });

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    fireEvent.submit(screen.getByRole("form", { name: /scan legacy profiles/i }));

    const scanError = await screen.findByText(/Enter a legacy ThePrivator profile root/i);
    const legacyPanel = scanError.closest("section") ?? screen.getByLabelText(/scan legacy profiles/i);
    fireEvent.click(within(legacyPanel as HTMLElement).getByRole("button", { name: /lookup diagnostics for ui-legacy-legacy-root-required/i }));

    const lookupPanel = await screen.findByLabelText(/diagnostic lookup/i);
    expect(lookupPanel).toHaveTextContent(/UI-local reference/i);
    expect(lookupPanel).toHaveTextContent(/no durable diagnostic log/i);
    expect(lookupPanel).not.toHaveTextContent(DIAGNOSTIC_RELATIVE_LOG_PATH);

    fireEvent.click(within(legacyPanel as HTMLElement).getByRole("button", { name: /lookup diagnostics for ui-legacy-legacy-root-required/i }));
    await waitFor(() => expect(lookupPanel).toHaveTextContent(/Diagnostics lookup timed out/i));
    expect(lookupPanel).toHaveTextContent(/SIDECAR_TIMEOUT/i);
    expect(screen.getByText(/Enter a legacy ThePrivator profile root/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/empty profile library/i)).toBeInTheDocument();

    fireEvent.click(within(lookupPanel).getByRole("button", { name: /retry diagnostics lookup for ui-legacy-legacy-root-required/i }));
    await waitFor(() => expect(lookupPanel).toHaveTextContent(/UI-local reference/i));
  });

  it("switches selected diagnostics across Chromium lifecycle, legacy issues, and legacy outcomes", async () => {
    const profile = profileRecord({ name: "Research" });
    const issueDetailRef = "sidecar-legacy-duplicate";
    const outcomeDetailRef = "sidecar-copy-partial";
    mockStartup([profile]);
    mockInvoke
      .mockRejectedValueOnce(
        profileError("CHROMIUM_EXECUTABLE_NOT_FOUND", "Chromium executable was not found.", "sidecar-missing-chromium-detail"),
      )
      .mockResolvedValueOnce(
        diagnosticLookupResult("sidecar-missing-chromium-detail", {
          entries: [
            diagnosticEntry("sidecar-missing-chromium-detail", {
              errorCode: "CHROMIUM_EXECUTABLE_NOT_FOUND",
              method: "chromium.launch",
            }),
          ],
        }),
      )
      .mockResolvedValueOnce(
        legacyEnvelope(
          legacyScanResult({
            candidates: [
              legacyCandidate({
                legacyId: "legacy-needs-fix",
                folderName: "needs-fix",
                legacyName: "Legacy Needs Fix",
                targetName: "Legacy Needs Fix",
                issues: [legacyIssue({ code: "PROFILE_DUPLICATE_NAME", detailRef: issueDetailRef })],
              }),
            ],
          }),
        ),
      )
      .mockResolvedValueOnce({ found: false, detailRef: issueDetailRef, reason: "not-persisted", logPath: DIAGNOSTIC_RELATIVE_LOG_PATH, entries: [] })
      .mockResolvedValueOnce(
        legacyEnvelope(
          legacyImportResult({
            outcomes: [
              legacyOutcome({
                legacyId: "legacy-needs-fix",
                targetName: "Legacy Needs Fix",
                status: "partial",
                copyStatus: "failed",
                profileId: profile.id,
                error: legacyError({ code: "LEGACY_USER_DATA_COPY_FAILED", detailRef: outcomeDetailRef }),
              }),
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(profileEnvelope(profileResult([profile])))
      .mockResolvedValueOnce(
        diagnosticLookupResult(outcomeDetailRef, {
          entries: [
            diagnosticEntry(outcomeDetailRef, {
              event: "legacy.import.outcome",
              status: "partial",
              method: "legacy.import",
              errorCode: "LEGACY_USER_DATA_COPY_FAILED",
              context: { legacyId: "legacy-needs-fix" },
            }),
          ],
        }),
      );

    render(<App />);

    const card = await screen.findByRole("listitem", { name: /research/i });
    fireEvent.click(within(card).getByRole("button", { name: /launch chromium/i }));

    const recovery = await within(card).findByLabelText(/research lifecycle recovery/i);
    fireEvent.click(within(recovery).getByRole("button", { name: /lookup diagnostics for sidecar-missing-chromium-detail/i }));
    const lookupPanel = await screen.findByLabelText(/diagnostic lookup/i);
    expect(lookupPanel).toHaveTextContent(/CHROMIUM_EXECUTABLE_NOT_FOUND/i);
    expect(lookupPanel).toHaveTextContent(/chromium\.launch/i);

    fireEvent.change(screen.getByLabelText(/legacy profile root/i), { target: { value: "/tmp/legacy-root" } });
    fireEvent.click(screen.getByRole("button", { name: /scan legacy root/i }));
    const issue = await screen.findByText(/PROFILE_DUPLICATE_NAME/i);
    const issueCard = issue.closest("article") as HTMLElement;
    fireEvent.click(within(issueCard).getByRole("button", { name: /lookup diagnostics for sidecar-legacy-duplicate/i }));
    await waitFor(() => expect(lookupPanel).toHaveTextContent(/sidecar-legacy-duplicate/i));
    expect(lookupPanel).toHaveTextContent(/No persisted diagnostic event matched/i);

    const candidateRow = await screen.findByRole("listitem", { name: /legacy needs fix/i });
    fireEvent.click(within(candidateRow).getByRole("checkbox", { name: /select profile/i }));
    fireEvent.click(screen.getByRole("button", { name: /import selected \(1\)/i }));
    const outcomes = await screen.findByLabelText(/legacy import outcomes/i);
    fireEvent.click(within(outcomes).getByRole("button", { name: /lookup diagnostics for sidecar-copy-partial/i }));

    await waitFor(() => expect(lookupPanel).toHaveTextContent(/legacy\.import\.outcome/i));
    expect(lookupPanel).toHaveTextContent(/legacy-needs-fix/i);
    expect(lookupPanel).toHaveTextContent(/LEGACY_USER_DATA_COPY_FAILED/i);
    expect(lookupPanel).not.toHaveTextContent("/tmp/legacy-root");
    expect(commandCalls("diagnostics_lookup")).toHaveLength(3);
  });

  it("does not add direct browser or Tauri filesystem bypasses for legacy import", () => {
    const source = appSource();

    expect(source).toContain("scanLegacyProfiles");
    expect(source).toContain("importLegacyProfiles");
    expect(source).toContain("listIdentityPresets");
    expect(source).toContain("validateIdentity");
    expect(source).toContain("applyProfileIdentityPreset");
    expect(source).toContain("updateProfileIdentity");
    expect(source).not.toMatch(/@tauri-apps\/plugin-(dialog|fs)/);
    expect(source).not.toMatch(/\binvoke\s*\(/);
    expect(source).not.toMatch(/showOpenFilePicker|webkitdirectory|readTextFile|writeTextFile|localStorage|sessionStorage/);
    expect(source).not.toMatch(/type=\"file\"|type='file'/);
  });

  it("keeps the S01 diagnostic recovery pattern in the compact system panel", async () => {
    mockStartup([]);
    mockInvoke
      .mockRejectedValueOnce(profileError("DIAGNOSTIC_FAILURE", "Diagnostic failure requested.", "sidecar-detail-ref"))
      .mockResolvedValueOnce(
        diagnosticLookupResult("sidecar-detail-ref", {
          entries: [
            diagnosticEntry("sidecar-detail-ref", {
              errorCode: "DIAGNOSTIC_FAILURE",
              method: "diagnostics.fail",
            }),
          ],
        }),
      );

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    fireEvent.click(screen.getByRole("button", { name: /diagnostic error/i }));

    const systemStatus = await screen.findByLabelText(/compact sidecar system status/i);
    expect(systemStatus).toHaveTextContent(/recoverable sidecar error/i);
    expect(systemStatus).toHaveTextContent(/DIAGNOSTIC_FAILURE/i);
    expect(systemStatus).toHaveTextContent(/sidecar-detail-ref/i);
    expect(mockInvoke).toHaveBeenLastCalledWith("sidecar_diagnostic_failure");

    fireEvent.click(within(systemStatus).getByRole("button", { name: /lookup diagnostics for sidecar-detail-ref/i }));

    const lookupPanel = await screen.findByLabelText(/diagnostic lookup/i);
    expect(lookupPanel).toHaveTextContent(/DIAGNOSTIC_FAILURE/i);
    expect(lookupPanel).toHaveTextContent(/diagnostics\.fail/i);
    expect(mockInvoke).toHaveBeenLastCalledWith("diagnostics_lookup", { detailRef: "sidecar-detail-ref" });
  });
});
