import { afterEach, describe, expect, it } from "vitest";

import { suppressNativeContextMenu } from "./nativeContextMenu";

let remove: (() => void) | null = null;

function install() {
  remove = suppressNativeContextMenu();
}

function rightClick(target: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function mount(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild as Element;
}

afterEach(() => {
  remove?.();
  remove = null;
  document.body.innerHTML = "";
});

describe("suppressNativeContextMenu", () => {
  it("stops the webview menu on ordinary chrome", () => {
    // Its Reload entry throws away the whole UI state and reads as a crash.
    install();

    expect(rightClick(mount("<div>a row</div>"))).toBe(true);
  });

  it("leaves text inputs alone, where cut, copy and paste live", () => {
    // A proxy password is pasted far more often than it is typed.
    install();

    expect(rightClick(mount("<input type='text' />"))).toBe(false);
    expect(rightClick(mount("<textarea></textarea>"))).toBe(false);
  });

  it("leaves password fields alone too", () => {
    install();

    expect(rightClick(mount("<input type='password' />"))).toBe(false);
  });

  it("suppresses the menu on a field with nothing to cut or paste into", () => {
    install();

    expect(rightClick(mount("<input type='text' disabled />"))).toBe(true);
    expect(rightClick(mount("<input type='text' readonly />"))).toBe(true);
  });

  it("treats a contenteditable region as editable, including inside it", () => {
    install();
    const region = mount("<div contenteditable='true'><span>text</span></div>");

    expect(rightClick(region)).toBe(false);
    expect(rightClick(region.firstElementChild as Element)).toBe(false);
  });

  it("does not treat contenteditable='false' as editable", () => {
    install();

    expect(rightClick(mount("<div contenteditable='false'>fixed</div>"))).toBe(true);
  });

  it("leaves an app menu free to open on the same click", () => {
    // The app's own row menu is a React handler on the element; it runs before
    // this document listener and both call preventDefault. Suppressing the
    // native menu must not mean suppressing ours.
    install();
    const row = mount("<div>row</div>");
    let opened = false;
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      opened = true;
    });

    expect(rightClick(row)).toBe(true);
    expect(opened).toBe(true);
  });

  it("stops suppressing once removed", () => {
    install();
    const row = mount("<div>row</div>");
    expect(rightClick(row)).toBe(true);

    remove?.();
    remove = null;

    expect(rightClick(row)).toBe(false);
  });
});
