/**
 * Normalize a user-entered font-family list.
 *
 * The same rule as `server/src/font-family.ts` (and dsh's
 * `ui-theme/src/theme-settings.ts` before it): names are comma separated,
 * quotes, backslashes, angle brackets and control characters are dropped, and
 * every non-generic family is double-quoted. The browser normalizes before
 * showing the field and before sending it; the server normalizes again because
 * what it stores later reaches CSS.
 *
 * The two copies exist because the web build and the server do not share a
 * module graph — keep them and their tests in step.
 */
export const FONT_FAMILY_MAX_LENGTH = 200;
/**
 * CSS Fonts generic and system family keywords, which must stay unquoted.
 * Lowercased on insert; the original spelling is preserved in the output.
 */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
]);
export function normalizeFontFamily(value: string): string {
  return value
    .split(",")
    .map((name) =>
      name
        .replace(/["'\\<>\u0000-\u001f\u007f]/gu, "")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .filter((name) => name !== "")
    .map((name) => (GENERIC_FAMILIES.has(name.toLowerCase()) ? name : `"${name}"`))
    .join(", ");
}
/**
 * What a field should send when it loses focus.
 *
 * Returns the normalized draft, or `null` when it already matches the stored
 * value — a blur that changed nothing must not cost a round trip.
 */
export function commitFontFamily(draft: string, saved: string): string | null {
  const normalized = normalizeFontFamily(draft);
  return normalized === saved ? null : normalized;
}