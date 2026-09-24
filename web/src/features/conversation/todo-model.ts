/**
 * The todo list projection — the pure part, no React.
 *
 * dsh's todo is a whole-list snapshot type (`todo_write`): one `TodoItem` per
 * line, a three-state status, and a plan that is replaced wholesale. pi's `todo`
 * tool (shipped by the rpiv-todo extension) is an incremental one: six actions
 * (`create` / `update` / `list` / `get` / `delete` / `clear`), a four-state
 * status with a `deleted` tombstone, dependencies, and an `activeForm` label
 * shown while a task is in progress.
 *
 * What the two share — and the reason this module exists — is that every
 * successful call carries the *whole post-mutation list* under `details.tasks`.
 * That makes the current plan a projection of the transcript rather than state
 * this UI has to own: scan backwards for the last usable snapshot. It is also
 * exactly how the terminal panel rebuilds itself after `/reload` or compaction,
 * so both surfaces read the same source.
 */

import type { AgentMessage, TodoView, ToolResultMessage } from "../../lib/types.ts";
import type { Translate } from "../../lib/i18n/index.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

/**
 * One task, as much as the UI reads of it. Derived from unvalidated model JSON,
 * so every field is optional until checked — the extension's schema adds
 * `metadata`, which nothing here renders and therefore nothing here keeps.
 */
export interface TodoItem {
  id: number;
  subject: string;
  status: TodoStatus;
  /** Present-continuous label the extension shows while `in_progress`. */
  activeForm?: string;
  description?: string;
  /** Ids this task waits on; rendered as `⛓ #1,#2` on the task's row. */
  blockedBy?: number[];
  owner?: string;
}

const STATUSES: readonly string[] = ["pending", "in_progress", "completed", "deleted"];

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && STATUSES.includes(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** One task, or null when a field the UI depends on is missing or mistyped. */
function parseTask(value: unknown): TodoItem | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "number" || typeof raw.subject !== "string" || !isStatus(raw.status)) {
    return null;
  }

  const item: TodoItem = { id: raw.id, subject: raw.subject, status: raw.status };
  const activeForm = nonEmptyString(raw.activeForm);
  const description = nonEmptyString(raw.description);
  const owner = nonEmptyString(raw.owner);
  if (activeForm !== undefined) item.activeForm = activeForm;
  if (description !== undefined) item.description = description;
  if (owner !== undefined) item.owner = owner;
  if (Array.isArray(raw.blockedBy)) {
    const ids = raw.blockedBy.filter((id): id is number => typeof id === "number");
    if (ids.length > 0) item.blockedBy = ids;
  }
  return item;
}

export interface TodoSnapshot {
  /** The call's action, kept for callers that want to say what happened. */
  action: string;
  tasks: TodoItem[];
}

/**
 * Read one call's `details` into a snapshot.
 *
 * All-or-nothing on purpose: a list with one unusable row is not a list with
 * one row fewer, it is a payload this UI no longer understands, and rendering
 * the rows it did understand would show a plan that was never the plan. A null
 * answer makes the caller fall back one call further, or to the generic tool row.
 */
export function parseTodoSnapshot(details: unknown): TodoSnapshot | null {
  if (typeof details !== "object" || details === null) return null;
  const raw = details as Record<string, unknown>;
  if (!Array.isArray(raw.tasks)) return null;

  const tasks: TodoItem[] = [];
  for (const value of raw.tasks) {
    const task = parseTask(value);
    if (task === null) return null;
    tasks.push(task);
  }
  return { action: nonEmptyString(raw.action) ?? "", tasks };
}

/**
 * The current plan: the last usable `todo` snapshot in the transcript.
 *
 * Backwards rather than forwards, because only the newest snapshot matters and
 * a long session carries one per call. A malformed snapshot is skipped instead
 * of ending the search: the rows it came from are still a real record of the
 * list as it stood one call earlier.
 *
 * `list` / `get` calls are snapshots too — the extension answers both with the
 * same `details.tasks` — so they need no special case here.
 */
export function projectTodos(messages: readonly AgentMessage[]): TodoItem[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Partial<ToolResultMessage>;
    if (message.role !== "toolResult" || message.toolName !== "todo") continue;
    const snapshot = parseTodoSnapshot(message.details);
    if (snapshot !== null) return snapshot.tasks;
  }
  return [];
}

/**
 * The rows the UI shows.
 *
 * `deleted` is a tombstone: the task is kept so that a `blockedBy` id still
 * resolves, not so that anyone reads it. The terminal panel never renders one
 * either, and the two surfaces disagreeing about what the list contains would
 * be a worse bug than a missing row.
 */
