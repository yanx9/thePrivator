export type GlobalStatusTone = "ready" | "pending" | "attention" | "error";

export type GlobalStatusItemKey = "sidecar" | "chromium" | "automation" | "profiles" | "attention";

export type GlobalAttentionSource = "sidecar" | "chromium" | "automation" | "profiles" | "diagnostics" | "workspace";

export interface GlobalStatusItem {
  key: GlobalStatusItemKey;
  label: string;
  value: string;
  tone: GlobalStatusTone;
  supportActionHint?: string;
}

export interface GlobalStatusSummary {
  overallTone: GlobalStatusTone;
  statusLine: string;
  items: GlobalStatusItem[];
  hasSupportAction: boolean;
}

export interface GlobalAttentionCandidate {
  source: GlobalAttentionSource;
  phase?: string | null;
  code?: string | null;
  detailRef?: string | null;
  occurredAt?: string | null;
}

export interface BuildGlobalStatusInput {
  health?: {
    phase?: string | null;
    status?: string | null;
  } | null;
  chromium?: {
    phase?: string | null;
    runningCount?: number | null;
  } | null;
  automationApi?: {
    phase?: string | null;
    status?: string | null;
    running?: boolean | null;
  } | null;
  profiles?: {
    phase?: string | null;
    count?: number | null;
  } | null;
  attentionCandidates?: GlobalAttentionCandidate[] | null;
}

const SOURCE_LABELS: Record<GlobalAttentionSource, string> = {
  sidecar: "App connection",
  chromium: "Browser runtime",
  automation: "Automation API",
  profiles: "Profiles",
  diagnostics: "Support lookup",
  workspace: "Workspace",
};

const GLOBAL_STATUS_READY_LINE = "Workspace ready";
const GLOBAL_STATUS_PENDING_LINE = "Workspace is preparing";
const GLOBAL_STATUS_ATTENTION_LINE = "Workspace has one item to review";
const GLOBAL_STATUS_ERROR_LINE = "Workspace needs support";

export function buildGlobalStatusSummary(input: BuildGlobalStatusInput = {}): GlobalStatusSummary {
  const profileCount = normalizeCount(input.profiles?.count);
  const sidecar = buildSidecarItem(input.health);
  const chromium = buildChromiumItem(input.chromium);
  const automation = buildAutomationItem(input.automationApi);
  const profiles = buildProfilesItem(input.profiles, profileCount);
  const attention = buildAttentionItem({
    candidates: input.attentionCandidates,
    existingItems: [sidecar, chromium, automation, profiles],
    profileCount,
  });
  const items = [sidecar, chromium, automation, profiles, attention];
  const overallTone = chooseOverallTone(items);

  return {
    overallTone,
    statusLine: formatStatusLine(overallTone),
    items,
    hasSupportAction: items.some((item) => Boolean(item.supportActionHint)),
  };
}

function buildSidecarItem(snapshot: BuildGlobalStatusInput["health"]): GlobalStatusItem {
  const phase = normalizePhase(snapshot?.phase);
  const status = normalizePhase(snapshot?.status);

  if (!phase) {
    return statusItem("sidecar", "App connection", "Checking", "pending");
  }

  if (phase === "healthy") {
    if (status && status !== "healthy") {
      return statusItem("sidecar", "App connection", "Degraded", "attention", supportHint("sidecar"));
    }
    return statusItem("sidecar", "App connection", "Ready", "ready");
  }

  if (phase === "loading") {
    return statusItem("sidecar", "App connection", "Checking", "pending");
  }

  return statusItem(
    "sidecar",
    "App connection",
    phase === "bridge-error" ? "Unavailable" : "Needs support",
    phase === "bridge-error" ? "error" : "attention",
    supportHint("sidecar"),
  );
}

function buildChromiumItem(snapshot: BuildGlobalStatusInput["chromium"]): GlobalStatusItem {
  const phase = normalizePhase(snapshot?.phase);
  const runningCount = normalizeCount(snapshot?.runningCount);
  const runningLabel = `${runningCount} running`;

  if (!phase) {
    return statusItem("chromium", "Browsers", `Status pending · ${runningLabel}`, "pending");
  }

  if (phase === "ready") {
    return statusItem("chromium", "Browsers", `Ready · ${runningLabel}`, "ready");
  }

  if (phase === "loading" || phase === "refreshing") {
    return statusItem("chromium", "Browsers", `Checking · ${runningLabel}`, "pending");
  }

  if (phase === "launching") {
    return statusItem("chromium", "Browsers", `Launching · ${runningLabel}`, "pending");
  }

  if (phase === "stopping") {
    return statusItem("chromium", "Browsers", `Stopping · ${runningLabel}`, "pending");
  }

  return statusItem(
    "chromium",
    "Browsers",
    phase === "bridge-error" ? `Unavailable · ${runningLabel}` : `Needs support · ${runningLabel}`,
    phase === "bridge-error" ? "error" : "attention",
    supportHint("chromium"),
  );
}

