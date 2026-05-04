import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createProfile,
  deleteProfile,
  getSidecarHealth,
  listProfiles,
  triggerSidecarDiagnosticFailure,
  updateProfile,
} from "./sidecar/client";
import type {
  ProfileListSnapshot,
  ProfileMutationSnapshot,
  ProfileRecord,
  SidecarClientError,
  SidecarHealthSnapshot,
  SidecarUiPhase,
} from "./sidecar/types";

type HealthBusyAction = "health" | "diagnostic" | null;
type ProfilePhase = "loading" | "ready" | Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;
type ProfileMutationPhase = "idle" | "creating" | "renaming" | "deleting";
type ProfileErrorContext = "startup" | "refresh" | "create" | "rename" | "delete";

type HealthViewState = {
  phase: SidecarUiPhase;
  health: SidecarHealthSnapshot | null;
  error: SidecarClientError | null;
  lastCheckedAt: string | null;
};

type ProfileUiError = {
  context: ProfileErrorContext;
  error: SidecarClientError;
};

type EditingState = {
  id: string;
  name: string;
};

const INITIAL_HEALTH_STATE: HealthViewState = {
  phase: "loading",
  health: null,
  error: null,
  lastCheckedAt: null,
};

const HEALTH_PHASE_LABELS: Record<SidecarUiPhase, string> = {
  loading: "Checking sidecar",
  healthy: "Sidecar healthy",
  "recoverable-error": "Recoverable sidecar error",
  "bridge-error": "Sidecar unavailable",
};

const PROFILE_PHASE_LABELS: Record<ProfilePhase, string> = {
  loading: "Loading profile store",
  ready: "Profile library ready",
  "recoverable-error": "Recoverable profile error",
  "bridge-error": "Profile bridge error",
};

const PROFILE_ERROR_CONTEXT_LABELS: Record<ProfileErrorContext, string> = {
  startup: "Startup profile load",
  refresh: "Profile refresh",
  create: "Create profile",
  rename: "Rename profile",
  delete: "Delete profile",
};

const EMPTY_DETAIL_REF = "Waiting for first sidecar response";

