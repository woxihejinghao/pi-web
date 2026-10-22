import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceEntry } from "../../lib/types.ts";

// The copy renders through `useT`; pin it to the key so the assertions read one
// string. The render half touches nothing else.
vi.mock("../../lib/app-state.ts", () => ({ useT: () => (key: string) => key }));

const { FilesLevel } = await import("./FilesTab.tsx");
type TreeLevel = Parameters<typeof FilesLevel>[0]["level"];

/**
 * The rows' marks: which glyph a directory gets, which mark a file gets, and
 * what the special levels look like.
 *
 * The artwork itself belongs to `file-type-icon.test.tsx`; what this file is
 * about is the tree's choices — a directory is the folder glyph (open or shut,
 * two separate dsh glyphs rather than one tinted one), a file is the file-type
 * mark, and an unreadable entry gets no mark at all. `FilesLevel` is the drawing
 * half of the tree, so this is a static render.
 */
function entry(name: string, type: WorkspaceEntry["type"]): WorkspaceEntry {
  return { name, path: name, type };
}

function level(entries: WorkspaceEntry[], extra: Partial<TreeLevel> = {}): TreeLevel {
  return { status: "ready", entries, truncated: false, error: null, ...extra };
}

function render(value: TreeLevel): string {
  return renderToStaticMarkup(
    <FilesLevel
      level={value}
      levels={{}}
      expanded={{}}
      onToggle={() => undefined}
      onOpenFile={() => undefined}
    />,
  );
}

describe("FilesLevel marks", () => {
  it("marks a directory with the shut folder glyph", () => {
    const html = render(level([entry("src", "directory")]));
    expect(html).toContain('data-glyph="folderClose"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("data-file-type-mark");
  });

  it("marks a code file with the full-colour square", () => {
    const html = render(level([entry("main.ts", "file")]));
    // The code artwork's own 20px artboard, and no folder glyph: a file row's
    // disclosure slot does not exist in this tree.
    expect(html).toContain('viewBox="0 0 20 20"');
    expect(html).not.toContain('data-glyph="folderClose"');
  });

  it("marks a document with the shared sheet", () => {
    const html = render(level([entry("notes.md", "file")]));
    // The sheet is the other family: its own 28px artboard with a `mark` group
    // inside it, rather than the code square's 20px artboard.
    expect(html).toContain('viewBox="0 0 28 28"');
    expect(html).toContain("data-file-type-mark");
    expect(html).not.toContain('viewBox="0 0 20 20"');
  });

  it("gives an unreadable entry its name and no mark", () => {
    const html = render(level([entry("fifo", "other")]));
    expect(html).toContain("fifo");
    expect(html).not.toContain("data-file-type-mark");
    expect(html).not.toContain("data-glyph");
  });

  it("draws a level as a list, so nesting is the indent", () => {
    const html = render(level([entry("src", "directory")]));
    expect(html).toMatch(/^<ul[^>]*>.*<li[^>]*>.*<\/li><\/ul>$/s);
  });
});

describe("FilesLevel states", () => {
  it("reports an empty level as such rather than as a bare list", () => {
    expect(render(level([]))).toContain("files.empty");
  });

  it("shows the loader while a level has nothing to draw yet", () => {
    expect(render(level([], { status: "loading" }))).toContain("common.loading");
  });

  it("shows the reason when a level could not be read", () => {
    expect(render(level([], { status: "failed", error: "EACCES" }))).toContain("EACCES");
  });

  it("says when a level was cut short", () => {
    expect(render(level([entry("a.txt", "file")], { truncated: true }))).toContain("files.tooMany");
  });
});
