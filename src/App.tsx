type SignalCard = {
  label: string;
  value: string;
  description: string;
  tone: "ready" | "pending" | "error";
};

const shellSignals: SignalCard[] = [
  {
    label: "Health",
    value: "Awaiting sidecar contract",
    description:
      "Reserved for the typed Python NDJSON health response that lands in the next slice task.",
    tone: "pending",
  },
  {
    label: "Build",
    value: "Tauri 2 spine online",
    description:
      "Vite, TypeScript, Rust, and Tauri config are wired so packaging work can extend this shell.",
    tone: "ready",
  },
  {
    label: "Status",
    value: "Bridge placeholder compiled",
    description:
      "The webview surface is intentionally narrow while Rust commands become the trusted sidecar boundary.",
    tone: "ready",
  },
  {
    label: "Recoverable error",
    value: "Diagnostic slot reserved",
    description:
      "Future deliberate sidecar failures will render here with a detailRef instead of crashing the UI.",
    tone: "error",
  },
];

const verificationMilestones = [
  "React shell render test",
  "Vite production build",
  "Rust command bridge check",
];

export function App() {
  return (
    <main className="shell" aria-labelledby="shell-heading">
      <section className="hero-panel" aria-label="ThePrivator rewrite overview">
        <div className="hero-copy">
          <p className="kicker">M001 · S01 runtime spine</p>
          <h1 id="shell-heading">ThePrivator rewrite spine</h1>
          <p className="hero-lede">
            A Tauri 2 desktop shell for proving the typed Rust command bridge,
            bundled Python sidecar, and recoverable diagnostics path before the
            profile workflow moves over from the legacy CustomTkinter app.
          </p>
        </div>

        <aside className="build-ribbon" aria-label="Current scaffold phase">
          <span className="pulse-dot" aria-hidden="true" />
          <span>Scaffold phase checked by Vitest, Vite, and Cargo</span>
        </aside>
      </section>

      <section className="signal-grid" aria-label="S01 sidecar status regions">
        {shellSignals.map((signal) => (
          <article
            className={`signal-card signal-card--${signal.tone}`}
            key={signal.label}
            aria-label={`${signal.label} region`}
          >
            <p className="signal-label">{signal.label}</p>
            <h2>{signal.value}</h2>
            <p>{signal.description}</p>
          </article>
        ))}
      </section>

      <section className="runbook-panel" aria-label="Scaffold verification checklist">
        <div>
          <p className="kicker">Visible contract</p>
          <h2>Reserved health, build, status, and deliberate error surfaces</h2>
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
