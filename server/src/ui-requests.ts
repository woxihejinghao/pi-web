import type { SessionHandle } from "./registry.ts";
import { sendRawCommand } from "./registry.ts";

/**
 * The blocking extension dialogs currently waiting on a human.
 *
 * Answering by session path is not enough. A fresh session has no path yet: pi
 * mints the JSONL path itself and only reveals it through `get_state`, which
 * lands *after* `session_start` — exactly where an extension asks its first
 * question. The browser would receive a request whose `sessionPath` is the empty
 * string and have no address to reply to (a POST to `/api/sessions//ui-response`,
 * which is a 404).
 *
 * So the dialog id is the address instead: this table remembers which process
 * asked, and the client answers by id. It also makes a page reload survivable —
 * the request is still here, so a fresh page can list it and render the card
 * again, rather than leaving that pi process blocked forever. dsh's host keeps
 * the same table for the same reason ("the host remains authoritative for
 * whether the request is pending").
 */
export interface PendingUiDialog {
  /** Empty while the session has not been written to disk yet. */
  sessionPath: string;
  request: { id: string; method: string; [key: string]: unknown };
}

interface Entry {
  handle: SessionHandle;
  request: PendingUiDialog["request"];
  /** When the dialog arrived, for judging pi's own `timeout` deadline. */
  receivedAt: number;
}

/**
 * pi resolves a timed-out dialog on its own and reports nothing to the client,
 * so the deadline is the only way to tell "still waiting" from "already
 * settled". Entries past it are dropped on read rather than answered: pi is no
 * longer listening, and a late response would race its default.
 */
function expired(entry: Entry, now: number): boolean {
  const timeout = entry.request.timeout;
  if (typeof timeout !== "number" || timeout <= 0) return false;
  return now - entry.receivedAt > timeout;
}

export class PendingUiRequests {
  private readonly entries = new Map<string, Entry>();

  /** Remember a dialog so it can be answered by id and restored after a reload. */
  add(handle: SessionHandle, request: PendingUiDialog["request"]): void {
    this.entries.set(request.id, { handle, request, receivedAt: Date.now() });
  }

  /** Dialogs a client may still answer, oldest first. */
  list(): PendingUiDialog[] {
    const now = Date.now();
    const pending: PendingUiDialog[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.handle.dead || expired(entry, now)) {
        this.entries.delete(id);
        continue;
      }
      pending.push({ sessionPath: entry.handle.sessionPath, request: entry.request });
    }
    return pending;
  }

  /**
   * Forward one answer to the process that asked. `false` when nothing is
   * waiting under that id — a stale card, or one whose dialog pi already
   * settled.
   */
  async answer(id: string, payload: Record<string, unknown>): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    if (entry.handle.dead) return false;
    sendRawCommand(entry.handle.client, { type: "extension_ui_response", id, ...payload });
    return true;
  }

  /** Forget everything a process was waiting on; it is gone or being replaced. */
  dropFor(handle: SessionHandle): void {
    for (const [id, entry] of this.entries) {
      if (entry.handle === handle) this.entries.delete(id);
    }
  }
}

export const pendingUiRequests = new PendingUiRequests();
