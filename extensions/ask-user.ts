/**
 * AskUserQuestion — the structured question batch, shipped here instead of
 * installed.
 *
 * The shape is dsh's `ask_user_question`, not a series of `ctx.ui.select`
 * calls: one call carries every question, and its result is one answer batch
 * keyed by question id. That is what lets the web client render the whole set
 * at once, keep a draft across questions, and submit in one action.
 *
 * pi's UI sub-protocol has no batch dialog, so the batch rides in a `select`
 * title (see `server/src/ask-user-codec.ts`, which decodes it). Two modes fall
 * out of that:
 *
 * - `rpc` — how pi-web-simple runs pi — gets the encoded batch, which the
 *   server decodes before any browser sees it.
 * - `tui` gets one ordinary dialog per question instead. Feeding a terminal
 *   user a prefixed title would be worse than asking them three times, and the
 *   batch survives either way because the answers are assembled here.
 *
 * Neither terminal pi sessions nor their tool lists know about this file: it is
 * deliberately absent from the package's `pi.extensions` manifest, so only the
 * RPC processes this deployment spawns register the tool, and only because
 * `server/src/presets.ts` passes the file with `--extension`. The `tui` branch
 * therefore serves a session that loaded the extension by hand
 * (`pi -e extensions/ask-user.ts`); it is kept because that is still a better
 * answer there than a prefixed title.
 *
 * Nothing is remembered between calls. A caller that wants "the question still
 * waiting for an answer" reads the transcript, which is why `/reload`,
 * compaction and branching keep working without this file owning state.
 */

import type { ExtensionAPI, ExtensionContext, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * Prefix that turns an ordinary `select` title into a question batch.
 *
 * Duplicated from `server/src/ask-user-codec.ts` on purpose: this file runs
 * inside the pi process and cannot import server code. The wire format is
 * versioned so the two sides can be changed one at a time.
 */
const TITLE_PREFIX = "pi-web:ask-user:v1:";

/** The single entry in the `select` options array, which carries no choice. */
const OPTION_SENTINEL = "__pi_web_ask_user__";

/** Foreground wait before pi settles the dialog, in seconds. dsh's default. */
const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * How much longer pi waits than the deadline the user sees.
 *
 * The web client owns the visible countdown and reports the deadline itself by
 * answering `timedOut`. Its clock starts when the request arrives, which is
 * strictly later than pi's, so without this slack pi would always settle first
 * and the tool could only report a cancel — losing the difference between "the
 * user declined" and "nobody answered in time". The buffer is what makes the
 * reported outcome accurate; pi's own timer still fires for a client that
 * disappeared before it could report, which is exactly when a guess is needed.
 */
const REPORT_SLACK_MS = 30_000;

/** One selectable answer offered to the user. */
interface AskUserOption {
  label: string;
  description?: string;
}

/**
 * A caller-declared presentation intent.
 *
 * It says the question *is* a known kind of decision so a UI that recognises
 * the tag can present it as such. It changes presentation only: the answer is
 * the same option label a generic card would send, and a client that does not
 * know the tag renders the ordinary list — which is exactly what the web client
 * does when the tag is absent or unreadable.
 */
interface AskUserIntent {
  kind: "plan-review";
  /** The option label that approves the plan; every other label declines it. */
  approve: string;
  /**
   * The tool invocation that submitted the plan, when there is one.
   *
   * Passed through to the client so it can reopen the *logged* plan after the
   * review closes (dsh's `PlanReview.callId`, and the same field name here).
   */
  callId?: string;
}

/** One question in a batch, after validation. */
interface AskUserQuestion {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: AskUserOption[];
  multiSelect?: boolean;
  intent?: AskUserIntent;
}

/** One answered question, as this tool returns it. */
interface AskUserAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

/** What the call turned into: the answers, or why there are none. */
interface AskUserDetails {
  questions: AskUserQuestion[];
  answers: AskUserAnswer[];
  outcome: "answered" | "cancelled" | "timed-out";
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  details: AskUserDetails;
};

const OptionSchema = Type.Object({
  label: Type.String({ description: "Short user-facing option label." }),
  description: Type.Optional(
    Type.String({ description: "One sentence explaining the tradeoff or impact." }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Stable id for this question; echoed in the answer." }),
  question: Type.String({ description: "The specific question to ask the user." }),
  header: Type.Optional(
    Type.String({ description: 'Optional short heading, such as "Confirm" or "Choose Mode".' }),
  ),
  detail: Type.Optional(
    Type.String({
      description: "Optional supporting detail shown with the question but kept out of the options.",
    }),
  ),
  options: Type.Optional(
    Type.Array(OptionSchema, {
      description:
        'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
    }),
  ),
  multi_select: Type.Optional(
    Type.Boolean({ description: "Whether the user may select more than one option. Defaults to false." }),
  ),
  intent: Type.Optional(
    Type.Object({
      kind: Type.Literal("plan-review", {
        description: "The question is a plan submitted for approval. The plan itself goes in `detail`.",
      }),
      approve: Type.String({
        description: "The option label that approves the plan; every other option declines it.",
      }),
      callId: Type.Optional(
        Type.String({
          description:
            "The tool invocation that submitted the plan, when it has one; a client uses it to reopen the logged plan.",
        }),
      ),
    }),
  ),
});

const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    description: "Questions to ask the user before continuing.",
  }),
  timeout: Type.Optional(
    Type.Number({
      minimum: -1,
      description:
        "Seconds to wait for an answer before settling the call as pending; -1 waits indefinitely. Defaults to 120.",
    }),
  ),
});

