import { describe, expect, it } from "vitest";
import { translator } from "../../lib/i18n/index.ts";
import type { AgentMessage } from "../../lib/types.ts";
import {
  limitCompleted,
  parseTodoSnapshot,
  progressLabel,
  projectTodos,
  rowSummary,
  summarizeTodos,
  todosInArgs,
  type TodoItem,
  type TodoSummary,
} from "./todo-model.ts";

const zh = translator("zh-CN");
const progress = (summary: TodoSummary): string => progressLabel(summary, zh);
const row = (summary: TodoSummary): string => rowSummary(summary, zh);

function task(content: string, status: TodoItem["status"]): TodoItem {
  return { content, status };
}

/** A `todo` tool result carrying a snapshot, as pi writes it to the transcript. */
function toolResult(details: unknown, toolName = "todo"): AgentMessage {
  return { role: "toolResult", toolName, toolCallId: "call_1", content: [], details } as AgentMessage;
}

/** A prompt, which is what opens a turn. */
function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

describe("parseTodoSnapshot", () => {
  it("reads a well-formed whole-list snapshot", () => {
    expect(parseTodoSnapshot({
      todos: [task("first", "pending"), task("second", "in_progress")],
      counts: { pending: 1, inProgress: 1, completed: 0 },
    })).toEqual([task("first", "pending"), task("second", "in_progress")]);
  });

  it("accepts an empty list — clearing the plan is a real state", () => {
    expect(parseTodoSnapshot({ todos: [], counts: { pending: 0, inProgress: 0, completed: 0 } })).toEqual([]);
  });

  it("rejects payloads it only half understands", () => {
    // A list with one unusable row is not a list one row shorter; rendering the
    // rows it did understand would show a plan that was never the plan.
    expect(parseTodoSnapshot(null)).toBeNull();
    expect(parseTodoSnapshot("nope")).toBeNull();
    expect(parseTodoSnapshot({})).toBeNull();
    expect(parseTodoSnapshot({ todos: {} })).toBeNull();
    expect(parseTodoSnapshot({ todos: [{ content: "ok", status: "pending" }, null] })).toBeNull();
    expect(parseTodoSnapshot({ todos: [{ content: 1, status: "pending" }] })).toBeNull();
    expect(parseTodoSnapshot({ todos: [{ content: "", status: "pending" }] })).toBeNull();
    expect(parseTodoSnapshot({ todos: [{ content: "x", status: "done" }] })).toBeNull();
    expect(parseTodoSnapshot({ todos: [{ content: "x", status: "deleted" }] })).toBeNull();
  });

  it("maps the old incremental payload onto the same shape", () => {
    // `@juicesharp/rpiv-todo` answered with `tasks`, `subject` and a fourth
    // `deleted` state; a session older than the switch still shows its plan.
    const snapshot = parseTodoSnapshot({
      action: "update",
      tasks: [
        { id: 1, subject: "first", status: "pending" },
        { id: 2, subject: "second", status: "completed" },
      ],
      nextId: 3,
    });
    expect(snapshot).toEqual([task("first", "pending"), task("second", "completed")]);
  });

  it("keeps the legacy reader lenient, because its tombstones are normal", () => {
    const snapshot = parseTodoSnapshot({
      tasks: [
        { id: 1, subject: "kept", status: "in_progress" },
        { id: 2, subject: "gone", status: "deleted" },
        { id: 3, subject: "broken", status: "done" },
        null,
      ],
    });
    expect(snapshot).toEqual([task("kept", "in_progress")]);
  });
});

describe("projectTodos", () => {
  it("takes the last snapshot, not the first", () => {
    const messages = [
      toolResult({ todos: [task("task 1", "pending")] }),
      toolResult({ todos: [task("task 1", "completed")] }),
    ];
    expect(projectTodos(messages)).toEqual([task("task 1", "completed")]);
  });

  it("skips a malformed snapshot and falls back to the previous one", () => {
    const healthy = toolResult({ todos: [task("task 1", "pending")] });
    const truncated = toolResult({ todos: "…" });
    expect(projectTodos([healthy, truncated])).toEqual([task("task 1", "pending")]);
  });

  it("reads a session that still carries the old payload", () => {
    const messages = [toolResult({ action: "create", tasks: [{ id: 1, subject: "old", status: "pending" }] })];
    expect(projectTodos(messages)).toEqual([task("old", "pending")]);
  });

  it("clears the plan when a new turn opens, the way dsh does at turn/start", () => {
    const messages = [
      user("first"),
      toolResult({ todos: [task("task 1", "completed")] }),
      user("second"),
    ];
    // The previous turn's list is not this turn's plan: the panel is empty until
    // the agent writes one again.
    expect(projectTodos(messages)).toEqual([]);
  });

  it("shows what the newest turn wrote, not what the one before it did", () => {
    const messages = [
      user("first"),
      toolResult({ todos: [task("old", "completed")] }),
      user("second"),
      toolResult({ todos: [task("new", "pending")] }),
    ];
    expect(projectTodos(messages)).toEqual([task("new", "pending")]);
  });

  it("keeps the plan while the newest prompt is still queued", () => {
    const messages = [
      user("first"),
      toolResult({ todos: [task("task 1", "in_progress")] }),
      user("second"),
    ];
    // pi has not picked the second prompt up, so it has not opened a turn — and
    // the plan it will replace is still the one being worked on.
    expect(projectTodos(messages, 1)).toEqual([task("task 1", "in_progress")]);
  });

  it("ignores other tools, other roles, and sessions with no plan", () => {
    const messages = [
      { role: "assistant", content: [], details: { todos: [task("task 9", "pending")] } },
      toolResult({ todos: [task("task 9", "pending")] }, "bash"),
    ] as AgentMessage[];
    expect(projectTodos(messages)).toEqual([]);
    expect(projectTodos([])).toEqual([]);
  });
});

