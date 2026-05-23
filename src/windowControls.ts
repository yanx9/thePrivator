type WindowControlHandle = {
  startDragging?: () => void | Promise<void>;
  minimize?: () => void | Promise<void>;
  toggleMaximize?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
};

type TauriWindowModule = {
  getCurrentWindow?: () => WindowControlHandle;
};

async function runWindowControl(action: (windowHandle: WindowControlHandle) => void | Promise<void>): Promise<void> {
  try {
    const windowModule = (await import("@tauri-apps/api/window")) as TauriWindowModule;
    const windowHandle = windowModule.getCurrentWindow?.();
    if (!windowHandle) {
      return;
    }

    await action(windowHandle);
  } catch {
    // Window controls are best-effort UI affordances. Outside Tauri, in tests, or
    // when a permission/API call is unavailable, keep the React tree usable.
  }
}

export function startDragging(): Promise<void> {
  return runWindowControl((windowHandle) => windowHandle.startDragging?.());
}

export function minimizeWindow(): Promise<void> {
  return runWindowControl((windowHandle) => windowHandle.minimize?.());
}

export function toggleMaximizeWindow(): Promise<void> {
  return runWindowControl((windowHandle) => windowHandle.toggleMaximize?.());
}

export function closeWindow(): Promise<void> {
  return runWindowControl((windowHandle) => windowHandle.close?.());
}
