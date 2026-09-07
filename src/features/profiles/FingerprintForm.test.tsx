import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

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

const generatedUa = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
function pendingUserAgent() {
  let resolve!: (response: unknown) => void;
  let reject!: (error: Error) => void;
  const fetch = vi.fn().mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  vi.stubGlobal("fetch", fetch);
  return {
    fetch, reject: (error: Error) => reject(error),
    resolve: () => resolve({ ok: true, json: async () => ({ data: [{ userAgent: generatedUa, browser: "chrome", browserVersion: "135.0.0.0", os: "linux", device: "desktop" }] }) }),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("FingerprintForm", () => {
  it("retains generated presets and manual edits after refresh failure and supports retry", async () => {
    const request = pendingUserAgent();
    const base: ProfileIdentity = { ...realIdentity(), label: "Ubuntu Linux Chrome 120", presetId: "ubuntu-linux-chrome-120", browser: { mode: "masked", userAgent: generatedUa } };
    const onChange = vi.fn();
    const onApplyPreset = vi.fn();
    const draft = createIdentityDraftState(realIdentity());
    const view = render(<FingerprintForm draft={draft} warnings={[]} presets={[base]} onChange={onChange} onApplyPreset={onApplyPreset} />);
    const button = screen.getByRole("button", { name: "Odśwież presety" });
    fireEvent.click(button);
    await act(async () => request.resolve());
    fireEvent.click(button);
    fireEvent.change(screen.getByLabelText("Identity label"), { target: { value: "Manual edit" } });
    view.rerender(<FingerprintForm draft={onChange.mock.calls[0][0]} warnings={[]} presets={[base]} onChange={onChange} onApplyPreset={onApplyPreset} />);
    await act(async () => request.reject(new Error("untrusted response")));
    expect(screen.getByRole("alert")).toHaveTextContent(/previous presets and draft unchanged/i);
    expect(screen.queryByText(/untrusted response/)).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ubuntu Linux Chrome 135 (API)" })).toBeInTheDocument();
    expect(screen.getByLabelText("Identity label")).toHaveValue("Manual edit");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await act(async () => request.resolve());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cancels preset generation on unmount and never applies it implicitly", async () => {
    const request = pendingUserAgent();
    const base: ProfileIdentity = { ...realIdentity(), label: "Linux Chrome 120", presetId: "linux", browser: { mode: "masked", userAgent: generatedUa } };
    const onChange = vi.fn();
    const view = render(<FingerprintForm draft={createIdentityDraftState(realIdentity())} warnings={[]} presets={[base]} onChange={onChange} onApplyPreset={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Odśwież presety" }));
    const signal = request.fetch.mock.calls[0][1].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => request.resolve());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("refreshes the preset list then applies a complete generated preset only to the draft", async () => {
    const request = pendingUserAgent();
    const base: ProfileIdentity = { ...realIdentity(), label: "Ubuntu Linux Chrome 120", presetId: "ubuntu-linux-chrome-120", browser: { mode: "masked", userAgent: generatedUa.replace("135.", "120.") }, screen: { mode: "masked", width: 1920, height: 1080, viewportWidth: 1920, viewportHeight: 1032, colorDepth: 24, pixelRatio: 1 } };
    const onChange = vi.fn();
    const onApplyPreset = vi.fn();
    render(<FingerprintForm draft={createIdentityDraftState(realIdentity())} warnings={[]} presets={[base]} onChange={onChange} onApplyPreset={onApplyPreset} />);
    const button = screen.getByRole("button", { name: "Odśwież presety" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    await act(async () => request.resolve());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "Ubuntu Linux Chrome 135 (API)" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Start from a preset"), { target: { value: "api:0" } });
    expect(onApplyPreset).not.toHaveBeenCalled();
    const parsed = parseIdentityDraftState(onChange.mock.calls[0][0]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.identity.screen).toEqual(base.screen);
      expect(parsed.identity.browser).toMatchObject({ ...base.browser, userAgent: generatedUa });
      expect(parsed.identity.presetId).toBeNull();
    }
  });

  it.each(["real", "masked"] as const)("does not offer refresh in %s browser mode", (mode) => {
    const identity = realIdentity();
    identity.browser = mode === "real" ? { mode } : { mode, userAgent: "Existing UA" };
    renderForm(identity);
    expect(screen.queryByRole("button", { name: "Odśwież" })).not.toBeInTheDocument();
  });

  it("preserves the draft on failure, hides provider error details and allows retry", async () => {
    const request = pendingUserAgent();
    const identity = realIdentity();
    identity.browser = { mode: "custom", userAgent: "Keep this UA" };
    const { onChange } = renderForm(identity);
    const button = screen.getByRole("button", { name: "Odśwież" });
    fireEvent.click(button);
    await act(async () => request.reject(new Error("<script>untrusted provider detail</script>")));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("User agent")).toHaveValue("Keep this UA");
    expect(screen.getByRole("alert")).toHaveTextContent(/could not.*randomapi.dev.*unchanged/i);
    expect(screen.queryByText(/untrusted provider detail/)).not.toBeInTheDocument();
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await act(async () => request.resolve());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["User agent", "Identity label", "Client hints platform"])("aborts and ignores stale results after editing %s", async (label) => {
    const request = pendingUserAgent();
    const identity = realIdentity();
    identity.browser = { mode: "custom", userAgent: "Original UA" };
    const { apply, onChange } = renderForm(identity);
    fireEvent.click(screen.getByRole("button", { name: "Odśwież" }));
    const signal = request.fetch.mock.calls[0][1].signal;
    fireEvent.change(screen.getByLabelText(label), { target: { value: "Manual edit" } });
    apply();
    expect(signal.aborted).toBe(true);
    await act(async () => request.resolve());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(label)).toHaveValue("Manual edit");
    expect(screen.getByRole("button", { name: "Odśwież" })).not.toBeDisabled();
  });

  it.each(["mode", "profile", "unmount"])("aborts requests on %s changes without writing to a stale draft", async (change) => {
    const request = pendingUserAgent();
    const identity = realIdentity();
    identity.browser = { mode: "custom", userAgent: "Original UA" };
    const { apply, onChange, rerender, unmount } = renderForm(identity);
    fireEvent.click(screen.getByRole("button", { name: "Odśwież" }));
    const signal = request.fetch.mock.calls[0][1].signal;
    if (change === "mode") {
      fireEvent.change(screen.getByRole("combobox", { name: /browser mode/i }), { target: { value: "real" } });
      apply();
      onChange.mockClear();
    } else if (change === "profile") {
      const other = createIdentityDraftState({ ...identity, label: "Other profile" });
      rerender(<FingerprintForm draft={other} warnings={[]} onChange={onChange} />);
    } else unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => request.resolve());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("refreshes only the UA draft field with an adjacent Polish button and explains the connection", async () => {
    const request = pendingUserAgent();
    const identity = realIdentity();
    identity.browser = { mode: "custom", userAgent: "Old UA", clientHints: { platform: "Linux", platformVersion: "12.0.0" } };
    const { current, onChange, apply } = renderForm(identity);
    const before = current();
    const button = screen.getByRole("button", { name: "Odśwież" });
    expect(button.parentElement).toContainElement(screen.getByLabelText("User agent"));
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAccessibleDescription(/randomapi.dev.*direct.*not.*profile proxy/i);
    expect(screen.getByText(/OS filter.*no profile cookies or configuration/i)).toBeInTheDocument();
    expect(screen.getByText(/unknown.*Linux/i)).toBeInTheDocument();
    expect(screen.getByText(/version.*UA-CH/i)).toBeInTheDocument();
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(request.fetch).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => request.resolve());
    expect(onChange).toHaveBeenCalledTimes(1);
    apply();
    expect(current()).toEqual({ ...before, identity: { ...before.identity, browser: { ...before.identity.browser, userAgent: generatedUa } }, values: { ...before.values, "browser.userAgent": generatedUa } });
    expect(screen.getByLabelText("User agent")).toHaveValue(generatedUa);
    expect(screen.getByRole("status")).toHaveTextContent(/draft.*save/i);
    expect(button).not.toBeDisabled();
  });
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
