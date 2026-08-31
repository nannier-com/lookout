/**
 * The small manners of an HTTP server, in one place.
 *
 * Replying with JSON and reading a JSON body are two lines each, which is
 * exactly why they were written inline four times over and drifted: one route
 * capped the body it would read and another did not. A handler should say what
 * it means and not how a response is spelled.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
  ".md": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 8192) req.destroy();
    });
    req.on("end", () => {
      try {
        ok(JSON.parse(body || "{}") as Record<string, unknown>);
      } catch {
        ok({});
      }
    });
  });
}
