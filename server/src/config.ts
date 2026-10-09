import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Root of all pi-web-simple state. One directory, no scattered files. */
export const DATA_DIR = process.env.PI_WEB_SIMPLE_HOME
  ? process.env.PI_WEB_SIMPLE_HOME
  : join(homedir(), ".pi-web-simple");

/** Project records (JSON, atomically written). */
export const STORE_FILE = join(DATA_DIR, "store.json");

/**
 * HTTP port. In dev this is the API only — Vite owns the browser-facing port
 * and proxies `/api` here. In production the same server answers both, so this
 * *is* the address you open; the published CLI defaults it to 5319 to match
 * what dev puts in the address bar.
 */
export const PORT = Number(process.env.PI_WEB_SIMPLE_PORT ?? 4319);

/** A session process is stopped after this long without activity. */
export const IDLE_TIMEOUT_MS = Number(process.env.PI_WEB_SIMPLE_IDLE_MS ?? 10 * 60 * 1000);

/** Upper bound on concurrently alive pi RPC subprocesses. */
export const MAX_ACTIVE_SESSIONS = Number(process.env.PI_WEB_SIMPLE_MAX_SESSIONS ?? 8);

/**
 * How much one SSE connection may buffer while its socket is backed up.
 *
 * `res.write` returning false means Node's own buffer is full — the client is
 * not draining fast enough. Writing anyway is what lets a stalled stream grow
 * without bound (the benchmark held ~690MB across four slow readers). Past this
 * many bytes the connection is dropped instead; the browser reconnects and
 * re-reads an authoritative snapshot.
 */
export const SSE_MAX_BUFFERED_BYTES = Number(
  process.env.PI_WEB_SIMPLE_SSE_BUFFER ?? 4 * 1024 * 1024,
);

/**
 * When set, both session lookup and every spawned pi process use this session
 * root instead of pi's default. Keeps the app (and its verification runs) from
 * touching the user's real session history.
 */
export const SESSION_DIR_OVERRIDE = process.env.PI_WEB_SIMPLE_SESSION_DIR ?? null;

/**
 * A positive integer from the environment, or the default.
 *
 * Unlike the ports and timeouts above, a bad value here would not fail loudly:
 * a NaN byte budget would clip every title to nothing. Falling back is what
 * keeps a typo from emptying the sidebar.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * UTF-8 byte budget for one session title. dsh ships no default (its config is
 * required), so this is ours: long enough for a sentence, short enough that the
 * sidebar's single line is the constraint rather than the number.
 */
export const TITLE_MAX_BYTES = positiveInt(process.env.PI_WEB_SIMPLE_TITLE_BYTES, 120);

/** Words kept when a title is derived from a first message. */
export const TITLE_FALLBACK_WORDS = positiveInt(process.env.PI_WEB_SIMPLE_TITLE_WORDS, 8);

/**
 * Budgets for the optional model-written title. All three exist because the
 * feature is charged per call and must stay small on every axis: a short
 * deadline (a title is not worth waiting on), a small input (a first message
 * can be a pasted file), and a tiny output cap.
 */
export const TITLE_TIMEOUT_MS = positiveInt(process.env.PI_WEB_SIMPLE_TITLE_TIMEOUT_MS, 10_000);

/** Bytes of the first message sent to the title model. */
export const TITLE_INPUT_MAX_BYTES = positiveInt(process.env.PI_WEB_SIMPLE_TITLE_INPUT_BYTES, 2_000);

/** Output-token cap for one title. A title is one short line; 32 is generous. */
export const TITLE_OUTPUT_TOKENS = positiveInt(process.env.PI_WEB_SIMPLE_TITLE_OUTPUT_TOKENS, 32);

/**
 * Set to skip the one-time move of names an older build kept in `store.json`
 * into the sessions' own files.
 *
 * An escape hatch, not a feature: without the migration those names are simply
 * no longer shown, because a session's own name is the only title now.
 */
export const SKIP_TITLE_MIGRATION = process.env.PI_WEB_SIMPLE_SKIP_TITLE_MIGRATION === "1";

/**
 * A cwd that resolves to an empty project scope.
 *
 * Settings pages can be opened before a workspace is selected, but pi hangs the
 * project scope off `<cwd>/.pi` — its package resolver and its MCP config layer
 * both do. Pointing at the server's own cwd would pull in this repository's
 * files, and pointing at `$HOME` would pick up `~/.pi`, which is the *parent* of
 * the agent dir rather than a project. A path under the agent dir that is never
 * created gives both readers an empty project scope, which is what "no
 * workspace" means here. Resolved per call because tests repoint the agent dir.
 */
export function noProjectCwd(): string {
  return join(getAgentDir(), ".pi-web-simple-no-project");
}

/**
 * The built front end to serve, or null when there is none.
 *
 * `web/dist` sits two levels up from both layouts this module is compiled into
 * — `server/src/` under tsx, `server/build/` inside the published package — so
 * one relative path covers dev and the installed CLI.
 *
 * Null is a deliberate answer rather than an error: an unbuilt checkout keeps
 * a working API instead of serving nothing, and the startup log says which one
 * you got. `PI_WEB_SIMPLE_STATIC_DIR` overrides the lookup, and an empty value
 * forces API-only.
 */
export const STATIC_DIR: string | null = (() => {
  const override = process.env.PI_WEB_SIMPLE_STATIC_DIR;
  if (override !== undefined) {
    return override.length > 0 ? resolve(override) : null;
  }
  const built = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  return existsSync(join(built, "index.html")) ? built : null;
})();

/**
 * Open the browser at the app URL once the server is listening.
 *
 * Only the published CLI opts in (it sets `PI_WEB_SIMPLE_OPEN=1`): the dev
 * server must not steal focus from the editor, and a test run must not open
 * windows at all.
 */
export const OPEN_BROWSER = process.env.PI_WEB_SIMPLE_OPEN === "1";
