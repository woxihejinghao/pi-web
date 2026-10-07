/**
 * Closing tabs as a *gesture* — the one place that knows a tab can own a process.
 *
 * `rightbarActions` is layout and storage: it removes chips, picks the next tab
 * to show and writes the layout back, and it deliberately knows nothing about
 * shells. But closing a terminal's tab is the user saying they are done with
 * that shell, so the process goes with the tab — while every *other* way a tab
 * leaves the screen (collapsing the panel, switching sessions, a reload) only
 * detaches, which is what lets a running build survive the sidebar being put
 * away.
 *
 * That rule used to live on the chip's ✕, back when the ✕ was the only gesture
 * that closed a tab. The strip's menu closes whole groups, so the rule needed a
 * single owner rather than a second copy of itself: this file.
 */
import { rightbarActions, rightbarStore, type RightbarTab } from "./rightbar-state.ts";
import { terminalActions } from "./terminal-state.ts";

/**
 * Kill the shells behind these tabs, then take the tabs away.
 *
 * Ids that match nothing are ignored, so a caller can pass a group it computed
 * from a render that has since gone stale.
 */
export function closeTabs(sessionPath: string, ids: readonly string[]): void {
  const surface = rightbarStore.get().surfaces[sessionPath];
  if (surface === undefined) return;
  const going = new Set(ids);
  // Read before removing: the host id lives on the tab, and the tab is about to
  // stop existing in the store.
  for (const tab of surface.tabs) {
    if (going.has(tab.id)) releaseShell(tab);
  }
  rightbarActions.closeTabs(sessionPath, ids);
}

/** A terminal tab is a process; every other kind of tab is a view. */
function releaseShell(tab: RightbarTab): void {
  // An empty target means no shell was ever opened for this tab — the body asks
  // for one on mount, and a tab closed before it got an answer has none to kill.
  if (tab.kind === "terminal" && tab.target.length > 0) terminalActions.release(tab.target);
}
