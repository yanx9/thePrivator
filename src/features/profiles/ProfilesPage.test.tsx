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

const dialogs = vi.hoisted(() => ({ pickFile: vi.fn(), pickSaveTarget: vi.fn() }));
vi.mock("../../dialogs", () => dialogs);
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

it("duplicates a stopped profile through the sidecar and shows the new row", async () => {
  const source = record(ALPHA, "Alpha");
  const clone = record(BETA, "Alpha copy");
  let profiles = [source];
  respond({ profiles_list: () => listResult(profiles), chromium_status: () => statusResult([]),
    profiles_duplicate: () => {
      profiles = [source, clone];
      return envelope({ storeVersion: 4, profile: clone, profiles, count: 2 });
    } });
  renderPage();
  fireEvent.contextMenu(await screen.findByText("Alpha"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("profiles_duplicate", { profileId: ALPHA }));
  expect(await screen.findByText("Alpha copy")).toBeInTheDocument();
});

it.each([false, true])("toggles favorites from the menu (currently %s)", async (favorite) => {
  let profile = record(ALPHA, "Alpha");
  profile.organization.favorite = favorite;
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === "profiles_list") return listResult([profile]);
    if (command === "chromium_status") return statusResult([]);
    if (command === "profiles_organization_update") {
      profile = { ...profile, organization: (args as { organization: typeof profile.organization }).organization };
      return envelope({ storeVersion: 4, profile, profiles: [profile], count: 1 });
    }
    throw new Error(`Unexpected ${command}`);
  });
  renderPage();
  fireEvent.contextMenu(await screen.findByText("Alpha"));
  fireEvent.click(screen.getByRole("menuitem", { name: favorite ? "Remove from favorites" : "Add to favorites" }));
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("profiles_organization_update", {
    profileId: ALPHA, organization: { folderId: null, tags: [], notes: "", favorite: !favorite, color: null },
  }));
  await waitFor(() => expect(screen.queryByRole("img", { name: "Favorite" }) !== null).toBe(!favorite));
});

