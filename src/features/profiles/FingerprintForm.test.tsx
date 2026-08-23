import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import {
  IDENTITY_SURFACE_LABELS,
  IDENTITY_SURFACE_ORDER,
  createIdentityDraftState,
  parseIdentityDraftState,
} from "../../identityControls";
import type { ProfileIdentity } from "../../sidecar/types";
import { FingerprintForm } from "./FingerprintForm";

function realIdentity(): ProfileIdentity {
  return {
    identityVersion: 2,
    label: "Real device",
    presetId: null,
    browser: { mode: "real" },
    navigator: { mode: "real" },
    screen: { mode: "real" },
    locale: { mode: "real" },
    canvas: { mode: "real" },
    audio: { mode: "real" },
    webgl: { mode: "real" },
    webrtc: { mode: "real", policy: "real" },
    geolocation: { mode: "real", permission: "prompt" },
    mediaDevices: { mode: "real" },
    ports: { mode: "real" },
  };
}

/**
 * Render, then keep re-rendering with whatever the form hands back.
 *
 * The form is controlled, so without this every interaction after the first
 * would be applied to the original draft and the test would quietly check a
 * one-edit-deep version of the component.
 */
function renderForm(identity: ProfileIdentity = realIdentity()) {
  const onChange = vi.fn();
  let draft = createIdentityDraftState(identity);
  const view = render(<FingerprintForm draft={draft} warnings={[]} onChange={onChange} />);

  const apply = () => {
    draft = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    view.rerender(<FingerprintForm draft={draft} warnings={[]} onChange={onChange} />);
    return draft;
  };

  return { ...view, onChange, apply, current: () => draft };
}

describe("FingerprintForm", () => {
  it("renders every surface the identity module knows about", () => {
    // Adding a surface must show up here without touching this component, which
    // is the whole reason the controls are generated from descriptors.
    renderForm();

    expect(IDENTITY_SURFACE_ORDER).toHaveLength(11);
    for (const surface of IDENTITY_SURFACE_ORDER) {
      expect(
        screen.getByRole("heading", { name: IDENTITY_SURFACE_LABELS[surface] }),
        surface,
      ).toBeInTheDocument();
    }
  });

  it("offers each surface only the modes it actually supports", () => {
    renderForm();

    const geolocation = screen.getByRole("combobox", { name: /geolocation mode/i });
    const options = within(geolocation).getAllByRole("option").map((option) => option.textContent);
    // Geolocation has no masked mode: the sidecar has nothing that could derive
    // a position, so offering it would be offering a mode nothing can produce.
    expect(options.join(" ").toLowerCase()).not.toContain("mask");

    const canvas = screen.getByRole("combobox", { name: /canvas mode/i });
    expect(within(canvas).getAllByRole("option").map((option) => option.textContent)?.join(" ")).toMatch(/noise/i);
  });

  it("shows no fields for a surface reporting the real machine", () => {
    renderForm();

    expect(screen.queryByLabelText("User agent")).not.toBeInTheDocument();
  });

  it("reveals the fields for a mode once it is chosen", () => {
    const { apply } = renderForm();

    fireEvent.change(screen.getByRole("combobox", { name: /browser mode/i }), { target: { value: "custom" } });
    apply();

    expect(screen.getByLabelText("User agent")).toBeInTheDocument();
  });

  it("keeps numeric fields as text so a typo produces a message rather than silence", () => {
    // type=number discards what it cannot parse, so the field would empty itself
    // and the user would never see why their value did not stick.
    const { apply } = renderForm();
    fireEvent.change(screen.getByRole("combobox", { name: /screen mode/i }), { target: { value: "custom" } });
    apply();

    const width = screen.getByLabelText("Screen width");
    expect(width).toHaveAttribute("type", "text");

    fireEvent.change(width, { target: { value: "twelve" } });
    apply();

    expect(screen.getByLabelText("Screen width")).toHaveValue("twelve");
    expect(screen.getByLabelText("Screen width")).toHaveAttribute("aria-invalid", "true");
  });

  it("ties an error to the field that produced it", () => {
    const { apply } = renderForm();
    fireEvent.change(screen.getByRole("combobox", { name: /screen mode/i }), { target: { value: "custom" } });
    apply();
    fireEvent.change(screen.getByLabelText("Screen width"), { target: { value: "0" } });
    apply();

    const field = screen.getByLabelText("Screen width");
    const describedBy = field.getAttribute("aria-describedby") ?? "";
    const messages = describedBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(messages).toMatch(/screen width/i);
  });

  it("edits the identity label without touching a surface", () => {
    const { apply, current } = renderForm();

    fireEvent.change(screen.getByLabelText("Identity label"), { target: { value: "Berlin desktop" } });
    apply();

    expect(current().identity.label).toBe("Berlin desktop");
    expect(current().identity.screen.mode).toBe("real");
  });

  it("produces an identity the parser accepts once the fields are filled in", () => {
    const { apply, current } = renderForm();

    fireEvent.change(screen.getByRole("combobox", { name: /webrtc mode/i }), { target: { value: "custom" } });
    apply();
    fireEvent.change(screen.getByLabelText("WebRTC policy"), { target: { value: "block" } });
    apply();

    const parsed = parseIdentityDraftState(current());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.identity.webrtc).toEqual({ mode: "custom", policy: "block" });
    }
  });

  it("shows a cross-surface warning beside the surface that caused it", () => {
    // An inconsistent mask makes a profile more identifiable, not less, so the
    // warning belongs next to the control rather than in a summary at the end.
    const draft = createIdentityDraftState(realIdentity());
    render(
      <FingerprintForm
        draft={draft}
        warnings={[
          {
            code: "IDENTITY_GEOLOCATION_TIMEZONE_MISMATCH",
            message: "The geolocation does not match the timezone.",
            surface: "geolocation",
            path: "geolocation.latitude",
          },
        ]}
        onChange={vi.fn()}
      />,
    );

    const section = screen.getByRole("heading", { name: "Geolocation" }).closest("section");
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getByRole("status")).toHaveTextContent(/does not match the timezone/i);
  });

  it("keeps a surface it does not render instead of dropping it from the payload", () => {
    // The draft is merged onto its source, so a surface added by a newer build
    // survives a round trip through an older form rather than being erased.
    const identity = { ...realIdentity(), futureSurface: { mode: "real" } } as unknown as ProfileIdentity;
    const { apply, current } = renderForm(identity);

    fireEvent.change(screen.getByLabelText("Identity label"), { target: { value: "Edited" } });
    apply();

    const parsed = parseIdentityDraftState(current());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect((parsed.identity as unknown as Record<string, unknown>).futureSurface).toEqual({ mode: "real" });
    }
  });
});
