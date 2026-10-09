import { describe, expect, it } from "vitest";
import { translator } from "../../lib/i18n/index.ts";

// These assertions pin the Chinese wording, so the table is resolved for zh-CN
// here rather than depending on whatever locale the test host happens to have.
const zh = translator("zh-CN");
const VARIANT_TITLES = variantTitles(zh);
import {
  SUMMARY_KEYS,
  TOOL_VARIANTS,
  variantTitles,
  abbreviateHomePath,
  classify,
  deriveSummary,
  firstLine,
  firstNonBlankLine,
  lastNonBlankLine,
  relativizeToCwd,
  shortenPath,
  splitForCompact,
  splitIntoProcessSegments,
  processTitle,
  processSegmentTitle,
  processActivityOf,
  type ProcessActivity,
  type Variant,
} from "./row-model.ts";

describe("classify", () => {
  it("maps pi tool names onto dsh's variants", () => {
    expect(classify("bash")).toBe("bash");
    // Same row shape (`command` / `description`), so the same variant.
    expect(classify("powershell")).toBe("bash");
    expect(classify("read")).toBe("read");
    expect(classify("write")).toBe("write");
    expect(classify("edit")).toBe("edit");
  });

  it("folds the tools pi has no dsh equivalent for into search", () => {
    // pi splits listing/finding across four tools; dsh renders one search row.
    expect(classify("grep")).toBe("search");
    expect(classify("find")).toBe("search");
    expect(classify("glob")).toBe("search");
    expect(classify("ls")).toBe("search");
  });

  it("falls back to others for anything unknown, including mcp tools", () => {
    expect(classify("todo")).toBe("others");
    expect(classify("task")).toBe("others");
    expect(classify("mcp__figma__get_code")).toBe("others");
    expect(classify("")).toBe("others");
  });

  it("only ever returns a variant that has a title and a summary-keys entry", () => {
    const variants = new Set<string>(Object.values(TOOL_VARIANTS));
    variants.add("others");
    for (const variant of variants) {
      expect(VARIANT_TITLES[variant as Variant]).toBeTypeOf("string");
      expect(SUMMARY_KEYS[variant as Variant]).toBeInstanceOf(Array);
    }
  });
});

describe("line helpers", () => {
  it("cuts at the first newline", () => {
    expect(firstLine("one\ntwo")).toBe("one");
    expect(firstLine("one")).toBe("one");
    expect(firstLine("\nsecond")).toBe("");
  });

  it("skips leading blank lines when picking the first line", () => {
    expect(firstNonBlankLine("\n\n  \nreal content\nmore")).toBe("real content");
    expect(firstNonBlankLine("")).toBe("");
    expect(firstNonBlankLine("   \n  ")).toBe("");
  });

  it("skips trailing blank lines when picking the last line", () => {
    expect(lastNonBlankLine("first\n\nlast\n\n  \n")).toBe("last");
    expect(lastNonBlankLine("only")).toBe("only");
    expect(lastNonBlankLine("")).toBe("");
  });
});

describe("deriveSummary", () => {
  it("prefers a bash description over the command itself", () => {
    expect(deriveSummary("bash", { description: "List the files", command: "ls -la" })).toBe(
      "List the files",
    );
  });

  it("falls back to the command when there is no description", () => {
    expect(deriveSummary("bash", { command: "npm test" })).toBe("npm test");
  });

  it("takes only the first line of a multi-line command", () => {
    expect(deriveSummary("bash", { command: "cd /tmp\nrm -rf build" })).toBe("cd /tmp");
  });

  it("uses the path for file tools", () => {
    expect(deriveSummary("read", { path: "src/index.ts" })).toBe("src/index.ts");
    expect(deriveSummary("edit", { file_path: "a/b.ts", old_string: "x" })).toBe("a/b.ts");
    expect(deriveSummary("write", { path: "new.ts", content: "..." })).toBe("new.ts");
  });

  it("joins a search's queries array", () => {
    expect(deriveSummary("search", { queries: ["alpha", "beta\nmore"] })).toBe("alpha, beta");
  });

  it("ignores an empty queries array and uses the preferred key", () => {
    expect(deriveSummary("search", { queries: [], pattern: "needle" })).toBe("needle");
  });

  it("falls back to any non-empty string argument", () => {
    // An unknown tool with a shape we have no key table for still gets a summary.
    expect(deriveSummary("others", { whatever: "some value" })).toBe("some value");
  });

  it("returns nothing when there is no usable text", () => {
    expect(deriveSummary("others", {})).toBe("");
    expect(deriveSummary("others", { count: 3, flag: true })).toBe("");
    expect(deriveSummary("bash", undefined)).toBe("");
  });

  it("never returns a multi-line summary, whatever the arguments hold", () => {
    const messy = {
      tail: "line one\nline two",
      path: "a\nb",
    };
    for (const variant of Object.keys(SUMMARY_KEYS) as Variant[]) {
      expect(deriveSummary(variant, messy)).not.toContain("\n");
    }
  });
});

