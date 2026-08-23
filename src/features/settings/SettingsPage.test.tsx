import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { SettingsPage } from "./SettingsPage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const dialogs = vi.hoisted(() => ({
  pickDirectory: vi.fn(),
  pickFile: vi.fn(),
  pickSaveTarget: vi.fn(),
}));
vi.mock("../../dialogs", () => dialogs);

vi.mock("../../sidecarEvents", () => ({
  subscribeToProfilesChanged: () => () => {},
  subscribeToChromiumStatusChanged: () => () => {},
  PROFILES_CHANGED_EVENT: "theprivator://profiles-changed",
  CHROMIUM_STATUS_CHANGED_EVENT: "theprivator://chromium-status-changed",
}));

const mockInvoke = vi.mocked(invoke);

function envelope(result: unknown) {
  return { requestId: "bridge-1", protocolVersion: "1.0.0", durationMs: 4.5, result };
}

function health() {
  return envelope({
    status: "healthy",
    product: { name: "ThePrivator", version: "0.1.0" },
    sidecar: { version: "0.1.0" },
    protocol: { version: "1.0.0" },
    runtime: { pythonVersion: "3.14.0", implementation: "CPython" },
    platform: { system: "Linux", release: "7.1.6", machine: "x86_64" },
    build: { mode: "source", frozen: false },
  });
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
  dialogs.pickDirectory.mockReset();
  dialogs.pickFile.mockReset();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("SettingsPage navigation", () => {
  it("lists every section and marks the open one", () => {
    respond({ sync_status: () => envelope({}) });

    render(<SettingsPage section="appearance" />);

    const nav = screen.getByRole("navigation", { name: /settings sections/i });
    for (const label of ["Appearance", "Synchronization", "Diagnostics", "Import"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(within(nav).getByRole("link", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Import" })).not.toHaveAttribute("aria-current");
  });
});

describe("Appearance", () => {
  it("opens on whatever the document already says", () => {
    document.documentElement.setAttribute("data-theme", "dark");

    render(<SettingsPage section="appearance" />);

    expect(screen.getByRole("radio", { name: /dark/i })).toBeChecked();
  });

  it("treats a missing attribute as following the system", () => {
    render(<SettingsPage section="appearance" />);

    expect(screen.getByRole("radio", { name: /match the system/i })).toBeChecked();
  });

  it("stamps an explicit choice onto the document", () => {
    render(<SettingsPage section="appearance" />);

    fireEvent.click(screen.getByRole("radio", { name: /^dark/i }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("removes the attribute rather than writing 'system' onto it", () => {
    // The token layer distinguishes "no attribute" (follow prefers-color-scheme)
    // from an explicit choice. A third value would match neither rule.
    document.documentElement.setAttribute("data-theme", "light");
    render(<SettingsPage section="appearance" />);

    fireEvent.click(screen.getByRole("radio", { name: /match the system/i }));

    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("Diagnostics", () => {
  it("reports the sidecar it is talking to", async () => {
    respond({ sidecar_health: health });

    render(<SettingsPage section="diagnostics" />);

    expect(await screen.findByText("healthy")).toBeInTheDocument();
    expect(screen.getByText("1.0.0")).toBeInTheDocument();
  });

  it("explains what a diagnostic reference is for", () => {
    respond({ sidecar_health: health });

    render(<SettingsPage section="diagnostics" />);

    // The reason the redaction is affordable: the detail is kept, not destroyed.
    expect(screen.getByText(/short reference instead of the full detail/i)).toBeInTheDocument();
  });

  it("will not look up an empty reference", () => {
    respond({ sidecar_health: health });

    render(<SettingsPage section="diagnostics" />);

    expect(screen.getByRole("button", { name: "Look up" })).toBeDisabled();
  });

  it("exchanges a reference for what was recorded", async () => {
    respond({
      sidecar_health: health,
      diagnostics_lookup: () => ({
          found: true,
          detailRef: "sidecar-abc123",
          logPath: "profile-store/diagnostics/events.jsonl",
          reason: "found",
          entries: [
            {
              schemaVersion: 1,
              ts: "2026-05-04T18:00:00.000Z",
              source: "python-sidecar",
              event: "sidecar.request",
              status: "error",
              logPath: "profile-store/diagnostics/events.jsonl",
              method: "profiles.create",
              errorCode: "PROFILE_DUPLICATE_NAME",
              detailRef: "sidecar-abc123",
            },
          ],
      }),
    });

    render(<SettingsPage section="diagnostics" />);
    fireEvent.change(screen.getByLabelText(/diagnostic reference/i), { target: { value: "sidecar-abc123" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));

    const entries = await screen.findByRole("list", { name: /diagnostic entries/i });
    expect(within(entries).getByText("PROFILE_DUPLICATE_NAME")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("diagnostics_lookup", { detailRef: "sidecar-abc123" });
  });

  it("says plainly when a reference recorded nothing", async () => {
    respond({
      sidecar_health: health,
      diagnostics_lookup: () => ({
        found: false,
        detailRef: "sidecar-nope",
        logPath: "profile-store/diagnostics/events.jsonl",
        reason: "not-persisted",
        entries: [],
      }),
    });

    render(<SettingsPage section="diagnostics" />);
    fireEvent.change(screen.getByLabelText(/diagnostic reference/i), { target: { value: "sidecar-nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));

    expect(await screen.findByText(/nothing was recorded/i)).toBeInTheDocument();
  });
});

describe("Import", () => {
  const IMPORTED_ID = "11111111-1111-1111-1111-111111111111";

  function packageResult(overrides: Record<string, unknown> = {}) {
    return envelope({
      packageVersion: 3,
      format: "theprivator.profile-package",
      operation: "import",
      profileId: IMPORTED_ID,
      profileName: "Banking",
      nameConflictResolved: false,
      profile: { id: IMPORTED_ID, name: "Banking" },
      cookieCount: 3,
      importedCookieCount: 3,
      replacedCookieCount: 3,
      payloadFileCount: 12,
      payloadByteCount: 4096,
      warningCount: 0,
      warnings: [],
      ...overrides,
    });
  }

  it("warns that proxy passwords do not travel in a package", () => {
    render(<SettingsPage section="import" />);

    expect(screen.getByText(/passwords are deliberately left out/i)).toBeInTheDocument();
  });

  it("imports the package the user picked and reports the result", async () => {
    dialogs.pickFile.mockResolvedValue("/home/someone/Banking.tpkg");
    respond({ profile_package_import: packageResult });

    render(<SettingsPage section="import" />);
    fireEvent.click(screen.getByRole("button", { name: /choose a package/i }));

    expect(await screen.findByText("Banking")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("profile_package_import", {
      sourcePath: "/home/someone/Banking.tpkg",
    });
  });

  it("says when the imported profile had to be renamed", async () => {
    dialogs.pickFile.mockResolvedValue("/home/someone/Banking.tpkg");
    respond({ profile_package_import: () => packageResult({ nameConflictResolved: true }) });

    render(<SettingsPage section="import" />);
    fireEvent.click(screen.getByRole("button", { name: /choose a package/i }));

    expect(await screen.findByText(/that name was taken/i)).toBeInTheDocument();
  });

  it("does nothing when the file picker is cancelled", async () => {
    dialogs.pickFile.mockResolvedValue(null);
    respond({ profile_package_import: packageResult });

    render(<SettingsPage section="import" />);
    fireEvent.click(screen.getByRole("button", { name: /choose a package/i }));

    await waitFor(() => expect(dialogs.pickFile).toHaveBeenCalled());
    expect(mockInvoke).not.toHaveBeenCalledWith("profile_package_import", expect.anything());
  });

  it("reports a rejected package rather than looking like nothing happened", async () => {
    dialogs.pickFile.mockResolvedValue("/home/someone/broken.tpkg");
    respond({
      profile_package_import: () =>
        Promise.reject({
          code: "PORTABILITY_PACKAGE_CHECKSUM_MISMATCH",
          message: "A file in the package does not match its checksum.",
          recoverable: true,
          detailRef: "sidecar-0a1b2c3d4e5f",
        }),
    });

    render(<SettingsPage section="import" />);
    fireEvent.click(screen.getByRole("button", { name: /choose a package/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/does not match its checksum/i);
  });

  it("scans a chosen folder and selects nothing by itself", async () => {
    // Importing everything a scan found is how a user ends up with forty
    // profiles they did not ask for.
    dialogs.pickDirectory.mockResolvedValue("/home/someone/.theprivator");
    respond({
      legacy_scan_profiles: () =>
        envelope({
          scanVersion: 1,
          count: 2,
          candidates: [
            {
              legacyId: "legacy-one",
              folderName: "profile-one",
              legacyName: "Old banking",
              targetName: "Old banking",
              userData: { status: "available" },
              metadata: {},
              issues: [],
            },
            {
              legacyId: "legacy-two",
              folderName: "profile-two",
              legacyName: null,
              targetName: "profile-two",
              userData: { status: "missing" },
              metadata: {},
              issues: [],
            },
          ],
          issues: [],
        }),
    });

    render(<SettingsPage section="import" />);
    fireEvent.click(screen.getByRole("button", { name: /choose a folder to scan/i }));
    await waitFor(() => expect(dialogs.pickDirectory).toHaveBeenCalled());
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("legacy_scan_profiles", expect.anything()));

    const found = await screen.findByRole("list", { name: /profiles found/i });
    expect(within(found).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(found).getAllByRole("checkbox").every((box) => !(box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("button", { name: /import 0 profiles/i })).toBeDisabled();
  });

  it("shows the name each legacy profile will take before importing", async () => {
    dialogs.pickDirectory.mockResolvedValue("/home/someone/.theprivator");
    respond({
      legacy_scan_profiles: () =>
        envelope({
          scanVersion: 1,
          count: 1,
          candidates: [
            {
              legacyId: "legacy-one",
              folderName: "profile-one",
              legacyName: "Banking",
              targetName: "Banking (2)",
              userData: { status: "available" },
              metadata: {},
              issues: [],
            },
          ],
          issues: [],
        }),
    });

    render(<SettingsPage section="import" />);
    fireEvent.click(screen.getByRole("button", { name: /choose a folder to scan/i }));

    expect(await screen.findByText(/will be imported as .Banking \(2\)./i)).toBeInTheDocument();
  });

  it("imports only the profiles that were ticked", async () => {
    dialogs.pickDirectory.mockResolvedValue("/home/someone/.theprivator");
    respond({
      legacy_scan_profiles: () =>
        envelope({
          scanVersion: 1,
          count: 2,
          candidates: [
            {
              legacyId: "legacy-one",
              folderName: "profile-one",
              legacyName: "Keep me",
              targetName: "Keep me",
              userData: { status: "available" },
              metadata: {},
              issues: [],
            },
            {
              legacyId: "legacy-two",
              folderName: "profile-two",
              legacyName: "Leave me",
              targetName: "Leave me",
              userData: { status: "available" },
              metadata: {},
              issues: [],
            },
          ],
          issues: [],
        }),
      legacy_import_profiles: () =>
        envelope({
          importVersion: 1,
          requestedCount: 1,
          successCount: 1,
          partialCount: 0,
          failedCount: 0,
          outcomes: [
            {
              legacyId: "legacy-one",
              targetName: "Keep me",
              status: "success",
              copyStatus: "copied",
              profileId: "11111111-1111-1111-1111-111111111111",
            },
          ],
        }),
    });

    render(<SettingsPage section="import" />);
    fireEvent.click(screen.getByRole("button", { name: /choose a folder to scan/i }));
    await screen.findByRole("list", { name: /profiles found/i });

    fireEvent.click(screen.getByRole("checkbox", { name: /keep me/i }));
    fireEvent.click(screen.getByRole("button", { name: /import 1 profile$/i }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("legacy_import_profiles", {
        legacyRoot: "/home/someone/.theprivator",
        items: [{ legacyId: "legacy-one", targetName: "Keep me" }],
      }),
    );
    expect(await screen.findByText(/1 imported/i)).toBeInTheDocument();
  });
});
