import type { ReactNode } from "react";

import type { Route } from "../app/routes";
import { Sidebar, type SidebarCounts, type SidebarFolder } from "./Sidebar";
import { StatusBar, type StatusTile } from "./StatusBar";
import { TopNav } from "./TopNav";
import { WindowChrome } from "./WindowChrome";
import styles from "./AppShell.module.css";

interface AppShellProps {
  route: Route;
  search: string;
  onSearchChange: (value: string) => void;
  folders: SidebarFolder[];
  counts: SidebarCounts;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  statusTiles: StatusTile[];
  /** Some destinations own the full width; the folder rail only makes sense on profiles. */
  showSidebar: boolean;
  children: ReactNode;
}

/**
 * The frame every destination renders inside.
 *
 * A grid rather than nested flex containers so the scrolling region is exactly
 * one cell: with flex, a long table pushes the status bar off-screen instead of
 * scrolling under it.
 */
export function AppShell({
  route,
  search,
  onSearchChange,
  folders,
  counts,
  sidebarCollapsed,
  onToggleSidebar,
  statusTiles,
  showSidebar,
  children,
}: AppShellProps) {
  // The macOS Tauri configuration supplies the native title bar and controls.
  const nativeTitleBar = navigator.platform.startsWith("Mac");

  return (
    <div className={`${styles.shell}${nativeTitleBar ? ` ${styles.nativeTitleBar}` : ""}`}>
      <a className={styles.skipLink} href="#workspace">
        Skip to workspace
      </a>
      {nativeTitleBar ? null : <WindowChrome />}
      <TopNav route={route} search={search} onSearchChange={onSearchChange} />
      <div className={styles.body} style={showSidebar ? undefined : { gridTemplateColumns: "1fr" }}>
        {showSidebar ? (
          <Sidebar
            route={route}
            folders={folders}
            counts={counts}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={onToggleSidebar}
          />
        ) : null}
        <main id="workspace" className={styles.main} aria-label={mainLabelForRoute(route)}>
          {children}
        </main>
      </div>
      <StatusBar tiles={statusTiles} />
    </div>
  );
}

function mainLabelForRoute(route: Route): string {
  switch (route.name) {
    case "profiles":
      return "Profiles workspace";
    case "profile":
      return "Profile settings";
    case "profile-new":
      return "New profile";

    case "automation":
      return "Automation";
    case "settings":
      return "Settings";
  }
}
