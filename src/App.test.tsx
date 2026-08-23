import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The profile surfaces have their own suites; here they stand in for themselves
// so this file stays a test of routing rather than a second slow copy of both.
vi.mock("./features/profiles/ProfilesPage", () => ({
  ProfilesPage: ({ view }: { view: string }) => <div data-testid="profiles-table">{view}</div>,
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
