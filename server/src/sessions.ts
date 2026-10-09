import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * A session as it comes off the file: everything but `hidden`, which belongs to
 * this UI's store rather than to pi's log and is applied per read.
 */
type DerivedSessionView = Omit<SessionView, "hidden">;

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

function toDerivedView(info: SessionInfo): DerivedSessionView {
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
  };
}

export function toSessionView(
  info: SessionInfo,
  override: SessionOverride | undefined,
): SessionView {
  return { ...toDerivedView(info), hidden: override?.hidden === true };
}

interface SessionCacheEntry {
  /** Fingerprint of the files this entry was parsed from. */
  signature: string;
  /** Newest first, the order `SessionManager.list` hands back. */
  views: DerivedSessionView[];
}

/**
 * Parsed session metadata, keyed by the session directory and the project it
 * was read for.
 *
 * Listing a workspace costs it its whole history, not the handful of rows the
 * sidebar draws: pi streams every JSONL file in the directory to count messages
 * and pick out the first user message. Re-reading all of them on every expand
 * is what made a workspace with hundreds of sessions feel slow, so the parsed
 * result is kept until the directory actually moves.
 */
const sessionCache = new Map<string, SessionCacheEntry>();

/**
 * How many files are stat-ed at once while fingerprinting a directory.
 *
 * A workspace can hold thousands of sessions, and an unbounded fan-out would
 * ask the OS for thousands of descriptors at the same moment.
 */
const SIGNATURE_CONCURRENCY = 64;

/**
 * What the directory looked like when its sessions were parsed: the name, size
 * and mtime of every JSONL file in it, or null when the directory does not
 * exist (which is "no sessions" — the same answer pi gives).
 *
 * `SessionManager.list` reads each file top to bottom, so a directory whose
 * files have not moved cannot have a different answer. Stat-ing them costs a
 * fraction of streaming them, which is why this runs on every request instead
 * of trusting the file watcher: one missed event would otherwise pin a stale
 * list for as long as the process lives.
 */
async function directorySignature(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return null;
  }
  const stamps: string[] = [];
  for (let index = 0; index < names.length; index += SIGNATURE_CONCURRENCY) {
    const batch = names.slice(index, index + SIGNATURE_CONCURRENCY);
    stamps.push(
      ...(await Promise.all(
        batch.map(async (name) => {
          try {
            const info = await stat(join(dir, name));
            return `${name}|${info.size}|${info.mtimeMs}`;
          } catch {
            return `${name}|gone`;
          }
        }),
      )),
    );
  }
  return stamps.join("\n");
}

/** Parsed sessions for one directory, served from the cache when nothing moved. */
async function deriveSessions(
  projectPath: string,
  options: ListSessionsOptions,
): Promise<DerivedSessionView[]> {
  const dir = options.sessionDir;
  // Only the explicit per-project directory gets a cache entry: pi's own default
  // layout is a different shape, and the server always names the directory it
  // wants (see `session-path.ts`).
  if (dir === undefined) {
    const infos = await SessionManager.list(projectPath, undefined, undefined, options.signal);
    return infos.map(toDerivedView);
  }

  const signature = await directorySignature(dir);
  if (signature === null) return [];

  // Keyed by the pair, not the directory alone: the answer is filtered by the
  // project's own cwd, so two projects pointed at one directory must not share
  // an entry.
  const key = `${dir}\n${projectPath}`;
  const cached = sessionCache.get(key);
  if (cached !== undefined && cached.signature === signature) return cached.views;

  const infos = await SessionManager.list(projectPath, dir, undefined, options.signal);
  const views = infos.map(toDerivedView).sort((a, b) => b.modified.localeCompare(a.modified));
  sessionCache.set(key, { signature, views });
  return views;
}

export interface ListSessionsOptions {
  /** Override pi's session storage root. Tests use this to stay hermetic. */
  sessionDir?: string;
  includeHidden?: boolean;
  /** How many visible sessions to return, newest first. Omitted means all. */
  limit?: number;
  /**
   * A session path that must be in the result even when it sorts past `limit`.
   *
   * The sidebar draws one page of rows but still needs the metadata of the
   * conversation on screen; without this, an old session opened from elsewhere
   * would have no title until the user paged down to it.
   */
  focus?: string;
  signal?: AbortSignal;
}

/** One page of a workspace's sessions, and how many the workspace has. */
export interface SessionListPage {
  sessions: SessionView[];
  /** Visible sessions before `limit` narrowed the list. */
  total: number;
}

/**
 * Sessions for a project are derived from pi's own storage rather than
 * mirrored into our store, so the Web UI and the `pi` CLI always agree.
 * Ordering is "last updated", matching dsh's default session view.
 *
 * A page and its total come back together because the sidebar needs both: it
 * draws a handful of rows and offers the rest behind "show more", so the count
 * is what it labels that button with, and it never has to hold the whole list.
 */
export async function listSessions(
  projectPath: string,
  options: ListSessionsOptions = {},
): Promise<SessionListPage> {
  const [derived, overrides] = await Promise.all([
    deriveSessions(projectPath, options),
    getSessionOverrides(),
  ]);

  const views = derived.map((view) => ({
    ...view,
    hidden: overrides[view.path]?.hidden === true,
  }));
  const visible = options.includeHidden === true ? views : views.filter((view) => !view.hidden);

  const sessions = options.limit === undefined ? visible : visible.slice(0, options.limit);
  const focus = options.focus;
  if (options.limit !== undefined && focus !== undefined) {
    // The open conversation stays addressable whichever page the sidebar shows.
    if (!sessions.some((view) => view.path === focus)) {
      const found = visible.find((view) => view.path === focus);
      if (found !== undefined) sessions.push(found);
    }
  }
  return { sessions, total: visible.length };
}
