import type { RefObject } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import { CloseIcon } from "../../components/icons.tsx";
import { ACCEPTED_IMAGE_MIME_TYPES, imageDataUrl } from "../../lib/image-attachments.ts";
import type { ImageBlock } from "../../lib/types.ts";
import styles from "./AttachmentStrip.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * The draft strip: what is about to be sent, above the text it is attached to.
 *
 * A 64px thumbnail rather than a filename, because a screenshot's name is
 * `CleanShot 2026-09-22 at 10.41.12@2x.png` and tells the user nothing about
 * which one it is. Shared by the conversation composer and the new-session
 * card, which are the same input in two places and must not drift.
 */
export function AttachmentStrip({
  images,
  refusal,
  onRemove,
}: {
  images: ImageBlock[];
  refusal: string | null;
  onRemove(index: number): void;
}) {
  const t = useT();
  if (images.length === 0 && refusal === null) return null;
  return (
    <>
      {images.length > 0 ? (
        <div className={styles.attachments}>
          {images.map((image, index) => (
            <div className={styles.attachment} key={index}>
              <img src={imageDataUrl(image)} alt={`附件 ${String(index + 1)}`} />
              <button
                type="button"
                className={styles.remove}
                onClick={() => onRemove(index)}
                aria-label={`移除附件 ${String(index + 1)}`}
                title={t("common.remove")}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {/* Shown even with no thumbnails above it: a drag of one PDF leaves a
          refusal and nothing else, and that is exactly the case where silence
          would look like the drop was ignored. */}
      {refusal !== null ? <p className={styles.refusal}>{refusal}</p> : null}
    </>
  );
}

/**
 * The visible half of the file picker: dsh's attach circle — a 28px selector
 * disc with the paperclip on it.
 *
 * The paperclip is dsh's own glyph (`IconPaperclipOutline16`) rather than the
 * picture frame this used to draw: the button attaches files, and a mark that
 * names the act is what dsh puts on the circle.
 */
export function AttachButton({ disabled, onClick }: { disabled?: boolean; onClick(): void }) {
  const t = useT();
  return (
    <button
      type="button"
      className={styles.attach}
      disabled={disabled ?? false}
      onClick={onClick}
      aria-label={t("attach.add")}
      title={t("attach.addTitle")}
    >
      <Glyph name="paperclip" />
    </button>
  );
}

/**
 * The picker itself, never drawn.
 *
 * `accept` is the same list the reader enforces, so the file dialog cannot
 * offer something the send path would refuse afterwards — two different answers
 * to "what is an image" would show up as a silent no-op.
 */
export function AttachmentInput({
  inputRef,
  onFiles,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onFiles(files: File[]): void;
}) {
  const t = useT();
  return (
    <input
      ref={inputRef}
      className={styles.fileInput}
      type="file"
      accept={ACCEPTED_IMAGE_MIME_TYPES.join(",")}
      multiple
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        // Cleared before the (async) read: attaching the same file twice in a
        // row is normal after removing it, and an unchanged value fires no
        // change event the second time.
        event.target.value = "";
        onFiles(files);
      }}
    />
  );
}
