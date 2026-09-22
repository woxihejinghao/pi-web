import { describe, expect, it, vi } from "vitest";
import type { SessionHandle } from "./registry.ts";
import { PendingUiRequests } from "./ui-requests.ts";

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
  return { id, method: "select", options: ["a", "b"], ...extra };
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

    expect(await table.answer("ui_1", { value: "a" })).toBe(true);
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

    expect(await table.answer("ui_1", { value: "a" })).toBe(false);
    expect(await table.answer("ui_nope", { value: "a" })).toBe(false);
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
    expect(await table.answer("ui_1", { value: "a" })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
