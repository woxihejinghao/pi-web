import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeDiagramError, diagramSource } from "./mermaid.ts";

/**
 * The engine is mocked: this file is about what `renderDiagram` *asks* mermaid
 * for (config once per theme, one render per call, errors flattened), not about
 * mermaid's own parsing. The real engine is exercised by the interaction check
 * against the dev server, which no unit test in this repository can stand in
 * for — rendering needs layout.
 */
const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaid }));

/** `renderDiagram` keeps module-level state (engine promise, applied theme). */
async function freshModule(): Promise<typeof import("./mermaid.ts")> {
  vi.resetModules();
  return import("./mermaid.ts");
}

beforeEach(() => {
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
  mermaid.render.mockResolvedValue({ svg: "<svg id=\"ok\"></svg>", bindFunctions: undefined });
});

describe("diagramSource", () => {
  it("normalizes CRLF and drops the blank lines a fence carries", () => {
    expect(diagramSource("\n\nflowchart LR\r\n  A --> B\n\n")).toBe("flowchart LR\n  A --> B");
  });

  it("keeps the indentation inside the diagram", () => {
    expect(diagramSource("sequenceDiagram\n  A->>B: hi")).toContain("\n  A->>B: hi");
  });
});

describe("describeDiagramError", () => {
  it("keeps the first non-empty line and drops the parser's caret art", () => {
    const message = "Parse error on line 2:\n... A --\n-------^\nExpecting 'SEMI'";
    expect(describeDiagramError(new Error(message))).toBe("Parse error on line 2:");
  });

  it("strips the redundant Error prefix", () => {
    expect(describeDiagramError(new Error("Error: No diagram type detected"))).toBe(
      "No diagram type detected",
    );
  });

  it("bounds a long line", () => {
    const described = describeDiagramError(new Error("x".repeat(400)));
    expect(described).toHaveLength(158);
    expect(described.endsWith("…")).toBe(true);
  });

  it("says nothing when the engine throws nothing", () => {
    expect(describeDiagramError(undefined)).toBe("");
    expect(describeDiagramError({})).toBe("");
  });
});

describe("renderDiagram", () => {
  it("initializes once for a theme and reuses it", async () => {
    const { renderDiagram } = await freshModule();
    await renderDiagram("flowchart LR\n A-->B", "light");
    await renderDiagram("flowchart LR\n B-->C", "light");

    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: "strict", theme: "default" }),
    );
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it("re-initializes when the appearance changes", async () => {
    const { renderDiagram } = await freshModule();
    await renderDiagram("flowchart LR\n A-->B", "light");
    await renderDiagram("flowchart LR\n A-->B", "dark");

    expect(mermaid.initialize).toHaveBeenCalledTimes(2);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "dark", securityLevel: "strict" }),
    );
  });

  it("leaves mermaid's own palette alone", async () => {
    const { renderDiagram } = await freshModule();
    await renderDiagram("flowchart LR\n A-->B", "dark");

    const config = mermaid.initialize.mock.calls[0]?.[0] as {
      look?: string;
      themeVariables: Record<string, string>;
    };
    // No `look` override (mermaid 12's `neo` stands) and no colour overrides —
    // only type is ours.
    expect(config.look).toBeUndefined();
    expect(Object.keys(config.themeVariables).sort()).toEqual(["fontFamily", "fontSize"]);
  });

  it("takes the font from the design token and applies it to both places", async () => {
    const { renderDiagram } = await freshModule();
    await renderDiagram("flowchart LR\n A-->B", "light");

    const config = mermaid.initialize.mock.calls[0]?.[0] as {
      fontFamily?: string;
      themeVariables?: Record<string, string>;
    };
    expect(config.fontFamily).toBeTruthy();
    expect(config.themeVariables?.fontFamily).toBe(config.fontFamily);
    expect(config.themeVariables?.fontSize).toBe("13px");
  });

  it("gives every render its own id, so two diagrams cannot share marker ids", async () => {
    const { renderDiagram } = await freshModule();
    await renderDiagram("flowchart LR\n A-->B", "light");
    await renderDiagram("flowchart LR\n A-->B", "light");

    const ids = mermaid.render.mock.calls.map((call: unknown[]) => call[0]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("hands back the engine's svg", async () => {
    const { renderDiagram } = await freshModule();
    await expect(renderDiagram("flowchart LR\n A-->B", "light")).resolves.toEqual({
      ok: true,
      svg: '<svg id="ok"></svg>',
    });
  });

  it("turns a parse failure into a readable message instead of throwing", async () => {
    const { renderDiagram } = await freshModule();
    mermaid.render.mockRejectedValueOnce(new Error("Parse error on line 1:\n---^\nbad"));

    await expect(renderDiagram("flowchart LR\n A--", "light")).resolves.toEqual({
      ok: false,
      message: "Parse error on line 1:",
    });
  });

  it("does not render an empty fence, and never loads the engine for it", async () => {
    const { renderDiagram } = await freshModule();
    await expect(renderDiagram("   \n\n", "light")).resolves.toEqual({ ok: false, message: "" });
    expect(mermaid.initialize).not.toHaveBeenCalled();
    expect(mermaid.render).not.toHaveBeenCalled();
  });
});
