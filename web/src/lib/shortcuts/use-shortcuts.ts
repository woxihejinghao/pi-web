/**
 * The browser adapter for the keyboard shortcuts: one listener, and the React
 * hook that installs it.
 *
 * Everything that decides *whether* a keystroke counts lives in `dispatch.ts`;
 * this file's whole job is to turn a `KeyboardEvent` into the plain facts that
 * file reads, and to hand the decision back as `preventDefault` plus a call.
 */
import { useEffect } from "react";
import type { ShortcutGesture } from "./binding.ts";
import { dispatchShortcut, LAYER_SELECTOR, type ShortcutCommand } from "./dispatch.ts";
import { environment } from "./environment.ts";

/** A keydown, as the plain object the dispatch consumes. */
function gestureOf(event: KeyboardEvent): ShortcutGesture {
  return {
    code: event.code,
    control: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    repeat: event.repeat,
    // `isComposing` is what most engines report for an IME; AltGraph is how a
    // Windows layout reports the AltGr key, where `Ctrl+Alt+…` is a character
    // rather than a chord; a dead key is a keystroke waiting for its letter.
    // All three mean the keystroke belongs to something other than this app.
    composing: event.isComposing || event.getModifierState("AltGraph") || event.key === "Dead",
    defaultPrevented: event.defaultPrevented,
  };
}

/**
 * Install the keyboard shortcuts.
 *
 * @param commands - the table, usually a module constant.
 * @param enabled - false while something replaces the shell (the settings page
 * renders instead of the layout, but this hook's effect stays mounted, so the
 * flag is what stands in for "the page underneath is gone").
 */
export function useShortcuts(commands: readonly ShortcutCommand[], enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const result = dispatchShortcut({
        commands,
        environment: environment(),
        gesture: gestureOf(event),
        // Asked per keystroke rather than cached behind a MutationObserver, the
        // way dsh does it: this is one selector match against a page with a
        // handful of dialogs, and a stale cache would be a shortcut that fires
        // behind a modal that just opened.
        layerOpen: document.querySelector(LAYER_SELECTOR) !== null,
      });
      if (result.status === "pass") return;
      // Claimed in both remaining cases. A key this app binds must not also
      // reach the browser — that is what makes a web default like `⌘⌥P` safe.
      event.preventDefault();
      // A held key is claimed but not obeyed: leaning on `⌘⇧B` must not flap
      // the panel at the keyboard's repeat rate.
      if (result.status === "handled" && !result.repeat) result.command.run();
    };
    // Bubble phase, on `window`, like dsh. A local control gets to decide
    // first: the composer's own Enter handling, a dialog's Escape, an input's
    // keymap. Only a keydown nothing closer wanted arrives here.
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commands, enabled]);
}