export function visibleTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.filter((task) => task.status !== "deleted");
}

/**
 * Whether the panel should offer to install the task-list extension.
 *
 * There are four ways to answer "no", and they are not the same thing:
 *
 * - the app has not heard back yet (`view === null`), so the panel waits rather
 *   than flashing a notice at every reload;
 * - the read broke (`error`), and a broken read is not a missing package —
 *   offering an install could re-install something already present;
 * - the package is in pi's settings but disabled, which is the user's own
 *   choice to undo in the plugins section, not a missing dependency;
 * - the user closed the notice, which is why this preference exists at all.
 *
 * Only a clean "not installed" reaches the install offer.
 */
export function shouldOfferTodoInstall(view: TodoView | null, dismissed: boolean): boolean {
  if (dismissed || view === null || view.error !== null) return false;
  return !view.available && !view.installed;
}

/**
 * How many finished tasks the plan panel keeps on screen.
 *
 * dsh never faces this: its plan is replaced on every write and cleared on the
 * next turn, so the list stays short. pi's list is the session's and it is
 * cleared only deliberately, so a long session ends up with dozens of finished
 * rows — the real one this UI was built against had 40 of them above a single
 * unfinished task, which meant opening the panel and then scrolling past all of
 * them to find out what was left.
 *
 * Unfinished tasks are never dropped, only finished ones: the answer to "where
 * is it now?" is never a completed row.
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
 * Keeps the *most recently finished* rows rather than the oldest ones: tasks are
 * numbered in creation order, so the newest finished rows are the ones adjacent
 * to the work still in flight, and dropping the oldest keeps the visible window
 * contiguous instead of punching a hole in the middle of the list.
 */
export function limitCompleted(todos: readonly TodoItem[], limit: number): LimitedTodos {
  const rows = visibleTodos(todos);
  const finished = rows.filter((task) => task.status === "completed");
  if (finished.length <= limit) return { rows, hiddenCompleted: 0 };

  const kept = new Set(finished.slice(finished.length - Math.max(limit, 0)).map((task) => task.id));
  return {
    rows: rows.filter((task) => task.status !== "completed" || kept.has(task.id)),
    hiddenCompleted: finished.length - kept.size,
  };
}

export interface TodoSummary {
  done: number;
  total: number;
  active: number;
  pending: number;
  /**
   * Subject of the first task in progress, or null when nothing is running (or
   * when the first one is unusable). Several tasks may be in progress at once —
   * parallel work is a real state here — so the summary names one and counts
   * the rest rather than hiding them.
   */
  activeSubject: string | null;
  /** In-progress tasks beyond the named one; 0 whenever nothing is named. */
  activeExtra: number;
}

export function summarizeTodos(todos: readonly TodoItem[]): TodoSummary {
  const visible = visibleTodos(todos);
  const active = visible.filter((task) => task.status === "in_progress");
  const first = active[0];
  const named = first !== undefined && first.subject.trim() !== "";
  const done = visible.filter((task) => task.status === "completed").length;

  return {
    done,
    total: visible.length,
    active: active.length,
    pending: visible.length - done - active.length,
    activeSubject: named ? first.subject : null,
    activeExtra: named ? active.length - 1 : 0,
  };
}

/** The id this call acted on, when its arguments name one. */
export function todoCallId(args: Record<string, unknown> | undefined): number | null {
  const id = args?.id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

/** The call's action, when its arguments name one. */
export function todoCallAction(args: Record<string, unknown> | undefined): string {
  return nonEmptyString(args?.action) ?? "";
}

/**
 * What to say about a call whose snapshot is not readable yet: the action, the
 * id it names, and the subject it creates. Used while the call is still running
 * and from a rejected call, whose arguments are kept verbatim.
 *
 * Deliberately not dsh's `deriveSummary`: that one scans for any usable string
 * because dsh's todo call carries a whole list in its arguments. pi's carries an
 * action and an id, so its generic summary would read "update" and nothing else.
 */
export function todoArgsSummary(args: Record<string, unknown> | undefined): string {
  const action = todoCallAction(args);
  if (action === "") return "";
  const id = todoCallId(args);
  const subject = nonEmptyString(args?.subject);
  return [`${action}${id === null ? "" : ` #${String(id)}`}`, subject ?? ""]
    .filter((part) => part !== "")
    .join(" · ");
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
  return summary.activeSubject === null ? head : `${head} · ${summary.activeSubject}`;
}
