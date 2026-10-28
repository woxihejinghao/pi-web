import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { readSkills, setSkillEnabled } from "./skills.ts";

let root: string;
let previous: string | undefined;
const content = (name: string) => `---\nname: ${name}\ndescription: A useful skill\n---\n\n# Instructions\nRead the input.\n`;
async function skill(base: string, name: string) {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content(name));
}
beforeEach(async () => {
  previous = process.env.PI_CODING_AGENT_DIR;
  root = await mkdtemp(join(tmpdir(), "piws-skills-"));
  process.env.PI_CODING_AGENT_DIR = root;
  await skill(join(root, "skills"), "local-skill");
  await skill(join(root, "package", "skills"), "package-skill");
  await writeFile(join(root, "package", "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", pi: { skills: ["./skills"] } }));
  await writeFile(join(root, "settings.json"), JSON.stringify({ packages: [join(root, "package")] }));
});
afterEach(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
});
describe("skills management", () => {
  it("lists discovered and packaged skills with their content", async () => {
    const view = await readSkills(null);
    expect(view.error).toBeNull();
    const fixtures = view.skills.filter((s) => s.path.startsWith(root));
    expect(fixtures.map((s) => s.name).sort()).toEqual(["local-skill", "package-skill"]);
    expect(fixtures.every((s) => s.content.includes("# Instructions"))).toBe(true);
  });
  it.each(["local-skill", "package-skill"])("toggles %s through settings without rewriting sources", async (name) => {
    const item = (await readSkills(null)).skills.find((s) => s.name === name)!;
    expect(item).toBeDefined();
    const disabled = await setSkillEnabled({ path: item.path, projectPath: null, enabled: false });
    expect(disabled.skills.find((s) => s.path === item.path)?.enabled).toBe(false);
    const enabled = await setSkillEnabled({ path: item.path, projectPath: null, enabled: true });
    expect(enabled.skills.find((s) => s.path === item.path)?.enabled).toBe(true);
    const file = item.path.endsWith(".md") ? item.path : join(item.path, "SKILL.md");
    expect(await readFile(file, "utf8")).toBe(content(name));
  });
  it("lists workspace skills but only changes trusted workspace settings", async () => {
    const project = join(root, "workspace");
    await skill(join(project, ".pi", "skills"), "workspace-skill");
    const view = await readSkills(project);
    const item = view.skills.find((s) => s.name === "workspace-skill")!;
    expect(item.scope).toBe("project");
    expect(view.projectTrusted).toBe(false);
    await expect(setSkillEnabled({ path: item.path, projectPath: project, enabled: false })).rejects.toThrow();
    new ProjectTrustStore(root).set(project, true);
    const updated = await setSkillEnabled({ path: item.path, projectPath: project, enabled: false });
    expect(updated.skills.find((s) => s.path === item.path)?.enabled).toBe(false);
    expect(JSON.parse(await readFile(join(project, ".pi", "settings.json"), "utf8"))).toHaveProperty("skills");
    expect((await readSkills(null)).skills.some((s) => s.name === "workspace-skill")).toBe(false);
  });
  it("rejects paths that were not in the inventory", async () => {
    await expect(setSkillEnabled({ path: "/tmp/arbitrary.md", projectPath: null, enabled: false })).rejects.toThrow();
  });
});
