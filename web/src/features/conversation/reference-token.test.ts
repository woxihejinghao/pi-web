import { describe, expect, it } from "vitest";
import {
  expandReferences,
  REFERENCE_SLOT,
  referenceAtCaret,
  referenceInsertion,
  referenceLabel,
  referenceLabelFor,
  referenceSpans,
  relativeReference,
  withTrailingSlash,
} from "./reference-token.ts";

/** The referenced substrings, which is what a chip ends up covering. */
function tokens(text: string): string[] {
  return referenceSpans(text).map((span) => text.slice(span.start, span.end));
}

describe("referenceSpans", () => {
  it("finds a folder path after whitespace", () => {
    expect(tokens("look in src/lib/ please")).toEqual(["src/lib/"]);
  });

  it("finds one at the very start of the draft", () => {
    expect(tokens("deepseek-harness-master/ is here")).toEqual(["deepseek-harness-master/"]);
  });

  it("finds several, in order", () => {
    expect(tokens("a/ then b/c/")).toEqual(["a/", "b/c/"]);
  });

  it("stops the token before a word that only starts like one", () => {
    expect(tokens("either and/or neither")).toEqual([]);
  });

  it("leaves a URL alone", () => {
    expect(tokens("see https://example.com/ for more")).toEqual([]);
  });

  it("does not start a token inside a quoted word", () => {
    expect(tokens('say "a/ b" now')).toEqual([]);
  });

  it("stops the token at whitespace", () => {
    expect(tokens("run /tmp/probe/ now")).toEqual(["/tmp/probe/"]);
  });

  it("covers the glyph slot a drop wrote in front of the label", () => {
    const drafted = `${REFERENCE_SLOT}alpha/ then`;
    expect(referenceSpans(drafted)).toEqual([
      { start: 0, end: REFERENCE_SLOT.length + "alpha/".length },
    ]);
  });

  it("keeps a slotted reference when the sentence runs into it", () => {
    const drafted = `${REFERENCE_SLOT}alpha/x`;
    expect(referenceSpans(drafted)).toEqual([
      { start: 0, end: REFERENCE_SLOT.length + "alpha/".length },
    ]);
  });

  it("still wants a boundary around a hand-typed one", () => {
    expect(tokens("see alpha/x now")).toEqual([]);
  });
});

describe("referenceInsertion", () => {
  it("writes the glyph slot, the label, and a trailing space", () => {
    expect(referenceInsertion("", 0, 0, "proj")).toEqual({
      text: `${REFERENCE_SLOT}proj/ `,
      caret: REFERENCE_SLOT.length + 5 + 1,
    });
  });

  it("adds the space the token boundary needs", () => {
    expect(referenceInsertion("see", 3, 3, "proj")).toEqual({
      text: `see ${REFERENCE_SLOT}proj/ `,
      caret: 3 + 1 + REFERENCE_SLOT.length + 5 + 1,
    });
  });

  it("does not add a second space when one is already there", () => {
    expect(referenceInsertion("see ", 4, 4, "proj")).toEqual({
      text: `see ${REFERENCE_SLOT}proj/ `,
      caret: 4 + REFERENCE_SLOT.length + 5 + 1,
    });
  });

  it("reuses the whitespace that follows the caret", () => {
    expect(referenceInsertion("see now", 3, 3, "proj")).toEqual({
      text: `see ${REFERENCE_SLOT}proj/ now`,
      caret: 3 + 1 + REFERENCE_SLOT.length + 5,
    });
  });

  it("replaces the selection", () => {
    expect(referenceInsertion("see old/ now", 4, 8, "proj")).toEqual({
      text: `see ${REFERENCE_SLOT}proj/ now`,
      caret: 4 + REFERENCE_SLOT.length + 5,
    });
  });

  it("keeps a path that already ends in a separator", () => {
    expect(referenceInsertion("", 0, 0, "proj/")).toEqual({
      text: `${REFERENCE_SLOT}proj/ `,
      caret: REFERENCE_SLOT.length + 5 + 1,
    });
  });
});

describe("referenceAtCaret", () => {
  // `see ␣alpha/ now`: the chip covers indices 4..12.
  const drafted = `see ${REFERENCE_SLOT}alpha/ now`;
  const span = { start: 4, end: 4 + REFERENCE_SLOT.length + "alpha/".length };

  it("takes the whole chip on Backspace at its end", () => {
    expect(referenceAtCaret(drafted, span.end, "back")).toEqual(span);
  });

  it("takes the whole chip on Backspace from inside it", () => {
    expect(referenceAtCaret(drafted, span.start + 1, "back")).toEqual(span);
  });

  it("leaves a caret in front of the chip to the text in front", () => {
    expect(referenceAtCaret(drafted, span.start, "back")).toBeNull();
  });

  it("takes the whole chip on Delete at its start", () => {
    expect(referenceAtCaret(drafted, span.start, "forward")).toEqual(span);
  });

  it("leaves a caret behind the chip to the text behind", () => {
    expect(referenceAtCaret(drafted, span.end, "forward")).toBeNull();
  });

  it("ignores ordinary text", () => {
    expect(referenceAtCaret("plain words", 5, "back")).toBeNull();
  });
});

