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
 *
 * A bubble, though, does not always hold that block. `useConversation` renders a
 * user turn from what the composer held and drops pi's `message_end` for user
 * messages, so a command sent from the web keeps the literal `/skill:<name>` it
 * was typed as until the session is reloaded from disk. `parseSkillCall` is the
 * one entry point that folds either shape, which is what keeps the chip — and
 * with it the icon and the colour — on a freshly sent skill.
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
 * pi's own command split, `_expandSkillCommand`: the name runs to the first
 * space and everything after it is the user's own text. Matching that exactly
 * matters only for the literal form — a command the local fold recognises but pi
 * does not would draw a chip for something pi never expanded.
 */
const SKILL_COMMAND = /^\/skill:([^ \t\n\r]+)(?: +([\s\S]*))?$/;

/** A skill call as a bubble draws it, expanded or not. */
export interface SkillCall {
  /** Skill name, e.g. `git-commit`. */
  name: string;
  /** Text the user appended after the command, when there was any. */
  userMessage?: string;
  /**
   * The SKILL.md the body was read from. Absent while the message is still the
   * literal command — pi has not expanded it, so there is nothing to point at.
   */
  location?: string;
}

/**
 * Fold either shape of a skill call down to what the chip shows.
 *
 * The expanded block is pi's record; the literal command is what the optimistic
 * turn holds before (and, for the life of the session, instead of) it. Both have
 * to reach the same chip, or a skill sent from the web would lose its glyph and
 * its colour and read as ordinary text.
 */
export function parseSkillCall(text: string): SkillCall | null {
  const block = parseSkillBlock(text);
  if (block !== null) {
    return {
      name: block.name,
      location: block.location,
      ...(block.userMessage === undefined ? {} : { userMessage: block.userMessage }),
    };
  }
  const match = SKILL_COMMAND.exec(text.trim());
  if (match === null) return null;
  const userMessage = match[2]?.trim();
  return {
    name: match[1] as string,
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
