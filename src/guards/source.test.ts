import { describe, expect, it } from "vitest";

/**
 * Every UI source, read at build time.
 *
 * Vite's eager raw glob keeps this browser-build compatible without Node fs
 * types, and unlike reading one entry file it keeps covering the UI as it is
 * split into components -- a forbidden import moved to a sibling would otherwise
 * pass unnoticed. It lives outside src/legacy because it guards the whole tree,
 * not the app that happens to be mounted today.
 */
const uiSourceModules: Record<string, string> = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Test files carry raw command names, mocks, and unsafe sentinels on purpose. */
const TEST_SOURCE_PATTERN = /\.(test|spec)\.tsx?$/;

/**
 * `src/sidecar/client.ts` is the single module allowed to call `invoke`. That
 * chokepoint is what makes the rest of the UI mechanically checkable, so it is
 * exempt from the negative rules but still counted for the positive ones.
 */
const INVOKE_BOUNDARY_MODULE = "../sidecar/client.ts";

/**
 * Per-rule exemptions, keyed by module path.
 *
 * Deliberately narrow: a module that owns one boundary stays subject to every
 * other rule, so `windowControls.ts` importing `fetch` would still fail. A
 * blanket per-file exemption would quietly widen each of these modules'
 * authority to everything on the list.
 */
const NEGATIVE_RULE_EXEMPTIONS: Record<string, readonly string[]> = {
  // Fixed, public UA endpoint only; request privacy and validation are covered
  // by userAgentApi.test.ts. DOM/file bypasses remain forbidden in this module.
  "../userAgentApi.ts": ["direct network request"],
  // The single module allowed to touch the Tauri window API. Every call is a
  // dynamic import inside try/catch so the app still runs outside Tauri.
  "../windowControls.ts": ["direct window API"],
  // Holds the forbidden marketing phrases as the denylist it enforces; a module
  // whose job is to reject "guaranteed undetectability" has to contain it.
  "../identityAuditGuidance.ts": ["credential or guarantee copy"],
  // The single module allowed to subscribe to bridge events, for the same reason
  // windowControls owns the window API: one seam, dynamically imported, mockable.
  "../sidecarEvents.ts": ["direct event API"],
};

const uiSourceEntries = () =>
  Object.entries(uiSourceModules).filter(([path]) => !TEST_SOURCE_PATTERN.test(path));

/** Union of every UI source: for "the UI must use wrapper X somewhere" rules. */
const appSource = () => uiSourceEntries().map(([, text]) => text).join("\n");

/** Per-file sources subject to the negative rules, so a failure names the offender. */
const guardedUiSources = () =>
  uiSourceEntries().filter(([path]) => path !== INVOKE_BOUNDARY_MODULE);

const isExemptFromRule = (path: string, rule: string) =>
  NEGATIVE_RULE_EXEMPTIONS[path]?.includes(rule) ?? false;

describe("UI source guard", () => {
  it("does not add direct browser or Tauri filesystem bypasses for legacy import, cookie portability, and package portability", () => {
    const source = appSource();

    expect(source).toContain("scanLegacyProfiles");
    expect(source).toContain("importLegacyProfiles");
    expect(source).toContain("listIdentityPresets");
    expect(source).toContain("validateIdentity");
    expect(source).toContain("applyProfileIdentityPreset");
    expect(source).toContain("updateProfileIdentity");
    expect(source).toContain("getIdentityAuditPlan");
    expect(source).toContain("openIdentityAuditPage");
    expect(source).toContain("validateProxy");
    expect(source).toContain("updateProfileProxy");
    expect(source).toContain("startAutomationApi");
    expect(source).toContain("getAutomationApiStatus");
    expect(source).toContain("copyAutomationApiToken");
    expect(source).toContain("stopAutomationApi");
    expect(source).toContain("exportProfileCookies");
    expect(source).toContain("replaceProfileCookies");
    expect(source).toContain("exportProfilePackage");
    expect(source).toContain("importProfilePackage");
    expect(source).toContain("./windowControls");
    expect(source).toContain("data-tauri-drag-region");
    expect(source).toContain("onClick={() => void minimizeWindow()}");
    expect(source).toContain("onClick={() => void toggleMaximizeWindow()}");
    expect(source).toContain("onClick={() => void closeWindow()}");
    expect(source).toContain("@tauri-apps/plugin-dialog");
    // Negative rules run per file so a failure names the offending module rather
    // than the whole tree, and so they keep applying to components added later.
    const forbidden: Array<[string, RegExp]> = [
      ["PAC/system proxy vocabulary", /value=\"pac\"|value='pac'|value=\"system\"|value='system'|value=\"directFallback\"|value='directFallback'/],
      ["PAC/system proxy copy", /PAC proxy|Proxy Auto-Config|System proxy|Direct fallback|autoConfigUrl|proxyAutoConfig/],
      ["filesystem or shell plugin", /@tauri-apps\/plugin-(fs|shell)/],
      ["direct window API", /@tauri-apps\/api\/window/],
      ["direct event API", /@tauri-apps\/api\/event/],
      ["raw invoke outside the client", /\binvoke\s*\(/],
      ["browser storage or file bypass", /showOpenFilePicker|webkitdirectory|readTextFile|writeTextFile|localStorage|sessionStorage/],
      ["DOM escape hatch", /type=\"file\"|type='file'|<iframe|window\.open|document\.querySelector|\.innerHTML/],
      ["direct network request", /\bfetch\s*\(/],
      ["internal artifact vocabulary", /manifest\.json|package member|raw manifest|debug endpoint|launch args|raw diagnostics|stack trace/i],
      ["credential or guarantee copy", /Authorization|Bearer|guaranteed undetectability|universal green|universal pass/i],
    ];
    const violations: string[] = [];
    for (const [path, text] of guardedUiSources()) {
      for (const [label, pattern] of forbidden) {
        if (isExemptFromRule(path, label)) continue;
        if (pattern.test(text)) violations.push(`${path}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps every negative-rule exemption pointed at a real module and a real rule", () => {
    // An exemption for a module or rule that no longer exists is a silent hole:
    // it looks like a considered decision but guards nothing.
    const paths = new Set(uiSourceEntries().map(([path]) => path));
    const ruleLabels = new Set([
      "PAC/system proxy vocabulary",
      "PAC/system proxy copy",
      "filesystem or shell plugin",
      "direct window API",
      "raw invoke outside the client",
      "browser storage or file bypass",
      "DOM escape hatch",
      "direct network request",
      "internal artifact vocabulary",
      "credential or guarantee copy",
      "direct event API",
    ]);
    for (const [path, rules] of Object.entries(NEGATIVE_RULE_EXEMPTIONS)) {
      expect(paths, `exemption names a module that no longer exists: ${path}`).toContain(path);
      for (const rule of rules) {
        expect(ruleLabels, `exemption names a rule that no longer exists: ${rule}`).toContain(rule);
      }
    }
  });

  it("scans every UI module, not just the entry file", () => {
    // Guards the guard: if the glob silently matched nothing, every negative
    // assertion above would vacuously pass.
    const paths = guardedUiSources().map(([path]) => path);
    expect(paths).toContain("../App.tsx");
    expect(paths).toContain("../proxyControls.ts");
    expect(paths).not.toContain(INVOKE_BOUNDARY_MODULE);
    expect(paths.every((path) => !TEST_SOURCE_PATTERN.test(path))).toBe(true);
    expect(paths.length).toBeGreaterThanOrEqual(5);
  });
});
