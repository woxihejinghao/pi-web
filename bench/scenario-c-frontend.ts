/**
 * 场景 C — 把「前端主线程渲染成本」算进来。
 *
 * 前两个场景只测到服务端把事件写出 SSE。真实链路还有一段：浏览器
 * `EventSource` → `actions.emitSessionEvent` → `useConversation.handleEvent`
 * → `setView` → React 重渲染整棵对话树。`useConversation` 里每个事件
 * （包括每个 text_delta）都会无条件 `publish()`，所以这段成本随事件数线性增长。
 *
 * 本脚本用**真实前端产物**（vite build + preview）+ **真实 Chrome**（headless，
 * 通过 CDP 驱动）测这段成本，pi 进程仍用 load-stub 替身，零 LLM 成本。
 *
 * 用法（先构建前端）：
 *   pnpm --filter web build
 *   cd server && ./node_modules/.bin/tsx ../bench/scenario-c-frontend.ts
 *
 * 环境变量：
 *   C_SESSIONS   fixture 里造多少个会话（默认 8）
 *   C_TURNS      每个会话的历史轮数（默认 40）
 *   LOAD_EVENTS  每个会话这次 streaming 发多少事件（默认 2000）
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpConnection, findChromeTarget } from "./lib/cdp.mjs";
import { sanitizeProjectDirName, writeSessionFile } from "./lib/fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const ROOT = join(HERE, ".bench-tmp", `frontend-${process.pid}`);
const PROJECT_DIR = join(ROOT, "project");
const HOME_DIR = join(ROOT, "home");
const SESSION_ROOT = join(ROOT, "sessions");
const CHROME_PROFILE = join(ROOT, "chrome-profile");

/** 挑一个空闲端口。默认值（4319/5319/9222）常被正在运行的实例占着。 */
async function findFreePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    const free = await new Promise((resolve) => {
      const probe = createNetServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error(`no free port from ${start}`);
}

const API_PORT = await findFreePort(4400);
const WEB_PORT = await findFreePort(API_PORT + 1);
const CDP_PORT = await findFreePort(WEB_PORT + 1);
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LOAD_STUB = join(HERE, "load-stub.mjs");
const DIST_INDEX = join(REPO, "web", "dist", "index.html");

const SESSIONS = Number(process.env.C_SESSIONS ?? 8);
const TURNS = Number(process.env.C_TURNS ?? 40);
const EVENTS = Number(process.env.LOAD_EVENTS ?? 2000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.error(`[c] ${message}`);

// config.ts 在模块加载时读取这些变量，所以必须赶在动态 import 之前设好。
process.env.PI_WEB_SIMPLE_HOME = HOME_DIR;
process.env.PI_WEB_SIMPLE_SESSION_DIR = SESSION_ROOT;
process.env.PI_WEB_SIMPLE_PORT = String(API_PORT);

if (!existsSync(DIST_INDEX)) {
  console.error(`前端产物不存在：${DIST_INDEX}\n先跑 pnpm --filter web build`);
  process.exit(1);
}

// ---------------------------------------------------------------- fixture ---

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(PROJECT_DIR, { recursive: true });
mkdirSync(HOME_DIR, { recursive: true });

const projectPath = realpathSync(PROJECT_DIR);
const sessionDir = join(SESSION_ROOT, sanitizeProjectDirName(projectPath));
const sessionPaths = [];
const startedAt = Date.now();

for (let index = 0; index < SESSIONS; index += 1) {
  sessionPaths.push(
    writeSessionFile(sessionDir, {
      fileName: `bench-${String(index).padStart(2, "0")}.jsonl`,
      id: `bench-session-${index}`,
      cwd: projectPath,
      turns: TURNS,
      startedAt: startedAt - (SESSIONS - index) * 3600_000,
    }),
  );
}
// 侧栏按 modified 倒序、默认只展开 5 个（ProjectTree 的 PAGE_SIZE），
// 所以当前会话必须选最新的那个，否则它在 DOM 里根本不存在。
const currentSession = sessionPaths[sessionPaths.length - 1];

writeFileSync(
  join(HOME_DIR, "store.json"),
  `${JSON.stringify(
    {
      version: 1,
      projects: [
        {
          id: "bench-project",
          path: projectPath,
          title: "bench-project",
          order: 0,
          createdAt: new Date(startedAt).toISOString(),
          updatedAt: new Date(startedAt).toISOString(),
        },
      ],
      sessionOverrides: {},
    },
    null,
    2,
  )}\n`,
);

// ------------------------------------------------------------ 真实 server ---

const { SessionRegistry } = await import("../server/src/registry.ts");
const { EventBus } = await import("../server/src/bus.ts");
const { createRequestHandler } = await import("../server/src/routes.ts");

const bus = new EventBus();
const registry = new SessionRegistry({
  cliPath: LOAD_STUB,
  sessionDir: SESSION_ROOT,
  maxActiveSessions: 64,
});
registry.onEvent((handle, event) => {
  bus.publish({ type: "session_event", sessionPath: handle.sessionPath, event });
});
registry.onClosed((handle, reason) => {
  bus.publish({ type: "session_closed", sessionPath: handle.sessionPath, reason });
});

const handler = createRequestHandler({ registry, bus, sessionRoot: SESSION_ROOT });
const server = createServer((req, res) => {
  void handler(req, res);
});
await new Promise((resolve) => server.listen(API_PORT, "127.0.0.1", () => resolve()));
log(`server listening on ${API_PORT}`);

const promptUrl = (sessionPath) =>
  `http://127.0.0.1:${API_PORT}/api/sessions/${encodeURIComponent(sessionPath)}/prompt`;

const sendPrompt = (sessionPath) =>
  fetch(promptUrl(sessionPath), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "stream" }),
  }).then((response) => {
    if (!response.ok) throw new Error(`prompt failed: ${response.status}`);
  });

