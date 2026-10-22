import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileTypeIcon } from "./file-type-icon.tsx";
import styles from "./FileTypeIcon.module.css";

/**
 * Which branch a row's mark takes, and the metric it takes it at.
 *
 * The artwork itself is a checked-in table (see `code-file-icon-artwork.ts`) and
 * is not re-asserted here; what this pins down is the dispatch — a detailed code
 * type gets the full-colour square, everything else gets the shared sheet — plus
 * the two things a caller cannot see from the source: the 28px default and the
 * sheet's category class.
 */
describe("FileTypeIcon", () => {
  it("draws the full-colour square artwork for a detailed code type", () => {
    const html = renderToStaticMarkup(<FileTypeIcon name="src/main.ts" size={16} />);
    // The code square's own 20px artboard, scaled to the requested edge.
    expect(html).toContain('viewBox="0 0 20 20"');
    expect(html).toContain('width="16"');
    expect(html).toContain('height="16"');
  });

  it("draws the shared sheet for a coarse category, under that category's class", () => {
    const html = renderToStaticMarkup(<FileTypeIcon name="shot.png" size={16} />);
    expect(html).toContain('viewBox="0 0 28 28"');
    expect(styles.image).toBeDefined();
    expect(html).toContain(styles.image!);
    expect(html).not.toContain('viewBox="0 0 20 20"');
  });

  it("gives an unclaimed file the muted sheet", () => {
    const html = renderToStaticMarkup(<FileTypeIcon name="archive.zip" />);
    expect(html).toContain(styles.other!);
    expect(html).toContain('viewBox="0 0 28 28"');
  });

  it("defaults to the artwork's 28px when the caller has no metric", () => {
    const html = renderToStaticMarkup(<FileTypeIcon name="notes.md" />);
    expect(html).toContain('width="28"');
    expect(html).toContain('height="28"');
  });

  it("takes an already resolved kind instead of re-classifying", () => {
    // `kind` wins over `name`: a caller that knows the category — a document
    // preview with the server's verdict — must not have it re-guessed. The name
    // here classifies as an image, so a dispatch that ignored `kind` would paint
    // the image class rather than the pdf one.
    const html = renderToStaticMarkup(
      <FileTypeIcon name="scan.png" kind="pdf" size={16} />,
    );
    expect(html).toContain(styles.pdf!);
    expect(html).not.toContain(styles.image!);
  });
});
