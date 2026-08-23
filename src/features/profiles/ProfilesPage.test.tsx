import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ProfilesPage } from "./ProfilesPage";
import { useProfileData } from "./useProfileData";

// Only the Tauri bridge is mocked. client.ts -- and with it every strict-key
// check and redaction rule the responses pass through -- runs for real, which is
// the point: mocking the client would test this page against a fiction.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("../../sidecarEvents", () => ({
  subscribeToProfilesChanged: () => () => {},
  subscribeToChromiumStatusChanged: () => () => {},
  PROFILES_CHANGED_EVENT: "theprivator://profiles-changed",
  CHROMIUM_STATUS_CHANGED_EVENT: "theprivator://chromium-status-changed",
}));

/**
 * The page takes its data from the composition root now, so the tests mount it
 * through a host that runs the same loader the app does. Nothing below the
 * bridge is faked -- client.ts still parses every response.
 */
function PageHost(props: Omit<Parameters<typeof ProfilesPage>[0], "data"> & { includeTrash: boolean }) {
  const { includeTrash, ...rest } = props;
  const data = useProfileData(includeTrash);
  return <ProfilesPage {...rest} data={data} />;
}

const mockInvoke = vi.mocked(invoke);

const ALPHA = "11111111-1111-1111-1111-111111111111";
const BETA = "22222222-2222-2222-2222-222222222222";

function identity() {
  return {
    identityVersion: 2,
    label: "Real device",
    presetId: null,
    browser: { mode: "real" },
    navigator: { mode: "real" },
    screen: { mode: "real" },
    locale: { mode: "real" },
    canvas: { mode: "real" },
    audio: { mode: "real" },
    webgl: { mode: "real" },
    webrtc: { mode: "real", policy: "real" },
    geolocation: { mode: "real", permission: "prompt" },
    mediaDevices: { mode: "real" },
    ports: { mode: "real" },
  };
}

function record(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    createdAt: "2026-05-04T18:00:00.000Z",
    updatedAt: "2026-05-04T18:01:00.000Z",
    defaults: { browser: "chromium", startUrl: "about:blank", proxyMode: "direct", fingerprintMode: "disabled" },
    storage: {
      profileDir: `profile-store/profiles/${id}`,
      userDataDir: `profile-store/profiles/${id}/user-data`,
    },
    identity: identity(),
    proxy: { proxyVersion: 1, mode: "direct", credentialState: "none", summary: "Direct connection" },
    organization: { folderId: null, tags: [], notes: "", favorite: false, color: null },
    launch: { startupBehavior: "customUrls", startUrls: [], args: [] },
    lifecycle: { deletedAt: null, lastLaunchedAt: null, launchCount: 0 },
    sync: {
      revision: 1,
      updatedBy: "device-a",
      originDeviceId: "device-a",
      lastSyncedAt: null,
      lastSyncedRevision: null,
    },
    ...overrides,
  };
}

/** The shape the bridge actually rejects with; anything looser is a fiction. */
function bridgeError(code: string, message: string) {
  return { code, message, recoverable: true, detailRef: "diag-1" };
}

function envelope(result: unknown) {
  return { requestId: "bridge-1", protocolVersion: "1.0.0", durationMs: 1, result };
}

function listResult(profiles: unknown[]) {
  return envelope({ storeVersion: 4, profiles, count: profiles.length });
}

function statusResult(runningIds: string[]) {
  return envelope({
    runningCount: runningIds.length,
    profiles: runningIds.map((profileId) => ({
      profileId,
      status: "running",
      pid: 4242,
      startedAt: "2026-05-04T18:05:00.000Z",
      userDataDir: `profile-store/profiles/${profileId}/user-data`,
    })),
    reconciled: [],
  });
}

/** Answer whichever command is asked for, so ordering never decides the test. */
function respond(handlers: Partial<Record<string, () => unknown>>) {
  mockInvoke.mockImplementation((command: string) => {
    const handler = handlers[command];
    if (handler === undefined) {
      return Promise.reject(new Error(`unexpected command: ${command}`));
    }
    return Promise.resolve(handler()) as ReturnType<typeof invoke>;
  });
}

function renderPage(overrides: Partial<Parameters<typeof ProfilesPage>[0]> = {}) {
  const onOpenProfile = vi.fn();
  const onNewProfile = vi.fn();
  const props = {
    view: "all" as const,
    folderId: null,
    search: "",
    folderNames: new Map<string, string>(),
    onOpenProfile,
    onNewProfile,
    ...overrides,
  };
  return {
    onOpenProfile,
    onNewProfile,
    ...render(<PageHost {...props} includeTrash={props.view === "trash"} />),
  };
}

