import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { MenuItem, RowAction } from "./rowMenuHelpers";
import styles from "./RowMenu.module.css";

interface RowMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onChoose: (action: RowAction) => void;
  onClose: () => void;
}

export function RowMenu({ x, y, items, onChoose, onClose }: RowMenuProps) {
  const [expanded, setExpanded] = useState<RowAction | null>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLButtonElement | null>(null);
  const keyboardOpen = useRef(false);
  const [submenuPosition, setSubmenuPosition] = useState({ left: 0, top: 0, side: "right" });
  useLayoutEffect(() => {
    if (!expanded || !submenuRef.current || !parentRef.current) return;
    const parent = parentRef.current.getBoundingClientRect();
    const child = submenuRef.current.getBoundingClientRect();
    const flip = parent.right + child.width > window.innerWidth - 4;
    setSubmenuPosition({ left: Math.max(4, Math.min(flip ? parent.left - child.width : parent.right, window.innerWidth - child.width - 4)), top: Math.max(4, Math.min(parent.top, window.innerHeight - child.height - 4)), side: flip ? "left" : "right" });
    if (keyboardOpen.current) { submenuRef.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); keyboardOpen.current = false; }
  }, [expanded]);
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
      {items.map((item) => item.children ? (
        <div key={item.action} className={styles.submenuAnchor} onMouseLeave={() => setExpanded(null)}>
          <button type="button" role="menuitem" className={styles.item}
            aria-haspopup="menu" aria-expanded={expanded === item.action}
            disabled={item.disabledReason !== undefined}
            onMouseEnter={(event) => { parentRef.current = event.currentTarget; setExpanded(item.action); }}
            onClick={(event) => { parentRef.current = event.currentTarget; setExpanded(expanded === item.action ? null : item.action); }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              parentRef.current = event.currentTarget;
              if (expanded === item.action) {
                submenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
              } else {
                keyboardOpen.current = true;
                setExpanded(item.action);
              }
            }}>
            {item.label}<span aria-hidden="true"> ›</span>
          </button>
          {expanded === item.action ? <div ref={submenuRef} className={styles.submenu} role="menu" aria-label={item.label}
            data-side={submenuPosition.side} style={{ left: submenuPosition.left, top: submenuPosition.top }}
            onKeyDown={(event) => {
              if (["ArrowLeft", "Escape"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); setExpanded(null); parentRef.current?.focus(); }
              if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
              }
            }}>
            {item.children.map((child) => <button key={child.action} type="button" role="menuitem"
              className={styles.item} disabled={child.disabledReason !== undefined}
              title={child.disabledReason} aria-description={child.disabledReason}
              onClick={() => onChoose(child.action)}>{child.label}</button>)}
          </div> : null}
        </div>
      ) : (
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
