import { useState } from "react";
import { createProfile, normalizeSidecarError, updateProfileIdentity, updateProfileLaunch, updateProfileOrganization } from "../../sidecar/client";
import type { ProfileData } from "../profiles/useProfileData";
import type { ProfileRecord } from "../../sidecar/types";
import styles from "./TemplatesPage.module.css";

export interface TemplatesPageProps { data: ProfileData; onOpenProfile: (id: string) => void; search?: string }
export function TemplatesPage({ data, onOpenProfile, search = "" }: TemplatesPageProps) {
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createdId, setCreatedId] = useState("");
  const [complete, setComplete] = useState(false);
  const [pendingSource, setPendingSource] = useState<ProfileRecord | null>(null);
  const rows = data.rows.filter(({ profile }) => `${profile.name} ${profile.organization.tags.join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()));
  const source = (rows.find(({ profile }) => profile.id === selected) ?? rows[0])?.profile;
  async function create(retry = false) {
    const configuration = retry ? pendingSource : source;
    if (busy || !configuration || (!retry && (!name.trim() || createdId))) return;
    if (retry && data.rows.some((row) => row.profile.id === createdId && row.running)) {
      setError("Stop the created profile before retrying configuration."); return;
    }
    setBusy(true); setError(""); setComplete(false);
    setPendingSource(configuration);
    try {
      let id = createdId;
      if (!retry) {
        const result = await createProfile(name.trim());
        if (!result.profile) throw new Error("Creation returned no profile.");
        id = result.profile.id;
        setCreatedId(id); data.refresh();
      }
      await updateProfileIdentity(id, configuration.identity);
      const startUrls = configuration.launch.startUrls.filter((value) => {
        if (value === "about:blank") return true;
        try {
          const url = new URL(value);
          return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
        } catch { return false; }
      });
      await updateProfileLaunch(id, { startupBehavior: configuration.launch.startupBehavior, startUrls, args: [] });
      await updateProfileOrganization(id, { folderId: configuration.organization.folderId, tags: configuration.organization.tags, color: configuration.organization.color, notes: "", favorite: false });
      setComplete(true); data.refresh();
    } catch (caught) { setError(normalizeSidecarError(caught).message); data.refresh(); }
    finally { setBusy(false); }
  }
  return <section className={styles.page} aria-label="Templates"><h1>Templates</h1>
    <p>Reuse source profile configuration, not browser data. These are your existing profiles, not separately stored templates.</p>
    <p>Copies fingerprint settings, plain HTTP(S) startup pages, folder, tags and color. Startup URLs containing authentication, query strings or fragments are skipped. Cookies, sessions, credentials, proxy settings, notes and extra launch arguments are never copied. New profiles use a direct connection; configure their proxy before browsing.</p>
    {data.loading ? <p role="status">Loading profiles…</p> : null}
    {data.error ? <p role="alert">{data.error.message}</p> : null}
    {!source && !data.loading ? <p>{data.rows.length ? "No source profiles match your search." : "Create a profile first, then reuse its configuration here."}</p> : null}
    <fieldset disabled={busy || !source || !!createdId}>
      <label>Source profile<select value={source?.id ?? ""} onChange={(event) => setSelected(event.target.value)}>{rows.map(({ profile }) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      {source ? <><button onClick={() => onOpenProfile(source.id)}>Open source profile</button><p>Fingerprint: {source.identity.label} · Startup: {source.launch.startupBehavior} · Tags: {source.organization.tags.join(", ") || "None"}</p></> : null}
      <label>New profile name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <button disabled={!name.trim()} onClick={() => void create()}>Create from configuration</button>
    </fieldset>
    {busy ? <p role="status">Creating and applying configuration…</p> : null}
    {error ? <p role="alert">{createdId ? "Profile created, but configuration is incomplete. Open the created profile to finish setup. " : "Could not create profile. "}{error}</p> : null}
    {complete ? <p role="status">Configuration copied. Browser data and credentials were not copied.</p> : null}
    {createdId ? <button disabled={busy} onClick={() => onOpenProfile(createdId)}>Open created profile</button> : null}
    {createdId && !complete ? <button disabled={busy} onClick={() => void create(true)}>Retry configuration</button> : null}
    {createdId && complete ? <button onClick={() => { setCreatedId(""); setComplete(false); setName(""); setPendingSource(null); }}>Create another profile</button> : null}
  </section>;
}
