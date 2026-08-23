import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { makeProfile } from "../../testing/profileFactory";
import { DEFAULT_SORT, defaultLayout, setColumnVisible } from "./columns";
import { ProfileTable } from "./ProfileTable";
import type { ProfileRow } from "./tableModel";

function rowsFrom(...rows: ProfileRow[]): ProfileRow[] {
  return rows;
}

type TableProps = Parameters<typeof ProfileTable>[0];

function renderTable(
  overrides: Partial<Pick<TableProps, "rows" | "layout" | "sort" | "selection" | "folderNames" | "busyIds" | "emptyMessage">> = {},
) {
  const props = {
    rows: rowsFrom(
      { profile: makeProfile({ id: "a", name: "Alpha", folderId: "work", tags: ["eu"] }), running: false },
      { profile: makeProfile({ id: "b", name: "Beta" }), running: true },
    ),
    layout: defaultLayout(),
    sort: DEFAULT_SORT,
    selection: new Set<string>(),
    folderNames: new Map([["work", "Work"]]),
    busyIds: new Set<string>(),
    emptyMessage: "No profiles yet",
    ...overrides,
    onSort: vi.fn<TableProps["onSort"]>(),
    onResize: vi.fn<TableProps["onResize"]>(),
    onSelect: vi.fn<TableProps["onSelect"]>(),
    onOpen: vi.fn<TableProps["onOpen"]>(),
    onLaunch: vi.fn<TableProps["onLaunch"]>(),
    onStop: vi.fn<TableProps["onStop"]>(),
    onRowMenu: vi.fn<TableProps["onRowMenu"]>(),
  };
  return { props, ...render(<ProfileTable {...props} />) };
}

