import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, AssistantMessage, ContentBlock, ImageBlock } from "../../lib/types.ts";
import { MessageList, retryPromptOf } from "./MessageList.tsx";
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
    undeliveredPrompts: 0,
    toolExecutions: {},
    isStreaming: false,
    loading: false,
    error: null,
    retry: null,
    failedAttempts: 0,
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

/** The message pi persists when a model request fails outright. */
function failed(errorMessage?: string): AssistantMessage {
  return { role: "assistant", content: [], timestamp: 1, stopReason: "error", errorMessage };
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

  it("holds the running turn's card while a prompt is queued behind it", () => {
    // Pressing Enter during a turn shows the follow-up straight away, and the
    // running turn must not look finished because of it: pi has not started the
    // next turn, so the card for this one is still describing work in progress.
    const messages = [asked("第一个"), answered([text("好了"), wrote(`${CWD}/a.ts`)]), asked("第二个")];
    const drawn = (patch: Partial<ConversationView>): string =>
      renderToStaticMarkup(
        <MessageList
          view={view(messages, { isStreaming: true, ...patch })}
          cwd={CWD}
          home="/Users/dev"
          onOpenFile={noop}
        />,
      );

    // The queued prompt opens no turn of its own, so turn 1 is still the live
    // one and its card waits for it — this is the bug being fixed.
    expect(drawn({ undeliveredPrompts: 1 })).not.toContain("data-turn-files");

    // Once pi takes the prompt up, that turn is the live one and turn 1's card
    // lands, files and all. (Same transcript, one turn later.)
    const delivered = drawn({ undeliveredPrompts: 0 });
    expect(delivered).toContain("已编辑 1 个文件");
    expect(delivered).toContain("在右侧栏预览 a.ts");
  });

  it("shows a queued prompt inside the running turn, not as a turn of its own", () => {
    // The bubble is what the user is waiting on, so it is drawn from the first
    // frame; it just does not get to be a turn until pi starts one.
    const html = renderToStaticMarkup(
      <MessageList
        view={view(
          [asked("第一个"), answered([text("好了"), wrote(`${CWD}/a.ts`)]), asked("第二个")],
          { isStreaming: true, undeliveredPrompts: 1 },
        )}
        cwd={CWD}
        home="/Users/dev"
        onOpenFile={noop}
      />,
    );

    expect(html).toContain("第二个");
    expect(html).toContain('data-turn="1"');
    expect(html).not.toContain('data-turn="2"');
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

/**
 * A failed model request has to be visible somewhere, and the row that reports
 * it is read from the transcript rather than from the stream: pi persists the
 * errored assistant message, so the row survives a reload, a session switch and
 * a fresh page. What only the stream can add is the retry count — a session file
 * records that the request failed, never how many times pi tried first.
 */
describe("MessageList model failure", () => {
  const retry = {
    attempt: 1,
    maxAttempts: 3,
    delayMs: 1000,
    errorMessage: "overloaded",
    deadline: Date.now() + 1000,
  };

  it("reports the failure where the answer would have been", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("改一下"), failed("401 invalid api key")])}
        cwd={CWD}
        home="/Users/dev"
      />,
    );

    expect(turnMarkup(html, 1)).toContain("模型请求失败");
    expect(html).toContain("401 invalid api key");
  });

  it("says how many retries preceded it", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("改一下"), failed("overloaded")], { failedAttempts: 3 })}
        cwd={CWD}
        home="/Users/dev"
      />,
    );

    expect(html).toContain("已重试 3 次");
  });

  it("hides a failure the retry loop recovered from", () => {
    // pi drops the errored message from the agent's state but keeps it in the
    // session file, so an errored entry on its own is not a failed turn — only
    // the turn's *last* answer being errored is.
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("改一下"), failed("overloaded"), answered([text("改好了")])])}
        cwd={CWD}
        home="/Users/dev"
      />,
    );

    expect(html).not.toContain("模型请求失败");
    expect(html).toContain("改好了");
  });

  it("does not call a turn failed before it has ended", () => {
    // Mid-retry the transcript already holds the errored message, so the row
    // has to wait for the turn: otherwise it would contradict the retry notice,
    // which is still saying pi is trying again.
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("改一下"), failed("overloaded")], { isStreaming: true, retry })}
        cwd={CWD}
        home="/Users/dev"
      />,
    );

    expect(html).not.toContain("模型请求失败");
    expect(html).toContain("等待重试模型请求");
  });

  it("offers the prompt again", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("改一下"), failed("overloaded")])}
        cwd={CWD}
        home="/Users/dev"
        onRetry={noop}
      />,
    );

    expect(html).toContain(">重试</button>");
  });

  it("reports without an action when there is nobody to send it to", () => {
    const html = renderToStaticMarkup(
      <MessageList
        view={view([asked("改一下"), failed("overloaded")])}
        cwd={CWD}
        home="/Users/dev"
      />,
    );

    expect(html).toContain("模型请求失败");
    expect(html).not.toContain(">重试</button>");
  });

  it("still reports a failure pi gave no reason for", () => {
    // pi stamps `errorMessage` nearly everywhere it stamps `stopReason:
    // "error"`, but the summarizer path does not — and a disclosure that
    // unfolds onto nothing is worse than the bare line.
    const html = renderToStaticMarkup(
      <MessageList view={view([asked("改一下"), failed()])} cwd={CWD} home="/Users/dev" />,
    );

    expect(html).toContain("模型请求失败");
    expect(html).not.toContain("失败原因");
  });
});

describe("retryPromptOf", () => {
  const image: ImageBlock = { type: "image", data: "AAAA", mimeType: "image/png" };

  it("re-sends the turn's own prompt and pictures", () => {
    const payload = retryPromptOf([
      { role: "user", content: [text("看这个"), image], timestamp: 0 },
      failed("overloaded"),
    ]);

    expect(payload).toEqual({ text: "看这个", images: [image] });
  });

  it("has nothing to re-send for a turn with no prompt", () => {
    expect(retryPromptOf([failed("overloaded")])).toBeNull();
  });
});
