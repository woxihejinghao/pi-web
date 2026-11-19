/**
 * Normalize a user-entered font-family list.
 *
 * Adapted from deepseek-harness (`packages/client/ui-theme/src/theme-settings.ts`)
 * so a value means here what it means in dsh's settings page: names are comma
 * separated, quotes, backslashes, angle brackets and control characters are
 * dropped, and every non-generic family is double-quoted. The result is a valid
 * CSS value that is safe to hand to `style.setProperty`; an empty string means
 * "use the built-in stack".
 *
 * `web/src/lib/font-family.ts` holds the same rule for the browser, which
 * normalizes before showing the field. Keep the two implementations and their
 * tests in step — they are duplicated because the server and the web build do
 * not share a module graph.
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
/**
 * Coerce one list into CSS's font-family syntax.
 *
 * Not idempotent in the strict sense of rejecting repetition: like dsh, a name
 * mentioned twice stays twice, because a repeated fallback is inert and the
 * user's list is otherwise theirs to arrange.
 */
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