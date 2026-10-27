import { useCallback, useEffect, useRef, useState } from "react";
import { actions, appStore, sessionEvents, streamRestored } from "../../lib/app-state.ts";
import { useStoreSelector } from "../../lib/store.ts";
import { api } from "../../lib/api.ts";
import type {
  AgentMessage,
  AssistantMessage,
  AssistantStreamEvent,
  ContentBlock,
  ForkPoint,
  ImageBlock,
  SessionEvent,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
} from "../../lib/types.ts";
import { projectTodos, type TodoItem } from "./todo-model.ts";
import { projectPendingQuestions, type PendingQuestion } from "./pending-questions.ts";
import { parseStreamingJson } from "../../lib/streaming-json.ts";
import {
  EMPTY_TIMING,
  sessionStats,
  type LiveTiming,
  type SessionStats as SessionStatsData,
} from "./stats-model.ts";

export interface ToolExecution {
  toolName: string;
  args?: Record<string, unknown>;
  /** Streamed stdout/partial text, concatenated. */
  output: string;
  result: ContentBlock[] | null;
  /** The tool's own payload from its result, verbatim (see `ToolResultMessage`). */
  details?: unknown;
  isError: boolean;
  running: boolean;
}

export interface ConversationView {
  messages: AgentMessage[];
  /**
   * User messages pi will accept as fork targets, in transcript order. The list
   * pairs positionally with the user turns the UI renders; the text is kept so
   * the pairing can be verified rather than assumed.
   */
  forkPoints: ForkPoint[];
  /**
   * The plan for the turn in flight, projected from its newest `todo` tool
   * result (see `projectTodos`). Empty when the turn never used one, when the
   * last write in it cleared the list, or when the newest turn has not written
   * one yet — all three are the same thing to every consumer here.
   */
  todos: TodoItem[];
  /**
   * Question batches whose deadline passed with no answer, still answerable
   * (see `projectPendingQuestions`). Projected from the transcript like the
   * plan above, so a reload, a compaction or a branch all agree about them.
   */
  pendingQuestions: PendingQuestion[];
  /** Assistant content being assembled right now, or null when idle. */
  partial: ContentBlock[] | null;
  /**
   * How many of `messages`' trailing user messages pi has not taken up yet —
   * the steers and follow-ups still waiting in its queue.
   *
   * The composer appends a message the moment Enter is pressed, because the
   * user has to see what they sent, but pi only *starts* the turn when it
   * reaches the message: immediately for a prompt, after the current turn for a
   * queued one. `MessageList` needs the difference, because a turn that has not
   * begun cannot be over — a queued prompt counted as a turn of its own would
   * make the running turn look finished and reveal its changed-files card
   * while its files are still being written.
   */
  undeliveredPrompts: number;
  /**
   * The queued prompts this browser is waiting for pi to take up, oldest
   * first. The queue dock renders them; see `QueuedPrompt` for why the list
   * mirrors the trailing undelivered user rows one-to-one.
   */
  queue: QueuedPrompt[];
  /**
   * Wall-clock time of the newest message this browser sent this session, or 0
   * when it has sent none.
   *
   * `MessageList` watches it: the composer is docked at the bottom of the
   * window, so a reader who scrolled up to re-read something and then typed a
   * message has asked to see what happens next — the send brings the transcript
   * back to the tail. It is deliberately *not* "a user message appeared": a
   * message pi recorded from the terminal, or a row that arrives on a reload,
   * grows `messages` without touching this, and a reader who is not following
   * must not be dragged down by someone else's message. Every send from this
   * browser goes through this hook — a prompt, a steer or a follow-up, a
   * command, a retry, an answer to a pending question — so one value covers
   * them all instead of each call site remembering to ask.
   *
   * Only the *change* means anything, and it is never reset, so a session switch
   * cannot read as a send (a reset would pin the next session's reader to the
   * bottom, which is not something they asked for).
   */
  sentAt: number;
  toolExecutions: Record<string, ToolExecution>;
  /**
   * Whether this session's agent loop is running right now.
   *
   * pi drives the window from `agent_start` to `agent_settled`. The flag comes
   * from two places because either can be the one that knows: this hook's own
   * stream (the session is open and its frames arrive here) and app state's
   * per-session run mark (the run started while the user was reading something
   * else, or before this hook mounted). Unioned, not replaced — see the return
   * in `useConversation`.
   */
  isStreaming: boolean;
  /**
   * Whether pi is compacting this session's context right now.
   *
   * pi's own event stream is the only source: `get_state` reports it, but that
   * figure cannot be polled cheaply, and a compaction is a bounded wait with a
   * start and an end frame. `compaction_start` sets it and `compaction_end`
   * clears it — and lands the checkpoint in the transcript, at the point the
   * cut was made.
   */
  compacting: boolean;
  loading: boolean;
  error: string | null;
  /** An in-flight model retry, or null. */
  retry: RetryState | null;
  /**
   * How many automatic retries pi made before this turn's model request gave
   * up, or 0 when it never retried (retries off in pi's settings) or when the
   * count is simply not known — a transcript read from disk carries the failure
   * but not the attempts that preceded it. Only ever a suffix on the failure
   * row: the failure itself is derived from the transcript, so it survives a
   * reload without this.
   */
  failedAttempts: number;
  /**
   * The figures under the composer: counts, tokens, and — while this browser
   * measured the stream itself — decode speed. See `stats-model.ts` for why the
   * timing half is client-owned.
   */
  stats: SessionStatsData;
}

