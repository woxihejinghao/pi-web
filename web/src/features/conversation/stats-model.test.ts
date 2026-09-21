import { describe, expect, it } from "vitest";
import type { AgentMessage, AssistantMessage, ToolResultMessage, UserMessage } from "../../lib/types.ts";
import {
  EMPTY_TIMING,
  billedInputTokens,
  formatCacheHitPercent,
  formatExactCount,
  formatLatencySeconds,
  formatTokensPerSecond,
  sessionStats,
} from "./stats-model.ts";

function user(): UserMessage {
  return { role: "user", content: "hi", timestamp: 0 };
}

function assistant(usage: Partial<AssistantMessage["usage"]>, model = "deepseek"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    provider: "cz",
    model,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...usage },
    timestamp: 0,
  };
}

function toolResult(usage?: AssistantMessage["usage"]): ToolResultMessage {
  return { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [], usage, timestamp: 0 };
}

function timing(overrides: Partial<typeof EMPTY_TIMING> = {}): typeof EMPTY_TIMING {
  return { ...EMPTY_TIMING, ...overrides };
}

describe("sessionStats", () => {
  it("counts user turns and assistant steps", () => {
    const messages: AgentMessage[] = [user(), assistant({}), user(), assistant({}), assistant({})];
    const stats = sessionStats(messages, EMPTY_TIMING);
    expect(stats.turns).toBe(2);
    expect(stats.steps).toBe(3);
  });

  it("sums usage over assistant and tool-result messages", () => {
    const messages: AgentMessage[] = [
      user(),
      assistant({ input: 100, output: 20, cacheRead: 300, cacheWrite: 5 }),
      toolResult({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 7 }),
    ];
    const stats = sessionStats(messages, EMPTY_TIMING);
    expect(stats.usage).toEqual({ input: 100, output: 20, cacheRead: 300, cacheWrite: 5 });
    // Billed input (100 + 300 + 5) plus output, the figure on the pill.
    expect(stats.totalTokens).toBe(425);
  });

  it("names the newest assistant message's model", () => {
    const messages: AgentMessage[] = [
      assistant({}, "old"),
      assistant({}, "deepseek-chat"),
    ];
    expect(sessionStats(messages, EMPTY_TIMING).model).toBe("cz/deepseek-chat");
  });

  it("reports no speed until this client has measured one", () => {
    expect(sessionStats([user(), assistant({ output: 500 })], EMPTY_TIMING).tokensPerSecond).toBeNull();
    const measured = sessionStats(
      [user(), assistant({ output: 500 })],
      timing({ decodeMs: 2000, decodeTokens: 500 }),
    );
    expect(measured.tokensPerSecond).toBe(250);
  });
});

describe("formatCacheHitPercent", () => {
  it("rounds to whole percent", () => {
    expect(formatCacheHitPercent({ input: 17, output: 0, cacheRead: 83, cacheWrite: 0 })).toBe("83");
  });

  it("never rounds a miss up to 100", () => {
    expect(formatCacheHitPercent({ input: 1, output: 0, cacheRead: 999, cacheWrite: 0 })).toBe("99.9");
  });

  it("says 100 only when nothing was billed uncached", () => {
    expect(formatCacheHitPercent({ input: 0, output: 0, cacheRead: 40, cacheWrite: 0 })).toBe("100");
  });

  it("is null when nothing was billed at all", () => {
    expect(formatCacheHitPercent({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
});

describe("billedInputTokens", () => {
  it("adds the three disjoint prompt-side buckets", () => {
    expect(billedInputTokens({ input: 1, output: 99, cacheRead: 2, cacheWrite: 3 })).toBe(6);
  });
});

describe("formatting", () => {
  it("shows whole numbers from ten tokens per second up", () => {
    expect(formatTokensPerSecond(241.4)).toBe("241");
    expect(formatTokensPerSecond(9.44)).toBe("9.4");
    expect(formatTokensPerSecond(-5)).toBe("0");
  });

  it("keeps one decimal below ten seconds of latency", () => {
    expect(formatLatencySeconds(1234)).toBe("1.2秒");
    expect(formatLatencySeconds(12_400)).toBe("12秒");
  });

  it("groups exact counts the way dsh's dialog does", () => {
    expect(formatExactCount(587123)).toBe("587,123");
    expect(formatExactCount(42)).toBe("42");
  });
});
