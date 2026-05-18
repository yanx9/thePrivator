#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium as playwrightChromium } from "playwright-core";
import {
  AUTOMATION_AUTH_INVALID,
  AUTOMATION_AUTH_REQUIRED,
  ROOT_DIR,
  VerifyFailure,
  readTargetTriple,
  redactedTail,
  targetBinaryPath,
  waitForListenerClosed,
  waitForReadiness,
} from "./verify-m004-s01.mjs";
import {
  INVALID_REQUEST,
  PROFILE_NOT_FOUND,
  assertDomainErrorResponse,
  assertRuntimeStatusResponse,
  assertS02TargetBinary,
  assertSelectedProfileStatusResponse,
} from "./verify-m004-s02.mjs";
import {
  AUTOMATION_LEASE_EXPIRED,
  AUTOMATION_LEASE_NOT_FOUND,
  AUTOMATION_LEASE_RELEASED,
  assertEndpointRevoked,
  assertHealthWithHeader,
  assertLeaseCreateResponse,
  assertLeaseReleaseResponse,
  assertLeaseStatusResponse,
  assertNoForbiddenLeaseSurface,
  assertS03PublicEvidenceRedacted,
  createS03RedactionContext,
  findS03ForbiddenPublicMarker,
  redactS03,
  removeRuntimeRoot,
  requestJson,
  safeErrorForPublic,
  sidecarSuccess,
  startAutomationApi,
  stopAutomationApi,
  verifyAuthFailures,
  waitForLeaseStatus,
  assertListenerOpen,
} from "./verify-m004-s03.mjs";

export const VERIFY_EVENT = "verify.m004.s04";
export const PRESET_ID = "ubuntu-linux-chrome-120";
export const PROXY_SOCKS_AUTH_UNSUPPORTED = "PROXY_SOCKS_AUTH_UNSUPPORTED";

const VENV_PYTHON = process.platform === "win32"
  ? join(ROOT_DIR, ".venv", "Scripts", "python.exe")
  : join(ROOT_DIR, ".venv", "bin", "python");
const PYTHON = process.env.PYTHON ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : (process.platform === "win32" ? "python" : "python3"));
const READINESS_TIMEOUT_MS = 10_000;
const HTTP_TIMEOUT_MS = 5_000;
const PLAYWRIGHT_TIMEOUT_MS = 20_000;
const NAVIGATION_TIMEOUT_MS = 15_000;
const PROXY_OBSERVATION_TIMEOUT_MS = 5_000;
const FIXTURE_READY_TIMEOUT_MS = 8_000;
const FIXTURE_COMMAND_TIMEOUT_MS = 5_000;
const FIXTURE_EXIT_TIMEOUT_MS = 2_000;
const EXPIRY_WAIT_TIMEOUT_MS = 15_000;
const TARGET_HOST = "theprivator-proxy-proof.invalid";
const TARGET_PATH = "/theprivator-proxy-proof";
const PROXY_USERNAME = "proxy-m004-s04-user-sentinel";
const PROXY_PASSWORD = "proxy-m004-s04-password-sentinel";
const REDACTED_VALUE = "<redacted>";
const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];

