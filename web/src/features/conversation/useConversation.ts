import { useCallback, useEffect, useRef, useState } from "react";
import { actions, sessionEvents } from "../../lib/app-state.ts";
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
   * The session's current todo list, projected from the newest `todo` tool
   * result in the transcript (see `projectTodos`). Empty when the session never
   * used one — or when the last write cleared it, which is the same thing to
   * every consumer here.
   */
  todos: TodoItem[];
  /** Assistant content being assembled right now, or null when idle. */
  partial: ContentBlock[] | null;
  toolExecutions: Record<string, ToolExecution>;
  isStreaming: boolean;
  loading: boolean;
  error: string | null;
  /** An in-flight model retry, or null. */
  retry: RetryState | null;
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

interface StreamSlot {
  content: ContentBlock[];
  /** Raw `toolcall_delta` chunks, parsed when the call ends. */
  rawArgs: Record<number, string>;
}

const emptyView: ConversationView = {
  messages: [],
  forkPoints: [],
  todos: [],
  partial: null,
  toolExecutions: {},
  isStreaming: false,
  loading: true,
  error: null,
  retry: null,
  stats: sessionStats([], EMPTY_TIMING),
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
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
    case "toolcall_delta":
      slot.rawArgs[index] = (slot.rawArgs[index] ?? "") + asString(delta.delta);
      break;
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
}

/**
 * Loads a session's history once, then keeps it current from the event stream.
 * Streaming assistant content lives outside `messages` until `message_end`,
 * which is authoritative.
 */
