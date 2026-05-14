import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOMATION_AUTH_INVALID,
  AUTOMATION_AUTH_REQUIRED,
  VerifyFailure,
  targetBinaryPath,
} from "./verify-m004-s01.mjs";
import {
  INVALID_REQUEST,
  PROFILE_API_VERSION,
  PROFILE_NOT_FOUND,
  RUNTIME_API_VERSION,
  assertDomainErrorResponse,
  assertProfilesResponse,
  assertProtectedAuthErrorResponse,
  assertRuntimeStatusResponse,
  assertS02PublicEvidenceRedacted,
  assertS02TargetBinary,
  assertSelectedProfileStatusResponse,
  buildFinalSummary,
  createS02RedactionContext,
  findS02ForbiddenPublicMarker,
  parseHttpJsonBody,
} from "./verify-m004-s02.mjs";

const tempRoots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "theprivator-m004-s02-test-"));
  tempRoots.push(root);
  return root;
}

function makeContext() {
  const root = makeRoot();
  const storeRoot = join(root, "app-data-root-should-not-leak");
  const token = "m004-s02-token-should-not-leak-19a24d";
  const fakeChromiumPath = join(storeRoot, "fake-chromium-should-not-leak");
  return {
    root,
    storeRoot,
    token,
    fakeChromiumPath,
    context: createS02RedactionContext({
      rootDir: root,
      storeRoot,
      token,
      extraSensitiveValues: [fakeChromiumPath, "proxy-password-should-not-leak"],
    }),
  };
}

function request(requestId = "automation-123456789abc") {
  return { requestId };
}

function headers(requestId = "automation-123456789abc") {
  return requestId;
}

function directProfile(id = "profile-direct") {
  return {
    id,
    name: "Direct Profile",
    createdAt: "2026-05-14T20:00:00.000Z",
    updatedAt: "2026-05-14T20:00:00.000Z",
    defaults: {
      browser: "chromium",
      startUrl: "about:blank",
      proxyMode: "direct",
      fingerprintMode: "disabled",
    },
    identity: {
      identityVersion: 1,
      presetId: "real-browser-default",
      label: "Real Browser Default",
      userAgent: null,
      acceptLanguage: null,
      locale: null,
      timezone: null,
      platform: null,
      hardwareConcurrency: null,
      deviceMemory: null,
      screen: null,
      webRtcPolicy: "default",
    },
    proxy: {
      proxyVersion: 1,
      mode: "direct",
      summary: "Direct connection",
    },
  };
}

function fixedProfile(id = "profile-fixed") {
  return {
    ...directProfile(id),
    name: "Fixed Proxy Profile",
    defaults: {
      browser: "chromium",
      startUrl: "about:blank",
      proxyMode: "fixedServer",
      fingerprintMode: "disabled",
    },
    proxy: {
      proxyVersion: 1,
      mode: "fixedServer",
      protocol: "http",
      host: "proxy.example.invalid",
      port: 8080,
      summary: "http://proxy.example.invalid:8080",
    },
  };
}

function profilesBody(profiles = [directProfile(), fixedProfile()], requestId = "automation-123456789abc") {
  return {
    profileApiVersion: PROFILE_API_VERSION,
    profiles,
    count: profiles.length,
    limit: 10,
    nextCursor: null,
    request: request(requestId),
  };
}

function runtimeBody(overrides = {}, requestId = "automation-123456789abc") {
  return {
    runtimeApiVersion: RUNTIME_API_VERSION,
    runningCount: 1,
    profiles: [
      {
        profileId: "profile-fixed",
        status: "running",
        startedAt: "2026-05-14T20:01:00.000Z",
      },
    ],
    reconciled: [],
    request: request(requestId),
    ...overrides,
  };
}

function selectedStatusBody(overrides = {}, requestId = "automation-123456789abc") {
  return {
    profileApiVersion: PROFILE_API_VERSION,
    runtimeApiVersion: RUNTIME_API_VERSION,
    profile: fixedProfile("profile-fixed"),
    runtime: {
      profileId: "profile-fixed",
      status: "running",
      startedAt: "2026-05-14T20:01:00.000Z",
    },
    request: request(requestId),
    ...overrides,
  };
}

function authError(code = AUTOMATION_AUTH_REQUIRED, requestId = "automation-123456789abc") {
  return {
    error: {
      code,
      message: code === AUTOMATION_AUTH_REQUIRED
        ? "Local automation API token is required."
        : "Local automation API token is invalid.",
      details: { phase: "auth" },
      detailRef: "sidecar-123456789abc",
      requestId,
    },
  };
}

