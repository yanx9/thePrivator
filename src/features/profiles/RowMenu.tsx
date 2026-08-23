import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { MenuItem, RowAction } from "./rowMenu";
import styles from "./RowMenu.module.css";

interface RowMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onChoose: (action: RowAction) => void;
  onClose: () => void;
}

export function RowMenu({ x, y, items, onChoose, onClose }: RowMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (element === null) {
      return;
    }
    // Opening near the right or bottom edge would put half the menu off screen,
    // where the last entry -- always the destructive one -- is unreachable.
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    menuRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    // Capture, so a click anywhere closes the menu before it reaches whatever it
    // landed on -- a click through a menu is how a row gets launched by accident.
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      aria-label="Profile actions"
      tabIndex={-1}
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className={styles.item}
          data-danger={item.danger === true}
          data-separator={item.separatorBefore === true}
          disabled={item.disabledReason !== undefined}
          // The reason is spoken, not only shown: a disabled entry with no
          // explanation teaches nothing about how to make it work.
          aria-description={item.disabledReason}
          title={item.disabledReason}
          onClick={() => onChoose(item.action)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
