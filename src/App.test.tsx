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

function mockStartup(profiles: unknown[] = []) {
  mockInvoke.mockResolvedValueOnce(healthEnvelope()).mockResolvedValueOnce(profileEnvelope(profileResult(profiles)));
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

describe("ThePrivator profile library UI", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("starts health and profile list without a startup waterfall and renders the empty-state CTA", async () => {
    const health = deferred<unknown>();
    const profiles = deferred<unknown>();
    mockInvoke.mockImplementation(((command: string) => {
      if (command === "sidecar_health") {
        return health.promise;
      }
      if (command === "profiles_list") {
        return profiles.promise;
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    }) as typeof invoke);

    render(<App />);

    expect(screen.getByRole("heading", { name: /persistent profile library/i })).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "sidecar_health");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "profiles_list");
    expect(screen.getByLabelText(/current profile phase/i)).toHaveTextContent(/loading/i);
    expect(screen.getByRole("button", { name: /refreshing profiles/i })).toBeDisabled();

    await act(async () => {
      health.resolve(healthEnvelope());
      profiles.resolve(profileEnvelope(profileResult([])));
      await Promise.all([health.promise, profiles.promise]);
    });

    expect(await screen.findByLabelText(/empty profile library/i)).toHaveTextContent(/Create the first profile/i);
    expect(screen.getByLabelText(/current profile phase/i)).toHaveTextContent(/ready/i);
    expect(screen.getByLabelText(/current profile phase/i)).toHaveTextContent(/0 stored profiles/i);
    expect(screen.getByLabelText(/compact sidecar system status/i)).toHaveTextContent(/ThePrivator 2\.1\.0/i);
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
    expect(card).toHaveTextContent(/not persisted running truth/i);
    expect(screen.getByLabelText(/profile observability/i)).toHaveTextContent(/Current count1/i);
    expect(screen.getByLabelText(/profile observability/i)).toHaveTextContent(/List requestbridge-profiles-1/i);
  });

  it("renders startup profile load failures as actionable recovery without claiming an empty store", async () => {
    mockInvoke
      .mockResolvedValueOnce(healthEnvelope())
      .mockRejectedValueOnce(profileError("SIDECAR_UNAVAILABLE", "The profile bridge is unavailable.", "startup-detail"));

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

    expect(mockInvoke).toHaveBeenCalledTimes(2);
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
