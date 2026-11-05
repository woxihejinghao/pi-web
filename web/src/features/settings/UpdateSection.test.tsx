import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { appStore, resetAppState } from "../../lib/app-state.ts";
import { UpdateSection } from "./UpdateSection.tsx";

afterEach(() => resetAppState());

describe("UpdateSection", () => {
  it.each([
    ["zh-CN", "项目版本", "检查更新", "pi 版本"],
    ["en", "Project version", "Check for updates", "pi version"],
  ] as const)("only shows the project version in %s", (language, projectLabel, checkLabel, piLabel) => {
    const state = appStore.get();
    appStore.set({ ...state, settings: { ...state.settings, language } });
    const html = renderToStaticMarkup(<UpdateSection projectPath={null} />);

    expect(html).toContain(projectLabel);
    expect(html).toContain(checkLabel);
    expect(html).not.toContain(piLabel);
    expect(html).not.toContain("@earendil-works/pi-coding-agent");
  });
});
