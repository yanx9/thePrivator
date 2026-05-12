import type {
  FixedServerProxyDraft,
  ProfileProxyDraft,
  ProfileProxyMode,
  ProfileProxySummary,
  ProxyCredentialState,
  ProxyProtocol,
} from "./sidecar/types";

export type ProxyCredentialDraftMode = "none" | "saved" | "replace" | "clear";
export type ProxyDraftFieldPath =
  | "mode"
  | "protocol"
  | "host"
  | "port"
  | "credentials"
  | "credentialUsername"
  | "credentialPassword";
export type ProxyDraftFieldErrors = Partial<Record<ProxyDraftFieldPath, string>>;

export interface ProxyProtocolOption {
  value: ProxyProtocol;
  label: string;
  description: string;
}

export interface ProxyDraftState {
  mode: ProfileProxyMode | string;
  protocol: ProxyProtocol | string;
  host: string;
  port: string;
  credentialMode: ProxyCredentialDraftMode;
  savedCredentialState: ProxyCredentialState;
  credentialUsername: string;
  credentialPassword: string;
  errors: ProxyDraftFieldErrors;
}

export type ProxyDraftParseResult =
  | { ok: true; proxy: ProfileProxyDraft; errors: ProxyDraftFieldErrors }
  | { ok: false; errors: ProxyDraftFieldErrors };

export const DEFAULT_PROXY_PROTOCOL: ProxyProtocol = "http";
export const DEFAULT_PROXY_PORT = "8080";

export const FIXED_PROXY_PROTOCOL_OPTIONS: ProxyProtocolOption[] = [
  {
    value: "http",
    label: "HTTP",
    description: "Use one fixed HTTP proxy server.",
  },
  {
    value: "https",
    label: "HTTPS",
    description: "Use one fixed HTTPS proxy server.",
  },
  {
    value: "socks4",
    label: "SOCKS4",
    description: "Use one fixed SOCKS4 proxy server.",
  },
  {
    value: "socks5",
    label: "SOCKS5",
    description: "Use one fixed SOCKS5 proxy server.",
  },
];

const SUPPORTED_PROXY_PROTOCOLS = new Set<ProxyProtocol>(FIXED_PROXY_PROTOCOL_OPTIONS.map((option) => option.value));
const MAX_PROXY_CREDENTIAL_LENGTH = 512;

export function createProxyDraftState(summary: ProfileProxySummary | null | undefined): ProxyDraftState {
  if (!isRecord(summary) || summary.mode === "direct" || typeof summary.mode !== "string") {
    return directDraftState();
  }

  if (summary.mode !== "fixedServer") {
    return {
      ...directDraftState(),
      mode: summary.mode,
      errors: {
        mode: "Saved proxy mode is unsupported; choose Direct or Fixed server before checking or saving.",
      },
    };
  }

  const savedCredentialState = summary.credentialState === "configured" ? "configured" : "none";
  const draft: ProxyDraftState = {
    mode: "fixedServer",
    protocol: typeof summary.protocol === "string" ? summary.protocol : "",
    host: typeof summary.host === "string" ? summary.host : "",
    port: typeof summary.port === "number" && Number.isFinite(summary.port) ? String(summary.port) : "",
    credentialMode: savedCredentialState === "configured" ? "saved" : "none",
    savedCredentialState,
    credentialUsername: "",
    credentialPassword: "",
    errors: {},
  };

  const parsed = parseProxyDraftState(draft);
  const errors: ProxyDraftFieldErrors = parsed.ok ? {} : { ...parsed.errors };
  if (summary.credentialState !== "configured" && summary.credentialState !== "none") {
    errors.credentials = "Saved proxy credential state is unsupported and was reset to no credentials.";
  }
  if (draft.credentialMode === "saved") {
    delete errors.credentials;
  }
  return { ...draft, errors };
}

export function updateProxyDraftMode(draft: ProxyDraftState, mode: ProfileProxyMode | string): ProxyDraftState {
  const next: ProxyDraftState = {
    ...draft,
    mode,
  };

  if (mode === "direct") {
    return refreshProxyDraftErrors({
      ...next,
      credentialMode: "none",
      savedCredentialState: "none",
      credentialUsername: "",
      credentialPassword: "",
    });
  }

  if (mode === "fixedServer" && !next.port) {
    next.port = DEFAULT_PROXY_PORT;
  }
  return refreshProxyDraftErrors(next);
}

export function updateProxyDraftField(
  draft: ProxyDraftState,
  field: Extract<ProxyDraftFieldPath, "protocol" | "host" | "port">,
  value: string,
): ProxyDraftState {
  return refreshProxyDraftErrors({
    ...draft,
    [field]: value,
  });
}

export function updateProxyDraftCredentialMode(
  draft: ProxyDraftState,
  credentialMode: ProxyCredentialDraftMode,
): ProxyDraftState {
  return refreshProxyDraftErrors({
    ...draft,
    credentialMode,
    credentialUsername: credentialMode === "replace" ? draft.credentialUsername : "",
    credentialPassword: credentialMode === "replace" ? draft.credentialPassword : "",
  });
}

export function updateProxyDraftCredentialField(
  draft: ProxyDraftState,
  field: "username" | "password",
  value: string,
): ProxyDraftState {
  const next = field === "username" ? { ...draft, credentialUsername: value } : { ...draft, credentialPassword: value };
  return refreshProxyDraftErrors(next.credentialMode === "replace" ? next : { ...next, credentialMode: "replace" });
}

