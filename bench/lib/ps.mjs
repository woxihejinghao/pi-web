/**
 * 进程树采样工具（macOS/Linux 通用，基于 `ps`，无第三方依赖）。
 *
 * 为什么需要「进程树」而不是「单个 pid」：一个 pi 会话进程可能再派生
 * 子进程（MCP server、npx 包装等）。只量父进程会低估多会话的真实成本。
 */
import { execFileSync } from "node:child_process";

/** `ps -o time=` 的 `[[hh:]mm:]ss.ss` → 累计 CPU 秒。 */
function parseCpuTime(text) {
  const parts = text.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

/**
 * 一次全量快照。字段：
 *   pid / ppid / rssKb（常驻内存）/ cpuSeconds（进程生命周期累计 CPU 时间）
 */
export function psSnapshot() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  const rows = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // command 允许包含空格，所以只对前四列做固定切分。
    const m = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      cpuSeconds: parseCpuTime(m[4]),
      command: m[5],
    });
  }
  return rows;
}

/**
 * 收集若干个根 pid 的完整进程树。
 * 返回 { procs, rssKb, cpuSeconds, rootCount }。
 */
export function processTree(rows, rootPids) {
  const byParent = new Map();
  for (const row of rows) {
    const list = byParent.get(row.ppid);
    if (list) list.push(row);
    else byParent.set(row.ppid, [row]);
  }

  const seen = new Set();
  const queue = [...rootPids];
  const procs = [];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.find((r) => r.pid === pid);
    if (row) procs.push(row);
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }

  let rssKb = 0;
  let cpuSeconds = 0;
  for (const p of procs) {
    rssKb += p.rssKb;
    cpuSeconds += p.cpuSeconds;
  }
  return { procs, rssKb, cpuSeconds };
}

/** 两次采样之间，进程树消耗的 CPU 百分比（相对单核）。 */
export function cpuPercentBetween(before, after, elapsedMs) {
  const delta = after.cpuSeconds - before.cpuSeconds;
  return elapsedMs > 0 ? (delta / (elapsedMs / 1000)) * 100 : 0;
}

export const fmtMb = (kb) => `${(kb / 1024).toFixed(1)} MB`;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
