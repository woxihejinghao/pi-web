import { describe, expect, it } from "vitest";
import type { AskUserQuestionItem, ExtensionUiRequest, PendingUiDialog } from "../../lib/types.ts";
import {
  CONFIRM_NO,
  CONFIRM_YES,
  answerPayload,
  askUserAnswerPayload,
  askUserAnswered,
  askUserQuestions,
  canSubmit,
  firstUnanswered,
  initialAskUserDrafts,
  initialText,
  isTextRequest,
  parseRecommendedLabel,
  pendingUiForSession,
  questionOptions,
  secondsLeft,
  toggleAskUserSelection,
} from "./question-model.ts";

function request(overrides: Partial<ExtensionUiRequest> & { method: string }): ExtensionUiRequest {
  return { type: "extension_ui_request", id: "ui_1", ...overrides };
}

describe("parseRecommendedLabel", () => {
  it("strips the ASCII suffix and flags the row", () => {
    expect(parseRecommendedLabel("Yes, delete them (Recommended)")).toEqual({
      label: "Yes, delete them",
      recommended: true,
    });
  });

  it("accepts the localized suffix in both bracket widths", () => {
    expect(parseRecommendedLabel("保留（推荐）")).toEqual({ label: "保留", recommended: true });
    expect(parseRecommendedLabel("保留 (推荐)")).toEqual({ label: "保留", recommended: true });
  });

  it("leaves a label with no suffix untouched", () => {
    expect(parseRecommendedLabel("Allow")).toEqual({ label: "Allow", recommended: false });
  });

  it("only matches the suffix at the end", () => {
    expect(parseRecommendedLabel("(Recommended) is not the suffix")).toEqual({
      label: "(Recommended) is not the suffix",
      recommended: false,
    });
  });
});

describe("questionOptions", () => {
  it("keeps the original string as the value the extension receives", () => {
    const options = questionOptions(
      request({ method: "select", options: ["Allow (Recommended)", "Block"] }),
    );
    expect(options).toEqual([
      { value: "Allow (Recommended)", label: "Allow", recommended: true },
      { value: "Block", label: "Block", recommended: false },
    ]);
  });

  it("ignores non-string entries and requests without options", () => {
    expect(
      questionOptions(request({ method: "select", options: ["ok", 7, null] as unknown as string[] })),
    ).toEqual([{ value: "ok", label: "ok", recommended: false }]);
    expect(questionOptions(request({ method: "input" }))).toEqual([]);
  });
});

describe("answerPayload", () => {
  it("answers a select with the chosen row's raw label", () => {
    const select = request({ method: "select", options: ["Allow (Recommended)", "Block"] });
    expect(answerPayload(select, "Allow (Recommended)", "")).toEqual({
      value: "Allow (Recommended)",
    });
    expect(answerPayload(select, null, "")).toBeNull();
  });

  it("maps the confirm token back to pi's boolean", () => {
    const confirm = request({ method: "confirm", title: "Clear session?" });
    expect(answerPayload(confirm, CONFIRM_YES, "")).toEqual({ confirmed: true });
    expect(answerPayload(confirm, CONFIRM_NO, "")).toEqual({ confirmed: false });
    expect(answerPayload(confirm, null, "")).toBeNull();
  });

  it("sends input and editor text under `value`", () => {
    expect(answerPayload(request({ method: "input" }), null, "  hi  ")).toEqual({ value: "  hi  " });
    expect(answerPayload(request({ method: "editor" }), null, "")).toEqual({ value: "" });
  });
});

describe("canSubmit", () => {
  const select = request({ method: "select", options: ["a"] });

  it("requires a row for select and non-blank text for input", () => {
    expect(canSubmit(select, null, "")).toBe(false);
    expect(canSubmit(select, "a", "")).toBe(true);
    expect(canSubmit(request({ method: "input" }), null, "   ")).toBe(false);
    expect(canSubmit(request({ method: "input" }), null, "x")).toBe(true);
  });

  it("lets the editor submit an emptied field, which is a legitimately empty answer", () => {
    expect(canSubmit(request({ method: "editor", text: "old" }), null, "")).toBe(true);
  });
});

