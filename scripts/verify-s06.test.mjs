import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORBIDDEN_PROFILE_RUNTIME_FIELDS,
  PACKAGED_SMOKE_EXPECTED_SURFACE_MODES,
  PACKAGED_SMOKE_PRESET_ID,
  PACKAGED_SMOKE_PRESET_LABEL,
  PACKAGED_SMOKE_PROFILE_PREFIX,
  REQUIRED_DIAGNOSTIC_METHODS,
  VerifyFailure,
  assertFreshBuildArtifacts,
  assertPostSmokeDiagnostics,
  assertPostSmokeProfileStore,
  assertPostSmokeRedaction,
  assertTauriGuardrails,
  assertWebDriverPreflight,
  buildFinalSummary,
  buildTauriWebDriverCapabilities,
  createSmokeRunContext,
  executableName,
  redact,
  resolveChromiumExecutable,
  resolveTauriDriverExecutable,
  safeVisibleTextSnippet,
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

function defaultIdentity() {
  return {
    identityVersion: 1,
    label: "Real identity",
    presetId: null,
    browser: { mode: "real" },
    navigator: { mode: "real" },
    screen: { mode: "real" },
    locale: { mode: "real" },
    canvas: { mode: "real" },
    audio: { mode: "real" },
    webgl: { mode: "real" },
    webrtc: { mode: "real", policy: "real" },
  };
}

function packagedSmokeIdentity(overrides = {}) {
  return {
    identityVersion: 1,
    label: PACKAGED_SMOKE_PRESET_LABEL,
    presetId: PACKAGED_SMOKE_PRESET_ID,
    browser: { mode: PACKAGED_SMOKE_EXPECTED_SURFACE_MODES.browser },
    navigator: { mode: PACKAGED_SMOKE_EXPECTED_SURFACE_MODES.navigator },
    screen: { mode: PACKAGED_SMOKE_EXPECTED_SURFACE_MODES.screen },
    locale: { mode: PACKAGED_SMOKE_EXPECTED_SURFACE_MODES.locale },
    canvas: { mode: PACKAGED_SMOKE_EXPECTED_SURFACE_MODES.canvas },
    audio: { mode: PACKAGED_SMOKE_EXPECTED_SURFACE_MODES.audio },
    webgl: { mode: PACKAGED_SMOKE_EXPECTED_SURFACE_MODES.webgl },
    webrtc: { mode: PACKAGED_SMOKE_EXPECTED_SURFACE_MODES.webrtc, policy: "disableNonProxiedUdp" },
    ...overrides,
  };
}

function packagedSmokeProxy(overrides = {}) {
  return {
    proxyVersion: 1,
    mode: "fixedServer",
    protocol: "http",
    host: "proxy.example",
    port: 8080,
    credentialState: "configured",
    summary: "http://proxy.example:8080",
    credentials: {
      username: "proxy-user-should-not-leak",
      password: "proxy-pass-should-not-leak",
    },
    ...overrides,
  };
}

