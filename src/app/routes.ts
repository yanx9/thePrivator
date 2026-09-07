/**
 * Hash routing, without a router dependency.
 *
 * Real `<a href="#/profiles">` elements mean back and forward work inside the
 * webview for free and a profile is deep-linkable, which a click-handler-driven
 * switch would not give. The whole thing is small enough that a dependency would
 * cost more than it saves.
 */

export type ProfileView = "all" | "favorites" | "running" | "trash";

export type EditorSection = "general" | "proxy" | "fingerprint" | "extra" | "tools";

export type SettingsSection = "appearance" | "sync" | "diagnostics" | "import";

export type Route =
  | { name: "profiles"; view: ProfileView; folderId: string | null }
  | { name: "profile"; id: string }
  | { name: "profile-new" }

  | { name: "automation" }
  | { name: "settings"; section: SettingsSection };

export const DEFAULT_ROUTE: Route = { name: "profiles", view: "all", folderId: null };

const PROFILE_VIEWS: readonly ProfileView[] = ["all", "favorites", "running", "trash"];
const SETTINGS_SECTIONS: readonly SettingsSection[] = ["appearance", "sync", "diagnostics", "import"];

/**
 * Ids come out of the address bar, so they are treated as untrusted input and
 * matched against a conservative shape. An id that fails is not passed through
 * for a component to render -- the route falls back instead.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function parseRoute(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart, queryPart] = raw.split("?", 2);
  const segments = pathPart.split("/").filter(Boolean);
  const query = new URLSearchParams(queryPart ?? "");

  if (segments.length === 0) {
    return DEFAULT_ROUTE;
  }

  switch (segments[0]) {
    case "profiles": {
      const view = segments[1];
      if (view === undefined) {
        const folderId = query.get("folder");
        return {
          name: "profiles",
          view: "all",
          folderId: folderId !== null && ID_PATTERN.test(folderId) ? folderId : null,
        };
      }
      if (view === "new") {
        return { name: "profile-new" };
      }
      if (PROFILE_VIEWS.includes(view as ProfileView)) {
        return { name: "profiles", view: view as ProfileView, folderId: null };
      }
      return ID_PATTERN.test(view) ? { name: "profile", id: view } : DEFAULT_ROUTE;
    }

    case "automation":
      return { name: "automation" };
    case "settings": {
      const section = segments[1];
      return {
        name: "settings",
        section: SETTINGS_SECTIONS.includes(section as SettingsSection)
          ? (section as SettingsSection)
          : "appearance",
      };
    }
    default:
      return DEFAULT_ROUTE;
  }
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case "profiles":
      if (route.folderId !== null) {
        return `#/profiles?folder=${encodeURIComponent(route.folderId)}`;
      }
      return route.view === "all" ? "#/profiles" : `#/profiles/${route.view}`;
    case "profile":
      return `#/profiles/${encodeURIComponent(route.id)}`;
    case "profile-new":
      return "#/profiles/new";

    case "automation":
      return "#/automation";
    case "settings":
      return `#/settings/${route.section}`;
  }
}

/** Which top-level nav item should read as current for a route. */
export function primaryNavKeyForRoute(route: Route): string {
  switch (route.name) {
    case "profiles":
    case "profile":
    case "profile-new":
      return "profiles";
    default:
      return route.name;
  }
}
