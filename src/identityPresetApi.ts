import type { ProfileIdentity } from "./sidecar/types";
import { fetchRandomUserAgent, inferUserAgentOs } from "./userAgentApi";

/** API supplies only the UA. Keep the complete, OS-matched local template. */
export async function refreshIdentityPresets(
  templates: readonly ProfileIdentity[], signal: AbortSignal,
): Promise<ProfileIdentity[]> {
  if (templates.length === 0) throw new Error("Identity templates are not loaded.");
  return Promise.all(templates.map(async (template) => {
    if (template.browser.mode === "real") throw new Error("A browser template is required.");
    const os = inferUserAgentOs(
      template.navigator.mode === "real" ? undefined : template.navigator.platform,
      template.browser.userAgent,
    );
    const userAgent = await fetchRandomUserAgent(os, signal);
    const major = userAgent.match(/Chrome\/(\d+)/)![1];
    return {
      ...structuredClone(template),
      presetId: null,
      label: `${template.label.replace(/Chrome \d+(?: \(API\))?$/, `Chrome ${major}`)} (API)`,
      browser: { ...structuredClone(template.browser), userAgent },
    };
  }));
}
