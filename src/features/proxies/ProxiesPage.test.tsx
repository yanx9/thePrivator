import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeProfile } from "../../testing/profileFactory";
import { ProxiesPage } from "./ProxiesPage";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const profile = makeProfile({ id: "11111111-1111-1111-1111-111111111111", name: "Research", proxyHost: "proxy.test" });
profile.storage = { profileDir: `profile-store/profiles/${profile.id}`, userDataDir: `profile-store/profiles/${profile.id}/user-data` };
const data = { rows: [{ profile, running: false }], trashed: [], runningCount: 0, loading: false, error: null, refresh: vi.fn() };
it("checks the saved configuration and reports bridge errors", async () => {
  vi.mocked(invoke).mockRejectedValue({ code: "PROXY_FAILED", message: "Proxy unreachable", recoverable: true, detailRef: "diag-1" });
  render(<ProxiesPage data={data} onOpenProfile={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Check saved proxy" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Proxy unreachable");
  expect(invoke).toHaveBeenCalledWith("profiles_proxy_check", { profileId: profile.id });
});
it("blocks changes and checks while a profile is running", () => {
  render(<ProxiesPage data={{ ...data, rows: [{ profile, running: true }] }} onOpenProfile={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Save proxy" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Check saved proxy" })).toBeDisabled();
  expect(screen.getByText(/Stop this profile/)).toBeInTheDocument();
});
beforeEach(() => { vi.mocked(invoke).mockReset(); data.refresh.mockClear(); });
it("edits a selected profile proxy using the bridge and refreshes", async () => {
  vi.mocked(invoke).mockResolvedValue({ requestId: "1", protocolVersion: "1.0.0", durationMs: 1, result: { storeVersion: 4, profiles: [profile], count: 1, profile } });
  render(<ProxiesPage data={data} onOpenProfile={vi.fn()} />);
  expect(screen.getByText("http://proxy.test:8080")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: "new.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Save proxy" }));
  await waitFor(() => expect(data.refresh).toHaveBeenCalled());
  expect(invoke).toHaveBeenCalledWith("profiles_proxy_update", { profileId: profile.id, proxy: { proxyVersion: 1, mode: "fixedServer", protocol: "http", host: "new.test", port: 8080 } });
  expect(screen.getByRole("status")).toHaveTextContent("Proxy saved");
});
