import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { createStore, shallowArrayEqual } from "./createStore";

describe("createStore", () => {
  it("notifies subscribers when the state changes", () => {
    const store = createStore({ count: 0 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.set({ count: 1 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ count: 1 });
  });

  it("does not notify when the reference is unchanged", () => {
    // The status poll produces an identical snapshot most of the time; treating
    // that as a change would re-render the whole grid every interval.
    const state = { count: 0 };
    const store = createStore(state);
    const listener = vi.fn();
    store.subscribe(listener);

    store.set(state);

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const store = createStore({ count: 0 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.set({ count: 1 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("re-renders a selector only when its own slice changes", () => {
    // This is the entire reason the store exists: a runtime update for one
    // profile must not re-render the rows of every other profile.
    const store = createStore({ a: 1, b: 1 });
    const renders = { a: 0, b: 0 };

    const hookA = renderHook(() => {
      renders.a += 1;
      return store.useSelector((state) => state.a);
    });
    const hookB = renderHook(() => {
      renders.b += 1;
      return store.useSelector((state) => state.b);
    });
    const before = { ...renders };

    act(() => store.set((state) => ({ ...state, a: 2 })));

    expect(hookA.result.current).toBe(2);
    expect(renders.a).toBeGreaterThan(before.a);
    expect(renders.b).toBe(before.b);
  });

  it("keeps a derived selector stable so it cannot loop", () => {
    // useSyncExternalStore compares snapshots by identity, so a selector that
    // builds an array would re-render forever without the equality cache.
    const store = createStore({ items: [1, 2, 3], other: 0 });

    const { result } = renderHook(() =>
      store.useSelector((state) => state.items.filter((item) => item > 1), shallowArrayEqual),
    );
    const first = result.current;

    act(() => store.set((state) => ({ ...state, other: 1 })));

    expect(result.current).toBe(first);
  });
});

describe("shallowArrayEqual", () => {
  it.each([
    [[1, 2, 3], [1, 2, 3], true],
    [[1, 2], [1, 2, 3], false],
    [[1, 2, 3], [1, 2, 4], false],
    [[], [], true],
  ])("compares %o and %o", (a, b, expected) => {
    expect(shallowArrayEqual(a, b)).toBe(expected);
  });
});
