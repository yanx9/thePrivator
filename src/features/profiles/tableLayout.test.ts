import { describe, expect, it } from "vitest";

/**
 * The stylesheet, read as text.
 *
 * jsdom does not lay out CSS, so the only way to hold a layout rule here is to
 * assert on the rule itself. Both checks below encode a bug that shipped: rows
 * whose cells collapsed into one stacked column and rendered on top of each
 * other, forty pixels tall.
 */
const tableCss: string = Object.values(
  import.meta.glob("./ProfileTable.module.css", { query: "?raw", import: "default", eager: true }),
)[0] as string;

/** The stylesheet without its comments, so prose about a rule is not a rule. */
const declarations = tableCss.replace(/\/\*[\s\S]*?\*\//g, "");

function blockFor(selector: string): string {
  const start = tableCss.indexOf(selector);
  if (start === -1) {
    throw new Error(`the stylesheet no longer defines ${selector}`);
  }
  const open = tableCss.indexOf("{", start);
  return tableCss.slice(open, tableCss.indexOf("}", open));
}

describe("profile table layout", () => {
  it("reads the row tracks from the same variable the header does", () => {
    // One variable is what keeps a column width in one place. Two copies drift
    // apart the first time either is edited.
    const rows = blockFor(".headerRow,\n  .row");

    expect(rows).toContain("grid-template-columns: var(--grid-cols)");
  });

  it("never asks a row for subgrid, which content-visibility silently disables", () => {
    /*
     * `content-visibility: auto` applies layout containment, and a contained
     * element cannot be a subgrid: the property computes to `none` and every
     * cell collapses into a single column. The header row has no
     * content-visibility, so it kept working and the two disagreed -- which is
     * exactly how this rendered rows on top of themselves.
     */
    const usesSubgrid = /grid-template-columns:\s*subgrid/.test(declarations);
    const usesContentVisibility = /content-visibility:\s*auto/.test(declarations);

    expect(usesSubgrid && usesContentVisibility, "subgrid and content-visibility cannot both apply to a row").toBe(
      false,
    );
  });

  it("still lets rows skip off-screen work", () => {
    // The fix must not have been "drop the optimisation".
    expect(declarations).toContain("content-visibility: auto");
    expect(declarations).toContain("contain-intrinsic-size");
  });
});
