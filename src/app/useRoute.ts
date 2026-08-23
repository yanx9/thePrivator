import { useCallback, useMemo, useSyncExternalStore } from "react";

import { type Route, parseRoute, routeToHash } from "./routes";

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const readHash = () => window.location.hash;

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeToHash, readHash, readHash);
  return useMemo(() => parseRoute(hash), [hash]);
}

/**
 * Navigate without a full reload.
 *
 * Assigning location.hash is what makes the back button work; nav items are real
 * anchors and do this themselves, so this is for the places that navigate as a
 * side effect -- creating a profile, opening one from a row action.
 */
export function useNavigate(): (route: Route) => void {
  return useCallback((route: Route) => {
    const next = routeToHash(route);
    if (window.location.hash !== next) {
      window.location.hash = next;
    }
  }, []);
}
