import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTabs } from "./close-tabs.ts";
import {
  makePreviewTab,
  makeTerminalTab,
  paneTabs,
  resetRightbarState,
  rightbarActions,
  rightbarStore,
} from "./rightbar-state.ts";
import { resetTerminalState } from "./terminal-state.ts";

const KEY = "session-a";

/** Every request the code under test made, as `METHOD /path`. */
function stubFetch(): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", (url: string, init?: { method?: string }) => {
    seen.push(`${init?.method ?? "GET"} ${new URL(url, "http://localhost").pathname}`);
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(JSON.stringify({ closed: true })),
    });
  });
  return seen;
}

function surface() {
  const value = rightbarStore.get().surfaces[KEY];
  if (value === undefined) throw new Error(`no surface for ${KEY}`);
  return value;
}

/** A surface's docked tabs. A tab record is the surface's own, so this is only
 * a convenience for reading the pane that holds the ids. */
function dockTabs() {
  const value = surface();
  const pane = value.panes[0];
  if (pane === undefined) throw new Error("no docked pane");
  return paneTabs(value, pane);
}

/** A tab that has a shell behind it — `target` is only filled once it has one. */
function openTerminal(target: string): string {
  rightbarActions.openTab(KEY, { ...makeTerminalTab(), target });
  const tab = dockTabs().at(-1);
  if (tab === undefined) throw new Error("the terminal tab was not added");
  return tab.id;
}

beforeEach(() => {
  resetRightbarState();
  resetTerminalState();
});

afterEach(() => {
  resetRightbarState();
  resetTerminalState();
  vi.unstubAllGlobals();
});

/**
 * Closing tabs is the one gesture that kills a shell.
 *
 * Every other way a tab leaves the screen — collapsing the panel, switching
 * sessions, a reload — only detaches, and that is what lets a running build
 * survive the sidebar being put away. These pin the exception, because it is the
 * exception that is easy to lose: it used to live on the chip's ✕ alone, and the
 * strip's menu closed groups without it.
 */
describe("closeTabs", () => {
  it("takes the shell down with a terminal's tab", () => {
    const seen = stubFetch();
    const id = openTerminal("host-1");
    closeTabs(KEY, [id]);
    expect(seen).toEqual(["DELETE /api/terminal/host-1"]);
    expect(surface().tabs).toEqual({});
  });

  it("finds the shell behind a floating panel's tab too", () => {
    // The lookup walks the surface's tab records rather than a pane's ids,
    // which is the only reason a tab that has been dragged out of the column
    // still has its process killed when it is closed.
    const seen = stubFetch();
    const id = openTerminal("host-1");
    rightbarActions.floatTab(KEY, id);
    closeTabs(KEY, [id]);
    expect(seen).toEqual(["DELETE /api/terminal/host-1"]);
    expect(surface().floats).toEqual([]);
  });

  it("kills every shell in a group, not just the first", () => {
    const seen = stubFetch();
    const first = openTerminal("host-1");
    const second = openTerminal("host-2");
    closeTabs(KEY, [first, second]);
    expect(seen).toEqual(["DELETE /api/terminal/host-1", "DELETE /api/terminal/host-2"]);
  });

  it("leaves the shells it was not asked to close alone", () => {
    const seen = stubFetch();
    const kept = openTerminal("host-1");
    const going = openTerminal("host-2");
    closeTabs(KEY, [going]);
    expect(seen).toEqual(["DELETE /api/terminal/host-2"]);
    expect(dockTabs().map((tab) => tab.id)).toEqual([kept]);
  });

  it("asks the host for nothing when a view's tab closes", () => {
    const seen = stubFetch();
    rightbarActions.openTab(KEY, makePreviewTab("README.md"));
    const id = dockTabs()[0]?.id ?? "";
    closeTabs(KEY, [id]);
    expect(seen).toEqual([]);
  });

  it("asks for nothing when the terminal never got a shell", () => {
    // A tab closed between mounting and the host's answer has no id to kill.
    const seen = stubFetch();
    const id = openTerminal("");
    closeTabs(KEY, [id]);
    expect(seen).toEqual([]);
  });

  it("ignores ids that match no tab", () => {
    const seen = stubFetch();
    const id = openTerminal("host-1");
    closeTabs(KEY, ["nope"]);
    expect(seen).toEqual([]);
    expect(dockTabs().map((tab) => tab.id)).toEqual([id]);
  });

  it("does nothing for a session with no loaded surface", () => {
    const seen = stubFetch();
    closeTabs("never-seen", ["any"]);
    expect(seen).toEqual([]);
  });
});
