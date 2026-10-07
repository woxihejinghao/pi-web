import { describe, expect, it, vi } from "vitest";
import type { ShortcutGesture } from "./binding.ts";
import { dispatchShortcut, LAYER_SELECTOR, type ShortcutCommand } from "./dispatch.ts";
import type { ShortcutEnvironment } from "./environment.ts";

/** A keydown with exactly the modifiers the test names. */
function gesture(code: string, ...held: readonly ("control" | "alt" | "shift" | "meta")[]):
ShortcutGesture {
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

const MAC: ShortcutEnvironment = { runtime: "web", platform: "macos" };

const toggle: ShortcutCommand = {
  id: "test.toggle",
  defaults: {
    desktop: { code: "KeyB", modifiers: ["primary", "alt"] },
    web: { code: "KeyB", modifiers: ["primary", "shift"] },
  },
  run: vi.fn(),
};

const files: ShortcutCommand = {
  id: "test.files",
  defaults: {
    desktop: { code: "KeyP", modifiers: ["primary"] },
    web: { code: "KeyP", modifiers: ["primary", "alt"] },
  },
  run: vi.fn(),
};

const COMMANDS = [toggle, files] as const;

function dispatch(overrides: Partial<Parameters<typeof dispatchShortcut>[0]> = {}) {
  return dispatchShortcut({
    commands: COMMANDS,
    environment: MAC,
    gesture: gesture("KeyB", "meta", "shift"),
    layerOpen: false,
    ...overrides,
  });
}

describe("dispatchShortcut", () => {
  it("hands back the command whose binding the gesture is", () => {
    const result = dispatch();
    expect(result).toEqual({ status: "handled", command: toggle, repeat: false });
  });

  it("carries the held-down flag through instead of deciding for the caller", () => {
    expect(dispatch({ gesture: { ...gesture("KeyB", "meta", "shift"), repeat: true } })).toEqual({
      status: "handled",
      command: toggle,
      repeat: true,
    });
  });

  it("reads the column belonging to the shell it is running in", () => {
    // `⌘⇧B` is the web default; the same command is `⌘⌥B` wrapped.
    const wrapped = dispatch({
      environment: { runtime: "desktop", platform: "macos" },
      gesture: gesture("KeyB", "meta", "alt"),
    });
    expect(wrapped).toMatchObject({ status: "handled", command: toggle });
    // …and the web combination is not also live there.
    expect(dispatch({ environment: { runtime: "desktop", platform: "macos" } }).status).toBe("pass");
  });

  it("passes on a key it does not bind", () => {
    expect(dispatch({ gesture: gesture("KeyB", "meta") }).status).toBe("pass");
    expect(dispatch({ gesture: gesture("KeyQ", "meta", "shift") }).status).toBe("pass");
  });

  it("passes on a keydown something closer to the document already handled", () => {
    expect(dispatch({ gesture: { ...gesture("KeyB", "meta", "shift"), defaultPrevented: true } }).status)
      .toBe("pass");
  });

  it("passes while an input method owns the keystroke", () => {
    // The AltGraph case is the one that matters: on a layout where AltGr types
    // a character, `Ctrl+Alt+P` is a character and not this app's file tree.
    expect(dispatch({ gesture: { ...gesture("KeyB", "meta", "shift"), composing: true } }).status)
      .toBe("pass");
  });

  it("claims but refuses a key a modal or an open menu owns", () => {
    // `blocked` rather than `pass`, so the caller still cancels whatever the
    // browser would have done with the key.
    expect(dispatch({ layerOpen: true })).toEqual({ status: "blocked", command: toggle });
  });

  it("keeps the layer selector to the clauses that mean a layer is up", () => {
    // Both halves are load-bearing. `aria-modal` keeps the inline question card
    // and the usage popovers — also `role="dialog"` — from killing every
    // shortcut for as long as they are on screen; `role="menu"` catches this
    // app's popup menus, all of which are mounted only while open.
    expect(LAYER_SELECTOR).toBe('[role="dialog"][aria-modal="true"], [role="menu"]');
  });
});
