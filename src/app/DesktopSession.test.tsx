import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DesktopSession } from "./DesktopSession";
const api = vi.hoisted(() => ({ getMachineInfo: vi.fn(), getPreferences: vi.fn(), vaultOperation: vi.fn(), saveInterfacePreferences: vi.fn(), normalizeSidecarError: (e: Error) => ({ message: e.message }) }));
vi.mock("../sidecar/client", () => api);
vi.mock("../sidecarEvents", () => ({ subscribeToSidecarEvent: () => () => {} }));
beforeEach(() => { vi.clearAllMocks(); api.getMachineInfo.mockResolvedValue({ platform: "Linux", architecture: "x86_64", browserVersion: "137.0.0.0" }); api.getPreferences.mockResolvedValue({ theme: "dark" }); document.documentElement.removeAttribute("data-theme"); });
it("restores theme before showing the application", async () => {
 api.vaultOperation.mockResolvedValue({ enabled: false, locked: false, recoveryRequired: false });
 render(<DesktopSession><div>Profile library</div></DesktopSession>);
 expect(screen.queryByText("Profile library")).not.toBeInTheDocument();
 await screen.findByText("Profile library");
 expect(document.documentElement).toHaveAttribute("data-theme", "dark");
});
it("keeps the library unmounted until a successful password unlock", async () => {
 api.vaultOperation.mockResolvedValueOnce({ enabled: true, locked: true, recoveryRequired: true }).mockRejectedValueOnce(new Error("Incorrect password")).mockResolvedValueOnce({ enabled: true, locked: false, recoveryRequired: false });
 render(<DesktopSession><div>Profile library</div></DesktopSession>);
 const input = await screen.findByLabelText("PIN or password");
 fireEvent.change(input, { target: { value: "wrong123" } }); fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
 await screen.findByText("Incorrect password");
 expect(screen.queryByText("Profile library")).not.toBeInTheDocument();
 expect(input).toHaveValue("");
 fireEvent.change(input, { target: { value: "correct123" } }); fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
 await screen.findByText("Profile library");
 expect(api.vaultOperation).toHaveBeenLastCalledWith("unlock", "correct123");
});
