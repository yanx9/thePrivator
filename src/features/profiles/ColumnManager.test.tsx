import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ColumnManager } from "./ColumnManager";
import { type ColumnLayout, columnByKey, defaultLayout, setColumnVisible, visibleColumns } from "./columns";

function renderManager(overrides: { layout?: ColumnLayout } = {}) {
  const props = {
    layout: overrides.layout ?? defaultLayout(),
    onApply: vi.fn<(layout: ColumnLayout) => void>(),
    onClose: vi.fn<() => void>(),
  };
  return { props, ...render(<ColumnManager {...props} />) };
}

describe("ColumnManager", () => {
  it("lists the columns a user may hide, and none of the ones they may not", () => {
    renderManager();

    expect(screen.getByRole("checkbox", { name: "Tags" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Notes" })).toBeInTheDocument();
    // Hiding Name would leave a table of anonymous rows.
    expect(screen.queryByRole("checkbox", { name: "Name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /select/i })).not.toBeInTheDocument();
  });

  it("reports how much of the table is showing", () => {
    renderManager();

    const shown = visibleColumns(defaultLayout()).length;
    expect(screen.getByText(`${shown} of ${defaultLayout().length} columns shown`)).toBeInTheDocument();
  });

  it("edits a draft, leaving the live table alone until Apply", () => {
    // Live-applying re-lays out the grid under the panel the user is reading, and
    // leaves no way back from four toggles ago.
    const { props } = renderManager();

    fireEvent.click(screen.getByRole("checkbox", { name: "Tags" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Notes" }));

    expect(props.onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(props.onApply).toHaveBeenCalledTimes(1);
    const applied = props.onApply.mock.calls[0][0];
    expect(applied.find((entry) => entry.key === "tags")?.visible).toBe(false);
    expect(applied.find((entry) => entry.key === "notes")?.visible).toBe(false);
  });

  it("closes after applying, so the panel does not sit over the change it made", () => {
    const { props } = renderManager();

    fireEvent.click(screen.getByRole("checkbox", { name: "Tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("throws the draft away on Cancel", () => {
    const { props } = renderManager();

    fireEvent.click(screen.getByRole("checkbox", { name: "Tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape without applying", () => {
    const { props } = renderManager();

    fireEvent.click(screen.getByRole("checkbox", { name: "Tags" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Apply inert until something actually changed", () => {
    renderManager();

    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Tags" }));
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("restores the shipped layout from Reset, into the draft", () => {
    const { props } = renderManager({ layout: setColumnVisible(defaultLayout(), "tags", false) });

    expect(screen.getByRole("checkbox", { name: "Tags" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("checkbox", { name: "Tags" })).toBeChecked();
    expect(props.onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(props.onApply).toHaveBeenCalledWith(defaultLayout());
  });

  it("reorders a column and reports the new order", () => {
    const { props } = renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Move Proxy up" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const keys = props.onApply.mock.calls[0][0].map((entry) => entry.key);
    expect(keys.indexOf("proxy")).toBeLessThan(keys.indexOf("tags"));
    expect(new Set(keys)).toEqual(new Set(defaultLayout().map((entry) => entry.key)));
  });

  it("disables the move that would run off the end of the list", () => {
    renderManager();

    const movable = defaultLayout().filter((entry) => columnByKey(entry.key).locked !== true);
    const first = columnByKey(movable[0].key).label;
    const last = columnByKey(movable[movable.length - 1].key).label;

    expect(screen.getByRole("button", { name: `Move ${first} up` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Move ${last} down` })).toBeDisabled();
  });

  it("names itself as a dialog, so it is announced when it opens", () => {
    renderManager();

    expect(screen.getByRole("dialog", { name: "Choose columns" })).toBeInTheDocument();
  });
});