describe("todosInArgs", () => {
  it("reads the list a call was asked to write", () => {
    // The whole list lives in the arguments, so a running or failed call still
    // has a real summary.
    expect(todosInArgs({ todos: [task("task 1", "in_progress")] })).toEqual([task("task 1", "in_progress")]);
  });

  it("is null when the arguments carry no usable list", () => {
    expect(todosInArgs(undefined)).toBeNull();
    expect(todosInArgs({ action: "update", id: 7 })).toBeNull();
  });
});

describe("summarizeTodos", () => {
  const todos: TodoItem[] = [
    task("done one", "completed"),
    task("done two", "completed"),
    task("running one", "in_progress"),
    task("running two", "in_progress"),
    task("waiting", "pending"),
  ];

  it("counts the rows and names one active task while counting the rest", () => {
    const summary = summarizeTodos(todos);
    expect(summary).toMatchObject({ done: 2, total: 5, active: 2, pending: 1, activeExtra: 1 });
    expect(summary.activeContent).toBe("running one");
  });

  it("names nothing when the first active task has blank content", () => {
    const summary = summarizeTodos([
      task("   ", "in_progress"),
      task("running", "in_progress"),
    ]);
    expect(summary.activeContent).toBeNull();
    expect(summary.activeExtra).toBe(0);
    expect(summary.active).toBe(2);
  });
});

describe("limitCompleted", () => {
  it("leaves a short list alone", () => {
    const todos = [task("one", "completed"), task("two", "pending")];
    expect(limitCompleted(todos, 3)).toEqual({ rows: todos, hiddenCompleted: 0 });
  });

  it("keeps the newest finished rows and counts the rest", () => {
    // 40 finished rows above one open task is the real session this was built
    // against: without trimming, the open row is behind three screens of history.
    const todos = [
      ...Array.from({ length: 40 }, (_, index) => task(`done ${String(index + 1)}`, "completed")),
      task("open", "pending"),
    ];
    const { rows, hiddenCompleted } = limitCompleted(todos, 3);
    expect(rows.map((row) => row.content)).toEqual(["done 38", "done 39", "done 40", "open"]);
    expect(hiddenCompleted).toBe(37);
  });

  it("never drops an unfinished row, whichever side of the list it is on", () => {
    const todos = [
      task("running", "in_progress"),
      task("done one", "completed"),
      task("done two", "completed"),
      task("waiting", "pending"),
      task("done three", "completed"),
      task("done four", "completed"),
    ];
    const { rows, hiddenCompleted } = limitCompleted(todos, 2);
    expect(rows.map((row) => row.content)).toEqual(["running", "waiting", "done three", "done four"]);
    expect(hiddenCompleted).toBe(2);
  });
});

describe("labels", () => {
  it("joins only the non-zero counts, with a separator HTML would keep", () => {
    const label = progress(summarizeTodos([
      task("one", "completed"),
      task("two", "in_progress"),
      task("three", "pending"),
      task("four", "pending"),
    ]));
    // En spaces (U+2002) on both sides: ASCII runs collapse in HTML.
    expect(label).toBe("1 已完成\u2002·\u20021 进行中\u2002·\u20022 待处理");
  });

  it("omits zero-count segments rather than printing a zero", () => {
    expect(progress(summarizeTodos([task("one", "completed")]))).toBe("1 已完成");
  });

  it("appends the active task to the row summary only while one is running", () => {
    expect(row(summarizeTodos([task("one", "completed"), task("two", "pending")]))).toBe("1/2 已完成");
    expect(row(summarizeTodos([task("porting the theme", "in_progress")]))).toBe("0/1 已完成 · porting the theme");
  });
});
