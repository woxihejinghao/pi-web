#!/usr/bin/env node
/**
 * 场景 A —「多会话 = 多进程」的真实资源开销。
 *
 * 架构事实（见 server/src/registry.ts）：每个活跃会话对应一个
 * `node <pi>/dist/cli.js --mode rpc` 子进程，活跃上限由
 * PI_WEB_SIMPLE_MAX_SESSIONS 控制（默认 8）。因此「多会话/多工作区同时工作」
 * 的第一层成本就是这 N 个进程的启动延迟与常驻内存。
 *
 * 本脚本做的事：并发拉起 N 个真实 pi RPC 进程，等全部完成 get_state 握手，
 * 再测量空闲稳态下的进程树 RSS 与 CPU。不含任何 LLM 调用，零成本、可复现。
 *
 * 用法：
 *   node bench/scenario-a-processes.mjs
 *   NS=1,2,4,8,16 SETTLE_MS=8000 VARY_CWD=1 node bench/scenario-a-processes.mjs
 *
 * 环境变量：
 *   NS         并发档位，逗号分隔（默认 1,2,4,8）
 *   SETTLE_MS  握手完成后等待多久再量内存（默认 5000；MCP 子进程可能延迟启动）
 *   SAMPLE_MS  CPU 采样窗口（默认 2000）
 *   VARY_CWD   1 = 每个会话用不同的工作区目录（默认 0，同一个）
 *   PI_CLI     pi 的 dist/cli.js 路径
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cpuPercentBetween, fmtMb, processTree, psSnapshot, sleep } from "./lib/ps.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI =
  process.env.PI_CLI ??
  "/Users/milan/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

const NS = (process.env.NS ?? "1,2,4,8")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 5000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 2000);
const VARY_CWD = process.env.VARY_CWD === "1";

const ROOT = join(HERE, "..", ".bench-tmp");
const SESSION_DIR = join(ROOT, "sessions");
mkdirSync(SESSION_DIR, { recursive: true });

/** 给第 i 个会话准备 cwd；VARY_CWD 时每个会话一个目录（模拟多工作区）。 */
function cwdFor(index) {
  const dir = VARY_CWD ? join(ROOT, `project-${index}`) : join(ROOT, "project");
  mkdirSync(dir, { recursive: true });
  return dir;
}
for (let i = 0; i < 32; i++) cwdFor(i);

/**
 * 拉起一个 pi RPC 进程并发 get_state，返回 { child, readyMs, stderrBytes }。
 * 握手成功才 resolve —— 这正是 registry.spawn() 的判据。
 */
function spawnPi(index) {
  const started = Date.now();
  const child = spawn(process.execPath, [CLI, "--mode", "rpc", "--session-dir", SESSION_DIR], {
    cwd: cwdFor(index),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrBytes = 0;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
  });

  const ready = new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      let index_;
      while ((index_ = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index_);
        buffer = buffer.slice(index_ + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "response" && message.command === "get_state") {
          child.stdout.off("data", onData);
          if (message.success === false) reject(new Error(String(message.error)));
          else resolve({ sessionFile: message.data?.sessionFile, sessionId: message.data?.sessionId });
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`pi exited early: ${code}`)));
    child.once("error", reject);
    child.stdin.write(`${JSON.stringify({ id: "handshake", type: "get_state" })}\n`);
  });

  return { child, started, ready, stats: () => ({ readyMs: Date.now() - started, stderrBytes }) };
}

