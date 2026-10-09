import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TITLE_OUTPUT_TOKENS } from "./config.ts";
import type { ProviderConnection } from "./models.ts";
import { completeTitle } from "./title-llm.ts";

/** A local stand-in for a provider, so these tests never touch the network. */
let server: Server;
let base: string;
let received: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[];
let respond: (res: ServerResponse) => void;

beforeEach(async () => {
  received = [];
  respond = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "Log in again" } }] }));
  };
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      received.push({
        url: req.url ?? "",
        headers: req.headers,
        body: raw.length > 0 ? JSON.parse(raw) : {},
      });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function connection(api: string | null, apiKey: string | undefined = "sk-test"): ProviderConnection {
  return { id: "local", baseUrl: base, api, apiKey, models: [] };
}

describe("completeTitle", () => {
  it("speaks OpenAI to an OpenAI-shaped endpoint", async () => {
    const title = await completeTitle({
      connection: connection("openai-completions"),
      model: "cheap-model",
      text: "the login form loses my email",
    });

    expect(title).toBe("Log in again");
    const [request] = received;
    expect(request?.url).toBe("/chat/completions");
    expect(request?.headers.authorization).toBe("Bearer sk-test");
    expect(request?.body.model).toBe("cheap-model");
    expect(request?.body.max_tokens).toBe(TITLE_OUTPUT_TOKENS);
    const messages = request?.body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[1]?.content).toContain("the login form loses my email");
  });

  it("speaks Anthropic to an Anthropic-shaped endpoint", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "Fix" }, { type: "text", text: "login" }] }));
    };

    const title = await completeTitle({
      connection: connection("anthropic-messages"),
      model: "claude-cheap",
      text: "fix login",
    });

    expect(title).toBe("Fix login");
    const [request] = received;
    expect(request?.url).toBe("/v1/messages");
    expect(request?.headers["x-api-key"]).toBe("sk-test");
    expect(typeof request?.body.system).toBe("string");
    expect(request?.body.max_tokens).toBe(TITLE_OUTPUT_TOKENS);
  });

  it("keeps a base URL that already carries its version segment", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "Fix login" }] }));
    };

    await completeTitle({
      connection: { ...connection("anthropic-messages"), baseUrl: `${base}/v1` },
      model: "m",
      text: "hi",
    });

    expect(received[0]?.url).toBe("/v1/messages");
  });

  it("cleans terminal escapes out of the model's answer", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "\u001B[31mRed\u001B[0m title\nmore" } }] }));
    };

    expect(await completeTitle({ connection: connection(null), model: "m", text: "hi" })).toBe(
      "Red title more",
    );
  });

  it("refuses a wire protocol it cannot speak, without calling anyone", async () => {
    await expect(
      completeTitle({ connection: connection("google-generative-ai"), model: "m", text: "hi" }),
    ).rejects.toThrow(/unsupported wire protocol/);
    expect(received).toHaveLength(0);
  });

  it("fails on a non-2xx answer", async () => {
    respond = (res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "slow down" }));
    };

    await expect(
      completeTitle({ connection: connection(null), model: "m", text: "hi" }),
    ).rejects.toThrow(/429/);
  });

  it("fails when the answer carries no text", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "   " } }] }));
    };

    await expect(
      completeTitle({ connection: connection(null), model: "m", text: "hi" }),
    ).rejects.toThrow(/no text/);
  });

  it("sends only the head of a pasted file", async () => {
    const text = `${"x".repeat(10_000)}TAIL-MARKER`;

    await completeTitle({ connection: connection(null), model: "m", text });

    const messages = received[0]?.body.messages as { content: string }[];
    expect(messages[1]?.content).not.toContain("TAIL-MARKER");
    expect(messages[1]?.content.length).toBeLessThan(4_000);
  });
});
