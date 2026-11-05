import { Fragment, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  AgentMessage,
  AssistantMessage,
  CompactionSummaryMessage,
  ContentBlock,
  ForkPoint,
  ImageBlock,
  MessageUsage,
  TextBlock,
  ThinkingBlock as ThinkingBlockType,
  ToolCallBlock,
  ToolResultMessage,
  TranscriptDisplay,
  UserMessage,
} from "../../lib/types.ts";
import { isContentBlock } from "../../lib/types.ts";
import { ImageThumb } from "../../components/ImageLightbox.tsx";
import { imageBlocksOf } from "../../lib/image-attachments.ts";
import { Markdown } from "./Markdown.tsx";
import { FileRefProvider, type FileRefDelegate } from "./file-ref-context.tsx";
import { parsePathToken } from "./file-ref.ts";
import { MessageActions } from "./MessageActions.tsx";
import { ThinkingBlock } from "./ThinkingBlock.tsx";
import { TodoRow } from "./TodoRow.tsx";
import { TodoBaselinesProvider } from "./todo-history.tsx";
import { ToolCallRow } from "./ToolCallRow.tsx";
import { QuestionRow } from "./QuestionRow.tsx";
import { TurnProcessGroup } from "./TurnProcessGroup.tsx";
import { ChangedFilesCard } from "./ChangedFilesCard.tsx";
import { turnFiles, type TurnFile } from "./turn-files.ts";
import { resolveTurnRef, turnRefPaths, type TurnRefPath } from "./turn-refs.ts";
import { turnChangesList, type TurnChanges } from "../rightbar/turn-changes-store.ts";
import { RetryNotice } from "./RetryNotice.tsx";
import { CompactionRow, CompactionRunning } from "./CompactionRow.tsx";
import { TurnFailure } from "./TurnFailure.tsx";
import { TurnTruncated } from "./TurnTruncated.tsx";
import { TurnStatus } from "./TurnStatus.tsx";
import { TurnNavigator } from "./TurnNavigator.tsx";
import { processSegmentTitle, splitIntoProcessSegments } from "./row-model.ts";
import { transcriptPolicyFor, type TranscriptPolicy } from "./transcript-policy.ts";
import { StepProcessGroup } from "./StepProcessGroup.tsx";
import { displayUserText, parseSkillCall, skillCommandLabel } from "./skill-block.ts";
import { groupTurns, type RailTurn } from "./turn-rail.ts";
import { turnUsage } from "./stats-model.ts";
import { planDocsOf, type PlanDoc } from "./plan-docs.ts";
import { PlanCard } from "./PlanCard.tsx";
import { textFromContent, type ConversationView, type ToolExecution } from "./useConversation.ts";
import { useDelayedFlag } from "../../lib/use-delayed-flag.ts";
import { Glyph } from "../../components/dsh-icons.tsx";
import styles from "./MessageList.module.css";
import { useT } from "../../lib/app-state.ts";

/** Workspace root and home dir, threaded down so paths can be shortened for display. */
interface PathContext {
  cwd?: string | undefined;
  home?: string | undefined;
}

/** How far below the scrollport top the "currently reading" probe sits. */
const ACTIVE_LINE_MAX_PX = 96;
const ACTIVE_LINE_RATIO = 0.2;
/** Breathing room left above a row when the rail jumps to it. */
const JUMP_TOP_OFFSET_PX = 24;
/** Within this distance of the bottom, new output keeps scrolling into view. */
const STICK_THRESHOLD_PX = 80;
/** Same band dsh uses to decide whether a jump landed at the bottom. */
const AT_BOTTOM_THRESHOLD_PX = 25;
/**
 * How much of a freshly-opened transcript is mounted on the first commit.
 *
 * A session is read whole from disk, but mounting all of it at once makes the
 * browser lay out the entire column synchronously — on an 800-turn fixture that
 * is a ~300ms block, and it lands exactly when the reader clicked a row and is
 * waiting for the conversation. Mounting the tail first keeps that commit small
 * (the reader starts at the bottom anyway) and the rest is mounted in a
 * transition; see the effect that grows the window.
 */
const TAIL_INITIAL_ITEMS = 24;
/**
 * The window once everything is mounted.
 *
 * Infinity rather than the current length so that a turn arriving later from the
 * stream does not put the window back under `flow.length` — otherwise every
 * appended message would schedule another catch-up transition for a list that is
 * already fully mounted.
 */
const TAIL_FULL = Number.POSITIVE_INFINITY;
/** Scroll the transcript this close to the mounted top and the rest mounts now. */
const TOP_BACKFILL_PX = 160;

/** The shared empty vocabulary, so a turn with no files keeps one stable prop value. */
const EMPTY_REF_PATHS: readonly TurnRefPath[] = [];

/** Distance from the bottom edge — the one number every decision here uses. */
function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

/** dsh honours the OS setting for its jumps, and so does this one. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function BlockView({
  block,
  executions,
  results,
  streaming,
  previewSettled,
  defaultOpen,
  cwd,
  home,
}: {
  block: ContentBlock;
  executions: Record<string, ToolExecution>;
  results: Record<string, ToolResultMessage>;
  streaming: boolean;
  /** Whether a settled reasoning row may carry its one-line summary. */
  previewSettled: boolean;
  /** Whether a process row's own body starts open — the verbose display. */
  defaultOpen: boolean;
} & PathContext) {
  if (!isContentBlock(block)) return null;
  if (block.type === "text") {
    const text = (block as TextBlock).text;
    // `streaming` is the whole gate on file chips: a half-written path is not a
    // reference yet, and the vocabulary the finished answer will have is not
    // known while it is still arriving.
    return text.length > 0 ? <Markdown text={text} streaming={streaming} /> : null;
  }
  if (block.type === "thinking") {
    return (
      <ThinkingBlock
        text={(block as ThinkingBlockType).thinking}
        streaming={streaming}
        preview={previewSettled}
        defaultOpen={defaultOpen}
      />
    );
  }
  if (block.type === "toolCall") {
    const call = block as ToolCallBlock;
    const result = results[call.id];
    const execution =
      executions[call.id] ??
      (result
        ? {
            toolName: call.name,
            args: call.arguments,
            output: "",
            result: result.content,
            details: result.details,
            isError: false,
            running: false,
          }
        : undefined);
    // `todo` answers with a whole-list snapshot rather than a body of text, so it
    // gets a list instead of the generic parameters-and-output card; a settled
    // question gets its own answer read back as the card it was answered in.
    if (call.name === "todo") {
      return <TodoRow call={call} execution={execution} defaultOpen={defaultOpen} />;
    }
    if (call.name === "ask_user_question") {
      return (
        <QuestionRow
          call={call}
          execution={execution}
          cwd={cwd}
          home={home}
          defaultOpen={defaultOpen}
        />
      );
    }
    return (
      <ToolCallRow
        call={call}
        execution={execution}
        cwd={cwd}
        home={home}
        defaultOpen={defaultOpen}
      />
    );
  }
  if (block.type === "image") {
    return <ImageThumb image={block as ImageBlock} />;
  }
  return null;
}

/**
 * One content block plus its position inside the turn, so React keys stay stable
 * when compact mode moves the step into a group.
 */
interface TurnStep {
  block: ContentBlock;
  messageIndex: number;
  blockIndex: number;
  /**
   * Part of the message being streamed right now.
   *
   * Such a step is never folded into a compact group, and only the last of them
   * renders as running. Every committed step stays `undefined` even when the
   * turn it belongs to is still live.
   */
  live?: boolean;
  /**
   * The step's tool call is still executing. A committed block carries no
   * `live` flag, so this is what keeps a running turn's group header live even
   * when nothing is streaming at that instant — the tool itself is the work in
   * progress.
   */
  running?: boolean;
  /**
   * The last block of the message being streamed — the only one whose own
   * rendering depends on the stream still being open (the reasoning row tracks
   * its last line while running and its first line once settled).
   */
  tail?: boolean;
}