// --------------------------------------------------------------- 前端预览 ---

const viteBin = join(REPO, "web", "node_modules", ".bin", "vite");
// dev 模式只用来「拿到可读的函数名做归因」；真实数字以生产构建为准。
const DEV = process.env.C_DEV === "1";
const preview = spawn(
  viteBin,
  [DEV ? "dev" : "preview", "--port", String(WEB_PORT), "--strictPort"],
  {
    cwd: join(REPO, "web"),
    env: { ...process.env, PI_WEB_SIMPLE_PORT: String(API_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
preview.stderr.setEncoding("utf8");
preview.stderr.on("data", (chunk) => process.stderr.write(`[preview] ${chunk}`));

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`no response from ${url}`);
}
await waitForHttp(`http://127.0.0.1:${WEB_PORT}/`, 30_000);
log(`preview ready on ${WEB_PORT}`);

// ----------------------------------------------------------------- Chrome ---

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
chrome.stderr.setEncoding("utf8");
// Chrome 的 stderr 绝大部分是 updater/crashpad/显示链路的噪声；只在需要时看它。
chrome.stderr.on("data", () => undefined);
chrome.on("exit", (code, signal) => {
  if (code !== 0 && signal !== "SIGTERM") log(`chrome exited code=${code} signal=${signal}`);
});

const target = await findChromeTarget(CDP_PORT);
log(`chrome target found on ${CDP_PORT}`);
const cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Performance.enable");
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
  source: readFileSync(join(HERE, "frontend-measure.js"), "utf8"),
});

async function waitForEval(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`!!(${predicate})`)) return true;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label ?? predicate}`);
}

const loadEvent = cdp.waitFor("Page.loadEventFired", { timeoutMs: 30_000 });
await cdp.send("Page.navigate", { url: `http://127.0.0.1:${WEB_PORT}/` });
await loadEvent;
await waitForEval(`window.__bench`, 10_000, "measure probe");
log("page loaded, probe installed");