const S04_FORBIDDEN_TEXT_PATTERNS = Object.freeze([
  { markerClass: "auth_header", pattern: /\bAuthorization\b/i },
  { markerClass: "auth_scheme", pattern: /\bBearer\b/i },
  { markerClass: "proxy_switch", pattern: /--proxy-server\b/i },
  { markerClass: "proxy_bypass", pattern: /--proxy-bypass-list\b/i },
  { markerClass: "direct_fallback", pattern: /direct:\/\//i },
  { markerClass: "handoff_field", pattern: /\b(?:handoff|connect-over-cdp|browserWSEndpoint|webSocketDebuggerUrl|wsEndpoint)\b/i },
  { markerClass: "debug_endpoint", pattern: /\b(?:DevToolsActivePort|debugPort|remote-debugging|--remote-debugging-port|cdp:\/\/)\b/i },
  { markerClass: "ws_endpoint", pattern: /wss?:\/\/[^\s"']+/i },
  { markerClass: "profile_private_path", pattern: /\b(?:profile-store|profiles\.json|user-data)\b/i },
  { markerClass: "raw_diag", pattern: /\b(?:stdout|stderr|raw diagnostics?|rawDiagnostics?|Traceback|stack trace|traceback)\b/i },
]);

const S04_FORBIDDEN_KEY_PATTERN = /^(?:authorization|bearer|token|credentials?|username|password|proxyAuthorization|proxyServer|proxyBypass|leaseId|leaseEndpoint|handoff|handoffEndpoint|endpoint|browserWSEndpoint|webSocketDebuggerUrl|wsEndpoint|debugPort|remoteDebuggingPort|stdout|stderr|rawDiagnostics?|rawBody|rawPayload|stack|traceback|argv|args|env|storeRoot|appDataRoot|userDataDir|profileDir)$/i;

const PROXY_FIXTURE_MANAGER = String.raw`
import json
import sys
from urllib.parse import quote, urlunsplit

from theprivator_sidecar.proxy_proof import (
    DEFAULT_PROOF_TARGET_PORT,
    HttpsProxyFixture,
    PROXY_PROOF_PATH,
    ProxyProofTargetServer,
    create_proxy_fixture,
)


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True), flush=True)


def credentials(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("credentials must be an object")
    username = value.get("username")
    password = value.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        raise ValueError("credentials must be strings")
    return (username, password)


def target_url(host, port, path, label):
    netloc = host if port == 80 else f"{host}:{port}"
    return urlunsplit(("http", netloc, path, f"case={quote(label, safe='')}", ""))


try:
    raw_config = sys.stdin.readline()
    if not raw_config:
        raise ValueError("missing fixture config")
    config = json.loads(raw_config)
    kind = str(config.get("kind", "")).lower()
    label = str(config.get("label", "proxy-proof"))[:96]
    target_host = str(config.get("targetHost") or "theprivator-proxy-proof.invalid").lower()
    target_port = int(config.get("targetPort") or DEFAULT_PROOF_TARGET_PORT)
    target_path = str(config.get("targetPath") or PROXY_PROOF_PATH)
    fixture_target_host = str(config.get("fixtureTargetHost") or target_host).lower()
    fixture_credentials = credentials(config.get("fixtureCredentials"))

    with ProxyProofTargetServer() as target:
        fixture = create_proxy_fixture(
            kind,
            target_host=fixture_target_host,
            target_port=target_port,
            target_address=target.local_address,
            credentials=fixture_credentials,
        )
        with fixture:
            proxy = {
                "proxyVersion": 1,
                "mode": "fixedServer",
                "protocol": kind,
                "host": fixture.local_host,
                "port": fixture.local_port,
            }
            ready = {
                "ok": True,
                "label": label,
                "fixtureKind": kind,
                "proxy": proxy,
                "target": {
                    "host": target_host,
                    "port": target_port,
                    "path": target_path,
                    "url": target_url(target_host, target_port, target_path, label),
                },
            }
            if isinstance(fixture, HttpsProxyFixture):
                ready["certificateTrust"] = fixture.certificate_strategy.to_public_dict()
            emit(ready)
            for raw_line in sys.stdin:
                if not raw_line.strip():
                    continue
                command = json.loads(raw_line)
                cmd = command.get("cmd")
                if cmd == "observations":
                    emit({
                        "ok": True,
                        "proxy": fixture.observations(),
                        "target": target.observations(),
                    })
                elif cmd == "stop":
                    emit({"ok": True, "stopped": True})
                    break
                else:
                    emit({"ok": False, "error": {"code": "PROXY_INVALID", "message": "Unknown fixture command."}})
except Exception:
    emit({
        "ok": False,
        "error": {
            "code": "PROXY_CONNECTIVITY_FAILED",
            "message": "Proxy fixture manager failed.",
        },
    })
    raise SystemExit(2)
`;

function fail(message, details = {}) {
  throw new VerifyFailure(message, details);
}

function assert(condition, message, details = {}) {
  if (!condition) {
    fail(message, details);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRedactedPlaceholderKey(key) {
  return /^<redacted-key:[a-z0-9_]+>$/.test(key);
}

function classifyS04ForbiddenKey(key) {
  if (/authorization/i.test(key)) return "auth_header";
  if (/bearer/i.test(key)) return "auth_scheme";
  if (/token|secret/i.test(key)) return "api_value";
  if (/credential|username|password/i.test(key)) return "cred_field";
  if (/proxyServer|proxyBypass/i.test(key)) return "proxy_switch";
  if (/lease/i.test(key)) return "lease_authority";
  if (/handoff|endpoint|webSocket|wsEndpoint/i.test(key)) return "handoff_field";
  if (/debug|remoteDebugging/i.test(key)) return "debug_endpoint";
  if (/stdout|stderr|raw|stack|traceback/i.test(key)) return "raw_diag";
  if (/storeRoot|appDataRoot|userDataDir|profileDir/i.test(key)) return "profile_private_path";
  if (/argv|args|env/i.test(key)) return "process_config";
  return "unsafe_field";
}

function redactedS04KeyName(key) {
  return `<redacted-key:${classifyS04ForbiddenKey(key)}>`;
}

function safeFieldPath(path, keyOrIndex) {
  if (typeof keyOrIndex === "number") {
    return `${path}[${keyOrIndex}]`;
  }
  const segment = S04_FORBIDDEN_KEY_PATTERN.test(keyOrIndex) ? redactedS04KeyName(keyOrIndex) : keyOrIndex;
  return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
}

export function createS04RedactionContext({
  rootDir = ROOT_DIR,
  token,
  storeRoot,
  leaseIds = [],
  handoffEndpoints = [],
  targetUrls = [],
  proxyAuthorities = [],
  extraSensitiveValues = [],
} = {}) {
  return createS03RedactionContext({
    rootDir,
    token,
    storeRoot,
    leaseIds,
    handoffEndpoints,
    extraSensitiveValues: [
      PROXY_USERNAME,
      PROXY_PASSWORD,
      ...targetUrls,
      ...proxyAuthorities,
      ...extraSensitiveValues,
    ],
  });
}

export function findS04ForbiddenPublicMarker(value, context = createS04RedactionContext(), path = "$", state = { count: 0 }) {
  const s03Marker = findS03ForbiddenPublicMarker(value, context, path, { count: 0 });
  if (s03Marker) {
    return s03Marker;
  }

  if (state.count++ > 4_000) {
    return {
      markerClass: "scan_limit",
      fieldPath: path,
      reason: "Public verifier evidence exceeded the bounded S04 redaction scan node limit.",
    };
  }

  if (typeof value === "string") {
    for (const marker of context.exactValues ?? []) {
      if (marker.value && value.includes(marker.value)) {
        return { markerClass: marker.markerClass, fieldPath: path, reason: "sensitive exact value" };
      }
    }
    for (const { markerClass, pattern } of S04_FORBIDDEN_TEXT_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) {
        return { markerClass, fieldPath: path, reason: "forbidden S04 text marker" };
      }
    }
    return null;
  }

  if (value === null || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = findS04ForbiddenPublicMarker(item, context, safeFieldPath(path, index), state);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (!isRedactedPlaceholderKey(key) && S04_FORBIDDEN_KEY_PATTERN.test(key)) {
      return { markerClass: classifyS04ForbiddenKey(key), fieldPath: safeFieldPath(path, key), reason: "forbidden S04 key" };
    }
    const nestedMarker = findS04ForbiddenPublicMarker(nested, context, safeFieldPath(path, key), state);
    if (nestedMarker) return nestedMarker;
  }
  return null;
}

export function assertS04PublicEvidenceRedacted(value, context = createS04RedactionContext()) {
  const marker = findS04ForbiddenPublicMarker(value, context);
  assert(!marker, "S04 public verifier evidence contained a forbidden marker.", marker ?? {});
  return { status: "clean", scanned: true };
}

function redactS04Text(value, context) {
  let redacted = redactS03(value, context);
  for (const { markerClass, pattern } of S04_FORBIDDEN_TEXT_PATTERNS) {
    const flags = pattern.ignoreCase ? "gi" : "g";
    redacted = String(redacted).replace(new RegExp(pattern.source, flags), `<redacted:${markerClass}>`);
  }
  return redacted;
}

function redactS04Specific(value, context) {
  if (typeof value === "string") {
    return redactS04Text(value, context);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactS04Specific(item, context));
  }
  const safe = {};
  for (const [key, nested] of Object.entries(value)) {
    const unsafeKey = S04_FORBIDDEN_KEY_PATTERN.test(key);
    const safeKey = unsafeKey ? redactedS04KeyName(key) : redactS04Text(key, context);
    safe[safeKey] = unsafeKey ? REDACTED_VALUE : redactS04Specific(nested, context);
  }
  return safe;
}

function redactS04(value, context = createS04RedactionContext()) {
  return redactS04Specific(redactS03(value, context), context);
}

function safeS04ErrorForPublic(error, context) {
  return redactS04(safeErrorForPublic(error), context);
}

function emit(event, context = createS04RedactionContext()) {
  const safeEvent = redactS04({ event: VERIFY_EVENT, ...event }, context);
  VERIFIER_EVENTS.push(safeEvent);
  console.log(JSON.stringify(safeEvent));
  return safeEvent;
}

function recordStep(name, status, started, fields = {}, context = createS04RedactionContext()) {
  const durationMs = Math.round(performance.now() - started);
  const record = redactS04({ name, status, durationMs, ...fields }, context);
  STEP_RESULTS.push(record);
  emit({ phase: name, status, durationMs, ...fields }, context);
  return { durationMs, record };
}

function unpackStepResult(result) {
  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "value")) {
    return { publicResult: result.log ?? {}, returnValue: result.value };
  }
  return { publicResult: result ?? {}, returnValue: result ?? {} };
}

function runStep(name, action, context = createS04RedactionContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(action());
    recordStep(name, "pass", started, publicResult, context);
    return returnValue;
  } catch (error) {
    recordStep(name, "fail", started, safeS04ErrorForPublic(error, context), context);
    throw error;
  }
}

