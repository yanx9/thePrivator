import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VerifyFailure,
  assertFreshBuildArtifacts,
  assertTauriGuardrails,
  assertWebDriverPreflight,
  executableName,
  redact,
  resolveChromiumExecutable,
} from "./verify-s06.mjs";

const tempRoots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "theprivator-verify-s06-test-"));
  tempRoots.push(root);
  return root;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeExecutable(path, mtime) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path, 0o755);
  if (mtime) {
    utimesSync(path, mtime, mtime);
  }
}

function writeArtifact(path, mtime) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "artifact", "utf8");
  if (mtime) {
    utimesSync(path, mtime, mtime);
  }
}

function seedTauriGuardrails(root, capabilityOverrides = {}) {
  writeJson(join(root, "src-tauri", "tauri.conf.json"), {
    build: {
      beforeDevCommand: "npm run sidecar:build && npm run dev",
      beforeBuildCommand: "npm run build && npm run sidecar:build",
    },
    bundle: {
      targets: ["deb", "rpm"],
      externalBin: ["binaries/theprivator-sidecar"],
    },
  });
  writeJson(join(root, "src-tauri", "capabilities", "default.json"), {
    identifier: "default",
    windows: ["main"],
    permissions: [
      "core:default",
      {
        identifier: "shell:allow-spawn",
        allow: [
          {
            name: "binaries/theprivator-sidecar",
            sidecar: true,
          },
        ],
      },
      ...(capabilityOverrides.permissions ?? []),
    ],
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("verify-s06 guard helpers", () => {
  it("rejects stale package artifacts from before the recorded build start", () => {
    const root = makeRoot();
    const beforeBuild = new Date("2026-01-01T00:00:00.000Z");
    const buildStartedAt = new Date("2026-01-02T00:00:00.000Z");
    writeExecutable(join(root, "src-tauri", "target", "release", executableName("theprivator", "linux")), beforeBuild);
    writeExecutable(join(root, "src-tauri", "target", "release", executableName("theprivator-sidecar", "linux")), beforeBuild);
    writeExecutable(join(root, "src-tauri", "binaries", "theprivator-sidecar-x86_64-unknown-linux-gnu"), beforeBuild);
    writeArtifact(join(root, "src-tauri", "target", "release", "bundle", "deb", "ThePrivator_2.1.0_amd64.deb"), beforeBuild);
    writeArtifact(join(root, "src-tauri", "target", "release", "bundle", "rpm", "ThePrivator-2.1.0-1.x86_64.rpm"), beforeBuild);

    expect(() => assertFreshBuildArtifacts({
      rootDir: root,
      buildStartedAt,
      targetTriple: "x86_64-unknown-linux-gnu",
      platform: "linux",
    })).toThrow(VerifyFailure);
    expect(() => assertFreshBuildArtifacts({
      rootDir: root,
      buildStartedAt,
      targetTriple: "x86_64-unknown-linux-gnu",
      platform: "linux",
    })).toThrow(/stale/i);
  });

  it("returns only repo-relative fresh package and sidecar artifact paths", () => {
    const root = makeRoot();
    const buildStartedAt = new Date("2026-01-02T00:00:00.000Z");
    const afterBuild = new Date("2026-01-02T00:00:10.000Z");
    writeExecutable(join(root, "src-tauri", "target", "release", executableName("theprivator", "linux")), afterBuild);
    writeExecutable(join(root, "src-tauri", "target", "release", executableName("theprivator-sidecar", "linux")), afterBuild);
    writeExecutable(join(root, "src-tauri", "binaries", "theprivator-sidecar-x86_64-unknown-linux-gnu"), afterBuild);
    writeArtifact(join(root, "src-tauri", "target", "release", "bundle", "deb", "ThePrivator_2.1.0_amd64.deb"), afterBuild);
    writeArtifact(join(root, "src-tauri", "target", "release", "bundle", "rpm", "ThePrivator-2.1.0-1.x86_64.rpm"), afterBuild);

    const result = assertFreshBuildArtifacts({
      rootDir: root,
      buildStartedAt,
      targetTriple: "x86_64-unknown-linux-gnu",
      platform: "linux",
    });

    expect(result.releaseExecutable).toBe("src-tauri/target/release/theprivator");
    expect(result.releaseSidecar).toBe("src-tauri/target/release/theprivator-sidecar");
    expect(result.targetTripleSidecar).toBe("src-tauri/binaries/theprivator-sidecar-x86_64-unknown-linux-gnu");
    expect(result.packages.sort()).toEqual([
      "src-tauri/target/release/bundle/deb/ThePrivator_2.1.0_amd64.deb",
      "src-tauri/target/release/bundle/rpm/ThePrivator-2.1.0-1.x86_64.rpm",
    ]);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("keeps Tauri bundle and capability authority fixed to the packaged sidecar", () => {
    const root = makeRoot();
    seedTauriGuardrails(root);

    expect(assertTauriGuardrails({ rootDir: root, platform: "linux" })).toMatchObject({
      externalBin: "binaries/theprivator-sidecar",
      targets: ["deb", "rpm"],
      permissions: ["core:default", "shell:allow-spawn"],
    });

    seedTauriGuardrails(root, { permissions: ["fs:default"] });
    expect(() => assertTauriGuardrails({ rootDir: root, platform: "linux" })).toThrow(/widened/i);
  });

  it("fails strict WebDriver preflight with actionable missing-prerequisite instructions", () => {
    const root = makeRoot();
    const emptyBin = join(root, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });

    expect(() => assertWebDriverPreflight({
      rootDir: root,
      platform: "linux",
      env: { PATH: emptyBin },
      strict: true,
    })).toThrow(VerifyFailure);

    try {
      assertWebDriverPreflight({ rootDir: root, platform: "linux", env: { PATH: emptyBin }, strict: true });
      throw new Error("expected preflight to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(VerifyFailure);
      expect(error.details.missing.map((item) => item.name)).toEqual([
        "tauri-driver",
        "WebKitWebDriver",
        "display",
        "Chromium",
      ]);
      expect(JSON.stringify(error.details)).toContain("xvfb-run npm run verify:s06");
      expect(JSON.stringify(error.details)).not.toContain(root);
    }
  });

  it("rejects ambiguous Chromium env paths and resolves executable PATH candidates", () => {
    const root = makeRoot();
    const binDir = join(root, "bin");
    const chromium = join(binDir, "chromium");
    writeExecutable(chromium);

    expect(() => resolveChromiumExecutable({
      rootDir: root,
      env: { THEPRIVATOR_CHROMIUM_PATH: `${chromium}${process.platform === "win32" ? ";" : ":"}${chromium}`, PATH: binDir },
      platform: "linux",
    })).toThrow(/ambiguous/i);

    expect(resolveChromiumExecutable({ rootDir: root, env: { PATH: binDir }, platform: "linux" })).toMatchObject({
      name: "chromium",
      source: "PATH",
    });
  });

  it("redacts absolute roots, env values, Chromium user-data flags, and sensitive output tails", () => {
    const root = makeRoot();
    const appDataRoot = join(root, "app-data-root-should-not-leak");
    const value = redact({
      stderrTail: `launch --user-data-dir=${appDataRoot} THEPRIVATOR_CHROMIUM_PATH=${join(root, "bin", "chromium")} copied-browser-data-should-not-leak`,
      artifact: join(root, "src-tauri", "target", "release", "theprivator"),
    }, { rootDir: root, sensitiveValues: [appDataRoot, "copied-browser-data-should-not-leak"] });

    const text = JSON.stringify(value);
    expect(text).not.toContain(root);
    expect(text).not.toContain(appDataRoot);
    expect(text).not.toContain("copied-browser-data-should-not-leak");
    expect(text).not.toMatch(/--user-data-dir=\S+/);
    expect(text).not.toMatch(/THEPRIVATOR_CHROMIUM_PATH=\S+/);
    expect(text).toContain("<repo>");
  });
});
