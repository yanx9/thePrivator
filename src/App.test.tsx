import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The legacy tree is exercised by its own suite; here it stands in for "the
// profiles surface" so this file can stay a test of routing rather than a second
// slow copy of that suite.
vi.mock("./legacy/LegacyApp", () => ({
  LegacyApp: () => <div data-testid="legacy-profiles" />,
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

  it("opens on the profiles surface", () => {
    render(<App />);

    expect(screen.getByTestId("legacy-profiles")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /profile folders and views/i })).toBeInTheDocument();
  });

  it("follows the hash to another destination without a reload", () => {
    render(<App />);

    navigate("#/proxies");

    expect(screen.queryByTestId("legacy-profiles")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Proxies" })).toBeInTheDocument();
  });

  it("keeps the folder rail on a profile detail route and drops it elsewhere", () => {
    render(<App />);

    navigate("#/profiles/abc123");
    expect(screen.getByRole("navigation", { name: /profile folders and views/i })).toBeInTheDocument();

    navigate("#/settings/sync");
    expect(screen.queryByRole("navigation", { name: /profile folders/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("falls back to profiles for a hash that names no destination", () => {
    render(<App />);

    navigate("#/../../etc/passwd");

    expect(screen.getByTestId("legacy-profiles")).toBeInTheDocument();
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
