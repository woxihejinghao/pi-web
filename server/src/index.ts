import { createServer } from "node:http";
import { bus } from "./bus.ts";
import { PORT } from "./config.ts";
import { registry } from "./registry.ts";
import { createRequestHandler } from "./routes.ts";
import { SessionWatcher } from "./watch.ts";

// Single bridge from process-level session activity to the browser stream.
//
// pi's extensions emit a lot of terminal-only chrome — a single turn produced
// 53 `setTitle` requests. Those are noise for a browser client, so only the
// events a web UI can act on are forwarded.
const UI_METHODS_FOR_WEB = new Set(["notify", "confirm", "select", "input", "editor"]);

registry.onEvent((handle, event) => {
  // `extension_ui_request` is part of pi's UI sub-protocol and is not in the
  // typed agent-event union, so this check goes through a widened view.
  const raw = event as unknown as { type: string; method?: string };
  if (raw.type === "extension_ui_request") {
    if (!raw.method || !UI_METHODS_FOR_WEB.has(raw.method)) return;
  }
  bus.publish({ type: "session_event", sessionPath: handle.sessionPath, event });
});

registry.onClosed((handle, reason) => {
  bus.publish({ type: "session_closed", sessionPath: handle.sessionPath, reason });
});

const handler = createRequestHandler({ registry, bus });
const server = createServer((req, res) => {
  void handler(req, res);
});

const stopSweeper = registry.startSweeper();

// Notices sessions created or updated by the `pi` CLI in any project directory.
const watcher = new SessionWatcher({ registry, bus });
await watcher.start();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[pi-web-simple] api listening on http://127.0.0.1:${PORT}`);
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
