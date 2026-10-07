import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalInfo, TerminalSupport } from "../../lib/types.ts";
import {
  attachShell,
  emitTerminalOutput,
  resetTerminalState,
  subscribeTerminalOutput,
  terminalActions,
  terminalStore,
  terminalsFor,
} from "./terminal-state.ts";

const AVAILABLE: TerminalSupport = { available: true, shells: ["/bin/zsh"] };

function info(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: "t1",
    sessionPath: "sess-1",
    title: "",
    cols: 80,
    rows: 24,
    exitCode: null,
    ...overrides,
  };
}

/**
 * Answer the one endpoint these tests reach.
 *
 * `api` has no seam of its own, so the stub sits on `fetch` and parses the URL
 * the same way the server does — a `sessionPath` of `""` is the host-only probe.
 */
function stubFetch(support: TerminalSupport, terminals: TerminalInfo[]): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    seen.push(url);
    const sessionPath = new URL(url, "http://localhost").searchParams.get("sessionPath") ?? "";
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () =>
        Promise.resolve(
          JSON.stringify({
            support,
            terminals: sessionPath.length > 0 ? terminals : [],
          }),
        ),
    });
  });
  return seen;
}

beforeEach(() => {
  resetTerminalState();
});

afterEach(() => {
  resetTerminalState();
  vi.unstubAllGlobals();
});

describe("output fan-out", () => {
  it("hands a frame to the listener watching that shell", () => {
    const got: string[] = [];
    subscribeTerminalOutput("t1", (data) => got.push(data));
    emitTerminalOutput("t1", "hello");
    expect(got).toEqual(["hello"]);
  });

  it("routes by id, so one tab never sees another shell's output", () => {
    const a: string[] = [];
    const b: string[] = [];
    subscribeTerminalOutput("t1", (data) => a.push(data));
    subscribeTerminalOutput("t2", (data) => b.push(data));
    emitTerminalOutput("t2", "for-b");
    expect(a).toEqual([]);
    expect(b).toEqual(["for-b"]);
  });

  it("drops a frame nobody is watching rather than queueing it", () => {
    // The point of the out-of-band channel: an unmounted tab costs nothing, and
    // a shell that keeps printing while its tab is away does not grow a buffer.
    expect(() => emitTerminalOutput("t1", "into the void")).not.toThrow();
  });

  it("stops delivering once the subscription is dropped", () => {
    const got: string[] = [];
    const stop = subscribeTerminalOutput("t1", (data) => got.push(data));
    stop();
    emitTerminalOutput("t1", "after");
    expect(got).toEqual([]);
  });

  it("keeps the other listeners when one throws", () => {
    const got: string[] = [];
    subscribeTerminalOutput("t1", () => {
      throw new Error("disposed mid-write");
    });
    subscribeTerminalOutput("t1", (data) => got.push(data));
    emitTerminalOutput("t1", "still delivered");
    expect(got).toEqual(["still delivered"]);
  });
});

describe("refresh and probe", () => {
  it("records the host's answer and one session's shells together", async () => {
    stubFetch(AVAILABLE, [info()]);
    const answer = await terminalActions.refresh("sess-1");
    expect(answer.support).toEqual(AVAILABLE);
    expect(terminalStore.get().support).toEqual(AVAILABLE);
    expect(terminalsFor(terminalStore.get(), "sess-1")).toHaveLength(1);
  });

  it("asks about the host alone, with an empty session path", async () => {
    const seen = stubFetch(AVAILABLE, [info()]);
    await terminalActions.probe();
    expect(seen).toEqual(["/api/terminal?sessionPath="]);
    expect(terminalStore.get().support).toEqual(AVAILABLE);
    // A probe is not allowed to invent a shell list for a session it never
    // named — the menu only wanted to know whether to offer the entry.
    expect(terminalStore.get().bySession).toEqual({});
  });

  it("replaces one session's list without touching another's", async () => {
    stubFetch(AVAILABLE, [info({ id: "a", sessionPath: "sess-1" })]);
    await terminalActions.refresh("sess-1");

    stubFetch(AVAILABLE, [info({ id: "b", sessionPath: "sess-2" })]);
    await terminalActions.refresh("sess-2");

    const state = terminalStore.get();
    expect(terminalsFor(state, "sess-1").map((item) => item.id)).toEqual(["a"]);
    expect(terminalsFor(state, "sess-2").map((item) => item.id)).toEqual(["b"]);
  });
});

describe("lifecycle notes", () => {  it("adds a shell once, however many times the body reports it", () => {
    terminalActions.noteAdded(info());
    terminalActions.noteAdded(info());
    expect(terminalsFor(terminalStore.get(), "sess-1")).toHaveLength(1);
  });

  it("records an exit against the shell that left", () => {
    terminalActions.noteAdded(info());
    terminalActions.noteExit("t1", 130);
    expect(terminalsFor(terminalStore.get(), "sess-1")[0]?.exitCode).toBe(130);
  });

  it("leaves other shells alone when one exits", () => {
    terminalActions.noteAdded(info({ id: "t1" }));
    terminalActions.noteAdded(info({ id: "t2" }));
    terminalActions.noteExit("t2", 0);
    const list = terminalsFor(terminalStore.get(), "sess-1");
    expect(list.find((item) => item.id === "t1")?.exitCode).toBeNull();
    expect(list.find((item) => item.id === "t2")?.exitCode).toBe(0);
  });

  it("drops a shell the host no longer has", () => {
    terminalActions.noteAdded(info({ id: "t1" }));
    terminalActions.noteAdded(info({ id: "t2" }));
    terminalActions.forget("t1");
    expect(terminalsFor(terminalStore.get(), "sess-1").map((item) => item.id)).toEqual(["t2"]);
  });

  it("reports an unknown session as having no shells", () => {
    expect(terminalsFor(terminalStore.get(), "never-asked")).toEqual([]);
  });
});

