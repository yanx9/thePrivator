import { useEffect, useState } from "react";
import { vaultOperation, normalizeSidecarError, type VaultStatus } from "../../sidecar/client";
import { notifyVaultChanged } from "../../app/DesktopSession";
import styles from "./SettingsPage.module.css";

export function SecuritySettings() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void vaultOperation("status").then(setStatus).catch((e) => setError(normalizeSidecarError(e).message)); }, []);
  async function run(action: "enable" | "disable" | "lock") {
    setBusy(true); setError("");
    const secret = password; setPassword(""); setConfirmation("");
    try { setStatus(await vaultOperation(action, action === "lock" ? undefined : secret)); }
    catch (caught) { setError(normalizeSidecarError(caught).message); }
    finally { setBusy(false); notifyVaultChanged(); }
  }
  return <div className={styles.page}>
    <header className={styles.header}><h1>Data protection</h1><p>Optional PIN or password encryption for this device.</p></header>
    <section className={styles.card}>
      <h2>{status?.enabled ? "Vault enabled" : "Vault protection is off"}</h2>
      <p>When off, profile information and proxy credentials are stored without app encryption.</p>
      <p>When enabled, locking encrypts profiles, proxy credentials, notes, browser sessions and local synchronization settings. Locking stops browsers, background jobs and the automation API. Normal app exit locks automatically.</p>
      <p>Browser files are decrypted while unlocked. A crash or power loss can leave these files on disk until you recover and lock again. Use disk encryption for protection during an interrupted session. Exports and copies already synchronized to another folder are separate, unencrypted copies.</p>
      <p>Use at least 6 characters; a longer password protects better than a short PIN. There is no password reset. Keep a backup and your password somewhere safe.</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); void run(status?.enabled ? "disable" : "enable"); }}>
        <label>{status?.enabled ? "Current PIN or password" : "New PIN or password"}
          <input type="password" minLength={6} maxLength={1024} autoComplete={status?.enabled ? "current-password" : "new-password"} value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {!status?.enabled ? <label>Confirm PIN or password <input type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={(e) => setConfirmation(e.target.value)} /></label> : null}
        <div className={styles.actions}>
          <button className={styles.primary} disabled={!status || busy || password.length < 6 || (!status.enabled && password !== confirmation)}>{busy ? "Working…" : status?.enabled ? "Disable encryption" : "Enable and lock"}</button>
          {status?.enabled ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => void run("lock")}>Lock now</button> : null}
        </div>
      </form>
      {busy ? <p role="status">Stopping activity and processing your data. Large libraries may take several minutes. Keep the app open.</p> : null}
    </section>
  </div>;
}