beforeEach(() => {
  mockInvoke.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProfilesPage", () => {
  it("loads profiles and their run state into the table", async () => {
    respond({
      profiles_list: () => listResult([record(ALPHA, "Alpha"), record(BETA, "Beta")]),
      chromium_status: () => statusResult([BETA]),
    });

    renderPage();

    expect(await screen.findByRole("row", { name: /alpha/i })).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /beta/i })).getByRole("img", { name: "Running" })).toBeInTheDocument();
    expect(screen.getByText("2 profiles")).toBeInTheDocument();
  });

  it("reports a load failure instead of showing an empty table", async () => {
    // An empty table after a failed read is indistinguishable from "you have no
    // profiles", which is a very bad thing to tell someone by mistake.
    respond({
      profiles_list: () => Promise.reject(bridgeError("SIDECAR_TIMEOUT", "The sidecar timed out.")),
      chromium_status: () => statusResult([]),
    });

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(/timed out/i);
  });

  it("narrows the table with the search text handed down from the shell", async () => {
    respond({
      profiles_list: () => listResult([record(ALPHA, "Banking"), record(BETA, "Shopping")]),
      chromium_status: () => statusResult([]),
    });

    renderPage({ search: "bank" });

    expect(await screen.findByRole("row", { name: /banking/i })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /shopping/i })).not.toBeInTheDocument();
  });

  it("launches a profile and marks only that row as busy", async () => {
    let releaseLaunch: (value: unknown) => void = () => {};
    respond({
      profiles_list: () => listResult([record(ALPHA, "Alpha"), record(BETA, "Beta")]),
      chromium_status: () => statusResult([]),
      chromium_launch: () => new Promise((resolve) => (releaseLaunch = resolve)),
    });

    renderPage();
    await screen.findByRole("row", { name: /alpha/i });

    fireEvent.click(within(screen.getByRole("row", { name: /alpha/i })).getByRole("button", { name: "Launch" }));

    await waitFor(() =>
      expect(within(screen.getByRole("row", { name: /alpha/i })).getByRole("img", { name: "Working" })).toBeInTheDocument(),
    );
    // The old UI held one global busy flag, so launching one profile froze every
    // other row -- and that does not survive bulk actions at all.
    expect(within(screen.getByRole("row", { name: /beta/i })).getByRole("button", { name: "Launch" })).toBeEnabled();

    releaseLaunch(
      envelope({
        profileId: ALPHA,
        status: "running",
        pid: 1,
        startedAt: "2026-05-04T18:05:00.000Z",
        userDataDir: `profile-store/profiles/${ALPHA}/user-data`,
        runningCount: 1,
      }),
    );
  });

  it("shows a failed launch instead of silently doing nothing", async () => {
    respond({
      profiles_list: () => listResult([record(ALPHA, "Alpha")]),
      chromium_status: () => statusResult([]),
      chromium_launch: () => Promise.reject(bridgeError("CHROMIUM_LAUNCH_FAILED", "Chromium did not start.")),
    });

    renderPage();
    await screen.findByRole("row", { name: /alpha/i });

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/did not start/i);
  });

  it("asks before moving a profile to the trash, and the prompt stays up to be read", async () => {
    // The previous confirmation was owned by the menu, so closing the menu took
    // the prompt down with it before anyone could read it.
    respond({
      profiles_list: () => listResult([record(ALPHA, "Alpha")]),
      chromium_status: () => statusResult([]),
      profiles_delete: () => listResult([]),
    });

    renderPage();
    const row = await screen.findByRole("row", { name: /alpha/i });

    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to trash" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Move to trash" });
    expect(within(dialog).getByText(/"Alpha" will move to the trash/)).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("profiles_delete", { id: ALPHA }));
  });

  it("deletes nothing when the confirmation is dismissed", async () => {
    respond({
      profiles_list: () => listResult([record(ALPHA, "Alpha")]),
      chromium_status: () => statusResult([]),
      profiles_delete: () => listResult([]),
    });

    renderPage();
    fireEvent.contextMenu(await screen.findByRole("row", { name: /alpha/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to trash" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    expect(mockInvoke).not.toHaveBeenCalledWith("profiles_delete", expect.anything());
  });

  it("refuses to delete a running profile, and says why", async () => {
    respond({
      profiles_list: () => listResult([record(ALPHA, "Alpha")]),
      chromium_status: () => statusResult([ALPHA]),
    });

    renderPage();
    fireEvent.contextMenu(await screen.findByRole("row", { name: /alpha/i }));

    const entry = screen.getByRole("menuitem", { name: "Move to trash" });
    expect(entry).toBeDisabled();
    expect(entry).toHaveAttribute("title", "Stop the profile first");
  });

  it("opens a profile from the row menu", async () => {
    respond({
      profiles_list: () => listResult([record(ALPHA, "Alpha")]),
      chromium_status: () => statusResult([]),
    });

    const { onOpenProfile } = renderPage();
    fireEvent.contextMenu(await screen.findByRole("row", { name: /alpha/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit profile" }));

    expect(onOpenProfile).toHaveBeenCalledWith(ALPHA);
  });

  it("closes the row menu on Escape without acting", async () => {
    respond({
      profiles_list: () => listResult([record(ALPHA, "Alpha")]),
      chromium_status: () => statusResult([]),
    });

    renderPage();
    fireEvent.contextMenu(await screen.findByRole("row", { name: /alpha/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("offers bulk actions once more than one row is selected", async () => {
    respond({
      profiles_list: () => listResult([record(ALPHA, "Alpha"), record(BETA, "Beta")]),
      chromium_status: () => statusResult([]),
      chromium_bulk_launch: () => envelope({ launched: [], failed: [], runningCount: 0 }),
    });

    renderPage();
    await screen.findByRole("row", { name: /alpha/i });

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Beta" }));

    const bar = await screen.findByRole("region", { name: "Bulk actions" });
    expect(within(bar).getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(within(bar).getByRole("button", { name: "Launch 2 profiles" }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("chromium_bulk_launch", { profileIds: [ALPHA, BETA] }),
    );
  });

  it("keeps a bulk delete behind the same confirmation as a single one", async () => {
    respond({
      profiles_list: () => listResult([record(ALPHA, "Alpha"), record(BETA, "Beta")]),
      chromium_status: () => statusResult([]),
      profiles_delete: () => listResult([]),
    });

    renderPage();
    await screen.findByRole("row", { name: /alpha/i });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Beta" }));

    fireEvent.click(screen.getByRole("button", { name: "Move 2 profiles to trash" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/2 profiles will move to the trash/)).toBeInTheDocument();
  });

  it("drops a selected row from the selection once it leaves the table", async () => {
    // Otherwise a bulk action reaches a profile the user filtered away and can
    // no longer see -- the ghost rows the previous UI left behind.
    respond({
      profiles_list: () => listResult([record(ALPHA, "Alpha"), record(BETA, "Beta")]),
      chromium_status: () => statusResult([]),
    });

    const { rerender, onOpenProfile, onNewProfile } = renderPage();
    await screen.findByRole("row", { name: /alpha/i });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Beta" }));
    expect(await screen.findByRole("region", { name: "Bulk actions" })).toBeInTheDocument();

    rerender(
      <PageHost
        view="all"
        folderId={null}
        search="alpha"
        folderNames={new Map()}
        includeTrash={false}
        onOpenProfile={onOpenProfile}
        onNewProfile={onNewProfile}
      />,
    );

    await waitFor(() => expect(screen.queryByRole("region", { name: "Bulk actions" })).not.toBeInTheDocument());
  });

  it("shows the trash from its own command, with restore rather than launch", async () => {
    respond({
      profiles_list: () => listResult([]),
      chromium_status: () => statusResult([]),
      profiles_trash_list: () =>
        envelope({
          storeVersion: 4,
          profiles: [
            record(ALPHA, "Deleted", {
              lifecycle: { deletedAt: "2026-05-04T19:00:00.000Z", lastLaunchedAt: null, launchCount: 0 },
            }),
          ],
          count: 1,
        }),
    });

    renderPage({ view: "trash" });

    fireEvent.contextMenu(await screen.findByRole("row", { name: /deleted/i }));

    expect(screen.getByRole("menuitem", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Launch" })).not.toBeInTheDocument();
  });

  it("warns that a permanent delete cannot be undone", async () => {
    respond({
      profiles_list: () => listResult([]),
      chromium_status: () => statusResult([]),
      profiles_trash_list: () =>
        envelope({
          storeVersion: 4,
          profiles: [
            record(ALPHA, "Deleted", {
              lifecycle: { deletedAt: "2026-05-04T19:00:00.000Z", lastLaunchedAt: null, launchCount: 0 },
            }),
          ],
          count: 1,
        }),
    });

    renderPage({ view: "trash" });
    fireEvent.contextMenu(await screen.findByRole("row", { name: /deleted/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete permanently" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Delete permanently" });
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it("says the table is empty for the reason the current view is empty", async () => {
    respond({ profiles_list: () => listResult([]), chromium_status: () => statusResult([]) });

    renderPage({ view: "favorites" });

    expect(await screen.findByText(/star a profile/i)).toBeInTheDocument();
  });

  it("applies a column change from the picker", async () => {
    respond({
      profiles_list: () => listResult([record(ALPHA, "Alpha")]),
      chromium_status: () => statusResult([]),
    });

    renderPage();
    await screen.findByRole("row", { name: /alpha/i });
    expect(screen.getByRole("columnheader", { name: /tags/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("checkbox", { name: "Tags" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("columnheader", { name: /tags/i })).not.toBeInTheDocument();
  });

  it("hands the new-profile request up rather than opening its own form", async () => {
    respond({ profiles_list: () => listResult([]), chromium_status: () => statusResult([]) });

    const { onNewProfile } = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New profile" }));

    expect(onNewProfile).toHaveBeenCalledTimes(1);
  });
});
