import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS, isBuiltinCommand, runBuiltinCommand } from "./commands.ts";
import { SessionRegistry } from "./registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_CLI = join(HERE, "testing", "stub-pi.mjs");

let projectPath: string;
let sessionDir: string;
let registry: SessionRegistry;

beforeAll(async () => {
  projectPath = await realpath(await mkdtemp(join(tmpdir(), "piws-cmd-cwd-")));
  sessionDir = await realpath(await mkdtemp(join(tmpdir(), "piws-cmd-sess-")));
});

afterAll(async () => {
  await rm(projectPath, { recursive: true, force: true });
  await rm(sessionDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.STUB_SESSION_FILE;
  registry = new SessionRegistry({ cliPath: STUB_CLI });
});

afterEach(async () => {
  await registry.closeAll("test-cleanup");
});

const openSession = () => registry.open(projectPath, join(sessionDir, "commands.jsonl"));

describe("BUILTIN_COMMANDS", () => {
  it("only advertises commands the server can actually run", async () => {
    const handle = await openSession();
    for (const command of BUILTIN_COMMANDS) {
      // Every listed command must produce a reply rather than throwing
      // "unsupported" — except /name, which validates its argument first.
      const promise = runBuiltinCommand(handle, command.name, "value");
      await expect(promise).resolves.toBeTypeOf("string");
    }
  });

  it("recognises its own names and nothing else", () => {
    expect(isBuiltinCommand("compact")).toBe(true);
    expect(isBuiltinCommand("session")).toBe(true);
    // pi's built-ins that this UI does not implement must not be advertised.
    expect(isBuiltinCommand("tree")).toBe(false);
    expect(isBuiltinCommand("settings")).toBe(false);
    expect(isBuiltinCommand("skill:pdf-tools")).toBe(false);
  });
});

describe("runBuiltinCommand", () => {
  it("summarises what compaction saved", async () => {
    const handle = await openSession();
    const message = await runBuiltinCommand(handle, "compact", "");
    expect(message).toContain("12,345");
    expect(message).toContain("678");
  });

  it("passes extra arguments through as compaction instructions", async () => {
    const handle = await openSession();
    await expect(runBuiltinCommand(handle, "compact", "keep the API notes")).resolves.toBeTypeOf(
      "string",
    );
  });

  it("reports the export path", async () => {
    const handle = await openSession();
    const message = await runBuiltinCommand(handle, "export", "");
    expect(message).toMatch(/已导出到 .*\.html$/);
  });

  it("formats session stats", async () => {
    const handle = await openSession();
    const message = await runBuiltinCommand(handle, "session", "");
    expect(message).toContain("9 条消息");
    expect(message).toContain("300 tokens");
    expect(message).toContain("$0.0125");
  });

  it("requires an argument for /name", async () => {
    const handle = await openSession();
    await expect(runBuiltinCommand(handle, "name", "   ")).rejects.toThrow(/用法/);
  });

  it("sets the session name", async () => {
    const handle = await openSession();
    await expect(runBuiltinCommand(handle, "name", "重构登录")).resolves.toContain("重构登录");
  });

  it("rejects an unknown command", async () => {
    const handle = await openSession();
    await expect(runBuiltinCommand(handle, "tree", "")).rejects.toThrow(/不支持/);
  });
});
