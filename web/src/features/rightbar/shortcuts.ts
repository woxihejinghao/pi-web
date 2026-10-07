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
 *
 * Two of them act on the panel's **focused pane** rather than on the panel:
 * splitting and going fullscreen both mean "this half", and when two panes are
 * docked the click that focused one is the only place that was recorded. dsh
 * reads the same fact out of the DOM focus (`focusedTarget`) and blocks with a
 * reason when the focus is outside the sidebar or on a floating panel; there is
 * no channel for a reason here, so the command does nothing in those cases and
 * the control's own tooltip carries the sentence instead.
 */
import { appStore } from "../../lib/app-state.ts";
import type { Translate } from "../../lib/i18n/index.ts";
import { keycapsText, normalizeBinding } from "../../lib/shortcuts/binding.ts";
import type { ShortcutCommand } from "../../lib/shortcuts/dispatch.ts";
import { environment } from "../../lib/shortcuts/environment.ts";
import { paneById, rightbarActions, rightbarStore, type RightbarSurface } from "./rightbar-state.ts";

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

/** The surface the shortcuts act on, while the panel is showing it. */
function shownSurface(): { key: string; surface: RightbarSurface } | null {
  const key = activeSession();
  if (key === null) return null;
  const surface = rightbarStore.get().surfaces[key];
  if (surface === undefined || !surface.open) return null;
  return { key, surface };
}

/** Give the whole window to the panel, or give it back. */
function toggleFullscreen(): void {
  const shown = shownSurface();
  if (shown === null) return;
  // Only meaningful while the panel is showing: "fullscreen" on a panel that is
  // put away would mean opening it, which is not what the key says. dsh asks
  // for the keyboard focus to be inside the sidebar instead — it needs to, with
  // several panes to choose between; the presentation belongs to the column
  // rather than to a pane, so a *global* binding is the one that also works
  // right after clicking the button with a mouse.
  rightbarActions.setMode(shown.key, shown.surface.mode === "fullscreen" ? "push" : "fullscreen");
}

/**
 * Split the focused pane, or make no room at all.
 *
 * A floating panel cannot be split — it holds one tab by definition — and dsh
 * blocks the command there rather than splitting whichever docked pane happens
 * to be first: that would be a different pane from the one the user's attention
 * is in. The pane's own split control carries the sentence when it is disabled
 * by the budget or by the column being too narrow; a key has nowhere to put it.
 */
function splitFocusedPane(): void {
  const shown = shownSurface();
  if (shown === null) return;
  const focused = paneById(shown.surface, shown.surface.activePaneId);
  if (focused === undefined || focused.host === "float") return;
  rightbarActions.splitPane(shown.key, focused.id);
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
    id: "rightbar.split",
    // The one row in this table where the web column is *not* moved off the
    // bare primary combination: no browser claims `⌘\`, so there is no race to
    // lose, and dsh binds `pane.split` to the same combination everywhere.
    defaults: {
      desktop: { code: "Backslash", modifiers: ["primary"] },
      web: { code: "Backslash", modifiers: ["primary"] },
    },
    run: splitFocusedPane,
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
