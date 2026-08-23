import { useCallback, useState } from "react";

import { pickFile, pickSaveTarget } from "../../dialogs";
import {
  checkProfileProxy,
  collectIdentityAuditResults,
  exportProfileCookies,
  exportProfilePackage,
  getIdentityAuditPlan,
  normalizeSidecarError,
  openIdentityAuditPage,
  replaceProfileCookies,
} from "../../sidecar/client";
import type {
  CookieExportFormat,
  IdentityAuditCollectResult,
  IdentityAuditPlanResult,
  ProxyCheckResult,
} from "../../sidecar/types";
import styles from "./ProfileEditor.module.css";

interface ProfileToolsProps {
  profileId: string | null;
  running: boolean;
}

type Note = { tone: "ok" | "warn"; text: string };

/**
 * What a proxy check actually established.
 *
 * Split out so the wording can be tested on its own: the difference between
 * "not established" and a blank cell is the difference between telling someone
 * their traffic was not verified and letting them assume it was.
 */
export function ProxyCheckSummary({ result }: { result: ProxyCheckResult }) {
  return (
    <dl className={styles.checkFacts} aria-label="Proxy check result">
      <div>
        <dt>Route</dt>
        <dd>{result.routeProof.status}</dd>
      </div>
      <div>
        <dt>Exit address</dt>
        <dd>{result.ipHiding.publicExitIp ?? "not established"}</dd>
      </div>
      <div>
        <dt>WebRTC</dt>
        <dd>{result.webRtc.status}</dd>
      </div>
    </dl>
  );
}

interface AuditPageListProps {
  pages: IdentityAuditPlanResult["pages"];
  disabled: boolean;
  onOpen: (pageId: string) => void;
}

/**
 * The audit pages, as a list you can act on.
 *
 * Split out because of the invariant it carries: *every* page gets a button,
 * including the ones that need the user to click something on the page itself.
 * A "needs user action" row with nothing to press tells someone that something
 * is required of them and then gives them no way to do it.
 */
