import { describe, expect, it } from "vitest";
import { PROMPT_PREVIEW_LIMIT, RESPONSE_PREVIEW_LIMIT, groupTurns, preview } from "./turn-rail.ts";
import type { AgentMessage } from "../../lib/types.ts";

const user = (text: string): AgentMessage =>
  ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;
const assistant = (text: string): AgentMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;
const toolResult = (id: string): AgentMessage =>
  ({ role: "toolResult", toolCallId: id, content: [], timestamp: 0 }) as AgentMessage;

describe("preview", () => {
  it("returns an empty string for no parts", () => {
    expect(preview([], 50)).toBe("");
  });

  it("joins parts with a single space", () => {
    expect(preview(["hello", "world"], 50)).toBe("hello world");
  });

  it("collapses newlines and runs of whitespace", () => {
    expect(preview(["a\n\n  b\t c"], 50)).toBe("a b c");
  });

  it("leaves text that exactly fits untouched", () => {
    const exact = "x".repeat(49);
    expect(preview([exact], 50)).toBe(exact);
    expect(preview([exact], 50)).not.toContain("…");
  });

  it("truncates past the budget with a trailing ellipsis", () => {
    const long = "y".repeat(200);
    const result = preview([long], 50);
    expect(result.endsWith("…")).toBe(true);
    // The ellipsis replaces the last character, so the total stays at the limit.
    expect(result.length).toBe(50);
    expect(result.slice(0, 49)).toBe("y".repeat(49));
  });

  it("cuts mid-word rather than backing up to a word boundary", () => {
    // dsh slices at the character budget and lets the CSS clamp draw the
    // ellipsis, so the cut is raw: 11 characters of "word word word ..." is
    // "word word w". Rounding back to a word here would silently shorten the
    // card relative to the real text.
    expect(preview(["word ".repeat(30)], 12)).toBe("word word w…");
  });

  it("marks a clipped part even when the joined total is short", () => {
    // One part far past the budget sets `unread`, so the result still signals
    // that more text exists.
    const result = preview(["short", "z".repeat(500)], 50);
    expect(result.endsWith("…")).toBe(true);
  });

  it("keeps the prompt budget small enough for one clamped line", () => {
    expect(PROMPT_PREVIEW_LIMIT).toBe(50);
    expect(RESPONSE_PREVIEW_LIMIT).toBe(120);
  });
});

describe("groupTurns", () => {
  it("returns nothing for an empty transcript", () => {
    expect(groupTurns([])).toEqual([]);
  });

  it("numbers turns from 1 and opens one per user message", () => {
    const turns = groupTurns([user("first"), assistant("a"), user("second"), assistant("b")]);
    expect(turns.map((turn) => turn.turn)).toEqual([1, 2]);
    expect(turns.map((turn) => turn.prompt)).toEqual(["first", "second"]);
    expect(turns.map((turn) => turn.response)).toEqual(["a", "b"]);
  });

  it("keeps tool round-trips inside the turn that drove them", () => {
    const turns = groupTurns([
      user("edit the file"),
      assistant("working on it"),
      toolResult("call-1"),
      assistant("done"),
      user("thanks"),
    ]);
    expect(turns).toHaveLength(2);
    // The tool result renders inside its own row, so it is not a turn message.
    expect(turns[0]!.messages).toHaveLength(3);
    expect(turns[0]!.messages.every((message) => message.role !== "toolResult")).toBe(true);
    expect(turns[0]!.response).toBe("working on it done");
    expect(turns[1]!.prompt).toBe("thanks");
  });

  it("folds assistant output that precedes any user message into turn 1", () => {
    // A forked or resumed session can open mid-turn.
    const turns = groupTurns([assistant("already talking"), user("hi")]);
    expect(turns.map((turn) => turn.turn)).toEqual([1, 2]);
    expect(turns[0]!.prompt).toBe("");
    expect(turns[0]!.response).toBe("already talking");
  });

  it("gives two consecutive user messages their own turns", () => {
    // A queued message can be delivered before the model answers; the rail
    // should still say two prompts were sent.
    const turns = groupTurns([user("one"), user("two")]);
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.prompt)).toEqual(["one", "two"]);
  });

  it("applies the preview budgets to both fields", () => {
    const turns = groupTurns([user("p".repeat(300)), assistant("r".repeat(300))]);
    expect(turns[0]!.prompt).toHaveLength(PROMPT_PREVIEW_LIMIT);
    expect(turns[0]!.response).toHaveLength(RESPONSE_PREVIEW_LIMIT);
  });

  it("ignores assistant messages with no text blocks", () => {
    const toolOnly = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
      timestamp: 0,
    } as unknown as AgentMessage;
    const turns = groupTurns([user("run it"), toolOnly]);
    expect(turns[0]!.response).toBe("");
  });
});
