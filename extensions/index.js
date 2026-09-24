/**
 * Pi Web Simple — extension entry point.
 *
 * The package is primarily a standalone web UI (`npx pi-web-simple`). This
 * extension exists so the same UI is reachable from inside a pi session:
 * `/web` starts the bundled server as a child process, `/web stop` ends it,
 * and `session_shutdown` makes sure the child never outlives the session.
 *
 * Nothing about the session's cwd is handed to the server on purpose: it
 * browses every project already registered in `~/.pi-web-simple/store.json`
 * and spawns its own pi RPC processes, so the only real input is the port.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = resolve(PKG_ROOT, "server/build/index.js");
const DEFAULT_PORT = 5319;
const LOG_TAIL_LINES = 20;

/** The server is one machine-wide process, so one module-level slot is enough. */
let instance = null;

function parseArgs(args) {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const action = (words[0] ?? "start").toLowerCase();
	const portFlag = args.match(/--port[=\s]+(\d+)/);
	const bare = words.find((word) => /^\d{2,5}$/.test(word));
	const port = Number(portFlag?.[1] ?? bare ?? process.env.PI_WEB_SIMPLE_PORT ?? DEFAULT_PORT);
	return { action, port, noOpen: words.includes("--no-open") };
}

function stopInstance() {
	if (!instance) return null;
	const stopped = instance;
	instance = null;
	if (stopped.proc.exitCode === null) stopped.proc.kill("SIGTERM");
	return stopped;
}

export default function piWebSimple(pi) {
	pi.registerCommand("web", {
		description: "Start the pi-web-simple web UI (/web [port] [--no-open] | stop | status)",
		getArgumentCompletions: (prefix) => {
			const items = ["start", "stop", "status"].filter((item) => item.startsWith(prefix));
			return items.length > 0 ? items.map((item) => ({ value: item, label: item })) : null;
		},
		handler: async (args, ctx) => {
			const { action, port, noOpen } = parseArgs(args);

			if (action === "stop" || action === "kill") {
				const stopped = stopInstance();
				ctx.ui.notify(
					stopped ? `pi-web-simple stopped (${stopped.url})` : "pi-web-simple is not running",
					stopped ? "info" : "warning",
				);
				return;
			}

			if (action === "status") {
				const alive = instance !== null && instance.proc.exitCode === null;
				ctx.ui.notify(
					alive ? `pi-web-simple running → ${instance.url}` : "pi-web-simple is not running",
					alive ? "info" : "warning",
				);
				return;
			}

			if (action !== "start" && action !== "run") {
				ctx.ui.notify(`Unknown action "${action}" — use start (default), stop, or status`, "warning");
				return;
			}

			if (instance !== null && instance.proc.exitCode === null) {
				ctx.ui.notify(`pi-web-simple is already running → ${instance.url}`, "info");
				return;
			}

			if (!existsSync(SERVER_ENTRY)) {
				ctx.ui.notify("Missing server build at " + SERVER_ENTRY + " — run `pnpm build` first.", "error");
				return;
			}

			const url = `http://localhost:${port}`;
			// The server prints its URL and the reason it refused to bind (port in
			// use, no front end) to stdio. Inheriting stdio would spray that into
			// the TUI, so keep a short tail instead and surface it only on failure.
			const tail = [];
			const proc = spawn(process.execPath, [SERVER_ENTRY], {
				cwd: ctx.cwd,
				env: {
					...process.env,
					PI_WEB_SIMPLE_PORT: String(port),
					PI_WEB_SIMPLE_OPEN: noOpen ? "0" : "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			instance = { proc, port, url, tail };

			const collect = (chunk) => {
				for (const line of String(chunk).split("\n")) {
					if (line.trim()) tail.push(line.trim());
				}
				if (tail.length > LOG_TAIL_LINES) tail.splice(0, tail.length - LOG_TAIL_LINES);
			};
			proc.stdout.on("data", collect);
			proc.stderr.on("data", collect);

			proc.on("exit", (code) => {
				if (instance?.proc === proc) instance = null;
				if (code !== 0 && code !== null) {
					ctx.ui.notify(`pi-web-simple exited with code ${code}\n${tail.join("\n")}`, "error");
				}
			});
			proc.on("error", (error) => {
				if (instance?.proc === proc) instance = null;
				ctx.ui.notify(`pi-web-simple failed to start: ${error.message}`, "error");
			});

			ctx.ui.notify(
				`pi-web-simple starting → ${url}\nport ${port} · /web status to check · /web stop to end`,
			);
		},
	});

	pi.on("session_shutdown", () => {
		stopInstance();
	});
}
