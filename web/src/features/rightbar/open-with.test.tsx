import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { translator } from "../../lib/i18n/index.ts";
import type { NativeApplication } from "../../lib/types.ts";
import {
  openButtonLabel,
  openMenuRows,
  placeMenuEnd,
  rowTarget,
  systemApplication,
} from "./open-with.ts";
import { OpenWithMenuItems } from "./OpenWithButton.tsx";

// These assertions pin the Chinese wording, so the translator is passed in
// rather than resolved through the component.
const zh = translator("zh-CN");

vi.stubGlobal("navigator", { language: "zh-CN" });

function app(
  name: string,
  options: { default?: boolean; icon?: string | null } = {},
): NativeApplication {
  return {
    id: `/Applications/${name}.app`,
    name,
    default: options.default ?? false,
    icon: options.icon ?? null,
  };
}

/**
 * The preview's open control.
 *
 * The portalled shell around the menu is not covered here: React's *server*
 * renderer refuses portals outright, and this repo's test environment has no
 * DOM. What is covered is the part with a decision in it — which application the
 * main button claims to open, what the menu lists and in what order, what each
 * row asks the host to do, and where the menu lands — all of which are pure.
 */
describe("systemApplication", () => {
  it("is the one the host marked, not the first one back", () => {
    // The host answers in the reader's own Finder order, which is not a ranking:
    // taking the first entry would open a file with whatever sorts first.
    const applications = [app("Zed"), app("Cursor", { default: true }), app("VS Code")];
    expect(systemApplication(applications)?.name).toBe("Cursor");
  });

  it("is nobody when nothing claimed the file", () => {
    expect(systemApplication([app("Zed"), app("VS Code")])).toBeUndefined();
  });
});

describe("openButtonLabel", () => {
  it("names the application the press will use", () => {
    expect(openButtonLabel([app("Cursor", { default: true })], zh)).toBe("用 Cursor 打开");
  });

  it("still describes the gesture when the host names no application", () => {
    // Windows and Linux hosts do not enumerate; the button is not wrong to
    // exist, it just cannot say which program is coming.
    expect(openButtonLabel([], zh)).toBe("用默认应用打开");
    expect(openButtonLabel([app("Zed")], zh)).toBe("用默认应用打开");
  });
});

describe("openMenuRows", () => {
  it("lists the host's order and marks the system's own choice", () => {
    const rows = openMenuRows(
      [app("Zed"), app("Cursor", { default: true })],
      { failed: false },
      zh,
    );
    expect(rows.map((row) => row.id)).toEqual([
      "app:/Applications/Zed.app",
      "app:/Applications/Cursor.app",
      "reveal",
    ]);
    expect(rows.map((row) => row.label)).toEqual(["Zed", "Cursor（默认）", "显示文件位置"]);
  });

  it("keeps the file location last, behind a rule, whatever else is there", () => {
    const rows = openMenuRows([], { failed: false }, zh);
    expect(rows.map((row) => row.id)).toEqual(["reveal"]);
    expect(rows[0]?.divider).toBe(true);
    expect(rows[0]?.disabled).toBe(false);
  });

  it("says so in the menu when the host could not answer", () => {
    // Removing the control instead would take the file manager away with the
    // application list, and showing an empty list would read as "nothing can
    // open this" — which is not what a failed query means.
    const rows = openMenuRows([], { failed: true }, zh);
    expect(rows.map((row) => row.id)).toEqual(["unavailable", "reveal"]);
    expect(rows[0]?.label).toBe("无法获取应用列表");
    expect(rows[0]?.disabled).toBe(true);
  });
});

describe("rowTarget", () => {
  it("asks for the application the row names", () => {
    expect(rowTarget("app:/Applications/Zed.app")).toEqual({
      kind: "open",
      application: "/Applications/Zed.app",
    });
  });

  it("asks for the file manager from the pinned row", () => {
    expect(rowTarget("reveal")).toEqual({ kind: "reveal" });
  });

  it("asks for nothing from the row that only explains itself", () => {
    expect(rowTarget("unavailable")).toBeNull();
  });
});

describe("placeMenuEnd", () => {
  const menu = { offsetWidth: 200, offsetHeight: 120 };
  const viewport = { width: 800, height: 600 };

  it("hangs under the trigger, right-aligned to it", () => {
    // The trigger is the last thing in the header, so a menu growing rightwards
    // from its left edge would leave the window.
    expect(placeMenuEnd({ right: 780, top: 30, bottom: 54 }, menu, viewport)).toEqual({
      left: 580,
      top: 56,
    });
  });

  it("opens upwards when there is no room below", () => {
    expect(placeMenuEnd({ right: 780, top: 560, bottom: 584 }, menu, viewport)).toEqual({
      left: 580,
      top: 438,
    });
  });

  it("stops at the window's edges rather than sliding off them", () => {
    expect(placeMenuEnd({ right: 120, top: 30, bottom: 54 }, menu, viewport).left).toBe(2);
  });
});

describe("OpenWithMenuItems", () => {
  it("renders the applications, the rule, and the file location", () => {
    const rows = openMenuRows([app("Cursor", { default: true })], { failed: false }, zh);
    const html = renderToStaticMarkup(<OpenWithMenuItems rows={rows} onPick={() => {}} />);
    expect(html).toContain("Cursor（默认）");
    expect(html).toContain("显示文件位置");
    expect(html).toContain('role="separator"');
    expect(html).toContain('data-open-with-row="app:/Applications/Cursor.app"');
  });

  it("disables the row that only explains a failed query", () => {
    const rows = openMenuRows([], { failed: true }, zh);
    const html = renderToStaticMarkup(<OpenWithMenuItems rows={rows} onPick={() => {}} />);
    expect(html).toContain("无法获取应用列表");
    expect(html).toMatch(/disabled=""[^>]*data-open-with-row="unavailable"/);
  });
});
