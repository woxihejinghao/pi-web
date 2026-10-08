import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { placeMenu, tabMenuActions, TabMenuItems } from "./TabMenu.tsx";

// The items render through `useT`; without a navigator the default `system`
// preference resolves to English. These assertions pin the Chinese wording.
vi.stubGlobal("navigator", { language: "zh-CN" });

/**
 * The chip's context menu.
 *
 * The portalled shell around these items is not covered here: React's *server*
 * renderer refuses portals outright ("Portals are not currently supported by the
 * server renderer"), and this repo's test environment has no DOM. What is
 * covered is the two things with a rule in them — which items a strip offers,
 * and where the menu lands — both of which are pure.
 */
describe("tabMenuActions", () => {
  it("offers only the close item when there is nothing else to offer", () => {
    // Three names for one action would be worse than one: on a single-tab strip
    // "close other tabs" and "close all tabs" both mean "close the tab".
    expect(tabMenuActions(false, false)).toEqual(["close"]);
  });

  it("offers a rename only to the kinds that own their name", () => {
    // A preview is named after its file and a terminal after its shell; the
    // other three are named by the message table, where a stored title would be
    // written and never read.
    expect(tabMenuActions(true, false)).toEqual(["close", "rename"]);
  });

  it("keeps the kit's item first and the strip-wide actions last", () => {
    expect(tabMenuActions(true, true)).toEqual(["close", "rename", "closeOthers", "closeAll"]);
    expect(tabMenuActions(false, true)).toEqual(["close", "closeOthers", "closeAll"]);
  });
});

describe("TabMenuItems", () => {
  it("names the tab it was opened on", () => {
    const html = renderToStaticMarkup(
      <TabMenuItems tabTitle="index.ts" canRename={false} hasSiblings={false} onPick={() => {}} />,
    );
    expect(html).toContain("关闭 index.ts");
  });

  it("draws one item on a single-tab strip", () => {
    const html = renderToStaticMarkup(
      <TabMenuItems tabTitle="终端" canRename={false} hasSiblings={false} onPick={() => {}} />,
    );
    expect((html.match(/role="menuitem"/g) ?? []).length).toBe(1);
    expect(html).not.toContain("关闭其他标签页");
    expect(html).not.toContain("关闭全部标签页");
  });

  it("draws the kit's item first, then the two group actions", () => {
    const html = renderToStaticMarkup(
      <TabMenuItems tabTitle="终端" canRename={false} hasSiblings={true} onPick={() => {}} />,
    );
    const labels = [...html.matchAll(/role="menuitem"[^>]*>([^<]*)</g)].map((match) => match[1]);
    // Order matters: dsh's kit item is the same in every menu, so a reader looks
    // for it in the same place every time; the extension goes after it.
    expect(labels).toEqual(["关闭 终端", "关闭其他标签页", "关闭全部标签页"]);
  });

  it("offers a rename once the tab owns its name", () => {
    const html = renderToStaticMarkup(
      <TabMenuItems tabTitle="zsh" canRename={true} hasSiblings={false} onPick={() => {}} />,
    );
    const labels = [...html.matchAll(/role="menuitem"[^>]*>([^<]*)</g)].map((match) => match[1]);
    // The rename sits between the kit's item and the strip-wide pair: it acts on
    // this one tab, the way close does.
    expect(labels).toEqual(["关闭 zsh", "重命名"]);
  });
});

describe("placeMenu", () => {
  const menu = { offsetWidth: 140, offsetHeight: 96 };
  const viewport = { width: 1200, height: 800 };

  it("hangs down-right from the press", () => {
    expect(placeMenu({ x: 300, y: 200 }, menu, viewport)).toEqual({ top: 200, left: 300 });
  });

  it("flips to the left of the press at the window's right edge", () => {
    // The chip strip lives at the right of the window, so this is the common
    // case rather than the corner case.
    expect(placeMenu({ x: 1150, y: 200 }, menu, viewport)).toEqual({ top: 200, left: 1010 });
  });

  it("flips above the press at the window's bottom edge", () => {
    expect(placeMenu({ x: 300, y: 780 }, menu, viewport)).toEqual({ top: 684, left: 300 });
  });

  it("never lands outside the window, even when it does not fit either way", () => {
    // A window narrower than the menu: flipping cannot help, so the only thing
    // left to guarantee is that the menu is still reachable.
    const narrow = { width: 100, height: 60 };
    expect(placeMenu({ x: 90, y: 50 }, menu, narrow)).toEqual({ top: 2, left: 2 });
  });
});
