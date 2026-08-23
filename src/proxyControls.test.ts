import { describe, expect, it } from "vitest";
import {
  FIXED_PROXY_PROTOCOL_OPTIONS,
  createProxyDraftState,
  parseProxyDraftState,
  updateProxyDraftCredentialField,
  updateProxyDraftCredentialMode,
  updateProxyDraftField,
  updateProxyDraftMode,
} from "./proxyControls";
import type { ProfileProxySummary, ProxyProtocol } from "./sidecar/types";

const SENTINEL_USERNAME = "raw-saved-user";
const SENTINEL_PASSWORD = "raw-saved-pass";

function directProxySummary(overrides: Partial<ProfileProxySummary> = {}): ProfileProxySummary {
  return {
    proxyVersion: 1,
    mode: "direct",
    credentialState: "none",
    summary: "Direct connection",
    ...overrides,
  } as ProfileProxySummary;
}

function fixedProxySummary(overrides: Record<string, unknown> = {}): ProfileProxySummary {
  const protocol = (overrides.protocol ?? "http") as ProxyProtocol;
  const host = (overrides.host ?? "proxy.example") as string;
  const port = (overrides.port ?? 8080) as number;
  const displayHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return {
    proxyVersion: 1,
    mode: "fixedServer",
    protocol,
    host,
    port,
    credentialState: "none",
    summary: `${protocol}://${displayHost}:${port}`,
    ...overrides,
  } as ProfileProxySummary;
}

