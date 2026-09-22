import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  McpConfigError,
  deleteMcpServer,
  importMcpConfigs,
  readMcp,
  resetMcpAdapterCache,
  saveMcpServer,
  setMcpServerEnabled,
} from "./mcp.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "testing", "stub-mcp-adapter.mjs");

/**
 * The MCP page loads `pi-mcp-adapter/config` from the agent dir by path, so
 * these tests install a stub package there. That keeps them off the user's real
 * `~/.config/mcp` and `~/.pi/agent` files, and off whichever adapter version
 * happens to be installed.
 */
let agentDir: string;
let projectDir: string;

const packageDir = () => join(agentDir, "npm", "node_modules", "pi-mcp-adapter");
const globalConfig = () => join(agentDir, "mcp.json");
const projectConfig = () => join(projectDir, ".mcp.json");
const projectPiConfig = () => join(projectDir, ".pi", "mcp.json");

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

beforeAll(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "piws-mcp-agent-"));
  projectDir = await mkdtemp(join(tmpdir(), "piws-mcp-project-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  await mkdir(join(packageDir(), "dist"), { recursive: true });
  await writeJson(join(packageDir(), "package.json"), {
    name: "pi-mcp-adapter",
    version: "0.0.0",
    exports: { "./config": { import: "./dist/config.js" } },
  });
  await copyFile(STUB, join(packageDir(), "dist", "config.js"));
});

afterAll(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(globalConfig(), { force: true });
  await rm(projectConfig(), { force: true });
  await rm(join(projectDir, ".pi"), { recursive: true, force: true });
  resetMcpAdapterCache();
});

const find = (view: Awaited<ReturnType<typeof readMcp>>, name: string) =>
  view.servers.find((server) => server.name === name);

describe("readMcp", () => {
  it("describes stdio and remote servers without leaking secret values", async () => {
    await writeJson(globalConfig(), {
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma-developer-mcp", "--stdio"],
          env: { FIGMA_API_KEY: "sk-secret-value" },
        },
        remote: {
          url: "https://mcp.example.test/v1",
          headers: { Authorization: "Bearer sk-header-secret" },
        },
      },
    });

    const view = await readMcp(projectDir);
    expect(view.available).toBe(true);

    const figma = find(view, "figma")!;
    expect(figma.transport).toBe("stdio");
    expect(figma.detail).toBe("npx -y figma-developer-mcp --stdio");
    // Names, never values.
    expect(figma.envKeys).toEqual(["FIGMA_API_KEY"]);

    const remote = find(view, "remote")!;
    expect(remote.transport).toBe("http");
    expect(remote.headerKeys).toEqual(["Authorization"]);
    // A URL with no explicit auth mode is auto-detected as OAuth by the adapter.
    expect(remote.auth).toBe("oauth");

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("sk-secret-value");
    expect(serialized).not.toContain("sk-header-secret");
  });

  it("reports the workspace layer on top of the user layer", async () => {
    await writeJson(globalConfig(), { mcpServers: { shared: { command: "global-cmd" } } });
    await writeJson(projectConfig(), { mcpServers: { local: { command: "local-cmd" } } });

    const view = await readMcp(projectDir);
    expect(find(view, "shared")?.sourceKind).toBe("user");
    expect(find(view, "local")?.sourceKind).toBe("project");
    // The file the row would be written to is reported for every server.
    expect(find(view, "local")?.sourcePath).toBe(projectConfig());
  });

  it("lists detected host configs that are not imported yet", async () => {
    const view = await readMcp(projectDir);
    expect(view.importable.map((entry) => entry.kind)).toEqual(["cursor"]);
  });
});

