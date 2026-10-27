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
});
