import type {
  AgentMessage,
  AssistantMessage,
  ToolCallBlock,
  ToolResultMessage,
} from "../../lib/types.ts";
import { parseUnifiedDiff } from "../rightbar/diff-parse.ts";
import { classify, relativizeToCwd, shortenPath } from "./row-model.ts";

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
  /** Lines the turn's calls added, summed over the patches below. */
  added: number;
  /** Lines the turn's calls removed, summed over the patches below. */
  deleted: number;
  /**
   * The unified patches this file's calls produced, in call order.
   *
   * dsh draws the hover preview from the turn's own snapshot comparison; this
   * one has only pi's per-call patches, which is the same information cut one
   * way finer — a file edited three times in a turn previews as three patches
   * rather than one merged comparison, because merging them would mean
   * reconstructing a file neither side of the transcript holds.
   */
  patches: string[];
  /** A call wrote something this transcript cannot measure (a truncated `write`). */
  oversized: boolean;
}

/** Above this a patch is not kept: the card shows "过大" instead of drawing it. */
const MAX_PATCH_CHARS = 200_000;

/**
 * The only two tools that name the file they wrote; `bash` may write anything.
 * Neither label reaches the card any more — the row's right side is the line
 * counts now — so this is a variant test, not a lookup into the label table.
 */
function isFileWriter(variant: string): boolean {
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
 * Lines in a text block, counted the way a patch counts them: a trailing
 * newline ends the last line instead of starting an empty one, and an empty
 * string is zero lines rather than one.
 */
function lineCount(text: string): number {
  if (text === "") return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

/**
 * A whole-file write as a unified patch.
 *
 * pi's `write` reports only "wrote N bytes", with no patch and no copy of what
 * the file held before, so this is not a comparison — it is the new content
 * presented in the shape the rest of the card already draws. That is why a
 * `write` over an existing file counts as pure addition: the removed side is
 * something this transcript never saw, and inventing it would make the hover
 * preview disagree with the file it claims to describe.
 */
function writePatch(content: string): string {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  return `@@ -0,0 +1,${String(lines.length)} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
}

/** What one call wrote: the patch to draw, and the counts that patch parses to. */
interface CallChange {
  patch: string | null;
  added: number;
  deleted: number;
  oversized: boolean;
}

const NOTHING: CallChange = { patch: null, added: 0, deleted: 0, oversized: false };

/** pi's own unified patch for an `edit`, when the turn carries its result. */
function patchOf(result: ToolResultMessage | undefined): string | null {
  if (result === undefined || result.isError === true) return null;
  const details = result.details;
  if (typeof details !== "object" || details === null) return null;
  const patch = (details as { patch?: unknown }).patch;
  return typeof patch === "string" && patch.length > 0 ? patch : null;
}

/**
 * The `edits[]` argument as a fallback measurement, for a call whose result is
 * not in this turn (a session read from a log that was trimmed, say). The
 * counts are the two sides' own line counts rather than a comparison, and there
 * is no patch to draw, so the card can show ± while the preview stays closed.
 */
function measureEdits(args: Record<string, unknown>): CallChange {
  const edits = args["edits"];
  if (!Array.isArray(edits)) return NOTHING;
  let added = 0;
  let deleted = 0;
  for (const item of edits) {
    if (typeof item !== "object" || item === null) continue;
    const { oldText, newText } = item as { oldText?: unknown; newText?: unknown };
    if (typeof newText === "string") added += lineCount(newText);
    if (typeof oldText === "string") deleted += lineCount(oldText);
  }
  return { patch: null, added, deleted, oversized: false };
}

/** What one file-writing call did to its file, as far as the transcript can tell. */
function changeOf(
  call: ToolCallBlock,
  variant: string,
  result: ToolResultMessage | undefined,
): CallChange {
  // A failed call changed nothing, and pi's failure text carries no patch. Its
  // arguments are still in the transcript, so counting them would report an edit
  // that the file never received.
  if (result?.isError === true) return NOTHING;

  const args = call.arguments ?? {};
  if (variant === "write") {
    const content = args["content"];
    if (typeof content !== "string") return { ...NOTHING, oversized: true };
    if (content.length > MAX_PATCH_CHARS) return { ...NOTHING, oversized: true };
    const patch = writePatch(content);
    return { patch, added: lineCount(content), deleted: 0, oversized: false };
  }

  const patch = patchOf(result);
  if (patch === null) return measureEdits(args);
  if (patch.length > MAX_PATCH_CHARS) return { ...NOTHING, oversized: true };
  const parsed = parseUnifiedDiff(patch);
  return { patch, added: parsed.additions, deleted: parsed.deletions, oversized: false };
}

/**
 * The files one turn wrote, in the order they were first written.
 *
 * A turn is a user prompt plus every round-trip it drove (see `groupTurns`), so
 * this reads the tool calls of exactly those messages and nothing else. dsh shows
 * a card in the same place and is stricter about what is in it: it diffs
 * workspace snapshots taken at the turn's boundaries, so its rows include files
 * a shell command changed. This one knows only what the transcript names — a
 * file touched by `bash` has no call to attribute it to — but for the calls it
 * does see it has pi's own patch, which is what makes its ± figures and its
 * hover preview the same numbers rather than two measurements that can disagree.
 *
 * @param messages - the turn's messages, in order.
 * @param paths - the project and home directories the rows are displayed against.
 * @param results - tool results by call id; the patch an `edit` produced lives here.
 * @returns one entry per file, in first-write order.
 */
export function turnFiles(
  messages: readonly AgentMessage[],
  paths: { cwd?: string | undefined; home?: string | undefined } = {},
  results: Record<string, ToolResultMessage> = {},
): TurnFile[] {
  const files = new Map<string, TurnFile>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of (message as AssistantMessage).content ?? []) {
      if (block.type !== "toolCall") continue;
      const call = block as ToolCallBlock;
      const variant = classify(call.name);
      if (!isFileWriter(variant)) continue;
      const path = writtenPath(call);
      if (path === null) continue;

      const change = changeOf(call, variant, results[call.id]);
      const relative = relativeToProject(path, paths.cwd);
      const key = relative ?? path;
      const existing = files.get(key);
      if (existing !== undefined) {
        existing.added += change.added;
        existing.deleted += change.deleted;
        if (change.patch !== null) existing.patches.push(change.patch);
        if (change.oversized) existing.oversized = true;
        continue;
      }
      files.set(key, {
        path,
        relative,
        display: relative ?? shortenPath(relativizeToCwd(path, paths.cwd), paths.cwd, paths.home),
        added: change.added,
        deleted: change.deleted,
        patches: change.patch === null ? [] : [change.patch],
        oversized: change.oversized,
      });
    }
  }

  return [...files.values()];
}
