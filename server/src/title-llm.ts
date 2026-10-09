import { TITLE_INPUT_MAX_BYTES, TITLE_OUTPUT_TOKENS, TITLE_TIMEOUT_MS } from "./config.ts";
import { authHeaders, type ProviderConnection } from "./models.ts";
import { cleanTitleText, truncateTitleBytes } from "./title-text.ts";

/**
 * The instruction one auxiliary call sends. dsh's own title provider
 * (`session-title-llm`) writes it the same way, and for the same reasons: the
 * answer is displayed in a single sidebar line, so quotes, prefixes, Markdown
 * and control codes all have to be ruled out up front rather than stripped
 * afterwards, and the language has to follow the message rather than the UI.
 */
const SYSTEM_PROMPT = [
  "Create a concise title for an AI coding-assistant session from the supplied human message.",
  "Return only the title on one line, in plain text, with no quotes, prefix, explanation,",
  "Markdown, XML, or terminal control codes. No code is allowed.",
  "Use the language of the message.",
  `Aim for about 8 words in non-CJK languages or 20 CJK characters.`,
].join(" ");

/**
 * Frame the message as JSON, the way dsh does: a first message is arbitrary
 * user text, and nothing in it may be read as part of the instruction.
 */
function frameMessage(text: string): string {
  const trimmed = truncateTitleBytes(cleanTitleText(text), TITLE_INPUT_MAX_BYTES);
  return `Generate the session title from this human message:\n${JSON.stringify(trimmed)}`;
}

/** The chat endpoint for a wire protocol, mirroring models.ts's `/models` rule. */
function completionsEndpoint(baseUrl: string, api: string | null): string {
  if (api === "anthropic-messages") {
    return /\/v\d+$/.test(baseUrl) ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
  }
  return `${baseUrl}/chat/completions`;
}

/** Pull the text out of whichever response shape the protocol uses. */
function titleTextOf(body: unknown, api: string | null): string {
  if (typeof body !== "object" || body === null) return "";
  if (api === "anthropic-messages") {
    const content = (body as { content?: unknown }).content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block): block is { type: string; text: string } => {
        const candidate = block as { type?: unknown; text?: unknown };
        return candidate.type === "text" && typeof candidate.text === "string";
      })
      .map((block) => block.text)
      .join(" ");
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { text: string } => {
      return typeof (part as { text?: unknown }).text === "string";
    })
    .map((part) => part.text)
    .join(" ");
}

export interface TitleCall {
  /** Where and how to call; see `readProviderConnection`. */
  connection: ProviderConnection;
  /** Model id, already chosen by the user in settings. */
  model: string;
  /** The session's first human message. */
  text: string;
  /** Cancels on supersession, service disposal, or the caller's own abort. */
  signal?: AbortSignal;
}

/**
 * Ask one model for a title and return its text, cleaned but not clipped.
 *
 * Only the two protocols this project can speak are supported. Anything else
 * (`google-generative-ai`, `amazon-bedrock`, …) is refused rather than sent a
 * body shaped for a different API — a wrong request would surface as a
 * confusing provider error, and this call has nowhere to report it anyway.
 *
 * Every bound is deliberate: a title is never worth waiting on, a first message
 * can be a pasted file (hence the byte cap), and the output is one short line
 * (hence the token cap). The caller logs nothing on failure on purpose — a
 * missing automatic title is not an error the user needs to see.
 */
export async function completeTitle(call: TitleCall): Promise<string> {
  const { connection, model } = call;
  const anthropic = connection.api === "anthropic-messages";
  // `null` is an OpenAI-shaped endpoint by convention (see models.ts), so the
  // two accepted protocols are "openai-completions" and "anthropic-messages".
  if (connection.api !== null && connection.api !== "openai-completions" && !anthropic) {
    throw new Error(`title model: unsupported wire protocol "${connection.api}"`);
  }
  const body = anthropic
    ? {
        model,
        max_tokens: TITLE_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: frameMessage(call.text) }],
      }
    : {
        model,
        max_tokens: TITLE_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: frameMessage(call.text) },
        ],
      };

  const timeout = AbortSignal.timeout(TITLE_TIMEOUT_MS);
  const signal = call.signal === undefined ? timeout : AbortSignal.any([timeout, call.signal]);
  const response = await fetch(completionsEndpoint(connection.baseUrl, connection.api), {
    method: "POST",
    headers: { ...authHeaders(connection.api, connection.apiKey), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`title model: ${response.status} ${response.statusText}`);
  }
  const title = cleanTitleText(titleTextOf(await response.json(), connection.api));
  if (title.length === 0) throw new Error("title model: response contained no text");
  return title;
}
