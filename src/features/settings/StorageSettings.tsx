import { useEffect, useState } from "react";
import { getStorageUsage, normalizeSidecarError, type StorageUsage } from "../../sidecar/client";
import styles from "./SettingsPage.module.css";
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const i = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${["B", "KiB", "MiB", "GiB"][i]}`;
}
export function StorageSettings() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() { setBusy(true); setError(""); try { setUsage(await getStorageUsage()); } catch (e) { setError(normalizeSidecarError(e).message); } finally { setBusy(false); } }
  useEffect(() => { void refresh(); }, []);
  return <div className={styles.page}><h1>Disk usage</h1><p>Allocated space in ThePrivator’s data folder, including browser caches and trash. External exports, synchronization copies and the application installation are not included.</p>
    {error ? <p role="alert">{error}</p> : null}
    {usage ? <section className={styles.card}><h2>{formatBytes(usage.bytes)} total</h2><dl>
      <dt>Profiles, browser data and trash</dt><dd>{formatBytes(usage.groups.profiles)}</dd>
      <dt>Encrypted vault snapshots</dt><dd>{formatBytes(usage.groups.vault)}</dd>
      <dt>Settings, logs and other app data</dt><dd>{formatBytes(usage.groups.other)}</dd>
    </dl>{usage.incomplete ? <p>Some files could not be measured. This total is incomplete.</p> : null}</section> : null}
    <button className={styles.secondary} disabled={busy} onClick={() => void refresh()}>{busy ? "Measuring…" : "Refresh"}</button>
  </div>;
}
