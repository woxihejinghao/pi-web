/**
 * 场景 B —「N 个会话同时 streaming」时服务端事件管道的开销。
 *
 * 链路：load-stub(pi 替身) → RpcClient → registry.onEvent → bus.publish → SSE res.write → 客户端
 * 全部走真实代码（server/src/routes.ts 的 /api/events、registry、bus），
 * 只把 pi 二进制换成产生高频事件的替身，从而零 LLM 成本地压到真实链路上。
 *
 * 用法（在 server workspace 下跑，因为要 import .ts）：
 *   cd server && ./node_modules/.bin/tsx ../bench/scenario-b-streaming.ts
 *
 * 环境变量：
 *   SCENARIOS   NxM 列表（N=并发 streaming 会话数，M=SSE 客户端数），默认 1x1,4x1,8x1,8x4,8x0
 *   LOAD_EVENTS / LOAD_BATCH / LOAD_INTERVAL_MS  透传给 load-stub
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../server/src/bus.ts";
import { SessionRegistry } from "../server/src/registry.ts";
import { createRequestHandler } from "../server/src/routes.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOAD_STUB = join(HERE, "load-stub.mjs");
const TMP = join(HERE, ".bench-tmp", "streaming");
const EVENTS = Number(process.env.LOAD_EVENTS ?? 20000);
/** settled 之后再等这么久才统计，用于区分「真丢事件」与「尾部还在管道里堵着」。 */
const DRAIN_MS = Number(process.env.DRAIN_MS ?? 1500);
const SCENARIOS = (process.env.SCENARIOS ?? "1x1,4x1,8x1,8x4,8x0")
  .split(",")
  .map((spec) => spec.trim())
  .filter(Boolean)
  .map((spec) => {
    const [n, m] = spec.split("x").map(Number);
    return { n: n ?? 1, clients: m ?? 1 };
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ClientStats {
  messageUpdates: number;
  settled: number;
  latencies: number[];
}

const newClientStats = (): ClientStats => ({ messageUpdates: 0, settled: 0, latencies: [] });

function handleSseBlock(block: string, stats: ClientStats): void {
  let dataLine: string | null = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (!dataLine) return;
  let payload: { type?: string; event?: { type?: string; _t?: number } };
  try {
    payload = JSON.parse(dataLine);
  } catch {
    return;
  }
  if (payload.type !== "session_event" || !payload.event) return;
  const event = payload.event;
  if (event.type === "message_update") {
    stats.messageUpdates += 1;
    if (typeof event._t === "number") stats.latencies.push(Date.now() - event._t);
  } else if (event.type === "agent_settled") {
    stats.settled += 1;
  }
}

/** 消费一条 SSE，直到 signal 中止。返回后 stats 即为该客户端的统计。 */
async function consumeSse(url: string, stats: ClientStats, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (!block.startsWith(":")) handleSseBlock(block, stats);
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

interface ScenarioRecord {
  n: number;
  clients: number;
  expectedEvents: number;
  receivedEvents: number;
  lossPercent: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  latencyMax: number;
  wallMs: number;
  throughputPerSec: number;
  cpuPercent: number;
  rssBeforeMb: number;
  rssAfterMb: number;
  rssDeltaMb: number;
}

async function runScenario(n: number, clientCount: number): Promise<ScenarioRecord> {
  const sessionRoot = join(TMP, `sessions-${n}-${clientCount}`);
  const projectPath = join(TMP, "project");
  mkdirSync(sessionRoot, { recursive: true });
  mkdirSync(projectPath, { recursive: true });

  const bus = new EventBus();
  const registry = new SessionRegistry({
    cliPath: LOAD_STUB,
    sessionDir: sessionRoot,
    maxActiveSessions: 64,
  });

  let settledSeen = 0;
  const unsubscribe = registry.onEvent((handle, event) => {
    if (event.type === "agent_settled") settledSeen += 1;
    bus.publish({ type: "session_event", sessionPath: handle.sessionPath, event });
  });

  const server = createServer(createRequestHandler({ registry, bus }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  const stats = Array.from({ length: clientCount }, newClientStats);
  const controller = new AbortController();
  const clientTasks = stats.map((clientStats) =>
    consumeSse(`http://127.0.0.1:${port}/api/events`, clientStats, controller.signal),
  );
  await sleep(250); // 让 SSE 订阅先于事件流建立

  const handles = await Promise.all(
    Array.from({ length: n }, (_unused, i) =>
      registry.open(projectPath, join(sessionRoot, `sess-${i}.jsonl`)),
    ),
  );

  const cpuBefore = process.cpuUsage();
  const rssBeforeMb = process.memoryUsage().rss / 1024 ** 2;
  const startedAt = Date.now();

  await Promise.all(handles.map((handle) => handle.client.prompt("stream")));

  const settled = await waitFor(() => settledSeen >= n, 60_000);
  const settledAt = Date.now();
  await sleep(DRAIN_MS); // 排空管道里剩余的事件

  const wallMs = settledAt - startedAt;
  const cpuAfter = process.cpuUsage();
  const cpuMicros = cpuAfter.user - cpuBefore.user + (cpuAfter.system - cpuBefore.system);

  const latencies = stats.flatMap((clientStats) => clientStats.latencies).sort((a, b) => a - b);
  const receivedEvents = stats.reduce((sum, clientStats) => sum + clientStats.messageUpdates, 0);
  // 每个客户端都应看到全部事件；没有客户端时无接收方，不计入丢失。
  const expectedPerClient = n * EVENTS;
  const expectedEvents = clientCount === 0 ? 0 : expectedPerClient * clientCount;

  const record: ScenarioRecord = {
    n,
    clients: clientCount,
    expectedEvents,
    receivedEvents,
    lossPercent:
      expectedEvents === 0 ? 0 : ((expectedEvents - receivedEvents) / expectedEvents) * 100,
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    latencyP99: percentile(latencies, 99),
    latencyMax: latencies.length ? latencies[latencies.length - 1]! : 0,
    wallMs,
    throughputPerSec: wallMs > 0 ? ((n * EVENTS) / wallMs) * 1000 : 0,
    cpuPercent: (cpuMicros / 1000 / wallMs) * 100,
    rssBeforeMb,
    rssAfterMb: process.memoryUsage().rss / 1024 ** 2,
    rssDeltaMb: process.memoryUsage().rss / 1024 ** 2 - rssBeforeMb,
  };

  controller.abort();
  await Promise.allSettled(clientTasks);
  unsubscribe();
  await registry.closeAll("bench");
  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (!settled) record.lossPercent = Number.NaN;

  return record;
}

console.log("=".repeat(96));
console.log("场景 B：N 个会话同时 streaming — 服务端事件管道吞吐/延迟/CPU");
console.log("=".repeat(96));
console.log(`每会话事件数 : ${EVENTS}    场景(NxM) : ${SCENARIOS.map((s) => `${s.n}x${s.clients}`).join(", ")}`);
console.log("");

const records: ScenarioRecord[] = [];
for (const { n, clients } of SCENARIOS) {
  process.stdout.write(`▶ ${n} 会话 / ${clients} SSE 客户端 ... `);
  const record = await runScenario(n, clients);
  records.push(record);
  console.log(
    `收到 ${record.receivedEvents}，未送达 ${record.lossPercent.toFixed(2)}%，` +
      `P50 ${record.latencyP50}ms / P99 ${record.latencyP99}ms，` +
      `${record.throughputPerSec.toFixed(0)} events/s，CPU ${record.cpuPercent.toFixed(0)}%，` +
      `RSS ${record.rssBeforeMb.toFixed(0)}→${record.rssAfterMb.toFixed(0)}MB`,
  );
  await sleep(500);
  if (global.gc) global.gc();
  await sleep(300);
}

const pad = (value: string | number, width: number) => String(value).padEnd(width);
console.log("");
console.log(
  pad("N×M", 8) +
    pad("期望事件", 11) +
    pad("收到", 11) +
    pad("丢失", 9) +
    pad("P50", 8) +
    pad("P95", 8) +
    pad("P99", 9) +
    pad("吞吐/s", 10) +
    pad("CPU", 8) +
    pad("RSS增量", 10),
);
console.log("-".repeat(96));
for (const r of records) {
  console.log(
    pad(`${r.n}×${r.clients}`, 8) +
      pad(r.expectedEvents, 11) +
      pad(r.receivedEvents, 11) +
      pad(`${r.lossPercent.toFixed(2)}%`, 9) +
      pad(`${r.latencyP50}ms`, 8) +
      pad(`${r.latencyP95}ms`, 8) +
      pad(`${r.latencyP99}ms`, 9) +
      pad(r.throughputPerSec.toFixed(0), 10) +
      pad(`${r.cpuPercent.toFixed(0)}%`, 8) +
      pad(`${r.rssDeltaMb >= 0 ? "+" : ""}${r.rssDeltaMb.toFixed(0)}MB`, 10),
  );
}
console.log("");
console.log(
  `CPU/RSS 取自 bench 进程（server + SSE 客户端同进程），是整条链路的合计开销；` +
    `RSS增量 = 场景结束 − 场景开始（排空 ${DRAIN_MS}ms 后统计）。`,
);

const outFile = join(HERE, "results", "scenario-b.json");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  `${JSON.stringify({ at: new Date().toISOString(), eventsPerSession: EVENTS, drainMs: DRAIN_MS, records }, null, 2)}\n`,
);
console.log(`原始数据 → ${outFile}`);
