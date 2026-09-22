/**
 * pi's model providers, read from and written to pi's own config files.
 *
 * There is no RPC for this. pi's RPC surface covers a running *session* —
 * switching the model it talks to, listing what is available, and so on — but
 * the provider definitions and their credentials are read from `models.json`
 * and `auth.json` once at startup, before any session exists. So this module
 * edits those two files directly.
 *
 * Layout, per `ModelsJsonProvider` in pi's `core/model-config.d.ts`:
 *
 *   models.json  { providers: { <id>: { name, baseUrl, api, apiKey?, models: [...] } } }
 *   auth.json    { <id>: { type: "api_key", key: "..." } }
 *
 * pi accepts a credential in either place (`apiKey` inline, or `auth.json`
 * under the provider id) and treats them as equivalent. We read both, and
 * write `auth.json`, because that is where pi's own login flow stores them and
 * keeping every secret in one 0600 file is easier to reason about than secrets
 * scattered through a definition file the user is likely to paste into a chat.
 *
 * Everything here preserves fields it does not understand. The provider schema
 * is large — `compat`, `modelOverrides`, `thinkingLevelMap`, per-model `cost`,
 * `contextWindow` — and a save that rebuilt a provider from only the fields
 * this UI renders would silently delete the rest of the user's configuration.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Both paths are resolved per call rather than cached at module load, because
 * pi reads `PI_CODING_AGENT_DIR` on every `getAgentDir()`. Tests point that
 * variable at a scratch directory; a cached path would escape the sandbox and
 * write to the user's real config.
 */
export function modelsPath(): string {
  return join(getAgentDir(), "models.json");
}

export function authPath(): string {
  return join(getAgentDir(), "auth.json");
}

/**
 * pi's built-in providers, from `KnownProvider` in `@earendil-works/pi-ai`.
 *
 * This is what "自定义" means in the UI: a provider id outside this list is one
 * the user invented, and only they know its endpoint and protocol. A known id
 * still needs a key, but pi supplies the base URL and wire protocol, so the
 * editor can leave those alone.
 *
 * Kept as a literal instead of imported because `pi-ai` is a transitive
 * dependency of the pi launcher and pnpm's strict layout does not expose it. If
 * pi adds a provider, the worst case is one that could have been recognised is
 * labelled 自定义 — a cosmetic miss, not a wrong write.
 */
export const KNOWN_PROVIDERS: readonly string[] = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "google",
  "google-vertex",
  "openai",
  "azure-openai-responses",
  "openai-codex",
  "radius",
  "nvidia",
  "deepseek",
  "github-copilot",
  "xai",
  "groq",
  "cerebras",
  "openrouter",
  "vercel-ai-gateway",
  "zai",
  "zai-coding-cn",
  "mistral",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
  "huggingface",
  "fireworks",
  "together",
  "baseten",
  "opencode",
  "opencode-go",
  "kimi-coding",
  "meta",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
];

/**
 * Wire protocols pi can speak, from the `Api` union in `@earendil-works/pi-ai`.
 * `radius` is OAuth-only and has no key to enter, but it is a valid value for
 * the field, so the editor offers it rather than rejecting a hand-edited file.
 */
export const API_PROTOCOLS: readonly string[] = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "azure-openai-responses",
  "amazon-bedrock",
  "radius",
];

/** Provider ids are lowercase, start with a letter, and may use digits/dashes. */
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    // A missing file is the normal state before the first provider is added,
    // not an error. Anything else (permissions, a directory in the way) is.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ModelConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ModelConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new ModelConfigError(`${path} must contain a JSON object`);
  return parsed;
}

/** A model entry inside a provider. pi only requires `id`. */
export interface ProviderModelEntry {
  id: string;
  name?: string;
}

/** What the settings page renders for one provider. Never carries a secret. */
export interface ModelProviderView {
  id: string;
  name: string;
  baseUrl: string | null;
  api: string | null;
  /** A credential exists in `auth.json` or inline in `models.json`. */
  configured: boolean;
  /**
   * Where that credential lives. `auth.json` entries are the ones this UI
   * writes; `inline` is a key pasted straight into `models.json`, which we
   * report but do not manage.
   */
  keySource: "auth" | "inline" | null;
  /** True when the id is not in pi's built-in catalog, i.e. user-invented. */
  custom: boolean;
  models: ProviderModelEntry[];
}

function readModels(provider: Record<string, unknown>): ProviderModelEntry[] {
  const list = provider.models;
  if (!Array.isArray(list)) return [];
  const out: ProviderModelEntry[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    out.push({
      id: entry.id,
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
    });
  }
  return out;
}

