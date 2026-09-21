import type { AgentMessage, AssistantMessage, TextBlock, UserMessage } from "../../lib/types.ts";
import { textFromContent } from "./useConversation.ts";

/**
 * Preview budgets, sized to the rail card's clamps (one prompt line, up to three
 * response lines). Ported verbatim from dsh so a turn reads the same in the rail
 * as it does in the transcript.
 */
export const PROMPT_PREVIEW_LIMIT = 50;
export const RESPONSE_PREVIEW_LIMIT = 120;

/**
 * Join rendered text, collapse whitespace, and cap at `limit` with a trailing
 * ellipsis when clipped.
 *
 * The `limit * 2` read-ahead is dsh's: a rail card can never show more than one
 * prompt line and three response lines, so building the full string first would
 * scale the rail's work with the length of every answer in the session.
 */
export function preview(parts: readonly string[], limit: number): string {
  let text = "";
  let unread = false;
  for (const part of parts) {
    if (text.length >= limit * 2) {
      unread = true;
      break;
    }
    const clipped = part.length > limit * 2;
    const chunk = clipped ? part.slice(0, limit * 2) : part;
    text += text === "" ? chunk : ` ${chunk}`;
    if (clipped) {
      unread = true;
      break;
    }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`;
  return unread ? `${normalized}…` : normalized;
}

/** One entry in the right-hand rail. */
export interface RailTurn {
  /** 1-based, matching dsh's numbering in "跳转到第 N 轮". */
  turn: number;
  prompt: string;
  response: string;
  /** The renderable (user/assistant) messages of this turn, in order. */
  messages: AgentMessage[];
}

/** Pull the concatenated visible text out of one assistant message. */
function assistantText(message: AssistantMessage): string {
  const content = message.content ?? [];
  return content
    .filter((block) => block.type === "text")
    .map((block) => (block as TextBlock).text)
    .join("");
}

/**
 * Cut a flat transcript into turns.
 *
 * A turn opens at each user message and runs until the next one, so an
 * assistant answer plus every tool round-trip it drove stay together — which is
 * what makes a rail mark mean "one thing the user asked" rather than "one
 * message".
 *
 * Two cases pi can produce that dsh's model does not:
 * - A transcript that opens with assistant output (a resumed or forked session
 *   can start mid-turn). Those messages form turn 1 without a prompt, and the
 *   rail falls back to "第 1 轮" for the card title.
 * - Two user messages in a row (a queued message delivered before the model
 *   answered). The second one opens its own turn, which keeps the rail honest
 *   about how many prompts were actually sent.
 */
export function groupTurns(messages: readonly AgentMessage[]): RailTurn[] {
  const turns: RailTurn[] = [];
  let current: RailTurn | null = null;

  for (const message of messages) {
    if (message.role === "toolResult") {
      // Tool output renders inside its own row, so it is not part of the turn's
      // renderable message list (its text is not part of the response either).
      continue;
    }
    if (message.role === "user") {
      current = {
        turn: turns.length + 1,
        prompt: textFromContent((message as UserMessage).content),
        response: "",
        messages: [message],
      };
      turns.push(current);
      continue;
    }
    if (message.role !== "assistant") continue;

    if (current === null) {
      current = { turn: 1, prompt: "", response: "", messages: [] };
      turns.push(current);
    }
    current.messages.push(message);
  }

  for (const turn of turns) {
    const texts = turn.messages
      .filter((message) => message.role === "assistant")
      .map((message) => assistantText(message as AssistantMessage))
      .filter((text) => text.length > 0);
    turn.prompt = preview([turn.prompt], PROMPT_PREVIEW_LIMIT);
    turn.response = preview(texts, RESPONSE_PREVIEW_LIMIT);
  }

  return turns;
}
