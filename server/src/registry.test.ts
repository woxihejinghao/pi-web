import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry, type SessionHandle } from "./registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_CLI = join(HERE, "testing", "stub-pi.mjs");

let projectPath: string;
let sessionDir: string;
let registry: SessionRegistry;

beforeAll(async () => {
  projectPath = await realpath(await mkdtemp(join(tmpdir(), "piws-reg-cwd-")));
  sessionDir = await realpath(await mkdtemp(join(tmpdir(), "piws-reg-sess-")));
});

afterAll(async () => {
  await rm(projectPath, { recursive: true, force: true });
  await rm(sessionDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.STUB_SESSION_ID = "stub-session-id";
  // Another suite may have pointed the stub at a fixed file; explicit
  // `--session` arguments must win over that.
  delete process.env.STUB_SESSION_FILE;
  registry = new SessionRegistry({ cliPath: STUB_CLI });
});

afterEach(async () => {
  await registry.closeAll("test-cleanup");
});

const sessionPathFor = (name: string) => join(sessionDir, `${name}.jsonl`);

describe("open", () => {
  it("spawns a process for a fresh session and adopts pi's reported path", async () => {
    const handle = await registry.open(projectPath);
    expect(handle.sessionPath.endsWith(".jsonl")).toBe(true);
    expect(handle.sessionId).toBe("stub-session-id");
    expect(handle.projectPath).toBe(projectPath);
    expect(handle.dead).toBe(false);
    expect(registry.list()).toHaveLength(1);
  });

  it("reuses the live handle for a known session path", async () => {
    const path = sessionPathFor("reuse");
    const first = await registry.open(projectPath, path);
    const second = await registry.open(projectPath, path);
    expect(second).toBe(first);
    expect(registry.list()).toHaveLength(1);
  });

  it("resolves concurrent opens of the same path to one process", async () => {
    const path = sessionPathFor("concurrent");
    const [a, b] = await Promise.all([
      registry.open(projectPath, path),
      registry.open(projectPath, path),
    ]);
    expect(a).toBe(b);
    expect(registry.list()).toHaveLength(1);
  });

  it("keeps separate processes for separate sessions", async () => {
    await registry.open(projectPath, sessionPathFor("one"));
    await registry.open(projectPath, sessionPathFor("two"));
    expect(registry.list()).toHaveLength(2);
  });

  it("respawn on open after a handle was marked dead", async () => {
    const path = sessionPathFor("dead");
    const first = await registry.open(projectPath, path);
    registry.markDead(path);
    const second = await registry.open(projectPath, path);
    expect(second).not.toBe(first);
    expect(registry.list()).toHaveLength(1);
  });

  it("fails cleanly when the CLI path does not exist", async () => {
    const broken = new SessionRegistry({ cliPath: join(sessionDir, "missing-cli.mjs") });
    await expect(broken.open(projectPath, sessionPathFor("broken"))).rejects.toThrow();
    expect(broken.list()).toHaveLength(0);
  });
});

describe("events", () => {
  it("forwards agent events from the child process", async () => {
    const seen: string[] = [];
    const unsubscribe = registry.onEvent((_handle, event) => {
      seen.push(event.type);
    });
    const handle = await registry.open(projectPath, sessionPathFor("events"));
    await handle.client.prompt("hello");
    await vi.waitFor(() => {
      expect(seen).toContain("agent_settled");
    });
    expect(seen).toContain("agent_start");
    unsubscribe();
  });

  it("stops forwarding after unsubscribe", async () => {
    const seen: string[] = [];
    const unsubscribe = registry.onEvent((_handle, event) => {
      seen.push(event.type);
    });
    unsubscribe();
    const handle = await registry.open(projectPath, sessionPathFor("muted"));
    await handle.client.prompt("hello");
    await vi.waitFor(() => {
      expect(registry.list()).toHaveLength(1);
    });
    expect(seen).toHaveLength(0);
  });
});

describe("lifecycle", () => {
  it("close removes the handle and notifies listeners", async () => {
    const closed: Array<[string, string]> = [];
    registry.onClosed((handle, reason) => {
      closed.push([handle.sessionPath, reason]);
    });
    const path = sessionPathFor("closing");
    const handle = await registry.open(projectPath, path);
    await registry.close(path);
    expect(registry.list()).toHaveLength(0);
    expect(registry.get(path)).toBeUndefined();
    expect(closed).toEqual([[handle.sessionPath, "closed"]]);
  });

  it("closing an unknown session is a no-op", async () => {
    await expect(registry.close(sessionPathFor("never-opened"))).resolves.toBeUndefined();
  });

  it("evicts a handle whose idle window elapsed", async () => {
    const shortLived = new SessionRegistry({ cliPath: STUB_CLI, idleTimeoutMs: 0 });
    await shortLived.open(projectPath, sessionPathFor("idle"));
    await shortLived.evictIdle();
    expect(shortLived.list()).toHaveLength(0);
  });

  it("keeps a recently used handle alive", async () => {
    await registry.open(projectPath, sessionPathFor("busy"));
    await registry.evictIdle();
    expect(registry.list()).toHaveLength(1);
  });

  it("drops the least recently used handle above the cap", async () => {
    const capped = new SessionRegistry({
      cliPath: STUB_CLI,
      maxActiveSessions: 1,
      idleTimeoutMs: 60_000,
    });
    const older = await capped.open(projectPath, sessionPathFor("oldest"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const newer = await capped.open(projectPath, sessionPathFor("newest"));

    await capped.evictIdle();

    expect(capped.list()).toHaveLength(1);
    expect(capped.list()[0]?.sessionPath).toBe(newer.sessionPath);
    expect(capped.get(older.sessionPath)).toBeUndefined();
    await capped.closeAll("test-cleanup");
  });

  it("closeAll stops every process", async () => {
    await Promise.all([
      registry.open(projectPath, sessionPathFor("a")),
      registry.open(projectPath, sessionPathFor("b")),
    ]);
    expect(registry.list()).toHaveLength(2);
    await registry.closeAll();
    expect(registry.list()).toHaveLength(0);
  });
});

describe("prewarm", () => {
  it("spawns a handle marked as prewarmed", async () => {
    await registry.prewarm(projectPath);
    const handles = registry.list();
    expect(handles).toHaveLength(1);
    expect(handles[0]?.prewarmed).toBe(true);
  });

  it("promotes the handle on claim and clears the flag", async () => {
    await registry.prewarm(projectPath);
    const claimed = registry.claimPrewarmed(projectPath);
    expect(claimed).not.toBeNull();
    expect(claimed?.prewarmed).toBe(false);
    expect(registry.claimPrewarmed(projectPath)).toBeNull();
  });

  it("claims nothing when no prewarm is pending", () => {
    expect(registry.claimPrewarmed(projectPath)).toBeNull();
  });

  it("spawns once for concurrent prewarm calls", async () => {
    await Promise.all([registry.prewarm(projectPath), registry.prewarm(projectPath)]);
    expect(registry.list()).toHaveLength(1);
  });

  it("does not prewarm again while one is already warm", async () => {
    await registry.prewarm(projectPath);
    await registry.prewarm(projectPath);
    expect(registry.list()).toHaveLength(1);
  });

  it("drops a pending prewarm that belongs to another project", async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), "piws-reg-other-")));
    try {
      await registry.prewarm(projectPath);
      await registry.prewarm(other);
      expect(registry.list().map((handle) => handle.projectPath)).toEqual([other]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("never drops a claimed session when prewarming another project", async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), "piws-reg-other2-")));
    try {
      await registry.prewarm(projectPath);
      const claimed = registry.claimPrewarmed(projectPath);
      await registry.prewarm(other);
      expect(claimed).not.toBeNull();
      expect(registry.get(claimed!.sessionPath)).toBeDefined();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("is reclaimed by the idle sweeper when never claimed", async () => {
    const shortLived = new SessionRegistry({ cliPath: STUB_CLI, idleTimeoutMs: 0 });
    await shortLived.prewarm(projectPath);
    expect(shortLived.list()).toHaveLength(1);
    await shortLived.evictIdle();
    expect(shortLived.list()).toHaveLength(0);
  });
});

