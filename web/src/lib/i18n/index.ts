import type { LanguagePreference } from "../types.ts";
import { MESSAGES, type MessageKey, type UiLanguage } from "./messages.ts";

export { MESSAGES };
export type { MessageKey, UiLanguage };

export type MessageParams = Record<string, string | number>;

/** Look up one message and fill its `{name}` placeholders. */
export type Translate = (key: MessageKey, params?: MessageParams) => string;

/**
 * Resolve a stored preference into a table to render from.
 *
 * `system` is read from the host locale at call time rather than frozen at
 * build time, so first paint on a Chinese machine is Chinese and anything else
 * is English — while an explicit choice in settings always wins. An unknown or
 * missing locale lands on English, which is the language of the code, the
 * repository and the published package.
 */
export function resolveLanguage(preference: LanguagePreference, host?: string): UiLanguage {
  if (preference !== "system") return preference;
  const tag = host ?? (typeof navigator === "undefined" ? "en" : navigator.language);
  return /^zh\b/i.test(tag) ? "zh-CN" : "en";
}

/**
 * Build a `t()` for one language. Unknown placeholders are left verbatim
 * instead of becoming `undefined` in the middle of a sentence — a visible
 * `{name}` is a bug report, a silent "undefined" is a puzzle.
 */
export function translator(language: UiLanguage): Translate {
  const table = MESSAGES[language];
  return (key, params) => {
    const template = table[key];
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  };
}