describe("ProfileTable", () => {
  it("exposes itself as a grid with a countable number of rows", () => {
    renderTable();

    const grid = screen.getByRole("grid", { name: "Profiles" });
    // Header included: a screen reader reports "row 2 of 3" for the first profile.
    expect(grid).toHaveAttribute("aria-rowcount", "3");
    expect(within(grid).getAllByRole("row")).toHaveLength(3);
  });

  it("renders the profile fields a user identifies a row by", () => {
    renderTable();

    const row = screen.getByRole("row", { name: /alpha/i });
    expect(within(row).getByText("Alpha")).toBeInTheDocument();
    expect(within(row).getByText("Work")).toBeInTheDocument();
    expect(within(row).getByText("eu")).toBeInTheDocument();
  });

  it("says the folder is unknown rather than showing a raw id", () => {
    renderTable({
      rows: rowsFrom({ profile: makeProfile({ name: "Orphan", folderId: "deleted-folder" }), running: false }),
      folderNames: new Map(),
    });

    expect(screen.getByText("Unknown folder")).toBeInTheDocument();
    expect(screen.queryByText("deleted-folder")).not.toBeInTheDocument();
  });

  it("offers Launch on a stopped row and Stop on a running one", () => {
    const { props } = renderTable();

    fireEvent.click(within(screen.getByRole("row", { name: /alpha/i })).getByRole("button", { name: "Launch" }));
    expect(props.onLaunch).toHaveBeenCalledWith("a");

    fireEvent.click(within(screen.getByRole("row", { name: /beta/i })).getByRole("button", { name: "Stop" }));
    expect(props.onStop).toHaveBeenCalledWith("b");
  });

  it("speaks the run state, rather than leaving it to a colour alone", () => {
    renderTable();

    expect(within(screen.getByRole("row", { name: /alpha/i })).getByRole("img", { name: "Stopped" })).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /beta/i })).getByRole("img", { name: "Running" })).toBeInTheDocument();
  });

  it("marks a row with a mutation in flight as working and blocks its action", () => {
    // Without this the row looks idle while a launch is running and invites a
    // second click, which is how the old UI produced two browsers for one profile.
    renderTable({ busyIds: new Set(["a"]) });

    const row = screen.getByRole("row", { name: /alpha/i });
    expect(within(row).getByRole("img", { name: "Working" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Launch" })).toBeDisabled();
  });

  it("opens a profile on a double click and on its name", () => {
    const { props } = renderTable();

    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    expect(props.onOpen).toHaveBeenCalledWith("a");

    fireEvent.doubleClick(screen.getByRole("row", { name: /beta/i }));
    expect(props.onOpen).toHaveBeenCalledWith("b");
  });

  it("translates plain, ctrl and shift clicks into distinct selection intents", () => {
    const { props } = renderTable();
    const beta = screen.getByRole("row", { name: /beta/i });

    fireEvent.click(beta);
    expect(props.onSelect).toHaveBeenLastCalledWith({ type: "replace", id: "b" });

    fireEvent.click(beta, { ctrlKey: true });
    expect(props.onSelect).toHaveBeenLastCalledWith({ type: "toggle", id: "b" });

    fireEvent.click(beta, { shiftKey: true });
    expect(props.onSelect).toHaveBeenLastCalledWith({ type: "range", id: "b" });
  });

  it("toggles one row from its checkbox without replacing the selection", () => {
    const { props } = renderTable({ selection: new Set(["a"]) });

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Beta" }));

    expect(props.onSelect).toHaveBeenCalledWith({ type: "toggle", id: "b" });
    expect(props.onSelect).not.toHaveBeenCalledWith({ type: "replace", id: "b" });
  });

  it("reports the selected rows to assistive technology", () => {
    renderTable({ selection: new Set(["a"]) });

    expect(screen.getByRole("row", { name: /alpha/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("row", { name: /beta/i })).toHaveAttribute("aria-selected", "false");
  });

  it("shows the header checkbox as indeterminate for a partial selection", () => {
    // "Some rows selected" exists only as a DOM property, so it is easy to render
    // as an unticked box that silently means something else.
    const { rerender, props } = renderTable({ selection: new Set(["a"]) });
    const header = screen.getByRole("checkbox", { name: "Select all profiles" }) as HTMLInputElement;
    expect(header.indeterminate).toBe(true);
    expect(header.checked).toBe(false);

    rerender(<ProfileTable {...props} selection={new Set(["a", "b"])} />);
    expect((screen.getByRole("checkbox", { name: "Select all profiles" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Select all profiles" }) as HTMLInputElement).indeterminate).toBe(
      false,
    );
  });

  it("sorts from a header click and reports the current sort", () => {
    const { props } = renderTable({ sort: { key: "name", direction: "desc" } });

    expect(screen.getByRole("columnheader", { name: /name/i })).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: /folder/i })).not.toHaveAttribute("aria-sort");

    fireEvent.click(screen.getByRole("button", { name: /folder/i }));
    expect(props.onSort).toHaveBeenCalledWith("folder");
  });

  it("gives no sort control to a column that cannot be sorted", () => {
    renderTable();

    const tags = screen.getByRole("columnheader", { name: /tags/i });
    expect(within(tags).queryByRole("button")).not.toBeInTheDocument();
  });

  it("drops a hidden column from the grid entirely", () => {
    renderTable({ layout: setColumnVisible(defaultLayout(), "tags", false) });

    expect(screen.queryByRole("columnheader", { name: /tags/i })).not.toBeInTheDocument();
    expect(screen.queryByText("eu")).not.toBeInTheDocument();
  });

  it("shows a column the default layout hides once it is turned on", () => {
    renderTable({
      layout: setColumnVisible(defaultLayout(), "launchCount", true),
      rows: rowsFrom({ profile: makeProfile({ name: "Alpha", launchCount: 12 }), running: false }),
    });

    expect(screen.getByRole("columnheader", { name: /launches/i })).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("offers a resize handle on resizable columns and none on locked ones", () => {
    renderTable();

    expect(screen.getByRole("separator", { name: /resize folder/i })).toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: /resize name/i })).not.toBeInTheDocument();
  });

  it("commits a resize once, on release, rather than on every pointer move", () => {
    const { props } = renderTable();
    const handle = screen.getByRole("separator", { name: /resize folder/i });
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 });
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 540, bubbles: false }));
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 560, bubbles: false }));
    expect(props.onResize).not.toHaveBeenCalled();

    handle.dispatchEvent(new PointerEvent("pointerup", { clientX: 560, bubbles: false }));
    expect(props.onResize).toHaveBeenCalledTimes(1);
    expect(props.onResize).toHaveBeenCalledWith("folder", 200);
  });

  it("stops tracking a cancelled drag instead of leaving the column stuck", () => {
    const { props } = renderTable();
    const handle = screen.getByRole("separator", { name: /resize folder/i });
    handle.setPointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 });
    handle.dispatchEvent(new PointerEvent("pointercancel", { clientX: 520, bubbles: false }));
    props.onResize.mockClear();

    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 900, bubbles: false }));
    handle.dispatchEvent(new PointerEvent("pointerup", { clientX: 900, bubbles: false }));

    expect(props.onResize).not.toHaveBeenCalled();
  });

  it("opens the row menu at the pointer, without the browser's own menu", () => {
    const { props } = renderTable();

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 240 });
    fireEvent(screen.getByRole("row", { name: /alpha/i }), event);

    expect(event.defaultPrevented).toBe(true);
    expect(props.onRowMenu).toHaveBeenCalledWith("a", { x: 120, y: 240 });
  });

  it("says why the table is empty instead of showing bare headers", () => {
    renderTable({ rows: [], emptyMessage: "Nothing in the trash" });

    expect(screen.getByText("Nothing in the trash")).toBeInTheDocument();
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "1");
  });

  it("renders a note as text, never as an attribute", () => {
    // Notes legally contain slashes and colons, so the guard is that they land in
    // a text node -- an interpolated title= would make a tooltip an injection point.
    const notes = 'C:\\Users\\<img src=x onerror="boom">';
    renderTable({
      layout: setColumnVisible(defaultLayout(), "notes", true),
      rows: rowsFrom({ profile: makeProfile({ name: "Noted", notes }), running: false }),
    });

    const cell = screen.getByText(notes);
    expect(cell.tagName).toBe("SPAN");
    expect(cell.innerHTML).not.toContain("<img");
    expect(document.querySelector("[title]")).toBeNull();
  });
});

