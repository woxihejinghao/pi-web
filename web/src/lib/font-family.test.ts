import { describe, expect, it } from "vitest";
import { commitFontFamily, FONT_FAMILY_MAX_LENGTH, normalizeFontFamily } from "./font-family.ts";
/**
 * The same vectors as `server/src/font-family.test.ts`. The rule is duplicated
 * across the two module graphs, so these tests are what keeps the copies from
 * drifting.
 */
describe("normalizeFontFamily", () => {
  it("treats an empty list as the built-in stack", () => {
    expect(normalizeFontFamily("")).toBe("");
    expect(normalizeFontFamily("   ")).toBe("");
    expect(normalizeFontFamily(" , , ")).toBe("");
  });
  it("quotes family names and leaves generic families bare", () => {
    expect(normalizeFontFamily("Menlo, monospace")).toBe('"Menlo", monospace');
    expect(normalizeFontFamily("PingFang SC, sans-serif")).toBe('"PingFang SC", sans-serif');
  });
  it("keeps system keywords unquoted whatever their case", () => {
    expect(normalizeFontFamily("system-ui, -apple-system, SF Pro Text")).toBe(
      'system-ui, -apple-system, "SF Pro Text"',
    );
    expect(normalizeFontFamily("SANS-SERIF")).toBe("SANS-SERIF");
  });
  it("quotes CJK family names", () => {
    expect(normalizeFontFamily("更纱黑体 SC, 微软雅黑")).toBe('"更纱黑体 SC", "微软雅黑"');
  });
  it("drops quotes, backslashes, markup characters and controls", () => {
    expect(normalizeFontFamily(`a"b'c\\d<e>f`)).toBe('"abcdef"');
    expect(normalizeFontFamily("Menlo\u0000\u001f\u007f")).toBe('"Menlo"');
  });
  it("collapses whitespace and ignores empty entries", () => {
    expect(normalizeFontFamily("  JetBrains   Mono ,, Fira Code ")).toBe(
      '"JetBrains Mono", "Fira Code"',
    );
  });
  it("is a fixed point once normalized", () => {
    const once = normalizeFontFamily("Menlo, PingFang SC, monospace");
    expect(normalizeFontFamily(once)).toBe(once);
  });
  it("does not deduplicate, matching dsh", () => {
    expect(normalizeFontFamily("Menlo, Menlo")).toBe('"Menlo", "Menlo"');
  });
  it("keeps the input cap the settings field enforces", () => {
    expect(FONT_FAMILY_MAX_LENGTH).toBe(200);
  });
});
describe("commitFontFamily", () => {
  it("sends the normalized draft when it differs from the stored value", () => {
    expect(commitFontFamily("Menlo, monospace", "")).toBe('"Menlo", monospace');
  });
  it("sends nothing when the draft already matches", () => {
    expect(commitFontFamily('"Menlo", monospace', '"Menlo", monospace')).toBeNull();
    expect(commitFontFamily("  Menlo , monospace ", '"Menlo", monospace')).toBeNull();
  });
  it("sends the empty string that restores the built-in stack", () => {
    expect(commitFontFamily("   ", '"Menlo", monospace')).toBe("");
  });
});