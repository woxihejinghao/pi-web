import { describe, expect, it } from "vitest";
import { translator } from "../../lib/i18n/index.ts";
import type { McpServerView, McpView } from "../../lib/types.ts";
import { filterServers, scopeLabel as scopeLabelOf } from "./mcp-model.ts";

// These assertions pin the Chinese wording, so the translator is passed in
// rather than resolved from whatever locale the test host happens to have.
const zh = translator("zh-CN");
const scopeLabel = (server: Parameters<typeof scopeLabelOf>[0]): string =>
  scopeLabelOf(server, zh);

function server(overrides: Partial<McpServerView> & { name: string }): McpServerView {
  return {
    transport: "stdio",
    detail: "npx -y thing",
    command: "npx",
    args: "-y thing",
    cwd: null,
    url: null,
    envKeys: [],
    headerKeys: [],
    auth: "none",
    enabled: true,
    sourcePath: "/home/u/.pi/agent/mcp.json",
    sourceKind: "user",
    ...overrides,
  };
}

function view(servers: McpServerView[]): McpView {
  return {
    agentDir: "/home/u/.pi/agent",
    projectPath: "/work/repo",
    servers,
    errors: [],
    paths: {
      global: "/home/u/.pi/agent/mcp.json",
      project: "/work/repo/.pi/mcp.json",
    },
    error: null,
  };
}

describe("filterServers", () => {
  const inventory = view([
    server({ name: "global-a" }),
    server({ name: "workspace-b", sourceKind: "project", enabled: false }),
  ]);

  it("keeps everything with both filters on 全部", () => {
    expect(filterServers(inventory, "all", "all").map((s) => s.name)).toEqual([
      "global-a",
      "workspace-b",
    ]);
  });

  it("filters by scope and by state independently", () => {
    expect(filterServers(inventory, "project", "all").map((s) => s.name)).toEqual([
      "workspace-b",
    ]);
    expect(filterServers(inventory, "all", "disabled").map((s) => s.name)).toEqual([
      "workspace-b",
    ]);
    expect(filterServers(inventory, "all", "enabled").map((s) => s.name)).toEqual([
      "global-a",
    ]);
  });

  it("returns nothing before the inventory loads", () => {
    expect(filterServers(null, "all", "all")).toEqual([]);
  });
});

describe("scopeLabel", () => {
  it("names the layer a definition comes from", () => {
    expect(scopeLabel(server({ name: "a" }))).toBe("全局");
    expect(scopeLabel(server({ name: "b", sourceKind: "project" }))).toBe("当前工作区");
  });
});