it("edits tags without replacing unrelated organization fields", async () => {
  const profile = record(ALPHA, "Alpha");
  respond({ profiles_list: () => listResult([profile]), chromium_status: () => statusResult([]),
    profiles_organization_update: () => envelope({ storeVersion: 4, profile, profiles: [profile], count: 1 }) });
  renderPage();
  fireEvent.contextMenu(await screen.findByText("Alpha"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit tags…" }));
  const dialog = screen.getByRole("dialog", { name: "Edit tags" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Tags (comma separated)" }), { target: { value: " work, EU, work " } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("profiles_organization_update", {
    profileId: ALPHA, organization: { ...profile.organization, tags: ["work", "EU"] },
  }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it.each([BETA, ""])("moves a profile to folder %s, including no folder", async (folderId) => {
  const profile = record(ALPHA, "Alpha");
  respond({ profiles_list: () => listResult([profile]), chromium_status: () => statusResult([]),
    profiles_organization_update: () => envelope({ storeVersion: 4, profile, profiles: [profile], count: 1 }) });
  renderPage({ folderNames: new Map([[BETA, "Work"]]) });
  fireEvent.contextMenu(await screen.findByText("Alpha"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Move to folder…" }));
  const dialog = screen.getByRole("dialog", { name: "Move to folder" });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Folder" }), { target: { value: folderId } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("profiles_organization_update", {
    profileId: ALPHA, organization: { ...profile.organization, folderId: folderId || null },
  }));
});

it("moves into a new route-safe folder when the library has no folders", async () => {
  const profile = record(ALPHA, "Alpha");
  respond({ profiles_list: () => listResult([profile]), chromium_status: () => statusResult([]),
    profiles_organization_update: () => envelope({ storeVersion: 4, profile, profiles: [profile], count: 1 }) });
  renderPage();
  fireEvent.contextMenu(await screen.findByText("Alpha"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Move to folder…" }));
  const dialog = screen.getByRole("dialog", { name: "Move to folder" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "New folder" }), { target: { value: "Work_2026" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("profiles_organization_update", {
    profileId: ALPHA, organization: { ...profile.organization, folderId: "Work_2026" },
  }));
});

it.each(["Edit tags…", "Move to folder…"])("applies bulk %s to every selected profile", async (action) => {
  const profiles = [record(ALPHA, "Alpha"), record(BETA, "Beta")];
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === "profiles_list") return listResult(profiles);
    if (command === "chromium_status") return statusResult([]);
    if (command === "profiles_organization_update") {
      const id = (args as { profileId: string }).profileId;
      const profile = profiles.find((item) => item.id === id);
      return envelope({ storeVersion: 4, profile, profiles, count: 2 });
    }
    throw new Error(`Unexpected ${command}`);
  });
  renderPage();
  await screen.findByText("Alpha");
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all profiles" }));
  fireEvent.click(within(screen.getByRole("region", { name: "Bulk actions" })).getByRole("button", { name: action }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox", { name: action === "Edit tags…" ? "Tags (comma separated)" : "New folder" }), { target: { value: "Work" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  for (const profile of profiles) {
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("profiles_organization_update", {
      profileId: profile.id, organization: { ...profile.organization, ...(action === "Edit tags…" ? { tags: ["Work"] } : { folderId: "Work" }) },
    }));
  }
});

it("retains failed notes for retry and cancels without saving", async () => {
  const profile = record(ALPHA, "Alpha");
  respond({ profiles_list: () => listResult([profile]), chromium_status: () => statusResult([]),
    profiles_organization_update: () => Promise.reject(bridgeError("STORE_WRITE_FAILED", "Could not save notes.")) });
  renderPage();
  const notes = await screen.findByRole("textbox", { name: "Notes for Alpha" });
  fireEvent.change(notes, { target: { value: "Unsaved draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save notes for Alpha" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save notes.");
  expect(notes).toHaveValue("Unsaved draft");
  fireEvent.click(screen.getByRole("button", { name: "Cancel notes for Alpha" }));
  expect(notes).toHaveValue("");
  expect(mockInvoke.mock.calls.filter(([command]) => command === "profiles_organization_update")).toHaveLength(1);
});

it("keeps rejected tag edits visible for correction", async () => {
  respond({ profiles_list: () => listResult([record(ALPHA, "Alpha")]), chromium_status: () => statusResult([]),
    profiles_organization_update: () => Promise.reject(bridgeError("STORE_WRITE_FAILED", "Could not save tags.")) });
  renderPage();
  fireEvent.contextMenu(await screen.findByText("Alpha"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit tags…" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "work" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Could not save tags.");
  expect(within(dialog).getByRole("textbox")).toHaveValue("work");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("saves notes directly in the default main table without opening the editor", async () => {
  let profile = record(ALPHA, "Alpha");
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === "profiles_list") return listResult([profile]);
    if (command === "chromium_status") return statusResult([]);
    if (command === "profiles_organization_update") {
      profile = { ...profile, organization: (args as { organization: typeof profile.organization }).organization };
      return envelope({ storeVersion: 4, profile, profiles: [profile], count: 1 });
    }
    throw new Error(`Unexpected ${command}`);
  });
  const { onOpenProfile } = renderPage();
  const notes = await screen.findByRole("textbox", { name: "Notes for Alpha" });
  fireEvent.doubleClick(notes);
  fireEvent.change(notes, { target: { value: "Keep this\n<script>as text</script>" } });
  fireEvent.click(screen.getByRole("button", { name: "Save notes for Alpha" }));
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("profiles_organization_update", {
    profileId: ALPHA, organization: { ...profile.organization, notes: "Keep this\n<script>as text</script>" },
  }));
  expect(onOpenProfile).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save notes for Alpha" })).not.toBeInTheDocument());
  expect(notes).toHaveValue("Keep this\n<script>as text</script>");
});

it("exports cookies to the chosen file and reports skipped cookies", async () => {
  dialogs.pickSaveTarget.mockResolvedValue("/tmp/cookies.json");
  respond({ profiles_list: () => listResult([record(ALPHA, "Alpha")]), chromium_status: () => statusResult([]),
    profile_cookies_export: () => envelope({ portabilityVersion: 1, profileId: ALPHA, operation: "export", format: "theprivator-json", exportedCount: 3, skippedCount: 1, warningCount: 0, warnings: [] }) });
  renderPage();
  fireEvent.contextMenu(await screen.findByText("Alpha"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Cookies" }));
  expect(screen.queryByRole("menuitem", { name: "Export (cookies.txt)…" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "Export (JSON)…" }));
  expect(await screen.findByText("Exported 3 cookies. 1 skipped.")).toBeInTheDocument();
  expect(mockInvoke).toHaveBeenCalledWith("profile_cookies_export", { profileId: ALPHA, destinationPath: "/tmp/cookies.json", format: "theprivator-json" });
});
it("disables cookie portability for running profiles", async () => {
  respond({ profiles_list: () => listResult([record(ALPHA, "Alpha")]), chromium_status: () => statusResult([ALPHA]) });
  renderPage();
  fireEvent.contextMenu(await screen.findByText("Alpha"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Cookies" }));
  for (const name of ["Export (JSON)…", "Import…"]) {
    expect(screen.getByRole("menuitem", { name })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name })).toHaveAttribute("title", "Stop the profile first");
  }
});
it("cancelling the cookie save picker makes no export call", async () => {
  dialogs.pickSaveTarget.mockResolvedValue(null);
  respond({ profiles_list: () => listResult([record(ALPHA, "Alpha")]), chromium_status: () => statusResult([]) });
  renderPage();
  fireEvent.contextMenu(await screen.findByText("Alpha"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Cookies" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Export (JSON)…" }));
  await waitFor(() => expect(dialogs.pickSaveTarget).toHaveBeenCalled());
  expect(mockInvoke.mock.calls.some(([command]) => command === "profile_cookies_export")).toBe(false);
});

it("opens the cookie bot dialog for the context profile", async () => {
  respond({ profiles_list: () => listResult([record(ALPHA, "Alpha")]), chromium_status: () => statusResult([]) });
  renderPage();
  fireEvent.contextMenu(await screen.findByText("Alpha"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Run Cookie Bot…" }));
  expect(await screen.findByRole("dialog", { name: "Run Cookie Bot — Alpha" })).toBeInTheDocument();
});

it("requires confirmation before picking an import file and reports the import", async () => {
  dialogs.pickFile.mockResolvedValue("/tmp/cookies.json");
  respond({ profiles_list: () => listResult([record(ALPHA, "Alpha")]), chromium_status: () => statusResult([]),
    profile_cookies_replace: () => envelope({ portabilityVersion: 1, profileId: ALPHA, operation: "replace", format: "theprivator-json", importedCount: 2, replacedCount: 1, skippedCount: 0, warningCount: 0, warnings: [] }) });
  renderPage();
  fireEvent.contextMenu(await screen.findByText("Alpha"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Cookies" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Import…" }));
  expect(dialogs.pickFile).not.toHaveBeenCalled();
  const confirmation = screen.getByRole("alertdialog", { name: "Import cookies" });
  expect(confirmation).toHaveTextContent(/replaces/i);
  fireEvent.click(within(confirmation).getByRole("button", { name: "Replace cookies" }));
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("profile_cookies_replace", { profileId: ALPHA, sourcePath: "/tmp/cookies.json" }));
  expect(await screen.findByText(/Imported 2 cookies/)).toBeInTheDocument();
});

beforeEach(() => {
  mockInvoke.mockReset();
  dialogs.pickFile.mockReset();
  dialogs.pickSaveTarget.mockReset();
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
