import type { ProfileRecord } from "../../sidecar/types";

/**
 * Columns are data, not markup.
 *
 * The table this replaces spread each field across a header cell, a body cell and
 * a width rule that had to be kept in step by hand, which is why the old card had
 * 57 props. Here a column is one entry: adding one is an entry, hiding one is a
 * boolean, and the whole layout is a single `--grid-cols` string the grid reads.
 */
export type ColumnKey =
  | "select"
  | "status"
  | "name"
  | "folder"
  | "tags"
  | "proxy"
  | "fingerprint"
  | "notes"
  | "lastLaunchedAt"
  | "launchCount"
  | "createdAt"
  | "updatedAt"
  | "actions";

export type ColumnAlign = "start" | "end";

export interface ColumnDescriptor {
  key: ColumnKey;
  /** Header text. Empty for the checkbox and row-action columns, which are labelled instead. */
  label: string;
  /** Spoken header, for columns whose visible label is empty or an icon. */
  srLabel?: string;
  defaultWidth: number;
  minWidth: number;
  align?: ColumnAlign;
  sortable: boolean;
  /** A column the user cannot hide, because hiding it would leave the row unusable. */
  locked?: boolean;
  /** Hidden until the user turns it on, so the default table stays readable. */
  hiddenByDefault?: boolean;
}

export const COLUMNS: readonly ColumnDescriptor[] = [
  { key: "select", label: "", srLabel: "Select", defaultWidth: 36, minWidth: 36, sortable: false, locked: true },
  { key: "status", label: "", srLabel: "Status", defaultWidth: 40, minWidth: 40, sortable: true, locked: true },
  { key: "name", label: "Name", defaultWidth: 260, minWidth: 120, sortable: true, locked: true },
  { key: "folder", label: "Folder", defaultWidth: 140, minWidth: 80, sortable: true },
  { key: "tags", label: "Tags", defaultWidth: 180, minWidth: 80, sortable: false },
  { key: "proxy", label: "Proxy", defaultWidth: 200, minWidth: 100, sortable: true },
  { key: "fingerprint", label: "Fingerprint", defaultWidth: 140, minWidth: 90, sortable: true },
  { key: "notes", label: "Notes", defaultWidth: 220, minWidth: 100, sortable: false, hiddenByDefault: true },
  { key: "lastLaunchedAt", label: "Last launched", defaultWidth: 150, minWidth: 110, sortable: true },
  {
    key: "launchCount",
    label: "Launches",
    defaultWidth: 90,
    minWidth: 70,
    align: "end",
    sortable: true,
    hiddenByDefault: true,
  },
  { key: "createdAt", label: "Created", defaultWidth: 150, minWidth: 110, sortable: true, hiddenByDefault: true },
  { key: "updatedAt", label: "Updated", defaultWidth: 150, minWidth: 110, sortable: true, hiddenByDefault: true },
  { key: "actions", label: "", srLabel: "Actions", defaultWidth: 88, minWidth: 88, sortable: false, locked: true },
];

const COLUMNS_BY_KEY = new Map(COLUMNS.map((column) => [column.key, column]));

export function columnByKey(key: ColumnKey): ColumnDescriptor {
  const column = COLUMNS_BY_KEY.get(key);
  if (column === undefined) {
    throw new Error(`unknown column: ${key}`);
  }
  return column;
}

export interface ColumnLayoutEntry {
  key: ColumnKey;
  visible: boolean;
  width: number;
}

export type ColumnLayout = readonly ColumnLayoutEntry[];

export function defaultLayout(): ColumnLayout {
  return COLUMNS.map((column) => ({
    key: column.key,
    visible: column.hiddenByDefault !== true,
    width: column.defaultWidth,
  }));
}

/**
 * Rebuild a stored layout against the columns this build knows about.
 *
 * A layout outlives the code that wrote it: it comes back from preferences after
 * an update that added or removed a column, and on a synced machine it may have
 * been written by a different version entirely. Dropping unknown keys and
 * appending missing ones means a stale layout degrades to a usable table instead
 * of a table missing its Name column.
 */
