import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all pi-web-simple state. One directory, no scattered files. */
export const DATA_DIR = process.env.PI_WEB_SIMPLE_HOME
  ? process.env.PI_WEB_SIMPLE_HOME
  : join(homedir(), ".pi-web-simple");

/** Project records (JSON, atomically written). */
export const STORE_FILE = join(DATA_DIR, "store.json");

/** HTTP port for the API server. Vite proxies /api here in dev. */
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
