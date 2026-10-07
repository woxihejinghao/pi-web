import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { EventBus } from "./bus.ts";
import { conflict, HttpError, notFound } from "./errors.ts";

/**
 * Interactive shells for the right sidebar.
 *
 * `node-pty` is an *optional* dependency, and a native one. A machine with no
 * prebuilt binary for its platform — or no toolchain to build one — must still
 * get a working app, so every path into the module goes through `load()`, which
 * answers null when it will not come up, and `support()` tells the client what
 * it may offer. There is deliberately **no fallback shell**: a `child_process`
 * pipe is not a terminal. No job control, no `isatty`, no full-screen programs,
 * and `Ctrl+C` reaches the process only if it happens to be listening — which
 * is to say the tab would look like a terminal and not be one.
 */

/** Concurrent shells one server holds open. */
export const MAX_TERMINALS = 8;

/**
 * How much output a terminal keeps for a client that attaches late.
 *
 * A tab that unmounts and comes back — a sidebar toggle, a page reload, a
 * session switch — replays this before live output, so the screen it returns to
 * is the one the user left. Measured in characters rather than lines because
 * escape sequences make line counting a lie: one "line" of a progress bar can
 * be a megabyte.
 */
export const SCROLLBACK_LIMIT = 128 * 1024;

/**
 * Output is coalesced into frames this far apart.
 *
 * A PTY answers a keystroke with a handful of bytes, but `yes` or a build log
 * answers with thousands — and every frame otherwise costs an SSE write, a JSON
 * encode and a React commit on the other side. Merging at this interval is
 * below the threshold at which a terminal stops looking live.
 */
export const FLUSH_MS = 16;

/**
 * The slice of node-pty's surface this module uses.
 *
 * Declared here rather than imported: the module is optional, so a type that
 * came from it would make the build depend on something that need not be
 * installed. It also keeps the failure mode honest — `load()` returning null is
 * the only thing that decides whether the feature exists.
 */
export interface PtyDisposable {
  dispose(): void;
}

export interface PtyProcess {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): PtyProcess;
}

/** What the client may offer, and why not when it may offer nothing. */
export interface TerminalSupport {
  available: boolean;
  /** One line on why not — shown wherever the terminal entry would have been. */
  reason?: string;
  /** Shells this host offers, in the order a picker should show them. */
  shells: string[];
}

export interface TerminalInfo {
  id: string;
  sessionPath: string;
  title: string;
  cols: number;
  rows: number;
  /** null while the shell is alive; the code it left with afterwards. */
  exitCode: number | null;
}

interface TerminalRecord {
  readonly id: string;
  readonly sessionPath: string;
  readonly proc: PtyProcess;
  title: string;
  cols: number;
  rows: number;
  exitCode: number | null;
  /** Replayed to a client that attaches after output has already arrived. */
  scrollback: string;
  /** Output the shell produced but that has not been published yet. */
  pending: string;
  flush: NodeJS.Timeout | null;
  disposers: PtyDisposable[];
}

export interface TerminalManagerDeps {
  bus: EventBus;
  /**
   * Test seam: how the optional module is obtained.
   *
   * The default is the real one — `createRequire` on `node-pty`, plus the
   * execute-bit repair below. A test that wants to see the *unavailable* path,
   * or that wants a shell whose output it controls down to the byte, supplies
   * its own; throwing from here is the same as the module being absent.
   */
  loadModule?: () => PtyModule | null;
}

export interface CreateTerminalInput {
  sessionPath: string;
  /** Where the shell starts: the session's own working directory. */
  cwd: string;
  cols: number;
  rows: number;
  /** A path from `support().shells`; anything else falls back to the default. */
  shell?: string;
}

/**
 * What the routes need from a shell host.
 *
 * An interface rather than the class so a route test can answer without a PTY.
 * The decision worth pinning down at that layer is *which* shell is opened and
 * *where* — and asserting on a real shell's bytes to reach it would tie the
 * test to one machine's prompt.
 */
