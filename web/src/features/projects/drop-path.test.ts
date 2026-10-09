import { describe, expect, it } from "vitest";
import { droppedFolder } from "./drop-path.ts";

interface Item {
  kind?: string;
  /** Omitted for an entry `webkitGetAsEntry` cannot describe (a plain file). */
  directory?: boolean;
  name?: string;
}

/** The slice of `DataTransfer` `droppedFolder` reads, shaped by hand. */
function transfer(items: Item[] | null): DataTransfer {
  if (!items) return {} as DataTransfer;
  return {
    items: items.map((item) => ({
      kind: item.kind ?? "file",
      webkitGetAsEntry: () =>
        item.directory === undefined
          ? null
          : { isDirectory: item.directory, name: item.name ?? "" },
    })),
  } as unknown as DataTransfer;
}

describe("droppedFolder", () => {
  it("names the folder a drop carried", () => {
    expect(droppedFolder(transfer([{ directory: true, name: "proj" }]))).toEqual({
      index: 0,
      name: "proj",
    });
  });

  it("skips plain files, including ones ahead of the folder", () => {
    const data = transfer([{ name: "notes.md" }, { directory: true, name: "proj" }]);
    expect(droppedFolder(data)).toEqual({ index: 1, name: "proj" });
  });

  it("counts only file items, so the index matches `data.files`", () => {
    const data = transfer([{ kind: "string" }, { name: "notes.md" }, { directory: true, name: "proj" }]);
    expect(droppedFolder(data)).toEqual({ index: 1, name: "proj" });
  });

  it("ignores a drop that carries only files", () => {
    expect(droppedFolder(transfer([{ name: "notes.md" }]))).toBeNull();
  });

  it("ignores non-file items such as dragged text", () => {
    expect(droppedFolder(transfer([{ kind: "string" }, { name: "notes.md" }]))).toBeNull();
  });

  it("answers null when the transfer has no item list", () => {
    expect(droppedFolder(transfer(null))).toBeNull();
  });
});
