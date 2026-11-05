import { describe, expect, it } from "vitest";
import { EventBus, type BusEvent } from "./bus.ts";
import { HttpError } from "./errors.ts";
import {
  ATTACHMENT_TIMEOUT_MS,
  FLUSH_MS,
  MAX_INPUT_BYTES,
  MAX_TERMINALS,
  TerminalManager,
  discoverShells,
  type PtyDisposable,
  type PtyModule,
  type PtyProcess,
} from "./terminal.ts";

/**
 * A PTY whose entire behavior the test decides.
 *
 * The real one is replaced rather than driven: a shell is a moving target —
 * bash version, prompt, `stty` output and startup banner all differ per machine
 * — so a test that asserted on its bytes would fail on somebody else's laptop.
 * What is worth pinning down is this module's own contract: what it forwards,
 * what it coalesces, what it publishes, and what it does when the shell ends.
 */
class FakePty implements PtyProcess {
  readonly pid = 4242;
  cols: number;
  rows: number;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = 0;
  killError: Error | null = null;
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(event: { exitCode: number }) => void> = [];

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  onData(listener: (data: string) => void): PtyDisposable {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        const index = this.dataListeners.indexOf(listener);
        if (index >= 0) this.dataListeners.splice(index, 1);
      },
    };
  }

  onExit(listener: (event: { exitCode: number }) => void): PtyDisposable {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        const index = this.exitListeners.indexOf(listener);
        if (index >= 0) this.exitListeners.splice(index, 1);
      },
    };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killed += 1;
    if (this.killError !== null) throw this.killError;
  }

  emit(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  exit(exitCode: number): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode });
  }
}

interface Harness {
  manager: TerminalManager;
  events: BusEvent[];
  spawned: FakePty[];
  spawnedPaths: string[];
  only: <T extends BusEvent["type"]>(type: T) => Array<Extract<BusEvent, { type: T }>>;
}

function harness(
  options: {
    loadModule?: () => PtyModule | null;
    idleTimeoutMs?: number;
    now?: () => number;
  } = {},
): Harness {
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const spawned: FakePty[] = [];
  const spawnedPaths: string[] = [];
  const module: PtyModule = {
    spawn: (file, _args, opts) => {
      spawnedPaths.push(file);
      const pty = new FakePty(opts.cols, opts.rows);
      spawned.push(pty);
      return pty;
    },
  };
  const manager = new TerminalManager({
    bus,
    loadModule: options.loadModule ?? (() => module),
    reapIntervalMs: 0,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    manager,
    events,
    spawned,
    spawnedPaths,
    only: <T extends BusEvent["type"]>(type: T) =>
      events.filter((event): event is Extract<BusEvent, { type: T }> => event.type === type),
  };
}

const SETTLE = FLUSH_MS + 40;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE));
}

function open(h: Harness, overrides: { id?: string; sessionPath?: string } = {}): string {
  const info = h.manager.create({
    ...(overrides.id === undefined ? {} : { id: overrides.id }),
    sessionPath: overrides.sessionPath ?? "draft:a",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
  });
  return info.id;
}

describe("shell discovery", () => {
  it("offers at least one shell, with a usable default first", () => {
    const shells = discoverShells();
    expect(shells.length).toBeGreaterThan(0);
    const first = shells[0]!;
    expect(first.path.length).toBeGreaterThan(0);
    expect(first.name.length).toBeGreaterThan(0);
    expect(Array.isArray(first.args)).toBe(true);
  });

  it("dedupes by executable name and gives sh-like shells -i", () => {
    const shells = discoverShells();
    const names = shells.map((shell) => shell.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const shell of shells) {
      if (["sh", "bash", "zsh", "fish", "dash", "ksh"].includes(shell.name.toLowerCase())) {
        expect(shell.args).toEqual(["-i"]);
      }
    }
  });
});

describe("TerminalManager support", () => {
  it("answers that shells are available when the optional module loads", () => {
    const h = harness();
    expect(h.manager.support()).toEqual({ available: true });
  });

  it("reports why when the module will not load", () => {
    const h = harness({
      loadModule: () => {
        throw new Error("no prebuilt binary");
      },
    });
    expect(h.manager.support()).toEqual({ available: false, reason: "no prebuilt binary" });
  });

  it("reports the same failure when the module answers null", () => {
    const h = harness({ loadModule: () => null });
    expect(h.manager.support().available).toBe(false);
    expect(h.manager.support().reason).toContain("node-pty");
  });

  it("stops trying after the first failure", () => {
    let calls = 0;
    const h = harness({
      loadModule: () => {
        calls += 1;
        throw new Error("gone");
      },
    });
    h.manager.support();
    h.manager.support();
    expect(calls).toBe(1);
  });

  it("still lists shells when the native module is unavailable", () => {
    const h = harness({ loadModule: () => null });
    expect(h.manager.shells().length).toBeGreaterThan(0);
    expect(h.manager.environment().maxCols).toBe(500);
  });
});