describe("path shortening", () => {
  it("strips the workspace root only when the whole string is rooted there", () => {
    expect(relativizeToCwd("/work/proj/src/a.ts", "/work/proj")).toBe("src/a.ts");
    // A shell command starts with `cd`, so the path inside it must survive.
    expect(relativizeToCwd("cd /work/proj && ls", "/work/proj")).toBe("cd /work/proj && ls");
    expect(relativizeToCwd("/elsewhere/a.ts", "/work/proj")).toBe("/elsewhere/a.ts");
  });

  it("tolerates a trailing slash on the root", () => {
    expect(relativizeToCwd("/work/proj/src/a.ts", "/work/proj/")).toBe("src/a.ts");
  });

  it("leaves the path alone without a workspace", () => {
    expect(relativizeToCwd("/work/proj/src/a.ts", undefined)).toBe("/work/proj/src/a.ts");
    expect(relativizeToCwd("/work/proj/src/a.ts", "")).toBe("/work/proj/src/a.ts");
  });

  it("shortens a home-relative path to ~", () => {
    expect(abbreviateHomePath("/Users/me/proj/a.ts", "/Users/me")).toBe("~/proj/a.ts");
    expect(abbreviateHomePath("/Users/me", "/Users/me")).toBe("~");
    expect(abbreviateHomePath("/Users/me/", "/Users/me")).toBe("~");
  });

  it("does not touch a path outside home", () => {
    expect(abbreviateHomePath("/opt/x/a.ts", "/Users/me")).toBe("/opt/x/a.ts");
    // A sibling whose name merely starts with the home path is not inside it.
    expect(abbreviateHomePath("/Users/melon/a.ts", "/Users/me")).toBe("/Users/melon/a.ts");
  });

  it("refuses to half-translate windows paths", () => {
    expect(abbreviateHomePath("C:\\Users\\me\\a.ts", "C:\\Users\\me")).toBe(
      "C:\\Users\\me\\a.ts",
    );
    expect(abbreviateHomePath("\\Users\\me\\a.ts", "/Users/me")).toBe("\\Users\\me\\a.ts");
  });

  it("prefers the workspace-relative form over ~", () => {
    // Relativising first is what makes this `src/a.ts` rather than `~/proj/src/a.ts`.
    expect(shortenPath("/Users/me/proj/src/a.ts", "/Users/me/proj", "/Users/me")).toBe("src/a.ts");
    expect(shortenPath("/Users/me/other/a.ts", "/Users/me/proj", "/Users/me")).toBe(
      "~/other/a.ts",
    );
  });
});

describe("titles match dsh's zh-CN table", () => {
  it("keeps Bash untranslated, as dsh does", () => {
    expect(VARIANT_TITLES.bash).toBe("Bash");
  });

  it("uses the same strings dsh ships", () => {
    expect(VARIANT_TITLES.read).toBe("读取");
    expect(VARIANT_TITLES.write).toBe("写入");
    expect(VARIANT_TITLES.edit).toBe("编辑");
    expect(VARIANT_TITLES.search).toBe("搜索");
    expect(VARIANT_TITLES.code).toBe("代码");
    expect(VARIANT_TITLES.others).toBe("工具调用");
  });
});

