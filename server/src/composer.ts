/**
 * What the composer shows on the right: which model is answering, what it can
 * be switched to, and how full the context window is.
 *
 * Two sources, because the same input bar has to work before and after pi is
 * running. A resident session answers from its own memory (`get_state`,
 * `get_available_models`, `get_session_stats`) — that view is authoritative and
 * includes turns that have not reached disk yet. A session nobody has opened
 * answers from its JSONL file, because spawning pi just to fill in the input bar
 * would cost 1.5–3.2s (the very latency `readSessionSnapshot` exists to avoid).
 *
 * The disk path is not a guess. A session's model is recorded by pi itself as a
 * `model_change` entry, and the context figure is recomputed with pi's own
 * exported primitives (`estimateTokens`, `calculateContextTokens`,
 * `getLatestCompactionEntry`) following the same rules as
 * `AgentSession.getContextUsage()`. Two things stay genuinely unknown without a
 * process, and are reported as such rather than invented:
 *
 * - **the list of switchable models**, which only exists inside a running pi
 *   (`models: null` — the menu fetches it by asking for a live answer);
 * - **a context window when `models.json` does not declare one**, in which case
 *   there is no percentage to show (pi itself returns `undefined` when
 *   `contextWindow` is 0).
 */

import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  calculateContextTokens,
  estimateTokens,
  getLastAssistantUsage,
  getLatestCompactionEntry,
  type ModelInfo,
  type RpcClient,
  type SessionContext,
} from "@earendil-works/pi-coding-agent";
import { readModelCatalog, type ModelCatalog } from "./models.ts";

/** One selectable model, with just the fields the input bar renders. */
export interface ComposerModel {
  provider: string;
  id: string;
  /** Display name from `models.json`; falls back to the id in the UI. */
  name: string | null;
  /** 0 when unknown, matching pi's own `contextWindow ?? 0`. */
  contextWindow: number;
  reasoning: boolean;
}

/** How full the model's context window is. */
export interface ComposerContext {
  /** Estimated context tokens, or null for "unknown" (pi reports this too). */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface ComposerState {
  /** True when this came from a running pi process rather than the JSONL file. */
  live: boolean;
  model: ComposerModel | null;
  /** null means "no process to ask" — not "no models are configured". */
  models: ComposerModel[] | null;
  context: ComposerContext | null;
}

type ConversationMessage = SessionContext["messages"][number];
type Usage = NonNullable<Extract<ConversationMessage, { role: "assistant" }>["usage"]>;

/** The subset of a provider definition this module reads. */
interface ModelFields {
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
}

function toComposerModel(provider: string, id: string, fields: ModelFields): ComposerModel {
  return {
    provider,
    id,
    name: typeof fields.name === "string" && fields.name.length > 0 ? fields.name : null,
    contextWindow: typeof fields.contextWindow === "number" ? fields.contextWindow : 0,
    reasoning: fields.reasoning === true,
  };
}

/**
 * Usage from an assistant message, or null when none is usable.
 *
 * Aborted and errored replies are skipped rather than counted as zero: they
 * never described a full context, and pi's own `getAssistantUsage` filters the
 * same two stop reasons for the same reason.
 */
function assistantUsageOf(message: ConversationMessage): Usage | null {
  if (message.role !== "assistant") return null;
  const assistant = message as { usage?: Usage; stopReason?: string };
  const usage = assistant.usage;
  if (usage === undefined) return null;
  if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return null;
  return calculateContextTokens(usage) > 0 ? usage : null;
}

/**
 * pi's `estimateContextTokens` for a message list.
 *
 * The function itself is not exported from the package root, so it is rebuilt
 * here from the primitives that are: the last successful reply's usage is the
 * base, and whatever came after it is estimated per message. That is the whole
 * of pi's implementation — a 15-line rule with a test on both branches, rather
 * than a second opinion about how to count tokens.
 */
export function estimateContextTokens(messages: SessionContext["messages"]): number {
  let lastUsage: Usage | null = null;
  let lastIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const usage = assistantUsageOf(messages[i]!);
    if (usage !== null) {
      lastUsage = usage;
      lastIndex = i;
      break;
    }
  }

  if (lastUsage === null) {
    let estimated = 0;
    for (const message of messages) estimated += estimateTokens(message);
    return estimated;
  }

  let trailing = 0;
  for (let i = lastIndex + 1; i < messages.length; i += 1) trailing += estimateTokens(messages[i]!);
  return calculateContextTokens(lastUsage) + trailing;
}

/**
 * Context usage rebuilt from a session file, the way `getContextUsage()` would
 * compute it in a running process.
 *
 * The one subtlety is compaction: the last usage before a compaction describes
 * the context as it was *before* the summary replaced it. If no assistant has
 * replied since, the honest answer is "unknown", which is what pi returns too —
 * a number taken from the wrong side of the compaction would be worse than no
 * number, because it is exactly the moment a user looks at this figure.
 */
export function contextUsageFromDisk(
  manager: SessionManager,
  contextWindow: number,
): ComposerContext | null {
  if (!(contextWindow > 0)) return null;

  const branch = manager.getBranch();
  const compaction = getLatestCompactionEntry(branch);
  if (compaction !== null) {
    const index = branch.lastIndexOf(compaction);
    const after = branch.slice(index + 1);
    // `getLastAssistantUsage` applies pi's own "usable reply" filter, so this
    // asks the same question the runtime asks.
    if (getLastAssistantUsage(after) == null) {
      return { tokens: null, contextWindow, percent: null };
    }
  }

  const tokens = estimateContextTokens(manager.buildSessionContext().messages);
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

/** The model a session was last switched to, as pi recorded it. */
function lastModelChange(manager: SessionManager): { provider: string; modelId: string } | null {
  const entries = manager.getEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type !== "model_change") continue;
    return { provider: entry.provider, modelId: entry.modelId };
  }
  return null;
}

