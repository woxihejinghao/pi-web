import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffLines } from "./DiffHunk.tsx";
import { parseUnifiedDiff, type DiffHunk } from "./diff-parse.ts";
import diffStyles from "./FileDiff.module.css";

/**
 * The rows themselves, not the fold control around them.
 *
 * `DiffHunkView` is mostly a button; the lines are the part three places share —
 * the changes panel, a turn's review tab, and the turn-tail card's hover preview
 * — so what they have to agree on is asserted here, including that one sheet
 * draws all of them. The fold control's chrome is covered by the panel's tests.
 */
const PATCH = "@@ -10,2 +20,2 @@\n-old line\n+new line\n kept\n";

function hunk(): DiffHunk {
  const parsed = parseUnifiedDiff(PATCH);
  const first = parsed.hunks[0];
  if (first === undefined) throw new Error("the fixture patch did not parse into a hunk");
  return first;
}

describe("DiffLines", () => {
  it("numbers each side from the hunk's own range, not from one", () => {
    const html = renderToStaticMarkup(<DiffLines hunk={hunk()} />);

    // The removal is old line 10, the addition new line 20; the context line is
    // both 11 and 21. A renderer that counted from 1 would print neither.
    expect(html).toContain(">10<");
    expect(html).toContain(">20<");
    expect(html).not.toContain(">1<");
    expect(html).toContain(">+</span>");
    expect(html).toContain(">-</span>");
  });

  it("does not draw the hunk header: that line is the fold control's, not a row's", () => {
    expect(renderToStaticMarkup(<DiffLines hunk={hunk()} />)).not.toContain("@@");
  });

  it("draws its rows with the reference's own sheet, on every surface", () => {
    const html = renderToStaticMarkup(<DiffLines hunk={hunk()} />);

    // The row's classes come from `FileDiff.module.css`; whether a long line
    // wraps is the body's attribute to decide (`data-review-wrap`), so a row
    // carries no wrap class of its own.
    expect(html).toContain(diffStyles.line);
    expect(html).toContain(diffStyles.lineAdd);
    expect(html).toContain(diffStyles.lineDel);
    expect(html).toContain(diffStyles.lineContext);
    expect(html).toContain(diffStyles.num);
    expect(html).toContain(diffStyles.marker);
    expect(html).toContain(diffStyles.text);
  });
});
