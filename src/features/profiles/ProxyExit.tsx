import type { ProxyCheckSnapshot } from "../../sidecar/types";
import styles from "./ProxyExit.module.css";

export interface ProxyCheckState {
  status: "pending" | "done" | "error";
  result?: ProxyCheckSnapshot;
}

export function ProxyExit({ direct, state, onCheck }: { direct: boolean; state?: ProxyCheckState; onCheck?: () => void }) {
  const ip = state?.status === "done" ? state.result?.ipHiding.publicExitIp : null;
  const location = state?.result?.ipHiding.publicExitLocation;
  const code = location?.countryCode;
  const country = code ? new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code : null;
  const pending = state?.status === "pending";
  const label = pending ? "Checking proxy…" : state?.status === "error" ? "Check failed · Retry" : state?.status === "done" ? "Exit IP unknown · Retry" : "Check proxy";
  return <span className={styles.root} aria-live="polite">
    {direct ? <span className={styles.direct}>No proxy · Direct</span> : null}
    {ip ? <span className={styles.exit}>
      {code ? <span className={styles.flag} role="img" aria-label={`${country} flag`} title={country ?? code}>{String.fromCodePoint(...[...code].map((letter) => 127397 + letter.charCodeAt(0)))}</span> : <span className={styles.flag} role="img" aria-label="Country unknown" title="Country unknown">?</span>}
      <button className={styles.ip} type="button" disabled={!onCheck} title={`${direct ? "Direct public IP (no proxy)" : "Last checked public exit IP"}: ${ip}.${onCheck ? " Click to recheck." : ""}`} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onCheck?.(); }}>{ip}</button>
    </span> : !direct || state ? <button className={styles.check} type="button" disabled={pending || !onCheck} title={state?.status === "error" ? "Proxy check failed. Verify the proxy configuration and connection, then retry." : undefined} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onCheck?.(); }}>{label}</button> : null}
  </span>;
}
