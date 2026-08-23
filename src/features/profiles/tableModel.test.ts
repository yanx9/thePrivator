import { describe, expect, it } from "vitest";

import { makeProfile } from "../../testing/profileFactory";
import { DEFAULT_SORT, type SortState } from "./columns";
import {
  EMPTY_SELECTION,
  type ProfileRow,
  type SelectionState,
  type TableQuery,
  applySelection,
  filterRows,
  matchesSearch,
  pruneSelection,
  searchTerms,
  selectionKind,
  sortRows,
  visibleRows,
} from "./tableModel";

function row(profile: ReturnType<typeof makeProfile>, running = false): ProfileRow {
  return { profile, running };
}

function query(overrides: Partial<TableQuery> = {}): TableQuery {
  return { view: "all", folderId: null, search: "", tags: [], sort: DEFAULT_SORT, ...overrides };
}

describe("searchTerms", () => {
  it("splits on whitespace and drops the empties", () => {
    expect(searchTerms("  banking   EU ")).toEqual(["banking", "eu"]);
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("matchesSearch", () => {
  const profile = makeProfile({
    name: "Banking EU",
    tags: ["finance", "primary"],
    notes: "Opened for the Berlin account",
    proxyHost: "10.0.0.9",
    proxyPort: 1080,
  });

  it("matches nothing typed", () => {
    expect(matchesSearch(profile, [])).toBe(true);
  });

  it("matches on name, tag, note and proxy alike", () => {
    for (const term of ["banking", "finance", "berlin", "10.0.0.9", "1080"]) {
      expect(matchesSearch(profile, [term]), term).toBe(true);
    }
  });

  it("narrows as terms are added rather than widening", () => {
    // The whole point of a filter box: more typing means fewer rows.
    expect(matchesSearch(profile, ["banking", "berlin"])).toBe(true);
    expect(matchesSearch(profile, ["banking", "tokyo"])).toBe(false);
  });

  it("ignores case on both sides", () => {
    expect(matchesSearch(makeProfile({ name: "ÅRSRAPPORT" }), ["årsrapport"])).toBe(true);
  });

  it("finds the profiles on a direct connection by typing direct", () => {
    // "direct" stands in for the proxy a direct profile does not have, so that
    // "which of these has no proxy" is answerable from the search box.
    expect(matchesSearch(makeProfile({ name: "Plain" }), ["direct"])).toBe(true);
    expect(matchesSearch(makeProfile({ name: "Routed", proxyHost: "10.0.0.9" }), ["direct"])).toBe(false);
  });
});

describe("filterRows", () => {
  const alpha = makeProfile({ name: "Alpha", folderId: "work", tags: ["eu"], favorite: true });
  const beta = makeProfile({ name: "Beta", folderId: "work", tags: ["eu", "primary"] });
  const gamma = makeProfile({ name: "Gamma", folderId: null, tags: [] });
  const rows = [row(alpha), row(beta, true), row(gamma)];

  it("shows everything in the all view", () => {
    expect(filterRows(rows, query())).toHaveLength(3);
  });

  it("keeps only favourites in the favourites view", () => {
    expect(filterRows(rows, query({ view: "favorites" })).map((r) => r.profile.name)).toEqual(["Alpha"]);
  });

  it("keeps only live browsers in the running view", () => {
    expect(filterRows(rows, query({ view: "running" })).map((r) => r.profile.name)).toEqual(["Beta"]);
  });

  it("narrows to one folder", () => {
    expect(filterRows(rows, query({ folderId: "work" })).map((r) => r.profile.name)).toEqual(["Alpha", "Beta"]);
  });

  it("requires every selected tag, not any of them", () => {
    expect(filterRows(rows, query({ tags: ["eu"] })).map((r) => r.profile.name)).toEqual(["Alpha", "Beta"]);
    expect(filterRows(rows, query({ tags: ["eu", "primary"] })).map((r) => r.profile.name)).toEqual(["Beta"]);
  });

  it("combines folder, tag and search rather than letting the last one win", () => {
    const filtered = filterRows(rows, query({ folderId: "work", tags: ["eu"], search: "bet" }));

    expect(filtered.map((r) => r.profile.name)).toEqual(["Beta"]);
  });

  it("returns an empty list rather than everything when nothing matches", () => {
    // A filter that falls back to "show all" reads as though the filter silently
    // failed, which is worse than an empty table saying so.
    expect(filterRows(rows, query({ search: "nothing-matches-this" }))).toEqual([]);
  });
});

describe("sortRows", () => {
  it("orders by name case-insensitively", () => {
    const rows = [row(makeProfile({ name: "zeta" })), row(makeProfile({ name: "Alpha" }))];

    expect(sortRows(rows, DEFAULT_SORT).map((r) => r.profile.name)).toEqual(["Alpha", "zeta"]);
  });

  it("reverses on descending", () => {
    const rows = [row(makeProfile({ name: "Alpha" })), row(makeProfile({ name: "Beta" }))];
    const descending: SortState = { key: "name", direction: "desc" };

    expect(sortRows(rows, descending).map((r) => r.profile.name)).toEqual(["Beta", "Alpha"]);
  });

  it("compares launch counts as numbers, not as strings", () => {
    const rows = [
      row(makeProfile({ name: "Nine", launchCount: 9 })),
      row(makeProfile({ name: "Ten", launchCount: 10 })),
    ];

    expect(sortRows(rows, { key: "launchCount", direction: "asc" }).map((r) => r.profile.name)).toEqual([
      "Nine",
      "Ten",
    ]);
  });

  it("puts running profiles first when sorting by status", () => {
    const rows = [row(makeProfile({ name: "Idle" })), row(makeProfile({ name: "Live" }), true)];

    expect(sortRows(rows, { key: "status", direction: "asc" }).map((r) => r.profile.name)).toEqual([
      "Live",
      "Idle",
    ]);
  });

  it("sorts a never-launched profile below one that has run", () => {
    const rows = [
      row(makeProfile({ name: "Never", lastLaunchedAt: null })),
      row(makeProfile({ name: "Once", lastLaunchedAt: "2026-03-01T00:00:00Z" })),
    ];

    expect(sortRows(rows, { key: "lastLaunchedAt", direction: "desc" }).map((r) => r.profile.name)).toEqual([
      "Once",
      "Never",
    ]);
  });

  it("breaks ties the same way every call, whatever order the sidecar returned", () => {
    // A table that reshuffles on each status poll is unusable even when every
    // row in it is correct.
    const a = makeProfile({ id: "id-a", name: "Same", launchCount: 3 });
    const b = makeProfile({ id: "id-b", name: "Same", launchCount: 3 });
    const sort: SortState = { key: "launchCount", direction: "asc" };

    expect(sortRows([row(a), row(b)], sort).map((r) => r.profile.id)).toEqual(["id-a", "id-b"]);
    expect(sortRows([row(b), row(a)], sort).map((r) => r.profile.id)).toEqual(["id-a", "id-b"]);
  });

  it("leaves the caller's array alone", () => {
    const rows = [row(makeProfile({ name: "Zeta" })), row(makeProfile({ name: "Alpha" }))];
    const original = [...rows];

    sortRows(rows, DEFAULT_SORT);

    expect(rows).toEqual(original);
  });
});

describe("visibleRows", () => {
  it("filters before it sorts", () => {
    const rows = [
      row(makeProfile({ name: "Beta", favorite: true })),
      row(makeProfile({ name: "Alpha", favorite: false })),
      row(makeProfile({ name: "Gamma", favorite: true })),
    ];

    expect(visibleRows(rows, query({ view: "favorites" })).map((r) => r.profile.name)).toEqual([
      "Beta",
      "Gamma",
    ]);
  });
});

describe("pruneSelection", () => {
  it("drops an id that is no longer on screen", () => {
    // Otherwise a bulk delete reaches a row the user filtered away three
    // keystrokes ago and cannot see.
    const visible = [row(makeProfile({ id: "keep" }))];

    expect([...pruneSelection(new Set(["keep", "filtered-away"]), visible)]).toEqual(["keep"]);
  });

  it("returns an empty set when the table is empty", () => {
    expect(pruneSelection(new Set(["a", "b"]), [])).toEqual(new Set());
  });
});

describe("applySelection", () => {
  const rows = ["a", "b", "c", "d"].map((id) => row(makeProfile({ id, name: id.toUpperCase() })));

  function withIds(ids: string[], anchorId: string | null = null): SelectionState {
    return { ids: new Set(ids), anchorId };
  }

  it("toggles a row on and back off", () => {
    const on = applySelection(EMPTY_SELECTION, { type: "toggle", id: "b" }, rows);
    expect([...on.ids]).toEqual(["b"]);

    expect([...applySelection(on, { type: "toggle", id: "b" }, rows).ids]).toEqual([]);
  });

  it("replaces the selection on a plain click", () => {
    const state = applySelection(withIds(["a", "b"]), { type: "replace", id: "d" }, rows);

    expect([...state.ids]).toEqual(["d"]);
    expect(state.anchorId).toBe("d");
  });

  it("selects a range from the anchor", () => {
    const state = applySelection(withIds(["b"], "b"), { type: "range", id: "d" }, rows);

    expect([...state.ids].sort()).toEqual(["b", "c", "d"]);
  });

  it("selects the same range in either direction", () => {
    const forward = applySelection(withIds(["b"], "b"), { type: "range", id: "d" }, rows);
    const backward = applySelection(withIds(["d"], "d"), { type: "range", id: "b" }, rows);

    expect([...forward.ids].sort()).toEqual([...backward.ids].sort());
  });

  it("keeps the anchor so a range can be dragged back and forth", () => {
    const grown = applySelection(withIds(["a"], "a"), { type: "range", id: "d" }, rows);

    expect(grown.anchorId).toBe("a");
    expect([...applySelection(grown, { type: "range", id: "b" }, rows).ids].sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("falls back to a single row when there is no anchor to measure from", () => {
    const state = applySelection(EMPTY_SELECTION, { type: "range", id: "c" }, rows);

    expect([...state.ids]).toEqual(["c"]);
    expect(state.anchorId).toBe("c");
  });

  it("ignores a range to a row that is no longer visible", () => {
    const state = withIds(["a"], "a");

    expect(applySelection(state, { type: "range", id: "gone" }, rows)).toBe(state);
  });

  it("selects every visible row, and only the visible ones", () => {
    const visible = rows.slice(0, 2);

    expect([...applySelection(EMPTY_SELECTION, { type: "all" }, visible).ids].sort()).toEqual(["a", "b"]);
  });

  it("turns a full selection back off, so the header checkbox is not a one-way trap", () => {
    const all = applySelection(EMPTY_SELECTION, { type: "all" }, rows);

    expect([...applySelection(all, { type: "all" }, rows).ids]).toEqual([]);
  });

  it("selects all when only some rows are ticked", () => {
    const some = withIds(["a"]);

    expect(applySelection(some, { type: "all" }, rows).ids.size).toBe(4);
  });

  it("clears everything", () => {
    expect(applySelection(withIds(["a", "b"], "a"), { type: "clear" }, rows)).toEqual(EMPTY_SELECTION);
  });
});

describe("selectionKind", () => {
  const rows = ["a", "b"].map((id) => row(makeProfile({ id })));

  it("reports none, some and all", () => {
    expect(selectionKind(new Set(), rows)).toBe("none");
    expect(selectionKind(new Set(["a"]), rows)).toBe("some");
    expect(selectionKind(new Set(["a", "b"]), rows)).toBe("all");
  });

  it("reports none for an empty table even when ids linger", () => {
    // An empty table whose header checkbox shows "all" is a lie about zero rows.
    expect(selectionKind(new Set(["a"]), [])).toBe("none");
  });
});
