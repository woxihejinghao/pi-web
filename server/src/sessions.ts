import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { TITLE_FALLBACK_WORDS, TITLE_MAX_BYTES } from "./config.ts";
import { getSessionOverrides } from "./projects.ts";
import type { SessionOverride } from "./store.ts";
import { clipPreview, clipTitle, fallbackTitle } from "./title-text.ts";

export type TitleSource = "session" | "firstMessage" | "fallback";

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

const PREVIEW_MAX_CHARACTERS = 200;

/**
 * A skill command, before and after pi clipped it.
 *
 * pi resolves `/skill:<name> [args]` before the message is stored, so a session
 * opened with a skill command has the skill's entire SKILL.md as its first
 * message — and would be titled with a page of someone's markdown. dsh stores
 * the literal command and shows `/git-commit`; folding pi's expansion back to
 * the same command is what keeps the list readable.
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
 * Title precedence: the session's own name, then its first user message. The
 * name is a `session_info` entry in pi's own JSONL — written by pi's `/name`,
 * by this UI (see `session-title.ts`), or by automatic titling — so the CLI
 * and the Web UI read the same fact. The fallback keeps unnamed empty sessions
 * addressable.
 *
 * The skill fold runs first and on the raw text: its pattern reads the block's
 * own line structure, which cleaning would have collapsed away.
 */
function deriveTitle(info: SessionInfo): {
  title: string;
  titleSource: TitleSource;
} {
  const sessionName = info.name?.trim();
  if (sessionName) return { title: clipTitle(sessionName, TITLE_MAX_BYTES), titleSource: "session" };

  const first = fallbackTitle(
    foldSkillCommand(info.firstMessage),
    TITLE_FALLBACK_WORDS,
    TITLE_MAX_BYTES,
  );
  if (first) return { title: first, titleSource: "firstMessage" };

  return { title: `Session ${info.id.slice(0, 8)}`, titleSource: "fallback" };
}

export function toSessionView(
  info: SessionInfo,
  override: SessionOverride | undefined,
): SessionView {
  const { title, titleSource } = deriveTitle(info);
  return {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    title,
    titleSource,
    preview: clipPreview(foldSkillCommand(info.firstMessage), PREVIEW_MAX_CHARACTERS),
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
