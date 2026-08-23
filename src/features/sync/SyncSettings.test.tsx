import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { SyncSettings } from "./SyncSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const pickDirectory = vi.hoisted(() => vi.fn());
vi.mock("../../dialogs", () => ({ pickDirectory }));

const mockInvoke = vi.mocked(invoke);

const PROFILE = "11111111-1111-1111-1111-111111111111";

function envelope(result: unknown) {
  return { requestId: "bridge-1", protocolVersion: "1.0.0", durationMs: 1, result };
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    configured: false,
    folderName: null,
    deviceLabel: "This device",
    lastRunAt: null,
    trackedProfiles: 0,
    reachable: false,
    writable: false,
    detail: "Profile synchronisation is not set up on this device yet.",
    ...overrides,
  };
}

function enabledStatus(overrides: Record<string, unknown> = {}) {
  return status({
    enabled: true,
    configured: true,
    folderName: "ThePrivator",
    deviceLabel: "Laptop A",
    reachable: true,
    writable: true,
    detail: "The sync folder is readable and writable.",
    ...overrides,
  });
}

function counts(overrides: Record<string, number> = {}) {
  return { nothing: 0, push: 0, pull: 0, conflict: 0, deleteLocal: 0, deleteRemote: 0, ...overrides };
}

function conflictEntry(overrides: Record<string, unknown> = {}) {
  return {
    profileId: PROFILE,
    name: "Banking",
    action: "conflict",
    reason: "Both sides changed the profile since the last sync.",
    localRevision: 5,
    remoteRevision: 6,
    baseRevision: 4,
    ...overrides,
  };
}

function respond(handlers: Record<string, () => unknown>) {
  mockInvoke.mockImplementation((command: string) => {
    const handler = handlers[command];
    if (handler === undefined) {
      return Promise.reject(new Error(`unexpected command: ${command}`));
    }
    return Promise.resolve(handler()) as ReturnType<typeof invoke>;
  });
}

beforeEach(() => {
  mockInvoke.mockReset();
  pickDirectory.mockReset();
});

