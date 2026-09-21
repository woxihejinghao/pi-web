/**
 * Minimal stand-in for `pi --mode rpc`, used by registry tests.
 *
 * It implements just enough of the protocol to exercise process lifecycle:
 * `get_state` (the handshake the registry depends on), `prompt` (echoes an
 * event so listeners can be observed), and clean exit on stdin close.
 *
 * Deliberate protocol detail: records are split on "\n" only, mirroring
 * pi's framing rule.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const sessionFile =
  sessionIndex >= 0 && args[sessionIndex + 1]
    ? args[sessionIndex + 1]
    : (process.env.STUB_SESSION_FILE ?? join(tmpdir(), `stub-pi-${randomUUID()}.jsonl`));

const sessionId = process.env.STUB_SESSION_ID ?? "stub-session-id";

/** Mutable so `set_auto_compaction` can be observed through a later `get_state`. */
let autoCompactionEnabled = true;

/**
 * Payload for `get_commands`. Tests set STUB_COMMANDS to assert on a known
 * list; the default mirrors the three sources pi reports (skill, prompt
 * template, extension command).
 */
// Session content the stub reports. Tests that need a specific transcript set
// STUB_SESSION_FILE; everything else gets these empty defaults.
const stubMessages = [];
const stubForkMessages = [];
const stubTree = [];
const stubLeafId = null;

const stubCommands = process.env.STUB_COMMANDS
  ? JSON.parse(process.env.STUB_COMMANDS)
  : [
      {
        name: "skill:pdf-tools",
        description: "Extract text and tables from PDF files",
        source: "skill",
        sourceInfo: {},
      },
      { name: "review", description: "Review the current diff", source: "prompt", sourceInfo: {} },
    ];

/**
 * Blocking sleep. Deliberately synchronous: the stdin handler below must not
 * yield mid-buffer while simulating a slow request.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function respond(command, data, id) {
  write({ id, type: "response", command, success: true, data });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim().length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    switch (message.type) {
      case "get_state":
        respond(
          "get_state",
          {
            model: null,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            steeringMode: "all",
            followUpMode: "one-at-a-time",
            sessionFile,
            sessionId,
            autoCompactionEnabled,
            messageCount: 0,
            pendingMessageCount: 0,
          },
          message.id,
        );
        break;
      // Agent behaviour settings live in pi's own global config; the stub keeps
      // them in memory so a test can round-trip a write and read it back.
      case "set_auto_compaction": {
        autoCompactionEnabled = message.enabled === true;
        respond("set_auto_compaction", undefined, message.id);
        break;
      }
      case "get_messages":
        respond("get_messages", { messages: stubMessages }, message.id);
        break;
      // The real pi answers this from the live session; the stub reports one
      // fork target per user message so the routes can be exercised.
      case "get_fork_messages":
        respond(
          "get_fork_messages",
          { messages: stubForkMessages },
          message.id,
        );
        break;
      case "get_tree":
        respond("get_tree", { tree: stubTree, leafId: stubLeafId }, message.id);
        break;
      case "fork":
        respond("fork", { text: "stub fork", cancelled: false }, message.id);
        break;
      case "get_commands": {
        const delay = Number(process.env.STUB_COMMANDS_DELAY_MS ?? 0);
        if (delay > 0) sleepSync(delay);
        respond("get_commands", { commands: stubCommands }, message.id);
        break;
      }
      // Built-in slash commands the Web UI implements over RPC.
      case "compact":
        respond(
          "compact",
          {
            summary: "stub summary",
            firstKeptEntryId: "entry-1",
            tokensBefore: 12345,
            estimatedTokensAfter: 678,
          },
          message.id,
        );
        break;
      case "get_session_stats":
        respond(
          "get_session_stats",
          {
            sessionFile,
            sessionId,
            userMessages: 2,
            assistantMessages: 3,
            toolCalls: 4,
            toolResults: 4,
            totalMessages: 9,
            tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, total: 300 },
            cost: 0.0125,
          },
          message.id,
        );
        break;
      case "export_html":
        respond("export_html", { path: sessionFile.replace(/\.jsonl$/, ".html") }, message.id);
        break;
      case "set_session_name":
        respond("set_session_name", undefined, message.id);
        break;
      case "prompt":
        respond("prompt", undefined, message.id);
        write({ type: "agent_start" });
        write({ type: "agent_end", messages: [], willRetry: false });
        write({ type: "agent_settled" });
        break;
      default:
        write({
          id: message.id,
          type: "response",
          command: message.type,
          success: false,
          error: `stub does not implement ${message.type}`,
        });
    }
  }
});

process.stdin.on("end", () => process.exit(0));

// Announce readiness the way a real CLI would after wiring up stdio.
if (process.env.STUB_DELAY_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.STUB_DELAY_MS)));
}
