import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ProfileRecord } from "../../sidecar/types";
import {
  type ColumnDescriptor,
  type ColumnKey,
  type ColumnLayout,
  type SortState,
  clampWidth,
  columnByKey,
  gridTemplate,
  visibleColumns,
} from "./columns";
import { type ProfileRow, type SelectionIntent, selectionKind } from "./tableModel";
import styles from "./ProfileTable.module.css";
import { ProxyExit, type ProxyCheckState } from "./ProxyExit";

export interface FolderName {
  id: string;
  name: string;
}

interface ProfileTableProps {
  rows: readonly ProfileRow[];
  layout: ColumnLayout;
  sort: SortState;
  selection: ReadonlySet<string>;
  folderNames: ReadonlyMap<string, string>;
  /** Ids with a mutation in flight, so their row can say so instead of looking idle. */
  busyIds: ReadonlySet<string>;
  onSort: (key: ColumnKey) => void;
  onResize: (key: ColumnKey, width: number) => void;
  onSelect: (intent: SelectionIntent) => void;
  onOpen: (id: string) => void;
  onLaunch: (id: string) => void;
  onStop: (id: string) => void;
  onRowMenu: (id: string, position: { x: number; y: number }) => void;
  emptyMessage: string;
  onSaveNotes?: (id: string, notes: string) => Promise<boolean>;
  proxyChecks?: ReadonlyMap<string, ProxyCheckState>;
  onCheckProxy?: (id: string) => void;
}

function formatTimestamp(value: string | null): string {
  if (value === null) {
    return "Never";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Unknown";
  }
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fingerprintLabel(profile: ProfileRecord): string {
  return profile.defaults.fingerprintMode === "managed" ? "Managed" : "Off";
}

/** Deterministic hue per tag, so a tag keeps its colour across profiles and sessions. */
function tagHue(tag: string): number {
  let hash = 0;
  for (let index = 0; index < tag.length; index += 1) {
    hash = (hash * 31 + tag.charCodeAt(index)) % 6;
  }
  return hash + 1;
}

interface CellProps {
  onSaveNotes?: (id: string, notes: string) => Promise<boolean>;
  proxyCheck?: ProxyCheckState;
  onCheckProxy?: (id: string) => void;
  row: ProfileRow;
  column: ColumnDescriptor;
  folderNames: ReadonlyMap<string, string>;
  selected: boolean;
  busy: boolean;
  onSelect: (intent: SelectionIntent) => void;
  onOpen: (id: string) => void;
  onLaunch: (id: string) => void;
  onStop: (id: string) => void;
}

function NotesCell({ profile, busy, onSaveNotes }: { profile: ProfileRecord; busy: boolean; onSaveNotes: NonNullable<CellProps["onSaveNotes"]> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? profile.organization.notes;
  const dirty = draft !== null && draft !== profile.organization.notes;
  return <div className={styles.notesEditor} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <textarea aria-label={`Notes for ${profile.name}`} value={value} maxLength={1500} rows={1} disabled={busy}
      placeholder="Add notes…" onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setDraft(null); } }} />
    {dirty ? <span>
      <button type="button" disabled={busy} aria-label={`Save notes for ${profile.name}`} onClick={() => {
        void onSaveNotes(profile.id, value).then((saved) => { if (saved) setDraft(null); });
      }}>Save</button>
      <button type="button" disabled={busy} aria-label={`Cancel notes for ${profile.name}`} onClick={() => setDraft(null)}>Cancel</button>
    </span> : null}
  </div>;
}