/** One model request that pi is waiting to retry after a failure. */
export interface RetryState {
  attempt: number;
  maxAttempts: number;
  /** How long pi said it would wait before the next attempt. */
  delayMs: number;
  errorMessage: string;
  /** Wall-clock time of the next attempt, so the countdown survives a re-render. */
  deadline: number;
}

/**
 * One message this browser queued (steered or followed up) that pi has not
 * taken up yet.
 *
 * The queue dock renders this list, and `queueRemove`/`queueEdit` act on it by
 * id. The entries mirror the trailing undelivered user rows positionally — the
 * same sends, in the same order — because both are appended and consumed
 * together (see `send` and the `message_start` delivery below). A queue pi
 * filled from the terminal has no entries here, and no rows in the transcript
 * to remove either.
 */
export interface QueuedPrompt {
  id: string;
  text: string;
  images: ImageBlock[];
  mode: "steer" | "followUp";
}

/**
 * The checkpoint a `compaction_end` frame left behind, or null.
 *
 * pi reports a failed and an aborted compaction on the same frame, with no
 * `result` — in both cases the context is exactly as it was and there is nothing
 * to record. Only a result means the cut landed.
 */
export function compactionCheckpoint(
  event: SessionEvent,
): { summary: string; tokensBefore: number } | null {
  if (event.aborted === true) return null;
  const result = event.result;
  if (typeof result !== "object" || result === null) return null;
  const { summary, tokensBefore } = result as { summary?: unknown; tokensBefore?: unknown };
  if (typeof summary !== "string" || typeof tokensBefore !== "number") return null;
  return { summary, tokensBefore };
}

interface StreamSlot {
  content: ContentBlock[];
  /**
   * Raw `toolcall_delta` chunks.
   *
   * The block's `arguments` are re-parsed from these on every delta (see
   * `parseStreamingJson`), so a row and a live group header can name the
   * argument while it is still being written. The buffers survive until
   * `toolcall_end`, which replaces the block outright — and which is also the
   * fallback path when pi sends no final call.
   */
  rawArgs: Record<number, string>;
}

const emptyView: ConversationView = {
  messages: [],
  forkPoints: [],
  todos: [],
  pendingQuestions: [],
  partial: null,
  undeliveredPrompts: 0,
  queue: [],
  sentAt: 0,
  toolExecutions: {},
  isStreaming: false,
  compacting: false,
  loading: true,
  error: null,
  retry: null,
  failedAttempts: 0,
  stats: sessionStats([], EMPTY_TIMING),
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** How many user turns the list holds — see `deliveredUsersRef`. */
function countUserMessages(messages: readonly AgentMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === "user") count += 1;
  }
  return count;
}

/**
 * Indexes of the trailing user messages pi has not taken up yet, oldest first.
 *
 * These pair positionally with `queueRef`'s entries — both lists grow and
 * drain together — which is how a queue edit finds the transcript row it has
 * to rewrite. The walk stays inside the trailing `undelivered` user messages,
 * so a delivered row can never be reached even if the tail holds a
 * non-user block between them.
 */
function undeliveredUserIndexes(
  messages: readonly AgentMessage[],
  undelivered: number,
): number[] {
  const indexes: number[] = [];
  for (let i = messages.length - 1; i >= 0 && indexes.length < undelivered; i -= 1) {
    if (messages[i]?.role === "user") indexes.unshift(i);
  }
  return indexes;
}

/**
 * Live wall-clock boundaries for the statistics pill.
 *
 * pi reports no durations at all — not on a message's usage, not through its
 * session-stats RPC — so the only honest source for a decode speed is this
 * client's own clock while the events stream. A transcript read back from disk
 * therefore shows counts and tokens with no speed, rather than a number that
 * looks measured and is not.
 */
interface TimingState {
  totals: LiveTiming;
  /** Start of the step being decoded, or null between steps. */
  stepStart: number | null;
  /** The step's first non-empty delta, or null before it arrives. */
  firstTokenAt: number | null;
  /** toolCallId → start, for the calls still running. */
  openTools: Map<string, number>;
}

function emptyTiming(): TimingState {
  return {
    totals: { ...EMPTY_TIMING },
    stepStart: null,
    firstTokenAt: null,
    openTools: new Map(),
  };
}

