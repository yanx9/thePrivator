import type { ProfileRecord } from "../../sidecar/types";

/**
 * The context menu, as data.
 *
 * Which entries a row offers depends on whether it is running, trashed, favourite
 * and whether a bulk selection is active -- four inputs whose combinations are
 * exactly where a menu grows a "Delete" that fires on a running browser. Building
 * the list as data means those combinations are enumerable in a test instead of
 * reachable only by right-clicking the right row in the right state.
 */

export type RowAction =
  | "check-proxy"
  | "cookies"
  | "cookies-export-json"
  | "cookies-import"
  | "cookie-bot"
  | "launch"
  | "stop"
  | "open"
  | "duplicate"
  | "favorite"
  | "unfavorite"
  | "move"
  | "tag"
  | "export"
  | "delete"
  | "restore"
  | "purge"
  | "bulk-launch"
  | "bulk-stop"
  | "bulk-move"
  | "bulk-tag"
  | "bulk-delete"
  | "bulk-restore"
  | "bulk-purge";

export interface MenuItem {
  action: RowAction;
  label: string;
  children?: MenuItem[];
  /** Renders the entry as the destructive one, and puts it behind a confirmation. */
  danger?: boolean;
  /** Present but unavailable, with the reason spoken -- a missing entry teaches nothing. */
  disabledReason?: string;
  /** Starts a visual group. */
  separatorBefore?: boolean;
}

export interface RowMenuContext {
  checkingProxy?: boolean;
  profile: ProfileRecord;
  running: boolean;
  trashed: boolean;
  /** How many rows the action would hit, counting this one. */
  selectionSize: number;
  /** Ids in the selection that are currently running, for the bulk labels. */
  runningInSelection: number;
}

/** Bulk labels say how many rows they hit, so a click is never a surprise. */
function plural(count: number): string {
  return count === 1 ? "profile" : "profiles";
}

function bulkMenu(context: RowMenuContext): MenuItem[] {
  const { selectionSize, runningInSelection, trashed } = context;
  const stopped = selectionSize - runningInSelection;

  if (trashed) {
    return [
      { action: "bulk-restore", label: `Restore ${selectionSize} ${plural(selectionSize)}` },
      {
        action: "bulk-purge",
        label: `Delete ${selectionSize} ${plural(selectionSize)} permanently`,
        danger: true,
        separatorBefore: true,
      },
    ];
  }

  return [
    {
      action: "bulk-launch",
      label: `Launch ${stopped} ${plural(stopped)}`,
      disabledReason: stopped === 0 ? "Every selected profile is already running" : undefined,
    },
    {
      action: "bulk-stop",
      label: `Stop ${runningInSelection} ${plural(runningInSelection)}`,
      disabledReason: runningInSelection === 0 ? "No selected profile is running" : undefined,
    },
    { action: "bulk-move", label: "Move to folder…", separatorBefore: true },
    { action: "bulk-tag", label: "Edit tags…" },
    {
      action: "bulk-delete",
      label: `Move ${selectionSize} ${plural(selectionSize)} to trash`,
      danger: true,
      separatorBefore: true,
      disabledReason:
        runningInSelection > 0
          ? `Stop ${runningInSelection} running ${plural(runningInSelection)} first`
          : undefined,
    },
  ];
}

export function buildRowMenu(context: RowMenuContext): MenuItem[] {
  if (context.selectionSize > 1) {
    return bulkMenu(context);
  }

  if (context.trashed) {
    return [
      { action: "restore", label: "Restore" },
      { action: "purge", label: "Delete permanently", danger: true, separatorBefore: true },
    ];
  }

  const { running, profile } = context;

  return [
    running
      ? { action: "stop", label: "Stop" }
      : { action: "launch", label: "Launch" },
    { action: "open", label: "Edit profile" },
    { action: "check-proxy", label: context.checkingProxy ? "Checking proxy…" : "Check proxy", disabledReason: context.checkingProxy ? "A proxy check is already running" : undefined },
    { action: "duplicate", label: "Duplicate", separatorBefore: true },
    profile.organization.favorite
      ? { action: "unfavorite", label: "Remove from favorites" }
      : { action: "favorite", label: "Add to favorites" },
    { action: "move", label: "Move to folder…" },
    { action: "tag", label: "Edit tags…" },
    { action: "export", label: "Export…", separatorBefore: true },
    { action: "cookies", label: "Cookies", children: [
      { action: "cookies-export-json", label: "Export (JSON)…", disabledReason: running ? "Stop the profile first" : undefined },
      { action: "cookies-import", label: "Import…", disabledReason: running ? "Stop the profile first" : undefined },
    ] },
    { action: "cookie-bot", label: "Run Cookie Bot…" },
    {
      action: "delete",
      label: "Move to trash",
      danger: true,
      separatorBefore: true,
      // Deleting a profile whose browser is live would pull the user-data
      // directory out from under a running Chromium.
      disabledReason: running ? "Stop the profile first" : undefined,
    },
  ];
}

/** Actions that need a confirmation step before they run. */
export function requiresConfirmation(action: RowAction): boolean {
  return action === "cookies-import" || action === "delete" || action === "purge" || action === "bulk-delete" || action === "bulk-purge";
}
