// @ts-expect-error Vite raw import keeps the source guard browser-build compatible without Node fs types.
import appSourceText from "./App.tsx?raw";
import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

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
  };

  return {
    ...base,
    ...overrides,
    storage: overrides.storage ?? base.storage,
  };
}

function profileResult(profiles: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    storeVersion: 1,
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

  it("does not add direct browser or Tauri filesystem bypasses for legacy import", () => {
    const source = appSource();

    expect(source).toContain("scanLegacyProfiles");
    expect(source).toContain("importLegacyProfiles");
    expect(source).not.toMatch(/@tauri-apps\/plugin-(dialog|fs)/);
    expect(source).not.toMatch(/showOpenFilePicker|webkitdirectory|readTextFile|writeTextFile|localStorage/);
    expect(source).not.toMatch(/type=\"file\"|type='file'/);
  });

  it("keeps the S01 diagnostic recovery pattern in the compact system panel", async () => {
    mockStartup([]);
    mockInvoke.mockRejectedValueOnce(profileError("DIAGNOSTIC_FAILURE", "Diagnostic failure requested.", "sidecar-detail-ref"));

    render(<App />);

    await screen.findByLabelText(/empty profile library/i);
    fireEvent.click(screen.getByRole("button", { name: /diagnostic error/i }));

    const systemStatus = await screen.findByLabelText(/compact sidecar system status/i);
    expect(systemStatus).toHaveTextContent(/recoverable sidecar error/i);
    expect(systemStatus).toHaveTextContent(/DIAGNOSTIC_FAILURE/i);
    expect(systemStatus).toHaveTextContent(/sidecar-detail-ref/i);
    expect(mockInvoke).toHaveBeenLastCalledWith("sidecar_diagnostic_failure");
  });
});
