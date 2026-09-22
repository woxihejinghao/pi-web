import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { getGrammarVersion, highlight, subscribeLanguages } from "./highlight.ts";
import styles from "./CodeBlock.module.css";

/**
 * dsh's `useLangReady` (ui-primitives): a fence asks for its grammar only once
 * it is on screen, so the off-screen tail of a long transcript never pulls in
 * grammar chunks nobody scrolled to. The observer is one-shot — once a block
 * has been seen it never goes back to plain text.
 *
 * dsh multiplexes one observer across every code block through an activator
 * map; with one block per component a plain observer is the same thing.
 */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (seen) return;
    const node = ref.current;
    if (node === null) return;
    // No IntersectionObserver (test environments): treat the block as visible
    // immediately rather than never highlighting.
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

  // Grammars other than the entry-chunk three arrive as dynamic imports. dsh
  // renders the fence as plain text until one lands and re-renders on a store
  // notification; the snapshot is a counter, so nothing here has to await.
  const grammarVersion = useSyncExternalStore(
    subscribeLanguages,
    getGrammarVersion,
    getGrammarVersion,
  );

  // Calling `highlight` is what requests the grammar, so `onScreen` and
  // `grammarVersion` are both inputs, not side channels.
  const html = useMemo(
    () => (onScreen ? highlight(code, lang) : null),
    [onScreen, code, lang, grammarVersion],
  );

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
      {html ? (
        <div className={styles.code} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className={styles.code}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
