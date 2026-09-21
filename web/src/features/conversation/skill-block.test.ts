import { describe, expect, it } from "vitest";
import { displayUserText, parseSkillBlock, skillCommandLabel } from "./skill-block.ts";

/** Exactly the shape pi writes: `_expandSkillCommand` in `dist/core/agent-session.js`. */
function block(name: string, body: string, args?: string): string {
  const head = `<skill name="${name}" location="/Users/milan/.agents/skills/${name}/SKILL.md">`;
  const whole = `${head}\nReferences are relative to /Users/milan/.agents/skills/${name}.\n\n${body}\n</skill>`;
  return args === undefined ? whole : `${whole}\n\n${args}`;
}

describe("parseSkillBlock", () => {
  it("parses the name, location and body", () => {
    const parsed = parseSkillBlock(block("git-commit", "# Git Commit\n\nDo the thing."));
    expect(parsed).toEqual({
      name: "git-commit",
      location: "/Users/milan/.agents/skills/git-commit/SKILL.md",
      content: "References are relative to /Users/milan/.agents/skills/git-commit.\n\n# Git Commit\n\nDo the thing.",
    });
  });

  it("keeps the text the user wrote after the command", () => {
    const parsed = parseSkillBlock(block("git-commit", "# Git Commit", "fix the typo"));
    expect(parsed?.userMessage).toBe("fix the typo");
  });

  it("treats an empty trailing argument as no message", () => {
    const parsed = parseSkillBlock(block("git-commit", "# Git Commit", "\n"));
    expect(parsed?.userMessage).toBeUndefined();
  });

  it("returns null for ordinary text", () => {
    expect(parseSkillBlock("hello")).toBeNull();
    expect(parseSkillBlock("please run <skill name=\"x\" location=\"/y\">")).toBeNull();
  });

  it("returns null when the closing tag is missing", () => {
    expect(parseSkillBlock('<skill name="x" location="/y">\nbody')).toBeNull();
  });

  it("returns null when the block is not the whole message", () => {
    expect(parseSkillBlock(`look at this:\n\n${block("git-commit", "body")}`)).toBeNull();
  });
});

describe("displayUserText", () => {
  it("folds a skill block down to the command", () => {
    expect(displayUserText(block("git-commit", "# Git Commit\n\nLots of instructions."))).toBe(
      "/skill:git-commit",
    );
  });

  it("keeps the arguments on the same line", () => {
    expect(displayUserText(block("git-commit", "# Git Commit", "fix the typo"))).toBe(
      "/skill:git-commit fix the typo",
    );
  });

  it("passes ordinary text through unchanged", () => {
    expect(displayUserText("hello\nthere")).toBe("hello\nthere");
  });
});

describe("skillCommandLabel", () => {
  it("uses the prefix pi expands", () => {
    expect(skillCommandLabel("pdf-tools")).toBe("/skill:pdf-tools");
  });
});