export function parseProxyDraftState(draft: ProxyDraftState): ProxyDraftParseResult {
  const errors: ProxyDraftFieldErrors = {};

  if (draft.mode === "direct") {
    validateDirectCredentials(draft, errors);
    if (Object.keys(errors).length > 0) {
      return { ok: false, errors };
    }
    return {
      ok: true,
      proxy: { proxyVersion: 1, mode: "direct" },
      errors: {},
    };
  }

  if (draft.mode !== "fixedServer") {
    errors.mode = "Unsupported proxy mode; choose Direct or Fixed server.";
    return { ok: false, errors };
  }

  const protocol = parseProtocol(draft.protocol, errors);
  const host = parseHost(draft.host, errors);
  const port = parsePort(draft.port, errors);
  const credentials = parseCredentials(draft, errors);

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const proxy: FixedServerProxyDraft = {
    proxyVersion: 1,
    mode: "fixedServer",
    protocol,
    host,
    port,
  };
  if (credentials) {
    proxy.credentials = credentials;
  }

  return { ok: true, proxy, errors: {} };
}

export function isSupportedProxyProtocol(value: unknown): value is ProxyProtocol {
  return typeof value === "string" && SUPPORTED_PROXY_PROTOCOLS.has(value as ProxyProtocol);
}

export function formatProxyCredentialMode(mode: ProxyCredentialDraftMode): string {
  if (mode === "saved") {
    return "Saved credentials masked";
  }
  if (mode === "replace") {
    return "Replace credentials";
  }
  if (mode === "clear") {
    return "No credentials / clear saved credentials";
  }
  return "No credentials";
}

function directDraftState(): ProxyDraftState {
  return {
    mode: "direct",
    protocol: DEFAULT_PROXY_PROTOCOL,
    host: "",
    port: DEFAULT_PROXY_PORT,
    credentialMode: "none",
    savedCredentialState: "none",
    credentialUsername: "",
    credentialPassword: "",
    errors: {},
  };
}

function refreshProxyDraftErrors(draft: ProxyDraftState): ProxyDraftState {
  const parsed = parseProxyDraftState(draft);
  return {
    ...draft,
    errors: parsed.errors,
  };
}

function parseProtocol(value: string, errors: ProxyDraftFieldErrors): ProxyProtocol {
  if (isSupportedProxyProtocol(value)) {
    return value;
  }
  errors.protocol = "Proxy protocol must be HTTP, HTTPS, SOCKS4, or SOCKS5.";
  return DEFAULT_PROXY_PROTOCOL;
}

function parseHost(value: string, errors: ProxyDraftFieldErrors): string {
  const host = value.trim();
  if (!host) {
    errors.host = "Proxy host is required.";
    return "";
  }

  if (host !== value || /\s/.test(value)) {
    errors.host = "Proxy host cannot contain whitespace.";
    return host;
  }

  if (containsControlCharacters(host) || /:\/\//.test(host) || /[@\\/?#]/.test(host) || host.startsWith("--") || host.includes("=")) {
    errors.host = "Proxy host must be a host name or IP address, not a URL, path, argv, or userinfo value.";
  }

  return host;
}

function parsePort(value: string, errors: ProxyDraftFieldErrors): number {
  const text = value.trim();
  if (!/^\d+$/.test(text)) {
    errors.port = "Proxy port must be a whole number between 1 and 65535.";
    return 1;
  }

  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    errors.port = "Proxy port must be a whole number between 1 and 65535.";
  }
  return port;
}

function parseCredentials(
  draft: ProxyDraftState,
  errors: ProxyDraftFieldErrors,
): FixedServerProxyDraft["credentials"] | undefined {
  const hasUsername = draft.credentialUsername.length > 0;
  const hasPassword = draft.credentialPassword.length > 0;

  if (draft.credentialMode === "saved") {
    errors.credentials = "Saved proxy credentials are masked; enter replacement credentials or choose no credentials before checking or saving.";
    return undefined;
  }

  if (draft.credentialMode === "none" || draft.credentialMode === "clear") {
    if (hasUsername || hasPassword) {
      errors.credentials = "Credential fields are only valid when replacing proxy credentials.";
    }
    return undefined;
  }

  const usernameBlank = !draft.credentialUsername.trim();
  const passwordBlank = !draft.credentialPassword.trim();
  if (usernameBlank || passwordBlank) {
    errors.credentials = "Replacement proxy username and password are both required.";
    return undefined;
  }
  if (containsControlCharacters(draft.credentialUsername) || containsControlCharacters(draft.credentialPassword)) {
    errors.credentials = "Replacement proxy credentials cannot contain control characters.";
    return undefined;
  }
  if (draft.credentialUsername.length > MAX_PROXY_CREDENTIAL_LENGTH || draft.credentialPassword.length > MAX_PROXY_CREDENTIAL_LENGTH) {
    errors.credentials = `Replacement proxy credentials must be ${MAX_PROXY_CREDENTIAL_LENGTH} characters or fewer.`;
    return undefined;
  }

  return {
    username: draft.credentialUsername,
    password: draft.credentialPassword,
  };
}

function validateDirectCredentials(draft: ProxyDraftState, errors: ProxyDraftFieldErrors): void {
  if (draft.credentialMode === "replace" || draft.credentialMode === "saved" || draft.credentialUsername || draft.credentialPassword) {
    errors.credentials = "Direct proxy mode cannot include proxy credentials.";
  }
}

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
