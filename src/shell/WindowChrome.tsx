import type { MouseEvent } from "react";

import { closeWindow, minimizeWindow, startDragging, toggleMaximizeWindow } from "../windowControls";
import styles from "./WindowChrome.module.css";

/**
 * The frameless title bar.
 *
 * The window controls sit OUTSIDE the drag region on purpose: a button inside it
 * would start a window drag on press instead of firing. WebKitGTK also does not
 * implement double-click-to-maximise for a custom chrome, so the drag region does
 * it explicitly.
 */
export function WindowChrome() {
  const handleDragStart = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }
    void startDragging();
  };

  return (
    <header className={styles.chrome} aria-label="ThePrivator window chrome">
      <div
        className={styles.dragRegion}
        data-tauri-drag-region
        aria-label="Window drag region"
        onMouseDown={handleDragStart}
        onDoubleClick={() => void toggleMaximizeWindow()}
      >
        <span className={styles.mark} aria-hidden="true">
          TP
        </span>
        <span className={styles.title}>ThePrivator</span>
      </div>
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.control}
          aria-label="Minimize window"
          onClick={() => void minimizeWindow()}
        >
          <span aria-hidden="true">&#x2500;</span>
        </button>
        <button
          type="button"
          className={styles.control}
          aria-label="Maximize or restore window"
          onClick={() => void toggleMaximizeWindow()}
        >
          <span aria-hidden="true">&#x25A1;</span>
        </button>
        <button
          type="button"
          className={`${styles.control} ${styles.close}`}
          aria-label="Close window"
          onClick={() => void closeWindow()}
        >
          <span aria-hidden="true">&#x2715;</span>
        </button>
      </div>
    </header>
  );
}
