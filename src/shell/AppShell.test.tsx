import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const windowControlsMock = vi.hoisted(() => ({
  closeWindow: vi.fn(),
  minimizeWindow: vi.fn(),
  startDragging: vi.fn(),
  toggleMaximizeWindow: vi.fn(),
}));

vi.mock("../windowControls", () => windowControlsMock);

import { AppShell } from "./AppShell";
import type { Route } from "../app/routes";

function renderShell(overrides: Partial<Parameters<typeof AppShell>[0]> = {}) {
  const props = {
    route: { name: "profiles", view: "all", folderId: null } as Route,
    search: "",
    onSearchChange: vi.fn(),
    folders: [],
    counts: { all: 3, favorites: 1, running: 0, trash: 2 },
    sidebarCollapsed: false,
    onToggleSidebar: vi.fn(),
    statusTiles: [],
    showSidebar: true,
    children: <p>workspace body</p>,
    ...overrides,
  };
  return { props, ...render(<AppShell {...props} />) };
}

describe("AppShell", () => {
  it("names its landmarks so the workspace is reachable without a mouse", () => {
    renderShell();

    expect(screen.getByRole("link", { name: /skip to workspace/i })).toHaveAttribute("href", "#workspace");
    expect(screen.getByRole("main", { name: /profiles workspace/i })).toHaveAttribute("id", "workspace");
    expect(screen.getByRole("navigation", { name: /primary navigation/i })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /profile folders and views/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/global product status/i)).toBeInTheDocument();
  });

  it("keeps the window controls outside the drag region", () => {
    // A button inside it starts a window drag on press instead of firing.
    renderShell();

    for (const name of [/minimize window/i, /maximize or restore window/i, /close window/i]) {
      const control = screen.getByRole("button", { name });
      expect(control.closest("[data-tauri-drag-region]")).toBeNull();
    }
  });

  it("wires each window control to its own action", () => {
    renderShell();

    fireEvent.click(screen.getByRole("button", { name: /minimize window/i }));
    expect(windowControlsMock.minimizeWindow).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /maximize or restore window/i }));
    expect(windowControlsMock.toggleMaximizeWindow).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /close window/i }));
    expect(windowControlsMock.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("maximizes on a double click, which WebKitGTK does not do for a custom chrome", () => {
    renderShell();
    windowControlsMock.toggleMaximizeWindow.mockClear();

    fireEvent.doubleClick(screen.getByLabelText(/window drag region/i));

    expect(windowControlsMock.toggleMaximizeWindow).toHaveBeenCalledTimes(1);
  });

  it("marks the destination matching the route as current", () => {
    renderShell({ route: { name: "proxies" } });

    const nav = screen.getByRole("navigation", { name: /primary navigation/i });
    expect(within(nav).getByRole("link", { name: "Proxies" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Profiles" })).not.toHaveAttribute("aria-current");
  });

  it("keeps a profile detail route under the profiles destination", () => {
    renderShell({ route: { name: "profile", id: "abc" } });

    const nav = screen.getByRole("navigation", { name: /primary navigation/i });
    expect(within(nav).getByRole("link", { name: "Profiles" })).toHaveAttribute("aria-current", "page");
  });

  it("hides the folder rail on destinations it does not describe", () => {
    renderShell({ route: { name: "automation" }, showSidebar: false });

    expect(screen.queryByRole("navigation", { name: /profile folders/i })).not.toBeInTheDocument();
    expect(screen.getByRole("main", { name: /automation/i })).toBeInTheDocument();
  });

  it("reports per-view profile counts in the rail", () => {
    renderShell();

    const rail = screen.getByRole("navigation", { name: /profile folders and views/i });
    // Not "All profiles3" -- a count glued to a label is what a screen reader reads out.
    expect(within(rail).getByRole("link", { name: "All profiles, 3 profiles" })).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Trash, 2 profiles" })).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Favorites, 1 profile" })).toBeInTheDocument();
  });

  it("exposes folders as a tree and marks the open one", () => {
    renderShell({
      route: { name: "profiles", view: "all", folderId: "work" },
      folders: [
        { id: "work", name: "Work", profileCount: 2 },
        { id: "personal", name: "Personal", profileCount: 1 },
      ],
    });

    const tree = screen.getByRole("tree", { name: /folders/i });
    expect(within(tree).getByRole("treeitem", { name: "Work, 2 profiles" })).toHaveAttribute("aria-selected", "true");
    expect(within(tree).getByRole("treeitem", { name: "Personal, 1 profile" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("reports the collapse state of the rail", () => {
    const { props } = renderShell({ sidebarCollapsed: true });

    const toggle = screen.getByRole("button", { name: /expand sidebar/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(props.onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("renders a status tile as a button only when it leads somewhere", () => {
    // Announcing a read-only number as actionable is a lie to a screen reader.
    const onSelect = vi.fn();
    renderShell({
      statusTiles: [
        { key: "profiles", label: "Profiles", value: "3" },
        { key: "sync", label: "Sync", value: "Off", onSelect },
      ],
    });

    const status = screen.getByLabelText(/global product status/i);
    expect(within(status).queryByRole("button", { name: "Profiles: 3" })).not.toBeInTheDocument();
    fireEvent.click(within(status).getByRole("button", { name: "Sync: Off" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("reports search text to its owner rather than holding it", () => {
    const { props } = renderShell();

    fireEvent.change(screen.getByRole("searchbox", { name: /search profiles/i }), {
      target: { value: "banking" },
    });

    expect(props.onSearchChange).toHaveBeenCalledWith("banking");
  });
});
