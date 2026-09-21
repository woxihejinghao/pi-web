import type { SlashCommand } from "../../lib/types.ts";

/** Where an in-progress `/command` started and what follows the slash. */
export interface SlashTrigger {
  /** Text between the slash and the caret; may contain `:` as in `skill:pdf`. */
  query: string;
  /** Index of the `/` within the value. */
  start: number;
}

/**
 * Detect a `/command` token immediately before the caret.
 *
 * The slash has to open a word, so `a/b` and `see /etc/hosts` are ordinary
 * prose while `/skill:pdf` is a command. Whitespace ends the token, which
 * closes the menu as soon as the user starts typing an argument.
 */
export function detectSlashTrigger(value: string, caret: number): SlashTrigger | null {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, safeCaret);
  const match = /(^|\s)\/([^\s/]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { query, start: before.length - query.length - 1 };
}

/**
 * Section order in the menu, and the tiebreaker in `filterCommands`.
 * Relevance still wins: only equally good matches are held together by kind.
 */
const SOURCE_ORDER: Record<SlashCommand["source"], number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

/**
 * Commands matching a query, best match first: prefix hits, then substring
 * hits on the name, then hits on the description only. Ties fall back to the
 * section order so equal matches stay grouped — with an empty query every
 * result is rank 0, which is what makes the menu read as sections.
 */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const needle = query.trim().toLowerCase();
  const scored: { command: SlashCommand; rank: number }[] = [];

  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (needle.length === 0 || name.startsWith(needle)) {
      scored.push({ command, rank: 0 });
    } else if (name.includes(needle)) {
      scored.push({ command, rank: 1 });
    } else if (command.description?.toLowerCase().includes(needle)) {
      scored.push({ command, rank: 2 });
    }
  }

  return scored
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        SOURCE_ORDER[a.command.source] - SOURCE_ORDER[b.command.source] ||
        a.command.name.localeCompare(b.command.name),
    )
    .map((entry) => entry.command);
}

/** Human labels for the badge shown next to each command. */
export const SOURCE_LABEL: Record<SlashCommand["source"], string> = {
  builtin: "内置",
  skill: "技能",
  prompt: "模板",
  extension: "扩展",
};

/**
 * Split `/<name> <args>` when `name` is a built-in command this UI can run.
 *
 * Returns null for everything else — including `/skill:…` and prompt
 * templates, which pi expands on its own — so those are still sent as ordinary
 * prompts. The name may not contain a slash, so `/etc/hosts` never matches.
 */
export function parseBuiltinCommand(
  text: string,
  commands: SlashCommand[],
): { command: SlashCommand; args: string } | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;

  const name = match[1] ?? "";
  const command = commands.find((entry) => entry.source === "builtin" && entry.name === name);
  if (!command) return null;

  return { command, args: (match[2] ?? "").trim() };
}
