import { describe, expect, it } from "vitest";
import { buildGlobalStatusSummary } from "./globalStatus";

function itemMap(summary: ReturnType<typeof buildGlobalStatusSummary>) {
  return Object.fromEntries(summary.items.map((item) => [item.key, item]));
}

describe("buildGlobalStatusSummary", () => {
  it("summarizes a ready workspace with a stable five-item product vocabulary", () => {
    const summary = buildGlobalStatusSummary({
      health: { phase: "healthy", status: "healthy" },
      chromium: { phase: "ready", runningCount: 0 },
      automationApi: { phase: "ready", status: "running", running: true },
      profiles: { phase: "ready", count: 3 },
    });
    const items = itemMap(summary);

    expect(summary.overallTone).toBe("ready");
    expect(summary.statusLine).toBe("Workspace ready");
    expect(summary.items).toHaveLength(5);
    expect(items.sidecar).toMatchObject({ label: "App connection", value: "Ready", tone: "ready" });
    expect(items.chromium).toMatchObject({ label: "Browsers", value: "Ready · 0 running", tone: "ready" });
    expect(items.automation).toMatchObject({ label: "Automation", value: "Available", tone: "ready" });
    expect(items.profiles).toMatchObject({ label: "Profiles", value: "3 profiles", tone: "ready" });
    expect(items.attention).toMatchObject({ label: "Attention", value: "All systems ready", tone: "ready" });
    expect(summary.hasSupportAction).toBe(false);
  });

  it("uses safe pending labels for missing or malformed snapshots", () => {
    const summary = buildGlobalStatusSummary({
      health: null,
      chromium: { phase: null, runningCount: Number.NaN },
      automationApi: { phase: "idle", status: null, running: null },
      profiles: { phase: null, count: null },
    });
    const items = itemMap(summary);

    expect(summary.overallTone).toBe("attention");
    expect(items.sidecar).toMatchObject({ value: "Checking", tone: "pending" });
    expect(items.chromium).toMatchObject({ value: "Status pending · 0 running", tone: "pending" });
    expect(items.automation).toMatchObject({ value: "Not checked", tone: "pending" });
    expect(items.profiles).toMatchObject({ value: "0 profiles", tone: "pending" });
    expect(items.attention).toMatchObject({ value: "Create a profile", tone: "attention" });
  });

  it("surfaces generic support attention without leaking codes, detail refs, paths, tokens, or stack text", () => {
    const summary = buildGlobalStatusSummary({
      health: { phase: "recoverable-error", status: null },
      chromium: { phase: "ready", runningCount: 0 },
      automationApi: { phase: "ready", status: "stopped", running: false },
      profiles: { phase: "ready", count: 2 },
      attentionCandidates: [
        {
          source: "sidecar",
          phase: "recoverable-error",
          code: "PROXY_PASSWORD_private.example.invalid",
          detailRef: "profile-store/diagnostics/events.jsonl sidecar-detail-ref",
          occurredAt: "2026-05-04T18:00:00.000Z",
        },
      ],
    });
    const serialized = JSON.stringify(summary);
    const items = itemMap(summary);

    expect(summary.overallTone).toBe("attention");
    expect(summary.hasSupportAction).toBe(true);
    expect(items.attention).toMatchObject({ value: "App connection needs support", tone: "attention" });
    expect(items.attention.supportActionHint).toBe("Open Support to review app connection details.");
    expect(serialized).not.toMatch(/detailRef|sidecar-detail-ref|profile-store|private\.example\.invalid|PROXY_PASSWORD|password|token|traceback|stack/i);
  });

  it("reports Chromium running count directly without iterating or expanding profile rows", () => {
    const summary = buildGlobalStatusSummary({
      health: { phase: "healthy", status: "healthy" },
      chromium: { phase: "ready", runningCount: 12.8 },
      automationApi: { phase: "ready", status: "stopped", running: false },
      profiles: { phase: "ready", count: 2 },
    });
    const items = itemMap(summary);

    expect(summary.items).toHaveLength(5);
    expect(items.chromium).toMatchObject({ value: "Ready · 12 running", tone: "ready" });
    expect(items.profiles).toMatchObject({ value: "2 profiles", tone: "ready" });
  });

  it("distinguishes running and stopped Automation API availability without exposing endpoints", () => {
    const running = itemMap(buildGlobalStatusSummary({ automationApi: { phase: "ready", status: "running", running: true } })).automation;
    const stopped = itemMap(buildGlobalStatusSummary({ automationApi: { phase: "ready", status: "stopped", running: false } })).automation;

    expect(running).toMatchObject({ value: "Available", tone: "ready" });
    expect(stopped).toMatchObject({ value: "Ready to start", tone: "ready" });
    expect(JSON.stringify([running, stopped])).not.toMatch(/127\.0\.0\.1|localhost|\/health|Bearer|Authorization/i);
  });

  it("handles zero profiles and large profile counts with the same compact DOM contract", () => {
    const empty = buildGlobalStatusSummary({
      health: { phase: "healthy", status: "healthy" },
      chromium: { phase: "ready", runningCount: 0 },
      automationApi: { phase: "ready", status: "stopped", running: false },
      profiles: { phase: "ready", count: 0 },
    });
    const many = buildGlobalStatusSummary({
      health: { phase: "healthy", status: "healthy" },
      chromium: { phase: "ready", runningCount: 41 },
      automationApi: { phase: "ready", status: "stopped", running: false },
      profiles: { phase: "ready", count: 10_000 },
    });

    expect(itemMap(empty).profiles).toMatchObject({ value: "0 profiles", tone: "attention" });
    expect(itemMap(empty).attention).toMatchObject({ value: "Create a profile", tone: "attention" });
    expect(itemMap(many).profiles).toMatchObject({ value: "10000 profiles", tone: "ready" });
    expect(itemMap(many).chromium).toMatchObject({ value: "Ready · 41 running", tone: "ready" });
    expect(empty.items).toHaveLength(many.items.length);
  });

  it("chooses the newest support candidate deterministically and keeps raw values out of labels", () => {
    const summary = buildGlobalStatusSummary({
      health: { phase: "healthy", status: "healthy" },
      chromium: { phase: "bridge-error", runningCount: 1 },
      automationApi: { phase: "recoverable-error", status: null, running: null },
      profiles: { phase: "ready", count: 1 },
      attentionCandidates: [
        { source: "chromium", phase: "bridge-error", detailRef: "chrome-ref-with---remote-debugging-port", occurredAt: "2026-05-04T18:00:00.000Z" },
        { source: "automation", phase: "recoverable-error", detailRef: "automation-ref-with-tpapi-token", occurredAt: "2026-05-04T18:05:00.000Z" },
      ],
    });
    const attention = itemMap(summary).attention;

    expect(summary.overallTone).toBe("error");
    expect(attention).toMatchObject({ value: "Automation API needs support", tone: "attention" });
    expect(JSON.stringify(summary)).not.toMatch(/chrome-ref|automation-ref|remote-debugging-port|tpapi-token/i);
  });
});
