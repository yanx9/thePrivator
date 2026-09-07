import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { makeProfile } from "../../testing/profileFactory";
import { ProfilesPage } from "./ProfilesPage";
import { ProxyExit } from "./ProxyExit";

it("disables proxy actions when no check callback is available", () => {
 const { rerender } = render(<ProxyExit direct={false} />);
 expect(screen.getByRole("button", { name: "Check proxy" })).toBeDisabled();
 rerender(<ProxyExit direct={false} state={{ status: "error" }} />);
 expect(screen.getByRole("button", { name: "Check failed · Retry" })).toBeDisabled();
 rerender(<ProxyExit direct={false} state={{ status: "done", result: result().result as import("../../sidecar/types").ProxyCheckSnapshot }} />);
 expect(screen.getByRole("button", { name: "203.0.113.9" })).toBeDisabled();
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const id = "11111111-1111-1111-1111-111111111111";
const mockInvoke = vi.mocked(invoke);
beforeEach(() => { mockInvoke.mockReset(); });
function proxyCheckRouteProofDirect(overrides: Record<string, unknown> = {}) {
  return {
    status: "not-run",
    basis: "direct-profile",
    scope: "not-applicable",
    protocol: null,
    credentialState: "none",
    durationMs: 0,
    fixture: null,
    target: null,
    directFallbackDetected: false,
    observationCounts: { proxy: 0, target: 0 },
    ...overrides,
  };
}

function proxyCheckRouteProofProved(overrides: Record<string, unknown> = {}) {
  return {
    status: "proved",
    basis: "sidecar-managed-local-fixture",
    scope: "local-fixture",
    protocol: "http",
    credentialState: "none",
    durationMs: 245.5,
    fixture: { kind: "http", managed: true },
    target: { host: "198.51.100.20", port: 443 },
    directFallbackDetected: false,
    observationCounts: { proxy: 2, target: 1 },
    ...overrides,
  };
}

function proxyCheckIpHidingDirect(overrides: Record<string, unknown> = {}) {
  return {
    status: "not-proven",
    basis: "direct-profile",
    scope: "not-applicable",
    publicExitIpClaimed: false,
    publicExitIp: null,
    publicExitLocation: null,
    localFixtureConclusion: "not-run",
    ...overrides,
  };
}

function proxyCheckIpHidingProved(overrides: Record<string, unknown> = {}) {
  return {
    status: "proved",
    basis: "route-proof-succeeded",
    scope: "local-fixture",
    publicExitIpClaimed: false,
    publicExitIp: null,
    publicExitLocation: null,
    localFixtureConclusion: "direct target IP hidden from the proof target by the managed fixture",
    ...overrides,
  };
}

function proxyCheckWebRtcBaseline(overrides: Record<string, unknown> = {}) {
  return {
    status: "baseline-real",
    basis: "profile-identity-policy",
    mode: "real",
    policy: "real",
    localIpExposure: "real-local-ip-baseline",
    ...overrides,
  };
}

function proxyCheckWebRtcRestricted(overrides: Record<string, unknown> = {}) {
  return {
    status: "restricted",
    basis: "profile-identity-policy",
    mode: "masked",
    policy: "disableNonProxiedUdp",
    localIpExposure: "non-proxied-udp-disabled",
    ...overrides,
  };
}

function proxyCheckPublicCheckers(overrides: Record<string, unknown> = {}) {
  return {
    status: "advisory-only",
    basis: "fixed-https-allowlist",
    networkDependency: "user-driven-external-pages",
    pages: [
      {
        id: "cloudflare-trace",
        label: "Cloudflare trace",
        url: "https://www.cloudflare.com/cdn-cgi/trace",
        surfaces: ["ip"],
        advisory: "External IP guidance only; not used as ThePrivator proof.",
      },
      {
        id: "aws-checkip",
        label: "AWS checkip",
        url: "https://checkip.amazonaws.com/",
        surfaces: ["ip"],
        advisory: "External IP guidance only; not used as ThePrivator proof.",
      },
      {
        id: "webbrowsertools-webrtc",
        label: "WebRTC leak test",
        url: "https://webbrowsertools.com/webrtc-leak-test/",
        surfaces: ["webrtc"],
        advisory: "WebRTC guidance only; compare with the profile policy shown here.",
      },
    ],
    ...overrides,
  };
}


function result(profile = makeProfile({ id, proxyHost: "endpoint.example" }), ip: string | null = "203.0.113.9", countryCode: string | null = "DE") {
 const direct = profile.proxy.mode === "direct";
 return { requestId: "check-1", protocolVersion: "1.0.0", durationMs: 1, result: {
 proxyCheckVersion: 1, profileId: id, proxy: profile.proxy,
 routeProof: direct ? proxyCheckRouteProofDirect() : proxyCheckRouteProofProved(),
 ipHiding: (direct ? proxyCheckIpHidingDirect : proxyCheckIpHidingProved)({ publicExitIpClaimed: ip !== null, publicExitIp: ip, publicExitLocation: ip === null ? null : { country: "Germany", countryCode, region: null, city: null, timezone: null, isp: null } }),
 webRtc: proxyCheckWebRtcBaseline(), publicCheckers: proxyCheckPublicCheckers(),
 }};
}
function mount(profile = makeProfile({ id, name: "Alpha", proxyHost: "endpoint.example" })) {
 const props = { view: "all" as const, folderId: null, search: "", folderNames: new Map<string,string>(), onOpenProfile: vi.fn(), onNewProfile: vi.fn(), data: { rows: [{ profile, running: false }], trashed: [], runningCount: 0, loading: false, error: null, refresh: vi.fn() } };
 return { profile, props, ...render(<ProfilesPage {...props} />) };
}
it("shows a noninteractive restore hint for a trashed fixed-proxy profile", () => {
 const { props, rerender } = mount();
 const profile = makeProfile({ id, name: "Alpha", proxyHost: "endpoint.example", deletedAt: "2026-09-07T00:00:00Z" });
 rerender(<ProfilesPage {...props} view="trash" data={{ ...props.data, rows: [], trashed: [profile] }} />);
 const row = within(screen.getByRole("row", { name: /Select Alpha/ }));
 expect(row.queryByRole("button", { name: "Check proxy" })).not.toBeInTheDocument();
 expect(row.getByText("Restore profile to check proxy").closest("button")).toBeNull();
 expect(mockInvoke).not.toHaveBeenCalled();
});
it("deduplicates pending checks, disables the menu action, and retries errors", async () => {
 let reject!: (error: unknown) => void;
 mockInvoke.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
 mount();
 fireEvent.click(screen.getByRole("button", { name: "Check proxy" }));
 expect(screen.getByRole("button", { name: "Checking proxy…" })).toBeDisabled();
 openMenu();
 expect(screen.getByRole("menuitem", { name: /Checking proxy/ })).toBeDisabled();
 fireEvent.click(screen.getByRole("menuitem", { name: /Checking proxy/ }));
 expect(mockInvoke).toHaveBeenCalledTimes(1);
 await act(async () => reject({ code: "PROXY_CHECK_FAILED", message: "Proxy unreachable", recoverable: true, detailRef: "diag-1" }));
 fireEvent.keyDown(document, { key: "Escape" });
 expect(screen.getByRole("button", { name: "Check failed · Retry" })).toBeInTheDocument();
 mockInvoke.mockResolvedValue(result());
 fireEvent.click(screen.getByRole("button", { name: "Check failed · Retry" }));
 expect(await screen.findByText("203.0.113.9")).toBeInTheDocument();
});
it("preserves checks across polling but invalidates changed proxy configuration and credential revisions", async () => {
 mockInvoke.mockResolvedValue(result());
 const { profile, props, rerender } = mount();
 fireEvent.click(screen.getByRole("button", { name: "Check proxy" }));
 await screen.findByText("203.0.113.9");
 rerender(<ProfilesPage {...props} data={{ ...props.data, rows: [{ profile: structuredClone(profile), running: true }] }} />);
 expect(screen.getByText("203.0.113.9")).toBeInTheDocument();
 const changed = { ...profile, proxy: { ...profile.proxy, port: 9999 } };
 rerender(<ProfilesPage {...props} data={{ ...props.data, rows: [{ profile: changed, running: false }] }} />);
 expect(screen.queryByText("203.0.113.9")).not.toBeInTheDocument();
 expect(screen.getByRole("button", { name: "Check proxy" })).toBeInTheDocument();
 rerender(<ProfilesPage {...props} data={{ ...props.data, rows: [{ profile: { ...profile, sync: { ...profile.sync, revision: 2 } }, running: false }] }} />);
 expect(screen.queryByText("203.0.113.9")).not.toBeInTheDocument();
 expect(mockInvoke).toHaveBeenCalledTimes(1);
});
it("discards an in-flight result after the profile proxy changes", async () => {
 let resolve!: (value: unknown) => void;
 mockInvoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
 const { profile, props, rerender } = mount();
 fireEvent.click(screen.getByRole("button", { name: "Check proxy" }));
 rerender(<ProfilesPage {...props} data={{ ...props.data, rows: [{ profile: { ...profile, updatedAt: "2026-09-07T00:00:00Z" }, running: false }] }} />);
 await act(async () => resolve(result()));
 expect(screen.queryByText("203.0.113.9")).not.toBeInTheDocument();
 expect(screen.getByRole("button", { name: "Check proxy" })).toBeInTheDocument();
});
it("labels direct public IP as no proxy and never mistakes fixture proof for public IP", async () => {
 const profile = makeProfile({ id, name: "Alpha" });
 mockInvoke.mockResolvedValue(result(profile));
 mount(profile);
 expect(screen.getByText(/No proxy · Direct/)).toBeInTheDocument();
 openMenu();
 fireEvent.click(screen.getByRole("menuitem", { name: "Check proxy" }));
 await screen.findByText("203.0.113.9");
 expect(screen.getByText(/No proxy · Direct/)).toBeInTheDocument();
});
it("shows unknown country without inventing a flag and unknown public IP without fixture addresses", async () => {
 const profile = makeProfile({ id, name: "Alpha", proxyHost: "endpoint.example" });
 mockInvoke.mockResolvedValue(result(profile, "203.0.113.9", null));
 mount(profile);
 fireEvent.click(screen.getByRole("button", { name: "Check proxy" }));
 await screen.findByText("203.0.113.9");
 expect(screen.getByRole("img", { name: "Country unknown" })).toBeInTheDocument();
 expect(screen.queryByRole("img", { name: /flag/ })).not.toBeInTheDocument();
 mockInvoke.mockResolvedValue(result(profile, null));
 openMenu();
 fireEvent.click(screen.getByRole("menuitem", { name: "Check proxy" }));
 expect(await screen.findByRole("button", { name: "Exit IP unknown · Retry" })).toBeInTheDocument();
 expect(screen.queryByText("198.51.100.20")).not.toBeInTheDocument();
});

function openMenu() { fireEvent.contextMenu(screen.getByRole("row", { name: /Select Alpha/ })); }
it("checks on demand through IPC and renders the public exit and accessible flag", async () => {
 mockInvoke.mockResolvedValue(result());
 mount();
 expect(screen.queryByText(/endpoint.example/)).not.toBeInTheDocument();
 expect(mockInvoke).not.toHaveBeenCalled();
 expect(screen.getByRole("button", { name: "Check proxy" })).toBeInTheDocument();
 openMenu();
 fireEvent.click(screen.getByRole("menuitem", { name: "Check proxy" }));
 expect(await screen.findByText("203.0.113.9")).toBeInTheDocument();
 expect(screen.getByRole("img", { name: "Germany flag" })).toHaveAttribute("title", "Germany");
 expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("profiles_proxy_check", { profileId: id });
 openMenu();
 expect(screen.getByRole("menuitem", { name: /Cookies/ })).toBeInTheDocument();
 expect(screen.getByRole("menuitem", { name: /Run Cookie Bot/ })).toBeInTheDocument();
});
