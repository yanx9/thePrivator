import { useEffect, useRef, useState } from "react";
import { pickDirectory, pickFiles } from "../../dialogs";
import { exportProfileToDirectory, importProfilePackage, normalizeSidecarError } from "../../sidecar/client";
import type { ProfileRow } from "./tableModel";
import styles from "./ProfilesPage.module.css";

export function BatchTransfer({ rows = [], selectedIds = [], onImported }: { rows?: readonly ProfileRow[]; selectedIds?: readonly string[]; onImported?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const cancelled = useRef(false);
  const active = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);
  async function run(kind: "import" | "selected" | "all") {
    if (active.current) return;
    active.current = true; cancelled.current = false;
    setBusy(true); setResults([]); setProgress("");
    let finished = 0, succeeded = 0, total = 0;
    try {
      const files = kind === "import" ? await pickFiles("Import profile packages", [{ name: "ThePrivator packages", extensions: ["tpkg"] }]) : [];
      const directory = kind === "import" ? null : await pickDirectory("Export profiles to folder");
      if (kind !== "import" && !directory) return;
      const profiles = rows.filter(({ profile }) => kind === "all" || selectedIds.includes(profile.id));
      const jobs = kind === "import"
        ? files.map((file, index) => ({ label: `Package ${index + 1}`, work: async () => { const result = await importProfilePackage(file); return `Imported ${result.importedProfileName}`; } }))
        : profiles.map(({ profile, running }) => ({ label: profile.name, work: async () => {
          if (running) throw new Error("Stop this profile before exporting.");
          await exportProfileToDirectory(profile.id, directory!); return `Exported ${profile.name}`;
        } }));
      total = jobs.length;
      for (const job of jobs) {
        if (cancelled.current) break;
        setProgress(`${kind === "import" ? "Importing" : "Exporting"} ${finished + 1} of ${total}…`);
        try { const message = await job.work(); succeeded++; setResults((items) => [...items, message]); }
        catch (error) { setResults((items) => [...items, `${job.label}: ${error instanceof Error ? error.message : normalizeSidecarError(error).message}`]); }
        finished++;
      }
      setProgress(`${succeeded} succeeded, ${finished - succeeded} failed, ${total - finished} skipped${cancelled.current ? " · Cancelled" : ""}.`);
    } catch (error) { setProgress(normalizeSidecarError(error).message); }
    finally { active.current = false; setBusy(false); if (kind === "import") onImported?.(); }
  }
  return <section aria-label="Batch profile transfer">
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button type="button" className={styles.secondary} disabled={busy} onClick={() => void run("import")}>Import packages</button>
      {rows.length ? <>
        <button type="button" className={styles.secondary} disabled={busy || !selectedIds.length} onClick={() => void run("selected")}>Export selected</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => void run("all")}>Export all</button>
      </> : null}
      {busy ? <button type="button" className={styles.secondary} onClick={() => { cancelled.current = true; setProgress("Cancelling after the current profile…"); }}>Cancel remaining</button> : null}
    </div>
    <small>Portable packages omit proxy passwords. Exported browser sessions are not encrypted by the app vault.</small>
    {progress ? <p role="status">{progress}</p> : null}
    {results.length ? <details open><summary>Transfer results ({results.length})</summary><ul>{results.map((message, index) => <li key={index}>{message}</li>)}</ul></details> : null}
  </section>;
}
