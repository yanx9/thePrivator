import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { makeProfile } from "../../testing/profileFactory";
import { NotePreview } from "./NotePreview";
import { writeToClipboard } from "../../clipboard";

vi.mock("../../clipboard", () => ({ writeToClipboard: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function openNote() {
  const profile = makeProfile();
  profile.organization.notes = "First line\nSecond line";
  render(<NotePreview profile={profile} />);
  fireEvent.mouseEnter(screen.getByRole("button", { name: `Notes for ${profile.name}` }));
  return screen.getByRole("tooltip");
}
describe("NotePreview", () => {
  it("keeps the bubble open after selecting text, until Escape", () => {
    vi.useFakeTimers();
    const tooltip = openNote();
    fireEvent.pointerDown(screen.getByText(/First line/, { selector: "div" }));
    fireEvent.mouseLeave(tooltip);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  it("copies only the complete note, preserving newlines", async () => {
    vi.mocked(writeToClipboard).mockResolvedValue(true);
    openNote();
    fireEvent.click(screen.getByRole("button", { name: "Copy note" }));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    expect(writeToClipboard).toHaveBeenCalledWith("First line\nSecond line");
  });
  it("offers manual selection when clipboard access is unavailable", async () => {
    vi.mocked(writeToClipboard).mockResolvedValue(false);
    openNote();
    fireEvent.click(screen.getByRole("button", { name: "Copy note" }));
    expect(await screen.findByText("Clipboard unavailable. Select text and press Ctrl+C.")).toBeInTheDocument();
  });
});
