import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { PACKAGE_ROOT } from "./config.ts";

/**
 * Agent presets: how a session's pi process is composed at spawn time.
 *
 * Ported from deepseek-harness's agent presets (`packages/preset/agent-preset`),
 * whose `minimal` row (`packages/bundle/web-app/presets/minimal.patch.yml`)
 * fixes the whole system prompt to one sentence, composes a single persistent
 * shell, and leaves every other prompt section and model-facing plugin absent.
 *
 * pi has no RPC for swapping tools or the system prompt — `docs/rpc-commands.md`
 * has no `set_tools`/`set_system_prompt` — so a preset is only expressible as
 * process arguments. That is not a limitation to work around: it is exactly
 * dsh's own `agent-preset/locked` rule ("the session's conversation has started,
 * so its composition is fixed"), reached through the process instead of the
 * durable log.
 */

/**
 * The extension that carries the `/web` command, and the only entry in the
 * package's `pi.extensions` manifest.
 *
 * The minimal preset disables extension discovery outright (`--no-extensions`),
 * which drops that one entry and nothing else — every other file under
 * `extensions/` reaches a session as an explicit argument
 * (see `SESSION_EXTENSIONS`). `/web` is put back explicitly: it is this
 * deployment's own entry point, and dsh keeps its platform shell in the same
 * way (`persistent-shell` survives in `minimal.patch.yml` while everything
 * else is gone).
 *
 * The file is only referenced when it exists, so a checkout with the
 * `extensions/` directory stripped still boots; it just loses `/web`.
 */
const WEB_EXTENSION = join(PACKAGE_ROOT, "extensions", "index.js");
const APPROVAL_EXTENSION = join(PACKAGE_ROOT, "extensions", "approval-gate.ts");

/**
 * The tools and the plan mode this deployment loads into the pi processes it
 * spawns.
 *
 * None of these files is in the package's `pi.extensions` manifest. That
 * manifest is what turns a `pi install npm:pi-web-simple` (or a `packages`
 * entry) into tools for *every* session on the machine, and none of them
 * belongs there:
 *
 * - `ask-user`'s batch format is only decodable by this deployment's client. A
 *   terminal session could at best unfold one batch into a series of native
 *   dialogs, and it would pay for that with a tool slot and three
 *   `promptGuidelines` lines in the system prompt of every unrelated session.
 * - `todo`'s payload is a whole-list snapshot in `details.todos`, which is the
 *   shape this deployment's panel and transcript row project. Listed in the
 *   manifest, its only contribution to a terminal session is one more tool row
 *   and its prompt snippet.
 * - `plan-mode` is a collaboration stance rather than a capability, but it
 *   carries the same cost: a `/plan` command, an `exit_plan_mode` tool, and one
 *   prompt section in **every** session on the machine. Plan mode is a decision
 *   this deployment's user makes in its own UI.
 *
 * The consequence, stated rather than implied: a plain terminal session has no
 * question tool, no todo tool (pi ships neither), no `/todos` overlay, and no
 * plan mode. All three files keep the branch that serves a terminal
 * (`ctx.mode === "tui"`) for a session that loads them by hand —
 * `pi -e extensions/todo.ts`, and likewise for the other two.
 *
 * The minimal preset gets none of them (see `presetSpawnArgs`): dsh's minimal
 * roster has no todo tool, no question batch, and no plan mode.
 *
 * Guarded by the caller, like `/web`: pi treats an explicit path it cannot load
 * as a startup error, and losing a tool beats losing the session.
 */
const SESSION_EXTENSIONS: readonly string[] = [
  join(PACKAGE_ROOT, "extensions", "ask-user.ts"),
  join(PACKAGE_ROOT, "extensions", "todo.ts"),
  join(PACKAGE_ROOT, "extensions", "plan-mode.ts"),
];

/** The preset a session runs when the caller names none. */
export const DEFAULT_PRESET_ID = "standard";

/**
 * The entire system prompt of the minimal preset.
 *
 * Byte-for-byte dsh's `persona.prefix`. It doubles as the reverse-lookup key:
 * a session whose leading system message carries this text ran minimal.
 */
export const MINIMAL_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

/**
 * Arguments that are always sent when the minimal preset is selected.
 *
 * Each one maps to one line of `minimal.patch.yml`:
 *
 * - `--system-prompt` is `persona.complete: true` — the whole prompt, not an
 *   append, which is what makes `includeRuntimeContext: false` fall out.
 * - `--tools bash` is the single persistent shell.
 * - `--no-context-files` / `--no-skills` are "no workspace instructions, no
 *   skills"; `--no-mcp` is "no MCP-facing plugin"; `--no-prompt-templates`
 *   keeps the roster down to the tools and the one command this deployment
 *   owns — dsh's minimal composition holds nothing else either.
 */
