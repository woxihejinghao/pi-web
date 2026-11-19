import type { AppearancePreference } from "./types.ts";

/**
 * Appearance is applied as `html[data-appearance="dark"]` rather than a class or
 * a `body` attribute. Two reasons, both load-bearing:
 *
 * 1. The light token sheet defines its values on `body`, so the dark sheet has
 *    to out-specify that same element (`html[data-appearance] body`) instead of
 *    targeting a descendant.
 * 2. The pre-paint script in `index.html` runs before `<body>` exists, so the
 *    attribute has to live on `documentElement`.
 */
const APPEARANCE_CACHE_KEY = "pi-web-simple:appearance";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function matchesDarkScheme(): boolean {
  return typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches;
}

/** `system` resolved against the OS; the other two are literal. */
export function resolveAppearance(preference: AppearancePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  return matchesDarkScheme() ? "dark" : "light";
}

/**
 * Write the appearance and mirror the *preference* (not the resolved colour)
 * into localStorage, so the pre-paint script can keep following the OS while
 * this page is closed.
 */
export function applyAppearance(preference: AppearancePreference): void {
  document.documentElement.dataset.appearance = resolveAppearance(preference);
  try {
    localStorage.setItem(APPEARANCE_CACHE_KEY, preference);
  } catch {
    // Storage disabled (private mode). The next load just flashes the default
    // for a frame before /api/settings reconciles it.
  }
}

/**
 * The conversation-content font size. Written as an inline property on `body`,
 * where dsh's bootstrap script and ThemePresenter write it and where
 * `gradient-shadow-text.css` derives the delta/secondary pair from it. It beats
 * the `:root` fallback without a stylesheet rule per value.
 */
export function applyContentFontSize(px: number): void {
  document.body.style.setProperty("--dsh-content-font-size", `${px}px`);
}
/**
 * Where the two font lists are mirrored for the pre-paint script.
 *
 * The authoritative copy is the server's store file, but reading it over HTTP
 * arrives a frame after the first paint. `index.html` reads this snapshot and
 * sets the same variables on `<html>`, which the body's composite rules
 * inherit; `/api/settings` reconciles the snapshot once it lands.
 */
const FONTS_CACHE_KEY = "pi-web-simple:fonts";
/**
 * The interface and code font lists, as dsh's theme bootstrap writes them.
 *
 * An empty list removes the variable instead of writing `""`: the token sheet
 * then falls back to the built-in stack through its own `var()` chain. The
 * `<html>` copy is dropped at the same time — it is only the pre-paint
 * snapshot, and leaving it behind would make "back to default" look ignored.
 */
export function applyFontFamilies(fonts: { text: string; code: string }): void {
  applyFontFamily("--dsh-font-family-text", fonts.text);
  applyFontFamily("--dsh-font-family-code", fonts.code);
  try {
    localStorage.setItem(FONTS_CACHE_KEY, JSON.stringify(fonts));
  } catch {
    // Storage disabled (private mode). The next load just paints the built-in
    // stacks for a frame before /api/settings reconciles them.
  }
}
function applyFontFamily(variable: string, value: string): void {
  document.documentElement.style.removeProperty(variable);
  if (value === "") document.body.style.removeProperty(variable);
  else document.body.style.setProperty(variable, value);
}

/**
 * Re-apply on OS scheme changes, which is the whole point of `system`. Returns
 * an unsubscribe. The callback owns the decision of whether to act, so a
 * listener firing after the user picked a literal colour cannot fight it.
 */
export function watchSystemAppearance(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  const listener = (): void => onChange();
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