/**
 * Render one turn's content. In compact mode the turn's process steps collapse
 * into a single group; answers keep their order.
 *
 * The partition happens here, per turn, rather than inside a per-message
 * component: a turn routinely spans a dozen assistant messages (one per tool
 * round-trip), and grouping each of those separately produced a dozen identical
 * "执行过程" rows for a single request.
 */
function TurnBody({
  steps,
  executions,
  results,
  streaming,
  compact,
  stepGrouping,
  liveProcessDetail,
  processDurationMs,
  previewSettled,
  expandProcessRows,
  refPaths = EMPTY_REF_PATHS,
  onOpenFile,
  onImageUrl,
  cwd,
  home,
}: {
  steps: TurnStep[];
  executions: Record<string, ToolExecution>;
  results: Record<string, ToolResultMessage>;
  streaming: boolean;
  /**
   * Collapse this turn's process steps into one group. Both display modes ask
   * for this (dsh's `foldCompletedTurns`), and it only ever takes effect on a
   * turn that already finished: the group's header reports a completion, so
   * folding a turn that is still running (or one that failed) would put a
   * summary on the one turn that has none to give.
   */
  compact: boolean;
  /** dsh's `stepGrouping`: fold a turn's process runs, and for which turns. */
  stepGrouping: TranscriptPolicy["stepGrouping"];
  /** dsh's `liveProcessDetail`: name the live step (tool argument or reasoning tail) in a live group. */
  liveProcessDetail: TranscriptPolicy["liveProcessDetail"];
  /** Wall-clock span of this turn, for the group's header. */
  processDurationMs: number | null;
  /** Whether settled reasoning rows may carry their one-line summary. */
  previewSettled: boolean;
  /** Whether every process row opens its own body — the verbose display. */
  expandProcessRows: boolean;
  /**
   * The files this turn's tool calls named, in first-seen order.
   *
   * Computed by the list rather than here because a turn's vocabulary belongs
   * with the turn's messages, and because `steps` is rebuilt on every render —
   * a provider keyed off it would hand every `Markdown` below a new delegate and
   * undo the memo that keeps a streaming answer from re-parsing itself.
   */
  refPaths?: readonly TurnRefPath[] | undefined;
  /** Open a file the answer points at; absent means references stay text. */
  onOpenFile?: ((path: string, position: { line?: number | undefined; endLine?: number | undefined }) => void) | undefined;
  /** The URL for an image's hover preview; absent means no preview. */
  onImageUrl?: ((path: string) => string | undefined) | undefined;
} & PathContext) {
  const t = useT();

  /**
   * The turn's file vocabulary, as `Markdown` consumes it.
   *
   * `resolve` is the only place a token is allowed to become a file: it spells
   * the token (`parsePathToken`) and then asks the turn's vocabulary which real
   * file that is. A token the turn never named — or one whose basename belongs
   * to two files — resolves to nothing and stays ordinary code, which is dsh's
   * rule and the reason the renderer can safely guess at nothing.
   */
  const fileRefs = useMemo<FileRefDelegate | null>(() => {
    if (onOpenFile === undefined || refPaths.length === 0) return null;
    return {
      resolve(token) {
        const parsed = parsePathToken(token);
        if (parsed === undefined) return undefined;
        const path = resolveTurnRef(refPaths, parsed.path);
        return path === undefined ? undefined : { ...parsed, path };
      },
      open(file) {
        // A link the author wrote as an absolute path still opens the file the
        // turn knows by its project-relative spelling — the same fold
        // `resolve` makes for inline code.
        onOpenFile(resolveTurnRef(refPaths, file.path) ?? file.path, {
          line: file.line,
          endLine: file.endLine,
        });
      },
      ...(onImageUrl === undefined ? {} : { imageUrl: onImageUrl }),
    };
  }, [refPaths, onOpenFile, onImageUrl]);

  /** A turn with no opener (or no files) renders exactly as it did before. */
  const withRefs = (children: ReactNode): ReactNode =>
    fileRefs === null ? children : <FileRefProvider delegate={fileRefs}>{children}</FileRefProvider>;

  const renderStep = (step: TurnStep) => (
    <BlockView
      key={`${String(step.messageIndex)}-${String(step.blockIndex)}`}
      block={step.block}
      executions={executions}
      results={results}
      streaming={streaming && step.tail === true}
      previewSettled={previewSettled}
      defaultOpen={expandProcessRows}
      cwd={cwd}
      home={home}
    />
  );

  // dsh's `stepGrouping`: `collapsed` folds every turn's stretches, `history`
  // only a turn that has already closed, `none` never. A still-streaming turn is
  // the one whose status is open, which is exactly what `streaming` reports.
  const grouped = stepGrouping === "collapsed" || (stepGrouping === "history" && !streaming);

  const segments = splitIntoProcessSegments(steps);

  const renderProcess = (segmentSteps: TurnStep[], index: number) => {
    const rows = segmentSteps.map((step) => renderStep(step));
    if (!grouped) return rows;
    // dsh closes a stretch only at a reply or the end of the turn, so the last
    // stretch of a running turn stays live even after its tool has finished:
    // its header keeps naming the work in the present tense ("正在读取文件")
    // rather than reporting it as finished while the turn is still in it.
    const open = streaming && index === segments.length - 1;
    const heading = processSegmentTitle(segmentSteps, t, open);
    // dsh shows the live step's detail only in the modes that ask for it, and
    // only while the group is live: a finished group's title summarises what
    // happened, it is not a snapshot of one call. The detail is the running
    // tool's argument or a reasoning block's streaming tail, whichever step the
    // group is on — matching what its rows show when expanded.
    const detail =
      liveProcessDetail && heading.running && heading.detail !== undefined
        ? `${t("message.stepProcess.separator")}${heading.detail}`
        : "";
    return (
      <StepProcessGroup
        key={`group-${String(index)}`}
        title={`${heading.title}${detail}`}
        activity={heading.activity}
        running={heading.running}
      >
        {rows}
      </StepProcessGroup>
    );
  };

  if (!compact) {
    return withRefs(
      <div className={styles.assistantTurn}>
        {segments.map((segment, index) => (
          <Fragment key={`segment-${String(index)}`}>
            {segment.kind === "process"
              ? renderProcess(segment.steps, index)
              : segment.steps.map((step) => renderStep(step))}
          </Fragment>
        ))}
      </div>,
    );
  }

  // A folded turn gathers every process run into the one whole-turn group and
  // keeps the answers after it, in order. The runs stay distinct inside it, so
  // the fold reads as "this was the work, that is the reply" at both levels.
  const processSegments: TurnStep[][] = [];
  const answerSteps: TurnStep[] = [];
  for (const segment of segments) {
    if (segment.kind === "process") processSegments.push(segment.steps);
    else answerSteps.push(...segment.steps);
  }
  return withRefs(
    <div className={styles.assistantTurn}>
      {processSegments.length > 0 ? (
        <TurnProcessGroup durationMs={processDurationMs}>
          {processSegments.map((segmentSteps, index) => renderProcess(segmentSteps, index))}
        </TurnProcessGroup>
      ) : null}
      {answerSteps.map((step, index) => (
        // The wrapper exists only to carry dsh's `data-turn-process-answer`
        // flag: it is what tells the flow gap to tighten to 8px for the answer
        // that ends the group above it.
        <div
          key={`${String(step.messageIndex)}-${String(step.blockIndex)}`}
          data-turn-process-answer={index === 0 || undefined}
        >
          {renderStep(step)}
        </div>
      ))}
    </div>,
  );
}

