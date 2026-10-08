import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppState } from "../../lib/app-state.ts";
import { makeTerminalTab } from "./rightbar-state.ts";
import { resetTerminalState } from "./terminal-state.ts";
import { TerminalTab } from "./TerminalTab.tsx";

// The body's copy renders through `useT`, which falls back to the host locale
// when the preference is `system`. Pin it so the Chinese wording is asserted.
vi.stubGlobal("navigator", { language: "zh-CN" });

beforeEach(() => {
  resetAppState();
  resetTerminalState();
});

afterEach(() => {
  resetAppState();
  resetTerminalState();
});

/**
 * The terminal body, on its own.
 *
 * `Rightbar.test.tsx` can only reach this component's `lazy` fallback, so what
 * the body itself draws is covered here by rendering it directly.
 *
 * This is its first paint and nothing more: a static render does not run
 * effects, so the shell is never opened, no host is asked anything, and the
 * later phases — the exit bar, the failure overlay — are unreachable from here.
 * Those are driven by `terminal-state.ts`, which is covered on its own; the
 * remaining risk is the wiring between the two, and that is what the live
 * checks below the panel's own tests are for.
 */
describe("TerminalTab", () => {
  it("shows that a shell is starting, over a screen that is already mounted", () => {
    const html = renderToStaticMarkup(
      <TerminalTab
        sessionPath="sess-1"
        projectPath="/tmp/demo"
        tabKey="sess-1"
        tab={makeTerminalTab("")}
      />,
    );
    expect(html).toContain("正在启动 shell…");
    // xterm needs a laid-out element to measure before the PTY is asked for its
    // size, so the holder has to be in the very first paint — not swapped in
    // once the shell answers.
    expect(html).toContain("screen");
    // Nothing to report yet, so no exit bar.
    expect(html).not.toContain("重新启动");
  });
});
