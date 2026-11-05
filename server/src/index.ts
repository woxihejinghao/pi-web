import { spawn } from "node:child_process";
import { initializeApprovals } from "./approval.ts";
import { createServer } from "node:http";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { bus } from "./bus.ts";
import { OPEN_BROWSER, PORT, SKIP_TITLE_MIGRATION, STATIC_DIR } from "./config.ts";
import { registry } from "./registry.ts";
import { createRequestHandler } from "./routes.ts";
import { createStaticHandler } from "./static.ts";
import { TerminalManager } from "./terminal.ts";
import { migrateLegacySessionTitles } from "./title-migration.ts";
import { SessionTitleService } from "./title-service.ts";
import { SessionWatcher } from "./watch.ts";
import { WorkspaceWatcher } from "./workspace-watch.ts";
import { pendingUiRequests, webEventFor, type PiFrame } from "./ui-requests.ts";
import { reconcileEvent } from "./queue.ts";

// Single bridge from process-level session activity to the browser stream.
// Which frames survive that bridge is `webEventFor`'s decision, not this file's.

/**
 * Optional model-written titles. It owns no timer and no process: it reacts to
 * the first human message of a session, asks the configured model once, and
 * stays out of the way when the user has not opted in.
 */
const titleService = new SessionTitleService({
  liveWriter: (sessionPath) => {
    const handle = registry.get(sessionPath);
    return handle === undefined || handle.dead ? undefined : handle.client;
  },
  publish: (projectPath) => {
    bus.publish({ type: "sessions_changed", projectPath });
  },
});

registry.onEvent((handle, event) => {
  // Queue drains and terminal-side enqueues reach the mirror as raw frames,
  // before any translation — the mirror keeps image payloads the frame text
  // cannot carry (see `queue.ts`).
  reconcileEvent(handle, event as unknown as { type: string });
  // `extension_ui_request` is part of pi's UI sub-protocol and is not in the
  // typed agent-event union, so this check goes through a widened view. A
  // question batch is published in its decoded form (`method: "ask_user"`)
  // rather than the `select` envelope it travelled in — `webEventFor` owns that
  // translation, so no client has to know the codec.
  const published = webEventFor(event as unknown as PiFrame, handle, pendingUiRequests);
  if (published === null) return;
  // The title service reads pi's own frames, so it gets the event as it came
  // off the process and not the display form above.
  titleService.noteEvent(handle, event);
  bus.publish({
    type: "session_event",
    sessionPath: handle.sessionPath,
    event: published as unknown as JsonAgentSessionEvent,
  });
});

registry.onClosed((handle, reason) => {
  pendingUiRequests.dropFor(handle);
  titleService.forget(handle.sessionPath);
  bus.publish({ type: "session_closed", sessionPath: handle.sessionPath, reason });
});

// Null when there is no build to serve: the API then runs on its own, which is
// exactly what the dev setup wants, and what an unbuilt checkout gets.
initializeApprovals();
const staticHandler = createStaticHandler(STATIC_DIR);
// Owned here rather than by the route handler so shutdown can reach it: a PTY
// outliving the server would leave a shell attached to a terminal nobody can
// see, and a `node` process that never exits.
const terminals = new TerminalManager({ bus });
const handler = createRequestHandler({ registry, bus, staticHandler, terminals });
const server = createServer((req, res) => {
  void handler(req, res);
});

const stopSweeper = registry.startSweeper();

// A rename used to live in `store.json`, and is ignored on read now that a
// session's own name is the only title — so hand those names back before
// anything can show a list without them. Runs before the watcher starts, so
// the migration's own appends are not read as another process editing a
// session. Failure is already logged per entry and never blocks startup.
if (!SKIP_TITLE_MIGRATION) {
  const migration = await migrateLegacySessionTitles();
  if (migration.migrated > 0) {
    console.log(
      `[pi-web-simple] moved ${migration.migrated} stored session name(s) into their session files`,
    );
  }
}

// Notices sessions created or updated by the `pi` CLI in any project directory.
const watcher = new SessionWatcher({ registry, bus });
await watcher.start();

// Notices working-tree edits so the changes panel does not need a manual
// refresh after an editor save, a formatter, or a terminal `git` command.
const workspaceWatcher = new WorkspaceWatcher({ bus });
await workspaceWatcher.start();

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`[pi-web-simple] port ${PORT} is already in use`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(
    staticHandler
      ? `[pi-web-simple] ${url} (web ui + api)`
      : `[pi-web-simple] ${url} (api only — no front end build found)`,
  );
  if (staticHandler === null) {
    console.log("[pi-web-simple] run `pnpm build`, or point PI_WEB_SIMPLE_STATIC_DIR at a build");
  }
  if (OPEN_BROWSER) openBrowser(url);
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[pi-web-simple] ${signal} received, stopping sessions`);
  stopSweeper();
  watcher.stop();
  workspaceWatcher.stop();
  titleService.stop();
  terminals.stop();
  server.close();
  await registry.closeAll(`shutdown:${signal}`);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

/**
 * Best-effort. The URL is on stdout either way, so a machine without an opener
 * (`xdg-open` is not guaranteed on Linux) loses only the convenience.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const child = spawn(command[0], command.slice(1), { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
