/**
 * The cover that keeps a drag in this document.
 *
 * Chromium does not carry pointer capture across a process boundary, and a
 * `sandbox=""` frame is one: an opaque origin gets a renderer of its own. So a
 * frame that draws an HTML file is a hole a drag can fall into — the moment the
 * pointer crosses into it the parent document stops receiving moves, and it
 * never receives the release either, so the gesture hangs on screen until the
 * next press ends it. No listener here can help: the event is routed to the
 * other process before any handler of ours runs.
 *
 * What does help is never letting the pointer into the frame. A transparent
 * cover over the whole viewport answers the hit test instead, and it is in this
 * document, so the gesture keeps its events. Capture still retargets them to the
 * element the drag started on — compatibility mouse events included, which is
 * why the cover cannot steal the click that a press-and-release on a chip still
 * has to be.
 *
 * Deliberately not a React element: it has to be in the DOM before the browser
 * routes the next pointer event, and a gesture's own preview only reaches the
 * DOM on the render after the move that starts it. This is input routing, not
 * application state.
 */
import styles from "./GestureShield.module.css";

/** How many gestures are holding a cover up. */
let held = 0;
/** The cover itself, while at least one gesture holds it. */
let cover: HTMLElement | null = null;

/**
 * Cover the viewport until the returned callback runs.
 *
 * Refcounted rather than a boolean because a press that supersedes an
 * in-flight gesture ends the old one *after* the new one has begun, so two
 * holds can overlap for a frame.
 * @param cursor - what the pointer shows for the gesture's duration. The cover
 *   is what the pointer is over, so the element underneath no longer gets to
 *   say.
 * @returns the release. Idempotent, and safe to call after the cover is gone.
 */
export function holdPointer(cursor: string): () => void {
  // A static render and a unit test have no document; they have no gestures
  // either, so this is unreachable there rather than guarded by it.
  if (typeof document === "undefined") return () => {};
  held += 1;
  if (cover === null) {
    const element = document.createElement("div");
    element.className = styles.cover;
    element.setAttribute("aria-hidden", "true");
    element.dataset.rbShield = "";
    document.body.append(element);
    cover = element;
  }
  cover.style.cursor = cursor;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held -= 1;
    if (held > 0) return;
    cover?.remove();
    cover = null;
  };
}
