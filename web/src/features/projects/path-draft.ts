/**
 * Reading the address bar as a draft, the way dsh's directory browser does.
 *
 * dsh's picker keeps a Miller view of one or two levels and a path editor
 * above it; while a path is being typed the *last* segment prefix-filters the
 * level that text names — never the level the view happens to already show —
 * and a segment nobody matches is treated as a name being spelled rather than
 * a demand for an empty column. The pane arity is the point of that pairing:
 * typing deeper descends, erasing a segment walks back up, and neither moves
 * the view for a keystroke the panes are not following.
 *
 * This picker has one level, so of dsh's pane-arity machinery what survives is
 * the reading itself: which directory part the typed text names (the listing
 * follows it once typing rests) and which tail of it narrows that directory's
 * level. Both are kept pure and separate from the dialog because both halves
 * are easy to get subtly wrong — a directory part names a level the view may
 * not be showing yet, a trailing separator names the level itself rather than a
 * row in it, and `~` names a directory the host resolves to a path the text
 * never spells.
 */
import type { DirEntry, DirListing } from "../../lib/types.ts";

/** The separator a platform's own absolute paths use, inferred from one. */
export function pathSeparator(path: string): "\\" | "/" {
  return path.includes("\\") ? "\\" : "/";
}

/** The listed level as a directory part: separator-terminated (a root already is). */
function levelDirectory(listing: DirListing): string {
  const separator = pathSeparator(listing.path);
  return listing.path.endsWith(separator) ? listing.path : `${listing.path}${separator}`;
}

/**
 * Everything through the draft's last separator, or null while none has been
 * typed — nothing addresses a directory until there is one. On Windows a
 * forward slash separates too (the host's `resolve` accepts either), while on
 * POSIX a backslash is a legal name character and never separates.
 */
export function draftDirectory(draft: string, separator: "\\" | "/"): string | null {
  const cut = separator === "\\"
    ? Math.max(draft.lastIndexOf("\\"), draft.lastIndexOf("/"))
    : draft.lastIndexOf("/");
  return cut === -1 ? null : draft.slice(0, cut + 1);
}

/** A draft-following scan: the directory text that was sent, and where it landed. */
export interface ScannedDirectory {
  /** The draft's directory part, verbatim as it went to the server. */
  directory: string;
  /** `path` of the listing that came back. */
  landed: string;
}

/** How one level reads a draft: the directory it names, and the tail that narrows it. */
export interface DraftReading {
  /** The draft's directory part (null while no separator has been typed). */
  directory: string | null;
  /**
   * The final segment, when this level is the one that directory part
   * addresses; the empty string when the level itself is what the draft
   * spells (the address bar between navigations, or a trailing separator).
   * Null when this level does not answer the draft at all.
   */
  tail: string | null;
}

/**
 * Read a path draft against one level.
 *
 * A level answers a directory part when its own path is that part; `scanned`
 * adds the text that just produced this very listing, because the host resolves
 * what it is given — `~`, a relative path, or `..` reach a level whose canonical
 * `path` spells the request differently. The equality case matters just as
 * much: the address bar sits on the current directory between navigations, and
 * reading that as "the draft names the parent, filter this level by its own
 * name" would send the view walking back up on every navigation.
 */
export function readDraft(
  listing: DirListing,
  draft: string,
  scanned: ScannedDirectory | null,
): DraftReading {
  if (draft === listing.path) return { directory: levelDirectory(listing), tail: "" };
  const directory = draftDirectory(draft, pathSeparator(listing.path));
  if (directory === null) return { directory: null, tail: null };
  const answers = directory === levelDirectory(listing)
    || (scanned !== null && scanned.directory === directory && scanned.landed === listing.path);
  return { directory, tail: answers ? draft.slice(directory.length) : null };
}

/**
 * The rows to render under a prefix filter.
 *
 * Matching is case-insensitive and anchored at the start, and it only narrows
 * while some row it would show actually matches: a tail nobody matches is a
 * name still being spelled, so the level stays whole instead of blanking out on
 * the way to a name that does exist.
 */
export function matchingEntries(
  entries: readonly DirEntry[],
  prefix: string | null,
): readonly DirEntry[] {
  const needle = prefix?.toLowerCase() ?? "";
  if (needle === "") return entries;
  const matches = entries.filter((entry) => entry.name.toLowerCase().startsWith(needle));
  return matches.length > 0 ? matches : entries;
}
