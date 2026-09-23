import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { appStore } from "../../lib/app-state.ts";
import type { ProjectNode } from "../../lib/project-tree.ts";
import type { ProjectView } from "../../lib/types.ts";
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