describe("release", () => {
  it("tells the host to close the shell and forgets it", async () => {
    const seen = stubRoutes({ "DELETE /api/terminal/t1": { closed: true } });
    terminalActions.noteAdded(info());
    terminalActions.release("t1");

    expect(terminalsFor(terminalStore.get(), "sess-1")).toEqual([]);
    // The call itself is what frees the slot; without it a host that caps the
    // shells it keeps would fill up with ones nobody can reach.
    await vi.waitFor(() => expect(seen).toEqual(["DELETE /api/terminal/t1"]));
  });

  it("forgets the shell even when the host has already lost it", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: () => Promise.resolve(JSON.stringify({ error: "终端不存在" })),
      }),
    );
    terminalActions.noteAdded(info());
    terminalActions.release("t1");

    expect(terminalsFor(terminalStore.get(), "sess-1")).toEqual([]);
    // The rejection is swallowed rather than surfacing as an unhandled one.
    await Promise.resolve();
  });
});

/**
 * Route one request per method+path.
 *
 * `attachShell` talks to up to three endpoints to answer one question, and
 * *which* of them it reaches is the behaviour under test — so the stub records
 * every call and a test can assert on the sequence.
 */
function stubRoutes(routes: Record<string, unknown>): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    seen.push(key);
    if (!(key in routes)) {
      return Promise.reject(new Error(`unstubbed request: ${key}`));
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(JSON.stringify(routes[key])),
    });
  });
  return seen;
}

describe("attachShell", () => {
  const attach = { sessionPath: "sess-1", projectPath: "/tmp/demo", cols: 80, rows: 24 };

  it("reattaches to the shell the tab remembers, and replays its screen", async () => {
    const seen = stubRoutes({
      "GET /api/terminal?sessionPath=sess-1": {
        support: AVAILABLE,
        terminals: [info({ id: "t9" })],
      },
      "GET /api/terminal/t9": { scrollback: "$ echo hi\r\nhi\r\n" },
    });

    const attached = await attachShell({ ...attach, knownId: "t9" });
    expect(attached.info.id).toBe("t9");
    expect(attached.scrollback).toBe("$ echo hi\r\nhi\r\n");
    // Nothing was opened: that is the whole point of remembering the id.
    expect(seen).toEqual([
      "GET /api/terminal?sessionPath=sess-1",
      "GET /api/terminal/t9",
    ]);
  });

  it("opens a new shell when the remembered one has already exited", async () => {
    const seen = stubRoutes({
      "GET /api/terminal?sessionPath=sess-1": {
        support: AVAILABLE,
        terminals: [info({ id: "t9", exitCode: 0 })],
      },
      "POST /api/terminal": info({ id: "t-new" }),
    });

    const attached = await attachShell({ ...attach, knownId: "t9" });
    expect(attached.info.id).toBe("t-new");
    expect(attached.scrollback).toBe("");
    // An exited shell is still in the list — it has something left to read —
    // but reattaching to it would draw a dead screen with no way forward, so a
    // second one is opened and joins it in the store.
    expect(seen).toContain("POST /api/terminal");
    expect(terminalsFor(terminalStore.get(), "sess-1").map((item) => item.id)).toEqual([
      "t9",
      "t-new",
    ]);
  });

  it("starts the shell in the session's workspace, at the size already measured", async () => {
    let body: unknown;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "POST") body = JSON.parse(String(init.body));
      const payload =
        init?.method === "POST"
          ? info({ id: "t-new" })
          : { support: AVAILABLE, terminals: [] };
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve(JSON.stringify(payload)),
      });
    });

    await attachShell({ ...attach, knownId: "" });
    expect(body).toEqual({
      sessionPath: "sess-1",
      cwd: "/tmp/demo",
      cols: 80,
      rows: 24,
    });
  });

  it("refuses with the host's own reason when no shells can be opened", async () => {
    // The graceful-degradation path: `node-pty` is an optional dependency, so
    // "this host cannot do shells" is an answer, and the reason is what the tab
    // puts on screen. Nothing is attempted, and nothing is registered.
    stubRoutes({
      "GET /api/terminal?sessionPath=sess-1": {
        support: { available: false, reason: "node-pty 未安装", shells: [] },
        terminals: [],
      },
    });

    await expect(attachShell({ ...attach, knownId: "" })).rejects.toThrow("node-pty 未安装");
    expect(terminalsFor(terminalStore.get(), "sess-1")).toEqual([]);
  });

  it("picks the remembered shell out of a session's several", async () => {
    const seen = stubRoutes({
      "GET /api/terminal?sessionPath=sess-1": {
        support: AVAILABLE,
        terminals: [info({ id: "t1" }), info({ id: "t2" }), info({ id: "t3", exitCode: 7 })],
      },
      "GET /api/terminal/t2": { scrollback: "t2's screen" },
    });

    const attached = await attachShell({ ...attach, knownId: "t2" });
    expect(attached.scrollback).toBe("t2's screen");
    expect(seen).toEqual([
      "GET /api/terminal?sessionPath=sess-1",
      "GET /api/terminal/t2",
    ]);
  });
});
