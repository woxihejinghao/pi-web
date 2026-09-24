import { createServer, request as httpRequest, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus.ts";
import { resetDefaultComposerCache } from "./composer.ts";
import { SessionRegistry } from "./registry.ts";
import { createRequestHandler } from "./routes.ts";
import { sessionDirFor } from "./session-path.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_CLI = join(HERE, "testing", "stub-pi.mjs");
const execFileAsync = promisify(execFile);

let home: string;
let projectRoot: string;
let sessionRoot: string;
let registry: SessionRegistry;
let bus: EventBus;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  home = await realpath(process.env.PI_WEB_SIMPLE_HOME!);
  projectRoot = await realpath(await mkdtemp(join(tmpdir(), "piws-api-project-")));
  sessionRoot = await realpath(await mkdtemp(join(tmpdir(), "piws-api-sessions-")));
});

afterAll(async () => {
  for (const dir of [projectRoot, sessionRoot]) {
    await rm(dir, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await rm(join(home, "store.json"), { force: true });
  const store = await import("./store.ts");
  store.resetStoreCache();

  registry = new SessionRegistry({ cliPath: STUB_CLI });
  bus = new EventBus();
  registry.onEvent((handle, event) => {
    bus.publish({ type: "session_event", sessionPath: handle.sessionPath, event });
  });

  const handler = createRequestHandler({ registry, bus, sessionRoot });
  server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await registry.closeAll("test-cleanup");
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface ApiResult<T = any> {
  status: number;
  body: T;
}

async function api<T = any>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

const post = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

async function createProject(name = "demo-project"): Promise<{ id: string; path: string }> {
  const path = join(projectRoot, name);
  await mkdir(path, { recursive: true });
  const res = await post("/api/projects", { path });
  expect(res.status).toBe(201);
  return res.body;
}

describe("health", () => {
  it("reports ok with the active session count", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, activeSessions: 0 });
  });

  it("404s an unknown route", async () => {
    const res = await api("/api/nope");
    expect(res.status).toBe(404);
  });

  it("reports the host home directory so the UI can shorten paths to ~", async () => {
    const res = await api("/api/env");
    expect(res.status).toBe(200);
    expect(res.body.home).toBe(homedir());
  });
});

describe("projects api", () => {
  it("creates, lists, renames, and deletes a project", async () => {
    const project = await createProject("crud");
    expect(project.id).toBeTruthy();

    const listed = await api("/api/projects");
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].title).toBe("crud");
    expect(listed.body[0].exists).toBe(true);

    const renamed = await api(`/api/projects/${project.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(renamed.body.title).toBe("Renamed");

    const removed = await api(`/api/projects/${project.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await api("/api/projects")).body).toHaveLength(0);
  });

  it("rejects a duplicate path with 409", async () => {
    const project = await createProject("dupe");
    const again = await post("/api/projects", { path: project.path });
    expect(again.status).toBe(409);
  });

  it("rejects a non-existent path with 404", async () => {
    const res = await post("/api/projects", { path: join(projectRoot, "ghost") });
    expect(res.status).toBe(404);
  });

  it("rejects a missing path field with 400", async () => {
    const res = await post("/api/projects", {});
    expect(res.status).toBe(400);
  });

  it("reorders projects", async () => {
    const a = await createProject("order-a");
    const b = await createProject("order-b");
    const res = await api("/api/projects/order", {
      method: "PUT",
      body: JSON.stringify({ ids: [b.id, a.id] }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await api("/api/projects")).body.map((p: any) => p.id)).toEqual([b.id, a.id]);
  });
});

describe("workspace files api", () => {
  it("lists a project directory level and reads one of its files", async () => {
    const project = await createProject("files");
    await mkdir(join(project.path, "src"), { recursive: true });
    await writeFile(join(project.path, "README.md"), "# hi\n", "utf8");

    const listing = await api(`/api/projects/${project.id}/files`);
    expect(listing.status).toBe(200);
    expect(listing.body.entries.map((entry: any) => entry.path)).toEqual([
      "src",
      "README.md",
    ]);

    const file = await api(`/api/projects/${project.id}/file?path=README.md`);
    expect(file.status).toBe(200);
    expect(file.body).toMatchObject({ kind: "text", content: "# hi\n" });
  });

  it("refuses a path that leaves the project", async () => {
    const project = await createProject("escape");
    const res = await api(`/api/projects/${project.id}/files?path=..`);
    expect(res.status).toBe(403);
  });

  it("rejects a file request without a path", async () => {
    const project = await createProject("no-path");
    const res = await api(`/api/projects/${project.id}/file`);
    expect(res.status).toBe(400);
  });
});

