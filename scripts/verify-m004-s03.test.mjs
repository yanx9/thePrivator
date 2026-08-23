import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VerifyFailure } from "./verify-m004-s01.mjs";
import {
  AUTOMATION_LEASE_NOT_FOUND,
  LEASE_API_VERSION,
  assertLeaseCreateResponse,
  assertLeaseReleaseResponse,
  assertLeaseStatusResponse,
  assertNoForbiddenLeaseSurface,
  assertPlaywrightHandoffShape,
  assertS03PublicEvidenceRedacted,
  buildFinalSummary,
  createS03RedactionContext,
  findForbiddenLeaseSurfaceMarker,
  findS03ForbiddenPublicMarker,
} from "./verify-m004-s03.mjs";

const tempRoots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "theprivator-m004-s03-test-"));
  tempRoots.push(root);
  return root;
}

function makeContext() {
  const root = makeRoot();
  const storeRoot = join(root, "app-data-root-should-not-leak");
  const token = "m004-s03-token-should-not-leak-a6f1";
  const leaseId = "lease_s03ShouldNotLeak123456";
  const endpoint = "http://127.0.0.1:45678";
  return {
    root,
    storeRoot,
    token,
    leaseId,
    endpoint,
    context: createS03RedactionContext({
      rootDir: root,
      storeRoot,
      token,
      leaseIds: [leaseId],
      handoffEndpoints: [endpoint],
      extraSensitiveValues: ["proxy-password-should-not-leak", join(storeRoot, "profile-store/profiles/profile-a/user-data")],
    }),
  };
}

function request(requestId = "automation-123456789abc") {
  return { requestId };
}

function headers(requestId = "automation-123456789abc") {
  return requestId;
}

function leaseRecord(overrides = {}) {
  return {
    id: "lease_s03ShouldNotLeak123456",
    profileId: "profile-s03",
    framework: "playwright",
    status: "active",
    createdAt: "2026-05-14T20:00:00.000Z",
    expiresAt: "2026-05-14T20:00:30.000Z",
    ttlSeconds: 30,
    ...overrides,
  };
}

function runningRuntime() {
  return {
    runtimeApiVersion: 1,
    runningCount: 1,
    profile: {
      profileId: "profile-s03",
      status: "running",
      startedAt: "2026-05-14T20:00:01.000Z",
    },
  };
}

function stoppedRuntime() {
  return {
    runtimeApiVersion: 1,
    runningCount: 0,
    profile: {
      profileId: "profile-s03",
      status: "stopped",
      stoppedAt: "2026-05-14T20:00:02.000Z",
      termination: "graceful",
    },
  };
}

function createBody(overrides = {}) {
  return {
    leaseApiVersion: LEASE_API_VERSION,
    lease: leaseRecord(),
    handoff: {
      browser: "chromium",
      method: "connect-over-cdp",
      endpoint: "http://127.0.0.1:45678",
    },
    runtime: runningRuntime(),
    request: request(),
    ...overrides,
  };
}