/** 一个档位：并发拉起 N 个进程，测量、记录、清理。 */
async function runTier(n) {
  const spawned = [];
  const t0 = Date.now();
  const readyMs = [];

  const results = await Promise.allSettled(
    Array.from({ length: n }, async (_unused, i) => {
      const entry = spawnPi(i);
      spawned.push(entry);
      const state = await entry.ready;
      readyMs.push(Date.now() - t0);
      return { entry, state };
    }),
  );

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    for (const f of failures) console.error("   spawn 失败:", String(f.reason).slice(0, 160));
  }

  const alive = spawned.filter((e) => e.child.exitCode === null && !e.child.killed);
  const rootPids = alive.map((e) => e.child.pid);

  await sleep(SETTLE_MS);

  // CPU 与内存：空闲稳态下的两次快照差分。
  const rowsBefore = psSnapshot();
  const treeBefore = processTree(rowsBefore, rootPids);
  await sleep(SAMPLE_MS);
  const rowsAfter = psSnapshot();
  const treeAfter = processTree(rowsAfter, rootPids);

  const idleCpuPercent = cpuPercentBetween(treeBefore, treeAfter, SAMPLE_MS);
  // pi 启动时会把进程标题改成 "pi"，`ps -o command=` 因而看不到完整 argv；
  // 用「是否为本次拉起的根 pid」来区分主进程与它派生的子进程更可靠。
  const rootSet = new Set(rootPids);
  const mainProcs = treeAfter.procs.filter((p) => rootSet.has(p.pid));
  const childProcs = treeAfter.procs.filter((p) => !rootSet.has(p.pid));

  const record = {
    n,
    spawned: spawned.length,
    ready: alive.length,
    readyMsMin: readyMs.length ? Math.min(...readyMs) : null,
    readyMsP50: readyMs.length ? [...readyMs].sort((a, b) => a - b)[Math.floor(readyMs.length / 2)] : null,
    readyMsMax: readyMs.length ? Math.max(...readyMs) : null,
    rssKbTotal: treeAfter.rssKb,
    rssKbPerSession: alive.length ? treeAfter.rssKb / alive.length : null,
    treeProcs: treeAfter.procs.length,
    mainProcs: mainProcs.length,
    childProcs: childProcs.length,
    idleCpuPercent,
    stderrBytes: alive.reduce((sum, e) => sum + e.stats().stderrBytes, 0),
  };

  // 清理：SIGTERM，宽限后 SIGKILL。
  for (const entry of spawned) entry.child.kill("SIGTERM");
  await sleep(1200);
  for (const entry of spawned) {
    if (entry.child.exitCode === null) entry.child.kill("SIGKILL");
  }
  await sleep(600);

  return record;
}

function printHeader() {
  const cpu = cpus()[0]?.model ?? "unknown";
  console.log("=".repeat(78));
  console.log("场景 A：多会话 = 多 pi RPC 进程 — 真实资源开销");
  console.log("=".repeat(78));
  console.log(`机器        : ${cpu} / ${cpus().length} 核 / ${(totalmem() / 1024 ** 3).toFixed(0)} GB`);
  console.log(`pi CLI      : ${CLI}`);
  console.log(`并发档位    : ${NS.join(", ")}`);
  console.log(`工作区模式  : ${VARY_CWD ? "每会话一个工作区目录" : "同一工作区"}`);
  console.log(`settle/采样 : ${SETTLE_MS}ms / ${SAMPLE_MS}ms`);
  console.log("");
}

function printTable(records) {
  const pad = (value, width) => String(value).padEnd(width);
  console.log(
    `${pad("N", 4)}${pad("就绪", 6)}${pad("握手max", 10)}${pad("总RSS", 11)}${pad("单会话", 11)}${pad("进程树", 9)}${pad("空闲CPU", 10)}`,
  );
  console.log("-".repeat(78));
  for (const r of records) {
    console.log(
      pad(r.n, 4) +
        pad(`${r.ready}/${r.spawned}`, 6) +
        pad(r.readyMsMax === null ? "-" : `${r.readyMsMax}ms`, 10) +
        pad(fmtMb(r.rssKbTotal), 11) +
        pad(r.rssKbPerSession === null ? "-" : fmtMb(r.rssKbPerSession), 11) +
        pad(`${r.treeProcs}(${r.mainProcs}+${r.childProcs})`, 9) +
        pad(`${r.idleCpuPercent.toFixed(1)}%`, 10),
    );
  }
  console.log("");
  console.log("进程树 = 进程总数(pi主进程 + 派生/MCP子进程)");
}

printHeader();

const records = [];
for (const n of NS) {
  process.stdout.write(`▶ N=${n} 拉起中 ... `);
  const record = await runTier(n);
  records.push(record);
  console.log(
    `就绪 ${record.ready}/${record.spawned}，握手 max ${record.readyMsMax}ms，` +
      `RSS ${fmtMb(record.rssKbTotal)}（单会话 ${fmtMb(record.rssKbPerSession ?? 0)}），` +
      `空闲 CPU ${record.idleCpuPercent.toFixed(1)}%`,
  );
  await sleep(2000); // 档位之间让系统冷却，避免上一档残留干扰
}

console.log("");
printTable(records);

const outFile = join(HERE, "results", `scenario-a${VARY_CWD ? "-multicwd" : "-singlecwd"}.json`);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      at: new Date().toISOString(),
      machine: { cpu: cpus()[0]?.model, cores: cpus().length, memGb: totalmem() / 1024 ** 3 },
      cli: CLI,
      varyCwd: VARY_CWD,
      settleMs: SETTLE_MS,
      sampleMs: SAMPLE_MS,
      records,
    },
    null,
    2,
  )}\n`,
);
console.log(`原始数据 → ${outFile}`);
