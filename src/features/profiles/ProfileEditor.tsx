import { useCallback, useEffect, useId, useMemo, useState } from "react";

import type { EditorSection } from "../../app/routes";
import {
  type IdentityDraftState,
  createIdentityDraftState,
  parseIdentityDraftState,
} from "../../identityControls";
import { type ProxyDraftState, createProxyDraftState, parseProxyDraftState } from "../../proxyControls";
import {
  createProfile,
  listProfiles,
  normalizeSidecarError,
  updateProfile,
  updateProfileIdentity,
  updateProfileLaunch,
  updateProfileOrganization,
  updateProfileProxy,
} from "../../sidecar/client";
import type {
  IdentityWarning,
  ProfileLaunchDraft,
  ProfileOrganizationDraft,
  ProfileRecord,
} from "../../sidecar/types";
import { FingerprintForm } from "./FingerprintForm";
import { GeneralForm } from "./GeneralForm";
import { ProxyForm } from "./ProxyForm";
import styles from "./ProfileEditor.module.css";

interface ProfileEditorProps {
  /** Null opens the create flow; a record opens the edit flow for it. */
  profileId: string | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}

const SECTIONS: Array<{ id: EditorSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "proxy", label: "Proxy" },
  { id: "fingerprint", label: "Fingerprint" },
  { id: "extra", label: "Startup" },
];

interface EditorDraft {
  name: string;
  organization: ProfileOrganizationDraft;
  launch: ProfileLaunchDraft;
  proxy: ProxyDraftState;
  identity: IdentityDraftState;
}

/** Structural comparison for sections that are plain data all the way down. */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function draftFrom(profile: ProfileRecord | null): EditorDraft {
  return {
    name: profile?.name ?? "",
    organization: profile === null
      ? { folderId: null, tags: [], notes: "", favorite: false, color: null }
      : { ...profile.organization, tags: [...profile.organization.tags] },
    launch: profile === null
      ? { startupBehavior: "customUrls", startUrls: [], args: [] }
      : { ...profile.launch, startUrls: [...profile.launch.startUrls], args: [...profile.launch.args] },
    proxy: createProxyDraftState(profile?.proxy ?? null),
    identity: createIdentityDraftState(
      profile ?? {
        // A new profile starts on the real machine: a masked surface the user
        // never chose is a change they cannot explain later.
        identityVersion: 2,
        label: "Real device",
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
      },
    ),
  };
}

