import { describe, expect, it, vi } from "vitest";
import { ASK_USER_OPTION_SENTINEL, ASK_USER_TITLE_PREFIX } from "./ask-user-codec.ts";
import type { SessionHandle } from "./registry.ts";
import { PendingUiRequests, webEventFor } from "./ui-requests.ts";

/**
 * A handle whose stdin is the only thing the table touches — the real path goes
 * through `sendRawCommand`, which writes the frame straight to that stream.
 */
function handle(sessionPath: string) {
  const write = vi.fn();
  const client = {
    process: { stdin: { write, destroyed: false, writable: true } },
  } as unknown as SessionHandle["client"];
  const session = { sessionPath, client, dead: false } as SessionHandle;
  return { session, write };
}

function dialog(id: string, extra: Record<string, unknown> = {}) {
  return { type: "extension_ui_request", id, method: "select", options: ["a", "b"], ...extra };
}

describe("PendingUiRequests", () => {
  it("lists a dialog with the path its session had when the process asked", () => {
    const table = new PendingUiRequests();
    const { session } = handle("");
    table.add(session, dialog("ui_1"));
    expect(table.list()).toEqual([{ sessionPath: "", request: dialog("ui_1") }]);
  });

  it("answers by dialog id and stops listing the entry", async () => {
    const table = new PendingUiRequests();
    const { session, write } = handle("/sessions/a.jsonl");
    table.add(session, dialog("ui_1"));

    expect(await table.answer("ui_1", { value: "a" })).toBe("answered");
    // The frame keeps the dialog's own id: `RpcClient.send()` would stamp its
    // own over it, which is exactly why this path does not use `send()`.
    expect(write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: "extension_ui_response", id: "ui_1", value: "a" })}\n`,
    );
    expect(table.list()).toEqual([]);
  });

  it("reports an unknown or already answered id instead of inventing a target", async () => {
    const table = new PendingUiRequests();
    const { session, write } = handle("/sessions/a.jsonl");
    table.add(session, dialog("ui_1"));
    await table.answer("ui_1", { value: "a" });

    expect(await table.answer("ui_1", { value: "a" })).toBe("unknown");
    expect(await table.answer("ui_nope", { value: "a" })).toBe("unknown");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps two sessions' dialogs apart", async () => {
    const table = new PendingUiRequests();
    const a = handle("/sessions/a.jsonl");
    const b = handle("/sessions/b.jsonl");
    table.add(a.session, dialog("ui_a"));
    table.add(b.session, dialog("ui_b"));

    await table.answer("ui_b", { value: "b" });
    expect(b.write).toHaveBeenCalledTimes(1);
    expect(a.write).not.toHaveBeenCalled();
    expect(table.list().map((entry) => entry.request.id)).toEqual(["ui_a"]);
  });

  it("drops everything a process was waiting on when it goes away", () => {
    const table = new PendingUiRequests();
    const a = handle("/sessions/a.jsonl");
    const b = handle("/sessions/b.jsonl");
    table.add(a.session, dialog("ui_1"));
    table.add(a.session, dialog("ui_2"));
    table.add(b.session, dialog("ui_3"));

    table.dropFor(a.session);
    expect(table.list().map((entry) => entry.request.id)).toEqual(["ui_3"]);
  });

  it("stops listing a dialog pi already settled on its own timeout", () => {
    vi.useFakeTimers();
    try {
      const table = new PendingUiRequests();
      const { session } = handle("/sessions/a.jsonl");
      table.add(session, dialog("ui_1", { timeout: 5_000 }));

      vi.advanceTimersByTime(4_000);
      expect(table.list()).toHaveLength(1);
      vi.advanceTimersByTime(2_000);
      expect(table.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an expired answer even when nobody has listed the dialogs", async () => {
    vi.useFakeTimers();
    try {
      const table = new PendingUiRequests();
      const { session, write } = handle("/sessions/a.jsonl");
      table.add(session, dialog("ui_1", { timeout: 5_000 }));

      vi.advanceTimersByTime(5_000);

      expect(await table.answer("ui_1", { value: "a" })).toBe("unknown");
      expect(write).not.toHaveBeenCalled();
      expect(table.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a dialog with no timeout forever", () => {
    vi.useFakeTimers();
    try {
      const table = new PendingUiRequests();
      const { session } = handle("/sessions/a.jsonl");
      table.add(session, dialog("ui_1"));

      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(table.list()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a dead process's dialog rather than sending into it", async () => {
    const table = new PendingUiRequests();
    const { session, write } = handle("/sessions/a.jsonl");
    table.add(session, dialog("ui_1"));
    session.dead = true;

    expect(table.list()).toEqual([]);
    expect(await table.answer("ui_1", { value: "a" })).toBe("unknown");
    expect(write).not.toHaveBeenCalled();
  });
});

/**
 * A question batch arrives as an ordinary `select` whose title carries the
 * protocol — see `ask-user-codec.ts`. These cases pin the two halves that make
 * the indirection invisible to the browser: what it is shown, and what goes
 * back to pi.
 */
describe("ask_user batches", () => {
  function batchDialog(id: string, extra: Record<string, unknown> = {}) {
    const { timeoutMs, ...rest } = extra;
    return {
      id,
      method: "select",
      title: `${ASK_USER_TITLE_PREFIX}${JSON.stringify({
        v: 1,
        kind: "ask_user",
        questions: [
          { id: "db", header: "选库", question: "用哪个数据库？", options: [{ label: "Postgres" }] },
        ],
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })}`,
      options: [ASK_USER_OPTION_SENTINEL],
      ...rest,
    };
  }

  it("lists the decoded batch instead of the sentinel option it arrived in", () => {
    const table = new PendingUiRequests();
    const { session } = handle("/sessions/a.jsonl");
    table.add(session, batchDialog("ui_1", { timeout: 120_000 }));

    expect(table.list()).toEqual([
      {
        sessionPath: "/sessions/a.jsonl",
        request: {
          type: "extension_ui_request",
          id: "ui_1",
          method: "ask_user",
          title: "选库",
          questions: [
            { id: "db", header: "选库", question: "用哪个数据库？", options: [{ label: "Postgres" }] },
          ],
          timeout: 120_000,
        },
      },
    ]);
  });

  it("encodes the browser's decision into the value pi resolves the select with", async () => {
    const table = new PendingUiRequests();
    const { session, write } = handle("/sessions/a.jsonl");
    table.add(session, batchDialog("ui_1"));

    expect(await table.answer("ui_1", { answers: [{ id: "db", selected: ["Postgres"] }] })).toBe(
      "answered",
    );
    expect(write).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: "extension_ui_response",
        id: "ui_1",
        value: JSON.stringify({ answers: [{ id: "db", selected: ["Postgres"] }] }),
      })}\n`,
    );
  });

  it("counts down the deadline the user was promised, not pi's longer window", () => {
    const table = new PendingUiRequests();
    const { session } = handle("/sessions/a.jsonl");
    // pi's timer is what actually settles the dialog; the card must retire at
    // the deadline the user was shown, which is the shorter one.
    table.add(session, batchDialog("ui_1", { timeout: 150_000, timeoutMs: 120_000 }));

    expect(table.list()[0]?.request.timeout).toBe(120_000);
  });

  it("refuses an answer batch that does not name every question", async () => {
    const table = new PendingUiRequests();
    const { session, write } = handle("/sessions/a.jsonl");
    table.add(session, batchDialog("ui_1"));

    // The batch asks exactly one question, so an empty answer list is a client
    // bug — and taking it would record a skipped question nobody skipped.
    expect(await table.answer("ui_1", { answers: [] })).toBe("invalid");
    expect(write).not.toHaveBeenCalled();
    expect(table.list()).toHaveLength(1);
    expect(await table.answer("ui_1", { answers: [{ id: "db", selected: ["Postgres"] }] })).toBe(
      "answered",
    );
  });

  it("keeps the card answerable when the decision cannot be encoded", async () => {
    const table = new PendingUiRequests();
    const { session, write } = handle("/sessions/a.jsonl");
    table.add(session, batchDialog("ui_1"));

    expect(await table.answer("ui_1", { answers: "nope" })).toBe("invalid");
    expect(write).not.toHaveBeenCalled();
    // A rejected attempt must not close a question the user still has on screen.
    expect(table.list()).toHaveLength(1);
    expect(await table.answer("ui_1", { cancelled: true })).toBe("answered");
    expect(table.list()).toEqual([]);
  });
});

