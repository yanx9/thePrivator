import { type Route, primaryNavKeyForRoute, routeToHash } from "../app/routes";
import styles from "./TopNav.module.css";

interface NavItem {
  key: string;
  label: string;
  route: Route;
}

/**
 * The four destinations, deliberately not five.
 *
 * Templates holds profile and proxy templates as two tabs rather than taking a
 * nav slot each, which is the shape the product this follows uses and keeps the
 * bar readable at the 960px minimum window width.
 */
const NAV_ITEMS: NavItem[] = [
  { key: "profiles", label: "Profiles", route: { name: "profiles", view: "all", folderId: null } },
  { key: "proxies", label: "Proxies", route: { name: "proxies" } },
  { key: "templates", label: "Templates", route: { name: "templates" } },
  { key: "automation", label: "Automation", route: { name: "automation" } },
];

interface TopNavProps {
  route: Route;
  search: string;
  onSearchChange: (value: string) => void;
}

export function TopNav({ route, search, onSearchChange }: TopNavProps) {
  const activeKey = primaryNavKeyForRoute(route);

  return (
    <div className={styles.bar}>
      <nav className={styles.nav} aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => (
          <a
            key={item.key}
            className={styles.navItem}
            href={routeToHash(item.route)}
            aria-current={item.key === activeKey ? "page" : undefined}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <div className={styles.spacer} />

      <label className={styles.search}>
        <span className={styles.searchIcon} aria-hidden="true">
          &#x2315;
        </span>
        <input
          type="search"
          aria-label="Search profiles"
          placeholder="Search profiles"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </label>

      {/* Settings is a gear rather than a fifth nav slot, but it is still a
          destination, so it reports itself as current like any other. */}
      <a
        className={styles.iconAction}
        href={routeToHash({ name: "settings", section: "appearance" })}
        aria-label="Settings"
        aria-current={activeKey === "settings" ? "page" : undefined}
      >
        <span aria-hidden="true">&#x2699;</span>
      </a>
    </div>
  );
}
