/**
 * Runtime vocabulary derived from the persisted work-details mode, ported from
 * dsh's `ui-chat` presentation policy. Renderers select single fields instead
 * of comparing the mode enum, so adding a mode changes only the table below.
 */

import type { TranscriptDisplay } from "../../lib/types.ts";

/** Presentation capabilities that one work-details mode enables. */
export interface TranscriptPolicy {
  /**
   * Whether a normally completed turn folds its process rows behind the
   * whole-turn completion header (dsh's `foldCompletedTurns`).
   */
  foldCompletedTurns: boolean;
  /**
   * Whether a turn's process rows fold into per-stretch groups, and for which
   * turns — dsh's `stepGrouping`: every turn (`collapsed`), closed turns only
   * (`history`), or none (`none`).
   */
  stepGrouping: "collapsed" | "history" | "none";
  /**
   * Whether a live group's title carries the running tool's argument (a
   * command, a path, a query) — dsh's `liveProcessDetail`.
   */
  liveProcessDetail: boolean;
  /**
   * Whether a settled reasoning row previews its first line beside the Think
   * title (dsh's `settledReasoningPreview`).
   */
  settledReasoningPreview: boolean;
}

const POLICIES: Readonly<Record<TranscriptDisplay, TranscriptPolicy>> = {
  compact: {
    foldCompletedTurns: true,
    stepGrouping: "collapsed",
    liveProcessDetail: false,
    settledReasoningPreview: false,
  },
  standard: {
    foldCompletedTurns: true,
    stepGrouping: "collapsed",
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  detailed: {
    foldCompletedTurns: true,
    stepGrouping: "history",
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  verbose: {
    foldCompletedTurns: false,
    stepGrouping: "none",
    liveProcessDetail: false,
    settledReasoningPreview: true,
  },
};

/**
 * Resolve the policy constant for one mode. The same mode always yields the same
 * object, so selectors over a policy see stable identities.
 * @param mode - persisted work-details mode.
 * @returns the mode's presentation policy.
 */
export function transcriptPolicyFor(mode: TranscriptDisplay): TranscriptPolicy {
  return POLICIES[mode];
}
