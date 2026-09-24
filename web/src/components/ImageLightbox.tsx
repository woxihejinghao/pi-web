import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { imageDataUrl } from "../lib/image-attachments.ts";
import type { ImageBlock } from "../lib/types.ts";
import { CloseIcon } from "./icons.tsx";
import styles from "./ImageLightbox.module.css";
import { useT } from "../lib/app-state.ts";

/**
 * Full-size viewing for every thumbnail in the app.
 *
 * There is one lightbox per app, hung above the layout, because the images it
 * shows come from everywhere: a screenshot in a user turn, a chart a tool
 * returned, and a picture still sitting in the input bar are the same thing to a
 * reader who wants a closer look. One provider rather than one per image keeps a
 * paste of six screenshots from mounting six overlays and six Escape listeners.
 *
 * Without a provider a thumbnail still renders and simply does not open — the
 * transcript is worth reading in a test harness that has no overlay.
 */
interface LightboxApi {
  open(image: ImageBlock, alt: string): void;
}

const LightboxContext = createContext<LightboxApi | null>(null);

interface Shown {
  image: ImageBlock;
  alt: string;
}

export function ImageLightboxProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [shown, setShown] = useState<Shown | null>(null);

  const open = useCallback((image: ImageBlock, alt: string): void => {
    setShown({ image, alt });
  }, []);
  const close = useCallback((): void => {
    setShown(null);
  }, []);
  const api = useMemo(() => ({ open }), [open]);

  useEffect(() => {
    if (shown === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, close]);

  return (
    <LightboxContext.Provider value={api}>
      {children}
      {shown === null ? null : (
        <div
          className={styles.mask}
          role="dialog"
          aria-modal="true"
          aria-label={t("lightbox.title")}
          // The mask is the close target, so a click beside the picture does
          // what a click on a photo viewer always does. The comparison against
          // `currentTarget` is what keeps a click *on* the picture (or on the
          // close disc) from closing it.
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <img className={styles.full} src={imageDataUrl(shown.image)} alt={shown.alt} />
          <button
            type="button"
            className={styles.close}
            onClick={close}
            aria-label={t("common.close")}
            title={t("lightbox.closeTitle")}
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </LightboxContext.Provider>
  );
}

/**
 * One image, sized to its container, opening the lightbox on click.
 *
 * A `<button>` rather than a bare `<img>`: the whole point is that it is
 * clickable, and a button brings focus, keyboard activation and the right
 * cursor with it. `variant` only picks the corner radius — inside a user bubble
 * the thumbnail follows the bubble's own rounding, in a tool row it follows the
 * I/O card's.
 */
export function ImageThumb({
  image,
  variant = "message",
  alt,
}: {
  image: ImageBlock;
  variant?: "message" | "user" | "tool";
  alt?: string;
}) {
  const t = useT();
  const label = alt ?? t("lightbox.alt");
  const lightbox = useContext(LightboxContext);
  return (
    <button
      type="button"
      className={styles.thumb}
      data-variant={variant}
      onClick={() => lightbox?.open(image, label)}
      title={t("lightbox.open")}
      aria-label={t("lightbox.openLabel", { alt: label })}
    >
      <img src={imageDataUrl(image)} alt={label} loading="lazy" />
    </button>
  );
}
