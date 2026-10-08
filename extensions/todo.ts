/**
 * Todo — the agent's task list, shipped here instead of installed.
 *
 * The shape is dsh's `todo_write`, not the incremental tool
 * `@juicesharp/rpiv-todo` provides: every call carries the COMPLETE list and
 * replaces the previous one, so an entry is just a `content` line and a
 * three-state `status`. No id, no dependency field, no tombstone — the list is
 * the state, and whole-list replacement is what makes that stable.
 *
 * Nothing is remembered between calls. A panel or a row that wants "the plan
 * right now" reads the newest `todo` tool result out of the transcript, which is
 * why `/reload`, compaction and branching all keep working without this file
 * owning a single byte of mutable state.
 *
 * The tool keeps the name `todo` rather than dsh's `todo_write`: the web UI
 * dispatches its task row on `todo`, and older sessions carry `todo` results
 * from the extension this one replaces — two names would split one list in two.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** The complete lifecycle a task can be in. Anything else is not a task state. */
const STATUSES = ["pending", "in_progress", "completed"] as const;

type TodoStatus = (typeof STATUSES)[number];

/** One line of the plan — the unit a whole-list write replaces. */
interface TodoItem {
	content: string;
	status: TodoStatus;
}

/** The tool result payload the panel and the terminal row project from. */
interface TodoDetails {
	todos: TodoItem[];
	counts: { pending: number; inProgress: number; completed: number };
}

/**
 * The tool description, dsh's wording.
 *
 * It is the whole policy the model gets: plan multi-step work, add one todo per
 * step, keep what is being worked on `in_progress` (several at once only when
 * work really runs in parallel), and finish each one the moment it is done.
 */
const DESCRIPTION =
	"Record and update a task list to plan multi-step work and show progress; skip it for trivial "
	+ "single-step tasks. Add one todo per concrete step before you start. "
	+ "While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. "
	+ "Mark each todo `completed` as soon as it is done.";

const TodoParams = Type.Object({
	todos: Type.Array(
		Type.Object(
			{
				content: Type.String({ description: "What the task is — a short imperative line." }),
				status: StringEnum(STATUSES, {
					description: "pending (not started) | in_progress (now) | completed (done).",
				}),
			},
			{ additionalProperties: false },
		),
		{ description: "The COMPLETE task list, replacing any previous list." },
	),
});

/**
 * Validate what the schema cannot express and build the canonical list: content
 * trimmed, non-empty and unique.
 *
 * The schema already rejected a bad status or an unknown item key, so the
 * snapshot the transcript keeps equals what the model believes it wrote — the
 * cast below records that guarantee rather than guessing it again.
 */
