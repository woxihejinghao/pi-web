import { createServer, request as httpRequest, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus.ts";
import { resetDefaultComposerCache } from "./composer.ts";
import { resetSessionOpenCache } from "./session-open.ts";
import { MINIMAL_SYSTEM_PROMPT } from "./presets.ts";
import { SessionRegistry } from "./registry.ts";
import { createRequestHandler } from "./routes.ts";
import { sessionDirFor } from "./session-path.ts";
import type { CreateTerminalInput, TerminalHost, TerminalInfo } from "./terminal.ts";

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
  // Both are process-wide and keyed by file, so a test that rewrites a session
  // must not read an earlier test's parse.
  resetSessionOpenCache();

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
  // The stub reads these at spawn, so a test that set one must not leak it into
  // the next process — a stale transcript, or a run left in flight, would be a
  // confusing failure somewhere else.
  delete process.env.STUB_MESSAGES;
  delete process.env.STUB_MESSAGES_FILE;
  delete process.env.STUB_KEEP_RUNNING;
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

describe("request limits", () => {
  it("rejects a declared body larger than the configured limit before parsing", async () => {
    const tinyRegistry = new SessionRegistry({ cliPath: STUB_CLI });
    const tinyHandler = createRequestHandler({
      registry: tinyRegistry,
      bus: new EventBus(),
      sessionRoot,
      requestBodyMaxBytes: 4,
    });
    const tinyServer = createServer((req, res) => {
      void tinyHandler(req, res);
    });
    await new Promise<void>((resolve) => tinyServer.listen(0, "127.0.0.1", resolve));
    const tinyBase = `http://127.0.0.1:${(tinyServer.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${tinyBase}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: projectRoot }),
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "request body too large" });
    } finally {
      await tinyRegistry.closeAll("test-cleanup");
      await new Promise<void>((resolve) => tinyServer.close(() => resolve()));
    }
  });
});

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

  it("searches the project for an @ completion query", async () => {
    const project = await createProject("search");
    await mkdir(join(project.path, "src/lib"), { recursive: true });
    await writeFile(join(project.path, "src/lib/api.ts"), "", "utf8");
    await writeFile(join(project.path, "README.md"), "", "utf8");

    const res = await api(`/api/projects/${project.id}/files/search?q=api`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.query).toBe("api");
    expect(res.body.items.map((item: any) => item.path)).toContain("src/lib/api.ts");
  });

  it("bounds a search by limit and reports the cut", async () => {
    const project = await createProject("search-limit");
    await writeFile(join(project.path, "api.ts"), "", "utf8");
    await writeFile(join(project.path, "api.test.ts"), "", "utf8");

    const res = await api(`/api/projects/${project.id}/files/search?q=api&limit=1`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.truncated).toBe(true);
  });
});

describe("external session-referenced image api", () => {
  async function writeImageSession(sessionName: string, projectPath: string, reference: string): Promise<string> {
    const sessionPath = join(sessionRoot, `--${sessionName}--`, "session.jsonl");
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, [
      { type: "session", version: 3, id: sessionName, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
      { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: reference } },
    ].map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
    return sessionPath;
  }

  it("serves an image named in a bash command and markdown link", async () => {
    const project = await createProject("external-image");
    const imageDir = await mkdtemp(join(tmpdir(), "piws-external-image-"));
    const imagePath = join(imageDir, "fin_archive.png");
    await writeFile(imagePath, "PNG bytes", "utf8");
    const sessionPath = await writeImageSession("external-image", project.path, `bash command: open ${imagePath}`);
    const encoded = encodeURIComponent(imagePath);
    const session = encodeURIComponent(sessionPath);
    const file = await api(`/api/projects/${project.id}/file?path=${encoded}&session=${session}`);
    expect(file.status).toBe(200);
    expect(file.body).toMatchObject({ kind: "image", name: "fin_archive.png" });
    const markdownSessionPath = await writeImageSession("external-markdown", project.path, `![preview](${imagePath})`);
    const markdownSession = encodeURIComponent(markdownSessionPath);
    const markdown = await api(`/api/projects/${project.id}/file?path=${encoded}&session=${markdownSession}`);
    expect(markdown.status).toBe(200);
    const raw = await fetch(`${baseUrl}/api/projects/${project.id}/raw?path=${encoded}&session=${session}`);
    expect(raw.status).toBe(200);
    expect(Buffer.from(await raw.arrayBuffer()).toString()).toBe("PNG bytes");
  });

  it("rejects unreferenced, prefixed, missing-session, and wrong-project requests", async () => {
    const project = await createProject("external-reject");
    const other = await createProject("external-other");
    const imageDir = await mkdtemp(join(tmpdir(), "piws-external-reject-"));
    const imagePath = join(imageDir, "unreferenced.png");
    await writeFile(imagePath, "PNG bytes", "utf8");
    const sessionPath = await writeImageSession("external-reject", project.path, `${imagePath}.bak`);
    const path = encodeURIComponent(imagePath);
    const session = encodeURIComponent(sessionPath);
    expect((await api(`/api/projects/${project.id}/file?path=${path}&session=${session}`)).status).toBe(403);
    expect((await api(`/api/projects/${project.id}/file?path=${path}`)).status).toBe(403);
    expect((await api(`/api/projects/${other.id}/file?path=${path}&session=${session}`)).status).toBe(403);
  });

  it("rejects a symlink that escapes the referenced image directory", async () => {
    const project = await createProject("external-symlink");
    const imageDir = await mkdtemp(join(tmpdir(), "piws-external-symlink-"));
    const outsideDir = join(imageDir, "outside");
    const linkDir = join(imageDir, "link");
    await mkdir(outsideDir);
    await mkdir(linkDir);
    const outside = join(outsideDir, "secret.txt");
    const link = join(linkDir, "escape.png");
    await writeFile(outside, "secret", "utf8");
    await rm(link, { force: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, link);
    const sessionPath = await writeImageSession("external-symlink", project.path, link);
    const response = await api(`/api/projects/${project.id}/file?path=${encodeURIComponent(link)}&session=${encodeURIComponent(sessionPath)}`);
    expect(response.status).toBe(403);
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
    expect(res.body.total).toBe(1);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].title).toBe("hello there");
  });

  it("pages the session list without losing the total", async () => {
    const project = await createProject("paged-sessions");
    const sessionDir = sessionDirFor(project.path, sessionRoot);
    await mkdir(sessionDir, { recursive: true });
    for (const [name, id, at] of [
      ["older.jsonl", "aaaa2222-2222-3333-4444-555555555555", "2026-01-01T00:00:00.000Z"],
      ["newer.jsonl", "bbbb2222-2222-3333-4444-555555555555", "2026-02-01T00:00:00.000Z"],
    ] as const) {
      await writeFile(
        join(sessionDir, name),
        `${JSON.stringify({
          type: "session",
          version: 3,
          id,
          timestamp: at,
          cwd: project.path,
        })}\n${JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: at,
          message: { role: "user", content: id, timestamp: Date.parse(at) },
        })}\n`,
        "utf8",
      );
    }

    const page = await api(`/api/projects/${project.id}/sessions?limit=1`);
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(2);
    expect(page.body.sessions).toHaveLength(1);
    expect(page.body.sessions[0].path.endsWith("newer.jsonl")).toBe(true);

    // A page size is a display hint: nonsense falls back to the full list.
    const bogus = await api(`/api/projects/${project.id}/sessions?limit=zero`);
    expect(bogus.body.sessions).toHaveLength(2);
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

  it("hands a tool result's image out as a URL and serves the bytes from it", async () => {
    // The transcript no longer drags every screenshot of a session along with
    // it: a tool result's pictures come back addressed, and the browser fetches
    // the ones it renders. A user's own picture keeps its bytes, because a retry
    // re-sends them to pi (see `session-images.ts`).
    const sessionPath = join(sessionRoot, "--images--", "images.jsonl");
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(
      sessionPath,
      [
        { type: "session", version: 3, id: "images-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot },
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "user",
            content: [
              { type: "text", text: "看看" },
              { type: "image", data: "dXNlcg==", mimeType: "image/png" },
            ],
          },
        },
        {
          type: "message",
          id: "t1",
          parentId: "u1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "read",
            content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
            isError: false,
            timestamp: 2,
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );
    const url = `/api/sessions/${encodeURIComponent(sessionPath)}/messages`;

    const res = await api<{ messages: { role: string; content: Record<string, unknown>[] }[] }>(url);
    expect(res.status).toBe(200);

    const userImage = res.body.messages.find((entry) => entry.role === "user")!.content[1]!;
    expect(userImage).toMatchObject({ type: "image", data: "dXNlcg==", mimeType: "image/png" });

    const toolImage = res.body.messages.find((entry) => entry.role === "toolResult")!.content[0]!;
    expect(toolImage.data).toBeUndefined();
    expect(toolImage).toMatchObject({ type: "image", mimeType: "image/png" });
    const imageUrl = toolImage.url as string;
    // The ordinal counts the user's image too, so the tool's is #1.
    expect(imageUrl).toContain("/image/1?v=");

    const image = await fetch(baseUrl + imageUrl);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await image.arrayBuffer()).toString("utf8")).toBe("hello");

    // An ordinal is only meaningful for the file version it was named with.
    const stale = await fetch(`${baseUrl}${imageUrl.replace(/v=.*$/, "v=0")}`);
    expect(stale.status).toBe(404);
  });

  it("addresses a live transcript's pictures too, out of the handle", async () => {
    // A session mid-turn answers from pi's memory — and *that* is the switch the
    // reader makes over and over. It used to come back with every screenshot the
    // process still remembered: tens of megabytes parsed on the main thread,
    // which is the 正在载入会话… the user hits when they leave a session they just
    // prompted and come back. The file is not where those bytes are, so the
    // handle keeps the copy the URL addresses.
    const sessionPath = join(sessionRoot, "--live-images--", "live.jsonl");
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "live-images",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: projectRoot,
      })}\n`,
      "utf8",
    );

    // Deliberately bigger than any assertion below would notice if it leaked:
    // the response has to be the transcript, not the picture it mentions.
    const data = Buffer.alloc(150_000, 7).toString("base64");
    // Through a file rather than STUB_MESSAGES: this payload is ~200 KB of base64,
    // and Linux refuses to exec with any single environment string over 128 KiB
    // (E2BIG), so as an env var it only ever opened on macOS.
    const messagesFile = join(sessionRoot, "--live-images--", "stub-messages.json");
    await writeFile(
      messagesFile,
      JSON.stringify([
        {
          role: "user",
          content: [
            { type: "text", text: "看看" },
            { type: "image", data: "dXNlcg==", mimeType: "image/png" },
          ],
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [{ type: "image", data, mimeType: "image/png" }],
          isError: false,
          timestamp: 1,
        },
      ]),
      "utf8",
    );
    process.env.STUB_MESSAGES_FILE = messagesFile;

    // Prompt it and leave the turn in flight: it stays resident for ten minutes
    // (registry.ts) *and* its memory is still ahead of the file, so the switch
    // back has to be answered by the process — the file does not have these
    // turns at all.
    process.env.STUB_KEEP_RUNNING = "1";
    const state = await api(`/api/sessions/${encodeURIComponent(sessionPath)}/state`);
    expect(state.status).toBe(200);
    expect(
      (await post(`/api/sessions/${encodeURIComponent(sessionPath)}/prompt`, { message: "看看" }))
        .status,
    ).toBe(200);

    const url = `/api/sessions/${encodeURIComponent(sessionPath)}/messages`;
    const text = await (await fetch(baseUrl + url)).text();
    expect(text).not.toContain(data);

    const body = JSON.parse(text) as {
      messages: { role: string; content: Record<string, unknown>[] }[];
    };
    const userImage = body.messages.find((entry) => entry.role === "user")!.content[1]!;
    expect(userImage).toMatchObject({ type: "image", data: "dXNlcg==", mimeType: "image/png" });

    const toolImage = body.messages.find((entry) => entry.role === "toolResult")!.content[0]!;
    expect(toolImage.data).toBeUndefined();
    expect(toolImage).toMatchObject({ type: "image", mimeType: "image/png" });
    const imageUrl = toolImage.url as string;
    // Same ordinal space as the file's, but a version that names memory.
    expect(imageUrl).toContain("/image/1?v=live-");

    const image = await fetch(baseUrl + imageUrl);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer()).toString("base64")).toBe(data);

    // An unchanged transcript keeps its version, so coming back is a cache hit
    // rather than a re-download of every screenshot.
    const again = await api<{ messages: { role: string; content: Record<string, unknown>[] }[] }>(url);
    const againUrl = again.body.messages.find((entry) => entry.role === "toolResult")!.content[0]!
      .url;
    expect(againUrl).toBe(imageUrl);

    // The copy goes when the process does: a URL naming a transcript nobody holds
    // any more must 404 rather than answer with whatever is at that ordinal now.
    await post(`/api/sessions/${encodeURIComponent(sessionPath)}/stop`);
    expect((await fetch(baseUrl + imageUrl)).status).toBe(404);
  });

  it("reads a settled session's file even while its process is resident", async () => {
    // A process that is not working is no longer asked: pi appends every
    // committed entry to the session file as it lands, so the file already holds
    // the same transcript — and hauling it back out of pi means pushing every
    // picture the process remembers over stdio, which is what made returning to
    // a session that has settled crawl.
    const sessionPath = join(sessionRoot, "--settled--", "settled.jsonl");
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(
      sessionPath,
      [
        {
          type: "session",
          version: 3,
          id: "settled-session",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: projectRoot,
        },
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text: "文件的" }] },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );
    // What only the process knows: a turn the file has never seen.
    process.env.STUB_MESSAGES = JSON.stringify([
      { role: "user", content: [{ type: "text", text: "内存的" }], timestamp: 0 },
    ]);
    process.env.STUB_KEEP_RUNNING = "1";

    const url = `/api/sessions/${encodeURIComponent(sessionPath)}/messages`;
    expect((await api(`/api/sessions/${encodeURIComponent(sessionPath)}/state`)).status).toBe(200);

    const settled = await api<{ messages: unknown }>(url);
    expect(JSON.stringify(settled.body.messages)).toContain("文件的");
    expect(JSON.stringify(settled.body.messages)).not.toContain("内存的");

    // The moment a turn starts, memory is ahead of the file again and the
    // process is the only one that can answer.
    await post(`/api/sessions/${encodeURIComponent(sessionPath)}/prompt`, { message: "继续" });
    const running = await api<{ messages: unknown }>(url);
    expect(JSON.stringify(running.body.messages)).toContain("内存的");

    // …and once the run ends, the file is current again, so the next switch is
    // cheap. A flag that only ever went up would keep every later read — and
    // every screenshot in memory — on the slow path.
    await post(`/api/sessions/${encodeURIComponent(sessionPath)}/abort`);
    const ended = await api<{ messages: unknown }>(url);
    expect(JSON.stringify(ended.body.messages)).toContain("文件的");
    expect(JSON.stringify(ended.body.messages)).not.toContain("内存的");
  });

  it("404s an unknown project id", async () => {
    const res = await api("/api/projects/does-not-exist/sessions");
    expect(res.status).toBe(404);
  });

  /**
   * A rename is an append to pi's own log, so the CLI and this UI cannot
   * disagree — and nothing is left in `store.json` to keep them in sync.
   */
  it("writes a rename into pi's own session file", async () => {
    const project = await createProject("renaming");
    const sessionDir = sessionDirFor(project.path, sessionRoot);
    const sessionFile = join(sessionDir, "rename-me.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "dddd1111-2222-3333-4444-555555555555",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: project.path,
      })}\n`,
      "utf8",
    );

    const res = await post(`/api/sessions/${encodeURIComponent(sessionFile)}/rename`, {
      name: "My name",
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("My name");

    const raw = await readFile(sessionFile, "utf8");
    expect(raw).toContain('"type":"session_info"');
    expect(raw).toContain('"name":"My name"');

    const { readStore } = await import("./store.ts");
    expect(Object.keys((await readStore()).sessionOverrides)).toHaveLength(0);
  });

  it("404s a rename when the session file is not on disk", async () => {
    const target = join(sessionRoot, "--rename--", "missing.jsonl");
    const res = await post(`/api/sessions/${encodeURIComponent(target)}/rename`, { name: "My name" });
    expect(res.status).toBe(404);
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
    // A Web-side hide lives in our store; the delete has to take it along.
    const hidden = await post(`/api/sessions/${encodeURIComponent(sessionFile)}/hidden`, {
      hidden: true,
    });
    expect(hidden.status).toBe(200);

    const events: string[] = [];
    bus.subscribe((event) => events.push(event.type));

    const res = await api(`/api/sessions/${encodeURIComponent(sessionFile)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    // `trash` is optional on this host, so either path is a passing delete.
    expect(["trash", "unlink"]).toContain(res.body.method);
    expect(events).toContain("sessions_changed");
    await expect(readFile(sessionFile, "utf8")).rejects.toThrow();

    const listed = await api(`/api/projects/${project.id}/sessions?includeHidden=true`);
    expect(listed.body.sessions).toHaveLength(0);
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
    delete process.env.STUB_THINKING_LEVEL;
    delete process.env.STUB_THINKING_LEVELS;
  });

  afterEach(async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.STUB_MODEL;
    delete process.env.STUB_MODELS;
    delete process.env.STUB_CONTEXT_USAGE;
    delete process.env.STUB_THINKING_LEVEL;
    delete process.env.STUB_THINKING_LEVELS;
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
    expect(res.body).toEqual({
      live: false,
      model: null,
      models: null,
      context: null,
      thinkingLevel: null,
      // A file that does not exist carries no promise state, so the session
      // reads as the composition a caller would have gotten anyway — and with
      // no leading system message yet, that composition is still open. Plan
      // mode is the same kind of absence: no log entry, so inactive.
      presetId: "standard",
      presetLocked: false,
      planMode: false,
      // No file yet: pi writes a session lazily, on the first real message, so
      // this is what lets a client tell "the mode is off" from "nothing has said
      // anything yet" (a `/plan` typed here lives only in the process).
      sessionOnDisk: false,
    });
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

  it("lists the compositions a new session can be created with", async () => {
    const res = await api("/api/presets");
    expect(res.status).toBe(200);
    expect(res.body.presets.map((preset: { id: string }) => preset.id)).toEqual([
      "standard",
      "minimal",
    ]);
  });

  it("creates a session with the requested preset and reports it back", async () => {
    const project = await createProject("hero-preset");
    const draftFile = join(sessionRoot, "--hero-preset--", "minimal.jsonl");
    process.env.STUB_SESSION_FILE = draftFile;

    const created = await post("/api/sessions", { projectId: project.id, presetId: "minimal" });
    expect(created.status).toBe(201);
    expect(created.body.presetId).toBe("minimal");

    // The composer read is how the conversation header learns the composition,
    // so it must carry the running process's own answer.
    const composer = await api(`/api/sessions/${encodeURIComponent(draftFile)}/composer`);
    expect(composer.body.presetId).toBe("minimal");
  });

  it("refuses an unknown preset instead of opening a session without it", async () => {
    const project = await createProject("hero-preset-bad");
    // A preset decides the spawn arguments and pi cannot recompose a running
    // process, so a session created under a typo could never become the one the
    // caller asked for. Refusing is the only honest answer.
    const res = await post("/api/sessions", { projectId: project.id, presetId: "turbo" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown preset/);
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

  it("switches the thinking level over rpc and answers with the new one", async () => {
    const project = await createProject("composer-thinking");
    const sessionPath = join(sessionRoot, "--api-thinking--", "thinking.jsonl");
    process.env.STUB_SESSION_FILE = sessionPath;
    process.env.STUB_MODEL = JSON.stringify({ provider: "cz", id: "deepseek-flash", contextWindow: 128000, reasoning: true });
    process.env.STUB_MODELS = JSON.stringify([
      { provider: "cz", id: "deepseek-flash", contextWindow: 128000, reasoning: true },
    ]);

    const created = await post("/api/sessions", { projectId: project.id });
    const switched = await post(
      `/api/sessions/${encodeURIComponent(created.body.sessionPath)}/thinking`,
      { level: "high" },
    );

    expect(switched.status).toBe(200);
    // The answer is the re-read composer, so it reports the level the process
    // now holds rather than echoing the request.
    expect(switched.body.thinkingLevel).toBe("high");
    expect(switched.body.model.thinkingLevels).toContain("high");

    const reread = await api(`/api/sessions/${encodeURIComponent(created.body.sessionPath)}/composer`);
    expect(reread.body.thinkingLevel).toBe("high");
  });

  it("starts a new session on the thinking level the hero picked", async () => {
    const project = await createProject("hero-thinking");
    const sessionPath = join(sessionRoot, "--hero-thinking--", "thinking.jsonl");
    process.env.STUB_SESSION_FILE = sessionPath;
    process.env.STUB_THINKING_LEVEL = "minimal";
    process.env.STUB_MODELS = JSON.stringify([
      { provider: "cz", id: "deepseek-flash", contextWindow: 128000, reasoning: true },
    ]);

    const created = await post("/api/sessions", {
      projectId: project.id,
      thinkingLevel: "xhigh",
    });
    expect(created.status).toBe(201);
    expect(created.body.thinkingError).toBeUndefined();

    const composer = await api(`/api/sessions/${encodeURIComponent(sessionPath)}/composer`);
    expect(composer.body.thinkingLevel).toBe("xhigh");
  });

  it("rejects an unknown thinking level", async () => {
    const project = await createProject("thinking-invalid");
    process.env.STUB_SESSION_FILE = join(sessionRoot, "--thinking-invalid--", "invalid.jsonl");
    const created = await post("/api/sessions", { projectId: project.id });

    const res = await post(
      `/api/sessions/${encodeURIComponent(created.body.sessionPath)}/thinking`,
      { level: "impossible" },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/level/);
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

  it("answers for the composition it was asked about", async () => {
    const project = await createProject("commands-preset");
    const standard = await api<{ commands: { name: string }[]; presetId: string }>(
      `/api/projects/${project.id}/commands?presetId=standard`,
    );
    const minimal = await api<{ commands: { name: string }[]; presetId: string }>(
      `/api/projects/${project.id}/commands?presetId=minimal`,
    );

    expect(standard.body.presetId).toBe("standard");
    expect(minimal.body.presetId).toBe("minimal");
    // Built-ins are this server's and stay; the rest follow the process.
    expect(standard.body.commands.map((command) => command.name)).toContain("skill:pdf-tools");
    // A minimal process loads no skills and no prompt templates, and keeps only
    // the one extension its own arguments put back.
    expect(minimal.body.commands.map((command) => command.name)).toEqual([
      "compact",
      "export",
      "session",
      "name",
      "web",
    ]);
  });

  it("keeps one composition's listing from answering for another", async () => {
    const project = await createProject("commands-scope");
    const minimal = await api<{ commands: { name: string }[] }>(
      `/api/projects/${project.id}/commands?presetId=minimal`,
    );
    const standard = await api<{ commands: { name: string }[] }>(
      `/api/projects/${project.id}/commands?presetId=standard`,
    );

    expect(minimal.body.commands.map((command) => command.name)).not.toContain("skill:pdf-tools");
    // Cached under its own key, the standard listing is still the standard one.
    expect(standard.body.commands.map((command) => command.name)).toContain("skill:pdf-tools");
  });

  it("rejects an unknown preset instead of guessing one", async () => {
    const project = await createProject("commands-bad-preset");
    const res = await api(`/api/projects/${project.id}/commands?presetId=nope`);
    expect(res.status).toBe(400);
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

describe("session preset api", () => {
  /**
   * A session file that already recorded its leading system message.
   *
   * That entry is pi's own evidence of a composition *and* of the fact that one
   * has already been used — the same pair dsh keeps as `agentPreset` plus
   * `agent-preset-locked`.
   */
  async function writeStartedSession(name: string): Promise<string> {
    const dir = join(sessionRoot, `--${name}--`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "session.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: "01a04228-2612-7b9a-b6f1-f5c38cc1e726",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: projectRoot,
    };
    const system = {
      type: "message",
      id: "s1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "system",
        timestamp: 1735689601000,
        content: "",
        sections: { preamble: MINIMAL_SYSTEM_PROMPT },
      },
    };
    await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify(system)}\n`, "utf8");
    return path;
  }

  it("recomposes a session that has not started talking", async () => {
    const project = await createProject("preset-recompose");
    process.env.STUB_SESSION_FILE = join(sessionRoot, "--preset-recompose--", "session.jsonl");
    const created = await post("/api/sessions", { projectId: project.id });
    expect(created.body.presetId).toBe("standard");

    const switched = await post(`/api/sessions/${encodeURIComponent(created.body.sessionPath)}/preset`, {
      presetId: "minimal",
    });

    expect(switched.status).toBe(200);
    expect(switched.body.presetId).toBe("minimal");
    // Nothing was produced under the old composition, so it is still open.
    expect(switched.body.presetLocked).toBe(false);
    // The process really was replaced: its commands are now the minimal set.
    const commands = await api<{ commands: { name: string }[] }>(
      `/api/projects/${project.id}/commands?presetId=minimal`,
    );
    expect(commands.body.commands.map((command) => command.name)).toContain("web");
  });

  it("refuses to recompose a session that already has turns", async () => {
    const sessionPath = await writeStartedSession("preset-locked");

    const res = await post(`/api/sessions/${encodeURIComponent(sessionPath)}/preset`, {
      presetId: "standard",
    });

    expect(res.status).toBe(409);
    // Its own file already answers both questions.
    const composer = await api<{ presetId: string; presetLocked: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionPath)}/composer`,
    );
    expect(composer.body.presetId).toBe("minimal");
    expect(composer.body.presetLocked).toBe(true);
  });

  it("rejects an unknown preset", async () => {
    const sessionPath = join(sessionRoot, "--preset-unknown--", "session.jsonl");
    const res = await post(`/api/sessions/${encodeURIComponent(sessionPath)}/preset`, {
      presetId: "nope",
    });
    expect(res.status).toBe(400);
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
    // pi has a /tree command; this ui has no tree-navigation surface to run it
    // from, so the command is refused rather than accepted and ignored.
    const res = await run(sessionPath, { name: "tree" });
    expect(res.status).toBe(400);
  });

  it("requires a command name", async () => {
    const sessionPath = await openProjectSession("builtin-noname");
    const res = await run(sessionPath, {});
    expect(res.status).toBe(400);
  });
});

describe("plan mode api", () => {
  const header = (cwd: string) => ({
    type: "session",
    version: 3,
    id: "plan-session",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
  });

  /** One `custom` entry in the shape `pi.appendEntry()` writes. */
  const planEntry = (active: boolean) => ({
    type: "custom",
    id: "p1",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    customType: "pi-web-simple:plan-mode",
    data: { active },
  });

  /** A session file on disk, the way a switch would find one. */
  const writePlanSession = async (name: string, entries: unknown[]): Promise<string> => {
    const path = join(sessionRoot, `--${name}--`, `${name}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
    return path;
  };

  it("requires an explicit boolean", async () => {
    const project = await createProject("plan-invalid");
    const sessionPath = await writePlanSession("plan-invalid", [header(project.path)]);
    process.env.STUB_SESSION_FILE = sessionPath;
    // Explicit rather than a toggle: a repeated request must not flip the mode
    // a second time, so "nothing" is a bad request, not "the other one".
    const res = await post(`/api/sessions/${encodeURIComponent(sessionPath)}/plan`, {});
    expect(res.status).toBe(400);
  });

  it("treats the running process as authoritative, even against the file", async () => {
    const project = await createProject("plan-state");
    const sessionPath = await writePlanSession("plan-state", [header(project.path), planEntry(true)]);
    process.env.STUB_SESSION_FILE = sessionPath;
    // The stub answers no entries at all — a session that has not spoken yet, as
    // pi holds it in memory. The file's entry is another view's; the mode is off,
    // and answering the requested state instead would paint a click rather than
    // the log.
    const res = await post<{ ok: boolean; planMode: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionPath)}/plan`,
      { active: false },
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.planMode).toBe(false);
  });

  it("falls back to the file when the process cannot answer", async () => {
    const project = await createProject("plan-fallback");
    const sessionPath = await writePlanSession("plan-fallback", [header(project.path), planEntry(true)]);
    process.env.STUB_SESSION_FILE = sessionPath;
    process.env.STUB_FAIL_GET_ENTRIES = "1";

    const res = await post<{ ok: boolean; planMode: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionPath)}/plan`,
      { active: true },
    );
    expect(res.status).toBe(200);
    expect(res.body.planMode).toBe(true);
  });

  it("prefers the running process, which is ahead of the file", async () => {
    const project = await createProject("plan-process");
    // The file says off, the process says on: pi writes its session lazily, so a
    // switch made before the first message exists only in memory, and reading
    // the file alone would report the mode as off.
    const sessionPath = await writePlanSession("plan-process", [header(project.path), planEntry(false)]);
    process.env.STUB_SESSION_FILE = sessionPath;
    process.env.STUB_ENTRIES = JSON.stringify([
      {
        type: "custom",
        id: "p1",
        parentId: null,
        customType: "pi-web-simple:plan-mode",
        data: { active: true },
      },
    ]);

    const res = await post<{ ok: boolean; planMode: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionPath)}/plan`,
      { active: true },
    );
    expect(res.status).toBe(200);
    expect(res.body.planMode).toBe(true);
  });

  afterEach(() => {
    delete process.env.STUB_SESSION_FILE;
    delete process.env.STUB_ENTRIES;
    delete process.env.STUB_ENTRIES_LEAF;
    delete process.env.STUB_FAIL_GET_ENTRIES;
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

  it("filters other sessions' streaming frames once a session is declared", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
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

    const sessionFrame = (sessionPath: string, type: string) =>
      ({ type: "session_event", sessionPath, event: { type } }) as Parameters<
        EventBus["publish"]
      >[0];

    const hello = await nextFrame();
    expect(hello?.event).toBe("hello");
    const connectionId = hello!.data.connectionId;
    expect(typeof connectionId).toBe("string");

    const subscription = await post("/api/events/subscription", {
      connectionId,
      sessionPath: "/wanted",
    });
    expect(subscription.status).toBe(200);

    // The declared session's streaming frame comes through...
    bus.publish(sessionFrame("/wanted", "message_update"));
    const own = await nextFrame();
    expect(own?.data.sessionPath).toBe("/wanted");
    expect(own?.data.event.type).toBe("message_update");

    // ...another session's is dropped, and a low-volume frame for that same
    // session arriving right behind it proves the drop was a filter and not a
    // dead connection.
    bus.publish(sessionFrame("/other", "message_update"));
    bus.publish(sessionFrame("/other", "agent_start"));
    const otherStart = await nextFrame();
    expect(otherStart?.data.sessionPath).toBe("/other");
    expect(otherStart?.data.event.type).toBe("agent_start");

    controller.abort();
  });

  it("404s a subscription for a stream that is gone", async () => {
    const res = await post("/api/events/subscription", {
      connectionId: "00000000-0000-4000-8000-000000000000",
      sessionPath: "/x",
    });
    expect(res.status).toBe(404);
  });

  it("sheds a stream that cannot keep up instead of buffering without bound", async () => {
    // A cap of its own, tiny enough to reach in a few writes. Going through the
    // real 4MB would mean pushing hundreds of megabytes at a loopback socket.
    const tinyBus = new EventBus();
    const tinyRegistry = new SessionRegistry({ cliPath: STUB_CLI });
    tinyRegistry.onEvent((handle, event) => {
      tinyBus.publish({ type: "session_event", sessionPath: handle.sessionPath, event });
    });
    const tinyHandler = createRequestHandler({
      registry: tinyRegistry,
      bus: tinyBus,
      sessionRoot,
      sseMaxBufferedBytes: 1,
    });
    const tinyServer = createServer((req, res) => {
      void tinyHandler(req, res);
    });
    await new Promise<void>((resolve) => tinyServer.listen(0, "127.0.0.1", resolve));
    const tinyBase = `http://127.0.0.1:${(tinyServer.address() as AddressInfo).port}`;

    try {
      const controller = new AbortController();
      const res = await fetch(`${tinyBase}/api/events`, { signal: controller.signal });
      // The body is deliberately not read: the socket backs up, which is the
      // whole scenario. Enough volume to fill the kernel and Node buffers.
      const big = "x".repeat(512 * 1024);
      const frame = {
        type: "session_event",
        sessionPath: "/slow",
        event: { type: "tool_execution_update", output: big },
      } as unknown as Parameters<EventBus["publish"]>[0];
      for (let i = 0; i < 8; i += 1) tinyBus.publish(frame);

      // The server must end the connection rather than queue forever. A
      // destroyed socket surfaces as either a clean end or a read error.
      const reader = res.body!.getReader();
      await expect(
        (async () => {
          try {
            for (;;) {
              const { done } = await reader.read();
              if (done) return "closed";
            }
          } catch {
            return "closed";
          }
        })(),
      ).resolves.toBe("closed");
      controller.abort();
    } finally {
      await tinyRegistry.closeAll("test-cleanup");
      await new Promise<void>((resolve) => tinyServer.close(() => resolve()));
    }
  });
});

describe("settings", () => {
  it("serves the defaults before anything has been written", async () => {
    const res = await api("/api/settings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      appearance: "system",
      language: "system",
      contentFontSize: 14,
      transcriptDisplay: "standard",
      busySendBehavior: "queue",
      browserNotifications: false,
      titleModel: null,
    });
  });

  it("reads a two-mode generation's saved `normal` as detailed", async () => {
    await writeFile(
      join(home, "store.json"),
      JSON.stringify({
        version: 1,
        projects: [],
        sessionOverrides: {},
        settings: { transcriptDisplay: "normal" },
      }),
    );
    const store = await import("./store.ts");
    store.resetStoreCache();

    // dsh reads its own `normal` / `expanded` legacy values as `detailed`, and
    // this store has been writing the same two-mode value since before the
    // four-mode setting existed — it must migrate rather than fall back.
    const res = await api("/api/settings");
    expect(res.status).toBe(200);
    expect(res.body.transcriptDisplay).toBe("standard");
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
      transcriptDisplay: "standard",
      busySendBehavior: "queue",
      browserNotifications: false,
      titleModel: null,
    });

    const reread = await api("/api/settings");
    expect(reread.body.appearance).toBe("dark");
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

  it("round-trips the title model and refuses a malformed one", async () => {
    const chosen = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ titleModel: { provider: "local", model: "cheap" } }),
    });

    expect(chosen.status).toBe(200);
    expect(chosen.body.titleModel).toEqual({ provider: "local", model: "cheap" });
    expect((await api("/api/settings")).body.titleModel).toEqual({
      provider: "local",
      model: "cheap",
    });

    const off = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ titleModel: null }),
    });
    expect(off.body.titleModel).toBeNull();

    // A pair missing half of itself is rejected, and the stored value stands.
    const bad = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ titleModel: { provider: "local" } }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("titleModel");
    expect((await api("/api/settings")).body.titleModel).toBeNull();
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
    for (const contentFontSize of [9, 23, 14.5, "15"]) {
      const res = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ contentFontSize }),
      });
      expect(res.status).toBe(400);
    }
    expect((await api("/api/settings")).body.contentFontSize).toBe(14);
  });

  it("accepts both ends of dsh's font size range", async () => {
    // dsh's schema is `min(10).max(22).default(14)` (ui-theme's
    // theme-settings.ts, the same pair its FontSizeRow disables the stepper
    // against). The numbers are spelled out here rather than imported so a
    // drift back to the narrower 12..17 range this project used to ship fails
    // the test instead of following the constant.
    for (const contentFontSize of [10, 22]) {
      const res = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ contentFontSize }),
      });
      expect(res.status).toBe(200);
      expect(res.body.contentFontSize).toBe(contentFontSize);
    }
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

  it("carries a model's capacity and input types through a save and back", async () => {
    const created = await post("/api/models/providers", {
      id: "newco",
      models: [{ id: "big", contextWindow: 256000, maxTokens: 32000, input: ["text", "image"] }],
    });
    expect(created.status).toBe(201);

    const res = await api("/api/models/providers");
    expect(res.body.providers[0].models).toEqual([
      { id: "big", contextWindow: 256000, maxTokens: 32000, input: ["text", "image"] },
    ]);
  });

  it("carries a model's reasoning and thinking map through a save and back", async () => {
    const created = await post("/api/models/providers", {
      id: "newco",
      models: [{ id: "m", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }],
    });
    expect(created.status).toBe(201);

    const res = await api("/api/models/providers");
    expect(res.body.providers[0].models).toEqual([
      { id: "m", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
    ]);
  });

  it("refuses a reasoning flag or thinking map pi would not load, before it reaches the file", async () => {
    const flag = await post("/api/models/providers", {
      id: "newco",
      models: [{ id: "m", reasoning: "yes" }],
    });
    expect(flag.status).toBe(400);
    expect(flag.body.error).toMatch(/reasoning/);

    // A key pi does not know is a level it would ignore, and a map that does
    // nothing is worse than a refusal that says so.
    const level = await post("/api/models/providers", {
      id: "newco",
      models: [{ id: "m", thinkingLevelMap: { extreme: "max" } }],
    });
    expect(level.status).toBe(400);
    expect(level.body.error).toMatch(/档位名/);

    const effort = await post("/api/models/providers", {
      id: "newco",
      models: [{ id: "m", thinkingLevelMap: { max: "" } }],
    });
    expect(effort.status).toBe(400);
    expect(effort.body.error).toMatch(/非空字符串/);
  });

  it("refuses a capacity or input type pi would not load, before it reaches the file", async () => {
    // `null` is what a `NaN` becomes over JSON — the shape an unreadable
    // capacity box would send if the browser did not catch it first.
    const zero = await post("/api/models/providers", {
      id: "newco",
      models: [{ id: "m", contextWindow: 0 }],
    });
    expect(zero.status).toBe(400);
    expect(zero.body.error).toMatch(/上下文窗口/);

    const nan = await post("/api/models/providers", {
      id: "newco",
      models: [{ id: "m", maxTokens: null }],
    });
    expect(nan.status).toBe(400);
    expect(nan.body.error).toMatch(/最大输出/);

    const modality = await post("/api/models/providers", {
      id: "newco",
      models: [{ id: "m", input: ["audio"] }],
    });
    expect(modality.status).toBe(400);
    expect(modality.body.error).toMatch(/text 或 image/);
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

describe("fork api", () => {
  it("reports fork points alongside the transcript", async () => {
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
  // Same isolation rule as the model and extension APIs: the user layer is
  // pi's own `mcp.json` in the agent dir, so a temp agent dir stands in for
  // the real ~/.pi/agent.
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "piws-api-mcp-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(async () => {
    delete process.env.PI_CODING_AGENT_DIR;
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
    expect(res.body.servers).toMatchObject([{ name: "figma", transport: "stdio" }]);
    expect(res.body.paths.global).toBe(join(agentDir, "mcp.json"));
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

  it("deletes a server and reports an unknown one", async () => {
    await seedServer("figma", { command: "npx" });
    const deleted = await api("/api/mcp/servers", {
      method: "DELETE",
      body: JSON.stringify({ name: "figma" }),
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.servers).toEqual([]);

    const refused = await api("/api/mcp/servers", {
      method: "DELETE",
      body: JSON.stringify({ name: "ghost" }),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/ghost/);
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

describe("terminal api", () => {
  /**
   * A shell host that records what it was asked for.
   *
   * What belongs to the routes is the *decision* — which session, which
   * directory, which size — and a stand-in pins that down without node-pty
   * being installed, without a shell's startup output, and without waiting on
   * one to answer. `TerminalManager` gets the real coverage in
   * `terminal.test.ts`.
   */
  const opened: CreateTerminalInput[] = [];
  const shell = { path: "/bin/sh", name: "sh", args: ["-i"] };
  const infoFor = (id: string, input: CreateTerminalInput): TerminalInfo => ({
    id,
    sessionPath: input.sessionPath,
    title: shell.name,
    // The host decides this; the route does not carry a choice in.
    shell,
    cwd: input.cwd,
    cols: input.cols,
    rows: input.rows,
    state: "running",
    exitCode: null,
  });
  const host: TerminalHost = {
    support: () => ({ available: true }),
    shells: () => [shell],
    environment: () => ({
      cwd: "",
      maxCols: 500,
      maxRows: 200,
      maxInputBytes: 64 * 1024,
      scrollback: 1000,
    }),
    list: () => [],
    scrollbackOf: () => null,
    create: (input) => {
      opened.push(input);
      return infoFor(`t-${String(opened.length)}`, input);
    },
    attach: async (id) => ({
      info: infoFor(id, opened.at(-1)!),
      screen: "",
      sequence: 0,
    }),
    detach: () => undefined,
    snapshot: async (id) => ({ info: infoFor(id, opened.at(-1)!), screen: "", sequence: 0 }),
    write: () => undefined,
    resize: () => undefined,
    rename: (id, title) => ({ ...infoFor(id, opened.at(-1)!), title }),
    heartbeat: () => undefined,
    close: () => true,
    closeForSession: () => undefined,
    cleanupFailures: () => [],
    retryCleanup: () => false,
  };

  let terminalServer: Server;
  let terminalUrl: string;

  beforeEach(async () => {
    opened.length = 0;
    const handler = createRequestHandler({ registry, bus, sessionRoot, terminals: host });
    terminalServer = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => terminalServer.listen(0, "127.0.0.1", resolve));
    terminalUrl = `http://127.0.0.1:${(terminalServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => terminalServer.close(() => resolve()));
  });

  async function openTerminal(body: unknown): Promise<ApiResult> {
    const res = await fetch(`${terminalUrl}/api/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
  }

  it("reports what the host can offer, and what is already open", async () => {
    const res = await fetch(`${terminalUrl}/api/terminal?sessionPath=`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      support: { available: true },
      environment: {
        cwd: "",
        maxCols: 500,
        maxRows: 200,
        maxInputBytes: 64 * 1024,
        scrollback: 1000,
      },
      terminals: [],
    });
  });

  it("lists installed shells with the execution default called out", async () => {
    const res = await fetch(`${terminalUrl}/api/terminal/shells`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      shells: [{ path: "/bin/sh", name: "sh", args: ["-i"] }],
      default: { path: "/bin/sh", name: "sh", args: ["-i"] },
    });
  });

  it("passes a client-minted id and shell choice through to the host", async () => {
    const project = await createProject("terminal-choice");
    const res = await openTerminal({
      id: "tab-1",
      sessionPath: "draft:abc",
      cwd: project.path,
      cols: 90,
      rows: 28,
      shellPath: "/bin/sh",
    });
    expect(res.status).toBe(201);
    expect(opened[0]?.id).toBe("tab-1");
    expect(opened[0]?.shellPath).toBe("/bin/sh");
  });

  it("runs a draft session's shell in the workspace it was given", async () => {
    // The bug this pins: `SessionManager.open` does not fail on an id that is
    // not a session — it answers with the server process's own working
    // directory. A draft has no file on disk, so without the guard the shell
    // would open wherever the server was launched from, and the workspace check
    // would be skipped for the one case it exists for.
    const project = await createProject("terminal-draft");
    const res = await openTerminal({
      sessionPath: "draft:abc",
      cwd: project.path,
      cols: 100,
      rows: 30,
    });

    expect(res.status).toBe(201);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.cwd).toBe(project.path);
    expect(opened[0]?.cwd).not.toBe(process.cwd());
    expect(opened[0]?.sessionPath).toBe("draft:abc");
    expect(opened[0]?.cols).toBe(100);
    expect(opened[0]?.rows).toBe(30);
  });

  it("reads an existing session's own directory off disk", async () => {
    const project = await createProject("terminal-session");
    const sessionDir = sessionDirFor(project.path, sessionRoot);
    const sessionPath = join(sessionDir, "s1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "bbbb1111-2222-3333-4444-555555555555",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: project.path,
      })}\n`,
      "utf8",
    );

    const res = await openTerminal({ sessionPath, cols: 80, rows: 24 });
    expect(res.status).toBe(201);
    expect(opened[0]?.cwd).toBe(project.path);
  });

  it("refuses a workspace that is not one of the registered projects", async () => {
    const res = await openTerminal({
      sessionPath: "draft:abc",
      cwd: join(projectRoot, "not-registered"),
      cols: 80,
      rows: 24,
    });
    expect(res.status).toBe(400);
    expect(opened).toHaveLength(0);
  });

  it("refuses when there is nothing to tell it where the shell should start", async () => {
    const res = await openTerminal({ sessionPath: "draft:abc", cols: 80, rows: 24 });
    expect(res.status).toBe(400);
    expect(opened).toHaveLength(0);
  });
});
