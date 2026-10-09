import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DraftMirror } from "./DraftMirror.tsx";
import { REFERENCE_SLOT } from "./reference-token.ts";

const html = (text: string): string => renderToStaticMarkup(<DraftMirror text={text} />);

/** The markup's text, which is what the user reads under the textarea. */
const text = (markup: string): string =>
  markup
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

describe("DraftMirror", () => {
  it("paints a folder reference as a chip", () => {
    const markup = html("see /tmp/probe/ now");
    expect(markup).toContain("reference");
    expect(text(markup)).toBe("see /tmp/probe/ now");
  });

  it("leaves prose alone", () => {
    const markup = html("either and/or neither");
    expect(markup).not.toContain("reference");
    expect(text(markup)).toBe("either and/or neither");
  });

  it("paints every reference in the draft", () => {
    const markup = html("a src/ b lib/ c");
    expect(markup.match(/class="[^"]*reference[^"]*"/g) ?? []).toHaveLength(4);
  });

  it("renders an empty draft as nothing", () => {
    expect(html("")).toBe('<div aria-hidden="true"></div>');
  });

  it("marks a dropped reference with the slot its glyph is drawn in", () => {
    expect(html(`${REFERENCE_SLOT}alpha/ then`)).toContain("data-slot");
  });

  it("leaves a hand-typed reference without a glyph slot", () => {
    expect(html("see alpha/ then")).not.toContain("data-slot");
  });
});
