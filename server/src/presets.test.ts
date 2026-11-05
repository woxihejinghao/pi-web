import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRESET_ID,
  MINIMAL_SYSTEM_PROMPT,
  findPreset,
  listPresets,
  presetIdFromSystemMessage,
  presetSpawnArgs,
} from "./presets.ts";

describe("preset roster", () => {
  it("offers the default composition first", () => {
    expect(listPresets().map((preset) => preset.id)).toEqual([DEFAULT_PRESET_ID, "minimal"]);
  });

  it("answers null for an unknown id", () => {
    expect(findPreset("nope")).toBeNull();
    expect(findPreset("minimal")?.id).toBe("minimal");
  });
});

describe("presetSpawnArgs", () => {
  it("hands the default preset the tools the manifest leaves out", () => {
    // All three are web-only by construction: the package manifest lists only
    // `/web`, so no terminal session registers them, and the RPC process this
    // deployment spawns is handed them explicitly instead.
    const args = presetSpawnArgs(DEFAULT_PRESET_ID);
    expect(args).toEqual([
      "--extension",
      expect.stringMatching(/approval-gate\.ts$/),
      "--extension",
      expect.stringMatching(/extensions[/\\]ask-user\.ts$/),
      "--extension",
      expect.stringMatching(/extensions[/\\]todo\.ts$/),
      "--extension",
      expect.stringMatching(/extensions[/\\]plan-mode\.ts$/),
    ]);
  });

  it("retains the gate when a globally installed todo replaces the bundled one", () => {
    const previous = process.env.PI_WEB_SIMPLE_EXTERNAL_TODO;
    process.env.PI_WEB_SIMPLE_EXTERNAL_TODO = "1";
    try {
      const args = presetSpawnArgs("standard");
      expect(args.some(arg => arg.endsWith("/todo.ts"))).toBe(false);
      expect(args.some(arg => arg.endsWith("/approval-gate.ts"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PI_WEB_SIMPLE_EXTERNAL_TODO;
      else process.env.PI_WEB_SIMPLE_EXTERNAL_TODO = previous;
    }
  });

  it("falls back to the default when no usable id was given", () => {
    expect(presetSpawnArgs("nope")).toEqual(presetSpawnArgs(DEFAULT_PRESET_ID));
    expect(presetSpawnArgs(undefined)).toEqual(presetSpawnArgs(DEFAULT_PRESET_ID));
  });

  it("composes minimal out of pi's own flags", () => {
    const args = presetSpawnArgs("minimal");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(MINIMAL_SYSTEM_PROMPT);
    expect(args[args.indexOf("--tools") + 1]).toBe("bash");
    expect(args).toContain("--no-context-files");
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-mcp");
    expect(args).toContain("--no-prompt-templates");
    expect(args).toContain("--no-extensions");
  });

  it("restores the approval gate even when minimal disables discovery", () => {
    // `--no-extensions` drops the manifest's one entry, `/web`, and nothing
    // else: the tools this deployment adds are not in the manifest, and the
    // minimal roster keeps none of them — so `/web` is the one extension
    // restored.
    const args = presetSpawnArgs("minimal");
    const restored = args.slice(args.indexOf("--extension") + 1);
    expect(restored).toHaveLength(3);
    expect(restored[0]).toMatch(/approval-gate\.ts$/);
    expect(restored[2]).toMatch(/extensions[/\\]index\.js$/);
  });
});

describe("presetIdFromSystemMessage", () => {
  it("recognizes the minimal prompt, wherever pi put it", () => {
    expect(presetIdFromSystemMessage({ content: MINIMAL_SYSTEM_PROMPT })).toBe("minimal");
    expect(presetIdFromSystemMessage({ sections: { preamble: MINIMAL_SYSTEM_PROMPT } })).toBe(
      "minimal",
    );
  });

  it("still recognizes it beside the runtime sections pi appends", () => {
    // The shape observed with the flags this preset passes: `--system-prompt`
    // replaces the persona section, but pi attaches its own `<cwd>` section next
    // to it. Comparing the concatenation would miss the persona entirely, which
    // is why the match is per part.
    expect(
      presetIdFromSystemMessage({
        content: "",
        sections: {
          preamble: MINIMAL_SYSTEM_PROMPT,
          cwd: "<cwd>\n/private/tmp/project\n</cwd>",
        },
      }),
    ).toBe("minimal");
  });

  it("recognizes a lone bash tool when no prompt sections were recorded", () => {
    expect(presetIdFromSystemMessage({ content: "", toolsAdded: [{ name: "bash" }] })).toBe(
      "minimal",
    );
  });

  it("leaves the default composition alone", () => {
    expect(presetIdFromSystemMessage({ content: "You are a coding assistant." })).toBe(
      DEFAULT_PRESET_ID,
    );
    expect(
      presetIdFromSystemMessage({
        content: "",
        toolsAdded: [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }],
      }),
    ).toBe(DEFAULT_PRESET_ID);
  });

  it("does not read a larger tool set as minimal", () => {
    expect(
      presetIdFromSystemMessage({ content: "", toolsAdded: [{ name: "bash" }, { name: "read" }] }),
    ).toBe(DEFAULT_PRESET_ID);
  });
});
