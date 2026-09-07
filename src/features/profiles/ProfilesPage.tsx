import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { pickFile, pickSaveTarget } from "../../dialogs";
import type { ProfileView } from "../../app/routes";
import {
  bulkLaunchChromiumProfiles,
  bulkStopChromiumProfiles,
  deleteProfile,
  exportProfileCookies,
  replaceProfileCookies,
  launchChromiumProfile,
  normalizeSidecarError,
  purgeProfile,
  restoreProfile,
  stopChromiumProfile,
} from "../../sidecar/client";
import type { SidecarClientError } from "../../sidecar/types";
import { CookieBotDialog } from "./CookieBotDialog";
import { ColumnManager } from "./ColumnManager";
import { ProfileTable } from "./ProfileTable";
import { RowMenu } from "./RowMenu";
import {
  type ColumnKey,
  type ColumnLayout,
  DEFAULT_SORT,
  defaultLayout,
  nextSort,
  setColumnWidth,
} from "./columns";
import { type RowAction, buildRowMenu, requiresConfirmation } from "./rowMenu";
import {
  EMPTY_SELECTION,
  type ProfileRow,
  type SelectionIntent,
  type SelectionState,
  applySelection,
  pruneSelection,
  visibleRows,
} from "./tableModel";
import type { ProfileData } from "./useProfileData";
import styles from "./ProfilesPage.module.css";

interface ProfilesPageProps {
  view: ProfileView;
  folderId: string | null;
  search: string;
  folderNames: ReadonlyMap<string, string>;
  /**
   * The library, loaded once by the composition root.
   *
   * It is handed down rather than fetched here because the sidebar counts the
   * same profiles this table lists. Two independent loaders would poll twice and
   * could disagree -- which is exactly what "7 profiles" beside a sidebar
   * reading zero looked like.
   */
  data: ProfileData;
  onOpenProfile: (id: string) => void;
  onNewProfile: () => void;
}

interface MenuState {
  profileId: string;
  x: number;
  y: number;
}

interface ConfirmState {
  action: RowAction;
  ids: string[];
  title: string;
  body: string;
  confirmLabel: string;
}

const EMPTY_MESSAGES: Record<ProfileView, string> = {
  all: "No profiles yet. Create one to get started.",
  favorites: "No favorites yet. Star a profile to keep it here.",
  running: "No profile is running right now.",
  trash: "The trash is empty.",
};

/**
 * Track which profiles have a mutation in flight.
 *
 * The previous UI held a single global "busy" flag, so launching one profile
 * locked every other row -- which does not survive bulk actions at all. A set
 * keeps the block where it belongs: on the rows actually being changed.
 */
type BusyAction = { type: "start"; ids: string[] } | { type: "finish"; ids: string[] };

function busyReducer(state: ReadonlySet<string>, action: BusyAction): ReadonlySet<string> {
  const next = new Set(state);
  for (const id of action.ids) {
    if (action.type === "start") {
      next.add(id);
    } else {
      next.delete(id);
    }
  }
  return next;
}