export function ProfileEditor({ profileId, onClose, onSaved }: ProfileEditorProps) {
  const [profile, setProfile] = useState<ProfileRecord | null>(null);
  const [draft, setDraft] = useState<EditorDraft>(() => draftFrom(null));
  const [section, setSection] = useState<EditorSection>("general");
  const [loading, setLoading] = useState(profileId !== null);
  const [saving, setSaving] = useState(false);
  // A plain message, not a SidecarClientError: "that profile is gone" is this
  // component's own conclusion, and dressing it up as a sidecar failure would
  // put a fabricated error code in front of the user.
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<IdentityWarning[]>([]);

  useEffect(() => {
    if (profileId === null) {
      setProfile(null);
      setDraft(draftFrom(null));
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const snapshot = await listProfiles();
        if (cancelled) {
          return;
        }
        const found = snapshot.profiles.find((candidate) => candidate.id === profileId) ?? null;
        setProfile(found);
        setDraft(draftFrom(found));
        setError(found === null ? "That profile no longer exists." : null);
      } catch (caught) {
        if (!cancelled) {
          setError(normalizeSidecarError(caught).message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const sectionErrorCount = useMemo(
    () => ({
      general: nameError === null ? 0 : 1,
      proxy: Object.keys(draft.proxy.errors).length,
      fingerprint: Object.keys(draft.identity.errors).length,
      extra: 0,
    }),
    [nameError, draft.proxy.errors, draft.identity.errors],
  );

  const save = useCallback(async () => {
    const trimmed = draft.name.trim();
    if (trimmed.length === 0) {
      setNameError("A profile needs a name.");
      setSection("general");
      return;
    }
    setNameError(null);

    const creating = profile === null;
    /**
     * Only touched sections are written.
     *
     * Two reasons, and both are load-bearing. A stored proxy password is never
     * loaded into the form, so the proxy draft cannot be turned back into a
     * payload at all until the user re-enters it -- writing it unconditionally
     * would make renaming such a profile impossible. And every section write
     * bumps the profile's sync revision, so saving all four on every edit would
     * manufacture conflicts between devices that changed nothing.
     */
    const changed = {
      name: creating || profile.name !== trimmed,
      organization: creating || !sameJson(profile.organization, draft.organization),
      launch: creating || !sameJson(profile.launch, draft.launch),
      proxy: creating || !sameJson(createProxyDraftState(profile.proxy), draft.proxy),
      identity: true as boolean,
    };

    // Everything is parsed before anything is written: saving section by section
    // and failing halfway would leave a profile carrying a new proxy and an old
    // fingerprint, with nothing on screen saying so.
    const proxyResult = changed.proxy ? parseProxyDraftState(draft.proxy) : null;
    if (proxyResult !== null && !proxyResult.ok) {
      setDraft((current) => ({ ...current, proxy: { ...current.proxy, errors: proxyResult.errors } }));
      setSection("proxy");
      return;
    }

    const identityResult = parseIdentityDraftState(draft.identity);
    if (!identityResult.ok) {
      setDraft((current) => ({ ...current, identity: { ...current.identity, errors: identityResult.errors } }));
      setSection("fingerprint");
      return;
    }
    changed.identity = creating || !sameJson(profile.identity, identityResult.identity);

    setSaving(true);
    setError(null);
    try {
      let id = profile?.id ?? null;
      if (id === null) {
        const created = await createProfile(trimmed);
        id = created.profile?.id ?? null;
        if (id === null) {
          throw new Error("The sidecar created a profile without returning it.");
        }
      } else if (changed.name) {
        await updateProfile(id, trimmed);
      }

      if (changed.organization) {
        await updateProfileOrganization(id, draft.organization);
      }
      if (changed.launch) {
        await updateProfileLaunch(id, draft.launch);
      }
      if (proxyResult !== null && proxyResult.ok) {
        await updateProfileProxy(id, proxyResult.proxy);
      }
      if (changed.identity) {
        const identitySaved = await updateProfileIdentity(id, identityResult.identity);
        setWarnings(identitySaved.warnings);
      }

      onSaved(id);
    } catch (caught) {
      setError(normalizeSidecarError(caught).message);
    } finally {
      setSaving(false);
    }
  }, [draft, profile, onSaved]);

  return (
    <div className={styles.editor}>
      <header className={styles.header}>
        <h1>{profileId === null ? "New profile" : draft.name || "Profile"}</h1>
        <span className={styles.spacer} />
        <button type="button" className={styles.secondary} onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className={styles.primary} onClick={() => void save()} disabled={saving || loading}>
          {saving ? "Saving…" : "Save"}
        </button>
      </header>

      {error !== null ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <nav className={styles.tabs} aria-label="Profile sections">
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={section === entry.id}
            className={styles.tab}
            onClick={() => setSection(entry.id)}
          >
            {entry.label}
            {sectionErrorCount[entry.id] > 0 ? (
              // Errors are counted per section so a save blocked on a field two
              // tabs away says where to look instead of appearing to do nothing.
              <span className={styles.tabBadge} aria-label={`${sectionErrorCount[entry.id]} problems`}>
                {sectionErrorCount[entry.id]}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className={styles.body}>
        {loading ? (
          <p className={styles.loading}>Loading profile…</p>
        ) : section === "general" ? (
          <GeneralForm
            name={draft.name}
            nameError={nameError}
            organization={draft.organization}
            onNameChange={(name) => {
              setNameError(null);
              setDraft((current) => ({ ...current, name }));
            }}
            onOrganizationChange={(organization) => setDraft((current) => ({ ...current, organization }))}
          />
        ) : section === "proxy" ? (
          <ProxyForm draft={draft.proxy} onChange={(proxy) => setDraft((current) => ({ ...current, proxy }))} />
        ) : section === "fingerprint" ? (
          <FingerprintForm
            draft={draft.identity}
            warnings={warnings}
            onChange={(identity) => setDraft((current) => ({ ...current, identity }))}
          />
        ) : (
          <StartupForm
            launch={draft.launch}
            onChange={(launch) => setDraft((current) => ({ ...current, launch }))}
          />
        )}
      </div>
    </div>
  );
}

interface StartupFormProps {
  launch: ProfileLaunchDraft;
  onChange: (launch: ProfileLaunchDraft) => void;
}

function StartupForm({ launch, onChange }: StartupFormProps) {
  const urlsId = useId();
  const argsId = useId();

  return (
    <div className={styles.startup}>
      <fieldset className={styles.fieldset}>
        <legend>On launch</legend>
        <label>
          <input
            type="radio"
            name="startupBehavior"
            checked={launch.startupBehavior === "customUrls"}
            onChange={() => onChange({ ...launch, startupBehavior: "customUrls" })}
          />
          Open these pages
        </label>
        <label>
          <input
            type="radio"
            name="startupBehavior"
            checked={launch.startupBehavior === "restoreSession"}
            onChange={() => onChange({ ...launch, startupBehavior: "restoreSession" })}
          />
          Restore the previous session
        </label>
      </fieldset>

      {/* The hint is described, not labelled: folding it into the label would
          make a screen reader announce the whole sentence as the field's name. */}
      <div className={styles.stacked}>
        <label htmlFor={urlsId}>Start pages</label>
        <textarea
          id={urlsId}
          rows={4}
          aria-describedby={`${urlsId}-hint`}
          value={launch.startUrls.join("\n")}
          placeholder={"https://example.com\nabout:blank"}
          onChange={(event) =>
            onChange({
              ...launch,
              startUrls: event.target.value
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            })
          }
        />
        <span className={styles.hint} id={`${urlsId}-hint`}>
          One address per line. Each must start with https:// or http://, or be about:blank.
        </span>
      </div>

      <div className={styles.stacked}>
        <label htmlFor={argsId}>Command line switches</label>
        <textarea
          id={argsId}
          rows={3}
          aria-describedby={`${argsId}-hint`}
          value={launch.args.join("\n")}
          placeholder="--disable-features=SomeFeature"
          onChange={(event) =>
            onChange({
              ...launch,
              args: event.target.value
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            })
          }
        />
        <span className={styles.hint} id={`${argsId}-hint`}>
          One switch per line, from the supported list. Anything that would undo the proxy or the fingerprint
          is refused when you save.
        </span>
      </div>
    </div>
  );
}