describe("saveMcpServer", () => {
  const draft = (overrides: Record<string, unknown> = {}) => ({
    name: "new-server",
    transport: "stdio" as const,
    command: "npx",
    args: "-y thing --stdio",
    cwd: "",
    url: "",
    env: [{ key: "TOKEN", value: "t-1" }],
    headers: [],
    ...overrides,
  });

  it("creates a stdio server in the requested scope", async () => {
    const view = await saveMcpServer({
      projectPath: projectDir,
      scope: "global",
      originalName: null,
      draft: draft(),
    });

    expect(find(view, "new-server")).toMatchObject({
      transport: "stdio",
      detail: "npx -y thing --stdio",
      envKeys: ["TOKEN"],
    });
    expect(await readJson(globalConfig())).toMatchObject({
      mcpServers: { "new-server": { command: "npx", args: ["-y", "thing", "--stdio"] } },
    });
  });

  it("creates a remote server in the workspace", async () => {
    const view = await saveMcpServer({
      projectPath: projectDir,
      scope: "project",
      originalName: null,
      draft: draft({ name: "web", transport: "http", url: "https://mcp.test/sse" }),
    });

    expect(find(view, "web")).toMatchObject({ transport: "http", detail: "https://mcp.test/sse" });
    expect(await readJson(projectConfig())).toMatchObject({
      mcpServers: { web: { url: "https://mcp.test/sse" } },
    });
  });

  it("keeps a stored secret when the field is left blank", async () => {
    await writeJson(globalConfig(), {
      mcpServers: { figma: { command: "npx", env: { FIGMA_API_KEY: "sk-stored" } } },
    });

    const view = await saveMcpServer({
      projectPath: projectDir,
      scope: "global",
      originalName: "figma",
      draft: draft({
        name: "figma",
        command: "npx",
        args: "",
        env: [{ key: "FIGMA_API_KEY", value: "" }],
      }),
    });

    expect(find(view, "figma")?.envKeys).toEqual(["FIGMA_API_KEY"]);
    expect((await readJson(globalConfig())).mcpServers.figma.env.FIGMA_API_KEY).toBe("sk-stored");
  });

  it("drops a key whose row was removed, and replaces one that was retyped", async () => {
    await writeJson(globalConfig(), {
      mcpServers: {
        figma: { command: "npx", env: { FIGMA_API_KEY: "sk-stored", OLD: "x" } },
      },
    });

    await saveMcpServer({
      projectPath: projectDir,
      scope: "global",
      originalName: "figma",
      draft: draft({
        name: "figma",
        command: "npx",
        args: "",
        env: [
          { key: "FIGMA_API_KEY", value: "sk-new" },
          { key: "ADDED", value: "y" },
        ],
      }),
    });

    expect((await readJson(globalConfig())).mcpServers.figma.env).toEqual({
      FIGMA_API_KEY: "sk-new",
      ADDED: "y",
    });
  });

  it("clears the other transport's fields when switching kind", async () => {
    await writeJson(globalConfig(), {
      mcpServers: {
        thing: { command: "old-cmd", args: ["--a"], lifecycle: "lazy" },
      },
    });

    const view = await saveMcpServer({
      projectPath: projectDir,
      scope: "global",
      originalName: "thing",
      draft: draft({ name: "thing", transport: "http", url: "https://mcp.test/http" }),
    });

    const stored = (await readJson(globalConfig())).mcpServers.thing;
    expect(stored.url).toBe("https://mcp.test/http");
    expect(stored.command).toBeUndefined();
    expect(stored.args).toBeUndefined();
    // Fields the form does not show survive an edit.
    expect(stored.lifecycle).toBe("lazy");
    expect(find(view, "thing")?.transport).toBe("http");
  });

  it("renames by moving the entry and removing the old key", async () => {
    await writeJson(globalConfig(), {
      mcpServers: { "old-name": { command: "npx", args: ["-y", "thing"] } },
    });

    const view = await saveMcpServer({
      projectPath: projectDir,
      scope: "global",
      originalName: "old-name",
      draft: draft({ name: "new-name", command: "npx", args: "-y thing" }),
    });

    const servers = (await readJson(globalConfig())).mcpServers;
    expect(Object.keys(servers)).toEqual(["new-name"]);
    expect(find(view, "old-name")).toBeUndefined();
  });

  it("rejects a stdio entry without a command and an invalid URL", async () => {
    await expect(
      saveMcpServer({
        projectPath: projectDir,
        scope: "global",
        originalName: null,
        draft: draft({ command: "", env: [] }),
      }),
    ).rejects.toBeInstanceOf(McpConfigError);

    await expect(
      saveMcpServer({
        projectPath: projectDir,
        scope: "global",
        originalName: null,
        draft: draft({ name: "bad", transport: "http", url: "ftp://x.test" }),
      }),
    ).rejects.toThrow(/http/);
  });
});

