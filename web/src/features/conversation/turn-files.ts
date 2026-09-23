import type { AgentMessage, AssistantMessage, ToolCallBlock } from "../../lib/types.ts";
import { VARIANT_TITLES, classify, relativizeToCwd, shortenPath } from "./row-model.ts";

/**
 * One file a turn's own tool calls wrote.
 *
 * `path` is what the tool received; `relative` is that path inside the project,
 * which is what the right sidebar's preview route takes. It is null when the
 * call named something outside the project — a preview of `/tmp/notes.md` has no
 * project-relative form to open, so the row is shown but not clickable.
 */
export interface TurnFile {
  path: string;
  relative: string | null;
  /** Workspace-relative, else `~/…` — the form the rest of the transcript uses. */
  display: string;
  /** Tool labels that wrote it, in call order, deduped ("写入", "编辑"). */
  tools: string[];
  /** How many separate calls wrote it. */
  calls: number;
}

/** Only the two tools that name the file they wrote; `bash` may write anything. */
function isFileWriter(toolName: string): boolean {
  const variant = classify(toolName);
  return variant === "write" || variant === "edit";
}

/** The path argument of a file-writing call, if it carries one. */
function writtenPath(block: ToolCallBlock): string | null {
  const args = block.arguments;
  if (args === undefined) return null;
  for (const key of ["path", "file_path"]) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** `./src/app.ts` and `src/app.ts` are the same file, and must fold into one row. */
function normalizeRelative(path: string): string {
  return path.replace(/^\.\//, "");
}

function relativeToProject(path: string, cwd: string | undefined): string | null {
  if (!isAbsolutePath(path)) return normalizeRelative(path);
  if (cwd === undefined || cwd === "") return null;
  const root = cwd.replace(/[/\\]+$/, "");
  if (root === "") return null;
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  if (path.startsWith(`${root}\\`)) return path.slice(root.length + 1).replace(/\\/g, "/");
  return null;
}

/**
 * The files one turn wrote, in the order they were first written.
 *
 * A turn is a user prompt plus every round-trip it drove (see `groupTurns`), so
 * this reads the tool calls of exactly those messages and nothing else. dsh shows
 * a card in the same place and is stricter about what is in it: it diffs
 * workspace snapshots taken at the turn's boundaries, so its rows carry line
 * counts and include files a shell command changed. This one knows only what the
 * transcript names, which is the honest half of that — a `write` overwriting an
 * existing file does not describe what was there before, so any ± figure here
 * would be invented, and a file touched by `bash` has no call to attribute it to.
 */
export function turnFiles(
  messages: readonly AgentMessage[],
  paths: { cwd?: string | undefined; home?: string | undefined } = {},
): TurnFile[] {
  const files = new Map<string, TurnFile>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of (message as AssistantMessage).content ?? []) {
      if (block.type !== "toolCall") continue;
      const call = block as ToolCallBlock;
      if (!isFileWriter(call.name)) continue;
      const path = writtenPath(call);
      if (path === null) continue;

      const relative = relativeToProject(path, paths.cwd);
      const key = relative ?? path;
      const label = VARIANT_TITLES[classify(call.name)];
      const existing = files.get(key);
      if (existing !== undefined) {
        existing.calls += 1;
        if (!existing.tools.includes(label)) existing.tools.push(label);
        continue;
      }
      files.set(key, {
        path,
        relative,
        display: relative ?? shortenPath(relativizeToCwd(path, paths.cwd), paths.cwd, paths.home),
        tools: [label],
        calls: 1,
      });
    }
  }

  return [...files.values()];
}
