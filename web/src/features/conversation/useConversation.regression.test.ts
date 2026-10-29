import { describe, expect, it, vi } from "vitest";

const state = { slots: [] as unknown[], refs: [] as Array<{ current: unknown }>, effects: [] as Array<{ deps: unknown[] | undefined; cleanup?: () => void; effect: () => void | (() => void) }>, cursor: 0, effectCursor: 0, result: undefined as any };

function depsChanged(previous: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (previous === undefined || next === undefined) return true;
  return previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
}

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = initial;
    return [state.slots[index], (next: unknown) => { state.slots[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(state.slots[index]) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.refs)) state.refs[index] = { current: initial };
    return state.refs[index];
  },
  useCallback: (callback: unknown) => { state.cursor++; return callback; },
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const index = state.effectCursor++;
    const previous = state.effects[index];
    state.effects[index] = { deps, cleanup: previous?.cleanup, effect };
    if (!previous || depsChanged(previous.deps, deps)) (state.effects[index] as any).run = true;
  },
}));

vi.mock("../../lib/store.ts", () => ({
  useStoreSelector: () => false,
}));

const mocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  prompt: vi.fn(),
  steer: vi.fn(),
  followUp: vi.fn(),
  emitter: () => ({ emit: vi.fn(), subscribe: vi.fn(() => () => undefined) }),
}));

vi.mock("../../lib/api.ts", () => ({ api: { getMessages: mocks.getMessages, prompt: mocks.prompt, steer: mocks.steer, followUp: mocks.followUp, abort: vi.fn(), forkSession: vi.fn(), queueUpdate: vi.fn() } }));
vi.mock("../../lib/app-state.ts", () => ({
  actions: { markSessionOngoing: vi.fn(), markSessionSettled: vi.fn(), refreshSelectedProjectSessions: vi.fn(), takePendingPrompt: vi.fn(() => null) },
  appStore: { get: () => ({ sessionActivity: {} }), subscribe: () => () => undefined },
  sessionEvents: mocks.emitter(),
  streamRestored: mocks.emitter(),
}));

const { getMessages, prompt, steer, followUp } = mocks;

import { sessionEvents } from "../../lib/app-state.ts";
import { useConversation } from "./useConversation.ts";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function render(path: string | null): any {
  state.cursor = 0;
  state.effectCursor = 0;
  state.result = useConversation(path);
  return state.result;
}

function flushEffects(): void {
  for (const item of state.effects) {
    if (!(item as any).run) continue;
    (item as any).run = false;
    item.cleanup?.();
    item.cleanup = item.effect() as (() => void) | undefined;
  }
}

function resetHarness(): void {
  state.slots = [];
  state.refs = [];
  state.effects = [];
  state.cursor = 0;
  state.effectCursor = 0;
  getMessages.mockReset();
  prompt.mockReset();
  steer.mockReset();
  followUp.mockReset();
}

const loaded = (text: string) => ({ role: "user", content: text, timestamp: 1 });