/** Read every configured provider, with credential state but no credentials. */
export async function readProviders(): Promise<ModelProviderView[]> {
  const models = await readJsonFile(modelsPath());
  const auth = await readJsonFile(authPath());
  const providers = isRecord(models.providers) ? models.providers : {};

  const out: ModelProviderView[] = [];
  for (const [id, value] of Object.entries(providers)) {
    if (!isRecord(value)) continue;
    const entry = auth[id];
    const hasAuthKey =
      isRecord(entry) && entry.type === "api_key" && typeof entry.key === "string" && entry.key.length > 0;
    const hasInlineKey = typeof value.apiKey === "string" && value.apiKey.length > 0;

    out.push({
      id,
      name: typeof value.name === "string" && value.name.length > 0 ? value.name : id,
      baseUrl: typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? value.baseUrl : null,
      api: typeof value.api === "string" && value.api.length > 0 ? value.api : null,
      configured: hasAuthKey || hasInlineKey,
      keySource: hasAuthKey ? "auth" : hasInlineKey ? "inline" : null,
      custom: !KNOWN_PROVIDERS.includes(id),
      models: readModels(value),
    });
  }

  // Insertion order from `models.json`, which `JSON.parse` preserves for
  // string keys. Sorting would fight the user: they add a provider and expect
  // it where they put it, not wherever its id falls alphabetically. It is also
  // the order dsh shows — its known provider first, then the user's own rows in
  // the order they were created.
  return out;
}

/**
 * One model definition, as far as the composer needs it.
 *
 * The settings page renders only `id` and `name`, but the input bar also wants
 * the model's display name and its `contextWindow` — so this keeps the two
 * fields the editor deliberately drops. Everything else in the entry
 * (`cost`, `maxTokens`, `compat`, …) is still ignored here.
 */
export interface CatalogModel {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
}

/** `models.json`'s model list, keyed by provider id then model id. */
export type ModelCatalog = Map<string, Map<string, CatalogModel>>;

/**
 * The provider/model definitions on disk, keyed for lookup.
 *
 * This is the same file and the same entries pi resolves at startup, which is
 * what makes it usable for the model the composer shows before any process
 * exists: the session's JSONL records a `model_change` entry, and this turns
 * that pair back into a name and a context window. Reading it is not inventing a
 * catalog — a model missing from here is one pi would not know either.
 */
export async function readModelCatalog(): Promise<ModelCatalog> {
  const models = await readJsonFile(modelsPath());
  const providers = isRecord(models.providers) ? models.providers : {};
  const catalog: ModelCatalog = new Map();
  for (const [providerId, value] of Object.entries(providers)) {
    if (!isRecord(value)) continue;
    const list = Array.isArray(value.models) ? value.models : [];
    const entries = new Map<string, CatalogModel>();
    for (const raw of list) {
      if (!isRecord(raw) || typeof raw.id !== "string") continue;
      entries.set(raw.id, {
        id: raw.id,
        ...(typeof raw.name === "string" ? { name: raw.name } : {}),
        ...(typeof raw.contextWindow === "number" ? { contextWindow: raw.contextWindow } : {}),
        ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
      });
    }
    catalog.set(providerId, entries);
  }
  return catalog;
}

export interface ProviderInput {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  /**
   * Write-only. `undefined` leaves the stored key untouched, which is what the
   * editor sends when the user did not retype it — the page never receives the
   * current key, so it cannot echo one back. An empty string clears it.
   */
  apiKey?: string;
  models?: ProviderModelEntry[];
}

export function validateProviderId(id: string): string {
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new ModelConfigError("需以小写字母开头，之后可用小写字母、数字和短横线。");
  }
  return id;
}

// --- asking a provider what models it offers --------------------------------

/** How long to wait on a provider before giving up, in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Where a provider lists its models.
 *
 * Anthropic's listing endpoint hangs off the version prefix, which lives in the
 * path rather than the host (`https://api.anthropic.com/v1/models`) while its
 * message endpoint is reached as `{baseUrl}/v1/messages`. So the prefix is
 * appended only when the user has not already typed it — plenty of people paste
 * a base URL that already ends in `/v1`, and doubling it asks for a path the
 * provider does not serve.
 */
function modelsEndpoint(baseUrl: string, api: string | null): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    return /\/v\d+$/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
  }
  return `${trimmed}/models`;
}

/**
 * Credential headers, chosen by wire protocol.
 *
 * Anthropic takes the key in `x-api-key` and requires a version header; every
 * OpenAI-shaped endpoint takes a bearer token. pi's own `anthropic-messages`
 * transport accepts either `x-api-key` or `authorization`, but a proxy that
 * mirrors only the documented form is common enough that sending the canonical
 * one is the safer default.
 */