describe("proxy control helpers", () => {
  it("exposes only direct and fixed-server proxy protocol choices", () => {
    expect(FIXED_PROXY_PROTOCOL_OPTIONS.map((option) => option.value)).toEqual(["http", "https", "socks4", "socks5"]);
    expect(JSON.stringify(FIXED_PROXY_PROTOCOL_OPTIONS)).not.toMatch(/pac|system|auto|url|bypass/i);
  });

  it("initializes and parses a direct proxy draft from a saved public summary", () => {
    const draft = createProxyDraftState(directProxySummary());

    expect(draft.mode).toBe("direct");
    expect(draft.credentialMode).toBe("none");
    expect(parseProxyDraftState(draft)).toEqual({
      ok: true,
      proxy: { proxyVersion: 1, mode: "direct" },
      errors: {},
    });
  });

  it("initializes fixed-server drafts from public summaries without sharing or inventing credentials", () => {
    const summary = fixedProxySummary({
      credentialState: "configured",
      summary: `http://proxy.example:8080 ${SENTINEL_USERNAME} ${SENTINEL_PASSWORD}`,
    });
    const draft = createProxyDraftState(summary);

    expect(draft).toMatchObject({
      mode: "fixedServer",
      protocol: "http",
      host: "proxy.example",
      port: "8080",
      credentialMode: "saved",
      savedCredentialState: "configured",
      credentialUsername: "",
      credentialPassword: "",
      errors: {},
    });
    expect(JSON.stringify(draft)).not.toContain(SENTINEL_USERNAME);
    expect(JSON.stringify(draft)).not.toContain(SENTINEL_PASSWORD);
  });

  it.each<ProxyProtocol>(["http", "https", "socks4", "socks5"])("parses fixed-server %s drafts", (protocol) => {
    const draft = createProxyDraftState(fixedProxySummary({ protocol, summary: `${protocol}://proxy.example:8080` }));
    const parsed = parseProxyDraftState(draft);

    expect(parsed).toEqual({
      ok: true,
      proxy: {
        proxyVersion: 1,
        mode: "fixedServer",
        protocol,
        host: "proxy.example",
        port: 8080,
      },
      errors: {},
    });
  });

  it("preserves IPv6 host text for sidecar validation", () => {
    const draft = createProxyDraftState(fixedProxySummary({ protocol: "socks5", host: "2001:db8::42", port: 1080 }));

    expect(parseProxyDraftState(draft)).toEqual({
      ok: true,
      proxy: {
        proxyVersion: 1,
        mode: "fixedServer",
        protocol: "socks5",
        host: "2001:db8::42",
        port: 1080,
      },
      errors: {},
    });
  });

  it.each([
    ["empty host", "host", ""],
    ["leading whitespace host", "host", " proxy.example"],
    ["embedded whitespace host", "host", "proxy example"],
    ["URL host", "host", "https://proxy.example"],
    ["userinfo host", "host", "user:pass@proxy.example"],
    ["path host", "host", "/tmp/proxy.sock"],
    ["argv host", "host", "--proxy-server=proxy.example"],
    ["unsupported protocol", "protocol", "pac"],
    ["decimal port", "port", "8080.5"],
    ["zero port", "port", "0"],
    ["too-large port", "port", "65536"],
  ] as const)("returns field errors for malformed %s", (_caseName, field, value) => {
    const base = createProxyDraftState(fixedProxySummary());
    const draft = updateProxyDraftField(base, field, value);
    const parsed = parseProxyDraftState(draft);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors[field]).toBeTruthy();
    }
  });

  it("rejects credential fields when Direct mode is selected", () => {
    let draft = updateProxyDraftMode(createProxyDraftState(directProxySummary()), "direct");
    draft = updateProxyDraftCredentialField(draft, "username", "proxy-user");
    draft = updateProxyDraftCredentialField(draft, "password", "proxy-pass");

    const parsed = parseProxyDraftState(draft);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.credentials).toMatch(/direct/i);
    }
  });

  it("blocks masked saved credentials until the user explicitly replaces or clears them", () => {
    const draft = createProxyDraftState(fixedProxySummary({ credentialState: "configured" }));

    const parsed = parseProxyDraftState(draft);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.credentials).toMatch(/masked/i);
    }
    expect(JSON.stringify(draft)).not.toContain(SENTINEL_USERNAME);
    expect(JSON.stringify(draft)).not.toContain(SENTINEL_PASSWORD);
  });

  it("includes replacement credentials only after explicit username and password entry", () => {
    let draft = createProxyDraftState(fixedProxySummary({ credentialState: "configured" }));
    draft = updateProxyDraftCredentialMode(draft, "replace");
    draft = updateProxyDraftCredentialField(draft, "username", "proxy-user");

    let parsed = parseProxyDraftState(draft);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.credentials).toMatch(/username and password/i);
    }

    draft = updateProxyDraftCredentialField(draft, "password", "proxy-pass");
    parsed = parseProxyDraftState(draft);

    expect(parsed).toEqual({
      ok: true,
      proxy: {
        proxyVersion: 1,
        mode: "fixedServer",
        protocol: "http",
        host: "proxy.example",
        port: 8080,
        credentials: { username: "proxy-user", password: "proxy-pass" },
      },
      errors: {},
    });
  });

  it("clears saved credentials explicitly without emitting a credentials field", () => {
    const draft = updateProxyDraftCredentialMode(createProxyDraftState(fixedProxySummary({ credentialState: "configured" })), "clear");
    const parsed = parseProxyDraftState(draft);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.proxy).toEqual({
        proxyVersion: 1,
        mode: "fixedServer",
        protocol: "http",
        host: "proxy.example",
        port: 8080,
      });
      expect("credentials" in parsed.proxy).toBe(false);
    }
  });

  it("does not propagate impossible public proxy modes or protocols into sidecar drafts", () => {
    const unsupportedMode = createProxyDraftState({
      proxyVersion: 1,
      mode: "pac",
      credentialState: "configured",
      summary: "pac://raw-saved-user:raw-saved-pass@example.invalid",
    } as unknown as ProfileProxySummary);
    const unsupportedProtocol = createProxyDraftState(fixedProxySummary({ protocol: "ftp", credentialState: "raw" }));

    expect(parseProxyDraftState(unsupportedMode)).toMatchObject({
      ok: false,
      errors: { mode: expect.stringMatching(/unsupported/i) },
    });
    expect(unsupportedMode.errors.mode).toMatch(/unsupported/i);
    expect(unsupportedProtocol.protocol).toBe("ftp");
    expect(unsupportedProtocol.credentialMode).toBe("none");
    expect(parseProxyDraftState(unsupportedProtocol)).toMatchObject({
      ok: false,
      errors: { protocol: expect.stringMatching(/protocol/i) },
    });
    expect(unsupportedProtocol.errors.protocol).toMatch(/protocol/i);
    expect(JSON.stringify([unsupportedMode, unsupportedProtocol])).not.toMatch(/raw-saved-user|raw-saved-pass/i);
  });
});
