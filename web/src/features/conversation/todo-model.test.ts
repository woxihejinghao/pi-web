import { describe, expect, it } from "vitest";
import type { AgentMessage, TodoView } from "../../lib/types.ts";
import {
  limitCompleted,
  parseTodoSnapshot,
  progressLabel,
  projectTodos,
  rowSummary,
  shouldOfferTodoInstall,
  summarizeTodos,
  todoArgsSummary,
  todoCallAction,
  todoCallId,
  visibleTodos,
  type TodoItem,
} from "./todo-model.ts";

function task(overrides: Partial<TodoItem> & { id: number; status: TodoItem["status"] }): TodoItem {
  return { subject: `task ${String(overrides.id)}`, ...overrides };
}

/** A `todo` tool result carrying a snapshot, as pi writes it to the transcript. */
function toolResult(details: unknown, toolName = "todo"): AgentMessage {
  return { role: "toolResult", toolName, toolCallId: "call_1", content: [], details } as AgentMessage;
}

describe("parseTodoSnapshot", () => {
  it("reads a well-formed snapshot", () => {
    const snapshot = parseTodoSnapshot({
      action: "update",
      params: { action: "update", id: 2, status: "completed" },
      tasks: [{ id: 1, subject: "first", status: "pending" }],
      nextId: 2,
    });
    expect(snapshot).toEqual({ action: "update", tasks: [{ id: 1, subject: "first", status: "pending" }] });
  });

  it("accepts an empty list — clearing the plan is a real state", () => {
    expect(parseTodoSnapshot({ action: "clear", tasks: [], nextId: 1 })).toEqual({
      action: "clear",
      tasks: [],
    });
  });

  it("rejects payloads it only half understands", () => {
    // A list with one unusable row is not a list one row shorter; rendering the
    // rows it did understand would show a plan that was never the plan.
    expect(parseTodoSnapshot(null)).toBeNull();
    expect(parseTodoSnapshot("nope")).toBeNull();
    expect(parseTodoSnapshot({})).toBeNull();
    expect(parseTodoSnapshot({ tasks: {} })).toBeNull();
    expect(parseTodoSnapshot({ tasks: [{ id: 1, subject: "ok", status: "pending" }, null] })).toBeNull();
    expect(parseTodoSnapshot({ tasks: [{ id: "1", subject: "x", status: "pending" }] })).toBeNull();
    expect(parseTodoSnapshot({ tasks: [{ id: 1, subject: "x", status: "done" }] })).toBeNull();
    expect(parseTodoSnapshot({ tasks: [{ id: 1, status: "pending" }] })).toBeNull();
  });

  it("keeps the optional fields it renders, drops the empty ones", () => {
    const snapshot = parseTodoSnapshot({
      action: "create",
      tasks: [
        {
          id: 3,
          subject: "write tests",
          status: "in_progress",
          activeForm: "writing tests",
          description: "unit + integration",
          owner: "",
          blockedBy: [1, "2", 2],
        },
      ],
    });
    expect(snapshot?.tasks[0]).toEqual({
      id: 3,
      subject: "write tests",
      status: "in_progress",
      activeForm: "writing tests",
      description: "unit + integration",
      blockedBy: [1, 2],
    });
  });

  it("drops a blockedBy that holds no usable id", () => {
    const snapshot = parseTodoSnapshot({
      tasks: [{ id: 1, subject: "x", status: "pending", blockedBy: [] }],
    });
    expect(snapshot?.tasks[0]?.blockedBy).toBeUndefined();
  });
});

