import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Is any part of `node` inside the viewport right now? Used once, before the
 * first paint, to answer what an IntersectionObserver can only answer a task
 * later.
 *
 * A missing view (a detached document) counts as visible: the alternative is
 * leaving a fence permanently grey.
 */
function isOnScreen(node: HTMLElement): boolean {
  const view = node.ownerDocument.defaultView;
  if (view === null) return true;
  const rect = node.getBoundingClientRect();
  return (
    rect.top < view.innerHeight && rect.bottom > 0 && rect.left < view.innerWidth && rect.right > 0
  );
}

/**
 * dsh's `useLangReady` (ui-primitives): a fence asks for its grammar only once
 * it is on screen, so the off-screen tail of a long transcript never pulls in
 * grammar chunks nobody scrolled to. The observer is one-shot — once a block
 * has been seen it never goes back to plain text.
 *
 * dsh multiplexes one observer across every code block through an activator
 * map; with one block per component a plain observer is the same thing.
 *
 * The layout effect is this port's addition, and it exists to kill a flicker:
 * an IntersectionObserver reports on a later task, so a fence that is already
 * on screen would spend its first painted frame as plain text and flip to
 * coloured a frame later — a visible blink on every block of a stream. A
 * layout effect runs before paint, so the flip is committed off-screen and the
 * reader only ever sees the coloured version.
 *
 * Mermaid diagrams wait on the same signal for a different reason: a diagram is
 * laid out from scratch at its natural size, and the off-screen tail of a long
 * answer should not pay for that.
 */
export function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);

  useLayoutEffect(() => {
    if (seen) return;
    const node = ref.current;
    if (node === null) return;
    // No IntersectionObserver (test environments): treat the block as visible
    // immediately rather than never updating it.
    if (typeof IntersectionObserver === "undefined" || isOnScreen(node)) setSeen(true);
  }, [ref, seen]);

  useEffect(() => {
    if (seen) return;
    const node = ref.current;
    if (node === null) return;
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
