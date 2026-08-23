import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOMATION_AUTH_INVALID,
  AUTOMATION_AUTH_REQUIRED,
  VerifyFailure,
  assertAuthErrorResponse,
  assertPublicEvidenceRedacted,
  assertStatusResponse,
  assertTargetBinary,
  buildFinalSummary,
  createRedactionContext,
  findForbiddenPublicMarker,
  parseReadinessLine,
  redact,
  targetBinaryPath,
} from "./verify-m004-s01.mjs";

const tempRoots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "theprivator-m004-s01-test-"));
  tempRoots.push(root);
  return root;
}

function makeContext() {
  const root = makeRoot();
  return {
    root,
    token: "m004-s01-token-should-not-leak-641f0ee0",
    context: createRedactionContext({
      rootDir: root,
      storeRoot: join(root, "app-data-root-should-not-leak"),
      token: "m004-s01-token-should-not-leak-641f0ee0",
      extraSensitiveValues: ["sidecar-env-value-should-not-leak"],
    }),
  };
}

function authError(code = AUTOMATION_AUTH_REQUIRED) {
  return {
    error: {
      code,
      message: code === AUTOMATION_AUTH_REQUIRED
        ? "Local automation API token is required."
        : "Local automation API token is invalid.",
      details: { phase: "auth" },
      detailRef: "sidecar-123456789abc",
      requestId: "automation-123456789abc",
    },
  };
}

