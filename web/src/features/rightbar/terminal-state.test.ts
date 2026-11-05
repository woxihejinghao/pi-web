import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TerminalEnvironment,
  TerminalInfo,
  TerminalShell,
  TerminalSupport,
} from "../../lib/types.ts";
import {
  attachShell,
  emitTerminalOutput,
  TerminalGoneError,
  resetTerminalState,
  resyncTerminal,
  shellName,
  subscribeTerminalOutput,
  takeControl,
  terminalActions,
  terminalStore,
  terminalTitle,
  terminalsFor,
} from "./terminal-state.ts";

const SHELL: TerminalShell = { path: "/bin/zsh", name: "zsh", args: ["-i"] };
const DEFAULT_SHELL: TerminalShell = { path: "/bin/bash", name: "bash", args: ["-i"] };
const ENVIRONMENT: TerminalEnvironment = {
  cwd: "/tmp",
  maxCols: 500,
  maxRows: 200,
  maxInputBytes: 65536,
  scrollback: 1000,
};
const AVAILABLE: TerminalSupport = { available: true };
const UNAVAILABLE: TerminalSupport = { available: false, reason: "node-pty is not installed" };

function info(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: "t1",
    sessionPath: "sess-1",
    title: "",
    shell: SHELL,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    state: "running",
    exitCode: null,
    ...overrides,
  };
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Answer with a JSON body chosen by URL; every call is recorded. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = handler(url, init);
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  });
  return calls;
}

function bodyOf(call: Call): Record<string, unknown> {
  return typeof call.init?.body === "string"
    ? (JSON.parse(call.init.body) as Record<string, unknown>)
    : {};
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
    const got: Array<{ sequence: number; data: string }> = [];
    subscribeTerminalOutput("t1", (frame) => got.push(frame));
    emitTerminalOutput("t1", { sequence: 1, data: "hello" });
    expect(got).toEqual([{ sequence: 1, data: "hello" }]);
  });

  it("routes by id, so one tab never sees another shell's output", () => {
    const a: string[] = [];
    const b: string[] = [];
    subscribeTerminalOutput("t1", (frame) => a.push(frame.data));
    subscribeTerminalOutput("t2", (frame) => b.push(frame.data));
    emitTerminalOutput("t2", { sequence: 1, data: "for-b" });
    expect(a).toEqual([]);
    expect(b).toEqual(["for-b"]);
  });

  it("stops delivering after unsubscribe", () => {
    const got: string[] = [];
    const stop = subscribeTerminalOutput("t1", (frame) => got.push(frame.data));
    emitTerminalOutput("t1", { sequence: 1, data: "one" });
    stop();
    emitTerminalOutput("t1", { sequence: 2, data: "two" });
    expect(got).toEqual(["one"]);
  });

  it("drops output for an id nobody watches", () => {
    expect(() => {
      emitTerminalOutput("gone", { sequence: 9, data: "x" });
    }).not.toThrow();
  });
});

describe("naming", () => {
  it("strips the path and a Windows extension", () => {
    expect(shellName("/bin/zsh")).toBe("zsh");
    expect(shellName("C:\\Program Files\\PowerShell\\pwsh.exe")).toBe("pwsh");
  });

  it("prefers the user's title over the program's name", () => {
    expect(terminalTitle(info())).toBe("zsh");
    expect(terminalTitle(info({ title: "build" }))).toBe("build");
  });
});

describe("refresh and the host probe", () => {
  it("stores support, the environment and one session's shells", async () => {
    stubFetch((url) => {
      expect(url).toContain("sessionPath=sess-1");
      return { support: AVAILABLE, environment: ENVIRONMENT, terminals: [info()] };
    });
    const answer = await terminalActions.refresh("sess-1");
    expect(answer.terminals).toHaveLength(1);
    expect(terminalStore.get().support).toEqual(AVAILABLE);
    expect(terminalStore.get().environment).toEqual(ENVIRONMENT);
    expect(terminalsFor(terminalStore.get(), "sess-1")).toHaveLength(1);
  });

  it("probes without discarding another session's list", async () => {
    terminalActions.noteAdded(info());
    stubFetch(() => ({ support: AVAILABLE, environment: ENVIRONMENT, terminals: [] }));
    await terminalActions.probe();
    expect(terminalsFor(terminalStore.get(), "sess-1")).toHaveLength(1);
    expect(terminalStore.get().support).toEqual(AVAILABLE);
  });
});

describe("shell discovery", () => {
  it("loads once and remembers the execution default", async () => {
    const calls = stubFetch(() => ({ shells: [SHELL, DEFAULT_SHELL], default: DEFAULT_SHELL }));
    await terminalActions.loadShells();
    await terminalActions.loadShells();
    expect(calls).toHaveLength(1);
    expect(terminalStore.get().shells).toEqual([SHELL, DEFAULT_SHELL]);
    expect(terminalStore.get().defaultShell).toEqual(DEFAULT_SHELL);
  });

  it("reloads when asked", async () => {
    const calls = stubFetch(() => ({ shells: [SHELL], default: SHELL }));
    await terminalActions.loadShells();
    await terminalActions.loadShells(true);
    expect(calls).toHaveLength(2);
  });
});

