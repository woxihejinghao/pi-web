import { useEffect, useState } from "react";
import { highlight } from "./highlight.ts";
import styles from "./CodeBlock.module.css";

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setHtml(null);
    void highlight(code, lang).then((result) => {
      if (alive) setHtml(result);
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);

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
    <div className={styles.block}>
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
