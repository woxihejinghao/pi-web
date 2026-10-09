import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * The one call this module needs from a live session. `RpcClient` satisfies it
 * structurally, which keeps the live path testable without spawning a process.
 */
export interface SessionTitleWriter {
  setSessionName(name: string): Promise<void>;
}

/**
 * The name pi would show for this session, or `undefined` when it has none.
 *
 * Reads the log, so it is the same answer the CLI sees — and the only way to
 * ask "is this session already named?" without a pi process.
 */
export function sessionTitleOf(sessionPath: string): string | undefined {
  return SessionManager.open(sessionPath).getSessionName();
}

/**
 * Write a session's display name where pi keeps it: a `session_info` entry
 * inside the session's own JSONL.
 *
 * pi reads the *last* such entry, so a rename is an append to the log rather
 * than an update to a side table. That is the whole point of this module: the
 * Web UI, the TUI and `pi --resume` then agree about a session's name by
 * construction, and the name survives a session that is deleted and restored
 * from a backup. An empty name clears it — pi's `getSessionName()` reads a
 * blank entry as "no name" — which is how "back to automatic" is expressed.
 *
 * Two writers, picked by whether a pi process is already holding the file:
 *
 * - Live: the RPC call. pi appends through its own `SessionManager`, so this
 *   write serializes with the streaming writes the process is already doing.
 * - Cold: `SessionManager.open()` plus `appendSessionInfo()`. `open()`
 *   resolves an existing path with `flushed = true` (session-manager.js), so
 *   the entry really lands on disk, and nothing has to be spawned — worth
 *   having, because a cold spawn costs 1.5–3.2s (see `session-reader.ts`).
 *
 * A missing file is refused instead of created: `open()` on a path that does
 * not exist builds an in-memory session with `flushed = false`, where the name
 * would be dropped without a trace.
 */
export async function setSessionTitle(
  sessionPath: string,
  name: string,
  live: SessionTitleWriter | undefined,
): Promise<void> {
  if (!existsSync(sessionPath)) {
    throw new Error(`session file does not exist: ${sessionPath}`);
  }
  if (live !== undefined) {
    await live.setSessionName(name);
    return;
  }
  SessionManager.open(sessionPath).appendSessionInfo(name);
}
