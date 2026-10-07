import { describe, expect, it } from "vitest";
import { extensionOf, languageFor, previewKindFor } from "./file-kind.ts";

describe("extensionOf", () => {
  it("lowercases the extension and ignores the dot", () => {
    expect(extensionOf("App.TSX")).toBe("tsx");
    expect(extensionOf("a/b/readme.md")).toBe("md");
  });

  it("treats a dotfile and a bare name as extensionless", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("Dockerfile")).toBe("");
    expect(extensionOf("trailing.")).toBe("");
  });
});

describe("languageFor", () => {
  it("maps common extensions to their shiki language", () => {
    expect(languageFor("main.ts")).toBe("typescript");
    expect(languageFor("styles.module.css")).toBe("css");
    expect(languageFor("data.yml")).toBe("yaml");
  });

  it("maps a few well-known extensionless names", () => {
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("Makefile")).toBe("make");
  });

  it("returns undefined for text that has no language", () => {
    expect(languageFor("notes.txt")).toBeUndefined();
    expect(languageFor("LICENSE")).toBeUndefined();
  });
});

describe("previewKindFor", () => {
  it("honours the server's verdict before the extension", () => {
    expect(previewKindFor("photo.png", "image")).toBe("image");
    expect(previewKindFor("report.xlsx", "unsupported")).toBe("unsupported");
  });

  it("takes a PDF as its own kind rather than as a refusal", () => {
    // The server answers `pdf` for a document it will stream rather than read;
    // the tab mounts the browser's viewer against `/raw` for it.
    expect(previewKindFor("report.pdf", "pdf")).toBe("pdf");
  });

  it("draws HTML in a frame instead of showing its source", () => {
    expect(previewKindFor("page.html", "text")).toBe("html");
    expect(previewKindFor("page.HTM", "text")).toBe("html");
  });

  it("still shows HTML source when the server refused the file", () => {
    // A refusal is a refusal whatever the extension says: the reason is what the
    // tab has to draw.
    expect(previewKindFor("page.html", "unsupported")).toBe("unsupported");
  });

  it("splits text into markdown, code and plain text", () => {
    expect(previewKindFor("README.md", "text")).toBe("markdown");
    expect(previewKindFor("index.ts", "text")).toBe("code");
    expect(previewKindFor("notes.txt", "text")).toBe("text");
  });
});
