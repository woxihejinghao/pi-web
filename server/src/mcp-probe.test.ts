import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeMcpEntry } from "./mcp-probe.ts";

/**
 * The check spawns whatever command a stdio entry names, so these tests use
 * this node binary with a tiny inline script rather than anything from the
 * machine — including for the failure paths, which are the interesting ones.
 */
const NODE = process.execPath;

/** A minimal stdio server that answers initialize and tools/list. */
const STDIO_SERVER = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: 1,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub", version: "9.9" } },
      }) + "\\n");
    }
    if (message.id === 2) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: 2,
        result: { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] },
      }) + "\\n");
    }
  }
});
`;

/** A process that stays alive without ever speaking the protocol. */
const SILENT = "setTimeout(() => {}, 60000);";

function stdioEntry(script: string): { command: string; args: string[] } {
  return { command: NODE, args: ["-e", script] };
}

describe("probeMcpEntry over stdio", () => {
  it("reports the server name and tool count after a successful handshake", async () => {
    const result = await probeMcpEntry(stdioEntry(STDIO_SERVER), 10_000);

    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(3);
    expect(result.serverName).toBe("stub");
    expect(result.serverVersion).toBe("9.9");
    expect(result.message).toContain("3 个工具");
  });

  it("reports a command that cannot be started", async () => {
    const result = await probeMcpEntry(
      { command: "definitely-not-a-real-command-piws", args: [] },
      5_000,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/无法启动/);
  });

  it("times out on a process that never answers", async () => {
    const result = await probeMcpEntry(stdioEntry(SILENT), 400);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/连接超时/);
  });

  it("says so when the entry cannot connect anywhere", async () => {
    const result = await probeMcpEntry({}, 1000);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/command 也没有 url/);
  });

  it("declines the socket transport rather than guessing", async () => {
    const result = await probeMcpEntry({ socket: "/tmp/rmcp-mux.sock" }, 1000);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/socket/);
  });
});

describe("probeMcpEntry over HTTP", () => {
  let jsonServer: Server;
  let htmlServer: Server;
  let jsonUrl: string;
  let htmlUrl: string;

  beforeAll(async () => {
    jsonServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { serverInfo: { name: "http-stub", version: "1.2" } },
        }),
      );
    });
    htmlServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>not an mcp endpoint</body></html>");
    });
    await new Promise<void>((resolve) => jsonServer.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => htmlServer.listen(0, "127.0.0.1", resolve));
    jsonUrl = `http://127.0.0.1:${(jsonServer.address() as AddressInfo).port}/mcp`;
    htmlUrl = `http://127.0.0.1:${(htmlServer.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => jsonServer.close(() => resolve()));
    await new Promise<void>((resolve) => htmlServer.close(() => resolve()));
  });

  it("accepts a JSON-RPC initialize response", async () => {
    const result = await probeMcpEntry({ url: jsonUrl }, 5000);
    expect(result.ok).toBe(true);
    expect(result.serverName).toBe("http-stub");
  });

  it("rejects a 200 that is not JSON-RPC", async () => {
    const result = await probeMcpEntry({ url: htmlUrl }, 5000);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/不像 MCP 端点/);
  });

  it("reports an unreachable address", async () => {
    // Port 1 is reserved and never listening.
    const result = await probeMcpEntry({ url: "http://127.0.0.1:1/mcp" }, 3000);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/无法连接/);
  });
});
