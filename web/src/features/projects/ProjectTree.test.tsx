import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it , vi } from "vitest";

// Interface copy resolves through `useT`, and the default `system` preference
// lands on English without a navigator (node test environment). The assertions
// below pin the Chinese wording, so fix the host locale here.
vi.stubGlobal("navigator", { language: "zh-CN" });
import { appStore, type PendingUiRequest } from "../../lib/app-state.ts";
import type { ProjectNode } from "../../lib/project-tree.ts";
import type { ProjectView, SessionView } from "../../lib/types.ts";
import { ProjectTreeItem } from "./ProjectTree.tsx";

function workspace(overrides: Partial<ProjectView> = {}): ProjectNode {
  return {
    project: {
      id: "p1",
      path: "/Users/dev/proj",
      title: "proj",
      order: 0,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      exists: true,
      ...overrides,
    },
    children: [],
    depth: 0,
  };
}

/**
 * The workspace row carries two actions now, not four: creating a session for
 * that workspace, and one `...` that folds rename and removal into a menu.
 */
describe("ProjectTree workspace row", () => {
  it("folds rename and removal behind a single overflow trigger", () => {
    const html = renderToStaticMarkup(<ProjectTreeItem node={workspace()} />);

    expect(html).toContain("更多操作 proj");
    expect(html).toContain('aria-haspopup="menu"');
    // The two former buttons are gone from the row itself.
    expect(html).not.toContain('aria-label="重命名 proj"');
    expect(html).not.toContain('aria-label="移除 proj"');
  });

  it("offers a new session for that workspace", () => {
    const html = renderToStaticMarkup(<ProjectTreeItem node={workspace()} />);

    expect(html).toContain("在 proj 中新建会话");
  });

  it("keeps the overflow menu closed until it is asked for", () => {
    const html = renderToStaticMarkup(<ProjectTreeItem node={workspace()} />);

    expect(html).not.toContain("删除工作区");
  });
});

/**
 * dsh's leading slot: an outlined folder while collapsed, a filled one while
 * open, and the disclosure caret only under the pointer.
 */
describe("ProjectTree workspace mark", () => {
  /** The two folder states are separate dsh glyphs, so they are named, not tinted. */
  const marked = (html: string, glyph: string): boolean => html.includes(`data-glyph="${glyph}"`);

  /** Render with the app store in a given shape, then put it back. */
  function renderWith(state: { selected?: string; expanded?: boolean }): string {
    const before = appStore.get();
    appStore.set({
      ...before,
      selectedProjectId: state.selected ?? null,
      expandedProjects: state.expanded === true ? { p1: true } : {},
    });
    try {
      return renderToStaticMarkup(<ProjectTreeItem node={workspace()} />);
    } finally {
      appStore.set(before);
    }
  }

  const openAndSelected = { selected: "p1", expanded: true };

  it("draws dsh's closed folder while the workspace is collapsed", () => {
    const html = renderWith({ expanded: false });

    expect(marked(html, "folderClose")).toBe(true);
    expect(marked(html, "folderOpen")).toBe(false);
  });

  it("swaps in the open folder once the workspace is expanded", () => {
    const html = renderWith(openAndSelected);

    expect(marked(html, "folderOpen")).toBe(true);
    expect(marked(html, "folderClose")).toBe(false);
    expect(html).toContain("projectCaretOpen");
  });

  it("tints the mark but never the name", () => {
    const open = renderWith(openAndSelected);
    const collapsed = renderWith({ selected: "p1", expanded: false });

    expect(open).toContain("projectGlyphAccent");
    expect(collapsed).not.toContain("projectGlyphAccent");
    // The name is what the workspace is called, not what state it is in.
    expect(open).not.toContain("projectTitleAccent");
    expect(collapsed).not.toContain("projectTitleAccent");
  });

  it("starts the caret on its closed side", () => {
    const html = renderWith({ expanded: false });

    expect(marked(html, "caretRight")).toBe(true);
    expect(html).not.toContain("projectCaretOpen");
  });
});

/**
 * The provisional "新会话" row is pinned to the workspace that started it.
 *
 * Selecting a workspace deliberately does not close the conversation you were
 * reading, so a session opened elsewhere also fails `all.some(...)`: ownership
 * has to be named, not inferred from the path.
 */
