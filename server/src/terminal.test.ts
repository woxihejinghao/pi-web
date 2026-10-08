import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus, type BusEvent } from "./bus.ts";
import { HttpError } from "./errors.ts";
import {
  FLUSH_MS,
  MAX_TERMINALS,
  SCROLLBACK_LIMIT,
  TerminalManager,
  pickShell,
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
 * The real module gets one smoke test at the bottom instead.
 */
class FakePty implements PtyProcess {
  readonly pid = 4242;
  cols: number;
  rows: number;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
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
    this.killed = true;
  }

  /** The shell printed something. */
  emit(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  /** The shell ended. */
  exit(exitCode: number): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode });
  }
}

interface Harness {
  manager: TerminalManager;
  events: BusEvent[];
  spawned: FakePty[];
  /** The programs that were asked for, in order — `spawn`'s first argument. */
  spawnedFiles: string[];
  optionsOf: () => Record<string, unknown>;
  /** Every event of one shape, with the type narrowed for the assertions. */
  only: <T extends BusEvent["type"]>(type: T) => Array<Extract<BusEvent, { type: T }>>;
}

/**
 * @param loadModule - how the optional module resolves. Omitted means "it is
 * installed and works"; throwing or returning null is the unavailable path.
 */
function harness(loadModule?: () => PtyModule | null): Harness {
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const spawned: FakePty[] = [];
  const spawnedFiles: string[] = [];
  let options: Record<string, unknown> = {};
  const module: PtyModule = {
    spawn: (file, _args, opts) => {
      spawnedFiles.push(file);
      options = opts as unknown as Record<string, unknown>;
      const pty = new FakePty(opts.cols, opts.rows);
      spawned.push(pty);
      return pty;
    },
  };
  return {
    manager: new TerminalManager({ bus, loadModule: loadModule ?? (() => module) }),
    events,
    spawned,
    spawnedFiles,
    optionsOf: () => options,
    only: <T extends BusEvent["type"]>(type: T) =>
      events.filter((event): event is Extract<BusEvent, { type: T }> => event.type === type),
  };
}

function open(h: Harness, sessionPath = "/sessions/a.jsonl", cwd = "/work") {
  return h.manager.create({ sessionPath, cwd, cols: 80, rows: 24 });
}

function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
  throw new Error("expected the call to throw");
}

