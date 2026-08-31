/**
 * Serving the pixels: the screenshots themselves, and thumbnails of them.
 *
 * Both are reads out of one directory, and both are the only routes in the
 * server that touch a path a browser supplied, so they are kept together with
 * the check that a URL cannot leave the evidence store however it is spelled.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { MIME } from "./http.js";

/**
 * Thumbnails are re-requested every time the page re-renders a tile, and
 * re-encoding a multi-megabyte PNG each time would make the grid slower than
 * serving the originals. Keyed by path, mtime and width, so a fresh capture at
 * the same path invalidates on its own.
 */
const thumbCache = new Map<string, Buffer>();

/** Serve only from inside the evidence directory, whatever the URL claims. */
export function safeEvidencePath(evDir: string, rel: string): string | null {
  const target = resolve(evDir, decodeURIComponent(rel));
  const root = resolve(evDir);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return existsSync(target) && statSync(target).isFile() ? target : null;
}

/**
 * Full-page screenshots run to megabytes each, and a grid of them stalls the
 * page for the whole run. Thumbnails are generated on demand and cropped the
 * same way the contact sheet crops, so the grid matches what the sheet shows.
 */
export function serveThumb(req: IncomingMessage, res: ServerResponse, evDir: string, url: URL): void {
  const p = safeEvidencePath(evDir, url.pathname.slice("/thumb/".length));
  if (!p) {
    res.writeHead(404).end("not found");
    return;
  }
  void (async () => {
    try {
      const w = Math.min(600, Math.max(120, Number(url.searchParams.get("w") ?? 380)));
      // A screenshot is cropped to its top, which is the part that carries the
      // defect. A contact sheet is already a composite, so cropping it hides
      // the very tiles it was built to show: fit the whole thing instead.
      const whole = url.searchParams.get("fit") === "inside";
      const h = Math.round(w * (whole ? 1.2 : 0.8));
      const st = statSync(p);
      const key = `${p}|${st.mtimeMs}|${st.size}|${w}|${whole ? "in" : "cover"}`;
      const etag = `"${Buffer.from(key).toString("base64url").slice(0, 32)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304).end();
        return;
      }
      let buf = thumbCache.get(key);
      if (!buf) {
        const sharp = (await import("sharp")).default;
        buf = await sharp(p)
          .resize(w, h, {
            fit: whole ? "inside" : "cover",
            position: "top",
            withoutEnlargement: true,
          })
          .webp({ quality: 72 })
          .toBuffer();
        if (thumbCache.size > 400) thumbCache.clear();
        thumbCache.set(key, buf);
      }
      res.writeHead(200, { "content-type": "image/webp", etag, "cache-control": "no-cache" });
      res.end(buf);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  })();
}

/** The screenshot itself, streamed as it is on disk. */
export function serveEvidence(res: ServerResponse, evDir: string, url: URL): void {
  const p = safeEvidencePath(evDir, url.pathname.slice("/evidence/".length));
  if (!p) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(p).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(p).pipe(res);
}
