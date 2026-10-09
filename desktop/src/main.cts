/**
 * Electron main process for the pi-web-simple desktop build.
 *
 * The desktop app is deliberately thin: it contributes a window, a menu, a
 * process-local port and a bundled Node.js runtime — everything below that is
 * the *same* server the published CLI starts (`server/build/index.js`), so the
 * browser and the desktop app can never drift into two different products.
 *
 * Why a bundled runtime instead of Electron's own Node (`ELECTRON_RUN_AS_NODE`):
 * pi's RPC client spawns the bare command `node` (see
 * `@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js`), which means
 * the agent's own subprocesses need a real `node` on `PATH` — and on Windows a
 * `.cmd`/`.bat` shim cannot satisfy `spawn("node")` at all. Shipping the
 * official Node.js build removes both problems, keeps the agent on the same
 * Node the CI tests against, and matches deepseek-harness' desktop, which also
 * carries its own runtime rather than borrowing the host's.
 *
 * Written as `.cts` so it compiles to CommonJS: the packaged app's package.json
 * carries `"type": "module"` (the server build is ESM), and Electron's main
 * entry is most predictable as CJS.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from "electron";

/** Same default as the published CLI, so docs and screenshots stay true. */
const DEFAULT_PORT = 5319;
const SERVER_START_TIMEOUT_MS = 30_000;
const LOG_TAIL_LINES = 200;
const PROJECT_URL = "https://github.com/woxihejinghao/pi-web";

const isDev = !app.isPackaged;

// ---------------------------------------------------------------------------
// diagnostics

const logTail: string[] = [];
const recordLine = (line: string): void => {
  logTail.push(line);
  if (logTail.length > LOG_TAIL_LINES) logTail.shift();
  // Always on: launched from a terminal this is the only view of the server's
  // own output, and `open -a` sends it to the system log.
  process.stderr.write(line + "\n");
};

/** The last few server lines — what an error dialog shows instead of nothing. */
function tailText(): string {
  return logTail.slice(-25).join("\n");
}

async function reportFatal(error: unknown, title: string): Promise<void> {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  recordLine(`[desktop] ${title}: ${message}`);
  // `app.exit` skips `before-quit`, so the server has to be reaped here.
  await stopServerProcess();
  const detail = tailText();
  await dialog.showMessageBox({
    type: "error",
    title,
    message: title,
    detail: detail.length > 0 ? detail : message,
    buttons: ["Quit"],
    defaultId: 0,
  });
  app.exit(1);
}

// ---------------------------------------------------------------------------
// layout

interface AppPaths {
  /** `server/build/index.js` — the server the CLI also runs. */
  serverEntry: string;
  /** Built front end handed to the server through `PI_WEB_SIMPLE_STATIC_DIR`. */
  staticDir: string;
  nodeBin: string;
  /** Directory to prepend to `PATH`; null when `nodeBin` is a bare command. */
  nodeBinDir: string | null;
  cwd: string;
  preload: string;
  /**
   * The brand bitmap to hand Electron (`desktop/resources/icon.png`), or null
   * when there is nothing to hand over. Only unpackaged runs need it: a packaged
   * app carries its icon in the bundle (`mac`'s `.icns`, `win`'s `.ico`), while
   * `electron .` would otherwise wear Electron's own icon in the Dock.
   */
  icon: string | null;
}

function appPaths(): AppPaths {
  const preload = join(__dirname, "preload.cjs");
  if (!isDev) {
    const appRoot = app.getAppPath();
    const nodeBin = join(
      process.resourcesPath,
      "runtime",
      "node",
      "bin",
      process.platform === "win32" ? "node.exe" : "node",
    );
    return {
      serverEntry: join(appRoot, "server", "build", "index.js"),
      staticDir: join(appRoot, "web", "dist"),
      nodeBin,
      nodeBinDir: dirname(nodeBin),
      // Launching from a project directory would make pi's cwd-derived project
      // scope depend on where the user happened to install the app.
      cwd: app.getPath("home"),
      preload,
      icon: null,
    };
  }
  // Unpackaged: `electron .` inside `desktop/` runs against the checkout, using
  // the host's `node` (there is no runtime download in a dev loop).
  const repoRoot = resolve(app.getAppPath(), "..");
  const nodeBin = process.env.PI_WEB_DESKTOP_NODE ?? "node";
  const nodeBinDir = dirname(nodeBin);
  // `electron .` runs out of Electron's own bundle, so the Dock (and the
  // taskbar on Windows/Linux) would show Electron's icon without this. The
  // packaged app never needs it — see the field's comment on `AppPaths`.
  const icon = join(app.getAppPath(), "resources", "icon.png");
  return {
    serverEntry: join(repoRoot, "server", "build", "index.js"),
    staticDir: join(repoRoot, "web", "dist"),
    nodeBin,
    nodeBinDir: nodeBinDir === "." ? null : nodeBinDir,
    cwd: repoRoot,
    preload,
    icon: existsSync(icon) ? icon : null,
  };
}