const MINIMAL_ARGS: readonly string[] = [
  "--system-prompt",
  MINIMAL_SYSTEM_PROMPT,
  "--tools",
  "bash",
  "--no-context-files",
  "--no-skills",
  "--no-mcp",
  "--no-prompt-templates",
  "--no-extensions",
];

/** One selectable composition, as the server and the creation UI read it. */
export interface AgentPreset {
  /** Stable identifier; also the row's fallback label. */
  id: string;
  /**
   * The prompt this preset fixes, or null when the session keeps pi's own.
   * A non-null value is the reverse-lookup key for a session file.
   */
  systemPrompt: string | null;
  /**
   * The tools this preset declares to the model, or null for pi's default
   * selection. Used only to recognize a session file after the fact.
   */
  tools: readonly string[] | null;
  /** Extra CLI arguments, appended after the session arguments. */
  args: readonly string[];
}

export const PRESETS: readonly AgentPreset[] = [
  {
    id: DEFAULT_PRESET_ID,
    systemPrompt: null,
    tools: null,
    args: [],
  },
  {
    id: "minimal",
    systemPrompt: MINIMAL_SYSTEM_PROMPT,
    tools: ["bash"],
    args: MINIMAL_ARGS,
  },
];

/** Every selectable preset, in the order the creation UI offers them. */
export function listPresets(): readonly AgentPreset[] {
  return PRESETS;
}

/**
 * The preset with this id, or null when no declaration matches.
 *
 * Null rather than a throw: the caller that owns the HTTP status is the route,
 * and an unknown id from a request is a 400 there, not a server fault.
 */
export function findPreset(id: string): AgentPreset | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * Arguments to append to a spawn for this preset.
 *
 * An unknown id spawns the default rather than failing here: the process is
 * already being started, and refusing would turn a bad label into a dead
 * session. Request validation happens at the route, where a 400 is answerable.
 */
export function presetSpawnArgs(id: string | undefined): string[] {
  const preset = (id === undefined ? null : findPreset(id)) ?? PRESETS[0]!;
  if (!existsSync(APPROVAL_EXTENSION)) throw new Error("Required approval gate is missing");
  const gate = ["--extension", APPROVAL_EXTENSION];
  if (preset.id !== "minimal") {
    const loaded: string[] = [];
    for (const file of SESSION_EXTENSIONS) {
      if (process.env.PI_WEB_SIMPLE_EXTERNAL_TODO === "1" && basename(file) === "todo.ts") continue;
      if (existsSync(file)) loaded.push("--extension", file);
    }
    return [...preset.args, ...gate, ...loaded];
  }
  // `--extension` is omitted rather than pointed at a missing file: pi treats an
  // explicit path that does not load as a startup error, and losing `/web` is a
  // far better outcome than losing the session.
  return existsSync(WEB_EXTENSION) ? [...preset.args, ...gate, "--extension", WEB_EXTENSION] : [...preset.args, ...gate];
}

/** The declared text of a system message, one string per part. */
function systemMessageParts(message: {
  content?: unknown;
  sections?: Record<string, string | null> | undefined;
}): string[] {
  const parts: string[] = [];
  if (typeof message.content === "string") {
    if (message.content.length > 0) parts.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  for (const value of Object.values(message.sections ?? {})) {
    if (typeof value === "string") parts.push(value);
  }
  return parts;
}

/**
 * The preset a session's leading system message implies.
 *
 * pi persists the prompt sections and tool declarations of the first request as
 * a leading system message (`docs/session-format.md`), and replays later system
 * messages as patches on top. Reading the *first* one therefore answers "how was
 * this session composed" — later changes are irrelevant, because a preset is
 * fixed at spawn.
 *
 * The match is per part, not on the message as a whole: `--system-prompt`
 * replaces the persona section, but pi still attaches its own runtime context
 * (a `<cwd>` section, observed with the flags this file passes), and comparing
 * the concatenation would never see the persona for the cwd beside it. That is
 * also why the tool list backs it up — a minimal session declares exactly bash,
 * which stays true however pi lays the prompt out.
 */
export function presetIdFromSystemMessage(message: {
  content?: unknown;
  sections?: Record<string, string | null> | undefined;
  toolsAdded?: readonly { name?: unknown }[] | undefined;
}): string {
  const parts = systemMessageParts(message).map((part) => part.trim());
  for (const preset of PRESETS) {
    if (preset.systemPrompt !== null && parts.includes(preset.systemPrompt)) return preset.id;
  }

  const declared = new Set(
    (message.toolsAdded ?? []).map((tool) => tool.name).filter((name): name is string => typeof name === "string"),
  );
  for (const preset of PRESETS) {
    if (preset.tools === null) continue;
    if (declared.size !== preset.tools.length) continue;
    if (preset.tools.every((name) => declared.has(name))) return preset.id;
  }

  return DEFAULT_PRESET_ID;
}