/** Composer state read straight from the session file, with no pi process. */
export async function readComposerFromDisk(
  sessionPath: string,
  catalog?: ModelCatalog,
): Promise<ComposerState> {
  const manager = SessionManager.open(sessionPath);
  const models = catalog ?? (await readModelCatalog());
  const change = lastModelChange(manager);

  if (change === null) {
    // A session pi has minted but never written a model change into: either a
    // new session whose first turn has not landed yet, or a path with no file at
    // all. Both mean "nothing is chosen", which is the truthful thing for the
    // input bar to show — `SessionManager.open` deliberately opens-or-creates,
    // so this is not an error path.
    return { live: false, model: null, models: null, context: null };
  }

  const entry = models.get(change.provider)?.get(change.modelId);
  const model = toComposerModel(change.provider, change.modelId, entry ?? {});
  return {
    live: false,
    model,
    models: null,
    context: contextUsageFromDisk(manager, model.contextWindow),
  };
}

/**
 * Composer state read from a running session — the authoritative view.
 *
 * `get_available_models` only ever answers from inside a process (it is the
 * runtime's resolved model list, scoped to this session's cwd), which is why the
 * disk path cannot supply it.
 */
export async function readComposerFromClient(
  client: RpcClient,
  catalog?: ModelCatalog,
): Promise<ComposerState> {
  const [state, available, stats] = await Promise.all([
    client.getState(),
    client.getAvailableModels(),
    client.getSessionStats(),
  ]);

  const current = state.model ?? null;
  const model = current === null ? null : toComposerModel(current.provider, current.id, current);

  const models = available.map((info: ModelInfo) => {
    // The runtime knows the window; `models.json` knows the display name.
    const entry = catalog?.get(info.provider)?.get(info.id);
    return toComposerModel(info.provider, info.id, {
      name: entry?.name,
      contextWindow: info.contextWindow,
      reasoning: info.reasoning,
    });
  });

  const usage = stats.contextUsage;
  const context: ComposerContext | null =
    usage === undefined
      ? null
      : {
          tokens: typeof usage.tokens === "number" ? usage.tokens : null,
          contextWindow: usage.contextWindow,
          percent: typeof usage.percent === "number" ? usage.percent : null,
        };

  return { live: true, model, models, context };
}

/**
 * Composer state for a session that does not exist yet — the hero's picker.
 *
 * Both answers come from files, not from a process:
 *
 * - the list is pi's own `ModelRuntime`, the very object a running session
 *   answers `get_available_models` from (`getAvailableSnapshot`). It resolves
 *   the built-in provider catalog, `models.json` and the credentials in
 *   `auth.json` in ~15ms and never touches the network, so "available" means
 *   here exactly what it means inside pi: configured *and* authenticated;
 * - the current model is the startup default pi itself reads from settings
 *   (`defaultProvider`/`defaultModel`), with the same fallback pi applies when
 *   that default is missing or no longer usable — the first available model.
 *
 * `context` is null by construction rather than unknown: a session with no
 * turns has no window to report, and showing 0% would read as a measurement.
 */
export async function readComposerFromDefaults(projectPath: string): Promise<ComposerState> {
  const runtime = await sharedModelRuntime();
  const models = runtime.getAvailableSnapshot().map((entry) =>
    toComposerModel(entry.provider, entry.id, {
      name: entry.name,
      contextWindow: entry.contextWindow,
      reasoning: entry.reasoning,
    }),
  );

  const settings = SettingsManager.create(projectPath);
  const provider = settings.getDefaultProvider();
  const id = settings.getDefaultModel();
  const preferred =
    provider !== undefined && id !== undefined
      ? models.find((entry) => entry.provider === provider && entry.id === id)
      : undefined;

  return { live: false, model: preferred ?? models[0] ?? null, models, context: null };
}

/**
 * How long the runtime behind `readComposerFromDefaults` is reused.
 *
 * Building one re-reads the model files and rewrites pi's own
 * `models-store.json`, and React's StrictMode mounts the hero twice in
 * development — so both the double mount and a quick project switch land on one
 * build instead of three. Short enough that a settings change shows up on the
 * next visit rather than after a restart.
 */
const MODEL_RUNTIME_TTL_MS = 5_000;

let modelRuntimeCache: { at: number; promise: Promise<ModelRuntime> } | null = null;

async function sharedModelRuntime(): Promise<ModelRuntime> {
  const cached = modelRuntimeCache;
  if (cached !== null && Date.now() - cached.at < MODEL_RUNTIME_TTL_MS) {
    return await cached.promise;
  }

  let promise: Promise<ModelRuntime>;
  promise = ModelRuntime.create().catch((err: unknown) => {
    // A failed build must not be served from the cache for the rest of the TTL.
    if (modelRuntimeCache?.promise === promise) modelRuntimeCache = null;
    throw err;
  });
  modelRuntimeCache = { at: Date.now(), promise };
  return await promise;
}

/** Test seam: forget the cached runtime so the next read re-resolves the files. */
export function resetDefaultComposerCache(): void {
  modelRuntimeCache = null;
}
