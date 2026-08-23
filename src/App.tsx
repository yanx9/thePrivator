import { useCallback, useMemo, useState } from "react";

import { Placeholder } from "./app/Placeholder";
import { type Route, primaryNavKeyForRoute } from "./app/routes";
import { useNavigate, useRoute } from "./app/useRoute";
import { ProfilesPage } from "./features/profiles/ProfilesPage";
import { LegacyApp } from "./legacy/LegacyApp";
import { AppShell } from "./shell/AppShell";
import type { SidebarCounts, SidebarFolder } from "./shell/Sidebar";
import type { StatusTile } from "./shell/StatusBar";

/**
 * The composition root.
 *
 * Everything below the shell is being ported destination by destination. Until a
 * destination has its own surface, the profile routes render the previous UI from
 * src/legacy -- which keeps the app usable and its tests meaningful while the
 * replacement is built, rather than leaving a long red period behind a flag. The
 * other destinations say what they will hold instead of quietly rendering the
 * profiles page, which would read as a broken nav rather than an unbuilt one.
 */
function destinationFor(routeName: ReturnType<typeof primaryNavKeyForRoute>) {
  switch (routeName) {
    case "proxies":
      return (
        <Placeholder
          title="Proxies"
          description="Saved proxy templates live here, so a proxy can be attached to a profile without retyping its credentials."
        />
      );
    case "templates":
      return (
        <Placeholder
          title="Templates"
          description="Profile templates capture a fingerprint and launch setup once, then stamp out profiles that share it."
        />
      );
    case "automation":
      return (
        <Placeholder
          title="Automation"
          description="The local automation endpoint and its access token are managed here."
        />
      );
    default:
      return (
        <Placeholder
          title="Settings"
          description="Appearance, profile synchronization, diagnostics and import live here."
        />
      );
  }
}

interface DestinationContext {
  destination: string;
  search: string;
  folderNames: ReadonlyMap<string, string>;
  onOpenProfile: (id: string) => void;
  onNewProfile: () => void;
}

/**
 * The strangler seam.
 *
 * The profile list is the new table; creating and editing a profile is still the
 * previous UI, until the editor lands. Splitting on the route rather than on a
 * flag means both halves are reachable and testable at every commit, instead of
 * a long period where one of them only exists in a branch.
 */
function renderDestination(route: Route, context: DestinationContext) {
  if (route.name === "profiles") {
    return (
      <ProfilesPage
        view={route.view}
        folderId={route.folderId}
        search={context.search}
        folderNames={context.folderNames}
        onOpenProfile={context.onOpenProfile}
        onNewProfile={context.onNewProfile}
      />
    );
  }
  if (route.name === "profile" || route.name === "profile-new") {
    return <LegacyApp />;
  }
  return destinationFor(context.destination);
}

export function App() {
  const route = useRoute();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((collapsed) => !collapsed), []);

  // Placeholders until the profile store hook lands with the table.
  const folders = useMemo<SidebarFolder[]>(() => [], []);
  const folderNames = useMemo<ReadonlyMap<string, string>>(() => new Map(), []);
  const counts = useMemo<SidebarCounts>(() => ({ all: 0, favorites: 0, running: 0, trash: 0 }), []);
  const statusTiles = useMemo<StatusTile[]>(() => [], []);

  const destination = primaryNavKeyForRoute(route);

  const openProfile = useCallback((id: string) => navigate({ name: "profile", id }), [navigate]);
  const newProfile = useCallback(() => navigate({ name: "profile-new" }), [navigate]);

  return (
    <AppShell
      route={route}
      search={search}
      onSearchChange={setSearch}
      folders={folders}
      counts={counts}
      sidebarCollapsed={sidebarCollapsed}
      onToggleSidebar={toggleSidebar}
      statusTiles={statusTiles}
      showSidebar={destination === "profiles"}
    >
      {renderDestination(route, {
        destination,
        search,
        folderNames,
        onOpenProfile: openProfile,
        onNewProfile: newProfile,
      })}
    </AppShell>
  );
}
