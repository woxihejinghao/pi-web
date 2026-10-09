import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTurnChangesTab } from "./rightbar-state.ts";
import { TurnChangesTab } from "./TurnChangesTab.tsx";
import { publishTurnChanges, turnChangesStore } from "./turn-changes-store.ts";
import type { TurnFile } from "../conversation/turn-files.ts";

// The panel renders through `useT`; the default `system` preference resolves to
// English without a navigator, so the host locale is pinned for the Chinese copy.
vi.stubGlobal("navigator", { language: "zh-CN" });

const PATCH = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " context",
  "-gone",
  "+kept",
].join("\n");

function file(display: string, overrides: Partial<TurnFile> = {}): TurnFile {
  return {
    path: `/proj/${display}`,
    relative: display,
    display,
    added: 1,
    deleted: 1,
    patches: [PATCH],
    oversized: false,
    ...overrides,
  };
}

const noop = (): void => {};

function draw(turn: number, index = 0): string {
  return renderToStaticMarkup(
    <TurnChangesTab sessionPath="session-a" tab={makeTurnChangesTab(turn, index)} onOpenFile={noop} />,
  );
}

beforeEach(() => {
  turnChangesStore.set({ bySession: {} });
});

describe("TurnChangesTab", () => {
  it("says the changes are unavailable when nothing was published for the turn", () => {
    // A tab restored from a saved layout, or one whose transcript is no longer
    // loaded: there is no snapshot to ask for, so the panel has to say so.
    expect(draw(1)).toContain("这轮改动的内容已不可用");
  });

  it("draws the selected file's comparison", () => {
    publishTurnChanges("session-a", [{ turn: 1, files: [file("src/a.ts")] }]);
    const html = draw(1);

    expect(html).toContain("src/a.ts");
    // Each line is drawn as a marker column plus the text, so the sign and the
    // words are separate nodes — the assertion asks for the text it renders.
    expect(html).toContain(">kept<");
    expect(html).toContain(">gone<");
    expect(html).toContain("选择要查看的文件");
    expect(html).toContain("在右侧栏打开 src/a.ts");
  });

  it("opens on the file the address names, and falls back when it is past the end", () => {
    publishTurnChanges("session-a", [
      { turn: 1, files: [file("src/a.ts"), file("src/b.ts")] },
    ]);

    expect(draw(1, 1)).toContain("src/b.ts");
    // A tab moved to a file the turn no longer lists still draws something.
    expect(draw(1, 7)).toContain("src/a.ts");
  });

  it("reports an oversized write instead of drawing an empty comparison", () => {
    publishTurnChanges("session-a", [
      { turn: 1, files: [file("big.bin", { added: 0, deleted: 0, patches: [], oversized: true })] },
    ]);

    expect(draw(1)).toContain("文件过大，无法显示改动");
  });

  it("draws no open-file control for a path outside the project", () => {
    publishTurnChanges("session-a", [
      { turn: 1, files: [file("/tmp/notes.md", { relative: null })] },
    ]);
    const html = draw(1);

    expect(html).toContain("/tmp/notes.md");
    expect(html).not.toContain("在右侧栏打开 /tmp/notes.md");
  });
});