describe("withTrailingSlash", () => {
  it("adds the separator a reference needs", () => {
    expect(withTrailingSlash("/tmp/probe/alpha")).toBe("/tmp/probe/alpha/");
    expect(withTrailingSlash("/tmp/probe/alpha/")).toBe("/tmp/probe/alpha/");
  });

  it("keeps a Windows spelling's own separator", () => {
    expect(withTrailingSlash("C:\\dev\\proj")).toBe("C:\\dev\\proj\\");
    expect(withTrailingSlash("C:/dev/proj")).toBe("C:/dev/proj/");
  });
});

describe("referenceLabel", () => {
  const none = new Set<string>();

  it("reads as the folder's own name", () => {
    expect(referenceLabel("/tmp/pw-probe/alpha", none)).toBe("alpha/");
  });

  it("walks outward when the name is taken", () => {
    expect(referenceLabel("/tmp/pw-probe/alpha", new Set(["alpha/"]))).toBe("pw-probe/alpha/");
    expect(referenceLabel("/tmp/pw-probe/alpha", new Set(["alpha/", "pw-probe/alpha/"])))
      .toBe("tmp/pw-probe/alpha/");
  });

  it("falls back to the whole path when nothing shorter is free", () => {
    const taken = new Set(["alpha/", "pw-probe/alpha/", "tmp/pw-probe/alpha/"]);
    expect(referenceLabel("/tmp/pw-probe/alpha", taken)).toBe("/tmp/pw-probe/alpha/");
  });

  it("reads a Windows path the same way", () => {
    expect(referenceLabel("C:\\dev\\proj\\src", none)).toBe("src/");
  });
});

describe("referenceLabelFor", () => {
  it("reuses the spelling the same path already has", () => {
    const references = new Map([["alpha/", "/tmp/pw-probe/alpha/"]]);
    expect(referenceLabelFor("/tmp/pw-probe/alpha/", references, new Set(["alpha/"]))).toBe("alpha/");
  });

  it("mints a new one for a different path", () => {
    const references = new Map([["alpha/", "/tmp/pw-probe/alpha/"]]);
    expect(referenceLabelFor("/tmp/other/alpha/", references, new Set(["alpha/"]))).toBe("other/alpha/");
  });
});

describe("expandReferences", () => {
  const references = new Map([
    ["alpha/", "/tmp/pw-probe/alpha/"],
    ["beta/", "/tmp/other/beta/"],
  ]);

  it("puts every label back as its path", () => {
    expect(expandReferences("see alpha/ and beta/ now", references)).toBe(
      "see /tmp/pw-probe/alpha/ and /tmp/other/beta/ now",
    );
  });

  it("leaves a reference-shaped word alone when no drop minted it", () => {
    expect(expandReferences("look in src/ now", references)).toBe("look in src/ now");
  });

  it("leaves an edited label alone, because it no longer resolves", () => {
    expect(expandReferences("see alpha-two/ now", references)).toBe("see alpha-two/ now");
  });

  it("is the identity when nothing was dropped", () => {
    const text = "look in src/ now";
    expect(expandReferences(text, new Map())).toBe(text);
  });

  it("expands a label at the very start and the very end", () => {
    expect(expandReferences("alpha/", references)).toBe("/tmp/pw-probe/alpha/");
  });

  it("leaves the glyph slot out of what it sends", () => {
    expect(expandReferences(`see ${REFERENCE_SLOT}alpha/ now`, references)).toBe(
      "see /tmp/pw-probe/alpha/ now",
    );
  });

  it("takes a slot with it even when its label no longer resolves", () => {
    expect(expandReferences(`see ${REFERENCE_SLOT}alpha-two/ now`, references)).toBe(
      "see alpha-two/ now",
    );
  });
});

describe("relativeReference", () => {
  it("shortens a path inside the workspace", () => {
    expect(relativeReference("/Users/dev/proj/src/lib", "/Users/dev/proj")).toBe("src/lib");
  });

  it("keeps a path outside it", () => {
    expect(relativeReference("/Users/dev/other", "/Users/dev/proj")).toBe("/Users/dev/other");
  });

  it("keeps the workspace root itself, whose relative spelling is nothing", () => {
    expect(relativeReference("/Users/dev/proj", "/Users/dev/proj")).toBe("/Users/dev/proj");
  });

  it("tolerates a trailing separator on the root", () => {
    expect(relativeReference("/Users/dev/proj/src", "/Users/dev/proj/")).toBe("src");
  });

  it("does not match a sibling that merely shares the prefix", () => {
    expect(relativeReference("/Users/dev/proj-other", "/Users/dev/proj")).toBe("/Users/dev/proj-other");
  });

  it("separates with the platform's own slash", () => {
    expect(relativeReference("C:\\dev\\proj\\src", "C:\\dev\\proj")).toBe("src");
  });

  it("keeps the path when there is no workspace", () => {
    expect(relativeReference("/Users/dev/proj", null)).toBe("/Users/dev/proj");
  });
});
