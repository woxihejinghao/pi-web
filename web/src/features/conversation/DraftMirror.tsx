import { useCallback, useMemo, useRef, type RefObject } from "react";
import { FileIcon, FolderIcon } from "../../components/icons.tsx";
import type { SlashCommand } from "../../lib/types.ts";
import { FILE_SIGIL, REFERENCE_SLOT, referenceSpans } from "./reference-token.ts";
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
 * else, and the glyph is painted *over* the em space an insertion wrote into
 * the text (`REFERENCE_SLOT`) rather than beside it. That is what keeps the
 * chip's icon at the same left edge as ordinary text — no card padding is
 * consumed by it, and no measurement decides where it goes. It also means the
 * two layers wrap identically without either one modelling the other: the
 * mirror lays out exactly the characters the textarea does.
 *
 * A reference the user typed by hand has no slot, so it keeps its colour and
 * gets no glyph — there would be a letter under the icon. The glyph itself
 * distinguishes the two kinds a chip can stand for: a folder, or a file (see
 * `FILE_SIGIL`).
 */
export function DraftMirror({ text, commands = [], className, mirrorRef }: {
  text: string;
  /** Only registered skills are highlighted; partial or unknown names stay prose. */
  commands?: SlashCommand[];
  /** The card's positioning and metrics for this layer. */
  className?: string;
  /** Read by the textarea's scroll handler to keep the layers aligned. */
  mirrorRef?: RefObject<HTMLDivElement | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const parts = useMemo(() => split(text, commands), [text, commands]);

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
        : part.kind === "skill"
          ? <span key={`skill-${part.start}`} className={styles.skill}>{part.value}</span>
          : (
          <span
            key={`ref-${part.start}`}
            className={styles.reference}
            data-slot={part.slot || undefined}
            data-file={part.file || undefined}
          >
            <span className={styles.referenceIcon}>
              {part.file ? <FileIcon width={14} height={14} /> : <FolderIcon width={14} height={14} />}
            </span>
            {part.value}
          </span>
        ))}
    </div>
  );
}

/** One run of the draft: plain text, or a reference by its range. */
type Part =
  | { kind: "text"; at: number; value: string }
  | { kind: "skill"; start: number; value: string }
  | { kind: "reference"; start: number; value: string; slot: boolean; file: boolean };

function split(text: string, commands: SlashCommand[]): Part[] {
  const parts: Part[] = [];
  let cursor = 0;
  // Skills execute only at the start of a prompt. Match the whole token so a
  // partial name, path, or a skill mentioned in prose never looks executable.
  const skill = /^(\s*)\/([^\s/]+)(?=\s|$)/.exec(text);
  if (skill && commands.some((command) => command.source === "skill" && command.name === skill[2])) {
    const start = skill[1]?.length ?? 0;
    if (start > 0) parts.push({ kind: "text", at: 0, value: text.slice(0, start) });
    cursor = skill[0].length;
    parts.push({ kind: "skill", start, value: text.slice(start, cursor) });
  }
  for (const span of referenceSpans(text)) {
    if (span.start < cursor) continue;
    if (span.start > cursor) {
      parts.push({ kind: "text", at: cursor, value: text.slice(cursor, span.start) });
    }
    const slot = text.startsWith(REFERENCE_SLOT, span.start);
    parts.push({
      kind: "reference",
      start: span.start,
      value: text.slice(span.start, span.end),
      slot,
      // A hand-typed reference has no slot and is always a folder path; only a
      // chip can carry the sigil, and only a slot can carry a glyph.
      file: slot && text.startsWith(FILE_SIGIL, span.start + REFERENCE_SLOT.length),
    });
    cursor = span.end;
  }
  if (cursor < text.length) parts.push({ kind: "text", at: cursor, value: text.slice(cursor) });
  return parts;
}
