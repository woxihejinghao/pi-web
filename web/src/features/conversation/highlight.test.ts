import { describe, expect, it, vi } from "vitest";
import { getGrammarVersion, highlight, subscribeLanguages } from "./highlight.ts";

describe("highlight", () => {
  it("highlights an entry-chunk language through the css-variables theme", () => {
    const html = highlight("const answer: number = 42", "typescript");
    expect(html).toContain('class="shiki css-variables"');
    // Colours are theme tokens, not literals: that is what makes the dark
    // token sheet recolour code without re-highlighting it.
    expect(html).toContain("var(--shiki-token-");
  });

  it("resolves dsh's fence aliases to the same grammar", () => {
    const code = "const answer: number = 42";
    const canonical = highlight(code, "typescript");
    expect(highlight(code, "ts")).toBe(canonical);
    expect(highlight(code, "javascript")).toBe(canonical);
    expect(highlight(code, "TS")).toBe(canonical);
  });

  it("highlights shellscript aliases", () => {
    expect(highlight('printf %s "$HOME"', "bash")).toContain("--shiki-token-");
    expect(highlight('printf %s "$HOME"', "sh")).not.toBeNull();
  });

  it("leaves languages outside dsh's table as plain text", () => {
    expect(highlight("--- a/x\n+++ b/x", "diff")).toBeNull();
    expect(highlight("const answer = 42")).toBeNull();
  });

  it("leaves fences past the length cap as plain text", () => {
    expect(highlight("a".repeat(20_001), "json")).toBeNull();
  });

  it("imports a grammar on demand and reports it through the subscription", async () => {
    let notified = 0;
    const unsubscribe = subscribeLanguages(() => {
      notified += 1;
    });
    const before = getGrammarVersion();

    // First sight: the grammar is not here yet, so the fence stays plain text.
    expect(highlight("print(1)", "python")).toBeNull();

    await vi.waitFor(() => expect(getGrammarVersion()).toBe(before + 1));
    expect(notified).toBe(1);
    unsubscribe();
    expect(highlight("print(1)", "python")).toContain('class="shiki css-variables"');
  });
});
