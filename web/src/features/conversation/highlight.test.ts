import { describe, expect, it, vi } from "vitest";
import {
  getGrammarVersion,
  highlight,
  highlightStep,
  lookupHighlight,
  rememberHighlight,
  subscribeLanguages,
  type HighlightCarry,
} from "./highlight.ts";

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

  it("leaves a from-scratch fence past the length cap as plain text", () => {
    // The cap bounds a *whole-fence* tokenize; a fence that can be continued
    // from a frozen prefix never pays that, and is not capped.
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

/**
 * A streamed fence arrives one character at a time, so the incremental path has
 * to land on exactly the markup a single pass over the whole thing produces —
 * every span it renders differently is a colour the reader would see change
 * once the answer settles.
 */
describe("incremental highlighting", () => {
  /** Grow `code` one character at a time through `highlightStep`. */
  function stream(code: string, lang: string): { html: string | null; carry: HighlightCarry | null } {
    let carry: HighlightCarry | null = null;
    let html: string | null = null;
    for (let end = 1; end <= code.length; end += 1) {
      const step = highlightStep(carry, code.slice(0, end), lang);
      expect(step, `prefix of length ${String(end)}`).not.toBeNull();
      carry = step?.carry ?? null;
      html = step?.html ?? null;
    }
    return { html, carry };
  }

  it("reaches the same markup as a full pass, one character at a time", () => {
    const code = [
      "// a leading comment",
      "export function greet(name: string): string {",
      "  return `hello ${name}`;",
      "}",
      "",
      "/* a block comment",
      "   that spans lines */",
      "const n = 42;",
    ].join("\n");

    const full = highlight(code, "typescript");
    expect(full).not.toBeNull();
    expect(stream(code, "typescript").html).toBe(full);
  });

  it("matches a full pass for the shapes a stream actually produces", () => {
    // Unclosed constructs are the interesting case: the frozen prefix can end
    // inside a block comment or a template literal, and the grammar state
    // carried across that boundary is the whole reason the tail's colours can
    // be right while the fence is still incomplete.
    const samples = [
      "const s = `one\ntwo\nthree`;\nconst y = 2;",
      "/* open\nstill open\n*/\nconst x = 1;",
      "function f() {\n  return 1;\n}\n",
      "a\n\nb",
      "const unterminated = `still going\n",
    ];
    for (const code of samples) {
      expect(stream(code, "typescript").html, code).toBe(highlight(code, "typescript"));
    }
  });

  it("freezes only the complete lines, never the one being written", () => {
    const first = highlightStep(null, "const a = 1;\nconst b = 2;", "typescript");
    expect(first?.carry?.head).toBe("const a = 1;\n");

    // The same text again continues from that prefix instead of restarting.
    const again = highlightStep(first?.carry ?? null, "const a = 1;\nconst b = 2;", "typescript");
    expect(again?.html).toBe(first?.html);
    expect(again?.carry?.head).toBe("const a = 1;\n");
  });

  it("starts over when the carry belongs to other text", () => {
    // A carry is only ever a hint: a different grammar drops it, and so does a
    // fence that no longer starts with its prefix.
    const seed = highlightStep(null, "const a = 1;\n", "typescript");
    const other = highlightStep(seed?.carry ?? null, "SELECT 1", "json");
    expect(other?.html).toBe(highlight("SELECT 1", "json"));

    const rewound = highlightStep(seed?.carry ?? null, "const a = 2;\n", "typescript");
    expect(rewound?.html).toBe(highlight("const a = 2;\n", "typescript"));
  });

  it("streams past the length cap once a prefix is frozen", () => {
    // The long fence below can only be reached by growing through the stream,
    // and that is the case the cap must not punish: the tokens up to the last
    // newline are already done, and only the new remainder is tokenized.
    const first = `${"a".repeat(100)}\n`;
    // 210 short lines: past the whole-fence cap in total, but every line is
    // well under the per-line one, so each is tokenized normally.
    const rest = `${"b".repeat(95)}c\n`.repeat(210);
    const seed = highlightStep(null, first, "typescript");
    expect(seed?.carry).not.toBeNull();
    const grown = highlightStep(seed?.carry ?? null, first + rest, "typescript");
    expect(grown?.html).toContain('class="shiki css-variables"');
  });

  it("does not tokenize a pathological single line", () => {
    // A 19 000-character line, kept under the whole-fence cap so this exercises
    // the per-line guard alone: 52 seconds of tokenizing without it, long enough
    // that this test would time out. The fence still renders; that one line just
    // comes out uncoloured.
    const html = highlight(`${"b".repeat(19_000)}\n`, "typescript");
    expect(html).toContain('class="shiki css-variables"');
  });

  it("hands a rendered fence back on a remount", () => {
    // Folding a compact group unmounts every code block inside it, so the only
    // way to avoid re-tokenizing them all is a memo keyed by grammar + source.
    const html = highlight("const a = 1;", "typescript");
    expect(html).not.toBeNull();
    rememberHighlight("const a = 1;", "typescript", html ?? "");
    expect(lookupHighlight("const a = 1;", "typescript")).toBe(html);
    // Keyed by grammar too: the same text under another language is not a hit,
    // and a fence with no known grammar is never stored.
    expect(lookupHighlight("const a = 1;", "json")).toBeUndefined();
    expect(lookupHighlight("const a = 1;")).toBeUndefined();
  });
});