/**
 * The copyable text of a turn's answer: every answer block, joined.
 *
 * Thinking and tool calls are left out — they are process, not the reply, and
 * pasting them alongside the answer is never what "copy this response" means.
 */
function assistantTextOf(messages: AgentMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => (message as AssistantMessage).content ?? [])
    .filter(isContentBlock)
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

/**
 * The failed model request that ended a turn, if that is how it ended.
 *
 * Only the turn's *last* assistant message counts. pi keeps a failed message in
 * the session file even when the retry that followed it recovered the turn
 * ("Remove error message from agent state (keep in session for history)"), so
 * the presence of an errored message says an attempt failed, not that the turn
 * did — and a transcript read from disk cannot tell the two apart any other
 * way. `stopReason` is the whole test; the reason text is what pi put on the
 * message.
 */
function failedAnswerOf(messages: readonly AgentMessage[]): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "assistant") continue;
    const assistant = message as AssistantMessage;
    return assistant.stopReason === "error" ? assistant : null;
  }
  return null;
}

/**
 * The answer pi stopped at the output-token cap, if that is how the turn ended.
 *
 * Same shape as `failedAnswerOf`: only the turn's *last* assistant message
 * counts, because pi stamps `stopReason: "length"` on the message it truncated —
 * an earlier `length` message inside the turn was a mid-turn step, and the turn
 * carried on past it.
 */
function truncatedAnswerOf(messages: readonly AgentMessage[]): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "assistant") continue;
    const assistant = message as AssistantMessage;
    return assistant.stopReason === "length" ? assistant : null;
  }
  return null;
}

/**
 * What re-sending a failed turn actually sends: the prompt that opened it, with
 * the pictures it carried. Null when the turn has no prompt to re-send — pi can
 * fail a run that a queued message or a fork started, and a turn with no user
 * message has nothing to repeat.
 */
export function retryPromptOf(
  messages: readonly AgentMessage[],
): { text: string; images: ImageBlock[] } | null {
  const prompt = messages.find((message): message is UserMessage => message.role === "user");
  if (prompt === undefined) return null;
  return { text: textFromContent(prompt.content), images: imageBlocksOf(prompt.content) };
}

/**
 * One user turn: its pictures first, then its text.
 *
 * The content arrives exactly as pi stored it — a plain string for an ordinary
 * message, a block array once something was attached to it. The text is still
 * pulled back out of the blocks, because a bubble is one paragraph plus whatever
 * was pasted into it, and the skill-command fold only ever applies to the text.
 */