describe("projectTodos", () => {
  it("takes the last snapshot, not the first", () => {
    const messages = [
      toolResult({ action: "create", tasks: [task({ id: 1, status: "pending" })] }),
      toolResult({ action: "update", tasks: [task({ id: 1, status: "completed" })] }),
    ];
    expect(projectTodos(messages)).toEqual([task({ id: 1, status: "completed" })]);
  });

  it("skips a malformed snapshot and falls back to the previous one", () => {
    const healthy = toolResult({ action: "create", tasks: [task({ id: 1, status: "pending" })] });
    const truncated = toolResult({ action: "update", tasks: "…" });
    expect(projectTodos([healthy, truncated])).toEqual([task({ id: 1, status: "pending" })]);
  });

  it("counts every action as a snapshot, including the read-only ones", () => {
    // `list` and `get` answer with the same whole-list field, so nothing has to
    // special-case them — a projection that skipped them would be wrong.
    const messages = [
      toolResult({ action: "create", tasks: [task({ id: 1, status: "pending" })] }),
      toolResult({ action: "list", tasks: [task({ id: 1, status: "completed" })] }),
    ];
    expect(projectTodos(messages)).toEqual([task({ id: 1, status: "completed" })]);
  });

  it("ignores other tools, other roles, and sessions with no plan", () => {
    const messages = [
      { role: "assistant", content: [], details: { tasks: [task({ id: 9, status: "pending" })] } },
      toolResult({ action: "create", tasks: [task({ id: 9, status: "pending" })] }, "bash"),
    ] as AgentMessage[];
    expect(projectTodos(messages)).toEqual([]);
    expect(projectTodos([])).toEqual([]);
  });
});

