/**
 * Row model for tool and reasoning rows — the pure part, no React.
 *
 * Ported from dsh's `ToolRow.tsx` helpers (`classifyTool`, `TOOL_VARIANTS`,
 * `VARIANT_TITLE_KEYS`, `SUMMARY_KEYS`, `deriveSummary`) with pi's tool names in
 * the table. Kept separate from the component so the summary rules — which are
 * the part that silently rots — can be tested directly.
 */

/** Row variant: decides both the glyph and the title. */
export type Variant = "bash" | "read" | "write" | "edit" | "search" | "code" | "others";

/** pi tool name → variant. Anything absent falls back to `others`. */
export const TOOL_VARIANTS: Record<string, Variant> = {
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "search",
  find: "search",
  glob: "search",
  ls: "search",
};

/** dsh's `VARIANT_TITLE_KEYS`, resolved to the strings its zh-CN table carries. */
export const VARIANT_TITLES: Record<Variant, string> = {
  bash: "Bash",
  read: "读取",
  write: "写入",
  edit: "编辑",
  search: "搜索",
  code: "代码",
  others: "工具调用",
};

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
 */
export function splitForCompact<T extends { block: { type?: string } }>(steps: T[]): {
  process: T[];
  answers: T[];
} {
  const process: T[] = [];
  const answers: T[] = [];
  for (const step of steps) {
    (isProcessBlock(step.block) ? process : answers).push(step);
  }
  return { process, answers };
}
