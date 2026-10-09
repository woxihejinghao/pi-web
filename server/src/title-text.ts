/**
 * Title text rules: terminal-safe cleaning, byte-budgeted clipping, and the
 * deterministic fallback derived from a first message.
 *
 * Pure, and deliberately free of any import: the read path (`sessions.ts`) and
 * the write path (`session-title.ts`) both need these rules, and neither
 * should drag the other's dependencies along.
 *
 * The escape/control patterns are dsh's `session-title/src/normalize.ts`, ported
 * as-is — including the directional controls, which exist so a title cannot
 * display as something other than what it says.
 */

/** Operating-system-command escapes, including an unterminated tail. */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu;
/** Control-sequence-introducer escapes, such as SGR colour codes. */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = /\u001B[@-_]/gu;
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
/** Directional and invisible controls that can make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

const ELLIPSIS = "…";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, "utf8");

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

/**
 * One trimmed, whitespace-collapsed line with no terminal control left in it.
 *
 * A session's name and its first message are both free text: the first can be
 * pasted from a terminal, the second usually is. What lands in the sidebar has
 * to be one readable line, whatever arrived.
 */
export function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESC_SEQUENCE, "")
    .replace(CONTROL_CHARACTER, "")
    .replace(DIRECTIONAL_CONTROL, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * The longest leading code-point prefix within a UTF-8 byte budget.
 *
 * Code points rather than UTF-16 units: half a surrogate pair renders as a
 * replacement character, which looks like the data was corrupt.
 */
export function truncateTitleBytes(input: string, maxBytes: number): string {
  assertPositiveInteger("maxBytes", maxBytes);
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let used = 0;
  let output = "";
  for (const character of input) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

/**
 * Clean a title, then clip it to a byte budget, marking a loss with `…`.
 *
 * Bytes rather than characters, following dsh: the budget has to mean the same
 * thing for a Chinese title and an English one, and a character count does not.
 */
export function clipTitle(input: string, maxBytes: number): string {
  const text = cleanTitleText(input);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const room = maxBytes - ELLIPSIS_BYTES;
  if (room <= 0) return truncateTitleBytes(text, maxBytes);
  return `${truncateTitleBytes(text, room).trimEnd()}${ELLIPSIS}`;
}

/**
 * Clean and clip a preview to a character budget, marking a loss with `…`.
 *
 * Characters, unlike the title's bytes: a preview is prose the reader scans,
 * and "200 characters" is the unit a reader would guess at. Code points again,
 * so an emoji at the boundary cannot be split.
 */
export function clipPreview(input: string, maxCharacters: number): string {
  const text = cleanTitleText(input);
  const characters = [...text];
  if (characters.length <= maxCharacters) return text;
  return `${characters.slice(0, maxCharacters - 1).join("").trimEnd()}${ELLIPSIS}`;
}

/**
 * The deterministic title for a session that has no name: the leading words of
 * its first human message.
 *
 * Both budgets are dsh's `fallbackSessionTitle`, and both are needed — a word
 * cap says nothing about Chinese text, which has no spaces to count, and a byte
 * cap alone would cut an English sentence mid-word for no reason.
 */
export function fallbackTitle(input: string, maxWords: number, maxBytes: number): string {
  assertPositiveInteger("maxWords", maxWords);
  const words = cleanTitleText(input).split(" ").filter(Boolean);
  const kept = words.slice(0, maxWords).join(" ");
  const title = clipTitle(kept, maxBytes);
  // A word cut that left the byte budget room to spare still has to say it was
  // cut; `clipTitle` only marks what *it* removed.
  return title === kept && words.length > maxWords ? `${title}${ELLIPSIS}` : title;
}