export function reconcileLayout(stored: unknown): ColumnLayout {
  const entries = Array.isArray(stored) ? stored : [];
  const seen = new Set<ColumnKey>();
  const reconciled: ColumnLayoutEntry[] = [];

  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const candidate = raw as { key?: unknown; visible?: unknown; width?: unknown };
    if (typeof candidate.key !== "string") {
      continue;
    }
    const column = COLUMNS_BY_KEY.get(candidate.key as ColumnKey);
    if (column === undefined || seen.has(column.key)) {
      continue;
    }
    seen.add(column.key);
    reconciled.push({
      key: column.key,
      visible: column.locked === true ? true : candidate.visible !== false,
      width: clampWidth(column, typeof candidate.width === "number" ? candidate.width : column.defaultWidth),
    });
  }

  for (const column of COLUMNS) {
    if (!seen.has(column.key)) {
      reconciled.push({
        key: column.key,
        visible: column.hiddenByDefault !== true,
        width: column.defaultWidth,
      });
    }
  }

  return reconciled;
}

export const MAX_COLUMN_WIDTH = 640;

export function clampWidth(column: ColumnDescriptor, width: number): number {
  if (!Number.isFinite(width)) {
    return column.defaultWidth;
  }
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(column.minWidth, width)));
}

export function visibleColumns(layout: ColumnLayout): ColumnLayoutEntry[] {
  return layout.filter((entry) => entry.visible);
}

/**
 * The grid template.
 *
 * Every visible column is a fixed pixel track except Name, which takes the slack
 * so the table fills the window at any width without a resize observer.
 */
export function gridTemplate(layout: ColumnLayout): string {
  return visibleColumns(layout)
    .map((entry) => (entry.key === "name" ? `minmax(${entry.width}px, 1fr)` : `${entry.width}px`))
    .join(" ");
}

export function setColumnVisible(layout: ColumnLayout, key: ColumnKey, visible: boolean): ColumnLayout {
  return layout.map((entry) =>
    entry.key === key && columnByKey(key).locked !== true ? { ...entry, visible } : entry,
  );
}

export function setColumnWidth(layout: ColumnLayout, key: ColumnKey, width: number): ColumnLayout {
  return layout.map((entry) =>
    entry.key === key ? { ...entry, width: clampWidth(columnByKey(key), width) } : entry,
  );
}

/** Move a column to a new index, keeping locked columns pinned to their ends. */
export function moveColumn(layout: ColumnLayout, key: ColumnKey, toIndex: number): ColumnLayout {
  const fromIndex = layout.findIndex((entry) => entry.key === key);
  if (fromIndex === -1 || columnByKey(key).locked === true) {
    return layout;
  }
  const firstMovable = layout.findIndex((entry) => columnByKey(entry.key).locked !== true);
  const lastMovable = layout.reduce(
    (last, entry, index) => (columnByKey(entry.key).locked !== true ? index : last),
    firstMovable,
  );
  const target = Math.min(lastMovable, Math.max(firstMovable, toIndex));
  if (target === fromIndex) {
    return layout;
  }
  const next = [...layout];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(target, 0, moved);
  return next;
}

export type SortDirection = "asc" | "desc";

export interface SortState {
  key: ColumnKey;
  direction: SortDirection;
}

export const DEFAULT_SORT: SortState = { key: "name", direction: "asc" };

/**
 * Clicking a header cycles ascending, descending, and back to the default.
 *
 * The third state matters: without it there is no way back to the order the table
 * opened in, and "sorted by something I clicked twenty minutes ago" is how a user
 * ends up convinced a profile went missing.
 */
export function nextSort(current: SortState, key: ColumnKey): SortState {
  if (!columnByKey(key).sortable) {
    return current;
  }
  if (current.key !== key) {
    return { key, direction: "asc" };
  }
  if (current.direction === "asc") {
    return { key, direction: "desc" };
  }
  return DEFAULT_SORT;
}

export type ProfileFieldReader = (profile: ProfileRecord) => string | number;

/** How each sortable column reads its value. Sorting never touches the DOM. */
export const SORT_READERS: Partial<Record<ColumnKey, ProfileFieldReader>> = {
  name: (profile) => profile.name.toLocaleLowerCase(),
  folder: (profile) => profile.organization.folderId ?? "",
  proxy: (profile) => profile.proxy.mode,
  fingerprint: (profile) => profile.defaults.fingerprintMode,
  lastLaunchedAt: (profile) => profile.lifecycle.lastLaunchedAt ?? "",
  launchCount: (profile) => profile.lifecycle.launchCount,
  createdAt: (profile) => profile.createdAt,
  updatedAt: (profile) => profile.updatedAt,
};
