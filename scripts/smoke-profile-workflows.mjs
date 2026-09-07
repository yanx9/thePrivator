// Browser + real source sidecar smoke, isolated from all user profiles.
// Run: node scripts/smoke-profile-workflows.mjs
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storeRoot = mkdtempSync(path.join(tmpdir(), "theprivator-workflow-"));
const evidence = path.join(tmpdir(), "theprivator-workflow-evidence");
mkdirSync(evidence, { recursive: true });
let serial = 0;
function request(method, params = {}) {
  const result = spawnSync(path.join(root, ".venv/bin/python"), ["-m", "theprivator_sidecar"], {
    cwd: root, encoding: "utf8", timeout: 20000,
    input: JSON.stringify({ id: `smoke-${++serial}`, method, params: { ...params, storeRoot } }) + "\n",
  });
  assert.equal(result.status, 0, "Source sidecar must exit successfully");
  const response = JSON.parse(result.stdout.trim());
  if (response.error) throw new Error(`${response.error.code}: ${response.error.message}`);
  return { requestId: response.id, protocolVersion: "1.0.0", durationMs: 1, result: response.result };
}
const methods = Object.fromEntries([
  "profiles.list", "profiles.create", "profiles.trash.list", "profiles.duplicate",
  "profiles.organization.update", "profiles.identity.update", "profiles.proxy.update",
  "profiles.launch.update", "profiles.update", "chromium.status", "identity.presets.list",
].map((method) => [method.replaceAll(".", "_"), method]));
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  const seed = request("profiles.create", { name: "QA profile" }).result.profile;
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("sourceSidecar", (command, args) => {
    if (!methods[command]) throw new Error(`Unsupported smoke command: ${command}`);
    return request(methods[command], args);
  });
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: (command, args) => command.startsWith("plugin:event|") ? Promise.resolve(1) : window.sourceSidecar(command, args),
      transformCallback: () => 1, unregisterCallback: () => {},
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  const name = page.getByText("QA profile", { exact: true });
  await name.waitFor();
  await name.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add to favorites" }).click();
  await page.getByRole("img", { name: "Favorite" }).waitFor();
  assert.equal(request("profiles.list").result.profiles[0].organization.favorite, true);
  await name.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit tags…" }).click();
  await page.getByRole("textbox", { name: "Tags (comma separated)" }).fill("Work, EU");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(request("profiles.list").result.profiles[0].organization.tags, ["Work", "EU"]);
  await name.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to folder…" }).click();
  await page.getByRole("textbox", { name: "New folder" }).fill("Work_2026");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("treeitem", { name: "Work_2026, 1 profile" }).waitFor();
  await page.getByRole("textbox", { name: "Notes for QA profile", exact: true }).fill("First line\nSecond line");
  await page.getByRole("button", { name: "Save notes for QA profile", exact: true }).click();
  await page.getByRole("button", { name: "Save notes for QA profile", exact: true }).waitFor({ state: "hidden" });
  assert.equal(request("profiles.list").result.profiles[0].organization.notes, "First line\nSecond line");
  await name.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await page.getByText("QA profile copy", { exact: true }).waitFor();
  assert.equal(request("profiles.list").result.count, 2);
  await page.screenshot({ path: path.join(evidence, "profiles.png") });
  await page.getByRole("link", { name: "Proxies", exact: true }).click();
  await page.getByRole("button", { name: "Save proxy", exact: true }).click();
  await page.getByText("Proxy saved.", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, "proxies.png") });
  await page.getByRole("link", { name: "Templates", exact: true }).click();
  await page.getByRole("textbox", { name: "New profile name" }).fill("QA template result");
  await page.getByRole("button", { name: "Create from configuration" }).click();
  await page.getByText("Configuration copied. Browser data and credentials were not copied.", { exact: true }).waitFor();
  assert.equal(request("profiles.list").result.count, 3);
  await page.screenshot({ path: path.join(evidence, "templates.png") });
  await page.goto(server.resolvedUrls.local[0] + `#/profiles/${seed.id}`);
  await page.getByRole("tab", { name: /fingerprint/i }).click();
  await page.getByLabel("Start from a preset").selectOption("real");
  assert.deepEqual(await page.getByLabel("Start from a preset").locator("option").allTextContents(), ["Custom", "Real"]);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("grid", { name: "Profiles", exact: true }).waitFor();
  const stored = request("profiles.list").result.profiles.find((profile) => profile.id === seed.id);
  assert.equal(stored.identity.label, "Real");
  for (const surface of ["browser", "navigator", "screen", "locale", "canvas", "audio", "webgl", "webrtc", "geolocation", "mediaDevices", "ports"]) assert.equal(stored.identity[surface].mode, "real");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ["favorites", "tags", "named folders", "multiline notes", "duplicate", "proxy save", "template creation", "real preset persistence"], browserErrors: errors, screenshots: evidence }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  rmSync(storeRoot, { recursive: true, force: true });
}
