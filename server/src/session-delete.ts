import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { removeSessionOverride } from "./projects.ts";

/**
 * How a session file left the disk. `trash` means it is recoverable from the
 * system trash; `unlink` means it is gone.
 */
export type DeleteMethod = "trash" | "unlink";

export interface DeleteSessionResult {
  ok: boolean;
  method: DeleteMethod;
  /** There was nothing at that path to begin with. */
  missing?: boolean;
  error?: string;
}

/**
 * Moves one file to the system trash.
 *
 * Injectable so a test can pin both branches — with and without the `trash`
 * CLI — instead of asserting around whatever the host happens to have
 * installed.
 */
export type TrashRunner = (sessionPath: string) => Promise<{ ok: boolean; hint: string | null }>;

function runTrash(sessionPath: string): Promise<{ ok: boolean; hint: string | null }> {
  return new Promise((resolve) => {
    // A path starting with "-" would otherwise be read as a flag.
    const args = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
    const child = spawn("trash", args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      // ENOENT: the `trash` CLI is simply not installed. Not an error to show —
      // the caller falls back to a permanent delete.
      resolve({ ok: false, hint: `trash: ${err.message}` });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, hint: null });
        return;
      }
      const first = stderr.trim().split("\n")[0];
      resolve({ ok: false, hint: `trash: ${(first || `exit ${code ?? "?"}`).slice(0, 200)}` });
    });
  });
}

/**
 * Delete one session file, preferring the system trash over an unrecoverable
 * `unlink`.
 *
 * This mirrors what pi's own `/resume` picker does (its `deleteSessionFile`),
 * because the two writers must agree: a session deleted here should be just as
 * recoverable as one deleted from the terminal. The `trash` CLI is not a
 * dependency and is often absent, so a permanent delete is the fallback — and
 * when it too fails, the `trash` stderr is appended to the error, the same way
 * pi explains why the recovery path was unavailable.
 */
export async function deleteSessionFile(
  sessionPath: string,
  trash: TrashRunner = runTrash,
): Promise<DeleteSessionResult> {
  if (!existsSync(sessionPath)) return { ok: false, method: "unlink", missing: true };

  const trashed = await trash(sessionPath);
  // trash may report failure yet still have moved the file (or raced with
  // another process); the file being gone is what matters.
  if (trashed.ok || !existsSync(sessionPath)) {
    return { ok: true, method: "trash" };
  }

  try {
    await unlink(sessionPath);
    return { ok: true, method: "unlink" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      method: "unlink",
      error: trashed.hint ? `${message} (${trashed.hint})` : message,
    };
  }
}

/**
 * Delete a session and forget what this UI had recorded about it.
 *
 * The override (a Web-side rename or hide) is keyed by file path and outlives
 * the file otherwise: it would sit in `store.json` forever pointing at nothing,
 * and would come back to life if a session ever reappeared at that path.
 */
export async function deleteSession(
  sessionPath: string,
  trash: TrashRunner = runTrash,
): Promise<DeleteSessionResult> {
  const result = await deleteSessionFile(sessionPath, trash);
  if (result.ok) await removeSessionOverride(sessionPath);
  return result;
}
