import { describe, expect, it } from "vitest";
import type { ExtensionItem, ExtensionsView } from "../../lib/types.ts";
import { extensionSourceLabel, groupExtensions } from "./plugin-model.ts";

function item(overrides: Partial<ExtensionItem> & { path: string }): ExtensionItem {
  return {
    name: overrides.path.split("/").pop() ?? overrides.path,
    source: "auto",
    scope: "user",
    origin: "top-level",
    enabled: true,
    ...overrides,
  };
}

function view(extensions: ExtensionItem[]): ExtensionsView {
  return {
    agentDir: "/home/u/.pi/agent",
    settingsPath: "/home/u/.pi/agent/settings.json",
    projectPath: "/work/repo",
    projectSettingsPath: "/work/repo/.pi/settings.json",
    projectTrusted: true,
    extensions,
    error: null,
  };
}

describe("groupExtensions", () => {
  it("splits rows by scope and keeps their order", () => {
    const groups = groupExtensions(
      view([
        item({ path: "/home/u/.pi/agent/extensions/a.ts", name: "a" }),
        item({ path: "/work/repo/.pi/extensions/b.ts", name: "b", scope: "project" }),
        item({ path: "/home/u/.pi/agent/extensions/c.ts", name: "c" }),
      ]),
      "",
    );

    expect(groups.user.map((entry) => entry.name)).toEqual(["a", "c"]);
    expect(groups.project.map((entry) => entry.name)).toEqual(["b"]);
  });

  it("returns empty groups before the inventory loads", () => {
    expect(groupExtensions(null, "")).toEqual({ user: [], project: [] });
  });

  it("matches the label, the path, and the source", () => {
    const inventory = view([
      item({ path: "/home/u/.pi/agent/extensions/hello.ts", name: "hello" }),
      item({
        path: "/home/u/.pi/agent/npm/node_modules/pi-subagents/index.js",
        name: "pi-subagents",
        source: "npm:pi-subagents",
        origin: "package",
      }),
    ]);

    expect(groupExtensions(inventory, "HELLO").user).toHaveLength(1);
    // The label was renamed by the user; the file name still finds it.
    expect(groupExtensions(inventory, "hello.ts").user).toHaveLength(1);
    // A package is found by its source even though the label is a name.
    expect(groupExtensions(inventory, "npm:pi-subagents").user).toHaveLength(1);
    expect(groupExtensions(inventory, "nothing").user).toEqual([]);
  });

  it("ignores surrounding whitespace in the query", () => {
    const inventory = view([item({ path: "/x/hello.ts", name: "hello" })]);
    expect(groupExtensions(inventory, "  hello  ").user).toHaveLength(1);
  });
});

describe("extensionSourceLabel", () => {
  it("names the contributor in the terms the row can act on", () => {
    expect(
      extensionSourceLabel(item({ path: "/x/a.ts", origin: "package", source: "npm:a" })),
    ).toBe("pi 包");
    expect(extensionSourceLabel(item({ path: "/x/a.ts", source: "auto" }))).toBe("自动发现");
    expect(extensionSourceLabel(item({ path: "/x/a.ts", source: "local" }))).toBe("本地路径");
    // Anything else is shown as-is rather than guessed at.
    expect(extensionSourceLabel(item({ path: "/x/a.ts", source: "/opt/team/ext" }))).toBe(
      "/opt/team/ext",
    );
  });
});