function authHeaders(api: string | null, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey === undefined || apiKey.length === 0) return headers;
  if (api === "anthropic-messages") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Read a model list out of whatever shape came back.
 *
 * OpenAI and Anthropic both answer `{ data: [{ id, … }] }`, which is the common
 * case. `{ models: [...] }` and a bare string array are also seen in the wild
 * from self-hosted gateways, and accepting them costs one branch.
 */
function parseModelList(body: unknown): ProviderModelEntry[] {
  // A bare array is the list itself; otherwise it is nested under a key.
  const list = Array.isArray(body)
    ? body
    : isRecord(body)
      ? Array.isArray(body.data)
        ? body.data
        : Array.isArray(body.models)
          ? body.models
          : null
      : null;
  if (list === null) {
    throw new ModelConfigError(
      isRecord(body) || Array.isArray(body)
        ? "无法从提供方的响应里找到模型列表。"
        : "提供方的响应不是 JSON 对象。",
    );
  }

  const seen = new Set<string>();
  const out: ProviderModelEntry[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      if (entry.length === 0 || seen.has(entry)) continue;
      seen.add(entry);
      out.push({ id: entry });
      continue;
    }
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    // Anthropic calls it `display_name`; OpenAI-shaped catalogs use `name`.
    const label =
      typeof entry.display_name === "string" && entry.display_name.length > 0
        ? entry.display_name
        : typeof entry.name === "string" && entry.name.length > 0
          ? entry.name
          : undefined;
    out.push(label === undefined ? { id: entry.id } : { id: entry.id, name: label });
  }
  return out;
}

export interface FetchModelsInput {
  /** Used only to fall back to the stored credential when none is supplied. */
  id?: string;
  baseUrl: string;
  api?: string;
  /** A key typed but not yet saved. Absent means "use the stored one". */
  apiKey?: string;
}

/** The credential to use: what the caller typed, else what is on disk. */
async function resolveApiKey(input: FetchModelsInput): Promise<string | undefined> {
  if (input.apiKey !== undefined) {
    return input.apiKey.length > 0 ? input.apiKey : undefined;
  }
  if (input.id === undefined) return undefined;

  const auth = await readJsonFile(authPath());
  const entry = auth[input.id];
  if (isRecord(entry) && entry.type === "api_key" && typeof entry.key === "string") {
    return entry.key;
  }
  const models = await readJsonFile(modelsPath());
  const providers = isRecord(models.providers) ? models.providers : {};
  const provider = providers[input.id];
  if (isRecord(provider) && typeof provider.apiKey === "string") return provider.apiKey;
  return undefined;
}

/**
 * Ask a provider which models it serves.
 *
 * This is not something pi can answer for us. `get_available_models` reports the
 * models already configured, and `refreshModels` is a per-provider method on
 * pi-ai's provider objects — it is not exported and each provider implements its
 * own. So the request is made from here, against the provider's own catalog
 * endpoint.
 *
 * The parameters are deliberately unsaved ones: a provider being created has no
 * id yet and no file to read from, and asking which models exist is exactly how
 * a user finds out what to type into 模型目录.
 */
