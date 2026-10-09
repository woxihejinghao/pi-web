/**
 * Whether a change the workspace watcher reported concerns the file a Preview
 * tab is showing.
 *
 * The watcher's event carries workspace-relative paths rather than the file's
 * contents, so the decision of "is this mine" is a pure comparison and lives
 * here instead of inside the tab. `null` is not an empty list: it means the
 * watcher saw something it could not attribute (a directory-level FSEvents
 * report, or more paths in one debounce window than it lists). A reader cannot
 * rule itself out in that case, so it counts as a hit — a redundant re-read
 * costs one request, while a missed edit leaves the panel lying.
 */

/**
 * One path as both sides spell it: `/`-separated, no `./`, no trailing slash.
 *
 * Node reports recursive-watch filenames relative to the watched root but with
 * the platform's separator, and a tab target arrives as the server normalized
 * it. Normalizing here means the comparison never has to know which of the two
 * it is looking at.
 */
export function normalizeWatchPath(input: string): string {
  let out = input.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * Whether `target` (a workspace-relative file path) is covered by the change.
 *
 * A path equal to the target is obvious; a path that *contains* it counts too,
 * because a directory that was renamed or removed reports as the directory, and
 * the file under it is exactly what just stopped existing. Comparison is
 * case-sensitive on purpose: the server hands back the names the filesystem
 * gave it, so the only thing case folding could add is a false hit on a
 * case-sensitive machine.
 */
export function previewChangedBy(paths: readonly string[] | null, target: string): boolean {
  if (paths === null) return true;
  const want = normalizeWatchPath(target);
  if (want.length === 0) return false;
  return paths.some((raw) => {
    const path = normalizeWatchPath(raw);
    if (path.length === 0) return false;
    return want === path || want.startsWith(`${path}/`);
  });
}
