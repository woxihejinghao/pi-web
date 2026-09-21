import { useMemo, useState } from "react";
import { Glyph, type GlyphName } from "../../components/dsh-icons.tsx";
import { StateDot } from "../../components/StateDot.tsx";
import type { ContentBlock, TextBlock, ToolCallBlock } from "../../lib/types.ts";
import { DisclosureRow } from "./DisclosureRow.tsx";
import { VARIANT_TITLES, classify, deriveSummary, shortenPath, type Variant } from "./row-model.ts";
import type { ToolExecution } from "./useConversation.ts";
import styles from "./ToolCallRow.module.css";

/** Variant → glyph. The UI half of the variant table; the rest lives in row-model. */
const VARIANT_GLYPHS: Record<Variant, GlyphName> = {
  bash: "terminal",
  read: "browse",
  write: "edit",
  edit: "edit",
  search: "search",
  code: "code",
  others: "sparkle",
};

function blocksToText(blocks: ContentBlock[] | null): string {
  if (!blocks) return "";
  return blocks
    .map((block) => (block.type === "text" ? (block as TextBlock).text : `[${block.type}]`))
    .join("\n");
}

/**
 * The input side, trimmed to what the row is about rather than a JSON dump.
 * A shell command is the whole story; for everything else the arguments are.
 */
function inputText(variant: Variant, call: ToolCallBlock): string {
  const args = call.arguments;
  if (!args || Object.keys(args).length === 0) return "";
  if (variant === "bash" && typeof args.command === "string") return `$ ${args.command}`;
  return JSON.stringify(args, null, 2);
}

/**
 * One tool call as a dsh-style disclosure row.
 *
 * Collapsed it is a single 24px line: glyph, name, a 2×2 dot, then the summary.
 * Expanded it grows an I/O card with the arguments on top and the output below.
 * There is no separate chevron column — hovering cross-fades the glyph into a
 * chevron in place, which is what keeps a list of these as tight as a paragraph.
 */
export function ToolCallRow({
  call,
  execution,
  cwd,
  home,
}: {
  call: ToolCallBlock;
  execution: ToolExecution | undefined;
  cwd?: string | undefined;
  home?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const variant = classify(call.name);
  const state = execution?.isError ? "error" : execution?.running ? "running" : "ok";
  const running = execution?.running ?? false;
  // Paths dominate these rows and pi hands them over absolute, so the summary
  // gets the same workspace-then-home treatment dsh applies.
  const summary = shortenPath(deriveSummary(variant, call.arguments ?? execution?.args), cwd, home);
  const output = execution?.output || blocksToText(execution?.result ?? null);
  const input = useMemo(() => inputText(variant, call), [variant, call]);
  const showInput = input.length > 0 || running;

  // dsh falls back to a generic "工具调用" title for tools it does not know.
  // pi's own tool names carry more than that, so an unrecognised tool is titled
  // by its own name instead.
  const title = variant === "others" ? call.name : VARIANT_TITLES[variant];

  return (
    <div className={styles.root} data-variant={variant} data-tool={call.name} data-state={state}>
      {running ? <span className={styles.visuallyHidden}>运行中</span> : null}

      <DisclosureRow
        rowClassName={styles.row}
        leadingClassName={styles.leading}
        titleClassName={styles.title}
        chevronClassName={styles.chevron}
        // dsh swaps the glyph for a state dot when a call did not settle cleanly.
        icon={
          state === "error" ? <StateDot state="error" /> : <Glyph name={VARIANT_GLYPHS[variant]} />
        }
        title={title}
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setOpen((value) => !value)}
        collapsedContent={
          <>
            <span className={styles.sep} aria-hidden />
            <span className={styles.summary} data-error={execution?.isError || undefined}>
              {summary}
            </span>
          </>
        }
      >
        <div className={styles.bodyScroll}>
          <div className={styles.ioCard}>
            {showInput ? (
              <>
                <div className={styles.ioSection}>
                  <span className={styles.ioLabel}>输入</span>
                  <span className={styles.ioText}>{input || "运行中…"}</span>
                </div>
                <div className={styles.ioDivider} />
              </>
            ) : null}
            <div className={styles.ioSection}>
              <span className={styles.ioLabel}>输出</span>
              <span className={styles.ioText} data-error={execution?.isError || undefined}>
                {output.length > 0 ? output : running ? "运行中…" : "(无输出)"}
              </span>
            </div>
          </div>
        </div>
      </DisclosureRow>
    </div>
  );
}