describe("summarizeTodos", () => {
  const todos: TodoItem[] = [
    task({ id: 1, status: "completed" }),
    task({ id: 2, status: "completed" }),
    task({ id: 3, status: "in_progress", activeForm: "writing tests" }),
    task({ id: 4, status: "in_progress" }),
    task({ id: 5, status: "pending" }),
    task({ id: 6, status: "deleted" }),
  ];

  it("counts the visible rows and names one active task while counting the rest", () => {
    const summary = summarizeTodos(todos);
    expect(summary).toMatchObject({ done: 2, total: 5, active: 2, pending: 1, activeExtra: 1 });
    expect(summary.activeSubject).toBe("task 3");
  });

  it("leaves tombstones out of every count", () => {
    expect(visibleTodos(todos).map((t) => t.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("names nothing when the first active task has a blank subject", () => {
    const summary = summarizeTodos([
      task({ id: 1, status: "in_progress", subject: "   " }),
      task({ id: 2, status: "in_progress" }),
    ]);
    expect(summary.activeSubject).toBeNull();
    expect(summary.activeExtra).toBe(0);
    expect(summary.active).toBe(2);
  });
});

describe("limitCompleted", () => {
  it("leaves a short list alone", () => {
    const todos = [task({ id: 1, status: "completed" }), task({ id: 2, status: "pending" })];
    expect(limitCompleted(todos, 3)).toEqual({ rows: todos, hiddenCompleted: 0 });
  });

  it("keeps the newest finished rows and counts the rest", () => {
    // 40 finished rows above one open task is the real session this was built
    // against: without trimming, the open row is behind three screens of history.
    const todos = [
      ...Array.from({ length: 40 }, (_, index) => task({ id: index + 1, status: "completed" })),
      task({ id: 41, status: "pending" }),
    ];
    const { rows, hiddenCompleted } = limitCompleted(todos, 3);
    expect(rows.map((row) => row.id)).toEqual([38, 39, 40, 41]);
    expect(hiddenCompleted).toBe(37);
  });

  it("never drops an unfinished row, whichever side of the list it is on", () => {
    const todos = [
      task({ id: 1, status: "in_progress" }),
      task({ id: 2, status: "completed" }),
      task({ id: 3, status: "completed" }),
      task({ id: 4, status: "pending" }),
      task({ id: 5, status: "completed" }),
      task({ id: 6, status: "completed" }),
    ];
    const { rows, hiddenCompleted } = limitCompleted(todos, 2);
    expect(rows.map((row) => row.id)).toEqual([1, 4, 5, 6]);
    expect(hiddenCompleted).toBe(2);
  });

  it("does not count tombstones as finished", () => {
    const todos = [task({ id: 1, status: "deleted" }), task({ id: 2, status: "completed" })];
    expect(limitCompleted(todos, 3)).toEqual({
      rows: [task({ id: 2, status: "completed" })],
      hiddenCompleted: 0,
    });
  });
});

describe("labels", () => {
  it("joins only the non-zero counts, with a separator HTML would keep", () => {
    const label = progressLabel(summarizeTodos([
      task({ id: 1, status: "completed" }),
      task({ id: 2, status: "in_progress" }),
      task({ id: 3, status: "pending" }),
      task({ id: 4, status: "pending" }),
    ]));
    // En spaces (U+2002) on both sides: ASCII runs collapse in HTML.
    expect(label).toBe("1 已完成\u2002·\u20021 进行中\u2002·\u20022 待处理");
  });

  it("omits zero-count segments rather than printing a zero", () => {
    expect(progressLabel(summarizeTodos([task({ id: 1, status: "completed" })]))).toBe("1 已完成");
  });

  it("appends the active subject to the row summary only while one is running", () => {
    expect(rowSummary(summarizeTodos([task({ id: 1, status: "completed" }), task({ id: 2, status: "pending" })]))).toBe(
      "1/2 已完成",
    );
    expect(
      rowSummary(summarizeTodos([task({ id: 1, status: "in_progress", subject: "porting the theme" })])),
    ).toBe("0/1 已完成 · porting the theme");
  });
});

describe("call arguments", () => {
  it("reads the id an update or delete acts on", () => {
    expect(todoCallId({ action: "update", id: 7, status: "completed" })).toBe(7);
    expect(todoCallId({ action: "clear" })).toBeNull();
    expect(todoCallId(undefined)).toBeNull();
    expect(todoCallId({ id: "7" })).toBeNull();
  });

  it("reads the action, defaulting to an empty string it can render", () => {
    expect(todoCallAction({ action: "create" })).toBe("create");
    expect(todoCallAction({})).toBe("");
    expect(todoCallAction(undefined)).toBe("");
  });

  it("summarizes a call from its arguments when the snapshot cannot be read", () => {
    expect(todoArgsSummary({ action: "create", subject: "port the panel" })).toBe("create · port the panel");
    expect(todoArgsSummary({ action: "update", id: 3, status: "completed" })).toBe("update #3");
    expect(todoArgsSummary({ action: "clear" })).toBe("clear");
    expect(todoArgsSummary({})).toBe("");
  });
});

/** A clean "not installed" answer, which each case bends one field of. */
function todoView(overrides: Partial<TodoView> = {}): TodoView {
  return {
    available: false,
    installed: false,
    packageName: "@juicesharp/rpiv-todo",
    source: "npm:@juicesharp/rpiv-todo",
    projectPath: null,
    error: null,
    ...overrides,
  };
}

describe("shouldOfferTodoInstall", () => {
  it("offers the install when the package is cleanly absent", () => {
    expect(shouldOfferTodoInstall(todoView(), false)).toBe(true);
  });

  it("stays quiet until the answer arrives", () => {
    // The panel is mounted from the first paint, so `null` is the normal state
    // during every reload — a notice here would flash on each one.
    expect(shouldOfferTodoInstall(null, false)).toBe(false);
  });

  it("stays quiet when the read broke", () => {
    // A broken read is not a missing package: installing could re-install one
    // that is already there.
    expect(shouldOfferTodoInstall(todoView({ error: "boom" }), false)).toBe(false);
  });

  it("does not re-offer a package that is installed", () => {
    expect(shouldOfferTodoInstall(todoView({ installed: true }), false)).toBe(false);
    // Disabled is the user's own choice, undoable in the plugins section.
    expect(shouldOfferTodoInstall(todoView({ installed: true, available: true }), false)).toBe(false);
  });

  it("honours the dismissal", () => {
    expect(shouldOfferTodoInstall(todoView(), true)).toBe(false);
  });
});
