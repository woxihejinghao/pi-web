import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  getGrammarVersion,
  highlightStep,
  lookupHighlight,
  rememberHighlight,
  subscribeLanguages,
  type HighlightCarry,
} from "./highlight.ts";
import styles from "./CodeBlock.module.css";

/**
 * Is any part of `node` inside the viewport right now? Used once, before the
 * first paint, to answer what an IntersectionObserver can only answer a task
 * later.
 *
 * A missing view (a detached document) counts as visible: the alternative is
 * leaving a fence permanently grey.
 */
function isOnScreen(node: HTMLElement): boolean {
  const view = node.ownerDocument.defaultView;
  if (view === null) return true;
  const rect = node.getBoundingClientRect();
  return (
    rect.top < view.innerHeight && rect.bottom > 0 && rect.left < view.innerWidth && rect.right > 0
  );
}

/**
 * dsh's `useLangReady` (ui-primitives): a fence asks for its grammar only once
 * it is on screen, so the off-screen tail of a long transcript never pulls in
 * grammar chunks nobody scrolled to. The observer is one-shot — once a block
 * has been seen it never goes back to plain text.
 *
 * dsh multiplexes one observer across every code block through an activator
 * map; with one block per component a plain observer is the same thing.
 *
 * The layout effect is this port's addition, and it exists to kill a flicker:
 * an IntersectionObserver reports on a later task, so a fence that is already
 * on screen would spend its first painted frame as plain text and flip to
 * coloured a frame later — a visible blink on every block of a stream. A
 * layout effect runs before paint, so the flip is committed off-screen and the
 * reader only ever sees the coloured version.
 */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);

  useLayoutEffect(() => {
    if (seen) return;
    const node = ref.current;
    if (node === null) return;
    // No IntersectionObserver (test environments): treat the block as visible
    // immediately rather than never highlighting.
    if (typeof IntersectionObserver === "undefined" || isOnScreen(node)) setSeen(true);
  }, [ref, seen]);

  useEffect(() => {
    if (seen) return;
    const node = ref.current;
    if (node === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [ref, seen]);

  return seen;
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(rootRef);
  const [copied, setCopied] = useState(false);
  /**
   * The frozen part of the previous tokenize, so a streamed fence only ever
   * re-tokenizes the line being written (see `highlightStep`).
   *
   * A ref rather than state on purpose: it is not rendered, and it has to
   * survive the re-render that a new delta causes. React may replay a render in
   * which this is written, which is safe — the same carry and the same code
   * produce the same next carry.
   */
  const carryRef = useRef<HighlightCarry | null>(null);

  // Grammars other than the entry-chunk three arrive as dynamic imports. dsh
  // renders the fence as plain text until one lands and re-renders on a store
  // notification; the snapshot is a counter, so nothing here has to await.
  const grammarVersion = useSyncExternalStore(
    subscribeLanguages,
    getGrammarVersion,
    getGrammarVersion,
  );

  // Calling `highlightStep` is what requests the grammar, so `onScreen` and
  // `grammarVersion` are both inputs, not side channels.
  const html = useMemo(() => {
    if (!onScreen) return null;
    const cached = lookupHighlight(code, lang);
    // A stale carry is harmless — `highlightStep` checks the prefix before
    // using it — so the cached result does not have to clear it. Keeping it
    // lets the next delta continue from whatever prefix it still describes.
    if (cached !== undefined) return cached;
    const step = highlightStep(carryRef.current, code, lang);
    carryRef.current = step?.carry ?? null;
    const next = step?.html ?? null;
    // `null` is deliberately not cached: a fence whose grammar is still
    // arriving has to be asked again once it lands.
    if (next !== null) rememberHighlight(code, lang, next);
    return next;
  }, [onScreen, code, lang, grammarVersion]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard permission denied; nothing useful to do.
    }
  };

  return (
    <div className={styles.block} ref={rootRef}>
      <div className={styles.banner}>
        <span className={styles.lang}>{lang ?? "text"}</span>
        <button type="button" className={styles.copy} onClick={() => void copy()}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      {/*
       * Both states live inside the same box, and the box is the only element
       * whose identity matters: the grammar landing swaps the *contents* from a
       * bare `<pre>` to shiki's own `<pre>` without React unmounting the
       * container, so the swap cannot move the block or drop its scroll offset.
       * Rendering the plain state as its own `<pre className={styles.code}>`
       * (what this used to do) made the two states different elements, which
       * remounted the fence on every upgrade.
       */}
      <div className={styles.code}>
        {html === null ? (
          <pre>
            <code>{code}</code>
          </pre>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  );
}
