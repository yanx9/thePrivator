import { type FormEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { buildGlobalStatusSummary, type GlobalStatusSummary } from "./globalStatus";
import { closeWindow, minimizeWindow, startDragging, toggleMaximizeWindow } from "./windowControls";
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
  FIXED_PROXY_PROTOCOL_OPTIONS,
  createProxyDraftState,
  formatProxyCredentialMode,
  parseProxyDraftState,
  updateProxyDraftCredentialField,
  updateProxyDraftCredentialMode,
  updateProxyDraftField,
  updateProxyDraftMode,
  type ProxyCredentialDraftMode,
  type ProxyDraftFieldPath,
  type ProxyDraftState,
} from "./proxyControls";
import {
  applyProfileIdentityPreset,
  copyAutomationApiToken,
  createProfile,
  deleteProfile,
  exportProfileCookies,
  exportProfilePackage,
  getAutomationApiStatus,
  getChromiumStatus,
  getIdentityAuditPlan,
  getSidecarHealth,
  importLegacyProfiles,
  importProfilePackage,
  launchChromiumProfile,
  listIdentityPresets,
  listProfiles,
  lookupDiagnosticDetail,
  openIdentityAuditPage,
  scanLegacyProfiles,
  startAutomationApi,
  stopAutomationApi,
  stopChromiumProfile,
  triggerSidecarDiagnosticFailure,
  replaceProfileCookies,
  updateProfile,
  updateProfileIdentity,
  updateProfileProxy,
  validateIdentity,
  validateProxy,
  checkProfileProxy,
} from "./sidecar/client";
import type {
  AutomationApiStatusSnapshot,
  ChromiumRunningProfileState,
  ChromiumStatusSnapshot,
  ChromiumStoppedProfileState,
  CookieExportFormat,
  CookieExportSnapshot,
  CookiePortabilityWarning,
  CookieReplaceSnapshot,
  DiagnosticEntry,
  DiagnosticLookupResult,
  ProfilePackageExportSnapshot,
  ProfilePackageImportSnapshot,
  ProfilePackageWarning,
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
  ProfileProxySummary,
  ProfileRecord,
  ProxyCheckSnapshot,
  ProxyProtocol,
  SidecarClientError,
  SidecarErrorSource,
  SidecarHealthSnapshot,
  SidecarUiPhase,
} from "./sidecar/types";

type HealthBusyAction = "health" | "diagnostic" | null;
type AutomationApiAction = "start" | "status" | "copy-token" | "stop";
type AutomationApiUiPhase =
  | "idle"
  | "ready"
  | "starting"
  | "refreshing"
  | "copying"
  | "stopping"
  | Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;
type AutomationApiError = {
  action: AutomationApiAction;
  error: SidecarClientError;
  occurredAt: string;
};
type AutomationApiCopyFeedback = {
  kind: "success" | "error";
  message: string;
  occurredAt: string;
  error?: SidecarClientError;
} | null;
type AutomationApiViewState = {
  phase: AutomationApiUiPhase;
  status: AutomationApiStatusSnapshot | null;
  error: AutomationApiError | null;
  currentAction: AutomationApiAction | null;
  lastSuccess: {
    action: Exclude<AutomationApiAction, "copy-token">;
    occurredAt: string;
    status: AutomationApiStatusSnapshot["status"];
  } | null;
  copyFeedback: AutomationApiCopyFeedback;
};
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

type ProxyConfigPhase = "idle" | "ready" | "checking" | "saving" | Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;

type ProxyConfigAction = "check" | "save";

type ProxyConfigError = {
  profileId: string;
  action: ProxyConfigAction;
  error: SidecarClientError;
  occurredAt: string;
};

type ProxyConfigSuccess = {
  profileId: string;
  action: ProxyConfigAction;
  requestId: string;
  summary: string;
  mode: ProfileProxySummary["mode"];
  protocol: ProxyProtocol | null;
  credentialState: ProfileProxySummary["credentialState"];
  warningCount: number;
  occurredAt: string;
};

type ProxyConfigPanelState = {
  isOpen: boolean;
  phase: ProxyConfigPhase;
  draft: ProxyDraftState | null;
  currentAction: ProxyConfigAction | null;
  error: ProxyConfigError | null;
  success: ProxyConfigSuccess | null;
};

type ProxyCheckPhase = "idle" | "running" | "success" | Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;

type ProxyCheckAction = "saved-proof";

type ProxyCheckError = {
  profileId: string;
  action: ProxyCheckAction;
  error: SidecarClientError;
  occurredAt: string;
};

type ProxyCheckPanelState = {
  phase: ProxyCheckPhase;
  currentAction: ProxyCheckAction | null;
  snapshot: ProxyCheckSnapshot | null;
  error: ProxyCheckError | null;
  requestedAt: string | null;
};

type ProxyCheckStateByProfile = Record<string, ProxyCheckPanelState>;

type ProxyCheckRuntimeGuard = {
  isKnown: boolean;
  reason: string | null;
};

type CookiePortabilityPhase =
  | "idle"
  | "choosing-file"
  | "exporting"
  | "replacing"
  | "success"
  | Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;

type CookiePortabilityAction = "export-netscape" | "export-theprivator-json" | "replace";

type CookiePortabilityError = {
  profileId: string;
  action: CookiePortabilityAction;
  error: SidecarClientError;
  occurredAt: string;
};

type CookiePortabilitySuccess = {
  profileId: string;
  action: CookiePortabilityAction;
  snapshot: CookieExportSnapshot | CookieReplaceSnapshot;
  occurredAt: string;
};

type CookiePortabilityPanelState = {
  phase: CookiePortabilityPhase;
  currentAction: CookiePortabilityAction | null;
  lastSuccess: CookiePortabilitySuccess | null;
  warnings: CookiePortabilityWarning[];
  error: CookiePortabilityError | null;
};

type CookiePortabilityStateByProfile = Record<string, CookiePortabilityPanelState>;

type CookiePortabilityRuntimeGuard = {
  isKnown: boolean;
  disabledReason: string | null;
};

type PackagePortabilityPhase =
  | "idle"
  | "choosing-file"
  | "exporting"
  | "importing"
  | "refreshing-profiles"
  | "success"
  | Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;

type PackagePortabilityAction = "export" | "import";

type PackagePortabilityError = {
  profileId: string | null;
  action: PackagePortabilityAction;
  error: SidecarClientError;
  occurredAt: string;
};

type PackagePortabilitySuccess = {
  profileId: string | null;
  action: PackagePortabilityAction;
  snapshot: ProfilePackageExportSnapshot | ProfilePackageImportSnapshot;
  occurredAt: string;
};

type PackageImportRefreshState = {
  error: SidecarClientError;
  occurredAt: string;
} | null;

type PackagePortabilityPanelState = {
  phase: PackagePortabilityPhase;
  currentAction: PackagePortabilityAction | null;
  lastSuccess: PackagePortabilitySuccess | null;
  warnings: ProfilePackageWarning[];
  error: PackagePortabilityError | null;
  refreshError?: PackageImportRefreshState;
};

type PackagePortabilityStateByProfile = Record<string, PackagePortabilityPanelState>;

type PackagePortabilityRuntimeGuard = {
  isKnown: boolean;
  disabledReason: string | null;
};

const INITIAL_PROXY_CHECK_PANEL_STATE: ProxyCheckPanelState = {
  phase: "idle",
  currentAction: null,
  snapshot: null,
  error: null,
  requestedAt: null,
};

const INITIAL_COOKIE_PORTABILITY_PANEL_STATE: CookiePortabilityPanelState = {
  phase: "idle",
  currentAction: null,
  lastSuccess: null,
  warnings: [],
  error: null,
};

