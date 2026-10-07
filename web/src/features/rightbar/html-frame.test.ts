import { describe, expect, it } from "vitest";
import { buildFrameDocument, FRAME_CSP } from "./html-frame.ts";

describe("buildFrameDocument", () => {
  it("puts the policy just inside the head, before anything else can load", () => {
    const out = buildFrameDocument("<html><head><title>x</title></head><body>hi</body></html>");
    expect(out.startsWith("<html><head><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<title>"));
  });

  it("reads a head tag that carries attributes, in any case", () => {
    const out = buildFrameDocument("<HTML><HEAD lang=\"zh\"><p>x</HEAD></HTML>");
    expect(out).toContain("<HEAD lang=\"zh\"><meta http-equiv=\"Content-Security-Policy\"");
  });

  it("leaves the doctype first when the document has no head element", () => {
    // Standards mode depends on the doctype being the very first thing, so the
    // policy goes after it rather than in front of it.
    const out = buildFrameDocument("<!DOCTYPE html>\n<p>bare fragment</p>");
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<p>"));
  });

  it("uses the html element when there is no head and no doctype", () => {
    const out = buildFrameDocument("<html><body>x</body></html>");
    expect(out.startsWith("<html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
  });

  it("prepends to a document that is nothing but content", () => {
    const out = buildFrameDocument("<p>just a fragment</p>");
    expect(out.startsWith("<meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(out).toContain("<p>just a fragment</p>");
  });

  it("does not mistake a header element for a head element", () => {
    const out = buildFrameDocument("<header>nav</header>");
    expect(out.startsWith("<meta")).toBe(true);
  });
});

describe("FRAME_CSP", () => {
  it("turns off scripts, connections, frames and forms", () => {
    expect(FRAME_CSP).toContain("script-src 'none'");
    expect(FRAME_CSP).toContain("connect-src 'none'");
    expect(FRAME_CSP).toContain("frame-src 'none'");
    expect(FRAME_CSP).toContain("form-action 'none'");
    expect(FRAME_CSP).toContain("default-src 'none'");
  });

  it("still lets a document carry its own styling and inline assets", () => {
    expect(FRAME_CSP).toContain("style-src 'unsafe-inline'");
    expect(FRAME_CSP).toContain("img-src data:");
  });

  it("never allows a network origin anywhere in the policy", () => {
    // The one thing this policy exists to guarantee: no `http`/`https`/`*`
    // source appears in it, so nothing in the frame can reach out.
    expect(FRAME_CSP).not.toMatch(/https?:|\*/);
  });
});
