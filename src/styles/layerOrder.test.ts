import { describe, expect, it } from "vitest";

/**
 * Where the cascade layers are declared, and when.
 *
 * A layer's position is fixed the first time its name appears. index.css is the
 * only file that declares the full order, and every CSS module opens with
 * `@layer components` -- so if any module is injected before index.css, the
 * `components` layer is registered first and `base` ends up after it. The reset
 * then wins over every component rule, and the visible result is that buttons
 * across the app render as bare text.
 *
 * This is checked on the entry module's source rather than on a rendered page
 * because jsdom does not implement cascade layers at all.
 */
const entrySource: string = Object.values(
  import.meta.glob("../main.tsx", { query: "?raw", import: "default", eager: true }),
)[0] as string;

const styleSheets: Record<string, string> = import.meta.glob("./*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Import specifiers, in the order the module system will evaluate them. */
function importOrder(source: string): string[] {
  return [...source.matchAll(/^import\s+(?:[^"']*?from\s+)?["']([^"']+)["'];?$/gm)].map((match) => match[1]);
}

const documentShell: string = Object.values(
  import.meta.glob("../../index.html", { query: "?raw", import: "default", eager: true }),
)[0] as string;

describe("cascade layer order", () => {
  it("pins the order in the document, where no bundler decision can move it", () => {
    // The import order below is the other half of this, and it is one refactor
    // away from silently regressing. An inline declaration settles the ranking
    // before any stylesheet can be parsed at all.
    const declaration = documentShell.indexOf("@layer tokens, base, components, utilities;");
    const firstStylesheet = documentShell.search(/<link[^>]+rel=["']stylesheet["']|<script[^>]+src=/);

    expect(declaration, "index.html no longer declares the layer order").toBeGreaterThanOrEqual(0);
    if (firstStylesheet >= 0) {
      expect(declaration).toBeLessThan(firstStylesheet);
    }
  });

  it("imports the stylesheet before anything that carries a CSS module", () => {
    const order = importOrder(entrySource);
    const stylesAt = order.indexOf("./styles/index.css");
    const appAt = order.indexOf("./App");

    expect(stylesAt, "main.tsx no longer imports ./styles/index.css").toBeGreaterThanOrEqual(0);
    expect(appAt, "main.tsx no longer imports ./App").toBeGreaterThanOrEqual(0);
    expect(
      stylesAt < appAt,
      "the stylesheet must be imported before App, or every CSS module registers the components layer first",
    ).toBe(true);
  });

  it("declares the whole order in one statement, before importing the sheets it orders", () => {
    const index = styleSheets["./index.css"];
    expect(index, "src/styles/index.css is gone").toBeDefined();

    const declaration = index.indexOf("@layer tokens, base, components, utilities;");
    const firstImport = index.indexOf("@import");

    expect(declaration, "the layer order statement is missing or reworded").toBeGreaterThanOrEqual(0);
    if (firstImport >= 0) {
      expect(declaration).toBeLessThan(firstImport);
    }
  });

  it("keeps the reset in the base layer, where component rules outrank it", () => {
    // An unlayered reset would beat every layered rule regardless of order.
    const reset = styleSheets["./reset.css"];

    expect(reset).toContain("@layer base {");
    expect(reset.slice(0, reset.indexOf("@layer base {")).trim().replace(/\/\*[\s\S]*?\*\//g, "")).toBe("");
  });
});