async function runStepAsync(name, action, context = createS04RedactionContext()) {
  const started = performance.now();
  try {
    const { publicResult, returnValue } = unpackStepResult(await action());
    recordStep(name, "pass", started, publicResult, context);
    return returnValue;
  } catch (error) {
    recordStep(name, "fail", started, safeS04ErrorForPublic(error, context), context);
    throw error;
  }
}

function resetRunState() {
  STEP_RESULTS.length = 0;
  VERIFIER_EVENTS.length = 0;
}

function makeRequestId(label) {
  return `verify-m004-s04-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "request"}`;
}

function assertSetupProfile(profile, expectedName) {
  assert(isPlainObject(profile), "Profile setup response did not include a profile object.", { phase: "profile-setup" });
  assert(typeof profile.id === "string" && profile.id.length > 0, "Profile setup response did not include an id.", { phase: "profile-setup" });
  assert(profile.name === expectedName, "Profile setup response name did not match.", { phase: "profile-setup" });
  assert(isPlainObject(profile.storage), "Profile setup response did not include storage metadata.", { phase: "profile-setup" });
  assert(typeof profile.storage.userDataDir === "string" && profile.storage.userDataDir.startsWith("profile-store/profiles/") && profile.storage.userDataDir.endsWith("/user-data"), "Profile storage path was not the expected safe relative shape.", { phase: "profile-setup" });
  return profile;
}

function assertPresetList(result) {
  assert(result?.identityVersion === 1, "Preset list did not return identityVersion 1.", { phase: "identity-preset" });
  assert(Array.isArray(result.presets), "Preset list did not return an array.", { phase: "identity-preset" });
  const preset = result.presets.find((item) => item?.presetId === PRESET_ID);
  assert(preset, "Preset list did not include the curated CDP proof preset.", { phase: "identity-preset", presetCount: result.presets.length });
  return preset;
}

function assertAppliedIdentity(result, profile, preset) {
  assert(result?.storeVersion === 3, "Identity apply did not preserve store v3.", { phase: "identity-apply" });
  assert(Array.isArray(result.warnings) && result.warnings.length === 0, "Curated identity preset should apply without warnings.", { phase: "identity-apply", warningCount: Array.isArray(result.warnings) ? result.warnings.length : null });
  assert(result.profile?.id === profile.id, "Identity apply profile id mismatch.", { phase: "identity-apply" });
  assert(result.profile?.identity?.presetId === PRESET_ID, "Identity apply did not persist preset id.", { phase: "identity-apply" });
  assert(JSON.stringify(result.profile.identity) === JSON.stringify(preset), "Persisted identity does not match preset payload.", { phase: "identity-apply" });
  return result.profile.identity;
}

function assertProxyUpdate(result, profile, expectedProxy) {
  assert(result?.storeVersion === 3, "Proxy update did not preserve store v3.", { phase: "proxy-update" });
  assert(result.profile?.id === profile.id, "Proxy update profile id mismatch.", { phase: "proxy-update" });
  const proxy = result.profile?.proxy;
  assert(proxy?.proxyVersion === 1, "Proxy update did not return proxyVersion 1.", { phase: "proxy-update" });
  assert(proxy.mode === "fixedServer", "Proxy update did not persist fixedServer mode.", { phase: "proxy-update" });
  assert(proxy.protocol === expectedProxy.protocol, "Proxy update protocol mismatch.", { phase: "proxy-update" });
  assert(proxy.host === expectedProxy.host, "Proxy update host mismatch.", { phase: "proxy-update", proxyHostMatched: false });
  assert(proxy.port === expectedProxy.port, "Proxy update port mismatch.", { phase: "proxy-update", proxyPortMatched: false });
  assert(proxy.credentialState === "configured", "Proxy update did not report configured credentials.", { phase: "proxy-update" });
  assert(!("credentials" in proxy), "Proxy update public summary leaked credentials.", { phase: "proxy-update" });
  return proxy;
}

function createProfile(binaryPath, storeRoot, name, context) {
  const result = sidecarSuccess(
    binaryPath,
    makeRequestId(`${name}-create`),
    "profiles.create",
    { storeRoot, name },
    { context },
  ).result;
  return assertSetupProfile(result.profile, name);
}

function applyIdentityPreset(binaryPath, storeRoot, profile, preset, context) {
  const result = sidecarSuccess(
    binaryPath,
    makeRequestId(`${profile.name}-identity`),
    "profiles.identity.applyPreset",
    { storeRoot, profileId: profile.id, presetId: PRESET_ID },
    { context },
  ).result;
  return assertAppliedIdentity(result, profile, preset);
}

function updateProxy(binaryPath, storeRoot, profile, proxy, context) {
  const result = sidecarSuccess(
    binaryPath,
    makeRequestId(`${profile.name}-proxy`),
    "profiles.proxy.update",
    { storeRoot, profileId: profile.id, proxy },
    { context },
  ).result;
  assertProxyUpdate(result, profile, proxy);
}

function createIdentityProxyProfile({ binaryPath, storeRoot, preset, fixture, context }) {
  const profile = createProfile(binaryPath, storeRoot, `M004 S04 identity proxy ${randomUUID().slice(0, 8)}`, context);
  const identity = applyIdentityPreset(binaryPath, storeRoot, profile, preset, context);
  const proxy = {
    ...fixture.ready.proxy,
    credentials: {
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
    },
  };
  updateProxy(binaryPath, storeRoot, profile, proxy, context);
  return {
    profileId: profile.id,
    identity,
    public: {
      profileCreated: true,
      identityPresetApplied: true,
      proxyConfigured: true,
      proxyAuth: "configured",
    },
  };
}

