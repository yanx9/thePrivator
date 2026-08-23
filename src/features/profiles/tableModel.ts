import type { ProfileRecord } from "../../sidecar/types";
import type { ProfileView } from "../../app/routes";
import { SORT_READERS, type SortState } from "./columns";

/**
 * The table's model, as pure functions.
 *
 * None of this touches the DOM, so the rules that decide what a user sees are
 * tested directly rather than through a rendered grid. That matters most for the
 * filter: "my profile disappeared" is the report these rules produce when they
 * are wrong, and it is indistinguishable from data loss to the person filing it.
 */

export interface ProfileRow {
  profile: ProfileRecord;
  running: boolean;
}

export interface TableQuery {
  view: ProfileView;
  folderId: string | null;
  search: string;
  tags: readonly string[];
  sort: SortState;
}

/**
 * Split the search box into terms.
 *
 * Terms are ANDed, so typing more narrows rather than widens -- the behaviour a
 * user expects from a filter box even though a single fuzzy match is easier to
 * write.
 */
export function searchTerms(search: string): string[] {
  return search
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function haystack(profile: ProfileRecord): string {
  const proxy = profile.proxy.mode === "fixedServer" ? `${profile.proxy.host}:${profile.proxy.port}` : "direct";
  return [profile.name, proxy, profile.organization.notes, ...profile.organization.tags]
    .join("\n")
    .toLocaleLowerCase();
}

export function matchesSearch(profile: ProfileRecord, terms: readonly string[]): boolean {
  if (terms.length === 0) {
    return true;
  }
  const text = haystack(profile);
  return terms.every((term) => text.includes(term));
}

function matchesView(row: ProfileRow, view: ProfileView): boolean {
  switch (view) {
    case "favorites":
      return row.profile.organization.favorite;
    case "running":
      return row.running;
    case "trash":
      // Trashed profiles are absent from the profiles array entirely; the trash
      // view is fed from profiles.trash.list, so nothing here should be trashed.
      return row.profile.lifecycle.deletedAt !== null;
    case "all":
      return true;
  }
}

export function filterRows(rows: readonly ProfileRow[], query: TableQuery): ProfileRow[] {
  const terms = searchTerms(query.search);
  return rows.filter((row) => {
    if (!matchesView(row, query.view)) {
      return false;
    }
    if (query.folderId !== null && row.profile.organization.folderId !== query.folderId) {
      return false;
    }
    if (query.tags.length > 0 && !query.tags.every((tag) => row.profile.organization.tags.includes(tag))) {
      return false;
    }
    return matchesSearch(row.profile, terms);
  });
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return String(a).localeCompare(String(b));
}

export function sortRows(rows: readonly ProfileRow[], sort: SortState): ProfileRow[] {
  const reader = SORT_READERS[sort.key];
  const sorted = [...rows];
  const sign = sort.direction === "asc" ? 1 : -1;

  sorted.sort((left, right) => {
    if (sort.key === "status" && left.running !== right.running) {
      // Running first when ascending: the rows a user is most likely to act on.
      return left.running ? -sign : sign;
    }
    if (reader !== undefined) {
      const compared = compareValues(reader(left.profile), reader(right.profile));
      if (compared !== 0) {
        return compared * sign;
      }
    }
    // Ties break on name and then id, so the order never depends on the order the
    // sidecar happened to return -- a table that reshuffles on every poll is
    // unusable even when every row is correct.
    const byName = left.profile.name.localeCompare(right.profile.name);
    return byName !== 0 ? byName : left.profile.id.localeCompare(right.profile.id);
  });

  return sorted;
}

export function visibleRows(rows: readonly ProfileRow[], query: TableQuery): ProfileRow[] {
  return sortRows(filterRows(rows, query), query.sort);
}

/**
 * Drop ids that are no longer on screen.
 *
 * A selection that outlives its rows is how a bulk action hits a profile the user
 * cannot see -- deleting from a filtered table and catching a row filtered out
 * three keystrokes ago.
 */
export function pruneSelection(selection: ReadonlySet<string>, rows: readonly ProfileRow[]): Set<string> {
  const present = new Set(rows.map((row) => row.profile.id));
  const pruned = new Set<string>();
  for (const id of selection) {
    if (present.has(id)) {
      pruned.add(id);
    }
  }
  return pruned;
}

export type SelectionIntent =
  | { type: "toggle"; id: string }
  | { type: "replace"; id: string }
  | { type: "range"; id: string }
  | { type: "all" }
  | { type: "clear" };

export interface SelectionState {
  ids: ReadonlySet<string>;
  /** The row a shift-click measures from. */
  anchorId: string | null;
}

export const EMPTY_SELECTION: SelectionState = { ids: new Set(), anchorId: null };

export function applySelection(
  state: SelectionState,
  intent: SelectionIntent,
  rows: readonly ProfileRow[],
): SelectionState {
  switch (intent.type) {
    case "clear":
      return EMPTY_SELECTION;
    case "all": {
      const all = new Set(rows.map((row) => row.profile.id));
      // A header checkbox that only ever selects is a trap once every row is
      // already ticked, so a full selection toggles back off.
      if (all.size > 0 && all.size === state.ids.size && rows.every((row) => state.ids.has(row.profile.id))) {
        return EMPTY_SELECTION;
      }
      return { ids: all, anchorId: state.anchorId };
    }
    case "replace":
      return { ids: new Set([intent.id]), anchorId: intent.id };
    case "toggle": {
      const ids = new Set(state.ids);
      if (ids.has(intent.id)) {
        ids.delete(intent.id);
      } else {
        ids.add(intent.id);
      }
      return { ids, anchorId: intent.id };
    }
    case "range": {
      const anchorIndex = rows.findIndex((row) => row.profile.id === state.anchorId);
      const targetIndex = rows.findIndex((row) => row.profile.id === intent.id);
      if (targetIndex === -1) {
        return state;
      }
      if (anchorIndex === -1) {
        return { ids: new Set([intent.id]), anchorId: intent.id };
      }
      const from = Math.min(anchorIndex, targetIndex);
      const to = Math.max(anchorIndex, targetIndex);
      const ids = new Set(state.ids);
      for (const row of rows.slice(from, to + 1)) {
        ids.add(row.profile.id);
      }
      // The anchor stays put so dragging a shift-selection back and forth grows
      // and shrinks from the same end.
      return { ids, anchorId: state.anchorId };
    }
  }
}

export type SelectionKind = "none" | "some" | "all";

export function selectionKind(selection: ReadonlySet<string>, rows: readonly ProfileRow[]): SelectionKind {
  if (rows.length === 0 || selection.size === 0) {
    return "none";
  }
  return rows.every((row) => selection.has(row.profile.id)) ? "all" : "some";
}
