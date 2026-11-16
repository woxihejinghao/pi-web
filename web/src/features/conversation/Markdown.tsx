import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import clsx from "clsx";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";
import { FileRefChip } from "./FileRefChip.tsx";
import { useFileRefs, type FileRefDelegate } from "./file-ref-context.tsx";
import { fileRefLabel, parseFileTarget } from "./file-ref.ts";
import styles from "./Markdown.module.css";

/** The text of a link's label, when the label is text a chip can wear. */
function plainText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(plainText).join("");
  // Anything else — an image, nested markup — has no one-line spelling here;
  // the chip falls back to the file's own name.
  return "";
}

/**
 * Whether the inline markdown being rendered sits inside a link's label.
 *
 * A button may not be nested in an anchor, and `[see `index.ts`](https://…)`
 * puts an inline token exactly there. The renderer cannot tell from the `code`
 * node alone, so the `a` renderer marks the subtree it owns; dsh carries the
 * same flag through its own render pass (`inLink`).
 */
const InLinkContext = createContext(false);

/** Whether the text being rendered is still arriving; see the module note. */
const StreamingContext = createContext(false);

/**
 * The hover preview for one reference, when the owner can serve it as a picture.
 *
 * The caption is the chip's own short name, so the card and the chip cannot
 * disagree about which file is being shown.
 */
function imagePreview(
  refs: FileRefDelegate | null,
  path: string,
): { url: string; name: string } | undefined {
  const url = refs?.imageUrl?.(path);
  return url === undefined ? undefined : { url, name: fileRefLabel({ path }) };
}

/**
 * The renderers themselves, at module scope.
 *
 * Their identity is the point. `react-markdown` treats each entry of
 * `components` as an element type, so an arrow function written inside the
 * component is a *different* type on every render — React then unmounts the
 * whole markdown subtree and mounts an identical one, which is not merely
 * wasteful: a file chip's hover timer, a fence's scroll offset and a
 * disclosure's open state all die with the old tree. Measured on the reference
 * verification: the chips were being remounted ~350ms after the transcript
 * settled, which is enough to lose a hover that had already started. Module
 * scope makes the types permanent, so a re-render reconciles instead of
 * replacing.
 *
 * Everything these renderers need beyond their own props comes from context —
 * the file vocabulary, the streaming flag, the anchor nesting — which is what
 * lets them be constants rather than closures.
 */
function MarkdownPre({ children }: { children?: ReactNode }) {
  // CodeBlock renders its own container, so the default <pre> wrapper would nest
  // two boxes.
  return <>{children}</>;
}

function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  const refs = useFileRefs();
  // Read inside the renderer, not the component above: the provider that sets
  // this flag is in the tree this renderer belongs to.
  const inLink = useContext(InLinkContext);
  const streaming = useContext(StreamingContext);
  const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
  const raw = String(children ?? "");
  const isBlock = Boolean(language) || raw.includes("\n");
  if (isBlock) {
    const source = raw.replace(/\n$/, "");
    // A `mermaid` fence is not code to colour — it is a picture to draw, with its
    // own fallback to the source while the answer streams or when it does not
    // parse. `mmd` is the extension the same diagrams are stored under.
    if (language !== undefined && (language === "mermaid" || language === "mmd")) {
      return <MermaidBlock code={source} streaming={streaming} />;
    }
    return <CodeBlock code={source} lang={language} />;
  }

  // A token the turn's vocabulary knows becomes a chip; anything it does not
  // name — including every token while the message streams — stays code, which
  // is the honest fallback: the reader can still copy it, and no handler is
  // baked into a path that may change.
  const target = refs === null || streaming || inLink ? undefined : refs.resolve(raw);
  if (target !== undefined && refs !== null) {
    const preview = imagePreview(refs, target.path);
    return (
      <FileRefChip
        file={target}
        {...(preview === undefined ? {} : { preview })}
        onOpen={() => {
          refs.open(target);
        }}
      />
    );
  }
  return <code className={styles.inlineCode}>{children}</code>;
}

function MarkdownAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const refs = useFileRefs();
  const streaming = useContext(StreamingContext);
  const file = streaming ? undefined : parseFileTarget(href ?? "");
  // A local destination is a file, not a page: it opens in the panel that can
  // show it, and a link this app cannot resolve keeps the browser's own
  // behavior rather than becoming a dead chip.
  if (file !== undefined && refs !== null) {
    const label = plainText(children);
    const preview = imagePreview(refs, file.path);
    return (
      <FileRefChip
        file={file}
        {...(label === "" ? {} : { label })}
        {...(preview === undefined ? {} : { preview })}
        onOpen={() => {
          refs.open(file);
        }}
      />
    );
  }
  return (
    <a className={styles.link} href={href} target="_blank" rel="noreferrer">
      <InLinkContext.Provider value>{children}</InLinkContext.Provider>
    </a>
  );
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>{children}</table>
    </div>
  );
}

/** Stable forever; see the note above `MarkdownPre`. */
const MARKDOWN_COMPONENTS: Components = {
  pre: MarkdownPre,
  code: MarkdownCode,
  a: MarkdownAnchor,
  table: MarkdownTable,
};

/**
 * Markdown renderer for assistant output and user turns. Fenced blocks go
 * through shiki — except a `mermaid` fence, which is a picture rather than code
 * and is handed to `MermaidBlock` (see the note there). Inline code stays plain
 * so it inherits theme tokens.
 *
 * Two of its affordances come from the surrounding `FileRefProvider`, and both
 * are off without one: a link whose destination names a workspace file becomes a
 * chip that opens it in the right sidebar (rather than a new browser tab), and an
 * inline-code token the turn's vocabulary recognizes as a real file becomes one
 * too. dsh splits these the same way — the *spelling* is the renderer's, the
 * *vocabulary* belongs to the turn — and it is what lets this component stay a
 * plain renderer for its seven call sites, only one of which is a conversation.
 *
 * Both are disabled while the message streams. A half-written path is not a
 * reference yet, and the vocabulary an answer will end up mentioning is not
 * final, so a chip now would be a guess that a later chunk would have to
 * retract.
 *
 * `variant` chooses the rhythm, not the sizes: `message` (the default) is the
 * transcript's tight one, where a paragraph is one of many and air between them
 * only pushes the next message off screen, while `document` is dsh's own spacing
 * for a surface that shows a whole document at a column's width (the plan
 * preview).
 *
 * Memoized on `text`, which is the whole point during a stream: every delta
 * republishes the conversation view, and without this the *entire* transcript
 * would be re-parsed and re-rendered for each token — a settled answer four
 * screens up is the same string it was a moment ago, and re-deriving it can
 * only cost frames in the one moment the reader is watching output arrive.
 */
export const Markdown = memo(function Markdown({
  text,
  variant = "message",
  streaming = false,
}: {
  text: string;
  /** `document` gives a whole document dsh's spacing; see the module note. */
  variant?: "message" | "document";
  /** Whether this text is still arriving; see the module note. */
  streaming?: boolean;
}) {
  const classes = useMemo(
    () => clsx(styles.markdown, variant === "document" && styles.document),
    [variant],
  );
  return (
    <StreamingContext.Provider value={streaming}>
      <div className={classes}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
          {text}
        </ReactMarkdown>
      </div>
    </StreamingContext.Provider>
  );
});
