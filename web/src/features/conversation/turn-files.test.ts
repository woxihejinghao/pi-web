import { describe, expect, it } from "vitest";
import type { AgentMessage, AssistantMessage, ContentBlock } from "../../lib/types.ts";
import { turnFiles } from "./turn-files.ts";

/** One assistant message holding the given content blocks. */
function assistant(blocks: ContentBlock[]): AssistantMessage {
  return { role: "assistant", content: blocks, timestamp: 0 };
}

function call(name: string, arguments_: Record<string, unknown>): ContentBlock {
  return { type: "toolCall", id: `${name}-${String(Math.random())}`, name, arguments: arguments_ };
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 };
}

const CWD = "/Users/dev/proj";

describe("turnFiles", () => {
  it("keeps a write and an edit, labelled with the tool that ran", () => {
    const files = turnFiles(
      [
        user("做点东西"),
        assistant([
          call("write", { path: `${CWD}/src/new.ts`, content: "export const a = 1;\n" }),
          call("edit", { path: `${CWD}/README.md`, edits: [{ oldText: "a", newText: "b" }] }),
        ]),
      ],
      { cwd: CWD },
    );

    expect(files.map((file) => file.display)).toEqual(["src/new.ts", "README.md"]);
    expect(files.map((file) => file.tools)).toEqual([["写入"], ["编辑"]]);
    expect(files.map((file) => file.relative)).toEqual(["src/new.ts", "README.md"]);
  });

  it("folds repeated writes of one file into a single row with a call count", () => {
    const files = turnFiles(
      [
        assistant([call("edit", { path: `${CWD}/a.ts`, edits: [] })]),
        assistant([
          call("edit", { path: `${CWD}/a.ts`, edits: [] }),
          call("write", { path: `${CWD}/a.ts`, content: "" }),
        ]),
      ],
      { cwd: CWD },
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.calls).toBe(3);
    // Both labels survive, in the order the calls first used them.
    expect(files[0]?.tools).toEqual(["编辑", "写入"]);
  });

  it("treats ./a.ts and a.ts as the same file", () => {
    const files = turnFiles(
      [
        assistant([call("edit", { path: "./a.ts", edits: [] })]),
        assistant([call("edit", { path: "a.ts", edits: [] })]),
      ],
      { cwd: CWD },
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.calls).toBe(2);
    expect(files[0]?.relative).toBe("a.ts");
  });

  it("leaves a file outside the project unopenable but still listed", () => {
    const files = turnFiles([assistant([call("write", { path: "/tmp/notes.md", content: "x" })])], {
      cwd: CWD,
      home: "/Users/dev",
    });

    expect(files).toHaveLength(1);
    // The preview route takes a project-relative path, and this has no such form.
    expect(files[0]?.relative).toBeNull();
    expect(files[0]?.display).toBe("/tmp/notes.md");
  });

  it("shortens an outside path under the home directory", () => {
    const files = turnFiles(
      [assistant([call("edit", { path: "/Users/dev/.pi/settings.json", edits: [] })])],
      { cwd: CWD, home: "/Users/dev" },
    );

    expect(files[0]?.display).toBe("~/.pi/settings.json");
  });

  it("ignores tools that do not name a file they wrote", () => {
    const files = turnFiles(
      [
        assistant([
          call("bash", { command: "echo hi > a.ts" }),
          call("read", { path: `${CWD}/a.ts` }),
          call("grep", { pattern: "a" }),
        ]),
      ],
      { cwd: CWD },
    );

    // `bash` may have written anything; attributing it to a path would be a guess.
    expect(files).toEqual([]);
  });

  it("ignores a write whose arguments carry no usable path", () => {
    const files = turnFiles([assistant([call("write", { content: "orphan" })])], { cwd: CWD });
    expect(files).toEqual([]);
  });

  it("accepts pi's file_path spelling", () => {
    const files = turnFiles([assistant([call("edit", { file_path: `${CWD}/b.ts` })])], {
      cwd: CWD,
    });
    expect(files[0]?.relative).toBe("b.ts");
  });

  it("reads only the turn it was given", () => {
    const earlier = assistant([call("write", { path: `${CWD}/old.ts`, content: "" })]);
    const current = assistant([call("write", { path: `${CWD}/new.ts`, content: "" })]);

    expect(turnFiles([earlier], { cwd: CWD }).map((file) => file.display)).toEqual(["old.ts"]);
    expect(turnFiles([user("再来"), current], { cwd: CWD }).map((file) => file.display)).toEqual([
      "new.ts",
    ]);
  });
});
