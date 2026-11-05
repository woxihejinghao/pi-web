import { accessSync, constants, chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import type { EventBus } from "./bus.ts";
import { badRequest, conflict, HttpError, notFound } from "./errors.ts";

/**
 * Interactive shells for the right sidebar.
 *
 * The feature is a *session*, not a stream: a shell keeps running while no page
 * is looking at it, several pages can look at the same one, exactly one of them
 * may type into it, and a page that comes back gets the screen it left rather
 * than a replay of raw bytes. The pieces are:
 *
 *  * a PTY (`node-pty`, optional and native — a machine with no build gets
 *    `support().available === false` and the UI hides the entry);
 *  * a headless xterm that mirrors the PTY, so a late client can be handed a
 *    screen instead of a character stream whose first escape sequence may have
 *    been cut off;
 *  * a monotone `sequence` on output frames, so a client can tell a gap from a
 *    pause and recover with a snapshot;
 *  * attachments: the last page to attach owns input and resize, everyone else
 *    is read-only until it takes control back.
 *
 * There is deliberately **no fallback shell**: a `child_process` pipe is not a
 * terminal. No job control, no `isatty`, no full-screen programs.
 */

/** Concurrent shells one server holds open, finished ones included. */
export const MAX_TERMINALS = 8;
/** Widest/narrowest geometry a browser may ask for. */
export const MAX_COLS = 500;
export const MAX_ROWS = 200;
/** Largest single input request; the browser queues the rest. */
export const MAX_INPUT_BYTES = 64 * 1024;
/** Rows of history the mirrored screen keeps. */
export const SCROLLBACK_ROWS = 1000;
/** How long a shell with no attachment survives, unless it is still moving. */
export const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** An attachment that has not said anything for this long is presumed gone. */
export const ATTACHMENT_TIMEOUT_MS = 90 * 1000;
/** Cleanup retry cadence after a failed kill. */
export const CLEANUP_RETRY_MS = 60 * 1000;
/** Output coalescing: below this a terminal stops looking live. */
export const FLUSH_MS = 16;
/** Server-side title cap, matching the tab strip's own limit. */
export const TITLE_LIMIT = 120;

/** Shells offered by the host, resolved once per question. */
export interface TerminalShell {
  path: string;
  name: string;
  args: string[];
}

export type TerminalLifecycle = "starting" | "running" | "exited" | "failed";

export interface TerminalInfo {
  id: string;
  sessionPath: string;
  title: string;
  shell: TerminalShell;
  cwd: string;
  cols: number;
  rows: number;
  state: TerminalLifecycle;
  exitCode: number | null;
  error?: string;
  /** The attachment currently allowed to type; absent when nobody controls it. */
  controllerId?: string;
}

export interface TerminalEnvironment {
  cwd: string;
  maxCols: number;
  maxRows: number;
  maxInputBytes: number;
  scrollback: number;
}

export interface TerminalSnapshot {
  info: TerminalInfo;
  screen: string;
  sequence: number;
}

/** What the client may offer, and why not when it may offer nothing. */
export interface TerminalSupport {
  available: boolean;
  reason?: string;
}

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

export interface CreateTerminalInput {
  /** Client-minted so a retried create cannot open a second shell. */
  id?: string;
  sessionPath: string;
  /** Where the shell starts: the session's own working directory. */
  cwd: string;
  cols: number;
  rows: number;
  /** A path returned by `shells()`; omitted means the host's default. */
  shellPath?: string;
}

export interface TerminalManagerDeps {
  bus: EventBus;
  /**
   * Test seam: how the optional native module is obtained. Throwing or
   * answering null is the same as the module being absent.
   */
  loadModule?: () => PtyModule | null;
  /** Test seam: shorten the idle reaper without waiting two hours. */
  idleTimeoutMs?: number;
  /** Test seam: how often the reaper runs; 0 disables the timer. */
  reapIntervalMs?: number;
  /** Test seam: clock. */
  now?: () => number;
}

/**
 * What the routes need from a shell host.
 *
 * An interface rather than the class so a route test can answer without a PTY.
 */
export interface TerminalHost {
  support(): TerminalSupport;
  shells(): TerminalShell[];
  environment(cwd?: string): TerminalEnvironment;
  list(sessionPath?: string): TerminalInfo[];
  /** @deprecated Kept for the pre-snapshot route; returns the serialized screen. */
  scrollbackOf(id: string): string | null;
  create(input: CreateTerminalInput): TerminalInfo;
  attach(id: string, attachmentId: string): Promise<TerminalSnapshot>;
  detach(id: string, attachmentId: string): void;
  snapshot(id: string): Promise<TerminalSnapshot>;
  write(id: string, attachmentId: string, data: string): void;
  resize(id: string, attachmentId: string, cols: number, rows: number): void;
  rename(id: string, title: string): TerminalInfo;
  heartbeat(id: string, attachmentId: string): void;
  close(id: string): boolean;
  closeForSession(sessionPath: string): void;
  cleanupFailures(): Array<{ id: string; sessionPath: string; message: string }>;
  retryCleanup(id: string): boolean;
}

interface ScreenHandle {
  screen: HeadlessTerminalType;
  serialize: SerializeAddonType;
}

interface TerminalRecord {
  readonly id: string;
  readonly sessionPath: string;
  readonly proc: PtyProcess;
  readonly shell: TerminalShell;
  readonly cwd: string;
  readonly screen: HeadlessTerminalType;
  readonly serialize: SerializeAddonType;
  readonly attachments: Map<string, number>;
  readonly disposers: PtyDisposable[];
  title: string;
  cols: number;
  rows: number;
  state: TerminalLifecycle;
  exitCode: number | null;
  error: string | undefined;
  controllerId: string | undefined;
  sequence: number;
  /** Output produced but not published yet. */
  pending: string;
  flush: NodeJS.Timeout | null;
  /** Serializes screen writes and frame publication, so sequence order is write order. */
  outputChain: Promise<void>;
  lastActivity: number;
  closed: boolean;
}

interface CleanupFailure {
  record: TerminalRecord;
  id: string;
  sessionPath: string;
  message: string;
  attempts: number;
  timer: NodeJS.Timeout | null;
}

export class TerminalManager implements TerminalHost {
  private readonly deps: TerminalManagerDeps;
  private readonly terminals = new Map<string, TerminalRecord>();
  /** Ids that were closed; a create with one is refused rather than resurrected. */
  private readonly closedIds = new Set<string>();
  /** Ids in flight, counted against the quota. */
  private readonly reserved = new Set<string>();
  private readonly failures = new Map<string, CleanupFailure>();
  private readonly reaper: NodeJS.Timeout | null;
  private readonly idleTimeoutMs: number;
  /** undefined = not tried yet, null = tried and failed. */
  private module: PtyModule | null | undefined = undefined;
  private failure: string | null = null;

  constructor(deps: TerminalManagerDeps) {
    this.deps = deps;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    const interval = deps.reapIntervalMs ?? 30_000;
    this.reaper =
      interval > 0
        ? setInterval(() => {
            this.reap();
          }, interval)
        : null;
    this.reaper?.unref?.();
  }

  support(): TerminalSupport {
    if (this.load() === null) {
      return { available: false, reason: this.failure ?? "terminal unavailable" };
    }
    return { available: true };
  }

  /**
   * Which shells this host can start.
   *
   * Discovery does not need node-pty: the picker still has something to say on
   * a machine where the native module failed to load, even if opening one then
   * answers 503.
   */
  shells(): TerminalShell[] {
    return discoverShells();
  }

  environment(cwd = ""): TerminalEnvironment {
    return {
      cwd,
      maxCols: MAX_COLS,
      maxRows: MAX_ROWS,
      maxInputBytes: MAX_INPUT_BYTES,
      scrollback: SCROLLBACK_ROWS,
    };
  }

  list(sessionPath?: string): TerminalInfo[] {
    const all = [...this.terminals.values()];
    const wanted =
      sessionPath === undefined ? all : all.filter((record) => record.sessionPath === sessionPath);
    return wanted.map(infoOf);
  }

  /** The serialized screen. Sync because the legacy route is sync; new callers use `snapshot`. */
  scrollbackOf(id: string): string | null {
    const record = this.terminals.get(id);
    if (record === undefined) return null;
    try {
      return record.serialize.serialize();
    } catch {
      return "";
    }
  }

  create(input: CreateTerminalInput): TerminalInfo {
    const pty = this.load();
    if (pty === null) {
      throw new HttpError(503, `终端不可用：${this.failure ?? "node-pty 未安装"}`);
    }

    const id = input.id ?? mintId();
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(id)) throw badRequest(`终端 id 不合法：${id}`);
    const existing = this.terminals.get(id);
    if (existing !== undefined) {
      // A retried request is the same request: answer with the shell it already
      // opened rather than counting it twice or failing the tab that made it.
      if (existing.sessionPath === input.sessionPath) return infoOf(existing);
      throw conflict(`终端 id 已被其他会话占用：${id}`);
    }
    if (this.closedIds.has(id)) throw conflict(`终端已关闭，不能复用 id：${id}`);
    if (this.reserved.has(id)) throw conflict(`终端正在创建：${id}`);
    if (this.terminals.size + this.reserved.size >= MAX_TERMINALS) {
      throw conflict(`终端数量已达上限（${String(MAX_TERMINALS)}），请先关闭一个`);
    }

    const shell = this.pickShell(input.shellPath);
    const cols = clampDimension(input.cols, MAX_COLS, 80);
    const rows = clampDimension(input.rows, MAX_ROWS, 24);

    this.reserved.add(id);
    try {
      let proc: PtyProcess;
      try {
        proc = pty.spawn(shell.path, shell.args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: input.cwd,
          env: shellEnv(),
        });
      } catch (err) {
        const failure = err instanceof Error ? err.message : String(err);
        throw new HttpError(503, `终端无法启动：${failure}`);
      }

      const handle = createScreen(cols, rows);
      const now = this.now();
      const record: TerminalRecord = {
        id,
        sessionPath: input.sessionPath,
        proc,
        shell,
        cwd: input.cwd,
        screen: handle.screen,
        serialize: handle.serialize,
        attachments: new Map(),
        disposers: [],
        title: shell.name,
        cols,
        rows,
        state: "running",
        exitCode: null,
        error: undefined,
        controllerId: undefined,
        sequence: 0,
        pending: "",
        flush: null,
        outputChain: Promise.resolve(),
        lastActivity: now,
        closed: false,
      };

      record.disposers.push(
        proc.onData((data) => {
          if (record.closed) return;
          this.touch(record);
          record.pending += data;
          if (record.flush === null) {
            record.flush = setTimeout(() => {
              record.flush = null;
              void this.flushOutput(record);
            }, FLUSH_MS);
            record.flush.unref?.();
          }
        }),
      );

      record.disposers.push(
        proc.onExit(({ exitCode }) => {
          if (record.closed) return;
          if (record.flush !== null) {
            clearTimeout(record.flush);
            record.flush = null;
          }
          record.state = "exited";
          record.exitCode = exitCode;
          record.controllerId = undefined;
          record.attachments.clear();
          // Anything printed on the way out goes first, or the exit notice
          // would render above the shell's own last line.
          void (async () => {
            await this.flushOutput(record);
            await record.outputChain;
            this.publishState(record);
          })();
        }),
      );

      this.terminals.set(id, record);
      return infoOf(record);
    } finally {
      this.reserved.delete(id);
    }
  }

  /** Take input control, and answer with the screen as of `sequence`. */
  async attach(id: string, attachmentId: string): Promise<TerminalSnapshot> {
    const record = this.require(id);
    requireAttachmentId(attachmentId);
    record.attachments.set(attachmentId, this.now());
    record.controllerId = attachmentId;
    this.touch(record);
    // Snapshot after every frame that has already been written, so the screen
    // and the sequence describe the same moment.
    await record.outputChain;
    const snapshot: TerminalSnapshot = {
      info: infoOf(record),
      screen: record.serialize.serialize(),
      sequence: record.sequence,
    };
    this.publishState(record);
    return snapshot;
  }

  detach(id: string, attachmentId: string): void {
    const record = this.terminals.get(id);
    if (record === undefined) return;
    if (record.attachments.delete(attachmentId) && record.controllerId === attachmentId) {
      record.controllerId = undefined;
      this.publishState(record);
    }
  }

  async snapshot(id: string): Promise<TerminalSnapshot> {
    const record = this.require(id);
    await record.outputChain;
    return { info: infoOf(record), screen: record.serialize.serialize(), sequence: record.sequence };
  }

  write(id: string, attachmentId: string, data: string): void {
    const record = this.require(id);
    if (record.state !== "running") return;
    if (record.controllerId !== attachmentId) {
      throw conflict("终端正由另一个窗口输入，请先接管");
    }
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > MAX_INPUT_BYTES) {
      throw new HttpError(413, `单次输入超过上限（${String(MAX_INPUT_BYTES)} 字节）`);
    }
    this.touch(record);
    record.proc.write(data);
  }

  resize(id: string, attachmentId: string, cols: number, rows: number): void {
    const record = this.require(id);
    if (record.state !== "running") return;
    if (record.controllerId !== attachmentId) {
      throw conflict("终端正由另一个窗口输入，请先接管");
    }
    const nextCols = clampDimension(cols, MAX_COLS, record.cols);
    const nextRows = clampDimension(rows, MAX_ROWS, record.rows);
    if (nextCols === record.cols && nextRows === record.rows) return;
    record.cols = nextCols;
    record.rows = nextRows;
    this.touch(record);
    try {
      record.proc.resize(nextCols, nextRows);
    } catch {
      // The shell can die between the check and here; the exit event is coming.
    }
    try {
      record.screen.resize(nextCols, nextRows);
    } catch {
      // A disposed screen after a racing close.
    }
    this.publishState(record);
  }

  rename(id: string, title: string): TerminalInfo {
    const record = this.require(id);
    const next = title.trim().slice(0, TITLE_LIMIT);
    if (next.length === 0 || next === record.title) return infoOf(record);
    record.title = next;
    this.touch(record);
    this.publishState(record);
    return infoOf(record);
  }

  heartbeat(id: string, attachmentId: string): void {
    const record = this.terminals.get(id);
    if (record === undefined) return;
    if (record.attachments.has(attachmentId)) {
      record.attachments.set(attachmentId, this.now());
      this.touch(record);
    }
  }

  /**
   * Remove a shell from every list, then end the process.
   *
   * The tab disappears at once; killing is allowed to lag. A kill that throws
   * is kept in `failures` and retried, because a PTY that survives its close is
   * the one failure mode that leaks a process for the server's whole lifetime.
   */
  close(id: string): boolean {
    const record = this.terminals.get(id);
    if (record === undefined) return false;
    this.terminals.delete(id);
    this.closedIds.add(id);
    record.closed = true;
    record.controllerId = undefined;
    record.attachments.clear();
    if (record.flush !== null) {
      clearTimeout(record.flush);
      record.flush = null;
    }
    this.deps.bus.publish({
      type: "terminal_closed",
      terminalId: id,
      sessionPath: record.sessionPath,
    });
    this.disposeLater(record);
    return true;
  }

  closeForSession(sessionPath: string): void {
    for (const record of [...this.terminals.values()]) {
      if (record.sessionPath === sessionPath) this.close(record.id);
    }
  }

  cleanupFailures(): Array<{ id: string; sessionPath: string; message: string }> {
    return [...this.failures.values()].map(({ id, sessionPath, message }) => ({
      id,
      sessionPath,
      message,
    }));
  }

  retryCleanup(id: string): boolean {
    const failure = this.failures.get(id);
    if (failure === undefined) return false;
    if (failure.timer !== null) {
      clearTimeout(failure.timer);
      failure.timer = null;
    }
    this.attemptCleanup(failure);
    return true;
  }

  /** Every shell, torn down at shutdown so no PTY outlives the server. */
  stop(): void {
    if (this.reaper !== null) clearInterval(this.reaper);
    for (const failure of this.failures.values()) {
      if (failure.timer !== null) clearTimeout(failure.timer);
    }
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  /**
   * Drop attachments that stopped speaking, and shells nobody has used for the
   * idle timeout.
   *
   * `node-pty` has no equivalent of the reference host's activity inspection, so
   * this is approximation rather than certainty: a two-hour `npm install` with
   * no output and no attached page is indistinguishable from an abandoned tab.
   * The timeout is configurable for exactly that reason.
   */
  reap(now = this.now()): void {
    for (const record of [...this.terminals.values()]) {
      let changed = false;
      for (const [attachmentId, seen] of [...record.attachments]) {
        if (now - seen > ATTACHMENT_TIMEOUT_MS) {
          record.attachments.delete(attachmentId);
          changed = true;
          if (record.controllerId === attachmentId) record.controllerId = undefined;
        }
      }
      if (record.attachments.size === 0 && now - record.lastActivity >= this.idleTimeoutMs) {
        this.close(record.id);
        continue;
      }
      if (changed) this.publishState(record);
    }
  }

  private require(id: string): TerminalRecord {
    const record = this.terminals.get(id);
    if (record === undefined) throw notFound(`终端不存在：${id}`);
    return record;
  }

  private pickShell(shellPath: string | undefined): TerminalShell {
    const shells = this.shells();
    if (shells.length === 0) throw new HttpError(503, "这台机器上没有可用的 shell");
    if (shellPath === undefined || shellPath.length === 0) return shells[0]!;
    const found = shells.find((shell) => shell.path === shellPath);
    if (found === undefined) throw badRequest(`不是可用的 shell：${shellPath}`);
    return found;
  }

  private touch(record: TerminalRecord): void {
    record.lastActivity = this.now();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Append pending output to the write chain; one frame per call, in order. */
  private flushOutput(record: TerminalRecord): Promise<void> {
    if (record.pending.length === 0) return record.outputChain;
    const data = record.pending;
    record.pending = "";
    record.outputChain = record.outputChain.then(async () => {
      if (record.closed) return;
      await writeScreen(record.screen, data);
      record.sequence += 1;
      this.deps.bus.publish({
        type: "terminal_output",
        terminalId: record.id,
        sessionPath: record.sessionPath,
        sequence: record.sequence,
        data,
      });
    });
    return record.outputChain;
  }

  private publishState(record: TerminalRecord): void {
    if (record.closed) return;
    this.deps.bus.publish({
      type: "terminal_state",
      terminalId: record.id,
      sessionPath: record.sessionPath,
      info: infoOf(record),
    });
  }

  /** Kill and dispose off the request path; a failed kill becomes retryable. */
  private disposeLater(record: TerminalRecord): void {
    void (async () => {
      // Let any already-published frame finish so a subscriber is not writing
      // into a disposed screen.
      await record.outputChain.catch(() => undefined);
      for (const disposer of record.disposers) {
        try {
          disposer.dispose();
        } catch {
          // Already disposed by the process ending; both orders are normal.
        }
      }
      if (record.state === "running") {
        try {
          record.proc.kill();
        } catch (err) {
          this.recordCleanupFailure(record, err);
        }
      }
      try {
        record.screen.dispose();
      } catch {
        // Already gone.
      }
    })();
  }

  private recordCleanupFailure(record: TerminalRecord, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const existing = this.failures.get(record.id);
    const failure: CleanupFailure = {
      record,
      id: record.id,
      sessionPath: record.sessionPath,
      message,
      attempts: (existing?.attempts ?? 0) + 1,
      timer: null,
    };
    if (existing?.timer != null) clearTimeout(existing.timer);
    this.failures.set(record.id, failure);
    this.deps.bus.publish({
      type: "terminal_cleanup_failed",
      terminalId: record.id,
      sessionPath: record.sessionPath,
      message,
    });
    failure.timer = setTimeout(() => {
      failure.timer = null;
      this.attemptCleanup(failure);
    }, CLEANUP_RETRY_MS);
    failure.timer.unref?.();
  }

  private attemptCleanup(failure: CleanupFailure): void {
    // The record has already left `terminals` by design; the failure keeps its
    // own reference, which is the only way to reach a process whose close
    // failed after removal.
    try {
      failure.record.proc.kill();
    } catch (err) {
      this.recordCleanupFailure(failure.record, err);
      return;
    }
    this.failures.delete(failure.id);
  }

  private load(): PtyModule | null {
    if (this.module !== undefined) return this.module;
    try {
      this.module = (this.deps.loadModule ?? loadNodePty)();
    } catch (err) {
      this.module = null;
      this.failure = (err as Error).message;
    }
    if (this.module === null) this.failure ??= "node-pty 未安装";
    return this.module;
  }
}

function infoOf(record: TerminalRecord): TerminalInfo {
  const info: TerminalInfo = {
    id: record.id,
    sessionPath: record.sessionPath,
    title: record.title,
    shell: record.shell,
    cwd: record.cwd,
    cols: record.cols,
    rows: record.rows,
    state: record.state,
    exitCode: record.exitCode,
  };
  if (record.error !== undefined) info.error = record.error;
  if (record.controllerId !== undefined) info.controllerId = record.controllerId;
  return info;
}

function mintId(): string {
  return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function requireAttachmentId(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(value)) throw badRequest("attachmentId 不合法");
}

/**
 * One headless screen per shell.
 *
 * `@xterm/headless` is CommonJS, so it is required rather than imported — the
 * same reason `node-pty` is, and the same seam: the server build stays ESM.
 */
function createScreen(cols: number, rows: number): ScreenHandle {
  const require = createRequire(import.meta.url);
  const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
  const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
  const screen = new Terminal({ cols, rows, scrollback: SCROLLBACK_ROWS, allowProposedApi: true });
  const serialize = new SerializeAddon();
  screen.loadAddon(serialize);
  return { screen, serialize };
}

function writeScreen(screen: HeadlessTerminalType, data: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      screen.write(data, () => {
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/**
 * Discover the shells this host can actually start.
 *
 * Order matters: the execution default first (what a plain "New terminal"
 * opens), then the user's login shell and the usual suspects, then whatever
 * `/etc/shells` lists. Duplicates are dropped by executable name, so `/bin/zsh`
 * appearing twice is one entry.
 */
export function discoverShells(): TerminalShell[] {
  const seen = new Set<string>();
  const shells: TerminalShell[] = [];
  const add = (path: string): void => {
    if (!isExecutable(path)) return;
    const name = basename(path).replace(/\.exe$/i, "");
    const key = name.toLowerCase();
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    shells.push({ path, name, args: shellArgs(name) });
  };

  add(defaultShellPath());
  if (process.platform === "win32") {
    for (const candidate of ["pwsh", "powershell", "cmd"]) {
      const resolved = resolveOnPath(candidate);
      if (resolved !== null) add(resolved);
    }
    return shells;
  }

  for (const path of loginShells()) add(path);
  for (const candidate of ["zsh", "bash", "fish", "pwsh"]) {
    const resolved = resolveOnPath(candidate);
    if (resolved !== null) add(resolved);
  }
  return shells;
}

function defaultShellPath(): string {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec;
    if (comspec !== undefined && isExecutable(comspec)) return comspec;
    return resolveOnPath("powershell") ?? "cmd.exe";
  }
  const fromEnv = process.env.SHELL;
  if (fromEnv !== undefined && fromEnv.length > 0 && isExecutable(fromEnv)) return fromEnv;
  for (const candidate of ["/bin/sh", "/bin/bash", "/bin/zsh"]) {
    if (isExecutable(candidate)) return candidate;
  }
  return "/bin/sh";
}

function loginShells(): string[] {
  try {
    return readFileSync("/etc/shells", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function shellArgs(name: string): string[] {
  const key = name.toLowerCase();
  if (key === "cmd") return [];
  if (key === "pwsh" || key === "powershell") return ["-NoLogo"];
  return ["-i"];
}

function isExecutable(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveOnPath(name: string): string | null {
  if (isAbsolute(name)) return isExecutable(name) ? name : null;
  const path = process.env.PATH;
  if (path === undefined) return null;
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter((item) => item.length > 0)
      : [""];
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The real loader: `createRequire` rather than a static import, because the
 * module is optional and a static import would make the build depend on a
 * native binary that need not exist.
 */
function loadNodePty(): PtyModule {
  const require = createRequire(import.meta.url);
  const loaded = require("node-pty") as PtyModule;
  restoreSpawnHelper(require);
  return loaded;
}

/**
 * Give node-pty's `spawn-helper` its execute bit back.
 *
 * Some installers unpack it as `rw-r--r--`; the symptom is `posix_spawnp
 * failed`, which reads like a sandbox problem and sends people looking in the
 * wrong place. Idempotent, best-effort.
 */
function restoreSpawnHelper(require: NodeRequire): void {
  if (process.platform === "win32") return;
  let root: string;
  try {
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
    // A read-only install directory. The spawn will report what went wrong.
  }
}

/** The environment a user's shell gets: inherited, with TERM forced. */
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
function clampDimension(value: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(2, Math.round(value)));
}

/**
 * The shell a plain "New terminal" opens.
 *
 * Kept as a named export so the rule stays testable on its own: the host's
 * login shell, not a fixed `bash`, which is what the reference sidebar does.
 */
export function pickShell(shells: TerminalShell[]): TerminalShell | null {
  return shells[0] ?? null;
}