export interface TerminalHost {
  support(): TerminalSupport;
  list(sessionPath?: string): TerminalInfo[];
  scrollbackOf(id: string): string | null;
  create(input: CreateTerminalInput): TerminalInfo;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  rename(id: string, title: string): TerminalInfo;
  close(id: string): boolean;
  closeForSession(sessionPath: string): void;
}

export class TerminalManager implements TerminalHost {
  private readonly deps: TerminalManagerDeps;
  private readonly terminals = new Map<string, TerminalRecord>();
  /** undefined = not tried yet, null = tried and failed. */
  private module: PtyModule | null | undefined = undefined;
  private failure: string | null = null;
  private counter = 0;

  constructor(deps: TerminalManagerDeps) {
    this.deps = deps;
  }

  /**
   * Whether shells are available here.
   *
   * Deliberately cheap: it reports whether the module loads, not whether a
   * shell can start. Paying a real `spawn` on every page load to answer a
   * question whose answer only changes when the machine does is the wrong
   * trade — a spawn that fails later is reported then, in place of the pane.
   */
  support(): TerminalSupport {
    if (this.load() === null) {
      return { available: false, reason: this.failure ?? "terminal unavailable", shells: [] };
    }
    return { available: true, shells: installedShells() };
  }

  list(sessionPath?: string): TerminalInfo[] {
    const all = [...this.terminals.values()];
    const wanted =
      sessionPath === undefined ? all : all.filter((record) => record.sessionPath === sessionPath);
    return wanted.map(infoOf);
  }

  /** The screen to replay before live output, or null if the id is unknown. */
  scrollbackOf(id: string): string | null {
    return this.terminals.get(id)?.scrollback ?? null;
  }

  create(input: CreateTerminalInput): TerminalInfo {
    const pty = this.load();
    if (pty === null) {
      // 503, not 400: nothing about the request is wrong, this host just cannot
      // run a shell. The client hides the entry instead of showing an error.
      throw new HttpError(503, `终端不可用：${this.failure ?? "node-pty 未安装"}`);
    }
    if (this.terminals.size >= MAX_TERMINALS) {
      throw conflict(`终端数量已达上限（${String(MAX_TERMINALS)}），请先关闭一个`);
    }

    const shells = installedShells();
    const file = pickShell(input.shell, shells);
    const cols = clampDimension(input.cols, 80);
    const rows = clampDimension(input.rows, 24);
    const id = `term-${String(++this.counter)}-${Math.random().toString(36).slice(2, 7)}`;

    let proc: PtyProcess;
    try {
      proc = pty.spawn(file, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd: input.cwd,
        env: shellEnv(),
      });
    } catch (err) {
      // A spawn that throws means this machine's node-pty is broken rather than
      // this request being wrong — most often a `spawn-helper` installed
      // without its execute bit, which reads as `posix_spawnp failed`. Retire
      // the module so every later call takes the cheap "unavailable" path
      // instead of retrying a failure that will not heal.
      this.module = null;
      this.failure = (err as Error).message;
      throw new HttpError(503, `终端无法启动：${this.failure}`);
    }

    const record: TerminalRecord = {
      id,
      sessionPath: input.sessionPath,
      proc,
      title: "",
      cols,
      rows,
      exitCode: null,
      scrollback: "",
      pending: "",
      flush: null,
      disposers: [],
    };

    record.disposers.push(
      proc.onData((data) => {
        record.scrollback = appendScrollback(record.scrollback, data);
        record.pending += data;
        if (record.flush === null) {
          record.flush = setTimeout(() => {
            record.flush = null;
            this.publishOutput(record);
          }, FLUSH_MS);
          record.flush.unref?.();
        }
      }),
    );