describe("ProjectTree new-session row", () => {
  const session = (path: string, title: string): SessionView => ({
    path,
    id: path,
    cwd: "/Users/dev/proj",
    title,
    titleSource: "session",
    preview: "",
    created: "2025-01-01T00:00:00.000Z",
    modified: "2025-01-01T00:00:00.000Z",
    messageCount: 1,
    hidden: false,
  });

  /** Render with the app store in a given shape, then put it back. */
  function renderWith(state: {
    selectedSessionPath?: string | null;
    draftProjectId?: string | null;
    selectedProjectId?: string | null;
    sessions?: SessionView[];
  }): string {
    const before = appStore.get();
    appStore.set({
      ...before,
      selectedProjectId: state.selectedProjectId ?? "p1",
      expandedProjects: { p1: true },
      selectedSessionPath: state.selectedSessionPath ?? null,
      draftProjectId: state.draftProjectId ?? null,
      sessions: { p1: state.sessions ?? [] },
    });
    try {
      return renderToStaticMarkup(<ProjectTreeItem node={workspace()} />);
    } finally {
      appStore.set(before);
    }
  }

  it("pins a draft under the workspace that opened it", () => {
    const html = renderWith({ selectedSessionPath: "draft:abc", draftProjectId: "p1" });

    expect(html).toContain(">新会话<");
    expect(html).toContain("准备中");
  });

  it("keeps a spawned session provisional until the list catches up", () => {
    // The real path has been swapped in but `sessions` has not refreshed yet.
    const html = renderWith({
      selectedSessionPath: "/sessions/p1/fresh.jsonl",
      draftProjectId: "p1",
    });

    expect(html).toContain(">新会话<");
    expect(html).toContain("未保存");
  });

  it("does not claim a conversation opened in another workspace", () => {
    const html = renderWith({
      selectedSessionPath: "/sessions/p2/other.jsonl",
      draftProjectId: "p2",
    });

    expect(html).not.toContain(">新会话<");
  });

  it("leaves the row to the real session once it is in the list", () => {
    const html = renderWith({
      selectedSessionPath: "/sessions/p1/here.jsonl",
      draftProjectId: "p1",
      sessions: [session("/sessions/p1/here.jsonl", "already here")],
    });

    expect(html).not.toContain(">新会话<");
    expect(html).toContain("already here");
  });
});

/**
 * dsh's run-state mark on a session row: a chase of cells while the session is
 * running, a settled dot for a finished run the user has not opened yet. An
 * idle session keeps the clean left edge and shows neither.
 */
describe("ProjectTree session status mark", () => {
  const PATH = "/sessions/p1/live.jsonl";

  const session = (path: string, title: string): SessionView => ({
    path,
    id: path,
    cwd: "/Users/dev/proj",
    title,
    titleSource: "session",
    preview: "",
    created: "2025-01-01T00:00:00.000Z",
    modified: "2025-01-01T00:00:00.000Z",
    messageCount: 1,
    hidden: false,
  });

  /** Render the workspace with the given marks, then put the store back. */
  function renderWith(
    activity: Record<string, "ongoing" | "done">,
    pending: PendingUiRequest[] = [],
  ): string {
    const before = appStore.get();
    appStore.set({
      ...before,
      selectedProjectId: "p1",
      expandedProjects: { p1: true },
      selectedSessionPath: null,
      draftProjectId: null,
      sessions: { p1: [session(PATH, "live run")] },
      sessionActivity: activity,
      pendingUiRequests: pending,
    });
    try {
      return renderToStaticMarkup(<ProjectTreeItem node={workspace()} />);
    } finally {
      appStore.set(before);
    }
  }

  const asking = (sessionPath: string, method: "select" | "confirm" = "confirm"): PendingUiRequest => ({
    sessionPath,
    request: { type: "extension_ui_request", id: `q-${sessionPath}`, method },
  });

  it("draws the ongoing chase while the session is running", () => {
    const html = renderWith({ [PATH]: "ongoing" });

    expect(html).toContain('data-state="ongoing"');
    expect(html).toContain("进行中");
  });

  it("draws a settled dot for a finished run the user has not opened", () => {
    const html = renderWith({ [PATH]: "done" });

    expect(html).toContain('data-state="done"');
    expect(html).toContain("已完成");
  });

  it("leaves an idle session without a mark", () => {
    const html = renderWith({});

    expect(html).not.toContain('data-state="ongoing"');
    expect(html).not.toContain("进行中");
    expect(html).not.toContain("已完成");
  });

  it("turns warning while an extension is blocked on the session", () => {
    const html = renderWith({}, [asking(PATH, "select")]);

    expect(html).toContain('data-state="warning"');
    expect(html).toContain("等待回答");
  });

  it("lets the pending question outrank a running agent", () => {
    const html = renderWith({ [PATH]: "ongoing" }, [asking(PATH)]);

    expect(html).toContain('data-state="warning"');
    expect(html).not.toContain('data-state="ongoing"');
  });

  it("does not mark a session the question belongs to another one", () => {
    const html = renderWith({}, [asking("/sessions/p1/other.jsonl")]);

    expect(html).not.toContain('data-state="warning"');
    expect(html).not.toContain("等待回答");
  });
});