describe("SyncSettings", () => {
  it("names itself before the status has arrived", async () => {
    // A page showing nothing but "Loading" tells the user less than one that
    // says what it is.
    respond({ sync_status: () => new Promise(() => {}) });

    render(<SyncSettings />);

    expect(screen.getByRole("heading", { name: /profile synchronization/i })).toBeInTheDocument();
  });

  it("says the profiles travel through the user's own folder", async () => {
    // Never "cloud": in this product that word suggests we receive the profiles.
    respond({ sync_status: () => envelope(status()) });

    render(<SyncSettings />);

    const lede = await screen.findByText(/nothing is sent to us/i);
    expect(lede).toBeInTheDocument();
    expect(document.body.textContent?.toLowerCase()).not.toContain("cloud");
  });

  it("shows the off state without inventing a folder", async () => {
    respond({ sync_status: () => envelope(status()) });

    render(<SyncSettings />);

    expect(await screen.findByText("This device only")).toBeInTheDocument();
    expect(screen.getByText("Not chosen yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /synchronize$/i })).not.toBeInTheDocument();
  });

  it("shows the folder by name once it is chosen", async () => {
    respond({ sync_status: () => envelope(enabledStatus({ trackedProfiles: 4 })) });

    render(<SyncSettings />);

    expect(await screen.findByText("Synchronized")).toBeInTheDocument();
    expect(screen.getByText("ThePrivator")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("configures sync from the folder the user picked", async () => {
    pickDirectory.mockResolvedValue("/home/someone/Drive/ThePrivator");
    respond({
      sync_status: () => envelope(status()),
      sync_configure: () => envelope(enabledStatus()),
    });

    render(<SyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose a folder" }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("sync_configure", {
        enabled: true,
        folder: "/home/someone/Drive/ThePrivator",
        deviceLabel: "This device",
      }),
    );
  });

  it("does nothing when the folder picker is cancelled", async () => {
    pickDirectory.mockResolvedValue(null);
    respond({ sync_status: () => envelope(status()) });

    render(<SyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose a folder" }));

    await waitFor(() => expect(pickDirectory).toHaveBeenCalled());
    expect(mockInvoke).not.toHaveBeenCalledWith("sync_configure", expect.anything());
  });

  it("never puts the chosen path on screen", async () => {
    // The redaction perimeter treats an absolute path in the UI as a leak, and
    // the user already knows which folder they just picked.
    pickDirectory.mockResolvedValue("/home/someone/Drive/ThePrivator");
    respond({
      sync_status: () => envelope(status()),
      sync_configure: () => envelope(enabledStatus()),
    });

    render(<SyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose a folder" }));

    await screen.findByText("Synchronized");
    expect(document.body.textContent).not.toContain("/home/someone");
  });

  it("turns sync off without sending a folder", async () => {
    respond({
      sync_status: () => envelope(enabledStatus()),
      sync_configure: () => envelope(status()),
    });

    render(<SyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /turn synchronization off/i }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("sync_configure", {
        enabled: false,
        folder: null,
        deviceLabel: null,
      }),
    );
  });

  it("explains that the device name is not the computer's name", async () => {
    respond({ sync_status: () => envelope(enabledStatus()) });

    render(<SyncSettings />);

    expect(await screen.findByLabelText(/device name/i)).toHaveValue("Laptop A");
    expect(screen.getByText(/not your computer's name/i)).toBeInTheDocument();
  });

  it("checks for changes without applying them", async () => {
    respond({
      sync_status: () => envelope(enabledStatus()),
      sync_plan: () => envelope({ plans: [conflictEntry({ action: "push" })], counts: counts({ push: 1 }) }),
    });

    render(<SyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /check for changes/i }));

    const pending = await screen.findByRole("list", { name: /pending changes/i });
    expect(within(pending).getByText("Banking")).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("sync_run");
  });

  it("says so when a check finds nothing to do", async () => {
    respond({
      sync_status: () => envelope(enabledStatus()),
      sync_plan: () => envelope({ plans: [], counts: counts() }),
    });

    render(<SyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /check for changes/i }));

    expect(await screen.findByText(/already up to date/i)).toBeInTheDocument();
  });

  it("reports what a run changed", async () => {
    respond({
      sync_status: () => envelope(enabledStatus()),
      sync_run: () =>
        envelope({
          applied: [{ profileId: PROFILE, name: "Banking", action: "uploaded", keptCopyAs: null }],
          conflicts: [],
          failures: [],
          status: enabledStatus({ trackedProfiles: 1 }),
        }),
    });

    render(<SyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /^synchronize$/i }));

    expect(await screen.findByText(/1 profile updated/i)).toBeInTheDocument();
  });

  it("says where replaced browsing data went, and that nothing was deleted", async () => {
    respond({
      sync_status: () => envelope(enabledStatus()),
      sync_run: () =>
        envelope({
          applied: [{ profileId: PROFILE, name: "Banking", action: "updated", keptCopyAs: "abc-20260504" }],
          conflicts: [],
          failures: [],
          status: enabledStatus(),
        }),
    });

    render(<SyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /^synchronize$/i }));

    expect(await screen.findByText(/nothing was deleted/i)).toBeInTheDocument();
  });

  it("turns a failure code into something worth reading", async () => {
    respond({
      sync_status: () => envelope(enabledStatus()),
      sync_run: () =>
        envelope({
          applied: [],
          conflicts: [],
          failures: [{ profileId: PROFILE, name: "Banking", code: "SYNC_PROFILE_BUSY" }],
          status: enabledStatus(),
        }),
    });

    render(<SyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /^synchronize$/i }));

    expect(await screen.findByText(/stop this profile's browser/i)).toBeInTheDocument();
    expect(screen.queryByText("SYNC_PROFILE_BUSY")).not.toBeInTheDocument();
  });

  it("offers all three resolutions for a conflict and picks none by itself", async () => {
    respond({
      sync_status: () => envelope(enabledStatus()),
      sync_run: () =>
        envelope({
          applied: [],
          conflicts: [conflictEntry()],
          failures: [],
          status: enabledStatus(),
        }),
    });

    render(<SyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /^synchronize$/i }));

    await screen.findByRole("heading", { name: /needs your decision/i });
    expect(screen.getByRole("button", { name: /keep this device's/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /keep the other device's/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /keep both/i })).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("sync_resolve", expect.anything());
  });

  it("promises that a resolution moves data aside rather than deleting it", async () => {
    respond({
      sync_status: () => envelope(enabledStatus()),
      sync_run: () =>
        envelope({ applied: [], conflicts: [conflictEntry()], failures: [], status: enabledStatus() }),
    });

    render(<SyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /^synchronize$/i }));

    expect(await screen.findByText(/moved aside rather than deleted/i)).toBeInTheDocument();
  });

  it("sends the chosen resolution and reruns", async () => {
    let runs = 0;
    respond({
      sync_status: () => envelope(enabledStatus()),
      sync_run: () => {
        runs += 1;
        return envelope({
          applied: [],
          conflicts: runs === 1 ? [conflictEntry()] : [],
          failures: [],
          status: enabledStatus(),
        });
      },
      sync_resolve: () =>
        envelope({
          resolved: { profileId: PROFILE, name: "Banking", action: "updated", keptCopyAs: "abc-2026" },
          resolution: "keepRemote",
        }),
    });

    render(<SyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /^synchronize$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /keep the other device's/i }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("sync_resolve", {
        profileId: PROFILE,
        resolution: "keepRemote",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: /needs your decision/i })).not.toBeInTheDocument(),
    );
  });

  it("reports a folder that has become unwritable", async () => {
    respond({
      sync_status: () =>
        envelope(
          enabledStatus({ writable: false, detail: "The sync folder is not writable: Permission denied." }),
        ),
    });

    render(<SyncSettings />);

    expect(await screen.findByRole("status")).toHaveTextContent(/not writable/i);
  });

  it("shows a failure to read the status instead of an empty page", async () => {
    respond({
      sync_status: () =>
        Promise.reject({
          code: "SIDECAR_TIMEOUT",
          message: "The sidecar timed out.",
          recoverable: true,
          detailRef: "diag-1",
        }),
    });

    render(<SyncSettings />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/timed out/i);
  });
});
