import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIDEBAR_VIEW,
  FLAT_ORDER_KEY,
  loadSidebarView,
  moveInOrder,
  moveWorkspace,
  reconcileManualOrder,
  rowHalf,
  saveSidebarView,
} from "./sidebar-view.ts";

const KEY = "pi-web-simple.sidebar-view.v1";

/** A `localStorage` stand-in; returning the map lets a test read what was written. */
function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const entries = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string): string | null => entries.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      entries.set(key, value);
    },
    removeItem: (key: string): void => {
      entries.delete(key);
    },
  });
  return entries;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sidebar view preferences", () => {
  it("starts from the defaults when nothing was saved", () => {
    installStorage();
    expect(loadSidebarView()).toEqual(DEFAULT_SIDEBAR_VIEW);
  });

  it("defaults to the nested tree and recency", () => {
    // Named rather than implied: the tree default is this project's one
    // deliberate deviation from dsh, and a silent change to it would be a
    // change to every existing sidebar.
    expect(DEFAULT_SIDEBAR_VIEW.groupBy).toBe("workspace-tree");
    expect(DEFAULT_SIDEBAR_VIEW.orderBy).toBe("updated");
  });

  it("survives a round trip", () => {
    const entries = installStorage();
    const view = {
      groupBy: "flat" as const,
      orderBy: "manual" as const,
      sessionOrder: { p1: ["b", "a"], [FLAT_ORDER_KEY]: ["z"] },
    };
    saveSidebarView(view);

    expect(JSON.parse(entries.get(KEY) ?? "")).toEqual(view);
    expect(loadSidebarView()).toEqual(view);
  });

  it("falls back to the defaults on an unparseable cache", () => {
    installStorage({ [KEY]: "{not json" });
    expect(loadSidebarView()).toEqual(DEFAULT_SIDEBAR_VIEW);
  });

  it("drops only the field that is wrong", () => {
    installStorage({
      [KEY]: JSON.stringify({
        groupBy: "spiral",
        orderBy: "manual",
        sessionOrder: { p1: ["a"] },
      }),
    });

    expect(loadSidebarView()).toEqual({
      groupBy: DEFAULT_SIDEBAR_VIEW.groupBy,
      orderBy: "manual",
      sessionOrder: { p1: ["a"] },
    });
  });

  it("drops a saved order that is not a list of paths", () => {
    // Half an order would pin the rows it kept and re-sort the rest, so the
    // entry goes rather than being repaired.
    installStorage({
      [KEY]: JSON.stringify({ sessionOrder: { p1: ["a", 7], p2: ["b"] } }),
    });

    expect(loadSidebarView().sessionOrder).toEqual({ p2: ["b"] });
  });

  it("treats blocked storage as no persistence", () => {
    vi.stubGlobal("localStorage", {
      getItem: (): never => {
        throw new Error("blocked");
      },
      setItem: (): never => {
        throw new Error("blocked");
      },
    });

    expect(loadSidebarView()).toEqual(DEFAULT_SIDEBAR_VIEW);
    expect(() => saveSidebarView(DEFAULT_SIDEBAR_VIEW)).not.toThrow();
  });
});

describe("reconcileManualOrder", () => {
  it("keeps the saved positions and trails the members it has not seen", () => {
    expect(reconcileManualOrder(["d", "a", "b", "c"], ["c", "a"])).toEqual(["c", "a", "d", "b"]);
  });

  it("drops saved entries whose session is no longer loaded", () => {
    expect(reconcileManualOrder(["a", "b"], ["gone", "b", "a"])).toEqual(["b", "a"]);
  });

  it("falls back to the given order with nothing saved", () => {
    expect(reconcileManualOrder(["a", "b"], undefined)).toEqual(["a", "b"]);
  });
});

describe("moveInOrder", () => {
  it("drops a row above or below its target", () => {
    expect(moveInOrder(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(moveInOrder(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
  });

  it("reports nothing to do when the row lands where it started", () => {
    expect(moveInOrder(["a", "b", "c"], "b", "c", "before")).toBeUndefined();
    expect(moveInOrder(["a", "b", "c"], "a", "b", "before")).toBeUndefined();
    expect(moveInOrder(["a", "b", "c"], "a", "a", "before")).toBeUndefined();
  });

  it("ignores ids the order does not hold", () => {
    expect(moveInOrder(["a", "b"], "a", "missing", "before")).toBeUndefined();
    expect(moveInOrder(["a", "b"], "missing", "a", "before")).toBeUndefined();
  });
});

describe("moveWorkspace", () => {
  it("moves a workspace before its anchor", () => {
    expect(moveWorkspace(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("lands last when there is no anchor", () => {
    expect(moveWorkspace(["a", "b", "c"], "a", undefined)).toEqual(["b", "c", "a"]);
  });

  it("reports nothing to do when the move is a no-op", () => {
    expect(moveWorkspace(["a", "b", "c"], "b", "c")).toBeUndefined();
    expect(moveWorkspace(["a", "b", "c"], "a", "b")).toBeUndefined();
    expect(moveWorkspace(["a", "b", "c"], "a", undefined)).not.toBeUndefined();
  });

  it("ignores an unknown source or anchor", () => {
    expect(moveWorkspace(["a", "b"], "missing", "a")).toBeUndefined();
    expect(moveWorkspace(["a", "b"], "a", "missing")).toBeUndefined();
  });
});

describe("rowHalf", () => {
  const row = (top: number, height: number): { clientY: number; currentTarget: HTMLElement } => ({
    clientY: 0,
    currentTarget: {
      getBoundingClientRect: () => ({ top, height }),
    } as unknown as HTMLElement,
  });

  it("splits the row at its middle", () => {
    expect(rowHalf({ ...row(100, 32), clientY: 110 })).toBe("before");
    expect(rowHalf({ ...row(100, 32), clientY: 116 })).toBe("after");
  });
});
