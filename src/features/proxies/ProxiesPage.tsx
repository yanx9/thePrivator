import { useState } from "react";
import { createProxyDraftState, parseProxyDraftState } from "../../proxyControls";
import { checkProfileProxy, normalizeSidecarError, updateProfileProxy } from "../../sidecar/client";
import { ProxyForm } from "../profiles/ProxyForm";
import type { ProfileData } from "../profiles/useProfileData";
import type { ProfileRow } from "../profiles/tableModel";
import styles from "./ProxiesPage.module.css";

export interface ProxiesPageProps { data: ProfileData; onOpenProfile: (id: string) => void; search?: string }
export function ProxiesPage({ data, onOpenProfile, search = "" }: ProxiesPageProps) {
  const [selected, setSelected] = useState("");
  const rows = data.rows.filter(({ profile }) => `${profile.name} ${profile.proxy.summary}`.toLowerCase().includes(search.trim().toLowerCase()));
  const row = rows.find(({ profile }) => profile.id === selected) ?? rows[0];
  return <section className={styles.page} aria-label="Proxies"><h1>Proxies</h1><p>Manage each profile’s connection. Credentials stay masked.</p>
    {data.loading ? <p role="status">Loading profiles…</p> : null}
    {data.error ? <p role="alert">{data.error.message}</p> : null}
    {!rows.length && !data.loading ? <p>{data.rows.length ? "No profiles match your search." : "Create a profile first to configure its proxy."}</p> : null}
    <ul>{rows.map(({ profile, running }) => <li key={profile.id}><button onClick={() => setSelected(profile.id)} aria-pressed={profile.id === row?.profile.id}>{profile.name}</button> <span>{profile.proxy.summary}</span> {running ? "Running" : "Stopped"}</li>)}</ul>
    {row ? <ProxyEditor key={row.profile.id} row={row} refresh={data.refresh} onOpenProfile={onOpenProfile} /> : null}
  </section>;
}
function ProxyEditor({ row, refresh, onOpenProfile }: { row: ProfileRow; refresh: () => void; onOpenProfile: (id: string) => void }) {
  const [draft, setDraft] = useState(() => createProxyDraftState(row.profile.proxy));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function check() {
    if (busy || row.running) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await checkProfileProxy(row.profile.id);
      setMessage(result.ipHiding.publicExitIp
        ? `Observed exit IP: ${result.ipHiding.publicExitIp}. WebRTC: ${result.webRtc.localIpExposure}.`
        : `Check complete. Public exit IP not verified. Route proof: ${result.routeProof.status} (${result.routeProof.scope}). WebRTC: ${result.webRtc.localIpExposure}.`);
    } catch (caught) { setError(normalizeSidecarError(caught).message); }
    finally { setBusy(false); }
  }
  async function save() {
    if (busy || row.running) return;
    const parsed = parseProxyDraftState(draft);
    setDraft({ ...draft, errors: parsed.errors });
    if (!parsed.ok) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await updateProfileProxy(row.profile.id, parsed.proxy);
      setDraft(createProxyDraftState(result.profile.proxy));
      refresh(); setMessage("Proxy saved.");
    } catch (caught) { setError(normalizeSidecarError(caught).message); }
    finally { setBusy(false); }
  }
  return <div className={styles.editor}><h2>{row.profile.name}</h2><button disabled={busy} onClick={() => onOpenProfile(row.profile.id)}>Open profile</button>
    {row.running ? <p>Stop this profile before changing its proxy.</p> : null}
    <fieldset disabled={busy || row.running}><ProxyForm draft={draft} onChange={setDraft} /><button onClick={() => void save()}>Save proxy</button><button onClick={() => void check()}>Check saved proxy</button></fieldset>
    <p>Checks use the saved configuration, not unsaved edits. A local route proof is not a public anonymity guarantee.</p>
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
  </div>;
}
