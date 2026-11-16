import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/app-state.ts";
import styles from "./MermaidBlock.module.css";
import { diagramSource, renderDiagram, type DiagramTheme } from "./mermaid.ts";
import { useOnScreen } from "./use-on-screen.ts";

/**
 * The appearance the diagram should be drawn in.
 *
 * Read from `html[data-appearance]` rather than from a store: that attribute is
 * the single place the app commits an appearance — the pre-paint script writes
 * it before the first frame, and every later change (including `system`
 * re-resolving against the OS) goes through `applyAppearance`, which sets the
 * same attribute. Watching it is therefore one source of truth, not a second
 * copy of the theme logic.
 */
function readTheme(): DiagramTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.appearance === "dark" ? "dark" : "light";
}

function useDiagramTheme(): DiagramTheme {
  const [theme, setTheme] = useState<DiagramTheme>(readTheme);

  useEffect(() => {
    setTheme(readTheme());
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-appearance"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

type RenderState =
  | { status: "pending" }
  | { status: "ready"; svg: string }
  | { status: "failed"; message: string };

/**
 * A```mermaid fence: the diagram when there is one, its source otherwise.
 *
 * Three states show the source instead of a picture, and all of them are the
 * same fallback a code fence has — text that can still be read and copied:
 *
 * - while the answer is still streaming, because a half-written diagram is not
 *   a diagram, and rendering every delta would spawn and throw away an SVG per
 *   token;
 * - while the block has never been on screen, so the off-screen tail of a long
 *   answer costs nothing (the engine chunk included);
 * - when Mermaid cannot parse it, in which case the error joins the source.
 *
 * "Show source" is not a fourth state but a toggle, so the reader can always ask
 * for the text behind a diagram that did render.
 */
export function MermaidBlock({ code, streaming }: { code: string; streaming: boolean }) {
  const t = useT();
  const source = diagramSource(code);
  const theme = useDiagramTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(rootRef);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [state, setState] = useState<RenderState>({ status: "pending" });
  /**
   * What the last render attempt was for, as `theme\0source`.
   *
   * A ref, not state: it decides whether to *start* work, and re-rendering
   * because a ref changed would be a second render for no new output. It also
   * remembers failures, so scrolling past a broken diagram or flipping to the
   * source and back does not re-parse it every time.
   */
  const attempted = useRef<string | null>(null);

  const wantsDiagram = !streaming && onScreen && source !== "" && !showSource;

  useEffect(() => {
    if (!wantsDiagram) return;
    const key = `${theme}\u0000${source}`;
    if (attempted.current === key) return;
    attempted.current = key;
    let cancelled = false;
    void renderDiagram(source, theme).then((result) => {
      // A late result for a source that has since changed belongs to a diagram
      // that is no longer on screen.
      if (cancelled) return;
      setState(
        result.ok
          ? { status: "ready", svg: result.svg }
          : { status: "failed", message: result.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [wantsDiagram, source, theme]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard permission denied; nothing useful to do.
    }
  };

  const drawn = !showSource && state.status === "ready";

  return (
    <div className={styles.block} data-diagram-view={drawn ? "diagram" : "source"} ref={rootRef}>
      <div className={styles.banner}>
        <span className={styles.lang}>mermaid</span>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            aria-pressed={showSource}
            onClick={() => setShowSource((shown) => !shown)}
          >
            {showSource ? t("mermaid.diagram") : t("mermaid.source")}
          </button>
          <button type="button" className={styles.action} onClick={() => void copy()}>
            {copied ? t("common.copied") : t("common.copy")}
          </button>
        </div>
      </div>
      {state.status === "failed" && (
        <p className={styles.error}>
          {state.message === ""
            ? t("mermaid.renderFailed")
            : `${t("mermaid.renderFailed")}: ${state.message}`}
        </p>
      )}
      {drawn ? (
        // `securityLevel: "strict"` is what makes this safe: mermaid sanitizes
        // the labels and drops click handlers, so the markup is its own SVG.
        <div className={styles.diagram} dangerouslySetInnerHTML={{ __html: state.svg }} />
      ) : (
        <pre className={styles.source}>
          <code>{source}</code>
        </pre>
      )}
    </div>
  );
}
