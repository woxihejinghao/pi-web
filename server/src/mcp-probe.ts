/**
 * A one-shot MCP connection check for a configured server.
 *
 * This performs the same handshake pi does on startup — `initialize`, then
 * `tools/list` for stdio — and reports the outcome in one line. It exists
 * because "检查" is the only way to answer *would this definition work?* without
 * spending a cold start on a real session, and because a definition typed into
 * the settings page has no other way to be validated.
 *
 * It runs only when the user asks for it. A stdio server is an arbitrary
 * command; `npx -y something@latest` in particular can spend a minute
 * downloading before it ever speaks the protocol, which is why the timeout is
 * generous and why nothing here happens on page load.
 *
 * Scope: stdio and HTTP(S). The rmcp-mux socket transport is reported as
 * unsupported rather than guessed at.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerEntry } from "./mcp.ts";

/** Long enough for a cold `npx` download, short enough to not feel hung. */
export const PROBE_TIMEOUT_MS = 15_000;

/** What the client offers; the server answers with the revision it supports. */
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "pi-web-simple", version: "0.1.0" };

export interface McpProbeResult {
  ok: boolean;
  /** One line for the row and the dialog, already in Chinese. */
  message: string;
  /** From `tools/list`, when the handshake got that far. */
  toolCount?: number;
  serverName?: string;
  serverVersion?: string;
  durationMs: number;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown };
}

function summarize(value: unknown, limit = 200): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

function initializeRequest(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  });
}

function toolCountOf(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const tools = (result as { tools?: unknown }).tools;
  return Array.isArray(tools) ? tools.length : undefined;
}

function serverInfoOf(result: unknown): { name?: string; version?: string } {
  if (typeof result !== "object" || result === null) return {};
  const info = (result as { serverInfo?: unknown }).serverInfo;
  if (typeof info !== "object" || info === null) return {};
  const { name, version } = info as { name?: unknown; version?: unknown };
  return {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof version === "string" ? { version } : {}),
  };
}

/** Turn a JSON-RPC error object into something worth reading. */
function errorMessage(response: JsonRpcResponse): string {
  const message = response.error?.message;
  return typeof message === "string" && message.length > 0
    ? `服务端返回错误：${summarize(message)}`
    : "服务端返回了一个无法解析的错误。";
}

// --- stdio ------------------------------------------------------------------

function probeStdio(entry: McpServerEntry, timeoutMs: number): Promise<McpProbeResult> {
  const command = entry.command as string;
  const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === "string") : [];
  const started = Date.now();

  return new Promise<McpProbeResult>((resolve) => {
    let settled = false;
    let child: ChildProcessWithoutNullStreams | null = null;
    let buffer = "";
    let stderr = "";
    let toolCount: number | undefined;
    let info: { name?: string; version?: string } = {};

    const finish = (result: Omit<McpProbeResult, "durationMs">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A server that answered may still be running; the check has no further
      // use for it, and leaving it would leak one process per click.
      child?.kill("SIGTERM");
      resolve({ ...result, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        message: `连接超时（${Math.round(timeoutMs / 1000)} 秒）：命令未完成 MCP 握手。`,
      });
    }, timeoutMs);

    try {
      child = spawn(command, args, {
        cwd: typeof entry.cwd === "string" && entry.cwd.length > 0 ? entry.cwd : undefined,
        // Same environment rule as the adapter for a default stdio server:
        // inherit, then let the entry override individual variables.
        env: { ...process.env, ...(entry.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ ok: false, message: `无法启动 ${command}：${(err as Error).message}` });
      return;
    }

    child.on("error", (err) => {
      finish({
        ok: false,
        message: `无法启动 ${command}：${(err as Error).message}`,
      });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      // Kept only for the failure message; many servers log every request here.
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on("exit", (code) => {
      finish({
        ok: false,
        message:
          `进程退出（code ${code ?? "null"}）` + (stderr.trim().length > 0 ? `：${summarize(stderr)}` : "。"),
      });
    });

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.length === 0) continue;

        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          // A server that prints banners to stdout before the protocol starts
          // is common enough; ignore anything that is not JSON-RPC.
          continue;
        }

        if (message.id === 1) {
          if (message.error !== undefined) {
            finish({ ok: false, message: errorMessage(message) });
            return;
          }
          info = serverInfoOf(message.result);
          // Handshake done. Ask for the tool list on the same connection, and
          // answer as soon as it arrives: knowing *how many* tools a server
          // publishes is most of what makes this check useful.
          child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
          continue;
        }

        if (message.id === 2) {
          toolCount = toolCountOf(message.result);
          finish({
            ok: true,
            message:
              toolCount === undefined
                ? "握手成功。"
                : `握手成功，服务端公布 ${toolCount} 个工具。`,
            ...(toolCount === undefined ? {} : { toolCount }),
            ...(info.name === undefined ? {} : { serverName: info.name }),
            ...(info.version === undefined ? {} : { serverVersion: info.version }),
          });
          return;
        }
      }
    });

    child.stdin.write(`${initializeRequest(1)}\n`);
  });
}

