import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * A minimal selector store.
 *
 * Context would be the obvious choice, but the status poll rewrites a runtime map
 * that the table, the sidebar, the status bar and the detail panel all read. Under
 * Context every tick re-renders every consumer subtree; with a selector each row
 * subscribes to `(s) => s.runtimeByProfile[id]` and only the rows whose runtime
 * actually changed re-render. That is the whole reason this exists rather than a
 * provider, and the reason the old UI needed a 57-prop card component to stay
 * responsive.
 *
 * No state library: the project keeps four runtime dependencies on purpose, and
 * useSyncExternalStore is what those libraries are wrapping anyway.
 */
export interface Store<S> {
  get(): S;
  set(next: S | ((current: S) => S)): void;
  subscribe(listener: () => void): () => void;
  useSelector<T>(selector: (state: S) => T, isEqual?: (a: T, b: T) => boolean): T;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();

  const get = () => state;

  const set = (next: S | ((current: S) => S)) => {
    const value = typeof next === "function" ? (next as (current: S) => S)(state) : next;
    // Bail on an unchanged reference so a no-op refresh -- which the poll produces
    // most of the time -- costs nothing.
    if (Object.is(value, state)) {
      return;
    }
    state = value;
    for (const listener of listeners) {
      listener();
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  function useSelector<T>(selector: (state: S) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
    // useSyncExternalStore compares snapshots by identity, so a selector that
    // derives an object would loop forever. The cache keeps the previous result
    // and returns it unchanged whenever isEqual says nothing moved.
    const cache = useRef<{ state: S; selected: T } | null>(null);

    const getSnapshot = useCallback(() => {
      const current = get();
      const previous = cache.current;
      if (previous !== null && Object.is(previous.state, current)) {
        return previous.selected;
      }
      const selected = selector(current);
      if (previous !== null && isEqual(previous.selected, selected)) {
        cache.current = { state: current, selected: previous.selected };
        return previous.selected;
      }
      cache.current = { state: current, selected };
      return selected;
    }, [selector, isEqual]);

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  return { get, set, subscribe, useSelector };
}

/** Compare two arrays element-by-element, for selectors that derive a list. */
export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every((item, index) => Object.is(item, b[index]));
}
