import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_NAME = "theprivator-sidecar";
const EXTENSION = process.platform === "win32" ? ".exe" : "";
const VENV_PYTHON = process.platform === "win32"
  ? join(ROOT_DIR, ".venv", "Scripts", "python.exe")
  : join(ROOT_DIR, ".venv", "bin", "python");
const PYTHON = process.env.PYTHON ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : (process.platform === "win32" ? "python" : "python3"));
const PRESET_ID = "ubuntu-linux-chrome-120";
const SIDECAR_TIMEOUT_MS = 15_000;
const CHROMIUM_LAUNCH_TIMEOUT_MS = 45_000;
const CDP_NAVIGATION_TIMEOUT_MS = 20_000;
const FIXTURE_READY_TIMEOUT_MS = 8_000;
const FIXTURE_COMMAND_TIMEOUT_MS = 5_000;
const PROOF_TIMEOUT_MS = 25_000;
const TARGET_HOST = "theprivator-proxy-proof.invalid";
const TARGET_PATH = "/theprivator-proxy-proof";
const PROXY_USERNAME = "proxy-s05-user-sentinel";
const PROXY_PASSWORD = "proxy-s05-password-sentinel";
const WRONG_PROXY_USERNAME = "proxy-s05-wrong-user-sentinel";
const WRONG_PROXY_PASSWORD = "proxy-s05-wrong-password-sentinel";
const STEP_RESULTS = [];
const VERIFIER_EVENTS = [];
const ALL_TRANSCRIPTS = [];
const PROFILE_STORE_SUMMARIES = [];
const SENSITIVE_VALUES = new Set([
  ROOT_DIR,
  PROXY_USERNAME,
  PROXY_PASSWORD,
  WRONG_PROXY_USERNAME,
  WRONG_PROXY_PASSWORD,
]);
const SENSITIVE_KEY_RE = /(?:authorization|credential|password|proxy[-_ ]?(?:authorization|pass|password|user|username)|username)/i;
const PUBLIC_FORBIDDEN_MARKERS = [
  "Proxy-Authorization",
  "proxy-authorization",
  "DevToolsActivePort",
  "debugPort",
  "--proxy-server",
  "--load-extension",
  "--disable-extensions-except",
  "--remote-debugging-port",
  "--user-data-dir",
  "--ignore-certificate-errors",
  "identity-extensions",
  "proxy-auth-extensions",
  "identity_config.js",
  "identity_protector.js",
  "proxy_auth_config.js",
  "proxy_auth_worker.js",
  "private key",
  "BEGIN PRIVATE KEY",
  "proxy-key.pem",
  "proxy-cert.pem",
  "DevToolsActivePort",
  "Traceback",
];
const PRIVATE_STORE_FORBIDDEN_MARKERS = [
  "Proxy-Authorization",
  "proxy-authorization",
  "DevToolsActivePort",
  "debugPort",
  "--proxy-server",
  "--load-extension",
  "--disable-extensions-except",
  "--remote-debugging-port",
  "--user-data-dir",
  "--ignore-certificate-errors",
  "identity-extensions",
  "proxy-auth-extensions",
  "Traceback",
  "ws://",
  "wss://",
];

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

const PROXY_CDP_NAVIGATOR = String.raw`
import json
import sys
import time

from theprivator_sidecar.cdp import CdpClient, discover_devtools_endpoint, discover_page_target_endpoint, page_navigate, runtime_evaluate
from theprivator_sidecar.protocol import PROXY_PROOF_FAILED, SidecarError


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True), flush=True)


payload = json.loads(sys.stdin.read() or "{}")
url = payload.get("targetUrl")
user_data_path = payload.get("userDataPath")
timeout = max(0.5, float(payload.get("timeoutSeconds", 8.0)))
started = time.perf_counter()
try:
    if not isinstance(url, str) or not isinstance(user_data_path, str):
        raise SidecarError(code=PROXY_PROOF_FAILED, message="Proxy proof could not be collected.")
    endpoint = discover_devtools_endpoint(user_data_path, timeout_seconds=min(timeout, 10.0))
    page = discover_page_target_endpoint(endpoint, timeout_seconds=min(timeout, 5.0))
    marker = "missing"
    frame = "missing"
    with CdpClient(page.web_socket_debugger_url, timeout_seconds=timeout) as client:
        client.command("Page.enable", {}, timeout_seconds=timeout)
        navigation = page_navigate(client, url, timeout_seconds=timeout, allowed_urls={url})
        if navigation.get("frameId"):
            frame = "present"
        deadline = time.monotonic() + timeout
        while time.monotonic() <= deadline:
            try:
                body = runtime_evaluate(
                    client,
                    "document.body ? document.body.textContent : ''",
                    await_promise=False,
                    return_by_value=True,
                    timeout_seconds=min(1.0, timeout),
                )
                if isinstance(body, str) and "theprivator proxy proof" in body:
                    marker = "present"
                    break
            except Exception:
                pass
            time.sleep(0.1)
    emit({
        "ok": True,
        "navigation": {
            "status": "navigated",
            "frame": frame,
            "marker": marker,
            "durationMs": round((time.perf_counter() - started) * 1000, 3),
        },
    })
except SidecarError as exc:
    emit({
        "ok": False,
        "error": exc.to_dict(),
        "navigation": {
            "status": "failed",
            "errorCode": exc.code,
            "durationMs": round((time.perf_counter() - started) * 1000, 3),
        },
    })
except Exception:
    emit({
        "ok": False,
        "error": {"code": PROXY_PROOF_FAILED, "message": "Proxy proof could not be collected.", "recoverable": True, "detailRef": "sidecar-proxy-proof-failed"},
        "navigation": {
            "status": "failed",
            "errorCode": PROXY_PROOF_FAILED,
            "durationMs": round((time.perf_counter() - started) * 1000, 3),
        },
    })
`;

const IDENTITY_PROOF_COLLECTOR = String.raw`
import json
import sys
from theprivator_sidecar.identity_proof import collect_identity_proof_for_user_data_dir
from theprivator_sidecar.protocol import IDENTITY_PROOF_FAILED, SidecarError

try:
    proof = collect_identity_proof_for_user_data_dir(
        sys.argv[1],
        discovery_timeout_seconds=10.0,
        proof_timeout_seconds=8.0,
    )
    print(json.dumps({"ok": True, "proof": proof}, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
except SidecarError as exc:
    print(json.dumps({"ok": False, "error": exc.to_dict()}, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    raise SystemExit(2)
except Exception:
    print(json.dumps({"ok": False, "error": {"code": IDENTITY_PROOF_FAILED, "message": "Identity proof could not be collected.", "recoverable": True, "detailRef": "sidecar-proof-failed"}}, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    raise SystemExit(2)
`;

class VerifyFailure extends Error {
  constructor(message, details) {
    super(message);
    this.name = "VerifyFailure";
    this.details = details;
  }
}

function emit(event) {
  const safeEvent = redactForLog({ event: "verify.s05", ...event });
  VERIFIER_EVENTS.push(safeEvent);
  console.log(JSON.stringify(safeEvent));
}

function fail(message, details) {
  throw new VerifyFailure(message, redactForLog(details));
}

function assert(condition, message, details) {
  if (!condition) {
    fail(message, details);
  }
}

function executable(command) {
  return process.platform === "win32" && ["npm", "cargo", "rustc"].includes(command)
    ? `${command}.cmd`
    : command;
}

function rememberSensitive(value) {
  if (typeof value === "string" && value.trim()) {
    SENSITIVE_VALUES.add(value);
  }
}

function activeSensitiveValues(extra = []) {
  return [...SENSITIVE_VALUES, ...extra].filter((value) => typeof value === "string" && value.length > 0);
}

