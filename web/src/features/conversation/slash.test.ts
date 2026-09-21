import { describe, expect, it } from "vitest";
import type { SlashCommand } from "../../lib/types.ts";
import { detectSlashTrigger, filterCommands, parseBuiltinCommand } from "./slash.ts";

describe("detectSlashTrigger", () => {
  it("finds a slash at the start of the input", () => {
    expect(detectSlashTrigger("/", 1)).toEqual({ query: "", start: 0 });
    expect(detectSlashTrigger("/sk", 3)).toEqual({ query: "sk", start: 0 });
  });

  it("finds a slash that opens a word", () => {
    expect(detectSlashTrigger("hi /sk", 6)).toEqual({ query: "sk", start: 3 });
  });

  it("ignores a slash inside a word or path", () => {
    expect(detectSlashTrigger("a/b", 3)).toBeNull();
    expect(detectSlashTrigger("see /etc/hosts", 14)).toBeNull();
  });

  it("closes once an argument is typed", () => {
    expect(detectSlashTrigger("/skill:pdf extract", 18)).toBeNull();
  });

  it("keeps the colon so skill commands complete", () => {
    expect(detectSlashTrigger("/skill:", 7)).toEqual({ query: "skill:", start: 0 });
  });

  it("only considers text before the caret", () => {
    // Caret parked at the end of an earlier token.
    expect(detectSlashTrigger("/review /rev", 7)).toEqual({ query: "review", start: 0 });
    // Caret before the slash: nothing is being completed.
    expect(detectSlashTrigger("/review", 0)).toBeNull();
  });

  it("clamps a caret outside the value", () => {
    expect(detectSlashTrigger("/rev", 99)).toEqual({ query: "rev", start: 0 });
    expect(detectSlashTrigger("/rev", -5)).toBeNull();
  });
});

const commands: SlashCommand[] = [
  { name: "skill:pdf-tools", description: "Extract text from PDFs", source: "skill" },
  { name: "review", description: "Review the current diff", source: "prompt" },
  { name: "code-review", description: "Walk through a pull request", source: "prompt" },
  { name: "skill:brave-search", description: "Search the web", source: "skill" },
  { name: "export", description: "Write the PDF transcript out", source: "extension" },
];

const names = (query: string) => filterCommands(commands, query).map((command) => command.name);

describe("filterCommands", () => {
  it("returns everything for an empty query, grouped by kind then alphabetically", () => {
    expect(names("")).toEqual([
      "export",
      "code-review",
      "review",
      "skill:brave-search",
      "skill:pdf-tools",
    ]);
  });

  it("ranks a prefix match above a mere substring match", () => {
    expect(names("review")).toEqual(["review", "code-review"]);
  });

  it("ranks a name match above a description-only match", () => {
    // "skill:pdf-tools" matches on its name; "export" only on its description.
    expect(names("pdf")).toEqual(["skill:pdf-tools", "export"]);
  });

  it("finds a command by its description alone", () => {
    expect(names("web")).toEqual(["skill:brave-search"]);
  });

  it("is case-insensitive", () => {
    expect(names("REVIEW")).toEqual(["review", "code-review"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(names("zzz")).toEqual([]);
  });

  it("keeps equally good matches grouped by kind", () => {
    const equal: SlashCommand[] = [
      { name: "zeta", source: "skill" },
      { name: "alpha", source: "extension" },
      { name: "mid", source: "prompt" },
    ];
    expect(filterCommands(equal, "").map((command) => command.source)).toEqual([
      "extension",
      "prompt",
      "skill",
    ]);
  });

  it("ranks relevance above kind, so sectioning never buries the best match", () => {
    const mixed: SlashCommand[] = [
      { name: "zeta", source: "skill" },
      { name: "pdf-tools", source: "skill" },
      { name: "export", description: "writes PDFs", source: "extension" },
    ];
    // "pdf-tools" matches on its name; "export" only on its description, and
    // that outranks the fact that extensions section before skills.
    expect(filterCommands(mixed, "pdf").map((command) => command.name)).toEqual([
      "pdf-tools",
      "export",
    ]);
  });

  it("puts built-in commands first when nothing is typed", () => {
    const withBuiltin: SlashCommand[] = [
      { name: "skill:pdf-tools", source: "skill" },
      { name: "compact", source: "builtin" },
      { name: "review", source: "prompt" },
    ];
    expect(filterCommands(withBuiltin, "").map((command) => command.name)).toEqual([
      "compact",
      "review",
      "skill:pdf-tools",
    ]);
  });
});

const runnable: SlashCommand[] = [
  { name: "compact", source: "builtin" },
  { name: "name", source: "builtin" },
  { name: "skill:pdf-tools", source: "skill" },
];

describe("parseBuiltinCommand", () => {
  it("splits a bare command", () => {
    expect(parseBuiltinCommand("/compact", runnable)).toEqual({
      command: runnable[0],
      args: "",
    });
  });

  it("splits its arguments", () => {
    expect(parseBuiltinCommand("/name 重构登录", runnable)?.args).toBe("重构登录");
  });

  it("keeps inner whitespace in the arguments", () => {
    expect(parseBuiltinCommand("/compact  keep  the  API  notes", runnable)?.args).toBe(
      "keep  the  API  notes",
    );
  });

  it("leaves commands pi expands itself alone", () => {
    // These are still ordinary prompts: pi expands them on delivery.
    expect(parseBuiltinCommand("/skill:pdf-tools extract", runnable)).toBeNull();
    expect(parseBuiltinCommand("/review", runnable)).toBeNull();
  });

  it("ignores text and paths", () => {
    expect(parseBuiltinCommand("hello", runnable)).toBeNull();
    expect(parseBuiltinCommand("fix /etc/hosts", runnable)).toBeNull();
    expect(parseBuiltinCommand("/etc/hosts", runnable)).toBeNull();
  });

  it("will not match a name containing a slash", () => {
    expect(parseBuiltinCommand("/compact/now", runnable)).toBeNull();
  });
});
