import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock.tsx";
import styles from "./Markdown.module.css";

/**
 * Markdown renderer for assistant output and user turns. Fenced blocks go
 * through shiki; inline code stays plain so it inherits theme tokens.
 *
 * Memoized on `text`, which is the whole point during a stream: every delta
 * republishes the conversation view, and without this the *entire* transcript
 * would be re-parsed and re-rendered for each token — a settled answer four
 * screens up is the same string it was a moment ago, and re-deriving it can
 * only cost frames in the one moment the reader is watching output arrive.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // CodeBlock renders its own container, so the default <pre> wrapper
          // would nest two boxes.
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
            const raw = String(children ?? "");
            const isBlock = Boolean(language) || raw.includes("\n");
            if (!isBlock) {
              return <code className={styles.inlineCode}>{children}</code>;
            }
            return <CodeBlock code={raw.replace(/\n$/, "")} lang={language} />;
          },
          a: ({ href, children }) => (
            <a className={styles.link} href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className={styles.tableWrap}>
              <table className={styles.table}>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
