import { describe, expect, it } from "vitest";
import {
  bindingKey,
  keycapsText,
  matchesBinding,
  normalizeBinding,
  primaryModifier,
  type PhysicalModifier,
  type ShortcutGesture,
} from "./binding.ts";

/** A keydown with exactly the modifiers the test names, and nothing else set. */
function gesture(code: string, ...held: readonly PhysicalModifier[]): ShortcutGesture {
  return {
    code,
    control: held.includes("control"),
    alt: held.includes("alt"),
    shift: held.includes("shift"),
    meta: held.includes("meta"),
    repeat: false,
    composing: false,
    defaultPrevented: false,
  };
}

describe("normalizeBinding", () => {
  it("resolves primary to Command on macOS and Control elsewhere", () => {
    expect(primaryModifier("macos")).toBe("meta");
    expect(primaryModifier("windows")).toBe("control");
    expect(primaryModifier("linux")).toBe("control");
    const binding = { code: "KeyB", modifiers: ["primary"] } as const;
    expect(normalizeBinding(binding, "macos").modifiers).toEqual(["meta"]);
    expect(normalizeBinding(binding, "windows").modifiers).toEqual(["control"]);
  });

  it("writes the modifiers in canonical order, whatever order they were declared", () => {
    const normalized = normalizeBinding(
      { code: "KeyB", modifiers: ["shift", "primary"] },
      "macos",
    );
    // Control, alt, shift, meta — the order the keycaps are drawn in, so the
    // declared order must not leak through to the tooltip.
    expect(normalized.modifiers).toEqual(["shift", "meta"]);
    expect(bindingKey(normalized)).toBe("shift+meta+KeyB");
  });

  it("drops a modifier named twice", () => {
    // `primary` is meta on macOS, so this is meta twice over.
    expect(normalizeBinding({ code: "KeyB", modifiers: ["primary", "meta"] }, "macos").modifiers)
      .toEqual(["meta"]);
  });
});

describe("matchesBinding", () => {
  const binding = normalizeBinding({ code: "KeyB", modifiers: ["primary", "alt"] }, "macos");

  it("accepts the exact combination", () => {
    expect(matchesBinding(binding, gesture("KeyB", "meta", "alt"))).toBe(true);
  });

  it("refuses a missing modifier", () => {
    expect(matchesBinding(binding, gesture("KeyB", "meta"))).toBe(false);
  });

  it("refuses an extra modifier", () => {
    // `⌃⌘⌥B` is a different key from `⌘⌥B`. Matching loosely would make every
    // unclaimed combination a shortcut, and leave no room to extend the table.
    expect(matchesBinding(binding, gesture("KeyB", "control", "meta", "alt"))).toBe(false);
  });

  it("refuses the right modifiers on the wrong physical key", () => {
    // The physical key is what is compared, so a layout that puts "b"
    // elsewhere does not move the shortcut with it.
    expect(matchesBinding(binding, gesture("KeyN", "meta", "alt"))).toBe(false);
  });
});

describe("keycapsText", () => {
  it("draws the symbols run together on macOS, in the order macOS prints them", () => {
    const binding = normalizeBinding({ code: "KeyB", modifiers: ["primary", "shift"] }, "macos");
    // Shift before Command: that is how a Mac menu writes ⇧⌘B, and `⌘⇧B` would
    // read as a typo to the only people who see this string.
    expect(keycapsText(binding, "macos")).toBe("⇧⌘B");
  });

  it("draws named modifiers joined by plus elsewhere", () => {
    const binding = normalizeBinding({ code: "KeyB", modifiers: ["primary", "shift"] }, "windows");
    expect(keycapsText(binding, "windows")).toBe("Ctrl+Shift+B");
    expect(keycapsText(binding, "linux")).toBe("Ctrl+Shift+B");
  });

  it("spells the keys that have no letter of their own", () => {
    const enter = normalizeBinding({ code: "Enter", modifiers: ["primary", "alt"] }, "macos");
    expect(keycapsText(enter, "macos")).toBe("⌥⌘Enter");
    const backquote = normalizeBinding({ code: "Backquote", modifiers: ["control"] }, "macos");
    expect(keycapsText(backquote, "macos")).toBe("⌃`");
    expect(keycapsText(backquote, "linux")).toBe("Ctrl+`");
  });

  it("draws nothing for an unbound command", () => {
    expect(keycapsText(null, "macos")).toBe("");
  });
});