    record.disposers.push(
      proc.onExit(({ exitCode }) => {
        // Anything the shell printed on its way out goes first, or the exit
        // notice the client renders would appear above its own last line.
        if (record.flush !== null) {
          clearTimeout(record.flush);
          record.flush = null;
        }
        this.publishOutput(record);
        record.exitCode = exitCode;
        this.deps.bus.publish({
          type: "terminal_state",
          terminalId: record.id,
          sessionPath: record.sessionPath,
          exitCode,
        });
      }),
    );

    this.terminals.set(id, record);
    return infoOf(record);
  }

  /**
   * Send keystrokes.
   *
   * A write to a shell that has already exited is dropped rather than refused:
   * the client and the PTY race by nature — a key can be in flight when the
   * shell ends — and turning that into a 404 would put an error in the console
   * for something the user did correctly.
   */
  write(id: string, data: string): void {
    const record = this.terminals.get(id);
    if (record === undefined) throw notFound(`终端不存在：${id}`);
    if (record.exitCode !== null) return;
    record.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const record = this.terminals.get(id);
    if (record === undefined) throw notFound(`终端不存在：${id}`);
    if (record.exitCode !== null) return;
    const nextCols = clampDimension(cols, record.cols);
    const nextRows = clampDimension(rows, record.rows);
    if (nextCols === record.cols && nextRows === record.rows) return;
    record.cols = nextCols;
    record.rows = nextRows;
    try {
      record.proc.resize(nextCols, nextRows);
    } catch {
      // The shell can die between the check above and here. Nothing to do about
      // it, and the exit event is already on its way.
    }
  }

  rename(id: string, title: string): TerminalInfo {
    const record = this.terminals.get(id);
    if (record === undefined) throw notFound(`终端不存在：${id}`);
    record.title = title.slice(0, 80);
    return infoOf(record);
  }

  close(id: string): boolean {
    const record = this.terminals.get(id);
    if (record === undefined) return false;
    this.terminals.delete(id);
    if (record.flush !== null) clearTimeout(record.flush);
    for (const disposer of record.disposers) {
      try {
        disposer.dispose();
      } catch {
        // Already disposed by the process ending; both orders are normal.
      }
    }
    if (record.exitCode === null) {
      try {
        record.proc.kill();
      } catch {
        // Already gone.
      }
    }
    this.deps.bus.publish({
      type: "terminal_closed",
      terminalId: id,
      sessionPath: record.sessionPath,
    });
    return true;
  }

  /** Drop every shell belonging to a session — used when the session goes away. */
  closeForSession(sessionPath: string): void {
    for (const record of [...this.terminals.values()]) {
      if (record.sessionPath === sessionPath) this.close(record.id);
    }
  }

  /** Every shell, torn down at shutdown so no PTY outlives the server. */
  stop(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  private publishOutput(record: TerminalRecord): void {
    if (record.pending.length === 0) return;
    const data = record.pending;
    record.pending = "";
    this.deps.bus.publish({
      type: "terminal_output",
      terminalId: record.id,
      sessionPath: record.sessionPath,
      data,
    });
  }

  private load(): PtyModule | null {
    if (this.module !== undefined) return this.module;
    try {
      this.module = (this.deps.loadModule ?? loadNodePty)();
    } catch (err) {
      // The message is kept as-is: it is what the user has to act on, and every
      // wrapper we could add would only push the interesting part further away.
      this.module = null;
      this.failure = (err as Error).message;
    }
    if (this.module === null) this.failure ??= "node-pty 未安装";
    return this.module;
  }
}

/**
 * The real loader.
 *
 * `createRequire` rather than `import`: the module is optional, so a static
 * import would make the build — and every bundler that walks it — depend on
 * something that need not be installed. It also keeps the module out of the
 * type checker's hands, which is why the shape above is declared by hand.
 */
function loadNodePty(): PtyModule {
  const require = createRequire(import.meta.url);
  const loaded = require("node-pty") as PtyModule;
  restoreSpawnHelper(require);
  return loaded;
}

