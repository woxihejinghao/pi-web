import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  McpConfigError,
  deleteMcpServer,
  readMcp,
  saveMcpServer,
  setMcpServerEnabled,
} from "./mcp.ts";

/**
 * These tests write real `mcp.json` files into a throwaway agent dir, because
 * that is exactly what the module reads: pi's own two config files, with no
 * extension in between. `PI_CODING_AGENT_DIR` repoints the user layer, and the
 * project layer lives under the temp workspace.
 */
let agentDir: string;
let projectDir: string;

const globalConfig = () => join(agentDir, "mcp.json");
const projectConfig = () => join(projectDir, ".pi", "mcp.json");

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
});

afterAll(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(globalConfig(), { force: true });
  await rm(join(projectDir, ".pi"), { recursive: true, force: true });
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
          url: "https://mcp.example.test/mcp",
          headers: { "X-Key": "sk-header-secret" },
        },
      },
    });

    const view = await readMcp(projectDir);
    expect(view.error).toBeNull();

    const figma = find(view, "figma")!;
    expect(figma.transport).toBe("stdio");
    expect(figma.detail).toBe("npx -y figma-developer-mcp --stdio");
    // Names, never values.
    expect(figma.envKeys).toEqual(["FIGMA_API_KEY"]);
    expect(figma.auth).toBe("none");

    const remote = find(view, "remote")!;
    expect(remote.transport).toBe("http");
    expect(remote.headerKeys).toEqual(["X-Key"]);
    // Without an Authorization header, pi signs in over OAuth on 401.
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
    expect(find(view, "shared")?.sourcePath).toBe(globalConfig());
    expect(find(view, "local")?.sourceKind).toBe("project");
    expect(find(view, "local")?.sourcePath).toBe(projectConfig());
  });

  it("lets a workspace entry that only names override keys change state, not the definition", async () => {
    await writeJson(globalConfig(), {
      mcpServers: { figma: { command: "npx", env: { KEY: "stored" } } },
    });
    await writeJson(projectConfig(), { mcpServers: { figma: { enabled: false } } });

    const view = await readMcp(projectDir);
    const figma = find(view, "figma")!;
    expect(figma.enabled).toBe(false);
    // The definition still comes from the user layer, credentials included.
    expect(figma.command).toBe("npx");
    expect(figma.envKeys).toEqual(["KEY"]);
    expect(view.errors).toEqual([]);
  });

  it("surfaces unreadable and invalid entries instead of hiding them", async () => {
    await writeJson(globalConfig(), {
      mcpServers: {
        ok: { command: "npx" },
        "bad name": { command: "npx" },
        empty: {},
      },
    });
    await mkdir(dirname(projectConfig()), { recursive: true });
    await writeFile(projectConfig(), "{ this is not json", "utf8");
    const view = await readMcp(projectDir);
    expect(find(view, "ok")).toBeDefined();
    expect(view.errors.some((message) => message.includes("bad name"))).toBe(true);
    expect(view.errors.some((message) => message.includes("empty"))).toBe(true);
    expect(view.errors.some((message) => message.includes("不是标准 JSON"))).toBe(true);
  });

  it("rejects two names that would share a tool namespace", async () => {
    await writeJson(globalConfig(), {
      mcpServers: { "my-server": { command: "a" }, my_server: { command: "b" } },
    });

    const view = await readMcp(projectDir);
    expect(view.servers.map((server) => server.name)).toEqual(["my-server"]);
    expect(view.errors.some((message) => message.includes("命名空间"))).toBe(true);
  });

  it("reports a workspace override with nothing to override", async () => {
    await writeJson(projectConfig(), { mcpServers: { ghost: { enabled: false } } });

    const view = await readMcp(projectDir);
    expect(find(view, "ghost")).toBeUndefined();
    expect(view.errors.some((message) => message.includes("ghost"))).toBe(true);
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
      draft: draft({ name: "web", transport: "http", url: "https://mcp.test/mcp" }),
    });

    expect(find(view, "web")).toMatchObject({ transport: "http", detail: "https://mcp.test/mcp" });
    expect(await readJson(projectConfig())).toMatchObject({
      mcpServers: { web: { url: "https://mcp.test/mcp" } },
    });
  });

  it("needs a workspace before it can write the project layer", async () => {
    await expect(
      saveMcpServer({
        projectPath: null,
        scope: "project",
        originalName: null,
        draft: draft(),
      }),
    ).rejects.toThrow(/工作区/);
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

  it("keeps skipping values when editing a layer other than the one that carries the secret", async () => {
    await writeJson(globalConfig(), {
      mcpServers: { figma: { command: "npx", env: { FIGMA_API_KEY: "sk-stored" } } },
    });

    await saveMcpServer({
      projectPath: projectDir,
      scope: "project",
      originalName: "figma",
      draft: draft({
        name: "figma",
        command: "npx",
        args: "",
        env: [{ key: "FIGMA_API_KEY", value: "" }],
      }),
    });

    // The workspace copy carries the key forward rather than dropping it.
    expect((await readJson(projectConfig())).mcpServers.figma.env.FIGMA_API_KEY).toBe("sk-stored");
  });

  it("clears the other transport's fields when switching kind", async () => {
    await writeJson(globalConfig(), {
      mcpServers: {
        thing: { command: "old-cmd", args: ["--a"], exposure: "direct", timeout: 30 },
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
    expect(stored.exposure).toBe("direct");
    expect(stored.timeout).toBe(30);
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

  it("rejects a stdio entry without a command, an invalid URL, and a bad name", async () => {
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

    // pi's server names allow letters, digits, `_`, and `-` only.
    await expect(
      saveMcpServer({
        projectPath: projectDir,
        scope: "global",
        originalName: null,
        draft: draft({ name: "with.dot" }),
      }),
    ).rejects.toThrow(/名称/);
  });
});

describe("deleteMcpServer", () => {
  it("removes the definition from the file that carries it", async () => {
    await writeJson(globalConfig(), { mcpServers: { gone: { command: "npx" } } });

    const view = await deleteMcpServer({ projectPath: projectDir, name: "gone" });

    expect(find(view, "gone")).toBeUndefined();
    expect((await readJson(globalConfig())).mcpServers).toEqual({});
  });

  it("removes a workspace override and re-exposes the user-level definition", async () => {
    await writeJson(globalConfig(), { mcpServers: { figma: { command: "npx" } } });
    await writeJson(projectConfig(), { mcpServers: { figma: { enabled: false } } });

    const view = await deleteMcpServer({ projectPath: projectDir, name: "figma" });

    // The row is back, enabled, and sourced from the user layer — which is what
    // deleting an override really means.
    expect(find(view, "figma")?.enabled).toBe(true);
    expect(find(view, "figma")?.sourceKind).toBe("user");
    expect((await readJson(projectConfig())).mcpServers).toEqual({});
  });

  it("reports an unknown server instead of writing anything", async () => {
    await expect(
      deleteMcpServer({ projectPath: projectDir, name: "ghost" }),
    ).rejects.toBeInstanceOf(McpConfigError);
  });
});

describe("setMcpServerEnabled", () => {
  it("writes a workspace entry for a user-level server", async () => {
    await writeJson(globalConfig(), { mcpServers: { figma: { command: "npx" } } });

    const view = await setMcpServerEnabled({
      projectPath: projectDir,
      name: "figma",
      enabled: false,
    });

    expect(find(view, "figma")?.enabled).toBe(false);
    expect(await readJson(projectConfig())).toMatchObject({
      mcpServers: { figma: { enabled: false } },
    });
    // The user-level definition is untouched.
    expect((await readJson(globalConfig())).mcpServers.figma).toEqual({ command: "npx" });
  });

  it("edits a workspace definition in place and drops a redundant enabled flag", async () => {
    await writeJson(globalConfig(), { mcpServers: { figma: { command: "npx" } } });
    await writeJson(projectConfig(), {
      mcpServers: { figma: { command: "npx", args: ["-y", "thing"] } },
    });

    await setMcpServerEnabled({ projectPath: projectDir, name: "figma", enabled: false });
    expect((await readJson(projectConfig())).mcpServers.figma.enabled).toBe(false);

    await setMcpServerEnabled({ projectPath: projectDir, name: "figma", enabled: true });
    // `enabled: true` on a full definition is the default, so the key goes away.
    expect((await readJson(projectConfig())).mcpServers.figma.enabled).toBeUndefined();
  });

  it("needs a workspace, because the state is project-local", async () => {
    await expect(
      setMcpServerEnabled({ projectPath: null, name: "figma", enabled: false }),
    ).rejects.toThrow(/工作区/);
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
