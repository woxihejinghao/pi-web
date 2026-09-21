import { describe, expect, it } from "vitest";
import { buildProjectTree, flattenProjectTree } from "./project-tree.ts";
import type { ProjectView } from "./types.ts";

function project(id: string, path: string, order: number): ProjectView {
  return {
    id,
    path,
    title: path.split("/").pop() ?? path,
    order,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    exists: true,
  };
}

describe("buildProjectTree", () => {
  it("keeps unrelated paths at the root", () => {
    const tree = buildProjectTree([
      project("a", "/Users/me/alpha", 0),
      project("b", "/Users/me/beta", 1),
    ]);
    expect(tree.map((node) => node.project.id)).toEqual(["a", "b"]);
    expect(tree.every((node) => node.depth === 0)).toBe(true);
    expect(tree.every((node) => node.children.length === 0)).toBe(true);
  });

  it("nests a project under its registered ancestor", () => {
    const tree = buildProjectTree([
      project("parent", "/Users/me/code", 0),
      project("child", "/Users/me/code/app", 1),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.project.id).toBe("parent");
    expect(tree[0]?.children.map((node) => node.project.id)).toEqual(["child"]);
    expect(tree[0]?.children[0]?.depth).toBe(1);
  });

  it("uses the nearest ancestor, not the outermost", () => {
    const tree = buildProjectTree([
      project("root", "/Users/me/code", 0),
      project("middle", "/Users/me/code/app", 1),
      project("leaf", "/Users/me/code/app/packages/web", 2),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.project.id).toBe("root");
    const middle = tree[0]?.children[0];
    expect(middle?.project.id).toBe("middle");
    expect(middle?.children[0]?.project.id).toBe("leaf");
    expect(middle?.children[0]?.depth).toBe(2);
  });

  it("does not treat a shared name prefix as nesting", () => {
    // /Users/me/app must not be considered an ancestor of /Users/me/application
    const tree = buildProjectTree([
      project("a", "/Users/me/app", 0),
      project("b", "/Users/me/application", 1),
    ]);
    expect(tree.map((node) => node.project.id)).toEqual(["a", "b"]);
  });

  it("orders siblings by their stored order", () => {
    const tree = buildProjectTree([
      project("second", "/Users/me/zeta", 1),
      project("first", "/Users/me/alpha", 0),
    ]);
    expect(tree.map((node) => node.project.id)).toEqual(["first", "second"]);
  });

  it("promotes children when their parent is not registered", () => {
    const tree = buildProjectTree([project("orphan", "/Users/me/code/app", 0)]);
    expect(tree.map((node) => node.project.id)).toEqual(["orphan"]);
    expect(tree[0]?.depth).toBe(0);
  });

  it("handles an empty project list", () => {
    expect(buildProjectTree([])).toEqual([]);
  });
});

describe("flattenProjectTree", () => {
  it("walks depth-first in display order", () => {
    const tree = buildProjectTree([
      project("parent", "/Users/me/code", 0),
      project("child", "/Users/me/code/app", 1),
      project("sibling", "/Users/me/other", 2),
    ]);
    expect(flattenProjectTree(tree).map((node) => node.project.id)).toEqual([
      "parent",
      "child",
      "sibling",
    ]);
  });
});