describe("TerminalManager", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe("support", () => {
    it("reports the host's shells when the optional module loads", () => {
      const support = harness().manager.support();
      expect(support.available).toBe(true);
      // A host always offers at least one — the fallback is the user's own
      // login shell, which is what the tab should open either way.
      expect(support.shells.length).toBeGreaterThan(0);
      // The one a plain "terminal" opens, reported rather than inferred: the
      // client sees a list of paths, not which one `$SHELL` points at. It is
      // always a listed shell, because that is the only kind `pickShell` picks.
      expect(support.default.length).toBeGreaterThan(0);
      expect(support.shells).toContain(support.default);
    });

    it("reports why, and offers nothing, when the module will not load", () => {
      const support = harness(() => {
        throw new Error("Cannot find module 'node-pty'");
      }).manager.support();
      expect(support.available).toBe(false);
      expect(support.reason).toContain("node-pty");
      expect(support.shells).toEqual([]);
      // Nothing to open, so nothing to name as the default.
      expect(support.default).toBe("");
    });

    it("treats a loader that answers null the same as one that throws", () => {
      const support = harness(() => null).manager.support();
      expect(support.available).toBe(false);
      expect(support.reason).toBeTruthy();
    });

    it("stops trying after the first failure", () => {
      let attempts = 0;
      const h = harness(() => {
        attempts += 1;
        throw new Error("nope");
      });
      h.manager.support();
      h.manager.support();
      expect(attempts).toBe(1);
    });
  });

  /**
   * The rule a picker's answer goes through, on its own.
   *
   * Kept out of `create` because the list it decides against comes from this
   * machine's `/etc/shells`: going through a real shell would let a test assert
   * only "one of the two branches happened". `$SHELL` is stubbed for the same
   * reason — the test owns both halves of the comparison.
   */
  describe("pickShell", () => {
    const shells = ["/bin/sh", "/bin/bash", "/bin/zsh"];

    it("honours a request the host lists", () => {
      expect(pickShell("/bin/zsh", shells)).toBe("/bin/zsh");
    });

    it("ignores a request the host does not list", () => {
      // A layout saved on another machine, or one whose package was removed,
      // must not leave a tab that cannot open. Which of the two fallbacks wins
      // depends on this machine's `$SHELL`, so the assertion is the invariant
      // rather than a path: a listed shell, and not the one that was asked for.
      const picked = pickShell("/opt/homebrew/bin/fish", shells);
      expect(picked).not.toBe("/opt/homebrew/bin/fish");
      expect(shells).toContain(picked);
    });

    it.skipIf(process.platform === "win32")(
      "prefers the login shell when nothing was asked for",
      () => {
        vi.stubEnv("SHELL", "/bin/zsh");
        try {
          expect(pickShell(undefined, shells)).toBe("/bin/zsh");
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );

    it.skipIf(process.platform === "win32")(
      "takes the first listed shell when the login shell is not one",
      () => {
        vi.stubEnv("SHELL", "/opt/homebrew/bin/fish");
        try {
          expect(pickShell(undefined, shells)).toBe("/bin/sh");
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );
  });

  describe("create", () => {
    it("spawns a shell with the requested size, in the session's directory", () => {
      const h = harness();
      const info = open(h, "/sessions/a.jsonl", "/work/project");

      expect(info.exitCode).toBeNull();
      expect(info.cols).toBe(80);
      expect(info.rows).toBe(24);
      expect(h.spawned).toHaveLength(1);

      const options = h.optionsOf();
      expect(options.cwd).toBe("/work/project");
      expect(options.name).toBe("xterm-256color");
      expect(options.cols).toBe(80);
      const env = options.env as Record<string, string>;
      // The server's own TERM describes whatever started it, not the xterm.js
      // on the other end, so it is replaced rather than inherited.
      expect(env.TERM).toBe("xterm-256color");
    });

    it("opens the login shell when the request does not name one", () => {
      const h = harness();
      const support = h.manager.support();
      const info = open(h);
      expect(info.shell).toBe(support.default);
      expect(h.spawnedFiles).toEqual([support.default]);
    });

    it("spawns the shell it was asked for, and keeps reporting that one", () => {
      const h = harness();
      const support = h.manager.support();
      // Any listed shell that is *not* the default proves the request travelled;
      // on a host with a single shell the pipeline is still what is under test.
      const wanted = support.shells.find((item) => item !== support.default) ?? support.default;
      const info = h.manager.create({
        sessionPath: "/s.jsonl",
        cwd: "/work",
        cols: 80,
        rows: 24,
        shell: wanted,
      });
      expect(info.shell).toBe(wanted);
      expect(h.spawnedFiles).toEqual([wanted]);
      // Reads report what is running, so a tab is named after the real program
      // rather than after a request that may not have been honoured.
      expect(h.manager.list()[0]?.shell).toBe(wanted);
    });

    it("answers 503 — not 400 — when this host cannot run a shell", () => {
      const h = harness(() => null);
      // Nothing about the request is wrong; the host simply cannot do it.
      expect(statusOf(() => open(h))).toBe(503);
    });

    it("clamps a size that no PTY could honour", () => {
      const h = harness();
      const info = h.manager.create({
        sessionPath: "/s.jsonl",
        cwd: "/work",
        cols: 0,
        rows: 99999,
      });
      expect(info.cols).toBe(2);
      expect(info.rows).toBe(1000);
    });

    it("refuses to open more shells than the cap", () => {
      const h = harness();
      for (let index = 0; index < MAX_TERMINALS; index += 1) open(h);
      expect(statusOf(() => open(h))).toBe(409);
      expect(h.spawned).toHaveLength(MAX_TERMINALS);
    });

    it("gives every shell its own id", () => {
      const h = harness();
      const ids = new Set([open(h).id, open(h).id, open(h).id]);
      expect(ids.size).toBe(3);
    });
  });

  describe("output", () => {
    it("coalesces a burst into one frame", () => {
      vi.useFakeTimers();
      const h = harness();
      const info = open(h);

      h.spawned[0]!.emit("a");
      h.spawned[0]!.emit("b");
      h.spawned[0]!.emit("c");
      // Nothing goes out mid-burst: one frame per interval, not one per chunk.
      expect(h.only("terminal_output")).toHaveLength(0);

      vi.advanceTimersByTime(FLUSH_MS);
      const frames = h.only("terminal_output");
      expect(frames).toHaveLength(1);
      expect(frames[0]!.data).toBe("abc");
      expect(frames[0]!.terminalId).toBe(info.id);
    });

    it("separates bursts that are further apart than the interval", () => {
      vi.useFakeTimers();
      const h = harness();
      open(h);
      h.spawned[0]!.emit("one");
      vi.advanceTimersByTime(FLUSH_MS);
      h.spawned[0]!.emit("two");
      vi.advanceTimersByTime(FLUSH_MS);
      expect(h.only("terminal_output").map((frame) => frame.data)).toEqual(["one", "two"]);
    });

    it("keeps the screen for a client that attaches late", () => {
      const h = harness();
      const info = open(h);
      h.spawned[0]!.emit("hello ");
      h.spawned[0]!.emit("world");
      expect(h.manager.scrollbackOf(info.id)).toBe("hello world");
    });

    it("caps the scrollback rather than letting it grow", () => {
      const h = harness();
      const info = open(h);
      h.spawned[0]!.emit("x".repeat(SCROLLBACK_LIMIT + 500));
      expect(h.manager.scrollbackOf(info.id)?.length).toBe(SCROLLBACK_LIMIT);
    });

    it("has no scrollback for an id it does not know", () => {
      expect(harness().manager.scrollbackOf("nope")).toBeNull();
    });
  });

  describe("input and size", () => {
    it("forwards keystrokes unchanged", () => {
      const h = harness();
      const info = open(h);
      h.manager.write(info.id, "ls\r");
      // Control characters and Tab travel as-is; nothing here interprets them.
      h.manager.write(info.id, "\t\u0003");
      expect(h.spawned[0]!.writes).toEqual(["ls\r", "\t\u0003"]);
    });

    it("drops a keystroke that races the shell's exit", () => {
      const h = harness();
      const info = open(h);
      h.spawned[0]!.exit(0);
      // Not an error: a key can be in flight when the shell ends, and the user
      // did nothing wrong.
      h.manager.write(info.id, "x");
      expect(h.spawned[0]!.writes).toEqual([]);
    });

    it("resizes the PTY only when the size actually changed", () => {
      const h = harness();
      const info = open(h);
      h.manager.resize(info.id, 80, 24);
      expect(h.spawned[0]!.resizes).toEqual([]);
      h.manager.resize(info.id, 120, 40);
      expect(h.spawned[0]!.resizes).toEqual([[120, 40]]);
    });

    it("asks for an unknown terminal", () => {
      const h = harness();
      expect(statusOf(() => h.manager.write("nope", "x"))).toBe(404);
      expect(statusOf(() => h.manager.resize("nope", 80, 24))).toBe(404);
      expect(statusOf(() => h.manager.rename("nope", "t"))).toBe(404);
    });
  });

  describe("exit and teardown", () => {
    it("flushes what the shell said before announcing its exit code", () => {
      const h = harness();
      const info = open(h);
      h.spawned[0]!.emit("goodbye");
      h.spawned[0]!.exit(3);

      // Order matters: the exit notice the client renders must not appear above
      // the shell's own last line.
      const types = h.events.map((event) => event.type);
      expect(types.indexOf("terminal_output")).toBeLessThan(types.indexOf("terminal_state"));

      expect(h.only("terminal_state")[0]).toMatchObject({ terminalId: info.id, exitCode: 3 });
      // The tab stays: an exited shell is something to read, not something to
      // make disappear.
      expect(h.manager.list()[0]?.exitCode).toBe(3);
    });

    it("kills the shell on close, announces it, and forgets the id", () => {
      const h = harness();
      const info = open(h);
      expect(h.manager.close(info.id)).toBe(true);
      expect(h.spawned[0]!.killed).toBe(true);
      expect(h.only("terminal_closed")[0]?.terminalId).toBe(info.id);
      // Closing twice is a race with the tab's own close, not an error.
      expect(h.manager.close(info.id)).toBe(false);
    });

    it("leaves an already-exited shell alone", () => {
      const h = harness();
      const info = open(h);
      h.spawned[0]!.exit(0);
      h.manager.close(info.id);
      expect(h.spawned[0]!.killed).toBe(false);
    });

    it("closes only the shells of the session that went away", () => {
      const h = harness();
      open(h, "/sessions/a.jsonl");
      const kept = open(h, "/sessions/b.jsonl");
      h.manager.closeForSession("/sessions/a.jsonl");
      expect(h.manager.list().map((info) => info.id)).toEqual([kept.id]);
    });

    it("takes every shell down at shutdown", () => {
      const h = harness();
      open(h, "/sessions/a.jsonl");
      open(h, "/sessions/b.jsonl");
      h.manager.stop();
      expect(h.manager.list()).toEqual([]);
      expect(h.spawned.every((pty) => pty.killed)).toBe(true);
    });
  });

  describe("listing and naming", () => {
    it("filters by session", () => {
      const h = harness();
      open(h, "/sessions/a.jsonl");
      open(h, "/sessions/a.jsonl");
      open(h, "/sessions/b.jsonl");
      expect(h.manager.list("/sessions/a.jsonl")).toHaveLength(2);
      expect(h.manager.list("/sessions/b.jsonl")).toHaveLength(1);
      expect(h.manager.list()).toHaveLength(3);
    });

    it("renames a tab, within reason", () => {
      const h = harness();
      const info = open(h);
      expect(h.manager.rename(info.id, "build").title).toBe("build");
      expect(h.manager.rename(info.id, "x".repeat(200)).title.length).toBe(80);
    });
  });
});

/**
 * One test against the real module.
 *
 * Everything above replaces node-pty, which is what makes the suite fast and
 * deterministic — and also means none of it would notice if the real thing
 * stopped working on this machine. This is the smoke alarm. It is skipped where
 * the optional dependency is absent, which is a supported install.
 */
const probe = new TerminalManager({ bus: new EventBus() });
const available = probe.support().available;

describe.skipIf(!available)("TerminalManager with the real node-pty", () => {
  it("runs a command in the session's directory and reports its exit code", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "piws-terminal-")));
    const bus = new EventBus();
    const output: string[] = [];
    let exitCode: number | null = null;
    let announce: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      announce = resolve;
    });
    bus.subscribe((event) => {
      if (event.type === "terminal_output") output.push(event.data);
      if (event.type === "terminal_state") {
        exitCode = event.exitCode;
        announce();
      }
    });

    const manager = new TerminalManager({ bus });
    try {
      const info = manager.create({ sessionPath: "/real.jsonl", cwd: dir, cols: 90, rows: 20 });
      // A login shell prints a banner and sets up job control first; writing
      // before that lands is the flaky version of this test.
      await new Promise((resolve) => setTimeout(resolve, 600));
      manager.write(info.id, "pwd; exit 7\n");
      await exited;

      expect(output.join("")).toContain(dir);
      expect(exitCode).toBe(7);
      // A real PTY is what makes the shell's own `pwd` answer the directory
      // rather than a pipe: the module is only worth having if this holds.
      expect(manager.list()[0]?.exitCode).toBe(7);
    } finally {
      manager.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
