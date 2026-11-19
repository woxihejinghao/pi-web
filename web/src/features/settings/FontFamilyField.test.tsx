import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appStore, resetAppState } from "../../lib/app-state.ts";
import { FontFamilyField } from "./FontFamilyField.tsx";
beforeEach(() => {
  appStore.update((state) => ({ ...state, settings: { ...state.settings, language: "zh-CN" } }));
});
afterEach(() => resetAppState());
function render(value: string): string {
  return renderToStaticMarkup(
    <FontFamilyField
      title="正文字体"
      description="用于界面与会话正文。"
      value={value}
      onCommit={() => undefined}
    />,
  );
}
describe("FontFamilyField", () => {
  it("shows the stored list, its explanation, and the default placeholder", () => {
    const html = render('"Menlo", monospace');
    expect(html).toContain("正文字体");
    expect(html).toContain("用于界面与会话正文。");
    expect(html).toContain("Menlo");
    expect(html).toContain("默认");
  });
  it("shows the placeholder when the built-in stack is in effect", () => {
    const html = render("");
    expect(html).toContain("默认");
    expect(html).not.toContain("Menlo");
  });
});