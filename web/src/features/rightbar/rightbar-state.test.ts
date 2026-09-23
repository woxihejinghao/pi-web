import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WIDTH_DEFAULT,
  WIDTH_MAX,
  WIDTH_MIN,
  clampWidth,
  normalizeUrl,
  resetRightbarState,
  rightbarActions,
  rightbarStore,
} from "./rightbar-state.ts";

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
    expect(changes[0]?.title).toBe("文件变更");
    expect(surface().activeTabId).toBe(changes[0]?.id);
  });

  it("titles a preview tab after its file name", () => {
    rightbarActions.openPreviewTab(KEY, "docs/guide/setup.md");
    expect(surface().tabs[0]?.title).toBe("setup.md");
    expect(surface().tabs[0]?.target).toBe("docs/guide/setup.md");
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
      expect.objectContaining({ kind: "changes", title: "文件变更", target: "" }),
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
