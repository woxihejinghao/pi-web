/**
 * Row model for tool and reasoning rows — the pure part, no React.
 *
 * Ported from dsh's `ToolRow.tsx` helpers (`classifyTool`, `TOOL_VARIANTS`,
 * `VARIANT_TITLE_KEYS`, `SUMMARY_KEYS`, `deriveSummary`) with pi's tool names in
 * the table. Kept separate from the component so the summary rules — which are
 * the part that silently rots — can be tested directly.
 */
import type { MessageKey, Translate } from "../../lib/i18n/index.ts";


/** Row variant: decides both the glyph and the title. */
export type Variant = "bash" | "read" | "write" | "edit" | "search" | "code" | "others";

/** pi tool name → variant. Anything absent falls back to `others`. */
export const TOOL_VARIANTS: Record<string, Variant> = {
  bash: "bash",
  // Same variant: `powershell` takes the same `command`/`description` shape, so
  // the row reads as a command rather than falling through to "tool call".
  powershell: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "search",
  find: "search",
  glob: "search",
  ls: "search",
};

/**
 * The row title per variant — dsh's `VARIANT_TITLE_KEYS`, resolved through the
 * message table rather than frozen at module load: switching the interface
 * language has to re-label rows that are already on screen.
 */
export function variantTitles(t: Translate): Record<Variant, string> {
  return {
    bash: "Bash",
    read: t("tool.read"),
    write: t("tool.write"),
    edit: t("tool.edit"),
    search: t("tool.search"),
    code: t("tool.code"),
    others: t("tool.others"),
  };
}

/** Which argument best describes the call, in priority order — dsh's SUMMARY_KEYS. */
export const SUMMARY_KEYS: Record<Variant, string[]> = {
  bash: ["description", "command"],
  read: ["path", "file_path", "url"],
  search: ["query", "pattern", "url"],
  write: ["path", "file_path"],
  edit: ["path", "file_path"],
  code: ["description"],
  others: [],
};

export function classify(toolName: string): Variant {
  return TOOL_VARIANTS[toolName] ?? "others";
}

/** Cut at the first newline. Used to keep a multi-line argument from breaking a row. */
export function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

/**
 * The first line that actually has content.
 *
 * Reasoning blocks routinely open with a blank line. A row reading "思考 ·" with
 * nothing after the dot looks like a rendering bug, so blanks are skipped.
 */
export function firstNonBlankLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

/** The last line that actually has content — the streaming tail. */
export function lastNonBlankLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  return [...lines].reverse().find((line) => line.trim() !== "") ?? "";
}

function pickString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function isWindowsStylePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * Strip the workspace root from a workspace-rooted absolute path.
 *
 * dsh's `relativizeToCwd`. Note this only fires when the *whole* string starts
 * with the root — a shell command like `cd /root/x && ...` is left alone, so the
 * shortening never rewrites the middle of a command.
 */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === "") return text;
  const root = cwd.replace(/[/\\]+$/, "");
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1);
  return text;
}

/**
 * Rewrite a path under the home directory as `~/...`.
 *
 * dsh's `abbreviateHomePath`. Windows paths are left untouched — `~` is a shell
 * convention, and half-translating a UNC path is worse than not translating it.
 */
export function abbreviateHomePath(text: string, home: string | undefined): string {
  if (home === undefined || home === "") return text;
  if (isWindowsStylePath(text) || isWindowsStylePath(home)) return text;
  const root = home.replace(/\/+$/, "");
  if (root === "" || root === "/") return text;
  if (text.replace(/\/+$/, "") === root) return "~";
  if (text.startsWith(`${root}/`)) return `~${text.slice(root.length)}`;
  return text;
}

/**
 * The order dsh shortens a summary in: workspace-relative first, then `~/`.
 * Doing it the other way round would produce `~/proj/sub` for a path that
 * `sub` describes exactly.
 */
