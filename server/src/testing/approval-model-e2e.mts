/** Exercises real model-issued/nested tools against a local mock OpenAI API.
 * No network model service, account, credential or real workspace is used. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir, RpcClient } from "@earendil-works/pi-coding-agent";
import { DEFAULT_APPROVAL, saveApproval } from "../../../extensions/approval-policy.js";

const root = mkdtempSync(join(tmpdir(), "piws-nested-approval-"));
const agent = join(root, "agent"); mkdirSync(agent);
const workspace = join(root, "workspace"); mkdirSync(workspace);
const outside = join(root, "outside"); mkdirSync(outside);
symlinkSync(outside, join(workspace, "escape"));
mkdirSync(join(workspace, ".pi"));
writeFileSync(join(workspace, ".pi", "settings.json"), "{}");
symlinkSync(join(workspace, ".pi", "settings.json"), join(workspace, "innocent.md"));
const config = join(root, "approval.json");
const gate = join(dirname(fileURLToPath(import.meta.url)), "../../../extensions/approval-gate.ts");
let tool = "codemode";
let input: Record<string, unknown> = {};
let reviewResult = '{"outcome":"allow","risk":"low"}';
let reviews = 0;
const api = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const reviewing = body.messages.some((message: { role?: string; content?: unknown }) => message.role === "system" && JSON.stringify(message.content).includes("Review one proposed local file edit"));
  const finished = body.messages.some((message: { role?: string }) => message.role === "tool");
  if (reviewing) reviews++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (reviewing || finished) {
    event({ role: "assistant", content: reviewing ? reviewResult : "done" });
    event({}, "stop");
  } else {
    event({ role: "assistant", tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: tool, arguments: JSON.stringify(input) } }] });
    event({}, "tool_calls");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {
  "approval-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}/v1`, apiKey: "test-key-not-secret", models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
} }));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], quietStartup: true }));

async function scenario(name: string, decisions: boolean[], mode: "ask" | "smart", expected: boolean, path: string) {
  saveApproval({ ...DEFAULT_APPROVAL, mode, timeoutSeconds: 10 }, config);
  const client = new RpcClient({
    cliPath: join(getPackageDir(), "dist/cli.js"), cwd: workspace,
    provider: "approval-test", model: "mock",
    env: { PI_CODING_AGENT_DIR: agent, PI_WEB_APPROVAL_CONFIG: config, PI_OFFLINE: "1" },
    args: ["--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--extension", gate, "--extension", "builtin:codemode", "--tools", "read,write,bash,codemode"],
  });
  let seen = 0;
  let settled = false;
  client.onEvent((event: { type?: string; method?: unknown; id?: unknown }) => {
    if (event.type === "agent_settled") settled = true;
    if (event.type === "extension_ui_request" && event.method === "confirm") {
      const confirmed = decisions[seen++] ?? false;
      const stdin = (client as unknown as { process: { stdin: { write(text: string): void } } }).process.stdin;
      stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, confirmed }) + "\n");
    }
  });
  try {
    await client.start();
    await client.prompt("Write only the test note authorized for this scenario.");
    const deadline = Date.now() + 20000;
    while (!settled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(settled, `${name}: agent did not settle; stderr=${client.getStderr()}`);
    assert.equal(existsSync(path), expected, `${name}: unexpected file write`);
    assert.equal(seen, decisions.length, `${name}: unexpected approval count`);
    console.log(`PASS: ${name} (${seen} confirmations)`);
  } finally { await client.stop(); }
}
try {
  input = { code: 'await tools.write({path:"outer-denied.txt",content:"probe"});' };
  await scenario("denied codemode cannot execute", [false], "ask", false, join(workspace, "outer-denied.txt"));
  input = { code: 'await tools.write({path:"nested-denied.txt",content:"probe"});' };
  await scenario("approving codemode does not approve its nested write", [true, false], "ask", false, join(workspace, "nested-denied.txt"));
  input = { code: 'await tools.write({path:"nested-allowed.txt",content:"probe"});' };
  await scenario("both codemode and nested write approved", [true, true], "ask", true, join(workspace, "nested-allowed.txt"));
  tool = "write"; input = { path: "low-risk.md", content: "test note" };
  await scenario("Smart low-risk review via current runtime API", [], "smart", true, join(workspace, "low-risk.md"));
  assert.equal(reviews, 1);
  reviewResult = '{"outcome":"deny","risk":"high"}'; input = { path: "review-denied.md", content: "test note" };
  await scenario("Smart denial falls back to a human", [false], "smart", false, join(workspace, "review-denied.md"));
  reviewResult = "invalid JSON"; input = { path: "review-broken.md", content: "test note" };
  await scenario("invalid AI response cannot grant permission", [false], "smart", false, join(workspace, "review-broken.md"));
  const before = reviews;
  input = { path: "escape/escaped.md", content: "test note" };
  await scenario("symlink outside workspace always asks", [false], "smart", false, join(outside, "escaped.md"));
  assert.equal(reviews, before, "external path must not reach AI auto-approval");
  input = { path: "innocent.md", content: "changed" };
  await scenario("symlink to internal sensitive config always asks", [false], "smart", false, join(workspace, "unused-marker"));
  assert.equal(reviews, before, "sensitive canonical path must not reach AI auto-approval");
} finally {
  await new Promise<void>(resolve => api.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
