import { describe, expect, it } from "vitest";
import { classifyFileType, fileExtension, isCodeFileType } from "./file-type.ts";

describe("fileExtension", () => {
  it("returns what follows the basename's final dot, case preserved", () => {
    expect(fileExtension("src/App.TSX")).toBe("TSX");
    expect(fileExtension("a/b/archive.tar.gz")).toBe("gz");
  });

  it("treats a dotfile and a trailing dot as extensionless", () => {
    expect(fileExtension(".gitignore")).toBe("gitignore");
    expect(fileExtension(".env")).toBe("env");
    expect(fileExtension("trailing.")).toBe("");
    expect(fileExtension("Dockerfile")).toBe("");
  });

  it("reads a Windows path the same way", () => {
    expect(fileExtension("C:\\work\\main.rs")).toBe("rs");
  });
});

describe("classifyFileType", () => {
  it("resolves the detailed code types before the coarse sheet", () => {
    expect(classifyFileType("src/main.ts")).toBe("typescript");
    expect(classifyFileType("src/App.tsx")).toBe("react");
    expect(classifyFileType("scripts/build.sh")).toBe("shell");
    expect(classifyFileType("Cargo.toml")).toBe("toml");
  });

  it("resolves filename rules before extension rules", () => {
    // `package.json` is the npm manifest, not a generic JSON document.
    expect(classifyFileType("package.json")).toBe("node");
    expect(classifyFileType(".gitignore")).toBe("git");
    expect(classifyFileType("Dockerfile.dev")).toBe("docker");
  });

  it("mines the presentation categories out of the extension", () => {
    expect(classifyFileType("shot.png")).toBe("image");
    expect(classifyFileType("clip.mp4")).toBe("video");
    expect(classifyFileType("report.xlsx")).toBe("excel");
    expect(classifyFileType("deck.pptx")).toBe("ppt");
    expect(classifyFileType("paper.pdf")).toBe("pdf");
    expect(classifyFileType("notes.md")).toBe("markdown");
    expect(classifyFileType("contract.docx")).toBe("word");
  });

  it("matches case-insensitively", () => {
    expect(classifyFileType("PHOTO.JPEG")).toBe("image");
    expect(classifyFileType("README.MD")).toBe("markdown");
  });

  it("knows the extensionless documents by name", () => {
    expect(classifyFileType("README")).toBe("markdown");
    expect(classifyFileType("docs/CHANGELOG")).toBe("markdown");
  });

  it("falls back to `other` only when nothing claims the file", () => {
    expect(classifyFileType("archive.zip")).toBe("other");
    expect(classifyFileType("LICENSE")).toBe("other");
    expect(classifyFileType("")).toBe("other");
  });

  it("keeps a coarse answer out of the code set", () => {
    // The sheet artwork and the full-colour artwork are drawn by two different
    // branches, so a kind that claimed both would be a mis-dispatch.
    for (const name of ["shot.png", "notes.md", "archive.zip", "deck.pptx"]) {
      expect(isCodeFileType(classifyFileType(name))).toBe(false);
    }
    expect(isCodeFileType(classifyFileType("src/main.ts"))).toBe(true);
  });
});