export function shortenPath(
  text: string,
  cwd: string | undefined,
  home: string | undefined,
): string {
  return abbreviateHomePath(relativizeToCwd(text, cwd), home);
}

/**
 * The one-line description shown next to the tool name.
 *
 * Order matters and mirrors dsh: a search's `queries` array wins outright, then
 * the variant's preferred keys, then any non-empty string, and nothing at all if
 * the arguments hold no usable text.
 */
export function deriveSummary(variant: Variant, args: Record<string, unknown> | undefined): string {
  if (!args) return "";

  if (variant === "search" && Array.isArray(args.queries)) {
    const queries = args.queries.filter(
      (query): query is string => typeof query === "string" && query !== "",
    );
    if (queries.length > 0) return queries.map(firstLine).join(", ");
  }

  const picked = pickString(args, SUMMARY_KEYS[variant]);
  if (picked !== undefined) return firstLine(picked);

  for (const value of Object.values(args)) {
    if (typeof value === "string" && value !== "") return firstLine(value);
  }
  return "";
}

/**
 * Thinking and tool calls are *process*; text is the answer. An image is neither,
 * but it must never be swallowed into a collapsed group, so it counts as an
 * answer.
 */
function isProcessBlock(block: { type?: string }): boolean {
  return block.type === "thinking" || block.type === "toolCall";
}

/**
 * Split one turn's blocks for the "compact" transcript display: every process
 * step becomes one group (rendered where the first of them sat), and the answer
 * steps keep their relative order.
 *
 * The input is wrapped in a carrier object rather than being a bare block array
 * so the caller's own identity for each step — the message and block indices
 * MessageList keys on — survives the partition. Without that, moving a step into
 * the group would remount it and collapse any state it owned.
 *
 * Interleaved answers end up adjacent: `text, tool, text` renders as the group
 * followed by both texts. That is the trade the mode asks for, and the
 * alternative (one group per interleaving run) would produce several
 * near-identical rows for a single turn.
 *
 * A `live` process step (see `TurnStep`) is not an exception: a running turn is
 * folded the same way (dsh's `stepGrouping` 'collapsed'), so a streaming
 * reasoning block or tool call still lands in `process`. Only a live *answer*
 * block stays out — a group would hide the text the reader is watching arrive.
 */
export function splitForCompact<T extends { block: { type?: string }; live?: boolean }>(steps: T[]): {
  process: T[];
  answers: T[];
} {
  const process: T[] = [];
  const answers: T[] = [];
  for (const step of steps) {
    // Process blocks are folded whether or not they have settled; answers never
    // are, streaming or not.
    (isProcessBlock(step.block) ? process : answers).push(step);
  }
  return { process, answers };
}

/**
 * dsh's `ProcessActivity`, narrowed to the categories pi's tool names produce.
 * `thinking` is not a tool category — it is what a segment with no tool calls
 * (reasoning only) reads as.
 */
export type ProcessActivity =
  | "thinking"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "commands"
  | "code"
  | "plan"
  | "tools";

/**
 * pi tool name → the activity a process group names it by.
 *
 * Deliberately NOT `classify`'s variant table. A row and a group answer two
 * different questions — what this one call was, what the stretch is doing —
 * and the two tables need not agree; dsh keeps a separate `activity()` for the
 * same reason. Only real tool names are listed (pi's built-ins plus the `todo`
 * extension this package ships); anything else reads as `tools`.
 */
const ACTIVITY_BY_TOOL: Record<string, ProcessActivity> = {
  read: "read",
  write: "write",
  edit: "edit",
  grep: "search",
  find: "search",
  glob: "search",
  ls: "search",
  bash: "commands",
  powershell: "commands",
  run_code: "code",
  todo: "plan",
};

/** The activity category a tool name belongs to. */
export function processActivityOf(toolName: string): ProcessActivity {
  return ACTIVITY_BY_TOOL[toolName] ?? "tools";
}

/**
 * A live (unclosed) segment's header: dsh's present-tense activity labels
 * ("正在读取文件"), not a fixed "working" string. The group says *what* the
 * agent is doing; the turn's own status line says it is still working.
 */
