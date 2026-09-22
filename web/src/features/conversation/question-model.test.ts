import { describe, expect, it } from "vitest";
import type { ExtensionUiRequest } from "../../lib/types.ts";
import {
  CONFIRM_NO,
  CONFIRM_YES,
  answerPayload,
  canSubmit,
  initialText,
  isTextRequest,
  parseRecommendedLabel,
  questionOptions,
  secondsLeft,
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