describe("useConversation generation and targeted rollback regressions", () => {
  it("does not let a late load overwrite the newly selected session", async () => {
    resetHarness();
    const oldLoad = deferred<any>();
    const newLoad = deferred<any>();
    getMessages.mockImplementation((path: string) => path === "old" ? oldLoad.promise : newLoad.promise);

    render("old");
    flushEffects();
    render("new");
    flushEffects();

    newLoad.resolve({ messages: [loaded("new history")], forkPoints: [] });
    await newLoad.promise;
    render("new");
    oldLoad.resolve({ messages: [loaded("old history")], forkPoints: [] });
    await oldLoad.promise;
    render("new");

    expect(state.result.messages.map((message: any) => message.content)).toEqual(["new history"]);
  });

  it("shows a cached transcript immediately while a switched-back session refreshes", async () => {
    resetHarness();
    const oldLoad = deferred<any>();
    const newLoad = deferred<any>();
    getMessages.mockImplementation((path: string) => path === "old" ? oldLoad.promise : newLoad.promise);

    render("old");
    flushEffects();
    oldLoad.resolve({ messages: [loaded("old history")], forkPoints: [] });
    await oldLoad.promise;
    render("old");

    render("new");
    flushEffects();
    newLoad.resolve({ messages: [loaded("new history")], forkPoints: [] });
    await newLoad.promise;
    render("new");

    // The refresh for the old session is still pending, but its last committed
    // transcript should be visible instead of a blank working-state row.
    getMessages.mockImplementation(() => new Promise(() => undefined));
    render("old");
    flushEffects();
    render("old");

    expect(state.result.messages.map((message: any) => message.content)).toEqual(["old history"]);
    expect(state.result.loading).toBe(true);
  });

  it("does not reload the same session during a StrictMode effect replay", async () => {
    resetHarness();
    getMessages.mockResolvedValue({ messages: [loaded("history")], forkPoints: [] });

    render("session");
    flushEffects();
    await Promise.resolve();
    render("session");

    // StrictMode performs the effect cleanup and setup again without changing
    // dependencies. Re-run the recorded effect to model that replay.
    const effect = state.effects[1] as any;
    effect.cleanup?.();
    effect.run = true;
    flushEffects();
    await Promise.resolve();

    expect(getMessages).toHaveBeenCalledTimes(1);
  });

  it("preserves content indexes when streaming resumes partway through a message", async () => {
    resetHarness();
    getMessages.mockResolvedValue({ messages: [loaded("history")], forkPoints: [] });
    render("session");
    flushEffects();
    await Promise.resolve();
    render("session");

    const listener = vi.mocked(sessionEvents.subscribe).mock.lastCall?.[0];
    expect(listener).toBeDefined();
    listener?.({
      sessionPath: "session",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "resumed" },
      },
    });
    const partial = render("session").partial;
    expect(partial).toHaveLength(3);
    expect(0 in partial).toBe(false);
    expect(1 in partial).toBe(false);
    expect(partial[2]).toEqual({ type: "text", text: "resumed" });

    listener?.({
      sessionPath: "session",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "earlier" },
      },
    });
    const updated = render("session").partial;
    expect(0 in partial).toBe(false);
    expect(updated[0]).toEqual({ type: "text", text: "earlier" });
    expect(updated[2]).toEqual({ type: "text", text: "resumed" });
  });

  it("skips missing tool result blocks in streamed updates and final results", async () => {
    resetHarness();
    getMessages.mockResolvedValue({ messages: [], forkPoints: [] });
    render("session");
    flushEffects();
    await Promise.resolve();
    render("session");

    const listener = vi.mocked(sessionEvents.subscribe).mock.lastCall?.[0];
    expect(listener).toBeDefined();
    listener?.({
      sessionPath: "session",
      event: {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "read",
        partialResult: { content: [undefined, null, { type: "text", text: "partial" }] },
      },
    });
    const running = render("session").toolExecutions["tool-1"];
    expect(running.output).toBe("partial");
    expect(running.result).toEqual([{ type: "text", text: "partial" }]);
    expect(running.running).toBe(true);

    listener?.({
      sessionPath: "session",
      event: {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: [null, { type: "text", text: "finished" }] },
      },
    });
    const finished = render("session").toolExecutions["tool-1"];
    expect(finished.result).toEqual([{ type: "text", text: "finished" }]);
    expect(finished.running).toBe(false);
  });

  it("rolls back only the failed optimistic send when sends run concurrently", async () => {
    resetHarness();
    getMessages.mockResolvedValue({ messages: [], forkPoints: [] });
    render("session");
    flushEffects();
    await Promise.resolve();
    render("session");

    const first = deferred<{ ok: true }>();
    const second = deferred<{ ok: true }>();
    prompt.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const sendOne = state.result.send("first", "prompt");
    const sendTwo = state.result.send("second", "prompt");
    first.reject(new Error("first failed"));
    await sendOne;
    second.resolve({ ok: true });
    await sendTwo;
    render("session");

    expect(state.result.messages.map((message: any) => message.content)).toEqual(["second"]);
    expect(state.result.error).toBe("first failed");
  });

  it("does not absorb a no-start message_end into a matching historical assistant", async () => {
    resetHarness();
    const historical = {
      role: "assistant",
      responseId: "response-1",
      content: [{ type: "text", text: "same" }],
      timestamp: 1,
    };
    getMessages.mockResolvedValue({ messages: [historical], forkPoints: [] });
    render("session");
    flushEffects();
    await Promise.resolve();
    render("session");

    const listener = vi.mocked(sessionEvents.subscribe).mock.lastCall?.[0];
    listener?.({
      sessionPath: "session",
      event: { type: "message_end", message: { ...historical, timestamp: 2 } },
    });
    render("session");

    expect(state.result.messages).toHaveLength(2);
    expect(state.result.messages.map((message: any) => message.role)).toEqual(["assistant", "assistant"]);
  });

  it("does not replace an older assistant prefix from a different response", async () => {
    resetHarness();
    const historical = {
      role: "assistant",
      responseId: "old-response",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1,
    };
    getMessages.mockResolvedValue({ messages: [historical], forkPoints: [] });
    render("session");
    flushEffects();
    await Promise.resolve();
    render("session");
    const listener = vi.mocked(sessionEvents.subscribe).mock.lastCall?.[0];
    listener?.({
      sessionPath: "session",
      event: { type: "message_start", message: { role: "assistant", responseId: "new-response" } },
    });
    listener?.({
      sessionPath: "session",
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          responseId: "new-response",
          content: [{ type: "text", text: "hello world" }],
          timestamp: 2,
        },
      },
    });
    render("session");
    expect(state.result.messages.map((message: any) => message.responseId)).toEqual([
      "old-response",
      "new-response",
    ]);
  });

  it("consumes identical optimistic users one occurrence at a time", async () => {
    resetHarness();
    getMessages.mockResolvedValue({ messages: [], forkPoints: [] });
    prompt.mockResolvedValue({ ok: true });
    render("session");
    flushEffects();
    await Promise.resolve();
    render("session");

    await state.result.send("same", "prompt");
    await state.result.send("same", "prompt");
    const listener = vi.mocked(sessionEvents.subscribe).mock.lastCall?.[0];
    const first = { role: "user", content: "same", timestamp: 10 };
    const second = { role: "user", content: "same", timestamp: 11 };
    listener?.({ sessionPath: "session", event: { type: "message_start", message: first } });
    listener?.({ sessionPath: "session", event: { type: "message_start", message: second } });
    listener?.({ sessionPath: "session", event: { type: "message_end", message: { ...first } } });
    listener?.({ sessionPath: "session", event: { type: "message_end", message: { ...second } } });
    render("session");

    expect(state.result.messages.map((message: any) => message.content)).toEqual(["same", "same"]);
  });

  it("recovers mixed sparse thinking, text, and tool-call blocks", async () => {
    resetHarness();
    getMessages.mockResolvedValue({ messages: [], forkPoints: [] });
    render("session");
    flushEffects();
    await Promise.resolve();
    render("session");
    const listener = vi.mocked(sessionEvents.subscribe).mock.lastCall?.[0];
    listener?.({ sessionPath: "session", event: { type: "message_start", message: { role: "assistant" } } });
    listener?.({ sessionPath: "session", event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "think" } } });
    listener?.({ sessionPath: "session", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: "answer" } } });
    listener?.({ sessionPath: "session", event: { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 5, id: "call-1", toolName: "read" } } });
    listener?.({ sessionPath: "session", event: { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 5, toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } } } } });
    const partial = render("session").partial;

    expect(partial?.[1]).toEqual({ type: "thinking", thinking: "think" });
    expect(partial?.[3]).toEqual({ type: "text", text: "answer" });
    expect(partial?.[5]).toEqual({ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } });
  });

  it("does not let a session switch callback repaint the next session", async () => {
    resetHarness();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    getMessages.mockResolvedValue({ messages: [], forkPoints: [] });
    render("old");
    flushEffects();
    await Promise.resolve();
    render("old");
    const listener = vi.mocked(sessionEvents.subscribe).mock.lastCall?.[0];
    listener?.({ sessionPath: "old", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "old" } } });
    const oldFrame = frames.get(1);
    render("new");
    flushEffects();
    oldFrame?.(0);
    expect(render("new").partial).toBeNull();
    vi.unstubAllGlobals();
  });

  it("invalidates a queued animation frame when message_end publishes", async () => {
    resetHarness();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    getMessages.mockResolvedValue({ messages: [], forkPoints: [] });
    render("session");
    flushEffects();
    await Promise.resolve();
    render("session");
    const listener = vi.mocked(sessionEvents.subscribe).mock.lastCall?.[0];
    listener?.({ sessionPath: "session", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "old" } } });
    const oldFrame = frames.get(1);
    listener?.({ sessionPath: "session", event: { type: "message_end", message: { role: "assistant", responseId: "done", content: [{ type: "text", text: "complete" }], timestamp: 1 } } });
    oldFrame?.(0);
    render("session");
    expect(state.result.messages.map((message: any) => message.content[0]?.text)).toEqual(["complete"]);

    listener?.({ sessionPath: "session", event: { type: "message_start", message: { role: "assistant", responseId: "next" } } });
    listener?.({ sessionPath: "session", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "next" } } });
    oldFrame?.(0);
    expect(render("session").partial).toEqual([]);
    vi.unstubAllGlobals();
  });
});
