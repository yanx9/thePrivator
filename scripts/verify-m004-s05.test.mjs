import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VerifyFailure } from "./verify-m004-s01.mjs";
import {
  S05_CLIPBOARD_STATE_KEY,
  S05_CLIPBOARD_TOKEN_KEY,
  S05_PROFILE_PREFIX,
  S05_REQUIRED_DIAGNOSTIC_FAILURE_METHODS,
  S05_REQUIRED_DIAGNOSTIC_SUCCESS_METHODS,
  S05_REQUIRED_PACKAGED_HELPERS,
  VERIFY_EVENT,
  assertS05PostSmokeDiagnostics,
  assertS05PublicEvidenceRedacted,
  buildS05FinalSummary,
  clearPrivateClipboardCapture,
  createS05RedactionContext,
  findS05ForbiddenPublicMarker,
  installPrivateClipboardCapture,
  packagedHarness,
  parseArgs,
  readPrivateClipboardToken,
  safeS05ErrorForPublic,
  validateAutomationApiStatusMetrics,
  validatePrivateAutomationApiToken,
} from "./verify-m004-s05.mjs";

const tempRoots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "theprivator-m004-s05-test-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeDiagnostics(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function makeContext() {
  const root = makeRoot();
  const smokeRoot = join(root, "src-tauri", "target", "s06-smoke-data", "s05-run-should-not-leak");
  const appDataRoot = join(smokeRoot, "data", "Com.ThePrivator.Desktop");
  const profileRoot = join(appDataRoot, "profile-store", "profiles", "profile-a");
  const userDataRoot = join(profileRoot, "user-data");
  const token = "m004-s05-token-should-not-leak-55b9";
  const leaseId = "lease_s05ShouldNotLeak123456";
  const endpoint = "http://127.0.0.1:45678";
  const apiBaseUrl = "http://127.0.0.1:46789";
  const targetUrl = "http://theprivator-proxy-proof.invalid:18080/theprivator-proxy-proof?case=s05";
  const proxyAuthority = "http://127.0.0.1:19090";
  const proxyUser = "s05-proxy-user-should-not-leak";
  const proxyPassword = "s05-proxy-password-should-not-leak";
  return {
    root,
    smokeRoot,
    appDataRoot,
    profileRoot,
    userDataRoot,
    token,
    leaseId,
    endpoint,
    apiBaseUrl,
    targetUrl,
    proxyAuthority,
    proxyUser,
    proxyPassword,
    context: createS05RedactionContext({
      rootDir: root,
      token,
      copiedToken: token,
      apiBaseUrl,
      storeRoot: appDataRoot,
      leaseIds: [leaseId],
      handoffEndpoints: [endpoint],
      targetUrls: [targetUrl],
      proxyAuthorities: [proxyAuthority],
      smokeRoots: [smokeRoot],
      appDataRoots: [appDataRoot],
      profileRoots: [profileRoot],
      userDataRoots: [userDataRoot],
      extraSensitiveValues: [proxyUser, proxyPassword],
    }),
  };
}

function expectSafeFailure(callback, forbiddenText = []) {
  try {
    callback();
    throw new Error("expected callback to throw");
  } catch (error) {
    if (error?.message === "expected callback to throw") {
      throw error;
    }
    expect(error).toBeInstanceOf(VerifyFailure);
    const encoded = JSON.stringify({ message: error.message, details: error.details });
    for (const marker of forbiddenText) {
      expect(encoded).not.toContain(marker);
    }
    if (Object.prototype.hasOwnProperty.call(error.details, "fieldPath")) {
      expect(error.details.fieldPath).toMatch(/^\$/);
    }
    return error;
  }
}