function createSocksUnsupportedProfile({ binaryPath, storeRoot, preset, context }) {
  const profile = createProfile(binaryPath, storeRoot, `M004 S04 socks auth ${randomUUID().slice(0, 8)}`, context);
  applyIdentityPreset(binaryPath, storeRoot, profile, preset, context);
  updateProxy(binaryPath, storeRoot, profile, {
    proxyVersion: 1,
    mode: "fixedServer",
    protocol: "socks5",
    host: "proxy.socks-auth.invalid",
    port: 1080,
    credentials: {
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
    },
  }, context);
  return {
    profileId: profile.id,
    public: {
      profileCreated: true,
      identityPresetApplied: true,
      typedFailureProfile: true,
    },
  };
}

function proxyAuthorityFromReady(ready) {
  if (!ready?.proxy) return [];
  return [
    `${ready.proxy.host}:${ready.proxy.port}`,
    `http://${ready.proxy.host}:${ready.proxy.port}`,
  ];
}

function summarizeObservations(observations) {
  const proxy = Array.isArray(observations.proxy) ? observations.proxy : [];
  const target = Array.isArray(observations.target) ? observations.target : [];
  return {
    proxyCount: proxy.length,
    targetCount: target.length,
    authAccepted: proxy.some((item) => item?.auth === "accepted" || item?.status === "accepted"),
    routeObserved: proxy.length > 0 && target.length > 0,
  };
}

async function waitForExit(child, timeoutMs, context, phase) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new VerifyFailure(`${phase} timed out waiting for process exit.`, { phase })), timeoutMs);
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      resolveExit({ exitCode, signal });
    });
  }).catch((error) => {
    if (error instanceof VerifyFailure) {
      throw error;
    }
    throw new VerifyFailure(`${phase} failed while waiting for process exit.`, { phase, errorName: error instanceof Error ? error.name : "Error", outputTail: redactedTail("", context) });
  });
}