describe("TerminalManager create", () => {
  it("spawns the requested shell, with the requested size and directory", () => {
    const h = harness();
    const shell = h.manager.shells()[0]!;
    const info = h.manager.create({
      id: "t-1",
      sessionPath: "draft:a",
      cwd: "/tmp/project",
      cols: 100,
      rows: 30,
      shellPath: shell.path,
    });
    expect(info.id).toBe("t-1");
    expect(info.state).toBe("running");
    expect(info.title).toBe(shell.name);
    expect(info.shell.path).toBe(shell.path);
    expect(info.cols).toBe(100);
    expect(info.rows).toBe(30);
    expect(info.controllerId).toBeUndefined();
    expect(h.spawnedPaths).toEqual([shell.path]);
    expect(h.spawned[0]!.cols).toBe(100);
  });

  it("answers 503 — not 400 — when this host cannot run a shell", () => {
    const h = harness({ loadModule: () => null });
    expect(() =>
      h.manager.create({ sessionPath: "s", cwd: "/tmp", cols: 80, rows: 24 }),
    ).toThrow(HttpError);
  });

  it("is idempotent for the same id and session", () => {
    const h = harness();
    const first = open(h, { id: "same" });
    const second = open(h, { id: "same" });
    expect(second).toBe(first);
    expect(h.spawned).toHaveLength(1);
  });

  it("refuses an id that another session already owns", () => {
    const h = harness();
    open(h, { id: "same", sessionPath: "a" });
    expect(() => open(h, { id: "same", sessionPath: "b" })).toThrow(/占用/);
  });

  it("refuses to resurrect a closed id", () => {
    const h = harness();
    const id = open(h, { id: "gone" });
    h.manager.close(id);
    expect(() => open(h, { id: "gone" })).toThrow(/已关闭/);
  });

  it("counts finished shells toward the cap", () => {
    const h = harness();
    for (let index = 0; index < MAX_TERMINALS; index += 1) open(h);
    h.spawned[0]!.exit(0);
    expect(() => open(h)).toThrow(HttpError);
  });

  it("clamps a size no PTY could honour", () => {
    const h = harness();
    open(h);
    expect(h.spawned[0]!.cols).toBe(80);
    expect(h.spawned[0]!.rows).toBe(24);
    const info = h.manager.create({
      sessionPath: "draft:a",
      cwd: "/tmp",
      cols: 10_000,
      rows: -3,
    });
    expect(info.cols).toBe(500);
    expect(info.rows).toBe(2);
  });

  it("rejects a shell that is not installed", () => {
    const h = harness();
    expect(() =>
      h.manager.create({
        sessionPath: "s",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        shellPath: "/definitely/not/a/shell",
      }),
    ).toThrow(HttpError);
  });
});

describe("TerminalManager output", () => {
  it("coalesces a burst into one sequenced frame", async () => {
    const h = harness();
    open(h);
    const pty = h.spawned[0]!;
    pty.emit("a");
    pty.emit("b");
    pty.emit("c");
    await settle();
    const frames = h.only("terminal_output");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe("abc");
    expect(frames[0]!.sequence).toBe(1);
  });

  it("separates bursts further apart than the interval, in order", async () => {
    const h = harness();
    open(h);
    const pty = h.spawned[0]!;
    pty.emit("one");
    await settle();
    pty.emit("two");
    await settle();
    expect(h.only("terminal_output").map((frame) => frame.sequence)).toEqual([1, 2]);
  });

  it("hands a late attachment the screen it missed", async () => {
    const h = harness();
    const id = open(h);
    h.spawned[0]!.emit("hello ");
    h.spawned[0]!.emit("world");
    await settle();
    const snapshot = await h.manager.attach(id, "a1");
    expect(snapshot.screen).toContain("hello world");
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.info.controllerId).toBe("a1");
  });

  it("refuses a screen for an unknown id", async () => {
    const h = harness();
    await expect(h.manager.attach("nope", "a1")).rejects.toThrow(/不存在/);
  });
});

describe("TerminalManager attachment and input", () => {
  it("makes the newest attachment the controller", async () => {
    const h = harness();
    const id = open(h);
    await h.manager.attach(id, "a1");
    await h.manager.attach(id, "a2");
    expect(h.manager.list()[0]!.controllerId).toBe("a2");
    expect(() => h.manager.write(id, "a1", "x")).toThrow(/接管/);
    h.manager.write(id, "a2", "ok");
    expect(h.spawned[0]!.writes).toEqual(["ok"]);
  });

  it("rejects a write larger than the input cap before it reaches the shell", async () => {
    const h = harness();
    const id = open(h);
    await h.manager.attach(id, "a1");
    expect(() => h.manager.write(id, "a1", "x".repeat(MAX_INPUT_BYTES + 1))).toThrow(HttpError);
    expect(h.spawned[0]!.writes).toHaveLength(0);
  });

  it("drops a keystroke that races the shell's exit", async () => {
    const h = harness();
    const id = open(h);
    await h.manager.attach(id, "a1");
    h.spawned[0]!.exit(0);
    await settle();
    expect(() => h.manager.write(id, "a1", "x")).not.toThrow();
    expect(h.spawned[0]!.writes).toHaveLength(0);
  });

  it("detaching the controller leaves nobody in control", async () => {
    const h = harness();
    const id = open(h);
    await h.manager.attach(id, "a1");
    h.manager.detach(id, "a1");
    expect(h.manager.list()[0]!.controllerId).toBeUndefined();
    expect(() => h.manager.write(id, "a1", "x")).toThrow(/接管/);
  });

  it("resizes only when the size actually changed, and clamps it", async () => {
    const h = harness();
    const id = open(h);
    await h.manager.attach(id, "a1");
    h.manager.resize(id, "a1", 120, 40);
    h.manager.resize(id, "a1", 120, 40);
    h.manager.resize(id, "a1", 9000, 9000);
    expect(h.spawned[0]!.resizes).toEqual([
      [120, 40],
      [500, 200],
    ]);
  });

  it("lets a non-controller read a snapshot without taking control", async () => {
    const h = harness();
    const id = open(h);
    await h.manager.attach(id, "a1");
    const snapshot = await h.manager.snapshot(id);
    expect(snapshot.info.controllerId).toBe("a1");
  });
});

