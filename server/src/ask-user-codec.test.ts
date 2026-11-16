import { describe, expect, it } from "vitest";
import {
  ASK_USER_TITLE_PREFIX,
  decodeAskUserBatch,
  encodeAskUserResponse,
} from "./ask-user-codec.ts";

/** The wire form the extension writes into a `select` title. */
function title(payload: unknown): string {
  return `${ASK_USER_TITLE_PREFIX}${JSON.stringify(payload)}`;
}

const batch = {
  v: 1,
  kind: "ask_user",
  questions: [
    { id: "db", header: "选库", question: "用哪个数据库？", options: [{ label: "Postgres" }] },
  ],
};

describe("decodeAskUserBatch", () => {
  it("reads a batch out of the prefixed title and takes its title from the first header", () => {
    expect(decodeAskUserBatch(title(batch))).toEqual({
      questions: [{ id: "db", header: "选库", question: "用哪个数据库？", options: [{ label: "Postgres" }] }],
      title: "选库",
    });
  });

  it("keeps every optional field it was given and omits the ones it was not", () => {
    const decoded = decodeAskUserBatch(
      title({
        v: 1,
        kind: "ask_user",
        questions: [
          {
            id: "a",
            question: "Which?",
            detail: "**detail**",
            options: [{ label: "One", description: "the first" }, { label: "Two" }],
            multiSelect: true,
          },
        ],
      }),
    );
    expect(decoded).toEqual({
      questions: [
        {
          id: "a",
          question: "Which?",
          detail: "**detail**",
          options: [{ label: "One", description: "the first" }, { label: "Two" }],
          multiSelect: true,
        },
      ],
    });
  });

  it("reads the user-visible deadline the extension declared", () => {
    expect(decodeAskUserBatch(title({ ...batch, timeoutMs: 120_000 }))?.timeoutMs).toBe(120_000);
  });

  it("rejects a declared deadline that is not a positive number", () => {
    for (const timeoutMs of [0, -1, "120", null]) {
      expect(decodeAskUserBatch(title({ ...batch, timeoutMs }))).toBeNull();
    }
  });

  it("carries the asking tool call, which decides how closing the card behaves", () => {
    expect(decodeAskUserBatch(title({ ...batch, callId: "call_42" }))?.callId).toBe("call_42");
  });

  it("drops a call id it cannot read instead of rejecting the batch", () => {
    for (const callId of ["", 42, null]) {
      const decoded = decodeAskUserBatch(title({ ...batch, callId }));
      expect(decoded?.questions).toHaveLength(1);
      expect(decoded?.callId).toBeUndefined();
    }
  });

  it("carries a presentation intent through, and drops one it cannot honour", () => {
    const plan = {
      id: "plan",
      question: "Approve this plan?",
      detail: "# Plan\n\ndo the thing",
      options: [{ label: "Approve" }, { label: "Request changes" }],
      intent: { kind: "plan-review", approve: "Approve", callId: "call-1", extra: "ignored" },
    };
    expect(decodeAskUserBatch(title({ v: 1, kind: "ask_user", questions: [plan] }))?.questions).toEqual([
      {
        id: "plan",
        question: "Approve this plan?",
        detail: "# Plan\n\ndo the thing",
        options: [{ label: "Approve" }, { label: "Request changes" }],
        // `callId` is the tool invocation that submitted the plan, which is how
        // the client reopens the logged document after the review closes.
        intent: { kind: "plan-review", approve: "Approve", callId: "call-1" },
      },
    ]);

    // A pointer of the wrong shape costs the pointer, not the tag: the verdict
    // itself is still answerable, and the card just cannot offer the document.
    const badCallId = { ...plan, intent: { kind: "plan-review", approve: "Approve", callId: 7 } };
    expect(
      decodeAskUserBatch(title({ v: 1, kind: "ask_user", questions: [badCallId] }))?.questions[0]?.intent,
    ).toEqual({ kind: "plan-review", approve: "Approve" });

    // A tag this build does not know is a decoration, not a reason to refuse an
    // otherwise answerable batch: the card falls back to the generic list.
    const unknown = { ...plan, intent: { kind: "something-else", approve: "Approve" } };
    expect(
      decodeAskUserBatch(title({ v: 1, kind: "ask_user", questions: [unknown] }))?.questions[0]?.intent,
    ).toBeUndefined();
    const broken = { ...plan, intent: { kind: "plan-review" } };
    expect(
      decodeAskUserBatch(title({ v: 1, kind: "ask_user", questions: [broken] }))?.questions[0]?.intent,
    ).toBeUndefined();
  });

  it("accepts a question with no options, which is a free-text question", () => {
    const decoded = decodeAskUserBatch(title({ ...batch, questions: [{ id: "x", question: "Why?" }] }));
    expect(decoded?.questions).toEqual([{ id: "x", question: "Why?" }]);
  });

  it("leaves a plain dialog alone when the title only looks like a prefix", () => {
    expect(decodeAskUserBatch("pi-web:ask-user:v1:not json")).toBeNull();
    expect(decodeAskUserBatch("pi-web:ask-user:v1:")).toBeNull();
    // A different version is a different protocol; the caller must not guess.
    expect(decodeAskUserBatch(title({ ...batch, v: 2 }))).toBeNull();
    expect(decodeAskUserBatch(title({ ...batch, kind: "other" }))).toBeNull();
  });

  it("ignores titles that are not the protocol at all", () => {
    expect(decodeAskUserBatch("Allow dangerous command?")).toBeNull();
    expect(decodeAskUserBatch(undefined)).toBeNull();
    expect(decodeAskUserBatch(42)).toBeNull();
    expect(decodeAskUserBatch(`${ASK_USER_TITLE_PREFIX}[1,2]`)).toBeNull();
  });

  it("rejects the whole batch when any question is malformed", () => {
    const cases: unknown[] = [
      [],
      [{ question: "no id" }],
      [{ id: "", question: "empty id" }],
      [{ id: "a" }],
      [{ id: "a", question: "dup" }, { id: "a", question: "dup" }],
      [{ id: "a", question: "q", header: 7 }],
      [{ id: "a", question: "q", multiSelect: "yes" }],
      [{ id: "a", question: "q", options: [{ description: "no label" }] }],
      [{ id: "a", question: "q", options: [{ label: "ok" }, { label: 7 }] }],
      [{ id: "a", question: "q", options: "Postgres" }],
    ];
    for (const questions of cases) {
      expect(decodeAskUserBatch(title({ v: 1, kind: "ask_user", questions }))).toBeNull();
    }
  });
});

