/**
 * The numbers dsh prints under the composer, computed from pi's transcript.
 *
 * dsh derives both pills from a durable `sessionStats` projection: counts and
 * wall times folded out of its event log, plus a token-usage projection. pi has
 * no such projection — a session read back from disk carries usage on each
 * message and nothing else — so the counts and tokens are folded here, and the
 * *timing* half is measured live, in this browser, while pi streams.
 *
 * That split is deliberate and matches the project's rule about not inventing
 * values: a transcript's timestamps say when a generation began and when a tool
 * result was written, not how long decoding took, so a reloaded session shows
 * its counts and tokens with no speed rather than a number that looks measured
 * and is not. dsh's own pill degrades the same way when its time figures are
 * absent (and it has a fallback fold for windows without the projection).
 *
 * Kept free of React so the arithmetic — which is the part that silently rots —
 * can be tested directly.
 */
import type { AgentMessage, AssistantMessage } from "../../lib/types.ts";
import type { Translate } from "../../lib/i18n/index.ts";

/** The three disjoint prompt-side buckets plus the completion. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Wall times this client measured while pi streamed, plus the in-flight
 * boundaries needed to keep measuring. All zero for a session loaded from disk.
 */
export interface LiveTiming {
  /** Step start → assembled message, summed over steps. */
  llmMs: number;
  /** tool_execution_start → end, summed over calls. */
  toolMs: number;
  /** Step start → first non-empty delta, summed over steps that produced one. */
  ttftMs: number;
  ttftSteps: number;
  /** First token → assembled message, over steps that also reported output. */
  decodeMs: number;
  decodeTokens: number;
}

export const EMPTY_TIMING: LiveTiming = {
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftSteps: 0,
  decodeMs: 0,
  decodeTokens: 0,
};

export interface SessionStats {
  /** User messages, i.e. dsh's "轮". */
  turns: number;
  /** Assistant messages, i.e. dsh's "步" — one step is one model call. */
  steps: number;
  usage: UsageTotals;
  /** Billed input plus output: the figure dsh labels `587K tok`. */
  totalTokens: number;
  /** `"83"` / `"99.5"`, or null when nothing was billed. */
  cacheHitPercent: string | null;
  /** `provider/model` of the newest assistant message, or null. */
  model: string | null;
  timing: LiveTiming;
  /** Output tokens over decode time, or null when this client measured none. */
  tokensPerSecond: number | null;
}

/** The three disjoint prompt-side buckets — what the provider actually bills. */
export function billedInputTokens(usage: UsageTotals): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/**
 * Cache-hit percentage, rounded to whole units.
 *
 * A non-zero miss never rounds up to `100`: a session that read 999 of 1000
 * prompt tokens cached is "99.9", not "100", because "100" is a claim about
 * billing that the numbers do not support.
 */
export function formatCacheHitPercent(usage: UsageTotals): string | null {
  const billed = billedInputTokens(usage);
  if (billed === 0) return null;
  const missed = usage.input + usage.cacheWrite;
  if (missed === 0) return "100";
  const percent = (usage.cacheRead / billed) * 100;
  if (Math.round(percent) >= 100) return (Math.floor(percent * 10) / 10).toFixed(1);
  return String(Math.round(percent));
}

/** dsh's `formatTokensPerSecond`: whole units from ten up, one decimal below. */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/**
 * A latency in seconds, unit included: one decimal below ten seconds, whole
 * seconds above it. dsh's `formatLatencySeconds` + its `duration.seconds`
 * template, which is how the TTFT row reads.
 */
export function formatLatencySeconds(ms: number, t: Translate): string {
  const seconds = Math.max(0, ms) / 1000;
  const shown = seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds);
  return t("stats.seconds", { seconds: shown });
}

/** Exact counts with thousands separators, as dsh's dialog shows them. */
export function formatExactCount(count: number): string {
  return String(Math.round(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function usageOf(message: AgentMessage): UsageTotals | null {
  const usage = (message as { usage?: Partial<UsageTotals> }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const bucket = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    input: bucket(usage.input),
    output: bucket(usage.output),
    cacheRead: bucket(usage.cacheRead),
    cacheWrite: bucket(usage.cacheWrite),
  };
}

/**
 * Fold a transcript and this client's live timing into the pill figures.
 * Usage is summed over assistant *and* tool-result messages, matching pi's own
 * `getSessionStats` — a tool that runs a summariser bills tokens too, and
 * leaving those out would make the total disagree with pi's.
 */
export function sessionStats(messages: AgentMessage[], timing: LiveTiming): SessionStats {
  let turns = 0;
  let steps = 0;
  let model: string | null = null;
  const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const message of messages) {
    if (message.role === "user") {
      turns += 1;
      continue;
    }
    if (message.role === "assistant") {
      steps += 1;
      const assistant = message as AssistantMessage;
      if (assistant.provider !== undefined && assistant.model !== undefined) {
        model = `${assistant.provider}/${assistant.model}`;
      }
    } else if (message.role !== "toolResult") {
      continue;
    }
    const messageUsage = usageOf(message);
    if (messageUsage === null) continue;
    usage.input += messageUsage.input;
    usage.output += messageUsage.output;
    usage.cacheRead += messageUsage.cacheRead;
    usage.cacheWrite += messageUsage.cacheWrite;
  }

  return {
    turns,
    steps,
    usage,
    totalTokens: billedInputTokens(usage) + usage.output,
    cacheHitPercent: formatCacheHitPercent(usage),
    model,
    timing,
    tokensPerSecond: timing.decodeMs > 0 ? timing.decodeTokens / (timing.decodeMs / 1000) : null,
  };
}