const LIVE_TITLE_KEYS: Record<ProcessActivity, MessageKey> = {
  thinking: "message.stepProcess.thinking",
  read: "message.stepProcess.read",
  write: "message.stepProcess.write",
  edit: "message.stepProcess.edit",
  search: "message.stepProcess.search",
  commands: "message.stepProcess.commands",
  code: "message.stepProcess.code",
  plan: "message.stepProcess.plan",
  tools: "message.stepProcess.tools",
};

const DONE_TITLE_KEYS: Record<ProcessActivity, MessageKey> = {
  thinking: "message.stepProcess.done.thinking",
  read: "message.stepProcess.done.read",
  write: "message.stepProcess.done.write",
  edit: "message.stepProcess.done.edit",
  search: "message.stepProcess.done.search",
  commands: "message.stepProcess.done.commands",
  code: "message.stepProcess.done.code",
  plan: "message.stepProcess.done.plan",
  tools: "message.stepProcess.done.tools",
};

/**
 * A stretch whose live tool call has not started running yet: its arguments are
 * still arriving. dsh distinguishes this from "running" for the same reason it
 * matters here — while the call is only being written, "正在运行命令" is a lie.
 */
const PREPARE_TITLE_KEYS: Record<Exclude<ProcessActivity, "thinking">, MessageKey> = {
  read: "message.stepProcess.prepare.read",
  write: "message.stepProcess.prepare.write",
  edit: "message.stepProcess.prepare.edit",
  search: "message.stepProcess.prepare.search",
  commands: "message.stepProcess.prepare.commands",
  code: "message.stepProcess.prepare.code",
  plan: "message.stepProcess.prepare.plan",
  tools: "message.stepProcess.prepare.tools",
};

/** A stretch that is only reasoning is preparing no tool; dsh lends it `tools`. */
function prepareTitleKey(activity: ProcessActivity): MessageKey {
  return activity === "thinking" ? PREPARE_TITLE_KEYS.tools : PREPARE_TITLE_KEYS[activity];
}

/**
 * One ordered run of a turn's steps: either process (thinking + tool calls) or
 * answers. Ported from dsh's process grouping, which cuts a Turn at every reply
 * or user input. A still-streaming process step lands in a process run like any
 * other: dsh's `stepGrouping` 'collapsed' folds a running turn too, and the
 * group's live header — not the row itself — is what says what is happening.
 */
export type ProcessSegment<T> =
  | { kind: "process"; steps: T[] }
  | { kind: "answer"; steps: T[] };

/** Cut a turn's steps into ordered process / answer runs. */
export function splitIntoProcessSegments<
  T extends { block: { type?: string }; live?: boolean },
>(steps: T[]): ProcessSegment<T>[] {
  const segments: ProcessSegment<T>[] = [];
  for (const step of steps) {
    const kind = isProcessBlock(step.block) ? "process" : "answer";
    const last = segments[segments.length - 1];
    if (last !== undefined && last.kind === kind) last.steps.push(step);
    else segments.push({ kind, steps: [step] });
  }
  return segments;
}

/**
 * Compose a closed segment's title from its tool calls, ported from dsh's
 * `processTitle`. Categories rank by distinct call count; a segment with no tool
 * calls reads as thinking.
 */
export function processTitle(counts: ReadonlyMap<ProcessActivity, number>, t: Translate): string {
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([kind]) => kind);
  const labels = ranked.slice(0, 3).map((kind) => t(DONE_TITLE_KEYS[kind]));
  const first = labels[0];
  if (first === undefined) return t("message.stepProcess.done.thinking");
  const second = labels[1];
  if (second === undefined) return first;
  // dsh's `continuation`: everything after the first label loses its sentence
  // case, so the joined title reads as one phrase rather than several.
  const continuation = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1);
  if (labels.length === 2) {
    const prefix = t("message.stepProcess.sharedPrefix");
    const shared = prefix !== "" && first.startsWith(prefix) && second.startsWith(prefix);
    return t("message.stepProcess.joinTwo", {
      first,
      second: continuation(shared ? second.slice(prefix.length) : second),
    });
  }
  const title = [first, ...labels.slice(1).map(continuation)].join(t("message.stepProcess.comma"));
  return ranked.length > 3 ? t("message.stepProcess.more", { title }) : title;
}

