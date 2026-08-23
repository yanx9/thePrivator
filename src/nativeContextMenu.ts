/**
 * Suppressing the webview's own right-click menu.
 *
 * WebKitGTK offers Back / Forward / Stop / Reload in every window, and Reload in
 * particular is destructive here: it throws away the whole UI state and looks to
 * the user like the app crashed. In a development build it also offers Inspect
 * Element, which is fine there and absent from a release build because the tauri
 * crate is built without its `devtools` feature.
 *
 * Editable fields keep their native menu. That menu is where cut, copy and paste
 * live, and a proxy password is exactly the kind of value someone pastes rather
 * than types -- taking it away to hide a Reload entry would be a bad trade.
 *
 * The app's own context menus are unaffected: they are React handlers on the
 * elements themselves, so they run before this document-level listener and can
 * still open. This only stops the browser from adding its menu on top.
 */

const EDITABLE = new Set(["input", "textarea"]);

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (EDITABLE.has(target.tagName.toLowerCase())) {
    // A disabled or read-only field has nothing to cut or paste into, so it gets
    // the same treatment as the rest of the chrome.
    const field = target as HTMLInputElement | HTMLTextAreaElement;
    return !field.disabled && !field.readOnly;
  }
  return target.closest("[contenteditable]:not([contenteditable='false'])") !== null;
}

/** Install the suppressor. Returns a function that removes it again. */
export function suppressNativeContextMenu(root: Document = document): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (isEditable(event.target)) {
      return;
    }
    event.preventDefault();
  };

  root.addEventListener("contextmenu", onContextMenu);
  return () => root.removeEventListener("contextmenu", onContextMenu);
}