// 侧栏出现工作区 → 点开 → 点会话。项目节点有时默认已展开，所以顺序自适应。
await waitForEval(
  `document.querySelector('div[title=${JSON.stringify(projectPath)}]')`,
  20_000,
  "project row",
);
log("project row present");

await waitForEval(
  `(() => {
     const session = document.querySelector('div[title=${JSON.stringify(currentSession)}] button');
     if (session) { session.click(); return true; }
     const project = document.querySelector('div[title=${JSON.stringify(projectPath)}] button');
     if (project) { project.click(); return false; }
     return false;
   })()`,
  30_000,
  "session selected",
);
log("session selected");

// 历史加载完成的判据：最后一条 fixture 回复出现在 DOM 里。
if (TURNS > 0) {
  await waitForEval(
    `document.body.innerText.includes(${JSON.stringify(`回答 ${TURNS}`)})`,
    30_000,
    "transcript rendered",
  );
  log("transcript rendered");
} else {
  await sleep(1500);
  log("empty transcript (TURNS=0)");
}

// 预热所有会话的 pi 进程，让 spawn 开销落在场景之外。
await Promise.all(
  sessionPaths.map((sessionPath) =>
    fetch(`http://127.0.0.1:${API_PORT}/api/sessions/${encodeURIComponent(sessionPath)}/state`),
  ).map((p) => p.catch(() => undefined)),
);
await sleep(1500);
log("sessions prewarmed");

// dev 模式下再包一层 appStore，用来定位「谁在驱动重渲染」。
if (DEV) {
  const wrapped = await cdp.evaluate(`(async () => {
    const mod = await import('/src/lib/app-state.ts');
    const store = mod.appStore;
    window.__appUpdates = { set: 0, update: 0 };
    const set = store.set.bind(store);
    const update = store.update.bind(store);
    store.set = (value) => { window.__appUpdates.set += 1; return set(value); };
    store.update = (fn) => { window.__appUpdates.update += 1; return update(fn); };
    return true;
  })()`);
  log(`appStore instrumented: ${wrapped}`);
}

// ------------------------------------------------------------------ 场景 ---

