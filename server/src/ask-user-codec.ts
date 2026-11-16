/**
 * The one place the web UI's structured-question protocol is translated.
 *
 * pi's extension UI sub-protocol has exactly four dialogs — `select`,
 * `confirm`, `input`, `editor` — and none of them carries a batch of questions,
 * option descriptions, multi-select or a free-form "other". dsh's
 * `ask_user_question` has all four, so the shape has to ride inside a field pi
 * already sends. This module owns that encoding: the `pi-web-simple` extension
 * in `extensions/ask-user.ts` writes the payload into a `select` title, and
 * everything downstream — this server, the browser, the transcript — sees the
 * decoded form instead.
 *
 * Keeping the translation here rather than in the browser is deliberate: the
 * server is already the authority on which dialogs are pending (`ui-requests`)
 * and already filters what reaches a web client (`UI_METHODS_FOR_WEB`), so the
 * browser gets a clean `method: "ask_user"` request and never learns that a
 * sentinel option or a prefixed title was involved.
 *
 * The extension keeps its own copy of the constants and the encoder in the
 * same shape, because it runs in the pi process and cannot import this file.
 * Both sides are covered by tests; the wire format is `v`-versioned so the two
 * can be changed one at a time.
 */

/** Prefix that turns an ordinary `select` title into a question batch. */
export const ASK_USER_TITLE_PREFIX = "pi-web:ask-user:v1:";

/**
 * The single entry in the `select` options array.
 *
 * The batch rides in the title, so the array only exists to satisfy pi's
 * signature. It is a constant rather than an empty array because a client that
 * does not know the protocol should still have something to click, and because
 * an empty list would read as "nothing to choose".
 */
export const ASK_USER_OPTION_SENTINEL = "__pi_web_ask_user__";

/** One selectable answer offered to the user. */
export interface AskUserOption {
  label: string;
  /** Extra context rendered under the label; the answer never includes it. */
  description?: string;
}

/**
 * A caller-declared presentation intent.
 *
 * It says the question *is* a known kind of decision, so a client that
 * recognises the tag may present it as such instead of as a generic option
 * list. The answer encoding is identical either way: an intent changes
 * presentation only, never the protocol.
 */
export interface AskUserIntent {
  kind: "plan-review";
  /** The option label that approves the plan; every other option declines it. */
  approve: string;
  /**
   * The tool invocation that submitted the plan, when there is one.
   *
   * It is what lets a client reopen the *logged* plan after the review closes
   * (dsh carries the same field for the same reason). A review with no
   * invocation — a temporary request made by an extension directly — has none,
   * and then the plan lives only in this request.
   */
  callId?: string;
}

/** One question in a batch. */
export interface AskUserQuestion {
  /** Stable caller-provided id, echoed in the answer. */
  id: string;
  /** The question to display. */
  question: string;
  /** Optional short heading, used as the card's title when present. */
  header?: string;
  /** Optional supporting detail, rendered as markdown under the question. */
  detail?: string;
  /** Choices to render; absent or empty asks for free text only. */
  options?: AskUserOption[];
  /** Whether more than one label may be selected. Defaults to single-select. */
  multiSelect?: boolean;
  /** Presentation hint a capable client may honour; absent asks for the generic list. */
  intent?: AskUserIntent;
}

/** The decoded batch, ready to be shown by any client. */
export interface AskUserBatch {
  questions: AskUserQuestion[];
  /** The card's title: the first question's header, when it declared one. */
  title?: string;
  /**
   * The deadline the user sees, when the extension declared one.
   *
   * It is deliberately shorter than the timeout pi itself enforces: the client
   * reports the deadline by answering `timedOut`, and a report that always lost
   * the race against pi's own timer could not be told apart from a cancel.
   */
  timeoutMs?: number;
  /**
   * The tool call that asked, when the extension named one.
   *
   * It is what makes a card dismissible without cancelling: a card keyed by its
   * tool call only leaves the seat when it is closed, and the tool call row can
   * bring it back. A batch with no call id has no row to come back from, so
   * closing it is the answer (`cancelled`).
   */
  callId?: string;
}

/**
 * Wire body the extension reads off `select`'s resolved value.
 *
 * `answers` is the batch the user submitted, `timedOut` is the countdown
 * expiring with the question still answerable, and `cancelled` arrives as pi's
 * own `{ cancelled: true }` rather than through here.
 */
export interface AskUserWireAnswer {
  answers?: AskUserAnswerItem[];
  timedOut?: true;
}

/** One answered question, as the extension receives it. */
export interface AskUserAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

/**
 * Read a batch out of a `select` title.
 *
 * Anything short of a complete, well-formed batch returns `null` so the caller
 * falls back to treating the request as the plain `select` it also is. That is
 * what keeps a normal extension dialog whose title happens to start with the
 * prefix from being mangled into an unanswerable card.
 */
