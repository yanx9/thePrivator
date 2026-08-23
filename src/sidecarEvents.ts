/**
 * Subscriptions to the bridge's change notifications.
 *
 * The UI's only liveness signal was a twelve-second poll, so a launch or rename
 * could sit invisible for most of that window even though the bridge already
 * knew the outcome. These events close that gap; the poll stays as the backstop
 * for a dropped or missed one, which is why every handler here must be safe to
 * run zero, one, or many times.
 *
 * The Tauri event API is reached through a dynamic import, exactly as
 * ./windowControls does, so this module is the single mockable seam and the rest
 * of the UI never imports @tauri-apps/api directly.
 */

/** Emitted when the set of profiles or their stored settings may have changed. */
export const PROFILES_CHANGED_EVENT = "theprivator://profiles-changed";

/** Emitted when a browser may have started, stopped, or been reconciled away. */
export const CHROMIUM_STATUS_CHANGED_EVENT = "theprivator://chromium-status-changed";

export type SidecarChangeSource = string;

type TauriEventModule = {
  listen?: (
    event: string,
    handler: (message: { payload?: unknown }) => void,
  ) => Promise<() => void>;
};

/** Removes the subscription. Safe to call before the listener finished attaching. */
export type Unsubscribe = () => void;

function readSource(payload: unknown): SidecarChangeSource {
  if (typeof payload === "object" && payload !== null && "source" in payload) {
    const { source } = payload as { source?: unknown };
    if (typeof source === "string") {
      return source;
    }
  }
  return "unknown";
}

/**
 * Subscribe to one bridge event.
 *
 * Returns synchronously so a React effect can use it as a cleanup function
 * directly. React 19's StrictMode mounts effects twice, so cleanup routinely
 * runs before the underlying listen() has resolved; the disposer therefore
 * records the intent and detaches once the handle exists, rather than assuming
 * it already does.
 */
export function subscribeToSidecarEvent(
  event: string,
  handler: (source: SidecarChangeSource) => void,
): Unsubscribe {
  let disposed = false;
  let detach: (() => void) | null = null;

  void (async () => {
    try {
      const eventModule = (await import("@tauri-apps/api/event")) as TauriEventModule;
      if (disposed || !eventModule.listen) {
        return;
      }
      const unlisten = await eventModule.listen(event, (message) => {
        if (!disposed) {
          handler(readSource(message?.payload));
        }
      });
      if (disposed) {
        unlisten();
        return;
      }
      detach = unlisten;
    } catch {
      // Outside Tauri, in tests, or when the API is unavailable, the poll alone
      // keeps the UI correct -- just less immediate.
    }
  })();

  return () => {
    disposed = true;
    detach?.();
    detach = null;
  };
}

export function subscribeToProfilesChanged(
  handler: (source: SidecarChangeSource) => void,
): Unsubscribe {
  return subscribeToSidecarEvent(PROFILES_CHANGED_EVENT, handler);
}

export function subscribeToChromiumStatusChanged(
  handler: (source: SidecarChangeSource) => void,
): Unsubscribe {
  return subscribeToSidecarEvent(CHROMIUM_STATUS_CHANGED_EVENT, handler);
}