/**
 * The bridge from a pi frame to what the browser is told. This is the only
 * place the codec's two shapes meet the stream, so both the pass-through and
 * the decode are pinned here rather than in the boot script.
 */
describe("webEventFor", () => {
  function handleBatch(id: string, timeoutMs: number) {
    return {
      type: "extension_ui_request",
      id,
      method: "select",
      title: `${ASK_USER_TITLE_PREFIX}${JSON.stringify({
        v: 1,
        kind: "ask_user",
        timeoutMs,
        questions: [{ id: "db", header: "选库", question: "用哪个数据库？", options: [{ label: "Postgres" }] }],
      })}`,
      options: [ASK_USER_OPTION_SENTINEL],
    };
  }

  it("passes an ordinary agent event through untouched", () => {
    const table = new PendingUiRequests();
    const { session } = handle("/sessions/a.jsonl");
    const event = { type: "message_update", delta: "hi" };
    expect(webEventFor(event, session, table)).toBe(event);
  });

  it("drops the terminal-only chrome a browser cannot act on", () => {
    const table = new PendingUiRequests();
    const { session } = handle("/sessions/a.jsonl");
    const frame = { type: "extension_ui_request", id: "ui_1", method: "setTitle", title: "x" };
    // 53 of these came out of one turn; none of them is a web action.
    expect(webEventFor(frame, session, table)).toBeNull();
  });

  it("forwards a notify without remembering it, because nothing is owed", () => {
    const table = new PendingUiRequests();
    const { session } = handle("/sessions/a.jsonl");
    const frame = { type: "extension_ui_request", id: "ui_2", method: "notify", message: "done" };
    expect(webEventFor(frame, session, table)).toBe(frame);
    expect(table.list()).toEqual([]);
  });

  it("remembers a blocking dialog and hands back the shape the client renders", () => {
    const table = new PendingUiRequests();
    const { session } = handle("/sessions/a.jsonl");
    const frame = dialog("ui_1");
    expect(webEventFor(frame, session, table)).toEqual(frame);
    expect(table.list()).toHaveLength(1);
  });

  it("publishes a question batch decoded rather than as the select it arrived in", () => {
    const table = new PendingUiRequests();
    const { session } = handle("/sessions/a.jsonl");
    const published = webEventFor(handleBatch("ui_3", 120_000), session, table);

    expect(published).toEqual({
      type: "extension_ui_request",
      id: "ui_3",
      method: "ask_user",
      title: "选库",
      timeout: 120_000,
      questions: [{ id: "db", header: "选库", question: "用哪个数据库？", options: [{ label: "Postgres" }] }],
    });
    // Decoding is not a view: the same entry stays answerable by id.
    expect(table.list()).toHaveLength(1);
  });
});
