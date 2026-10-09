import { existsSync } from "node:fs";
import { clearSessionOverrideName, getSessionOverrides } from "./projects.ts";
import { sessionTitleOf, setSessionTitle } from "./session-title.ts";

export interface TitleMigrationResult {
  /** Overrides whose name now lives in the session's own file. */
  migrated: number;
  /** Overrides left alone because their session file is not on disk (yet). */
  skipped: number;
  /** Overrides whose write failed; the stored name is kept for a retry. */
  failed: number;
}

/**
 * Move names an older build kept in `store.json` into the sessions' own files.
 *
 * Until the rename path wrote `session_info` entries, a Web rename lived in
 * `sessionOverrides[path].name` — and that copy is now ignored on read, because
 * a session's own name is the only title. This is the one chance to hand those
 * names back before they look like they were lost.
 *
 * Idempotent by construction: a path is processed only while it still carries
 * a `name`, and the name is dropped exactly when its write succeeded. A path
 * whose file is missing is left alone rather than counted as a failure — the
 * file may be on a volume that is not mounted yet — and `deleteSession`
 * already clears the override when a session is deleted on purpose.
 *
 * A session that already has a name in pi wins: this UI cannot tell which of
 * the two the user wrote last, and "the name in the log" is the answer this
 * project now keeps single. The stored copy is dropped either way, so the
 * migration cannot run forever on the same entry.
 */
export async function migrateLegacySessionTitles(
  log: { warn(message: string): void } = console,
): Promise<TitleMigrationResult> {
  const result: TitleMigrationResult = { migrated: 0, skipped: 0, failed: 0 };

  for (const [sessionPath, override] of Object.entries(await getSessionOverrides())) {
    const name = override.name?.trim();
    if (name === undefined || name.length === 0) continue;

    if (!existsSync(sessionPath)) {
      result.skipped += 1;
      continue;
    }
    try {
      if (sessionTitleOf(sessionPath) === undefined) {
        await setSessionTitle(sessionPath, name, undefined);
      }
      await clearSessionOverrideName(sessionPath);
      result.migrated += 1;
    } catch (error) {
      result.failed += 1;
      // Loud enough to find in a log, quiet enough not to stop the server: a
      // name that did not move is still in `store.json` for the next start.
      log.warn(
        `[pi-web-simple] could not move the stored name of ${sessionPath} into the session file: ${String(error)}`,
      );
    }
  }
  return result;
}
