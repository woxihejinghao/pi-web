import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore, resetAppState } from "../../lib/app-state.ts";
import {
  bindingKey,
  keycapsText,
  normalizeBinding,
  type ShortcutPlatform,
  type ShortcutRuntime,
} from "../../lib/shortcuts/binding.ts";
import { translator } from "../../lib/i18n/index.ts";
import { resetRightbarState, rightbarActions, rightbarStore } from "./rightbar-state.ts";
import { rightbarCommands, shortcutHint, shortcutTitle, type RightbarCommandId } from "./shortcuts.ts";

const KEY = "session-a";
const zh = translator("zh-CN");

const RUNTIMES: readonly ShortcutRuntime[] = ["desktop", "web"];
const PLATFORMS: readonly ShortcutPlatform[] = ["macos", "windows", "linux"];

/** Select one session, or leave the hero showing. */
function selectSession(path: string | null): void {
  appStore.update((state) => ({
    ...state,
    projects: [
      { id: "p1", path: "/tmp/demo", title: "demo", order: 0, createdAt: "", updatedAt: "", exists: true },
    ],
    selectedProjectId: "p1",
    selectedSessionPath: path,
  }));
}

function command(id: RightbarCommandId): { run: () => void } {
  const found = rightbarCommands.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no command ${id}`);
  return found;
}

function surface(key = KEY) {
  const value = rightbarStore.get().surfaces[key];
  if (value === undefined) throw new Error(`no surface for ${key}`);
  return value;
}

beforeEach(() => {
  resetAppState();
  resetRightbarState();
});

afterEach(() => {
  resetAppState();
  resetRightbarState();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the command table", () => {
  it("gives every command a distinct id", () => {
    const ids = rightbarCommands.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never binds two commands to the same keys in the same shell and platform", () => {
    // dsh throws at registration for exactly this. Nothing here registers at
    // runtime — the table is a constant — so the check has to be a test, and it
    // is the one failure a reader of the table cannot see by looking at it.
    for (const runtime of RUNTIMES) {
      for (const platform of PLATFORMS) {
        const keys = rightbarCommands.map((entry) =>
          bindingKey(normalizeBinding(entry.defaults[runtime], platform)),
        );
        expect(new Set(keys).size, `${runtime}:${platform}`).toBe(keys.length);
      }
    }
  });

  it("spells every key it binds, in every combination it is drawn in", () => {
    for (const entry of rightbarCommands) {
      for (const runtime of RUNTIMES) {
        for (const platform of PLATFORMS) {
          const text = keycapsText(normalizeBinding(entry.defaults[runtime], platform), platform);
          // A keycap nobody spelled falls back to the raw `code`, so a missing
          // entry in `KEY_NAMES` shows up here as `Backquote` or `KeyP` rather
          // than as a tooltip somebody has to notice.
          expect(text, `${entry.id} ${runtime}:${platform}`).not.toMatch(/Key|Digit/);
          expect(text.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("running a command", () => {
  it("does nothing at all while the hero is showing", () => {
    selectSession(null);
    for (const entry of rightbarCommands) entry.run();
    // Not even a surface: every command is addressed by the session it belongs
    // to, and there is none.
    expect(rightbarStore.get().surfaces).toEqual({});
  });

  it("shows the panel and puts it away again", () => {
    selectSession(KEY);
    command("rightbar.toggle").run();
    expect(surface().open).toBe(true);
    // Opening an empty surface seeds it, so the panel never shows nothing.
    expect(surface().tabs).toHaveLength(1);
    command("rightbar.toggle").run();
    expect(surface().open).toBe(false);
  });

  it("brings the file tree up, once however often it is asked", () => {
    selectSession(KEY);
    command("rightbar.files").run();
    command("rightbar.files").run();
    // Files is a single-instance tab: a second one would show the same tree.
    expect(surface().tabs.map((tab) => tab.kind)).toEqual(["files"]);
    expect(surface().open).toBe(true);
  });

  it("opens one more shell every time it is asked", () => {
    selectSession(KEY);
    command("rightbar.terminal").run();
    command("rightbar.terminal").run();
    // Two terminals are two processes, so unlike Files this never reuses a tab.
    expect(surface().tabs.map((tab) => tab.kind)).toEqual(["terminal", "terminal"]);
    // The host id is the body's business; the shortcut only makes the tab.
    expect(surface().tabs.map((tab) => tab.target)).toEqual(["", ""]);
  });

  it("opens a browser tab on nothing, which is the address bar's empty state", () => {
    selectSession(KEY);
    command("rightbar.browser").run();
    expect(surface().tabs.map((tab) => tab.kind)).toEqual(["browser"]);
    expect(surface().tabs[0]?.target).toBe("");
  });

  it("gives the window to the panel only while the panel is showing", () => {
    selectSession(KEY);
    // Present but put away. The key says "fullscreen this", not "open this" —
    // so it does nothing rather than opening the panel in a mode.
    rightbarActions.ensureSurface(KEY);
    command("rightbar.fullscreen").run();
    expect(surface().mode).toBe("push");
    expect(surface().open).toBe(false);

    rightbarActions.open(KEY);
    command("rightbar.fullscreen").run();
    expect(surface().mode).toBe("fullscreen");
    command("rightbar.fullscreen").run();
    expect(surface().mode).toBe("push");
  });
});

describe("the keycap hint", () => {
  /**
   * `environment()` caches for the life of the module, so a test that wants a
   * different device has to import the module again — and stub the globals it
   * reads *before* the import, since the first hint drawn is what locks it in.
   */
  async function hintOn(
    signals: { desktop?: string; userAgent: string },
    id: RightbarCommandId,
  ): Promise<string> {
    vi.resetModules();
    vi.stubGlobal(
      "window",
      signals.desktop === undefined
        ? undefined
        : { piWebDesktop: { isDesktop: true, platform: signals.desktop, electronVersion: "0" } },
    );
    vi.stubGlobal("navigator", { userAgent: signals.userAgent });
    const module = await import("./shortcuts.ts");
    return module.shortcutHint(id);
  }

  const MAC_BROWSER = {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
  };

  it("advertises the browser's column with the browser's symbols", async () => {
    expect(await hintOn(MAC_BROWSER, "rightbar.toggle")).toBe("⇧⌘B");
    expect(await hintOn(MAC_BROWSER, "rightbar.files")).toBe("⌥⌘P");
    // Not built on `primary`: this is the one binding every terminal-bearing
    // editor agrees on, Control on a Mac included.
    expect(await hintOn(MAC_BROWSER, "rightbar.terminal")).toBe("⌃`");
  });

  it("advertises the desktop's column and the desktop's machine", async () => {
    expect(await hintOn({ ...MAC_BROWSER, desktop: "darwin" }, "rightbar.toggle")).toBe("⌥⌘B");
    expect(await hintOn({ ...MAC_BROWSER, desktop: "darwin" }, "rightbar.files")).toBe("⌘P");
    expect(await hintOn({ ...MAC_BROWSER, desktop: "darwin" }, "rightbar.fullscreen")).toBe("⌥⌘Enter");
  });

  it("names Control, Alt and Shift where they are not symbols", async () => {
    expect(
      await hintOn(
        { desktop: "win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0" },
        "rightbar.toggle",
      ),
    ).toBe("Ctrl+Alt+B");
  });
});

describe("the tooltip", () => {
  it("prints the control's own words and the keys that also reach it", () => {
    expect(shortcutTitle(zh, "收起右栏", "rightbar.toggle")).toMatch(/^收起右栏（.+）$/u);
  });
});
