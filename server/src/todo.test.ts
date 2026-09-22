import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TODO_PACKAGE, TODO_SOURCE, readTodo } from "./todo.ts";

/**
 * Every test points pi at a scratch agent directory, like the extension tests
 * do: `getAgentDir()` reads `PI_CODING_AGENT_DIR` on each call, so without this
 * these reads would look at the real `~/.pi/agent` (where the package happens
 * to be installed).
 *
 * The fixture is a local package directory rather than an npm install: the
 * check reads pi's settings and the resolved entries, not the registry, so the
 * only thing that matters is that `package.json` calls itself the same name the
 * real package does.
 */
let agentDir: string;
let todoDir: string;

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function extensionFile(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "export default function () {}\n", "utf8");
}

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "piws-todo-agent-"));
  todoDir = await mkdtemp(join(tmpdir(), "piws-todo-package-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  await extensionFile(join(todoDir, "extensions", "todo.ts"));
  await writeJson(join(todoDir, "package.json"), {
    name: TODO_PACKAGE,
    version: "1.0.0",
    pi: { extensions: ["./extensions"] },
  });
  await writeJson(join(agentDir, "settings.json"), { packages: [] });
});

afterEach(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDir, { recursive: true, force: true });
  await rm(todoDir, { recursive: true, force: true });
});

describe("readTodo", () => {
  it("reports a missing extension instead of an empty task list", async () => {
    const view = await readTodo(null);

    expect(view.available).toBe(false);
    expect(view.installed).toBe(false);
    expect(view.error).toBeNull();
    // The names travel with the answer, so the notice does not hard-code them.
    expect(view.packageName).toBe(TODO_PACKAGE);
    expect(view.source).toBe(TODO_SOURCE);
  });

  it("finds the package through pi's own resolver once it is configured", async () => {
    await writeJson(join(agentDir, "settings.json"), { packages: [todoDir] });

    const view = await readTodo(null);

    expect(view.available).toBe(true);
    expect(view.installed).toBe(true);
    expect(view.error).toBeNull();
  });

  it("counts an installed but disabled package as unavailable, not missing", async () => {
    // The object form is what `pi config` writes when one entry is turned off.
    await writeJson(join(agentDir, "settings.json"), {
      packages: [{ source: todoDir, extensions: ["-extensions/todo.ts"] }],
    });

    const view = await readTodo(null);

    expect(view.installed).toBe(true);
    expect(view.available).toBe(false);
  });
});