export async function fetchProviderModels(input: FetchModelsInput): Promise<ProviderModelEntry[]> {
  const baseUrl = validateBaseUrl(input.baseUrl);
  const api = input.api !== undefined && input.api.length > 0 ? input.api : null;
  const url = modelsEndpoint(baseUrl, api);
  const apiKey = await resolveApiKey(input);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: authHeaders(api, apiKey),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (err) {
    const cause = (err as Error).name === "TimeoutError" ? "请求超时" : (err as Error).message;
    throw new ModelConfigError(`无法连接 ${url}：${cause}`);
  }

  if (!response.ok) {
    // The status is the useful part (401 for a bad key, 404 for a wrong path);
    // the body may be an HTML error page, so it is truncated rather than
    // forwarded whole.
    const text = await response.text().catch(() => "");
    const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new ModelConfigError(
      `提供方返回 ${response.status}${detail.length > 0 ? `：${detail}` : ""}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new ModelConfigError(`${url} 的响应不是 JSON：${(err as Error).message}`);
  }
  return parseModelList(body);
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ModelConfigError("请输入有效的 HTTP 或 HTTPS 地址。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ModelConfigError("请输入有效的 HTTP 或 HTTPS 地址。");
  }
  return value;
}

/**
 * Timestamped backup before a write, matching the `.bak.<suffix>` files pi's
 * own tooling leaves behind. Renaming is atomic and the old contents are small,
 * so this is cheap insurance against a bug in the merge below.
 */
async function backup(path: string): Promise<void> {
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ModelConfigError(`cannot back up ${path}: ${(err as Error).message}`);
  }
  const stamp = Math.floor(Date.now() / 1000);
  await writeFile(`${path}.bak.pi-web-simple-${stamp}`, existing, "utf8");
}

/** Temp file + rename, so a crash mid-write cannot truncate the config. */
async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(getAgentDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Merge the model list the editor sent into the one already stored, matching by
 * id.
 *
 * The editor renders only `id` and `name`, but a model entry carries far more —
 * `contextWindow`, `maxTokens`, `cost`, `reasoning`, `input`, `thinkingLevelMap`,
 * `compat`. Rebuilding the array from the two rendered fields would drop all of
 * it: a provider whose model declared a 1M context window would come back with
 * none, and pi would fall back to a default that is wrong for that endpoint.
 *
 * Entries the editor no longer lists are removed, so deleting a model from the
 * dialog still deletes it.
 */
function mergeModels(
  previous: unknown,
  incoming: ProviderModelEntry[],
): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  if (Array.isArray(previous)) {
    for (const entry of previous) {
      if (isRecord(entry) && typeof entry.id === "string") byId.set(entry.id, entry);
    }
  }
  return incoming.map((model) => {
    const merged: Record<string, unknown> = { ...(byId.get(model.id) ?? {}) };
    merged.id = model.id;
    // An empty name means "use the id", which pi expresses by omitting the
    // field — storing `name: ""` would leave a blank label in its model picker.
    if (model.name === undefined || model.name.length === 0) delete merged.name;
    else merged.name = model.name;
    return merged;
  });
}

/**
 * Create or update one provider, merging into whatever is already there.
 *
 * `mode` decides the failure when the id already exists: the "添加提供方" flow
 * passes `create` so a collision is reported instead of quietly overwriting a
 * provider the user forgot about. The editor passes `update`.
 */
export async function saveProvider(
  input: ProviderInput,
  mode: "create" | "update",
): Promise<ModelProviderView> {
  const id = validateProviderId(input.id);
  const models = await readJsonFile(modelsPath());
  const providers = isRecord(models.providers) ? { ...models.providers } : {};
  const existing = isRecord(providers[id]) ? (providers[id] as Record<string, unknown>) : undefined;

  if (mode === "create" && existing !== undefined) {
    throw new ModelConfigError("已有提供方使用了这个 ID。");
  }
  if (mode === "update" && existing === undefined) {
    throw new ModelConfigError(`没有找到提供方 ${id}。`);
  }

  // Spread the existing entry first: unknown fields survive an edit.
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  next.name = input.name !== undefined && input.name.length > 0 ? input.name : (existing?.name ?? id);
  if (input.baseUrl !== undefined) {
    if (input.baseUrl.length > 0) next.baseUrl = validateBaseUrl(input.baseUrl);
    else delete next.baseUrl;
  }
  if (input.api !== undefined) {
    if (input.api.length > 0) next.api = input.api;
    else delete next.api;
  }
  if (input.models !== undefined) {
    next.models = mergeModels(existing?.models, input.models);
  }

  // A key stored inline in models.json would shadow the one we are about to
  // write, and the editor cannot show it to let the user decide. Clearing it
  // matters only when the user is actually setting a key here; a save that
  // leaves `apiKey` untouched would look correct and change nothing.
  if (input.apiKey !== undefined && input.apiKey.length > 0) delete next.apiKey;

  providers[id] = next;
  models.providers = providers;

  await backup(modelsPath());
  await writeJsonAtomic(modelsPath(), models);

  if (input.apiKey !== undefined) {
    const auth = await readJsonFile(authPath());
    if (input.apiKey.length > 0) {
      auth[id] = { type: "api_key", key: input.apiKey };
    } else {
      delete auth[id];
    }
    await backup(authPath());
    await writeJsonAtomic(authPath(), auth);
  }

  const all = await readProviders();
  const saved = all.find((p) => p.id === id);
  if (saved === undefined) throw new ModelConfigError(`无法读回提供方 ${id}。`);
  return saved;
}

/**
 * Remove a provider and the credential this UI is responsible for.
 *
 * A key in `auth.json` is ours to delete — we wrote it and nothing else reads
 * that entry. An inline `models.json.apiKey` disappears with the provider
 * because it lives inside it. Credentials from the environment were never
 * ours, so they are untouched by definition.
 */
export async function deleteProvider(id: string): Promise<void> {
  const models = await readJsonFile(modelsPath());
  const providers = isRecord(models.providers) ? { ...models.providers } : {};
  if (!(id in providers)) throw new ModelConfigError(`没有找到提供方 ${id}。`);
  delete providers[id];
  models.providers = providers;

  await backup(modelsPath());
  await writeJsonAtomic(modelsPath(), models);

  const auth = await readJsonFile(authPath());
  if (id in auth) {
    delete auth[id];
    await backup(authPath());
    await writeJsonAtomic(authPath(), auth);
  }
}
