import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHandle } from "./registry.ts";

let home: string;
let dir: string;
let agentDir: string;
let store: typeof import("./store.ts");
let titles: typeof import("./session-title.ts");
let titleService: typeof import("./title-service.ts");

/** A local stand-in for the title model; nothing here touches the network. */
let server: Server;
let base: string;
let requests: Record<string, unknown>[];
let respond: (res: ServerResponse) => void;
let delayMs = 0;

beforeAll(async () => {
  home = await realpath(process.env.PI_WEB_SIMPLE_HOME!);
  dir = await realpath(await mkdtemp(join(tmpdir(), "piws-title-service-")));
  agentDir = await realpath(await mkdtemp(join(tmpdir(), "piws-title-agent-")));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  store = await import("./store.ts");
  titles = await import("./session-title.ts");
  titleService = await import("./title-service.ts");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
});

beforeEach(async () => {
  requests = [];
  delayMs = 0;
  respond = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "Login form loses email" } }] }));
  };
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      requests.push(raw.length > 0 ? JSON.parse(raw) : {});
      // A responder that can be slow, for the "renamed mid-flight" case.
      setTimeout(() => respond(res), delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await rm(join(home, "store.json"), { force: true });
  store.resetStoreCache();
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        local: { name: "local", baseUrl: base, api: "openai-completions", models: [{ id: "cheap" }] },
      },
    }),
    "utf8",
  );
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ local: { type: "api_key", key: "sk-test" } }),
    "utf8",
  );
  await store.mutateStore((draft) => {
    draft.settings.titleModel = { provider: "local", model: "cheap" };
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Header-only session file: enough for pi to open and for a title to land. */
async function writeSession(fileName: string, parentSession?: string): Promise<string> {
  const path = join(dir, fileName);
  await writeFile(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "11111111-2222-3333-4444-555555555555",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: dir,
      ...(parentSession === undefined ? {} : { parentSession }),
    })}\n`,
    "utf8",
  );
  return path;
}

function handleFor(sessionPath: string): SessionHandle {
  return {
    sessionPath,
    sessionId: "session-1",
    projectPath: dir,
    client: {} as SessionHandle["client"],
    startedAt: 0,
    lastActivityAt: 0,
    unsubscribe: () => undefined,
    dead: false,
    prewarmed: false,
  };
}

function firstMessage(text: string): JsonAgentSessionEvent {
  return {
    type: "entry_appended",
    entry: {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: text, timestamp: 1 },
    },
  } as unknown as JsonAgentSessionEvent;
}

function makeService(): { service: InstanceType<typeof titleService.SessionTitleService>; published: string[] } {
  const published: string[] = [];
  const service = new titleService.SessionTitleService({
    liveWriter: () => undefined,
    publish: (projectPath) => published.push(projectPath),
  });
  return { service, published };
}

/** Long enough for the fire-and-forget pipeline to settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

describe("SessionTitleService", () => {
  it("writes a model title into the session's own file", async () => {
    const path = await writeSession("titled.jsonl");
    const { service, published } = makeService();

    service.noteEvent(handleFor(path), firstMessage("the login form loses my email"));

    await vi.waitFor(() => {
      expect(titles.sessionTitleOf(path)).toBe("Login form loses email");
    });
    expect(requests).toHaveLength(1);
    expect(published).toEqual([dir]);
    service.stop();
  });

  it("does nothing when no title model is configured", async () => {
    const path = await writeSession("unconfigured.jsonl");
    await store.mutateStore((draft) => {
      draft.settings.titleModel = null;
    });
    const { service } = makeService();

    service.noteEvent(handleFor(path), firstMessage("hello"));
    await settle();

    expect(titles.sessionTitleOf(path)).toBeUndefined();
    expect(requests).toHaveLength(0);
    service.stop();
  });

  it("leaves a session that already has a name alone", async () => {
    const path = await writeSession("named.jsonl");
    await titles.setSessionTitle(path, "Named by the user", undefined);
    const { service } = makeService();

    service.noteEvent(handleFor(path), firstMessage("hello"));
    await settle();

    expect(titles.sessionTitleOf(path)).toBe("Named by the user");
    expect(requests).toHaveLength(0);
    service.stop();
  });

  it("keeps a rename that happened while the model was answering", async () => {
    const path = await writeSession("renamed-mid-flight.jsonl");
    const { service } = makeService();
    delayMs = 60;

    service.noteEvent(handleFor(path), firstMessage("hello"));
    await titles.setSessionTitle(path, "Mine wins", undefined);
    await settle();

    expect(titles.sessionTitleOf(path)).toBe("Mine wins");
    service.stop();
  });

  it("asks once per session, however many messages arrive", async () => {
    const path = await writeSession("once.jsonl");
    const { service } = makeService();

    service.noteEvent(handleFor(path), firstMessage("first"));
    service.noteEvent(handleFor(path), firstMessage("second"));
    await vi.waitFor(() => {
      expect(titles.sessionTitleOf(path)).toBe("Login form loses email");
    });

    expect(requests).toHaveLength(1);
    service.stop();
  });

  it("does not title a session that was forked from another", async () => {
    const path = await writeSession("forked.jsonl", "/tmp/parent.jsonl");
    const { service } = makeService();

    service.noteEvent(handleFor(path), firstMessage("hello"));
    await settle();

    expect(titles.sessionTitleOf(path)).toBeUndefined();
    expect(requests).toHaveLength(0);
    service.stop();
  });

  it("stays quiet when the model fails", async () => {
    const path = await writeSession("failing.jsonl");
    respond = (res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    };
    const { service } = makeService();

    service.noteEvent(handleFor(path), firstMessage("hello"));
    await vi.waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    await settle();

    expect(titles.sessionTitleOf(path)).toBeUndefined();
    service.stop();
  });

  it("drops work that was in flight when it stopped", async () => {
    const path = await writeSession("stopped.jsonl");
    const { service } = makeService();
    delayMs = 60;

    service.noteEvent(handleFor(path), firstMessage("hello"));
    service.stop();
    await settle();

    expect(titles.sessionTitleOf(path)).toBeUndefined();
    service.stop();
  });
});
