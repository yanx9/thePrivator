import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import {
  basename,
  delimiter as hostPathDelimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import webdriver from "selenium-webdriver";

const { Builder, By, Capabilities, until } = webdriver;

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_NAME = "theprivator-sidecar";
const APP_BINARY_NAME = "theprivator";
const SIDECAR_EXTERNAL_BIN = "binaries/theprivator-sidecar";
const ALLOWED_STRING_PERMISSIONS = Object.freeze([
  "core:default",
  "core:window:default",
  "core:window:allow-start-dragging",
  "core:window:allow-minimize",
  "core:window:allow-toggle-maximize",
  "core:window:allow-close",
  "dialog:allow-open",
  "dialog:allow-save",
]);
const ALLOWED_PERMISSION_IDS = Object.freeze([...ALLOWED_STRING_PERMISSIONS, "shell:allow-spawn"]);
const ALLOWED_STRING_PERMISSION_SET = new Set(ALLOWED_STRING_PERMISSIONS);
const VENV_PYTHON = process.platform === "win32"
  ? join(ROOT_DIR, ".venv", "Scripts", "python.exe")
  : join(ROOT_DIR, ".venv", "bin", "python");
const PYTHON = process.env.PYTHON ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : (process.platform === "win32" ? "python" : "python3"));
const VERIFY_EVENT = "verify.s06";
const BUILD_TIMEOUT_MS = Number(process.env.VERIFY_S06_BUILD_TIMEOUT_MS ?? 20 * 60_000);
const COMMAND_TIMEOUT_MS = 30_000;
const DRIVER_READY_TIMEOUT_MS = Number(process.env.VERIFY_S06_DRIVER_READY_TIMEOUT_MS ?? 20_000);
const UI_WAIT_TIMEOUT_MS = Number(process.env.VERIFY_S06_UI_WAIT_TIMEOUT_MS ?? 60_000);
const UI_POLL_MS = 250;
const DRIVER_TAIL_LINES = 40;
const VISIBLE_TEXT_SNIPPET_LIMIT = 520;
const FRESHNESS_SKEW_MS = 1_500;
const STEP_RESULTS = [];
const STANDARD_CHROMIUM_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "chrome",
  "microsoft-edge",
  "microsoft-edge-stable",
];
const LINUX_WEBDRIVER_NAMES = ["WebKitWebDriver", "webkit2gtk-driver"];
const PACKAGE_EXTENSIONS = new Set([".deb", ".rpm", ".AppImage", ".appimage"]);
// Planted secret VALUES. Finding one of these anywhere outside the credentials
// key is a real leak, including inside a profile note, so they are always
// scanned against the unmasked payload.
const SENSITIVE_VALUE_SENTINELS = [
  "copied-browser-data-should-not-leak",
  "outside-secret-should-not-leak",
  "proxy-user-should-not-leak",
  "proxy-pass-should-not-leak",
];
// Credential FIELD names. These catch a runtime structure being serialised into
// public output -- but "rotate proxy_user each quarter" is an ordinary thing for
// a user to write in a note, so they are not applied to free text the user owns.
const SENSITIVE_FIELD_NAME_MARKERS = ["proxy_user", "proxy_pass"];
const DEFAULT_SENSITIVE_SUBSTRINGS = [...SENSITIVE_VALUE_SENTINELS, ...SENSITIVE_FIELD_NAME_MARKERS];
const PROFILE_STORE_RELATIVE_PATH = "profile-store/profiles.json";
const DIAGNOSTIC_RELATIVE_LOG_PATH = "profile-store/diagnostics/events.jsonl";
const MAX_POST_SMOKE_SCAN_ENTRIES = 5_000;
const MAX_DIAGNOSTIC_READ_BYTES = 512 * 1024;
const FIXTURE_READY_TIMEOUT_MS = Number(process.env.VERIFY_S06_FIXTURE_READY_TIMEOUT_MS ?? 8_000);
const FIXTURE_COMMAND_TIMEOUT_MS = Number(process.env.VERIFY_S06_FIXTURE_COMMAND_TIMEOUT_MS ?? 5_000);
export const PACKAGED_SMOKE_PROFILE_PREFIX = "M003 Packaged Proxy Smoke";
export const PACKAGED_SMOKE_PRESET_ID = "ubuntu-linux-chrome-120";
export const PACKAGED_SMOKE_PRESET_LABEL = "Ubuntu Linux Chrome 120";
export const PACKAGED_SMOKE_EXPECTED_SURFACE_MODES = Object.freeze({
  browser: "masked",
  navigator: "masked",
  screen: "masked",
  locale: "masked",
  canvas: "noise",
  audio: "noise",
  webgl: "masked",
  webrtc: "masked",
});
export const PACKAGED_SMOKE_AUDIT_PAGE_ID = "browserleaks-webgl";
export const PACKAGED_SMOKE_AUDIT_PAGE_LABEL = "BrowserLeaks WebGL";
export const PACKAGED_SMOKE_AUDIT_PAGE_COUNT = 9;
const PACKAGED_SMOKE_PROXY_USERNAME = "s06-proxy-user-sentinel";
const PACKAGED_SMOKE_PROXY_PASSWORD = "s06-proxy-password-sentinel";
const PACKAGED_SMOKE_PROXY_TARGET_HOST = "theprivator-proxy-proof.invalid";
const PACKAGED_SMOKE_PROXY_TARGET_PATH = "/theprivator-proxy-proof";
export const REQUIRED_DIAGNOSTIC_METHODS = Object.freeze([
  "profiles.create",
  "profiles.identity.applyPreset",
  "profiles.proxy.update",
  "profiles.proxy.check",
  "chromium.launch",
  "chromium.stop",
]);
const SUPPORTING_REGRESSION_COMMANDS = [
  "npm run verify:s02",
  "npm run verify:s03",
  "npm run verify:s04",
  "npm run verify:s05",
  "npm run verify:s06",
];
export const FORBIDDEN_PROFILE_RUNTIME_FIELDS = new Set([
  "pid",
  "process",
  "command",
  "status",
  "running",
  "stoppedAt",
  "startedAt",
  "termination",
  "runtime",
  "runtimeState",
  "debugPort",
  "devtoolsPort",
  "remoteDebuggingPort",
  "remoteControlPort",
  "cdpPort",
  "cdpEndpoint",
  "debugEndpoint",
  "websocket",
  "webSocket",
  "websocketUrl",
  "webSocketUrl",
  "webSocketDebuggerUrl",
  "browserWSEndpoint",
  "wsEndpoint",
  "targetId",
  "targetIds",
  "cdpTargetId",
  "activeTargetId",
  "args",
  "argv",
  "rawArgs",
  "commandLine",
  "extensionPath",
  "extensionDir",
  "extensionManifestPath",
  "extensionConfigPath",
  "generatedExtensionPath",
  "generatedExtensionDir",
  "generatedConfigPath",
  "generatedConfigDir",
  "generatedExtension",
  "generatedConfig",
  "identityRuntime",
  "identityRuntimeRegistry",
  "runtimeRegistry",
  "cdpRuntime",
  "proxyRuntime",
  "proxyRuntimeRegistry",
  "proxyAuthExtensionPath",
  "proxyAuthorization",
]);
// Store v4 persists the user's own Chromium switches at profile.launch.args. That
// is declared configuration the user typed, not captured runtime truth, so the key
// stays forbidden everywhere except this one exact path.
const FORBIDDEN_PROFILE_RUNTIME_FIELD_EXEMPT_PATHS = new Set(["$.launch.args"]);
const EMPTY_KEY_PATHS = new Set();
const MAX_PROFILE_TAGS = 10;
const MAX_PROFILE_TAG_LENGTH = 32;
const MAX_PROFILE_NOTES_LENGTH = 1500;
const MAX_PROFILE_START_URLS = 10;
const MAX_PROFILE_START_URL_LENGTH = 2048;
const MAX_PROFILE_LAUNCH_ARGS = 20;
const MAX_PROFILE_LAUNCH_ARG_LENGTH = 256;
const PROFILE_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const PROFILE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const PROFILE_STARTUP_BEHAVIORS = new Set(["customUrls", "restoreSession"]);
const FORBIDDEN_DIAGNOSTIC_KEYS = new Set([
  "params",
  "command",
  "env",
  "stdout",
  "stderr",
  "stack",
  "traceback",
]);
const DIAGNOSTIC_ALLOWED_SOURCES = new Set(["python-sidecar"]);
const DIAGNOSTIC_ALLOWED_EVENTS = new Set(["sidecar.request"]);
const DIAGNOSTIC_ALLOWED_STATUSES = new Set(["ok", "error"]);
const FORBIDDEN_FINAL_EVIDENCE_FIELDS = new Set([
  ...FORBIDDEN_DIAGNOSTIC_KEYS,
  "credentials",
  "credential",
  "username",
  "password",
  "proxyAuthorization",
  "launchArgs",
  "generatedAuthExtensionPath",
  "appDataRoot",
  "publicCheckerBodyText",
  "fixtureTrust",
  "debugPort",
  "devtoolsPort",
  "remoteDebuggingPort",
  "remoteControlPort",
  "cdpPort",
  "cdpEndpoint",
  "debugEndpoint",
  "websocketUrl",
  "webSocketUrl",
  "webSocketDebuggerUrl",
  "browserWSEndpoint",
  "wsEndpoint",
  "targetId",
  "targetIds",
  "cdpTargetId",
  "activeTargetId",
  "args",
  "argv",
  "rawArgs",
  "commandLine",
  "extensionPath",
  "extensionDir",
  "extensionManifestPath",
  "extensionConfigPath",
  "generatedExtensionPath",
  "generatedExtensionDir",
  "generatedConfigPath",
  "generatedConfigDir",
  "generatedExtension",
  "generatedConfig",
  "identityRuntime",
  "identityRuntimeRegistry",
  "runtimeRegistry",
  "cdpRuntime",
  "proxyRuntime",
  "proxyRuntimeRegistry",
  "proxyAuthExtensionPath",
  "proxyAuthorization",
]);
const UNSAFE_TEXT_PATTERNS = [
  { code: "S06_REDACTION_USER_DATA_DIR", pattern: /--user-data-dir(?:=|\s+)/i },
  { code: "S06_REDACTION_CHROMIUM_ENV", pattern: /THEPRIVATOR_CHROMIUM_PATH(?:=|[\"'\s:])/i },
  { code: "S06_REDACTION_TRACEBACK", pattern: /Traceback/i },
  { code: "S06_REDACTION_PROXY", pattern: /proxy[_-]?(?:user|pass)(?:word)?/i },
  { code: "S06_REDACTION_PARAMS", pattern: /[\"']params[\"']\s*:/i },
  { code: "S06_REDACTION_COMMAND", pattern: /[\"']command[\"']\s*:/i },
  { code: "S06_REDACTION_ENV", pattern: /[\"']env[\"']\s*:/i },
  { code: "S06_REDACTION_STDOUT", pattern: /[\"']stdout[\"']\s*:/i },
  { code: "S06_REDACTION_STDERR", pattern: /[\"']stderr[\"']\s*:/i },
  { code: "S06_REDACTION_DEBUG_RUNTIME", pattern: /\b(?:debugPort|devtoolsPort|remoteDebuggingPort|remoteControlPort|cdpPort|--remote-debugging-port)\b/i },
  { code: "S06_REDACTION_WEBSOCKET", pattern: /\b(?:websocketUrl|webSocketUrl|webSocketDebuggerUrl|browserWSEndpoint|wsEndpoint|wss?:\/\/)\b/i },
  { code: "S06_REDACTION_TARGET_ID", pattern: /\b(?:targetId|targetIds|cdpTargetId|activeTargetId)\b/i },
  { code: "S06_REDACTION_GENERATED_EXTENSION", pattern: /\b(?:extensionPath|extensionDir|extensionManifestPath|extensionConfigPath|generatedExtensionPath|generatedExtensionDir|generatedConfigPath|generatedConfigDir|chrome-extension:\/\/|manifest\.json)\b/i },
];
const PUBLIC_EVIDENCE_UNSAFE_TEXT_PATTERNS = [
  { code: "S06_REDACTION_PROXY_AUTH_HEADER", pattern: /Proxy-Authorization/i },
  { code: "S06_REDACTION_PROXY_SERVER_ARG", pattern: /--proxy-server(?:=|\s+)/i },
  { code: "S06_REDACTION_CREDENTIAL_PROXY_URI", pattern: /(?:https?|socks4|socks5):\/\/[^\s\"'/:@]+:[^\s\"'/:@]+@/i },
  { code: "S06_REDACTION_GENERATED_PROXY_AUTH_EXTENSION", pattern: /(?:generated-)?proxy-auth(?:-[A-Za-z0-9_.-]+)*-extension|proxyAuthExtension|chrome-extension:\/\/|manifest\.json/i },
  { code: "S06_REDACTION_GENERATED_IDENTITY_EXTENSION", pattern: /(?:generated-)?identity(?:-[A-Za-z0-9_.-]+)*-extension|identityRuntimeRegistry/i },
  { code: "S06_REDACTION_PROFILE_STORAGE_ROOT", pattern: /profile-store\/profiles\//i },
  { code: "S06_REDACTION_PROFILE_USER_DATA_ROOT", pattern: /(?:^|[\/\\])user-data(?:[\/\\]|$)|--user-data-dir/i },
  { code: "S06_REDACTION_APP_DATA_ROOT", pattern: /(?:XDG_DATA_HOME|APPDATA|LOCALAPPDATA|Application Support|app-data-root)/i },
  { code: "S06_REDACTION_PUBLIC_CHECKER_URL", pattern: /https?:\/\/[^\s\"']*(?:browserleaks\.com|cloudflare|checkip|webbrowsertools)/i },
  { code: "S06_REDACTION_PUBLIC_CHECKER_BODY", pattern: /public checker body|Cloudflare trace body|ip=\d{1,3}(?:\.\d{1,3}){3}/i },
  { code: "S06_REDACTION_FIXTURE_TRUST", pattern: /(?:fixtureTrust|spkiSha256|verifier-only-trust-detail|privateKey|certificatePem)/i },
];

const GLOBAL_SENSITIVE_VALUES = new Set([ROOT_DIR, PACKAGED_SMOKE_PROXY_USERNAME, PACKAGED_SMOKE_PROXY_PASSWORD]);
if (process.env.THEPRIVATOR_CHROMIUM_PATH) {
  GLOBAL_SENSITIVE_VALUES.add(process.env.THEPRIVATOR_CHROMIUM_PATH);
}

const PROXY_FIXTURE_MANAGER = String.raw`
import json
import sys
from urllib.parse import quote, urlunsplit

from theprivator_sidecar.proxy_proof import (
    DEFAULT_PROOF_TARGET_PORT,
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
    label = str(config.get("label", "s06-proxy-proof"))[:96]
    target_host = str(config.get("targetHost") or "theprivator-proxy-proof.invalid").lower()
    target_port = int(config.get("targetPort") or DEFAULT_PROOF_TARGET_PORT)
    target_path = str(config.get("targetPath") or PROXY_PROOF_PATH)
    fixture_credentials = credentials(config.get("fixtureCredentials"))

    with ProxyProofTargetServer() as target:
        fixture = create_proxy_fixture(
            kind,
            target_host=target_host,
            target_port=target_port,
            target_address=target.local_address,
            credentials=fixture_credentials,
        )
        with fixture:
            emit({
                "ok": True,
                "label": label,
                "fixtureKind": kind,
                "proxy": {
                    "proxyVersion": 1,
                    "mode": "fixedServer",
                    "protocol": kind,
                    "host": fixture.local_host,
                    "port": fixture.local_port,
                },
                "target": {
                    "host": target_host,
                    "port": target_port,
                    "path": target_path,
                    "url": target_url(target_host, target_port, target_path, label),
                },
            })
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

export class VerifyFailure extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "VerifyFailure";
    this.details = details;
  }
}

export function executableName(name, platform = process.platform) {
  return platform === "win32" ? `${name}.exe` : name;
}

function pathDelimiterForPlatform(platform = process.platform) {
  return platform === "win32" ? ";" : ":";
}

function pathextsForPlatform(platform = process.platform, env = process.env) {
  if (platform !== "win32") {
    return [""];
  }
  const extensions = String(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  return extensions.length > 0 ? extensions : [".EXE", ".CMD", ".BAT", ".COM"];
}

function slashPath(value) {
  return value.split(sep).join("/");
}

function repoRelative(rootDir, path) {
  return slashPath(relative(rootDir, path)) || ".";
}

function executableForCommand(command, platform = process.platform) {
  if (platform === "win32" && ["npm", "cargo", "rustc"].includes(command)) {
    return `${command}.cmd`;
  }
  return command;
}

function isExecutable(path, platform = process.platform) {
  try {
    accessSync(path, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function commandLabel(command, args, label) {
  if (label) {
    return label;
  }
  return [basename(command), ...args].join(" ");
}

export function redact(value, options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const sensitiveValues = new Set([
    rootDir,
    ...GLOBAL_SENSITIVE_VALUES,
    ...(options.sensitiveValues ?? []),
  ]);

  function redactString(input) {
    let output = input;
    for (const sensitive of Array.from(sensitiveValues).filter(Boolean).sort((a, b) => b.length - a.length)) {
      output = output.split(sensitive).join(resolve(sensitive) === resolve(rootDir) ? "<repo>" : "<redacted>");
    }
    for (const token of DEFAULT_SENSITIVE_SUBSTRINGS) {
      output = output.split(token).join("<redacted>");
    }
    output = output.replace(/--user-data-dir(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)/g, "<chromium-user-data-dir redacted>");
    output = output.replace(/THEPRIVATOR_CHROMIUM_PATH=(?:"[^"]+"|'[^']+'|\S+)/g, "<chromium-path redacted>");
    output = output.replace(/(proxy[_-]?(?:user|pass)(?:word)?)(=|:)(?:"[^"]+"|'[^']+'|\S+)/gi, "$1$2<redacted>");
    output = output.replace(/Traceback(?:[^\n]*(?:\n\s+[^\n]*)*)?/g, "<traceback redacted>");
    output = output.replace(/https?:\/\/[^\s"')]+/gi, "<url redacted>");
    return output;
  }

  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, options));
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, options)]));
  }
  return value;
}

function normalizeOutputTail(value, options = {}) {
  if (!value) {
    return "";
  }
  return redact(value, options)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-25)
    .join("\n");
}

function fail(message, details, options = {}) {
  throw new VerifyFailure(message, redact(details, options));
}

function assert(condition, message, details, options = {}) {
  if (!condition) {
    fail(message, details, options);
  }
}

function emit(event) {
  console.log(JSON.stringify({ event: VERIFY_EVENT, ...redact(event) }));
}

export function runStep(name, action, options = {}) {
  const started = performance.now();
  try {
    const result = action() ?? {};
    const durationMs = Math.round(performance.now() - started);
    const logResult = result.log ?? result;
    const returnResult = result.value ?? result;
    const record = { name, status: "pass", durationMs, ...redact(logResult, options) };
    STEP_RESULTS.push(record);
    emit({ step: name, status: "pass", durationMs, ...redact(logResult, options) });
    return returnResult;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    const record = { name, status: "fail", durationMs, message };
    STEP_RESULTS.push(record);
    emit({ step: name, status: "fail", durationMs, message });
    if (error?.details) {
      emit({ step: name, status: "fail-details", details: redact(error.details, options) });
    }
    throw error;
  }
}

export async function runStepAsync(name, action, options = {}) {
  const started = performance.now();
  try {
    const result = (await action()) ?? {};
    const durationMs = Math.round(performance.now() - started);
    const logResult = result.log ?? result;
    const returnResult = result.value ?? result;
    const record = { name, status: "pass", durationMs, ...redact(logResult, options) };
    STEP_RESULTS.push(record);
    emit({ step: name, status: "pass", durationMs, ...redact(logResult, options) });
    return returnResult;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    const record = { name, status: "fail", durationMs, message };
    STEP_RESULTS.push(record);
    emit({ step: name, status: "fail", durationMs, message });
    if (error?.details) {
      emit({ step: name, status: "fail-details", details: redact(error.details, options) });
    }
    throw error;
  }
}

function runCommand(name, command, args, timeoutMs, options = {}) {
  return runStep(name, () => {
    const rootDir = options.rootDir ?? ROOT_DIR;
    const label = commandLabel(command, args, options.label ?? name);
    const result = spawnSync(executableForCommand(command), args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    });

    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        fail(`${name} timed out.`, {
          code: "S06_COMMAND_TIMEOUT",
          step: name,
          command: label,
          timeoutMs,
          stdoutTail: normalizeOutputTail(result.stdout, { rootDir }),
          stderrTail: normalizeOutputTail(result.stderr, { rootDir }),
        }, { rootDir });
      }
      fail(`Failed to run ${name}.`, {
        code: "S06_COMMAND_START_FAILED",
        step: name,
        command: label,
        message: result.error.message,
      }, { rootDir });
    }

    if (result.status !== 0) {
      fail(`${name} exited with status ${result.status ?? "unknown"}.`, {
        code: "S06_COMMAND_EXIT_NONZERO",
        step: name,
        command: label,
        exitCode: result.status,
        stdoutTail: normalizeOutputTail(result.stdout, { rootDir }),
        stderrTail: normalizeOutputTail(result.stderr, { rootDir }),
      }, { rootDir });
    }

    return { command: label, exitCode: result.status ?? 0 };
  }, { rootDir: options.rootDir ?? ROOT_DIR });
}

function readJson(path, rootDir) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("Required JSON metadata could not be parsed.", {
      code: "S06_JSON_MALFORMED",
      artifact: repoRelative(rootDir, path),
      message: error instanceof Error ? error.message : String(error),
    }, { rootDir });
  }
}

function findExecutableCandidate(name, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathEnv = options.pathEnv ?? env.PATH ?? "";
  const dirs = [
    ...String(pathEnv).split(pathDelimiterForPlatform(platform)).filter(Boolean),
    ...(options.extraDirs ?? []),
  ];
  const extensions = pathextsForPlatform(platform, env);

  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    const candidate = resolve(name);
    return isExecutable(candidate, platform) ? { name: basename(candidate), path: candidate } : null;
  }

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, platform === "win32" && extname(name) === "" ? `${name}${extension}` : name);
      if (isExecutable(candidate, platform)) {
        return { name, path: candidate };
      }
    }
  }
  return null;
}

function safeExecutableLog(candidate, source) {
  if (!candidate) {
    return null;
  }
  return { name: candidate.name, source };
}

function validateEnvExecutableValue(value, label, options = {}) {
  const platform = options.platform ?? process.platform;
  const rootDir = options.rootDir ?? ROOT_DIR;
  const env = options.env ?? process.env;
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  GLOBAL_SENSITIVE_VALUES.add(trimmed);
  if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) {
    fail(`${label} contains control characters and cannot be used.`, {
      code: "S06_EXECUTABLE_PATH_MALFORMED",
      source: label,
    }, { rootDir });
  }
  if (trimmed.includes(pathDelimiterForPlatform(platform))) {
    fail(`${label} is ambiguous; set it to exactly one executable path.`, {
      code: "S06_EXECUTABLE_PATH_AMBIGUOUS",
      source: label,
    }, { rootDir });
  }
  if (/\s--?\w/.test(trimmed) || trimmed.startsWith("-")) {
    fail(`${label} must be an executable path, not a command line.`, {
      code: "S06_EXECUTABLE_PATH_COMMAND_LINE",
      source: label,
    }, { rootDir });
  }

  const candidate = findExecutableCandidate(trimmed, { platform, env, pathEnv: env.PATH });
  if (!candidate) {
    fail(`${label} did not point to an executable file.`, {
      code: "S06_EXECUTABLE_PATH_NOT_EXECUTABLE",
      source: label,
      instruction: "Set THEPRIVATOR_CHROMIUM_PATH to a single Chromium/Chrome executable path or install chromium/google-chrome on PATH.",
    }, { rootDir });
  }
  return candidate;
}

export function resolveChromiumExecutable(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (env.THEPRIVATOR_CHROMIUM_PATH) {
    const candidate = validateEnvExecutableValue(env.THEPRIVATOR_CHROMIUM_PATH, "THEPRIVATOR_CHROMIUM_PATH", {
      rootDir,
      env,
      platform,
    });
    return { ...safeExecutableLog(candidate, "THEPRIVATOR_CHROMIUM_PATH") };
  }

  for (const name of STANDARD_CHROMIUM_NAMES) {
    const candidate = findExecutableCandidate(name, { env, pathEnv: env.PATH, platform });
    if (candidate) {
      return { ...safeExecutableLog(candidate, "PATH") };
    }
  }

  fail("Chromium executable was not found for the packaged smoke.", {
    code: "S06_CHROMIUM_MISSING",
    name: "Chromium",
    instruction: "Install Chromium/Chrome or set THEPRIVATOR_CHROMIUM_PATH to one local executable before running npm run verify:s06.",
  }, { rootDir });
}

function isoRunStamp(date) {
  return date.toISOString().replace(/[-:.]/g, "");
}

function sanitizeRunIdPart(value, label) {
  const text = String(value ?? "").trim();
  assert(text.length > 0 && text.length <= 96 && /^[A-Za-z0-9_.-]+$/.test(text), `${label} must be a safe run identifier segment.`, {
    code: "S06_RUN_ID_UNSAFE",
    label,
  });
  return text;
}

function sanitizeProfilePrefix(value) {
  const text = String(value ?? "").trim();
  assert(text.length > 0 && text.length <= 96 && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(text), "Packaged smoke profile prefix must be safe visible text.", {
    code: "S06_PROFILE_PREFIX_UNSAFE",
    label: "profilePrefix",
  });
  return text;
}

export function createSmokeRunContext(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const now = options.now ?? new Date();
  const nonce = sanitizeRunIdPart(options.nonce ?? randomBytes(4).toString("hex"), "nonce");
  const runId = sanitizeRunIdPart(options.runId ?? `${isoRunStamp(now)}-${nonce}`, "runId");
  const profilePrefix = sanitizeProfilePrefix(options.profilePrefix ?? PACKAGED_SMOKE_PROFILE_PREFIX);
  const smokeRoot = join(rootDir, "src-tauri", "target", "s06-smoke-data", runId);
  const dataRoot = join(smokeRoot, "data");
  const configRoot = join(smokeRoot, "config");
  const cacheRoot = join(smokeRoot, "cache");
  const smokeProfileName = `${profilePrefix} ${runId}`;

  if (existsSync(smokeRoot)) {
    fail("S06 smoke data root already exists; refusing to reuse a duplicate smoke profile name.", {
      code: "S06_SMOKE_ROOT_EXISTS",
      smokeRoot: repoRelative(rootDir, smokeRoot),
      smokeProfileName,
    }, { rootDir, sensitiveValues: [smokeRoot] });
  }

  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(configRoot, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });
  GLOBAL_SENSITIVE_VALUES.add(smokeRoot);
  GLOBAL_SENSITIVE_VALUES.add(dataRoot);
  GLOBAL_SENSITIVE_VALUES.add(configRoot);
  GLOBAL_SENSITIVE_VALUES.add(cacheRoot);

  const driverEnv = {
    ...(options.baseEnv ?? process.env),
    XDG_DATA_HOME: dataRoot,
    XDG_CONFIG_HOME: configRoot,
    XDG_CACHE_HOME: cacheRoot,
  };

  const smokeRootRelative = repoRelative(rootDir, smokeRoot);
  return {
    runId,
    smokeProfileName,
    smokeRoot,
    smokeRootRelative,
    dataRoot,
    configRoot,
    cacheRoot,
    driverEnv,
    log: {
      runId,
      smokeProfileName,
      smokeRoot: smokeRootRelative,
      retained: true,
    },
  };
}

export function buildTauriWebDriverCapabilities(applicationPath) {
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: applicationPath });
  return capabilities;
}

function findTauriDriverExecutable(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathEnv = options.pathEnv ?? env.PATH ?? "";
  const cargoBin = options.cargoBin ?? join(homedir(), ".cargo", "bin");
  GLOBAL_SENSITIVE_VALUES.add(cargoBin);
  return findExecutableCandidate("tauri-driver", {
    env,
    pathEnv,
    platform,
    extraDirs: [cargoBin],
  });
}

export function resolveTauriDriverExecutable(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const candidate = findTauriDriverExecutable(options);
  if (!candidate) {
    fail("tauri-driver was not found for the packaged UI smoke.", {
      code: "S06_TAURI_DRIVER_MISSING",
      name: "tauri-driver",
      instruction: "Install Tauri WebDriver support (for example cargo install tauri-cli --features webdriver) and ensure tauri-driver is on PATH or in ~/.cargo/bin.",
    }, { rootDir });
  }
  return candidate;
}

export function safeVisibleTextSnippet(value, options = {}) {
  const normalized = redact(String(value ?? ""), options)
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= VISIBLE_TEXT_SNIPPET_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, VISIBLE_TEXT_SNIPPET_LIMIT - 1)}…`;
}

export function assertWebDriverPreflight(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const strict = options.strict ?? true;
  const missing = [];
  const pathEnv = env.PATH ?? "";

  const tauriDriver = findTauriDriverExecutable({
    env,
    pathEnv,
    platform,
    cargoBin: options.cargoBin,
  });
  if (!tauriDriver) {
    missing.push({
      name: "tauri-driver",
      instruction: "Install Tauri WebDriver support (for example cargo install tauri-cli --features webdriver) and ensure tauri-driver is on PATH.",
    });
  }

  let platformDriver = null;
  if (platform === "linux") {
    for (const name of LINUX_WEBDRIVER_NAMES) {
      platformDriver = findExecutableCandidate(name, { env, pathEnv, platform });
      if (platformDriver) {
        break;
      }
    }
    if (!platformDriver) {
      missing.push({
        name: "WebKitWebDriver",
        instruction: "Install the Linux WebKit WebDriver package (commonly webkit2gtk-driver/WebKitWebDriver) before running the packaged UI smoke.",
      });
    }
  }

  const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  if (platform === "linux" && !hasDisplay) {
    missing.push({
      name: "display",
      instruction: "Run from a visible desktop session or use xvfb-run npm run verify:s06 for headless Linux automation.",
    });
  }

  let chromium = null;
  try {
    chromium = resolveChromiumExecutable({ rootDir, env, platform });
  } catch (error) {
    if (error instanceof VerifyFailure && error.details?.code === "S06_CHROMIUM_MISSING") {
      missing.push({ name: "Chromium", instruction: error.details.instruction });
    } else {
      throw error;
    }
  }

  const result = {
    strict,
    tauriDriver: safeExecutableLog(tauriDriver, tauriDriver ? "PATH" : "missing"),
    platformDriver: platform === "linux" ? safeExecutableLog(platformDriver, platformDriver ? "PATH" : "missing") : { name: "native", source: "platform" },
    display: platform === "linux" ? (hasDisplay ? "available" : "missing") : "not-required",
    chromium: chromium ?? { name: "Chromium", source: "missing" },
    missing,
  };

  if (strict && missing.length > 0) {
    fail("S06 WebDriver preflight failed.", {
      code: "S06_PREFLIGHT_MISSING",
      missing,
      instruction: "Install the missing prerequisites, or on headless Linux run xvfb-run npm run verify:s06 after installing tauri-driver, WebKitWebDriver, and Chromium.",
    }, { rootDir });
  }

  return result;
}

function assertExecutableFile(path, label, rootDir, platform) {
  assert(existsSync(path), `Missing ${label}.`, {
    code: "S06_ARTIFACT_MISSING",
    artifact: repoRelative(rootDir, path),
  }, { rootDir });
  const stats = statSync(path);
  assert(stats.isFile(), `${label} is not a file.`, {
    code: "S06_ARTIFACT_NOT_FILE",
    artifact: repoRelative(rootDir, path),
  }, { rootDir });
  if (platform !== "win32") {
    assert((stats.mode & 0o111) !== 0, `${label} is not executable.`, {
      code: "S06_ARTIFACT_NOT_EXECUTABLE",
      artifact: repoRelative(rootDir, path),
    }, { rootDir });
  }
  return stats;
}

function assertFresh(stats, path, buildStartedAt, rootDir, label) {
  const thresholdMs = buildStartedAt instanceof Date ? buildStartedAt.getTime() : Number(buildStartedAt);
  assert(Number.isFinite(thresholdMs), "Build freshness timestamp is invalid.", {
    code: "S06_BUILD_STARTED_AT_INVALID",
  }, { rootDir });
  assert(stats.mtimeMs + FRESHNESS_SKEW_MS >= thresholdMs, `${label} is stale; it predates the S06 build start.`, {
    code: "S06_ARTIFACT_STALE",
    artifact: repoRelative(rootDir, path),
    mtime: new Date(stats.mtimeMs).toISOString(),
    buildStartedAt: new Date(thresholdMs).toISOString(),
  }, { rootDir });
}

function walkArtifacts(path, artifacts) {
  if (!existsSync(path)) {
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) {
      walkArtifacts(fullPath, artifacts);
      continue;
    }
    if (entry.isFile() && PACKAGE_EXTENSIONS.has(extname(entry.name))) {
      artifacts.push(fullPath);
    }
  }
}

function findPackageArtifacts(rootDir) {
  const artifacts = [];
  walkArtifacts(join(rootDir, "src-tauri", "target", "release", "bundle"), artifacts);
  return artifacts;
}

export function assertFreshBuildArtifacts(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const platform = options.platform ?? process.platform;
  const buildStartedAt = options.buildStartedAt;
  const extension = platform === "win32" ? ".exe" : "";
  const targetTriple = options.targetTriple;
  assert(targetTriple && typeof targetTriple === "string", "Target triple is required for S06 artifact checks.", {
    code: "S06_TARGET_TRIPLE_MISSING",
  }, { rootDir });

  const releaseExecutable = join(rootDir, "src-tauri", "target", "release", executableName(APP_BINARY_NAME, platform));
  const releaseSidecar = join(rootDir, "src-tauri", "target", "release", `${SIDECAR_NAME}${extension}`);
  const targetTripleSidecar = join(rootDir, "src-tauri", "binaries", `${SIDECAR_NAME}-${targetTriple}${extension}`);

  const releaseExecutableStats = assertExecutableFile(releaseExecutable, "release executable", rootDir, platform);
  const releaseSidecarStats = assertExecutableFile(releaseSidecar, "release sidecar", rootDir, platform);
  const targetTripleSidecarStats = assertExecutableFile(targetTripleSidecar, "target-triple sidecar", rootDir, platform);
  assertFresh(releaseExecutableStats, releaseExecutable, buildStartedAt, rootDir, "release executable");
  assertFresh(releaseSidecarStats, releaseSidecar, buildStartedAt, rootDir, "release sidecar");
  assertFresh(targetTripleSidecarStats, targetTripleSidecar, buildStartedAt, rootDir, "target-triple sidecar");

  const packages = findPackageArtifacts(rootDir);
  const debs = packages.filter((path) => extname(path) === ".deb");
  const rpms = packages.filter((path) => extname(path) === ".rpm");
  const appImages = packages.filter((path) => [".AppImage", ".appimage"].includes(extname(path)));
  if (platform === "linux") {
    assert(appImages.length === 0, "Linux package output unexpectedly included AppImage without S06 proof.", {
      code: "S06_APPIMAGE_UNPROVEN",
      artifacts: appImages.map((path) => repoRelative(rootDir, path)),
    }, { rootDir });
    assert(debs.length > 0, "Linux package output is missing a fresh .deb artifact.", {
      code: "S06_DEB_MISSING",
      bundleRoot: "src-tauri/target/release/bundle",
    }, { rootDir });
    assert(rpms.length > 0, "Linux package output is missing a fresh .rpm artifact.", {
      code: "S06_RPM_MISSING",
      bundleRoot: "src-tauri/target/release/bundle",
    }, { rootDir });
  }

  const packagePaths = [...debs, ...rpms];
  for (const artifact of packagePaths) {
    const stats = statSync(artifact);
    assert(stats.isFile(), "Package artifact is not a file.", {
      code: "S06_PACKAGE_NOT_FILE",
      artifact: repoRelative(rootDir, artifact),
    }, { rootDir });
    assertFresh(stats, artifact, buildStartedAt, rootDir, "package artifact");
  }

  return {
    buildStartedAt: new Date(buildStartedAt instanceof Date ? buildStartedAt.getTime() : Number(buildStartedAt)).toISOString(),
    releaseExecutable: repoRelative(rootDir, releaseExecutable),
    releaseSidecar: repoRelative(rootDir, releaseSidecar),
    targetTripleSidecar: repoRelative(rootDir, targetTripleSidecar),
    packages: packagePaths.map((path) => repoRelative(rootDir, path)).sort(),
  };
}

export function assertBuildArtifactsPresent(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const platform = options.platform ?? process.platform;
  const extension = platform === "win32" ? ".exe" : "";
  const targetTriple = options.targetTriple;
  assert(targetTriple && typeof targetTriple === "string", "Target triple is required for S06 artifact checks.", {
    code: "S06_TARGET_TRIPLE_MISSING",
  }, { rootDir });

  const releaseExecutable = join(rootDir, "src-tauri", "target", "release", executableName(APP_BINARY_NAME, platform));
  const releaseSidecar = join(rootDir, "src-tauri", "target", "release", `${SIDECAR_NAME}${extension}`);
  const targetTripleSidecar = join(rootDir, "src-tauri", "binaries", `${SIDECAR_NAME}-${targetTriple}${extension}`);
  assertExecutableFile(releaseExecutable, "release executable", rootDir, platform);
  assertExecutableFile(releaseSidecar, "release sidecar", rootDir, platform);
  assertExecutableFile(targetTripleSidecar, "target-triple sidecar", rootDir, platform);

  const packages = findPackageArtifacts(rootDir);
  const debs = packages.filter((path) => extname(path) === ".deb");
  const rpms = packages.filter((path) => extname(path) === ".rpm");
  const appImages = packages.filter((path) => [".AppImage", ".appimage"].includes(extname(path)));
  if (platform === "linux") {
    assert(appImages.length === 0, "Linux package output unexpectedly included AppImage without S06 proof.", {
      code: "S06_APPIMAGE_UNPROVEN",
      artifacts: appImages.map((path) => repoRelative(rootDir, path)),
    }, { rootDir });
    assert(debs.length > 0, "Linux package output is missing a .deb artifact for ui-only smoke.", {
      code: "S06_DEB_MISSING",
      bundleRoot: "src-tauri/target/release/bundle",
    }, { rootDir });
    assert(rpms.length > 0, "Linux package output is missing a .rpm artifact for ui-only smoke.", {
      code: "S06_RPM_MISSING",
      bundleRoot: "src-tauri/target/release/bundle",
    }, { rootDir });
  }

  const packagePaths = [...debs, ...rpms];
  for (const artifact of packagePaths) {
    const stats = statSync(artifact);
    assert(stats.isFile(), "Package artifact is not a file.", {
      code: "S06_PACKAGE_NOT_FILE",
      artifact: repoRelative(rootDir, artifact),
    }, { rootDir });
  }

  return {
    releaseExecutable: repoRelative(rootDir, releaseExecutable),
    releaseSidecar: repoRelative(rootDir, releaseSidecar),
    targetTripleSidecar: repoRelative(rootDir, targetTripleSidecar),
    packages: packagePaths.map((path) => repoRelative(rootDir, path)).sort(),
  };
}

export function assertTauriGuardrails(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const platform = options.platform ?? process.platform;
  const tauriConfigPath = join(rootDir, "src-tauri", "tauri.conf.json");
  const capabilityPath = join(rootDir, "src-tauri", "capabilities", "default.json");
  const tauriConfig = readJson(tauriConfigPath, rootDir);
  const capability = readJson(capabilityPath, rootDir);

  const externalBin = tauriConfig.bundle?.externalBin;
  assert(Array.isArray(externalBin) && externalBin.length === 1 && externalBin[0] === SIDECAR_EXTERNAL_BIN,
    "Tauri bundle.externalBin must stay fixed to the packaged sidecar.", {
      code: "S06_EXTERNAL_BIN_DRIFT",
      externalBin,
    }, { rootDir });

  const targets = tauriConfig.bundle?.targets;
  if (platform === "linux") {
    assert(Array.isArray(targets), "Linux bundle targets must stay explicit.", {
      code: "S06_BUNDLE_TARGETS_MISSING",
      targets,
    }, { rootDir });
    const sortedTargets = [...targets].sort();
    assert(JSON.stringify(sortedTargets) === JSON.stringify(["deb", "rpm"]),
      "Linux bundle targets must stay fixed to .deb and .rpm only.", {
        code: "S06_BUNDLE_TARGETS_DRIFT",
        targets,
      }, { rootDir });
  }

  assert(String(tauriConfig.build?.beforeBuildCommand ?? "").includes("sidecar:build"),
    "beforeBuildCommand must keep building the sidecar before packaging.", {
      code: "S06_BEFORE_BUILD_DRIFT",
    }, { rootDir });
  assert(String(tauriConfig.build?.beforeDevCommand ?? "").includes("sidecar:build"),
    "beforeDevCommand must keep building the sidecar before dev launch.", {
      code: "S06_BEFORE_DEV_DRIFT",
    }, { rootDir });

  const mainWindow = Array.isArray(tauriConfig.app?.windows)
    ? tauriConfig.app.windows.find((windowConfig) => windowConfig?.label === "main") ?? tauriConfig.app.windows[0]
    : null;
  assert(mainWindow?.decorations === false,
    "The main Tauri window must stay frameless for the custom chrome path.", {
      code: "S06_WINDOW_DECORATIONS_DRIFT",
      decorations: mainWindow?.decorations,
    }, { rootDir });

  const permissions = capability.permissions;
  assert(Array.isArray(permissions), "Default capability permissions must be an array.", {
    code: "S06_CAPABILITY_MALFORMED",
  }, { rootDir });

  const permissionIds = [];
  for (const permission of permissions) {
    if (typeof permission === "string" && ALLOWED_STRING_PERMISSION_SET.has(permission)) {
      permissionIds.push(permission);
      continue;
    }
    if (permission && typeof permission === "object" && permission.identifier === "shell:allow-spawn") {
      const allow = permission.allow;
      const allowedSidecars = Array.isArray(allow)
        ? allow.filter((entry) => entry?.name === SIDECAR_EXTERNAL_BIN && entry?.sidecar === true && Object.keys(entry).length === 2)
        : [];
      assert(Array.isArray(allow) && allow.length === 1 && allowedSidecars.length === 1,
        "Default capability widened shell:allow-spawn beyond the fixed sidecar.", {
          code: "S06_CAPABILITY_WIDENED",
          identifier: permission.identifier,
        }, { rootDir });
      permissionIds.push(permission.identifier);
      continue;
    }

    const identifier = typeof permission === "string" ? permission : permission?.identifier;
    fail("Default capability widened filesystem/shell/dialog/window authority for S06.", {
      code: "S06_CAPABILITY_WIDENED",
      identifier: identifier ?? "unknown",
    }, { rootDir });
  }

  assert(permissionIds.length === ALLOWED_PERMISSION_IDS.length && ALLOWED_PERMISSION_IDS.every((permissionId) => permissionIds.includes(permissionId)),
    "Default capability must contain only the fixed core/dialog/window permissions and shell:allow-spawn.", {
      code: "S06_CAPABILITY_DRIFT",
      permissions: permissionIds,
      expected: ALLOWED_PERMISSION_IDS,
    }, { rootDir });

  return {
    externalBin: SIDECAR_EXTERNAL_BIN,
    targets,
    decorations: mainWindow.decorations,
    permissions: permissionIds,
  };
}

export function readTargetTriple(rootDir = ROOT_DIR) {
  const result = spawnSync(executableForCommand("rustc"), ["--print", "host-tuple"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
  });

  if (result.error) {
    fail("Failed to determine the Rust host target triple.", {
      code: "S06_TARGET_TRIPLE_COMMAND_FAILED",
      message: result.error.message,
      stderrTail: normalizeOutputTail(result.stderr, { rootDir }),
    }, { rootDir });
  }
  if (result.status !== 0) {
    fail("rustc --print host-tuple failed.", {
      code: "S06_TARGET_TRIPLE_COMMAND_NONZERO",
      exitCode: result.status,
      stderrTail: normalizeOutputTail(result.stderr, { rootDir }),
    }, { rootDir });
  }
  const targetTriple = result.stdout.trim();
  assert(targetTriple, "rustc did not return a host target triple.", {
    code: "S06_TARGET_TRIPLE_EMPTY",
  }, { rootDir });
  return targetTriple;
}

function inspectPackageContents(packages, rootDir) {
  const inspections = [];
  for (const artifact of packages) {
    const absolute = join(rootDir, artifact);
    const extension = extname(absolute);
    if (extension === ".deb") {
      const tool = findExecutableCandidate("dpkg-deb", { env: process.env, pathEnv: process.env.PATH });
      if (!tool) {
        inspections.push({ artifact, tool: "dpkg-deb", status: "skipped", reason: "tool-missing" });
        continue;
      }
      const result = spawnSync(tool.path, ["-c", absolute], {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (result.status !== 0 || result.error) {
        inspections.push({ artifact, tool: "dpkg-deb", status: "skipped", reason: "inspection-failed" });
        continue;
      }
      assert(result.stdout.includes(SIDECAR_NAME), ".deb package listing did not include the sidecar name.", {
        code: "S06_PACKAGE_SIDECAR_MISSING",
        artifact,
        tool: "dpkg-deb",
      }, { rootDir });
      inspections.push({ artifact, tool: "dpkg-deb", status: "pass" });
      continue;
    }
    if (extension === ".rpm") {
      const tool = findExecutableCandidate("rpm", { env: process.env, pathEnv: process.env.PATH });
      if (!tool) {
        inspections.push({ artifact, tool: "rpm", status: "skipped", reason: "tool-missing" });
        continue;
      }
      const result = spawnSync(tool.path, ["-qpl", absolute], {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (result.status !== 0 || result.error) {
        inspections.push({ artifact, tool: "rpm", status: "skipped", reason: "inspection-failed" });
        continue;
      }
      assert(result.stdout.includes(SIDECAR_NAME), ".rpm package listing did not include the sidecar name.", {
        code: "S06_PACKAGE_SIDECAR_MISSING",
        artifact,
        tool: "rpm",
      }, { rootDir });
      inspections.push({ artifact, tool: "rpm", status: "pass" });
    }
  }
  return { inspections };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function allocateLoopbackPort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (typeof port === "number") {
          resolvePort(port);
        } else {
          rejectPort(new Error("Failed to allocate a loopback port."));
        }
      });
    });
  });
}

function redactionOptionsForSmoke(rootDir, smokeContext) {
  return {
    rootDir,
    sensitiveValues: smokeContext
      ? [smokeContext.smokeRoot, smokeContext.dataRoot, smokeContext.configRoot, smokeContext.cacheRoot]
      : [],
  };
}

function createTailRecorder(child, options = {}) {
  const stdout = [];
  const stderr = [];
  const push = (bucket, chunk) => {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);
    bucket.push(...lines);
    while (bucket.length > DRIVER_TAIL_LINES) {
      bucket.shift();
    }
  };

  child.stdout?.on("data", (chunk) => push(stdout, chunk));
  child.stderr?.on("data", (chunk) => push(stderr, chunk));

  return {
    stdoutTail() {
      return normalizeOutputTail(stdout.join("\n"), options);
    },
    stderrTail() {
      return normalizeOutputTail(stderr.join("\n"), options);
    },
  };
}

function driverTailDetails(driverProcess) {
  if (!driverProcess) {
    return {};
  }
  return {
    driverStdoutTail: driverProcess.tail.stdoutTail(),
    driverStderrTail: driverProcess.tail.stderrTail(),
  };
}

async function waitForDriverStatus(driverProcess, port, rootDir, smokeContext) {
  const started = Date.now();
  const redactionOptions = redactionOptionsForSmoke(rootDir, smokeContext);
  while (Date.now() - started < DRIVER_READY_TIMEOUT_MS) {
    if (driverProcess.child.exitCode !== null || driverProcess.child.signalCode !== null) {
      fail("tauri-driver exited before WebDriver status became available.", {
        code: "S06_TAURI_DRIVER_EARLY_EXIT",
        step: "webdriver-driver-start",
        exitCode: driverProcess.child.exitCode,
        signal: driverProcess.child.signalCode,
        smokeProfileName: smokeContext.smokeProfileName,
        smokeRoot: smokeContext.smokeRootRelative,
        ...driverTailDetails(driverProcess),
      }, redactionOptions);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the bounded readiness timeout expires.
    }
    await sleep(200);
  }

  fail("Timed out waiting for tauri-driver WebDriver status.", {
    code: "S06_TAURI_DRIVER_TIMEOUT",
    step: "webdriver-driver-start",
    timeoutMs: DRIVER_READY_TIMEOUT_MS,
    smokeProfileName: smokeContext.smokeProfileName,
    smokeRoot: smokeContext.smokeRootRelative,
    ...driverTailDetails(driverProcess),
  }, redactionOptions);
}

async function stopChildProcess(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return { status: "not-running" };
  }
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ status: "exited", code, signal }));
  });
  child.kill("SIGTERM");
  const timeout = sleep(timeoutMs).then(() => ({ status: "timeout" }));
  const result = await Promise.race([exited, timeout]);
  if (result.status === "timeout" && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    return { status: "killed" };
  }
  return result;
}

class LineProcess {
  constructor(child, label, options = {}) {
    this.child = child;
    this.label = label;
    this.options = options;
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
    let line;
    try {
      line = await this.readLine(timeoutMs);
    } catch (error) {
      fail(`${this.label} timed out or exited while waiting for JSON.`, {
        code: "S06_FIXTURE_TIMEOUT",
        label: this.label,
        exitCode: this.exitCode,
        signal: this.exitSignal,
        stderrTail: normalizeOutputTail(this.stderr, this.options),
        message: error instanceof Error ? error.message : String(error),
      }, this.options);
    }
    try {
      const payload = JSON.parse(line);
      assert(payload && typeof payload === "object" && !Array.isArray(payload), `${this.label} emitted a malformed JSON payload.`, {
        code: "S06_FIXTURE_MALFORMED",
        label: this.label,
        lineLength: line.length,
      }, this.options);
      return payload;
    } catch (error) {
      if (error instanceof VerifyFailure) {
        throw error;
      }
      fail(`${this.label} emitted malformed JSON.`, {
        code: "S06_FIXTURE_MALFORMED_JSON",
        label: this.label,
        lineLength: line?.length ?? 0,
        message: error instanceof Error ? error.message : String(error),
      }, this.options);
    }
  }

  send(payload) {
    if (this.exited) {
      fail(`${this.label} is not running.`, {
        code: "S06_FIXTURE_NOT_RUNNING",
        label: this.label,
        exitCode: this.exitCode,
        signal: this.exitSignal,
        stderrTail: normalizeOutputTail(this.stderr, this.options),
      }, this.options);
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
      await withTimeout(new Promise((resolveExit) => this.child.once("exit", (code, signal) => resolveExit({ code, signal }))), 2_000, `${this.label} exit`);
      return response;
    } catch (error) {
      this.child.kill("SIGTERM");
      try {
        await withTimeout(new Promise((resolveExit) => this.child.once("exit", (code, signal) => resolveExit({ code, signal }))), 1_000, `${this.label} terminate`);
      } catch {
        this.child.kill("SIGKILL");
      }
      if (error instanceof VerifyFailure) {
        throw error;
      }
      fail(`${this.label} cleanup failed.`, {
        code: "S06_FIXTURE_CLEANUP_FAILED",
        label: this.label,
        message: error instanceof Error ? error.message : String(error),
        stderrTail: normalizeOutputTail(this.stderr, this.options),
      }, this.options);
    }
  }
}

export async function startProxyFixture(config, runtime) {
  const redactionOptions = redactionOptionsForSmoke(runtime.rootDir, runtime.smokeContext);
  const child = spawn(PYTHON, ["-u", "-c", PROXY_FIXTURE_MANAGER], {
    cwd: runtime.rootDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const lineProcess = new LineProcess(child, `proxy fixture ${config.label}`, redactionOptions);
  lineProcess.send(config);
  const ready = await lineProcess.readJson(FIXTURE_READY_TIMEOUT_MS);
  assert(ready.ok === true, "Proxy fixture did not become ready.", {
    code: "S06_FIXTURE_READY_FAILED",
    label: config.label,
    error: ready.error,
    stderrTail: normalizeOutputTail(lineProcess.stderr, redactionOptions),
  }, redactionOptions);
  assert(ready.proxy?.mode === "fixedServer" && ready.proxy?.protocol === "http" && typeof ready.proxy?.host === "string" && Number.isInteger(ready.proxy?.port), "Proxy fixture ready payload was malformed.", {
    code: "S06_FIXTURE_READY_MALFORMED",
    label: config.label,
    ready: {
      ok: ready.ok === true,
      fixtureKind: ready.fixtureKind,
      proxyMode: ready.proxy?.mode,
      proxyProtocol: ready.proxy?.protocol,
      hasHost: typeof ready.proxy?.host === "string",
      hasPort: Number.isInteger(ready.proxy?.port),
    },
  }, redactionOptions);
  const fixtureHandle = {
    label: config.label,
    process: lineProcess,
    ready,
    async observations() {
      lineProcess.send({ cmd: "observations" });
      const response = await lineProcess.readJson(FIXTURE_COMMAND_TIMEOUT_MS);
      assert(response.ok === true && Array.isArray(response.proxy) && Array.isArray(response.target), "Proxy fixture observations payload was malformed.", {
        code: "S06_FIXTURE_OBSERVATIONS_MALFORMED",
        label: config.label,
        ok: response.ok === true,
        proxyCount: Array.isArray(response.proxy) ? response.proxy.length : null,
        targetCount: Array.isArray(response.target) ? response.target.length : null,
      }, redactionOptions);
      return { proxy: response.proxy, target: response.target };
    },
    async stop() {
      return lineProcess.stop();
    },
  };
  return {
    value: fixtureHandle,
    log: {
      label: config.label,
      fixtureKind: ready.fixtureKind,
      proxy: {
        mode: ready.proxy.mode,
        protocol: ready.proxy.protocol,
        credentialState: "configured",
      },
      target: "managed-local-fixture",
      ready: true,
    },
  };
}

export async function fixtureObservationCounts(fixture) {
  if (!fixture) {
    return { proxy: 0, target: 0 };
  }
  const observations = await fixture.observations();
  return { proxy: observations.proxy.length, target: observations.target.length };
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function quitDriverSession(driver) {
  if (!driver) {
    return { status: "not-started" };
  }
  await withTimeout(driver.quit(), 10_000, "WebDriver session quit");
  return { status: "quit" };
}

export async function startTauriDriverProcess({ rootDir, smokeContext, platform = process.platform, env = process.env }) {
  const tauriDriver = resolveTauriDriverExecutable({ rootDir, platform, env });
  const port = await allocateLoopbackPort();
  const redactionOptions = redactionOptionsForSmoke(rootDir, smokeContext);
  const child = spawn(tauriDriver.path, ["--port", String(port)], {
    cwd: rootDir,
    env: smokeContext.driverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = createTailRecorder(child, redactionOptions);
  const driverProcess = { child, port, tail, tauriDriver };

  child.once("error", (error) => {
    emit({
      step: "webdriver-driver-start",
      status: "process-error",
      code: "S06_TAURI_DRIVER_PROCESS_ERROR",
      message: error.message,
      smokeProfileName: smokeContext.smokeProfileName,
      smokeRoot: smokeContext.smokeRootRelative,
    });
  });

  await waitForDriverStatus(driverProcess, port, rootDir, smokeContext);
  return {
    value: driverProcess,
    log: {
      port,
      tauriDriver: { name: tauriDriver.name, source: "PATH-or-cargo-bin" },
      smokeProfileName: smokeContext.smokeProfileName,
      smokeRoot: smokeContext.smokeRootRelative,
    },
  };
}

export async function createTauriWebDriverSession({ applicationPath, applicationRelativePath, driverProcess, rootDir, smokeContext }) {
  const redactionOptions = redactionOptionsForSmoke(rootDir, smokeContext);
  try {
    const capabilities = buildTauriWebDriverCapabilities(applicationPath);
    const driver = await new Builder()
      .usingServer(`http://127.0.0.1:${driverProcess.port}`)
      .withCapabilities(capabilities)
      .build();
    const session = await driver.getSession();
    const sessionId = typeof session?.getId === "function" ? session.getId() : null;
    if (!sessionId) {
      try {
        await quitDriverSession(driver);
      } catch {
        // The failure below is the actionable setup error.
      }
      fail("WebDriver setup returned a malformed session response.", {
        code: "S06_WEBDRIVER_SESSION_MALFORMED",
        step: "webdriver-session-start",
        application: applicationRelativePath,
        smokeProfileName: smokeContext.smokeProfileName,
        smokeRoot: smokeContext.smokeRootRelative,
        ...driverTailDetails(driverProcess),
      }, redactionOptions);
    }
    return {
      value: driver,
      log: {
        application: applicationRelativePath,
        browserName: "wry",
        session: "created",
        smokeProfileName: smokeContext.smokeProfileName,
        smokeRoot: smokeContext.smokeRootRelative,
      },
    };
  } catch (error) {
    if (error instanceof VerifyFailure) {
      throw error;
    }
    fail("Failed to create a Tauri WebDriver session for the packaged app.", {
      code: "S06_WEBDRIVER_SESSION_FAILED",
      step: "webdriver-session-start",
      application: applicationRelativePath,
      message: error instanceof Error ? error.message : String(error),
      smokeProfileName: smokeContext.smokeProfileName,
      smokeRoot: smokeContext.smokeRootRelative,
      ...driverTailDetails(driverProcess),
      instruction: "Ensure tauri-driver and the platform WebDriver are installed; on Linux also ensure WebKitWebDriver can launch the packaged executable from a visible display or xvfb-run.",
    }, redactionOptions);
  }
}

function xpathLiteral(value) {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  return `concat(${value.split("'").map((part) => `'${part}'`).join(', "\'", ')})`;
}

async function getVisibleText(driver) {
  try {
    const body = await driver.findElement(By.css("body"));
    return await body.getText();
  } catch {
    return "";
  }
}

export async function safeSelectorContext(driver, rootDir, smokeContext) {
  const redactionOptions = redactionOptionsForSmoke(rootDir, smokeContext);
  const visibleText = await getVisibleText(driver);
  let buttons = [];
  try {
    const buttonElements = await driver.findElements(By.css("button"));
    buttons = (await Promise.all(buttonElements.slice(0, 16).map(async (button) => {
      try {
        const text = (await button.getText()).trim();
        return text || null;
      } catch {
        return null;
      }
    }))).filter(Boolean);
  } catch {
    buttons = [];
  }
  let hasProfileNameInput = false;
  try {
    hasProfileNameInput = (await driver.findElements(By.css("#profile-name"))).length > 0;
  } catch {
    hasProfileNameInput = false;
  }
  const detailRefs = Array.from(new Set((visibleText.match(/\b(?:sidecar|bridge|ui)-[A-Za-z0-9_.:-]+\b/g) ?? []).slice(-6)));

  return {
    visibleText: safeVisibleTextSnippet(visibleText, redactionOptions),
    buttons,
    hasProfileNameInput,
    detailRefs,
  };
}

async function failUi(driver, runtime, message, details = {}) {
  const { rootDir, smokeContext, driverProcess } = runtime;
  const redactionOptions = redactionOptionsForSmoke(rootDir, smokeContext);
  const selectorContext = driver ? await safeSelectorContext(driver, rootDir, smokeContext) : {};
  fail(message, {
    code: details.code ?? "S06_UI_CONTRACT_DRIFT",
    step: details.step,
    smokeProfileName: smokeContext.smokeProfileName,
    smokeRoot: smokeContext.smokeRootRelative,
    ...details,
    selectorContext,
    ...driverTailDetails(driverProcess),
  }, redactionOptions);
}

export async function pollForValue(driver, runtime, description, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? UI_WAIT_TIMEOUT_MS;
  const started = Date.now();
  let lastMessage = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
    }
    await sleep(options.pollMs ?? UI_POLL_MS);
  }
  await failUi(driver, runtime, `Timed out waiting for ${description}.`, {
    code: "S06_UI_TIMEOUT",
    step: options.step,
    description,
    timeoutMs,
    lastMessage,
  });
}

export async function waitForVisibleElement(driver, by, runtime, description, options = {}) {
  try {
    const element = await driver.wait(until.elementLocated(by), options.timeoutMs ?? UI_WAIT_TIMEOUT_MS, undefined, UI_POLL_MS);
    await driver.wait(until.elementIsVisible(element), options.timeoutMs ?? UI_WAIT_TIMEOUT_MS, undefined, UI_POLL_MS);
    return element;
  } catch (error) {
    await failUi(driver, runtime, `Missing visible UI element: ${description}.`, {
      code: "S06_UI_SELECTOR_MISSING",
      step: options.step,
      description,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function waitForVisibleText(driver, expectedText, runtime, options = {}) {
  return pollForValue(driver, runtime, `visible text ${expectedText}`, async () => {
    const text = await getVisibleText(driver);
    return text.includes(expectedText) ? { text: expectedText } : null;
  }, { ...options, step: options.step ?? "visible-text" });
}

function profileCardXPath(name) {
  return `//article[contains(concat(' ', normalize-space(@class), ' '), ' profile-card ')][.//h3[normalize-space()=${xpathLiteral(name)}]]`;
}

function profileCardByName(name) {
  return By.xpath(profileCardXPath(name));
}

function profileSectionByAriaLabel(profileName, ariaLabel) {
  return By.xpath(`${profileCardXPath(profileName)}//section[@aria-label=${xpathLiteral(ariaLabel)}]`);
}

export async function waitForProfileCard(driver, profileName, runtime, options = {}) {
  return waitForVisibleElement(driver, profileCardByName(profileName), runtime, `profile card ${profileName}`, {
    ...options,
    step: options.step ?? "profile-card",
  });
}

export async function waitForProfileButton(driver, profileName, buttonText, runtime, options = {}) {
  return pollForValue(driver, runtime, `${buttonText} button for ${profileName}`, async () => {
    const cards = await driver.findElements(profileCardByName(profileName));
    for (const card of cards) {
      if (!(await card.isDisplayed())) {
        continue;
      }
      const buttons = await card.findElements(By.xpath(`.//button[normalize-space()=${xpathLiteral(buttonText)}]`));
      for (const button of buttons) {
        if ((await button.isDisplayed()) && (await button.isEnabled())) {
          return button;
        }
      }
    }
    return null;
  }, { ...options, step: options.step ?? "profile-button" });
}

export async function waitForMetricValue(driver, sectionLabel, metricLabel, expectedValue, runtime, options = {}) {
  const selector = By.xpath(`//*[@aria-label=${xpathLiteral(sectionLabel)}]//dt[normalize-space()=${xpathLiteral(metricLabel)}]/following-sibling::dd[1][normalize-space()=${xpathLiteral(String(expectedValue))}]`);
  return waitForVisibleElement(driver, selector, runtime, `${sectionLabel} metric ${metricLabel}=${expectedValue}`, {
    ...options,
    step: options.step ?? "metric-value",
  });
}

export async function readMetricValue(driver, sectionLabel, metricLabel) {
  try {
    const elements = await driver.findElements(By.xpath(`//*[@aria-label=${xpathLiteral(sectionLabel)}]//dt[normalize-space()=${xpathLiteral(metricLabel)}]/following-sibling::dd[1]`));
    for (const element of elements) {
      if (!(await element.isDisplayed())) {
        continue;
      }
      const text = (await element.getText()).trim();
      return text && text !== "Unavailable" ? text : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function readProfileSectionText(driver, profileName, ariaLabel) {
  try {
    const regions = await driver.findElements(profileRegionByAriaLabel(profileName, ariaLabel));
    for (const region of regions) {
      if (!(await region.isDisplayed())) {
        continue;
      }
      return (await region.getText()).trim();
    }
  } catch {
    return "";
  }
  return "";
}

export async function readProfileCardText(driver, profileName) {
  try {
    const cards = await driver.findElements(profileCardByName(profileName));
    for (const card of cards) {
      if (!(await card.isDisplayed())) {
        continue;
      }
      return (await card.getText()).trim();
    }
  } catch {
    return "";
  }
  return "";
}

export async function assertInitialPackagedUi(driver, runtime) {
  await waitForVisibleText(driver, "Persistent profiles, transient browsers.", runtime, { step: "packaged-ui-initial" });
  await waitForVisibleElement(driver, By.css("#profile-name"), runtime, "#profile-name", { step: "packaged-ui-initial" });
  await waitForVisibleText(driver, "Bring old ThePrivator profiles into the sidecar store deliberately.", runtime, { step: "packaged-ui-initial" });
  return {
    heading: "Persistent profiles, transient browsers.",
    profileNameInput: "visible",
    legacyImportSurface: "visible",
    smokeProfileName: runtime.smokeContext.smokeProfileName,
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

export async function createSmokeProfile(driver, runtime) {
  const input = await waitForVisibleElement(driver, By.css("#profile-name"), runtime, "#profile-name", { step: "packaged-profile-create" });
  try {
    await input.clear();
    await input.sendKeys(runtime.smokeContext.smokeProfileName);
  } catch (error) {
    await failUi(driver, runtime, "Failed to type the smoke profile name into the visible form.", {
      code: "S06_UI_INPUT_FAILED",
      step: "packaged-profile-create",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const createButton = await waitForVisibleElement(
    driver,
    By.xpath("//form[@aria-label='Create profile']//button[normalize-space()='Create profile']"),
    runtime,
    "Create profile button",
    { step: "packaged-profile-create" },
  );
  try {
    await driver.wait(until.elementIsEnabled(createButton), UI_WAIT_TIMEOUT_MS, undefined, UI_POLL_MS);
    await createButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Create profile button.", {
      code: "S06_UI_CLICK_FAILED",
      step: "packaged-profile-create",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  await waitForProfileCard(driver, runtime.smokeContext.smokeProfileName, runtime, { step: "packaged-profile-create" });
  return {
    smokeProfileName: runtime.smokeContext.smokeProfileName,
    profileCard: "visible",
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

function profileRegionByAriaLabel(profileName, ariaLabel) {
  return By.xpath(`${profileCardXPath(profileName)}//*[@aria-label=${xpathLiteral(ariaLabel)}]`);
}

async function waitForProfileSectionText(driver, profileName, ariaLabel, expectedText, runtime, options = {}) {
  const selector = By.xpath(`${profileCardXPath(profileName)}//*[@aria-label=${xpathLiteral(ariaLabel)}][contains(normalize-space(.), ${xpathLiteral(expectedText)})]`);
  await waitForVisibleElement(driver, selector, runtime, `${ariaLabel} text ${expectedText}`, {
    ...options,
    step: options.step ?? "profile-section-text",
  });
  return { ariaLabel, text: expectedText };
}

async function waitForProfileSectionTexts(driver, profileName, ariaLabel, expectedTexts, runtime, options = {}) {
  for (const expectedText of expectedTexts) {
    await waitForProfileSectionText(driver, profileName, ariaLabel, expectedText, runtime, options);
  }
  return {
    ariaLabel,
    observedText: expectedTexts,
  };
}

async function waitForSmokeIdentityPresetControls(driver, runtime, options = {}) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const panelSelector = profileSectionByAriaLabel(profileName, `Configure identity for ${profileName}`);
  return pollForValue(driver, runtime, PACKAGED_SMOKE_PRESET_LABEL, async () => {
    const panels = await driver.findElements(panelSelector);
    for (const panel of panels) {
      if (!(await panel.isDisplayed())) {
        continue;
      }
      const selects = await panel.findElements(By.xpath(".//label[normalize-space()='Curated preset']/following-sibling::select[1]"));
      for (const select of selects) {
        if (!(await select.isDisplayed())) {
          continue;
        }
        const matchingOptions = await select.findElements(By.xpath(`.//option[@value=${xpathLiteral(PACKAGED_SMOKE_PRESET_ID)} and contains(normalize-space(.), ${xpathLiteral(PACKAGED_SMOKE_PRESET_LABEL)})]`));
        const presetOptions = await select.findElements(By.xpath(".//option[string-length(normalize-space(@value)) > 0]"));
        if (matchingOptions.length > 0 && await select.isEnabled()) {
          return {
            select,
            option: matchingOptions[0],
            presetCount: presetOptions.length,
          };
        }
      }
    }
    return null;
  }, { ...options, step: options.step ?? "packaged-identity-config" });
}

export async function assertSmokeIdentitySummary(driver, runtime, options = {}) {
  const profileName = runtime.smokeContext.smokeProfileName;
  await waitForProfileSectionTexts(driver, profileName, `${profileName} saved identity summary`, [
    PACKAGED_SMOKE_PRESET_LABEL,
    `Preset ${PACKAGED_SMOKE_PRESET_ID}`,
    "Browser masked",
    "Canvas noise",
    "WebGL masked",
  ], runtime, { ...options, step: options.step ?? "packaged-identity-summary" });
  return {
    label: PACKAGED_SMOKE_PRESET_LABEL,
    presetId: PACKAGED_SMOKE_PRESET_ID,
    surfaceModes: PACKAGED_SMOKE_EXPECTED_SURFACE_MODES,
    summary: "visible",
  };
}

export async function openSmokeIdentityConfig(driver, runtime) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const configureButton = await waitForProfileButton(driver, profileName, "Configure identity", runtime, {
    step: "packaged-identity-config",
  });
  try {
    await configureButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Configure identity button.", {
      code: "S06_UI_CLICK_FAILED",
      step: "packaged-identity-config",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  await waitForVisibleElement(driver, profileSectionByAriaLabel(profileName, `Configure identity for ${profileName}`), runtime, `Configure identity for ${profileName}`, {
    step: "packaged-identity-config",
  });
  const controls = await waitForSmokeIdentityPresetControls(driver, runtime, { step: "packaged-identity-config" });
  await waitForMetricValue(driver, `${profileName} identity observability`, "Preset count", String(controls.presetCount), runtime, {
    step: "packaged-identity-config",
  });
  await waitForProfileSectionTexts(driver, profileName, `Configure identity for ${profileName}`, [
    "Profile identity configuration",
    "Apply a curated preset",
    PACKAGED_SMOKE_PRESET_LABEL,
  ], runtime, { step: "packaged-identity-config" });

  return {
    smokeProfileName: profileName,
    identityPanel: "visible",
    presetId: PACKAGED_SMOKE_PRESET_ID,
    presetLabel: PACKAGED_SMOKE_PRESET_LABEL,
    presetCount: controls.presetCount,
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

export async function applySmokeIdentityPreset(driver, runtime) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const controls = await waitForSmokeIdentityPresetControls(driver, runtime, { step: "packaged-identity-apply" });
  try {
    await controls.select.click();
    await controls.option.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to select the curated identity preset through the visible select control.", {
      code: "S06_UI_SELECT_FAILED",
      step: "packaged-identity-apply",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const applyButton = await waitForProfileButton(driver, profileName, "Apply preset", runtime, {
    step: "packaged-identity-apply",
  });
  try {
    await applyButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Apply preset button.", {
      code: "S06_UI_CLICK_FAILED",
      step: "packaged-identity-apply",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  await waitForVisibleText(driver, "Preset applied for next launch.", runtime, { step: "packaged-identity-apply" });
  await waitForVisibleText(driver, "Preset applied with 0 sidecar warnings.", runtime, { step: "packaged-identity-apply" });
  const summary = await assertSmokeIdentitySummary(driver, runtime, { step: "packaged-identity-apply" });
  return {
    smokeProfileName: profileName,
    presetId: PACKAGED_SMOKE_PRESET_ID,
    presetLabel: PACKAGED_SMOKE_PRESET_LABEL,
    presetCount: controls.presetCount,
    successCopy: "visible",
    ...summary,
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

async function openSmokeAuditGuide(driver, runtime) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const openButton = await waitForProfileButton(driver, profileName, "Open audit guide", runtime, {
    step: "packaged-audit-plan",
  });
  try {
    await openButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Open audit guide button.", {
      code: "S06_UI_CLICK_FAILED",
      step: "packaged-audit-plan",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  await waitForVisibleElement(driver, profileSectionByAriaLabel(profileName, `Audit guide for ${profileName}`), runtime, `Audit guide for ${profileName}`, {
    step: "packaged-audit-plan",
  });
  await waitForProfileSectionTexts(driver, profileName, `Audit guide for ${profileName}`, [
    `${PACKAGED_SMOKE_AUDIT_PAGE_COUNT} curated checker pages`,
    "Compare manually; do not treat one public checker as authoritative.",
    "Public checker pages can change",
    "Checker, page, or network issues are external instability",
    PACKAGED_SMOKE_AUDIT_PAGE_LABEL,
    PACKAGED_SMOKE_AUDIT_PAGE_ID,
    "The app sends only the fixed pageId to the typed audit-open wrapper",
  ], runtime, { step: "packaged-audit-plan" });

  return {
    smokeProfileName: profileName,
    pageCount: PACKAGED_SMOKE_AUDIT_PAGE_COUNT,
    pageId: PACKAGED_SMOKE_AUDIT_PAGE_ID,
    pageLabel: PACKAGED_SMOKE_AUDIT_PAGE_LABEL,
    checkerContent: "not-inspected",
    authority: "page-id-only",
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

async function waitForAuditPageOpenButton(driver, runtime, options = {}) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const selector = By.xpath(`${profileCardXPath(profileName)}//article[contains(concat(' ', normalize-space(@class), ' '), ' identity-audit-page-card ')][.//h5[normalize-space()=${xpathLiteral(PACKAGED_SMOKE_AUDIT_PAGE_LABEL)}] and .//dt[normalize-space()='Page ID']/following-sibling::dd[1][normalize-space()=${xpathLiteral(PACKAGED_SMOKE_AUDIT_PAGE_ID)}]]//button[normalize-space()='Open in profile']`);
  return pollForValue(driver, runtime, `${PACKAGED_SMOKE_AUDIT_PAGE_LABEL} Open in profile button`, async () => {
    const buttons = await driver.findElements(selector);
    for (const button of buttons) {
      if ((await button.isDisplayed()) && (await button.isEnabled())) {
        return button;
      }
    }
    return null;
  }, { ...options, step: options.step ?? "packaged-audit-open" });
}

async function openSmokeAuditPage(driver, runtime) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const openButton = await waitForAuditPageOpenButton(driver, runtime, { step: "packaged-audit-open" });
  try {
    await openButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click BrowserLeaks WebGL Open in profile through the visible audit guide.", {
      code: "S06_UI_CLICK_FAILED",
      step: "packaged-audit-open",
      pageId: PACKAGED_SMOKE_AUDIT_PAGE_ID,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  await waitForProfileSectionTexts(driver, profileName, `Audit guide for ${profileName}`, [
    `${PACKAGED_SMOKE_AUDIT_PAGE_LABEL} opened in the configured profile.`,
    "The sidecar launched an audit-capable Chromium session before opening the curated page.",
    "The app does not read public page content or checker scores.",
    "Page ID",
    PACKAGED_SMOKE_AUDIT_PAGE_ID,
    "Launched by audit-open",
    "launched · 1 running",
  ], runtime, { step: "packaged-audit-open" });

  return {
    smokeProfileName: profileName,
    pageId: PACKAGED_SMOKE_AUDIT_PAGE_ID,
    pageLabel: PACKAGED_SMOKE_AUDIT_PAGE_LABEL,
    openSuccess: "visible",
    launchMetadata: "launched",
    runningCount: 1,
    checkerContent: "not-inspected",
    authority: "page-id-only",
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

export async function launchSmokeChromium(driver, runtime) {
  const launchButton = await waitForProfileButton(driver, runtime.smokeContext.smokeProfileName, "Launch Chromium", runtime, {
    step: "packaged-chromium-launch",
  });
  try {
    await launchButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Launch Chromium button.", {
      code: "S06_UI_CLICK_FAILED",
      step: "packaged-chromium-launch",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  await waitForVisibleText(driver, "Running from sidecar runtime bookkeeping", runtime, { step: "packaged-chromium-launch" });
  await waitForMetricValue(driver, "Profile observability", "Running count", "1", runtime, { step: "packaged-chromium-launch" });
  return {
    smokeProfileName: runtime.smokeContext.smokeProfileName,
    lifecycle: "running",
    runningCount: 1,
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

export async function stopSmokeChromium(driver, runtime, options = {}) {
  const step = options.step ?? "packaged-chromium-stop";
  const stopButton = await waitForProfileButton(driver, runtime.smokeContext.smokeProfileName, "Stop Chromium", runtime, {
    step,
  });
  try {
    await stopButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Stop Chromium button.", {
      code: "S06_UI_CLICK_FAILED",
      step,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  await waitForProfileButton(driver, runtime.smokeContext.smokeProfileName, "Launch Chromium", runtime, {
    step,
  });
  await waitForMetricValue(driver, "Profile observability", "Running count", "0", runtime, { step });
  return {
    smokeProfileName: runtime.smokeContext.smokeProfileName,
    lifecycle: "stopped",
    runningCount: 0,
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

export async function assertRestartPersistence(driver, runtime) {
  await waitForVisibleText(driver, "Persistent profiles, transient browsers.", runtime, { step: "packaged-restart-persistence" });
  await waitForProfileCard(driver, runtime.smokeContext.smokeProfileName, runtime, { step: "packaged-restart-persistence" });
  const identitySummary = await assertSmokeIdentitySummary(driver, runtime, { step: "packaged-restart-persistence" });
  const proxySummary = await assertSmokeProxySummary(driver, runtime, { step: "packaged-restart-persistence" });
  return {
    smokeProfileName: runtime.smokeContext.smokeProfileName,
    profileCard: "visible-after-restart",
    identitySummary,
    proxySummary,
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

function proxyConfigSectionLabel(profileName) {
  return `Configure proxy for ${profileName}`;
}

async function clickProxyPanelLabel(driver, runtime, labelText, options = {}) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const step = options.step ?? "packaged-proxy-configure";
  const selector = By.xpath(`${profileCardXPath(profileName)}//section[@aria-label=${xpathLiteral(proxyConfigSectionLabel(profileName))}]//label[.//span[normalize-space()=${xpathLiteral(labelText)}] or normalize-space()=${xpathLiteral(labelText)}]`);
  const label = await waitForVisibleElement(driver, selector, runtime, `${labelText} proxy label`, { step });
  try {
    await label.click();
  } catch (error) {
    await failUi(driver, runtime, `Failed to click the visible ${labelText} proxy control.`, {
      code: "S06_UI_CLICK_FAILED",
      step,
      labelText,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return label;
}

async function setProxyPanelInput(driver, runtime, labelText, value, options = {}) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const step = options.step ?? "packaged-proxy-configure";
  const selector = By.xpath(`${profileCardXPath(profileName)}//section[@aria-label=${xpathLiteral(proxyConfigSectionLabel(profileName))}]//label[normalize-space()=${xpathLiteral(labelText)}]/following-sibling::input[1]`);
  const input = await waitForVisibleElement(driver, selector, runtime, `${labelText} proxy input`, { step });
  try {
    await input.clear();
    await input.sendKeys(String(value));
  } catch (error) {
    await failUi(driver, runtime, `Failed to type the ${labelText} proxy value through the visible form.`, {
      code: "S06_UI_INPUT_FAILED",
      step,
      labelText,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return input;
}

async function selectProxyProtocol(driver, runtime, protocol, options = {}) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const step = options.step ?? "packaged-proxy-configure";
  const selectSelector = By.xpath(`${profileCardXPath(profileName)}//section[@aria-label=${xpathLiteral(proxyConfigSectionLabel(profileName))}]//label[normalize-space()='Protocol']/following-sibling::select[1]`);
  const optionSelector = By.xpath(`${profileCardXPath(profileName)}//section[@aria-label=${xpathLiteral(proxyConfigSectionLabel(profileName))}]//label[normalize-space()='Protocol']/following-sibling::select[1]/option[@value=${xpathLiteral(protocol)}]`);
  const select = await waitForVisibleElement(driver, selectSelector, runtime, "Protocol proxy select", { step });
  const option = await waitForVisibleElement(driver, optionSelector, runtime, `${protocol} proxy protocol option`, { step });
  try {
    await select.click();
    await option.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to choose the visible proxy protocol option.", {
      code: "S06_UI_SELECT_FAILED",
      step,
      protocol,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function assertNoCredentialTextVisible(driver, runtime, step) {
  const text = await getVisibleText(driver);
  assertNoUnsafeText("packaged proxy UI visible text", text, {
    ...redactionOptionsForSmoke(runtime.rootDir, runtime.smokeContext),
    sensitiveValues: [PACKAGED_SMOKE_PROXY_USERNAME, PACKAGED_SMOKE_PROXY_PASSWORD],
  });
  return { step, redacted: true };
}

async function assertSmokeProxySummary(driver, runtime, options = {}) {
  const profileName = runtime.smokeContext.smokeProfileName;
  await waitForProfileSectionTexts(driver, profileName, `${profileName} saved proxy summary`, [
    "M003 saved proxy",
    "Fixed server",
    "HTTP",
    "configured (masked)",
  ], runtime, { ...options, step: options.step ?? "packaged-proxy-summary" });
  await assertNoCredentialTextVisible(driver, runtime, options.step ?? "packaged-proxy-summary");
  return {
    mode: "fixedServer",
    protocol: "http",
    credentialState: "configured",
    summary: "visible-redacted",
  };
}

const SAVED_PROXY_PROOF_VOCABULARY = Object.freeze([
  {
    code: "routeProof",
    required: [
      "Local fixture proved saved proxy routing.",
      "The local fixture observed proxy routing",
      "Deterministic local route proof",
      "sidecar-managed local fixture saw the proxy path",
    ],
  },
  {
    code: "ipHiding",
    required: [
      "IP-hiding conclusion",
      "target-IP hiding only for the deterministic fixture",
    ],
  },
  {
    code: "webRtc",
    required: ["WebRTC / local-IP baseline"],
  },
  {
    code: "publicCheckers",
    required: [
      "Public checker advisory pages",
      "Advisory only",
    ],
  },
  {
    code: "httpProxy",
    required: [
      "Protocol HTTP",
      "Credential state configured (masked)",
      "Fallback route Not detected",
    ],
  },
]);

function normalizeUiTextForSearch(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizedIncludes(normalizedText, expectedText) {
  const expected = normalizeUiTextForSearch(expectedText);
  if (normalizedText.includes(expected)) {
    return true;
  }
  return normalizedText.replace(/\s+/g, "").includes(expected.replace(/\s+/g, ""));
}

export function describeSavedProxyProofUiState(state = {}) {
  const resultText = String(state.resultText ?? "");
  const visibleText = String(state.visibleText ?? "");
  const phase = typeof state.phase === "string" && state.phase.trim() ? state.phase.trim() : null;
  const request = typeof state.request === "string" && state.request.trim() ? state.request.trim() : null;
  const previousRequest = typeof state.previousRequest === "string" && state.previousRequest.trim() ? state.previousRequest.trim() : null;
  const normalizedResult = normalizeUiTextForSearch(resultText);
  const normalizedVisible = normalizeUiTextForSearch(`${visibleText} ${resultText} ${phase ?? ""}`);
  const missingVocabulary = SAVED_PROXY_PROOF_VOCABULARY
    .filter(({ required }) => required.some((item) => !normalizedIncludes(normalizedResult, item)))
    .map(({ code }) => code);
  const hasResult = normalizedResult.length > 0;
  const hasRequiredVocabulary = hasResult && missingVocabulary.length === 0;
  const hasCurrentHttpSuccess = hasRequiredVocabulary
    && !normalizedIncludes(normalizedResult, "Saved proxy proof completed without proving IP hiding.")
    && normalizedIncludes(normalizedResult, "Protocol HTTP")
    && normalizedIncludes(normalizedResult, "Credential state configured (masked)")
    && normalizedIncludes(normalizedResult, "Fallback route Not detected");
  return {
    phase,
    request,
    previousRequest,
    hasResult,
    hasRequiredVocabulary,
    hasCurrentHttpSuccess,
    missingVocabulary,
    runningObserved: /^running\b/i.test(phase ?? "") || normalizedIncludes(normalizedVisible, "Running saved proxy proof"),
    staleSocksFailureObserved: normalizedIncludes(normalizedVisible, "PROXY_SOCKS_AUTH_UNSUPPORTED")
      || normalizedIncludes(normalizedVisible, "SOCKS proxy credentials cannot be used"),
    staleRequest: Boolean(previousRequest && request && request === previousRequest),
  };
}

export function assertCurrentHttpSavedProxyProofUiState(state = {}, options = {}) {
  const summary = describeSavedProxyProofUiState({
    ...state,
    previousRequest: options.previousRequest ?? state.previousRequest,
  });
  if (!summary.hasResult) {
    fail("Current HTTP saved proxy proof results were not visible.", {
      code: "S06_SAVED_PROXY_PROOF_MISSING",
      proofState: summary,
    });
  }
  if (!summary.hasRequiredVocabulary) {
    fail("Current HTTP saved proxy proof result omitted required S04 vocabulary.", {
      code: "S06_SAVED_PROXY_PROOF_MALFORMED",
      proofState: summary,
    });
  }
  if (!summary.hasCurrentHttpSuccess) {
    fail("Current HTTP saved proxy proof did not prove the HTTP fixture.", {
      code: "S06_SAVED_PROXY_PROOF_NOT_PROVED",
      proofState: summary,
    });
  }
  if (options.requireNewRequest !== false && summary.staleRequest) {
    fail("Current HTTP saved proxy proof reused a stale request id.", {
      code: "S06_SAVED_PROXY_PROOF_STALE_REQUEST",
      proofState: summary,
    });
  }
  return summary;
}

export async function latestVisibleDetailRef(driver, runtime, step) {
  const visibleText = await getVisibleText(driver);
  const sidecarRefs = Array.from(visibleText.matchAll(/\bsidecar-[a-f0-9]{12}(?![a-f0-9])/gi)).map((match) => match[0]);
  const bridgeRefs = Array.from(visibleText.matchAll(/\bbridge-[A-Za-z0-9_.:-]{8,160}/g)).map((match) => match[0].replace(/(?:Lookup|Retry).*$/u, ""));
  const uiRefs = Array.from(visibleText.matchAll(/\bui-[A-Za-z0-9_.:-]{8,160}/g)).map((match) => match[0].replace(/(?:Lookup|Retry).*$/u, ""));
  const detailRefs = [...sidecarRefs, ...bridgeRefs, ...uiRefs].filter((detailRef) => /^(?:sidecar|bridge|ui)-[A-Za-z0-9_.:-]+$/.test(detailRef));
  const detailRef = detailRefs.at(-1);
  if (!detailRef) {
    await failUi(driver, runtime, "Expected a visible diagnostic detailRef.", {
      code: "S06_UI_DETAIL_REF_MISSING",
      step,
    });
  }
  return detailRef;
}

export async function lookupVisibleDiagnosticRef(driver, runtime, detailRef, options = {}) {
  const step = options.step ?? "packaged-diagnostic-lookup";
  const lookupButton = await waitForVisibleElement(driver, By.xpath(`//button[@aria-label=${xpathLiteral(`Lookup diagnostics for ${detailRef}`)}]`), runtime, `diagnostic lookup button for ${detailRef}`, { step });
  try {
    await lookupButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible diagnostics lookup button.", {
      code: "S06_UI_CLICK_FAILED",
      step,
      detailRef,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await waitForVisibleText(driver, "Persisted diagnostic event summaries matched this detailRef.", runtime, { step });
  await waitForVisibleText(driver, detailRef, runtime, { step });
  return { detailRef: "visible", lookup: "matched-redacted-diagnostics" };
}

export async function configureUnsupportedSocksProxyAndAssertProofFailure(driver, runtime, fixture) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const step = "packaged-socks-auth-negative-proof";
  const configureButton = await waitForProfileButton(driver, profileName, "Configure proxy", runtime, { step });
  try {
    await configureButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Configure proxy button for the SOCKS negative proof.", {
      code: "S06_UI_CLICK_FAILED",
      step,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const panelLabel = proxyConfigSectionLabel(profileName);
  await waitForVisibleElement(driver, profileSectionByAriaLabel(profileName, panelLabel), runtime, panelLabel, { step });
  await clickProxyPanelLabel(driver, runtime, "Fixed server", { step });
  await selectProxyProtocol(driver, runtime, "socks5", { step });
  await setProxyPanelInput(driver, runtime, "Host", fixture.ready.proxy.host, { step });
  await setProxyPanelInput(driver, runtime, "Port", fixture.ready.proxy.port, { step });
  await clickProxyPanelLabel(driver, runtime, "Replace credentials", { step });
  await setProxyPanelInput(driver, runtime, "Replacement username", PACKAGED_SMOKE_PROXY_USERNAME, { step });
  await setProxyPanelInput(driver, runtime, "Replacement password", PACKAGED_SMOKE_PROXY_PASSWORD, { step });

  const saveButton = await waitForProfileButton(driver, profileName, "Save proxy", runtime, { step });
  try {
    await saveButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Save proxy button for the SOCKS negative proof.", {
      code: "S06_UI_CLICK_FAILED",
      step,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await waitForVisibleText(driver, "Proxy configuration saved.", runtime, { step });
  await waitForVisibleText(driver, "Proxy configuration saved with redacted public profile truth", runtime, { step });

  const runButton = await waitForProfileButton(driver, profileName, "Run saved proxy proof", runtime, { step });
  try {
    await runButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Run saved proxy proof button for the SOCKS negative proof.", {
      code: "S06_UI_CLICK_FAILED",
      step,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await waitForVisibleText(driver, "PROXY_SOCKS_AUTH_UNSUPPORTED", runtime, { step });
  await waitForVisibleText(driver, "SOCKS proxy credentials cannot be used", runtime, { step });
  const detailRef = await latestVisibleDetailRef(driver, runtime, step);
  const diagnosticsLookup = await lookupVisibleDiagnosticRef(driver, runtime, detailRef, { step });
  await waitForVisibleText(driver, "profiles.proxy.check", runtime, { step });
  await assertNoCredentialTextVisible(driver, runtime, step);
  return {
    status: "typed-negative-proved",
    code: "PROXY_SOCKS_AUTH_UNSUPPORTED",
    detailRef: diagnosticsLookup.detailRef,
    diagnosticsLookup: diagnosticsLookup.lookup,
    savedProxyOverwrittenBy: "packaged-proxy-configure-save",
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

export async function configureSmokeProxy(driver, runtime, fixture, options = {}) {
  const proxyUsername = options.credentials?.username ?? PACKAGED_SMOKE_PROXY_USERNAME;
  const proxyPassword = options.credentials?.password ?? PACKAGED_SMOKE_PROXY_PASSWORD;
  const profileName = runtime.smokeContext.smokeProfileName;
  const configureButton = await waitForProfileButton(driver, profileName, "Configure proxy", runtime, {
    step: "packaged-proxy-configure",
  });
  try {
    await configureButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Configure proxy button.", {
      code: "S06_UI_CLICK_FAILED",
      step: "packaged-proxy-configure",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const panelLabel = proxyConfigSectionLabel(profileName);
  await waitForVisibleElement(driver, profileSectionByAriaLabel(profileName, panelLabel), runtime, panelLabel, {
    step: "packaged-proxy-configure",
  });
  await clickProxyPanelLabel(driver, runtime, "Fixed server", { step: "packaged-proxy-configure" });
  await selectProxyProtocol(driver, runtime, "http", { step: "packaged-proxy-configure" });
  await setProxyPanelInput(driver, runtime, "Host", fixture.ready.proxy.host, { step: "packaged-proxy-configure" });
  await setProxyPanelInput(driver, runtime, "Port", fixture.ready.proxy.port, { step: "packaged-proxy-configure" });
  await clickProxyPanelLabel(driver, runtime, "Replace credentials", { step: "packaged-proxy-configure" });
  await setProxyPanelInput(driver, runtime, "Replacement username", proxyUsername, { step: "packaged-proxy-configure" });
  await setProxyPanelInput(driver, runtime, "Replacement password", proxyPassword, { step: "packaged-proxy-configure" });

  const checkButton = await waitForProfileButton(driver, profileName, "Check proxy", runtime, { step: "packaged-proxy-check" });
  try {
    await checkButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Check proxy button.", {
      code: "S06_UI_CLICK_FAILED",
      step: "packaged-proxy-check",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await waitForVisibleText(driver, "Proxy draft validation completed.", runtime, { step: "packaged-proxy-check" });
  await waitForVisibleText(driver, "Proxy draft validation completed with 0 warnings.", runtime, { step: "packaged-proxy-check" });
  await assertNoCredentialTextVisible(driver, runtime, "packaged-proxy-check");

  const saveButton = await waitForProfileButton(driver, profileName, "Save proxy", runtime, { step: "packaged-proxy-save" });
  try {
    await saveButton.click();
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Save proxy button.", {
      code: "S06_UI_CLICK_FAILED",
      step: "packaged-proxy-save",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await waitForVisibleText(driver, "Proxy configuration saved.", runtime, { step: "packaged-proxy-save" });
  await waitForVisibleText(driver, "Proxy configuration saved with redacted public profile truth", runtime, { step: "packaged-proxy-save" });
  await waitForMetricValue(driver, `${profileName} proxy observability`, "Credential state", "configured (masked)", runtime, { step: "packaged-proxy-save" });
  const summary = await assertSmokeProxySummary(driver, runtime, { step: "packaged-proxy-save" });
  await waitForSavedProxyProofResetAfterHttpSave(driver, runtime, { step: "packaged-proxy-save" });
  return {
    smokeProfileName: profileName,
    mode: "fixedServer",
    protocol: "http",
    credentialState: "configured",
    summary: summary.summary,
    fixture: {
      status: "ready",
      kind: fixture.ready.fixtureKind,
      target: "local-fixture",
    },
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

async function waitForSavedProxyProofResetAfterHttpSave(driver, runtime, options = {}) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const step = options.step ?? "packaged-proxy-save";
  const timeoutMs = options.timeoutMs ?? UI_WAIT_TIMEOUT_MS;
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    const inputText = await readProfileSectionText(driver, profileName, `${profileName} saved proxy proof input`);
    const resultText = await readProfileSectionText(driver, profileName, "Saved proxy proof results");
    const cardText = await readProfileCardText(driver, profileName);
    const phase = await readMetricValue(driver, `${profileName} proxy-check observability`, "Proxy check phase");
    const normalizedInput = normalizeUiTextForSearch(inputText);
    const normalizedCard = normalizeUiTextForSearch(cardText);
    lastState = {
      inputHttp: normalizedIncludes(normalizedInput, "Fixed endpoint")
        && normalizedIncludes(normalizedInput, "Protocol HTTP")
        && normalizedIncludes(normalizedInput, "Credential state configured (masked)"),
      phase,
      staleResultVisible: Boolean(resultText),
      staleSocksFailureObserved: normalizedIncludes(normalizedCard, "PROXY_SOCKS_AUTH_UNSUPPORTED")
        || normalizedIncludes(normalizedCard, "SOCKS proxy credentials cannot be used"),
    };
    if (/^idle\b/i.test(phase ?? "") && !lastState.staleResultVisible && !lastState.staleSocksFailureObserved) {
      return {
        savedProof: "reset-after-http-save",
        input: lastState.inputHttp ? "http-fixed-configured" : "http-summary-verified",
      };
    }
    await sleep(options.pollMs ?? UI_POLL_MS);
  }
  await failUi(driver, runtime, "HTTP proxy save did not reset stale saved-proxy proof state.", {
    code: "S06_SAVED_PROXY_PROOF_RESET_TIMEOUT",
    step,
    timeoutMs,
    proofState: lastState,
  });
}

async function readSavedProxyProofUiState(driver, runtime, previousRequest) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const resultText = await readProfileSectionText(driver, profileName, "Saved proxy proof results");
  const inputText = await readProfileSectionText(driver, profileName, `${profileName} saved proxy proof input`);
  const visibleText = await getVisibleText(driver);
  const phase = await readMetricValue(driver, `${profileName} proxy-check observability`, "Proxy check phase");
  const request = await readMetricValue(driver, `${profileName} proxy-check observability`, "Request");
  return describeSavedProxyProofUiState({ resultText: resultText ? `${resultText}\n${inputText}` : "", visibleText, phase, request, previousRequest });
}

async function waitForCurrentSavedProxyProofResult(driver, runtime, options = {}) {
  const step = options.step ?? "packaged-saved-proxy-proof";
  const previousRequest = options.previousRequest ?? null;
  const timeoutMs = options.timeoutMs ?? UI_WAIT_TIMEOUT_MS;
  const started = Date.now();
  let transitionObserved = false;
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    const state = await readSavedProxyProofUiState(driver, runtime, previousRequest);
    transitionObserved = transitionObserved || state.runningObserved;
    const newRequestObserved = Boolean(state.request && state.request !== previousRequest);
    lastState = { ...state, transitionObserved, newRequestObserved };

    if (state.hasResult && !state.hasRequiredVocabulary && (transitionObserved || newRequestObserved || !previousRequest)) {
      await failUi(driver, runtime, "Current HTTP saved proxy proof result omitted required S04 vocabulary.", {
        code: "S06_SAVED_PROXY_PROOF_MALFORMED",
        step,
        proofState: lastState,
      });
    }

    if (state.hasResult && state.hasRequiredVocabulary && !state.hasCurrentHttpSuccess && (transitionObserved || newRequestObserved || !previousRequest)) {
      await failUi(driver, runtime, "Current HTTP saved proxy proof result did not prove the HTTP fixture.", {
        code: "S06_SAVED_PROXY_PROOF_NOT_PROVED",
        step,
        proofState: lastState,
      });
    }

    if (state.hasCurrentHttpSuccess && (transitionObserved || newRequestObserved || !previousRequest)) {
      return lastState;
    }

    await sleep(options.pollMs ?? UI_POLL_MS);
  }

  await failUi(driver, runtime, "Timed out waiting for current HTTP saved proxy proof results after rerun.", {
    code: "S06_SAVED_PROXY_PROOF_TIMEOUT",
    step,
    timeoutMs,
    proofState: lastState,
  });
}

async function waitForSavedProxyProofKickoff(driver, runtime, previousRequest, options = {}) {
  const timeoutMs = options.timeoutMs ?? Math.min(4000, UI_WAIT_TIMEOUT_MS);
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    const state = await readSavedProxyProofUiState(driver, runtime, previousRequest);
    const newRequestObserved = Boolean(state.request && state.request !== previousRequest);
    lastState = { ...state, newRequestObserved };
    if (state.runningObserved || state.hasResult || newRequestObserved) {
      return lastState;
    }
    await sleep(options.pollMs ?? UI_POLL_MS);
  }
  return lastState;
}

async function clickRunSavedProxyProofButton(driver, runtime, button, attempt, step) {
  try {
    await driver.executeScript("arguments[0].scrollIntoView({ block: 'center', inline: 'nearest' });", button);
    if (attempt === 1) {
      await button.click();
      return "native-click";
    }
    await driver.executeScript("arguments[0].click();", button);
    return "dom-click";
  } catch (error) {
    await failUi(driver, runtime, "Failed to click the visible Run saved proxy proof button.", {
      code: "S06_UI_CLICK_FAILED",
      step,
      attempt,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runSavedProxyProof(driver, runtime, options = {}) {
  const profileName = runtime.smokeContext.smokeProfileName;
  const step = options.step ?? "packaged-saved-proxy-proof";
  const previousRequest = await readMetricValue(driver, `${profileName} proxy-check observability`, "Request");
  const clickAttempts = [];
  let kickoffState = null;

  for (const attempt of [1, 2]) {
    const runButton = await waitForProfileButton(driver, profileName, "Run saved proxy proof", runtime, { step });
    const clickMode = await clickRunSavedProxyProofButton(driver, runtime, runButton, attempt, step);
    kickoffState = await waitForSavedProxyProofKickoff(driver, runtime, previousRequest, { step });
    clickAttempts.push({ attempt, clickMode, kickoffState });
    if (kickoffState?.runningObserved || kickoffState?.hasResult || kickoffState?.newRequestObserved) {
      break;
    }
  }

  if (!kickoffState?.runningObserved && !kickoffState?.hasResult && !kickoffState?.newRequestObserved) {
    await failUi(driver, runtime, "Run saved proxy proof button did not start a visible proof request.", {
      code: "S06_SAVED_PROXY_PROOF_NOT_STARTED",
      step,
      previousRequest,
      clickAttempts,
      proofState: kickoffState,
    });
  }

  const proofUiState = await waitForCurrentSavedProxyProofResult(driver, runtime, { step, previousRequest });
  await waitForVisibleText(driver, "Saved proxy proof finished for request", runtime, { step });
  await assertNoCredentialTextVisible(driver, runtime, step);
  return {
    proxyCheckVersion: 1,
    profileId: "visible-ui-profile",
    request: proofUiState.request ? "fresh-visible-request" : "visible-ui-request",
    staleSocksFailureObserved: proofUiState.staleSocksFailureObserved,
    proxy: {
      proxyVersion: 1,
      mode: "fixedServer",
      protocol: "http",
      credentialState: "configured",
      summary: "visible-redacted",
    },
    routeProof: {
      status: "proved",
      basis: "sidecar-managed-local-fixture",
      scope: "local-fixture",
      protocol: "http",
      credentialState: "configured",
      directFallbackDetected: false,
      observationCounts: { proxy: "visible", target: "visible" },
    },
    ipHiding: {
      status: "proved",
      basis: "route-proof-succeeded",
      scope: "local-fixture",
      publicExitIpClaimed: false,
    },
    webRtc: {
      status: "restricted",
      basis: "profile-identity-policy",
      mode: "masked",
      policy: "disableNonProxiedUdp",
    },
    publicCheckers: {
      status: "advisory-only",
      basis: "fixed-https-allowlist",
      networkDependency: "user-driven-external-pages",
      pages: ["cloudflare-trace", "aws-checkip", "webbrowsertools-webrtc"],
    },
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

export async function assertProxyRuntimeGuardWhileRunning(driver, runtime) {
  const profileName = runtime.smokeContext.smokeProfileName;
  await waitForProfileSectionTexts(driver, profileName, proxyConfigSectionLabel(profileName), [
    "saved proxy edits apply on the next launch",
  ], runtime, { step: "packaged-proxy-runtime-guard" });
  await waitForProfileSectionTexts(driver, profileName, "Saved proxy proof results", [
    "Local fixture proved saved proxy routing.",
  ], runtime, { step: "packaged-proxy-runtime-guard" });
  await assertNoCredentialTextVisible(driver, runtime, "packaged-proxy-runtime-guard");
  return {
    proxyEdits: "disabled-while-running",
    savedProof: "previous-proof-preserved",
    smokeRoot: runtime.smokeContext.smokeRootRelative,
  };
}

function pathInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isSafeRelativeStorePath(value) {
  if (typeof value !== "string" || !value) {
    return false;
  }
  if (isAbsolute(value) || value.startsWith("~") || value.includes(":") || value.includes("\\")) {
    return false;
  }
  const parts = value.split("/");
  return !parts.includes("..") && !parts.includes("") && value.startsWith("profile-store/profiles/");
}

function assertNoUnsafeText(label, value, options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const sensitiveValues = new Set([
    rootDir,
    ...GLOBAL_SENSITIVE_VALUES,
    ...(options.sensitiveValues ?? []),
  ]);
  if (options.smokeContext) {
    sensitiveValues.add(options.smokeContext.smokeRoot);
    sensitiveValues.add(options.smokeContext.dataRoot);
    sensitiveValues.add(options.smokeContext.configRoot);
    sensitiveValues.add(options.smokeContext.cacheRoot);
  }
  if (process.env.THEPRIVATOR_CHROMIUM_PATH) {
    sensitiveValues.add(process.env.THEPRIVATOR_CHROMIUM_PATH);
  }

  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  // Only the pattern stage may look at a masked copy. The absolute-value and
  // fixture-substring scans must see the real bytes: masking them there is how
  // profile notes and tags ended up with no leak coverage at all, when the only
  // thing that needed exempting was the path-shaped pattern rule.
  const patternText =
    options.patternMaskedValue === undefined
      ? text
      : typeof options.patternMaskedValue === "string"
        ? options.patternMaskedValue
        : JSON.stringify(options.patternMaskedValue ?? "");
  for (const sensitive of Array.from(sensitiveValues).filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (text.includes(sensitive)) {
      fail(`${label} leaked an absolute sensitive value.`, {
        code: "S06_REDACTION_ABSOLUTE_VALUE",
        label,
        marker: sensitive === rootDir ? "repo-root" : "sensitive-path",
      }, { rootDir, sensitiveValues: Array.from(sensitiveValues) });
    }
  }
  for (const token of SENSITIVE_VALUE_SENTINELS) {
    if (text.includes(token)) {
      fail(`${label} leaked forbidden smoke fixture text.`, {
        code: "S06_REDACTION_FORBIDDEN_FIXTURE",
        label,
        token,
      }, { rootDir, sensitiveValues: Array.from(sensitiveValues) });
    }
  }
  for (const token of SENSITIVE_FIELD_NAME_MARKERS) {
    if (patternText.includes(token)) {
      fail(`${label} leaked forbidden smoke fixture text.`, {
        code: "S06_REDACTION_FORBIDDEN_FIXTURE",
        label,
        token,
      }, { rootDir, sensitiveValues: Array.from(sensitiveValues) });
    }
  }
  for (const { code, pattern } of UNSAFE_TEXT_PATTERNS) {
    if (pattern.test(patternText)) {
      fail(`${label} leaked unsafe diagnostic/verifier text.`, {
        code,
        label,
      }, { rootDir, sensitiveValues: Array.from(sensitiveValues) });
    }
  }
  return { label, redacted: true };
}

function assertNoForbiddenPublicEvidenceText(label, value, options = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  for (const { code, pattern } of PUBLIC_EVIDENCE_UNSAFE_TEXT_PATTERNS) {
    if (pattern.test(text)) {
      fail(`${label} leaked forbidden public verifier evidence.`, {
        code,
        label,
      }, options);
    }
  }
  return { label, publicEvidenceSafe: true };
}

function collectProfileStoreFiles(dir, options = {}, output = [], state = { entries: 0 }) {
  const maxDepth = options.maxDepth ?? 8;
  const rootDir = options.rootDir ?? ROOT_DIR;
  const depth = options.depth ?? 0;
  if (depth > maxDepth || output.length >= 8) {
    return output;
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return output;
  }

  state.entries += entries.length;
  if (state.entries > MAX_POST_SMOKE_SCAN_ENTRIES) {
    fail("Post-smoke app-data scan exceeded the bounded entry limit.", {
      code: "S06_APP_DATA_SCAN_UNBOUNDED",
      smokeRoot: options.smokeRootRelative,
      maxEntries: MAX_POST_SMOKE_SCAN_ENTRIES,
    }, { rootDir });
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile() && entry.name === "profiles.json" && basename(dirname(fullPath)) === "profile-store") {
      output.push(fullPath);
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    if (["user-data", "Default", "Cache", "Code Cache", "GPUCache"].includes(entry.name)) {
      continue;
    }
    collectProfileStoreFiles(fullPath, {
      ...options,
      depth: depth + 1,
    }, output, state);
  }
  return output;
}

function readProfileStorePayload(path, rootDir) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("profile-store/profiles.json could not be parsed after the packaged smoke.", {
      code: "S06_PROFILE_STORE_MALFORMED",
      artifact: repoRelative(rootDir, path),
      message: error instanceof Error ? error.message : String(error),
    }, { rootDir });
  }
  assert(payload && typeof payload === "object" && !Array.isArray(payload), "profile-store/profiles.json root must be an object.", {
    code: "S06_PROFILE_STORE_SHAPE",
    artifact: repoRelative(rootDir, path),
  }, { rootDir });
  assert(Array.isArray(payload.profiles), "profile-store/profiles.json profiles field must be an array.", {
    code: "S06_PROFILE_STORE_PROFILES_MISSING",
    artifact: repoRelative(rootDir, path),
  }, { rootDir });
  return payload;
}

function findSmokeProfileStore(rootDir, smokeContext) {
  const candidates = collectProfileStoreFiles(smokeContext.smokeRoot, {
    rootDir,
    smokeRootRelative: smokeContext.smokeRootRelative,
  }).sort();
  assert(candidates.length > 0, "Missing profile-store/profiles.json under the isolated S06 smoke root.", {
    code: "S06_PROFILE_STORE_MISSING",
    smokeRoot: smokeContext.smokeRootRelative,
    expected: PROFILE_STORE_RELATIVE_PATH,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });

  let inspectedProfiles = 0;
  for (const path of candidates) {
    const payload = readProfileStorePayload(path, rootDir);
    inspectedProfiles += payload.profiles.length;
    const profile = payload.profiles.find((item) => item?.name === smokeContext.smokeProfileName);
    if (profile) {
      const appDataRoot = dirname(dirname(path));
      assert(pathInside(smokeContext.dataRoot, path), "profile-store/profiles.json was not under the verifier XDG data root.", {
        code: "S06_PROFILE_STORE_OUTSIDE_XDG_DATA",
        smokeRoot: smokeContext.smokeRootRelative,
        profileStore: repoRelative(rootDir, path),
      }, { rootDir, sensitiveValues: [smokeContext.smokeRoot, smokeContext.dataRoot] });
      return { path, appDataRoot, payload, profile };
    }
  }

  fail("profile-store/profiles.json did not contain the generated smoke profile.", {
    code: "S06_PROFILE_STORE_SMOKE_PROFILE_MISSING",
    smokeRoot: smokeContext.smokeRootRelative,
    smokeProfileName: smokeContext.smokeProfileName,
    candidates: candidates.map((path) => repoRelative(rootDir, path)),
    inspectedProfiles,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
}

function collectForbiddenKeys(value, forbiddenKeys, path = "$", output = [], exemptPaths = EMPTY_KEY_PATHS) {
  if (!value || typeof value !== "object") {
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenKeys(item, forbiddenKeys, `${path}[${index}]`, output, exemptPaths));
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (forbiddenKeys.has(key) && !exemptPaths.has(childPath)) {
      output.push(childPath);
    }
    collectForbiddenKeys(child, forbiddenKeys, childPath, output, exemptPaths);
  }
  return output;
}

function smokeIdentitySurfaceModes(identity) {
  return Object.fromEntries(Object.keys(PACKAGED_SMOKE_EXPECTED_SURFACE_MODES).map((surface) => [
    surface,
    identity?.[surface]?.mode,
  ]));
}

function assertPackagedSmokeIdentity(identity, profileStorePath, rootDir, smokeContext) {
  assert(identity && typeof identity === "object" && !Array.isArray(identity), "Smoke profile identity metadata is missing.", {
    code: "S06_PROFILE_IDENTITY_MISSING",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });

  assert(identity.identityVersion === 1, "Smoke profile identity.identityVersion must be v1.", {
    code: "S06_PROFILE_IDENTITY_VERSION",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    expectedIdentityVersion: 1,
    actualIdentityVersion: identity.identityVersion,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });

  assert(identity.presetId === PACKAGED_SMOKE_PRESET_ID && identity.label === PACKAGED_SMOKE_PRESET_LABEL, "Smoke profile did not persist the curated identity preset.", {
    code: "S06_PROFILE_IDENTITY_PRESET",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    expectedPresetId: PACKAGED_SMOKE_PRESET_ID,
    expectedLabel: PACKAGED_SMOKE_PRESET_LABEL,
    actualPresetId: typeof identity.presetId === "string" ? identity.presetId : null,
    actualLabel: typeof identity.label === "string" ? identity.label : null,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });

  const surfaceModes = smokeIdentitySurfaceModes(identity);
  for (const [surface, expectedMode] of Object.entries(PACKAGED_SMOKE_EXPECTED_SURFACE_MODES)) {
    assert(surfaceModes[surface] === expectedMode, "Smoke profile identity surface mode did not match the curated preset.", {
      code: "S06_PROFILE_IDENTITY_SURFACE_MODE",
      profileStore: repoRelative(rootDir, profileStorePath),
      smokeProfileName: smokeContext.smokeProfileName,
      surface,
      expectedMode,
      actualMode: typeof surfaceModes[surface] === "string" ? surfaceModes[surface] : null,
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  }

  return {
    identityVersion: identity.identityVersion,
    presetId: identity.presetId,
    label: identity.label,
    surfaceModes,
  };
}

// organization.notes and organization.tags are text the user typed. Slashes and
// colons are ordinary content there, so they are masked before the path-shaped
// redaction patterns run; assertPackagedSmokeOrganization bounds them instead.
/**
 * Mask the private store for redaction checks.
 *
 * Two different exemptions, deliberately separated:
 *
 * - Proxy credentials are legitimately stored here, so they are masked for every
 *   stage. The private store is where they live; finding them is not a leak.
 * - Organization notes and tags are free user text that may contain slashes and
 *   colons, so only the path-shaped pattern rules may skip them. The
 *   absolute-value and fixture-substring scans must still see the real bytes, or
 *   a credential pasted into a note would go entirely unchecked.
 */
function sanitizePrivateProfileStoreForRedaction(value, { maskOrganizationText = false } = {}, parentKey = null) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePrivateProfileStoreForRedaction(item, { maskOrganizationText }, parentKey));
  }
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "credentials") {
      output[key] = "<private-store-credentials>";
    } else if (maskOrganizationText && parentKey === "organization" && (key === "notes" || key === "tags")) {
      output[key] = "<private-store-organization-text>";
    } else {
      output[key] = sanitizePrivateProfileStoreForRedaction(child, { maskOrganizationText }, key);
    }
  }
  return output;
}

// Mirrors _TAG_RE in theprivator_sidecar/profile_sections.py and PROFILE_TAG_PATTERN
// in src/sidecar/client.ts. Without it a persisted tag could be an absolute path
// or a raw credential and still satisfy this verifier's shape check.
const PROFILE_TAG_PATTERN = /^[\p{L}\p{N}_ -]+$/u;

function isBoundedProfileFreeText(value, maxLength) {
  return typeof value === "string" && Array.from(value).length <= maxLength && !PROFILE_CONTROL_CHARACTER_PATTERN.test(value);
}

function isSafeProfileStartUrl(value) {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > MAX_PROFILE_START_URL_LENGTH) {
    return false;
  }
  if (/\s/.test(value) || PROFILE_CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  return value === "about:blank" || value.startsWith("https://") || value.startsWith("http://");
}

function isSafeProfileLaunchArg(value) {
  return typeof value === "string"
    && value.startsWith("--")
    && value.length <= MAX_PROFILE_LAUNCH_ARG_LENGTH
    && !PROFILE_CONTROL_CHARACTER_PATTERN.test(value);
}

function assertPackagedSmokeOrganization(organization, profileStorePath, rootDir, smokeContext) {
  assert(organization && typeof organization === "object" && !Array.isArray(organization), "Smoke profile organization metadata is missing.", {
    code: "S06_PROFILE_ORGANIZATION_MISSING",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  const tags = organization.tags;
  assert(Array.isArray(tags) && tags.length <= MAX_PROFILE_TAGS && tags.every((tag) => isBoundedProfileFreeText(tag, MAX_PROFILE_TAG_LENGTH) && tag.length > 0 && PROFILE_TAG_PATTERN.test(tag)), "Smoke profile organization.tags left the persisted tag bounds.", {
    code: "S06_PROFILE_ORGANIZATION_TAGS_UNSAFE",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    maxTags: MAX_PROFILE_TAGS,
    maxTagLength: MAX_PROFILE_TAG_LENGTH,
    actualTagCount: Array.isArray(tags) ? tags.length : null,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(isBoundedProfileFreeText(organization.notes, MAX_PROFILE_NOTES_LENGTH), "Smoke profile organization.notes left the persisted notes bounds.", {
    code: "S06_PROFILE_ORGANIZATION_NOTES_UNSAFE",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    maxNotesLength: MAX_PROFILE_NOTES_LENGTH,
    actualNotesLength: typeof organization.notes === "string" ? organization.notes.length : null,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(typeof organization.favorite === "boolean", "Smoke profile organization.favorite must be a boolean.", {
    code: "S06_PROFILE_ORGANIZATION_FAVORITE_UNSAFE",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(organization.color === null || (typeof organization.color === "string" && PROFILE_COLOR_PATTERN.test(organization.color)), "Smoke profile organization.color must be a #rrggbb value or null.", {
    code: "S06_PROFILE_ORGANIZATION_COLOR_UNSAFE",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });

  return {
    tagCount: tags.length,
    notesLength: organization.notes.length,
    favorite: organization.favorite,
    foldered: typeof organization.folderId === "string",
    colored: typeof organization.color === "string",
  };
}

function assertPackagedSmokeLaunch(launch, profileStorePath, rootDir, smokeContext) {
  assert(launch && typeof launch === "object" && !Array.isArray(launch), "Smoke profile launch metadata is missing.", {
    code: "S06_PROFILE_LAUNCH_MISSING",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(PROFILE_STARTUP_BEHAVIORS.has(launch.startupBehavior), "Smoke profile launch.startupBehavior was not a supported startup behavior.", {
    code: "S06_PROFILE_LAUNCH_BEHAVIOR_UNSAFE",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    actualStartupBehavior: typeof launch.startupBehavior === "string" ? launch.startupBehavior : null,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  const startUrls = launch.startUrls;
  assert(Array.isArray(startUrls) && startUrls.length <= MAX_PROFILE_START_URLS && startUrls.every(isSafeProfileStartUrl), "Smoke profile launch.startUrls must stay bounded https/http/about:blank entries.", {
    code: "S06_PROFILE_START_URL_UNSAFE",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    maxStartUrls: MAX_PROFILE_START_URLS,
    actualStartUrlCount: Array.isArray(startUrls) ? startUrls.length : null,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  const args = launch.args;
  assert(Array.isArray(args) && args.length <= MAX_PROFILE_LAUNCH_ARGS && args.every(isSafeProfileLaunchArg), "Smoke profile launch.args must stay bounded '--' switches.", {
    code: "S06_PROFILE_LAUNCH_ARGS_UNSAFE",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    maxArgs: MAX_PROFILE_LAUNCH_ARGS,
    maxArgLength: MAX_PROFILE_LAUNCH_ARG_LENGTH,
    actualArgCount: Array.isArray(args) ? args.length : null,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });

  return {
    startupBehavior: launch.startupBehavior,
    startUrlCount: startUrls.length,
    argCount: args.length,
  };
}

function assertPackagedSmokeLifecycle(lifecycle, profileStorePath, rootDir, smokeContext) {
  assert(lifecycle && typeof lifecycle === "object" && !Array.isArray(lifecycle), "Smoke profile lifecycle metadata is missing.", {
    code: "S06_PROFILE_LIFECYCLE_MISSING",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  // A non-null deletedAt means the record is in the trash, which the packaged
  // smoke must never leave behind: the smoke profile has to stay live.
  assert(lifecycle.deletedAt === null, "Smoke profile was left in the profile-store trash.", {
    code: "S06_PROFILE_LIFECYCLE_TRASHED",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(Number.isInteger(lifecycle.launchCount) && lifecycle.launchCount >= 0, "Smoke profile lifecycle.launchCount must be a non-negative whole number.", {
    code: "S06_PROFILE_LIFECYCLE_LAUNCH_COUNT",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    actualLaunchCount: Number.isInteger(lifecycle.launchCount) ? lifecycle.launchCount : null,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });

  return {
    trashed: false,
    launchCount: lifecycle.launchCount,
  };
}

function assertPackagedSmokeProxy(proxy, profileStorePath, rootDir, smokeContext) {
  assert(proxy && typeof proxy === "object" && !Array.isArray(proxy), "Smoke profile proxy metadata is missing.", {
    code: "S06_PROFILE_PROXY_MISSING",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(proxy.proxyVersion === 1, "Smoke profile proxy.proxyVersion must be v1.", {
    code: "S06_PROFILE_PROXY_VERSION",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    actualProxyVersion: proxy.proxyVersion,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(proxy.mode === "fixedServer", "Smoke profile proxy must persist a fixed-server proxy.", {
    code: "S06_PROFILE_PROXY_MODE",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    actualMode: proxy.mode,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(proxy.protocol === "http", "Smoke profile proxy must persist the verifier HTTP fixture protocol.", {
    code: "S06_PROFILE_PROXY_PROTOCOL",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    actualProtocol: proxy.protocol,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(typeof proxy.host === "string" && proxy.host.length > 0 && Number.isInteger(proxy.port), "Smoke profile proxy endpoint was malformed.", {
    code: "S06_PROFILE_PROXY_ENDPOINT",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    hasHost: typeof proxy.host === "string" && proxy.host.length > 0,
    hasPort: Number.isInteger(proxy.port),
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  const credentialsConfigured = proxy.credentials && typeof proxy.credentials === "object" && !Array.isArray(proxy.credentials);
  const credentialState = proxy.credentialState ?? (credentialsConfigured ? "configured" : "none");
  assert(credentialState === "configured", "Smoke profile proxy must persist configured masked credentials.", {
    code: "S06_PROFILE_PROXY_CREDENTIAL_STATE",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    actualCredentialState: credentialState,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(credentialsConfigured, "Smoke profile proxy credentials must remain private in the packaged store.", {
    code: "S06_PROFILE_PROXY_CREDENTIALS_MISSING",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
    credentialState,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  const summary = typeof proxy.summary === "string" && proxy.summary.length > 0
    ? proxy.summary
    : `${proxy.protocol}://${proxy.host}:${proxy.port}`;
  assert(typeof summary === "string" && summary.length > 0 && !/@/.test(summary), "Smoke profile proxy summary must be public-safe and credential-free.", {
    code: "S06_PROFILE_PROXY_SUMMARY_UNSAFE",
    profileStore: repoRelative(rootDir, profileStorePath),
    smokeProfileName: smokeContext.smokeProfileName,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  for (const token of DEFAULT_SENSITIVE_SUBSTRINGS) {
    assert(!summary.includes(token), "Smoke profile proxy summary must not contain proxy credentials.", {
      code: "S06_PROFILE_PROXY_SUMMARY_CREDENTIAL_LEAK",
      profileStore: repoRelative(rootDir, profileStorePath),
      smokeProfileName: smokeContext.smokeProfileName,
      token,
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  }

  return {
    proxyVersion: proxy.proxyVersion,
    mode: proxy.mode,
    protocol: proxy.protocol,
    credentialState,
    summary,
  };
}

export function assertPostSmokeProfileStore(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const smokeContext = options.smokeContext;
  assert(smokeContext?.smokeRoot && smokeContext?.smokeProfileName, "Smoke context is required for post-smoke profile-store assertions.", {
    code: "S06_SMOKE_CONTEXT_MISSING",
  }, { rootDir });

  const { path, appDataRoot, payload, profile } = findSmokeProfileStore(rootDir, smokeContext);
  assert(payload.storeVersion === 4, "profile-store/profiles.json must persist storeVersion: 4 for packaged proxy smoke.", {
    code: "S06_PROFILE_STORE_VERSION",
    profileStore: repoRelative(rootDir, path),
    smokeProfileName: smokeContext.smokeProfileName,
    expectedStoreVersion: 4,
    actualStoreVersion: payload.storeVersion,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot, appDataRoot] });
  const identity = assertPackagedSmokeIdentity(profile.identity, path, rootDir, smokeContext);
  const proxy = assertPackagedSmokeProxy(profile.proxy, path, rootDir, smokeContext);
  const organization = assertPackagedSmokeOrganization(profile.organization, path, rootDir, smokeContext);
  const launch = assertPackagedSmokeLaunch(profile.launch, path, rootDir, smokeContext);
  const lifecycle = assertPackagedSmokeLifecycle(profile.lifecycle, path, rootDir, smokeContext);
  const storage = profile.storage;
  assert(storage && typeof storage === "object" && !Array.isArray(storage), "Smoke profile storage metadata is missing.", {
    code: "S06_PROFILE_STORAGE_MISSING",
    profileStore: repoRelative(rootDir, path),
    smokeProfileName: smokeContext.smokeProfileName,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(isSafeRelativeStorePath(storage.profileDir), "Smoke profile storage.profileDir must be a safe relative store path.", {
    code: "S06_PROFILE_DIR_UNSAFE",
    profileStore: repoRelative(rootDir, path),
    profileDir: storage.profileDir,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(isSafeRelativeStorePath(storage.userDataDir) && storage.userDataDir === `${storage.profileDir}/user-data`, "Smoke profile storage.userDataDir must be a safe relative user-data path.", {
    code: "S06_USER_DATA_DIR_UNSAFE",
    profileStore: repoRelative(rootDir, path),
    profileDir: storage.profileDir,
    userDataDir: storage.userDataDir,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });

  const runtimeFields = collectForbiddenKeys(profile, FORBIDDEN_PROFILE_RUNTIME_FIELDS, "$", [], FORBIDDEN_PROFILE_RUNTIME_FIELD_EXEMPT_PATHS);
  assert(runtimeFields.length === 0, "profiles.json persisted transient Chromium runtime truth.", {
    code: "S06_PROFILE_RUNTIME_PERSISTED",
    profileStore: repoRelative(rootDir, path),
    smokeProfileName: smokeContext.smokeProfileName,
    runtimeFields,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });

  assertNoUnsafeText("profile-store/profiles.json", sanitizePrivateProfileStoreForRedaction(payload), {
    patternMaskedValue: sanitizePrivateProfileStoreForRedaction(payload, { maskOrganizationText: true }),
    rootDir,
    smokeContext,
    sensitiveValues: [appDataRoot],
  });

  return {
    smokeProfileName: smokeContext.smokeProfileName,
    smokeRoot: smokeContext.smokeRootRelative,
    appDataRoot: repoRelative(rootDir, appDataRoot),
    profileStore: repoRelative(rootDir, path),
    profileId: profile.id,
    profileCount: payload.profiles.length,
    storeVersion: payload.storeVersion,
    identity,
    proxy,
    organization,
    launch,
    lifecycle,
    storage: {
      profileDir: storage.profileDir,
      userDataDir: storage.userDataDir,
    },
    persistedRuntimeFields: 0,
  };
}

function readBoundedText(path) {
  const stats = statSync(path);
  const length = Math.min(stats.size, MAX_DIAGNOSTIC_READ_BYTES);
  if (length === 0) {
    return "";
  }
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, stats.size - length);
    let text = buffer.toString("utf8");
    if (stats.size > MAX_DIAGNOSTIC_READ_BYTES) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function isSafeDiagnosticMethodName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value);
}

function isSafeDiagnosticErrorCode(value) {
  return value === null || value === undefined || (typeof value === "string" && /^[A-Z0-9_]{1,96}$/.test(value));
}

function isSafeDiagnosticDetailRef(value) {
  return value === null || value === undefined || (typeof value === "string" && /^(?:sidecar|bridge|ui)-[A-Za-z0-9_.:-]{1,160}$/.test(value));
}

function parseDiagnosticRecords(path, rootDir, smokeContext, appDataRoot) {
  const text = readBoundedText(path);

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const records = [];
  let malformedRows = 0;
  for (const [index, line] of lines.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedRows += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformedRows += 1;
      continue;
    }
    const forbiddenKeys = collectForbiddenKeys(parsed, FORBIDDEN_DIAGNOSTIC_KEYS);
    assert(forbiddenKeys.length === 0, "Diagnostics log persisted forbidden raw diagnostic fields.", {
      code: "S06_DIAGNOSTICS_FORBIDDEN_FIELD",
      diagnosticsLog: repoRelative(rootDir, path),
      row: index + 1,
      forbiddenKeys,
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot, appDataRoot] });
    assert(parsed.logPath === DIAGNOSTIC_RELATIVE_LOG_PATH, "Diagnostics log row used an unsafe logPath.", {
      code: "S06_DIAGNOSTICS_LOG_PATH_UNSAFE",
      diagnosticsLog: repoRelative(rootDir, path),
      row: index + 1,
      logPath: parsed.logPath,
      expected: DIAGNOSTIC_RELATIVE_LOG_PATH,
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot, appDataRoot] });
    assert(isSafeDiagnosticMethodName(parsed.method), "Diagnostics log row used an unsafe method name.", {
      code: "S06_DIAGNOSTICS_METHOD_UNSAFE",
      diagnosticsLog: repoRelative(rootDir, path),
      row: index + 1,
      method: "<unsafe>",
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot, appDataRoot] });
    assert(DIAGNOSTIC_ALLOWED_SOURCES.has(parsed.source), "Diagnostics log row used an unsafe source.", {
      code: "S06_DIAGNOSTICS_SOURCE_UNSAFE",
      diagnosticsLog: repoRelative(rootDir, path),
      row: index + 1,
      source: parsed.source,
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot, appDataRoot] });
    assert(DIAGNOSTIC_ALLOWED_EVENTS.has(parsed.event), "Diagnostics log row used an unsafe event.", {
      code: "S06_DIAGNOSTICS_EVENT_UNSAFE",
      diagnosticsLog: repoRelative(rootDir, path),
      row: index + 1,
      event: parsed.event,
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot, appDataRoot] });
    assert(DIAGNOSTIC_ALLOWED_STATUSES.has(parsed.status), "Diagnostics log row used an unsafe status.", {
      code: "S06_DIAGNOSTICS_STATUS_UNSAFE",
      diagnosticsLog: repoRelative(rootDir, path),
      row: index + 1,
      status: parsed.status,
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot, appDataRoot] });
    records.push(parsed);
  }
  assertNoUnsafeText("profile-store/diagnostics/events.jsonl", text, {
    rootDir,
    smokeContext,
    sensitiveValues: [appDataRoot],
  });
  return { text, lines, records, malformedRows };
}

function assertDiagnosticRecordSafe(record, method, rootDir, smokeContext, diagnosticsPath) {
  assert(record.schemaVersion === 1, "Diagnostics schemaVersion changed.", {
    code: "S06_DIAGNOSTICS_SCHEMA_DRIFT",
    method,
    diagnosticsLog: repoRelative(rootDir, diagnosticsPath),
    schemaVersion: record.schemaVersion,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(DIAGNOSTIC_ALLOWED_SOURCES.has(record.source), "Diagnostics source changed or became unsafe.", {
    code: "S06_DIAGNOSTICS_SOURCE_UNSAFE",
    method,
    source: record.source,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(DIAGNOSTIC_ALLOWED_EVENTS.has(record.event), "Diagnostics event changed or became unsafe.", {
    code: "S06_DIAGNOSTICS_EVENT_UNSAFE",
    method,
    event: record.event,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(DIAGNOSTIC_ALLOWED_STATUSES.has(record.status), "Diagnostics status changed or became unsafe.", {
    code: "S06_DIAGNOSTICS_STATUS_UNSAFE",
    method,
    status: record.status,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(record.method === method, "Diagnostics method mismatch.", {
    code: "S06_DIAGNOSTICS_METHOD_MISMATCH",
    expectedMethod: method,
    actualMethod: record.method,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(typeof record.durationMs === "number" && Number.isFinite(record.durationMs) && record.durationMs >= 0, "Diagnostics durationMs missing for packaged sidecar request.", {
    code: "S06_DIAGNOSTICS_DURATION_MISSING",
    method,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
  assert(typeof record.ts === "string" && record.ts.endsWith("Z"), "Diagnostics timestamp missing for packaged sidecar request.", {
    code: "S06_DIAGNOSTICS_TS_MISSING",
    method,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
}

function summarizeDiagnosticFailures(records, rootDir, smokeContext, diagnosticsPath) {
  const failures = [];
  for (const [index, record] of records.entries()) {
    if (record.status !== "error") {
      continue;
    }
    assert(isSafeDiagnosticErrorCode(record.errorCode), "Diagnostics error row used an unsafe errorCode.", {
      code: "S06_DIAGNOSTICS_ERROR_CODE_UNSAFE",
      diagnosticsLog: repoRelative(rootDir, diagnosticsPath),
      row: index + 1,
      method: record.method,
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
    assert(isSafeDiagnosticDetailRef(record.detailRef), "Diagnostics error row used an unsafe detailRef.", {
      code: "S06_DIAGNOSTICS_DETAIL_REF_UNSAFE",
      diagnosticsLog: repoRelative(rootDir, diagnosticsPath),
      row: index + 1,
      method: record.method,
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
    assert(typeof record.durationMs === "number" && Number.isFinite(record.durationMs) && record.durationMs >= 0, "Diagnostics error row durationMs was missing or unsafe.", {
      code: "S06_DIAGNOSTICS_ERROR_DURATION_MISSING",
      diagnosticsLog: repoRelative(rootDir, diagnosticsPath),
      row: index + 1,
      method: record.method,
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot] });
    failures.push({
      method: record.method,
      status: record.status,
      errorCode: record.errorCode ?? null,
      detailRef: record.detailRef ?? null,
      logPath: record.logPath,
      durationMs: record.durationMs,
    });
  }
  return failures;
}

export function assertPostSmokeDiagnostics(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const smokeContext = options.smokeContext;
  assert(smokeContext?.smokeRoot && smokeContext?.smokeProfileName, "Smoke context is required for post-smoke diagnostics assertions.", {
    code: "S06_SMOKE_CONTEXT_MISSING",
  }, { rootDir });

  const { appDataRoot } = findSmokeProfileStore(rootDir, smokeContext);
  const diagnosticsPath = join(appDataRoot, DIAGNOSTIC_RELATIVE_LOG_PATH);
  assert(existsSync(diagnosticsPath), "Missing profile-store/diagnostics/events.jsonl under the packaged app-data root.", {
    code: "S06_DIAGNOSTICS_MISSING",
    smokeRoot: smokeContext.smokeRootRelative,
    appDataRoot: repoRelative(rootDir, appDataRoot),
    expected: DIAGNOSTIC_RELATIVE_LOG_PATH,
  }, { rootDir, sensitiveValues: [smokeContext.smokeRoot, appDataRoot] });

  const { records, malformedRows, lines } = parseDiagnosticRecords(diagnosticsPath, rootDir, smokeContext, appDataRoot);
  const required = {};
  for (const method of REQUIRED_DIAGNOSTIC_METHODS) {
    const record = records.find((entry) => entry.event === "sidecar.request" && entry.source === "python-sidecar" && entry.method === method && entry.status === "ok");
    assert(record, "Packaged sidecar diagnostics are missing a required successful request record.", {
      code: "S06_DIAGNOSTICS_METHOD_MISSING",
      diagnosticsLog: repoRelative(rootDir, diagnosticsPath),
      smokeRoot: smokeContext.smokeRootRelative,
      expectedMethod: method,
      observedMethods: Array.from(new Set(records.map((entry) => entry.method).filter(Boolean))).sort(),
      malformedRows,
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot, appDataRoot] });
    assertDiagnosticRecordSafe(record, method, rootDir, smokeContext, diagnosticsPath);
    required[method] = {
      status: record.status,
      source: record.source,
      event: record.event,
      logPath: record.logPath,
      durationMs: record.durationMs,
    };
  }

  const typedFailures = summarizeDiagnosticFailures(records, rootDir, smokeContext, diagnosticsPath);

  return {
    smokeProfileName: smokeContext.smokeProfileName,
    smokeRoot: smokeContext.smokeRootRelative,
    diagnosticsLog: repoRelative(rootDir, diagnosticsPath),
    appDataRoot: repoRelative(rootDir, appDataRoot),
    logPath: DIAGNOSTIC_RELATIVE_LOG_PATH,
    requiredMethods: REQUIRED_DIAGNOSTIC_METHODS,
    required,
    typedFailures,
    totalRowsRead: lines.length,
    validRows: records.length,
    malformedRows,
  };
}

export function assertPostSmokeRedaction(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const smokeContext = options.smokeContext;
  const { appDataRoot, payload } = findSmokeProfileStore(rootDir, smokeContext);
  const diagnosticsPath = join(appDataRoot, DIAGNOSTIC_RELATIVE_LOG_PATH);
  assertNoUnsafeText("profile-store/profiles.json", sanitizePrivateProfileStoreForRedaction(payload), {
    patternMaskedValue: sanitizePrivateProfileStoreForRedaction(payload, { maskOrganizationText: true }),
    rootDir,
    smokeContext,
    sensitiveValues: [appDataRoot],
  });
  if (existsSync(diagnosticsPath)) {
    assertNoUnsafeText("profile-store/diagnostics/events.jsonl", readBoundedText(diagnosticsPath), {
      rootDir,
      smokeContext,
      sensitiveValues: [appDataRoot],
    });
  }
  if (options.evidence) {
    const forbiddenEvidenceKeys = collectForbiddenKeys(options.evidence, FORBIDDEN_FINAL_EVIDENCE_FIELDS);
    assert(forbiddenEvidenceKeys.length === 0, "verify.s06 final evidence included forbidden runtime/debug/generated fields.", {
      code: "S06_REDACTION_FORBIDDEN_FIELD",
      label: "verify.s06 final evidence",
      forbiddenKeys: forbiddenEvidenceKeys,
    }, { rootDir, sensitiveValues: [smokeContext.smokeRoot, appDataRoot] });
    const finalEvidenceOptions = {
      rootDir,
      smokeContext,
      sensitiveValues: [appDataRoot],
    };
    assertNoUnsafeText("verify.s06 final evidence", options.evidence, finalEvidenceOptions);
    assertNoForbiddenPublicEvidenceText("verify.s06 final evidence", options.evidence, finalEvidenceOptions);
  }
  return {
    smokeProfileName: smokeContext.smokeProfileName,
    smokeRoot: smokeContext.smokeRootRelative,
    profileStore: "redacted",
    diagnostics: existsSync(diagnosticsPath) ? "redacted" : "missing",
    verifierEvidence: options.evidence ? "redacted" : "not-checked",
  };
}

function stepByName(checks, name) {
  return checks.find((check) => check.name === name) ?? null;
}

function summarizeProfileStoreForEvidence(profileStore) {
  if (!profileStore || typeof profileStore !== "object") {
    return profileStore;
  }
  return {
    smokeProfileName: profileStore.smokeProfileName,
    smokeRoot: profileStore.smokeRoot,
    profileId: profileStore.profileId,
    profileCount: profileStore.profileCount,
    storeVersion: profileStore.storeVersion,
    persistedRuntimeFields: profileStore.persistedRuntimeFields,
    storage: profileStore.storage ? "safe-relative-store-paths" : undefined,
    proxy: profileStore.proxy,
    organization: profileStore.organization,
    launch: profileStore.launch,
    lifecycle: profileStore.lifecycle,
  };
}

function summarizeDiagnosticsForEvidence(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") {
    return diagnostics;
  }
  return {
    smokeProfileName: diagnostics.smokeProfileName,
    smokeRoot: diagnostics.smokeRoot,
    diagnosticsLog: diagnostics.diagnosticsLog,
    logPath: diagnostics.logPath,
    requiredMethods: diagnostics.requiredMethods,
    required: diagnostics.required,
    typedFailures: diagnostics.typedFailures,
    totalRowsRead: diagnostics.totalRowsRead,
    validRows: diagnostics.validRows,
    malformedRows: diagnostics.malformedRows,
  };
}

function summarizePublicCheckerPages(publicCheckers) {
  if (!publicCheckers || typeof publicCheckers !== "object" || !Array.isArray(publicCheckers.pages)) {
    return publicCheckers;
  }
  return {
    status: publicCheckers.status,
    basis: publicCheckers.basis,
    networkDependency: publicCheckers.networkDependency,
    pages: publicCheckers.pages.map((page) => {
      if (typeof page === "string") {
        return page;
      }
      return {
        id: page?.id,
        label: page?.label,
        surfaces: page?.surfaces,
        advisory: page?.advisory ? "external-advisory" : undefined,
      };
    }),
  };
}

function summarizeObservationCounts(counts) {
  if (!counts || typeof counts !== "object") {
    return undefined;
  }
  return {
    proxy: Number.isFinite(counts.proxy) ? counts.proxy : counts.proxy === "visible" ? "visible" : undefined,
    target: Number.isFinite(counts.target) ? counts.target : counts.target === "visible" ? "visible" : undefined,
  };
}

function summarizeRouteProofForEvidence(routeProof) {
  if (!routeProof || typeof routeProof !== "object") {
    return routeProof;
  }
  return {
    status: routeProof.status,
    basis: routeProof.basis,
    scope: routeProof.scope,
    protocol: routeProof.protocol,
    credentialState: routeProof.credentialState,
    directFallbackDetected: routeProof.directFallbackDetected === true,
    observationCounts: summarizeObservationCounts(routeProof.observationCounts),
  };
}

function summarizeIpHidingForEvidence(ipHiding) {
  if (!ipHiding || typeof ipHiding !== "object") {
    return ipHiding;
  }
  return {
    status: ipHiding.status,
    basis: ipHiding.basis,
    scope: ipHiding.scope,
    publicExitIpClaimed: ipHiding.publicExitIpClaimed === true,
    localFixtureConclusion: ipHiding.localFixtureConclusion ? "local-fixture-proof" : undefined,
  };
}

function summarizeWebRtcForEvidence(webRtc) {
  if (!webRtc || typeof webRtc !== "object") {
    return webRtc;
  }
  return {
    status: webRtc.status,
    basis: webRtc.basis,
    mode: webRtc.mode,
    policy: webRtc.policy,
    localIpExposure: webRtc.localIpExposure,
  };
}

function summarizeProxyForEvidence(proxy) {
  if (!proxy || typeof proxy !== "object") {
    return proxy;
  }
  return {
    proxyVersion: proxy.proxyVersion,
    mode: proxy.mode,
    protocol: proxy.protocol,
    credentialState: proxy.credentialState,
    summary: proxy.summary,
  };
}

function summarizeProxyCheckForEvidence(proxyCheck) {
  if (!proxyCheck || typeof proxyCheck !== "object") {
    return proxyCheck;
  }
  return {
    proxyCheckVersion: proxyCheck.proxyCheckVersion,
    profileId: proxyCheck.profileId,
    requestId: proxyCheck.requestId,
    proxy: summarizeProxyForEvidence(proxyCheck.proxy),
    routeProof: summarizeRouteProofForEvidence(proxyCheck.routeProof),
    ipHiding: summarizeIpHidingForEvidence(proxyCheck.ipHiding),
    webRtc: summarizeWebRtcForEvidence(proxyCheck.webRtc),
    publicCheckers: summarizePublicCheckerPages(proxyCheck.publicCheckers),
  };
}

function summarizeCleanupForEvidence(cleanup) {
  if (!cleanup || typeof cleanup !== "object") {
    return cleanup;
  }
  const ownedChromium = cleanup.ownedChromium && typeof cleanup.ownedChromium === "object"
    ? {
        uiStop: cleanup.ownedChromium.uiStop,
        runtimePidCount: Array.isArray(cleanup.ownedChromium.runtimePids) ? cleanup.ownedChromium.runtimePids.length : undefined,
        runtimePidStatuses: Array.isArray(cleanup.ownedChromium.runtimePids)
          ? cleanup.ownedChromium.runtimePids.map((item) => item?.status).filter(Boolean)
          : undefined,
      }
    : cleanup.ownedChromium;
  const cleanupStatus = cleanup.status ?? (/failed|kill-failed|quit-failed/i.test(JSON.stringify(cleanup)) ? "needs-attention" : "pass");
  return {
    smokeProfileName: cleanup.smokeProfileName,
    smokeRoot: cleanup.smokeRoot,
    retainedSmokeRoot: cleanup.retainedSmokeRoot === true,
    ownedChromium,
    webdriverSession: typeof cleanup.webdriverSession === "object" ? cleanup.webdriverSession?.status : cleanup.webdriverSession,
    driverProcess: typeof cleanup.driverProcess === "object" ? cleanup.driverProcess?.status : cleanup.driverProcess,
    status: cleanupStatus,
  };
}

export function buildFinalSummary({ mode, proof, smoke, checks = STEP_RESULTS, platform = process.platform, arch = process.arch } = {}) {
  const packageInspection = stepByName(checks, "package-sidecar-shape")?.inspections ?? [];
  const identityProof = smoke?.identity ?? (smoke?.profileStore?.identity
    ? {
        ...smoke.profileStore.identity,
        persistence: "profile-store",
      }
    : undefined);
  const proxy = summarizeProxyForEvidence(smoke?.proxy ?? smoke?.profileStore?.proxy);
  const proxyCheck = summarizeProxyCheckForEvidence(smoke?.proxyCheck);
  const routeProof = proxyCheck?.routeProof;
  const ipHiding = proxyCheck?.ipHiding;
  const webRtc = proxyCheck?.webRtc;
  const publicCheckers = proxyCheck?.publicCheckers;
  const cleanup = summarizeCleanupForEvidence(smoke?.cleanup);
  return {
    os: { platform, arch },
    mode,
    artifacts: {
      releaseExecutable: proof?.releaseExecutable,
      releaseSidecar: proof?.releaseSidecar,
      targetTripleSidecar: proof?.targetTripleSidecar,
      packages: proof?.packages ?? [],
    },
    smokeProfileName: smoke?.smokeProfileName,
    retainedSmokeRoot: smoke?.smokeRoot,
    sidecarBundledInvocation: {
      evidence: "packaged-release-executable-via-tauri-webdriver",
      application: proof?.releaseExecutable,
      releaseSidecar: proof?.releaseSidecar,
      targetTripleSidecar: proof?.targetTripleSidecar,
      diagnosticsSource: smoke?.diagnostics?.diagnosticsLog,
      sourceSidecarSubprocess: false,
    },
    identity: identityProof,
    proxy,
    proxyCheck,
    routeProof,
    ipHiding,
    webRtc,
    publicCheckers,
    directFallbackDetected: routeProof?.directFallbackDetected === true,
    observations: smoke?.observations ?? {
      running: stepByName(checks, "packaged-chromium-launch")
        ? { lifecycle: "running", runningCount: stepByName(checks, "packaged-chromium-launch")?.runningCount }
        : undefined,
      stopped: stepByName(checks, "packaged-chromium-stop")
        ? { lifecycle: "stopped", runningCount: stepByName(checks, "packaged-chromium-stop")?.runningCount }
        : undefined,
    },
    restartPersistence: smoke?.restartPersistence ?? smoke?.lifecycle,
    profileStore: summarizeProfileStoreForEvidence(smoke?.profileStore),
    diagnostics: summarizeDiagnosticsForEvidence(smoke?.diagnostics),
    diagnosticsRequiredMethods: smoke?.diagnostics?.requiredMethods,
    redaction: smoke?.redaction,
    cleanup,
    packageInspection,
    supportingRegressions: SUPPORTING_REGRESSION_COMMANDS,
  };
}

function collectRuntimeFiles(dir, output = []) {
  if (!existsSync(dir)) {
    return output;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRuntimeFiles(fullPath, output);
    } else if (entry.isFile() && entry.name === "chromium-processes.json") {
      output.push(fullPath);
    }
  }
  return output;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwnedRuntimePids(smokeContext) {
  const pids = new Set();
  for (const path of collectRuntimeFiles(smokeContext.smokeRoot)) {
    try {
      const payload = JSON.parse(readFileSync(path, "utf8"));
      const records = Array.isArray(payload) ? payload : Object.values(payload ?? {});
      for (const record of records) {
        const pid = record?.pid;
        if (Number.isInteger(pid) && pid > 0) {
          pids.add(pid);
        }
      }
    } catch {
      // Malformed cleanup state is reported by T03; cleanup remains best-effort here.
    }
  }
  return Array.from(pids);
}

async function attemptOwnedChromiumCleanup(driver, runtime) {
  const cleanup = { uiStop: "not-needed", runtimePids: [] };
  try {
    if (driver) {
      const stopButtons = await driver.findElements(By.xpath(`//article[contains(concat(' ', normalize-space(@class), ' '), ' profile-card ')][.//h3[normalize-space()=${xpathLiteral(runtime.smokeContext.smokeProfileName)}]]//button[normalize-space()='Stop Chromium']`));
      for (const button of stopButtons) {
        if ((await button.isDisplayed()) && (await button.isEnabled())) {
          await button.click();
          await waitForMetricValue(driver, "Profile observability", "Running count", "0", runtime, {
            step: "cleanup",
            timeoutMs: 15_000,
          });
          cleanup.uiStop = "pass";
          break;
        }
      }
    }
  } catch (error) {
    cleanup.uiStop = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  for (const pid of readOwnedRuntimePids(runtime.smokeContext)) {
    if (!isPidAlive(pid)) {
      cleanup.runtimePids.push({ pid, status: "not-running" });
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      cleanup.runtimePids.push({ pid, status: "sigterm" });
    } catch (error) {
      cleanup.runtimePids.push({ pid, status: "kill-failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return cleanup;
}

export async function cleanupPackagedSmoke({ driver, driverProcess, runtime, runningObserved }) {
  return runStepAsync("cleanup", async () => {
    const cleanup = {
      smokeProfileName: runtime?.smokeContext?.smokeProfileName,
      smokeRoot: runtime?.smokeContext?.smokeRootRelative,
      retainedSmokeRoot: true,
      ownedChromium: "not-observed",
      webdriverSession: "not-started",
      driverProcess: "not-started",
    };

    if (runningObserved && runtime?.smokeContext) {
      cleanup.ownedChromium = await attemptOwnedChromiumCleanup(driver, runtime);
    }

    if (driver) {
      try {
        cleanup.webdriverSession = await quitDriverSession(driver);
      } catch (error) {
        cleanup.webdriverSession = { status: "quit-failed", message: error instanceof Error ? error.message : String(error) };
      }
    }

    if (driverProcess?.child) {
      cleanup.driverProcess = await stopChildProcess(driverProcess.child);
      cleanup.driverStdoutTail = driverProcess.tail.stdoutTail();
      cleanup.driverStderrTail = driverProcess.tail.stderrTail();
    }

    return cleanup;
  }, runtime ? redactionOptionsForSmoke(runtime.rootDir, runtime.smokeContext) : { rootDir: ROOT_DIR });
}

async function runPackagedUiSmoke(proof, options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const platform = options.platform ?? process.platform;
  const applicationPath = join(rootDir, proof.releaseExecutable);
  const smokeContext = runStep("smoke-root", () => createSmokeRunContext({
    rootDir,
    baseEnv: process.env,
  }), { rootDir });
  const runtime = { rootDir, smokeContext, driverProcess: null };
  let driverProcess = null;
  let driver = null;
  let fixture = null;
  let runningObserved = false;
  let smokeProof = null;

  try {
    fixture = await runStepAsync("proxy-fixture-ready", async () => startProxyFixture({
      kind: "http",
      label: smokeContext.runId,
      targetHost: PACKAGED_SMOKE_PROXY_TARGET_HOST,
      targetPath: PACKAGED_SMOKE_PROXY_TARGET_PATH,
      fixtureCredentials: {
        username: PACKAGED_SMOKE_PROXY_USERNAME,
        password: PACKAGED_SMOKE_PROXY_PASSWORD,
      },
    }, runtime), redactionOptionsForSmoke(rootDir, smokeContext));

    driverProcess = await runStepAsync("webdriver-driver-start", async () => startTauriDriverProcess({
      rootDir,
      smokeContext,
      platform,
      env: process.env,
    }), redactionOptionsForSmoke(rootDir, smokeContext));
    runtime.driverProcess = driverProcess;

    driver = await runStepAsync("webdriver-session-start", async () => createTauriWebDriverSession({
      applicationPath,
      applicationRelativePath: proof.releaseExecutable,
      driverProcess,
      rootDir,
      smokeContext,
    }), redactionOptionsForSmoke(rootDir, smokeContext));

    await runStepAsync("packaged-ui-initial", async () => assertInitialPackagedUi(driver, runtime), redactionOptionsForSmoke(rootDir, smokeContext));
    await runStepAsync("packaged-profile-create", async () => createSmokeProfile(driver, runtime), redactionOptionsForSmoke(rootDir, smokeContext));
    const identityConfig = await runStepAsync("packaged-identity-config", async () => openSmokeIdentityConfig(driver, runtime), redactionOptionsForSmoke(rootDir, smokeContext));
    const identityApply = await runStepAsync("packaged-identity-apply", async () => applySmokeIdentityPreset(driver, runtime), redactionOptionsForSmoke(rootDir, smokeContext));
    const unsupportedSocksAuth = await runStepAsync("packaged-socks-auth-negative-proof", async () => configureUnsupportedSocksProxyAndAssertProofFailure(driver, runtime, fixture), redactionOptionsForSmoke(rootDir, smokeContext));
    const proxyConfig = await runStepAsync("packaged-proxy-configure-save", async () => configureSmokeProxy(driver, runtime, fixture), redactionOptionsForSmoke(rootDir, smokeContext));
    const firstProxyCheck = await runStepAsync("packaged-saved-proxy-proof", async () => runSavedProxyProof(driver, runtime), redactionOptionsForSmoke(rootDir, smokeContext));
    await runStepAsync("packaged-chromium-launch", async () => launchSmokeChromium(driver, runtime), redactionOptionsForSmoke(rootDir, smokeContext));
    runningObserved = true;
    const runtimeGuard = await runStepAsync("packaged-proxy-runtime-guard", async () => assertProxyRuntimeGuardWhileRunning(driver, runtime), redactionOptionsForSmoke(rootDir, smokeContext));
    const firstStop = await runStepAsync("packaged-chromium-stop", async () => stopSmokeChromium(driver, runtime), redactionOptionsForSmoke(rootDir, smokeContext));
    runningObserved = false;

    await runStepAsync("webdriver-session-quit", async () => quitDriverSession(driver), redactionOptionsForSmoke(rootDir, smokeContext));
    driver = null;
    driver = await runStepAsync("webdriver-session-restart", async () => createTauriWebDriverSession({
      applicationPath,
      applicationRelativePath: proof.releaseExecutable,
      driverProcess,
      rootDir,
      smokeContext,
    }), redactionOptionsForSmoke(rootDir, smokeContext));
    const restartProof = await runStepAsync("packaged-restart-persistence", async () => assertRestartPersistence(driver, runtime), redactionOptionsForSmoke(rootDir, smokeContext));
    const restartProxyCheck = await runStepAsync("packaged-saved-proxy-proof-restart", async () => runSavedProxyProof(driver, runtime, { step: "packaged-saved-proxy-proof-restart" }), redactionOptionsForSmoke(rootDir, smokeContext));
    const profileStore = runStep("profile-store-persistence", () => assertPostSmokeProfileStore({ rootDir, smokeContext }), redactionOptionsForSmoke(rootDir, smokeContext));
    const profileStoreEvidence = summarizeProfileStoreForEvidence(profileStore);
    const diagnostics = runStep("diagnostics-correlation", () => assertPostSmokeDiagnostics({ rootDir, smokeContext }), redactionOptionsForSmoke(rootDir, smokeContext));
    const diagnosticsEvidence = summarizeDiagnosticsForEvidence(diagnostics);
    const fixtureCounts = await runStepAsync("proxy-fixture-observations", async () => fixtureObservationCounts(fixture), redactionOptionsForSmoke(rootDir, smokeContext));

    smokeProof = {
      application: proof.releaseExecutable,
      smokeProfileName: smokeContext.smokeProfileName,
      smokeRoot: smokeContext.smokeRootRelative,
      lifecycle: "created-identity-proxy-checked-saved-proof-launched-stopped-restarted",
      legacyImportSurface: "visible",
      retainedSmokeRoot: true,
      identity: {
        ...profileStore.identity,
        persistence: "profile-store",
        configuredVia: "visible-ui",
      },
      proxy: profileStoreEvidence.proxy,
      proxyCheck: {
        ...restartProxyCheck,
        profileId: profileStore.profileId,
        proxy: profileStoreEvidence.proxy,
      },
      observations: {
        identityConfig: {
          presetId: identityConfig.presetId,
          presetCount: identityConfig.presetCount,
          panel: identityConfig.identityPanel,
        },
        identityApply: {
          presetId: identityApply.presetId,
          presetLabel: identityApply.presetLabel,
          successCopy: identityApply.successCopy,
          summary: identityApply.summary,
        },
        proxyConfig,
        unsupportedSocksAuth,
        savedProxyProof: firstProxyCheck,
        running: { lifecycle: "running", runningCount: 1, identity: "configured", proxy: "configured" },
        runtimeGuard,
        stopped: { lifecycle: firstStop.lifecycle, runningCount: firstStop.runningCount },
        restart: {
          profileCard: restartProof.profileCard,
          identitySummary: restartProof.identitySummary.summary,
          proxySummary: restartProof.proxySummary.summary,
          presetId: restartProof.identitySummary.presetId,
        },
        fixture: { observationCounts: fixtureCounts },
      },
      restartPersistence: restartProof.profileCard,
      profileStore: profileStoreEvidence,
      diagnostics: diagnosticsEvidence,
    };
    smokeProof.redaction = runStep("diagnostics-redaction", () => assertPostSmokeRedaction({
      rootDir,
      smokeContext,
      evidence: smokeProof,
    }), redactionOptionsForSmoke(rootDir, smokeContext));
    return smokeProof;
  } finally {
    if (fixture) {
      await runStepAsync("proxy-fixture-cleanup", async () => fixture.stop(), redactionOptionsForSmoke(rootDir, smokeContext));
    }
    const cleanup = await cleanupPackagedSmoke({ driver, driverProcess, runtime, runningObserved });
    if (smokeProof) {
      smokeProof.cleanup = cleanup;
    }
  }
}

function parseArgs(argv) {
  const flags = new Set(argv);
  return {
    buildOnly: flags.has("--build-only"),
    preflightOnly: flags.has("--preflight-only"),
    strictPreflight: flags.has("--strict-preflight"),
    skipBuild: flags.has("--skip-build") || flags.has("--ui-only"),
    uiOnly: flags.has("--ui-only"),
  };
}

function runBuildOnly(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const platform = options.platform ?? process.platform;
  const targetTriple = runStep("target-triple", () => ({ targetTriple: readTargetTriple(rootDir) }), { rootDir }).targetTriple;
  runStep("tauri-config-capability", () => assertTauriGuardrails({ rootDir, platform }), { rootDir });
  runStep("preflight", () => {
    const preflight = assertWebDriverPreflight({ rootDir, platform, env: process.env, strict: options.strictPreflight ?? false });
    return {
      strict: preflight.strict,
      missingPrerequisites: preflight.missing.map((item) => item.name),
      display: preflight.display,
      chromium: preflight.chromium,
    };
  }, { rootDir });

  const buildStartedAt = new Date(Date.now() - FRESHNESS_SKEW_MS);
  runStep("build-freshness-window", () => ({ buildStartedAt: buildStartedAt.toISOString() }), { rootDir });
  runCommand("fresh-build", "npm", ["run", "tauri", "build"], BUILD_TIMEOUT_MS, {
    rootDir,
    label: "npm-run-tauri-build",
  });
  const artifacts = runStep("artifact-shape", () => assertFreshBuildArtifacts({
    rootDir,
    platform,
    targetTriple,
    buildStartedAt,
  }), { rootDir });
  runStep("package-sidecar-shape", () => inspectPackageContents(artifacts.packages, rootDir), { rootDir });
  return { targetTriple, ...artifacts };
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.preflightOnly) {
    runStep("preflight", () => assertWebDriverPreflight({ rootDir: ROOT_DIR, env: process.env, strict: true }), { rootDir: ROOT_DIR });
    emit({ status: "pass", mode: "preflight-only", checks: STEP_RESULTS });
    return;
  }

  if (args.buildOnly) {
    const proof = runBuildOnly({ rootDir: ROOT_DIR, strictPreflight: args.strictPreflight });
    emit({
      status: "pass",
      mode: "build-only",
      proof,
      checks: STEP_RESULTS,
    });
    return;
  }

  let proof;
  if (args.skipBuild) {
    const targetTriple = runStep("target-triple", () => ({ targetTriple: readTargetTriple(ROOT_DIR) }), { rootDir: ROOT_DIR }).targetTriple;
    runStep("tauri-config-capability", () => assertTauriGuardrails({ rootDir: ROOT_DIR, platform: process.platform }), { rootDir: ROOT_DIR });
    runStep("preflight", () => {
      const preflight = assertWebDriverPreflight({ rootDir: ROOT_DIR, platform: process.platform, env: process.env, strict: true });
      return {
        strict: preflight.strict,
        missingPrerequisites: preflight.missing.map((item) => item.name),
        display: preflight.display,
        chromium: preflight.chromium,
      };
    }, { rootDir: ROOT_DIR });
    proof = runStep("artifact-shape", () => assertBuildArtifactsPresent({
      rootDir: ROOT_DIR,
      platform: process.platform,
      targetTriple,
    }), { rootDir: ROOT_DIR });
    runStep("package-sidecar-shape", () => inspectPackageContents(proof.packages, ROOT_DIR), { rootDir: ROOT_DIR });
  } else {
    proof = runBuildOnly({ rootDir: ROOT_DIR, strictPreflight: true });
  }

  const smoke = await runPackagedUiSmoke(proof, { rootDir: ROOT_DIR, platform: process.platform });
  const summary = runStep("summary", () => {
    const finalSummary = buildFinalSummary({
      mode: args.uiOnly || args.skipBuild ? "ui-only" : "full",
      proof,
      smoke,
      checks: STEP_RESULTS,
    });
    assertNoUnsafeText("verify.s06 final summary", finalSummary, { rootDir: ROOT_DIR });
    return finalSummary;
  }, { rootDir: ROOT_DIR });
  emit({
    status: "pass",
    mode: args.uiOnly || args.skipBuild ? "ui-only" : "full",
    proof,
    smoke,
    summary,
    checks: STEP_RESULTS,
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await runCli();
  } catch (error) {
    if (error instanceof VerifyFailure) {
      console.error(error.message);
      if (error.details) {
        console.error(JSON.stringify(redact(error.details), null, 2));
      }
      emit({ status: "fail", checks: STEP_RESULTS });
      process.exitCode = 1;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Unexpected verify:s06 failure.");
      console.error(redact(message));
      emit({ status: "fail", checks: STEP_RESULTS });
      process.exitCode = 1;
    }
  }
}
