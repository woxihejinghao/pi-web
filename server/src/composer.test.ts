import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type RpcClient } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contextUsageFromDisk,
  estimateContextTokens,
  readComposerFromClient,
  readComposerFromDefaults,
  readComposerFromDisk,
  resetDefaultComposerCache,
} from "./composer.ts";
import { modelsPath } from "./models.ts";

const HEADER = {
  type: "session",
  version: 3,
  id: "01a04228-2612-7b9a-b6f1-f5c38cc1e726",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/tmp/project",
};

const modelChange = (id: string, parentId: string | null, provider: string, modelId: string) => ({
  type: "model_change",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.500Z",
  provider,
  modelId,
});

const message = (id: string, parentId: string | null, role: string, content: unknown) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:01.000Z",
  message: { role, content },
});

/** An assistant reply carrying the usage pi records on every real one. */
const assistant = (
  id: string,
  parentId: string | null,
  text: string,
  usage: { input: number; output: number; totalTokens: number },
  stopReason = "stop",
) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:02.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    usage: { cacheRead: 0, cacheWrite: 0, ...usage },
  },
});

const compaction = (id: string, parentId: string | null) => ({
  type: "compaction",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:03.000Z",
  summary: "summarised",
  firstKeptEntryId: id,
  tokensBefore: 5000,
});

async function writeSession(dir: string, entries: unknown[]): Promise<string> {
  const path = join(dir, "session.jsonl");
  await writeFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
  return path;
}

let dir: string;
let agentDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "piws-composer-"));
  agentDir = await mkdtemp(join(tmpdir(), "piws-composer-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(dir, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
});

describe("estimateContextTokens", () => {
  it("estimates from character count when no reply has usage yet", () => {
    // 12 characters / 4, pi's own rule.
    const messages = [{ role: "user", content: "hello world!", timestamp: 0 }] as never;
    expect(estimateContextTokens(messages)).toBe(3);
  });

  it("uses the last successful reply's usage as the base", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 }, timestamp: 1 },
    ] as never;
    expect(estimateContextTokens(messages)).toBe(1000);
  });

  it("adds the messages that came after the last reply", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 }, timestamp: 1 },
      { role: "user", content: "12345678", timestamp: 2 },
    ] as never;
    expect(estimateContextTokens(messages)).toBe(1002);
  });

  it("skips aborted replies, which never described a full context", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "cut" }], stopReason: "aborted", usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 }, timestamp: 1 },
      { role: "user", content: "12345678", timestamp: 2 },
    ] as never;
    // Both messages fall back to the character estimate: 1 + 2.
    expect(estimateContextTokens(messages)).toBe(3);
  });
});

describe("contextUsageFromDisk", () => {
  it("returns null when the model declares no context window", async () => {
    const path = await writeSession(dir, [
      HEADER,
      modelChange("m1", null, "cz", "deepseek-flash"),
      message("u1", "m1", "user", "hello"),
    ]);
    expect(contextUsageFromDisk(SessionManager.open(path), 0)).toBeNull();
  });

  it("reports tokens and the percentage of the window", async () => {
    const path = await writeSession(dir, [
      HEADER,
      modelChange("m1", null, "cz", "deepseek-flash"),
      message("u1", "m1", "user", "hello"),
      assistant("a1", "u1", "hi", { input: 500, output: 500, totalTokens: 40000 }),
    ]);
    const usage = contextUsageFromDisk(SessionManager.open(path), 100000);
    expect(usage).toEqual({ tokens: 40000, contextWindow: 100000, percent: 40 });
  });

  it("refuses to report a pre-compaction figure", async () => {
    // The only usage on the branch predates the summary, so it describes a
    // context that no longer exists. pi answers "unknown" here too.
    const path = await writeSession(dir, [
      HEADER,
      modelChange("m1", null, "cz", "deepseek-flash"),
      message("u1", "m1", "user", "hello"),
      assistant("a1", "u1", "hi", { input: 500, output: 500, totalTokens: 40000 }),
      compaction("c1", "a1"),
      message("u2", "c1", "user", "another question"),
    ]);
    const usage = contextUsageFromDisk(SessionManager.open(path), 100000);
    expect(usage).toEqual({ tokens: null, contextWindow: 100000, percent: null });
  });
});

