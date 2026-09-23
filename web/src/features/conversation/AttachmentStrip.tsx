import type { RefObject } from "react";
import { CloseIcon, ImageIcon } from "../../components/icons.tsx";
import { ACCEPTED_IMAGE_MIME_TYPES, imageDataUrl } from "../../lib/image-attachments.ts";
import type { ImageBlock } from "../../lib/types.ts";
import styles from "./AttachmentStrip.module.css";

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
                title="移除"
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
 * The visible half of the file picker.
 *
 * A toolbar glyph rather than a filled disc: attaching is an offer, the send
 * button is the action.
 */
export function AttachButton({ disabled, onClick }: { disabled?: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      className={styles.attach}
      disabled={disabled ?? false}
      onClick={onClick}
      aria-label="添加图片"
      title="添加图片（也可粘贴或拖入）"
    >
      <ImageIcon />
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
