import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { AuditPageList, ProfileTools, ProxyCheckSummary } from "./ProfileTools";
import type { ProxyCheckResult } from "../../sidecar/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const dialogs = vi.hoisted(() => ({
  pickDirectory: vi.fn(),
  pickFile: vi.fn(),
  pickSaveTarget: vi.fn(),
}));
vi.mock("../../dialogs", () => dialogs);

const mockInvoke = vi.mocked(invoke);

const PROFILE = "11111111-1111-1111-1111-111111111111";

function envelope(result: unknown) {
  return { requestId: "bridge-1", protocolVersion: "1.0.0", durationMs: 1, result };
}

function respond(handlers: Record<string, () => unknown>) {
  mockInvoke.mockImplementation((command: string) => {
    const handler = handlers[command];
    if (handler === undefined) {
      return Promise.reject(new Error(`unexpected command: ${command}`));
    }
    return Promise.resolve(handler()) as ReturnType<typeof invoke>;
  });
}

beforeEach(() => {
  mockInvoke.mockReset();
  dialogs.pickFile.mockReset();
  dialogs.pickSaveTarget.mockReset();
});

describe("ProfileTools", () => {
  it("describes the shared browser JSON import and export format", () => {
    render(<ProfileTools profileId={PROFILE} running={false} />);
    expect(screen.getByText(/JSON import and export use the same cookie array/i)).toHaveTextContent(/expirationDate.*storeId/i);
  });
  it("says the tools need a saved profile before offering them", () => {
    // A create form has no profile directory to export or check yet.
    render(<ProfileTools profileId={null} running={false} />);

    expect(screen.getByText(/save this one first/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export as package/i })).not.toBeInTheDocument();
  });

  it("explains why the browser has to be stopped", () => {
    render(<ProfileTools profileId={PROFILE} running={false} />);

    expect(screen.getByText(/copying a profile mid-write produces one that will not open/i)).toBeInTheDocument();
  });

  it("blocks the portability tools while the browser is running, and says so", () => {
    render(<ProfileTools profileId={PROFILE} running />);

    expect(screen.getByRole("button", { name: /export as package/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /import cookies/i })).toBeDisabled();
    expect(screen.getByText(/stop this profile's browser to use these/i)).toBeInTheDocument();
  });

  it("still allows a proxy check while the browser is running", () => {
    // The check needs a browser to check through, so a running one is fine.
    render(<ProfileTools profileId={PROFILE} running />);

    expect(screen.getByRole("button", { name: /check the proxy/i })).toBeEnabled();
  });

  it("exports a package and repeats that the password did not travel", async () => {
    dialogs.pickSaveTarget.mockResolvedValue("/home/someone/Banking.tpkg");
    respond({
      profile_package_export: () =>
        envelope({
          packageVersion: 3,
          format: "theprivator.profile-package",
          operation: "export",
          profileId: PROFILE,
          profileName: "Banking",
          cookieCount: 3,
          skippedCookieCount: 0,
          payloadFileCount: 12,
          payloadByteCount: 4096,
          warningCount: 0,
          warnings: [],
        }),
    });

    render(<ProfileTools profileId={PROFILE} running={false} />);
    fireEvent.click(screen.getByRole("button", { name: /export as package/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/proxy passwords were left out/i);
    expect(mockInvoke).toHaveBeenCalledWith("profile_package_export", {
      profileId: PROFILE,
      destinationPath: "/home/someone/Banking.tpkg",
    });
  });

  it("does nothing when the save dialog is cancelled", async () => {
    dialogs.pickSaveTarget.mockResolvedValue(null);
    respond({});

    render(<ProfileTools profileId={PROFILE} running={false} />);
    fireEvent.click(screen.getByRole("button", { name: /export as package/i }));

    await waitFor(() => expect(dialogs.pickSaveTarget).toHaveBeenCalled());
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("offers only the browser JSON export format", () => {
    render(<ProfileTools profileId={PROFILE} running={false} />);

    expect(screen.getByRole("button", { name: /export cookies \(json\)/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export cookies \(cookies\.txt\)/i })).not.toBeInTheDocument();
  });

  it("calls them cookies, which is what the user is looking for", () => {
    // They were labelled "sessions", which is accurate and unfindable: someone
    // hunting for cookie import walks straight past it.
    render(<ProfileTools profileId={PROFILE} running={false} />);

    expect(screen.getByRole("button", { name: "Import cookies…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sessions/i })).not.toBeInTheDocument();
  });

  it("warns up front that importing replaces rather than merges", () => {
    render(<ProfileTools profileId={PROFILE} running={false} />);

    expect(screen.getByText(/does not merge them/i)).toBeInTheDocument();
  });

  it("warns when a cookie export could not represent everything", async () => {
    // Encrypted values may be unavailable even for JSON exports.
    dialogs.pickSaveTarget.mockResolvedValue("/home/someone/cookies.json");
    respond({
      profile_cookies_export: () =>
        envelope({
          portabilityVersion: 1,
          profileId: PROFILE,
          operation: "export",
          format: "theprivator-json",
          exportedCount: 8,
          skippedCount: 2,
          warningCount: 1,
          warnings: [
            {
              code: "COOKIE_VALUE_UNAVAILABLE",
              message: "Some stored cookies could not be exported because their values were unavailable to the sidecar.",
              count: 2,
            },
          ],
        }),
    });

    render(<ProfileTools profileId={PROFILE} running={false} />);
    fireEvent.click(screen.getByRole("button", { name: /export cookies \(json\)/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/2 could not be represented/i);
  });

  it("says plainly that importing cookies discards the ones already there", async () => {
    dialogs.pickFile.mockResolvedValue("/home/someone/cookies.json");
    respond({
      profile_cookies_replace: () =>
        envelope({
          portabilityVersion: 1,
          profileId: PROFILE,
          operation: "replace",
          format: "theprivator-json",
          importedCount: 5,
          replacedCount: 5,
          skippedCount: 0,
          warningCount: 0,
          warnings: [],
        }),
    });

    render(<ProfileTools profileId={PROFILE} running={false} />);
    fireEvent.click(screen.getByRole("button", { name: /import cookies/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/the old ones are gone/i);
  });

  it("reports a refused export rather than looking like nothing happened", async () => {
    dialogs.pickSaveTarget.mockResolvedValue("/home/someone/Banking.tpkg");
    respond({
      profile_package_export: () =>
        Promise.reject({
          code: "PORTABILITY_PROFILE_BUSY",
          message: "Stop the profile before exporting it.",
          recoverable: true,
          detailRef: "sidecar-0a1b2c3d4e5f",
        }),
    });

    render(<ProfileTools profileId={PROFILE} running={false} />);
    fireEvent.click(screen.getByRole("button", { name: /export as package/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/stop the profile before exporting/i);
  });

  it("cannot collect results before there is a plan", () => {
    render(<ProfileTools profileId={PROFILE} running={false} />);

    expect(screen.getByRole("button", { name: /collect results/i })).toBeDisabled();
  });

  it("sends the proxy check for this profile", async () => {
    respond({
      profiles_proxy_check: () =>
        Promise.reject({
          code: "PROXY_CHECK_FAILED",
          message: "The proxy did not answer.",
          recoverable: true,
          detailRef: "sidecar-0a1b2c3d4e5f",
        }),
    });

    render(<ProfileTools profileId={PROFILE} running={false} />);
    fireEvent.click(screen.getByRole("button", { name: /check the proxy/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/did not answer/i);
    expect(mockInvoke).toHaveBeenCalledWith("profiles_proxy_check", { profileId: PROFILE });
  });
});

describe("ProxyCheckSummary", () => {
  function result(overrides: Partial<ProxyCheckResult> = {}): ProxyCheckResult {
    return {
      proxyCheckVersion: 1 as const,
      profileId: PROFILE,
      proxy: {
        proxyVersion: 1,
        mode: "direct",
        credentialState: "none",
        summary: "Direct connection",
      } as ProxyCheckResult["proxy"],
      routeProof: {
        status: "not-run" as const,
        basis: "direct-profile" as const,
        scope: "not-applicable" as const,
        protocol: null,
        credentialState: "none" as const,
        durationMs: 0,
        fixture: null,
        target: null,
        directFallbackDetected: false as const,
        observationCounts: { proxy: 0, target: 0 },
      },
      ipHiding: {
        status: "not-proven" as const,
        basis: "direct-profile" as const,
        scope: "not-applicable" as const,
        publicExitIpClaimed: false,
        publicExitIp: null,
        publicExitLocation: null,
        localFixtureConclusion: "not-run" as const,
      },
      webRtc: {
        status: "baseline-real" as const,
        basis: "profile-identity-policy" as const,
        mode: "real" as const,
        policy: "real" as const,
        localIpExposure: "real-local-ip-baseline" as const,
      },
      publicCheckers: {
        status: "advisory-only" as const,
        basis: "fixed-https-allowlist" as const,
        networkDependency: "user-driven-external-pages" as const,
        pages: [],
      },
      ...overrides,
    };
  }

  it("says an unproven exit address was not established, rather than leaving it blank", () => {
    // A blank cell reads as "fine". "Not established" is the truth: nothing was
    // proven about where this profile's traffic comes out.
    render(<ProxyCheckSummary result={result()} />);

    const facts = screen.getByLabelText(/proxy check result/i);
    expect(within(facts).getByText("not established")).toBeInTheDocument();
  });

  it("reports what the route proof concluded without upgrading it", () => {
    render(<ProxyCheckSummary result={result()} />);

    expect(within(screen.getByLabelText(/proxy check result/i)).getByText("not-run")).toBeInTheDocument();
  });

  it("shows a proven exit address when there is one", () => {
    render(
      <ProxyCheckSummary
        result={result({
          ipHiding: {
            status: "proved",
            basis: "route-proof-succeeded",
            scope: "local-fixture",
            publicExitIpClaimed: true,
            publicExitIp: "203.0.113.7",
            publicExitLocation: null,
            localFixtureConclusion: "direct target IP hidden from the proof target by the managed fixture",
          },
        })}
      />,
    );

    expect(screen.getByText("203.0.113.7")).toBeInTheDocument();
  });
});

describe("AuditPageList", () => {
  const pages = [
    {
      id: "canvas",
      label: "Canvas",
      category: "browserleaks" as const,
      url: "https://example.test/canvas",
      surfaces: ["canvas" as const],
      comparisonNote: "Compare the canvas hash between runs.",
      requiresUserAction: false,
      expectedRows: [],
    },
    {
      id: "geo",
      label: "Geolocation",
      category: "browserleaks" as const,
      url: "https://example.test/geo",
      surfaces: ["geolocation" as const],
      comparisonNote: "Allow the permission prompt to see the reported position.",
      requiresUserAction: true,
      expectedRows: [],
    },
  ];

  it("gives every page a way to open it, including the manual ones", () => {
    // A "needs user action" row with nothing to press tells someone that
    // something is required of them and then gives them no way to do it.
    render(<AuditPageList pages={pages} disabled={false} onOpen={vi.fn()} />);

    const rows = within(screen.getByRole("list", { name: /audit pages/i })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(within(row).getByRole("button")).toBeEnabled();
    }
  });

  it("says which pages need finishing by hand", () => {
    render(<AuditPageList pages={pages} disabled={false} onOpen={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /finish by hand/i })).toBeInTheDocument();
  });

  it("opens the page that was clicked", () => {
    const onOpen = vi.fn();
    render(<AuditPageList pages={pages} disabled={false} onOpen={onOpen} />);

    fireEvent.click(screen.getByRole("button", { name: /finish by hand/i }));

    expect(onOpen).toHaveBeenCalledWith("geo");
  });

  it("disables every button while something else is running", () => {
    render(<AuditPageList pages={pages} disabled onOpen={vi.fn()} />);

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });
});
