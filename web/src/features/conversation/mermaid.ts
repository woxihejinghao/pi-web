import type { Mermaid, MermaidConfig } from "mermaid";

/**
 * Mermaid rendering, kept out of the component so the 1–2 MB diagram engine only
 * ever enters through a dynamic `import()` — a transcript with no diagram in it
 * downloads none of it, and one with a diagram downloads it when the block is
 * scrolled to (see `useOnScreen`).
 *
 * Three of mermaid's globals matter here:
 *
 * 1. `initialize()` writes module-level config, so the appearance is state this
 *    module keeps rather than something each call passes through. Switching
 *    light/dark re-initializes once, and every already-rendered SVG is a string
 *    in React state, so nothing is invalidated by the switch.
 * 2. `render()` is documented as "multiple calls will be enqueued to run
 *    serially" — no queue of our own is needed, and adding one would only make
 *    the ordering harder to reason about.
 * 3. Rendering happens into a hidden container mermaid appends to `<body>`.
 *    `suppressErrorRendering` keeps a parse error from being drawn as a diagram,
 *    and the `finally` below deletes the container mermaid leaves behind when it
 *    throws instead of always cleaning up.
 */

export type DiagramTheme = "light" | "dark";

export type DiagramResult =
  | { ok: true; svg: string }
  | { ok: false; message: string };

/** The diagram's text as a reader would paste it: no leading/trailing blank lines. */
export function diagramSource(code: string): string {
  return code.replace(/\r\n/g, "\n").replace(/^\n+|\s+$/g, "");
}

/**
 * Mermaid's parser reports with the offending source line and a caret in the
 * message, sometimes several kilobytes of it. The block already shows the whole
 * source next to the failure, so the message only has to say *what* broke:
 * first line, collapsed, bounded.
 */
export function describeDiagramError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const firstLine = raw.split("\n").map((line) => line.trim()).find((line) => line !== "");
  if (firstLine === undefined) return "";
  const cleaned = firstLine.replace(/\s+/g, " ").replace(/^Error:\s*/i, "");
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}…` : cleaned;
}

let loading: Promise<Mermaid> | null = null;
let appliedTheme: DiagramTheme | null = null;
let sequence = 0;

/** Fallbacks for environments without a document (tests, SSR). */
const FALLBACK_FONT =
  'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/**
 * A design token as a concrete value, because mermaid needs one.
 *
 * Mermaid computes with the values it is handed — `lighten`, `darken`, `adjust`
 * — so a `var(--…)` reference is rejected outright ("Unsupported color
 * format"), which is why the resolved value is the only thing it can take. The
 * aliases live on `body` rather than `html` (see `lib/theme.ts`), so that is
 * where they have to be read.
 */
function tokenValue(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

function configure(theme: DiagramTheme): MermaidConfig {
  const fontFamily = tokenValue("--dsw-font-family", FALLBACK_FONT);
  return {
    // mermaid scans the document for `.mermaid` elements on load; the only
    // diagrams here are the ones this module renders.
    startOnLoad: false,
    // `strict` escapes labels and neutralizes click handlers, which is the
    // honest setting for text that came out of a model.
    securityLevel: "strict",
    suppressErrorRendering: true,
    // The palette is mermaid 12's own `default`/`dark` theme, untouched: the
    // diagram is the engine's drawing, not a surface this app should restyle.
    // Only the type is ours — the transcript's font and a size that sits with a
    // code fence instead of heading above it (mermaid's default is 16px).
    theme: theme === "dark" ? "dark" : "default",
    themeVariables: { fontFamily, fontSize: "13px" },
    fontFamily,
  };
}

async function engine(theme: DiagramTheme): Promise<Mermaid> {
  if (loading === null) {
    const pending = import("mermaid").then((module) => module.default);
    loading = pending;
    // A failed chunk fetch (offline, a stale deploy) must not poison the module
    // for the rest of the session: the next on-screen diagram retries.
    void pending.catch(() => {
      if (loading === pending) loading = null;
    });
  }
  const mermaid = await loading;
  if (appliedTheme !== theme) {
    mermaid.initialize(configure(theme));
    appliedTheme = theme;
  }
  return mermaid;
}

/** Remove the hidden container mermaid renders into when it leaves one behind. */
function dropLeftoverNodes(id: string): void {
  const parent = typeof document === "undefined" ? null : document.body;
  if (parent === null) return;
  for (const candidate of [`d${id}`, id]) {
    parent.querySelector(`#${candidate}`)?.remove();
  }
}

export async function renderDiagram(code: string, theme: DiagramTheme): Promise<DiagramResult> {
  const source = diagramSource(code);
  if (source === "") return { ok: false, message: "" };

  let mermaid: Mermaid;
  try {
    mermaid = await engine(theme);
  } catch {
    return { ok: false, message: "" };
  }

  sequence += 1;
  // The id becomes part of the SVG's internal marker/clipPath ids, so it has to
  // be unique per render — two diagrams of the same source must not share them.
  const id = `pi-mermaid-${sequence}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return { ok: true, svg };
  } catch (error) {
    return { ok: false, message: describeDiagramError(error) };
  } finally {
    dropLeftoverNodes(id);
  }
}