function domainError(code, phase, requestId = "automation-123456789abc") {
  return {
    error: {
      code,
      message: "Typed domain failure.",
      details: { phase },
      detailRef: "sidecar-123456789abc",
      requestId,
    },
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

describe("verify-m004-s02 validator guardrails", () => {
  it("accepts safe profile list payloads including empty and fixed-proxy pages", () => {
    const { context } = makeContext();

    expect(assertProfilesResponse({
      statusCode: 200,
      body: profilesBody([], "automation-empty-page"),
      requestId: headers("automation-empty-page"),
      context,
      phase: "profiles-empty",
    })).toMatchObject({ count: 0, profileIds: [] });

    expect(assertProfilesResponse({
      statusCode: 200,
      body: profilesBody([directProfile("profile-a"), fixedProfile("profile-b")], "automation-populated"),
      requestId: headers("automation-populated"),
      expectedProfileIds: ["profile-a", "profile-b"],
      context,
      phase: "profiles-populated",
    })).toMatchObject({
      count: 2,
      profileIds: ["profile-a", "profile-b"],
      proxyModes: ["direct", "fixedServer"],
    });
  });

  it("rejects unsafe profile response fixtures without leaking forbidden marker names in details", () => {
    const { context, storeRoot, token } = makeContext();
    const unsafeProfiles = [
      profilesBody([{ ...directProfile(), credentialState: "configured" }]),
      profilesBody([{ ...directProfile(), storage: { userDataDir: "profile-store/profiles/profile-a/user-data" } }]),
      profilesBody([{ ...directProfile(), profileDir: storeRoot }]),
      profilesBody([{ ...fixedProfile(), proxy: { ...fixedProfile().proxy, credentialState: "configured" } }]),
      profilesBody([{ ...directProfile(), token }]),
    ];

    for (const body of unsafeProfiles) {
      const error = expectThrowsSafely(() => assertProfilesResponse({ statusCode: 200, body, requestId: headers(), context }), [storeRoot, token, "credentialState", "userDataDir", "profileDir"]);
      expect(error.details.fieldPath).toMatch(/^\$/);
    }
  });

  it("accepts safe runtime and selected-profile status payloads", () => {
    const { context } = makeContext();

    expect(assertRuntimeStatusResponse({
      statusCode: 200,
      body: runtimeBody({}, "automation-runtime"),
      requestId: headers("automation-runtime"),
      expectedRunningProfileIds: ["profile-fixed"],
      context,
    })).toMatchObject({ runningCount: 1, runningProfileIds: ["profile-fixed"] });

    expect(assertRuntimeStatusResponse({
      statusCode: 200,
      body: runtimeBody({ runningCount: 0, profiles: [], reconciled: [] }, "automation-runtime-empty"),
      requestId: headers("automation-runtime-empty"),
      context,
    })).toMatchObject({ runningCount: 0, runningProfileIds: [] });

    expect(assertSelectedProfileStatusResponse({
      statusCode: 200,
      body: selectedStatusBody({}, "automation-selected"),
      requestId: headers("automation-selected"),
      expectedProfileId: "profile-fixed",
      expectedRuntimeStatus: "running",
      context,
    })).toMatchObject({ profileId: "profile-fixed", runtimeStatus: "running" });

    expect(assertSelectedProfileStatusResponse({
      statusCode: 200,
      body: selectedStatusBody({ runtime: { profileId: "profile-fixed", status: "stopped" } }, "automation-selected-stopped"),
      requestId: headers("automation-selected-stopped"),
      expectedProfileId: "profile-fixed",
      expectedRuntimeStatus: "stopped",
      context,
    })).toMatchObject({ profileId: "profile-fixed", runtimeStatus: "stopped" });
  });

  it("rejects unsafe runtime and selected-profile fixtures", () => {
    const { context, storeRoot, fakeChromiumPath } = makeContext();
    const unsafeBodies = [
      runtimeBody({ profiles: [{ profileId: "profile-fixed", status: "running", startedAt: "2026-05-14T20:01:00.000Z", pid: 424242 }] }),
      runtimeBody({ profiles: [{ profileId: "profile-fixed", status: "running", startedAt: "2026-05-14T20:01:00.000Z", userDataDir: "profile-store/profiles/profile-fixed/user-data" }] }),
      runtimeBody({ debugPort: 9222 }),
      runtimeBody({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/secret" }),
      selectedStatusBody({ runtime: { profileId: "profile-fixed", status: "running", startedAt: "2026-05-14T20:01:00.000Z", ownerToken: "owner-token-should-not-leak" } }),
      selectedStatusBody({ profile: { ...fixedProfile(), profileDir: storeRoot } }),
      selectedStatusBody({ runtime: { profileId: "profile-fixed", status: "running", startedAt: "2026-05-14T20:01:00.000Z", executable: fakeChromiumPath } }),
    ];

    for (const body of unsafeBodies.slice(0, 4)) {
      expectThrowsSafely(() => assertRuntimeStatusResponse({ statusCode: 200, body, requestId: headers(), context }), [storeRoot, fakeChromiumPath, "pid", "userDataDir", "debugPort", "webSocketDebuggerUrl"]);
    }
    for (const body of unsafeBodies.slice(4)) {
      expectThrowsSafely(() => assertSelectedProfileStatusResponse({ statusCode: 200, body, requestId: headers(), expectedProfileId: "profile-fixed", context }), [storeRoot, fakeChromiumPath, "ownerToken", "profileDir"]);
    }
  });

  it("validates auth and typed domain error envelopes with header/body request identity", () => {
    const { context } = makeContext();

    expect(assertProtectedAuthErrorResponse({
      statusCode: 401,
      body: authError(AUTOMATION_AUTH_REQUIRED, "automation-auth-missing"),
      requestId: "automation-auth-missing",
      expectedCode: AUTOMATION_AUTH_REQUIRED,
      context,
      phase: "auth-missing",
    })).toMatchObject({ statusCode: 401, errorCode: AUTOMATION_AUTH_REQUIRED });

    expect(assertProtectedAuthErrorResponse({
      statusCode: 401,
      body: authError(AUTOMATION_AUTH_INVALID, "automation-auth-invalid"),
      requestId: "automation-auth-invalid",
      expectedCode: AUTOMATION_AUTH_INVALID,
      context,
      phase: "auth-invalid",
    })).toMatchObject({ statusCode: 401, errorCode: AUTOMATION_AUTH_INVALID });

    expect(assertDomainErrorResponse({
      statusCode: 400,
      body: domainError(INVALID_REQUEST, "profile", "automation-profile-error"),
      requestId: "automation-profile-error",
      expectedCode: INVALID_REQUEST,
      expectedStatusCode: 400,
      expectedPhase: "profile",
      context,
      phase: "profiles-invalid-pagination",
    })).toMatchObject({ statusCode: 400, errorCode: INVALID_REQUEST, errorPhase: "profile" });

    expect(assertDomainErrorResponse({
      statusCode: 404,
      body: domainError(PROFILE_NOT_FOUND, "profile", "automation-missing-profile"),
      requestId: "automation-missing-profile",
      expectedCode: PROFILE_NOT_FOUND,
      expectedStatusCode: 404,
      expectedPhase: "profile",
      context,
      phase: "selected-profile-unknown",
    })).toMatchObject({ statusCode: 404, errorCode: PROFILE_NOT_FOUND, errorPhase: "profile" });

    expect(() => assertDomainErrorResponse({
      statusCode: 400,
      body: domainError(INVALID_REQUEST, "profile", "automation-profile-error"),
      requestId: "automation-different",
      expectedCode: INVALID_REQUEST,
      expectedStatusCode: 400,
      expectedPhase: "profile",
      context,
      phase: "profiles-invalid-pagination",
    })).toThrow(/X-Request-ID/);
  });

  it("rejects malformed HTTP JSON without echoing raw bodies", () => {
    const { context, token } = makeContext();

    const error = expectThrowsSafely(() => parseHttpJsonBody({
      text: `{not-json ${token} stdout stderr profile-store`,
      statusCode: 503,
      phase: "malformed-json",
      context,
    }), [token, "{not-json", "stdout", "stderr", "profile-store"]);

    expect(error.details).toMatchObject({ phase: "malformed-json", statusCode: 503 });
    expect(error.details.bodyLength).toBeGreaterThan(0);
  });
});

describe("verify-m004-s02 redaction and binary discovery", () => {
  it("reports S02 forbidden markers by class and redacted path", () => {
    const { context, token, storeRoot, fakeChromiumPath } = makeContext();
    const cases = [
      [{ event: "verify.m004.s02", value: token }, "api_value", token],
      [{ event: "verify.m004.s02", value: storeRoot }, "app_root", storeRoot],
      [{ event: "verify.m004.s02", value: fakeChromiumPath }, "extra_value", fakeChromiumPath],
      [{ event: "verify.m004.s02", credentialState: "configured" }, "cred_field", "credentialState"],
      [{ event: "verify.m004.s02", userDataDir: "profile-store/profiles/profile-a/user-data" }, "app_root", "userDataDir"],
      [{ event: "verify.m004.s02", profileDir: "/tmp/profile-dir" }, "app_root", "profileDir"],
      [{ event: "verify.m004.s02", debugPort: 9222 }, "debug_endpoint", "debugPort"],
      [{ event: "verify.m004.s02", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools" }, "debug_endpoint", "webSocketDebuggerUrl"],
      [{ event: "verify.m004.s02", stdoutTail: "redacted" }, "raw_diag", "stdoutTail"],
      [{ event: "verify.m004.s02", rawBody: "redacted" }, "raw_diag", "rawBody"],
    ];

    for (const [artifact, markerClass, rawMarker] of cases) {
      const marker = findS02ForbiddenPublicMarker(artifact, context);
      expect(marker).toMatchObject({ markerClass });
      const error = expectThrowsSafely(() => assertS02PublicEvidenceRedacted(artifact, context), [rawMarker, token, storeRoot, fakeChromiumPath]);
      expect(error.details.markerClass).toBe(markerClass);
      expect(error.details.fieldPath).toMatch(/^\$/);
    }
  });

  it("reports a missing S02 target binary with sidecar build action and no legacy fallback", () => {
    const root = makeRoot();
    const binaryPath = targetBinaryPath({ rootDir: root, targetTriple: "x86_64-test-local" });

    expect(() => assertS02TargetBinary({ rootDir: root, targetTriple: "x86_64-test-local", binaryPath })).toThrow(/Missing target-triple sidecar binary/);
    try {
      assertS02TargetBinary({ rootDir: root, targetTriple: "x86_64-test-local", binaryPath });
      throw new Error("expected missing binary to fail");
    } catch (error) {
      const safeError = expectSafeFailure(error, [root]);
      expect(safeError.details.action).toContain("npm run sidecar:build");
      expect(JSON.stringify(safeError.details)).not.toMatch(/legacy/i);
    }
  });

  it("accepts an executable target binary and builds a redacted final summary", () => {
    const { context, storeRoot, token } = makeContext();
    const root = makeRoot();
    const binaryPath = targetBinaryPath({ rootDir: root, targetTriple: "x86_64-test-local" });
    mkdirSync(dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(binaryPath, 0o755);

    const target = assertS02TargetBinary({ rootDir: root, targetTriple: "x86_64-test-local", binaryPath });
    expect(target).toMatchObject({ targetTriple: "x86_64-test-local", executableChecked: true });

    const summary = buildFinalSummary({
      status: "pass",
      target,
      readiness: { host: "127.0.0.1", port: 43123, version: "1.0.0" },
      setup: {
        profileIds: ["profile-direct", "profile-fixed"],
        proxyProfileId: "profile-fixed",
        launchedProfileId: "profile-fixed",
      },
      httpChecks: {
        health: { statusCode: 200, requestId: "automation-health" },
        auth: [{ endpoint: "profiles", mode: "missing", statusCode: 401, errorCode: AUTOMATION_AUTH_REQUIRED }],
        profiles: { statusCode: 200, count: 2, profileIds: ["profile-direct", "profile-fixed"] },
        selectedProfileStatus: { statusCode: 200, profileId: "profile-fixed", runtimeStatus: "running" },
        runtimeStatus: { statusCode: 200, runningCount: 1, runningProfileIds: ["profile-fixed"] },
      },
      cleanup: {
        runtimeStop: { requested: true, stopped: true, profileIds: ["profile-fixed"], runningCount: 0 },
        childExit: { requested: true, exitCode: 0, signal: null },
        listenerClosed: true,
        runtimeRootRemoved: true,
      },
      redaction: { status: "clean", scanned: true },
      checks: [],
    });

    expect(() => assertS02PublicEvidenceRedacted(summary, context)).not.toThrow();
    const encoded = JSON.stringify(summary);
    expect(encoded).not.toContain(storeRoot);
    expect(encoded).not.toContain(token);
    expect(summary.setup.profileCount).toBe(2);
    expect(summary.cleanup).toMatchObject({ listenerClosed: true, runtimeRootRemoved: true });
  });
});
