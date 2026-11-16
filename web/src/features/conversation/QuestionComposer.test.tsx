import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppState } from "../../lib/app-state.ts";
import type { AskUserQuestionItem } from "../../lib/types.ts";
import { QuestionComposer } from "./QuestionComposer.tsx";

// The copy renders through `useT`, which falls back to the host locale when the
// preference is `system`. Pin it so the assertions read one language.
vi.stubGlobal("navigator", { language: "en" });

beforeEach(() => {
  resetAppState();
});

afterEach(() => {
  resetAppState();
});

function card(questions: AskUserQuestionItem[], extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <QuestionComposer questions={questions} onSubmit={() => undefined} {...extra} />,
  );
}

/**
 * The batched card, on its own.
 *
 * This is its first paint and nothing more: a static render does not run
 * effects, so the countdown never starts and no answer is ever sent. What is
 * worth pinning here is what the card decides to put on screen — the title it
 * picks, the rows it builds, the pager, and the fallback that keeps a card the
 * client cannot read from becoming a dead end.
 */
describe("QuestionComposer", () => {
  it("titles a multi-question batch by its size and shows the first question", () => {
    const html = card([
      {
        id: "db",
        header: "Storage",
        question: "Which database?",
        detail: "**detail**",
        options: [
          { label: "Postgres (Recommended)", description: "Solid transactions" },
          { label: "SQLite" },
        ],
      },
      { id: "tags", question: "Which capabilities?", options: [{ label: "fulltext" }], multiSelect: true },
    ]);

    expect(html).toContain("2 questions");
    // The pager position and the answered count describe the batch, not one question.
    expect(html).toContain("Question 1 of 2 (0 answered)");
    expect(html).toContain("Which database?");
    expect(html).toContain("Solid transactions");
    // The recommendation is stripped from the label and shown as its own badge.
    expect(html).toContain("Postgres");
    expect(html).toContain("Recommended");
    expect(html).not.toContain("Postgres (Recommended)");
    // Only the current page is drawn; the rest of the batch is behind the pager.
    expect(html).not.toContain("Which capabilities?");
    expect(html).toContain("Skip");
    expect(html).toContain("Next");
  });

  it("takes its title from a lone question's header instead of counting to one", () => {
    const html = card([
      { id: "go", header: "Confirm", question: "Proceed?", options: [{ label: "Yes" }] },
    ]);

    expect(html).toContain("Confirm");
    expect(html).not.toContain("1 questions");
  });

  it("draws a cancel affordance only while something is blocked behind it", () => {
    const questions = [{ id: "go", question: "Proceed?", options: [{ label: "Yes" }] }];
    expect(card(questions)).toContain("Cancel (Esc)");
    // A question re-opened after its deadline blocks nothing, so it is closed by
    // putting the strip away rather than by answering `cancelled`.
    expect(card(questions, { cancellable: false })).not.toContain("Cancel (Esc)");
  });

  it("closes a card that names its tool call by hiding it, not by answering", () => {
    const questions = [{ id: "go", question: "Proceed?", options: [{ label: "Yes" }] }];
    const hidden = card(questions, { onHide: () => undefined });
    // The affordance is still there, and it says what it does: the request
    // stands and the question row reopens it.
    expect(hidden).toContain("Close the panel");
    expect(hidden).not.toContain("Cancel (Esc)");
    // A card with nowhere to come back from keeps the old meaning.
    expect(card(questions)).toContain("Cancel (Esc)");
  });

  it("counts down only when a deadline was given", () => {
    const questions = [{ id: "go", question: "Proceed?", options: [{ label: "Yes" }] }];
    expect(card(questions, { timeoutMs: 120_000 })).toContain("Cancels in");
    expect(card(questions)).not.toContain("Cancels in");
  });

  it("renders a plan-review question as an approval card instead of an option list", () => {
    const html = card(
      [
        {
          id: "plan",
          header: "Migration plan",
          question: "Approve this plan?",
          detail: "# Plan\n\nStep one.\n\nStep two turns the tap off.",
          options: [{ label: "Approve" }, { label: "Request changes" }],
          intent: { kind: "plan-review", approve: "Approve" },
        },
      ],
      { onOpenPlan: () => true },
    );

    expect(html).toContain("Plan review");
    // The way into the full document is the sidebar (dsh's `reviewLink`), not an
    // expansion on the card — the card shows enough to recognise the plan.
    expect(html).toContain("View full plan");
    expect(html).toContain("Open plan in sidebar");
    expect(html).not.toContain("Step two turns the tap off.");
    // The list is replaced, not stacked under the plan: the verdict is the
    // smallest thing on the card if it is drawn as a fourth row of options.
    expect(html).not.toContain('role="radiogroup"');
  });

  it("gives a plan review the card to itself, with none of the ask chrome", () => {
    // The ask presentation brings a header, a pager, a skip and a submit. A plan
    // review takes the card over instead (dsh's `PlanReviewPanel`), so each of
    // those would be either meaningless or a second, conflicting way to answer —
    // Skip sends the plan back as "keep planning", and Submit refuses because
    // nothing is selected.
    const html = card(
      [
        {
          id: "plan",
          header: "Migration plan",
          question: "Approve this plan?",
          detail: "# Plan\n\nStep one.",
          options: [{ label: "Approve" }, { label: "Request changes" }],
          intent: { kind: "plan-review", approve: "Approve" },
        },
      ],
      { onOpenPlan: () => true },
    );

    // The review's own card: a tinted strip over the plan's title, and nothing
    // the ask card would have drawn around it.
    expect(html).toContain("Plan review");
    expect(html).toContain("<h3");
    expect(html).not.toContain("<h2");
    expect(html).not.toContain("Question 1 of 1");
    expect(html).not.toContain("Skip");
    expect(html).not.toContain("Submit");
    expect(html).not.toContain("Cancel (Esc)");
    // The question text is the card's accessible name, not a second title.
    expect(html).toContain('aria-label="Approve this plan?"');
  });

  it("keeps a tagged question in the generic flow when the batch asks several", () => {
    const html = card([
      {
        id: "plan",
        question: "Approve?",
        detail: "# Plan",
        options: [{ label: "Approve" }],
        intent: { kind: "plan-review", approve: "Approve" },
      },
      { id: "other", question: "And this?", options: [{ label: "Yes" }] },
    ]);

    // A single verdict cannot stand for a batch, so the tag is ignored.
    expect(html).not.toContain("Plan review");
    expect(html).toContain('role="radiogroup"');
  });

  it("keeps a batch it cannot read answerable by cancel", () => {
    const html = card([]);
    expect(html).toContain("could not be read");
  });
});
