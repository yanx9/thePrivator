import {
  DEFAULT_PROXY_PROTOCOL,
  isSupportedProxyProtocol,
  parseProxyDraftState,
  type ProxyDraftState,
} from "./proxyControls";

export type ProxyClipboardResult =
  | { ok: true; draft: ProxyDraftState }
  | { ok: false; error: string };

const FORMAT_ERROR = "Enter one proxy as protocol://user:pass@host:port, host:port:user:pass, or host:port.";

/** Parse locally; errors must never include clipboard text or credentials. */
export function parseProxyClipboard(text: string, current: ProxyDraftState): ProxyClipboardResult {
  if (text.length > 4096) return { ok: false, error: FORMAT_ERROR };
  let value = text.trim();
  if (!value || /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    return { ok: false, error: FORMAT_ERROR };
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }

  let protocol = isSupportedProxyProtocol(current.protocol) ? current.protocol : DEFAULT_PROXY_PROTOCOL;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme) {
    const explicitProtocol = scheme[1].toLowerCase();
    if (!isSupportedProxyProtocol(explicitProtocol)) {
      return { ok: false, error: "Proxy protocol must be HTTP, HTTPS, SOCKS4, or SOCKS5." };
    }
    protocol = explicitProtocol;
    value = value.slice(scheme[0].length);
    // A copied URL may have a root slash. Do not discard paths or query strings.
    if (/^(?:.*@)?(?:\[[^\]]+\]|[^:@/]+):\d+\/$/.test(value)) value = value.slice(0, -1);
  }

  let host = "";
  let port = "";
  let username = "";
  let password = "";
  let hasCredentials = false;
  // Host-first colon syntax takes precedence so @ and : in its password stay literal.
  const hostFirst = /^(\[[^\]]+\]|[^\s:@,;|/\\?#]+):(\d+)(?::([^:]*):(.*))?$/.exec(value);
  if (hostFirst) {
    [, host, port] = hostFirst;
    hasCredentials = hostFirst[3] !== undefined;
    username = hostFirst[3] ?? "";
    password = hostFirst[4] ?? "";
  } else if (value.includes("@")) {
    const at = value.lastIndexOf("@");
    const credentials = value.slice(0, at);
    const endpoint = /^(\[[^\]]+\]|[^\s:@/\\?#]+):(\d+)$/.exec(value.slice(at + 1));
    const colon = credentials.indexOf(":");
    if (!endpoint || colon < 0) return { ok: false, error: FORMAT_ERROR };
    [, host, port] = endpoint;
    hasCredentials = true;
    try {
      username = decodeURIComponent(credentials.slice(0, colon));
      password = decodeURIComponent(credentials.slice(colon + 1));
    } catch {
      return { ok: false, error: "Proxy credentials contain invalid percent encoding." };
    }
  } else {
    // Common provider exports: host port [user pass], using tabs, spaces, commas, semicolons or pipes.
    const separator = ["\t", ",", ";", "|"].find((candidate) => value.includes(candidate));
    const fields = separator ? value.split(separator).map((field) => field.trim()) : value.split(/ +/);
    if (fields.length !== 2 && fields.length !== 4) return { ok: false, error: FORMAT_ERROR };
    [host, port] = fields;
    hasCredentials = fields.length === 4;
    username = fields[2] ?? "";
    password = fields[3] ?? "";
  }

  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
    try {
      // URL is used only to validate IPv6; parsing it otherwise loses explicit default ports.
      if (!host.includes(":") || new URL(`http://[${host}]/`).hostname === "") {
        return { ok: false, error: "Proxy host must be a valid host name or IP address." };
      }
    } catch {
      return { ok: false, error: "Proxy host must be a valid IPv6 address inside brackets." };
    }
  } else if (!host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    return { ok: false, error: "Proxy host must be a valid host name or IP address. Put IPv6 addresses in brackets." };
  }
  if (host.length > 253) return { ok: false, error: "Proxy host is too long." };

  const draft: ProxyDraftState = {
    ...current,
    mode: "fixedServer",
    protocol,
    host,
    port,
    credentialMode: hasCredentials ? "replace" : current.savedCredentialState === "configured" ? "clear" : "none",
    credentialUsername: username,
    credentialPassword: password,
    errors: {},
  };
  const parsed = parseProxyDraftState(draft);
  if (!parsed.ok) return { ok: false, error: Object.values(parsed.errors)[0] ?? FORMAT_ERROR };
  return { ok: true, draft };
}
