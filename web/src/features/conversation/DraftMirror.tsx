import { useCallback, useMemo, useRef, type RefObject } from "react";
import { FolderIcon } from "../../components/icons.tsx";
import { REFERENCE_SLOT, referenceSpans } from "./reference-token.ts";
import styles from "./DraftMirror.module.css";

/**
 * The draft as it should look, painted underneath a transparent textarea.
 *
 * The editor stays a textarea — the slash menu, the IME, the selection and the
 * autosize all keep working — and the only thing it cannot do, styling part of
 * its own value, is done by a same-sized layer behind it. The two layers share
 * one typography, one padding and one wrapping rule (each card's stylesheet
 * keeps them equal, since the input's own metrics differ between the composer
 * and the hero), and the textarea scrolls this one along with it.
 *
 * Nothing here changes a width. A chip colours its own characters and nothing
 * else, and the folder glyph is painted *over* the em space a drop wrote into
 * the text (`REFERENCE_SLOT`) rather than beside it. That is what keeps the
 * chip's icon at the same left edge as ordinary text — no card padding is
 * consumed by it, and no measurement decides where it goes. It also means the
 * two layers wrap identically without either one modelling the other: the
 * mirror lays out exactly the characters the textarea does.
 *
 * A reference the user typed by hand has no slot, so it keeps its colour and
 * gets no glyph — there would be a letter under the icon.
 */
export function DraftMirror({ text, className, mirrorRef }: {
  text: string;
  /** The card's positioning and metrics for this layer. */
  className?: string;
  /** Read by the textarea's scroll handler to keep the layers aligned. */
  mirrorRef?: RefObject<HTMLDivElement | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const parts = useMemo(() => split(text), [text]);

  const attach = useCallback(
    (node: HTMLDivElement | null): void => {
      hostRef.current = node;
      if (mirrorRef) mirrorRef.current = node;
    },
    [mirrorRef],
  );

  return (
    <div className={className} ref={attach} aria-hidden="true">
      {parts.map((part) => part.kind === "text"
        ? <span key={`text-${part.at}`}>{part.value}</span>
        : (
          <span
            key={`ref-${part.start}`}
            className={styles.reference}
            data-slot={part.slot || undefined}
          >
            <span className={styles.referenceIcon}>
              <FolderIcon width={14} height={14} />
            </span>
            {part.value}
          </span>
        ))}
    </div>
  );
}

/** One run of the draft: plain text, or a folder reference by its range. */
type Part =
  | { kind: "text"; at: number; value: string }
  | { kind: "reference"; start: number; value: string; slot: boolean };

function split(text: string): Part[] {
  const parts: Part[] = [];
  let cursor = 0;
  for (const span of referenceSpans(text)) {
    if (span.start > cursor) {
      parts.push({ kind: "text", at: cursor, value: text.slice(cursor, span.start) });
    }
    parts.push({
      kind: "reference",
      start: span.start,
      value: text.slice(span.start, span.end),
      slot: text.startsWith(REFERENCE_SLOT, span.start),
    });
    cursor = span.end;
  }
  if (cursor < text.length) parts.push({ kind: "text", at: cursor, value: text.slice(cursor) });
  return parts;
}
