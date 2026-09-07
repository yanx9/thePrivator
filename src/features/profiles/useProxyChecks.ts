import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkProfileProxy } from "../../sidecar/client";
import type { ProfileRecord } from "../../sidecar/types";
import type { ProfileRow } from "./tableModel";
import type { ProxyCheckState } from "./ProxyExit";

/** Memory only. Revision/timestamp conservatively invalidate credential-only edits,
 * since list records intentionally omit credentials. Never persist proxy secrets. */
function scope(profile: ProfileRecord): string {
  const proxy = profile.proxy;
  return JSON.stringify([profile.id, profile.updatedAt, profile.sync.revision, proxy.mode,
    proxy.credentialState, ...(proxy.mode === "fixedServer" ? [proxy.protocol, proxy.host, proxy.port] : [])]);
}
export function useProxyChecks(rows: readonly ProfileRow[]) {
  const scopes = useMemo(() => new Map(rows.map(({ profile }) => [profile.id, scope(profile)])), [rows]);
  const latest = useRef(scopes);
  latest.current = scopes;
  const [cache, setCache] = useState(new Map<string, { scope: string; state: ProxyCheckState }>());
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    setCache((current) => {
      const next = new Map([...current].filter(([id, entry]) => scopes.get(id) === entry.scope));
      return next.size === current.size ? current : next;
    });
  }, [scopes]);
  const check = useCallback(async (id: string) => {
    const key = latest.current.get(id);
    if (!key || inFlight.current.has(id)) return;
    inFlight.current.add(id);
    const update = (state: ProxyCheckState) => {
      if (latest.current.get(id) === key) setCache((current) => new Map(current).set(id, { scope: key, state }));
    };
    update({ status: "pending" });
    try {
      const result = await checkProfileProxy(id);
      update({ status: "done", result });
    } catch {
      // Do not reflect bridge/provider text: it can contain endpoint credentials.
      update({ status: "error" });
    } finally {
      inFlight.current.delete(id);
    }
  }, []);
  const states = useMemo(() => new Map([...cache].filter(([id, entry]) => scopes.get(id) === entry.scope).map(([id, entry]) => [id, entry.state])), [cache, scopes]);
  return { states, check };
}
