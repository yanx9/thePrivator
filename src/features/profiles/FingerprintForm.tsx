import { useId } from "react";

import {
  type IdentityDraftFieldDescriptor,
  type IdentityDraftState,
  getIdentitySurfaceControls,
  updateIdentityDraftField,
  updateIdentityDraftLabel,
  updateIdentityDraftSurfaceMode,
} from "../../identityControls";
import type { IdentityWarning, ProfileIdentity } from "../../sidecar/types";
import styles from "./FingerprintForm.module.css";

interface FingerprintFormProps {
  draft: IdentityDraftState;
  warnings: readonly IdentityWarning[];
  /** Curated starting points, loaded lazily by the editor. */
  presets?: readonly ProfileIdentity[];
  onChange: (draft: IdentityDraftState) => void;
  onApplyPreset?: (presetId: string) => void;
}

/**
 * The fingerprint editor.
 *
 * Every control here is generated from the surface descriptors, so a new surface
 * appears as soon as the descriptor list grows -- previously adding one meant
 * edits in six places, and forgetting any of them shipped a surface the user
 * could not see or set.
 */
export function FingerprintForm({
  draft,
  warnings,
  presets,
  onChange,
  onApplyPreset,
}: FingerprintFormProps) {
  const controls = getIdentitySurfaceControls(draft.identity);
  const labelId = useId();
  const presetId = useId();

  const warningsBySurface = new Map<string, IdentityWarning[]>();
  for (const warning of warnings) {
    const existing = warningsBySurface.get(warning.surface);
    if (existing === undefined) {
      warningsBySurface.set(warning.surface, [warning]);
    } else {
      existing.push(warning);
    }
  }

  return (
    <div className={styles.form}>
      {presets !== undefined && presets.length > 0 && onApplyPreset !== undefined ? (
        <div className={styles.labelRow}>
          <label htmlFor={presetId}>Start from a preset</label>
          <select
            id={presetId}
            value={draft.identity.presetId ?? ""}
            onChange={(event) => {
              if (event.target.value !== "") {
                onApplyPreset(event.target.value);
              }
            }}
          >
            {/* The empty option is not "no preset" as a choice -- it is what a
                hand-edited identity reads as, and picking it would be a no-op
                that looks like it reverted something. */}
            <option value="">Custom</option>
            {presets.map((preset) => (
              <option key={preset.presetId ?? preset.label} value={preset.presetId ?? ""}>
                {preset.label}
              </option>
            ))}
          </select>
          <p className={styles.hint}>
            A preset sets every surface at once. Editing any field afterwards makes the identity custom.
          </p>
        </div>
      ) : null}

      <div className={styles.labelRow}>
        <label htmlFor={labelId}>Identity label</label>
        <input
          id={labelId}
          type="text"
          value={draft.values.label}
          aria-invalid={draft.errors.label !== undefined}
          aria-describedby={draft.errors.label === undefined ? undefined : `${labelId}-error`}
          onChange={(event) => onChange(updateIdentityDraftLabel(draft, event.target.value))}
        />
        {draft.errors.label === undefined ? null : (
          <p className={styles.error} id={`${labelId}-error`} role="alert">
            {draft.errors.label}
          </p>
        )}
      </div>

      {controls.map((control) => {
        const modeError = draft.errors[`${control.surface}.mode`];
        const surfaceWarnings = warningsBySurface.get(control.surface) ?? [];

        return (
          <section className={styles.surface} key={control.surface} aria-labelledby={`surface-${control.surface}`}>
            <div className={styles.surfaceHead}>
              <h3 id={`surface-${control.surface}`}>{control.label}</h3>
              <label className={styles.modeSelect}>
                <span className={styles.srOnly}>{control.label} mode</span>
                <select
                  value={control.mode}
                  aria-invalid={modeError !== undefined}
                  onChange={(event) =>
                    onChange(updateIdentityDraftSurfaceMode(draft, control.surface, event.target.value))
                  }
                >
                  {control.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <p className={styles.surfaceHint}>
              {control.options.find((option) => option.value === control.mode)?.description ?? ""}
            </p>

            {modeError === undefined ? null : (
              <p className={styles.error} role="alert">
                {modeError}
              </p>
            )}

            {surfaceWarnings.map((warning) => (
              // Warnings come from the sidecar's cross-surface consistency check.
              // An inconsistent mask makes a profile more identifiable, not less,
              // so they belong beside the control that caused them.
              <p className={styles.warning} key={warning.code} role="status">
                {warning.message}
              </p>
            ))}

            {control.fields.length === 0 ? null : (
              <div className={styles.fields}>
                {control.fields.map((field) => (
                  <Field
                    key={field.path}
                    field={field}
                    value={draft.values[field.path] ?? ""}
                    error={draft.errors[field.path]}
                    onChange={(value) => onChange(updateIdentityDraftField(draft, field.path, value))}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

interface FieldProps {
  field: IdentityDraftFieldDescriptor;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}

const WEBRTC_POLICY_OPTIONS = [
  { value: "real", label: "Report the real addresses" },
  { value: "disableNonProxiedUdp", label: "Disable non-proxied UDP" },
  { value: "block", label: "Block WebRTC" },
];

const GEOLOCATION_PERMISSION_OPTIONS = [
  { value: "prompt", label: "Ask each time" },
  { value: "allow", label: "Always allow" },
  { value: "block", label: "Always block" },
];

function Field({ field, value, error, onChange }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [field.description ? hintId : null, error !== undefined ? errorId : null]
    .filter((entry): entry is string => entry !== null)
    .join(" ");

  const shared = {
    id,
    "aria-invalid": error !== undefined,
    "aria-describedby": describedBy.length > 0 ? describedBy : undefined,
  };

  return (
    <div className={styles.field}>
      <label htmlFor={id}>{field.label}</label>

      {field.kind === "boolean" ? (
        <input
          {...shared}
          type="checkbox"
          checked={value === "true"}
          onChange={(event) => onChange(event.target.checked ? "true" : "false")}
        />
      ) : field.kind === "textarea" || field.kind === "language-list" || field.kind === "port-list" ? (
        <textarea {...shared} rows={2} value={value} onChange={(event) => onChange(event.target.value)} />
      ) : field.kind === "webrtc-policy" || field.kind === "geolocation-permission" ? (
        <select {...shared} value={value} onChange={(event) => onChange(event.target.value)}>
          {(field.kind === "webrtc-policy" ? WEBRTC_POLICY_OPTIONS : GEOLOCATION_PERMISSION_OPTIONS).map(
            (option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ),
          )}
        </select>
      ) : (
        <input
          {...shared}
          // Numeric fields stay text inputs on purpose: type=number silently
          // discards what it cannot parse, so a typo would clear the field
          // instead of producing the message that explains the mistake.
          type="text"
          inputMode={field.kind === "integer" || field.kind === "number" ? "numeric" : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      {field.description ? (
        <p className={styles.hint} id={hintId}>
          {field.description}
        </p>
      ) : null}
      {error === undefined ? null : (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