const DESCRIPTION =
  "Ask the user brief, direct questions when you need confirmation, a choice, or missing information "
  + "before proceeding. Ask several questions in one call when they belong together — the user answers "
  + "them as one batch. Use user-facing terms and assume no knowledge of background work or internal names. "
  + 'When you are asking the user to approve a plan you wrote, set the question\'s `intent` to '
  + '{ "kind": "plan-review", "approve": "<one of your option labels>" } and put the plan in `detail`.';

/**
 * The one instruction a settled-by-deadline result carries.
 *
 * It lives in the result text because that text is all the model reads: it has
 * to say that a pending call is not a skipped answer, or the model will treat
 * silence as permission to decide.
 */
const PENDING_NOTICE =
  "No answer arrived before the deadline. This is pending, not a skipped answer. "
  + "Continue useful independent work; the user can still answer, and their reply will arrive "
  + "as a new message. Do not treat this as permission.";

/**
 * Validate what the schema cannot express and normalize the batch.
 *
 * The schema already rejected a missing id or an unknown option key, so this
 * covers the two things it cannot: a blank string and a repeated id. A caller
 * that breaks either has no way to map its own answers back, so the call fails
 * before the user is ever asked.
 */
function toQuestions(raw: readonly { id: string; question: string; header?: string; detail?: string; options?: readonly AskUserOption[]; multi_select?: boolean; intent?: AskUserIntent }[]): AskUserQuestion[] {
  if (raw.length === 0) throw new Error("ask_user_question requires at least one question");
  const questions: AskUserQuestion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = item.id.trim();
    if (id.length === 0) throw new Error("invalid question: `id` must be a non-empty string");
    if (seen.has(id)) throw new Error(`question id ${JSON.stringify(id)} must be unique within this call`);
    seen.add(id);
    const question = item.question.trim();
    if (question.length === 0) throw new Error("invalid question: `question` must be a non-empty string");
    const options = item.options?.map((option) => ({
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    }));
    const intent = item.intent === undefined
      ? undefined
      : validateIntent(item.intent, options, item.detail);
    questions.push({
      id,
      question,
      ...(item.header === undefined ? {} : { header: item.header }),
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      ...(options === undefined ? {} : { options }),
      ...(item.multi_select === undefined ? {} : { multiSelect: item.multi_select }),
      ...(intent === undefined ? {} : { intent }),
    });
  }
  return questions;
}