function metricsToObject(result) {
  const out = {};
  for (const metric of result.metrics ?? []) out[metric.name] = metric.value;
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

const shortUrl = (url) => {
  if (!url) return "(vm)";
  try {
    return new URL(url).pathname.split("/").pop() || url;
  } catch {
    return url;
  }
};

/** 把 CDP CPU profile 按「函数 + 文件」聚合自身耗时（微秒），并分离 idle。 */
function aggregateProfile(profile, topN) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let idleMicros = 0;
  let totalMicros = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const node = byId.get(samples[i]);
    if (!node) continue;
    const delta = deltas[i] ?? 0;
    totalMicros += delta;
    const frame = node.callFrame;
    const name = frame.functionName || "(anonymous)";
    if (name === "(idle)") {
      idleMicros += delta;
      continue;
    }
    const key = `${name} @ ${shortUrl(frame.url)}:${frame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + delta);
  }

  return {
    top: [...self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([key, micros]) => ({ key, ms: Math.round(micros / 1000) })),
    idleMs: Math.round(idleMicros / 1000),
    totalMs: Math.round(totalMicros / 1000),
  };
}

async function runScenario(label, promptTargets) {
  await cdp.evaluate("window.__benchReset()");
  if (DEV) await cdp.evaluate("window.__appUpdates = { set: 0, update: 0 }");
  const perfBefore = metricsToObject(await cdp.send("Performance.getMetrics"));
  const cpuBefore = process.cpuUsage();
  await cdp.send("Profiler.start");

  if (promptTargets.length > 0) {
    await Promise.all(promptTargets.map(sendPrompt));
    await waitForEval(
      `window.__bench.agentSettled >= ${promptTargets.length}`,
      120_000,
      `${label} settled`,
    );
    await sleep(1500); // 最后一次 setView + paint 落定
  } else {
    await sleep(2500); // 基线与有事件场景保持同样的观测窗口
  }

  const snap = await cdp.evaluate("window.__benchSnapshot()");
  const { profile } = await cdp.send("Profiler.stop");
  const perfAfter = metricsToObject(await cdp.send("Performance.getMetrics"));
  const cpuAfter = process.cpuUsage();
  // 诊断：当前会话空闲的场景里，页面上会不会出现流式文本（load-stub 的 delta）。
  const diagnostic = await cdp.evaluate(`({
    hasStreamingText: document.body.innerText.includes("lorem ipsum"),
    bodyLength: document.body.innerText.length,
  })`);

  const updates = snap.updateTimes;
  const spanMs =
    snap.firstEventAt !== null && snap.lastUpdateAt !== null
      ? snap.lastUpdateAt - snap.firstEventAt
      : 0;
  const gaps = [];
  for (let i = 1; i < updates.length; i += 1) gaps.push(updates[i] - updates[i - 1]);
  gaps.sort((a, b) => a - b);

  const longTasks = snap.longTasks;
  const longTaskTotal = longTasks.reduce((sum, t) => sum + t.duration, 0);
  const frames = snap.frames.filter((f) => f > 0 && f < 5000).sort((a, b) => a - b);
  const jankyFrames = frames.filter((f) => f > 50).length;

  const taskMs = ((perfAfter.TaskDuration ?? 0) - (perfBefore.TaskDuration ?? 0)) * 1000;
  const scriptMs = ((perfAfter.ScriptDuration ?? 0) - (perfBefore.ScriptDuration ?? 0)) * 1000;
  const layoutMs = ((perfAfter.LayoutDuration ?? 0) - (perfBefore.LayoutDuration ?? 0)) * 1000;
  const styleMs =
    ((perfAfter.RecalcStyleDuration ?? 0) - (perfBefore.RecalcStyleDuration ?? 0)) * 1000;

  const profiling = aggregateProfile(profile, 6);

  const record = {
    label,
    sessionsStreaming: promptTargets.length,
    currentSessionStreaming: promptTargets.includes(currentSession),
    messageUpdates: snap.messageUpdates,
    agentSettled: snap.agentSettled,
    reactCommits: snap.reactCommits,
    commitsPerEvent:
      snap.messageUpdates > 0 ? snap.reactCommits / snap.messageUpdates : 0,
    /** 事件在主线程被处理的墙钟跨度：远大于服务端产生时长即为积压。 */
    spanMs: Math.round(spanMs),
    gapP50: Math.round(percentile(gaps, 50)),
    gapP95: Math.round(percentile(gaps, 95)),
    gapMax: Math.round(gaps.length ? gaps[gaps.length - 1] : 0),
    longTaskCount: longTasks.length,
    longTaskTotalMs: Math.round(longTaskTotal),
    longTaskMaxMs: Math.round(longTasks.reduce((max, t) => Math.max(max, t.duration), 0)),
    frames: frames.length,
    jankyFrames,
    jankyPercent: frames.length ? (jankyFrames / frames.length) * 100 : null,
    /** Profiler 口径：观测窗口内主线程真正干活的时间。 */
    busyMs: profiling.totalMs - profiling.idleMs,
    idleMs: profiling.idleMs,
    taskMs: Math.round(taskMs),
    scriptMs: Math.round(scriptMs),
    layoutMs: Math.round(layoutMs),
    styleMs: Math.round(styleMs),
    /** 每个 message_update 平均占用的主线程时间：跨会话对比的核心指标。 */
    busyMsPerEvent:
      snap.messageUpdates > 0 ? (profiling.totalMs - profiling.idleMs) / snap.messageUpdates : 0,
    benchCpuMs: (cpuAfter.user - cpuBefore.user + (cpuAfter.system - cpuBefore.system)) / 1000,
    appStoreUpdates: DEV ? await cdp.evaluate("window.__appUpdates") : null,
    renderedStreamingText: diagnostic.hasStreamingText,
    topFunctions: profiling.top,
  };

  await sleep(2000); // 场景间隔，避免上一轮渲染/GC 干扰下一轮
  return record;
}

const others = sessionPaths.filter((path) => path !== currentSession);
const scenarios = [
  ["0: 基线（无 streaming）", []],
  ["A: 仅当前会话 streaming", [currentSession]],
  [`B: ${sessionPaths.length} 会话并发（含当前会话）`, sessionPaths.slice()],
  [`C: ${others.length} 个非当前会话并发（当前空闲）`, others],
];

console.log("=" .repeat(96));
console.log(
  `场景 C：前端主线程渲染成本（真实 Chrome headless + ${DEV ? "vite dev（仅用于函数名归因）" : "生产构建"}）`,
);
console.log("=".repeat(96));
console.log(
  `会话数 ${SESSIONS}（历史 ${TURNS} 轮/会话），每会话 ${EVENTS} 个 message_update，` +
    `当前会话 = ${currentSession.split("/").pop()}`,
);
console.log("");

const records = [];
for (const [label, targets] of scenarios) {
  process.stdout.write(`▶ ${label} ... `);
  const record = await runScenario(label, targets);
  records.push(record);
  console.log(
    `${record.messageUpdates} 事件，render ${record.reactCommits} 次，` +
      `页面含流式文本=${record.renderedStreamingText}，` +
      `跨度 ${record.spanMs}ms，主线程忙 ${record.busyMs}ms（每事件 ${record.busyMsPerEvent.toFixed(3)}ms）`,
  );
}

const pad = (value, width) => String(value).padEnd(width);
console.log("");
console.log(
  pad("场景", 34) +
    pad("事件", 9) +
    pad("render", 9) +
    pad("流式文本", 10) +
    pad("render/事件", 12) +
    pad("跨度", 9) +
    pad("主线程忙", 10) +
    pad("忙/事件", 10),
);
console.log("-".repeat(114));
for (const r of records) {
  console.log(
    pad(r.label, 34) +
      pad(r.messageUpdates, 9) +
      pad(r.reactCommits, 9) +
      pad(String(r.renderedStreamingText), 10) +
      pad(r.commitsPerEvent.toFixed(2), 12) +
      pad(`${r.spanMs}ms`, 9) +
      pad(`${r.busyMs}ms`, 10) +
      pad(`${r.busyMsPerEvent.toFixed(3)}ms`, 10),
  );
}
console.log("");
console.log("跨度 = 第一个事件到最后一个事件被主线程处理的墙钟时间；服务端产生这些事件仅需约 2s。");
console.log("主线程忙/空闲 = CDP CPU Profiler 的采样归属（可信，基线约 50ms）。");
console.log("Task* = Performance.getMetrics 的 TaskDuration，本环境下与 Profiler 不一致，仅作参考。");
console.log("");
for (const r of records) {
  console.log(`【${r.label}】主线程 top 自耗时：`);
  for (const fn of r.topFunctions) console.log(`    ${String(fn.ms).padStart(5)}ms  ${fn.key}`);
}

const outFile = join(HERE, "results", "scenario-c.json");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      at: new Date().toISOString(),
      sessions: SESSIONS,
      turns: TURNS,
      eventsPerSession: EVENTS,
      currentSession,
      records,
    },
    null,
    2,
  )}\n`,
);
console.log(`原始数据 → ${outFile}`);

// ------------------------------------------------------------------ 清理 ---

cdp.close();
chrome.kill("SIGTERM");
preview.kill("SIGTERM");
await registry.closeAll("bench");
await new Promise((resolve) => server.close(() => resolve()));
await sleep(500);
rmSync(ROOT, { recursive: true, force: true });
