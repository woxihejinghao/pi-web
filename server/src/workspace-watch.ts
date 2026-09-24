import { watch, type FSWatcher } from "node:fs";
import type { EventBus } from "./bus.ts";
import { listProjects } from "./projects.ts";

/** Coalesce the burst a save, a formatter, or a build produces. */
const DEBOUNCE_MS = 400;

/**
 * Path segments whose churn a git panel never shows.
 *
 * `node_modules` is the important one: an install rewrites thousands of files,
 * and none of them is a change the panel should reload for. The filter runs on
 * the event, not on the watch, so the directories are still watched on
 * platforms where `recursive` walks them — this saves the reload, not the
 * subscription.
 */
const IGNORED_SEGMENTS = new Set(["node_modules", ".pnpm-store"]);

export interface WorkspaceWatcherDeps {
  bus: EventBus;
}

/**
 * Watches each project's working tree so the changes panel can follow edits
 * nobody made through it: an editor save, a formatter, a build, or a `git`
 * command run in a terminal.
 *
 * Recursive per project — one watcher per registered project, added and dropped
 * with the project list, like `SessionWatcher`. The panel is what decides
 * whether a change is worth a `git status` read; this side only says that
 * something moved.
 */
export class WorkspaceWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private readonly bus: EventBus;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(deps: WorkspaceWatcherDeps) {
    this.bus = deps.bus;
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
      }
    }

    for (const projectPath of wanted) {
      if (this.watchers.has(projectPath)) continue;
      try {
        const watcher = watch(
          projectPath,
          { recursive: true, persistent: false },
          (_event, filename) => {
            this.onChange(projectPath, filename);
          },
        );
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(projectPath);
        });
        this.watchers.set(projectPath, watcher);
      } catch {
        // A directory that cannot be watched (permissions, or gone since it was
        // registered) simply gets no watcher; the panel's own refresh still works.
      }
    }
  }

  private onChange(projectPath: string, filename: string | Buffer | null): void {
    if (this.stopped) return;
    if (filename !== null) {
      const name = typeof filename === "string" ? filename : filename.toString();
      if (isIgnoredPath(name)) return;
    }

    const existing = this.debounce.get(projectPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounce.delete(projectPath);
      this.bus.publish({ type: "workspace_changed", projectPath });
    }, DEBOUNCE_MS);
    timer.unref?.();
    this.debounce.set(projectPath, timer);
  }

  get watchedProjects(): string[] {
    return [...this.watchers.keys()];
  }
}

/**
 * Whether a path the watcher reported should be ignored.
 *
 * Whole segments only, so `src/node_modules_helper.ts` is not filtered. A null
 * filename (FSEvents reports one for some directory-level changes, and for the
 * replay it delivers when a watcher is created) cannot be attributed to
 * anything, so it is kept — one redundant refresh beats a missed edit.
 */
export function isIgnoredPath(name: string): boolean {
  return name.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment));
}
