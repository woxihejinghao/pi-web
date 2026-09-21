import {
  SessionManager,
  buildContextEntries,
  type SessionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Read a session straight from its JSONL file, without a pi process.
 *
 * `get_messages` over RPC returns the same transcript, but only once a process
 * exists — and a cold spawn costs 1.5–3.2s. That was the entire cost of the
 * "正在载入会话…" wait when switching to a session that was not already
 * resident, even though the transcript is sitting on disk the whole time.
 *
 * `buildSessionContext()` is what pi itself uses to reconstruct a session, so
 * the result matches the runtime view: compaction-aware, walked from the
 * current leaf.
 */
export interface SessionSnapshot {
  sessionId: string;
  messages: SessionContext["messages"];
  /**
   * One entry per user message on the active branch, in transcript order.
   * `entryId` is what pi's `fork` command takes; `text` is sent along so the
   * client can check its own ordering instead of trusting position blindly.
   */
  forkPoints: ForkPoint[];
}

/** A message the user can fork from. pi only forks at user messages. */
export interface ForkPoint {
  entryId: string;
  text: string;
}

/** Flatten a message's content to its text, for matching and previews. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => {
      return (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      );
    })
    .map((part) => part.text)
    .join("");
}

/**
 * User messages on the context path, which are the valid fork targets.
 *
 * `buildContextEntries()` walks from the current leaf and applies compaction,
 * so this list matches the transcript the user is looking at. Entries are
 * filtered to `type === "message"` before reading `message.role`: other entry
 * kinds (model changes, labels, compaction summaries) have no message at all.
 */
function forkPointsFrom(manager: SessionManager): ForkPoint[] {
  const out: ForkPoint[] = [];
  // A loop rather than filter+map: `SessionEntry` is a union, and only a
  // discriminating check narrows it enough to read `.message`.
  for (const entry of buildContextEntries(manager.getEntries(), manager.getLeafId())) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "user") continue;
    out.push({ entryId: entry.id, text: messageText(entry.message.content) });
  }
  return out;
}

export function readSessionSnapshot(sessionPath: string): SessionSnapshot {
  // `open()` parses the file synchronously. That is the same thing
  // `SessionManager.list()` does for every session in a project (103ms for a
  // whole project), so a single file is well inside budget.
  const manager = SessionManager.open(sessionPath);
  return {
    sessionId: manager.getSessionId(),
    messages: manager.buildSessionContext().messages,
    forkPoints: forkPointsFrom(manager),
  };
}

/**
 * The session's entry tree, for the `/tree` view.
 *
 * Roots are returned as an array because a session can in principle be
 * re-rooted by compaction; in practice a session file has one root.
 */
export interface SessionTreeSnapshot {
  sessionId: string;
  tree: unknown[];
  leafId: string | null;
}

export function readSessionTree(sessionPath: string): SessionTreeSnapshot {
  const manager = SessionManager.open(sessionPath);
  return {
    sessionId: manager.getSessionId(),
    tree: manager.getTree(),
    leafId: manager.getLeafId(),
  };
}
