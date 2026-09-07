import { afterEach, expect, it, vi } from "vitest";
import { makeProfile } from "./testing/profileFactory";
import { refreshIdentityPresets } from "./identityPresetApi";

const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
afterEach(() => vi.unstubAllGlobals());
it("refreshes complete templates without mutating originals or retaining a curated ID", async () => {
  const base = { ...makeProfile().identity, label: "Ubuntu Linux Chrome 120", presetId: "ubuntu-linux-chrome-120", browser: { mode: "masked" as const, userAgent: ua.replace("142.", "120.") } };
  const before = structuredClone(base);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ userAgent: ua, browser: "chrome", browserVersion: "142.0.0.0", os: "linux", device: "desktop" }] }) }));
  const result = await refreshIdentityPresets([base], new AbortController().signal);
  expect(result).toEqual([{ ...base, presetId: null, label: "Ubuntu Linux Chrome 142 (API)", browser: { ...base.browser, userAgent: ua } }]);
  expect(base).toEqual(before);
});
