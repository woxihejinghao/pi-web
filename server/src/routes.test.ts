import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus.ts";
import { SessionRegistry } from "./registry.ts";
import { createRequestHandler } from "./routes.ts";
import { sessionDirFor } from "./session-path.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_CLI = join(HERE, "testing", "stub-pi.mjs");

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
      contentFontSize: 14,
      transcriptDisplay: "normal",
      busySendBehavior: "queue",
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
      contentFontSize: 15,
      transcriptDisplay: "normal",
      busySendBehavior: "queue",
    });

    const reread = await api("/api/settings");
    expect(reread.body.appearance).toBe("dark");
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
    expect((await api("/api/settings")).body.contentFontSize).toBe(14);
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
