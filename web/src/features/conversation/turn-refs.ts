/**
 * The files one turn's tool calls named, and which of them it wrote.
 *
 * This is the vocabulary an inline-code reference is resolved against — dsh's
 * `chatFileMentions`, which answers the same question out of a turn's produced
 * and delivered paths. The renderer never guesses at what looks like a path: a
 * token either names a file this turn actually touched or it stays ordinary
 * code, and that single rule is what keeps a sentence about `index.ts` from
 * turning into a chip pointing at a file the agent never opened.
 *
 * The scope is the turn, not the workspace, and the reason is the same one dsh
 * gives: a whole-project vocabulary needs an index the client does not have, and
 * a basename that matches forty files resolves to nothing anyway. A turn's
 * handful of paths is small enough to scan and specific enough to be right.
 *
 * Pure data in, paths out — no React, so the matching rules can be tested
 * directly.
 */
import type {
  ContentBlock,
  ToolCallBlock,
  ToolResultMessage,
} from "../../lib/types.ts";
import { isContentBlock } from "../../lib/types.ts";
import { basename } from "./file-ref.ts";
import { classify } from "./row-model.ts";
import { relativeToProject } from "./turn-files.ts";

/** One path a turn named, in both spellings that matter. */
export interface TurnRefPath {
  /** What a reference opens: project-relative when the path is inside it. */
  open: string;
  /** What the tool call wrote, kept so an absolute token can still match. */
  raw: string;
  /** A `write`/`edit` that succeeded, as opposed to a `read`. */
  changed: boolean;
}

/**
 * Argument keys that name a file.
 *
 * The same pair `turn-files.ts` reads, and deliberately not a wider net: a
 * `grep` call's `pattern` is a regex and its `path` is a directory, so the two
 * tools that name a file they will touch are the two that name a file worth
 * pointing at. `ls` and `grep` do carry a `path`, which is a folder in the
 * common case — a folder cannot be opened as a file, and it fails the vocabulary
 * here rather than in the preview.
 */
const PATH_KEYS = ["path", "file_path"] as const;

/** The variants whose calls put a file's name in the transcript as a change. */
const WRITERS: ReadonlySet<string> = new Set(["write", "edit"]);

/** The path argument of a call, if it carries one. */
function pathArgument(args: Record<string, unknown> | undefined): string | null {
  if (args === undefined) return null;
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/**
 * Every file path a turn's tool calls named, in first-seen order.
 *
 * A failed call is still a mention — the model talked about a file by asking for
 * it, which is exactly what a reader clicking the name wants to see — so unlike
 * `turn-files.ts`, an error does not remove the path. What the error does
 * suppress is the `changed` flag, which is what decides which spelling wins when
 * two calls name the same file.
 *
 * @param blocks - every content block of the turn, in order — the same list the
 * rows render from, live tail included.
 * @param paths - the project root, for relativizing absolute arguments.
 * @param results - tool results by call id, for the write succeeded-or-not test.
 * @returns one entry per distinct file.
 */
export function turnRefPaths(
  blocks: readonly ContentBlock[],
  paths: { cwd?: string | undefined } = {},
  results: Record<string, ToolResultMessage> = {},
): TurnRefPath[] {
  const found = new Map<string, TurnRefPath>();

  for (const block of blocks) {
    if (!isContentBlock(block)) continue;
    if (block.type !== "toolCall") continue;
    const call = block as ToolCallBlock;
    const raw = pathArgument(call.arguments);
    if (raw === null) continue;

    const relative = relativeToProject(raw, paths.cwd);
    const open = relative ?? raw;
    const changed = WRITERS.has(classify(call.name)) && results[call.id]?.isError !== true;
    const existing = found.get(open);
    if (existing === undefined) {
      found.set(open, { open, raw, changed });
      continue;
    }
    // One file named twice keeps one entry: the second mention is the same
    // chip, and a write anywhere in the turn outranks a read.
    if (changed) existing.changed = true;
  }

  return [...found.values()];
}

/**
 * The file a token names, or undefined when the turn cannot say which.
 *
 * Exact spellings first — a token that already matches what a tool call wrote is
 * unambiguous. Failing that, a bare basename resolves only when exactly one path
 * in the turn ends with it, which is dsh's `onlyPathWithBasename` rule and the
 * reason `index.ts` in a sentence about three `index.ts` files stays code.
 *
 * @param paths - the turn's vocabulary, from `turnRefPaths`.
 * @param token - the path part of an authored reference.
 * @returns The spelling to open, or undefined when the token is ambiguous or
 * unknown.
 */
export function resolveTurnRef(paths: readonly TurnRefPath[], token: string): string | undefined {
  const exact = paths.filter((path) => path.open === token || path.raw === token);
  if (exact.length > 0) {
    const written = exact.find((path) => path.changed) ?? exact[0];
    return written?.open;
  }
  const named = paths.filter((path) => basename(path.open) === token);
  return named.length === 1 ? named[0]?.open : undefined;
}
