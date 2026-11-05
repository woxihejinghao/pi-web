import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DraftMirror } from "./DraftMirror.tsx";
import type { SlashCommand } from "../../lib/types.ts";
import { fileToken, REFERENCE_SLOT } from "./reference-token.ts";

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

  const commands: SlashCommand[] = [
    { name: "skill:git-commit", source: "skill" },
    { name: "help", source: "builtin" },
  ];
  const skillHtml = (value: string, available = commands): string =>
    renderToStaticMarkup(<DraftMirror text={value} commands={available} />);

  it("highlights a registered skill typed or selected into the draft", () => {
    for (const value of ["/skill:git-commit", "/skill:git-commit ", "  /skill:git-commit fix it"]) {
      const markup = skillHtml(value);
      expect(markup).toMatch(/class="[^"]*skill[^"]*">\/skill:git-commit<\/span>/);
      expect(text(markup)).toBe(value);
    }
  });

  it("does not highlight partial, unknown, unavailable or merely mentioned skills", () => {
    for (const value of ["/skill:git", "/skill:missing", "/skill:git-commit-extra", "see /skill:git-commit", "/skill:git-commit/file", "/help"]) {
      expect(skillHtml(value)).not.toMatch(/class="[^"]*skill/);
    }
    expect(skillHtml("/skill:git-commit", [])).not.toMatch(/class="[^"]*skill/);
  });

  it("keeps file references and all draft characters alongside a skill", () => {
    const value = `/skill:git-commit check ${REFERENCE_SLOT}${fileToken("api.ts")} and src/\n`;
    const markup = skillHtml(value);
    expect(markup).toMatch(/class="[^"]*skill/);
    expect(markup).toContain("data-file");
    expect(markup).toContain("reference");
    expect(text(markup)).toBe(value);
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

  it("marks a file chip, which wears a different glyph than a folder's", () => {
    expect(html(`${REFERENCE_SLOT}${fileToken("api.ts")} then`)).toContain("data-file");
    expect(html(`${REFERENCE_SLOT}src/ then`)).not.toContain("data-file");
  });
});