export function useConversation(sessionPath: string | null): ConversationApi {
  const [view, setView] = useState<ConversationView>(emptyView);
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
  const forkPointsRef = useRef<ForkPoint[]>([]);
  const slotRef = useRef<StreamSlot | null>(null);
  const toolsRef = useRef<Record<string, ToolExecution>>({});
  const streamingRef = useRef(false);
  const loadingRef = useRef(true);
  const errorRef = useRef<string | null>(null);
  const retryRef = useRef<RetryState | null>(null);
  /** Wall-clock boundaries accumulated from the event stream; see `TimingState`. */
  const timingRef = useRef<TimingState>(emptyTiming());
  /** Guards the one-time "this session now exists on disk" sidebar refresh. */
  const persistedNotifiedRef = useRef(false);
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

  const publish = useCallback(() => {
    // This publish supersedes any frame that was waiting to do the same thing.
    if (frameRef.current !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const slot = slotRef.current;
    setView({
      messages: messagesRef.current,
      forkPoints: forkPointsRef.current,
      // Projected on every publish rather than cached: the scan walks backwards
      // and normally stops at the last tool result, and a stale plan is a worse
      // bug than a redundant pass over a few hundred messages.
      todos: projectTodos(messagesRef.current),
      partial: slot ? [...slot.content] : null,
      toolExecutions: { ...toolsRef.current },
      isStreaming: streamingRef.current,
      loading: loadingRef.current,
      error: errorRef.current,
      retry: retryRef.current,
      // Copied, not aliased: the ref keeps mutating as events arrive, and a view
      // holding the live object would compare equal to itself forever.
      stats: sessionStats(messagesRef.current, { ...timingRef.current.totals }),
    });
  }, []);

  /**
   * Republish on the next frame, at most once per frame.
   *
   * `requestAnimationFrame` is absent in test environments; publishing inline
   * there keeps the observable behaviour the same.
   */
  const schedulePublish = useCallback(() => {
    if (typeof requestAnimationFrame === "undefined") {
      publish();
      return;
    }
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      publish();
    });
  }, [publish]);

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      switch (event.type) {
        case "agent_start":
          streamingRef.current = true;
          break;

        // pi retries a failed model request on its own schedule. Without this
        // the turn looks frozen for the whole backoff — the reason the UI went
        // quiet is exactly what the user cannot see.
        case "auto_retry_start":
          retryRef.current = {
            attempt: asNumber(event.attempt, 1),
            maxAttempts: asNumber(event.maxAttempts, 1),
            delayMs: asNumber(event.delayMs, 0),
            errorMessage: asString(event.errorMessage),
            deadline: Date.now() + asNumber(event.delayMs, 0),
          };
          break;

        case "auto_retry_end":
          retryRef.current = null;
          break;

        case "message_start": {
          const message = event.message as AgentMessage | undefined;
          if (message?.role === "assistant") {
            slotRef.current = { content: [], rawArgs: {} };
            timingRef.current.stepStart = Date.now();
            timingRef.current.firstTokenAt = null;
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
            const hadAssistant = messagesRef.current.some((m) => m.role === "assistant");
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

            // pi writes the JSONL once the first assistant message lands, so
            // this is the moment the sidebar can finally show the session.
            if (!hadAssistant && !persistedNotifiedRef.current) {
              persistedNotifiedRef.current = true;
              actions.refreshSelectedProjectSessions();
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

        default:
          break;
      }
      publish();
    },
    [publish, schedulePublish],
  );

  const load = useCallback(
    async (path: string) => {
      loadingRef.current = true;
      errorRef.current = null;
      publish();
      try {
        const { messages, forkPoints } = await api.getMessages(path);
        // System messages replay the entire prompt and tool loadout; the UI
        // never shows them and they would dwarf the real conversation.
        const visible = messages.filter((message) => message.role !== "system");
        messagesRef.current = visible;
        forkPointsRef.current = forkPoints;
        persistedNotifiedRef.current = visible.some((message) => message.role === "assistant");
        loadingRef.current = false;
      } catch (err) {
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
    messagesRef.current = [];
    slotRef.current = null;
    toolsRef.current = {};
    streamingRef.current = false;
    // Timings belong to the stream they were measured on; a new session starts
    // its own clock rather than inheriting the previous one's speed.
    timingRef.current = emptyTiming();
    // A retry belongs to one turn; carrying it into another session would leave
    // a countdown ticking for something that is no longer happening.
    retryRef.current = null;
    persistedNotifiedRef.current = false;
    // The history below belongs to the previous session until `load` says
    // otherwise; leaving this set would let a queued prompt skip the wait.
    setLoadedPath(null);

    if (!sessionPath) {
      loadingRef.current = false;
      publish();
      return;
    }

    void load(sessionPath);
    const unsubscribe = sessionEvents.subscribe((payload) => {
      if (payload.sessionPath !== sessionPath) return;
      handleEvent(payload.event);
    });
    return () => {
      unsubscribe();
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
      const message = text.trim();
      if (message.length === 0 && images.length === 0) return false;

      // Show the user's turn immediately; `message_end` for user messages is
      // deliberately ignored above, so this stays the single source.
      messagesRef.current = [
        ...messagesRef.current,
        { role: "user", content: userContent(message, images), timestamp: Date.now() },
      ];
      if (mode === "prompt") streamingRef.current = true;
      publish();

      try {
        if (mode === "steer") await api.steer(sessionPath, message, images);
        else if (mode === "followUp") await api.followUp(sessionPath, message, images);
        else await api.prompt(sessionPath, message, images);
        return true;
      } catch (err) {
        // Roll the optimistic turn back so the failure is visible, not implied.
        messagesRef.current = messagesRef.current.slice(0, -1);
        errorRef.current = (err as Error).message;
        streamingRef.current = false;
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
    await load(sessionPath);
  }, [sessionPath, load]);

  // Deliver a message the user typed while the session was still spawning.
  // Waiting on `loadedPath` rather than `view.loading` is what keeps the turn
  // from being erased by the load that is still in flight; see `loadedPath`.
  useEffect(() => {
    if (!sessionPath || loadedPath !== sessionPath) return;
    const pending = actions.takePendingPrompt(sessionPath);
    if (pending) void send(pending.text, pending.mode, pending.images);
  }, [sessionPath, loadedPath, send]);

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

  return { ...view, send, abort, reload, fork };
}

export { textFromContent };