// --- HTTP(S) ----------------------------------------------------------------

/** Pull the JSON-RPC payload out of a streamable-HTTP (SSE) response body. */
function parseEventStream(text: string): JsonRpcResponse | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    try {
      return JSON.parse(trimmed.slice(5).trim()) as JsonRpcResponse;
    } catch {
      continue;
    }
  }
  return null;
}

async function probeHttp(entry: McpServerEntry, timeoutMs: number): Promise<McpProbeResult> {
  const url = entry.url as string;
  const started = Date.now();
  const done = (result: Omit<McpProbeResult, "durationMs">): McpProbeResult => ({
    ...result,
    durationMs: Date.now() - started,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Streamable HTTP servers may answer either way; asking for both is what
        // the spec expects from a client that speaks the current revision.
        accept: "application/json, text/event-stream",
        ...(entry.headers ?? {}),
      },
      body: initializeRequest(1),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
  } catch (err) {
    const cause = (err as Error).name === "TimeoutError" ? "请求超时" : (err as Error).message;
    return done({ ok: false, message: `无法连接 ${url}：${cause}` });
  }

  if (!response.ok) {
    const detail = summarize(await response.text().catch(() => ""));
    return done({
      ok: false,
      message: `服务端返回 HTTP ${response.status}${detail.length > 0 ? `：${detail}` : ""}`,
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text().catch(() => "");
  let message: JsonRpcResponse | null = null;
  if (contentType.includes("text/event-stream")) {
    message = parseEventStream(text);
  } else {
    try {
      message = JSON.parse(text) as JsonRpcResponse;
    } catch {
      message = null;
    }
  }

  if (message === null) {
    // A 200 that is not JSON-RPC is the classic misconfiguration: the URL points
    // at a web page or a proxy, not at an MCP endpoint.
    return done({
      ok: false,
      message: `响应不是 JSON-RPC${detailSuffix(text)}——这个地址看起来不像 MCP 端点。`,
    });
  }
  if (message.error !== undefined) {
    return done({ ok: false, message: errorMessage(message) });
  }

  const info = serverInfoOf(message.result);
  // The tool list would need the session id from this response and a second
  // round trip; the row reports the handshake for remote servers instead.
  return done({
    ok: true,
    message: `握手成功${info.name === undefined ? "。" : `（${info.name}${info.version === undefined ? "" : ` ${info.version}`}）`}`,
    ...(info.name === undefined ? {} : { serverName: info.name }),
    ...(info.version === undefined ? {} : { serverVersion: info.version }),
  });
}

function detailSuffix(text: string): string {
  const detail = summarize(text, 120);
  return detail.length > 0 ? `（${detail}）` : "";
}

// --- entry point ------------------------------------------------------------

export async function probeMcpEntry(
  entry: McpServerEntry,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<McpProbeResult> {
  if (typeof entry.command === "string" && entry.command.length > 0) {
    return await probeStdio(entry, timeoutMs);
  }
  if (typeof entry.url === "string" && entry.url.length > 0) {
    return await probeHttp(entry, timeoutMs);
  }
  if (typeof entry.socket === "string" && entry.socket.length > 0) {
    return {
      ok: false,
      message: "socket 传输（rmcp-mux）暂不支持检查。",
      durationMs: 0,
    };
  }
  return {
    ok: false,
    message: "这条定义既没有 command 也没有 url，无法连接到任何地方。",
    durationMs: 0,
  };
}
