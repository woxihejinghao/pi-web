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
import { useSidebarDrag, type RowDragHandlers, type SidebarDrag } from "./use-sidebar-drag.ts";

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
 * The provisional "新会话" row is pinned to the workspace that started it, and
 * survives the user looking elsewhere — a session whose first reply has not
 * landed has no file yet, so this row is the only place it exists.
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
    unsavedSessions?: Record<string, string[]>;
    selectedProjectId?: string | null;
    sessions?: SessionView[];
  }): string {
    const before = appStore.get();
    appStore.set({
      ...before,
      selectedProjectId: state.selectedProjectId ?? "p1",
      expandedProjects: { p1: true },
      selectedSessionPath: state.selectedSessionPath ?? null,
      unsavedSessions: state.unsavedSessions ?? {},
      sessions: { p1: state.sessions ?? [] },
    });
    try {
      return renderToStaticMarkup(<ProjectTreeItem node={workspace()} />);
    } finally {
      appStore.set(before);
    }
  }

  it("pins a draft under the workspace that opened it", () => {
    const html = renderWith({
      selectedSessionPath: "draft:abc",
      unsavedSessions: { p1: ["draft:abc"] },
    });

    expect(html).toContain(">新会话<");
    expect(html).toContain("准备中");
  });

  it("keeps a spawned session provisional until the list catches up", () => {
    // The real path has been swapped in but `sessions` has not refreshed yet.
    const html = renderWith({
      selectedSessionPath: "/sessions/p1/fresh.jsonl",
      unsavedSessions: { p1: ["/sessions/p1/fresh.jsonl"] },
    });

    expect(html).toContain(">新会话<");
    expect(html).toContain("未保存");
  });

  it("keeps a running session's row after the user opens another one", () => {
    // The regression: a session whose first reply has not landed is only known
    // to this browser, and keying the row off the selection dropped it here.
    const html = renderWith({
      selectedSessionPath: "/sessions/p1/other.jsonl",
      unsavedSessions: { p1: ["/sessions/p1/running.jsonl"] },
    });

    expect(html).toContain(">新会话<");
    expect(html).toContain("未保存");
  });

  it("keeps every unsaved session when another is started", () => {
    const html = renderWith({
      selectedSessionPath: "draft:second",
      unsavedSessions: { p1: ["draft:second", "/sessions/p1/first.jsonl"] },
    });

    expect(html.match(/>新会话</g)).toHaveLength(2);
  });

  it("does not claim a conversation opened in another workspace", () => {
    const html = renderWith({
      selectedSessionPath: "/sessions/p2/other.jsonl",
      unsavedSessions: { p2: ["/sessions/p2/other.jsonl"] },
    });

    expect(html).not.toContain(">新会话<");
  });

  it("leaves the row to the real session once it is in the list", () => {
    const html = renderWith({
      selectedSessionPath: "/sessions/p1/here.jsonl",
      unsavedSessions: { p1: ["/sessions/p1/here.jsonl"] },
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
      unsavedSessions: {},
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

/**
 * The rows are one page of the server's answer: what is still folded away is
 * counted by `sessionTotals`, not by however many sessions the sidebar happens
 * to be holding.
 */
describe("ProjectTree session page", () => {
  const session = (path: string): SessionView => ({
    path,
    id: path,
    cwd: "/Users/dev/proj",
    title: `session ${path}`,
    titleSource: "session",
    preview: "",
    created: "2025-01-01T00:00:00.000Z",
    modified: "2025-01-01T00:00:00.000Z",
    messageCount: 1,
    hidden: false,
  });

  /** Render a workspace holding `sessions`, which `total` says are not all of them. */
  function renderWith(sessions: SessionView[], total: number): string {
    const before = appStore.get();
    appStore.set({
      ...before,
      selectedProjectId: "p1",
      expandedProjects: { p1: true },
      selectedSessionPath: null,
      unsavedSessions: {},
      sessions: { p1: sessions },
      sessionTotals: { p1: total },
      revealedSessions: {},
      sessionQuery: "",
    });
    try {
      return renderToStaticMarkup(<ProjectTreeItem node={workspace()} />);
    } finally {
      appStore.set(before);
    }
  }

  const page = Array.from({ length: 5 }, (_, index) => session(`/sessions/p1/${index}.jsonl`));

  it("counts the folded rows from the server's total", () => {
    expect(renderWith(page, 7)).toContain("展开其余 2 个会话");
  });

  it("offers nothing more once the page is the whole list", () => {
    expect(renderWith(page, 5)).not.toContain("展开其余");
  });
});

/**
 * A search filters the loaded rows, and a workspace with nothing left folds
 * away entirely. The bail-out that does the folding has to sit after the
 * component's hooks (see `ProjectTree.tsx`): returning above them makes the
 * component render a different number of hooks than its previous render, and
 * React treats that as a crash — which is exactly what typing in the sidebar's
 * field used to do.
 */
describe("ProjectTree search", () => {
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

  function renderSearch(sessions: SessionView[], query: string): string {
    const before = appStore.get();
    appStore.set({
      ...before,
      selectedProjectId: "p1",
      expandedProjects: { p1: true },
      selectedSessionPath: null,
      unsavedSessions: {},
      sessions: { p1: sessions },
      sessionTotals: { p1: sessions.length },
      revealedSessions: {},
      sessionQuery: query,
    });
    try {
      return renderToStaticMarkup(<ProjectTreeItem node={workspace()} />);
    } finally {
      appStore.set(before);
    }
  }

  const sessions = [session("/sessions/p1/a.jsonl", "alpha"), session("/sessions/p1/b.jsonl", "beta")];

  it("keeps only the rows whose title matches", () => {
    const html = renderSearch(sessions, "alph");
    expect(html).toContain("alpha");
    expect(html).not.toContain("beta");
  });

  it("folds the whole workspace away when nothing matches it", () => {
    expect(renderSearch(sessions, "zzz")).toBe("");
  });
});

/**
 * The drag wiring is a hook, so a static render of rows cannot see it directly.
 * This probe calls it and prints what one row was handed.
 */
function DragProbe({ accountKey, path }: { accountKey: string; path: string }) {
  const row = useSidebarDrag([]).sessionRow(accountKey, path);
  return (
    <span
      data-draggable={String(row.draggable)}
      data-marker={String(row.marker)}
    />
  );
}

describe("useSidebarDrag", () => {
  it("offers a drag for a session with a file on disk", () => {
    const html = renderToStaticMarkup(
      <DragProbe accountKey="p1" path="/sessions/p1/one.jsonl" />,
    );
    expect(html).toContain('data-draggable="true"');
    // Nothing is being dragged yet, so no row draws a marker.
    expect(html).toContain('data-marker="null"');
  });

  it("leaves a draft out: it has no position to save", () => {
    const html = renderToStaticMarkup(<DragProbe accountKey="p1" path="draft:7" />);
    expect(html).toContain('data-draggable="false"');
  });
});

/**
 * The insert marker is a class on the row, and the row only gets it from the
 * drag wiring — so this hands the renderer a wiring that reports one, which is
 * exactly what a pointer hovering that row would produce.
 */
describe("ProjectTree drop markers", () => {
  const MARKED = "/sessions/p1/two.jsonl";

  const row = (marker: "before" | "after" | null): RowDragHandlers => ({
    draggable: true,
    marker,
    onDragStart: () => undefined,
    onDragEnd: () => undefined,
    onDragOver: () => undefined,
    onDrop: () => undefined,
  });

  const drag: SidebarDrag = {
    sessionRow: (_accountKey, path) => row(path === MARKED ? "before" : null),
    projectRow: () => row(null),
  };

  const session = (path: string, title: string): SessionView => ({
    path,
    id: path,
    cwd: "/Users/dev/proj",
    title,
    titleSource: "session",
    preview: "",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    hidden: false,
  });

  it("marks the row the pointer is over — and only that row", () => {
    const before = appStore.get();
    appStore.set({
      ...before,
      selectedProjectId: "p1",
      expandedProjects: { p1: true },
      sessions: { p1: [session("/sessions/p1/one.jsonl", "one"), session(MARKED, "two")] },
      sessionTotals: { p1: 2 },
      revealedSessions: {},
      unsavedSessions: {},
      sessionQuery: "",
    });
    try {
      const html = renderToStaticMarkup(<ProjectTreeItem node={workspace()} drag={drag} />);
      expect(html).toContain("dropBefore");
      expect(html).not.toContain("dropAfter");
      // One row carries it; the other does not.
      expect(html.match(/dropBefore/g)).toHaveLength(1);
    } finally {
      appStore.set(before);
    }
  });
});