export function AuditPageList({ pages, disabled, onOpen }: AuditPageListProps) {
  return (
    <ul className={styles.auditList} aria-label="Audit pages">
      {pages.map((page) => (
        <li key={page.id}>
          <div>
            <strong>{page.label}</strong>
            <span className={styles.hint}>{page.comparisonNote}</span>
          </div>
          <button type="button" disabled={disabled} onClick={() => onOpen(page.id)}>
            {page.requiresUserAction ? "Open and finish by hand" : "Open"}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The things you do to a profile rather than to its settings.
 *
 * Every one of them touches the profile's own directory or its live browser,
 * which is why they sit here rather than beside the fields: exporting a profile
 * whose browser is running copies a database mid-write, and checking a proxy
 * needs a browser to check it through.
 */
export function ProfileTools({ profileId, running }: ProfileToolsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [proxyCheck, setProxyCheck] = useState<ProxyCheckResult | null>(null);
  const [auditPlan, setAuditPlan] = useState<IdentityAuditPlanResult | null>(null);
  const [auditResults, setAuditResults] = useState<IdentityAuditCollectResult | null>(null);

  const run = useCallback((activity: string, work: () => Promise<void>) => {
    setBusy(activity);
    setError(null);
    setNote(null);
    void (async () => {
      try {
        await work();
      } catch (caught) {
        setError(normalizeSidecarError(caught).message);
      } finally {
        setBusy(null);
      }
    })();
  }, []);

  if (profileId === null) {
    return (
      <p className={styles.loading}>
        These tools work on a saved profile. Save this one first, then come back.
      </p>
    );
  }

  const exportPackage = () =>
    run("package", async () => {
      const destination = await pickSaveTarget("Export this profile as a package", [
        { name: "ThePrivator package", extensions: ["tpkg"] },
      ]);
      if (destination === null) {
        return;
      }
      const result = await exportProfilePackage(profileId, destination);
      setNote({
        tone: "ok",
        text: `Exported ${result.payloadFileCount} files. Proxy passwords were left out on purpose -- whoever opens this will need their own.`,
      });
    });

  const exportCookies = (format: CookieExportFormat) =>
    run("cookies", async () => {
      const destination = await pickSaveTarget(
        format === "netscape" ? "Export cookies as cookies.txt" : "Export cookies as JSON",
        [
          format === "netscape"
            ? { name: "Netscape cookies", extensions: ["txt"] }
            : { name: "ThePrivator cookies", extensions: ["json"] },
        ],
      );
      if (destination === null) {
        return;
      }
      const result = await exportProfileCookies(profileId, destination, format);
      setNote({
        tone: result.skippedCount > 0 ? "warn" : "ok",
        text:
          result.skippedCount > 0
            ? `Exported ${result.exportedCount} sessions. ${result.skippedCount} could not be represented in this format.`
            : `Exported ${result.exportedCount} sessions.`,
      });
    });

  const replaceCookies = () =>
    run("cookies", async () => {
      const source = await pickFile("Replace this profile's cookies", [
        { name: "Cookie files", extensions: ["txt", "json"] },
      ]);
      if (source === null) {
        return;
      }
      const result = await replaceProfileCookies(profileId, source);
      setNote({
        tone: "warn",
        text: `Replaced this profile's sessions with ${result.replacedCount} from the file. The previous ones are gone.`,
      });
    });

  const check = () =>
    run("proxy", async () => {
      setProxyCheck(await checkProfileProxy(profileId));
    });

  const plan = () =>
    run("audit", async () => {
      setAuditPlan(await getIdentityAuditPlan(profileId));
      setAuditResults(null);
    });

  const collect = () =>
    run("collecting", async () => {
      setAuditResults(await collectIdentityAuditResults(profileId));
    });

  const openPage = (pageId: string) =>
    run("opening", async () => {
      await openIdentityAuditPage(profileId, pageId);
    });

  return (
    <div className={styles.general}>
      {error !== null ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {note !== null ? (
        <p className={note.tone === "warn" ? styles.error : styles.hint} role="status">
          {note.text}
        </p>
      ) : null}

      <section className={styles.fieldset}>
        <h3>Portability</h3>
        <p className={styles.hint}>
          A package carries the fingerprint, the proxy server and the browsing data, but never the proxy
          password. The browser must be stopped: copying a profile mid-write produces one that will not open.
        </p>
        <div className={styles.toolActions}>
          <button type="button" disabled={busy !== null || running} onClick={exportPackage}>
            {busy === "package" ? "Exporting…" : "Export as package"}
          </button>
          <button type="button" disabled={busy !== null || running} onClick={() => exportCookies("theprivator-json")}>
            Export sessions (JSON)
          </button>
          <button type="button" disabled={busy !== null || running} onClick={() => exportCookies("netscape")}>
            Export sessions (cookies.txt)
          </button>
          <button type="button" disabled={busy !== null || running} onClick={replaceCookies}>
            Replace sessions…
          </button>
        </div>
        {running ? <p className={styles.hint}>Stop this profile&apos;s browser to use these.</p> : null}
      </section>

      <section className={styles.fieldset}>
        <h3>Proxy</h3>
        <p className={styles.hint}>
          Checks that traffic really leaves through the proxy, and that WebRTC is not routing around it.
        </p>
        <div className={styles.toolActions}>
          <button type="button" disabled={busy !== null} onClick={check}>
            {busy === "proxy" ? "Checking…" : "Check the proxy"}
          </button>
        </div>
        {proxyCheck !== null ? <ProxyCheckSummary result={proxyCheck} /> : null}
      </section>

      <section className={styles.fieldset}>
        <h3>Fingerprint audit</h3>
        <p className={styles.hint}>
          Opens pages that report what a site actually sees, so the fingerprint can be compared against what
          this profile claims. A mask that disagrees with itself makes a profile easier to recognise, not
          harder.
        </p>
        <div className={styles.toolActions}>
          <button type="button" disabled={busy !== null} onClick={plan}>
            {busy === "audit" ? "Loading…" : "Show the audit pages"}
          </button>
          <button type="button" disabled={busy !== null || auditPlan === null} onClick={collect}>
            {busy === "collecting" ? "Collecting…" : "Collect results"}
          </button>
        </div>

        {auditPlan !== null ? (
          <AuditPageList pages={auditPlan.pages} disabled={busy !== null} onOpen={openPage} />
        ) : null}

        {auditResults !== null ? (
          <ul className={styles.auditList} aria-label="Audit results">
            {auditResults.pages.map((page) => (
              <li key={page.id}>
                <div>
                  <strong>{page.label}</strong>
                  <span className={styles.hint}>{page.status}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
