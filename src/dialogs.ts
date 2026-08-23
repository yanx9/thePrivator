/**
 * Native file and folder pickers.
 *
 * The Tauri plugin is reached through a dynamic import, exactly as
 * ./windowControls and ./sidecarEvents do, so this module is the single seam
 * the source guard exempts and the rest of the UI never imports @tauri-apps
 * directly.
 *
 * What comes back is an absolute path chosen by the user through the operating
 * system. It is passed straight to the sidecar and never rendered: the
 * redaction perimeter treats an absolute path on screen as a leak, and the user
 * already knows which folder they just picked.
 */

type DialogModule = {
  open?: (options: {
    directory?: boolean;
    multiple?: boolean;
    title?: string;
  }) => Promise<string | string[] | null>;
};

/** Ask for a directory. Null when the user cancelled, which is not an error. */
export async function pickDirectory(title: string): Promise<string | null> {
  try {
    const module = (await import("@tauri-apps/plugin-dialog")) as DialogModule;
    if (typeof module.open !== "function") {
      return null;
    }
    const selection = await module.open({ directory: true, multiple: false, title });
    return typeof selection === "string" ? selection : null;
  } catch {
    // Outside a Tauri window there is no picker. Reporting that as a failure
    // would put an error in front of a user who simply cancelled.
    return null;
  }
}
