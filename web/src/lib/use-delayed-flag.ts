import { useEffect, useState } from "react";

/**
 * Report `active` only once it has stayed true for `delayMs`.
 *
 * Transcripts are read from disk now, so a session switch is usually over in
 * under 150ms. Rendering "正在载入会话…" immediately would just make the text
 * flash for two frames, which reads worse than showing nothing at all. If the
 * load ever does drag on, the hint appears and explains the wait.
 */
export function useDelayedFlag(active: boolean, delayMs = 250): boolean {
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!active) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return settled;
}
