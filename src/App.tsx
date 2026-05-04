import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSidecarHealth, triggerSidecarDiagnosticFailure } from "./sidecar/client";
import type { SidecarClientError, SidecarHealthSnapshot, SidecarUiPhase } from "./sidecar/types";

type BusyAction = "health" | "diagnostic" | null;

type ViewState = {
  phase: SidecarUiPhase;
  health: SidecarHealthSnapshot | null;
  error: SidecarClientError | null;
  lastCheckedAt: string | null;
};

const INITIAL_STATE: ViewState = {
  phase: "loading",
  health: null,
  error: null,
  lastCheckedAt: null,
};

const PHASE_LABELS: Record<SidecarUiPhase, string> = {
  loading: "Checking sidecar",
  healthy: "Sidecar healthy",
  "recoverable-error": "Recoverable sidecar error",
  "bridge-error": "Sidecar unavailable",
};

const verificationMilestones = [
  "Typed React client owns all Tauri invokes",
  "Health refresh disables duplicate sidecar spawns",
  "Diagnostic failure stays recoverable with a detailRef",
];

export function App() {
  const [state, setState] = useState<ViewState>(INITIAL_STATE);
  const [busyAction, setBusyAction] = useState<BusyAction>("health");
  const inFlightRef = useRef(false);

  const finishWithError = useCallback((error: SidecarClientError) => {
    const checkedAt = new Date().toISOString();
    setState({
      phase: error.phase,
      health: null,
      error,
      lastCheckedAt: checkedAt,
    });
  }, []);

  const refreshHealth = useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    setBusyAction("health");
    setState((current) => ({
      ...current,
      phase: current.health || current.error ? current.phase : "loading",
    }));

    try {
      const health = await getSidecarHealth();
      setState({
        phase: "healthy",
        health,
        error: null,
        lastCheckedAt: health.checkedAt,
      });
    } catch (error) {
      finishWithError(error as SidecarClientError);
    } finally {
      inFlightRef.current = false;
      setBusyAction(null);
    }
  }, [finishWithError]);

  const triggerDiagnosticError = useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    setBusyAction("diagnostic");

    try {
      await triggerSidecarDiagnosticFailure();
    } catch (error) {
      finishWithError(error as SidecarClientError);
    } finally {
      inFlightRef.current = false;
      setBusyAction(null);
    }
  }, [finishWithError]);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  const isBusy = busyAction !== null;
  const phaseTone = state.phase === "healthy" ? "ready" : state.phase === "loading" ? "pending" : "error";
  const primaryDetailRef = state.error?.detailRef ?? "Waiting for first sidecar response";

  return (
    <main className="shell" aria-labelledby="shell-heading">
      <section className="hero-panel" aria-label="ThePrivator rewrite overview">
        <div className="hero-copy">
          <p className="kicker">M001 · S01 runtime spine</p>
          <h1 id="shell-heading">ThePrivator rewrite spine</h1>
          <p className="hero-lede">
            A Tauri 2 desktop shell proving the typed Rust command bridge, bundled Python sidecar,
            and recoverable diagnostics path before profile workflows move over from the legacy app.
          </p>
        </div>

        <aside className={`phase-ribbon phase-ribbon--${phaseTone}`} aria-label="Current sidecar phase">
          <span className="pulse-dot" aria-hidden="true" />
          <span className="phase-label">Phase</span>
          <strong>{state.phase}</strong>
          <span>{PHASE_LABELS[state.phase]}</span>
        </aside>
      </section>

      <section className="control-bar" aria-label="Sidecar health actions">
        <div>
          <p className="kicker">Live sidecar boundary</p>
          <h2>Health and recoverable diagnostics are coming through Tauri commands.</h2>
        </div>
        <div className="action-row">
          <button type="button" onClick={refreshHealth} disabled={isBusy}>
            {busyAction === "health" ? "Refreshing…" : "Refresh health"}
          </button>
          <button
            className="button--danger"
            type="button"
            onClick={triggerDiagnosticError}
            disabled={isBusy}
          >
            {busyAction === "diagnostic" ? "Triggering…" : "Trigger diagnostic error"}
          </button>
        </div>
      </section>

      <section className="signal-grid" aria-label="S01 sidecar status regions">
        <HealthCard health={state.health} isLoading={state.phase === "loading"} />
        <BuildCard health={state.health} />
        <StatusCard state={state} detailRef={primaryDetailRef} />
        <ErrorCard error={state.error} onRetry={refreshHealth} isBusy={isBusy} />
      </section>

      <section className="runbook-panel" aria-label="Sidecar verification checklist">
        <div>
          <p className="kicker">Visible contract</p>
          <h2>Health, build, status, request, and deliberate error surfaces are live.</h2>
        </div>
        <ol>
          {verificationMilestones.map((milestone) => (
            <li key={milestone}>{milestone}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}

function HealthCard({ health, isLoading }: { health: SidecarHealthSnapshot | null; isLoading: boolean }) {
  const productVersion = formatProductVersion(health);

  return (
    <article className="signal-card signal-card--health" aria-label="Health region">
      <p className="signal-label">Health</p>
      <h2>{isLoading ? "Checking sidecar" : health ? health.health.status : "Health unavailable"}</h2>
      <dl className="metric-list">
        <Metric label="Product / app" value={productVersion} />
        <Metric label="Sidecar" value={health?.health.sidecar.version} />
        <Metric label="Protocol" value={health?.health.protocol.version} />
        <Metric label="Runtime" value={formatRuntime(health)} />
      </dl>
    </article>
  );
}

function BuildCard({ health }: { health: SidecarHealthSnapshot | null }) {
  return (
    <article className="signal-card signal-card--build" aria-label="Build region">
      <p className="signal-label">Build</p>
      <h2>{formatBuildMode(health)}</h2>
      <dl className="metric-list">
        <Metric label="Platform" value={formatPlatform(health)} />
        <Metric label="Frozen" value={health ? (health.health.build.frozen ? "yes" : "no") : undefined} />
        <Metric label="Sidecar request" value={formatDuration(health?.health.request?.durationMs)} />
        <Metric label="Bridge invoke" value={formatDuration(health?.bridgeDurationMs)} />
      </dl>
    </article>
  );
}

function StatusCard({ state, detailRef }: { state: ViewState; detailRef: string }) {
  return (
    <article className="signal-card signal-card--status" aria-label="Status region">
      <p className="signal-label">Status</p>
      <h2>{PHASE_LABELS[state.phase]}</h2>
      <dl className="metric-list">
        <Metric label="Visible phase" value={state.phase} />
        <Metric label="Request ID" value={state.health?.requestId} />
        <Metric label="Last checked" value={formatCheckedAt(state.lastCheckedAt)} />
        <Metric label="detailRef" value={detailRef} />
      </dl>
    </article>
  );
}

function ErrorCard({
  error,
  onRetry,
  isBusy,
}: {
  error: SidecarClientError | null;
  onRetry: () => void;
  isBusy: boolean;
}) {
  const headline = useMemo(() => {
    if (!error) {
      return "Diagnostic path armed";
    }

    if (error.source === "sidecar") {
      return "Recoverable sidecar error";
    }

    if (error.source === "protocol") {
      return "Protocol response needs attention";
    }

    return "Sidecar unavailable";
  }, [error]);

  return (
    <article
      className={`signal-card signal-card--error ${error ? "signal-card--has-error" : ""}`}
      aria-label="Recoverable error region"
    >
      <p className="signal-label">Recoverable error</p>
      <h2>{headline}</h2>
      {error ? (
        <div className="error-copy" role="status" aria-live="polite">
          <p>{error.message}</p>
          <dl className="metric-list">
            <Metric label="Code" value={error.code} />
            <Metric label="Recoverable" value={error.recoverable ? "yes" : "no"} />
            <Metric label="Source" value={error.source} />
            <Metric label="detailRef" value={error.detailRef} />
          </dl>
          <button type="button" onClick={onRetry} disabled={isBusy}>
            Retry health
          </button>
        </div>
      ) : (
        <p>
          Trigger the diagnostic action to prove typed sidecar failures render with a detailRef and
          without crashing the shell.
        </p>
      )}
    </article>
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

  return `${formatValue(snapshot.health.runtime.implementation)} ${formatValue(
    snapshot.health.runtime.pythonVersion,
  )}`;
}

function formatPlatform(snapshot: SidecarHealthSnapshot | null): string {
  if (!snapshot) {
    return "Awaiting health";
  }

  return [snapshot.health.platform.system, snapshot.health.platform.release, snapshot.health.platform.machine]
    .map(formatValue)
    .join(" · ");
}

function formatBuildMode(snapshot: SidecarHealthSnapshot | null): string {
  if (!snapshot) {
    return "Build metadata pending";
  }

  return `${formatValue(snapshot.health.build.mode)} mode`;
}

function formatDuration(value: number | undefined): string {
  return typeof value === "number" ? `${value.toFixed(2)} ms` : "Awaiting health";
}

function formatCheckedAt(value: string | null): string {
  if (!value) {
    return "Not checked yet";
  }

  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "Unavailable";
  }

  return String(value);
}