function Cell({ row, column, folderNames, selected, busy, onSelect, onOpen, onLaunch, onStop, proxyCheck, onCheckProxy, onSaveNotes }: CellProps) {
  const { profile, running } = row;

  switch (column.key) {
    case "select":
      return (
        <div className={styles.cell} role="gridcell" data-column="select">
          <input
            type="checkbox"
            checked={selected}
            aria-label={`Select ${profile.name}`}
            onChange={() => onSelect({ type: "toggle", id: profile.id })}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      );
    case "status":
      return (
        <div className={styles.cell} role="gridcell" data-column="status">
          <span
            className={styles.statusDot}
            data-running={running}
            data-busy={busy}
            role="img"
            aria-label={busy ? "Working" : running ? "Running" : "Stopped"}
          />
        </div>
      );
    case "name":
      return (
        <div className={styles.cell} role="gridcell">
          <button type="button" className={styles.nameButton} onClick={() => onOpen(profile.id)}>
            {profile.organization.favorite ? (
              <span className={styles.favorite} role="img" aria-label="Favorite">
                ★
              </span>
            ) : null}
            <span className={styles.nameText}>{profile.name}</span>
          </button>
        </div>
      );
    case "folder": {
      const folderId = profile.organization.folderId;
      const name = folderId === null ? null : (folderNames.get(folderId) ?? "Unknown folder");
      return (
        <div className={styles.cell} role="gridcell">
          <span className={name === null ? styles.muted : undefined}>{name ?? "—"}</span>
        </div>
      );
    }
    case "tags":
      return (
        <div className={styles.cell} role="gridcell">
          {profile.organization.tags.length === 0 ? (
            <span className={styles.muted}>—</span>
          ) : (
            <span className={styles.tagList}>
              {profile.organization.tags.map((tag) => (
                <span key={tag} className={styles.tag} data-hue={tagHue(tag)}>
                  {tag}
                </span>
              ))}
            </span>
          )}
        </div>
      );
    case "proxy":
      return (
        <div className={styles.cell} role="gridcell">
          {profile.lifecycle.deletedAt !== null && profile.proxy.mode === "fixedServer" ? (
            <span className={styles.muted}>Restore profile to check proxy</span>
          ) : (
            <ProxyExit direct={profile.proxy.mode === "direct"} state={proxyCheck} onCheck={onCheckProxy ? () => onCheckProxy(profile.id) : undefined} />
          )}
        </div>
      );
    case "fingerprint":
      return (
        <div className={styles.cell} role="gridcell">
          <span className={profile.defaults.fingerprintMode === "managed" ? undefined : styles.muted}>
            {fingerprintLabel(profile)}
          </span>
        </div>
      );
    case "notes":
      return (
        <div className={styles.cell} role="gridcell">
          {onSaveNotes && profile.lifecycle.deletedAt === null
            ? <NotesCell profile={profile} busy={busy} onSaveNotes={onSaveNotes} />
            : <span className={styles.truncate}>{profile.organization.notes || "—"}</span>}
        </div>
      );
    case "lastLaunchedAt":
      return (
        <div className={styles.cell} role="gridcell">
          <span className={profile.lifecycle.lastLaunchedAt === null ? styles.muted : undefined}>
            {formatTimestamp(profile.lifecycle.lastLaunchedAt)}
          </span>
        </div>
      );
    case "launchCount":
      return (
        <div className={styles.cell} role="gridcell" data-align="end">
          {profile.lifecycle.launchCount}
        </div>
      );
    case "createdAt":
      return (
        <div className={styles.cell} role="gridcell">
          {formatTimestamp(profile.createdAt)}
        </div>
      );
    case "updatedAt":
      return (
        <div className={styles.cell} role="gridcell">
          {formatTimestamp(profile.updatedAt)}
        </div>
      );
    case "actions":
      return (
        <div className={styles.cell} role="gridcell" data-column="actions">
          <button
            type="button"
            className={styles.rowAction}
            data-variant={running ? "stop" : "launch"}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              if (running) {
                onStop(profile.id);
              } else {
                onLaunch(profile.id);
              }
            }}
          >
            {running ? "Stop" : "Launch"}
          </button>
        </div>
      );
  }
}

interface RowProps extends Omit<CellProps, "column"> {
  columns: readonly ColumnDescriptor[];
  rowIndex: number;
  onRowMenu: (id: string, position: { x: number; y: number }) => void;
}

/**
 * One row.
 *
 * Memoised on purpose: the status poll rewrites the runtime map several times a
 * minute, and without this every tick re-renders every row in a 500-row table.
 */
const Row = memo(function Row({ row, columns, rowIndex, onRowMenu, ...cellProps }: RowProps) {
  const { profile } = row;

  return (
    <div
      className={styles.row}
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={cellProps.selected}
      data-selected={cellProps.selected}
      onClick={(event) => {
        if (event.shiftKey) {
          cellProps.onSelect({ type: "range", id: profile.id });
        } else if (event.ctrlKey || event.metaKey) {
          cellProps.onSelect({ type: "toggle", id: profile.id });
        } else {
          cellProps.onSelect({ type: "replace", id: profile.id });
        }
      }}
      onDoubleClick={() => cellProps.onOpen(profile.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        onRowMenu(profile.id, { x: event.clientX, y: event.clientY });
      }}
    >
      {columns.map((column) => (
        <Cell key={column.key} column={column} row={row} {...cellProps} />
      ))}
    </div>
  );
});

interface HeaderCellProps {
  column: ColumnDescriptor;
  width: number;
  sort: SortState;
  headerSelection: ReturnType<typeof selectionKind>;
  onSort: (key: ColumnKey) => void;
  onResize: (key: ColumnKey, width: number) => void;
  onSelect: (intent: SelectionIntent) => void;
}

