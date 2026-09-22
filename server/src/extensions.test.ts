import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExtensionConfigError,
  readExtensions,
  setExtensionEnabled,
} from "./extensions.ts";

/**
 * Every test points pi at a scratch agent directory, the same way the model
 * tests do: `getAgentDir()` reads `PI_CODING_AGENT_DIR` on each call, so
 * without this these writes would land in the real `~/.pi/agent`.
 *
 * The fixtures are the three shapes pi resolves: an auto-discovered file under
 * the agent dir, a directory entry point (`<name>/index.ts`), and a package
 * whose `pi.extensions` manifest points at a directory of files.
 */
let agentDir: string;
let projectDir: string;
let packageDir: string;

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function extensionFile(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "export default function () {}\n", "utf8");
}

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "piws-ext-agent-"));
  projectDir = await mkdtemp(join(tmpdir(), "piws-ext-project-"));
  packageDir = await mkdtemp(join(tmpdir(), "piws-ext-package-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  await extensionFile(join(agentDir, "extensions", "hello.ts"));
  await extensionFile(join(agentDir, "extensions", "nested", "index.ts"));
  await extensionFile(join(packageDir, "extensions", "from-package.ts"));
  await extensionFile(join(projectDir, ".pi", "extensions", "local.ts"));

  await writeJson(join(packageDir, "package.json"), {
    name: "probe-package",
    version: "1.0.0",
    pi: { extensions: ["./extensions"] },
  });
  await writeJson(join(agentDir, "settings.json"), {
    packages: [packageDir],
    extensions: [],
  });
});

afterEach(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
  await rm(packageDir, { recursive: true, force: true });
});

const byName = (view: Awaited<ReturnType<typeof readExtensions>>, name: string) =>
  view.extensions.find((entry) => entry.name === name);

describe("readExtensions", () => {
  it("lists auto-discovered files, directory entry points, and package entries", async () => {
    const view = await readExtensions(null);

    expect(view.error).toBeNull();
    expect(view.extensions.map((entry) => entry.name).sort()).toEqual([
      "hello",
      "nested",
      // The package calls itself `probe-package`; its install directory is a
      // scratch path, so the package.json name is what the row should carry.
      "probe-package",
    ]);
    expect(view.extensions.every((entry) => entry.scope === "user")).toBe(true);
    expect(view.extensions.every((entry) => entry.enabled)).toBe(true);
  });

  it("reports the package that contributed an entry, not just its path", async () => {
    const view = await readExtensions(null);
    const packaged = byName(view, "probe-package");

    expect(packaged?.origin).toBe("package");
    expect(packaged?.source).toBe(packageDir);
  });

  it("adds the workspace scope and its trust state when a project is given", async () => {
    const view = await readExtensions(projectDir);

    expect(view.projectPath).toBe(projectDir);
    expect(view.projectSettingsPath).toBe(join(projectDir, ".pi", "settings.json"));
    // Trust defaults to undecided, which pi treats as untrusted.
    expect(view.projectTrusted).toBe(false);
    const local = byName(view, "local");
    expect(local?.scope).toBe("project");
  });

  it("keeps user rows ahead of workspace rows", async () => {
    const view = await readExtensions(projectDir);
    const scopes = view.extensions.map((entry) => entry.scope);
    expect(scopes.indexOf("project")).toBeGreaterThan(scopes.lastIndexOf("user"));
  });
});

describe("setExtensionEnabled", () => {
  it("disables an auto-discovered extension with pi's override pattern", async () => {
    const view = await readExtensions(null);
    const target = byName(view, "hello")!;

    const next = await setExtensionEnabled({
      projectPath: null,
      path: target.path,
      enabled: false,
    });

    expect(byName(next, "hello")?.enabled).toBe(false);
    // Relative to the agent dir, which is what pi's matcher compares against.
    expect(await readJson(join(agentDir, "settings.json"))).toMatchObject({
      extensions: ["-extensions/hello.ts"],
    });

    // And what pi itself resolves agrees with what we reported.
    expect((await readExtensions(null)).extensions.find((e) => e.path === target.path)?.enabled)
      .toBe(false);
  });

  it("replaces the previous pattern instead of stacking one", async () => {
    const target = byName(await readExtensions(null), "hello")!;

    await setExtensionEnabled({ projectPath: null, path: target.path, enabled: false });
    await setExtensionEnabled({ projectPath: null, path: target.path, enabled: true });

    const settings = await readJson(join(agentDir, "settings.json"));
    expect(settings.extensions).toEqual(["+extensions/hello.ts"]);
    expect(byName(await readExtensions(null), "hello")?.enabled).toBe(true);
  });

  it("disables a package entry inside the package's object form", async () => {
    const target = byName(await readExtensions(null), "probe-package")!;

    const next = await setExtensionEnabled({
      projectPath: null,
      path: target.path,
      enabled: false,
    });

    expect(next.extensions.find((entry) => entry.path === target.path)?.enabled).toBe(false);
    expect(await readJson(join(agentDir, "settings.json"))).toMatchObject({
      packages: [
        {
          source: packageDir,
          extensions: ["-extensions/from-package.ts"],
        },
      ],
    });
  });

  it("rejects an unknown path rather than writing a stale pattern", async () => {
    await expect(
      setExtensionEnabled({ projectPath: null, path: join(agentDir, "nope.ts"), enabled: false }),
    ).rejects.toBeInstanceOf(ExtensionConfigError);
  });

  it("refuses to write project settings for an untrusted workspace", async () => {
    const target = byName(await readExtensions(projectDir), "local")!;

    await expect(
      setExtensionEnabled({ projectPath: projectDir, path: target.path, enabled: false }),
    ).rejects.toBeInstanceOf(ExtensionConfigError);
  });

  it("writes project settings once the workspace is trusted", async () => {
    // Trust keys are canonicalized, and `mkdtemp` hands back a path under a
    // symlinked temp root on macOS; without `realpath` pi would not match it.
    await writeJson(join(agentDir, "trust.json"), { [await realpath(projectDir)]: true });
    const view = await readExtensions(projectDir);
    expect(view.projectTrusted).toBe(true);
    const target = byName(view, "local")!;

    const next = await setExtensionEnabled({
      projectPath: projectDir,
      path: target.path,
      enabled: false,
    });

    expect(next.extensions.find((entry) => entry.path === target.path)?.enabled).toBe(false);
    expect(await readJson(join(projectDir, ".pi", "settings.json"))).toMatchObject({
      extensions: ["-extensions/local.ts"],
    });
  });
});