describe("isTextRequest / initialText", () => {
  it("separates the field questions from the row questions", () => {
    expect(isTextRequest(request({ method: "input" }))).toBe(true);
    expect(isTextRequest(request({ method: "editor" }))).toBe(true);
    expect(isTextRequest(request({ method: "select", options: [] }))).toBe(false);
    expect(isTextRequest(request({ method: "confirm" }))).toBe(false);
  });

  it("prefills input and editor from `text`", () => {
    expect(initialText(request({ method: "editor", text: "Line 1" }))).toBe("Line 1");
    expect(initialText(request({ method: "input" }))).toBe("");
  });
});

describe("secondsLeft", () => {
  it("rounds up and never goes negative", () => {
    expect(secondsLeft(10_000, 8_500)).toBe(2);
    expect(secondsLeft(10_000, 10_000)).toBe(0);
    expect(secondsLeft(10_000, 12_000)).toBe(0);
  });
});

const DB: AskUserQuestionItem = {
  id: "db",
  header: "选库",
  question: "用哪个数据库？",
  options: [{ label: "Postgres" }, { label: "SQLite" }],
};
const TAGS: AskUserQuestionItem = {
  id: "tags",
  question: "需要哪些能力？",
  options: [{ label: "fulltext" }, { label: "vector" }],
  multiSelect: true,
};
const NOTES: AskUserQuestionItem = { id: "notes", question: "还有什么要说明？" };

function askUser(questions: AskUserQuestionItem[]): ExtensionUiRequest {
  return { type: "extension_ui_request", id: "ui_1", method: "ask_user", questions };
}

/** Drafts with one question answered, for the cases that only vary one entry. */
function draftsOf(count: number) {
  return initialAskUserDrafts(Array.from({ length: count }, () => DB));
}

describe("askUserQuestions", () => {
  it("reads the batch a decoded request carries", () => {
    expect(askUserQuestions(askUser([DB, NOTES]))).toEqual([DB, NOTES]);
  });

  it("is empty for another method and drops entries that are not questions", () => {
    expect(askUserQuestions(request({ method: "select", options: ["a"] }))).toEqual([]);
    expect(
      askUserQuestions({
        ...askUser([DB]),
        questions: [DB, null, { id: 7 }, { id: "x", question: "y" }] as unknown as AskUserQuestionItem[],
      }),
    ).toEqual([DB, { id: "x", question: "y" }]);
  });
});

describe("askUser drafts", () => {
  it("starts every question blank instead of pre-selecting the recommendation", () => {
    expect(initialAskUserDrafts([DB, NOTES])).toEqual([
      { selected: [], custom: "", skipped: false },
      { selected: [], custom: "", skipped: false },
    ]);
  });

  it("treats a selection, typed text or an explicit skip as an answer", () => {
    expect(askUserAnswered(undefined)).toBe(false);
    expect(askUserAnswered({ selected: [], custom: "  ", skipped: false })).toBe(false);
    expect(askUserAnswered({ selected: ["Postgres"], custom: "", skipped: false })).toBe(true);
    expect(askUserAnswered({ selected: [], custom: "pgvector", skipped: false })).toBe(true);
    expect(askUserAnswered({ selected: [], custom: "", skipped: true })).toBe(true);
  });

  it("finds the first unanswered question so a submit can land on it", () => {
    const drafts = draftsOf(3);
    expect(firstUnanswered([DB, TAGS, NOTES], drafts)).toBe(0);
    drafts[0] = { selected: ["Postgres"], custom: "", skipped: false };
    drafts[1] = { selected: [], custom: "", skipped: true };
    expect(firstUnanswered([DB, TAGS, NOTES], drafts)).toBe(2);
    drafts[2] = { selected: [], custom: "small", skipped: false };
    expect(firstUnanswered([DB, TAGS, NOTES], drafts)).toBe(-1);
  });

  it("keeps one label at a time on a single-select question and drops the typed alternative", () => {
    const first = toggleAskUserSelection({ selected: [], custom: "pgvector", skipped: false }, "Postgres", false);
    expect(first).toEqual({ selected: ["Postgres"], custom: "", skipped: false });
    const second = toggleAskUserSelection(first, "SQLite", false);
    expect(second.selected).toEqual(["SQLite"]);
    // Clicking the picked row again clears it rather than being a no-op.
    expect(toggleAskUserSelection(second, "SQLite", false).selected).toEqual([]);
  });

  it("accumulates labels on a multi-select question without disturbing the typed answer", () => {
    const first = toggleAskUserSelection({ selected: [], custom: "hybrid", skipped: false }, "vector", true);
    expect(first).toEqual({ selected: ["vector"], custom: "hybrid", skipped: false });
    const second = toggleAskUserSelection(first, "fulltext", true);
    expect(second.selected).toEqual(["vector", "fulltext"]);
    expect(toggleAskUserSelection(second, "vector", true).selected).toEqual(["fulltext"]);
  });
});

