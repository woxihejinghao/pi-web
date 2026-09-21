import { badRequest } from "./errors.ts";
import type { SessionHandle } from "./registry.ts";

/**
 * pi's built-in slash commands (`compact`, `export`, …) live in a separate
 * `BUILTIN_SLASH_COMMANDS` list that never appears in `get_commands`, because
 * in the TUI they are implemented by the TUI itself: opening the settings
 * menu, reading the clipboard, navigating the session tree.
 *
 * A Web client therefore has to supply both the list and the behaviour. Only
 * commands with a reachable RPC method are listed — in a menu, a command that
 * silently does nothing is worse than an absent one.
 */
export interface BuiltinCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  { name: "compact", description: "压缩当前会话上下文", argumentHint: "[补充要求]" },
  { name: "export", description: "把当前会话导出为 HTML", argumentHint: "[输出路径]" },
  { name: "session", description: "查看当前会话的统计信息" },
  { name: "name", description: "设置会话名称", argumentHint: "<名称>" },
];

/** True when this server knows how to run `name`. */
export function isBuiltinCommand(name: string): boolean {
  return BUILTIN_COMMANDS.some((command) => command.name === name);
}

const count = new Intl.NumberFormat("zh-CN");

/**
 * Run a built-in command and return one line describing the outcome.
 *
 * Every entry here is one-shot: it maps to a single RPC method. Anything that
 * needs more UI to be useful (the model picker, the session tree, the fork
 * message selector) is deliberately absent rather than half-present.
 */
export async function runBuiltinCommand(
  handle: SessionHandle,
  name: string,
  args: string,
): Promise<string> {
  const client = handle.client;
  const argument = args.trim();

  switch (name) {
    case "compact": {
      const result = await client.compact(argument.length > 0 ? argument : undefined);
      const before = count.format(result.tokensBefore);
      return result.estimatedTokensAfter === undefined
        ? `已压缩上下文，压缩前约 ${before} tokens`
        : `已压缩上下文：约 ${before} → ${count.format(result.estimatedTokensAfter)} tokens`;
    }

    case "export": {
      const { path } = await client.exportHtml(argument.length > 0 ? argument : undefined);
      return `已导出到 ${path}`;
    }

    case "session": {
      const stats = await client.getSessionStats();
      const parts = [
        `${stats.totalMessages} 条消息`,
        `用户 ${stats.userMessages} / 助手 ${stats.assistantMessages} / 工具 ${stats.toolCalls}`,
        `${count.format(stats.tokens.total)} tokens`,
      ];
      if (stats.cost > 0) parts.push(`花费 $${stats.cost.toFixed(4)}`);
      return parts.join("，");
    }

    case "name": {
      if (argument.length === 0) throw badRequest("用法：/name <名称>");
      await client.setSessionName(argument);
      return `会话已命名为「${argument}」`;
    }

    default:
      throw badRequest(`这个界面不支持内置命令 /${name}`);
  }
}
