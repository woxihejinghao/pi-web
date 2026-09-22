import {
  getPackageDir,
  RpcClient,
  type JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { IDLE_TIMEOUT_MS, MAX_ACTIVE_SESSIONS, SESSION_DIR_OVERRIDE } from "./config.ts";

/**
 * `RpcClient` spawns `node <cliPath> --mode rpc ...` with `cwd` set to the
 * project. Its default `cliPath` is the *relative* string "dist/cli.js", which
 * cannot resolve against a project directory, so the absolute path from the
 * installed package is mandatory here.
 */
const DEFAULT_CLI_PATH = join(getPackageDir(), "dist/cli.js");

/**
 * Subset of pi's `RpcSlashCommand` that this UI consumes. Declared locally
 * because the package root exports `SlashCommandInfo` (the extension-API
 * shape) but not the RPC one returned by `get_commands`.
 *
 * `builtin` is never reported by pi: those commands are implemented by the
 * client, so the API layer merges them in from `commands.ts`.
 */
export interface SlashCommand {
  /** Command name without the leading slash, e.g. "skill:pdf-tools". */
  name: string;
  description?: string;
  /** Where the command came from; decides its section in the completion menu. */
  source: "builtin" | "extension" | "prompt" | "skill";
}

/**
 * How long an enumerated command list is reused. The set is fixed for a
 * process's lifetime, but a settings or skill change should show up without a
 * server restart, so the cache expires on its own.
 */
const COMMANDS_TTL_MS = 60_000;

export interface SessionRegistryOptions {
  /** Absolute path to pi's CLI entry point. Overridden in tests. */
  cliPath?: string;
  idleTimeoutMs?: number;
  maxActiveSessions?: number;
  /** Force pi to store sessions under this root (mirrors PI_WEB_SIMPLE_SESSION_DIR). */
  sessionDir?: string | null;
}

export interface SessionHandle {
  /** Absolute path of the pi session JSONL file. Also the registry key. */
  sessionPath: string;
  sessionId: string;
  /** Canonical project directory; the spawned process's cwd. */
  projectPath: string;
  client: RpcClient;
  startedAt: number;
  lastActivityAt: number;
  /** Detaches the RpcClient event subscription. */
  unsubscribe: () => void;
  /** Set when an RPC call failed; the handle is replaced on next open. */
  dead: boolean;
  /**
   * Spawned ahead of demand. An unclaimed prewarm produces no session file
   * (pi only writes once an assistant message arrives) and is dropped when a
   * different project is prewarmed or when the idle sweeper reaches it.
   */
  prewarmed: boolean;
}

export type SessionEventListener = (handle: SessionHandle, event: JsonAgentSessionEvent) => void;
export type SessionClosedListener = (handle: SessionHandle, reason: string) => void;

/** One writer per session file, enforced in-process. */
class SessionRegistry {
  private readonly handles = new Map<string, SessionHandle>();
  private readonly pending = new Map<string, Promise<SessionHandle>>();
  /** One in-flight prewarm per project path. */
  private readonly prewarming = new Map<string, Promise<SessionHandle | null>>();
  /** Enumerated slash commands per project path. */
  private readonly commandsCache = new Map<string, { at: number; commands: SlashCommand[] }>();
  private eventListeners = new Set<SessionEventListener>();
  private closedListeners = new Set<SessionClosedListener>();
  private sweeper: NodeJS.Timeout | null = null;
  private readonly cliPath: string;
  private readonly idleTimeoutMs: number;
  private readonly maxActiveSessions: number;
  private readonly sessionDir: string | null;

  constructor(options: SessionRegistryOptions = {}) {
    this.cliPath = options.cliPath ?? DEFAULT_CLI_PATH;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.maxActiveSessions = options.maxActiveSessions ?? MAX_ACTIVE_SESSIONS;
    this.sessionDir = options.sessionDir ?? SESSION_DIR_OVERRIDE;
  }

  onEvent(listener: SessionEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClosed(listener: SessionClosedListener): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  /**
   * Attach to a session, spawning a pi RPC process on first use.
   *
   * Omit `sessionPath` to start a fresh session: pi mints the path itself and
   * reports it through `get_state`, which then becomes the registry key. The
   * file may not exist yet — pi only writes it once an assistant message
   * arrives — but the path is stable for the life of this process.
   */
  async open(projectPath: string, sessionPath?: string): Promise<SessionHandle> {
    const requestedKey = sessionPath ? resolve(sessionPath) : undefined;

    if (requestedKey) {
      const live = this.handles.get(requestedKey);
      if (live && !live.dead) {
        live.lastActivityAt = Date.now();
        return live;
      }
      if (live) this.handles.delete(requestedKey);

      const inflight = this.pending.get(requestedKey);
      if (inflight) return inflight;
    }

    const promise = this.spawn(projectPath, requestedKey, false);
    if (requestedKey) {
      this.pending.set(requestedKey, promise);
      void promise.then(
        () => this.pending.delete(requestedKey),
        () => this.pending.delete(requestedKey),
      );
    }
    return promise;
  }

  /**
   * Spawn a session before anyone asks for one.
   *
   * A cold pi start costs ~1.6s, so having one ready makes "new session"
   * effectively instant. Fire-and-forget: failures are swallowed because the
   * on-demand path is still there as a fallback.
   */
  async prewarm(projectPath: string): Promise<void> {
    await this.ensurePrewarmed(projectPath);
  }

  /**
   * Spawn (or join) the prewarmed session for a project and hand back its
   * handle. Unlike `prewarm()` this reports the process, which listing slash
   * commands needs: commands only exist inside a running pi process, and a
   * prewarmed one is the cheapest way to have one.
   *
   * The handle stays marked as prewarmed, so it is still available for
   * `claimPrewarmed()` afterwards.
   */
  async ensurePrewarmed(projectPath: string): Promise<SessionHandle | null> {
    const warm = this.findPrewarmed(projectPath);
    if (warm) return warm;

    const inflight = this.prewarming.get(projectPath);
    if (inflight) return inflight;

    const promise = (async (): Promise<SessionHandle | null> => {
      // Only one unclaimed prewarm should exist; a stale one for another
      // project would otherwise linger until the idle sweeper reaches it.
      await this.dropPrewarmedExcept(projectPath);
      try {
        return await this.spawn(projectPath, undefined, true);
      } catch {
        // Prewarming is best-effort; the on-demand path is still available.
        return null;
      }
    })();

    this.prewarming.set(projectPath, promise);
    try {
      return await promise;
    } finally {
      this.prewarming.delete(projectPath);
    }
  }

  /**
   * Slash commands registered for a project: extension commands, prompt
   * templates, and skill commands (`/skill:name`).
   *
   * pi expands skill and template commands itself before delivering a prompt,
   * so the client only needs to complete the text.
   */
  async listCommands(projectPath: string): Promise<SlashCommand[]> {
    const cached = this.commandsCache.get(projectPath);
    if (cached && Date.now() - cached.at < COMMANDS_TTL_MS) return cached.commands;

    const handle = this.findLive(projectPath) ?? (await this.ensurePrewarmed(projectPath));
    if (!handle) throw new Error("no pi process available to enumerate commands");

    let commands: SlashCommand[];
    try {
      commands = await handle.client.getCommands();
    } catch (err) {
      // The process answered the handshake but not this request; drop it so
      // the next call respawns instead of reusing a broken client.
      await this.close(handle.sessionPath, "commands-failed");
      throw err;
    }

    handle.lastActivityAt = Date.now();
    this.commandsCache.set(projectPath, { at: Date.now(), commands });
    return commands;
  }

  /** Any live session attached to this project, prewarmed or not. */
  findLive(projectPath: string): SessionHandle | null {
    for (const handle of this.handles.values()) {
      if (!handle.dead && handle.projectPath === projectPath) return handle;
    }
    return null;
  }

  /**
   * Take the prewarmed session for a project, promoting it to a real session.
   * Returns null when nothing is warm, in which case the caller spawns.
   */
  claimPrewarmed(projectPath: string): SessionHandle | null {
    const handle = this.findPrewarmed(projectPath);
    if (!handle) return null;
    handle.prewarmed = false;
    handle.lastActivityAt = Date.now();
    return handle;
  }

  /** Prewarmed handles still waiting to be claimed. */
  private findPrewarmed(projectPath: string): SessionHandle | null {
    for (const handle of this.handles.values()) {
      if (handle.prewarmed && !handle.dead && handle.projectPath === projectPath) {
        return handle;
      }
    }
    return null;
  }

  private async dropPrewarmedExcept(projectPath: string): Promise<void> {
    for (const handle of [...this.handles.values()]) {
      if (handle.prewarmed && handle.projectPath !== projectPath) {
        await this.close(handle.sessionPath, "prewarm-superseded");
      }
    }
  }

  get(sessionPath: string): SessionHandle | undefined {
    return this.handles.get(resolve(sessionPath));
  }

  list(): SessionHandle[] {
    return [...this.handles.values()];
  }

  touch(sessionPath: string): void {
    const handle = this.handles.get(resolve(sessionPath));
    if (handle) handle.lastActivityAt = Date.now();
  }

  /** Call after an RPC failure so the next open() respawns instead of reusing. */
  markDead(sessionPath: string): void {
    const handle = this.handles.get(resolve(sessionPath));
    if (handle) handle.dead = true;
  }

  async close(sessionPath: string, reason = "closed"): Promise<void> {
    const key = resolve(sessionPath);
    const handle = this.handles.get(key);
    if (!handle) return;
    this.handles.delete(key);
    handle.dead = true;
    handle.unsubscribe();
    try {
      await handle.client.stop();
    } catch {
      // A process that already exited is the expected steady state here.
    }
    for (const listener of this.closedListeners) listener(handle, reason);
  }

  async closeAll(reason = "shutdown"): Promise<void> {
    const keys = [...this.handles.keys()];
    await Promise.all(keys.map((key) => this.close(key, reason)));
  }

  /**
   * Close every resident session except `keep` (which may be null to close all).
   *
   * Used after writing a *global* pi setting over RPC. Those writes land in
   * pi's own settings file, and only a freshly started process reads it — a
   * process spawned earlier keeps serving the value it booted with. Retiring
   * those handles costs one cold start on the next switch, which is the right
   * trade for not showing a stale mode in another open session.
   */
  async closeAllExcept(keep: SessionHandle | null, reason: string): Promise<void> {
    const keepKey = keep === null ? null : resolve(keep.sessionPath);
    const keys = [...this.handles.keys()].filter((key) => key !== keepKey);
    await Promise.all(keys.map((key) => this.close(key, reason)));
  }

  /** Start the idle sweeper. Returns a stop function. */
  startSweeper(intervalMs = 30_000): () => void {
    if (this.sweeper) return () => this.stopSweeper();
    this.sweeper = setInterval(() => {
      void this.evictIdle();
    }, intervalMs);
    this.sweeper.unref?.();
    return () => this.stopSweeper();
  }

  private stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** Drop idle processes, then the least-recently-used ones above the cap. */
  async evictIdle(now = Date.now()): Promise<void> {
    for (const handle of [...this.handles.values()]) {
      if (now - handle.lastActivityAt > this.idleTimeoutMs) {
        await this.close(handle.sessionPath, "idle-timeout");
      }
    }
    if (this.handles.size <= this.maxActiveSessions) return;
    const byAge = [...this.handles.values()].sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    const excess = this.handles.size - this.maxActiveSessions;
    for (const handle of byAge.slice(0, excess)) {
      await this.close(handle.sessionPath, "capacity");
    }
  }

  private async spawn(
    projectPath: string,
    sessionPath?: string,
    prewarmed = false,
  ): Promise<SessionHandle> {
    const client = new RpcClient({
      cliPath: this.cliPath,
      cwd: projectPath,
      args: [
        ...(this.sessionDir ? ["--session-dir", this.sessionDir] : []),
        ...(sessionPath ? ["--session", sessionPath] : []),
      ],
    });

    // Subscribe before start() so no early event is dropped.
    const handle: SessionHandle = {
      sessionPath: sessionPath ?? "",
      sessionId: "",
      projectPath,
      client,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      unsubscribe: () => undefined,
      dead: false,
      prewarmed,
    };
    const unsubscribe = client.onEvent((event) => {
      handle.lastActivityAt = Date.now();
      for (const listener of this.eventListeners) listener(handle, event);
    });
    handle.unsubscribe = unsubscribe;

    try {
      await client.start();
    } catch (err) {
      handle.unsubscribe();
      throw err;
    }

    let state: Awaited<ReturnType<RpcClient["getState"]>>;
    try {
      state = await client.getState();
    } catch (err) {
      handle.unsubscribe();
      await client.stop().catch(() => undefined);
      throw err;
    }

    const key = state.sessionFile ? resolve(state.sessionFile) : sessionPath;
    if (!key) {
      handle.unsubscribe();
      await client.stop().catch(() => undefined);
      throw new Error("pi did not report a session file for the new session");
    }

    // A fresh session resolves its key only after start(); if a concurrent
    // open() already claimed it, keep the existing owner and discard this one.
    const existing = this.handles.get(key);
    if (existing && existing !== handle) {
      handle.unsubscribe();
      await client.stop().catch(() => undefined);
      return existing;
    }
    handle.sessionPath = key;
    handle.sessionId = state.sessionId;
    this.handles.set(key, handle);
    return handle;
  }
}

export const registry = new SessionRegistry();

/**
 * Write one raw frame to the pi process's stdin.
 *
 * This exists for `extension_ui_response`, and it deliberately bypasses
 * `RpcClient.send()`. That method is a request/response channel: it stamps its
 * own request id over the caller's (so pi could never match the answer to the
 * dialog that asked) and then waits for a reply line. `extension_ui_response`
 * has no reply — it is fire-and-forget on pi's side — so going through `send()`
 * leaves the caller waiting until a 30s timeout rejects it, with the dialog
 * unanswered the whole time.
 *
 * `RpcClient` implements the UI sub-protocol on the read side (every
 * non-response line reaches `onEvent`) but exposes no public write path, so this
 * reaches into its private child process. The frame format is the same JSONL
 * rule the client writes for its own commands.
 */
export function sendRawCommand(client: RpcClient, command: unknown): void {
  const stdin = (client as unknown as { process?: { stdin?: Writable } }).process?.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    throw new Error("pi process stdin is not writable; cannot answer the dialog");
  }
  stdin.write(`${JSON.stringify(command)}\n`);
}

export { SessionRegistry, DEFAULT_CLI_PATH };
