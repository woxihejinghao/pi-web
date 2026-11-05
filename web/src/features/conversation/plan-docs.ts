import type { AgentMessage, AssistantMessage, ToolCallBlock } from "../../lib/types.ts";
import { isContentBlock } from "../../lib/types.ts";

/**
 * A plan's text, however it reached the client.
 *
 * The half of a {@link PlanDoc} that a reader actually sees, split out because
 * a review can carry a plan with no tool invocation behind it (an extension
 * asking directly, with an `intent` and no `callId`). That document has nothing
 * to reopen, so it has no id — and nothing else about it differs.
 */
export interface PlanText {
  /** The plan's title: its first markdown heading, or a fallback. */
  title: string;
  /** The complete plan, as markdown. */
  plan: string;
}

/**
 * One plan the agent submitted through `exit_plan_mode`.
 *
 * This is dsh's `SubmittedPlan`: the document as it was handed over, keyed by
 * the tool invocation that submitted it. That key is the whole point — it is
 * what the review card, the transcript card and the sidebar tab all address the
 * plan by, so any of them can find it again after the review closes, and a
 * reload finds it by replaying the transcript rather than by keeping a copy.
 *
 * A plan that was **rejected** is here too, for the same reason dsh keeps it:
 * the card is a record that a plan was submitted, not a record of approval.
 */
export interface PlanDoc extends PlanText {
  /** The tool invocation's id; also its `intent.callId` in the review. */
  callId: string;
}

/** The tool whose calls carry a submitted plan. */
export const EXIT_PLAN_MODE_TOOL = "exit_plan_mode";

/**
 * The plan's first markdown heading (any level), or dsh's fallback.
 *
 * The same rule `extensions/plan-mode.ts` uses for the card's title, so the
 * heading the user reviewed is the heading the card and the tab show.
 */
export function planTitleOf(plan: string): string {
  for (const line of plan.split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) return match[1]!;
  }
  return "Plan";
}

/**
 * Every plan the messages submitted, in invocation order.
 *
 * Read out of the assistant messages' tool calls rather than out of the tool
 * results: a rejected plan has an error result and no `details`, and dsh keeps
 * its card anyway. The arguments are complete once the message is — pi streams
 * them, but this projects the transcript, where `message_end` has already
 * replaced the partial.
 *
 * A call whose `plan` argument is not a usable plan is skipped rather than
 * throwing: `exit_plan_mode` validates its own arguments, so this is defence
 * against a hand-edited session file, and one bad call should not cost the
 * others their cards.
 */
export function planDocsOf(messages: readonly AgentMessage[]): PlanDoc[] {
  const docs: PlanDoc[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of (message as AssistantMessage).content ?? []) {
      if (!isContentBlock(block)) continue;
      if (block.type !== "toolCall") continue;
      const call = block as ToolCallBlock;
      if (call.name !== EXIT_PLAN_MODE_TOOL) continue;
      const raw = call.arguments?.plan;
      const plan = typeof raw === "string" ? raw.trim() : "";
      if (plan.length === 0) continue;
      docs.push({ callId: call.id, title: planTitleOf(plan), plan });
    }
  }
  return docs;
}