function buildAutomationItem(snapshot: BuildGlobalStatusInput["automationApi"]): GlobalStatusItem {
  const phase = normalizePhase(snapshot?.phase);
  const lifecycle = normalizePhase(snapshot?.status);

  if (lifecycle === "running" || snapshot?.running === true) {
    return statusItem("automation", "Automation", "Available", "ready");
  }

  if (lifecycle === "stopped" || snapshot?.running === false) {
    return statusItem("automation", "Automation", "Ready to start", "ready");
  }

  if (!phase || phase === "idle") {
    return statusItem("automation", "Automation", "Not checked", "pending");
  }

  if (phase === "ready") {
    return statusItem("automation", "Automation", "Status pending", "pending");
  }

  if (phase === "starting") {
    return statusItem("automation", "Automation", "Starting", "pending");
  }

  if (phase === "stopping") {
    return statusItem("automation", "Automation", "Stopping", "pending");
  }

  if (phase === "refreshing" || phase === "copying") {
    return statusItem("automation", "Automation", "Checking", "pending");
  }

  return statusItem(
    "automation",
    "Automation",
    phase === "bridge-error" ? "Unavailable" : "Needs support",
    phase === "bridge-error" ? "error" : "attention",
    supportHint("automation"),
  );
}

function buildProfilesItem(snapshot: BuildGlobalStatusInput["profiles"], profileCount: number): GlobalStatusItem {
  const phase = normalizePhase(snapshot?.phase);
  const value = `${profileCount} ${profileCount === 1 ? "profile" : "profiles"}`;

  if (isErrorPhase(phase)) {
    return statusItem("profiles", "Profiles", value, phase === "bridge-error" ? "error" : "attention", supportHint("profiles"));
  }

  if (!phase || phase === "loading") {
    return statusItem("profiles", "Profiles", value, "pending");
  }

  if (profileCount === 0) {
    return statusItem("profiles", "Profiles", value, "attention");
  }

  return statusItem("profiles", "Profiles", value, "ready");
}

function buildAttentionItem({
  candidates,
  existingItems,
  profileCount,
}: {
  candidates: GlobalAttentionCandidate[] | null | undefined;
  existingItems: GlobalStatusItem[];
  profileCount: number;
}): GlobalStatusItem {
  const latestAttention = chooseLatestAttention(candidates);
  if (latestAttention) {
    const sourceLabel = SOURCE_LABELS[latestAttention.source];
    const tone = latestAttention.phase === "bridge-error" ? "error" : "attention";
    return statusItem("attention", "Attention", `${sourceLabel} needs support`, tone, supportHint(latestAttention.source));
  }

  if (profileCount === 0) {
    return statusItem("attention", "Attention", "Create a profile", "attention");
  }

  const blockingItem = existingItems.find((item) => item.tone === "error" || item.tone === "attention");
  if (blockingItem) {
    return statusItem(
      "attention",
      "Attention",
      `${blockingItem.label} needs review`,
      blockingItem.tone,
      blockingItem.supportActionHint ?? "Open Support for a safe, redacted drilldown.",
    );
  }

  if (existingItems.some((item) => item.tone === "pending")) {
    return statusItem("attention", "Attention", "Setup in progress", "pending");
  }

  return statusItem("attention", "Attention", "All systems ready", "ready");
}

function chooseLatestAttention(candidates: GlobalAttentionCandidate[] | null | undefined): GlobalAttentionCandidate | null {
  const safeCandidates = (candidates ?? []).filter((candidate) => {
    const phase = normalizePhase(candidate.phase);
    return isErrorPhase(phase) || Boolean(candidate.detailRef) || Boolean(candidate.code);
  });

  if (safeCandidates.length === 0) {
    return null;
  }

  return safeCandidates
    .map((candidate, index) => ({ candidate, index, time: timestampValue(candidate.occurredAt) }))
    .sort((left, right) => {
      if (right.time !== left.time) {
        return right.time - left.time;
      }
      return left.index - right.index;
    })[0].candidate;
}

function chooseOverallTone(items: GlobalStatusItem[]): GlobalStatusTone {
  if (items.some((item) => item.tone === "error")) {
    return "error";
  }
  if (items.some((item) => item.tone === "attention")) {
    return "attention";
  }
  if (items.some((item) => item.tone === "pending")) {
    return "pending";
  }
  return "ready";
}

function formatStatusLine(tone: GlobalStatusTone): string {
  if (tone === "error") {
    return GLOBAL_STATUS_ERROR_LINE;
  }
  if (tone === "attention") {
    return GLOBAL_STATUS_ATTENTION_LINE;
  }
  if (tone === "pending") {
    return GLOBAL_STATUS_PENDING_LINE;
  }
  return GLOBAL_STATUS_READY_LINE;
}

function statusItem(
  key: GlobalStatusItemKey,
  label: string,
  value: string,
  tone: GlobalStatusTone,
  supportActionHint?: string,
): GlobalStatusItem {
  return supportActionHint ? { key, label, value, tone, supportActionHint } : { key, label, value, tone };
}

function supportHint(source: GlobalAttentionSource): string {
  return `Open Support to review ${SOURCE_LABELS[source].toLowerCase()} details.`;
}

function normalizePhase(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

function isErrorPhase(phase: string | null): boolean {
  return phase === "bridge-error" || phase === "recoverable-error" || phase === "error" || Boolean(phase?.endsWith("-error"));
}

function timestampValue(value: string | null | undefined): number {
  if (!value) {
    return -1;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : -1;
}