function toTodoList(raw: readonly { content: string; status: string }[]): TodoItem[] {
	const todos: TodoItem[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		const content = item.content.trim();
		if (content.length === 0) {
			throw new Error("invalid todo: `content` must be a non-empty string");
		}
		if (seen.has(content)) {
			throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`);
		}
		seen.add(content);
		todos.push({ content, status: item.status as TodoStatus });
	}
	return todos;
}

/** Per-status totals, the one-line answer a call gives back. */
function countOf(todos: readonly TodoItem[]): TodoDetails["counts"] {
	return {
		pending: todos.filter((todo) => todo.status === "pending").length,
		inProgress: todos.filter((todo) => todo.status === "in_progress").length,
		completed: todos.filter((todo) => todo.status === "completed").length,
	};
}

/** `Updated todo list: 2 pending, 1 in progress, 3 completed.` */
function resultText(counts: TodoDetails["counts"]): string {
	return `Updated todo list: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed.`;
}

/** Is this one of the three states the list can hold? Anything else is not a task. */
function isStatus(value: unknown): value is TodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed";
}

/**
 * One tool result's plan, or null when the payload is not a list at all.
 *
 * `todos` is this extension's own payload; `tasks` is the incremental tool's,
 * read as `subject` so a session that predates this file still shows its list.
 * `deleted` entries are the old tool's tombstones — they exist to keep an id
 * resolvable, never to be rendered — and are dropped like any other unusable
 * row.
 */
function todosFromDetails(details: unknown): TodoItem[] | null {
	if (typeof details !== "object" || details === null) return null;
	const raw = details as { todos?: unknown; tasks?: unknown };
	const source = Array.isArray(raw.todos) ? raw.todos : Array.isArray(raw.tasks) ? raw.tasks : null;
	if (source === null) return null;

	const todos: TodoItem[] = [];
	for (const value of source) {
		if (typeof value !== "object" || value === null) continue;
		const item = value as { content?: unknown; subject?: unknown; status?: unknown };
		const content = typeof item.content === "string" && item.content !== ""
			? item.content
			: typeof item.subject === "string"
				? item.subject
				: "";
		if (content === "" || !isStatus(item.status)) continue;
		todos.push({ content, status: item.status });
	}
	return todos;
}

/**
 * The current plan, read back off the session branch.
 *
 * The newest `todo` tool result wins, which is exactly the replay rule the tool
 * has: a branch's last write is the list that branch is working against. A
 * payload that is not a list at all is skipped rather than ending the search, so
 * a rejected call does not erase the plan behind it.
 *
 * Only the newest turn counts, the same rule the web panel projects: dsh clears
 * its plan at `turn/start`, so a snapshot older than the newest prompt is the
 * previous turn's plan and not this one's. The boundary is the last user message
 * on the branch, which is where a turn opens.
 */
function readTodos(ctx: ExtensionContext): TodoItem[] {
	const branch = ctx.sessionManager.getBranch();
	let start = 0;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user") {
			start = index;
			break;
		}
	}

	let todos: TodoItem[] = [];
	for (let index = start; index < branch.length; index += 1) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "todo") continue;
		const next = todosFromDetails(message.details);
		if (next !== null) todos = next;
	}
	return todos;
}

/** The terminal's `/todos` overlay: the list, or the one line that says there is none. */
class TodoListComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly todos: readonly TodoItem[],
		private readonly theme: Theme,
		private readonly onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		const theme = this.theme;
		const lines: string[] = [""];
		const title = theme.fg("accent", " Todos ");
		lines.push(truncateToWidth(
			theme.fg("borderMuted", "─".repeat(3)) + title + theme.fg("borderMuted", "─".repeat(Math.max(0, width - 10))),
			width,
		));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${theme.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			const done = this.todos.filter((todo) => todo.status === "completed").length;
			lines.push(truncateToWidth(`  ${theme.fg("muted", `${done}/${this.todos.length} completed`)}`, width));
			lines.push("");
			for (const todo of this.todos) {
				const glyph = todo.status === "completed"
					? theme.fg("success", "✓")
					: todo.status === "in_progress"
						? theme.fg("accent", "◐")
						: theme.fg("dim", "○");
				const content = todo.status === "completed" ? theme.fg("dim", todo.content) : theme.fg("text", todo.content);
				lines.push(truncateToWidth(`  ${glyph} ${content}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${theme.fg("dim", "Press Escape to close")}`, width));
		lines.push("");
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: DESCRIPTION,
		promptSnippet: "Record and update the task list that plans multi-step work",
		parameters: TodoParams,

		async execute(_toolCallId, params) {
			const todos = toTodoList(params.todos);
			const counts = countOf(todos);
			return {
				content: [{ type: "text", text: resultText(counts) }],
				details: { todos, counts } satisfies TodoDetails,
			};
		},

		renderCall(args, theme) {
			const count = Array.isArray(args?.todos) ? args.todos.length : 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", `${count} item${count === 1 ? "" : "s"}`),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (details === undefined || !Array.isArray(details.todos)) {
				const block = result.content[0];
				return new Text(block?.type === "text" ? block.text : "", 0, 0);
			}
			if (details.todos.length === 0) return new Text(theme.fg("dim", "Todo list cleared"), 0, 0);

			const { counts } = details;
			let text = theme.fg("muted", resultText(counts));
			const shown = expanded ? details.todos : details.todos.slice(0, 5);
			for (const todo of shown) {
				const glyph = todo.status === "completed"
					? theme.fg("success", "✓")
					: todo.status === "in_progress"
						? theme.fg("accent", "◐")
						: theme.fg("dim", "○");
				const content = todo.status === "completed" ? theme.fg("dim", todo.content) : theme.fg("muted", todo.content);
				text += `\n${glyph} ${content}`;
			}
			if (!expanded && details.todos.length > 5) {
				text += `\n${theme.fg("dim", `... ${String(details.todos.length - 5)} more`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current todo list",
		handler: async (_args, ctx) => {
			const todos = readTodos(ctx);
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					todos.length === 0
						? "No todos yet. Ask the agent to add some!"
						: todos.map((todo) => `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◐" : "○"} ${todo.content}`).join("\n"),
					"info",
				);
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
