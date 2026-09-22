import type { ExtensionUiRequest } from "../../lib/types.ts";

/**
 * Shape of one blocking extension dialog, derived from pi's four dialog
 * methods. pi's `select`/`input`/`editor` carry a plain title plus either
 * options or a text field, so the card's job is to normalise that into rows the
 * user can act on — the layout itself is ported from dsh's question composer.
 */

/** One answerable row: the label the user reads, the value pi receives back. */
export interface QuestionOption {
  /** Sent to pi verbatim; the recommendation suffix is part of the value. */
  value: string;
  /** Display text, with the recommendation suffix stripped. */
  label: string;
  recommended: boolean;
}

/**
 * Split dsh's conventional recommendation suffix from an option label.
 *
 * dsh's `ask_user_question` told the model to append `(Recommended)` to the
 * option it prefers, and its renderer turns that into a badge. Extensions
 * written for pi did not agree on a convention, but the same suffix is the one
 * they borrow, so the same parse applies — and the *value* keeps the suffix
 * because that is the string the extension is matching on.
 */
export function parseRecommendedLabel(raw: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
  if (!suffix.test(raw)) return { label: raw, recommended: false };
  return { label: raw.replace(suffix, ""), recommended: true };
}

/**
 * `confirm` is a two-action question rather than a list: pi answers it with a
 * boolean, so the rows carry our own labels and a token the card maps back.
 */
export const CONFIRM_YES = "yes";
export const CONFIRM_NO = "no";

/** The rows a request renders: its own options, or nothing outside `select`. */
export function questionOptions(request: ExtensionUiRequest): QuestionOption[] {
  if (request.method !== "select") return [];
  const raw = Array.isArray(request.options) ? request.options : [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => ({ value: item, ...parseRecommendedLabel(item) }));
}

/** Whether the request's body is a text field rather than a row list. */
export function isTextRequest(request: ExtensionUiRequest): boolean {
  return request.method === "input" || request.method === "editor";
}

/** Prefilled text: `editor` carries `text` as its prefill, `input` its value. */
export function initialText(request: ExtensionUiRequest): string {
  return typeof request.text === "string" ? request.text : "";
}

/**
 * The wire payload for one decision, or `null` when nothing has been chosen.
 *
 * `select` and `input`/`editor` share the `value` key; `confirm` is the odd one
 * out with a boolean, which is why the choice token is translated here instead
 * of at the call site.
 */
export function answerPayload(
  request: ExtensionUiRequest,
  choice: string | null,
  text: string,
): Record<string, unknown> | null {
  if (request.method === "confirm") {
    if (choice === null) return null;
    return { confirmed: choice === CONFIRM_YES };
  }
  if (request.method === "select") {
    return choice === null ? null : { value: choice };
  }
  return { value: text };
}

/**
 * Whether the card can send an answer yet.
 *
 * `select` needs a row, `input` a non-empty value, and `editor` nothing: the
 * editor is opened to change existing text, so submitting an emptied field
 * ("delete all of it") is a legitimate answer rather than an empty one.
 */
export function canSubmit(
  request: ExtensionUiRequest,
  choice: string | null,
  text: string,
): boolean {
  if (request.method === "select") return choice !== null;
  if (request.method === "input") return text.trim() !== "";
  return true;
}

/** Whole seconds left on pi's own auto-resolve deadline, never negative. */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