describe("deleteMcpServer", () => {
  it("removes the definition from the file that carries it", async () => {
    await writeJson(globalConfig(), { mcpServers: { gone: { command: "npx" } } });

    const view = await deleteMcpServer({ projectPath: projectDir, name: "gone" });

    expect(find(view, "gone")).toBeUndefined();
    expect((await readJson(globalConfig())).mcpServers).toEqual({});
  });

  it("refuses to touch another agent's config file", async () => {
    await writeJson(globalConfig(), { imports: ["cursor"] });

    await expect(
      deleteMcpServer({ projectPath: projectDir, name: "from-cursor" }),
    ).rejects.toThrow(/cursor/);
  });

  it("reports an unknown server instead of writing anything", async () => {
    await expect(
      deleteMcpServer({ projectPath: projectDir, name: "ghost" }),
    ).rejects.toBeInstanceOf(McpConfigError);
  });
});

describe("setMcpServerEnabled", () => {
  it("writes the workspace override the adapter's own /mcp disable writes", async () => {
    await writeJson(globalConfig(), { mcpServers: { figma: { command: "npx" } } });

    const view = await setMcpServerEnabled({
      projectPath: projectDir,
      name: "figma",
      enabled: false,
    });

    expect(find(view, "figma")?.enabled).toBe(false);
    expect(await readJson(projectPiConfig())).toMatchObject({
      mcpServers: { figma: { disabled: true } },
    });

    const reenabled = await setMcpServerEnabled({
      projectPath: projectDir,
      name: "figma",
      enabled: true,
    });
    expect(find(reenabled, "figma")?.enabled).toBe(true);
  });

  it("needs a workspace, because the override is project-local", async () => {
    await expect(
      setMcpServerEnabled({ projectPath: null, name: "figma", enabled: false }),
    ).rejects.toThrow(/工作区/);
  });
});

describe("importMcpConfigs", () => {
  it("records the imports and surfaces the imported servers", async () => {
    const view = await importMcpConfigs(projectDir, ["cursor"]);

    expect((await readJson(globalConfig())).imports).toEqual(["cursor"]);
    const imported = find(view, "from-cursor")!;
    expect(imported.hostImport).toBe(true);
    expect(imported.importKind).toBe("cursor");
    // Now that it is imported, it is no longer offered as a candidate.
    expect(view.importable).toEqual([]);
  });

  it("rejects an empty selection", async () => {
    await expect(importMcpConfigs(projectDir, [])).rejects.toBeInstanceOf(McpConfigError);
  });
});

describe("saveMcpServer argument round-tripping", () => {
  it("keeps an argument containing a space when the text was not changed", async () => {
    await writeJson(globalConfig(), {
      mcpServers: { spaced: { command: "npx", args: ["-y", "--config=/a b/c.json"] } },
    });
    const view = await readMcp(projectDir);
    const stored = find(view, "spaced")!;
    // The editor shows the joined form; saving it back untouched must not split
    // the argument that contains the space into two.
    expect(stored.args).toBe("-y --config=/a b/c.json");

    await saveMcpServer({
      projectPath: projectDir,
      scope: "global",
      originalName: "spaced",
      draft: {
        name: "spaced",
        transport: "stdio",
        command: "npx",
        args: stored.args,
        cwd: "",
        url: "",
        env: [],
        headers: [],
      },
    });

    expect((await readJson(globalConfig())).mcpServers.spaced.args).toEqual([
      "-y",
      "--config=/a b/c.json",
    ]);
  });

  it("splits a changed argument string", async () => {
    await writeJson(globalConfig(), { mcpServers: { plain: { command: "npx" } } });

    await saveMcpServer({
      projectPath: projectDir,
      scope: "global",
      originalName: "plain",
      draft: {
        name: "plain",
        transport: "stdio",
        command: "npx",
        args: "-y  thing   --stdio",
        cwd: "",
        url: "",
        env: [],
        headers: [],
      },
    });

    expect((await readJson(globalConfig())).mcpServers.plain.args).toEqual([
      "-y",
      "thing",
      "--stdio",
    ]);
  });
});
