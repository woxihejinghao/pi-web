import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus, type BusEvent } from "./bus.ts";
import { addProject, removeProject } from "./projects.ts";
import { SessionRegistry } from "./registry.ts";
import { resetStoreCache } from "./store.ts";
import { sessionDirFor } from "./session-path.ts";
import { SessionWatcher } from "./watch.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_CLI = join(HERE, "testing", "stub-pi.mjs");

let projectRoot: string;
let sessionRoot: string;
let bus: EventBus;
let watcher: SessionWatcher | null = null;
let registry: SessionRegistry | null = null;

beforeAll(async () => {
  projectRoot = await realpath(await mkdtemp(join(tmpdir(), "piws-watch-project-")));
  sessionRoot = await realpath(await mkdtemp(join(tmpdir(), "piws-watch-sessions-")));
});

beforeEach(async () => {
  await rm(join(process.env.PI_WEB_SIMPLE_HOME!, "store.json"), { force: true });
  resetStoreCache();
  bus = new EventBus();
  watcher = null;
  registry = null;
});

afterEach(async () => {
  watcher?.stop();
  await registry?.closeAll("test-cleanup");
});

async function collectEvents(): Promise<BusEvent[]> {
  const events: BusEvent[] = [];
  bus.subscribe((event) => events.push(event));
  return events;
}

/** Write a minimal valid pi session file into a project's session directory. */
async function writeSessionFile(projectPath: string, name: string): Promise<string> {
  const dir = sessionDirFor(projectPath, sessionRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "bbbb1111-2222-3333-4444-555555555555",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: projectPath,
    })}\n`,
    "utf8",
  );
  return path;
}

describe("SessionWatcher", () => {
  it("watches every registered project", async () => {
    const projectPath = join(projectRoot, "watched");
    await mkdir(projectPath, { recursive: true });
    await addProject(projectPath);

    watcher = new SessionWatcher({ registry: new SessionRegistry({ cliPath: STUB_CLI }), bus, sessionRoot });
    await watcher.start();

    expect(watcher.watchedProjects).toEqual([projectPath]);
  });

  it("emits sessions_changed when a session file appears", async () => {
    const projectPath = join(projectRoot, "appearing");
    await mkdir(projectPath, { recursive: true });
    await addProject(projectPath);

    watcher = new SessionWatcher({ registry: new SessionRegistry({ cliPath: STUB_CLI }), bus, sessionRoot });
    await watcher.start();
    const events = await collectEvents();

    await writeSessionFile(projectPath, "appeared.jsonl");

    await vi.waitFor(
      () => {
        expect(events.some((e) => e.type === "sessions_changed")).toBe(true);
      },
      { timeout: 5000 },
    );
  });

  it("emits session_external_changed when another process writes an owned session", async () => {
    const projectPath = join(projectRoot, "contested");
    await mkdir(projectPath, { recursive: true });
    await addProject(projectPath);

    registry = new SessionRegistry({ cliPath: STUB_CLI });
    const sessionPath = join(sessionDirFor(projectPath, sessionRoot), "owned.jsonl");
    await mkdir(dirname(sessionPath), { recursive: true });
    const handle = await registry.open(projectPath, sessionPath);

    watcher = new SessionWatcher({ registry, bus, sessionRoot });
    await watcher.start();
    const events = await collectEvents();

    // Pretend our own process has been quiet for a while, so the change can
    // only have come from the CLI.
    handle.lastActivityAt = Date.now() - 60_000;
    await writeSessionFile(projectPath, "owned.jsonl");

    await vi.waitFor(
      () => {
        expect(events.some((e) => e.type === "session_external_changed")).toBe(true);
      },
      { timeout: 5000 },
    );
    const external = events.find((e) => e.type === "session_external_changed");
    expect(external && "sessionPath" in external ? external.sessionPath : "").toBe(sessionPath);
  });

  it("stays quiet for a write that follows our own activity", async () => {
    const projectPath = join(projectRoot, "self-write");
    await mkdir(projectPath, { recursive: true });
    await addProject(projectPath);

    registry = new SessionRegistry({ cliPath: STUB_CLI });
    const sessionPath = join(sessionDirFor(projectPath, sessionRoot), "mine.jsonl");
    await mkdir(dirname(sessionPath), { recursive: true });
    await registry.open(projectPath, sessionPath);

    watcher = new SessionWatcher({ registry, bus, sessionRoot });
    await watcher.start();
    const events = await collectEvents();

    await writeSessionFile(projectPath, "mine.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(events.some((e) => e.type === "session_external_changed")).toBe(false);
  });

  it("stops watching a project after it is removed", async () => {
    const projectPath = join(projectRoot, "transient");
    await mkdir(projectPath, { recursive: true });
    const project = await addProject(projectPath);

    watcher = new SessionWatcher({ registry: new SessionRegistry({ cliPath: STUB_CLI }), bus, sessionRoot });
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

    watcher = new SessionWatcher({ registry: new SessionRegistry({ cliPath: STUB_CLI }), bus, sessionRoot });
    await watcher.start();
    watcher.stop();
    expect(watcher.watchedProjects).toHaveLength(0);
  });
});
