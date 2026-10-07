/**
 * Turning one keydown into at most one command.
 *
 * This is dsh's `ShortcutRegistry.dispatch`, minus everything this app does not
 * have: no rebindable preferences, no conflict set, no two-key chords, and no
 * native-menu path. What is kept is the *order* of the checks, because that
 * order is the whole behavior — it decides whether a keystroke is ignored,
 * claimed, or claimed-and-refused.
 */
import { matchesBinding, normalizeBinding, type ShortcutBinding, type ShortcutGesture } from "./binding.ts";
import type { ShortcutEnvironment } from "./environment.ts";

/**
 * One keyboard command a feature owns, together with how to run it.
 *
 * There is no label field. dsh carries one per command because it renders a
 * settings sheet from the same table; here each control already has its own
 * words, and the keycap hint is printed beside them — so a second name would be
 * a second place to keep in step.
 */
export interface ShortcutCommand {
  /** Stable identity. The UI looks a command up by this to print its keys. */
  readonly id: string;
  /** The default in each shell. */
  readonly defaults: Readonly<Record<"desktop" | "web", ShortcutBinding>>;
  /** Do it. Called only when the keydown is not a held-down repeat. */
  readonly run: () => void;
}

/**
 * What owns the keyboard above the page.
 *
 * dsh's selector, verbatim. Its second clause matters here: this app's three
 * popup menus (`+` in the right sidebar, the project actions menu, the branch
 * picker) are `role="menu"` and are mounted only while open, so a menu left
 * open does not silently kill every shortcut. The first clause deliberately
 * wants `aria-modal`: the conversation's question card and the usage popovers
 * are `role="dialog"` too, and both are things the user should be able to press
 * a shortcut *over* — the question card can sit in the transcript for minutes.
 */
export const LAYER_SELECTOR = '[role="dialog"][aria-modal="true"], [role="menu"]';

/**
 * What became of one keydown.
 *
 * `blocked` is not `pass`: the key belongs to this app, it just cannot run
 * here. The caller still cancels the browser's own binding for it, which is
 * what keeps a modal from being the one place where `⌘⌥P` opens Chrome's print
 * dialog — dsh consumes a blocked shortcut for the same reason.
 *
 * `repeat` rides along on a handled key rather than being folded away here,
 * because the two facts are answered by different layers: this one says whose
 * key it is, and the caller is the only one that can decide a held key should
 * be swallowed without being obeyed.
 */
export type ShortcutDispatch =
  | { readonly status: "pass" }
  | { readonly status: "handled"; readonly command: ShortcutCommand; readonly repeat: boolean }
  | { readonly status: "blocked"; readonly command: ShortcutCommand };

export interface DispatchInput {
  readonly commands: readonly ShortcutCommand[];
  readonly environment: ShortcutEnvironment;
  readonly gesture: ShortcutGesture;
  /** A modal or an open menu is up. */
  readonly layerOpen: boolean;
}

/**
 * Resolve a gesture against the command table.
 *
 * The first match in table order wins. Reaching the end of the table is `pass`:
 * this app has no interest in the key, and neither the browser nor the page
 * should be told otherwise.
 */
export function dispatchShortcut(input: DispatchInput): ShortcutDispatch {
  const { gesture } = input;
  // A keydown an input method is mid-way through is not a keystroke, and one
  // something closer to the document already handled is not ours to re-read.
  // AltGraph is in `gesture.composing` for this check's sake: on a layout where
  // AltGr types a character, `Ctrl+Alt+P` *is* that character, and dsh refuses
  // the same combination for the same reason.
  if (gesture.defaultPrevented || gesture.composing) return { status: "pass" };

  const { runtime, platform } = input.environment;
  const command = input.commands.find((candidate) =>
    matchesBinding(normalizeBinding(candidate.defaults[runtime], platform), gesture),
  );
  if (command === undefined) return { status: "pass" };
  if (input.layerOpen) return { status: "blocked", command };
  return { status: "handled", command, repeat: gesture.repeat };
}
