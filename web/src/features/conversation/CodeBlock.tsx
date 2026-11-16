import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  getGrammarVersion,
  highlightStep,
  lookupHighlight,
  rememberHighlight,
  subscribeLanguages,
  type HighlightCarry,
} from "./highlight.ts";
import styles from "./CodeBlock.module.css";
import { useOnScreen } from "./use-on-screen.ts";
import { useT } from "../../lib/app-state.ts";

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const t = useT();
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
          {copied ? t("common.copied") : t("common.copy")}
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
