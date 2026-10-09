import { describe, expect, it } from "vitest";
import type {
  AgentMessage,
  AssistantMessage,
  ContentBlock,
  ToolResultMessage,
} from "../../lib/types.ts";
import { turnFiles as turnFilesOf } from "./turn-files.ts";

type TurnFilesParams = Parameters<typeof turnFilesOf>;
const turnFiles = (
  messages: TurnFilesParams[0],
  paths: TurnFilesParams[1] = {},
  results: TurnFilesParams[2] = {},
): ReturnType<typeof turnFilesOf> => turnFilesOf(messages, paths, results);

/** One assistant message holding the given content blocks. */
function assistant(blocks: ContentBlock[]): AssistantMessage {
  return { role: "assistant", content: blocks, timestamp: 0 };
}

function call(
  name: string,
  arguments_: Record<string, unknown>,
  id = `${name}-${String(Math.random())}`,
): ContentBlock {
  return { type: "toolCall", id, name, arguments: arguments_ };
}

/** The result pi recorded for one call; `details` is where an edit keeps its patch. */
function resultOf(
  id: string,
  toolName: string,
  options: { details?: unknown; isError?: boolean } = {},
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [],
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.isError === undefined ? {} : { isError: options.isError }),
    timestamp: 0,
  };
}

/** pi's own unified patch for an edit, as it lands in `details.patch`. */
const PATCH = [
  "--- /proj/a.ts",
  "+++ /proj/a.ts",
  "@@ -1,3 +1,3 @@",
  " context",
  "-gone",
  "+kept",
  " tail",
].join("\n");

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 };
}

const CWD = "/Users/dev/proj";

describe("turnFiles", () => {
  it("keeps a write and an edit, in the order they were first written", () => {
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
    expect(files.map((file) => file.relative)).toEqual(["src/new.ts", "README.md"]);
  });

  it("folds every call that touched one file into a single row", () => {
    const files = turnFiles(
      [
        assistant([call("edit", { path: `${CWD}/a.ts`, edits: [{ newText: "one\ntwo" }] })]),
        assistant([
          call("edit", { path: `${CWD}/a.ts`, edits: [{ newText: "three" }] }),
          call("write", { path: `${CWD}/a.ts`, content: "" }),
        ]),
      ],
      { cwd: CWD },
    );

    expect(files).toHaveLength(1);
    // The row adds up the calls: 2 + 1 lines, and the write contributed none.
    expect(files[0]?.added).toBe(3);
    expect(files[0]?.deleted).toBe(0);
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

  it("counts a write's content as additions and keeps its patch", () => {
    const files = turnFiles(
      [assistant([call("write", { path: `${CWD}/src/new.ts`, content: "export const a = 1;\n\n" })])],
      { cwd: CWD },
    );

    // The trailing newline ends the second line; it does not open a third.
    expect(files[0]?.added).toBe(2);
    expect(files[0]?.deleted).toBe(0);
    expect(files[0]?.patches).toHaveLength(1);
    expect(files[0]?.patches[0]).toContain("+export const a = 1;");
    expect(files[0]?.oversized).toBe(false);
  });

  it("measures an edit from pi's own patch rather than from its arguments", () => {
    const files = turnFiles(
      [
        assistant([
          call(
            "edit",
            { path: `${CWD}/a.ts`, edits: [{ oldText: "one\ntwo\nthree", newText: "one" }] },
            "call-1",
          ),
        ]),
      ],
      { cwd: CWD },
      { "call-1": resultOf("call-1", "edit", { details: { patch: PATCH } }) },
    );

    expect(files[0]?.added).toBe(1);
    expect(files[0]?.deleted).toBe(1);
    expect(files[0]?.patches).toEqual([PATCH]);
  });

  it("falls back to the edits argument when the turn carries no result", () => {
    const files = turnFiles(
      [
        assistant([
          call("edit", { path: `${CWD}/a.ts`, edits: [{ oldText: "one\ntwo", newText: "one" }] }),
        ]),
      ],
      { cwd: CWD },
    );

    expect(files[0]?.added).toBe(1);
    expect(files[0]?.deleted).toBe(2);
    // Nothing to draw: printing the arguments as a patch would be a comparison
    // this transcript never made.
    expect(files[0]?.patches).toEqual([]);
  });

  it("counts nothing for a call that failed", () => {
    const files = turnFiles(
      [assistant([call("write", { path: `${CWD}/a.ts`, content: "nope" }, "call-2")])],
      { cwd: CWD },
      { "call-2": resultOf("call-2", "write", { isError: true }) },
    );

    expect(files[0]?.added).toBe(0);
    expect(files[0]?.deleted).toBe(0);
    expect(files[0]?.patches).toEqual([]);
  });

  it("adds up every call that touched one file", () => {
    const files = turnFiles(
      [
        assistant([
          call("write", { path: `${CWD}/a.ts`, content: "one\ntwo\n" }),
          call("edit", { path: `${CWD}/a.ts`, edits: [] }, "call-3"),
        ]),
      ],
      { cwd: CWD },
      { "call-3": resultOf("call-3", "edit", { details: { patch: PATCH } }) },
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.added).toBe(3);
    expect(files[0]?.deleted).toBe(1);
    expect(files[0]?.patches).toHaveLength(2);
  });

  it("marks a write with no content as oversized instead of guessing", () => {
    const files = turnFiles([assistant([call("write", { path: `${CWD}/big.bin` })])], { cwd: CWD });

    expect(files[0]?.oversized).toBe(true);
    expect(files[0]?.added).toBe(0);
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
