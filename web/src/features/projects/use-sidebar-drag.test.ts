import { createElement, type DragEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actions, appStore } from "../../lib/app-state.ts";
import { buildProjectTree } from "../../lib/project-tree.ts";
import type { ProjectView, SessionView } from "../../lib/types.ts";
import { parentOfMap, useSidebarDrag, type SidebarDrag } from "./use-sidebar-drag.ts";

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

describe("chat drops onto workspace headers", () => {
  let previous: ReturnType<typeof appStore.get>;
  let wiring: SidebarDrag;
  let confirm: ReturnType<typeof vi.fn>;
  const path = "/sessions/source/chat.jsonl";
  const source = project("source", "/workspace/source", 0);
  const target = project("target", "/workspace/target", 1);
  const session: SessionView = {
    path, id: "chat", cwd: source.path, title: "Chat to move", titleSource: "firstMessage",
    preview: "", created: source.createdAt, modified: source.updatedAt, messageCount: 1, hidden: false,
  };
  const event = () => ({
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    dataTransfer: { effectAllowed: "none", dropEffect: "none", setData: vi.fn() },
    currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 30 }) }, clientY: 5,
  }) as unknown as DragEvent<HTMLElement>;

  beforeEach(() => {
    previous = appStore.get();
    appStore.set({ ...previous, projects: [source, target], sessions: { source: [session], target: [] } });
    confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm });
    vi.spyOn(actions, "moveChatSession").mockResolvedValue(true);
    vi.spyOn(actions, "moveSession").mockImplementation(() => undefined);
    vi.spyOn(actions, "moveProject").mockResolvedValue(undefined);
    function Probe() {
      wiring = useSidebarDrag(buildProjectTree([source, target]));
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
  });
  afterEach(() => {
    appStore.set(previous);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("confirms and moves once to an empty workspace, not its ordering action", () => {
    wiring.sessionRow(source.id, path).onDragStart(event());
    const destination = wiring.projectRow(target.id);
    const hover = event();
    destination.onDragOver(hover);
    expect(hover.preventDefault).toHaveBeenCalled();
    destination.onDrop(event());
    destination.onDrop(event());
    wiring.sessionRow(source.id, path).onDragEnd();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain(target.path);
    expect(actions.moveChatSession).toHaveBeenCalledTimes(1);
    expect(actions.moveChatSession).toHaveBeenCalledWith(path, target.path);
    expect(actions.moveProject).not.toHaveBeenCalled();
    expect(actions.moveSession).not.toHaveBeenCalled();
  });

  it("does nothing after cancellation", () => {
    confirm.mockReturnValue(false);
    wiring.sessionRow(source.id, path).onDragStart(event());
    wiring.projectRow(target.id).onDrop(event());
    expect(confirm).toHaveBeenCalledOnce();
    expect(actions.moveChatSession).not.toHaveBeenCalled();
  });

  it("rejects the source workspace, unsaved chats and missing destination folders", () => {
    wiring.sessionRow(source.id, path).onDragStart(event());
    wiring.projectRow(source.id).onDrop(event());
    wiring.sessionRow(source.id, "draft:1").onDragStart(event());
    wiring.sessionRow(source.id, path).onDragEnd();
    wiring.projectRow(target.id).onDrop(event());
    wiring.sessionRow(source.id, "/sessions/unsaved.jsonl").onDragStart(event());
    wiring.projectRow(target.id).onDrop(event());
    appStore.update((state) => ({ ...state, projects: [source, { ...target, exists: false }] }));
    wiring.sessionRow(source.id, path).onDragStart(event());
    wiring.projectRow(target.id).onDrop(event());
    expect(confirm).not.toHaveBeenCalled();
    expect(actions.moveChatSession).not.toHaveBeenCalled();
  });

  it("retains chat reordering within the same workspace", () => {
    const sibling = { ...session, id: "second", path: "/sessions/source/second.jsonl" };
    appStore.update((state) => ({ ...state, sessions: { source: [session, sibling] } }));
    wiring.sessionRow(source.id, path).onDragStart(event());
    wiring.sessionRow(source.id, sibling.path).onDrop(event());
    expect(actions.moveSession).toHaveBeenCalledWith(source.id, [path, sibling.path], path, sibling.path, "before");
    expect(actions.moveChatSession).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("retains workspace reordering when a workspace, rather than a chat, is dragged", () => {
    wiring.projectRow(source.id).onDragStart(event());
    wiring.projectRow(target.id).onDrop(event());
    expect(actions.moveProject).toHaveBeenCalledTimes(1);
    expect(actions.moveProject).toHaveBeenCalledWith(source.id, target.id);
    expect(actions.moveChatSession).not.toHaveBeenCalled();
  });
});