describe("listCommands", () => {
  it("reports the commands pi registers", async () => {
    const commands = await registry.listCommands(projectPath);
    expect(commands.map((command) => command.name)).toEqual(["skill:pdf-tools", "review"]);
    expect(commands[0]?.source).toBe("skill");
    expect(commands[1]?.source).toBe("prompt");
  });

  it("spawns a process when nothing is running", async () => {
    expect(registry.list()).toHaveLength(0);
    await registry.listCommands(projectPath);
    expect(registry.list()).toHaveLength(1);
  });

  it("reuses the prewarmed process and leaves it claimable", async () => {
    await registry.prewarm(projectPath);
    await registry.listCommands(projectPath);
    expect(registry.list()).toHaveLength(1);
    // Listing must not consume the prewarm: a new session still gets it.
    expect(registry.claimPrewarmed(projectPath)).not.toBeNull();
  });

  it("prefers a live session over the prewarm", async () => {
    const handle = await registry.open(projectPath, sessionPathFor("live"));
    await registry.listCommands(projectPath);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get(handle.sessionPath)?.sessionPath).toBe(handle.sessionPath);
  });

  it("serves a cached list without a second round trip", async () => {
    // The delay is inherited by the stub when it is spawned below, so the
    // first call pays it and the second one must not.
    process.env.STUB_COMMANDS_DELAY_MS = "400";
    try {
      const first = await registry.listCommands(projectPath);
      const started = Date.now();
      const second = await registry.listCommands(projectPath);
      expect(second).toEqual(first);
      expect(Date.now() - started).toBeLessThan(200);
    } finally {
      delete process.env.STUB_COMMANDS_DELAY_MS;
    }
  });

  it("throws when no process can be started", async () => {
    const broken = new SessionRegistry({ cliPath: join(HERE, "testing", "absent-cli.mjs") });
    try {
      await expect(broken.listCommands(projectPath)).rejects.toThrow(/no pi process/);
    } finally {
      await broken.closeAll("test-cleanup");
    }
  });

  // prewarm() deliberately swallows the spawn error; listCommands is the
  // caller that surfaces it.
  it("keeps working when the CLI path is missing", async () => {
    const broken = new SessionRegistry({ cliPath: join(sessionDir, "missing-cli.mjs") });
    await expect(broken.prewarm(projectPath)).resolves.toBeUndefined();
    expect(broken.list()).toHaveLength(0);
  });
});

describe("handle bookkeeping", () => {
  it("touch refreshes the idle clock", async () => {
    const handle: SessionHandle = await registry.open(projectPath, sessionPathFor("touch"));
    const before = handle.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 10));
    registry.touch(handle.sessionPath);
    expect(handle.lastActivityAt).toBeGreaterThan(before);
  });
});
