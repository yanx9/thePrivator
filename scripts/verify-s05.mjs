import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENV_PYTHON = process.platform === "win32"
  ? join(ROOT_DIR, ".venv", "Scripts", "python.exe")
  : join(ROOT_DIR, ".venv", "bin", "python");
const PYTHON = process.env.PYTHON ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : (process.platform === "win32" ? "python" : "python3"));
const PYTHON_LABEL = "python -m theprivator_sidecar";
const DIAGNOSTIC_RELATIVE_LOG_PATH = "profile-store/diagnostics/events.jsonl";
const PROFILE_STORE_RELATIVE_PATH = "profile-store/profiles.json";
const RUNTIME_RELATIVE_DIR = "profile-store/runtime";
const PRESET_ID = "ubuntu-linux-chrome-120";
const AUDIT_OPEN_PAGE_ID = "browserleaks-webgl";
const SIDECAR_TIMEOUT_MS = 20_000;
const AUDIT_OPEN_TIMEOUT_MS = 60_000;
const STEP_RESULTS = [];
const SENSITIVE_VALUES = new Set([ROOT_DIR]);

const EXPECTED_AUDIT_PAGES = [
  ["browserleaks-client-hints", "https://browserleaks.com/client-hints", ["browser", "clientHints"]],
  ["browserleaks-javascript", "https://browserleaks.com/javascript", ["browser", "navigator", "screen", "locale"]],
  ["browserleaks-canvas", "https://browserleaks.com/canvas", ["canvas"]],
  [AUDIT_OPEN_PAGE_ID, "https://browserleaks.com/webgl", ["webgl"]],
  ["browserleaks-webrtc", "https://browserleaks.com/webrtc", ["webrtc"]],
  ["pixelscan-fingerprint-check", "https://pixelscan.net/fingerprint-check", ["browser", "clientHints", "navigator", "screen", "locale", "canvas", "webgl", "audio", "webrtc"]],
  ["browserscan-browser-checker", "https://www.browserscan.net/browser-checker", ["browser", "clientHints", "navigator", "screen", "locale", "canvas", "webgl", "webrtc"]],
  ["amiunique-fingerprint", "https://amiunique.org/fingerprint", ["browser", "clientHints", "navigator", "screen", "locale", "canvas", "webgl", "audio", "webrtc"]],
  ["cover-your-tracks", "https://coveryourtracks.eff.org/", ["browser", "clientHints", "navigator", "canvas", "webgl", "audio", "webrtc"]],
];
const EXPECTED_PAGE_URL_BY_ID = new Map(EXPECTED_AUDIT_PAGES.map(([id, url]) => [id, url]));
const EXPECTED_SURFACES_BY_ID = new Map(EXPECTED_AUDIT_PAGES.map(([id, _url, surfaces]) => [id, surfaces]));
const EXPECTED_PAGE_IDS = EXPECTED_AUDIT_PAGES.map(([id]) => id);
const EXPECTED_AUDIT_OPEN_URL = EXPECTED_PAGE_URL_BY_ID.get(AUDIT_OPEN_PAGE_ID);

const FORBIDDEN_AUDIT_FIELDS = new Set([
  "pid",
  "process",
  "userDataDir",
  "targetId",
  "targetID",
  "debugPort",
  "webSocketDebuggerUrl",
  "websocketDebuggerUrl",
  "storeRoot",
  "command",
  "args",
  "argv",
  "extensionDir",
  "configPath",
  "configBody",
  "devToolsActivePort",
  "DevToolsActivePort",
]);
const FORBIDDEN_DIAGNOSTIC_KEYS = new Set([
  "params",
  "storeRoot",
  "legacyRoot",
  "items",
  "targetName",
  "folderName",
  "legacyName",
  "message",
  "stack",
  "traceback",
  "command",
  "env",
  "stdout",
  "stderr",
]);
const FORBIDDEN_TEXT_PATTERNS = [
  /DevToolsActivePort/i,
  /ws:\/\//i,
  /wss:\/\//i,
  /--remote-debugging-port/i,
  /--user-data-dir/i,
  /webSocketDebuggerUrl/i,
  /debugPort/i,
  /targetId/i,
  /raw argv/i,
  /Traceback/i,
  /proxy[_-]?(user|pass)/i,
];
const FORBIDDEN_GUARANTEE_PATTERNS = [
  /guaranteed\s+(?:undetectability|undetectable|green|pass|success|score)/i,
  /\bundetectable\b/i,
  /universal\s+(?:green|pass|success)/i,
  /always\s+(?:green|pass|succeed|hide)/i,
  /cannot\s+be\s+fingerprinted/i,
  /can't\s+be\s+fingerprinted/i,
];
const CHROMIUM_EXECUTABLE_NAMES = [
  "chromium-browser",
  "chromium",
  "google-chrome",
  "google-chrome-stable",
  "chrome",
];

class VerifyFailure extends Error {
  constructor(message, details) {
    super(message);
    this.name = "VerifyFailure";
    this.details = details;
  }
}

function emit(event) {
  console.log(JSON.stringify({ event: "verify.s05", ...event }));
}

function rememberSensitive(value) {
  if (typeof value === "string" && value.trim()) {
    SENSITIVE_VALUES.add(value);
  }
}

