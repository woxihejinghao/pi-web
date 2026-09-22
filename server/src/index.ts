import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { bus } from "./bus.ts";
import { OPEN_BROWSER, PORT, STATIC_DIR } from "./config.ts";
import { registry } from "./registry.ts";
import { createRequestHandler } from "./routes.ts";
import { createStaticHandler } from "./static.ts";
import { SessionWatcher } from "./watch.ts";
import { pendingUiRequests } from "./ui-requests.ts";

// Single bridge from process-level session activity to the browser stream.
//
// pi's extensions emit a lot of terminal-only chrome — a single turn produced
// 53 `setTitle` requests. Those are noise for a browser client, so only the
// events a web UI can act on are forwarded.
const UI_METHODS_FOR_WEB = new Set(["notify", "confirm", "select", "input", "editor"]);

registry.onEvent((handle, event) => {
  // `extension_ui_request` is part of pi's UI sub-protocol and is not in the
  // typed agent-event union, so this check goes through a widened view.
  const raw = event as unknown as { type: string; id?: string; method?: string };
  if (raw.type === "extension_ui_request") {
    if (!raw.method || !UI_METHODS_FOR_WEB.has(raw.method)) return;
    // A dialog blocks its process, and the client answers it by id — so the
    // request has to be remembered here, not only broadcast. `notify` is
    // fire-and-forget and owes no answer.
    if (raw.method !== "notify" && typeof raw.id === "string") {
      pendingUiRequests.add(handle, raw as unknown as { id: string; method: string });
    }
  }
  bus.publish({ type: "session_event", sessionPath: handle.sessionPath, event });
});

registry.onClosed((handle, reason) => {
  pendingUiRequests.dropFor(handle);
  bus.publish({ type: "session_closed", sessionPath: handle.sessionPath, reason });
});

// Null when there is no build to serve: the API then runs on its own, which is
// exactly what the dev setup wants, and what an unbuilt checkout gets.
const staticHandler = createStaticHandler(STATIC_DIR);
const handler = createRequestHandler({ registry, bus, staticHandler });
const server = createServer((req, res) => {
  void handler(req, res);
});

const stopSweeper = registry.startSweeper();

// Notices sessions created or updated by the `pi` CLI in any project directory.
const watcher = new SessionWatcher({ registry, bus });
await watcher.start();

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
