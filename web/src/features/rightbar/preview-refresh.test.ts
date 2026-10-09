import { describe, expect, it } from "vitest";
import { normalizeWatchPath, previewChangedBy } from "./preview-refresh.ts";

describe("normalizeWatchPath", () => {
  it("normalizes separators and leading dots", () => {
    expect(normalizeWatchPath("src\\deep\\file.ts")).toBe("src/deep/file.ts");
    expect(normalizeWatchPath("./src/file.ts")).toBe("src/file.ts");
    expect(normalizeWatchPath("src/dir/")).toBe("src/dir");
  });

  it("keeps a root slash", () => {
    expect(normalizeWatchPath("/")).toBe("/");
  });
});

describe("previewChangedBy", () => {
  it("matches the file itself", () => {
    expect(previewChangedBy(["src/app.ts"], "src/app.ts")).toBe(true);
  });

  it("matches a directory the file lives under", () => {
    expect(previewChangedBy(["src"], "src/app.ts")).toBe(true);
    expect(previewChangedBy(["src/"], "src/app.ts")).toBe(true);
  });

  it("does not match a sibling or a name that merely shares a prefix", () => {
    expect(previewChangedBy(["src/other.ts"], "src/app.ts")).toBe(false);
    expect(previewChangedBy(["src/ap"], "src/app.ts")).toBe(false);
    expect(previewChangedBy(["src/app.ts.bak"], "src/app.ts")).toBe(false);
  });

  it("normalizes both sides before comparing", () => {
    expect(previewChangedBy(["src\\app.ts"], "src/app.ts")).toBe(true);
    expect(previewChangedBy(["./src/app.ts"], "src/app.ts")).toBe(true);
  });

  it("treats an unattributable change as a hit", () => {
    expect(previewChangedBy(null, "src/app.ts")).toBe(true);
  });

  it("treats an empty list as no hit at all", () => {
    expect(previewChangedBy([], "src/app.ts")).toBe(false);
  });

  it("ignores a blank path", () => {
    expect(previewChangedBy(["", "./"], "src/app.ts")).toBe(false);
  });
});
