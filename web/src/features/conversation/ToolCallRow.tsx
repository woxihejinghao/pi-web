import { useMemo } from "react";
import { Glyph, type GlyphName } from "../../components/dsh-icons.tsx";
import { StateDot } from "../../components/StateDot.tsx";
import type { ContentBlock, TextBlock, ToolCallBlock } from "../../lib/types.ts";
import { isContentBlock } from "../../lib/types.ts";
import { DisclosureRow } from "./DisclosureRow.tsx";
import { useDisclosureOpen } from "./use-disclosure-open.ts";
import { ImageThumb } from "../../components/ImageLightbox.tsx";
import { imageBlocksOf } from "../../lib/image-attachments.ts";
import { classify, deriveSummary, shortenPath, variantTitles, type Variant } from "./row-model.ts";
import { diffCardModel, diffTotals } from "./diff-card-model.ts";
import { DiffCard } from "./DiffCard.tsx";
import type { ToolExecution } from "./useConversation.ts";
import styles from "./ToolCallRow.module.css";
import { useT } from "../../lib/app-state.ts";

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

/**
 * The textual half of a tool's answer.
 *
 * Images are left out rather than rendered as `[image]`: they are shown as
 * pictures below this text (see `ioImages`), and a marker next to the picture
 * that stands for it is noise.
 */
function blocksToText(blocks: ContentBlock[] | null): string {
  if (!blocks) return "";
  return blocks
    .filter(isContentBlock)
    .filter((block) => block.type !== "image")
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
  defaultOpen = false,
}: {
  call: ToolCallBlock;
  execution: ToolExecution | undefined;
  cwd?: string | undefined;
  home?: string | undefined;
  /** Whether the I/O card starts open — the verbose display opens every row. */
  defaultOpen?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useDisclosureOpen(defaultOpen);
  const variant = classify(call.name);
  const state = execution?.isError ? "error" : execution?.running ? "running" : "ok";
  const running = execution?.running ?? false;
  // Paths dominate these rows and pi hands them over absolute, so the summary
  // gets the same workspace-then-home treatment dsh applies.
  const summary = shortenPath(deriveSummary(variant, call.arguments ?? execution?.args), cwd, home);
  const output = execution?.output || blocksToText(execution?.result ?? null);
  const images = imageBlocksOf(execution?.result ?? []);
  const input = useMemo(() => inputText(variant, call), [variant, call]);
  // A write/edit call whose arguments describe their own change renders as a
  // diff instead of an argument dump (dsh's file-mutation cards). The model
  // needs parseable arguments, so a still-streaming call falls back to the
  // generic sections until its schema is whole.
  const diff = useMemo(
    () => diffCardModel(call.name, call.arguments ?? execution?.args, execution?.isError ?? false),
    [call, execution?.args, execution?.isError],
  );
  // The collapsed row ends with a live +N -N tally (dsh's diffStat suffix),
  // colored only while the row is hovered or open.
  const totals = useMemo(() => (diff ? diffTotals(diff.diffs) : null), [diff]);
  const showInput = !diff && (input.length > 0 || running);

  // dsh falls back to a generic "工具调用" title for tools it does not know.
  // pi's own tool names carry more than that, so an unrecognised tool is titled
  // by its own name instead.
  const title = variant === "others" ? call.name : variantTitles(t)[variant];

  return (
    <div className={styles.root} data-variant={variant} data-tool={call.name} data-state={state}>
      {running ? <span className={styles.visuallyHidden}>{t("common.running")}</span> : null}

      <DisclosureRow
        rowClassName={styles.row}
        leadingClassName={styles.leading}
        titleClassName={styles.title}
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
            {totals ? (
              <span className={styles.diffStat}>
                <span className={styles.diffAdded}>+{totals.added}</span>{" "}
                <span className={styles.diffRemoved}>-{totals.removed}</span>
              </span>
            ) : null}
          </>
        }
      >
        <div className={styles.bodyScroll}>
          {diff ? (
            <DiffCard {...diff} />
          ) : (
            <div className={styles.ioCard}>
            {showInput ? (
              <>
                <div className={styles.ioSection}>
                  <span className={styles.ioLabel}>{t("toolCall.input")}</span>
                  <span className={styles.ioText}>{input || t("common.runningEllipsis")}</span>
                </div>
                <div className={styles.ioDivider} />
              </>
            ) : null}
            <div className={styles.ioSection}>
              <span className={styles.ioLabel}>{t("toolCall.output")}</span>
              {output.length > 0 || running || images.length === 0 ? (
                <span className={styles.ioText} data-error={execution?.isError || undefined}>
                  {output.length > 0 ? output : running ? t("common.runningEllipsis") : t("toolCall.noOutput")}
                </span>
              ) : null}
              {/* A picture from `read` is the answer itself, not a value for the
                  label beside it, so it spans the section's two columns. */}
              {images.length > 0 ? (
                <div className={styles.ioImages}>
                  {images.map((image, index) => (
                    <ImageThumb
                      key={index}
                      image={image}
                      variant="tool"
                      alt={t("toolCall.resultImage", { index: index + 1 })}
                    />
                  ))}
                </div>
              ) : null}
            </div>
            </div>
          )}
        </div>
      </DisclosureRow>
    </div>
  );
}
