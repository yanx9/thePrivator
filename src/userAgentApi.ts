export type UserAgentOs = "windows" | "macos" | "linux";

function detectOs(value: string | undefined): UserAgentOs | undefined {
  if (/\b(?:Win32|Win64|Windows)\b/i.test(value ?? "")) return "windows";
  if (/\b(?:MacIntel|MacPPC|Macintosh|Mac OS X)\b/i.test(value ?? "")) return "macos";
  if (/\bLinux\b/i.test(value ?? "")) return "linux";
  return undefined;
}

/** Explicit navigator.platform wins, then existing UA; unknown defaults to Linux. */
export function inferUserAgentOs(platform: string | undefined, userAgent: string | undefined): UserAgentOs {
  return detectOs(platform) ?? detectOs(userAgent) ?? "linux";
}

/** Public, keyless provider. Never send the draft, proxy, or profile metadata. */
export async function fetchRandomUserAgent(os: UserAgentOs, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  // Avoid AbortSignal.timeout/any: older Mint WebKit supports AbortController.
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
  try {
    const ua = await requestUserAgent(os, controller.signal);
    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    return ua;
  } catch (error) {
    if (timedOut) throw new Error("randomapi.dev request timed out. Please try again.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function requestUserAgent(os: UserAgentOs, signal: AbortSignal): Promise<string> {
  const response = await fetch(`https://randomapi.dev/api/user-agents?count=1&browser=chrome&os=${os}&device=desktop`, {
    method: "GET", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error", signal,
  });
  if (!response.ok) throw new Error("randomapi.dev is unavailable. Please try again.");
  const body: unknown = await response.json();
  const invalid = new Error("Invalid user agent response from randomapi.dev.");
  if (!isRecord(body) || !Array.isArray(body.data) || body.data.length !== 1) throw invalid;
  const item: unknown = body.data[0];
  if (!isRecord(item)) throw invalid;
  const ua = item.userAgent;
  // The identity descriptor and sidecar both cap UA at 512 safe characters.
  // Chrome desktop UAs are ASCII; reject non-ASCII as well as all controls.
  if (typeof ua !== "string" || ua.length > 512 || !/^[\x20-\x7e]+$/.test(ua) ||
      !ua.startsWith("Mozilla/5.0 (") || !ua.includes("AppleWebKit/") || !ua.includes("Safari/") ||
      /Mobile|Android|iPhone|iPad|Firefox\/|CriOS\/|Edg\/|OPR\//i.test(ua) ||
      item.browser !== "chrome" || item.os !== os || item.device !== "desktop" ||
      detectOs(ua) !== os ||
      !/Chrome\/\d+\.\d+\.\d+\.\d+(?: |$)/.test(ua) ||
      ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)(?: |$)/)?.[1] !== item.browserVersion) throw invalid;
  return ua;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
