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
 * When set, both session lookup and every spawned pi process use this session
 * root instead of pi's default. Keeps the app (and its verification runs) from
 * touching the user's real session history.
 */
export const SESSION_DIR_OVERRIDE = process.env.PI_WEB_SIMPLE_SESSION_DIR ?? null;

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
