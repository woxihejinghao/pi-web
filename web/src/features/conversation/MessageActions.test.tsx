import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MessageUsage } from "../../lib/types.ts";
import { MessageActions, TurnUsagePill } from "./MessageActions.tsx";

// Read rather than imported: a `?raw` import of a `.module.css` file is still
// resolved as a CSS module (the sheet arrives as the class-name map, not text),
// and this file's whole point is that the rules below are present in the sheet.
const sheet = readFileSync(new URL("./MessageActions.module.css", import.meta.url), "utf8");

/**
 * The sheet without its comments, for the assertions below.
 *
 * They are about rules, and this file's comments necessarily *name* the
 * attributes and the values being looked for — a comment that mentions the
 * `always` attribute must not stand in for a rule that styles it.
 */
const rules = sheet.replace(/\/\*[\s\S]*?\*\//g, "");

// The copy asserted below is the Chinese one, and a bare node environment offers
// no navigator to prefer it. Same reason `MessageList.test.tsx` pins it.
vi.stubGlobal("navigator", { language: "zh-CN" });

const noop = (): void => {};

/** The turn this file bills for: 12,240 tokens, 89% of the prompt cached. */
const usage: MessageUsage = {
  input: 1_200,
  output: 340,
  cacheRead: 10_600,
  cacheWrite: 100,
  totalTokens: 12_240,
};

// Today at 21:00. `MessageActions` asks `useCalendarDay()` for the day, which
// reads the real clock, so a stamped date would render as a date and the
// assertions below would change every day; a row from today renders the clock
// alone, on any day the suite runs.
const sent = (() => {
  const at = new Date();
  at.setHours(21, 0, 0, 0);
  return at.getTime();
})();

function panel(withUsage: MessageUsage, model: string | null = "anthropic/claude-opus-4"): string {
  return renderToStaticMarkup(
    <TurnUsagePill
      usage={withUsage}
      model={model}
      align="start"
      open
      onOpen={noop}
      anchorRef={{ current: null }}
    />,
  );
}

describe("MessageActions row", () => {
  it("reads a prompt's clock before its buttons, and right-aligns them", () => {
    const html = renderToStaticMarkup(
      <MessageActions
        text="你好"
        align="end"
        timestamp={sent}
        forkEntryId="entry-1"
        onFork={noop}
      />,
    );

    // dsh's `clock="start"`: the prompt's own row says when it was sent, then
    // offers the buttons — and it is the row the sheet draws at 15px.
    expect(html).toContain('data-clock="start"');
    expect(html).toContain("21:00");
    expect(html.indexOf("21:00")).toBeLessThan(html.indexOf('data-glyph="copy"'));
    // Copy first, then fork — the order docs/design-notes.md gives the row.
    expect(html.indexOf('data-glyph="copy"')).toBeLessThan(html.indexOf('data-glyph="branch"'));
    expect(html).toContain('aria-label="复制"');
    expect(html).toContain('aria-label="从此处分叉"');
    // dsh's tooltip, not the browser's: no `title` anywhere in the row. The
    // bubble is portalled and only exists once something is hovered or focused,
    // so a static render has to show neither — and the name has to come from
    // `aria-label`, which is what a keyboard user hears.
    expect(html).not.toContain("title=");
    // The bill and the elapsed time belong to the answer, not to the prompt.
    expect(html).not.toContain("用量");
    expect(html).not.toContain("用时");
  });

  it("does not offer a fork when the transcript has no entry to branch from", () => {
    const html = renderToStaticMarkup(
      <MessageActions text="你好" align="end" timestamp={sent} forkEntryId={null} onFork={noop} />,
    );

    expect(html).not.toContain('data-glyph="branch"');
  });

  it("shows an answer's figures with the panel still shut", () => {
    const html = renderToStaticMarkup(
      <MessageActions
        text="好了"
        usage={usage}
        model="anthropic/claude-opus-4"
        durationMs={153_000}
        timestamp={sent}
      />,
    );

    // dsh's `clock="end"`: the answer's time comes after the figures, and this
    // is the row the sheet draws a size larger.
    expect(html).toContain('data-clock="end"');
    expect(html.indexOf("用量 12K tok")).toBeLessThan(html.indexOf("21:00"));
    expect(html).toContain("用时 2分33秒");
    // The pill is a button that opens a dialog, and nothing is open yet.
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
  });

  it("offers no figure at all for a turn that cost nothing", () => {
    const html = renderToStaticMarkup(<MessageActions text="好了" />);

    expect(html).not.toContain("用量");
    expect(html).not.toContain("用时");
    expect(html).not.toContain('aria-haspopup="dialog"');
  });
});

describe("TurnUsagePill panel", () => {
  it("adds up the turn's own buckets instead of showing zeros under the total", () => {
    const html = panel(usage);

    expect(html).toContain("本轮用量");
    // Exact, with separators, in the header; the pill beside it rounds.
    expect(html).toContain("12,240 tok");
    expect(html).toContain("anthropic/claude-opus-4");
    expect(html).toContain("缓存命中");
    expect(html).toContain("89%");
    expect(html).toContain("1,200 tok");
    expect(html).toContain("10,600 tok");
    expect(html).toContain("100 tok");
    expect(html).toContain("340 tok");
  });

  it("drops the provider row for a turn that did not name a model", () => {
    const html = panel(usage, null);

    expect(html).not.toContain("提供方 / 模型");
    // The rest of the panel is still there: only the row is missing.
    expect(html).toContain("12,240 tok");
  });

  it("drops the cache-hit row when there was no prompt to cache", () => {
    // Output only: nothing was billed on the prompt side, so a percentage would
    // be a claim about a denominator that does not exist.
    const html = panel({ input: 0, output: 340, cacheRead: 0, cacheWrite: 0, totalTokens: 340 });

    expect(html).not.toContain("缓存命中");
    expect(html).toContain("340 tok");
  });
});

/**
 * The sheet, read as text.
 *
 * Measurements and visibility are the two things a markup test cannot see: they
 * live in CSS keyed on attributes the transcript writes, so the assertions below
 * are about the stylesheet itself. dsh's own suite pins its sheet the same way —
 * including the rule that nothing may match an `always` row.
 */
describe("MessageActions stylesheet", () => {
  const media = rules.indexOf("@media (hover: hover)");
  const reveal = rules.slice(media);

  it("draws an answer's row a size larger than a prompt's, and only that one", () => {
    // dsh: 15px under a prompt's bubble, 17px on the answer's tail. The value
    // the larger rule keys on is dsh's `clock` — `end` for a tail, which is the
    // opposite of this file's `align="end"` (a prompt), so pin both halves.
    expect(rules).toContain('.actions[data-clock="end"] .action svg');
    expect(rules).toContain("17px + var(--dsh-content-font-delta, 0px)");
    expect(rules).toContain("15px + var(--dsh-content-font-delta, 0px)");
    expect(rules).not.toContain('[data-clock="start"]');
  });

  it("keeps the rule behind a hover-capable pointer", () => {
    // A touch device never hovers, so without this every row but the newest
    // would be invisible for good.
    expect(media).toBeGreaterThan(-1);
    expect(rules.indexOf('[data-actions-reveal="hover"] .actions')).toBeGreaterThan(media);
  });

  it("takes the hidden row out of the transcript's flow", () => {
    // dsh only fades this row (`opacity`), which leaves its 28px band standing
    // under every earlier message; with the transcript's own gaps around it
    // that is a ~62px hole where nobody is touching the row, and a session a
    // few turns old reads as spaced out. The row leaves the layout instead:
    // `absolute` in both states, hung in the gap below its own message.
    expect(reveal).toContain('[data-actions-reveal="hover"] {');
    expect(reveal).toContain("position: relative");
    expect(reveal).toContain('[data-actions-reveal="hover"] .actions');
    expect(reveal).toContain("position: absolute");
    expect(reveal).toContain("top: calc(100% + var(--transcript-gap, 14px))");
    // Without both edges the absolute row shrink-wraps and loses the alignment
    // the row above relies on (`actionsEnd` to the right, `timeStart` left).
    expect(reveal).toContain("left: 0");
    expect(reveal).toContain("right: 0");
    expect(reveal).toContain("opacity: 0");
    expect(reveal).toContain("transition: opacity 80ms ease");
  });

  it("measures the row's gap against the transcript's own rhythm", () => {
    // The row hangs in the space `MessageList.module.css` leaves between turns,
    // so that sheet declares the value and this one reads it; the two numbers
    // have to agree or a hidden row sits off the rhythm it is hiding inside.
    const transcript = readFileSync(
      new URL("./MessageList.module.css", import.meta.url),
      "utf8",
    );
    const declared = /--transcript-gap:\s*(\d+)px/.exec(transcript);
    expect(declared?.[1]).toBe("14");
    expect(rules).toContain("var(--transcript-gap, 14px)");
    // All three of that sheet's gaps — column, turn and turn tail — read the
    // variable, so the row moves with the rhythm instead of with one copy of it.
    expect(transcript.match(/gap: var\(--transcript-gap\)/g)?.length).toBe(3);
    expect(transcript).not.toMatch(/^\s*gap: 14px;/m);
  });

  it("changes nothing but opacity when the row comes back", () => {
    // The reason the row is out of the flow in the first place: revealing it
    // must not re-enter the layout, or the transcript jumps under the pointer.
    const back = reveal.slice(reveal.indexOf('[data-actions-reveal="hover"]:hover'));
    expect(back).toContain("opacity: 1");
    expect(back).not.toContain("position:");
    expect(back).not.toContain("display:");
    expect(back).not.toContain("margin");
  });

  it("brings the row back on hover and on keyboard focus", () => {
    expect(reveal).toContain('[data-actions-reveal="hover"]:hover .actions');
    expect(reveal).toContain('[data-actions-reveal="hover"]:focus-within .actions');
    expect(reveal).toContain("opacity: 1");
  });

  it("never hides a row the transcript marked as always visible", () => {
    // The newest prompt's and the newest answer's rows carry `always`; nothing
    // in the sheet may match it.
    expect(rules).not.toContain('data-actions-reveal="always"');
  });

  it("hangs an answer's row back under the answer's text, and only that row", () => {
    const tail = rules.slice(rules.indexOf(".actionsTail"), rules.indexOf(".actionsEnd"));
    const end = rules.slice(rules.indexOf(".actionsEnd"), rules.indexOf(".action {"));

    // dsh's turn-tail `margin-left: -6px`: the padding the icon needs for a
    // 28px target would otherwise push its glyph 6px right of the text above.
    expect(tail).toContain("margin-left: -6px");
    // A prompt's row is flush with its bubble — dsh draws the same asymmetry.
    expect(end).not.toContain("-6px");
  });
});
