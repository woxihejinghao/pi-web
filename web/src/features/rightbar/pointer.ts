/**
 * Pointer ownership shared by the docked panes and the floating layer.
 *
 * Capture is hardening, not the mechanism: the window listeners carry the
 * gesture either way. Capture is what stops a scroll container the pointer
 * crosses from claiming it, which Chromium reports as a cancelled pointer and
 * an abandoned drag. Environments without the API (jsdom, a static render)
 * simply go unhardened.
 *
 * Copied in shape from dsh's `ui-dockkit/src/components/pointer.ts`: a gesture
 * follows only the pointer that started it, so a second finger or a pen beside
 * the mouse can neither move nor end it, and the listeners remove themselves
 * before `up` or `cancel` runs.
 *
 * One thing is not copied. dsh relies on capture alone, which holds everywhere
 * inside this document but not across a process boundary — and a preview of an
 * HTML file is a `sandbox=""` frame, which is exactly that. So every gesture
 * also raises a cover that the pointer cannot leave the document through; see
 * `gesture-shield.ts`.
 */
import { useEffect, useRef } from "react";
import { holdPointer } from "./gesture-shield.ts";

/** What a gesture does while it lasts and when it settles. */
export interface GestureFollowers {
  readonly move: (event: PointerEvent) => void;
  /** The release. The gesture has already ended when this runs. */
  readonly up: (event: PointerEvent) => void;
  /**
   * What the pointer shows for the gesture's duration.
   *
   * Carried here rather than left to the element, because the cover is what the
   * pointer is over: the grip underneath has stopped being consulted, and only
   * the gesture knows what it is doing. Each caller passes the cursor of the
   * grip it started from, so a drag looks the way its handle does.
   */
  readonly cursor?: string;
}

/** What the three window listeners call. */
interface PointerFollowers extends GestureFollowers {
  readonly cancel: () => void;
}

/**
 * Take ownership of the pointer for the rest of the gesture.
 * @param element - the element the gesture started on.
 * @param pointerId - the pointer to capture.
 */
export function capturePointer(element: HTMLElement, pointerId: number): void {
  if (typeof element.setPointerCapture !== "function") return;
  element.setPointerCapture(pointerId);
}

/**
 * Capture the pointer, then follow it on the window until release or cancel.
 * @param element - the element the gesture started on.
 * @param pointerId - the pointer to capture and follow.
 * @param followers - listeners for move, release, and cancel.
 * @returns detach callback removing the three listeners.
 */
export function followPointer(
  element: HTMLElement,
  pointerId: number,
  followers: PointerFollowers,
): () => void {
  capturePointer(element, pointerId);
  const controller = new AbortController();
  const { signal } = controller;
  // The cover lives exactly as long as the gesture: every way out — the
  // release, a cancel, a superseding press, an unmount — aborts the controller,
  // and the abort is what puts it down.
  signal.addEventListener("abort", holdPointer(followers.cursor ?? "default"), { once: true });
  const own = (event: PointerEvent): boolean => event.pointerId === pointerId;
  window.addEventListener(
    "pointermove",
    (event) => {
      if (own(event)) followers.move(event);
    },
    { signal },
  );
  window.addEventListener(
    "pointerup",
    (event) => {
      if (!own(event)) return;
      controller.abort();
      followers.up(event);
    },
    { signal },
  );
  window.addEventListener(
    "pointercancel",
    (event) => {
      if (!own(event)) return;
      controller.abort();
      followers.cancel();
    },
    { signal },
  );
  return () => {
    controller.abort();
  };
}

/**
 * Start a gesture from the element a press landed on.
 * @param element - the pressed element; the pointer is captured on it.
 * @param pointerId - the pressing pointer.
 * @param followers - what the gesture does.
 */
export type BeginGesture = (
  element: HTMLElement,
  pointerId: number,
  followers: GestureFollowers,
) => void;

/**
 * One pointer gesture at a time for a component.
 *
 * A gesture ends on release, on cancel, or when a new press supersedes it;
 * `reset` runs at each of those ends so the component clears its preview (the
 * drag highlight, the drop hints, the resize preview). Unmounting mid-gesture
 * removes the listeners without resetting anything.
 * @param reset - clears the component's gesture preview.
 * @returns the gesture starter, called from a pointer-down handler.
 */
export function useGesture(reset: () => void): BeginGesture {
  const inFlight = useRef<{ readonly stop: () => void; readonly end: () => void } | null>(null);
  useEffect(() => () => inFlight.current?.stop(), []);
  return (element, pointerId, followers) => {
    inFlight.current?.end();
    const settle = (): void => {
      inFlight.current = null;
      reset();
    };
    const stop = followPointer(element, pointerId, {
      // Carried through, not dropped: this object is rebuilt here, and a cursor
      // that stops at this line makes every gesture's cover say `default`.
      cursor: followers.cursor,
      move: followers.move,
      up: (event) => {
        settle();
        followers.up(event);
      },
      cancel: settle,
    });
    inFlight.current = {
      stop,
      end: () => {
        stop();
        settle();
      },
    };
  };
}
