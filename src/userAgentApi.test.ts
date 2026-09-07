import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRandomUserAgent, inferUserAgentOs } from "./userAgentApi";

const linuxUa = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const payload = (userAgent = linuxUa) => ({ data: [{ userAgent, browser: "chrome", browserVersion: "135.0.0.0", os: "linux", device: "desktop" }], meta: {} });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("random Chrome desktop user agents", () => {
  it.each([
    ["Win32", linuxUa, "windows"],
    ["MacIntel", linuxUa, "macos"],
    ["Linux x86_64", "Windows NT 10.0", "linux"],
    [undefined, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "windows"],
    ["unknown", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "macos"],
    [undefined, linuxUa, "linux"],
    [undefined, "unknown", "linux"],
  ])("matches platform %s before UA, defaulting to Linux", (platform, ua, expected) => {
    expect(inferUserAgentOs(platform, ua)).toBe(expected);
  });
  it.each([
    null, {}, { data: [] }, { data: [payload().data[0], payload().data[0]] },
    { data: [null] }, { data: [{ userAgent: linuxUa }] },
    payload(""), payload("x".repeat(513)), payload(linuxUa + "\n"), payload(linuxUa + "\u007f"),
    payload(linuxUa.replace("Chrome/135.0.0.0", "Firefox/135.0")),
    payload(linuxUa.replace("Linux", "Windows")), payload(linuxUa + " Mobile"),
    payload(linuxUa + " Edg/135.0.0.0"),
    { data: [{ ...payload().data[0], os: "windows" }] },
    { data: [{ ...payload().data[0], browserVersion: "999.0.0.0" }] },
    { data: [{ ...payload().data[0], device: "mobile" }] },
  ])("rejects malformed or implausible provider data safely: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
    await expect(fetchRandomUserAgent("linux", new AbortController().signal)).rejects.toThrow("Invalid user agent response from randomapi.dev.");
  });

  it("rejects HTTP failures before reading their body", async () => {
    const json = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json }));
    await expect(fetchRandomUserAgent("linux", new AbortController().signal)).rejects.toThrow("randomapi.dev is unavailable. Please try again.");
    expect(json).not.toHaveBeenCalled();
  });

  it("times out stalled requests using AbortController and clears its timer", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal;
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      requestSignal = init.signal;
      requestSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const result = expect(fetchRandomUserAgent("linux", new AbortController().signal)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(requestSignal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards cancellation and does not start already cancelled requests", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetch);
    const result = expect(fetchRandomUserAgent("linux", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await result;
    await expect(fetchRandomUserAgent("linux", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fetches only the OS filter from the fixed provider without credentials, cache or referrer", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload() });
    vi.stubGlobal("fetch", fetch);
    expect(await fetchRandomUserAgent("linux", new AbortController().signal)).toBe(linuxUa);
    expect(fetch).toHaveBeenCalledWith("https://randomapi.dev/api/user-agents?count=1&browser=chrome&os=linux&device=desktop", expect.objectContaining({
      method: "GET", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal),
    }));
  });
});
