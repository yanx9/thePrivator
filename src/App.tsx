import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createProfile,
  deleteProfile,
  getChromiumStatus,
  getSidecarHealth,
  launchChromiumProfile,
  listProfiles,
  stopChromiumProfile,
  triggerSidecarDiagnosticFailure,
  updateProfile,
} from "./sidecar/client";
import type {
  ChromiumRunningProfileState,
  ChromiumStatusSnapshot,
  ChromiumStoppedProfileState,
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
type ChromiumLifecyclePhase =
  | "loading"
  | "ready"
  | "refreshing"
  | "launching"
  | "stopping"
  | Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;
type ChromiumMutationPhase = "launching" | "stopping";
type ChromiumLifecycleAction = "status" | "launch" | "stop";

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

type ChromiumLifecycleMutation = {
  profileId: string;
  phase: ChromiumMutationPhase;
} | null;

type ChromiumLifecycleError = {
  action: ChromiumLifecycleAction;
  profileId: string | null;
  error: SidecarClientError;
  occurredAt: string;
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

const CHROMIUM_PHASE_LABELS: Record<ChromiumLifecyclePhase, string> = {
  loading: "Loading Chromium runtime status",
  ready: "Chromium lifecycle ready",
  refreshing: "Refreshing Chromium runtime status",
  launching: "Launching selected profile",
  stopping: "Stopping selected profile",
  "recoverable-error": "Recoverable Chromium lifecycle error",
  "bridge-error": "Chromium bridge error",
};

const CHROMIUM_ACTION_LABELS: Record<ChromiumLifecycleAction, string> = {
  status: "Status refresh",
  launch: "Launch Chromium",
  stop: "Stop Chromium",
};

const EMPTY_DETAIL_REF = "Waiting for first sidecar response";
const CHROMIUM_STATUS_POLL_MS = 2800;

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
  const [chromiumPhase, setChromiumPhase] = useState<ChromiumLifecyclePhase>("loading");
  const [chromiumRuntimeByProfile, setChromiumRuntimeByProfile] = useState<Record<string, ChromiumRunningProfileState>>({});
  const [chromiumReconciledByProfile, setChromiumReconciledByProfile] = useState<Record<string, ChromiumStoppedProfileState>>({});
  const [chromiumMutation, setChromiumMutation] = useState<ChromiumLifecycleMutation>(null);
  const [chromiumStatusError, setChromiumStatusError] = useState<ChromiumLifecycleError | null>(null);
  const [chromiumErrorsByProfile, setChromiumErrorsByProfile] = useState<Record<string, ChromiumLifecycleError>>({});
  const [lastChromiumStatus, setLastChromiumStatus] = useState<ChromiumStatusSnapshot | null>(null);
  const [lastChromiumStatusRequestedAt, setLastChromiumStatusRequestedAt] = useState<string | null>(null);
  const [lastChromiumStatusReceivedAt, setLastChromiumStatusReceivedAt] = useState<string | null>(null);
  const [lastLifecycleError, setLastLifecycleError] = useState<ChromiumLifecycleError | null>(null);
  const [chromiumRunningCount, setChromiumRunningCount] = useState(0);
  const [isChromiumStatusRefreshing, setIsChromiumStatusRefreshing] = useState(false);

  const healthInFlightRef = useRef(false);
  const profileLoadInFlightRef = useRef(false);
  const chromiumStatusInFlightRef = useRef(false);
  const chromiumRuntimeByProfileRef = useRef<Record<string, ChromiumRunningProfileState>>({});
  const chromiumMutationRef = useRef<ChromiumLifecycleMutation>(null);

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

  const clearLifecycleErrorForProfile = useCallback((profileId: string) => {
    setChromiumErrorsByProfile((current) => {
      if (!current[profileId]) {
        return current;
      }

      const next = { ...current };
      delete next[profileId];
      return next;
    });
  }, []);

  const recordLifecycleError = useCallback((action: ChromiumLifecycleAction, error: SidecarClientError, profileId: string | null = null) => {
    const lifecycleError: ChromiumLifecycleError = {
      action,
      profileId,
      error,
      occurredAt: new Date().toISOString(),
    };

    setLastLifecycleError(lifecycleError);
    setChromiumPhase(error.phase);

    if (profileId) {
      setChromiumErrorsByProfile((current) => ({
        ...current,
        [profileId]: lifecycleError,
      }));
    } else {
      setChromiumStatusError(lifecycleError);
    }
  }, []);

  const applyChromiumStatusSnapshot = useCallback((snapshot: ChromiumStatusSnapshot) => {
    const nextRuntimeByProfile: Record<string, ChromiumRunningProfileState> = Object.fromEntries(
      snapshot.profiles.map((running) => [running.profileId, running]),
    );
    const previousRuntimeByProfile = chromiumRuntimeByProfileRef.current;

    setChromiumReconciledByProfile((current) => {
      const nextReconciledByProfile = { ...current };

      for (const profileId of Object.keys(nextRuntimeByProfile)) {
        delete nextReconciledByProfile[profileId];
      }

      for (const stopped of snapshot.reconciled) {
        nextReconciledByProfile[stopped.profileId] = stopped;
      }

      for (const [profileId, previousRunning] of Object.entries(previousRuntimeByProfile)) {
        if (nextRuntimeByProfile[profileId] || nextReconciledByProfile[profileId]) {
          continue;
        }

        nextReconciledByProfile[profileId] = {
          profileId,
          status: "stopped",
          stoppedAt: snapshot.receivedAt,
          termination: "reconciled",
          userDataDir: previousRunning.userDataDir,
        };
      }

      return nextReconciledByProfile;
    });

    chromiumRuntimeByProfileRef.current = nextRuntimeByProfile;
    setChromiumRuntimeByProfile(nextRuntimeByProfile);
    setLastChromiumStatus(snapshot);
    setLastChromiumStatusReceivedAt(snapshot.receivedAt);
    setChromiumRunningCount(snapshot.runningCount);
    setChromiumStatusError(null);
    setChromiumPhase("ready");
  }, []);

  const applyChromiumLaunchSnapshot = useCallback((snapshot: ChromiumRunningProfileState & { runningCount: number }) => {
    const running: ChromiumRunningProfileState = {
      profileId: snapshot.profileId,
      status: "running",
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      userDataDir: snapshot.userDataDir,
    };
    const nextRuntimeByProfile = {
      ...chromiumRuntimeByProfileRef.current,
      [running.profileId]: running,
    };

    chromiumRuntimeByProfileRef.current = nextRuntimeByProfile;
    setChromiumRuntimeByProfile(nextRuntimeByProfile);
    setChromiumReconciledByProfile((current) => {
      if (!current[running.profileId]) {
        return current;
      }

      const next = { ...current };
      delete next[running.profileId];
      return next;
    });
    setChromiumRunningCount(snapshot.runningCount);
    setChromiumStatusError(null);
    clearLifecycleErrorForProfile(running.profileId);
    setChromiumPhase("ready");
  }, [clearLifecycleErrorForProfile]);

  const applyChromiumStopSnapshot = useCallback((snapshot: ChromiumStoppedProfileState & { runningCount: number }) => {
    const stopped: ChromiumStoppedProfileState = {
      profileId: snapshot.profileId,
      status: "stopped",
      stoppedAt: snapshot.stoppedAt,
      termination: snapshot.termination,
      userDataDir: snapshot.userDataDir,
    };
    const nextRuntimeByProfile = { ...chromiumRuntimeByProfileRef.current };
    delete nextRuntimeByProfile[stopped.profileId];

    chromiumRuntimeByProfileRef.current = nextRuntimeByProfile;
    setChromiumRuntimeByProfile(nextRuntimeByProfile);
    setChromiumReconciledByProfile((current) => ({
      ...current,
      [stopped.profileId]: stopped,
    }));
    setChromiumRunningCount(snapshot.runningCount);
    setChromiumStatusError(null);
    clearLifecycleErrorForProfile(stopped.profileId);
    setChromiumPhase("ready");
  }, [clearLifecycleErrorForProfile]);

  const refreshChromiumStatus = useCallback(
    async (_reason: "startup" | "manual" | "poll" | "launch" | "stop" = "manual") => {
      if (chromiumStatusInFlightRef.current) {
        return;
      }

      chromiumStatusInFlightRef.current = true;
      const requestedAt = new Date().toISOString();
      setLastChromiumStatusRequestedAt(requestedAt);
      setIsChromiumStatusRefreshing(true);
      setChromiumPhase((current) => (current === "loading" ? "loading" : "refreshing"));

      try {
        const snapshot = await getChromiumStatus();
        applyChromiumStatusSnapshot(snapshot);
      } catch (error) {
        recordLifecycleError("status", error as SidecarClientError);
      } finally {
        chromiumStatusInFlightRef.current = false;
        setIsChromiumStatusRefreshing(false);
      }
    },
    [applyChromiumStatusSnapshot, recordLifecycleError],
  );

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
    void refreshChromiumStatus("startup");
  }, [refreshHealth, refreshProfiles, refreshChromiumStatus]);

  useEffect(() => {
    const pollId = window.setInterval(() => {
      void refreshChromiumStatus("poll");
    }, CHROMIUM_STATUS_POLL_MS);

    return () => window.clearInterval(pollId);
  }, [refreshChromiumStatus]);

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
      if (!editing || editing.id !== profile.id || chromiumRuntimeByProfileRef.current[profile.id] || chromiumMutationRef.current?.profileId === profile.id) {
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
      if (chromiumRuntimeByProfileRef.current[profile.id] || chromiumMutationRef.current?.profileId === profile.id) {
        return;
      }

      void runProfileMutation("deleting", "delete", () => deleteProfile(profile.id), () => {
        setDeleteCandidate(null);
      });
    },
    [runProfileMutation],
  );

  const handleLaunchProfile = useCallback(
    async (profile: ProfileRecord) => {
      if (chromiumMutationRef.current || chromiumRuntimeByProfileRef.current[profile.id]) {
        return;
      }

      const mutation = { profileId: profile.id, phase: "launching" as const };
      chromiumMutationRef.current = mutation;
      setChromiumMutation(mutation);
      setChromiumPhase("launching");
      clearLifecycleErrorForProfile(profile.id);

      try {
        const snapshot = await launchChromiumProfile(profile.id);
        applyChromiumLaunchSnapshot(snapshot);
        void refreshChromiumStatus("launch");
      } catch (error) {
        recordLifecycleError("launch", error as SidecarClientError, profile.id);
      } finally {
        chromiumMutationRef.current = null;
        setChromiumMutation(null);
      }
    },
    [applyChromiumLaunchSnapshot, clearLifecycleErrorForProfile, recordLifecycleError, refreshChromiumStatus],
  );

  const handleStopProfile = useCallback(
    async (profile: ProfileRecord) => {
      if (chromiumMutationRef.current || !chromiumRuntimeByProfileRef.current[profile.id]) {
        return;
      }

      const mutation = { profileId: profile.id, phase: "stopping" as const };
      chromiumMutationRef.current = mutation;
      setChromiumMutation(mutation);
      setChromiumPhase("stopping");
      clearLifecycleErrorForProfile(profile.id);

      try {
        const snapshot = await stopChromiumProfile(profile.id);
        applyChromiumStopSnapshot(snapshot);
        void refreshChromiumStatus("stop");
      } catch (error) {
        recordLifecycleError("stop", error as SidecarClientError, profile.id);
      } finally {
        chromiumMutationRef.current = null;
        setChromiumMutation(null);
      }
    },
    [applyChromiumStopSnapshot, clearLifecycleErrorForProfile, recordLifecycleError, refreshChromiumStatus],
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
  const chromiumTone = chromiumPhase === "ready" ? "ready" : chromiumPhase === "loading" || chromiumPhase === "refreshing" || chromiumPhase === "launching" || chromiumPhase === "stopping" ? "pending" : "error";
  const latestReconciliation = useMemo(() => getLatestStoppedState(Object.values(chromiumReconciledByProfile)), [chromiumReconciledByProfile]);

  return (
    <main className="shell profile-shell" aria-labelledby="shell-heading">
      <section className="hero-panel profile-hero" aria-label="ThePrivator Chromium profile lifecycle overview">
        <div className="hero-copy">
          <p className="kicker">M001 · S03 Chromium lifecycle</p>
          <h1 id="shell-heading">Persistent profiles, transient browsers.</h1>
          <p className="hero-lede">
            Launch and stop sidecar-owned Chromium processes for stored profiles without writing runtime truth into the
            profile records. Running state comes from process bookkeeping and is reconciled by status refreshes.
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
              <p className="kicker">Sidecar store + runtime</p>
              <h2 id="library-heading">Profiles stay durable; Chromium state stays ephemeral.</h2>
            </div>
            <div className="section-actions">
              <button type="button" className="button--secondary" onClick={() => void refreshProfiles("refresh")} disabled={isProfileBusy}>
                {isProfileLoading ? "Refreshing profiles…" : "Refresh profiles"}
              </button>
              <button type="button" className="button--secondary" onClick={() => void refreshChromiumStatus("manual")} disabled={isChromiumStatusRefreshing}>
                {isChromiumStatusRefreshing ? "Refreshing status…" : "Refresh lifecycle status"}
              </button>
            </div>
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
                  isLifecycleActionBusy={chromiumMutation !== null}
                  isProfileBusy={isProfileBusy}
                  lifecycleError={chromiumErrorsByProfile[profile.id] ?? chromiumStatusError}
                  lifecycleMutation={chromiumMutation}
                  mutationPhase={mutationPhase}
                  profile={profile}
                  reconciledState={chromiumReconciledByProfile[profile.id] ?? null}
                  runningState={chromiumRuntimeByProfile[profile.id] ?? null}
                  onCancelDelete={() => setDeleteCandidate(null)}
                  onConfirmDelete={handleConfirmDelete}
                  onDeleteRequest={setDeleteCandidate}
                  onEditNameChange={(name) => setEditing({ id: profile.id, name })}
                  onLaunch={handleLaunchProfile}
                  onRefreshStatus={() => void refreshChromiumStatus("manual")}
                  onRenameCancel={() => setEditing(null)}
                  onRenameRequest={() => {
                    setDeleteCandidate(null);
                    setEditing({ id: profile.id, name: profile.name });
                  }}
                  onRenameSubmit={handleRenameSubmit}
                  onStop={handleStopProfile}
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
            chromiumPhase={chromiumPhase}
            chromiumRunningCount={chromiumRunningCount}
            chromiumTone={chromiumTone}
            error={profileError}
            isChromiumStatusRefreshing={isChromiumStatusRefreshing}
            isLoading={isProfileLoading}
            lastChromiumStatus={lastChromiumStatus}
            lastLifecycleError={lastLifecycleError}
            lastListSnapshot={lastListSnapshot}
            lastStatusReceivedAt={lastChromiumStatusReceivedAt}
            lastStatusRequestedAt={lastChromiumStatusRequestedAt}
            latestReconciliation={latestReconciliation}
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
  isLifecycleActionBusy,
  isProfileBusy,
  lifecycleError,
  lifecycleMutation,
  mutationPhase,
  onCancelDelete,
  onConfirmDelete,
  onDeleteRequest,
  onEditNameChange,
  onLaunch,
  onRefreshStatus,
  onRenameCancel,
  onRenameRequest,
  onRenameSubmit,
  onStop,
  profile,
  reconciledState,
  runningState,
}: {
  deleteCandidate: ProfileRecord | null;
  editing: EditingState | null;
  isLifecycleActionBusy: boolean;
  isProfileBusy: boolean;
  lifecycleError: ChromiumLifecycleError | null;
  lifecycleMutation: ChromiumLifecycleMutation;
  mutationPhase: ProfileMutationPhase;
  onCancelDelete: () => void;
  onConfirmDelete: (profile: ProfileRecord) => void;
  onDeleteRequest: (profile: ProfileRecord) => void;
  onEditNameChange: (name: string) => void;
  onLaunch: (profile: ProfileRecord) => void;
  onRefreshStatus: () => void;
  onRenameCancel: () => void;
  onRenameRequest: () => void;
  onRenameSubmit: (event: FormEvent<HTMLFormElement>, profile: ProfileRecord) => void;
  onStop: (profile: ProfileRecord) => void;
  profile: ProfileRecord;
  reconciledState: ChromiumStoppedProfileState | null;
  runningState: ChromiumRunningProfileState | null;
}) {
  const isEditing = editing?.id === profile.id;
  const isDeleteCandidate = deleteCandidate?.id === profile.id;
  const isRenamingThis = isEditing && mutationPhase === "renaming";
  const isDeletingThis = isDeleteCandidate && mutationPhase === "deleting";
  const isLaunchingThis = lifecycleMutation?.profileId === profile.id && lifecycleMutation.phase === "launching";
  const isStoppingThis = lifecycleMutation?.profileId === profile.id && lifecycleMutation.phase === "stopping";
  const isRuntimeProtected = Boolean(runningState) || isLaunchingThis || isStoppingThis;
  const disableUnsafeRowActions = isProfileBusy || isRuntimeProtected;
  const disableLifecycleControls = isProfileBusy || isLifecycleActionBusy;
  const titleId = `profile-${profile.id}-title`;
  const renameInputId = `rename-${profile.id}`;
  const runtimeLabel = runningState ? "Running" : isLaunchingThis ? "Launching" : isStoppingThis ? "Stopping" : "Stopped";
  const runtimeTone = runningState ? "running" : isLaunchingThis || isStoppingThis ? "pending" : "stopped";

  const retryLifecycle = () => {
    if (!lifecycleError) {
      return;
    }

    if (lifecycleError.action === "launch") {
      onLaunch(profile);
      return;
    }

    if (lifecycleError.action === "stop") {
      onStop(profile);
      return;
    }

    onRefreshStatus();
  };

  return (
    <article className={`profile-card profile-card--${runtimeTone}`} role="listitem" aria-labelledby={titleId}>
      <div className="profile-card__topline">
        <div>
          <p className="signal-label">Stored profile</p>
          <h3 id={titleId}>{profile.name}</h3>
        </div>
        <span className={`status-pill status-pill--${runtimeTone}`} aria-label={`${profile.name} Chromium state: ${runtimeLabel}`}>
          {runtimeLabel}
        </span>
      </div>

      <dl className="profile-metadata">
        <Metric label="ID" value={profile.id} />
        <Metric label="Created" value={formatProfileTimestamp(profile.createdAt)} />
        <Metric label="Updated" value={formatProfileTimestamp(profile.updatedAt)} />
      </dl>

      <section className="runtime-panel" aria-label={`${profile.name} Chromium lifecycle`} aria-live="polite">
        <div className="runtime-panel__header">
          <div>
            <p className="signal-label">Transient Chromium state</p>
            <h4>{runningState ? "Sidecar-owned process proof" : "No running sidecar record"}</h4>
          </div>
          {runningState ? (
            <button type="button" className="button--secondary" onClick={() => onStop(profile)} disabled={disableLifecycleControls}>
              {isStoppingThis ? "Stopping…" : "Stop Chromium"}
            </button>
          ) : (
            <button type="button" onClick={() => onLaunch(profile)} disabled={disableLifecycleControls}>
              {isLaunchingThis ? "Launching…" : "Launch Chromium"}
            </button>
          )}
        </div>

        {runningState ? (
          <dl className="runtime-proof-grid">
            <Metric label="Status" value="Running from sidecar runtime bookkeeping" />
            <Metric label="PID" value={runningState.pid} />
            <Metric label="Started" value={formatProfileTimestamp(runningState.startedAt)} />
            <Metric label="Runtime truth" value="Transient; not written to profiles" />
          </dl>
        ) : reconciledState ? (
          <p className="runtime-placeholder runtime-placeholder--reconciled">
            Stopped · Last status refresh reconciled a previously running sidecar-owned process at {formatProfileTimestamp(reconciledState.stoppedAt)} ({reconciledState.termination}).
          </p>
        ) : (
          <p className="runtime-placeholder">
            Stopped · No sidecar-owned running record exists. This is transient runtime state, not durable profile truth.
          </p>
        )}
      </section>

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

      {lifecycleError ? (
        <section className="lifecycle-error" role="status" aria-live="polite" aria-label={`${profile.name} lifecycle recovery`}>
          <div>
            <strong>{CHROMIUM_ACTION_LABELS[lifecycleError.action]} failed safely.</strong>
            <p>{lifecycleError.error.message}</p>
          </div>
          <dl className="metric-list metric-list--inline">
            <Metric label="Code" value={lifecycleError.error.code} />
            <Metric label="Source" value={lifecycleError.error.source} />
            <Metric label="Recoverable" value={lifecycleError.error.recoverable ? "yes" : "no"} />
            <Metric label="detailRef" value={lifecycleError.error.detailRef} />
          </dl>
          <button type="button" className="button--secondary" onClick={retryLifecycle} disabled={disableLifecycleControls}>
            {lifecycleError.action === "status" ? "Retry status refresh" : lifecycleError.action === "stop" ? "Retry stop" : "Retry launch"}
          </button>
        </section>
      ) : null}

      {isEditing ? (
        <form className="rename-form" aria-label={`Rename ${profile.name}`} onSubmit={(event) => onRenameSubmit(event, profile)}>
          <label htmlFor={renameInputId}>New profile name</label>
          <input
            id={renameInputId}
            value={editing.name}
            onChange={(event) => onEditNameChange(event.target.value)}
            autoComplete="off"
            aria-invalid={false}
            disabled={(mutationPhase !== "idle" && !isRenamingThis) || isRuntimeProtected}
          />
          <div className="card-actions">
            <button type="submit" disabled={isProfileBusy || isRuntimeProtected}>
              {isRenamingThis ? "Saving…" : "Save rename"}
            </button>
            <button type="button" className="button--secondary" onClick={onRenameCancel} disabled={isProfileBusy}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="card-actions">
          <button type="button" className="button--secondary" onClick={onRenameRequest} disabled={disableUnsafeRowActions}>
            Rename
          </button>
          <button type="button" className="button--ghost-danger" onClick={() => onDeleteRequest(profile)} disabled={disableUnsafeRowActions}>
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
            <button type="button" className="button--danger" onClick={() => onConfirmDelete(profile)} disabled={isProfileBusy || isRuntimeProtected} aria-label={`Confirm delete ${profile.name}`}>
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
  chromiumPhase,
  chromiumRunningCount,
  chromiumTone,
  error,
  isChromiumStatusRefreshing,
  isLoading,
  lastChromiumStatus,
  lastLifecycleError,
  lastListSnapshot,
  lastStatusReceivedAt,
  lastStatusRequestedAt,
  latestReconciliation,
  mutationPhase,
  profileCount,
  profilePhase,
}: {
  chromiumPhase: ChromiumLifecyclePhase;
  chromiumRunningCount: number;
  chromiumTone: "ready" | "pending" | "error";
  error: ProfileUiError | null;
  isChromiumStatusRefreshing: boolean;
  isLoading: boolean;
  lastChromiumStatus: ChromiumStatusSnapshot | null;
  lastLifecycleError: ChromiumLifecycleError | null;
  lastListSnapshot: ProfileListSnapshot | ProfileMutationSnapshot | null;
  lastStatusReceivedAt: string | null;
  lastStatusRequestedAt: string | null;
  latestReconciliation: ChromiumStoppedProfileState | null;
  mutationPhase: ProfileMutationPhase;
  profileCount: number;
  profilePhase: ProfilePhase;
}) {
  return (
    <section className={`sidecar-card telemetry-card sidecar-card--${chromiumTone}`} aria-label="Profile observability">
      <p className="kicker">Profile observability</p>
      <h2>Durable list state and transient runtime proof stay separate.</h2>
      <dl className="metric-list">
        <Metric label="Profile phase" value={profilePhase} />
        <Metric label="Loading" value={isLoading ? "yes" : "no"} />
        <Metric label="Mutation" value={mutationPhase} />
        <Metric label="Current count" value={profileCount} />
        <Metric label="List request" value={lastListSnapshot?.requestId} />
        <Metric label="List received" value={formatProfileTimestamp(lastListSnapshot?.receivedAt)} />
        <Metric label="Lifecycle phase" value={chromiumPhase} />
        <Metric label="Lifecycle detail" value={CHROMIUM_PHASE_LABELS[chromiumPhase]} />
        <Metric label="Status refreshing" value={isChromiumStatusRefreshing ? "yes" : "no"} />
        <Metric label="Running count" value={chromiumRunningCount} />
        <Metric label="Status request" value={formatProfileTimestamp(lastStatusRequestedAt)} />
        <Metric label="Status received" value={formatProfileTimestamp(lastStatusReceivedAt)} />
        <Metric label="Status request ID" value={lastChromiumStatus?.requestId} />
        <Metric label="Last lifecycle error" value={lastLifecycleError?.error.code} />
        <Metric label="Lifecycle source" value={lastLifecycleError?.error.source} />
        <Metric label="Lifecycle detailRef" value={lastLifecycleError?.error.detailRef} />
        <Metric label="Last profile error" value={error?.error.code} />
        <Metric label="Last profile detailRef" value={error?.error.detailRef} />
        <Metric label="Last reconciliation" value={formatReconciliation(latestReconciliation)} />
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

function getLatestStoppedState(states: ChromiumStoppedProfileState[]): ChromiumStoppedProfileState | null {
  return states.reduce<ChromiumStoppedProfileState | null>((latest, current) => {
    if (!latest || Date.parse(current.stoppedAt) > Date.parse(latest.stoppedAt)) {
      return current;
    }

    return latest;
  }, null);
}

function formatReconciliation(value: ChromiumStoppedProfileState | null): string {
  if (!value) {
    return "No stale process reconciled";
  }

  return `${value.profileId} ${value.termination} at ${formatProfileTimestamp(value.stoppedAt)}`;
}

function formatValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "Unavailable";
  }

  return String(value);
}