function UserTurn({ content }: { content: string | ContentBlock[] }) {
  const t = useT();
  const text = textFromContent(content);
  const images = imageBlocksOf(content);
  const skill = parseSkillCall(text);
  return (
    <div className={styles.userTurn}>
      <div className={styles.userBubble} data-images={images.length > 0 || undefined}>
        {images.length > 0 ? (
          <div className={styles.userImages}>
            {/* Index keys: the list is append-only and never reordered, so the
                position *is* the identity — and two identical screenshots of
                two different states must both stay rendered. */}
            {images.map((image, index) => (
              <ImageThumb
                key={index}
                image={image}
                variant="user"
                alt={t("attach.alt", { index: index + 1 })}
              />
            ))}
          </div>
        ) : null}
        {text.length > 0 ? (
          <div className={styles.userText}>
            {skill === null
              ? text
              : // The chip is inline so a command with arguments still reads as one
                // line, the way dsh draws it. `title` carries where the body came
                // from — on an expanded call only; a command the optimistic turn
                // still holds has no location to show yet.
                (
                  <>
                    <span className={styles.skillChip} title={skill.location}>
                      {/* dsh's own skill glyph; the chip is otherwise text-only. */}
                      <Glyph name="skill" size={14} className={styles.skillIcon} />
                      {skillCommandLabel(skill.name)}
                    </span>
                    {skill.userMessage === undefined ? null : ` ${skill.userMessage}`}
                  </>
                )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** What one turn shows under its content: cost, elapsed time, fork target. */
interface TurnMeta {
  forkEntryId: string | null;
  usage: MessageUsage | null;
  /** `provider/model` of the turn's own model calls, or null. */
  model: string | null;
  durationMs: number | null;
  /** Start of the turn, used for the timestamp label. */
  startedAt: number | null;
  endedAt: number | null;
}

function timestampOf(message: AgentMessage): number | null {
  const value = (message as { timestamp?: unknown }).timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Whether a turn ends in something the reader can read — dsh's
 * `endsWithResponse`.
 *
 * Only such a turn keeps its action row visible at the end of the transcript.
 * The last message must be an assistant one (a turn that ended on a tool result
 * has not answered yet), and the last of its blocks that is neither reasoning
 * nor a blank placeholder decides: reply text or another kind of block the
 * reader was shown (an image) is an answer, a trailing tool call is not.
 */
function endsWithReply(messages: AgentMessage[]): boolean {
  const last = messages.at(-1);
  if (last === undefined || last.role !== "assistant") return false;

  const content = (last as AssistantMessage).content;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!isContentBlock(block)) continue;
    // Reasoning is not the answer, and a blank text block is a streaming
    // placeholder: neither decides, so keep looking backwards.
    if (block.type === "thinking") continue;
    if (block.type === "text") {
      if ((block as TextBlock).text.trim() !== "") return true;
      continue;
    }
    return block.type !== "toolCall";
  }
  return false;
}

/**
 * Per-turn metadata, keyed by turn number.
 *
 * The fork targets are matched by position across the user messages of the
 * transcript, with the text compared as a guard: server and client walk the
 * same entries, so a mismatch means the two views have diverged and the safer
 * answer is to offer no fork at all rather than fork at the wrong message.
 */
function turnMetadata(
  groups: ReturnType<typeof groupTurns>,
  forkPoints: ForkPoint[],
): Map<number, TurnMeta> {
  const out = new Map<number, TurnMeta>();
  let userIndex = 0;

  for (const group of groups) {
    const user = group.messages.find((message) => message.role === "user");
    const assistants = group.messages.filter((message) => message.role === "assistant");

    let forkEntryId: string | null = null;
    if (user !== undefined) {
      const point = forkPoints[userIndex];
      userIndex += 1;
      if (point !== undefined && point.text === textFromContent((user as UserMessage).content)) {
        forkEntryId = point.entryId;
      }
    }

    // A turn's usage is the sum of its model calls, bucket by bucket: the
    // turn-usage panel reads all four, and a summed `totalTokens` with zeroed
    // buckets behind it renders as a panel claiming nothing was ever billed.
    // The model the turn ran on is read off the same messages, because pi can
    // switch models between turns and the panel sits under this turn's figure.
    let model: string | null = null;
    for (const message of assistants) {
      const assistant = message as AssistantMessage;
      if (assistant.provider !== undefined && assistant.model !== undefined) {
        model = `${assistant.provider}/${assistant.model}`;
      }
    }

    // Wall-clock span of the turn. The last message's stamp is when it was
    // written for tool results, and when its generation began for a final
    // assistant message; either way this is elapsed time, not model time.
    const stamps = group.messages.map(timestampOf).filter((x): x is number => x !== null);
    const startedAt = stamps.length > 0 ? Math.min(...stamps) : null;
    const endedAt = stamps.length > 0 ? Math.max(...stamps) : null;

    out.set(group.turn, {
      forkEntryId,
      usage: turnUsage(assistants),
      model,
      durationMs:
        startedAt !== null && endedAt !== null && endedAt > startedAt ? endedAt - startedAt : null,
      startedAt,
      endedAt,
    });
  }

  return out;
}

/**
 * The turn owning the row at a probe line measured from the scrollport top.
 *
 * Rows are direct siblings in one column, so their `top` values increase with
 * document order and the answer is the last row at or above the line. A plain
 * forward scan finds it but reads a `getBoundingClientRect` for every row above
 * the line — which is all of them for a reader sitting at the bottom of a long
 * transcript, exactly the moment a session switch lands, and the forced layout
 * that comes with the first read then has to measure the whole freshly-mounted
 * column. Binary search asks the same question in O(log n) reads: ~11 instead
 * of ~1600 on a 800-turn transcript, and the same on every scroll frame.
 */
function turnAtLine(list: HTMLElement, line: number): number | null {
  const rows = list.querySelectorAll<HTMLElement>("[data-turn]");
  let low = 0;
  let high = rows.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (rows[mid]!.getBoundingClientRect().top <= line) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found < 0) return null;
  const turn = Number(rows[found]!.dataset.turn);
  return Number.isSafeInteger(turn) ? turn : null;
}

export function MessageList({
  view,
  sessionPath,
  cwd,
  home,
  transcriptView = "detailed",
  onFork,
  onOpenChanges,
  onOpenFile,
  onImageUrl,
  onTurnChanges,
  onOpenPlan,
  onPlans,
  onRetry,
}: {
  view: ConversationView;
  /**
   * The session this transcript belongs to. Used only to reset the mounted-tail
   * window when the reader switches sessions; the messages themselves come from
   * `view`.
   */
  sessionPath?: string | null;
  /** Work-details presentation mode; see `transcript-policy.ts`. */
  transcriptView?: TranscriptDisplay;
  /** Fork the session at a user message. Absent means the action is not shown. */
  onFork?: (entryId: string) => void;
  /**
   * Review a turn's changes in the right sidebar, opening on one file. Absent
   * means a turn's changed-files card lists its rows without making them
   * clickable.
   */
  onOpenChanges?: (turn: number, index: number) => void;
  /**
   * Open a file an answer points at — a path in a link or in inline code that
   * this turn's tool calls named — in the right sidebar, at the lines the
   * reference asked for. Absent means references stay ordinary text, which is
   * what the transcript does whenever it cannot address the panel.
   */
  onOpenFile?:
    | ((path: string, position: { line?: number | undefined; endLine?: number | undefined }) => void)
    | undefined;
  /**
   * The URL showing one path as a picture, for the hover preview on an image
   * reference. Absent means references never preview — the decision about what
   * counts as an image is the caller's, not the transcript's.
   */
  onImageUrl?: ((path: string) => string | undefined) | undefined;
  /**
   * Publish every turn's changed files for the sidebar's review tab to read.
   * Absent means the review tab has nothing to draw — its data lives nowhere
   * else, because this project keeps no workspace snapshot to ask a server for.
   */
  onTurnChanges?: (changes: readonly TurnChanges[]) => void;
  /**
   * Open one submitted plan in the right sidebar. Absent means a plan card
   * shows the document it recorded without offering the action.
   */
  onOpenPlan?: (plan: PlanDoc) => void;
  /**
   * Publish every plan this session submitted, for the sidebar's plan tab to
   * read. Absent means that tab has nothing to draw — the documents live in
   * `exit_plan_mode`'s calls, and only this component holds the transcript.
   */
  onPlans?: (plans: readonly PlanDoc[]) => void;
  /**
   * Send a failed turn's prompt again, with the pictures it carried. Absent
   * means the failure row reports without offering the action.
   */
  onRetry?: (text: string, images: ImageBlock[]) => void;
} & PathContext) {
  const t = useT();
  const {
    foldCompletedTurns,
    stepGrouping,
    liveProcessDetail,
    settledReasoningPreview,
    expandProcessRows,
  } = transcriptPolicyFor(transcriptView);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The message column, watched so that a fold or an image load — anything that
  // resizes the transcript without touching `view.messages` — still puts a
  // following reader back on the floor.
  const columnRef = useRef<HTMLDivElement>(null);
  // Follow new output only while the user is already at the bottom.
  const stickRef = useRef(true);
  /**
   * The send this transcript has already acted on; see `ConversationView.sentAt`.
   *
   * Seeded with whatever the first render carries, so mounting the list — or
   * switching to a session whose number is stale by design — is not mistaken for
   * a send of its own.
   */
  const sentAtRef = useRef(view.sentAt);
  /**
   * The same answer as `stickRef`, in the one form that can put a button on
   * screen. `applyPinned` is the only writer, so the two cannot disagree.
   */
  const [pinned, setPinned] = useState(true);
  /** A smooth jump is in flight; see `onScroll` for what that suppresses. */
  const jumpingRef = useRef(false);
  /** Previous offset, for telling a jump apart from a reader going back up. */
  const lastTopRef = useRef(0);
  // A disk-backed switch finishes in ~100ms, so the hint only appears if the
  // load is genuinely slow.
  const showLoading = useDelayedFlag(view.loading);
  /** How many trailing flow items (turns and checkpoints) are mounted. */
  const [tailCount, setTailCount] = useState(TAIL_INITIAL_ITEMS);
  /** Column height captured before a prepend, for the scroll compensation. */
  const prependHeightRef = useRef<number | null>(null);
  /** A rail jump to a turn that was not mounted yet; finished once it is. */
  const pendingJumpTurnRef = useRef<number | null>(null);
  /** Read by `onScroll`, which is deliberately not re-created per render. */
  const windowedRef = useRef(false);

  const applyPinned = useCallback((value: boolean): void => {
    stickRef.current = value;
    // React bails out when a state update would not change the value, so the
    // scroll handler can call this on every event for free.
    setPinned(value);
  }, []);

  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const [bandHeight, setBandHeight] = useState<number | null>(null);
  const frameRef = useRef<number | null>(null);

  /**
   * Every tool result in the stream, keyed by the call it answers.
   *
   * The whole result, not just its content: the todo row reads `details` (its
   * snapshot), the generic row reads `content`, and a turn's changed-files card
   * reads `details.patch` for the line counts it prints and the comparison it
   * previews. Declared above `turnFilesByTurn` because that is its first reader.
   */
  const results = useMemo(() => {
    const map: Record<string, ToolResultMessage> = {};
    for (const message of view.messages) {
      if (message.role === "toolResult") {
        const toolResult = message as ToolResultMessage;
        map[toolResult.toolCallId] = toolResult;
      }
    }
    return map;
  }, [view.messages]);

  const railItems = useMemo(
    // A steer or follow-up the composer has shown but pi has not picked up yet
    // does not open a turn, so the turn being produced stays the last one — and
    // stays `liveTurn` below while its own files are still being written.
    () => groupTurns(view.messages, view.undeliveredPrompts),
    [view.messages, view.undeliveredPrompts],
  );
  /**
   * The transcript as a flow: turns interleaved with the compaction checkpoints
   * that sit between them.
   *
   * This is a merge rather than a filter because a checkpoint's position *is*
   * its position among the messages, and the two positions it can have mean two
   * different things. A session read from disk starts with one — pi's context
   * begins at the cut, so the turns it folded are simply not in the data — while
   * a compaction that happens while the reader is watching lands at the tail,
   * with everything it folded still on screen above it. Drawing every checkpoint
   * at the top would put that second one off-screen the moment it became the
   * thing the reader most needed to see.
   */
  const flow = useMemo(() => {
    const order = new Map<AgentMessage, number>();
    const checkpoints: { at: number; message: CompactionSummaryMessage }[] = [];
    view.messages.forEach((message, at) => {
      order.set(message, at);
      if (message.role === "compactionSummary") {
        checkpoints.push({ at, message: message as CompactionSummaryMessage });
      }
    });

    type Item =
      | { kind: "turn"; group: RailTurn }
      | { kind: "checkpoint"; at: number; message: CompactionSummaryMessage };

    const items: Item[] = [];
    let next = 0;
    for (const group of railItems) {
      // A turn's anchor is the index of the message that opens it; `groupTurns`
      // walks the same list in the same order, so the anchors increase.
      const first = group.messages[0];
      const anchor = first === undefined ? Number.MAX_SAFE_INTEGER : (order.get(first) ?? 0);
      while (next < checkpoints.length && checkpoints[next]!.at < anchor) {
        items.push({ kind: "checkpoint", ...checkpoints[next]! });
        next += 1;
      }
      items.push({ kind: "turn", group });
    }
    while (next < checkpoints.length) {
      items.push({ kind: "checkpoint", ...checkpoints[next]! });
      next += 1;
    }
    return items;
  }, [view.messages, railItems]);

  /** Whether the transcript holds a compaction checkpoint of its own. */
  const hasCheckpoint = flow.some((item) => item.kind === "checkpoint");

  /**
   * The mounted window: the last `tailCount` items of the flow.
   *
   * Counted from the tail rather than held as a start index so that a turn
   * arriving from the stream is always inside the window — a growing list does
   * not move the window off the end.
   */
  const windowStart = Math.max(0, flow.length - tailCount);
  const visibleFlow = windowStart === 0 ? flow : flow.slice(windowStart);
  windowedRef.current = windowStart > 0;

  // A new session starts at the tail again. The reset is keyed on the path, not
  // on the message list: a stream grows the list continuously and must not send
  // the window back to the top mid-answer.
  useEffect(() => {
    setTailCount(TAIL_INITIAL_ITEMS);
  }, [sessionPath]);

  /**
   * Mount the rest of the transcript once the tail is on screen.
   *
   * A transition, not a chain of chunks: the remaining turns are one O(n) render
   * that React can interrupt between fibers, so the work is spread across frames
   * without the quadratic re-render of re-mounting a few rows at a time (each of
   * those re-rendered everything already mounted). The compensation below keeps
   * a reader who has scrolled away where they were.
   */
  useEffect(() => {
    if (tailCount >= flow.length) return;
    startTransition(() => {
      prependHeightRef.current = scrollRef.current?.scrollHeight ?? null;
      setTailCount(TAIL_FULL);
    });
  }, [tailCount, flow.length]);

  /**
   * Keep a reader who is not following the tail where they were when earlier
   * turns are mounted above them. A pinned reader is left to the ResizeObserver,
   * which puts it back at the bottom instead.
   */
  useLayoutEffect(() => {
    const before = prependHeightRef.current;
    prependHeightRef.current = null;
    const scroller = scrollRef.current;
    if (before === null || scroller === null || stickRef.current) return;
    const grown = scroller.scrollHeight - before;
    if (grown > 0) scroller.scrollTop += grown;
  }, [tailCount]);

  /**
   * Each turn's written files, keyed by turn number.
   *
   * Derived from the same message list the turns were cut from, so a turn's card
   * cannot describe a different set of messages than the rows above it — and from
   * the same results map the tool rows read, so the counts a card prints come from
   * pi's own patches rather than from a second guess at what the calls did. Turns
   * that wrote nothing are left out rather than mapped to an empty list.
   */
  const turnFilesByTurn = useMemo(() => {
    const map = new Map<number, TurnFile[]>();
    for (const group of railItems) {
      const files = turnFiles(group.messages, { cwd, home }, results);
      if (files.length > 0) map.set(group.turn, files);
    }
    return map;
  }, [railItems, cwd, home, results]);

  /**
   * The files each turn named, keyed the same way as its changed files.
   *
   * Built from committed messages only, and deliberately: the vocabulary a chip
   * resolves against is what the turn *said*, and while the answer streams there
   * is nothing to resolve against anyway (chips are gated on `streaming`).
   * Leaving the live tail out of the scan is what keeps this map identified by
   * `railItems` — the same identity across every token of a stream — so the
   * delegate handed to `Markdown` does not change mid-answer.
   */
  const refPathsByTurn = useMemo(() => {
    const map = new Map<number, TurnRefPath[]>();
    for (const group of railItems) {
      const blocks = group.messages.flatMap((message) =>
        message.role === "assistant" ? ((message as AssistantMessage).content ?? []) : [],
      );
      const paths = turnRefPaths(blocks, { cwd }, results);
      if (paths.length > 0) map.set(group.turn, paths);
    }
    return map;
  }, [railItems, cwd, results]);
  /**
   * Hand the sidebar what it cannot compute.
   *
   * A review tab is addressed by session and turn, and the turns live here — the
   * conversation pane is the only component holding the message list. Publishing
   * from the projection that was just built (rather than rescanning for the
   * sidebar) is what keeps the card and the tab showing the same numbers.
   */
  useEffect(() => {
    if (onTurnChanges === undefined) return;
    onTurnChanges(turnChangesList(turnFilesByTurn));
  }, [turnFilesByTurn, onTurnChanges]);

  /**
   * The plans each turn submitted, keyed the same way as its changed files.
   *
   * A turn can submit more than one plan — the first may be sent back — and all
   * of them keep their cards: what a card records is that a plan was submitted,
   * which is true whether or not it was approved (dsh keeps them for the same
   * reason).
   */
  const plansByTurn = useMemo(() => {
    const map = new Map<number, PlanDoc[]>();
    for (const group of railItems) {
      const plans = planDocsOf(group.messages);
      if (plans.length > 0) map.set(group.turn, plans);
    }
    return map;
  }, [railItems]);

  // Hand the sidebar the documents it cannot compute, ascending by turn so a
  // restored tab's lookup cannot depend on the order the map was built in.
  useEffect(() => {
    if (onPlans === undefined) return;
    onPlans([...plansByTurn].sort(([left], [right]) => left - right).flatMap(([, plans]) => plans));
  }, [plansByTurn, onPlans]);

  const turnMeta = useMemo(
    () => turnMetadata(railItems, view.forkPoints),
    [railItems, view.forkPoints],
  );

  const syncActiveTurn = useCallback((): void => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const line = Math.min(ACTIVE_LINE_MAX_PX, scroller.clientHeight * ACTIVE_LINE_RATIO);
    const reading = turnAtLine(scroller, scroller.getBoundingClientRect().top + line);
    setActiveTurn((current) => (current === reading ? current : reading));
  }, []);

  // Scrolling fires far faster than the rail needs to update.
  const scheduleActiveTurn = useCallback((): void => {
    if (frameRef.current !== null) return;
    if (typeof requestAnimationFrame === "undefined") {
      syncActiveTurn();
      return;
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      syncActiveTurn();
    });
  }, [syncActiveTurn]);

  useEffect(
    () => () => {
      if (frameRef.current !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(frameRef.current);
      }
      // Reset unconditionally. Leaving the stale id here blocks every later
      // schedule, because `pending !== null` reads as "a frame is already
      // queued" — and that frame was just cancelled. StrictMode's double mount
      // hits this on the very first render, which leaves the rail permanently
      // un-synced.
      frameRef.current = null;
    },
    [],
  );

  // The rail centres itself in the visible transcript area, so it needs the real
  // height rather than a viewport guess.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setBandHeight(scroller.clientHeight));
    observer.observe(scroller);
    setBandHeight(scroller.clientHeight);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    scheduleActiveTurn();
  }, [scheduleActiveTurn, railItems.length]);

  /**
   * Keep the pinned reader at the bottom, before the browser paints.
   *
   * This is a layout effect on purpose: streamed output grows the transcript
   * several times a second, and an effect that runs after paint shows that
   * growth for one frame with the old scroll offset — the whole column visibly
   * jumps up and then snaps back, on every delta. Scrolling inside the commit
   * that added the content means the reader only ever sees the settled frame.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (stickRef.current) {
      element.scrollTop = element.scrollHeight;
      return;
    }
    // Not following — but the content can still move the reader. Switching to a
    // session shorter than the scrollport leaves the viewport parked at the
    // bottom, and the button that was on screen a moment ago now points at
    // nothing. Measuring here reaches the same answer the scroll handler would,
    // so the ask and the button cannot drift apart.
    applyPinned(distanceFromBottom(element) < STICK_THRESHOLD_PX);
  }, [view.messages, view.partial, applyPinned]);

  /**
   * A send puts the reader back on the floor.
   *
   * The composer is docked at the bottom of the window, so sending while
   * scrolled up in the transcript — reading an older answer, then deciding to
   * say something — would otherwise leave the reader's own message below the
   * fold and the answer streaming where they cannot see it. `sentAt` is the one
   * signal that says *this* browser sent it: a message pi recorded from the
   * terminal, or a row that arrives on a reload, grows `messages` without
   * changing it, and a reader who is reading is not dragged down by someone
   * else's message.
   *
   * Following resumes with it, and following means being at the bottom in this
   * same commit — a layout effect, so the reader's own message is never painted
   * below the fold — rather than the jump button's smooth glide: they asked for
   * the answer, not for a tour of the transcript they just left.
   */
  useLayoutEffect(() => {
    if (view.sentAt === sentAtRef.current) return;
    sentAtRef.current = view.sentAt;
    const element = scrollRef.current;
    if (element === null) return;
    applyPinned(true);
    element.scrollTop = element.scrollHeight;
  }, [view.sentAt, applyPinned]);

  /**
   * The same correction, for every change that is not a message.
   *
   * The layout effect above is keyed on `view.messages` and `view.partial`,
   * which is all a stream touches — but plenty of things resize the transcript
   * without going near either: folding a finished turn's process group (that
   * alone is hundreds of pixels), opening one tool row, a picture in a bubble
   * finishing its load, the content font size changing in settings, the todo or
   * question panel growing the composer stack under the scrollport, the window
   * being dragged smaller. Each of them moves the bottom of the transcript away
   * from a reader who was sitting on it, and nothing brings them back: the
   * action row carrying the turn's cost and duration slides below the fold while
   * `pinned` still says true, so the jump-to-bottom button stays hidden and the
   * only way down is to scroll by hand. It reads as the row drifting out of the
   * bottom of the window for no reason.
   *
   * dsh splits this exact responsibility the same way: one `ResizeObserver` over
   * the message column, the scrollport and the composer, and a `resize` handler
   * whose whole body is "if the reader is following the tail, follow it again"
   * (`ChatViewport.attach` → `use-chat-scroll` → `ChatReading.onResize`).
   *
   * Both boxes are watched. The scrollport covers a composer stack that changed
   * height; the column covers the transcript itself, since its own height is
   * what a fold or an image load moves. A box change must not move a reader who
   * is *not* following, so that branch only re-reads the distance — the same
   * check the scroll handler makes, so the follow state and the button cannot
   * disagree.
   */
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) {
        scroller.scrollTop = scroller.scrollHeight;
        return;
      }
      applyPinned(distanceFromBottom(scroller) < STICK_THRESHOLD_PX);
    });
    observer.observe(scroller);
    const column = columnRef.current;
    if (column !== null) observer.observe(column);
    return () => observer.disconnect();
  }, [applyPinned]);

  /**
   * What actually ends a jump.
   *
   * `scrollend` is the browser saying the scroll is over: it fires for a smooth
   * scroll that a wheel interrupted, and for one that gave up because the bottom
   * moved while it was on its way (a streaming turn grows the transcript faster
   * than the animation closes the gap). No sequence of offsets says either of
   * those things — they just stop.
   */
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const end = (): void => {
      jumpingRef.current = false;
    };
    element.addEventListener("scrollend", end);
    return () => element.removeEventListener("scrollend", end);
  }, []);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = distanceFromBottom(element);

    // Reading upward has run out of mounted transcript. Mount the rest now
    // rather than let the reader hit a wall: they asked to go there, so the
    // idle catch-up is not the right owner of this decision. The captured
    // height lets the prepend compensation keep their place when it lands.
    if (windowedRef.current && element.scrollTop < TOP_BACKFILL_PX) {
      prependHeightRef.current = element.scrollHeight;
      setTailCount(TAIL_FULL);
    }

    if (jumpingRef.current) {
      // A jump passes through every offset on the way down. Judging "pinned"
      // from those would put the button back on screen mid-flight and unpin the
      // follow — the reader asked to end up at the bottom, not to be abandoned
      // halfway there. Both checks below are the fallback for a browser without
      // `scrollend`: landing, or moving backwards because a wheel or the
      // scrollbar took over.
      if (distance <= AT_BOTTOM_THRESHOLD_PX || element.scrollTop < lastTopRef.current) {
        jumpingRef.current = false;
      }
    }
    // Still in flight: the pin is whatever the jump decided. Ended — here, or
    // by `scrollend` before this event — means this offset is a real one, and
    // the very event that ended it is the one that has to judge it: a reader
    // who wheels away mid-jump ends the jump and leaves the button needed in
    // the same gesture.
    if (!jumpingRef.current) applyPinned(distance < STICK_THRESHOLD_PX);

    lastTopRef.current = element.scrollTop;
    scheduleActiveTurn();
  };

  /**
   * The jump button's action: go to the end, and keep going.
   *
   * Pinned before the scroll rather than after it, because arriving is not the
   * point. A turn that streams its next delta mid-animation would otherwise find
   * the reader unpinned and leave them wherever the animation happened to be —
   * the one thing they just asked not to happen.
   */
  const jumpToBottom = (): void => {
    const element = scrollRef.current;
    if (element === null) return;
    applyPinned(true);
    jumpingRef.current = true;
    lastTopRef.current = element.scrollTop;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  /**
   * Scroll a turn's row to just below the top of the scrollport, if it is
   * mounted. Returns false when the row is outside the mounted window.
   *
   * `scrollTop +=` rather than `scrollIntoView`, because `scrollIntoView` cannot
   * leave a fixed offset above the row and would put the anchor flush against
   * the pane edge.
   */
  const landOnTurn = useCallback(
    (turn: number): boolean => {
      const scroller = scrollRef.current;
      if (scroller === null) return false;
      const row = scroller.querySelector<HTMLElement>(`[data-turn="${String(turn)}"]`);
      if (row === null) return false;
      const rowTop = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += rowTop - JUMP_TOP_OFFSET_PX;
      // Landing at the end should resume following; landing mid-transcript must
      // not, or the next streaming delta would yank the reader back down.
      applyPinned(distanceFromBottom(scroller) <= AT_BOTTOM_THRESHOLD_PX);
      setActiveTurn(turn);
      return true;
    },
    [applyPinned],
  );

  /**
   * The rail's jump. A turn above the mounted window has to be mounted first,
   * then the jump is finished by the effect below — the reader asked to go
   * there, so the window grows to include it immediately rather than waiting on
   * the background catch-up.
   */
  const navigateToTurn = useCallback(
    (turn: number): void => {
      if (landOnTurn(turn)) return;
      const index = flow.findIndex((item) => item.kind === "turn" && item.group.turn === turn);
      if (index < 0) return;
      pendingJumpTurnRef.current = turn;
      setTailCount((count) => Math.max(count, flow.length - index));
    },
    [landOnTurn, flow],
  );

  useLayoutEffect(() => {
    const turn = pendingJumpTurnRef.current;
    if (turn === null) return;
    if (landOnTurn(turn)) pendingJumpTurnRef.current = null;
  }, [tailCount, landOnTurn]);

  const partial = view.partial;
  let lastPartialIndex = -1;
  partial?.forEach((block, index) => {
    if (isContentBlock(block)) lastPartialIndex = index;
  });
  const hasPartial = lastPartialIndex >= 0;
  const lastTurn = railItems.at(-1)?.turn ?? null;
  /**
   * The turn still being produced. Its rail mark pulses, and its changed-files
   * card is held back: a card describes a whole turn, and dsh only draws it once
   * the turn is over — landing it mid-turn would grow the row count under the
   * reader with every round-trip that writes another file.
   *
   * A prompt pi has queued behind this turn is already in the transcript but
   * does not start a turn of its own yet (see `groupTurns`), which is what keeps
   * this pointing at the turn that is actually running.
   */
  const liveTurn = view.isStreaming ? lastTurn : null;
  /**
   * Whether the streaming blocks can be rendered inside the live turn's row.
   *
   * They always can when there is a live turn: pi appends the committed
   * assistant message to the end of the transcript, so the partial's slot in
   * the *last* turn is exactly the slot the message will occupy once
   * `message_end` lands. The turn rendering below relies on that and appends the
   * partial with the index the real message is about to get.
   */
  const partialMerged = hasPartial && liveTurn !== null;

  return (
    // data-conversation-scroll marks the scrollport for the width strips'
    // wheel bridge (dsh's same-named contract).
    <div className={styles.scroll} ref={scrollRef} data-conversation-scroll onScroll={onScroll}>
      <TurnNavigator
        items={railItems}
        activeTurn={activeTurn}
        busyTurn={liveTurn}
        bandHeight={bandHeight}
        onNavigate={navigateToTurn}
      />

      <div className={styles.column} ref={columnRef}>
        {/* The baseline each todo row diffs against — one scan of the transcript
            here, instead of every row walking it again. */}
        <TodoBaselinesProvider messages={view.messages}>
        {showLoading ? <p className={styles.hint}>{t("message.loading")}</p> : null}

        {/* A checkpoint alone is not an empty session: it is what the context
            starts with, and the row below says so. */}
        {!view.loading && railItems.length === 0 && !hasCheckpoint && !hasPartial ? (
          <p className={styles.hint}>{t("message.empty")}</p>
        ) : null}

        {visibleFlow.map((item) => {
          // The cut, drawn where it sits among the turns: a checkpoint pi
          // replayed lands first (the context begins there), the one a live
          // compaction just made lands last, under everything it folded.
          if (item.kind === "checkpoint") {
            return (
              <CompactionRow
                key={`compaction-${String(item.at)}`}
                summary={item.message.summary}
                tokensBefore={item.message.tokensBefore}
                timestamp={item.message.timestamp}
              />
            );
          }
          const group = item.group;
          // Flatten the turn's assistant content so compact mode can group the
          // *turn's* process steps. A turn spans one assistant message per tool
          // round-trip, so grouping per message produced a group per round-trip.
          const steps: TurnStep[] = [];
          group.messages.forEach((message, messageIndex) => {
            if (message.role === "user") return;
            const content = (message as AssistantMessage).content ?? [];
            content.forEach((block, blockIndex) => {
              if (!isContentBlock(block)) return;
              // A committed tool call carries no `live` flag, so a turn whose
              // current work is a tool — nothing streaming right now — would
              // otherwise read as settled. The execution's own running state is
              // what keeps the group's header live.
              const running =
                block.type === "toolCall" &&
                view.toolExecutions[(block as ToolCallBlock).id]?.running === true;
              steps.push({ block, messageIndex, blockIndex, ...(running ? { running: true } : {}) });
            });
          });

          /**
           * The streaming message, appended to the turn it will land in rather
           * than rendered after the whole rail.
           *
           * The two renderings have to be the same React elements in the same
           * parent with the same keys, or `message_end` unmounts every block of
           * the answer and mounts an identical copy a moment later: code fences
           * re-highlight from scratch, a reasoning row collapses itself, and the
           * reader sees the tail of every step blink as the turn is committed.
           * `group.messages.length` is the index the committed message will
           * have (pi appends it), so the keys line up exactly.
           */
          const isLiveTurn = group.turn === liveTurn;
          if (isLiveTurn && partial !== null && hasPartial) {
            const messageIndex = group.messages.length;
            partial.forEach((block, blockIndex) => {
              if (!isContentBlock(block)) return;
              steps.push({
                block,
                messageIndex,
                blockIndex,
                live: true,
                tail: blockIndex === lastPartialIndex,
              });
            });
          }

          // See `failedAnswerOf`: a live turn's errored message may still be
          // recovered by the retry pi is running.
          const failed = isLiveTurn ? null : failedAnswerOf(group.messages);
          const retryPrompt = failed === null ? null : retryPromptOf(group.messages);
          // The same read for a turn pi cut off at the output-token cap. A live
          // turn is held back too: pi stamps `stopReason` only when the message
          // assembles, but the retry-shaped logic keeps the two rows symmetric.
          const truncated = isLiveTurn ? null : truncatedAnswerOf(group.messages);
          // Whether this turn ends in an answer, and whether it has a tail at
          // all. The tail is drawn as one container because the transcript
          // reveals a turn's action row by being hovered, which is how dsh's
          // turn tail behaves (`TurnTailNodeView`).
          const hasAnswer = group.messages.some((message) => message.role === "assistant");
          const hasTailFiles = group.turn !== liveTurn && turnFilesByTurn.has(group.turn);
          const hasTailPlans = group.turn !== liveTurn && plansByTurn.has(group.turn);
          // The last segment of the conversation keeps its row in the open —
          // dsh's rule, `endsWithResponse` included: the newest prompt always,
          // and the newest answer only once the turn has actually ended in one,
          // so a row does not hang in the open above a turn that is still
          // working. Every earlier row reveals on hover (`data-actions-reveal`).
          const revealTail =
            hasAnswer && endsWithReply(group.messages) && group.turn === lastTurn ? "always" : "hover";

          return (
            <div key={group.turn} className={styles.turn} data-turn={group.turn}>
              {group.messages.map((message, index) => {
                // Timestamps are not unique across messages and can be identical
                // in a fast exchange, so the position inside the turn is the key.
                const key = `${String(group.turn)}-${String(index)}`;
                if (message.role !== "user") return null;
                const content = (message as UserMessage).content;
                const text = textFromContent(content);
                const meta = turnMeta.get(group.turn);
                // The turn's fork target belongs to the prompt that opened it,
                // and only that one is in pi's file: a queued prompt waiting
                // further down the group has no entry to branch from yet.
                const forkEntryId = index === 0 ? (meta?.forkEntryId ?? null) : null;
                // The newest prompt on screen keeps its row; every earlier one
                // reveals it on hover. A turn can hold a queued prompt after the
                // one that opened it, so the row that counts as "newest" is the
                // last prompt in the last turn — hence the look forward.
                const newestPrompt =
                  group.turn === lastTurn &&
                  !group.messages.slice(index + 1).some((later) => later.role === "user");
                return (
                  <div key={key} data-actions-reveal={newestPrompt ? "always" : "hover"}>
                    <UserTurn content={content} />
                    <MessageActions
                      align="end"
                      text={displayUserText(text)}
                      timestamp={timestampOf(message)}
                      forkEntryId={forkEntryId}
                      {...(onFork === undefined ? {} : { onFork })}
                    />
                  </div>
                );
              })}
              {steps.length > 0 ? (
                <TurnBody
                  steps={steps}
                  executions={view.toolExecutions}
                  results={results}
                  // Only the live turn can carry a running step; every step in
                  // it still has to ask (`step.tail`) before it renders as such.
                  streaming={isLiveTurn}
                  // A turn folds only once it has ended and only if it ended by
                  // producing something: the group's header is a completion
                  // report ("已完成，用时 2分33秒"), so folding a turn that is
                  // still running would put that claim on the one turn that has
                  // nothing to report yet — dsh refuses to fold a live, stopped,
                  // or failed turn for the same reason. Both display modes fold
                  // (dsh's `foldCompletedTurns` is on for every mode but
                  // verbose); the mode only decides whether a settled reasoning
                  // row keeps its summary line, via `previewSettled` below.
                  compact={foldCompletedTurns && !isLiveTurn && failed === null}
                  stepGrouping={stepGrouping}
                  liveProcessDetail={liveProcessDetail}
                  expandProcessRows={expandProcessRows}
                  processDurationMs={turnMeta.get(group.turn)?.durationMs ?? null}                  // dsh's `settledReasoningPreview`: the compact mode drops the
                  // line beside "思考" and leaves the text one click away; every
                  // other mode keeps it.
                  previewSettled={settledReasoningPreview}
                  cwd={cwd}
                  home={home}
                  refPaths={refPathsByTurn.get(group.turn) ?? EMPTY_REF_PATHS}
                  {...(onOpenFile === undefined ? {} : { onOpenFile })}
                  {...(onImageUrl === undefined ? {} : { onImageUrl })}
                />
              ) : null}
              {/* A failed request, where the answer would have been. Held back
                  while the turn is live: pi keeps the errored message in the
                  file during a retry, so the row would claim the turn failed
                  while `RetryNotice` above is still saying pi is trying again. */}
              {failed === null ? null : (
                <TurnFailure
                  message={failed.errorMessage ?? ""}
                  attempts={group.turn === lastTurn ? view.failedAttempts : 0}
                  {...(onRetry === undefined || retryPrompt === null
                    ? {}
                    : {
                        onRetry: () => {
                          onRetry(retryPrompt.text, retryPrompt.images);
                        },
                      })}
                />
              )}
              {/* A turn pi cut off at the output-token cap: the answer above
                  just stops mid-sentence, and this row is the only
                  explanation. Sits where the failure row sits — right after
                  what the model produced, before the turn-tail chrome. */}
              {truncated === null ? null : <TurnTruncated />}
              {/* The turn's own edits, between the answer and the action row —
                  dsh's turn tail, where the card belongs to the turn that
                  caused it rather than to the transcript as a whole, and like
                  dsh it waits for that turn to end (see `liveTurn`). The cards
                  and the action row share one container so that hovering any of
                  them reveals the action row, exactly as dsh's tail does. */}
              {hasTailFiles || hasTailPlans || hasAnswer ? (
                <div className={styles.turnTail} data-actions-reveal={revealTail}>
                  {hasTailFiles ? (
                    <ChangedFilesCard
                      files={turnFilesByTurn.get(group.turn) ?? []}
                      turn={group.turn}
                      {...(onOpenChanges === undefined ? {} : { onOpenChanges })}
                    />
                  ) : null}
                  {/* The turn's submitted plans, next to its changed files — dsh's
                      turn tail holds both, and both belong to the turn that caused
                      them rather than to the tool row that mentioned it. */}
                  {hasTailPlans ? (
                    <PlanCard plans={plansByTurn.get(group.turn) ?? []} onOpenPlan={onOpenPlan} />
                  ) : null}
                  {/* Streaming answers keep the running status as the only live
                      footer. The usage/copy row is provisional and can overlap
                      that status line before the turn settles. */}
                  {hasAnswer && !isLiveTurn ? (
                    <MessageActions
                      text={assistantTextOf(group.messages)}
                      usage={turnMeta.get(group.turn)?.usage ?? null}
                      model={turnMeta.get(group.turn)?.model ?? null}
                      durationMs={turnMeta.get(group.turn)?.durationMs ?? null}
                      timestamp={turnMeta.get(group.turn)?.endedAt ?? null}
                      forkEntryId={turnMeta.get(group.turn)?.forkEntryId ?? null}
                      {...(onFork === undefined ? {} : { onFork })}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}

        {/*
         * The fallback path for a stream with no turn to attach to — a session
         * whose first event is an assistant message, before any prompt is in
         * the transcript. Everything else is rendered by the live turn above.
         */}
        {hasPartial && partial !== null && !partialMerged ? (
          <TurnBody
            steps={partial.flatMap((block, blockIndex) =>
              !isContentBlock(block)
                ? []
                : [{
                    block,
                    messageIndex: -1,
                    blockIndex,
                    live: true,
                    tail: blockIndex === lastPartialIndex,
                  }],
            )}
            executions={view.toolExecutions}
            results={results}
            streaming={view.isStreaming}
            // The live turn keeps its rows open regardless of the setting:
            // folding them would hide exactly what the user is waiting on, and
            // the group's header would have no completion to report. Every
            // settled turn folds, in either display mode.
            compact={foldCompletedTurns && !view.isStreaming}
            stepGrouping={stepGrouping}
            liveProcessDetail={liveProcessDetail}
            expandProcessRows={expandProcessRows}
            // Nothing to time: this path exists for a stream with no turn to
            // attach to, so there is no start or end stamp anywhere.
            processDurationMs={null}
            previewSettled={settledReasoningPreview}
            cwd={cwd}
            home={home}
          />
        ) : null}

        {/* The compaction pi is writing right now. Above the turn's own running
            label: it is the thing that is happening, and the label below is the
            turn it is happening inside of. */}
        {view.compacting ? <CompactionRunning /> : null}

        {/*
         * dsh keeps this label up for the whole turn — before the first token,
         * during tool calls, and while text streams — so `isStreaming` (which pi
         * drives from `agent_start` to `agent_settled`) is exactly the right
         * window. Hiding it as soon as the first token lands would leave the
         * long tool-running stretches with no sign of life.
         * Not while a retry is up, though: a retry is a deliberate pause, and
         * the row below says so in place of this one.
         */}
        {view.isStreaming && view.retry === null ? <TurnStatus /> : null}

        {/* A retry is a deliberate pause, so it replaces the status line rather
            than stacking under it. */}
        {view.retry ? <RetryNotice retry={view.retry} /> : null}
        </TodoBaselinesProvider>
      </div>

      {/*
        The jump-to-bottom button, in the slot form the rail above already uses:
        zero-height and sticky to the scrollport's bottom edge, with the disc
        absolutely placed inside it. Wrapping the scrollport in a `position:
        relative` box would say the same thing, but it would also re-parent the
        rail — and the rail's arithmetic is written against this element.
      */}
      <div className={styles.jumpSlot}>
        {pinned ? null : (
          <button
            type="button"
            className={styles.jump}
            aria-label={t("message.scrollToBottom")}
            title={t("message.scrollToBottom")}
            onClick={jumpToBottom}
          >
            <Glyph name="chevronDown" size={20} />
          </button>
        )}
      </div>
    </div>
  );
}