const INITIAL_PACKAGE_PORTABILITY_PANEL_STATE: PackagePortabilityPanelState = {
  phase: "idle",
  currentAction: null,
  lastSuccess: null,
  warnings: [],
  error: null,
  refreshError: null,
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

const INITIAL_AUTOMATION_API_STATE: AutomationApiViewState = {
  phase: "idle",
  status: null,
  error: null,
  currentAction: null,
  lastSuccess: null,
  copyFeedback: null,
};

const AUTOMATION_API_PHASE_LABELS: Record<AutomationApiUiPhase, string> = {
  idle: "Automation API status not checked",
  ready: "Automation API lifecycle ready",
  starting: "Starting automation API",
  refreshing: "Refreshing automation API status",
  copying: "Copying automation API token",
  stopping: "Stopping automation API",
  "recoverable-error": "Recoverable automation API error",
  "bridge-error": "Automation API bridge error",
};

const AUTOMATION_API_ACTION_LABELS: Record<AutomationApiAction, string> = {
  start: "Start API",
  status: "Refresh API status",
  "copy-token": "Copy token",
  stop: "Stop API",
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

const PROXY_CONFIG_PHASE_LABELS: Record<ProxyConfigPhase, string> = {
  idle: "Proxy panel closed",
  ready: "Proxy configuration ready",
  checking: "Checking proxy draft",
  saving: "Saving proxy configuration",
  "recoverable-error": "Recoverable proxy error",
  "bridge-error": "Proxy bridge error",
};

const PROXY_CONFIG_ACTION_LABELS: Record<ProxyConfigAction, string> = {
  check: "Check proxy draft",
  save: "Save proxy configuration",
};

const PROXY_CHECK_PHASE_LABELS: Record<ProxyCheckPhase, string> = {
  idle: "Saved proxy proof not run",
  running: "Running saved proxy proof",
  success: "Saved proxy proof complete",
  "recoverable-error": "Recoverable saved proxy proof error",
  "bridge-error": "Saved proxy proof bridge error",
};

const PROXY_CHECK_ACTION_LABELS: Record<ProxyCheckAction, string> = {
  "saved-proof": "Run saved proxy proof",
};

const COOKIE_PORTABILITY_PHASE_LABELS: Record<CookiePortabilityPhase, string> = {
  idle: "No cookie portability operation has run",
  "choosing-file": "Waiting for native dialog selection",
  exporting: "Exporting cookies through the sidecar",
  replacing: "Replacing cookies through the sidecar",
  success: "Cookie portability operation completed",
  "recoverable-error": "Recoverable cookie portability error",
  "bridge-error": "Cookie portability bridge error",
};

const COOKIE_PORTABILITY_ACTION_LABELS: Record<CookiePortabilityAction, string> = {
  "export-netscape": "Export Netscape cookies.txt",
  "export-theprivator-json": "Export ThePrivator JSON",
  replace: "Replace cookies",
};

const COOKIE_EXPORT_FORMAT_LABELS: Record<CookieExportFormat, string> = {
  netscape: "Netscape cookies.txt",
  "theprivator-json": "ThePrivator JSON",
};

const PACKAGE_PORTABILITY_PHASE_LABELS: Record<PackagePortabilityPhase, string> = {
  idle: "No package portability operation has run",
  "choosing-file": "Waiting for native package dialog selection",
  exporting: "Exporting ThePrivator package through the sidecar",
  importing: "Importing ThePrivator package through the sidecar",
  "refreshing-profiles": "Refreshing profile list after package import",
  success: "Package portability operation completed",
  "recoverable-error": "Recoverable package portability error",
  "bridge-error": "Package portability bridge error",
};

const PACKAGE_PORTABILITY_ACTION_LABELS: Record<PackagePortabilityAction, string> = {
  export: "Export ThePrivator package",
  import: "Import ThePrivator package",
};

const EMPTY_DETAIL_REF = "Waiting for first sidecar response";
const CHROMIUM_STATUS_POLL_MS = 2800;

export function App() {
  const [healthState, setHealthState] = useState<HealthViewState>(INITIAL_HEALTH_STATE);
  const [healthBusyAction, setHealthBusyAction] = useState<HealthBusyAction>("health");
  const [automationApiState, setAutomationApiState] = useState<AutomationApiViewState>(INITIAL_AUTOMATION_API_STATE);
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
  const [proxyPanelProfileId, setProxyPanelProfileId] = useState<string | null>(null);
  const [proxyDraft, setProxyDraft] = useState<ProxyDraftState | null>(null);
  const [proxyConfigPhase, setProxyConfigPhase] = useState<ProxyConfigPhase>("idle");
  const [proxyCurrentAction, setProxyCurrentAction] = useState<ProxyConfigAction | null>(null);
  const [proxyConfigError, setProxyConfigError] = useState<ProxyConfigError | null>(null);
  const [proxyConfigSuccess, setProxyConfigSuccess] = useState<ProxyConfigSuccess | null>(null);
  const [proxyCheckByProfile, setProxyCheckByProfile] = useState<ProxyCheckStateByProfile>({});
  const [cookiePortabilityByProfile, setCookiePortabilityByProfile] = useState<CookiePortabilityStateByProfile>({});
  const [packagePortabilityByProfile, setPackagePortabilityByProfile] = useState<PackagePortabilityStateByProfile>({});
  const [packageImportState, setPackageImportState] = useState<PackagePortabilityPanelState>(INITIAL_PACKAGE_PORTABILITY_PANEL_STATE);

  const healthInFlightRef = useRef(false);
  const automationApiActionInFlightRef = useRef(false);
  const automationApiRequestIdRef = useRef(0);
  const profileLoadInFlightRef = useRef(false);
  const chromiumStatusInFlightRef = useRef(false);
  const diagnosticLookupRequestIdRef = useRef(0);
  const identityConfigRequestIdRef = useRef(0);
  const identityAuditRequestIdRef = useRef(0);
  const proxyConfigRequestIdRef = useRef(0);
  const proxyCheckRequestIdRef = useRef(0);
  const proxyCheckRequestByProfileRef = useRef<Record<string, number>>({});
  const cookiePortabilityRequestIdRef = useRef(0);
  const cookiePortabilityRequestByProfileRef = useRef<Record<string, number>>({});
  const packagePortabilityRequestIdRef = useRef(0);
  const packageExportRequestByProfileRef = useRef<Record<string, number>>({});
  const packageImportRequestIdRef = useRef(0);
  const chromiumRuntimeByProfileRef = useRef<Record<string, ChromiumRunningProfileState>>({});
  const chromiumMutationRef = useRef<ChromiumLifecycleMutation>(null);
  const profileIdsRef = useRef<Set<string>>(new Set());

  const applyProfileSnapshot = useCallback((snapshot: ProfileListSnapshot | ProfileMutationSnapshot) => {
    const nextProfileIds = new Set(snapshot.profiles.map((profile) => profile.id));
    profileIdsRef.current = nextProfileIds;
    Object.keys(proxyCheckRequestByProfileRef.current).forEach((profileId) => {
      if (!nextProfileIds.has(profileId)) {
        delete proxyCheckRequestByProfileRef.current[profileId];
      }
    });
    Object.keys(cookiePortabilityRequestByProfileRef.current).forEach((profileId) => {
      if (!nextProfileIds.has(profileId)) {
        delete cookiePortabilityRequestByProfileRef.current[profileId];
      }
    });
    Object.keys(packageExportRequestByProfileRef.current).forEach((profileId) => {
      if (!nextProfileIds.has(profileId)) {
        delete packageExportRequestByProfileRef.current[profileId];
      }
    });
    setProxyCheckByProfile((current) => {
      let changed = false;
      const next: ProxyCheckStateByProfile = {};
      Object.entries(current).forEach(([profileId, state]) => {
        if (nextProfileIds.has(profileId)) {
          next[profileId] = state;
        } else {
          changed = true;
        }
      });
      return changed ? next : current;
    });
    setCookiePortabilityByProfile((current) => {
      let changed = false;
      const next: CookiePortabilityStateByProfile = {};
      Object.entries(current).forEach(([profileId, state]) => {
        if (nextProfileIds.has(profileId)) {
          next[profileId] = state;
        } else {
          changed = true;
        }
      });
      return changed ? next : current;
    });
    setPackagePortabilityByProfile((current) => {
      let changed = false;
      const next: PackagePortabilityStateByProfile = {};
      Object.entries(current).forEach(([profileId, state]) => {
        if (nextProfileIds.has(profileId)) {
          next[profileId] = state;
        } else {
          changed = true;
        }
      });
      return changed ? next : current;
    });
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

  const runAutomationApiStatusAction = useCallback(
    async (
      action: Exclude<AutomationApiAction, "copy-token">,
      operation: () => Promise<AutomationApiStatusSnapshot>,
    ) => {
      if (automationApiActionInFlightRef.current) {
        return;
      }

      const requestId = automationApiRequestIdRef.current + 1;
      automationApiRequestIdRef.current = requestId;
      automationApiActionInFlightRef.current = true;
      setAutomationApiState((current) => ({
        ...current,
        phase: action === "start" ? "starting" : action === "stop" ? "stopping" : "refreshing",
        currentAction: action,
        error: null,
        copyFeedback: action === "stop" ? null : current.copyFeedback,
      }));

      try {
        const snapshot = await operation();
        if (automationApiRequestIdRef.current !== requestId) {
          return;
        }
        setAutomationApiState((current) => ({
          ...current,
          phase: "ready",
          status: snapshot,
          error: null,
          currentAction: null,
          lastSuccess: {
            action,
            occurredAt: snapshot.receivedAt,
            status: snapshot.status,
          },
          copyFeedback: action === "stop" ? null : current.copyFeedback,
        }));
      } catch (error) {
        if (automationApiRequestIdRef.current !== requestId) {
          return;
        }
        const clientError = error as SidecarClientError;
        setAutomationApiState((current) => ({
          ...current,
          phase: clientError.phase,
          error: {
            action,
            error: clientError,
            occurredAt: new Date().toISOString(),
          },
          currentAction: null,
        }));
      } finally {
        if (automationApiRequestIdRef.current === requestId) {
          automationApiActionInFlightRef.current = false;
        }
      }
    },
    [],
  );

  const handleCopyAutomationApiToken = useCallback(async () => {
    if (automationApiActionInFlightRef.current) {
      return;
    }

    const requestId = automationApiRequestIdRef.current + 1;
    automationApiRequestIdRef.current = requestId;
    automationApiActionInFlightRef.current = true;
    setAutomationApiState((current) => ({
      ...current,
      phase: "copying",
      currentAction: "copy-token",
      error: null,
      copyFeedback: null,
    }));

    try {
      const token = await copyAutomationApiToken();
      try {
        const clipboard = navigator.clipboard;
        if (!clipboard || typeof clipboard.writeText !== "function") {
          throw makeAutomationApiUiError(
            "AUTOMATION_API_CLIPBOARD_UNAVAILABLE",
            "Clipboard write is unavailable in this webview. The token was discarded without rendering it.",
          );
        }
        await clipboard.writeText(token);
      } catch (clipboardError) {
        if (isSafeUiError(clipboardError)) {
          throw clipboardError;
        }
        throw makeAutomationApiUiError(
          "AUTOMATION_API_CLIPBOARD_WRITE_FAILED",
          "Clipboard write failed. The token was discarded without rendering it.",
        );
      }

      if (automationApiRequestIdRef.current !== requestId) {
        return;
      }
      setAutomationApiState((current) => ({
        ...current,
        phase: "ready",
        error: null,
        currentAction: null,
        copyFeedback: {
          kind: "success",
          message: "Token copied to the clipboard and discarded from UI state.",
          occurredAt: new Date().toISOString(),
        },
      }));
    } catch (error) {
      if (automationApiRequestIdRef.current !== requestId) {
        return;
      }
      const clientError = error as SidecarClientError;
      setAutomationApiState((current) => ({
        ...current,
        phase: clientError.phase,
        error: {
          action: "copy-token",
          error: clientError,
          occurredAt: new Date().toISOString(),
        },
        currentAction: null,
        copyFeedback: {
          kind: "error",
          message: clientError.message,
          occurredAt: new Date().toISOString(),
          error: clientError,
        },
      }));
    } finally {
      if (automationApiRequestIdRef.current === requestId) {
        automationApiActionInFlightRef.current = false;
      }
    }
  }, []);

  const handleStartAutomationApi = useCallback(() => {
    void runAutomationApiStatusAction("start", startAutomationApi);
  }, [runAutomationApiStatusAction]);

  const handleRefreshAutomationApiStatus = useCallback(() => {
    void runAutomationApiStatusAction("status", getAutomationApiStatus);
  }, [runAutomationApiStatusAction]);

  const handleStopAutomationApi = useCallback(() => {
    void runAutomationApiStatusAction("stop", stopAutomationApi);
  }, [runAutomationApiStatusAction]);

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

  const recordProxyConfigError = useCallback((profileId: string, action: ProxyConfigAction, error: SidecarClientError) => {
    setProxyConfigSuccess(null);
    setProxyConfigError({
      profileId,
      action,
      error,
      occurredAt: new Date().toISOString(),
    });
    setProxyConfigPhase(error.phase);
    setProxyCurrentAction(action);
  }, []);

  const recordProxyCheckError = useCallback((profileId: string, error: SidecarClientError) => {
    setProxyCheckByProfile((current) => ({
      ...current,
      [profileId]: {
        phase: error.phase,
        currentAction: "saved-proof",
        snapshot: null,
        error: {
          profileId,
          action: "saved-proof",
          error,
          occurredAt: new Date().toISOString(),
        },
        requestedAt: current[profileId]?.requestedAt ?? new Date().toISOString(),
      },
    }));
  }, []);

  const clearProxyCheckStateForProfile = useCallback((profileId: string) => {
    delete proxyCheckRequestByProfileRef.current[profileId];
    setProxyCheckByProfile((current) => {
      if (!current[profileId]) {
        return current;
      }

      const next = { ...current };
      delete next[profileId];
      return next;
    });
  }, []);

  const getCookiePortabilityDisabledReason = useCallback(
    (profile: ProfileRecord, options: { ignoreActiveOperation?: boolean } = {}): string | null => {
      const lifecycleMutation = chromiumMutationRef.current;
      const currentState = cookiePortabilityByProfile[profile.id];

      if (chromiumPhase !== "ready") {
        return `Chromium lifecycle status is ${chromiumPhase}; cookie portability fails closed until status refresh confirms the profile is stopped.`;
      }
      if (isProfileLoading || mutationPhase !== "idle") {
        return "Profile loading or mutation is in progress; wait before moving cookies.";
      }
      if (chromiumRuntimeByProfileRef.current[profile.id]) {
        return "Cookie portability is stopped-profile only. Stop Chromium before exporting or replacing cookies.";
      }
      if (lifecycleMutation !== null) {
        return `Chromium is ${lifecycleMutation.phase}; cookie portability fails closed until the lifecycle action settles.`;
      }
      if (!options.ignoreActiveOperation && (currentState?.phase === "choosing-file" || currentState?.phase === "exporting" || currentState?.phase === "replacing")) {
        return "A cookie portability operation is already running for this profile.";
      }

      return null;
    },
    [chromiumPhase, cookiePortabilityByProfile, isProfileLoading, mutationPhase],
  );

  const recordCookiePortabilityError = useCallback((profileId: string, action: CookiePortabilityAction, error: SidecarClientError) => {
    setCookiePortabilityByProfile((current) => {
      const previous = current[profileId] ?? INITIAL_COOKIE_PORTABILITY_PANEL_STATE;
      return {
        ...current,
        [profileId]: {
          ...previous,
          phase: error.phase,
          currentAction: null,
          error: {
            profileId,
            action,
            error,
            occurredAt: new Date().toISOString(),
          },
        },
      };
    });
  }, []);

  const finishCookiePortabilityCancel = useCallback((profileId: string) => {
    setCookiePortabilityByProfile((current) => {
      const previous = current[profileId] ?? INITIAL_COOKIE_PORTABILITY_PANEL_STATE;
      return {
        ...current,
        [profileId]: {
          ...previous,
          phase: previous.lastSuccess ? "success" : "idle",
          currentAction: null,
          error: null,
        },
      };
    });
  }, []);

  const startCookiePortabilityAction = useCallback((profileId: string, action: CookiePortabilityAction) => {
    setCookiePortabilityByProfile((current) => {
      const previous = current[profileId] ?? INITIAL_COOKIE_PORTABILITY_PANEL_STATE;
      return {
        ...current,
        [profileId]: {
          ...previous,
          phase: "choosing-file",
          currentAction: action,
          error: null,
        },
      };
    });
  }, []);

  const runProfileCookieExport = useCallback(
    async (profile: ProfileRecord, action: Extract<CookiePortabilityAction, "export-netscape" | "export-theprivator-json">, format: CookieExportFormat) => {
      const disabledReason = getCookiePortabilityDisabledReason(profile);
      if (disabledReason) {
        recordCookiePortabilityError(profile.id, action, makeCookiePortabilityUiError("PORTABILITY_UI_BUSY", disabledReason));
        return;
      }

      const requestId = cookiePortabilityRequestIdRef.current + 1;
      cookiePortabilityRequestIdRef.current = requestId;
      cookiePortabilityRequestByProfileRef.current[profile.id] = requestId;
      startCookiePortabilityAction(profile.id, action);

      try {
        const destinationPath = await save({
          title: format === "netscape" ? "Export cookies as Netscape cookies.txt" : "Export cookies as ThePrivator JSON",
          filters: [
            {
              name: COOKIE_EXPORT_FORMAT_LABELS[format],
              extensions: [format === "netscape" ? "txt" : "json"],
            },
          ],
        });

        if (cookiePortabilityRequestByProfileRef.current[profile.id] !== requestId || !profileIdsRef.current.has(profile.id)) {
          return;
        }

        const safeDestinationPath = parseDialogPathSelection(destinationPath, "save");
        if (safeDestinationPath === null) {
          finishCookiePortabilityCancel(profile.id);
          return;
        }

        const secondDisabledReason = getCookiePortabilityDisabledReason(profile, { ignoreActiveOperation: true });
        if (secondDisabledReason) {
          recordCookiePortabilityError(profile.id, action, makeCookiePortabilityUiError("PORTABILITY_UI_BUSY", secondDisabledReason));
          return;
        }

        setCookiePortabilityByProfile((current) => {
          const previous = current[profile.id] ?? INITIAL_COOKIE_PORTABILITY_PANEL_STATE;
          return {
            ...current,
            [profile.id]: {
              ...previous,
              phase: "exporting",
              currentAction: action,
              error: null,
            },
          };
        });

        const snapshot = await exportProfileCookies(profile.id, safeDestinationPath, format);
        if (cookiePortabilityRequestByProfileRef.current[profile.id] !== requestId || !profileIdsRef.current.has(profile.id)) {
          return;
        }

        setCookiePortabilityByProfile((current) => ({
          ...current,
          [profile.id]: {
            phase: "success",
            currentAction: null,
            lastSuccess: {
              profileId: profile.id,
              action,
              snapshot,
              occurredAt: new Date().toISOString(),
            },
            warnings: snapshot.warnings,
            error: null,
          },
        }));
      } catch (error) {
        if (cookiePortabilityRequestByProfileRef.current[profile.id] !== requestId || !profileIdsRef.current.has(profile.id)) {
          return;
        }
        const clientError = error instanceof DialogSelectionError
          ? error.toClientError()
          : isSafeUiError(error)
            ? error
            : makeCookiePortabilityDialogError();
        recordCookiePortabilityError(profile.id, action, clientError);
      }
    },
    [finishCookiePortabilityCancel, getCookiePortabilityDisabledReason, recordCookiePortabilityError, startCookiePortabilityAction],
  );

  const handleExportNetscapeCookies = useCallback(
    (profile: ProfileRecord) => {
      void runProfileCookieExport(profile, "export-netscape", "netscape");
    },
    [runProfileCookieExport],
  );

  const handleExportThePrivatorCookies = useCallback(
    (profile: ProfileRecord) => {
      void runProfileCookieExport(profile, "export-theprivator-json", "theprivator-json");
    },
    [runProfileCookieExport],
  );

  const handleReplaceProfileCookies = useCallback(
    async (profile: ProfileRecord) => {
      const action: CookiePortabilityAction = "replace";
      const disabledReason = getCookiePortabilityDisabledReason(profile);
      if (disabledReason) {
        recordCookiePortabilityError(profile.id, action, makeCookiePortabilityUiError("PORTABILITY_UI_BUSY", disabledReason));
        return;
      }

      const requestId = cookiePortabilityRequestIdRef.current + 1;
      cookiePortabilityRequestIdRef.current = requestId;
      cookiePortabilityRequestByProfileRef.current[profile.id] = requestId;
      startCookiePortabilityAction(profile.id, action);

      try {
        const sourcePath = await open({
          title: "Replace profile cookies from a cookie file",
          multiple: false,
          filters: [
            {
              name: "Cookie files",
              extensions: ["txt", "json"],
            },
          ],
        });

        if (cookiePortabilityRequestByProfileRef.current[profile.id] !== requestId || !profileIdsRef.current.has(profile.id)) {
          return;
        }

        const safeSourcePath = parseDialogPathSelection(sourcePath, "open");
        if (safeSourcePath === null) {
          finishCookiePortabilityCancel(profile.id);
          return;
        }

        const secondDisabledReason = getCookiePortabilityDisabledReason(profile, { ignoreActiveOperation: true });
        if (secondDisabledReason) {
          recordCookiePortabilityError(profile.id, action, makeCookiePortabilityUiError("PORTABILITY_UI_BUSY", secondDisabledReason));
          return;
        }

        setCookiePortabilityByProfile((current) => {
          const previous = current[profile.id] ?? INITIAL_COOKIE_PORTABILITY_PANEL_STATE;
          return {
            ...current,
            [profile.id]: {
              ...previous,
              phase: "replacing",
              currentAction: action,
              error: null,
            },
          };
        });

        const snapshot = await replaceProfileCookies(profile.id, safeSourcePath);
        if (cookiePortabilityRequestByProfileRef.current[profile.id] !== requestId || !profileIdsRef.current.has(profile.id)) {
          return;
        }

        setCookiePortabilityByProfile((current) => ({
          ...current,
          [profile.id]: {
            phase: "success",
            currentAction: null,
            lastSuccess: {
              profileId: profile.id,
              action,
              snapshot,
              occurredAt: new Date().toISOString(),
            },
            warnings: snapshot.warnings,
            error: null,
          },
        }));
      } catch (error) {
        if (cookiePortabilityRequestByProfileRef.current[profile.id] !== requestId || !profileIdsRef.current.has(profile.id)) {
          return;
        }
        const clientError = error instanceof DialogSelectionError
          ? error.toClientError()
          : isSafeUiError(error)
            ? error
            : makeCookiePortabilityDialogError();
        recordCookiePortabilityError(profile.id, action, clientError);
      }
    },
    [finishCookiePortabilityCancel, getCookiePortabilityDisabledReason, recordCookiePortabilityError, startCookiePortabilityAction],
  );

  const isPackageImportRunning = isPackagePortabilityOperationRunning(packageImportState);

  const getPackageExportDisabledReason = useCallback(
    (profile: ProfileRecord, options: { ignoreActiveOperation?: boolean } = {}): string | null => {
      const lifecycleMutation = chromiumMutationRef.current;
      const currentPackageState = packagePortabilityByProfile[profile.id];
      const currentCookieState = cookiePortabilityByProfile[profile.id];

      if (chromiumPhase !== "ready") {
        return `Chromium lifecycle status is ${chromiumPhase}; package export fails closed until status refresh confirms the profile is stopped.`;
      }
      if (isProfileLoading || mutationPhase !== "idle") {
        return "Profile loading or mutation is in progress; wait before exporting a package.";
      }
      if (chromiumRuntimeByProfileRef.current[profile.id]) {
        return "Profile package export is stopped-profile only. Stop Chromium before exporting a .tpkg package.";
      }
      if (lifecycleMutation !== null) {
        return `Chromium is ${lifecycleMutation.phase}; package export fails closed until the lifecycle action settles.`;
      }
      if (isCookiePortabilityOperationRunning(currentCookieState)) {
        return "A cookie portability operation is already running for this profile.";
      }
      if (!options.ignoreActiveOperation && isPackagePortabilityOperationRunning(currentPackageState)) {
        return "A package portability operation is already running for this profile.";
      }

      return null;
    },
    [chromiumPhase, cookiePortabilityByProfile, isProfileLoading, mutationPhase, packagePortabilityByProfile],
  );

  const getPackageImportDisabledReason = useCallback((): string | null => {
    if (isProfileLoading || mutationPhase !== "idle") {
      return "Profile loading or mutation is in progress; wait before importing a package.";
    }
    if (chromiumPhase !== "ready") {
      return `Chromium lifecycle status is ${chromiumPhase}; package import waits for known runtime state before refreshing profiles.`;
    }
    if (chromiumMutationRef.current !== null) {
      return `Chromium is ${chromiumMutationRef.current.phase}; package import waits until the lifecycle action settles.`;
    }
    if (isPackageImportRunning) {
      return "A package import operation is already running.";
    }

    return null;
  }, [chromiumPhase, isPackageImportRunning, isProfileLoading, mutationPhase]);

  const recordPackagePortabilityError = useCallback((profileId: string | null, action: PackagePortabilityAction, error: SidecarClientError) => {
    const nextError: PackagePortabilityError = {
      profileId,
      action,
      error,
      occurredAt: new Date().toISOString(),
    };

    if (profileId) {
      setPackagePortabilityByProfile((current) => {
        const previous = current[profileId] ?? INITIAL_PACKAGE_PORTABILITY_PANEL_STATE;
        return {
          ...current,
          [profileId]: {
            ...previous,
            phase: error.phase,
            currentAction: null,
            error: nextError,
          },
        };
      });
      return;
    }

    setPackageImportState((current) => ({
      ...current,
      phase: error.phase,
      currentAction: null,
      error: nextError,
    }));
  }, []);

  const finishPackageExportCancel = useCallback((profileId: string) => {
    setPackagePortabilityByProfile((current) => {
      const previous = current[profileId] ?? INITIAL_PACKAGE_PORTABILITY_PANEL_STATE;
      return {
        ...current,
        [profileId]: {
          ...previous,
          phase: previous.lastSuccess ? "success" : "idle",
          currentAction: null,
          error: null,
        },
      };
    });
  }, []);

  const finishPackageImportCancel = useCallback(() => {
    setPackageImportState((current) => ({
      ...current,
      phase: current.lastSuccess ? "success" : "idle",
      currentAction: null,
      error: null,
    }));
  }, []);

  const startPackageExportAction = useCallback((profileId: string) => {
    setPackagePortabilityByProfile((current) => {
      const previous = current[profileId] ?? INITIAL_PACKAGE_PORTABILITY_PANEL_STATE;
      return {
        ...current,
        [profileId]: {
          ...previous,
          phase: "choosing-file",
          currentAction: "export",
          error: null,
          refreshError: null,
        },
      };
    });
  }, []);

  const handleExportProfilePackage = useCallback(
    async (profile: ProfileRecord) => {
      const action: PackagePortabilityAction = "export";
      const disabledReason = getPackageExportDisabledReason(profile);
      if (disabledReason) {
        recordPackagePortabilityError(profile.id, action, makePackagePortabilityUiError("PACKAGE_PORTABILITY_UI_BUSY", disabledReason));
        return;
      }

      const requestId = packagePortabilityRequestIdRef.current + 1;
      packagePortabilityRequestIdRef.current = requestId;
      packageExportRequestByProfileRef.current[profile.id] = requestId;
      startPackageExportAction(profile.id);

      try {
        const destinationPath = await save({
          title: "Export ThePrivator package",
          filters: [{ name: "ThePrivator package", extensions: ["tpkg"] }],
        });

        if (packageExportRequestByProfileRef.current[profile.id] !== requestId || !profileIdsRef.current.has(profile.id)) {
          return;
        }

        const safeDestinationPath = parseDialogPathSelection(destinationPath, "save");
        if (safeDestinationPath === null) {
          finishPackageExportCancel(profile.id);
          return;
        }

        const secondDisabledReason = getPackageExportDisabledReason(profile, { ignoreActiveOperation: true });
        if (secondDisabledReason) {
          recordPackagePortabilityError(profile.id, action, makePackagePortabilityUiError("PACKAGE_PORTABILITY_UI_BUSY", secondDisabledReason));
          return;
        }

        setPackagePortabilityByProfile((current) => {
          const previous = current[profile.id] ?? INITIAL_PACKAGE_PORTABILITY_PANEL_STATE;
          return {
            ...current,
            [profile.id]: {
              ...previous,
              phase: "exporting",
              currentAction: action,
              error: null,
              refreshError: null,
            },
          };
        });

        const snapshot = await exportProfilePackage(profile.id, safeDestinationPath);
        if (packageExportRequestByProfileRef.current[profile.id] !== requestId || !profileIdsRef.current.has(profile.id)) {
          return;
        }

        setPackagePortabilityByProfile((current) => ({
          ...current,
          [profile.id]: {
            phase: "success",
            currentAction: null,
            lastSuccess: {
              profileId: profile.id,
              action,
              snapshot,
              occurredAt: new Date().toISOString(),
            },
            warnings: snapshot.warnings,
            error: null,
            refreshError: null,
          },
        }));
      } catch (error) {
        if (packageExportRequestByProfileRef.current[profile.id] !== requestId || !profileIdsRef.current.has(profile.id)) {
          return;
        }
        const clientError = error instanceof DialogSelectionError
          ? error.toClientError()
          : isSafeUiError(error)
            ? error
            : makePackagePortabilityDialogError();
        recordPackagePortabilityError(profile.id, action, clientError);
      }
    },
    [finishPackageExportCancel, getPackageExportDisabledReason, recordPackagePortabilityError, startPackageExportAction],
  );

  const handleImportProfilePackage = useCallback(async () => {
    const action: PackagePortabilityAction = "import";
    const disabledReason = getPackageImportDisabledReason();
    if (disabledReason) {
      recordPackagePortabilityError(null, action, makePackagePortabilityUiError("PACKAGE_PORTABILITY_UI_BUSY", disabledReason));
      return;
    }

    const requestId = packageImportRequestIdRef.current + 1;
    packageImportRequestIdRef.current = requestId;
    setPackageImportState((current) => ({
      ...current,
      phase: "choosing-file",
      currentAction: action,
      error: null,
      refreshError: null,
    }));

    try {
      const sourcePath = await open({
        title: "Import ThePrivator package",
        multiple: false,
        filters: [{ name: "ThePrivator package", extensions: ["tpkg"] }],
      });

      if (packageImportRequestIdRef.current !== requestId) {
        return;
      }

      const safeSourcePath = parseDialogPathSelection(sourcePath, "open");
      if (safeSourcePath === null) {
        finishPackageImportCancel();
        return;
      }

      const secondDisabledReason = getPackageImportDisabledReason();
      if (secondDisabledReason) {
        recordPackagePortabilityError(null, action, makePackagePortabilityUiError("PACKAGE_PORTABILITY_UI_BUSY", secondDisabledReason));
        return;
      }

      setPackageImportState((current) => ({
        ...current,
        phase: "importing",
        currentAction: action,
        error: null,
        refreshError: null,
      }));

      const snapshot = await importProfilePackage(safeSourcePath);
      if (packageImportRequestIdRef.current !== requestId) {
        return;
      }

      const success: PackagePortabilitySuccess = {
        profileId: snapshot.importedProfileId,
        action,
        snapshot,
        occurredAt: new Date().toISOString(),
      };

      setPackageImportState({
        phase: "refreshing-profiles",
        currentAction: action,
        lastSuccess: success,
        warnings: snapshot.warnings,
        error: null,
        refreshError: null,
      });

      profileLoadInFlightRef.current = true;
      setIsProfileLoading(true);
      setProfileError(null);
      setProfilePhase((current) => (current === "ready" ? "ready" : "loading"));

      try {
        const refreshedProfiles = await listProfiles();
        if (packageImportRequestIdRef.current !== requestId) {
          return;
        }
        applyProfileSnapshot(refreshedProfiles);
        setPackageImportState({
          phase: "success",
          currentAction: null,
          lastSuccess: success,
          warnings: snapshot.warnings,
          error: null,
          refreshError: null,
        });
      } catch (refreshError) {
        if (packageImportRequestIdRef.current !== requestId) {
          return;
        }
        const clientError = refreshError as SidecarClientError;
        setProfilePhase(clientError.phase);
        setProfileError({ context: "refresh", error: clientError });
        setPackageImportState({
          phase: "success",
          currentAction: null,
          lastSuccess: success,
          warnings: snapshot.warnings,
          error: null,
          refreshError: { error: clientError, occurredAt: new Date().toISOString() },
        });
      } finally {
        if (packageImportRequestIdRef.current === requestId) {
          profileLoadInFlightRef.current = false;
          setIsProfileLoading(false);
        }
      }
    } catch (error) {
      if (packageImportRequestIdRef.current !== requestId) {
        return;
      }
      const clientError = error instanceof DialogSelectionError
        ? error.toClientError()
        : isSafeUiError(error)
          ? error
          : makePackagePortabilityDialogError();
      recordPackagePortabilityError(null, action, clientError);
    }
  }, [applyProfileSnapshot, finishPackageImportCancel, getPackageImportDisabledReason, recordPackagePortabilityError]);

  const closeProxyConfig = useCallback(() => {
    proxyConfigRequestIdRef.current += 1;
    setProxyPanelProfileId(null);
    setProxyDraft(null);
    setProxyConfigPhase("idle");
    setProxyCurrentAction(null);
    setProxyConfigError(null);
    setProxyConfigSuccess(null);
  }, []);

  const openProxyConfig = useCallback(
    (profile: ProfileRecord) => {
      const requestId = proxyConfigRequestIdRef.current + 1;
      proxyConfigRequestIdRef.current = requestId;
      closeIdentityConfig();
      closeIdentityAuditPanel();
      setProxyPanelProfileId(profile.id);
      setProxyDraft(createProxyDraftState(profile.proxy));
      setProxyConfigPhase("ready");
      setProxyCurrentAction(null);
      setProxyConfigError(null);
      setProxyConfigSuccess(null);
    },
    [closeIdentityAuditPanel, closeIdentityConfig],
  );

  const handleProxyDraftModeChange = useCallback(
    (profileId: string, mode: string) => {
      if (proxyPanelProfileId !== profileId) {
        return;
      }

      setProxyDraft((current) => (current ? updateProxyDraftMode(current, mode) : current));
      setProxyConfigError(null);
      setProxyConfigSuccess(null);
      setProxyConfigPhase("ready");
      setProxyCurrentAction(null);
    },
    [proxyPanelProfileId],
  );

  const handleProxyDraftFieldChange = useCallback(
    (profileId: string, field: Extract<ProxyDraftFieldPath, "protocol" | "host" | "port">, value: string) => {
      if (proxyPanelProfileId !== profileId) {
        return;
      }

      setProxyDraft((current) => (current ? updateProxyDraftField(current, field, value) : current));
      setProxyConfigError(null);
      setProxyConfigSuccess(null);
      setProxyConfigPhase("ready");
      setProxyCurrentAction(null);
    },
    [proxyPanelProfileId],
  );

  const handleProxyDraftCredentialModeChange = useCallback(
    (profileId: string, credentialMode: ProxyCredentialDraftMode) => {
      if (proxyPanelProfileId !== profileId) {
        return;
      }

      setProxyDraft((current) => (current ? updateProxyDraftCredentialMode(current, credentialMode) : current));
      setProxyConfigError(null);
      setProxyConfigSuccess(null);
      setProxyConfigPhase("ready");
      setProxyCurrentAction(null);
    },
    [proxyPanelProfileId],
  );

  const handleProxyDraftCredentialFieldChange = useCallback(
    (profileId: string, field: "username" | "password", value: string) => {
      if (proxyPanelProfileId !== profileId) {
        return;
      }

      setProxyDraft((current) => (current ? updateProxyDraftCredentialField(current, field, value) : current));
      setProxyConfigError(null);
      setProxyConfigSuccess(null);
      setProxyConfigPhase("ready");
      setProxyCurrentAction(null);
    },
    [proxyPanelProfileId],
  );

  const handleSavedProxyProofCheck = useCallback(
    async (profile: ProfileRecord) => {
      const currentState = proxyCheckByProfile[profile.id];
      const lifecycleMutation = chromiumMutationRef.current;
      if (
        currentState?.phase === "running" ||
        isProfileLoading ||
        mutationPhase !== "idle" ||
        chromiumPhase !== "ready" ||
        chromiumRuntimeByProfileRef.current[profile.id] ||
        lifecycleMutation !== null
      ) {
        return;
      }

      const requestId = proxyCheckRequestIdRef.current + 1;
      proxyCheckRequestIdRef.current = requestId;
      proxyCheckRequestByProfileRef.current[profile.id] = requestId;
      const requestedAt = new Date().toISOString();
      setProxyCheckByProfile((current) => ({
        ...current,
        [profile.id]: {
          phase: "running",
          currentAction: "saved-proof",
          snapshot: null,
          error: null,
          requestedAt,
        },
      }));

      try {
        const snapshot = await checkProfileProxy(profile.id);
        if (proxyCheckRequestByProfileRef.current[profile.id] !== requestId || !profileIdsRef.current.has(profile.id)) {
          return;
        }

        setProxyCheckByProfile((current) => ({
          ...current,
          [profile.id]: {
            phase: "success",
            currentAction: null,
            snapshot,
            error: null,
            requestedAt,
          },
        }));
      } catch (error) {
        if (proxyCheckRequestByProfileRef.current[profile.id] !== requestId || !profileIdsRef.current.has(profile.id)) {
          return;
        }

        recordProxyCheckError(profile.id, error as SidecarClientError);
      }
    },
    [chromiumPhase, isProfileLoading, mutationPhase, proxyCheckByProfile, recordProxyCheckError],
  );

  const handleCheckProxy = useCallback(
    async (profile: ProfileRecord) => {
      const lifecycleMutation = chromiumMutationRef.current;
      if (
        proxyPanelProfileId !== profile.id ||
        !proxyDraft ||
        proxyConfigPhase === "checking" ||
        proxyConfigPhase === "saving" ||
        isProfileLoading ||
        mutationPhase !== "idle" ||
        chromiumRuntimeByProfileRef.current[profile.id] ||
        lifecycleMutation !== null
      ) {
        return;
      }

      const parsed = parseProxyDraftState(proxyDraft);
      if (!parsed.ok) {
        setProxyDraft({ ...proxyDraft, errors: parsed.errors });
        setProxyConfigError(null);
        setProxyConfigSuccess(null);
        setProxyConfigPhase("ready");
        setProxyCurrentAction(null);
        return;
      }

      const requestId = proxyConfigRequestIdRef.current;
      setProxyDraft({ ...proxyDraft, errors: {} });
      setProxyConfigPhase("checking");
      setProxyCurrentAction("check");
      setProxyConfigError(null);
      setProxyConfigSuccess(null);

      try {
        const snapshot = await validateProxy(parsed.proxy);
        if (proxyConfigRequestIdRef.current !== requestId) {
          return;
        }

        setProxyConfigSuccess(createProxyConfigSuccess(profile.id, "check", snapshot.proxy, snapshot.requestId, snapshot.warnings.length));
        setProxyConfigPhase("ready");
        setProxyCurrentAction(null);
        setProxyConfigError(null);
      } catch (error) {
        if (proxyConfigRequestIdRef.current !== requestId) {
          return;
        }

        recordProxyConfigError(profile.id, "check", error as SidecarClientError);
      }
    },
    [isProfileLoading, mutationPhase, proxyConfigPhase, proxyDraft, proxyPanelProfileId, recordProxyConfigError],
  );

  const handleSaveProxy = useCallback(
    async (profile: ProfileRecord) => {
      const lifecycleMutation = chromiumMutationRef.current;
      if (
        proxyPanelProfileId !== profile.id ||
        !proxyDraft ||
        proxyConfigPhase === "checking" ||
        proxyConfigPhase === "saving" ||
        isProfileLoading ||
        mutationPhase !== "idle" ||
        chromiumRuntimeByProfileRef.current[profile.id] ||
        lifecycleMutation !== null
      ) {
        return;
      }

      const parsed = parseProxyDraftState(proxyDraft);
      if (!parsed.ok) {
        setProxyDraft({ ...proxyDraft, errors: parsed.errors });
        setProxyConfigError(null);
        setProxyConfigSuccess(null);
        setProxyConfigPhase("ready");
        setProxyCurrentAction(null);
        return;
      }

      const requestId = proxyConfigRequestIdRef.current;
      setProxyDraft({ ...proxyDraft, errors: {} });
      setProxyConfigPhase("saving");
      setProxyCurrentAction("save");
      setProxyConfigError(null);
      setProxyConfigSuccess(null);

      try {
        const snapshot = await updateProfileProxy(profile.id, parsed.proxy);
        if (proxyConfigRequestIdRef.current !== requestId) {
          return;
        }

        applyProfileSnapshot(snapshot);
        clearProxyCheckStateForProfile(profile.id);
        setProxyDraft(createProxyDraftState(snapshot.profile.proxy));
        setProxyConfigSuccess(createProxyConfigSuccess(profile.id, "save", snapshot.profile.proxy, snapshot.requestId, 0));
        setProxyConfigPhase("ready");
        setProxyCurrentAction(null);
        setProxyConfigError(null);
      } catch (error) {
        if (proxyConfigRequestIdRef.current !== requestId) {
          return;
        }

        recordProxyConfigError(profile.id, "save", error as SidecarClientError);
      }
    },
    [applyProfileSnapshot, clearProxyCheckStateForProfile, isProfileLoading, mutationPhase, proxyConfigPhase, proxyDraft, proxyPanelProfileId, recordProxyConfigError],
  );

  const loadIdentityAuditPlan = useCallback((profile: ProfileRecord) => {
    closeProxyConfig();
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
  }, [closeProxyConfig]);

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
      closeProxyConfig();
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
    [closeProxyConfig, identityPresetCache, recordIdentityConfigError],
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
  const globalStatusSummary = useMemo(
    () => buildGlobalStatusSummary({
      health: {
        phase: healthState.phase,
        status: healthState.health?.health.status ?? null,
      },
      chromium: {
        phase: chromiumPhase,
        runningCount: chromiumRunningCount,
      },
      automationApi: {
        phase: automationApiState.phase,
        status: automationApiState.status?.status ?? null,
        running: automationApiState.status?.running ?? null,
      },
      profiles: {
        phase: profilePhase,
        count: profileCount,
      },
      attentionCandidates: [
        {
          source: "sidecar",
          phase: healthState.error?.phase ?? null,
          code: healthState.error?.code ?? null,
          detailRef: healthState.error?.detailRef ?? null,
          occurredAt: healthState.lastCheckedAt,
        },
        {
          source: "chromium",
          phase: lastLifecycleError?.error.phase ?? null,
          code: lastLifecycleError?.error.code ?? null,
          detailRef: lastLifecycleError?.error.detailRef ?? null,
          occurredAt: lastLifecycleError?.occurredAt ?? null,
        },
        {
          source: "automation",
          phase: automationApiState.error?.error.phase ?? automationApiState.status?.lastError?.phase ?? null,
          code: automationApiState.error?.error.code ?? automationApiState.status?.lastError?.code ?? null,
          detailRef: automationApiState.error?.error.detailRef ?? automationApiState.status?.lastError?.detailRef ?? null,
          occurredAt: automationApiState.error?.occurredAt ?? automationApiState.status?.lastError?.at ?? null,
        },
        {
          source: "profiles",
          phase: profileError?.error.phase ?? null,
          code: profileError?.error.code ?? null,
          detailRef: profileError?.error.detailRef ?? null,
          occurredAt: null,
        },
      ],
    }),
    [
      automationApiState.error?.error.code,
      automationApiState.error?.error.detailRef,
      automationApiState.error?.error.phase,
      automationApiState.error?.occurredAt,
      automationApiState.phase,
      automationApiState.status?.lastError?.at,
      automationApiState.status?.lastError?.code,
      automationApiState.status?.lastError?.detailRef,
      automationApiState.status?.lastError?.phase,
      automationApiState.status?.running,
      automationApiState.status?.status,
      chromiumPhase,
      chromiumRunningCount,
      healthState.error?.code,
      healthState.error?.detailRef,
      healthState.error?.phase,
      healthState.health?.health.status,
      healthState.lastCheckedAt,
      healthState.phase,
      lastLifecycleError?.error.code,
      lastLifecycleError?.error.detailRef,
      lastLifecycleError?.error.phase,
      lastLifecycleError?.occurredAt,
      profileCount,
      profileError?.error.code,
      profileError?.error.detailRef,
      profileError?.error.phase,
      profilePhase,
    ],
  );
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
  const packageImportDisabledReason = getPackageImportDisabledReason();

  return (
    <div className="shell app-frame profile-shell">
      <a className="skip-link" href="#profiles-workspace">Skip to profiles workspace</a>
      <WindowChrome />

      <header className="app-frame__topbar" aria-label="Workspace navigation">
        <nav className="primary-nav" aria-label="Primary workspace navigation">
          <a className="primary-nav__item primary-nav__item--active" href="#profiles-workspace" aria-current="page">
            Profiles
          </a>
          <span className="primary-nav__item primary-nav__item--future" aria-disabled="true">
            Import
          </span>
          <span className="primary-nav__item primary-nav__item--future" aria-disabled="true">
            Automation
          </span>
        </nav>
        <GlobalStatusBar summary={globalStatusSummary} />
      </header>

      <main id="profiles-workspace" className="profiles-main" aria-label="Profiles workspace" tabIndex={-1}>
        <section className="workspace-toolbar profile-hero" aria-label="Profiles workspace overview">
          <div className="hero-copy">
            <p className="kicker">Profiles</p>
            <h1 id="shell-heading">Profiles</h1>
            <p className="hero-lede">Create, import, launch, and stop browser profiles.</p>
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

          <ProfilePackageImportPanel
            diagnosticLookupState={diagnosticLookupState}
            disabledReason={packageImportDisabledReason}
            state={packageImportState}
            onDiagnosticLookup={runDiagnosticLookup}
            onImport={handleImportProfilePackage}
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
                  proxyConfigState={{
                    isOpen: proxyPanelProfileId === profile.id,
                    phase: proxyPanelProfileId === profile.id ? proxyConfigPhase : "idle",
                    draft: proxyPanelProfileId === profile.id ? proxyDraft : null,
                    currentAction: proxyPanelProfileId === profile.id ? proxyCurrentAction : null,
                    error: proxyConfigError?.profileId === profile.id ? proxyConfigError : null,
                    success: proxyConfigSuccess?.profileId === profile.id ? proxyConfigSuccess : null,
                  }}
                  proxyCheckState={proxyCheckByProfile[profile.id] ?? null}
                  cookiePortabilityState={cookiePortabilityByProfile[profile.id] ?? null}
                  packagePortabilityState={packagePortabilityByProfile[profile.id] ?? null}
                  cookiePortabilityRuntimeGuard={{
                    isKnown: chromiumPhase === "ready",
                    disabledReason: chromiumPhase === "ready" ? null : `Chromium lifecycle status is ${chromiumPhase}; cookie portability fails closed until status refresh confirms the profile is stopped.`,
                  }}
                  packagePortabilityRuntimeGuard={{
                    isKnown: chromiumPhase === "ready",
                    disabledReason: chromiumPhase === "ready" ? null : `Chromium lifecycle status is ${chromiumPhase}; package export fails closed until status refresh confirms the profile is stopped.`,
                  }}
                  proxyCheckRuntimeGuard={{
                    isKnown: chromiumPhase === "ready",
                    reason: chromiumPhase === "ready" ? null : `Chromium runtime status is ${chromiumPhase}; saved proxy proof fails closed until status refresh confirms no conflicting browser is running.`,
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
                  onExportNetscapeCookies={handleExportNetscapeCookies}
                  onExportProfilePackage={handleExportProfilePackage}
                  onExportThePrivatorCookies={handleExportThePrivatorCookies}
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
                  onProxyCheck={handleCheckProxy}
                  onProxyClose={closeProxyConfig}
                  onProxyConfigure={openProxyConfig}
                  onProxyDraftCredentialFieldChange={handleProxyDraftCredentialFieldChange}
                  onProxyDraftCredentialModeChange={handleProxyDraftCredentialModeChange}
                  onProxyDraftFieldChange={handleProxyDraftFieldChange}
                  onProxyDraftModeChange={handleProxyDraftModeChange}
                  onProxyProofCheck={handleSavedProxyProofCheck}
                  onProxySave={handleSaveProxy}
                  onRefreshStatus={() => void refreshChromiumStatus("manual")}
                  onRenameCancel={() => setEditing(null)}
                  onRenameRequest={() => {
                    setDeleteCandidate(null);
                    setEditing({ id: profile.id, name: profile.name });
                  }}
                  onRenameSubmit={handleRenameSubmit}
                  onReplaceProfileCookies={handleReplaceProfileCookies}
                  onStop={handleStopProfile}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="system-column workspace-utility-column" aria-label="Workspace utility panels">
          <SystemStatusPanel
            diagnosticLookupState={diagnosticLookupState}
            healthBusyAction={healthBusyAction}
            healthState={healthState}
            onDiagnosticLookup={runDiagnosticLookup}
            onRefreshHealth={refreshHealth}
            onTriggerDiagnostic={triggerDiagnosticError}
          />
          <AutomationApiPanel
            diagnosticLookupState={diagnosticLookupState}
            state={automationApiState}
            onCopyToken={handleCopyAutomationApiToken}
            onDiagnosticLookup={runDiagnosticLookup}
            onRefreshStatus={handleRefreshAutomationApiStatus}
            onStart={handleStartAutomationApi}
            onStop={handleStopAutomationApi}
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
  </div>
  );
}

function GlobalStatusBar({ summary }: { summary: GlobalStatusSummary }) {
  return (
    <section className={`global-status global-status--${summary.overallTone}`} aria-label="Global product status" aria-live="polite" aria-atomic="true">
      <div className="global-status__headline">
        <span className={`global-status__beacon global-status__beacon--${summary.overallTone}`} aria-hidden="true" />
        <strong>{summary.statusLine}</strong>
      </div>
      <dl className="global-status__items">
        {summary.items.map((item) => (
          <div key={item.key} className={`global-status__item global-status__item--${item.tone}`}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
            {item.supportActionHint ? <span className="global-status__hint">{item.supportActionHint}</span> : null}
          </div>
        ))}
      </dl>
    </section>
  );
}

function WindowChrome() {
  const handleDragStart = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    void startDragging();
  }, []);

  return (
    <header className="app-chrome" aria-label="ThePrivator window chrome">
      <div
        className="app-chrome__drag-region"
        data-tauri-drag-region
        aria-label="Window drag region"
        onMouseDown={handleDragStart}
      >
        <span className="app-chrome__mark" aria-hidden="true">TP</span>
        <div className="app-chrome__title">
          <span>ThePrivator</span>
          <small>Profile workspace</small>
        </div>
      </div>
      <div className="app-chrome__window-controls" aria-label="Window controls">
        <button type="button" className="app-chrome__control" aria-label="Minimize window" onClick={() => void minimizeWindow()}>
          <span aria-hidden="true">−</span>
        </button>
        <button type="button" className="app-chrome__control" aria-label="Maximize or restore window" onClick={() => void toggleMaximizeWindow()}>
          <span aria-hidden="true">□</span>
        </button>
        <button type="button" className="app-chrome__control app-chrome__control--close" aria-label="Close window" onClick={() => void closeWindow()}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </header>
  );
}

function ProfilePackageImportPanel({
  diagnosticLookupState,
  disabledReason,
  state,
  onDiagnosticLookup,
  onImport,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  disabledReason: string | null;
  state: PackagePortabilityPanelState;
  onDiagnosticLookup: (detailRef: string) => void;
  onImport: () => void;
}) {
  const isRunningOperation = isPackagePortabilityOperationRunning(state);
  const currentActionLabel = state.currentAction ? PACKAGE_PORTABILITY_ACTION_LABELS[state.currentAction] : "No active package import action";
  const hint = disabledReason ?? "Available because profile and lifecycle state are idle. Native open dialog cancel is a no-op.";

  return (
    <section className="package-import-panel" aria-label="ThePrivator package import">
      <div className="package-import-panel__header">
        <div>
          <p className="signal-label">Profile package import</p>
          <h4>Import a ThePrivator .tpkg package</h4>
          <p>
            Choose a package with the native dialog. The UI forwards the opaque selection only to the fixed package wrapper,
            then refreshes profiles so the imported stopped copy appears in the durable list.
          </p>
        </div>
        <span className="mini-phase" aria-label={`Package import phase: ${state.phase}`}>
          {state.phase}
        </span>
      </div>

      <dl className="metric-list metric-list--inline package-portability-observability" aria-label="ThePrivator package import observability">
        <Metric label="Package phase" value={`${state.phase} · ${PACKAGE_PORTABILITY_PHASE_LABELS[state.phase]}`} />
        <Metric label="Current action" value={currentActionLabel} />
        <Metric label="Last imported profile" value={getPackageProfileSummary(state.lastSuccess)} />
        <Metric label="Warnings" value={state.warnings.length} />
        <Metric label="Request" value={state.lastSuccess?.snapshot.requestId} />
        <Metric label="Bridge duration" value={state.lastSuccess ? formatDuration(state.lastSuccess.snapshot.bridgeDurationMs) : undefined} />
        <Metric label="detailRef" value={state.error?.error.detailRef ?? state.refreshError?.error.detailRef} />
      </dl>

      {isRunningOperation ? (
        <div className="package-portability-status" role="status" aria-live="polite" aria-atomic="true">
          {state.phase === "choosing-file"
            ? "Waiting for the native open dialog to return one package selection before any sidecar mutation starts."
            : state.phase === "refreshing-profiles"
              ? "Package imported; refreshing the durable profile list."
              : "Importing the package through the fixed sidecar command…"}
        </div>
      ) : null}

      <div className="package-portability-actions">
        <button type="button" disabled={disabledReason !== null || isRunningOperation} aria-describedby="package-import-action-hint" onClick={onImport}>
          {state.currentAction === "import" ? "Importing package…" : "Import ThePrivator package"}
        </button>
      </div>
      <p id="package-import-action-hint" className="package-portability-hint" role="status" aria-live="polite">
        {hint}
      </p>

      {state.lastSuccess ? <ProfilePackageSuccessFeedback state={state.lastSuccess} /> : null}
      {state.refreshError ? <ProfilePackageRefreshErrorFeedback state={state.refreshError} diagnosticLookupState={diagnosticLookupState} onDiagnosticLookup={onDiagnosticLookup} /> : null}
      {state.error ? <ProfilePackageErrorFeedback diagnosticLookupState={diagnosticLookupState} state={state.error} onDiagnosticLookup={onDiagnosticLookup} /> : null}
    </section>
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
  proxyConfigState,
  proxyCheckRuntimeGuard,
  proxyCheckState,
  cookiePortabilityRuntimeGuard,
  cookiePortabilityState,
  packagePortabilityRuntimeGuard,
  packagePortabilityState,
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
  onExportNetscapeCookies,
  onExportProfilePackage,
  onExportThePrivatorCookies,
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
  onProxyCheck,
  onProxyClose,
  onProxyConfigure,
  onProxyDraftCredentialFieldChange,
  onProxyDraftCredentialModeChange,
  onProxyDraftFieldChange,
  onProxyDraftModeChange,
  onProxyProofCheck,
  onProxySave,
  onRefreshStatus,
  onRenameCancel,
  onRenameRequest,
  onRenameSubmit,
  onReplaceProfileCookies,
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
  proxyConfigState: ProxyConfigPanelState;
  proxyCheckRuntimeGuard: ProxyCheckRuntimeGuard;
  proxyCheckState: ProxyCheckPanelState | null;
  cookiePortabilityRuntimeGuard: CookiePortabilityRuntimeGuard;
  cookiePortabilityState: CookiePortabilityPanelState | null;
  packagePortabilityRuntimeGuard: PackagePortabilityRuntimeGuard;
  packagePortabilityState: PackagePortabilityPanelState | null;
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
  onExportNetscapeCookies: (profile: ProfileRecord) => void;
  onExportProfilePackage: (profile: ProfileRecord) => void;
  onExportThePrivatorCookies: (profile: ProfileRecord) => void;
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
  onProxyCheck: (profile: ProfileRecord) => void;
  onProxyClose: () => void;
  onProxyConfigure: (profile: ProfileRecord) => void;
  onProxyDraftCredentialFieldChange: (profileId: string, field: "username" | "password", value: string) => void;
  onProxyDraftCredentialModeChange: (profileId: string, credentialMode: ProxyCredentialDraftMode) => void;
  onProxyDraftFieldChange: (profileId: string, field: Extract<ProxyDraftFieldPath, "protocol" | "host" | "port">, value: string) => void;
  onProxyDraftModeChange: (profileId: string, mode: string) => void;
  onProxyProofCheck: (profile: ProfileRecord) => void;
  onProxySave: (profile: ProfileRecord) => void;
  onRefreshStatus: () => void;
  onRenameCancel: () => void;
  onRenameRequest: () => void;
  onRenameSubmit: (event: FormEvent<HTMLFormElement>, profile: ProfileRecord) => void;
  onReplaceProfileCookies: (profile: ProfileRecord) => void;
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
  const proxyRuntimeProtectionReason = isRuntimeProtected
    ? `Proxy changes are disabled while Chromium is ${runtimeLabel.toLowerCase()}. Stop Chromium before checking or saving; saved proxy edits apply on the next launch.`
    : null;
  const proxyProofRuntimeProtectionReason = isRuntimeProtected
    ? `Saved proxy proof is disabled while Chromium is ${runtimeLabel.toLowerCase()}. Stop Chromium and wait for lifecycle state to settle before proving routing against saved profile truth.`
    : null;
  const cookieRuntimeProtectionReason = isRuntimeProtected
    ? `Cookie portability is stopped-profile only while Chromium is ${runtimeLabel.toLowerCase()}. Stop Chromium and wait for lifecycle state to settle before exporting or replacing cookies.`
    : null;
  const packageRuntimeProtectionReason = isRuntimeProtected
    ? `Profile package export is stopped-profile only while Chromium is ${runtimeLabel.toLowerCase()}. Stop Chromium and wait for lifecycle state to settle before exporting a .tpkg package.`
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

      <ProfileProxySummary isConfigOpen={proxyConfigState.isOpen} profile={profile} onConfigure={() => onProxyConfigure(profile)} />

      {proxyConfigState.isOpen ? (
        <ProxyConfigurationPanel
          diagnosticLookupState={diagnosticLookupState}
          isLifecycleActionBusy={isLifecycleActionBusy}
          isProfileBusy={isProfileBusy}
          profile={profile}
          runtimeProtectionReason={proxyRuntimeProtectionReason}
          state={proxyConfigState}
          onCheckProxy={onProxyCheck}
          onClose={onProxyClose}
          onCredentialFieldChange={onProxyDraftCredentialFieldChange}
          onCredentialModeChange={onProxyDraftCredentialModeChange}
          onDiagnosticLookup={onDiagnosticLookup}
          onDraftFieldChange={onProxyDraftFieldChange}
          onModeChange={onProxyDraftModeChange}
          onSaveProxy={onProxySave}
        />
      ) : null}

      <SavedProxyProofPanel
        diagnosticLookupState={diagnosticLookupState}
        isLifecycleActionBusy={isLifecycleActionBusy}
        isProfileBusy={isProfileBusy}
        profile={profile}
        runtimeGuard={proxyCheckRuntimeGuard}
        runtimeProtectionReason={proxyProofRuntimeProtectionReason}
        state={proxyCheckState}
        onDiagnosticLookup={onDiagnosticLookup}
        onRunProof={onProxyProofCheck}
      />

      <ProfilePackageExportPanel
        cookiePortabilityState={cookiePortabilityState}
        diagnosticLookupState={diagnosticLookupState}
        isLifecycleActionBusy={isLifecycleActionBusy}
        isProfileBusy={isProfileBusy}
        profile={profile}
        runtimeGuard={packagePortabilityRuntimeGuard}
        runtimeProtectionReason={packageRuntimeProtectionReason}
        state={packagePortabilityState}
        onDiagnosticLookup={onDiagnosticLookup}
        onExport={onExportProfilePackage}
      />

      <CookiePortabilityPanel
        diagnosticLookupState={diagnosticLookupState}
        isLifecycleActionBusy={isLifecycleActionBusy}
        isProfileBusy={isProfileBusy}
        profile={profile}
        runtimeGuard={cookiePortabilityRuntimeGuard}
        runtimeProtectionReason={cookieRuntimeProtectionReason}
        state={cookiePortabilityState}
        onDiagnosticLookup={onDiagnosticLookup}
        onExportNetscape={onExportNetscapeCookies}
        onExportThePrivator={onExportThePrivatorCookies}
        onReplace={onReplaceProfileCookies}
      />

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
          <Metric label="Proxy" value={profile.proxy.summary} />
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

function ProfileProxySummary({
  isConfigOpen,
  profile,
  onConfigure,
}: {
  isConfigOpen: boolean;
  profile: ProfileRecord;
  onConfigure: () => void;
}) {
  const panelId = `proxy-panel-${profile.id}`;
  const proxy = profile.proxy;

  return (
    <section className="proxy-summary-panel" aria-label={`${profile.name} saved proxy summary`}>
      <div className="proxy-summary-panel__header">
        <div>
          <p className="signal-label">M003 saved proxy</p>
          <h4>{proxy.summary}</h4>
        </div>
        <button
          type="button"
          className="button--secondary"
          aria-controls={panelId}
          aria-expanded={isConfigOpen}
          aria-label={`Configure proxy for ${profile.name}`}
          onClick={onConfigure}
        >
          Configure proxy
        </button>
      </div>
      <p>Public profile truth only: endpoint summaries are redacted and credential values stay private to the sidecar.</p>
      <dl className="metric-list metric-list--inline">
        <Metric label="Saved summary" value={proxy.summary} />
        <Metric label="Mode" value={formatProxyMode(proxy.mode)} />
        <Metric label="Protocol" value={proxy.mode === "fixedServer" ? formatProxyProtocol(proxy.protocol) : "Not applicable"} />
        <Metric label="Credential state" value={formatProxyCredentialState(proxy.credentialState)} />
      </dl>
    </section>
  );
}

function ProxyConfigurationPanel({
  diagnosticLookupState,
  isLifecycleActionBusy,
  isProfileBusy,
  profile,
  runtimeProtectionReason,
  state,
  onCheckProxy,
  onClose,
  onCredentialFieldChange,
  onCredentialModeChange,
  onDiagnosticLookup,
  onDraftFieldChange,
  onModeChange,
  onSaveProxy,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  isLifecycleActionBusy: boolean;
  isProfileBusy: boolean;
  profile: ProfileRecord;
  runtimeProtectionReason: string | null;
  state: ProxyConfigPanelState;
  onCheckProxy: (profile: ProfileRecord) => void;
  onClose: () => void;
  onCredentialFieldChange: (profileId: string, field: "username" | "password", value: string) => void;
  onCredentialModeChange: (profileId: string, credentialMode: ProxyCredentialDraftMode) => void;
  onDiagnosticLookup: (detailRef: string) => void;
  onDraftFieldChange: (profileId: string, field: Extract<ProxyDraftFieldPath, "protocol" | "host" | "port">, value: string) => void;
  onModeChange: (profileId: string, mode: string) => void;
  onSaveProxy: (profile: ProfileRecord) => void;
}) {
  const draftState = state.draft ?? createProxyDraftState(profile.proxy);
  const isChecking = state.phase === "checking";
  const isSaving = state.phase === "saving";
  const isProxyBusy = isChecking || isSaving;
  const fieldErrorCount = Object.keys(draftState.errors).length;
  const modeFieldsetId = `proxy-mode-${profile.id}`;
  const modeHintId = `proxy-mode-hint-${profile.id}`;
  const modeErrorId = `proxy-mode-error-${profile.id}`;
  const protocolId = `proxy-protocol-${profile.id}`;
  const protocolHintId = `proxy-protocol-hint-${profile.id}`;
  const protocolErrorId = `proxy-protocol-error-${profile.id}`;
  const hostId = `proxy-host-${profile.id}`;
  const hostHintId = `proxy-host-hint-${profile.id}`;
  const hostErrorId = `proxy-host-error-${profile.id}`;
  const portId = `proxy-port-${profile.id}`;
  const portHintId = `proxy-port-hint-${profile.id}`;
  const portErrorId = `proxy-port-error-${profile.id}`;
  const credentialModeId = `proxy-credential-mode-${profile.id}`;
  const credentialHintId = `proxy-credential-hint-${profile.id}`;
  const credentialErrorId = `proxy-credential-error-${profile.id}`;
  const credentialUsernameId = `proxy-credential-username-${profile.id}`;
  const credentialPasswordId = `proxy-credential-password-${profile.id}`;
  const proxyActionHintId = `proxy-action-hint-${profile.id}`;
  const editDisabledReason = runtimeProtectionReason
    ?? (isProfileBusy
      ? "Profile loading or mutation is in progress; wait before editing proxy settings."
      : isLifecycleActionBusy
        ? "A Chromium lifecycle action is in progress; proxy edits fail closed until runtime state settles."
        : isChecking
          ? "Proxy draft check is already running."
          : isSaving
            ? "Proxy save is already running."
            : null);
  const actionDisabledReason = editDisabledReason
    ?? (fieldErrorCount > 0
      ? `Fix ${fieldErrorCount} local proxy field error${fieldErrorCount === 1 ? "" : "s"} before checking or saving.`
      : null);
  const isEditDisabled = editDisabledReason !== null;
  const canRunProxyAction = actionDisabledReason === null;
  const modeDescription = draftState.errors.mode ? `${modeHintId} ${modeErrorId}` : modeHintId;
  const protocolDescription = draftState.errors.protocol ? `${protocolHintId} ${protocolErrorId}` : protocolHintId;
  const hostDescription = draftState.errors.host ? `${hostHintId} ${hostErrorId}` : hostHintId;
  const portDescription = draftState.errors.port ? `${portHintId} ${portErrorId}` : portHintId;
  const credentialDescription = draftState.errors.credentials ? `${credentialHintId} ${credentialErrorId}` : credentialHintId;
  const isFixedServer = draftState.mode === "fixedServer";
  const isDirect = draftState.mode === "direct";

  return (
    <section
      id={`proxy-panel-${profile.id}`}
      className="proxy-config-panel"
      role="region"
      aria-label={`Configure proxy for ${profile.name}`}
      aria-live="polite"
    >
      <div className="proxy-config-panel__header">
        <div>
          <p className="signal-label">Profile proxy configuration</p>
          <h4>{profile.proxy.summary}</h4>
          <p>
            Choose Direct or one fixed HTTP/HTTPS/SOCKS4/SOCKS5 endpoint. Check validates only the draft; Save writes public
            profile truth through the typed sidecar command and keeps credentials redacted.
          </p>
        </div>
        <button type="button" className="button--secondary" onClick={onClose} aria-label="Close proxy configuration">
          Close
        </button>
      </div>

      <dl className="metric-list metric-list--inline proxy-config-observability" aria-label={`${profile.name} proxy observability`}>
        <Metric label="Proxy configuration phase" value={`${state.phase} · ${PROXY_CONFIG_PHASE_LABELS[state.phase]}`} />
        <Metric label="Current proxy action" value={state.currentAction ? PROXY_CONFIG_ACTION_LABELS[state.currentAction] : "No active proxy action"} />
        <Metric label="Draft validation" value={fieldErrorCount ? `${fieldErrorCount} local field error${fieldErrorCount === 1 ? "" : "s"}` : "Local draft parseable"} />
        <Metric label="Saved public summary" value={profile.proxy.summary} />
        <Metric label="Credential state" value={formatProxyCredentialState(profile.proxy.credentialState)} />
        <Metric label="Draft credentials" value={formatProxyCredentialMode(draftState.credentialMode)} />
        <Metric label="Last proxy request" value={state.success?.requestId} />
        <Metric label="Last proxy detailRef" value={state.error?.error.detailRef} />
      </dl>

      {isChecking ? (
        <div className="proxy-status" role="status" aria-live="polite" aria-atomic="true">
          Checking the proxy draft through <code>proxy.validate</code>…
        </div>
      ) : null}
      {isSaving ? (
        <div className="proxy-status" role="status" aria-live="polite" aria-atomic="true">
          Saving the proxy draft through <code>profiles.proxy.update</code>…
        </div>
      ) : null}

      <section className="proxy-draft-editor" aria-label={`${profile.name} proxy draft editor`}>
        <div className="identity-panel-subhead">
          <strong>Proxy draft</strong>
          <span>{fieldErrorCount ? `${fieldErrorCount} field error${fieldErrorCount === 1 ? "" : "s"}` : "Locally parseable draft"}</span>
        </div>

        <fieldset id={modeFieldsetId} className="proxy-mode-group" aria-describedby={modeDescription} aria-invalid={Boolean(draftState.errors.mode)}>
          <legend>Connection mode</legend>
          <label className="proxy-mode-option">
            <input
              type="radio"
              name={`proxy-mode-${profile.id}`}
              value="direct"
              checked={isDirect}
              disabled={isEditDisabled}
              onChange={() => onModeChange(profile.id, "direct")}
            />
            <span>Direct</span>
            <small>Clear endpoint and credential fields; Chromium connects without a proxy.</small>
          </label>
          <label className="proxy-mode-option">
            <input
              type="radio"
              name={`proxy-mode-${profile.id}`}
              value="fixedServer"
              checked={isFixedServer}
              disabled={isEditDisabled}
              onChange={() => onModeChange(profile.id, "fixedServer")}
            />
            <span>Fixed server</span>
            <small>Use one explicit HTTP, HTTPS, SOCKS4, or SOCKS5 endpoint for this profile.</small>
          </label>
          <p id={modeHintId} className="proxy-field-hint">
            Saved masked credentials are never reused implicitly: choose replacement credentials or no credentials before Check or Save.
          </p>
          {draftState.errors.mode ? (
            <p id={modeErrorId} className="proxy-field-error" role="alert">
              {draftState.errors.mode}
            </p>
          ) : null}
        </fieldset>

        {isFixedServer ? (
          <div className="proxy-endpoint-grid">
            <div className="proxy-field">
              <label htmlFor={protocolId}>Protocol</label>
              <select
                id={protocolId}
                value={draftState.protocol}
                disabled={isEditDisabled}
                aria-invalid={Boolean(draftState.errors.protocol)}
                aria-describedby={protocolDescription}
                onChange={(event) => onDraftFieldChange(profile.id, "protocol", event.target.value)}
              >
                {FIXED_PROXY_PROTOCOL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
                {draftState.protocol && !FIXED_PROXY_PROTOCOL_OPTIONS.some((option) => option.value === draftState.protocol) ? (
                  <option value={draftState.protocol}>Unsupported saved protocol</option>
                ) : null}
              </select>
              <p id={protocolHintId} className="proxy-field-hint">
                HTTP/HTTPS and SOCKS4/SOCKS5 are the only fixed-server protocols accepted by the typed contract.
              </p>
              {draftState.errors.protocol ? (
                <p id={protocolErrorId} className="proxy-field-error" role="alert">
                  {draftState.errors.protocol}
                </p>
              ) : null}
            </div>

            <div className="proxy-field">
              <label htmlFor={hostId}>Host</label>
              <input
                id={hostId}
                value={draftState.host}
                disabled={isEditDisabled}
                autoComplete="off"
                placeholder="proxy.example"
                aria-invalid={Boolean(draftState.errors.host)}
                aria-describedby={hostDescription}
                onChange={(event) => onDraftFieldChange(profile.id, "host", event.target.value)}
              />
              <p id={hostHintId} className="proxy-field-hint">
                Enter a host name or IP address only, not a URL, path, userinfo, argv, or launch flag.
              </p>
              {draftState.errors.host ? (
                <p id={hostErrorId} className="proxy-field-error" role="alert">
                  {draftState.errors.host}
                </p>
              ) : null}
            </div>

            <div className="proxy-field">
              <label htmlFor={portId}>Port</label>
              <input
                id={portId}
                value={draftState.port}
                inputMode="numeric"
                disabled={isEditDisabled}
                autoComplete="off"
                aria-invalid={Boolean(draftState.errors.port)}
                aria-describedby={portDescription}
                onChange={(event) => onDraftFieldChange(profile.id, "port", event.target.value)}
              />
              <p id={portHintId} className="proxy-field-hint">Use a whole-number TCP port from 1 to 65535.</p>
              {draftState.errors.port ? (
                <p id={portErrorId} className="proxy-field-error" role="alert">
                  {draftState.errors.port}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="proxy-muted-copy" role="status" aria-live="polite">
            Direct mode clears endpoint and credential fields before Check or Save; saved public summary will be “Direct connection”.
          </p>
        )}

        {isFixedServer ? (
          <fieldset className="proxy-credential-group" aria-describedby={credentialDescription} aria-invalid={Boolean(draftState.errors.credentials)}>
            <legend id={credentialModeId}>Credentials</legend>
            {draftState.savedCredentialState === "configured" ? (
              <label className="proxy-mode-option">
                <input
                  type="radio"
                  name={`proxy-credential-mode-${profile.id}`}
                  value="saved"
                  checked={draftState.credentialMode === "saved"}
                  disabled={isEditDisabled}
                  onChange={() => onCredentialModeChange(profile.id, "saved")}
                />
                <span>Saved masked credentials</span>
                <small>Visible only as credentialState configured; choose replace or clear before Check or Save.</small>
              </label>
            ) : null}
            <label className="proxy-mode-option">
              <input
                type="radio"
                name={`proxy-credential-mode-${profile.id}`}
                value="none"
                checked={draftState.credentialMode === "none"}
                disabled={isEditDisabled}
                onChange={() => onCredentialModeChange(profile.id, "none")}
              />
              <span>No credentials</span>
              <small>Save a fixed proxy endpoint without proxy authentication.</small>
            </label>
            <label className="proxy-mode-option">
              <input
                type="radio"
                name={`proxy-credential-mode-${profile.id}`}
                value="replace"
                checked={draftState.credentialMode === "replace"}
                disabled={isEditDisabled}
                onChange={() => onCredentialModeChange(profile.id, "replace")}
              />
              <span>Replace credentials</span>
              <small>Send a replacement username/password to the sidecar once; saved UI remains masked.</small>
            </label>
            {draftState.savedCredentialState === "configured" ? (
              <label className="proxy-mode-option">
                <input
                  type="radio"
                  name={`proxy-credential-mode-${profile.id}`}
                  value="clear"
                  checked={draftState.credentialMode === "clear"}
                  disabled={isEditDisabled}
                  onChange={() => onCredentialModeChange(profile.id, "clear")}
                />
                <span>Clear saved credentials</span>
                <small>Save the endpoint without proxy authentication and remove the masked credential state.</small>
              </label>
            ) : null}
            <p id={credentialHintId} className="proxy-field-hint">
              Replacement fields are editable only for this draft and are not echoed in success, error, or saved summaries.
            </p>
            {draftState.credentialMode === "replace" ? (
              <div className="proxy-credential-fields">
                <div className="proxy-field">
                  <label htmlFor={credentialUsernameId}>Replacement username</label>
                  <input
                    id={credentialUsernameId}
                    value={draftState.credentialUsername}
                    disabled={isEditDisabled}
                    autoComplete="off"
                    aria-invalid={Boolean(draftState.errors.credentials)}
                    aria-describedby={credentialDescription}
                    onChange={(event) => onCredentialFieldChange(profile.id, "username", event.target.value)}
                  />
                </div>
                <div className="proxy-field">
                  <label htmlFor={credentialPasswordId}>Replacement password</label>
                  <input
                    id={credentialPasswordId}
                    type="password"
                    value={draftState.credentialPassword}
                    disabled={isEditDisabled}
                    autoComplete="new-password"
                    aria-invalid={Boolean(draftState.errors.credentials)}
                    aria-describedby={credentialDescription}
                    onChange={(event) => onCredentialFieldChange(profile.id, "password", event.target.value)}
                  />
                </div>
              </div>
            ) : null}
            {draftState.errors.credentials ? (
              <p id={credentialErrorId} className="proxy-field-error" role="alert">
                {draftState.errors.credentials}
              </p>
            ) : null}
          </fieldset>
        ) : null}

        <div className="proxy-actions">
          <button
            type="button"
            className="button--secondary"
            disabled={!canRunProxyAction}
            aria-describedby={proxyActionHintId}
            onClick={() => onCheckProxy(profile)}
          >
            {isChecking ? "Checking proxy…" : "Check proxy"}
          </button>
          <button type="button" disabled={!canRunProxyAction} aria-describedby={proxyActionHintId} onClick={() => onSaveProxy(profile)}>
            {isSaving ? "Saving proxy…" : "Save proxy"}
          </button>
        </div>
        <p id={proxyActionHintId} className="proxy-muted-copy" role="status" aria-live="polite">
          {actionDisabledReason
            ?? "Check uses proxy.validate without persistence; Save uses profiles.proxy.update and preserves the previous saved summary if the sidecar rejects the draft."}
        </p>
      </section>

      {state.error ? (
        <ProxyConfigErrorFeedback
          diagnosticLookupState={diagnosticLookupState}
          state={state.error}
          onDiagnosticLookup={onDiagnosticLookup}
        />
      ) : null}

      {state.success ? <ProxyConfigSuccessFeedback state={state.success} /> : null}
    </section>
  );
}

function ProxyConfigErrorFeedback({
  diagnosticLookupState,
  state,
  onDiagnosticLookup,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  state: ProxyConfigError;
  onDiagnosticLookup: (detailRef: string) => void;
}) {
  return (
    <section className="proxy-error-feedback" role="alert" aria-live="assertive" aria-atomic="true">
      <strong>{PROXY_CONFIG_ACTION_LABELS[state.action]} failed safely.</strong>
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

function ProxyConfigSuccessFeedback({ state }: { state: ProxyConfigSuccess }) {
  const heading = state.action === "check" ? "Proxy draft validation completed." : "Proxy configuration saved.";
  const copy = state.action === "check"
    ? `Proxy draft validation completed with ${state.warningCount} warning${state.warningCount === 1 ? "" : "s"}. This uses proxy.validate only; run saved proxy proof separately after saving to assess routing/IP-hiding.`
    : "Proxy configuration saved with redacted public profile truth and will apply on the next Chromium launch.";

  return (
    <section className="proxy-success-feedback" role="status" aria-live="polite" aria-atomic="true">
      <strong>{heading}</strong>
      <p>{copy}</p>
      <dl className="metric-list metric-list--inline">
        <Metric label="Action" value={PROXY_CONFIG_ACTION_LABELS[state.action]} />
        <Metric label="Request" value={state.requestId} />
        <Metric label="Summary" value={state.summary} />
        <Metric label="Mode" value={formatProxyMode(state.mode)} />
        <Metric label="Protocol" value={state.protocol ? formatProxyProtocol(state.protocol) : "Not applicable"} />
        <Metric label="Credential state" value={formatProxyCredentialState(state.credentialState)} />
        <Metric label="Warnings" value={state.warningCount} />
        <Metric label="Occurred" value={formatProfileTimestamp(state.occurredAt)} />
      </dl>
    </section>
  );
}

function SavedProxyProofPanel({
  diagnosticLookupState,
  isLifecycleActionBusy,
  isProfileBusy,
  profile,
  runtimeGuard,
  runtimeProtectionReason,
  state,
  onDiagnosticLookup,
  onRunProof,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  isLifecycleActionBusy: boolean;
  isProfileBusy: boolean;
  profile: ProfileRecord;
  runtimeGuard: ProxyCheckRuntimeGuard;
  runtimeProtectionReason: string | null;
  state: ProxyCheckPanelState | null;
  onDiagnosticLookup: (detailRef: string) => void;
  onRunProof: (profile: ProfileRecord) => void;
}) {
  const currentState = state ?? INITIAL_PROXY_CHECK_PANEL_STATE;
  const isRunning = currentState.phase === "running";
  const headingId = `proxy-check-heading-${profile.id}`;
  const actionHintId = `proxy-check-action-hint-${profile.id}`;
  const disabledReason = runtimeProtectionReason
    ?? (!runtimeGuard.isKnown
      ? runtimeGuard.reason ?? "Chromium runtime status is unknown; saved proxy proof fails closed until status refresh succeeds."
      : isProfileBusy
        ? "Profile loading or mutation is in progress; wait before running saved proxy proof."
        : isLifecycleActionBusy
          ? "A Chromium lifecycle action is in progress; saved proxy proof fails closed until runtime state settles."
          : isRunning
            ? "Saved proxy proof is already running for this profile."
            : null);
  const canRunProof = disabledReason === null;

  return (
    <section className="proxy-check-panel" aria-labelledby={headingId}>
      <div className="proxy-check-panel__header">
        <div>
          <p className="signal-label">Saved proxy proof</p>
          <h4 id={headingId}>Deterministic local route proof</h4>
          <p>
            Run <code>profiles.proxy.check</code> against the saved profile proxy. This is separate from draft validation and proves only the deterministic local fixture boundary.
          </p>
        </div>
        <button type="button" aria-describedby={actionHintId} disabled={!canRunProof} onClick={() => onRunProof(profile)}>
          {isRunning ? "Running proof…" : "Run saved proxy proof"}
        </button>
      </div>

      <dl className="metric-list metric-list--inline proxy-check-observability" aria-label={`${profile.name} proxy-check observability`}>
        <Metric label="Proxy check phase" value={`${currentState.phase} · ${PROXY_CHECK_PHASE_LABELS[currentState.phase]}`} />
        <Metric label="Current action" value={currentState.currentAction ? PROXY_CHECK_ACTION_LABELS[currentState.currentAction] : "No active proxy check"} />
        <Metric label="Method" value="profiles.proxy.check" />
        <Metric label="Request" value={currentState.snapshot?.requestId} />
        <Metric label="Bridge duration" value={currentState.snapshot ? formatDuration(currentState.snapshot.bridgeDurationMs) : undefined} />
        <Metric label="detailRef" value={currentState.error?.error.detailRef} />
        <Metric label="Requested" value={currentState.requestedAt ? formatProfileTimestamp(currentState.requestedAt) : undefined} />
      </dl>

      {isRunning ? (
        <div className="proxy-check-status" role="status" aria-live="polite" aria-atomic="true">
          Running saved proxy proof through <code>profiles.proxy.check</code>. Duplicate requests are disabled until this response settles.
        </div>
      ) : currentState.phase === "success" && currentState.snapshot ? (
        <div className="proxy-check-status proxy-check-status--success" role="status" aria-live="polite" aria-atomic="true">
          Saved proxy proof finished for request <code>{currentState.snapshot.requestId}</code>.
        </div>
      ) : null}

      <p id={actionHintId} className="proxy-muted-copy" role="status" aria-live="polite">
        {disabledReason
          ?? "Runs the saved-profile proof only; use Configure proxy for draft validation or saving. Public checker pages remain manual advisory references."}
      </p>

      <section className="proxy-check-section" aria-label={`${profile.name} saved proxy proof input`}>
        <div className="identity-panel-subhead">
          <strong>Saved proxy input</strong>
          <span>{profile.proxy.mode === "fixedServer" ? "Fixed endpoint" : "Direct mode"}</span>
        </div>
        <dl className="metric-list metric-list--inline">
          <Metric label="Saved summary" value={profile.proxy.summary} />
          <Metric label="Mode" value={formatProxyMode(profile.proxy.mode)} />
          <Metric label="Protocol" value={profile.proxy.mode === "fixedServer" ? formatProxyProtocol(profile.proxy.protocol) : "Not applicable"} />
          <Metric label="Credential state" value={formatProxyCredentialState(profile.proxy.credentialState)} />
        </dl>
        <p className="proxy-muted-copy">Credentials, auth headers, launch arguments, runtime paths, WebSocket URLs, and public checker page bodies are not rendered by this panel.</p>
      </section>

      {currentState.snapshot ? <ProxyCheckResultDetails snapshot={currentState.snapshot} /> : null}
      {!currentState.snapshot && !currentState.error && !isRunning ? (
        <p className="proxy-check-empty">No saved proxy proof has run yet. Direct profiles can complete as “not proven”; fixed proxies need a successful local fixture proof before IP-hiding is proven.</p>
      ) : null}

      {currentState.error ? (
        <ProxyCheckErrorFeedback
          diagnosticLookupState={diagnosticLookupState}
          state={currentState.error}
          onDiagnosticLookup={onDiagnosticLookup}
        />
      ) : null}
    </section>
  );
}

function ProfilePackageExportPanel({
  cookiePortabilityState,
  diagnosticLookupState,
  isLifecycleActionBusy,
  isProfileBusy,
  profile,
  runtimeGuard,
  runtimeProtectionReason,
  state,
  onDiagnosticLookup,
  onExport,
}: {
  cookiePortabilityState: CookiePortabilityPanelState | null;
  diagnosticLookupState: DiagnosticLookupState;
  isLifecycleActionBusy: boolean;
  isProfileBusy: boolean;
  profile: ProfileRecord;
  runtimeGuard: PackagePortabilityRuntimeGuard;
  runtimeProtectionReason: string | null;
  state: PackagePortabilityPanelState | null;
  onDiagnosticLookup: (detailRef: string) => void;
  onExport: (profile: ProfileRecord) => void;
}) {
  const currentState = state ?? INITIAL_PACKAGE_PORTABILITY_PANEL_STATE;
  const isRunningOperation = isPackagePortabilityOperationRunning(currentState);
  const isCookieRunning = isCookiePortabilityOperationRunning(cookiePortabilityState);
  const headingId = `package-portability-heading-${profile.id}`;
  const actionHintId = `package-portability-action-hint-${profile.id}`;
  const disabledReason = runtimeProtectionReason
    ?? (!runtimeGuard.isKnown
      ? runtimeGuard.disabledReason ?? "Chromium runtime status is unknown; package export fails closed until status refresh confirms the profile is stopped."
      : isProfileBusy
        ? "Profile loading or mutation is in progress; wait before exporting a package."
        : isLifecycleActionBusy
          ? "A Chromium lifecycle action is in progress; package export fails closed until runtime state settles."
          : isCookieRunning
            ? "A cookie portability operation is already running for this profile."
            : isRunningOperation
              ? "A package portability operation is already running for this profile."
              : null);
  const currentActionLabel = currentState.currentAction ? PACKAGE_PORTABILITY_ACTION_LABELS[currentState.currentAction] : "No active package portability action";

  return (
    <section className="package-portability-panel" aria-labelledby={headingId}>
      <div className="package-portability-panel__header">
        <div>
          <p className="signal-label">Profile package portability</p>
          <h4 id={headingId}>Profile package portability for stopped profiles</h4>
          <p>
            Use the native save dialog to export a portable ThePrivator package. The UI never reads files and never renders
            selected locations, archive internals, cookie material, credentials, browser control metadata, process launch metadata, or unbounded failure details.
          </p>
        </div>
        <span className="mini-phase" aria-label={`Package portability phase: ${currentState.phase}`}>
          {currentState.phase}
        </span>
      </div>

      <dl className="metric-list metric-list--inline package-portability-observability" aria-label={`${profile.name} package portability observability`}>
        <Metric label="Package phase" value={`${currentState.phase} · ${PACKAGE_PORTABILITY_PHASE_LABELS[currentState.phase]}`} />
        <Metric label="Current action" value={currentActionLabel} />
        <Metric label="Last operation" value={currentState.lastSuccess ? PACKAGE_PORTABILITY_ACTION_LABELS[currentState.lastSuccess.action] : null} />
        <Metric label="Warnings" value={currentState.warnings.length} />
        <Metric label="Request" value={currentState.lastSuccess?.snapshot.requestId} />
        <Metric label="Bridge duration" value={currentState.lastSuccess ? formatDuration(currentState.lastSuccess.snapshot.bridgeDurationMs) : undefined} />
        <Metric label="detailRef" value={currentState.error?.error.detailRef} />
      </dl>

      {isRunningOperation ? (
        <div className="package-portability-status" role="status" aria-live="polite" aria-atomic="true">
          {currentState.phase === "choosing-file"
            ? "Waiting for the native save dialog to return one destination before any sidecar mutation starts."
            : "Exporting the package through the fixed sidecar command…"}
        </div>
      ) : null}

      <div className="package-portability-actions">
        <button type="button" className="button--secondary" disabled={disabledReason !== null} aria-describedby={actionHintId} onClick={() => onExport(profile)}>
          {currentState.currentAction === "export" ? "Exporting package…" : "Export ThePrivator package"}
        </button>
      </div>
      <p id={actionHintId} className="package-portability-hint" role="status" aria-live="polite">
        {disabledReason ?? "Available because this profile is stopped and no profile, lifecycle, cookie, or package operation is active. Dialog cancel is a no-op."}
      </p>

      {currentState.lastSuccess ? <ProfilePackageSuccessFeedback state={currentState.lastSuccess} /> : null}
      {currentState.error ? <ProfilePackageErrorFeedback diagnosticLookupState={diagnosticLookupState} state={currentState.error} onDiagnosticLookup={onDiagnosticLookup} /> : null}
    </section>
  );
}

function ProfilePackageSuccessFeedback({ state }: { state: PackagePortabilitySuccess }) {
  const snapshot = state.snapshot;
  const isExport = snapshot.operation === "export";
  const heading = isExport ? "ThePrivator package export completed." : "ThePrivator package import completed.";
  const copy = isExport
    ? "The sidecar wrote the selected destination without returning the location or archive internals to the UI."
    : "The sidecar imported a stopped copied profile and returned only safe aggregate metadata to the UI.";

  return (
    <section className="package-portability-success" role="status" aria-live="polite" aria-atomic="true">
      <strong>{heading}</strong>
      <p>{copy}</p>
      <dl className="metric-list metric-list--inline">
        <Metric label="Operation" value={formatLiteral(snapshot.operation)} />
        <Metric label={isExport ? "Profile ID" : "Imported profile ID"} value={isExport ? snapshot.profileId : snapshot.importedProfileId} />
        <Metric label={isExport ? "Profile name" : "Imported profile name"} value={isExport ? snapshot.profileName : snapshot.importedProfileName} />
        <Metric label="Name conflict" value={isExport ? undefined : snapshot.nameConflictResolved ? "resolved" : "no conflict"} />
        <Metric label="Portable sessions" value={snapshot.portableSessionCount} />
        <Metric label="Payload files" value={snapshot.payloadFileCount} />
        <Metric label="Payload bytes" value={snapshot.payloadBytes} />
        <Metric label="Payload skipped" value={snapshot.payloadSkippedCount} />
        <Metric label="Warnings" value={snapshot.warningCount} />
        <Metric label="Request" value={snapshot.requestId} />
        <Metric label="Bridge duration" value={formatDuration(snapshot.bridgeDurationMs)} />
        <Metric label="Received" value={formatProfileTimestamp(snapshot.receivedAt)} />
        <Metric label="Recorded" value={formatProfileTimestamp(state.occurredAt)} />
      </dl>
      {snapshot.warnings.length ? <ProfilePackageWarningList warnings={snapshot.warnings} /> : null}
    </section>
  );
}

function ProfilePackageWarningList({ warnings }: { warnings: ProfilePackageWarning[] }) {
  return (
    <div className="package-portability-warning-list" role="list" aria-label="Package portability warnings">
      {warnings.map((warning) => (
        <article key={warning.code} className="package-portability-warning" role="listitem">
          <strong>{warning.code}</strong>
          <p>{warning.message}</p>
          <dl className="metric-list metric-list--inline">
            <Metric label="Count" value={warning.count} />
          </dl>
        </article>
      ))}
    </div>
  );
}

function ProfilePackageErrorFeedback({
  diagnosticLookupState,
  state,
  onDiagnosticLookup,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  state: PackagePortabilityError;
  onDiagnosticLookup: (detailRef: string) => void;
}) {
  return (
    <section className="package-portability-error" role="alert" aria-live="assertive" aria-atomic="true">
      <strong>{PACKAGE_PORTABILITY_ACTION_LABELS[state.action]} failed safely.</strong>
      <p>{state.error.message}</p>
      <p className="package-portability-hint">Previous successful metadata remains visible, and no selected location, archive internals, cookie material, credential, browser control metadata, process launch metadata, or unbounded failure details are rendered.</p>
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

function ProfilePackageRefreshErrorFeedback({
  diagnosticLookupState,
  state,
  onDiagnosticLookup,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  state: NonNullable<PackageImportRefreshState>;
  onDiagnosticLookup: (detailRef: string) => void;
}) {
  return (
    <section className="package-portability-error" role="alert" aria-live="assertive" aria-atomic="true">
      <strong>Package imported, but profile refresh failed safely.</strong>
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

function CookiePortabilityPanel({
  diagnosticLookupState,
  isLifecycleActionBusy,
  isProfileBusy,
  profile,
  runtimeGuard,
  runtimeProtectionReason,
  state,
  onDiagnosticLookup,
  onExportNetscape,
  onExportThePrivator,
  onReplace,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  isLifecycleActionBusy: boolean;
  isProfileBusy: boolean;
  profile: ProfileRecord;
  runtimeGuard: CookiePortabilityRuntimeGuard;
  runtimeProtectionReason: string | null;
  state: CookiePortabilityPanelState | null;
  onDiagnosticLookup: (detailRef: string) => void;
  onExportNetscape: (profile: ProfileRecord) => void;
  onExportThePrivator: (profile: ProfileRecord) => void;
  onReplace: (profile: ProfileRecord) => void;
}) {
  const currentState = state ?? INITIAL_COOKIE_PORTABILITY_PANEL_STATE;
  const isChoosing = currentState.phase === "choosing-file";
  const isExporting = currentState.phase === "exporting";
  const isReplacing = currentState.phase === "replacing";
  const isRunningOperation = isChoosing || isExporting || isReplacing;
  const headingId = `cookie-portability-heading-${profile.id}`;
  const actionHintId = `cookie-portability-action-hint-${profile.id}`;
  const disabledReason = runtimeProtectionReason
    ?? (!runtimeGuard.isKnown
      ? runtimeGuard.disabledReason ?? "Chromium runtime status is unknown; cookie portability fails closed until status refresh confirms the profile is stopped."
      : isProfileBusy
        ? "Profile loading or mutation is in progress; wait before moving cookies."
        : isLifecycleActionBusy
          ? "A Chromium lifecycle action is in progress; cookie portability fails closed until runtime state settles."
          : isRunningOperation
            ? "A cookie portability operation is already running for this profile."
            : null);
  const canRunAction = disabledReason === null;
  const currentActionLabel = currentState.currentAction ? COOKIE_PORTABILITY_ACTION_LABELS[currentState.currentAction] : "No active cookie portability action";

  return (
    <section className="cookie-portability-panel" aria-labelledby={headingId}>
      <div className="cookie-portability-panel__header">
        <div>
          <p className="signal-label">Cookie portability</p>
          <h4 id={headingId}>Cookie portability for stopped profiles</h4>
          <p>
            Use native dialogs to choose a destination or source file. The UI never reads files and never renders selected locations,
            cookie domains, names, or values.
          </p>
        </div>
        <span className="mini-phase" aria-label={`Cookie portability phase: ${currentState.phase}`}>
          {currentState.phase}
        </span>
      </div>

      <dl className="metric-list metric-list--inline cookie-portability-observability" aria-label={`${profile.name} cookie portability observability`}>
        <Metric label="Cookie portability phase" value={`${currentState.phase} · ${COOKIE_PORTABILITY_PHASE_LABELS[currentState.phase]}`} />
        <Metric label="Current action" value={currentActionLabel} />
        <Metric label="Last operation" value={currentState.lastSuccess ? COOKIE_PORTABILITY_ACTION_LABELS[currentState.lastSuccess.action] : null} />
        <Metric label="Last format" value={currentState.lastSuccess ? COOKIE_EXPORT_FORMAT_LABELS[currentState.lastSuccess.snapshot.format] : null} />
        <Metric label="Warnings" value={currentState.warnings.length} />
        <Metric label="Request" value={currentState.lastSuccess?.snapshot.requestId} />
        <Metric label="Bridge duration" value={currentState.lastSuccess ? formatDuration(currentState.lastSuccess.snapshot.bridgeDurationMs) : undefined} />
        <Metric label="detailRef" value={currentState.error?.error.detailRef} />
      </dl>

      {isRunningOperation ? (
        <div className="cookie-portability-status" role="status" aria-live="polite" aria-atomic="true">
          {isChoosing
            ? "Waiting for the native dialog to return a single selected file path before any sidecar mutation starts."
            : isExporting
              ? "Exporting cookies through the fixed sidecar cookie export command…"
              : "Replacing cookies through the fixed sidecar cookie replace command…"}
        </div>
      ) : null}

      <div className="cookie-portability-actions">
        <button type="button" className="button--secondary" disabled={!canRunAction} aria-describedby={actionHintId} onClick={() => onExportNetscape(profile)}>
          {currentState.currentAction === "export-netscape" ? "Exporting Netscape…" : "Export Netscape"}
        </button>
        <button type="button" className="button--secondary" disabled={!canRunAction} aria-describedby={actionHintId} onClick={() => onExportThePrivator(profile)}>
          {currentState.currentAction === "export-theprivator-json" ? "Exporting JSON…" : "Export ThePrivator JSON"}
        </button>
        <button type="button" disabled={!canRunAction} aria-describedby={actionHintId} onClick={() => onReplace(profile)}>
          {currentState.currentAction === "replace" ? "Replacing cookies…" : "Replace cookies"}
        </button>
      </div>
      <p id={actionHintId} className="cookie-portability-hint" role="status" aria-live="polite">
        {disabledReason
          ?? "Available because this profile is stopped and no profile or lifecycle mutation is active. Dialog cancel is a no-op."}
      </p>

      {currentState.lastSuccess ? <CookiePortabilitySuccessFeedback state={currentState.lastSuccess} /> : null}

      {currentState.error ? (
        <CookiePortabilityErrorFeedback
          diagnosticLookupState={diagnosticLookupState}
          state={currentState.error}
          onDiagnosticLookup={onDiagnosticLookup}
        />
      ) : null}
    </section>
  );
}

function CookiePortabilitySuccessFeedback({ state }: { state: CookiePortabilitySuccess }) {
  const snapshot = state.snapshot;
  const isExport = snapshot.operation === "export";
  const heading = isExport ? `${COOKIE_EXPORT_FORMAT_LABELS[snapshot.format]} export completed.` : `${COOKIE_EXPORT_FORMAT_LABELS[snapshot.format]} import replaced existing cookies.`;
  const copy = isExport
    ? "The sidecar wrote the selected destination without returning the path or cookie contents to the UI."
    : "The sidecar replaced profile cookies from the selected source without returning the path or cookie contents to the UI.";

  return (
    <section className="cookie-portability-success" role="status" aria-live="polite" aria-atomic="true">
      <strong>{heading}</strong>
      <p>{copy}</p>
      <dl className="metric-list metric-list--inline">
        <Metric label="Operation" value={formatLiteral(snapshot.operation)} />
        <Metric label="Format" value={COOKIE_EXPORT_FORMAT_LABELS[snapshot.format]} />
        <Metric label="Exported" value={isExport ? snapshot.exportedCount : undefined} />
        <Metric label="Imported" value={!isExport ? snapshot.importedCount : undefined} />
        <Metric label="Replaced" value={!isExport ? snapshot.replacedCount : undefined} />
        <Metric label="Skipped" value={snapshot.skippedCount} />
        <Metric label="Warnings" value={snapshot.warningCount} />
        <Metric label="Request" value={snapshot.requestId} />
        <Metric label="Bridge duration" value={formatDuration(snapshot.bridgeDurationMs)} />
        <Metric label="Received" value={formatProfileTimestamp(snapshot.receivedAt)} />
        <Metric label="Recorded" value={formatProfileTimestamp(state.occurredAt)} />
      </dl>
      {snapshot.warnings.length ? <CookiePortabilityWarningList warnings={snapshot.warnings} /> : null}
    </section>
  );
}

function CookiePortabilityWarningList({ warnings }: { warnings: CookiePortabilityWarning[] }) {
  return (
    <div className="cookie-portability-warning-list" role="list" aria-label="Cookie portability warnings">
      {warnings.map((warning) => (
        <article key={warning.code} className="cookie-portability-warning" role="listitem">
          <strong>{warning.code}</strong>
          <p>{warning.message}</p>
          <dl className="metric-list metric-list--inline">
            <Metric label="Count" value={warning.count} />
          </dl>
        </article>
      ))}
    </div>
  );
}

function CookiePortabilityErrorFeedback({
  diagnosticLookupState,
  state,
  onDiagnosticLookup,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  state: CookiePortabilityError;
  onDiagnosticLookup: (detailRef: string) => void;
}) {
  return (
    <section className="cookie-portability-error" role="alert" aria-live="assertive" aria-atomic="true">
      <strong>{COOKIE_PORTABILITY_ACTION_LABELS[state.action]} failed safely.</strong>
      <p>{state.error.message}</p>
      <p className="cookie-portability-hint">Previous successful metadata remains visible, and no selected location or cookie content is rendered.</p>
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

function ProxyCheckResultDetails({ snapshot }: { snapshot: ProxyCheckSnapshot }) {
  const routeProof = snapshot.routeProof;
  const ipHiding = snapshot.ipHiding;
  const webRtc = snapshot.webRtc;
  const publicCheckers = snapshot.publicCheckers;
  const provedLocalFixture = routeProof.status === "proved" && ipHiding.status === "proved";

  return (
    <div className="proxy-check-results" aria-label="Saved proxy proof results">
      <section className={`proxy-check-success proxy-check-success--${provedLocalFixture ? "proved" : "not-proven"}`} role="status" aria-live="polite" aria-atomic="true">
        <strong>{provedLocalFixture ? "Local fixture proved saved proxy routing." : "Saved proxy proof completed without proving IP hiding."}</strong>
        <p>{formatProxyCheckConclusion(snapshot)}</p>
        <dl className="metric-list metric-list--inline">
          <Metric label="Profile" value={snapshot.profileId} />
          <Metric label="Route proof" value={formatProxyCheckStatus(routeProof.status)} />
          <Metric label="IP hiding" value={formatProxyCheckStatus(ipHiding.status)} />
          <Metric label="Received" value={formatProfileTimestamp(snapshot.receivedAt)} />
        </dl>
      </section>

      <section className="proxy-check-section" aria-label="Deterministic local route proof">
        <div className="identity-panel-subhead">
          <strong>Deterministic local route proof</strong>
          <span>{formatProxyCheckStatus(routeProof.status)}</span>
        </div>
        <p>{formatProxyCheckRouteCopy(snapshot)}</p>
        <dl className="metric-list metric-list--inline">
          <Metric label="Status" value={formatProxyCheckStatus(routeProof.status)} />
          <Metric label="Basis" value={formatLiteral(routeProof.basis)} />
          <Metric label="Scope" value={formatLiteral(routeProof.scope)} />
          <Metric label="Protocol" value={routeProof.protocol ? formatProxyProtocol(routeProof.protocol) : "Not applicable"} />
          <Metric label="Credential state" value={formatProxyCredentialState(routeProof.credentialState)} />
          <Metric label="Duration" value={formatDuration(routeProof.durationMs)} />
          <Metric label="Fixture" value={formatProxyCheckFixture(routeProof)} />
          <Metric label="Target" value={formatProxyCheckTarget(routeProof)} />
          <Metric label="Observations" value={formatProxyCheckObservations(routeProof)} />
          <Metric label="Fallback route" value={routeProof.directFallbackDetected ? "Detected" : "Not detected"} />
        </dl>
      </section>

      <section className="proxy-check-section" aria-label="IP-hiding conclusion">
        <div className="identity-panel-subhead">
          <strong>IP-hiding conclusion</strong>
          <span>{formatProxyCheckStatus(ipHiding.status)}</span>
        </div>
        <p>{formatProxyCheckIpCopy(snapshot)}</p>
        <dl className="metric-list metric-list--inline">
          <Metric label="Status" value={formatProxyCheckStatus(ipHiding.status)} />
          <Metric label="Basis" value={formatLiteral(ipHiding.basis)} />
          <Metric label="Scope" value={formatLiteral(ipHiding.scope)} />
          <Metric label="Local conclusion" value={formatLiteral(ipHiding.localFixtureConclusion)} />
          <Metric label="Public exit IP claim" value={ipHiding.publicExitIpClaimed ? "Claimed" : "Not claimed"} />
          <Metric label="Public exit IP" value={ipHiding.publicExitIp ?? "Not collected"} />
        </dl>
      </section>

      <section className="proxy-check-section" aria-label="WebRTC local-IP baseline">
        <div className="identity-panel-subhead">
          <strong>WebRTC / local-IP baseline</strong>
          <span>{formatProxyCheckStatus(webRtc.status)}</span>
        </div>
        <p>{formatProxyCheckWebRtcCopy(snapshot)}</p>
        <dl className="metric-list metric-list--inline">
          <Metric label="Status" value={formatProxyCheckStatus(webRtc.status)} />
          <Metric label="Basis" value={formatLiteral(webRtc.basis)} />
          <Metric label="Identity mode" value={formatIdentityMode(webRtc.mode)} />
          <Metric label="Policy" value={formatLiteral(webRtc.policy)} />
          <Metric label="Local IP exposure" value={formatLiteral(webRtc.localIpExposure)} />
        </dl>
      </section>

      <section className="proxy-check-section" aria-label="Public checker advisory pages">
        <div className="identity-panel-subhead">
          <strong>Public checker advisory pages</strong>
          <span>{formatProxyCheckStatus(publicCheckers.status)}</span>
        </div>
        <p>
          These pages are manual advisory references only. Checker labels, scoring, availability, and network instability are external signals; ThePrivator does not promise a hidden public IP or a checker pass.
        </p>
        <dl className="metric-list metric-list--inline">
          <Metric label="Status" value={formatProxyCheckStatus(publicCheckers.status)} />
          <Metric label="Basis" value={formatLiteral(publicCheckers.basis)} />
          <Metric label="Network dependency" value={formatLiteral(publicCheckers.networkDependency)} />
          <Metric label="Page count" value={publicCheckers.pages.length} />
        </dl>
        <div className="proxy-check-page-list" role="list" aria-label="Advisory public checker pages">
          {publicCheckers.pages.map((page) => (
            <article key={page.id} className="proxy-check-page-card" role="listitem">
              <div className="identity-audit-page-card__header">
                <strong>{page.label}</strong>
                <span className="identity-audit-page-card__surface-count">{formatSurfaces(page.surfaces)}</span>
              </div>
              <p className="identity-audit-url">{page.url}</p>
              <p>{page.advisory}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ProxyCheckErrorFeedback({
  diagnosticLookupState,
  state,
  onDiagnosticLookup,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  state: ProxyCheckError;
  onDiagnosticLookup: (detailRef: string) => void;
}) {
  return (
    <section className="proxy-check-error" role="alert" aria-live="assertive" aria-atomic="true">
      <strong>{PROXY_CHECK_ACTION_LABELS[state.action]} failed safely.</strong>
      <p>{state.error.message}</p>
      <p className="proxy-muted-copy">The saved profile/proxy record was not changed. Malformed or partial proof responses are discarded before any result sections render.</p>
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

function AutomationApiPanel({
  diagnosticLookupState,
  state,
  onCopyToken,
  onDiagnosticLookup,
  onRefreshStatus,
  onStart,
  onStop,
}: {
  diagnosticLookupState: DiagnosticLookupState;
  state: AutomationApiViewState;
  onCopyToken: () => void;
  onDiagnosticLookup: (detailRef: string) => void;
  onRefreshStatus: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const status = state.status;
  const isBusy = state.currentAction !== null;
  const isRunning = status?.running ?? false;
  const tone = state.phase === "ready" && isRunning
    ? "ready"
    : state.phase === "idle" || state.phase === "starting" || state.phase === "refreshing" || state.phase === "copying" || state.phase === "stopping"
      ? "pending"
      : state.error
        ? "error"
        : "ready";
  const commandError = state.error;
  const statusError = status?.lastError ?? null;
  const copyFeedback = state.copyFeedback;
  const safeUrl = status?.api?.url ?? null;

  return (
    <section className={`sidecar-card automation-api-card sidecar-card--${tone}`} aria-label="Automation API lifecycle controls" aria-live="polite">
      <div className="sidecar-card__header">
        <div>
          <p className="kicker">Automation API</p>
          <h2>{AUTOMATION_API_PHASE_LABELS[state.phase]}</h2>
        </div>
        <span className="mini-phase" aria-label={`Automation API UI phase: ${state.phase}`}>{state.phase}</span>
      </div>

      <dl className="metric-list automation-api-metrics" aria-label="Automation API safe status">
        <Metric label="Lifecycle phase" value={status ? `${status.status} · ${status.running ? "running" : "stopped"}` : "Not checked"} />
        <Metric label="Loopback URL" value={safeUrl ?? "Unavailable until running"} />
        <Metric label="Port" value={status?.api?.port} />
        <Metric label="Scope" value={status?.api?.scope ?? "Loopback only"} />
        <Metric label="Health route" value={safeUrl ? `GET ${safeUrl}/health` : "GET /health after start"} />
        <Metric label="Protected route" value={safeUrl ? `GET ${safeUrl}/v1/status` : "GET /v1/status after start"} />
        <Metric label="Copy available" value={status?.copyAvailable ? "yes" : "no"} />
        <Metric label="Started" value={formatProfileTimestamp(status?.process?.startedAt)} />
        <Metric label="Last transition" value={formatProfileTimestamp(status?.lastTransitionAt)} />
        <Metric label="Last received" value={formatProfileTimestamp(status?.receivedAt)} />
        <Metric label="Readiness duration" value={formatAutomationDuration(status?.timings.readinessDurationMs)} />
        <Metric label="Stop duration" value={formatAutomationDuration(status?.timings.stopDurationMs)} />
        <Metric label="Last command" value={state.lastSuccess ? `${AUTOMATION_API_ACTION_LABELS[state.lastSuccess.action]} → ${state.lastSuccess.status}` : "No successful command"} />
        <Metric label="Last command at" value={formatProfileTimestamp(state.lastSuccess?.occurredAt)} />
        <Metric label="Last error code" value={commandError?.error.code ?? statusError?.code} />
        <Metric label="Last error phase" value={commandError ? AUTOMATION_API_ACTION_LABELS[commandError.action] : statusError?.phase} />
        <Metric label="Last detailRef" value={commandError?.error.detailRef ?? statusError?.detailRef} />
      </dl>

      <div className="automation-api-actions" aria-label="Automation API actions">
        <button type="button" onClick={onStart} disabled={isBusy || isRunning}>
          {state.currentAction === "start" ? "Starting API…" : "Start API"}
        </button>
        <button type="button" className="button--secondary" onClick={onRefreshStatus} disabled={isBusy}>
          {state.currentAction === "status" ? "Refreshing API status…" : "Refresh API status"}
        </button>
        <button type="button" className="button--secondary" onClick={onCopyToken} disabled={isBusy || !status?.copyAvailable}>
          {state.currentAction === "copy-token" ? "Copying token…" : "Copy token"}
        </button>
        <button type="button" className="button--ghost-danger" onClick={onStop} disabled={isBusy || !isRunning}>
          {state.currentAction === "stop" ? "Stopping API…" : "Stop API"}
        </button>
      </div>

      <p className="automation-api-note">
        Token material is never displayed. Copy requests write directly to the system clipboard from this button handler and then discard the value.
      </p>

      {copyFeedback ? (
        <div className={`automation-api-feedback automation-api-feedback--${copyFeedback.kind}`} role="status" aria-live="polite">
          <strong>{copyFeedback.kind === "success" ? "Copy completed safely." : "Copy failed safely."}</strong>
          <p>{copyFeedback.message}</p>
          <dl className="metric-list metric-list--inline">
            <Metric label="Occurred" value={formatProfileTimestamp(copyFeedback.occurredAt)} />
            <Metric label="Code" value={copyFeedback.error?.code} />
            <Metric label="detailRef" value={copyFeedback.error?.detailRef} />
          </dl>
          {copyFeedback.error ? <DiagnosticReference detailRef={copyFeedback.error.detailRef} state={diagnosticLookupState} onLookup={onDiagnosticLookup} /> : null}
        </div>
      ) : null}

      {commandError ? (
        <div className="automation-api-feedback automation-api-feedback--error" role="status" aria-live="polite">
          <strong>{AUTOMATION_API_ACTION_LABELS[commandError.action]} failed safely.</strong>
          <p>{commandError.error.message}</p>
          <dl className="metric-list metric-list--inline">
            <Metric label="Code" value={commandError.error.code} />
            <Metric label="Source" value={commandError.error.source} />
            <Metric label="Occurred" value={formatProfileTimestamp(commandError.occurredAt)} />
            <Metric label="detailRef" value={commandError.error.detailRef} />
          </dl>
          <DiagnosticReference detailRef={commandError.error.detailRef} state={diagnosticLookupState} onLookup={onDiagnosticLookup} />
        </div>
      ) : null}

      {statusError ? (
        <div className="automation-api-feedback automation-api-feedback--error" role="status" aria-live="polite">
          <strong>Last lifecycle error snapshot.</strong>
          <p>{statusError.message}</p>
          <dl className="metric-list metric-list--inline">
            <Metric label="Code" value={statusError.code} />
            <Metric label="Phase" value={statusError.phase} />
            <Metric label="At" value={formatProfileTimestamp(statusError.at)} />
            <Metric label="Duration" value={formatAutomationDuration(statusError.durationMs)} />
            <Metric label="detailRef" value={statusError.detailRef} />
          </dl>
          <DiagnosticReference detailRef={statusError.detailRef} state={diagnosticLookupState} onLookup={onDiagnosticLookup} />
        </div>
      ) : null}
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

function getPackageProfileSummary(state: PackagePortabilitySuccess | null): string | null {
  if (!state) {
    return null;
  }

  const snapshot = state.snapshot;
  if (snapshot.operation === "export") {
    return `${snapshot.profileName} (${snapshot.profileId})`;
  }

  return `${snapshot.importedProfileName} (${snapshot.importedProfileId})`;
}

function formatAutomationDuration(value: number | undefined): string {
  return typeof value === "number" ? `${value.toFixed(2)} ms` : "Unavailable";
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

function createProxyConfigSuccess(
  profileId: string,
  action: ProxyConfigAction,
  proxy: ProfileProxySummary,
  requestId: string,
  warningCount: number,
): ProxyConfigSuccess {
  return {
    profileId,
    action,
    requestId,
    summary: proxy.summary,
    mode: proxy.mode,
    protocol: proxy.mode === "fixedServer" ? proxy.protocol : null,
    credentialState: proxy.credentialState,
    warningCount,
    occurredAt: new Date().toISOString(),
  };
}

function formatProxyMode(value: ProfileProxySummary["mode"] | string): string {
  if (value === "direct") {
    return "Direct";
  }
  if (value === "fixedServer") {
    return "Fixed server";
  }

  return value;
}

function formatProxyProtocol(value: ProxyProtocol | string): string {
  if (value === "http") {
    return "HTTP";
  }
  if (value === "https") {
    return "HTTPS";
  }
  if (value === "socks4") {
    return "SOCKS4";
  }
  if (value === "socks5") {
    return "SOCKS5";
  }

  return value;
}

function formatProxyCredentialState(value: ProfileProxySummary["credentialState"]): string {
  return value === "configured" ? "configured (masked)" : "none";
}

function formatProxyCheckConclusion(snapshot: ProxyCheckSnapshot): string {
  if (snapshot.routeProof.status === "proved" && snapshot.ipHiding.status === "proved") {
    return "The local fixture observed proxy routing and concluded the proof target did not see the direct target IP. This does not collect or assert a public exit IP.";
  }

  if (snapshot.proxy.mode === "direct") {
    return "Direct mode is valid profile truth, but no proxy route was run and IP hiding is not proven.";
  }

  return "The proof completed without a local-fixture IP-hiding conclusion; treat the saved proxy as not proven until a successful fixed-proxy proof runs.";
}

function formatProxyCheckRouteCopy(snapshot: ProxyCheckSnapshot): string {
  if (snapshot.routeProof.status === "proved") {
    return "The sidecar-managed local fixture saw the proxy path without bypass evidence. The proof scope is local-fixture only.";
  }

  return "No route proof is run for Direct mode, so this is a successful app state rather than a proxy/IP-hiding proof.";
}

function formatProxyCheckIpCopy(snapshot: ProxyCheckSnapshot): string {
  if (snapshot.ipHiding.status === "proved") {
    return "The local fixture conclusion proves target-IP hiding only for the deterministic fixture; no public exit IP is claimed or stored.";
  }

  return "IP hiding is not proven for this saved profile. Public checker pages may be used manually as advisory context, not as app-side proof.";
}

function formatProxyCheckWebRtcCopy(snapshot: ProxyCheckSnapshot): string {
  if (snapshot.webRtc.status === "restricted") {
    return "The saved identity policy restricts WebRTC local-IP exposure before any public checker comparison.";
  }

  return "Baseline-real WebRTC behavior may expose local IP candidates; this is an expected baseline unless the saved identity policy blocks or disables non-proxied UDP.";
}

function formatProxyCheckStatus(value: string): string {
  if (value === "not-run") {
    return "Not run";
  }
  if (value === "not-proven") {
    return "Not proven";
  }
  if (value === "advisory-only") {
    return "Advisory only";
  }
  if (value === "baseline-real") {
    return "Baseline real";
  }

  return formatLiteral(value);
}

function formatProxyCheckFixture(routeProof: ProxyCheckSnapshot["routeProof"]): string {
  if (!routeProof.fixture) {
    return "Not applicable";
  }

  return `${formatProxyProtocol(routeProof.fixture.kind)} managed fixture`;
}

function formatProxyCheckTarget(routeProof: ProxyCheckSnapshot["routeProof"]): string {
  if (!routeProof.target) {
    return "Not applicable";
  }

  return `${routeProof.target.host}:${routeProof.target.port}`;
}

function formatProxyCheckObservations(routeProof: ProxyCheckSnapshot["routeProof"]): string {
  return `proxy ${routeProof.observationCounts.proxy} · target ${routeProof.observationCounts.target}`;
}

function formatSurfaces(surfaces: string[]): string {
  return surfaces.map(formatLiteral).join(" · ");
}

function formatLiteral(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

function isCookiePortabilityOperationRunning(state: CookiePortabilityPanelState | null | undefined): boolean {
  return state?.phase === "choosing-file" || state?.phase === "exporting" || state?.phase === "replacing";
}

function isPackagePortabilityOperationRunning(state: PackagePortabilityPanelState | null | undefined): boolean {
  return state?.phase === "choosing-file" || state?.phase === "exporting" || state?.phase === "importing" || state?.phase === "refreshing-profiles";
}

class DialogSelectionError extends Error {
  readonly code: string;
  readonly source: SidecarErrorSource;
  readonly phase: Extract<SidecarUiPhase, "recoverable-error" | "bridge-error">;

  constructor(code: string, message: string, source: SidecarErrorSource = "ui", phase: Extract<SidecarUiPhase, "recoverable-error" | "bridge-error"> = "recoverable-error") {
    super(message);
    this.name = "DialogSelectionError";
    this.code = code;
    this.source = source;
    this.phase = phase;
  }

  toClientError(): SidecarClientError {
    return {
      code: this.code,
      message: this.message,
      recoverable: true,
      detailRef: `ui-portability-${this.code.toLowerCase().replace(/_/g, "-")}`,
      source: this.source,
      phase: this.phase,
    };
  }
}

function parseDialogPathSelection(value: unknown, dialogKind: "open" | "save"): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    throw new DialogSelectionError(
      "PORTABILITY_DIALOG_SELECTION_INVALID",
      `Native ${dialogKind} dialog returned multiple file selections; no portability command was started.`,
    );
  }

  throw new DialogSelectionError(
    "PORTABILITY_DIALOG_SELECTION_INVALID",
    `Native ${dialogKind} dialog returned an invalid file selection; no portability command was started.`,
  );
}

function makeCookiePortabilityUiError(code: string, message: string): SidecarClientError {
  return {
    code,
    message,
    recoverable: true,
    detailRef: `ui-portability-${code.toLowerCase().replace(/_/g, "-")}`,
    source: "ui",
    phase: "recoverable-error",
  };
}

function makeCookiePortabilityDialogError(): SidecarClientError {
  return {
    code: "PORTABILITY_DIALOG_FAILED",
    message: "Native file dialog failed before any cookie command started.",
    recoverable: true,
    detailRef: "ui-portability-dialog-failed",
    source: "bridge",
    phase: "bridge-error",
  };
}

function makePackagePortabilityUiError(code: string, message: string): SidecarClientError {
  return {
    code,
    message,
    recoverable: true,
    detailRef: `ui-package-portability-${code.toLowerCase().replace(/_/g, "-")}`,
    source: "ui",
    phase: "recoverable-error",
  };
}

function makePackagePortabilityDialogError(): SidecarClientError {
  return {
    code: "PACKAGE_PORTABILITY_DIALOG_FAILED",
    message: "Native file dialog failed before any package command started.",
    recoverable: true,
    detailRef: "ui-package-portability-dialog-failed",
    source: "bridge",
    phase: "bridge-error",
  };
}

function formatLegacyUserDataStatus(value: LegacyScanCandidate["userData"]["status"]): string {
  return value === "available" ? "User-data available" : "No user-data found";
}

function makeAutomationApiUiError(code: string, message: string): SidecarClientError {
  return {
    code,
    message,
    recoverable: true,
    detailRef: `ui-automation-api-${code.toLowerCase().replace(/_/g, "-")}`,
    source: "ui",
    phase: "recoverable-error",
  };
}

function isSafeUiError(value: unknown): value is SidecarClientError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    "recoverable" in value &&
    "detailRef" in value &&
    "source" in value &&
    "phase" in value
  );
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
