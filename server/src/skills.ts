import { basename, join, relative } from "node:path";
import { readFile } from "node:fs/promises";
import {
  DefaultPackageManager, ProjectTrustStore, SettingsManager, getAgentDir, loadSkills,
} from "@earendil-works/pi-coding-agent";
import { noProjectCwd } from "./config.ts";
import { badRequest } from "./errors.ts";

export interface SkillItem {
  name: string;
  description: string;
  path: string;
  scope: "user" | "project";
  enabled: boolean;
  content: string;
  source: string;
}
export interface SkillsView {
  agentDir: string;
  projectPath: string | null;
  projectTrusted: boolean;
  skillsPath: string;
  projectSkillsPath: string | null;
  skills: SkillItem[];
  error: string | null;
}

async function resolveSkills(projectPath: string | null) {
  const agentDir = getAgentDir();
  const cwd = projectPath ?? noProjectCwd();
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const resolved = await manager.resolve(async () => "skip");
  return { agentDir, cwd, settings, resources: resolved.skills };
}

export async function readSkills(projectPath: string | null): Promise<SkillsView> {
  const agentDir = getAgentDir();
  const base = {
    agentDir, projectPath,
    projectTrusted: projectPath !== null && new ProjectTrustStore(agentDir).get(projectPath) === true,
    skillsPath: join(agentDir, "skills"),
    projectSkillsPath: projectPath ? join(projectPath, ".pi", "skills") : null,
  };
  try {
    const { cwd, resources } = await resolveSkills(projectPath);
    const skills = await Promise.all(resources.map(async (resource): Promise<SkillItem> => {
      const result = loadSkills({ cwd, agentDir, includeDefaults: false, skillPaths: [resource.path] });
      const skill = result.skills[0];
      const path = skill?.filePath ?? resource.path;
      return {
        name: skill?.name ?? basename(resource.path),
        description: skill?.description ?? result.diagnostics.map((d) => d.message).join("; "),
        path: resource.path,
        scope: resource.metadata.scope === "project" ? "project" : "user",
        enabled: resource.enabled,
        content: await readFile(path, "utf8").catch((err: Error) => err.message),
        source: resource.metadata.source,
      };
    }));
    return { ...base, skills, error: null };
  } catch (err) {
    return { ...base, skills: [], error: (err as Error).message };
  }
}

export async function readSkill(path: string, projectPath: string | null): Promise<SkillItem> {
  const view = await readSkills(projectPath);
  const skill = view.skills.find((item) => item.path === path);
  if (!skill) throw badRequest("没有找到这个 skill，可能已被删除或路径已改变。");
  return skill;
}

function override(patterns: string[], pattern: string, enabled: boolean): string[] {
  return [...patterns.filter((p) => p.replace(/^[!+-]/, "") !== pattern), `${enabled ? "+" : "-"}${pattern}`];
}

/** Use pi config's resource filters; third-party SKILL.md files remain untouched. */
export async function setSkillEnabled(input: {
  path: string; projectPath: string | null; enabled: boolean;
}): Promise<SkillsView> {
  const { agentDir, cwd, settings, resources } = await resolveSkills(input.projectPath);
  const target = resources.find((resource) => resource.path === input.path);
  if (!target) throw badRequest("没有找到这个 skill。");
  const project = target.metadata.scope === "project";
  if (project && new ProjectTrustStore(agentDir).get(cwd) !== true) {
    throw badRequest("这个工作区尚未被信任，无法改写它的 .pi 设置。");
  }
  const baseDir = target.metadata.baseDir ?? (project ? join(cwd, ".pi") : agentDir);
  const pattern = relative(baseDir, target.path);
  if (target.metadata.origin === "package") {
    const packages = [...settings.getPackages()];
    const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === target.metadata.source);
    if (index < 0) throw badRequest("没有找到这个 skill 所属的包。");
    const entry = packages[index]!;
    const object = typeof entry === "string" ? { source: entry } : { ...entry };
    object.skills = override(object.skills ?? [], pattern, input.enabled);
    packages[index] = object;
    if (project) settings.setProjectPackages(packages);
    else settings.setPackages(packages);
  } else {
    const current = (project ? settings.getProjectSettings() : settings.getGlobalSettings()).skills ?? [];
    const updated = override(current, pattern, input.enabled);
    if (project) settings.setProjectSkillPaths(updated);
    else settings.setSkillPaths(updated);
  }
  await settings.flush();
  return readSkills(input.projectPath);
}
