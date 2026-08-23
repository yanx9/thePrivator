/**
 * Writing to the system clipboard.
 *
 * A separate module because the one thing it is used for -- the automation
 * access token -- must never be rendered, and the error path is the risk: a
 * clipboard failure can quote the value it was asked to write. Nothing here
 * ever returns or rethrows what was passed in.
 */

/** True when the value reached the clipboard. False when there is no clipboard. */
export async function writeToClipboard(value: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") {
    return false;
  }
  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    // Deliberately swallowed rather than rethrown. The caller reports a fixed
    // message; forwarding this one could put the value on screen.
    return false;
  }
}