export function App() {
  const [healthState, setHealthState] = useState<HealthViewState>(INITIAL_HEALTH_STATE);
  const [healthBusyAction, setHealthBusyAction] = useState<HealthBusyAction>("health");
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [profilePhase, setProfilePhase] = useState<ProfilePhase>("loading");
  const [profileError, setProfileError] = useState<ProfileUiError | null>(null);
  const [lastListSnapshot, setLastListSnapshot] = useState<ProfileListSnapshot | ProfileMutationSnapshot | null>(null);
  const [isProfileLoading, setIsProfileLoading] = useState(true);
  const [mutationPhase, setMutationPhase] = useState<ProfileMutationPhase>("idle");
  const [createName, setCreateName] = useState("");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<ProfileRecord | null>(null);

  const healthInFlightRef = useRef(false);
  const profileLoadInFlightRef = useRef(false);

  const applyProfileSnapshot = useCallback((snapshot: ProfileListSnapshot | ProfileMutationSnapshot) => {
    setProfiles(snapshot.profiles);
    setLastListSnapshot(snapshot);
    setProfilePhase("ready");
    setProfileError(null);
  }, []);

  const finishHealthWithError = useCallback((error: SidecarClientError) => {
    const checkedAt = new Date().toISOString();
    setHealthState({
      phase: error.phase,
      health: null,
      error,
      lastCheckedAt: checkedAt,
    });
  }, []);

  const refreshHealth = useCallback(async () => {
    if (healthInFlightRef.current) {
      return;
    }

    healthInFlightRef.current = true;
    setHealthBusyAction("health");
    setHealthState((current) => ({
      ...current,
      phase: current.health || current.error ? current.phase : "loading",
    }));

    try {
      const health = await getSidecarHealth();
      setHealthState({
        phase: "healthy",
        health,
        error: null,
        lastCheckedAt: health.checkedAt,
      });
    } catch (error) {
      finishHealthWithError(error as SidecarClientError);
    } finally {
      healthInFlightRef.current = false;
      setHealthBusyAction(null);
    }
  }, [finishHealthWithError]);

  const refreshProfiles = useCallback(
    async (context: ProfileErrorContext = "refresh") => {
      if (profileLoadInFlightRef.current) {
        return;
      }

      profileLoadInFlightRef.current = true;
      setIsProfileLoading(true);
      setProfileError(null);
      setProfilePhase((current) => (current === "ready" ? "ready" : "loading"));

      try {
        const snapshot = await listProfiles();
        applyProfileSnapshot(snapshot);
      } catch (error) {
        const clientError = error as SidecarClientError;
        setProfilePhase(clientError.phase);
        setProfileError({ context, error: clientError });
      } finally {
        profileLoadInFlightRef.current = false;
        setIsProfileLoading(false);
      }
    },
    [applyProfileSnapshot],
  );

  useEffect(() => {
    void refreshHealth();
    void refreshProfiles("startup");
  }, [refreshHealth, refreshProfiles]);

  const runProfileMutation = useCallback(
    async (
      phase: Exclude<ProfileMutationPhase, "idle">,
      context: Extract<ProfileErrorContext, "create" | "rename" | "delete">,
      operation: () => Promise<ProfileMutationSnapshot>,
      onSuccess?: () => void,
    ) => {
      if (mutationPhase !== "idle") {
        return;
      }

      setMutationPhase(phase);
      setProfileError(null);

      try {
        const snapshot = await operation();
        applyProfileSnapshot(snapshot);
        onSuccess?.();
      } catch (error) {
        const clientError = error as SidecarClientError;
        setProfilePhase(clientError.phase);
        setProfileError({ context, error: clientError });
      } finally {
        setMutationPhase("idle");
      }
    },
    [applyProfileSnapshot, mutationPhase],
  );

  const handleCreateSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void runProfileMutation("creating", "create", () => createProfile(createName), () => {
        setCreateName("");
      });
    },
    [createName, runProfileMutation],
  );

  const handleRenameSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>, profile: ProfileRecord) => {
      event.preventDefault();
      if (!editing || editing.id !== profile.id) {
        return;
      }

      void runProfileMutation("renaming", "rename", () => updateProfile(profile.id, editing.name), () => {
        setEditing(null);
      });
    },
    [editing, runProfileMutation],
  );

  const handleConfirmDelete = useCallback(
    (profile: ProfileRecord) => {
      void runProfileMutation("deleting", "delete", () => deleteProfile(profile.id), () => {
        setDeleteCandidate(null);
      });
    },
    [runProfileMutation],
  );

  const triggerDiagnosticError = useCallback(async () => {
    if (healthInFlightRef.current) {
      return;
    }

    healthInFlightRef.current = true;
    setHealthBusyAction("diagnostic");

    try {
      await triggerSidecarDiagnosticFailure();
    } catch (error) {
      finishHealthWithError(error as SidecarClientError);
    } finally {
      healthInFlightRef.current = false;
      setHealthBusyAction(null);
    }
  }, [finishHealthWithError]);

  const profileCount = profiles.length;
  const isProfileBusy = isProfileLoading || mutationPhase !== "idle";
  const isEmpty = !isProfileLoading && profileCount === 0;
  const profileTone = profilePhase === "ready" ? "ready" : profilePhase === "loading" ? "pending" : "error";

  return (
    <main className="shell profile-shell" aria-labelledby="shell-heading">
      <section className="hero-panel profile-hero" aria-label="ThePrivator profile library overview">
        <div className="hero-copy">
          <p className="kicker">M001 · S02 profile library</p>
          <h1 id="shell-heading">Persistent profile library</h1>
          <p className="hero-lede">
            Create, inspect, rename, and remove sidecar-owned browser profiles. Every card renders persisted
            profile truth from the Python store through the fixed Tauri command bridge—no localStorage shadow copy.
          </p>
        </div>

        <aside className={`phase-ribbon phase-ribbon--${profileTone}`} aria-label="Current profile phase">
          <span className="pulse-dot" aria-hidden="true" />
          <span className="phase-label">Profile phase</span>
          <strong>{profilePhase}</strong>
          <span>{PROFILE_PHASE_LABELS[profilePhase]}</span>
          <span className="ribbon-count">{profileCount} stored profiles</span>
        </aside>
      </section>

      <section className="profile-workspace" aria-label="Profile library workspace">
        <section className="library-panel" aria-labelledby="library-heading">
          <div className="section-heading">
            <div>
              <p className="kicker">Sidecar store</p>
              <h2 id="library-heading">Profiles render from startup list state.</h2>
            </div>
            <button type="button" className="button--secondary" onClick={() => void refreshProfiles("refresh")} disabled={isProfileBusy}>
              {isProfileLoading ? "Refreshing profiles…" : "Refresh profiles"}
            </button>
          </div>

          <CreateProfileForm
            createName={createName}
            isBusy={isProfileBusy}
            mutationPhase={mutationPhase}
            profileError={profileError}
            onNameChange={setCreateName}
            onSubmit={handleCreateSubmit}
          />

          <ProfileFeedback
            error={profileError}
            isLoading={isProfileLoading}
            lastListSnapshot={lastListSnapshot}
            mutationPhase={mutationPhase}
            profileCount={profileCount}
          />

          {isProfileLoading && profileCount === 0 ? (
            <div className="profile-loading" role="status" aria-live="polite">
              Loading profiles from the sidecar store…
            </div>
          ) : profileError && !lastListSnapshot && profileCount === 0 ? (
            <ProfileLoadRecoveryState isBusy={isProfileBusy} onRetry={() => void refreshProfiles("refresh")} />
          ) : isEmpty ? (
            <EmptyProfileState />
          ) : (
            <div className="profile-grid" role="list" aria-label="Stored profiles">
              {profiles.map((profile) => (
                <ProfileCard
                  key={profile.id}
                  deleteCandidate={deleteCandidate}
                  editing={editing}
                  isProfileBusy={isProfileBusy}
                  mutationPhase={mutationPhase}
                  profile={profile}
                  onCancelDelete={() => setDeleteCandidate(null)}
                  onConfirmDelete={handleConfirmDelete}
                  onDeleteRequest={setDeleteCandidate}
                  onEditNameChange={(name) => setEditing({ id: profile.id, name })}
                  onRenameCancel={() => setEditing(null)}
                  onRenameRequest={() => {
                    setDeleteCandidate(null);
                    setEditing({ id: profile.id, name: profile.name });
                  }}
                  onRenameSubmit={handleRenameSubmit}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="system-column" aria-label="Diagnostics and observability">
          <SystemStatusPanel
            healthBusyAction={healthBusyAction}
            healthState={healthState}
            onRefreshHealth={refreshHealth}
            onTriggerDiagnostic={triggerDiagnosticError}
          />
          <ProfileTelemetry
            error={profileError}
            isLoading={isProfileLoading}
            lastListSnapshot={lastListSnapshot}
            mutationPhase={mutationPhase}
            profileCount={profileCount}
            profilePhase={profilePhase}
          />
        </aside>
      </section>
    </main>
  );
}

function CreateProfileForm({
  createName,
  isBusy,
  mutationPhase,
  onNameChange,
  onSubmit,
  profileError,
}: {
  createName: string;
  isBusy: boolean;
  mutationPhase: ProfileMutationPhase;
  onNameChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  profileError: ProfileUiError | null;
}) {
  const createErrorId = profileError?.context === "create" ? "create-profile-feedback" : undefined;

  return (
    <form className="create-card" aria-label="Create profile" onSubmit={onSubmit}>
      <div>
        <label htmlFor="profile-name">Profile name</label>
        <p id="profile-name-help">Names are validated by the sidecar profile store and stay in the form after recoverable errors.</p>
      </div>
      <div className="create-controls">
        <input
          id="profile-name"
          name="profile-name"
          value={createName}
          onChange={(event) => onNameChange(event.target.value)}
          aria-describedby={createErrorId ? `profile-name-help ${createErrorId}` : "profile-name-help"}
          aria-invalid={profileError?.context === "create" ? true : undefined}
          placeholder="Research, Banking, Travel…"
          autoComplete="off"
          disabled={mutationPhase !== "idle" && mutationPhase !== "creating"}
        />
        <button type="submit" disabled={isBusy}>
          {mutationPhase === "creating" ? "Creating…" : "Create profile"}
        </button>
      </div>
    </form>
  );
}

function ProfileFeedback({
  error,
  isLoading,
  lastListSnapshot,
  mutationPhase,
  profileCount,
}: {
  error: ProfileUiError | null;
  isLoading: boolean;
  lastListSnapshot: ProfileListSnapshot | ProfileMutationSnapshot | null;
  mutationPhase: ProfileMutationPhase;
  profileCount: number;
}) {
  const message = useMemo(() => {
    if (error) {
      return PROFILE_ERROR_CONTEXT_LABELS[error.context];
    }
    if (mutationPhase !== "idle") {
      return `Profile mutation in progress: ${mutationPhase}.`;
    }
    if (isLoading) {
      return "Loading profiles from the sidecar store.";
    }
    return `Last successful profile list contains ${profileCount} ${profileCount === 1 ? "profile" : "profiles"}.`;
  }, [error, isLoading, mutationPhase, profileCount]);

  return (
    <section
      className={`profile-feedback ${error ? "profile-feedback--error" : ""}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label="Profile operation feedback"
      id={error?.context === "create" ? "create-profile-feedback" : undefined}
    >
      <strong>{message}</strong>
      {error ? (
        <>
          <p>{error.error.message}</p>
          <dl className="metric-list metric-list--inline">
            <Metric label="Code" value={error.error.code} />
            <Metric label="Source" value={error.error.source} />
            <Metric label="Recoverable" value={error.error.recoverable ? "yes" : "no"} />
            <Metric label="detailRef" value={error.error.detailRef} />
          </dl>
        </>
      ) : (
        <dl className="metric-list metric-list--inline">
          <Metric label="Mutation" value={mutationPhase} />
          <Metric label="List request" value={lastListSnapshot?.requestId} />
          <Metric label="Received" value={formatProfileTimestamp(lastListSnapshot?.receivedAt)} />
        </dl>
      )}
    </section>
  );
}

function EmptyProfileState() {
  return (
    <section className="empty-state" aria-label="Empty profile library">
      <p className="kicker">Empty store</p>
      <h2>Create the first profile to start the product loop.</h2>
      <p>
        Startup returned an empty persisted list. Add a profile name above to create a sidecar-backed record with
        typed defaults and an isolated user-data target.
      </p>
    </section>
  );
}

function ProfileLoadRecoveryState({ isBusy, onRetry }: { isBusy: boolean; onRetry: () => void }) {
  return (
    <section className="empty-state profile-recovery" aria-label="Profile load recovery">
      <p className="kicker">Profile store unavailable</p>
      <h2>Profile truth could not be loaded.</h2>
      <p>
        The prior list remains empty because no successful profile snapshot has arrived in this session. Retry the
        sidecar profile load after the bridge or store issue is fixed.
      </p>
      <button type="button" className="button--secondary" onClick={onRetry} disabled={isBusy}>
        Retry profile load
      </button>
    </section>
  );
}

function ProfileCard({
  deleteCandidate,
  editing,
  isProfileBusy,
  mutationPhase,
  onCancelDelete,
  onConfirmDelete,
  onDeleteRequest,
  onEditNameChange,
  onRenameCancel,
  onRenameRequest,
  onRenameSubmit,
  profile,
}: {
  deleteCandidate: ProfileRecord | null;
  editing: EditingState | null;
  isProfileBusy: boolean;
  mutationPhase: ProfileMutationPhase;
  onCancelDelete: () => void;
  onConfirmDelete: (profile: ProfileRecord) => void;
  onDeleteRequest: (profile: ProfileRecord) => void;
  onEditNameChange: (name: string) => void;
  onRenameCancel: () => void;
  onRenameRequest: () => void;
  onRenameSubmit: (event: FormEvent<HTMLFormElement>, profile: ProfileRecord) => void;
  profile: ProfileRecord;
}) {
  const isEditing = editing?.id === profile.id;
  const isDeleteCandidate = deleteCandidate?.id === profile.id;
  const isRenamingThis = isEditing && mutationPhase === "renaming";
  const isDeletingThis = isDeleteCandidate && mutationPhase === "deleting";
  const titleId = `profile-${profile.id}-title`;
  const renameInputId = `rename-${profile.id}`;

  return (
    <article className="profile-card" role="listitem" aria-labelledby={titleId}>
      <div className="profile-card__topline">
        <div>
          <p className="signal-label">Stored profile</p>
          <h3 id={titleId}>{profile.name}</h3>
        </div>
        <span className="status-pill">Stopped</span>
      </div>

      <dl className="profile-metadata">
        <Metric label="ID" value={profile.id} />
        <Metric label="Created" value={formatProfileTimestamp(profile.createdAt)} />
        <Metric label="Updated" value={formatProfileTimestamp(profile.updatedAt)} />
      </dl>

      <section className="defaults-panel" aria-label={`${profile.name} typed defaults`}>
        <h4>Typed defaults</h4>
        <dl className="defaults-grid">
          <Metric label="Browser" value={formatBrowser(profile.defaults.browser)} />
          <Metric label="Proxy" value={`${profile.defaults.proxyMode} proxy`} />
          <Metric label="Fingerprint" value={`${profile.defaults.fingerprintMode} fingerprinting`} />
          <Metric label="Start URL" value={profile.defaults.startUrl} />
          <Metric label="User-data target" value={profile.storage.userDataDir} />
        </dl>
      </section>

      <p className="runtime-placeholder">
        Stopped · S03 will add live Chromium launch state. This placeholder is not persisted running truth.
      </p>

      {isEditing ? (
        <form className="rename-form" aria-label={`Rename ${profile.name}`} onSubmit={(event) => onRenameSubmit(event, profile)}>
          <label htmlFor={renameInputId}>New profile name</label>
          <input
            id={renameInputId}
            value={editing.name}
            onChange={(event) => onEditNameChange(event.target.value)}
            autoComplete="off"
            aria-invalid={false}
            disabled={mutationPhase !== "idle" && !isRenamingThis}
          />
          <div className="card-actions">
            <button type="submit" disabled={isProfileBusy}>
              {isRenamingThis ? "Saving…" : "Save rename"}
            </button>
            <button type="button" className="button--secondary" onClick={onRenameCancel} disabled={isProfileBusy}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="card-actions">
          <button type="button" className="button--secondary" onClick={onRenameRequest} disabled={isProfileBusy}>
            Rename
          </button>
          <button type="button" className="button--ghost-danger" onClick={() => onDeleteRequest(profile)} disabled={isProfileBusy}>
            Delete
          </button>
        </div>
      )}

      {isDeleteCandidate ? (
        <section className="delete-confirmation" role="group" aria-label={`Confirm delete ${profile.name}`}>
          <strong>Delete {profile.name}?</strong>
          <p>
            S02 removes the profile record only. It does not promise browser user-data cleanup; that policy is deferred
            to later Chromium/import lifecycle work per D009.
          </p>
          <div className="card-actions">
            <button type="button" className="button--danger" onClick={() => onConfirmDelete(profile)} disabled={isProfileBusy} aria-label={`Confirm delete ${profile.name}`}>
              {isDeletingThis ? "Deleting…" : "Confirm delete"}
            </button>
            <button type="button" className="button--secondary" onClick={onCancelDelete} disabled={isProfileBusy}>
              Keep profile
            </button>
          </div>
        </section>
      ) : null}
    </article>
  );
}

function SystemStatusPanel({
  healthBusyAction,
  healthState,
  onRefreshHealth,
  onTriggerDiagnostic,
}: {
  healthBusyAction: HealthBusyAction;
  healthState: HealthViewState;
  onRefreshHealth: () => void;
  onTriggerDiagnostic: () => void;
}) {
  const isBusy = healthBusyAction !== null;
  const healthTone = healthState.phase === "healthy" ? "ready" : healthState.phase === "loading" ? "pending" : "error";

  return (
    <section className={`sidecar-card sidecar-card--${healthTone}`} aria-label="Compact sidecar system status">
      <div className="sidecar-card__header">
        <div>
          <p className="kicker">System status</p>
          <h2>{HEALTH_PHASE_LABELS[healthState.phase]}</h2>
        </div>
        <span className="mini-phase">{healthState.phase}</span>
      </div>

      <dl className="metric-list">
        <Metric label="Product" value={formatProductVersion(healthState.health)} />
        <Metric label="Runtime" value={formatRuntime(healthState.health)} />
        <Metric label="Bridge invoke" value={formatDuration(healthState.health?.bridgeDurationMs)} />
        <Metric label="Last checked" value={formatHealthCheckedAt(healthState.lastCheckedAt)} />
        <Metric label="detailRef" value={healthState.error?.detailRef ?? EMPTY_DETAIL_REF} />
      </dl>

      {healthState.error ? (
        <div className="system-error" role="status" aria-live="polite">
          <p>{healthState.error.message}</p>
          <dl className="metric-list metric-list--inline">
            <Metric label="Code" value={healthState.error.code} />
            <Metric label="Source" value={healthState.error.source} />
          </dl>
        </div>
      ) : null}

      <div className="system-actions">
        <button type="button" onClick={onRefreshHealth} disabled={isBusy}>
          {healthBusyAction === "health" ? "Refreshing…" : "Refresh health"}
        </button>
        <button className="button--secondary" type="button" onClick={onTriggerDiagnostic} disabled={isBusy}>
          {healthBusyAction === "diagnostic" ? "Triggering…" : "Diagnostic error"}
        </button>
      </div>
    </section>
  );
}

function ProfileTelemetry({
  error,
  isLoading,
  lastListSnapshot,
  mutationPhase,
  profileCount,
  profilePhase,
}: {
  error: ProfileUiError | null;
  isLoading: boolean;
  lastListSnapshot: ProfileListSnapshot | ProfileMutationSnapshot | null;
  mutationPhase: ProfileMutationPhase;
  profileCount: number;
  profilePhase: ProfilePhase;
}) {
  return (
    <section className="sidecar-card telemetry-card" aria-label="Profile observability">
      <p className="kicker">Profile observability</p>
      <h2>Last successful list state stays visible.</h2>
      <dl className="metric-list">
        <Metric label="Profile phase" value={profilePhase} />
        <Metric label="Loading" value={isLoading ? "yes" : "no"} />
        <Metric label="Mutation" value={mutationPhase} />
        <Metric label="Current count" value={profileCount} />
        <Metric label="List request" value={lastListSnapshot?.requestId} />
        <Metric label="List received" value={formatProfileTimestamp(lastListSnapshot?.receivedAt)} />
        <Metric label="Last error code" value={error?.error.code} />
        <Metric label="Last error source" value={error?.error.source} />
        <Metric label="Last detailRef" value={error?.error.detailRef} />
      </dl>
    </section>
  );
}

function Metric({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{formatValue(value)}</dd>
    </div>
  );
}

function formatProductVersion(snapshot: SidecarHealthSnapshot | null): string {
  if (!snapshot) {
    return "Awaiting health";
  }

  const name = formatValue(snapshot.health.product.name);
  const version = formatValue(snapshot.health.product.version);
  return `${name} ${version}`;
}

function formatRuntime(snapshot: SidecarHealthSnapshot | null): string {
  if (!snapshot) {
    return "Awaiting health";
  }

  return `${formatValue(snapshot.health.runtime.implementation)} ${formatValue(snapshot.health.runtime.pythonVersion)}`;
}

function formatDuration(value: number | undefined): string {
  return typeof value === "number" ? `${value.toFixed(2)} ms` : "Awaiting health";
}

function formatHealthCheckedAt(value: string | null): string {
  if (!value) {
    return "Not checked yet";
  }

  return formatProfileTimestamp(value);
}

function formatProfileTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "Unavailable";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString().replace("T", " ").replace(".000Z", " UTC").replace("Z", " UTC");
}

function formatBrowser(value: ProfileRecord["defaults"]["browser"]): string {
  return value === "chromium" ? "Chromium" : value;
}

function formatValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "Unavailable";
  }

  return String(value);
}
