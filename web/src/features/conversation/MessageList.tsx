import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AgentMessage,
  AssistantMessage,
  ContentBlock,
  ForkPoint,
  ImageBlock,
  MessageUsage,
  TextBlock,
  ThinkingBlock as ThinkingBlockType,
  ToolCallBlock,
  ToolResultMessage,
  UserMessage,
} from "../../lib/types.ts";
import { ImageThumb } from "../../components/ImageLightbox.tsx";
import { imageBlocksOf } from "../../lib/image-attachments.ts";
import { Markdown } from "./Markdown.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { ThinkingBlock } from "./ThinkingBlock.tsx";
import { TodoRow } from "./TodoRow.tsx";
import { ToolCallRow } from "./ToolCallRow.tsx";
import { TurnProcessGroup } from "./TurnProcessGroup.tsx";
import { ChangedFilesCard } from "./ChangedFilesCard.tsx";
import { turnFiles, type TurnFile } from "./turn-files.ts";
import { RetryNotice } from "./RetryNotice.tsx";
import { TurnStatus } from "./TurnStatus.tsx";
import { TurnNavigator } from "./TurnNavigator.tsx";
import { splitForCompact } from "./row-model.ts";
import { displayUserText, parseSkillCall, skillCommandLabel } from "./skill-block.ts";
import { groupTurns } from "./turn-rail.ts";
import { textFromContent, type ConversationView, type ToolExecution } from "./useConversation.ts";
import { useDelayedFlag } from "../../lib/use-delayed-flag.ts";
import { Glyph } from "../../components/dsh-icons.tsx";
import styles from "./MessageList.module.css";

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
  cwd,
  home,
}: {
  block: ContentBlock;
  executions: Record<string, ToolExecution>;
  results: Record<string, ToolResultMessage>;
  streaming: boolean;
} & PathContext) {
  if (block.type === "text") {
    const text = (block as TextBlock).text;
    return text.length > 0 ? <Markdown text={text} /> : null;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock text={(block as ThinkingBlockType).thinking} streaming={streaming} />;
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
    // gets a list instead of the generic parameters-and-output card.
    if (call.name === "todo") return <TodoRow call={call} execution={execution} />;
    return <ToolCallRow call={call} execution={execution} cwd={cwd} home={home} />;
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
  cwd,
  home,
}: {
  steps: TurnStep[];
  executions: Record<string, ToolExecution>;
  results: Record<string, ToolResultMessage>;
  streaming: boolean;
  /**
   * Collapse this turn's process steps into one group. Only ever true for a turn
   * that already finished: folding rows while they are still arriving would hide
   * the thing the user is waiting on.
   */
  compact: boolean;
} & PathContext) {
  const renderStep = (step: TurnStep) => (
    <BlockView
      key={`${String(step.messageIndex)}-${String(step.blockIndex)}`}
      block={step.block}
      executions={executions}
      results={results}
      streaming={streaming && step.tail === true}
      cwd={cwd}
      home={home}
    />
  );

  if (!compact) {
    return (
      <div className={styles.assistantTurn}>{steps.map((step) => renderStep(step))}</div>
    );
  }

  const { process, answers } = splitForCompact(steps);
  return (
    <div className={styles.assistantTurn}>
      {process.length > 0 ? (
        <TurnProcessGroup count={process.length}>
          {process.map((step) => renderStep(step))}
        </TurnProcessGroup>
      ) : null}
      {answers.map((step, index) => (
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
    </div>
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
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
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
                alt={`附件 ${String(index + 1)}`}
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
  durationMs: number | null;
  /** Start of the turn, used for the timestamp label. */
  startedAt: number | null;
  endedAt: number | null;
}

function timestampOf(message: AgentMessage): number | null {
  const value = (message as { timestamp?: unknown }).timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageOf(message: AgentMessage): MessageUsage | null {
  const value = (message as { usage?: unknown }).usage;
  if (typeof value !== "object" || value === null) return null;
  const total = (value as { totalTokens?: unknown }).totalTokens;
  return typeof total === "number" ? (value as MessageUsage) : null;
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

    let total = 0;
    let sawUsage = false;
    for (const message of assistants) {
      const usage = usageOf(message);
      if (usage === null) continue;
      sawUsage = true;
      total += usage.totalTokens;
    }

    // Wall-clock span of the turn. The last message's stamp is when it was
    // written for tool results, and when its generation began for a final
    // assistant message; either way this is elapsed time, not model time.
    const stamps = group.messages.map(timestampOf).filter((x): x is number => x !== null);
    const startedAt = stamps.length > 0 ? Math.min(...stamps) : null;
    const endedAt = stamps.length > 0 ? Math.max(...stamps) : null;

    out.set(group.turn, {
      forkEntryId,
      usage: sawUsage ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total } : null,
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
 * Walks the anchors in document order and keeps the last one that starts above
 * the line — the same fallback dsh uses. It does not need `elementsFromPoint`:
 * turn rows are direct siblings in one column, so "last row starting above the
 * line" is exactly the row being read.
 */
function turnAtLine(list: HTMLElement, line: number): number | null {
  let found: number | null = null;
  for (const row of list.querySelectorAll<HTMLElement>("[data-turn]")) {
    if (row.getBoundingClientRect().top > line) break;
    const turn = Number(row.dataset.turn);
    if (Number.isSafeInteger(turn)) found = turn;
  }
  return found;
}

export function MessageList({
  view,
  cwd,
  home,
  compactTranscript = false,
  onFork,
  onOpenFile,
}: {
  view: ConversationView;
  /** Collapse finished turns' process rows into one group (see settings). */
  compactTranscript?: boolean;
  /** Fork the session at a user message. Absent means the action is not shown. */
  onFork?: (entryId: string) => void;
  /**
   * Preview a project-relative path in the right sidebar. Absent means a turn's
   * changed-files card lists its rows without making them clickable.
   */
  onOpenFile?: (path: string) => void;
} & PathContext) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow new output only while the user is already at the bottom.
  const stickRef = useRef(true);
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

  const applyPinned = useCallback((value: boolean): void => {
    stickRef.current = value;
    // React bails out when a state update would not change the value, so the
    // scroll handler can call this on every event for free.
    setPinned(value);
  }, []);

  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const [bandHeight, setBandHeight] = useState<number | null>(null);
  const frameRef = useRef<number | null>(null);

  const railItems = useMemo(() => groupTurns(view.messages), [view.messages]);
  /**
   * Each turn's written files, keyed by turn number.
   *
   * Derived from the same message list the turns were cut from, so a turn's card
   * cannot describe a different set of messages than the rows above it. Turns
   * that wrote nothing are left out rather than mapped to an empty list.
   */
  const turnFilesByTurn = useMemo(() => {
    const map = new Map<number, TurnFile[]>();
    for (const group of railItems) {
      const files = turnFiles(group.messages, { cwd, home });
      if (files.length > 0) map.set(group.turn, files);
    }
    return map;
  }, [railItems, cwd, home]);
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
   * Scroll a turn's row to just below the top of the scrollport.
   *
   * `scrollTop +=` rather than `scrollIntoView`, because `scrollIntoView` cannot
   * leave a fixed offset above the row and would put the anchor flush against
   * the pane edge.
   */
  const navigateToTurn = useCallback((turn: number): void => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const row = scroller.querySelector<HTMLElement>(`[data-turn="${String(turn)}"]`);
    if (row === null) return;
    const rowTop = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += rowTop - JUMP_TOP_OFFSET_PX;
    // Landing at the end should resume following; landing mid-transcript must
    // not, or the next streaming delta would yank the reader back down.
    applyPinned(distanceFromBottom(scroller) <= AT_BOTTOM_THRESHOLD_PX);
    setActiveTurn(turn);
  }, [applyPinned]);

  const results = useMemo(() => {
    // The whole tool result, not just its content: the todo row reads `details`
    // (its snapshot) and the generic row reads `content`.
    const map: Record<string, ToolResultMessage> = {};
    for (const message of view.messages) {
      if (message.role === "toolResult") {
        const toolResult = message as ToolResultMessage;
        map[toolResult.toolCallId] = toolResult;
      }
    }
    return map;
  }, [view.messages]);

  const partial = view.partial;
  const hasPartial = partial !== null && partial.length > 0;
  const lastTurn = railItems.at(-1)?.turn ?? null;
  /**
   * The turn still being produced. Its rail mark pulses, and its changed-files
   * card is held back: a card describes a whole turn, and dsh only draws it once
   * the turn is over — landing it mid-turn would grow the row count under the
   * reader with every round-trip that writes another file.
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
    <div className={styles.scroll} ref={scrollRef} onScroll={onScroll}>
      <TurnNavigator
        items={railItems}
        activeTurn={activeTurn}
        busyTurn={liveTurn}
        bandHeight={bandHeight}
        onNavigate={navigateToTurn}
      />

      <div className={styles.column}>
        {showLoading ? <p className={styles.hint}>正在载入会话…</p> : null}

        {!view.loading && railItems.length === 0 && !hasPartial ? (
          <p className={styles.hint}>还没有消息。在下面输入开始对话。</p>
        ) : null}

        {railItems.map((group) => {
          // Flatten the turn's assistant content so compact mode can group the
          // *turn's* process steps. A turn spans one assistant message per tool
          // round-trip, so grouping per message produced a group per round-trip.
          const steps: TurnStep[] = [];
          group.messages.forEach((message, messageIndex) => {
            if (message.role === "user") return;
            const content = (message as AssistantMessage).content ?? [];
            content.forEach((block, blockIndex) => {
              steps.push({ block, messageIndex, blockIndex });
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
          if (isLiveTurn && hasPartial) {
            const messageIndex = group.messages.length;
            partial.forEach((block, blockIndex) => {
              steps.push({
                block,
                messageIndex,
                blockIndex,
                live: true,
                tail: blockIndex === partial.length - 1,
              });
            });
          }

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
                return (
                  <div key={key}>
                    <UserTurn content={content} />
                    <MessageActions
                      align="end"
                      text={displayUserText(text)}
                      timestamp={timestampOf(message)}
                      forkEntryId={meta?.forkEntryId ?? null}
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
                  // The live turn folds on the same setting as any other; its
                  // streamed steps are kept out of the group by `step.live`.
                  compact={compactTranscript}
                  cwd={cwd}
                  home={home}
                />
              ) : null}
              {/* The turn's own edits, between the answer and the action row —
                  dsh's turn tail, where the card belongs to the turn that
                  caused it rather than to the transcript as a whole, and like
                  dsh it waits for that turn to end (see `liveTurn`). */}
              {group.turn !== liveTurn && turnFilesByTurn.has(group.turn) ? (
                <ChangedFilesCard
                  files={turnFilesByTurn.get(group.turn) ?? []}
                  {...(onOpenFile === undefined ? {} : { onOpenFile })}
                />
              ) : null}
              {group.messages.some((message) => message.role === "assistant") ? (
                <MessageActions
                  text={assistantTextOf(group.messages)}
                  usage={turnMeta.get(group.turn)?.usage ?? null}
                  durationMs={turnMeta.get(group.turn)?.durationMs ?? null}
                  timestamp={turnMeta.get(group.turn)?.endedAt ?? null}
                  forkEntryId={turnMeta.get(group.turn)?.forkEntryId ?? null}
                  {...(onFork === undefined ? {} : { onFork })}
                />
              ) : null}
            </div>
          );
        })}

        {/*
         * The fallback path for a stream with no turn to attach to — a session
         * whose first event is an assistant message, before any prompt is in
         * the transcript. Everything else is rendered by the live turn above.
         */}
        {hasPartial && !partialMerged ? (
          <TurnBody
            steps={partial.map((block, blockIndex) => ({
              block,
              messageIndex: -1,
              blockIndex,
              live: true,
              tail: blockIndex === partial.length - 1,
            }))}
            executions={view.toolExecutions}
            results={results}
            streaming={view.isStreaming}
            // The live turn keeps its rows open regardless of the setting:
            // folding them would hide exactly what the user is waiting on.
            compact={compactTranscript && !view.isStreaming}
            cwd={cwd}
            home={home}
          />
        ) : null}

        {/*
         * dsh keeps this label up for the whole turn — before the first token,
         * during tool calls, and while text streams — so `isStreaming` (which pi
         * drives from `agent_start` to `agent_settled`) is exactly the right
         * window. Hiding it as soon as the first token lands would leave the
         * long tool-running stretches with no sign of life.
         */}
        {view.isStreaming ? <TurnStatus /> : null}

        {/* A retry is a deliberate pause, so it replaces the status line rather
            than stacking under it. */}
        {view.retry ? <RetryNotice retry={view.retry} /> : null}
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
            aria-label="滚动到底部"
            title="滚动到底部"
            onClick={jumpToBottom}
          >
            <Glyph name="chevronDown" size={20} />
          </button>
        )}
      </div>
    </div>
  );
}