describe("TerminalManager exit and teardown", () => {
  it("flushes output before announcing the exit", async () => {
    const h = harness();
    const id = open(h);
    const pty = h.spawned[0]!;
    pty.emit("goodbye");
    pty.exit(3);
    await settle();
    const output = h.events.findIndex((event) => event.type === "terminal_output");
    const state = h.events.findIndex((event) => event.type === "terminal_state");
    expect(output).toBeGreaterThanOrEqual(0);
    expect(state).toBeGreaterThan(output);
    const info = h.only("terminal_state").at(-1)!.info;
    expect(info.state).toBe("exited");
    expect(info.exitCode).toBe(3);
    expect(info.controllerId).toBeUndefined();
    await expect(h.manager.snapshot(id)).resolves.toMatchObject({ info: { state: "exited" } });
  });

  it("kills on close, announces it, and forgets the id", async () => {
    const h = harness();
    const id = open(h);
    expect(h.manager.close(id)).toBe(true);
    expect(h.manager.close(id)).toBe(false);
    expect(h.manager.list()).toHaveLength(0);
    expect(h.only("terminal_closed")).toHaveLength(1);
    await settle();
    expect(h.spawned[0]!.killed).toBe(1);
  });

  it("keeps a failed kill for a retry", async () => {
    const h = harness();
    const id = open(h);
    h.spawned[0]!.killError = new Error("EBUSY");
    h.manager.close(id);
    await settle();
    expect(h.manager.cleanupFailures()).toEqual([
      { id, sessionPath: "draft:a", message: "EBUSY" },
    ]);
    expect(h.only("terminal_cleanup_failed")).toHaveLength(1);
    h.spawned[0]!.killError = null;
    expect(h.manager.retryCleanup(id)).toBe(true);
    expect(h.manager.cleanupFailures()).toEqual([]);
  });

  it("closes only the shells of the session that went away", () => {
    const h = harness();
    open(h, { sessionPath: "a" });
    open(h, { sessionPath: "a" });
    open(h, { sessionPath: "b" });
    h.manager.closeForSession("a");
    expect(h.manager.list().map((info) => info.sessionPath)).toEqual(["b"]);
  });

  it("takes every shell down at shutdown", () => {
    const h = harness();
    open(h);
    open(h);
    h.manager.stop();
    expect(h.manager.list()).toHaveLength(0);
  });
});

describe("TerminalManager rename and reaping", () => {
  it("trims a title and ignores an empty one", () => {
    const h = harness();
    const id = open(h);
    expect(h.manager.rename(id, "  build  ").title).toBe("build");
    expect(h.manager.rename(id, "   ").title).toBe("build");
    expect(h.manager.rename(id, "x".repeat(500)).title).toHaveLength(120);
  });

  it("reclaims a shell nobody has attached to for the idle timeout", async () => {
    let now = 1_000;
    const h = harness({ idleTimeoutMs: 10_000, now: () => now });
    const id = open(h);
    await h.manager.attach(id, "a1");
    h.manager.detach(id, "a1");
    now += 10_001;
    h.manager.reap(now);
    expect(h.manager.list()).toHaveLength(0);
    expect(h.only("terminal_closed")).toHaveLength(1);
  });

  it("drops an attachment that stopped sending heartbeats", async () => {
    let now = 1_000;
    const h = harness({ now: () => now });
    const id = open(h);
    await h.manager.attach(id, "a1");
    now += ATTACHMENT_TIMEOUT_MS + 1;
    h.manager.reap(now);
    expect(h.manager.list()[0]!.controllerId).toBeUndefined();
    expect(h.only("terminal_state").at(-1)!.info.controllerId).toBeUndefined();
    await h.manager.attach(id, "a2");
    expect(h.manager.list()[0]!.controllerId).toBe("a2");
  });
});

describe("TerminalManager listing", () => {
  it("filters by session", () => {
    const h = harness();
    open(h, { sessionPath: "a" });
    open(h, { sessionPath: "b" });
    expect(h.manager.list("a")).toHaveLength(1);
    expect(h.manager.list("a")[0]!.sessionPath).toBe("a");
    expect(h.manager.list()).toHaveLength(2);
  });
});
