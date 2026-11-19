import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The content font size is the one axis the settings page writes straight onto
 * the document, and *where* it lands is part of matching dsh: the theme
 * bootstrap's body script and the layout's ThemePresenter both write
 * `--dsh-content-font-size` on `body`, and `gradient-shadow-text.css` derives
 * the delta/secondary pair from it inside a `body` block. Writing it on
 * `documentElement` still inherits down to the conversation, so nothing would
 * look broken — it would just stop being the axis dsh publishes.
 *
 * The environment is node (no jsdom in this workspace), so the two style bags
 * are stubbed and the assertion is about which one received the write.
 */
function stubDocument() {
  const body = { setProperty: vi.fn(), removeProperty: vi.fn() };
  const documentElement = { setProperty: vi.fn(), removeProperty: vi.fn() };
  vi.stubGlobal("document", {
    body: { style: body },
    documentElement: { style: documentElement },
  });
  return { body, documentElement };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("applyContentFontSize", () => {
  it("writes the px value on body, where dsh publishes the axis", async () => {
    const { body, documentElement } = stubDocument();
    const { applyContentFontSize } = await import("./theme.ts");

    applyContentFontSize(17);

    expect(body.setProperty).toHaveBeenCalledWith("--dsh-content-font-size", "17px");
    expect(documentElement.setProperty).not.toHaveBeenCalled();
  });

  it("writes plain integer px so the derived calc() stays exact", async () => {
    const { body } = stubDocument();
    const { applyContentFontSize } = await import("./theme.ts");

    applyContentFontSize(10);
    applyContentFontSize(22);

    expect(body.setProperty).toHaveBeenLastCalledWith("--dsh-content-font-size", "22px");
    expect(body.setProperty).toHaveBeenCalledTimes(2);
  });
});
describe("applyFontFamilies", () => {
  it("writes both lists on body, where the token sheet's composite rules read them", async () => {
    const { body } = stubDocument();
    const { applyFontFamilies } = await import("./theme.ts");
    applyFontFamilies({ text: '"Menlo", monospace', code: '"Fira Code"' });
    expect(body.setProperty).toHaveBeenCalledWith("--dsh-font-family-text", '"Menlo", monospace');
    expect(body.setProperty).toHaveBeenCalledWith("--dsh-font-family-code", '"Fira Code"');
  });
  it("drops the pre-paint snapshot from html so a cleared list stops applying", async () => {
    const { body, documentElement } = stubDocument();
    const { applyFontFamilies } = await import("./theme.ts");
    applyFontFamilies({ text: "", code: "" });
    // The snapshot is only for the first paint; the reconciler owns the value
    // from here, so leaving it behind would make "back to default" look ignored.
    expect(documentElement.removeProperty).toHaveBeenCalledWith("--dsh-font-family-text");
    expect(documentElement.removeProperty).toHaveBeenCalledWith("--dsh-font-family-code");
    expect(body.removeProperty).toHaveBeenCalledWith("--dsh-font-family-text");
    expect(body.removeProperty).toHaveBeenCalledWith("--dsh-font-family-code");
    expect(body.setProperty).not.toHaveBeenCalled();
  });
  it("mirrors the lists for the pre-paint script", async () => {
    const { body } = stubDocument();
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
    });
    const { applyFontFamilies } = await import("./theme.ts");
    applyFontFamilies({ text: '"Menlo"', code: "" });
    expect(JSON.parse(saved.get("pi-web-simple:fonts")!)).toEqual({
      text: '"Menlo"',
      code: "",
    });
    expect(body.setProperty).toHaveBeenCalledWith("--dsh-font-family-text", '"Menlo"');
  });
  it("survives a browser with storage disabled", async () => {
    stubDocument();
    vi.stubGlobal("localStorage", undefined);
    const { applyFontFamilies } = await import("./theme.ts");
    expect(() => applyFontFamilies({ text: '"Menlo"', code: "" })).not.toThrow();
  });
});