describe("splitForCompact", () => {
  const text = (t: string) => ({ block: { type: "text", text: t }, at: t });
  const thinking = (t: string) => ({ block: { type: "thinking", thinking: t }, at: t });
  const call = (id: string) => ({ block: { type: "toolCall", id, name: "bash", arguments: {} }, at: id });

  it("treats thinking and tool calls as process, text as the answer", () => {
    const { process, answers } = splitForCompact([
      thinking("weighing options"),
      call("a"),
      text("done"),
    ]);
    expect(process.map((step) => step.block.type)).toEqual(["thinking", "toolCall"]);
    expect(answers.map((step) => step.block.type)).toEqual(["text"]);
  });

  it("carries the caller's own step identity through the partition", () => {
    // Position is what MessageList keys on, so a step moved into the group must
    // keep it or React would remount the row and lose its open state.
    const { process, answers } = splitForCompact([text("a"), call("x"), text("b")]);
    expect(process.map((step) => step.at)).toEqual(["x"]);
    expect(answers.map((step) => step.at)).toEqual(["a", "b"]);
  });

  it("keeps answers adjacent when they were interleaved with process", () => {
    const { answers } = splitForCompact([text("one"), call("x"), text("two")]);
    // Documented trade of the mode: both answers render together after the group.
    expect(answers.map((step) => step.at)).toEqual(["one", "two"]);
  });

  it("never folds an image into the collapsed group", () => {
    const image = { block: { type: "image", data: "…" }, at: "img" };
    const { process, answers } = splitForCompact([image, call("a")]);
    expect(process.map((step) => step.at)).toEqual(["a"]);
    expect(answers.map((step) => step.at)).toEqual(["img"]);
  });

  it("folds a step that is still streaming like any other process block", () => {
    // dsh's `stepGrouping` 'collapsed' folds a running turn too: the group's
    // live header, not the row, is what says what is happening. Only a live
    // *answer* block stays out.
    const steps: { block: { type?: string }; at: string; live?: boolean }[] = [
      { block: { type: "thinking" }, at: "settled" },
      { block: { type: "thinking" }, at: "live", live: true },
      { block: { type: "toolCall" }, at: "call" },
    ];
    const { process, answers } = splitForCompact(steps);
    expect(process.map((step) => step.at)).toEqual(["settled", "live", "call"]);
    expect(answers.map((step) => step.at)).toEqual([]);
  });

  it("handles a turn that is all process or all answer", () => {
    expect(splitForCompact([call("a"), call("b")]).answers).toEqual([]);
    expect(splitForCompact([text("hi")]).process).toEqual([]);
    expect(splitForCompact([])).toEqual({ process: [], answers: [] });
  });
});

describe("splitIntoProcessSegments", () => {
  const text = (t: string) => ({ block: { type: "text", text: t }, at: t });
  const thinking = (t: string) => ({ block: { type: "thinking", thinking: t }, at: t });
  const call = (id: string) => ({ block: { type: "toolCall", id, name: "bash", arguments: {} }, at: id });

  it("cuts a turn at every answer, keeping process runs separate", () => {
    const segments = splitIntoProcessSegments([
      thinking("a"), call("1"), text("first"), thinking("b"), call("2"), text("second"),
    ]);
    expect(segments.map((segment) => segment.kind)).toEqual([
      "process", "answer", "process", "answer",
    ]);
    expect(segments[2]?.steps.map((step) => step.at)).toEqual(["b", "2"]);
  });

  it("keeps a streamed process step in its process run", () => {
    // A running turn is folded the same way, and the group's live header says
    // what is going on, so a streaming reasoning block stays with its process.
    const segments = splitIntoProcessSegments([
      { block: { type: "thinking" }, at: "settled" },
      { block: { type: "thinking" }, at: "live", live: true },
    ]);
    expect(segments.map((segment) => segment.kind)).toEqual(["process"]);
    expect(segments[0]?.steps.map((step) => step.at)).toEqual(["settled", "live"]);
  });
});

