/**
 * Where the reader was, so a reload lands back in the same conversation.
 *
 * Closing the page and opening it again is not a reset of what the user was
 * doing, and the run marks and pending dialogs have already been made to
 * survive that gap (see the `hello` frame). Remembering the selection is the
 * other half: restoring a session's state is only useful if the session is on
 * screen when the page comes back.
 *
 * Kept in `localStorage` rather than on the server: this is a property of the
 * browser, not of the workspace, and another machine should not move this one.
 * It is read only when a page loads, so an open tab keeps its own state; tabs
 * of the same browser share the one record, which means the most recent
 * selection is what the next reload restores.
 */
export interface LastSession {
  projectId: string;
  /** The open conversation, or null when the new-session hero was showing. */
  sessionPath: string | null;
}
const KEY = "pi-web-simple.last-session.v1";
function storage(): Storage | null {
  // Absent in the node test environment, and unavailable under a browser's
  // "block third-party storage" setting — both are "no memory", not an error
  // the shell should surface.
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
/**
 * The recorded selection, or null when there is none to restore.
 *
 * A record that is not this shape is treated as absent rather than repaired:
 * a half-written value would otherwise select a project that never existed and
 * leave the shell showing an empty header.
 */
export function readLastSession(): LastSession | null {
  const store = storage();
  if (store === null) return null;
  const raw = store.getItem(KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const { projectId, sessionPath } = parsed as {
      projectId?: unknown;
      sessionPath?: unknown;
    };
    if (typeof projectId !== "string" || projectId.length === 0) return null;
    if (sessionPath !== null && typeof sessionPath !== "string") return null;
    return { projectId, sessionPath: sessionPath ?? null };
  } catch {
    return null;
  }
}
export function writeLastSession(record: LastSession): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(KEY, JSON.stringify(record));
  } catch {
    // A full or disabled storage must not break selection; the next page just
    // starts where it would have without the record.
  }
}
export function forgetLastSession(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(KEY);
  } catch {
    // Same reasoning as the write.
  }
}