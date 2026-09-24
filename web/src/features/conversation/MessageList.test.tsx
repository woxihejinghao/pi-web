import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, AssistantMessage, ContentBlock } from "../../lib/types.ts";
import { MessageList } from "./MessageList.tsx";
import { EMPTY_TIMING, sessionStats } from "./stats-model.ts";
import type { ConversationView } from "./useConversation.ts";

// Interface copy resolves through `useT`, and the default `system` preference
// lands on English without a navigator (node test environment). Several
// assertions below pin the Chinese wording, so fix the host locale here.
vi.stubGlobal("navigator", { language: "zh-CN" });

const CWD = "/Users/dev/proj";
const noop = (): void => {};

function view(messages: AgentMessage[], patch: Partial<ConversationView> = {}): ConversationView {
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
    ...patch,
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

  it("holds the card back until the turn that wrote the files has ended", () => {
    const messages = [asked("改一下"), answered([text("改好了"), wrote(`${CWD}/src/app.ts`)])];
    const streaming = (
      <MessageList
        view={view(messages, { isStreaming: true })}
        cwd={CWD}
        home="/Users/dev"
        onOpenFile={noop}
      />
    );

    // The first round-trip is already in `messages` while the turn runs on, so
    // the card would otherwise appear — and keep growing — before the answer.
    expect(renderToStaticMarkup(streaming)).not.toContain("data-turn-files");

    const settled = renderToStaticMarkup(
      <MessageList view={view(messages)} cwd={CWD} home="/Users/dev" onOpenFile={noop} />,
    );
    expect(settled).toContain("已编辑 1 个文件");
    expect(settled).toContain("在右侧栏预览 src/app.ts");
  });

  it("keeps finished turns' cards while a later turn streams", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view(
          [
            asked("第一个"),
            answered([text("好了"), wrote(`${CWD}/a.ts`)]),
            asked("第二个"),
            answered([text("正在改"), wrote(`${CWD}/b.ts`)]),
          ],
          { isStreaming: true },
        )}
        cwd={CWD}
        home="/Users/dev"
        onOpenFile={noop}
      />,
    );

    expect(html.match(/data-turn-files/g)).toHaveLength(1);
    expect(html).toContain("已编辑 1 个文件");
    expect(html).toContain("在右侧栏预览 a.ts");
    expect(html).not.toContain("在右侧栏预览 b.ts");
  });
});

/**
 * A skill sent from the web never leaves the composer's literal command behind:
 * the optimistic turn is the only copy of a user message the transcript shows,
 * so the bubble has to fold `/skill:<name>` itself or the chip — glyph and
 * colour included — never appears.
 */
/**
 * The streaming answer is rendered inside the turn it is about to land in, not
 * after the rail.
 *
 * That placement is the whole fix for the flicker at `message_end`: the partial
 * and the committed message then occupy the same React parent with the same
 * keys, so React reuses the mounted DOM instead of throwing every fence and
 * reasoning row away and rebuilding an identical copy a moment later. The
 * assertions below slice out the turn's own markup so "inside the turn" is a
 * real claim — a partial rendered after the rail still contains its text in the
 * document, and would pass a bare `toContain`.
 */
function turnMarkup(html: string, turn: number): string {
  const marker = `data-turn="${String(turn)}"`;
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`no ${marker} in markup`);
  const open = html.lastIndexOf("<div", at);
  const tag = /<\/?div\b/g;
  tag.lastIndex = open;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html)) !== null) {
    depth += match[0] === "</div" ? -1 : 1;
    if (depth === 0) return html.slice(open, tag.lastIndex);
  }
  throw new Error(`unbalanced markup for ${marker}`);
}

const thought = (value: string): ContentBlock => ({ type: "thinking", thinking: value });

describe("MessageList streaming message", () => {
  it("renders streamed blocks inside the turn they will land in", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("写点东西"), answered([text("第一段")])], {
          partial: [text("第二段")],
          isStreaming: true,
        })}
        cwd={CWD}
        home="/Users/dev"
      />,
    );

    const turn = turnMarkup(html, 1);
    expect(turn).toContain("第一段");
    expect(turn).toContain("第二段");
  });

  it("marks only the streamed tail as running", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("想想"), answered([thought("已经想完的")])], {
          partial: [thought("正在想的")],
          isStreaming: true,
        })}
        cwd={CWD}
        home="/Users/dev"
      />,
    );

    // The settled step keeps its first line; only the live one tracks its tail.
    expect(html.match(/data-state="running"/g)).toHaveLength(1);
    expect(turnMarkup(html, 1)).toContain("正在想的");
  });

  it("folds a live turn's finished steps but keeps the streamed ones open", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("跑一下"), answered([thought("已经想完的")])], {
          partial: [thought("正在想的")],
          isStreaming: true,
        })}
        cwd={CWD}
        home="/Users/dev"
        compactTranscript
      />,
    );

    // The settled process row folded into the group — a collapsed group does not
    // render its children, so its text being absent is what proves the fold.
    expect(html).toContain("执行过程");
    expect(html).not.toContain("已经想完的");
    // The block still arriving stayed an answer, outside the group.
    expect(html).toContain("正在想的");
  });

  it("still renders a streamed message with no turn to attach to", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([], { partial: [text("孤儿输出")], isStreaming: true })}
        cwd={CWD}
        home="/Users/dev"
      />,
    );

    expect(html).toContain("孤儿输出");
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