function cleanSummary(context) {
  return buildS05FinalSummary({
    status: "pass",
    mode: "contracts-only",
    packageProof: {
      buildFresh: true,
      artifactsChecked: true,
      artifactCount: 3,
      preflightStatus: "pass",
    },
    ui: {
      profileCreated: true,
      identityConfigured: true,
      proxyConfigured: true,
      copyFlowUsed: true,
      apiStarted: true,
    },
    api: {
      started: true,
      stopped: true,
      status: "healthy",
      statusCode: 200,
      requestId: "automation-s05status",
      detailRef: "sidecar-s05status",
    },
    http: {
      health: { status: "pass", statusCode: 200, requestId: "automation-s05health" },
      auth: [
        { statusCode: 401, errorCode: "AUTOMATION_AUTH_REQUIRED", requestId: "automation-s05auth1", detailRef: "sidecar-s05auth1" },
        { statusCode: 401, errorCode: "AUTOMATION_AUTH_INVALID", requestId: "automation-s05auth2", detailRef: "sidecar-s05auth2" },
      ],
      profiles: { statusCode: 200, requestId: "automation-s05profiles" },
      runtime: { statusCode: 200, requestId: "automation-s05runtime" },
    },
    leaseFlow: {
      create: { status: "created", statusCode: 201, requestId: "automation-s05lease1", detailRef: "sidecar-s05lease1" },
      active: { status: "active", statusCode: 200, requestId: "automation-s05lease2" },
      release: { status: "released", statusCode: 200, requestId: "automation-s05lease3" },
      releasedReuse: { statusCode: 409, errorCode: "AUTOMATION_LEASE_RELEASED", requestId: "automation-s05lease4", detailRefPresent: true },
      expiry: { status: "expired", statusCode: 200, requestId: "automation-s05lease5" },
      expiredReuse: { statusCode: 409, errorCode: "AUTOMATION_LEASE_EXPIRED", requestId: "automation-s05lease6", detailRefPresent: true },
      revocation: { status: "pass", statusCode: 409, errorCode: "AUTOMATION_LEASE_ENDPOINT_REVOKED", requestCorrelated: true },
    },
    playwright: {
      attached: true,
      navigated: true,
      targetMarker: true,
      identityMatches: 6,
      proxyObservationCount: 2,
    },
    cleanup: {
      appStopped: true,
      apiStopped: true,
      listenerClosed: true,
      runtimeStopped: true,
      fixtureStopped: true,
      retainedSmokeData: true,
      diagnosticsScanned: true,
    },
    redaction: { status: "clean", scanned: true, forbiddenMarkerCount: 0 },
    checks: [
      { name: "redaction-scan", status: "pass", durationMs: 2, code: "S05_REDACTION_CLEAN" },
      { name: "auth-missing", status: "pass", statusCode: 401, requestId: "automation-s05check" },
    ],
  }, context);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("verify-m004-s05 packaged harness contract", () => {
  it("imports the reusable S06 packaged harness primitives without exporting raw fixture secrets", () => {
    expect(VERIFY_EVENT).toBe("verify.m004.s05");
    expect(S05_PROFILE_PREFIX).toBe("M004 Packaged Automation Smoke");
    for (const helperName of S05_REQUIRED_PACKAGED_HELPERS) {
      expect(packagedHarness[helperName], helperName).toBeTypeOf("function");
    }
    expect(Object.keys(packagedHarness)).not.toEqual(expect.arrayContaining([
      "PACKAGED_SMOKE_PROXY_USERNAME",
      "PACKAGED_SMOKE_PROXY_PASSWORD",
      "PACKAGED_SMOKE_PROXY_TARGET_HOST",
      "PACKAGED_SMOKE_PROXY_TARGET_PATH",
      "GLOBAL_SENSITIVE_VALUES",
    ]));
  });

  it("lets S05 choose a safe visible profile prefix while preserving S06 prefix validation", () => {
    const root = makeRoot();
    const context = packagedHarness.createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-10T11:12:13.000Z"),
      nonce: "s05prefix",
      profilePrefix: S05_PROFILE_PREFIX,
      baseEnv: {},
    });

    expect(context.smokeProfileName).toBe("M004 Packaged Automation Smoke 20260510T111213000Z-s05prefix");
    expect(context.log.smokeProfileName).toBe(context.smokeProfileName);
    expect(JSON.stringify(context.log)).not.toContain(root);
    expect(() => packagedHarness.createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-10T11:12:13.000Z"),
      nonce: "unsafe",
      profilePrefix: "M004/Packaged Automation Smoke",
      baseEnv: {},
    })).toThrow(/profile prefix/i);
  });
});

