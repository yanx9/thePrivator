import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargo = read("src-tauri/Cargo.toml").match(/^version = "([^"]+)"/m)?.[1];
const cargoLock = read("src-tauri/Cargo.lock")
  .match(/name = "theprivator"\nversion = "([^"]+)"/)?.[1];

for (const [source, version] of Object.entries({
  npmLock: lock.version,
  npmRoot: lock.packages[""].version,
  tauri: tauri.version,
  cargo,
  cargoLock,
})) {
  assert.equal(version, pkg.version, `${source} must match package.json`);
}
assert.match(read("CHANGELOG.md"), new RegExp(`## \\[${pkg.version.replaceAll(".", "\\.")}\\]`));
const tag = process.argv[2];
if (tag) assert.equal(tag, `v${pkg.version}`, "Release tag must match the application version");
console.log(`Release metadata verified: ${pkg.version}`);
