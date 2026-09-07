import { useId, useLayoutEffect, useRef, useState } from "react";
import { createIdentityDraftState, type IdentityDraftState } from "../../identityControls";
import { refreshIdentityPresets } from "../../identityPresetApi";
import type { ProfileIdentity } from "../../sidecar/types";
import styles from "./FingerprintForm.module.css";

interface Props {
  draft: IdentityDraftState;
  presets: readonly ProfileIdentity[];
  onChange: (draft: IdentityDraftState) => void;
  onApplyPreset: (id: string) => void;
}

export function IdentityPresetPicker({ draft, presets, onChange, onApplyPreset }: Props) {
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
  return <div className={styles.labelRow}>
    <label htmlFor={id}>Start from a preset</label>
    <div className={styles.inputAction}>
      <select id={id} value={selected >= 0 ? `api:${selected}` : draft.identity.presetId ?? ""}
        onChange={(event) => {
          const value = event.target.value;
          if (value.startsWith("api:")) {
            const preset = generated[Number(value.slice(4))];
            if (preset) onChange(createIdentityDraftState(preset));
          } else if (value) onApplyPreset(value);
        }}>
        <option value="">Custom</option>
        {generated.length > 0 ? <optgroup label="Generated from API">
          {generated.map((preset, index) => <option key={index} value={`api:${index}`}>{preset.label}</option>)}
        </optgroup> : null}
        <optgroup label="Built-in templates (offline)">
          {presets.map((preset) => <option key={preset.presetId ?? preset.label} value={preset.presetId ?? ""}>{preset.label}</option>)}
        </optgroup>
      </select>
      <button type="button" className={styles.refreshButton} disabled={busy} aria-label="Odśwież presety" aria-describedby={`${id}-hint`} onClick={() => void refresh()}>
        <span aria-hidden="true">↻</span> {busy ? "Odświeżanie…" : "Odśwież"}
      </button>
    </div>
    <p className={styles.hint}>A preset sets every surface at once. Editing any field afterwards makes the identity custom.</p>
    <p className={styles.hint} id={`${id}-hint`}>randomapi.dev: direct connection, not the profile proxy. Sends only OS/browser filters, no profile configuration or cookies; the provider sees your IP. Refresh does not change your draft.</p>
    <p className={styles.hint}>API supplies random Chrome desktop user agents, not necessarily the latest Chrome. Other settings come from OS-matched local templates. This does not update Chromium; review consistency warnings before saving.</p>
    {message ? <p className={failed ? styles.error : styles.hint} role={failed ? "alert" : "status"}>{message}</p> : null}
  </div>;
}
