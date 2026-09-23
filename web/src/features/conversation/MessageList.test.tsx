import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentMessage, AssistantMessage, ContentBlock } from "../../lib/types.ts";
import { MessageList } from "./MessageList.tsx";
import { EMPTY_TIMING, sessionStats } from "./stats-model.ts";
import type { ConversationView } from "./useConversation.ts";

const CWD = "/Users/dev/proj";
const noop = (): void => {};

function view(messages: AgentMessage[]): ConversationView {
  return {
    messages,
    forkPoints: [],
    todos: [],
    partial: null,
    toolExecutions: {},
    isStreaming: false,
    loading: false,
    error: null,
    retry: null,
    stats: sessionStats(messages, EMPTY_TIMING),
  };
}

function asked(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function answered(blocks: ContentBlock[]): AssistantMessage {
  return { role: "assistant", content: blocks, timestamp: 1 };
}

const text = (value: string): ContentBlock => ({ type: "text", text: value });
const wrote = (path: string): ContentBlock => ({
  type: "toolCall",
  id: `call-${path}`,
  name: "write",
  arguments: { path, content: "x\n" },
});

/**
 * The transcripts here are the integration point the card has to get right: the
 * files belong to the turn that wrote them, and a turn that wrote nothing gets
 * no card at all.
 */
describe("MessageList changed files", () => {
  it("puts a turn's files under that turn's answer", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("改一下"), answered([text("改好了"), wrote(`${CWD}/src/app.ts`)])])}
        cwd={CWD}
        home="/Users/dev"
        onOpenFile={noop}
      />,
    );

    expect(html).toContain("已编辑 1 个文件");
    expect(html).toContain("在右侧栏预览 src/app.ts");
  });

  it("keeps each turn's files with its own turn", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([
          asked("第一个"),
          answered([text("好了"), wrote(`${CWD}/a.ts`)]),
          asked("第二个"),
          answered([text("好了"), wrote(`${CWD}/b.ts`)]),
        ])}
        cwd={CWD}
        home="/Users/dev"
        onOpenFile={noop}
      />,
    );

    expect(html.match(/已编辑 1 个文件/g)).toHaveLength(2);
    expect(html).toContain("在右侧栏预览 a.ts");
    expect(html).toContain("在右侧栏预览 b.ts");
    // Two cards, one per turn — not one card carrying both files.
    expect(html).not.toContain("已编辑 2 个文件");
  });

  it("draws no card for a turn that wrote nothing", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("解释一下"), answered([text("这是解释")])])}
        cwd={CWD}
        home="/Users/dev"
        onOpenFile={noop}
      />,
    );

    expect(html).not.toContain("已编辑");
  });

  it("lists the files without a preview handler", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("改一下"), answered([text("好了"), wrote(`${CWD}/a.ts`)])])}
        cwd={CWD}
        home="/Users/dev"
      />,
    );

    expect(html).toContain("已编辑 1 个文件");
    expect(html).not.toContain("在右侧栏预览 a.ts");
  });
});

/**
 * A skill sent from the web never leaves the composer's literal command behind:
 * the optimistic turn is the only copy of a user message the transcript shows,
 * so the bubble has to fold `/skill:<name>` itself or the chip — glyph and
 * colour included — never appears.
 */
describe("MessageList skill chip", () => {
  it("draws a shipped skill command as a chip", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("/skill:git-commit"), answered([text("好了")])])}
        cwd={CWD}
        home="/Users/dev"
      />,
    );

    expect(html).toContain("/skill:git-commit");
    expect(html).toContain("skillChip");
    expect(html).toContain("skillIcon");
  });

  it("keeps the arguments outside the chip", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("/skill:git-commit fix the typo"), answered([text("好了")])])}
        cwd={CWD}
        home="/Users/dev"
      />,
    );

    expect(html).toContain("skillChip");
    expect(html).toContain("/skill:git-commit</span> fix the typo");
  });

  it("leaves ordinary text as text", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("解释一下 /skill:git-commit"), answered([text("这是解释")])])}
        cwd={CWD}
        home="/Users/dev"
      />,
    );

    expect(html).not.toContain("skillChip");
  });
});
