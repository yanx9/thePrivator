import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ProfileEditor } from "./ProfileEditor";

// Only the bridge is mocked, so client.ts validates every payload this editor
// sends and every response it reads, exactly as it would in the app.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

const PROFILE_ID = "11111111-1111-1111-1111-111111111111";

function identity(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}) {
  const proxy = overrides.proxy ?? {
    proxyVersion: 1,
    mode: "direct",
    credentialState: "none",
    summary: "Direct connection",
  };
  return {
    id: PROFILE_ID,
    name: "Research",
    createdAt: "2026-05-04T18:00:00.000Z",
    updatedAt: "2026-05-04T18:01:00.000Z",
    defaults: {
      browser: "chromium",
      startUrl: "about:blank",
      proxyMode: (proxy as { mode: string }).mode,
      fingerprintMode: "disabled",
    },
    storage: {
      profileDir: `profile-store/profiles/${PROFILE_ID}`,
      userDataDir: `profile-store/profiles/${PROFILE_ID}/user-data`,
    },
    identity: identity(),
    proxy,
    organization: { folderId: null, tags: ["eu"], notes: "Berlin account", favorite: true, color: null },
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

function envelope(result: unknown) {
  return { requestId: "bridge-1", protocolVersion: "1.0.0", durationMs: 1, result };
}

function mutation(profile: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return envelope({ storeVersion: 4, profiles: [profile], count: 1, profile, ...extra });
}

/** Answer whichever command is asked for, so call ordering never decides a test. */
function respond(handlers: Record<string, () => unknown>) {
  mockInvoke.mockImplementation((command: string) => {
    const handler = handlers[command];
    if (handler === undefined) {
      return Promise.reject(new Error(`unexpected command: ${command}`));
    }
    return Promise.resolve(handler()) as ReturnType<typeof invoke>;
  });
}

function allSaveCommandsSucceed(profile = record()) {
  respond({
    profiles_list: () => envelope({ storeVersion: 4, profiles: [profile], count: 1 }),
    chromium_status: () => envelope({ runningCount: 0, profiles: [], reconciled: [] }),
    profiles_create: () => mutation(profile),
    profiles_update: () => mutation(profile),
    profiles_organization_update: () => mutation(profile),
    profiles_launch_update: () => mutation(profile),
    profiles_proxy_update: () => mutation(profile),
    profiles_identity_update: () => mutation(profile, { warnings: [] }),
  });
}

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("ProfileEditor, editing an existing profile", () => {
  it("loads the stored values into the form", async () => {
    allSaveCommandsSucceed();

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByLabelText("Name")).toHaveValue("Research");
    expect(screen.getByLabelText(/keep in favorites/i)).toBeChecked();
    expect(screen.getByText("eu")).toBeInTheDocument();
    expect(screen.getByLabelText("Notes")).toHaveValue("Berlin account");
  });

  it("says the profile is gone rather than opening a blank form", async () => {
    // A blank form here would silently create a second profile on save.
    respond({ profiles_list: () => envelope({ storeVersion: 4, profiles: [], count: 0 }) });

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer exists/i);
  });

  it("saves each section that changed, and reports the id it saved", async () => {
    allSaveCommandsSucceed();
    const onSaved = vi.fn();

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={onSaved} />);
    await screen.findByLabelText("Name");

    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("tab", { name: /startup/i }));
    fireEvent.change(screen.getByLabelText("Start pages"), { target: { value: "https://example.test/" } });
    fireEvent.click(screen.getByRole("tab", { name: /fingerprint/i }));
    fireEvent.change(screen.getByLabelText("WebRTC mode"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("WebRTC policy"), { target: { value: "block" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(PROFILE_ID));
    for (const command of [
      "profiles_organization_update",
      "profiles_launch_update",
      "profiles_identity_update",
    ]) {
      expect(mockInvoke, command).toHaveBeenCalledWith(command, expect.anything());
    }
  });

  it("writes nothing when the user changed nothing", async () => {
    // Every section write bumps the profile's sync revision, so saving all four
    // on every visit would manufacture conflicts between devices that agree.
    allSaveCommandsSucceed();
    const onSaved = vi.fn();

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={onSaved} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(PROFILE_ID));
    // Reads are fine; the point is that nothing was written.
    const commands = mockInvoke.mock.calls.map(([command]) => command);
    expect(commands.filter((command) => /update|create|delete/.test(command as string))).toEqual([]);
  });

  it("sends the new name when it did change", async () => {
    allSaveCommandsSucceed();

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("profiles_update", { id: PROFILE_ID, name: "Renamed" }),
    );
  });

  it("refuses to save an empty name and says which section to look at", async () => {
    allSaveCommandsSucceed();

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/needs a name/i);
    expect(mockInvoke).not.toHaveBeenCalledWith("profiles_organization_update", expect.anything());
  });

  it("writes nothing at all when one section fails to validate", async () => {
    // Saving section by section and failing halfway would leave a profile with a
    // new proxy and an old fingerprint, and nothing on screen saying so.
    allSaveCommandsSucceed();

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Name");

    fireEvent.click(screen.getByRole("tab", { name: /proxy/i }));
    fireEvent.change(screen.getByLabelText("Proxy mode"), { target: { value: "fixedServer" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: /proxy/i })).toHaveAttribute("aria-selected", "true"));
    expect(mockInvoke).not.toHaveBeenCalledWith("profiles_organization_update", expect.anything());
    expect(mockInvoke).not.toHaveBeenCalledWith("profiles_proxy_update", expect.anything());
  });

  it("switches to the failing section so a blocked save is not silent", async () => {
    allSaveCommandsSucceed();

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Name");

    fireEvent.click(screen.getByRole("tab", { name: /fingerprint/i }));
    fireEvent.change(screen.getByLabelText("Screen mode"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Screen width"), { target: { value: "0" } });

    fireEvent.click(screen.getByRole("tab", { name: /general/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /fingerprint/i })).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("counts the problems on each tab", async () => {
    allSaveCommandsSucceed();

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("tab", { name: /fingerprint/i }));
    fireEvent.change(screen.getByLabelText("Screen mode"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Screen width"), { target: { value: "0" } });

    expect(
      within(screen.getByRole("tab", { name: /fingerprint/i })).getByLabelText(/problems/),
    ).toBeInTheDocument();
  });

  it("reports a save that the sidecar rejected", async () => {
    respond({
      profiles_list: () => envelope({ storeVersion: 4, profiles: [record()], count: 1 }),
      profiles_identity_update: () => mutation(record(), { warnings: [] }),
      profiles_organization_update: () =>
        Promise.reject({
          code: "PROFILE_ORGANIZATION_INVALID",
          message: "A profile can carry at most 10 tags.",
          recoverable: true,
          detailRef: "diag-1",
        }),
    });

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Name");
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/at most 10 tags/i);
  });

  it("adds and removes tags, refusing a duplicate that differs only in case", async () => {
    // The sidecar folds tag case, so accepting "EU" beside "eu" here would show
    // two chips and store one.
    allSaveCommandsSucceed();

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Name");

    fireEvent.change(screen.getByLabelText("Tags"), { target: { value: "EU" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    expect(screen.getAllByText(/^eu$/i)).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Tags"), { target: { value: "banking" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    expect(screen.getByText("banking")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove tag banking" }));
    expect(screen.queryByText("banking")).not.toBeInTheDocument();
  });

  it("does not save the profile when Enter is pressed in the tag box", async () => {
    allSaveCommandsSucceed();

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Name");

    const tagBox = screen.getByLabelText("Tags");
    fireEvent.change(tagBox, { target: { value: "berlin" } });
    fireEvent.keyDown(tagBox, { key: "Enter" });

    expect(screen.getByText("berlin")).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("profiles_organization_update", expect.anything());
  });

  it("sends the edited startup pages, one per line", async () => {
    allSaveCommandsSucceed();

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("tab", { name: /startup/i }));
    fireEvent.change(screen.getByLabelText("Start pages"), {
      target: { value: "https://example.test/\n\n  about:blank  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("profiles_launch_update", {
        profileId: PROFILE_ID,
        launch: {
          startupBehavior: "customUrls",
          startUrls: ["https://example.test/", "about:blank"],
          args: [],
        },
      }),
    );
  });

  it("leaves a saved proxy alone when the edit was somewhere else", async () => {
    // The stored password is never loaded into the form, so the proxy draft
    // cannot be turned back into a payload until the user re-enters it. Writing
    // the section anyway would make renaming such a profile impossible, and
    // sending the blank field would silently drop working authentication.
    const profile = record({
      proxy: {
        proxyVersion: 1,
        mode: "fixedServer",
        protocol: "http",
        host: "10.0.0.9",
        port: 8080,
        credentialState: "configured",
        summary: "http://10.0.0.9:8080",
      },
    });
    allSaveCommandsSucceed(profile);

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("profiles_update", { id: PROFILE_ID, name: "Renamed" }));
    expect(mockInvoke).not.toHaveBeenCalledWith("profiles_proxy_update", expect.anything());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("writes the proxy once the user actually edits it", async () => {
    allSaveCommandsSucceed();

    render(<ProfileEditor profileId={PROFILE_ID} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("tab", { name: /proxy/i }));
    fireEvent.change(screen.getByLabelText("Proxy mode"), { target: { value: "fixedServer" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "10.0.0.9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("profiles_proxy_update", {
        profileId: PROFILE_ID,
        proxy: { proxyVersion: 1, mode: "fixedServer", protocol: "http", host: "10.0.0.9", port: 8080 },
      }),
    );
  });
});

describe("ProfileEditor, creating a profile", () => {
  it("opens an empty form with every surface on the real machine", () => {
    // A masked surface the user never chose is a change they cannot explain later.
    allSaveCommandsSucceed();

    render(<ProfileEditor profileId={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "New profile" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    fireEvent.click(screen.getByRole("tab", { name: /fingerprint/i }));
    expect(screen.getByLabelText("Screen mode")).toHaveValue("real");
  });

  it("creates the profile first, then writes its sections against the new id", async () => {
    allSaveCommandsSucceed();
    const onSaved = vi.fn();

    render(<ProfileEditor profileId={null} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Banking" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(PROFILE_ID));
    expect(mockInvoke).toHaveBeenCalledWith("profiles_create", { name: "Banking" });
    expect(mockInvoke).toHaveBeenCalledWith("profiles_organization_update", {
      profileId: PROFILE_ID,
      organization: { folderId: null, tags: [], notes: "", favorite: false, color: null },
    });
  });

  it("does not reach the sidecar at all without a name", () => {
    allSaveCommandsSucceed();

    render(<ProfileEditor profileId={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("leaves without saving on Cancel", () => {
    allSaveCommandsSucceed();
    const onClose = vi.fn();

    render(<ProfileEditor profileId={null} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Abandoned" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalledWith("profiles_create", expect.anything());
  });
});