describe("askUserAnswerPayload", () => {
  it("refuses a batch with a question still unanswered", () => {
    const drafts = draftsOf(2);
    drafts[0] = { selected: ["Postgres"], custom: "", skipped: false };
    expect(askUserAnswerPayload([DB, NOTES], drafts)).toBeNull();
    expect(askUserAnswerPayload([], [])).toBeNull();
  });

  it("serializes a single choice, a skip and a typed answer", () => {
    const payload = askUserAnswerPayload([DB, TAGS, NOTES], [
      { selected: ["SQLite"], custom: "", skipped: false },
      { selected: [], custom: "", skipped: true },
      { selected: [], custom: "  keep it small  ", skipped: false },
    ]);
    expect(payload).toEqual({
      answers: [
        { id: "db", selected: ["SQLite"] },
        { id: "tags", selected: [] },
        { id: "notes", selected: [], custom: "keep it small" },
      ],
    });
  });

  it("lets typed text replace a single choice but supplement a multi-select one", () => {
    const payload = askUserAnswerPayload([DB, TAGS], [
      { selected: ["Postgres"], custom: "or MySQL", skipped: false },
      { selected: ["vector"], custom: "and pgvector", skipped: false },
    ]);
    expect(payload).toEqual({
      answers: [
        { id: "db", selected: [], custom: "or MySQL" },
        { id: "tags", selected: ["vector"], custom: "and pgvector" },
      ],
    });
  });
});

describe("pendingUiForSession", () => {
  const dialog = (sessionPath: string, id = "ui_1"): PendingUiDialog => ({
    sessionPath,
    request: request({ id, method: "confirm" }),
  });

  it("takes the open session's own dialog", () => {
    const mine = dialog("/work/a.jsonl", "ui_mine");
    expect(pendingUiForSession([dialog("/work/b.jsonl"), mine], "/work/a.jsonl")).toBe(mine);
  });

  it("leaves another session's dialog undrawn", () => {
    // Its process is blocked too, but the answer is not this reader's to give:
    // the sidebar row for that session carries the waiting mark instead.
    expect(pendingUiForSession([dialog("/work/b.jsonl")], "/work/a.jsonl")).toBeNull();
  });

  it("draws no dialog addressed elsewhere while no session is open", () => {
    expect(pendingUiForSession([dialog("/work/b.jsonl")], null)).toBeNull();
    expect(pendingUiForSession([], null)).toBeNull();
  });

  it("gives an unaddressed dialog to the seat that is becoming a session", () => {
    // pi publishes the request before it has named the session file, so an empty
    // address means "still being created" — and the draft on screen, like the
    // hero whose next message creates one, is the seat it was asked from. That
    // hero case is the prewarm process's first question (see design-notes).
    const unaddressed = dialog("");
    expect(pendingUiForSession([dialog("/work/b.jsonl"), unaddressed], null)).toBe(unaddressed);
  });

  it("keeps an unaddressed dialog off an open session", () => {
    expect(pendingUiForSession([dialog("")], "/work/a.jsonl")).toBeNull();
  });
});
