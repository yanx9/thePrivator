import { useCallback, useEffect, useState } from "react";

import { getSidecarHealth, lookupDiagnosticDetail, normalizeSidecarError } from "../../sidecar/client";
import type { DiagnosticLookupResult, SidecarHealthSnapshot } from "../../sidecar/types";
import styles from "./SettingsPage.module.css";

/**
 * Health and the diagnostic-reference lookup.
 *
 * Errors in this app carry an opaque reference instead of a message full of
 * paths and command lines. This is where that reference is exchanged for the
 * detail behind it -- which is the whole reason the redaction is affordable:
 * the information is not destroyed, only kept out of the UI until asked for.
 */
export function DiagnosticsSettings() {
  const [health, setHealth] = useState<SidecarHealthSnapshot | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [lookup, setLookup] = useState<DiagnosticLookupResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setHealth(await getSidecarHealth());
      setHealthError(null);
    } catch (caught) {
      setHealthError(normalizeSidecarError(caught).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const look = useCallback(() => {
    const trimmed = reference.trim();
    if (trimmed.length === 0) {
      return;
    }
    setBusy(true);
    setLookupError(null);
    void (async () => {
      try {
        setLookup(await lookupDiagnosticDetail(trimmed));
      } catch (caught) {
        setLookup(null);
        setLookupError(normalizeSidecarError(caught).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [reference]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Diagnostics</h1>
        <p className={styles.lede}>
          When something fails, ThePrivator shows a short reference instead of the full detail. Paste one
          here to see what was recorded.
        </p>
      </header>

      <section className={styles.card} aria-labelledby="health-heading">
        <h2 id="health-heading">Sidecar</h2>

        {healthError !== null ? (
          <p className={styles.error} role="alert">
            {healthError}
          </p>
        ) : (
          <dl className={styles.facts}>
            <div>
              <dt>Status</dt>
              <dd>{health?.health.status ?? "Checking…"}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{health?.health.product.version ?? "—"}</dd>
            </div>
            <div>
              <dt>Protocol</dt>
              <dd>{health?.protocolVersion ?? "—"}</dd>
            </div>
            <div>
              <dt>Round trip</dt>
              <dd>{health === null ? "—" : `${Math.round(health.bridgeDurationMs)} ms`}</dd>
            </div>
          </dl>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={() => void refresh()}>
            Check again
          </button>
        </div>
      </section>

      <section className={styles.card} aria-labelledby="lookup-heading">
        <h2 id="lookup-heading">Look up a reference</h2>

        <div className={styles.inline}>
          <label className={styles.field}>
            <span>Diagnostic reference</span>
            <input
              type="text"
              value={reference}
              placeholder="sidecar-0a1b2c3d4e5f"
              onChange={(event) => setReference(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  look();
                }
              }}
            />
          </label>
          <button
            type="button"
            className={styles.primary}
            disabled={busy || reference.trim().length === 0}
            onClick={look}
          >
            {busy ? "Looking up…" : "Look up"}
          </button>
        </div>

        {lookupError !== null ? (
          <p className={styles.error} role="alert">
            {lookupError}
          </p>
        ) : null}

        {lookup !== null ? (
          lookup.entries.length === 0 ? (
            <p className={styles.hint}>Nothing was recorded under that reference.</p>
          ) : (
            <ul className={styles.list} aria-label="Diagnostic entries">
              {lookup.entries.map((entry, index) => (
                <li key={`${entry.detailRef}-${index}`}>
                  <strong>{entry.errorCode}</strong>
                  <span className={styles.hint}>
                    {entry.method ?? "no method"} · {entry.event} · {entry.status}
                  </span>
                  <span className={styles.mono}>{entry.ts}</span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </div>
  );
}
