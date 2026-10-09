import { describe, expect, it } from "vitest";
import { buildProjectTree } from "../../lib/project-tree.ts";
import type { ProjectView } from "../../lib/types.ts";
import { parentOfMap } from "./use-sidebar-drag.ts";

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

const NESTED = [
  project("root", "/Users/me/code", 0),
  project("child", "/Users/me/code/app", 1),
  project("other", "/Users/me/other", 2),
];

/**
 * This map is the whole of the sibling rule a workspace drop is held to: two
 * headers may trade places exactly when they agree here.
 */
describe("parentOfMap", () => {
  it("names the nested parent and leaves a root at null", () => {
    expect([...parentOfMap(buildProjectTree(NESTED))]).toEqual([
      ["root", null],
      ["child", "root"],
      ["other", null],
    ]);
  });

  it("puts the deepest node under its nearest registered ancestor", () => {
    const tree = buildProjectTree([
      project("root", "/Users/me/code", 0),
      project("middle", "/Users/me/code/app", 1),
      project("leaf", "/Users/me/code/app/web", 2),
    ]);
    expect(parentOfMap(tree).get("leaf")).toBe("middle");
  });

  it("makes every workspace a sibling when the grouping does not nest", () => {
    // dsh's plain "Workspaces" grouping: nothing is nested, so any two headers
    // may be reordered against each other.
    const tree = buildProjectTree(NESTED, { nest: false });
    expect([...parentOfMap(tree).values()]).toEqual([null, null, null]);
  });

  it("handles an empty tree", () => {
    expect(parentOfMap([]).size).toBe(0);
  });
});
