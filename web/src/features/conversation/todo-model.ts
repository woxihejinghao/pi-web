/**
 * The todo list projection — the pure part, no React.
 *
 * One `todo` call carries the whole list and replaces the previous one, the way
 * dsh's `todo_write` does: each entry is a `content` line and a three-state
 * `status`, and nothing else — a list that is replaced wholesale needs no id,
 * no priority and no tombstone. So the current plan is a projection of the
 * transcript — scan the newest turn backwards for the newest usable snapshot —
 * rather than state this UI has to own, which is also what makes the panel
 * survive a `/reload` and a compaction.
 *
 * `tasks` is read as well. That is what the tool answered with before it moved
 * into this project (`@juicesharp/rpiv-todo`): an incremental list carrying ids,
 * a `deleted` tombstone and `blockedBy` deps. A session that predates the switch
 * still shows its plan; the extra fields are dropped rather than half-rendered,
 * because nothing here can act on an id any more.
 */

import type { AgentMessage, ToolResultMessage } from "../../lib/types.ts";
import type { Translate } from "../../lib/i18n/index.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

/** One task, as much as the UI reads of it. */
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const STATUSES: readonly string[] = ["pending", "in_progress", "completed"];

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && STATUSES.includes(value);
}

/** One entry, or null when either field the UI reads is missing or mistyped. */
function parseItem(value: unknown): TodoItem | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { content?: unknown; status?: unknown };
  if (typeof raw.content !== "string" || raw.content === "" || !isStatus(raw.status)) return null;
  return { content: raw.content, status: raw.status };
}

/**
 * The old tool's entry: `subject` names it, `status` carries a fourth state,
 * and `deleted` is a tombstone kept so a `blockedBy` id still resolves. A
 * tombstone was never meant to be read, so it drops out here like an unusable
 * row; everything else is mapped onto the current shape.
 */
function parseLegacyItem(value: unknown): TodoItem | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { subject?: unknown; status?: unknown };
  if (raw.status === "deleted" || typeof raw.subject !== "string" || raw.subject === "" || !isStatus(raw.status)) {
    return null;
  }
  return { content: raw.subject, status: raw.status };
}

/**
 * Read one payload into the plan it holds, or null when it holds no list.
 *
 * The current shape is all-or-nothing on purpose: a list with one unusable row
 * is not a list with one row fewer, it is a payload this UI no longer
 * understands, and rendering the rows it did understand would show a plan that
 * was never the plan. A null answer makes the caller walk one call further back,
 * or fall back to the arguments. The legacy shape is read leniently, because its
 * tombstones are a normal part of the payload rather than a sign of damage.
 */
export function parseTodoSnapshot(details: unknown): TodoItem[] | null {
  if (typeof details !== "object" || details === null) return null;
  const raw = details as { todos?: unknown; tasks?: unknown };

  if (Array.isArray(raw.todos)) {
    const todos: TodoItem[] = [];
    for (const value of raw.todos) {
      const item = parseItem(value);
      if (item === null) return null;
      todos.push(item);
    }
    return todos;
  }

  if (Array.isArray(raw.tasks)) {
    const todos: TodoItem[] = [];
    for (const value of raw.tasks) {
      const item = parseLegacyItem(value);
      if (item !== null) todos.push(item);
    }
    return todos;
  }

  return null;
}

/**
 * Where the newest turn opens: the index of the last user message pi has taken
 * up. Everything before it belongs to an earlier turn.
 *
 * `undelivered` is how many trailing user messages pi has not picked up yet —
 * the same figure `groupTurns` folds into the turn in flight, and the same one
 * `useConversation` publishes as `undeliveredPrompts`. A queued prompt does not
 * open a turn until pi reaches it, so it must not clear the plan either.
 */
function currentTurnStart(messages: readonly AgentMessage[], undelivered: number): number {
  let delivered =
    messages.reduce((count, message) => (message.role === "user" ? count + 1 : count), 0) - undelivered;
  let start = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role !== "user") continue;
    delivered -= 1;
    // A queued prompt sits after the turn it belongs to; it opens no new one.
    if (delivered < 0) break;
    start = index;
  }
  return start;
}

/**
 * The current plan: the last usable `todo` snapshot written since the newest
 * turn opened.
 *
 * dsh clears its plan at `turn/start` and keeps it through `turn/end`, so its
 * panel only ever describes the turn it belongs to. The same rule is projected
 * here rather than stored: a turn opens at each user message pi has taken up, so
 * a snapshot older than the newest one is not this turn's plan — it is the
 * previous turn's. Nothing has to be cleared, and `/reload`, branching and
 * compaction all agree, because the boundary is in the transcript.
 *
 * Backwards rather than forwards, because only the newest snapshot matters and a
 * turn carries one per call. A malformed snapshot is skipped instead of ending
 * the search: the rows it came from are still a real record of the list as it
 * stood one call earlier.
 */
