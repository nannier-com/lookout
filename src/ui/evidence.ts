/**
 * Serving the pixels: the screenshots themselves, and thumbnails of them.
 *
 * Two roots serve one namespace. A path starting `issues/` is a frozen frame
 * in an issue's own folder under the project's `.lookout/issues/`; everything
 * else is a live shot in the capture workspace. These are the only routes in
 * the server that touch a path a browser supplied, so they are kept together
 * with the check that a URL cannot leave its root however it is spelled.
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { MIME, text } from "./http.js";

export interface EvidenceRoots {
  /** The capture workspace: every live shot, the sheets, the run log. */
  evidence: string;
  /** The project's `.lookout/issues`, holding each dossier's frozen frames. */
  issues: string;
}

/**
 * Thumbnails are re-requested every time the page re-renders a tile, and
 * re-encoding a multi-megabyte PNG each time would make the grid slower than
 * serving the originals. Keyed by path, mtime and width, so a fresh capture at
 * the same path invalidates on its own.
 */
const thumbCache = new Map<string, Buffer>();

/** Serve only from inside the path's own root, whatever the URL claims. */
export function safeEvidencePath(roots: EvidenceRoots, rel: string): string | null {
  const decoded = decodeURIComponent(rel);
  const inIssues = decoded === "issues" || decoded.startsWith("issues/");
  const root = resolve(inIssues ? roots.issues : roots.evidence);
  const target = resolve(root, inIssues ? decoded.slice("issues/".length) : decoded);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return existsSync(target) && statSync(target).isFile() ? target : null;
}

/**
 * What a browser is told to compare a cached tile against.
 *
 * Everything that decides what comes back: which file, as it is on disk right
 * now, at which width, cropped or whole. Hashed, not encoded. This was base64
 * of that key truncated to 32 characters, and base64 is a prefix code: 32
 * characters is the first 24 bytes, which is the front of an absolute path and
 * nothing else. Every thumbnail the server produced carried the same ETag,
 * decoding to `/Users/somebody/Workspac`, and the mtime, size, width and fit
 * the key exists to distinguish were all cut off the end.
 *
 * What that cost is precisely what lookout is for: re-capture a screenshot and
 * the browser revalidates the tile, is told 304, and goes on showing the defect
 * you just fixed. Measured on 2026-09-01, replacing a desktop capture with a
 * phone one and revalidating returned 304 with no body.
 *
 * Its own function because that is the half worth testing, and because reading
 * the file's mtime here means a caller cannot forget to.
 */
export function thumbEtag(path: string, width: number, whole: boolean): string {
  const st = statSync(path);
  const key = `${path}|${st.mtimeMs}|${st.size}|${width}|${whole ? "in" : "cover"}`;
  return `"${createHash("sha1").update(key).digest("base64url").slice(0, 22)}"`;
}

/**
 * Full-page screenshots run to megabytes each, and a grid of them stalls the
 * page for the whole run. Thumbnails are generated on demand and cropped the
 * same way the contact sheet crops, so the grid matches what the sheet shows.
 */
export async function serveThumb(req: Request, roots: EvidenceRoots, url: URL): Promise<Response> {
  const p = safeEvidencePath(roots, url.pathname.slice("/thumb/".length));
  if (!p) return text(404, "not found");
  try {
    const w = Math.min(600, Math.max(120, Number(url.searchParams.get("w") ?? 380)));
    // A screenshot is cropped to its top, which is the part that carries the
    // defect. A contact sheet is already a composite, so cropping it hides
    // the very tiles it was built to show: fit the whole thing instead.
    const whole = url.searchParams.get("fit") === "inside";
    const h = Math.round(w * (whole ? 1.2 : 0.8));
    // One identity, used twice: the validator a browser compares against, and
    // the key this process caches the encoded bytes under. They answer the same
    // question, so they must not be able to disagree.
    const etag = thumbEtag(p, w, whole);
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
    let buf = thumbCache.get(etag);
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
      thumbCache.set(etag, buf);
    }
    return new Response(new Uint8Array(buf), {
      headers: { "content-type": "image/webp", etag, "cache-control": "no-cache" },
    });
  } catch {
    return new Response(null, { status: 500 });
  }
}

/** The screenshot itself, streamed as it is on disk. */
export function serveEvidence(roots: EvidenceRoots, url: URL): Response {
  const p = safeEvidencePath(roots, url.pathname.slice("/evidence/".length));
  if (!p) return text(404, "not found");
  return new Response(Bun.file(p), {
    headers: {
      "content-type": MIME[extname(p).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}
