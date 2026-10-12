import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getMachineInfo, getPreferences, vaultOperation, normalizeSidecarError, type MachineInfo, type VaultStatus, type Preferences, saveInterfacePreferences } from "../sidecar/client";
import { subscribeToSidecarEvent } from "../sidecarEvents";
import styles from "../features/settings/SettingsPage.module.css";

const PreferencesContext = createContext<{ preferences: Preferences; save: (patch: Pick<Preferences, "tableLayout" | "sidebarCollapsed">) => void } | null>(null);
export const usePreferences = () => useContext(PreferencesContext);
const MachineContext = createContext<MachineInfo | null>(null);
export const useMachineInfo = () => useContext(MachineContext);
export const VAULT_CHANGED = "theprivator-vault-changed";
export function notifyVaultChanged() { window.dispatchEvent(new Event(VAULT_CHANGED)); }
export function applyTheme(theme: "system" | "light" | "dark") {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

export function DesktopSession({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>({ theme: "system" });
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [machine, setMachine] = useState<MachineInfo | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const [preferences, status] = await Promise.all([getPreferences(), vaultOperation("status")]);
      applyTheme(preferences.theme);
      setPreferences(preferences);
      setVault(status);
    } catch (caught) { setError(normalizeSidecarError(caught).message); }
  }, []);
  useEffect(() => {
    void refresh();
    void getMachineInfo().then(setMachine).catch(() => {});
    const changed = () => { void refresh(); };
    window.addEventListener(VAULT_CHANGED, changed);
    const off = subscribeToSidecarEvent("theprivator://vault-close-failed", () => {
      setError("The vault could not be locked. The app remains open. Check free space and retry locking.");
      void refresh();
    });
    return () => { window.removeEventListener(VAULT_CHANGED, changed); off(); };
  }, [refresh]);
  const save = useCallback((patch: Pick<Preferences, "tableLayout" | "sidebarCollapsed">) => {
    setPreferences((current) => ({ ...current, ...patch }));
    void saveInterfacePreferences(patch).catch((caught) => setError(normalizeSidecarError(caught).message));
  }, []);
  if (vault && !vault.locked) return <PreferencesContext.Provider value={{ preferences, save }}><MachineContext.Provider value={machine}>
    {error ? <p role="alert">{error} <button onClick={() => setError("")}>Dismiss</button></p> : null}{children}
  </MachineContext.Provider></PreferencesContext.Provider>;
  return <main className={styles.page} style={{ maxWidth: 480, margin: "12vh auto" }}>
    <h1>{vault ? "Unlock ThePrivator" : "Opening ThePrivator…"}</h1>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {vault?.recoveryRequired ? <p>The previous session did not finish locking. Enter your password to recover its latest data, then lock again to protect it.</p> : null}
    {vault ? <form onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setError("");
      const value = password; setPassword("");
      void vaultOperation("unlock", value).then(setVault).catch((caught) => setError(normalizeSidecarError(caught).message)).finally(() => setBusy(false));
    }}>
      <label>PIN or password <input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></label>
      <button className={styles.primary} disabled={busy || !password}>{busy ? "Unlocking…" : "Unlock"}</button>
    </form> : error ? <button onClick={() => { setError(""); void refresh(); }}>Retry</button> : null}
  </main>;
}
