import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VerifyFailure } from "./verify-m004-s01.mjs";
import {
  PRESET_ID,
  PROXY_SOCKS_AUTH_UNSUPPORTED,
  assertS04DomainFailure,
  assertS04PublicEvidenceRedacted,
  buildS04FinalSummary,
  createS04RedactionContext,
  findS04ForbiddenPublicMarker,
} from "./verify-m004-s04.mjs";

const tempRoots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "theprivator-m004-s04-test-"));
  tempRoots.push(root);
  return root;
}

function makeContext() {
  const root = makeRoot();
  const storeRoot = join(root, "app-data-root-should-not-leak");
  const token = "m004-s04-token-should-not-leak-55b9";
  const leaseId = "lease_s04ShouldNotLeak123456";
  const endpoint = "http://127.0.0.1:45678";
  const targetUrl = "http://theprivator-proxy-proof.invalid:18080/theprivator-proxy-proof?case=s04";
  const proxyAuthority = "http://127.0.0.1:19090";
  const proxyUser = "s04-proxy-user-should-not-leak";
  const proxyPassword = "s04-proxy-password-should-not-leak";
  return {
    root,
    storeRoot,
    token,
    leaseId,
    endpoint,
    targetUrl,
    proxyAuthority,
    proxyUser,
    proxyPassword,
    context: createS04RedactionContext({
      rootDir: root,
      storeRoot,
      token,
      leaseIds: [leaseId],
      handoffEndpoints: [endpoint],
      targetUrls: [targetUrl],
      proxyAuthorities: [proxyAuthority],
      extraSensitiveValues: [proxyUser, proxyPassword, join(storeRoot, "profile-store/profiles/profile-a/user-data")],
    }),
  };
}

function errorBody(code, overrides = {}) {
  return {
    error: {
      code,
      message: "Automation lease failure was safely classified.",
      details: { phase: "lease" },
      detailRef: "sidecar-safe-detail-ref",
      requestId: "automation-safe-request-id",
      ...overrides,
    },
  };
}

function response(code, statusCode = 503, overrides = {}) {
  const body = errorBody(code, overrides.error ?? {});
  return {
    statusCode,
    body,
    requestId: body.error.requestId,
    location: null,
  };
}

function expectSafeFailure(error, forbiddenText = []) {
  expect(error).toBeInstanceOf(VerifyFailure);
  const details = JSON.stringify(error.details);
  for (const marker of forbiddenText) {
    expect(details).not.toContain(marker);
  }
  return error;
}

function expectThrowsSafely(callback, forbiddenText = []) {
  try {
    callback();
    throw new Error("expected callback to throw");
  } catch (error) {
    if (error?.message === "expected callback to throw") {
      throw error;
    }
    return expectSafeFailure(error, forbiddenText);
  }
}

