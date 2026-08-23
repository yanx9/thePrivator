import type { SettingsSection } from "../../app/routes";
import { routeToHash } from "../../app/routes";
import { SyncSettings } from "../sync/SyncSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { ImportSettings } from "./ImportSettings";
import styles from "./SettingsPage.module.css";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "sync", label: "Synchronization" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "import", label: "Import" },
];

export function SettingsPage({ section }: { section: SettingsSection }) {
  return (
    <div className={styles.layout}>
      <nav className={styles.sections} aria-label="Settings sections">
        {SECTIONS.map((entry) => (
          <a
            key={entry.id}
            className={styles.section}
            href={routeToHash({ name: "settings", section: entry.id })}
            aria-current={entry.id === section ? "page" : undefined}
          >
            {entry.label}
          </a>
        ))}
      </nav>

      <div className={styles.panel}>
        {section === "sync" ? (
          <SyncSettings />
        ) : section === "diagnostics" ? (
          <DiagnosticsSettings />
        ) : section === "import" ? (
          <ImportSettings />
        ) : (
          <AppearanceSettings />
        )}
      </div>
    </div>
  );
}
