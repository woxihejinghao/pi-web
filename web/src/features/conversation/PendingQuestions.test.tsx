import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Model an already expanded deferred card when the next live request arrives.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: () => [true, vi.fn()],
}));
vi.mock("../../lib/app-state.ts", () => ({ useT: () => (key: string) => key }));
vi.mock("./QuestionComposer.tsx", () => ({ QuestionComposer: () => <div>deferred editor</div> }));

import { PendingQuestions } from "./PendingQuestions.tsx";

const questions = [{ callId: "old", questions: [{ id: "q", question: "Old question" }] }];

describe("PendingQuestions live-dialog priority", () => {
  it("folds an open deferred editor while a live dialog owns the seat", () => {
    const html = renderToStaticMarkup(<PendingQuestions questions={questions} suspended onAnswer={() => undefined} />);
    expect(html).not.toContain("deferred editor");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("disabled");
  });

  it("restores the deferred editor when the live question is gone", () => {
    const html = renderToStaticMarkup(<PendingQuestions questions={questions} onAnswer={() => undefined} />);
    expect(html).toContain("deferred editor");
    expect(html).toContain('aria-expanded="true"');
  });
});
