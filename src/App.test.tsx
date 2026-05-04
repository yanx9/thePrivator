import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

function healthEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "bridge-7",
    protocolVersion: "1.0.0",
    durationMs: 3.4,
    result: {
      status: "healthy",
      product: { name: "ThePrivator", version: "2.1.0" },
      sidecar: { version: "0.1.0" },
      protocol: { version: "1.0.0" },
      runtime: { pythonVersion: "3.12.3", implementation: "cpython" },
      platform: { system: "Linux", release: "6.8", machine: "x86_64" },
      build: { mode: "source", frozen: false },
      request: { durationMs: 1.2 },
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe("ThePrivator sidecar health UI", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("renders live health, build, runtime, request, and protocol fields", async () => {
    mockInvoke.mockResolvedValueOnce(healthEnvelope());

    render(<App />);

    expect(screen.getByRole("heading", { name: /theprivator rewrite spine/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/current sidecar phase/i)).toHaveTextContent(/healthy/i));
    expect(screen.getByLabelText(/health region/i)).toHaveTextContent(/ThePrivator 2\.1\.0/i);
    expect(screen.getByLabelText(/health region/i)).toHaveTextContent(/0\.1\.0/i);
    expect(screen.getByLabelText(/health region/i)).toHaveTextContent(/cpython 3\.12\.3/i);
    expect(screen.getByLabelText(/build region/i)).toHaveTextContent(/source mode/i);
    expect(screen.getByLabelText(/build region/i)).toHaveTextContent(/Linux · 6\.8 · x86_64/i);
    expect(screen.getByLabelText(/^Status region$/i)).toHaveTextContent(/bridge-7/i);
    expect(screen.getByLabelText(/^Status region$/i)).toHaveTextContent(/healthy/i);
    expect(mockInvoke).toHaveBeenCalledWith("sidecar_health");
  });

  it("shows a busy loading state and prevents duplicate sidecar requests", async () => {
    const health = deferred<unknown>();
    mockInvoke.mockReturnValueOnce(health.promise);

    render(<App />);

    expect(screen.getByLabelText(/current sidecar phase/i)).toHaveTextContent(/loading/i);
    expect(screen.getByRole("button", { name: /refreshing/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /trigger diagnostic error/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /refreshing/i }));
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      health.resolve(healthEnvelope());
      await health.promise;
    });

    await waitFor(() => expect(screen.getByLabelText(/current sidecar phase/i)).toHaveTextContent(/healthy/i));
  });

  it("renders bridge rejections as a retryable sidecar unavailable card", async () => {
    mockInvoke.mockRejectedValueOnce({
      code: "SIDECAR_UNAVAILABLE",
      message: "The Python sidecar binary is unavailable. Run npm run sidecar:build and retry.",
      recoverable: true,
      detailRef: "bridge-detail-ref",
    });

    render(<App />);

    await waitFor(() =>
      expect(screen.getByLabelText(/recoverable error region/i)).toHaveTextContent(/SIDECAR_UNAVAILABLE/i),
    );
    const errorRegion = screen.getByLabelText(/recoverable error region/i);
    expect(errorRegion).toHaveTextContent(/SIDECAR_UNAVAILABLE/i);
    expect(errorRegion).toHaveTextContent(/bridge-detail-ref/i);
    expect(errorRegion).toHaveTextContent(/Recoverable/i);
    expect(errorRegion).toHaveTextContent(/yes/i);
    expect(screen.getByRole("button", { name: /retry health/i })).toBeEnabled();
  });

  it("renders the deliberate diagnostic sidecar error without success styling", async () => {
    mockInvoke
      .mockResolvedValueOnce(healthEnvelope())
      .mockRejectedValueOnce({
        code: "DIAGNOSTIC_FAILURE",
        message: "Diagnostic failure requested.",
        recoverable: true,
        detailRef: "sidecar-detail-ref",
      });

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText(/current sidecar phase/i)).toHaveTextContent(/healthy/i));
    fireEvent.click(screen.getByRole("button", { name: /trigger diagnostic error/i }));

    await waitFor(() => expect(screen.getByLabelText(/current sidecar phase/i)).toHaveTextContent(/recoverable-error/i));
    const errorRegion = screen.getByLabelText(/recoverable error region/i);
    expect(errorRegion).toHaveTextContent(/DIAGNOSTIC_FAILURE/i);
    expect(errorRegion).toHaveTextContent(/Diagnostic failure requested/i);
    expect(errorRegion).toHaveTextContent(/sidecar-detail-ref/i);
    expect(screen.getByLabelText(/current sidecar phase/i)).toHaveTextContent(/recoverable-error/i);
    expect(mockInvoke).toHaveBeenLastCalledWith("sidecar_diagnostic_failure");
  });

  it("supports retry after a bridge failure", async () => {
    mockInvoke
      .mockRejectedValueOnce({
        code: "SIDECAR_TIMEOUT",
        message: "The Python sidecar did not respond before the bridge timeout.",
        recoverable: true,
        detailRef: "timeout-detail-ref",
      })
      .mockResolvedValueOnce(healthEnvelope({ requestId: "bridge-8" }));

    render(<App />);

    await waitFor(() =>
      expect(screen.getByLabelText(/recoverable error region/i)).toHaveTextContent(/SIDECAR_TIMEOUT/i),
    );
    fireEvent.click(screen.getByRole("button", { name: /retry health/i }));

    await waitFor(() => expect(screen.getByLabelText(/^Status region$/i)).toHaveTextContent(/bridge-8/i));
    expect(screen.getByLabelText(/current sidecar phase/i)).toHaveTextContent(/healthy/i);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("maps malformed invoke success to an actionable protocol error card", async () => {
    mockInvoke.mockResolvedValueOnce(healthEnvelope({ result: { status: "healthy" } }));

    render(<App />);

    expect(await screen.findByText(/Protocol response needs attention/i)).toBeInTheDocument();
    const errorRegion = screen.getByLabelText(/recoverable error region/i);
    expect(errorRegion).toHaveTextContent(/SIDECAR_PROTOCOL_ERROR/i);
    expect(errorRegion).toHaveTextContent(/detailRef/i);
    expect(screen.getByLabelText(/current sidecar phase/i)).toHaveTextContent(/bridge-error/i);
  });

  it("renders empty optional build strings without blank UI crashes", async () => {
    mockInvoke.mockResolvedValueOnce(
      healthEnvelope({
        result: {
          status: "healthy",
          product: { name: "ThePrivator", version: "" },
          sidecar: { version: "0.1.0" },
          protocol: { version: "1.0.0" },
          runtime: { pythonVersion: "3.12.3", implementation: "cpython" },
          platform: { system: "Linux", release: "", machine: "x86_64" },
          build: { mode: "", frozen: false },
        },
      }),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText(/current sidecar phase/i)).toHaveTextContent(/healthy/i));
    expect(screen.getByLabelText(/health region/i)).toHaveTextContent(/ThePrivator Unavailable/i);
    expect(screen.getByLabelText(/build region/i)).toHaveTextContent(/Unavailable mode/i);
    expect(screen.getByLabelText(/build region/i)).toHaveTextContent(/Linux · Unavailable · x86_64/i);
  });
});
