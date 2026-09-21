import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { getSessionOverrides } from "./projects.ts";
import type { SessionOverride } from "./store.ts";

export type TitleSource = "override" | "session" | "firstMessage" | "fallback";

export interface SessionView {
  /** Absolute path of pi's JSONL session file. Serves as the session identity. */
  path: string;
  id: string;
  cwd: string;
  title: string;
  titleSource: TitleSource;
  /** First user message, collapsed and clipped; empty when the session has none. */
  preview: string;
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  hidden: boolean;
}

const TITLE_MAX = 80;
const PREVIEW_MAX = 200;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A skill command, before and after pi clipped it.
 *
 * pi resolves `/skill:<name> [args]` before the message is stored, so a session
 * opened with a skill command has the skill's entire SKILL.md as its first
 * message — and would be titled with 80 characters of someone's markdown. dsh
 * stores the literal command and shows `/git-commit`; folding pi's expansion
 * back to the same command is what keeps the list readable.
 */
const SKILL_BLOCK =
  /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;
/** The same block once it has been clipped to a title or preview length. */
const SKILL_PREFIX = /^<skill name="([^"]+)"/;

function foldSkillCommand(text: string): string {
  const block = SKILL_BLOCK.exec(text);
  const name = block?.[1] ?? SKILL_PREFIX.exec(text)?.[1];
  if (name === undefined) return text;
  const args = block?.[2]?.trim();
  return args ? `/skill:${name} ${args}` : `/skill:${name}`;
}

/**
 * Title precedence: an explicit UI rename, then pi's own `/name`, then the
 * first user message. The fallback keeps unnamed empty sessions addressable.
 */
function deriveTitle(info: SessionInfo, override: SessionOverride | undefined): {
  title: string;
  titleSource: TitleSource;
} {
  const overrideName = override?.name?.trim();
  if (overrideName) return { title: clip(overrideName, TITLE_MAX), titleSource: "override" };

  const sessionName = info.name?.trim();
  if (sessionName) return { title: clip(sessionName, TITLE_MAX), titleSource: "session" };

  const first = collapse(foldSkillCommand(info.firstMessage));
  if (first) return { title: clip(first, TITLE_MAX), titleSource: "firstMessage" };

  return { title: `Session ${info.id.slice(0, 8)}`, titleSource: "fallback" };
}

export function toSessionView(
  info: SessionInfo,
  override: SessionOverride | undefined,
): SessionView {
  const { title, titleSource } = deriveTitle(info, override);
  return {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    title,
    titleSource,
    preview: clip(collapse(foldSkillCommand(info.firstMessage)), PREVIEW_MAX),
    parentSessionPath: info.parentSessionPath,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    hidden: override?.hidden === true,
  };
}

export interface ListSessionsOptions {
  /** Override pi's session storage root. Tests use this to stay hermetic. */
  sessionDir?: string;
  includeHidden?: boolean;
  signal?: AbortSignal;
}

/**
 * Sessions for a project are derived from pi's own storage rather than
 * mirrored into our store, so the Web UI and the `pi` CLI always agree.
 * Ordering is "last updated", matching dsh's default session view.
 */
export async function listSessions(
  projectPath: string,
  options: ListSessionsOptions = {},
): Promise<SessionView[]> {
  const [infos, overrides] = await Promise.all([
    SessionManager.list(projectPath, options.sessionDir, undefined, options.signal),
    getSessionOverrides(),
  ]);

  const views = infos.map((info) => toSessionView(info, overrides[info.path]));
  const visible = options.includeHidden ? views : views.filter((view) => !view.hidden);
  return visible.sort((a, b) => b.modified.localeCompare(a.modified));
}
