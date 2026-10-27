import { decodeAskUserBatch, encodeAskUserResponse, type AskUserBatch } from "./ask-user-codec.ts";
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
 *
 * Two shapes live in here. `plain` is a dialog whose answer goes back the way
 * pi asked it. `ask_user` is a question batch that arrived encoded in a
 * `select` — see `ask-user-codec.ts` — and this table is where that shape stops
 * being visible: `list()` hands out the decoded request, and `answer()` encodes
 * the browser's decision back into the value pi resolves.
 */
export interface PendingUiDialog {
  /** Empty while the session has not been written to disk yet. */
  sessionPath: string;
  request: { id: string; method: string; [key: string]: unknown };
}

/** How one dialog's answer is read: as sent, or through the question codec. */
type Codec = "plain" | "ask_user";

interface Entry {
  handle: SessionHandle;
  /** The frame pi sent, kept verbatim so a `plain` answer echoes its own shape. */
  request: PendingUiDialog["request"];
  /** What a client is shown; identical to `request` for everything but `ask_user`. */
  display: PendingUiDialog["request"];
  codec: Codec;
  /** When the dialog arrived, for judging pi's own `timeout` deadline. */
  receivedAt: number;
}

/** What became of one answer attempt. */
export type AnswerOutcome = "answered" | "unknown" | "invalid";

/**
 * pi resolves a timed-out dialog on its own and reports nothing to the client,
 * so the deadline is the only way to tell "still waiting" from "already
 * settled". Entries past it are dropped on read rather than answered: pi is no
 * longer listening, and a late response would race its default.
 */
function expired(entry: Entry, now: number): boolean {
  const timeout = entry.request.timeout;
  if (typeof timeout !== "number" || timeout <= 0) return false;
  return now - entry.receivedAt >= timeout;
}

export class PendingUiRequests {
  private readonly entries = new Map<string, Entry>();

  /**
   * Remember a dialog so it can be answered by id and restored after a reload,
   * and return the request a client should render.
   *
   * The batch is decoded once, here: the browser never sees the sentinel option
   * or the prefixed title, and the answer path below reads the same decision
   * from the entry rather than guessing again.
   */
  add(handle: SessionHandle, request: PendingUiDialog["request"]): PendingUiDialog["request"] {
    const batch = request.method === "select" ? decodeAskUserBatch(request.title) : null;
    const codec: Codec = batch === null ? "plain" : "ask_user";
    const display = batch === null ? request : askUserDisplay(request, batch);
    this.entries.set(request.id, { handle, request, display, codec, receivedAt: Date.now() });
    return display;
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
      pending.push({ sessionPath: entry.handle.sessionPath, request: entry.display });
    }
    return pending;
  }

  /**
   * Forward one answer to the process that asked.
   *
   * `unknown` is a stale card, or one whose dialog pi already settled. `invalid`
   * is a question batch whose decision did not survive decoding — that entry is
   * kept, because the card is still on screen and the user can try again.
   */
  async answer(id: string, payload: Record<string, unknown>): Promise<AnswerOutcome> {
    const entry = this.entries.get(id);
    if (!entry) return "unknown";
    if (entry.handle.dead || expired(entry, Date.now())) {
      this.entries.delete(id);
      return "unknown";
    }
    const body = entry.codec === "ask_user"
      ? encodeAskUserResponse(payload, decodeAskUserBatch(entry.request.title)?.questions)
      : payload;
    if (body === null) return "invalid";
    this.entries.delete(id);
    sendRawCommand(entry.handle.client, { type: "extension_ui_response", id, ...body });
    return "answered";
  }

  /** Forget everything a process was waiting on; it is gone or being replaced. */
  dropFor(handle: SessionHandle): void {
    for (const [id, entry] of this.entries) {
      if (entry.handle === handle) this.entries.delete(id);
    }
  }
}

/**
 * The decoded batch, shaped as a request the web client already knows how to
 * route: the same envelope, with the questions replacing the encoded title.
 * `options` is dropped rather than passed through — it only ever held the
 * codec's sentinel, which is not an answer anyone should be offered.
 */
function askUserDisplay(
  request: PendingUiDialog["request"],
  batch: AskUserBatch,
): PendingUiDialog["request"] {
  // The card counts down the deadline the user was promised, which the
  // extension declares in the payload. pi's own timeout is longer, and the
  // expiry check above keeps reading that one off the original frame — the two
  // must not be conflated, or the card would retire after the user has already
  // been told the answer is late.
  const timeout = batch.timeoutMs
    ?? (typeof request.timeout === "number" ? request.timeout : undefined);
  return {
    type: "extension_ui_request",
    id: request.id,
    method: "ask_user",
    questions: batch.questions,
    ...(batch.title === undefined ? {} : { title: batch.title }),
    ...(timeout === undefined ? {} : { timeout }),
  };
}

/**
 * The pi UI sub-protocol frames a browser can act on.
 *
 * pi emits a lot of terminal-only chrome — a single turn produced 53 `setTitle`
 * requests — and those are noise for a web client, so the rest is dropped here
 * rather than in every consumer.
 */
export const UI_METHODS_FOR_WEB: ReadonlySet<string> = new Set([
  "notify",
  "confirm",
  "select",
  "input",
  "editor",
]);

/** A session frame as it came off the pi process, before any narrowing. */
export interface PiFrame {
  type?: string;
  id?: unknown;
  method?: unknown;
  [key: string]: unknown;
}

/**
 * The one place a pi frame becomes what the browser is told.
 *
 * `null` means the frame is not for the web client at all. Anything else is
 * what goes on the stream: a dialog in the shape the client should render —
 * decoded, when it carried a question batch — and everything else untouched.
 */
export function webEventFor(
  raw: PiFrame,
  handle: SessionHandle,
  table: PendingUiRequests,
): Record<string, unknown> | null {
  if (raw.type !== "extension_ui_request") return raw;
  if (typeof raw.method !== "string" || !UI_METHODS_FOR_WEB.has(raw.method)) return null;
  // `notify` is fire-and-forget and owes no answer, so there is nothing to
  // remember and nothing to decode.
  if (raw.method === "notify" || typeof raw.id !== "string") return raw;
  return table.add(handle, raw as unknown as { id: string; method: string });
}

export const pendingUiRequests = new PendingUiRequests();
