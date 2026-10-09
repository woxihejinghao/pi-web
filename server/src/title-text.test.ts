import { describe, expect, it } from "vitest";
import { cleanTitleText, clipPreview, clipTitle, fallbackTitle, truncateTitleBytes } from "./title-text.ts";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

describe("cleanTitleText", () => {
  it("strips ANSI colour codes", () => {
    expect(cleanTitleText("\u001B[31mred\u001B[0m title")).toBe("red title");
  });

  it("strips an OSC sequence and its terminator", () => {
    expect(cleanTitleText("\u001B]0;window title\u0007after")).toBe("after");
  });

  it("strips control characters that carry no layout", () => {
    expect(cleanTitleText("a\u0000b\u0007c\u007Fd")).toBe("abcd");
  });

  it("strips directional controls, which could make a title read as something else", () => {
    expect(cleanTitleText("a\u202Eb")).toBe("ab");
  });

  it("collapses every kind of whitespace into single spaces", () => {
    expect(cleanTitleText("  first\n\n  second\ttabbed  ")).toBe("first second tabbed");
  });
});

describe("truncateTitleBytes", () => {
  it("returns the input when it already fits", () => {
    expect(truncateTitleBytes("短", 10)).toBe("短");
  });

  it("cuts on a code point, not a UTF-16 unit", () => {
    // Three CJK characters are nine bytes; a fourth would exceed the budget.
    expect(truncateTitleBytes("中".repeat(10), 10)).toBe("中中中");
  });

  it("never splits a surrogate pair", () => {
    expect(truncateTitleBytes("👍".repeat(5), 7)).toBe("👍");
  });

  it("rejects a budget that is not a positive integer", () => {
    expect(() => truncateTitleBytes("x", 0)).toThrow(/positive integer/);
    expect(() => truncateTitleBytes("x", 1.5)).toThrow(/positive integer/);
  });
});

describe("clipTitle", () => {
  it("cleans and leaves a fitting title alone", () => {
    expect(clipTitle("  \u001B[1mhello\u001B[0m  ", 120)).toBe("hello");
  });

  it("marks a loss with an ellipsis and stays inside the budget", () => {
    const title = clipTitle("x".repeat(500), 120);

    expect(bytes(title)).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("budgets by bytes, so a Chinese title is not longer than an English one", () => {
    const title = clipTitle("中".repeat(100), 120);

    expect(bytes(title)).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("does not leave half an emoji at the cut", () => {
    const title = clipTitle("👍".repeat(100), 120);

    expect(bytes(title)).toBeLessThanOrEqual(120);
    expect(title).not.toContain("\uFFFD");
  });
});

describe("clipPreview", () => {
  it("keeps a short preview whole", () => {
    expect(clipPreview("a\n\nb", 200)).toBe("a b");
  });

  it("counts characters, and says when it cut", () => {
    const preview = clipPreview("x".repeat(500), 200);

    expect([...preview]).toHaveLength(200);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("does not split an emoji at the boundary", () => {
    const preview = clipPreview("👍".repeat(10), 5);

    expect(preview).toBe("👍👍👍👍…");
  });
});

describe("fallbackTitle", () => {
  it("keeps the leading words and marks the cut", () => {
    expect(fallbackTitle("one two three four five", 3, 120)).toBe("one two three…");
  });

  it("leaves a message that fits entirely alone", () => {
    expect(fallbackTitle("one two", 8, 120)).toBe("one two");
  });

  it("cuts on bytes when a single word is longer than the budget", () => {
    const title = fallbackTitle("x".repeat(500), 8, 120);

    expect(bytes(title)).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("cuts Chinese text on bytes, since it has no words to count", () => {
    const title = fallbackTitle("中".repeat(100), 8, 120);

    expect(bytes(title)).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("returns empty for input with nothing readable in it", () => {
    expect(fallbackTitle("  \u001B[0m \n ", 8, 120)).toBe("");
  });

  it("rejects a word budget that is not a positive integer", () => {
    expect(() => fallbackTitle("x", 0, 120)).toThrow(/positive integer/);
  });
});