describe("verify-m004-s05 public evidence redaction", () => {
  it("catches token, credential, proxy, path, handoff, raw diagnostics, argv/env, stack, lease, and CDP markers", () => {
    const {
      context,
      token,
      leaseId,
      endpoint,
      apiBaseUrl,
      targetUrl,
      proxyAuthority,
      proxyUser,
      proxyPassword,
      appDataRoot,
      profileRoot,
      userDataRoot,
    } = makeContext();
    const cases = [
      [{ Authorization: `Bearer ${token}` }, "Authorization"],
      [`Bearer ${token}`, token],
      [{ copiedToken: token }, token],
      [{ credentials: { username: proxyUser, password: proxyPassword } }, proxyPassword],
      [{ note: `http://${proxyUser}:${proxyPassword}@127.0.0.1:19090` }, proxyUser],
      [{ args: ["--proxy-server=http://user:pass@127.0.0.1:8080"] }, "--proxy-server"],
      [{ value: "--proxy-bypass-list=<-loopback>" }, "--proxy-bypass-list"],
      [{ value: "direct://fallback" }, "direct://"],
      [{ storeRoot: appDataRoot }, appDataRoot],
      [{ value: `${profileRoot}/profile-store/profiles/profile-a/user-data` }, profileRoot],
      [{ value: userDataRoot }, userDataRoot],
      [{ rawDiagnostics: { stdout: "raw child output", stderr: "raw child failure" } }, "stdout"],
      [{ argv: ["--remote-debugging-port=9222"], env: { THEPRIVATOR_AUTOMATION_API_TOKEN: token } }, "--remote-debugging-port"],
      [{ stack: "Traceback: sensitive failure" }, "Traceback"],
      [{ leaseId }, leaseId],
      [{ handoff: { endpoint } }, endpoint],
      [{ apiBaseUrl }, apiBaseUrl],
      [{ value: targetUrl }, targetUrl],
      [{ value: proxyAuthority }, proxyAuthority],
      [{ value: "DevToolsActivePort" }, "DevToolsActivePort"],
      [{ value: "ws://127.0.0.1:9222/devtools/browser/raw" }, "ws://"],
      [{ value: "cdp://127.0.0.1:9222" }, "cdp://"],
    ];

    for (const [artifact, rawMarker] of cases) {
      const marker = findS05ForbiddenPublicMarker(artifact, context);
      expect(marker, JSON.stringify(artifact)).toBeTruthy();
      const error = expectSafeFailure(() => assertS05PublicEvidenceRedacted(artifact, context), [
        rawMarker,
        token,
        leaseId,
        endpoint,
        apiBaseUrl,
        targetUrl,
        proxyAuthority,
        proxyUser,
        proxyPassword,
        appDataRoot,
        profileRoot,
        userDataRoot,
      ]);
      expect(error.details.markerClass).toBeTruthy();
    }
  });

  it("handles nested arrays and non-object evidence without echoing unsafe content", () => {
    const { context, token, endpoint } = makeContext();
    expect(findS05ForbiddenPublicMarker("plain safe status", context)).toBeNull();
    expect(findS05ForbiddenPublicMarker(204, context)).toBeNull();
    expect(findS05ForbiddenPublicMarker([{ status: "pass" }, ["nested", { stderr: `failed ${token}` }]], context)).toMatchObject({ markerClass: "raw_diag" });
    expectSafeFailure(() => assertS05PublicEvidenceRedacted([{ ok: true }, ["nested", { endpoint }]], context), [endpoint, token]);
  });

  it("builds a clean final summary with safe booleans, counts, statuses, codes, request IDs, and detailRefs", () => {
    const { context, token, leaseId, endpoint, apiBaseUrl, targetUrl, proxyAuthority, proxyUser, proxyPassword, appDataRoot, profileRoot, userDataRoot } = makeContext();
    const summary = cleanSummary(context);
    const encoded = JSON.stringify(summary);

    expect(summary.event).toBe(VERIFY_EVENT);
    expect(summary.status).toBe("pass");
    expect(summary.proofScope).toMatchObject({ packagedHarness: true, automationApi: true, playwrightAttach: true });
    expect(summary.http.auth).toEqual(expect.arrayContaining([
      expect.objectContaining({ statusCode: 401, errorCode: "AUTOMATION_AUTH_REQUIRED", requestId: "automation-s05auth1", detailRef: "sidecar-s05auth1" }),
    ]));
    expect(summary.leaseFlow.releasedReuse).toMatchObject({ statusCode: 409, errorCode: "AUTOMATION_LEASE_RELEASED", detailRefPresent: true });
    expect(encoded).not.toContain(token);
    expect(encoded).not.toContain(leaseId);
    expect(encoded).not.toContain(endpoint);
    expect(encoded).not.toContain(apiBaseUrl);
    expect(encoded).not.toContain(targetUrl);
    expect(encoded).not.toContain(proxyAuthority);
    expect(encoded).not.toContain(proxyUser);
    expect(encoded).not.toContain(proxyPassword);
    expect(encoded).not.toContain(appDataRoot);
    expect(encoded).not.toContain(profileRoot);
    expect(encoded).not.toContain(userDataRoot);
    expect(encoded).not.toMatch(/Authorization|Bearer|--proxy-server|direct:\/\/|DevToolsActivePort|webSocketDebuggerUrl|stdout|stderr|Traceback|profile-store|user-data/i);
    expect(() => assertS05PublicEvidenceRedacted(summary, context)).not.toThrow();
  });

  it("fails the final summary scan when unsafe fields are appended later", () => {
    const { context, endpoint, token } = makeContext();
    const summary = cleanSummary(context);
    summary.checks.push({ name: "unsafe", status: "pass", endpoint });

    const marker = findS05ForbiddenPublicMarker(summary, context);
    expect(marker).toMatchObject({ markerClass: "lease_endpoint" });
    expectSafeFailure(() => assertS05PublicEvidenceRedacted(summary, context), [endpoint, token]);
  });

  it("formats failures and unknown CLI arguments without raw token, endpoint, path, credential, or process markers", () => {
    const { context, token, endpoint, appDataRoot, proxyUser, proxyPassword } = makeContext();
    const rawError = new Error(`Failed with ${token} ${endpoint} ${appDataRoot} ${proxyUser}:${proxyPassword} --proxy-server=http://user:pass@127.0.0.1:8080 Traceback`);
    const safeError = safeS05ErrorForPublic(rawError, context);
    const encoded = JSON.stringify(safeError);

    expect(encoded).not.toContain(token);
    expect(encoded).not.toContain(endpoint);
    expect(encoded).not.toContain(appDataRoot);
    expect(encoded).not.toContain(proxyUser);
    expect(encoded).not.toContain(proxyPassword);
    expect(encoded).not.toContain("--proxy-server");
    expect(encoded).not.toContain("Traceback");
    expect(encoded).toContain("<redacted");

    const argumentError = expectSafeFailure(() => parseArgs(["--token=should-not-leak"]), ["--token=should-not-leak"]);
    expect(argumentError.details).toMatchObject({ code: "S05_UNKNOWN_ARGUMENT", unknownArgumentCount: 1 });
    expect(parseArgs(["--lifecycle-only", "--skip-build"])).toMatchObject({ lifecycleOnly: true, skipBuild: true });
  });

  it("validates Automation API UI metrics without allowing unsafe loopback or copy states", () => {
    const metrics = validateAutomationApiStatusMetrics({
      lifecycle: "Running",
      loopbackUrl: "http://127.0.0.1:43123",
      port: "43123",
      scope: "loopback",
      copyAvailable: "yes",
    });
    expect(metrics).toMatchObject({ apiBaseUrl: "http://127.0.0.1:43123", port: 43123, copyAvailable: true });

    expectSafeFailure(() => validateAutomationApiStatusMetrics({
      lifecycle: "Running",
      loopbackUrl: "http://localhost:43123",
      port: "43123",
      scope: "loopback",
      copyAvailable: "yes",
    }), ["http://localhost:43123"]);
    expectSafeFailure(() => validateAutomationApiStatusMetrics({
      lifecycle: "Running",
      loopbackUrl: "http://127.0.0.1:43123",
      port: "43123",
      scope: "loopback",
      copyAvailable: "no",
    }));
  });

  it("captures copied tokens only through the private clipboard hook helpers", async () => {
    const scripts = [];
    const driver = {
      async executeScript(script) {
        scripts.push(script);
        if (script.includes(S05_CLIPBOARD_STATE_KEY)) {
          return { installed: true, captured: false };
        }
        if (script.includes(S05_CLIPBOARD_TOKEN_KEY) && script.startsWith("return")) {
          return "tpapi-privateCapture123";
        }
        return null;
      },
    };

    await expect(installPrivateClipboardCapture(driver)).resolves.toEqual({ hookInstalled: true });
    await expect(readPrivateClipboardToken(driver, { timeoutMs: 25, pollMs: 1 })).resolves.toBe("tpapi-privateCapture123");
    await expect(clearPrivateClipboardCapture(driver)).resolves.toEqual({ privateClipboardCleared: true });
    expect(scripts.join("\n")).toContain(S05_CLIPBOARD_TOKEN_KEY);
  });

  it("fails clipboard hook and token-shape errors without echoing captured values", async () => {
    const unavailableDriver = {
      async executeScript() {
        return { installed: false, captured: false, errorName: "TypeError" };
      },
    };
    await expect(installPrivateClipboardCapture(unavailableDriver)).rejects.toMatchObject({
      details: expect.objectContaining({ code: "S05_CLIPBOARD_HOOK_UNAVAILABLE" }),
    });

    const invalid = "raw-secret-token-value-that-should-not-echo";
    const error = expectSafeFailure(() => validatePrivateAutomationApiToken(invalid), [invalid]);
    expect(error.details).toMatchObject({ code: "S05_TOKEN_SHAPE_INVALID", prefixPresent: false });
  });

  it("builds a lifecycle-only summary that exposes protected discovery proof without private authority", () => {
    const { context, token, apiBaseUrl, endpoint, proxyAuthority } = makeContext();
    const summary = buildS05FinalSummary({
      status: "pass",
      mode: "lifecycle-only",
      packageProof: { buildFresh: false, artifactsChecked: true, artifactCount: 5, preflightStatus: "pass" },
      ui: { profileCreated: true, identityConfigured: true, proxyConfigured: true, copyFlowUsed: true, apiStarted: true },
      api: { started: true, stopped: true, status: "running", statusCode: 200, requestId: "automation-lifecycle1" },
      http: {
        health: { statusCode: 200, requestId: "automation-health1" },
        auth: [
          { statusCode: 401, errorCode: "AUTOMATION_AUTH_REQUIRED", requestId: "automation-auth1", detailRef: "sidecar-auth1" },
          { statusCode: 401, errorCode: "AUTOMATION_AUTH_INVALID", requestId: "automation-auth2", detailRef: "sidecar-auth2" },
        ],
        profiles: { statusCode: 200, requestId: "automation-profiles1" },
        profileStatus: { statusCode: 200, requestId: "automation-profile1", status: "stopped" },
        runtime: { statusCode: 200, requestId: "automation-runtime1", status: "stopped" },
      },
      cleanup: { appStopped: true, apiStopped: true, listenerClosed: true, runtimeStopped: true, fixtureStopped: true, retainedSmokeData: true },
      redaction: { status: "clean", scanned: true, forbiddenMarkerCount: 0 },
      checks: [{ name: "packaged-token-copy-private", status: "pass", durationMs: 3 }],
    }, context);
    const encoded = JSON.stringify(summary);
    expect(summary.mode).toBe("lifecycle-only");
    expect(summary.proofScope).toMatchObject({ automationApi: true, protectedHttp: true, cleanupVerified: true });
    expect(encoded).not.toContain(token);
    expect(encoded).not.toContain(apiBaseUrl);
    expect(encoded).not.toContain(endpoint);
    expect(encoded).not.toContain(proxyAuthority);
    expect(() => assertS05PublicEvidenceRedacted(summary, context)).not.toThrow();
  });

  it("builds a full lease summary with safe failure, Playwright, diagnostics, and profile-store proof", () => {
    const { context, token, leaseId, endpoint, apiBaseUrl, targetUrl, proxyAuthority, appDataRoot } = makeContext();
    const summary = buildS05FinalSummary({
      status: "pass",
      mode: "full",
      packageProof: { buildFresh: true, artifactsChecked: true, artifactCount: 5, preflightStatus: "pass" },
      ui: { profileCreated: true, identityConfigured: true, proxyConfigured: true, copyFlowUsed: true, apiStarted: true },
      api: { started: true, stopped: true, status: "running", statusCode: 200, requestId: "automation-full1" },
      http: {
        health: { statusCode: 200, requestId: "automation-health-full" },
        profiles: { statusCode: 200, requestId: "automation-profiles-full" },
        runtime: { statusCode: 200, requestId: "automation-runtime-full", runningCount: 0 },
      },
      failureMatrix: [
        { caseName: "invalid-ttl", statusCode: 400, errorCode: "INVALID_REQUEST", errorPhase: "lease", requestCorrelated: true, detailRefPresent: true },
        { caseName: "unknown-lease", statusCode: 404, errorCode: "AUTOMATION_LEASE_NOT_FOUND", errorPhase: "lease", requestCorrelated: true, detailRefPresent: true },
      ],
      leaseFlow: {
        create: { statusCode: 201, leaseStatus: "active", requestId: "automation-create-full", runtimeStatus: "running", runningCount: 1, ttlSeconds: 30 },
        active: { statusCode: 200, leaseStatus: "active", requestId: "automation-active-full", ttlSeconds: 30 },
        release: { statusCode: 200, leaseStatus: "released", requestId: "automation-release-full", runtimeStatus: "stopped", runningCount: 0 },
        releasedReuse: { statusCode: 409, errorCode: "AUTOMATION_LEASE_RELEASED", errorPhase: "lease", requestCorrelated: true, detailRefPresent: true },
        revocation: { status: "pass" },
        expiry: { statusCode: 200, leaseStatus: "expired", requestId: "automation-expiry-full", runningCount: 0, ttlSeconds: 1 },
        expiredReuse: { statusCode: 409, errorCode: "AUTOMATION_LEASE_EXPIRED", errorPhase: "lease", requestCorrelated: true, detailRefPresent: true },
        expiredRevocation: { status: "pass" },
      },
      playwright: { attached: true, navigated: true, targetMarker: true, identityMatches: 8, proxyObservationCount: 2 },
      profileStore: { storeVersion: 4, profileCount: 1, identity: { presetId: "ubuntu-linux-chrome-120" }, proxy: { credentialState: "configured" }, persistedRuntimeFields: 0 },
      diagnostics: { requiredMethods: ["profiles.create", "chromium.launch"], leaseFailureMethods: S05_REQUIRED_DIAGNOSTIC_FAILURE_METHODS, typedFailureCount: 5, totalRowsRead: 12, validRows: 12, malformedRows: 0 },
      cleanup: { appStopped: true, apiStopped: true, listenerClosed: true, runtimeStopped: true, fixtureStopped: true, retainedSmokeData: true, diagnosticsScanned: true },
      redaction: { status: "clean", scanned: true, forbiddenMarkerCount: 0 },
      checks: [{ name: "redaction-scan", status: "pass", durationMs: 3 }],
    }, context);
    const encoded = JSON.stringify(summary);
    expect(summary.proofScope).toMatchObject({ playwrightAttach: true, cleanupVerified: true });
    expect(summary.failures).toHaveLength(2);
    expect(summary.profileStore).toMatchObject({ scanned: true, storeVersion: 4, identityPresetApplied: true, proxyConfigured: true });
    expect(summary.diagnostics).toMatchObject({ scanned: true, leaseFailureMethodCount: S05_REQUIRED_DIAGNOSTIC_FAILURE_METHODS.length, typedFailureCount: 5 });
    for (const privateMarker of [token, leaseId, endpoint, apiBaseUrl, targetUrl, proxyAuthority, appDataRoot]) {
      expect(encoded).not.toContain(privateMarker);
    }
    expect(() => assertS05PublicEvidenceRedacted(summary, context)).not.toThrow();
  });

  it("asserts S05 diagnostics include typed Automation API lease failures without leaking paths", () => {
    const root = makeRoot();
    const smokeContext = packagedHarness.createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-10T11:12:13.000Z"),
      nonce: "s05diag",
      profilePrefix: S05_PROFILE_PREFIX,
      baseEnv: {},
    });
    const appDataRoot = join(smokeContext.dataRoot, "theprivator-desktop");
    writeJson(join(appDataRoot, "profile-store", "profiles.json"), {
      storeVersion: 4,
      profiles: [{ id: "profile-s05diag", name: smokeContext.smokeProfileName }],
    });
    const diagnosticsPath = join(appDataRoot, "profile-store", "diagnostics", "events.jsonl");
    const baseRow = {
      schemaVersion: 1,
      ts: "2026-05-10T11:12:13.000Z",
      source: "python-sidecar",
      event: "sidecar.request",
      durationMs: 1,
      logPath: "profile-store/diagnostics/events.jsonl",
    };
    writeDiagnostics(diagnosticsPath, [
      ...S05_REQUIRED_DIAGNOSTIC_SUCCESS_METHODS.map((method, index) => ({ ...baseRow, status: "ok", requestId: `s05-ok-${index}`, method, errorCode: null, detailRef: null })),
      { ...baseRow, status: "error", requestId: "s05-invalid-ttl", method: "automation.leases.create", errorCode: "INVALID_REQUEST", detailRef: "sidecar-invalid-ttl" },
      { ...baseRow, status: "error", requestId: "s05-unknown-profile", method: "automation.leases.create", errorCode: "PROFILE_NOT_FOUND", detailRef: "sidecar-unknown-profile" },
      { ...baseRow, status: "error", requestId: "s05-unknown-lease", method: "automation.leases.status", errorCode: "AUTOMATION_LEASE_NOT_FOUND", detailRef: "sidecar-unknown-lease" },
      { ...baseRow, status: "error", requestId: "s05-released", method: "automation.leases.release", errorCode: "AUTOMATION_LEASE_RELEASED", detailRef: "sidecar-released" },
      { ...baseRow, status: "error", requestId: "s05-expired", method: "automation.leases.release", errorCode: "AUTOMATION_LEASE_EXPIRED", detailRef: "sidecar-expired" },
    ]);

    const context = createS05RedactionContext({ rootDir: root, smokeRoots: [smokeContext.smokeRoot], appDataRoots: [appDataRoot] });
    const proof = assertS05PostSmokeDiagnostics({ rootDir: root, smokeContext, context });

    expect(proof.leaseFailureMethods).toEqual(S05_REQUIRED_DIAGNOSTIC_FAILURE_METHODS);
    expect(proof.typedFailureCount).toBe(5);
    expect(JSON.stringify(proof)).not.toContain(root);

    writeDiagnostics(diagnosticsPath, [
      ...S05_REQUIRED_DIAGNOSTIC_SUCCESS_METHODS.filter((method) => method !== "chromium.status").map((method, index) => ({ ...baseRow, status: "ok", requestId: `s05-ok-missing-${index}`, method, errorCode: null, detailRef: null })),
      { ...baseRow, status: "error", requestId: "s05-invalid-ttl", method: "automation.leases.create", errorCode: "INVALID_REQUEST", detailRef: "sidecar-invalid-ttl" },
      { ...baseRow, status: "error", requestId: "s05-unknown-profile", method: "automation.leases.create", errorCode: "PROFILE_NOT_FOUND", detailRef: "sidecar-unknown-profile" },
      { ...baseRow, status: "error", requestId: "s05-unknown-lease", method: "automation.leases.status", errorCode: "AUTOMATION_LEASE_NOT_FOUND", detailRef: "sidecar-unknown-lease" },
    ]);
    const error = expectSafeFailure(() => assertS05PostSmokeDiagnostics({ rootDir: root, smokeContext, context }), [root, appDataRoot]);
    expect(error.details).toMatchObject({ code: "S05_DIAGNOSTICS_SUCCESS_METHOD_MISSING", expectedMethod: "chromium.status" });
  });
});