function statusBody(status = "active", overrides = {}) {
  const lease = status === "active"
    ? leaseRecord({ status })
    : leaseRecord({
        status,
        ...(status === "released"
          ? { releasedAt: "2026-05-14T20:00:02.000Z", cleanedUpAt: "2026-05-14T20:00:02.000Z" }
          : { expiredAt: "2026-05-14T20:00:02.000Z", cleanedUpAt: "2026-05-14T20:00:02.000Z" }),
      });
  return {
    leaseApiVersion: LEASE_API_VERSION,
    lease,
    ...(status === "active" ? {} : { runtime: stoppedRuntime() }),
    request: request(),
    ...overrides,
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

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("verify-m004-s03 lease response validators", () => {
  it("accepts a private one-time Playwright handoff while returning only safe public summary", () => {
    const { context, leaseId, endpoint } = makeContext();

    expect(assertPlaywrightHandoffShape(createBody().handoff)).toMatchObject({
      browser: "chromium",
      method: "connect-over-cdp",
      port: 45678,
      endpoint,
    });

    const result = assertLeaseCreateResponse({
      statusCode: 201,
      body: createBody(),
      requestId: headers(),
      location: `/v1/leases/${leaseId}`,
      expectedProfileId: "profile-s03",
      expectedTtlSeconds: 30,
    });

    expect(result.private).toEqual({ leaseId, handoffEndpoint: endpoint });
    expect(JSON.stringify(result.public)).not.toContain(leaseId);
    expect(JSON.stringify(result.public)).not.toContain(endpoint);
    expect(() => assertNoForbiddenLeaseSurface({ lease: result.public, request: request() }, context)).not.toThrow();
  });

  it("rejects malformed lease create fixtures before attach", () => {
    const { endpoint, leaseId } = makeContext();
    const badBodies = [
      createBody({ lease: leaseRecord({ id: "not-a-lease" }) }),
      createBody({ lease: leaseRecord({ ttlSeconds: "30" }) }),
      createBody({ lease: leaseRecord({ status: "pending" }) }),
      createBody({ handoff: { browser: "chromium", method: "connect-over-cdp", endpoint: "https://127.0.0.1:45678" } }),
      createBody({ handoff: { browser: "chromium", method: "connect-over-cdp", endpoint: "http://localhost:45678" } }),
      createBody({ handoff: { browser: "chromium", method: "connect-over-cdp", endpoint: "ws://127.0.0.1:45678/devtools/browser/raw" } }),
      createBody({ request: {} }),
    ];

    for (const body of badBodies) {
      expectThrowsSafely(() => assertLeaseCreateResponse({
        statusCode: 201,
        body,
        requestId: headers(),
        location: `/v1/leases/${leaseId}`,
        expectedProfileId: "profile-s03",
        expectedTtlSeconds: 30,
      }), [endpoint, leaseId, "ws://"]);
    }
  });

  it("accepts active, released, and expired safe status surfaces", () => {
    const { context } = makeContext();

    expect(assertLeaseStatusResponse({
      statusCode: 200,
      body: statusBody("active"),
      requestId: headers(),
      expectedProfileId: "profile-s03",
      expectedStatus: "active",
      expectedTtlSeconds: 30,
      context,
    })).toMatchObject({ leaseStatus: "active", runtimeStatus: null });

    expect(assertLeaseReleaseResponse({
      statusCode: 200,
      body: statusBody("released"),
      requestId: headers(),
      expectedProfileId: "profile-s03",
      expectedTtlSeconds: 30,
      context,
    })).toMatchObject({ leaseStatus: "released", runtimeStatus: "stopped", runningCount: 0 });

    expect(assertLeaseStatusResponse({
      statusCode: 200,
      body: statusBody("expired"),
      requestId: headers(),
      expectedProfileId: "profile-s03",
      expectedStatus: "expired",
      expectedTtlSeconds: 30,
      context,
    })).toMatchObject({ leaseStatus: "expired", runtimeStatus: "stopped", runningCount: 0 });
  });

  it("rejects forbidden handoff, debug, path, credential, token, and raw diagnostic material in status surfaces", () => {
    const { context, endpoint, storeRoot, token } = makeContext();
    const unsafeBodies = [
      statusBody("active", { handoff: { endpoint } }),
      statusBody("released", { runtime: { ...stoppedRuntime(), webSocketDebuggerUrl: "ws://127.0.0.1:45678/devtools/browser/raw" } }),
      statusBody("released", { runtime: { ...stoppedRuntime(), debugPort: 45678 } }),
      statusBody("released", { runtime: { ...stoppedRuntime(), profile: { ...stoppedRuntime().profile, userDataDir: "profile-store/profiles/profile-s03/user-data" } } }),
      statusBody("released", { runtime: { ...stoppedRuntime(), credentials: "configured" } }),
      statusBody("released", { runtime: { ...stoppedRuntime(), token } }),
      statusBody("released", { runtime: { ...stoppedRuntime(), storeRoot } }),
      statusBody("released", { runtime: { ...stoppedRuntime(), stdoutTail: "raw child output" } }),
    ];

    for (const body of unsafeBodies) {
      const error = expectThrowsSafely(() => assertLeaseStatusResponse({
        statusCode: 200,
        body,
        requestId: headers(),
        expectedProfileId: "profile-s03",
        expectedStatus: body.lease.status,
        expectedTtlSeconds: 30,
        context,
      }), [endpoint, storeRoot, token, "ws://", "userDataDir", "stdoutTail"]);
      expect(error.details.fieldPath ?? JSON.stringify(error.details.actualKeys ?? [])).toMatch(/\$|redacted-key|handoff|debug|raw|token|store/i);
    }
  });
});

describe("verify-m004-s03 public evidence redaction", () => {
  it("reports lease authority and forbidden operational markers by class without raw values", () => {
    const { context, leaseId, endpoint, storeRoot, token } = makeContext();
    const cases = [
      [{ event: "verify.m004.s03", value: token }, "api_value", token],
      [{ event: "verify.m004.s03", value: storeRoot }, "app_root", storeRoot],
      [{ event: "verify.m004.s03", value: leaseId }, "lease_id", leaseId],
      [{ event: "verify.m004.s03", value: endpoint }, "lease_endpoint", endpoint],
      [{ event: "verify.m004.s03", value: "lease_unregisteredShouldNotLeak" }, "lease_id", "lease_unregisteredShouldNotLeak"],
      [{ event: "verify.m004.s03", webSocketDebuggerUrl: "ws://127.0.0.1:45678/devtools" }, "debug_endpoint", "webSocketDebuggerUrl"],
      [{ event: "verify.m004.s03", debugPort: 45678 }, "debug_endpoint", "debugPort"],
      [{ event: "verify.m004.s03", credentials: "configured" }, "cred_field", "credentials"],
      [{ event: "verify.m004.s03", userDataDir: "profile-store/profiles/profile-s03/user-data" }, "app_root", "userDataDir"],
      [{ event: "verify.m004.s03", stdoutTail: "redacted" }, "raw_diag", "stdoutTail"],
      [{ event: "verify.m004.s03", rawDiagnostics: "redacted" }, "raw_diag", "rawDiagnostics"],
    ];

    for (const [artifact, markerClass, rawMarker] of cases) {
      const marker = findS03ForbiddenPublicMarker(artifact, context);
      expect(marker).toMatchObject({ markerClass });
      const error = expectThrowsSafely(() => assertS03PublicEvidenceRedacted(artifact, context), [rawMarker, token, storeRoot, leaseId, endpoint]);
      expect(error.details.markerClass).toBe(markerClass);
      expect(error.details.fieldPath).toMatch(/^\$/);
    }
  });

  it("distinguishes protected API status bodies from public verifier evidence", () => {
    const { context, leaseId, endpoint } = makeContext();
    const protectedStatus = statusBody("active");

    expect(findForbiddenLeaseSurfaceMarker(protectedStatus, context)).toBeNull();
    expect(() => assertNoForbiddenLeaseSurface(protectedStatus, context)).not.toThrow();
    expect(findS03ForbiddenPublicMarker({ event: "verify.m004.s03", protectedStatus }, context)).toMatchObject({ markerClass: "lease_id" });

    const unsafeProtectedStatus = statusBody("active", { handoff: { endpoint } });
    expect(findForbiddenLeaseSurfaceMarker(unsafeProtectedStatus, context)).toMatchObject({ markerClass: "handoff_field" });
    expect(JSON.stringify(protectedStatus)).toContain(leaseId);
  });

  it("builds a clean final summary without raw lease identifiers or CDP origins", () => {
    const { context, leaseId, endpoint, storeRoot, token } = makeContext();
    const summary = buildFinalSummary({
      status: "pass",
      target: {
        binary: "src-tauri/binaries/theprivator-sidecar-x86_64-test-local",
        targetTriple: "x86_64-test-local",
        executableChecked: true,
      },
      readiness: { host: "127.0.0.1", port: 43123, version: "1.0.0" },
      setup: { profileId: "profile-s03" },
      httpChecks: {
        health: { statusCode: 200, requestId: "automation-health" },
        auth: [{ mode: "missing", statusCode: 401, errorCode: "AUTOMATION_AUTH_REQUIRED" }],
        unknownLease: { statusCode: 404, errorCode: AUTOMATION_LEASE_NOT_FOUND },
      },
      leaseFlow: {
        create: { leaseStatus: "active", ttlSeconds: 30, runtimeStatus: "running", attachAuthority: "private-on-create-only" },
        playwright: { attached: true, action: "data-url-title-and-text", titleMatched: true, textMatched: true },
        release: { leaseStatus: "released", runtimeStatus: "stopped", runningCount: 0 },
        expiry: { leaseStatus: "expired", runtimeStatus: "stopped", runningCount: 0 },
        endpointRevocation: { revoked: true, probe: "playwright-attach-probe" },
      },
      cleanup: {
        childExit: { requested: true, exitCode: 0, signal: null },
        listenerClosed: true,
        runtimeRootRemoved: true,
      },
      redaction: { status: "clean", scanned: true },
      checks: [],
    });

    const encoded = JSON.stringify(summary);
    expect(encoded).not.toContain(leaseId);
    expect(encoded).not.toContain(endpoint);
    expect(encoded).not.toContain(storeRoot);
    expect(encoded).not.toContain(token);
    expect(() => assertS03PublicEvidenceRedacted(summary, context)).not.toThrow();
  });
});