function cleanSummary(context) {
  return buildS04FinalSummary({
    status: "pass",
    target: {
      targetTriple: "x86_64-test-local",
      executableChecked: true,
    },
    setup: {
      profileCount: 2,
      identityPresetApplied: true,
      proxyConfigured: true,
      proxyAuth: "configured",
      typedFailureProfile: true,
    },
    httpChecks: {
      health: { statusCode: 200, healthy: true },
      auth: [
        { mode: "missing", statusCode: 401, errorCode: "AUTOMATION_AUTH_REQUIRED" },
        { mode: "invalid", statusCode: 401, errorCode: "AUTOMATION_AUTH_INVALID" },
      ],
    },
    failureMatrix: [
      {
        caseName: "proxy-socks-auth-unsupported",
        statusCode: 503,
        errorCode: PROXY_SOCKS_AUTH_UNSUPPORTED,
        errorPhase: "lease",
        requestCorrelated: true,
        detailRefPresent: true,
      },
      {
        caseName: "released-reuse",
        statusCode: 409,
        errorCode: "AUTOMATION_LEASE_RELEASED",
        errorPhase: "lease",
        requestCorrelated: true,
        detailRefPresent: true,
      },
    ],
    leaseFlow: {
      create: { leaseStatus: "active", ttlSeconds: 30, runtimeStatus: "running", attachAuthority: "private-on-create-only" },
      playwright: { attached: true, navigated: true, targetMarker: true, identityMatches: 6 },
      proxyObservation: { proxyCount: 2, targetCount: 1, authAccepted: true, routeObserved: true },
      activeStatus: { leaseStatus: "active", ttlSeconds: 30, runtimeStatus: null, runningCount: null },
      release: { leaseStatus: "released", runtimeStatus: "stopped", runningCount: 0 },
      releasedReuse: { statusCode: 409, errorCode: "AUTOMATION_LEASE_RELEASED", errorPhase: "lease", requestCorrelated: true, detailRefPresent: true },
      postReleaseRuntime: { runtimeRunningCount: 0, selectedStatus: "stopped" },
      revocation: { revoked: true, probe: "playwright-attach-probe" },
      expiry: { leaseStatus: "expired", runtimeStatus: "stopped", runningCount: 0 },
      expiredReuse: { statusCode: 409, errorCode: "AUTOMATION_LEASE_EXPIRED", errorPhase: "lease", requestCorrelated: true, detailRefPresent: true },
      expiredRevocation: { revoked: true, probe: "playwright-attach-probe" },
    },
    cleanup: {
      apiChildExit: { requested: true, exitCode: 0, signal: null },
      listenerClosed: true,
      proxyFixtureStopped: true,
      runtimeRootRemoved: true,
    },
    redaction: { status: "clean", scanned: true },
    checks: [
      { name: "identity-preset", status: "pass", durationMs: 3, presetSelected: true, presetCount: 4 },
      { name: "redaction-scan", status: "pass", durationMs: 1, scanned: true },
    ],
  }, context);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("verify-m004-s04 failure validators", () => {
  it("accepts typed lease failures with status, phase, request correlation, and no raw detail surface", () => {
    const { context } = makeContext();
    const result = assertS04DomainFailure(response(PROXY_SOCKS_AUTH_UNSUPPORTED), {
      expectedCode: PROXY_SOCKS_AUTH_UNSUPPORTED,
      expectedStatusCode: 503,
      expectedPhase: "lease",
      context,
      phase: "proxy-socks-auth",
      caseName: "proxy-socks-auth-unsupported",
    });

    expect(result).toEqual({
      caseName: "proxy-socks-auth-unsupported",
      statusCode: 503,
      errorCode: PROXY_SOCKS_AUTH_UNSUPPORTED,
      errorPhase: "lease",
      requestCorrelated: true,
      detailRefPresent: true,
    });
    expect(() => assertS04PublicEvidenceRedacted(result, context)).not.toThrow();
  });

  it("rejects wrong status/code fixtures without echoing sensitive context", () => {
    const { context, token, endpoint, storeRoot } = makeContext();
    const error = expectThrowsSafely(() => assertS04DomainFailure(response("INTERNAL_ERROR", 500), {
      expectedCode: PROXY_SOCKS_AUTH_UNSUPPORTED,
      expectedStatusCode: 503,
      expectedPhase: "lease",
      context,
      phase: "proxy-socks-auth",
      caseName: "proxy-socks-auth-unsupported",
    }), [token, endpoint, storeRoot]);

    expect(error.details.expectedStatusCode).toBe(503);
    expect(error.details.actualStatusCode).toBe(500);
  });
});

describe("verify-m004-s04 public evidence redaction", () => {
  it("catches token, credential, proxy switch, direct fallback, CDP, handoff, path, output, and stack markers", () => {
    const {
      context,
      token,
      leaseId,
      endpoint,
      targetUrl,
      proxyAuthority,
      proxyUser,
      proxyPassword,
      storeRoot,
    } = makeContext();
    const cases = [
      [{ Authorization: `Bearer ${token}` }, "auth_header", token],
      [{ value: token }, "api_value", token],
      [{ credentials: { username: proxyUser, password: proxyPassword } }, "cred_field", proxyPassword],
      [{ args: ["--proxy-server=http://user:pass@127.0.0.1:8080"] }, "process_config", "--proxy-server"],
      [{ value: "direct://fallback" }, "direct_fallback", "direct://"],
      [{ value: "--proxy-bypass-list=<-loopback>" }, "proxy_bypass", "--proxy-bypass-list"],
      [{ value: "DevToolsActivePort" }, "debug_endpoint", "DevToolsActivePort"],
      [{ value: "ws://127.0.0.1:9222/devtools/browser/raw" }, "ws_endpoint", "ws://"],
      [{ handoff: { endpoint } }, "lease_endpoint", endpoint],
      [{ leaseId }, "lease_id", leaseId],
      [{ value: targetUrl }, "extra_value", targetUrl],
      [{ value: proxyAuthority }, "extra_value", proxyAuthority],
      [{ value: join(storeRoot, "profile-store/profiles/profile-a/user-data") }, "extra_value", storeRoot],
      [{ stdout: "raw child output" }, "raw_diag", "stdout"],
      [{ stack: "Traceback: sensitive failure" }, "raw_diag", "Traceback"],
    ];

    for (const [artifact, markerClass, rawMarker] of cases) {
      const marker = findS04ForbiddenPublicMarker(artifact, context);
      expect(marker).toMatchObject({ markerClass });
      const error = expectThrowsSafely(() => assertS04PublicEvidenceRedacted(artifact, context), [rawMarker, token, leaseId, endpoint, targetUrl, proxyAuthority, proxyUser, proxyPassword, storeRoot]);
      expect(error.details.markerClass).toBe(markerClass);
      expect(error.details.fieldPath).toMatch(/^\$/);
    }
  });

  it("builds a clean final summary with only safe counts, booleans, statuses, and codes", () => {
    const { context, token, leaseId, endpoint, targetUrl, proxyAuthority, proxyUser, proxyPassword, storeRoot } = makeContext();
    const summary = cleanSummary(context);
    const encoded = JSON.stringify(summary);

    expect(encoded).not.toContain(PRESET_ID);
    expect(encoded).not.toContain(token);
    expect(encoded).not.toContain(leaseId);
    expect(encoded).not.toContain(endpoint);
    expect(encoded).not.toContain(targetUrl);
    expect(encoded).not.toContain(proxyAuthority);
    expect(encoded).not.toContain(proxyUser);
    expect(encoded).not.toContain(proxyPassword);
    expect(encoded).not.toContain(storeRoot);
    expect(encoded).not.toContain("--proxy-server");
    expect(encoded).not.toContain("direct://");
    expect(encoded).not.toContain("DevToolsActivePort");
    expect(encoded).not.toContain("ws://");
    expect(encoded).not.toContain("profile-store");
    expect(() => assertS04PublicEvidenceRedacted(summary, context)).not.toThrow();
  });

  it("fails the final summary scan if unsafe verifier evidence is added later", () => {
    const { context, endpoint } = makeContext();
    const summary = cleanSummary(context);
    summary.checks.push({ name: "unsafe", status: "pass", endpoint });

    const marker = findS04ForbiddenPublicMarker(summary, context);
    expect(marker).toMatchObject({ markerClass: "lease_endpoint" });
    expectThrowsSafely(() => assertS04PublicEvidenceRedacted(summary, context), [endpoint]);
  });
});
