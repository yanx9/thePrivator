import { type ProfileView, type Route, routeToHash } from "../app/routes";
import styles from "./Sidebar.module.css";

export interface SidebarFolder {
  id: string;
  name: string;
  profileCount: number;
}

export interface SidebarCounts {
  all: number;
  favorites: number;
  running: number;
  trash: number;
}

interface ViewItem {
  view: ProfileView;
  label: string;
  glyph: string;
}

const VIEW_ITEMS: ViewItem[] = [
  { view: "all", label: "All profiles", glyph: "▦" },
  { view: "favorites", label: "Favorites", glyph: "★" },
  { view: "running", label: "Running", glyph: "▶" },
  { view: "trash", label: "Trash", glyph: "✖" },
];

/**
 * A count rendered next to a label concatenates into its accessible name with no
 * separator -- a screen reader announces the "Work" folder holding 2 profiles as
 * "Work2". Naming the item explicitly is the fix; the visible label stays a prefix
 * of the spoken one, so voice control still matches what is on screen.
 */
function describeCount(label: string, count: number): string {
  return `${label}, ${count} ${count === 1 ? "profile" : "profiles"}`;
}

interface SidebarProps {
  route: Route;
  folders: SidebarFolder[];
  counts: SidebarCounts;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function Sidebar({ route, folders, counts, collapsed, onToggleCollapsed }: SidebarProps) {
  const activeView = route.name === "profiles" && route.folderId === null ? route.view : null;
  const activeFolderId = route.name === "profiles" ? route.folderId : null;

  return (
    <nav
      className={collapsed ? `${styles.sidebar} ${styles.collapsed}` : styles.sidebar}
      aria-label="Profile folders and views"
    >
      <ul className={styles.group}>
        {VIEW_ITEMS.map((item) => (
          <li key={item.view}>
            <a
              className={styles.item}
              href={routeToHash({ name: "profiles", view: item.view, folderId: null })}
              aria-current={item.view === activeView ? "page" : undefined}
              aria-label={describeCount(item.label, counts[item.view])}
            >
              <span className={styles.glyph} aria-hidden="true">
                {item.glyph}
              </span>
              <span className={styles.label}>{item.label}</span>
              <span className={styles.count}>{counts[item.view]}</span>
            </a>
          </li>
        ))}
      </ul>

      <div className={styles.sectionTitle} id="sidebar-folders-heading">
        Folders
      </div>
      {folders.length === 0 ? (
        <p className={styles.empty}>No folders yet</p>
      ) : (
        <ul className={styles.group} role="tree" aria-labelledby="sidebar-folders-heading">
          {folders.map((folder) => (
            <li key={folder.id} role="none">
              <a
                className={styles.item}
                role="treeitem"
                aria-level={1}
                aria-selected={folder.id === activeFolderId}
                aria-label={describeCount(folder.name, folder.profileCount)}
                href={routeToHash({ name: "profiles", view: "all", folderId: folder.id })}
              >
                <span className={styles.glyph} aria-hidden="true">
                  &#x1F5C0;
                </span>
                <span className={styles.label}>{folder.name}</span>
                <span className={styles.count}>{folder.profileCount}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className={styles.collapseToggle}
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <span aria-hidden="true">{collapsed ? "»" : "«"}</span>
      </button>
    </nav>
  );
}