/**
 * dsh caps a live detail at 160 graphemes so a pasted file cannot turn a title
 * into a paragraph; the same budget applies here, counted in code points.
 */
const LIVE_DETAIL_MAX_CHARS = 160;

/**
 * One line naming what a tool call is doing, for a live group's title.
 *
 * Reuses the row summary's own priority table: the argument that names a
 * finished row ("npm test", a file path, a pattern) is the one worth showing
 * while the call is still being written. dsh keeps a wider table
 * (`LIVE_TOOL_DETAIL_KEYS`) because its tools are a different set.
 */
export function liveToolDetail(toolName: string, args: Record<string, unknown> | undefined): string {
  const summary = deriveSummary(classify(toolName), args);
  const characters = [...summary];
  if (characters.length <= LIVE_DETAIL_MAX_CHARS) return summary;
  return `${characters.slice(0, LIVE_DETAIL_MAX_CHARS - 1).join("").trimEnd()}…`;
}

/** A process segment's header: the running activity, or a closed summary. */
export interface ProcessSegmentTitle {
  title: string;
  activity: ProcessActivity;
  running: boolean;
  /** The live step is a tool call still writing its arguments; see `PREPARE_TITLE_KEYS`. */
  preparing?: boolean;
  /** One-line argument summary of the live tool call, when it has one. */
  detail?: string;
}

/**
 * Title, category and run state for one process segment.
 *
 * `open` is dsh's "the turn has not closed this stretch yet" (a stretch closes
 * only at a reply or the turn's end). An open stretch is live even when nothing
 * is streaming and no tool is mid-execution — the model may be between steps —
 * so it takes the present-tense activity label rather than a finished summary.
 */
export function processSegmentTitle<
  T extends { block: { type?: string }; live?: boolean; running?: boolean },
>(steps: T[], t: Translate, open = false): ProcessSegmentTitle {
  const counts = new Map<ProcessActivity, number>();
  let running: ProcessActivity | undefined;
  let preparing = false;
  let detail: string | undefined;
  for (const step of steps) {
    const active = step.live === true || step.running === true;
    if (step.block.type === "toolCall") {
      const block = step.block as { name?: string; arguments?: Record<string, unknown> };
      const activity = processActivityOf(block.name ?? "");
      counts.set(activity, (counts.get(activity) ?? 0) + 1);
      if (active) {
        running = activity;
        // Streaming but not yet executing: the arguments are still being written.
        preparing = step.live === true && step.running !== true;
        const named = liveToolDetail(block.name ?? "", block.arguments);
        detail = named.length > 0 ? named : undefined;
      }
    } else if (active && step.block.type === "thinking") {
      // A reasoning tail with no tool call running is still work in progress; the
      // latest live step wins, so this overwrites an earlier tool's category.
      running = "thinking";
      preparing = false;
      // Reasoning names no argument, and a detail left over from an earlier tool
      // in this stretch would describe work that has already moved on.
      detail = undefined;
    }
  }
  // The live label names the activity the stretch is on: the streaming (or
  // still-executing) step's category, else the most frequent one — an open
  // stretch with only settled work behind it is still on that work.
  const activity = running ?? [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "thinking";
  if (running !== undefined || open) {
    const live = { activity, running: true as const, ...(detail === undefined ? {} : { detail }) };
    if (preparing) {
      return { ...live, title: t(prepareTitleKey(activity)), preparing: true };
    }
    return { ...live, title: t(LIVE_TITLE_KEYS[activity]) };
  }
  return { title: processTitle(counts, t), activity, running: false };
}
