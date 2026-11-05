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
  ipcMain,
  Menu,
  Notification,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { badgeOverlay } from "./badge-overlay.cjs";

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
   * The brand bitmap to hand Electron, or null when there is nothing to hand
   * over. Only unpackaged runs need it: a packaged app carries its icon in the
   * bundle (`mac`'s `.icns`, `win`'s `.ico`), while `electron .` would otherwise
   * wear Electron's own icon in the Dock.
   *
   * Which file depends on the platform, for the same reason the packaged icons
   * differ (see `desktop/scripts/render-icon.mjs`): macOS wants the squircle with
   * its transparent margin, Windows and Linux want the full-bleed square.
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
  const iconName = process.platform === "darwin" ? "icon.png" : "icon-square.png";
  const icon = join(app.getAppPath(), "resources", iconName);
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
    // Tells the server its copy lives in this bundle, not in an npm
    // `node_modules`: the 关于 row then points at the release page instead of
    // offering an `npm install -g` that would update something else entirely.
    PI_WEB_SIMPLE_DESKTOP: "1",
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

function killWindowsTree(child: ChildProcess): void {
  if (process.platform !== "win32" || child.pid === undefined) return;
  // `ChildProcess.kill()` only targets the direct node process on Windows;
  // pi may have already spawned RPC/tool descendants. taskkill /T reaps the
  // whole tree without adding a native dependency.
  const result = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  result.once("error", (error) => recordLine(`[desktop] taskkill failed: ${error.message}`));
}

async function stopServer(child: ChildProcess, exited: Promise<number | null>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    trace("stop: already exited");
    return;
  }
  trace("stop: SIGTERM");
  child.kill("SIGTERM");
  const finished = await Promise.race([exited, sleep(5_000).then(() => "timeout" as const)]);
  trace(`stop: ${finished === "timeout" ? "timeout, force tree kill" : "exited"}`);
  if (finished === "timeout") {
    if (process.platform === "win32") killWindowsTree(child);
    else child.kill("SIGKILL");
  }
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
// notifications

/**
 * The channels the preload bridge speaks. The names are written on both sides
 * of the isolated world, so they live here and in exactly one other file
 * (`desktop/src/preload.cts`).
 */
const NOTIFY_CHANNEL = "piweb:notify";
const BADGE_CHANNEL = "piweb:badge";
const NOTIFICATION_CLICK_CHANNEL = "piweb:notification-click";

/** What the page asks the shell to show; the copy is already translated. */
interface ShellNotification {
  title: string;
  body: string;
  /** The session path, doubling as the notice's identity (the web path's `tag`). */
  tag: string;
}

/**
 * Mirror the count of finished-but-unopened sessions onto the OS: the Dock on
 * macOS, the launcher on Linux, and — because Windows has no numeric badge —
 * an overlay bitmap on the taskbar icon.
 */
function applyBadge(count: number): void {
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  currentBadge = safe;
  if (process.platform === "win32") {
    const target = mainWindow();
    if (target === null) return;
    target.setOverlayIcon(
      safe === 0 ? null : badgeOverlay(safe),
      safe === 0 ? "" : `${safe} sessions finished`,
    );
    return;
  }
  // macOS Dock and the Linux Unity launcher both read this one, and it clears
  // the badge at zero by itself.
  app.setBadgeCount(safe);
}

/**
 * Notices still on screen, keyed by session path. Electron drops a
 * `Notification` that nothing references, and the map also gives a session's
 * newer notice something to replace instead of stacking a duplicate.
 */
const notices = new Map<string, Notification>();

/**
 * The count the page last asked for. A taskbar overlay dies with its window, so
 * a rebuilt one has to be told again — macOS and Linux keep the badge on the
 * app and need nothing here.
 */
let currentBadge = 0;

