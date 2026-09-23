/**
 * A unified diff, parsed into something a component can draw.
 *
 * The server hands over git's own patch text, one file at a time, and this is
 * the only place that text is understood. Keeping it a pure function means the
 * rendering tests can hand it a literal patch, and the numbers the panel shows
 * (`+N -M`) come from the same pass that draws the lines — they cannot disagree.
 */

export type DiffLineKind = "add" | "del" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its leading marker (`+`, `-`, ` `). */
  text: string;
  /** 1-based line number in the old file, or null for an added line. */
  oldLine: number | null;
  /** 1-based line number in the new file, or null for a removed line. */
  newLine: number | null;
}

export interface DiffHunk {
  /** git's `@@ -a,b +c,d @@ <context>` header, verbatim. */
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  /** True when git reported the file as binary instead of patching it. */
  binary: boolean;
  additions: number;
  deletions: number;
  /** Old path from the `---` line; null for `/dev/null` (a new file). */
  oldPath: string | null;
  /** New path from the `+++` line; null for `/dev/null` (a deletion). */
  newPath: string | null;
}

/** `@@ -12,3 +13,4 @@ tail` — the two start positions are all we need. */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** `--- a/path`, `+++ b/path`, or `/dev/null` for an added/deleted side. */
function pathFromHeader(line: string): string | null {
  const value = line.slice(4).split("\t")[0] ?? "";
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

/**
 * Parse one file's unified diff.
 *
 * The file-level metadata git prints above the first hunk (`diff --git`,
 * `index`, `new file mode`, the `---`/`+++` pair) is consumed here and never
 * drawn: the panel draws its own file header. Each hunk's own `@@` line *is*
 * kept, as its first `meta` line — it is the only place the two line ranges
 * appear, and the component draws it as the hunk's divider.
 */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let current: DiffHunk | null = null;
  // 1-based cursors for the current hunk's two sides; only the lines being
  // drawn need them, so they stay local to the loop.
  let oldCursor = 0;
  let newCursor = 0;

  // A trailing newline would otherwise become a final empty context line.
  const lines = patch.length === 0 ? [] : patch.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }
    if (line.startsWith("diff --git ")) continue;
    if (line.startsWith("--- ")) {
      oldPath = pathFromHeader(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = pathFromHeader(line);
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      current = {
        header: line,
        lines: [
          {
            kind: "meta",
            text: line,
            oldLine: null,
            newLine: null,
          },
        ],
      };
      hunks.push(current);
      // The counters start at the hunk's own positions, not at 1.
      oldCursor = Number(header[1]);
      newCursor = Number(header[2]);
      continue;
    }

    // Metadata before the first hunk (`index abc..def`, `new file mode`, …) is
    // not part of any hunk and is simply not drawn.
    if (current === null) continue;

    if (line.startsWith("\\")) {
      // `\ No newline at end of file` belongs to the line above it.
      current.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }

    const marker = line[0] ?? " ";
    const text = line.slice(1);
    if (marker === "+") {
      current.lines.push({ kind: "add", text, oldLine: null, newLine: newCursor });
      newCursor += 1;
      additions += 1;
    } else if (marker === "-") {
      current.lines.push({ kind: "del", text, oldLine: oldCursor, newLine: null });
      oldCursor += 1;
      deletions += 1;
    } else {
      current.lines.push({
        kind: "context",
        text,
        oldLine: oldCursor,
        newLine: newCursor,
      });
      oldCursor += 1;
      newCursor += 1;
    }
  }

  return { hunks, binary, additions, deletions, oldPath, newPath };
}
