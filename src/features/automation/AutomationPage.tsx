import { useCallback, useEffect, useState } from "react";

import {
  copyAutomationApiToken,
  getAutomationApiStatus,
  normalizeSidecarError,
  startAutomationApi,
  stopAutomationApi,
} from "../../sidecar/client";
import type { AutomationApiStatusResult } from "../../sidecar/types";
import { writeToClipboard } from "../../clipboard";
import styles from "./AutomationPage.module.css";

/**
 * The local automation endpoint.
 *
 * The access token is the whole security model of this feature, so it is never
 * rendered -- not in a field, not in a tooltip, not in an error message. The
 * only way it leaves this component is into the clipboard, and even the failure
 * path is careful: a clipboard error can quote what it was asked to write, so
 * the message from it is replaced rather than shown.
 */
export function AutomationPage() {
  const [status, setStatus] = useState<AutomationApiStatusResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getAutomationApiStatus());
      setError(null);
    } catch (caught) {
      setError(normalizeSidecarError(caught).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    (label: string, work: () => Promise<AutomationApiStatusResult>) => {
      setBusy(label);
      setError(null);
      setCopyNote(null);
      void (async () => {
        try {
          setStatus(await work());
        } catch (caught) {
          setError(normalizeSidecarError(caught).message);
        } finally {
          setBusy(null);
        }
      })();
    },
    [],
  );

  const copyToken = useCallback(() => {
    setBusy("copying");
    setError(null);
    setCopyNote(null);
    void (async () => {
      try {
        const token = await copyAutomationApiToken();
        const copied = await writeToClipboard(token);
        setCopyNote(
          copied
            ? "The access token is on the clipboard. Paste it into your script now."
            : "The clipboard is unavailable in this window.",
        );
      } catch (caught) {
        // The message is replaced rather than forwarded: a clipboard failure can
        // quote the value it was asked to write, and that value is the token.
        setError("The access token could not be copied.");
      } finally {
        setBusy(null);
      }
    })();
  }, []);

  const running = status?.running ?? false;
  const url = status?.api?.url ?? null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Automation</h1>
        <p className={styles.lede}>
          A small HTTP endpoint on this machine that lets Selenium, Playwright or Puppeteer drive your
          profiles. It listens on loopback only and requires an access token.
        </p>
      </header>

      {error !== null ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {/* Both labels are load-bearing: the packaged UI smoke test addresses this
          section and this list by name, so renaming either is a contract change
          rather than a cosmetic one. */}
      <section className={styles.card} aria-label="Automation endpoint">
        <dl className={styles.facts} aria-label="Automation endpoint status">
          <div>
            <dt>State</dt>
            <dd>{status === null ? "Not checked" : running ? "Running" : "Stopped"}</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd className={styles.mono}>{url ?? "Available once running"}</dd>
          </div>
          <div>
            <dt>Reachable from</dt>
            <dd>{status?.api?.scope ?? "This machine only"}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{formatMoment(status?.process?.startedAt ?? null)}</dd>
          </div>
        </dl>

        {status?.lastError != null ? (
          <p className={styles.warning} role="status">
            {status.lastError.message}
          </p>
        ) : null}

        <div className={styles.actions} aria-label="Automation endpoint actions">
          {running ? (
            <button
              type="button"
              className={styles.secondary}
              disabled={busy !== null}
              onClick={() => act("stopping", stopAutomationApi)}
            >
              {busy === "stopping" ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button
              type="button"
              className={styles.primary}
              disabled={busy !== null}
              onClick={() => act("starting", startAutomationApi)}
            >
              {busy === "starting" ? "Starting…" : "Start"}
            </button>
          )}

          <button
            type="button"
            className={styles.secondary}
            disabled={busy !== null || !running || !(status?.copyAvailable ?? false)}
            onClick={copyToken}
          >
            {busy === "copying" ? "Copying…" : "Copy access token"}
          </button>

          <button
            type="button"
            className={styles.secondary}
            disabled={busy !== null}
            onClick={() => act("refreshing", getAutomationApiStatus)}
          >
            Refresh
          </button>
        </div>

        {copyNote !== null ? (
          <p className={styles.note} role="status">
            {copyNote}
          </p>
        ) : null}

        <p className={styles.hint}>
          The token is never shown on screen. Copying it puts it on the clipboard and nowhere else.
        </p>
      </section>
    </div>
  );
}

function formatMoment(value: string | null): string {
  if (value === null) {
    return "Not running";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}