function HeaderCell({ column, width, sort, headerSelection, onSort, onResize, onSelect }: HeaderCellProps) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  const active = sort.key === column.key;

  useEffect(() => {
    if (checkboxRef.current !== null) {
      // "some rows selected" has no HTML attribute; it only exists as a property.
      checkboxRef.current.indeterminate = headerSelection === "some";
    }
  }, [headerSelection]);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLSpanElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startWidth = width;
      const cell = handle.closest<HTMLElement>("[data-header-cell]");
      const grid = handle.closest<HTMLElement>("[data-grid]");
      handle.setPointerCapture(event.pointerId);

      // The drag writes straight to the DOM and commits once on release: routing
      // every pointermove through React re-renders the whole table per frame,
      // which is what made the previous grid stutter while resizing.
      const move = (moveEvent: PointerEvent) => {
        const next = clampWidth(column, startWidth + (moveEvent.clientX - startX));
        if (cell !== null) {
          cell.style.width = `${next}px`;
        }
        if (grid !== null) {
          grid.style.setProperty("--resizing-width", `${next}px`);
        }
      };

      const finish = (upEvent: PointerEvent) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        if (cell !== null) {
          cell.style.removeProperty("width");
        }
        if (grid !== null) {
          grid.style.removeProperty("--resizing-width");
        }
        onResize(column.key, clampWidth(column, startWidth + (upEvent.clientX - startX)));
      };

      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", finish);
      // Without this a cancelled drag (a browser gesture, a lost pointer) leaves
      // the listeners attached and the column stuck mid-resize.
      handle.addEventListener("pointercancel", finish);
    },
    [column, onResize, width],
  );

  return (
    <div
      className={styles.headerCell}
      role="columnheader"
      data-header-cell={column.key}
      data-align={column.align ?? "start"}
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
    >
      {column.key === "select" ? (
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={headerSelection === "all"}
          aria-label="Select all profiles"
          onChange={() => onSelect({ type: "all" })}
        />
      ) : column.sortable ? (
        <button type="button" className={styles.headerButton} onClick={() => onSort(column.key)}>
          {/* A sortable column with no visible label still needs a spoken one,
              but rendering it visibly is how "Status" became "S..." in a 40px
              column that was never meant to show text. */}
          <span className={column.label.length > 0 ? undefined : styles.srOnly}>
            {column.label.length > 0 ? column.label : column.srLabel}
          </span>
          <span className={styles.sortGlyph} aria-hidden="true">
            {active ? (sort.direction === "asc" ? "▲" : "▼") : ""}
          </span>
        </button>
      ) : (
        <span className={column.label.length > 0 ? undefined : styles.srOnly}>
          {column.label.length > 0 ? column.label : column.srLabel}
        </span>
      )}

      {column.locked === true ? null : (
        <span
          className={styles.resizeHandle}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${column.label}`}
          onPointerDown={startResize}
        />
      )}
    </div>
  );
}

export function ProfileTable({
  rows,
  layout,
  sort,
  selection,
  folderNames,
  busyIds,
  onSort,
  onResize,
  onSelect,
  onOpen,
  onLaunch,
  onStop,
  onRowMenu,
  emptyMessage,
  onSaveNotes,
  proxyChecks,
  onCheckProxy,
}: ProfileTableProps) {
  // Checking `typeof CSS` alone is not enough: an environment can expose CSS
  // without supports(), and content-visibility does nothing when unsupported
  // rather than falling back, so the row rule stays off unless it is real.
  const [supportsContentVisibility] = useState(
    () =>
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("content-visibility", "auto"),
  );
  // Both memoised on the layout: a fresh array or map here would give every row
  // a new prop identity on each status tick, and the row memo below would be
  // decorative rather than load-bearing. Measured -- without this a change to one
  // profile's runtime re-renders every row in the table.
  const entries = useMemo(() => visibleColumns(layout), [layout]);
  const columns = useMemo(() => entries.map((entry) => columnByKey(entry.key)), [entries]);
  const headerSelection = selectionKind(selection, rows);
  const template = useMemo(() => gridTemplate(layout), [layout]);

  return (
    <div
      className={styles.grid}
      data-grid=""
      role="grid"
      aria-label="Profiles"
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length}
      // One variable drives every track, so a resize never has to touch a cell.
      style={{ "--grid-cols": template } as React.CSSProperties}
      data-content-visibility={supportsContentVisibility}
    >
      <div className={styles.headerRow} role="row" aria-rowindex={1}>
        {entries.map((entry) => (
          <HeaderCell
            key={entry.key}
            column={columnByKey(entry.key)}
            width={entry.width}
            sort={sort}
            headerSelection={headerSelection}
            onSort={onSort}
            onResize={onResize}
            onSelect={onSelect}
          />
        ))}
      </div>

      {rows.length === 0 ? (
        <p className={styles.empty}>{emptyMessage}</p>
      ) : (
        rows.map((row, index) => (
          <Row
            key={row.profile.id}
            row={row}
            columns={columns}
            rowIndex={index + 2}
            folderNames={folderNames}
            selected={selection.has(row.profile.id)}
            busy={busyIds.has(row.profile.id)}
            proxyCheck={proxyChecks?.get(row.profile.id)}
            onCheckProxy={onCheckProxy}
            onSelect={onSelect}
            onOpen={onOpen}
            onLaunch={onLaunch}
            onStop={onStop}
            onRowMenu={onRowMenu}
            onSaveNotes={onSaveNotes}
          />
        ))
      )}
    </div>
  );
}
