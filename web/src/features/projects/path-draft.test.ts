import { describe, expect, it } from "vitest";
import type { DirEntry, DirListing } from "../../lib/types.ts";
import {
  draftDirectory,
  matchingEntries,
  pathSeparator,
  readDraft,
  type ScannedDirectory,
} from "./path-draft.ts";

function level(path: string, entries: DirEntry[] = []): DirListing {
  return { path, parent: null, entries };
}

const proj = level("/Users/dev/proj");

describe("pathSeparator", () => {
  it("reads the platform off the path itself", () => {
    expect(pathSeparator("/Users/dev/proj")).toBe("/");
    expect(pathSeparator("C:\\Users\\dev\\proj")).toBe("\\");
  });
});

describe("draftDirectory", () => {
  it("keeps everything through the last separator", () => {
    expect(draftDirectory("/Users/dev/proj", "/")).toBe("/Users/dev/");
    expect(draftDirectory("/Users/dev/proj/", "/")).toBe("/Users/dev/proj/");
  });

  it("names no directory before a separator is typed", () => {
    expect(draftDirectory("proj", "/")).toBeNull();
    expect(draftDirectory("", "/")).toBeNull();
  });

  it("lets a backslash separate only where the platform does", () => {
    expect(draftDirectory("C:\\Users\\dev", "\\")).toBe("C:\\Users\\");
    expect(draftDirectory("C:/Users/dev", "\\")).toBe("C:/Users/");
    // A backslash is a legal POSIX name character, so it never splits there.
    expect(draftDirectory("/Users/dev\\proj", "/")).toBe("/Users/");
  });
});

describe("readDraft", () => {
  it("reads the address bar resting on a level as that level, not a filter", () => {
    expect(readDraft(proj, "/Users/dev/proj", null)).toEqual({
      directory: "/Users/dev/proj/",
      tail: "",
    });
    expect(readDraft(proj, "/Users/dev/proj/", null)).toEqual({
      directory: "/Users/dev/proj/",
      tail: "",
    });
  });

  it("prefix-filters the level the draft names", () => {
    expect(readDraft(proj, "/Users/dev/proj/sr", null)).toEqual({
      directory: "/Users/dev/proj/",
      tail: "sr",
    });
  });

  it("leaves a level the draft does not name alone", () => {
    expect(readDraft(proj, "/Users/dev/other", null)).toEqual({
      directory: "/Users/dev/",
      tail: null,
    });
  });

  it("answers with the text a scan was sent, not just the canonical path", () => {
    const scanned: ScannedDirectory = { directory: "~/", landed: "/Users/milan/Downloads" };
    const downloads = level("/Users/milan/Downloads");
    expect(readDraft(downloads, "~/Dow", scanned)).toEqual({
      directory: "~/",
      tail: "Dow",
    });
    // The same listing without that scan is not addressed by `~/`.
    expect(readDraft(downloads, "~/Dow", null)).toEqual({
      directory: "~/",
      tail: null,
    });
  });

  it("names no directory before a separator is typed", () => {
    expect(readDraft(proj, "proj", null)).toEqual({ directory: null, tail: null });
  });
});

describe("matchingEntries", () => {
  const entries: DirEntry[] = [
    { name: "src", path: "/w/src" },
    { name: "Scripts", path: "/w/Scripts" },
    { name: "docs", path: "/w/docs" },
  ];

  it("keeps the level whole with no prefix", () => {
    expect(matchingEntries(entries, null)).toBe(entries);
    expect(matchingEntries(entries, "")).toBe(entries);
  });

  it("narrows to the rows the prefix starts", () => {
    expect(matchingEntries(entries, "s").map((entry) => entry.name)).toEqual(["src", "Scripts"]);
    expect(matchingEntries(entries, "sc").map((entry) => entry.name)).toEqual(["Scripts"]);
  });

  it("matches case-insensitively", () => {
    expect(matchingEntries(entries, "SCR").map((entry) => entry.name)).toEqual(["Scripts"]);
  });

  it("keeps the level whole when nothing matches, rather than blanking out", () => {
    expect(matchingEntries(entries, "zz")).toBe(entries);
  });
});
