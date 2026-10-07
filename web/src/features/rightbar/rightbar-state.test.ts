import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { translator } from "../../lib/i18n/index.ts";
import { cascadedRect } from "./dock-geometry.ts";
import {
  MAX_DOCK_PANES,
  WIDTH_DEFAULT,
  WIDTH_MAX,
  WIDTH_MIN,
  clampWidth,
  normalizeUrl,
  paneTabs,
  resetRightbarState,
  rightbarActions,
  rightbarStore,
  tabTitle,
  type RightbarPane,
  type RightbarSurface,
} from "./rightbar-state.ts";

// The assertions below pin the Chinese wording, so the translator is resolved
// here rather than from whatever locale the test host happens to have.
const zh = translator("zh-CN");

const KEY = "session-a";
const V2 = "pi-web-simple.rightbar.v2.";
const V1 = "pi-web-simple.rightbar.v1.";

let commits = 0;

/** A stand-in for the browser's storage, which the node test env lacks. */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  commits = 0;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      commits += 1;
      map.set(key, value);
    },
    removeItem: (key: string) => void map.delete(key),
  };
  return map;
}

/** How many localStorage writes have happened since `installStorage`. */
function writeCount(): number {
  return commits;
}

function surface(key = KEY): RightbarSurface {
  const value = rightbarStore.get().surfaces[key];
  if (value === undefined) throw new Error(`no surface for ${key}`);
  return value;
}

/** The docked panes, left to right, re-read from the store. */
function docked(key = KEY): RightbarPane[] {
  return surface(key).panes;
}

/** One docked pane by position. */
function pane(index = 0, key = KEY): RightbarPane {
  const found = docked(key)[index];
  if (found === undefined) throw new Error(`no docked pane ${String(index)}`);
  return found;
}

/** One docked pane's tab ids, in strip order. */
function ids(index = 0, key = KEY): string[] {
  return [...pane(index, key).tabs];
}

/** A pane's tabs, in strip order. */
function tabsOf(target: RightbarPane, key = KEY) {
  return paneTabs(surface(key), target);
}

/** Open a preview of `path` — into `paneId`, or the focused docked pane. */
function openInto(path: string, paneId?: string): string {
  rightbarActions.openPreviewTab(KEY, path, paneId);
  const found = Object.values(surface().tabs).find(
    (tab) => tab.kind === "preview" && tab.target === path,
  );
  if (found === undefined) throw new Error(`no preview for ${path}`);
  return found.id;
}

