/**
 * What one `todo` write changed relative to the one before it — the pure part,
 * ported from dsh's `todo-diff-model.ts` plus the details projection its
 * `todo-history.ts` provides.
 *
 * dsh diffs two recorded snapshots: a call's baseline is the previous snapshot
 * in the same transcript, matched per task by `content` (the tool rejects a
 * duplicate, so content is the identity), and the result splits the new list
 * into added / updated (status changed or row moved) / unchanged while the
 * leftovers of the old list are the removed set. The baseline here is found the
 * same way, just without the event log: see `todoBaselinesOf`.
 */

import type { Translate } from "../../lib/i18n/index.ts";
import type { AgentMessage } from "../../lib/types.ts";
import { isContentBlock } from "../../lib/types.ts";
import { parseTodoSnapshot, type TodoItem } from "./todo-model.ts";

/** One task plus how this write touched it, as the diff card reads it. */
export interface TodoDiffItem {
  content: string;
  status: TodoItem["status"];
  /** How this row differs from the baseline list; null when unchanged. */
  change: "added" | "updated" | "moved" | "removed" | null;
  /** Human name for the change, also the row's status glyph aria-label. */
  changeLabel: string;
  /** The status this row had before the write, when the status is what changed. */
  previousStatusLabel?: string;
}

export interface TodoDiff {
  /**
   * Changed and added rows in the current list's order, then the removed rows
   * in the previous list's order — dsh's ordering.
   */
  items: TodoDiffItem[];
  /** Rows this write did not touch, shown folded away. */
  unchanged: TodoDiffItem[];
  /** "首次记录" vs "与上次清单相比". */
  caption: string;
  /** The one-line tally for the collapsed row ("新增 2 · 更新 1"), never empty. */
  summary: string;
}

/** Labels for the three statuses, shared by the diff rows' prev→now text. */
export function todoStatusLabel(status: TodoItem["status"], t: Translate): string {
  switch (status) {
    case "completed":
      return t("todo.status.completed");
    case "in_progress":
      return t("todo.status.inProgress");
    case "pending":
      return t("todo.status.pending");
  }
}

function statusChangedLabel(t: Translate): string {
  return t("todo.diff.updatedItem");
}

/**
 * Diff `current` against `previous` — undefined baseline means the first write
 * this session has recorded, so every row reads as added. Mirrors dsh's
 * `detailsFor` field for field, including its quirks: a moved row counts into
 * `updated` in the summary but shows no mark of its own (only its aria label),
 * and a removed row carries no status glyph, just the mark.
 */
export function todoDiffModel(
  current: readonly TodoItem[],
  previous: readonly TodoItem[] | undefined,
  t: Translate,
): TodoDiff {
  const initial = previous === undefined;
  const caption = initial ? t("todo.diff.initial") : t("todo.diff.compare");

  const previousByContent = new Map(previous?.map((item) => [item.content, item]) ?? []);
  const currentContents = new Set(current.map((item) => item.content));
  // Previous positions of the rows that survive, so a reorder is distinguishable
  // from a same-place edit — dsh's `retainedPositions`.
  const retainedPositions = new Map<string, number>();
  let retainedIndex = 0;
  for (const item of previous ?? []) {
    if (currentContents.has(item.content)) {
      retainedPositions.set(item.content, retainedIndex);
      retainedIndex += 1;
    }
  }

  const items: TodoDiffItem[] = [];
  const unchanged: TodoDiffItem[] = [];
  let added = 0;
  let updated = 0;
  // Where the current pass stands among the retained rows — a retained row
  // whose previous position differs from this cursor moved.
  let retainedCursor = 0;

  for (const item of current) {
    const before = previousByContent.get(item.content);
    const statusLabel = todoStatusLabel(item.status, t);
    if (before === undefined) {
      added += 1;
      items.push({ content: item.content, status: item.status, change: "added", changeLabel: t("todo.diff.addedItem") });
      continue;
    }
    const moved = retainedPositions.get(item.content) !== retainedCursor;
    retainedCursor += 1;
    const statusChanged = before.status !== item.status;
    if (statusChanged || moved) {
      updated += 1;
      items.push({
        content: item.content,
        status: item.status,
        change: statusChanged ? "updated" : "moved",
        changeLabel: statusChanged ? statusChangedLabel(t) : t("todo.diff.movedItem"),
        ...(statusChanged && before.status !== undefined
          ? { previousStatusLabel: todoStatusLabel(before.status, t) }
          : {}),
      });
      continue;
    }
    unchanged.push({ content: item.content, status: item.status, change: null, changeLabel: statusLabel });
  }

  const removed: TodoDiffItem[] = [];
  for (const item of previous ?? []) {
    if (currentContents.has(item.content)) continue;
    removed.push({
      content: item.content,
      status: item.status,
      change: "removed",
      changeLabel: t("todo.diff.removedItem"),
    });
  }
  items.push(...removed);

  const counts: string[] = [];
  if (added > 0) counts.push(t("todo.diff.added", { count: added }));
  if (updated > 0) counts.push(t("todo.diff.updated", { count: updated }));
  if (removed.length > 0) counts.push(t("todo.diff.removed", { count: removed.length }));
  const summary = counts.join(" · ") || t("todo.diff.noChanges");

  return { items, unchanged, caption, summary };
}

/**
 * Baseline snapshot per `todo` call id: the newest snapshot recorded strictly
 * before the call, or undefined for the first one. A forward pass over the
 * transcript — dsh gets this from its event-sourced history; here the
 * transcript is the history, and a call that never answers (or answers with a
 * parse error) leaves the previous snapshot standing, the same way dsh only
 * records successful writes.
 */
export function todoBaselinesOf(messages: readonly AgentMessage[]): Map<string, readonly TodoItem[] | undefined> {
  const baselines = new Map<string, readonly TodoItem[] | undefined>();
  let last: readonly TodoItem[] | undefined;
  for (const message of messages) {
    if (message.role === "assistant") {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isContentBlock(block)) continue;
        const call = block as { type?: string; name?: string; id?: string };
        if (call.type === "toolCall" && call.name === "todo" && typeof call.id === "string") {
          baselines.set(call.id, last);
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      const result = message as { toolName?: string; details?: unknown };
      if (result.toolName !== "todo") continue;
      const snapshot = parseTodoSnapshot(result.details);
      if (snapshot !== null) last = snapshot;
    }
  }
  return baselines;
}
