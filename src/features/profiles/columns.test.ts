import { describe, expect, it } from "vitest";

import {
  COLUMNS,
  DEFAULT_SORT,
  MAX_COLUMN_WIDTH,
  clampWidth,
  columnByKey,
  defaultLayout,
  gridTemplate,
  moveColumn,
  nextSort,
  reconcileLayout,
  setColumnVisible,
  setColumnWidth,
  visibleColumns,
} from "./columns";

describe("column descriptors", () => {
  it("gives every column a spoken header", () => {
    // The checkbox and row-action columns render no text, and a grid whose header
    // cell is empty announces the column as blank.
    for (const column of COLUMNS) {
      const spoken = column.label.length > 0 ? column.label : column.srLabel;
      expect(spoken, `column ${column.key}`).toBeTruthy();
    }
  });

  it("keeps the columns a row cannot work without unhideable", () => {
    for (const key of ["select", "status", "name", "actions"] as const) {
      expect(columnByKey(key).locked, key).toBe(true);
    }
  });

  it("never marks a locked column as hidden by default", () => {
    for (const column of COLUMNS) {
      if (column.locked === true) {
        expect(column.hiddenByDefault, column.key).not.toBe(true);
      }
    }
  });

  it("gives every column a minimum width it can actually render in", () => {
    for (const column of COLUMNS) {
      expect(column.minWidth, column.key).toBeGreaterThan(0);
      expect(column.defaultWidth, column.key).toBeGreaterThanOrEqual(column.minWidth);
      expect(column.defaultWidth, column.key).toBeLessThanOrEqual(MAX_COLUMN_WIDTH);
    }
  });

  it("rejects an unknown key rather than returning a hole", () => {
    expect(() => columnByKey("nope" as never)).toThrow(/unknown column/);
  });
});

describe("defaultLayout", () => {
  it("starts with a readable subset rather than every column at once", () => {
    const layout = defaultLayout();

    expect(layout).toHaveLength(COLUMNS.length);
    expect(visibleColumns(layout).map((entry) => entry.key)).toEqual([
      "select",
      "status",
      "name",
      "folder",
      "tags",
      "proxy",
      "fingerprint",
      "lastLaunchedAt",
      "actions",
    ]);
  });
});

describe("reconcileLayout", () => {
  it("keeps a stored layout that still matches this build", () => {
    const stored = setColumnVisible(defaultLayout(), "notes", true);

    expect(reconcileLayout(stored)).toEqual(stored);
  });

  it("appends a column this build added but the stored layout never saw", () => {
    const stored = defaultLayout().filter((entry) => entry.key !== "launchCount");

    const reconciled = reconcileLayout(stored);

    expect(reconciled.map((entry) => entry.key)).toContain("launchCount");
    expect(reconciled).toHaveLength(COLUMNS.length);
  });

  it("drops a column this build no longer has", () => {
    const stored = [...defaultLayout(), { key: "cookieJar", visible: true, width: 100 }];

    expect(reconcileLayout(stored).map((entry) => entry.key)).not.toContain("cookieJar");
  });

  it("re-shows a locked column that a stale layout had hidden", () => {
    // Otherwise a layout written before "name" was locked leaves a nameless table.
    const stored = defaultLayout().map((entry) =>
      entry.key === "name" ? { ...entry, visible: false } : entry,
    );

    expect(reconcileLayout(stored).find((entry) => entry.key === "name")?.visible).toBe(true);
  });

  it("clamps a width that would push a column off screen", () => {
    const stored = defaultLayout().map((entry) =>
      entry.key === "folder" ? { ...entry, width: 99_999 } : entry,
    );

    expect(reconcileLayout(stored).find((entry) => entry.key === "folder")?.width).toBe(MAX_COLUMN_WIDTH);
  });

  it("falls back to the defaults for input that is not a layout at all", () => {
    for (const junk of [null, undefined, "layout", 7, {}, [1, 2, 3], [{ key: 5 }]]) {
      expect(reconcileLayout(junk)).toHaveLength(COLUMNS.length);
    }
    expect(reconcileLayout(null)).toEqual(defaultLayout());
  });

  it("keeps the first of a duplicated key rather than rendering the column twice", () => {
    const stored = [
      { key: "name", visible: true, width: 200 },
      { key: "name", visible: true, width: 400 },
    ];

    const names = reconcileLayout(stored).filter((entry) => entry.key === "name");
    expect(names).toHaveLength(1);
    expect(names[0].width).toBe(200);
  });
});