describe("git api", () => {
  /** A project that is also a repository, with one commit already made. */
  async function createRepo(name: string): Promise<{ id: string; path: string }> {
    const project = await createProject(name);
    const git = (...args: string[]) =>
      execFileAsync(
        "git",
        ["-C", project.path, "-c", "user.email=t@e", "-c", "user.name=T", ...args],
        { encoding: "utf8" },
      );
    await git("-c", "init.defaultBranch=main", "init", "-q");
    // The api commits through `gitCommit`, which passes no `-c`: the repository
    // itself has to know who is committing. CI runners have no global identity.
    await git("config", "user.email", "t@e");
    await git("config", "user.name", "T");
    await writeFile(join(project.path, "a.txt"), "one\n", "utf8");
    await git("add", "-A");
    await git("commit", "-qm", "init");
    return project;
  }

  it("answers with the branch, both sides and the history", async () => {
    const project = await createRepo("git-repo");
    await writeFile(join(project.path, "a.txt"), "one changed\n", "utf8");

    const res = await api(`/api/projects/${project.id}/git`);
    expect(res.status).toBe(200);
    expect(res.body.branch).toBe("main");
    expect(res.body.unstaged.map((file: any) => file.path)).toEqual(["a.txt"]);
    expect(res.body.unstaged[0].patch).toContain("+one changed");
    expect(res.body.staged).toEqual([]);
    expect(res.body.log[0].subject).toBe("init");
  });

  it("answers 200 with repository:false for a plain directory", async () => {
    const project = await createProject("git-plain");
    const res = await api(`/api/projects/${project.id}/git`);
    expect(res.status).toBe(200);
    expect(res.body.repository).toBe(false);
    expect(res.body.unstaged).toEqual([]);
  });

  it("stages, commits and answers with the re-read state", async () => {
    const project = await createRepo("git-commit");
    await writeFile(join(project.path, "a.txt"), "one committed\n", "utf8");

    const staged = await post(`/api/projects/${project.id}/git/stage`, {
      paths: ["a.txt"],
      staged: true,
    });
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    expect(staged.body.staged.map((file: any) => file.path)).toEqual(["a.txt"]);

    const committed = await post(`/api/projects/${project.id}/git/commit`, {
      message: "feat: commit from the api",
    });
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect(committed.body.view.log[0].subject).toBe("feat: commit from the api");
    expect(committed.body.view.staged).toEqual([]);
    expect(committed.body.hash).toBe(committed.body.view.log[0].short);
  });

  it("reports git's own refusal as a 400 with its message", async () => {
    const project = await createRepo("git-refusal");
    // Nothing staged, so git refuses — and its wording is what the panel shows.
    const res = await post(`/api/projects/${project.id}/git/commit`, { message: "nothing" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("nothing to commit");
  });

  it("explains a push with no remote instead of failing as a 500", async () => {
    const project = await createRepo("git-push");
    const res = await post(`/api/projects/${project.id}/git/push`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("没有配置远端");
  });

  it("rejects a stage request without paths", async () => {
    const project = await createRepo("git-no-paths");
    const res = await post(`/api/projects/${project.id}/git/stage`, { staged: true });
    expect(res.status).toBe(400);
  });

});

describe("sessions api", () => {
  it("lists sessions belonging to the project", async () => {
    const project = await createProject("with-sessions");
    const sessionDir = sessionDirFor(project.path, sessionRoot);
    const sessionFile = join(sessionDir, "s1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "aaaa1111-2222-3333-4444-555555555555",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: project.path,
      })}\n${JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "hello there", timestamp: 1767225601000 },
      })}\n`,
      "utf8",
    );

    const res = await api(`/api/projects/${project.id}/sessions`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe("hello there");
  });

  it("creates a session, prompts it, and reads it back", async () => {
    const project = await createProject("prompting");
    const draftFile = join(sessionRoot, "--draft--", "draft.jsonl");
    process.env.STUB_SESSION_FILE = draftFile;

    const created = await post("/api/sessions", { projectId: project.id });
    expect(created.status).toBe(201);
    expect(created.body.sessionPath).toBe(draftFile);
    expect(created.body.sessionId).toBe("stub-session-id");

    const prompted = await post(`/api/sessions/${encodeURIComponent(draftFile)}/prompt`, {
      message: "hi",
    });
    expect(prompted.status).toBe(200);

    const messages = await api(`/api/sessions/${encodeURIComponent(draftFile)}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body.messages).toEqual([]);

    const state = await api(`/api/sessions/${encodeURIComponent(draftFile)}/state`);
    expect(state.body.state.isStreaming).toBe(false);
  });

  it("serves a transcript from disk without spawning pi", async () => {
    // Every session is in this state the moment the user switches to it: on
    // disk, not resident. Spawning pi to read it cost 1.2–3.3s of loading
    // spinner, which is what this asserts away.
    const sessionPath = join(sessionRoot, "--idle--", "idle.jsonl");
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(
      sessionPath,
      [
        { type: "session", version: 3, id: "idle-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot },
        {
          type: "message",
          id: "a1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "hello from disk" },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    const resident = registry.list().length;
    const res = await api<{ sessionId: string; messages: { role: string }[] }>(
      `/api/sessions/${encodeURIComponent(sessionPath)}/messages`,
    );

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe("idle-session");
    expect(res.body.messages.map((entry) => entry.role)).toEqual(["user"]);
    // The point of the change: no process was created to answer this.
    expect(registry.list().length).toBe(resident);
  });

  it("rejects a session path outside pi's storage root", async () => {
    const outside = join(home, "secrets.jsonl");
    const res = await api(`/api/sessions/${encodeURIComponent(outside)}/messages`);
    expect(res.status).toBe(403);
  });

  it("rejects a session path that is not a jsonl file", async () => {
    const res = await api(`/api/sessions/${encodeURIComponent(join(sessionRoot, "notes.txt"))}/messages`);
    expect(res.status).toBe(400);
  });

  it("404s an unknown project id", async () => {
    const res = await api("/api/projects/does-not-exist/sessions");
    expect(res.status).toBe(404);
  });

  it("stores a UI rename as an override without opening the session", async () => {
    const target = join(sessionRoot, "--rename--", "s.jsonl");
    const res = await post(`/api/sessions/${encodeURIComponent(target)}/rename`, { name: "My name" });
    expect(res.status).toBe(200);
    expect(res.body.override).toEqual({ name: "My name" });
  });

  it("prewarms a session so the next create is instant", async () => {
    const project = await createProject("prewarming");
    const warmPath = join(sessionRoot, "--warm--", "warm.jsonl");
    process.env.STUB_SESSION_FILE = warmPath;

    const prewarmed = await post("/api/sessions/prewarm", { projectId: project.id });
    expect(prewarmed.status).toBe(202);
    expect(prewarmed.body).toEqual({ ok: true, projectPath: project.path });

    // The process is up without the caller having waited for it.
    await vi.waitFor(async () => {
      expect((await api("/api/health")).body.activeSessions).toBeGreaterThanOrEqual(1);
    });

    const created = await post("/api/sessions", { projectId: project.id });
    expect(created.status).toBe(201);
    expect(created.body.prewarmed).toBe(true);
    expect(created.body.sessionPath).toBe(warmPath);
  });

  it("reports prewarmed: false when it has to spawn on demand", async () => {
    const project = await createProject("not-prewarmed");
    process.env.STUB_SESSION_FILE = join(sessionRoot, "--cold--", "cold.jsonl");

    const created = await post("/api/sessions", { projectId: project.id });
    expect(created.status).toBe(201);
    expect(created.body.prewarmed).toBe(false);
  });

  it("rejects a prewarm without a projectId", async () => {
    const res = await post("/api/sessions/prewarm", {});
    expect(res.status).toBe(400);
  });

  it("404s a prewarm for an unknown project", async () => {
    const res = await post("/api/sessions/prewarm", { projectId: "missing" });
    expect(res.status).toBe(404);
  });

  it("stops a session and reports zero active afterwards", async () => {
    const project = await createProject("stopping");
    process.env.STUB_SESSION_FILE = join(sessionRoot, "--stop--", "s.jsonl");
    const created = await post("/api/sessions", { projectId: project.id });
    expect((await api("/api/health")).body.activeSessions).toBe(1);

    const stopped = await post(`/api/sessions/${encodeURIComponent(created.body.sessionPath)}/stop`);
    expect(stopped.status).toBe(200);
    expect((await api("/api/health")).body.activeSessions).toBe(0);
  });

  it("deletes a session file, its override, and tells the UI to refetch", async () => {
    const project = await createProject("deleting");
    const sessionDir = sessionDirFor(project.path, sessionRoot);
    const sessionFile = join(sessionDir, "doomed.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "bbbb1111-2222-3333-4444-555555555555",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: project.path,
      })}\n`,
      "utf8",
    );
    // A Web-side rename lives in our store; the delete has to take it along.
    const renamed = await post(`/api/sessions/${encodeURIComponent(sessionFile)}/rename`, {
      name: "Doomed",
    });
    expect(renamed.status).toBe(200);

    const events: string[] = [];
    bus.subscribe((event) => events.push(event.type));

    const res = await api(`/api/sessions/${encodeURIComponent(sessionFile)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    // `trash` is optional on this host, so either path is a passing delete.
    expect(["trash", "unlink"]).toContain(res.body.method);
    expect(events).toContain("sessions_changed");
    await expect(readFile(sessionFile, "utf8")).rejects.toThrow();

    const listed = await api(`/api/projects/${project.id}/sessions?includeHidden=true`);
    expect(listed.body).toHaveLength(0);
  });

  it("closes a resident process before deleting its session", async () => {
    const project = await createProject("deleting-live");
    const sessionDir = sessionDirFor(project.path, sessionRoot);
    const sessionFile = join(sessionDir, "live.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3 })}\n`, "utf8");
    process.env.STUB_SESSION_FILE = sessionFile;

    await post("/api/sessions", { projectId: project.id });
    await vi.waitFor(async () => {
      expect((await api("/api/health")).body.activeSessions).toBe(1);
    });

    const res = await api(`/api/sessions/${encodeURIComponent(sessionFile)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await api("/api/health")).body.activeSessions).toBe(0);
    await expect(readFile(sessionFile, "utf8")).rejects.toThrow();
  });

  it("404s deleting a session file that is already gone", async () => {
    const res = await api(`/api/sessions/${encodeURIComponent(join(sessionRoot, "--gone--", "x.jsonl"))}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("rejects deleting outside pi's storage root", async () => {
    const res = await api(`/api/sessions/${encodeURIComponent(join(home, "secrets.jsonl"))}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});

describe("prompt attachments", () => {
  /** A session whose stub pi is already spawned and can be prompted. */
  async function openSession(name: string): Promise<string> {
    const project = await createProject(name);
    const sessionPath = join(sessionRoot, `--${name}--`, "session.jsonl");
    process.env.STUB_SESSION_FILE = sessionPath;
    const created = await post("/api/sessions", { projectId: project.id });
    expect(created.status).toBe(201);
    return sessionPath;
  }

  const prompt = (sessionPath: string, body: unknown) =>
    post(`/api/sessions/${encodeURIComponent(sessionPath)}/prompt`, body);

  it("forwards an image to pi untouched", async () => {
    const sessionPath = await openSession("images-forward");
    const res = await prompt(sessionPath, {
      message: "看这张",
      images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });
    expect(res.status).toBe(200);
  });

  it("accepts a picture with no caption", async () => {
    // pi writes `[{type:"text",text:""}, ...images]` either way, so a screenshot
    // with nothing typed under it is a complete turn — and one the composer is
    // able to produce, so it must not be the one case the server refuses.
    const sessionPath = await openSession("images-captionless");
    const res = await prompt(sessionPath, {
      message: "",
      images: [{ type: "image", data: "UklGRg==", mimeType: "image/webp" }],
    });
    expect(res.status).toBe(200);
  });

  it("rejects a format no provider decodes", async () => {
    const sessionPath = await openSession("images-svg");
    const res = await prompt(sessionPath, {
      message: "看这张",
      images: [{ type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mimeType/);
  });

  it("rejects an image over the size ceiling", async () => {
    const sessionPath = await openSession("images-huge");
    const res = await prompt(sessionPath, {
      images: [{ type: "image", data: "A".repeat(8 * 1024 * 1024), mimeType: "image/png" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5MB/);
  });

  it("rejects a message with neither text nor pictures", async () => {
    const sessionPath = await openSession("images-empty");
    const res = await prompt(sessionPath, { message: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message or images/);
  });
});

describe("composer api", () => {
  // The disk path resolves the session's `model_change` against
  // `models.json`, so these tests point pi at a scratch agent directory for the
  // same reason the provider tests do: the real file is the user's.
  let agentDir: string;

  const writeModels = async (providers: unknown): Promise<void> => {
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers }), "utf8");
  };

  const writeSession = async (name: string, entries: unknown[]): Promise<string> => {
    const path = join(sessionRoot, `--${name}--`, `${name}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
    return path;
  };

  const header = { type: "session", version: 3, id: "composer-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot };

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "piws-api-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // The project composer read reuses pi's model resolver for a few seconds;
    // a fresh agent directory per test has to invalidate it.
    resetDefaultComposerCache();
    delete process.env.STUB_MODEL;
    delete process.env.STUB_MODELS;
    delete process.env.STUB_CONTEXT_USAGE;
  });

  afterEach(async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.STUB_MODEL;
    delete process.env.STUB_MODELS;
    delete process.env.STUB_CONTEXT_USAGE;
    delete process.env.STUB_SESSION_FILE;
    await rm(agentDir, { recursive: true, force: true });
  });

  it("answers from the session file without spawning pi", async () => {
    await writeModels({
      cz: { name: "cz", models: [{ id: "deepseek-flash", name: "DeepSeek Flash", contextWindow: 200000 }] },
    });
    const sessionPath = await writeSession("composer-disk", [
      header,
      { type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", provider: "cz", modelId: "deepseek-flash" },
      { type: "message", id: "u1", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "hello" } },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          stopReason: "stop",
          usage: { input: 500, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 20000 },
        },
      },
    ]);

    const resident = registry.list().length;
    const res = await api(`/api/sessions/${encodeURIComponent(sessionPath)}/composer`);

    expect(res.status).toBe(200);
    expect(res.body.live).toBe(false);
    expect(res.body.model).toMatchObject({ provider: "cz", id: "deepseek-flash", name: "DeepSeek Flash", contextWindow: 200000 });
    expect(res.body.context).toEqual({ tokens: 20000, contextWindow: 200000, percent: 10 });
    // The switchable list only exists inside a process; empty would read as
    // "you have no models", so it is null.
    expect(res.body.models).toBeNull();
    expect(registry.list().length).toBe(resident);
  });

  it("answers for a session pi has not written to disk yet", async () => {
    // pi mints the session path before the first turn lands in the file, so the
    // composer has to describe a file that does not exist yet — and "no model
    // chosen" is the truthful description, not a 404 that the UI would show as
    // an error over a perfectly healthy new session.
    const pending = join(sessionRoot, "--pending--", "pending.jsonl");
    const res = await api(`/api/sessions/${encodeURIComponent(pending)}/composer`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ live: false, model: null, models: null, context: null });
  });

  it("spawns on demand when asked for a live answer", async () => {
    const sessionPath = await writeSession("composer-spawn", [header]);
    process.env.STUB_SESSION_FILE = sessionPath;
    process.env.STUB_MODELS = JSON.stringify([
      { provider: "cz", id: "deepseek-flash", contextWindow: 128000, reasoning: true },
    ]);

    const res = await api(`/api/sessions/${encodeURIComponent(sessionPath)}/composer?spawn=true`);
    expect(res.status).toBe(200);
    expect(res.body.live).toBe(true);
    expect(res.body.models).toHaveLength(1);
    expect((await api("/api/health")).body.activeSessions).toBe(1);
  });

  it("reports the live model, model list, and context usage", async () => {
    const project = await createProject("composer-live");
    await writeModels({
      cz: { name: "cz", models: [{ id: "deepseek-flash" }, { id: "glm", name: "GLM 5.3" }] },
    });
    const sessionPath = join(sessionRoot, "--api-live--", "live.jsonl");
    process.env.STUB_SESSION_FILE = sessionPath;
    process.env.STUB_MODEL = JSON.stringify({ provider: "cz", id: "deepseek-flash", name: "DeepSeek Flash", contextWindow: 128000, reasoning: true });
    process.env.STUB_MODELS = JSON.stringify([
      { provider: "cz", id: "deepseek-flash", contextWindow: 128000, reasoning: true },
      { provider: "cz", id: "glm", contextWindow: 64000, reasoning: false },
    ]);
    process.env.STUB_CONTEXT_USAGE = JSON.stringify({ tokens: 64000, contextWindow: 128000, percent: 50 });

    const created = await post("/api/sessions", { projectId: project.id });
    expect(created.status).toBe(201);

    const res = await api(`/api/sessions/${encodeURIComponent(created.body.sessionPath)}/composer`);
    expect(res.status).toBe(200);
    expect(res.body.live).toBe(true);
    expect(res.body.model).toMatchObject({ provider: "cz", id: "deepseek-flash", name: "DeepSeek Flash" });
    expect(res.body.models.map((model: { id: string }) => model.id)).toEqual(["deepseek-flash", "glm"]);
    // The runtime knows the window; `models.json` supplies the display name.
    expect(res.body.models[1]).toMatchObject({ id: "glm", name: "GLM 5.3" });
    expect(res.body.context).toEqual({ tokens: 64000, contextWindow: 128000, percent: 50 });
  });

  it("offers the model list and startup default before a session exists", async () => {
    const project = await createProject("hero-models");
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          cz: {
            name: "cz",
            baseUrl: "https://example.invalid",
            api: "anthropic-messages",
            apiKey: "sk-cz",
            models: [
              { id: "deepseek-flash", name: "DeepSeek Flash", contextWindow: 128000 },
              { id: "glm", name: "GLM 5.3", contextWindow: 64000, reasoning: true },
            ],
          },
          unauthed: {
            name: "unauthed",
            baseUrl: "https://example.invalid",
            api: "openai-completions",
            models: [{ id: "ghost" }],
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "cz", defaultModel: "glm" }),
      "utf8",
    );

    const resident = registry.list().length;
    const res = await api(`/api/projects/${project.id}/composer`);

    expect(res.status).toBe(200);
    expect(res.body.live).toBe(false);
    // No session, so no window to report — not a measured 0%.
    expect(res.body.context).toBeNull();
    // The list is pi's own: configured *and* authenticated, which is what
    // `/model` offers inside a running session.
    expect(
      res.body.models.map((m: { provider: string; id: string }) => `${m.provider}/${m.id}`),
    ).toEqual(["cz/deepseek-flash", "cz/glm"]);
    expect(res.body.model).toMatchObject({ provider: "cz", id: "glm", name: "GLM 5.3" });
    // Answering it must not have spawned anything.
    expect(registry.list().length).toBe(resident);
  });

  it("starts a new session on the model the hero picked", async () => {
    const project = await createProject("hero-pick");
    const sessionPath = join(sessionRoot, "--hero-pick--", "pick.jsonl");
    process.env.STUB_SESSION_FILE = sessionPath;
    process.env.STUB_MODEL = JSON.stringify({ provider: "cz", id: "deepseek-flash", name: "DeepSeek Flash", contextWindow: 128000, reasoning: true });
    process.env.STUB_MODELS = JSON.stringify([
      { provider: "cz", id: "deepseek-flash", contextWindow: 128000, reasoning: true },
      { provider: "cz", id: "glm", contextWindow: 64000, reasoning: false },
    ]);

    const created = await post("/api/sessions", {
      projectId: project.id,
      model: { provider: "cz", id: "glm" },
    });
    expect(created.status).toBe(201);
    expect(created.body.modelError).toBeUndefined();

    const composer = await api(`/api/sessions/${encodeURIComponent(sessionPath)}/composer`);
    expect(composer.body.model).toMatchObject({ provider: "cz", id: "glm" });
  });

  it("creates the session anyway when the picked model is gone", async () => {
    // The session exists the moment pi reports its path; refusing the whole
    // request over a stale id would throw away the draft the user was about to
    // type into.
    const project = await createProject("hero-stale");
    process.env.STUB_SESSION_FILE = join(sessionRoot, "--hero-stale--", "stale.jsonl");
    process.env.STUB_MODELS = JSON.stringify([
      { provider: "cz", id: "deepseek-flash", contextWindow: 128000, reasoning: true },
    ]);

    const created = await post("/api/sessions", {
      projectId: project.id,
      model: { provider: "cz", id: "removed" },
    });
    expect(created.status).toBe(201);
    expect(created.body.modelError).toMatch(/removed/);
  });

  it("rejects a malformed model selection", async () => {
    const project = await createProject("hero-bad");
    const res = await post("/api/sessions", { projectId: project.id, model: { provider: "cz" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/model\.id/);
  });

  it("switches the model over rpc and answers with the new one", async () => {
    const project = await createProject("composer-switch");
    const sessionPath = join(sessionRoot, "--api-switch--", "switch.jsonl");
    process.env.STUB_SESSION_FILE = sessionPath;
    process.env.STUB_MODEL = JSON.stringify({ provider: "cz", id: "deepseek-flash", name: "DeepSeek Flash", contextWindow: 128000, reasoning: true });
    process.env.STUB_MODELS = JSON.stringify([
      { provider: "cz", id: "deepseek-flash", contextWindow: 128000, reasoning: true },
      { provider: "cz", id: "glm", contextWindow: 64000, reasoning: false },
    ]);

    const created = await post("/api/sessions", { projectId: project.id });
    const switched = await post(`/api/sessions/${encodeURIComponent(created.body.sessionPath)}/model`, {
      provider: "cz",
      id: "glm",
    });

    expect(switched.status).toBe(200);
    expect(switched.body.model).toMatchObject({ provider: "cz", id: "glm" });
    // A later read agrees, because the process remembered the switch.
    const reread = await api(`/api/sessions/${encodeURIComponent(created.body.sessionPath)}/composer`);
    expect(reread.body.model.id).toBe("glm");
  });

  it("rejects an unknown model with 400 without retiring the process", async () => {
    const project = await createProject("composer-unknown");
    process.env.STUB_SESSION_FILE = join(sessionRoot, "--api-unknown--", "unknown.jsonl");
    process.env.STUB_MODEL = JSON.stringify({ provider: "cz", id: "deepseek-flash", contextWindow: 128000, reasoning: true });
    process.env.STUB_MODELS = JSON.stringify([
      { provider: "cz", id: "deepseek-flash", contextWindow: 128000, reasoning: true },
    ]);

    const created = await post("/api/sessions", { projectId: project.id });
    const res = await post(`/api/sessions/${encodeURIComponent(created.body.sessionPath)}/model`, {
      provider: "cz",
      id: "nope",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/无法切换到 cz\/nope/);
    // A typo is not a broken pi: the session is still usable.
    expect((await api("/api/health")).body.activeSessions).toBe(1);
  });

  it("requires a provider and an id", async () => {
    const project = await createProject("composer-invalid");
    process.env.STUB_SESSION_FILE = join(sessionRoot, "--api-invalid--", "invalid.jsonl");
    const created = await post("/api/sessions", { projectId: project.id });

    expect((await post(`/api/sessions/${encodeURIComponent(created.body.sessionPath)}/model`, { provider: "cz" })).status).toBe(400);
    expect((await post(`/api/sessions/${encodeURIComponent(created.body.sessionPath)}/model`, { id: "glm" })).status).toBe(400);
  });
});

describe("slash commands api", () => {
  it("lists the commands registered for a project", async () => {
    const project = await createProject("commands-project");
    const res = await api<{ commands: { name: string; source: string }[] }>(
      `/api/projects/${project.id}/commands`,
    );
    expect(res.status).toBe(200);
    // Built-ins are prepended by this server; the rest come from pi.
    expect(res.body.commands.map((command) => command.name)).toEqual([
      "compact",
      "export",
      "session",
      "name",
      "skill:pdf-tools",
      "review",
    ]);
  });

  it("404s an unknown project", async () => {
    const res = await api("/api/projects/nope/commands");
    expect(res.status).toBe(404);
  });

  it("reports a failure inline instead of failing the request", async () => {
    const project = await createProject("commands-failure");
    vi.spyOn(registry, "listCommands").mockRejectedValueOnce(new Error("pi rpc failed"));
    const res = await api<{ commands: { name: string }[]; error?: string }>(
      `/api/projects/${project.id}/commands`,
    );
    // Losing the pi-supplied commands is not worth an error banner, and the
    // built-in ones still work — they never needed a pi process.
    expect(res.status).toBe(200);
    expect(res.body.commands.map((command) => command.name)).toEqual([
      "compact",
      "export",
      "session",
      "name",
    ]);
    expect(res.body.error).toContain("pi rpc failed");
  });

  it("lists built-in commands ahead of the ones pi reports", async () => {
    const project = await createProject("commands-builtin");
    const res = await api<{ commands: { name: string; source: string }[] }>(
      `/api/projects/${project.id}/commands`,
    );
    expect(res.status).toBe(200);
    expect(res.body.commands[0]).toMatchObject({ name: "compact", source: "builtin" });
    expect(res.body.commands.map((command) => command.name)).toContain("skill:pdf-tools");
  });
});

describe("builtin command api", () => {
  /** Create a project plus one live session, and return that session's path. */
  async function openProjectSession(name: string): Promise<string> {
    const project = await createProject(name);
    const sessionPath = join(sessionRoot, `--${name}--`, "session.jsonl");
    process.env.STUB_SESSION_FILE = sessionPath;
    const created = await post("/api/sessions", { projectId: project.id });
    expect(created.status).toBe(201);
    return sessionPath;
  }

  const run = (sessionPath: string, body: unknown) =>
    post<{ message: string }>(`/api/sessions/${encodeURIComponent(sessionPath)}/command`, body);

  it("runs a command over rpc instead of sending it as a prompt", async () => {
    const sessionPath = await openProjectSession("builtin-run");
    const res = await run(sessionPath, { name: "compact" });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("12,345");

    // The text never reached the model.
    const messages = await api(`/api/sessions/${encodeURIComponent(sessionPath)}/messages`);
    expect(messages.body.messages).toEqual([]);
  });

  it("passes arguments through", async () => {
    const sessionPath = await openProjectSession("builtin-args");
    const res = await run(sessionPath, { name: "name", args: "重构登录" });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("重构登录");
  });

  it("rejects a built-in this ui does not implement", async () => {
    const sessionPath = await openProjectSession("builtin-unknown");
    // pi has a /tree command; it needs a tree-navigation UI we do not have.
    const res = await run(sessionPath, { name: "tree" });
    expect(res.status).toBe(400);
  });

  it("requires a command name", async () => {
    const sessionPath = await openProjectSession("builtin-noname");
    const res = await run(sessionPath, {});
    expect(res.status).toBe(400);
  });
});

describe("request origin guard", () => {
  const port = () => Number(new URL(baseUrl).port);

  function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: port(), path, method: "GET", headers },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("accepts a loopback Host", async () => {
    const res = await rawGet("/api/health", { host: `127.0.0.1:${port()}` });
    expect(res.status).toBe(200);
  });

  it("rejects a non-loopback Host (DNS rebinding)", async () => {
    const res = await rawGet("/api/health", { host: "evil.example.com" });
    expect(res.status).toBe(403);
    expect(res.body).toContain("Host");
  });

  it("rejects a non-loopback Origin", async () => {
    const res = await rawGet("/api/health", {
      host: `127.0.0.1:${port()}`,
      origin: "https://evil.example.com",
    });
    expect(res.status).toBe(403);
  });

  it("accepts a loopback Origin", async () => {
    const res = await rawGet("/api/health", {
      host: `127.0.0.1:${port()}`,
      origin: "http://localhost:5319",
    });
    expect(res.status).toBe(200);
  });
});

describe("directory browsing api", () => {
  it("lists the start locations", async () => {
    const res = await api("/api/fs/locations");
    expect(res.status).toBe(200);
    expect(res.body.some((location: any) => location.label === "主目录")).toBe(true);
  });

  it("lists the sub-directories of a path", async () => {
    const res = await api(`/api/fs/list?path=${encodeURIComponent(projectRoot)}`);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe(projectRoot);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  it("404s a missing directory", async () => {
    const res = await api(`/api/fs/list?path=${encodeURIComponent(join(projectRoot, "nope"))}`);
    expect(res.status).toBe(404);
  });
});

describe("event stream", () => {
  it("sends the hello frame and then live session events", async () => {
    const project = await createProject("streaming");
    process.env.STUB_SESSION_FILE = join(sessionRoot, "--stream--", "s.jsonl");

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const nextFrame = async (): Promise<{ event: string; data: any } | null> => {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (eventLine && dataLine) {
            return { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) };
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    };

    const hello = await nextFrame();
    expect(hello?.event).toBe("hello");

    const created = await post("/api/sessions", { projectId: project.id });
    await post(`/api/sessions/${encodeURIComponent(created.body.sessionPath)}/prompt`, {
      message: "hello",
    });

    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const frame = await nextFrame();
      if (!frame) break;
      if (frame.event === "session_event") seen.push(frame.data.event.type);
      if (seen.includes("agent_settled")) break;
    }
    expect(seen).toContain("agent_start");
    expect(seen).toContain("agent_settled");

    controller.abort();
  });
});

describe("settings", () => {
  it("serves the defaults before anything has been written", async () => {
    const res = await api("/api/settings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      appearance: "system",
      language: "system",
      contentFontSize: 15,
      transcriptDisplay: "normal",
      busySendBehavior: "queue",
      todoNoticeDismissed: false,
      browserNotifications: false,
    });
  });

  it("round-trips a partial patch and persists it", async () => {
    const patched = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ appearance: "dark", contentFontSize: 15 }),
    });
    expect(patched.status).toBe(200);
    // Untouched fields keep their previous values rather than resetting.
    expect(patched.body).toEqual({
      appearance: "dark",
      language: "system",
      contentFontSize: 15,
      transcriptDisplay: "normal",
      busySendBehavior: "queue",
      todoNoticeDismissed: false,
      browserNotifications: false,
    });

    const reread = await api("/api/settings");
    expect(reread.body.appearance).toBe("dark");
  });

  it("persists the task-panel notice dismissal", async () => {
    const patched = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ todoNoticeDismissed: true }),
    });

    expect(patched.status).toBe(200);
    expect(patched.body.todoNoticeDismissed).toBe(true);
    // The whole point of storing it here: closing the notice must survive a
    // reload, or the panel would ask again on every visit.
    expect((await api("/api/settings")).body.todoNoticeDismissed).toBe(true);
  });

  it("persists the browser-notification preference", async () => {
    const patched = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ browserNotifications: true }),
    });

    expect(patched.status).toBe(200);
    expect(patched.body.browserNotifications).toBe(true);
    // Permission lives in the browser, but the user's choice to use it must
    // survive a reload — otherwise every visit re-asks for the permission.
    expect((await api("/api/settings")).body.browserNotifications).toBe(true);
  });

  it("rejects a non-boolean browser-notification preference", async () => {
    const res = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ browserNotifications: "yes" }),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("browserNotifications");
    expect((await api("/api/settings")).body.browserNotifications).toBe(false);
  });

  it("round-trips the interface language", async () => {
    const patched = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ language: "en" }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.language).toBe("en");
    expect((await api("/api/settings")).body.language).toBe("en");
  });

  it("rejects an unknown language instead of falling back", async () => {
    for (const language of ["fr", "zh", "en-US"]) {
      const res = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ language }),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("language");
    }
    expect((await api("/api/settings")).body.language).toBe("system");
  });

  it("rejects an unknown appearance instead of falling back", async () => {
    // A silently ignored write is worse than a rejected one: the UI would keep
    // showing the value the user picked while the shell stayed light.
    const res = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ appearance: "sepia" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("appearance");
    expect((await api("/api/settings")).body.appearance).toBe("system");
  });

  it("rejects an out-of-range font size rather than clamping it", async () => {
    for (const contentFontSize of [11, 18, 14.5, "15"]) {
      const res = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ contentFontSize }),
      });
      expect(res.status).toBe(400);
    }
    expect((await api("/api/settings")).body.contentFontSize).toBe(15);
  });

  it("rejects an unknown option for the enum fields", async () => {
    for (const patch of [
      { transcriptDisplay: "compact-plus" },
      { busySendBehavior: "interrupt" },
    ]) {
      const res = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(400);
    }
  });

  it("reports agent settings as unavailable when nobody can be asked", async () => {
    const res = await api("/api/settings/agent");
    expect(res.status).toBe(200);
    // No projectPath: the row renders disabled rather than inventing a value.
    expect(res.body).toEqual({ available: false });
  });

  it("reads and writes auto-compaction through a pi process", async () => {
    const project = await createProject("settings-project");

    const initial = await api(`/api/settings/agent?projectPath=${encodeURIComponent(project.path)}`);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ available: true, autoCompaction: true });

    const written = await api("/api/settings/agent", {
      method: "PUT",
      body: JSON.stringify({ projectPath: project.path, autoCompaction: false }),
    });
    expect(written.status).toBe(200);
    expect(written.body).toEqual({ available: true, autoCompaction: false });

    // The stub keeps it in memory, so a fresh read proves the RPC landed.
    const reread = await api(`/api/settings/agent?projectPath=${encodeURIComponent(project.path)}`);
    expect(reread.body).toEqual({ available: true, autoCompaction: false });
  });

  it("refuses a non-boolean auto-compaction", async () => {
    const project = await createProject("settings-project-types");
    const res = await api("/api/settings/agent", {
      method: "PUT",
      body: JSON.stringify({ projectPath: project.path, autoCompaction: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("model providers api", () => {
  // pi's config lives outside our own data dir, so these tests point
  // `PI_CODING_AGENT_DIR` at a scratch directory. Without it the API would
  // write into the user's real ~/.pi/agent/models.json.
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "piws-api-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(agentDir, { recursive: true, force: true });
  });

  it("serves an empty list plus the catalogs the editors render from", async () => {
    const res = await api("/api/models/providers");
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([]);
    // The provider catalog and protocol list are pi's, so they ship with the
    // response rather than being duplicated in the frontend.
    expect(res.body.knownProviders).toContain("deepseek");
    expect(res.body.apiProtocols).toContain("anthropic-messages");
    expect(res.body.modelsPath).toBe(join(agentDir, "models.json"));
    expect(res.body.authPath).toBe(join(agentDir, "auth.json"));
  });

  it("creates, updates, and deletes a provider", async () => {
    const created = await post("/api/models/providers", {
      id: "newco",
      name: "NewCo",
      baseUrl: "https://api.newco.test/v1",
      api: "openai-completions",
      apiKey: "sk-new",
      models: [{ id: "big" }],
    });
    expect(created.status).toBe(201);
    expect(created.body.providers).toMatchObject([
      { id: "newco", name: "NewCo", configured: true, custom: true },
    ]);

    const updated = await api("/api/models/providers/newco", {
      method: "PUT",
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(updated.status).toBe(200);
    expect(updated.body.providers[0]).toMatchObject({ name: "Renamed", configured: true });

    const deleted = await api("/api/models/providers/newco", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.body.providers).toEqual([]);
  });

  it("never returns the api key it just stored", async () => {
    await post("/api/models/providers", { id: "newco", apiKey: "sk-secret" });
    const res = await api("/api/models/providers");
    expect(JSON.stringify(res.body)).not.toContain("sk-secret");
  });

  it("lists a known provider without the custom badge", async () => {
    await post("/api/models/providers", { id: "deepseek", apiKey: "sk-d" });
    const res = await api("/api/models/providers");
    expect(res.body.providers[0].custom).toBe(false);
  });

  it("rejects a duplicate id on create with a 400, not a 500", async () => {
    await post("/api/models/providers", { id: "newco" });
    const again = await post("/api/models/providers", { id: "newco" });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/已有提供方使用了这个 ID/);
  });

  it("rejects a malformed id and a non-http base url", async () => {
    expect((await post("/api/models/providers", { id: "NewCo" })).status).toBe(400);
    expect(
      (await post("/api/models/providers", { id: "newco", baseUrl: "ftp://x.test" })).status,
    ).toBe(400);
  });

  it("rejects a fetch with no base URL or a non-http one", async () => {
    // Both are caught before any request leaves the machine.
    expect((await post("/api/models/fetch-models", { api: "openai-completions" })).status).toBe(400);
    const bad = await post("/api/models/fetch-models", { baseUrl: "file:///etc/passwd" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/HTTP 或 HTTPS/);
  });

  it("reports an unreachable provider as a 400 with a readable message", async () => {
    // Port 1 is reserved and never listening, so this fails to connect without
    // touching any real host.
    const res = await post("/api/models/fetch-models", {
      baseUrl: "http://127.0.0.1:1",
      api: "openai-completions",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/无法连接/);
  });

  it("404s an update of a provider that does not exist", async () => {
    const res = await api("/api/models/providers/ghost", {
      method: "PUT",
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("fork and tree api", () => {
  it("reports fork points and a tree alongside the transcript", async () => {
    const project = await createProject("fork-project");
    const created = await post("/api/sessions", { projectId: project.id });
    const sessionPath = created.body.sessionPath;

    const messages = await api(
      `/api/sessions/${encodeURIComponent(sessionPath)}/messages`,
    );
    expect(messages.status).toBe(200);
    // The stub reports empty fixtures; the fields must still be present, since
    // the UI reads them unconditionally.
    expect(Array.isArray(messages.body.forkPoints)).toBe(true);
    expect(Array.isArray(messages.body.messages)).toBe(true);

    const tree = await api(`/api/sessions/${encodeURIComponent(sessionPath)}/tree`);
    expect(tree.status).toBe(200);
    expect(Array.isArray(tree.body.tree)).toBe(true);
    expect(tree.body).toHaveProperty("leafId");
    expect(["live", "disk"]).toContain(tree.body.source);
  });

  it("forks at an entry and reports the new session file", async () => {
    const project = await createProject("fork-target-project");
    const created = await post("/api/sessions", { projectId: project.id });
    const sessionPath = created.body.sessionPath;

    const forked = await post(`/api/sessions/${encodeURIComponent(sessionPath)}/fork`, {
      entryId: "entry-1",
    });
    expect(forked.status).toBe(200);
    expect(forked.body).toMatchObject({ ok: true, cancelled: false });
    expect(typeof forked.body.text).toBe("string");
    // sessionFile is what tells the client which session the branch landed in.
    expect(forked.body).toHaveProperty("sessionFile");
  });

  it("rejects a fork without an entry id", async () => {
    const project = await createProject("fork-bad-project");
    const created = await post("/api/sessions", { projectId: project.id });
    const res = await post(`/api/sessions/${encodeURIComponent(created.body.sessionPath)}/fork`, {});
    expect(res.status).toBe(400);
  });
});

describe("extensions api", () => {
  // Same reasoning as the model providers: pi's config lives outside our data
  // dir, so these point `PI_CODING_AGENT_DIR` at a scratch directory instead of
  // reading and writing the user's real ~/.pi/agent.
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "piws-api-ext-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(agentDir, { recursive: true, force: true });
  });

  it("lists the workspace scope and reports the files it resolved against", async () => {
    const project = await createProject("extensions-project");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "hello.ts"),
      "export default function () {}\n",
      "utf8",
    );

    const res = await api(`/api/extensions?projectPath=${encodeURIComponent(project.path)}`);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.settingsPath).toBe(join(agentDir, "settings.json"));
    expect(res.body.projectSettingsPath).toBe(join(project.path, ".pi", "settings.json"));
    expect(res.body.extensions).toMatchObject([
      { name: "hello", scope: "user", origin: "top-level", enabled: true },
    ]);
  });

  it("toggles an extension and answers with the re-resolved list", async () => {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    const path = join(agentDir, "extensions", "hello.ts");
    await writeFile(path, "export default function () {}\n", "utf8");

    const res = await api("/api/extensions", {
      method: "PUT",
      body: JSON.stringify({ projectPath: null, path, enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(res.body.extensions).toMatchObject([{ path, enabled: false }]);
    // The pattern pi's matcher compares against: relative to the agent dir.
    expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
      extensions: ["-extensions/hello.ts"],
    });
  });

  it("rejects a toggle for a path that is not in the inventory", async () => {
    const res = await api("/api/extensions", {
      method: "PUT",
      body: JSON.stringify({ projectPath: null, path: join(agentDir, "ghost.ts"), enabled: false }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/没有找到扩展/);
  });

  it("rejects a toggle without a boolean state", async () => {
    const res = await api("/api/extensions", {
      method: "PUT",
      body: JSON.stringify({ projectPath: null, path: "x", enabled: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("mcp api", () => {
  // Same isolation rule as the model and extension APIs: the adapter is loaded
  // from the agent dir, so a stub package goes there instead of the user's
  // real ~/.pi/agent install.
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "piws-api-mcp-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const packageDir = join(agentDir, "npm", "node_modules", "pi-mcp-adapter");
    await mkdir(join(packageDir, "dist"), { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "pi-mcp-adapter",
        version: "0.0.0",
        exports: { "./config": { import: "./dist/config.js" } },
      }),
      "utf8",
    );
    await copyFile(
      join(HERE, "testing", "stub-mcp-adapter.mjs"),
      join(packageDir, "dist", "config.js"),
    );
  });

  afterEach(async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    const mcp = await import("./mcp.ts");
    mcp.resetMcpAdapterCache();
    await rm(agentDir, { recursive: true, force: true });
  });

  const seedServer = async (name: string, entry: Record<string, unknown>): Promise<void> => {
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { [name]: entry } }, null, 2),
      "utf8",
    );
  };

  it("serves the inventory with the paths the page shows", async () => {
    await seedServer("figma", { command: "npx", args: ["-y", "figma-developer-mcp"], env: { KEY: "secret" } });

    const res = await api("/api/mcp");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.servers).toMatchObject([{ name: "figma", transport: "stdio" }]);
    expect(res.body.paths.piGlobal).toBe(join(agentDir, "mcp.json"));
    // Secret values never reach the response.
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("creates a server and answers with the re-read inventory", async () => {
    const project = await createProject("mcp-project");
    const res = await api("/api/mcp/servers", {
      method: "PUT",
      body: JSON.stringify({
        projectPath: project.path,
        scope: "global",
        originalName: null,
        draft: {
          name: "web-search",
          transport: "stdio",
          command: "npx",
          args: "-y search-mcp",
          cwd: "",
          url: "",
          env: [],
          headers: [],
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.body.servers).toMatchObject([{ name: "web-search", detail: "npx -y search-mcp" }]);
  });

  it("rejects a malformed draft with a 400", async () => {
    const res = await api("/api/mcp/servers", {
      method: "PUT",
      body: JSON.stringify({
        scope: "global",
        draft: { name: "bad", transport: "http", url: "not-a-url" },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http/);
  });

  it("toggles a server for a workspace and explains the missing-workspace case", async () => {
    await seedServer("figma", { command: "npx" });
    const project = await createProject("mcp-toggle");

    const off = await api("/api/mcp/state", {
      method: "PUT",
      body: JSON.stringify({ projectPath: project.path, name: "figma", enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(off.body.servers).toMatchObject([{ name: "figma", enabled: false }]);

    const noWorkspace = await api("/api/mcp/state", {
      method: "PUT",
      body: JSON.stringify({ name: "figma", enabled: true }),
    });
    expect(noWorkspace.status).toBe(400);
    expect(noWorkspace.body.error).toMatch(/工作区/);
  });

  it("deletes a server and refuses one owned by another agent", async () => {
    await seedServer("figma", { command: "npx" });
    const deleted = await api("/api/mcp/servers", {
      method: "DELETE",
      body: JSON.stringify({ name: "figma" }),
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.servers).toEqual([]);

    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ imports: ["cursor"] }), "utf8");
    const refused = await api("/api/mcp/servers", {
      method: "DELETE",
      body: JSON.stringify({ name: "from-cursor" }),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/cursor/);
  });

  it("imports another agent's config", async () => {
    const res = await post("/api/mcp/imports", { kinds: ["cursor"] });
    expect(res.status).toBe(200);
    expect(res.body.servers).toMatchObject([{ name: "from-cursor", hostImport: true }]);
  });

  it("treats install as a no-op when the adapter already loads", async () => {
    // The install endpoint shells out to pi's package manager, so this asserts
    // the guard: with the stub present it must answer from the loaded module
    // instead of running npm again.
    const res = await post("/api/mcp/install", {});
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it("restarts by retiring the resident processes", async () => {
    const project = await createProject("mcp-restart");
    await post("/api/sessions", { projectId: project.id });

    const res = await post("/api/mcp/restart");
    expect(res.status).toBe(200);
    expect(res.body.closed).toBeGreaterThan(0);
    expect(registry.list()).toHaveLength(0);
  });
});

describe("mcp api without the adapter", () => {
  // No stub package here on purpose: this is the state a user is in before
  // installing pi-mcp-adapter, and the page has to say so rather than render an
  // empty inventory. Nothing in this block may call the install endpoint — it
  // would run a real `npm install`.
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "piws-api-mcp-missing-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const mcp = await import("./mcp.ts");
    mcp.resetMcpAdapterCache();
  });

  afterEach(async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(agentDir, { recursive: true, force: true });
  });

  it("answers with an install hint instead of an empty list", async () => {
    const res = await api("/api/mcp");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.unavailableReason).toMatch(/pi-mcp-adapter/);
    expect(res.body.servers).toEqual([]);
  });
});
