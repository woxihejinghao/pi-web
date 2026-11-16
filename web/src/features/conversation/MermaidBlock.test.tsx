import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.tsx";

/**
 * The fence → block decision, asserted through the real renderer.
 *
 * There is no DOM here (static markup, no effects), which is exactly the state a
 * transcript is in before it settles: a diagram block must render its *source*
 * and must not ask the engine for anything until it is on screen and settled.
 * The drawing itself is checked against a browser, not here.
 */
function render(text: string, streaming?: boolean): string {
  return renderToStaticMarkup(
    <Markdown text={text} {...(streaming === undefined ? {} : { streaming })} />,
  );
}

describe("mermaid fences", () => {
  it("become a diagram block, showing the source until it is settled", () => {
    const html = render("```mermaid\nflowchart LR\n  A --> B\n```");
    expect(html).toContain('data-diagram-view="source"');
    expect(html).toContain("flowchart LR");
    // Nothing is drawn during server rendering: no engine, no svg.
    expect(html).not.toContain("<svg");
  });

  it("accepts the `mmd` spelling of the same fence", () => {
    expect(render("```mmd\nflowchart LR\n  A --> B\n```")).toContain('data-diagram-view="source"');
  });

  it("waits out the stream rather than drawing a half-written diagram", () => {
    const html = render("```mermaid\nflowchart LR\n  A -->", true);
    expect(html).toContain('data-diagram-view="source"');
    expect(html).toContain("flowchart LR");
  });

  it("leaves every other language on the code fence", () => {
    const html = render("```js\nconst a = 1;\n```");
    expect(html).not.toContain("data-diagram-view");
    expect(html).toContain("const a = 1;");
  });

  it("keeps an unlabelled block as code, even when it starts like a diagram", () => {
    const html = render("```\nflowchart LR\n  A --> B\n```");
    expect(html).not.toContain("data-diagram-view");
  });
});
