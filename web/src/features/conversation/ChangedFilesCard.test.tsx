import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangedFilesCard } from "./ChangedFilesCard.tsx";
import type { TurnFile } from "./turn-files.ts";

function file(display: string, overrides: Partial<TurnFile> = {}): TurnFile {
  return {
    path: `/proj/${display}`,
    relative: display,
    display,
    tools: ["编辑"],
    calls: 1,
    ...overrides,
  };
}

const noop = (): void => {};

/**
 * Static covers for the card.
 *
 * The card is a list plus one piece of arithmetic (the fold), and the arithmetic
 * is the part that can be wrong without looking wrong — so it is asserted at the
 * boundary (three rows shown, four folded) rather than through clicks, which a
 * static render cannot make anyway.
 */
describe("ChangedFilesCard", () => {
  it("shows every row when the turn fits under the fold", () => {
    const html = renderToStaticMarkup(
      <ChangedFilesCard files={[file("a.ts"), file("b.ts")]} onOpenFile={noop} />,
    );

    expect(html).toContain("已编辑 2 个文件");
    expect(html).toContain("a.ts");
    expect(html).toContain("b.ts");
    // Nothing hidden: no fold control to click.
    expect(html).not.toContain("全部");
  });

  it("folds past the third row and says how many are hidden", () => {
    const files = [file("a.ts"), file("b.ts"), file("c.ts"), file("d.ts")];
    const html = renderToStaticMarkup(<ChangedFilesCard files={files} onOpenFile={noop} />);

    expect(html).toContain("已编辑 4 个文件");
    expect(html).toContain("c.ts");
    expect(html).not.toContain("d.ts");
    expect(html).toContain("全部 4 个文件");
    expect(html).toContain("展开全部 4 个改动文件");
  });

  it("makes rows previewable, and opens the first file from the header", () => {
    const html = renderToStaticMarkup(<ChangedFilesCard files={[file("src/a.ts")]} onOpenFile={noop} />);

    expect(html).toContain("在右侧栏预览 src/a.ts");
    expect(html).toContain("在右侧栏预览本轮改动");
  });

  it("lists a file outside the project without making it clickable", () => {
    const outside = file("/tmp/notes.md", { relative: null });
    const html = renderToStaticMarkup(<ChangedFilesCard files={[outside]} onOpenFile={noop} />);

    expect(html).toContain("/tmp/notes.md");
    expect(html).not.toContain("在右侧栏预览 /tmp/notes.md");
    // With nothing openable the header is not a button either.
    expect(html).not.toContain("在右侧栏预览本轮改动");
  });

  it("draws the card without a handler as plain, unclickable rows", () => {
    const html = renderToStaticMarkup(<ChangedFilesCard files={[file("a.ts")]} />);

    expect(html).toContain("已编辑 1 个文件");
    expect(html).not.toContain("在右侧栏预览 a.ts");
  });

  it("names both tools and the call count on a repeatedly written file", () => {
    const html = renderToStaticMarkup(
      <ChangedFilesCard
        files={[file("a.ts", { tools: ["编辑", "写入"], calls: 3 })]}
        onOpenFile={noop}
      />,
    );

    expect(html).toContain("编辑 · 写入 ×3");
    expect(html).toContain("编辑 1 · 写入 1");
  });
});
