import { SessionManager, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { TITLE_MAX_BYTES } from "./config.ts";
import { readProviderConnection } from "./models.ts";
import type { SessionHandle } from "./registry.ts";
import { messageText } from "./session-reader.ts";
import { sessionTitleOf, setSessionTitle, type SessionTitleWriter } from "./session-title.ts";
import { completeTitle } from "./title-llm.ts";
import { clipTitle } from "./title-text.ts";
import { readStore } from "./store.ts";

export interface TitleServiceDeps {
  /**
   * The live writer for a session, or `undefined` when no pi process holds it.
   * Injected so the service never has to know about the registry.
   */
  liveWriter: (sessionPath: string) => SessionTitleWriter | undefined;
  /** Announce a title that landed, so the sidebar refetches. */
  publish: (projectPath: string) => void;
  log?: { warn(message: string): void };
}

interface Work {
  revision: number;
  controller: AbortController;
}

/**
 * Writes a model-generated title for a session that has none.
 *
 * This is the optional half of session naming: the deterministic title derived
 * from the first message (`sessions.ts`) always exists, and this only replaces
 * it when the user has both picked a model and left it to run. Everything about
 * the design follows from "a title is a nicety that must never cost the user
 * anything visible":
 *
 * - One attempt per session, on its first human message. Nothing re-runs on
 *   later messages, so a long conversation does not keep buying titles.
 * - A name the session already has wins, checked before the call and again
 *   before the write. That second check is what makes a rename during the
 *   round trip stick instead of being overwritten by a stale answer.
 * - Failures are silent. A missing automatic title is not something the user
 *   can act on, and the deterministic title is already on screen.
 * - Supersession aborts the in-flight call rather than racing it, following
 *   dsh's revision rule; the revision also keeps a stale result from landing
 *   after a newer one.
 */
export class SessionTitleService {
  private readonly work = new Map<string, Work>();
  /** Sessions already considered: one title attempt each, ever. */
  private readonly attempted = new Set<string>();
  private stopped = false;

  constructor(private readonly deps: TitleServiceDeps) {}

  /** One pi event; only a session's first human message starts anything. */
  noteEvent(handle: SessionHandle, event: JsonAgentSessionEvent): void {
    if (this.stopped || event.type !== "entry_appended") return;
    const entry = event.entry;
    if (entry.type !== "message" || entry.message.role !== "user") return;
    // A session pi has not written yet has no file, so there is nowhere to put
    // a title; its first message will arrive again once it does.
    if (handle.sessionPath.length === 0) return;
    this.schedule(handle, messageText(entry.message.content));
  }

  /** Forget a session, so its path can be titled again if it reappears. */
  forget(sessionPath: string): void {
    this.work.get(sessionPath)?.controller.abort();
    this.work.delete(sessionPath);
    this.attempted.delete(sessionPath);
  }

  /** Abort everything in flight; called on shutdown. */
  stop(): void {
    this.stopped = true;
    for (const work of this.work.values()) work.controller.abort();
    this.work.clear();
  }

  private schedule(handle: SessionHandle, text: string): void {
    const { sessionPath } = handle;
    if (this.attempted.has(sessionPath)) return;
    this.attempted.add(sessionPath);
    const revision = this.supersede(sessionPath);
    const controller = this.work.get(sessionPath)!.controller;
    void this.run(handle, text, revision, controller.signal).catch((error: unknown) => {
      this.warn(`session "${handle.sessionId}": automatic title failed: ${String(error)}`);
    });
  }

  private async run(
    handle: SessionHandle,
    text: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { sessionPath } = handle;
    const { titleModel } = (await readStore()).settings;
    if (titleModel === null || text.trim().length === 0) return;

    // Before spending anything: does the name already exist, and is this a
    // session that should be named at all?
    if (!this.isCurrent(sessionPath, revision)) return;
    if (sessionTitleOf(sessionPath) !== undefined) return;
    if (isChildSession(sessionPath)) return;

    const connection = await readProviderConnection(titleModel.provider);
    if (connection === undefined || !this.isCurrent(sessionPath, revision)) return;

    const title = await completeTitle({
      connection,
      model: titleModel.model,
      text,
      signal,
    });
    if (!this.isCurrent(sessionPath, revision) || signal.aborted) return;

    // Asked again after the round trip: a rename while the model was thinking
    // is the user's answer, and it outranks this one.
    if (sessionTitleOf(sessionPath) !== undefined) return;
    await setSessionTitle(sessionPath, clipTitle(title, TITLE_MAX_BYTES), this.deps.liveWriter(sessionPath));
    this.deps.publish(handle.projectPath);
  }

  private supersede(sessionPath: string): number {
    const previous = this.work.get(sessionPath);
    previous?.controller.abort();
    const revision = (previous?.revision ?? 0) + 1;
    this.work.set(sessionPath, { revision, controller: new AbortController() });
    return revision;
  }

  private isCurrent(sessionPath: string, revision: number): boolean {
    const work = this.work.get(sessionPath);
    return !this.stopped && work !== undefined && work.revision === revision;
  }

  private warn(message: string): void {
    this.deps.log?.warn(`[pi-web-simple] ${message}`);
  }
}

/**
 * Whether this session was forked from another one. dsh only auto-names a
 * session a user started, and a fork inherits enough of its parent's context
 * that a fresh name would describe the wrong thing.
 */
function isChildSession(sessionPath: string): boolean {
  try {
    return SessionManager.open(sessionPath).getHeader()?.parentSession !== undefined;
  } catch {
    return false;
  }
}
