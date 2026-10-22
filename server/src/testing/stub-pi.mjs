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
import { readFileSync } from "node:fs";
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
 * Thinking state for the composer routes. Mutable so `set_thinking_level` can
 * be observed through a later `get_state`, the same way a real session records
 * it. The supported list defaults to pi's full seven-level scale.
 */
let thinkingLevel = process.env.STUB_THINKING_LEVEL ?? "medium";
const stubThinkingLevels = process.env.STUB_THINKING_LEVELS
  ? JSON.parse(process.env.STUB_THINKING_LEVELS)
  : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Model state for the composer routes. `STUB_MODEL` is what the session is
 * currently on (null when the test does not care), `STUB_MODELS` is what
 * `get_available_models` reports, and `set_model` moves the former to the
 * latter's entry — the same lookup-and-reject the real pi does.
 */
let currentModel = process.env.STUB_MODEL ? JSON.parse(process.env.STUB_MODEL) : null;
const stubModels = process.env.STUB_MODELS ? JSON.parse(process.env.STUB_MODELS) : [];
const stubContextUsage = process.env.STUB_CONTEXT_USAGE
  ? JSON.parse(process.env.STUB_CONTEXT_USAGE)
  : undefined;

/**
 * Payload for `get_commands`. Tests set STUB_COMMANDS to assert on a known
 * list; the default mirrors the three sources pi reports (skill, prompt
 * template, extension command).
 *
 * A minimal composition answers differently, and the difference is derived
 * from the same arguments the registry composes with: `--no-extensions` and
 * `--no-prompt-templates` leave no skill and no template behind, only whatever
 * an explicit `--extension` put back. That is what lets the API tests assert a
 * command listing follows the composition rather than the project.
 */
const minimalComposition = args.includes("--no-extensions");
/**
 * Transcript `get_messages` reports. The stub never writes a session file, so a
 * test that wants the `get_messages` route to answer from memory sets
 * STUB_MESSAGES to a JSON payload; everything else gets an empty transcript.
 */
const stubMessages = readStubMessages();

/**
 * A test that needs a transcript bigger than a few characters points
 * `STUB_MESSAGES_FILE` at a JSON file instead of putting the payload in the
 * environment: Linux caps one environment string at 128 KiB (MAX_ARG_STRLEN),
 * so a ~200 KB `STUB_MESSAGES` makes `execve` fail with E2BIG and the session
 * opens with an error the test never asked for. macOS has no such per-string
 * limit, which is why the payload fits there and not on the CI runner.
 */
function readStubMessages() {
  const file = process.env.STUB_MESSAGES_FILE;
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  return process.env.STUB_MESSAGES ? JSON.parse(process.env.STUB_MESSAGES) : [];
}

/**
 * Leave a prompted turn in flight. A real pi streams from `agent_start` until
 * the run settles, and while it does, its memory can hold turns no session file
 * has seen yet. A test that needs that window sets STUB_KEEP_RUNNING=1: the stub
 * then stops after `agent_start` and never settles.
 */
const keepRunning = process.env.STUB_KEEP_RUNNING === "1";
const stubForkMessages = [];
const stubTree = [];
const stubLeafId = null;

/**
 * Session entries `get_entries` answers with.
 *
 * A test that needs the in-memory view to differ from the file sets
 * STUB_ENTRIES — which is the whole point of reading the process: pi writes its
 * session file lazily, so a switch made before the first message is only here.
 */
const stubEntries = process.env.STUB_ENTRIES ? JSON.parse(process.env.STUB_ENTRIES) : [];
const stubEntriesLeaf = process.env.STUB_ENTRIES_LEAF ?? (stubEntries.at(-1)?.id ?? null);

const stubCommands = process.env.STUB_COMMANDS
  ? JSON.parse(process.env.STUB_COMMANDS)
  : minimalComposition
    ? [
        {
          name: "web",
          description: "Start the pi-web-simple web UI",
          source: "extension",
          sourceInfo: {},
        },
      ]
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
            model: currentModel,
            thinkingLevel,
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
      case "get_entries":
        // A test can make the process unable to answer, which is how the route's
        // file fallback gets exercised (a process that went away mid-request).
        if (process.env.STUB_FAIL_GET_ENTRIES) {
          write({
            id: message.id,
            type: "response",
            command: "get_entries",
            success: false,
            error: "stub cannot read entries",
          });
          break;
        }
        respond("get_entries", { entries: stubEntries, leafId: stubEntriesLeaf }, message.id);
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
      case "get_available_models":
        respond("get_available_models", { models: stubModels }, message.id);
        break;
      case "set_model": {
        const found = stubModels.find(
          (model) => model.provider === message.provider && model.id === message.modelId,
        );
        if (!found) {
          write({
            id: message.id,
            type: "response",
            command: "set_model",
            success: false,
            error: `Model not found: ${message.provider}/${message.modelId}`,
          });
          break;
        }
        currentModel = found;
        respond("set_model", found, message.id);
        break;
      }
      case "get_available_thinking_levels":
        respond("get_available_thinking_levels", { levels: stubThinkingLevels }, message.id);
        break;
      case "set_thinking_level":
        // pi clamps to what the model supports; the stub only records, so a test
        // can assert the round trip rather than a clamp the real pi owns.
        thinkingLevel = message.level;
        respond("set_thinking_level", undefined, message.id);
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
            ...(stubContextUsage === undefined ? {} : { contextUsage: stubContextUsage }),
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
        // pi 1.1.0 answers `prompt` with a disposition ("started" | "queued" |
        // "handled"); `RpcClient.prompt()` reads `data.disposition` and throws on
        // an undefined payload. 0.86.1 ignores the field, so sending it is safe
        // on both versions. "started" is what tells the caller to wait for
        // `agent_settled`, which this stub emits below.
        // The run starts before the command answers: pi resolves `prompt`
        // through a preflight callback it fires once the stream is up, so the
        // boundary is on the wire first here too — which is what lets a test
        // that just prompted treat the process as running the moment the call
        // returns.
        write({ type: "agent_start" });
        respond("prompt", { disposition: "started" }, message.id);
        if (keepRunning) break;
        write({ type: "agent_end", messages: [], willRetry: false });
        write({ type: "agent_settled" });
        break;
      case "abort":
        // Aborting settles the run either way — pi's `_emitAgentSettled` reads
        // the abort request and emits `agent_settled` with `aborted: true`, so
        // the boundary a transcript read waits on comes down for an aborted run
        // exactly as for a finished one.
        write({ type: "agent_settled", aborted: true });
        respond("abort", undefined, message.id);
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
