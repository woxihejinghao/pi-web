import { createStore, useStoreSelector, type Store } from "../../lib/store.ts";
import type { TurnFile } from "../conversation/turn-files.ts";

/**
 * One turn's changed files, as the transcript projected them.
 *
 * This is the bridge the review tab reads through. dsh's review tab asks the
 * Host for a summary and a comparison by session and event sequence, because
 * dsh took a workspace snapshot and kept it; this project has no snapshot, so
 * the only place a turn's changes exist is the transcript, which the conversation
 * pane — not the sidebar — is the one holding. The pane publishes, the tab reads.
 */
export interface TurnChanges {
  turn: number;
  files: readonly TurnFile[];
}

interface TurnChangesState {
  /** By session path; each entry is that session's turns in ascending order. */
  bySession: Record<string, readonly TurnChanges[]>;
}

/**
 * Published turns, per session.
 *
 * A separate store rather than a field on the app store: the app store is read
 * whole by the shell, so a write to it re-renders the conversation, the sidebar
 * and the settings page — and this one is written on every turn that ends.
 */
export const turnChangesStore: Store<TurnChangesState> = createStore({ bySession: {} });

/** Whether two projections describe the same turns, file for file. */
function sameChanges(
  left: readonly TurnChanges[] | undefined,
  right: readonly TurnChanges[],
): boolean {
  if (left === undefined || left.length !== right.length) return false;
  return left.every((change, index) => {
    const other = right[index];
    if (other === undefined || change.turn !== other.turn) return false;
    if (change.files === other.files) return true;
    if (change.files.length !== other.files.length) return false;
    return change.files.every((file, fileIndex) => {
      const peer = other.files[fileIndex];
      return (
        peer !== undefined &&
        file.path === peer.path &&
        file.relative === peer.relative &&
        file.added === peer.added &&
        file.deleted === peer.deleted &&
        file.oversized === peer.oversized &&
        file.patches.length === peer.patches.length &&
        file.patches.every((patch, patchIndex) => patch === peer.patches[patchIndex])
      );
    });
  });
}

/**
 * The publishable list, built from the map the conversation pane keeps.
 *
 * Ascending by turn, because the sidebar reads it as the turn's own history and
 * a review tab is only interested in one entry anyway. Kept here rather than
 * inline in the pane so the ordering has a test: the transcript hands turns over
 * in whatever order its map iterated.
 *
 * @param byTurn - every turn of one session that wrote something.
 * @returns the same turns, ascending.
 */
export function turnChangesList(
  byTurn: ReadonlyMap<number, readonly TurnFile[]>,
): TurnChanges[] {
  return [...byTurn]
    .map(([turn, files]) => ({ turn, files }))
    .sort((left, right) => left.turn - right.turn);
}

/**
 * Replace one session's published turns.
 *
 * Called by the conversation pane whenever its projection changes. An equal
 * projection is not written: turn files are recomputed from the message list, so
 * streaming would otherwise republish identical data and wake every review tab
 * on each round-trip.
 *
 * @param sessionPath - the session the turns belong to.
 * @param changes - every turn in that session that wrote something, ascending.
 */
export function publishTurnChanges(sessionPath: string, changes: readonly TurnChanges[]): void {
  if (sessionPath.length === 0) return;
  turnChangesStore.update((state) => {
    if (sameChanges(state.bySession[sessionPath], changes)) return state;
    return { bySession: { ...state.bySession, [sessionPath]: changes } };
  });
}

/**
 * One turn's published changes, or undefined while there are none.
 *
 * Undefined is the answer for a tab restored from a saved layout whose session
 * has not been opened yet, and for a turn whose messages are no longer loaded —
 * both are "not readable right now" rather than an error.
 *
 * @param sessionPath - the session whose turn is being reviewed.
 * @param turn - the turn number.
 * @returns the published projection, if the pane has one.
 */
export function useTurnChanges(sessionPath: string, turn: number): TurnChanges | undefined {
  return useStoreSelector(turnChangesStore, (state) =>
    state.bySession[sessionPath]?.find((change) => change.turn === turn),
  );
}
