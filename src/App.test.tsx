import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

// The profile surfaces have their own suites; here they stand in for themselves
// so this file stays a test of routing rather than a second slow copy of both.
vi.mock("./features/profiles/ProfilesPage", () => ({
  ProfilesPage: ({ view }: { view: string }) => <div data-testid="profiles-table">{view}</div>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("./sidecarEvents", () => ({
  subscribeToProfilesChanged: () => () => {},
  subscribeToChromiumStatusChanged: () => () => {},
  PROFILES_CHANGED_EVENT: "theprivator://profiles-changed",
  CHROMIUM_STATUS_CHANGED_EVENT: "theprivator://chromium-status-changed",
}));

vi.mock("./features/profiles/ProfileEditor", () => ({
  ProfileEditor: ({ profileId }: { profileId: string | null }) => (
    <div data-testid="profile-editor">{profileId ?? "new"}</div>
  ),
}));

vi.mock("./windowControls", () => ({
  closeWindow: vi.fn(),
  minimizeWindow: vi.fn(),
  startDragging: vi.fn(),
  toggleMaximizeWindow: vi.fn(),
}));

import { App } from "./App";

function navigate(hash: string) {
  window.location.hash = hash;
  fireEvent(window, new HashChangeEvent("hashchange"));
}

describe("App", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  afterEach(() => {
    window.location.hash = "";
  });

  it("opens on the profile table", () => {
    render(<App />);

    expect(screen.getByTestId("profiles-table")).toHaveTextContent("all");
    expect(screen.getByRole("navigation", { name: /profile folders and views/i })).toBeInTheDocument();
  });

  it("passes the view named by the hash down to the table", () => {
    render(<App />);

    navigate("#/profiles/trash");

    expect(screen.getByTestId("profiles-table")).toHaveTextContent("trash");
  });

  it("opens the editor for one profile, and the create flow for a new one", () => {
    render(<App />);

    navigate("#/profiles/abc123");
    expect(screen.getByTestId("profile-editor")).toHaveTextContent("abc123");

    navigate("#/profiles/new");
    expect(screen.getByTestId("profile-editor")).toHaveTextContent("new");
  });

  it("follows the hash to another destination without a reload", () => {
    render(<App />);

    navigate("#/proxies");

    expect(screen.queryByTestId("profiles-table")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Proxies" })).toBeInTheDocument();
  });

  it("keeps the folder rail on a profile detail route and drops it elsewhere", () => {
    render(<App />);

    navigate("#/profiles/abc123");
    expect(screen.getByRole("navigation", { name: /profile folders and views/i })).toBeInTheDocument();

    navigate("#/settings/diagnostics");
    expect(screen.queryByRole("navigation", { name: /profile folders/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Diagnostics" })).toBeInTheDocument();
  });

  it("opens the synchronization page from its own settings section", () => {
    render(<App />);

    navigate("#/settings/sync");

    expect(screen.getByRole("heading", { name: /profile synchronization/i })).toBeInTheDocument();
  });

  it("falls back to profiles for a hash that names no destination", () => {
    render(<App />);

    navigate("#/../../etc/passwd");

    expect(screen.getByTestId("profiles-table")).toHaveTextContent("all");
  });

  it("reaches every destination by clicking, so none needs a typed hash", () => {
    render(<App />);

    const nav = screen.getByRole("navigation", { name: /primary navigation/i });
    for (const name of ["Profiles", "Proxies", "Templates", "Automation"]) {
      expect(nav).toContainElement(screen.getByRole("link", { name }));
    }
    // Settings is a gear beside the search box, not a fifth nav slot.
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "#/settings/appearance");
  });

  it("marks the settings gear as current while a settings route is open", () => {
    render(<App />);
    expect(screen.getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current");

    navigate("#/settings/diagnostics");

    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  });
});

describe("App sidebar counts", () => {
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
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      defaults: { browser: "chromium", startUrl: "about:blank", proxyMode: "direct", fingerprintMode: "disabled" },
      storage: { profileDir: `profile-store/profiles/${id}`, userDataDir: `profile-store/profiles/${id}/user-data` },
      identity: identity(),
      proxy: { proxyVersion: 1, mode: "direct", credentialState: "none", summary: "Direct connection" },
      organization: { folderId: null, tags: [], notes: "", favorite: false, color: null },
      launch: { startupBehavior: "customUrls", startUrls: [], args: [] },
      lifecycle: { deletedAt: null, lastLaunchedAt: null, launchCount: 0 },
      sync: { revision: 1, updatedBy: "d", originDeviceId: "d", lastSyncedAt: null, lastSyncedRevision: null },
      ...overrides,
    };
  }

  const ALPHA = "11111111-1111-1111-1111-111111111111";
  const BETA = "22222222-2222-2222-2222-222222222222";
  const GONE = "33333333-3333-3333-3333-333333333333";

  function envelope(result: unknown) {
    return { requestId: "b", protocolVersion: "1.0.0", durationMs: 1, result };
  }

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "profiles_list") {
        return Promise.resolve(
          envelope({
            storeVersion: 4,
            profiles: [
              record(ALPHA, "Alpha", { organization: { folderId: null, tags: [], notes: "", favorite: true, color: null } }),
              record(BETA, "Beta"),
            ],
            count: 2,
          }),
        ) as ReturnType<typeof invoke>;
      }
      if (command === "chromium_status") {
        return Promise.resolve(
          envelope({
            runningCount: 1,
            profiles: [
              {
                profileId: BETA,
                status: "running",
                pid: 1,
                startedAt: "2026-01-01T00:00:00.000Z",
                userDataDir: `profile-store/profiles/${BETA}/user-data`,
              },
            ],
            reconciled: [],
          }),
        ) as ReturnType<typeof invoke>;
      }
      if (command === "profiles_trash_list") {
        return Promise.resolve(
          envelope({
            storeVersion: 4,
            profiles: [record(GONE, "Deleted", { lifecycle: { deletedAt: "2026-01-02T00:00:00.000Z", lastLaunchedAt: null, launchCount: 0 } })],
            count: 1,
          }),
        ) as ReturnType<typeof invoke>;
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
  });

  it("counts the profiles it actually loaded, not zero", async () => {
    // The sidebar read zero beside a table saying seven, because the counts were
    // placeholders that never got wired to the loader.
    render(<App />);

    const rail = await screen.findByRole("navigation", { name: /profile folders and views/i });
    expect(await within(rail).findByRole("link", { name: "All profiles, 2 profiles" })).toBeInTheDocument();
  });

  it("counts favorites, running browsers and the trash separately", async () => {
    render(<App />);

    const rail = await screen.findByRole("navigation", { name: /profile folders and views/i });
    expect(await within(rail).findByRole("link", { name: "Favorites, 1 profile" })).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Running, 1 profile" })).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Trash, 1 profile" })).toBeInTheDocument();
  });

  it("fills the status bar rather than leaving it empty", async () => {
    render(<App />);

    const status = await screen.findByLabelText(/global product status/i);
    expect(await within(status).findByLabelText("Profiles: 2")).toBeInTheDocument();
    expect(within(status).getByLabelText("Running: 1")).toBeInTheDocument();
    expect(within(status).getByLabelText("Sidecar: Connected")).toBeInTheDocument();
  });

  it("says the sidecar is unavailable when the library will not load", async () => {
    vi.mocked(invoke).mockImplementation(() =>
      Promise.reject({
        code: "SIDECAR_TIMEOUT",
        message: "The sidecar timed out.",
        recoverable: true,
        detailRef: "sidecar-0a1b2c3d4e5f",
      }),
    );

    render(<App />);

    const status = await screen.findByLabelText(/global product status/i);
    expect(await within(status).findByLabelText("Sidecar: Unavailable")).toBeInTheDocument();
  });
});
