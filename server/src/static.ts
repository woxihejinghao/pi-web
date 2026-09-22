/**
 * Static serving for the compiled front end.
 *
 * In production `pi-web-simple` is a single process: it answers `/api/*` and
 * hands everything else to the SPA build. That is what removes the second
 * server (and therefore the cross-origin hop) the dev setup needs — in dev,
 * Vite owns the browser-facing port and proxies `/api` to this process
 * instead, so nothing here is on the request path.
 *
 * Two rules shape the handler:
 *
 * - **`/api/...` never reaches this module.** An unknown endpoint has to come
 *   back as JSON; falling through to `index.html` would hand `fetch` an HTML
 *   shell that fails as a parse error instead of a readable 404.
 * - **Every unmatched path returns `index.html`.** The client router keeps its
 *   own state, so a hard refresh on a deep link has to boot the same shell
 *   rather than 404.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

/** Answers one request; `true` means the response was already written. */
export type StaticHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
) => Promise<boolean>;

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const ASSET_DIR = `${sep}assets${sep}`;

/**
 * Vite fingerprints everything it emits into `assets/`, so those files are
 * safe to cache forever. `index.html` is the one name that never changes and
 * is what points at the current fingerprints, so it must always revalidate —
 * otherwise a new deployment would keep loading the previous build.
 */
function cacheControl(filePath: string): string {
  return filePath.includes(ASSET_DIR)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

/**
 * Resolve a URL path to a readable file inside `root`, or null.
 *
 * The prefix check is the whole point: `resolve` collapses `..` before the
 * comparison, so a traversal attempt lands outside `root` and is rejected
 * whether it arrived literally or percent-encoded.
 */
function resolveFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return null;

  const full = resolve(root, `.${decoded}`);
  if (full !== root && !full.startsWith(root + sep)) return null;

  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

async function sendFile(
  res: ServerResponse,
  filePath: string,
  method: string,
): Promise<void> {
  const stats = statSync(filePath);
  res.writeHead(200, {
    "content-type":
      CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "content-length": stats.size,
    "cache-control": cacheControl(filePath),
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  // Errors here are client disconnects, which `pipeline` tears down for us.
  await pipeline(createReadStream(filePath), res);
}

/**
 * Build the handler for `root`, or null when there is nothing to serve.
 *
 * Null is the honest answer for a source checkout that has never been built,
 * and for a run that points `PI_WEB_SIMPLE_STATIC_DIR` at the wrong place: the
 * API keeps working and `/` keeps answering its JSON 404, which is far easier
 * to diagnose than an empty 200.
 */
export function createStaticHandler(root: string | null): StaticHandler | null {
  if (root === null) return null;
  const indexHtml = join(root, "index.html");
  if (!existsSync(indexHtml)) return null;

  return async (req, res, pathname) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return false;
    if (pathname === "/api" || pathname.startsWith("/api/")) return false;

    const file = resolveFile(root, pathname);
    if (file !== null) {
      await sendFile(res, file, method);
      return true;
    }

    await sendFile(res, indexHtml, method);
    return true;
  };
}
