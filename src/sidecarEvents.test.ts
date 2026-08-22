import { beforeEach, describe, expect, it, vi } from "vitest";

const eventModuleMock = vi.hoisted(() => ({ listen: vi.fn() }));

vi.mock("@tauri-apps/api/event", () => eventModuleMock);

import {
  CHROMIUM_STATUS_CHANGED_EVENT,
  PROFILES_CHANGED_EVENT,
  subscribeToChromiumStatusChanged,
  subscribeToProfilesChanged,
  subscribeToSidecarEvent,
} from "./sidecarEvents";

type Listener = (message: { payload?: unknown }) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("sidecar event subscriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the exact event names the Rust bridge emits", () => {
    // src-tauri/src/events.rs pins the same two strings; a mismatch would leave
    // the UI silently on the poll alone.
    expect(PROFILES_CHANGED_EVENT).toBe("theprivator://profiles-changed");
    expect(CHROMIUM_STATUS_CHANGED_EVENT).toBe("theprivator://chromium-status-changed");
  });

  it("delivers the change source to the handler", async () => {
    let listener: Listener | undefined;
    eventModuleMock.listen.mockImplementation(async (_event: string, handler: Listener) => {
      listener = handler;
      return () => {};
    });
    const handler = vi.fn();

    subscribeToProfilesChanged(handler);
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.({ payload: { source: "profiles.create" } });

    expect(handler).toHaveBeenCalledWith("profiles.create");
  });

  it("reports an unrecognised payload as an unknown source rather than throwing", async () => {
    let listener: Listener | undefined;
    eventModuleMock.listen.mockImplementation(async (_event: string, handler: Listener) => {
      listener = handler;
      return () => {};
    });
    const handler = vi.fn();

    subscribeToChromiumStatusChanged(handler);
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.({ payload: "not an object" });

    expect(handler).toHaveBeenCalledWith("unknown");
  });

  it("detaches a listener that finishes attaching after the subscription was disposed", async () => {
    // React 19 StrictMode mounts effects twice, so cleanup routinely runs while
    // listen() is still in flight. Without this the app leaks a listener per
    // mount, and every event would fire its handler more times than it mounted.
    const gate = deferred<void>();
    const unlisten = vi.fn();
    eventModuleMock.listen.mockImplementation(async () => {
      await gate.promise;
      return unlisten;
    });

    const dispose = subscribeToSidecarEvent(PROFILES_CHANGED_EVENT, vi.fn());
    // Dispose only once listen() is genuinely in flight; disposing earlier takes
    // the separate path where nothing is ever attached.
    await vi.waitFor(() => expect(eventModuleMock.listen).toHaveBeenCalledTimes(1));
    dispose();
    gate.resolve();

    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("never attaches at all when disposed before the event module loads", async () => {
    const unlisten = vi.fn();
    eventModuleMock.listen.mockResolvedValue(unlisten);

    const dispose = subscribeToSidecarEvent(PROFILES_CHANGED_EVENT, vi.fn());
    dispose();

    // Give the dynamic import a chance to resolve; the subscription must notice
    // it was disposed and skip listen() entirely rather than attach and detach.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(eventModuleMock.listen).not.toHaveBeenCalled();
    expect(unlisten).not.toHaveBeenCalled();
  });

  it("stops delivering to a disposed handler", async () => {
    let listener: Listener | undefined;
    eventModuleMock.listen.mockImplementation(async (_event: string, handler: Listener) => {
      listener = handler;
      return () => {};
    });
    const handler = vi.fn();

    const dispose = subscribeToSidecarEvent(PROFILES_CHANGED_EVENT, handler);
    await vi.waitFor(() => expect(listener).toBeDefined());
    dispose();
    listener?.({ payload: { source: "profiles.create" } });

    expect(handler).not.toHaveBeenCalled();
  });

  it("stays silent when the Tauri event API is unavailable", async () => {
    // Outside Tauri the poll alone keeps the UI correct, just less immediate.
    eventModuleMock.listen.mockRejectedValue(new Error("no event api"));
    const handler = vi.fn();

    const dispose = subscribeToSidecarEvent(PROFILES_CHANGED_EVENT, handler);

    expect(() => dispose()).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
