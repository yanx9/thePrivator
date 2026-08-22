import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as packagedVerifier from "./verify-s06.mjs";
import {
  FORBIDDEN_PROFILE_RUNTIME_FIELDS,
  PACKAGED_SMOKE_EXPECTED_SURFACE_MODES,
  PACKAGED_SMOKE_PRESET_ID,
  PACKAGED_SMOKE_PRESET_LABEL,
  PACKAGED_SMOKE_PROFILE_PREFIX,
  REQUIRED_DIAGNOSTIC_METHODS,
  VerifyFailure,
  assertCurrentHttpSavedProxyProofUiState,
  assertFreshBuildArtifacts,
  assertPostSmokeDiagnostics,
  assertPostSmokeProfileStore,
  assertPostSmokeRedaction,
  assertTauriGuardrails,
  assertWebDriverPreflight,
  buildFinalSummary,
  buildTauriWebDriverCapabilities,
  createSmokeRunContext,
  describeSavedProxyProofUiState,
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

function packagedSmokeOrganization(overrides = {}) {
  return {
    folderId: null,
    tags: ["packaged smoke", "proxy_user rotation"],
    notes: "Runbook: rotate proxy_user each quarter, notes live at profile-store/profiles and wss://ops.example/runbook.",
    favorite: true,
    color: "#3366ff",
    ...overrides,
  };
}

function packagedSmokeLaunch(overrides = {}) {
  return {
    startupBehavior: "customUrls",
    startUrls: ["about:blank", "https://example.invalid/start"],
    args: ["--disable-features=Translate", "--no-first-run"],
    ...overrides,
  };
}

function packagedSmokeLifecycle(overrides = {}) {
  return {
    deletedAt: null,
    lastLaunchedAt: "2026-05-09T10:11:12.000Z",
    launchCount: 2,
    ...overrides,
  };
}

function packagedSmokeSync(overrides = {}) {
  return {
    revision: 3,
    updatedBy: "44444444-4444-4444-8444-444444444444",
    originDeviceId: "44444444-4444-4444-8444-444444444444",
    lastSyncedAt: null,
    lastSyncedRevision: null,
    ...overrides,
  };
}

function packagedSmokeStoreProfile(profileId, smokeProfileName, overrides = {}) {
  return {
    id: profileId,
    name: smokeProfileName,
    storage: {
      profileDir: `profile-store/profiles/${profileId}`,
      userDataDir: `profile-store/profiles/${profileId}/user-data`,
    },
    identity: packagedSmokeIdentity(),
    proxy: packagedSmokeProxy(),
    organization: packagedSmokeOrganization(),
    launch: packagedSmokeLaunch(),
    lifecycle: packagedSmokeLifecycle(),
    sync: packagedSmokeSync(),
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
    app: {
      windows: [
        {
          label: "main",
          decorations: capabilityOverrides.decorations ?? false,
        },
      ],
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
      "core:window:default",
      "core:window:allow-start-dragging",
      "core:window:allow-minimize",
      "core:window:allow-toggle-maximize",
      "core:window:allow-close",
      "dialog:allow-open",
      "dialog:allow-save",
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
    expect(Array.from(FORBIDDEN_PROFILE_RUNTIME_FIELDS)).toContain("args");
    expect(Array.from(FORBIDDEN_PROFILE_RUNTIME_FIELDS)).not.toContain("credentials");
    expect(Array.from(FORBIDDEN_PROFILE_RUNTIME_FIELDS)).not.toContain("organization");
    expect(Array.from(FORBIDDEN_PROFILE_RUNTIME_FIELDS)).not.toContain("launch");
  });

  it("exports only the packaged helper surface S05 needs without proxy secrets", () => {
    const helperNames = [
      "assertBuildArtifactsPresent",
      "assertFreshBuildArtifacts",
      "assertTauriGuardrails",
      "assertWebDriverPreflight",
      "createSmokeRunContext",
      "startTauriDriverProcess",
      "createTauriWebDriverSession",
      "quitDriverSession",
      "cleanupPackagedSmoke",
      "safeSelectorContext",
      "pollForValue",
      "waitForVisibleElement",
      "waitForVisibleText",
      "waitForProfileCard",
      "waitForProfileButton",
      "waitForMetricValue",
      "readMetricValue",
      "readProfileSectionText",
      "readProfileCardText",
      "assertInitialPackagedUi",
      "createSmokeProfile",
      "openSmokeIdentityConfig",
      "applySmokeIdentityPreset",
      "configureSmokeProxy",
      "runSavedProxyProof",
      "assertPostSmokeProfileStore",
      "assertPostSmokeDiagnostics",
      "assertPostSmokeRedaction",
      "startProxyFixture",
      "fixtureObservationCounts",
    ];

    for (const name of helperNames) {
      expect(packagedVerifier[name], name).toBeTypeOf("function");
    }
    expect(Object.keys(packagedVerifier)).not.toEqual(expect.arrayContaining([
      "PACKAGED_SMOKE_PROXY_USERNAME",
      "PACKAGED_SMOKE_PROXY_PASSWORD",
      "PACKAGED_SMOKE_PROXY_TARGET_HOST",
      "PACKAGED_SMOKE_PROXY_TARGET_PATH",
      "GLOBAL_SENSITIVE_VALUES",
    ]));
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
      decorations: false,
      permissions: [
        "core:default",
        "core:window:default",
        "core:window:allow-start-dragging",
        "core:window:allow-minimize",
        "core:window:allow-toggle-maximize",
        "core:window:allow-close",
        "dialog:allow-open",
        "dialog:allow-save",
        "shell:allow-spawn",
      ],
    });

    for (const forbiddenPermission of [
      "fs:default",
      "shell:allow-open",
      "shell:allow-execute",
      "dialog:default",
      "core:window:allow-create",
      "core:window:allow-set-title",
    ]) {
      seedTauriGuardrails(root, { permissions: [forbiddenPermission] });
      expect(() => assertTauriGuardrails({ rootDir: root, platform: "linux" }), forbiddenPermission).toThrow(/widened/i);
    }

    seedTauriGuardrails(root, {
      permissions: [
        {
          identifier: "shell:allow-spawn",
          allow: [
            { name: "binaries/theprivator-sidecar", sidecar: true },
            { name: "sh", sidecar: false },
          ],
        },
      ],
    });
    expect(() => assertTauriGuardrails({ rootDir: root, platform: "linux" })).toThrow(/widened/i);

    seedTauriGuardrails(root, { decorations: true });
    expect(() => assertTauriGuardrails({ rootDir: root, platform: "linux" })).toThrow(/frameless|decorations/i);
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

    const s05Context = createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-09T10:11:12.000Z"),
      nonce: "s05abc",
      profilePrefix: "M004 Packaged Automation Smoke",
      baseEnv: {},
    });
    expect(s05Context.smokeProfileName).toBe("M004 Packaged Automation Smoke 20260509T101112000Z-s05abc");
    expect(JSON.stringify(s05Context.log)).not.toContain(root);
    expect(() => createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-09T10:11:12.000Z"),
      nonce: "unsafe-prefix",
      profilePrefix: "M004/Packaged Automation Smoke",
      baseEnv: {},
    })).toThrow(/profile prefix/i);

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

  it("catches a real secret pasted into a profile note", () => {
    // The organization-text exemption exists so notes keep slashes and colons.
    // It must not extend to planted secret values: masking those was how notes
    // and tags ended up with no leak coverage at all.
    const root = makeRoot();
    const context = createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-09T10:11:12.000Z"),
      nonce: "leak123",
      baseEnv: {},
    });
    const profileId = "11111111-1111-4111-8111-111111111111";
    const storePath = join(context.dataRoot, "Com.ThePrivator.Desktop", "profile-store", "profiles.json");
    writeJson(storePath, {
      storeVersion: 4,
      profiles: [
        packagedSmokeStoreProfile(profileId, context.smokeProfileName, {
          organization: packagedSmokeOrganization({
            notes: "Reminder: the password is proxy-pass-should-not-leak",
          }),
        }),
      ],
    });

    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(
      /leaked forbidden smoke fixture text/,
    );
  });

  it("asserts packaged store-v4 proxy persistence while redacting public proof", () => {
    const root = makeRoot();
    const context = createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-09T10:11:12.000Z"),
      nonce: "persist123",
      baseEnv: {},
    });
    const profileId = "11111111-1111-4111-8111-111111111111";
    const appDataRoot = join(context.dataRoot, "Com.ThePrivator.Desktop");
    const storePath = join(appDataRoot, "profile-store", "profiles.json");
    writeJson(storePath, {
      storeVersion: 4,
      profiles: [
        packagedSmokeStoreProfile(profileId, context.smokeProfileName, {
          createdAt: "2026-05-09T10:11:12.000Z",
          updatedAt: "2026-05-09T10:11:12.000Z",
          defaults: {
            browser: "chromium",
            startUrl: "about:blank",
            proxyMode: "fixedServer",
            fingerprintMode: "managed",
          },
        }),
      ],
    });

    const proof = assertPostSmokeProfileStore({ rootDir: root, smokeContext: context });

    expect(proof).toMatchObject({
      smokeProfileName: context.smokeProfileName,
      smokeRoot: context.smokeRootRelative,
      appDataRoot: "src-tauri/target/s06-smoke-data/20260509T101112000Z-persist123/data/Com.ThePrivator.Desktop",
      profileStore: "src-tauri/target/s06-smoke-data/20260509T101112000Z-persist123/data/Com.ThePrivator.Desktop/profile-store/profiles.json",
      profileId,
      storeVersion: 4,
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
      organization: {
        tagCount: 2,
        notesLength: packagedSmokeOrganization().notes.length,
        favorite: true,
        foldered: false,
        colored: true,
      },
      launch: {
        startupBehavior: "customUrls",
        startUrlCount: 2,
        argCount: 2,
      },
      lifecycle: {
        trashed: false,
        launchCount: 2,
      },
    });
    expect(JSON.stringify(proof)).not.toContain(root);
    expect(JSON.stringify(proof)).not.toContain("proxy-user-should-not-leak");
    expect(JSON.stringify(proof)).not.toContain("proxy-pass-should-not-leak");
    expect(JSON.stringify(proof)).not.toContain('"credentials"');
    expect(JSON.stringify(proof)).not.toContain("proxy_user");
    expect(JSON.stringify(proof)).not.toContain("wss://");

    writeJson(storePath, {
      storeVersion: 4,
      profiles: [
        packagedSmokeStoreProfile(profileId, context.smokeProfileName, {
          proxy: {
            proxyVersion: 1,
            mode: "fixedServer",
            protocol: "http",
            host: "proxy.example",
            port: 8080,
            credentials: {
              username: "proxy-user-should-not-leak",
              password: "proxy-pass-should-not-leak",
            },
          },
        }),
      ],
    });
    expect(assertPostSmokeProfileStore({ rootDir: root, smokeContext: context }).proxy).toEqual({
      proxyVersion: 1,
      mode: "fixedServer",
      protocol: "http",
      credentialState: "configured",
      summary: "http://proxy.example:8080",
    });

    writeJson(storePath, {
      profiles: [packagedSmokeStoreProfile(profileId, context.smokeProfileName)],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/storeVersion/i);

    writeJson(storePath, {
      storeVersion: 3,
      profiles: [packagedSmokeStoreProfile(profileId, context.smokeProfileName)],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/storeVersion/i);

    writeJson(storePath, {
      storeVersion: 5,
      profiles: [packagedSmokeStoreProfile(profileId, context.smokeProfileName)],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/storeVersion/i);

    writeJson(storePath, {
      storeVersion: 4,
      profiles: [packagedSmokeStoreProfile(profileId, context.smokeProfileName, { identity: defaultIdentity() })],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/curated identity preset/i);

    writeJson(storePath, {
      storeVersion: 4,
      profiles: [packagedSmokeStoreProfile(profileId, context.smokeProfileName, { proxy: undefined })],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/proxy/i);

    writeJson(storePath, {
      storeVersion: 4,
      profiles: [
        packagedSmokeStoreProfile(profileId, context.smokeProfileName, {
          storage: {
            profileDir: `profile-store/profiles/${profileId}`,
            userDataDir: `/tmp/theprivator/${profileId}/user-data`,
          },
        }),
      ],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/safe relative user-data/i);

    writeJson(storePath, {
      storeVersion: 4,
      profiles: [
        packagedSmokeStoreProfile(profileId, context.smokeProfileName, {
          debugPort: 9222,
          proxyAuthExtensionPath: `profile-store/profiles/${profileId}/generated-proxy-auth-extension`,
        }),
      ],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/runtime truth/i);

    writeJson(storePath, {
      storeVersion: 4,
      profiles: [
        packagedSmokeStoreProfile(profileId, context.smokeProfileName, {
          proxy: packagedSmokeProxy({ summary: "http://proxy-user-should-not-leak:proxy-pass-should-not-leak@proxy.example:8080" }),
        }),
      ],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/proxy|credential|redaction/i);
  });

  it("accepts declared launch args while still rejecting captured runtime argv", () => {
    const root = makeRoot();
    const context = createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-09T10:11:12.000Z"),
      nonce: "launch123",
      baseEnv: {},
    });
    const profileId = "55555555-5555-4555-8555-555555555555";
    const storePath = join(context.dataRoot, "theprivator", "profile-store", "profiles.json");
    const seed = (launchOverrides, profileOverrides = {}) => writeJson(storePath, {
      storeVersion: 4,
      profiles: [
        packagedSmokeStoreProfile(profileId, context.smokeProfileName, {
          launch: packagedSmokeLaunch(launchOverrides),
          ...profileOverrides,
        }),
      ],
    });

    seed({ args: ["--disable-features=Translate", "--no-first-run", "--lang=en-GB"] });
    expect(assertPostSmokeProfileStore({ rootDir: root, smokeContext: context }).launch).toEqual({
      startupBehavior: "customUrls",
      startUrlCount: 2,
      argCount: 3,
    });

    seed({ args: [] }, { proxyRuntime: { args: ["--proxy-server=http://127.0.0.1:8080"] } });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/runtime truth/i);

    seed({ args: ["not-a-switch"] });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/launch\.args/i);

    seed({ args: [`--lang=${"e".repeat(300)}`] });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/launch\.args/i);

    seed({ args: Array.from({ length: 21 }, (_, index) => `--flag-${index}`) });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/launch\.args/i);

    seed({ args: ["--user-data-dir=/home/someone/profile"] });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/unsafe diagnostic/i);

    for (const startUrls of [
      ["file:///etc/passwd"],
      ["javascript:alert(1)"],
      ["--headless"],
      ["https://example.invalid/ start"],
      [`https://example.invalid/${"a".repeat(2100)}`],
      Array.from({ length: 11 }, (_, index) => `https://example.invalid/${index}`),
    ]) {
      seed({ startUrls });
      expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context }), String(startUrls[0])).toThrow(/startUrls/i);
    }

    seed({ startupBehavior: "openLastSession" });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/startupBehavior/i);
  });

  it("bounds organization free text without applying path-shaped redaction to it", () => {
    const root = makeRoot();
    const context = createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-09T10:11:12.000Z"),
      nonce: "notes123",
      baseEnv: {},
    });
    const profileId = "66666666-6666-4666-8666-666666666666";
    const storePath = join(context.dataRoot, "theprivator", "profile-store", "profiles.json");
    const seed = (organizationOverrides) => writeJson(storePath, {
      storeVersion: 4,
      profiles: [
        packagedSmokeStoreProfile(profileId, context.smokeProfileName, {
          organization: packagedSmokeOrganization(organizationOverrides),
        }),
      ],
    });

    seed({
      notes: "See profile-store/profiles/notes: proxy_user rotation, wss://ops.example, C:\\Users\\ops\\manifest.json",
      tags: ["proxy_pass audit"],
    });
    const proof = assertPostSmokeProfileStore({ rootDir: root, smokeContext: context });
    expect(proof.organization).toMatchObject({ tagCount: 1, favorite: true, colored: true });
    expect(JSON.stringify(proof)).not.toContain("proxy_user");
    expect(JSON.stringify(proof)).not.toContain("proxy_pass");
    expect(assertPostSmokeRedaction({ rootDir: root, smokeContext: context }).profileStore).toBe("redacted");

    seed({ notes: "a".repeat(1501) });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/organization\.notes/i);

    seed({ notes: "line one\nline two" });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/organization\.notes/i);

    seed({ tags: ["ok", "b".repeat(33)] });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/organization\.tags/i);

    seed({ tags: Array.from({ length: 11 }, (_, index) => `tag-${index}`) });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/organization\.tags/i);

    seed({ color: "rebeccapurple" });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/organization\.color/i);

    seed({ favorite: "yes" });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/organization\.favorite/i);
  });

  it("rejects a smoke profile left in the profile-store trash", () => {
    const root = makeRoot();
    const context = createSmokeRunContext({
      rootDir: root,
      now: new Date("2026-05-09T10:11:12.000Z"),
      nonce: "trash123",
      baseEnv: {},
    });
    const profileId = "77777777-7777-4777-8777-777777777777";
    const storePath = join(context.dataRoot, "theprivator", "profile-store", "profiles.json");

    writeJson(storePath, {
      storeVersion: 4,
      profiles: [
        packagedSmokeStoreProfile(profileId, context.smokeProfileName, {
          lifecycle: packagedSmokeLifecycle({ deletedAt: "2026-05-09T10:12:00.000Z" }),
        }),
      ],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/trash/i);

    writeJson(storePath, {
      storeVersion: 4,
      profiles: [
        packagedSmokeStoreProfile(profileId, context.smokeProfileName, {
          lifecycle: packagedSmokeLifecycle({ launchCount: -1 }),
        }),
      ],
    });
    expect(() => assertPostSmokeProfileStore({ rootDir: root, smokeContext: context })).toThrow(/launchCount/i);
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
      storeVersion: 4,
      profiles: [
        packagedSmokeStoreProfile(profileId, context.smokeProfileName, {
          createdAt: "2026-05-09T10:11:12.000Z",
          updatedAt: "2026-05-09T10:11:12.000Z",
          defaults: {
            browser: "chromium",
            startUrl: "about:blank",
            proxyMode: "fixedServer",
            fingerprintMode: "managed",
          },
        }),
      ],
    });
    const diagnosticsPath = join(appDataRoot, "profile-store", "diagnostics", "events.jsonl");
    mkdirSync(dirname(diagnosticsPath), { recursive: true });
    writeFileSync(diagnosticsPath, [
      "not-json-but-safe",
      JSON.stringify({
        schemaVersion: 1,
        ts: "2026-05-09T10:10:59.000Z",
        source: "python-sidecar",
        event: "sidecar.request",
        status: "error",
        requestId: "s06-socks-negative",
        method: "profiles.proxy.check",
        durationMs: 7,
        errorCode: "PROXY_SOCKS_AUTH_UNSUPPORTED",
        detailRef: "sidecar-socks-auth-negative",
        logPath: "profile-store/diagnostics/events.jsonl",
      }),
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
    expect(proof.validRows).toBe(REQUIRED_DIAGNOSTIC_METHODS.length + 1);
    expect(proof.typedFailures).toEqual([
      {
        method: "profiles.proxy.check",
        status: "error",
        errorCode: "PROXY_SOCKS_AUTH_UNSUPPORTED",
        detailRef: "sidecar-socks-auth-negative",
        logPath: "profile-store/diagnostics/events.jsonl",
        durationMs: 7,
      },
    ]);
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

  it("rejects stale SOCKS proof state before accepting a fresh HTTP saved-proxy result", () => {
    const staleSocksState = describeSavedProxyProofUiState({
      visibleText: "Saved proxy proof bridge error PROXY_SOCKS_AUTH_UNSUPPORTED SOCKS proxy credentials cannot be used",
      phase: "recoverable-error · Saved proxy proof bridge error",
      request: "bridge-socks-negative",
      previousRequest: "bridge-socks-negative",
    });
    expect(staleSocksState).toMatchObject({
      hasResult: false,
      hasCurrentHttpSuccess: false,
      staleSocksFailureObserved: true,
      staleRequest: true,
    });
    expect(() => assertCurrentHttpSavedProxyProofUiState({
      visibleText: "Saved proxy proof bridge error PROXY_SOCKS_AUTH_UNSUPPORTED SOCKS proxy credentials cannot be used",
      phase: "recoverable-error · Saved proxy proof bridge error",
      request: "bridge-socks-negative",
    }, { previousRequest: "bridge-socks-negative" })).toThrow(/results were not visible/i);

    expect(() => assertCurrentHttpSavedProxyProofUiState({
      resultText: "Local fixture proved saved proxy routing. Deterministic local route proof Route proof Proved Protocol HTTP Credential state configured (masked) Fallback route Not detected",
      visibleText: "Saved proxy proof finished for request bridge-http-missing-vocab",
      phase: "success · Saved proxy proof complete",
      request: "bridge-http-missing-vocab",
    }, { previousRequest: "bridge-socks-negative" })).toThrow(/required S04 vocabulary/i);

    const freshHttpResult = [
      "Local fixture proved saved proxy routing.",
      "The local fixture observed proxy routing and concluded the proof target did not see the direct target IP.",
      "Deterministic local route proof",
      "The sidecar-managed local fixture saw the proxy path without bypass evidence.",
      "Route proof Proved",
      "Protocol HTTP",
      "Credential state configured (masked)",
      "Fallback route Not detected",
      "IP-hiding conclusion",
      "The local fixture conclusion proves target-IP hiding only for the deterministic fixture.",
      "WebRTC / local-IP baseline",
      "Non Proxied Udp Disabled",
      "Public checker advisory pages",
      "Advisory only",
    ].join(" ");
    const accepted = assertCurrentHttpSavedProxyProofUiState({
      resultText: freshHttpResult,
      visibleText: "Persisted diagnostic event summaries matched this detailRef. PROXY_SOCKS_AUTH_UNSUPPORTED Saved proxy proof finished for request bridge-http-current",
      phase: "success · Saved proxy proof complete",
      request: "bridge-http-current",
    }, { previousRequest: "bridge-socks-negative" });
    expect(accepted).toMatchObject({
      hasCurrentHttpSuccess: true,
      staleSocksFailureObserved: true,
      staleRequest: false,
    });
    expect(() => assertCurrentHttpSavedProxyProofUiState({
      resultText: freshHttpResult,
      visibleText: "Saved proxy proof finished for request bridge-http-current",
      phase: "success · Saved proxy proof complete",
      request: "bridge-http-current",
    }, { previousRequest: "bridge-http-current" })).toThrow(/stale request/i);
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
      storeVersion: 4,
      profiles: [packagedSmokeStoreProfile(profileId, context.smokeProfileName)],
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
        cleanup: {
          status: "pass",
          smokeProfileName: context.smokeProfileName,
          smokeRoot: context.smokeRootRelative,
          retainedSmokeRoot: true,
          ownedChromium: { uiStop: "pass", runtimePids: [{ pid: 12345, status: "sigterm" }] },
          webdriverSession: { status: "quit" },
          driverProcess: { status: "terminated" },
          driverStderrTail: "--proxy-server=http://127.0.0.1:8080 should not reach final evidence",
        },
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
    expect(summary.routeProof).not.toHaveProperty("fixture");
    expect(summary.routeProof).not.toHaveProperty("target");
    expect(summary.routeProof).not.toHaveProperty("durationMs");
    expect(summary.directFallbackDetected).toBe(false);
    expect(summary.ipHiding).toMatchObject({ status: "proved", publicExitIpClaimed: false });
    expect(summary.ipHiding).not.toHaveProperty("publicExitIp");
    expect(summary.webRtc).toMatchObject({ status: "restricted" });
    expect(summary.publicCheckers).toMatchObject({ status: "advisory-only" });
    expect(summary.diagnosticsRequiredMethods).toEqual(REQUIRED_DIAGNOSTIC_METHODS);
    expect(summary.diagnostics).not.toHaveProperty("appDataRoot");
    expect(summary.cleanup).toMatchObject({
      status: "pass",
      retainedSmokeRoot: true,
      ownedChromium: { uiStop: "pass", runtimePidCount: 1, runtimePidStatuses: ["sigterm"] },
      webdriverSession: "quit",
      driverProcess: "terminated",
    });
    expect(JSON.stringify(summary)).not.toContain(root);
    expect(JSON.stringify(summary)).not.toContain("12345");
    expect(JSON.stringify(summary)).not.toMatch(/driver(?:Stdout|Stderr)Tail|proxy-user-should-not-leak|proxy-pass-should-not-leak|"credentials"|Proxy-Authorization|--proxy-server|profile-store\/profiles|public checker body/i);

    for (const evidence of [
      { credentials: { username: "redacted", password: "redacted" } },
      { proxyAuthorization: "Proxy-Authorization: Basic redacted" },
      { launchArgs: ["--proxy-server=http://127.0.0.1:8080"] },
      { generatedAuthExtensionPath: "profile-store/profiles/profile/generated-proxy-auth-extension" },
      { appDataRoot: join(context.dataRoot, "theprivator") },
      { publicCheckerBodyText: "Cloudflare trace body text ip=203.0.113.5" },
      { fixtureTrust: { spkiSha256: "verifier-only-trust-detail" } },
      { note: "Proxy-Authorization: Basic redacted" },
      { note: "http://alice:secret@proxy.example:8080" },
      { note: "--proxy-server=http://127.0.0.1:8080" },
      { note: "profile-store/profiles/profile/generated-proxy-auth-extension" },
      { note: "profile-store/profiles/profile/user-data" },
      { note: "https://browserleaks.com/webrtc public checker body" },
      { note: "spkiSha256 verifier-only-trust-detail" },
    ]) {
      expect(() => assertPostSmokeRedaction({ rootDir: root, smokeContext: context, evidence })).toThrow(/forbidden|unsafe|leaked/i);
    }
  });
});