beforeEach(() => {
  resetRightbarState();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("opening and closing", () => {
  it("seeds an empty surface with the Files tab, in its one pane", () => {
    rightbarActions.open(KEY);
    const value = surface();
    expect(value.open).toBe(true);
    expect(value.panes).toHaveLength(1);
    const tabs = tabsOf(value.panes[0]!);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.kind).toBe("files");
    expect(value.panes[0]!.activeTabId).toBe(tabs[0]?.id);
    expect(value.activePaneId).toBe(value.panes[0]!.id);
    // One pane fills the column, so there is no divider and nothing for one to
    // divide.
    expect(value.sizes).toBeUndefined();
  });

  it("keeps the tabs when the panel is closed and reopened", () => {
    rightbarActions.openPreviewTab(KEY, "src/index.ts");
    rightbarActions.close(KEY);
    expect(surface().open).toBe(false);
    expect(ids()).toHaveLength(1);

    rightbarActions.open(KEY);
    expect(pane().activeTabId).toBe(ids()[0]);
  });

  it("closes the panel when its last tab closes, and keeps the pane", () => {
    rightbarActions.open(KEY);
    rightbarActions.closeTab(KEY, ids()[0]!);
    expect(surface().open).toBe(false);
    expect(surface().tabs).toEqual({});
    // The panel is a column of the page: a surface with no panes at all has
    // nothing left to address, so the last one stays and reads as empty.
    expect(docked()).toHaveLength(1);
    expect(pane().activeTabId).toBeNull();
  });

  it("focuses the neighbouring tab when the active one closes", () => {
    rightbarActions.open(KEY);
    const preview = openInto("README.md");
    const files = ids()[0]!;
    rightbarActions.closeTab(KEY, files);
    expect(ids()).toEqual([preview]);
    expect(pane().activeTabId).toBe(preview);
  });

  /**
   * Closing a group — the strip's context menu.
   *
   * `closeTabs` is the plural of `closeTab`, and the pair must agree: the single
   * close is literally a one-element call, so what these pin is that the plural
   * behaves like the singular when given one id, and that a group close is one
   * write rather than N.
   */
  describe("closing groups", () => {
    /** Three tabs in the one pane, with the second one showing. */
    function threeTabs(): { files: string; readme: string; notes: string } {
      rightbarActions.open(KEY);
      const files = ids()[0]!;
      const readme = openInto("README.md");
      const notes = openInto("notes.md");
      rightbarActions.selectTab(KEY, readme);
      return { files, readme, notes };
    }

    it("takes away every id it is given", () => {
      const { files, readme, notes } = threeTabs();
      rightbarActions.closeTabs(KEY, [files, notes]);
      expect(ids()).toEqual([readme]);
      // The survivor was the one showing, and it stays showing.
      expect(pane().activeTabId).toBe(readme);
    });

    it("leaves the panel open when tabs remain", () => {
      const { files, notes } = threeTabs();
      rightbarActions.closeTabs(KEY, [files, notes]);
      expect(surface().open).toBe(true);
    });

    it("closes the panel when the group was everything", () => {
      threeTabs();
      rightbarActions.closeTabs(KEY, Object.keys(surface().tabs));
      expect(surface().open).toBe(false);
      expect(surface().tabs).toEqual({});
      expect(pane().activeTabId).toBeNull();
    });

    it("falls to the tab that slides into the closed one's place", () => {
      // `readme` (middle) is showing; `notes` takes its position.
      const { readme, notes } = threeTabs();
      rightbarActions.closeTabs(KEY, [readme]);
      expect(pane().activeTabId).toBe(notes);
    });

    it("falls back to the left when there was nothing to the right", () => {
      // Closing the last tab has no right neighbour to slide in, so the tab to
      // its left keeps the reader company — the same rule Chrome uses.
      const { readme, notes } = threeTabs();
      rightbarActions.closeTabs(KEY, [notes]);
      expect(pane().activeTabId).toBe(readme);
    });

    it("keeps the showing tab when it is not in the group", () => {
      const { files, readme } = threeTabs();
      rightbarActions.closeTabs(KEY, [files]);
      expect(pane().activeTabId).toBe(readme);
    });

    it("does nothing for ids that match no tab", () => {
      const { files, readme, notes } = threeTabs();
      rightbarActions.closeTabs(KEY, ["nope-1", "nope-2"]);
      expect(ids()).toEqual([files, readme, notes]);
    });

    it("does nothing for an empty group", () => {
      threeTabs();
      const before = rightbarStore.get().surfaces[KEY];
      rightbarActions.closeTabs(KEY, []);
      expect(ids()).toHaveLength(3);
      expect(surface().open).toBe(true);
      // Not even a write: there was no intent to carry out.
      expect(rightbarStore.get().surfaces[KEY]).toBe(before);
    });

    it("writes the layout once for a whole group", () => {
      installStorage();
      threeTabs();
      const before = writeCount();
      rightbarActions.closeTabs(KEY, Object.keys(surface().tabs));
      expect(writeCount() - before).toBe(1);
    });
  });
});

describe("tabs", () => {
  it("focuses an already-open preview instead of duplicating it", () => {
    const first = openInto("README.md");
    openInto("README.md");
    expect(ids()).toEqual([first]);
    expect(pane().activeTabId).toBe(first);
  });

  it("keeps the Files tab to one instance", () => {
    rightbarActions.openFilesTab(KEY);
    rightbarActions.openFilesTab(KEY);
    expect(tabsOf(pane()).filter((tab) => tab.kind === "files")).toHaveLength(1);
  });

  it("keeps the changes tab to one instance, since a project has one change set", () => {
    rightbarActions.openChangesTab(KEY);
    rightbarActions.openChangesTab(KEY);
    const changes = tabsOf(pane()).filter((tab) => tab.kind === "changes");
    expect(changes).toHaveLength(1);
    // A fixed-kind tab carries no title of its own; the strip asks the table for
    // it at render time, which is what keeps a language switch from leaving an
    // old title behind on an already-open tab.
    expect(changes[0] === undefined ? "" : tabTitle(changes[0], zh)).toBe("文件变更");
    expect(pane().activeTabId).toBe(changes[0]?.id);
  });

  it("searches the whole surface, not just the focused pane, for a single-instance tab", () => {
    // Files is one-per-project, so asking for it from the other pane brings the
    // pane that already holds it forward rather than opening a second tree.
    rightbarActions.openFilesTab(KEY);
    const files = ids()[0]!;
    rightbarActions.splitPane(KEY, pane().id);
    const right = pane(1).id;
    rightbarActions.openFilesTab(KEY, right);
    expect(docked()).toHaveLength(2);
    expect(ids(0)).toEqual([files]);
    expect(ids(1)).toEqual([]);
    expect(surface().activePaneId).toBe(pane(0).id);
  });

  it("titles a preview tab after its file name", () => {
    openInto("docs/guide/setup.md");
    const tab = tabsOf(pane())[0];
    expect(tab?.title).toBe("setup.md");
    expect(tab?.target).toBe("docs/guide/setup.md");
  });

  it("gives every terminal its own tab, since two shells are two processes", () => {
    rightbarActions.openTerminalTab(KEY);
    rightbarActions.openTerminalTab(KEY);
    const terminals = tabsOf(pane()).filter((tab) => tab.kind === "terminal");
    expect(terminals).toHaveLength(2);
    // Nothing to attach to yet: the body opens the shell and writes the id back.
    expect(terminals[0]?.target).toBe("");
    // An unnamed terminal is titled by the table, like the other fixed kinds.
    expect(terminals[0] === undefined ? "" : tabTitle(terminals[0], zh)).toBe("终端");
  });

  it("remembers the host id a terminal body attached to", () => {
    rightbarActions.openTerminalTab(KEY);
    const id = ids()[0]!;
    rightbarActions.setTabTarget(KEY, id, "t-42");
    expect(tabsOf(pane())[0]?.target).toBe("t-42");
  });
});

describe("browser history", () => {
  it("records a navigation and steps through it", () => {
    rightbarActions.openBrowserTab(KEY, "http://localhost:5173/");
    const id = ids()[0]!;
    rightbarActions.navigateBrowser(KEY, id, "https://example.com/");
    expect(tabsOf(pane())[0]?.history).toEqual([
      "http://localhost:5173/",
      "https://example.com/",
    ]);

    rightbarActions.stepBrowserHistory(KEY, id, -1);
    expect(tabsOf(pane())[0]?.target).toBe("http://localhost:5173/");
    rightbarActions.stepBrowserHistory(KEY, id, -1);
    // Already at the first entry: the step is a no-op, not an error.
    expect(tabsOf(pane())[0]?.historyIndex).toBe(0);
  });

  it("drops the forward entries when an address is typed", () => {
    rightbarActions.openBrowserTab(KEY, "https://a.example/");
    const id = ids()[0]!;
    rightbarActions.navigateBrowser(KEY, id, "https://b.example/");
    rightbarActions.navigateBrowser(KEY, id, "https://c.example/");
    rightbarActions.stepBrowserHistory(KEY, id, -1);
    rightbarActions.navigateBrowser(KEY, id, "https://d.example/");
    expect(tabsOf(pane())[0]?.history).toEqual([
      "https://a.example/",
      "https://b.example/",
      "https://d.example/",
    ]);
  });

  it("titles the tab after the landed host", () => {
    rightbarActions.openBrowserTab(KEY, "https://example.com/a/b");
    expect(tabsOf(pane())[0]?.title).toBe("example.com");
  });
});

describe("splitting", () => {
  it("makes a second, empty pane and gives the two an even share", () => {
    rightbarActions.open(KEY);
    const first = pane().id;
    rightbarActions.splitPane(KEY, first);
    const value = surface();
    expect(value.panes).toHaveLength(2);
    expect(value.panes[0]!.id).toBe(first);
    expect(value.sizes).toEqual([0.5, 0.5]);
    // The new half is empty, focused, and reads as 「空面板」 until its own `+`
    // puts something in it.
    expect(value.panes[1]!.tabs).toEqual([]);
    expect(value.panes[1]!.activeTabId).toBeNull();
    expect(value.activePaneId).toBe(value.panes[1]!.id);
  });

  it("refuses a third pane", () => {
    rightbarActions.open(KEY);
    rightbarActions.splitPane(KEY, pane().id);
    const right = pane(1).id;
    // Filled first, or the refusal below could be the empty-pane rule rather
    // than the budget.
    openInto("a.md", right);
    const before = surface();
    rightbarActions.splitPane(KEY, before.panes[1]!.id);
    expect(surface().panes).toHaveLength(MAX_DOCK_PANES);
    expect(surface()).toBe(before);
  });

  it("refuses to split a pane with nothing in it", () => {
    rightbarActions.open(KEY);
    rightbarActions.splitPane(KEY, pane().id);
    const before = surface();
    rightbarActions.splitPane(KEY, before.panes[1]!.id);
    expect(surface()).toBe(before);
  });

  it("refuses to split when no pane is focused, which is the same as empty", () => {
    rightbarActions.ensureSurface(KEY);
    rightbarActions.splitPane(KEY);
    expect(docked()).toHaveLength(1);
  });

  it("records the divider's fractions, and clamps them to the floor", () => {
    rightbarActions.open(KEY);
    rightbarActions.splitPane(KEY, pane().id);
    rightbarActions.resizePanes(KEY, [0.7, 0.3]);
    expect(surface().sizes).toEqual([0.7, 0.3]);
    // A fifth of the column is the point below which a pane stops being
    // readable, so a drag past it pins the floor instead of obeying.
    rightbarActions.resizePanes(KEY, [0.99, 0.01]);
    expect(surface().sizes).toEqual([0.8, 0.2]);
  });

  it("ignores a divider drag with only one pane", () => {
    // A stale drag from a layout that has since merged must not invent a
    // divider for a single-pane surface.
    rightbarActions.open(KEY);
    rightbarActions.resizePanes(KEY, [0.3, 0.7]);
    expect(surface().sizes).toBeUndefined();
  });

  it("merges a docked pane away when its last tab leaves, divider and all", () => {
    rightbarActions.open(KEY);
    rightbarActions.splitPane(KEY, pane().id);
    const again = openInto("a.md", pane(1).id);
    rightbarActions.closeTab(KEY, again);
    const value = surface();
    expect(value.panes).toHaveLength(1);
    expect(value.sizes).toBeUndefined();
    // Focus falls off the pane that is gone rather than naming it.
    expect(value.activePaneId).toBe(value.panes[0]!.id);
  });
});

describe("moving tabs between panes", () => {
  it("reorders inside a pane, counting the caret over the dragged chip", () => {
    const [a, b, c] = [openInto("a.md"), openInto("b.md"), openInto("c.md")];
    const paneId = pane().id;
    // Slot 3 is "after c" once the dragged chip is counted, so the tab lands
    // last — the same arithmetic a browser's tab strip uses.
    rightbarActions.placeTab(KEY, a, paneId, 3);
    expect(ids()).toEqual([b, c, a]);
  });

  it("leaves the layout alone when the caret is where the chip already sits", () => {
    const [a, b] = [openInto("a.md"), openInto("b.md")];
    const paneId = pane().id;
    const before = surface();
    rightbarActions.placeTab(KEY, a, paneId, 0);
    expect(surface()).toBe(before);
    rightbarActions.placeTab(KEY, a, paneId, 1);
    expect(surface()).toBe(before);
    expect(ids()).toEqual([a, b]);
  });

  it("moves a tab across panes, at the slot it was released on", () => {
    const a = openInto("a.md");
    const b = openInto("b.md");
    rightbarActions.splitPane(KEY, pane().id);
    const right = pane(1).id;
    const c = openInto("c.md", right);

    rightbarActions.moveTab(KEY, a, right, 0);
    expect(docked()).toHaveLength(2);
    expect(ids(0)).toEqual([b]);
    expect(ids(1)).toEqual([a, c]);
    expect(pane(1).activeTabId).toBe(a);
    // Nothing was emptied, so the divider the user set survives the move.
    expect(surface().sizes).toEqual([0.5, 0.5]);
  });

  it("collapses the split when a pane's only tab moves out of it", () => {
    const a = openInto("a.md");
    rightbarActions.splitPane(KEY, pane().id);
    const right = pane(1).id;
    const b = openInto("b.md", right);

    rightbarActions.moveTab(KEY, a, right, 0);
    expect(docked()).toHaveLength(1);
    expect(ids()).toEqual([a, b]);
    expect(surface().sizes).toBeUndefined();
  });

  it("resolves a chip released on the middle of another pane into a move", () => {
    const a = openInto("a.md");
    const b = openInto("b.md");
    rightbarActions.splitPane(KEY, pane().id);
    const right = pane(1).id;
    const c = openInto("c.md", right);

    rightbarActions.dropTab(KEY, a, right, "center");
    expect(ids(0)).toEqual([b]);
    expect(ids(1)).toEqual([c, a]);
  });

  it("splits on an edge release and seats the tab in the new half, in one write", () => {
    installStorage();
    const a = openInto("a.md");
    const b = openInto("b.md");
    const paneId = pane().id;
    const before = writeCount();

    rightbarActions.dropTab(KEY, a, paneId, "right");
    expect(writeCount() - before).toBe(1);
    expect(docked()).toHaveLength(2);
    expect(ids(0)).toEqual([b]);
    expect(ids(1)).toEqual([a]);
    expect(surface().sizes).toEqual([0.5, 0.5]);
  });

  it("puts the new half on the side the release asked for", () => {
    const a = openInto("a.md");
    const b = openInto("b.md");
    rightbarActions.dropTab(KEY, a, pane().id, "left");
    expect(ids(0)).toEqual([a]);
    expect(ids(1)).toEqual([b]);
  });

  it("refuses to split a pane's only tab away from it", () => {
    // The split would empty the pane the tab came from and seat it beside where
    // it already was: indistinguishable from doing nothing, at the cost of a
    // layout change.
    const a = openInto("a.md");
    const before = surface();
    rightbarActions.dropTab(KEY, a, pane().id, "right");
    rightbarActions.dropTab(KEY, a, pane().id, "left");
    expect(surface()).toBe(before);
    expect(docked()).toHaveLength(1);
    expect(ids()).toEqual([a]);
  });

  it("does nothing on an edge release with the budget already spent", () => {
    // The pointer is over an edge, so falling back to a move would answer a
    // question nobody asked.
    const a = openInto("a.md");
    rightbarActions.splitPane(KEY, pane().id);
    const right = pane(1).id;
    const c = openInto("c.md", right);

    rightbarActions.dropTab(KEY, c, pane(0).id, "left");
    expect(docked()).toHaveLength(2);
    expect(ids(0)).toEqual([a]);
    expect(ids(1)).toEqual([c]);
  });
});

describe("floating panels", () => {
  it("takes the tab out of the column and leaves the docked pane behind", () => {
    const a = openInto("a.md");
    rightbarActions.floatTab(KEY, a);
    const value = surface();
    expect(value.floats).toHaveLength(1);
    expect(docked()).toHaveLength(1);
    expect(ids()).toEqual([]);
    expect(value.floats[0]!.host).toBe("float");
    expect(value.floats[0]!.tabs).toEqual([a]);
    expect(value.floats[0]!.activeTabId).toBe(a);
    expect(value.activePaneId).toBe(value.floats[0]!.id);
    // With no release point to go on, the panel cascades from the ones already
    // floating.
    expect(value.floats[0]!.rect).toEqual(cascadedRect(0));
  });

  it("cascades the second panel off the first", () => {
    const a = openInto("a.md");
    const b = openInto("b.md");
    rightbarActions.floatTab(KEY, a);
    rightbarActions.floatTab(KEY, b);
    const [first, second] = surface().floats;
    expect(first!.rect).toEqual(cascadedRect(0));
    expect(second!.rect).toEqual(cascadedRect(1));
    // Bottom to top, which is also the paint order.
    expect(surface().floats.at(-1)!.id).toBe(second!.id);
  });

  it("takes the release point's rectangle when the drag chose one", () => {
    const a = openInto("a.md");
    const rect = { x: 40, y: 60, width: 380, height: 300 };
    rightbarActions.floatTab(KEY, a, rect);
    expect(surface().floats[0]!.rect).toEqual(rect);
  });

  it("merges a docked pane away when floating its last tab empties it", () => {
    openInto("a.md");
    rightbarActions.splitPane(KEY, pane().id);
    const b = openInto("b.md", pane(1).id);
    rightbarActions.floatTab(KEY, b);
    expect(docked()).toHaveLength(1);
    expect(surface().sizes).toBeUndefined();
    expect(surface().floats).toHaveLength(1);
  });

  it("refuses to float a tab that is already floating", () => {
    const a = openInto("a.md");
    rightbarActions.floatTab(KEY, a);
    const before = surface();
    rightbarActions.floatTab(KEY, a);
    expect(surface()).toBe(before);
  });

  it("sends a float's only tab back to the focused docked pane", () => {
    const a = openInto("a.md");
    rightbarActions.splitPane(KEY, pane().id);
    const right = pane(1).id;
    const b = openInto("b.md", right);
    const c = openInto("c.md", right);

    rightbarActions.floatTab(KEY, b);
    rightbarActions.focusPane(KEY, right);
    rightbarActions.unfloatPane(KEY, surface().floats[0]!.id);

    const value = surface();
    expect(value.floats).toEqual([]);
    expect(ids(0)).toEqual([a]);
    // The tab lands at the end of the destination's strip, like every other tab
    // that arrives from somewhere else.
    expect(ids(1)).toEqual([c, b]);
    expect(pane(1).activeTabId).toBe(b);
  });

  it("moves a panel, clamping it at the top-left corner", () => {
    const a = openInto("a.md");
    rightbarActions.floatTab(KEY, a);
    const panelId = surface().floats[0]!.id;

    rightbarActions.moveFloat(KEY, panelId, 300, 200);
    expect(surface().floats[0]!.rect).toMatchObject({ x: 300, y: 200 });
    // Past the corner, the header would be off screen — and it is the panel's
    // only handle.
    rightbarActions.moveFloat(KEY, panelId, -50, -50);
    expect(surface().floats[0]!.rect).toMatchObject({ x: 0, y: 0 });
  });

  it("resizes a panel from its corner", () => {
    const a = openInto("a.md");
    rightbarActions.floatTab(KEY, a);
    const panelId = surface().floats[0]!.id;
    const rect = { x: 10, y: 20, width: 500, height: 400 };
    rightbarActions.resizeFloat(KEY, panelId, rect);
    expect(surface().floats[0]!.rect).toEqual(rect);
  });

  it("raises a panel to the top without duplicating it", () => {
    const a = openInto("a.md");
    const b = openInto("b.md");
    rightbarActions.floatTab(KEY, a);
    rightbarActions.floatTab(KEY, b);
    const first = surface().floats[0]!.id;
    const second = surface().floats[1]!.id;

    rightbarActions.focusPane(KEY, first);
    // The panel is moved to the top of the stack rather than added to it again,
    // and focusing is what says so — there is no separate raise.
    expect(surface().floats.map((entry) => entry.id)).toEqual([second, first]);
    expect(surface().activePaneId).toBe(first);
  });

  it("writes nothing when focusing the panel that is already raised", () => {
    installStorage();
    const a = openInto("a.md");
    rightbarActions.floatTab(KEY, a);
    const panelId = surface().floats[0]!.id;
    const before = writeCount();
    rightbarActions.focusPane(KEY, panelId);
    expect(writeCount() - before).toBe(0);
  });

  it("closes a floating panel with its only tab", () => {
    const a = openInto("a.md");
    rightbarActions.floatTab(KEY, a);
    rightbarActions.closeTab(KEY, a);
    const value = surface();
    expect(value.floats).toEqual([]);
    expect(value.tabs).toEqual({});
    expect(value.open).toBe(false);
  });

  it("keeps the column when a float closes but docked tabs remain", () => {
    const a = openInto("a.md");
    const b = openInto("b.md");
    rightbarActions.floatTab(KEY, a);
    rightbarActions.closeTab(KEY, a);
    const value = surface();
    expect(value.floats).toEqual([]);
    // The floats are drawn over the conversation, so a surface holding only
    // floats keeps its column; this one still has a docked tab to show, which
    // is why the panel does not go away with the float.
    expect(value.open).toBe(true);
    expect(ids()).toEqual([b]);
  });

  it("ignores a gesture aimed at a pane that is gone", () => {
    rightbarActions.ensureSurface(KEY);
    const before = surface();
    rightbarActions.moveFloat(KEY, "nope", 0, 0);
    rightbarActions.resizeFloat(KEY, "nope", { x: 0, y: 0, width: 1, height: 1 });
    rightbarActions.unfloatPane(KEY, "nope");
    rightbarActions.focusPane(KEY, "nope");
    expect(surface()).toBe(before);
  });
});

describe("width", () => {
  it("clamps a dragged width into range", () => {
    rightbarActions.setWidth(KEY, 10);
    expect(surface().width).toBe(WIDTH_MIN);
    rightbarActions.setWidth(KEY, 9999);
    expect(surface().width).toBe(WIDTH_MAX);
    rightbarActions.setWidth(KEY, Number.NaN);
    expect(surface().width).toBe(WIDTH_DEFAULT);
    expect(clampWidth(500)).toBe(500);
  });
});

describe("persistence", () => {
  it("restores panes, tabs, divider and width for the same session, closed", () => {
    const store = installStorage();
    rightbarActions.openPreviewTab(KEY, "src/app.ts");
    rightbarActions.splitPane(KEY, pane().id);
    rightbarActions.openPreviewTab(KEY, "src/b.ts", pane(1).id);
    rightbarActions.resizePanes(KEY, [0.3, 0.7]);
    rightbarActions.setWidth(KEY, 520);
    expect(store.size).toBe(1);

    // A fresh page: the store is empty but storage still holds the layout.
    resetRightbarState();
    rightbarActions.ensureSurface(KEY);
    const restored = surface();
    expect(restored.open).toBe(false);
    expect(restored.width).toBe(520);
    expect(restored.panes).toHaveLength(2);
    expect(tabsOf(restored.panes[0]!).map((tab) => tab.target)).toEqual(["src/app.ts"]);
    expect(tabsOf(restored.panes[1]!).map((tab) => tab.target)).toEqual(["src/b.ts"]);
    expect(restored.sizes).toEqual([0.3, 0.7]);
    expect(restored.activePaneId).toBe(restored.panes[1]!.id);
  });

  it("restores a floating panel where it was left", () => {
    installStorage();
    const a = openInto("a.md");
    rightbarActions.floatTab(KEY, a, { x: 40, y: 60, width: 380, height: 300 });

    resetRightbarState();
    rightbarActions.ensureSurface(KEY);
    const restored = surface();
    expect(restored.floats).toEqual([
      expect.objectContaining({
        host: "float",
        tabs: [a],
        rect: { x: 40, y: 60, width: 380, height: 300 },
      }),
    ]);
    expect(restored.activePaneId).toBe(restored.floats[0]!.id);
  });

  it("does not persist a draft session", () => {
    const store = installStorage();
    rightbarActions.openPreviewTab("draft:abc", "README.md");
    expect(store.size).toBe(0);
    expect(Object.keys(surface("draft:abc").tabs)).toHaveLength(1);
  });

  it("ignores a corrupt stored layout", () => {
    installStorage().set(
      V2 + KEY,
      JSON.stringify({ tabs: [{ kind: "nope" }, "x"], width: "wide", panes: "x" }),
    );
    rightbarActions.ensureSurface(KEY);
    const restored = surface();
    expect(restored.tabs).toEqual({});
    expect(restored.width).toBe(WIDTH_DEFAULT);
    // Nothing survived to name a pane, so the surface starts on an empty one.
    expect(restored.panes).toHaveLength(1);
  });

  it("keeps only the panes the budget allows", () => {
    installStorage().set(
      V2 + KEY,
      JSON.stringify({
        panes: Array.from({ length: MAX_DOCK_PANES + 1 }, (_, index) => ({
          id: `p${String(index)}`,
          host: "dock",
          tabs: [`t${String(index)}`],
          activeTabId: `t${String(index)}`,
        })),
        tabs: Object.fromEntries(
          Array.from({ length: MAX_DOCK_PANES + 1 }, (_, index) => [
            `t${String(index)}`,
            { id: `t${String(index)}`, kind: "preview", title: "a.md", target: "a.md" },
          ]),
        ),
      }),
    );
    rightbarActions.ensureSurface(KEY);
    expect(docked()).toHaveLength(MAX_DOCK_PANES);
  });

  it("invents no divider for a stored single-pane layout", () => {
    installStorage().set(
      V2 + KEY,
      JSON.stringify({
        panes: [{ id: "p0", host: "dock", tabs: [], activeTabId: null }],
        sizes: [0.5, 0.5],
      }),
    );
    rightbarActions.ensureSurface(KEY);
    expect(docked()).toHaveLength(1);
    expect(surface().sizes).toBeUndefined();
  });

  it("drops a floating pane that has no rectangle to be drawn at", () => {
    installStorage().set(
      V2 + KEY,
      JSON.stringify({
        floats: [{ id: "f1", host: "float", tabs: ["t1"] }],
        tabs: { t1: { id: "t1", kind: "preview", title: "a.md", target: "a.md" } },
      }),
    );
    rightbarActions.ensureSurface(KEY);
    const restored = surface();
    // Nowhere to draw it, and the tab it held is now unreachable, so both go.
    expect(restored.floats).toEqual([]);
    expect(restored.tabs).toEqual({});
  });

  it("drops a tab record no pane lists", () => {
    installStorage().set(
      V2 + KEY,
      JSON.stringify({
        panes: [{ id: "p0", host: "dock", tabs: ["t1"], activeTabId: "t1" }],
        tabs: {
          t1: { id: "t1", kind: "preview", title: "a.md", target: "a.md" },
          t2: { id: "t2", kind: "preview", title: "b.md", target: "b.md" },
        },
      }),
    );
    rightbarActions.ensureSurface(KEY);
    // A record no pane lists is unreachable; keeping it would grow a tail of
    // tabs nobody can open.
    expect(Object.keys(surface().tabs)).toEqual(["t1"]);
  });

  it("restores a changes tab, which carries no address", () => {
    installStorage();
    rightbarActions.openChangesTab(KEY);
    resetRightbarState();
    rightbarActions.ensureSurface(KEY);
    expect(tabsOf(surface().panes[0]!)).toEqual([
      expect.objectContaining({ kind: "changes", title: "", target: "" }),
    ]);
  });

  it("brings a terminal tab back pointing at the shell it was attached to", () => {
    // This is what makes a reload reattach instead of opening a second shell
    // beside the one still running on the host.
    installStorage();
    rightbarActions.openTerminalTab(KEY);
    rightbarActions.setTabTarget(KEY, ids()[0]!, "t-42");

    resetRightbarState();
    rightbarActions.ensureSurface(KEY);
    expect(tabsOf(surface().panes[0]!)).toEqual([
      expect.objectContaining({ kind: "terminal", target: "t-42" }),
    ]);
  });

  describe("the flat layout this one replaced", () => {
    it("adopts a v1 layout into one pane, and keeps the old key", () => {
      const store = installStorage();
      store.set(
        V1 + KEY,
        JSON.stringify({
          open: true,
          mode: "push",
          width: 420,
          tabs: [
            { id: "diff-1", kind: "diff", title: "改动", target: "" },
            { id: "readme", kind: "preview", title: "README.md", target: "README.md" },
          ],
          activeTabId: "readme",
        }),
      );
      rightbarActions.ensureSurface(KEY);
      const restored = surface();
      expect(restored.width).toBe(420);
      expect(docked()).toHaveLength(1);
      expect(ids()).toEqual(["diff-1", "readme"]);
      expect(pane().activeTabId).toBe("readme");
      // The old kind is adopted rather than dropped: "diff" became "changes"
      // when the tab grew staging, committing and history.
      expect(tabsOf(pane())[0]).toMatchObject({ kind: "changes", target: "" });
      // The old key stays where it is: it costs a few hundred bytes and it is
      // the only copy of a layout for anyone who goes back to an older build.
      expect(store.get(V1 + KEY)).not.toBeNull();
    });

    it("falls back to the first tab when the v1 active id names nothing", () => {
      installStorage().set(
        V1 + KEY,
        JSON.stringify({
          tabs: [{ id: "a", kind: "preview", title: "a.md", target: "a.md" }],
          activeTabId: "gone",
        }),
      );
      rightbarActions.ensureSurface(KEY);
      expect(pane().activeTabId).toBe("a");
    });

    it("prefers a v2 layout when both are stored", () => {
      const store = installStorage();
      store.set(V1 + KEY, JSON.stringify({ width: 300, tabs: [] }));
      store.set(
        V2 + KEY,
        JSON.stringify({
          width: 460,
          panes: [{ id: "p0", host: "dock", tabs: [], activeTabId: null }],
        }),
      );
      rightbarActions.ensureSurface(KEY);
      expect(surface().width).toBe(460);
    });
  });
});

describe("normalizeUrl", () => {
  it("assumes HTTPS for a bare public host", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
    expect(normalizeUrl("example.com:8443/x")).toBe("https://example.com:8443/x");
  });

  it("assumes HTTP for loopback, where a dev server is the whole point", () => {
    expect(normalizeUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeUrl("127.0.0.1:4319/api/health")).toBe("http://127.0.0.1:4319/api/health");
    expect(normalizeUrl("api.localhost")).toBe("http://api.localhost/");
  });

  it("keeps an explicit scheme, whatever it is", () => {
    expect(normalizeUrl("http://example.com/")).toBe("http://example.com/");
    expect(normalizeUrl("https://localhost:5173/")).toBe("https://localhost:5173/");
  });

  it("refuses anything that is not http(s)", () => {
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("data:text/html,hi")).toBeNull();
    expect(normalizeUrl("mailto:someone@example.com")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
  });

  it("refuses embedded credentials", () => {
    expect(normalizeUrl("http://user:pass@example.com/")).toBeNull();
  });
});
