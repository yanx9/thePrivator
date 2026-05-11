import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createIdentityDraftState,
  formatIdentityExpectedValueSummary,
  formatIdentityMode,
  formatIdentitySummary,
  getIdentitySurfaceControls,
  markIdentityAsAdvancedOverride,
  parseIdentityDraftState,
  updateIdentityDraftField,
  updateIdentityDraftLabel,
  updateIdentityDraftSurfaceMode,
  type IdentityDraftFieldDescriptor,
  type IdentityDraftFieldPath,
  type IdentityDraftState,
} from "./identityControls";
import {
  applyProfileIdentityPreset,
  createProfile,
  deleteProfile,
  getChromiumStatus,
  getIdentityAuditPlan,
  getSidecarHealth,
  importLegacyProfiles,
  launchChromiumProfile,
  listIdentityPresets,
  listProfiles,
  lookupDiagnosticDetail,
  openIdentityAuditPage,
  scanLegacyProfiles,
  stopChromiumProfile,
  triggerSidecarDiagnosticFailure,
  updateProfile,
  updateProfileIdentity,
  validateIdentity,
} from "./sidecar/client";
import type {
  ChromiumRunningProfileState,
  ChromiumStatusSnapshot,
  ChromiumStoppedProfileState,
  DiagnosticEntry,
  DiagnosticLookupResult,
  LegacyImportOutcome,
  LegacyImportSelection,
  LegacyImportSnapshot,
  LegacyIssue,
  LegacyScanCandidate,
  LegacyScanSnapshot,
  ProfileIdentity,
  IdentitySurface,
  IdentityAuditOpenSnapshot,
  IdentityAuditPage,
  IdentityAuditPlanSnapshot,
  IdentityWarning,
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
type LegacyScanPhase = "idle" | "scanning" | "ready" | Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;
type LegacyImportPhase = "idle" | "importing" | "completed" | Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;
type LegacyImportRefreshState = {
  error: SidecarClientError;
  occurredAt: string;
} | null;

type DiagnosticLookupPhase = "idle" | "loading" | "ready" | "error";

type DiagnosticLookupState = {
  detailRef: string | null;
  phase: DiagnosticLookupPhase;
  result: DiagnosticLookupResult | null;
  error: SidecarClientError | null;
  checkedAt: string | null;
};

type IdentityConfigPhase =
  | "idle"
  | "loading-presets"
  | "validating"
  | "ready"
  | "applying-preset"
  | "saving"
  | Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;

type IdentityConfigAction = "load-presets" | "validate-saved" | "apply-preset" | "check" | "save";

type IdentityConfigError = {
  profileId: string;
  action: IdentityConfigAction;
  error: SidecarClientError;
  occurredAt: string;
};

type IdentityConfigSuccess = {
  profileId: string;
  action: Extract<IdentityConfigAction, "apply-preset" | "check" | "save">;
  presetId: string | null;
  label: string;
  warningCount: number;
  occurredAt: string;
};

type IdentityAuditPhase =
  | "idle"
  | "loading-plan"
  | "ready"
  | "opening"
  | Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;

type IdentityAuditAction = "load-plan" | "open-page";

type IdentityAuditCurrentAction = {
  action: IdentityAuditAction;
  pageId: string | null;
} | null;

type IdentityAuditError = {
  profileId: string;
  action: IdentityAuditAction;
  pageId: string | null;
  error: SidecarClientError;
  occurredAt: string;
};

type IdentityAuditOpenSuccess = Pick<IdentityAuditOpenSnapshot, "profileId" | "pageId" | "openedAt" | "launched" | "runningCount" | "requestId"> & {
  pageLabel: string;
  occurredAt: string;
};

type IdentityAuditPanelState = {
  isOpen: boolean;
  phase: IdentityAuditPhase;
  currentAction: IdentityAuditCurrentAction;
  plan: IdentityAuditPlanSnapshot | null;
  error: IdentityAuditError | null;
  openSuccess: IdentityAuditOpenSuccess | null;
};

type IdentityConfigPanelState = {
  isOpen: boolean;
  phase: IdentityConfigPhase;
  draft: IdentityDraftState | null;
  presets: ProfileIdentity[] | null;
  selectedPresetId: string;
  savedWarnings: IdentityWarning[];
  currentAction: IdentityConfigAction | null;
  error: IdentityConfigError | null;
  applySuccess: IdentityConfigSuccess | null;
};

type LegacySelectionState = Record<string, boolean>;
type LegacyTargetNameState = Record<string, string>;

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

const INITIAL_DIAGNOSTIC_LOOKUP_STATE: DiagnosticLookupState = {
  detailRef: null,
  phase: "idle",
  result: null,
  error: null,
  checkedAt: null,
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

const LEGACY_SCAN_PHASE_LABELS: Record<LegacyScanPhase, string> = {
  idle: "Waiting for a legacy root",
  scanning: "Scanning legacy profiles",
  ready: "Legacy scan ready",
  "recoverable-error": "Recoverable legacy scan error",
  "bridge-error": "Legacy scan bridge error",
};

const LEGACY_IMPORT_PHASE_LABELS: Record<LegacyImportPhase, string> = {
  idle: "No import requested",
  importing: "Importing selected legacy profiles",
  completed: "Legacy import complete",
  "recoverable-error": "Recoverable legacy import error",
  "bridge-error": "Legacy import bridge error",
};

const LEGACY_COPY_STATUS_LABELS: Record<LegacyImportOutcome["copyStatus"], string> = {
  copied: "User-data copied",
  missing: "No user-data found",
  failed: "User-data copy failed",
  skipped: "User-data copy skipped",
};

const IDENTITY_CONFIG_PHASE_LABELS: Record<IdentityConfigPhase, string> = {
  idle: "Identity panel closed",
  "loading-presets": "Loading curated presets",
  validating: "Validating saved identity",
  ready: "Identity configuration ready",
  "applying-preset": "Applying selected preset",
  saving: "Saving identity override",
  "recoverable-error": "Recoverable identity error",
  "bridge-error": "Identity bridge error",
};

const IDENTITY_CONFIG_ACTION_LABELS: Record<IdentityConfigAction, string> = {
  "load-presets": "Load curated presets",
  "validate-saved": "Saved identity validation",
  "apply-preset": "Apply identity preset",
  check: "Check identity draft",
  save: "Save identity override",
};

const IDENTITY_AUDIT_PHASE_LABELS: Record<IdentityAuditPhase, string> = {
  idle: "Audit panel closed",
  "loading-plan": "Loading guided audit plan",
  ready: "Guided audit ready",
  opening: "Opening curated checker page",
  "recoverable-error": "Recoverable audit error",
  "bridge-error": "Audit bridge error",
};

const IDENTITY_AUDIT_ACTION_LABELS: Record<IdentityAuditAction, string> = {
  "load-plan": "Load audit plan",
  "open-page": "Open curated checker page",
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
  const [legacyRoot, setLegacyRoot] = useState("");
  const [legacyScannedRoot, setLegacyScannedRoot] = useState<string | null>(null);
  const [legacyScanPhase, setLegacyScanPhase] = useState<LegacyScanPhase>("idle");
  const [legacyScanSnapshot, setLegacyScanSnapshot] = useState<LegacyScanSnapshot | null>(null);
  const [legacySelectedById, setLegacySelectedById] = useState<LegacySelectionState>({});
  const [legacyTargetNamesById, setLegacyTargetNamesById] = useState<LegacyTargetNameState>({});
  const [legacyImportPhase, setLegacyImportPhase] = useState<LegacyImportPhase>("idle");
  const [legacyImportSnapshot, setLegacyImportSnapshot] = useState<LegacyImportSnapshot | null>(null);
  const [legacyScanError, setLegacyScanError] = useState<SidecarClientError | null>(null);
  const [legacyImportError, setLegacyImportError] = useState<SidecarClientError | null>(null);
  const [legacyImportRefreshState, setLegacyImportRefreshState] = useState<LegacyImportRefreshState>(null);
  const [diagnosticLookupState, setDiagnosticLookupState] = useState<DiagnosticLookupState>(INITIAL_DIAGNOSTIC_LOOKUP_STATE);
  const [identityPanelProfileId, setIdentityPanelProfileId] = useState<string | null>(null);
  const [identityDraft, setIdentityDraft] = useState<IdentityDraftState | null>(null);
  const [identityConfigPhase, setIdentityConfigPhase] = useState<IdentityConfigPhase>("idle");
  const [identityPresetCache, setIdentityPresetCache] = useState<ProfileIdentity[] | null>(null);
  const [selectedIdentityPresetId, setSelectedIdentityPresetId] = useState("");
  const [savedIdentityWarnings, setSavedIdentityWarnings] = useState<IdentityWarning[]>([]);
  const [identityCurrentAction, setIdentityCurrentAction] = useState<IdentityConfigAction | null>(null);
  const [identityConfigError, setIdentityConfigError] = useState<IdentityConfigError | null>(null);
  const [identityConfigSuccess, setIdentityConfigSuccess] = useState<IdentityConfigSuccess | null>(null);
  const [identityAuditPanelProfileId, setIdentityAuditPanelProfileId] = useState<string | null>(null);
  const [identityAuditPhase, setIdentityAuditPhase] = useState<IdentityAuditPhase>("idle");
  const [identityAuditCurrentAction, setIdentityAuditCurrentAction] = useState<IdentityAuditCurrentAction>(null);
  const [identityAuditPlan, setIdentityAuditPlan] = useState<IdentityAuditPlanSnapshot | null>(null);
  const [identityAuditError, setIdentityAuditError] = useState<IdentityAuditError | null>(null);
  const [identityAuditOpenSuccess, setIdentityAuditOpenSuccess] = useState<IdentityAuditOpenSuccess | null>(null);

  const healthInFlightRef = useRef(false);
  const profileLoadInFlightRef = useRef(false);
  const chromiumStatusInFlightRef = useRef(false);
  const diagnosticLookupRequestIdRef = useRef(0);
  const identityConfigRequestIdRef = useRef(0);
  const identityAuditRequestIdRef = useRef(0);
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

  const refreshProfilesAfterLegacyImport = useCallback(async () => {
    if (profileLoadInFlightRef.current) {
      const busyError = makeLegacyUiError(
        "LEGACY_PROFILE_REFRESH_BUSY",
        "Profile refresh is already running; imported outcomes remain visible and the list can be refreshed manually.",
      );
      setLegacyImportRefreshState({ error: busyError, occurredAt: new Date().toISOString() });
      return;
    }

    profileLoadInFlightRef.current = true;
    setIsProfileLoading(true);
    setProfileError(null);
    setProfilePhase((current) => (current === "ready" ? "ready" : "loading"));

    try {
      const snapshot = await listProfiles();
      applyProfileSnapshot(snapshot);
      setLegacyImportRefreshState(null);
    } catch (error) {
      const clientError = error as SidecarClientError;
      setProfilePhase(clientError.phase);
      setProfileError({ context: "refresh", error: clientError });
      setLegacyImportRefreshState({ error: clientError, occurredAt: new Date().toISOString() });
    } finally {
      profileLoadInFlightRef.current = false;
      setIsProfileLoading(false);
    }
  }, [applyProfileSnapshot]);

  const handleLegacyRootChange = useCallback((value: string) => {
    setLegacyRoot(value);
    if (value.trim()) {
      setLegacyScanError(null);
    }
  }, []);

  const handleLegacyScanSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const normalizedRoot = legacyRoot.trim();

      if (!normalizedRoot) {
        setLegacyScanError(makeLegacyUiError("LEGACY_ROOT_REQUIRED", "Enter a legacy ThePrivator profile root before scanning."));
        setLegacyScanPhase("recoverable-error");
        return;
      }

      setLegacyScanPhase("scanning");
      setLegacyScanError(null);

      try {
        const snapshot = await scanLegacyProfiles(normalizedRoot);
        setLegacyScanSnapshot(snapshot);
        setLegacyScannedRoot(normalizedRoot);
        setLegacyTargetNamesById(Object.fromEntries(snapshot.candidates.map((candidate) => [candidate.legacyId, candidate.targetName])));
        setLegacySelectedById({});
        setLegacyImportPhase("idle");
        setLegacyImportSnapshot(null);
        setLegacyImportError(null);
        setLegacyImportRefreshState(null);
        setLegacyScanPhase("ready");
      } catch (error) {
        const clientError = error as SidecarClientError;
        setLegacyScanError(clientError);
        setLegacyScanPhase(clientError.phase);
      }
    },
    [legacyRoot],
  );

  const handleLegacySelectionChange = useCallback((legacyId: string, selected: boolean) => {
    setLegacySelectedById((current) => ({
      ...current,
      [legacyId]: selected,
    }));
  }, []);

  const handleLegacyTargetNameChange = useCallback((legacyId: string, targetName: string) => {
    setLegacyTargetNamesById((current) => ({
      ...current,
      [legacyId]: targetName,
    }));
  }, []);

  const handleLegacyImportSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (!legacyScanSnapshot || !legacyScannedRoot) {
        setLegacyImportError(makeLegacyUiError("LEGACY_SCAN_REQUIRED", "Scan a legacy root before importing selected profiles."));
        setLegacyImportPhase("recoverable-error");
        return;
      }

      if (legacyRoot.trim() !== legacyScannedRoot) {
        setLegacyImportError(makeLegacyUiError("LEGACY_SCAN_STALE", "The path changed after the last scan. Rescan before importing."));
        setLegacyImportPhase("recoverable-error");
        return;
      }

      const items: LegacyImportSelection[] = legacyScanSnapshot.candidates
        .filter((candidate) => legacySelectedById[candidate.legacyId])
        .map((candidate) => ({
          legacyId: candidate.legacyId,
          targetName: legacyTargetNamesById[candidate.legacyId] ?? candidate.targetName,
        }));

      if (items.length === 0) {
        setLegacyImportError(makeLegacyUiError("LEGACY_IMPORT_SELECTION_REQUIRED", "Select at least one scanned profile before importing."));
        setLegacyImportPhase("recoverable-error");
        return;
      }

      setLegacyImportPhase("importing");
      setLegacyImportError(null);
      setLegacyImportRefreshState(null);

      try {
        const snapshot = await importLegacyProfiles(legacyScannedRoot, items);
        setLegacyImportSnapshot(snapshot);
        setLegacyImportPhase("completed");
        if (snapshot.successCount + snapshot.partialCount > 0) {
          await refreshProfilesAfterLegacyImport();
        }
      } catch (error) {
        const clientError = error as SidecarClientError;
        setLegacyImportError(clientError);
        setLegacyImportPhase(clientError.phase);
      }
    },
    [legacyRoot, legacyScanSnapshot, legacyScannedRoot, legacySelectedById, legacyTargetNamesById, refreshProfilesAfterLegacyImport],
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

  const runDiagnosticLookup = useCallback(async (detailRef: string) => {
    const requestId = diagnosticLookupRequestIdRef.current + 1;
    diagnosticLookupRequestIdRef.current = requestId;
    setDiagnosticLookupState({
      detailRef,
      phase: "loading",
      result: null,
      error: null,
      checkedAt: null,
    });

    try {
      const result = await lookupDiagnosticDetail(detailRef);
      if (diagnosticLookupRequestIdRef.current !== requestId) {
        return;
      }
      setDiagnosticLookupState({
        detailRef: result.detailRef,
        phase: "ready",
        result,
        error: null,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (diagnosticLookupRequestIdRef.current !== requestId) {
        return;
      }
      setDiagnosticLookupState({
        detailRef,
        phase: "error",
        result: null,
        error: error as SidecarClientError,
        checkedAt: new Date().toISOString(),
      });
    }
  }, []);

  const retryDiagnosticLookup = useCallback(() => {
    if (!diagnosticLookupState.detailRef) {
      return;
    }

    void runDiagnosticLookup(diagnosticLookupState.detailRef);
  }, [diagnosticLookupState.detailRef, runDiagnosticLookup]);

  const recordIdentityConfigError = useCallback((profileId: string, action: IdentityConfigAction, error: SidecarClientError) => {
    setIdentityConfigSuccess(null);
    setIdentityConfigError({
      profileId,
      action,
      error,
      occurredAt: new Date().toISOString(),
    });
    setIdentityConfigPhase(error.phase);
    setIdentityCurrentAction(action);
  }, []);

  const closeIdentityConfig = useCallback(() => {
    identityConfigRequestIdRef.current += 1;
    setIdentityPanelProfileId(null);
    setIdentityDraft(null);
    setIdentityConfigPhase("idle");
    setSelectedIdentityPresetId("");
    setSavedIdentityWarnings([]);
    setIdentityCurrentAction(null);
    setIdentityConfigError(null);
    setIdentityConfigSuccess(null);
  }, []);

  const closeIdentityAuditPanel = useCallback(() => {
    identityAuditRequestIdRef.current += 1;
    setIdentityAuditPanelProfileId(null);
    setIdentityAuditPhase("idle");
    setIdentityAuditCurrentAction(null);
    setIdentityAuditPlan(null);
    setIdentityAuditError(null);
    setIdentityAuditOpenSuccess(null);
  }, []);

  const loadIdentityAuditPlan = useCallback((profile: ProfileRecord) => {
    const requestId = identityAuditRequestIdRef.current + 1;
    identityAuditRequestIdRef.current = requestId;

    setIdentityAuditPanelProfileId(profile.id);
    setIdentityAuditPhase("loading-plan");
    setIdentityAuditCurrentAction({ action: "load-plan", pageId: null });
    setIdentityAuditPlan(null);
    setIdentityAuditError(null);
    setIdentityAuditOpenSuccess(null);

    void getIdentityAuditPlan(profile.id)
      .then((snapshot) => {
        if (identityAuditRequestIdRef.current !== requestId) {
          return;
        }

        setIdentityAuditPlan(snapshot);
        setIdentityAuditPhase("ready");
        setIdentityAuditCurrentAction(null);
        setIdentityAuditError(null);
      })
      .catch((error) => {
        if (identityAuditRequestIdRef.current !== requestId) {
          return;
        }

        const clientError = error as SidecarClientError;
        setIdentityAuditPlan(null);
        setIdentityAuditPhase(clientError.phase);
        setIdentityAuditCurrentAction(null);
        setIdentityAuditError({
          profileId: profile.id,
          action: "load-plan",
          pageId: null,
          error: clientError,
          occurredAt: new Date().toISOString(),
        });
      });
  }, []);

  const openIdentityAuditCatalogPage = useCallback(
    async (profile: ProfileRecord, page: IdentityAuditPage) => {
      if (identityAuditPanelProfileId !== profile.id || !identityAuditPlan || identityAuditCurrentAction) {
        return;
      }

      const requestId = identityAuditRequestIdRef.current + 1;
      identityAuditRequestIdRef.current = requestId;
      setIdentityAuditPhase("opening");
      setIdentityAuditCurrentAction({ action: "open-page", pageId: page.id });
      setIdentityAuditError(null);
      setIdentityAuditOpenSuccess(null);

      try {
        const snapshot = await openIdentityAuditPage(profile.id, page.id);
        if (identityAuditRequestIdRef.current !== requestId) {
          return;
        }

        setIdentityAuditOpenSuccess({
          profileId: snapshot.profileId,
          pageId: snapshot.pageId,
          pageLabel: snapshot.page.label,
          openedAt: snapshot.openedAt,
          launched: snapshot.launched,
          runningCount: snapshot.runningCount,
          requestId: snapshot.requestId,
          occurredAt: new Date().toISOString(),
        });
        setIdentityAuditPhase("ready");
        setIdentityAuditCurrentAction(null);
        setIdentityAuditError(null);

        if (snapshot.launched) {
          void refreshChromiumStatus("launch");
        }
      } catch (error) {
        if (identityAuditRequestIdRef.current !== requestId) {
          return;
        }

        const clientError = error as SidecarClientError;
        setIdentityAuditPhase(clientError.phase);
        setIdentityAuditCurrentAction(null);
        setIdentityAuditOpenSuccess(null);
        setIdentityAuditError({
          profileId: profile.id,
          action: "open-page",
          pageId: page.id,
          error: clientError,
          occurredAt: new Date().toISOString(),
        });
      }
    },
    [identityAuditCurrentAction, identityAuditPanelProfileId, identityAuditPlan, refreshChromiumStatus],
  );

  const openIdentityConfig = useCallback(
    (profile: ProfileRecord) => {
      const requestId = identityConfigRequestIdRef.current + 1;
      identityConfigRequestIdRef.current = requestId;
      const draft = createIdentityDraftState(profile);
      const hasPresetCache = identityPresetCache !== null;

      setIdentityPanelProfileId(profile.id);
      setIdentityDraft(draft);
      setSelectedIdentityPresetId(draft.identity.presetId ?? "");
      setSavedIdentityWarnings([]);
      setIdentityConfigError(null);
      setIdentityConfigSuccess(null);
      setIdentityConfigPhase(hasPresetCache ? "validating" : "loading-presets");
      setIdentityCurrentAction(hasPresetCache ? "validate-saved" : "load-presets");

      const presetPromise = hasPresetCache
        ? Promise.resolve(identityPresetCache)
        : listIdentityPresets().then((snapshot) => {
            if (identityConfigRequestIdRef.current === requestId) {
              setIdentityPresetCache(snapshot.presets);
            }
            return snapshot.presets;
          });

      void presetPromise
        .then(() => {
          if (identityConfigRequestIdRef.current !== requestId) {
            return;
          }
          setIdentityConfigPhase((current) => (current === "loading-presets" ? "validating" : current));
          setIdentityCurrentAction("validate-saved");
        })
        .catch((error) => {
          if (identityConfigRequestIdRef.current !== requestId) {
            return;
          }
          recordIdentityConfigError(profile.id, "load-presets", error as SidecarClientError);
        });

      void validateIdentity(draft.identity)
        .then((snapshot) => {
          if (identityConfigRequestIdRef.current !== requestId) {
            return;
          }
          setIdentityDraft(createIdentityDraftState(snapshot.identity));
          setSelectedIdentityPresetId(snapshot.identity.presetId ?? "");
          setSavedIdentityWarnings(snapshot.warnings);
          setIdentityConfigPhase((current) => (current === "recoverable-error" || current === "bridge-error" ? current : "ready"));
          setIdentityCurrentAction((current) => (current === "load-presets" ? current : null));
        })
        .catch((error) => {
          if (identityConfigRequestIdRef.current !== requestId) {
            return;
          }
          recordIdentityConfigError(profile.id, "validate-saved", error as SidecarClientError);
        });
    },
    [identityPresetCache, recordIdentityConfigError],
  );

  const handleIdentityPresetSelect = useCallback(
    (profileId: string, presetId: string) => {
      if (identityPanelProfileId !== profileId) {
        return;
      }

      setSelectedIdentityPresetId(presetId);
      setIdentityConfigError(null);
      setIdentityConfigSuccess(null);
    },
    [identityPanelProfileId],
  );

  const handleApplyIdentityPreset = useCallback(
    async (profile: ProfileRecord, presetId: string) => {
      const requestedPresetId = presetId.trim();
      const presetExists = identityPresetCache?.some((preset) => preset.presetId === requestedPresetId) ?? false;
      const lifecycleMutation = chromiumMutationRef.current;

      if (
        identityPanelProfileId !== profile.id ||
        identityConfigPhase === "applying-preset" ||
        requestedPresetId.length === 0 ||
        !presetExists ||
        chromiumRuntimeByProfileRef.current[profile.id] ||
        lifecycleMutation?.profileId === profile.id
      ) {
        return;
      }

      const requestId = identityConfigRequestIdRef.current;
      setIdentityConfigPhase("applying-preset");
      setIdentityCurrentAction("apply-preset");
      setIdentityConfigError(null);
      setIdentityConfigSuccess(null);

      try {
        const snapshot = await applyProfileIdentityPreset(profile.id, requestedPresetId);

        if (identityConfigRequestIdRef.current !== requestId) {
          return;
        }

        applyProfileSnapshot(snapshot);
        setIdentityDraft(createIdentityDraftState(snapshot.profile));
        setSelectedIdentityPresetId(snapshot.profile.identity.presetId ?? requestedPresetId);
        setSavedIdentityWarnings(snapshot.warnings);
        setIdentityConfigSuccess({
          profileId: profile.id,
          action: "apply-preset",
          presetId: requestedPresetId,
          label: snapshot.profile.identity.label,
          warningCount: snapshot.warnings.length,
          occurredAt: new Date().toISOString(),
        });
        setIdentityConfigPhase("ready");
        setIdentityCurrentAction(null);
        setIdentityConfigError(null);
      } catch (error) {
        if (identityConfigRequestIdRef.current !== requestId) {
          return;
        }

        recordIdentityConfigError(profile.id, "apply-preset", error as SidecarClientError);
      }
    },
    [applyProfileSnapshot, identityConfigPhase, identityPanelProfileId, identityPresetCache, recordIdentityConfigError],
  );

  const handleIdentityDraftLabelChange = useCallback(
    (profileId: string, value: string) => {
      if (identityPanelProfileId !== profileId) {
        return;
      }

      setIdentityDraft((current) => (current ? updateIdentityDraftLabel(current, value) : current));
      setSavedIdentityWarnings([]);
      setIdentityConfigError(null);
      setIdentityConfigSuccess(null);
      setIdentityConfigPhase("ready");
      setIdentityCurrentAction(null);
    },
    [identityPanelProfileId],
  );

  const handleIdentityDraftFieldChange = useCallback(
    (profileId: string, path: Exclude<IdentityDraftFieldPath, "label">, value: string) => {
      if (identityPanelProfileId !== profileId) {
        return;
      }

      setIdentityDraft((current) => (current ? updateIdentityDraftField(current, path, value) : current));
      setSavedIdentityWarnings([]);
      setIdentityConfigError(null);
      setIdentityConfigSuccess(null);
      setIdentityConfigPhase("ready");
      setIdentityCurrentAction(null);
    },
    [identityPanelProfileId],
  );

  const handleIdentitySurfaceModeChange = useCallback(
    (profileId: string, surface: IdentitySurface, mode: string) => {
      if (identityPanelProfileId !== profileId) {
        return;
      }

      setIdentityDraft((current) => (current ? updateIdentityDraftSurfaceMode(current, surface, mode) : current));
      setSavedIdentityWarnings([]);
      setIdentityConfigError(null);
      setIdentityConfigSuccess(null);
      setIdentityConfigPhase("ready");
      setIdentityCurrentAction(null);
    },
    [identityPanelProfileId],
  );

  const handleCheckIdentity = useCallback(
    async (profile: ProfileRecord) => {
      const lifecycleMutation = chromiumMutationRef.current;
      if (
        identityPanelProfileId !== profile.id ||
        !identityDraft ||
        identityConfigPhase === "loading-presets" ||
        identityConfigPhase === "validating" ||
        identityConfigPhase === "applying-preset" ||
        identityConfigPhase === "saving" ||
        chromiumRuntimeByProfileRef.current[profile.id] ||
        lifecycleMutation?.profileId === profile.id
      ) {
        return;
      }

      const parsed = parseIdentityDraftState(identityDraft);
      if (!parsed.ok) {
        setIdentityDraft({ ...identityDraft, errors: parsed.errors });
        setIdentityConfigError(null);
        setIdentityConfigSuccess(null);
        setIdentityConfigPhase("ready");
        setIdentityCurrentAction(null);
        return;
      }

      const requestId = identityConfigRequestIdRef.current;
      setIdentityDraft({ ...identityDraft, errors: {} });
      setIdentityConfigPhase("validating");
      setIdentityCurrentAction("check");
      setIdentityConfigError(null);
      setIdentityConfigSuccess(null);

      try {
        const snapshot = await validateIdentity(parsed.identity);
        if (identityConfigRequestIdRef.current !== requestId) {
          return;
        }

        const nextDraft = createIdentityDraftState(snapshot.identity);
        nextDraft.labelEdited = identityDraft.labelEdited;
        setIdentityDraft(nextDraft);
        setSelectedIdentityPresetId(snapshot.identity.presetId ?? "");
        setSavedIdentityWarnings(snapshot.warnings);
        setIdentityConfigSuccess({
          profileId: profile.id,
          action: "check",
          presetId: snapshot.identity.presetId,
          label: snapshot.identity.label,
          warningCount: snapshot.warnings.length,
          occurredAt: new Date().toISOString(),
        });
        setIdentityConfigPhase("ready");
        setIdentityCurrentAction(null);
        setIdentityConfigError(null);
      } catch (error) {
        if (identityConfigRequestIdRef.current !== requestId) {
          return;
        }

        recordIdentityConfigError(profile.id, "check", error as SidecarClientError);
      }
    },
    [identityConfigPhase, identityDraft, identityPanelProfileId, recordIdentityConfigError],
  );

  const handleSaveIdentity = useCallback(
    async (profile: ProfileRecord) => {
      const lifecycleMutation = chromiumMutationRef.current;
      if (
        identityPanelProfileId !== profile.id ||
        !identityDraft ||
        identityConfigPhase === "loading-presets" ||
        identityConfigPhase === "validating" ||
        identityConfigPhase === "applying-preset" ||
        identityConfigPhase === "saving" ||
        chromiumRuntimeByProfileRef.current[profile.id] ||
        lifecycleMutation?.profileId === profile.id
      ) {
        return;
      }

      const parsed = parseIdentityDraftState(identityDraft);
      if (!parsed.ok) {
        setIdentityDraft({ ...identityDraft, errors: parsed.errors });
        setIdentityConfigError(null);
        setIdentityConfigSuccess(null);
        setIdentityConfigPhase("ready");
        setIdentityCurrentAction(null);
        return;
      }

      const identity = markIdentityAsAdvancedOverride(parsed.identity, {
        preserveLabel: identityDraft.labelEdited || parsed.identity.presetId === null,
      });
      const attemptedDraft = createIdentityDraftState(identity);
      attemptedDraft.labelEdited = identityDraft.labelEdited;
      const requestId = identityConfigRequestIdRef.current;
      setIdentityDraft(attemptedDraft);
      setIdentityConfigPhase("saving");
      setIdentityCurrentAction("save");
      setIdentityConfigError(null);
      setIdentityConfigSuccess(null);

      try {
        const snapshot = await updateProfileIdentity(profile.id, identity);
        if (identityConfigRequestIdRef.current !== requestId) {
          return;
        }

        applyProfileSnapshot(snapshot);
        setIdentityDraft(createIdentityDraftState(snapshot.profile));
        setSelectedIdentityPresetId(snapshot.profile.identity.presetId ?? "");
        setSavedIdentityWarnings(snapshot.warnings);
        setIdentityConfigSuccess({
          profileId: profile.id,
          action: "save",
          presetId: snapshot.profile.identity.presetId,
          label: snapshot.profile.identity.label,
          warningCount: snapshot.warnings.length,
          occurredAt: new Date().toISOString(),
        });
        setIdentityConfigPhase("ready");
        setIdentityCurrentAction(null);
        setIdentityConfigError(null);
      } catch (error) {
        if (identityConfigRequestIdRef.current !== requestId) {
          return;
        }

        recordIdentityConfigError(profile.id, "save", error as SidecarClientError);
      }
    },
    [applyProfileSnapshot, identityConfigPhase, identityDraft, identityPanelProfileId, recordIdentityConfigError],
  );

  const profileCount = profiles.length;
  const isProfileBusy = isProfileLoading || mutationPhase !== "idle";
  const isEmpty = !isProfileLoading && profileCount === 0;
  const profileTone = profilePhase === "ready" ? "ready" : profilePhase === "loading" ? "pending" : "error";
  const chromiumTone = chromiumPhase === "ready" ? "ready" : chromiumPhase === "loading" || chromiumPhase === "refreshing" || chromiumPhase === "launching" || chromiumPhase === "stopping" ? "pending" : "error";
  const legacySelectedCount = useMemo(
    () => legacyScanSnapshot?.candidates.filter((candidate) => legacySelectedById[candidate.legacyId]).length ?? 0,
    [legacyScanSnapshot, legacySelectedById],
  );
  const legacyScanIsStale = Boolean(legacyScanSnapshot && legacyScannedRoot !== null && legacyRoot.trim() !== legacyScannedRoot);
  const legacyCanScan = legacyRoot.trim().length > 0 && legacyScanPhase !== "scanning" && legacyImportPhase !== "importing";
  const legacyCanImport = Boolean(
    legacyScanSnapshot && !legacyScanIsStale && legacySelectedCount > 0 && legacyScanPhase !== "scanning" && legacyImportPhase !== "importing",
  );
  const legacyOutcomeCounts = useMemo(
    () => ({
      success: legacyImportSnapshot?.successCount ?? 0,
      partial: legacyImportSnapshot?.partialCount ?? 0,
      failed: legacyImportSnapshot?.failedCount ?? 0,
    }),
    [legacyImportSnapshot],
  );
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
            diagnosticLookupState={diagnosticLookupState}
            error={profileError}
            isLoading={isProfileLoading}
            lastListSnapshot={lastListSnapshot}
            mutationPhase={mutationPhase}
            profileCount={profileCount}
            onDiagnosticLookup={runDiagnosticLookup}
          />

          <LegacyImportPanel
            canImport={legacyCanImport}
            canScan={legacyCanScan}
            diagnosticLookupState={diagnosticLookupState}
            importError={legacyImportError}
            importPhase={legacyImportPhase}
            importRefreshState={legacyImportRefreshState}
            importSnapshot={legacyImportSnapshot}
            isStale={legacyScanIsStale}
            legacyRoot={legacyRoot}
            outcomeCounts={legacyOutcomeCounts}
            scanError={legacyScanError}
            scanPhase={legacyScanPhase}
            scanSnapshot={legacyScanSnapshot}
            scannedRoot={legacyScannedRoot}
            selectedById={legacySelectedById}
            selectedCount={legacySelectedCount}
            targetNamesById={legacyTargetNamesById}
            onDiagnosticLookup={runDiagnosticLookup}
            onImportSubmit={handleLegacyImportSubmit}
            onRootChange={handleLegacyRootChange}
            onScanSubmit={handleLegacyScanSubmit}
            onSelectionChange={handleLegacySelectionChange}
            onTargetNameChange={handleLegacyTargetNameChange}
          />

          {isProfileLoading && profileCount === 0 ? (
            <div className="profile-loading" role="status" aria-live="polite">
              Loading profiles from the sidecar store…
            </div>
          ) : profileError && (!lastListSnapshot || profileError.context === "refresh") && profileCount === 0 ? (
            <ProfileLoadRecoveryState isBusy={isProfileBusy} onRetry={() => void refreshProfiles("refresh")} />
          ) : isEmpty ? (
            <EmptyProfileState />
          ) : (
            <div className="profile-grid" role="list" aria-label="Stored profiles">
              {profiles.map((profile) => (
                <ProfileCard
                  key={profile.id}
                  deleteCandidate={deleteCandidate}
                  diagnosticLookupState={diagnosticLookupState}
                  editing={editing}
                  identityConfigState={{
                    isOpen: identityPanelProfileId === profile.id,
                    phase: identityPanelProfileId === profile.id ? identityConfigPhase : "idle",
                    draft: identityPanelProfileId === profile.id ? identityDraft : null,
                    presets: identityPanelProfileId === profile.id ? identityPresetCache : null,
                    selectedPresetId: identityPanelProfileId === profile.id ? selectedIdentityPresetId : "",
                    savedWarnings: identityPanelProfileId === profile.id ? savedIdentityWarnings : [],
                    currentAction: identityPanelProfileId === profile.id ? identityCurrentAction : null,
                    error: identityConfigError?.profileId === profile.id ? identityConfigError : null,
                    applySuccess: identityConfigSuccess?.profileId === profile.id ? identityConfigSuccess : null,
                  }}
                  identityAuditState={{
                    isOpen: identityAuditPanelProfileId === profile.id,
                    phase: identityAuditPanelProfileId === profile.id ? identityAuditPhase : "idle",
                    currentAction: identityAuditPanelProfileId === profile.id ? identityAuditCurrentAction : null,
                    plan: identityAuditPanelProfileId === profile.id ? identityAuditPlan : null,
                    error: identityAuditError?.profileId === profile.id ? identityAuditError : null,
                    openSuccess: identityAuditOpenSuccess?.profileId === profile.id ? identityAuditOpenSuccess : null,
                  }}
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
                  onDiagnosticLookup={runDiagnosticLookup}
                  onEditNameChange={(name) => setEditing({ id: profile.id, name })}
                  onIdentityApplyPreset={handleApplyIdentityPreset}
                  onIdentityAuditClose={closeIdentityAuditPanel}
                  onIdentityAuditOpen={loadIdentityAuditPlan}
                  onIdentityAuditOpenPage={openIdentityAuditCatalogPage}
                  onIdentityAuditRetryPlan={loadIdentityAuditPlan}
                  onIdentityCheck={handleCheckIdentity}
                  onIdentityClose={closeIdentityConfig}
                  onIdentityConfigure={openIdentityConfig}
                  onIdentityDraftFieldChange={handleIdentityDraftFieldChange}
                  onIdentityDraftLabelChange={handleIdentityDraftLabelChange}
                  onIdentityPresetSelect={handleIdentityPresetSelect}
                  onIdentitySave={handleSaveIdentity}
                  onIdentitySurfaceModeChange={handleIdentitySurfaceModeChange}
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
            diagnosticLookupState={diagnosticLookupState}
            healthBusyAction={healthBusyAction}
            healthState={healthState}
            onDiagnosticLookup={runDiagnosticLookup}
            onRefreshHealth={refreshHealth}
            onTriggerDiagnostic={triggerDiagnosticError}
          />
          <DiagnosticLookupPanel state={diagnosticLookupState} onRetry={retryDiagnosticLookup} />
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

function LegacyImportPanel({
  canImport,
  canScan,
  diagnosticLookupState,
  importError,
  importPhase,
  importRefreshState,
  importSnapshot,
  isStale,
  legacyRoot,
  outcomeCounts,
  scanError,
  scanPhase,
  scanSnapshot,
  scannedRoot,
  selectedById,
  selectedCount,
  targetNamesById,
  onDiagnosticLookup,
  onImportSubmit,
  onRootChange,
  onScanSubmit,
  onSelectionChange,
  onTargetNameChange,
}: {
  canImport: boolean;
  canScan: boolean;
  diagnosticLookupState: DiagnosticLookupState;
  importError: SidecarClientError | null;
  importPhase: LegacyImportPhase;
  importRefreshState: LegacyImportRefreshState;
  importSnapshot: LegacyImportSnapshot | null;
  isStale: boolean;
  legacyRoot: string;
  outcomeCounts: { success: number; partial: number; failed: number };
  scanError: SidecarClientError | null;
  scanPhase: LegacyScanPhase;
  scanSnapshot: LegacyScanSnapshot | null;
  scannedRoot: string | null;
  selectedById: LegacySelectionState;
  selectedCount: number;
  targetNamesById: LegacyTargetNameState;
  onDiagnosticLookup: (detailRef: string) => void;
  onImportSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRootChange: (value: string) => void;
  onScanSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSelectionChange: (legacyId: string, selected: boolean) => void;
  onTargetNameChange: (legacyId: string, targetName: string) => void;
}) {
  const rootHelpId = "legacy-root-help";
  const rootErrorId = scanError ? "legacy-scan-error" : undefined;
  const hasScan = Boolean(scanSnapshot);
  const candidateCount = scanSnapshot?.candidates.length ?? 0;
  const panelTone = importPhase === "completed" ? "ready" : scanPhase === "scanning" || importPhase === "importing" ? "pending" : scanError || importError || importRefreshState ? "error" : "neutral";

  return (
    <section className={`legacy-import-panel legacy-import-panel--${panelTone}`} aria-labelledby="legacy-import-heading">
      <div className="legacy-import-panel__header">
        <div>
          <p className="kicker">Explicit legacy import</p>
          <h2 id="legacy-import-heading">Bring old ThePrivator profiles into the sidecar store deliberately.</h2>
          <p>
            Enter a legacy profile root, scan immediate profile folders, select only the rows you want, and import them
            through the profile store. The original legacy tree is not mutated.
          </p>
        </div>
        <span className="mini-phase" aria-label={`Legacy import phase: ${importPhase}`}>
          {importPhase}
        </span>
      </div>

      <form className="legacy-scan-form" aria-label="Scan legacy profiles" onSubmit={onScanSubmit}>
        <div>
          <label htmlFor="legacy-root">Legacy profile root</label>
          <p id={rootHelpId}>
            Paste or type the root folder that contains legacy profile folders. The app never opens a browser file-system
            picker or starts a hidden migration.
          </p>
        </div>
        <div className="legacy-scan-controls">
          <input
            id="legacy-root"
            name="legacy-root"
            value={legacyRoot}
            onChange={(event) => onRootChange(event.target.value)}
            aria-describedby={rootErrorId ? `${rootHelpId} ${rootErrorId}` : rootHelpId}
            aria-invalid={scanError?.code === "LEGACY_ROOT_REQUIRED" ? true : undefined}
            autoComplete="off"
            placeholder="/Users/you/Library/Application Support/ThePrivator"
          />
          <button type="submit" disabled={!canScan}>
            {scanPhase === "scanning" ? "Scanning…" : "Scan legacy root"}
          </button>
        </div>
      </form>

      <dl className="metric-list metric-list--inline legacy-observability" aria-label="Legacy import observability">
        <Metric label="Scan phase" value={`${scanPhase} · ${LEGACY_SCAN_PHASE_LABELS[scanPhase]}`} />
        <Metric label="Import phase" value={`${importPhase} · ${LEGACY_IMPORT_PHASE_LABELS[importPhase]}`} />
        <Metric label="Scanned profiles" value={candidateCount} />
        <Metric label="Selected" value={selectedCount} />
        <Metric label="Outcomes" value={`${outcomeCounts.success} success · ${outcomeCounts.partial} partial · ${outcomeCounts.failed} failed`} />
        <Metric label="Last scan detailRef" value={scanError?.detailRef} />
        <Metric label="Last import detailRef" value={importError?.detailRef ?? importRefreshState?.error.detailRef} />
      </dl>

      {scanError ? (
        <LegacyErrorFeedback
          diagnosticLookupState={diagnosticLookupState}
          id="legacy-scan-error"
          title="Scan failed safely"
          error={scanError}
          onDiagnosticLookup={onDiagnosticLookup}
        />
      ) : null}

      {scanSnapshot?.issues.length ? (
        <LegacyIssueList
          diagnosticLookupState={diagnosticLookupState}
          id="legacy-root-issues"
          label="Root scan issues"
          issues={scanSnapshot.issues}
          onDiagnosticLookup={onDiagnosticLookup}
        />
      ) : null}

      {hasScan ? (
        <form className="legacy-import-form" aria-label="Import scanned legacy profiles" onSubmit={onImportSubmit}>
          <div className="legacy-selection-bar" role="status" aria-live="polite" aria-atomic="true">
            <strong>
              {selectedCount} of {candidateCount} scanned {candidateCount === 1 ? "profile" : "profiles"} selected.
            </strong>
            <span>Last scanned: {scannedRoot ? "current input at scan time" : "not yet scanned"}</span>
          </div>

          {isStale ? (
            <div className="legacy-stale-warning" role="status" aria-live="polite">
              The path changed after the last scan. Review the retained results if needed, then scan again before importing.
            </div>
          ) : null}

          {candidateCount === 0 ? (
            <section className="legacy-empty-scan" aria-label="No legacy profiles found">
              <strong>No immediate legacy profile folders were found.</strong>
              <p>Choose another root and scan again. Nothing is imported until you select profiles and submit.</p>
            </section>
          ) : (
            <div className="legacy-candidate-list" role="list" aria-label="Scanned legacy profiles">
              {scanSnapshot?.candidates.map((candidate) => (
                <LegacyCandidateRow
                  key={candidate.legacyId}
                  candidate={candidate}
                  diagnosticLookupState={diagnosticLookupState}
                  isSelected={Boolean(selectedById[candidate.legacyId])}
                  targetName={targetNamesById[candidate.legacyId] ?? candidate.targetName}
                  onDiagnosticLookup={onDiagnosticLookup}
                  onSelectionChange={onSelectionChange}
                  onTargetNameChange={onTargetNameChange}
                />
              ))}
            </div>
          )}

          {importError ? (
            <LegacyErrorFeedback
              diagnosticLookupState={diagnosticLookupState}
              title="Import failed safely"
              error={importError}
              onDiagnosticLookup={onDiagnosticLookup}
            />
          ) : null}
          {importRefreshState ? (
            <LegacyErrorFeedback
              diagnosticLookupState={diagnosticLookupState}
              title="Profile list refresh after import failed"
              error={importRefreshState.error}
              description={`Import outcomes remain visible. Retry Refresh profiles after resolving the list reload issue from ${formatProfileTimestamp(importRefreshState.occurredAt)}.`}
              onDiagnosticLookup={onDiagnosticLookup}
            />
          ) : null}

          <div className="legacy-import-actions">
            <button type="submit" disabled={!canImport}>
              {importPhase === "importing" ? "Importing selected…" : `Import selected (${selectedCount})`}
            </button>
            <span className="legacy-action-hint">
              Sidecar validation runs on the target names exactly as shown; invalid or duplicate rows stay editable.
            </span>
          </div>
        </form>
      ) : null}

      <LegacyImportOutcomes
        diagnosticLookupState={diagnosticLookupState}
        snapshot={importSnapshot}
        onDiagnosticLookup={onDiagnosticLookup}
      />
    </section>
  );
}

function LegacyCandidateRow({
  candidate,
  diagnosticLookupState,
  isSelected,
  targetName,
  onDiagnosticLookup,
  onSelectionChange,
  onTargetNameChange,
}: {
  candidate: LegacyScanCandidate;
  diagnosticLookupState: DiagnosticLookupState;
  isSelected: boolean;
  targetName: string;
  onDiagnosticLookup: (detailRef: string) => void;
  onSelectionChange: (legacyId: string, selected: boolean) => void;
  onTargetNameChange: (legacyId: string, targetName: string) => void;
}) {
  const rowTitleId = `legacy-candidate-${candidate.legacyId}-title`;
  const targetInputId = `legacy-target-${candidate.legacyId}`;
  const targetHelpId = `legacy-target-${candidate.legacyId}-help`;
  const issueListId = candidate.issues.length ? `legacy-candidate-${candidate.legacyId}-issues` : undefined;
  const describedBy = issueListId ? `${targetHelpId} ${issueListId}` : targetHelpId;

  return (
    <article className={`legacy-candidate-row ${isSelected ? "legacy-candidate-row--selected" : ""}`} role="listitem" aria-labelledby={rowTitleId}>
      <label className="legacy-select-control">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(event) => onSelectionChange(candidate.legacyId, event.target.checked)}
        />
        <span>Select profile</span>
      </label>

      <div className="legacy-candidate-main">
        <div className="legacy-candidate-titleline">
          <div>
            <p className="signal-label">Legacy folder</p>
            <h3 id={rowTitleId}>{candidate.legacyName ?? candidate.folderName}</h3>
          </div>
          <span className={`status-pill status-pill--${candidate.userData.status === "available" ? "running" : "stopped"}`}>
            {formatLegacyUserDataStatus(candidate.userData.status)}
          </span>
        </div>

        <dl className="legacy-chip-list" aria-label={`${candidate.legacyName ?? candidate.folderName} safe legacy metadata`}>
          <Metric label="Folder" value={candidate.folderName} />
          <Metric label="Legacy name" value={candidate.legacyName ?? "No legacy name"} />
          <Metric label="Issues" value={candidate.issues.length} />
        </dl>

        <div className="legacy-target-control">
          <label htmlFor={targetInputId}>Target profile name</label>
          <input
            id={targetInputId}
            value={targetName}
            onChange={(event) => onTargetNameChange(candidate.legacyId, event.target.value)}
            aria-describedby={describedBy}
            aria-invalid={candidate.issues.length > 0 ? true : undefined}
            autoComplete="off"
          />
          <p id={targetHelpId}>This exact name is sent to the sidecar profile store for validation during import.</p>
        </div>

        {candidate.issues.length ? (
          <LegacyIssueList
            diagnosticLookupState={diagnosticLookupState}
            id={issueListId}
            label="Candidate validation issues"
            issues={candidate.issues}
            compact
            onDiagnosticLookup={onDiagnosticLookup}
          />
        ) : null}
      </div>
    </article>
  );
}

function LegacyIssueList({
  compact = false,
  diagnosticLookupState,
  id,
  issues,
  label,
  onDiagnosticLookup,
}: {
  compact?: boolean;
  diagnosticLookupState: DiagnosticLookupState;
  id?: string;
  issues: LegacyIssue[];
  label: string;
  onDiagnosticLookup: (detailRef: string) => void;
}) {
  return (
    <section className={`legacy-issue-list ${compact ? "legacy-issue-list--compact" : ""}`} id={id} aria-label={label}>
      <strong>{label}</strong>
      <div className="legacy-issue-list__items" role="list">
        {issues.map((issue) => (
          <article key={`${issue.code}-${issue.detailRef}`} className="legacy-issue" role="listitem">
            <div>
              <strong>{issue.code}</strong>
              <p>{issue.message}</p>
            </div>
            <dl className="metric-list metric-list--inline">
              <Metric label="detailRef" value={issue.detailRef} />
            </dl>
            <DiagnosticReference detailRef={issue.detailRef} state={diagnosticLookupState} onLookup={onDiagnosticLookup} />
          </article>
        ))}
      </div>
    </section>
  );
}

function LegacyErrorFeedback({
  description,
  diagnosticLookupState,
  error,
  id,
  title,
  onDiagnosticLookup,
}: {
  description?: string;
  diagnosticLookupState: DiagnosticLookupState;
  error: SidecarClientError;
  id?: string;
  title: string;
  onDiagnosticLookup: (detailRef: string) => void;
}) {
  return (
    <section className="legacy-error-feedback" id={id} role="status" aria-live="polite" aria-atomic="true">
      <strong>{title}</strong>
      <p>{description ?? error.message}</p>
      <dl className="metric-list metric-list--inline">
        <Metric label="Code" value={error.code} />
        <Metric label="Source" value={error.source} />
        <Metric label="Recoverable" value={error.recoverable ? "yes" : "no"} />
        <Metric label="detailRef" value={error.detailRef} />
      </dl>
      <DiagnosticReference detailRef={error.detailRef} state={diagnosticLookupState} onLookup={onDiagnosticLookup} />
    </section>
  );
}

function LegacyImportOutcomes({
  diagnosticLookupState,
  snapshot,
  onDiagnosticLookup,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  snapshot: LegacyImportSnapshot | null;
  onDiagnosticLookup: (detailRef: string) => void;
}) {
  if (!snapshot) {
    return null;
  }

  return (
    <section className="legacy-outcome-panel" aria-label="Legacy import outcomes" aria-live="polite">
      <div className="legacy-outcome-panel__summary">
        <div>
          <p className="signal-label">Per-profile outcomes</p>
          <h3>Import completed with explicit profile results.</h3>
        </div>
        <dl className="metric-list metric-list--inline">
          <Metric label="Requested" value={snapshot.requestedCount} />
          <Metric label="Success" value={snapshot.successCount} />
          <Metric label="Partial" value={snapshot.partialCount} />
          <Metric label="Failed" value={snapshot.failedCount} />
          <Metric label="Request" value={snapshot.requestId} />
        </dl>
      </div>

      <div className="legacy-outcome-list" role="list" aria-label="Per-profile legacy import result cards">
        {snapshot.outcomes.map((outcome) => (
          <LegacyOutcomeCard
            key={`${outcome.legacyId}-${outcome.targetName}-${outcome.status}`}
            diagnosticLookupState={diagnosticLookupState}
            outcome={outcome}
            onDiagnosticLookup={onDiagnosticLookup}
          />
        ))}
      </div>
    </section>
  );
}

function LegacyOutcomeCard({
  diagnosticLookupState,
  outcome,
  onDiagnosticLookup,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  outcome: LegacyImportOutcome;
  onDiagnosticLookup: (detailRef: string) => void;
}) {
  const titleId = `legacy-outcome-${outcome.legacyId}-${outcome.status}`;
  const statusLabel = outcome.status === "success" ? "Imported" : outcome.status === "partial" ? "Imported with copy issue" : "Import failed";

  return (
    <article className={`legacy-outcome-card legacy-outcome-card--${outcome.status}`} role="listitem" aria-labelledby={titleId}>
      <div className="legacy-outcome-card__header">
        <div>
          <p className="signal-label">{statusLabel}</p>
          <h4 id={titleId}>{outcome.targetName}</h4>
        </div>
        <span className={`status-pill status-pill--${outcome.status === "success" ? "running" : outcome.status === "partial" ? "pending" : "stopped"}`}>
          {outcome.status}
        </span>
      </div>

      <dl className="metric-list metric-list--inline">
        <Metric label="Copy" value={LEGACY_COPY_STATUS_LABELS[outcome.copyStatus]} />
        <Metric label="Folder" value={outcome.folderName} />
        <Metric label="Legacy name" value={outcome.legacyName} />
        <Metric label="Profile ID" value={"profileId" in outcome ? outcome.profileId : undefined} />
      </dl>

      {"error" in outcome ? (
        <section className="legacy-outcome-error" aria-label={`${outcome.targetName} import failure details`}>
          <p>{outcome.error.message}</p>
          <dl className="metric-list metric-list--inline">
            <Metric label="Code" value={outcome.error.code} />
            <Metric label="Recoverable" value={outcome.error.recoverable ? "yes" : "no"} />
            <Metric label="detailRef" value={outcome.error.detailRef} />
          </dl>
          <DiagnosticReference detailRef={outcome.error.detailRef} state={diagnosticLookupState} onLookup={onDiagnosticLookup} />
        </section>
      ) : null}
    </article>
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
  diagnosticLookupState,
  error,
  isLoading,
  lastListSnapshot,
  mutationPhase,
  profileCount,
  onDiagnosticLookup,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  error: ProfileUiError | null;
  isLoading: boolean;
  lastListSnapshot: ProfileListSnapshot | ProfileMutationSnapshot | null;
  mutationPhase: ProfileMutationPhase;
  profileCount: number;
  onDiagnosticLookup: (detailRef: string) => void;
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
          <DiagnosticReference detailRef={error.error.detailRef} state={diagnosticLookupState} onLookup={onDiagnosticLookup} />
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
  diagnosticLookupState,
  editing,
  identityConfigState,
  identityAuditState,
  isLifecycleActionBusy,
  isProfileBusy,
  lifecycleError,
  lifecycleMutation,
  mutationPhase,
  onCancelDelete,
  onConfirmDelete,
  onDeleteRequest,
  onDiagnosticLookup,
  onEditNameChange,
  onIdentityApplyPreset,
  onIdentityAuditClose,
  onIdentityAuditOpen,
  onIdentityAuditOpenPage,
  onIdentityAuditRetryPlan,
  onIdentityCheck,
  onIdentityClose,
  onIdentityConfigure,
  onIdentityDraftFieldChange,
  onIdentityDraftLabelChange,
  onIdentityPresetSelect,
  onIdentitySave,
  onIdentitySurfaceModeChange,
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
  diagnosticLookupState: DiagnosticLookupState;
  editing: EditingState | null;
  identityConfigState: IdentityConfigPanelState;
  identityAuditState: IdentityAuditPanelState;
  isLifecycleActionBusy: boolean;
  isProfileBusy: boolean;
  lifecycleError: ChromiumLifecycleError | null;
  lifecycleMutation: ChromiumLifecycleMutation;
  mutationPhase: ProfileMutationPhase;
  onCancelDelete: () => void;
  onConfirmDelete: (profile: ProfileRecord) => void;
  onDeleteRequest: (profile: ProfileRecord) => void;
  onDiagnosticLookup: (detailRef: string) => void;
  onEditNameChange: (name: string) => void;
  onIdentityApplyPreset: (profile: ProfileRecord, presetId: string) => void;
  onIdentityAuditClose: () => void;
  onIdentityAuditOpen: (profile: ProfileRecord) => void;
  onIdentityAuditOpenPage: (profile: ProfileRecord, page: IdentityAuditPage) => void;
  onIdentityAuditRetryPlan: (profile: ProfileRecord) => void;
  onIdentityCheck: (profile: ProfileRecord) => void;
  onIdentityClose: () => void;
  onIdentityConfigure: (profile: ProfileRecord) => void;
  onIdentityDraftFieldChange: (profileId: string, path: Exclude<IdentityDraftFieldPath, "label">, value: string) => void;
  onIdentityDraftLabelChange: (profileId: string, value: string) => void;
  onIdentityPresetSelect: (profileId: string, presetId: string) => void;
  onIdentitySave: (profile: ProfileRecord) => void;
  onIdentitySurfaceModeChange: (profileId: string, surface: IdentitySurface, mode: string) => void;
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
  const runtimeLabel = isStoppingThis ? "Stopping" : isLaunchingThis ? "Launching" : runningState ? "Running" : "Stopped";
  const runtimeTone = isLaunchingThis || isStoppingThis ? "pending" : runningState ? "running" : "stopped";
  const identityRuntimeProtectionReason = isRuntimeProtected
    ? `Identity changes are disabled while Chromium is ${runtimeLabel.toLowerCase()}. Stop Chromium before checking or saving; changes affect the next launch only.`
    : null;

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

      <ProfileIdentitySummary
        isConfigOpen={identityConfigState.isOpen}
        profile={profile}
        onConfigure={() => onIdentityConfigure(profile)}
      />

      {identityConfigState.isOpen ? (
        <IdentityConfigurationPanel
          diagnosticLookupState={diagnosticLookupState}
          profile={profile}
          runtimeProtectionReason={identityRuntimeProtectionReason}
          state={identityConfigState}
          onApplyPreset={onIdentityApplyPreset}
          onCheckIdentity={onIdentityCheck}
          onClose={onIdentityClose}
          onDiagnosticLookup={onDiagnosticLookup}
          onDraftFieldChange={onIdentityDraftFieldChange}
          onDraftLabelChange={onIdentityDraftLabelChange}
          onPresetSelect={onIdentityPresetSelect}
          onSaveIdentity={onIdentitySave}
          onSurfaceModeChange={onIdentitySurfaceModeChange}
        />
      ) : null}

      <ProfileIdentityAuditSummary
        diagnosticLookupState={diagnosticLookupState}
        identityAuditState={identityAuditState}
        isLifecycleActionBusy={isLifecycleActionBusy}
        isProfileBusy={isProfileBusy}
        profile={profile}
        runningState={runningState}
        onClose={onIdentityAuditClose}
        onDiagnosticLookup={onDiagnosticLookup}
        onOpen={onIdentityAuditOpen}
        onOpenPage={onIdentityAuditOpenPage}
        onRetryPlan={onIdentityAuditRetryPlan}
      />

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
          <DiagnosticReference detailRef={lifecycleError.error.detailRef} state={diagnosticLookupState} onLookup={onDiagnosticLookup} />
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

function ProfileIdentitySummary({
  isConfigOpen,
  profile,
  onConfigure,
}: {
  isConfigOpen: boolean;
  profile: ProfileRecord;
  onConfigure: () => void;
}) {
  const controls = getIdentitySurfaceControls(profile.identity);
  const panelId = `identity-panel-${profile.id}`;
  const compactModes = controls.map((control) => `${control.label} ${control.mode}`).join(" · ");

  return (
    <section className="identity-summary-panel" aria-label={`${profile.name} saved identity summary`}>
      <div className="identity-summary-panel__header">
        <div>
          <p className="signal-label">M002 saved identity</p>
          <h4>{profile.identity.label}</h4>
        </div>
        <button
          type="button"
          className="button--secondary"
          aria-controls={panelId}
          aria-expanded={isConfigOpen}
          aria-label={`Configure identity for ${profile.name}`}
          onClick={onConfigure}
        >
          Configure identity
        </button>
      </div>
      <p>{formatIdentitySummary(profile.identity)}</p>
      <dl className="metric-list metric-list--inline">
        <Metric label="Label" value={profile.identity.label} />
        <Metric label="Preset" value={profile.identity.presetId ? `Preset ${profile.identity.presetId}` : "No preset"} />
        <Metric label="Surface modes" value={compactModes} />
      </dl>
    </section>
  );
}

function ProfileIdentityAuditSummary({
  diagnosticLookupState,
  identityAuditState,
  isLifecycleActionBusy,
  isProfileBusy,
  profile,
  runningState,
  onClose,
  onDiagnosticLookup,
  onOpen,
  onOpenPage,
  onRetryPlan,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  identityAuditState: IdentityAuditPanelState;
  isLifecycleActionBusy: boolean;
  isProfileBusy: boolean;
  profile: ProfileRecord;
  runningState: ChromiumRunningProfileState | null;
  onClose: () => void;
  onDiagnosticLookup: (detailRef: string) => void;
  onOpen: (profile: ProfileRecord) => void;
  onOpenPage: (profile: ProfileRecord, page: IdentityAuditPage) => void;
  onRetryPlan: (profile: ProfileRecord) => void;
}) {
  const panelId = `identity-audit-panel-${profile.id}`;
  const openDisabled = !identityAuditState.isOpen && (isProfileBusy || isLifecycleActionBusy);

  return (
    <section className="identity-audit-summary-panel" aria-label={`${profile.name} guided identity audit`}>
      <div className="identity-audit-summary-panel__header">
        <div>
          <p className="signal-label">Guided identity audit</p>
          <h4>Manual public checker comparison</h4>
        </div>
        <button
          type="button"
          className="button--secondary"
          aria-controls={panelId}
          aria-expanded={identityAuditState.isOpen}
          disabled={openDisabled}
          onClick={() => (identityAuditState.isOpen ? onClose() : onOpen(profile))}
        >
          {identityAuditState.isOpen ? "Close audit guide" : "Open audit guide"}
        </button>
      </div>
      <p>
        Load a profile-scoped checklist of curated public checker pages, then compare their visible values manually. Local
        ThePrivator proof remains the app contract; checker labels, network behavior, and scores can change independently.
      </p>
      {openDisabled ? (
        <p className="identity-audit-muted" role="status" aria-live="polite">
          Audit actions pause during profile mutations or Chromium lifecycle launch/stop operations.
        </p>
      ) : null}
      {identityAuditState.isOpen ? (
        <IdentityAuditPanel
          diagnosticLookupState={diagnosticLookupState}
          id={panelId}
          isLifecycleActionBusy={isLifecycleActionBusy}
          isProfileBusy={isProfileBusy}
          profile={profile}
          runningState={runningState}
          state={identityAuditState}
          onDiagnosticLookup={onDiagnosticLookup}
          onOpenPage={onOpenPage}
          onRetryPlan={onRetryPlan}
        />
      ) : null}
    </section>
  );
}

function IdentityAuditPanel({
  diagnosticLookupState,
  id,
  isLifecycleActionBusy,
  isProfileBusy,
  profile,
  runningState,
  state,
  onDiagnosticLookup,
  onOpenPage,
  onRetryPlan,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  id: string;
  isLifecycleActionBusy: boolean;
  isProfileBusy: boolean;
  profile: ProfileRecord;
  runningState: ChromiumRunningProfileState | null;
  state: IdentityAuditPanelState;
  onDiagnosticLookup: (detailRef: string) => void;
  onOpenPage: (profile: ProfileRecord, page: IdentityAuditPage) => void;
  onRetryPlan: (profile: ProfileRecord) => void;
}) {
  const isPlanLoading = state.phase === "loading-plan";
  const isOpeningPage = state.currentAction?.action === "open-page";
  const plan = state.plan;
  const actionDisabledReason = isProfileBusy
    ? "Profile list mutation is in progress; audit actions are paused."
    : isLifecycleActionBusy
      ? "Chromium is launching or stopping; wait for lifecycle state to settle before audit actions."
      : isPlanLoading
        ? "Audit plan is still loading."
        : !plan
          ? "Load the audit plan before opening checker pages."
          : isOpeningPage
            ? "An audit page is already opening for this profile."
            : null;
  const currentAction = state.currentAction
    ? `${IDENTITY_AUDIT_ACTION_LABELS[state.currentAction.action]}${state.currentAction.pageId ? ` · ${state.currentAction.pageId}` : ""}`
    : "No active audit action";
  const runtimeCopy = runningState
    ? "Already running profile: Open in profile asks the sidecar to open a new tab in this configured profile."
    : "Stopped profile: Open in profile asks the sidecar to launch an audit-capable Chromium session before opening the page.";
  const errorPage = state.error?.pageId && plan ? plan.pages.find((page) => page.id === state.error?.pageId) ?? null : null;

  return (
    <section id={id} className="identity-audit-panel" role="region" aria-label={`Audit guide for ${profile.name}`} aria-live="polite">
      <div className="identity-audit-panel__header">
        <div>
          <p className="signal-label">Advisory audit flow</p>
          <h4>{plan ? `${plan.pages.length} curated checker pages` : "Audit plan loading"}</h4>
          <p>{runtimeCopy}</p>
        </div>
        <span className="mini-phase" aria-label={`Identity audit phase: ${state.phase}`}>
          {state.phase}
        </span>
      </div>

      <dl className="metric-list metric-list--inline identity-audit-observability" aria-label={`${profile.name} audit observability`}>
        <Metric label="Audit phase" value={`${state.phase} · ${IDENTITY_AUDIT_PHASE_LABELS[state.phase]}`} />
        <Metric label="Current action" value={currentAction} />
        <Metric label="Plan pages" value={plan?.pages.length ?? 0} />
        <Metric label="Last opened page" value={state.openSuccess?.pageLabel} />
        <Metric label="Opened request" value={state.openSuccess?.requestId} />
        <Metric label="Launch metadata" value={state.openSuccess ? `${state.openSuccess.launched ? "launched" : "already running"} · ${state.openSuccess.runningCount} running` : null} />
        <Metric label="Audit detailRef" value={state.error?.error.detailRef} />
      </dl>

      {isPlanLoading ? (
        <div className="identity-audit-status" role="status" aria-live="polite" aria-atomic="true">
          Loading the fixed audit catalog and expected identity guidance through the typed sidecar client…
        </div>
      ) : null}

      {plan ? (
        <section className="identity-audit-copy" aria-label="Audit guidance boundaries">
          <strong>Compare manually; do not treat one public checker as authoritative.</strong>
          <p>{plan.copy.advisory}</p>
          <p>{plan.copy.localProof}</p>
          <p>{plan.copy.publicCheckerInstability}</p>
          <p>Checker, page, or network issues are external instability unless the app shows a typed audit error below.</p>
        </section>
      ) : null}

      {state.error ? (
        <IdentityAuditErrorFeedback
          diagnosticLookupState={diagnosticLookupState}
          error={state.error}
          page={errorPage}
          profile={profile}
          onDiagnosticLookup={onDiagnosticLookup}
          onOpenPage={onOpenPage}
          onRetryPlan={onRetryPlan}
        />
      ) : null}

      {state.openSuccess ? <IdentityAuditSuccessFeedback state={state.openSuccess} /> : null}

      {plan ? (
        <div className="identity-audit-page-list" role="list" aria-label={`${profile.name} curated audit pages`}>
          {plan.pages.map((page) => {
            const isOpeningThisPage = state.currentAction?.action === "open-page" && state.currentAction.pageId === page.id;
            return (
              <IdentityAuditPageCard
                key={page.id}
                disabledReason={actionDisabledReason}
                isOpening={isOpeningThisPage}
                page={page}
                profile={profile}
                onOpenPage={onOpenPage}
              />
            );
          })}
        </div>
      ) : state.error?.action === "load-plan" ? (
        <button type="button" className="button--secondary" onClick={() => onRetryPlan(profile)} disabled={isProfileBusy || isLifecycleActionBusy}>
          Retry audit plan
        </button>
      ) : null}
    </section>
  );
}

function IdentityAuditPageCard({
  disabledReason,
  isOpening,
  page,
  profile,
  onOpenPage,
}: {
  disabledReason: string | null;
  isOpening: boolean;
  page: IdentityAuditPage;
  profile: ProfileRecord;
  onOpenPage: (profile: ProfileRecord, page: IdentityAuditPage) => void;
}) {
  const titleId = `identity-audit-page-${profile.id}-${page.id}`;
  const hintId = `${titleId}-hint`;

  return (
    <article className="identity-audit-page-card" role="listitem" aria-labelledby={titleId}>
      <div className="identity-audit-page-card__header">
        <div>
          <p className="signal-label">{formatIdentityAuditCategory(page.category)}</p>
          <h5 id={titleId}>{page.label}</h5>
        </div>
        <span className="identity-audit-page-card__surface-count">{page.surfaces.length} surfaces</span>
      </div>
      <p className="identity-audit-url">{page.url}</p>
      <p>{page.comparisonNote}</p>
      {page.requiresUserAction ? (
        <p className="identity-audit-user-action">After the page opens, start the public test manually before comparing values.</p>
      ) : null}
      <dl className="metric-list metric-list--inline">
        <Metric label="Page ID" value={page.id} />
        <Metric label="Category" value={formatIdentityAuditCategory(page.category)} />
        <Metric label="Surfaces" value={formatIdentityAuditSurfaces(page.surfaces)} />
      </dl>
      <div className="identity-audit-expected-list" role="list" aria-label={`Expected values for ${page.label}`}>
        {page.expectedRows.map((row) => (
          <article key={`${page.id}-${row.surface}-${row.label}`} className="identity-audit-expected-row" role="listitem">
            <strong>{row.label}</strong>
            <p>{row.expected}</p>
            <span>{row.guidance}</span>
          </article>
        ))}
      </div>
      <div className="identity-audit-page-card__actions">
        <button type="button" disabled={Boolean(disabledReason)} aria-describedby={hintId} onClick={() => onOpenPage(profile, page)}>
          {isOpening ? "Opening…" : "Open in profile"}
        </button>
        <p id={hintId} className="identity-audit-muted" role="status" aria-live="polite">
          {disabledReason ?? "The app sends only the fixed pageId to the typed audit-open wrapper; compare the public page manually."}
        </p>
      </div>
    </article>
  );
}

function IdentityAuditErrorFeedback({
  diagnosticLookupState,
  error,
  page,
  profile,
  onDiagnosticLookup,
  onOpenPage,
  onRetryPlan,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  error: IdentityAuditError;
  page: IdentityAuditPage | null;
  profile: ProfileRecord;
  onDiagnosticLookup: (detailRef: string) => void;
  onOpenPage: (profile: ProfileRecord, page: IdentityAuditPage) => void;
  onRetryPlan: (profile: ProfileRecord) => void;
}) {
  return (
    <section className="identity-audit-error" role="alert" aria-live="assertive" aria-atomic="true">
      <strong>{IDENTITY_AUDIT_ACTION_LABELS[error.action]} failed safely.</strong>
      <p>{error.error.message}</p>
      <dl className="metric-list metric-list--inline">
        <Metric label="Code" value={error.error.code} />
        <Metric label="Source" value={error.error.source} />
        <Metric label="Recoverable" value={error.error.recoverable ? "yes" : "no"} />
        <Metric label="detailRef" value={error.error.detailRef} />
        <Metric label="Page ID" value={error.pageId} />
        <Metric label="Occurred" value={formatProfileTimestamp(error.occurredAt)} />
      </dl>
      <p className="identity-audit-muted">This is an app-side audit failure. Public checker rendering or scoring remains external to this diagnostic.</p>
      <DiagnosticReference detailRef={error.error.detailRef} state={diagnosticLookupState} onLookup={onDiagnosticLookup} />
      {error.action === "load-plan" ? (
        <button type="button" className="button--secondary" onClick={() => onRetryPlan(profile)}>
          Retry audit plan
        </button>
      ) : page ? (
        <button type="button" className="button--secondary" onClick={() => onOpenPage(profile, page)}>
          Retry open in profile
        </button>
      ) : null}
    </section>
  );
}

function IdentityAuditSuccessFeedback({ state }: { state: IdentityAuditOpenSuccess }) {
  return (
    <section className="identity-audit-success" role="status" aria-live="polite" aria-atomic="true">
      <strong>{state.pageLabel} opened in the configured profile.</strong>
      <p>
        {state.launched
          ? "The sidecar launched an audit-capable Chromium session before opening the curated page."
          : "The sidecar opened the curated page in the already running profile."} The app does not read public page content or checker scores.
      </p>
      <dl className="metric-list metric-list--inline">
        <Metric label="Page ID" value={state.pageId} />
        <Metric label="Opened" value={formatProfileTimestamp(state.openedAt)} />
        <Metric label="Launch" value={state.launched ? "Launched by audit-open" : "Already running"} />
        <Metric label="Running count" value={state.runningCount} />
        <Metric label="Request" value={state.requestId} />
        <Metric label="Recorded" value={formatProfileTimestamp(state.occurredAt)} />
      </dl>
    </section>
  );
}

function IdentityConfigurationPanel({
  diagnosticLookupState,
  profile,
  runtimeProtectionReason,
  state,
  onApplyPreset,
  onCheckIdentity,
  onClose,
  onDiagnosticLookup,
  onDraftFieldChange,
  onDraftLabelChange,
  onPresetSelect,
  onSaveIdentity,
  onSurfaceModeChange,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  profile: ProfileRecord;
  runtimeProtectionReason: string | null;
  state: IdentityConfigPanelState;
  onApplyPreset: (profile: ProfileRecord, presetId: string) => void;
  onCheckIdentity: (profile: ProfileRecord) => void;
  onClose: () => void;
  onDiagnosticLookup: (detailRef: string) => void;
  onDraftFieldChange: (profileId: string, path: Exclude<IdentityDraftFieldPath, "label">, value: string) => void;
  onDraftLabelChange: (profileId: string, value: string) => void;
  onPresetSelect: (profileId: string, presetId: string) => void;
  onSaveIdentity: (profile: ProfileRecord) => void;
  onSurfaceModeChange: (profileId: string, surface: IdentitySurface, mode: string) => void;
}) {
  const draftState = state.draft ?? createIdentityDraftState(profile);
  const draftIdentity = draftState.identity;
  const controls = getIdentitySurfaceControls(draftIdentity);
  const presets = state.presets ?? [];
  const isLoadingPresets = state.phase === "loading-presets";
  const isValidating = state.phase === "validating";
  const isCheckingIdentity = state.phase === "validating" && state.currentAction === "check";
  const isValidatingSaved = state.phase === "validating" && state.currentAction !== "check";
  const isApplyingPreset = state.phase === "applying-preset" && state.currentAction === "apply-preset";
  const isSaving = state.phase === "saving";
  const isIdentityBusy = isLoadingPresets || isValidating || isApplyingPreset || isSaving;
  const fieldErrorCount = Object.keys(draftState.errors).length;
  const selectedPresetId = state.selectedPresetId;
  const selectedPreset = presets.find((preset) => preset.presetId === selectedPresetId) ?? null;
  const selectedPresetUnavailable = selectedPresetId.length > 0 && selectedPreset === null;
  const presetSelectId = `identity-preset-select-${profile.id}`;
  const presetApplyHintId = `identity-preset-apply-hint-${profile.id}`;
  const draftLabelId = `identity-label-${profile.id}`;
  const draftLabelHintId = `identity-label-hint-${profile.id}`;
  const draftLabelErrorId = `identity-label-error-${profile.id}`;
  const draftLabelError = draftState.errors.label;
  const advancedActionHintId = `identity-advanced-action-hint-${profile.id}`;
  const applyDisabledReason = runtimeProtectionReason
    ?? (isLoadingPresets
      ? "Curated preset choices are still loading."
      : isValidatingSaved
        ? "Saved identity validation is still running."
        : isCheckingIdentity
          ? "Identity draft check is already running."
          : isSaving
            ? "An advanced override save is already running."
            : isApplyingPreset
              ? "Preset apply is already running for this profile."
              : selectedPresetId.length === 0
                ? "Choose a curated preset before applying."
                : selectedPresetUnavailable
                  ? `Preset ${selectedPresetId} is not in the loaded curated preset list. Choose an available preset before applying.`
                  : null);
  const advancedDisabledReason = runtimeProtectionReason
    ?? (isLoadingPresets
      ? "Curated preset choices are still loading."
      : isValidatingSaved
        ? "Saved identity validation is still running."
        : isCheckingIdentity
          ? "Identity draft check is already running."
          : isApplyingPreset
            ? "Preset apply is already running for this profile."
            : isSaving
              ? "An advanced override save is already running."
              : fieldErrorCount > 0
                ? `Fix ${fieldErrorCount} field error${fieldErrorCount === 1 ? "" : "s"} before checking or saving.`
                : null);
  const canApplyPreset = applyDisabledReason === null;
  const canRunAdvancedAction = advancedDisabledReason === null;

  return (
    <section
      id={`identity-panel-${profile.id}`}
      className="identity-config-panel"
      role="region"
      aria-label={`Configure identity for ${profile.name}`}
      aria-live="polite"
    >
      <div className="identity-config-panel__header">
        <div>
          <p className="signal-label">Profile identity configuration</p>
          <h4>{draftState.values.label || draftIdentity.label}</h4>
          <p>
            This panel reads the saved S02 identity, loads curated presets only after opening, validates advanced drafts
            through the sidecar, and keeps warnings scoped to this profile.
          </p>
        </div>
        <button type="button" className="button--secondary" onClick={onClose} aria-label="Close identity configuration">
          Close
        </button>
      </div>

      <dl className="metric-list metric-list--inline identity-config-observability" aria-label={`${profile.name} identity observability`}>
        <Metric label="Identity configuration phase" value={`${state.phase} · ${IDENTITY_CONFIG_PHASE_LABELS[state.phase]}`} />
        <Metric label="Current action" value={state.currentAction ? IDENTITY_CONFIG_ACTION_LABELS[state.currentAction] : "No active identity action"} />
        <Metric label="Draft label" value={draftState.values.label} />
        <Metric label="Draft preset" value={draftIdentity.presetId ? `Preset ${draftIdentity.presetId}` : "No preset"} />
        <Metric label="Preset count" value={presets.length} />
        <Metric label="Saved warnings" value={state.savedWarnings.length} />
        <Metric label="Field errors" value={fieldErrorCount} />
        <Metric label="Expected values" value={formatIdentityExpectedValueSummary(draftIdentity)} />
        <Metric label="Last identity detailRef" value={state.error?.error.detailRef} />
      </dl>

      {isLoadingPresets ? (
        <div className="identity-status" role="status" aria-live="polite" aria-atomic="true">
          Loading curated identity presets through the typed sidecar client…
        </div>
      ) : null}
      {isValidatingSaved ? (
        <div className="identity-status" role="status" aria-live="polite" aria-atomic="true">
          Validating the saved identity through the typed sidecar client…
        </div>
      ) : null}
      {isCheckingIdentity ? (
        <div className="identity-status" role="status" aria-live="polite" aria-atomic="true">
          Checking the advanced identity draft through the typed sidecar client…
        </div>
      ) : null}
      {isApplyingPreset ? (
        <div className="identity-status" role="status" aria-live="polite" aria-atomic="true">
          Applying the selected preset through the typed sidecar client…
        </div>
      ) : null}
      {isSaving ? (
        <div className="identity-status" role="status" aria-live="polite" aria-atomic="true">
          Saving the advanced identity override through the typed sidecar client…
        </div>
      ) : null}

      <section className="identity-preset-apply" aria-label={`${profile.name} preset apply controls`}>
        <div className="identity-panel-subhead">
          <strong>Apply a curated preset</strong>
          <span>{selectedPreset ? selectedPreset.label : selectedPresetUnavailable ? "Unavailable preset" : "No preset selected"}</span>
        </div>
        <div className="identity-preset-apply__controls">
          <div className="identity-preset-apply__field">
            <label htmlFor={presetSelectId}>Curated preset</label>
            <select
              id={presetSelectId}
              value={selectedPresetId}
              disabled={isIdentityBusy}
              aria-describedby={presetApplyHintId}
              onChange={(event) => onPresetSelect(profile.id, event.target.value)}
            >
              <option value="">Choose a preset…</option>
              {selectedPresetUnavailable ? <option value={selectedPresetId}>Unavailable preset {selectedPresetId}</option> : null}
              {presets.map((preset) =>
                preset.presetId ? (
                  <option key={preset.presetId} value={preset.presetId}>
                    {preset.label} · {preset.presetId}
                  </option>
                ) : null,
              )}
            </select>
          </div>
          <button
            type="button"
            disabled={!canApplyPreset}
            aria-describedby={presetApplyHintId}
            onClick={() => onApplyPreset(profile, selectedPresetId)}
          >
            {isApplyingPreset ? "Applying preset…" : "Apply preset"}
          </button>
        </div>
        <p id={presetApplyHintId} className="identity-muted-copy" role="status" aria-live="polite">
          {applyDisabledReason
            ?? `${selectedPreset?.label ?? "The selected preset"} will be saved through the typed identity mutation and used on the next Chromium launch.`}
        </p>
      </section>

      <section className="identity-advanced-editor" aria-label={`${profile.name} advanced identity editor`}>
        <div className="identity-panel-subhead">
          <strong>Advanced identity override</strong>
          <span>{fieldErrorCount ? `${fieldErrorCount} field error${fieldErrorCount === 1 ? "" : "s"}` : "Locally parseable draft"}</span>
        </div>
        <div className="identity-label-field">
          <label htmlFor={draftLabelId}>Advanced identity label</label>
          <input
            id={draftLabelId}
            value={draftState.values.label}
            maxLength={128}
            disabled={isIdentityBusy}
            aria-invalid={Boolean(draftLabelError)}
            aria-describedby={draftLabelError ? `${draftLabelHintId} ${draftLabelErrorId}` : draftLabelHintId}
            onChange={(event) => onDraftLabelChange(profile.id, event.target.value)}
          />
          <p id={draftLabelHintId} className="identity-field-hint">
            Advanced edits clear curated preset identity; edit this label if you want a custom name preserved on save.
          </p>
          {draftLabelError ? (
            <p id={draftLabelErrorId} className="identity-field-error" role="alert">
              {draftLabelError}
            </p>
          ) : null}
        </div>
        <IdentitySurfaceControlList
          controls={controls}
          draft={draftState}
          isBusy={isIdentityBusy}
          profile={profile}
          onFieldChange={onDraftFieldChange}
          onSurfaceModeChange={onSurfaceModeChange}
        />
        <div className="identity-advanced-actions">
          <button
            type="button"
            className="button--secondary"
            disabled={!canRunAdvancedAction}
            aria-describedby={advancedActionHintId}
            onClick={() => onCheckIdentity(profile)}
          >
            {isCheckingIdentity ? "Checking identity…" : "Check identity"}
          </button>
          <button
            type="button"
            disabled={!canRunAdvancedAction}
            aria-describedby={advancedActionHintId}
            onClick={() => onSaveIdentity(profile)}
          >
            {isSaving ? "Saving override…" : "Save advanced override"}
          </button>
        </div>
        <p id={advancedActionHintId} className="identity-muted-copy" role="status" aria-live="polite">
          {advancedDisabledReason
            ?? "Warnings from Check identity are visible but do not block Save advanced override; hard errors preserve the draft and previous profile truth."}
        </p>
      </section>

      {state.error ? (
        <IdentityConfigErrorFeedback
          diagnosticLookupState={diagnosticLookupState}
          state={state.error}
          onDiagnosticLookup={onDiagnosticLookup}
        />
      ) : null}

      <section className="identity-preset-list" aria-label={`${profile.name} curated identity presets`}>
        <div className="identity-panel-subhead">
          <strong>Curated presets</strong>
          <span>{presets.length ? `${presets.length} loaded` : "Not loaded yet"}</span>
        </div>
        {presets.length ? (
          <div className="identity-preset-list__items" role="list">
            {presets.map((preset) => (
              <article key={preset.presetId ?? preset.label} className="identity-preset-card" role="listitem">
                <strong>{preset.label}</strong>
                <dl className="metric-list metric-list--inline">
                  <Metric label="Preset" value={preset.presetId ? `Preset ${preset.presetId}` : "No preset"} />
                  <Metric label="Browser" value={formatIdentityMode(preset.browser.mode)} />
                  <Metric label="Canvas" value={formatIdentityMode(preset.canvas.mode)} />
                </dl>
              </article>
            ))}
          </div>
        ) : (
          <p className="identity-muted-copy">Preset choices appear here after the first successful panel load.</p>
        )}
      </section>

      {state.applySuccess ? <IdentityConfigSuccessFeedback state={state.applySuccess} /> : null}

      {state.savedWarnings.length ? (
        <IdentityWarningList
          title={state.applySuccess ? getIdentityWarningTitle(state.applySuccess.action) : "Saved identity warnings"}
          warnings={state.savedWarnings}
        />
      ) : null}
    </section>
  );
}

function IdentityConfigErrorFeedback({
  diagnosticLookupState,
  state,
  onDiagnosticLookup,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  state: IdentityConfigError;
  onDiagnosticLookup: (detailRef: string) => void;
}) {
  return (
    <section className="identity-error-feedback" role="alert" aria-live="assertive" aria-atomic="true">
      <strong>{IDENTITY_CONFIG_ACTION_LABELS[state.action]} failed safely.</strong>
      <p>{state.error.message}</p>
      <dl className="metric-list metric-list--inline">
        <Metric label="Code" value={state.error.code} />
        <Metric label="Source" value={state.error.source} />
        <Metric label="Recoverable" value={state.error.recoverable ? "yes" : "no"} />
        <Metric label="detailRef" value={state.error.detailRef} />
        <Metric label="Occurred" value={formatProfileTimestamp(state.occurredAt)} />
      </dl>
      <DiagnosticReference detailRef={state.error.detailRef} state={diagnosticLookupState} onLookup={onDiagnosticLookup} />
    </section>
  );
}

function IdentityConfigSuccessFeedback({ state }: { state: IdentityConfigSuccess }) {
  const warningCopy = formatIdentitySuccessCopy(state);
  const heading = state.action === "apply-preset"
    ? "Preset applied for next launch."
    : state.action === "check"
      ? "Identity check completed."
      : "Advanced override saved for next launch.";

  return (
    <section className="identity-success-feedback" role="status" aria-live="polite" aria-atomic="true">
      <strong>{heading}</strong>
      <p>{warningCopy}</p>
      <dl className="metric-list metric-list--inline">
        <Metric label="Action" value={IDENTITY_CONFIG_ACTION_LABELS[state.action]} />
        <Metric label="Label" value={state.label} />
        <Metric label="Preset" value={state.presetId ? `Preset ${state.presetId}` : "No preset"} />
        <Metric label="Warnings" value={state.warningCount} />
        <Metric label="Occurred" value={formatProfileTimestamp(state.occurredAt)} />
      </dl>
    </section>
  );
}

function IdentityWarningList({ title, warnings }: { title?: string; warnings: IdentityWarning[] }) {
  const heading = title ?? "Saved identity warnings";

  return (
    <section className="identity-warning-list" aria-label={heading}>
      <div className="identity-panel-subhead">
        <strong>{heading}</strong>
        <span>{warnings.length} warning{warnings.length === 1 ? "" : "s"}</span>
      </div>
      <div className="identity-warning-list__items" role="list">
        {warnings.map((warning) => (
          <article key={`${warning.code}-${warning.path}`} className="identity-warning-card" role="listitem">
            <strong>{warning.code}</strong>
            <p>{warning.message}</p>
            <dl className="metric-list metric-list--inline">
              <Metric label="Surface" value={warning.surface} />
              <Metric label="Path" value={warning.path} />
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function IdentitySurfaceControlList({
  controls,
  draft,
  isBusy,
  profile,
  onFieldChange,
  onSurfaceModeChange,
}: {
  controls: ReturnType<typeof getIdentitySurfaceControls>;
  draft: IdentityDraftState;
  isBusy: boolean;
  profile: ProfileRecord;
  onFieldChange: (profileId: string, path: Exclude<IdentityDraftFieldPath, "label">, value: string) => void;
  onSurfaceModeChange: (profileId: string, surface: IdentitySurface, mode: string) => void;
}) {
  return (
    <section className="identity-surface-controls" aria-label={`${profile.name} supported identity controls`}>
      <div className="identity-panel-subhead">
        <strong>Supported surface controls</strong>
        <span>Only supported modes are offered per surface</span>
      </div>
      <div className="identity-surface-controls__items">
        {controls.map((control) => {
          const modeSelectId = `identity-${profile.id}-${control.surface}-mode`;
          const modeHintId = `${modeSelectId}-hint`;
          const modeErrorId = `${modeSelectId}-error`;
          const modeError = draft.errors[`${control.surface}.mode`];
          const modeDescribedBy = modeError ? `${modeHintId} ${modeErrorId}` : modeHintId;
          return (
            <details key={control.surface} className="identity-surface-section" open>
              <summary>
                <span>{control.label}</span>
                <span>{control.modeLabel}</span>
              </summary>
              <div className="identity-surface-section__body">
                <div className="identity-field identity-field--mode">
                  <label htmlFor={modeSelectId}>{control.label} mode</label>
                  <select
                    id={modeSelectId}
                    value={control.mode}
                    disabled={isBusy}
                    aria-invalid={Boolean(modeError)}
                    aria-describedby={modeDescribedBy}
                    onChange={(event) => onSurfaceModeChange(profile.id, control.surface, event.target.value)}
                  >
                    {control.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p id={modeHintId} className="identity-field-hint">
                    {control.options.map((option) => `${option.label}: ${option.description}`).join(" ")}
                  </p>
                  {modeError ? (
                    <p id={modeErrorId} className="identity-field-error" role="alert">
                      {modeError}
                    </p>
                  ) : null}
                </div>
                {control.fields.length ? (
                  <div className="identity-field-grid">
                    {control.fields.map((field) => (
                      <IdentityDraftFieldControl
                        key={field.path}
                        draft={draft}
                        field={field}
                        isBusy={isBusy}
                        profile={profile}
                        onFieldChange={onFieldChange}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="identity-muted-copy">
                    {control.label} is using real host values; no saved advanced fields are sent for this surface.
                  </p>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function IdentityDraftFieldControl({
  draft,
  field,
  isBusy,
  profile,
  onFieldChange,
}: {
  draft: IdentityDraftState;
  field: IdentityDraftFieldDescriptor;
  isBusy: boolean;
  profile: ProfileRecord;
  onFieldChange: (profileId: string, path: Exclude<IdentityDraftFieldPath, "label">, value: string) => void;
}) {
  const fieldId = `identity-${profile.id}-${field.path.replace(/\./g, "-")}`;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const error = draft.errors[field.path];
  const describedBy = error ? `${hintId} ${errorId}` : hintId;
  const value = draft.values[field.path];

  return (
    <div className={`identity-field identity-field--${field.kind}`}>
      <label htmlFor={fieldId}>{field.label}</label>
      {field.kind === "textarea" ? (
        <textarea
          id={fieldId}
          value={value}
          rows={3}
          maxLength={field.maxLength}
          disabled={isBusy}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event) => onFieldChange(profile.id, field.path, event.target.value)}
        />
      ) : field.kind === "boolean" ? (
        <select
          id={fieldId}
          value={value}
          disabled={isBusy}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event) => onFieldChange(profile.id, field.path, event.target.value)}
        >
          <option value="false">False</option>
          <option value="true">True</option>
        </select>
      ) : field.kind === "webrtc-policy" ? (
        <select
          id={fieldId}
          value={value}
          disabled={isBusy}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event) => onFieldChange(profile.id, field.path, event.target.value)}
        >
          <option value="real">Real</option>
          <option value="disableNonProxiedUdp">Disable non-proxied UDP</option>
          <option value="block">Block WebRTC</option>
        </select>
      ) : (
        <input
          id={fieldId}
          type="text"
          inputMode={field.kind === "integer" ? "numeric" : field.kind === "number" ? "decimal" : undefined}
          value={value}
          maxLength={field.maxLength}
          disabled={isBusy}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event) => onFieldChange(profile.id, field.path, event.target.value)}
        />
      )}
      <p id={hintId} className="identity-field-hint">
        {field.description}
        {field.min !== undefined && field.max !== undefined ? ` Supported range: ${field.min}–${field.max}.` : ""}
      </p>
      {error ? (
        <p id={errorId} className="identity-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function getIdentityWarningTitle(action: IdentityConfigSuccess["action"]): string {
  if (action === "apply-preset") {
    return "Preset apply warnings";
  }
  if (action === "check") {
    return "Identity check warnings";
  }
  return "Saved override warnings";
}

function formatIdentitySuccessCopy(state: IdentityConfigSuccess): string {
  if (state.action === "apply-preset") {
    return state.warningCount === 0
      ? "Preset applied with 0 sidecar warnings. This records the configured identity for the next Chromium launch; it does not promise full fingerprint protection."
      : `Preset applied with ${state.warningCount} warning${state.warningCount === 1 ? "" : "s"}. Warnings are non-blocking and should be reviewed before the next launch.`;
  }
  if (state.action === "check") {
    return state.warningCount === 0
      ? "Identity check completed with 0 sidecar warnings. Save is still an explicit profile-store mutation."
      : `Identity check completed with ${state.warningCount} warning${state.warningCount === 1 ? "" : "s"}. Warnings are visible and saveable.`;
  }
  return state.warningCount === 0
    ? "Advanced override saved with 0 sidecar warnings and will be restored from the profile store on the next startup."
    : `Advanced override saved with ${state.warningCount} warning${state.warningCount === 1 ? "" : "s"}. Warnings are non-blocking and the profile-store snapshot is now visible.`;
}

function SystemStatusPanel({
  diagnosticLookupState,
  healthBusyAction,
  healthState,
  onDiagnosticLookup,
  onRefreshHealth,
  onTriggerDiagnostic,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  healthBusyAction: HealthBusyAction;
  healthState: HealthViewState;
  onDiagnosticLookup: (detailRef: string) => void;
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
          <DiagnosticReference detailRef={healthState.error.detailRef} state={diagnosticLookupState} onLookup={onDiagnosticLookup} />
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

function DiagnosticReference({
  detailRef,
  state,
  onLookup,
}: {
  detailRef: string;
  state: DiagnosticLookupState;
  onLookup: (detailRef: string) => void;
}) {
  const isSelected = state.detailRef === detailRef;
  const isLoading = isSelected && state.phase === "loading";

  return (
    <div className={`diagnostic-reference ${isSelected ? "diagnostic-reference--selected" : ""}`}>
      <span>
        Diagnostic reference <code>{detailRef}</code>
      </span>
      <button
        type="button"
        className="button--secondary diagnostic-reference__button"
        onClick={() => onLookup(detailRef)}
        disabled={isLoading}
        aria-label={`Lookup diagnostics for ${detailRef}`}
      >
        {isLoading ? "Looking up…" : "Lookup diagnostics"}
      </button>
    </div>
  );
}

function DiagnosticLookupPanel({ state, onRetry }: { state: DiagnosticLookupState; onRetry: () => void }) {
  const lookupTone = state.phase === "error" ? "error" : state.phase === "loading" ? "pending" : "ready";

  return (
    <section className={`sidecar-card diagnostic-lookup-card sidecar-card--${lookupTone}`} aria-label="Diagnostic lookup">
      <div className="sidecar-card__header">
        <div>
          <p className="kicker">Diagnostic lookup</p>
          <h2>{formatDiagnosticLookupHeading(state)}</h2>
        </div>
        <span className="mini-phase">{state.phase}</span>
      </div>

      {state.phase === "idle" ? (
        <p className="diagnostic-lookup-card__empty">
          Select a Lookup diagnostics action from a visible error to fetch a bounded, redacted event summary. The app never reads log files directly.
        </p>
      ) : null}

      {state.phase === "loading" && state.detailRef ? (
        <div className="diagnostic-lookup-card__status" role="status" aria-live="polite">
          Looking up redacted diagnostics for <code>{state.detailRef}</code>…
        </div>
      ) : null}

      {state.phase === "error" && state.detailRef && state.error ? (
        <div className="diagnostic-lookup-card__error" role="status" aria-live="polite">
          <p>{state.error.message}</p>
          <dl className="metric-list metric-list--inline">
            <Metric label="Selected detailRef" value={state.detailRef} />
            <Metric label="Lookup code" value={state.error.code} />
            <Metric label="Lookup source" value={state.error.source} />
            <Metric label="Lookup detailRef" value={state.error.detailRef} />
            <Metric label="Checked" value={formatProfileTimestamp(state.checkedAt)} />
          </dl>
          <button type="button" className="button--secondary" onClick={onRetry} aria-label={`Retry diagnostics lookup for ${state.detailRef}`}>
            Retry diagnostics lookup
          </button>
        </div>
      ) : null}

      {state.phase === "ready" && state.result ? (
        <div className="diagnostic-lookup-card__result" aria-live="polite">
          <p>{formatDiagnosticLookupReason(state.result)}</p>
          <dl className="metric-list metric-list--inline">
            <Metric label="detailRef" value={state.result.detailRef} />
            <Metric label="Reason" value={state.result.reason} />
            <Metric label="Log path" value={state.result.logPath ?? "No durable diagnostic log"} />
            <Metric label="Checked" value={formatProfileTimestamp(state.checkedAt)} />
            <Metric label="Entries" value={state.result.entries.length} />
          </dl>

          {state.result.entries.length ? (
            <div className="diagnostic-entry-list" role="list" aria-label={`Diagnostic events for ${state.result.detailRef}`}>
              {state.result.entries.map((entry, index) => (
                <DiagnosticEntrySummary key={`${entry.detailRef}-${entry.event}-${entry.ts}-${index}`} entry={entry} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function DiagnosticEntrySummary({ entry }: { entry: DiagnosticEntry }) {
  return (
    <article className="diagnostic-entry" role="listitem">
      <strong>{entry.event}</strong>
      <dl className="metric-list metric-list--inline">
        <Metric label="Source" value={entry.source} />
        <Metric label="Status" value={entry.status} />
        <Metric label="Method" value={entry.method} />
        <Metric label="Error code" value={entry.errorCode} />
        <Metric label="Request" value={entry.requestId === undefined ? undefined : String(entry.requestId)} />
        <Metric label="Duration" value={formatDiagnosticDuration(entry.durationMs)} />
        <Metric label="Occurred" value={formatProfileTimestamp(entry.ts)} />
        <Metric label="Log path" value={entry.logPath} />
        {"context" in entry ? <Metric label="Legacy ID" value={entry.context?.legacyId} /> : null}
        {"exitCode" in entry ? <Metric label="Exit code" value={entry.exitCode === null ? "not available" : entry.exitCode} /> : null}
        {"stdoutLines" in entry ? <Metric label="Stdout lines" value={entry.stdoutLines} /> : null}
        {"stderrLines" in entry ? <Metric label="Stderr lines" value={entry.stderrLines} /> : null}
      </dl>
    </article>
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

function formatIdentityAuditCategory(value: IdentityAuditPage["category"]): string {
  if (value === "browserleaks") {
    return "BrowserLeaks";
  }
  if (value === "consistency") {
    return "Consistency checker";
  }
  if (value === "privacy") {
    return "Privacy checker";
  }

  return value;
}

function formatIdentityAuditSurfaces(surfaces: IdentityAuditPage["surfaces"]): string {
  return surfaces.join(" · ");
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

function formatLegacyUserDataStatus(value: LegacyScanCandidate["userData"]["status"]): string {
  return value === "available" ? "User-data available" : "No user-data found";
}

function makeLegacyUiError(code: string, message: string): SidecarClientError {
  return {
    code,
    message,
    recoverable: true,
    detailRef: `ui-legacy-${code.toLowerCase().replace(/_/g, "-")}`,
    source: "ui",
    phase: "recoverable-error",
  };
}

function formatDiagnosticLookupHeading(state: DiagnosticLookupState): string {
  if (state.phase === "idle") {
    return "No diagnostic reference selected.";
  }
  if (state.phase === "loading") {
    return "Looking up redacted diagnostics.";
  }
  if (state.phase === "error") {
    return "Diagnostic lookup failed safely.";
  }
  if (state.result?.found) {
    return "Diagnostic events found.";
  }

  return "No persisted event found.";
}

function formatDiagnosticLookupReason(result: DiagnosticLookupResult): string {
  if (result.found) {
    return "Persisted diagnostic event summaries matched this detailRef.";
  }

  if (result.reason === "ui-local") {
    return "UI-local reference: no durable diagnostic log is available for this browser-local detailRef.";
  }

  if (result.reason === "not-persisted") {
    return "No persisted diagnostic event matched this detailRef yet. Retry after the sidecar writes its bounded event summary.";
  }

  return "The diagnostics store reported this detailRef as invalid or unavailable without exposing raw log text.";
}

function formatDiagnosticDuration(value: number | undefined): string {
  return typeof value === "number" ? `${value.toFixed(2)} ms` : "Unavailable";
}

function formatValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "Unavailable";
  }

  return String(value);
}