/**
 * Check the two assertions a type cannot carry about a presentation intent.
 *
 * dsh rejects the whole call for either (`BAD_INTENT`), and so does this: a
 * card told to render an approval for a label it was never offered, or for a
 * plan that was never sent, would put a verdict on screen that the model did
 * not ask for — and the answer would come back naming a label of its own
 * invention. Rejecting the call instead puts the mistake where it can be fixed.
 */
function validateIntent(
  intent: AskUserIntent,
  options: readonly AskUserOption[] | undefined,
  detail: string | undefined,
): AskUserIntent {
  if (detail === undefined || detail.trim().length === 0) {
    throw new Error("invalid intent: a plan-review question requires `detail` to carry the plan");
  }
  const labels = options?.map((option) => option.label) ?? [];
  if (!labels.includes(intent.approve)) {
    throw new Error(
      `invalid intent: approve label ${JSON.stringify(intent.approve)} is not one of this question's options`,
    );
  }
  const callId = intent.callId?.trim();
  return {
    kind: intent.kind,
    approve: intent.approve,
    ...(callId === undefined || callId.length === 0 ? {} : { callId }),
  };
}

/**
 * The wire form the server decodes out of the `select` title.
 *
 * `timeoutMs` is the deadline the *user* sees, which is shorter than the one pi
 * enforces (see `REPORT_SLACK_MS`). It travels in the payload so neither the
 * server nor the browser has to know how much slack this file chose.
 *
 * `callId` is the tool call that asked. The web client uses it for the same
 * thing dsh's card does: a card that names its call can be closed and reopened
 * from the tool call row, so closing only hides it — a card with no call id has
 * nowhere to come back from, and closing it answers `cancelled`.
 */
function encodeRequest(
  questions: readonly AskUserQuestion[],
  timeoutMs: number | undefined,
  callId: string,
): string {
  return `${TITLE_PREFIX}${JSON.stringify({
    v: 1,
    kind: "ask_user",
    questions,
    callId,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })}`;
}

/** The decision the web client serialized into the select's value. */
function decodeWireAnswer(value: string): { answers?: AskUserAnswer[]; timedOut?: true } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  if (body.timedOut === true) return { timedOut: true };
  if (!Array.isArray(body.answers)) return null;
  const answers: AskUserAnswer[] = [];
  for (const entry of body.answers) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string") return null;
    const selected = Array.isArray(item.selected)
      ? item.selected.filter((label): label is string => typeof label === "string")
      : [];
    const custom = typeof item.custom === "string" ? item.custom : undefined;
    answers.push({ id: item.id, selected, ...(custom === undefined ? {} : { custom }) });
  }
  return { answers };
}

/**
 * Check that an answer batch lines up with the questions it claims to answer.
 *
 * One answer per question is the shape every client is supposed to send, and
 * the one the web card always sends. Anything else is a client bug or a
 * hand-written frame, and failing is better than accepting it: a question with
 * no answer item is indistinguishable from one the user skipped, so silence
 * would be recorded as a decision nobody made. dsh's host rejects the same
 * batch, for the same reason.
 */
function assertAligned(questions: readonly AskUserQuestion[], answers: readonly AskUserAnswer[]): void {
  const expected = new Set(questions.map((question) => question.id));
  const seen = new Set<string>();
  for (const answer of answers) {
    if (!expected.has(answer.id)) {
      throw new Error(`invalid answer batch: no question has id ${JSON.stringify(answer.id)}`);
    }
    if (seen.has(answer.id)) {
      throw new Error(`invalid answer batch: id ${JSON.stringify(answer.id)} appears twice`);
    }
    seen.add(answer.id);
  }
  if (seen.size !== expected.size) {
    const missing = [...expected].filter((id) => !seen.has(id));
    throw new Error(
      `invalid answer batch: missing an answer for ${missing.map((id) => JSON.stringify(id)).join(", ")}`,
    );
  }
}

function answered(questions: AskUserQuestion[], answers: AskUserAnswer[]): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ answers }) }],
    details: { questions, answers, outcome: "answered" },
  };
}

