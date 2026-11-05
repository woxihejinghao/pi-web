/** Real RPC approval checks. No external model requests or real user files. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir, RpcClient } from "@earendil-works/pi-coding-agent";
import { DEFAULT_APPROVAL, saveApproval } from "../../../extensions/approval-policy.js";

const root = mkdtempSync(join(tmpdir(), "piws-approval-e2e-"));
const config = join(root, "approval.json");
const gate = join(dirname(fileURLToPath(import.meta.url)), "../../../extensions/approval-gate.ts");
const previous = process.env.PI_WEB_APPROVAL_CONFIG;
process.env.PI_WEB_APPROVAL_CONFIG = config;
saveApproval({ ...DEFAULT_APPROVAL, timeoutSeconds: 10 }, config);
const client = new RpcClient({
  cliPath: join(getPackageDir(), "dist/cli.js"), cwd: root,
  args: ["--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--extension", gate],
});
let response: "allow" | "deny" | "cancel" | "timeout" = "deny";
let dialogs = 0;
client.onEvent((event: { type?: string; method?: unknown; id?: unknown }) => {
  if (event.type !== "extension_ui_request" || event.method !== "confirm") return;
  dialogs++;
  if (response === "timeout") return;
  const stdin = (client as unknown as { process: { stdin: { write(text: string): void } } }).process.stdin;
  stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id,
    ...(response === "cancel" ? { cancelled: true } : { confirmed: response === "allow" }),
  }) + "\n");
});
async function shell(name: string) {
  const path = join(root, name);
  try { await client.bash(`printf 'probe' > '${path}'`); } catch { /* blocked RPC command */ }
  return existsSync(path);
}
try {
  await client.start();
  assert.ok(await client.getState());
  assert.equal(await shell("denied"), false);
  response = "allow";
  assert.equal(await shell("allowed"), true);
  assert.equal(readFileSync(join(root, "allowed"), "utf8"), "probe");
  response = "cancel";
  assert.equal(await shell("cancelled"), false);
  response = "timeout";
  assert.equal(await shell("timed-out"), false);
  assert.equal(dialogs, 4);
  writeFileSync(config, "corrupt");
  response = "allow";
  assert.equal(await shell("broken-config"), false);
  assert.equal(dialogs, 4, "invalid policy must not create an approvable dialog");
  saveApproval({ ...DEFAULT_APPROVAL, mode: "smart", timeoutSeconds: 10 }, config);
  response = "deny";
  assert.equal(await shell("smart-shell-denied"), false, "Smart must still ask for shell calls");
  saveApproval({ ...DEFAULT_APPROVAL, mode: "off", timeoutSeconds: 10 }, config);
  assert.equal(await shell("explicit-off"), true);
  console.log("PASS: real RPC gate: allow, deny, cancel, timeout, corrupt config, Smart shell, explicit Off; no model calls.");
} finally {
  await client.stop();
  if (previous === undefined) delete process.env.PI_WEB_APPROVAL_CONFIG;
  else process.env.PI_WEB_APPROVAL_CONFIG = previous;
  rmSync(root, { recursive: true, force: true });
}
