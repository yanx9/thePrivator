import { describe, expect, it } from "vitest";
import { createProxyDraftState, parseProxyDraftState } from "./proxyControls";
import { parseProxyClipboard } from "./proxyClipboard";

const base = createProxyDraftState(null);

describe("proxy clipboard parsing", () => {
  it.each([
    "http://alice:secret@proxy.example:8080",
    "alice:secret@proxy.example:8080",
    "proxy.example:8080:alice:secret",
    "http://proxy.example:8080:alice:secret",
    "proxy.example 8080 alice secret",
    "proxy.example\t8080\talice\tsecret",
    "proxy.example,8080,alice,secret",
    "proxy.example;8080;alice;secret",
    "proxy.example|8080|alice|secret",
    '  "http://alice:secret@proxy.example:8080/"\r\n',
  ])("parses %s", (text) => {
    const result = parseProxyClipboard(text, base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parseProxyDraftState(result.draft)).toMatchObject({
      ok: true,
      proxy: { mode: "fixedServer", protocol: "http", host: "proxy.example", port: 8080,
        credentials: { username: "alice", password: "secret" } },
    });
  });

  it.each([
    ["http://proxy.example:80", "http", "80"],
    ["HTTPS://proxy.example:443/", "https", "443"],
    ["socks4://proxy.example:1080", "socks4", "1080"],
    ["socks5://proxy.example:1080", "socks5", "1080"],
    ["proxy.example:1", "http", "1"],
    ["proxy.example 65535", "http", "65535"],
  ])("preserves explicit ports for %s", (text, protocol, port) => {
    expect(parseProxyClipboard(text, base)).toMatchObject({ ok: true, draft: { protocol, port, credentialMode: "none" } });
  });

  it.each([
    "socks5://alice:secret@[2001:db8::42]:1080",
    "[2001:db8::42]:1080:alice:secret",
    "[2001:db8::42] 1080 alice secret",
  ])("supports bracketed IPv6 in %s", (text) => {
    expect(parseProxyClipboard(text, base)).toMatchObject({ ok: true, draft: { host: "2001:db8::42", port: "1080" } });
  });

  it("decodes URL credentials once and preserves literal host-first passwords", () => {
    expect(parseProxyClipboard("https://al%40ice:p%3Aa%40ss%2520@proxy.example:443", base)).toMatchObject({
      ok: true, draft: { credentialUsername: "al@ice", credentialPassword: "p:a@ss%20" },
    });
    expect(parseProxyClipboard("proxy.example:8080:alice:p:a@ss%20", base)).toMatchObject({
      ok: true, draft: { credentialPassword: "p:a@ss%20" },
    });
    expect(parseProxyClipboard("http://proxy.example:8080:alice:123/", base)).toMatchObject({
      ok: true, draft: { credentialPassword: "123/" },
    });
  });

  it("keeps the selected protocol and clears previous credentials when absent", () => {
    const current = { ...base, protocol: "socks5", savedCredentialState: "configured" as const,
      credentialMode: "replace" as const, credentialUsername: "old-user", credentialPassword: "old-pass" };
    expect(parseProxyClipboard("new.example:1080", current)).toMatchObject({
      ok: true, draft: { protocol: "socks5", credentialMode: "clear", credentialUsername: "", credentialPassword: "" },
    });
    expect(current.credentialPassword).toBe("old-pass");
  });

  it.each([
    "", "proxy.example", "http://proxy.example", "ftp://proxy.example:21", "socks5h://proxy.example:1080",
    "proxy.example:0", "proxy.example:65536", "proxy.example:80.5", "proxy.example:abc",
    "proxy.example:80:alice", "proxy.example:80::secret", "proxy.example:80:alice:",
    "http://alice:%ZZ@proxy.example:80", "http://alice:sec%0Aret@proxy.example:80",
    "http://proxy.example:80/path", "http://proxy.example:80?query", "http://proxy.example:80#fragment",
    "[invalid]:80", "[2001:::42]:80", "2001:db8::42:80", "bad_host:80", "-bad:80",
    "one.example:80\ntwo.example:80", "one.example:80 two.example:80", "x".repeat(4097),
  ])("rejects malformed clipboard input #%#", (text) => {
    expect(parseProxyClipboard(text, base)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("does not leak credentials in errors or mutate the current draft", () => {
    const before = structuredClone(base);
    const result = parseProxyClipboard("http://alice:private-secret@proxy.example:99999", base);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/alice|private-secret/);
    expect(base).toEqual(before);
  });
});