// ---------------------------------------------------------------------------
// port

function isPortFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

/**
 * An explicit `PI_WEB_SIMPLE_PORT` wins (and a busy port is then a real error);
 * otherwise prefer 5319 — the number every doc mentions — and only fall back to
 * an ephemeral port when something else already holds it. The CLI and the
 * desktop app can therefore run side by side.
 */
async function choosePort(): Promise<number> {
  const requested = Number(process.env.PI_WEB_SIMPLE_PORT);
  if (Number.isInteger(requested) && requested > 0 && requested < 65_536) return requested;
  if (await isPortFree(DEFAULT_PORT)) return DEFAULT_PORT;
  return freePort();
}

// ---------------------------------------------------------------------------
// server child process

interface ServerHandle {
  child: ChildProcess;
  url: string;
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

async function startServer(paths: AppPaths): Promise<ServerHandle> {
  if (!existsSync(paths.serverEntry)) {
    throw new Error(
      `server build not found at ${paths.serverEntry} — run \`pnpm build\` before launching the desktop app`,
    );
  }
  if (!existsSync(join(paths.staticDir, "index.html"))) {
    throw new Error(
      `front end build not found at ${paths.staticDir} — run \`pnpm build\` before launching the desktop app`,
    );
  }

  const port = await choosePort();
  const url = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_WEB_SIMPLE_PORT: String(port),
    // Electron owns the window; opening a browser as well would be a bug.
    PI_WEB_SIMPLE_OPEN: "0",
    PI_WEB_SIMPLE_STATIC_DIR: paths.staticDir,
  };
  if (paths.nodeBinDir !== null) {
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    // `spawn("node", …)` inside pi resolves against this, so the agent uses the
    // same runtime we shipped rather than whatever the user has installed.
    env[pathKey] = `${paths.nodeBinDir}${delimiter}${env[pathKey] ?? ""}`;
  }

  const child = spawn(paths.nodeBin, [paths.serverEntry], {
    cwd: paths.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // Recorded before the readiness check below: quitting during startup must
  // still reap this process, and there is no handle to ask yet.
  starting = child;

  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    let buffered = "";
    stream?.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) recordLine(line);
    });
  }

  const exited = new Promise<number | null>((done) => {
    child.once("exit", (code) => done(code));
  });
  child.once("error", (error) => recordLine(`[desktop] failed to spawn ${paths.nodeBin}: ${error.message}`));

  await waitForHealth(url, exited);
  return { child, url, exited, stop: () => stopServer(child, exited) };
}

