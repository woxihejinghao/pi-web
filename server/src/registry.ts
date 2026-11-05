import {
  getPackageDir,
  RpcClient,
  type JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { IDLE_TIMEOUT_MS, MAX_ACTIVE_SESSIONS, SESSION_DIR_OVERRIDE } from "./config.ts";
import { DEFAULT_PRESET_ID, presetSpawnArgs } from "./presets.ts";
import { LiveImageStore, type SessionImage } from "./session-images.ts";
import { readStore } from "./store.ts";

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
  /**
   * The agent preset this process was composed with.
   *
   * Fixed for the handle's life: it decided the spawn arguments, and pi offers
   * no way to change the tool set or system prompt of a running process. A
   * session that should run a different preset needs a new process, which means
   * a new session — see `presets.ts`.
   */
  presetId: string;
  client: RpcClient;
  startedAt: number;
  lastActivityAt: number;
  /**
   * pi's agent loop is between `agent_start` and `agent_settled`.
   *
   * Memory is authoritative while this is set: pi appends each committed entry
   * to the session file as it lands, so the file is current again the moment the
   * run ends — but the assistant message still streaming has no file line yet,
   * and `message_update` carries deltas rather than a snapshot, so a reader that
   * missed the start of it could never assemble the text. See the `/messages`
   * route, which is the only reason this flag exists.
   */
  running: boolean;
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
  /**
   * Live transcripts' images, keyed exactly like the handles they came from and
   * dropped with them: the bytes are pi's memory, so they must not outlive the
   * process that could serve them. See `LiveImageStore`.
   */
  private readonly liveImages = new Map<string, LiveImageStore>();
  private readonly pending = new Map<string, Promise<SessionHandle>>();
  /** One in-flight prewarm per project path and preset. */
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
   *
   * `presetId` is what the process gets composed with, and it is the caller's
   * job to know it: a fresh session takes the user's choice, while an existing
   * one takes whatever its file says (`session-preset.ts`). Only a fresh spawn
   * consumes it — an already-live handle keeps the composition it booted with.
   */
  async open(
    projectPath: string,
    sessionPath?: string,
    presetId: string = DEFAULT_PRESET_ID,
  ): Promise<SessionHandle> {
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

    const promise = this.spawn(projectPath, requestedKey, false, presetId);
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
  async prewarm(projectPath: string, presetId: string = DEFAULT_PRESET_ID): Promise<void> {
    await this.ensurePrewarmed(projectPath, presetId);
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
  async ensurePrewarmed(
    projectPath: string,
    presetId: string = DEFAULT_PRESET_ID,
  ): Promise<SessionHandle | null> {
    const warm = this.findPrewarmed(projectPath, presetId);
    if (warm) return warm;

    const key = this.compositionKey(projectPath, presetId);
    const inflight = this.prewarming.get(key);
    if (inflight) return inflight;

    const promise = (async (): Promise<SessionHandle | null> => {
      // Only one unclaimed prewarm should exist; a stale one for another
      // project or composition would otherwise linger until the idle sweeper
      // reaches it.
      await this.dropPrewarmedExcept(projectPath, presetId);
      try {
        return await this.spawn(projectPath, undefined, true, presetId);
      } catch {
        // Prewarming is best-effort; the on-demand path is still available.
        return null;
      }
    })();

    this.prewarming.set(key, promise);
    try {
      return await promise;
    } finally {
      this.prewarming.delete(key);
    }
  }

  /**
   * Slash commands one composition registers: extension commands, prompt
   * templates, and skill commands (`/skill:name`).
   *
   * pi expands skill and template commands itself before delivering a prompt,
   * so the client only needs to complete the text.
   *
   * The composition is part of the question rather than an implementation
   * detail. A minimal process registers no prompt templates and no skills, so
   * its menu is the client's built-ins plus whatever its one `--extension` put
   * back (`/web`). Answering a minimal session from a standard process would
   * offer commands that session cannot run — which is why the handle is matched
   * by preset instead of taking "any live process in this project".
   */
  async listCommands(
    projectPath: string,
    presetId: string = DEFAULT_PRESET_ID,
  ): Promise<SlashCommand[]> {
    const key = this.compositionKey(projectPath, presetId);
    const cached = this.commandsCache.get(key);
    if (cached && Date.now() - cached.at < COMMANDS_TTL_MS) return cached.commands;

    const handle =
      this.findLive(projectPath, presetId) ?? (await this.ensurePrewarmed(projectPath, presetId));
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
    this.commandsCache.set(key, { at: Date.now(), commands });
    return commands;
  }

  /**
   * A live session attached to this project, prewarmed or not.
   *
   * `presetId` narrows it to one composition. Omit it for "some process that
   * can answer for this project" — the question `openSession` and the capacity
   * sweeper ask — and pass it wherever the answer belongs to a composition.
   */
  findLive(projectPath: string, presetId?: string): SessionHandle | null {
    for (const handle of this.handles.values()) {
      if (handle.dead || handle.projectPath !== projectPath) continue;
      if (presetId !== undefined && handle.presetId !== presetId) continue;
      return handle;
    }
    return null;
  }

  /**
   * Take the prewarmed session for a project, promoting it to a real session.
   * Returns null when nothing is warm, in which case the caller spawns.
   */
  claimPrewarmed(projectPath: string, presetId: string = DEFAULT_PRESET_ID): SessionHandle | null {
    // A prewarm is composed for one preset, and a process cannot be recomposed.
    // Handing a standard process to a minimal request would silently give the
    // user the full tool set, so a mismatched prewarm is simply not claimed —
    // the caller spawns instead, and the warm process stays for the next
    // standard session.
    const handle = this.findPrewarmed(projectPath, presetId);
    if (!handle) return null;
    handle.prewarmed = false;
    handle.lastActivityAt = Date.now();
    return handle;
  }

  /** Prewarmed handles still waiting to be claimed, for one composition. */
  private findPrewarmed(projectPath: string, presetId: string): SessionHandle | null {
    for (const handle of this.handles.values()) {
      if (
        handle.prewarmed &&
        !handle.dead &&
        handle.projectPath === projectPath &&
        handle.presetId === presetId
      ) {
        return handle;
      }
    }
    return null;
  }

  /**
   * Identity of one composition of a project: its path paired with a preset.
   *
   * Doubles as the prewarm slot key and the command-cache key, because both
   * answer the same question — "which composition is this about?" — and a menu
   * that resolved it differently from the process would offer commands the
   * session cannot run.
   */
  private compositionKey(projectPath: string, presetId: string): string {
    return `${projectPath}\u0000${presetId}`;
  }

  private async dropPrewarmedExcept(projectPath: string, presetId: string): Promise<void> {
    const keep = this.compositionKey(projectPath, presetId);
    for (const handle of [...this.handles.values()]) {
      if (handle.prewarmed && this.compositionKey(handle.projectPath, handle.presetId) !== keep) {
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

  /**
   * Name the images of one live transcript, so its response can hand out URLs
   * instead of shipping every screenshot inline. Answers the version those URLs
   * carry.
   */
  rememberLiveTranscript(sessionPath: string, images: SessionImage[]): string {
    const key = resolve(sessionPath);
    let store = this.liveImages.get(key);
    if (!store) {
      store = new LiveImageStore();
      this.liveImages.set(key, store);
    }
    return store.accept(images);
  }

  /**
   * The bytes one live transcript's image URL names, or null when that version
   * is not the current one — the transcript moved on, or the process is gone.
   * The endpoint answers 404 for null, which the reader heals on its next
   * transcript read.
   */
  readLiveImage(sessionPath: string, version: string, index: number): SessionImage | null {
    return this.liveImages.get(resolve(sessionPath))?.read(version, index) ?? null;
  }

  async close(sessionPath: string, reason = "closed"): Promise<void> {
    const key = resolve(sessionPath);
    // A move/delete must also retire an open already in flight, not just the
    // handles that happened to finish their startup before close() was called.
    const inflight = this.pending.get(key);
    if (inflight) await inflight.catch(() => undefined);
    const handle = this.handles.get(key);
    if (!handle) return;
    this.handles.delete(key);
    this.liveImages.delete(key);
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
    presetId: string = DEFAULT_PRESET_ID,
  ): Promise<SessionHandle> {
    const { systemPrompt } = (await readStore()).settings;
    const client = new RpcClient({
      cliPath: this.cliPath,
      cwd: projectPath,
      args: [
        ...(this.sessionDir ? ["--session-dir", this.sessionDir] : []),
        ...(sessionPath ? ["--session", sessionPath] : []),
        ...presetSpawnArgs(presetId),
        ...(systemPrompt.trim() ? ["--append-system-prompt", `\n${systemPrompt}`] : []),
      ],
    });

    // Subscribe before start() so no early event is dropped.
    const handle: SessionHandle = {
      sessionPath: sessionPath ?? "",
      sessionId: "",
      projectPath,
      presetId,
      client,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      running: false,
      unsubscribe: () => undefined,
      dead: false,
      prewarmed,
    };
    const unsubscribe = client.onEvent((event) => {
      handle.lastActivityAt = Date.now();
      // The two boundaries that say whether memory is ahead of the session file.
      // Everything in between is a token delta and leaves the flag alone.
      if (event.type === "agent_start") handle.running = true;
      else if (event.type === "agent_settled") handle.running = false;
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