describe("processActivityOf", () => {
  it("maps pi tool names onto dsh's activity categories", () => {
    expect(processActivityOf("bash")).toBe("commands");
    expect(processActivityOf("read")).toBe("read");
    expect(processActivityOf("grep")).toBe("search");
    expect(processActivityOf("edit")).toBe("edit");
    expect(processActivityOf("write")).toBe("write");
    expect(processActivityOf("mystery")).toBe("tools");
  });

  it("gives pi's own tools the category dsh gives its equivalents", () => {
    // Both used to fall through to `tools` — "正在调用工具" for a shell command
    // and for a plan update.
    expect(processActivityOf("powershell")).toBe("commands");
    expect(processActivityOf("todo")).toBe("plan");
  });
});

describe("processTitle", () => {
  it("joins two categories without the shared prefix", () => {
    const counts = new Map<ProcessActivity, number>([["read", 1], ["search", 1]]);
    expect(processTitle(counts, zh)).toBe("已读取文件并搜索代码");
  });

  it("lists three categories and truncates beyond that", () => {
    const three = new Map<ProcessActivity, number>([["read", 1], ["search", 1], ["commands", 1]]);
    expect(processTitle(three, zh)).toBe("已读取文件，已搜索代码，执行了命令");
    const four = new Map<ProcessActivity, number>([
      ["read", 1], ["search", 1], ["commands", 1], ["edit", 1],
    ]);
    expect(processTitle(four, zh)).toBe("已读取文件，已搜索代码，执行了命令等");
  });
});

describe("processSegmentTitle", () => {
  const call = (name: string) => ({ block: { type: "toolCall", id: name, name, arguments: {} } });
  const thinking = () => ({ block: { type: "thinking", thinking: "…" } });

  it("names a run by its tool categories, ranking by count", () => {
    const heading = processSegmentTitle([call("read"), call("read"), call("grep")], zh);
    expect(heading.title).toBe("已读取文件并搜索代码");
    expect(heading.activity).toBe("read");
    expect(heading.running).toBe(false);
  });

  it("reads a tool-free run as thinking", () => {
    expect(processSegmentTitle([thinking()], zh).title).toBe("已完成分析");
  });

  it("reads a streaming tool call as preparing, not running", () => {
    // An uncommitted block is one whose arguments are still being written, so
    // the tool has not started: dsh's `preparing`, and the one state where
    // "正在运行命令" would claim work that is not happening yet.
    const heading = processSegmentTitle([{ ...call("bash"), live: true }], zh);
    expect(heading.title).toBe("准备运行命令");
    expect(heading.activity).toBe("commands");
    expect(heading.running).toBe(true);
    expect(heading.preparing).toBe(true);
  });

  it("names a plan update by the plan category, in all three tenses", () => {
    expect(processSegmentTitle([{ ...call("todo"), live: true }], zh).title).toBe("准备更新计划");
    expect(processSegmentTitle([{ ...call("todo"), running: true }], zh).title).toBe("正在更新计划");
    expect(processSegmentTitle([call("todo")], zh).title).toBe("更新了计划");
  });

  it("uses the live activity label while only reasoning is streaming", () => {
    const heading = processSegmentTitle([{ ...thinking(), live: true }], zh);
    expect(heading.title).toBe("正在分析请求");
    expect(heading.running).toBe(true);
  });

  it("stays live for a committed tool call that is still executing", () => {
    // No block is streaming here: the work in progress is a tool that has
    // already been committed to the transcript, so `live` is absent and only
    // the execution's own running state can say the stretch is unfinished.
    const heading = processSegmentTitle([{ ...call("read"), running: true }], zh);
    expect(heading.title).toBe("正在读取文件");
    expect(heading.running).toBe(true);
    // Already executing, so this is not the preparing state.
    expect(heading.preparing).toBeUndefined();
  });

  it("stays live for an open stretch with nothing streaming", () => {
    // dsh closes a stretch only at a reply or the turn's end, so the last
    // stretch of a running turn is open even while the model is between steps:
    // it keeps the present-tense label for the work behind it instead of
    // reporting a finished summary.
    const heading = processSegmentTitle([call("read"), call("read")], zh, true);
    expect(heading.title).toBe("正在读取文件");
    expect(heading.running).toBe(true);
  });
});
