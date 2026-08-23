import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AutomationPage } from "./AutomationPage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

/**
 * A value that must never reach the DOM.
 *
 * The access token is the whole security model of the automation endpoint. If
 * it renders anywhere -- a field, a tooltip, an error message -- a screenshot
 * or a screen share hands someone control of every profile on the machine.
 */
const TOKEN = "tpapi-sentinel-token-should-not-render";

// The automation commands return their result unwrapped: the bridge unwraps the
// envelope for these, unlike the profile commands.
function status(overrides: Record<string, unknown> = {}) {
  return {
    status: "running",
    running: true,
    api: { host: "127.0.0.1", port: 47821, url: "http://127.0.0.1:47821", scope: "loopback" },
    process: { pid: 4242, startedAt: "2026-05-04T18:05:00.000Z" },
    copyAvailable: true,
    lastTransitionAt: "2026-05-04T18:05:00.000Z",
    timings: { readinessDurationMs: 25.5 },
    ...overrides,
  };
}

function stoppedStatus(overrides: Record<string, unknown> = {}) {
  return status({
    status: "stopped",
    running: false,
    api: undefined,
    process: undefined,
    copyAvailable: false,
    lastTransitionAt: "2026-05-04T18:06:00.000Z",
    timings: { stopDurationMs: 40 },
    ...overrides,
  });
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

function installClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("AutomationPage", () => {
  it("says what the endpoint is and that it stays on this machine", async () => {
    respond({ automation_api_status: () => stoppedStatus() });

    render(<AutomationPage />);

    expect(screen.getByRole("heading", { name: "Automation" })).toBeInTheDocument();
    expect(await screen.findByText(/loopback only/i)).toBeInTheDocument();
  });

  it("reports a stopped endpoint without inventing an address", async () => {
    respond({ automation_api_status: () => stoppedStatus() });

    render(<AutomationPage />);

    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText(/available once running/i)).toBeInTheDocument();
  });

  it("shows the loopback address once it is running", async () => {
    respond({ automation_api_status: () => status() });

    render(<AutomationPage />);

    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:47821")).toBeInTheDocument();
  });

  it("starts the endpoint and reflects the new state", async () => {
    let started = false;
    respond({
      automation_api_status: () => (started ? status() : stoppedStatus()),
      automation_api_start: () => {
        started = true;
        return status();
      },
    });

    render(<AutomationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("automation_api_start");
  });

  it("stops it again", async () => {
    respond({
      automation_api_status: () => status(),
      automation_api_stop: () => stoppedStatus(),
    });

    render(<AutomationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

    expect(await screen.findByText("Stopped")).toBeInTheDocument();
  });

  it("offers no token to copy while the endpoint is stopped", async () => {
    respond({ automation_api_status: () => stoppedStatus() });

    render(<AutomationPage />);

    expect(await screen.findByRole("button", { name: /copy access token/i })).toBeDisabled();
  });

  it("puts the token on the clipboard and never on the page", async () => {
    const writeText = installClipboard();
    respond({
      automation_api_status: () => status(),
      automation_api_copy_token: () => ({ token: TOKEN }),
    });

    render(<AutomationPage />);
    fireEvent.click(await screen.findByRole("button", { name: /copy access token/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TOKEN));
    expect(await screen.findByRole("status")).toHaveTextContent(/on the clipboard/i);
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("keeps the token out of the page when the clipboard rejects, quoting it", async () => {
    // A clipboard failure can echo the value it was asked to write. Forwarding
    // that message would put the token on screen through the error path.
    installClipboard(vi.fn().mockRejectedValue(new Error(`clipboard denied writing ${TOKEN}`)));
    respond({
      automation_api_status: () => status(),
      automation_api_copy_token: () => ({ token: TOKEN }),
    });

    render(<AutomationPage />);
    fireEvent.click(await screen.findByRole("button", { name: /copy access token/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/clipboard is unavailable/i));
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.body.textContent).not.toContain("clipboard denied");
  });

  it("keeps the token out of the page when there is no clipboard at all", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    respond({
      automation_api_status: () => status(),
      automation_api_copy_token: () => ({ token: TOKEN }),
    });

    render(<AutomationPage />);
    fireEvent.click(await screen.findByRole("button", { name: /copy access token/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/clipboard is unavailable/i);
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("keeps the token out of the page when the sidecar refuses to hand it over", async () => {
    installClipboard();
    respond({
      automation_api_status: () => status(),
      automation_api_copy_token: () =>
        Promise.reject({
          code: "AUTOMATION_AUTH_INVALID",
          message: `token ${TOKEN} was rejected`,
          recoverable: true,
          detailRef: "diag-1",
        }),
    });

    render(<AutomationPage />);
    fireEvent.click(await screen.findByRole("button", { name: /copy access token/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be copied/i);
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("never renders an Authorization header or a bearer prefix", async () => {
    installClipboard();
    respond({
      automation_api_status: () => status(),
      automation_api_copy_token: () => ({ token: TOKEN }),
    });

    render(<AutomationPage />);
    fireEvent.click(await screen.findByRole("button", { name: /copy access token/i }));

    await screen.findByRole("status");
    expect(document.body.textContent).not.toMatch(/authorization|bearer/i);
  });

  it("reports a failure to start rather than looking idle", async () => {
    respond({
      automation_api_status: () => stoppedStatus(),
      automation_api_start: () =>
        Promise.reject({
          code: "AUTOMATION_API_BIND_FAILED",
          message: "The automation port is already in use.",
          recoverable: true,
          detailRef: "diag-1",
        }),
    });

    render(<AutomationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already in use/i);
  });

  it("surfaces an error the endpoint reported about itself", async () => {
    respond({
      automation_api_status: () =>
        status({
          lastError: {
            code: "AUTOMATION_API_HTTP_ERROR",
            message: "A request was rejected.",
            phase: "serve",
            detailRef: "sidecar-abc",
            at: "2026-05-04T18:07:00.000Z",
          },
        }),
    });

    render(<AutomationPage />);

    expect(await screen.findByRole("status")).toHaveTextContent(/request was rejected/i);
  });
});
