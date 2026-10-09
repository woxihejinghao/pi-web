/**
 * What a drop on the picker is, read out of a `DataTransfer`.
 *
 * A dragged folder arrives as one entry among the dropped files, and the only
 * thing every browser is willing to say about it is its *name* — a page never
 * gets the location (`DirectoryPicker` explains why the listing comes from the
 * server instead). The shell can do better, and does it out of the same drop:
 * `files[index]` is the `File` whose path the preload bridge resolves. Both
 * halves are read here so the component only has to ask one question.
 */
export interface DroppedFolder {
  /**
   * Position among `data.files` — **not** among `data.items`, which also holds
   * the dragged text and URL item kinds. The two lists index differently the
   * moment a drop carries anything but files, and this is the number the shell
   * needs to look the `File` up.
   */
  index: number;
  /** The folder's own name — the most a browser is allowed to see. */
  name: string;
}

/**
 * The first dragged *folder*, or null when the drop carried none.
 *
 * Files are ignored on purpose: the picker chooses directories, and a dropped
 * file would otherwise be handed to the server as a path and fail there with a
 * less useful message.
 */
export function droppedFolder(data: DataTransfer): DroppedFolder | null {
  const items = data.items;
  if (!items) return null;
  let index = 0;
  for (let at = 0; at < items.length; at += 1) {
    const item = items[at];
    if (!item || item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) return { index, name: entry.name };
    index += 1;
  }
  return null;
}
