import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actions, resetAppState } from "../../lib/app-state.ts";
import type { ToolCallBlock } from "../../lib/types.ts";
import { QuestionReviewCard } from "./QuestionReviewCard.tsx";
import { QuestionRow } from "./QuestionRow.tsx";
import type { ToolExecution } from "./useConversation.ts";

// The copy renders through `useT`, which falls back to the host locale when the
// preference is `system`. Pin it so the assertions read one language.
vi.stubGlobal("navigator", { language: "en" });

beforeEach(() => {
  resetAppState();
});

afterEach(() => {
  resetAppState();
});

const QUESTIONS = [
  {
    id: "db",
    header: "Storage",
    question: "Which database?",
    options: [{ label: "Postgres", description: "Solid transactions" }, { label: "SQLite" }],
  },
  { id: "notes", question: "Anything else?" },
];

describe("QuestionReviewCard", () => {
  it("marks the chosen row and shows a typed answer next to its question", () => {
    const html = renderToStaticMarkup(
      <QuestionReviewCard
        record={{
          questions: QUESTIONS,
          answers: [
            { id: "db", selected: ["Postgres"] },
            { id: "notes", selected: [], custom: "keep it small" },
          ],
          outcome: "answered",
        }}
      />,
    );

    expect(html).toContain("Storage");
    expect(html).toContain("Which database?");
    expect(html).toContain("Solid transactions");
    expect(html).toContain("keep it small");
    // Both questions are on screen: reading back is not deciding, so there is no
    // pager to hide the previous verdict behind.
    expect(html).toContain("Anything else?");
  });

  it("says a skipped question was skipped rather than leaving it blank", () => {
    const html = renderToStaticMarkup(
      <QuestionReviewCard
        record={{ questions: QUESTIONS, answers: [{ id: "db", selected: [] }], outcome: "answered" }}
      />,
    );
    expect(html).toContain("Skipped");
  });

  it("draws a cancel with no answers at all", () => {
    const html = renderToStaticMarkup(
      <QuestionReviewCard record={{ questions: QUESTIONS, answers: [], outcome: "cancelled" }} />,
    );
    expect(html).toContain("Which database?");
    expect(html).not.toContain("Skipped");
  });
});

function call(): ToolCallBlock {
  return { type: "toolCall", id: "call-1", name: "ask_user_question", arguments: {} } as ToolCallBlock;
}

function execution(details: unknown): ToolExecution {
  return {
    toolName: "ask_user_question",
    output: "",
    result: null,
    details,
    isError: false,
    running: false,
  };
}

describe("QuestionRow", () => {
  it("names what became of the call and how much was asked", () => {
    const html = renderToStaticMarkup(
      <QuestionRow
        call={call()}
        execution={execution({ questions: QUESTIONS, answers: [], outcome: "timed-out" })}
      />,
    );

    expect(html).toContain("Question");
    expect(html).toContain("Timed out");
    expect(html).toContain("2 question(s)");
  });

  it("falls back to the generic row when the result is not one it can read", () => {
    // The generic row at least shows the raw output; a card with no record to
    // draw would be emptier than the thing it replaced.
    const html = renderToStaticMarkup(<QuestionRow call={call()} execution={undefined} />);
    expect(html).toContain("ask_user_question");
  });

  it("offers the way back to a question the user put away", () => {
    actions.enqueueUiRequest({
      sessionPath: "/sessions/one.jsonl",
      request: {
        type: "extension_ui_request",
        id: "ui_1",
        method: "ask_user",
        callId: "call-1",
        questions: QUESTIONS,
        expiresAt: Date.now() + 60_000,
      },
    });
    actions.hideUiRequest("ui_1");

    // The tool call has no result yet — it is still waiting — so the row says
    // so and reopening it puts the card back in the seat (dsh's rule).
    const html = renderToStaticMarkup(<QuestionRow call={call()} execution={undefined} />);
    expect(html).toContain("Waiting for an answer");
  });
});
