import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore, resetAppState } from "../../lib/app-state.ts";
import { Rightbar } from "./Rightbar.tsx";
import { resetRightbarState, rightbarActions } from "./rightbar-state.ts";

// Panel copy renders through `useT`; without a navigator the default `system`
// preference resolves to English. These assertions pin the Chinese wording, so
// fix the host locale for the file.
vi.stubGlobal("navigator", { language: "zh-CN" });

/**
 * Server-rendered covers for the shell.
 *
 * The panel is mostly state plumbing, so these assert the two things a unit
 * test of the store cannot: that nothing is drawn without a session, and that an
 * open surface actually lays out its strip and its active tab's body. Effects do
 * not run in a static render, which is what keeps the tab bodies from reaching
 * for the network here.
 */
function selectSession(sessionPath: string | null): void {
  appStore.update((state) => ({
    ...state,
    projects: [
      { id: "p1", path: "/tmp/demo", title: "demo", order: 0, createdAt: "", updatedAt: "", exists: true },
    ],
    selectedProjectId: "p1",
    selectedSessionPath: sessionPath,
  }));
}

beforeEach(() => {
  resetAppState();
  resetRightbarState();
});

afterEach(() => {
  resetAppState();
  resetRightbarState();
});

describe("Rightbar", () => {
  it("draws nothing without a session", () => {
    selectSession(null);
    rightbarActions.open("sess-1");
    expect(renderToStaticMarkup(<Rightbar />)).toBe("");
  });

  it("draws nothing while the surface is closed", () => {
    selectSession("sess-1");
    rightbarActions.ensureSurface("sess-1");
    expect(renderToStaticMarkup(<Rightbar />)).toBe("");
  });

  it("seeds the Files tab and draws the panel when opened", () => {
    selectSession("sess-1");
    rightbarActions.open("sess-1");
    const html = renderToStaticMarkup(<Rightbar />);
    expect(html).toContain('aria-label="右侧栏"');
    expect(html).toContain("文件");
    // The Files body's header carries the project root path.
    expect(html).toContain("/tmp/demo");
  });

  it("renders the active preview tab with its file name and a loading state", () => {
    selectSession("sess-1");
    rightbarActions.openPreviewTab("sess-1", "docs/setup.md");
    const html = renderToStaticMarkup(<Rightbar />);
    expect(html).toContain("setup.md");
    expect(html).toContain("加载中");
  });

  it("renders the browser tab's address bar and its empty state", () => {
    selectSession("sess-1");
    rightbarActions.openBrowserTab("sess-1", "");
    const html = renderToStaticMarkup(<Rightbar />);
    expect(html).toContain('aria-label="网址"');
    expect(html).toContain("localhost:5173");
    expect(html).toContain("已启用沙箱");
  });

  it("renders the changes tab's loading state", () => {
    selectSession("sess-1");
    rightbarActions.openChangesTab("sess-1");
    const html = renderToStaticMarkup(<Rightbar />);
    expect(html).toContain("文件变更");
    // Effects do not run in a static render, so the body is still its first
    // paint: the header names the surface and git has not been asked yet.
    expect(html).toContain("工作区改动");
    expect(html).toContain("读取改动");
  });

  it("gives a terminal tab a chip, and loads its screen on demand", () => {
    selectSession("sess-1");
    rightbarActions.openTerminalTab("sess-1");
    const html = renderToStaticMarkup(<Rightbar />);
    // The strip is in the main chunk and names the tab straight away...
    expect(html).toContain('title="终端"');
    // ...while the body is behind a `lazy` boundary, so a static render — which
    // never resolves one — draws the fallback. That is the whole point of the
    // split: xterm is ~340 kB and only a terminal tab ever needs it.
    // `TerminalTab.test.tsx` covers what the body draws once it arrives.
    expect(html).toContain("加载中");
  });

  it("prints the keys a control also answers to", () => {
    selectSession("sess-1");
    rightbarActions.open("sess-1");
    const html = renderToStaticMarkup(<Rightbar />);
    // The keycaps come from the same table the keydown listener matches
    // against, so this asserts the whole chain at once: the environment's
    // device, the binding's normalization, the keycap table and the tooltip
    // template. There is no navigator in this render, which is the device whose
    // defaults are the plainest.
    expect(html).toContain('title="收起右栏（Ctrl+Shift+B）"');
    expect(html).toContain('title="全屏显示（Ctrl+Alt+Enter）"');
  });

  it("keeps each session's surface to itself", () => {
    selectSession("sess-a");
    rightbarActions.openPreviewTab("sess-a", "a.md");
    rightbarActions.ensureSurface("sess-b");
    expect(renderToStaticMarkup(<Rightbar />)).toContain("a.md");

    selectSession("sess-b");
    expect(renderToStaticMarkup(<Rightbar />)).toBe("");
  });
});
