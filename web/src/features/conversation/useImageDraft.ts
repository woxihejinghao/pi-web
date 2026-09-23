import {
  useCallback,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type RefObject,
} from "react";
import type { ImageBlock } from "../../lib/types.ts";
import {
  addImages,
  imageFilesFrom,
  readImageFile,
  refusalNotice,
  type ImageRefusal,
} from "../../lib/image-attachments.ts";

export interface ImageDraft {
  /** Pictures waiting to be sent, in the order they were attached. */
  images: ImageBlock[];
  /** What could not be attached, in one line, or null. */
  refusal: string | null;
  /** A file drag is over the input; drives the card's highlight. */
  dragging: boolean;
  attach(files: File[]): Promise<void>;
  remove(index: number): void;
  clear(): void;
  /** Put an unsent draft back after a failed send. */
  restore(images: ImageBlock[]): void;
  /** Paste handler for the message textarea. */
  onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void;
  /** Spread onto the card that wraps the input. */
  dragProps: {
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
  fileInputRef: RefObject<HTMLInputElement | null>;
  openPicker(): void;
}

/**
 * The attachments half of a message input.
 *
 * There are two of them in the app — the conversation's Composer and the new
 * session page's hero card — and they must behave identically: same ceiling,
 * same refusals, same three ways in. The state lives here rather than in each
 * component so "identical" does not depend on anyone keeping two copies in
 * step.
 *
 * Reading is asynchronous (one `FileReader` per image) while remove, send and
 * clear are synchronous, so the list is mirrored in a ref and `apply` is the
 * only writer: a closure over `images` would hand the wrong list to whichever
 * of those ran while a read was in flight.
 */
export function useImageDraft(): ImageDraft {
  const [images, setImages] = useState<ImageBlock[]>([]);
  const imagesRef = useRef<ImageBlock[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const apply = useCallback((next: ImageBlock[]): void => {
    imagesRef.current = next;
    setImages(next);
  }, []);

  const attach = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) return;
      const results = await Promise.all(files.map(readImageFile));
      const incoming = results
        .map((result) => result.image)
        .filter((image): image is ImageBlock => image !== null);
      const refusals = results
        .map((result) => result.refusal)
        .filter((item): item is ImageRefusal => item !== null);
      const merged = addImages(imagesRef.current, incoming);
      apply(merged.images);
      setRefusal(refusalNotice(refusals, merged.overflow));
    },
    [apply],
  );

  const remove = useCallback(
    (index: number): void => {
      apply(imagesRef.current.filter((_, at) => at !== index));
      setRefusal(null);
    },
    [apply],
  );

  const clear = useCallback((): void => {
    apply([]);
    setRefusal(null);
  }, [apply]);

  const restore = useCallback(
    (next: ImageBlock[]): void => {
      apply(next);
    },
    [apply],
  );

  /**
   * A paste, not a key: this fires for Cmd+V and for the middle-click paste of
   * some terminals alike, which is the whole point of handling it here.
   *
   * `preventDefault` is deliberately not called. A paste can carry text *and* a
   * picture (a copied slide, a rich-text snippet), and the text belongs in the
   * input exactly as if it had been typed.
   */
  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>): void => {
      const files = imageFilesFrom(event.clipboardData);
      if (files.length === 0) return;
      void attach(files);
    },
    [attach],
  );

  const onDragOver = useCallback((event: DragEvent<HTMLElement>): void => {
    // Anything else dragged over the input (a selected word, a link) is not
    // this feature's business, and swallowing it would break text drops.
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>): void => {
    // Moving from the card onto one of its children fires `dragleave` on the
    // card; `relatedTarget` is what tells that apart from actually leaving.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      setDragging(false);
      const files = imageFilesFrom(event.dataTransfer);
      if (files.length === 0) return;
      // Without this the browser opens the dropped file and leaves the page.
      event.preventDefault();
      void attach(files);
    },
    [attach],
  );

  const openPicker = useCallback((): void => {
    fileInputRef.current?.click();
  }, []);

  return {
    images,
    refusal,
    dragging,
    attach,
    remove,
    clear,
    restore,
    onPaste,
    dragProps: { onDragOver, onDragLeave, onDrop },
    fileInputRef,
    openPicker,
  };
}