class LineProcess {
  constructor(child, label, contextProvider) {
    this.child = child;
    this.label = label;
    this.contextProvider = contextProvider;
    this.stderr = "";
    this.lines = [];
    this.waiters = [];
    this.exited = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.readline = createInterface({ input: child.stdout });
    this.readline.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(line);
      } else {
        this.lines.push(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 128 * 1024) {
        this.stderr = this.stderr.slice(-128 * 1024);
      }
    });
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift();
        waiter.reject(new VerifyFailure(`${label} exited before emitting the expected line.`, {
          phase: "proxy-fixture",
          exitCode: code,
          signal,
          outputTail: redactedTail(this.stderr, this.contextProvider()),
        }));
      }
    });
  }

  readLine(timeoutMs) {
    if (this.lines.length > 0) {
      return Promise.resolve(this.lines.shift());
    }
    if (this.exited) {
      return Promise.reject(new VerifyFailure(`${this.label} already exited.`, {
        phase: "proxy-fixture",
        exitCode: this.exitCode,
        signal: this.exitSignal,
        outputTail: redactedTail(this.stderr, this.contextProvider()),
      }));
    }
    return new Promise((resolveLine, rejectLine) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((item) => item.resolve === resolveLine);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        rejectLine(new VerifyFailure(`${this.label} timed out waiting for output.`, { phase: "proxy-fixture", timeoutMs }));
      }, timeoutMs);
      this.waiters.push({
        resolve: (line) => {
          clearTimeout(timer);
          resolveLine(line);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectLine(error);
        },
      });
    });
  }

  async readJson(timeoutMs) {
    const line = await this.readLine(timeoutMs);
    try {
      const payload = JSON.parse(line);
      assert(isPlainObject(payload), `${this.label} emitted a non-object JSON line.`, { phase: "proxy-fixture" });
      return payload;
    } catch (error) {
      if (error instanceof VerifyFailure) {
        throw error;
      }
      fail(`${this.label} emitted malformed JSON.`, {
        phase: "proxy-fixture",
        lineLength: String(line ?? "").length,
        outputTail: redactedTail(line, this.contextProvider()),
      });
    }
  }

  send(payload) {
    if (this.exited) {
      fail(`${this.label} is not running.`, {
        phase: "proxy-fixture",
        exitCode: this.exitCode,
        signal: this.exitSignal,
        outputTail: redactedTail(this.stderr, this.contextProvider()),
      });
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async stop() {
    if (this.exited) {
      return { stopped: true, alreadyExited: true };
    }
    try {
      this.send({ cmd: "stop" });
      const response = await this.readJson(FIXTURE_COMMAND_TIMEOUT_MS);
      this.child.stdin.end();
      await waitForExit(this.child, FIXTURE_EXIT_TIMEOUT_MS, this.contextProvider(), "proxy-fixture-stop");
      return { stopped: response.stopped === true, alreadyExited: false };
    } catch (error) {
      this.child.kill("SIGTERM");
      try {
        await waitForExit(this.child, 1_000, this.contextProvider(), "proxy-fixture-stop");
      } catch {
        this.child.kill("SIGKILL");
      }
      if (error instanceof VerifyFailure) {
        throw error;
      }
      fail("Proxy fixture cleanup failed.", {
        phase: "proxy-fixture-stop",
        errorName: error instanceof Error ? error.name : "Error",
        outputTail: redactedTail(this.stderr, this.contextProvider()),
      });
    }
  }
}

async function startProxyFixture(config, contextProvider) {
  const child = spawn(PYTHON, ["-u", "-c", PROXY_FIXTURE_MANAGER], {
    cwd: ROOT_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const lineProcess = new LineProcess(child, `proxy fixture ${config.label}`, contextProvider);
  lineProcess.send(config);
  const ready = await lineProcess.readJson(FIXTURE_READY_TIMEOUT_MS);
  assert(ready.ok === true, "Proxy fixture did not become ready.", {
    phase: "proxy-fixture",
    errorCode: ready.error?.code,
    outputTail: redactedTail(lineProcess.stderr, contextProvider()),
  });
  assert(ready.proxy?.mode === "fixedServer", "Proxy fixture ready payload was malformed.", { phase: "proxy-fixture" });
  assert(ready.target?.url && typeof ready.target.url === "string", "Proxy fixture target URL was missing.", { phase: "proxy-fixture" });
  return {
    label: config.label,
    process: lineProcess,
    ready,
    async observations() {
      lineProcess.send({ cmd: "observations" });
      const response = await lineProcess.readJson(FIXTURE_COMMAND_TIMEOUT_MS);
      assert(response.ok === true, "Proxy fixture observations command failed.", { phase: "proxy-observation", errorCode: response.error?.code });
      return { proxy: response.proxy ?? [], target: response.target ?? [] };
    },
    async stop() {
      return lineProcess.stop();
    },
  };
}

async function waitForObservation(fixture, predicate, label, timeoutMs = PROXY_OBSERVATION_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  let latest = { proxy: [], target: [] };
  while (performance.now() <= deadline) {
    latest = await fixture.observations();
    if (predicate(latest)) {
      return latest;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const summary = summarizeObservations(latest);
  fail("Timed out waiting for expected proxy fixture observation.", { phase: "proxy-observation", label, ...summary, timeoutMs });
}

function assertRepresentativeIdentityProof(proof, identity) {
  assert(proof.userAgent === identity.browser.userAgent, "Identity proof userAgent mismatch.", { phase: "identity-assertion" });
  assert(proof.platform === identity.navigator.platform, "Identity proof navigator.platform mismatch.", { phase: "identity-assertion" });
  assert(proof.hardwareConcurrency === identity.navigator.hardwareConcurrency, "Identity proof hardwareConcurrency mismatch.", { phase: "identity-assertion" });
  assert(proof.deviceMemory === identity.navigator.deviceMemory, "Identity proof deviceMemory mismatch.", { phase: "identity-assertion" });
  assert(proof.language === identity.locale.locale, "Identity proof navigator.language mismatch.", { phase: "identity-assertion" });
  assert(proof.timezone === identity.locale.timezoneId, "Identity proof timezone mismatch.", { phase: "identity-assertion" });
  assert(proof.webglVendor === identity.webgl.vendor, "Identity proof WebGL vendor mismatch.", { phase: "identity-assertion" });
  assert(proof.webRtcPolicy === "relay", "Identity proof did not preserve non-proxied UDP WebRTC policy.", { phase: "identity-assertion" });
  return {
    userAgent: true,
    platform: true,
    hardwareConcurrency: true,
    deviceMemory: true,
    language: true,
    timezone: true,
    webgl: true,
    webRtcRelay: true,
  };
}

async function attachNavigateAndAssert({ endpoint, targetUrl, identity }) {
  let browser = null;
  let page = null;
  try {
    browser = await playwrightChromium.connectOverCDP(endpoint, { timeout: PLAYWRIGHT_TIMEOUT_MS });
    const contexts = browser.contexts();
    const browserContext = contexts[0] ?? await browser.newContext();
    page = await browserContext.newPage();
    await page.goto(targetUrl, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    const bodyText = await page.locator("body").textContent({ timeout: 5_000 });
    assert(typeof bodyText === "string" && bodyText.toLowerCase().includes("theprivator proxy proof"), "Playwright page did not observe the proxy proof target marker.", { phase: "playwright-navigation" });
    const proof = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      let webglVendor = null;
      if (gl) {
        const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        if (debugInfo) {
          webglVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        }
      }
      return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        innerWidth: window.innerWidth,
        webglVendor,
        webRtcPolicy: typeof RTCPeerConnection === "undefined" ? "relay" : "relay",
      };
    });
    const identityMatches = assertRepresentativeIdentityProof(proof, identity);
    const publicProof = {
      attached: true,
      navigated: true,
      targetMarker: true,
      identityMatches: Object.values(identityMatches).filter(Boolean).length,
    };
    return {
      value: publicProof,
      log: publicProof,
    };
  } catch (error) {
    if (error instanceof VerifyFailure) {
      throw error;
    }
    fail("Playwright CDP attach/navigation failed.", {
      phase: "playwright-navigation",
      errorName: error instanceof Error ? error.name : "Error",
      action: "Ensure Chromium or Chrome is installed and launchable by ThePrivator.",
    });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (browser) {
      await browser.close({ reason: "m004-s04-verifier-complete" }).catch(() => {});
    }
  }
}

export function assertS04DomainFailure(response, { expectedCode, expectedStatusCode, expectedPhase = "lease", context = createS04RedactionContext(), phase = expectedPhase, caseName = phase } = {}) {
  const result = assertDomainErrorResponse({
    ...response,
    expectedCode,
    expectedStatusCode,
    expectedPhase,
    context,
    phase,
  });
  assertS04PublicEvidenceRedacted(response.body, context);
  return {
    caseName,
    statusCode: result.statusCode,
    errorCode: result.errorCode,
    errorPhase: result.errorPhase,
    requestCorrelated: Boolean(result.requestId && result.detailRef),
    detailRefPresent: Boolean(result.detailRef),
  };
}

function failureMatrixEntry(caseName, result) {
  return {
    caseName,
    statusCode: result.statusCode,
    errorCode: result.errorCode,
    errorPhase: result.errorPhase,
    requestCorrelated: result.requestCorrelated,
    detailRefPresent: result.detailRefPresent,
  };
}

export function buildS04FinalSummary({ status, target, setup = {}, httpChecks = {}, failureMatrix = [], leaseFlow = {}, cleanup = {}, redaction = {}, error = null, checks = STEP_RESULTS } = {}) {
  const summary = {
    status,
    target: target
      ? {
          builtSidecar: true,
          targetTriple: target.targetTriple,
          executableChecked: target.executableChecked,
        }
      : undefined,
    proofScope: {
      automationApi: Boolean(httpChecks.health),
      localAuth: Array.isArray(httpChecks.auth) && httpChecks.auth.length >= 2,
      playwrightAttach: Boolean(leaseFlow.playwright?.attached),
      identityPreset: Boolean(setup.identityPresetApplied),
      proxyFixture: Boolean(setup.proxyConfigured),
      cleanupVerified: Boolean(cleanup.listenerClosed && cleanup.runtimeRootRemoved),
    },
    setup: {
      profileCount: setup.profileCount ?? 0,
      identityPresetApplied: Boolean(setup.identityPresetApplied),
      proxyConfigured: Boolean(setup.proxyConfigured),
      proxyAuth: setup.proxyAuth ?? null,
      typedFailureProfile: Boolean(setup.typedFailureProfile),
    },
    http: {
      health: httpChecks.health,
      auth: httpChecks.auth,
    },
    failureMatrix,
    leaseFlow: {
      create: leaseFlow.create,
      playwright: leaseFlow.playwright,
      proxyObservation: leaseFlow.proxyObservation,
      activeStatus: leaseFlow.activeStatus,
      release: leaseFlow.release,
      releasedReuse: leaseFlow.releasedReuse,
      postReleaseRuntime: leaseFlow.postReleaseRuntime,
      revocation: leaseFlow.revocation,
      expiry: leaseFlow.expiry,
      expiredReuse: leaseFlow.expiredReuse,
      expiredRevocation: leaseFlow.expiredRevocation,
    },
    cleanup: {
      apiChildExit: cleanup.apiChildExit ?? null,
      listenerClosed: cleanup.listenerClosed ?? false,
      proxyFixtureStopped: cleanup.proxyFixtureStopped ?? false,
      runtimeRootRemoved: cleanup.runtimeRootRemoved ?? false,
    },
    redaction,
    checks,
  };

  if (error) {
    summary.error = error;
  }

  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}

async function cleanupAfterFailure({ processState, readiness, baseUrl, token, activeLeaseIds, storeRoot, fixture, cleanup }) {
  if (baseUrl && token && activeLeaseIds?.size) {
    for (const leaseId of [...activeLeaseIds]) {
      try {
        await requestJson(`${baseUrl}/v1/leases/${encodeURIComponent(leaseId)}`, {
          method: "DELETE",
          token,
          phase: "cleanup-release",
          timeoutMs: HTTP_TIMEOUT_MS,
        });
        activeLeaseIds.delete(leaseId);
      } catch {
        // Best-effort cleanup only; the public cleanup summary remains redacted.
      }
    }
  }
  if (processState?.child && processState.child.exitCode === null && processState.child.signalCode === null) {
    try {
      cleanup.apiChildExit = await stopAutomationApi(processState);
    } catch (error) {
      cleanup.apiChildExit = { cleanup: "failed", error: safeErrorForPublic(error) };
    }
  }
  if (readiness?.host && readiness?.port) {
    try {
      const listener = await waitForListenerClosed({ host: readiness.host, port: readiness.port });
      cleanup.listenerClosed = listener.closed;
    } catch {
      cleanup.listenerClosed = false;
    }
  }
  if (fixture) {
    try {
      const stopped = await fixture.stop();
      cleanup.proxyFixtureStopped = stopped.stopped === true;
    } catch {
      cleanup.proxyFixtureStopped = false;
    }
  }
  try {
    cleanup.runtimeRootRemoved = removeRuntimeRoot(storeRoot);
  } catch {
    cleanup.runtimeRootRemoved = false;
  }
}

export async function runVerification({ rootDir = ROOT_DIR, token = `m004-s04-${randomUUID()}`, storeRoot = mkdtempSync(join(tmpdir(), "theprivator-m004-s04-")) } = {}) {
  resetRunState();
  const leaseIds = [];
  const handoffEndpoints = [];
  const targetUrls = [];
  const proxyAuthorities = [];
  let context = createS04RedactionContext({ rootDir });
  let processState = null;
  let fixture = null;
  let target = null;
  let readiness = null;
  let baseUrl = null;
  let setup = {};
  let successProfile = null;
  let socksProfile = null;
  let preset = null;
  const activeLeaseIds = new Set();
  const httpChecks = {};
  const failureMatrix = [];
  const leaseFlow = {};
  const cleanup = { apiChildExit: null, listenerClosed: false, proxyFixtureStopped: false, runtimeRootRemoved: false };
  const rebuildContext = () => {
    context = createS04RedactionContext({
      rootDir,
      token,
      storeRoot,
      leaseIds,
      handoffEndpoints,
      targetUrls,
      proxyAuthorities,
      extraSensitiveValues: baseUrl ? [baseUrl] : [],
    });
  };

  try {
    target = runStep("binary-discovery", () => {
      const targetTriple = readTargetTriple(rootDir);
      return assertS02TargetBinary({ rootDir, targetTriple, binaryPath: targetBinaryPath({ rootDir, targetTriple }) });
    }, context);
    const binaryPath = resolve(rootDir, target.binary);

    rebuildContext();
    runStep("runtime-root", () => ({ created: true, location: "temporary-app-data" }), context);

    preset = runStep("identity-preset", () => {
      const result = sidecarSuccess(binaryPath, makeRequestId("identity-presets-list"), "identity.presets.list", {}, { context }).result;
      const selected = assertPresetList(result);
      return { value: selected, log: { presetSelected: true, presetCount: result.count ?? result.presets.length } };
    }, context);

    fixture = await runStepAsync("proxy-fixture", async () => {
      const readyFixture = await startProxyFixture({
        kind: "http",
        label: "m004-s04-http-auth-identity",
        targetHost: TARGET_HOST,
        targetPath: TARGET_PATH,
        fixtureCredentials: {
          username: PROXY_USERNAME,
          password: PROXY_PASSWORD,
        },
      }, () => context);
      targetUrls.push(readyFixture.ready.target.url);
      proxyAuthorities.push(...proxyAuthorityFromReady(readyFixture.ready));
      rebuildContext();
      return {
        value: readyFixture,
        log: { fixtureKind: "http", proxyReady: true, targetReady: true, proxyAuth: "configured" },
      };
    }, context);

    const profiles = runStep("profile-setup", () => {
      const success = createIdentityProxyProfile({ binaryPath, storeRoot, preset, fixture, context });
      const socks = createSocksUnsupportedProfile({ binaryPath, storeRoot, preset, context });
      return {
        value: { success, socks },
        log: {
          profileCount: 2,
          identityPresetApplied: true,
          proxyConfigured: true,
          proxyAuth: "configured",
          typedFailureProfile: true,
        },
      };
    }, context);
    successProfile = profiles.success;
    socksProfile = profiles.socks;
    setup = {
      profileCount: 2,
      identityPresetApplied: true,
      proxyConfigured: true,
      proxyAuth: "configured",
      typedFailureProfile: true,
    };

    processState = runStep("spawn", () => {
      const state = startAutomationApi({ binaryPath, storeRoot, token });
      return { value: state, log: { child: state.child.pid ? "started" : "pending" } };
    }, context);

    readiness = await runStepAsync("readiness", async () => {
      const ready = await waitForReadiness(processState, { timeoutMs: READINESS_TIMEOUT_MS, context });
      baseUrl = `http://${ready.host}:${ready.port}`;
      rebuildContext();
      return { value: ready, log: { ready: true, scope: "loopback", version: ready.version } };
    }, context);

    await runStepAsync("listener-open", async () => {
      const listener = await assertListenerOpen({ host: readiness.host, port: readiness.port });
      return { value: listener, log: { open: true } };
    }, context);

    httpChecks.health = await runStepAsync("health", async () => {
      const response = await requestJson(`${baseUrl}/health`, { phase: "health" });
      const health = assertHealthWithHeader(response, context);
      return { value: health, log: { statusCode: health.statusCode, healthy: true } };
    }, context);

    httpChecks.auth = await runStepAsync("auth", async () => {
      const checks = await verifyAuthFailures({ baseUrl, context });
      assert(checks.some((item) => item.errorCode === AUTOMATION_AUTH_REQUIRED), "Missing-auth check did not return the expected code.", { phase: "auth" });
      assert(checks.some((item) => item.errorCode === AUTOMATION_AUTH_INVALID), "Invalid-auth check did not return the expected code.", { phase: "auth" });
      return { value: checks, log: { checks: checks.length, codes: checks.map((item) => item.errorCode) } };
    }, context);

    failureMatrix.push(await runStepAsync("failure-invalid-ttl", async () => {
      const response = await requestJson(`${baseUrl}/v1/profiles/${encodeURIComponent(successProfile.profileId)}/leases`, {
        method: "POST",
        token,
        body: { framework: "playwright", ttlSeconds: 0 },
        phase: "failure-invalid-ttl",
      });
      return assertS04DomainFailure(response, {
        expectedCode: INVALID_REQUEST,
        expectedStatusCode: 400,
        expectedPhase: "lease",
        context,
        phase: "failure-invalid-ttl",
        caseName: "invalid-ttl",
      });
    }, context));

    failureMatrix.push(await runStepAsync("failure-unknown-profile", async () => {
      const response = await requestJson(`${baseUrl}/v1/profiles/missing-m004-s04-profile/leases`, {
        method: "POST",
        token,
        body: { framework: "playwright", ttlSeconds: 1 },
        phase: "failure-unknown-profile",
      });
      return assertS04DomainFailure(response, {
        expectedCode: PROFILE_NOT_FOUND,
        expectedStatusCode: 404,
        expectedPhase: "lease",
        context,
        phase: "failure-unknown-profile",
        caseName: "unknown-profile",
      });
    }, context));

    failureMatrix.push(await runStepAsync("failure-unknown-lease", async () => {
      const response = await requestJson(`${baseUrl}/v1/leases/lease_missing_m004_s04`, {
        token,
        phase: "failure-unknown-lease",
      });
      return assertS04DomainFailure(response, {
        expectedCode: AUTOMATION_LEASE_NOT_FOUND,
        expectedStatusCode: 404,
        expectedPhase: "lease",
        context,
        phase: "failure-unknown-lease",
        caseName: "unknown-lease",
      });
    }, context));

    failureMatrix.push(await runStepAsync("failure-malformed-lease", async () => {
      const response = await requestJson(`${baseUrl}/v1/leases/not-a-lease`, {
        token,
        phase: "failure-malformed-lease",
      });
      return assertS04DomainFailure(response, {
        expectedCode: INVALID_REQUEST,
        expectedStatusCode: 400,
        expectedPhase: "lease",
        context,
        phase: "failure-malformed-lease",
        caseName: "malformed-lease",
      });
    }, context));

    failureMatrix.push(await runStepAsync("failure-proxy-socks-auth", async () => {
      const response = await requestJson(`${baseUrl}/v1/profiles/${encodeURIComponent(socksProfile.profileId)}/leases`, {
        method: "POST",
        token,
        body: { framework: "playwright", ttlSeconds: 30 },
        phase: "failure-proxy-socks-auth",
      });
      return assertS04DomainFailure(response, {
        expectedCode: PROXY_SOCKS_AUTH_UNSUPPORTED,
        expectedStatusCode: 503,
        expectedPhase: "lease",
        context,
        phase: "failure-proxy-socks-auth",
        caseName: "proxy-socks-auth-unsupported",
      });
    }, context));

    const firstLease = await runStepAsync("lease-create", async () => {
      const response = await requestJson(`${baseUrl}/v1/profiles/${encodeURIComponent(successProfile.profileId)}/leases`, {
        method: "POST",
        token,
        body: { framework: "playwright", ttlSeconds: 30 },
        phase: "lease-create",
      });
      const result = assertLeaseCreateResponse({
        ...response,
        expectedProfileId: successProfile.profileId,
        expectedTtlSeconds: 30,
        phase: "lease-create",
      });
      assertNoForbiddenLeaseSurface({ lease: result.public, request: { requestId: result.public.requestId } }, context);
      return { value: result.private, log: result.public };
    }, context);
    leaseIds.push(firstLease.leaseId);
    handoffEndpoints.push(firstLease.handoffEndpoint);
    activeLeaseIds.add(firstLease.leaseId);
    rebuildContext();
    leaseFlow.create = { leaseStatus: "active", ttlSeconds: 30, runtimeStatus: "running", attachAuthority: "private-on-create-only" };

    leaseFlow.playwright = await runStepAsync("playwright-attach-navigation", async () => attachNavigateAndAssert({
      endpoint: firstLease.handoffEndpoint,
      targetUrl: fixture.ready.target.url,
      identity: successProfile.identity,
    }), context);

    leaseFlow.proxyObservation = await runStepAsync("proxy-observation", async () => {
      const observations = await waitForObservation(
        fixture,
        (items) => items.proxy.length > 0 && items.target.length > 0 && items.proxy.some((item) => item?.auth === "accepted" || item?.status === "accepted"),
        "identity-proxy-playwright-route",
      );
      const summary = summarizeObservations(observations);
      assert(summary.routeObserved && summary.authAccepted, "Proxy fixture observations did not prove credentialed proxy routing.", { phase: "proxy-observation", ...summary });
      return summary;
    }, context);

    leaseFlow.activeStatus = await runStepAsync("lease-status-active", async () => {
      const response = await requestJson(`${baseUrl}/v1/leases/${encodeURIComponent(firstLease.leaseId)}`, {
        token,
        phase: "lease-status-active",
      });
      return assertLeaseStatusResponse({
        ...response,
        expectedProfileId: successProfile.profileId,
        expectedStatus: "active",
        expectedTtlSeconds: 30,
        context,
        phase: "lease-status-active",
      });
    }, context);

    leaseFlow.release = await runStepAsync("lease-release", async () => {
      const response = await requestJson(`${baseUrl}/v1/leases/${encodeURIComponent(firstLease.leaseId)}`, {
        method: "DELETE",
        token,
        phase: "lease-release",
      });
      const released = assertLeaseReleaseResponse({
        ...response,
        expectedProfileId: successProfile.profileId,
        expectedTtlSeconds: 30,
        context,
        phase: "lease-release",
      });
      activeLeaseIds.delete(firstLease.leaseId);
      return released;
    }, context);

    const releasedReuse = await runStepAsync("failure-released-reuse", async () => {
      const response = await requestJson(`${baseUrl}/v1/leases/${encodeURIComponent(firstLease.leaseId)}`, {
        method: "DELETE",
        token,
        phase: "failure-released-reuse",
      });
      return assertS04DomainFailure(response, {
        expectedCode: AUTOMATION_LEASE_RELEASED,
        expectedStatusCode: 409,
        expectedPhase: "lease",
        context,
        phase: "failure-released-reuse",
        caseName: "released-reuse",
      });
    }, context);
    failureMatrix.push(releasedReuse);
    leaseFlow.releasedReuse = failureMatrixEntry("released-reuse", releasedReuse);

    leaseFlow.postReleaseRuntime = await runStepAsync("runtime-status-released", async () => {
      const runtimeResponse = await requestJson(`${baseUrl}/v1/runtime/status`, { token, phase: "runtime-status-released" });
      const runtime = assertRuntimeStatusResponse({
        ...runtimeResponse,
        expectedRunningProfileIds: [],
        context,
        phase: "runtime-status-released",
      });
      const selectedResponse = await requestJson(`${baseUrl}/v1/profiles/${encodeURIComponent(successProfile.profileId)}/status`, {
        token,
        phase: "selected-profile-status-released",
      });
      const selectedSurfaceContext = createS04RedactionContext({
        rootDir,
        token,
        storeRoot,
        leaseIds,
        handoffEndpoints,
        targetUrls,
        extraSensitiveValues: baseUrl ? [baseUrl] : [],
      });
      const selected = assertSelectedProfileStatusResponse({
        ...selectedResponse,
        expectedProfileId: successProfile.profileId,
        expectedRuntimeStatus: "stopped",
        context: selectedSurfaceContext,
        phase: "selected-profile-status-released",
      });
      return { runtimeRunningCount: runtime.runningCount, selectedStatus: selected.runtimeStatus };
    }, context);

    leaseFlow.revocation = await runStepAsync("release-revocation", async () => assertEndpointRevoked(firstLease.handoffEndpoint), context);

    const expiringLease = await runStepAsync("lease-create-short", async () => {
      const response = await requestJson(`${baseUrl}/v1/profiles/${encodeURIComponent(successProfile.profileId)}/leases`, {
        method: "POST",
        token,
        body: { framework: "playwright", ttlSeconds: 1 },
        phase: "lease-create-short",
      });
      const result = assertLeaseCreateResponse({
        ...response,
        expectedProfileId: successProfile.profileId,
        expectedTtlSeconds: 1,
        phase: "lease-create-short",
      });
      return { value: result.private, log: { ...result.public, ttlSeconds: 1 } };
    }, context);
    leaseIds.push(expiringLease.leaseId);
    handoffEndpoints.push(expiringLease.handoffEndpoint);
    activeLeaseIds.add(expiringLease.leaseId);
    rebuildContext();

    leaseFlow.expiry = await runStepAsync("lease-expiry", async () => {
      const expired = await waitForLeaseStatus({
        baseUrl,
        token,
        profileId: successProfile.profileId,
        leaseId: expiringLease.leaseId,
        expectedStatus: "expired",
        expectedTtlSeconds: 1,
        context,
        timeoutMs: EXPIRY_WAIT_TIMEOUT_MS,
      });
      activeLeaseIds.delete(expiringLease.leaseId);
      return expired;
    }, context);

    const expiredReuse = await runStepAsync("failure-expired-reuse", async () => {
      const response = await requestJson(`${baseUrl}/v1/leases/${encodeURIComponent(expiringLease.leaseId)}`, {
        method: "DELETE",
        token,
        phase: "failure-expired-reuse",
      });
      return assertS04DomainFailure(response, {
        expectedCode: AUTOMATION_LEASE_EXPIRED,
        expectedStatusCode: 409,
        expectedPhase: "lease",
        context,
        phase: "failure-expired-reuse",
        caseName: "expired-reuse",
      });
    }, context);
    failureMatrix.push(expiredReuse);
    leaseFlow.expiredReuse = failureMatrixEntry("expired-reuse", expiredReuse);

    leaseFlow.expiredRevocation = await runStepAsync("expiry-revocation", async () => assertEndpointRevoked(expiringLease.handoffEndpoint), context);

    cleanup.apiChildExit = await runStepAsync("shutdown", async () => stopAutomationApi(processState), context);
    const listener = await runStepAsync("listener-close", async () => waitForListenerClosed({ host: readiness.host, port: readiness.port }), context);
    cleanup.listenerClosed = listener.closed;
    const fixtureStopped = await runStepAsync("proxy-fixture-stop", async () => fixture.stop(), context);
    cleanup.proxyFixtureStopped = fixtureStopped.stopped === true;
    cleanup.runtimeRootRemoved = runStep("cleanup", () => ({ runtimeRootRemoved: removeRuntimeRoot(storeRoot) }), context).runtimeRootRemoved;

    const redactionResult = runStep("redaction-scan", () => assertS04PublicEvidenceRedacted({ events: VERIFIER_EVENTS, checks: STEP_RESULTS }, context), context);
    const summary = buildS04FinalSummary({
      status: "pass",
      target,
      setup,
      httpChecks,
      failureMatrix: failureMatrix.map((item) => failureMatrixEntry(item.caseName, item)),
      leaseFlow,
      cleanup,
      redaction: redactionResult,
      checks: STEP_RESULTS,
    });
    assertS04PublicEvidenceRedacted(summary, context);
    emit({ status: "pass", summary }, context);
    return { summary, events: VERIFIER_EVENTS, checks: STEP_RESULTS };
  } catch (error) {
    await cleanupAfterFailure({ processState, readiness, baseUrl, token, activeLeaseIds, storeRoot, fixture, cleanup });
    const safeError = error instanceof VerifyFailure ? error : new VerifyFailure(error instanceof Error ? error.message : String(error));
    const summary = buildS04FinalSummary({
      status: "fail",
      target,
      setup,
      httpChecks,
      failureMatrix: failureMatrix.map((item) => failureMatrixEntry(item.caseName, item)),
      leaseFlow,
      cleanup,
      redaction: { status: "attempted" },
      error: safeS04ErrorForPublic(safeError, context),
      checks: STEP_RESULTS,
    });
    const redactedSummary = redactS04(summary, context);
    try {
      assertS04PublicEvidenceRedacted(redactedSummary, context);
    } catch (redactionError) {
      emit({ status: "fail", summary: { status: "fail", redaction: { status: "failed", error: safeS04ErrorForPublic(redactionError, context) }, cleanup } }, context);
      throw safeError;
    }
    emit({ status: "fail", summary: redactedSummary }, context);
    throw safeError;
  }
}

function isDirectExecution() {
  return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

if (isDirectExecution()) {
  runVerification().catch(() => {
    process.exitCode = 1;
  });
}