describe("readComposerFromDisk", () => {
  it("resolves the last model change against models.json", async () => {
    await writeFile(
      modelsPath(),
      JSON.stringify({
        providers: {
          cz: {
            name: "cz",
            models: [{ id: "deepseek-flash", name: "DeepSeek Flash", contextWindow: 200000, reasoning: true }],
          },
        },
      }),
      "utf8",
    );
    const path = await writeSession(dir, [
      HEADER,
      modelChange("m1", null, "cz", "deepseek-flash"),
      message("u1", "m1", "user", "hello"),
      assistant("a1", "u1", "hi", { input: 500, output: 500, totalTokens: 20000 }),
      // A later switch wins: the composer shows what the session is on now.
      modelChange("m2", "a1", "cz", "deepseek-flash"),
    ]);

    const state = await readComposerFromDisk(path);
    expect(state.live).toBe(false);
    expect(state.model).toEqual({
      provider: "cz",
      id: "deepseek-flash",
      name: "DeepSeek Flash",
      contextWindow: 200000,
      reasoning: true,
    });
    expect(state.context).toEqual({ tokens: 20000, contextWindow: 200000, percent: 10 });
    // No process, so the switchable list is unknown rather than empty.
    expect(state.models).toBeNull();
  });

  it("keeps the model even when models.json does not define it", async () => {
    await writeFile(modelsPath(), JSON.stringify({ providers: {} }), "utf8");
    const path = await writeSession(dir, [
      HEADER,
      modelChange("m1", null, "gone", "vanished"),
      message("u1", "m1", "user", "hello"),
    ]);

    const state = await readComposerFromDisk(path);
    expect(state.model).toEqual({
      provider: "gone",
      id: "vanished",
      name: null,
      contextWindow: 0,
      reasoning: false,
    });
    // Without a window there is nothing to measure against.
    expect(state.context).toBeNull();
  });

  it("reports no model for a session that never sent a request", async () => {
    const path = await writeSession(dir, [HEADER]);
    const state = await readComposerFromDisk(path);
    expect(state).toEqual({ live: false, model: null, models: null, context: null });
  });
});

describe("readComposerFromClient", () => {
  function client(overrides: Record<string, unknown>): RpcClient {
    return {
      getState: () =>
        Promise.resolve({
          model: {
            provider: "cz",
            id: "deepseek-flash",
            name: "DeepSeek Flash",
            contextWindow: 128000,
            reasoning: true,
          },
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "one-at-a-time",
          sessionFile: "/tmp/session.jsonl",
          sessionId: "id",
          autoCompactionEnabled: true,
          messageCount: 2,
          pendingMessageCount: 0,
        }),
      getAvailableModels: () =>
        Promise.resolve([
          { provider: "cz", id: "deepseek-flash", contextWindow: 128000, reasoning: true },
          { provider: "cz", id: "glm", contextWindow: 64000, reasoning: false },
        ]),
      getSessionStats: () =>
        Promise.resolve({
          contextUsage: { tokens: 64000, contextWindow: 128000, percent: 50 },
        }),
      ...overrides,
    } as unknown as RpcClient;
  }

  it("reports the live model, the switchable list and the context usage", async () => {
    const state = await readComposerFromClient(client({}), new Map());
    expect(state.live).toBe(true);
    expect(state.model?.id).toBe("deepseek-flash");
    expect(state.models?.map((m) => m.id)).toEqual(["deepseek-flash", "glm"]);
    expect(state.context).toEqual({ tokens: 64000, contextWindow: 128000, percent: 50 });
  });

  it("fills in display names from the on-disk catalog", async () => {
    const catalog = new Map([
      ["cz", new Map([["glm", { id: "glm", name: "GLM 5.3" }]])],
    ]);
    const state = await readComposerFromClient(client({}), catalog);
    expect(state.models?.find((m) => m.id === "glm")?.name).toBe("GLM 5.3");
  });

  it("reports an unknown context as null rather than zero", async () => {
    const state = await readComposerFromClient(
      client({ getSessionStats: () => Promise.resolve({ contextUsage: undefined }) }),
    );
    expect(state.context).toBeNull();
  });
});

describe("readComposerFromDefaults", () => {
  const providers = {
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
  };

  const seed = async (settings: unknown): Promise<void> => {
    await writeFile(modelsPath(), JSON.stringify({ providers }), "utf8");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings), "utf8");
  };

  beforeEach(() => {
    // The resolver behind this read is reused for a few seconds, and every test
    // here points it at a fresh agent directory.
    resetDefaultComposerCache();
  });

  it("lists what pi would list, and the model pi would start on", async () => {
    await seed({ defaultProvider: "cz", defaultModel: "glm" });

    const state = await readComposerFromDefaults(dir);
    expect(state.live).toBe(false);
    expect(state.context).toBeNull();
    expect(state.models?.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "cz/deepseek-flash",
      "cz/glm",
    ]);
    expect(state.model).toMatchObject({ provider: "cz", id: "glm", name: "GLM 5.3" });
  });

  it("leaves out a provider with no credential", async () => {
    await seed({});
    const state = await readComposerFromDefaults(dir);
    expect(state.models?.some((m) => m.provider === "unauthed")).toBe(false);
  });

  it("falls back to the first available model when settings name none", async () => {
    await seed({});
    const state = await readComposerFromDefaults(dir);
    expect(state.model?.id).toBe("deepseek-flash");
  });

  it("falls back when the saved default is no longer available", async () => {
    await seed({ defaultProvider: "cz", defaultModel: "removed" });
    const state = await readComposerFromDefaults(dir);
    expect(state.model?.id).toBe("deepseek-flash");
  });
});
