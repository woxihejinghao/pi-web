/**
 * 压测用的 pi RPC 替身。
 *
 * 只实现 `get_state`（registry 的握手依赖）与 `prompt`：收到 prompt 后按固定
 * 节奏吐大量 `message_update` 事件，用来测量「N 个会话同时 streaming」时
 * 服务端事件管道（pi 进程 → RpcClient → registry → bus → SSE）的吞吐与延迟。
 *
 * 每个事件都带 `_t`（发出时的 Date.now()），客户端拿它算端到端单程延迟。
 * 事件结构刻意保持与真实 pi 一致的形状，避免客户端走特殊分支。
 *
 * 参数（环境变量）：
 *   LOAD_EVENTS       每个 prompt 产生多少个 message_update（默认 20000）
 *   LOAD_BATCH        每 tick 写多少个事件（默认 20）
 *   LOAD_INTERVAL_MS  每 tick 间隔（默认 1ms → 约 20k events/s/会话）
 */
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const sessionFile = flagValue("--session") ?? `/tmp/piws-load-stub-${randomUUID()}.jsonl`;
const sessionId = `load-stub-${randomUUID().slice(0, 8)}`;

const EVENTS = Number(process.env.LOAD_EVENTS ?? 20000);
const BATCH = Number(process.env.LOAD_BATCH ?? 20);
const INTERVAL_MS = Number(process.env.LOAD_INTERVAL_MS ?? 1);

const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
const respond = (command, data, id) => write({ id, type: "response", command, success: true, data });

function streamEvents() {
  write({ type: "agent_start", _t: Date.now(), _total: EVENTS });
  let sent = 0;

  const tick = () => {
    for (let i = 0; i < BATCH && sent < EVENTS; i += 1, sent += 1) {
      write({
        type: "message_update",
        _t: Date.now(),
        _seq: sent,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lorem ipsum " },
      });
    }
    if (sent < EVENTS) {
      setTimeout(tick, INTERVAL_MS);
      return;
    }
    write({ type: "agent_end", messages: [], willRetry: false, _t: Date.now(), _emitted: sent });
    write({ type: "agent_settled", _t: Date.now(), _emitted: sent });
  };

  setTimeout(tick, INTERVAL_MS);
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
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: 0,
          },
          message.id,
        );
        break;
      case "get_messages":
        respond("get_messages", { messages: [] }, message.id);
        break;
      case "prompt":
        respond("prompt", undefined, message.id);
        streamEvents();
        break;
      case "set_session_name":
        respond("set_session_name", undefined, message.id);
        break;
      default:
        write({
          id: message.id,
          type: "response",
          command: message.type,
          success: false,
          error: `load-stub does not implement ${message.type}`,
        });
    }
  }
});

process.stdin.on("end", () => process.exit(0));
