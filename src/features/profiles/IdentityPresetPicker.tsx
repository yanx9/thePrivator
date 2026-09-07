import { useId, useLayoutEffect, useRef, useState } from "react";
import { createIdentityDraftState, type IdentityDraftState } from "../../identityControls";
import { refreshIdentityPresets } from "../../identityPresetApi";
import type { ProfileIdentity } from "../../sidecar/types";
import styles from "./FingerprintForm.module.css";

interface Props {
  draft: IdentityDraftState;
  presets: readonly ProfileIdentity[];
  onChange: (draft: IdentityDraftState) => void;
}

// A complete replacement, not a merge: no old mask values or policies survive.
const REAL_PRESET: ProfileIdentity = {
  identityVersion: 2,
  label: "Real",
  presetId: null,
  browser: { mode: "real" },
  navigator: { mode: "real" },
  screen: { mode: "real" },
  locale: { mode: "real" },
  canvas: { mode: "real" },
  audio: { mode: "real" },
  webgl: { mode: "real" },
  webrtc: { mode: "real", policy: "real" },
  geolocation: { mode: "real", permission: "prompt" },
  mediaDevices: { mode: "real" },
  ports: { mode: "real" },
};

export function IdentityPresetPicker({ draft, presets, onChange }: Props) {
  const id = useId();
  const request = useRef<AbortController | null>(null);
  const [generated, setGenerated] = useState<ProfileIdentity[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);

  async function refresh() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setFailed(false);
    setMessage("Fetching presets from randomapi.dev…");
    try {
      const next = await refreshIdentityPresets(presets, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      setGenerated(next);
      setMessage("Presets refreshed. Choose an API preset, then Save to apply it.");
    } catch {
      if (request.current !== controller || controller.signal.aborted) return;
      controller.abort();
      setFailed(true);
      setMessage("Could not refresh presets from randomapi.dev. Previous presets and draft unchanged. Try again.");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  const selected = generated.findIndex((preset) => JSON.stringify(preset) === JSON.stringify(draft.identity));
  const isRealPreset = JSON.stringify(draft.identity) === JSON.stringify(REAL_PRESET);
  return <div className={styles.labelRow}>
    <label htmlFor={id}>Start from a preset</label>
    <div className={styles.inputAction}>
      <select id={id} value={isRealPreset ? "real" : selected >= 0 ? `api:${selected}` : ""}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "real") {
            onChange(createIdentityDraftState(structuredClone(REAL_PRESET)));
          } else if (value.startsWith("api:")) {
            const preset = generated[Number(value.slice(4))];
            if (preset) onChange(createIdentityDraftState(preset));
          }
        }}>
        <option value="">Custom</option>
        <option value="real">Real</option>
        {generated.length > 0 ? <optgroup label="Generated from API">
          {generated.map((preset, index) => <option key={index} value={`api:${index}`}>{preset.label}</option>)}
        </optgroup> : null}
      </select>
      <button type="button" className={styles.refreshButton} disabled={busy} aria-label="Refresh presets" aria-describedby={`${id}-hint`} onClick={() => void refresh()}>
        <span aria-hidden="true">↻</span> {busy ? "Refreshing…" : "Refresh"}
      </button>
    </div>
    <p className={styles.hint}>A preset sets every surface at once. Editing any field afterwards makes the identity custom.</p>
    <p className={styles.hint}>Real disables masking on every surface, restores real WebRTC and asks for geolocation permission. Changes stay in the draft until Save.</p>
    <p className={styles.hint} id={`${id}-hint`}>randomapi.dev: direct connection, not the profile proxy. Sends only OS/browser filters, no profile configuration or cookies; the provider sees your IP. Refresh does not change your draft.</p>
    <p className={styles.hint}>API supplies random Chrome desktop user agents, not necessarily the latest Chrome. Other settings come from OS-matched local templates. This does not update Chromium; review consistency warnings before saving.</p>
    {message ? <p className={failed ? styles.error : styles.hint} role={failed ? "alert" : "status"}>{message}</p> : null}
  </div>;
}