function settled(
  questions: AskUserQuestion[],
  outcome: "cancelled" | "timed-out",
  text: string,
): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: { questions, answers: [], outcome },
  };
}

/**
 * The result of a dialog that closed itself without an answer.
 *
 * An aborted turn is not the user declining — dsh reports it separately
 * (`ASK_ABORTED`) — and the difference is worth keeping, because silence that
 * reads as a refusal invites the model to treat an interruption as a decision.
 */
function dismissed(questions: AskUserQuestion[], signal: AbortSignal | undefined): ToolResult {
  return settled(
    questions,
    "cancelled",
    signal?.aborted === true
      ? "Error: ask_user_question was aborted before the user answered"
      : "Error: ask_user_question was cancelled before the user answered",
  );
}

/**
 * The options pi should wait for a dialog with.
 *
 * `timeout` is pi's own backstop, which the caller chooses per mode (see
 * `REPORT_SLACK_MS`). `signal` makes an aborted turn dismiss the dialog instead
 * of leaving it up until the deadline — the only form of dsh's `ASK_ABORTED`
 * pi's UI sub-protocol offers.
 */
function dialogOptions(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): { timeout?: number; signal?: AbortSignal } | undefined {
  if (timeoutMs === undefined && signal === undefined) return undefined;
  return {
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Ask through the RPC sub-protocol: one `select` carrying the whole batch.
 *
 * `undefined` is pi settling the dialog itself, and it happens three ways that
 * matter: the client cancelled, a client that is no longer there let the
 * deadline pass, or the calling turn was aborted. The extension asked for a
 * window, so its own clock tells the first two apart — a cancel comes back at
 * once, a deadline after roughly that window — and the signal tells the third
 * (dsh's `ASK_ABORTED`, which is likewise not a decision the user made).
 */
async function askOverRpc(
  ctx: ExtensionContext,
  questions: AskUserQuestion[],
  timeoutSeconds: number,
  callId: string,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const value = await ctx.ui.select(
    encodeRequest(questions, timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined, callId),
    [OPTION_SENTINEL],
    dialogOptions(timeoutSeconds > 0 ? timeoutSeconds * 1000 + REPORT_SLACK_MS : undefined, signal),
  );
  if (value === undefined) {
    // An aborted turn dismisses the dialog; it is not the user declining the
    // question, and saying so keeps the model from reading the interruption as
    // an answer it should act on.
    if (signal?.aborted === true) return dismissed(questions, signal);
    const waitedMs = Date.now() - startedAt;
    const expired = timeoutSeconds > 0 && waitedMs >= timeoutSeconds * 1000;
    if (expired) return settled(questions, "timed-out", PENDING_NOTICE);
    return dismissed(questions, signal);
  }
  const decoded = decodeWireAnswer(value);
  if (decoded?.timedOut === true) return settled(questions, "timed-out", PENDING_NOTICE);
  if (decoded?.answers === undefined) {
    return settled(
      questions,
      "cancelled",
      "Error: ask_user_question received an answer it could not read",
    );
  }
  assertAligned(questions, decoded.answers);
  return answered(questions, decoded.answers);
}

/**
 * Ask through ordinary dialogs, one per question.
 *
 * This is the terminal fallback, and it is deliberately the plainest thing that
 * works: a `select` for a single choice, a sequence of confirms for a
 * multi-select, and free text when there are no options. A batch-wide cancel
 * discards the answers already collected, because the tool has nothing coherent
 * to return from half a batch.
 */
async function askInTui(
  ctx: ExtensionContext,
  questions: AskUserQuestion[],
  timeoutSeconds: number,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const opts = dialogOptions(timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined, signal);
  const answers: AskUserAnswer[] = [];

  for (const question of questions) {
    const title = question.header === undefined
      ? question.question
      : `${question.header}: ${question.question}`;
    const options = question.options ?? [];

    if (options.length === 0) {
      const text = await ctx.ui.input(title, "Your answer", opts);
      if (text === undefined) return dismissed(questions, signal);
      answers.push({ id: question.id, selected: [], ...(text.length === 0 ? {} : { custom: text }) });
      continue;
    }

    if (question.multiSelect === true) {
      const selected: string[] = [];
      for (const option of options) {
        const label = option.description === undefined
          ? option.label
          : `${option.label} — ${option.description}`;
        const yes = await ctx.ui.confirm(title, label, opts);
        // An abort dismisses the confirm as `false`; stopping here keeps a
        // half-answered multi-select from being submitted as a skip.
        if (signal?.aborted === true) return dismissed(questions, signal);
        if (yes) selected.push(option.label);
      }
      answers.push({ id: question.id, selected });
      continue;
    }

    const labels = options.map((option) =>
      option.description === undefined ? option.label : `${option.label} — ${option.description}`,
    );
    const picked = await ctx.ui.select(title, labels, opts);
    if (picked === undefined) return dismissed(questions, signal);
    // The row was rendered with its description appended, so map the index back
    // to the bare label the model wrote.
    const index = labels.indexOf(picked);
    const option = index >= 0 ? options[index] : undefined;
    answers.push({ id: question.id, selected: [option?.label ?? picked] });
  }

  return answered(questions, answers);
}

/** The plain-text body of a result, for the paths that have no details to draw. */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  const block = result.content[0];
  return block?.type === "text" ? (block.text ?? "") : "";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User",
    description: DESCRIPTION,
    promptSnippet: "Ask the user a batched question when a decision or missing detail blocks progress",
    promptGuidelines: [
      "Ask before deciding when the answer is expensive to undo: the data model, a public API, a dependency choice, anything the user will have to live with.",
      "Decide yourself when the user told you to, or when a wrong choice is cheap to reverse — an unnecessary question costs the user a turn.",
      "Read the repository (and the session so far) before asking about anything it already answers.",
    ],
    parameters: AskUserParams,
    executionMode: "sequential",

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const questions = toQuestions(params.questions);
      const timeoutSeconds = params.timeout ?? DEFAULT_TIMEOUT_SECONDS;

      if (!ctx.hasUI) {
        return settled(
          questions,
          "cancelled",
          "Error: ask_user_question is unavailable because this session has no interactive UI",
        );
      }
      if (ctx.mode === "tui") return askInTui(ctx, questions, timeoutSeconds, signal);
      return askOverRpc(ctx, questions, timeoutSeconds, toolCallId, signal);
    },

    renderCall(args, theme) {
      const questions = Array.isArray(args?.questions) ? args.questions : [];
      const labels = questions
        .map((question) => question.header ?? question.id)
        .filter((label): label is string => typeof label === "string");
      let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
      text += theme.fg("muted", `${String(questions.length)} question${questions.length === 1 ? "" : "s"}`);
      if (labels.length > 0) text += theme.fg("dim", ` (${labels.join(", ")})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, options: ToolRenderResultOptions, theme) {
      const details = result.details as AskUserDetails | undefined;
      if (details === undefined) return new Text(textOf(result), 0, 0);
      if (details.outcome === "cancelled") return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      if (details.outcome === "timed-out") {
        return new Text(theme.fg("warning", "No answer before the deadline — still answerable"), 0, 0);
      }
      const lines = details.answers.map((answer) => {
        const chosen = answer.selected.join(", ");
        const shown = answer.custom === undefined
          ? chosen.length > 0 ? chosen : "(skipped)"
          : chosen.length > 0 ? `${chosen} + ${answer.custom}` : answer.custom;
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${theme.fg("text", shown)}`;
      });
      // The transcript row is a summary; the full batch is in the tool result
      // the model reads, and the terminal only has room for the verdict.
      const shown = options.expanded ? lines : lines.slice(0, 5);
      const remainder = lines.length - shown.length;
      const body = remainder > 0 ? `${shown.join("\n")}\n${theme.fg("dim", `... ${String(remainder)} more`)}` : shown.join("\n");
      return new Text(body, 0, 0);
    },
  });
}
