/**
 * The right sidebar's keyboard commands.
 *
 * The bindings are dsh's, copied from the packages that own each one there
 * (`ui-sidebar-right`, `ui-sidebar-files`, `ui-sidebar-browser`,
 * `ui-sidebar-terminal`) rather than invented, so the muscle memory transfers
 * between the two apps. Two things about them are worth knowing before editing
 * the table:
 *
 *  * **The web column differs from the desktop column on purpose.** A browser
 *    already owns bare `primary` combinations — `⌘P` prints, `⌘T` is a new tab,
 *    `⌘⇧B` toggles the bookmarks bar — and the desktop window owns none of them,
 *    so on web each one moves to `primary+alt`. A browser may still win a race
 *    it starts (nothing a page does can take back `⌘W`), which is why the
 *    panels that the browser reserves are the ones this table does not bind.
 *  * **`Ctrl+\`` is the same everywhere.** It is deliberately *not* built on
 *    `primary`, because it is the one binding every terminal-bearing editor
 *    agrees on and a Mac user's fingers already expect Control.
 */
import { appStore } from "../../lib/app-state.ts";
import type { Translate } from "../../lib/i18n/index.ts";
import { keycapsText, normalizeBinding } from "../../lib/shortcuts/binding.ts";
import type { ShortcutCommand } from "../../lib/shortcuts/dispatch.ts";
import { environment } from "../../lib/shortcuts/environment.ts";
import { rightbarActions, rightbarStore } from "./rightbar-state.ts";

/**
 * The session the shortcuts act on, or null while the hero is showing.
 *
 * Read from the store at call time rather than captured in a closure: the
 * keydown listener is installed once and outlives any particular session, so
 * anything it captured would be the session that was selected when the page
 * loaded. dsh answers the same question through a `resolve` step that returns
 * `blocked` with a reason; there is no channel for that reason here, so a
 * shortcut with no session does nothing at all.
 */
function activeSession(): string | null {
  const path = appStore.get().selectedSessionPath;
  return path === null || path.length === 0 ? null : path;
}

/** Show the panel, or put it away. */
function toggleRightbar(): void {
  const key = activeSession();
  if (key === null) return;
  rightbarActions.toggle(key);
}

/** Give the whole window to the panel, or give it back. */
function toggleFullscreen(): void {
  const key = activeSession();
  if (key === null) return;
  const surface = rightbarStore.get().surfaces[key];
  // Only meaningful while the panel is showing: "fullscreen" on a panel that is
  // put away would mean opening it, which is not what the key says. dsh asks
  // for the keyboard focus to be inside the sidebar instead — it needs to, with
  // several panes to choose between; one panel means there is nothing to
  // disambiguate, and a *global* binding is the one that also works right after
  // clicking the button with a mouse.
  if (surface === undefined || !surface.open) return;
  rightbarActions.setMode(key, surface.mode === "fullscreen" ? "push" : "fullscreen");
}

/** Bring up the file tree, or the one that is already there. */
function openFiles(): void {
  const key = activeSession();
  if (key === null) return;
  rightbarActions.openFilesTab(key);
}

/**
 * Open one more shell.
 *
 * A new tab every time, which is dsh's `terminal.new` and the reason this is
 * not a toggle: two terminals are two processes and neither replaces the other.
 * `docs/known-limitations.md` records what that costs — the host caps a session
 * at eight shells, and closing a terminal's chip is what releases its slot.
 */
function openTerminal(): void {
  const key = activeSession();
  if (key === null) return;
  rightbarActions.openTerminalTab(key);
}

/** Open a browser tab on the local dev server this panel exists for. */
function openBrowser(): void {
  const key = activeSession();
  if (key === null) return;
  rightbarActions.openBrowserTab(key, "");
}

/**
 * Every command this panel answers to.
 *
 * `as const` keeps each `id` a literal, so `RightbarCommandId` below is the
 * exact set of them and a typo in a lookup is a compile error rather than a
 * hint that silently prints nothing.
 */
export const rightbarCommands = [
  {
    id: "rightbar.toggle",
    defaults: {
      desktop: { code: "KeyB", modifiers: ["primary", "alt"] },
      web: { code: "KeyB", modifiers: ["primary", "shift"] },
    },
    run: toggleRightbar,
  },
  {
    id: "rightbar.fullscreen",
    defaults: {
      desktop: { code: "Enter", modifiers: ["primary", "alt"] },
      web: { code: "Enter", modifiers: ["primary", "alt"] },
    },
    run: toggleFullscreen,
  },
  {
    id: "rightbar.files",
    defaults: {
      desktop: { code: "KeyP", modifiers: ["primary"] },
      web: { code: "KeyP", modifiers: ["primary", "alt"] },
    },
    run: openFiles,
  },
  {
    id: "rightbar.terminal",
    defaults: {
      desktop: { code: "Backquote", modifiers: ["control"] },
      web: { code: "Backquote", modifiers: ["control"] },
    },
    run: openTerminal,
  },
  {
    id: "rightbar.browser",
    defaults: {
      desktop: { code: "KeyT", modifiers: ["primary"] },
      web: { code: "KeyT", modifiers: ["primary", "alt"] },
    },
    run: openBrowser,
  },
] as const satisfies readonly ShortcutCommand[];

/** One of the commands above, by id. */
export type RightbarCommandId = (typeof rightbarCommands)[number]["id"];

/**
 * The keycaps to print next to one of this panel's controls.
 *
 * Derived from the same table the listener matches against, so a hint can never
 * advertise a key that does nothing — the failure mode of a hand-written
 * tooltip. Empty only for an id that does not exist, which the union prevents.
 */
export function shortcutHint(id: RightbarCommandId): string {
  const command = rightbarCommands.find((candidate) => candidate.id === id);
  if (command === undefined) return "";
  const { runtime, platform } = environment();
  return keycapsText(normalizeBinding(command.defaults[runtime], platform), platform);
}

/**
 * The tooltip for a control that also answers to a shortcut.
 *
 * Usually one control and one command share a name but not a sentence — the
 * strip's button says 「收起右栏」 while the command is "show or hide it" — so
 * the control passes its own words in and only the keys come from the table.
 * A command with nothing bound degrades to the plain label rather than a
 * dangling pair of brackets.
 */
export function shortcutTitle(t: Translate, label: string, id: RightbarCommandId): string {
  const keys = shortcutHint(id);
  return keys.length === 0 ? label : t("shortcut.hint", { label, keys });
}