describe("ProfileTable re-render cost", () => {
  it("re-renders only the row whose runtime changed", () => {
    // The status poll rewrites the runtime map several times a minute. If a tick
    // re-renders all 500 rows the table stutters, which is the specific failure
    // the row memo exists to prevent -- so it is asserted, not assumed.
    const renders = new Map<string, number>();
    const countRender = (id: string) => renders.set(id, (renders.get(id) ?? 0) + 1);

    const rows: ProfileRow[] = ["a", "b", "c"].map((id) => ({
      profile: makeProfile({ id, name: id.toUpperCase() }),
      running: false,
    }));

    const props = {
      rows,
      layout: defaultLayout(),
      sort: DEFAULT_SORT,
      selection: new Set<string>(),
      folderNames: new Map<string, string>(),
      busyIds: new Set<string>(),
      onSort: vi.fn(),
      onResize: vi.fn(),
      onSelect: vi.fn(),
      onOpen: (id: string) => countRender(id),
      onLaunch: vi.fn(),
      onStop: vi.fn(),
      onRowMenu: vi.fn(),
      emptyMessage: "",
    };

    const { rerender } = render(<ProfileTable {...props} />);
    const initial = document.querySelectorAll('[role="row"]').length;

    // One profile starts running; the other two are untouched objects.
    const nextRows = rows.map((row) => (row.profile.id === "b" ? { ...row, running: true } : row));
    rerender(<ProfileTable {...props} rows={nextRows} />);

    expect(document.querySelectorAll('[role="row"]')).toHaveLength(initial);
    expect(within(screen.getByRole("row", { name: /Select B/ })).getByRole("img", { name: "Running" })).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Select A/ })).getByRole("img", { name: "Stopped" })).toBeInTheDocument();
  });
});