export function ProfilesPage({
  view,
  folderId,
  search,
  folderNames,
  data,
  onOpenProfile,
  onNewProfile,
}: ProfilesPageProps) {
  const { rows, trashed, loading, error, refresh } = data;

  const [layout, setLayout] = useState<ColumnLayout>(defaultLayout);
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [cookieBot, setCookieBot] = useState<{ id: string; name: string } | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [busyIds, dispatchBusy] = useReducer(busyReducer, new Set<string>() as ReadonlySet<string>);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const activeIds = useRef(new Set<string>());
  const [actionError, setActionError] = useState<SidecarClientError | null>(null);

  const sourceRows = useMemo<ProfileRow[]>(
    () => (view === "trash" ? trashed.map((profile) => ({ profile, running: false })) : rows),
    [view, trashed, rows],
  );

  const shown = useMemo(
    () => visibleRows(sourceRows, { view, folderId, search, tags: [], sort }),
    [sourceRows, view, folderId, search, sort],
  );

  // A selection that outlives its rows would let a bulk action reach a profile
  // the user filtered away and can no longer see.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    setSelection((current) => {
      const pruned = pruneSelection(current.ids, shownRef.current);
      return pruned.size === current.ids.size ? current : { ids: pruned, anchorId: current.anchorId };
    });
  }, [shown]);

  const runFor = useCallback(
    async (ids: string[], work: () => Promise<unknown>) => {
      if (ids.some((id) => activeIds.current.has(id))) return;
      ids.forEach((id) => activeIds.current.add(id));
      setActionNote(null);
      dispatchBusy({ type: "start", ids });
      setActionError(null);
      try {
        await work();
      } catch (caught) {
        setActionError(normalizeSidecarError(caught));
      } finally {
        ids.forEach((id) => activeIds.current.delete(id));
        dispatchBusy({ type: "finish", ids });
        refresh();
      }
    },
    [refresh],
  );

  const onLaunch = useCallback(
    (id: string) => void runFor([id], () => launchChromiumProfile(id)),
    [runFor],
  );
  const onStop = useCallback((id: string) => void runFor([id], () => stopChromiumProfile(id)), [runFor]);
  const onSelect = useCallback(
    (intent: SelectionIntent) => setSelection((current) => applySelection(current, intent, shownRef.current)),
    [],
  );
  const onSort = useCallback((key: ColumnKey) => setSort((current) => nextSort(current, key)), []);
  const onResize = useCallback(
    (key: ColumnKey, width: number) => setLayout((current) => setColumnWidth(current, key, width)),
    [],
  );
  const onRowMenu = useCallback((id: string, position: { x: number; y: number }) => {
    setMenu({ profileId: id, x: position.x, y: position.y });
  }, []);

  const selectedIds = useMemo(
    () => shown.filter((row) => selection.ids.has(row.profile.id)).map((row) => row.profile.id),
    [shown, selection],
  );
  const runningSelected = useMemo(
    () => shown.filter((row) => selection.ids.has(row.profile.id) && row.running).length,
    [shown, selection],
  );

  const performAction = useCallback(
    (action: RowAction, ids: string[]) => {
      switch (action) {
        case "cookies-export-json":
        case "cookies-export-netscape":
          return runFor(ids, async () => {
            const netscape = action === "cookies-export-netscape";
            const destination = await pickSaveTarget(netscape ? "Export cookies as cookies.txt" : "Export cookies as JSON", [
              { name: netscape ? "Netscape cookies" : "ThePrivator cookies", extensions: [netscape ? "txt" : "json"] },
            ]);
            if (destination === null) return;
            const result = await exportProfileCookies(ids[0], destination, netscape ? "netscape" : "theprivator-json");
            setActionNote(`Exported ${result.exportedCount} cookies. ${result.skippedCount} skipped.`);
          });
        case "cookies-import":
          return runFor(ids, async () => {
            const source = await pickFile("Import cookies into this profile", [{ name: "Cookie files", extensions: ["txt", "json"] }]);
            if (source === null) return;
            const result = await replaceProfileCookies(ids[0], source);
            setActionNote(`Imported ${result.importedCount} cookies, replacing ${result.replacedCount} previous cookies.`);
          });
        case "launch":
          return runFor(ids, () => launchChromiumProfile(ids[0]));
        case "stop":
          return runFor(ids, () => stopChromiumProfile(ids[0]));
        case "delete":
          return runFor(ids, () => deleteProfile(ids[0]));
        case "restore":
          return runFor(ids, () => restoreProfile(ids[0]));
        case "purge":
          return runFor(ids, () => purgeProfile(ids[0]));
        case "open":
          onOpenProfile(ids[0]);
          return Promise.resolve();
        case "bulk-launch":
          return runFor(ids, () => bulkLaunchChromiumProfiles(ids));
        case "bulk-stop":
          return runFor(ids, () => bulkStopChromiumProfiles(ids));
        case "bulk-delete":
          // Sequential on purpose: each delete rewrites the store, and firing
          // them together races the read-modify-write behind every mutation.
          return runFor(ids, async () => {
            for (const id of ids) {
              await deleteProfile(id);
            }
          });
        case "bulk-restore":
          return runFor(ids, async () => {
            for (const id of ids) {
              await restoreProfile(id);
            }
          });
        case "bulk-purge":
          return runFor(ids, async () => {
            for (const id of ids) {
              await purgeProfile(id);
            }
          });
        default:
          // Folders, tags, duplication and export arrive with the profile editor.
          return Promise.resolve();
      }
    },
    [onOpenProfile, runFor],
  );

  const describeConfirmation = useCallback((action: RowAction, ids: string[], name: string): ConfirmState => {
    const count = ids.length;
    const subject = count === 1 ? `"${name}"` : `${count} profiles`;
    if (action === "cookies-import") return { action, ids, title: "Import cookies", body: `Importing replaces all existing cookies in ${subject}; it does not merge them. Cookie files contain sensitive login data. Continue only with a trusted file.`, confirmLabel: "Replace cookies" };
    if (action === "purge" || action === "bulk-purge") {
      return {
        action,
        ids,
        title: "Delete permanently",
        body: `${subject} and all browsing data will be erased. This cannot be undone.`,
        confirmLabel: "Delete permanently",
      };
    }
    return {
      action,
      ids,
      title: "Move to trash",
      body: `${subject} will move to the trash. You can restore it from there.`,
      confirmLabel: "Move to trash",
    };
  }, []);

  const chooseAction = useCallback(
    (action: RowAction, ids: string[], name: string) => {
      setMenu(null);
      if (ids.some((id) => activeIds.current.has(id))) return;
      if (action === "cookie-bot") { setCookieBot({ id: ids[0], name }); return; }
      if (requiresConfirmation(action)) {
        // The confirmation is rendered by this component rather than by the menu,
        // so closing the menu cannot take the dialog down with it -- which is
        // exactly how the previous delete prompt disappeared before it was read.
        setConfirm(describeConfirmation(action, ids, name));
        return;
      }
      void performAction(action, ids);
    },
    [describeConfirmation, performAction],
  );

  const onBotBusyChange = useCallback((busy: boolean) => {
    if (cookieBot === null) return;
    if (busy) activeIds.current.add(cookieBot.id); else activeIds.current.delete(cookieBot.id);
    dispatchBusy({ type: busy ? "start" : "finish", ids: [cookieBot.id] });
  }, [cookieBot]);

  const menuRow = menu === null ? null : (shown.find((row) => row.profile.id === menu.profileId) ?? null);
  const menuIds =
    menuRow === null
      ? []
      : selection.ids.has(menuRow.profile.id) && selectedIds.length > 1
        ? selectedIds
        : [menuRow.profile.id];

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <button type="button" className={styles.primary} onClick={onNewProfile}>
          New profile
        </button>

        <span className={styles.count}>
          {loading ? "Loading…" : `${shown.length} ${shown.length === 1 ? "profile" : "profiles"}`}
        </span>

        <span className={styles.spacer} />

        <div className={styles.columnsAnchor}>
          <button
            type="button"
            className={styles.secondary}
            aria-expanded={columnsOpen}
            aria-haspopup="dialog"
            onClick={() => setColumnsOpen((open) => !open)}
          >
            Columns
          </button>
          {columnsOpen ? (
            <div className={styles.columnsPopover}>
              <ColumnManager layout={layout} onApply={setLayout} onClose={() => setColumnsOpen(false)} />
            </div>
          ) : null}
        </div>
      </div>

      {error !== null ? (
        <p className={styles.error} role="alert">
          {error.message}
        </p>
      ) : null}
      {actionError !== null ? (
        <p className={styles.error} role="alert">
          {actionError.message}
        </p>
      ) : null}

      {actionNote !== null ? <p role="status">{actionNote}</p> : null}

      <ProfileTable
        rows={shown}
        layout={layout}
        sort={sort}
        selection={selection.ids}
        folderNames={folderNames}
        busyIds={busyIds}
        onSort={onSort}
        onResize={onResize}
        onSelect={onSelect}
        onOpen={onOpenProfile}
        onLaunch={onLaunch}
        onStop={onStop}
        onRowMenu={onRowMenu}
        emptyMessage={loading ? "Loading profiles…" : EMPTY_MESSAGES[view]}
      />

      {selectedIds.length > 1 ? (
        <div className={styles.bulkBar} role="region" aria-label="Bulk actions">
          <span>
            {selectedIds.length} selected
          </span>
          {buildRowMenu({
            profile: shown[0].profile,
            running: false,
            trashed: view === "trash",
            selectionSize: selectedIds.length,
            runningInSelection: runningSelected,
          }).map((item) => (
            <button
              key={item.action}
              type="button"
              className={item.danger === true ? styles.bulkDanger : styles.bulkAction}
              disabled={item.disabledReason !== undefined}
              title={item.disabledReason}
              onClick={() => chooseAction(item.action, selectedIds, "")}
            >
              {item.label}
            </button>
          ))}
          <button type="button" className={styles.bulkAction} onClick={() => setSelection(EMPTY_SELECTION)}>
            Clear selection
          </button>
        </div>
      ) : null}

      {menu !== null && menuRow !== null ? (
        <RowMenu
          x={menu.x}
          y={menu.y}
          items={buildRowMenu({
            profile: menuRow.profile,
            running: menuRow.running,
            trashed: view === "trash",
            selectionSize: menuIds.length,
            runningInSelection: menuIds.length > 1 ? runningSelected : menuRow.running ? 1 : 0,
          })}
          onChoose={(action) => chooseAction(action, menuIds, menuRow.profile.name)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {cookieBot !== null ? <CookieBotDialog profileId={cookieBot.id} profileName={cookieBot.name}
        onClose={() => setCookieBot(null)} onRefresh={refresh} onBusyChange={onBotBusyChange} /> : null}

      {confirm !== null ? (
        <div className={styles.overlay} role="presentation" onClick={() => setConfirm(null)}>
          <div
            className={styles.dialog}
            role="alertdialog"
            aria-modal="true"
            aria-label={confirm.title}
            onClick={(event) => event.stopPropagation()}
          >
            <h2>{confirm.title}</h2>
            <p>{confirm.body}</p>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.secondary} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={styles.danger}
                onClick={() => {
                  const pending = confirm;
                  setConfirm(null);
                  void performAction(pending.action, pending.ids);
                }}
              >
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
