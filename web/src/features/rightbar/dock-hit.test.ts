import { describe, expect, it } from "vitest";
import { PANE_ATTR, STRIP_ATTR, TAB_ATTR, hitTest } from "./dock-hit.ts";
import type { Rect } from "./dock-geometry.ts";

/**
 * The drop rules are the one part of the dock that reads the DOM, so they are
 * pinned against a hand-built element tree rather than a real document: the
 * repository's test environment has no layout engine, and what these assertions
 * are about is the *rule* — which box wins, and what a body point resolves to —
 * not about whether a browser can measure. `v5.mjs` covers the other half: that
 * the attributes these selectors walk are the ones the components actually
 * render.
 */
interface FakeNode {
  readonly attrs: Record<string, string>;
  readonly rect: Rect;
  readonly children: readonly FakeNode[];
}

function node(attrs: Record<string, string>, rect: Rect, children: readonly FakeNode[] = []): FakeNode {
  return { attrs, rect, children };
}

function hasAttr(candidate: FakeNode, selector: string): boolean {
  return candidate.attrs[selector.slice(1, -1)] !== undefined;
}

/** The smallest object `hitTest` can be handed: two selectors, no layout. */
function element(tree: FakeNode): HTMLElement {
  return {
    getAttribute: (name: string) => tree.attrs[name] ?? null,
    getBoundingClientRect: () => tree.rect,
    querySelector: (selector: string) => {
      const found = tree.children.find((child) => hasAttr(child, selector));
      return found === undefined ? null : element(found);
    },
    querySelectorAll: (selector: string) =>
      tree.children.filter((child) => hasAttr(child, selector)).map((child) => element(child)),
  } as unknown as HTMLElement;
}

/** A chip at `x`, 80px wide, in the strip's own row. */
function chip(tabId: string, x: number): FakeNode {
  return node({ [TAB_ATTR]: tabId }, { x, y: 0, width: 80, height: 26 });
}

/** A pane whose strip is its top 40px and whose body is everything below. */
function pane(id: string, x: number, width: number, tabs: readonly string[] = []): FakeNode {
  const chips = tabs.map((tabId, index) => chip(tabId, x + index * 84));
  return node({ [PANE_ATTR]: id }, { x, y: 0, width, height: 500 }, [
    node({ [STRIP_ATTR]: id }, { x, y: 0, width, height: 40 }, chips),
  ]);
}

function row(...panes: readonly FakeNode[]): HTMLElement {
  return element(node({}, { x: 0, y: 0, width: 420, height: 500 }, panes));
}

describe("hitTest", () => {
  it("answers a point in a strip with an insertion slot", () => {
    // 84px apart, so the second chip's midpoint is 40 + 84 = 124.
    const root = row(pane("p1", 0, 420, ["a", "b"]));
    expect(hitTest(root, 10, 20, true)).toEqual({ kind: "strip", paneId: "p1", index: 0 });
    expect(hitTest(root, 130, 20, true)).toEqual({ kind: "strip", paneId: "p1", index: 2 });
  });

  it("answers a body point with the half the pointer is on", () => {
    const root = row(pane("p1", 0, 420));
    expect(hitTest(root, 100, 300, true)).toEqual({ kind: "zone", paneId: "p1", zone: "left" });
    expect(hitTest(root, 300, 300, true)).toEqual({ kind: "zone", paneId: "p1", zone: "right" });
  });

  it("lets the strip win over the pane it sits inside", () => {
    // The strip is *inside* the pane box, so a test that only asked about the
    // pane would resolve every release among the chips to a half.
    const root = row(pane("p1", 0, 420, ["a"]));
    expect(hitTest(root, 20, 20, true)).toMatchObject({ kind: "strip", index: 0 });
  });

  it("falls back to the middle when the budget is spent", () => {
    // Two docked panes already: an edge could only ask for a third.
    const root = row(pane("p1", 0, 420));
    expect(hitTest(root, 100, 300, false)).toEqual({ kind: "zone", paneId: "p1", zone: "center" });
    expect(hitTest(root, 300, 300, false)).toEqual({ kind: "zone", paneId: "p1", zone: "center" });
  });

  it("falls back to the middle when a half would be too narrow to work in", () => {
    const root = row(pane("p1", 0, 240));
    expect(hitTest(root, 10, 300, true)).toEqual({ kind: "zone", paneId: "p1", zone: "center" });
  });

  it("names the pane the pointer is over, not the first one", () => {
    const root = row(pane("p1", 0, 200), pane("p2", 200, 220));
    expect(hitTest(root, 300, 300, true)).toEqual({ kind: "zone", paneId: "p2", zone: "center" });
    expect(hitTest(root, 100, 20, true)).toMatchObject({ kind: "strip", paneId: "p1" });
  });

  it("answers null outside every pane", () => {
    const root = row(pane("p1", 0, 200));
    expect(hitTest(root, 300, 300, true)).toBeNull();
    expect(hitTest(root, 100, 900, true)).toBeNull();
  });

  it("treats a pane drawn without a strip as all body", () => {
    // Nothing guarantees a pane has a strip — a surface could draw one bare —
    // and a pane with no strip is still somewhere a tab can be moved into.
    const bare = node({ [PANE_ATTR]: "p1" }, { x: 0, y: 0, width: 420, height: 500 });
    const root = element(node({}, { x: 0, y: 0, width: 420, height: 500 }, [bare]));
    expect(hitTest(root, 20, 20, true)).toEqual({ kind: "zone", paneId: "p1", zone: "left" });
  });
});
