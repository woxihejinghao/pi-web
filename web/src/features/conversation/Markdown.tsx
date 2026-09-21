import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock.tsx";
import styles from "./Markdown.module.css";

/**
 * Markdown renderer for assistant output and user turns. Fenced blocks go
 * through shiki; inline code stays plain so it inherits theme tokens.
 */
export function Markdown({ text }: { text: string }) {
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
}