function statusBody(overrides = {}) {
  return {
    status: "running",
    automationApi: { version: "1.0.0" },
    api: { host: "127.0.0.1", port: 43123, scope: "loopback" },
    store: { configured: true },
    startedAt: "2026-05-14T21:00:00.000Z",
    request: { requestId: "automation-123456789abc" },
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

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("verify-m004-s01 helper guardrails", () => {
  it("redacts exact sentinels and sensitive key names from public evidence", () => {
    const { context, token, root } = makeContext();
    const storeRoot = join(root, "app-data-root-should-not-leak");

    const publicValue = redact({
      message: `safe prefix ${token} ${storeRoot} sidecar-env-value-should-not-leak`,
      nested: {
        token,
        Authorization: `Bearer ${token}`,
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/secret",
        storeRoot,
        args: ["automation-api"],
      },
    }, context);

    const text = JSON.stringify(publicValue);
    expect(text).not.toContain(token);
    expect(text).not.toContain(storeRoot);
    expect(text).not.toContain("sidecar-env-value-should-not-leak");
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("ws://");
    expect(text).not.toContain("automation-api");
    expect(text).toContain("<redacted-key:api_value>");
    expect(text).toContain("<redacted-key:auth_header>");
    expect(() => assertPublicEvidenceRedacted(publicValue, context)).not.toThrow();
  });

  it("parses strict safe readiness and rejects malformed readiness without echoing input", () => {
    const { context, token } = makeContext();

    expect(parseReadinessLine('{"host":"127.0.0.1","port":45678,"version":"1.0.0"}', context)).toEqual({
      host: "127.0.0.1",
      port: 45678,
      version: "1.0.0",
    });

    expect(() => parseReadinessLine("{ not json", context)).toThrow(VerifyFailure);

    try {
      parseReadinessLine(JSON.stringify({ host: "127.0.0.1", port: 45678, version: "1.0.0", token }), context);
      throw new Error("expected unsafe readiness to fail");
    } catch (error) {
      const safeError = expectSafeFailure(error, [token]);
      expect(safeError.details.markerClass).toBe("api_value");
      expect(safeError.details.fieldPath).toContain("<redacted-key:api_value>");
    }
  });

  it("validates typed 401 auth envelopes and rejects envelope mismatches", () => {
    const { context } = makeContext();

    expect(assertAuthErrorResponse({
      statusCode: 401,
      body: authError(AUTOMATION_AUTH_REQUIRED),
      expectedCode: AUTOMATION_AUTH_REQUIRED,
      context,
      phase: "auth-missing",
    })).toMatchObject({ statusCode: 401, errorCode: AUTOMATION_AUTH_REQUIRED });

    expect(assertAuthErrorResponse({
      statusCode: 401,
      body: authError(AUTOMATION_AUTH_INVALID),
      expectedCode: AUTOMATION_AUTH_INVALID,
      context,
      phase: "auth-invalid",
    })).toMatchObject({ statusCode: 401, errorCode: AUTOMATION_AUTH_INVALID });

    expect(() => assertAuthErrorResponse({
      statusCode: 200,
      body: authError(AUTOMATION_AUTH_REQUIRED),
      expectedCode: AUTOMATION_AUTH_REQUIRED,
      context,
      phase: "auth-missing",
    })).toThrow(/fail closed/);
  });

  it("rejects unsafe status fields and values before they enter the final summary", () => {
    const { context, token, root } = makeContext();

    expect(assertStatusResponse({
      statusCode: 200,
      body: statusBody(),
      readiness: { host: "127.0.0.1", port: 43123, version: "1.0.0" },
      context,
    })).toMatchObject({ statusCode: 200, storeConfigured: true });

    for (const unsafeBody of [
      statusBody({ debugPort: 9222 }),
      statusBody({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" }),
      statusBody({ storeRoot: join(root, "app-data-root-should-not-leak") }),
      statusBody({ token }),
    ]) {
      expect(() => assertStatusResponse({
        statusCode: 200,
        body: unsafeBody,
        readiness: { host: "127.0.0.1", port: 43123, version: "1.0.0" },
        context,
      })).toThrow(VerifyFailure);
    }
  });

  it("reports forbidden public markers by class and path without raw marker values", () => {
    const { context, token, root } = makeContext();
    const storeRoot = join(root, "app-data-root-should-not-leak");

    const cases = [
      [{ event: "verify.m004.s01", value: token }, "api_value", token],
      [{ event: "verify.m004.s01", header: "Authorization" }, "auth_header", "Authorization"],
      [{ event: "verify.m004.s01", scheme: "Bearer" }, "auth_scheme", "Bearer"],
      [{ event: "verify.m004.s01", root: storeRoot }, "app_root", storeRoot],
      [{ event: "verify.m004.s01", marker: "DevToolsActivePort" }, "debug_endpoint", "DevToolsActivePort"],
      [{ event: "verify.m004.s01", marker: "ws://127.0.0.1:9222/devtools" }, "ws_endpoint", "ws://"],
      [{ event: "verify.m004.s01", credentials: "redacted" }, "cred_field", "credentials"],
      [{ event: "verify.m004.s01", stdoutTail: "redacted" }, "raw_diag", "stdoutTail"],
      [{ event: "verify.m004.s01", env: { safe: false } }, "process_config", "env"],
    ];

    for (const [artifact, markerClass, rawMarker] of cases) {
      const marker = findForbiddenPublicMarker(artifact, context);
      expect(marker).toMatchObject({ markerClass });
      try {
        assertPublicEvidenceRedacted(artifact, context);
        throw new Error("expected redaction assertion to fail");
      } catch (error) {
        const safeError = expectSafeFailure(error, [rawMarker, token, storeRoot]);
        expect(safeError.details.markerClass).toBe(markerClass);
        expect(safeError.details.fieldPath).toMatch(/^\$/);
      }
    }
  });

  it("reports a missing target binary with a build action and no legacy fallback", () => {
    const root = makeRoot();
    const binaryPath = targetBinaryPath({ rootDir: root, targetTriple: "x86_64-test-local" });

    expect(() => assertTargetBinary({ rootDir: root, targetTriple: "x86_64-test-local", binaryPath })).toThrow(/Missing target-triple sidecar binary/);
    try {
      assertTargetBinary({ rootDir: root, targetTriple: "x86_64-test-local", binaryPath });
      throw new Error("expected missing binary to fail");
    } catch (error) {
      const safeError = expectSafeFailure(error, [root]);
      expect(safeError.details.action).toContain("npm run sidecar:build");
      expect(JSON.stringify(safeError.details)).not.toMatch(/legacy/i);
    }
  });

  it("accepts an executable target binary and builds a redacted final summary", () => {
    const { context } = makeContext();
    const root = makeRoot();
    const binaryPath = targetBinaryPath({ rootDir: root, targetTriple: "x86_64-test-local" });
    mkdirSync(dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(binaryPath, 0o755);

    const target = assertTargetBinary({ rootDir: root, targetTriple: "x86_64-test-local", binaryPath });
    expect(target).toMatchObject({ targetTriple: "x86_64-test-local", executableChecked: true });

    const summary = buildFinalSummary({
      status: "pass",
      target,
      readiness: { host: "127.0.0.1", port: 43123, version: "1.0.0" },
      httpChecks: {
        health: { statusCode: 200, requestId: "automation-health" },
        missingAuth: { statusCode: 401, errorCode: AUTOMATION_AUTH_REQUIRED },
        malformedAuth: { statusCode: 401, errorCode: AUTOMATION_AUTH_INVALID },
        invalidAuth: { statusCode: 401, errorCode: AUTOMATION_AUTH_INVALID },
        validAuth: { statusCode: 200, requestId: "automation-status" },
      },
      cleanup: {
        childExit: { requested: true, exitCode: 0, signal: null },
        listenerClosed: true,
        runtimeRootRemoved: true,
      },
      redaction: { status: "clean", scanned: true },
      checks: [],
    });

    expect(() => assertPublicEvidenceRedacted(summary, context)).not.toThrow();
    expect(summary.cleanup).toMatchObject({ listenerClosed: true, runtimeRootRemoved: true });
  });
});