function redactText(value, extra = []) {
  let redacted = String(value ?? "");
  for (const sensitive of activeSensitiveValues(extra).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(sensitive).join(sensitive === ROOT_DIR ? "<repo>" : "<redacted>");
  }
  return redacted
    .replace(/ws:\/\/[^\s"']+/gi, "ws://<redacted>")
    .replace(/wss:\/\/[^\s"']+/gi, "wss://<redacted>")
    .replace(/--remote-debugging-port(?:=|\s+)\d+/gi, "--remote-debugging-port=<redacted>")
    .replace(/--ignore-certificate-errors-spki-list=[^\s"']+/gi, "--ignore-certificate-errors-spki-list=<redacted>")
    .replace(/debugPort["':\s=]+\d+/gi, "debugPort=<redacted>");
}

function redactForLog(value, extra = []) {
  if (typeof value === "string") {
    return redactText(value, extra);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, extra));
  }
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      result["<redacted-key>"] = "<redacted>";
    } else {
      result[redactText(key, extra)] = redactForLog(nested, extra);
    }
  }
  return result;
}

function normalizeOutput(value, extra = []) {
  if (!value) {
    return "";
  }
  return redactText(value, extra)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-25)
    .join("\n");
}

function commandLabel(command, args, label) {
  return label || [basename(command), ...args].join(" ");
}

async function runStep(name, action) {
  const started = performance.now();
  try {
    const result = await action();
    const durationMs = Math.round(performance.now() - started);
    const logResult = result?.log ?? result ?? {};
    const returnResult = result?.value ?? result;
    const record = { name, ...redactForLog(logResult), status: "pass", durationMs };
    STEP_RESULTS.push(record);
    emit({ step: name, ...redactForLog(logResult), status: "pass", durationMs });
    return returnResult;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    const record = { name, status: "fail", durationMs, message };
    STEP_RESULTS.push(record);
    emit({ step: name, status: "fail", durationMs, message });
    if (error?.details) {
      emit({ step: name, status: "fail-details", details: redactForLog(error.details) });
    }
    throw error;
  }
}

function runCommand(name, command, args, timeoutMs, options = {}) {
  return runStep(name, () => {
    const label = commandLabel(command, args, options.label);
    const result = spawnSync(executable(command), args, {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        fail(`${label} timed out.`, {
          command: label,
          timeoutMs,
          stdoutTail: normalizeOutput(result.stdout),
          stderrTail: normalizeOutput(result.stderr),
        });
      }
      fail(`Failed to run ${label}.`, { command: label, error: result.error.message });
    }
    if (result.status !== 0) {
      fail(`${label} exited with status ${result.status ?? "unknown"}.`, {
        command: label,
        exitCode: result.status,
        stdoutTail: normalizeOutput(result.stdout),
        stderrTail: normalizeOutput(result.stderr),
      });
    }
    assertNoPublicLeaks(`${label} stdout/stderr`, `${result.stdout}\n${result.stderr}`);
    return { command: label };
  });
}

function readTargetTriple() {
  try {
    return execFileSync(executable("rustc"), ["--print", "host-tuple"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail("Failed to determine the Rust host target triple.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function targetBinaryPath(targetTriple) {
  return join(ROOT_DIR, "src-tauri", "binaries", `${SIDECAR_NAME}-${targetTriple}${EXTENSION}`);
}

function assertTargetBinary(binaryPath, targetTriple) {
  assert(existsSync(binaryPath), "Missing built sidecar binary for verify:s05.", {
    binary: relative(ROOT_DIR, binaryPath),
    instruction: "Run npm run sidecar:build before npm run verify:s05.",
  });
  const stats = statSync(binaryPath);
  assert(stats.isFile(), "Built sidecar path is not a file.", { binary: relative(ROOT_DIR, binaryPath) });
  if (process.platform !== "win32") {
    assert((stats.mode & 0o111) !== 0, "Built sidecar binary is not executable.", {
      binary: relative(ROOT_DIR, binaryPath),
    });
  }
  return { binary: relative(ROOT_DIR, binaryPath), targetTriple };
}

function parseNdjsonLines(streamName, value, expectedCount = null, extra = []) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (expectedCount !== null && lines.length !== expectedCount) {
    fail(`${streamName} emitted ${lines.length} NDJSON line(s), expected ${expectedCount}.`, {
      streamName,
      lineCount: lines.length,
      tail: normalizeOutput(value, extra),
    });
  }
  if (expectedCount === null && lines.length < 1) {
    fail(`${streamName} emitted no NDJSON lines.`, { streamName });
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${streamName} line ${index + 1} is not valid JSON.`, {
        streamName,
        lineNumber: index + 1,
        error: error instanceof Error ? error.message : String(error),
        lineTail: normalizeOutput(line, extra),
      });
    }
  });
}

function runSidecarRequest(binaryPath, request, options = {}) {
  const sensitiveValues = activeSensitiveValues(options.sensitiveValues ?? []);
  for (const value of sensitiveValues) {
    rememberSensitive(value);
  }
  const result = spawnSync(binaryPath, {
    cwd: ROOT_DIR,
    input: `${JSON.stringify(request)}\n`,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs ?? SIDECAR_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      fail(`Built sidecar timed out for ${request.method}.`, {
        method: request.method,
        timeoutMs: options.timeoutMs ?? SIDECAR_TIMEOUT_MS,
        stdoutTail: normalizeOutput(result.stdout, sensitiveValues),
        stderrTail: normalizeOutput(result.stderr, sensitiveValues),
      });
    }
    fail(`Built sidecar failed for ${request.method}.`, {
      method: request.method,
      error: result.error.message,
      stdoutTail: normalizeOutput(result.stdout, sensitiveValues),
      stderrTail: normalizeOutput(result.stderr, sensitiveValues),
    });
  }
  if (result.status !== 0) {
    fail(`Built sidecar exited with status ${result.status ?? "unknown"} for ${request.method}.`, {
      method: request.method,
      exitCode: result.status,
      stdoutTail: normalizeOutput(result.stdout, sensitiveValues),
      stderrTail: normalizeOutput(result.stderr, sensitiveValues),
    });
  }

  assertNoPublicLeaks(`sidecar ${request.method} stdout/stderr`, `${result.stdout}\n${result.stderr}`, sensitiveValues);
  const [response] = parseNdjsonLines("sidecar stdout", result.stdout, 1, sensitiveValues);
  const diagnostics = parseNdjsonLines("sidecar stderr", result.stderr, null, sensitiveValues);
  const diagnostic = diagnostics[0];
  assertRequestDiagnostic(diagnostic, request);
  const transcript = { requestId: request.id, method: request.method, response, diagnostic, diagnostics, stdout: result.stdout, stderr: result.stderr };
  ALL_TRANSCRIPTS.push(transcript);
  return transcript;
}

function assertRequestDiagnostic(diagnostic, request) {
  assert(diagnostic?.event === "sidecar.request", "Sidecar diagnostic event name changed.", {
    method: request.method,
    diagnostic,
  });
  assert(diagnostic.method === request.method, "Sidecar diagnostic method did not match request.", {
    method: request.method,
    diagnosticMethod: diagnostic.method,
  });
  assert(diagnostic.requestId === request.id, "Sidecar diagnostic request id did not match request.", {
    requestId: request.id,
    diagnosticRequestId: diagnostic.requestId,
  });
  assert(!("params" in diagnostic), "Sidecar diagnostic leaked request params.", { method: request.method });
}

function sidecarRequest(id, method, params = {}) {
  return { id, method, params };
}

function sidecarSuccess(binaryPath, id, method, params = {}, options = {}) {
  const transcript = runSidecarRequest(binaryPath, sidecarRequest(id, method, params), options);
  const { response, diagnostic } = transcript;
  assert(response.id === id, "Sidecar success response id mismatch.", { method, requestId: id, responseId: response.id });
  assert(response.ok === true, `Expected ${method} to succeed.`, {
    method,
    errorCode: response.error?.code,
    detailRef: response.error?.detailRef,
  });
  assert(diagnostic.status === "ok", "Sidecar diagnostic did not report ok status.", {
    method,
    status: diagnostic.status,
    errorCode: diagnostic.errorCode,
    detailRef: diagnostic.detailRef,
  });
  assert(diagnostic.errorCode === null, "Successful diagnostic should not include errorCode.", { method });
  assert(diagnostic.detailRef === null, "Successful diagnostic should not include detailRef.", { method });
  assert(response.result && typeof response.result === "object" && !Array.isArray(response.result), "Success response result must be an object.", { method });
  return { ...transcript, result: response.result };
}

function sidecarError(binaryPath, id, method, params = {}, options = {}) {
  const transcript = runSidecarRequest(binaryPath, sidecarRequest(id, method, params), options);
  const { response, diagnostic } = transcript;
  assert(response.id === id, "Sidecar error response id mismatch.", { method, requestId: id, responseId: response.id });
  assert(response.ok === false, `Expected ${method} to fail safely.`, { method });
  assert(response.error && typeof response.error === "object", "Sidecar error response is missing error.", { method });
  assert(diagnostic.status === "error", "Sidecar diagnostic did not report error status.", { method, status: diagnostic.status });
  assert(diagnostic.errorCode === response.error.code, "Diagnostic errorCode did not match response error code.", {
    method,
    responseCode: response.error.code,
    diagnosticCode: diagnostic.errorCode,
  });
  assert(diagnostic.detailRef === response.error.detailRef, "Diagnostic detailRef did not match response detailRef.", {
    method,
    responseDetailRef: response.error.detailRef,
    diagnosticDetailRef: diagnostic.detailRef,
  });
  assert(typeof response.error.detailRef === "string" && response.error.detailRef.startsWith("sidecar-"), "Sidecar error did not include an opaque detailRef.", {
    method,
    detailRef: response.error.detailRef,
  });
  return { ...transcript, error: response.error };
}

function makeRequestId(label) {
  return `verify-s05-${label}`.slice(0, 120);
}

function safeLabel(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "case";
}

function makeTempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  rememberSensitive(root);
  return root;
}

function isSafeRelativeStoragePath(value) {
  return typeof value === "string"
    && value.startsWith("profile-store/profiles/")
    && value.endsWith("/user-data")
    && !value.startsWith("/")
    && !value.includes("..");
}

function assertProfileShape(profile, expectedName) {
  assert(profile && typeof profile === "object" && !Array.isArray(profile), "Profile payload is missing.");
  assert(typeof profile.id === "string" && profile.id.length > 0, "Profile id is missing.");
  assert(profile.name === expectedName, "Profile name mismatch.", { profileName: profile.name, expectedName });
  assert(profile.storage && typeof profile.storage === "object", "Profile storage metadata is missing.");
  assert(isSafeRelativeStoragePath(profile.storage.userDataDir), "Profile userDataDir is not a safe relative path.", {
    userDataDir: profile.storage.userDataDir,
  });
  return profile;
}

function assertPresetList(result) {
  assert(result.identityVersion === 1, "Preset list did not return identityVersion 1.", { identityVersion: result.identityVersion });
  assert(Array.isArray(result.presets), "Preset list did not return an array.");
  const preset = result.presets.find((item) => item?.presetId === PRESET_ID);
  assert(preset, "Preset list did not include the S05 curated CDP proof preset.", { presetId: PRESET_ID, presetCount: result.presets.length });
  return preset;
}

function assertAppliedIdentity(result, profile, preset) {
  assert(result.storeVersion === 4, "Identity apply did not preserve store v4.", { storeVersion: result.storeVersion });
  assert(Array.isArray(result.warnings) && result.warnings.length === 0, "Curated identity preset should apply without warnings.", {
    warnings: result.warnings,
  });
  assert(result.profile?.id === profile.id, "Identity apply profile id mismatch.", { profileId: result.profile?.id, expectedProfileId: profile.id });
  assert(result.profile?.identity?.presetId === PRESET_ID, "Identity apply did not persist preset id.", { presetId: result.profile?.identity?.presetId });
  assert(JSON.stringify(result.profile.identity) === JSON.stringify(preset), "Persisted identity does not match preset payload.", { presetId: PRESET_ID });
  return result.profile.identity;
}

function assertProxySummary(proxy, expected) {
  assert(proxy?.proxyVersion === 1, "Proxy summary did not report proxyVersion 1.");
  assert(proxy.mode === "fixedServer", "Proxy summary did not report fixedServer mode.", { mode: proxy.mode });
  assert(proxy.protocol === expected.protocol, "Proxy summary protocol mismatch.", { protocol: proxy.protocol, expectedProtocol: expected.protocol });
  assert(proxy.host === expected.host, "Proxy summary host mismatch.", { host: proxy.host, expectedHost: expected.host });
  assert(proxy.port === expected.port, "Proxy summary port mismatch.", { port: proxy.port, expectedPort: expected.port });
  assert(proxy.credentialState === expected.credentialState, "Proxy credential state mismatch.", {
    credentialState: proxy.credentialState,
    expectedCredentialState: expected.credentialState,
  });
  assert(!("credentials" in proxy), "Public proxy summary leaked credentials.");
  assert(!("username" in proxy), "Public proxy summary leaked username.");
  assert(!("password" in proxy), "Public proxy summary leaked password.");
}

function assertRunningPayload(payload, profile) {
  assert(payload.profileId === profile.id, "Chromium running payload profile id mismatch.", { profileId: payload.profileId, expectedProfileId: profile.id });
  assert(payload.status === "running", "Chromium payload did not report running.", { status: payload.status });
  assert(Number.isInteger(payload.pid) && payload.pid > 0, "Chromium running payload is missing positive pid.", { pid: payload.pid });
  assert(typeof payload.startedAt === "string" && payload.startedAt.endsWith("Z"), "Chromium running payload is missing startedAt.", { startedAt: payload.startedAt });
  assert(payload.userDataDir === profile.storage.userDataDir, "Chromium running userDataDir mismatch.", { userDataDir: payload.userDataDir, expectedUserDataDir: profile.storage.userDataDir });
  return payload;
}

function assertStoppedPayload(payload, profile) {
  assert(payload.profileId === profile.id, "Chromium stopped payload profile id mismatch.", { profileId: payload.profileId, expectedProfileId: profile.id });
  assert(payload.status === "stopped", "Chromium stop payload did not report stopped.", { status: payload.status });
  assert(["graceful", "forced", "reconciled", "already-stopped"].includes(payload.termination), "Unexpected Chromium termination kind.", { termination: payload.termination });
  assert(payload.runningCount === 0, "Chromium stop payload did not clear running count.", { runningCount: payload.runningCount });
  assert(payload.userDataDir === profile.storage.userDataDir, "Chromium stopped userDataDir mismatch.", { userDataDir: payload.userDataDir, expectedUserDataDir: profile.storage.userDataDir });
  return payload;
}

function assertStatusStopped(payload) {
  assert(payload.runningCount === 0, "Chromium status did not report zero running profiles.", { runningCount: payload.runningCount });
  assert(Array.isArray(payload.profiles) && payload.profiles.length === 0, "Chromium status retained running profiles.", { profiles: payload.profiles });
  assert(Array.isArray(payload.reconciled), "Chromium status reconciled field is not an array.", { reconciled: payload.reconciled });
  return payload;
}

function readTextIfExists(path) {
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf8");
}

function readJsonIfExists(path, fallback = null) {
  const text = readTextIfExists(path);
  if (!text) {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail("Expected JSON file was malformed.", { path: relative(ROOT_DIR, path), error: error instanceof Error ? error.message : String(error) });
  }
}

function userDataPath(storeRoot, profile) {
  const path = join(storeRoot, ...profile.storage.userDataDir.split("/"));
  rememberSensitive(path);
  return path;
}

function runtimeRegistryPath(storeRoot) {
  return join(storeRoot, "profile-store", "runtime", "chromium-processes.json");
}

function diagnosticsPath(storeRoot) {
  return join(storeRoot, "profile-store", "diagnostics", "events.jsonl");
}

function profileStorePath(storeRoot) {
  return join(storeRoot, "profile-store", "profiles.json");
}

function assertRuntimeRegistryEmpty(storeRoot) {
  const payload = readJsonIfExists(runtimeRegistryPath(storeRoot), { registryVersion: 1, processes: {} });
  assert(payload.registryVersion === 1, "Runtime registry version mismatch after cleanup.", { registryVersion: payload.registryVersion });
  assert(payload.processes && typeof payload.processes === "object" && !Array.isArray(payload.processes), "Runtime registry processes field is invalid.");
  assert(Object.keys(payload.processes).length === 0, "Runtime registry retained processes after cleanup.", { processCount: Object.keys(payload.processes).length });
  return { processCount: 0 };
}

function assertPrivateProfileStoreSafe(storeRoot, profileId, expectedProxy) {
  const path = profileStorePath(storeRoot);
  assert(existsSync(path), "profiles.json was not written.");
  const text = readFileSync(path, "utf8");
  assertNoPrivateStoreRuntimeLeaks("profiles.json", text);
  const payload = JSON.parse(text);
  assert(payload.storeVersion === 4, "profiles.json did not remain store v4.", { storeVersion: payload.storeVersion });
  const profile = payload.profiles.find((item) => item?.id === profileId);
  assert(profile, "profiles.json does not contain the proof profile.", { profileId });
  assert(profile.proxy?.protocol === expectedProxy.protocol, "Persisted proxy protocol mismatch.", { protocol: profile.proxy?.protocol, expectedProtocol: expectedProxy.protocol });
  assert(profile.proxy?.host === expectedProxy.host, "Persisted proxy host mismatch.", { host: profile.proxy?.host, expectedHost: expectedProxy.host });
  assert(profile.proxy?.port === expectedProxy.port, "Persisted proxy port mismatch.", { port: profile.proxy?.port, expectedPort: expectedProxy.port });
  const hasCredentials = Boolean(expectedProxy.credentials);
  assert(Boolean(profile.proxy?.credentials) === hasCredentials, "Persisted proxy credential presence mismatch.", { hasCredentials });
  const summary = { storeVersion: payload.storeVersion, profileCount: payload.profiles.length, credentialState: hasCredentials ? "private" : "none" };
  PROFILE_STORE_SUMMARIES.push(summary);
  return summary;
}

function assertNoPrivateStoreRuntimeLeaks(label, text) {
  for (const marker of PRIVATE_STORE_FORBIDDEN_MARKERS) {
    assert(!text.includes(marker), `${label} leaked runtime/debug marker.`, { marker });
  }
  assert(!text.includes(ROOT_DIR), `${label} leaked the repository path.`);
}

function assertLaunchArgsMarkerGuard() {
  const marker = "--user-data-dir";
  const probe = JSON.stringify({ storeVersion: 4, profiles: [{ launch: { args: [`${marker}=/probe`] } }] });
  let failure = null;
  try {
    assertNoPrivateStoreRuntimeLeaks("launch args probe", probe);
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof VerifyFailure, "Private store marker guard missed a runtime marker inside launch.args.");
  assert(failure.details?.marker === marker, "Private store marker guard tripped on an unexpected marker.", { marker: failure.details?.marker });
  // Step results are swept against PUBLIC_FORBIDDEN_MARKERS, so the probed marker must not appear in this summary.
  return { guard: "private-store-runtime-markers", probe: "launch.args", tripped: true };
}

function parseDiagnosticsLog(storeRoot) {
  const path = diagnosticsPath(storeRoot);
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, "utf8");
  assertNoPublicLeaks("diagnostics log", text);
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      const entry = JSON.parse(line);
      assertDiagnosticEntrySafe(entry, index + 1);
      return entry;
    } catch (error) {
      if (error instanceof VerifyFailure) {
        throw error;
      }
      fail("Persisted diagnostic line is not valid JSON.", { lineNumber: index + 1, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function assertDiagnosticEntrySafe(entry, lineNumber) {
  const allowedKeys = new Set(["schemaVersion", "ts", "source", "event", "status", "logPath", "requestId", "method", "durationMs", "errorCode", "detailRef"]);
  for (const key of Object.keys(entry)) {
    assert(allowedKeys.has(key), "Persisted diagnostic contained an unexpected field.", { lineNumber, key });
  }
  assert(entry.event === "sidecar.request", "Persisted diagnostic event name changed.", { lineNumber, event: entry.event });
  assert(!("params" in entry), "Persisted diagnostic leaked params.", { lineNumber });
}

function lookupDiagnosticDetail(storeRoot, detailRef) {
  const entries = parseDiagnosticsLog(storeRoot).filter((entry) => entry.detailRef === detailRef);
  return {
    found: entries.length > 0,
    logPath: "profile-store/diagnostics/events.jsonl",
    entries,
  };
}

function assertDiagnosticLookup(storeRoot, detailRef, expected) {
  const lookup = lookupDiagnosticDetail(storeRoot, detailRef);
  assert(lookup.found === true, "Diagnostic lookup did not find the expected detailRef.", { detailRef, expected });
  assert(lookup.entries.length === 1, "Diagnostic lookup did not return exactly one matching row.", { detailRef, count: lookup.entries.length });
  const entry = lookup.entries[0];
  assert(entry.requestId === expected.requestId, "Diagnostic lookup requestId mismatch.", { requestId: entry.requestId, expectedRequestId: expected.requestId });
  assert(entry.method === expected.method, "Diagnostic lookup method mismatch.", { method: entry.method, expectedMethod: expected.method });
  assert(entry.status === expected.status, "Diagnostic lookup status mismatch.", { status: entry.status, expectedStatus: expected.status });
  assert(entry.errorCode === expected.errorCode, "Diagnostic lookup errorCode mismatch.", { errorCode: entry.errorCode, expectedErrorCode: expected.errorCode });
  return { detailRef, errorCode: entry.errorCode, method: entry.method };
}

function assertNoPublicLeaks(label, value, extra = []) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const sensitive of activeSensitiveValues(extra)) {
    assert(!text.includes(sensitive), `${label} leaked a sensitive value.`, { label, leaked: sensitive === ROOT_DIR ? "repo-root" : "sentinel-or-path" });
  }
  for (const marker of PUBLIC_FORBIDDEN_MARKERS) {
    assert(!text.includes(marker), `${label} leaked a forbidden public marker.`, { label, marker });
  }
  assert(!/wss?:\/\//i.test(text), `${label} leaked a WebSocket URL.`, { label });
}

function visitPublicPayload(value, visitor, pathParts = []) {
  visitor(value, pathParts);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitPublicPayload(item, visitor, [...pathParts, String(index)]));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      visitPublicPayload(nested, visitor, [...pathParts, key]);
    }
  }
}

function assertNoRawPublicCheckerContent(value, label) {
  const rawContentKeys = new Set(["rawTranscript", "responseBody", "html", "content", "bodyText", "pageText", "screenshot", "dom"]);
  visitPublicPayload(value, (nested, pathParts) => {
    const key = pathParts.at(-1) ?? label;
    assert(!rawContentKeys.has(key), "Public checker surface exposed raw page content.", { label, path: pathParts.join(".") });
    if (typeof nested === "string") {
      assert(!/theprivator proxy proof/i.test(nested), "Verifier surface exposed raw fixture/public checker content.", { label, path: pathParts.join(".") });
    }
  });
}

function assertFinalSurfaceRedacted(label, value) {
  assertNoPublicLeaks(label, value);
  assertNoRawPublicCheckerContent(value, label);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert(!/profile-store\/profiles\/[^"\s]+\/user-data/i.test(text), `${label} leaked a profile user-data path.`, { label });
  assert(!/profile-store\/runtime\//i.test(text), `${label} leaked a profile runtime path.`, { label });
}

function assertVerifierEventsRedacted() {
  assertFinalSurfaceRedacted("verifier events", VERIFIER_EVENTS);
  return { emittedEvents: VERIFIER_EVENTS.length };
}

function assertTranscriptRedaction(transcripts) {
  const publicText = transcripts.map((item) => `${item.stdout}\n${item.stderr}`).join("\n");
  assertNoPublicLeaks("sidecar transcripts", publicText);
  return { transcriptCount: transcripts.length };
}

function assertProfileStoreSummariesRedacted() {
  assertFinalSurfaceRedacted("profile-store summaries", PROFILE_STORE_SUMMARIES);
  return { profileStoreSummaryCount: PROFILE_STORE_SUMMARIES.length };
}

function assertPublicCommandResultSummariesRedacted() {
  const summaries = ALL_TRANSCRIPTS.map((transcript) => ({
    requestId: transcript.requestId,
    method: transcript.method,
    ok: transcript.response?.ok === true,
    status: transcript.response?.result?.status ?? transcript.response?.result?.routeProof?.status ?? null,
    errorCode: transcript.response?.error?.code ?? null,
    detailRef: transcript.response?.error?.detailRef ?? null,
  }));
  assertFinalSurfaceRedacted("public command result summaries", summaries);
  return { publicCommandResultCount: summaries.length };
}

class LineProcess {
  constructor(child, label) {
    this.child = child;
    this.label = label;
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
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      while (this.waiters.length) {
        const waiter = this.waiters.shift();
        waiter.reject(new Error(`${label} exited before emitting the expected line.`));
      }
    });
  }

  readLine(timeoutMs) {
    if (this.lines.length) {
      return Promise.resolve(this.lines.shift());
    }
    if (this.exited) {
      return Promise.reject(new Error(`${this.label} already exited.`));
    }
    return new Promise((resolveLine, rejectLine) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((item) => item.resolve === resolveLine);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        rejectLine(new Error(`${this.label} timed out waiting for output.`));
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
      assertNoPublicLeaks(`${this.label} output`, line);
      return payload;
    } catch (error) {
      if (error instanceof VerifyFailure) {
        throw error;
      }
      fail(`${this.label} emitted malformed JSON.`, { lineTail: normalizeOutput(line), error: error instanceof Error ? error.message : String(error) });
    }
  }

  send(payload) {
    if (this.exited) {
      fail(`${this.label} is not running.`, { exitCode: this.exitCode, signal: this.exitSignal, stderrTail: normalizeOutput(this.stderr) });
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
      await waitForExit(this.child, 2_000);
      assertNoPublicLeaks(`${this.label} stderr`, this.stderr);
      return response;
    } catch (error) {
      this.child.kill("SIGTERM");
      try {
        await waitForExit(this.child, 1_000);
      } catch {
        this.child.kill("SIGKILL");
      }
      if (error instanceof VerifyFailure) {
        throw error;
      }
      fail(`${this.label} cleanup failed.`, { error: error instanceof Error ? error.message : String(error), stderrTail: normalizeOutput(this.stderr) });
    }
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("process exit timed out")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function startProxyFixture(config) {
  const child = spawn(PYTHON, ["-u", "-c", PROXY_FIXTURE_MANAGER], {
    cwd: ROOT_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const lineProcess = new LineProcess(child, `proxy fixture ${config.label}`);
  lineProcess.send(config);
  const ready = await lineProcess.readJson(FIXURE_READY_TIMEOUT_SAFE());
  assert(ready.ok === true, "Proxy fixture did not become ready.", { label: config.label, error: ready.error, stderrTail: normalizeOutput(lineProcess.stderr) });
  assert(ready.proxy?.mode === "fixedServer", "Proxy fixture ready payload was malformed.", { ready });
  return {
    label: config.label,
    process: lineProcess,
    ready,
    async observations() {
      lineProcess.send({ cmd: "observations" });
      const response = await lineProcess.readJson(FIXTURE_COMMAND_TIMEOUT_MS);
      assert(response.ok === true, "Proxy fixture observations command failed.", { label: config.label, response });
      return { proxy: response.proxy ?? [], target: response.target ?? [] };
    },
    async stop() {
      return lineProcess.stop();
    },
  };
}

function FIXURE_READY_TIMEOUT_SAFE() {
  return FIXTURE_READY_TIMEOUT_MS;
}

async function waitForObservation(fixture, predicate, label, timeoutMs = 4_000) {
  const deadline = performance.now() + timeoutMs;
  let latest = { proxy: [], target: [] };
  while (performance.now() <= deadline) {
    latest = await fixture.observations();
    if (predicate(latest)) {
      return latest;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  fail("Timed out waiting for expected proxy fixture observation.", { label, latest });
}

function runPythonJson(name, code, input, timeoutMs, extraSensitive = []) {
  const result = spawnSync(PYTHON, ["-u", "-c", code], {
    cwd: ROOT_DIR,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  const sensitive = activeSensitiveValues(extraSensitive);
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      fail(`${name} timed out.`, { timeoutMs, stdoutTail: normalizeOutput(result.stdout, sensitive), stderrTail: normalizeOutput(result.stderr, sensitive) });
    }
    fail(`${name} failed.`, { error: result.error.message, stdoutTail: normalizeOutput(result.stdout, sensitive), stderrTail: normalizeOutput(result.stderr, sensitive) });
  }
  assertNoPublicLeaks(`${name} stdout/stderr`, `${result.stdout}\n${result.stderr}`, sensitive);
  const [payload] = parseNdjsonLines(`${name} stdout`, result.stdout, 1, sensitive);
  if (result.status !== 0 && payload.ok !== true) {
    return { ...payload, exitCode: result.status, stderr: result.stderr, stdout: result.stdout };
  }
  if (result.status !== 0) {
    fail(`${name} exited with status ${result.status ?? "unknown"}.`, { stdoutTail: normalizeOutput(result.stdout, sensitive), stderrTail: normalizeOutput(result.stderr, sensitive) });
  }
  return { ...payload, stdout: result.stdout, stderr: result.stderr };
}

function runProxyNavigation(userDataPathValue, targetUrl, label) {
  rememberSensitive(userDataPathValue);
  const timeoutSeconds = CDP_NAVIGATION_TIMEOUT_MS / 1000;
  const payload = runPythonJson(
    `proxy navigation ${label}`,
    PROXY_CDP_NAVIGATOR,
    { userDataPath: userDataPathValue, targetUrl, timeoutSeconds },
    CDP_NAVIGATION_TIMEOUT_MS + 10_000,
    [userDataPathValue],
  );
  return payload;
}

function runIdentityProof(userDataPathValue) {
  rememberSensitive(userDataPathValue);
  const result = spawnSync(PYTHON, ["-u", "-c", IDENTITY_PROOF_COLLECTOR, userDataPathValue], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROOF_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      fail("Identity proof collector timed out.", { timeoutMs: PROOF_TIMEOUT_MS, stdoutTail: normalizeOutput(result.stdout), stderrTail: normalizeOutput(result.stderr) });
    }
    fail("Identity proof collector failed.", { error: result.error.message, stdoutTail: normalizeOutput(result.stdout), stderrTail: normalizeOutput(result.stderr) });
  }
  assertNoPublicLeaks("identity proof stdout/stderr", `${result.stdout}\n${result.stderr}`, [userDataPathValue]);
  const [payload] = parseNdjsonLines("identity proof stdout", result.stdout, 1, [userDataPathValue]);
  if (result.status !== 0 || payload.ok !== true) {
    fail("Identity proof collector failed.", { exitCode: result.status, errorCode: payload.error?.code, detailRef: payload.error?.detailRef, message: payload.error?.message });
  }
  assert(payload.proof && typeof payload.proof === "object", "Identity proof collector returned no proof payload.");
  return { proof: payload.proof, stdout: result.stdout, stderr: result.stderr };
}

function assertRepresentativeIdentityProof(proof, identity) {
  assert(proof.schemaVersion === 1, "Identity proof schema version mismatch.", { schemaVersion: proof.schemaVersion });
  assert(proof.browser?.userAgent === identity.browser.userAgent, "Identity proof userAgent mismatch.");
  assert(proof.navigator?.platform === identity.navigator.platform, "Identity proof navigator.platform mismatch.");
  assert(proof.locale?.timezone === identity.locale.timezoneId, "Identity proof timezone mismatch.");
  assert(proof.viewport?.innerWidth === identity.screen.viewportWidth, "Identity proof viewport width mismatch.");
  assert(proof.webgl?.vendor === identity.webgl.vendor, "Identity proof WebGL vendor mismatch.");
  assert(proof.webrtc?.icePolicy === "relay", "Identity proof did not preserve non-proxied UDP WebRTC policy.", { webrtc: proof.webrtc });
  assertNoPublicLeaks("identity proof payload", JSON.stringify(proof));
  return {
    userAgent: "matched",
    navigator: "matched",
    timezone: "matched",
    viewport: "matched",
    webgl: "matched",
    webrtc: "relay",
  };
}

function findGeneratedExtension(root, requiredFiles) {
  assert(existsSync(root), "Expected extension root was not generated.");
  const children = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  assert(children.length >= 1, "Expected extension root did not contain generated extension directories.");
  const extensionDir = join(root, children[0].name);
  rememberSensitive(extensionDir);
  for (const file of requiredFiles) {
    assert(existsSync(join(extensionDir, file)), "Generated extension directory is missing a required file.", { file });
  }
  return "present";
}

function assertCompositeArtifacts(storeRoot, profileId) {
  void profileId;
  const identityRoot = join(storeRoot, "profile-store", "runtime", "identity-extensions");
  const proxyRoot = join(storeRoot, "profile-store", "runtime", "proxy-auth-extensions");
  rememberSensitive(identityRoot);
  rememberSensitive(proxyRoot);
  return {
    identityExtension: findGeneratedExtension(identityRoot, ["manifest.json", "identity_config.js", "identity_protector.js"]),
    proxyAuthExtension: findGeneratedExtension(proxyRoot, ["manifest.json", "proxy_auth_config.js", "proxy_auth_worker.js"]),
  };
}

function assertNoRuntimeArtifacts(storeRoot, label) {
  const runtimeRoot = join(storeRoot, "profile-store", "runtime");
  const identityRoot = join(runtimeRoot, "identity-extensions");
  const proxyRoot = join(runtimeRoot, "proxy-auth-extensions");
  assert(!existsSync(runtimeRoot), `${label} created a runtime registry or extension root before the expected pre-spawn failure.`, { label, runtime: "absent" });
  assert(!existsSync(identityRoot), `${label} generated identity artifacts before proxy validation failed.`, { label });
  assert(!existsSync(proxyRoot), `${label} generated proxy-auth artifacts before proxy validation failed.`, { label });
  return { runtimeRoot: "absent", identityArtifacts: "absent", proxyAuthArtifacts: "absent" };
}

function exactKeys(value, keys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`, { label });
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} keys changed.`, { label, actual, expected });
}

function assertProxyCheckVocabulary(result, profile, expectedProxy) {
  exactKeys(result, ["proxyCheckVersion", "profileId", "proxy", "routeProof", "ipHiding", "webRtc", "publicCheckers"], "proxy-check result");
  assert(result.proxyCheckVersion === 1, "Proxy-check version changed.", { proxyCheckVersion: result.proxyCheckVersion });
  assert(result.profileId === profile.id, "Proxy-check profile id mismatch.", { profileId: result.profileId, expectedProfileId: profile.id });
  assertProxySummary(result.proxy, {
    protocol: expectedProxy.protocol,
    host: expectedProxy.host,
    port: expectedProxy.port,
    credentialState: expectedProxy.credentials ? "configured" : "none",
  });

  exactKeys(result.routeProof, ["status", "basis", "scope", "protocol", "credentialState", "durationMs", "fixture", "target", "directFallbackDetected", "observationCounts"], "routeProof");
  assert(result.routeProof.status === "proved", "routeProof status mismatch.", { status: result.routeProof.status });
  assert(result.routeProof.directFallbackDetected === false, "routeProof detected direct fallback.", { directFallbackDetected: result.routeProof.directFallbackDetected });
  assert(result.routeProof.credentialState === "configured", "routeProof credential state mismatch.", { credentialState: result.routeProof.credentialState });
  assert(result.routeProof.protocol === expectedProxy.protocol, "routeProof protocol mismatch.", { protocol: result.routeProof.protocol, expectedProtocol: expectedProxy.protocol });
  assert(result.routeProof.observationCounts?.proxy > 0 && result.routeProof.observationCounts?.target > 0, "routeProof observation counts must be positive.", { observationCounts: result.routeProof.observationCounts });

  exactKeys(result.ipHiding, ["status", "basis", "scope", "publicExitIpClaimed", "publicExitIp", "localFixtureConclusion"], "ipHiding");
  assert(result.ipHiding.status === "proved", "ipHiding status mismatch.", { status: result.ipHiding.status });
  assert(result.ipHiding.publicExitIpClaimed === false, "ipHiding must not claim a public exit IP.", { publicExitIpClaimed: result.ipHiding.publicExitIpClaimed });

  exactKeys(result.webRtc, ["status", "basis", "mode", "policy", "localIpExposure"], "webRtc");
  assert(result.webRtc.status === "restricted", "webRtc status mismatch.", { status: result.webRtc.status });
  assert(result.webRtc.localIpExposure === "non-proxied-udp-disabled", "webRtc local IP exposure mismatch.", { localIpExposure: result.webRtc.localIpExposure });

  exactKeys(result.publicCheckers, ["status", "basis", "networkDependency", "pages"], "publicCheckers");
  assert(result.publicCheckers.status === "advisory-only", "publicCheckers status mismatch.", { status: result.publicCheckers.status });
  assert(Array.isArray(result.publicCheckers.pages) && result.publicCheckers.pages.length >= 1, "publicCheckers pages missing.", { pageCount: result.publicCheckers.pages?.length });
  for (const page of result.publicCheckers.pages) {
    exactKeys(page, ["id", "label", "url", "surfaces", "advisory"], `publicCheckers.${page?.id ?? "page"}`);
  }
  assertFinalSurfaceRedacted("proxy-check result", result);
  return {
    routeProof: { status: result.routeProof.status, observationCounts: result.routeProof.observationCounts },
    ipHiding: { status: result.ipHiding.status, publicExitIpClaimed: result.ipHiding.publicExitIpClaimed },
    webRtc: { status: result.webRtc.status, localIpExposure: result.webRtc.localIpExposure },
    publicCheckers: { status: result.publicCheckers.status, pageCount: result.publicCheckers.pages.length },
  };
}

function assertSuccessfulProxyProof(caseConfig, navigation, observations) {
  assert(navigation.ok === true, "Proxy navigation failed for a supported case.", { caseLabel: caseConfig.label, navigation });
  assert(navigation.navigation?.status === "navigated", "Proxy navigation did not report navigated.", { caseLabel: caseConfig.label, navigation: navigation.navigation });
  assert(navigation.navigation?.marker === "present", "Proxy target marker was not observed through CDP.", { caseLabel: caseConfig.label, navigation: navigation.navigation });
  const accepted = observations.proxy.filter((item) => item?.status === "accepted");
  assert(accepted.length >= 1, "Proxy fixture did not observe an accepted routed request.", { caseLabel: caseConfig.label, observations });
  assert(observations.target.some((item) => Number(item?.status) === 200), "Target fixture did not observe the proof request.", { caseLabel: caseConfig.label, observations });
  if (caseConfig.profileCredentials) {
    assert(accepted.some((item) => item?.auth === "accepted"), "Credentialed proxy case never observed accepted proxy authentication.", { caseLabel: caseConfig.label, observations });
  } else {
    assert(!observations.proxy.some((item) => item?.status === "auth-failed"), "No-auth proxy case unexpectedly observed auth failure.", { caseLabel: caseConfig.label, observations });
  }
  return {
    caseLabel: caseConfig.label,
    fixtureKind: caseConfig.kind,
    navigation: "marker-present",
    proxyObservations: observations.proxy.length,
    targetObservations: observations.target.length,
    directFallbackDetected: false,
  };
}

function assertAuthFailureProof(caseConfig, navigation, observations) {
  assert(navigation.ok === false || navigation.navigation?.marker !== "present", "Wrong credentials unexpectedly navigated to the proof target.", { caseLabel: caseConfig.label, navigation });
  assert(observations.proxy.some((item) => item?.status === "auth-failed"), "Wrong credentials did not produce proxy auth-failed observation.", { caseLabel: caseConfig.label, observations });
  assert(observations.target.length === 0, "Wrong credentials should not reach the target fixture.", { caseLabel: caseConfig.label, observations });
  return {
    caseLabel: caseConfig.label,
    errorCode: "PROXY_CONNECTIVITY_FAILED",
    failureClass: "auth-failed",
    proxyObservations: observations.proxy.length,
    targetObservations: observations.target.length,
  };
}

function assertInvalidMappingProof(caseConfig, navigation, observations) {
  assert(navigation.ok === false || navigation.navigation?.marker !== "present", "Invalid target mapping unexpectedly navigated to the proof target.", { caseLabel: caseConfig.label, navigation });
  assert(observations.proxy.some((item) => item?.status === "target-unmapped" || item?.status === "connectivity-failed"), "Invalid target mapping did not produce a proxy connectivity observation.", { caseLabel: caseConfig.label, observations });
  assert(observations.target.length === 0, "Invalid target mapping should not reach the target fixture.", { caseLabel: caseConfig.label, observations });
  return {
    caseLabel: caseConfig.label,
    errorCode: "PROXY_CONNECTIVITY_FAILED",
    failureClass: "target-unmapped",
    proxyObservations: observations.proxy.length,
    targetObservations: observations.target.length,
  };
}

function assertUnreachableProxyProof(caseConfig, navigation) {
  assert(navigation.ok === false || navigation.navigation?.marker !== "present", "Unreachable proxy unexpectedly navigated to the proof target.", { caseLabel: caseConfig.label, navigation });
  return {
    caseLabel: caseConfig.label,
    errorCode: "PROXY_CONNECTIVITY_FAILED",
    failureClass: "proxy-unreachable",
    directFallbackDetected: false,
  };
}

async function createProfileWithProxy(binaryPath, storeRoot, caseConfig, proxy, preset) {
  const profileName = `S05 ${caseConfig.label}`.slice(0, 95);
  const create = sidecarSuccess(
    binaryPath,
    makeRequestId(`${safeLabel(caseConfig.label)}-create`),
    "profiles.create",
    { storeRoot, name: profileName },
  ).result;
  assert(create.storeVersion === 4, "Profile create did not return store v4.", { storeVersion: create.storeVersion });
  const profile = assertProfileShape(create.profile, profileName);

  const applied = sidecarSuccess(
    binaryPath,
    makeRequestId(`${safeLabel(caseConfig.label)}-identity`),
    "profiles.identity.applyPreset",
    { storeRoot, profileId: profile.id, presetId: PRESET_ID },
  ).result;
  const identity = assertAppliedIdentity(applied, profile, preset);

  const updated = sidecarSuccess(
    binaryPath,
    makeRequestId(`${safeLabel(caseConfig.label)}-proxy`),
    "profiles.proxy.update",
    { storeRoot, profileId: profile.id, proxy },
  ).result;
  assert(updated.storeVersion === 4, "Proxy update did not preserve store v4.", { storeVersion: updated.storeVersion });
  assert(updated.profile?.id === profile.id, "Proxy update profile id mismatch.", { profileId: updated.profile?.id, expectedProfileId: profile.id });
  assertProxySummary(updated.profile.proxy, {
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    credentialState: proxy.credentials ? "configured" : "none",
  });

  return { profile: updated.profile, identity };
}

function launchProfile(binaryPath, storeRoot, profile, caseConfig, env = {}) {
  const launch = sidecarSuccess(
    binaryPath,
    makeRequestId(`${safeLabel(caseConfig.label)}-launch`),
    "chromium.launch",
    { storeRoot, profileId: profile.id },
    { timeoutMs: CHROMIUM_LAUNCH_TIMEOUT_MS, env },
  ).result;
  return assertRunningPayload(launch, profile);
}

function stopProfile(binaryPath, storeRoot, profile, label) {
  const stop = sidecarSuccess(
    binaryPath,
    makeRequestId(`${safeLabel(label)}-stop`),
    "chromium.stop",
    { storeRoot, profileId: profile.id },
    { timeoutMs: SIDECAR_TIMEOUT_MS },
  ).result;
  return assertStoppedPayload(stop, profile);
}

function statusStopped(binaryPath, storeRoot, label) {
  const status = sidecarSuccess(
    binaryPath,
    makeRequestId(`${safeLabel(label)}-status`),
    "chromium.status",
    { storeRoot },
    { timeoutMs: SIDECAR_TIMEOUT_MS },
  ).result;
  return assertStatusStopped(status);
}

async function runFixtureBackedCase(binaryPath, preset, caseConfig) {
  const storeRoot = makeTempRoot(`theprivator-s05-${safeLabel(caseConfig.label)}-`);
  let fixture = null;
  let profile = null;
  let launched = false;
  const transcriptsBefore = ALL_TRANSCRIPTS.length;
  try {
    emit({ phase: "case-start", caseLabel: caseConfig.label, fixtureKind: caseConfig.kind, expectation: caseConfig.expectation });
    const targetHost = caseConfig.targetHost ?? TARGET_HOST;
    const targetPort = caseConfig.targetPort ?? 80;
    fixture = await startProxyFixture({
      label: caseConfig.label,
      kind: caseConfig.kind,
      targetHost,
      targetPort,
      targetPath: TARGET_PATH,
      fixtureTargetHost: caseConfig.fixtureTargetHost ?? targetHost,
      fixtureCredentials: caseConfig.fixtureCredentials ?? null,
      profileCredentials: caseConfig.profileCredentials ?? null,
    });
    const proxy = { ...fixture.ready.proxy };
    if (caseConfig.profileCredentials) {
      proxy.credentials = caseConfig.profileCredentials;
    }
    const certificateTrust = fixture.ready.certificateTrust;
    if (certificateTrust?.spkiSha256) {
      rememberSensitive(certificateTrust.spkiSha256);
    }
    const { profile: createdProfile, identity } = await createProfileWithProxy(binaryPath, storeRoot, caseConfig, proxy, preset);
    profile = createdProfile;
    const launchEnv = {};
    if (certificateTrust?.spkiSha256) {
      launchEnv.THEPRIVATOR_ENABLE_PROXY_PROOF_TRUST = "1";
      launchEnv.THEPRIVATOR_PROXY_PROOF_SPKI_SHA256 = certificateTrust.spkiSha256;
    }
    const launch = launchProfile(binaryPath, storeRoot, profile, caseConfig, launchEnv);
    launched = true;
    const dataPath = userDataPath(storeRoot, profile);
    emit({ phase: "launch", caseLabel: caseConfig.label, status: "running", fixtureKind: caseConfig.kind });
    let identityProof = null;
    let artifacts = null;
    if (caseConfig.identityProof) {
      artifacts = assertCompositeArtifacts(storeRoot, profile.id);
      const proofTranscript = runIdentityProof(dataPath);
      identityProof = assertRepresentativeIdentityProof(proofTranscript.proof, identity);
      assertNoPublicLeaks("identity proof transcript", `${proofTranscript.stdout}\n${proofTranscript.stderr}`);
      emit({ phase: "identity-composition", caseLabel: caseConfig.label, status: "pass", artifacts, identityProof });
    }
    const navigation = runProxyNavigation(dataPath, fixture.ready.target.url, caseConfig.label);

    const observations = await waitForObservation(
      fixture,
      (items) => {
        if (caseConfig.expectation === "success") {
          return items.proxy.length > 0 && items.target.length > 0;
        }
        if (caseConfig.expectation === "auth-failure") {
          return items.proxy.some((item) => item?.status === "auth-failed");
        }
        if (caseConfig.expectation === "invalid-mapping") {
          return items.proxy.some((item) => item?.status === "target-unmapped" || item?.status === "connectivity-failed");
        }
        return items.proxy.length > 0 || items.target.length > 0;
      },
      caseConfig.label,
    );

    let proof;
    if (caseConfig.expectation === "success") {
      proof = assertSuccessfulProxyProof(caseConfig, navigation, observations);
      emit({ phase: "route-observed", ...proof, status: "pass" });
      emit({ phase: "no-direct-fallback", caseLabel: caseConfig.label, status: "pass", directFallbackDetected: false });
    } else if (caseConfig.expectation === "auth-failure") {
      proof = assertAuthFailureProof(caseConfig, navigation, observations);
      emit({ phase: "auth-failure-observed", ...proof, status: "pass" });
    } else if (caseConfig.expectation === "invalid-mapping") {
      proof = assertInvalidMappingProof(caseConfig, navigation, observations);
      emit({ phase: "connectivity-failure-observed", ...proof, status: "pass" });
    } else {
      fail("Unknown fixture-backed proxy case expectation.", { caseLabel: caseConfig.label, expectation: caseConfig.expectation });
    }

    launched = false;
    stopProfile(binaryPath, storeRoot, profile, caseConfig.label);
    const status = statusStopped(binaryPath, storeRoot, caseConfig.label);
    const registry = assertRuntimeRegistryEmpty(storeRoot);
    const checkRequestId = makeRequestId(`${safeLabel(caseConfig.label)}-proxy-check`);
    const proxyCheck = sidecarSuccess(
      binaryPath,
      checkRequestId,
      "profiles.proxy.check",
      { storeRoot, profileId: profile.id },
      { timeoutMs: CHROMIUM_LAUNCH_TIMEOUT_MS },
    ).result;
    const proxyVocabulary = assertProxyCheckVocabulary(proxyCheck, profile, proxy);
    emit({ phase: "routeProof", caseLabel: caseConfig.label, status: "pass", proofStatus: proxyVocabulary.routeProof.status, observationCounts: proxyVocabulary.routeProof.observationCounts });
    emit({ phase: "ipHiding", caseLabel: caseConfig.label, status: "pass", proofStatus: proxyVocabulary.ipHiding.status, publicExitIpClaimed: proxyVocabulary.ipHiding.publicExitIpClaimed });
    emit({ phase: "webRtc", caseLabel: caseConfig.label, status: "pass", proofStatus: proxyVocabulary.webRtc.status, localIpExposure: proxyVocabulary.webRtc.localIpExposure });
    emit({ phase: "publicCheckers", caseLabel: caseConfig.label, status: "pass", proofStatus: proxyVocabulary.publicCheckers.status, pageCount: proxyVocabulary.publicCheckers.pageCount });
    const profileStore = assertPrivateProfileStoreSafe(storeRoot, profile.id, proxy);
    const diagnostics = parseDiagnosticsLog(storeRoot);
    assert(diagnostics.some((entry) => entry.requestId === checkRequestId && entry.method === "profiles.proxy.check" && entry.status === "ok"), "Proxy-check success diagnostic was not persisted.", { requestId: checkRequestId, diagnosticCount: diagnostics.length });
    const caseTranscripts = ALL_TRANSCRIPTS.slice(transcriptsBefore);
    assertTranscriptRedaction(caseTranscripts);
    assertVerifierEventsRedacted();
    assertNoPublicLeaks("diagnostics lookup", JSON.stringify(diagnostics));
    const cleanup = { status: "pass", runningCount: status.runningCount, registry, diagnostics: diagnostics.length };
    emit({ phase: "cleanup", caseLabel: caseConfig.label, ...cleanup });
    emit({ phase: "case-result", caseLabel: caseConfig.label, fixtureKind: caseConfig.kind, status: "pass", proof, identityProof, artifacts, profileStore, proxyVocabulary });
    return { caseLabel: caseConfig.label, fixtureKind: caseConfig.kind, proof, identityProof, proxyVocabulary, cleanup };
  } finally {
    if (launched && profile?.id) {
      try {
        stopProfile(binaryPath, storeRoot, profile, `${caseConfig.label}-cleanup`);
        statusStopped(binaryPath, storeRoot, `${caseConfig.label}-cleanup`);
      } catch {
        // The failing step already emitted safe details; cleanup must not mask it.
      }
    }
    if (fixture) {
      try {
        await fixture.stop();
      } catch {
        // Cleanup failures are reported by the owning step when observable.
      }
    }
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

async function runUnreachableProxyCase(binaryPath, preset) {
  const caseConfig = {
    label: "http-unreachable-proxy",
    kind: "http",
    expectation: "unreachable",
  };
  const storeRoot = makeTempRoot("theprivator-s05-unreachable-");
  let profile = null;
  let launched = false;
  const transcriptsBefore = ALL_TRANSCRIPTS.length;
  try {
    emit({ phase: "case-start", caseLabel: caseConfig.label, fixtureKind: caseConfig.kind, expectation: caseConfig.expectation });
    const proxy = {
      proxyVersion: 1,
      mode: "fixedServer",
      protocol: "http",
      host: "127.0.0.1",
      port: 9,
    };
    const created = await createProfileWithProxy(binaryPath, storeRoot, caseConfig, proxy, preset);
    profile = created.profile;
    launchProfile(binaryPath, storeRoot, profile, caseConfig);
    launched = true;
    const navigation = runProxyNavigation(userDataPath(storeRoot, profile), `http://${TARGET_HOST}${TARGET_PATH}?case=${safeLabel(caseConfig.label)}`, caseConfig.label);
    const proof = assertUnreachableProxyProof(caseConfig, navigation);
    emit({ phase: "connectivity-failure-observed", ...proof, status: "pass" });
    launched = false;
    stopProfile(binaryPath, storeRoot, profile, caseConfig.label);
    statusStopped(binaryPath, storeRoot, caseConfig.label);
    assertRuntimeRegistryEmpty(storeRoot);
    assertPrivateProfileStoreSafe(storeRoot, profile.id, proxy);
    const diagnostics = parseDiagnosticsLog(storeRoot);
    assertTranscriptRedaction(ALL_TRANSCRIPTS.slice(transcriptsBefore));
    assertVerifierEventsRedacted();
    assertNoPublicLeaks("diagnostics lookup", JSON.stringify(diagnostics));
    emit({ phase: "case-result", caseLabel: caseConfig.label, fixtureKind: caseConfig.kind, status: "pass", proof });
    return proof;
  } finally {
    if (launched && profile?.id) {
      try {
        stopProfile(binaryPath, storeRoot, profile, `${caseConfig.label}-cleanup`);
        statusStopped(binaryPath, storeRoot, `${caseConfig.label}-cleanup`);
      } catch {
        // Do not mask the original failure.
      }
    }
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

async function runSocksCredentialUnsupportedCase(binaryPath, preset) {
  const storeRoot = makeTempRoot("theprivator-s05-socks-auth-identity-");
  const caseLabel = "socks-auth-identity-pre-spawn-unsupported";
  const transcriptsBefore = ALL_TRANSCRIPTS.length;
  try {
    emit({ phase: "case-start", caseLabel, fixtureKind: "socks5", expectation: "typed-pre-spawn-error" });
    const profileName = "S05 SOCKS auth identity unsupported";
    const create = sidecarSuccess(
      binaryPath,
      makeRequestId("socks-auth-identity-create"),
      "profiles.create",
      { storeRoot, name: profileName },
    ).result;
    const profile = assertProfileShape(create.profile, profileName);
    const applied = sidecarSuccess(
      binaryPath,
      makeRequestId("socks-auth-identity-preset"),
      "profiles.identity.applyPreset",
      { storeRoot, profileId: profile.id, presetId: PRESET_ID },
    ).result;
    assertAppliedIdentity(applied, profile, preset);
    const proxy = {
      proxyVersion: 1,
      mode: "fixedServer",
      protocol: "socks5",
      host: "proxy.socks-auth.invalid",
      port: 9050,
      credentials: {
        username: PROXY_USERNAME,
        password: PROXY_PASSWORD,
      },
    };
    sidecarSuccess(
      binaryPath,
      makeRequestId("socks-auth-identity-proxy"),
      "profiles.proxy.update",
      { storeRoot, profileId: profile.id, proxy },
    );
    const missingChromium = join(storeRoot, "missing-chromium-should-not-mask-proxy-validation");
    rememberSensitive(missingChromium);
    const launch = sidecarError(
      binaryPath,
      makeRequestId("socks-auth-identity-launch"),
      "chromium.launch",
      { storeRoot, profileId: profile.id },
      {
        timeoutMs: CHROMIUM_LAUNCH_TIMEOUT_MS,
        env: { THEPRIVATOR_CHROMIUM_PATH: missingChromium },
      },
    );
    assert(launch.error.code === "PROXY_SOCKS_AUTH_UNSUPPORTED", "SOCKS credentials did not fail with the typed proxy error before executable discovery.", { errorCode: launch.error.code, detailRef: launch.error.detailRef });
    const lookup = assertDiagnosticLookup(storeRoot, launch.error.detailRef, {
      requestId: makeRequestId("socks-auth-identity-launch"),
      method: "chromium.launch",
      status: "error",
      errorCode: "PROXY_SOCKS_AUTH_UNSUPPORTED",
    });
    const runtimeArtifacts = assertNoRuntimeArtifacts(storeRoot, caseLabel);
    const status = statusStopped(binaryPath, storeRoot, caseLabel);
    const runtime = assertRuntimeRegistryEmpty(storeRoot);
    const privateStore = assertPrivateProfileStoreSafe(storeRoot, profile.id, proxy);
    const diagnostics = parseDiagnosticsLog(storeRoot);
    assertNoPublicLeaks("negative diagnostics lookup", JSON.stringify(diagnostics));
    assertTranscriptRedaction(ALL_TRANSCRIPTS.slice(transcriptsBefore));
    assertVerifierEventsRedacted();
    emit({ phase: "typed-negative-diagnostics", caseLabel, status: "pass", method: lookup.method, errorCode: launch.error.code, detailRef: launch.error.detailRef, runtime, runtimeArtifacts, privateStore, runningCount: status.runningCount });
    emit({ phase: "case-result", caseLabel, fixtureKind: "socks5", status: "pass", proof: { errorCode: launch.error.code, detailRef: launch.error.detailRef } });
    return { caseLabel, errorCode: launch.error.code, detailRef: launch.error.detailRef, diagnostics: lookup, runtimeArtifacts };
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

async function runHealthAndPresetSetup(binaryPath) {
  const health = await runStep("built-sidecar-health", () => {
    const result = sidecarSuccess(binaryPath, "verify-s05-health", "health.status", {}).result;
    assert(result.status, "Built sidecar health response is missing status.");
    assert(result.build?.mode === "pyinstaller", "verify:s05 must exercise the built sidecar binary.", { buildMode: result.build?.mode });
    return { status: result.status, buildMode: result.build.mode };
  });

  const preset = await runStep("identity-preset-for-cdp", () => {
    const result = sidecarSuccess(binaryPath, "verify-s05-presets", "identity.presets.list", {}).result;
    const selected = assertPresetList(result);
    return { value: selected, log: { presetId: selected.presetId, presetCount: result.count } };
  });
  return { health, preset };
}

async function main() {
  const targetTriple = await runStep("target-triple", () => {
    const value = readTargetTriple();
    assert(value, "rustc did not return a host target triple.");
    return { targetTriple: value };
  }).then((result) => result.targetTriple);
  const binaryPath = targetBinaryPath(targetTriple);
  await runStep("target-binary", () => assertTargetBinary(binaryPath, targetTriple));
  const { preset } = await runHealthAndPresetSetup(binaryPath);

  const compositionCase = {
    label: "https-auth-proxy-identity-composition",
    kind: "https",
    expectation: "success",
    fixtureCredentials: { username: PROXY_USERNAME, password: PROXY_PASSWORD },
    profileCredentials: { username: PROXY_USERNAME, password: PROXY_PASSWORD },
    identityProof: true,
  };

  const compositionProof = await runStep(
    "composition-success-https-auth-identity",
    () => runFixtureBackedCase(binaryPath, preset, compositionCase),
  );
  const typedNegative = await runStep(
    "typed-negative-socks-auth-identity-pre-spawn-unsupported",
    () => runSocksCredentialUnsupportedCase(binaryPath, preset),
  );

  await runStep("launch-args-marker-guard", () => assertLaunchArgsMarkerGuard());

  const redactionSweep = await runStep("redaction-sweep", () => {
    const transcripts = assertTranscriptRedaction(ALL_TRANSCRIPTS);
    const events = assertVerifierEventsRedacted();
    const profileStores = assertProfileStoreSummariesRedacted();
    const publicCommands = assertPublicCommandResultSummariesRedacted();
    const diagnostics = { diagnosticsJsonlScanned: true };
    const summary = {
      transcriptCount: transcripts.transcriptCount,
      verifierEvents: events.emittedEvents,
      profileStoreSummaryCount: profileStores.profileStoreSummaryCount,
      publicCommandResultCount: publicCommands.publicCommandResultCount,
      diagnosticsJsonlScanned: diagnostics.diagnosticsJsonlScanned,
      forbiddenMarkers: 0,
    };
    assertFinalSurfaceRedacted("redaction sweep summary", summary);
    return summary;
  });

  const finalSummary = {
    status: "pass",
    phase: "summary",
    compositionSuccessCount: 1,
    typedNegativeCount: 1,
    routeProof: compositionProof.proxyVocabulary.routeProof.status,
    ipHiding: compositionProof.proxyVocabulary.ipHiding.status,
    webRtc: compositionProof.proxyVocabulary.webRtc.status,
    publicCheckers: compositionProof.proxyVocabulary.publicCheckers.status,
    cleanup: compositionProof.cleanup.status,
    redactionSweep,
    checkCount: STEP_RESULTS.length,
  };
  assert(typedNegative.errorCode === "PROXY_SOCKS_AUTH_UNSUPPORTED", "Typed negative summary error code mismatch.", { errorCode: typedNegative.errorCode });
  assertFinalSurfaceRedacted("final verify.s05 summary", finalSummary);
  emit(finalSummary);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  emit({ status: "fail", message, checks: STEP_RESULTS });
  process.exit(1);
}