export function projectTodos(messages: readonly AgentMessage[], undelivered = 0): TodoItem[] {
  const start = currentTurnStart(messages, undelivered);
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index] as Partial<ToolResultMessage>;
    if (message.role !== "toolResult" || message.toolName !== "todo") continue;
    const snapshot = parseTodoSnapshot(message.details);
    if (snapshot !== null) return snapshot;
  }
  return [];
}

/**
 * The plan a call is writing, read off its arguments.
 *
 * A whole-list write puts the list in the arguments, so a call still running —
 * or one that failed and therefore has no usable result — can still be
 * summarized from what it was asked to do. The arguments are the well-formed
 * payload the write itself carries, so the same reader handles both.
 */
export function todosInArgs(args: Record<string, unknown> | undefined): TodoItem[] | null {
  return parseTodoSnapshot(args);
}

/**
 * How many finished tasks the plan panel keeps on screen.
 *
 * dsh does not need this layer — its plan is cleared at the start of the next
 * turn, so a list only ever describes one turn and stays short. Here one turn can
 * still finish a dozen tasks (a fan-out migration, a batch of renames) against a
 * panel that is 180px tall, and the answer a reader opens it for is "where is it
 * now?" — never a completed row.
 *
 * Unfinished tasks are never dropped, only finished ones.
 */
export const PANEL_COMPLETED_LIMIT = 3;

export interface LimitedTodos {
  rows: TodoItem[];
  /** Finished rows left out, for the `+N 项已完成` line. */
  hiddenCompleted: number;
}

/**
 * Trim the finished tail of the list for the panel.
 *
 * Keeps the *most recently finished* rows rather than the oldest ones: the list
 * is written in plan order, so the newest finished rows are the ones adjacent to
 * the work still in flight, and dropping the oldest keeps the visible window
 * contiguous instead of punching a hole in the middle of the list.
 */
export function limitCompleted(todos: readonly TodoItem[], limit: number): LimitedTodos {
  const finished = todos.filter((task) => task.status === "completed");
  if (finished.length <= limit) return { rows: [...todos], hiddenCompleted: 0 };

  const kept = new Set(finished.slice(finished.length - Math.max(limit, 0)).map((task) => task.content));
  return {
    rows: todos.filter((task) => task.status !== "completed" || kept.has(task.content)),
    hiddenCompleted: finished.length - kept.size,
  };
}

export interface TodoSummary {
  done: number;
  total: number;
  active: number;
  pending: number;
  /**
   * Content of the first task in progress, or null when nothing is running (or
   * when the first one is unusable). Several tasks may be in progress at once —
   * parallel work is a real state here — so the summary names one and counts
   * the rest rather than hiding them.
   */
  activeContent: string | null;
  /** In-progress tasks beyond the named one; 0 whenever nothing is named. */
  activeExtra: number;
}

export function summarizeTodos(todos: readonly TodoItem[]): TodoSummary {
  const active = todos.filter((task) => task.status === "in_progress");
  const first = active[0];
  const named = first !== undefined && first.content.trim() !== "";
  const done = todos.filter((task) => task.status === "completed").length;

  return {
    done,
    total: todos.length,
    active: active.length,
    pending: todos.length - done - active.length,
    activeContent: named ? first.content : null,
    activeExtra: named ? active.length - 1 : 0,
  };
}

/**
 * The panel header's summary: `2 已完成 · 1 进行中 · 3 待处理`, zero-count
 * segments omitted as noise (a non-empty list keeps at least one).
 *
 * The separator is an en space on each side (U+2002) rather than an ASCII
 * space, which HTML would collapse — dsh's wording and its reason.
 */
export function progressLabel(summary: TodoSummary, t: Translate): string {
  return [
    ...(summary.done > 0 ? [t("todo.summaryDone", { count: summary.done })] : []),
    ...(summary.active > 0 ? [t("todo.summaryActive", { count: summary.active })] : []),
    ...(summary.pending > 0 ? [t("todo.summaryPending", { count: summary.pending })] : []),
  ].join("\u2002·\u2002");
}

/** The collapsed row's summary, matching dsh's `{done}/{total} 已完成 · 当前项`. */
export function rowSummary(summary: TodoSummary, t: Translate): string {
  const head = t("todo.summaryHead", { done: summary.done, total: summary.total });
  return summary.activeContent === null ? head : `${head} · ${summary.activeContent}`;
}