describe("encodeAskUserResponse", () => {
  it("serializes a submitted batch into the value pi resolves the select with", () => {
    const body = encodeAskUserResponse({
      answers: [{ id: "db", selected: ["Postgres"], custom: "with pgvector" }],
    });
    expect(body).toEqual({
      value: JSON.stringify({ answers: [{ id: "db", selected: ["Postgres"], custom: "with pgvector" }] }),
    });
  });

  it("normalizes a missing `selected` to an empty array, which is a skip", () => {
    expect(encodeAskUserResponse({ answers: [{ id: "db" }] })).toEqual({
      value: JSON.stringify({ answers: [{ id: "db", selected: [] }] }),
    });
  });

  it("passes a cancel through as pi's own shape rather than a serialized one", () => {
    expect(encodeAskUserResponse({ cancelled: true })).toEqual({ cancelled: true });
  });

  it("marks an answering deadline separately from a cancel, so a late reply stays possible", () => {
    expect(encodeAskUserResponse({ timedOut: true })).toEqual({
      value: JSON.stringify({ timedOut: true }),
    });
  });

  it("refuses a batch that does not line up with the questions it answers", () => {
    const questions = [
      { id: "db", question: "Which database?" },
      { id: "tags", question: "Which capabilities?" },
    ];
    const partial = { answers: [{ id: "db", selected: ["Postgres"] }] };
    // With no batch to check against, the body is as valid as it looks; the
    // caller that knows the questions (the pending table) always passes them.
    expect(encodeAskUserResponse(partial)).not.toBeNull();
    expect(encodeAskUserResponse(partial, questions)).toBeNull();
    expect(
      encodeAskUserResponse(
        { answers: [{ id: "db", selected: ["Postgres"] }, { id: "tags", selected: ["vector"] }] },
        questions,
      ),
    ).not.toBeNull();
    // A repeated id answers one question twice and leaves the other blank.
    expect(
      encodeAskUserResponse(
        { answers: [{ id: "db", selected: [] }, { id: "db", selected: [] }] },
        questions,
      ),
    ).toBeNull();
    // An id no question has would be dropped on the way to the model anyway.
    expect(
      encodeAskUserResponse(
        { answers: [{ id: "db", selected: [] }, { id: "tags", selected: [] }, { id: "x", selected: [] }] },
        questions,
      ),
    ).toBeNull();
  });

  it("refuses a body that is not a decision", () => {
    expect(encodeAskUserResponse({})).toBeNull();
    expect(encodeAskUserResponse({ answers: "db" })).toBeNull();
    expect(encodeAskUserResponse({ answers: [null] })).toBeNull();
    expect(encodeAskUserResponse({ answers: [{ selected: [], id: 7 }] })).toBeNull();
    expect(encodeAskUserResponse({ answers: [{ id: "a", selected: ["x", 7] }] })).toBeNull();
    expect(encodeAskUserResponse({ answers: [{ id: "a", custom: 7 }] })).toBeNull();
  });
});
