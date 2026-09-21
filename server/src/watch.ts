import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "./bus.ts";
import { listProjects } from "./projects.ts";
import type { SessionRegistry } from "./registry.ts";
import { getSessionRoot, sessionDirFor } from "./session-path.ts";

/** Coalesce the burst of events a single file write produces. */
const DEBOUNCE_MS = 200;

/**
 * How long after our own activity a file change is still attributed to us.
 * pi writes the JSONL right around its events, and we subscribe to those, so
 * anything landing well after the last event came from another process.
 */
const SELF_WRITE_WINDOW_MS = 3000;

export interface WatcherDeps {
  registry: SessionRegistry;
  bus: EventBus;
  sessionRoot?: string;
}

/**
 * Watches each project's pi session directory so the Web UI notices sessions
 * created or updated by the `pi` CLI.
 *
 * Per-project, non-recursive: pi stores a project's sessions as flat files in
 * one directory, so a single `fs.watch` per project covers everything.
 */
export class SessionWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, Set<string>>();
  private readonly registry: SessionRegistry;
  private readonly bus: EventBus;
  private readonly sessionRoot: string;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(deps: WatcherDeps) {
    this.registry = deps.registry;
    this.bus = deps.bus;
    this.sessionRoot = deps.sessionRoot ?? getSessionRoot();
  }

  /** Begin watching, and keep the watch set in step with project changes. */
  async start(): Promise<void> {
    this.unsubscribe = this.bus.subscribe((event) => {
      if (event.type === "projects_changed") void this.sync();
    });
    await this.sync();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    this.pending.clear();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  /** Add watchers for new projects and drop watchers for removed ones. */
  async sync(): Promise<void> {
    if (this.stopped) return;
    const projects = await listProjects();
    const wanted = new Set(projects.map((project) => project.path));

    for (const [projectPath, watcher] of this.watchers) {
      if (!wanted.has(projectPath)) {
        watcher.close();
        this.watchers.delete(projectPath);
        const timer = this.debounce.get(projectPath);
        if (timer) clearTimeout(timer);
        this.debounce.delete(projectPath);
        this.pending.delete(projectPath);
      }
    }

    for (const projectPath of wanted) {
      if (this.watchers.has(projectPath)) continue;
      const dir = sessionDirFor(projectPath, this.sessionRoot);
      try {
        // pi creates this lazily; watching a missing directory throws.
        mkdirSync(dir, { recursive: true });
        const watcher = watch(dir, { persistent: false }, (_event, filename) => {
          this.onChange(projectPath, filename);
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(projectPath);
        });
        this.watchers.set(projectPath, watcher);
      } catch {
        // A project directory that cannot host sessions (permissions) simply
        // gets no watcher; the session list still loads on demand.
      }
    }
  }

  private onChange(projectPath: string, filename: string | Buffer | null): void {
    if (this.stopped) return;
    const name = typeof filename === "string" ? filename : filename?.toString();
    const changed = this.pending.get(projectPath) ?? new Set<string>();
    // A null filename means "something in this directory changed".
    changed.add(name ?? "*");
    this.pending.set(projectPath, changed);

    const existing = this.debounce.get(projectPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounce.delete(projectPath);
      const names = this.pending.get(projectPath);
      this.pending.delete(projectPath);
      if (names) this.flush(projectPath, names);
    }, DEBOUNCE_MS);
    timer.unref?.();
    this.debounce.set(projectPath, timer);
  }

  private flush(projectPath: string, names: Set<string>): void {
    const dir = sessionDirFor(projectPath, this.sessionRoot);
    // Any change we cannot attribute to a live process we own makes the
    // session list stale, so the UI refetches it.
    let sawUnattributed = false;

    for (const name of names) {
      if (name === "*" || !name.endsWith(".jsonl")) {
        sawUnattributed = true;
        continue;
      }
      const sessionPath = join(dir, name);
      const handle = this.registry.get(sessionPath);
      if (!handle || handle.dead) {
        sawUnattributed = true;
        continue;
      }
      if (Date.now() - handle.lastActivityAt <= SELF_WRITE_WINDOW_MS) {
        continue; // our own process is writing this session
      }
      // We own a live process for this session, yet the file moved long after
      // our last event: another process (the CLI) appended to it.
      this.bus.publish({
        type: "session_external_changed",
        sessionPath,
        modifiedAt: new Date().toISOString(),
      });
    }

    if (sawUnattributed) {
      this.bus.publish({ type: "sessions_changed", projectPath });
    }
  }

  get watchedProjects(): string[] {
    return [...this.watchers.keys()];
  }
}
