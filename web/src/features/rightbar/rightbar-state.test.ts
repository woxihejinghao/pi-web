import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { translator } from "../../lib/i18n/index.ts";
import {
  WIDTH_DEFAULT,
  WIDTH_MAX,
  WIDTH_MIN,
  clampWidth,
  normalizeUrl,
  resetRightbarState,
  rightbarActions,
  rightbarStore,
  tabTitle,
} from "./rightbar-state.ts";

// The assertions below pin the Chinese wording, so the translator is resolved
// here rather than from whatever locale the test host happens to have.
const zh = translator("zh-CN");

const KEY = "session-a";

/** A stand-in for the browser's storage, which the node test env lacks. */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  return map;
}

function surface(key = KEY) {
  const value = rightbarStore.get().surfaces[key];
  if (value === undefined) throw new Error(`no surface for ${key}`);
  return value;
}

beforeEach(() => {
  resetRightbarState();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("opening and closing", () => {
  it("seeds an empty surface with the Files tab", () => {
    rightbarActions.open(KEY);
    const value = surface();
    expect(value.open).toBe(true);
    expect(value.tabs).toHaveLength(1);
    expect(value.tabs[0]?.kind).toBe("files");
    expect(value.activeTabId).toBe(value.tabs[0]?.id);
  });

  it("keeps the tabs when the panel is closed and reopened", () => {
    rightbarActions.openPreviewTab(KEY, "src/index.ts");
    rightbarActions.close(KEY);
    expect(surface().open).toBe(false);
    expect(surface().tabs).toHaveLength(1);

    rightbarActions.open(KEY);
    expect(surface().activeTabId).toBe(surface().tabs[0]?.id);
  });

  it("closes the panel when its last tab closes", () => {
    rightbarActions.open(KEY);
    const tab = surface().tabs[0]!;
    rightbarActions.closeTab(KEY, tab.id);
    expect(surface().open).toBe(false);
    expect(surface().tabs).toEqual([]);
    expect(surface().activeTabId).toBeNull();
  });

  it("focuses the neighbouring tab when the active one closes", () => {
    rightbarActions.open(KEY);
    rightbarActions.openPreviewTab(KEY, "README.md");
    const [files, preview] = surface().tabs;
    rightbarActions.closeTab(KEY, files!.id);
    expect(surface().tabs.map((tab) => tab.id)).toEqual([preview!.id]);
    expect(surface().activeTabId).toBe(preview!.id);
  });

  /**
   * Closing a group — the strip's context menu.
   *
   * `closeTabs` is the plural of `closeTab`, and the pair must agree: the single
   * close is now literally a one-element call, so what these pin is that the
   * plural behaves like the singular when given one id, and that a group close
   * is one write rather than N.
   */
  describe("closing groups", () => {
    /** Three tabs, with the second one showing. */
    function threeTabs() {
      rightbarActions.open(KEY);
      rightbarActions.openPreviewTab(KEY, "README.md");
      rightbarActions.openPreviewTab(KEY, "notes.md");
      const [files, readme, notes] = surface().tabs;
      rightbarActions.selectTab(KEY, readme!.id);
      return { files: files!, readme: readme!, notes: notes! };
    }

    it("takes away every id it is given", () => {
      const { files, readme, notes } = threeTabs();
      rightbarActions.closeTabs(KEY, [files.id, notes.id]);
      expect(surface().tabs.map((tab) => tab.id)).toEqual([readme.id]);
      // The survivor was the one showing, and it stays showing.
      expect(surface().activeTabId).toBe(readme.id);
    });

    it("leaves the panel open when tabs remain", () => {
      const { files, notes } = threeTabs();
      rightbarActions.closeTabs(KEY, [files.id, notes.id]);
      expect(surface().open).toBe(true);
    });

    it("closes the panel when the group was everything", () => {
      threeTabs();
      rightbarActions.closeTabs(
        KEY,
        surface().tabs.map((tab) => tab.id),
      );
      expect(surface().open).toBe(false);
      expect(surface().tabs).toEqual([]);
      expect(surface().activeTabId).toBeNull();
    });

    it("falls to the tab that slides into the closed one's place", () => {
      // `readme` (middle) is showing; `notes` takes its position.
      const { notes } = threeTabs();
      rightbarActions.closeTabs(KEY, [surface().tabs[1]!.id]);
      expect(surface().activeTabId).toBe(notes.id);
    });

    it("falls back to the left when there was nothing to the right", () => {
      // Closing the last tab has no right neighbour to slide in, so the tab to
      // its left keeps the reader company — the same rule Chrome uses.
      const { readme } = threeTabs();
      rightbarActions.closeTabs(KEY, [surface().tabs[2]!.id]);
      expect(surface().activeTabId).toBe(readme.id);
    });

    it("keeps the showing tab when it is not in the group", () => {
      const { readme } = threeTabs();
      rightbarActions.closeTabs(KEY, [surface().tabs[0]!.id]);
      expect(surface().activeTabId).toBe(readme.id);
    });

    it("does nothing for ids that match no tab", () => {
      const { files, readme, notes } = threeTabs();
      rightbarActions.closeTabs(KEY, ["nope-1", "nope-2"]);
      expect(surface().tabs.map((tab) => tab.id)).toEqual([files.id, readme.id, notes.id]);
    });

    it("does nothing for an empty group", () => {
      threeTabs();
      rightbarActions.closeTabs(KEY, []);
      expect(surface().tabs).toHaveLength(3);
      expect(surface().open).toBe(true);
    });

    it("writes the layout once for a whole group", () => {
      // The panel persists through localStorage, so "how many writes" is
      // observable: one commit per group, not one per tab.
      const store = installStorage();
      threeTabs();
      store.clear();
      rightbarActions.closeTabs(
        KEY,
        surface().tabs.map((tab) => tab.id),
      );
      expect([...store.keys()]).toHaveLength(1);
    });
  });
});

describe("tabs", () => {
  it("focuses an already-open preview instead of duplicating it", () => {
    rightbarActions.openPreviewTab(KEY, "README.md");
    const first = surface().tabs[0]!;
    rightbarActions.openPreviewTab(KEY, "README.md");
    expect(surface().tabs).toHaveLength(1);
    expect(surface().activeTabId).toBe(first.id);
  });

  it("keeps the Files tab to one instance", () => {
    rightbarActions.openFilesTab(KEY);
    rightbarActions.openFilesTab(KEY);
    expect(surface().tabs.filter((tab) => tab.kind === "files")).toHaveLength(1);
  });

  it("keeps the changes tab to one instance, since a project has one change set", () => {
    rightbarActions.openChangesTab(KEY);
    rightbarActions.openChangesTab(KEY);
    const changes = surface().tabs.filter((tab) => tab.kind === "changes");
    expect(changes).toHaveLength(1);
    // A fixed-kind tab carries no title of its own; the strip asks the table for
    // it at render time, which is what keeps a language switch from leaving an
    // old title behind on an already-open tab.
    expect(changes[0] === undefined ? "" : tabTitle(changes[0], zh)).toBe("文件变更");
    expect(surface().activeTabId).toBe(changes[0]?.id);
  });

  it("titles a preview tab after its file name", () => {
    rightbarActions.openPreviewTab(KEY, "docs/guide/setup.md");
    expect(surface().tabs[0]?.title).toBe("setup.md");
    expect(surface().tabs[0]?.target).toBe("docs/guide/setup.md");
  });

  it("gives every terminal its own tab, since two shells are two processes", () => {
    rightbarActions.openTerminalTab(KEY);
    rightbarActions.openTerminalTab(KEY);
    const terminals = surface().tabs.filter((tab) => tab.kind === "terminal");
    expect(terminals).toHaveLength(2);
    // Nothing to attach to yet: the body opens the shell and writes the id back.
    expect(terminals[0]?.target).toBe("");
    // An unnamed terminal is titled by the table, like the other fixed kinds.
    expect(terminals[0] === undefined ? "" : tabTitle(terminals[0], zh)).toBe("终端");
  });

  it("remembers the host id a terminal body attached to", () => {
    rightbarActions.openTerminalTab(KEY);
    const id = surface().tabs[0]!.id;
    rightbarActions.setTabTarget(KEY, id, "t-42");
    expect(surface().tabs[0]?.target).toBe("t-42");
  });
});

describe("browser history", () => {
  it("records a navigation and steps through it", () => {
    rightbarActions.openBrowserTab(KEY, "http://localhost:5173/");
    const id = surface().tabs[0]!.id;
    rightbarActions.navigateBrowser(KEY, id, "https://example.com/");
    expect(surface().tabs[0]?.history).toEqual([
      "http://localhost:5173/",
      "https://example.com/",
    ]);

    rightbarActions.stepBrowserHistory(KEY, id, -1);
    expect(surface().tabs[0]?.target).toBe("http://localhost:5173/");
    rightbarActions.stepBrowserHistory(KEY, id, -1);
    // Already at the first entry: the step is a no-op, not an error.
    expect(surface().tabs[0]?.historyIndex).toBe(0);
  });

  it("drops the forward entries when an address is typed", () => {
    rightbarActions.openBrowserTab(KEY, "https://a.example/");
    const id = surface().tabs[0]!.id;
    rightbarActions.navigateBrowser(KEY, id, "https://b.example/");
    rightbarActions.navigateBrowser(KEY, id, "https://c.example/");
    rightbarActions.stepBrowserHistory(KEY, id, -1);
    rightbarActions.navigateBrowser(KEY, id, "https://d.example/");
    expect(surface().tabs[0]?.history).toEqual(["https://a.example/", "https://b.example/", "https://d.example/"]);
  });

  it("titles the tab after the landed host", () => {
    rightbarActions.openBrowserTab(KEY, "https://example.com/a/b");
    expect(surface().tabs[0]?.title).toBe("example.com");
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
  it("restores tabs and width for the same session, closed", () => {
    const store = installStorage();
    rightbarActions.openPreviewTab(KEY, "src/app.ts");
    rightbarActions.setWidth(KEY, 520);
    expect(store.size).toBe(1);

    // A fresh page: the store is empty but storage still holds the layout.
    resetRightbarState();
    rightbarActions.ensureSurface(KEY);
    const restored = surface();
    expect(restored.open).toBe(false);
    expect(restored.width).toBe(520);
    expect(restored.tabs.map((tab) => tab.target)).toEqual(["src/app.ts"]);
  });

  it("does not persist a draft session", () => {
    const store = installStorage();
    rightbarActions.openPreviewTab("draft:abc", "README.md");
    expect(store.size).toBe(0);
    expect(rightbarStore.get().surfaces["draft:abc"]?.tabs).toHaveLength(1);
  });

  it("ignores a corrupt stored layout", () => {
    installStorage().set(
      "pi-web-simple.rightbar.v1." + KEY,
      JSON.stringify({ tabs: [{ kind: "nope" }, "x"], width: "wide" }),
    );
    rightbarActions.ensureSurface(KEY);
    const restored = surface();
    expect(restored.tabs).toEqual([]);
    expect(restored.width).toBe(WIDTH_DEFAULT);
  });

  it("adopts a layout saved under the tab's old kind", () => {
    installStorage().set(
      "pi-web-simple.rightbar.v1." + KEY,
      JSON.stringify({
        open: true,
        mode: "push",
        width: 420,
        tabs: [{ id: "diff-1", kind: "diff", title: "改动", target: "" }],
        activeTabId: "diff-1",
      }),
    );
    rightbarActions.ensureSurface(KEY);
    expect(surface().tabs[0]).toMatchObject({ kind: "changes", target: "" });
  });

  it("restores a changes tab, which carries no address", () => {
    installStorage();
    rightbarActions.openChangesTab(KEY);
    resetRightbarState();
    rightbarActions.ensureSurface(KEY);
    const restored = surface();
    expect(restored.tabs).toEqual([
      expect.objectContaining({ kind: "changes", title: "", target: "" }),
    ]);
  });

  it("brings a terminal tab back pointing at the shell it was attached to", () => {
    // This is what makes a reload reattach instead of opening a second shell
    // beside the one still running on the host.
    installStorage();
    rightbarActions.openTerminalTab(KEY);
    const id = surface().tabs[0]!.id;
    rightbarActions.setTabTarget(KEY, id, "t-42");

    resetRightbarState();
    rightbarActions.ensureSurface(KEY);
    expect(surface().tabs).toEqual([
      expect.objectContaining({ kind: "terminal", target: "t-42" }),
    ]);
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