describe("state frames", () => {
  it("adds an unknown shell and updates one it has", () => {
    terminalActions.noteAdded(info());
    terminalActions.noteState(info({ state: "exited", exitCode: 3 }));
    const list = terminalsFor(terminalStore.get(), "sess-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.state).toBe("exited");
    expect(list[0]?.exitCode).toBe(3);
  });

  it("forgets a shell without touching other sessions", () => {
    terminalActions.noteAdded(info());
    terminalActions.noteAdded(info({ id: "t2", sessionPath: "sess-2" }));
    terminalActions.forget("t1");
    expect(terminalsFor(terminalStore.get(), "sess-1")).toHaveLength(0);
    expect(terminalsFor(terminalStore.get(), "sess-2")).toHaveLength(1);
  });

  it("renames through the host and stores the answer", async () => {
    stubFetch(() => info({ title: "build" }));
    await terminalActions.rename("t1", "build");
    expect(terminalsFor(terminalStore.get(), "sess-1")[0]?.title).toBe("build");
  });
});

describe("attachShell", () => {
  const base = {
    sessionPath: "sess-1",
    projectPath: "/work",
    cols: 100,
    rows: 30,
    attachmentId: "a1",
  };

  it("attaches to a running shell it remembers and reports the id first", async () => {
    const seen: string[] = [];
    const calls = stubFetch((url) => {
      if (url.includes("/attach")) {
        return { info: info({ controllerId: "a1" }), screen: "prompt$ ", sequence: 7 };
      }
      return { support: AVAILABLE, environment: ENVIRONMENT, terminals: [info()] };
    });
    const connected = await attachShell({
      ...base,
      knownId: "t1",
      openId: "fresh",
      onId: (id) => seen.push(id),
    });
    expect(seen).toEqual(["t1"]);
    expect(connected.screen).toBe("prompt$ ");
    expect(connected.sequence).toBe(7);
    expect(connected.attachmentId).toBe("a1");
    const attach = calls.find((call) => call.url.includes("/attach"));
    expect(bodyOf(attach as Call)).toEqual({ attachmentId: "a1" });
  });

  it("reads a finished shell without taking control", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/snapshot")) {
        return { info: info({ state: "exited", exitCode: 0 }), screen: "done", sequence: 12 };
      }
      return {
        support: AVAILABLE,
        environment: ENVIRONMENT,
        terminals: [info({ state: "exited", exitCode: 0 })],
      };
    });
    const connected = await attachShell({ ...base, knownId: "t1", openId: "fresh" });
    expect(connected.attachmentId).toBe("");
    expect(connected.screen).toBe("done");
    expect(calls.some((call) => call.url.includes("/attach"))).toBe(false);
  });

  it("opens a shell with the caller's id and shell choice, then attaches", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("sessionPath=")) {
        return { support: AVAILABLE, environment: ENVIRONMENT, terminals: [] };
      }
      if (url.endsWith("/api/terminal")) return info({ id: "opened" });
      if (url.includes("/attach")) {
        return { info: info({ id: "opened", controllerId: "a1" }), screen: "", sequence: 0 };
      }
      throw new Error(`unexpected ${url}`);
    });
    const connected = await attachShell({
      ...base,
      knownId: "",
      openId: "opened",
      shellPath: "/bin/bash",
    });
    expect(connected.info.id).toBe("opened");
    const create = calls.find(
      (call) => call.url.endsWith("/api/terminal") && call.init?.method === "POST",
    );
    expect(bodyOf(create as Call)).toMatchObject({
      id: "opened",
      shellPath: "/bin/bash",
      cwd: "/work",
    });
  });

  it("reports a remembered shell the host no longer has instead of replacing it", async () => {
    const calls = stubFetch(() => ({
      support: AVAILABLE,
      environment: ENVIRONMENT,
      terminals: [],
    }));
    await expect(
      attachShell({ ...base, knownId: "gone", openId: "fresh" }),
    ).rejects.toBeInstanceOf(TerminalGoneError);
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
  });

  it("refuses to open one when the host has no shells", async () => {
    stubFetch(() => ({ support: UNAVAILABLE, environment: ENVIRONMENT, terminals: [] }));
    await expect(attachShell({ ...base, knownId: "", openId: "fresh" })).rejects.toThrow(
      "node-pty is not installed",
    );
  });
});

describe("control transfer and repair", () => {
  it("takes control through attach and stores the new controller", async () => {
    stubFetch(() => ({ info: info({ controllerId: "a2" }), screen: "screen", sequence: 4 }));
    const snapshot = await takeControl("t1", "a2");
    expect(snapshot.sequence).toBe(4);
    expect(terminalsFor(terminalStore.get(), "sess-1")[0]?.controllerId).toBe("a2");
  });

  it("resyncs with the snapshot endpoint and leaves control alone", async () => {
    const calls = stubFetch(() => ({
      info: info({ controllerId: "a2" }),
      screen: "screen",
      sequence: 5,
    }));
    await resyncTerminal("t1");
    expect(calls[0]?.url).toContain("/snapshot");
    expect(terminalsFor(terminalStore.get(), "sess-1")[0]?.controllerId).toBe("a2");
  });
});

describe("release", () => {
  it("forgets the shell and asks the host to close it", () => {
    const calls = stubFetch(() => ({ closed: true }));
    terminalActions.noteAdded(info());
    terminalActions.release("t1");
    expect(terminalsFor(terminalStore.get(), "sess-1")).toHaveLength(0);
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});
