import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus, type BusEvent } from "./bus.ts";
import { addProject } from "./projects.ts";
import { resetStoreCache } from "./store.ts";
import { WorkspaceWatcher, isIgnoredPath } from "./workspace-watch.ts";

let projectRoot: string;
let bus: EventBus;
let watcher: WorkspaceWatcher | null = null;

beforeAll(async () => {
  projectRoot = await realpath(await mkdtemp(join(tmpdir(), "piws-workspace-")));
  // Built once, far from any watcher: a directory created just before a
  // watcher is up gets replayed by FSEvents with a null filename.
  await mkdir(join(projectRoot, "with-deps", "node_modules", "pkg"), { recursive: true });
});

beforeEach(async () => {
  await rm(join(process.env.PI_WEB_SIMPLE_HOME!, "store.json"), { force: true });
  resetStoreCache();
  bus = new EventBus();
  watcher = null;
});

afterEach(() => {
  watcher?.stop();
});

async function collectEvents(): Promise<BusEvent[]> {
  const events: BusEvent[] = [];
  bus.subscribe((event) => events.push(event));
  return events;
}

describe("WorkspaceWatcher", () => {
  it("watches every registered project", async () => {
    const projectPath = join(projectRoot, "watched");
    await mkdir(projectPath, { recursive: true });
    await addProject(projectPath);

    watcher = new WorkspaceWatcher({ bus });
    await watcher.start();

    expect(watcher.watchedProjects).toEqual([projectPath]);
  });

  it("emits workspace_changed when a file deep in the tree changes", async () => {
    const projectPath = join(projectRoot, "edited");
    await mkdir(join(projectPath, "src", "deep"), { recursive: true });
    await addProject(projectPath);

    watcher = new WorkspaceWatcher({ bus });
    await watcher.start();
    const events = await collectEvents();

    await writeFile(join(projectPath, "src", "deep", "file.ts"), "x", "utf8");

    await vi.waitFor(
      () => {
        expect(events.some((event) => event.type === "workspace_changed")).toBe(true);
      },
      { timeout: 5000 },
    );
    const changed = events.find((event) => event.type === "workspace_changed");
    expect(changed && "projectPath" in changed ? changed.projectPath : "").toBe(projectPath);
  });

  it("ignores dependency churn", async () => {
    const projectPath = join(projectRoot, "with-deps");
    await addProject(projectPath);

    watcher = new WorkspaceWatcher({ bus });
    await watcher.start();
    const events = await collectEvents();

    await writeFile(join(projectPath, "node_modules", "pkg", "index.js"), "x", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(events.some((event) => event.type === "workspace_changed")).toBe(false);
  });

  it("stops watching a project after it is removed", async () => {
    const projectPath = join(projectRoot, "transient");
    await mkdir(projectPath, { recursive: true });
    const project = await addProject(projectPath);

    watcher = new WorkspaceWatcher({ bus });
    await watcher.start();
    expect(watcher.watchedProjects).toHaveLength(1);

    const { removeProject } = await import("./projects.ts");
    await removeProject(project.id);
    await watcher.sync();

    expect(watcher.watchedProjects).toHaveLength(0);
  });

  it("stop() releases every watcher", async () => {
    const projectPath = join(projectRoot, "closing");
    await mkdir(projectPath, { recursive: true });
    await addProject(projectPath);

    watcher = new WorkspaceWatcher({ bus });
    await watcher.start();
    watcher.stop();
    expect(watcher.watchedProjects).toHaveLength(0);
  });
});

describe("isIgnoredPath", () => {
  it("matches whole path segments only", () => {
    expect(isIgnoredPath("node_modules/pkg/index.js")).toBe(true);
    expect(isIgnoredPath("a/b/node_modules")).toBe(true);
    expect(isIgnoredPath("node_modules")).toBe(true);
    // A name that merely starts with the string is a real source file.
    expect(isIgnoredPath("src/node_modules_helper.ts")).toBe(false);
  });

  it("keeps ordinary paths", () => {
    expect(isIgnoredPath("src/index.ts")).toBe(false);
    expect(isIgnoredPath("top.txt")).toBe(false);
  });
});