export function decodeAskUserBatch(title: unknown): AskUserBatch | null {
  if (typeof title !== "string" || !title.startsWith(ASK_USER_TITLE_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(title.slice(ASK_USER_TITLE_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const payload = parsed as Record<string, unknown>;
  if (payload.v !== 1 || payload.kind !== "ask_user") return null;
  const questions = readQuestions(payload.questions);
  if (questions === null) return null;
  const timeoutMs = readTimeoutMs(payload.timeoutMs);
  if (timeoutMs === null) return null;
  // A call id of the wrong shape is dropped rather than rejecting the batch: it
  // decides how closing the card behaves, not what the card asks.
  const callId = readOptionalString(payload.callId);
  const header = questions[0]?.header;
  return {
    questions,
    ...(header === undefined ? {} : { title: header }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(typeof callId === "string" && callId.length > 0 ? { callId } : {}),
  };
}

/**
 * Translate the browser's answer body into the frame pi receives.
 *
 * The browser sends a decision (`answers` / `timedOut` / `cancelled`); pi's
 * `select` resolves to a value, so the decision is serialized into one. `null`
 * means the body was not a decision at all and the route answers 400 rather
 * than handing pi something it cannot parse.
 */
export function encodeAskUserResponse(
  payload: Record<string, unknown>,
  questions?: readonly AskUserQuestion[],
): { value: string } | { cancelled: true } | null {
  if (payload.cancelled === true) return { cancelled: true };
  if (payload.timedOut === true) return { value: JSON.stringify({ timedOut: true } satisfies AskUserWireAnswer) };
  const answers = readAnswers(payload.answers);
  if (answers === null) return null;
  // When the batch is known, the answer has to line up with it: a missing item
  // is indistinguishable from a skipped question downstream, so accepting a
  // partial batch would record silence as a decision. The extension refuses the
  // same shape on the way in (see `assertAligned` in `extensions/ask-user.ts`);
  // this is the earlier, cheaper place to catch a client that got it wrong.
  if (questions !== undefined && !alignedWith(questions, answers)) return null;
  return { value: JSON.stringify({ answers } satisfies AskUserWireAnswer) };
}

/** Whether the answers name every question exactly once, and nothing else. */
function alignedWith(
  questions: readonly AskUserQuestion[],
  answers: readonly AskUserAnswerItem[],
): boolean {
  const expected = new Set(questions.map((question) => question.id));
  if (answers.length !== expected.size) return false;
  const seen = new Set<string>();
  for (const answer of answers) {
    if (!expected.has(answer.id) || seen.has(answer.id)) return false;
    seen.add(answer.id);
  }
  return true;
}

/**
 * Validate the batch the extension put on the wire.
 *
 * The whole batch is rejected rather than partially accepted: a card that
 * silently dropped one malformed question would let the user answer a batch the
 * model never asked, and the ids it echoes back would not line up.
 */
function readQuestions(raw: unknown): AskUserQuestion[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskUserQuestion[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    const id = item.id;
    const question = item.question;
    if (typeof id !== "string" || id.length === 0 || typeof question !== "string") return null;
    if (seen.has(id)) return null;
    seen.add(id);
    const options = item.options === undefined ? undefined : readOptions(item.options);
    if (options === null) return null;
    const header = readOptionalString(item.header);
    const detail = readOptionalString(item.detail);
    if (header === null || detail === null) return null;
    const multiSelect = item.multiSelect;
    if (multiSelect !== undefined && typeof multiSelect !== "boolean") return null;
    const intent = readIntent(item.intent);
    questions.push({
      id,
      question,
      ...(header === undefined ? {} : { header }),
      ...(detail === undefined ? {} : { detail }),
      ...(options === undefined ? {} : { options }),
      ...(multiSelect === undefined ? {} : { multiSelect }),
      ...(intent === undefined ? {} : { intent }),
    });
  }
  return questions;
}

/**
 * Read a presentation intent, or `undefined` when it is not one a client can
 * honour.
 *
 * Unlike the extension — which rejects the call outright, because it is the one
 * that can still tell the model — this degrades to the generic option list.
 * Dropping a tag costs a specialised presentation; refusing the whole batch here
 * would take an answerable question away from the user over a decoration. The
 * answer a generic card produces is the same label either way.
 */
function readIntent(raw: unknown): AskUserIntent | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  if (item.kind !== "plan-review") return undefined;
  if (typeof item.approve !== "string" || item.approve.length === 0) return undefined;
  const callId = readOptionalString(item.callId);
  return {
    kind: "plan-review",
    approve: item.approve,
    // A `callId` of the wrong shape is dropped rather than rejecting the tag: it
    // is a pointer to the logged plan, not part of the decision.
    ...(typeof callId === "string" && callId.length > 0 ? { callId } : {}),
  };
}

function readOptions(raw: unknown): AskUserOption[] | null {
  if (!Array.isArray(raw)) return null;
  const options: AskUserOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.label !== "string" || item.label.length === 0) return null;
    const description = readOptionalString(item.description);
    if (description === null) return null;
    options.push({
      label: item.label,
      ...(description === undefined ? {} : { description }),
    });
  }
  return options;
}

/** `undefined` for absent, `null` for present-but-not-a-positive-number. */
function readTimeoutMs(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

function readAnswers(raw: unknown): AskUserAnswerItem[] | null {
  if (!Array.isArray(raw)) return null;
  const answers: AskUserAnswerItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string") return null;
    const selected = item.selected === undefined ? [] : readStringArray(item.selected);
    if (selected === null) return null;
    const custom = readOptionalString(item.custom);
    if (custom === null) return null;
    answers.push({
      id: item.id,
      selected,
      ...(custom === undefined ? {} : { custom }),
    });
  }
  return answers;
}

function readStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const values: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return null;
    values.push(entry);
  }
  return values;
}

/** `undefined` for absent, `null` for present-but-not-a-string. */
function readOptionalString(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? raw : null;
}
