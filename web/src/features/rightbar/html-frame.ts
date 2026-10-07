/**
 * A local HTML file, prepared for a frame that cannot run anything.
 *
 * Two locks, because either alone is not enough. The frame carries `sandbox=""`,
 * which is the browser's own promise that no script, form or navigation
 * originates inside it. This module adds the second one: a content policy
 * delivered inside the document, which is what keeps the frame from *fetching*
 * — a page with no scripts can still leak what it displays through an image URL
 * or a stylesheet request.
 *
 * The policy has to travel in the document because a `srcDoc` frame has no
 * response of its own to carry a header. `pi-web`'s server sets no security
 * headers at all, so there is nothing to inherit either; this is the only place
 * the rule can live.
 */

/**
 * What the frame may do: nothing, except draw itself.
 *
 * `style-src 'unsafe-inline'` is deliberate and is not the usual mistake — the
 * file's own `<style>` blocks and `style=` attributes are the whole point of
 * previewing it, and inline styles cannot reach the network on their own. Every
 * resource a page would normally pull in (`img`, `font`, `media`) is limited to
 * `data:` URIs, so a document that carries its own assets still looks right
 * while one that references a sibling file or a remote host simply does not
 * load it.
 */
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;

/**
 * Put the policy as early in the document as its own structure allows.
 *
 * A policy in a `<meta>` only governs what the parser has not reached yet, so
 * its position matters: after `<head>`, or after `<html>` when the document
 * leaves the head implicit, or after the doctype when it has neither. Prepending
 * it unconditionally would be simpler and would also break standards mode, since
 * a doctype that is not the first thing in the document is ignored.
 */
export function buildFrameDocument(html: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head !== null) return insertAfter(html, head);
  const root = /<html(?:\s[^>]*)?>/i.exec(html);
  if (root !== null) return insertAfter(html, root);
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype !== null) return insertAfter(html, doctype);
  return CSP_META + html;
}

function insertAfter(source: string, match: RegExpExecArray): string {
  const at = match.index + match[0].length;
  return source.slice(0, at) + CSP_META + source.slice(at);
}
