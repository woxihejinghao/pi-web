import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppState } from "../../lib/app-state.ts";
import { composerDraftFor } from "../../lib/composer-drafts.ts";
import { SessionRow } from "./ProjectTree.tsx";
import { NO_DRAG } from "./use-sidebar-drag.ts";

const PATH = "/sessions/one.jsonl";
function row(path = PATH): string {
  return renderToStaticMarkup(<SessionRow
    sessionPath={path} title="A conversation" time="5 分钟前"
    active={false} external={false} indent={0} drag={NO_DRAG.sessionRow("p1", path)}
    status={{ state: "ongoing", label: "session.statusRunning" }}
  />);
}

beforeEach(() => {
  resetAppState();
  vi.stubGlobal("navigator", { language: "zh-CN" });
});
afterEach(() => vi.unstubAllGlobals());

describe("session row draft marker", () => {
  it("shows unsent text beside the title without hiding run status or time", () => {
    const draft = composerDraftFor(PATH);
    draft.update((state) => ({ ...state, text: "unsent" }));
    const html = row();
    expect(html).toContain('title="有尚未发送的内容"');
    expect(html).toContain("草稿</span>");
    expect(html).toContain("进行中");
    expect(html).toContain("5 分钟前");
    expect(row("/sessions/other.jsonl")).not.toContain("草稿</span>");
    draft.update((state) => ({ ...state, text: "" }));
    expect(row()).not.toContain("草稿</span>");
  });

  it("marks an image-only draft and removes the marker with its final attachment", () => {
    const draft = composerDraftFor(PATH);
    draft.update((state) => ({ ...state, images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }));
    expect(row()).toContain("草稿</span>");
    draft.update((state) => ({ ...state, images: [] }));
    expect(row()).not.toContain("草稿</span>");
  });

  it("does not mark whitespace or an empty in-flight send as a draft", () => {
    const draft = composerDraftFor(PATH);
    draft.update((state) => ({ ...state, text: " \n " }));
    expect(row()).not.toContain("草稿</span>");
    draft.update((state) => ({ ...state, text: "", sending: true }));
    expect(row()).not.toContain("草稿</span>");
  });
});