function infoOf(record: TerminalRecord): TerminalInfo {
  return {
    id: record.id,
    sessionPath: record.sessionPath,
    title: record.title,
    cols: record.cols,
    rows: record.rows,
    exitCode: record.exitCode,
  };
}

/**
 * Give node-pty's `spawn-helper` its execute bit back.
 *
 * The module ships a small native helper next to its prebuilt binding, and some
 * installers copy it without the mode — `npm` in particular unpacks it as
 * `rw-r--r--`. The symptom is `posix_spawnp failed`, which reads like a sandbox
 * or entitlement problem and sends people looking in entirely the wrong place.
 * Idempotent, best-effort, and skipped on Windows, which has no such helper.
 */
function restoreSpawnHelper(require: NodeRequire): void {
  if (process.platform === "win32") return;
  let root: string;
  try {
    // `require.resolve` lands on lib/index.js; the package root is two up.
    root = dirname(dirname(require.resolve("node-pty")));
  } catch {
    return;
  }
  const helper = join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  try {
    if (!existsSync(helper)) return;
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0o111) return;
    chmodSync(helper, mode | 0o755);
  } catch {
    // A read-only install directory. The spawn will report what actually went
    // wrong, which is better than a chmod failure reported as a terminal bug.
  }
}

/**
 * The shells this host offers.
 *
 * `/etc/shells` is the system's own answer to "what may I run as a login
 * shell", which is exactly the question a picker asks. Entries are checked for
 * existence because a package can be uninstalled and leave its line behind.
 * Windows has no such file and no such list: whatever `ComSpec` points at is
 * the one shell, and that is a complete answer there.
 */
function installedShells(): string[] {
  const fallback = defaultShell();
  if (process.platform === "win32") return [fallback];
  try {
    const lines = readFileSync("/etc/shells", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    const present = lines.filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
    return present.length > 0 ? present : [fallback];
  } catch {
    return [fallback];
  }
}

function defaultShell(): string {
  if (process.platform === "win32") return process.env.ComSpec ?? "powershell.exe";
  const fromEnv = process.env.SHELL;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return "/bin/sh";
}

/**
 * The shell a new tab opens.
 *
 * A requested shell is honoured only when the host actually lists it, so a
 * stale choice saved in a layout cannot make the tab fail to open. Otherwise
 * the user's own login shell wins: it is the one whose aliases and prompt they
 * expect, and the one `/etc/shells` almost always contains.
 */
function pickShell(requested: string | undefined, shells: string[]): string {
  if (requested !== undefined && shells.includes(requested)) return requested;
  const login = defaultShell();
  if (shells.includes(login)) return login;
  return shells[0] ?? login;
}

/**
 * The environment a user's shell gets.
 *
 * Inherited wholesale — `PATH`, the language, whatever credentials the user
 * exported — with two exceptions. `TERM` is forced, because the server's own
 * value describes whatever terminal started *it* (often nothing at all), not
 * the xterm.js on the other end. `ELECTRON_RUN_AS_NODE` is dropped: the desktop
 * build runs this server inside Electron, and a shell that inherits it launches
 * Node instead of a login shell when a tool re-execs itself.
 */
function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "ELECTRON_RUN_AS_NODE") continue;
    env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

/** Keeps a nonsense measurement from becoming a nonsense PTY. */
function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1000, Math.max(2, Math.round(value)));
}

/**
 * Append output, never growing past the cap.
 *
 * Cutting a character stream can land mid-escape-sequence, which the replay
 * then renders as garbage until the next one resynchronises. It is accepted
 * rather than fixed: the alternative is parsing the whole scrollback on every
 * frame, and the damaged region is at most one sequence long at the top of a
 * screen nobody is looking at.
 */
function appendScrollback(current: string, data: string): string {
  const next = current + data;
  if (next.length <= SCROLLBACK_LIMIT) return next;
  return next.slice(next.length - SCROLLBACK_LIMIT);
}
