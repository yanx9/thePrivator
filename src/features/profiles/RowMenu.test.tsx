import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RowMenu } from "./RowMenu";
import { buildRowMenu } from "./rowMenuHelpers";
import { makeProfile } from "../../testing/profileFactory";

it("flips a right-edge submenu left and supports keyboard return", () => {
  const close = vi.fn();
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    return { left: 850, right: 1050, top: 20, bottom: 200, width: 200, height: 180, x: 850, y: 20, toJSON() {} };
  });
  render(<RowMenu x={1000} y={10} items={buildRowMenu({ profile: makeProfile(), running: false, trashed: false, selectionSize: 1, runningInSelection: 0 })} onChoose={vi.fn()} onClose={close} />);
  const cookies = screen.getByRole("menuitem", { name: "Cookies" });
  cookies.focus();
  fireEvent.keyDown(cookies, { key: "ArrowRight" });
  expect(screen.getByRole("menu", { name: "Cookies" })).toHaveAttribute("data-side", "left");
  expect(screen.getByRole("menuitem", { name: "Export (JSON)…" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(cookies).toHaveFocus();
  expect(close).not.toHaveBeenCalled();
  rect.mockRestore();
});

it("moves focus into a hover-expanded submenu with ArrowRight", () => {
  render(<RowMenu x={10} y={10} items={buildRowMenu({ profile: makeProfile(), running: false, trashed: false, selectionSize: 1, runningInSelection: 0 })} onChoose={vi.fn()} onClose={vi.fn()} />);
  const cookies = screen.getByRole("menuitem", { name: "Cookies" });
  fireEvent.mouseEnter(cookies);
  expect(cookies).toHaveAttribute("aria-expanded", "true");
  cookies.focus();
  fireEvent.keyDown(cookies, { key: "ArrowRight" });
  expect(screen.getByRole("menuitem", { name: "Export (JSON)…" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(cookies).toHaveFocus();
});

it("opens Cookies on hover or click and dispatches only the chosen child", () => {
  const onChoose = vi.fn();
  render(<RowMenu x={10} y={10} items={buildRowMenu({ profile: makeProfile(), running: false, trashed: false, selectionSize: 1, runningInSelection: 0 })} onChoose={onChoose} onClose={vi.fn()} />);
  const cookies = screen.getByRole("menuitem", { name: "Cookies" });
  expect(screen.queryByRole("menuitem", { name: "Import…" })).not.toBeInTheDocument();
  fireEvent.mouseEnter(cookies);
  expect(screen.getByRole("menuitem", { name: "Import…" })).toBeInTheDocument();
  expect(onChoose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "Export (JSON)…" }));
  expect(onChoose).toHaveBeenCalledWith("cookies-export-json");
  expect(screen.getByRole("menuitem", { name: "Run Cookie Bot…" })).toBeInTheDocument();
});