async function waitForHealth(url: string, exited: Promise<number | null>): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    const code = await Promise.race([exited, sleep(150).then(() => undefined)]);
    if (code !== undefined) {
      throw new Error(`server exited with code ${code} before it started listening`);
    }
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(150);
  }
  throw new Error(`server did not become ready within ${SERVER_START_TIMEOUT_MS}ms (${lastError})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Shutdown is the one path with no UI to look at, and a leak here means a stray
 * server holding a port, so it can be traced from the outside:
 * `PI_WEB_SIMPLE_DESKTOP_TRACE=/tmp/trace.log` appends one line per event.
 */
const tracePath = process.env.PI_WEB_SIMPLE_DESKTOP_TRACE;
function trace(event: string): void {
  if (tracePath === undefined) return;
  try {
    appendFileSync(tracePath, `${Date.now()} ${event}\n`);
  } catch {
    // Diagnostics must never be the reason the app fails to quit.
  }
}

async function stopServer(child: ChildProcess, exited: Promise<number | null>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    trace("stop: already exited");
    return;
  }
  trace("stop: SIGTERM");
  child.kill("SIGTERM");
  const finished = await Promise.race([exited, sleep(5_000).then(() => "timeout" as const)]);
  trace(`stop: ${finished === "timeout" ? "timeout, SIGKILL" : "exited"}`);
  if (finished === "timeout") child.kill("SIGKILL");
}

// ---------------------------------------------------------------------------
// window

function createWindow(handle: ServerHandle, paths: AppPaths): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: "#0f1115",
    title: "pi-web-simple",
    // Windows and Linux take the window/taskbar icon from here. macOS ignores
    // it (its Dock icon is the bundle's, or the `dock.setIcon` in `main`).
    ...(paths.icon !== null ? { icon: paths.icon } : {}),
    // macOS opens with the window's `sidebar` vibrancy material so the web UI's
    // transparent sidebar (`web/src/theme/index.css`,
    // `web/src/layout/AppLayout.module.css`) has something to read through —
    // the same material deepseek-harness gives its window. `'active'` keeps
    // the material stable when the window loses focus; `'followWindow'` washes
    // the sidebar out. The transparent `backgroundColor` is what lets the
    // material show behind the page; the fill above stays as the pre-paint and
    // as the whole window's colour when there is no material.
    //
    // `hiddenInset` keeps the native traffic lights but draws the title-bar
    // band transparent, so the page extends to the window's top edge and the
    // sidebar tint runs under the controls instead of stopping below an opaque
    // strip. `trafficLightPosition` matches deepseek-harness' inset. Because the
    // band is no longer an opaque bar, the window is dragged from rows the page
    // marks instead — see the `[data-window-drag]` rules in `theme/index.css`,
    // which are also what keeps the controls under that band clickable.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 18 },
          vibrancy: "sidebar" as const,
          visualEffectState: "active" as const,
          backgroundColor: "#00000000",
        }
      : {}),
    webPreferences: {
      preload: paths.preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: true,
    },
  });

  // External links belong in the user's browser, not in a chromeless window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url, handle.url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(handle.url) && isExternal(url, handle.url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    recordLine(`[desktop] failed to load ${url} (${code} ${description})`);
  });

  window.once("ready-to-show", () => window.show());
  void window.loadURL(handle.url);
  return window;
}

function isExternal(url: string, appUrl: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return (protocol === "http:" || protocol === "https:") && !url.startsWith(appUrl);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// menu

function buildMenu(handle: ServerHandle): Menu {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === "darwin") {
    template.push({
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push(
    {
      label: "File",
      submenu: [
        {
          label: "Open in Browser",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => void shell.openExternal(handle.url),
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, ...(process.platform === "darwin" ? [{ role: "front" as const }] : [])],
    },
    {
      role: "help",
      submenu: [
        // 只在打包后存在（应用目录根部）；开发模式下这一项直接不显示。
        ...(existsSync(noticesPath())
          ? [
              { label: "Third-party Notices", click: () => void shell.openPath(noticesPath()) },
              { type: "separator" as const },
            ]
          : []),
        { label: "pi-web-simple on GitHub", click: () => void shell.openExternal(PROJECT_URL) },
        {
          label: "Report an Issue",
          click: () => void shell.openExternal(`${PROJECT_URL}/issues`),
        },
      ],
    },
  );
  return Menu.buildFromTemplate(template);
}

/** `THIRD_PARTY_NOTICES.md` as staged into the app bundle (null in dev). */
function noticesPath(): string {
  return join(app.getAppPath(), "THIRD_PARTY_NOTICES.md");
}

// ---------------------------------------------------------------------------
// lifecycle

let handle: ServerHandle | null = null;
/** The server process as soon as it exists — `handle` only after it is ready. */
let starting: ChildProcess | null = null;
let window: BrowserWindow | null = null;
let shutdown: Promise<void> | null = null;

function quitGracefully(): void {
  trace("quitGracefully");
  shutdown ??= stopServerProcess();
  void shutdown.then(() => app.quit());
}

/** Stops the server whether or not it got as far as being ready. */
async function stopServerProcess(): Promise<void> {
  if (handle !== null) await handle.stop();
  else starting?.kill("SIGTERM");
}

async function main(): Promise<void> {
  const paths = appPaths();
  app.setName("pi-web-simple");
  if (process.platform === "darwin") {
    // Under `electron .` the Dock shows Electron's icon, and there is no bundle
    // of ours for it to read instead — so hand it the same PNG the packaging
    // scripts turn into the `.icns`.
    if (paths.icon !== null) app.dock?.setIcon(paths.icon);
    app.setAboutPanelOptions({
      applicationName: "pi-web-simple",
      applicationVersion: app.getVersion(),
      copyright: "MIT licensed. Bundles Node.js; see THIRD_PARTY_NOTICES.md.",
    });
  }

  handle = await startServer(paths);
  recordLine(`[desktop] serving ${handle.url}`);
  Menu.setApplicationMenu(buildMenu(handle));
  window = createWindow(handle, paths);

  // The agent can die on its own (crashed extension, OOM). Surfacing that beats
  // leaving the user with a UI whose every action silently fails.
  void handle.exited.then((code) => {
    if (shutdown !== null || code === null) return;
    void reportFatal(new Error(`the pi-web-simple server exited with code ${code}`), "Server stopped");
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.on("activate", () => {
    if (window === null && handle !== null) window = createWindow(handle, appPaths());
  });

  app.on("window-all-closed", () => {
    // macOS keeps the app (and its server) alive, as the platform expects.
    if (process.platform !== "darwin") quitGracefully();
  });

  app.on("before-quit", (event) => {
    trace(`before-quit handle=${handle === null ? "null" : "set"} shutdown=${shutdown === null ? "null" : "pending"}`);
    if (handle === null && starting === null) return;
    if (shutdown !== null) return; // already stopping: let this quit through
    event.preventDefault();
    quitGracefully();
  });

  app.on("will-quit", () => trace("will-quit"));

  /**
   * Electron handles SIGTERM/SIGINT in C++ by calling `quit()`, which never
   * reaches a JavaScript signal listener — but it does emit `before-quit`
   * first, so the handler above is the single stop path. Installing a listener
   * here as well only makes the intent clear; it is a no-op in Electron.
   */
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      trace(`${signal} js handler`);
      quitGracefully();
    });
  }

  void app.whenReady()
    .then(main)
    .catch((error: unknown) => reportFatal(error, "pi-web-simple could not start"));
}
