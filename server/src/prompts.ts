import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONTEXT_FILENAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

export interface PromptDocument {
  scope: "global" | "workspace";
  path: string;
  content: string;
  exists: boolean;
  active: boolean;
}

export interface PromptsView {
  global: PromptDocument;
  workspace: PromptDocument | null;
  workspacePath: string | null;
}

async function existingContextFile(dir: string): Promise<string | null> {
  for (const filename of CONTEXT_FILENAMES) {
    const path = join(dir, filename);
    try {
      await access(path, constants.F_OK);
      return path;
    } catch {
      // Continue through pi's candidate order.
    }
  }
  return null;
}

async function document(scope: PromptDocument["scope"], path: string, active: boolean): Promise<PromptDocument> {
  try {
    return { scope, path, content: await readFile(path, "utf8"), exists: true, active };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { scope, path, content: "", exists: false, active };
    throw error;
  }
}

export async function readPrompts(projectPath: string | null): Promise<PromptsView> {
  const agentDir = getAgentDir();
  const globalPath = await existingContextFile(agentDir);
  const global = await document("global", globalPath ?? join(agentDir, "AGENTS.md"), globalPath !== null);

  if (!projectPath) return { global, workspace: null, workspacePath: null };
  const workspaceRoot = resolve(projectPath);
  const workspacePath = await existingContextFile(workspaceRoot);
  const workspace = await document("workspace", workspacePath ?? join(workspaceRoot, "AGENTS.md"), workspacePath !== null);
  return { global, workspace, workspacePath: workspaceRoot };
}

export async function savePrompt(scope: "global" | "workspace", content: string, projectPath: string | null): Promise<PromptsView> {
  if (typeof content !== "string" || content.length > 1_000_000) {
    throw new Error("提示词内容必须是字符串且不超过 1 MB");
  }
  const view = await readPrompts(projectPath);
  const target = scope === "global" ? view.global : view.workspace;
  if (!target) throw new Error("当前没有可编辑的工作区");
  await mkdir(dirname(target.path), { recursive: true });
  await writeFile(target.path, content, "utf8");
  return readPrompts(projectPath);
}