function packagedSmokeProxyProof(overrides = {}) {
  return {
    proxyCheckVersion: 1,
    profileId: "33333333-3333-4333-8333-333333333333",
    requestId: "bridge-proxy-check-1",
    routeProof: {
      status: "proved",
      basis: "sidecar-managed-local-fixture",
      scope: "local-fixture",
      protocol: "http",
      credentialState: "configured",
      durationMs: 123.4,
      fixture: { kind: "http", managed: true },
      target: { host: "198.51.100.20", port: 443 },
      observationCounts: { proxy: 2, target: 1 },
      directFallbackDetected: false,
    },
    ipHiding: {
      status: "proved",
      basis: "route-proof-succeeded",
      scope: "local-fixture",
      publicExitIpClaimed: false,
      publicExitIp: null,
      localFixtureConclusion: "direct target IP hidden from the proof target by the managed fixture",
    },
    webRtc: {
      status: "restricted",
      basis: "profile-identity-policy",
      mode: "masked",
      policy: "disableNonProxiedUdp",
      localIpExposure: "non-proxied-udp-disabled",
    },
    publicCheckers: {
      status: "advisory-only",
      basis: "fixed-https-allowlist",
      networkDependency: "user-driven-external-pages",
      pages: ["cloudflare-trace", "aws-checkip", "webbrowsertools-webrtc"],
    },
    ...overrides,
  };
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
  it("exports the packaged identity and proxy evidence contract constants", () => {
    expect(PACKAGED_SMOKE_PROFILE_PREFIX).toBe("M003 Packaged Proxy Smoke");
    expect(PACKAGED_SMOKE_PRESET_ID).toBe("ubuntu-linux-chrome-120");
    expect(PACKAGED_SMOKE_PRESET_LABEL).toBe("Ubuntu Linux Chrome 120");
    expect(PACKAGED_SMOKE_EXPECTED_SURFACE_MODES).toEqual({
      browser: "masked",
      navigator: "masked",
      screen: "masked",
      locale: "masked",
      canvas: "noise",
      audio: "noise",
      webgl: "masked",
      webrtc: "masked",
    });
    expect(REQUIRED_DIAGNOSTIC_METHODS).toEqual([
      "profiles.create",
      "profiles.identity.applyPreset",
      "profiles.proxy.update",
      "profiles.proxy.check",
      "chromium.launch",
      "chromium.stop",
    ]);
    expect(REQUIRED_DIAGNOSTIC_METHODS).not.toContain("identity.audit.plan");
    expect(REQUIRED_DIAGNOSTIC_METHODS).not.toContain("identity.audit.open");
    expect(REQUIRED_DIAGNOSTIC_METHODS).not.toContain("proxy.validate");
    expect(Array.from(FORBIDDEN_PROFILE_RUNTIME_FIELDS)).toEqual(expect.arrayContaining([
      "debugPort",
      "remoteDebuggingPort",
      "webSocketDebuggerUrl",
      "targetId",
      "argv",
      "extensionPath",
      "generatedConfigPath",
      "identityRuntimeRegistry",
      "proxyRuntimeRegistry",
      "proxyAuthExtensionPath",
      "proxyAuthorization",
    ]));
    expect(Array.from(FORBIDDEN_PROFILE_RUNTIME_FIELDS)).not.toContain("credentials");
  });

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
      cargoBin: emptyBin,
      strict: true,
    })).toThrow(VerifyFailure);

    try {
      assertWebDriverPreflight({ rootDir: root, platform: "linux", env: { PATH: emptyBin }, cargoBin: emptyBin, strict: true });
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

  it("redacts absolute roots, public URLs, env values, Chromium user-data flags, and sensitive output tails", () => {
    const root = makeRoot();
    const appDataRoot = join(root, "app-data-root-should-not-leak");
    const value = redact({
      stderrTail: `launch --user-data-dir=${appDataRoot} THEPRIVATOR_CHROMIUM_PATH=${join(root, "bin", "chromium")} copied-browser-data-should-not-leak https://browserleaks.com/webgl`,
      artifact: join(root, "src-tauri", "target", "release", "theprivator"),
    }, { rootDir: root, sensitiveValues: [appDataRoot, "copied-browser-data-should-not-leak"] });

    const text = JSON.stringify(value);
    expect(text).not.toContain(root);
    expect(text).not.toContain(appDataRoot);
    expect(text).not.toContain("copied-browser-data-should-not-leak");
    expect(text).not.toMatch(/--user-data-dir=\S+/);
    expect(text).not.toMatch(/THEPRIVATOR_CHROMIUM_PATH=\S+/);
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).toContain("<repo>");
    expect(text).toContain("<url redacted>");
  });

  it("creates a retained isolated S06 smoke root with a unique visible profile name and XDG app environment", () => {
    const root = makeRoot();
    const context = createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-09T10:11:12.000Z"),
      nonce: "abc123",
      baseEnv: { PATH: "/usr/bin" },
    });

    expect(context.runId).toBe("20260509T101112000Z-abc123");
    expect(context.smokeProfileName).toBe(`${PACKAGED_SMOKE_PROFILE_PREFIX} 20260509T101112000Z-abc123`);
    expect(context.smokeRootRelative).toBe("src-tauri/target/s06-smoke-data/20260509T101112000Z-abc123");
    expect(existsSync(context.smokeRoot)).toBe(true);
    expect(context.driverEnv).toMatchObject({
      PATH: "/usr/bin",
      XDG_DATA_HOME: join(context.smokeRoot, "data"),
      XDG_CONFIG_HOME: join(context.smokeRoot, "config"),
      XDG_CACHE_HOME: join(context.smokeRoot, "cache"),
    });
    expect(JSON.stringify(context.log)).not.toContain(root);
    expect(() => createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-09T10:11:12.000Z"),
      nonce: "abc123",
      baseEnv: {},
    })).toThrow(/already exists/i);
  });

  it("builds standard Tauri WebDriver capabilities without smuggling store roots or sidecar params", () => {
    const capabilities = buildTauriWebDriverCapabilities("/tmp/theprivator");
    expect(capabilities.get("browserName")).toBe("wry");
    expect(capabilities.get("tauri:options")).toEqual({ application: "/tmp/theprivator" });

    const serialized = JSON.stringify(capabilities);
    expect(serialized).not.toContain("storeRoot");
    expect(serialized).not.toContain("profileId");
    expect(serialized).not.toContain("chromium");
    expect(serialized).not.toContain("sidecar");
    expect(serialized).not.toContain("browserleaks-webgl");
    expect(serialized).not.toContain(PACKAGED_SMOKE_PRESET_ID);
    expect(serialized).not.toMatch(/https?:\/\//i);
    expect(serialized).not.toContain("debugPort");
  });

  it("resolves tauri-driver from PATH or an injected cargo bin and redacts visible UI failure snippets", () => {
    const root = makeRoot();
    const cargoBin = join(root, "home", ".cargo", "bin");
    writeExecutable(join(cargoBin, "tauri-driver"));

    expect(resolveTauriDriverExecutable({
      rootDir: root,
      platform: "linux",
      env: { PATH: join(root, "empty") },
      cargoBin,
    })).toMatchObject({ name: "tauri-driver", path: join(cargoBin, "tauri-driver") });

    const snippet = safeVisibleTextSnippet(
      `Profile failed at ${root} with --user-data-dir=${join(root, "profile-store", "profiles", "p1", "user-data")} and Traceback secret`,
      { rootDir: root, sensitiveValues: [root] },
    );
    expect(snippet).not.toContain(root);
    expect(snippet).not.toMatch(/--user-data-dir=\S+/);
    expect(snippet).not.toContain("Traceback");
    expect(snippet.length).toBeLessThanOrEqual(520);
  });

  it("asserts packaged store-v3 proxy persistence while redacting public proof", () => {
    const root = makeRoot();
    const context = createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-09T10:11:12.000Z"),
      nonce: "persist123",
      baseEnv: {},
    });
    const profileId = "11111111-1111-4111-8111-111111111111";
    const appDataRoot = join(context.dataRoot, "Com.ThePrivator.Desktop");
    writeJson(join(appDataRoot, "profile-store", "profiles.json"), {
      storeVersion: 3,
      profiles: [
        {
          id: profileId,
          name: context.smokeProfileName,
          createdAt: "2026-05-09T10:11:12.000Z",
          updatedAt: "2026-05-09T10:11:12.000Z",
          defaults: {
            browser: "chromium",
            startUrl: "about:blank",
            proxyMode: "fixedServer",
            fingerprintMode: "disabled",
          },
          storage: {
            profileDir: `profile-store/profiles/${profileId}`,
            userDataDir: `profile-store/profiles/${profileId}/user-data`,
          },
          identity: packagedSmokeIdentity(),
          proxy: packagedSmokeProxy(),
        },
      ],
    });

    const proof = assertPostSmokeProfileStore({ rootDir: root, smokeContext: context });

    expect(proof).toMatchObject({
      smokeProfileName: context.smokeProfileName,
      smokeRoot: context.smokeRootRelative,
      appDataRoot: "src-tauri/target/s06-smoke-data/20260509T101112000Z-persist123/data/Com.ThePrivator.Desktop",
      profileStore: "src-tauri/target/s06-smoke-data/20260509T101112000Z-persist123/data/Com.ThePrivator.Desktop/profile-store/profiles.json",
      profileId,
      storeVersion: 3,
      persistedRuntimeFields: 0,
      storage: {
        profileDir: `profile-store/profiles/${profileId}`,
        userDataDir: `profile-store/profiles/${profileId}/user-data`,
      },
      identity: {
        identityVersion: 1,
        presetId: PACKAGED_SMOKE_PRESET_ID,
        label: PACKAGED_SMOKE_PRESET_LABEL,
        surfaceModes: PACKAGED_SMOKE_EXPECTED_SURFACE_MODES,
      },
      proxy: {
        proxyVersion: 1,
        mode: "fixedServer",
        protocol: "http",
        credentialState: "configured",
        summary: "http://proxy.example:8080",
      },
    });
    expect(JSON.stringify(proof)).not.toContain(root);
    expect(JSON.stringify(proof)).not.toContain("proxy-user-should-not-leak");
    expect(JSON.stringify(proof)).not.toContain("proxy-pass-should-not-leak");
    expect(JSON.stringify(proof)).not.toContain('"credentials"');

    writeJson(join(appDataRoot, "profile-store", "profiles.json"), {
      profiles: [
        {
          id: profileId,
          name: context.smokeProfileName,
          storage: {
            profileDir: `profile-store/profiles/${profileId}`,
            userDataDir: `profile-store/profiles/${profileId}/user-data`,
          },
          identity: packagedSmokeIdentity(),
          proxy: packagedSmokeProxy(),
        },
      ],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/storeVersion/i);

    writeJson(join(appDataRoot, "profile-store", "profiles.json"), {
      storeVersion: 2,
      profiles: [
        {
          id: profileId,
          name: context.smokeProfileName,
          storage: {
            profileDir: `profile-store/profiles/${profileId}`,
            userDataDir: `profile-store/profiles/${profileId}/user-data`,
          },
          identity: packagedSmokeIdentity(),
          proxy: packagedSmokeProxy(),
        },
      ],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/storeVersion/i);

    writeJson(join(appDataRoot, "profile-store", "profiles.json"), {
      storeVersion: 3,
      profiles: [
        {
          id: profileId,
          name: context.smokeProfileName,
          storage: {
            profileDir: `profile-store/profiles/${profileId}`,
            userDataDir: `profile-store/profiles/${profileId}/user-data`,
          },
          identity: defaultIdentity(),
          proxy: packagedSmokeProxy(),
        },
      ],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/curated identity preset/i);

    writeJson(join(appDataRoot, "profile-store", "profiles.json"), {
      storeVersion: 3,
      profiles: [
        {
          id: profileId,
          name: context.smokeProfileName,
          storage: {
            profileDir: `profile-store/profiles/${profileId}`,
            userDataDir: `profile-store/profiles/${profileId}/user-data`,
          },
          identity: packagedSmokeIdentity(),
        },
      ],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/proxy/i);

    writeJson(join(appDataRoot, "profile-store", "profiles.json"), {
      storeVersion: 3,
      profiles: [
        {
          id: profileId,
          name: context.smokeProfileName,
          storage: {
            profileDir: `profile-store/profiles/${profileId}`,
            userDataDir: `/tmp/theprivator/${profileId}/user-data`,
          },
          identity: packagedSmokeIdentity(),
          proxy: packagedSmokeProxy(),
        },
      ],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/safe relative user-data/i);

    writeJson(join(appDataRoot, "profile-store", "profiles.json"), {
      storeVersion: 3,
      profiles: [
        {
          id: profileId,
          name: context.smokeProfileName,
          storage: {
            profileDir: `profile-store/profiles/${profileId}`,
            userDataDir: `profile-store/profiles/${profileId}/user-data`,
          },
          identity: packagedSmokeIdentity(),
          proxy: packagedSmokeProxy(),
          debugPort: 9222,
          proxyAuthExtensionPath: `profile-store/profiles/${profileId}/generated-proxy-auth-extension`,
        },
      ],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/runtime truth/i);

    writeJson(join(appDataRoot, "profile-store", "profiles.json"), {
      storeVersion: 3,
      profiles: [
        {
          id: profileId,
          name: context.smokeProfileName,
          storage: {
            profileDir: `profile-store/profiles/${profileId}`,
            userDataDir: `profile-store/profiles/${profileId}/user-data`,
          },
          identity: packagedSmokeIdentity(),
          proxy: packagedSmokeProxy({ summary: "http://proxy-user-should-not-leak:proxy-pass-should-not-leak@proxy.example:8080" }),
        },
      ],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/proxy|credential|redaction/i);
  });

  it("asserts packaged diagnostics correlation and rejects unsafe diagnostic rows", () => {
    const root = makeRoot();
    const context = createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-09T10:11:12.000Z"),
      nonce: "diag123",
      baseEnv: {},
    });
    const profileId = "22222222-2222-4222-8222-222222222222";
    const appDataRoot = join(context.dataRoot, "theprivator-desktop");
    writeJson(join(appDataRoot, "profile-store", "profiles.json"), {
      storeVersion: 3,
      profiles: [
        {
          id: profileId,
          name: context.smokeProfileName,
          createdAt: "2026-05-09T10:11:12.000Z",
          updatedAt: "2026-05-09T10:11:12.000Z",
          defaults: {
            browser: "chromium",
            startUrl: "about:blank",
            proxyMode: "fixedServer",
            fingerprintMode: "disabled",
          },
          storage: {
            profileDir: `profile-store/profiles/${profileId}`,
            userDataDir: `profile-store/profiles/${profileId}/user-data`,
          },
          identity: packagedSmokeIdentity(),
          proxy: packagedSmokeProxy(),
        },
      ],
    });
    const diagnosticsPath = join(appDataRoot, "profile-store", "diagnostics", "events.jsonl");
    mkdirSync(dirname(diagnosticsPath), { recursive: true });
    writeFileSync(diagnosticsPath, [
      "not-json-but-safe",
      ...REQUIRED_DIAGNOSTIC_METHODS.map((method, index) => JSON.stringify({
        schemaVersion: 1,
        ts: `2026-05-09T10:11:${String(index).padStart(2, "0")}.000Z`,
        source: "python-sidecar",
        event: "sidecar.request",
        status: "ok",
        requestId: `s06-${index}`,
        method,
        durationMs: index,
        errorCode: null,
        detailRef: null,
        logPath: "profile-store/diagnostics/events.jsonl",
      })),
    ].join("\n"), "utf8");

    const proof = assertPostSmokeDiagnostics({ rootDir: root, smokeContext: context });

    expect(proof.requiredMethods).toEqual(REQUIRED_DIAGNOSTIC_METHODS);
    expect(proof.requiredMethods).toEqual([
      "profiles.create",
      "profiles.identity.applyPreset",
      "profiles.proxy.update",
      "profiles.proxy.check",
      "chromium.launch",
      "chromium.stop",
    ]);
    expect(proof.requiredMethods).not.toContain("identity.audit.plan");
    expect(proof.requiredMethods).not.toContain("identity.audit.open");
    expect(proof.malformedRows).toBe(1);
    expect(proof.validRows).toBe(REQUIRED_DIAGNOSTIC_METHODS.length);
    expect(JSON.stringify(proof)).not.toContain(root);

    for (const missingMethod of ["profiles.proxy.update", "profiles.proxy.check", "chromium.launch", "chromium.stop"]) {
      writeFileSync(diagnosticsPath, [
        ...REQUIRED_DIAGNOSTIC_METHODS.filter((method) => method !== missingMethod).map((method, index) => JSON.stringify({
          schemaVersion: 1,
          ts: `2026-05-09T10:12:${String(index).padStart(2, "0")}.000Z`,
          source: "python-sidecar",
          event: "sidecar.request",
          status: "ok",
          requestId: `s06-missing-${index}`,
          method,
          durationMs: index,
          logPath: "profile-store/diagnostics/events.jsonl",
        })),
      ].join("\n"), "utf8");
      try {
        assertPostSmokeDiagnostics({ rootDir: root, smokeContext: context });
        throw new Error("expected diagnostics assertion to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(VerifyFailure);
        expect(error.details.expectedMethod).toBe(missingMethod);
      }
    }

    writeFileSync(diagnosticsPath, `${JSON.stringify({
      schemaVersion: 1,
      ts: "2026-05-09T10:11:12.000Z",
      source: "python-sidecar",
      event: "sidecar.request",
      status: "ok",
      method: "profiles.create",
      durationMs: 1,
      logPath: "/tmp/unsafe-events.jsonl",
    })}\n`, "utf8");
    expect(() => assertPostSmokeDiagnostics({ rootDir: root, smokeContext: context })).toThrow(/unsafe logPath/i);

    for (const [field, override, message] of [
      ["params", { params: { profileId } }, /forbidden raw diagnostic fields/i],
      ["source", { source: "tauri-bridge" }, /unsafe source/i],
      ["event", { event: "raw.command" }, /unsafe event/i],
      ["status", { status: "pending" }, /unsafe status/i],
      ["method", { method: "https://browserleaks.com/webgl" }, /unsafe method/i],
    ]) {
      writeFileSync(diagnosticsPath, `${JSON.stringify({
        schemaVersion: 1,
        ts: "2026-05-09T10:11:12.000Z",
        source: "python-sidecar",
        event: "sidecar.request",
        status: "ok",
        method: "profiles.create",
        durationMs: 1,
        logPath: "profile-store/diagnostics/events.jsonl",
        ...override,
      })}\n`, "utf8");
      expect(() => assertPostSmokeDiagnostics({ rootDir: root, smokeContext: context }), field).toThrow(message);
    }
  });

  it("emits a redacted final summary with packaged proxy proof evidence", () => {
    const root = makeRoot();
    const context = createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-09T10:11:12.000Z"),
      nonce: "summary123",
      baseEnv: {},
    });
    const profileId = "33333333-3333-4333-8333-333333333333";
    const appDataRoot = join(context.dataRoot, "theprivator");
    writeJson(join(appDataRoot, "profile-store", "profiles.json"), {
      storeVersion: 3,
      profiles: [
        {
          id: profileId,
          name: context.smokeProfileName,
          storage: {
            profileDir: `profile-store/profiles/${profileId}`,
            userDataDir: `profile-store/profiles/${profileId}/user-data`,
          },
          identity: packagedSmokeIdentity(),
          proxy: packagedSmokeProxy(),
        },
      ],
    });

    const profileStore = assertPostSmokeProfileStore({ rootDir: root, smokeContext: context });
    const proxyCheck = packagedSmokeProxyProof({ profileId });
    const diagnostics = {
      diagnosticsLog: "src-tauri/target/s06-smoke-data/run/data/app/profile-store/diagnostics/events.jsonl",
      requiredMethods: REQUIRED_DIAGNOSTIC_METHODS,
      required: Object.fromEntries(REQUIRED_DIAGNOSTIC_METHODS.map((method) => [method, { status: "ok" }])),
    };
    const redaction = assertPostSmokeRedaction({
      rootDir: root,
      smokeContext: context,
      evidence: {
        artifact: "src-tauri/target/release/theprivator",
        proxy: profileStore.proxy,
        proxyCheck,
      },
    });
    const summary = buildFinalSummary({
      mode: "full",
      platform: "linux",
      arch: "x64",
      proof: {
        releaseExecutable: "src-tauri/target/release/theprivator",
        releaseSidecar: "src-tauri/target/release/theprivator-sidecar",
        targetTripleSidecar: "src-tauri/binaries/theprivator-sidecar-x86_64-unknown-linux-gnu",
        packages: ["src-tauri/target/release/bundle/deb/ThePrivator_2.1.0_amd64.deb"],
      },
      smoke: {
        smokeProfileName: context.smokeProfileName,
        smokeRoot: context.smokeRootRelative,
        lifecycle: "created-proxy-checked-saved-proof-launched-stopped-restarted",
        diagnostics,
        profileStore,
        proxy: profileStore.proxy,
        proxyCheck,
        redaction,
        cleanup: { status: "pass" },
      },
      checks: [{ name: "package-sidecar-shape", inspections: [{ artifact: "pkg.deb", status: "pass" }] }],
    });

    expect(summary.supportingRegressions).toEqual([
      "npm run verify:s02",
      "npm run verify:s03",
      "npm run verify:s04",
      "npm run verify:s05",
      "npm run verify:s06",
    ]);
    expect(summary.sidecarBundledInvocation.sourceSidecarSubprocess).toBe(false);
    expect(summary.identity).toMatchObject({
      presetId: PACKAGED_SMOKE_PRESET_ID,
      label: PACKAGED_SMOKE_PRESET_LABEL,
      surfaceModes: PACKAGED_SMOKE_EXPECTED_SURFACE_MODES,
      persistence: "profile-store",
    });
    expect(summary.audit).toBeUndefined();
    expect(summary.proxy).toMatchObject({
      mode: "fixedServer",
      protocol: "http",
      credentialState: "configured",
      summary: "http://proxy.example:8080",
    });
    expect(summary.proxy).not.toHaveProperty("credentials");
    expect(summary.proxyCheck).toMatchObject({
      routeProof: { status: "proved", directFallbackDetected: false },
      ipHiding: { status: "proved", publicExitIpClaimed: false },
      webRtc: { status: "restricted" },
      publicCheckers: { status: "advisory-only" },
    });
    expect(summary.routeProof).toMatchObject({ status: "proved", directFallbackDetected: false });
    expect(summary.ipHiding).toMatchObject({ status: "proved", publicExitIpClaimed: false });
    expect(summary.webRtc).toMatchObject({ status: "restricted" });
    expect(summary.publicCheckers).toMatchObject({ status: "advisory-only" });
    expect(summary.cleanup).toMatchObject({ status: "pass" });
    expect(JSON.stringify(summary)).not.toContain(root);
    expect(JSON.stringify(summary)).not.toMatch(/proxy-user-should-not-leak|proxy-pass-should-not-leak|"credentials"|Proxy-Authorization|--proxy-server|profile-store\/profiles|public checker body/i);

    for (const evidence of [
      { credentials: { username: "redacted", password: "redacted" } },
      { proxyAuthorization: "Proxy-Authorization: Basic redacted" },
      { launchArgs: ["--proxy-server=http://127.0.0.1:8080"] },
      { generatedAuthExtensionPath: "profile-store/profiles/profile/generated-proxy-auth-extension" },
      { appDataRoot: join(context.dataRoot, "theprivator") },
      { publicCheckerBodyText: "Cloudflare trace body text ip=203.0.113.5" },
      { fixtureTrust: { spkiSha256: "verifier-only-trust-detail" } },
    ]) {
      expect(() => assertPostSmokeRedaction({ rootDir: root, smokeContext: context, evidence })).toThrow(/forbidden|unsafe|leaked/i);
    }
  });
});
