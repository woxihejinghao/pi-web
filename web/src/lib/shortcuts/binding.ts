/**
 * The physical-key protocol behind the keyboard shortcuts: what a binding is,
 * how it is written down, and how it is drawn.
 *
 * Nothing here touches the DOM — the listener that reads a `KeyboardEvent`
 * lives in `use-shortcuts.ts`. dsh splits its own layer on exactly this line
 * (pure `binding.ts`, DOM adapter next to it), and the split is what makes the
 * tables testable without a browser.
 *
 * A binding names a *physical* key (`code`, e.g. `KeyB`) rather than the
 * character a layout produces (`key`). This is dsh's rule and worth keeping:
 * on Dvorak or AZERTY the shortcut stays on the same physical key, while
 * matching on `key` would move it wherever the layout put that letter.
 */

/** Operating system of the device receiving input. */
export type ShortcutPlatform = "macos" | "windows" | "linux";

/**
 * Which shell the page is running in.
 *
 * It picks the column of defaults, because a browser already owns several bare
 * `primary` combinations (`⌘P` prints, `⌘T` opens a tab, `⌘⇧B` toggles the
 * bookmarks bar) while the desktop window owns none of them — see the tables in
 * `features/rightbar/shortcuts.ts`.
 */
export type ShortcutRuntime = "desktop" | "web";

/**
 * `primary` is the platform's own modifier — Command on macOS, Control
 * everywhere else. The rest name one physical modifier.
 */
export type ShortcutModifier = "primary" | "control" | "alt" | "shift" | "meta";

/** A modifier that is a key rather than an intention. */
export type PhysicalModifier = Exclude<ShortcutModifier, "primary">;

/** One physical key plus the exact set of modifiers held down with it. */
export interface ShortcutBinding {
  readonly code: string;
  readonly modifiers: readonly ShortcutModifier[];
}

/** A binding with `primary` resolved and the modifiers in canonical order. */
export interface NormalizedBinding {
  readonly code: string;
  readonly modifiers: readonly PhysicalModifier[];
}

/**
 * The keyboard facts a dispatch reads, with the event object stripped off.
 *
 * Keeping this a plain object is what lets a test drive every guard — a held
 * key, a composition, an already-handled keydown — without a DOM.
 */
export interface ShortcutGesture {
  /** `KeyboardEvent.code`: the physical key. */
  readonly code: string;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  /** Held down. Claimed like any other press, but not run again. */
  readonly repeat: boolean;
  /** An input method, an AltGraph pair or a dead key owns this keystroke. */
  readonly composing: boolean;
  /** Something closer to the document already handled it. */
  readonly defaultPrevented: boolean;
}

/**
 * How each named key is written on a keycap.
 *
 * Ported verbatim from dsh's `packages/client/shortcuts/src/binding.ts`, minus
 * the entries for codes this app does not bind — a table entry nobody binds is
 * a claim that some key spells something, which is not worth carrying.
 */
const KEY_NAMES: Readonly<Record<string, string>> = {
  Slash: "/",
  Comma: ",",
  Period: ".",
  Backslash: "\\",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Enter: "Enter",
  Escape: "Esc",
  Space: "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/**
 * Normalized modifier order, and therefore keycap order.
 *
 * Control, alt, shift, meta is not arbitrary: it is the order macOS prints its
 * own modifier glyphs in (⌃⌥⇧⌘), so `primary+alt` comes out `⌥⌘B` — the way a
 * Mac user has seen that shortcut written in every menu they have ever opened.
 * Rendering it as `⌘⌥B` would read as a typo to them. dsh orders it the same
 * way for the same reason.
 */
const MODIFIER_ORDER: readonly PhysicalModifier[] = ["control", "alt", "shift", "meta"];

/** The modifier `primary` stands for on one platform. */
export function primaryModifier(platform: ShortcutPlatform): PhysicalModifier {
  return platform === "macos" ? "meta" : "control";
}

/** Resolve `primary` and put the modifiers in canonical order. */
export function normalizeBinding(
  binding: ShortcutBinding,
  platform: ShortcutPlatform,
): NormalizedBinding {
  const expanded = new Set<PhysicalModifier>(
    binding.modifiers.map((modifier) =>
      modifier === "primary" ? primaryModifier(platform) : modifier,
    ),
  );
  return { code: binding.code, modifiers: MODIFIER_ORDER.filter((item) => expanded.has(item)) };
}

/** A stable index for one normalized binding, for lookup and for tests. */
export function bindingKey(binding: NormalizedBinding): string {
  return [...binding.modifiers, binding.code].join("+");
}

/**
 * Whether one keydown is exactly this binding.
 *
 * *Exactly*: a binding is `⌘⇧B`, and pressing `⌃⌘⇧B` is a different key. dsh
 * matches the same way, and it is why extra modifiers can be used to extend the
 * set later without the existing shortcuts quietly moving under the user.
 */
export function matchesBinding(binding: NormalizedBinding, gesture: ShortcutGesture): boolean {
  if (binding.code !== gesture.code) return false;
  // Both sides are filtered through `MODIFIER_ORDER`, so the two lists compare
  // positionally — no sorting, and no set arithmetic to get wrong.
  const held = MODIFIER_ORDER.filter((modifier) => gesture[modifier]);
  return (
    held.length === binding.modifiers.length &&
    held.every((modifier, index) => modifier === binding.modifiers[index])
  );
}

/**
 * Draw one binding as a single string, for a tooltip.
 *
 * macOS runs the symbols together (`⇧⌘B`), the way every native menu draws
 * them; the named modifiers elsewhere are joined with `+`, which is how they
 * are written there.
 *
 * dsh returns the keycaps as a list with the separators threaded between them,
 * because its settings sheet draws each one as its own little box. Nothing here
 * does, so the list is built and joined in one place instead of being handed
 * out for every caller to join differently.
 */
export function keycapsText(
  binding: NormalizedBinding | null,
  platform: ShortcutPlatform,
): string {
  if (binding === null) return "";
  const key = KEY_NAMES[binding.code] ?? binding.code.replace(/^(?:Key|Digit)/u, "");
  const symbols: Record<PhysicalModifier, string> =
    platform === "macos"
      ? { control: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" }
      : { control: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta" };
  return [...binding.modifiers.map((modifier) => symbols[modifier]), key].join(
    platform === "macos" ? "" : "+",
  );
}
