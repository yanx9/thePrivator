import { useId } from "react";

import {
  DEFAULT_PROXY_PROTOCOL,
  FIXED_PROXY_PROTOCOL_OPTIONS,
  type ProxyCredentialDraftMode,
  type ProxyDraftState,
  updateProxyDraftCredentialField,
  updateProxyDraftCredentialMode,
  updateProxyDraftField,
  updateProxyDraftMode,
} from "../../proxyControls";
import styles from "./FingerprintForm.module.css";

interface ProxyFormProps {
  draft: ProxyDraftState;
  onChange: (draft: ProxyDraftState) => void;
}

export function ProxyForm({ draft, onChange }: ProxyFormProps) {
  const ids = {
    mode: useId(),
    protocol: useId(),
    host: useId(),
    port: useId(),
    username: useId(),
    password: useId(),
  };

  return (
    <div className={styles.form}>
      <section className={styles.surface} aria-labelledby={`${ids.mode}-heading`}>
        <div className={styles.surfaceHead}>
          <h3 id={`${ids.mode}-heading`}>Connection</h3>
          <label className={styles.modeSelect}>
            <span className={styles.srOnly}>Proxy mode</span>
            <select
              id={ids.mode}
              value={draft.mode}
              onChange={(event) => onChange(updateProxyDraftMode(draft, event.target.value))}
            >
              <option value="direct">Direct connection</option>
              <option value="fixedServer">Fixed server</option>
            </select>
          </label>
        </div>

        {draft.errors.mode === undefined ? null : (
          <p className={styles.error} role="alert">
            {draft.errors.mode}
          </p>
        )}

        {draft.mode === "fixedServer" ? (
          <div className={styles.fields}>
            <div className={styles.field}>
              <label htmlFor={ids.protocol}>Protocol</label>
              <select
                id={ids.protocol}
                value={draft.protocol || DEFAULT_PROXY_PROTOCOL}
                aria-invalid={draft.errors.protocol !== undefined}
                onChange={(event) => onChange(updateProxyDraftField(draft, "protocol", event.target.value))}
              >
                {FIXED_PROXY_PROTOCOL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {draft.errors.protocol === undefined ? null : (
                <p className={styles.error} role="alert">
                  {draft.errors.protocol}
                </p>
              )}
            </div>

            <div className={styles.field}>
              <label htmlFor={ids.host}>Host</label>
              <input
                id={ids.host}
                type="text"
                value={draft.host}
                aria-invalid={draft.errors.host !== undefined}
                onChange={(event) => onChange(updateProxyDraftField(draft, "host", event.target.value))}
              />
              {draft.errors.host === undefined ? null : (
                <p className={styles.error} role="alert">
                  {draft.errors.host}
                </p>
              )}
            </div>

            <div className={styles.field}>
              <label htmlFor={ids.port}>Port</label>
              <input
                id={ids.port}
                type="text"
                inputMode="numeric"
                value={draft.port}
                aria-invalid={draft.errors.port !== undefined}
                onChange={(event) => onChange(updateProxyDraftField(draft, "port", event.target.value))}
              />
              {draft.errors.port === undefined ? null : (
                <p className={styles.error} role="alert">
                  {draft.errors.port}
                </p>
              )}
            </div>
          </div>
        ) : null}
      </section>

      {draft.mode === "fixedServer" ? (
        <section className={styles.surface} aria-labelledby={`${ids.username}-heading`}>
          <div className={styles.surfaceHead}>
            <h3 id={`${ids.username}-heading`}>Authentication</h3>
            <label className={styles.modeSelect}>
              <span className={styles.srOnly}>Credential mode</span>
              <select
                value={draft.credentialMode}
                onChange={(event) =>
                  onChange(
                    updateProxyDraftCredentialMode(draft, event.target.value as ProxyCredentialDraftMode),
                  )
                }
              >
                <option value="none">No authentication</option>
                {draft.savedCredentialState === "configured" ? (
                  <>
                    {/* Offered only when something is stored: "keep the saved
                        credentials" with nothing saved would quietly mean "none"
                        while reading as a secret that is still in place. */}
                    <option value="saved">Keep the saved credentials</option>
                    <option value="clear">Remove the saved credentials</option>
                  </>
                ) : null}
                <option value="replace">Set credentials</option>
              </select>
            </label>
          </div>

          {draft.errors.credentials === undefined ? null : (
            <p className={styles.error} role="alert">
              {draft.errors.credentials}
            </p>
          )}

          {draft.credentialMode === "replace" ? (
            <div className={styles.fields}>
              <div className={styles.field}>
                <label htmlFor={ids.username}>Username</label>
                <input
                  id={ids.username}
                  type="text"
                  autoComplete="off"
                  value={draft.credentialUsername}
                  aria-invalid={draft.errors.credentialUsername !== undefined}
                  onChange={(event) =>
                    onChange(updateProxyDraftCredentialField(draft, "username", event.target.value))
                  }
                />
                {draft.errors.credentialUsername === undefined ? null : (
                  <p className={styles.error} role="alert">
                    {draft.errors.credentialUsername}
                  </p>
                )}
              </div>

              <div className={styles.field}>
                <label htmlFor={ids.password}>Password</label>
                <input
                  id={ids.password}
                  type="password"
                  autoComplete="off"
                  value={draft.credentialPassword}
                  aria-invalid={draft.errors.credentialPassword !== undefined}
                  onChange={(event) =>
                    onChange(updateProxyDraftCredentialField(draft, "password", event.target.value))
                  }
                />
                {draft.errors.credentialPassword === undefined ? null : (
                  <p className={styles.error} role="alert">
                    {draft.errors.credentialPassword}
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