/** pi's numeric event fields are `unknown` off the wire; keep the fallback explicit. */
function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Fold one streaming delta into the partial assistant message. */
function applyDelta(slot: StreamSlot, delta: AssistantStreamEvent): void {
  const index = typeof delta.contentIndex === "number" ? delta.contentIndex : 0;
  const blocks = slot.content;

  switch (delta.type) {
    case "text_start":
      blocks[index] = { type: "text", text: "" };
      break;
    case "text_delta": {
      const existing = blocks[index];
      const chunk = asString(delta.delta);
      if (existing && existing.type === "text") {
        (existing as TextBlock).text += chunk;
      } else {
        blocks[index] = { type: "text", text: chunk };
      }
      break;
    }
    case "text_end": {
      const final = delta.content;
      blocks[index] = { type: "text", text: typeof final === "string" ? final : "" };
      break;
    }
    case "thinking_start":
      blocks[index] = { type: "thinking", thinking: "" };
      break;
    case "thinking_delta": {
      const existing = blocks[index];
      const chunk = asString(delta.delta);
      if (existing && existing.type === "thinking") {
        (existing as ThinkingBlock).thinking += chunk;
      } else {
        blocks[index] = { type: "thinking", thinking: chunk };
      }
      break;
    }
    case "thinking_end": {
      const final = delta.content;
      blocks[index] = { type: "thinking", thinking: typeof final === "string" ? final : "" };
      break;
    }
    case "toolcall_start":
      blocks[index] = {
        type: "toolCall",
        id: asString(delta.id),
        name: asString(delta.toolName),
        arguments: {},
      };
      slot.rawArgs[index] = "";
      break;
    case "toolcall_delta": {
      const raw = (slot.rawArgs[index] ?? "") + asString(delta.delta);
      slot.rawArgs[index] = raw;
      // Read the arguments as they arrive, not when the call ends. A row's
      // summary and a live group's detail both come from `arguments`, and for a
      // long one (a pasted file, a big patch) waiting for the end means the
      // whole call shows nothing until it is over.
      const existing = blocks[index];
      if (existing?.type === "toolCall") {
        const partial = parseStreamingJson(raw);
        if (partial !== undefined) existing.arguments = partial;
      }
      break;
    }
    case "toolcall_end": {
      const call = delta.toolCall as ToolCallBlock | undefined;
      if (call) {
        blocks[index] = call;
      } else {
        const raw = slot.rawArgs[index] ?? "";
        const existing = blocks[index];
        let parsed: Record<string, unknown> = {};
        try {
          parsed = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          parsed = { _raw: raw };
        }
        blocks[index] = {
          type: "toolCall",
          id: existing?.type === "toolCall" ? existing.id : "",
          name: existing?.type === "toolCall" ? existing.name : "tool",
          arguments: parsed,
        };
      }
      break;
    }
    default:
      break;
  }
}

function textFromContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? (block as TextBlock).text : ""))
    .join("");
}

/**
 * A user message's content, in pi's own shape.
 *
 * pi stores a plain string for a text-only message and a block array once
 * anything is attached, so the optimistic turn has to match: otherwise the
 * transcript would change shape under the reader the moment it reloaded from
 * disk. The empty text block for a caption-less picture is not an invention —
 * pi writes one for every prompt, and `messageText` on the server flattens it
 * back to "", which is what keeps fork points lined up.
 */
function userContent(message: string, images: ImageBlock[]): string | ContentBlock[] {
  if (images.length === 0) return message;
  return [{ type: "text", text: message }, ...images];
}

export interface ConversationApi extends ConversationView {
  /** `images` ride along with the text; pi accepts either one without the other. */
  send(text: string, mode: "prompt" | "steer" | "followUp", images?: ImageBlock[]): Promise<boolean>;
  /**
   * Send one slash text pi will consume as an **extension command**.
   *
   * The difference from `send` is not the request — both post a prompt — but who
   * draws the user turn. An extension command records only the message it
   * submits itself (`/plan <message>` steers one; a bare `/plan` records
   * nothing), so drawing the typed line optimistically would leave a row pi
   * never wrote, which only a reload could clear. Instead the command's own
   * message is adopted from the stream, and a command that submits nothing adds
   * no row at all.
   */
  runCommand(text: string, images?: ImageBlock[]): Promise<boolean>;
  abort(): Promise<void>;
  reload(): Promise<void>;
  /**
   * Fork at a user message.
   *
   * pi creates a *new* session file containing the branch up to that message —
   * the original keeps every entry it had. So the useful thing to do afterwards
   * is follow the fork: select the new file and refresh the sidebar, where it
   * appears as its own session. Resolves to the forked-from text, or null when
   * an extension vetoed the fork.
   */
  fork(entryId: string): Promise<{ text: string; sessionPath: string } | null>;
  /**
   * Drop one queued message before pi reaches it. Optimistic; resolves false
   * when the item was not queued here or pi had already started sending it.
   */
  queueRemove(id: string): Promise<boolean>;
  /**
   * Rewrite one queued message's text before pi reaches it. Carries text only
   * — pi's queue holds strings, so a rewritten row drops its images, the same
   * rule dsh's queue editor applies.
   */
  queueEdit(id: string, text: string): Promise<boolean>;
}

/**
 * Minimum wall-clock gap between two streaming repaints.
 *
 * `requestAnimationFrame` already caps this at one per frame, but a frame is
 * 16ms and every one of them re-parses the whole partial Markdown — a cost that
 * grows with the partial's length. On a long response that is what turns a fast
 * stream into dropped frames: the parse is linear in the text, the frame rate
 * is fixed. 50ms of batching keeps the text advancing smoothly to the eye while
 * cutting the render count per second by about three.
 *
 * Only token deltas wait. A non-streaming event (`message_end`,
 * `agent_settled`, a tool result) publishes immediately — it is the arrival
 * that must not be late.
 */
const STREAM_REPAINT_MS = 50;

/**
 * Loads a session's history once, then keeps it current from the event stream.
 * Streaming assistant content lives outside `messages` until `message_end`,
 * which is authoritative.
 */
