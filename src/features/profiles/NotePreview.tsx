import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProfileRecord } from "../../sidecar/types";
import styles from "./ProfileTable.module.css";
import { writeToClipboard } from "../../clipboard";

export function NotePreview({ profile }: { profile: ProfileRecord }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const anchor = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const note = profile.organization.notes;
  function show() {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 380)), top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 320)) });
    setOpen(true);
  }
  function leave() { if (!pinned) leaveTimer.current = setTimeout(() => setOpen(false), 120); }
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !bubble.current?.contains(event.target)) { setOpen(false); setPinned(false); }
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); setPinned(false); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);
  if (!note) return <span className={styles.muted}>—</span>;
  return <div className={styles.notePreview} onDoubleClick={(event) => event.stopPropagation()}>
    <button ref={anchor} type="button" aria-label={`Notes for ${profile.name}`} aria-expanded={open}
      aria-describedby={open ? `note-${profile.id}` : undefined} onMouseEnter={show} onMouseLeave={leave} onFocus={show} onBlur={leave}
      onClick={(event) => { event.stopPropagation(); if (pinned) { setOpen(false); setPinned(false); } else { show(); setPinned(true); } }}>{note}</button>
    {open ? createPortal(<div ref={bubble} id={`note-${profile.id}`} role="tooltip" className={styles.noteBubble} style={position}
      onMouseEnter={show} onMouseLeave={leave}
      onPointerDown={(event) => { event.stopPropagation(); if (leaveTimer.current) clearTimeout(leaveTimer.current); setPinned(true); }}
      onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <div className={styles.noteText}>{note}</div>
      <div className={styles.noteActions}>
        <button type="button" onFocus={() => { show(); setPinned(true); }} onClick={() => {
          void writeToClipboard(note).then((copied) => setCopyStatus(copied ? "Copied" : "Clipboard unavailable. Select text and press Ctrl+C."));
        }}>Copy note</button>
        <span role="status">{copyStatus}</span>
      </div>
      <small>Edit in Profile settings → General → Notes</small>
    </div>, document.body) : null}
  </div>;
}
