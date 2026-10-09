#!/usr/bin/env node
/**
 * Regenerate the README screenshots.
 *
 * Chrome's `--screenshot` flag hangs on some macOS builds (it never returns;
 * `--dump-dom` works fine), so this drives the DevTools protocol instead:
 * connect to a headless Chrome that was started with
 * `--remote-debugging-port`, navigate, click the project row and then the
 * session row, open the sidebar on the change set, and capture the viewport
 * at 2x.
 *
 * ## What it expects
 *
 * A throwaway demo project outside the repository, whose session was produced
 * by a real `pi` run, and a pi-web-simple serving it. Concretely:
 *
 * ```sh
 * # 1. a tiny project, and a session that actually edits it
 * mkdir -p /tmp/pws-demo/zh-project && cd /tmp/pws-demo/zh-project
 * git init && printf 'export const greet = () => "hello";\n' > greet.js && git add -A && git commit -m init
 * PI_CODING_AGENT_SESSION_DIR=/tmp/pws-demo/sessions \
 *   pi -p --approve "把 greet.js 的问候语改成你好，pi，并在 README 里记一笔，最后跑一次确认"
 *
 * # 2. pi writes the session under its realpath (`/private/tmp/...` on macOS),
 * #    so the project path in the store must be the realpath too.
 * mv /tmp/pws-demo/sessions/--*-zh-project-- /tmp/pws-demo/sessions/--private-tmp-pws-demo-zh-project--
 *
 * # 3. serve it, with an isolated store pointing at that project
 * PI_WEB_SIMPLE_HOME=/tmp/pws-demo/home-zh PI_WEB_SIMPLE_SESSION_DIR=/tmp/pws-demo/sessions \
 *   PI_WEB_SIMPLE_PORT=5477 PI_WEB_SIMPLE_OPEN=0 node server/build/index.js &
 *
 * # 4. a headless Chrome to drive, then this script
 * "$CHROME" --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/chrome \
 *   --no-first-run --disable-gpu --window-size=1600,1150 about:blank &
 * node scripts/screenshots.mjs --lang zh-CN --appearance dark --out docs/images/overview-dark.png
 * ```
 *
 * Repeat step 3 with a second project/session (and `--lang en`) for the
 * English set: `overview-dark.en.png` / `overview-light.en.png`.
 *
 * Options:
 *   --app <url>         pi-web-simple base URL (default http://127.0.0.1:5477)
 *   --cdp <url>         Chrome DevTools endpoint (default http://127.0.0.1:9222)
 *   --lang <tag>        zh-CN | en — pushed through the settings API
 *   --appearance <mode> dark | light
 *   --project <path>    project path to expand; defaults to one under /tmp
 *   --session <hint>    substring of the session file path to click
 *   --out <file>        PNG to write
 */
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const app = arg("app", "http://127.0.0.1:5477");
const cdp = arg("cdp", "http://127.0.0.1:9222");
const lang = arg("lang", "zh-CN");
const appearance = arg("appearance", "dark");
const projectHint = arg("project", "/private/tmp/pws-demo");
const sessionHint = arg("session", "2026-");
const out = arg("out");
if (out === undefined) {
  console.error("--out <file> is required");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A minimal CDP client: one page target, `send(method, params)` per call. */
async function connect() {
  const targets = await (await fetch(`${cdp}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (page === undefined) throw new Error(`no page target at ${cdp}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));

  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.id);
    if (resolve !== undefined) {
      pending.delete(message.id);
      resolve(message);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return res.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const { send, evaluate, close } = await connect();

await fetch(`${app}/api/settings`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ language: lang, appearance }),
});

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1600,
  height: 1150,
  deviceScaleFactor: 2,
  mobile: false,
});
await send("Page.navigate", { url: `${app}/` });
await sleep(4000);

const steps = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const byTitle = (needle) => [...document.querySelectorAll('[title]')].find((el) => (el.getAttribute('title') ?? '').includes(needle));
  const byText = (needles) => [...document.querySelectorAll('button')].find((b) => needles.includes((b.textContent ?? '').trim()));
  const done = [];

  const project = byTitle(${JSON.stringify(projectHint)});
  if (project) { project.click(); done.push('project'); await sleep(800); }

  // The row container carries the session path as its title; the click target is
  // the button inside it.
  const row = byTitle(${JSON.stringify(sessionHint)});
  const sessionButton = row?.querySelector('button');
  if (sessionButton) { sessionButton.click(); done.push('session'); await sleep(3200); }

  const rightbarButton = byTitle('打开右侧栏') ?? byTitle('Open the sidebar');
  if (rightbarButton) { rightbarButton.click(); done.push('rightbar'); await sleep(1000); }

  const newTab = byTitle('新建标签页') ?? byTitle('New tab');

  // The change set is normally the tab the sidebar restores, so this only makes
  // sure it is the one on top. A fresh profile restores the file tree instead,
  // in which case the tab comes from the "+" menu — which is closed again with
  // Escape, because that portal only listens for real pointer events and a
  // synthetic click would leave it open on top of the panel.
  const changesTab = byText(['文件变更', 'Changes']);
  if (changesTab) {
    changesTab.click(); done.push('changes'); await sleep(2000);
  } else if (newTab) {
    newTab.click(); await sleep(600);
    const changesItem = byText(['文件变更', 'Changes']);
    if (changesItem) { changesItem.click(); done.push('changes-new'); await sleep(2000); }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(700);
  }

  // Scroll the transcript back to the top so the shot starts at the first user
  // message. The transcript is a sibling of the composer, not an ancestor, so
  // this climbs the composer's ancestors and takes the tallest overflowing
  // container inside the first one that has any. CSS-module hashes change with
  // every style edit, so nothing here matches on a class name.
  let scroller = null;
  for (let el = document.querySelector('textarea'); el && !scroller; el = el.parentElement) {
    const overflowing = [...el.querySelectorAll('div')].filter((d) => d.scrollHeight > d.clientHeight + 20);
    if (overflowing.length > 0) scroller = overflowing.sort((a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight))[0];
  }
  if (scroller) { scroller.scrollTop = 0; done.push('scrollTop'); await sleep(900); }

  return done.join(',');
})()`);
console.log(`${out} ← ${steps}`);

await sleep(1200);
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
if (shot.result?.data === undefined) throw new Error("captureScreenshot returned no data");
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
close();
