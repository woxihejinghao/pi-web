/**
 * Skill commands arrive pre-expanded, so they have to be folded back.
 *
 * pi resolves `/skill:<name> [args]` before the message is stored: the
 * transcript keeps the skill's *entire* SKILL.md wrapped in a tag, not the
 * command the user typed.
 *
 *   <skill name="git-commit" location="/Users/…/skills/git-commit/SKILL.md">
 *   References are relative to /Users/…/skills/git-commit.
 *
 *   …the whole file…
 *   </skill>
 *
 * dsh never has this problem — it stores the literal `/git-commit` and renders
 * it as an inline chip — so this is the pi-side equivalent: pi's own parse
 * (`parseSkillBlock`, `dist/core/agent-session.js`) so the two never disagree
 * about what a skill block is, plus the label to show instead of a two-kilobyte
 * file dump.
 */

/** A parsed skill block: what pi inlined, and what the user typed around it. */
export interface SkillBlock {
  /** Skill name, e.g. `git-commit`. */
  name: string;
  /** Absolute path of the SKILL.md the body was read from. */
  location: string;
  /** Everything between the tags — the skill body. */
  content: string;
  /** Text the user appended after the command, when there was any. */
  userMessage?: string;
}

/**
 * pi's regex, byte for byte. The optional trailing group is the user's own
 * text: `/skill:git-commit fix the typo` expands to the block plus a blank line
 * plus `fix the typo`, and losing it would drop what the user actually asked.
 */
const SKILL_BLOCK =
  /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** Parse a skill block out of a user message, or null when it is not one. */
export function parseSkillBlock(text: string): SkillBlock | null {
  const match = SKILL_BLOCK.exec(text);
  if (match === null) return null;
  const userMessage = match[4]?.trim();
  return {
    name: match[1] as string,
    location: match[2] as string,
    content: match[3] as string,
    ...(userMessage ? { userMessage } : {}),
  };
}

/**
 * The command the user actually typed. pi names every skill command
 * `skill:<name>` (`get_commands`, and `_expandSkillCommand` only expands that
 * prefix), so this is what the completion menu offered and what the reader can
 * type again.
 */
export function skillCommandLabel(name: string): string {
  return `/skill:${name}`;
}

/**
 * The text to show, and to copy, for a user message.
 *
 * A skill block collapses to its command — the file body is the model's context,
 * not the user's message. Everything else passes through untouched.
 */
export function displayUserText(text: string): string {
  const block = parseSkillBlock(text);
  if (block === null) return text;
  const label = skillCommandLabel(block.name);
  return block.userMessage === undefined ? label : `${label} ${block.userMessage}`;
}
