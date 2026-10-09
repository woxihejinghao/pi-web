import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { STORE_FILE } from "./config.ts";

/**
 * A named, ordered project: the canonical path of a local directory the user
 * works in. Mirrors deepseek-harness's `Workspace` identity rule — path
 * uniqueness is string equality of the canonicalized path, and the id is a
 * generated uuid that survives path rewrites.
 */
export interface ProjectRecord {
  id: string;
  /** Canonical absolute path (`fs.realpath`): symlinks, `..`, trailing slashes resolved. */
  path: string;
  /** Display title. Defaults to the final path segment. Duplicates allowed. */
  title: string;
  /** Persisted ordering key, always rewritten to the array index on save. */
  order: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * UI-only state for a session, keyed by absolute session file path.
 *
 * `hidden` is the only field still written. A rename goes into pi's own JSONL
 * instead (see `session-title.ts`), so the CLI and this UI agree about a
 * session's name. A `name` left behind by an older store is still parsed — the
 * one-time migration reads it to move the name into the session file — but it
 * no longer decides any title.
 */
export interface SessionOverride {
  /** Legacy: read only, and only so a pre-migration rename can be moved out. */
  name?: string;
  hidden?: boolean;
}

/** What a caller may still write; the rename half moved into pi's own file. */
export type SessionOverrideInput = Omit<SessionOverride, "name">;

export interface StoreData {
  version: 1;
  projects: ProjectRecord[];
  sessionOverrides: Record<string, SessionOverride>;
  /** Shell-wide preferences owned by this Web UI (never written into pi's config). */
  settings: WebSettings;
}

/** Appearance preference; `system` follows the OS colour scheme. */
export type AppearancePreference = "light" | "dark" | "system";

/**
 * UI language. `system` follows the host locale: a Chinese host gets Chinese
 * and everything else English, so the default never fights the machine the UI
 * is running on.
 */
export type LanguagePreference = "system" | "zh-CN" | "en";

/**
 * How completed turns present their process content (thinking + tool calls).
 * Ported from dsh's `ui-chat` transcript-view setting, which offers four modes:
 *
 * - `compact` folds a finished turn behind its completion header and hides a
 *   settled reasoning row's one-line summary (dsh's `settledReasoningPreview`).
 * - `standard` folds too, but keeps that summary.
 * - `detailed` is dsh's own default; here it presents the same as `standard`
 *   until this UI grows dsh's per-step grouping, which is the only thing that
 *   tells the two apart upstream.
 * - `verbose` is the only mode that does not fold a finished turn.
 */
export type TranscriptDisplay = "compact" | "standard" | "detailed" | "verbose";

/** Saved modes from dsh's older generations; both read as `detailed`. */
const LEGACY_TRANSCRIPT_VALUES: readonly string[] = ["normal", "expanded"];

/**
 * What Enter does while the agent is running. `queue` waits for the run to
 * settle (pi's `followUp`); `steer` cuts in after the current tool calls
 * (pi's `steer`). Cmd/Ctrl+Enter always uses the other one, which is why this
 * is a preference rather than a per-message toggle.
 */
export type BusySendBehavior = "queue" | "steer";

const APPEARANCE_VALUES: readonly AppearancePreference[] = ["light", "dark", "system"];
const TRANSCRIPT_VALUES: readonly TranscriptDisplay[] = ["compact", "standard", "detailed", "verbose"];
const LANGUAGE_VALUES: readonly LanguagePreference[] = ["system", "zh-CN", "en"];
const BUSY_SEND_VALUES: readonly BusySendBehavior[] = ["queue", "steer"];

/**
 * Conversation content font size bounds, copied from dsh's theme schema
 * (`Schema.number().step(1).min(12).max(17).default(14)`). The range is dsh's;
 * the default is not: this project starts at 15 while upstream dsh starts at
 * 14. Out-of-range values
 * are rejected rather than clamped: silently showing a different number than
the user typed is worse than refusing the write.
 */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 17;
export const FONT_SIZE_DEFAULT = 15;

/**
 * The provider/model pair that writes automatic session titles.
 *
 * Exactly the two strings a request needs; the credential lives in
 * `models.json` / `auth.json` and is read at call time, never stored here.
 */
export interface TitleModelChoice {
  provider: string;
  model: string;
}

/**
 * Preferences this Web UI owns end to end. Anything pi itself persists
 * (steering/follow-up mode, auto-retry, auto-compaction) is deliberately absent
 * here — those live in pi's own global settings and are read back over RPC, so
 * the terminal and this UI can never disagree about them.
 */
export interface WebSettings {
  appearance: AppearancePreference;
  /**
   * Interface language. Unlike the appearance cubes this is not a look-only
   * preference: it decides which message table the front end renders from.
   */
  language: LanguagePreference;
  contentFontSize: number;
  transcriptDisplay: TranscriptDisplay;
  busySendBehavior: BusySendBehavior;
  /**
   * Whether a finished session task raises a browser notification. Off by
   * default: the browser only grants the permission behind a user gesture, so
   * turning this on is what asks for it — a page load never does.
   */
  browserNotifications: boolean;
  /**
   * Which model writes an automatic title for a session that has none, or
   * `null` for "nobody" — the default.
   *
   * Off by default because this is the only preference on this page that
   * spends money: every session it names is one extra request. Whoever turns
   * it on should also pick the model that pays for it, which is why the choice
   * is a pair rather than "use whatever the session uses".
   */
  titleModel: TitleModelChoice | null;
}

export function defaultSettings(): WebSettings {
  return {
    appearance: "system",
    // Following the host avoids surprising anyone who was using the Chinese UI
    // before this setting existed; English is what other locales resolve to.
    language: "system",
    contentFontSize: FONT_SIZE_DEFAULT,
    // dsh's own default. Only the *default* moves: a store that already names a
    // mode keeps it, and the two-mode generation's saved `normal` is read as
    // `detailed` below.
    transcriptDisplay: "detailed",
    // Queueing is the safe default: steering interrupts an in-flight run, so it
    // should be the deliberate choice rather than what happens to a stray Enter.
    busySendBehavior: "queue",
    browserNotifications: false,
    // Titles stay deterministic until someone opts in and names a model.
    titleModel: null,
  };
}

function emptyStore(): StoreData {
  return { version: 1, projects: [], sessionOverrides: {}, settings: defaultSettings() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerate hand-edited or partially written files: drop anything malformed. */
function normalize(raw: unknown): StoreData {
  if (!isRecord(raw)) return emptyStore();
  const projects: ProjectRecord[] = [];
  if (Array.isArray(raw.projects)) {
    for (const entry of raw.projects) {
      if (!isRecord(entry)) continue;
      const { id, path, title, order, createdAt, updatedAt } = entry;
      if (typeof id !== "string" || typeof path !== "string" || path.length === 0) continue;
      projects.push({
        id,
        path,
        title: typeof title === "string" && title.length > 0 ? title : path,
        order: typeof order === "number" && Number.isFinite(order) ? order : projects.length,
        createdAt: typeof createdAt === "string" ? createdAt : new Date(0).toISOString(),
        updatedAt: typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString(),
      });
    }
  }
  const sessionOverrides: Record<string, SessionOverride> = {};
  if (isRecord(raw.sessionOverrides)) {
    for (const [key, value] of Object.entries(raw.sessionOverrides)) {
      if (!isRecord(value)) continue;
      const override: SessionOverride = {};
      if (typeof value.name === "string") override.name = value.name;
      if (typeof value.hidden === "boolean") override.hidden = value.hidden;
      if (Object.keys(override).length > 0) sessionOverrides[key] = override;
    }
  }
  return { version: 1, projects, sessionOverrides, settings: normalizeSettings(raw.settings) };
}

/**
 * Coerce a persisted settings blob, falling back per field. A bad value from a
 * hand-edited file should cost that one preference, not the whole settings page.
 */
function normalizeSettings(raw: unknown): WebSettings {
  const settings = defaultSettings();
  if (!isRecord(raw)) return settings;
  if (
    typeof raw.appearance === "string" &&
    (APPEARANCE_VALUES as readonly string[]).includes(raw.appearance)
  ) {
    settings.appearance = raw.appearance as AppearancePreference;
  }
  if (
    typeof raw.contentFontSize === "number" &&
    Number.isInteger(raw.contentFontSize) &&
    raw.contentFontSize >= FONT_SIZE_MIN &&
    raw.contentFontSize <= FONT_SIZE_MAX
  ) {
    settings.contentFontSize = raw.contentFontSize;
  }
  if (
    typeof raw.language === "string" &&
    (LANGUAGE_VALUES as readonly string[]).includes(raw.language)
  ) {
    settings.language = raw.language as LanguagePreference;
  }
  if (typeof raw.transcriptDisplay === "string") {
    // A mode saved by the two-mode generation is read as `detailed`, the same
    // way dsh reads its own `normal` / `expanded` legacy values.
    const value = LEGACY_TRANSCRIPT_VALUES.includes(raw.transcriptDisplay)
      ? "detailed"
      : raw.transcriptDisplay;
    if ((TRANSCRIPT_VALUES as readonly string[]).includes(value)) {
      settings.transcriptDisplay = value as TranscriptDisplay;
    }
  }
  if (
    typeof raw.busySendBehavior === "string" &&
    (BUSY_SEND_VALUES as readonly string[]).includes(raw.busySendBehavior)
  ) {
    settings.busySendBehavior = raw.busySendBehavior as BusySendBehavior;
  }
  if (typeof raw.browserNotifications === "boolean") {
    settings.browserNotifications = raw.browserNotifications;
  }
  if (isRecord(raw.titleModel)
    && typeof raw.titleModel.provider === "string" && raw.titleModel.provider.length > 0
    && typeof raw.titleModel.model === "string" && raw.titleModel.model.length > 0) {
    settings.titleModel = { provider: raw.titleModel.provider, model: raw.titleModel.model };
  }
  return settings;
}

let cache: StoreData | null = null;

/** Serializes mutations so concurrent requests cannot interleave file writes. */
let writeQueue: Promise<unknown> = Promise.resolve();

async function loadFromDisk(): Promise<StoreData> {
  try {
    const text = await readFile(STORE_FILE, "utf8");
    return normalize(JSON.parse(text));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    if (err instanceof SyntaxError) {
      throw new Error(`corrupt store file at ${STORE_FILE}: ${err.message}`);
    }
    throw err;
  }
}

export async function readStore(): Promise<StoreData> {
  if (cache) return cache;
  cache ??= await loadFromDisk();
  return cache;
}

/**
 * Apply a mutation and persist it atomically (temp file + rename). The
 * callback receives a deep copy, so a throw leaves the cached state untouched.
 */
export async function mutateStore<T>(fn: (draft: StoreData) => T): Promise<T> {
  const run = async (): Promise<T> => {
    const current = await readStore();
    const draft = structuredClone(current);
    const result = fn(draft);
    await persist(draft);
    cache = draft;
    return result;
  };
  const next = writeQueue.then(run, run);
  writeQueue = next.catch(() => undefined);
  return next;
}

async function persist(data: StoreData): Promise<void> {
  await mkdir(dirname(STORE_FILE), { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, STORE_FILE);
}

/** Test seam: drop the in-memory cache so the next read hits disk. */
export function resetStoreCache(): void {
  cache = null;
}
