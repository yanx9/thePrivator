import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CookieBotDialog } from "./CookieBotDialog";
const api = vi.hoisted(() => ({ getCookieBotDefaults: vi.fn(), startCookieBot: vi.fn(), getCookieBotStatus: vi.fn(), cancelCookieBot: vi.fn(), normalizeSidecarError: (e: Error) => e }));
vi.mock("../../sidecar/client", () => api);
const config = { urls: ["https://www.wikipedia.org/"], maxPages: 10, maxDepth: 1, dwellSeconds: 5, maxDurationSeconds: 120, closeAfterCompletion: false };
beforeEach(() => {
  vi.clearAllMocks();
  api.getCookieBotDefaults.mockResolvedValue({ config });
  api.getCookieBotStatus.mockResolvedValue({ job: null });
  api.startCookieBot.mockResolvedValue({ job: { jobId: "job", status: "completed", config, visitedPages: 2, failedPages: 0, errors: [], stopReason: "page-limit" } });
});
it("shows the current navigation and explains bounded DOM waits", async () => {
  api.getCookieBotStatus.mockResolvedValue({ job: { jobId: "job", status: "running", config, currentUrl: "https://example.com/article", visitedPages: 1, failedPages: 0, errors: [], stopReason: null } });
  render(<CookieBotDialog profileId="alpha" profileName="Alpha" onClose={vi.fn()} onRefresh={vi.fn()} onBusyChange={vi.fn()} />);
  await screen.findByRole("button", { name: "Cancel run" });
  expect(screen.getByRole("status")).toHaveTextContent("Current page: https://example.com/article");
  expect(screen.getByText(/Only same-origin/)).toHaveTextContent("up to 10 seconds for the DOM and 2 extra seconds for delayed links");
});
it("restores the actual configuration of an existing running job", async () => {
  api.getCookieBotStatus.mockResolvedValue({ job: { jobId: "job", status: "running", config: { ...config, urls: ["https://example.com/"], closeAfterCompletion: true }, visitedPages: 1, failedPages: 0, errors: [], stopReason: null } });
  render(<CookieBotDialog profileId="alpha" profileName="Alpha" onClose={vi.fn()} onRefresh={vi.fn()} onBusyChange={vi.fn()} />);
  await screen.findByRole("button", { name: "Cancel run" });
  expect(screen.getByLabelText("Links to crawl")).toHaveValue("https://example.com/");
  expect(screen.getByRole("checkbox", { name: /Close profile/ })).toBeChecked();
  expect(screen.getByText(/Default sites:/)).toHaveTextContent("https://www.wikipedia.org/");
});
it.each(["failed", "completed"])("displays asynchronous %s job errors and restores next-run defaults", async (status) => {
  const runningConfig = { ...config, urls: ["https://example.com/"], maxPages: 3, maxDepth: 2, dwellSeconds: 7, maxDurationSeconds: 60, closeAfterCompletion: true };
  const job = { jobId: "job", status: "running", config: runningConfig, visitedPages: 1, failedPages: 0, errors: [], stopReason: null };
  api.getCookieBotStatus.mockResolvedValue({ job });
  render(<CookieBotDialog profileId="alpha" profileName="Alpha" onClose={vi.fn()} onRefresh={vi.fn()} onBusyChange={vi.fn()} />);
  await screen.findByRole("button", { name: "Cancel run" });
  expect(screen.getByText(/Only same-origin/)).toHaveTextContent("depth 2. Browsing is limited to 3 pages and 60 seconds, with 7 seconds per page");
  expect(screen.getByRole("checkbox", { name: /Close profile/ })).toBeChecked();
  api.getCookieBotStatus.mockResolvedValue({ job: { ...job, status, errors: ["Stop the profile and retry.", "Could not close the bot tab."] } });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(new RegExp(`^${status}:`)), { timeout: 2500 });
  expect(screen.getByRole("alert")).toHaveTextContent("Stop the profile and retry.");
  expect(screen.getByRole("alert")).toHaveTextContent("Could not close the bot tab.");
  expect(screen.getByRole("checkbox", { name: /Close profile/ })).not.toBeChecked();
  expect(screen.getByLabelText("Links to crawl")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(api.startCookieBot).toHaveBeenCalledWith("alpha", config));
});
it("uses displayed defaults when empty, prevents duplicate starts, and reports failures", async () => {
  let finish!: (value: unknown) => void;
  api.startCookieBot.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<CookieBotDialog profileId="alpha" profileName="Alpha" onClose={vi.fn()} onRefresh={vi.fn()} onBusyChange={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
  expect(screen.getByText(/Default sites:/)).toHaveTextContent("https://www.wikipedia.org/");
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  fireEvent.click(screen.getByRole("button", { name: "Starting…" }));
  expect(api.startCookieBot).toHaveBeenCalledExactlyOnceWith("alpha", config);
  finish({ job: { jobId: "job", status: "failed", config, visitedPages: 0, failedPages: 1, errors: ["Browser could not start"], stopReason: "failed" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("Browser could not start");
});
it.each(["javascript:alert(1)", "file:///etc/passwd", "https://user:password@example.com"])("rejects unsafe URL %s before starting", async (url) => {
  render(<CookieBotDialog profileId="alpha" profileName="Alpha" onClose={vi.fn()} onRefresh={vi.fn()} onBusyChange={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Links to crawl"), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(api.startCookieBot).not.toHaveBeenCalled();
});
it("focuses the URL field, traps Tab, and cancels with Escape before starting", async () => {
  const close = vi.fn();
  render(<CookieBotDialog profileId="alpha" profileName="Alpha" onClose={close} onRefresh={vi.fn()} onBusyChange={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
  expect(screen.getByLabelText("Links to crawl")).toHaveFocus();
  screen.getByRole("button", { name: "Run" }).focus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(screen.getByLabelText("Links to crawl")).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  expect(api.startCookieBot).not.toHaveBeenCalled();
});
it("polls an active job and cancels it without pretending it stopped", async () => {
  const job = { jobId: "job", status: "running", config, visitedPages: 1, failedPages: 0, errors: [], stopReason: null };
  api.getCookieBotStatus.mockResolvedValue({ job });
  api.cancelCookieBot.mockResolvedValue({ job: { ...job, status: "cancelling" } });
  const busy = vi.fn();
  render(<CookieBotDialog profileId="alpha" profileName="Alpha" onClose={vi.fn()} onRefresh={vi.fn()} onBusyChange={busy} />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
  await waitFor(() => expect(api.cancelCookieBot).toHaveBeenCalledWith("alpha", "job"));
  expect(screen.getByRole("status")).toHaveTextContent("cancelling");
  expect(busy).toHaveBeenCalledWith(true);
  api.getCookieBotStatus.mockResolvedValue({ job: { ...job, status: "cancelled" } });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("cancelled"), { timeout: 2500 });
  expect(busy).toHaveBeenLastCalledWith(false);
});
it("normalizes custom URLs and sends the close and bounded crawl settings", async () => {
  render(<CookieBotDialog profileId="alpha" profileName="Alpha" onClose={vi.fn()} onRefresh={vi.fn()} onBusyChange={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Links to crawl"), { target: { value: "example.com, https://example.org/a\nexample.net" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Close profile/ }));
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(api.startCookieBot).toHaveBeenCalledWith("alpha", { ...config, urls: ["https://example.com/", "https://example.org/a", "https://example.net/"], closeAfterCompletion: true }));
  expect(await screen.findByRole("status")).toHaveTextContent(/2 pages visited/);
});