function redact(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    let redacted = value;
    for (const sensitive of Array.from(SENSITIVE_VALUES).filter(Boolean).sort((a, b) => b.length - a.length)) {
      const replacement = resolve(sensitive) === resolve(ROOT_DIR) ? "<repo>" : "<redacted>";
      redacted = redacted.split(sensitive).join(replacement);
    }
    return redacted
      .replace(/ws:\/\/[^\s"']+/gi, "ws://<redacted>")
      .replace(/wss:\/\/[^\s"']+/gi, "wss://<redacted>")
      .replace(/--remote-debugging-port(?:=|\s+)\d+/gi, "--remote-debugging-port=<redacted>")
      .replace(/--user-data-dir(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)/gi, "--user-data-dir=<redacted>")
      .replace(/THEPRIVATOR_CHROMIUM_PATH(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)/gi, "THEPRIVATOR_CHROMIUM_PATH=<redacted>")
      .replace(/webSocketDebuggerUrl["':\s=]+[^\s,"'}]+/gi, "webSocketDebuggerUrl=<redacted>")
      .replace(/debugPort["':\s=]+\d+/gi, "debugPort=<redacted>")
      .replace(/targetId["':\s=]+[^\s,"'}]+/gi, "targetId=<redacted>");
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  }

  return value;
}

function normalizeOutput(value) {
  if (!value) {
    return "";
  }
  return redact(value)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-20)
    .join("\n");
}

function fail(message, details) {
  throw new VerifyFailure(message, redact(details));
}

function assert(condition, message, details) {
  if (!condition) {
    fail(message, details);
  }
}

function runStep(name, action) {
  const started = performance.now();
  try {
    const result = action() ?? {};
    const durationMs = Math.round(performance.now() - started);
    const { value, log, ...rest } = result;
    const logResult = log ?? rest;
    const returnResult = value ?? result;
    const record = { name, ...redact(logResult), status: "pass", durationMs };
    STEP_RESULTS.push(record);
    emit({ step: name, ...redact(logResult), status: "pass", durationMs });
    return returnResult;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    STEP_RESULTS.push({ name, status: "fail", durationMs, message });
    emit({ step: name, status: "fail", durationMs, message });
    if (error?.details) {
      emit({ step: name, status: "fail-details", details: redact(error.details) });
    }
    throw error;
  }
}

function commandBasename(value) {
  return value.includes("python") ? "python" : basename(value);
}

function runPreflightCommand(command, args, timeoutMs) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    fail(`${commandBasename(command)} preflight failed.`, {
      executable: commandBasename(command),
      error: result.error.message,
      outputTail: normalizeOutput(result.stdout),
      errorTail: normalizeOutput(result.stderr),
    });
  }
  if (result.status !== 0) {
    fail(`${commandBasename(command)} preflight exited with status ${result.status ?? "unknown"}.`, {
      executable: commandBasename(command),
      exitCode: result.status,
      outputTail: normalizeOutput(result.stdout),
      errorTail: normalizeOutput(result.stderr),
    });
  }
  return result.stdout.trim() || result.stderr.trim();
}

function isExecutableFile(path) {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function discoverChromiumExecutable() {
  const configured = process.env.THEPRIVATOR_CHROMIUM_PATH?.trim();
  if (configured && isExecutableFile(configured)) {
    rememberSensitive(configured);
    return { path: configured, source: "THEPRIVATOR_CHROMIUM_PATH" };
  }
  if (configured) {
    rememberSensitive(configured);
  }

  const delimiter = process.platform === "win32" ? ";" : ":";
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const entry of pathEntries) {
    for (const name of CHROMIUM_EXECUTABLE_NAMES) {
      for (const extension of extensions) {
        const candidate = join(entry, `${name}${extension}`);
        if (isExecutableFile(candidate)) {
          rememberSensitive(candidate);
          return { path: candidate, source: "PATH", name };
        }
      }
    }
  }

  fail("Chromium executable was not found for audit-open proof.", {
    code: "CHROMIUM_EXECUTABLE_NOT_FOUND",
    searchedNames: CHROMIUM_EXECUTABLE_NAMES,
  });
}

function parseNdjson(streamName, value, expectedCount = undefined) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (expectedCount !== undefined && lines.length !== expectedCount) {
    fail(`${streamName} emitted ${lines.length} NDJSON line(s), expected ${expectedCount}.`, {
      streamName,
      lineCount: lines.length,
      tail: normalizeOutput(value),
    });
  }

  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${streamName} line ${index + 1} is not valid JSON.`, {
        streamName,
        lineNumber: index + 1,
        error: error instanceof Error ? error.message : String(error),
        lineTail: normalizeOutput(line),
      });
    }
  });
}

function callSidecar(request, options = {}) {
  const timeoutMs = options.timeoutMs ?? SIDECAR_TIMEOUT_MS;
  const result = spawnSync(PYTHON, ["-m", "theprivator_sidecar"], {
    cwd: ROOT_DIR,
    input: `${JSON.stringify(request)}\n`,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      fail(`${PYTHON_LABEL} timed out for ${request.method}.`, {
        method: request.method,
        timeoutMs,
        outputTail: normalizeOutput(result.stdout),
        errorTail: normalizeOutput(result.stderr),
      });
    }
    fail(`${PYTHON_LABEL} failed for ${request.method}.`, {
      method: request.method,
      error: result.error.message,
      outputTail: normalizeOutput(result.stdout),
      errorTail: normalizeOutput(result.stderr),
    });
  }

  if (result.status !== 0) {
    fail(`${PYTHON_LABEL} exited with status ${result.status ?? "unknown"} for ${request.method}.`, {
      method: request.method,
      exitCode: result.status,
      outputTail: normalizeOutput(result.stdout),
      errorTail: normalizeOutput(result.stderr),
    });
  }

  const [response] = parseNdjson("sidecar stdout", result.stdout, 1);
  const diagnostics = parseNdjson("sidecar stderr", result.stderr);
  assert(diagnostics.length >= 1, "Sidecar did not emit a diagnostic event.", { method: request.method });
  assertNoForbiddenText(JSON.stringify(response), `stdout response for ${request.method}`);
  assertNoForbiddenText(JSON.stringify(diagnostics), `stderr diagnostics for ${request.method}`);
  return { response, diagnostics };
}

function assertSuccess(response, requestId, method) {
  assert(response.id === requestId, "Sidecar success id mismatch.", { method, responseId: response.id });
  assert(response.ok === true, `Expected ${method} to succeed.`, { method, response: summarizeEnvelope(response) });
  assert(response.protocolVersion === "1.0.0", "Sidecar protocol version changed.", { method, protocolVersion: response.protocolVersion });
  assert(typeof response.durationMs === "number" && response.durationMs >= 0, "Sidecar duration missing.", { method });
  return response.result;
}

function assertError(response, requestId, code, method) {
  assert(response.id === requestId, "Sidecar error id mismatch.", { method, responseId: response.id });
  assert(response.ok === false, `Expected ${method} to fail.`, { method, response: summarizeEnvelope(response) });
  assert(response.protocolVersion === "1.0.0", "Sidecar protocol version changed.", { method, protocolVersion: response.protocolVersion });
  assert(response.error?.code === code, `Expected ${method} error code ${code}.`, { method, error: response.error });
  assert(response.error?.recoverable === true, `Expected ${method} error to be recoverable.`, { method, error: response.error });
  assert(typeof response.error?.detailRef === "string" && response.error.detailRef.startsWith("sidecar-"), "Expected sidecar detailRef.", {
    method,
    error: response.error,
  });
  assertNoForbiddenText(JSON.stringify(response.error), `${method} error payload`);
  return response.error;
}

function summarizeEnvelope(response) {
  if (!response || typeof response !== "object") {
    return response;
  }
  if (response.ok === false) {
    return { id: response.id, ok: response.ok, error: response.error };
  }
  return { id: response.id, ok: response.ok, protocolVersion: response.protocolVersion, durationMs: response.durationMs };
}

function diagnosticsLogPath(storeRoot) {
  return join(storeRoot, DIAGNOSTIC_RELATIVE_LOG_PATH);
}

function profileStorePath(storeRoot) {
  return join(storeRoot, PROFILE_STORE_RELATIVE_PATH);
}

function runtimeDirPath(storeRoot) {
  return join(storeRoot, RUNTIME_RELATIVE_DIR);
}

function readDiagnosticRecords(storeRoot) {
  const path = diagnosticsLogPath(storeRoot);
  assert(existsSync(path), "Missing diagnostics log file.", relative(ROOT_DIR, path));
  return parseNdjson("diagnostics log", readFileSync(path, "utf8"));
}

function lookupDiagnosticRecords(storeRoot, detailRef) {
  return readDiagnosticRecords(storeRoot).filter((entry) => entry.detailRef === detailRef);
}

function findDiagnosticRecord(storeRoot, detailRef, expectations) {
  const records = lookupDiagnosticRecords(storeRoot, detailRef);
  const record = records.find((entry) => !expectations.event || entry.event === expectations.event);
  assert(record, "No persisted diagnostic record matched detailRef.", {
    detailRef,
    expectedEvent: expectations.event,
    recordCount: records.length,
  });
  assertDiagnosticRecordSafe(record, expectations);
  return record;
}

function assertDiagnosticRecordSafe(record, expectations = {}) {
  assert(record.schemaVersion === 1, "Diagnostic schema version changed.", record);
  assert(record.logPath === DIAGNOSTIC_RELATIVE_LOG_PATH, "Diagnostic log path must stay relative and fixed.", record);
  assert(record.source === (expectations.source ?? "python-sidecar"), "Diagnostic source mismatch.", record);
  if (expectations.event !== undefined) {
    assert(record.event === expectations.event, "Diagnostic event mismatch.", record);
  }
  if (expectations.status !== undefined) {
    assert(record.status === expectations.status, "Diagnostic status mismatch.", record);
  }
  if (expectations.errorCode !== undefined) {
    assert(record.errorCode === expectations.errorCode, "Diagnostic error code mismatch.", record);
  }
  if (expectations.method !== undefined) {
    assert(record.method === expectations.method, "Diagnostic method mismatch.", record);
  }
  assert(typeof record.durationMs === "number" && record.durationMs >= 0, "Diagnostic duration missing.", record);
  assert(typeof record.ts === "string" && record.ts.endsWith("Z"), "Diagnostic timestamp missing.", record);
  assertNoForbiddenKeys(record, FORBIDDEN_DIAGNOSTIC_KEYS, "diagnostic record");
  assertNoForbiddenText(JSON.stringify(record), "diagnostic record");
  if (record.context !== undefined) {
    assert(Object.keys(record.context).join(",") === "legacyId", "Diagnostic context must only contain legacyId.", record);
  }
}

function assertNoForbiddenKeys(value, forbiddenKeys, context) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, forbiddenKeys, `${context}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assert(!forbiddenKeys.has(key), `${context} exposed forbidden key ${key}.`, { key, context });
    assertNoForbiddenKeys(item, forbiddenKeys, `${context}.${key}`);
  }
}

function assertNoForbiddenText(text, context) {
  const redactedText = redact(String(text));
  for (const sensitive of SENSITIVE_VALUES) {
    if (sensitive) {
      assert(!redactedText.includes(sensitive), `${context} leaked a sensitive value.`, { context });
    }
  }
  for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
    assert(!pattern.test(redactedText), `${context} leaked forbidden debug text.`, { context, pattern: String(pattern) });
  }
}

function assertNoGuaranteeLanguage(text, context) {
  for (const pattern of FORBIDDEN_GUARANTEE_PATTERNS) {
    assert(!pattern.test(text), `${context} contains guarantee-style copy.`, { context, pattern: String(pattern) });
  }
}

function assertAuditPlan(plan) {
  assert(plan && typeof plan === "object", "Audit plan must be an object.", typeof plan);
  assert(plan.auditVersion === 1, "Audit plan version changed.", { auditVersion: plan.auditVersion });
  assert(plan.copy && typeof plan.copy === "object", "Audit plan copy missing.", plan);
  assert(Array.isArray(plan.pages), "Audit plan pages missing.", plan);
  assert(plan.pages.length === EXPECTED_AUDIT_PAGES.length, "Audit plan page count changed.", { count: plan.pages.length });
  assertNoForbiddenKeys(plan, FORBIDDEN_AUDIT_FIELDS, "audit plan");
  assertNoForbiddenText(JSON.stringify(plan), "audit plan");

  const ids = plan.pages.map((page) => page.id);
  assert(JSON.stringify(ids) === JSON.stringify(EXPECTED_PAGE_IDS), "Audit plan page ids changed.", { ids });
  for (const page of plan.pages) {
    assertAuditPage(page, { requireRows: true });
  }
}

function assertAuditPage(page, options = {}) {
  assert(page && typeof page === "object", "Audit page must be an object.", page);
  const expectedUrl = EXPECTED_PAGE_URL_BY_ID.get(page.id);
  assert(expectedUrl, "Audit page id is not in the fixed catalog.", { pageId: page.id });
  assert(page.url === expectedUrl, "Audit page URL must match the fixed catalog.", { pageId: page.id, url: page.url });
  assert(new URL(page.url).protocol === "https:", "Audit page URL must be HTTPS.", { pageId: page.id, url: page.url });
  assert(JSON.stringify(page.surfaces) === JSON.stringify(EXPECTED_SURFACES_BY_ID.get(page.id)), "Audit page surfaces changed.", {
    pageId: page.id,
    surfaces: page.surfaces,
  });
  assert(typeof page.label === "string" && page.label.length > 0, "Audit page label missing.", { pageId: page.id });
  assert(typeof page.comparisonNote === "string" && page.comparisonNote.length > 0, "Audit page comparison note missing.", { pageId: page.id });
  assertNoGuaranteeLanguage(page.label, `audit page ${page.id} label`);
  assertNoGuaranteeLanguage(page.comparisonNote, `audit page ${page.id} comparison note`);
  assertNoForbiddenText(JSON.stringify(page), `audit page ${page.id}`);
  assertNoForbiddenKeys(page, FORBIDDEN_AUDIT_FIELDS, `audit page ${page.id}`);
  if (options.requireRows) {
    assert(Array.isArray(page.expectedRows) && page.expectedRows.length > 0, "Audit page expected rows missing.", { pageId: page.id });
    for (const row of page.expectedRows) {
      assert(page.surfaces.includes(row.surface), "Expected row surface must belong to the page.", { pageId: page.id, row });
      assert(typeof row.label === "string" && row.label.length > 0, "Expected row label missing.", { pageId: page.id, row });
      assert(typeof row.expected === "string" && row.expected.length > 0, "Expected row value missing.", { pageId: page.id, row });
      assert(typeof row.guidance === "string" && row.guidance.length > 0, "Expected row guidance missing.", { pageId: page.id, row });
      assertNoGuaranteeLanguage(row.expected, `audit page ${page.id} expected row`);
      assertNoGuaranteeLanguage(row.guidance, `audit page ${page.id} guidance row`);
      assertNoForbiddenText(JSON.stringify(row), `audit page ${page.id} expected row`);
    }
  }
}

function assertAuditOpenPayload(result, profileId, pageId) {
  assert(result && typeof result === "object", "Audit-open result must be an object.", result);
  assertNoForbiddenKeys(result, FORBIDDEN_AUDIT_FIELDS, "audit-open result");
  assertNoForbiddenText(JSON.stringify(result), "audit-open result");
  assert(result.auditVersion === 1, "Audit-open version changed.", result);
  assert(result.profileId === profileId, "Audit-open profileId mismatch.", { profileId: result.profileId });
  assert(result.pageId === pageId, "Audit-open pageId mismatch.", { pageId: result.pageId });
  assert(result.status === "opened", "Audit-open status mismatch.", { status: result.status });
  assert(typeof result.openedAt === "string" && result.openedAt.endsWith("Z"), "Audit-open timestamp missing.", result);
  assert(typeof result.launched === "boolean", "Audit-open launched flag missing.", result);
  assert(Number.isInteger(result.runningCount) && result.runningCount >= 1, "Audit-open running count invalid.", result);
  assertAuditPage(result.page, { requireRows: true });
  assert(result.page.url === EXPECTED_AUDIT_OPEN_URL, "Audit-open did not target the expected catalog URL.", {
    pageId,
    url: result.page.url,
  });
}

function assertGuidanceCopy(plan) {
  const copy = plan.copy;
  const text = JSON.stringify(copy);
  assert(typeof copy.advisory === "string" && copy.advisory.toLowerCase().includes("advisory"), "Audit advisory copy missing.", copy);
  assert(copy.advisory.toLowerCase().includes("does not promise"), "Audit copy must explicitly avoid promises.", copy);
  assert(typeof copy.localProof === "string" && copy.localProof.includes("local proof"), "Audit local proof copy missing.", copy);
  assert(typeof copy.publicCheckerInstability === "string" && copy.publicCheckerInstability.includes("Public checker pages can change"), "Public checker instability copy missing.", copy);
  assertNoGuaranteeLanguage(text, "audit plan copy");
  assertNoForbiddenText(text, "audit plan copy");
}

function assertFrontendAndClientBoundary() {
  const appSource = readFileSync(join(ROOT_DIR, "src", "App.tsx"), "utf8");
  const clientSource = readFileSync(join(ROOT_DIR, "src", "sidecar", "client.ts"), "utf8");
  const guidanceSource = readFileSync(join(ROOT_DIR, "src", "identityAuditGuidance.ts"), "utf8");
  const chromiumSource = readFileSync(join(ROOT_DIR, "theprivator_sidecar", "chromium.py"), "utf8");

  assert(appSource.includes("getIdentityAuditPlan"), "App.tsx must load audit plans through the typed client wrapper.");
  assert(/openIdentityAuditPage\(profile\.id,\s*page\.id\)/.test(appSource), "App.tsx must open audit pages using profileId and pageId only.");
  assert(appSource.includes("lookupDiagnosticDetail"), "App.tsx must render audit diagnostics through the strict sidecar client wrapper.");
  assert(!appSource.includes("@tauri-apps/api/core"), "App.tsx must not import Tauri invoke directly.");
  assert(!/@tauri-apps\/plugin-(dialog|fs|shell)/.test(appSource), "App.tsx must not import filesystem, dialog, or shell bypass plugins.");
  assert(!/showOpenFilePicker|webkitdirectory|readTextFile|writeTextFile|localStorage|sessionStorage|type=["']file["']|window\.open|location\.href/.test(appSource), "App.tsx must not add browser, storage, or filesystem bypasses for audit flow.");

  assert(clientSource.includes('invoke<unknown>("identity_audit_plan", { profileId: safeProfileId })'), "Client must call identity_audit_plan with only the validated profileId.");
  assert(clientSource.includes('invoke<unknown>("identity_audit_open", { profileId: safeProfileId, pageId: safePageId })'), "Client must call identity_audit_open with only profileId/pageId.");
  const openWrapper = clientSource.slice(clientSource.indexOf("export async function openIdentityAuditPage"), clientSource.indexOf("export async function applyProfileIdentityPreset"));
  assert(!/url|href|targetUrl|checkerText|screenshot|dom/i.test(openWrapper), "Client audit-open wrapper must not accept URLs, DOM text, or screenshots.");
  assert(clientSource.includes('"targetId"') && clientSource.includes('"webSocketDebuggerUrl"'), "Client must keep forbidden audit runtime field guards.");
  assert(clientSource.includes('invoke<unknown>("diagnostics_lookup", { detailRef: safeDetailRef })'), "Client must call diagnostics_lookup with only the validated detailRef.");
  assert(!/diagnostics_lookup[\s\S]{0,180}(logPath|storeRoot|legacyRoot|params|stdout|stderr)/.test(clientSource), "Client must not widen diagnostics_lookup inputs or raw diagnostic access.");

  assertNoGuaranteeLanguage(appSource, "App.tsx audit copy");
  assert(guidanceSource.includes("IDENTITY_AUDIT_ADVISORY_COPY"), "identityAuditGuidance.ts must keep explicit advisory audit copy.");
  assert(chromiumSource.includes("target_url=url") && chromiumSource.includes("allowed_public_urls={url}"), "Chromium audit target helper must pass one exact catalog URL allowlist.");
  assert(!/BrowserLeaks|Pixelscan|BrowserScan|AmIUnique|Cover Your Tracks[\s\S]{0,80}(querySelector|innerText|screenshot|page_source)/i.test(chromiumSource), "Sidecar audit open must not scrape public checker content.");
}

function assertProfileStoreNotChanged(storeRoot, beforeText) {
  const afterText = readFileSync(profileStorePath(storeRoot), "utf8");
  assert(afterText === beforeText, "Profile store changed during a no-write audit failure.", {
    beforeBytes: Buffer.byteLength(beforeText),
    afterBytes: Buffer.byteLength(afterText),
  });
}

function assertNoRuntimeWrite(storeRoot) {
  assert(!existsSync(runtimeDirPath(storeRoot)), "Audit failure unexpectedly wrote Chromium runtime state.", {
    runtime: RUNTIME_RELATIVE_DIR,
  });
}

function assertLogRedacted(storeRoot) {
  const path = diagnosticsLogPath(storeRoot);
  assert(existsSync(path), "Missing diagnostics log for redaction scan.", DIAGNOSTIC_RELATIVE_LOG_PATH);
  const text = readFileSync(path, "utf8");
  assertNoForbiddenText(text, "diagnostics log");
  for (const line of parseNdjson("diagnostics log", text)) {
    assertDiagnosticRecordSafe(line, { source: "python-sidecar" });
  }
  return { diagnosticBytes: Buffer.byteLength(text) };
}

function assertProfileJsonSafe(storeRoot) {
  const text = readFileSync(profileStorePath(storeRoot), "utf8");
  assert(!text.includes(ROOT_DIR), "Profile JSON leaked repo root.");
  for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
    assert(!pattern.test(text), "Profile JSON leaked forbidden debug text.", { pattern: String(pattern) });
  }
  return { profileJsonBytes: Buffer.byteLength(text) };
}

function writeLegacyConfig(profileDir, payload) {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "config.json"), JSON.stringify(payload), "utf8");
}

function maybeSymlinkOutsideSecret(source, destination) {
  try {
    symlinkSync(source, destination);
    return true;
  } catch {
    return false;
  }
}

function main() {
  let tempRoot;
  let storeRoot;
  let legacyRoot;
  let chromiumExecutable;
  let profileId;
  let auditProfileWasOpened = false;
  let cleanupCompleted = false;

  try {
    chromiumExecutable = runStep("preflight", () => {
      const pythonVersion = runPreflightCommand(PYTHON, ["--version"], 5_000);
      const chromium = discoverChromiumExecutable();
      return {
        value: chromium.path,
        python: pythonVersion.replace(/\s+/g, " ").split(" ").slice(0, 2).join(" "),
        sidecarMode: "source",
        chromium: "available",
        chromiumSource: chromium.source,
      };
    });

    runStep("frontend-client-boundary-guard", () => {
      assertFrontendAndClientBoundary();
      return { checkedFiles: ["src/App.tsx", "src/sidecar/client.ts", "src/identityAuditGuidance.ts", "theprivator_sidecar/chromium.py"] };
    });

    tempRoot = mkdtempSync(join(tmpdir(), "theprivator-s05-audit-"));
    storeRoot = join(tempRoot, "app-data-root-should-not-leak");
    legacyRoot = join(tempRoot, "legacy-root-should-not-leak");
    rememberSensitive(tempRoot);
    rememberSensitive(storeRoot);
    rememberSensitive(legacyRoot);
    rememberSensitive(chromiumExecutable);

    const profile = runStep("audit-profile-seed", () => {
      const profileName = "S05 Audit Verifier Profile Should Not Leak";
      rememberSensitive(profileName);
      const created = callSidecar({
        id: "s05-profile-create",
        method: "profiles.create",
        params: { storeRoot, name: profileName },
      });
      const createdResult = assertSuccess(created.response, "s05-profile-create", "profiles.create");
      const createdProfile = createdResult.profile;
      assert(typeof createdProfile?.id === "string" && createdProfile.id, "Profile create did not return a profile id.", createdResult);
      const preset = callSidecar({
        id: "s05-profile-preset",
        method: "profiles.identity.applyPreset",
        params: { storeRoot, profileId: createdProfile.id, presetId: PRESET_ID },
      });
      const presetResult = assertSuccess(preset.response, "s05-profile-preset", "profiles.identity.applyPreset");
      assert(presetResult.profile?.identity?.presetId === PRESET_ID, "Profile preset was not applied.", { presetId: presetResult.profile?.identity?.presetId });
      return { value: presetResult.profile, profileSeeded: true, presetId: PRESET_ID };
    });
    profileId = profile.id;

    const auditPlan = runStep("audit-plan-catalog", () => {
      const planned = callSidecar({
        id: "s05-audit-plan",
        method: "identity.audit.plan",
        params: { storeRoot, profileId },
      });
      const result = assertSuccess(planned.response, "s05-audit-plan", "identity.audit.plan");
      assertAuditPlan(result);
      return {
        value: result,
        pageCount: result.pages.length,
        pageIds: result.pages.map((page) => page.id),
      };
    });

    runStep("expected-guidance-no-guarantee-copy", () => {
      assertGuidanceCopy(auditPlan);
      const rowCount = auditPlan.pages.reduce((count, page) => count + page.expectedRows.length, 0);
      assert(rowCount >= EXPECTED_AUDIT_PAGES.length, "Expected guidance rows are missing.", { rowCount });
      return { copyKeys: Object.keys(auditPlan.copy).sort(), expectedRowCount: rowCount };
    });

    runStep("unknown-page-id-diagnostic-lookup-no-write", () => {
      const unknownPageId = "unknown-page-id-should-not-leak";
      rememberSensitive(unknownPageId);
      const beforeProfileStore = readFileSync(profileStorePath(storeRoot), "utf8");
      const opened = callSidecar({
        id: "s05-audit-open-unknown",
        method: "identity.audit.open",
        params: { storeRoot, profileId, pageId: unknownPageId },
      });
      const error = assertError(opened.response, "s05-audit-open-unknown", "IDENTITY_AUDIT_PAGE_NOT_FOUND", "identity.audit.open");
      assertProfileStoreNotChanged(storeRoot, beforeProfileStore);
      assertNoRuntimeWrite(storeRoot);
      const record = findDiagnosticRecord(storeRoot, error.detailRef, {
        source: "python-sidecar",
        event: "sidecar.request",
        status: "error",
        method: "identity.audit.open",
        errorCode: "IDENTITY_AUDIT_PAGE_NOT_FOUND",
      });
      const missingLookup = lookupDiagnosticRecords(storeRoot, "sidecar-not-yet-persisted");
      assert(missingLookup.length === 0, "Diagnostic lookup should return no rows for unknown detailRefs.", { count: missingLookup.length });
      return { method: record.method, pageId: "unknown", code: error.code, detailRef: error.detailRef, noProfileWrite: true, noRuntimeWrite: true };
    });

    runStep("missing-chromium-audit-open-diagnostic", () => {
      const missingChromiumPath = join(tempRoot, "missing-chromium-path-should-not-leak");
      const emptyPath = join(tempRoot, "empty-path");
      mkdirSync(emptyPath, { recursive: true });
      rememberSensitive(missingChromiumPath);
      rememberSensitive(emptyPath);
      const beforeProfileStore = readFileSync(profileStorePath(storeRoot), "utf8");
      const opened = callSidecar(
        {
          id: "s05-audit-open-missing-chromium",
          method: "identity.audit.open",
          params: { storeRoot, profileId, pageId: AUDIT_OPEN_PAGE_ID },
        },
        {
          env: { THEPRIVATOR_CHROMIUM_PATH: missingChromiumPath, PATH: emptyPath },
          timeoutMs: SIDECAR_TIMEOUT_MS,
        },
      );
      const error = assertError(opened.response, "s05-audit-open-missing-chromium", "CHROMIUM_EXECUTABLE_NOT_FOUND", "identity.audit.open");
      assertProfileStoreNotChanged(storeRoot, beforeProfileStore);
      assertNoRuntimeWrite(storeRoot);
      const record = findDiagnosticRecord(storeRoot, error.detailRef, {
        source: "python-sidecar",
        event: "sidecar.request",
        status: "error",
        method: "identity.audit.open",
        errorCode: "CHROMIUM_EXECUTABLE_NOT_FOUND",
      });
      return { method: record.method, pageId: AUDIT_OPEN_PAGE_ID, code: error.code, detailRef: error.detailRef, noRuntimeWrite: true };
    });

    runStep("audit-open-curated-url", () => {
      const opened = callSidecar(
        {
          id: "s05-audit-open-webgl",
          method: "identity.audit.open",
          params: { storeRoot, profileId, pageId: AUDIT_OPEN_PAGE_ID },
        },
        {
          env: { THEPRIVATOR_CHROMIUM_PATH: chromiumExecutable },
          timeoutMs: AUDIT_OPEN_TIMEOUT_MS,
        },
      );
      const result = assertSuccess(opened.response, "s05-audit-open-webgl", "identity.audit.open");
      assertAuditOpenPayload(result, profileId, AUDIT_OPEN_PAGE_ID);
      auditProfileWasOpened = true;
      return {
        value: result,
        method: "identity.audit.open",
        pageId: AUDIT_OPEN_PAGE_ID,
        url: result.page.url,
        launched: result.launched,
        runningCount: result.runningCount,
      };
    });

    runStep("audit-cleanup-status-stop", () => {
      const before = callSidecar({
        id: "s05-chromium-status-before-stop",
        method: "chromium.status",
        params: { storeRoot },
      });
      const beforeResult = assertSuccess(before.response, "s05-chromium-status-before-stop", "chromium.status");
      assert(beforeResult.profiles.some((running) => running.profileId === profileId && running.status === "running"), "Audit-open profile is not running before cleanup.", {
        runningCount: beforeResult.runningCount,
      });
      const stopped = callSidecar({
        id: "s05-chromium-stop-after-audit",
        method: "chromium.stop",
        params: { storeRoot, profileId },
      });
      const stoppedResult = assertSuccess(stopped.response, "s05-chromium-stop-after-audit", "chromium.stop");
      assert(stoppedResult.status === "stopped", "Chromium stop did not return stopped status.", { status: stoppedResult.status });
      const after = callSidecar({
        id: "s05-chromium-status-after-stop",
        method: "chromium.status",
        params: { storeRoot },
      });
      const afterResult = assertSuccess(after.response, "s05-chromium-status-after-stop", "chromium.status");
      assert(!afterResult.profiles.some((running) => running.profileId === profileId), "Audit-open profile still running after cleanup.", {
        runningCount: afterResult.runningCount,
      });
      cleanupCompleted = true;
      return { statusBefore: "running", stopStatus: stoppedResult.status, termination: stoppedResult.termination, runningCountAfter: afterResult.runningCount };
    });

    runStep("legacy-diagnostics-profile-errors", () => {
      const duplicateName = "S05 Audit Verifier Profile Should Not Leak";
      const invalidName = " S05 Invalid Verifier Name ";
      rememberSensitive(duplicateName);
      rememberSensitive(duplicateName.toLowerCase());
      rememberSensitive(invalidName);
      const duplicate = callSidecar({
        id: "s05-profile-duplicate",
        method: "profiles.create",
        params: { storeRoot, name: duplicateName.toLowerCase() },
      });
      const duplicateError = assertError(duplicate.response, "s05-profile-duplicate", "PROFILE_DUPLICATE_NAME", "profiles.create");
      findDiagnosticRecord(storeRoot, duplicateError.detailRef, {
        source: "python-sidecar",
        event: "sidecar.request",
        status: "error",
        method: "profiles.create",
        errorCode: "PROFILE_DUPLICATE_NAME",
      });
      const invalid = callSidecar({
        id: "s05-profile-invalid-name",
        method: "profiles.create",
        params: { storeRoot, name: invalidName },
      });
      const invalidError = assertError(invalid.response, "s05-profile-invalid-name", "PROFILE_INVALID_NAME", "profiles.create");
      findDiagnosticRecord(storeRoot, invalidError.detailRef, {
        source: "python-sidecar",
        event: "sidecar.request",
        status: "error",
        method: "profiles.create",
        errorCode: "PROFILE_INVALID_NAME",
      });
      return { codes: [duplicateError.code, invalidError.code], detailRefs: [duplicateError.detailRef, invalidError.detailRef] };
    });

    runStep("legacy-diagnostics-import-outcomes", () => {
      const duplicateLegacyName = "S05 Audit Verifier Profile Should Not Leak";
      const staleName = "S05 Stale Verifier Name Should Not Leak";
      const proxyUser = "s05-proxy-user-should-not-leak";
      const proxyPass = "s05-proxy-pass-should-not-leak";
      const outsideSecretText = "s05-outside-secret-should-not-leak";
      rememberSensitive(duplicateLegacyName);
      rememberSensitive(staleName);
      rememberSensitive(proxyUser);
      rememberSensitive(proxyPass);
      rememberSensitive(outsideSecretText);

      const legacyProfileDir = join(legacyRoot, "duplicate-profile");
      writeLegacyConfig(legacyProfileDir, {
        name: duplicateLegacyName,
        proxy_user: proxyUser,
        proxy_pass: proxyPass,
        absolute_path: join(tempRoot, "legacy-secret-path-should-not-leak"),
      });
      const sourceUserData = join(legacyProfileDir, "user-data");
      mkdirSync(sourceUserData, { recursive: true });
      const outsideSecret = join(tempRoot, "outside-secret-should-not-leak.txt");
      writeFileSync(outsideSecret, outsideSecretText, "utf8");
      maybeSymlinkOutsideSecret(outsideSecret, join(sourceUserData, "unsafe-link"));

      const scan = callSidecar({
        id: "s05-legacy-scan",
        method: "legacy.scan",
        params: { storeRoot, legacyRoot },
      });
      const scanResult = assertSuccess(scan.response, "s05-legacy-scan", "legacy.scan");
      const candidate = scanResult.candidates[0];
      assert(candidate?.legacyId, "Legacy scan did not return a candidate.", { count: scanResult.count });
      const imported = callSidecar({
        id: "s05-legacy-import",
        method: "legacy.import",
        params: {
          storeRoot,
          legacyRoot,
          items: [
            { legacyId: candidate.legacyId, targetName: duplicateLegacyName },
            { legacyId: "legacy-stale-selection", targetName: staleName },
          ],
        },
      });
      const importResult = assertSuccess(imported.response, "s05-legacy-import", "legacy.import");
      assert(importResult.failedCount >= 1, "Legacy import should produce at least one failed outcome.", {
        failedCount: importResult.failedCount,
        partialCount: importResult.partialCount,
      });
      const detailRefs = importResult.outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.error.detailRef);
      assert(detailRefs.length >= 1, "Legacy import outcomes did not expose diagnostic detailRefs.", { outcomeCount: importResult.outcomes.length });
      for (const detailRef of detailRefs) {
        const record = findDiagnosticRecord(storeRoot, detailRef, {
          source: "python-sidecar",
          event: "legacy.import.outcome",
          method: "legacy.import",
        });
        assert(record.status === "partial" || record.status === "failed", "Legacy outcome status mismatch.", record);
        assert(typeof record.errorCode === "string" && /^(LEGACY_|PROFILE_)/.test(record.errorCode), "Legacy outcome error code mismatch.", record);
      }
      return { failedCount: importResult.failedCount, partialCount: importResult.partialCount, detailRefs };
    });

    runStep("redaction-leak-check", () => {
      const logScan = assertLogRedacted(storeRoot);
      const profileScan = assertProfileJsonSafe(storeRoot);
      assertNoForbiddenText(JSON.stringify(STEP_RESULTS), "verify.s05 emitted step records");
      return { ...logScan, ...profileScan, sensitiveValueCount: SENSITIVE_VALUES.size };
    });

    runStep("summary", () => {
      const passedSteps = STEP_RESULTS.filter((step) => step.status === "pass").length;
      return {
        verdict: "pass",
        passedSteps,
        pageCount: EXPECTED_AUDIT_PAGES.length,
        primaryProof: "guided-public-audit-entrypoints",
      };
    });
  } catch (error) {
    if (error instanceof VerifyFailure) {
      console.error(error.message);
      if (error.details) {
        console.error(JSON.stringify(redact(error.details), null, 2));
      }
      process.exitCode = 1;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    emit({ step: "unexpected-failure", status: "fail", message: redact(message) });
    console.error("Unexpected verify:s05 failure.");
    console.error(redact(message));
    process.exitCode = 1;
  } finally {
    if (auditProfileWasOpened && !cleanupCompleted && storeRoot && profileId) {
      try {
        callSidecar({
          id: "s05-finally-stop-after-failure",
          method: "chromium.stop",
          params: { storeRoot, profileId },
        });
      } catch {
        // Best-effort cleanup after a reported verifier failure. The original safe step remains authoritative.
      }
    }
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

main();
