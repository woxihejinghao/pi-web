import pane from "./Pane.module.css";

/**
 * A path whose directories recede and whose last segment keeps full contrast.
 *
 * The split happens in both directions because a live path on Windows is
 * backslash-separated and a git path never is; the separator that was actually
 * found is the one that is printed back, so the label looks like the path the
 * user has. Rendered inside `Pane.module.css`'s `.path`, whose right-to-left
 * trick keeps the file name visible when a long path has to be clipped.
 */
export function PathLabel({ path }: { path: string }) {
  const separator = path.includes("\\") ? "\\" : "/";
  const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0);
  const name = segments.pop() ?? path;
  const prefix = segments.length > 0 ? segments.join(separator) + separator : "";
  return (
    <>
      {prefix}
      <span className={pane.pathName}>{name}</span>
    </>
  );
}
