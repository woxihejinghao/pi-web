import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, AssistantMessage, ContentBlock, Usage } from "../../lib/types.ts";
import { EMPTY_TIMING, sessionStats } from "./stats-model.ts";
import { SessionStats } from "./SessionStats.tsx";

// Same reason `MessageList.test.tsx` pins it: the copy asserted below is the
// Chinese one, and a bare node environment offers no navigator to prefer it.
vi.stubGlobal("navigator", { language: "zh-CN" });

const text = (value: string): ContentBlock => ({ type: "text", text: value });

function answered(usage?: Usage): AssistantMessage {
  return {
    role: "assistant",
    content: [text("done")],
    timestamp: 2,
    ...(usage === undefined ? {} : { usage }),
  };
}

function asked(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function render(messages: AgentMessage[]): string {
  return renderToStaticMarkup(<SessionStats stats={sessionStats(messages, EMPTY_TIMING)} />);
}

/**
 * The row's box, not its contents, is what these tests are here for.
 *
 * dsh hides the whole row until the session has a step or a token. This port
 * cannot: the row is a flex item of the pane's column, so unmounting it shortens
 * the column by the row's height and drops the composer onto the window edge —
 * and the transcript is momentarily empty on every session switch, which makes
 * that a jump the reader sees. The row therefore always renders, and only the
 * pills inside it come and go; `min-height` in the stylesheet keeps the empty
 * box the same height as the full one.
 */
describe("SessionStats row", () => {
  it("keeps its row on screen when nothing has been reported yet", () => {
    const markup = render([]);
    expect(markup).toContain("data-composer-stats");
    // No pill, and in particular no "0 轮 0 步": only the box is left behind.
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("轮");
    expect(markup).not.toContain("tok");
  });

  it("keeps the row when the transcript has only the user's side", () => {
    // A prompt that has not been answered yet: a turn, but no step and no bill.
    const markup = render([asked("hi")]);
    expect(markup).toContain("data-composer-stats");
    expect(markup).not.toContain("<button");
  });

  it("fills the row in once the session has a step", () => {
    const markup = render([asked("hi"), answered()]);
    expect(markup).toContain("1 轮 1 步");
  });

  it("adds the token pill once something was billed", () => {
    const markup = render([
      asked("hi"),
      answered({ input: 100, output: 50, cacheRead: 900, cacheWrite: 0 }),
    ]);
    expect(markup).toContain("缓存命中 90%");
    expect(markup).toContain("tok");
    // Both pills, so the row is at its full height by construction: the counts
    // and the token total. Only the usage pill is a button — the time pill stays
    // a plain label when this client measured no wall times, which EMPTY_TIMING
    // is.
    expect(markup).toContain("1 轮 1 步");
    expect(markup.match(/<button/g) ?? []).toHaveLength(1);
  });
});