describe("layout edits", () => {
  it("refuses to hide a locked column", () => {
    const layout = setColumnVisible(defaultLayout(), "name", false);

    expect(layout.find((entry) => entry.key === "name")?.visible).toBe(true);
  });

  it("hides and re-shows an optional column", () => {
    const hidden = setColumnVisible(defaultLayout(), "tags", false);
    expect(hidden.find((entry) => entry.key === "tags")?.visible).toBe(false);
    expect(setColumnVisible(hidden, "tags", true).find((entry) => entry.key === "tags")?.visible).toBe(true);
  });

  it("clamps a resize to the column's own minimum", () => {
    const layout = setColumnWidth(defaultLayout(), "folder", 5);

    expect(layout.find((entry) => entry.key === "folder")?.width).toBe(columnByKey("folder").minWidth);
  });

  it("survives a resize to a non-finite width", () => {
    // pointermove arithmetic produces NaN the moment a pointer event arrives
    // without a start position.
    const layout = setColumnWidth(defaultLayout(), "folder", Number.NaN);

    expect(layout.find((entry) => entry.key === "folder")?.width).toBe(columnByKey("folder").defaultWidth);
  });

  it("moves a column without disturbing the others", () => {
    const layout = defaultLayout();
    const proxyIndex = layout.findIndex((entry) => entry.key === "proxy");

    const moved = moveColumn(layout, "proxy", proxyIndex - 1);

    expect(moved).toHaveLength(layout.length);
    expect(new Set(moved.map((entry) => entry.key))).toEqual(new Set(layout.map((entry) => entry.key)));
    expect(moved.findIndex((entry) => entry.key === "proxy")).toBe(proxyIndex - 1);
  });

  it("will not move a column past the locked ones at either end", () => {
    const layout = defaultLayout();

    const toFront = moveColumn(layout, "proxy", 0);
    const toBack = moveColumn(layout, "proxy", layout.length - 1);

    expect(toFront.slice(0, 3).map((entry) => entry.key)).toEqual(["select", "status", "name"]);
    expect(toBack[toBack.length - 1].key).toBe("actions");
  });

  it("refuses to move a locked column", () => {
    const layout = defaultLayout();

    expect(moveColumn(layout, "actions", 3)).toEqual(layout);
  });

  it("ignores a move of a column that is not in the layout", () => {
    const layout = defaultLayout().filter((entry) => entry.key !== "notes");

    expect(moveColumn(layout, "notes", 2)).toEqual(layout);
  });
});

/** Count grid tracks without splitting `minmax(260px, 1fr)` down its comma. */
function trackCount(template: string): number {
  return template.replace(/\([^)]*\)/g, "").trim().split(/\s+/).length;
}

describe("gridTemplate", () => {
  it("lists one track per visible column, in order", () => {
    const template = gridTemplate(defaultLayout());

    expect(trackCount(template)).toBe(visibleColumns(defaultLayout()).length);
    expect(template.startsWith("36px 40px minmax(260px, 1fr)")).toBe(true);
  });

  it("gives the slack to Name so the table fills any window width", () => {
    expect(gridTemplate(defaultLayout())).toContain("minmax(260px, 1fr)");
    expect(gridTemplate(defaultLayout()).match(/1fr/g)).toHaveLength(1);
  });

  it("drops a hidden column from the template", () => {
    const layout = setColumnVisible(defaultLayout(), "tags", false);

    expect(trackCount(gridTemplate(layout))).toBe(visibleColumns(layout).length);
  });
});

describe("clampWidth", () => {
  it("rounds to whole pixels, because a fractional track blurs the borders", () => {
    expect(clampWidth(columnByKey("folder"), 140.4)).toBe(140);
  });
});

describe("nextSort", () => {
  it("cycles ascending, descending, then back to the default", () => {
    const first = nextSort(DEFAULT_SORT, "createdAt");
    expect(first).toEqual({ key: "createdAt", direction: "asc" });

    const second = nextSort(first, "createdAt");
    expect(second).toEqual({ key: "createdAt", direction: "desc" });

    // Without this third step there is no way back to the opening order.
    expect(nextSort(second, "createdAt")).toEqual(DEFAULT_SORT);
  });

  it("starts a new column ascending regardless of the previous direction", () => {
    const descending = { key: "createdAt", direction: "desc" } as const;

    expect(nextSort(descending, "launchCount")).toEqual({ key: "launchCount", direction: "asc" });
  });

  it("ignores a click on a column that does not sort", () => {
    expect(nextSort(DEFAULT_SORT, "tags")).toEqual(DEFAULT_SORT);
    expect(nextSort(DEFAULT_SORT, "actions")).toEqual(DEFAULT_SORT);
  });
});
