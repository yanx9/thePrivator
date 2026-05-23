import { beforeEach, describe, expect, it, vi } from "vitest";

const windowApiMock = vi.hoisted(() => ({
  close: vi.fn(),
  getCurrentWindow: vi.fn(),
  minimize: vi.fn(),
  startDragging: vi.fn(),
  toggleMaximize: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: windowApiMock.getCurrentWindow,
}));

import { closeWindow, minimizeWindow, startDragging, toggleMaximizeWindow } from "./windowControls";

function installWindowHandle() {
  const handle = {
    close: windowApiMock.close,
    minimize: windowApiMock.minimize,
    startDragging: windowApiMock.startDragging,
    toggleMaximize: windowApiMock.toggleMaximize,
  };
  windowApiMock.getCurrentWindow.mockReturnValue(handle);
  return handle;
}

describe("windowControls", () => {
  beforeEach(() => {
    windowApiMock.close.mockReset();
    windowApiMock.getCurrentWindow.mockReset();
    windowApiMock.minimize.mockReset();
    windowApiMock.startDragging.mockReset();
    windowApiMock.toggleMaximize.mockReset();
  });

  it("does not touch Tauri window APIs during module import", () => {
    expect(windowApiMock.getCurrentWindow).not.toHaveBeenCalled();
  });

  it("starts dragging the current Tauri window on demand", async () => {
    installWindowHandle();

    await startDragging();

    expect(windowApiMock.getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(windowApiMock.startDragging).toHaveBeenCalledTimes(1);
  });

  it("minimizes the current Tauri window on demand", async () => {
    installWindowHandle();

    await minimizeWindow();

    expect(windowApiMock.getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(windowApiMock.minimize).toHaveBeenCalledTimes(1);
  });

  it("toggles maximize on the current Tauri window on demand", async () => {
    installWindowHandle();

    await toggleMaximizeWindow();

    expect(windowApiMock.getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(windowApiMock.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("closes the current Tauri window on demand", async () => {
    installWindowHandle();

    await closeWindow();

    expect(windowApiMock.getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(windowApiMock.close).toHaveBeenCalledTimes(1);
  });

  it("fails safely when the Tauri window API is unavailable or rejects", async () => {
    windowApiMock.getCurrentWindow.mockImplementationOnce(() => {
      throw new Error("window internals unavailable");
    });
    await expect(startDragging()).resolves.toBeUndefined();

    windowApiMock.getCurrentWindow.mockReturnValueOnce({
      minimize: vi.fn().mockRejectedValue(new Error("permission denied")),
    });
    await expect(minimizeWindow()).resolves.toBeUndefined();

    windowApiMock.getCurrentWindow.mockReturnValueOnce({});
    await expect(closeWindow()).resolves.toBeUndefined();
  });
});
