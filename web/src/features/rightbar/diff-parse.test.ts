import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff-parse.ts";

/** A realistic one-file patch, as `git diff HEAD -- path` prints it. */
const MODIFIED = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1234567..89abcde 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export { a };",
  "\\ No newline at end of file",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("reads the two paths and drops the git metadata lines", () => {
    const result = parseUnifiedDiff(MODIFIED);
    expect(result.oldPath).toBe("src/app.ts");
    expect(result.newPath).toBe("src/app.ts");
    expect(result.binary).toBe(false);
    expect(result.hunks).toHaveLength(1);
  });

  it("counts what was added and removed", () => {
    const result = parseUnifiedDiff(MODIFIED);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(1);
  });

  it("numbers both sides of the hunk, starting at the hunk's own position", () => {
    const lines = parseUnifiedDiff(MODIFIED).hunks[0]!.lines;
    const byText = new Map(lines.map((line) => [line.text, line]));
    expect(byText.get("const a = 1;")).toMatchObject({ oldLine: 1, newLine: 1 });
    expect(byText.get("const b = 2;")).toMatchObject({ kind: "del", oldLine: 2, newLine: null });
    expect(byText.get("const b = 3;")).toMatchObject({ kind: "add", oldLine: null, newLine: 2 });
    expect(byText.get("const c = 4;")).toMatchObject({ kind: "add", oldLine: null, newLine: 3 });
    // After one line out and two in, the old side has only advanced by one.
    expect(byText.get("export { a };")).toMatchObject({ oldLine: 3, newLine: 4 });
  });

  it("keeps the hunk header and the no-newline notice as meta lines", () => {
    const lines = parseUnifiedDiff(MODIFIED).hunks[0]!.lines;
    expect(lines[0]).toMatchObject({ kind: "meta", text: "@@ -1,4 +1,5 @@" });
    expect(lines.at(-1)).toMatchObject({ kind: "meta", text: "\\ No newline at end of file" });
  });

  it("follows several hunks with their own counters", () => {
    const patch = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      "-one",
      "+ONE",
      " two",
      "@@ -10,2 +10,3 @@",
      " ten",
      "+ten and a half",
      " eleven",
    ].join("\n");
    const result = parseUnifiedDiff(patch);
    expect(result.hunks).toHaveLength(2);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(1);
    const second = result.hunks[1]!.lines;
    expect(second[1]).toMatchObject({ text: "ten", oldLine: 10, newLine: 10 });
    expect(second[2]).toMatchObject({ text: "ten and a half", kind: "add", newLine: 11 });
    expect(second[3]).toMatchObject({ text: "eleven", newLine: 12 });
  });

  it("reads /dev/null as a missing side, for an added file", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+second",
    ].join("\n");
    const result = parseUnifiedDiff(patch);
    expect(result.oldPath).toBeNull();
    expect(result.newPath).toBe("new.txt");
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(0);
  });

  it("flags a binary patch and counts nothing for it", () => {
    const patch = [
      "diff --git a/logo.png b/logo.png",
      "index 1234567..89abcde 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    const result = parseUnifiedDiff(patch);
    expect(result.binary).toBe(true);
    expect(result.hunks).toEqual([]);
    expect(result.additions + result.deletions).toBe(0);
  });

  it("treats an empty patch as no change at all", () => {
    expect(parseUnifiedDiff("")).toMatchObject({
      hunks: [],
      additions: 0,
      deletions: 0,
      binary: false,
    });
  });

  it("keeps a blank context line rather than collapsing it", () => {
    // git writes " " for a blank context line; a trailing newline in the patch
    // must not become an extra one.
    const patch = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " one", " ", "-two", "+2"].join(
      "\n",
    );
    const lines = parseUnifiedDiff(patch).hunks[0]!.lines;
    expect(lines.map((line) => line.text)).toEqual(["@@ -1,3 +1,3 @@", "one", "", "two", "2"]);
    expect(lines[2]).toMatchObject({ kind: "context", oldLine: 2, newLine: 2 });
  });
});