function showShellNotification(notice: ShellNotification, sender: WebContents): void {
  notices.get(notice.tag)?.close();

  const notification = new Notification({ title: notice.title, body: notice.body });
  notices.set(notice.tag, notification);
  notification.on("click", () => revealWindow(sender, notice.tag));
  notification.on("failed", (_event, error: string) => {
    // macOS 上 `UNNotification` 拒绝投递时唯一的信号：`isSupported()` 依旧
    // 为 true，没有监听器就完全看不出发生了什么。链接器签名的 Electron
    // （开发模式没重签时）就落在这里，所以留一行到 stderr。
    recordLine(`[desktop] notification failed: ${error}`);
    if (notices.get(notice.tag) === notification) notices.delete(notice.tag);
  });
  notification.on("close", () => {
    if (notices.get(notice.tag) === notification) notices.delete(notice.tag);
  });
  notification.show();
}

/**
 * Bring the window forward and tell the page which session the notice named.
 *
 * The click lands in the main process, but the session list lives in the
 * renderer, so the answer travels back over `NOTIFICATION_CLICK_CHANNEL`. A
 * window that had to be recreated is still loading its first page, and a send
 * before `did-finish-load` would be dropped — hence the wait.
 */
function revealWindow(sender: WebContents, sessionPath: string): void {
  const target = mainWindow();
  if (target !== null) {
    if (target.isMinimized()) target.restore();
    if (!target.isVisible()) target.show();
    target.focus();
  }
  const contents = target?.webContents ?? sender;
  if (contents.isDestroyed()) return;
  const deliver = (): void => contents.send(NOTIFICATION_CLICK_CHANNEL, sessionPath);
  if (contents.isLoading()) contents.once("did-finish-load", deliver);
  else deliver();
}

/** Narrow an IPC payload before it reaches `new Notification`. */
function readNotification(payload: unknown): ShellNotification | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { title, body, tag } = payload as Partial<ShellNotification>;
  if (typeof title !== "string" || typeof body !== "string" || typeof tag !== "string") {
    return null;
  }
  return { title, body, tag };
}

/**
 * Wire the renderer-facing channels. The page can only reach them through the
 * preload bridge, which is what keeps `ipcRenderer` out of the UI.
 */
function registerDesktopBridge(): void {
  ipcMain.on(NOTIFY_CHANNEL, (event, payload: unknown) => {
    const notice = readNotification(payload);
    if (notice !== null) showShellNotification(notice, event.sender);
  });
  ipcMain.on(BADGE_CHANNEL, (_event, count: unknown) => {
    if (typeof count === "number") applyBadge(count);
  });
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

/** Track the window and forget it when the user closes it (macOS stays alive). */
function adoptWindow(created: BrowserWindow): BrowserWindow {
  window = created;
  created.on("closed", () => {
    if (window === created) window = null;
  });
  // The Windows overlay is a property of the window, so a new one starts bare.
  if (process.platform === "win32" && currentBadge > 0) applyBadge(currentBadge);
  return created;
}

/**
 * The app's one window, recreated if the user closed it. macOS keeps the app
 * (and its server) running after the last window closes, so "closed" is not
 * "quit" there, and both the Dock icon and a notification click have to be able
 * to bring the UI back.
 */
function mainWindow(): BrowserWindow | null {
  if (window !== null && window.isDestroyed()) window = null;
  if (window === null && handle !== null) return adoptWindow(createWindow(handle, appPaths()));
  return window;
}

function quitGracefully(): void {
  trace("quitGracefully");
  shutdown ??= stopServerProcess();
  void shutdown.then(() => app.quit());
}

/** Stops the server whether or not it got as far as being ready. */
async function stopServerProcess(): Promise<void> {
  if (handle !== null) {
    await handle.stop();
    return;
  }
  if (starting !== null) {
    starting.kill("SIGTERM");
    // Startup can also have spawned descendants before health became ready.
    if (process.platform === "win32") killWindowsTree(starting);
    starting = null;
  }
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
  registerDesktopBridge();
  Menu.setApplicationMenu(buildMenu(handle));
  window = adoptWindow(createWindow(handle, paths));

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
    mainWindow()?.focus();
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
