import { useCallback, useEffect, useState } from "react";

import {
  configureSync,
  getSyncStatus,
  normalizeSidecarError,
  planSync,
  resolveSyncConflict,
  runSync,
} from "../../sidecar/client";
import type { SyncConflictResolution, SyncPlanEntry, SyncRunResult, SyncStatusResult } from "../../sidecar/types";
import { pickDirectory } from "../../dialogs";
import styles from "./SyncSettings.module.css";

/**
 * Profile synchronisation, as the user configures it.
 *
 * The wording avoids "cloud" throughout. In this product that word would
 * suggest profiles are being uploaded to our servers, which is exactly what
 * this design does not do -- the folder belongs to the user, and whichever
 * program already syncs it moves the bytes.
 */
export function SyncSettings() {
  const [status, setStatus] = useState<SyncStatusResult | null>(null);
  const [plan, setPlan] = useState<SyncPlanEntry[] | null>(null);
  const [lastRun, setLastRun] = useState<SyncRunResult | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await getSyncStatus();
      setStatus(snapshot);
      setLabel((current) => (current === "" ? snapshot.deviceLabel : current));
      setError(null);
    } catch (caught) {
      setError(normalizeSidecarError(caught).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withBusy = useCallback(
    async (activity: string, work: () => Promise<void>) => {
      setBusy(activity);
      setError(null);
      try {
        await work();
      } catch (caught) {
        setError(normalizeSidecarError(caught).message);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const chooseFolder = () =>
    void withBusy("choosing", async () => {
      const folder = await pickDirectory("Choose the folder your sync app keeps up to date");
      if (folder === null) {
        return;
      }
      setStatus(await configureSync({ enabled: true, folder, deviceLabel: label.trim() || undefined }));
      setPlan(null);
      setLastRun(null);
    });

  const disable = () =>
    void withBusy("disabling", async () => {
      setStatus(await configureSync({ enabled: false }));
      setPlan(null);
      setLastRun(null);
    });

  const check = () =>
    void withBusy("checking", async () => {
      setPlan((await planSync()).plans);
      setLastRun(null);
    });

  const sync = () =>
    void withBusy("syncing", async () => {
      const result = await runSync();
      setLastRun(result);
      setStatus(result.status);
      setPlan(null);
    });

  const resolve = (profileId: string, resolution: SyncConflictResolution) =>
    void withBusy("resolving", async () => {
      await resolveSyncConflict(profileId, resolution);
      const result = await runSync();
      setLastRun(result);
      setStatus(result.status);
    });

  // The heading renders before the status arrives on purpose: a page that shows
  // nothing but "Loading" tells the user less than one that says what it is.
  const header = (
    <>
      <header className={styles.header}>
        <h1>Profile synchronization</h1>
        <p className={styles.lede}>
          Point ThePrivator at a folder that Google Drive, Syncthing or rclone already keeps up to date.
          Profiles travel through that folder; nothing is sent to us.
        </p>
      </header>

      {error !== null ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );

  if (status === null) {
    return (
      <div className={styles.page}>
        {header}
        {error === null ? <p className={styles.muted}>Loading…</p> : null}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {header}

      <section className={styles.card} aria-labelledby="sync-state-heading">
        <h2 id="sync-state-heading">This device</h2>

        <dl className={styles.facts}>
          <div>
            <dt>Status</dt>
            <dd>{status.enabled ? "Synchronized" : "This device only"}</dd>
          </div>
          <div>
            <dt>Folder</dt>
            <dd>{status.folderName ?? "Not chosen yet"}</dd>
          </div>
          <div>
            <dt>Profiles tracked</dt>
            <dd>{status.trackedProfiles}</dd>
          </div>
          <div>
            <dt>Last run</dt>
            <dd>{status.lastRunAt === null ? "Never" : new Date(status.lastRunAt).toLocaleString()}</dd>
          </div>
        </dl>

        {status.enabled && !status.writable ? (
          <p className={styles.warning} role="status">
            {status.detail}
          </p>
        ) : null}

        <label className={styles.field}>
          <span>Device name</span>
          <input
            type="text"
            value={label}
            maxLength={64}
            onChange={(event) => setLabel(event.target.value)}
            onBlur={() => {
              if (status.enabled && label.trim() && label.trim() !== status.deviceLabel) {
                void withBusy("renaming", async () => {
                  setStatus(await configureSync({ enabled: true, folder: undefined, deviceLabel: label.trim() }));
                });
              }
            }}
          />
          {/* Not the hostname: the label is shown to your other machines, and
              typing it back is what confirms taking a profile from one of them. */}
          <span className={styles.hint}>
            Shown on your other devices. Pick something you will recognise, not your computer&apos;s name.
          </span>
        </label>

        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy !== null} onClick={chooseFolder}>
            {status.enabled ? "Choose a different folder" : "Choose a folder"}
          </button>
          {status.enabled ? (
            <button type="button" className={styles.secondary} disabled={busy !== null} onClick={disable}>
              Turn synchronization off
            </button>
          ) : null}
        </div>
      </section>

      {status.enabled ? (
        <section className={styles.card} aria-labelledby="sync-run-heading">
          <h2 id="sync-run-heading">Synchronize now</h2>
          <p className={styles.muted}>
            Checking is read-only: it tells you what would change before anything does.
          </p>

          <div className={styles.actions}>
            <button type="button" className={styles.secondary} disabled={busy !== null} onClick={check}>
              {busy === "checking" ? "Checking…" : "Check for changes"}
            </button>
            <button type="button" className={styles.primary} disabled={busy !== null} onClick={sync}>
              {busy === "syncing" ? "Synchronizing…" : "Synchronize"}
            </button>
          </div>

          {plan !== null ? (
            plan.length === 0 ? (
              <p className={styles.muted}>Everything is already up to date.</p>
            ) : (
              <ul className={styles.list} aria-label="Pending changes">
                {plan.map((entry) => (
                  <li key={entry.profileId}>
                    <strong>{entry.name}</strong>
                    <span className={styles.reason}>{entry.reason}</span>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {lastRun !== null ? (
            <div className={styles.results}>
              <p className={styles.muted}>
                {lastRun.applied.length === 0
                  ? "Nothing needed changing."
                  : `${lastRun.applied.length} ${lastRun.applied.length === 1 ? "profile" : "profiles"} updated.`}
              </p>

              {lastRun.applied.some((entry) => entry.keptCopyAs !== null) ? (
                <p className={styles.warning} role="status">
                  Replaced browsing data was kept in the <code>conflicts</code> folder inside your profile
                  store. Nothing was deleted.
                </p>
              ) : null}

              {lastRun.failures.length > 0 ? (
                <ul className={styles.list} aria-label="Profiles that could not be synchronized">
                  {lastRun.failures.map((failure) => (
                    <li key={failure.profileId}>
                      <strong>{failure.name}</strong>
                      <span className={styles.reason}>{describeFailure(failure.code)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {lastRun !== null && lastRun.conflicts.length > 0 ? (
        <section className={styles.card} aria-labelledby="sync-conflicts-heading">
          <h2 id="sync-conflicts-heading">Needs your decision</h2>
          <p className={styles.muted}>
            These profiles changed in two places. ThePrivator will not guess which one you meant, and
            whichever you choose, the data it replaces is moved aside rather than deleted.
          </p>

          <ul className={styles.conflicts}>
            {lastRun.conflicts.map((entry) => (
              <li key={entry.profileId}>
                <div>
                  <strong>{entry.name}</strong>
                  <span className={styles.reason}>{entry.reason}</span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy !== null}
                    onClick={() => resolve(entry.profileId, "keepLocal")}
                  >
                    Keep this device&apos;s
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy !== null}
                    onClick={() => resolve(entry.profileId, "keepRemote")}
                  >
                    Keep the other device&apos;s
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy !== null}
                    onClick={() => resolve(entry.profileId, "keepBoth")}
                  >
                    Keep both
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Turn a sidecar code into something worth reading. */
function describeFailure(code: string): string {
  switch (code) {
    case "SYNC_PROFILE_BUSY":
      return "Stop this profile's browser and synchronize again.";
    case "SYNC_CONFLICT_UNRESOLVED":
      return "The other device's copy has not finished uploading yet.";
    case "SYNC_LOCK_HELD":
      return "Another device was writing this profile. Synchronize again in a moment.";
    default:
      return "This profile could not be synchronized this time.";
  }
}
