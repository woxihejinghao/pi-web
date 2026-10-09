import { beforeEach, describe, expect, it } from "vitest";
import type { TurnFile } from "../conversation/turn-files.ts";
import { publishTurnChanges, turnChangesList, turnChangesStore } from "./turn-changes-store.ts";

function file(display: string, overrides: Partial<TurnFile> = {}): TurnFile {
  return {
    path: `/proj/${display}`,
    relative: display,
    display,
    added: 1,
    deleted: 0,
    patches: [],
    oversized: false,
    ...overrides,
  };
}

beforeEach(() => {
  turnChangesStore.set({ bySession: {} });
});

describe("turnChangesList", () => {
  it("hands the turns over ascending, whatever order the map iterated", () => {
    const byTurn = new Map<number, readonly TurnFile[]>([
      [3, [file("c.ts")]],
      [1, [file("a.ts")]],
      [2, [file("b.ts")]],
    ]);

    expect(turnChangesList(byTurn).map((change) => change.turn)).toEqual([1, 2, 3]);
  });
});

/**
 * The store is the conversation pane's side of the review tab: the pane
 * publishes, the tab reads, and the two must not disagree about whether
 * something changed.
 */
describe("publishTurnChanges", () => {
  it("keeps each session's turns under its own key", () => {
    publishTurnChanges("session-a", [{ turn: 1, files: [file("a.ts")] }]);
    publishTurnChanges("session-b", [{ turn: 2, files: [file("b.ts")] }]);

    const state = turnChangesStore.get();
    expect(state.bySession["session-a"]).toHaveLength(1);
    expect(state.bySession["session-a"]?.[0]?.turn).toBe(1);
    expect(state.bySession["session-b"]?.[0]?.files[0]?.display).toBe("b.ts");
  });

  it("ignores an empty session path rather than filing under the empty key", () => {
    publishTurnChanges("", [{ turn: 1, files: [file("a.ts")] }]);
    expect(turnChangesStore.get().bySession[""]).toBeUndefined();
  });

  it("does not wake subscribers when the projection is unchanged", () => {
    let notifications = 0;
    const unsubscribe = turnChangesStore.subscribe(() => {
      notifications += 1;
    });

    const files = [file("a.ts", { added: 2, deleted: 1 })];
    publishTurnChanges("session-a", [{ turn: 1, files }]);
    // The pane recomputes its projection on every message that lands, so an
    // equal one has to be a no-op or every round-trip wakes every review tab.
    publishTurnChanges("session-a", [{ turn: 1, files: [file("a.ts", { added: 2, deleted: 1 })] }]);
    expect(notifications).toBe(1);

    publishTurnChanges("session-a", [{ turn: 1, files: [file("a.ts", { added: 3, deleted: 1 })] }]);
    expect(notifications).toBe(2);
    unsubscribe();
  });
});