export function useConversation(sessionPath: string | null): ConversationApi {
  const [view, setView] = useState<ConversationView>(emptyView);
  /**
   * The app-wide run mark for this session.
   *
   * A session keeps running while the user reads another one, and the frames
   * that say so (`agent_start`/`agent_settled`) are delivered for every session
   * — only the token deltas are filtered by subscription. Arming `isStreaming`
   * from this mark, rather than only from this hook's own subscription, is what
   * keeps the "Working..." label and the composer's Stop button from vanishing
   * the moment the user switches away and back.
   */
  const running = useStoreSelector(
    appStore,
    (state) => sessionPath !== null && state.sessionActivity[sessionPath] === "ongoing",
  );
  /**
   * The path whose history `messages` currently reflects, or null while a load
   * is in flight.
   *
   * A queued prompt may only be delivered once this matches its session. Gating
   * on `view.loading` instead is not the same thing and silently loses the
   * first message of every new session: on the render where `sessionPath` first
   * appears, `view` is still the *previous* render's snapshot — `loading:
   * false`, from the draft that had nothing to load — so the effect fires while
   * `load()` is still awaiting disk, and the `messagesRef.current = visible`
   * that lands a moment later erases the user turn it had just added
   * optimistically. The turn never comes back, because pi's own `message_end`
   * for user messages is deliberately ignored, and all that is left of the
   * message is the session title the sidebar derives from it.
   */
  const [loadedPath, setLoadedPath] = useState<string | null>(null);

  const messagesRef = useRef<AgentMessage[]>([]);
  /**
   * How many of `messagesRef`'s user messages pi has taken up.
   *
   * A user message is in the transcript from the moment the composer sends it,
   * but pi starts its turn only when it gets to the message — `message_start`
   * for a user message is that moment, and for a queued prompt pi emits it as it
   * takes the message out of the queue. Nothing about the text can be compared
   * to place it instead: pi expands skill commands before it queues them, so the
   * echo is not what was typed.
   */
  const deliveredUsersRef = useRef(0);
  /**
   * The queued prompts this browser is waiting on — the queue dock's rows.
   *
   * Kept alongside `deliveredUsersRef` because the two describe the same
   * window: an entry is appended when a steered or followed-up send resolves
   * to pi, and consumed from the front by the same `message_start` that
   * counts a delivery. A remove or edit splices the entry and its transcript
   * row together, so the pair cannot drift; a reload or a session switch
   * drops the whole list, since pi's surviving queue re-reveals itself as its
   * messages are taken up.
   */
  const queueRef = useRef<QueuedPrompt[]>([]);
  /**
   * The newest send from this browser; see `ConversationView.sentAt`.
   *
   * Deliberately not reset with the rest of the session state below: the number
   * is meaningless outside the session that produced it, and going backwards
   * would look like a send to whoever is comparing it.
   */
  const sentAtRef = useRef(0);
  /**
   * Whether the next user message pi records belongs to an extension command.
   *
   * Set while `runCommand` is in flight, cleared by the first user `message_end`
   * (the command's own message) or by any ordinary `send`. The flag is what
   * replaces the optimistic turn for commands: pi's row is the only row.
   */
  const adoptUserRef = useRef(false);
  const forkPointsRef = useRef<ForkPoint[]>([]);
  const slotRef = useRef<StreamSlot | null>(null);
  const toolsRef = useRef<Record<string, ToolExecution>>({});
  const streamingRef = useRef(false);
  /** Whether pi is compacting right now; see `ConversationView.compacting`. */
  const compactingRef = useRef(false);
  const loadingRef = useRef(true);
  /** Monotonically invalidates history loads whose session is no longer current. */
  const loadGenerationRef = useRef(0);
  /**
   * React StrictMode replays an effect's setup/cleanup on mount. Keep the path
   * across that replay so the second setup can restore the subscription without
   * clearing the transcript or issuing the same history request twice.
   */
  const effectPathRef = useRef<string | null | undefined>(undefined);
  const errorRef = useRef<string | null>(null);
  const retryRef = useRef<RetryState | null>(null);
  /**
   * Retries pi announced for the turn in flight, so a failure that ends the
   * turn can say how many attempts preceded it.
   */
  const retryAttemptRef = useRef(0);
  const failedAttemptsRef = useRef(0);
  /** Wall-clock boundaries accumulated from the event stream; see `TimingState`. */
  const timingRef = useRef<TimingState>(emptyTiming());
  /**
   * A repaint already scheduled for the streaming update, or null.
   *
   * pi emits a `message_update` per token — far faster than the screen refreshes
   * — and every one of them republishes the whole view: the markdown being
   * written is re-parsed and the transcript re-rendered. Coalescing the deltas
   * into one publish per frame is what keeps a fast stream from dropping frames,
   * which the reader sees as the column stuttering and the follow-scroll landing
   * in fits. `slotRef` keeps accumulating in the meantime, so the frame that
   * does run carries every delta that arrived since the last one.
   */
  const frameRef = useRef<number | null>(null);
  /** Wall-clock time of the last publish, for the streaming repaint floor. */
  const lastPublishRef = useRef(0);
  /** True while a delta has arrived that no publish has carried yet. */
  const dirtyRef = useRef(false);

  const publish = useCallback(() => {
    // This publish supersedes any frame that was waiting to do the same thing.
    if (frameRef.current !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    lastPublishRef.current = Date.now();
    dirtyRef.current = false;
    const slot = slotRef.current;
    // Computed before the projection that consumes it: the plan is cleared when a
    // turn opens, and a prompt pi has not taken up yet has not opened one.
    const undeliveredPrompts = Math.max(
      0,
      countUserMessages(messagesRef.current) - deliveredUsersRef.current,
    );
    setView({
      messages: messagesRef.current,
      forkPoints: forkPointsRef.current,
      // Projected on every publish rather than cached: the scan walks backwards
      // from the end of the newest turn and normally stops at its last tool
      // result, and a stale plan is a worse bug than a redundant pass.
      todos: projectTodos(messagesRef.current, undeliveredPrompts),
      // Also projected on every publish: the answered set is completed from the
      // user messages already in the transcript, and a reply that arrived as a
      // new turn has to close its question on the frame that carries it.
      pendingQuestions: projectPendingQuestions(messagesRef.current),
      partial: slot ? [...slot.content] : null,
      // Recomputed rather than counted as it changes: the refs are the state,
      // and one pass over a few hundred messages is cheaper than a counter that
      // can drift from the list it describes.
      undeliveredPrompts,
      queue: [...queueRef.current],
      sentAt: sentAtRef.current,
      toolExecutions: { ...toolsRef.current },
      isStreaming: streamingRef.current,
      compacting: compactingRef.current,
      loading: loadingRef.current,
      error: errorRef.current,
      retry: retryRef.current,
      failedAttempts: failedAttemptsRef.current,
      // Copied, not aliased: the ref keeps mutating as events arrive, and a view
      // holding the live object would compare equal to itself forever.
      stats: sessionStats(messagesRef.current, { ...timingRef.current.totals }),
    });
  }, []);

  /**
   * Repaint streaming output on the next frame, but no more often than
   * `STREAM_REPAINT_MS`.
   *
   * `requestAnimationFrame` is absent in test environments; publishing inline
   * there keeps the observable behaviour the same.
   */
  const schedulePublish = useCallback(() => {
    if (typeof requestAnimationFrame === "undefined") {
      publish();
      return;
    }
    dirtyRef.current = true;
    if (frameRef.current !== null) return;

    // Keeps re-arming until the floor has passed and something is pending, so
    // the last delta of a burst is always painted — a dropped tail would leave
    // the transcript a few tokens short until the next event.
    const tick = (): void => {
      if (!dirtyRef.current) {
        frameRef.current = null;
        return;
      }
      if (Date.now() - lastPublishRef.current < STREAM_REPAINT_MS) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }
      frameRef.current = null;
      publish();
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [publish]);

  /**
   * Fold one session frame into the refs.
   */
  const handleEvent = useCallback(
    (event: SessionEvent) => {
      switch (event.type) {
        case "agent_start":
          streamingRef.current = true;
          // A fresh run: whatever the previous turn ended with is history now.
          retryAttemptRef.current = 0;
          failedAttemptsRef.current = 0;
          break;

        // pi retries a failed model request on its own schedule. Without this
        // the turn looks frozen for the whole backoff — the reason the UI went
        // quiet is exactly what the user cannot see.
        case "auto_retry_start": {
          retryAttemptRef.current = asNumber(event.attempt, 1);
          // A retry is on its way, so this turn is not a failure yet: the row
          // that says it is belongs to pi's *last* word, `auto_retry_end`.
          failedAttemptsRef.current = 0;
          retryRef.current = {
            attempt: retryAttemptRef.current,
            maxAttempts: asNumber(event.maxAttempts, 1),
            delayMs: asNumber(event.delayMs, 0),
            errorMessage: asString(event.errorMessage),
            deadline: Date.now() + asNumber(event.delayMs, 0),
          };
          break;
        }

        case "auto_retry_end":
          retryRef.current = null;
          // pi's verdict on the turn: `success: false` means it stopped
          // retrying and the transcript now holds a failed request, so the
          // attempt count is the one thing the transcript cannot supply. A
          // success clears the count and leaves no failure entry behind.
          failedAttemptsRef.current =
            event.success === false ? asNumber(event.attempt, retryAttemptRef.current) : 0;
          retryAttemptRef.current = 0;
          break;

        case "message_start": {
          const message = event.message as AgentMessage | undefined;
          if (message?.role === "assistant") {
            slotRef.current = { content: [], rawArgs: {} };
            timingRef.current.stepStart = Date.now();
            timingRef.current.firstTokenAt = null;
          } else if (message?.role === "user") {
            // pi has taken this message up. Only ever one at a time, and never
            // more than the transcript holds: a message sent from the terminal
            // or another tab has no row here to confirm.
            if (deliveredUsersRef.current < countUserMessages(messagesRef.current)) {
              deliveredUsersRef.current += 1;
              // The same event consumes the queue dock's oldest row; gating on
              // the delivery keeps a terminal-side take-up from eating a row
              // this browser queued.
              queueRef.current = queueRef.current.slice(1);
            }
          }
          break;
        }

        case "message_update": {
          const delta = event.assistantMessageEvent as AssistantStreamEvent | undefined;
          if (!delta) break;
          if (!slotRef.current) slotRef.current = { content: [], rawArgs: {} };
          // TTFT runs to the first *non-empty* chunk: `text_start` frames land
          // with nothing in them, and counting one would report a first token
          // the model had not produced yet.
          if (
            timingRef.current.firstTokenAt === null &&
            (delta.type === "text_delta" || delta.type === "thinking_delta") &&
            asString(delta.delta).length > 0
          ) {
            timingRef.current.firstTokenAt = Date.now();
          }
          applyDelta(slotRef.current, delta);
          // One repaint per frame rather than one per token; see `frameRef`.
          schedulePublish();
          return;
        }

        case "message_end": {
          const message = event.message as AgentMessage | undefined;
          if (!message) break;
          if (message.role === "assistant") {
            messagesRef.current = [...messagesRef.current, message];
            slotRef.current = null;

            // Close the step here, where the assembled message (and therefore
            // the provider's output-token count) is finally in hand.
            const timing = timingRef.current;
            const endedAt = Date.now();
            if (timing.stepStart !== null) {
              timing.totals.llmMs += endedAt - timing.stepStart;
              if (timing.firstTokenAt !== null) {
                timing.totals.ttftMs += timing.firstTokenAt - timing.stepStart;
                timing.totals.ttftSteps += 1;
                const output = (message as AssistantMessage).usage?.output ?? 0;
                if (output > 0) {
                  timing.totals.decodeMs += endedAt - timing.firstTokenAt;
                  timing.totals.decodeTokens += output;
                }
              }
            }
            timing.stepStart = null;
            timing.firstTokenAt = null;
          } else if (message.role === "user") {
            // An extension command's own message: the command steered it, so pi
            // is the only party that wrote a row for it — the composer
            // deliberately draws none (see `runCommand`).
            if (adoptUserRef.current) {
              adoptUserRef.current = false;
              messagesRef.current = [...messagesRef.current, message];
            }
          } else if (message.role === "toolResult" || message.role === "bashExecution") {
            // Rendered through the tool card that produced them, kept here as
            // the durable record. `system`/`user` are deliberately dropped:
            // user turns are added optimistically, and system messages carry
            // the whole prompt + tool loadout.
            messagesRef.current = [...messagesRef.current, message];
          }
          break;
        }

        case "tool_execution_start": {
          const id = asString(event.toolCallId);
          if (id.length > 0) timingRef.current.openTools.set(id, Date.now());
          toolsRef.current = {
            ...toolsRef.current,
            [id]: {
              toolName: asString(event.toolName),
              args: (event.args as Record<string, unknown>) ?? {},
              output: "",
              result: null,
              isError: false,
              running: true,
            },
          };
          break;
        }

        case "tool_execution_update": {
          const id = asString(event.toolCallId);
          const previous = toolsRef.current[id];
          const partial = event.partialResult as { content?: ContentBlock[]; details?: unknown } | undefined;
          const chunk = partial?.content
            ? partial.content
                .map((block) => (block.type === "text" ? (block as TextBlock).text : ""))
                .join("")
            : "";
          toolsRef.current = {
            ...toolsRef.current,
            [id]: {
              toolName: previous?.toolName ?? asString(event.toolName),
              args: previous?.args,
              output: chunk.length > 0 ? chunk : (previous?.output ?? ""),
              result: partial?.content ?? previous?.result ?? null,
              details: partial?.details ?? previous?.details,
              isError: previous?.isError ?? false,
              running: true,
            },
          };
          // A chatty command streams its output per chunk just like the model
          // streams tokens; the same one-repaint-per-frame coalescing applies.
          schedulePublish();
          return;
        }

        case "tool_execution_end": {
          const id = asString(event.toolCallId);
          const startedAt = timingRef.current.openTools.get(id);
          if (startedAt !== undefined) {
            timingRef.current.openTools.delete(id);
            timingRef.current.totals.toolMs += Date.now() - startedAt;
          }
          const previous = toolsRef.current[id];
          const result = event.result as { content?: ContentBlock[]; details?: unknown } | undefined;
          toolsRef.current = {
            ...toolsRef.current,
            [id]: {
              toolName: previous?.toolName ?? asString(event.toolName),
              args: previous?.args,
              output: previous?.output ?? "",
              result: result?.content ?? previous?.result ?? null,
              details: result?.details ?? previous?.details,
              isError: Boolean(event.isError),
              running: false,
            },
          };
          break;
        }

        case "agent_settled":
          streamingRef.current = false;
          break;

        // Compaction is a model call of its own, run between the frames the
        // transcript is made of. Without these two the wait is invisible: the
        // turn simply stops producing tokens for half a minute, and the cut
        // that follows would leave no trace in the conversation at all.
        case "compaction_start":
          compactingRef.current = true;
          break;

        case "compaction_end": {
          compactingRef.current = false;
          const checkpoint = compactionCheckpoint(event);
          if (checkpoint === null) break;
          // Appended where it happened rather than re-read from pi.
          //
          // A re-read would return the *compacted* context — the checkpoint
          // first, the folded turns gone — and that is the wrong shape for the
          // one reader who needs to see this: the transcript collapses under
          // them, and the row explaining it lands above everything, off-screen
          // in any session long enough to have been compacted in the first
          // place. Recording it here instead keeps what pi folded visible above
          // the marker and puts the marker exactly where the reader is looking.
          // A session loaded from disk still gets the server's own copy at the
          // top, because there the folded turns are not in the data to begin
          // with.
          messagesRef.current = [
            ...messagesRef.current,
            {
              role: "compactionSummary",
              summary: checkpoint.summary,
              tokensBefore: checkpoint.tokensBefore,
              timestamp: Date.now(),
            },
          ];
          break;
        }

        default:
          break;
      }
      publish();
    },
    [publish, schedulePublish],
  );

  const load = useCallback(
    async (path: string) => {
      const generation = ++loadGenerationRef.current;
      loadingRef.current = true;
      errorRef.current = null;
      publish();
      try {
        const { messages, forkPoints } = await api.getMessages(path);
        if (generation !== loadGenerationRef.current) return;
        // System messages replay the entire prompt and tool loadout; the UI
        // never shows them and they would dwarf the real conversation.
        const visible = messages.filter((message) => message.role !== "system");
        messagesRef.current = visible;
        // Everything in the file is a message pi already took up, so the
        // transcript starts with nothing queued behind it.
        deliveredUsersRef.current = countUserMessages(visible);
        // The dock rows belonged to the browser that queued them; pi's
        // surviving queue re-reveals itself through deliveries instead.
        queueRef.current = [];
        forkPointsRef.current = forkPoints;
        loadingRef.current = false;
      } catch (err) {
        if (generation !== loadGenerationRef.current) return;
        errorRef.current = (err as Error).message;
        loadingRef.current = false;
      }
      // Batched with the `publish()` below, so the render that sees the settled
      // view is the same one that allows a queued prompt through — by which
      // point this load can no longer overwrite what the delivery appends.
      setLoadedPath(path);
      publish();
    },
    [publish],
  );

  useEffect(() => {
    // React StrictMode intentionally runs setup → cleanup → setup once on mount.
    // The second setup still needs a fresh event subscription, but it must not
    // clear the transcript or start a duplicate history request. A real session
    // switch has a different path and therefore takes the full reset path.
    const sameEffectPath = effectPathRef.current === sessionPath;
    if (!sameEffectPath) {
      effectPathRef.current = sessionPath;
      // Invalidate any history request from the session that just became stale.
      loadGenerationRef.current += 1;
      messagesRef.current = [];
      deliveredUsersRef.current = 0;
      queueRef.current = [];
      // A command's pending adoption belongs to the stream it was sent on.
      adoptUserRef.current = false;
      slotRef.current = null;
      toolsRef.current = {};
      streamingRef.current = false;
      // Timings belong to the stream they were measured on; a new session starts
      // its own clock rather than inheriting the previous one's speed.
      timingRef.current = emptyTiming();
      // A retry belongs to one turn; carrying it into another session would leave
      // a countdown ticking for something that is no longer happening — and the
      // failed-attempt count belongs to that turn's transcript row, which only the
      // session being switched away from can show.
      retryRef.current = null;
      retryAttemptRef.current = 0;
      failedAttemptsRef.current = 0;
      // A compaction belongs to the session that was running it too: leaving this
      // set would put the running row under the next session's transcript, where
      // no `compaction_end` is ever going to arrive to clear it.
      compactingRef.current = false;
      // The history below belongs to the previous session until `load` says
      // otherwise; leaving this set would let a queued prompt skip the wait.
      setLoadedPath(null);
    }

    if (!sessionPath) {
      if (!sameEffectPath) {
        loadingRef.current = false;
        publish();
      }
      return;
    }

    if (!sameEffectPath) void load(sessionPath);
    const unsubscribe = sessionEvents.subscribe((payload) => {
      if (payload.sessionPath !== sessionPath) return;
      handleEvent(payload.event);
    });
    // A reconnect means the stream may have missed frames that will never be
    // replayed (the server sheds a client that falls too far behind). The file
    // is authoritative for everything already written; a message still being
    // streamed heals when its `message_end` arrives with the whole message.
    const unsubscribeRestored = streamRestored.subscribe(() => {
      void load(sessionPath);
    });
    return () => {
      unsubscribe();
      unsubscribeRestored();
      // A frame queued by this session must not repaint the next one.
      if (frameRef.current !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [sessionPath, load, handleEvent, publish]);

  const send = useCallback<ConversationApi["send"]>(
    async (text, mode, images = []) => {
      if (!sessionPath) return false;
      // An ordinary send always owns its own optimistic turn.
      adoptUserRef.current = false;
      const message = text.trim();
      if (message.length === 0 && images.length === 0) return false;

      // Show the user's turn immediately; `message_end` for user messages is
      // deliberately ignored above, so this stays the single source.
      const sendGeneration = loadGenerationRef.current;
      const optimisticMessage: AgentMessage = {
        role: "user",
        content: userContent(message, images),
        timestamp: Date.now(),
      };
      messagesRef.current = [...messagesRef.current, optimisticMessage];
      if (mode === "prompt") streamingRef.current = true;
      // A prompt is sent as a prompt, so pi has taken it up the moment the call
      // returns; counting it here keeps the turn before it from looking live for
      // the round-trip a `message_start` would take to arrive (its changed-files
      // card would drop out and come back). A steer or follow-up is the opposite
      // — it waits in pi's queue, and that wait is what `undeliveredPrompts`
      // reports until pi reaches it.
      if (mode === "prompt") deliveredUsersRef.current += 1;
      // The queue dock's row exists from the same moment the transcript row
      // does, so a remove or edit cannot race past a send that is still in
      // flight; the rollback below takes it back out if pi refused it.
      const queueEntry: QueuedPrompt | null =
        mode === "prompt"
          ? null
          : { id: crypto.randomUUID(), text: message, images, mode };
      if (queueEntry) queueRef.current = [...queueRef.current, queueEntry];
      // Stamped with the optimistic turn, so the transcript can put the reader
      // back on the floor on the same frame that turn is painted — see
      // `ConversationView.sentAt`. A refused send keeps the stamp: the reader
      // is already at the bottom, and taking it back would move them again.
      sentAtRef.current = Date.now();
      publish();

      try {
        if (mode === "steer") await api.steer(sessionPath, message, images);
        else if (mode === "followUp") await api.followUp(sessionPath, message, images);
        else await api.prompt(sessionPath, message, images);
        return true;
      } catch (err) {
        // A late response from a previous session must not mutate the current
        // session's transcript or counters.
        if (sendGeneration !== loadGenerationRef.current) return false;
        // Roll back this send only. Another concurrent send or stream event may
        // have appended after it, so removing the last row is not safe.
        const optimisticIndex = messagesRef.current.indexOf(optimisticMessage);
        if (optimisticIndex >= 0) {
          messagesRef.current = messagesRef.current.filter((_, index) => index !== optimisticIndex);
        }
        if (mode === "prompt") deliveredUsersRef.current -= 1;
        if (queueEntry) {
          queueRef.current = queueRef.current.filter((entry) => entry.id !== queueEntry.id);
        }
        errorRef.current = (err as Error).message;
        streamingRef.current = false;
        publish();
        return false;
      }
    },
    [sessionPath, publish],
  );

  /**
   * Remove or rewrite one queued message.
   *
   * The optimistic application mirrors what the server will do — splice the
   * queue entry and its transcript row together — so the dock and the
   * transcript never disagree for longer than one round trip. A 409 means pi
   * started sending the message between the user's tap and the call; both
   * snapshots go back and the error line says so.
   */
  const queueMutate = useCallback(
    async (id: string, action: { kind: "remove" } | { kind: "edit"; text: string }): Promise<boolean> => {
      if (!sessionPath) return false;
      const entries = queueRef.current;
      const position = entries.findIndex((entry) => entry.id === id);
      if (position === -1) return false;
      const entry = entries[position]!;
      // pi addresses queue items per lane; the dock's index is over the
      // interleaved list, so the lane position is derived here.
      const laneIndex = entries
        .slice(0, position)
        .filter((earlier) => earlier.mode === entry.mode).length;
      const snapshotQueue = entries;
      const snapshotMessages = messagesRef.current;
      const undelivered = Math.max(
        0,
        countUserMessages(messagesRef.current) - deliveredUsersRef.current,
      );
      const rowIndexes = undeliveredUserIndexes(messagesRef.current, undelivered);
      const rowIndex = rowIndexes[position];
      if (rowIndex === undefined) return false;

      const nextEntries = [...entries];
      if (action.kind === "remove") nextEntries.splice(position, 1);
      else nextEntries[position] = { ...entry, text: action.text };
      const nextMessages = [...messagesRef.current];
      if (action.kind === "remove") nextMessages.splice(rowIndex, 1);
      else nextMessages[rowIndex] = { ...nextMessages[rowIndex]!, content: userContent(action.text, entry.images) };
      queueRef.current = nextEntries;
      messagesRef.current = nextMessages;
      publish();

      try {
        const { failed } = await api.queueUpdate(sessionPath, {
          mode: entry.mode,
          index: laneIndex,
          expectedText: entry.text,
          action,
        });
        if (failed.length > 0) errorRef.current = failed.join("\n");
        return true;
      } catch (err) {
        queueRef.current = snapshotQueue;
        messagesRef.current = snapshotMessages;
        errorRef.current = (err as Error).message;
        publish();
        return false;
      }
    },
    [sessionPath, publish],
  );

  const queueRemove = useCallback(
    (id: string) => queueMutate(id, { kind: "remove" }),
    [queueMutate],
  );

  const queueEdit = useCallback(
    (id: string, text: string) => queueMutate(id, { kind: "edit", text: text.trim() }),
    [queueMutate],
  );

  const runCommand = useCallback<ConversationApi["runCommand"]>(
    async (text, images = []) => {
      if (!sessionPath) return false;
      const message = text.trim();
      if (message.length === 0 && images.length === 0) return false;
      // Armed before the request, because pi may record the command's message
      // and emit it before the RPC reply lands.
      adoptUserRef.current = true;
      // A command is a message too, so it goes through the same stamp: the row
      // pi records for it arrives on the stream a beat later, and reading it
      // needs the transcript back at the tail (see `ConversationView.sentAt`).
      sentAtRef.current = Date.now();
      publish();
      try {
        await api.prompt(sessionPath, message, images);
        return true;
      } catch (err) {
        adoptUserRef.current = false;
        errorRef.current = (err as Error).message;
        publish();
        return false;
      }
    },
    [sessionPath, publish],
  );

  const abort = useCallback(async () => {
    if (!sessionPath) return;
    try {
      await api.abort(sessionPath);
    } catch (err) {
      errorRef.current = (err as Error).message;
      publish();
    }
  }, [sessionPath, publish]);

  const reload = useCallback(async () => {
    if (!sessionPath) return;
    messagesRef.current = [];
    slotRef.current = null;
    retryRef.current = null;
    retryAttemptRef.current = 0;
    failedAttemptsRef.current = 0;
    await load(sessionPath);
  }, [sessionPath, load]);

  // Deliver a message the user typed while the session was still spawning.
  // Waiting on `loadedPath` rather than `view.loading` is what keeps the turn
  // from being erased by the load that is still in flight; see `loadedPath`.
  useEffect(() => {
    if (!sessionPath || loadedPath !== sessionPath) return;
    const pending = actions.takePendingPrompt(sessionPath);
    // A queued extension command goes out the command way: pi records only what
    // the command submits, so the optimistic turn would be a row it never wrote.
    if (pending) {
      if (pending.command === true) void runCommand(pending.text, pending.images);
      else void send(pending.text, pending.mode, pending.images);
    }
  }, [sessionPath, loadedPath, send, runCommand]);

  const fork = useCallback(
    async (entryId: string): Promise<{ text: string; sessionPath: string } | null> => {
      if (sessionPath === null) return null;
      const result = await api.forkSession(sessionPath, entryId);
      if (result.cancelled) return null;
      // pi answers with the original `sessionPath` and a fresh `sessionFile`;
      // the new branch is the file. Returned rather than selected here, because
      // which session the app is *looking at* is the caller's decision — this
      // hook only owns the transcript it was handed.
      return { text: result.text, sessionPath: result.sessionFile ?? result.sessionPath };
    },
    [sessionPath],
  );

  // `view.isStreaming` is this hook's own view of the run; `running` is the
  // app-wide one. Either being true means the turn is still moving, so the two
  // are unioned: the ref knows about a run whose start frame this subscription
  // missed, and the mark knows about one that started before this hook mounted.
  return {
    ...view,
    isStreaming: view.isStreaming || running,
    send,
    runCommand,
    abort,
    reload,
    fork,
    queueRemove,
    queueEdit,
  };
}

export { textFromContent };
