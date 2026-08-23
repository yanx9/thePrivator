import { useCallback, useMemo, useState } from "react";

import { Placeholder } from "./app/Placeholder";
import { type Route, primaryNavKeyForRoute } from "./app/routes";
import { useNavigate, useRoute } from "./app/useRoute";
import { ProfileEditor } from "./features/profiles/ProfileEditor";
import { ProfilesPage } from "./features/profiles/ProfilesPage";
import { useProfileData } from "./features/profiles/useProfileData";
import { AutomationPage } from "./features/automation/AutomationPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { AppShell } from "./shell/AppShell";
import type { SidebarCounts, SidebarFolder } from "./shell/Sidebar";
import type { StatusTile } from "./shell/StatusBar";
import type { ProfileData } from "./features/profiles/useProfileData";

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
      return <AutomationPage />;
    default:
      // Every destination above is handled; settings is routed before this.
      return null;
  }
}

interface DestinationContext {
  destination: string;
  search: string;
  folderNames: ReadonlyMap<string, string>;
  data: ProfileData;
  onOpenProfile: (id: string) => void;
  onNewProfile: () => void;
  onCloseEditor: () => void;
}

function renderDestination(route: Route, context: DestinationContext) {
  if (route.name === "profiles") {
    return (
      <ProfilesPage
        view={route.view}
        folderId={route.folderId}
        search={context.search}
        folderNames={context.folderNames}
        data={context.data}
        onOpenProfile={context.onOpenProfile}
        onNewProfile={context.onNewProfile}
      />
    );
  }
  if (route.name === "settings") {
    return <SettingsPage section={route.section} />;
  }
  if (route.name === "profile" || route.name === "profile-new") {
    return (
      <ProfileEditor
        profileId={route.name === "profile" ? route.id : null}
        onClose={context.onCloseEditor}
        onSaved={context.onCloseEditor}
      />
    );
  }
  return destinationFor(context.destination);
}

export function App() {
  const route = useRoute();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((collapsed) => !collapsed), []);

  // One loader for the whole window: the sidebar counts the same profiles the
  // table lists, and a second loader would poll twice and could disagree.
  const data = useProfileData(true);

  // Folders need the organization store, which has no command yet. An empty
  // list renders as "No folders yet", which is true.
  const folders = useMemo<SidebarFolder[]>(() => [], []);
  const folderNames = useMemo<ReadonlyMap<string, string>>(() => new Map(), []);

  const counts = useMemo<SidebarCounts>(
    () => ({
      all: data.rows.length,
      favorites: data.rows.filter((row) => row.profile.organization.favorite).length,
      running: data.rows.filter((row) => row.running).length,
      trash: data.trashed.length,
    }),
    [data.rows, data.trashed],
  );

  const statusTiles = useMemo<StatusTile[]>(
    () => [
      { key: "profiles", label: "Profiles", value: String(data.rows.length) },
      {
        key: "running",
        label: "Running",
        value: String(data.runningCount),
        tone: data.runningCount > 0 ? "ok" : "neutral",
      },
      {
        key: "sidecar",
        label: "Sidecar",
        value: data.error === null ? "Connected" : "Unavailable",
        tone: data.error === null ? "ok" : "danger",
      },
    ],
    [data.rows.length, data.runningCount, data.error],
  );

  const destination = primaryNavKeyForRoute(route);

  const openProfile = useCallback((id: string) => navigate({ name: "profile", id }), [navigate]);
  const newProfile = useCallback(() => navigate({ name: "profile-new" }), [navigate]);
  const closeEditor = useCallback(
    () => navigate({ name: "profiles", view: "all", folderId: null }),
    [navigate],
  );

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
        onCloseEditor: closeEditor,
        data,
      })}
    </AppShell>
  );
}
